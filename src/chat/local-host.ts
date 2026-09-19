// THIS BROWSER AS A SESSION HOST: the chat page's client for the background's `ml-sessions` port
// (src/session-server.ts). It turns the port's messages into the `SessionHost` contract, so the page treats local
// sessions exactly like a hub runtime's.
//
// No `chrome.*` here: the extension entry passes `connect` (a `chrome.runtime.connect` on SESSIONS_PORT), and the tests
// pass an in-memory port wired to a real `SessionServer`.
//
// The service worker can be evicted at any time, which disconnects the port. The host then reports `offline`, answers
// every in-flight command with `unavailable`, reconnects with backoff, and re-subscribes: the index again (a fresh
// snapshot replaces what the page holds), and every open session subscription from the last position it delivered, so
// the background decides between resuming and resetting by the contract's own rules.
import type { Command, CommandResult, HostStatus, Principal, RuntimeId, RuntimeInfo, SessionHost, SessionId, SessionIndexUpdate, SessionStreamMessage, StreamPosition, Unsubscribe } from "../session-host";
import type { PortLike, SessionsClientMessage, SessionsServerMessage } from "../session-server";

/** Reconnect delays in ms; the last repeats. */
const RETRY_MS = [250, 1000, 3000, 10_000];

/**
 * How long a dropped port may take to come back before the page is told this browser is offline. The browser stops an
 * idle worker about every 30 seconds and the port is back in a quarter of a second; saying "offline" for that moment
 * redrew everything keyed on it (the start page, the composer, Settings → Runtimes, which lost its scroll position),
 * which read as the page reloading on its own. Commands in flight still fail at once: only what is SHOWN waits.
 */
export const OFFLINE_GRACE_MS = 3000;

interface Subscription {
    session: SessionId;
    listener: (message: SessionStreamMessage) => void;
    /** the newest position delivered, to resume from after a reconnect */
    position?: StreamPosition;
}

interface Pending {
    resolve: (result: CommandResult<any>) => void;
    cleanup: () => void;
}

/** A `SessionHost` over this extension's background worker. */
export class LocalHost implements SessionHost {
    readonly self: Principal = { id: "local", kind: "local", name: "This browser" };
    private port: PortLike | null = null;
    private state: HostStatus = { state: "connecting" };
    private runtime: RuntimeInfo | null = null;
    private statusListeners = new Set<(s: HostStatus) => void>();
    private runtimeListeners = new Set<(r: RuntimeInfo[]) => void>();
    private indexListeners = new Set<(u: SessionIndexUpdate) => void>();
    /** the index as last reported, so a late listener starts from a snapshot without another round trip */
    private index: Map<string, SessionIndexUpdate & { type: "upsert" }> | null = null;
    private subs = new Map<number, Subscription>();
    private pending = new Map<number, Pending>();
    private nextId = 1;
    private attempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private offlineTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(
        private readonly connectPort: () => PortLike,
        private readonly timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
    ) {
        this.open();
    }

    /** Close the port and stop reconnecting. */
    dispose(): void {
        this.disposed = true;
        if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
        if (this.offlineTimer) this.timers.clearTimeout(this.offlineTimer);
        const port = this.port;
        this.port = null;
        try { port?.disconnect(); } catch { /* already gone */ }
        this.failPending("the page closed its connection");
    }

    private open(): void {
        if (this.disposed) return;
        let port: PortLike;
        try {
            port = this.connectPort();
        } catch (err) {
            this.lost((err as Error)?.message || "could not reach the extension");
            return;
        }
        this.port = port;
        port.onMessage.addListener((msg: SessionsServerMessage) => { if (this.port === port) this.onMessage(msg); });
        port.onDisconnect.addListener(() => { if (this.port === port) { this.port = null; this.lost("the extension's worker restarted"); } });
        if (this.indexListeners.size) this.post({ type: "sessions" });
        for (const [sub, s] of this.subs) this.post({ type: "events", sub, hash: s.session.hash, ...(s.position ? { since: s.position } : {}) });
    }

    private lost(reason: string): void {
        this.failPending(reason);
        if (this.disposed) return;
        const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
        this.attempt++;
        // Said only if it is still down after the grace (a `runtime` message on reconnect cancels it); once said, each
        // further failed attempt updates when the next one is.
        const say = (): void => {
            this.offlineTimer = null;
            if (this.runtime?.online) {
                this.runtime = { ...this.runtime, online: false };
                this.emitRuntimes();
            }
            this.setStatus({ state: "offline", reason, retryAt: Date.now() + delay });
        };
        if (this.state.state === "offline") say();
        else if (!this.offlineTimer) this.offlineTimer = this.timers.setTimeout(say, OFFLINE_GRACE_MS);
        this.retryTimer = this.timers.setTimeout(() => { this.retryTimer = null; this.open(); }, delay);
    }

    private failPending(message: string): void {
        for (const [id, p] of this.pending) {
            this.pending.delete(id);
            p.cleanup();
            p.resolve({ ok: false, error: { code: "unavailable", message } });
        }
    }

    private post(message: SessionsClientMessage): boolean {
        if (!this.port) return false;
        try { this.port.postMessage(message); return true; } catch { return false; }
    }

    private onMessage(msg: SessionsServerMessage): void {
        if (!msg || typeof msg !== "object") return;
        switch (msg.type) {
            case "runtime":
                this.attempt = 0;
                if (this.offlineTimer) { this.timers.clearTimeout(this.offlineTimer); this.offlineTimer = null; }
                this.runtime = msg.runtime;
                this.setStatus({ state: "online" });
                this.emitRuntimes();
                return;
            case "index":
                this.applyIndex(msg.update);
                for (const l of this.indexListeners) l(msg.update);
                return;
            case "stream": {
                const s = this.subs.get(msg.sub);
                if (!s) return;
                s.position = advance(s.position, msg.message);
                s.listener(msg.message);
                return;
            }
            case "result": {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                p.cleanup();
                p.resolve(msg.result);
                return;
            }
        }
    }

    private applyIndex(u: SessionIndexUpdate): void {
        if (u.type === "snapshot") {
            this.index = new Map(u.sessions.map((session) => [session.id.hash, { type: "upsert", session }]));
        } else if (this.index) {
            if (u.type === "upsert") this.index.set(u.session.id.hash, u);
            else if (u.type === "remove") this.index.delete(u.id.hash);
        }
    }

    private setStatus(s: HostStatus): void {
        this.state = s;
        for (const l of this.statusListeners) l(s);
    }

    private emitRuntimes(): void {
        const list = this.runtime ? [this.runtime] : [];
        for (const l of this.runtimeListeners) l(list);
    }

    status(listener: (status: HostStatus) => void): Unsubscribe {
        this.statusListeners.add(listener);
        let live = true;
        queueMicrotask(() => { if (live) listener(this.state); });
        return () => { live = false; this.statusListeners.delete(listener); };
    }

    runtimes(listener: (runtimes: RuntimeInfo[]) => void): Unsubscribe {
        this.runtimeListeners.add(listener);
        let live = true;
        queueMicrotask(() => { if (live && this.runtime) listener([this.runtime]); });
        return () => { live = false; this.runtimeListeners.delete(listener); };
    }

    sessions(listener: (update: SessionIndexUpdate) => void, opts?: { runtime?: RuntimeId }): Unsubscribe {
        const filtered = (u: SessionIndexUpdate): void => {
            if (!opts?.runtime) return listener(u);
            const rt = u.type === "snapshot" ? u.runtime : u.type === "upsert" ? u.session.id.runtime : u.id.runtime;
            if (rt === opts.runtime) listener(u);
        };
        const first = !this.indexListeners.size;
        let live = true;
        // A later listener starts from what is already held; the first asks the background.
        if (!first && this.index && this.runtime) {
            const snapshot: SessionIndexUpdate = { type: "snapshot", runtime: this.runtime.id, sessions: [...this.index.values()].map((u) => u.session) };
            queueMicrotask(() => { if (live) filtered(snapshot); });
        }
        this.indexListeners.add(filtered);
        if (first) this.post({ type: "sessions" });
        return () => { live = false; this.indexListeners.delete(filtered); };
    }

    events(session: SessionId, listener: (message: SessionStreamMessage) => void, opts?: { since?: StreamPosition }): Unsubscribe {
        const sub = this.nextId++;
        this.subs.set(sub, { session, listener, position: opts?.since });
        this.post({ type: "events", sub, hash: session.hash, ...(opts?.since ? { since: opts.since } : {}) });
        return () => {
            if (!this.subs.delete(sub)) return;
            this.post({ type: "unsub", sub });
        };
    }

    send<C extends Command>(command: C, opts?: { signal?: AbortSignal }): Promise<CommandResult<C["type"]>> {
        if (opts?.signal?.aborted) return Promise.resolve({ ok: false, error: { code: "aborted", message: "cancelled before it was sent" } });
        const id = this.nextId++;
        return new Promise((resolve) => {
            const onAbort = (): void => {
                if (!this.pending.delete(id)) return;
                resolve({ ok: false, error: { code: "aborted", message: "cancelled; it may still have been delivered" } });
            };
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            this.pending.set(id, { resolve, cleanup: () => opts?.signal?.removeEventListener("abort", onAbort) });
            if (!this.post({ type: "cmd", id, command })) {
                this.pending.delete(id);
                opts?.signal?.removeEventListener("abort", onAbort);
                resolve({ ok: false, error: { code: "unavailable", message: "not connected to the extension's worker" } });
            }
        });
    }
}

/** The position to resume a subscription from after one more message. */
function advance(pos: StreamPosition | undefined, m: SessionStreamMessage): StreamPosition | undefined {
    switch (m.type) {
        case "event":
            return { epoch: m.epoch, cursor: pos?.epoch === m.epoch ? Math.max(pos.cursor, m.cursor) : m.cursor };
        case "reset":
            return { epoch: m.epoch, cursor: 0 };
        case "backfilled":
            return { epoch: m.epoch, cursor: pos?.epoch === m.epoch ? Math.max(pos.cursor, m.cursor) : m.cursor };
        default:
            return pos;
    }
}
