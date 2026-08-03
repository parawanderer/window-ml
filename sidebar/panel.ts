// DevTools panel host. Plays the same parent-of-the-iframe role that sidebar/shell.ts
// plays for the in-page overlay, but sources the __mlDebug stream from a background port
// keyed on the inspected tab (a panel can't receive the page's window-messages). The app
// iframe (sidebar.html) is byte-for-byte the overlay's — it just sees a parent relaying
// __mlDebug, exactly as under the shell — so the app needs no changes. (`chrome` is the
// @types/chrome global — a local `declare` would poison the type across the project.)
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

// The MV3 background service worker is recycled aggressively; when it (or the port) drops,
// the panel would silently stop receiving events (it connected once). Reconnect so new
// calls keep flowing, and treat each (re)connect's `replay` as the source of truth.
function connect(): void {
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({ name: "ml-devtools" }); }
    catch { return; }   // extension context gone (e.g. reloaded) → this panel is stale
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
    port.onDisconnect.addListener(() => { setTimeout(connect, 500); });   // SW cycled → re-establish
}
connect();

window.addEventListener("message", (e: MessageEvent) => {
    const d: any = e.data;
    if (!d || e.source !== frame.contentWindow) return;
    if (d.__mlSidebarApp === "ready") {
        ready = true;
        frame.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");   // the panel is always "open"
        for (const evt of queue.splice(0)) frame.contentWindow?.postMessage({ __mlDebug: evt }, "*");
        return;
    }
    // Design A reverse channel: the app's approve/deny for a background-hosted run's gate. Forward it to
    // the background as SET_APPROVAL. Unforgeable by the inspected page — this fires ONLY for a message
    // from the real panel-app iframe (the e.source check above), and a web page can't postMessage into a
    // DevTools page. panel.ts (a devtools extension page) can chrome.runtime.sendMessage directly; the
    // page has no such path (it's not an extension context, and SET_APPROVAL isn't a content-relayed type).
    if (d.__mlSidebarApp === "approval" && typeof d.hash === "string" && typeof d.seq === "number") {
        void chrome.runtime.sendMessage({ type: "SET_APPROVAL", payload: { runId: d.hash, seq: d.seq, decision: !!d.decision } }).catch(() => {});
        return;
    }
    if (typeof d.__mlLightbox === "string") { showLightbox(d.__mlLightbox); return; }
    // Hover-highlight reverse channel: the app asks to outline a page element/point on hover. The panel
    // can't touch the inspected page, so relay to the background → that tab's content-script shell, which
    // draws the box. Origin-checked above (e.source === frame.contentWindow); a web page can't
    // postMessage into a DevTools page regardless.
    if ("__mlHighlight" in d) { void chrome.runtime.sendMessage({ type: "ML_HL_REMOTE", tabId, ref: d.__mlHighlight }).catch(() => {}); return; }
    // Session composer reverse channel: the panel can't touch the inspected page, so relay to the
    // background → that tab's shell → the page's handle registry (same route as hover-highlight).
    if (d.__mlSidebarApp === "sessionSend" && typeof d.hash === "string" && typeof d.text === "string" && d.text.trim()) {
        void chrome.runtime.sendMessage({ type: "ML_SESSION_REMOTE", tabId, action: "send", hash: d.hash, text: d.text }).catch(() => {});
        return;
    }
    if (d.__mlSidebarApp === "sessionCancel" && typeof d.hash === "string") {
        void chrome.runtime.sendMessage({ type: "ML_SESSION_REMOTE", tabId, action: "cancel", hash: d.hash }).catch(() => {});
        return;
    }
});

// If the panel goes away with a highlight still showing (it lives on the inspected page, not here),
// clear it so no stray box is left behind.
window.addEventListener("pagehide", () => {
    try { void chrome.runtime.sendMessage({ type: "ML_HL_REMOTE", tabId, ref: null }).catch(() => {}); } catch { /* context gone */ }
});

// The app posts __mlLightbox on an image click; the overlay's shell shows it full-window.
// The panel is its own page, so it needs its own viewer — with Escape + backdrop close,
// and it grabs focus so Escape lands HERE even though the click came from the app iframe
// (keyboard events don't cross the iframe boundary).
let lightboxKey: ((e: KeyboardEvent) => void) | null = null;
function hideLightbox(): void {
    document.getElementById("ml-lightbox")?.remove();
    if (lightboxKey) { window.removeEventListener("keydown", lightboxKey); lightboxKey = null; }
}
function showLightbox(src: string): void {
    hideLightbox();
    const box = document.createElement("div");
    box.id = "ml-lightbox";
    box.tabIndex = -1;
    box.addEventListener("click", hideLightbox);              // click anywhere (incl. the image) closes
    const img = document.createElement("img");
    img.src = src;
    box.append(img);
    document.body.append(box);
    box.focus();                                              // pull focus out of the iframe → Escape reaches us
    lightboxKey = e => { if (e.key === "Escape") hideLightbox(); };
    window.addEventListener("keydown", lightboxKey);
}
