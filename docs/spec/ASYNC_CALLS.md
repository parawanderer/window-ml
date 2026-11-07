# Async calls: the three ways a run stops waiting

**Status: concept document, nothing of it built (2026-10-29, from Shane's 2026-09-18 framing in
`tmp/chats/gemini_async_discussion.md` and the memories that held it since; promoted to a spec on Shane's word
2026-10-29; UNASSIGNED).** This is the one place the design lives. The memories, the open-topics map and the specs
that touch a piece of it point here, and a build of any mode starts from this file.

The problem is the one every agent harness has: a tool call blocks the loop until it returns, and when a call takes
forty minutes nobody expected, the model sits for forty minutes uninformed. Shane hit it in Claude Code more than
once: a script that should take thirteen minutes, a harness that waits over an hour, and the only remedy a person
noticing and typing "it has been thirty minutes" into the session, after which the model acts sensibly at once. In
window.ml the JavaScript never hangs (every call is awaited async JS) but the AGENT LOOP does, and the compute is
wasted. That is the missing primitive.

## Why it is three things, not one

What reads as "make tools async" is three concurrency modes with different state transitions. Serving all three with
one wrapper is why harnesses get messy, and is why this was not built the day it was raised.

| Mode | What it is | The model's intent | The shape of the result |
| --- | --- | --- | --- |
| 1. **Escalation lease** | sync by default; on overrun the call DETACHES (never dies) and the loop gets a handle | "give me the value" | the value, or `{ detached, id, elapsed, tail }` |
| 2. **Push subscription** | an observer registered with a cardinality and a TTL; the run continues; matches arrive at TURN BOUNDARIES | "tell me if this happens (once, N times, forever)" | a subscription id now; events later |
| 3. **Explicit fork-join** | the model says up front it will not wait: `background: true` → a handle, later `join([…])` | "start this, I have other work" | a handle at once |

A compute task PROGRESSES toward completion; an observer SITS IDLE waiting for an external transition. Treat the
second as a background task and the model has to poll, burning a turn per empty check, which is the token tax mode 2
exists to avoid. Mode 3 is mode 1 with the lease set to zero, so it is last and cheapest.

**Async by default was considered and rejected.** If most calls finish in about 200 ms, returning a handle turns
every one-turn operation into two (`call` → id, then `poll` → result): double the round trips and a fragmented
working context, a tax on the common case to serve the rare one. Mode 1 exists so the common case costs nothing and
only the overrun pays.

## What exists today, which each mode reuses

Nothing of the three modes is built, but most of their machinery is, which is what makes them assembly rather than a
subsystem. Do not build a second copy of any of these.

- **A tool call is one awaited round trip.** The loop (`agent-loop.ts`) calls the tool and waits; a DOM tool goes
  worker → tab through `delegateSend`, which already has a THIRD outcome beside answer and reject (a sleeping tab
  that does neither) and a generous cap for a frozen tab (`docs/dev/agent-tools.md`). The loop's own `AbortSignal` is
  checked at step boundaries, before the model call and before a tool runs, and resolves the run `{ cancelled }`
  (`docs/dev/architecture.md`, "Tools and cancellation"); a streaming fetch is cancelled by its Port, a plain one by
  `ABORT_TASK`. So "cancel the run" exists; "cancel one call and keep the run" does not.
- **The one delivery path into a running loop is the run inbox.** `a.say()` steers a run mid-flight by queueing text
  that is injected at the next step boundary: `runInboxes` in `sw-runs.ts` for a worker-hosted run, the page loop's
  `control.inbox` for a page-hosted one, `INJECT_MESSAGE` the wire between them, and the sender check is the run's
  own tab. A detached result, a subscription's event and a watchdog's wake are all this mailbox with a different
  payload. The turn boundary is the only place anything is injected, never into a live generation.
- **`ml.sh` already detaches.** A long shell call "detaches with a cancel handle" (`SHELL.md`, "One call"), the host
  protocol knows `start`, `done`, `cancel` and `status`, a call has a deadline, and an orphan a policy chooses to keep
  is parked on an ORPHAN list the status reports rather than killed. That is mode 1's lifecycle for one executor,
  built before the frame was written, and the shape to generalise from.
- **`python_exec` has the other half: a bounded cancel and a lifetime rule.** A cell's cancel runs in the harness
  inside the worker with a 1 s spend budget, a cut of the loop's queue and a revoke of what the cell handed to
  JavaScript (`docs/dev/python-sandbox.md`, "Where the cancel runs"), and the sandbox itself can be killed by
  terminating the worker. The idle reap and the keep define what a worker-hosted run's state outlives: a keep "never
  outlives its turn" and "ends with its sandbox: a kill (a timeout, a crash, a cancel) clears it and the next cell is
  told the loss", armed only by the service worker for a live turn (`turnLive`, `endedRuns`). A detached cell is a
  live turn's work and takes the same rule.
- **A predicate over run state already runs in the read-only dialect.** Watches (`state-watch.ts`, the Run state
  panel, `STATE_INSPECTOR.md` "Watches") and the watches a person shares with a worker-hosted run
  (`sw-shared-watches.ts`) evaluate an expression over `ml.current` with halting and no effects. Mode 2's predicate
  and the delivery policy over the inbox are that evaluator, not a new one.
- **A budget the model can extend exists** (`step-budget.ts`: a run that hits its step cap offers Continue (+N)),
  and a run is already a handle with `run`, `continue` and `cancel` (`ml.createAgent`). A detached call's handle and
  a spawned subtask's handle are the same shape, which `HEADLESS_AGENTS.md` should use rather than invent.

## Two kinds of executor, and what "detach" can mean for each

(Added 2026-10-29 from an outside review Shane had made of this file.) The Jupyter line applies here exactly, and the
first draft blurred it. In a kernel, `a = run_mcmc()` blocks the one execution thread for as long as it runs, while
`subprocess.Popen(["python", "sim.py"])` hands the kernel a pid and a descriptor and the process runs on its own.
The harness has both kinds, and "detach" is a different thing for each:

- **Out of thread: real background compute.** An `ml.sh` call is a process on the host with its own pid, exit code
  and output redirection; a fetch is the browser's. These run on while the loop does anything else, can be polled,
  tailed and cancelled, and are what a detached call MEANS in full. Parallel work is several of these.
- **In thread: the harness's own kernel.** A `python_exec` cell runs in a single-threaded Pyodide worker; a cell in a
  tight numeric loop blocks that worker's event loop, and so does `exec`'s main-world eval in the page. Neither can
  be lease-detached from its thread without killing it. (Narrowed 2026-11-07, measured: a Python cell CAN be interrupted in its thread by `KeyboardInterrupt` through the interrupt buffer, the namespace kept, and an `exec` through the debugger by `Runtime.terminateExecution`, the page kept; the kill is the fallback for a call inside C and for the userScripts world; rule 3 below.) Detaching one means only that the service worker STOPS
  AWAITING it: the loop is free for shell, DOM and text work, and the kernel is BUSY AND LOCKED until the cell
  returns or its sandbox is killed. A further `python_exec` of that run queues behind the detached cell or is told
  "busy with <id>", never runs beside it; nothing can read a half-mutated namespace, so there is no race to warn
  about, only a lock to state. There is no second worker per run, by the reset-ownership ruling that the worker
  boundary is the run boundary (`docs/dev/python-sandbox.md`), and no fork in Pyodide: a model that wants parallel
  Python launches scripts through `ml.sh`.
- **Interrupting an in-thread call is a kill, and the spec says so.** (RETITLED in substance 2026-11-07: the kill is the FALLBACK, the interrupt comes first; rule 3.) The sandbox's bounded 1 s cancel is the asyncio
  tail that runs after a cell's script as one coroutine with it ("Where the cancel runs"); it never reaches a
  running synchronous frame. The only cancel for a detached tight loop is terminating the worker, which loses the
  run's namespace and tells the next cell the loss, as the keep's rule already states. `exec` has not even that:
  the page's JavaScript runs to its end. The result of `cancel(id)` names which happened.

## Mode 1: the escalation lease

The call is dispatched synchronously with a lease. Inside the lease the value drops into the turn as today, zero
friction. Past it the runtime DETACHES the call without killing it, the tool call resolves now with
`{ status: "detached", id, elapsed_ms, tail }` (the output so far, capped like any tool output), and the loop goes on.
In its next step the model may wait on it with a higher ceiling (`await(id, { timeout })`), cancel it (`cancel(id)`),
or do other work and collect it later; when the call finishes on its own, its result enters the run through the
inbox at the next turn boundary, as a steer does, labelled with the id.

1. **The lease is per tool and short, with an argument override.** A DOM read and a build have different natural
   scales; a long GLOBAL default is the silent hang by a longer road. The model may state its own expectation on the
   call (`expect_ms`); it is never required to. The DEFAULT'S VALUE IS A BENCH QUESTION, not a judgement: too short
   and every wait spends a turn, too long and it is the hang again, so it is a matrix over `runOnce` with spread
   across seeds (arms: the default; measures: wake turns spent, stalls undetected, and whether the model supplies its
   own estimate more often after being woken). Ship a short placeholder and say in the code that it is one.
2. **A missed expectation WAKES the model and cancels nothing.** The wake is an inbox message that says which case it
   was, because they call for different behaviour: predicted ("you said ~13 min; it has been 13 min; investigate the
   stall") or defaulted ("you gave no estimate, a 60 s default applied; the call is still live; estimate or
   investigate"). The watchdog's diagnostic value is that the number was the MODEL'S prediction, so a miss is
   evidence its model of the world is wrong; a harness-supplied number is only a timer, and the two messages must
   never be merged. The still-live call can resolve later and arrive normally.
3. **Cancel is honest per executor.** `python_exec`: the sandbox kill for a running frame (the bounded cancel is the
   asyncio tail, above), after which the keep is gone and the next cell is told the loss, as the reap already says. CORRECTED 2026-11-07 (Shane's ask, measured by the async lane, `20261107-1321Z-async-to-repl-specs-interrupt-measurements.md`): `python_exec`'s cancel is `KeyboardInterrupt` through Pyodide's interrupt buffer FIRST (`setInterruptBuffer` over a `SharedArrayBuffer`; measured about 3 ms on a pure-Python loop in the restricted core, Node and the extension's offscreen document alike), and the sandbox kill only when the interrupt has not landed within a bound (a call inside C does not check the buffer until it returns): the bound is a constant beside `SH_LEASE_MS`, placeholder 1 s, under the same bench rule. The namespace survives an interrupt and is lost only to the kill, and the result says which happened. The buffer is CLEARED before every cell, with its own test: an interrupt written while C code runs stays pending and would fire on the next cell's first bytecode. The sandbox kill, the keep gone and the next cell told the loss, is now the fallback, not the cancel. `ml.sh`: the host's `cancel`, or its
   deadline kill. A fetch: its abort. `exec`'s main-world eval CANNOT be interrupted once running; cancel there only
   stops awaiting it, and the result says so rather than implying the JavaScript stopped. CORRECTED the same day: an `exec` that ran through the debugger (an isolated world, or a CDP main-world eval) IS interruptible by `Runtime.terminateExecution`, measured: the script stops about 100 ms later, the page's state survives including the writes made before the loop, timers resume and the context still evaluates; the pending evaluate rejects with a bare "Internal error" when the script had not yet awaited, and NEVER settles once it had (the exec wrapper's common case), so the cancel settles on its own deadline, never on the evaluate, and reports "terminated" from having sent the command plus a fresh evaluate answering. "Cannot interrupt, no longer awaited" stays only for the userScripts main world, which has no debugger. A cancel's effect is a
   fact in the result, never a promise.
4. **A detached call never outlives its run.** The run's end (an answer, the step cap, Stop, a navigation that kills a
   page-hosted loop) cancels every detached call of that run by its executor's cancel, and what cannot be cancelled is
   reported as an orphan, the way the shell's status already reports its orphan list. A detached cell holds its
   worker as a running message does (the reap's "idle" is no message running or queued), so no clock reaps it, and
   it ends with the turn exactly as a keep does; while it runs the kernel is locked, as above. For `ml.sh` the
   sweeper EXISTS: a call's default policy kills its process group, a `kill`-policy call is killed when the native
   port closes, which is what a service-worker eviction or a crashed tab does to it, an entry swept after the host
   itself died is reported `host-lost`, and a policy that chooses otherwise parks the process on the ORPHAN list the
   status reports (`SHELL.md`, the kill policy and its orphan list). That is the dead-man's switch; this file adds
   the loop-side reporting, not a second one.
5. **The handle is the run's.** It is answered only for the run that made it, from that run's own tab or the service
   worker, with the sender checks the inbox already has; a page cannot await, cancel or read another run's call. A
   detached call, its wake and its collection are records in the run log (`python`/`detached`, `shell`/`detached`,
   with the id), so the person sees what ran past its lease and what was cancelled.
6. **A detached result crosses the same checks as a tool result:** output cap, scrub (`sw-scrub.ts`), and the
   `@tool:` pointer rules for a large value. Nothing reaches the model through the inbox that could not have reached
   it as the call's return. The output of a call that runs for hours is BOUNDED AT THE EXECUTOR, not only at the
   return: the host already caps a shell call's output, and a detached cell's stdout is a fixed-size ring buffer in
   the worker (the last N KB), never an unbounded array. The inbox carries status and tail only; the model inspects
   more with `tail(id, { lines })` on the handle, and the full capped output is a value it can point at, as a tool's
   large result is today.

## Mode 2: the push subscription

`subscribe({ on, times, ttl })` registers an observer and returns at once with an id. `on` is a predicate in the
read-only dialect over a source (a DOM event on a selector, a network response once network inspection exists, a
detached call's completion, a value changing in `ml.current`, a file appearing or changing on the host through `ml.sh`, a host process's exit,
mail arriving per `AGENT_MAIL.md`); `times` is the
CARDINALITY (`1`, `n`, or unbounded); `ttl` ends it. A match is queued in the run inbox and injected at the next turn
boundary as `[event <id>: <payload>]`; the subscription is dropped at its count or its TTL, and the model is told
which.

7. **Delivery is a separate, MODEL-OWNED policy over the inbox,** changeable mid-run (Shane, 2026-10-08): mute a
   source, let it collect without a wake, pull on demand, push, push after N have collected, or any read-only
   dialect expression. Pull and push are two settings of one mechanism. The policy is state (`defineState`),
   visible and overridable by the person in the Run state panel; a muted inbox has a size cap and an "N dropped"
   count. "Pull" is a read of the inbox as a `TableLike` through the read-only facade, which needs no approval.
8. **Muting never silences an overrun.** Whatever the policy, rule 2's wake for a detached call is deferred or batched
   at most, never removed: a call that could go silent forever is the failure this file exists to end.
9. **A subscription is not a blocking wait.** The old `waitForEvent` idea (pause the loop until a DOM event fires) is
   mode 1 with the event as the call: it gets a lease, a wake on miss, and detaches like any other. Mode 2 is for a
   run that has other things to do meanwhile.

## Mode 3: explicit fork-join

`background: true` on any call that supports a lease returns the handle at once: mode 1 with the lease at zero.
`join([ids], { timeout })` is `await` over several, itself leased, so a join that overruns detaches and wakes like
any call. No new state, no new delivery path, and never the default (the token tax above).

## The state machine

```
tool call
  ├─ background: true ───────────────────────────► handle now                 (mode 3)
  └─ synchronous, under a lease
       ├─ returns inside the lease ───────────────► value in this turn         (today)
       └─ overruns ──────────────────────────────► detached: handle + tail     (mode 1)
             ├─ await(id, ceiling) ──────────────► value, or detached again
             ├─ cancel(id) ──────────────────────► cancelled, or "cannot interrupt, no longer awaited" (interrupt first; the kill or "no longer awaited" only where rule 3 says)
             ├─ finishes on its own ─────────────► result through the run inbox at a turn boundary
             ├─ misses the expectation ──────────► a labelled wake through the inbox; the call lives on
             └─ the run ends ────────────────────► cancelled by its executor, or reported as an orphan

subscribe(on, times, ttl) ───────────────────────► id now; matches through the inbox         (mode 2)
   the inbox's delivery policy (model-owned, person-overridable) decides when a wake is injected,
   except an overrun wake, which it may only defer
```

### Rulings on the async lane's mode 1 design note (coordinator, 2026-11-07)

The lane's note (session-mail `20261107-1204Z-async-to-repl-specs-mode1-design.md`) is accepted with these rulings,
each of which amends the text above where it says otherwise:

- **`ml.sh` is a member, not a tool, so its lease sits on the call** (`shRun`'s await of `done`), and on overrun the
  member THROWS a `Detached` error carrying `{ id, elapsed_ms, lease_ms, expect_ms, tail }` in exec and as the same
  exception on the Python wire. Mode 1's "the tool call resolves with `{ status: "detached" }`" is the shape for a
  TOOL (python_exec, exec, a fetch); a member resolving with a value would hand a script `r.stdout === undefined`
  with no error, the plausible-wrong-answer shape this codebase designs out.
- **One deadline, one wake.** `expect_ms ?? SH_LEASE_MS` is the lease; the detach at that deadline IS rule 2's wake,
  carrying one of its two phrasings. After the detach no clock runs unless the model sets one (`task await
  timeout_ms`, itself leased, detaching again when it runs out). The finished result's inbox return is the other
  wake. No second wake at a multiple of the expectation.
- **One builtin tool, `task({ op, id, ... })`** with `await`, `cancel`, `tail`, and later `join` with `ids`, declared
  in the tool registry, dispatched in the worker with the run id from the loop, never from its arguments; a foreign
  or unknown id reads `UnknownTask`, indistinguishably.
- **One task table for every executor** (`sw-tasks.ts`, `defineState` `run.tasks`, scope run, lost on worker
  eviction and turn end), holding the executors' callbacks and never the script's word. Statuses: `running`,
  `done`, `failed`, `cancelled`, `orphaned` (`expired` joins with mode 2's subscriptions); a row exists only once a
  call has detached or was started in the background, so `detached` is not a status.
- **The inbox item is `{ text, origin: "task" }`**, injected as a user-role message at the step boundary as a steer
  is, kept apart from a person's steer by its origin in the transcript and both exports (the export rule: what the
  model saw, labelled). Only `sw-tasks.ts` sets that origin; a steer cannot claim it.
- **The run's end is the turn's end** (`settle`), as rule 4 says and as the keep does: a model that answers while a
  build is detached ends the build, and the `Detached` text says so in one line. A session continue does not keep a
  task.
- **`ml.current.tasks` is computed at the snapshot's instant** (`withTasks` beside `withPolicies`, at both assembly
  sites), `elapsed_ms` from the snapshot's clock, the tail read through the row's bounded, scrubbed `tail()`; no row
  is kept live. RE-RULED the same hour on the lane's correction: a Python cell has no `ml.current` today (the
  Python facade exposes the server's wire members only; every `withPolicies`/`withRuntime` site is the exec isolated
  world or the dialect survey), so `ml.current.tasks` ships for JavaScript in the first PR; Python's parity there is
  the `Detached` exception on `sh.run` (an `MlError` carrying the task id), the same inbox return and the same `task`
  tool, which is the loop's and does not care which world started the call. "`ml.current` in Python" is an OPEN item
  below, its own piece of work.
- **Live `tail` on `ml.sh` has nothing to read today** (the host reports output only with `done`): the row's `tail`
  is null with the sentence saying so, never a fake empty string, until a host `peek` op exists. The host op is a
  window-ml-host PR; no lane owns that repo today, so WHO WRITES IT IS A CALL FOR SHANE (recommended: the async
  lane, as a second slice after mode 1 merges, since it knows the shape it needs). DECIDED 2026-11-07 (Shane): the async lane writes it as its second slice after mode 1 merges: `peek { id, stream, offset, length }` reads the growing held file before `done`, with `read`'s 512 KiB range cap and `{ "$bytes" }` form, a paragraph in the host's `PROTOCOL.md` and a test in the host repo, from the lane's own clone of window-ml-host; the window-ml PR that consumes it names the host version it needs; the shape comes to the coordinator as a short note before the host PR, since it is a protocol change.
- **The host's 2-minute default stays the script's business**: the worker sends no `timeoutMs` the script did not
  give; the `Detached` text names the limit the call runs under.
- **Page-hosted runs do not arise for `ml.sh`** (it runs only in a worker-built run's isolated world); the
  navigation question is deferred to the exec executor, recorded here.
- **An extension-internal shell call never detaches**: `lease: false` on `ShCallContext`, settable only by worker
  code (`sw-library-proposal.ts`'s read), out of any script's reach.
- **`SH_LEASE_MS` is 15 s in `sh-call.ts`**, `// state: fixed`, marked a placeholder; the bench (arms 5, 15, 60 s over
  a fake host whose sleep outlasts the lease) runs before the PR leaves draft and its numbers go in the PR.
- **No UI in the first PR** beyond the run log and the state panel's registry view; the chip is a later PR agreed
  with the chat-page lane first. RULED 2026-11-07 (the chat-page lane, on the async lane's question, upheld by the coordinator): a task result in the transcript is a NEW EVENT KIND on the agent-site-say precedent, rendered in the async lane's PR under the chat-page lane's review, so no merged state ever draws a task result as the person's bubble; this is the transcript side of the `task` origin above. BUILT 2026-11-07 (the async lane): mode 1 on `ml.sh` is PR #1437, branch `async/mode1-shell-lease`, head 461b5821 (verified open as a DRAFT, labels @agent @exec @security @docs @python @ui, no review yet); it stays a draft only for the `SH_LEASE_MS` bench, whose matrix and cost the lane sends before any real-model run (a bench result changes one constant and the body). The event kind is named `agent-task-say`, worker-only, drawn in this PR (reducer, bubble, prompt pin, HUD label, both exports) under the chat-page lane's review, the body naming who built which part. Two facts the lane named: `sw-scrub.ts`'s import-time `chrome.storage` listener is now guarded with `typeof chrome`, because importing `sw-tasks.ts` pulled it into eleven worker tests that load without `chrome`; deferred and named in the body are the one-line task count in the prompt ("the prompt pays one line" above) and the panel check of the Detached wording. flaky-ci reviews the code; e3 red-teams the surface (routed 2026-11-07; the lane's eight rows are its list). UNDER MEASUREMENT 2026-11-07 (Shane's ask, confirmed in the coordinator's session: an interrupt that keeps the namespace is part of what the tool is for to him): whether the kill is really the only interrupt of a running cell. Pyodide's `setInterruptBuffer` raises `KeyboardInterrupt` in the running frame between bytecodes (Jupyter's "Interrupt kernel"; the namespace survives, a call inside C waits for its return), which needs a `SharedArrayBuffer` and so a cross-origin-isolated offscreen document; and an exec run through CDP can be stopped by `Runtime.terminateExecution` with the page's state kept. Three measurements, nothing merged: the restricted core keeps the interrupt check (Node first); what cross-origin isolation of the offscreen document breaks (pdf.js, the archive worker); what `terminateExecution` returns and whether window state survives. If they hold, the python_exec slice's cancel becomes KeyboardInterrupt first and the kill only when it does not land within N ms, and exec's becomes terminate when it ran through CDP; the correction lands here as a spec PR from the lane's note, before the python_exec design note. e3's red-team pass on #1437 STARTED 2026-11-07 against 461b5821: node:test rows with mocks for `ml.current.tasks` and the exec-side `Detached` handle, e2e rows for a page's reach of the task tool and the presence invariant; its test-only PR lands after #1437 merges (the surface is not on main), its flips as its own commit on the lane's branch before that merge. DONE the same day against 461b5821 (verified against origin): e3's `redteam-task.test.mjs`, nine rows, plus the `redteam` genre line in `scripts/test.mjs`, on branch `redteam/task-mode1` at e3b03803 (verified), HELD until #1437 merges; nothing gating. Each row names the one-line mutant it reds against (cross-run lookup, both late-result guards, `forModel` at finish and in `withTasks`, `agent-task-say` out of `WORKER_ONLY_KINDS`, the waiter guard); the dialect row (a script's write never reaching the table) holds by construction, so no single mutant. No e2e spec, with the reason recorded: mode 1 adds no page-started type and no page-visible field, and the presence invariant is pinned in the file by the page-realm `ml.current` refusal and `pageMayWrite("agent-task-say", …)`. Two notes to the lane, not defects: the late-result row reds only when BOTH guards go (status and identity), so neither is dead; and the write sentence above. e3 re-runs on the bench head and names it in its PR body. #1437 HEAD 2f0f1825 (2026-11-07, verified: two commits on 461b5821 for the chat-page lane's review; a task's result is drawn when the model reads it, not when queued, as one quiet line on the calm and focus surfaces, no Edit on a task bubble, task results out of the prompt pin); still a draft for the bench; flaky-ci reviews 2f0f1825 and names it. The lane accepted the `ml.current.tasks` write ruling above. INTERRUPT, FIRST RESULT (the lane, 2026-11-07): `setInterruptBuffer` works in the restricted core in Node and inside an offscreen document on Chromium 151 WITHOUT cross-origin isolation; `KeyboardInterrupt` lands about 3 ms after the flag and the namespace survives; the note with the COOP/COEP comparison follows. REQUESTED (relayed by the async lane as Shane's ask in its session; CONFIRMED by Shane in the coordinator's session the same day, the shape approved): the Python bench's Run button becomes Stop while `benchRunning`, on every surface that shows the one `PythonBench` component, by this interrupt: the worker calls `setInterruptBuffer` per Pyodide instance and clears the flag before every run (a stop written during C code stays pending and would hit the next script), the offscreen document holds each worker's `SharedArrayBuffer`, and a new message type (extension pages only, refused from content scripts) writes the flag and falls back to today's worker kill if the run has not ended within about a second. The same machinery python_exec's cancel will need. RULED: its own PR after #1437, under a short design note first; `src/python` and the offscreen Python host are free (no lane owns them; the last owner was the dialect round's lane 1, closed; #1274 merged at e5f37cd1); e3's row for the new message type; the sidebar part cleared with the chat-page lane. MEASURED the same day (the lane's note): `SharedArrayBuffer` exists on `chrome-extension://` pages and their offscreen documents WITHOUT COOP/COEP, an extension-page property and not a Chromium 151 change (a plain web page and about:blank in the same browser have none until isolated), so no manifest change is needed, the e2e harness sees what the extension sees, and the web build, which runs no Python, would not; under the manifest keys the interrupt also works and the six offscreen-hosted e2e specs pass identically (17 passed, 2 skipped each way). NAMED RISK: SAB on non-isolated extension pages is Chrome's policy, not a standard; the fallback is the manifest keys. BENCH STOP DESIGN NOTE (`20261107-1330Z-async-to-repl-specs-bench-stop-design.md` with its addendum) RULED 2026-11-07, the lane's recommendations taken: `BENCH_STOP_KILL_MS` 1 s stays a stated placeholder under the bench rule (a Python loop stops in 3 ms, a C call may run minutes; measured only if a real script shows a shape between); `PYTHON_INTERRUPT` carries NO id and the offscreen document interrupts only the bench principal's worker, so no message can name another run's namespace, and with no bench run in flight (none, or only a model's cell in either worker) it answers `{ running: false }`, writes nothing and kills nothing; a model's `python_exec` cell is NOT reachable by it, that being the executor slice with its own note on the same buffer; both workers get the buffer in one code path, the flag host-side so nothing new is reachable from a cell in either mode; the python-sandbox.md paragraph states the Chrome-policy risk; the two result wordings ("Stopped", and the kill naming that the variables are gone) are fixed strings in one place for the executor slice to reuse; the existing `IconStop`; Reset unchanged and now working after a Stop, no Restart button (Shane's call, confirmed). Built after #1437 merges, flaky-ci reviewing, e3's rows (no page sender reaches `PYTHON_INTERRUPT`; a model run's worker is never its target; a cell cannot reach or clear the flag), labels @python @ui @security. LEASE BENCH PLAN (the lane, 2026-11-07, put to Shane with the coordinator's recommendation; nothing runs before his yes): PREREQUISITE, the e2e harness cannot run `ml.sh` today (nothing enables the shell or installs the host): wmlhost built from window-ml-host main ae7284e, its native-messaging manifest in the Playwright test profile only, `shellEnabled` plus a temp workspace root, skipping when wmlhost is absent, as its own PR off #1437 (`@ci @exec`, flaky-ci reviewing); MATRIX `sh-lease.bench.ts`, lease 5/15/60 s × three tasks (a 40 s build printing progress, a hang, a 2 s call) × 5 repeats, measuring wake turns, whether the model passes `expectMs` before and after its first `Detached`, whether a stall is investigated or cancelled, token cost; two local models on mlbox through OpenWebUI, 90 runs, 2 to 4 GPU hours; cloud models only if the local spread cannot choose; the panel check of the `Detached` wording rides on the same runs. MOVED 2026-11-07 (Shane's proposal, relayed by the async lane and CONFIRMED by Shane in the coordinator's session the same day, with his YES to the local-model matrix: nobody is using the mlbox models now; cloud still only on his word): the bench is the BENCH LANE's (`[window-ml bench]`, brief `20261107-1345Z-repl-specs-to-bench-sh-lease-brief.md`); the async lane keeps the harness PR (`ci/e2e-native-host` off main, `@ci @exec`: the harness module `native-host.mjs` finds a built wmlhost by `E2E_WMLHOST` or a sibling `window-ml-host*/target/release`, writes its native-messaging manifest into the TEST PROFILE only after launch, since Chromium 151 on macOS reads `<user-data-dir>/NativeMessagingHosts` at `connectNative` time, a fresh temp workspace, one real `ml.sh` spec that skips without the binary; wmlhost 0.7.0 answered hello from the test profile). SAFETY RULE IN EFFECT for the bench (Shane's, through the async lane): `ml.sh` there runs on the laptop as Shane's uid under Seatbelt, so every `ml.sh` ASK is auto-DENIED, only the free tier inside the temp workspace runs, a refused read is data; the deny lives in the approver with a test row. BENCH DESIGN NOTE (`20261107-1330Z-bench-to-repl-specs-sh-lease-design.md`) RULED the same day, its recommendations taken: Q1 #1437 gains `__SH_LEASE_MS__` as a build define on the `__EXEC_DEFAULT_WORLD__` precedent (three lines plus build.mjs's positive-integer check, the async lane's commit; the shipped build unchanged; the bench varies it through `CellEffects.defines`); Q2 the bench runs from a local integration branch of main + the harness head + #1437's head, all three SHAs in the notebook, one head per sweep, its spec PR against main after both merge; Q3 a task script runs free only through a workspace-scoped manifest seeded per script by `MANIFESTS add` from an extension page in the test profile, host-pinned, the run asserting the reason is policy or builtin and never person; Q4 the approver approves only the outer `exec` gate and denies every nested ask, every other gated tool and `python_exec` in every mode (CORRECTED by the lane: UI-started runs carry the person's kit, `UserRunRequest` takes no tool subset, so the approver alone is the defence and "denied non-exec gates" is its own measure outside wake turns; no test-only `tools` field on the product), with a canary row that asks for `~/.ssh/config` and asserts the gate log's deny, no `askId` approval, the consent `ask` in the run log and an answer without the file's first line, the comparison value computed in-process and never written anywhere. Two facts recorded: the build arm cannot measure whether progress output helps until the host's `peek` (live tail is null); the hang dies at the host's 120 s default, so "stall noticed" means cancelled or named before that kill, and the hang cells are 30 of 90 runs at about 3 minutes, so 3 to 5 GPU hours. DOCKER ADDENDUM (Shane's suggestion, relayed by two lanes; put to him with a yes recommended; APPROVED by Shane in the coordinator's session the same day, image build and pilot to proceed): the whole harness in one linux/arm64 container (Chromium, Node, `dist/`, a Linux build of wmlhost) with bwrap able to make user namespaces, then ONE pilot cell on the fake LLM (no GPU, no mlbox) whose four checks are the acceptance list (native messaging from the per-profile directory on Linux, bwrap applies, a seeded manifest runs free, the canary is denied), any failure coming back as a note first; the gain is that the bench's reads cover a container's filesystem, not Shane's home, the deny rule still on top; parity is not the reason; the Linux sandbox is bwrap not Seatbelt, so the canary runs on both placements and the lease is reported from one named platform; unverified until the pilot: Linux per-profile native messaging and the tailnet route out of Docker Desktop. DEFECT ON MAIN found by the harness's first real-host e2e (2026-11-07), independent of #1437: with `autoApproveReadonly` on (the default), a worker-built run's exec whose script names `ml.sh` is tried as a read-only survey, the worker refuses it (`ml.sh` is not in its `ml`), and `pageLegOk` in `sw-run-host.ts`'s `tryReadonly` then lets the survey go on to the PAGE realm, which evaluates it and answers `TypeError: Cannot read properties of undefined (reading 'run')`; run log `routing readonly-page reads-page`; the call never reaches the isolated world or a person, so every `ml.sh` call from exec fails in the default config, and a script naming `ml.sh` is evaluated in the page's realm, which the routing invariant forbids; `pageLegOk` excludes only the isolated DEFAULT world, not the forced reasons (`sh`, and so `pointer` and `current` too). With the flag off the same script runs on the real host. RULED: the async lane fixes it as its own PR on main before the harness PR (`@exec @security @agent`, flaky-ci reviewing): a script the routing forces isolated for ANY reason other than `default` gets no page leg (the set complement, never a list naming `sh`), a unit row enumerating every reason the routing module exports, the e2e shape under the default config, the run log reading an isolated routing; e3's row (no page-realm evaluation of a script naming `ml.sh`, a pointer or `ml.current` under the default config) in its own file, the flip as e3's commit on the lane's branch before the merge. The harness PR then runs with the default config and never turns the flag off. REFINED the same hour on the lane's question: `ExecReason` also holds `unapproved-page`, a PAGE-derived reason, and a user-started run's read-only survey on an unapproved page is allowed by the site-access invariant, so "any reason other than default" over-reached. The page leg is decided on the SCRIPT alone (`routeExec` with `approvedPage` true, isolation available, no world): a page leg only when the reason is `plain`; `sh`, `current`, `pointer` and any future script-named reason lose it automatically; the world-`page` request and the isolated-by-default exclusion stay. `EXEC_REASONS` is exported as a runtime list with the type derived from it, and the unit row classifies every reason as no-page-leg or page-derived, so a new reason must be placed or the row fails; the classification sentence goes in site-access.md beside the routing table; e3's row matches. e3's PAGE-LEG PASS written 2026-11-07 against main 7e937260, measured not guessed: e3's `redteam-exec-page-leg.test.mjs` plus the genre line, branch `redteam/exec-page-leg` d17b4ee3 (verified, two files), no PR; it goes onto the lane's fix branch as e3's commit when the PR exists, the two todo rows flipped there once the fix and `EXEC_REASONS` land. Rows: `sh` script, the page leg RUNS (`readonly-page / refused-in-page` then `exec-refused / sh`, a `readonlyTry` sent to the page with the script in its args; the defect; todo); pointer and `ml.current` scripts, the worker answers (`readonly-worker / no-page-reads`, no `readonlyTry`; hold today, guarded); plain, the leg runs (control); unapproved page with a plain script, the leg KEEPS running (`exec-refused / unapproved-page`), the row asserting the leg is PRESENT, pinning that the fix does not take it away. The classification row enumerates `EXEC_REASONS` against a duty table (page / never / call / setting / site) and `execNames`' keys against the reasons, so a new reason or a fourth script-named mechanism fails until placed. Fix-shape fact from e3, passed to the lane: today the page leg is computed only inside the block guarded by `defaultExecWorld(...) === "isolated"`, so under the default config `execRoute` is never consulted and `pageLegOk` is true for every script; deciding on the script alone means routing unconditionally (`routeExec(js, true, undefined)`) and keeping the leg only for `plain`. janitor-2 reviews the fix PR. PILOT RESULT (the bench lane, 2026-11-07, `20261107-1339Z-bench-to-repl-specs-sh-lease-pilot.md`): two of four checks pass in the container: Linux native messaging PASS, canary denied PASS (nothing of the file reached the model); bwrap FAIL (`bwrap: Can't mount proc on /newroot/proc: Operation not permitted`, so calls run host-plain), the seeded-manifest check not judgeable since it depends on the sandbox. The lane's guess: Docker's masked /proc; its proposed next try `--security-opt systempaths=unconfined`; the fallback the laptop under Seatbelt with the deny rule. The next try is SHANE'S DECISION (the coordinator's session could not send it).
- **The red team's rows** are the eight in the note (another run's or a guessed id; a result after settle; a task
  outliving the run; URL, key or filter in a tail or result; a forged `Detached` or `task` origin; writes to or
  foreign rows in `ml.current.tasks`; nothing new reaches an unapproved page; the detach never skips the judgement
  or the ask), written by e3 in its own file as a PR after the lane's.

## `ml.current.tasks`: the model's own view of its async work (Shane, 2026-11-07)

The model gets its async work the way it gets everything else about its run: as a member of `ml.current`, read from
the dialect, never from a tool that dumps (`CURRENT_CONTEXT.md`, rules 1 and 5). `ml.current.tasks` is one
`TableLike`, resolved up front with the rest of the facade, one row per detached call, subscription and join of THIS
run: `id`, `kind` (`call`, `subscription`, `join`), `tool`, `status` (`running`, `detached`, `done`, `cancelled`,
`orphan`, `expired`), `started`, `elapsed_ms`, `lease_ms`, `expect_ms` (null when the model gave none), `tail` (the
scrubbed, capped tail rule 6 allows and nothing more), `times` and `ttl` for a subscription, and `result` (an
`@tool:` pointer once the call is done, null before). A write to it lands on the script's own copy of the facade (the owned copy `adoptCurrent` hands a script) and the next snapshot is unchanged; nothing a script does reaches the run's table. CORRECTED 2026-11-07 on e3's red-team row (the sentence said the write throws; the code, as built in #1437, hands a copy; ruled to the code, the throw not required).

What this buys, and why it is a ruling rather than a convenience:

- **Mode 2's predicate is free.** Watches already evaluate a read-only expression over `ml.current`; "when task 7 is
  done" is `ml.current.tasks` in that evaluator, no second one.
- **The actions stay tool calls.** `await`, `cancel`, `tail` and `join` are effects on the handle, so they are tools
  with the handle's sender checks (rule 5), never methods on the facade: `ml.current` has no effects, and a row's
  `id` is what the model passes to them.
- **The inbox pull sits beside it** (recommended, not yet Shane's word): rule 7's "pull is a read of the inbox as a
  `TableLike`" is `ml.current.inbox`, the events collected and not yet injected, so a muted policy is read from the
  same place.
- **Python parity by construction** (`CURRENT_CONTEXT.md`, "Python parity"): the same object in a cell, so a
  detached cell can read its sibling calls.
- **The prompt pays one line.** The table is never printed into the prompt; when it is non-empty the turn carries a
  count ("2 detached calls; `ml.current.tasks`"), per `PROMPT_BUDGET.md`.

What it must never carry: another run's rows (rule 5; the red-team row is a page reading `ml.current.tasks` of a run
it did not build), an unscrubbed or uncapped `tail`, a result value that the output cap would have handed to the
model as a pointer. It lands in mode 1's first PR with `ml.sh`, since the handle's state is what it reads; the async
lane's design note names the facade's module and how a row is kept current while the facade stays synchronous.

## What this changes for the people writing the pieces

- A new tool, `ml.*` member or page-started message type gets a RED-TEAM PASS before it lands (`AGENTS.md`): the
  handle, `await`, `cancel`, `join`, `subscribe` and the inbox read are all of those. The rows to expect: a page
  awaiting or cancelling another run's handle; a detached result arriving after the run ended; a subscription
  outliving its run or its TTL; a muted inbox hiding an overrun wake; a predicate with an effect or without a bound;
  a detached cell surviving the turn's end or its sandbox's kill; a handle crossing a navigation.
- The prompt text for the lease and the wake stays terse (`docs/dev/prompt-review.md`) and is measured on the
  panel before it ships: the wake's two phrasings are the part that matters.
- Each executor's detach is its own PR with its own doc paragraph: `ml.sh` first (its lifecycle exists; the work is
  the handle and the inbox return), `python_exec` second (its cancel and kill exist; the work is the lease and the
  turn-end rule beside the keep), `exec` last (no interruption; the honest limit is the whole of its design), fetches
  and the DOM tools after.

## Build order

Mode 1 first: it is the failure everyone hits. Mode 2 second, with the delivery policy in the same PR as the first
source, since a subscription without a policy is a poll. Mode 3 last, one flag. The order inside mode 1 is the
executor order above. Nothing here is assigned; a lane that takes it writes a design note to the coordinator before
the first PR, as every REPL lane does.

## Open questions

- `ml.current` in a Python cell: the facade has no `current` members today, so `ml.current.tasks` (and the rest of
  the facade) reaches Python only when that is built, a separate piece from mode 1 (recorded 2026-11-07).
- The lease's default per tool: a bench, as rule 1 says. The placeholder is seconds, not minutes.
- Whether the HUD and the sidebar show a detached call as a chip with its cancel, and whether the Run state panel's
  inbox view is the person's way to pull what a muted policy collected.
- How a page-hosted loop (no service worker spine) holds a detached call across the page's own navigation: today
  the `ml.agent()` promise dies with the navigated-away context while the run continues in the worker, and a handle
  the page holds dies with it; the worker's copy is the one that survives.
- Whether network inspection (the biggest win in the agent's own feedback) ships as a mode-2 source first or as a
  tool first.
- The ring buffer's size for a detached cell, and whether `tail` reads the worker's buffer live while the cell runs
  (the worker is busy, so the buffer is read by the offscreen document, which holds it) or only at the detach and
  the end.

## Related

`AGENT_MAIL.md` (mail is a mode-2 source and the other reader of the inbox), `HEADLESS_AGENTS.md` (a spawned run's
handle is a detached call's), `SHELL.md` "One call" and `SHELL_INTERACTIVE.md` (the one executor that detaches
today, and a held process as a stateful value), `docs/dev/python-sandbox.md` "The idle reap" and "Where the cancel
runs" (the lifetime and cancel a detached cell inherits), `STATE_INSPECTOR.md` "Watches" (the predicate evaluator),
`docs/dev/agent-tools.md` (the delegate's third outcome, `delegateSend`), `docs/dev/architecture.md` (the run's
`AbortSignal`, `ABORT_TASK`).
