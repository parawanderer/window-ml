// answer-log.test.mjs — the answer set of a worker-built run as a page-side script sees it (`AnswerLog`), and the
// worker's replay of what that script reports it changed (`replayAnswerOps`, answer-set.ts; worker-answer.ts). The
// report crosses from the page, so the replay is tested as a boundary: whatever the page sends, the set stays well
// formed, and a text the page was never shown stays unknown to it.
import { test } from "node:test";
import assert from "node:assert/strict";
const { AnswerSet, AnswerLog, answerShape, replayAnswerOps, makeAnswerFacade } = await import("../src/pointers/answer-set.ts");

/** A worker set holding a private text, an output pointer and an element. */
function workerSet() {
    const s = new AnswerSet();
    s.add({ kind: "text", text: "PRIVATE TEXT FROM ANOTHER SITE" });
    s.add({ kind: "token", ref: "@tool:abc1234", preview: "the table" });
    s.add({ kind: "element", nodes: [], preview: "h1 \"Title\"" });
    return s;
}

// --- what the page is given ---

test("the shape carries no text content, only that a text item is there; pointers and elements keep their previews", () => {
    const shape = answerShape(workerSet());
    assert.deepEqual(shape, [{ kind: "text" }, { kind: "token", ref: "@tool:abc1234", preview: "the table" }, { kind: "element", preview: "h1 \"Title\"" }]);
    assert.ok(!JSON.stringify(shape).includes("PRIVATE"));
});

test("a page-side script reads the length and indices at once, and a text it was not shown reads as kept by the worker", () => {
    const log = new AnswerLog(answerShape(workerSet()));
    const f = makeAnswerFacade(log);
    assert.equal(f.length, 3);
    assert.deepEqual(f.dump().map((d) => [d.i, d.kind, d.preview]), [[0, "text", "(text, kept by the worker)"], [1, "token", "@tool:abc1234 — the table"], [2, "element", "h1 \"Title\""]]);
    assert.ok(!JSON.stringify(f).includes("PRIVATE"));
});

test("remove by text matches only what the script can see; a hidden text is never matched, not even by its placeholder", () => {
    const log = new AnswerLog(answerShape(workerSet()));
    const f = makeAnswerFacade(log);
    assert.equal(f.remove("PRIVATE TEXT FROM ANOTHER SITE"), 0, "the page cannot test a guess against the hidden text");
    assert.equal(f.remove("\u0000"), 0);
    assert.equal(f.remove("@tool:abc1234"), 1);
    f.add("mine");
    assert.equal(f.remove("mine"), 1);
    assert.equal(f.length, 2);
});

test("every change is recorded in order, an element by its preview only; a checkpoint restore drops what came after it", () => {
    const log = new AnswerLog([]);
    const f = makeAnswerFacade(log, () => "p \"x\"");
    f.add("a");
    const restore = log.checkpoint();
    f.add({ nodeType: 1 });
    f.remove(0);
    restore();
    f.clear();
    assert.deepEqual(JSON.parse(JSON.stringify(log.ops)), [{ op: "add", item: { kind: "text", text: "a" } }, { op: "clear" }]);
    const el = new AnswerLog([]);
    makeAnswerFacade(el, () => "p \"x\"").add({ nodeType: 1, secret: "node" });
    assert.deepEqual(JSON.parse(JSON.stringify(el.ops)), [{ op: "add", item: { kind: "element", preview: "p \"x\"" } }]);
});

// --- what the worker replays ---

test("the worker's replay gives the same set the script saw, with the hidden text in place", () => {
    const real = workerSet();
    const log = new AnswerLog(answerShape(real));
    const f = makeAnswerFacade(log, () => "b \"x\"");
    f.remove(1); f.add("added"); f.add({ nodeType: 1 });
    assert.deepEqual(replayAnswerOps(real, JSON.parse(JSON.stringify(log.ops))), { applied: 3 });
    assert.deepEqual(real.dump().map((d) => [d.kind, d.preview]), [["text", "PRIVATE TEXT FROM ANOTHER SITE"], ["element", "h1 \"Title\""], ["text", "added"], ["element", "b \"x\""]]);
    assert.equal(real.length, f.length);
});

test("a report with any malformed operation is refused whole and changes nothing", () => {
    const bad = [
        "not a list", null, { op: "add" },
        [{ op: "add", item: { kind: "text", text: "ok" } }, { op: "drop" }],
        [{ op: "add", item: { kind: "element", preview: "x", nodes: [1] }, extra: 1 }, { op: "remove", which: -1 }],
        [{ op: "remove", which: 1.5 }],
        [{ op: "add", item: { kind: "token", ref: "javascript:alert(1)" } }],
        [{ op: "add", item: { kind: "text", text: "x".repeat(20_001) } }],
        [{ op: "add", item: { kind: "element", preview: { toString: () => "x" } } }],
        [{ op: "add", item: { kind: "text", text: 5 } }],
        Array.from({ length: 201 }, () => ({ op: "clear" })),
    ];
    for (const ops of bad) {
        const set = workerSet();
        const before = JSON.stringify(set.dump());
        const r = replayAnswerOps(set, ops);
        assert.ok("refused" in r, `accepted: ${JSON.stringify(ops).slice(0, 80)}`);
        assert.equal(JSON.stringify(set.dump()), before);
    }
});

test("a replayed element is a preview with no nodes, whatever the page sends", () => {
    const set = new AnswerSet();
    replayAnswerOps(set, [{ op: "add", item: { kind: "element", preview: "x", note: "n", nodes: ["forged"], media: [{ dataUrl: "data:,x" }] } }]);
    assert.deepEqual(JSON.parse(JSON.stringify(set.items)), [{ kind: "element", nodes: [], preview: "x", note: "n" }]);
    assert.deepEqual(set.media(), [], "media comes only from the worker's own selector path");
});
