// no-bridge.ts — removes the phone app's native bridge from the diagram frame before anything else in it runs.
//
// react-native-webview gives EVERY frame its `ReactNativeWebView`, a sandboxed one included, and the app cannot tell
// such a frame's messages from the page's: both arrive from origin "null" (mobile/src/embed.tsx, `ourPage`). Imported
// first by mermaid-frame.ts, so it runs before Mermaid's own code. It is the second layer: the frame's CSP, which
// lets only its own script run (scripts/build-web.mjs, the native build), is what stops injected script reaching a
// fresh bridge in a nested frame.
delete (globalThis as { ReactNativeWebView?: unknown }).ReactNativeWebView;
