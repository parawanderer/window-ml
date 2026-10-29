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
  be lease-detached from its thread without killing it. Detaching one means only that the service worker STOPS
  AWAITING it: the loop is free for shell, DOM and text work, and the kernel is BUSY AND LOCKED until the cell
  returns or its sandbox is killed. A further `python_exec` of that run queues behind the detached cell or is told
  "busy with <id>", never runs beside it; nothing can read a half-mutated namespace, so there is no race to warn
  about, only a lock to state. There is no second worker per run, by the reset-ownership ruling that the worker
  boundary is the run boundary (`docs/dev/python-sandbox.md`), and no fork in Pyodide: a model that wants parallel
  Python launches scripts through `ml.sh`.
- **Interrupting an in-thread call is a kill, and the spec says so.** The sandbox's bounded 1 s cancel is the asyncio
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
   asyncio tail, above), after which the keep is gone and the next cell is told the loss, as the reap already says. `ml.sh`: the host's `cancel`, or its
   deadline kill. A fetch: its abort. `exec`'s main-world eval CANNOT be interrupted once running; cancel there only
   stops awaiting it, and the result says so rather than implying the JavaScript stopped. A cancel's effect is a
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
             ├─ cancel(id) ──────────────────────► cancelled, or "cannot interrupt, no longer awaited"
             ├─ finishes on its own ─────────────► result through the run inbox at a turn boundary
             ├─ misses the expectation ──────────► a labelled wake through the inbox; the call lives on
             └─ the run ends ────────────────────► cancelled by its executor, or reported as an orphan

subscribe(on, times, ttl) ───────────────────────► id now; matches through the inbox         (mode 2)
   the inbox's delivery policy (model-owned, person-overridable) decides when a wake is injected,
   except an overrun wake, which it may only defer
```

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
