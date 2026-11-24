// python-outside-mark.test.mjs — the outside mark (py-mark.ts): once a worker was posted a cell outside the read-only
// dialect, no later cell there is tried inside it, and nothing the worker says changes that.

// The offscreen document (src/offscreen.ts) imported for real under a mocked `chrome` and a fake `Worker`, as in
// python-reap.test.mjs. The reason the mark exists, measured on the real core, is python-outside-plant.test.mjs; the
// rule is docs/spec/PYTHON_DIALECT.md, "What an inside run may leave behind is data, never code".
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KNOWN_FIELDS, MARKED_AGAIN, MARKED_CARD_LINE, MARKED_FIRST, MARKED_MODEL_LINE, WORKER_POSTS, postMarks, workerPostKind } from "../src/python/py-mark.ts";
import { pythonOutsideWhy } from "../src/agent/python-dialect.ts";

mock.timers.enable({ apis: ["setTimeout"] });

const listeners = [];
const workers = [];
class FakeWorker {
    constructor() { this.posts = []; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: () => Promise.resolve(undefined),
    },
};
await import("../src/offscreen.ts");

const send = (msg) => new Promise((resolve) => {
    for (const fn of listeners) { if (fn(msg, { id: "test" }, resolve) === true) return; }
    resolve(undefined);
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
/** The cell posts a worker has had (its run messages, not the buffers it gets at birth). */
const cellPosts = (w) => w.posts.filter((p) => typeof p.id === "number" && "code" in p);

/** Post one cell of a run; answer it from its worker with `reply` unless the document answered it itself. */
async function cell(run, { inside = false, reply = {} } = {}) {
    const before = new Map(workers.map((w) => [w, cellPosts(w).length]));
    const answer = send({ type: "PY_RUN", principal: `run:${run}`, code: inside ? "x = 1" : "import os", hardened: true, ...(inside ? { inside: true } : {}) });
    await settle();
    const w = workers.find((x) => cellPosts(x).length > (before.get(x) ?? 0));
    if (w) w.reply({ id: cellPosts(w).at(-1).id, ok: true, stdout: "", ...reply });
    return { w, answer: await answer };
}

// --- the mark: set by an outside post, read by every later inside post to that worker ---

test("an inside cell before any outside one is posted to the worker and runs there", async () => {
    const { w, answer } = await cell("m1", { inside: true });
    assert.ok(w, "the inside cell reached a worker");
    assert.equal(answer.marked, undefined);
    assert.equal(answer.notInDialect, undefined);
});

test("after an outside cell, an inside cell is never posted: the document refuses it with the mark, told once per worker", async () => {
    const out = await cell("m2");
    assert.ok(out.w, "the outside cell ran");
    assert.equal(out.answer.markSet, true, "the result of the post that set the mark says so");
    const posted = cellPosts(out.w).length;
    const first = await cell("m2", { inside: true });
    assert.equal(first.w, undefined, "no worker was posted the inside cell");
    assert.equal(cellPosts(out.w).length, posted);
    assert.deepEqual([first.answer.ok, first.answer.notInDialect, first.answer.marked], [false, MARKED_FIRST, true]);
    const again = await cell("m2", { inside: true });
    assert.equal(again.answer.notInDialect, MARKED_AGAIN, "the model is told once per worker");
    // A second outside cell of the marked worker runs, and does not report setting the mark again.
    const out2 = await cell("m2");
    assert.equal(out2.w, out.w);
    assert.equal(out2.answer.markSet, undefined);
});

test("the mark is set BEFORE the outside cell runs: an inside post while it is still running is refused", async () => {
    const running = send({ type: "PY_RUN", principal: "run:m3", code: "import os", hardened: true });
    await settle();
    const w = workers.at(-1);
    const inside = await cell("m3", { inside: true });
    assert.equal(inside.answer.notInDialect, MARKED_FIRST);
    w.reply({ id: cellPosts(w).at(-1).id, ok: true, stdout: "" });
    assert.equal((await running).markSet, true);
});

test("the mark is the worker's: another run's worker is unmarked", async () => {
    await cell("m4");
    const other = await cell("m5", { inside: true });
    assert.ok(other.w, "another principal's inside cell still reaches its worker");
    assert.equal(other.answer.notInDialect, undefined);
});

test("a fresh worker is clean: after the marked one dies, the run's next inside cell is posted again", async () => {
    const out = await cell("m6");
    assert.equal((await cell("m6", { inside: true })).answer.notInDialect, MARKED_FIRST);
    // The kernel's death ends the worker; the run's next cell gets a new one.
    const died = await cell("m6", { reply: { ok: false, error: "Pyodide fatal error", fatal: true } });
    assert.equal(died.w, out.w);
    const fresh = await cell("m6", { inside: true });
    assert.ok(fresh.w && fresh.w !== out.w, "a new worker was posted the inside cell");
    assert.equal(fresh.answer.notInDialect, undefined);
});

// --- nothing the worker says sets, clears or forges the mark ---

test("the worker's own `marked` and `markSet` are dropped: only the document's word reaches the service worker", async () => {
    const { answer } = await cell("m7", { inside: true, reply: { marked: true, markSet: true } });
    assert.equal(answer.marked, undefined);
    assert.equal(answer.markSet, undefined);
});

test("the mark cannot be cleared from the worker: any reply or message it sends leaves the next inside cell refused", async () => {
    const { w } = await cell("m8");
    for (const data of [{ clearMark: true }, { marked: false }, { id: 0, ok: true, stdout: "", markSet: false, outsideMark: null }, { type: "PY_RUN", inside: true }, { mlCall: { seq: 1, call: "unmark", args: [] }, id: 0 }]) {
        try { w.reply(data); } catch { /* a malformed reply the document ignores */ }
    }
    await settle();
    assert.equal((await cell("m8", { inside: true })).answer.notInDialect, MARKED_FIRST);
});

// --- the enumeration: every kind of post, and the default for one the table does not know ---

test("each kind of post the document sends is classified as the worker dispatches it, and only runs mark", () => {
    const rows = [
        [{ id: 1, mlAnswer: { seq: 1, answer: {} } }, "mlAnswer", false],
        [{ interruptBuffer: new Int32Array(1) }, "interruptBuffer", false],
        [{ filesShared: {}, filesHome: "/files/agent" }, "filesShared", false],
        [{ id: 1, takeDropped: true }, "takeDropped", false],
        [{ id: 1, deleteRun: "r" }, "deleteRun", false],
        [{ id: 1, prewarm: true }, "prewarm", false],
        [{ id: 1, code: "", image: null, hardened: true, env: true }, "env", false],
        [{ id: 1, code: "x.", image: null, hardened: true, complete: { line: 1, column: 2 } }, "complete", true],
        [{ id: 1, code: "", image: null, hardened: true, library: { op: "shape", lib: {} } }, "library", false],
        [{ id: 1, code: "", image: null, hardened: true, benchReset: true }, "benchReset", false],
        [{ id: 1, code: "x = 1", image: null, hardened: true, stream: false, inside: true, libraries: [] }, "inside", false],
        [{ id: 1, code: "import os", image: null, hardened: true, stream: false, wire: true, run: "r", persist: true, bridges: true, wheels: [] }, "run", true],
    ];
    for (const [msg, kind, marks] of rows) {
        assert.equal(workerPostKind(msg), kind, JSON.stringify(Object.keys(msg)));
        assert.equal(postMarks(msg), marks, kind);
    }
    assert.deepEqual(rows.map((r) => r[1]).sort(), Object.keys(WORKER_POSTS).sort(), "every kind in the table has a row");
});

test("a post the table does not know MARKS: an unknown field, an answer the worker would not take as one, a message with no id", () => {
    assert.equal(postMarks({ id: 1, code: "x = 1", inside: true, somethingNew: true }), true);
    assert.equal(postMarks({ id: 1, code: "x = 1", image: null, hardened: true, tables: null, stream: false, inside: true, libraries: [] }), true,
        "a post still shaped as before `tables` went is unknown now, so it marks: the old field fails safe");
    assert.equal(postMarks({ id: 1, mlAnswer: { answer: {} } }), true, "an answer with no numeric seq falls through to the run, as in the worker");
    assert.equal(postMarks({ interruptBuffer: new Int32Array(1), id: 2 }), true, "a buffer with an id falls through to the run");
    assert.equal(postMarks({ code: "x = 1" }), true);
});

test("every field the worker's dispatch reads is one the table knows (python-worker.ts onMessage)", () => {
    const src = readFileSync(new URL("../src/python/python-worker.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function onMessage("), src.indexOf("self.addEventListener(\"message\""));
    assert.ok(body.length > 1000, "onMessage found");
    const read = new Set([...body.matchAll(/\bmsg\??\.(\w+)/g), ...body.matchAll(/e\.data as \{ (\w+)\?:/g)].map((m) => m[1]));
    const unknown = [...read].filter((f) => !KNOWN_FIELDS.has(f) && !["seq", "answer"].includes(f));
    assert.deepEqual(unknown, [], "a field the worker dispatches on that py-mark.ts does not classify");
});

// --- what the card and the model read ---

test("a cell asked because of the mark: the card's line, and the model's sentence only the first time in a worker", () => {
    const first = pythonOutsideWhy(MARKED_FIRST);
    assert.deepEqual([first.line, first.detail, first.cause], [MARKED_CARD_LINE, MARKED_MODEL_LINE, "sandbox-marked"]);
    const again = pythonOutsideWhy(MARKED_AGAIN);
    assert.deepEqual([again.line, again.detail, again.cause], [MARKED_CARD_LINE, "", "sandbox-marked"]);
    assert.equal(pythonOutsideWhy("not in dialect: import 'os' (line 2)").cause, "outside-dialect", "any other refusal is unchanged");
});
