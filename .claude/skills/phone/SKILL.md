---
name: phone
description: Run the phone app on an Android emulator, an iOS simulator, or a plugged-in Android phone, and test it — boot, build and install, launch, screenshot, and run the same Maestro flows on both platforms. Use when a change to the chat page or the mobile shell needs checking the way a phone actually draws it, or for anything only a device has (the system WebView, the camera, being backgrounded). Optional tooling: never needed for `npm test` or `npm run test:chat`.
---

# The phone app on an emulator or a simulator

`scripts/android.mjs` wraps the command-line Android SDK (no Android Studio); `scripts/ios.mjs` wraps Xcode's
`xcodebuild` and `simctl` (macOS only). They take the SAME commands, so everything below reads for either: swap the
script name.

```bash
node scripts/android.mjs doctor          # what is installed and missing, with the command for each; lists devices
node scripts/android.mjs setup           # once: platform-tools, emulator, arm64 API 35 image, the `wml-phone` device
node scripts/android.mjs boot            # headless; --window to watch it. Returns once Android has booted
node scripts/android.mjs install         # build-web → mobile.mjs android (cap sync) → gradle assembleDebug → adb install
node scripts/android.mjs launch          # cold start (force-stop first)
node scripts/android.mjs shot [file]     # PNG, default test-results/android.png; Read it to see the screen
node scripts/android.mjs flows [file…]   # Maestro: every tests/mobile/*.yaml, or the ones named
node scripts/android.mjs stop
```

```bash
node scripts/ios.mjs doctor              # Xcode, an iPhone simulator, Maestro; the simulator it will use
node scripts/ios.mjs boot                # --window opens Simulator.app to watch
node scripts/ios.mjs install             # build-web → mobile.mjs ios (cap sync) → xcodebuild (simulator) → simctl install
node scripts/ios.mjs launch; node scripts/ios.mjs shot; node scripts/ios.mjs flows; node scripts/ios.mjs stop
```

The simulator is the newest iPhone on the newest iOS runtime, or `IOS_DEVICE=<name or UDID>`. No signing certificate is
needed for a simulator build; `install` runs `pod install` itself whenever the native project is regenerated.

## The React Native app (mobile/)

```bash
node scripts/android.mjs install --demo   # page built + synced (demo world), release APK, installed
node scripts/android.mjs launch                   # dev.wander.windowml
node scripts/ios.mjs install --demo       # the same on the iOS simulator (Release build, pods on first run)
node scripts/ios.mjs launch
```

On iOS the simulator takes no taps from the command line: drive it with a Maestro flow (`node scripts/ios.mjs flows
<file>`), tapping by visible text or by accessible name (a pill's is `Model: <id>`, not its text).

When a flow cannot find something that is plainly on the screen, print what the tools can actually see:
`~/.maestro/maestro/bin/maestro --device <udid> hierarchy` (iOS) or `maestro hierarchy` with one device attached. A
label is matched WHOLE, so a row reading "gemma3:27b, sees images" needs `gemma3:27b.*`; a placeholder is in no
accessibility tree, so a field needs a `testID` (`- tapOn: { id: "sheet-filter" }`).

A flow names its app by `appId` (`dev.wander.windowml`, the one app). `demo-*.yaml` needs the DEMO build
(`install --demo`), since those flows drive the demo world's sessions; `first-run.yaml` and `join.yaml` need a REAL
build, which carries no fake host. Name the flows for the build you installed; a bare `flows` runs all of them and the
other half will fail.
`join.yaml` joins against a hub that is not there, which exercises key generation and the keystore (the vault)
end to end on a real WebView: on iOS it is the check that the keys survive at all.

**A whole batch failing on iOS, the first flow after ~15 s and the rest in a second each, is the DRIVER, not the app.**
Maestro's log says "Error getting main window kAXErrorServerNotFound" or "App … did not stop in time": it lost the app
between flows, and every later flow fails instantly on the dead driver. There is no crash report and the same batch
passes on a rerun. Rerun it, or run fewer at a time, before reading anything into it.

On Android `install` builds for the connected device's ABI only (`ro.product.cpu.abi`, passed as
`-PreactNativeArchitectures`); a release built by hand gets `app.json`'s `buildArchs`, arm64-v8a alone (50 MB, down from
128 MB with all four). A phone that is not arm64 needs its ABI added there.

`install` regenerates the native project (`expo prebuild --clean`, then `pod install` on iOS) whenever
`mobile/package.json`, `app.json` or `plugins/` changed since the last one (`scripts/mobile-prebuild.mjs`), so a new
native module is linked rather than failing at launch as "Cannot find native module". That rebuild is from scratch and
slow; nothing else triggers it. When the app shows only a white screen, read its log first:
`xcrun simctl spawn booted log show --last 5m --predicate 'process == "windowml"' | grep -i error` (iOS) or
`adb logcat -d | grep -i ReactNativeJS` (Android).

Drop `--demo` for the real page (this device's account over the hub). It is a release build: the JS is bundled in, so
no Metro server is involved and what you see is what ships.

## A real pairing, locally

The failure path (`join.yaml`) needs no hub. To watch a phone actually join an account, run the test hub and be
the other device yourself:

```bash
~/git/window-ml-hub-v0.4.0/target/release/wmlhub serve --hub-name hub.local --registration open \
    --state-dir /tmp/hubstate --listen 127.0.0.1:8799 &            # the binary tests/fixtures/hub-harness.mjs uses
node --import tsx scripts/hub-root.mjs create ws://127.0.0.1:8799 --state /tmp/root.json   # the account's root
# in the app: Join an account → hub ws://127.0.0.1:8799 → Show my code, then read the code off a screenshot
echo yes | node --import tsx scripts/hub-root.mjs confirm "ZVJV FSQ0" --state /tmp/root.json
```

`confirm` asks at a prompt whether both screens show the same fingerprint, so pipe `yes` or it waits forever. The
iOS simulator reaches `127.0.0.1` as itself; the Android emulator needs `10.0.2.2` for the host. Relaunching the app
afterwards without `clearState` is the check that the keystore kept the keys and the membership.

## Which test layer to reach for

| You want to check | Use |
| --- | --- |
| a phone LAYOUT, touch targets, the keyboard as a resize, drafts, pickers | a Playwright test tagged `@mobile` in `tests/e2e/chat-web.spec.mjs` (`npm run test:mobile`): seconds, no emulator, runs in CI |
| that the packaged app starts, and what a person sees on it | a Maestro flow in `tests/mobile/` (`flows`) |
| how the real system WebView renders or performs | `boot` + `install` + `launch` + `shot`; `chrome://inspect` in desktop Chrome for its DevTools (a debug build's WebView is debuggable) |

Prefer the `@mobile` Playwright layer: it is fast and in CI. The emulator is for what only a device shows.

## Gotchas

- **`install` rebuilds everything**, including the web build, because the native project holds a COPY of
  `dist-app/`. A sync skipped is a change that "did nothing".
- **JDK 21** is what gradle is run with (the script picks it with `java_home -v 21`); a newer default JDK can break
  the Android gradle plugin, and 17 fails with "invalid source release: 21".
- **Maestro is mobile.dev's CLI**, in `~/.maestro/maestro/bin` from its release zip. `brew install --cask maestro` is
  an unrelated app with the same name; the tap formula refuses while Xcode is out of date. The script finds the CLI
  on the PATH or in `~/.maestro`, and turns its analytics prompt off (its first-run banner failed the first run).
- **The first launch on a freshly booted iOS simulator can stay WHITE for 20 seconds or more** while WebKit's
  processes start; the page has rendered by then (the DOM is there). Relaunch and screenshot again before debugging.
  To see the app's console on iOS: `xcrun simctl launch --console-pty booted dev.wander.windowml`. For an engine question, Playwright's `webkit` runs the same bundle on the desktop.
- **Gradle only watches `mobile/`.** A change to `src/native/` (the bridge) or the page is invisible to it, and an
  incremental build reuses the old JS bundle. `install` deletes the bundle first; building by hand, delete
  `mobile/android/app/build/generated/assets/react/release` yourself or the fix "does nothing".
- **`launch` uses `am start -n dev.wander.windowml/.MainActivity`**: `monkey` exits 251 on a fresh image.
- **Maestro reads the WebView through Android's accessibility tree**, so assert on visible TEXT, not selectors.
- **A plugged-in phone works the same**, when it is the only device adb sees (USB debugging on); skip `boot`.
- The SDK lives in `/opt/homebrew/share/android-commandlinetools` (Homebrew's cask); `ANDROID_HOME` overrides it.
- Never rebuild `dist/` while an e2e suite runs; `install` builds `dist-web/`/`dist-app/`, not `dist/`, so it is safe
  beside one.

Setup for a human is in CONTRIBUTING.md, "4b. Optional: the mobile clients".
