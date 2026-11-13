# Async calls: how detached calls are built

How a call that outlives its turn is built today. What each mode SHOULD do, the open questions and the rulings live in
[`docs/spec/ASYNC_CALLS.md`](../spec/ASYNC_CALLS.md); this file holds only what the code does, and grows with each
slice. Built so far: mode 1 (the escalation lease) on `ml.sh`. Not built: mode 1 on `python_exec` and `exec`, modes 2
and 3.

## Two tiers, two kinds of executor

A detach means a different thing for each kind of executor, and the code treats them differently:

- **Out of thread: a process on the host.** An `ml.sh` call is a process with its own pid, exit code and output. When
  it detaches, it really runs on while the loop does anything else, and several can run at once. This is the tier
  that is built.
- **In thread: the run's own kernel.** A `python_exec` cell runs on the run's one Pyodide worker, and an `exec` in the
  page's JavaScript. Neither can leave its thread. When this tier is built, a detached cell will mean only that the
  worker stops awaiting it, with the kernel staying busy and locked until the cell returns.

The two compose: an `ml.sh` task belongs to the RUN, not to the cell that started it. A cell can start a long build,
catch `Detached`, keep `e.task` and return; the kernel is free, and the build runs on. Parallel or long Python goes
through `ml.sh` (`python sim.py`), not a background coroutine.

## Why an asyncio task never outlives its cell

A cell may use asyncio freely INSIDE itself: top-level `await`, `asyncio.gather` over several `ml.sh` calls or fetches.
A task it leaves pending does not survive it. After every cell's script, the sandbox's cancel runs as one coroutine
with it (`docs/dev/python-sandbox.md`, "Where the cancel runs"): it spends every pending task under a 1 s budget, cuts
the loop's queue, and revokes what the cell handed to JavaScript, and a task that keeps running refuses the cell's
result. That is the sandbox's guarantee that no Python runs that nobody sees. It is also what keeps the namespace
whole: a coroutine left running would interleave with the next cell at every `await`, on the same variables. And it
would be invisible to the task table below, which is the only thing a model can await, tail or cancel.

## Mode 1 on `ml.sh`

A call that runs past its lease DETACHES into a task instead of holding the step: the script's `await
ml.sh.run(...)` throws `Detached` with `e.task` (a `MlError` with `.task` in a cell), the process runs on, and its
result reaches the model through the run inbox at the next step boundary, or through `task await`.

- **The lease is `expectMs ?? SH_LEASE_MS`** (`sh-call.ts`), measured from `start`, never while a card waits. One
  deadline: a model's own `expectMs` REPLACES the lease rather than adding to it. `SH_LEASE_MS` is 15 s, measured by
  the lease bench (`notebooks/bench/sh-lease.ipynb`, the bench lane's, and #1437's body): no lease moved correctness,
  5 s cost more task turns, 60 s caught no more stalls. A bench cell sets it with the build define `__SH_LEASE_MS__`
  (a positive integer, checked in `build.mjs`); what ships is the default.
- **`shRun` races `runCall` against a timer.** `runCall` is the whole call as before; the timer answers the script and
  registers the task (`detachTask`, `sw-tasks.ts`). `runCall` keeps `withShell` held until `done`, so the port is
  never idle-closed under a detached call and the kill policy stays the host's. The `Detached` text says which case it
  was (the script's estimate, or the default) and the host's time limit (`timeoutMs`, or the host's 120 s).
- **The cap holds an `ml.sh` call's `timeoutMs`.** `shRun` clamps a named `timeoutMs` to the `detachedTaskMaxMin`
  setting (`detachedCapMs`, `sw-tasks.ts`) when the call can detach (`lease` is not false); `SH_LIMITS.timeoutMs` (60 min)
  stays the ceiling parseShRun applies, and a call naming none keeps the host's 120 s. There is no host-sent end message,
  so a detached call's result has no path to a new worker: while it runs, its open native port keeps the worker alive, and
  a worker that crashes loses the port (the host kills the call by its `onOwnerLoss` default), which `hydrateTasks` reports
  as an `orphaned` row (`ref: { kind: "sh" }`).
- **One task table for every executor** (`sw-tasks.ts`, state `run.tasks`), with statuses `running`, `done`, `failed`,
  `cancelled` and `orphaned`. An executor gives `cancel`, `tail` and a `settled` promise. `tail` may answer a promise
  (the host is asked). `ml.sh`'s `tail` calls the host's `peek` when `hello.peek` is true (`docs/dev/shell.md`, "A
  running call's tail"); on a host without it, and over the hub, it is null with a sentence saying why. Two bounds, by who asked:
  the tail nobody asked for (`ml.current.tasks`) shows 500 characters per stream; a `task tail` shows the N lines asked
  (at most 200) up to 8 KiB per stream, and a stream that hit the 8 KiB cut is also stored whole and pointed at.
- **The result goes one way, once.** `taskOutcomeOf` (`sw-shell-call.ts`) cuts each stream's text to exec's output cap, with its pointer. If
  a `task await` is waiting, it gets the result. Otherwise the result is queued
  in `runInboxes` as `{ text, task }` (only `sw-tasks.ts` sets `task`). It is DELIVERED only when the loop drains it
  (`taskDrained`, called from the run host's `drainInbox`): only then is it fanned as `agent-task-say` (worker-only,
  `event-admission.ts`), logged `task`/`collected`, and drawn and exported under the task's id, never as the person's
  words. A result an `await` took between the queue and the drain is dropped from the inbox, so the model never reads
  it twice and the transcript never shows a result the model did not read. A task message has no surface or client,
  and leaves `ml.current.client` the latest person's.
- **A task outlives its turn (rule 4b, slice A).** The run host's `settle` calls `closeTurnTasks`: it drops the turn's
  sink and any await and leaves the tasks running. A result that lands with no turn live stays in the task table,
  undelivered, and is logged `task`/`parked`; no inbox is kept between turns (`runInboxes` means "the turn is live").
  `openTasks`, called at each turn's start after the inbox exists, queues every ended undelivered task of the run in
  the order it ended, with its true elapsed time, and the first step's `drainInbox` reads it through `taskDrained`. A
  result a turn queued but never drained is queued again by the next turn. `endTasks(runId, reason)` is what ends tasks
  now: at session release (`onSessionRelease`, reason `session-release`) and at archive or delete (`sw-sessions.ts`,
  reason `archived`/`deleted`). It cancels each running task through its executor (a cancel that cannot reach it is
  logged `task`/`orphaned`), drops the table and its stored key, so a later result is dropped. Slice B made the table
  durable across a worker eviction and added the cap setting (`detachedTaskMaxMin`, below). Not built yet: a result
  starting a turn, notify-only, the lifetimes list and the no-tab state.
- **The `task` tool** (`task-tool.ts`, a worker builtin offered with `ml.sh` or `python_exec`, not gated, not citable): `await` (with
  its own `timeout_ms`, capped at `TASK_AWAIT_MAX_MS`), `cancel`, `tail`. It is keyed by the loop's run id, so another
  run's id and an invented one read the same `UnknownTask`. `ml.current.tasks` is computed at the snapshot's instant by
  `withTasks`, beside `withPolicies`. Python has no `ml.current` yet.
- **Rendering.** The dev view draws a task's result as a labelled `UserBubble` (speaker `task <id>`); the calm surfaces
  draw `TaskResultLine` (`task-line.tsx`), one quiet line that opens to the exact text the model got.
- **A call that must not detach** (the extension's own read in `sw-library-proposal.ts`) passes `lease: false`.

## Mode 1 on `python_exec`

Only a worker-hosted run's cell is leased (`workerPython` passes the tool's `late` formatter; a page-hosted run, the
bench and a page's `ml.pythonExec` keep the 15 s kill). The pieces, in `sw-python-task.ts`, `py-lease.ts` and the
offscreen document:

- **The lease starts when the cell does.** The cell's `PY_RUN` carries `cell` (the worker's own stream id). On the Python
  worker's `started` the offscreen document posts `PY_STARTED`, and `leaseCell` arms `expect_ms ?? PY_LEASE_MS` (15 s
  placeholder, `__PY_LEASE_MS__`). A cold start and a wait behind another cell are never charged to it. The document
  swaps the 15 s cap for `PY_DETACHED_MAX_MS` (the 60 min ceiling, `__PY_DETACHED_MAX_MS__`) for a leased cell, or for the person's cap when the PY_RUN names one: the
  lease, not the cap, decides when it stops being attached. The lease is clamped to `PY_LEASE_MAX_MS` (a fixed 150 s,
  never more than half a bench build's ceiling) and to half the cap in force, whatever `expect_ms` says: a lease at the
  cap would never detach, because the sandbox kills the cell when the cap ends, and a detached cell keeps as long again
  to run as a task. The `python`/`detached` record carries `{ seq, id, leaseMs, expectMs? }`, as the shell's does.
- **Past the lease the call answers `Detached`**, the tool shape's text (`pyDetachedText`, which states the cap applied) with the output so far, and
  the cell runs on. Its `sendMessage` reply stays pending, which keeps the service worker alive, but not for ever:
  measured in Chrome 151 on a SILENT cell, a reply 345 s after the send reached the same worker in both runs, and one at
  390 s or later reached nobody (the worker was gone; the next message started a new one). A worker with nothing pending
  was evicted at about 65 s. That wall bounded the cell to 5 min before slice B; it no longer does, because the result
  does not depend on the reply (below). The cap is the `detachedTaskMaxMin` setting (1 to 60 min, default 60), sent on
  the cell's `PY_RUN` as `detachedMaxMs`, read at the call, and clamped by the offscreen document to the 60 min ceiling;
  it is honoured only on the worker's own leased cell, as `cell` is.
- **The kernel is locked while a cell is detached.** A second `python_exec` of the run is REFUSED (`pyKernelBusy`), not
  queued: queued behind the worker's chain, its 120 s start bound would kill the worker and the detached cell with it.
- **The result goes through the tool's own formatter** (`format` in `python-tool.ts`): the output cap and the hints, then
  `finish`'s scrub. A whole longer than the text is stored, and its key, length and figure travel with it, so the loop
  mints a `@tool:` pointer with the step's cut line and the figure reaches the model as an image (#1730). `verify` is
  not run late.
- **Cancel is the interrupt first** (`interruptCell`, offscreen.ts): SIGINT into the cell's worker's buffer, and the
  worker killed after `PY_INTERRUPT_KILL_MS` (1 s) if it has not answered. The cancel says which (`pyCancelText`): names
  kept, or the sandbox restarted and the names lost. A cancel that arrives before the cell started is done when it starts,
  since the worker clears the buffer before each cell.
- **Stop reaches an attached cell.** The run's abort interrupts it by the same `interruptCell`. Before this, nothing on
  the Python path read the abort and a runaway cell ran to its 15 s kill. Once detached, neither a Stop nor the
  turn's end touches the cell: the model cancels it with `task cancel`, and `endTasks` does at session release. The
  kernel lock (`detachedCells`) holds into the next turn, whose `python_exec` is refused with `pyKernelBusy`. The turn's
  end (`PY_END_TURN`) arms the idle reap, which never fires on a worker with a running message (`armReap` and
  `reapWorker` both check `pending`).
- **The tail is kept in the offscreen document**, beside the worker: the last `PY_TAIL_RING_CHARS` of the cell's
  output, read by `PY_TAIL`. The service worker keeps no copy. A leased cell always streams to the document. Once
  detached, its chunks no longer reach the step's live output.
- **A result whose worker died is fetched, parked and read once.** The offscreen document keeps each leased cell's
  result (`heldResults`: the last 8, dropped after 10 min, handed over once) and posts `PY_DONE` (cell id, run, outcome,
  size) after every leased cell's reply. The worker that sent the cell ignores it: it is still waiting (`liveCells`) or
  has just settled it (the last 64). A worker that knows neither is a new one, woken by that message: `pythonDone`
  hydrates the run's task table (`hydrateTasks`), and if it holds a running row whose `ref.cell` is this cell, asks
  `PY_RESULT`, formats the answer plainly (`plainPyOutcome`, `sw-python-late.ts`: the tool's own `format` closure is
  gone) and settles the row, which `finish` parks (no inbox is live) and persists. The next turn's `openTasks` queues it
  once; draining it flips `delivered` in the store. With no row, or no result held, it logs `python`/`orphaned` as
  before (a row with no result held is also settled `failed`, so the kernel is not locked for ever).
- **The table is stored** (`ml_tasks:<runId>` in `chrome.storage.session`, `defineState` `run.tasks`): written through
  after a detach, an end, a delivery and a page change's cancel; removed by `endTasks`. `hydrateTasks` rebuilds it when
  memory holds none: a running cell row is attached again by its id (cancel, tail, the kernel lock), one past the ceiling
  plus 60 s and every running `ml.sh` row is `orphaned`, since the host's port closed with the dead worker. `sw-tasks.ts`
  imports `sw-python-task.ts` for the cell rebuild only when a row needs it (the two sit in one import cycle).
- **The messages are the service worker's alone.** `PY_STARTED`, `PY_CANCEL`, `PY_TAIL`, `PY_RESULT` and `PY_DONE` are not in `HANDLE_MAP`, are
  answered only for our own id with no tab, and name a cell by an id only the worker made. A `cell` on a `PY_RUN` is
  honoured only from the worker and only for the wire's own `run:<id>` principal.

## A page change (rule 4a)

Each executor declares where its call runs: `TaskExecutor.pageBound` (`sw-tasks.ts`; `ml.sh` and `python_exec` say `false`, absent
means false). `webNavigation.onCommitted` (`background.ts`) calls `cancelPageTasks(runId)` for every worker-hosted run on the tab,
which cancels the page-bound tasks through their executor, queues `[task <id> cancelled: it ran in the page this run left]` (or
answers a waiting await with it) and records `task`/`cancelled` with reason `page-change`. A cancel the executor does not confirm leaves the task
`orphaned` instead: the line reads `[task <id> orphaned: …, and its cancel was not confirmed]`, a waiting await gets status
`orphaned`, and the record is `task`/`orphaned`. A runtime-bound task is left alone. The
cancelled task's late result is dropped by `finish`'s status guards. No page-bound executor exists yet; the tests use a fake one
(`tests/sh-lease.test.mjs`). `rekeyRunInbox` (`sw-runs.ts`) moves a live run's inbox to another tab (tasks are keyed by run id and
follow); `senderOwnsRun` is the owner check `SET_APPROVAL` uses. The run host's `settle` still closes over the starting tab id.

## Traps

- **A short `expectMs` shortens the lease.** The deadline is `expectMs ?? SH_LEASE_MS`, and models underestimate: on
  the bench every estimate for a 40 s build was 20 to 45 s. The `Detached` text, not the lease, is what carries a
  model through an underestimate.
- **A workspace manifest for a script that runs other programs needs `runs-code`.** Without it the sandbox refuses
  every child (`Permission denied` on stderr) while the call reports `ok: true` and finishes at once, so nothing ever
  detaches. It made the first lease bench invalid (`docs/spec/SHELL.md`).
- **An `ml.sh` task's `tail` is null only where the host cannot `peek`** (no `hello.peek`: an older host, or the hub),
  said in the tool's answer, never a fake empty string.
