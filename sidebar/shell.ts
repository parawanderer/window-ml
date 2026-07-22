// Content-script shell for the debug sidebar. It hosts the app in an <iframe>
// that loads an extension page (sidebar.html) — a chrome-extension:// origin the
// host web page can't read across, so the app may safely hold secrets (unlike a
// shadow-root panel injected into the page DOM, which the page can walk into).
//
// This shell owns the slide-out container, tab, and resize handle, and relays
// the page's `__mlDebug` stream (from injected.js, main world) into the iframe.
// injected.js is unchanged: it still emits only after the `__mlSidebar:"ready"`
// handshake, which the shell sends once the iframe app reports it's listening.
import { SB_ROOT, SB_HOST, SB_TAB, SB_FRAME, SB_LIGHTBOX, SB_LIGHTBOX_X } from "../ids";

const WIDTH_KEY = "ml_debug_width";
const MIN_W = 280, TAB_W = 34, DEFAULT_W = 400;

const SHELL_CSS = `
#${SB_HOST} { position: fixed; top: 0; right: 0; height: 100vh; display: flex;
  z-index: 2147483000; transform: translateX(calc(100% - ${TAB_W}px)); transition: transform .22s ease; }
#${SB_HOST}.open { transform: translateX(0); }
#${SB_TAB} { width: ${TAB_W}px; flex: 0 0 ${TAB_W}px; cursor: pointer; border: none;
  background: #4f46e5; color: #fff; writing-mode: vertical-rl; text-orientation: mixed;
  letter-spacing: .08em; font: 600 12px system-ui, sans-serif; padding: 10px 0;
  border-radius: 6px 0 0 6px; align-self: center; height: 150px; box-shadow: -2px 0 8px rgba(0,0,0,.35); }
#${SB_TAB}:hover { background: #6366f1; }
#ml-sb-body { position: relative; flex: 1; min-width: 0; height: 100%; box-shadow: -4px 0 20px rgba(0,0,0,.4); }
#ml-sb-resize { position: absolute; left: -3px; top: 0; width: 7px; height: 100%; cursor: ew-resize; z-index: 1; }
#ml-sb-resize:hover, #ml-sb-resize.drag { background: #6366f1; opacity: .5; }
#${SB_FRAME} { display: block; width: 100%; height: 100%; border: 0; }
/* Full-window image lightbox (a sibling of the panel, so no transformed
   ancestor — position:fixed maps to the whole viewport). */
#${SB_LIGHTBOX} { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.82);
  display: flex; align-items: center; justify-content: center; padding: 28px; cursor: zoom-out; }
#${SB_LIGHTBOX} img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 10px 50px rgba(0,0,0,.6); cursor: default; }
#${SB_LIGHTBOX_X} { position: fixed; top: 12px; right: 16px; width: 32px; height: 32px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,.35); background: rgba(0,0,0,.5); color: #fff; font: 16px system-ui; cursor: pointer; }
#${SB_LIGHTBOX_X}:hover { background: rgba(0,0,0,.85); }
`;

let shellHost: HTMLElement | null = null;   // shadow host in the page's light DOM
let shadowRoot: ShadowRoot | null = null;
let panel: HTMLElement | null = null;       // the sliding container, inside the shadow root
let frame: HTMLIFrameElement | null = null;
let lightbox: HTMLElement | null = null;

function hideLightbox(): void {
    lightbox?.remove(); lightbox = null;
    window.removeEventListener("keydown", onLightboxKey);
}
function onLightboxKey(e: KeyboardEvent): void { if (e.key === "Escape") hideLightbox(); }
// Full-window image lightbox (from the app's ClickableImg → __mlLightbox). Lives
// in the shell so it fills the whole browser, not the ~sidebar-width iframe.
function showLightbox(src: string): void {
    if (!shadowRoot) return;
    hideLightbox();
    lightbox = document.createElement("div");
    lightbox.id = SB_LIGHTBOX;
    lightbox.addEventListener("click", hideLightbox);   // backdrop click closes
    const img = document.createElement("img");
    img.src = src;
    img.addEventListener("click", (e) => e.stopPropagation());
    const x = document.createElement("button");
    x.id = SB_LIGHTBOX_X; x.textContent = "✕"; x.title = "Close (Esc)";
    x.addEventListener("click", hideLightbox);
    lightbox.append(x, img);
    shadowRoot.append(lightbox);
    window.addEventListener("keydown", onLightboxKey);
}

function onWindowMessage(e: MessageEvent): void {
    const d = e.data;
    if (!d) return;
    // injected.js asks us to hide the overlay for a screenshot (so the sidebar
    // isn't captured into the agent's `look`). Hide, then ack after two frames so
    // the hidden state has painted before the capture fires.
    if (d.__mlSidebarShot === "hide") {
        if (shellHost) shellHost.style.visibility = "hidden";
        if (lightbox) lightbox.style.visibility = "hidden";   // full-viewport overlay — MUST hide too, else the shot is all backdrop
        requestAnimationFrame(() => requestAnimationFrame(() => window.postMessage({ __mlSidebarShot: "hidden" }, "*")));
        return;
    }
    if (d.__mlSidebarShot === "show") {
        if (shellHost) shellHost.style.visibility = "";
        if (lightbox) lightbox.style.visibility = "";
        return;
    }
    // The iframe app asks to open an image full-window (ClickableImg).
    if (typeof d.__mlLightbox === "string" && frame && e.source === frame.contentWindow) { showLightbox(d.__mlLightbox); return; }
    // injected.js (page main world) → relay into the iframe app.
    if (d.__mlDebug && e.source === window) { frame?.contentWindow?.postMessage(d, "*"); return; }
    // The iframe app is listening → handshake injected.js so it starts emitting,
    // and tell the app the current open state (so it can pause polling when hidden).
    if (d.__mlSidebarApp === "ready" && frame && e.source === frame.contentWindow) {
        window.postMessage({ __mlSidebar: "ready" }, "*");
        frame.contentWindow?.postMessage({ __mlSidebarOpen: panel?.classList.contains("open") ?? false }, "*");
    }
}

// Tell the iframe app when the panel slides open/closed (it gates polling on this).
function toggleOpen(): void {
    const open = panel?.classList.toggle("open") ?? false;
    frame?.contentWindow?.postMessage({ __mlSidebarOpen: open }, "*");
}

const setWidth = (w: number): void => { if (panel) panel.style.width = `${Math.round(w)}px`; };

function startResize(e: PointerEvent): void {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("drag");
    if (frame) frame.style.pointerEvents = "none";   // let drag events cross the iframe
    const onMove = (ev: PointerEvent) =>
        setWidth(Math.max(MIN_W, Math.min(window.innerWidth * 0.95, window.innerWidth - ev.clientX)));
    const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        handle.classList.remove("drag");
        if (frame) frame.style.pointerEvents = "";
        const w = panel ? parseInt(panel.style.width, 10) : 0;
        if (w) chrome.storage.local.set({ [WIDTH_KEY]: w });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
}

function mount(): void {
    if (shellHost) return;
    // Host the shell's chrome (container/tab/resize/iframe) inside a shadow root
    // so the page's CSS can't bleed into it (e.g. a global `div { opacity: .8 }`,
    // as example.com actually ships). `all: initial` on the shadow host blocks
    // page rules that target the host element itself. Secrets still live in the
    // iframe (its own extension origin), not in this shell.
    shellHost = document.createElement("div");
    shellHost.id = SB_ROOT;
    shellHost.style.cssText = "all: initial;";
    const root = shellHost.attachShadow({ mode: "open" });
    shadowRoot = root;

    const style = document.createElement("style");
    style.textContent = SHELL_CSS;
    root.append(style);

    panel = document.createElement("div");
    panel.id = SB_HOST;

    const tab = document.createElement("button");
    tab.id = SB_TAB;
    tab.title = "window.ml debug";
    tab.textContent = "ml · debug";
    tab.addEventListener("click", toggleOpen);

    const body = document.createElement("div");
    body.id = "ml-sb-body";
    const resize = document.createElement("div");
    resize.id = "ml-sb-resize";
    resize.title = "Drag to resize";
    resize.addEventListener("pointerdown", startResize);
    frame = document.createElement("iframe");
    frame.id = SB_FRAME;
    frame.allow = "clipboard-write";   // delegate the Clipboard API into the extension iframe
    frame.src = chrome.runtime.getURL("sidebar.html");
    body.append(resize, frame);

    panel.append(tab, body);
    root.append(panel);
    (document.documentElement || document.body).append(shellHost);

    chrome.storage.local.get({ [WIDTH_KEY]: DEFAULT_W }, (d: any) => setWidth(d[WIDTH_KEY] || DEFAULT_W));
    window.addEventListener("message", onWindowMessage);
    // Tell injected.js a sidebar now exists so it starts BUFFERING debug events
    // immediately — before the iframe app finishes loading and handshakes `ready`.
    // Events emitted in that load window get replayed on ready instead of dropped.
    window.postMessage({ __mlSidebar: "present" }, "*");
}

function unmount(): void {
    if (!shellHost) return;
    hideLightbox();
    window.removeEventListener("message", onWindowMessage);
    shellHost.remove();
    shellHost = panel = frame = shadowRoot = null;
}

chrome.storage.sync.get({ sidebar: false }, (cfg) => { if (cfg.sidebar) mount(); });
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.sidebar) { if (changes.sidebar.newValue) mount(); else unmount(); }
});
