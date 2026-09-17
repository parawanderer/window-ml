# The chat page: implementation notes

The spec is [`docs/spec/CHAT_PAGE.md`](../spec/CHAT_PAGE.md) and the contract it reads is
[`docs/spec/SESSION_CONTRACT.md`](../spec/SESSION_CONTRACT.md) (`src/session-host.ts`). This file is how the code under
`src/chat/` is put together, and why.

## The pieces

| File | What it is |
| --- | --- |
| `session-feed.ts` | One session subscription's stream rules, as a pure state machine: what to do with each message `SessionHost.events()` delivers. |
| `chat-store.ts` | The client store over ONE host: runtimes, status, the session index, and the open session's events fed into the shared reducer. |
| `grants.ts` | What this client may offer on a runtime (`holds`, `mayCommand`), and whether it can render the runtime at all (`speaksOurContract`). |
| `host-services.ts` | The services seam (`src/sidebar/services.ts`) over a store: every call the shared views make becomes a contract `Command`. |
| `platform.ts` | `ClientPlatform`, what belongs to the device rather than the runtime, and its web adapter. |
| `composite-host.ts` | Several hosts as one, routed by runtime; the first host given wins a runtime two of them report. |
| `fake-host.ts` | A scripted host with real epochs and cursors, for tests, the web build and demos. |
| `demo-world.ts` | The fake host's runtimes and sessions: one of each state the page has to draw. |
| `chat-app.tsx`, `chat.css` | The page: list and session, two panes or one. |
| `web.tsx`, `chat.html` | The web entry, built to `dist-web/` by `scripts/build-web.mjs`. |
| `local-host.ts` | This browser as a `SessionHost`: the client of the background's `ml-sessions` port, reconnecting when the worker is evicted. |

Background side, outside `src/chat/` because the extension bundles it:

| File | What it is |
| --- | --- |
| `src/session-index.ts` | The cross-tab session index: one row and one event ring per session, with the contract's epoch and cursor. Pure. |
| `src/session-server.ts` | The `ml-sessions` port protocol over the index, and the command hand-off. Pure over a port-like object. |
| `src/sw-sessions.ts` | The worker's index and server, and the sender check on the port. |

## One reducer, one transcript

The store does not render sessions itself. It applies each event with `onDebug(event, runtime)`, the reducer every
panel surface uses, into the same `sessionMap`, and the page renders `DetailView` and `Composer` from
`src/sidebar/`. So a run reads the same on a phone as in the DevTools panel, and a renderer fixed in one place is
fixed in both. The price is that those views are held to the services seam: they may not reach `chrome` or a parent
frame (`tests/portable-session-views.test.mjs`), and they ask the seam (`sideCalls`, `bench`) rather than reading the
extension's config.

Sessions are keyed `runtime:hash` in `sessionMap`, so the same hash on two runtimes is two sessions. The page's
selection is the store's `view` signal (`{ name: "detail", hash: key }`), because shared views read it too (the
Python renderer names the driving model from it, and `highlight` targets the session being read).

## The stream rules

`SessionFeed` keeps an epoch and the SET of cursors applied in it, and drops, in this order: a message about another
session; an event from an unknown major version; an event whose payload names another hash than its envelope (a
runtime must not write into a record by mislabelling); an event from another epoch; an event already applied. A set
rather than a high-water mark, because the contract allows reordering around a reconnect: a lower cursor after a
higher one is new, not a repeat.

- `reset` adopts the new epoch and the store drops the reduced session: the backfill that follows rebuilds it. Merely
  appending would double every turn the client already had.
- `backfilled` with `truncated` under a NEW epoch and no `reset` (a runtime that lost the session's history) keeps
  what is shown and adopts the epoch. Keeping the old epoch was the first version, and it dropped every live event
  after the restart as stale.
- `gone` removes the session from the index and the reduced state, and returns the view to the list.

A feed outlives its subscription: reopening a session resumes from `position`, so the host sends only what is new.
The test for that counts what the host re-sent, because the reducer absorbs a repeated step by `seq` and the
transcript alone cannot tell a resume from a full replay.

Timestamps are moved onto this client's clock (`ts - clockOffsetMs`) on the way in, for `ts` only.

## Commands and failures

`ChatStore.send` never throws (the host never rejects) and turns a failure into a notice unless the caller passes
`quiet`. Side calls and highlights are quiet: a gloss that could not be fetched shows its own retry state, and a
highlight fires on every pointer move. The client never updates a transcript optimistically: approving sends
`approval.answer` and the gate closes when the runtime's resolved step arrives.

## Rendering by capability and grant

The page never branches on "is it local". A runtime without a `session.send` grant gets no composer and a sentence
saying so; an offline one says when it was last seen; one speaking another contract major is listed with a note and
its sessions are not shown. Grants are presentation only: the runtime checks every command itself, so a wrong answer
here costs a missing button or a `forbidden` notice, never access.

## The web build

`scripts/build-web.mjs` bundles `src/chat/web.tsx` into `dist-web/` (`chat.js`, `index.html`, `sidebar.css`,
`chat.css`, the KaTeX fonts). `npm run build` runs it after the extension, except for a variant built with `--outdir`.
It FAILS on any `chrome.*` reference in the bundle, and `tests/chat-web-bundle.test.mjs` runs the same check in memory
so `npm test` says so too. The web entry opens on `demoHost()` until `HubHost` exists (slice 6), and exposes it as
`window.__chatFake`.

The phone layout is the same component below `NARROW_PX` (760): one pane, the open session in the URL (`#s=<key>`) so
a reload stays put and a back gesture returns to the list, touch-sized controls, and `100dvh` so the composer is not
under a phone's toolbars. The step pill floats there instead of overlapping a turn's first line, which a panel's wide
first line leaves room for and a phone's does not.

## The local index

The background keeps one `SessionIndex` for the worker's life (`sw-sessions.ts`), fed from the places that already
feed the DevTools panel, so the index holds what a panel would show, for every tab at once:

- **A background-hosted run's own events** wherever `relayDebugEvent` fans them (`emitStep`, `fanEvent`, and
  `emitLifecycle` when the background is the one fanning). These are TRUSTED and bind the session to the run's tab.
- **A page's own events**, forwarded by the content-script shell: `ML_DEBUG_EVENT` in devtools mode (as before),
  `ML_SESSION_EVENT` in overlay mode (whose events otherwise never leave the page), and `ML_SESSION_EVENT` in off mode
  only with the `listPageSessions` setting. These are UNTRUSTED: the index accepts one only for a session the sending
  tab owns, or that no tab owns, and takes the page's URL from `sender.tab`, never from the event.

Off mode leaves each page's debug bus dormant, which is what makes it free, so waking it for the index is a setting
(default off, in DevTools Settings) rather than a default. When it is on, the corner card still takes only
background-tagged events: a console `ml.chat` must not put a card on the page.

**Ingest where the panel is fed, not everywhere an event exists.** A background-hosted run's start and result are
emitted by the page-side caller in overlay and devtools mode, and by the background in off mode or after a navigation
(`emitLifecycle`'s comment has the rules). Ingesting at the background's buffer point as well would have recorded both.
The index also de-duplicates by meaning (a second start unless `resumed`, a result identical to the one before with
nothing in between, a repeated `sayId`, a chat turn's id), which covers off mode with `listPageSessions`, where the page
and the background both report.

**Ownership.** A trusted event for a session a DIFFERENT tab created untrusted means the page squatted the hash: the
record is replaced and its generation (the epoch's suffix) is bumped, so subscribers reset. Once background-hosted, a
session accepts from pages only its owner tab's events, which is how a steer (`agent-say`, which only the page emits)
still lands. A closed tab releases its sessions; a page-hosted session left `running` by a closed tab or a new
document (`ML_DEBUG_RESET`) becomes `interrupted`.

**The ring.** Per session, bounded by count and by serialized size, plus a total size cap that trims the least
recently changed sessions first, and a session cap that forgets finished sessions first. Live output is coalesced as
it arrives: the newest `agent-stream` and `agent-turn` per step, the newest output delta per `seq`, and a finished step
or a result drops the deltas it supersedes. Each carries its accumulated state, so a client that applied a dropped
entry is not behind. Only a cap loses history, and `lostThrough` records how far, which is what `truncated` reports.

**Opening a subscription.** From a position under the current epoch that the ring still covers: only the tail. From
anything else: `reset`, the whole ring, `backfilled`. For a session the worker does not hold (never seen, or lost with a
previous worker): `backfilled` alone, truncated when the client held something, so the page keeps its transcript. The
epoch is `<spawn>.<generation>`, with a fresh spawn id per worker life, so no position from an evicted worker resumes.

**A list row** is derived by the index, not the sidebar reducer (which lives in the panel bundle with its signals): an
agent's status follows the reducer's seal (a straggler step from a finished turn does not reopen it), gates are counted
by the `seq` of steps pending with `awaitingApproval`, and a row whose only change is `lastTs` is reported at most every
five seconds, so a streaming run does not upsert the list on every delta.

**The client.** `LocalHost` takes `connect` (the extension entry passes `chrome.runtime.connect`), so it has no
`chrome` reference and its tests run it against the real server over an in-memory port. On a disconnect it answers
in-flight commands `unavailable`, marks the runtime offline, reconnects with backoff, asks for the index again, and
re-subscribes each open session from the last position it delivered.

## The local commands

`src/session-commands.ts` maps each contract command onto a path the extension already has, over injected
dependencies (`sw-sessions.ts` supplies the browser's, `background.ts` the runs'), so every decision is tested without a
browser. Nothing new decides a gate, starts a loop or builds a request.

| Command | Path |
| --- | --- |
| `approval.answer` | the one `resolveApproval`, keyed `hash:seq`; `resolved: false` when the gate already closed |
| `session.send` | a RUNNING background loop: straight into its inbox (what a handle's `say` reaches through `INJECT_MESSAGE`), shown as an `agent-say` the loop marks seen. Anything else, or a message with images or an element: the session's page, through the composer's own handler |
| `session.cancel` | a background run: `cancelBackgroundRun` (the `CANCEL_RUN` body, factored out); otherwise the page |
| `session.continue` | only a `capped` session, through the page |
| `session.delete` | refused while running; forgets the stored chat (`ml_session_<hash>`), the resumable snapshot and pointer store, then the index row |
| `page.highlight` | `ML_HL_REMOTE` to the session's tab with `anyMode`, since the shell otherwise draws remote highlights only in devtools mode |
| `side.call` | `fetchLLM` on the utility profile, `think: false`, `maxTokens` capped at 1024, the session on the hint; `unsupported` without a utility model, which `capabilities.sideCalls` also says (kept current from storage) |
| `tab.screenshot` | `captureVisibleTab`, only for a tab in front in its window; PNG, then JPEG at falling quality until it fits `maxBytes` (ceiling 4 MB); size read from the image header |
| `tabs.list` | `chrome.tabs.query`, http(s) tabs only |

**The page says what it did.** The composer's page path was fire-and-forget, so the result could not say whether a
message steered a run, started a turn, or reached nothing (a reloaded page no longer holds an unsaved chat). A command
now carries a `reqId`; the shell relays it into the page and waits up to three seconds for the page's
`__mlSessionDone` (`steer`, `turn`, `cancelled`, `continued`, `busy`, `none`), and the command answers from that:
`none` is `not-found`, no reply is `unavailable`. The page's answer is its own claim about its own session and decides
nothing: the transcript still changes only through the session's events. The DevTools composer sends no `reqId` and is
unchanged.

**A screenshot of a background tab is refused, not taken with the debugger.** CDP could capture it, but attaching
puts the debugging banner on someone's screen for a look they did not start.

## Not yet

- The extension entry (`chat.html` over `LocalHost`) is slice 3, and its `ClientPlatform` adapter comes with it.
- The index lives in worker memory: an evicted worker comes back with an empty list. Saved sessions surviving that is
  slice 4.
- `CompositeHost.events` attaches to the host that owns a runtime when it subscribes, and does not move if a
  higher-priority host reports that runtime later.
- The panel's tooltips (`cursorTipOn`) are pointer-only, so on a touch screen their prose is unreachable.
