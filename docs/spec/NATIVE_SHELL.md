# Spec: a native shell for the phone app (agreed and built, 2026-09-21)

The phone app today is the chat page in Capacitor: every pixel is the web build, including the list, the navigation, the
pickers and the composer. It works, and on a phone it feels like a web page: no edge swipe back, no native transitions,
lists that scroll like a document, sheets that are divs. This proposes a thin native shell (React Native) that owns
that chrome, and keeps the web build for what it is good at: drawing a session.

This was agreed on 2026-09-21 and the shell is built (`mobile/`, #237 onwards): the list, the session chrome, the
composer, settings and pairing are native, and the transcript is the page. What is not there yet: scanning a QR code
with the camera, approvals from the waiting bar, and the Capacitor app's removal. Where this spec and `mobile/AGENTS.md` disagree about a detail of the app, the code and AGENTS.md are what
ships; this is why it is built that way.

It replaces the packaging half of "The phone app" in [`CHAT_PAGE.md`](CHAT_PAGE.md) (Capacitor, decided 2026-09-17).
Everything else there stands: the hub serves no code, the app is built and signed here, pushes say only "an approval is
waiting". The Capacitor app keeps shipping until this one reaches parity, then is removed.

## Scope: calm only

The native app draws **calm view and nothing else**. Calm is the chat page's default, and what it hides is exactly what
a native shell would otherwise have to rebuild: the header band, the debug and raw views, token chips, the resource
panel, the Python bench. Those stay on the extension page and the desktop client, where a mouse and a wide window are.

The shell does not reimplement a session's contents either. A transcript is markdown, code, tables, math, tool steps
and output cells: years of renderers, all of them already portable (`services()`, `ClientPlatform`). Redrawing them
natively would be a second implementation of every one, drifting from the first on day one.

## The split

| Native (React Native) | Web (the existing build, in one WebView) |
| --- | --- |
| the session list, grouped by runtime, with approval and attention badges | the calm transcript of the open session |
| navigation: a native stack, edge swipe / predictive back | approval cards in the transcript (they show what is asked: code, args, a page) |
| the session header: back, the model as a pill, ⋮ | the client core: keyring, `HubHost`, `ChatStore`, hub crypto |
| the composer: text, image attach, send / stop, drafts that survive anything | |
| pickers as bottom sheets: runtime, Agent / Chat, tab, model | |
| the new-session screen, the attention list, the "waiting on you" bar | |
| Settings, all of it: theme, text size, runtimes, devices, pairing (the web tabs were drawn for a desktop) | |
| system services: share sheet, image viewer, clipboard, haptics, notifications | |

The rule for placing a new thing: if a person OPERATES it (taps, swipes, types into it), it is native; if they READ
it, it is web. The WebView holds the transcript and nothing a person types into: the composer is native from the first
version.

**The composer never loses what was typed.** The same three rules as the web composer (`src/sidebar/drafts.ts`):

- the text is saved per session as it is typed, in the app's own storage, and read back when the session is opened
  again, after a restart included. Attached images are kept per session in MEMORY only (several hundred KB each is too
  much for AsyncStorage): they survive leaving the session and a failed send, not the app's death;
- sending empties the box at once but HOLDS the text until the runtime's answer arrives (the bridge's `sent`). A
  failure puts it back, in front of anything typed since, whether or not that session is on screen;
- a send still held when the app died was never confirmed, so it comes back into the box on the next start.

**Images travel over the hub, so they are shrunk on the phone** (`mobile/src/attach.ts`, `image-budget.ts`). A sealed
command is at most 1 MiB, a phone photo is several MB: each image is resized (1568 px on its long edge, JPEG, stepping
down to 768 px) until it fits an even share of a 640 KB budget for all of a message's images, at most four of them. One
that cannot fit is refused with a sentence rather than failing at the hub.

**What it looks like.** The phone-width chat page, as it is now: the same list, header, model pill, composer, badges and
spacing, in the same theme tokens. It is not a redesign. What changes is that each screen is BUILT for a phone rather than
a desktop layout patched down to 390px: the platform's navigation stack and back gesture, lists that scroll and recycle
like lists, bottom sheets for pickers and menus, 44pt rows, safe areas and the keyboard handled by the platform. Settings
is where this shows most, since its web tabs were drawn for a desktop and only squeezed onto a phone.

**Every component is documented**, as on the web: a docstring on each exported component and a comment on each
`StyleSheet` key, enforced by the code index's ratchet (`node scripts/index.mjs --mobile` to search them).

## Architecture: the engine in the WebView, the chrome in native

```
┌──────────────────────── React Native ────────────────────────┐
│  List screen   Session screen   New session   Attention  …  │
│      ▲  snapshot / events            │ commands              │
│      │                               ▼                       │
│  ┌──────────── WebView (one, always mounted) ─────────────┐  │
│  │ native-embed.tsx: Keyring · HubHost · ChatStore        │  │
│  │ renders: the open session's calm transcript, or nothing│  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**The client core stays in the WebView.** It already runs there in the Capacitor app, crypto included: the hub
client uses WebCrypto for Ed25519, X25519, AES-GCM and HMAC (`src/hub/support.ts`, `seal.ts`, `hpke.ts`), and the
keyring is IndexedDB, except for its secrets, which the app keeps in the platform keystore and hands back as bytes
(`docs/dev/hub-client.md` §The keyring in the phone app; WebKit cannot store an X25519 key at all). React Native's
engine (Hermes) has no WebCrypto. Moving the core to native would mean a crypto
module (`react-native-quick-crypto`, whose X25519 / Ed25519 coverage in `subtle` is a guess to verify), the hub's test
vectors re-run against it, and the keyring moved, all before a single screen improves. That is a later option, not
the first step. The bridge below is the same shape either way, so the core can move without the screens noticing.

**One WebView, mounted once, never recreated.** It sits under the navigation stack for the app's whole life. Opening a
session is a message (`open`), not a page load, so it is as fast as switching sessions on the desktop page, and the
connection lives as long as the app does rather than as long as a screen. When no session is open it renders nothing
and native covers it.

**The shared types are the contract's.** What the list needs (`SessionSummary`, `RuntimeInfo`, `HostStatus`, the
attention codes) is plain data in `src/session-host.ts` and friends. The native project imports those TYPES from this
repo, so a field added to the contract is a type error in the shell, not a silent gap.

## The bridge

`react-native-webview`'s `postMessage` both ways, one JSON envelope: `{ v: 1, type, ...payload }`. Both sides validate
every message against the same TypeScript union (`src/native/bridge.ts`, pure, unit-tested) and drop what they do not
recognise, so an old app and a new bundle (or the reverse) degrade instead of breaking.

**Web to native: state, and requests for the device.**

| type | payload | when |
| --- | --- | --- |
| `ready` | bridge version, bundle version | once, when the core has started |
| `account` | none / membership (label, role, hub) | at start and after pairing: native shows first-run or the app |
| `status` | `HostStatus` | on change: the "connecting…" / "offline" chip |
| `index` | `RuntimeInfo[]`, `SessionSummary[]`, `startable` (runtime ids by kind, grants.ts `mayStart`) | on change, debounced to a frame: the list, and what the new-session screen offers |
| `attention` | the items (`AttentionRow`: runtime, level, the page's title and detail) and the count of problems | on change: the inbox in the list's header and its screen. No fix is sent: a phone applies none, so each item names the device it is fixed on |
| `session` | key, title, model, status, `canSwitchModel`, `pendingApprovals`, composer state (can send / can stop) | on change, for the open session: the header, the composer, the "waiting" bar |
| `models` | runtime, the model list | answer to `models` |
| `saveFile` | name, mime, base64 | a "save as CSV", an export: native opens the share sheet |
| `openImage` | a data URL, never SVG (the page rasterizes one) | native opens its image viewer (`mobile/src/viewer.tsx`: pinch, pan, double-tap, share) |
| `openLink` | url | native asks, then opens the system browser (the WebView never navigates) |
| `copied` | none | native plays a haptic tick |
| `sent` | the `send` or `start` id, ok / the error | answer to `send` and `start`: the composer drops or restores the held text |
| `searchResult` | the search's id, a page of rows, whether more follow | answer to `search`: the search screen appends them |
| `error` | message | a core failure native should show |

**Native to web: what the person did.**

| type | payload |
| --- | --- |
| `theme` | light / dark, text size, safe-area insets, reduced motion |
| `open` / `close` | a session key |
| `send` | id, key, text, images (data URLs) |
| `start` | id, runtime, kind, model, text, images, and an agent's `target` (`{kind:"tab",tabId}` or `{kind:"blank",url?}`, checked page-side by `agentTarget`: http(s) only) |
| `tabs` | id, runtime: its open tabs for an agent's target, answered by `tabsResult` (tabs, groups, withheld) |
| `cancel`, `continue` | key |
| `answer` | key, seq, decision, persist (for the "waiting" bar's quick answer; the card in the transcript answers itself) |
| `switchModel` | key, model (`session.model`, #230) |
| `pin`, `delete`, `rename` | key |
| `peek` | key: capture the run's tab; the image arrives as `openImage`, the outcome as `sent` (offered when `chrome.canPeek`) |
| `chromeFor` | id, key: a session's chrome WITHOUT opening it (a long press on a list row), answered by `chromeOf` |
| `models` | runtime: ask for its list |
| `search` | id, query, `more` for the next page: the page asks every runtime it may (`src/native/search-bridge.ts`) |
| `showApproval` | bring the open session's approval card on screen; `open` carries `approval` to do it on the way in |
| `resume` | the app came back to the foreground: `host.reconnect()` now |

The keyring's secrets are the one exception, and they cross the OTHER way: the app holds them in the platform keystore
and answers the page's `vault` requests with bytes (`docs/dev/hub-client.md` §The keyring in the phone app), because
WebKit cannot keep an X25519 key in IndexedDB and a phone has a better place for a device key than a WebView.

**What never crosses:** private keys as keys, sealed bytes. Native sees what the list shows and nothing a compromised
native layer could not already see on screen.

**Hardening the WebView:** it loads the embed bundle from the app's own assets and nothing else (`originWhitelist` is
that one origin, `onShouldStartLoadWithRequest` refuses every navigation and turns a link into `openLink`); no
`allowFileAccessFromFileURLs`; `injectedJavaScript` is limited to installing the bridge.

## The web side

A third entry in `scripts/build-web.mjs`: **`src/chat/native-embed.tsx`**, beside `web.tsx` (the demo) and `client.tsx`
(the standalone client). It does what `client.tsx` does up to `new ChatStore(host)`, then:

- answers every `send` and `start` with `sent`, from the command's own result: the only way native learns a send
  failed, which is what the composer's drafts hang on;
- installs a **`nativePlatform: ClientPlatform`** whose `saveFile`, `openImage` and `copyText` post to native;
- forces calm, applies `theme` (and the insets as CSS variables), and renders only `SessionPane`'s transcript for the
  key native opened: no list, no header, no composer, no notices;
- publishes `index`, `status`, `session` and `attention` from the store's signals through one `effect` each, projected
  by a pure `nativeSnapshot(store)` that has its own unit tests;
- turns native's commands into the calls the page's own buttons make (`services().sendToSession`, `answerApproval`,
  the store's `open`/`close`), so a phone action and a desktop action go down the same path.

Nothing in `src/chat/` learns about React Native: the embed is an entry point, like the other two.

## The native side

A new top-level **`mobile/`**, its own package, following the Capacitor rule that nobody needs a mobile toolchain to
change the chat page:

- **Expo with prebuild**: `android/` and `ios/` are generated from `app.config.ts` and gitignored, as they are today.
  CI's `mobile-android` job compiles it on every change to `mobile/` or the embed; iOS nightly.
- **`react-native-screens`** native stack (the platform's own transitions and back gesture), **FlashList** for the
  session list, a bottom-sheet library for the pickers and ⋮ menus, **`react-native-webview`** for the one WebView.
- The embed bundle is copied into the app's assets by the build, the way `dist-app/` is today.
- Keyring stays in the WebView's IndexedDB for slice 1, as in the Capacitor app. Moving the ROOT key to the Keystore /
  Keychain is its own change, with its own threat note, later.

Screens in the first version: list, session, new session, attention, settings (theme, text size, runtimes, devices and
pairing, all native: the web tabs were drawn for a desktop). Pairing's QR code and camera scan use native modules.
Settings need bridge messages of their own (the device list, revoke, leave, the pairing steps), added with them.

## Later: islands in a native transcript

If the one-WebView transcript still scrolls like a page once everything around it is native, the next step is a native
transcript (messages, prose, thinking lines, one-line steps) with web **islands** only for heavy blocks. Calm makes this
plausible, because what it shows is mostly rows. Two rules, from how this goes wrong elsewhere:

- an island has a **fixed preview height**, measured once and capped (a few code lines, a few table rows); tapping it
  opens the block full screen. The list never jumps and a scroll never gets caught inside one;
- islands are **created near the viewport and recycled** after it, so a long session holds a handful of WebViews, not
  one per block.

Not started until slice 2 has been used on a phone for a while.

## Testing

- **The bridge**: `src/native/bridge.ts` and `nativeSnapshot` are pure, unit-tested in `core`.
- **The embed**: Playwright loads `native-embed.html` against the `FakeHost` with a stub `ReactNativeWebView` that
  records what the page posts, and sends it commands. That is every web-side behaviour, in CI, with no emulator.
- **The shell**: Maestro flows (YAML: tap, type, assert) on an Android emulator, nightly and non-blocking, like the
  real-model job. The shell holds little logic by design, so it needs few.
- **Parity**: every action the extension page can take on a session has a row in a checklist that names its native
  control and its bridge message; a missing row is a missing feature.

## Slices

1. **The bridge and the embed**, web side only: `bridge.ts`, `nativeSnapshot`, `native-embed.tsx`, the stub-bridge
   Playwright spec. Mergeable on its own, no toolchain.
2. **The shell**: `mobile/`, list, session screen with the native header and composer (drafts included), the WebView,
   theme and insets; new session and pickers; attention; settings. Side-loaded APK on your phone; the Capacitor app stays.
3. **Parity and the switch**: the checklist green, then remove Capacitor (`capacitor.config.ts`,
   `scripts/mobile*.mjs`, the CI job) in one change.
4. **Later, if needed**: the native transcript with islands; the core in Hermes; the root key in the Keystore.

## Open, to settle in slice 2

- Whether a WebView covered by native screens keeps its timers and socket running on both platforms (believed yes on
  Android while the app is foregrounded; to measure, since the connection lives there).
- Expo against bare React Native: Expo's prebuild matches the gitignored-projects rule and its dev client makes
  side-loading easy; bare is the fallback if a module needs it.
- iOS text selection and long-press inside the WebView, next to native gestures on the same screen.
