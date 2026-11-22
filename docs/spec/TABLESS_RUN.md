# A run that starts with no tab

**Status: proposal, nothing built (2026-11-14, from Shane's idea in the window-ml-9b session; the tab invariant read
by the `[window-ml move-run]` lane on move-run-b 0e0b6707; the build is that lane's, after MOVE_RUN slice 2, by the
coordinator's ruling of 2026-11-16).** It changes a decision in [`CHAT_PAGE.md`](CHAT_PAGE.md) ("an agent chat needs a
primary page") and extends [`MOVE_RUN.md`](MOVE_RUN.md) shape (a). It waits on that shape, not on shape (b). Resuming a
session whose tab closed is part of it (§Resuming with no page, 2026-11-17).

## Why

The chat page's start form offers "New tab" first: a run that does not need a page yet is given one anyway, because a
run must have a tab. That one choice is most of `blank-start.ts`, a state machine for when the browser will not let
the extension run on the page it just opened, so the start form can raise a permission dialog for a page nobody
asked for.

Many sessions need no page at the start: work on files the person drops in, on the disk through `ml.sh`, in Python,
on fetched pages. A tab, if one is needed at all, is needed later, and at a URL that is known only then.

## The decisions

- **"No tab" replaces "New tab"** as the first choice of the agent start form (`tab-picker.tsx`). The open tabs stay
  below it. A run started this way is DETACHED: it has a transcript, worker-realm tools, and no page.
- **The start form asks for no URL** (Shane, 2026-11-14). Nobody types a URL without their bookmarks and the
  address bar's hints; the person tells the model where to go ("to gmail") and approves its `navigate`. The URL
  field of today's "New tab" goes with it, and `blank-start.ts`'s check moves to that approval.
- **A detached run's tools are the worker-realm ones** (`realm: "worker"` in the tool registry): `python_exec`,
  `fetch_url`, `task`, `answer`, `agent_api_docs`, the `propose_*` tools, and the run's files. A page-realm tool is
  refused with a sentence saying the run has no page and how it gets one; it is not removed from the tool list, so the
  model learns the way to a page instead of not knowing one exists.
- **It gets a tab two ways, and only two:**
  1. **The person attaches it**: MOVE_RUN shape (a), a move between turns, from "no tab". From the chat page
     ("move to tab…") or the HUD ("bring a session here"), as for any other run.
  2. **The model calls `navigate`**, and the person approves it. No new tool: `navigate` from the detached state
     opens a tab at the URL and attaches the run there.
- **The run started there is a run the PERSON started**, so it works on any page, as a run started from the HUD
  does, and the site-access lists do not apply to it ([`SITE_ACCESS.md`](SITE_ACCESS.md)).

## `navigate` from the detached state

It is the tool a run already uses to carry itself onto another site. The hostile case (a model steered by injected
content asking to go to a page that then receives the run's context) is the cross-origin `navigate` the gate already
asks about. What changes is the branch it runs, because `navigate` today assumes a page (`navigateTool`,
`ml-tool-factories.ts`: `realm: "page"`, the target resolved against `location.href`):

- **The worker runs it**, not the page: it opens the tab, waits for its load, and attaches the run.
- **Every target is another site.** It asks every time, whatever the run's `crossOrigin` fact says, because "same
  site" has no site to be the same as. Treating the first navigation as same-site would let it through unasked.
- **A relative URL is refused**: nothing to resolve it against.
- **The approval card checks the site's access before the tab opens**, the start page's `blankStart` check moved to
  the moment it is needed.
- **The description the model reads** gains one clause for the detached state (PROMPT_BUDGET applies).

Its tests are `navigate` tests, written to fail first: from the detached state it always asks, a relative URL is
refused, a refused approval opens no tab, and a page cannot start it (no `HANDLE_MAP` entry, as for a move).

## `ml.sh` with no page

`ml.sh` is reached two ways today ([`docs/dev/shell.md`](../dev/shell.md)): from an `exec` in an isolated world on a
tab (`exec-routing.ts`), and from a `python_exec` cell outside the dialect over the wire (`sw-ml-wire.ts`). The second needs no
page, so a detached run has `ml.sh` already, through Python. Its cost is that a cell outside the dialect always asks.

Open: whether that is enough, or whether a detached run wants a worker-hosted `exec` world with `ml.sh` in it. A bench
of disk tasks in a detached run, Python-only, answers it; nothing is built for it before that.

## How it would work

The tab is a hard number today, between turns as much as during them (the move-run lane's reading):

- `bgRuns` and its persisted snapshot hold `tabId: number`, and the restore after an eviction skips a snapshot whose
  `tabId` is not a number (`sw-runs.ts`). A null-tab run would vanish at the first eviction.
- The run inbox, `activeRuns`, the replay ring, `trackRun`/`releaseRunTab`, the tab pin, the arrival watcher and
  `startingControllers` are all keyed by tab id. The worker tools are built with the tab (`buildWorkerTools`).
- About 120 sites that send to the page read the turn's tab binding (`sw-run-host.ts`) and expect a number.

So the shape is **one DETACHED HOST behind one predicate**, not `tabId: number | null`: a sentinel host that refuses
page-realm tools, files the run under its run id where today's maps file it under a tab, and sends UI events to the
chat page. The nullable type would spread a guard over every one of those sites. This decision is made before anyone
types `| null` into `bgRuns`.

- **The snapshot** gains the detached form, and the restore keeps it (an UPGRADE test: an old snapshot, a number,
  restores as before).
- **The move from no tab**: `moveRun` (`move-run.ts`) reads the source tab and then releases it, notes the leave on
  its card and relays a debug event to it. From a detached run those three are skipped; the rest is the move as it is.
- **Where a detached run renders and buffers** is the one new design question. Today a run is shown by its tab's card
  and its replay ring; the chat page becomes the first surface that shows a run on its own, and the ring is keyed by
  run. [`CHAT_PAGE.md`](CHAT_PAGE.md) and the session index are where that lands.

## When a detached run ends (Shane, 2026-11-14)

A run whose tab closes BECOMES detached, as if it had started that way; it does not end there.

- **It is kept for a grace period.** If the person opens it on the chat page within it, it goes on detached, and
  gets a tab again by attach or `navigate`.
- **If no one opens it within the grace period, or the browser closes, it is done**: everything that holds memory
  for it is released (its Python namespace, its `@tool:` values, its inbox, its replay ring), and `endTasks` runs,
  which is the release that cancels its cells. The transcript stays in the session store as for any finished run.
- **Unless a background task of the run is still running** ([`ASYNC_CALLS.md`](ASYNC_CALLS.md)): that keeps it
  alive, and the grace period starts when the last task ends. On main this already holds for the task itself: a
  turn's `settle` calls `closeTurnTasks`, not `endTasks`, so a task outlives its turn; tasks are keyed by run, never
  by tab, and a tab close touches none of them. A result that lands with no turn running is parked in the task table
  and reaches the next turn, so it waits for whoever reopens the run. Each task is capped by `detachedTaskMaxMin`.

What main does NOT have (read by the async lane, main 43f88825):

- **A release on a tab close.** `tabs.onRemoved` drops the tab's `activeRuns` entry and the page's own value session,
  never the run's: today a run whose tab closes keeps everything, with no grace period and no release. The release at
  grace expiry is a NEW trigger, beside `forgetRun`, a failed start, the install purge, token-store pressure, and
  archive or delete.
  It ships FIRST, without this spec (Shane, 2026-11-14; the async lane's, through `releaseSessionTokens`): a closed
  tab's run with no running task is released after the grace period, its transcript and stored run kept (a later
  Continue starts a fresh namespace and is told so), and the session list shows whether a session is still alive and lets the
  person stop its kernel by hand, the same release at once. This spec then changes only what the run is during
  the grace period: detached, and reopenable.
- **"The run has no running task", as something the worker can ask.** The task table is private (`sw-tasks.ts`). The
  async lane builds `hasRunningTasks(runId)` (hydrating first: after an eviction the in-memory table is empty while
  cells still run), or an `onTasksIdle(runId)` hook from `finish()` that also fires on the path where a cell finished
  while the worker was evicted (`rehydratedCellTask`).
- **A timer that survives eviction.** The grace period is a deadline in storage, checked when the worker wakes
  (an alarm), never a `setTimeout`: the worker is gone after about 30 s idle and is not awake when a cell finishes.
  The browser closing ends it because the task table (`chrome.storage.session`) and the timer go with the session.
  Its length is a stated default, not a measured one: 10 min, the DevTools setting `closedRunGraceMin` (0 releases
  at once); nothing yet records how soon a closed run is reopened.
- **A turn started by a finished task on a run with no tab.** The async lane's next slice starts a turn when a task
  finishes and refuses with reason `no-tab` when the run has no tab, leaving the result parked. That is right for a
  detached run until someone reopens it; whether a reopen starts that turn is decided in that branch.

## Resuming with no page

**Status: amendment, proposal, nothing built (2026-11-17, the `[window-ml move-run]` lane; the defect that started it
is #1946).** What Shane said, on 2026-11-14 in the `[window-ml move-run]` session (0b684e12), reporting that "Resume
on a page" was broken: the end of a resume should be starting and resuming without pages, "just a chat input
bubble"; on startup a line saying the kernel(s) are being re-initialised "with X objects or whatever"; the model then
goes to a page either because it is told to navigate, or through a control the person uses that picks from their
tabs, with no approval since the person triggered it, and not in the chat bubble, "because it being there implies
that you are sending it as a chat message"; perhaps a `/`-command, which Shane left undecided. Everything below that
is not in those words is the lane's proposal.

- **No closed-tab bar.** Today the chat page swaps the composer for a bar ("The tab this run worked in has closed",
  `.chat-resume` in `chat-app.tsx`, chosen by `resumableHere` in `grants.ts`) whose one action is the "Resume this
  run" dialog and its tab pick. That bar and that dialog go from this path: the composer stays, as for any idle
  session.
- **The first message resumes it, detached.** Sending to such a session resumes it on the DETACHED HOST and then
  continues with the message, one action for the person. During the grace period the run is already detached
  (above), so the send is an ordinary turn; after it, or after the browser restarted, the send rehydrates the saved
  run first, as `session.resume` does today, with no tab. A chat session (no tools) has no page to lose: the send is
  the whole of its resume. If the resume FAILS on that first send (the rehydrate refuses, the saved run is gone),
  the typed message stays in the composer, the error is shown above it, and nothing is sent to the model.
- **A visible line says what the kernels are started with.** The `session-resumed` divider gains, per kernel the run
  had (the Python namespace today; a worker `exec` world if the `ml.sh` bench above ever builds one), one of:
  - kept: the namespace was never released, and holds N names;
  - re-initialised: the namespace was released at `<time>` (`<reason>`: the grace period, the idle reap, a memory
    eviction, a fatal Pyodide error and its respawn (`kernel-death`), a browser restart, a person's stop), so the N
    names it held are gone (the first 50 by name, then the total), and it starts with the run's files and its kept
    `@tool:` values, each counted.

  The line is drawn as part of the divider, never as a message, and both exports carry it. The MODEL is told the same
  in one line at the head of its next turn ("namespace reset at <time>: <reason>", PYTHON_DIALECT.md, "The
  namespace"), so it does not call a name that is gone. The names come from the scope manifest (`runNsVars`,
  `offscreen.ts`, the copy `ml.current.env` reads), which is dropped WITH the namespace: to name what was lost, the
  release keeps that list in the session store before it drops it: NAMES only, never values or types' contents,
  capped at the first 50 plus the total, the same cap in the record, the divider and both exports. Every path that
  drops the namespace (the six reasons above) writes that record through ONE function. The names field is ABSENT
  when the list could not be read, never an empty list: an empty list with a total of 0 means the namespace held
  nothing, and a reader tells the two apart. The absent case, a path that cannot run the writer (a browser restart)
  and a session released before the record existed all take the form that gives what is known (released, when,
  why) and no count.
- **A page later, two ways, as for any detached run.**
  1. **The model navigates**: `navigate` from the detached state, approved by the person (above).
  2. **The person picks one of their open tabs**: MOVE_RUN shape (a) from no tab. The person started it, so it asks
     for no approval; the tab's grants start empty, as `RESUME_DROPS` already says of every resume. Between turns
     only: while a turn runs the control says it waits for the turn to end, until MOVE_RUN slice 2 moves a running
     turn.
- **That control is not in the composer and not in a bubble.** Anything typed into the composer reads as a message
  to the model, and this is not one. Its surface is OPEN, for Shane:
  - a page chip beside the composer ("page: none ▾", or the tab's title once attached) that opens the open-tabs
    picker (`useTargetPick`), always visible, so the person can see the run has no page;
  - a `/`-command (`/page`) that opens the same picker, Shane's own tentative suggestion. It is typed in the
    composer, where a message goes, and nobody finds it until told;
  - both, the chip as the surface and the command as its shortcut (the lane's recommendation).
- **The contract.** `session.resume` names a TARGET today, a tab or a blank one. Resuming detached is a third target
  (`{ detached: true }`), additive, agreed with the hub session before it is built, as the first resume was; the
  phone and other clients then resume the same way. The tab pick is `session.resume` with a tab target, as today.
  The target lands first as a [`SESSION_CONTRACT.md`](SESSION_CONTRACT.md) diff, read before the build, and the
  build PR carries `@hub-compat`.

### The overlap with the async lane's closed-tab release

The release above ("It ships FIRST") is the async lane's: the grace period, `closedRunGraceMin`, the alive marker in
the session list and the stop-the-kernel button. This section does not touch that code. Two things are shared:

- **The fact "this run's namespace was released, at T, because R", with the names it held.** The release records
  it; the re-initialised line reads it.
- **The model's line.** The release says "a later Continue starts a fresh namespace and is told so"; the
  re-initialised line above is that telling, for the person and the model. It is one line, not two.

The boundary (the coordinator's ruling, 2026-11-17, on #1947):

- **The record lives in the session store**, on the session, not in the run log. The divider, the exports and other
  clients read the session; the run log stays diagnostic.
- **The async lane owns the writer and the record's shape** (time, reason, the capped names, the total). It lands
  with the closed-tab release, or as an additive follow-up if the release merged without it.
- **The move-run lane owns every reader**: the divider line, the exports, and the model's one line. The model's line
  is written once, in the move-run build; the release does not add a second.
- **Order**: the release first, then this section (Order, item 4). A session released before the record existed
  takes the "what is known" form.

## Order

1. MOVE_RUN shape (a) on main.
2. The detached host, the snapshot form, and where its events render. "No tab" in the start form. Attach from no tab.
   A closed tab detaches its run, with the grace period: the async lane's task predicate first, then the release.
3. `navigate` from the detached state, with its tests.
4. Resuming with no page: the closed-tab bar goes, the composer resumes detached, the kernel line, the person's tab
   pick. It needs 2 and the async lane's release; the pick needs only 2.
5. The `ml.sh` bench, and a worker `exec` world only if it says so.

## Open

- The surface of the person's tab pick: a chip beside the composer, a `/`-command, or both (§Resuming with no page).
- Whether the person can detach a run whose tab is still open (a closed tab detaches it; above).
- How this relates to headless runs ([`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md)): a detached run has no page at all; a
  headless one has a page no one sees.
