// ONE SESSION SUBSCRIPTION'S STREAM RULES, as a pure state machine: what a client does with each message a
// `SessionHost.events()` subscription delivers (docs/spec/SESSION_CONTRACT.md). No UI and no signals, so the rules are
// tested on their own and every host (local, hub, fake) is held to the same ones.
//
// The rules, in the order they are checked:
// - a message about another session is dropped (a host routing bug must not write into the wrong record);
// - an event whose envelope speaks an unknown MAJOR version is dropped, never half-understood;
// - an event whose payload names another session hash than its envelope is dropped, so no runtime can write into
//   another session's record by mislabelling it;
// - an event from an epoch other than the current one is stale (it predates a `reset`) and is dropped;
// - an event already applied (same epoch and cursor) is dropped: delivery may repeat around a reconnect;
// - `reset` adopts the new epoch and tells the caller to clear what it holds, since a backfill follows;
// - `backfilled` with `truncated` and no `reset` means the runtime lost older history: keep what is shown, and adopt
//   its epoch if it is a new one, or every live event after it would be dropped as stale;
// - `gone` ends the subscription.
import { SESSION_CONTRACT_VERSION, type SessionId, type SessionStreamMessage, type StreamPosition } from "../session-host";
import type { MlDebugEvent } from "../contract-debug";

/** What the caller does with one stream message. */
export type FeedAction =
    | { type: "apply"; event: MlDebugEvent; pos?: number }
    | { type: "reset" }
    | { type: "backfilled"; truncated: boolean; from?: number }
    | { type: "gone" }
    | { type: "drop"; reason: "other-session" | "version" | "mislabelled" | "stale-epoch" | "duplicate" };

/** The stream state of one session subscription: its epoch and which cursors it has applied. Kept across
 *  re-subscriptions, so a reopened session resumes from {@link SessionFeed.position} instead of from nothing. */
export class SessionFeed {
    private epoch: string | null = null;
    /** Every cursor applied in the current epoch. A set rather than a high-water mark: delivery may REORDER around a
     *  reconnect, and a lower cursor arriving after a higher one is new, not a repeat. */
    private applied = new Set<number>();
    private maxCursor = -Infinity;

    constructor(readonly session: SessionId) {}

    /** The epoch this subscription is in, or null before anything arrived. A page of older events from another epoch
     *  belongs to a different history and must not be stitched onto this one. */
    get currentEpoch(): string | null {
        return this.epoch;
    }

    /** Where to resume from, or undefined before anything arrived. */
    get position(): StreamPosition | undefined {
        return this.epoch != null && Number.isFinite(this.maxCursor) ? { epoch: this.epoch, cursor: this.maxCursor } : undefined;
    }

    /** Classify one message and update the state. */
    handle(msg: SessionStreamMessage): FeedAction {
        if (msg.session.runtime !== this.session.runtime || msg.session.hash !== this.session.hash) return { type: "drop", reason: "other-session" };
        switch (msg.type) {
            case "event": {
                if (msg.v !== SESSION_CONTRACT_VERSION) return { type: "drop", reason: "version" };
                if (msg.event?.session?.hash !== this.session.hash) return { type: "drop", reason: "mislabelled" };
                // No epoch yet: a fresh subscription with nothing to replace starts straight with events.
                if (this.epoch == null) this.epoch = msg.epoch;
                else if (msg.epoch !== this.epoch) return { type: "drop", reason: "stale-epoch" };
                if (this.applied.has(msg.cursor)) return { type: "drop", reason: "duplicate" };
                this.applied.add(msg.cursor);
                if (msg.cursor > this.maxCursor) this.maxCursor = msg.cursor;
                return { type: "apply", event: msg.event, ...(Number.isInteger(msg.pos) && msg.pos! >= 0 ? { pos: msg.pos } : {}) };
            }
            case "reset":
                this.epoch = msg.epoch;
                this.applied.clear();
                this.maxCursor = -Infinity;
                return { type: "reset" };
            case "backfilled":
                // A new epoch with no `reset` before it: the runtime rebuilt the session without the history to
                // replace ours (an ephemeral session after a restart). What is shown stays; the cursors we applied
                // meant something only under the old epoch, and the live events that follow carry the new one.
                if (msg.epoch !== this.epoch) {
                    this.epoch = msg.epoch;
                    this.applied.clear();
                    this.maxCursor = -Infinity;
                }
                return { type: "backfilled", truncated: msg.truncated, ...(Number.isInteger(msg.from) && msg.from! >= 0 ? { from: msg.from } : {}) };
            case "gone":
                return { type: "gone" };
            default:
                // A message type from a newer contract: ignored, like any unknown kind.
                return { type: "drop", reason: "version" };
        }
    }
}
