// parent-channel.ts — the sidebar app's one line to its host: the content-script shell, or the DevTools panel.

// On a web page the shell's iframe has the PAGE as its parent window, so a `window.parent.postMessage` reaches the
// page's scripts, and a message whose source is `window.parent` may be the page's own (docs/spec/SITE_ACCESS.md,
// attack 16). There the app and the shell talk over a MessagePort, which the shell hands only to a frame that showed
// it a secret through the extension's own messaging, where the page sees nothing. Under the DevTools panel the parent
// is an extension page, and in a test the app is its own top window: there plain window messages are safe and stay.

type Handler = (data: any) => void;

let handler: Handler = () => { /* set by onHostMessage */ };
let port: MessagePort | null = null;
/** What the app said before the port arrived, sent in order once it does. */
const outbox: unknown[] = [];

/** Whether the parent window can be trusted with plain window messages: it is this extension's own page (the DevTools
 *  panel), or there is no parent at all. A cross-origin parent throws on `location`, which is the web-page case. */
export function parentIsTrusted(): boolean {
    if (window.parent === window) return true;
    try { return window.parent.location.origin === location.origin; } catch { return false; }
}

/** Send `msg` to the host. Queued until the port arrives on a web page. */
export function toHost(msg: unknown): void {
    if (parentIsTrusted()) { window.parent.postMessage(msg, "*"); return; }
    if (port) port.postMessage(msg);
    else outbox.push(msg);
}

/** Whether the channel to the shell has been opened (its hello sent). */
let opened = false;   // state: plumbing — this frame's hello to the shell, sent once
/** Called once the shell's port arrives. */
let onPort: () => void = () => { /* set by awaitHost */ };

/** Open the channel on a web page: send the shell a nonce through the extension's messaging, and take the port only
 *  from a window message carrying it. */
function openChannel(): void {
    if (opened) return;
    opened = true;
    const nonce = crypto.randomUUID();
    window.addEventListener("message", (e) => {
        // Only the shell knows the nonce, so a port carrying it is the shell's. Every other window message, the
        // page's included, is ignored here.
        if (port || !e.data || e.data.__mlHostPort !== nonce || !e.ports[0]) return;
        port = e.ports[0];
        port.onmessage = (m) => { if (m.data) handler(m.data); };
        // Taking the port: the shell keeps its current one until this ack of the nonce arrives first on the new one, so
        // a page's own frame of sidebar.html (which says hello too) cannot cut the real channel.
        port.postMessage({ __mlPortAck: nonce });
        for (const msg of outbox.splice(0)) port.postMessage(msg);
        onPort();
    });
    // The nonce goes to the shell through the extension's messaging, which reaches the tab's content scripts and never
    // the page. The shell runs in the top frame only.
    chrome.tabs.getCurrent((tab) => {
        if (tab?.id == null) return;
        chrome.tabs.sendMessage(tab.id, { type: "ML_HOST_HELLO", nonce }, { frameId: 0 }).catch(() => { /* the shell is gone */ });
    });
}

/**
 * Run `ready` once this frame is known to be the shell's: at once under a trusted parent (the DevTools panel, or no
 * parent), and on a web page only when the shell's port arrives. The shell hands its port to the frame IT mounted and
 * no other, so sidebar.html framed by a page itself (it is web-accessible: in the page's own shadow root, an <object>,
 * an <embed>, a frame navigated to it) never runs `ready`, and shows nothing of the sessions it would otherwise load.
 * @param ready what to run once hosted (the app's mount)
 */
export function awaitHost(ready: () => void): void {
    if (parentIsTrusted() || port) { ready(); return; }
    onPort = () => { onPort = () => {}; ready(); };
    openChannel();
}

/** Receive the host's messages with `fn`. Called once, at mount: it also opens the channel on a web page. */
export function onHostMessage(fn: Handler): void {
    handler = fn;
    if (parentIsTrusted()) {
        window.addEventListener("message", (e) => { if (e.source === window.parent && e.data) handler(e.data); });
        return;
    }
    openChannel();
}
