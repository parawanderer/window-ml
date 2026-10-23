# Result: the cancel sweep's two gaps (python-cancel)

Result for [PYTHON_CANCEL_GAPS.md](PYTHON_CANCEL_GAPS.md), 2026-10-23, session `5dfb667d` (`[window-ml python-cancel]`, work
slug `python-cancel`). Lands in #1051 (reviewed by `window-ml-flaky-ci`; merging when CI is green).

## What landed

- **Gap 2, the spend.** The wrapper's cancel cancels every task, turns the loop (`await asyncio.sleep(0)`), and repeats
  while any is pending, at most 8 rounds. A cancelled coroutine's `finally`/`except` runs inside the cell's own time,
  output in its stdout (the ruling on "runs after the result"). A task still pending after 8 rounds refuses the cell's
  result, naming the task. Under the fix the kept task reads `done() == True`, `cancelled() == True`, and a later
  `_coro.throw` runs none of its code (the generator is exhausted).
- **Gap 1, the cell gate** (`src/python/cell-gate.ts`). Hooks Pyodide's three doors from a Python callable to JS,
  before `lockdown()`: `Module.pyproxy_new` (revoke: point the proxy at an inert callable), once-callables through
  `Module.finalizationRegistry` and `Module.callPyObject[MaybePromising]` (revoke: block the pointer, a reference held),
  and `Promise.prototype.then`/`finally` (revoke: a flag in the wrapped reaction). Every hook is non-writable and
  non-configurable. A revoked callable that fires is a silent no-op, counted; the worker reports
  `dropped: {count, afterCell}` on the next cell and `sw-python.ts` records `python`/`dropped` in the run log. A later
  cell that reschedules a blocked callable is refused in that cell.
- **Order: spend, then revoke.** Revoking first blocks webloop's own `__step` once-callables, so no cancelled task runs
  to take its cancel and every later cell refused (measured). Ruled correct by the coordinator.
- The six `{ todo }` tests are plain tests; a new `P2-gate` section adds eight routes, six evasion routes
  (`_pyodide_core.create_once_callable`/`create_proxy`/`to_js`, all importable from a hardened cell, and
  `js.globalThis`'s `setTimeout`, `Promise` `then` and `queueMicrotask`, the same JS objects as `js.X`), early close,
  reschedule refused, silent-and-counted, and the hooks' non-configurability. A `P2-spend` section pins the refusal: a
  task that catches all 8 cancels fails the cell closed, named, value null, and the next cell runs clean.
  `docs/dev/python-sandbox.md` point (5) and a trap; a `docs/dev/run-log.md` row.
- The rest of `_pyodide_core`, reasoned rather than tested: `raw_call`/`run_sync` convert through the same doors,
  `destroy_proxies` only destroys, `trigger_fatal_error` kills the cell's own interpreter.

## Numbers

| Measure | Value |
| --- | --- |
| Mutation: gate reverted alone | 21 tests fail (five gap-1 todos, fourteen routes, early close, reschedule, silent+counted) |
| Mutation: spend reverted alone | 1 fails (`_coro`; measured before `P2-spend` existed) |
| Mutation: refusal alone | 1 fails (`P2-spend`) |
| Spend on a cell that schedules nothing | 0.98 µs (one `all_tasks()` scan, no loop turn) |
| Gate `revoke()` on the same cell | 1.29 µs |
| Empty cell, for scale | 44 ms median, 52 ms p90 (300 cells, Node, after lockdown) |
| `tests/redteam-python-sandbox.test.mjs` | 53 pass, 2 todo |
| `npm test`, branch rebased onto main | 6876 pass, 0 fail, 10 todo |

## What is left, and whose

- **`pyodide_js` reachable from a cell** (the red team's lane, #1036). The fix is sound only while it is not: two new
  `{ todo }` tests go through it (`runPython.bind` handed to `setTimeout`; a later cell writing
  `PyProxy_getAttrsQuiet(p).shared.ptr`). They turn plain when that closes.
- **SES `lockdown()` throws on main** (#1038, builder per #1040/#1043). The gate does not depend on it: it is
  installed once per realm (`gate ??= installCellGate(py)`) and its hooks are non-configurable on their own.
- **Drops after a run's last cell are not reported**: the count rides on the next cell's result. Nobody owns this; it
  is a run-log completeness gap, not a sandbox one.
- **A task that never yields cannot be spent**: the spend's `sleep(0)` hands it the CPU and the cell hangs to the run's
  timeout instead of refusing. Same class as a busy-loop task hanging the next pump; nobody owns it.
