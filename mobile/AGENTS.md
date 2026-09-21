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
- **Look like the phone-width chat page, built for a phone:** its tokens (`src/theme.ts`), its round icon buttons and
  pills, native navigation, 44pt targets, safe areas, the keyboard handled by `react-native-keyboard-controller`.
- **Document everything, as on the web:** a header comment on every file, a docstring on every exported component and
  function, a comment above every `StyleSheet.create` key. The code index checks it (`node scripts/index.mjs --mobile`
  from the repo root) and so does the pre-commit hook. Search the index before writing a new component.

## Traps

- **Gradle only watches `mobile/`**: a change to `src/native/` or the page leaves the old JS bundle in an incremental
  build. `node scripts/android.mjs install --next` deletes it first.
- **An Android prop can be iOS-only in disguise**: `decelerationRate="normal"` on the WebView crashed Android at startup
  (a string where Fabric wants a number). Check a WebView prop's platform in its docs.
- **A bridge check stricter than its sender drops real messages silently** (the model list, an array, failed an
  "object" check). `tests/native-bridge.test.mjs` runs every message each side sends through the other side's check:
  add the new message there when you add one.

## Running it

From the repo root: `node scripts/android.mjs install --next [--demo]` then `launch --next` builds, installs and
starts this app on the emulator (skill `phone`). This app's id is `dev.wander.windowml.next` while it sits beside the Capacitor app.
