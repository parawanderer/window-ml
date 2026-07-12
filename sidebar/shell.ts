// Content-script shell for the debug sidebar. It hosts the app in an <iframe>
// that loads an extension page (sidebar.html) — a chrome-extension:// origin the
// host web page can't read across, so the app may safely hold secrets (unlike a
// shadow-root panel injected into the page DOM, which the page can walk into).
//
// This shell owns the slide-out container, tab, and resize handle, and relays
// the page's `__mlDebug` stream (from injected.js, main world) into the iframe.
// injected.js is unchanged: it still emits only after the `__mlSidebar:"ready"`
// handshake, which the shell sends once the iframe app reports it's listening.
const WIDTH_KEY = "ml_debug_width";
const MIN_W = 280, TAB_W = 34, DEFAULT_W = 400;

const SHELL_CSS = `
#ml-sb-host { position: fixed; top: 0; right: 0; height: 100vh; display: flex;
  z-index: 2147483000; transform: translateX(calc(100% - ${TAB_W}px)); transition: transform .22s ease; }
#ml-sb-host.open { transform: translateX(0); }
#ml-sb-tab { width: ${TAB_W}px; flex: 0 0 ${TAB_W}px; cursor: pointer; border: none;
  background: #4f46e5; color: #fff; writing-mode: vertical-rl; text-orientation: mixed;
  letter-spacing: .08em; font: 600 12px system-ui, sans-serif; padding: 10px 0;
  border-radius: 6px 0 0 6px; align-self: center; height: 150px; box-shadow: -2px 0 8px rgba(0,0,0,.35); }
#ml-sb-tab:hover { background: #6366f1; }
#ml-sb-body { position: relative; flex: 1; min-width: 0; height: 100%; box-shadow: -4px 0 20px rgba(0,0,0,.4); }
#ml-sb-resize { position: absolute; left: -3px; top: 0; width: 7px; height: 100%; cursor: ew-resize; z-index: 1; }
#ml-sb-resize:hover, #ml-sb-resize.drag { background: #6366f1; opacity: .5; }
#ml-sb-frame { display: block; width: 100%; height: 100%; border: 0; }
`;

let shellHost: HTMLElement | null = null;   // shadow host in the page's light DOM
let panel: HTMLElement | null = null;       // the sliding container, inside the shadow root
let frame: HTMLIFrameElement | null = null;

function onWindowMessage(e: MessageEvent): void {
    const d = e.data;
    if (!d) return;
    // injected.js (page main world) → relay into the iframe app.
    if (d.__mlDebug && e.source === window) { frame?.contentWindow?.postMessage(d, "*"); return; }
    // The iframe app is listening → handshake injected.js so it starts emitting.
    if (d.__mlSidebarApp === "ready" && frame && e.source === frame.contentWindow) {
        window.postMessage({ __mlSidebar: "ready" }, "*");
    }
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
    shellHost.id = "ml-sb-root";
    shellHost.style.cssText = "all: initial;";
    const root = shellHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = SHELL_CSS;
    root.append(style);

    panel = document.createElement("div");
    panel.id = "ml-sb-host";

    const tab = document.createElement("button");
    tab.id = "ml-sb-tab";
    tab.title = "window.ml debug";
    tab.textContent = "ml · debug";
    tab.addEventListener("click", () => panel?.classList.toggle("open"));

    const body = document.createElement("div");
    body.id = "ml-sb-body";
    const resize = document.createElement("div");
    resize.id = "ml-sb-resize";
    resize.title = "Drag to resize";
    resize.addEventListener("pointerdown", startResize);
    frame = document.createElement("iframe");
    frame.id = "ml-sb-frame";
    frame.src = chrome.runtime.getURL("sidebar.html");
    body.append(resize, frame);

    panel.append(tab, body);
    root.append(panel);
    (document.documentElement || document.body).append(shellHost);

    chrome.storage.local.get({ [WIDTH_KEY]: DEFAULT_W }, (d: any) => setWidth(d[WIDTH_KEY] || DEFAULT_W));
    window.addEventListener("message", onWindowMessage);
}

function unmount(): void {
    if (!shellHost) return;
    window.removeEventListener("message", onWindowMessage);
    shellHost.remove();
    shellHost = panel = frame = null;
}

chrome.storage.sync.get({ sidebar: false }, (cfg) => { if (cfg.sidebar) mount(); });
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.sidebar) { if (changes.sidebar.newValue) mount(); else unmount(); }
});
