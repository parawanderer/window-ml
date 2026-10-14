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
  as a change log with timestamps: globals added, the DOM (a MutationObserver on the document), window messages, console
  identity and native-ness, the stacks of whoever calls `querySelector*`, `getBoundingClientRect`, `elementFromPoint`,
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
| 1 | `window.ml` global, 71 members | installed, every http(s) page incl. unapproved | "an UNAPPROVED page sees window.ml…": `final.windowMl` 71 | Only `requestAccess` once slice 4 of SITE_ACCESS.md lands; the global itself stays | A page-callable API on unapproved pages is the open-slice design |
| 2 | `__mlClosedRoots` on window, `Element.prototype.attachShadow` non-native (`name` "patched") | installed, every page, from document_start | same test: `mlClosedRootsAtLoad` true, `attachShadowNative` false | Yes: register shadow-patch only for approved origins (`chrome.scripting.registerContentScripts`) | Closed-shadow piercing on unapproved pages; hiding the patch by faking `toString` is itself detectable |
| 3 | `<script src="chrome-extension://<id>/injected.js">` added then removed | installed, every page | `domAdded` has it, `extIdLearnedBy` "dom" | Yes: inject injected.js as a `"world": "MAIN"` content script | None known; it also stops needing injected.js as a web-accessible resource |
| 4 | The extension's id and function names in stacks | installed (injected.js's ready event through `dispatchEvent`); every page-realm tool (`querySelector*`, `getBoundingClientRect`, `elementFromPoint`, `focus`, `dispatchEvent`); exec-main (`eval at run (chrome-extension://<id>/injected.js…)`, `executeTool`, `runDelegatedToolIn`) | `extensionCallers`, `pageCallCaller`, `caughtStack` | Not while tools run in the page's world: any page can wrap a builtin and read `new Error().stack`. exec-strict shows bare `<anonymous>` frames; exec-iso shows nothing | Moving page tools to an isolated world loses main-world parity (page globals) |
| 5 | Web-accessible `injected.js` (200, 847 KB) and `sidebar.html` (200) fetchable by id; a made-up id fails | installed | `warFetch` | Yes: `use_dynamic_url`, and 3 removes injected.js from the list | A web store build's id is fixed, so today one `fetch` detects the install |
| 6 | Window messages | installed: `__mlSidebar`, `PAGE_ADOPT_HELLO`; run: `ADOPT_RUN`, `RUN_ADOPTED_NOW`, `RUN_READOPTED`, `PAGE_TOOL_RUN` (tool name and args), `PAGE_TOOL_RESULT`, `PAGE_TOOL_STREAM` (+stream), `ML_HL_RESOLVE`/`ML_HL_AT` (a point's highlight, when the card draws it before the gate is answered) | `messages` | Partly: a MessagePort between injected.js and content.ts | The page still shares the world the tool code runs in |
| 7 | `div#ml-sb-card[popover]` on `<html>`, and `div#ml-sb-root-hl[popover]` for a click/type highlight (when drawn before the gate is answered) | run (HUD quiet) | `domAdded`, `domAttrs` | No | It is the person's view of the run |
| 8 | Window `blur`, focus on `#ml-sb-card` | gated calls (approval card) | "an approval moves focus…" | Probably: do not focus the card | Keyboard approval |
| 9 | `__mlPierceClosed` global | run | `globalsAdded` | Yes: keep the flag in a closure | None |
| 10 | All five `console` methods replaced; the page's own console output collected into the model's tool result | exec-main, exec-strict | `consoleSwapped`, `results[0]` contains "page says during exec" | No in the main world (it is how output is captured); exec-iso swaps nothing visible | Capturing through `Runtime.consoleAPICalled` needs the debugger on every exec |
| 11 | `__mlCdpStream` on the page's global, still there after the exec, the run and the detach | exec-strict+stream only | "strict-CSP page with streaming…": `final.mlCdpStream` true | Yes (fixme): name the binding for a world, or delete it in the wrapper's finally | Streaming of strict-page execs |
| 12 | `Runtime.enable` console-getter tell (Error `stack`/`message`/`name` getters, a function's `toString`) | **never**: no shape changes when a client enables Runtime | "a debugger client's Runtime.enable is invisible…" (controlled attach, no extension); rebrowser's `runtimeEnableLeak`: "No leak detected" | — | — |
| 13 | Selector click: one `click`, `isTrusted` false, no pointer/mouse down/up, client and screen (0,0), no activation, injected.js on the stack | click-sel; also a canvas with `cdp` off | "selector click…", "canvas click with CDP off…" | Only by making every click a CDP click | The debugger attached on every page a run clicks |
| 14 | CDP click: trusted pointerdown/mousedown/pointerup/mouseup/click with activation; no move before it; `pressure` 0 while pressed; size 1x1; the exact centre; `screenX` = `clientX` + the window's `screenX` | click-cdp (canvas, sealed, iframe; the frame's own probe sees it) | "canvas click (CDP)…", "sealed…", "cross-origin iframe…" | `pressure` yes (fixme: `force: 0.5`); the move and the centre are input-humanising, out of scope | One field |
| 15 | Isolated-world `el.click()`: `isTrusted` false but user activation true | exec-iso | "isolated world (unapproved page, CDP)…" | Drop `userGesture: true` | Popups/clipboard from an isolated exec |
| 16 | Typing by selector: `input` + `change` only, untrusted, no key events | type-sel | "type by selector…" | Only by CDP typing | The debugger per typed field |
| 17 | CDP typing: trusted keydown/keypress/beforeinput/input/keyup, `code` "" | type-cdp | "type into a sealed field (CDP)…" | `code` yes (fixme) | One field |
| 18 | Infobar resize at a CDP attach | **not observed**: no UI headless; headful (Chrome for Testing 151, macOS) also 0 resizes, the infobar itself not verified on screen | `resizes` 0 in the CDP rows | — | Unverified on branded Chrome |
| 19 | Debugger attach/detach | one attach and one detach per run that uses CDP (not per click) | the recorder's `(attach)`/`(detach)` in each row | — | — |
| 20 | Focus emulation and lifecycle | rendered only, on the render tab: `visibilityState` hidden then visible, `hasFocus` false then true, 4 `visibilitychange`, rAF ≥40 Hz; never on the run's tab; no `freeze`/`resume` ever | "rendered fetch…" | — | — |
| 21 | `Emulation.*` | `Emulation.setFocusEmulationEnabled` (and `Page.setWebLifecycleState`), rendered only | "the extension sends no Emulation.* command…" (static) + the recorder | — | — |
| 22 | `navigator.webdriver`, `HeadlessChrome` | the harness, not the extension: not flipped by `chrome.debugger.attach` | "no extension…", `webdriverChanges` [] in "canvas click (CDP)…" | — | — |
| 23 | `chrome.runtime` reachable from the page | **no**: no `externally_connectable` | `env.hasRuntime` false | — | — |
| 24 | Navigation | navigate: a same-origin document request with a Referer and no `Sec-Fetch-User` (no user activation) | "navigate…" | Partly: `chrome.tabs.update` gives a browser-initiated request (`Sec-Fetch-Site: none`, no Referer), also not a click | — |
| 25 | Worker requests | fetch_url: `Sec-Fetch-Site: none`, `mode: cors`, `dest: empty`, no Referer/Origin, `Accept-Language: en-GB` where the page sends `en-GB,en;q=0.9`, and a second request for `<path>.md`; the cookie only with `credentials` | "fetch_url from the worker…", "…with credentials" | `Accept-Language` yes (set it); the `.md` twin is Markdown negotiation | The negotiation |
| 26 | `FETCH_IMAGE_B64` | b64: the target's cookie, a third `Accept-Language` (`en-GB,en-US;q=0.9,en;q=0.8`), and any content type returned (an HTML page of another origin read back) | "page-started ml.fetch is refused…; FETCH_IMAGE_B64 reads another origin WITH its cookie" | Yes (fixme): `credentials: "omit"` and an image check | None |
| 27 | Rendered fetch | a real tab on the target site with the person's cookie, `Sec-Fetch-Site: none` navigation with no `Sec-Fetch-User`, window.ml injected there like on any page | "rendered fetch…" | — | Rendering |
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

1. **`FETCH_IMAGE_B64` is credentialed** (row 26). The handler calls `fetch(url)` with the default credentials mode, and a
   worker fetch to a host the extension has permission for carries that host's cookies. An approved page reads any
   non-private URL's bytes as the person, HTML included. `background.ts` and AGENTS.md's security invariants both call it
   uncredentialed. `test.fixme` in the spec.
2. **Any page identifies window.ml and learns its id**, with no run and no approval (rows 1-5): `'ml' in window`,
   `'__mlClosedRoots' in window`, `attachShadow`'s source, the injected `<script>`, the stack of injected.js's ready
   event, and a 200 from `chrome-extension://<id>/injected.js`. That fingerprints the person as a window.ml user on every
   site they visit. `test.fixme` in the spec.
3. **A run's tool calls are readable by the page** (rows 4, 6): `PAGE_TOOL_RUN` carries the tool name and arguments on the
   page's window, and page-realm tools call builtins the page can wrap. Inherent to tools that run in the page's world
   (docs/dev/site-access.md, "Adding a tool"), listed because it is also the strongest detector.
4. **The page writes into the model's exec result** (row 10): while a main-world exec runs, the page's own `console.log`
   lines are collected as the script's output and reach the model as `console:` text.
5. **`__mlCdpStream` outlives the exec** (row 11): the existing todo in `tests/redteam-isolated.test.mjs` covers the page
   calling it during the exec; it also stays on the page's global, a permanent marker. `test.fixme` in the spec.
6. **`__mlClosedRoots` is a page-writable WeakMap** (row 2), read by the DOM tools when piercing is on: a page can put a
   root of its choosing behind any host. Inferred from the source, not tested here; the page controls its own DOM anyway.

Only "looks automated": rows 7-8, 13-17, 20, 24-25, 27 (untrusted or CDP-shaped input, focus moves, script-started
navigation, worker request headers).

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
- **Console swap** (leak 3): in the main world for exec-main and exec-strict; not visible from exec-iso.
- **Focus emulation** (leak 6) is used only by a rendered `fetch_url` on its own background tab, and that tab is made
  visible too (rAF ≥40 Hz), so "focused but hidden" does not occur. **`setWebLifecycleState`** (leak 7) only ever sets
  `active`: no `freeze`/`resume` was seen.
- **`navigator.webdriver`** is true here because of the harness (headless, `--remote-debugging-port`), not
  `chrome.debugger`, which does not change it.
- **CDP `screenX`/`screenY` equal `clientX`/`clientY`**: no, they are offset by the window's position.
- **BotD demo**: its hosted demo is gone (404); BotD was run from its CDN build.
- Missing from the request: the `window.ml` global itself, the patched `attachShadow` on every page, the injected
  `<script>` tag, the window-message protocol, the HUD card in the page's DOM, and `FETCH_IMAGE_B64`'s cookies.
