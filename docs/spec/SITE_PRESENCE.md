# Spec: a site sees window.ml only when the person said it may (decided 2026-10-14)

**Status: decided; step 1 of the Order built** (without the two CDP field fixes, out of scope with input simulation); **step 2a built** (hidden by default: the page scripts are registered for allowed origins only and injected on demand for a run the person starts); **step 2b built** (the MessagePort); **the visible mark built** (the ask stub, slice 3 PR 4b). Replaces slice 4 of [SITE_ACCESS.md](SITE_ACCESS.md) and comes after slice 3's PR 2
(the agent level). It answers the measurement in [detection-surface.md](../dev/detection-surface.md): any page, approved or
not, can tell today that the person has window.ml and learn its extension id, with no run and no approval.

Decided with the owner on 2026-10-14: a page the person has not marked sees nothing of window.ml, and the person can
mark a page so it sees the API and may ask for access. "I do not want page X to know I have this installed, but I do
want page Y to know."

## The rule

Each origin has a **presence** below the levels it already has (use, agents, self-approval):

- **Hidden** (the default for any origin the person has not marked, and for every denied origin). We put nothing into
  the page: no `window.ml`, no main-world script, no `attachShadow` patch, no `__ml*` global, no window message, no
  element, no iframe. The content script's relay drops anything the page posts without answering it. Today's refusal
  text ("Refused: <origin> is not approved...") is itself a sign the extension is installed, so a hidden page gets no
  answer at all.
- **Visible.** The page has `window.ml`. Before it may use it, that is the slice 4 stub: `ml.requestAccess()` and
  nothing else. Once allowed, the full API, as today.

Allowing an origin to use `window.ml` (any of the existing levels) makes it visible. Revoking or denying makes it
hidden. A denied origin and an unknown one look the same to the page: nothing.

The person marks an origin visible from the popup's "This site" block. The existing "Let sites ask for access" setting
becomes the default presence for unknown origins: **off** (decided), so unknown sites are hidden and cannot discover the
extension or ask unprompted. On, every unknown origin is visible with the stub, which is SITE_ACCESS.md's slice 4 as
written. `requestAccess`'s rules (one prompt per origin, a gesture, the caps) apply unchanged, and only on visible
origins.

Presence is per exact origin, like every other level (Q19 of the slice 3 reference).

## What a hidden page still sees during a run the person starts

A run the person starts on a hidden page works, as it does on an unapproved page today: the run is built by the worker.
The page must learn as little as possible from it:

- **Tools run in the content script's isolated world.** On a hidden page nothing of ours enters the main world: not
  `shadow-patch.js`, not `injected.js`. The page-side tool stack (every `realm:"page"` tool and the geometry reads that
  `look`, `locate` and `verify` make) is built a second time as a bundle the worker puts into the content script's world
  with `executeScript` (`world: "ISOLATED"`), and `content.ts` hands it `RUN_TOOL_IN_PAGE` in-process; nothing is posted
  to the window. RULED 2026-10-27: that world, not a userScripts world and not a CDP isolated world (`exec-routing.ts`,
  which stay for an approved exec that names a pointer): both lack `chrome.dom`, and the second needs a debugger attached
  per call. A hidden page loses the page's own globals in the read-only survey (isolated exec already lacks them) and
  `exec` `world:"page"` (already refused there). An `exec` that needs the page's own globals asks for the main world on
  its card, and the card says the page can see that exec. A page that wraps its builtins never sees a hidden-page tool
  call: the isolated world has its own (the residual in "What stays visible" below, and detection-surface row 6, are
  for visible origins only).
- **Closed shadow roots** are read with `chrome.dom.openOrClosedShadowRoot` from that world, roots attached before the
  run started included (the late main-world patch misses them today), so a hidden page needs no `attachShadow` patch.
  Where that API is missing, closed roots are unreadable on hidden pages and the tool says so (the slice 2 open item
  "`chrome.dom` has no fallback").
- **The approval card and the transcript live in Chrome's side panel** (`chrome.sidePanel`), never in the page's DOM.
  This also closes the open item "clickjacking over the approval card via a page top-layer element": a page cannot draw
  over the side panel.
- **A highlight on the target of a waiting click or type** is the only thing drawn in the page: a host element with a
  random custom-element name per session, a closed shadow root, no `ml-` id, class or attribute, present only while the
  approval waits.

What stays visible, and is not removed: synthetic input is untrusted. CDP input is trusted and now carries the
W3C/hardware envelope (move→press→release, `pressure` 0.5 while pressed, `key`/`code`/`keyCode` cross-mapped —
`src/input-dispatch.ts`); what still distinguishes it from a person is timing and cadence, not the event fields.
A CDP click is at the target's centre. Input simulation beyond that envelope (human timing, trajectory) is out of
scope here and is the `lab/user-dynamics` topic.

## A visible page

The page is allowed to know window.ml is there, so the goal on a visible page is that it reads nothing of the person's
runs it was not given, not that it sees nothing:

- **The main-world script is a content script**, registered by the worker with
  `chrome.scripting.registerContentScripts({ world: "MAIN", runAt: "document_start", matches })` for the visible
  origins, and re-registered when the list changes. No `<script src="chrome-extension://...">` tag, so `injected.js`
  leaves the web-accessible list. Match patterns cannot name a port, so the script checks `location.origin` against the
  exact origin and stops, and the relay checks the sender's origin again.
- **The sidebar files** stay web-accessible (the overlay iframe needs them) with `use_dynamic_url: true`. As built: a
  page that knows the extension's id loads none of them by it (attack 16e); the overlay loads `sidebar.html`, and the
  sidebar `mermaid.html`, by the URL `getURL` names.
- **A MessagePort replaces window messages** between the main-world script and the content script. The main-world
  script runs at `document_start` before any page script, creates the channel and hands one port to the content script;
  `PAGE_TOOL_RUN` and its siblings then never cross the page's window. The page still shares the world the main-world
  tools run in (rows 4 and 6 of the measurement), so this hides a run's traffic from spontaneous page code only.
  As built (`src/page-channel.ts`): the hand-off is a synchronous `ml-page-port` event on `window`. The isolated side keeps
  the first port it is handed while armed: from document_start, and again after the worker's `PAGE_PORT_ARM`, which
  `injectPageScripts` sends before every late injection and which drops any port held. On a page whose script is injected
  after it loaded (a restored tab on a visible origin; since step 3 never a run on a hidden page, whose tools are in
  the isolated world) the page ran first: one that listens for the hand-off, or keeps
  handing ports over, can still take the run's channel, which is no worse than the window was. The main side calls the
  port's builtins through copies kept at load, so on a visible origin a page that wraps them later gets no port; it still
  reads what injected.js sends through a wrapped builtin it calls (`tests/redteam-exec-shared-world.test.mjs`).
- **`console` is a parameter, not a swap.** The main-world exec already evaluates the model's code as
  `new Function("state", "ml", "src", "return eval(src);")` (`tools.ts`); `console` becomes a fourth parameter bound to
  the collector, so the page's own `console.log` lines no longer reach the model's result and the page's `console`
  stays native. `window.console.log` bypasses the collector and is not captured (fails safe). The CDP path for
  strict-CSP pages wraps the source as `((console) => { ... })(collector)`. The isolated world uses the same pattern.
- **`__mlCdpStream`** (strict-CSP pages with streaming only): the listener accepts only `bindingCalled` from the
  execution context it evaluated in, the wrapper deletes the global in its `finally`, and the model's view of a
  main-world exec's output says the page could write into it. A nonce or a per-run name buys nothing against a page
  that reads or enumerates either while the exec runs; the name is random per exec all the same (built in step 1), which
  stops a page that defines an accessor under a fixed name beforehand and takes the binding as it is installed.
- **`__mlClosedRoots` and `__mlPierceClosed`** move into closures.

## Redirects on auto-approved fetches

Found by #645. On the paths that are auto-approved for a whole origin (`fetch_url` and incognito renders on the start
origin and on origins a navigate was approved to, same-origin `ml.fetch`), a redirect is followed today, so the request
reaches an origin nobody approved before the body is withheld. `redirect: "error"` would break ordinary redirects
(http to https, a trailing slash, sign-in hops, Sheets' export), so:

- a hop is followed when it stays on the same registrable domain, upgrades http to https on the same host, goes to an
  origin already approved in this run, or is a pair the feature declares (`FETCH_SHEET`: `docs.google.com` to
  `*.googleusercontent.com`, which also pins today's unpinned follow);
- any other hop becomes a prompt that names the target.

A worker `fetch` with `redirect: "manual"` gets an opaque response with no `Location`. **Measure first** whether
`chrome.webRequest.onHeadersReceived` with `extraHeaders` reports the extension's own worker requests and their
`Location`; if it does, the worker fetches with `manual`, judges the hop, and re-issues the request itself. If it does
not, record that and choose between `declarativeNetRequest` rules and following with the body withheld (today).

## Tests

- **The measurement is the oracle.** Every `test.fixme` in `tests/e2e/detection-surface.spec.mjs` this spec removes is
  flipped to a passing test, and its row in `docs/dev/detection-surface.md` is updated. A hidden page's probe records
  no global, no DOM change, no window message and no fetchable extension file, before, during and after a run the
  person starts there (only the waiting highlight, anonymised).
- **Red-team:** a hidden page posting every page-started type gets no answer and no side effect; a hidden page cannot
  tell a denied origin from an unknown one; a visible page cannot read a run's tool traffic from the window; the port is
  not reachable by a page script that runs after `document_start`.
- **Upgrade:** an origin allowed before this spec is visible after it; a denied one hidden; the stored "Let sites ask"
  value of an install that set it keeps its meaning.
- **Redirects:** a local server redirecting same-site, http to https, to an approved origin, to an unapproved origin,
  and a chain mixing them.

## Order

1. The `console` parameter, `__mlCdpStream`, the closures and the one-field CDP fixes (no UI, no new string).
2. Presence in storage, the main-world content script, `use_dynamic_url`, the MessagePort, the silent relay, the popup
   and Settings rows (new strings: owner approval).
   FOUND 2026-10-27 by the janitor on the built step 2a: a document loading between a site turning visible and its
   registration covering it answers `open: true` with no injected.js in it. The security lane's own `@security` PR,
   after #1189: #1206 MERGED 2026-10-28 at 295affd2, verified (with the janitor's one finding fixed in it: a failed
   inject no longer leaves its document marked as injected, with a red-team row). Step 3's build sits on the lane's
   `feat/hidden-isolated-tools-v2` (the tools' unit suites run against the isolated bundle too, a CI step; the
   hidden-with-run trace asserts no `ml` global); its PR opens after the red team's five-property PR, which follows #1203: #1228 MERGED 2026-10-28 at 46065d09
   (the hidden-page step-3 properties failing-first and the :272/:309 ruling split), verified. The lane's step-3 PR is
   #1236 MERGED 2026-10-28 at 3967b0df (CI green on run 40715649572; the janitor's dedupe finding fixed at 33d20d03 before the merge; the lane's clone removed), verified. It opened as #1236 OPEN (from `feat/hidden-isolated-tools-v2` with main and #1228 merged in, `@agent,@security`, janitor
   reviewer; the lane reports the red team's nine rows passing under step 3, five with a setup change to the step-3
   shape through the harness's `pageRealm`/`isolated` options and their assertions unchanged, which the red team is
   checking; the eight site-access e2e rows that held a port now find none; the red team's setup review passed with two findings fixed, head fbd2f8b2), verified 2026-10-28; the red team flips (told the hour it merged): #1259 MERGED 2026-10-28 at f4d8bb78, test-only, `tests/redteam-presence.test.mjs`, the janitor's review in its comment 6474314462, verified, so step 3 is closed on main; the attack-13 flake's test-only PR is #1255 OPEN (2026-10-28, `tests/e2e/site-access.spec.mjs` only, verified)
   the nine todos once it has merged.
   As built: the content script says `PAGE_SCRIPT_MISSING` once when its gate opened and no hello came within 1.5 s; the
   worker reads the presence of the sender's own origin (top frame, its named document only) and, when it is `full`, puts
   the page scripts into that document. `injectPageScripts` gives a document them once.
3. Tools in the content script's isolated world on hidden pages (the second bundle, behind no switch; the tools' tests
   run against both bundles; detection-surface's hidden-with-run `pageEvents` row goes to `[]`; rule 10: a separate
   agent's test-only red-team PR on main first, the lane's PR after), and `chrome.dom` for closed roots. Exec's default world is now a switch
   (`execDefaultWorld`, else the build's `__EXEC_DEFAULT_WORLD__`), and a call can ask for `world: "page" | "isolated"`.
   RULED 2026-10-28 (found by #1236's CI): an origin approved while a run the person started there is live gets
   `window.ml` on that page's NEXT document, not the current one. The document already holds the run's tools in the
   isolated world, its gate is open for the run, and those tools are its one set of page scripts: `PRESENCE_CHECK` sees
   the gate open and the script alive and skips it, which is the rule above (`injectPageScripts` gives a document its
   scripts once, in one world) and not an exception to it. Putting `injected.js` into MAIN beside the isolated tools
   would give one document two page scripts over one content-script channel slot, a second port or a re-arm that
   orphans the run; that is a channel design of its own, taken up only if someone is measured needing `window.ml` on
   the very page a run is on before it reloads. The run is unaffected; no new UI string; a cross-page e2e that
   approves a site models the approval before the reload. Separately fixed in #1236: a visible origin's document that
   loaded before its registration and asks `needInject` at adopt gets the page scripts in MAIN, not the isolated tools,
   which would have suppressed `PAGE_SCRIPT_MISSING` for good (unit row, mutation-checked).
4. The side panel for the card and the transcript, and the anonymised highlight. RULED 2026-10-28 on the security
   lane's survey (main at 3e9f91b7: a hidden page during a user-started run gets `div#ml-sb-card` and
   `div#ml-sb-root-hl` today; `chrome.sidePanel` is used nowhere): (1) scope is hidden pages only, as this section
   reads; a visible page keeps today's overlay, card and devtools surfaces, and moving its card to the panel later is a
   UI decision, not this step. (2) `chrome.sidePanel.open()` needs a user gesture, and a user-started run begins on one
   of our surfaces, so the start click opens a per-tab panel for the run's tab (`setOptions` with the tab id, enabled
   for the run, disabled when it ends); a gate that waits while the person has closed the panel shows the action badge
   and waits, with the action set to open the panel on its click (that click is the gesture), and draws nothing in the
   page but the highlight; the badge text and the panel's empty and closed states are new strings, named in the PR
   body. AMENDED 2026-10-28 on the lane's 4b question: the action has a popup (`action.default_popup` in
   `manifest.json`), and while it does the action click opens the popup, not the panel. The popup is the gesture:
   the badge (`sw-badge.ts`), which already counts start asks per tab, also counts gates waiting on a hidden-page
   run whose panel is closed, and the popup shows one "Open panel" row per such tab, naming the tab, whose click
   calls `chrome.sidePanel.open` for that tab. The popup's existing Show for a start ask, which brings up the
   in-page card today, opens the panel instead on a hidden page. No per-tab popup state and no
   `openPanelOnActionClick`: a popup cleared per tab would have to be rebuilt after a worker restart and would take
   the popup away on that tab while the gate waits, for one click saved. The row's text is a new string, named in
   the PR body. AMENDED 2026-10-28 on the lane's measurement (Chromium 151: `sidePanel.open` must run before the
   gesture handler's first await, and rejects "No active side panel" on a tab whose panel is disabled, while an
   un-awaited `setOptions` followed by `open` in the same tick succeeds; the panel page loads only while its tab is
   active): the panel is enabled per tab whenever the tab's top document is HIDDEN, and disabled when it is visible,
   written on the navigation commit and by the site-list sync that already walks the open tabs; it no longer follows
   the run. A start gesture that lands in the worker (Alt+Space, the context menu) calls `sidePanel.open` for the
   tab synchronously: success is a hidden page and the panel's composer opens; "No active side panel" is a visible
   page and the in-page composer opens as today, once the presence read confirms it; a read that says hidden after
   all (a navigation race) mounts nothing in the page, leaves the panel enabled and shows the badge. A run's end
   leaves the panel enabled, showing the run as finished, empty after the next navigation. The invariants the red
   team's rows keep: the decision is the browser's answer, never anything the page posts; nothing of the panel's
   state reaches the page; the enablement is rebuilt from the open tabs when the worker starts, so a restart cannot
   leave a hidden tab without its start surface (the lane measures whether Chrome keeps per-tab options across a
   worker restart and says so in the PR body). The panel page is not among Playwright's pages; the e2e reaches it
   through a CDP target or opens its document as a tab, in `docs/dev/e2e-harness.md`. Alternative rejected: enabling
   at run start would leave the two gestures that matter most on a hidden page doing nothing there, with a new popup
   row as the only start. (3) Two PRs: 4a the highlight, 4b the panel. The highlight is one implementation on every page (random
   custom-element name per session, closed root, no `ml-` id, class or attribute, present only while the approval
   waits), the e2e selectors moving to one helper, so there is no second drawer for visible pages; row 7 of
   `docs/dev/detection-surface.md` splits, the card part staying "No" for visible origins. (4) Rule 10 as for step 3:
   the red team's failing-first rows land on main first, in its own file (for a hidden page with a user-started run:
   `domAdded` is only the anonymised host while an approval waits, no `ml-` token in the DOM before, during or after,
   no `sidebar.html` frame, no popover attribute of ours, the visible page's card as the control); 4a merges after
   them, 4b after 4a, the red team flipping after each. RULED the same day, on the lane's conflict: the anonymised
   host keeps `popover="manual"` and the top-layer keeper (`shell-top-layer.ts`), so a page's own modal, fullscreen
   element or popover cannot cover the box marking what the person is approving; `popover` is not a name of ours,
   and the host is already the one thing `domAdded` shows. The host carries exactly its random tag name, `popover`
   and an inline `style`; everything else of ours, the stylesheet with id `ml-sb-style` that the CDP shadow resolver
   looks for included, lives inside the closed root, which a page cannot read. The red team's row reads "no popover
   attribute of ours except on the anonymised host".
   4a is #1279 OPEN 2026-10-28 (head 4c2c9db4, @security @ui; `src/sidebar/shell.ts`, `src/dom/dom.ts`, `src/ids.ts`;
   the host anonymous under ruling (a), in the page only while a box is drawn, one implementation in every mode; the
   e2e harness reads the highlight through `highlightTag`/`highlightBox` in `tests/e2e/harness.mjs`, and a test
   reaches the host's tag through `inShell`'s `roots.highlightTag`; detection-surface row 7 split into 7, the card,
   "No" on a visible page, and 7b, the anonymised highlight; the janitor asked by session-mail), verified; it holds
   until the red team's rows PR has merged.
5. The redirect measurement, then the rule.

After step 2, and deferred: consuming a page's WebMCP tools (`document.modelContext`) as a window.ml adapter, with the rules
this spec forces on it: [WEBMCP_COMPAT.md](WEBMCP_COMPAT.md).
