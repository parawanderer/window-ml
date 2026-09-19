// session-relay.ts — the session contract's two SUBSCRIPTIONS carried over a hub: the index, and one session's event
// stream. What a runtime publishes, and how a client reads it back into the same messages the local host produces
// (docs/spec/SESSION_CONTRACT.md, window-ml-hub docs/PROTOCOL.md §How the session contract maps onto it).
//
// Both halves live here because they are one format, and a format written twice drifts. The runtime side publishes;
// the client side reads. Neither touches `chrome`, since the reader runs in the chat page and the phone app.
//
// THE RING IS THE CONSTRAINT THAT SHAPES THIS. The index rides `KIND_SESSION_EVENTS`, which a hub retains in a ring
// (512 envelopes) and never coalesces. A snapshot published once at startup scrolls out after 512 updates, and a
// phone that wakes to a sleeping laptop then backfills a run of upserts with nothing to apply them to — a list that
// looks complete and is not. So the PUBLISHER re-publishes a whole snapshot every `SNAPSHOT_EVERY` updates, which
// keeps one inside the ring at all times, and the READER's single job is to know whether it has seen one yet.
import type { SessionIndexUpdate, SessionStreamMessage, SessionSummary } from "./session-host";
import type { ChannelKey } from "./hub/seal";
import type { Bytes } from "./hub/hpke";

/**
 * How many index updates may go by before the whole index is published again.
 *
 * Under the ring's 512 so a complete snapshot is always retained, with room to spare: the ring is shared with nothing
 * on this channel, but a hub may trim it for BYTES across the account (`account_ring_bytes`) before it trims it for
 * count. Lower also bounds how much a subscriber replays after the snapshot it starts from.
 */
export const SNAPSHOT_EVERY = 256;

/** The channel a runtime's index travels on: named by purpose and the runtime's own principal, under the account's
 *  channel key. The subject is the principal even though a subscribe already names the publisher, because a name
 *  shared by every runtime would group an account's principals by what they publish, and an empty subject is the one
 *  path through this derivation no vector exercises — two implementations would disagree there silently. */
export function indexChannel(channels: ChannelKey, runtimePrincipal: Bytes): Promise<Bytes> {
    return channels.channel("sessions.index", runtimePrincipal);
}

/** The retained channel carrying the index's key, one wrapped grant per device, beside `indexChannel`. Without it a
 *  device could subscribe to a runtime's session list and never be able to read it. */
export function indexKeysChannel(channels: ChannelKey, runtimePrincipal: Bytes): Promise<Bytes> {
    return channels.channel("sessions.index.keys", runtimePrincipal);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One index message as the bytes that get sealed. JSON, because it is the contract's own shape and a second
 *  encoding of it would be a second thing to keep in step. */
export const encodeIndexFrame = (u: SessionIndexUpdate): Bytes => encoder.encode(JSON.stringify(u)) as Bytes;

/**
 * An index message from its opened bytes, or null when it is not one.
 *
 * UNTRUSTED even though it verified: a frame that opens was sealed by the runtime, which is not the hub but is still
 * another machine, and a malformed frame is a runtime that is broken rather than a reason to throw inside a reader.
 */
export function decodeIndexFrame(batch: Bytes): SessionIndexUpdate | null {
    let v: unknown;
    try { v = JSON.parse(decoder.decode(batch)); } catch { return null; }
    const u = v as { type?: unknown; runtime?: unknown; sessions?: unknown; session?: unknown; id?: unknown };
    if (u?.type === "snapshot" && typeof u.runtime === "string" && Array.isArray(u.sessions)) return v as SessionIndexUpdate;
    if (u?.type === "upsert" && u.session && typeof u.session === "object") return v as SessionIndexUpdate;
    if (u?.type === "remove" && u.id && typeof u.id === "object") return v as SessionIndexUpdate;
    return null;
}

/**
 * The runtime's side: turn index changes into frames, re-publishing the whole index often enough that the ring
 * always holds a complete one.
 *
 * Pure over `send`, which seals and publishes one frame. It keeps the current rows itself so that a snapshot can be
 * produced at any point without asking the index again, and so that what it publishes is exactly what it has said.
 *
 * It hands over BATCHES, in order, and does not count them: the frame counter belongs to whatever seals the frame
 * (`SessionPublisher`), and two counters for one stream is how, one day, they disagree.
 */
export class IndexPublisher {
    private readonly rows = new Map<string, SessionSummary>();
    private sinceSnapshot = 0;
    /** A publish is asynchronous and a reader treats an earlier frame as a replay, so they go out one at a time. */
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private readonly runtime: string,
        private readonly send: (batch: Bytes) => Promise<void>,
        private readonly snapshotEvery: number = SNAPSHOT_EVERY,
    ) {}

    /** Publish the whole index. Called at startup, and on a cadence by `update`. */
    snapshot(rows?: SessionSummary[]): Promise<void> {
        if (rows) { this.rows.clear(); for (const r of rows) this.rows.set(r.id.hash, r); }
        this.sinceSnapshot = 0;
        return this.emit({ type: "snapshot", runtime: this.runtime, sessions: [...this.rows.values()] });
    }

    /** One change. A snapshot follows it when enough have gone by, so the ring never holds only fragments. */
    async update(u: SessionIndexUpdate): Promise<void> {
        if (u.type === "snapshot") return this.snapshot(u.sessions);
        if (u.type === "upsert") this.rows.set(u.session.id.hash, u.session);
        else this.rows.delete(u.id.hash);
        await this.emit(u);
        if (++this.sinceSnapshot >= this.snapshotEvery) await this.snapshot();
    }

    private emit(u: SessionIndexUpdate): Promise<void> {
        const batch = encodeIndexFrame(u);
        this.queue = this.queue.then(() => this.send(batch));
        return this.queue;
    }
}

/**
 * The client's side: read opened frames back into index updates.
 *
 * A `snapshot` REPLACES everything held for the runtime, so an upsert that arrives before the first snapshot is about
 * to be overwritten and applying it changes nothing that survives — but it would make an incomplete list look
 * complete in the meantime. So those are dropped, and `complete` says whether this reader has seen a snapshot at all.
 * A list that has not is one the UI must not present as the runtime's whole index.
 */
export class IndexReader {
    private seen = false;

    /** Has a complete index arrived? False until the first snapshot, whatever else has been read. */
    get complete(): boolean {
        return this.seen;
    }

    /** One opened frame, as the updates a client should apply: none, or the one it carried. */
    read(batch: Bytes): SessionIndexUpdate[] {
        const u = decodeIndexFrame(batch);
        if (!u) return [];
        if (u.type === "snapshot") { this.seen = true; return [u]; }
        return this.seen ? [u] : [];
    }
}

/* ------------------------------ one session's event stream ------------------------------ */

// Following the hub's own pattern: a session's frames on one channel, and the keys to read them on a retained sibling.
// The keys channel is what lets a phone that wakes to a sleeping laptop still read its key out of the ring — a key
// handed over by command would need the runtime online to answer.
//
// ONE KEY PER SESSION. A grant binds one channel anyway, so a per-session key costs exactly the grants a shared key
// would. And a shared key would make the channel binding no boundary at all: a device holding the key from one
// session's grant can name another session's channel itself (it has the channel key from pairing), build its AAD and
// decrypt it. The AEAD binds a frame to its channel against a hub moving frames about; it does not stop a KEY HOLDER
// who knows the channel. So only a per-session key lets a grant that covers some sessions keep the others unreadable.

/** The channel one session's events travel on. The subject is the session hash, which the HMAC hides: the hub sees a
 *  name and never the hash, which would otherwise be a join key against the same hash in a box's request hints. */
export function eventsChannel(channels: ChannelKey, hash: string): Promise<Bytes> {
    return channels.channel("events", encoder.encode(hash) as Bytes);
}

/** The retained channel carrying one wrapped key per device, each FOR `eventsChannel` of the same session. */
export function keysChannel(channels: ChannelKey, hash: string): Promise<Bytes> {
    return channels.channel("keys", encoder.encode(hash) as Bytes);
}

/** One stream message as the bytes that get sealed. The contract's own `epoch`/`cursor` travel INSIDE, which is the
 *  point: the hub's own position resumes within what the hub retained, and this one survives the hub entirely. */
export const encodeStreamFrame = (m: SessionStreamMessage): Bytes => encoder.encode(JSON.stringify(m)) as Bytes;

/** A stream message from its opened bytes, or null. Untrusted for the same reason an index frame is. */
export function decodeStreamFrame(batch: Bytes): SessionStreamMessage | null {
    let v: unknown;
    try { v = JSON.parse(decoder.decode(batch)); } catch { return null; }
    const m = v as { type?: unknown; session?: unknown; epoch?: unknown; cursor?: unknown; event?: unknown };
    if (!m || typeof m !== "object" || !m.session || typeof m.session !== "object") return null;
    if (m.type === "event") return typeof m.epoch === "string" && typeof m.cursor === "number" && !!m.event ? (v as SessionStreamMessage) : null;
    if (m.type === "reset") return typeof m.epoch === "string" ? (v as SessionStreamMessage) : null;
    if (m.type === "backfilled") return typeof m.epoch === "string" && typeof m.cursor === "number" ? (v as SessionStreamMessage) : null;
    if (m.type === "gone") return v as SessionStreamMessage;
    return null;
}

/** A device the runtime can see, as far as deciding whether to hand it a session's key is concerned. */
export interface Grantee {
    /** principal id, hex */
    id: string;
    /** the scopes its VERIFIED leaf holds */
    scopes: readonly string[];
}

/**
 * Which devices receive a session's key.
 *
 * Only one whose verified leaf holds `view`. That is the same check the runtime makes before answering a command, and
 * it has to be made HERE as well, because a key is not a command: a device handed one can read the stream by
 * subscribing, with no further question asked. So a device without `view` never receives a key, and cannot watch a
 * session even by naming its channel.
 *
 * There is no per-session filter yet, and not by oversight. The contract's `Grant.sessions` has nothing behind it on
 * the wire — a certificate carries `scopes` and no session restriction — so every device is effectively `"all"`. When
 * a certificate can carry one, this is the one place that has to learn it, and per-session keys are what will make
 * that restriction hold against a key holder rather than only at the command layer.
 */
export function grantees(devices: readonly Grantee[]): Grantee[] {
    return devices.filter((d) => d.scopes.includes("view"));
}
