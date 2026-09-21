// native-embed.tsx — THE PAGE INSIDE THE PHONE APP'S WEBVIEW (docs/spec/NATIVE_SHELL.md): the client (store, host,
// services) and ONE thing drawn, the open session's calm transcript. Everything a person operates (the list, the header,
// the composer, the pickers, settings) is native in `mobile/`, and the two talk over the bridge (src/native/bridge.ts):
// this page says what there is to show, the app says what the person did.
//
// `runEmbed(host)` is the whole page; two entries call it. `native-embed-app.tsx` over the keyring and a hub host (the
// real app), `native-embed-demo.tsx` over the fake host's demo world (for building the app's screens with no hub).

import { render } from "preact";
import { effect, signal } from "@preact/signals";
import type { SessionHost, SessionKey } from "../session-host";
import { parseSessionKey } from "../session-host";
import { encode, parseToWeb, type BridgeAccount, type ToNative, type ToWeb } from "../native/bridge";
import { sessionChrome } from "../native/snapshot";
import { installServices, services } from "../sidebar/services";
import { installTooltipLayer } from "../sidebar/tooltip-layer";
import { applyCodePrefs, applyTheme, initThemeStyle, pageTheme } from "../sidebar/prefs";
import { rev, sessionMap } from "../sidebar/store";
import { SessionPane } from "./chat-app";
import { ChatStore } from "./chat-store";
import { hostServices } from "./host-services";
import { webPlatform, type ClientPlatform } from "./platform";
import { calm, installViewPrefs } from "./view-mode";

/** Post a message to the app. Outside the app (a desktop test page) it goes to `__nativeOut`, for the specs to read. */
function post(msg: ToNative): void {
    const g = globalThis as { ReactNativeWebView?: { postMessage(s: string): void }; __nativeOut?: string[] };
    const data = encode(msg);
    if (g.ReactNativeWebView) g.ReactNativeWebView.postMessage(data);
    else (g.__nativeOut ??= []).push(data);
}

/** A Blob as base64, for handing a file to the app's share sheet. */
async function base64Of(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/** The device services as the app provides them: files go to its share sheet, images to its viewer, text to its
 *  clipboard. Preferences stay in the page's own storage, which lives in the app's data. */
const nativePlatform: ClientPlatform = {
    ...webPlatform,
    kind: "native",
    openImage: (src) => post({ type: "openImage", src }),
    saveFile: (name, data) => { void base64Of(data).then((b) => post({ type: "saveFile", name, mime: data.type || "application/octet-stream", base64: b })); },
    copyText: async (text) => { post({ type: "copyText", text }); return true; },
};

/** Coalesce a stream of posts into one per frame: an index that changes ten times in a burst crosses once. */
function perFrame(send: () => void): () => void {
    let queued = false;
    return () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; send(); });
    };
}

/** Everything the page does, over `host`. `account` is what the app's settings show about this device. */
export function runEmbed(host: SessionHost, opts: { account: BridgeAccount | null; bundle: string; reconnect?: () => void }): void {
    initThemeStyle();
    applyCodePrefs();
    installViewPrefs(webPlatform.prefs);
    calm.value = true;
    document.documentElement.toggleAttribute("data-focus", true);
    try { installTooltipLayer(document); } catch { /* no DOM */ }

    const store = new ChatStore(host);
    installServices(hostServices(store, nativePlatform));
    store.start();
    const open = signal<SessionKey | null>(null);
    /** Sessions whose runtime refused a model switch because a page script runs them. */
    const pageOwned = new Set<SessionKey>();

    const sendIndex = perFrame(() => post({ type: "index", runtimes: store.runtimes.value, sessions: [...store.index.value.values()] }));
    effect(() => { void store.runtimes.value; void store.index.value; sendIndex(); });
    effect(() => post({ type: "status", status: store.status.value }));
    const sendChrome = perFrame(() => {
        const key = open.value;
        if (!key) { post({ type: "session", chrome: null }); return; }
        const id = parseSessionKey(key);
        const rt = id ? store.runtime(id.runtime) : undefined;
        const s = sessionMap.get(key);
        post({ type: "session", chrome: sessionChrome(key, store.index.value.get(key), rt, store.host.self, s ? { pending: s.status === "pending", title: s.title } : undefined, pageOwned.has(key)) });
    });
    effect(() => { void open.value; void store.index.value; void store.runtimes.value; void rev.value; sendChrome(); });
    // The store's notices are the app's to show (a toast), and are dismissed here once handed over.
    effect(() => {
        for (const n of store.notices.value) { post({ type: "notice", text: n.text, tone: n.tone }); queueMicrotask(() => store.dismiss(n.id)); }
    });

    /** Act on one message from the app. */
    const receive = async (m: ToWeb): Promise<void> => {
        switch (m.type) {
            case "theme":
                // Through the page's own theme path, which also swaps the code colours: setting `data-theme` alone left
                // light-theme syntax colours on a dark code block, the identifiers all but invisible.
                pageTheme.value = m.theme.scheme;
                applyTheme();
                document.documentElement.style.setProperty("--safe-left", `${m.theme.insets.left}px`);
                document.documentElement.style.setProperty("--safe-right", `${m.theme.insets.right}px`);
                return;
            case "open":
                open.value = m.key;
                store.open(m.key);
                return;
            case "close":
                open.value = null;
                store.close();
                return;
            case "send": {
                const r = await services().sendToSession(m.key, m.text, m.images);
                post({ type: "sent", id: m.id, ok: r.ok, ...(r.ok ? {} : { error: r.error ?? "not sent" }) });
                return;
            }
            case "start": {
                if (m.kind === "agent") { post({ type: "sent", id: m.id, ok: false, error: "Starting an agent from the phone comes with the tab picker." }); return; }
                const r = await store.send({ type: "chat.start", runtime: m.runtime, text: m.text, ...(m.model ? { model: m.model } : {}) });
                post(r.ok ? { type: "sent", id: m.id, ok: true, session: `${r.data.session.runtime}:${r.data.session.hash}` }
                    : { type: "sent", id: m.id, ok: false, error: r.error.message || r.error.code });
                return;
            }
            case "cancel": services().cancelSession(m.key); return;
            case "continue": services().continueSession(m.key); return;
            case "answer": services().answerApproval(m.key, m.seq, m.decision, !!m.persist); return;
            case "switchModel": {
                const id = parseSessionKey(m.key);
                if (!id) return;
                const r = await store.send({ type: "session.model", session: id, model: m.model });
                if (!r.ok && r.error.code === "unsupported") { pageOwned.add(m.key); sendChrome(); }
                return;
            }
            case "models": {
                const r = await store.send({ type: "models.list", runtime: m.runtime }, { quiet: true });
                post(r.ok ? { type: "models", runtime: m.runtime, models: r.data.models } : { type: "models", runtime: m.runtime, models: null, error: r.error.message || r.error.code });
                return;
            }
            case "resume": opts.reconnect?.(); return;
        }
    };
    // The app calls this with each message (react-native-webview's `injectJavaScript`); anything malformed is dropped.
    (globalThis as { __wmlReceive?: (raw: unknown) => void }).__wmlReceive = (raw) => {
        const m = parseToWeb(raw);
        if (m) void receive(m);
    };

    render(<Embed store={store} open={open} />, document.getElementById("root") || document.body);
    post({ type: "account", account: opts.account });
    post({ type: "ready", bundle: opts.bundle });
}

/** The page: the open session's transcript, or nothing while the app shows a screen of its own. */
function Embed({ store, open }: { store: ChatStore; open: { value: SessionKey | null } }) {
    const key = open.value;
    return (
        <div class="chat calm narrow native-embed">
            {key ? <SessionPane store={store} sessionKey={key} narrow native /> : null}
        </div>
    );
}
