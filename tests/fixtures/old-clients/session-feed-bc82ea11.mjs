// session-feed-bc82ea11.mjs — the chat page's SessionFeed as main shipped it at bc82ea11, before `files-changed` existed: an OLD client, for the upgrade test of a new stream message (tests/files-list-command.test.mjs). Generated with esbuild from `git show bc82ea11:src/chat/session-feed.ts`, its indent doubled to the 4-space grid; never edited otherwise.

import { SESSION_CONTRACT_VERSION } from "../../../src/session/session-host.ts";
class SessionFeed {
    constructor(session) {
        this.session = session;
    }
    session;
    epoch = null;
    /** Every cursor applied in the current epoch. A set rather than a high-water mark: delivery may REORDER around a
      *  reconnect, and a lower cursor arriving after a higher one is new, not a repeat. */
    applied = /* @__PURE__ */ new Set();
    maxCursor = -Infinity;
    /** The state worth keeping past this launch, or null before anything arrived. */
    snapshot() {
        return this.epoch == null ? null : { epoch: this.epoch, cursors: [...this.applied] };
    }
    /**
      * A feed that picks up where a saved one left off: the same epoch and the same applied cursors, so the runtime's
      * resume sends only what is new, and anything it re-sends is dropped as a duplicate. If the history changed while
      * the app was closed, the runtime answers with `reset`, and the rules above clear what was restored.
      */
    static restore(session, snap) {
        const f = new SessionFeed(session);
        f.epoch = snap.epoch;
        for (const c of snap.cursors) {
            f.applied.add(c);
            if (c > f.maxCursor) f.maxCursor = c;
        }
        return f;
    }
    /** The epoch this subscription is in, or null before anything arrived. A page of older events from another epoch
      *  belongs to a different history and must not be stitched onto this one. */
    get currentEpoch() {
        return this.epoch;
    }
    /** Where to resume from, or undefined before anything arrived. */
    get position() {
        return this.epoch != null && Number.isFinite(this.maxCursor) ? { epoch: this.epoch, cursor: this.maxCursor } : void 0;
    }
    /** Classify one message and update the state. */
    handle(msg) {
        if (msg.session.runtime !== this.session.runtime || msg.session.hash !== this.session.hash) return { type: "drop", reason: "other-session" };
        switch (msg.type) {
            case "event": {
                if (msg.v !== SESSION_CONTRACT_VERSION) return { type: "drop", reason: "version" };
                if (msg.event?.session?.hash !== this.session.hash) return { type: "drop", reason: "mislabelled" };
                if (this.epoch == null) this.epoch = msg.epoch;
                else if (msg.epoch !== this.epoch) return { type: "drop", reason: "stale-epoch" };
                if (this.applied.has(msg.cursor)) return { type: "drop", reason: "duplicate" };
                this.applied.add(msg.cursor);
                if (msg.cursor > this.maxCursor) this.maxCursor = msg.cursor;
                return { type: "apply", event: msg.event, ...Number.isInteger(msg.pos) && msg.pos >= 0 ? { pos: msg.pos } : {} };
            }
            case "reset":
                this.epoch = msg.epoch;
                this.applied.clear();
                this.maxCursor = -Infinity;
                return { type: "reset" };
            case "backfilled":
                if (msg.epoch !== this.epoch) {
                    this.epoch = msg.epoch;
                    this.applied.clear();
                    this.maxCursor = -Infinity;
                }
                return { type: "backfilled", truncated: msg.truncated, ...Number.isInteger(msg.from) && msg.from >= 0 ? { from: msg.from } : {} };
            case "gone":
                return { type: "gone" };
            default:
                return { type: "drop", reason: "version" };
        }
    }
}
export {
    SessionFeed
};
