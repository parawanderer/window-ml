// session-publisher.ts — the RUNTIME's side of one session's event stream over a hub: which devices are handed a
// session's key, when, and the frames themselves (window-ml-hub docs/PROTOCOL.md; the format is session-relay.ts).
//
// It is the half that decides who may WATCH, so it is written to be strict about it. A key goes only to a device
// whose verified leaf holds `view` (`grantees`), and each session has its own key, so a device holding one session's
// key cannot read another's even by naming its channel.
//
// Pure over its transport (`HubPublish`), so the decisions are tested without a hub and the wire is tested with one.
// No `chrome`: it runs in the worker, and nothing it decides depends on being a browser.
import { StreamKey, sealFrame, wrapKey, type ChannelKey, type Recipient, type Sender } from "./hub/seal";
import type { Bytes } from "./hub/hpke";
import type { SessionStreamMessage } from "./session-host";
import { encodeStreamFrame, eventsChannel, grantees, indexChannel, indexKeysChannel, keysChannel, type Grantee } from "./session-relay";

/** What the publisher needs from a hub connection: to publish a sealed payload on a channel. */
export interface HubPublish {
    /** publish on one of this runtime's channels; the kind is always session events for this stream */
    publish(channel: Bytes, payload: Bytes): void;
    /** who this runtime signs as */
    sender(): Sender;
}

/** A device the runtime can hand a key to: who it is, where a grant is sealed to, and what its leaf allows. */
export interface Device extends Grantee {
    recipient: Recipient;
}

/** One stream this runtime is publishing — a session, or the index: its own key, its channels, how far it has
 *  counted. The index and every session go through the SAME grant path, so there is one rule for who may read, not
 *  two that could drift. */
interface Published {
    key: StreamKey;
    events: Bytes;
    keys: Bytes;
    counter: number;
    /** devices already holding this session's key, so a second presence does not re-grant */
    granted: Set<string>;
}

/**
 * Publishes sessions' event streams and hands each session's key to the devices allowed to watch it.
 *
 * A key is handed out at the moment EITHER side is new: a session starts publishing (every allowed device present
 * gets one), or a device comes online (it gets one for every session already publishing). Each is published on the
 * session's RETAINED keys channel rather than sent directly, which is what lets a phone that wakes after the laptop
 * has gone to sleep still find its key in the ring.
 *
 * A grant covers the stream from its first counter, so a device that arrives mid-session reads the history the hub
 * still holds rather than only what comes after it.
 */
export class SessionPublisher {
    /** by stream id: `s:<hash>` for a session, `index` for the index */
    private readonly sessions = new Map<string, Published>();
    private readonly devices = new Map<string, Device>();
    /** one session's publishes go out in order, because a reader treats an earlier counter as a replay */
    private readonly queues = new Map<string, Promise<void>>();

    constructor(
        private readonly hub: HubPublish,
        private readonly channels: ChannelKey,
        /** this runtime's principal: the subject of its index channel */
        private readonly runtimePrincipal: Bytes,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * A device came online (or changed what its leaf allows). It receives the key of every session already
     * publishing — if its leaf holds `view`. A device that loses `view` is dropped from the set here, but a key
     * already handed over cannot be taken back: that is what rotation on revocation is for, and it is not this.
     */
    async deviceOnline(device: Device): Promise<void> {
        if (!grantees([device]).length) { this.devices.delete(device.id); return; }
        this.devices.set(device.id, device);
        for (const [id, s] of this.sessions) await this.enqueue(id, () => this.grant(s, device));
    }

    /** A device went away. Nothing to revoke — a grant it already holds stays readable — only nobody new to tell. */
    deviceOffline(id: string): void {
        this.devices.delete(id);
    }

    /** Publish one message of a session's stream, starting the stream (and handing out its key) on the first. */
    publish(hash: string, message: SessionStreamMessage): Promise<void> {
        const id = `s:${hash}`;
        return this.enqueue(id, async () => {
            const s = this.sessions.get(id) ?? (await this.start(id, () => eventsChannel(this.channels, hash), () => keysChannel(this.channels, hash)));
            const frame = await sealFrame(this.hub.sender(), s.events, s.key, ++s.counter, encodeStreamFrame(message));
            this.hub.publish(s.events, frame);
        });
    }

    /**
     * Publish one index frame, already encoded by `IndexPublisher`, which owns the index's snapshot cadence and hands
     * the batches over in order. This side seals and counts, the same as for a session, so the index's key goes out
     * by the same rule and on the same retained kind of channel.
     */
    publishIndex(batch: Bytes): Promise<void> {
        return this.enqueue("index", async () => {
            const s = this.sessions.get("index") ?? (await this.start("index", () => indexChannel(this.channels, this.runtimePrincipal), () => indexKeysChannel(this.channels, this.runtimePrincipal)));
            const frame = await sealFrame(this.hub.sender(), s.events, s.key, ++s.counter, batch);
            this.hub.publish(s.events, frame);
        });
    }

    /** A session this runtime has stopped publishing (deleted, or evicted): forget its key. */
    forget(hash: string): void {
        this.sessions.delete(`s:${hash}`);
        this.queues.delete(`s:${hash}`);
    }

    /** The first frame of a stream: a fresh key, its channels, and a grant to every device allowed to read it. */
    private async start(id: string, events: () => Promise<Bytes>, keys: () => Promise<Bytes>): Promise<Published> {
        const s: Published = { key: await StreamKey.generate(), events: await events(), keys: await keys(), counter: 0, granted: new Set() };
        this.sessions.set(id, s);
        for (const device of this.devices.values()) await this.grant(s, device);
        return s;
    }

    private async grant(s: Published, device: Device): Promise<void> {
        if (s.granted.has(device.id)) return;
        const wrapped = await wrapKey(this.hub.sender(), device.recipient, s.events, s.key, 1, this.now());
        this.hub.publish(s.keys, wrapped);
        s.granted.add(device.id);
    }

    private enqueue(hash: string, work: () => Promise<void>): Promise<void> {
        const next = (this.queues.get(hash) ?? Promise.resolve()).then(work, work);
        this.queues.set(hash, next);
        return next;
    }
}

/** A hub connection as `SessionPublisher` uses it: every stream it publishes is `KIND_SESSION_EVENTS`. */
export function hubPublish(client: { publish(channel: Bytes, kind: number, payload: Bytes): void; sender(): Sender }, sessionEventsKind: number): HubPublish {
    return {
        publish: (channel, payload) => client.publish(channel, sessionEventsKind, payload),
        sender: () => client.sender(),
    };
}
