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
| `view-mode.tsx` | How much machinery the page shows (calm), whether the list pane is open, and the two controls that flip them. |
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
| `chat.start` | a chat the worker hosts itself: `sw-chat.ts` (below) |
| `agent.start` | the target tab's own start path, the one the HUD composer uses (below) |

**The page says what it did.** The composer's page path was fire-and-forget, so the result could not say whether a
message steered a run, started a turn, or reached nothing (a reloaded page no longer holds an unsaved chat). A command
now carries a `reqId`; the shell relays it into the page and waits up to three seconds for the page's
`__mlSessionDone` (`steer`, `turn`, `cancelled`, `continued`, `busy`, `none`), and the command answers from that:
`none` is `not-found`, no reply is `unavailable`. The page's answer is its own claim about its own session and decides
nothing: the transcript still changes only through the session's events. The DevTools composer sends no `reqId` and is
unchanged.

**A screenshot of a background tab is refused, not taken with the debugger.** CDP could capture it, but attaching
puts the debugging banner on someone's screen for a look they did not start.

## Chats the worker hosts

`chat.start` makes a conversation with no page behind it (`src/sw-chat.ts`). Every other session in the index belongs
to a tab: a console `ml.chat`, a page script, a background-hosted run delegating its tools back to the page it started
on. This one does not, because the person typed it into `chat.html`, and closing that page must not end the
conversation the phone will open later through the hub.

The turn is emitted here, as the same `chat` / `chat-result` / `chat-error` events `injected.ts` emits for a page's
chat, so the index, the session views and the exports read one shape and none of them has to know which side ran it.
The start and its result share an `id` derived from the hash and the turn number rather than drawn at random, so a
turn reported twice is recognised as one turn.

**This is the one place an event reaches the index without also going to `relayDebugEvent`**, and that is not the
double-feed the AGENTS.md trap is about. That trap is about recording a run twice because a background-hosted run's
lifecycle is emitted page-side on some surfaces and background-side on others. Here there is no panel to relay to at
all: a DevTools panel attaches to a tab, and this session has none.

Three things follow from having no page:

- **A message is simply the next turn.** There is no loop to steer and no page to relay to, so `session.send` checks
  for a worker-hosted chat BEFORE both run paths, which each end at a tab this session does not have. A message that
  arrives while the model is still answering is a `conflict`, since a chat has no inbox.
- **A saved chat survives the worker.** Each answered turn writes the same `ml_session_<hash>` record a page's
  `{ save: true }` chat writes, so `ml.resumeChat(hash)` picks it up from a page like any other, and the next message
  after an eviction rehydrates the history from it instead of reporting that the chat is gone. The turn counter is
  rebuilt from the answers in that history, or the turns after an eviction would reuse ids the earlier ones had.
  An `ephemeral` chat writes nothing and is therefore gone when the worker is.
- **A failed turn does not keep the message it could not answer**, so the next turn does not re-send a question the
  model never answered. The attempt is still in the transcript as its own `chat-error`.

The map of live chats is capped (`MAX_BG_CHATS`), dropping the chat idle longest; a saved one comes back from storage,
so the cap costs a round trip rather than a conversation. A chat mid-turn is never dropped.

## Starting a run from an extension page

`agent.start` does not start a run. It asks a tab's page to start one, through `ML_START_AGENT` → the shell →
`__mlStartAgent` → `ml.createAgent().run()`: the same path the HUD composer uses. That is deliberate. The page
builds the toolset and the system prompt, because it has the DOM, the config and the tool factories; a second
start path in the worker would be a second set of defaults to drift from the first. The run then routes itself to
the background loop in off and devtools modes exactly as a console run does.

**How the command learns which session it got.** The hash is minted inside the loop, after its own async setup, so
it does not exist when `run()` is called. Rather than poll the handle for it, the run reports it: an internal
`_onSession(hash)` option, called once on the first turn at the moment the hash is assigned, which the
`__mlStartAgent` handler turns into the same `__mlSessionDone` acknowledgement the other page commands use
(`outcome: "started"`, plus the hash). A start gets a longer deadline than a send (`START_DONE_MS`, ten seconds
against three), because it is waiting for the loop's setup and not merely for a page to receive a message.

**A blank tab is a real page.** The browser's own new-tab page cannot host a run: the extension is not allowed to
run there, so an agent would open on a page it cannot see. `{ kind: "blank" }` therefore opens a tab at the
command's `url`, or at the `agentStartPage` setting, and refuses when it has neither. Having opened it, the worker
waits for **`window.ml` to exist in the new page's main world**, not for the tab to report `complete` and not for
the content script to answer: the content script registers its listener before `injected.js` runs, so a start
relayed on that signal reaches a page whose `__mlStartAgent` listener does not exist yet, and the run is lost to a
timeout.

A tab whose URL is not http(s) is refused with `forbidden` before anything is started, for the same reason.

## The extension entry

`src/chat-ext.tsx` is `chat.html` as a tab of this browser: a `LocalHost` over a `ml-sessions` port, the
extension's `ClientPlatform`, and the same `ChatApp` the web build renders against a fake host. The popup's
**Sessions → Open** opens it, focusing the tab when one is already open, since two of them would each hold their
own port and their own scroll position.

It sits at `src/` rather than in `src/chat/` because it is the one file of the chat page that knows `chrome`
exists, and everything under `src/chat/` has to build for a phone. `sidebar/services-ext.ts` sits beside its seam
for the same reason.

**The extension's platform adapter is the web one with a different `kind`**, and that is worth stating rather
than dressing up: an extension page is a page, with the same `localStorage` (on the extension's origin, so
preferences are shared with other extension pages rather than with a site), the same anchor download and the same
clipboard. `kind` still earns its place, because a surface may offer something only where it can be done, and the
core asks the platform rather than inferring it from the runtime.

## Starting a session from the page

The list header's `+` (`src/chat/new-session.tsx`). Until it, every session in the list had been started somewhere
else — a console call, a page script, the HUD — and the page could only answer what already existed.

It is rendered by capability like everything else here: a runtime offers "new chat" only where
`capabilities.chat` says it can, "new agent run" only where `capabilities.agent` does, and the tab picker only
where `capabilities.tabs` does, with `mayCommand` deciding whether this client may ask at all. A phone talking to
a headless box gets a chat form and no tabs, and this file does not know what a box is. When only one runtime can
hold the kind being started, the form does not ask which; when only one KIND can be started, `+` is that kind
rather than a menu of one.

**The form is deliberately not in the URL**, unlike the open session. It holds what someone is part way through
typing, and a link to a half-written message is not a thing to share or to reload into.

**A refusal leaves the form standing, with the text still in it.** The store already raises the failure as a
notice, so the person changes the target or the wording and presses start again, rather than retyping a task
because a tab had closed.

The fake host starts sessions too, so the form is exercised at phone width in the web build before it is
exercised against a browser: `chat.start` mints a session and answers the first turn, `agent.start` mints a
running one, and `tabs.list` returns three demo tabs so the picker has something real in it.

## Saved sessions

`src/session-store.ts` keeps a session's DEBUG EVENTS in IndexedDB, and `capabilities.persistence` says whether this
browser can (a worker with no IndexedDB reports `false` rather than hoping).

**Why the events and not a transcript rebuilt from them.** They are what the sidebar, the chat page and both
exports already render, so a saved run reads exactly like a live one and there is no second rendering path to keep
in step. The cost is size, which is handled where it belongs: a byte budget and a session count, evicting oldest
activity first, never a running session and never one a page is subscribed to.

Two object stores, so appending an event does not rewrite the session, and writes are batched (a streaming run
emits one every ~100 ms, and a transaction each would spend more time in the database than in the model).

**What a restarted worker does.** At startup it reads the rows and calls `SessionIndex.restore`, which puts the
sessions back in the list with no events in memory: their ring is empty and `lostThrough` says everything is on
disk. A session that was RUNNING when the worker died comes back `interrupted`, because the loop died with it and
a list still showing it as running would be waiting for an event that cannot arrive.

**The cursor is one counter across every session, not a count per session.** So `restore` advances it past the
saved events; without that, the next live event on a restored session is handed cursor 1, below events the client
has already been sent, which breaks the one thing a cursor promises. This is easy to get wrong because the symptom
is a transcript that repeats its beginning, which reads like a rendering bug.

**Serving a transcript from disk.** `SessionIndex.needsStored` says whether a subscription can be answered from the
ring. When it cannot, the server reads the saved events and, while it reads, holds live events for that
subscription rather than posting them: the client's reducer trusts the contract's order (`reset`, the backfill,
`backfilled`, then live) and a disk read is the one thing slow enough to break it. An event that arrives during the
read is in the ring by the time the backfill is built, so it goes out as part of the backfill and is skipped when
the queue drains — the ring and the disk overlap, and sending an event twice would show the same step twice.

## What a session is CONTINUED from

The saved events are a transcript. Resuming needs the model's own history, and the two are not interchangeable: a
reader wants the steps and their outputs, a loop wants the message array. So a row carries a `history` beside its
events (`SessionHistory` in `session-store.ts`), and `putHistory` OVERWRITES — the newest is the whole of it, and
the older ones are worth nothing.

**It is written from one place per kind, in `sw-sessions.ts`.** `saveChatSession` writes both halves of a chat: the
`ml_session_<hash>` record `ml.resumeChat` rehydrates from, and the row's history. `SAVE_SESSION` (a page's
`{ save: true }` chat) and `sw-chat.ts`'s own `persist` both call it, so the record on disk and the saved session
cannot disagree about what a chat is. `saveRunHistory` writes the one half a run has, at each checkpoint and at
settle.

**Why not the run's own snapshot.** A live run is already mirrored to `ml_bgrun_<runId>` (`persistRun`), and that
looks like the same thing. It is not: that snapshot exists to survive an eviction MID-run, it is deleted the moment
the run settles, and a hydrate rejects one older than `STALE_BGRUN_MS`. Resuming a session is a question asked of a
run that finished yesterday, which is the case the snapshot is built to forget.

**`{ save: true }` now means kept.** A chat that persists itself is a session the store holds, so `saveChatSession`
marks it. The two spellings of "saved" were separate before, which left a `{ save: true }` chat with its record on
disk and no row to hang a history on. A RUN is the other way round: `saveRunHistory` never marks anything, because
whether a run is kept was already answered by `ephemeral` or `persistUiRuns`, and a history must not become a second
way to answer it. A history for a session the store does not hold is dropped.

## Resuming a saved run on another page

`session.resume` makes a saved run live on a tab. It does NOT take a turn: the person's next `session.send` is the
turn, which is why resuming something still running is a `conflict` rather than a no-op.

**It is the cross-page machinery, not a second one.** A run that navigates already re-adopts on the new document:
`_adoptRun(hash, rebuild)` rebuilds the builtin toolset from the carried `RebuildConfig` and registers the run by
hash, and `__mlSessionSend` already routes a message for a registered hash to `agentRegistry` rather than to the
chat path. Resuming reuses all of it. The only thing that was missing is that `RESUME_RUN` reads `bgRuns`, which is
worker memory, so a run that settled yesterday was not in it.

So the worker hydrates `bgRuns` from the saved history before relaying the adopt, and `RESUME_RUN` needs no change
at all. That is why the stored history carries the whole `StartRunPayload` rather than just the messages: the system
prompt, the tool descriptors and the rebuild config are what make a run continuable, and none of them can be
reconstructed from the transcript.

**A page that does not take it leaves nothing behind.** If the adopt is refused or unanswered, the worker deletes
the hydrated `bgRuns` entry and untracks the run, because the next thing to read that map would otherwise believe
that tab owns the session.

**The note is written only after the page has it.** `session-resumed` says where the session is now, where it was,
how long it sat and what it lost — a fact about the session, in the one place a reader and the model both trust, so
a note for a resume that did not happen would be a lie. `RESUME_DROPS` (session-commands.ts) is the list, kept
beside the command that causes the loss so the divider and the model's transcript cannot disagree.

**Its `id` identifies the RESUME, not the session.** The index de-duplicates a note by id, because two surfaces can
report one resume. A note identified by the session would mean a session that moved page twice showed one divider
for both, with the second silently dropped.

**The index rebinds itself.** A resumed run's events reach the worker trusted and carry the new tab, and a
background-hosted session takes its owner from a trusted event, so nothing has to move the binding by hand.

**Where the page offers it.** `resumableHere` (new-session.tsx) decides, and the condition that matters is
`page.tabId` being absent — the index drops it when a tab closes and keeps the url, so that is the tell that the
run has nowhere to live. It is also exactly when `session.send` would end at a closed tab, so the resume REPLACES
the composer rather than sitting beside it: two ways to continue one run is one too many, and one of them would
always fail.

The WHERE picker is one component (`useTargetPick`), shared with the start form. Resuming is a navigation from the
agent's side, so offering it a different set of places to go than a fresh run would be a difference with nothing
behind it. The form has no message box, because resuming takes no turn, and it says what the resume will LOSE
before it happens rather than only reporting it in the transcript afterwards — a person deciding where to resume
wants that first.

**A chat with no page is refused**, and that is not a gap: it is already this worker's wherever it is, and
`sendChat` rehydrates it from storage on its next message. Giving it a tab would give it a page it does not use.

## Which sessions are kept

Three routes to the same flag, and they are not the same question:

- **A command that started the session** (`chat.start`, `agent.start`) keeps it unless it said `ephemeral`. The
  worker decides, from its own command handler.
- **A run this browser's own UI started** (the Commander HUD) is kept when `config.persistUiRuns` is on. The shell
  passes `keep` into `__mlStartAgent`, the run reports its session through the same `_onSession` the chat page's
  commands use, and `sidebar/shell-session-relay.ts` hands the hash to the worker. The run's events do NOT carry a
  `save` flag of their own: that would be fourteen emit sites to keep right instead of one message, in a file that
  is split often.
- **Code** keeps nothing unless it asks: `ml.createChat({ save: true })` as before, and `ml.agent()` not at all.

**A keep request can arrive before the session does.** The hash is minted just BEFORE the run's first event, so the
worker holds a request for a hash it has not seen and applies it when the session appears. Assuming the other order
is easy — `markSaved`'s own docstring assumed it, correctly for the command path and wrongly for this one — and it
fails silently, as a run that simply is not saved.

The request reaches the worker from a page, so the pending set is bounded: a page can name a hash that never
arrives. What it costs to claim one is a session row, which the store's budget already bounds — the same standing
a page's own `{ save: true }` chat has always had.

## This device's own views: the box's panel and the Python bench

The resource panel and the bench are the extension's own UI — they talk to this browser's worker over `chrome.*`,
which `src/chat/` may never do. So the core does not import them. It asks for them, through `ChatExtras`
(`src/chat/extras.ts`), and the entry that has them fills it in (`src/chat-ext.tsx`); the web entry passes none and
the bundle never sees them.

**Each is asked PER RUNTIME, and that is the whole point of the argument.** A resource panel drawn from this
browser's worker describes THIS browser's box; rendering it beside a session running on someone's lab box would be
a lie told confidently. The extension entry answers for the runtimes its `LocalHost` reports and null for the rest,
so a `HubHost` runtime arriving later gets nothing without a line changing here.

**Both are asked twice**, which is the rule the rest of the page follows in a second place:

- the RUNTIME reports the capability (`resourcePanel`, `pythonBench` in `src/sw-sessions.ts`), and
- this DEVICE holds something to draw it with.

A phone reaching the same runtime over the hub reports the same capabilities and draws neither, not because it is a
phone but because it holds no implementation — and nothing in the page asks which it is.

`pythonBench` is MEASURED, not declared: `pythonBundlePresent` (`sw-python.ts`) opens the bundle's own Pyodide core and
the wheel of every start-up package, once per worker life, and the capability is false until it has. The wheels are
gitignored and the build only warns without them, so a declared `true` would offer a bench on a fresh checkout that
then fails with `ModuleNotFoundError: No module named 'numpy'`.

Where they go: the panel is the first tenant of the PANE ON THE RIGHT, which is the shape the state inspector wants
(§The state inspector in the spec), and the bench is a full-width drawer in the grid's second row, as it is in the
sidebar — it is a workspace, not a sidecar of whatever is beside it. The panel's dragged height does not follow it
into the pane: it carries one because in the DevTools panel it fights the session list for room, and in a pane of
its own there is nothing to fight.

Not done: `services().bench` stays false here, so a python code block in a transcript does not offer to open in the
bench. That flag is one boolean for the whole surface, and a session on another runtime would be offered a bench
that runs somewhere else — it wants to become a question about a session before it can be turned on.

## Finding one session among many

Three affordances in the list, all of them only worth having once an agent owns several tabs at once.

**The filter** appears once there are more than four sessions, and stays while something is typed so it never
vanishes under the cursor mid-search. It matches everything a person would use to name a session out loud: the
title, the task it was given, the page it is on, and the runtime it is running on. It looks PAST a folded group —
hiding a match because its runtime happens to be folded would be the list refusing the question it was asked — and
a runtime with no match disappears with its rows rather than leaving a row of empty headings.

**A runtime's group folds**, by id, stored per device. A folded head says how many sessions it is holding, because
folding one should not be the same as forgetting it.

**What moved while you were elsewhere** is marked with a dot (`movedSince`). Deliberately NOT stored: it answers
"what happened while I was here", which is the brainstorming case — you are talking in one session and the run in
the next tab gets somewhere — and not "what is unread", which would mark every session on the device the first time
the page is opened and teach everyone to ignore the mark. A session seen for the first time is never marked, and
reading one IS catching up with it.

**Recent, pinned and older** (`SessionList`, `row-menu.tsx`). The list's default view is the last `RECENT_DAYS` (30)
of each runtime, under a **Pinned** group that spans runtimes, and ends in an "Older sessions" row with a count. That
opens a second view on the same track, which slides in from the right with a back arrow: older sessions by month,
drawn `OLDER_PAGE` (40) at a time as the end scrolls into view. Two rules keep it honest:

- A session that is RUNNING or WAITING is recent however long ago it started. The list never files away something
  that wants you.
- A search covers both views from either one. Searching from the recent list and finding nothing would read as "that
  session is gone" when it is only old.

**A pin is this device's** (`pinned`, `view.pinned`), like the other view prefs. It does NOT protect a session from
the runtime's index cap (`maxSessions`, 300, oldest finished dropped first), so a pinned key whose session is gone draws
nothing and stays stored, in case the session comes back with its runtime. Protecting pins needs the runtime's help.

**A row's `⋮`** (Pin / Delete…) arrives with the pointer in the corner the timestamp used, shows on keyboard focus, and
is always shown on a touch screen. Row and `⋮` are SIBLINGS in `.chat-row-wrap`, because a button cannot hold a button.
The menu is `position: fixed` from the button's rect, because the list scrolls and clips. In calm view a row draws no
timestamp at all: with the menu taking that corner on hover, a hover-revealed time would never be seen, while its
invisible width cut every title short. **Delete** is offered only where `session.delete` may be sent, and goes through
one modal confirmation (`DeleteConfirm`, focus on Cancel). The row leaves when the runtime says the session is gone,
not when the button is pressed. **Rename is absent on purpose**: a title is the runtime's, and a rename kept on one
device gives a session two names on two screens. It arrives with a `session.rename` command.

## Which tab a run is driving

`SessionSummary.page` has carried the URL, title and `tabId` since the index existed, and nothing rendered it: the
header read `Work laptop · qwen3:32b`, which names the machine and the model and not the document being acted on.
On a page whose whole point is that an agent owns several tabs at once, that is the missing half of a session's
identity. The host now sits in the list row and in the header's sub-line, with the title and the full URL in the
tip, because a URL is long and both places ellipsize.

It is deliberately NOT a link. Opening the URL would make a second tab showing the same document, which is exactly
not the tab the run holds, and the contract has no command for bringing an existing one to the front.

**The peek** (`PagePeek`) sends `tab.screenshot` for the session and opens the result in the same full-size view an
image in a transcript opens in. Three conditions, and each one is a real case rather than defensive coding:

- `page.tabId` absent means the tab it worked in has closed — the same tell `resumableHere` reads — so there is
  nothing to capture and nothing is offered.
- The runtime must report `capabilities.screenshots` and this client must hold the `screen` scope.
- The browser can only capture the tab its window is SHOWING. A run working in a background tab is refused with
  `conflict`, and the store puts the runtime's own sentence on screen. Capturing it anyway would mean attaching the
  debugger, which puts a banner on someone's display for a remote look; `src/session-commands.ts` refuses on
  purpose, and the demo world keeps the rule so the UI is developed against it.

## Calm view, and the list pane

Two device preferences, both in `view-mode.tsx`, both stored through `ClientPlatform.prefs` and seeded by the entry
before the first render so the page never paints one mode and then the other.

**Calm is the default, and it is why this page exists.** The DevTools panel's transcript rendered at page scale is a
log viewer: a step counter on every turn, a model pill, a raw-argument toggle, a token footer, a hash in the
header's most prominent corner. None of that is wrong in a 360px drawer beside the page being driven — it is what
someone debugging a run came for. It is wrong in a tab someone is thinking in.

Calm sets `data-focus`, the same root attribute the panel's own focus mode uses (`src/sidebar/prefs.ts`), and then
`chat.css` adds what only a whole page needs: a reading measure (`--read`), a bubble for your own turn and no
container at all around the reply, and provenance that appears under a pointer instead of sitting above every
paragraph. The brain glyph is the panel's, deliberately: same idea, different default.

Three rules it follows:

- **Everything is a hide, never a restructure.** The document is the same one the export, the search and the toggle
  see, which is the standing rule that a run's raw, model-facing view may be quiet but never unavailable
  (AGENTS.md §Showing a run). The approval gate never quiets, because it is the one thing in a transcript that is
  waiting on a person.
- **The page reads its OWN preference, not the panel's `focusMode`.** They share an origin, so writing that signal
  from a tab would silently reconfigure the DevTools panel docked beside a page. The two chat entries call
  `installViewPrefs` where they used to call `applyFocus`.
- **Hover-reveal lives behind `@media (hover: hover) and (pointer: fine)`.** The same rules on a touch screen would
  hide the timestamps, the copy button, the counters and the hash with no gesture that brings any of them back, so
  a phone gets them dimmed and a mouse gets them on demand.

**What calm does one level in**, all of it CSS over the same document:

| | |
| --- | --- |
| a tool step | no chevron (the row is the button and its cursor says so), no `In:` / `Out:` labels, no `rendered \| raw` switch, no `Out` at all while it waits on a person, no rail while it is collapsed, room between what ran and what came back, and the pointer and the clock on one line |
| a step opening | animates from `height: 0` to `auto` (needs `interpolate-size`), so a long body does not shove the page down in one frame. The close is not animated: the component unmounts the body, and keeping every step's body mounted for a whole run to animate its removal is an expensive way to buy a fifth of a second |
| a dataframe | its controls appear when the pointer is on the table, bottom right — the top left is where the column names are |
| a citation | the tip belongs to the CAPTION, not the whole embed: an embed is something you read, and a tip that fires anywhere over it explains the frame on top of the contents. The link form drops the accent colour for the citation green under ordinary text |
| a reply | copy and the timestamp move UNDER it (they are what you want after reading, not on the first line), the status dot goes unless it is saying something other than "this worked", and the collapse control moves into the gutter |

**NO HEADER BAND on the wide layout.** What a header held has gone where each part belongs, because the four
things in it had four different scopes and only one of them was about the page:

- the session's TITLE, the runtime, the model and the page are the transcript's first line (`.chat-lede`) — there
  when you arrive, gone as soon as you scroll, which is exactly as long as they are worth the room;
- the `☰` is navigation, so it floats at the edge a list pane lives on;
- the view toggle, the box and the bench are the PAGE's tools, so they sit behind one mark in the bottom right,
  in the composer's row. Not floating over the transcript: a cluster there would fight a table's own controls,
  which sit in that corner of that table. Everything that ends in that corner (the composer, its footer, a form's
  last row) keeps clear of it, because a cluster over a `Resume` button is a cluster that eats the click.

A phone keeps its header: it holds the way back, and there is no room to float anything over a 390px column.

**What hides, and what does not.** Anything you go LOOKING for stays put — the toggles, the reply's copy, the
composer's counters, quiet but present. Only what belongs to a thing you are READING arrives with the pointer: a
table's controls, a code block's, a citation's tip. The rule exists because five separate hover-reveals turn
finding a control into a memory game.

**The page chip brings its tab to the front** where the device can reach it (`ChatExtras.focusTab`). That one wants
to be a CONTRACT COMMAND rather than a device capability — a phone driving a browser over the hub has every right
to say "show me that tab", and the runtime is what would act on it — so the member is a local stand-in with an
expiry date on it, noted in `extras.ts`.

**The list pane hides** (Gemini's move): the pane stays mounted and slides, so its scroll position survives, the
grid column animates rather than the body jumping a column's width, and `visibility: hidden` takes it out of the
tab order while it is off screen. Only on a wide layout — a phone shows one pane at a time either way, so there the
list is a screen you go back to. The way back is a `☰` in the header of whatever pane is left, including the empty
one, because a control that moves when nothing is open is a control you hunt for.

## Not yet

- `CompositeHost.events` attaches to the host that owns a runtime when it subscribes, and does not move if a
  higher-priority host reports that runtime later.
- The panel's tooltips (`cursorTipOn`) are pointer-only, so on a touch screen their prose is unreachable.
