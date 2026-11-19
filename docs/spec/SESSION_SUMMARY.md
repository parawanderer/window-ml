# Spec (WIP): the session summary page

**Status: specified, not built (2026-11-18).** Contents ruled by Shane (2026-11-18, ruling 50): the list below, open to
additions and cuts as they come up. Owners and order ruled by the coordinator (2026-11-18, "Owners and order" below). The access
tab's data is built on the worker side (`docs/spec/POLICIES.md`, "The effective view"); nothing else here is.

## What it is for

One page that says what a session is and what it holds: its state, its model and runtime, what it may reach, its files
and its share of the machine. Today that is spread over the session row, the transcript's usage line, the resource
panel and DevTools' state dump, and part of it (the Python kernel, the policies in effect) reaches no surface at all.

The page READS. It edits nothing except what a tab's own spec allows (the access tab removes a policy, with its confirm;
`POLICIES.md`). It is not a settings page and not a second transcript.

## Where it opens

- From the session's "..." menu, always: the chat page's `RowMenu` on a row and `SessionMenu` in the header
  (`src/chat/row-menu.tsx`, `src/chat/chat-app.tsx`) gain a "Summary" item in `SessionActions`, beside Pin, Rename and
  Export. The sidebar has no per-session menu today (its `IconMore` is "More panels"), so the sidebar's detail view
  gains one in its header, holding the same `SessionActions` (ruled 2026-11-18; built in the shell PR).
- The home tab is the summary. The other tabs are resources, files and access, in that order.
- On a phone it is the same page as a dismissable overlay over the session, not a route: dismissing it returns to the
  transcript where it was.
- Hovering a session row shows the SHORT FORM as a hover card (`src/sidebar/hover-card.tsx`, which exists and is unused
  on rows): title, state, model, last activity and open asks, each by the rules below. The row's own tips (`Dot`,
  `Stamp`, `PageChip`, `AgentBadge`) stay.

## What a missing value draws

A field with no source, or whose source answers "unknown" (`null`), draws NOTHING: its line is left out, not shown as
zero, "idle", "none" or a dash. Zero is drawn only when a source says zero. A tab whose every field is missing says
what it would hold and why it is empty ("No file store on this runtime"), in one line.

A field that only the extension's own runtime can answer ("local" below) reaches the page through one seam member,
`SessionHost.sessionDetails(key) -> {...} | null` (ruled 2026-11-18): `null` off the extension host, the shape of
`sessionPolicies`. It is never read from the state dump (`DUMP_RUN_STATE`), a debugging view whose shape the page must
not depend on. The object carries names and states only (a root's path, a package's name, an origin's level; never a
value, a file's content or a secret), and a field the worker cannot answer is ABSENT from it, never `null` or empty.
`sessionDetails` is page-reachable data, so it gets a red-team pass when built.

## The fields

Status is what the code on main answers today, at `ee67a765`:

- **have**: a source answers it for one session.
- **partial**: a source answers part of it, or only on some surfaces; the gap says what is missing.
- **need**: no source; the owning lane builds one.

Where a source is named, "host" means any `SessionHost` client (`ChatStore.index`, `ChatStore.runtimes`), "reducer"
the shared `sessionMap` `Session` (`src/sidebar/store.ts`), and "local" the `DUMP_RUN_STATE` message
(`src/sw/sw-run-state.ts`), which only extension pages send, off the worker's memory or storage.

### Summary tab

| Field | Status | Source today | Gap, and the lane that owns it |
| --- | --- | --- | --- |
| Title and hash | have | `SessionSummary.title`, `SessionSummary.id` (host) | — |
| State: running, waiting on an ask, finished | partial | `SessionSummary.status` (host); `Session.liveTurn`, `ended` (reducer) | No "paused" state exists, and "idle" is a finished status read as idle. The words are this page's mapping of `SessionStatus`; "paused" needs new data (session-store). |
| Python kernel loaded | need | `runNsVars` lives in the offscreen document only (`src/offscreen.ts`) | Reaches no surface; `DUMP_RUN_STATE` does not read the offscreen realm (python lane). |
| Time before the kernel is paused or killed | need | Rules only: `reapDelay`, `REAP_LIVE_MS`, `REAP_SETTLED_MS` (`src/python/py-reap.ts`), setting `pythonIdleMinutes` | No idle-since time or deadline is exposed (python lane). |
| Last activity | have | `SessionSummary.lastTs`, corrected by `RuntimeInfo.clockOffsetMs` (host) | Any activity, not only a message; the label says "last activity". |
| Context size against the model's window | partial | `sessionOccupancy`, `sessionContextLimit` (`src/sidebar/transcript/usage.tsx`, reducer) | The window is known only for a local runtime's loaded model; none over the hub, none for a cloud model (resource panel lane). |
| History size | partial | `StoredSessionRow` bytes and count (`session-store.ts`); `storage.stats` gives only the largest sessions | No per-session size command (session-store). |
| Agent run or chat | have | `SessionSummary.kind` (host) | — |
| Model | have | `SessionSummary.model` (host); a switched model in `run.model` (local) | — |
| Runtime | have | `SessionId.runtime` → `RuntimeInfo` name, kind, online (host) | — |
| Current page | partial | `SessionSummary.currentPage` (host, 2026-11-19): a worker-hosted run's tab after it moved, from the browser's navigation report; `SessionSummary.page` is the page it started on; `run.page` (local) | A page-hosted session has no current page (its page went with its document), and the report carries no title. Absent: the line says "started on". |
| Capabilities | partial | `RuntimeInfo.capabilities` (host, per runtime); `run.init` (local, per run) | Nothing per session over the host (session-store). |
| Started at, and by whom | have | `SessionSummary.createdTs`, `startedBy` (host) | — |
| Open asks | have | `SessionSummary.pendingApprovals` (host); details in `run.approvals` (local) | — |
| Tokens and cost so far | partial | Tokens: `usageSamples`, `sessionSubcall` (`usage.tsx`, reducer). Cost: `sessionCalls` priced through `services().priceCalls` (extension pages) | No cost on the web or hub chat page (session-store). |
| Fork parent | have | `SessionSummary.forkedFrom` (host, 2026-11-19): `fork()` in `ml-agent.ts` and `ml-chat.ts` sends `session.forkOf`, kept when the parent is on the same tab | Absent means not known: a parent on another tab, or one the runtime no longer holds, is not recorded. A worker-hosted chat (`sw-chat.ts`) has no `fork()`. |

### Resources tab

The session's slice of the resource panel, by mounting the existing components (`VramPanel`, `BoxPanel`,
`src/sidebar/resource/`), no new data. They scope to one session today only through the global `laneScoped` signal and
`scopedHash()`, which reads the open detail view's hash, so they take no session prop: the tab either sets the view or
the components gain a `hash` prop (a refactor in the resources PR, its call). On the chat page the panel exists only for
a local runtime; elsewhere the tab says so in one line.

#### Energy and its cost

Ruled by Shane (2026-11-19): the resources tab shows what a local model drew for the session, and its cost. Owner:
bench. The attribution is `tests/e2e/bench/electricity.mjs` today (readings integrated per interval, each interval's
energy split among the generations running in it, per GPU by residency, priced at each moment's rate). It becomes ONE
module under `src/spend/`, beside `price-book.ts`, that the bench and the page both import (moved with `move-symbols`),
never a second copy; only `runEnergy`, which reads the bench's SQLite box log, stays in the bench.

Where the readings come from. Live, from frames the extension already receives: the patched Ollama's `sample` frames
carry `info.compute.supported_gpus[].power` and `info.compute.power_sources`. In this clone's box log (2026-10-15 to
2026-11-17), 27,603 of 34,117 sample frames carried them, about half under 0.5 s apart while busy and 15 s apart idle. The
box log (`box.sqlite`, written by `box-stream.mjs`) is the bench's own record and never reaches the extension.
`sw-events.ts` keeps frames verbatim, so the fields arrive today, but the pinned `src/proto/events.proto` (fork
`10b026a3`) predates both (`GPUInfo.power` = 20 and `ComputeInfo.power_sources` = 6 on `slop`): re-pin before `src/`
reads them, so their names are checked.

What the attribution needs per session, and whether the extension holds it:

| Input | Used for | Held today |
| --- | --- | --- |
| `hint.session` on every `gen.end`, ours and every other client's | which generations are this session's; another client's take their share of an interval | Yes, live: each request sends `hintSession(hash)` (`contract-run.ts`), and `gen.end` frames carry every client's hint. |
| Power readings (`sample` frames' `info.compute`) | the energy | Only while the stream is held: `sw-events.ts` connects while a resource panel subscribes and stops with the last. The server's ring is 10 min (`RING_MS`); the sidebar keeps 45 min, in memory (`RESOURCE_RETENTION_MS`). |
| Residency per GPU (`sample` frames' `ps.models[].gpus`) | which card's draw a generation can take | As the readings: the same frames. |
| Rest baseline: each channel's median draw over readings at least 30 s after any generation, within 5 min of the session's generations | "above idle" and the 30 s tails | As the readings, and only when the stream was held around the session. |
| The electricity price (`usage.electricity`) | cost | Yes: each call records it (`price-book.ts`). |

So the extension can attribute only what it watched, and a past session's readings are gone with the stream. The page
reads a per-session share stored as it accrues, never the frames.

The hold (ruled by the coordinator, 2026-11-19). The worker holds the event stream while a local runtime generates for a
session and until that stretch closes (the 30 s tail and the 30 s rest after its last generation), with or without a
panel open, and only when the runtime's first `sample` frame carries a power field. It does not hold the stream while
nothing generates. A connection the worker opens with no frame seen asks for the server's whole ring
(`sinceFor(null, ...)` in `sw-events.ts`, `RING_MS`), so a stretch watched this way has the 10 min before it, as well as
the 30 s rest after it, to find its rest baseline in: each channel's median over readings at least 30 s after any
generation, every client's included. When neither part has such readings (the box was busy for the 10 min before, and
the next stretch opened inside the 30 s after), the rest is unknown: the stretch keeps its energy and draws no "above
idle", and its tails go unattributed, as `attribute` already does.

What an evicted worker leaves. A stretch's readings are in worker memory, and the worker can die between the last
generation and the close. The worker re-runs the attribution over the stretch so far at each of its `gen.end` frames and
writes the share each time, so an eviction loses only what came after the last write: the tail and any later
generation's part. The record is `{ J, aboveJ, basis, ms, cost, open, cut }`. It is written `open: true` until the close
writes `open: false`. On its next start, the worker marks every stretch still `open` as `cut: true`, and the page draws a
cut stretch's figure with the words "cut short: the browser stopped watching before the stretch ended". So a cut stretch
never reads as a complete one. The `defineState` declaration's description says this: "A session's local-model energy
and cost, one entry per stretch of generations, written at each generation's end; `cut` marks a stretch the worker
stopped inside, whose tail is missing." The test, a fixture of frames ending mid-stretch: "energy share: frames that
end mid-stretch leave a cut record, drawn as cut, never as complete".

Cost for one session in a page. The page reads one stored record per session. The attribution itself, measured on this
clone's box log (2026-11-19): `runEnergy` for the two busiest sessions (37 generations over 1.2 min, 27 over 2.8 min)
took 150 ms and 54 ms, SQLite reads and JSON parsing included, so per stretch in the worker it is noise. What would cost
is holding raw frames: a sample frame averages 4.8 KB (2.5 KB of it `info.compute`), about 1 MB a minute at the busy
cadence. The worker reduces each frame to its `reading()` on arrival and drops it once its stretch is attributed.

What draws when a reading is absent: nothing, by the rule above; never an estimate from rated wattage or token counts.
A session on a cloud model has no energy line. A local session whose box reported no power, or whose stretch was not
watched, has none either. A stretch with no rest baseline in reach shows the energy but no "above idle". The basis is
always drawn with the figure (`BASIS_WORDS`: "at the wall", "GPUs only", ...), because the scopes are not comparable.

Order of work, one PR each:

1. Re-pin `src/proto/events.proto` to the fork's commit that has `GPUInfo.power` and `ComputeInfo.power_sources`, and
   regenerate.
2. Move the attribution into `src/spend/` with `move-symbols`. The bench imports it from there. No behaviour change, and
   the bench's own tests are unchanged. To a janitor, through the coordinator.
3. The worker's hold and the stored share, with the cut record and its fixture test. To a janitor, through the
   coordinator.
4. The page's line in the resources tab.

### Files tab

Owned by files-host, after its scrub chain (#1948 and what it releases). On main, `/files/` is ruled, not built
(`FILE_ATTACHMENTS.md`).

| Field | Status | Source today | Gap |
| --- | --- | --- | --- |
| Count and list | partial | `run.files` (`sw-runs.ts`), `chat.files` (`sw-chat.ts`), local | The `/files/` store (files-host). |
| Bytes against the quota | need | Only the global `valueStoreBudgetMB`, `sessionStoreBudgetMB` | Per-session quota (files-host; over quota refuses new writes, ruling 48). |
| What the archive leaves out by size | need | — | Ruling 47 (files-host, archive). |

### Access tab

PR B: the policies row as a self-contained component on the ruled seam (`SessionHost.sessionPolicies(key)`,
`removePolicy(key, id, confirm?)`, SessionFeed `policies-changed`; `POLICIES.md`). The other rows follow it.

| Field | Status | Source today | Gap |
| --- | --- | --- | --- |
| Policies in effect | have (worker, #1975) | `sessionPolicies` (#1975); `policies.global`, `policies.run` (local) | The host seam is PR B. |
| `ml.sh` host attached, and its roots | partial | `shell.host` (local, browser-wide); `capabilities.shellHost`, `shellSandboxed` (host, booleans) | The contract leaves roots out of the host on purpose; roots are drawn local only. |
| Programs in `shellRevealsAllow` | need | Not in `src/` | The manifest lane's, #1977. |
| Hide and show entries | need | — | Ruling 34 (files-host). |
| Secret handles, by name only | need | No secret store; `SECRET_HANDLES.md` is an idea | Files-host's (ruling 18), after H16. |
| Whether the page's origin is approved | partial | `site.levels`, `run.env` (local); `blankStart.granted` (host, blank page only) | Local only. |
| Python network open or closed | need | Chosen per cell (`runPython` in `sw-python.ts`); no per-session flag | Ruling 37: closed by default; the gate's owner is not assigned. |
| Installed Python packages | have (local) | `python.run-installs` (`sw-pkg-installs.ts`, lost on browser restart) | Local only. |

## Owners and order

Ruled by the coordinator (2026-11-18):

1. This spec (small-fixes).
2. PR B, the access tab's policies row as a self-contained component on the ruled seam, in the gallery. Independent of
   this spec.
3. Gallery entries for the hover card and the summary tab against data that exists, then the shell (frame, header, tab
   strip, phone overlay, the "..." entry) with summary and access mounted (small-fixes).
4. The resources tab (small-fixes).
5. The files tab (files-host).
6. Fields marked "need", when the session-store lane resumes on Shane's word; until then they draw nothing.

## Ruled questions

1. Where the sidebar opens the page: a per-session "..." menu in the sidebar detail view's header, with the same
   `SessionActions`, built in the shell PR (2026-11-18).
2. How "local" fields reach the page: `SessionHost.sessionDetails(key)`, `null` off the extension host, never the state
   dump; names and states only, an unanswerable field absent; a red-team pass when built (2026-11-18).
