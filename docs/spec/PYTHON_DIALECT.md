# Spec (WIP): a read-only dialect of Python, and the namespace it runs in

**Status: decided, nothing built.** Decided by Shane on 2026-10-15, after a discussion that first proposed treating
Python as a sandbox and was corrected. This spec holds that decision, the reasons, the design, and the answers to the
open questions on persistent Python state in [`STATE_INSPECTOR.md`](STATE_INSPECTOR.md) ("Python state persists per
run") and [`PERSISTENT_RUNTIME_SPEC.md`](PERSISTENT_RUNTIME_SPEC.md). It is the second implementation of the concept the
JS dialect implements ([`docs/dev/readonly-exec.md`](../dev/readonly-exec.md)), and the main consumer of
[`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md).

## Why a dialect, when Pyodide is already a sandbox

The sandbox position was argued and rejected. Its case: Pyodide is a sealed WebAssembly worker, nothing crosses except by
copy through a callback, and a stuck cell is killed by terminating the worker, so the Python equivalent of the JS dialect
is the callback gate plus the kill switch. Four things are wrong with it.

1. **A sandbox is a property of a place; a dialect is a property of the program.** Under "placement is unobservable"
   ([`SHELL.md`](SHELL.md)), a read-only Python cell must be safe wherever the runtime puts it, and the place that
   matters most is the process host's real CPython, with numpy at native speed and no WebAssembly around it. Only a
   proof about the program travels there.
2. **A sandbox decays.** The Pyodide hardening is a list of things to purge (`js`, `pyodide_js`, the network globals;
   `harden()` in `src/python/python-runtime.ts`), which is a DENY list that the next Pyodide release can extend without
   telling anyone. A dialect gives the script nothing it did not list. The hardening stays, as belt.
3. **Persistent state brings rollback back.** A sandboxed cell that is refused halfway has already mutated the run's
   namespace. An owned-value interpreter restores what it touched, as `evalReadonly` does.
4. **Totality composes; a timer does not.** Every program the dialect admits terminates within a cost bound known before
   or during the run. A policy, a manifest cost and a survey can then be reasoned about together, and a budget can be
   shared across placements. A kill after N seconds proves nothing about the program, and Python is Turing-complete
   by default although almost nothing a model does with it needs to be.

## The design: the JS dialect with one substitution and one simplification

- **The parser is `ast.parse`.** No hand-written tokenizer, no drift from real Python. The subset is a WHITELIST of
  node types, and an unlisted node is `NotInDialect`. That whitelist is the one ratchet.
- **The evaluator is written in Python and runs in-process with the values.** It has to: the leaves are numpy and pandas
  objects that live in CPython. This is the opposite of the JS case, where the DOM is foreign and the interpreter lives
  beside it. One module file runs under Pyodide and under the host's CPython unchanged, which is what makes placement
  free and keeps JavaScript out of the process host ([`SHELL.md`](SHELL.md), "The host's language"). The evaluator never
  calls Python's `eval`, `exec` or `compile`.
- **Attribute access is mediated**, as `BY_KIND` and `DENIED_PROPS` mediate it in JS. Dunders are refused outright,
  which cuts the `__class__` → `__subclasses__` escape chain at its root. Methods are allowed per receiver kind (`str`,
  `list`, `dict`, `tuple`, `set`, numbers, `ndarray`, `DataFrame`, `Series`, `Index`), with the mutating ones accepted
  only on an owned receiver.
- **Halting is the Starlark set.** `for` over a finite collection or a bounded `range`, comprehensions over the same, no
  `while`, recursion to a bounded depth, no generators and no `yield`, no `class`. `lambda` and `def` are in, and
  `df.apply(f)` calls `f` back THROUGH the interpreter, which is the manifest's `@calls` annotation.
- **Ownership is simpler than in JS.** Every value in the namespace was made by an earlier cell, injected as a copy
  (`df`, `tables`, `img`), or returned by `ml.dereference` as a copy. The dialect owns nearly everything; the foreign
  values are manifest `internal` aliases (a view from `reshape`). Rollback on refusal is copy-on-first-write per name.
- **The native leaves are the manifest's whole job here.** In JS the dialect has few native libraries to worry about; in
  Python every useful cell is numpy or pandas, so this dialect is why the manifest spec's Python examples exist. Tier 1
  (a closed-form bound over `len`, `size`, `shape`, with hard caps) is the practical tier for C leaves, since there is no
  charge hook inside a C loop. Tier 3 ("interpret my body") is RICHER than in JS: much of the stdlib is pure Python, so
  the interpreter steps into `statistics`, `collections`, `json` and friends with only their C leaves annotated.
- **`re` needs the `riskyRegex` port.** Python's engine backtracks and has no linear mode.
- **Effects are the shared algebra** ([`EFFECTS.md`](EFFECTS.md)): the interpreter publishes `B = { read/write/alloc
  on heap(owned) }`, so a cell whose every leaf projects inside that set is free wherever it runs.

### Membership replaces `mode`

`python_exec`'s `mode: "readonly" | "full"` goes away, and nothing is lost: with `ml` reachable from Python
([`ML_WIRE.md`](ML_WIRE.md)), `full` mode's raw `js` module and `pyodide.http` have no use a gated `ml.fetch` does not
cover. The model never chooses. A cell inside the dialect runs with no card, in either place. A cell outside it (a
`while`, a class, an unannotated library call) goes to the person and runs as full Python with the gated `ml` callback,
in a worker that is still hardened. That is the two-path story the JS `exec` already tells.

A cell inside the dialect that makes a gated `ml` call (`ml.fetch` on a new URL, `ml.sh`) does not fall out of it: the
call SUSPENDS on an `ask` and continues when answered ([`ML_WIRE.md`](ML_WIRE.md), "Per-call asking"), which the JS
survey could not do and which answers the manifest spec's "granularity of a refusal".

## The namespace

**One namespace per run, persistent**, as decided on 2026-10-08. The five questions the state inspector spec left open:

1. **Per run AND per mode?** Dissolved: there is no `mode`. A cell can never hold a live network handle, because no
   cell ever gets one; `ml` is a callback that returns copies, and the dialect refuses what it does not list. The
   namespace holds data and handles, never capabilities.
2. **What the injected names mean on the second call.** `df`, `tables` and `img` become ordinary assignments at the top
   of the cell that passes them, and nothing resets them. A later cell without the parameter sees the earlier table,
   which is what a notebook does and what models assume. The tool's text says so, once, in place of the two sentences
   that contradict each other today.
3. **Lifetime and loss.** The next cell's result opens with "namespace reset at <time>: <reason>" from the housekeeping
   record that already exists for Pyodide kills and cold starts, and `ml.current.env` lists the live names with their
   types and shapes (the scope manifest in [`PERSISTENT_RUNTIME_SPEC.md`](PERSISTENT_RUNTIME_SPEC.md)). A run is told;
   it is never handed a silently empty namespace.
4. **Memory.** The namespace is one dict in the one shared interpreter, deleted at run end, with a memory eviction that
   triggers the loss message above rather than a quiet reset.
5. **Approval.** Dissolved with 1: state is data, and capability exists only at the call, judged per call.

**JS values reach Python the same way.** No `vars` parameter: `ml.state` read from Python through the callback, by
copy, is the bridge, and a value too large to copy crosses as a pointer. One rule for every crossing: JSON or Arrow by
copy, or a pointer, never a proxy. The run's namespace, seen from the worker, is a map from name to HANDLE, each pointing
at where its value lives (the page heap for `ml.state`, the Pyodide heap, the process host); the JS/Python asymmetry of
WHERE values live, deliberate in the persistent-runtime spec, survives, and the model sees one namespace reachable in two
languages ([`SHELL.md`](SHELL.md)).

## Packages on demand

Installing is its own step, gated by a policy or an approval and pinned by hash, so that a dialect cell only ever
IMPORTS. `micropip` from a local wheel mirror; PyPI as a gated network read. The facts a policy sees are small (a
package name, a version, a source, the hash), which makes this a cheap early consumer of [`POLICIES.md`](POLICIES.md).
The same hash keys the package's library manifest, so an installed package arrives with the description the dialect
needs, or arrives as `unknown` and every call into it asks.

## Secrets

A secret handle is a receiver kind of its own in the dialect: no attributes, no methods, `repr` is `[secret: github]`,
and it can only be passed to an `ml` member whose manifest lists `use(secret)` ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)).
The namespace persists the handle, never a value, because the value never enters any Python process: the worker or the
host injects it at the sink.

## Placement and the environment

CPython at the host runs a different numpy build than Pyodide, and the strict reading of "placement is unobservable" is
not available at native speed. The rule is weakened to **the same result up to the recorded environment**: the host's
numpy and pandas are pinned to the versions in the Pyodide lock, the environment is stamped into the run's provenance
(the open topic on stamping a run's environment), and BLAS operation-order differences are named as a tolerance rather
than pretended away. Running Pyodide under Node at the host would make placement bit-identical and is kept as an option
for a case that needs it, not the default.

## Step 0: measure the subset before writing it

The repo holds a corpus of real `python_exec` cells in run logs and bench results. Walking them with `ast` and counting
node types, imports and attribute calls says which subset admits most of what models actually write, and which numpy and
pandas methods the first manifest must cover. The JS dialect grew the same way. The gap list from that count is the
first PR's spec; nothing in the design above is written into code before it.

## Tests

The AGENTS.md rule for extending a dialect applies from the first construct: adversarial tests (reach `__class__`, a
builtin's `__globals__`, `getattr` with a computed dunder, `type()`, an unlisted import, a mutation of an unowned value,
unbounded `range`, a recursion past the depth), HALTING tests under a timeout, FAILURE tests (a refused cell leaves the
namespace as it was), run against real CPython (the existing `dist/pyodide/` tests self-skip without it). The halting,
failure and abuse vectors are written language-neutrally where they can be and run against BOTH dialects, which is the
only sharing the two evaluators can honestly have: one contract, one manifest format, one vector corpus.

## Open questions

- **How much of real pandas falls inside tier 1.** `groupby().apply`, `merge` and string accessors have data-dependent
  cost; the first manifest may need a hard cap in place of a bound for some of them.
- **Exceptions.** `try`/`except` over the dialect's own errors is in (the JS dialect has it); whether a cell may catch a
  numpy error and continue, and what that does to rollback.
- **Printing.** The JS dialect's print boundary (abridging, substitution notes) needs a Python counterpart over
  `print`, `repr` and the implicit last-expression value.
