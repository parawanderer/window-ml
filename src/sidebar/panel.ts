// DevTools panel host. Plays the same parent-of-the-iframe role that sidebar/shell.ts
// plays for the in-page overlay, but sources the __mlDebug stream from a background port
// keyed on the inspected tab (a panel can't receive the page's window-messages). The app
// iframe (sidebar.html) is byte-for-byte the overlay's — it just sees a parent relaying
// __mlDebug, exactly as under the shell — so the app needs no changes. (`chrome` is the
// @types/chrome global — a local `declare` would poison the type across the project.)
import { showLightbox, relayAppToWorker } from "./app-host";
const frame = document.getElementById("app") as HTMLIFrameElement;

// This panel only streams when it's the ACTIVE debug surface (debugMode === "devtools").
// The DevTools tab can't be un-registered, so when debug is off or rendering in the in-page
// sidebar we swap the app for a note explaining how to point the stream here — never a
// misleading empty log. Reads chrome.storage.sync (a DevTools page has chrome APIs).
const offnote = document.getElementById("ml-offnote")!;
function reflectMode(mode: string): void {
    const active = mode === "devtools";
    frame.style.display = active ? "block" : "none";
    offnote.style.display = active ? "none" : "block";
    if (active) return;
    const h = document.getElementById("ml-offnote-h")!, b = document.getElementById("ml-offnote-b")!;
    if (mode === "overlay") {
        h.textContent = "Debug is showing in the in-page sidebar";
        b.innerHTML = "window.ml is logging to the slide-out panel on the page. To stream it <b>here</b> instead, set <b>Debug panel → DevTools panel</b> in the toolbar popup or Settings → Appearance.";
    } else {
        h.textContent = "window.ml debug is off";
        b.innerHTML = "Turn it on with <b>Debug panel → DevTools panel</b> in the toolbar popup or Settings → Appearance to stream ml calls here.";
    }
}
chrome.storage.sync.get({ debugMode: "off" }, (c: any) => reflectMode(c.debugMode || "off"));
chrome.storage.onChanged.addListener((ch: any, area: string) => {
    if (area === "sync" && ch.debugMode) reflectMode(ch.debugMode.newValue || "off");
});

// Queue events until the app reports it's listening (its load races the port's replay
// burst), then flush and go live — mirrors the shell's present→ready→replay handshake.
let ready = false;
const queue: unknown[] = [];
function toApp(evt: unknown): void {
    if (ready) frame.contentWindow?.postMessage({ __mlDebug: evt }, "*");
    else queue.push(evt);
}

const tabId = chrome.devtools.inspectedWindow.tabId;

// Tell the app to drop its sessions. Its iframe outlives inspected-page reloads (the
// overlay's doesn't), so it must be cleared explicitly — on a page navigation (`reset`)
// and before a reconnect's authoritative replay, so re-applying the buffer can't dupe.
function resetApp(): void {
    if (ready) frame.contentWindow?.postMessage({ __mlDebugReset: true }, "*");
    else queue.length = 0;   // nothing shown yet → just drop any pending burst
}

// When the EXTENSION itself reloads (dev workflow), this panel's context is invalidated and Chrome can't
// re-attach the DevTools panel live (a devtools_page only registers on a fresh DevTools open) — so the panel
// would just go blank. Detect the dead context and show an actionable note instead. (`chrome.runtime.id`
// goes undefined once the context is invalidated.) The inspected-page reload path is separate (`reset`).
function showStaleNote(): void {
    frame.style.display = "none";
    offnote.style.display = "block";
    document.getElementById("ml-offnote-h")!.textContent = "Extension reloaded — reconnect this panel";
    document.getElementById("ml-offnote-b")!.innerHTML =
        "This panel lost its connection when the extension reloaded — Chrome can't re-attach a DevTools panel " +
        "live. Press <b>⌘R</b> / <b>Ctrl+R</b> on this DevTools window to reload it (re-registers the panel " +
        "without touching the inspected tab), or close &amp; reopen DevTools.";
}

// The MV3 background service worker is recycled aggressively; when it (or the port) drops,
// the panel would silently stop receiving events (it connected once). Reconnect so new
// calls keep flowing, and treat each (re)connect's `replay` as the source of truth.
function connect(): void {
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({ name: "ml-devtools" }); }
    catch { showStaleNote(); return; }   // extension context gone (reloaded) → this panel is stale
    port.postMessage({ type: "ml-devtools-init", tabId });
    port.onMessage.addListener((msg: any) => {
        if (msg?.__mlDebug) toApp(msg.__mlDebug);
        else if (msg?.reset) resetApp();
        // A non-empty replay is authoritative catch-up (reset first so re-applying can't dupe). An EMPTY
        // replay almost always means the background SW was just recycled and its in-memory buffer is gone
        // — NOT that the history is really empty. Wiping the panel then (it outlives the SW) was the
        // "random history vanished" bug: keep what's shown; a real page navigation clears via `reset`.
        else if (Array.isArray(msg?.replay) && msg.replay.length) { resetApp(); for (const e of msg.replay) toApp(e); }
    });
    port.onDisconnect.addListener(() => {
        // No runtime.id → the EXTENSION reloaded (not just the SW cycling): reconnecting is futile and would
        // loop, so surface the reload note. A live extension (id present) is a normal SW recycle → reconnect.
        if (!chrome.runtime?.id) { showStaleNote(); return; }
        setTimeout(connect, 500);
    });
}
connect();

window.addEventListener("message", (e: MessageEvent) => {
    const d: any = e.data;
    if (!d || e.source !== frame.contentWindow) return;
    // The chart's key set, which the overlay's shell uses to relay the PAGE's keys in. Nothing to relay here: the
    // iframe fills this panel, so this document almost never has focus of its own, and keys typed while another
    // DevTools pane has focus never reach an extension panel at all. Deliberately not announcing a relay, so the
    // chart's hints say "click the chart" in DevTools rather than promising keys that go elsewhere.
    if (d.__mlSidebarApp === "chartKeys") return;
    // The app filling this panel has nowhere of ours around it to see the pointer leave to (pointer-gone.ts).
    if (d.__mlSidebarApp === "pointerIn") return;
    if (d.__mlSidebarApp === "ready") {
        ready = true;
        frame.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");   // the panel is always "open"
        for (const evt of queue.splice(0)) frame.contentWindow?.postMessage({ __mlDebug: evt }, "*");
        return;
    }
    if (typeof d.__mlLightbox === "string") { showLightbox(d.__mlLightbox); return; }
    relayAppToWorker(d, tabId, "devtools", (m) => frame.contentWindow?.postMessage(m, "*"));
});

// If the panel goes away with a highlight still showing (it lives on the inspected page, not here),
// clear it so no stray box is left behind.
window.addEventListener("pagehide", () => {
    try { void chrome.runtime.sendMessage({ type: "ML_HL_REMOTE", tabId, ref: null }).catch(() => {}); } catch { /* context gone */ }
});
