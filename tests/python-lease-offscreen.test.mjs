// python-lease-offscreen.test.mjs — the offscreen document's half of a worker-hosted run's leased python_exec cell
// (docs/spec/ASYNC_CALLS.md, mode 1): its start told to the service worker, the detached ceiling in place of the 15 s
// cap, its kept tail, and its cancel by id (the interrupt, then the kill).

// src/offscreen.ts imported for real under a mocked `chrome` and a fake `Worker`, the scaffolding of
// python-bench-stop-offscreen.test.mjs. The worker's own side of the interrupt flag (KeyboardInterrupt) is real CPython's
// and is not reached here. The service worker's half is python-lease.test.mjs.
import { test, mock } from "node:test";
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
const { CELL_STOP_KILLED, HELD_RESULTS_MAX, HELD_RESULT_MS } = await import("../src/offscreen.ts");
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

test("a leased cell's start is told to the service worker by its id, and with no cap named its limit is the 60 min detached ceiling, not 15 s", async () => {
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
    w.reply({ id: post.id, ok: true, stdout: "hello", value: "abc" });
    await answer; await tick(); await tick();
    const done = sentToWorker.find((m) => m.type === "PY_DONE" && m.cell === cell);
    assert.ok(done, "PY_DONE posted");
    assert.equal(done.run, run);
    assert.equal(done.ok, true);
    assert.equal(done.bytes, 8, "the size is stdout plus a text value, counted without serialising the result");
    const before = sentToWorker.length;
    const posted = new Map(workers.map((x) => [x, x.posts.length]));
    const a2 = send({ type: "PY_RUN", code: "x", hardened: true, tables: null, principal: "page:4" });
    await tick();
    const w2 = workers.find((x) => x.posts.some((p, i) => i >= (posted.get(x) ?? 0) && typeof p.id === "number"));
    w2.reply({ id: w2.posts.filter((p) => typeof p.id === "number").at(-1).id, ok: true, stdout: "" });
    await a2; await tick(); await tick();
    assert.equal(sentToWorker.slice(before).some((m) => m.type === "PY_DONE"), false);
});

// --- the kernel dies and restarts (Jupyter's model): a fatal Pyodide error ends the interpreter, not just the cell ---
//
// Measured with pillow 12.2.0: `import PIL._imagingtk` traps in a wasm indirect call (RuntimeError "function signature
// mismatch"), after which every runPython of that Pyodide throws "Pyodide already fatally failed and can no longer be
// used." and the worker stays alive. SIMULATED here, not the real Pyodide: this suite's worker is a fake (the offscreen
// document is the unit under test, and the real-CPython suites skip without pyodide-core). The fake keeps the real
// failure's shape: the trap once, then "already fatally failed" for every later run on the SAME worker; a respawned
// worker is a new FakeWorker with an empty namespace, so only a respawn can answer the second cell with a NameError.
// Today nothing respawns it (offscreen.ts kills a worker on `onerror` only), so these fail; `todo` until the fix lands.

const TRAP_TRACEBACK = "PythonError: Traceback (most recent call last):\n  File \"<exec>\", line 1, in <module>\n    import PIL._imagingtk\nRuntimeError: function signature mismatch";
const FATAL_LATER = "Pyodide already fatally failed and can no longer be used.";

/** Answers a posted run the way a Pyodide that has fatally failed would: the trap once, then the dead-interpreter text. */
function answerFatal(w, post) {
    if (w.fatal) { w.reply({ id: post.id, ok: false, stdout: "", error: FATAL_LATER }); return; }
    w.fatal = true;
    w.reply({ id: post.id, ok: false, stdout: "", error: TRAP_TRACEBACK });
}

/** A fresh interpreter's answer to `print(x)` for a name defined in a lost namespace. */
const NAME_ERROR = "NameError: name 'x' is not defined";

/** Post a cell on an existing run's principal and answer it from whichever worker the document handed it to. */
async function nextCell(run, { cell, started = true, code = "print(x)" } = {}) {
    const posted = new Map(workers.map((x) => [x, x.posts.length]));
    const answer = send({ type: "PY_RUN", code, hardened: true, tables: null, principal: `run:${run}`, wire: { client: `c-${run}`, run }, cell });
    await tick();
    const w = workers.filter((x) => x.posts.some((p, i) => i >= (posted.get(x) ?? 0) && typeof p.id === "number")).at(-1);
    const post = w.posts.filter((p) => typeof p.id === "number").at(-1);
    if (started) { w.reply({ id: post.id, started: true }); await tick(); }
    if (w.fatal) w.reply({ id: post.id, ok: false, stdout: "", error: FATAL_LATER });
    else w.reply({ id: post.id, ok: false, stdout: "", error: NAME_ERROR });
    return { answer, w };
}

test("a fatal Pyodide error names the module and the lost namespace, and the next cell runs in a respawned interpreter", { todo: "the kernel does not restart after a fatal Pyodide error (async/kernel-death)" }, async () => {
    const run = `kd${++n}`;
    const first = await leased({ run, cell: `wpy-${n}` });
    answerFatal(first.w, first.post);
    const a = await first.answer;
    assert.equal(a.ok, false);
    assert.match(a.error, /PIL\._imagingtk/, "the result names the module that killed the interpreter");
    assert.match(a.error, /namespace|variables/i, "and says the names defined before are gone");
    assert.equal(first.w.terminated, true, "the dead worker is terminated, not left alive and unusable");
    const before = sentToWorker.length;
    const second = await nextCell(run);
    const b = await second.answer;
    assert.notEqual(second.w, first.w, "the next cell runs on a new worker");
    assert.doesNotMatch(b.error ?? "", /already fatally failed/, "never the dead interpreter's answer");
    assert.match(b.error, /NameError/, "a fresh interpreter does not hold the name from before the crash");
    assert.ok(sentToWorker.slice(before).some((m) => m.type === "HOUSEKEEPING_REPORT" && m.payload.subsystem === "pyodide" && m.payload.kind === "respawn" && m.payload.key === `run:${run}`), "the respawn is in the housekeeping log");
});

test("a detached cell that hits a fatal error is reported done with the module and lost namespace, and the next cell in the run is not blocked", { todo: "the kernel does not restart after a fatal Pyodide error (async/kernel-death)" }, async () => {
    const run = `kd${++n}`;
    const first = await leased({ run, cell: `wpy-${n}` });   // started: the service worker has detached it by now
    assert.ok(sentToWorker.some((m) => m.type === "PY_STARTED" && m.cell === first.cell));
    answerFatal(first.w, first.post);
    const a = await first.answer;
    await tick(); await tick();
    const done = sentToWorker.find((m) => m.type === "PY_DONE" && m.cell === first.cell);
    assert.ok(done, "the end is told by id, so the service worker releases the lease and the kernel lock");
    assert.equal(done.ok, false, "and tells it failed");
    assert.match(a.error, /PIL\._imagingtk/, "the text the failed task carries names the module");
    assert.match(a.error, /namespace|variables/i, "and the lost namespace");
    assert.equal(first.w.terminated, true);
    const second = await nextCell(run, { cell: `wpy-${++n}` });
    const b = await second.answer;
    assert.notEqual(second.w, first.w, "a following cell of the run gets a fresh interpreter");
    assert.doesNotMatch(b.error ?? "", /already fatally failed/);
});

// --- the cap the worker names (the person's detachedTaskMaxMin), clamped to the ceiling ---

test("the kill timer is the cap the worker's PY_RUN named; none, zero, negative, not a number or over the ceiling is the ceiling", async () => {
    assert.equal(PY_DETACHED_MAX_MS, 3_600_000);
    for (const [named, armed] of [[120_000, 120_000], [60_000, 60_000], [0, PY_DETACHED_MAX_MS], [-5, PY_DETACHED_MAX_MS], ["10", PY_DETACHED_MAX_MS], [null, PY_DETACHED_MAX_MS], [Infinity, PY_DETACHED_MAX_MS], [PY_DETACHED_MAX_MS * 3, PY_DETACHED_MAX_MS], [180_000.9, 180_000]]) {
        const before = longTimers.length;
        const { post, w } = await leased({ extra: { detachedMaxMs: named } });
        const mine = longTimers.slice(before);
        assert.ok(mine.includes(armed), `detachedMaxMs ${String(named)} armed ${armed}, got ${mine}`);
        if (armed !== PY_DETACHED_MAX_MS) assert.equal(mine.includes(PY_DETACHED_MAX_MS), false, `${String(named)}: the ceiling was not armed beside it`);
        w.reply({ id: post.id, ok: true, stdout: "" });
    }
});

test("a cell past the cap is killed with a message that states the cap applied, not the ceiling", async () => {
    const { w, answer } = await leased({ extra: { detachedMaxMs: 1500 } });
    const a = await answer;
    assert.equal(w.terminated, true);
    assert.match(a.error, /The Python cell ran past 2 s and the sandbox was terminated/);
    assert.doesNotMatch(a.error, /60 min/);
});

test("a cap is honoured only on the worker's own leased cell: a content script's PY_RUN naming one still has the 15 s cap, and a cell with no cell id too", async () => {
    const tab = await leased({ sender: PAGE, extra: { detachedMaxMs: 1500 } });
    const bare = await leased({ extra: { cell: undefined, detachedMaxMs: 1500 } });
    await sleep(1700);
    assert.equal(tab.w.terminated, false, "a tab cannot shorten (or name) a cap");
    assert.equal(bare.w.terminated, false, "a cap without a cell id is ignored");
    tab.w.reply({ id: tab.post.id, ok: true, stdout: "" });
    bare.w.reply({ id: bare.post.id, ok: true, stdout: "" });
});

// --- PY_RESULT: the last leased results, for a worker started since ---

/** A leased cell that has answered, so its result is held. */
async function answeredCell(result = { ok: true, stdout: "hello", value: "abc" }) {
    const c = await leased();
    c.w.reply({ id: c.post.id, ...result });
    await c.answer; await tick(); await tick();
    return c;
}

test("PY_RESULT hands a leased cell's result to the service worker once, then forgets it", async () => {
    const { cell } = await answeredCell();
    const first = await send({ type: "PY_RESULT", cell });
    assert.equal(first.result.ok, true);
    assert.equal(first.result.stdout, "hello");
    assert.equal(first.result.value, "abc");
    assert.deepEqual(await send({ type: "PY_RESULT", cell }), { result: null }, "once");
});

test("PY_RESULT is answered only to the service worker: a content script gets nothing, and does not use up the result", async () => {
    const { cell } = await answeredCell();
    assert.equal(await send({ type: "PY_RESULT", cell }, PAGE), undefined, "a tab sender is not answered");
    assert.equal(await send({ type: "PY_RESULT", cell }, { id: "someone-else" }), undefined, "another extension is not answered");
    assert.equal((await send({ type: "PY_RESULT", cell })).result.value, "abc", "the result is still there for the worker");
});

test("PY_RESULT for a cell that never ran, was never leased, or whose name is not a string answers none", async () => {
    assert.deepEqual(await send({ type: "PY_RESULT", cell: "wpy-never" }), { result: null });
    assert.equal(await send({ type: "PY_RESULT", cell: 7 }), undefined);
    assert.equal(await send({ type: "PY_RESULT" }), undefined);
});

test("only the last HELD_RESULTS_MAX results are held, the oldest first out", async () => {
    const cells = [];
    for (let i = 0; i < HELD_RESULTS_MAX + 2; i++) cells.push((await answeredCell({ ok: true, stdout: "", value: i })).cell);
    assert.deepEqual(await send({ type: "PY_RESULT", cell: cells[0] }), { result: null });
    assert.deepEqual(await send({ type: "PY_RESULT", cell: cells[1] }), { result: null });
    assert.equal((await send({ type: "PY_RESULT", cell: cells[2] })).result.value, 2);
    assert.equal((await send({ type: "PY_RESULT", cell: cells.at(-1) })).result.value, HELD_RESULTS_MAX + 1);
});

test("a result is dropped after HELD_RESULT_MS", async () => {
    const { cell } = await answeredCell();
    const real = Date.now();
    const fake = mock.method(Date, "now", () => real + HELD_RESULT_MS + 1);
    try { assert.deepEqual(await send({ type: "PY_RESULT", cell }), { result: null }); } finally { fake.mock.restore(); }
    const { cell: fresh } = await answeredCell();
    const early = mock.method(Date, "now", () => real + HELD_RESULT_MS - 60_000);
    try { assert.equal((await send({ type: "PY_RESULT", cell: fresh })).result.value, "abc", "inside the window it is still held"); } finally { early.mock.restore(); }
});

test("an unleased cell's result is not held", async () => {
    const posted = new Map(workers.map((x) => [x, x.posts.length]));
    const a = send({ type: "PY_RUN", code: "x", hardened: true, tables: null, principal: "page:9" });
    await tick();
    const w = workers.find((x) => x.posts.some((p, i) => i >= (posted.get(x) ?? 0) && typeof p.id === "number"));
    w.reply({ id: w.posts.filter((p) => typeof p.id === "number").at(-1).id, ok: true, stdout: "", value: "secret" });
    await a; await tick(); await tick();
    assert.deepEqual(await send({ type: "PY_RESULT", cell: "page:9" }), { result: null });
});
