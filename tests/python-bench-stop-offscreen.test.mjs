// python-bench-stop-offscreen.test.mjs — the offscreen document's half of the Python bench's Stop: PY_INTERRUPT.

// src/offscreen.ts imported for real under a mocked `chrome` and a fake `Worker` (the scaffolding of
// python-run-namespace.test.mjs). What is NOT reached here is the worker's own side of the flag (python-worker.ts reads
// the interrupt buffer and raises KeyboardInterrupt), which only real CPython shows. The service worker's half is in
// background.test.js. Design: docs/dev/python-sandbox.md, "Stopping a bench script".
import { test } from "node:test";
import assert from "node:assert/strict";

// --- a fake chrome and Worker around the real offscreen document ---

const listeners = [];
const sentToWorker = [];   // chrome.runtime.sendMessage payloads (the offscreen document talking to the service worker)
const workers = [];   // every Worker the document spawned, in order
class FakeWorker {
    constructor(url, opts) { this.url = url; this.name = opts?.name; this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    /** Play the worker's reply to the document. */
    reply(data) { this.onmessage({ data }); }
    /** The interrupt flag the document posted to this worker: the SharedArrayBuffer the document writes 2 into. */
    get flag() { return this.posts.find((p) => p.interruptBuffer)?.interruptBuffer; }
}
globalThis.Worker = FakeWorker;
// The idle reap arms a clock of minutes on every idle worker; a live timer would hold this process open.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) t.unref(); return t; };
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => { sentToWorker.push(m); return Promise.resolve(undefined); },
    },
};
const { BENCH_STOP_KILL_MS, BENCH_STOP_KILLED } = await import("../src/offscreen.ts");

const SW = { id: "test" };   // the service worker's sender: our id, no tab
/** Deliver a runtime message to the document's listeners; resolves with its answer, or undefined when none came. */
const send = (msg, sender = SW) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kills = () => sentToWorker.filter((m) => m.type === "HOUSEKEEPING_REPORT" && m.payload?.kind === "kill");
const stoppedKills = () => kills().filter((m) => m.payload.reason === "stopped");

/** Post a PY_RUN and wait until its worker has it. `started` plays the worker's "the cell is starting" note. */
async function startRun(msg, { started = true } = {}) {
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "while True: pass", hardened: true, tables: null, ...msg });
    await tick();
    const w = workers.find((x) => x.posts.some((p, i) => i >= (posted.get(x) ?? 0) && typeof p.id === "number"));
    const post = w.posts.filter((p) => typeof p.id === "number").at(-1);
    if (started) { w.reply({ id: post.id, started: true }); await tick(); }
    return { answer, w, post };
}
/** A started bench run on the `own` principal, its interrupt flag zeroed (the fake worker never clears it). */
async function benchRun() {
    const run = await startRun({ persist: true });
    Atomics.store(run.w.flag, 0, 0);
    return run;
}

// --- a started bench run is interrupted ---

test("PY_INTERRUPT on a started bench run writes 2 into its flag, and a worker that answers in time is not killed", async () => {
    const { answer, w, post } = await benchRun();
    assert.ok(w.flag instanceof Int32Array, "the interrupt buffer went to the worker");
    assert.equal(w.posts[0].interruptBuffer, w.flag, "and it was the first thing posted, before any run");
    const killsBefore = stoppedKills().length;
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { interrupted: true });
    assert.equal(Atomics.load(w.flag, 0), 2, "SIGINT written");
    // The worker's KeyboardInterrupt ends the script well inside the bound.
    w.reply({ id: post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    assert.deepEqual(await answer, { ok: false, stdout: "", error: "KeyboardInterrupt" }, "the run's answer is the worker's own");
    await sleep(BENCH_STOP_KILL_MS + 200);
    assert.equal(w.terminated, false, "the bound passed with nothing to kill: the answer cleared the timer");
    assert.equal(stoppedKills().length, killsBefore, "no kill record was sent");
});

// --- a worker that does not answer the interrupt is restarted ---

test("a started bench run that never answers is killed after BENCH_STOP_KILL_MS with stopped: restarted, and the kill is logged as stopped", async () => {
    const { answer, w } = await benchRun();
    const killsBefore = stoppedKills().length;
    const t0 = Date.now();
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { interrupted: true });
    assert.equal(w.terminated, false, "positive control: not killed at once, the interrupt gets its chance");
    const res = await answer;
    assert.deepEqual(res, { ok: false, stdout: "", error: BENCH_STOP_KILLED, stopped: "restarted" });
    assert.ok(Date.now() - t0 >= BENCH_STOP_KILL_MS - 50, "not before the bound");
    assert.equal(w.terminated, true);
    const rec = stoppedKills().at(-1);
    assert.equal(stoppedKills().length, killsBefore + 1);
    assert.equal(rec.payload.subsystem, "pyodide");
    assert.equal(rec.payload.key, "own");
});

// --- nothing to interrupt ---

test("PY_INTERRUPT with no bench run answers running: false and writes nothing", async () => {
    // Positive control: a worker exists (an earlier bench run spawned one), idle, with its flag zeroed.
    const { answer, w, post } = await benchRun();
    w.reply({ id: post.id, ok: true, stdout: "" });
    await answer;
    assert.equal(Atomics.load(w.flag, 0), 0);
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { running: false });
    assert.equal(Atomics.load(w.flag, 0), 0, "nothing written to an idle worker");
    assert.equal(w.terminated, false);
});

test("a bench run posted but not yet started is not interrupted", async () => {
    const { answer, w, post } = await startRun({ persist: true }, { started: false });
    Atomics.store(w.flag, 0, 0);
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { running: false });
    assert.equal(Atomics.load(w.flag, 0), 0, "the flag stays 0: the run is still queued behind the runtime boot");
    // Positive control: once the worker says it started, the same run is interrupted.
    w.reply({ id: post.id, started: true });
    await tick();
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { interrupted: true });
    assert.equal(Atomics.load(w.flag, 0), 2);
    w.reply({ id: post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    await answer;
});

// --- only the bench's own script is a target ---

test("a started cell of another principal (even one that keeps its namespace), and a non-persist cell on own, are not interrupted", async () => {
    const other = await startRun({ principal: "run:stop-a", persist: true, wire: { client: "mlw-stop", run: "stop-a" } });
    const plain = await startRun({ persist: false });
    for (const r of [other, plain]) Atomics.store(r.w.flag, 0, 0);
    const killsBefore = kills().length;
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { running: false });
    assert.equal(Atomics.load(other.w.flag, 0), 0, "a run's wire cell keeps running");
    assert.equal(Atomics.load(plain.w.flag, 0), 0, "a cell that does not keep the namespace is not the bench's");
    assert.notEqual(other.w, plain.w);
    await sleep(BENCH_STOP_KILL_MS + 200);
    assert.equal(kills().length, killsBefore, "nothing killed");
    assert.equal(other.w.terminated || plain.w.terminated, false);
    other.w.reply({ id: other.post.id, ok: true, stdout: "" });
    plain.w.reply({ id: plain.post.id, ok: true, stdout: "" });
    await Promise.all([other.answer, plain.answer]);
    // Positive control: a started bench run IS the target (it shares the `own` worker with the plain cell, so the flag is that worker's).
    const bench = await benchRun();
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { interrupted: true });
    assert.equal(Atomics.load(bench.w.flag, 0), 2);
    assert.equal(Atomics.load(other.w.flag, 0), 0, "the other principal's worker is still untouched");
    bench.w.reply({ id: bench.post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    await bench.answer;
});

// --- who may send it ---

test("PY_INTERRUPT from a content script or another extension gets no answer and writes nothing", async () => {
    const { answer, w, post } = await benchRun();
    assert.equal(await send({ type: "PY_INTERRUPT" }, { id: "test", tab: { id: 4 }, url: "https://evil.example/" }), undefined, "a tab's sender");
    assert.equal(await send({ type: "PY_INTERRUPT" }, { id: "other-extension" }), undefined, "a foreign id");
    assert.equal(await send({ type: "PY_INTERRUPT" }, {}), undefined, "no id at all");
    assert.equal(Atomics.load(w.flag, 0), 0, "nothing written");
    // Positive control: the service worker's sender interrupts the same run.
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }, SW), { interrupted: true });
    assert.equal(Atomics.load(w.flag, 0), 2);
    w.reply({ id: post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    await answer;
});

// --- a second Stop ---

test("a second PY_INTERRUPT while stopping answers interrupted and does not re-arm the kill", async () => {
    const { answer, w } = await benchRun();
    let resolved = 0;
    const counted = answer.then((r) => { resolved++; return r; });
    const t0 = Date.now();
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { interrupted: true });
    await sleep(Math.round(BENCH_STOP_KILL_MS * 0.7));
    assert.deepEqual(await send({ type: "PY_INTERRUPT" }), { interrupted: true });
    const res = await counted;
    const elapsed = Date.now() - t0;
    assert.equal(res.stopped, "restarted");
    assert.ok(elapsed < BENCH_STOP_KILL_MS * 1.4, `killed on the first Stop's clock (${elapsed} ms), not re-armed by the second`);
    assert.equal(w.terminated, true);
    await sleep(50);
    assert.equal(resolved, 1, "the run resolves once");
});
