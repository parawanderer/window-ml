# What a page can observe about window.ml

A measurement, not a design: for each signal an anti-bot script (or any hostile page) reads, whether window.ml gives it
off, for which action, and what removing it would cost. Measured 2026-10-14 against Chrome for Testing 151 on macOS, by
`tests/e2e/detection-surface.spec.mjs`. The request it answers came from another project's session, written from reading
the source; where it was wrong about how the tool works is the last section.

Two kinds of finding are mixed in the table and separated at the end: what is a security or privacy issue for
window.ml's own model (a page identifying that the person has window.ml, reading or tampering with something of ours),
and what only makes the browser look automated.

## How it is measured

- **The probe** (`tests/e2e/fixtures/detect/probe.js`) is each page's first script. From the page's main world it records,
  as a change log with timestamps: globals added, the DOM (a MutationObserver on the document), window messages (with a
  ping of its own every half second, so an empty list is a fact about the window and not a listener that never ran), the
  two events injected.js dispatches on `window` by name (the port hand-off and `ml:ready`), console identity and
  native-ness, the stacks of whoever calls `querySelector*`, `getBoundingClientRect`, `elementFromPoint`,
  `dispatchEvent` and `focus` (it wraps them, as a detector would), every input event with `isTrusted`,
  `navigator.userActivation`, coordinates, `pointerType`/`pressure`/size and `key`/`code`, focus, visibility, inner/outer
  size, rAF rate, `freeze`/`resume`, and four console-getter shapes of the `Runtime.enable` tell. It learns the extension's
  id wherever it shows up and then fetches its web-accessible files. It posts to the probe server, so nothing has to
  attach to the page to read it.
- **The probe server** (`tests/e2e/fixtures/detect/server.mjs`) answers several hostnames as distinct origins (`probe.test`
  approved, `other.test` not, `xo.test` in a cross-origin iframe, `api.test` with a cookie of its own), treated as secure
  contexts so the browser sends `Sec-Fetch-*`, and records the headers of every request.
- **The browser** (`tests/e2e/fixtures/detect/clean-browser.mjs`) is the Playwright Chromium binary launched without
  Playwright: Playwright attaches a debugger client to every page it drives, so under `harness.mjs` the page has a CDP
  client before the extension does anything. Here the tests talk CDP to the browser and to the extension's service worker
  only, start runs through `__mlStartUserRunForTest` with a fake model, and approve gates through `__mlApprovals`. A
  recorder wraps `chrome.debugger.sendCommand`/`attach`/`detach` in the worker, so each row also lists every CDP command
  the extension sent.
- **Run it:** `npx playwright test tests/e2e/detection-surface.spec.mjs` (about 40 s). `DETECT_PUBLIC=1` adds the public
  detector pages (network); `DETECT_HEADFUL=1` shows the window. Raw rows land in `tests/e2e/artifacts/detection-surface/`.

Limits: headless (no browser UI, so no infobar); `navigator.webdriver` is true in every launch this harness can drive
(headless, and `--remote-debugging-port` alone, measured headful), so it is watched for a change, never compared with a
false baseline; the "by hand" baseline is Playwright's CDP input, which is not a person's; timing (typing cadence,
time-on-page) is not measured.

## Results

Actions: **installed** (the page merely loaded with the extension present, approved or not), **run** (anything a run
does), exec-main (approved page), exec-iso (unapproved page, a CDP isolated world; user scripts are not available in this
browser), exec-strict (a `script-src 'self'` page: the main world through CDP), `+stream` (the run's `stream` option),
click-sel (selector), click-cdp (canvas, sealed shadow, cross-origin iframe), type-sel, type-cdp (sealed field), look,
locate, navigate, fetch_url, rendered (`fetch_url` with `rendered`+`credentials`), b64 (`ml._fetchImageBase64`). Test
names are the spec's.

| # | Signal | Fires for | How we know | Removable? | Cost of removing |
| --- | --- | --- | --- | --- | --- |
| 1 | `window.ml` global, 71 members | an origin the person allowed (always, session or self-approve), from document_start; a stub `window.ml` holding only `requestAccess` on an origin the person let ask (or every unknown origin with "Let sites ask for access" on); since SITE_PRESENCE step 2 a HIDDEN page (any other origin) has none until the person starts a run there, when the worker injects it into that document | "an UNAPPROVED page…" (`expectHiddenTrace`: no `ml` in `globalsAdded`); site-access.spec "attack 1: is hidden…" | Done for hidden pages; on an allowed origin it is the point | A run on a hidden page shows the page window.ml from its start on |
| 2 | `Element.prototype.attachShadow` non-native (`name` "patched"), and a reader of the captured closed roots handed to a page that dispatches `wml-closed-roots` on window before injected.js does (once). No `__mlClosedRoots` global since step 1 | visible origins only, from document_start (registered with injected.js since step 2); a hidden page with a run, from the run's start | `attachShadowNative` false on an approved page, true on a hidden one; `closedRootReaderAtLoad` false: injected.js now runs at document_start and claims the reader before any page script | Done for hidden pages | A closed root a hidden page made before a run started there is unreadable to that run |
| 3 | `<script src="chrome-extension://<id>/injected.js">` added then removed | **fixed** (step 2): injected.js is a registered MAIN-world content script, no tag | `domAdded` has no script; `extIdLearnedBy` [] at load on an approved page (no page wrapper sees its stack) | Done | None |
| 4 | The extension's id and function names in stacks | installed (injected.js's ready event through `dispatchEvent`); every page-realm tool (`querySelector*`, `getBoundingClientRect`, `elementFromPoint`, `focus`, `dispatchEvent`); exec-main (`eval at run (chrome-extension://<id>/injected.js…)`, `executeTool`, `runDelegatedToolIn`) | `extensionCallers`, `pageCallCaller`, `caughtStack` | Not while tools run in the page's world: any page can wrap a builtin and read `new Error().stack`. exec-strict shows bare `<anonymous>` frames; exec-iso shows nothing | Moving page tools to an isolated world loses main-world parity (page globals) |
| 5 | Web-accessible `sidebar.html` (200) fetchable by id; `mermaid.html` and `mermaid-frame.js` too, saying nothing `sidebar.html` does not; framed by any other origin, the frame answers nothing (`ancestorOrigins`, mermaid-frame.ts). injected.js is no longer listed (step 2) | installed, once a page knows the id | `warFetch` null on a hidden page: its probe learns no id to fetch with | Done: `use_dynamic_url` (manifest.json). By the id, every file is refused (attack 16e); only the per-session URL that `getURL` names loads them, and nothing puts it on the page (the overlay frame sits in a closed shadow root) | Measured: `getURL` of a web-accessible file returns the per-session URL in the worker and the content script alike, while `getURL("")`, the extension's pages and a framed file's own document keep the id |
| 6 | Window messages | **fixed** (SITE_PRESENCE step 2b): none. injected.js talks to content.js and the shell on a MessagePort (`page-channel.ts`), handed over by one `ml-page-port` event on `window` at document_start, before any page script. Residual: on a page given injected.js after it loaded (a run on a hidden page, a restored tab) a page listener sees the hand-off and can take the port, or race the injection with its own; a page that wraps a builtin injected.js's tool code calls still reads what it is given | `messages` (empty in every span, with the probe's own ping heard as the control), `pageEvents` (the hand-off and `ml:ready`: none on a visible page, both on a hidden page given injected.js for a run); site-access.spec "attack 2…" (`{ timeout: true }` for every raw request); `tests/redteam-exec-shared-world.test.mjs` (the prototype wrap, a todo) | Done for page listeners; not for a page that rewrites builtins | The page still shares the world the tool code runs in |
| 7 | `div#ml-sb-card[popover]` on `<html>`, and `div#ml-sb-root-hl[popover]` for a click/type highlight (when drawn before the gate is answered) | run (HUD quiet) | `domAdded`, `domAttrs` | No | It is the person's view of the run |
| 8 | Window `blur`, focus on `#ml-sb-card` | gated calls (approval card) | "an approval moves focus…" | Probably: do not focus the card | Keyboard approval |
| 9 | `__mlPierceClosed` global | **fixed** (SITE_PRESENCE step 1): the flag is a module variable in `dom.ts`, set per run | `globalsAdded` has no `__mlPierceClosed` (`expectRunTrace`) | Done | None |
| 10 | **Fixed** (SITE_PRESENCE step 1): `console` is a parameter of the exec's code bound to the collector, never a swap, in all three paths; the page's console stays native and its own lines stay out of the result. `window.console`/`globalThis.console` from the exec are the page's and are not collected | exec-main, exec-strict | `consoleSwapped` [] during and after; `results[0]` does not contain "page says during exec" | Done | `globalThis.console.log` from the model's code is not captured (fails safe) |
| 11 | `__mlCdpStream` on the page's global while a strict-page exec with streaming runs; gone after it since SITE_PRESENCE step 1 (the wrapper deletes it in its finally, `Runtime.removeBinding` does not) | exec-strict+stream only | "strict-CSP page with streaming…": `during.mlCdpStream` true; "__mlCdpStream is gone…": `final.mlCdpStream` false | Done for after the exec; during it the page shares the context the listener trusts | `Page.getFrameTree`, `Runtime.disable` and `Runtime.enable` per strict exec, to learn the context every evaluate is pinned to |
| 12 | `Runtime.enable` console-getter tell (Error `stack`/`message`/`name` getters, a function's `toString`) | **never**: no shape changes when a client enables Runtime | "a debugger client's Runtime.enable is invisible…" (controlled attach, no extension); rebrowser's `runtimeEnableLeak`: "No leak detected" | — | — |
| 13 | Selector click: one `click`, `isTrusted` false, no pointer/mouse down/up, client and screen (0,0), no activation, injected.js on the stack | click-sel; also a canvas with `cdp` off | "selector click…", "canvas click with CDP off…" | Only by making every click a CDP click | The debugger attached on every page a run clicks |
| 14 | CDP click: trusted pointermove/mousemove then pointerdown/mousedown/pointerup/mouseup/click with activation; `pressure` 0.5 while pressed, 0 otherwise; size 1x1; the exact centre; `screenX` = `clientX` + the window's `screenX` | click-cdp (canvas, sealed, iframe; the frame's own probe sees it) | "canvas click (CDP)…", "sealed…", "cross-origin iframe…" | Matched to Playwright's baseline (`input-dispatch.ts`, `cdpClickPlan`) | Timing/cadence still differ from a person |
| 15 | Isolated-world `el.click()`: `isTrusted` false but user activation true | exec-iso | "isolated world (unapproved page, CDP)…" | Drop `userGesture: true` | Popups/clipboard from an isolated exec |
| 16 | Typing by selector: `input` + `change` only, untrusted, no key events | type-sel | "type by selector…" | Only by CDP typing | The debugger per typed field |
| 17 | CDP typing: trusted keydown/keypress/beforeinput/input/keyup, `key`/`code`/`keyCode` the US-layout cross-map, Shift held around a capital | type-cdp | "type into a sealed field (CDP)…" | Matched to Playwright's baseline (`input-dispatch.ts`, `cdpTypePlan`) | Typing cadence still differs from a person |
| 18 | Infobar resize at a CDP attach | **not observed**: no UI headless; headful (Chrome for Testing 151, macOS) also 0 resizes, the infobar itself not verified on screen | `resizes` 0 in the CDP rows | — | Unverified on branded Chrome |
| 19 | Debugger attach/detach | one attach and one detach per run that uses CDP (not per click) | the recorder's `(attach)`/`(detach)` in each row | — | — |
| 20 | Focus emulation and lifecycle | rendered only, on the render tab: ends `visibilityState` visible and `hasFocus` true; a flip the probe records is hidden→visible (macOS usually, Linux already visible at the probe's first look), `visibilitychange` ≥2, rAF never in the throttled `0`/`1-4` buckets; never on the run's tab; no `freeze`/`resume` ever | "rendered fetch…" | — | — |
| 21 | `Emulation.*` | `Emulation.setFocusEmulationEnabled` (and `Page.setWebLifecycleState`), rendered only | "the extension sends no Emulation.* command…" (static) + the recorder | — | — |
| 22 | `navigator.webdriver`, `HeadlessChrome` | the harness, not the extension: not flipped by `chrome.debugger.attach` | "no extension…", `webdriverChanges` [] in "canvas click (CDP)…" | — | — |
| 23 | `chrome.runtime` reachable from the page | **no**: no `externally_connectable` | `env.hasRuntime` false | — | — |
| 24 | Navigation | navigate: a same-origin document request with a Referer and no `Sec-Fetch-User` (no user activation) | "navigate…" | Partly: `chrome.tabs.update` gives a browser-initiated request (`Sec-Fetch-Site: none`, no Referer), also not a click | — |
| 25 | Worker requests | fetch_url: `Sec-Fetch-Site: none`, `mode: cors`, `dest: empty`, no Referer/Origin, `Accept-Language: en-GB` where the page sends `en-GB,en;q=0.9`, and a second request for `<path>.md`; the cookie only with `credentials` | "fetch_url from the worker…", "…with credentials" | `Accept-Language` yes (set it); the `.md` twin is Markdown negotiation | The negotiation |
| 26 | `FETCH_IMAGE_B64` | b64: no cookie and no Referer since #646 (`credentials: "omit"`, `no-referrer`); a third `Accept-Language` on macOS (`en-GB,en-US;q=0.9,en;q=0.8`; the page's own value on Linux); an HTML page of another origin is refused, only a raster image is read back | "page-started ml.fetch is refused…; FETCH_IMAGE_B64 reads another origin's image with NO cookie, and refuses its HTML" | Fixed in #646 | None |
| 27 | Rendered fetch | a real tab on the target site with the person's cookie, `Sec-Fetch-Site: none` navigation with no `Sec-Fetch-User`; window.ml there only when the person allowed that origin (hidden otherwise, since step 2) | "rendered fetch…" | — | Rendering |
| 28 | look, locate | nothing on the page beyond the card (CDP on: `Page.captureScreenshot`; off: `captureVisibleTab`) | "look and locate…", "look with CDP off…" | — | — |

Not measured: `FETCH_SHEET` (hard-locked to `docs.google.com/…/export?`, unreachable locally), the TLS/HTTP2 fingerprint
(every request here is the browser's own network stack), typing cadence, an `@pt` canvas click with `cdp` off (the
`clickAt` path: synthetic pointerdown/mousedown/pointerup/mouseup/click, read from `builtin-tools.ts` only).

## Public detectors

Run headless with `DETECT_PUBLIC=1`, raw text and screenshots in `tests/e2e/artifacts/detection-surface/public-*`:
no extension, installed, and (rebrowser only) an exec-main calling `dummyFn()`, `getElementById`,
`getElementsByClassName`.

- **rebrowser-bot-detector** (bot-detector.rebrowser.net): `navigatorWebdriver` and `useragent` (Chrome for Testing
  brands) fire in all three, from the harness. `runtimeEnableLeak`: no leak in all three. With the exec, `dummyFn` and
  `mainWorldExecution` fire (main-world access, as designed), and `sourceUrlLeak` rates it clean (it looks only for
  `pptr:` and `UtilityScript.`) while its debug stack shows `eval at run (chrome-extension://<id>/injected.js…)`.
- **bot.sannysoft.com**: identical with and without the extension (WebDriver "present (failed)" from the harness).
- **CreepJS**: "100% headless" and "31% like headless" with and without the extension; its `extension` field "unknown".
- **BotD** (no hosted demo any more; its CDN build on a blank page): `{"bot":true,"botKind":"headless_chrome"}` in both.
- **BrowserScan**: its verdicts are icons, the text is identical in both runs.

None of them checks for window.ml itself; every verdict they reach here is the harness's headless/automation markers.

## Security and privacy findings (window.ml's own model)

Ranked; each also in the table.

1. **`FETCH_IMAGE_B64` was credentialed** (row 26), fixed in #646. The handler called `fetch(url)` with the default
   credentials mode, and a worker fetch to a host the extension has permission for carries that host's cookies. An
   approved page read any non-private URL's bytes as the person, HTML included. It now names `credentials: "omit"` and
   reads only a raster image (`src/sw/sw-image-fetch.ts`); the spec asserts no cookie and the HTML refused.
2. **Any page identifies window.ml and learns its id**, with no run and no approval (rows 1-5): `'ml' in window`,
   `'__mlClosedRoots' in window`, `attachShadow`'s source, the injected `<script>`, the stack of injected.js's ready
   event, and a 200 from `chrome-extension://<id>/injected.js`. That fingerprints the person as a window.ml user on every
   site they visit. `test.fixme` in the spec.
3. **A run's tool calls are readable by the page** (rows 4, 6): `PAGE_TOOL_RUN` carries the tool name and arguments,
   no longer on the page's window (step 2b) but on a port a page given injected.js late can take, and page-realm tools
   call builtins the page can wrap. Inherent to tools that run in the page's world
   (docs/dev/site-access.md, "Adding a tool"), listed because it is also the strongest detector.
4. **The page writes into the model's exec result** (row 10). Fixed for the page's own `console.log` lines (SITE_PRESENCE
   step 1, `tests/redteam-exec-console.test.mjs`): `console` is a parameter of the exec's code, bound to a null-prototype
   collector. A page function the exec calls can reach the wrapper functions (`.caller`, a stack frame's `getFunction()`);
   each is one-shot, so the page cannot evaluate code of its own beside the collector, `state` and `ml`, nor run the
   approved script again (#652 review). What remains is inherent to sharing the world: the page can rewrite the builtins
   the collector and the value's serialisation call (`Array.prototype.map`, `JSON.stringify`), throw an error with a
   stack of its choosing, and read the delegated path's `PAGE_TOOL_RESULT` by wrapping `MessagePort.prototype.postMessage` (row 6). The model reads every
   main-world exec result under a first line `page-writable (ran in page world):` (`PAGE_WORLD_HEAD`, output-clip.ts): the
   console, the `value:` (the page's own `JSON.stringify`) and an error the script threw. The console section is the plain
   `console:`. An isolated-world exec and a read-only survey carry no heading, and that absence is what tells the model
   they are not page-writable. Not labelled: a refusal or note the extension wrote itself (a CSP-blocked eval, CDP off).
   The sidebar's `toolFailed` skips the heading line. The open vectors are `todo`s in `tests/redteam-exec-shared-world.test.mjs`.
5. **`__mlCdpStream` outlived the exec** (row 11). Fixed: the wrapper deletes it in its finally, its name is random per
   exec (a page cannot define an accessor under it beforehand), and the listener takes `Runtime.bindingCalled` only from
   the context the wrapper evaluated in: the top frame's main world, learnt by turning Runtime off and on so it reports
   every live context, and passed as `contextId` to every evaluate. Turning Runtime off is safe for a concurrent CDP user
   on the tab: measured in Chromium 151, it keeps bindings, isolated worlds, remote objects and pending awaited
   evaluates. A frame's or another world's context is refused. The page's own scripts run in that same context and can
   still find and call it during the exec: inherent, the `todo` in `tests/redteam-isolated.test.mjs`.
6. **`__mlClosedRoots` was a page-writable WeakMap** (row 2). Fixed: the map is in shadow-patch's closure, filled and read
   through builtins taken at document_start, and its read-only reader is handed out ONCE, to the ask injected.js makes as
   it starts; a page that asks first gets the reader of its own roots and leaves the tools without one (piercing off,
   fails closed) (`tests/redteam-exec-console.test.mjs`, `tests/redteam-exec-shared-world.test.mjs`). The page can
   still answer the tools' ask itself before injected.js starts (wrapping `dispatchEvent`, or `document.open()`, which
   removes the patch's listener), and decides what the tools see behind its own hosts by redefining the builtins they
   call (`el.shadowRoot`), as for any main-world tool (row 4).

Only "looks automated": rows 7-8, 13, 15-16, 20, 24-25, 27 (untrusted input, focus moves, script-started
navigation, worker request headers). CDP click/typing (14, 17) now match Playwright's baseline field-for-field;
what still separates them from a person is timing and cadence, not the envelope.

## Where the request was wrong

- **Attach per reserved click** (its leak 5): the worker attaches once per tab on first CDP use and keeps the attachment
  for the run, detaching at the run's end or after 20 s idle (`sw-cdp.ts`, `ensureDebuggerAttached`); the recorder shows
  one attach/detach pair per run. `docs/spec/CDP_CLICK.md`'s "attach → dispatch → detach" is out of date the same way.
- **`Runtime.enable` is detectable by the console-getter trick** (leak 1): not in Chromium 151, for any of four shapes,
  whoever enables Runtime. `Runtime.enable` is also sent unconditionally by the CDP isolated world (`runInCdpWorld`), not
  only with `onStream`.
- **The default click path is a synthetic `dispatchEvent` sequence** (leak 4): a selector click is `HTMLElement.click()`,
  a single `click` event. The pointer/mouse sequence (`clickAt`) is only for a canvas `@pt` with `cdp` off. And CDP is not
  only for reserved targets: with `cdp` on (the default) a canvas, an `@pt` and `@focus` typing go through it too.
- **`__mlCdpStream`** (leak 2) lands only on strict-CSP pages with streaming on (the normal main-world exec uses no CDP),
  and `Runtime.removeBinding` does not remove the global, as suspected.
- **Console swap** (leak 3): in the main world for exec-main and exec-strict; not visible from exec-iso. Removed since
  (row 10): `console` is a parameter of the exec's code.
- **Focus emulation** (leak 6) is used only by a rendered `fetch_url` on its own background tab, and that tab is made
  visible too (rAF never throttled), so "focused but hidden" does not occur. Whether the page records a hidden→visible
  flip or is already visible at its first sample is a race between the tab load and the CDP landing; both are the same
  product behaviour. **`setWebLifecycleState`** (leak 7) only ever sets `active`: no `freeze`/`resume` was seen.
- **`navigator.webdriver`** is true here because of the harness (headless, `--remote-debugging-port`), not
  `chrome.debugger`, which does not change it.
- **CDP `screenX`/`screenY` equal `clientX`/`clientY`**: no, they are offset by the window's position.
- **BotD demo**: its hosted demo is gone (404); BotD was run from its CDN build.
- Missing from the request: the `window.ml` global itself, the patched `attachShadow` on every page, the injected
  `<script>` tag, the window-message protocol, the HUD card in the page's DOM, and `FETCH_IMAGE_B64`'s cookies (fixed in #646).
