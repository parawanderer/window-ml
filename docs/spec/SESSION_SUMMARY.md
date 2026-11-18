# Spec (WIP): the session summary page

**Status: specified, not built (2026-11-18).** Contents ruled by Shane (2026-11-18): the list below, open to additions
and cuts as they come up. Owners and order ruled by the coordinator (2026-11-18, "Owners and order" below). The access
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
  Export. The sidebar has no per-session menu today (its `IconMore` is "More panels"); where the sidebar opens the page
  is open question 1.
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

A field that only the extension's own runtime can answer (the "local" column below) is drawn under the extension host
and left out elsewhere, by the same rule as the access tab's seam (`SessionHost.sessionPolicies` answers `null` off the
extension host).

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
| Current page | partial | `SessionSummary.page` is the page it STARTED on (host); `run.page` (local) | No current-page field; `tabs.list` joined on `tabId` needs the `drive` scope (session-store). Until then the line says "started on". |
| Capabilities | partial | `RuntimeInfo.capabilities` (host, per runtime); `run.init` (local, per run) | Nothing per session over the host (session-store). |
| Started at, and by whom | have | `SessionSummary.createdTs`, `startedBy` (host) | — |
| Open asks | have | `SessionSummary.pendingApprovals` (host); details in `run.approvals` (local) | — |
| Tokens and cost so far | partial | Tokens: `usageSamples`, `sessionSubcall` (`usage.tsx`, reducer). Cost: `sessionCalls` priced through `services().priceCalls` (extension pages) | No cost on the web or hub chat page (session-store). |
| Fork parent | need | `fork()` in `ml-agent.ts` and `ml-chat.ts` records no parent; `SessionSummary.lineage` is for subagents and unfilled | A fork's parent is not recorded (session-store). |

### Resources tab

The session's slice of the resource panel, by mounting the existing components (`VramPanel`, `BoxPanel`,
`src/sidebar/resource/`), no new data. They scope to one session today only through the global `laneScoped` signal and
`scopedHash()`, which reads the open detail view's hash, so they take no session prop: the tab either sets the view or
the components gain a `hash` prop (a refactor in the resources PR, its call). On the chat page the panel exists only for
a local runtime; elsewhere the tab says so in one line.

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
| Programs in `shellRevealsAllow` | need | Not in `src/`; planned (shell lane). | |
| Hide and show entries | need | — | Ruling 34 (files-host). |
| Secret handles, by name only | need | No secret store; `SECRET_HANDLES.md` is an idea | (no lane yet) |
| Whether the page's origin is approved | partial | `site.levels`, `run.env` (local); `blankStart.granted` (host, blank page only) | Local only. |
| Python network open or closed | need | Chosen per cell (`runPython` in `sw-python.ts`); no per-session flag | (python lane) |
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

## Open questions

1. Where the sidebar opens the page: the sidebar has no per-session "..." menu. Proposed: add one to the session
   header in the detail view, holding the same `SessionActions`.
2. Whether "local" fields reach the page through one more seam member (proposed: `SessionHost.sessionDetails(key) ->
   {...} | null`, `null` off the extension host, the shape of `sessionPolicies`) or through the existing state dump.
   The dump is a debugging view of every realm; a page reading it would tie the page to its shape.
