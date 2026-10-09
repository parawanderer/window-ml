# Site access: which pages may use `window.ml`

The design and its reasons are `docs/spec/SITE_ACCESS.md`. This is how the built parts work and where to change them.

## The gate

Every message a web PAGE can make the background receive is listed in `src/page-relay.ts`: the `HANDLE_MAP`
request/response pairs the content script relays, and `PAGE_RELAYED_EXTRA` (a page's own cancel, its abort of a
request, and the shell's forwards of the page's own debug and session events). `PAGE_STARTED_TYPES` is their union.

`background.ts`'s `onMessage` listener runs `pageRefusal` (`sw-site-access.ts`) for any of those types arriving from a
tab that is not one of the extension's own frames, then hands the message to `route()`, the router that used to BE the
listener. Refused: the sender gets `{ error: "Refused: …" }`, including for a fire-and-forget type. Allowed: a handler
that answers asynchronously keeps the channel; one that never answers gets `sendResponse(undefined)`, so a content
script's promise settles. The streaming port (`LLM_STREAM`) checks the same gate as a `FETCH_LLM`.

`pageRefusal` reads only `sender` (`origin`, `url`, `frameId`, `tab`), which the browser sets:

1. A tab hosting a live background run (`activeRuns`) may send `RUN_TAB_TYPES` (page-relay.ts) from its top frame,
   whatever its origin: what that run's delegated tools send while they still run in the page (a vision tool's model
   call and screenshot, `fetch_url`, `python_exec`, a sheet, a server tool, a shadow resolve, the config a vision tool
   or an exec reads). An isolated exec sends none of them: its `ml` has nothing that sends. Never run control, a model change, an unload, a session, an embedding or a dump. The list
   shrinks as slice 2 moves tools to the worker, and goes with the last one. It is also why a run on a local `file:`
   page keeps working.
2. Otherwise the sender must be grantable (`grantableOrigin`: top frame, http(s), not opaque) and its origin approved
   (`decide`), or, over https only, its host on `pageApprovalDomains`.

**A page's screenshot is of its own tab, or nothing.** `CAPTURE_TAB` goes through the debugger by tab id when CDP is
on; otherwise `captureOwnTab` (`sw-capture.ts`) takes `captureVisibleTab` only while the sender's tab is the one its
window shows, and throws the shot away if the window showed another tab while it was taken. `captureVisibleTab` takes a
window, not a tab, so before this a page in a background tab was handed the pixels of the tab in front of it.

**A run's own screenshot, taken by the worker** (`captureRunTab`, `sw/worker-vision.ts`; the verify after an action uses it): the
debugger by tab id when CDP is on, bounded at 5 s since a tab in the background may never paint, then `captureOwnTab`,
which refuses a tab that is not showing. The worker never switches tabs to take one. `workerShot` pins it to the top
frame's document (`webNavigation.getFrame` before and after, and any commit on the tab during it, refuse it) and masks
the extension's own UI out in the worker, changing nothing on the page (`docs/dev/sidebar.md`, "Keeping the extension
out of a shot"). The worker's vision host asks the page for layout only, through one checked protocol
(`docs/dev/agent-tools.md`, "The worker's vision host").

**A page's answer cannot carry a picture, a reply or a spend into a worker-built run.** For a run the worker built or
was handed (`makeWorkerRun`, mid-turn included), the run host drops `image`, `imageLabel`, `images`, `feedback` and
`subUsage` from every page envelope (`withoutPageVision`, `sw/worker-verify.ts`), so a page can neither show the model
a picture as the page's screenshot nor inflate the run's spend. `look` and `locate` are exempt until they move to the
worker (part 3, PRs 6 and 7). The verify after a click, type, wait or navigate is the worker's
(`docs/dev/agent-tools.md`, "The worker's vision host").

**The shell is not the page, but the browser cannot tell them apart.** The content-script shell's messages arrive with
the page's tab and origin, so anything it sends under a page-startable type is refused on an unapproved site. It sends
its own types instead (`USER_START_RUN`, `USER_RUN_ACTION`, `USER_PYTHON_PREWARM`, `CANCEL_RUN`), and
`tests/redteam.test.js` scans `sidebar/shell.ts` for any page-startable type it sends.

**A page-built run whose page may not drive it is handed to the worker.** A person's follow-up or Continue for a run
a PAGE built goes to the page while that page's site may use window.ml. Once the tab is on a site that may not (the
run navigated off its builder's origin), `userRunAction` hands the run to the worker (`makeWorkerRun`) instead of
leaving it to a refused `RESUME_RUN`.

## The lists

`site-access.ts` is pure: `originOf`, `grantableOrigin`, `decide` (a denial beats an approval), `applyEdit`,
`originFromInput`. `sw-site-access.ts` keeps them in storage, under `SITE_ACCESS_KEYS`: `always` and `denied` in
`chrome.storage.local`, `session` in `chrome.storage.session`. Read on EVERY gated message, so a revoke applies to the
next call with no reload.

Edits arrive as `SITE_ACCESS` messages, answered for extension pages only (`isExtensionSender`). Two editors:
DevTools Settings → Permissions → "Sites that may use window.ml" (`SiteApprovals`, the full list) and the toolbar
popup's "This site" block (the current tab's origin, read from `chrome.tabs`, never a title the page set). An approval
that only the self-approval whitelist implies is reported `implied`, and the popup offers no Revoke for it: the
whitelist is edited in Settings.

## The page's cancel

The content script relays a page's `CANCEL_RUN_REQUEST` as `PAGE_CANCEL_RUN`, not `CANCEL_RUN`. The shell's Stop button
sends `CANCEL_RUN` from the same content-script world, so without its own type the gate could not refuse a page's
cancel without refusing the person's Stop. A run the worker built cannot be cancelled by a page at all.

## The run's events, and the extension's own iframe

A run's events go from the worker to the tab's SHELL over `chrome.runtime` (`ML_DEBUG_TO_PAGE`); `content.ts` no
longer re-posts them on the page's window, and the shell treats every window message as the page's, whatever it
claims (`__mlFromBg` means nothing now). The sidebar app in the card or overlay talks to the shell over a private
`MessagePort` (`src/sidebar/parent-channel.ts`, `openHostPort` in the shell): the app sends a nonce with
`chrome.tabs.sendMessage`, which reaches the tab's content scripts and never the page, and accepts only a port posted
back with that nonce. Attacks 15 and 16 in the spec are what each closes.

A page still sends its own session events (a run or chat it hosts). What it may add to a session the worker speaks for
is `pageMayWrite(kind, claim)` (`src/event-admission.ts`): nothing for a run the worker built (`owns`), only `agent`,
`agent-say` and `agent-result` for a run the page built that the worker hosts (`hosts`), anything for a session the
worker has no part in. The shell answers `claim` from the worker's events it has seen on the tab; the worker, before
the index or a DevTools panel (`workerClaimOf` in background.ts), from `isWorkerRun`, `bgRuns` and the index. A
background session whose run the worker no longer holds counts as `owns`. The shell claims a run before its id reaches the
page: `ADOPT_RUN_NOW` and `RUN_TOOL_IN_PAGE`, which content.ts relays to the page with the id, reach the shell in the
same dispatch first (`claimForWorker`). And if the page still wrote to a session before the worker's start arrived,
the shell has the app drop that session when it does (`dropPageSession`, `__mlForgetSession`). Attack 15d is the race. `DUMP_EVENTS` (`ml.__events()`) gives a page
only the buffered events of sessions it is not shut out of.

## Tools of a worker-built run that run in the worker

A builtin tool that never reads the page runs in the worker for a run the worker built (`WORKER_TOOL_NAMES` in
`src/sw/worker-tools.ts`), so what it reads never enters the page's world: the same tool from the same factory, given
an `ml` the worker answers. Today: `fetch_url`, through `fetchUrlFor` (`sw-fetch-url.ts`) with the run's tab as an
untrusted caller. Its approvals are the RUN's (`grantRunFetch`: the consent and the one-time as-you grant live in the
run's worker state, never on the tab), so no script on the tab can spend them through its own `FETCH_URL`, which it
may still send (`RUN_TAB_TYPES`); after an eviction they are rebuilt empty, and a call then asks again. Its Markdown comes
from the offscreen document (`HTML_TO_MD`) and its reader's model call is metered as the call's `subUsage`. The one
`fetch_url` still answered by the page is a session render of the page the run is on, from its own live DOM. A
read-only survey re-reads the run's fetches from the worker's cache (`_fetchCached` in `worker-readonly-ml.ts`), and a
miss defers to the page's. Both caches hold frozen copies (`cacheCopy`), so a survey cannot rewrite what a later
re-read shows. `RUN_TAB_TYPES` keeps `FETCH_URL` until approved exec is isolated (part 4): an approved script's inline
`ml.fetch` and a page-built run still send it.

`python_exec` runs there too, unless it needs the page (`image`, a page table by selector, `current`):
`pageOnlyPython` sends those to the page as before. In the worker its tables load without a DOM (a table by value, a
URL the run's fetch_url read, an external sheet), and the call goes through `runPython` (`sw-python.ts`) with the run as
the caller. Its approval is the run's CALL grant (`grantRunPython`: the external sheet ids, the full-mode code), set
around the one call and never on the tab, so a page cannot read the sheet with the person's cookies or run the approved
full-mode code itself while it runs. Live stdout goes straight to the call's output.

`agent_api_docs` runs there too (`apiDocsTool` in `src/tools/api-docs-tool.ts`, given a `DocsSource`): the worker reads
the live shortcut (`invocationInfo`, `sw-invocation.ts`) and the config itself, so `GET_INVOCATION` left
`RUN_TAB_TYPES`. `GET_CONFIG` stays until the vision tools move (part 3). Its within-dig dedup memory is the worker's,
keyed by the run's local tools, so `runLocalTool` counts each call the page runs towards its streak (`countDocsStreak`),
which the page's `executeTool` used to do; a read-only try counts on neither side.

`answer` runs there too, and the run's curated answer set lives there (`src/sw/worker-answer.ts`, kept in session
storage, so an eviction or a navigation mid-turn does not lose it). The tool is the page's descriptor with the shared
core (`answerCall`, `answer-set.ts`); only a `selector` asks the page, which resolves it in its DOM and returns a
preview and crops (`answerSelect`). An approved exec in the page's world, and a read-only survey that reaches the page,
is sent the set's SHAPE (`answerShape`: kinds and an element's preview, never a text's content or an output's ref or
caption) and given
an `AnswerLog`, which answers `.length` and indices at once and records what the script changed; the worker replays it
(`replayAnswerOps`). That report is the page's, so it is checked for shape and size, refused whole if any operation
is malformed or the set would pass its bounds, and a removal by text matches only what the same report added (as the
script's own view did), so it cannot probe a hidden item. A selector's answer from the page is rebuilt field by field
(`checkSelection`), and the model's note for it never leaves the worker. It can change only the person-facing answer, which a script in that world could already do. The page's
answer at `finish` is ignored for a worker-built run.

## Where an approved exec of a worker-built run runs

`delegateTool` (`sw-run-host.ts`) asks `routeExec` (`src/sw/exec-routing.ts`) before it mints any grant on the tab. The
rule is pure, and its tests enumerate every input (`tests/isolated-exec.test.mjs`):

- A plain script on an approved page: the page's main world, full parity.
- A script naming `ml.current` or a pointer (read lexically by `execNames`; a miss fails closed, since an unnamed
  read is not sent and the main world has no `ml.current`), or any script on a page that is not approved: an
  isolated world (`runIsolatedExec`, `src/sw/sw-isolated-exec.ts`). That is `chrome.userScripts.execute` in the run's
  world `wml-<runId>` when the person has allowed user scripts, else a CDP isolated world when the CDP setting is on.
- Neither available: refused on an unapproved page and for `ml.current`; a pointer script on an approved page runs in
  the main world with a note (owner's decision).

The isolated script runs inside one wrapper built as source (`isolatedWrapper`): it binds `ml` (`current` deep-frozen,
`dereference` answering only the reads sent with the call), captures the console, and returns plain data. Live lines
come back through `chrome.runtime.onUserScriptMessage` (reachable only from a world this extension configured), checked
against the run's tab, the top frame and the call's nonce, or through a CDP binding added with `executionContextName`,
so only that world has it, checked against the world's context id. The route is decided for one document (read
before its URL, so a navigation in between fails the send rather than redirecting it) and every send is pinned to it. Every decision is in the execution log
(`subsystem: routing`, `kind: exec-main|exec-isolated|exec-refused`, `detail.how`).

## What the content script sends outside the gate

Four types the content script sends on a page's word are not in `PAGE_STARTED_TYPES`, so the origin gate passes them
and each handler checks the sender itself. `tests/redteam.test.js` (section "UNGATED") pins the list.

- `CONTENT_READY`: answers with the rebuild of runs on the sender's tab, and replays a run's history to the tab once per
  document (`replayedTo`). A page can resend it whenever it likes by posting `PAGE_ADOPT_HELLO`. The reducer also drops
  a step without a `seq` that it already holds (same step, time, thought and tool).
- `RUN_READOPTED`: releases the nav barrier only during a navigation, only from frame 0, and never from the document
  the navigation is leaving (`navBarrier.accepts`). The current document is the browser's report
  (`webNavigation.onCommitted`), never `CONTENT_READY`, which the departing page could resend. The page info is stored
  with its document, and the call that navigated drops it if it came from the document the call went to
  (`documentOn` in sw-run-host.ts, which asks `webNavigation.getFrame` after an eviction).
- `PAGE_TOOL_STREAM`: only from the run's own tab, frame 0.
- `VALUE_COLUMNS`: the run's own tab, and for a worker-hosted run only a key sent with its in-flight call (part 1c).
  `DEREF_TOKEN` is gone.

## Read-only surveys of a run the worker hosts

A survey is evaluated in the worker first (`tryReadonly` in `sw-run-host.ts`), where the run's pointers and
`ml.current` live and no page exists. Only a survey that reaches for the page goes there, and the page leg refuses
every pointer read (`run-delegation.ts`), so a survey needing both reaches the person. An approved `exec` is sent the
values of the pointers its script names, resolved in the worker (`named-reads.ts`), and its page-side resolver
answers only those; `DEREF_TOKEN` is gone. `VALUE_COLUMNS` reads a stored table for a worker-hosted run only for a key
sent with its in-flight call. Where each survey went
is in the execution log (`routing`, `readonly-worker`/`readonly-page`). `docs/dev/readonly-exec.md`, "Where it is
called".

## Adding a tool, a member or a message

The red-team pass AGENTS.md requires. Run it as its own agent, told to find where a property does not hold rather
than to review; each gap it finds becomes a test titled by the property, failing before the fix. The threat is a page
that shares the main world with `window.ml` and with any tool code run there, posts any window message, reaches the
extension's open shadow roots, and knows every run id. Cover:

- **Where it runs.** A tool run in the page puts its inputs and results into the page's world. Prefer the worker; if
  it must run in the page, name what of the run it puts there (another site's content, a pointer's value, the system
  prompt) and why the page may see it.
- **What it sends while it runs.** Each page-started type it needs joins `RUN_TAB_TYPES`, which any script on a run's
  tab may then send whatever its origin. Test that type sent by the page itself, outside the tool.
- **What the page can forge.** Its result (`PAGE_TOOL_RESULT`) and its live lines: a forged one may misreport only the
  page's own content, never another site's or the run's.
- **An `ml.*` member.** Refused from an unapproved origin is automatic (the red-team suite enumerates `HANDLE_MAP`).
  On an approved page: does it spend tokens, change config, or read across origins, tabs or runs? If it is read-only,
  it goes in the dialect too, with the dialect rule's tests (`docs/dev/readonly-exec.md`), and is placed in or out of
  the worker facade on purpose.
- **A message type.** In `PAGE_STARTED_TYPES`, or sent by the content script outside `HANDLE_MAP`, where its handler
  must bind it to the sender itself (the run's tab, frame 0, the document) and the UNGATED ratchet lists it.
- **A blocked case.** If a safety classifier stops a test, stop on that case and hand it to the owner, whose other
  model writes the test; this side writes the defence.

## Tests

- `tests/site-access.test.mjs`: the pure rules.
- `tests/event-admission.test.mjs`: `pageMayWrite` over every event kind the contract defines, for each claim.
- `tests/run-start.test.mjs`, section "what a page may add to a run the worker built": the worker's half, against the
  bundle.
- `tests/run-start.test.mjs`, section "where a read-only survey of a worker-built run is evaluated": the routing and
  its log, against the bundle.
- `tests/redteam.test.js`, section "(f)": every page-started type refused from an unapproved origin with nothing
  reaching the backend, a tab or the screen; on a tab hosting a run, only `RUN_TAB_TYPES` allowed, every other type enumerated; a
  sender that can never be granted refused even when its host is approved; revoke and deny without reload; a page
  cannot edit the lists; the stream port.
- `tests/e2e/site-access.spec.mjs`: the hostile site, against a real browser.

The vm harness approves a test sender's origin unless `loadBackground({ siteGate: true })`, and gives a URL-less test
sender a page at `https://page.test/`, because a real content script always has one. The e2e harness's `waitForMl`
approves the page's origin unless `{ approve: false }`.
