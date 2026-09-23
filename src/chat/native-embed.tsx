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
import { pairingBridge, pairingInfo } from "../native/pairing-bridge";
import { bridgeVault } from "../native/vault-bridge";
import { bridgeStore, type PlainStore } from "../native/store-bridge";
import type { EventCache } from "./event-cache";
import { searchBridge } from "../native/search-bridge";
import { Keyring } from "../hub/keyring";
import { agentTarget, attentionForApp, runtimeStorage, sessionChrome, startableFor } from "../native/snapshot";
import type { PairingApi } from "../pairing/api";
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

/** Whether the approval card is scrolled out of the open transcript, as the pane reports it: the app's bar says so. */
const gateAway = signal(false);
/** The pane's report, as one stable function, so watching it does not re-run the pane's effect every render. */
const reportGate = (away: boolean) => { gateAway.value = away; };

/** The vault's answers, once `keepKeysInApp` has made one; and what the app said before `runEmbed` was listening. */
let settleVault: ((m: Extract<ToWeb, { type: "vaultResult" }>) => void) | null = null;
/** The same for the app's plain store, which holds everything about pairing that is not a key. */
let settleStore: ((m: Extract<ToWeb, { type: "storeResult" }>) => void) | null = null;
const early: unknown[] = [];

/**
 * Keep the keyring's secrets in the app's keystore (vault-bridge.ts). Called before the keyring is first opened, which
 * is before `runEmbed`: until then only vault answers are acted on, and anything else the app sends waits for it.
 */
export function keepKeysInApp(): PlainStore {
    const v = bridgeVault(post);
    const s = bridgeStore(post);
    settleVault = v.settle;
    settleStore = s.settle;
    Keyring.keepSecretsIn(v.vault);
    // And everything about this device's pairing that is NOT a key: the phone's WebView then stores nothing at all.
    Keyring.keepRecordsIn(s.store);
    (globalThis as { __wmlReceive?: (raw: unknown) => void }).__wmlReceive = (raw) => {
        const m = parseToWeb(raw);
        if (m?.type === "vaultResult") v.settle(m);
        else if (m?.type === "storeResult") s.settle(m);
        else if (m) early.push(raw);
    };
    return s.store;
}

/**
 * The page could not start (the keystore refused or never answered): say so, rather than leave the app waiting on an
 * account that will never be reported.
 */
export function reportStartFailure(e: unknown): void {
    post({ type: "notice", tone: "error", text: `This phone's keys could not be read: ${e instanceof Error ? e.message : String(e)}` });
}

/**
 * Bring the open session's approval card on screen. A session opened from the list has nothing rendered yet, so this
 * waits for the card across frames rather than scrolling to nothing; it gives up after about a second, since a run may
 * have been answered elsewhere in the meantime.
 */
function showGate(tries = 60): void {
    const card = document.querySelector(".astep-approve");
    if (card) { card.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    if (tries > 0) requestAnimationFrame(() => showGate(tries - 1));
}

/** A Blob as base64, for handing a file to the app's share sheet. */
async function base64Of(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/** An image the app's viewer can draw. React Native's `Image` cannot draw SVG, so an SVG is rasterized here, at twice
 *  its size for a zoom, and anything that fails to rasterize is sent as it was. */
async function drawable(src: string): Promise<string> {
    if (!/^data:image\/svg\+xml[;,]/.test(src)) return src;
    try {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = (img.naturalWidth || 900) * 2;
        canvas.height = (img.naturalHeight || 560) * 2;
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
    } catch {
        return src;
    }
}

/** Show an image full size in the app's viewer. */
function openInApp(src: string): void {
    void drawable(src).then((d) => post({ type: "openImage", src: d }));
}

/** The device services as the app provides them: files go to its share sheet, images to its viewer, text to its
 *  clipboard. Preferences stay in the page's own storage, which lives in the app's data. */
const nativePlatform: ClientPlatform = {
    ...webPlatform,
    kind: "native",
    openImage: openInApp,
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
export function runEmbed(host: SessionHost, opts: { account: BridgeAccount | null; bundle: string; reconnect?: () => void; pairing?: PairingApi; cache?: EventCache }): void {
    initThemeStyle();
    applyCodePrefs();
    installViewPrefs(webPlatform.prefs);
    calm.value = true;
    document.documentElement.toggleAttribute("data-focus", true);
    try { installTooltipLayer(document); } catch { /* no DOM */ }

    // With a cache (the real app, not the demo), a session seen in an earlier launch replays from the phone at once.
    const store = new ChatStore(host, opts.cache ? { cache: opts.cache } : {});
    installServices(hostServices(store, nativePlatform));
    store.start();
    const open = signal<SessionKey | null>(null);
    /** Sessions whose runtime refused a model switch because a page script runs them. */
    const pageOwned = new Set<SessionKey>();

    const sendIndex = perFrame(() => post({ type: "index", runtimes: store.runtimes.value, sessions: [...store.index.value.values()], startable: startableFor(store.runtimes.value) }));
    effect(() => { void store.runtimes.value; void store.index.value; sendIndex(); });
    effect(() => post({ type: "status", status: store.status.value }));
    // What the runtimes need a hand with: the phone's inbox, worded here so the laptop's page and the phone agree.
    effect(() => post({ type: "attention", ...attentionForApp(store.runtimes.value) }));
    /** The chrome for any session: the open one's, and a list row's when the app asks (`chromeFor`). */
    const chromeOf = (key: SessionKey) => {
        const id = parseSessionKey(key);
        const rt = id ? store.runtime(id.runtime) : undefined;
        const s = sessionMap.get(key);
        const live = { pending: s?.status === "pending", ...(s?.title ? { title: s.title } : {}), gateAway: key === open.value && gateAway.value };
        return sessionChrome(key, store.index.value.get(key), rt, store.host.self, s ? live : { pending: false, gateAway: live.gateAway }, pageOwned.has(key));
    };
    const sendChrome = perFrame(() => {
        const key = open.value;
        post({ type: "session", chrome: key ? chromeOf(key) : null });
    });
    effect(() => { void open.value; void store.index.value; void store.runtimes.value; void rev.value; void gateAway.value; sendChrome(); });
    // The store's notices are the app's to show (a toast), and are dismissed here once handed over.
    effect(() => {
        for (const n of store.notices.value) { post({ type: "notice", text: n.text, tone: n.tone }); queueMicrotask(() => store.dismiss(n.id)); }
    });

    const search = searchBridge(store, post);
    const pairing = opts.pairing ? pairingBridge(opts.pairing, post) : null;

    /** Act on one message from the app. */
    const receive = async (m: ToWeb): Promise<void> => {
        switch (m.type) {
            case "pairing":
                if (pairing) await pairing(m);
                else post({ type: "pairingResult", id: m.id, ok: false, error: "This page cannot pair." });
                return;
            case "theme":
                // Through the page's own theme path, which also swaps the code colours: setting `data-theme` alone left
                // light-theme syntax colours on a dark code block, the identifiers all but invisible.
                pageTheme.value = m.theme.scheme;
                applyTheme();
                document.documentElement.style.setProperty("--safe-left", `${m.theme.insets.left}px`);
                document.documentElement.style.setProperty("--safe-right", `${m.theme.insets.right}px`);
                return;
            case "open": {
                // A row found by search may be ARCHIVED: bring it back into the live store first, or the transcript
                // opens on a session the store does not have. The app never hears about archives.
                const found = search.memory.row(m.key);
                if (found?.archived) {
                    const r = await store.send({ type: "session.unarchive", session: found.id });
                    if (!r.ok) return;   // the store says why, as a notice
                }
                open.value = m.key;
                store.open(m.key);
                if (m.approval) showGate();
                return;
            }
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
                const images = m.images?.filter((i) => i.startsWith("data:image/")) ?? [];
                const extra = { ...(m.model ? { model: m.model } : {}), ...(images.length ? { images } : {}) };
                let r;
                if (m.kind === "agent") {
                    const target = agentTarget(m.target);
                    if (!target) {
                        // Said as a notice too: the store says its own refusals, and this one never reached it.
                        const error = (m.target as { kind?: unknown } | undefined)?.kind === "blank" ? "A new tab opens a web page: give an address starting https://, or leave it empty." : "Pick a tab for the agent, or a new one.";
                        post({ type: "notice", text: error, tone: "error" });
                        post({ type: "sent", id: m.id, ok: false, error });
                        return;
                    }
                    r = await store.send({ type: "agent.start", runtime: m.runtime, task: m.text, target, ...extra });
                } else {
                    r = await store.send({ type: "chat.start", runtime: m.runtime, text: m.text, ...extra });
                }
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
            // What the ⋮ sheet asks of a session. Each is answered by `sent`; a refusal is also a notice from the store,
            // in its words, so the app need not word one. A deleted session leaves the index, and the app closes it.
            case "pin":
            case "rename":
            case "delete": {
                const id = parseSessionKey(m.key);
                if (!id) { post({ type: "sent", id: m.id, ok: false, error: "That is not a session." }); return; }
                const r = await store.send(m.type === "pin" ? { type: "session.pin", session: id, pinned: m.on }
                    : m.type === "rename" ? { type: "session.rename", session: id, title: m.title.trim().slice(0, 200) }
                        : { type: "session.delete", session: id });
                post({ type: "sent", id: m.id, ok: r.ok, ...(r.ok ? {} : { error: r.error.message || r.error.code }) });
                return;
            }
            // An agent's target is picked from the runtime's own tabs, asked each time the picker opens.
            case "tabs": {
                const r = await store.send({ type: "tabs.list", runtime: m.runtime }, { quiet: true });
                post(r.ok ? { type: "tabsResult", id: m.id, tabs: r.data.tabs, groups: r.data.groups ?? [], withheld: r.data.withheld ?? 0 }
                    : { type: "tabsResult", id: m.id, tabs: null, groups: [], withheld: 0, error: r.error.message || r.error.code });
                return;
            }
            // The same check as a new agent's target: a run is picked up only on a page the app named properly.
            case "resumeRun": {
                const id = parseSessionKey(m.key);
                const target = agentTarget(m.target);
                if (!id || !target) {
                    const error = !id ? "That is not a session." : "A new tab opens a web page: give an address starting https://, or leave it empty.";
                    post({ type: "notice", text: error, tone: "error" });
                    post({ type: "sent", id: m.id, ok: false, error });
                    return;
                }
                const r = await store.send({ type: "session.resume", session: id, target });
                post({ type: "sent", id: m.id, ok: r.ok, ...(r.ok ? {} : { error: r.error.message || r.error.code }) });
                return;
            }
            // What a runtime keeps, for the Runtimes screen: read over the contract, worded here.
            case "storage": {
                const rt = store.runtime(m.runtime);
                const r = await store.send({ type: "storage.stats", runtime: m.runtime }, { quiet: true });
                post(r.ok ? { type: "storageResult", id: m.id, storage: runtimeStorage(r.data, rt?.name ?? m.runtime) }
                    : { type: "storageResult", id: m.id, storage: null, error: r.error.message || r.error.code });
                return;
            }
            case "chromeFor": post({ type: "chromeOf", id: m.id, chrome: chromeOf(m.key) }); return;
            // The page's capture goes to the app as `openImage`, the same full-size view a transcript image opens in.
            case "peek": {
                const id = parseSessionKey(m.key);
                const r = id ? await store.send({ type: "tab.screenshot", runtime: id.runtime, target: { session: id } }) : null;
                if (r?.ok) openInApp(r.data.image);
                post({ type: "sent", id: m.id, ok: !!r?.ok, ...(r?.ok ? {} : { error: r ? r.error.message || r.error.code : "That is not a session." }) });
                return;
            }
            case "models": {
                const r = await store.send({ type: "models.list", runtime: m.runtime }, { quiet: true });
                post(r.ok ? { type: "models", runtime: m.runtime, models: r.data.models } : { type: "models", runtime: m.runtime, models: null, error: r.error.message || r.error.code });
                return;
            }
            // The app's bar is about a card several screens down: bring it to the reader, which is all the app can
            // ask. Answering stays with the card, where the arguments, the grants and the warnings are.
            case "showApproval": showGate(); return;
            case "search": await search.handle(m); return;
            case "resume": opts.reconnect?.(); return;
        }
    };
    // The app calls this with each message (react-native-webview's `injectJavaScript`); anything malformed is dropped.
    const onRaw = (raw: unknown) => {
        const m = parseToWeb(raw);
        if (m?.type === "vaultResult") settleVault?.(m);
        else if (m?.type === "storeResult") settleStore?.(m);
        else if (m) void receive(m);
    };
    (globalThis as { __wmlReceive?: (raw: unknown) => void }).__wmlReceive = onRaw;
    for (const raw of early.splice(0)) onRaw(raw);

    render(<Embed store={store} open={open} />, document.getElementById("root") || document.body);
    post({ type: "account", account: opts.account });
    if (opts.pairing) post({ type: "pairingInfo", info: pairingInfo(opts.pairing) });
    post({ type: "ready", bundle: opts.bundle });
}

/** The page: the open session's transcript, or nothing while the app shows a screen of its own. */
function Embed({ store, open }: { store: ChatStore; open: { value: SessionKey | null } }) {
    const key = open.value;
    return (
        <div class="chat calm narrow native-embed">
            {key ? <SessionPane store={store} sessionKey={key} narrow native onGate={reportGate} /> : null}
        </div>
    );
}
