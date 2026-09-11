// The frame reader's arithmetic — specifically the `dropped` counter, which is the one field on the stream
// whose meaning is not the value it carries.
//
// A subscriber that falls behind loses frames, and the server says so. Nothing read it, so the panel drew a
// continuous line across frames that never arrived — the exact claim `segments()` refuses to make about a
// sampling gap, made silently about a worse one: frames are dropped when the box is busiest, so the
// interpolation lands on the movement the chart exists to show.
import test from "node:test";
import assert from "node:assert/strict";
import { lostSince, parseFrame, readFrames } from "../src/resource-events.ts";

const f = (kind, dropped) => ({ kind, t: 0, ...(dropped === undefined ? {} : { dropped }) });

test("lostSince: the news is the DELTA, not the value", () => {
    // The counter is CUMULATIVE. A connection that dropped three frames once reports 3 on every frame after,
    // so reading the value would break the trace at every subsequent sample — a chart in permanent pieces
    // after one hiccup, which teaches the reader to ignore breaks.
    let seen = 0;
    let r = lostSince(seen, f("sample", 0));
    assert.equal(r.lost, 0);
    seen = r.seen;

    r = lostSince(seen, f("sample", 3));
    assert.equal(r.lost, 3, "three frames went missing between the last one and this one");
    seen = r.seen;

    r = lostSince(seen, f("sample", 3));
    assert.equal(r.lost, 0, "the SAME count is not a second loss");
    seen = r.seen;

    r = lostSince(seen, f("sample", 5));
    assert.equal(r.lost, 2, "only what is new");
});

test("lostSince: a hello resets, because the counter is PER SUBSCRIBER", () => {
    // A reconnect starts a new count from zero. Read as a delta that would be -7, and clamping it to 0 gets
    // the right answer for the wrong reason: what matters is that the NEXT frame on the new connection must
    // be measured from 0 and not from the old connection's high-water mark, or the first genuine drop after
    // a reconnect is silently swallowed.
    const r = lostSince(7, { kind: "hello", t: 0, dropped: 0 });
    assert.equal(r.lost, 0, "the reconnect itself is not a loss — the backfill covers that seam");
    assert.equal(r.seen, 0, "and the count restarts, so the next drop is visible");

    // Proof of the second half: a drop right after a reconnect is reported.
    assert.equal(lostSince(r.seen, f("sample", 2)).lost, 2);
});

test("lostSince: a counter going backwards claims nothing", () => {
    // A server restart we did not see. We cannot know how many frames that cost, and a number invented here
    // would be drawn as a hole in a specific place. Resetting says only what is true: measure from here.
    const r = lostSince(9, f("sample", 1));
    assert.equal(r.lost, 0);
    assert.equal(r.seen, 1);
});

test("lostSince: an absent counter is not zero", () => {
    // A build that does not report `dropped` must not read as "nothing was ever lost" AND must not reset the
    // count we already have — the field being missing is a fact about the server, not about the record.
    const r = lostSince(4, f("sample", undefined));
    assert.equal(r.lost, 0);
    assert.equal(r.seen, 4, "the high-water mark survives a frame that does not carry it");
    // A garbage value is treated the same way rather than coerced into a delta.
    assert.equal(lostSince(4, f("sample", -1)).seen, 4);
    assert.equal(lostSince(4, { kind: "sample", t: 0, dropped: "lots" }).seen, 4);
});

test("readFrames: a frame split across two reads survives, and `dropped` with it", () => {
    // Worth pinning together: the delta arithmetic is only correct if every frame is read exactly once, and
    // the reader is what guarantees that on a slow link.
    const line = JSON.stringify({ kind: "sample", t: 5, dropped: 2 });
    const a = readFrames("", line.slice(0, 12));
    assert.deepEqual(a.frames, [], "half a frame is not a frame");
    const b = readFrames(a.rest, line.slice(12) + "\n");
    assert.equal(b.frames.length, 1);
    assert.equal(b.frames[0].dropped, 2);
    assert.equal(parseFrame("{ not json"), null, "an unreadable line is skipped, never allowed to abandon the stream");
});
