// python-lease-offscreen.test.mjs — the offscreen document's half of a worker-hosted run's leased python_exec cell
// (docs/spec/ASYNC_CALLS.md, mode 1): its start told to the service worker, the detached ceiling in place of the 15 s
// cap, its kept tail, and its cancel by id (the interrupt, then the kill).

// src/offscreen.ts imported for real under a mocked `chrome` and a fake `Worker`, the scaffolding of
// python-bench-stop-offscreen.test.mjs. The worker's own side of the interrupt flag (KeyboardInterrupt) is real CPython's
// and is not reached here. The service worker's half is python-lease.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

// --- a fake chrome and Worker around the real offscreen document ---

const listeners = [];
const sentToWorker = [];   // chrome.runtime.sendMessage payloads (the offscreen document talking to the service worker)
const workers = [];
class FakeWorker {
    constructor(url, opts) { this.url = url; this.name = opts?.name; this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
    get flag() { return this.posts.find((p) => p.interruptBuffer)?.interruptBuffer; }
}
globalThis.Worker = FakeWorker;
// Timers of a minute or more (the idle reap, the detached ceiling) must not hold this process open.
const realSetTimeout = globalThis.setTimeout;
const longTimers = [];
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) { t.unref(); longTimers.push(ms); } return t; };
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => { sentToWorker.push(m); return Promise.resolve(undefined); },
    },
};
const { CELL_STOP_KILLED } = await import("../src/offscreen.ts");
const { PY_DETACHED_MAX_MS, PY_INTERRUPT_KILL_MS, PY_TAIL_RING_CHARS } = await import("../src/python/py-lease.ts");

const SW = { id: "test" };
const PAGE = { id: "test", tab: { id: 7 } };   // a content script: our id, but a tab
const send = (msg, sender = SW) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

/** A worker-hosted run's leased cell, posted; `started` plays the worker's note that the cell begins. */
async function leased({ started = true, cell = `wpy-${++n}`, run = `r${n}`, sender = SW, extra = {} } = {}) {
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "while True: pass", hardened: true, tables: null, principal: `run:${run}`, wire: { client: `c${n}`, run }, cell, ...extra }, sender);
    await tick();
    const w = workers.find((x) => x.posts.some((p, i) => i >= (posted.get(x) ?? 0) && typeof p.id === "number"));
    const post = w.posts.filter((p) => typeof p.id === "number").at(-1);
    if (started) { w.reply({ id: post.id, started: true }); await tick(); }
    if (w.flag) Atomics.store(w.flag, 0, 0);
    return { answer, w, post, cell, run };
}

// --- the start is told, and the cap is the detached ceiling ---

test("a leased cell's start is told to the service worker by its id, and its cap is the detached ceiling, not 15 s", async () => {
    const before = longTimers.length;
    const { cell, post, w } = await leased();
    assert.ok(sentToWorker.some((m) => m.type === "PY_STARTED" && m.cell === cell), "PY_STARTED carries the cell id");
    assert.ok(longTimers.slice(before).includes(PY_DETACHED_MAX_MS), "the ceiling was armed at the start");
    assert.equal(post.stream, true, "a leased cell always streams to the document, which keeps its tail");
    await sleep(15_200);
    assert.equal(w.terminated, false, "past 15 s a leased cell still runs");
    w.reply({ id: post.id, ok: true, stdout: "", value: 1 });
});

test("an unleased cell is unchanged: no PY_STARTED, and the 15 s cap", async () => {
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const before = sentToWorker.length;
    void send({ type: "PY_RUN", code: "x", hardened: true, tables: null, principal: "page:3" });
    await tick();
    const w = workers.find((x) => x.posts.some((p, i) => i >= (posted.get(x) ?? 0) && typeof p.id === "number"));
    const post = w.posts.filter((p) => typeof p.id === "number").at(-1);
    w.reply({ id: post.id, started: true }); await tick();
    assert.equal(sentToWorker.slice(before).some((m) => m.type === "PY_STARTED"), false);
    assert.notEqual(post.stream, true);
    w.reply({ id: post.id, ok: true, stdout: "" });
});

test("a cell id is honoured only from the service worker, for the run's own principal", async () => {
    const fromTab = await leased({ sender: PAGE });
    assert.equal(sentToWorker.some((m) => m.type === "PY_STARTED" && m.cell === fromTab.cell), false, "a content script cannot lease");
    fromTab.w.reply({ id: fromTab.post.id, ok: true, stdout: "" });
    const other = await leased({ extra: { principal: "run:someone-else" } });
    assert.equal(sentToWorker.some((m) => m.type === "PY_STARTED" && m.cell === other.cell), false, "nor for another principal than the wire's run");
    other.w.reply({ id: other.post.id, ok: true, stdout: "" });
});

// --- the tail ---

test("PY_TAIL answers the cell's kept output, bounded, and running:false once it ended", async () => {
    const { cell, post, w } = await leased();
    w.reply({ id: post.id, partial: true, chunk: "a\nb\n", ts: 1 });
    assert.deepEqual(await send({ type: "PY_TAIL", cell }), { running: true, text: "a\nb\n" });
    w.reply({ id: post.id, partial: true, chunk: "x".repeat(PY_TAIL_RING_CHARS + 10), ts: 2 });
    const big = await send({ type: "PY_TAIL", cell });
    assert.ok(big.text.length <= PY_TAIL_RING_CHARS, "the ring keeps at most its bound");
    w.reply({ id: post.id, ok: true, stdout: "" });
    await tick();
    assert.deepEqual(await send({ type: "PY_TAIL", cell }), { running: false });
    assert.equal(await send({ type: "PY_TAIL", cell }, PAGE), undefined, "a content script is not answered");
});

// --- the cancel ---

test("PY_CANCEL interrupts the cell; a cell that answers in time is not killed and the cancel says interrupted", async () => {
    const { cell, post, w, answer } = await leased();
    const cancel = send({ type: "PY_CANCEL", cell });
    await tick();
    assert.equal(Atomics.load(w.flag, 0), 2, "SIGINT written into the cell's worker");
    w.reply({ id: post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    assert.deepEqual(await cancel, { how: "interrupted" });
    assert.equal((await answer).error, "KeyboardInterrupt", "the cell's own answer is the worker's");
    await sleep(PY_INTERRUPT_KILL_MS + 100);
    assert.equal(w.terminated, false);
});

test("PY_CANCEL kills the sandbox when the interrupt does not land in time, and says killed", async () => {
    const { cell, w, answer } = await leased();
    const cancel = send({ type: "PY_CANCEL", cell });
    assert.deepEqual(await cancel, { how: "killed" });
    assert.equal(w.terminated, true);
    const a = await answer;
    assert.equal(a.error, CELL_STOP_KILLED);
    assert.equal(a.stopped, "restarted");
});

test("PY_CANCEL before the cell started interrupts it as it starts", async () => {
    const { cell, post, w } = await leased({ started: false });
    const cancel = send({ type: "PY_CANCEL", cell });
    await tick();
    assert.equal(Atomics.load(w.flag, 0), 0, "nothing is written while the cell has not started: the worker clears the flag before it runs");
    w.reply({ id: post.id, started: true });
    await tick();
    assert.equal(Atomics.load(w.flag, 0), 2, "written at the start");
    w.reply({ id: post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    assert.deepEqual(await cancel, { how: "interrupted" });
});

test("PY_CANCEL of a cell that is not running answers ended; a content script is not answered", async () => {
    assert.deepEqual(await send({ type: "PY_CANCEL", cell: "wpy-never" }), { how: "ended" });
    const { cell, post, w } = await leased();
    assert.equal(await send({ type: "PY_CANCEL", cell }, PAGE), undefined);
    assert.equal(Atomics.load(w.flag, 0), 0, "and nothing was interrupted");
    w.reply({ id: post.id, ok: true, stdout: "" });
});

// --- a leased cell's end is told by its id, for a worker that may have died ---

test("a leased cell's end is posted as PY_DONE with its run, outcome and size; an unleased cell's is not", async () => {
    const { cell, post, w, run, answer } = await leased();
    w.reply({ id: post.id, ok: true, stdout: "hello", value: 1 });
    await answer; await tick(); await tick();
    const done = sentToWorker.find((m) => m.type === "PY_DONE" && m.cell === cell);
    assert.ok(done, "PY_DONE posted");
    assert.equal(done.run, run);
    assert.equal(done.ok, true);
    assert.ok(done.bytes > 0);
    const before = sentToWorker.length;
    const posted = new Map(workers.map((x) => [x, x.posts.length]));
    const a2 = send({ type: "PY_RUN", code: "x", hardened: true, tables: null, principal: "page:4" });
    await tick();
    const w2 = workers.find((x) => x.posts.some((p, i) => i >= (posted.get(x) ?? 0) && typeof p.id === "number"));
    w2.reply({ id: w2.posts.filter((p) => typeof p.id === "number").at(-1).id, ok: true, stdout: "" });
    await a2; await tick(); await tick();
    assert.equal(sentToWorker.slice(before).some((m) => m.type === "PY_DONE"), false);
});
