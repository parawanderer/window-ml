# A run that starts with no tab

**Status: proposal, nothing built (2026-11-14, from Shane's idea in the window-ml-9b session; the tab invariant read
by the `[window-ml move-run]` lane on move-run-b 0e0b6707; UNASSIGNED).** It changes a decision in
[`CHAT_PAGE.md`](CHAT_PAGE.md) ("an agent chat needs a primary page") and extends [`MOVE_RUN.md`](MOVE_RUN.md) shape
(a). It waits on that shape, not on shape (b).

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
tab (`exec-routing.ts`), and from a full-mode `python_exec` cell over the wire (`sw-ml-wire.ts`). The second needs no
page, so a detached run has `ml.sh` already, through Python. Its cost is that full mode always asks.

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

## Order

1. MOVE_RUN shape (a) on main.
2. The detached host, the snapshot form, and where its events render. "No tab" in the start form. Attach from no tab.
   A closed tab detaches its run, with the grace period: the async lane's task predicate first, then the release.
3. `navigate` from the detached state, with its tests.
4. The `ml.sh` bench, and a worker `exec` world only if it says so.

## Open

- Whether the person can detach a run whose tab is still open (a closed tab detaches it; above).
- How this relates to headless runs ([`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md)): a detached run has no page at all; a
  headless one has a page no one sees.
