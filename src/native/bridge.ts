// bridge.ts — THE NATIVE SHELL'S BRIDGE: every message between the phone app (React Native, `mobile/`) and the page in
// its WebView (`src/chat/native-embed.tsx`), one union each way, and the check both sides run on whatever arrives
// (docs/spec/NATIVE_SHELL.md). Pure and dependency-free apart from contract TYPES, so the app imports it as it is.
//
// The page OWNS the client (keyring, hub connection, store) and says what there is to show; the app draws everything
// a person operates and says what they did. Keys and sealed bytes never cross: the app sees what its screens show.
//
// A message that fails the check is DROPPED, never half-used: an older app and a newer page (or the reverse) then lose
// one feature instead of misreading each other. Every message carries the bridge version `v`; a different major is
// refused whole.

import type { HostStatus, ListedSession, ModelChoice, RuntimeInfo, SessionKind, SessionStatus, SessionSummary, TabGroupInfo, TabInfo } from "../session-host";

/** The bridge's version. Bump it when a message changes shape in a way an older peer would misread. */
export const BRIDGE_VERSION = 1;

/** A theme the page draws in, as the app's system settings say. */
export interface BridgeTheme {
    scheme: "light" | "dark";
    /** the system text size, 1 = default */
    fontScale: number;
    /** safe-area insets the page must keep clear of, in CSS pixels */
    insets: { top: number; bottom: number; left: number; right: number };
    reducedMotion: boolean;
}

/** What the open session's native chrome (header, composer, waiting bar) needs, and nothing the transcript draws. */
export interface SessionChrome {
    key: string;
    kind: SessionKind;
    title: string;
    status: SessionStatus;
    runtime: string;
    runtimeName: string;
    model: string | null;
    pendingApprovals: number;
    /** the card that answers the approval is scrolled out of the transcript: the app says so in its own bar */
    approvalOffscreen: boolean;
    /** the composer can send to it; when false, `readOnly` says why */
    canSend: boolean;
    readOnly?: string;
    /** a run in flight: the composer's button stops it while the box is empty */
    running: boolean;
    /** the model pill can switch it; when false, `switchNote` says why */
    canSwitchModel: boolean;
    switchNote?: string;
    /** the runtime holds a pin on it, which keeps it from being expired or evicted */
    pinned: boolean;
    /** what the ⋮ sheet may offer: each is the runtime reachable AND this device holding the grant to ask */
    canPin: boolean;
    canRename: boolean;
    canDelete: boolean;
    /** the run's tab is still open and the runtime can capture it for this device: the sheet offers "Look at the page" */
    canPeek: boolean;
    /** a saved agent run whose tab has closed, which this device may pick back up on a page (`resumeRun`) */
    canResume: boolean;
}

/** One thing a runtime needs a person's hand for, as the phone lists it (src/chat/attention.ts words it). */
export interface AttentionRow {
    /** `runtime:code`: what dismissing a suggestion remembers */
    key: string;
    runtime: string;
    runtimeName: string;
    level: "blocks" | "limits" | "suggests";
    title: string;
    detail: string;
}

/** The account this device is in, as the app shows it; null before one. */
export interface BridgeAccount { label: string; hubUrl: string; root: boolean }

/** The pairing calls the app can make, one per method of the page's `PairingApi` (src/pairing/api.ts), plus cancelling an
 *  offer. What crosses is plain data: a found offer and an offer in progress stay on the page, and cross as tokens. */
export type PairingCall = "load" | "createAccount" | "beginOffer" | "cancelOffer" | "lookupOffer" | "lookupScanned" | "confirmOffer" | "devices" | "revoke" | "leave";

/** What this device can do about accounts, from its `PairingApi`: shown by the app's first-run and pairing screens. */
export interface PairingInfo {
    canCreate: boolean;
    joinsAs: string;
    defaultLabel: string;
    defaultHubUrl: string;
    rootKeptIn?: string;
    /** a scanned QR code can be checked (`lookupScanned`) */
    canScan: boolean;
    /** the device list, revoking and leaving are offered */
    devices: boolean;
}

/** Page → app. */
export type ToNative =
    | { type: "ready"; bundle: string }
    | { type: "account"; account: BridgeAccount | null }
    | { type: "status"; status: HostStatus }
    /** What the runtimes need a hand with, most urgent first; `count` is the problems only, what the inbox badge says. */
    | { type: "attention"; items: AttentionRow[]; count: number }
    /** `startable`: the runtimes this device may start each kind of session on, by the page's rule (grants.ts `mayStart`). */
    | { type: "index"; runtimes: RuntimeInfo[]; sessions: SessionSummary[]; startable?: { chat: string[]; agent: string[] } }
    | { type: "session"; chrome: SessionChrome | null }
    /** The answer to `tabs`: a runtime's open tabs (null when it would not say, and `error` why), for an agent's target. */
    | { type: "tabsResult"; id: string; tabs: TabInfo[] | null; groups: TabGroupInfo[]; withheld: number; error?: string }
    /** The answer to `chromeFor`: that session's chrome, or null when it is not in the index. */
    | { type: "chromeOf"; id: string; chrome: SessionChrome | null }
    | { type: "models"; runtime: string; models: ModelChoice[] | null; error?: string }
    | { type: "sent"; id: string; ok: boolean; error?: string; session?: string }
    | { type: "notice"; text: string; tone: "error" | "info" }
    | { type: "saveFile"; name: string; mime: string; base64: string }
    | { type: "openImage"; src: string }
    | { type: "openLink"; url: string }
    | { type: "copyText"; text: string }
    | { type: "pairingInfo"; info: PairingInfo }
    /** the answer to a `pairing` call: its value, or the reason it failed in the page's words (pairingProblem) */
    | { type: "pairingResult"; id: string; ok: boolean; value?: unknown; error?: string }
    /** an offer this device made was answered (paired) or failed; `offer` is the token `beginOffer` returned */
    | { type: "pairingDone"; offer: string; ok: boolean; error?: string }
    /** A page of search results: rows to ADD to what this `id` has already answered, newest first. */
    | { type: "searchResult"; id: string; rows: ListedSession[]; more: boolean; error?: string }
    /** What the app keeps for the page that is NOT secret (store-bridge.ts): a read, a write or a removal by name. */
    | { type: "store"; id: string; op: "get" | "set" | "delete"; name: string; value?: string }
    /** The keyring's secrets, kept in the phone's keystore (vault-bridge.ts): a read, a write or a removal by name. */
    | { type: "vault"; id: string; op: "get" | "set" | "delete"; name: string; value?: string };

/** App → page. */
export type ToWeb =
    | { type: "theme"; theme: BridgeTheme }
    /** Open a session; `approval` also brings its pending approval on screen (the list's "needs you" rows). */
    | { type: "open"; key: string; approval?: boolean }
    | { type: "close" }
    | { type: "send"; id: string; key: string; text: string; images?: string[] }
    /** Start a session. An agent's `target` is where it runs: an open tab, or a new one (at `url`, or the runtime's start page). */
    | { type: "start"; id: string; runtime: string; kind: "chat" | "agent"; text: string; model?: string; images?: string[]; target?: { kind: "tab"; tabId: number } | { kind: "blank"; url?: string } }
    /** Pick a saved run back up on a page (`session.resume`): the same target as a new agent's, answered by `sent`. */
    | { type: "resumeRun"; id: string; key: string; target: { kind: "tab"; tabId: number } | { kind: "blank"; url?: string } }
    /** The runtime's open tabs, for an agent's target: answered by `tabsResult`. */
    | { type: "tabs"; id: string; runtime: string }
    | { type: "cancel"; key: string }
    | { type: "continue"; key: string }
    | { type: "answer"; key: string; seq: number; decision: boolean; persist?: boolean }
    | { type: "switchModel"; key: string; model: string }
    /** Pin or unpin a session on its runtime, rename it, or delete it: answered by `sent`, like `send`. */
    | { type: "pin"; id: string; key: string; on: boolean }
    | { type: "rename"; id: string; key: string; title: string }
    | { type: "delete"; id: string; key: string }
    /** What may be done with a session that is NOT open (a long press on its row): answered by `chromeOf`. */
    | { type: "chromeFor"; id: string; key: string }
    /** Capture the page the session's run is on, as it is now: the image arrives as `openImage`, the outcome as `sent`. */
    | { type: "peek"; id: string; key: string }
    | { type: "models"; runtime: string }
    | { type: "resume" }
    | { type: "pairing"; id: string; call: PairingCall; args?: Record<string, unknown> }
    /** The app's answer to a `store` request: `value` is what a `get` found, absent when there is nothing. */
    | { type: "storeResult"; id: string; ok: boolean; value?: string; error?: string }
    /** The keystore's answer to a `vault` request: `value` is what a `get` found, absent when there is nothing. */
    | { type: "vaultResult"; id: string; ok: boolean; value?: string; error?: string }
    /** Bring the approval the app's bar is about on screen: the card in the transcript is what answers it. */
    | { type: "showApproval" }
    /** Search history, on one runtime or on all of them; `more` asks for the next page of the search `id` already asked. */
    | { type: "search"; id: string; query: string; runtime?: string; more?: boolean };

type Shape = Record<string, "string" | "number" | "boolean" | "object" | "array" | "string?" | "number?" | "boolean?" | "object?" | "array?" | "object|null" | "array|null">;

/** The fields each message must carry, by type. What is not listed is not checked, and is passed through. */
const TO_NATIVE: Record<ToNative["type"], Shape> = {
    ready: { bundle: "string" },
    account: { account: "object|null" },
    status: { status: "object" },
    attention: { items: "array", count: "number" },
    index: { runtimes: "array", sessions: "array", startable: "object?" },
    session: { chrome: "object|null" },
    chromeOf: { id: "string", chrome: "object|null" },
    tabsResult: { id: "string", tabs: "array|null", groups: "array", withheld: "number", error: "string?" },
    models: { runtime: "string", models: "array|null", error: "string?" },
    sent: { id: "string", ok: "boolean", error: "string?", session: "string?" },
    notice: { text: "string", tone: "string" },
    saveFile: { name: "string", mime: "string", base64: "string" },
    openImage: { src: "string" },
    openLink: { url: "string" },
    copyText: { text: "string" },
    pairingInfo: { info: "object" },
    pairingResult: { id: "string", ok: "boolean", error: "string?" },
    pairingDone: { offer: "string", ok: "boolean", error: "string?" },
    searchResult: { id: "string", rows: "array", more: "boolean", error: "string?" },
    store: { id: "string", op: "string", name: "string", value: "string?" },
    vault: { id: "string", op: "string", name: "string", value: "string?" },
};
const TO_WEB: Record<ToWeb["type"], Shape> = {
    theme: { theme: "object" },
    open: { key: "string", approval: "boolean?" },
    close: {},
    send: { id: "string", key: "string", text: "string", images: "array?" },
    start: { id: "string", runtime: "string", kind: "string", text: "string", model: "string?", images: "array?", target: "object?" },
    tabs: { id: "string", runtime: "string" },
    resumeRun: { id: "string", key: "string", target: "object" },
    cancel: { key: "string" },
    continue: { key: "string" },
    answer: { key: "string", seq: "number", decision: "boolean", persist: "boolean?" },
    switchModel: { key: "string", model: "string" },
    pin: { id: "string", key: "string", on: "boolean" },
    rename: { id: "string", key: "string", title: "string" },
    delete: { id: "string", key: "string" },
    peek: { id: "string", key: "string" },
    chromeFor: { id: "string", key: "string" },
    models: { runtime: "string" },
    resume: {},
    pairing: { id: "string", call: "string", args: "object?" },
    storeResult: { id: "string", ok: "boolean", value: "string?", error: "string?" },
    vaultResult: { id: "string", ok: "boolean", value: "string?", error: "string?" },
    showApproval: {},
    search: { id: "string", query: "string", runtime: "string?", more: "boolean?" },
};

/** Does `v` have the kind a field spec asks for? */
function fits(v: unknown, spec: Shape[string]): boolean {
    const optional = spec.endsWith("?");
    if (v === undefined) return optional;
    const base = spec.replace("?", "");
    if (base === "object|null") return v === null || (typeof v === "object" && !Array.isArray(v));
    if (base === "array|null") return v === null || Array.isArray(v);
    if (base === "array") return Array.isArray(v);
    if (base === "object") return typeof v === "object" && v !== null && !Array.isArray(v);
    return typeof v === base;
}

/** Parse and check one raw message against a table: the message, or null for anything malformed or unknown. */
function parse<T extends { type: string }>(raw: unknown, table: Record<string, Shape>): T | null {
    let m: unknown = raw;
    if (typeof raw === "string") { try { m = JSON.parse(raw); } catch { return null; } }
    if (typeof m !== "object" || m === null) return null;
    const o = m as Record<string, unknown>;
    if (o.v !== BRIDGE_VERSION || typeof o.type !== "string" || !Object.hasOwn(table, o.type)) return null;
    const shape = table[o.type];
    for (const [k, spec] of Object.entries(shape)) if (!fits(o[k], spec)) return null;
    const { v: _v, ...msg } = o;
    return msg as T;
}

/** A page → app message, checked; null when it is malformed, unknown, or from another bridge version. */
export const parseToNative = (raw: unknown): ToNative | null => parse<ToNative>(raw, TO_NATIVE);
/** An app → page message, checked; null when it is malformed, unknown, or from another bridge version. */
export const parseToWeb = (raw: unknown): ToWeb | null => parse<ToWeb>(raw, TO_WEB);

/** A message as it crosses: JSON with the bridge version stamped on. */
export const encode = (msg: ToNative | ToWeb): string => JSON.stringify({ v: BRIDGE_VERSION, ...msg });
