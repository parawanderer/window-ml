// no-bridge.ts — removes the phone app's native bridges from the diagram frame before anything else in it runs.
//
// react-native-webview gives EVERY frame its bridge, a sandboxed one included: `ReactNativeWebView` on Android (a
// message listener registered for origin "*"), `window.webkit.messageHandlers` on iOS. The app cannot tell such a
// frame's messages from the page's: both arrive from origin "null" (mobile/src/embed.tsx, `ourPage`).
//
// Its own script, inlined into the phone's mermaid.html AHEAD of the library's (scripts/build-web.mjs, `buildNative`),
// not an import of mermaid-frame.ts: a bundler is free to place an imported module's statements after the library's
// body, and esbuild did. A separate `<script>` before it runs first by construction.
//
// It is the second layer. The frame's CSP, which lets only these two scripts run (by hash), is what stops injected
// script reaching a fresh bridge in a nested frame. iOS is not run in CI or on any emulator here: the `webkit` half is
// written against WKWebView's documented shape and is unverified.
const g = globalThis as { ReactNativeWebView?: unknown; webkit?: unknown };
delete g.ReactNativeWebView;
try { delete g.webkit; } catch { /* non-configurable: shadowed below */ }
// Still there: an inherited or non-deletable property. An own property of `undefined` shadows it.
if (g.webkit !== undefined) {
    try { Object.defineProperty(globalThis, "webkit", { value: undefined, configurable: false, writable: false }); } catch { /* left as is */ }
}
