// The stream order a client is promised, rebuilt from what a hub delivers: the ring, the hub's end-of-ring marker, then
// live frames. These are the rules a client trusts most, so they are tested here without a hub in the way.
import test from "node:test";
import assert from "node:assert/strict";
import { HubStreamAdapter } from "../src/chat/hub-stream.ts";

const S = { runtime: "rt", hash: "aaaa0001" };
const ev = (cursor, epoch = "w1.0") => ({ type: "event", v: 1, session: S, epoch, cursor, event: { kind: "agent-say", id: "x", text: String(cursor) } });

function adapter(since) {
    const out = [];
    const a = new HubStreamAdapter(S, since, (m) => out.push(m));
    const shape = () => out.map((m) => (m.type === "event" ? m.cursor : m.type === "backfilled" ? `backfilled${m.truncated ? "!" : ""}` : m.type));
    return { a, out, shape };
}

test("a fresh subscription: reset, the ring in order, backfilled, then live", () => {
    const { a, shape } = adapter();
    for (const c of [2, 1, 3]) a.frame(ev(c));   // the ring may not arrive in order
    a.ringDone(false);
    a.frame(ev(4));
    assert.deepEqual(shape(), ["reset", 1, 2, 3, "backfilled", 4]);
});

test("a resume in the same epoch sends only what the client lacks, and no reset", () => {
    // The whole point of carrying the contract's cursor inside each frame: the client's position survives the hub.
    const { a, shape } = adapter({ epoch: "w1.0", cursor: 2 });
    for (const c of [1, 2, 3, 4]) a.frame(ev(c));
    a.ringDone(false);
    assert.deepEqual(shape(), [3, 4, "backfilled"]);
});

test("a resume the ring can no longer reach is a restart, and the client is told it lost something", () => {
    // The ring starts at 10 but the client stopped at 2: 3..9 are gone from the hub. Pretending to resume would join
    // two histories that do not touch.
    const { a, shape } = adapter({ epoch: "w1.0", cursor: 2 });
    for (const c of [10, 11]) a.frame(ev(c));
    a.ringDone(true);
    assert.deepEqual(shape(), ["reset", 10, 11, "backfilled!"]);
});

test("a resume across a runtime restart (a new epoch) is a restart, whatever the cursors say", () => {
    // Cursor 5 under a new epoch is a different event from cursor 5 under the old one.
    const { a, shape } = adapter({ epoch: "w1.0", cursor: 5 });
    for (const c of [1, 2]) a.frame(ev(c, "w2.0"));
    a.ringDone(false);
    assert.deepEqual(shape(), ["reset", 1, 2, "backfilled!"]);
});

test("a frame both the ring and the live feed carry is sent once", () => {
    // Subscribing replays the ring while live publishing continues, so the seam can repeat a frame.
    const { a, shape } = adapter();
    a.frame(ev(1)); a.frame(ev(2));
    a.ringDone(false);
    a.frame(ev(2)); a.frame(ev(3)); a.frame(ev(3));
    assert.deepEqual(shape(), ["reset", 1, 2, "backfilled", 3]);
});

test("the runtime restarting while a client watches is a reset mid-stream, not a jumble of cursors", () => {
    const { a, out, shape } = adapter();
    a.frame(ev(7)); a.ringDone(false);
    a.frame(ev(1, "w2.0")); a.frame(ev(2, "w2.0"));
    assert.deepEqual(shape(), ["reset", 7, "backfilled", "reset", 1, 2]);
    assert.equal(out.filter((m) => m.type === "reset").at(-1).epoch, "w2.0");
});

test("an empty ring still ends with backfilled, so a client knows the backfill is over", () => {
    const { a, shape } = adapter();
    a.ringDone(false);
    assert.deepEqual(shape(), ["backfilled"]);
});

test("a deleted session ends the stream, and frames that are not events are ignored", () => {
    const { a, shape } = adapter();
    a.frame({ type: "reset", session: S, epoch: "w1.0" });   // a runtime has no business publishing these
    a.frame(ev(1));
    a.ringDone(false);
    a.frame({ type: "gone", session: S });
    assert.deepEqual(shape(), ["reset", 1, "backfilled", "gone"]);
});

test("a short ring whose events carry positions is not a loss: backfilled says where paging back starts", () => {
    // The hub kept events 40..42 of a session whose first 40 the runtime still has. Truncated would tell the client
    // they are gone; `from` tells it to ask the runtime.
    const { a, out } = adapter();
    for (const [c, pos] of [[41, 40], [42, 41], [43, 42]]) a.frame({ ...ev(c), pos });
    a.ringDone(true);
    assert.deepEqual(out.at(-1), { type: "backfilled", session: S, epoch: "w1.0", cursor: 43, truncated: false, from: 40 });

    // Unstamped frames (an older runtime) keep today's answer: truncated, and no position to page from.
    const old = adapter();
    old.a.frame(ev(41));
    old.a.ringDone(true);
    assert.equal(old.out.at(-1).truncated, true);
    assert.equal("from" in old.out.at(-1), false);
});

test("an empty ring ended by the runtime's own answer: backfilled with where the history ends, then live", () => {
    const { a, out, shape } = adapter();
    assert.equal(a.empty, true);
    a.ringFromRuntime({ epoch: "w1.0", from: 5, truncated: false });
    a.frame(ev(6));
    assert.deepEqual(shape(), ["backfilled", 6]);
    assert.equal(out[0].from, 5);
    assert.equal(out[0].epoch, "w1.0");
    a.ringDone(false);   // the hub's own marker, late: already live, so nothing
    a.ringFromRuntime({ epoch: "w1.0", from: 9, truncated: false });
    assert.deepEqual(shape(), ["backfilled", 6]);
});

test("a runtime that holds nothing for the session says so: truncated only when there is nothing to page", () => {
    const none = adapter();
    none.a.ringFromRuntime({ epoch: "e", from: 0, truncated: true });
    assert.deepEqual(none.shape(), ["backfilled!"]);
    const some = adapter();
    some.a.frame(ev(1));
    assert.equal(some.a.empty, false, "a ring that held an event is not empty");
});
