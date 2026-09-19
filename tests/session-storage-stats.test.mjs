// Where the saved-session store's bytes go (src/session-storage-stats.ts): the split has to add up to what the store's
// budget counts, and an image inside a tool result is an image, not tool output.
import test from "node:test";
import assert from "node:assert/strict";
import { measureEvents, summarizeStore } from "../src/session-storage-stats.ts";

const img = (n, c = "A") => "data:image/png;base64," + c.repeat(n);
const step = (over) => ({ kind: "agent-step", id: "h", ts: 1, session: { hash: "h", turn: 0 }, step: 1, seq: 1, tool: "exec", ...over });

test("images, tool output and the rest add up to the serialized size", () => {
    const events = [
        { kind: "agent", id: "h", ts: 1, session: { hash: "h", turn: 0 }, task: "look", images: [img(1000)] },
        step({ result: "x".repeat(500) }),
        step({ result: { kind: "image", dataUrl: img(2000, "B") }, arguments: { js: "y".repeat(100) } }),
    ];
    const m = measureEvents(events);
    assert.equal(m.total, events.reduce((n, e) => n + JSON.stringify(e).length, 0));
    assert.equal(m.images, img(1000).length + img(2000, "B").length, "an image inside a tool result counts as an image");
    assert.equal(m.imageCount, 2);
    assert.equal(m.toolOutput, 500 + "image".length);
    assert.equal(m.total, m.images + m.toolOutput + m.other);
});

test("the dedupe estimate counts each distinct image once, across sessions", () => {
    const seen = new Map();
    const a = measureEvents([step({ result: img(3000) }), step({ result: img(3000) })], seen);
    const b = measureEvents([step({ result: img(3000) }), step({ result: img(500, "C") })], seen);
    const s = summarizeStore([{ hash: "a", events: 2, ...a }, { hash: "b", title: "B", events: 2, ...b }], seen);
    assert.equal(s.images, 3 * img(3000).length + img(500, "C").length);
    assert.equal(s.imagesIfDeduplicated, img(3000).length + img(500, "C").length);
    assert.equal(s.sessions, 2);
    assert.deepEqual(s.top.map((r) => r.hash), ["a", "b"], "biggest first");
});

import { addBytes, appendSnapshot, emptyBytes, HISTORY_MAX, snapshotRows, topTools } from "../src/session-storage-stats.ts";

test("tool output is split by the tool that produced it, and adding keeps the split", () => {
    const a = measureEvents([step({ tool: "exec", result: "x".repeat(100) }), step({ tool: "python_exec", result: "y".repeat(40) })]);
    assert.deepEqual(a.byTool, { exec: 100, python_exec: 40 });
    const b = addBytes(a, measureEvents([step({ tool: "exec", result: "z".repeat(10) })]));
    assert.deepEqual(b.byTool, { exec: 110, python_exec: 40 });
    assert.equal(b.toolOutput, 150);
});

test("a snapshot sums rows, and a row with no breakdown counts as unmeasured", () => {
    const split = measureEvents([step({ tool: "exec", result: "x".repeat(100) })]);
    const snap = snapshotRows([
        { bytes: split.total, count: 1, split, summary: { pinned: true } },
        { bytes: 5000, count: 9, summary: {} },
    ], 42);
    assert.equal(snap.total, split.total + 5000);
    assert.equal(snap.unmeasured, 5000);
    assert.equal(snap.images + snap.toolOutput + snap.other + snap.unmeasured, snap.total, "the parts stack to the whole");
    assert.equal(snap.pinned, 1);
    assert.equal(snap.events, 10);
    assert.equal(snap.t, 42);
});

test("the history takes one snapshot a day and keeps a year", () => {
    const at = (t) => ({ ...emptyBytes(), t, sessions: 0, events: 0, pinned: 0, unmeasured: 0 });
    assert.equal(appendSnapshot([at(0)], at(1000), 5000), null, "too soon");
    assert.equal(appendSnapshot([at(0)], at(6000), 5000).length, 2);
    const full = Array.from({ length: HISTORY_MAX }, (_, i) => at(i * 10));
    const next = appendSnapshot(full, at(1e9), 5);
    assert.equal(next.length, HISTORY_MAX);
    assert.equal(next.at(-1).t, 1e9);
});

test("a snapshot keeps the top tools and folds the rest, whatever tool names arrive", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`mcp_tool_${i}`, i + 1]));
    const kept = topTools(many);
    assert.equal(Object.keys(kept).length, 21);
    assert.equal(kept["(other tools)"], Array.from({ length: 10 }, (_, i) => i + 1).reduce((a, b) => a + b));
});
