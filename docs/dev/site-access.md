# Site access: which pages may use `window.ml`

The design and its reasons are `docs/spec/SITE_ACCESS.md`; what a page may see of window.ml at all is `docs/spec/SITE_PRESENCE.md`. This is how the built parts work and where to change them.
Slice 3 is being built from its implementation reference, [../spec/SITE_ACCESS_SLICE3.md](../spec/SITE_ACCESS_SLICE3.md):
its PR 1 (the levels in storage, the self-approval list by origin, the upgrade) is in "The lists" below, and its PR 2
(the agent level enforced, and the start card) in "Starting agents"; `requestAccess` and the badge are not built yet.
What has been checked about the page-facing surface, what has not, and the plan: [security-audit.md](security-audit.md).
What a page can observe of window.ml installed and acting in it, measured per tool: [detection-surface.md](detection-surface.md).

## The gate

Every message a web PAGE can make the background receive is listed in `src/page-relay.ts`: the `HANDLE_MAP`
request/response pairs the content script relays, and `PAGE_RELAYED_EXTRA` (a page's own cancel, its abort of a
request, and the shell's forwards of the page's own debug and session events). `PAGE_STARTED_TYPES` is their union.

`background.ts`'s `onMessage` listener runs `pageRefusal` (`sw-site-access.ts`) for any of those types arriving from a
tab that is not one of the extension's own frames, then hands the message to `route()`, the router that used to BE the
listener. Refused: the sender gets `{ error: "Refused: …" }`, including for a fire-and-forget type. Allowed: a handler
that answers asynchronously keeps the channel; one that never answers gets `sendResponse(undefined)`, so a content
script's promise settles. The streaming port (`LLM_STREAM`) checks the same gate as a `FETCH_LLM`.

`pageRefusal` reads only `sender` (`origin`, `url`, `frameId`, `tab`), which the browser sets: the sender must be
grantable (`grantableOrigin`: top frame, http(s), not opaque) and its origin allowed (`levelsFor(...).use`), which an
origin on the self-approval list also is ("The self-approval list", below). A tab hosting a run gets nothing more (part 5). Until then it was lent what the
run's in-page tools sent (`RUN_TAB_TYPES`: a vision tool's model call and screenshot, `fetch_url`, `python_exec`, a
sheet, a server tool, a shadow resolve, the config); every one of those tools now runs in the worker, or asks the page
only for plain data about itself (below), so a run's page sends nothing for it. A run on a local `file:` page needs
nothing either.

**An error a page or the model reads names no secret of the config.** The worker's errors are written for the person
("Couldn't reach the server at <url>", "HTTP 500 from <url>: <body>", "blocked by the model filter (/<regex>/)"), and
`GET_CONFIG` withholding the URL, the key and the filter meant nothing while those reached the page as `{ error }`. The
rule is in one place, `src/secret-scrub.ts` (`secretsOf`: the chat URL as configured, its origin and its host, the price
service's URL, the key, the filter), applied at the two crossings by `src/sw/sw-scrub.ts`: `forPage` on every answer
to a page-started message and on the stream port's error (every `error` string at any depth; a data field is the
handler's answer and is left alone), and `forModel` on every step result a worker-hosted run's model reads, applied
once in the shared loop after the step settles (`forModel` in `agent-loop.ts`: a tool's answer, a read-only try, a
precheck, a dispatch that threw, a denial), which records the raw text in the execution log's `key` (`tool`/`scrubbed`). Extension pages (the popup, the DevTools panel, Settings) are answered unscrubbed: they are where
a person diagnoses a wrong URL. `SET_MODEL`'s unknown-model error lists only the models the filter allows.
The forms (`secretsOf`): the URL, its origin, host and host name (as typed and as parsed, any letter case; not a dotless
or loopback name such as `ollama` or `localhost`, which are ordinary words), each also JSON-escaped and percent-encoded;
the key only from 12 characters (a shorter one is a placeholder like `ollama`); the filter in its error form `(/re/)`,
and bare only when it holds a regex character other than `.` (else it is a model's name). A quoted backend body is cut
clear of a secret (`clipClear`), never through it. Every key ending in `error` is scrubbed (`transportError` too). The
settings a change replaced stay scrubbed while the worker lives, for a request in flight across the change, and a
resumed history crosses `forModel` once before its first model call (a session saved before the scrub).
`tests/error-scrub.test.mjs` walks every page-started type under each backend failure.

**A page's screenshot is of its own tab, or nothing.** `CAPTURE_TAB` goes through the debugger by tab id when CDP is
on; otherwise `captureOwnTab` (`sw-capture.ts`) takes `captureVisibleTab` only while the sender's tab is the one its
window shows, and throws the shot away if the window showed another tab while it was taken. `captureVisibleTab` takes a
window, not a tab, so before this a page in a background tab was handed the pixels of the tab in front of it.

**A run's own screenshot, taken by the worker** (`captureRunTab`, `sw/worker-vision.ts`; `look`, `locate` and the verify after an action use it): the
debugger by tab id when CDP is on, bounded at 5 s since a tab in the background may never paint, then `captureOwnTab`,
which refuses a tab that is not showing. The worker never switches tabs to take one. `workerShot` pins it to the top
frame's document (`webNavigation.getFrame` before and after, and any commit on the tab during it, refuse it) and masks
the extension's own UI out in the worker, changing nothing on the page (`docs/dev/sidebar.md`, "Keeping the extension
out of a shot"). The worker's vision host asks the page for layout only, through one checked protocol
(`docs/dev/agent-tools.md`, "The worker's vision host").

**A page cannot start a run that claims the worker built it.** `startBackgroundRun` (`sw/sw-run-host.ts`) strips
`builtBy`, `rebuild.builtBy`, `display` and `origin` (the PromptOrigin) from a page's START_RUN payload (`pageStartPayload`) before `hostRun`, so only
the worker's own `hostRun` call (`sw/sw-run-start.ts`) and `makeWorkerRun` make a run the worker's. The run host branches
on `builtBy` for tool routing, grants, vision, the answer and what it stores, so a page's claim would get all of them.
`pageOrigin` and `pageUrl` are replaced by the sender's (the origin the origin gate read, and the top frame's URL): the
origin seeds the run's consented origins and the URL is "the page you are on", so a page naming another site would get
navigations and reads there without a gate. `maxSteps` goes through `stepBudget`, as on RESUME_RUN (a whole number up to 200, otherwise the loop's default), so a page cannot ask for an unbounded run, and a dropped `origin` means a page cannot stamp its prompt as typed on an extension surface such as the HUD. A page's payload may ask for more gating, never less: the auto-approve
flags (`autoApprovePython`, `autoApproveReadonly`, `autoApproveSameOriginAuth`, `autoApproveSelfSource`) and
`selfIntrospection` hold only when the worker's config allows them too, and a builtin tool that asks for approval
(`GATED_TOOL_NAMES`, the tool registry's `gated`) or a server tool (`remote`) always does, whatever `requiresApproval` the page sent. A run id
another tab holds, running or settled, is refused. `approvalRouting` stays the page's: it changes only where its own
run's gates are shown (`"external"` hides the buttons and waits on the worker-realm `__mlApprovals` channel), never
whether they block.

**A run-control payload is checked whole before anything reads it.** `route()` runs `runControlPayloadError`
(`src/sw/run-payload-check.ts`) on every `RUN_CONTROL_TYPES` message first: each field the worker reads has the type it
is read as (every `StartRunPayload` field but three left to their readers: `maxSteps` to `stepBudget`, `approvalRouting`,
whose unknown value reads as "ui", and the rebuild's vision facts to `run-vision.ts`; RESUME_RUN's `runId` and `task`;
INJECT_MESSAGE's and PAGE_CANCEL_RUN's), every list is bounded (`RUN_PAYLOAD_LIMITS`), a run id is a short token, and
no object at any depth has an own `__proto__` key. A field it does not read is left alone, so a new field the run host
reads goes into the checker with it. Behind it, `hostRun` undoes the turn's registrations (controller, inbox, tab,
snapshot, turn) when its setup throws (`settle`), and the listener answers a page whose handler threw. A START_RUN or
RESUME_RUN naming a run whose turn is live **or still starting** is refused (`startBackgroundRun`), so a second turn never replaces the
controller the person's Stop reaches, and a PAGE_CANCEL_RUN acts only on a run its sender's tab owns (its live
controller, its snapshot, or its start registration), as INJECT_MESSAGE
does.

**A page's answer cannot carry a picture, a reply or a spend into a worker-built run.** For a run the worker built or
was handed (`makeWorkerRun`, mid-turn included), the run host drops `image`, `imageLabel`, `images`, `feedback` and
`subUsage` from every page envelope (`withoutPageVision`, `sw/worker-verify.ts`), so a page can neither show the model
a picture as the page's screenshot nor inflate the run's spend; no tool is exempt. The render slots lose their pictures
too (an `image`, `look` or `locate` descriptor is dropped, Python's In and Out lose `image`): the loop keeps a step's
picture as its pointer's image, and `look` at that pointer would show a reader the page's picture as an earlier capture. The verify after a click, type, wait
or navigate is the worker's, and so are `look` and `locate`: the page is never sent the call, only the target for a
preview, and the run's adopt names it no model (`docs/dev/agent-tools.md`, "The worker's vision host").

**The shell is not the page, but the browser cannot tell them apart.** The content-script shell's messages arrive with
the page's tab and origin, so anything it sends under a page-startable type is refused on an unapproved site. It sends
its own types instead (`USER_START_RUN`, `USER_RUN_ACTION`, `USER_PYTHON_PREWARM`, `CANCEL_RUN`), and
`tests/redteam.test.js` scans `sidebar/shell.ts` for any page-startable type it sends.

**A page-built run whose page may not drive it is handed to the worker.** A person's follow-up or Continue for a run
a PAGE built goes to the page while that page's site may use window.ml. Once the tab is on a site that may not (the
run navigated off its builder's origin), `userRunAction` hands the run to the worker (`makeWorkerRun`) instead of
leaving it to a refused `RESUME_RUN`.

**A page-built run that navigates onto a site that may not use window.ml is the worker's from that commit**
(`src/sw/nav-handover.ts`, part 5; owner's decision 2026-10-10). `handOverOnCommit` runs at the browser's
`webNavigation.onCommitted` for the tab's top frame, which no page can stop or fake, and hands every page-built run on
the tab (live, or settled and resumable there) to the worker when the new URL is not approved (`pageApproved`: an
unreadable URL, a sender that can never be granted, or an origin not on the lists). The destination's `CONTENT_READY`
asks again from its own sender URL (a worker that missed the commit) and waits for the decision, so the re-adopt it
answers is the worker's (`pageRebuild`: no model, no vision fact), and every tool send of the run waits for it too
(`handOverSettled` in `sendTool` and `delegateTool`). The run host reads who drives a run at each decision
(`byWorker()`), never from `p`, the turn's start payload, so the rest of a turn handed over in its middle runs as a
worker run: its worker tools, the run's grants, its answer set, isolated exec, worker vision, and the lifecycle events
the page-side caller can no longer fan. One way: a run back on an approved site stays the worker's. Each hand-over is an
execution-log record (`routing`, `handed-to-worker`, reason `navigated-to-unapproved-site`, the origin).

**A page-built run whose site is revoked while it runs is the worker's from the revoke** (owner's decision 2026-10-12),
with no navigation. Every path that takes a site off the approved set writes storage: the popup and DevTools Settings
(`SITE_ACCESS`: revoke, deny, an approval for the session revoked, an origin removed from the self-approval list), and
another surface writing the lists (`chrome.storage.onChanged`, local or session area). `background.ts` listens to `onChanged` for those keys (`changesSiteAccess`) and calls
`handOverOnRevoke`, which decides every tab holding a page-built run from the URL its top frame shows now
(`webNavigation.getFrame`) and hands the runs on a tab that may no longer use window.ml to the worker (reason
`site-revoked`). `SITE_ACCESS` awaits the same decision before it answers the editor, and a worker that starts decides
once after it restores its runs, for a change made while it was evicted (reason `site-not-approved` when it cannot tell
a navigation from a revoke). Nothing the page sends is read, so it cannot stop or delay the decision.

Every send of the run decides again first: `handOverSettled` checks the top frame's URL against the lists on each tool
send, so a revoke whose storage event has not arrived yet, or arrived at a worker since evicted, is decided before
anything reaches the tab. A call built for the page (`pageRouted`, its exec routed to the main world with its pointer
reads) whose run is handed over before it is sent is not sent: `sendTool` and `delegateSend`'s `beforeSend` throw
`HandedOverMidCall`, and `againIfHandedOver` builds the call again as the worker's (an exec naming a pointer goes to
an isolated world or is refused on the now unapproved page). `beforeSend` decides again from the lists after every wait
`delegateSend` makes (a navigation's barrier, which the page can hold, or a tab rebuilt), and the send follows it in the
same turn, so a revoke whose storage event has not been acted on yet is still seen. A call already on the page at the
revoke finishes there, and its answer is held to the worker's rules (`withoutPageVision`); a `VALUE_COLUMNS` read the
page makes during it is refused, since a stored table's columns go only to a page on an approved site. The page's own
`START_RUN` (or `RESUME_RUN`) for the turn is answered with an error and no result or history (`handedThisTurn`): it
is still waiting on that answer after a revoke, since no navigation took its document away.

A run the worker holds when its turn ends (built by it, or handed it) sends its tab a finish (`RUN_TOOL_IN_PAGE` with
`finish`) that carries the run id and nothing else: the page ends the run's registration and answers nothing the worker
reads, since the turn's answer is the worker's set (`worker-answer.ts`). Until #625 it carried the turn's `summary`,
which content.ts posted on the page's window, so a page the run was handed away from read its answer. content.ts and
the page no longer relay a `summary` with a finish at all. The other messages at the end of a turn carry no run
content to the page's world: the run's events (`ML_DEBUG_TO_PAGE`) go to the shell only, and a re-adopt names the
tools and flags of a worker's run with no model (`pageRebuild`). The finish is sent and not awaited: a page that never
answers it would otherwise hold the run's result and its next turn for as long as content.ts waits (two minutes).
`tests/worker-held-page-messages.test.mjs` checks every message to such a run's tab, by type, against what it may
carry; a new message type fails there until it is classified. A DevTools composer message for a run the worker holds
goes to no page, also when it comes from the panel of another tab (`ML_SESSION_REMOTE`).

The decision outlives the worker: `makeWorkerRun` stores the run id under `ml_handed_to_worker` at once (the run's own
snapshot is rewritten only at its next checkpoint), `hydratePersistedRuns` applies the list over the restored
snapshots, and `deleteRun` drops a run from it when its snapshot goes. A restore stores the list again without the ids
whose snapshot is gone (a settled run handed over has none, and a stale one is dropped), so a later page-built run
under the same id is never handed over by an old entry. Past `HANDED_MAX` entries, only those of runs the worker no
longer holds (no snapshot, loop or cross-page record) are pruned; a held run's entry is never dropped. One way:
re-approving the site leaves the run the worker's, and the page's `RESUME_RUN` for it is refused. `startBackgroundRun`
awaits `hydrationDone` and asks `isWorkerRun` again before it takes a page's `START_RUN` or `RESUME_RUN`, so a message
that wakes the worker is judged against the restored runs, not the empty maps the router saw. The wait is bounded
(`RESTORE_WAIT_MS`) and closed: past it the page is refused (`RESTORE_PENDING`), never judged against empty maps.

## The lists

`site-access.ts` is pure: `originOf`, `grantableOrigin`, `levelsFor`, `applyEdit`, `migrateSiteLists`, `originFromInput`,
`selfApprovalOrigin`, `selfApproves` and `uncoveredApprovals`. `sw-site-access.ts` keeps the lists in storage, under
`SITE_ACCESS_KEYS`, read on EVERY gated message, so a change applies to the next call with no reload:

| Key | Area | Holds |
| --- | --- | --- |
| `ml_site_always`, `ml_site_denied` | local | origins allowed always; origins denied |
| `ml_site_session` | session | origins allowed until the browser restarts |
| `ml_site_agents` | local, and session | origin → agent level (`ask`, `always`, `denied`; absent is `off`). An origin allowed only for the session keeps its level in the session area, so it goes with that approval |
| `ml_site_selfapprove` | local | the origins that approve their own actions |
| `ml_site_schema` | local | `2` once the slice 3 migration ran |
| `ml_site_upgrade_notice` | local | set by a migration that moved a whitelist, with the entries it could not carry over, until Settings' notice is dismissed |

`levelsFor(lists, origin)` answers `{ use, agents, selfApprove }`: `use` is `always`, `session`, `denied` or
`unknown`; a denial wins over everything; an origin on the self-approval list is `use: always` and `agents: always`
(slice 3, Q6); an origin that may not use window.ml has agents `off`. `applyEdit` takes `allow` (a site allowed fresh
starts at agents `off`; one already allowed keeps its level when its scope changes), `deny` and `revoke` (both take
every grant away: the approvals, the agent level and the self-approval, so neither a revoke nor a later "Stop denying"
leaves self-approval behind), `undeny`, `agents` (only for an origin that may use window.ml) and `selfApprove` (add or remove; a denial
still wins). An edit the rules do not know changes nothing, and the worker refuses one that does not name an origin as
the browser writes it. Edits and the migration's writes run one at a time (`serially` in `sw-site-access.ts`), so two
editors writing at once cannot lose either change, and an edit is refused while the migration cannot complete.

The agent level is enforced on every START_RUN, RESUME_RUN and INJECT_MESSAGE a page sends ("Starting agents",
below).

Edits arrive as `SITE_ACCESS` messages, answered for extension pages only (`isExtensionSender`), with the lists, and for
an `origin` its `decision` (`use`), its `levels`, and `implied` when only the self-approval list allows it. Two editors:
DevTools Settings → Permissions, "Sites that may use window.ml" (`SiteApprovals`: one row per allowed origin with its
scope, its agent level and a revoke) and "Sites that approve their own actions" (`SelfApprovalList`), and the toolbar
popup's "This site" block (the current tab's origin, read from `chrome.tabs`, never a title the page set), which shows
the agent level on a line of its own. Its Revoke, like every Settings row's, also removes a self-approval. The popup
does not add to the self-approval list (slice 3, Q14).

### The upgrade (`migrateSiteAccess`)

The worker migrates once, at start and before any reader (`siteSchemaReady`, which `readSiteLists` awaits, so a
message that wakes the worker is judged on the migrated lists): each entry of the old sync whitelist
(`pageApprovalDomains`) becomes the one origin it trusted (`selfApprovalOrigin`: a bare host is `https://host` on the
default port, loopback included; an entry stored as an origin is that origin; a host with a port, a path or a
non-string, a wildcard or a Unicode host trusted nothing and is dropped, and named in the notice; a trailing dot is
dropped from the host), and every origin allowed before gets agents `ask` (#578). It writes the
agent levels, the self-approval list and `ml_site_schema: 2` in one local write, and never rewrites the gate's three
lists, so an edit racing it is not lost. The sync setting is read once and left in place, for another machine on an
older build; nothing reads it after. A failed migration is tried again by the next reader, and until then the lists
read with no self-approval and no agent level. `tests/site-access-upgrade.test.mjs` is the fixture: storage as the old
build wrote it, read by the new bundle.

### The self-approval list

The origins trusted to answer their own approval prompts, `ml_site_selfapprove` in local storage, one origin per entry
(#628 then slice 3; Q19: no loopback special case). `selfApproves(lists, sender)` holds only when the sender's origin,
read as the gate reads it (`grantableOrigin`), self-approves by `levelsFor` (on the list and not denied). Plain http,
another port, a subdomain, a sub-frame or an opaque origin of a listed origin is never trusted as it. Settings takes
what is typed with `originFromInput` (a bare host is https; `http://` or a port must be written out), and lists each
allowed origin whose host self-approves over https on the default port but which is not itself on the list
(`uncoveredApprovals`), with an Add that stores that exact origin.

Every reader goes through it, so none can disagree with the gate:

| Reader | What it decides |
| --- | --- |
| `levelsFor` (`siteDecision`: `pageRefusal`, `SITE_ACCESS`'s `implied`, `sw-run-start.ts` resume, `sw-isolated-exec.ts` `pageApproved`) | the list implies approval for window.ml |
| `senderTrust` (`sw-consent.ts`) via `senderSelfApproves(selfApprovalFacts(sender))` | `whitelisted`: `CDP_CLICK`, `SERVER_TOOL_EXEC`, `FETCH_SHEET`, full-mode `PYTHON_EXEC`, `FETCH_URL` without a per-call grant; a worker-built run's `fetch_url`, sheet tables and Python, judged by its tab's URL |
| `pageApprovalAllowed` (`publicConfig`, which takes the decision as an argument) | `GET_CONFIG`, `workerMl`, a worker run's `agent_api_docs` config: whether a page-hosted `ml.agent` honours the page's own `approve()` |

One of the extension's own frames inside a tab (the overlay sidebar's bench) is judged by its tab's top-frame URL
(`selfApprovalFacts`), as before. `nav-handover.ts` `changesSiteAccess` watches the keys above in the local and session
areas, and no longer the sync area. The table over sender shapes x readers is `tests/self-approval-origin.test.js`
(seeded through the migration), with the pure rule in `tests/site-access.test.mjs`; the Settings rows, the list and its
notice in `tests/sidebar-settings.test.js`, drawn from the real bundle's answers; the popup in
`tests/popup-whitelist.test.js`. That first test also pins every line of `src/` that names the old setting, so a new
reader of it fails there.

## Presence: which pages see window.ml

[SITE_PRESENCE.md](../spec/SITE_PRESENCE.md), step 2. A page sees `window.ml` only when its origin may use it
(`visibleOrigins`, the same rule as `levelsFor`); every other page is HIDDEN, a denied origin and an unknown one alike.

- **The page scripts are registered, not in the manifest.** `sw-presence.ts` registers `shadow-patch.js` then
  `injected.js` (MAIN world, `document_start`, top frame) for the visible origins: `ml-main-lasting` (persists) and
  `ml-main-session` (does not, so a browser restart forgets a session grant's scripts with it). Re-synced at worker start
  and on every change to the lists, always awaited: an awaited update applies to the next navigation (measured).
- **Each match pattern names the origin's port, the default one included** (`originMatchPattern`): a pattern with no
  port matches every port of the host, and `:443` matches only the default one (measured in Chromium 151).
- **`injected.js` is not web-accessible**: registered and `executeScript` files need no listing.
- **A hidden page gets the page scripts only for a run still going on its tab**, put into that one document by the
  worker: at the run's start (`adoptOnTab`: the content script answers `needInject`, the worker injects and asks again
  with `injected`), and on a navigation mid-run (`CONTENT_READY` injects before it answers). A finished run is not
  reason enough. From then on that page sees what a visible page sees; a closed root it attached before is not captured.
- **The content script runs at `document_start` and speaks only on the worker's word.** `page-gate.ts` holds one gate per
  document, in the isolated world: `pending` until the worker answers `CONTENT_READY` (the page's early posts and the
  worker's requests wait), then `open` or `closed`. A closed gate relays nothing the page posts, answers nothing, and
  posts nothing (the sidebar shell's handshake included). The page script's hello only marks it alive, for how long to
  wait: a hidden page can forge a hello, and gets nothing for it.
- **injected.js talks to the content scripts on a MessagePort, never the page's window** (step 2b, `page-channel.ts`).
  It makes the channel on first use and hands one port to the isolated world with a synchronous `ml-page-port` event on
  `window`; content.js listens from `document_start` and keeps the FIRST port, so a page cannot swap its own in once
  injected.js has handed one over. content.js and the shell hear nothing the page posts on `window`.
- **Residuals:** a run on a hidden page exposes what it did before step 2 (rows 4 and 6 of detection-surface.md): there
  injected.js arrives after the page's scripts, which can take the port from the hand-off and speak as injected.js. A page
  that wraps `MessagePort.prototype.postMessage` reads the channel on any page. The sidebar's files stay web-accessible
  until `use_dynamic_url` (row 5).

## Starting agents

A site that may use window.ml starts, continues and steers the extension's agent only at its agent level
([../spec/SITE_ACCESS_SLICE3.md](../spec/SITE_ACCESS_SLICE3.md), PR 2). The rules are pure (`src/agent-start.ts`: the
1.7 refusals, what an approval is bound to, the card's lines, how a page-sent turn is marked); the worker's half is
`src/sw/sw-start-approval.ts`; the card is `src/sidebar/card/card-start.tsx` (sidebar.md, "The start card").

**At the router.** `AGENT_LEVEL_TYPES` (page-relay.ts) is START_RUN, RESUME_RUN and INJECT_MESSAGE; PAGE_CANCEL_RUN
stays allowed. After `pageRefusal`, the router applies the navigation rule (below), then `agentRefusal`
(sw-site-access.ts), which reads `levelsFor(...).agents` from `sender` alone: `off` and `denied` are refused with the
1.7 text (a START_RUN's names `host: "page"`, since `ml.agent` sends it), `ask` and `always` go on.

**At the run host.** `startBackgroundRun` (and `pageInject`, sw-page-turn.ts, for a steer) asks `gatePageTurn`, which
reads the level again and decides each turn a page sends:

- `always`: the turn rides. A record is still kept (scope `always`), so a later turn knows the run's site and tab, and
  a site turned back to "ask" is asked again for it.
- `ask`: a card when the run has no approval (or one that rode on "always"); a `change` card when a turn adds a gated
  builtin or a server tool, changes the model, changes the site's instructions or the text of a tool (its description
  and parameters, which the model reads and the card never shows; a tool the approval did not have counts), turns
  `crossOrigin` on, or raises the step budget (Q3, `widening`; the person's own Continue may raise it); a `more` card
  when a page-sent turn would pass the page turn budget (`PAGE_TURN_BUDGET`, 10). Otherwise the turn rides and a
  page-sent one is counted. A widening that rode on "always" turns a card-made approval into one that rode on
  "always", so a site set back to "ask" is asked again.
- An approval (`ml_start_approved`, session storage) is written before the turn runs, bound to the run id, its tab, its
  origin, the gated builtins, the server tools, the resolved model, digests of the site's instructions and of each
  tool's text, `crossOrigin` and the step budget. Another
  tab, or another origin on the same tab, is refused. A revoke of the site or its level drops every approval of that
  origin at the `storage.onChanged` event and again at worker start (`dropRevoked`), and re-approving does not bring
  them back.
- A first turn carrying `resumeMessages` is refused (Q4). A later turn's history is the worker's (`bgRuns`), never the
  page's copy; the page sends what it added since (an idle `say()`) as part of the turn's text. None held after an
  eviction is an empty history, which still continues the session.
- An ask belongs to the document that raised it: a top-frame commit on its tab, or the tab closing, answers it "gone"
  (refused as unanswered, and not counted as a denial), and after the person's answer the tab must still show the
  asking document (`webNavigation.getFrame`), for a document replaced with no commit the worker heard.
- The asks: one waiting per origin per tab, `START_ASKS_MAX` (3) across the browser, 3 minutes each (a test shortens it
  through a worker global), and three denials or timeouts quiet an origin for the browser session or until its level
  changes (`ml_start_denials`). An ask is in memory only: an eviction loses it, which refuses the start.
- The decision is `SET_START_APPROVAL`, sent by the shell for a message from the card's frame over its private port, or
  by the DevTools panel. It is in neither `HANDLE_MAP` nor `PAGE_RELAYED_EXTRA`, a shell's answer counts only for an ask
  on its own tab, and an answer for an ask the worker no longer holds changes nothing and is answered `{ data: false }`,
  so the surface shows the card expired (as it does on its own at the ask's deadline). The ask's id reaches only the
  worker's surfaces: `ML_DEBUG_TO_PAGE` to the shell and the DevTools port, never the session index, the replay buffer
  or `ml.__events()`.

**What the card shows** is the worker's snapshot (`StartAsk`): the origin from `sender`, the task verbatim, how many
images the site attached, the site's own instructions (`siteInstructions`: what is left of the page-built system prompt
once the extension's preamble, wherever it sits, every clause `composeSystemPrompt` can add for the toolset and the
notes marker are removed; plus each site-defined tool's description and parameters, `siteToolTexts`, S2), the tool
lines from the registry's `cardLine` (a server tool's name quoted and stripped of invisible characters,
`serverToolName`), the tool lines from the registry's `cardLine` (a site tool that takes a builtin's
name gets the builtin's line; the site's own tools are counted), the model the worker resolves after the filter (a
start the filter refuses is refused before any card), and the budgets.

**The page's context and a builtin's text are the worker's (B1, S2).** A page that starts a worker-hosted run sends no
"Current page context" block; the worker writes one from the browser's facts (`workerPageContext`: the sender's URL, the
tab's title cut at 80 characters, the time and the locale) after the card's snapshot, so a context block the page wrote
is the site's and shows on the card. A tool named like a builtin is given the extension's own description and
parameter descriptions (`builtin-texts.ts`, from the factories the worker builds a person's run with); a site's own
tool keeps its text, which the card shows and the binding covers. The bindings' digests are SHA-256.

**Whose turn it is (Q2, Q2a).** A turn the page sent reaches the model as "Message from the page ({origin}): ...", the
first task included, and the transcript shows it with the site's name (`agent-site-say`, never `agent-say`), which also reach the session index from the worker only, so the chat page
names the site too. The page's
own `agent-say` for a run the worker hosts is no longer admitted (`pageMayWrite`), so it cannot draw its message as the
person's. A message the PERSON sends through the extension for a page-built run is relayed by the page, as its handle
lives there: `userRunAction` notes it first (`notePersonTurn`, with the images and the step budget the person chose),
and the page's copy of exactly that text, with exactly those images, is the person's turn, unmarked, not counted, and
run at the person's budget (or the approved one), never the `maxSteps` the page relays (`takePersonTurn`, once per
note, two minutes). An honest page that folded an idle `say()` ahead of it sends the say, a blank line and the person's
text: the say is marked as the page's, the person's text is theirs. A page that swaps the text or adds a picture gets a
page turn. A page turn of pictures alone is marked too, and every line of a page's text after the first is prefixed
`| `, so a line it wrote to look like the person's reads as part of its message. A resumed turn never carries the first
turn's images. A turn refused after the gate (the run turned busy) gives back what it spent. INJECT_MESSAGE's `origin` (where a message was typed) is never read from a page.

**Waiting for the person (Q2b).** `handle.waitForPerson(prompt)` sends INJECT_MESSAGE with `waitForPerson`: for a run
this site's approval covers, the worker stops the run and fans `agent-wait`, and the reply box opens under the prompt,
labelled "The site asks: ({origin})". What the person types is their turn, as above. At most one wait a run every 10 s
(`WAIT_GAP_MS`).

**A page a running agent opened (Q17).** `openedByRun` answers for a sender's tab and document. While a run is live on
the tab, any document other than the one it started on (a run this worker did not see start, resumed after an
eviction, has no start page at all) may not start, continue or steer an agent. After it ends, a document the tab
committed while it was live still starts no new agent; only that run's own next turn is taken from it, and its approval
decides it like any page turn (a page-built run that navigated within its site is continued from the page it is on).
A prerendered document the run's tab activated (no top-frame commit) is recorded when the run ends, from what the tab
shows then; a tab the run's page opened (`webNavigation.onCreatedNavigationTarget`, an `openerTabId`) and a tab the
extension opens to render a page for `fetch_url` are agent-opened whole. The person's own message, relayed by such a
page, is let through, spent at the router (`claimPersonTurn`) so a copy
sent twice is refused the second time. What a run opened is kept in session storage (`ml_agent_opened`), so the rule
outlives an eviction, and the router reads it back before judging a message that woke the worker. A refused page's START_RUN is
recorded (`site.notStarted`, for the badge) and drawn as one quiet `agent-note` line in the driving run's steps (once a minute per site and run), with no
card and no model call; nothing is added to the driving run's messages.

**Revoked while it runs (Q9).** A site that may still use window.ml but lost the agent level has its live runs
cancelled (`cancelBackgroundRun`), and the result's summary says "Cancelled: this site may no longer start agents.". A
site revoked whole keeps #621's hand-over to the worker.

**Where the card shows (Q7).** The tab's HUD card, the overlay sidebar and the DevTools panel. Not the chat page and not
the phone: the start ask is a live notice that never enters the session index, which is all the chat page reads, and
showing it there would need the ask in the index and the hub's gate protocol. The chat page's mode is talking to the
model, while a site's agent helps with the page the person is looking at, so there is no natural place for a site's
start ask there yet. The external `__mlApprovals` channel never sees a start ask.

**Where the loop runs (Q1).** `ml.agent({ host: "page" })` runs the loop in the page, as plain window.ml use: its gates
are the caller's `approve`, its model calls `FETCH_LLM`, and a server tool's call is refused unless the site
self-approves (`SERVER_TOOL_EXEC`'s own rule). Without `host`, the run is the worker's, except a self-approving site
with no debug surface on, which keeps its own loop as before (its `approve` is what the list is for).

## The page's cancel

The content script relays a page's `CANCEL_RUN_REQUEST` as `PAGE_CANCEL_RUN`, not `CANCEL_RUN`. The shell's Stop button
sends `CANCEL_RUN` from the same content-script world, so without its own type the gate could not refuse a page's
cancel without refusing the person's Stop. A run the worker built cannot be cancelled by a page at all.

A cancel reaches a run that is still STARTING too. `START_RUN`/`RESUME_RUN` wait on the worker's restore, the config
and the start card before `hostRun` registers the turn's controller; a `CANCEL_RUN` in that window used to find nothing
to abort and the run started anyway (the person's Stop lost, including across a worker restart's hydration). The start
is registered in `startingControllers` (`sw-runs.ts`) for that window, aborted by `CANCEL_RUN`/`CANCEL_ALL_RUNS`/the
page's own `PAGE_CANCEL_RUN`, and the start answers `{ cancelled: true }` instead of hosting. `tests/background.test.js`
holds the cases; the ownership rule for `PAGE_CANCEL_RUN` is the same as for a live run, read from the start
registration's `tabId`.

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
`src/sw/worker-tools.ts`, the tool registry's `realm: "worker"`), so what it reads never enters the page's world: the same tool from the same factory, given
an `ml` the worker answers. Today: `fetch_url`, through `fetchUrlFor` (`sw-fetch-url.ts`) with the run's tab as an
untrusted caller. Its approvals are the RUN's (`grantRunFetch`: the consent and the one-time as-you grant live in the
run's worker state, never on the tab), so no script on the tab can spend them through its own `FETCH_URL` (which only an
approved site may send at all); after an eviction they are rebuilt empty, and a call then asks again. Its Markdown comes
from the offscreen document (`HTML_TO_MD`) and its reader's model call is metered as the call's `subUsage`. A session
render of the page the run is on (`credentials` and `rendered`, this page's URL) needs no request: the worker asks the
page for its live document's HTML as plain data (`pageRead`, below) and runs the rest of the tool itself, an `ask`'s
reader call included. A read-only survey re-reads the run's fetches from the worker's cache (`_fetchCached` in
`worker-readonly-ml.ts`), and a miss defers to the page's. Both caches hold frozen copies (`cacheCopy`), so a survey
cannot rewrite what a later re-read shows.

`python_exec` runs there too, whatever it loads. An `image`: the worker shoots it from its own capture and mints a
`cast`'s token in the page's registry through the `mint` geometry op (`src/sw/worker-media.ts`). A page table (a CSS
selector, or `current` on a page that is not a Google Sheet): the page reads it from its DOM with the page loader's
own reader (`pageTable`, ml-python.ts) and hands the cells back as plain data (`pageRead`), which the worker rebuilds
field by field within bounds (`checkPageTable`, `src/sw/worker-page-read.ts`). `current` on a Sheet's page is that
sheet, read by the worker like an external one. The page is asked for the source and nothing else of the call (not its
code, not its other tables), and a call mixing an image, a sheet and a page table runs whole in the worker, where it
used to be refused with a two-call steer because its page part ran on the page. Its other tables load without a DOM (a
table by value, a URL the run's fetch_url read, an external sheet), and the call goes through `runPython`
(`sw-python.ts`) with the run as the caller. Its approval is the run's CALL grant (`grantRunPython`: the external sheet ids, the full-mode code), set
around the one call and never on the tab, so a page cannot read the sheet with the person's cookies or run the approved
full-mode code itself while it runs. Live stdout goes straight to the call's output.

`describeElement` stays a page tool, but its one privileged step does not: a `>>>` path into a SEALED shadow root of a
run the worker drives comes back as `cdpShadowResolve` instead of the page sending `CDP_SHADOW_RESOLVE`, and the
worker resolves the MODEL's selector through the debugger (when the CDP setting is on) and writes the result
(`sealedDescribe`, tools.ts). The page's echo of a selector is never resolved.

`agent_api_docs` runs there too (`apiDocsTool` in `src/tools/api-docs-tool.ts`, given a `DocsSource`): the worker reads
the live shortcut (`invocationInfo`, `sw-invocation.ts`) and the config itself, so the page sends neither
`GET_INVOCATION` nor `GET_CONFIG` for it. Its within-dig dedup memory is the worker's,
keyed by the run's local tools, so `runLocalTool` counts each call the page runs towards its streak (`countDocsStreak`),
which the page's `executeTool` used to do; a read-only try counts on neither side.

`answer` runs there too, and the run's curated answer set lives there (`src/sw/worker-answer.ts`, kept in session
storage, so an eviction or a navigation mid-turn does not lose it). The tool is the page's descriptor with the shared
core (`answerCall`, `answer-set.ts`); only a `selector` asks the page, which resolves it in its DOM and returns a
preview and each element's media SHAPE with no image (`answerSelect` with `mediaInWorker`, `answerMediaShape`): the
worker crops each image from its own capture of the document the page answered in (`workerAnswerMedia`,
`src/sw/worker-media.ts`), and a page that sends an image of its own is refused whole. An `<img>` is cropped like any
element (its drawn size), never fetched from a src the page names, so `FETCH_IMAGE_B64` is not sent. An approved exec in the page's world, and a read-only survey that reaches the page,
is sent the set's SHAPE (`answerShape`: kinds and an element's preview, never a text's content or an output's ref or
caption) and given
an `AnswerLog`, which answers `.length` and indices at once and records what the script changed; the worker replays it
(`replayAnswerOps`). That report is the page's, so it is checked for shape and size, refused whole if any operation
is malformed or the set would pass its bounds, and a removal by text matches only what the same report added (as the
script's own view did), so it cannot probe a hidden item. A selector's answer from the page is rebuilt field by field
(`checkSelection`), and the model's note for it never leaves the worker. It can change only the person-facing answer, which a script in that world could already do. The page is
sent no answer content at `finish`, and answers none.

## Where an approved exec of a worker-built run runs

`delegateTool` (`sw-run-host.ts`) asks `routeExec` (`src/sw/exec-routing.ts`) before it mints any grant on the tab. The
rule is pure, and its tests enumerate every input (`tests/isolated-exec.test.mjs`, `tests/exec-world.test.mjs`):

- A plain script on an approved page: the page's main world, full parity.
- A script naming `ml.current`, `ml.sh` or a pointer (read lexically by `execNames`; a miss fails closed, since an
  unnamed read is not sent and the main world has neither `ml.current` nor `ml.sh`), or any script on a page that is
  not approved: an
  isolated world (`runIsolatedExec`, `src/sw/sw-isolated-exec.ts`). That is `chrome.userScripts.execute` in the run's
  world `wml-<runId>` when the person has allowed user scripts, else a CDP isolated world when the CDP setting is on.
- Neither available: refused on an unapproved page and for `ml.current` and `ml.sh`; a pointer script on an approved
  page runs in the main world with a note (owner's decision), unless it also names `ml.sh`, which outranks the pointer
  (reason `sh`), so a script reaching the process host never runs where the page's scripts could read its output or
  make its calls (docs/spec/SHELL.md, "The routing rule this adds").
- The call's `world` (owner's decisions, 2026-10-14): `"isolated"` runs isolated or is refused, never downgraded to the
  main world; `"page"` runs in the main world, and is REFUSED wherever the rules above isolate (a pointer, `ml.current`,
  an unapproved page), with a sentence saying why and to omit `world`. A malformed value is refused.
- No `world`: the default world, `defaultExecWorld` (contract-config.ts): the stored `execDefaultWorld` (DevTools
  Settings → "Where exec runs by default"; empty, the default and what an older install holds, means unset), else the
  build constant `__EXEC_DEFAULT_WORLD__` (build.mjs, a JSON string, `"page"` as shipped; the bench builds a variant per
  value). An isolated default with no isolation runs in the main world as before: a default is not a request.
- An isolated exec's error that reads like a missing page global (`is not defined`, `Cannot read properties of
  undefined`) gets one line, `Page globals need world: "page".` (`pageGlobalHint`), only when its route was
  `requested` or `default`: where policy isolated it, `"page"` would be refused, so the hint would start a loop.
- `world` is offered only to a run the worker drives (`withExecWorld`, at the turn's start; the start event carries the
  same list): a page-built run's exec runs in its page's world. `null` is omitted.
- What the page is sent of it: nothing for a run the worker drives. `sendTool` drops `world` from every exec message to
  the tab (`withoutWorld`), exec's In is drawn in the worker, and its precheck runs there too (it used to be sent to the
  page, script and all; a `js` that is no string is refused there). A read-only survey whose exec would run isolated
  (asked, or by the default) skips the page's leg: it is answered in the worker or goes to the gate. A page-built run
  refuses `"isolated"` in the worker's precheck, at the call, and on the page (`pageWorldRefusal`), and its survey is
  not tried. `ml.current.env.exec` answers for an exec without `world` under the default; for a page-built run it uses
  the page's world, so the page never learns the stored default.
- The approval card says the world when the call's `world` moves the exec away from where the default would run it
  (`worldCardNote`, the code block's note): "Runs in the page's own world, where the page's scripts can see and change
  it." or "Runs in an isolated world, hidden from the page's scripts." Under an isolated default, a page that steers the
  model to its own world (by shaping an error so the hint fires, or by injection) is seen by the person approving.
- KNOWN CONFOUND under an isolated default: a read-only survey that reads the page is no longer auto-answered (the
  page's leg runs the dialect in the main world); it goes to the approval gate and, approved, runs isolated. So the
  isolated default changes two things at once: where exec runs, and that page-reading surveys need approval. Running
  the dialect in the isolated world (SITE_PRESENCE step 3) removes it. On the shipped `"page"` default a world-less
  survey auto-answers on the page's leg as before (`tests/exec-world.test.mjs`, "default build").
- The red-team pass is `tests/redteam-exec-world.test.mjs`; the table is `tests/exec-world.test.mjs`.

The isolated script runs inside one wrapper built as source (`isolatedWrapper`): it binds `ml` (`current` deep-frozen,
`dereference` answering only the reads sent with the call, each the page's own `DerefText` from `src/isolated-kit.ts`),
captures the console, and returns plain data. Live lines
come back through `chrome.runtime.onUserScriptMessage` (reachable only from a world this extension configured), checked
against the run's tab, the top frame and the call's nonce, or through a CDP binding added with `executionContextName`,
so only that world has it, checked against the world's context id. The route is decided for one document (read
before its URL, so a navigation in between fails the send rather than redirecting it) and every send is pinned to it. Every decision is in the execution log
(`subsystem: routing`, `kind: exec-main|exec-isolated|exec-refused`, `detail.how`).

A value's `.pipe()` and a stored table's `col`/`select`/`records`/long `head` need the worker while the script runs (part
4b). The world asks over a channel only it holds, and the worker answers through `isoServer` (`src/sw/iso-channel.ts`):

- The channel is the one the live lines already use. A user-script world sends `ISO_EXEC_ASK` with
  `runtime.sendMessage`, which reaches only `onUserScriptMessage`: the page's main world and the content script cannot
  send there, and the type is in neither `HANDLE_MAP` nor `runtime.onMessage`'s router. A CDP world calls the binding
  named for its world (`executionContextName`); the answer goes back by `Runtime.evaluate` in that world's context id.
- A request is answered only under the call's nonce (minted per call, written only into the world's source, deleted
  when the call ends), from the call's tab, frame 0 and its routed document; an absent tab, frame or document is a no.
  Anything else gets no answer at all, so a sender learns nothing. A CDP call is taken only from the world's context id
  on the run's tab.
- Which facts Chrome gives, checked in its source (2026-10, `extensions/browser/api/messaging/extension_message_port.cc`,
  `DispatchOnConnect`): a user-script world's message gets the same `sender` as any frame's, so `tab`, `frameId` and
  `documentId` are set, with no branch on the sending world. Chrome does NOT set `userScriptWorldId` (Firefox does), so
  the world check applies only where a browser names it, and in Chrome another world on the same document is kept out
  by the nonce alone, which only this call's world was given. Were `documentId` ever absent, every request would go
  unanswered (`.pipe()` and stored columns would fail, nothing would leak): `tests/redteam-isolated-channel.test.mjs`,
  "no document". The vm harness sends Chrome's shape (`tests/isolated-harness.mjs`).
- What it may read is the entitlement `VALUE_COLUMNS` applies: a re-pipe of a read the approved source NAMED (the world
  sends an index into the call's reads, never a pointer), and the columns of a stored table sent with the call or handed
  back by one of its re-pipes, with the delimiter from the worker's record, held by the run. A read that failed is not
  re-read under another pipe.
- At most `ISO_ASK_MAX` (256) requests a call; past it each is refused before any work, so a looping script ends on
  that sentence. One re-pipe carries at most `ISO_MAX_STAGES` (256) stages of `ISO_MAX_STAGE_CHARS` (16,384)
  characters, past which it is refused with a sentence naming both: the one cap the read-only and main-world paths do
  not have, set well past any pipe a script writes.
- Every request is answered, an error included (an unterminated quote, a store that fails): a CDP world's read that
  went unanswered would leave its script awaiting it for good.

`tests/isolated-pointer.test.mjs` holds the values and errors to the read-only and main-world paths';
`tests/redteam-isolated-channel.test.mjs` is the red-team pass on the channel.

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

## What an approval lets leave

The read-only dialect has no network path: its `ml.fetch` answers only from caches of earlier approved fetches, and
nothing else in it starts a request (`docs/dev/readonly-exec.md`, "Threat questions answered"). Everything below is
the tools' and an approved exec's.

Approval is per URL (`fetchConsent`, `runFetchConsented`: the exact URL a person approved, re-fetched without asking for
the rest of the session). "Approve + remember" on an `exec` card is not a tab grant: it adds one exact-URL RUN policy per
URL the person saw (`rememberFetchUrls`, `docs/dev/policies.md`), kept with the session, and a page-built run's fetch is
not skipped by it. It used to write `fetchConsent`, which the page's own `FETCH_URL` reads, so a hostile page on the tab
could fetch a URL remembered for a run.

These are ORIGIN-wide instead, and auto-approved with no prompt:

- `fetch_url`, uncredentialed, of any URL on an origin the run has consented to: its start origin and every origin a
  `navigate` was approved to (`consentedOrigins`, `sw-run-host.ts`; `autoApprove`, `agent-host.ts`). A `rendered` read is
  included, an incognito tab that runs the target's scripts.
- `navigate` within the site or to a consented origin, in the person's own tab, with their cookies.
- `ml.fetch` of the sender page's own origin (`sameOriginAsSender`, `fetchUrlFor`), uncredentialed, and credentialed too
  with `autoApproveSameOriginAuth`; an approved exec may compute that URL at run time.
- The agent's own repository with `autoApproveSelfSource`.

**What a URL or origin approval does not control is what the request carries.** Data the run has read (another site's
content, a pointer's value, the page) can be written into the path or query of a URL on any of those origins with nobody
asked: a search URL (a `navigate` is credentialed, so the query lands in the person's account history), an endpoint whose
GET changes state, an analytics or logging endpoint, a URL shortener. That is the gap between approving destinations and
information-flow control (CaMeL, FIDES: label what the run read, and ask before a request whose URL carries labelled
data), which is not built.

**Redirects.** Every fetch follows them (`redirect: "follow"`, `sw-fetch.ts`). A per-URL-consented or same-origin fetch
that ends on an origin nobody consented to has its body withheld (`fetchUrlFor`), but the request to the redirect target
has already gone, carrying what the first URL carried. For a URL a person approved, they saw that URL whole. On the
origin-wide paths above, an open redirect on a consented origin delivers a URL the model composed to any host, with
nobody asked. An approved exec's literal URLs (`execOpen`) trust their redirects outright. Not fixed: a worker sees an
opaque response under `redirect: "manual"`, never the `Location`, so approving each hop is not possible from `fetch`
alone. The proposal is `redirect: "error"` on the origin-wide auto-approved paths, turning a redirect into a prompt for
the URL; a `rendered` read follows redirects as a navigation and needs its own answer.

**What a request carries besides its URL.** `GET`, no body; `Accept`, `Accept-Language` and `User-Agent`; cookies only
in the as-you mode, which a person approves per URL each time (or same-origin with `autoApproveSameOriginAuth`). The
request is the worker's, so a `Referer`, if Chrome sends one, names the extension and never the page (not measured).

## The `ml` wire (ML_CALL)

`ML_CALL` is one `ml` call as a message, for code that cannot hold `window.ml`. The first client is the Pyodide cell, which
runs in the offscreen document; CPython at a process host is the next. The contract is `docs/spec/ML_WIRE.md`; the types
(`MlWireRequest`, `MlWireAnswer`, `MlWireErrorCode`, `WireRealm`) are in `contract-messages.ts`, the sender check, the
members and the handler in `sw-ml-wire.ts`, and the client registry, the checks and the copy out in `ml-wire-serve.ts`,
which has no `chrome` in it so its rules are tested without a worker.

**The worker opens the client; the code never does.** `runPython` (`sw-python.ts`) calls `openWireClient` once per cell
and gets a handle, `mlw-<uuid>`. The handle is bound to the sender kind that will carry the calls: `offscreen`
(`sender.tab == null` and `sender.url` is the offscreen document's URL), the only kind so far. An isolated world keeps
its own channel (`iso-channel.ts`); when it becomes a wire client, every fact (tab, frame 0, document, world) is
REQUIRED, since a client opened without one would match any document on the tab. It is bound to the run the cell is for, and to a realm, `readonly` or `full`, taken
from `hardened`. The handle and the run ride `PY_RUN` as `wire: { client, run }`, and the client is closed when the cell
ends, so a call on the handle after that is refused. A completion runs no code and gets no client.

**A call is answered only when the handle AND the sender match.** `senderIs` compares what the browser set on the
message, and an absent fact does not match. An unknown handle, a closed one and a wrong sender are refused with one
identical message (`this sender cannot call ml over the wire`), so a caller cannot tell which handles exist. A tab's
sender never matches the offscreen client, and a page cannot start the message at all: `ML_CALL` is not in `HANDLE_MAP`
(`page-relay.ts`), so the content script relays nothing under that name. The worker takes it from `onMessage`
(`background.ts`).

**The run id in the message is not authority.** A hostile page knows every run id. `serveWireCall` compares the message's
`run` with the one the client was opened for and refuses any other, a `null` included, without saying whether that run
exists. A cell a page started through `PYTHON_EXEC` is bound to NO run, even on the tab of a run in flight: `wireRun` is
passed only by the worker-hosted run's tool (`worker-tools.ts`). Such a cell has no `dereference`, so it cannot read the
run's `@tool:` values by naming the run.

**Members.** They are the worker survey's own facade (`workerReadonlyMl` through `mlFacade` with realm `worker`), cut to
`ML_READONLY_METHODS`. What reads the page (`queryAll`, `a11y`) is absent, and answered as `Absent` with the list of what
the code does have. A member added to `ML_READONLY_METHODS` later arrives here without a second list. `full` has the same
set this round: the gated members (a live fetch, `chat`, `click`) come with the consent path, each with its own gate.
`dereference` is read from the run's resolver and answers `{ text, meta?, warning? }`, or the pointer when the value is
over `WIRE_VALUE_CAP` (2^20 JSON characters). No read reaches that today: the run's store holds the text the model was
shown (`fetch_url`'s "[first 4000 of N chars]"), and a pipe reads that text, so the whole of a large value is the value
store's, named by `meta.value`, and the pointer answer is the server's rule ahead of a member that needs it.

**What crosses.** Arguments are copied in and answers are rebuilt out by `toWire`, from own data properties into fresh
plain objects: a function, a proxy, an accessor, a cycle or a class instance is refused, so nothing live reaches the
client. Bytes cross as `{ $bytes: base64 }`. An argument that names a secret anywhere (an own `$secret` key) is refused
with `SecretHandle`, never resolved to a value. An error's text goes through `forPage` (`sw-scrub.ts`), so the server
URL, the key and the model filter never cross.

**`ask`.** A gated member that needs the person is answered first with `{ ask: { card } }`, and the final answer follows as
an `ML_ANSWER` push with the same `seq`. The member runs only if the client is still open when the person decides (an
approval landing after the cell ended runs nothing), and a card unanswered for `ASK_TIMEOUT_MS` (five minutes) fails the
call with `Denied`. No member is gated yet, so this path is exercised by the serve tests only.

**What the tests hold.** `tests/redteam-ml-wire.test.mjs` holds the properties a hostile page must not get: a page's
`ML_CALL` is never relayed; a tab's sender with a live handle is refused while the offscreen document with it is
answered; an unknown, guessed or closed handle reads the same as a wrong sender; a forged or null run id reaches
nothing; a page-started cell has no run; a read-only client reaches no `chat`, `click` or live fetch, nor anything off
the prototype; a `$secret` argument is refused; no answer carries a function or a proxy. `tests/ml-wire.test.mjs` holds
the wire's own behaviour. Each defence was mutation-checked: removing the sender check, the run check, the close, the
secret check or the realm cut, or binding a page-started cell to its tab's run, each fails a named test in the red-team
file.

## Adding a tool, a member or a message

The red-team pass AGENTS.md requires. Run it as its own agent, told to find where a property does not hold rather
than to review; each gap it finds becomes a test titled by the property, failing before the fix, and each shape it
tried that HELD is pinned too (or given a one-line reason it is not), so a re-pin or refactor that reopens it fails a
test. A scratch probe script is never the only record. The threat is a page
that shares the main world with `window.ml` and with any tool code run there, holds injected.js's port when it ran first
(`asInjected` in the vm worlds; nothing it posts on `window` is heard), acts on the
extension's shadow HOSTS (their roots are closed since attack 17), and knows every run id. Cover:

- **Where it runs.** A tool run in the page puts its inputs and results into the page's world. Prefer the worker; if
  it must run in the page, name what of the run it puts there (another site's content, a pointer's value, the system
  prompt) and why the page may see it.
- **What it sends while it runs.** Nothing, from the page: there is no allowance for a page a run is on (part 5), so a
  page-started type the tool sent there would be refused on an unapproved site. What the tool needs of the page it asks
  for as plain data about the page (`geometry`, `pageRead`, `answerSelect`), checked field by field in the worker. Test
  that the page sends nothing for it (the ratchet, `tests/e2e/media-in-worker.spec.mjs`), and what the page answers
  forged, oversized and malformed.
- **What the page can forge.** Its result (`PAGE_TOOL_RESULT`) and its live lines: a forged one may misreport only the
  page's own content, never another site's or the run's. Nor can it be larger than the worker takes from a page it reads
  itself: every answer goes through `capPageAnswer` (`src/sw/page-answer-caps.ts`) in `toPage`, held to
  `PAGE_TABLE_CAPS`, the constant `pageRead` uses, with the text the model reads clipped by `clipOut` while the worker
  holds the run (a page-built run's own tool text is its page's, and stays whole). So does every
  page text the worker folds into a result after it (`fromPage`, `capPageContext`): a new path that adds page text to a
  result or a prompt goes through one of them.
- **An `ml.*` member.** Refused from an unapproved origin is automatic (the red-team suite enumerates `HANDLE_MAP`).
  On an approved page: does it spend tokens, change config, or read across origins, tabs or runs? If it is read-only,
  it goes in the dialect too, with the dialect rule's tests (`docs/dev/readonly-exec.md`), and is placed in or out of
  the worker facade on purpose.
- **A message type.** In `PAGE_STARTED_TYPES`, or sent by the content script outside `HANDLE_MAP`, where its handler
  must bind it to the sender itself (the run's tab, frame 0, the document) and the UNGATED ratchet lists it.
- **A blocked case.** If a safety classifier stops a test, stop on that case and hand it to the owner, whose other
  model writes the test; this side writes the defence.

## Credentialed background fetches

**A privileged or credentialed background fetch MUST validate its target host: the client-side approval gate does
NOT protect it.** The agent approval lives in `injected.ts`, but raw messages (`FETCH_SHEET`, …) are reachable by any
page through the content-script relay, so a hostile page can call the handler directly. `FETCH_SHEET` fetches
`credentials:"include"` (the user's cookies), so it is hard-locked to the `docs.google.com/.../export?` shape
(`SHEET_URL_OK`); without it, it is a cookie-authenticated "read any URL" exfiltration primitive. `FETCH_IMAGE_B64`
names `credentials:"omit"`, because a worker fetch's default sends the cookies of every host the extension reaches,
and it reads only a public host's raster image (`sw-image-fetch.ts`).

## Tests

- `tests/site-access.test.mjs`: the pure rules, `levelsFor` and `applyEdit` over every (use x agents x selfApprove)
  state, and the migration enumerated.
- `tests/site-access-upgrade.test.mjs`: the upgrade from the old lists and sync whitelist, against the bundle.
- `tests/event-admission.test.mjs`: `pageMayWrite` over every event kind the contract defines, for each claim; the
  worker-only notices of a site's agent refused from a page for every claim.
- `tests/redteam-agent-level.test.mjs`: the agent level and the start card against the bundle: each level's refusals,
  the card's deny, timeout and eviction with zero model requests, a handle's later turns, the page turn budget, whose
  turn it is, waiting for the person, widening, the binding, a revoke, the first turn's history, the navigation rule,
  the floods, the decision message, the upgrade and Q9; `tests/redteam-agent-level-2.test.mjs`, the separate red-team
  pass (widening by budget, crossOrigin and tool text, pictures on a turn, context lines, Q17 across an eviction and
  its race). `tests/agent-start.test.mjs`: the pure rules, with
  `siteInstructions` against every composition of the stock prompt. `tests/sidebar-start-card.test.js`: the card in
  jsdom. `tests/e2e/site-access.spec.mjs`, attack 19: the card in a real browser.
- `tests/run-start.test.mjs`, section "what a page may add to a run the worker built": the worker's half, against the
  bundle.
- `tests/run-start.test.mjs`, section "where a read-only survey of a worker-built run is evaluated": the routing and
  its log, against the bundle.
- `tests/redteam.test.js`, section "(f)": every page-started type refused from an unapproved origin with nothing
  reaching the backend, a tab or the screen; a sender that can never be granted refused even when its host is
  approved; revoke and deny without reload; a page cannot edit the lists, nor write an agent level or the
  self-approval list through any page-started type; http://host of an old whitelisted host stays untrusted; the stream port. Section "(g)", part 5: the
  same on a tab hosting a run; the former run-tab types, by name, from a page that knows the run's id in the middle of
  its tool call; the page a page-built run navigates onto cannot stop the hand-over, nor can a revoked page flooding
  sends and re-adopts; and the upgrade (an old in-flight
  snapshot resumes as the worker's, a cross-version one is dropped).
- `tests/nav-handover.test.mjs`: the hand-over at the commit, and the rest of a turn handed over mid-way; the hand-over
  at a revoke by each path that changes the approved set, during a call in flight, while a call is being built (the
  revoke placed at each step), across an eviction and a restart, and one way when the site is approved again; the finish
  of a run handed over at a navigation or a revoke carries the run id alone; a page's START_RUN/RESUME_RUN delivered
  while the run restore is held (`holdRestore`); more than `HANDED_MAX` live hand-overs; the eviction seam.
- `tests/delegation.test.mjs`, "the end of a turn of a run the worker holds": a finish posts no summary on the page's
  window.
- `tests/worker-page-read.test.mjs`: python_exec over a page table, a `fetch_url` session render with an `ask`, and a
  sealed `describeElement`, each in the worker; `checkPageTable`; the page's half over a real DOM.
- `tests/page-answer-caps.test.mjs`: a page's answer held to `PAGE_TABLE_CAPS`, at and past each cap beside
  `checkPageTable` (so the two cannot drift), the source's row count, dropped text and pictures, the model's clip.
  `tests/redteam-render-values.test.mjs`, "bounds": a 300,000-row table, a 20 MB capture and a 20 MB text through a
  worker-built and a page-built run, in the pointer, the model's context and the execution log, with a positive control.
- `tests/redteam-page-run-builtby.test.mjs`: a page START_RUN claiming `builtBy`/`rebuild.builtBy` stays page-built,
  its `pageOrigin`/`pageUrl` are the sender's, its auto-approve flags and `requiresApproval` never undercut the worker's,
  its run id is its own tab's, and its `approvalRouting` never resolves or skips a gate.
- `tests/e2e/site-access.spec.mjs`: the hostile site, against a real browser; "part 5": the page a run is on, and the one
  a page-built run navigates onto while blocking its own re-adopt, get nothing from any former run-tab type; a run
  whose site is revoked mid-run by a storage write is handed over and its next exec never runs in the page.

The vm harness approves a test sender's origin unless `loadBackground({ siteGate: true })`, and gives a URL-less test
sender a page at `https://page.test/`, because a real content script always has one. The e2e harness's `waitForMl`
approves the page's origin unless `{ approve: false }`.
