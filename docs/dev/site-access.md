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

1. A tab hosting a live background run (`activeRuns`) may send anything but RUN CONTROL (`RUN_CONTROL_TYPES`: start,
   resume, steer, the page's cancel), from its top frame, whatever its origin. This is the INTERIM allowance for that
   run's delegated tools, which still make page messages (a vision tool's model call, a screenshot, `fetch_url`). Slice
   2 replaces it with one-time call tokens. It is also why a run on a local `file:` page keeps working.
2. Otherwise the sender must be grantable (`grantableOrigin`: top frame, http(s), not opaque) and its origin approved
   (`decide`), or, over https only, its host on `pageApprovalDomains`.

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
background session whose run the worker no longer holds counts as `owns`. `DUMP_EVENTS` (`ml.__events()`) gives a page
only the buffered events of sessions it is not shut out of.

## Tests

- `tests/site-access.test.mjs`: the pure rules.
- `tests/event-admission.test.mjs`: `pageMayWrite` over every event kind the contract defines, for each claim.
- `tests/run-start.test.mjs`, section "what a page may add to a run the worker built": the worker's half, against the
  bundle.
- `tests/redteam.test.js`, section "(f)": every page-started type refused from an unapproved origin with nothing
  reaching the backend, a tab or the screen; run control refused on a tab hosting a run while the rest is allowed; a
  sender that can never be granted refused even when its host is approved; revoke and deny without reload; a page
  cannot edit the lists; the stream port.
- `tests/e2e/site-access.spec.mjs`: the hostile site, against a real browser.

The vm harness approves a test sender's origin unless `loadBackground({ siteGate: true })`, and gives a URL-less test
sender a page at `https://page.test/`, because a real content script always has one. The e2e harness's `waitForMl`
approves the page's origin unless `{ approve: false }`.
