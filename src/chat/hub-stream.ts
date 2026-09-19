// hub-stream.ts — turn what a hub delivers for one session (its ring, a `backfilled` marker, then live frames) into the
// stream the session contract promises a client: `reset` when needed, the backfill, `backfilled`, then live events.
//
// Pure, so the ordering rules are tested without a hub — they are the part most likely to be wrong and the part a
// client trusts most. The local host gets this order from `SessionServer`, which decides between resuming and
// resetting by the contract's rules. Over a hub there is no such server: the runtime publishes plain `event`s into a
// ring and the hub replays that ring, so the order has to be REBUILT here.
//
// TWO POSITIONS, ON PURPOSE (window-ml-hub docs/PROTOCOL.md). The hub's `epoch`/`seq` resume within what the HUB kept;
// the contract's `epoch`/`cursor` are the runtime's, travel inside each sealed frame, and survive the hub entirely. A
// client's `since` is the contract's, so it is compared against the frames' own cursors and never handed to the hub,
// where it would name a position in a different sequence.
import type { SessionId, SessionStreamMessage, StreamPosition } from "../session-host";

type Event = Extract<SessionStreamMessage, { type: "event" }>;

/**
 * One session's stream, as a client should see it. Feed it opened frames (`frame`) and the hub's end-of-ring marker
 * (`ringDone`); it calls `emit` with the contract's messages, in the contract's order.
 */
export class HubStreamAdapter {
    private readonly ring: Event[] = [];
    private live = false;
    /** the newest cursor emitted, so a frame the ring and the live feed both carry is sent once */
    private last = -1;
    private epoch: string | null = null;

    constructor(
        private readonly session: SessionId,
        private readonly since: StreamPosition | undefined,
        private readonly emit: (m: SessionStreamMessage) => void,
    ) {
        if (since) this.last = since.cursor;
    }

    /** One opened frame, from the ring or live. Only `event`s carry a session's history; anything else is ignored. */
    frame(m: SessionStreamMessage): void {
        if (m.type === "gone") { this.emit({ type: "gone", session: this.session }); return; }
        if (m.type !== "event") return;
        if (!this.live) { this.ring.push(m); return; }
        // Live. A new epoch means the runtime rebuilt its history under us: the client's cursors mean nothing now.
        if (this.epoch !== null && m.epoch !== this.epoch) {
            this.epoch = m.epoch;
            this.last = -1;
            this.emit({ type: "reset", session: this.session, epoch: m.epoch });
        }
        this.epoch ??= m.epoch;
        if (m.cursor <= this.last) return;   // already sent from the ring
        this.last = m.cursor;
        this.emit(m);
    }

    /**
     * The hub has sent everything it retained. `truncated` is the HUB's: its ring no longer reaches the start of the
     * stream. Decide here whether the client can resume or must start again, and say which.
     */
    ringDone(hubTruncated: boolean): void {
        if (this.live) return;
        this.live = true;
        const ring = this.ring.sort((a, b) => a.cursor - b.cursor);
        const epoch = ring.at(-1)?.epoch ?? this.since?.epoch ?? null;
        this.epoch = epoch;

        // RESUME: same epoch, and the ring still reaches back to where the client stopped (or nothing was lost at all).
        // Anything else is a restart from what the ring holds — and the client is told whether the start is missing.
        const reaches = !!this.since && !!ring.length && ring[0].cursor <= this.since.cursor + 1;
        const resume = !!this.since && epoch === this.since.epoch && (reaches || !hubTruncated);
        if (resume) {
            for (const e of ring) if (e.cursor > this.last) { this.last = e.cursor; this.emit(e); }
            this.emit({ type: "backfilled", session: this.session, epoch: epoch ?? this.since!.epoch, cursor: Math.max(this.last, this.since!.cursor), truncated: false });
            return;
        }
        if (epoch !== null) this.emit({ type: "reset", session: this.session, epoch });
        this.last = -1;
        for (const e of ring) { this.last = e.cursor; this.emit(e); }
        // Where the ring starts in the SESSION, when the runtime stamped it. Then a short ring is not a loss: the
        // client pages back with `session.backfill { before: from }`, and the runtime, which is the one that knows,
        // answers whether anything older still exists. `truncated` here would say "gone from the runtime" on the
        // strength of what the HUB kept, which is a different fact.
        const first = ring[0]?.pos;
        if (typeof first === "number" && Number.isInteger(first) && first >= 0) {
            this.emit({ type: "backfilled", session: this.session, epoch: epoch ?? "", cursor: Math.max(this.last, 0), truncated: false, from: first });
            return;
        }
        // No position: truncated when the hub says its ring does not reach the start — or when a client that asked to
        // resume could not be resumed, since then what it held and what it is now shown do not join up.
        this.emit({ type: "backfilled", session: this.session, epoch: epoch ?? "", cursor: Math.max(this.last, 0), truncated: hubTruncated || !!this.since });
    }
}
