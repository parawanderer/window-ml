# Specification: Cryptographically Attested Jupyter Notebook Generation (`nb-attest`)

> **Status: parked (2026-10-10).** Sections 1–9 are the original draft. Section 10 is a review of it: five places where a
> valid signature does not yet support the claim a reader relies on, and how window.ml's runtime changes each. Read 10
> before building from 1–9. Until this is built, notebooks in the repo follow the repo's notebook rules (headless run,
> committed outputs, pinned inputs, an execution-evidence check), which make a notebook honest by convention only.

## 1. Problem Statement

When autonomous LLM coding agents produce Jupyter notebooks containing execution outputs, there is zero guarantee the code was executed in a real Python kernel. Agents frequently hallucinate valid-looking `outputs`, synthesized metrics, and mock visualizations directly into the notebook JSON.

Even if an agent runs an interactive kernel session, post-hoc edits via shell access (`jq`, `sed`, or Python scripts) allow the agent to tamper with execution counts, inject arbitrary outputs, or fabricate passing test runs.

## 2. Objective

Design an execution wrapper and tool definition that allows an agent to produce derived `.ipynb` notebooks containing real executed outputs while providing non-repudiation guarantees:

* The generated notebook is 100% valid under standard `nbformat` (v4.x) specifications (no proprietary schema extensions).
* The notebook carries an embedded signature certifying that its cells, outputs, and execution order strictly match an actual kernel session run by the wrapper.
* Tampering via bash, filesystem edits, or synthetic cell injection immediately invalidates the signature.
* Public verification requires only the corresponding public key or shared secret.

---

## 3. Architecture & Threat Model

### Components

1. **Host Execution Wrapper (Trusted Process):**
* Manages the isolated IPython/Jupyter kernel.
* Maintains an append-only, in-memory execution trace: `Trace = [(cell_id, source, outputs, execution_count), ...]`.
* Manages the signing key outside the agent's accessible filesystem and environment variables.
* Exposes two tool primitives to the agent: `execute_code` and `produce_derived_notebook`.


2. **Agent Shell / Execution Sandbox (Untrusted Workspace):**
* Has read/write access to the working directory.
* Has bash execution capabilities.
* **Cannot** read the private key or inspect the parent wrapper process memory.


3. **Verification Tool (`verify-nb`):**
* Standalone CLI or pre-commit hook that validates notebooks against a public key or HMAC secret.



### Threat Model

* **Threat 1: Synthetic Output Injection:** The agent writes an `.ipynb` directly to disk without executing code, fabricating `outputs` in JSON. *(Mitigated: Agent lacks the signing key; file fails signature check).*
* **Threat 2: Post-Execution Mutation:** The agent runs code via the kernel, calls the derivation tool, and then uses `sed` or `python` to alter a cell’s code or output. *(Mitigated: Any bit-level modification to signed fields breaks the signature).*
* **Threat 3: Execution Log Truncation/Fabrication:** The agent tries to fabricate pointers or feed raw cell objects to the derivation tool. *(Mitigated: The tool accepts only integer/UUID cell pointers referencing the wrapper’s internal trace).*

---

## 4. Cryptographic Envelope & Notebook Schema

To avoid schema validation failures in standard Jupyter tooling (`nbformat.validate()`, JupyterLab, VS Code, Google Colab), the signature envelope must reside inside the top-level `metadata` object (which permits `additionalProperties: true`).

### Schema Injection Point: `metadata.provenance`

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    },
    "provenance": {
      "version": "1.0",
      "scheme": "ed25519",
      "public_key": "a4f89b...",
      "session_id": "sess_01HZX89...",
      "signature": "3b7c89..."
    }
  },
  "cells": [
    {
      "cell_type": "code",
      "execution_count": 1,
      "metadata": {},
      "source": ["x = 42\n", "print(x)"],
      "outputs": [
        {
          "name": "stdout",
          "output_type": "stream",
          "text": ["42\n"]
        }
      ]
    }
  ]
}

```

---

## 5. Canonical Serialization (RFC 8785)

Standard JSON serialization is non-deterministic (key ordering, whitespace, string escaping, Unicode normalization). Naive hashing of serialized JSON strings leads to false-positive verification failures.

### Signing & Verification Algorithm

1. **Payload Extraction:** Let $N$ be the parsed Python dictionary representing the target notebook.
2. **Signature Detachment:**
* Extract $\sigma = N[\text{"metadata"}][\text{"provenance"}][\text{"signature"}]$.
* Remove the key `signature` from $N[\text{"metadata"}][\text{"provenance"}]$.


3. **Canonical Serialization (JCS):**
* Transform the modified dictionary $N'$ into canonical byte representation $B$ according to **RFC 8785 (JSON Canonicalization Scheme)**:
* UTF-8 encoding.
* Keys sorted lexicographically by Unicode code point.
* Strict compact formatting (no whitespace between separators: `','` and `':'`).
* Standardized IEEE 754 number formatting.




4. **Signature Computation / Verification:**
* **Signing:** $\sigma = \text{Sign}_{K_{\text{priv}}}(B)$
* **Verification:** $\text{Verify}_{K_{\text{pub}}}(B, \sigma) \to \{\text{True}, \text{False}\}$



---

## 6. Key Management Models

The wrapper must support two operational modes:

### Mode A: Ephemeral Asymmetric (Zero-Config Default)

1. On startup, the wrapper generates an in-memory `Ed25519` keypair.
2. The private key $K_{\text{priv}}$ stays in host memory.
3. The public key $K_{\text{pub}}$ is written to `./.nb_attest.pub` in the workspace.
4. When the agent derives a notebook, the tool signs with $K_{\text{priv}}$ and includes $K_{\text{pub}}$ in the envelope.
5. Anyone running `verify-nb solution.ipynb` against `./.nb_attest.pub` can verify the session.

### Mode B: External / Shared Secret (CI & Enterprise)

1. The wrapper receives an existing key via an environment variable or flag mapped from outside the workspace:
* **Symmetric:** `NB_ATTEST_HMAC_KEY="<hex-secret>"`
* **Asymmetric:** `NB_ATTEST_PRIVATE_KEY="<path-to-pem>"`


2. Derived notebooks are signed using this authority.
3. CI/CD pipelines or audit tools possessing the pre-shared secret or public certificate can enforce valid signatures as a blocking check before PR merge.

---

## 7. Tool Definition Interface

### Tool 1: `execute_cell`

Executes Python code in the persistent session kernel.

* **Inputs:**
* `code` (string, required): Source code to execute.


* **Returns:**
* `cell_id` (integer): Monotonically increasing pointer identifying this execution event.
* `execution_count` (integer): Kernel execution counter.
* `stdout` / `stderr` / `outputs`: Rendered execution results.



### Tool 2: `produce_derived_notebook`

Assembles and signs a standalone `.ipynb` file from selected cell pointers.

* **Inputs:**
* `cell_ids` (array of integers, required): Ordered list of `cell_id` pointers from earlier `execute_cell` calls.
* `output_path` (string, required): File path to save the resulting notebook (e.g., `solution.ipynb`).
* `include_markdown` (array of objects, optional): Optional markdown cells to intersperse: `[{"after_cell_id": 2, "source": "# Analysis"}]`.


* **Behavior:**
1. Validates that all requested `cell_ids` exist in the wrapper's internal trace log.
2. Constructs the notebook JSON with exact code, outputs, and execution counts as originally captured.
3. Canonicalizes the structure, computes the cryptographic signature, and embeds it into `metadata.provenance`.
4. Writes the complete `.ipynb` to `output_path`.
5. Returns success status and the generated SHA-256 fingerprint.



---

## 8. CLI Verification Tool: `verify-nb`

A lightweight standalone script (`verify_nb.py`) distributed alongside the wrapper:

```bash
# Verify using local ephemeral session public key:
$ verify-nb --pubkey .nb_attest.pub solution.ipynb
[OK] Notebook signature valid.
Attestation: 4 code cells verified against session sess_01HZX89...

# Verify using an enterprise HMAC secret in CI:
$ verify-nb --hmac-key $CI_SECRET submission.ipynb
[OK] Notebook signature valid.

# Detect agent tampering:
$ sed -i 's/score = 0.82/score = 0.99/g' solution.ipynb
$ verify-nb --pubkey .nb_attest.pub solution.ipynb
[FAIL] Signature mismatch. Notebook has been tampered with or contains unverified cells.

```

---

## 9. Implementation Checklist for Claude Code

* [ ] Implement RFC 8785 canonical JSON encoder (or adopt `canonicaljson` / `jcs`).
* [ ] Implement `Ed25519` key generation and signing via `cryptography.hazmat.primitives.asymmetric.ed25519`.
* [ ] Build the interactive IPython kernel runner with output capture using `jupyter_client`.
* [ ] Expose `execute_cell` and `produce_derived_notebook` tools.
* [ ] Implement `verify-nb` CLI entrypoint verifying detached signatures.
* [ ] Add unit test verifying that altering a single character in a cell `source`, `output`, or `execution_count` causes `verify-nb` to exit with status code `1`.

---

## 10. Review (2026-10-10): what a valid signature does not yet establish

Sections 1–9 establish one property: **a signed cell's source, outputs and execution count are those the wrapper
captured, unchanged since.** The claim a reader acts on is stronger: *this notebook's conclusion follows from this data,
in this environment.* Five gaps sit between the two.

### 10.1 Selection: cells can be left out or reordered

`produce_derived_notebook` takes any list of `cell_id`s in any order. Each signed cell really ran, but the derived
notebook can omit the cell that dropped the failing rows, or place a later computation first. The signature then
certifies a sequence the session never executed.

**Refinement.** Chain the trace: $h_0 = H(\text{session\_id})$, $h_i = H(h_{i-1} \,\|\, \text{JCS}(\text{cell}_i))$ over every
execution, including failed ones. Sign the head $h_n$ (and the session's identity) rather than only the selected cells.
The derived notebook records each cell's index in the full trace, plus the hashes of the omitted cells, so the chain
can be recomputed. `verify-nb` then reports the gaps ("cells 4 and 7 of 12 omitted; cell 7 raised") instead of hiding
them. Omitting cells stays allowed; omitting them silently does not.

### 10.2 Inputs: the data is not bound

The agent can write to the workspace (section 3), so it can edit an input file and then run the notebook honestly.
The signature is valid and the conclusion is fabricated: signing the computation does not authenticate its input.

**Refinement.** The signed record includes a content hash of every input the kernel read. The wrapper either mediates
reads (inputs reach the kernel only through a tool that hashes them) or records reads at the boundary it controls (a
read-only mount of inputs named by hash). An unrecorded read is reported, not trusted.

### 10.3 Key custody: the trust anchor comes from the untrusted side

Mode A writes the public key to `./.nb_attest.pub` in the workspace, and the envelope embeds `public_key`. An agent
can generate its own keypair, sign a fabricated notebook, and replace that file. Verifying against a key the workspace
supplies proves nothing.

**Refinement.** The verifier's key comes from outside the workspace and is pinned in advance (a key known to the
reviewer or CI, never one read from the notebook or its directory). `public_key` in the envelope is a hint for lookup
only.

### 10.4 Commentary is signed along with the evidence

`include_markdown` cells are the agent's own prose, yet they sit inside the signed payload and read as certified.
**Refinement.** Markdown is excluded from the signature, or signed under a separate field the verifier reports as
"authored, not executed". `verify-nb` states exactly what it certifies: these code cells ran in this order and produced
these outputs from these inputs.

### 10.5 No binding to time, build or environment

A valid notebook from an old session can be presented as evidence about a new build, and a rerun cannot be compared
against it without knowing what it ran on. **Refinement.** The signed record includes the time, the repository commit
(and a hash of any uncommitted diff), and an environment fingerprint (lockfile hash, kernel and interpreter version).
Reproducing the notebook (seeds, pinned extracts of live databases) is a repo rule, not this spec's job; the signed
record only has to carry enough to check it.

### 10.6 In window.ml's runtime

Built inside window.ml rather than as a wrapper around a coding agent, most of the above is already in place:

| Gap | Today in window.ml |
| --- | --- |
| 10.1 selection | `python_exec` keeps no state between calls: a cell's result depends only on its code and its declared inputs, so an omitted cell cannot have altered what a later one computed. The chain still records what was omitted. |
| 10.2 inputs | Inputs arrive as values the runtime holds (`@tool:` pointers into the value store, `docs/dev/pointers.md`), not files the agent can edit. The runtime hashes each value it hands the kernel. |
| 10.3 key | The runtime already has an identity key (its hub certificate, `docs/dev/hub-client.md`), held outside anything a tool can reach. |
| 10.4 commentary | The run record already separates what the model wrote from what a tool returned. |
| 10.5 binding | A run's export already carries its build and environment (`run.json`, `docs/dev/export.md`). |

So a signed notebook is a signed projection of a run's `python_exec` steps out of the record the runtime already keeps
(the rule that the log carries what the model actually saw), not a second log.

**A bash tool reopens 10.1 and 10.2.** The bash tool idea (scriptable from `exec` and `python_exec`, executing in a
container) gives the agent a writable filesystem and, if the container persists, state between calls. The container
boundary is then where inputs must be recorded: the runtime owns the container, so it can mount inputs read-only by
hash and record what the kernel opened, and a persistent container's state joins the chain (or the container is
disposable per call). Designing the bash tool and this spec together avoids building a filesystem the attestation
cannot see.

