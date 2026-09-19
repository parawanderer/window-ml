// The session index as it travels over a hub: the publisher's snapshot cadence, and the reader's refusal to present
// an incomplete list as a complete one. Pure — the hub itself is exercised in tests/hub-connection.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { IndexPublisher, IndexReader, SNAPSHOT_EVERY, decodeIndexFrame, encodeIndexFrame } from "../src/session-relay.ts";

const row = (hash, over = {}) => ({ id: { runtime: "rt", hash }, kind: "agent", status: "done", createdTs: 1, lastTs: 1, pendingApprovals: 0, saved: true, ...over });

/** A publisher whose frames are collected in order, the way a hub's ring would retain them. */
function publisher(every) {
    const frames = [];
    const p = new IndexPublisher("rt", async (counter, batch) => { frames.push({ counter, update: decodeIndexFrame(batch) }); }, every);
    return { p, frames };
}

test("the ring always holds a complete snapshot, however many updates go by", async () => {
    // The failure this prevents: a snapshot published once scrolls out of a 512-envelope ring, and a phone waking to
    // a sleeping laptop backfills upserts with nothing to apply them to.
    const RING = 512;
    const { p, frames } = publisher(SNAPSHOT_EVERY);
    await p.snapshot([row("aaaa0001")]);
    for (let i = 0; i < 2000; i++) await p.update({ type: "upsert", session: row(`b${String(i).padStart(7, "0")}`) });

    // Every window the size of the ring, anywhere in the stream, contains a snapshot.
    for (let end = RING; end <= frames.length; end += 37) {
        const window = frames.slice(end - RING, end);
        assert.ok(window.some((f) => f.update.type === "snapshot"), `a ring ending at frame ${end} holds a snapshot`);
    }
    assert.ok(SNAPSHOT_EVERY < RING, "and the cadence is under the ring with room to spare");
});

test("counters are strictly increasing, even when updates are fired without waiting", async () => {
    // A publish is asynchronous; a reader that sees counter 5 before 4 treats 4 as a replay.
    const { p, frames } = publisher(4);
    await Promise.all(Array.from({ length: 20 }, (_, i) => p.update({ type: "upsert", session: row(`c${String(i).padStart(7, "0")}`) })));
    const counters = frames.map((f) => f.counter);
    assert.deepEqual(counters, [...counters].sort((a, b) => a - b));
    assert.equal(new Set(counters).size, counters.length, "and never reused");
});

test("a re-published snapshot carries every row the publisher has said, including removals", async () => {
    const { p, frames } = publisher(3);
    await p.snapshot([row("aaaa0001"), row("aaaa0002")]);
    await p.update({ type: "upsert", session: row("aaaa0003") });
    await p.update({ type: "remove", id: { runtime: "rt", hash: "aaaa0001" } });
    await p.update({ type: "upsert", session: row("aaaa0002", { status: "running" }) });   // third update: a snapshot follows

    const last = frames.filter((f) => f.update.type === "snapshot").at(-1).update;
    const byHash = Object.fromEntries(last.sessions.map((s) => [s.id.hash, s.status]));
    assert.deepEqual(byHash, { aaaa0002: "running", aaaa0003: "done" }, "the removed row is gone, the changed one is current");
});

test("the reader does not present a list as complete until it has seen a snapshot", () => {
    // Upserts before the first snapshot are about to be replaced by it, so applying them changes nothing that
    // survives — but it would make a fragment look like the runtime's whole index in the meantime.
    const r = new IndexReader();
    assert.equal(r.complete, false);
    assert.deepEqual(r.read(encodeIndexFrame({ type: "upsert", session: row("aaaa0001") })), [], "dropped: nothing to apply it to");
    assert.equal(r.complete, false);

    const snap = { type: "snapshot", runtime: "rt", sessions: [row("aaaa0002")] };
    assert.deepEqual(r.read(encodeIndexFrame(snap)), [snap]);
    assert.equal(r.complete, true);

    const next = { type: "upsert", session: row("aaaa0003") };
    assert.deepEqual(r.read(encodeIndexFrame(next)), [next], "after a snapshot, changes apply");
});

test("a frame that opened but is not an index message is ignored, not thrown on", () => {
    // It verified, so the runtime sealed it — but a runtime is still another machine, and a broken one must not be
    // able to throw inside a page's reader.
    const r = new IndexReader();
    const junk = (s) => new TextEncoder().encode(s);
    for (const b of ["not json", "null", "{}", '{"type":"snapshot"}', '{"type":"upsert"}', '{"type":"nonsense","x":1}']) {
        assert.deepEqual(r.read(junk(b)), [], `ignored: ${b}`);
    }
    assert.equal(r.complete, false, "and none of them counts as a snapshot");
});
