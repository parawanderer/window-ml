# Spec: a site sees window.ml only when the person said it may (decided 2026-10-14)

**Status: decided, not built.** Replaces slice 4 of [SITE_ACCESS.md](SITE_ACCESS.md) and comes after slice 3's PR 2
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

- **Tools run in an isolated world.** Surveys, the DOM tools, the click and type paths and `exec` default to the
  isolated world (userScripts or CDP), which already exists for unapproved pages (`exec-routing.ts`). An `exec` that
  needs the page's own globals asks for the main world on its card, and the card says the page can see that exec.
- **Closed shadow roots** are read with `chrome.dom.openOrClosedShadowRoot` from the isolated world, so a hidden page
  needs no main-world `attachShadow` patch. Where that API is missing, closed roots are unreadable on hidden pages and
  the tool says so (the slice 2 open item "`chrome.dom` has no fallback").
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
- **The sidebar files** stay web-accessible (the overlay iframe needs them) with `use_dynamic_url: true`.
- **A MessagePort replaces window messages** between the main-world script and the content script. The main-world
  script runs at `document_start` before any page script, creates the channel and hands one port to the content script;
  `PAGE_TOOL_RUN` and its siblings then never cross the page's window. The page still shares the world the main-world
  tools run in (rows 4 and 6 of the measurement), so this hides a run's traffic from spontaneous page code only.
- **`console` is a parameter, not a swap.** The main-world exec already evaluates the model's code as
  `new Function("state", "ml", "src", "return eval(src);")` (`tools.ts`); `console` becomes a fourth parameter bound to
  the collector, so the page's own `console.log` lines no longer reach the model's result and the page's `console`
  stays native. `window.console.log` bypasses the collector and is not captured (fails safe). The CDP path for
  strict-CSP pages wraps the source as `((console) => { ... })(collector)`. The isolated world uses the same pattern.
- **`__mlCdpStream`** (strict-CSP pages with streaming only): the listener accepts only `bindingCalled` from the
  execution context it evaluated in, the wrapper deletes the global in its `finally`, and the model's view of a
  main-world exec's output says the page could write into it. A nonce or a per-run name buys nothing (the page reads
  or enumerates either).
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
3. Tools in the isolated world on hidden pages, and `chrome.dom` for closed roots.
4. The side panel for the card and the transcript, and the anonymised highlight.
5. The redirect measurement, then the rule.
