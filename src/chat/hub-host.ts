// hub-host.ts — the SessionHost for runtimes reached through a hub: the same contract the local host implements, so the
// chat page and the phone app treat a laptop across the world exactly like this browser (docs/spec/CHAT_PAGE.md §Two
// sources, window-ml-hub docs/PROTOCOL.md §How the session contract maps onto it).
//
//   runtimes()  presence (identity, liveness, a verified label) + `runtime.info` (what a transport cannot know)
//   sessions()  each runtime's `sessions.index` stream, read with the key its keys channel hands this device
//   events()    one session's stream, rebuilt into the contract's order by `HubStreamAdapter`
//   send()      a sealed command, answered by its result
//
// NOTHING HERE TRUSTS THE HUB. A chain is verified before its label or key is used (`HubConnection`), a stream is read
// only with a key this device was sealed, and a grant for another device simply does not open.
//
// IT OUTLIVES ITS CONNECTION when built with an opener (`HubHost.reconnecting`). A phone that sleeps drops its socket
// every time, and a page that reloaded to recover threw away the open session, its scroll and the composer draft. So
// the host reopens the connection itself (backing off 1, 2, 5, 10, then 30 s; `reconnect()` skips the wait when the
// page knows the device just woke), moves every open subscription onto the new one, and resumes each session stream
// from the last position its reader saw. Runtimes known before the drop stay listed, offline, until presence says
// otherwise, so a list does not empty and refill on every blip.
//
// A runtime is listed once `runtime.info` has answered, because listing one with a guessed contract version would be
// inventing a fact about it. The cost: a runtime ASLEEP when this client connects is not listed until it wakes. The
// hub session's answer to that is a published description the ring keeps, which is the follow-up, not a guess here.
import type { ChannelKey } from "../hub/seal";
import type { Bytes } from "../hub/hpke";
import { StreamReader } from "../hub/seal";
import { Role } from "../hub/wire";
import type {
    Command, CommandResult, HostStatus, Principal, RuntimeCapabilities, RuntimeId, RuntimeInfo, SessionHost, SessionId,
    SessionIndexUpdate, SessionStreamMessage, StreamPosition, Unsubscribe,
} from "../session-host";
import { IndexReader, decodeStreamFrame, eventsChannel, indexChannel, indexKeysChannel, keysChannel } from "../session-relay";
import type { Position } from "../hub/wire";
import type { HubConnection, HubPeer, StreamEvent } from "./hub-connection";
import { HubStreamAdapter } from "./hub-stream";

/** What `runtime.info` said, plus the clock offset its round trip bounds. */
interface Described {
    kind: RuntimeInfo["kind"];
    contractVersion: number;
    capabilities: RuntimeCapabilities;
    clockOffsetMs: number;
}

const hexToBytes = (hex: string): Bytes => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16))) as Bytes;

/**
 * One stream read through a keys channel.
 *
 * ONE ORDERED QUEUE, and the reason is a bug the end-to-end test caught. The keys channel and the data channel are
 * separate subscriptions, so the ring's frames can arrive before this device's key has opened, and have to be held.
 * The hub's end-of-ring marker was passed straight through while they waited — so `backfilled` overtook the very
 * frames it was meant to close, and they then replayed as if they were live. Everything on the data channel now goes
 * through one queue, processed in arrival order with each open AWAITED, and nothing is processed until the key exists.
 */
class KeyedStream {
    private reader: StreamReader | null = null;
    private readonly queue: StreamEvent[] = [];
    private draining = false;
    private stops: (() => void)[] = [];
    /** the hub's position of the newest frame received, so a stream moved to a new connection resumes after it */
    private position: Position | undefined;

    constructor(
        private readonly publisher: Bytes,
        private readonly keys: Bytes,
        private readonly data: Bytes,
        private readonly onBatch: (batch: Bytes) => void,
        private readonly onRingDone: (truncated: boolean) => void,
        /** called before each connection's subscriptions, so the owner can start reading a fresh ring */
        private readonly onAttach?: () => void,
    ) {}

    /**
     * Subscribe on `conn`, dropping the previous connection's subscriptions. The keys channel is read from its start
     * (the grants on it are few, and a rotation may have added one); the data channel from after the last frame seen,
     * so a reconnect replays nothing already read. Frames still queued from the old connection are drained as usual.
     */
    attach(conn: HubConnection): void {
        this.unsubscribe();
        this.onAttach?.();
        // Every device's grant rides the same keys channel, and only the one sealed to THIS device opens. The others
        // are expected, so a refusal is silence rather than an error.
        this.stops.push(conn.subscribe(this.publisher, this.keys, (e) => {
            if (e.kind !== "published") return;
            void conn.openGrant(e.sender, e.payload).then(
                (grant) => {
                    if (this.reader) { this.reader.addKey(grant); return; }   // a rotation, a second grant, a reconnect
                    this.reader = new StreamReader(grant);
                    void this.drain();
                },
                () => { /* a grant for another device */ },
            );
        }));
        this.stops.push(conn.subscribe(this.publisher, this.data, (e: StreamEvent) => {
            if (e.kind === "published") this.position = { epoch: e.epoch, seq: e.seq };
            // Bounded, because a device never granted a key would otherwise hold a live stream's frames forever.
            // Past the bound the oldest go; they are the ones a truncated backfill would have lost anyway.
            if (this.queue.length >= MAX_HELD) this.queue.shift();
            this.queue.push(e);
            void this.drain();
        }, this.position));
    }

    /** Process what is queued, in order, once the key is here. A second call while one runs is a no-op: the running
     *  loop picks up whatever was pushed meanwhile. */
    private async drain(): Promise<void> {
        if (this.draining || !this.reader) return;
        this.draining = true;
        try {
            while (this.queue.length) {
                const e = this.queue.shift()!;
                if (e.kind === "published") await this.open(e.payload);
                else if (e.kind === "backfilled") this.onRingDone(e.truncated);
            }
        } finally {
            this.draining = false;
        }
    }

    private async open(payload: Uint8Array): Promise<void> {
        try { this.onBatch((await this.reader!.open(payload as Bytes)).batch); }
        catch { /* a frame under a key this device does not hold, or a replay: not ours to read */ }
    }

    private unsubscribe(): void {
        // A stop that threw would leave the rest subscribed and, inside `bind`, fail a connection that worked.
        for (const s of this.stops) { try { s(); } catch { /* the old connection is gone; so is its subscription */ } }
        this.stops = [];
    }

    stop(): void {
        this.unsubscribe();
    }
}

/** How many of a stream's frames are held while this device waits for its key. */
const MAX_HELD = 4096;

/** Reconnect backoff: quick for a blip, capped so a hub down for the night is retried twice a minute. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Something that follows the connection: re-subscribed on each new one. */
interface Follower { attach(conn: HubConnection): void }

/** A `SessionHost` over a hub connection: one given (it ends with that connection), or one it opens and reopens. */
export class HubHost implements SessionHost {
    private state: HostStatus;
    private readonly statusListeners = new Set<(s: HostStatus) => void>();
    private readonly runtimeListeners = new Set<(r: RuntimeInfo[]) => void>();
    private readonly peerListeners = new Set<(peers: HubPeer[]) => void>();
    private readonly followers = new Set<Follower>();
    private readonly described = new Map<string, Described>();
    private readonly asking = new Set<string>();
    private peers: HubPeer[] = [];
    /** what this device's own leaf grants, kept across a drop so an offline runtime still says what it may be asked */
    private scopes: readonly string[] = [];
    private conn: HubConnection | null = null;
    private openConn: (() => Promise<HubConnection>) | null = null;
    private attempt = 0;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private connecting = false;
    private closed = false;

    /** A host over one connection that is already open. When it closes, the host is offline for good. */
    constructor(
        conn: HubConnection | null,
        private readonly channels: ChannelKey,
        readonly self: Principal,
        private readonly now: () => number = Date.now,
    ) {
        this.state = conn ? { state: "online" } : { state: "connecting" };
        if (conn) this.bind(conn);
    }

    /**
     * A host that opens its connection with `open` and opens it again whenever it closes, keeping every subscription
     * the page holds. Status goes `connecting`, `online`, then `offline` (with `retryAt`) and back.
     */
    static reconnecting(open: () => Promise<HubConnection>, channels: ChannelKey, self: Principal, now: () => number = Date.now): HubHost {
        const host = new HubHost(null, channels, self, now);
        host.openConn = open;
        void host.connect();
        return host;
    }

    /** The connection in use, or null while there is none: what pairing sends over. */
    get connection(): HubConnection | null {
        return this.conn;
    }

    /**
     * Try now instead of waiting out the backoff: for a page that knows the device just woke or came back online
     * (`visibilitychange`, `online`). Does nothing while connected or connecting.
     */
    reconnect(): void {
        if (this.conn || this.closed || !this.openConn) return;
        void this.connect();
    }

    /** Stop for good: close the connection and never reopen it (leaving the account, a page going away). */
    close(): void {
        this.closed = true;
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        this.conn?.close();
        this.conn = null;
    }

    private async connect(): Promise<void> {
        if (this.connecting || this.closed || !this.openConn) return;
        this.connecting = true;
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        this.setStatus({ state: "connecting" });
        try {
            const conn = await this.openConn();
            if (this.closed) { conn.close(); return; }
            this.attempt = 0;
            this.bind(conn);
        } catch (e) {
            this.lost((e as Error)?.message || String(e));
        } finally {
            this.connecting = false;
        }
    }

    /** Offline; and, with an opener, the next attempt scheduled. */
    private lost(reason: string): void {
        if (this.closed) return;
        if (!this.openConn) { this.setStatus({ state: "offline", reason }); return; }
        const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
        this.attempt++;
        this.setStatus({ state: "offline", reason, retryAt: this.now() + wait });
        this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, wait);
    }

    /** Make `conn` the connection: follow its presence, move every subscription onto it, and hear when it ends. */
    private bind(conn: HubConnection): void {
        this.conn = conn;
        this.scopes = conn.ownScopes();
        conn.onPeers((peers) => {
            if (this.conn !== conn) return;
            // Runtimes known before a reconnect stay listed, offline, until this connection's presence names them:
            // a list that emptied and refilled on every blip would be a flicker of everything the page shows.
            const fresh = peers.filter((p) => p.role === Role.ROLE_RUNTIME);
            const named = new Set(fresh.map((p) => p.id));
            this.peers = [...fresh, ...this.peers.filter((p) => !named.has(p.id)).map((p) => ({ ...p, online: false }))];
            // Ask what each runtime is when it appears, and again when it reconnects: a runtime that restarted may have
            // been upgraded under us.
            for (const p of this.peers) if (p.online && !this.asking.has(p.id)) void this.describe(p.id);
            this.announceRuntimes();
            for (const l of this.peerListeners) l(this.peers);
        });
        for (const f of this.followers) { try { f.attach(conn); } catch { /* one stream cannot fail the connection */ } }
        conn.onClose((reason) => {
            if (this.conn !== conn) return;
            this.conn = null;
            this.peers = this.peers.map((p) => ({ ...p, online: false }));
            this.announceRuntimes();
            this.lost(reason);
        });
        this.setStatus({ state: "online" });
    }

    private setStatus(state: HostStatus): void {
        this.state = state;
        for (const l of this.statusListeners) l(state);
    }

    /** Follow the runtimes across connections: `listener` hears the list now and on every change. */
    private onPeers(listener: (peers: HubPeer[]) => void): () => void {
        this.peerListeners.add(listener);
        listener(this.peers);
        return () => this.peerListeners.delete(listener);
    }

    /** Keep `follower` subscribed on whichever connection is current, from now until the returned stop. */
    private follow(follower: Follower): () => void {
        this.followers.add(follower);
        if (this.conn) follower.attach(this.conn);
        return () => this.followers.delete(follower);
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
        queueMicrotask(() => { if (live) listener(this.runtimeList()); });
        return () => { live = false; this.runtimeListeners.delete(listener); };
    }

    sessions(listener: (update: SessionIndexUpdate) => void, opts?: { runtime?: RuntimeId }): Unsubscribe {
        const streams = new Map<string, KeyedStream>();
        const opening = new Set<string>();
        let live = true;
        const open = async (runtime: string): Promise<void> => {
            if (streams.has(runtime) || opening.has(runtime) || (opts?.runtime && opts.runtime !== runtime)) return;
            opening.add(runtime);
            const publisher = hexToBytes(runtime);
            const reader = new IndexReader();
            const s = new KeyedStream(
                publisher,
                await indexKeysChannel(this.channels, publisher),
                await indexChannel(this.channels, publisher),
                (batch) => { if (live) for (const u of reader.read(batch)) listener(u); },
                () => { /* the index has no resume position: a snapshot replaces what the client holds */ },
            );
            opening.delete(runtime);
            if (!live) return;
            streams.set(runtime, s);
            if (this.conn) s.attach(this.conn);
        };
        const unfollow = this.follow({ attach: (conn) => { for (const s of streams.values()) s.attach(conn); } });
        const unsubPeers = this.onPeers((peers) => { for (const p of peers) void open(p.id); });
        return () => {
            live = false;
            unsubPeers();
            unfollow();
            for (const s of streams.values()) s.stop();
        };
    }

    events(session: SessionId, listener: (message: SessionStreamMessage) => void, opts?: { since?: StreamPosition }): Unsubscribe {
        let live = true;
        let stream: KeyedStream | null = null;
        let unfollow = () => {};
        // Where the reader is, so a stream moved to a new connection resumes from there rather than from `since`.
        let at: StreamPosition | undefined = opts?.since;
        let adapter: HubStreamAdapter;
        const fresh = (): void => {
            adapter = new HubStreamAdapter(session, at, (m) => {
                if (!live) return;
                if (m.type === "event") at = { epoch: m.epoch, cursor: m.cursor };
                else if (m.type === "reset") at = undefined;
                else if (m.type === "backfilled") at = { epoch: m.epoch, cursor: m.cursor };
                listener(m);
            });
        };
        void (async () => {
            const publisher = hexToBytes(session.runtime);
            const s = new KeyedStream(
                publisher,
                await keysChannel(this.channels, session.hash),
                await eventsChannel(this.channels, session.hash),
                (batch) => { const m = decodeStreamFrame(batch); if (m) adapter.frame(m); },
                (truncated) => adapter.ringDone(truncated),
                // Each connection's ring is read by a new adapter from where the last one got to: it decides between
                // resuming and resetting exactly as a fresh subscription with `since` would.
                fresh,
            );
            if (!live) return;
            stream = s;
            unfollow = this.follow(s);
        })();
        return () => { live = false; unfollow(); stream?.stop(); };
    }

    send<C extends Command>(command: C, opts?: { signal?: AbortSignal }): Promise<CommandResult<C["type"]>> {
        if (!this.conn) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "not connected to the hub" } });
        return this.conn.send(command, opts);
    }

    /** Ask a runtime what it is. Bounded by one outstanding request per runtime, and retried on the next presence. */
    private async describe(id: string): Promise<void> {
        this.asking.add(id);
        try {
            const sent = this.now();
            const r = await this.send({ type: "runtime.info", runtime: id });
            const back = this.now();
            if (!r.ok) return;
            // The runtime's clock at roughly the midpoint of the round trip; the round trip is the error bound.
            const clockOffsetMs = Math.round(r.data.nowMs - (sent + back) / 2);
            this.described.set(id, { kind: r.data.kind, contractVersion: r.data.contractVersion, capabilities: r.data.capabilities, clockOffsetMs });
            this.announceRuntimes();
        } finally {
            this.asking.delete(id);
        }
    }

    private runtimeList(): RuntimeInfo[] {
        const grants = this.scopes.map((scope) => ({ scope: scope as RuntimeInfo["grants"][number]["scope"] }));
        const out: RuntimeInfo[] = [];
        for (const p of this.peers) {
            const d = this.described.get(p.id);
            if (!d) continue;   // not listed until it has said what it is
            out.push({
                id: p.id, name: p.name, kind: d.kind, online: p.online, lastSeen: p.lastSeen,
                contractVersion: d.contractVersion, capabilities: d.capabilities, grants, clockOffsetMs: d.clockOffsetMs,
            });
        }
        return out;
    }

    private announceRuntimes(): void {
        const list = this.runtimeList();
        for (const l of this.runtimeListeners) l(list);
    }
}
