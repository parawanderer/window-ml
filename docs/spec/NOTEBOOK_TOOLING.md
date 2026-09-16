# Specification: Cryptographically Attested Jupyter Notebook Generation (`nb-attest`)

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
