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
    private readonly stops: (() => void)[] = [];

    constructor(
        conn: HubConnection,
        publisher: Bytes,
        keys: Bytes,
        data: Bytes,
        private readonly onBatch: (batch: Bytes) => void,
        private readonly onRingDone: (truncated: boolean) => void,
    ) {
        // Every device's grant rides the same keys channel, and only the one sealed to THIS device opens. The others
        // are expected, so a refusal is silence rather than an error.
        this.stops.push(conn.subscribe(publisher, keys, (e) => {
            if (e.kind !== "published") return;
            void conn.openGrant(e.sender, e.payload).then(
                (grant) => {
                    if (this.reader) { this.reader.addKey(grant); return; }   // a rotation, or a second grant
                    this.reader = new StreamReader(grant);
                    void this.drain();
                },
                () => { /* a grant for another device */ },
            );
        }));
        this.stops.push(conn.subscribe(publisher, data, (e: StreamEvent) => {
            // Bounded, because a device never granted a key would otherwise hold a live stream's frames forever.
            // Past the bound the oldest go; they are the ones a truncated backfill would have lost anyway.
            if (this.queue.length >= MAX_HELD) this.queue.shift();
            this.queue.push(e);
            void this.drain();
        }));
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

    stop(): void {
        for (const s of this.stops) s();
    }
}

/** How many of a stream's frames are held while this device waits for its key. */
const MAX_HELD = 4096;

/** A `SessionHost` over one hub connection. */
export class HubHost implements SessionHost {
    private state: HostStatus = { state: "online" };
    private readonly statusListeners = new Set<(s: HostStatus) => void>();
    private readonly runtimeListeners = new Set<(r: RuntimeInfo[]) => void>();
    private readonly described = new Map<string, Described>();
    private readonly asking = new Set<string>();
    private peers: HubPeer[] = [];

    constructor(
        private readonly conn: HubConnection,
        private readonly channels: ChannelKey,
        readonly self: Principal,
        private readonly now: () => number = Date.now,
    ) {
        conn.onPeers((peers) => {
            this.peers = peers.filter((p) => p.role === Role.ROLE_RUNTIME);
            // Ask what each runtime is when it appears, and again when it reconnects: a runtime that restarted may have
            // been upgraded under us.
            for (const p of this.peers) if (p.online && !this.asking.has(p.id)) void this.describe(p.id);
            this.announceRuntimes();
        });
        conn.onClose((reason) => {
            this.state = { state: "offline", reason };
            for (const l of this.statusListeners) l(this.state);
        });
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
        let live = true;
        const open = async (runtime: string): Promise<void> => {
            if (streams.has(runtime) || (opts?.runtime && opts.runtime !== runtime)) return;
            const publisher = hexToBytes(runtime);
            const reader = new IndexReader();
            streams.set(runtime, new KeyedStream(
                this.conn, publisher,
                await indexKeysChannel(this.channels, publisher),
                await indexChannel(this.channels, publisher),
                (batch) => { if (live) for (const u of reader.read(batch)) listener(u); },
                () => { /* the index has no resume position: a snapshot replaces what the client holds */ },
            ));
        };
        for (const p of this.peers) void open(p.id);
        const unsubPeers = this.conn.onPeers((peers) => {
            for (const p of peers) if (p.role === Role.ROLE_RUNTIME) void open(p.id);
        });
        return () => {
            live = false;
            unsubPeers();
            for (const s of streams.values()) s.stop();
        };
    }

    events(session: SessionId, listener: (message: SessionStreamMessage) => void, opts?: { since?: StreamPosition }): Unsubscribe {
        let live = true;
        let stream: KeyedStream | null = null;
        const adapter = new HubStreamAdapter(session, opts?.since, (m) => { if (live) listener(m); });
        void (async () => {
            const publisher = hexToBytes(session.runtime);
            const s = new KeyedStream(
                this.conn, publisher,
                await keysChannel(this.channels, session.hash),
                await eventsChannel(this.channels, session.hash),
                (batch) => { const m = decodeStreamFrame(batch); if (m) adapter.frame(m); },
                (truncated) => adapter.ringDone(truncated),
            );
            if (live) stream = s; else s.stop();
        })();
        return () => { live = false; stream?.stop(); };
    }

    send<C extends Command>(command: C, opts?: { signal?: AbortSignal }): Promise<CommandResult<C["type"]>> {
        return this.conn.send(command, opts);
    }

    /** Ask a runtime what it is. Bounded by one outstanding request per runtime, and retried on the next presence. */
    private async describe(id: string): Promise<void> {
        this.asking.add(id);
        try {
            const sent = this.now();
            const r = await this.conn.send({ type: "runtime.info", runtime: id });
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
        const grants = this.conn.ownScopes().map((scope) => ({ scope: scope as RuntimeInfo["grants"][number]["scope"] }));
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
