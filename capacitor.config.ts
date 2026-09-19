// capacitor.config.ts — the phone app is the CHAT PAGE, packaged (docs/spec/CHAT_PAGE.md slice 6).
//
// There is no second UI and no phone-only code path: `dist-web/` is the same bundle a browser loads, which is why
// the phone surface is already tested at phone width in `tests/e2e/chat-web.spec.mjs` rather than on a device. A
// device test earns its place only for what only a device has (camera pairing, the share sheet, being backgrounded
// mid-stream).
//
// The native projects are NOT checked in. CI runs `cap add` and builds them from this config, because nobody working
// on this repo should need Xcode or Android Studio installed to change the chat page: the moment the suite depends
// on them, a one-line UI fix needs 40GB of tooling. `.gitignore` holds `android/` and `ios/` for the same reason.
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    // Reverse-DNS on a domain the project owns. Changing it after a store submission orphans the app, so it is set
    // once, here, rather than being whatever a scaffold generated.
    appId: "dev.wander.windowml",
    appName: "window.ml",
    // The standalone client (src/chat/client.tsx) as the start page, built by scripts/build-web.mjs. Not `dist-web/`,
    // whose start page is the demo world the specs drive.
    webDir: "dist-app",
    // The page holds no secrets of its own — a hub connection is authenticated by a key in the app's own storage —
    // but a cleartext origin would let anything on the network rewrite the page that then uses that key.
    server: { androidScheme: "https" },
};

export default config;
