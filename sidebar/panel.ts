// DevTools panel host. Plays the same parent-of-the-iframe role that sidebar/shell.ts
// plays for the in-page overlay, but sources the __mlDebug stream from a background port
// keyed on the inspected tab (a panel can't receive the page's window-messages). The app
// iframe (sidebar.html) is byte-for-byte the overlay's — it just sees a parent relaying
// __mlDebug, exactly as under the shell — so the app needs no changes. (`chrome` is the
// @types/chrome global — a local `declare` would poison the type across the project.)
const frame = document.getElementById("app") as HTMLIFrameElement;

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
        else if (Array.isArray(msg?.replay)) { resetApp(); for (const e of msg.replay) toApp(e); }   // authoritative catch-up
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
    if (typeof d.__mlLightbox === "string") showLightbox(d.__mlLightbox);
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
