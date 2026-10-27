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
   Pyodide had attached to `Math` intrinsics, with nothing visibly breaking in ONE run. A third, from the red-team
   session's probe of `ses` under Node 26 (2026-10-15): `lockdown()` does NOT make the DIRECT `Function` and `eval`
   globals throw, only the prototype-chain constructors (`({}).constructor.constructor`, `AsyncFunction`,
   `GeneratorFunction`, `Function.prototype.constructor`), which is `ses`'s documented design (the start compartment
   keeps its own powerful `eval` and `Function`). So the two steps divide the work and both are needed: `lockdown()`
   closes the prototype-chain route (P1), the strip (step 3) removes the direct globals. A vector asserts each half on
   its own: the chain route throws, and `globalThis.Function`/`globalThis.eval` are absent. Do not trust one run: run lane
   3's corpus of real cells (`notebooks/python-dialect/`, PR #677) under lockdown against unlocked, and carry the number
   in the PR. If `.sig` is Pyodide's FFI signature cache, keep those properties through `ses`'s allowlist rather than
   skipping `lockdown()`.
   DEFECT FOUND 2026-10-23 by the `[window-ml python-cancel]` session, reproduced by the coordinator the same hour in
   Node with `ses` 2.3.0: on main `lockdown()` THROWS ("Accessor not expected at intrinsics.%ObjectPrototype%.constructor")
   because `lockdown.ts` defines an accessor on `Object.prototype.constructor` just before it (the #735 fix for Pyodide's
   `getPyProxyClass` assigning `n.constructor`); the `try/catch` around the call swallows the throw, `locked` never sets,
   every `lockdownReadonly` call reruns the boot, and `Object.isFrozen(Promise.prototype)` is false afterwards. The
   control without the accessor freezes. P1 still passes because `ses` tames the `Function` constructors before its
   permit check throws, which is why no vector noticed: nothing tests that the realm is FROZEN. The worker
   (`python-worker.ts`) takes the same path; not yet measured in a browser. ASSIGNED the same day, with the step 4 gap, to the
   `[window-ml security] Site access` session as BUILDER (corrected within the hour: the red team is a finder-side lane
   and builds no defence, rule 10; it delivers the failing-first tests as their own PR; the finder builds and reviews
   nothing on it; the janitor reviews both PRs): a failing-first test that `Object.prototype` and `Promise.prototype` are frozen after boot and
   that the latch sets; keep the `n.constructor` path of #735 working, measured both ways (an `ses` option that permits
   the accessor, or the accessor installed by another route after the freeze). Step 5's gate is built not to depend on
   the latch, so it holds either way. Property from the red team, ruled in: do NOT widen the `ses` permit to allow the
   accessor, since an accessor on `Object.prototype.constructor` is a write path to `Function` for anything that reaches
   the prototype; install it after `lockdown()`, or by a route `ses` does not treat as an intrinsic write.
   FIX SHAPE ruled 2026-10-23 on the builder's candidate, measured in Node: drop our accessor and pass `ses`'s own
   `overrideTaming: "severe"`, under which `lockdown()` installs the `Object.prototype.constructor` accessor itself
   (getter returns the frozen original, setter refuses `this === Object.prototype` and otherwise defines an own
   property); `lockdown()` then succeeds, the realm is frozen, and `n.constructor = v` on a plain object is an own
   property. Narrower than ours, which would have redefined the accessor on the prototype itself. Carried in the PR:
   the #735 DataFrame/table path in the real worker both ways; the `notebooks/python-dialect/` corpus under the new
   boot against the old (cell count, any new failure) since "severe" puts accessors on every property of the tamed
   intrinsics; boot time next to lane 1's 18 ms; a test that the freeze is real and the latch set, and that a cell
   assigning `Object.prototype.constructor` is refused.
   MEASURED 2026-10-23 by the builder (branch `fix/python-lockdown`, before its PR): the table/DataFrame cells never
   exercised #735 (they pass under a plain freeze); the real #735 property is a probe of 14 PyProxy kinds after boot,
   of which a plain freeze breaks 6 (tuple, set, generator, ndarray, iterator, memoryview), the old boot leaves the
   realm unfrozen and lets `Object.prototype.constructor = Function` through, and the severe boot freezes with 0 of 14
   broken and refuses that write; that probe is the committed test. The dialect corpus of 1714 real cells gives
   identical outcomes old against new (318 ok, 1396 error, 0 changed; 9 ok results differ only by random output); the
   lockdown step goes from 8.1 ms to 9.0 ms; a boot that leaves the realm unfrozen now FAILS. For the step 4 gap:
   `pyodide_js` is unregistered after webloop and the package loader bind what they import, `sys.modules` purged, the
   old JsLoaders' proxy cleared (a loader held the API alive past `gc.collect`, findable via `gc.get_objects`), and a
   stand-in re-registered carrying only `_api.config.enableRunUntilComplete` (webloop and the patched `asyncio.run`
   import config at call time); the gc walk finds 0 live proxies of the API, `_api` or `_module` (2 before), and
   `asyncio.run` works, also after a cell pops the stand-in. OPEN, the red team's probe in its test-only PR: in Node
   `run_js` still answers under the stand-in scope; in the worker that rests on step 3's strip removing eval, measured
   only in the real worker.
   RULED 2026-10-23 (coordinator, on the builder's question after running the red team's #1060 against #1046's branch):
   #1046 merges as ruled, the stand-in and nothing wider. (i) `run_js` is OPEN, now with its route: `pyodide/code.py`'s
   `run_js` does `from js import eval`, not `pyodide_js`, and `from js import Function` is the same route, so the
   stand-in cannot close it and a clean `lockdown()` does not either (the kept `Function` binding still evaluates);
   closing it is a step 3 property (the strip) or a refusal of `js` in an approved cell, which is a NEW defence with a
   corpus cost: widening, Shane's call, parked under the 2026-10-23 freeze. (ii) The red team's todos that ask for
   `import js`, `pyodide.ffi`, `pyodide.webloop` and `import asyncio` to fail in an approved cell ask for that same
   widening; they stay `todo`, labelled as parked, not as #1046's debt. (iii) Its todos that ask for `pyodide_js` not to
   import assert a property wider than the ruled one; the ruled property is "`pyodide_js` imports as a config-only
   stand-in with no `_module` and no `_api` beyond `config`", and the red team, never the builder (rule 10), rewrites
   those todos against it or keeps them as a record of the wider ask. (iv) The finder's and the builder's tests live in
   separate files: the red team's keep `redteam-python-lockdown.test.mjs` (on #1060's branch); #1046 renames its own to a non-`redteam-`
   name before it is marked ready, so neither PR merges the other's file. Severity, from #1060: the bridge imports reach
   from an APPROVED cell; the auto-approved inside path refuses every import form unasked.
   FIXED 2026-10-23: #1046 merged de645ea3 (`[window-ml security] Site access`, rebased on #1051; the janitor reviewed,
   its one finding, pin the stand-in's `enableRunUntilComplete`, fixed in 117bd3e1 before merge; builder's tests in
   `python-lockdown.test.mjs`). The DEFECT and the step 4 GAP above are closed as measured; `run_js` and the parked
   widening questions stay as ruled. CI's first run failed one #1051 test (P2 gate, "a revoked callback that fires
   after the result is silent and counted"), green alone, in its file and on the rerun: a timing flake, watched.
   RULED 2026-10-27 on the parked widening (ii), by Shane in the security lane's session (relayed by `[window-ml
   security] Site access`, session 2dfb7129, mail `20261027-1434Z-site-access-to-repl-specs-lockdown-widening-ruled.md`;
   CONFIRMED by Shane in the coordinator's session the same day, with the caller-scoped refinement below): refuse by
   default, an explicit approval
   lifts it. `js`, `pyodide.ffi` and `pyodide.webloop` are refused in an approved cell by the WORKER (so
   `__import__("j"+"s")` gains nothing), unless the approval card carried an explicit line that the cell reaches the
   browser's JavaScript and the person approved with it showing; that card line is a new public string whose wording
   goes to Shane before it lands. `asyncio` is NOT refused: its risk (work outliving the cell) is closed by #998's sweep
   of tasks and Handles. Even under the explicit approval, nothing a cell schedules outside asyncio (`pyodide.ffi`
   once-callables or proxies handed to `setTimeout`, `setInterval`, `queueMicrotask`, `MessageChannel`) may run after
   the cell's result: that route is refused or swept at the epilogue, and approving one cell never covers code that runs
   during a later one. Packages' own boot-time imports keep working (pyarrow's `unix_timezones` does `import js` at
   import time), so the refusal is by the CALLER (the cell's own frames), never by the name alone. Lands as its
   own PR (the security lane's `fix/python-strip`), ahead of this document's step 3 (the strip), which is measured
   with the approval granted and so waits for the lift; "SITE_PRESENCE step 3" in an earlier wording of this line was
   a slip, corrected 2026-10-27 on the lane's question. The two `run_js` todos it makes pass are flipped plain by the
   red team after the merge, in its file; the `asyncio` todo and the `from js import setTimeout` one are
   rewritten against this property by the red team (rule 10), never the builder.
   The coordinator's reading of the two routes it touches: no conflict with step 3 or with (i). The refusal closes
   `run_js` (`from js import eval`) for the DEFAULT approved cell only; under the explicit approval `js` is back and
   only step 3's strip closes `run_js`, so (i) stays a step 3 property and the strip is measured WITH the approval
   granted, not only without. One row the caller-scoped refusal adds for the red team: reaching `js` through a package
   that imported it at boot (`pyarrow.unix_timezones.js`, or any module attribute holding a JS proxy); the attribute
   gate's manifest answer is the claim, pinned or refuted after the fix merges.
3. **An ALLOW-LIST strip of the worker's `globalThis` after boot**, never a deny list: remove the real `Function`,
   `eval`, `importScripts`, `setTimeout`/`setInterval` with a string argument (`WebAssembly` compiles bytes, never a
   string, and `WebAssembly.instantiate`/`compile` on bytes STAY, since a `loadPackage` after the strip needs them; the
   first draft's "string-compiling paths" named nothing real), and the whole host surface (`fetch`, `XMLHttpRequest`, `WebSocket`, `indexedDB`, `caches`, `navigator`,
   `postMessage`, `addEventListener`). The relay keeps CLOSURE-HELD references captured before the strip; `onmessage` is
   defined once, non-writable, non-configurable. A JsProxy of `globalThis` must then find nothing. Commit the kept list
   as the set Pyodide needs, with a test that enumerates `globalThis` and fails on anything outside it.
4. **No JsProxy in the Python namespace at all.** The stdout tee becomes Pyodide's JS-side `setStdout` (batched or
   raw). The later `ml` callback ([`ML_WIRE.md`](../../spec/ML_WIRE.md), lane 1's PR 2) is a message through the
   closure-held post, never a function the cell holds. None means none: the injected inputs (`INJECTED_IMAGE_B64`,
   `INJECTED_TABLES_JSON`, the prelude's `_b64`/`_tsj`) land as `JsNull` today when the harness passes a JS `null`, and
   become Python `None`/`str` at injection time (measured by the red-team session, 2026-10-15).
   GAP FOUND 2026-10-23 by the `[window-ml python-cancel]` session, reproduced in a worker after `lockdownReadonly`: a
   cell can `import pyodide_js` and from it reach `_api` (`runPythonInternal`, `rawRun`, `scheduleCallback`) and
   `_module` (`ccall`, `dynCall`, `HEAP`, `_Py_IncRef`/`_Py_DecRef`, `PyProxy_getAttrsQuiet`, every hook installed on
   `Module`). `js.setTimeout(pyodide_js._api.runPythonInternal.bind(None, src), 10)` runs `src` after the cell's result
   with no Python callable crossing, so step 5's cancel has nothing to revoke; a later cell can un-revoke a proxy
   through `PyProxy_getAttrsQuiet(p).shared.ptr`. The pre-lockdown `harden()` in `python-runtime.ts` unregisters
   `js` and `pyodide_js` and purges `sys.modules`; the lockdown worker does not call it. ASSIGNED the same day, corrected
   within the hour, to the `[window-ml security] Site access` session as builder (the red team, a finder-side lane,
   builds no defence and delivers the attribute-gate probe as failing-first tests; the finder builds and reviews
   nothing on it, rule 10; the janitor reviews): make
   `pyodide_js`, `_module` and `_api` unreachable from a cell while Pyodide's own boot-time `from pyodide_js._api
   import scheduleCallback` keeps working; a gc-walk test that no live Python object holds a JsProxy of `Module` or
   the API; every other way to the API object enumerated. The finder's PR carries the two failing-first `{ todo }`
   tests (the string-run route; the un-revoke) and makes its own hooks non-writable; the cancel fix of step 5 is sound
   only once this is closed. MEASURED the same day by the finder on the fork core in `dist/pyodide`, through `wrapUserScript` as
   `python-dialect-inside.test.mjs` runs it: the dialect does NOT admit these routes unasked. `import pyodide_js`,
   `import js`, `from js import setTimeout`, `import pyodide.ffi`, `import pyodide.webloop`, `import asyncio`,
   `__import__('pyodide_js')` and the full string-run cell are each refused inside, so the cell asks. So this, and
   all six cancel-gap routes of step 5, escape an APPROVED readonly cell, not the auto-approved path. Limit of the
   measurement: import forms only; reaching those modules through an admitted object's attributes (the dialect's
   attribute gate) is the red team's to probe with the fix.
5. **Cancel the asyncio loop's pending handles before a cell's result is returned**, so nothing scheduled by one cell
   runs during the next, even with the strip in place.
6. **The harness binds its own module functions at boot** (red-team property P5, 2026-10-15). A cell that monkeypatches
   `ast.parse` or `json.loads` keeps the patch across the per-run RESET, since that is module state and not a namespace
   name, and could read the next cell's source and injected tables through the wrapper's own calls. Split by principal:
   CROSS-principal it is closed by step 1 (a worker per principal, respawned on change), and the vector's cross-principal
   half must pass from that alone. INTRA-principal it is the same thing as the persistent per-run namespace (root C) is
   about to make deliberate, so there is no module-state restore and no interpreter per cell. What must never depend on
   patchable module state is the HARNESS: the wrapper's parsing, line correction, result encoding and table injection
   (`ast`, `json`, `base64`, the stdout path) capture their own references before any cell runs and use only those. A
   cell's patch may change what the run's own later cells compute; it can never change what the harness reports or
   injects, which is the raw-view rule.

## Acceptance

- The red-team session's vectors (PR #698, `redteam-python-sandbox.test.mjs` under `tests/`, marked `todo` until the lockdown
  lands), which fail first and pass after: P1 to P4, and P5 in its two halves (cross-principal: a patched function is
  not visible after the principal changes; intra-principal: the harness's reporting is unaffected by a patched
  `json.loads` even though the next cell's own call sees it).
- The corpus regression number from step 2, and the lockdown's cost measured on the cold worker (the 18 ms above was
  one measurement in one realm; the PR carries its own).
- P4's half that reaches `globalThis` through the P1 route (`to_js({}).constructor.constructor("return this")()`)
  passes as "the route is blocked" once it throws under `lockdown()` (ruling, 2026-10-15): an unreachable surface is
  the stronger property. The surface assertion itself then runs from the HARNESS side, trusted code enumerating
  `Object.getOwnPropertyNames(globalThis)` against the committed allow-list (the step 3 test), never through an
  attacker route, and the stand-in-scope assertion stays as the strip's direct check.
- A `loadPackage` of one wheel after `lockdown()` and the strip succeeds (the on-demand packages root loads after both).
- The `globalThis` enumeration test from step 3.
- Tests run under real CPython in `dist/pyodide/` (they self-skip without it).
- `docs/dev/python-sandbox.md` rewritten in the same PR: the hardening section describes the allow list, the principals
  and the respawn, and no longer describes `harden()`/`unharden()` as the security model.
- Anything kept across calls (the per-principal workers, the kept-globals list) declared in the state registry.

Labels `@python,@security`. Design questions to `repl-specs` by session-mail; do not block on an answer, state the
assumption in the PR.
