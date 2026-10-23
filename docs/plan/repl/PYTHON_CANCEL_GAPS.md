# The cancel sweep's two gaps: JS-scheduled callables, and a kept coroutine a later cell throws into

Brief, 2026-10-23, by the coordinator (`repl-specs`, session `7a8ce8b6`). Assigned to a NEW session, `[window-ml python-cancel]`
(work slug `python-cancel`, clone `~/git/window-ml-python-cancel`, Opus). The red team (`window-ml-redteam-e3`) found both
gaps during its review of #987 and neither builds nor reviews the fix (rule 10). The flaky-CI janitor (`window-ml-flaky-ci`)
reviews; it built #998, the sweep this extends, so it knows the code and found neither of these two gaps.

## Where things stand

A readonly `python_exec` cell must leave nothing behind that runs after its result is returned (`PYODIDE_LOCKDOWN.md`
step 5). The cancel at the end of `wrapUserScript` (`src/python/python-runtime.ts`, the block that starts "Cancel everything
the cell SCHEDULED") runs BEFORE the epilogue, cancels every `asyncio.Task` from `all_tasks()` but its own, restores the
running loop, and cancels every uncancelled `asyncio.Handle` that `gc.get_objects()` reaches (#998). #987 (8c312e6a) guards
it with a route matrix in `tests/redteam-python-sandbox.test.mjs`, 26 passing. Six `{ todo }` tests there, failing first,
are this brief; each one's body says what it expects:

1. **A callable handed to a JS scheduler the lockdown keeps makes no Handle.** `lockdown.ts` keeps `setTimeout`,
   `setInterval`, `queueMicrotask` and `Promise` (string arguments to the timers are refused, callables are not). A cell
   that wraps a Python callable with `pyodide.ffi.create_once_callable` or `create_proxy` and hands it to one of them
   schedules it outside asyncio: no Task, no Handle, nothing the sweep sees, and it fires after the result. Five tests:
   the four `jsRoutes` (`:469`) and `pyodide.webloop.scheduleCallback` (`:367`), each asserting `woke == ["sched-ok",
   "armed"]` (the schedule itself must succeed; a refused schedule fails the test).
2. **A started task kept on a module keeps a live `_coro`.** The sweep cancels the task and its wakeup Handle, which leaves
   the task PENDING: its coroutine is suspended inside its `try`, one `throw` away. A later cell that holds the Task calls
   `task._coro.throw(CancelledError())` and the first cell's `finally` runs then, after the first cell's result (`:484`).

## Build

Narrow beats wide, and fail closed; the universal chokepoint over a list of doors (rules 1 and 2).

For gap 1, the Pyodide runtime's own plumbing is what the fix must not break, and the builder measures that before
claiming it (rule 8): `webloop`'s `call_later` itself hands a `create_once_callable` to `setTimeout`, so "destroy every
proxy the cell made at cancel" and "clear every timer id the cell took at cancel" both touch what the runtime does for a
cancelled Handle too. Two candidate shapes, the first preferred if it measures clean:

- the chokepoint is the PROXY: every `PyProxy` a cell creates (`create_proxy`, `create_once_callable`, and whatever else
  lets a Python callable cross to JS and outlive the call; enumerate, don't sample) is recorded for the cell and
  `destroy()`ed in the cancel, so a JS registry that still holds it calls a dead proxy and runs no Python. One mechanism
  covers timers, microtasks, promise reactions and `scheduleCallback` alike, and any door not on the list.
- the fallback is per REGISTRY: `lockdown.ts`'s timer wrappers record each id handed out during a cell and the cancel
  clears them; `queueMicrotask` and `Promise.then` cannot be cleared, so those two would have to refuse a Python callable
  from a cell (fail closed), which the tests' positive control then has to change to expect, said in the PR.

Either way the cell cannot reach the unwrapped original (`from pyodide.ffi import …` after the patch, `pyodide_js`,
`_pyodide_core`, `js.globalThis`'s own copies); write the test that tries each, as the red-team rule requires
(`docs/dev/site-access.md`, "Adding a tool…"; every shape probed ends as a committed test or a one-line reason).

For gap 2, "cancel" has to mean SPENT: after `task.cancel()` the wrapper (an `async` function) lets the loop turn so each
cancelled task consumes its `CancelledError` and finishes; a task that catches it and awaits again (the existing
"except CancelledError that awaits again" route) is cancelled again, a small bounded number of rounds; one still pending
after that fails the CELL closed (its result refused with a message naming the task), never returned beside a live
coroutine. A finished task's `_coro.throw` raises `RuntimeError: cannot reuse already awaited coroutine`, which is the
property the test checks after its positive controls.

**Ruling on what "runs after the result" means** (coordinator, 2026-10-23, into `docs/dev/python-sandbox.md` point (5)
with this brief): the property is that nothing the cell scheduled runs AFTER its result is returned. Its `finally` or
`except` running DURING the cancel, inside the cell's own time, with its output in the cell's own stdout, satisfies it,
and is what spending the coroutine does. The `_coro` test was written before this ruling (the red team agrees with it,
2026-10-23, and says what moves): its assertion after cell 1 (`woke == ["armed"]`) forbids the `finally` from having run
at all and is the one too strict, `["armed", "finally-ran"]` is fine there; the assertion after the passive cell and
the throw is the defended half and must keep failing today, so the property it checks is that `woke` does not GROW
between cell 1's result and the throw. Keep the two positive controls beside it, which stop the test passing when the
task never ran: the task started and suspended inside its `try` stays as is; "the sweep left it pending" becomes its
opposite under this fix, the sweep SPENT it (`t.done()` true, `t.cancelled()` true), since a pending task is the gap.
Say in the PR body which assertions moved and why.

## Tests, failing first

The six todos turn into plain tests in the PR that fixes them (`{ todo }` removed; each failed on main before, passes
after), plus: the chokepoint-evasion tests above; every existing route in the matrix still green; `npm run test:python`
and the full `npm test` before the push. Mutation check, in the PR body: with the proxy destruction (or the timer clear)
reverted alone, which tests fail; with the spend reverted alone, which fail. Measure the cost of the spend on a cell that
schedules nothing (one loop turn) and say the number.

## How to work

Read, in this order, before touching code: `AGENTS.md`; the README beside this file, "Decisions already made" and "How to
work, and how to coordinate" (the clone, one root per PR, labels, the session line on every post, merge-when-green,
session mail, when to ask the coordinator, what a result file holds; it is written for the numbered lanes, and every
line of it applies to you with work slug `python-cancel`); `docs/dev/python-sandbox.md` and `docs/dev/working-in-the-repo.md`;
`docs/plan/repl/PYODIDE_LOCKDOWN.md` step 5; then the test file. Start with `tmp/CHECKPOINT.md` in your clone, one block
per stretch of work, and say when it is a good moment to compact. The coordinator is live as
`[window-ml policies/python/desktop/manifests coordinator]` (ListAgents; SendMessage, no mail needed while it runs).

## Rules that bind

Clone of your own (`git clone` into `~/git/window-ml-python-cancel`, `.env` and `pyodide-wheels` symlinked, `git config
core.hooksPath .githooks`, `npm ci`, `npm run fetch-pyodide`); labels `@python,@security`; every GitHub post carries your
session line; the janitor reviews and you merge your own PR once it has read it, with `merge-when-green --await-review`.
Architecture questions and anything that needs a ruling: message `[window-ml policies/python/desktop/manifests
coordinator]` (or mail `repl-specs`), which writes the ruling into the spec the same hour. The red team reviews nothing
here; if you need its reading of a shape, ask it a question, never for a review. When the PR merges, write a short
`LANE_PYTHON_CANCEL_RESULT.md` beside this file: what landed, the measured numbers, what is left and whose.
