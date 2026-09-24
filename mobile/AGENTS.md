# mobile/ — the phone app's native shell

The React Native (Expo) app for iOS and Android. The design is `docs/spec/NATIVE_SHELL.md`; read it first. The
repo's own rules (`../AGENTS.md`) apply here too.

**Expo changed a lot recently: read the versioned docs, https://docs.expo.dev/versions/v57.0.0/, before using an Expo
API from memory.** `expo-file-system` in particular is the `File` / `Directory` / `Paths` API now, not the old
`documentDirectory` one.

## The split

- **Native (here):** everything a person OPERATES: the session list, navigation, the session header, the composer
  (with drafts that survive a failed send), pickers as bottom sheets, new chat, attention, settings, pairing.
- **Web (the page in the one WebView):** the calm transcript of the open session, and the client itself (keyring,
  hub connection, store). It is `src/chat/native-embed.tsx` in the repo, built into `dist-native/` by
  `node scripts/build-web.mjs` and copied into the app by `node scripts/sync-embed.mjs` (`--demo` for the fake-host
  demo world, which a release never carries).
- **The bridge** between them is `src/native/bridge.ts` (shared, imported from here through Metro's `watchFolders`).
  The app never re-derives a grant, a status or a model list: the page says, the app draws.

## Rules

- **The WebView is created once and never remounted** (`EmbedWebView`, in the always-mounted session layer). A remount
  reloads the page and reconnects to the hub.
- **RULE — ONE DESIGN LANGUAGE WITH THE CALM VIEW, and a device-specific reason to depart from it.** This app and the
  chat page's calm view are the same product on two screens, so the colours, the glyphs and the order they sit in are
  the page's: the palette in `src/theme.ts` mirrors `sidebar.css`'s tokens, and the glyphs in `src/icons.tsx` are the
  page's own path data (`src/sidebar/icons.tsx`) drawn through react-native-svg. A change to either side is a change to
  both, and WHICHEVER SIDE GOT IT RIGHT is the one the other follows — the shared look is not the page's property.
  (The app worked out that a row's status belongs FIRST on its meta line, so it is in the same place on every row;
  the page took that from the app, not the other way round.) Anything the app draws that the page also draws — a header's buttons, a badge, a menu row, a status word — is
  the same shape, the same colour and in the same place unless a DEVICE fact makes it wrong: a thumb needs 44pt where
  a pointer needs 24, a sheet belongs at the bottom of a phone where a menu belongs under its button, a system back
  gesture exists here and not there. "It was easier with the library we already had" is not one of those reasons, and
  it is how the two drifted the first time: lucide's magnifier, a sky-blue notice against the page's indigo, and the
  inbox first in a row where the page puts it third.
- **Built for a phone, within that:** native navigation, 44pt targets, safe areas, the keyboard handled by
  `react-native-keyboard-controller`.
- **Document everything, as on the web:** a header comment on every file, a docstring on every exported component and
  function, a comment above every `StyleSheet.create` key. The code index checks it (`node scripts/index.mjs --mobile`
  from the repo root) and so does the pre-commit hook. Search the index before writing a new component.

## Traps

- **Gradle only watches `mobile/`**: a change to `src/native/` or the page leaves the old JS bundle in an incremental
  build. `node scripts/android.mjs install` deletes it first.
- **A new native module needs a new native project**: `ios/` and `android/` are generated once, and an old one runs
  without the module until launch, where it fails as "Cannot find native module" on a white screen. `install`
  fingerprints `package.json`, `app.json` and `plugins/` (`scripts/mobile-prebuild.mjs`) and re-runs `expo prebuild
  --clean` when they change; by hand, delete the platform folder.
- **A scroll view with a field in it eats the first tap**: without `keyboardShouldPersistTaps="handled"` a tap while the
  keyboard is up only dismisses it, so a row picked after typing (a filtered model, Save on a rename) needs two taps and
  the first looks broken. `Sheet` sets it; any new scroller holding a field needs it too.
- **A sheet's text field THROWS on a plain screen**: `BottomSheetTextInput` exists to keep its sheet above the keyboard,
  and outside one it kills the app with "`useBottomSheetInternal` cannot be used out of the BottomSheet". `SheetFilter`
  takes `onScreen` for that. A screen with a field also needs `KeyboardAvoidingView`, or the keyboard covers it: the
  Runtimes screen's model filter (and its clear button) sat under the keyboard the moment it opened.
- **A CONTROLLED text field drops and reorders fast typing** (a rename came out "cche… notesa"). A field whose value
  nothing else rewrites is uncontrolled (`defaultValue`), and is cleared through its ref (`SheetFilter plain`).
- **A bottom sheet hides everything inside it** from VoiceOver, TalkBack and Maestro: `@gorhom/bottom-sheet` makes the
  sheet ONE accessibility element ("Bottom Sheet") unless it is given `accessible={false}` (`Sheet`, `src/ui.tsx` does).
  A flow that cannot find a row that is plainly on screen is this. `maestro hierarchy` prints what the tools can see.
- **A message from the page carries no URL on Android**: `e.nativeEvent.url` is the string `"null"` for a `file://`
  page, so a check against the page's address drops every message there while passing on iOS. What confines this
  WebView is `onShouldStartLoadWithRequest`; anything else is a second look, and must treat a missing URL as nothing.
- **Metro sees only the repo folders in `metro.config.js`'s `watchFolders`** (`src/native`, `src/pairing`, `src/chat`).
  A VALUE imported from anywhere else typechecks, runs in a debug bundle, and then fails the RELEASE build ("Unable to
  resolve module"), which `install` reports only as xcodebuild exiting 65: read its log, and never chain a flow run
  after it with `&&`. Type-only imports are erased and may come from anywhere. `tests/mobile-imports.test.mjs` fails on
  a value import from elsewhere, because nothing else catches it — a PR builds the DEBUG apk only, and the release one
  runs on main.
- **Anything the app sends rides one sealed hub command, at most 1 MiB** (`src/hub/seal.ts`), base64 and JSON included.
  A phone photo alone is several times that: images are shrunk to `image-budget.ts`'s budget before they are attached.
- **React Native's `Image` draws no SVG**, and says nothing: the viewer opened on a black screen for the demo's SVG
  capture. The page rasterizes an SVG before `openImage` (`drawable`, native-embed.tsx); anything else the app shows
  from a data URL needs the same.
- **An Android prop can be iOS-only in disguise**: `decelerationRate="normal"` on the WebView crashed Android at startup
  (a string where Fabric wants a number). Check a WebView prop's platform in its docs.
- **A bridge check stricter than its sender drops real messages silently** (the model list, an array, failed an
  "object" check). `tests/native-bridge.test.mjs` runs every message each side sends through the other side's check:
  add the new message there when you add one.

- **The page persists NOTHING in the WebView.** Secrets go to the keystore (`vault.ts`), everything else it would have
  put in IndexedDB goes to `Documents/store/` (`store.ts`, `src/native/store-bridge.ts`). A new thing the page must
  keep across launches goes through one of those two, never IndexedDB or localStorage.
- **The keyring's secrets live in the platform keystore, not the WebView** (`src/native/vault-bridge.ts` on the page,
  `src/vault.ts` here, expo-secure-store underneath): WebKit cannot keep an X25519 CryptoKey in IndexedDB at all. A
  `vault` request is answered at once, never queued behind `ready`, because the page cannot get to `ready` without its
  keys. How the keyring keeps seeds instead of keys: `docs/dev/hub-client.md`, "The keyring in the phone app".
- **iOS 27 kills an app without the scene lifecycle** at launch (`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`,
  SIGTRAP in the crash report under `~/Library/Logs/DiagnosticReports/`), and Expo 57's template has none.
  `plugins/with-ios-scene.js` adds it on every prebuild; if a template change breaks its AppDelegate edit, it throws
  rather than building an app that dies on launch.

## Running it

From the repo root: `node scripts/android.mjs install [--demo]` then `launch` builds, installs and starts this app on
the emulator (skill `phone`). Its id is `dev.wander.windowml`, which it took over from the Capacitor app it replaced.
