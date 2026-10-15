# The Pyodide worker lockdown: the defence, for whichever session builds it

Written 2026-10-15 by the coordinating session (`repl-specs`) so the defence does not depend on any one session's
context. It describes what the worker must become; it contains no escape recipes. The acceptance VECTORS (the tests
that fail first) are owned by the red-team session and live in its brief; a session building the defence needs this
file, [`docs/dev/python-sandbox.md`](../../dev/python-sandbox.md), and the code it names.

## Why

The `readonly` (auto-approved) `python_exec` sandbox was found, against real Pyodide, to reach JavaScript in its worker
and from there the extension-origin network. The hardening was a DENY list (`harden()` in `src/python/python-runtime.ts`
nulls a set of network globals and purges two modules), and a deny list over a host surface decays. This is the measured
case for [`PYTHON_DIALECT.md`](../../spec/PYTHON_DIALECT.md), "Why a dialect", point 2; the dialect closes the whole
class by construction later, and the lockdown is what stands until then and stays as belt afterwards.

Two interim mitigations ship first, as their own PR (branch `repl-lane1/pyodide-lockdown`, commit `5885bda3`, source
done, six tests left): `python_exec` tab grants qualified by mode (a `full` grant covers `readonly`, never the
reverse); a page-started `readonly` cell runs only under a grant; `autoApprovePython` defaults off. The lockdown then
starts from main.

## The defence

1. **A readonly-only worker that is NEVER unhardened.** `full` mode gets a separate worker. One worker per PRINCIPAL (a
   worker-hosted run, a page, `full`), respawned on principal change; a respawn writes the housekeeping record that the
   persistent namespace's loss message will read ([`docs/dev/housekeeping.md`](../../dev/housekeeping.md)).
2. **Intrinsic taming with Agoric's `ses`: `lockdown()` after Pyodide boots.** Measured by lane 1: 18 ms; the
   `Function`, `AsyncFunction` and `GeneratorFunction` constructors throw afterwards; a numpy/pandas cell and a later
   `loadPackage` still work. Two caveats from that measurement: indirect `eval` of a string still works after
   `lockdown()`, so the strip below must cover `eval` through any alias; and `lockdown()` removed `.sig` properties
   Pyodide had attached to `Math` intrinsics, with nothing visibly breaking in ONE run. Do not trust one run: run lane
   3's corpus of real cells (`notebooks/python-dialect/`, PR #677) under lockdown against unlocked, and carry the number
   in the PR. If `.sig` is Pyodide's FFI signature cache, keep those properties through `ses`'s allowlist rather than
   skipping `lockdown()`.
3. **An ALLOW-LIST strip of the worker's `globalThis` after boot**, never a deny list: remove the real `Function`,
   `eval`, `importScripts`, the `WebAssembly` string-compiling paths, `setTimeout`/`setInterval` with a string
   argument, and the whole host surface (`fetch`, `XMLHttpRequest`, `WebSocket`, `indexedDB`, `caches`, `navigator`,
   `postMessage`, `addEventListener`). The relay keeps CLOSURE-HELD references captured before the strip; `onmessage` is
   defined once, non-writable, non-configurable. A JsProxy of `globalThis` must then find nothing. Commit the kept list
   as the set Pyodide needs, with a test that enumerates `globalThis` and fails on anything outside it.
4. **No JsProxy in the Python namespace at all.** The stdout tee becomes Pyodide's JS-side `setStdout` (batched or
   raw). The later `ml` callback ([`ML_WIRE.md`](../../spec/ML_WIRE.md), lane 1's PR 2) is a message through the
   closure-held post, never a function the cell holds.
5. **Cancel the asyncio loop's pending handles before a cell's result is returned**, so nothing scheduled by one cell
   runs during the next, even with the strip in place.

## Acceptance

- The red-team session's vectors, which fail first and pass after, including a JsProxy-of-`globalThis` probe.
- The corpus regression number from step 2.
- The `globalThis` enumeration test from step 3.
- Tests run under real CPython in `dist/pyodide/` (they self-skip without it).
- `docs/dev/python-sandbox.md` rewritten in the same PR: the hardening section describes the allow list, the principals
  and the respawn, and no longer describes `harden()`/`unharden()` as the security model.
- Anything kept across calls (the per-principal workers, the kept-globals list) declared in the state registry.

Labels `@python,@security`. Design questions to `repl-specs` by session-mail; do not block on an answer, state the
assumption in the PR.
