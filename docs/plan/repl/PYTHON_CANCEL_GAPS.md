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
task never ran: the task started and suspended inside its `try` stays as is; "the sweep left it pending" cannot stay,
since a pending task is the gap, and its replacement pins the GENERATOR, not the Task (rule 5, no proxies): after the
later cell's `_coro.throw`, a second `throw` raises (`StopIteration`, or "cannot reuse already awaited coroutine") instead
of running the `finally`. `t.done()`/`t.cancelled()` are not pinned: the red team notes (2026-10-23) that a fix which
drives `_coro` directly can exhaust the generator while the Task's own state still reads pending, so they are the
mechanism's business; the PR body says what they read under the fix chosen. Say there which assertions moved and why.

**Ruling on revocation** (coordinator, 2026-10-23, on the builder's measurement): the chokepoint is the proxy, with
REVOCATION in place of `destroy()`, since a destroyed once-callable or PyProxy throws when its registry fires it and
`offscreen.ts` kills the worker on that throw, and `webloop` makes one once-callable per `call_later`, so destroying
everything recorded would kill the worker after any cancelled timer; the per-registry fallback is out as well (the tests
lock down with an empty scope, so `js.setTimeout` there is Node's own and wrappers would go unexercised). The doors, as
the builder enumerated them from `pyodide.asm.mjs`: every PyProxy through `pyproxy_new` (revoke: point it at an inert
callable); `create_once_callable` (creation is not hookable; each wrapper calls `callPyObject(ptr)`, so the ptr is
blocked while a revoked wrapper of it lives); promise handles (`then`/`catch`/`finally_` with a raw Python callable,
covered by wrapping `Promise.prototype.then`/`finally` before `lockdown()` freezes them); `_agen_handle_result_js` is
machinery only, the reason in the PR. Open and close of a cell's epoch come from the wrapper through a JS gate the
harness captures in a Python closure, so the namespace holds no JsProxy. The two halves of "silent": a revoked wrapper
that a stale registry FIRES after the cell's result is a silent no-op, never an error (nothing after the result may raise
into the worker), counted and recorded through the run log (`recordRunLog`, `docs/dev/run-log.md`) so a person sees how
many callbacks were dropped after which cell; a LATER cell that schedules a blocked ptr again is refused at schedule time,
in that cell, as an error the cell sees, never a callback that silently never comes. Silent after the result, loud inside
a cell. One more failing-first test: a cell that reaches the gate and closes its own epoch EARLY, then schedules; every
callable from the cell's start to the cancel is revoked regardless, the early close idempotent, the cancel's revoke
spanning the whole cell.

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

## RULED 2026-10-27: a task that never yields during the spend (the lane's design note)

Found by the lane itself (`LANE_PYTHON_CANCEL_RESULT.md`, "what is left"); the design note is the lane's
(`tmp/python-cancel/NOYIELD_NOTE.md`, untracked), measured after `lockdownReadonly` on STOCK Pyodide first and on the
pinned fork core second (pin 13 below; every result reproduced). Ruled by the
coordinator (`repl-specs`, session `7a8ce8b6`) the same hour:

1. **Refuse, not interrupt.** The spend is BOUNDED, in Python, by a `sys.settrace` hook installed only around the
   spend's rounds and never during the cell. A task the hook stops counts as UNSPENT and the cell's result is refused by
   name, the same shape as the eight-round refusal (`result = None`, a named `RuntimeError` saying which task kept running
   after its cancel and that the result is refused rather than returned beside it). The worker and the run's namespace
   survive. Pyodide's interrupt buffer is out: it needs a SharedArrayBuffer (COOP/COEP on the offscreen document, a change
   with reach beyond Python) and reaches no further than the hook, since both act between bytecodes.
2. **One budget for the whole spend, about 1 s, not per round.** The worst case for a cell is its own time plus the
   budget; per round would multiply it by the round count. The number is the lane's to measure; what is pinned is that it
   is a total.
3. **A loop inside C code keeps the 15 s kill, named.** The worker posts a "spending" mark to the offscreen before the
   spend starts (never before the cell's own code), so a kill after it names the leftover task instead of telling the
   model to simplify the computation. The namespace is lost there: only a kill stops C. Accepted.
4. **The shipped cores are enumerated, not assumed** (rule 8): a test asserts, per core we ship, whether the wrapper's
   `sys.settrace` is reachable and so which path (1 or 3) a spinner takes. If a core cannot reach it, that core takes
   path 3 only, and the test says so by name.
5. **A cell's own trace hook** (reachable outside the dialect only) is replaced for the spend and restored to `None`,
   never to the cell's hook. A handler whose first line clears the hook is a test row: the line event fires before the
   statement runs, so the hook raises first.
6. **Tests and review (rule 10).** The lane's rows (every row of the note's table, the control, the hook-clearing
   handler, the mutation check with the bound off, in a time-limited child process) land in the lane's own file; the
   janitor reviews the PR. The adversarial half is the red team's AFTER the merge, in e3's own file, from a brief naming
   what to probe: a handler that re-installs a hook, a thread started before the cancel, a generator or `exec` that
   reaches a C loop, and the spend's budget as a clock the cell can read. Nothing of that is the lane's to write.

### Amended 2026-10-27, later the same day: WHERE the cancel and its bound live (the lane's rebind finding)

Found by the lane in its own #1051 cancel, measured after `lockdownReadonly` (on stock Pyodide, then reproduced on
the pinned fork core, pin 13), in an approved
outside-dialect cell: the cell's body is compiled in the wrapper's own globals, and the cancel calls its hooks through
those same globals, so `global _ml_cell_revoke; _ml_cell_revoke = lambda: None` keeps a `setTimeout` callback alive past
the result (it ran; the control without the rebind was revoked). The same rebind reaches the round count, the spend's
`asyncio` lookup, and the bound's clock and hooks if they lived in the wrapper. Ruled the same hour:

7. **The cancel is a closure built at boot, called from JS, in a `finally`.** Nothing the cancel reads is a name a cell
   can rebind: the harness function captures what it needs at boot, and the worker calls it through the PyProxy the
   lockdown already returns, after `runPythonAsync` and in a `finally`, so an exception from the result's serialisation
   cannot skip it. This replaces the earlier "HERE, not at the end of the wrapper" placement. The bound (pins 1 to 5)
   lives inside that closure. The cancel's own output goes to a buffer of its own that JS appends to the cell's stdout;
   its refusal text JS appends to the error, with the value nulled.
8. **Capture CALLABLES and values, never modules.** A captured module is a dict a cell can still write into
   (`asyncio.sleep = …`), so the closure holds `asyncio.sleep`, `asyncio.all_tasks`, `gc.get_objects`, `sys.settrace`,
   `sys.setprofile`, `time.monotonic`, the loop and the revoke function as bound references, and the round count and the
   budget as plain values. A class a captured callable dispatches through (`Task.cancel`) is a surface the closure cannot
   close by capture; that one is the red team's row (below), and if it reaches, the answer is the lockdown's (the security
   lane's `fix/python-lockdown`), not a second cancel.
9. **The disarm is refused, not left to the kill.** The lane measured a profile hook that refuses a `c_call` of
   `sys.settrace`, `sys.setprofile` and `threading`'s equivalents during the spend, so a handler's `sys.settrace(None)`,
   an aliased `st = sys.settrace; st(None)` and a `setprofile(None)` at the call are refused (3 to 9 ms). Pin 5's
   "replaced and restored to `None`" stands; this is the enforce layer beneath it.
10. **The full worker keeps today's in-wrapper cancel.** Without the lockdown there is no PyProxy to call through and no
    hardened namespace to protect; that worker always asks. Narrow beats wide: the closure is built where the lockdown
    runs, and the plain-CPython tests keep the wrapper path. A test asserts which path each worker takes, by name.
11. **Inside-dialect cells are measured, not assumed out of reach** (rule 8). The lane's claim is that they run in a copy
    of the namespace with no `_` names; one test row pins it (a dialect cell that tries the rebind and is refused by the
    dialect, or has no such name to bind). Until that row exists the plan says "unprobed".
12. **Tests (rule 10).** The rebind case is the lane's own regression and lands in the lane's file, with the control.
    Everything else adversarial is e3's, after the merge, from the brief in pin 6 plus: the rebind through an alias and
    through `globals()[...]`; a write to a captured callable's class (`asyncio.Task.cancel`, `Future.cancel`); a cell that
    replaces the loop's `call_soon`; a cell that raises `BaseException` from `__del__` of an object the cancel touches; a
    rebind made from a task that runs DURING the spend rather than from the cell's body. The janitor reviews the lane's PR.

### Amended 2026-10-27, later again: the two cores, and the cancel in the SAME coroutine as the cell

Reported by the lane while building `python-cancel/spend-bound`. Two corrections to what the rulings above rested on,
both measured (rule 8):

- The never-yield, disarm and rebind probes first ran on STOCK Pyodide, not the pinned core: the lane's fresh clone had
  not run `npm run fetch-pyodide`. Rerun on the fork core (`pyodide-restricted-314.0.3-ca282158`), against the
  pre-change code, every result reproduces: the rebind's `woke` is `["ran"]` with its control `[]`, each Python-level
  spinner stops at the 0.5 s deadline, and `settrace(None)`, the alias and `setprofile(None)` are refused in 2 to 5 ms.
- Calling the cancel from JS after `runPythonAsync` resolved (pin 7 as written) leaves a GAP: microtasks and `call_soon`
  handles the cell queued run in it, before the cancel reaches them. 9 of the 55 existing red-team rows failed on that
  placement; with the cell's script and the cancel as one coroutine, all 55 pass.

Ruled the same hour:

13. **Two cores in practice, both enumerated.** Pin 4's enumeration names the stock core (a dev checkout without the
    fetch) and the fork core (CI and the release), and asserts the path each takes. A measurement in this doc says which
    core it ran on; "the pinned core" is not assumed from a checkout.
14. **Script and cancel are ONE coroutine, built at boot.** The harness closure of pin 7 runs the cell's script (through
    the captured `eval_code_async`) and then the cancel inside the same coroutine, so nothing the cell queued runs between
    the two; the `finally` of pin 7 moves inside that coroutine, so a script that raises or is itself cancelled still gets
    the cancel. JS calls the closure through the PyProxy the lockdown returns, once per cell. Everything else in pins 7 to
    12 stands: captured callables not modules, the separate cancel buffer JS appends to stdout, the refusal appended to the
    error with the value nulled, the full worker on the wrapper path. The lane's regression row for the gap is the
    existing 9 rows passing on the new placement, with one named row asserting a `call_soon` handle queued by the cell is
    revoked, not run.

### Found 2026-10-27 by the second red team (`window-ml-redteam-hard`, hunt 2): the bound does not see a callback with no Python frame

The first hunt on the merged spend bound (#1150, afcbe2b9), a bounded question with Shane's allocation: can a cell get
past the 15 s kill, mis-name its cause, or outlive the 1 s bound without C code. The first confirmed case closed it:
built-in callbacks a cell has already queued on the loop (`call_soon` of a builtin) kept the spend busy for 3802 ms and
3327 ms on two runs, measured on the fork core through `lockdownReadonly` and `hostRunScript` from the real
`onSpending` mark to the cancel's return; the ordinary-task control took 15 ms and 13 ms. Under the kill, so not an
escape, but the bound of pin 1 is defeated: a `sys.settrace` deadline fires on line events, and a callback with no
Python frame raises none. The kill's cause and the namespace loss were not measured; no claim about them. Pinned as a
failing-first todo in test-only #1171 (`redteam-hard-python-cancel.test.mjs` under `tests/`, a positive control in the same
test, stock core skips), reviewed by the first red team, never by the lane.

Ruled the same hour: the defect is the lane's (rule 9, reported through the coordinator in defect language), the fix
lands AFTER #1171 on main in the lane's own file (rule 10), and the second red team flips the todo plain after the
fix merges, touching nothing else. A fix that sees the loop's dispatch (a bound on the loop side, or a hook the
dispatch itself consults) is a narrowing and needs no ruling; anything that widens what a cell may leave running comes
back here first.

Ruled 2026-10-27, on the lane's fix shape (measured in plain Pyodide: webloop gives every `call_soon` its own JS
callback, FIFO, so the cancel's own wakeup waits behind the whole flood and no Python-side bound can run first;
250k queued = 598 ms to drain without hooks, 3.3 to 3.8 s under the real ones):

15. **A loop-side bound, in JS.** At boot the lockdown replaces `pyodide.webloop.scheduleCallback` with a wrapper that
    records each entry's queue time; once the spend's deadline passes (JS learns it from the `spending` mark), every
    entry queued before the deadline is dropped in JS without entering Python, except the one `call_soon` made by the
    harness one-shot the cancel now waits on instead of `sleep(0)`; entries queued after the deadline run, so the
    run's own completion is never dropped. The raw scheduler is captured at boot, out of a cell's reach; a cell that
    rebinds the module global installs only a Python callable, and what that schedules is already the cell gate's to
    revoke. Prototype at a 100 ms deadline: 2.5M queued = 354 ms spend (2.42M dropped, ~100 ns each); the overrun past
    the deadline is ~0.04x the time the cell spent queueing, so under the kill at most ~0.6 s. A narrowing.
16. **Refusal, not a tag.** A leftover task whose cancel-step the flood pushed past the deadline never takes its cancel:
    telling that step apart from the cell's callbacks would need a per-entry tag a cell can forge from the closure, a
    proxy (rule 5). The cell's result is REFUSED by name with what was measured: the number of callbacks dropped at the
    deadline and the task that never took its cancel; `result = None`, a named `RuntimeError`, worker and namespace
    survive. The second red team amends its two value assertions in #1171 to this behaviour (within the bound; the value
    or a refusal naming dropped callbacks) before #1171 merges; the lane touches nothing in that file.
17. **Dropped proxies are destroyed, deferred; never a note.** A dropped once-callable `PyProxy` keeps the cell's Python
    callable and its globals alive in the worker the next cell shares, the #757 class of cross-cell reach. Measured
    first (rule 8): whether the next cell reaches a dropped callable or its globals through `gc.get_objects()` or any
    walk. Whatever it shows, the dropped proxies are destroyed in a deferred sweep after the cancel has returned
    (batched, off the spend's path, so the overrun stays as prototyped), the reap frees the rest, and a test asserts the
    next cell reaches none of them; if the measurement shows reach before an idle sweep would run, the sweep runs
    before the next cell starts. The stress case's memory is stated in bytes beside the proxy count.

### Found 2026-10-27 by the lane, building the hunt-2 fix: a raising trace function unsets tracing

Measured on main and on the lane's branch alike, real lockdown harness, real 1 s budget: a task that catches the cancel,
busy-loops in its handler until the deadline fires, and then has 4 s of work in a nested `finally` held the spend for
5013 ms (control, empty `finally`: 1011 ms). Cause: when a `sys.settrace` function raises, CPython unsets tracing, so
every handler after the first deadline exception runs untraced; with `while True: pass` in that `finally` the bound of
pin 1 degrades to the 15 s kill. Under the kill, so a defect, not an escape. The same mechanism blocks pin 17's sweep:
closing a dropped task's coroutine under `settrace` runs its `except`/`finally` untraced. Found by the builder of the
defence, so it is the lane's own regression, and the second red team's standard pass pins it as a named property.

Probed fix, measured in Pyodide (3.14): the spend's hook moves from `sys.settrace` to `sys.monitoring` (`PY_START`,
`LINE`, `JUMP`); a raising monitoring callback leaves monitoring on. A busy loop's `except` and `finally` both stopped
at their first event (0.2 s run against a 0.2 s deadline, neither handler ran); `coro.close()` on a suspended coroutine
raised the deadline exception without running its handlers and its `cr_frame` came back `None`. `JUMP` is required: a
one-line `while True: pass` raises no `LINE` event under monitoring.

Ruled the same hour:

18. **Its own PR, first.** The monitoring switch is one mechanism change with its own review; it lands on main BEFORE
    the pins-15–17 fix, which rebases on it (step 5 of that fix depends on it). The lane's failing-first regression
    (the 4 s `finally` case, the control, the `while True` `finally` case under a child-process time limit as pin 6's
    rows run, and the `coro.close()` case asserting no handler ran and `cr_frame is None`) lands in the lane's file in
    that PR. The janitor reviews it in its queue; nothing waits on the second red team for this one. After it merges,
    the first red team (`window-ml-redteam-e3`) pins the case in its own file as a named row, with the mutation check
    (bound off, the case hangs), and that row is the property's pin from then on.
19. **`sys.monitoring` is guarded, universally** (rule 2). The attribute gate covers every function of `sys.monitoring`
    that installs, changes or removes a tool, its events or its callbacks, enumerated from the module's own namespace
    in a test (`dir(sys.monitoring)` filtered to callables, each asserted refused in a cell), never a hand-typed list
    of five. With that guard a cell cannot leave a tool running into the spend; the spend still asserts no foreign
    tool holds any id before it installs its own and refuses the cell's result by name if one does (pin 5's shape:
    measured, never assumed). The lane's own tool id is captured at boot with the other callables (pin 8).
20. **One mechanism where the measurement allows it** (rule 8). The `c_call` guard of pin 9 moves to monitoring's
    `CALL` event if the lane measures the same refusal there; if `setprofile` stays, the spec says why and both hooks
    are guarded and restored to `None` (pin 5). The skip-files rule moves into the callback. Pin 4's per-core
    enumeration gains the row "monitoring events the bound needs exist on this core".
