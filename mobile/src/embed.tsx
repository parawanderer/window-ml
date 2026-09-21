// embed.tsx — THE APP'S SIDE OF THE BRIDGE (docs/spec/NATIVE_SHELL.md): it writes the page (src/generated/embed.ts) to the
// app's storage, holds the ONE WebView that loads it, keeps what the page reports (the account, the connection, the
// runtimes and sessions, the open session's chrome), and turns what a person does into messages to the page. Screens read
// it through `useEmbed()` and never talk to the WebView themselves.
//
// The WebView is created once and never remounted: a remount would reload the page and reconnect to the hub, which is
// the lag this app exists to get rid of. `EmbedWebView` is rendered by the session layer, which stays mounted.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking, Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { encode, parseToNative, type BridgeAccount, type PairingCall, type PairingInfo, type SessionChrome, type ToWeb } from "../../src/native/bridge";
import type { HostStatus, ListedSession, ModelChoice, RuntimeInfo, SessionSummary } from "../../src/session-host";
import { EMBED } from "./generated/embed";
import { answerVault } from "./vault";

/** What the page has reported, as the screens read it. */
export interface EmbedState {
    /** the page has started and answered */
    ready: boolean;
    /** undefined until the page says; null before this device is in an account */
    account: BridgeAccount | null | undefined;
    status: HostStatus;
    runtimes: RuntimeInfo[];
    sessions: SessionSummary[];
    /** the open session's header and composer, or null with none open */
    chrome: SessionChrome | null;
    /** short news for a toast: a failed command, and the like */
    notice: { id: number; text: string; tone: "error" | "info" } | null;
    /** the page is the demo world (a fake host), not this device's account */
    demo: boolean;
    /** what this device can do about accounts; null until the page says */
    pairingInfo: PairingInfo | null;
}

/** A pairing call's answer: its value, or the reason in the page's words. */
export type PairingAnswer<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** What the screens can do. */
export interface EmbedApi extends EmbedState {
    /** Open a session; `approval` also brings its pending approval on screen. */
    open(key: string, approval?: boolean): void;
    close(): void;
    /** Send to a session; resolves with whether the runtime took it (the composer's drafts hang on this). */
    send(key: string, text: string, images?: string[]): Promise<{ ok: boolean; error?: string }>;
    /** Start a chat; resolves with the new session's key, or the reason it did not start. */
    start(runtime: string, text: string, model?: string): Promise<{ ok: boolean; error?: string; session?: string }>;
    cancel(key: string): void;
    answer(key: string, seq: number, decision: boolean): void;
    switchModel(key: string, model: string): void;
    /** The models a runtime offers, asked of it each time. */
    models(runtime: string): Promise<ModelChoice[] | null>;
    resume(): void;
    /** Bring the open session's pending approval on screen: the card in the transcript is what answers it. */
    showApproval(): void;
    /**
     * Search history, on one runtime or (null) on all of them. `onPage` is called with each page as it arrives (what
     * the page already holds comes first, then what the runtimes answer); `more()` asks for the next page, and `stop()`
     * ends it. An empty query lists everything, newest first, which is how the list's older sessions are reached.
     */
    search(query: string, runtime: string | null, onPage: (rows: ListedSession[], more: boolean, error?: string) => void): { more(): void; stop(): void };
    /** Tell the page the theme and insets. */
    theme(msg: Extract<ToWeb, { type: "theme" }>["theme"]): void;
    /** Call one of the page's pairing methods (src/native/pairing-bridge.ts). */
    pairing<T = unknown>(call: PairingCall, args?: Record<string, unknown>): Promise<PairingAnswer<T>>;
    /** Hear when an offer this device made is answered or fails. Returns the unsubscribe. */
    onPairingDone(cb: (d: { offer: string; ok: boolean; error?: string }) => void): () => void;
}

const EmbedContext = createContext<EmbedApi | null>(null);

/** The bridge, for a screen. */
export function useEmbed(): EmbedApi {
    const v = useContext(EmbedContext);
    if (!v) throw new Error("useEmbed outside <EmbedProvider>");
    return v;
}

/** Write the page and its fonts to `documents/web/`, only when the bundled page changed; answers the page's file URI. */
function writePage(): string {
    const dir = new Directory(Paths.document, "web");
    if (!dir.exists) dir.create({ intermediates: true });
    const page = new File(dir, "index.html");
    const stamp = new File(dir, "id.txt");
    const current = stamp.exists ? stamp.textSync() : "";
    if (current !== EMBED.id || !page.exists) {
        if (page.exists) page.delete();
        page.create();
        page.write(EMBED.html);
        const fonts = new Directory(dir, "fonts");
        if (!fonts.exists) fonts.create({ intermediates: true });
        for (const [name, b64] of Object.entries(EMBED.fonts as Record<string, string>)) {
            const f = new File(fonts, name);
            if (!f.exists) { f.create(); f.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); }
        }
        if (stamp.exists) stamp.delete();
        stamp.create();
        stamp.write(EMBED.id);
    }
    return page.uri;
}

let seq = 0;
const nextId = () => `n${Date.now().toString(36)}-${++seq}`;

/**
 * Is this message from the page we wrote, rather than from anything else a WebView could be showing? What keeps that
 * true is `onShouldStartLoadWithRequest`, which lets this WebView load nothing outside the page's own directory; this
 * is the second look. Android reports no URL on a `file://` page's messages (the string "null"), and a missing one is
 * therefore not evidence of anything. The path is matched by the page's own file, because Android also names the
 * app's files `/data/data/<id>` where expo-file-system writes them as `/data/user/0/<id>`.
 */
function ourPage(url: string | undefined): boolean {
    if (!url || url === "null") return true;
    return url.startsWith("file://") && url.replace(/[?#].*$/, "").endsWith("/web/index.html");
}

/** The shared WebView's handle, set by `EmbedWebView`. */
type WebViewHandle = { injectJavaScript(js: string): void } | null;

const WebViewSlot = createContext<{ ref: { current: WebViewHandle }; uri: string; onMessage: (e: WebViewMessageEvent) => void } | null>(null);

/** The provider: holds the state, the pending requests, and the WebView's props. Wrap the app in it once. */
export function EmbedProvider({ children }: { children: ReactNode }) {
    const uri = useMemo(writePage, []);
    const ref = useRef<WebViewHandle>(null);
    const [state, setState] = useState<EmbedState>({
        ready: false, account: undefined, status: { state: "connecting" }, runtimes: [], sessions: [], chrome: null, notice: null, demo: EMBED.demo, pairingInfo: null,
    });
    const pendingPairing = useRef(new Map<string, (a: PairingAnswer) => void>());
    const pairingDone = useRef(new Set<(d: { offer: string; ok: boolean; error?: string }) => void>());
    const pendingSent = useRef(new Map<string, (r: { ok: boolean; error?: string; session?: string }) => void>());
    const pendingModels = useRef(new Map<string, ((m: ModelChoice[] | null) => void)[]>());
    const searches = useRef(new Map<string, (rows: ListedSession[], more: boolean, error?: string) => void>());
    const queue = useRef<string[]>([]);
    const readyRef = useRef(false);

    /** Post a message to the page; held until the page says it is ready. */
    const post = useCallback((msg: ToWeb) => {
        const js = `window.__wmlReceive && window.__wmlReceive(${JSON.stringify(encode(msg))}); true;`;
        if (!readyRef.current || !ref.current) { queue.current.push(js); return; }
        ref.current.injectJavaScript(js);
    }, []);

    const onMessage = useCallback((e: WebViewMessageEvent) => {
        const m = parseToNative(e.nativeEvent.data);
        if (!m) return;
        switch (m.type) {
            // The keyring's secrets: answered at once, not queued behind `ready` (the page needs its keys to get there).
            case "vault":
                if (!ourPage(e.nativeEvent.url)) return;
                void answerVault(m).then((r) => ref.current?.injectJavaScript(`window.__wmlReceive && window.__wmlReceive(${JSON.stringify(encode(r))}); true;`));
                return;
            case "ready":
                readyRef.current = true;
                for (const js of queue.current.splice(0)) ref.current?.injectJavaScript(js);
                setState((s) => ({ ...s, ready: true }));
                return;
            case "account": setState((s) => ({ ...s, account: m.account })); return;
            case "status": setState((s) => ({ ...s, status: m.status })); return;
            case "index": setState((s) => ({ ...s, runtimes: m.runtimes, sessions: m.sessions })); return;
            case "session": setState((s) => ({ ...s, chrome: m.chrome })); return;
            case "notice": setState((s) => ({ ...s, notice: { id: Date.now(), text: m.text, tone: m.tone } })); return;
            case "sent": { const r = pendingSent.current.get(m.id); pendingSent.current.delete(m.id); r?.(m); return; }
            case "models": { const rs = pendingModels.current.get(m.runtime) ?? []; pendingModels.current.delete(m.runtime); rs.forEach((r) => r(m.models)); return; }
            case "searchResult": { searches.current.get(m.id)?.(m.rows, m.more, m.error); return; }
            case "pairingInfo": setState((s) => ({ ...s, pairingInfo: m.info })); return;
            case "pairingResult": {
                const r = pendingPairing.current.get(m.id);
                pendingPairing.current.delete(m.id);
                r?.(m.ok ? { ok: true, value: m.value } : { ok: false, error: m.error ?? "It did not complete. Try again." });
                return;
            }
            case "pairingDone": for (const cb of pairingDone.current) cb(m); return;
            case "copyText": void Clipboard.setStringAsync(m.text).then(() => Haptics.selectionAsync()); return;
            case "openLink": void Linking.openURL(m.url); return;
            case "openImage": void Share.share({ url: m.src }); return;
            case "saveFile": {
                const f = new File(Paths.cache, m.name);
                if (f.exists) f.delete();
                f.create();
                f.write(Uint8Array.from(atob(m.base64), (c) => c.charCodeAt(0)));
                void Sharing.shareAsync(f.uri, { mimeType: m.mime });
                return;
            }
        }
    }, []);

    /** A request answered by `sent`: resolves when the page says, or after 60s as a failure (never hangs a composer). */
    const request = useCallback((build: (id: string) => ToWeb) => new Promise<{ ok: boolean; error?: string; session?: string }>((resolve) => {
        const id = nextId();
        const timer = setTimeout(() => { pendingSent.current.delete(id); resolve({ ok: false, error: "No answer from the runtime in a minute." }); }, 60_000);
        pendingSent.current.set(id, (r) => { clearTimeout(timer); resolve(r); });
        post(build(id));
    }), [post]);

    const api = useMemo<EmbedApi>(() => ({
        ...state,
        open: (key, approval) => post({ type: "open", key, ...(approval ? { approval } : {}) }),
        close: () => post({ type: "close" }),
        send: (key, text, images) => request((id) => ({ type: "send", id, key, text, ...(images?.length ? { images } : {}) })),
        start: (runtime, text, model) => request((id) => ({ type: "start", id, runtime, kind: "chat", text, ...(model ? { model } : {}) })),
        cancel: (key) => post({ type: "cancel", key }),
        answer: (key, s, decision) => post({ type: "answer", key, seq: s, decision }),
        switchModel: (key, model) => post({ type: "switchModel", key, model }),
        models: (runtime) => new Promise((resolve) => {
            const list = pendingModels.current.get(runtime) ?? [];
            list.push(resolve);
            pendingModels.current.set(runtime, list);
            if (list.length === 1) post({ type: "models", runtime });
        }),
        resume: () => post({ type: "resume" }),
        showApproval: () => post({ type: "showApproval" }),
        search: (query, runtime, onPage) => {
            const id = nextId();
            searches.current.set(id, onPage);
            const where = runtime ? { runtime } : {};
            post({ type: "search", id, query, ...where });
            return {
                more: () => post({ type: "search", id, query, ...where, more: true }),
                stop: () => { searches.current.delete(id); },
            };
        },
        theme: (theme) => post({ type: "theme", theme }),
        pairing: <T,>(call: PairingCall, args?: Record<string, unknown>) => new Promise<PairingAnswer<T>>((resolve) => {
            const id = nextId();
            // A join's lookups and confirmations talk to the hub: a minute is generous, and a screen never waits forever.
            const timer = setTimeout(() => { pendingPairing.current.delete(id); resolve({ ok: false, error: "No answer from the page in a minute. Try again." }); }, 60_000);
            pendingPairing.current.set(id, (a) => { clearTimeout(timer); resolve(a as PairingAnswer<T>); });
            post({ type: "pairing", id, call, ...(args ? { args } : {}) });
        }),
        onPairingDone: (cb) => { pairingDone.current.add(cb); return () => { pairingDone.current.delete(cb); }; },
    }), [state, post, request]);

    return (
        <WebViewSlot.Provider value={{ ref, uri, onMessage }}>
            <EmbedContext.Provider value={api}>{children}</EmbedContext.Provider>
        </WebViewSlot.Provider>
    );
}

/** The one WebView. Render it exactly once, in a place that never unmounts (the session layer). */
export function EmbedWebView({ backgroundColor }: { backgroundColor: string }) {
    const slot = useContext(WebViewSlot);
    if (!slot) return null;
    const dir = slot.uri.replace(/index\.html$/, "");
    return (
        <WebView
            ref={(w) => { slot.ref.current = w; }}
            source={{ uri: slot.uri }}
            originWhitelist={["file://*"]}
            allowFileAccess
            allowingReadAccessToURL={dir}
            onMessage={slot.onMessage}
            // The page never navigates: a link is handed to the system browser, after the page asks.
            onShouldStartLoadWithRequest={(r) => r.url.startsWith(dir)}
            setSupportMultipleWindows={false}
            javaScriptCanOpenWindowsAutomatically={false}
            hideKeyboardAccessoryView
            keyboardDisplayRequiresUserAction={false}
            overScrollMode="never"
            style={{ flex: 1, backgroundColor }}
            containerStyle={{ backgroundColor }}
        />
    );
}
