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

// --- one session's event stream ---

const { eventsChannel, keysChannel, encodeStreamFrame, decodeStreamFrame, grantees } = await import("../src/session-relay.ts");
const { ChannelKey } = await import("../src/hub/seal.ts");

test("a session's channels hide its hash, and are distinct per session and per purpose", async () => {
    const ck = await ChannelKey.generate();
    const a = await eventsChannel(ck, "aaaa0001");
    const b = await eventsChannel(ck, "aaaa0002");
    const ka = await keysChannel(ck, "aaaa0001");
    const hex = (x) => [...x].map((v) => v.toString(16).padStart(2, "0")).join("");

    assert.equal(a.length, 16);
    assert.notEqual(hex(a), hex(b), "two sessions, two channels");
    assert.notEqual(hex(a), hex(ka), "a session's keys ride beside its events, not on them");
    // The whole point of the HMAC: the hub routes by this and must never see the hash, which is also in `#s=`, on
    // disk and in a box's request hints — a hash-named channel would be a join key between them.
    assert.ok(!hex(a).includes(hex(new TextEncoder().encode("aaaa0001"))));
    // And it is a pure function of the key and the session, so every device that holds the key names the same one.
    assert.equal(hex(await eventsChannel(ck, "aaaa0001")), hex(a));
});

test("a stream message crosses with the contract's own epoch and cursor inside", () => {
    const ev = { type: "event", v: 1, session: { runtime: "rt", hash: "aaaa0001" }, epoch: "w1.0", cursor: 7, event: { kind: "agent", id: "aaaa0001" } };
    assert.deepEqual(decodeStreamFrame(encodeStreamFrame(ev)), ev);
    for (const m of [
        { type: "reset", session: { runtime: "rt", hash: "a" }, epoch: "w1.0" },
        { type: "backfilled", session: { runtime: "rt", hash: "a" }, epoch: "w1.0", cursor: 3, truncated: false },
        { type: "gone", session: { runtime: "rt", hash: "a" } },
    ]) assert.deepEqual(decodeStreamFrame(encodeStreamFrame(m)), m, m.type);
});

test("a frame that opened but is not a stream message is ignored, not thrown on", () => {
    const junk = (s) => new TextEncoder().encode(s);
    for (const b of ["nope", "null", "{}", '{"type":"event"}', '{"type":"event","session":{},"epoch":"e"}', '{"type":"reset","session":{}}', '{"type":"x","session":{}}']) {
        assert.equal(decodeStreamFrame(junk(b)), null, `ignored: ${b}`);
    }
});

test("only a device whose verified leaf holds `view` is handed a session's key", () => {
    // A key is not a command: a device holding one reads the stream by subscribing, with nothing further asked. So the
    // check the runtime makes before answering a command has to be made here too.
    const who = grantees([
        { id: "phone", scopes: ["view", "drive"] },
        { id: "watcher", scopes: ["view"] },
        { id: "driver-only", scopes: ["drive"] },
        { id: "box", scopes: [] },
    ]).map((d) => d.id);
    assert.deepEqual(who, ["phone", "watcher"]);
});
