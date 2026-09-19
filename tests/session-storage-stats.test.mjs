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
