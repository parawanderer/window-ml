// The session index as it travels over a hub: the publisher's snapshot cadence, and the reader's refusal to present
// an incomplete list as a complete one. Pure — the hub itself is exercised in tests/hub-connection.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { IndexPublisher, IndexReader, SNAPSHOT_EVERY, decodeIndexFrame, encodeIndexFrame } from "../src/hub/runtime/session-relay.ts";

const row = (hash, over = {}) => ({ id: { runtime: "rt", hash }, kind: "agent", status: "done", createdTs: 1, lastTs: 1, pendingApprovals: 0, saved: true, ...over });

/** A publisher whose frames are collected in order, the way a hub's ring would retain them. */
function publisher(every) {
    const frames = [];
    let n = 0;
    const p = new IndexPublisher("rt", async (batch) => { frames.push({ order: ++n, update: decodeIndexFrame(batch) }); }, every);
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

test("batches go out in the order they were made, even when updates are fired without waiting", async () => {
    // A publish is asynchronous, and whatever seals these counts them in the order they arrive — so arriving out of
    // order would number a later snapshot below an earlier upsert, and a reader treats the earlier one as a replay.
    const { p, frames } = publisher(4);
    const names = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(7, "0")}`);
    await Promise.all(names.map((h) => p.update({ type: "upsert", session: row(h) })));
    const upserted = frames.filter((f) => f.update.type === "upsert").map((f) => f.update.session.id.hash);
    assert.deepEqual(upserted, names, "in the order they were asked for");
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

const { eventsChannel, keysChannel, encodeStreamFrame, decodeStreamFrame, grantees } = await import("../src/hub/runtime/session-relay.ts");
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

// --- what a live preview costs over a hub ---

const { LivePreview, LIVE_PREVIEW_CHARS, LIVE_PREVIEW_MS } = await import("../src/hub/runtime/session-relay.ts");

const S = { runtime: "rt", hash: "aaaa0001" };
/** One `agent-stream` as the stream message that carries it, with `n` characters of accumulated reasoning. */
const preview = (n, cursor = 1, key = "reasoning") => ({
    type: "event", v: 1, session: S, epoch: "w1.0", cursor,
    event: { kind: "agent-stream", id: S.hash, session: { hash: S.hash, turn: 0 }, step: 0, [key]: "x".repeat(n) },
});
const step = (cursor) => ({ type: "event", v: 1, session: S, epoch: "w1.0", cursor, event: { kind: "agent-step", id: S.hash, seq: 1 } });

test("a remote preview carries a bounded TAIL, however long the turn gets", () => {
    const p = new LivePreview({ now: () => 0, everyMs: 0 });
    const small = p.forWire(S.hash, preview(10));
    assert.equal(small.event.reasoning, "x".repeat(10), "under the cap, untouched");
    assert.equal(small.event.elided, undefined);

    // The shape this exists for: the accumulated text passes the cap and keeps growing, and the frame does not.
    const sizes = [LIVE_PREVIEW_CHARS * 2, LIVE_PREVIEW_CHARS * 20, LIVE_PREVIEW_CHARS * 200].map((n) => {
        const out = p.forWire(S.hash, preview(n));
        assert.equal(out.event.elided, n - LIVE_PREVIEW_CHARS, "how much was left off");
        assert.ok(out.event.reasoning.startsWith("… "), "marked as a tail in its own text, for every surface at once");
        return JSON.stringify(out).length;
    });
    assert.ok(sizes[2] - sizes[0] < 100, `frames stay the same size: ${sizes.join(", ")}`);
});

test("each channel is cut on its own, so a long think does not mark a short answer", () => {
    const p = new LivePreview({ now: () => 0, everyMs: 0 });
    const m = { ...preview(LIVE_PREVIEW_CHARS * 2), event: { ...preview(LIVE_PREVIEW_CHARS * 2).event, content: "the answer" } };
    const out = p.forWire(S.hash, m);
    assert.ok(out.event.reasoning.startsWith("… "));
    assert.equal(out.event.content, "the answer", "under the cap, and not marked as something it is not");
    assert.equal(out.event.elided, LIVE_PREVIEW_CHARS);
});

test("previews are paced per session, and nothing else is paced at all", () => {
    let now = 0;
    const p = new LivePreview({ now: () => now });
    assert.ok(p.forWire(S.hash, preview(10, 1)), "the first one goes");
    now += LIVE_PREVIEW_MS - 1;
    assert.equal(p.forWire(S.hash, preview(20, 2)), null, "the next one inside the window does not");
    // A dropped preview leaves a cursor HOLE, which the contract allows: positions are strictly increasing, not
    // contiguous. What must never be dropped is anything a reader needs whole.
    assert.ok(p.forWire(S.hash, step(3)), "a step is not a preview");
    assert.ok(p.forWire(S.hash, { type: "reset", session: S, epoch: "w1.0" }), "nor is the subscription protocol");
    now += 1;
    const after = p.forWire(S.hash, preview(30, 4));
    assert.ok(after, "once the window is over, the newest text goes");
    assert.equal(after.event.reasoning.length, 30, "and it is the newest, not the one that was held");

    // Another session is another pace: two runs streaming at once must not starve each other.
    assert.ok(p.forWire("bbbb0002", { ...preview(10, 5), session: { runtime: "rt", hash: "bbbb0002" } }));
});

// --- live TOOL output over a hub: paced, with a trailing send, and a discard never held ---

/** One live tool-output delta (the loop's fan): an `agent-step` with `streamOutput` and no `tool`. */
const out = (text, cursor, seq = 1) => ({ type: "event", v: 1, session: S, epoch: "w1.0", cursor, event: { kind: "agent-step", id: S.hash, step: 0, seq, streamOutput: text, streamMarks: [] } });
/** The step's own result, which supersedes its live output. */
const done = (cursor, seq = 1) => ({ type: "event", v: 1, session: S, epoch: "w1.0", cursor, event: { kind: "agent-step", id: S.hash, step: 0, seq, tool: "exec", result: "ok" } });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
/** A preview whose trailing sends are recorded, paced at `everyMs` of real time. */
function paced(everyMs = 40) {
    const flushed = [];
    const p = new LivePreview({ everyMs, flush: (hash, m) => flushed.push(m.cursor) });
    return { p, flushed };
}

test("a tool's live output is paced like a model preview: 60 s of 90 ms deltas is one frame per window, not 667", () => {
    let now = 0;
    const p = new LivePreview({ now: () => now });
    let sent = 0;
    for (let i = 0; i < 667; i++, now += 90) if (p.forWire(S.hash, out("x".repeat(12000), i + 1))) sent++;
    assert.ok(sent <= Math.ceil(667 * 90 / LIVE_PREVIEW_MS) + 1, `${sent} frames`);
    assert.ok(sent >= 60, `and still live: ${sent} frames`);
});

test("a tool that prints a line and then goes quiet still gets that line out: the held delta is sent when its window ends", async () => {
    const { p, flushed } = paced();
    assert.ok(p.forWire(S.hash, out("a\n", 1)), "the first line goes at once");
    assert.equal(p.forWire(S.hash, out("a\nb\n", 2)), null, "the next, inside the window, is held");
    assert.equal(p.forWire(S.hash, out("a\nb\nc\n", 3)), null);
    await tick(80);
    assert.deepEqual(flushed, [3], "the NEWEST held delta went out once the window was over, and only it");
});

test("held output goes out before the next message of its session, in order; the step's own result drops it instead", async () => {
    const { p, flushed } = paced();
    p.forWire(S.hash, out("a\n", 1));
    p.forWire(S.hash, out("a\nb\n", 2));
    const say = { type: "event", v: 1, session: S, epoch: "w1.0", cursor: 3, event: { kind: "agent-say", id: S.hash } };
    assert.ok(p.forWire(S.hash, say));
    assert.deepEqual(flushed, [2], "flushed BEFORE the message that followed it returned, so it is published first");

    p.forWire(S.hash, out("a\nb\nc\n", 4));   // inside the window again: held
    assert.ok(p.forWire(S.hash, done(5)), "the result goes");
    await tick(80);
    assert.deepEqual(flushed, [2], "and the output it supersedes never does");
    assert.ok(p.forWire(S.hash, out("next step\n", 6, 2)), "the next step's first line goes at once");
});

test("a DISCARD is never paced or held: a remote reader must not keep a refused try's lines while the run waits", async () => {
    const { p, flushed } = paced();
    p.forWire(S.hash, out("before the click\n", 1));
    p.forWire(S.hash, out("before the click\nmore\n", 2));   // held
    const discard = p.forWire(S.hash, out("", 3));
    assert.ok(discard, "the discard goes at once, inside the window");
    assert.equal(discard.event.streamOutput, "");
    await tick(80);
    assert.deepEqual(flushed, [], "and the try's held lines are dropped, not sent after it");
    assert.ok(p.forWire(S.hash, out("approved run\n", 4)), "the approved run's first line goes at once");
});

test("closing drops held output: nothing is sent for a connection that is gone", async () => {
    const { p, flushed } = paced();
    p.forWire(S.hash, out("a\n", 1));
    p.forWire(S.hash, out("a\nb\n", 2));
    p.close();
    await tick(80);
    assert.deepEqual(flushed, []);
});
