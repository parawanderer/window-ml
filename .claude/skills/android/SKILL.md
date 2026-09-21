---
name: android
description: Run the phone app on an Android emulator (or a plugged-in phone) and test it — boot, build and install the APK, launch, screenshot, and run Maestro flows. Use when a change to the chat page or the mobile shell needs checking the way a phone actually draws it, or for anything only a device has (the system WebView, the camera, being backgrounded). Optional tooling: never needed for `npm test` or `npm run test:chat`.
---

# The phone app on an emulator

`scripts/android.mjs` wraps the command-line Android SDK. No Android Studio.

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
- **`launch` uses `am start -n dev.wander.windowml/.MainActivity`**: `monkey` exits 251 on a fresh image.
- **Maestro reads the WebView through Android's accessibility tree**, so assert on visible TEXT, not selectors.
- **A plugged-in phone works the same**, when it is the only device adb sees (USB debugging on); skip `boot`.
- The SDK lives in `/opt/homebrew/share/android-commandlinetools` (Homebrew's cask); `ANDROID_HOME` overrides it.
- Never rebuild `dist/` while an e2e suite runs; `install` builds `dist-web/`/`dist-app/`, not `dist/`, so it is safe
  beside one.

Setup for a human is in CONTRIBUTING.md, "4b. Optional: the mobile clients".
