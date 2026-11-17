// pkg-install-offscreen.test.mjs — an install's candidate in the offscreen document: who may drive it (PY_INSTALL_TEST and PY_INSTALL_STOP), and that a candidate whose interpreter dies, runs out its deadline or is stopped ends as a failed install that leaves the run's own worker and its next install as they were. Run: node --import tsx --test tests/pkg-install-offscreen.test.mjs

// src/offscreen.ts imported for real under a mocked `chrome` and a fake `Worker` (the scaffolding of
// python-bench-stop-offscreen.test.mjs). Design: docs/plan/repl/PACKAGES_INSTALL.md, item 10, shape (v).
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
// The candidate's 60 s deadline is kept here, so a row fires it instead of waiting for it.
const realSetTimeout = globalThis.setTimeout;
const deadlines = [];
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) t.unref(); if (ms === 60_000) deadlines.push(fn); return t; };
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => { sentToWorker.push(m); return Promise.resolve(undefined); },
    },
};
await import("../src/offscreen.ts");

const SW = { id: "test" };   // the service worker's sender: our id, no tab
/** Deliver a runtime message to the document's listeners; resolves with its answer, or undefined when none came. */
const send = (msg, sender = SW) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = () => new Promise((r) => setTimeout(r, 0));

const TAB = { id: "test", tab: { id: 4 }, url: "https://evil.example/" };   // a content script: our id, but a tab
const OTHER = { id: "other-extension" };   // another extension: no tab, a foreign id
/** `send`, but a handler that took the message and never answers (the unguarded path) ends as "hung" rather than hanging the run. */
const sendOrHang = (msg, sender) => Promise.race([send(msg, sender), new Promise((r) => setTimeout(() => r("hung"), 300))]);
const TEST_MSG = { type: "PY_INSTALL_TEST", run: "r1", wheels: [], modules: ["x"] };

// --- who may drive an install's candidate (PACKAGES_INSTALL.md item 10, shape v) ---

for (const [name, sender] of [["a tab's sender", TAB], ["another extension", OTHER]]) {
    test(`PY_INSTALL_TEST from ${name} gets no answer and spawns no Worker`, async () => {
        const before = workers.length;
        assert.equal(await sendOrHang(TEST_MSG, sender), undefined);
        await tick();
        assert.equal(workers.length, before, "no candidate was started");
    });
    test(`PY_INSTALL_STOP from ${name} gets no answer`, async () => {
        assert.equal(await sendOrHang({ type: "PY_INSTALL_STOP", run: "r1" }, sender), undefined);
    });
}

test("positive control: the service worker's sender stops (nothing running) and starts a candidate", async () => {
    assert.deepEqual(await send({ type: "PY_INSTALL_STOP", run: "r1" }, SW), { ok: true, stopped: false });
    const before = workers.length;
    send(TEST_MSG, SW);   // not awaited: the fake worker never answers
    await tick();
    assert.ok(workers.length > before, "a Worker was spawned for the candidate");
    assert.ok(workers.at(-1).posts.length > 0, "and was handed work");
});

// --- a candidate that dies, runs out its deadline or is stopped (PACKAGES_INSTALL.md item 4: a failure changes nothing) ---

const SCAN_OK = JSON.stringify({ findings: [], reached: 1 });
const cellPosts = (w) => w.posts.filter((p) => typeof p.id === "number");
/** Start a candidate for `run`; resolves once its worker holds the scan cell. */
async function candidate(run) {
    const before = workers.length;
    const deadlinesBefore = deadlines.length;
    const answer = send({ type: "PY_INSTALL_TEST", run, wheels: [], modules: ["pkg"] });
    for (let i = 0; i < 20 && !(workers.length > before && cellPosts(workers.at(-1)).length); i++) await tick();
    const w = workers.at(-1);
    assert.ok(workers.length > before && cellPosts(w).length === 1, "the candidate's worker holds the scan cell");
    return { answer, w, deadline: deadlines[deadlinesBefore] };
}
/** Answer the candidate's current cell (the last one posted to `w`). */
const answerCell = async (w, result) => { w.reply({ id: cellPosts(w).at(-1).id, stdout: "", ...result }); for (let i = 0; i < 5; i++) await tick(); };
/** The worker the import cell went to, after the scan answered on `w`. */
const importWorker = (w) => (cellPosts(w).length === 2 ? w : workers.at(-1));
/** A run's own worker, with a cell in it: what a dying candidate must not touch. */
async function runWorker() {
    const before = workers.length;
    send({ type: "PY_RUN", code: "x = 1", hardened: true, tables: null });
    for (let i = 0; i < 5; i++) await tick();
    return workers.slice(before).find((x) => cellPosts(x).length);
}
const kills = () => sentToWorker.filter((m) => m.type === "HOUSEKEEPING_REPORT" && m.payload?.kind === "kill").map((m) => m.payload.key);

test("an interpreter that dies in the import is a failed install, the run's own worker is untouched, and the run's next install starts", async () => {
    const own = await runWorker();
    assert.ok(own, "the control: a run's worker holds a cell");
    const killsBefore = kills().length;
    const c = await candidate("dies");
    await answerCell(c.w, { ok: true, value: SCAN_OK });
    const imp = importWorker(c.w);
    imp.onerror({ message: "RuntimeError: function signature mismatch" });
    const r = await c.answer;
    assert.equal(r.ok, false);
    assert.equal(r.died, true);
    assert.match(r.error, /function signature mismatch/);
    assert.deepEqual(r.scan, { findings: [], reached: 1 }, "the scan read before the import still comes back");
    assert.equal(imp.terminated, true, "the candidate is gone");
    assert.equal(own.terminated, false, "the run's own worker is not");
    assert.ok(kills().slice(killsBefore).every((k) => k.startsWith("install:")), "and no kill names any principal but the candidate's");
    const next = await candidate("dies");
    await answerCell(next.w, { ok: true, value: SCAN_OK });
    await answerCell(importWorker(next.w), { ok: true, value: "null" });
    assert.equal((await next.answer).ok, true, "the run's next install is not refused as another install being tested");
});

test("an interpreter that dies in the scan leaves the import test to a fresh worker, and the install can still pass", async () => {
    const c = await candidate("scan-dies");
    c.w.onerror({ message: "RangeError: Maximum call stack size exceeded" });
    for (let i = 0; i < 10 && workers.at(-1) === c.w; i++) await tick();
    const fresh = workers.at(-1);
    assert.notEqual(fresh, c.w, "a fresh candidate worker was spawned");
    assert.equal(cellPosts(fresh).length, 1, "and it holds the import cell");
    await answerCell(fresh, { ok: true, value: "null" });
    assert.deepEqual(await c.answer, { ok: true, scan: null });
});

// A fatal Pyodide error is an ANSWER, and the worker lives on answering this to every later cell (python-lease-offscreen's
// kernel-death rows): the candidate must not hand its import to that worker.
const FATAL = "PythonError: Traceback (most recent call last):\n  File \"<exec>\", line 1, in <module>\nRangeError: Maximum call stack size exceeded";
const FATAL_LATER = "Pyodide already fatally failed and can no longer be used.";

test("a fatal error in the scan, which leaves its worker alive and unusable, hands the import to a fresh worker", async () => {
    const c = await candidate("scan-fatal");
    await answerCell(c.w, { ok: false, error: FATAL });
    const imp = importWorker(c.w);
    if (imp === c.w) await answerCell(c.w, { ok: false, error: FATAL_LATER });   // the unfixed path: the dead interpreter's answer
    assert.notEqual(imp, c.w, "the import went to a fresh worker");
    assert.equal(c.w.terminated, true, "the dead one is dropped");
    await answerCell(imp, { ok: true, value: "null" });
    assert.deepEqual(await c.answer, { ok: true, scan: null });
});

test("a fatal error in the import is a failed install that names it", async () => {
    const c = await candidate("import-fatal");
    await answerCell(c.w, { ok: true, value: SCAN_OK });
    const imp = importWorker(c.w);
    await answerCell(imp, { ok: false, error: FATAL });
    const r = await c.answer;
    assert.deepEqual([r.ok, r.died], [false, true]);
    assert.match(r.error, /Maximum call stack size exceeded/);
    assert.equal(imp.terminated, true);
});

for (const [name, end, reason] of [["the deadline", (c) => c.deadline(), "install-deadline"], ["Stop", (_c, run) => send({ type: "PY_INSTALL_STOP", run }), "stopped"]]) {
    test(`${name} in the import ends the candidate as a failed install`, async () => {
        const run = `end-import-${reason}`;
        const c = await candidate(run);
        assert.equal(typeof c.deadline, "function", "the control: the candidate armed its deadline");
        await answerCell(c.w, { ok: true, value: SCAN_OK });
        const imp = importWorker(c.w);
        await end(c, run);
        const r = await c.answer;
        assert.deepEqual([r.ok, r.died, r.error], [false, true, `Python worker stopped (${reason}).`]);
        assert.equal(imp.terminated, true);
    });

    test(`${name} in the scan ends the candidate: the import does not start in a fresh worker`, async () => {
        const run = `end-scan-${reason}`;
        const c = await candidate(run);
        const before = workers.length;
        await end(c, run);
        const r = await Promise.race([c.answer, new Promise((res) => setTimeout(() => res("hung"), 300))]);
        assert.notEqual(r, "hung", "the install answered");
        assert.deepEqual([r.ok, r.died, r.error], [false, true, `Python worker stopped (${reason}).`]);
        assert.equal(workers.length, before, "no worker was spawned for the import");
        assert.equal(c.w.terminated, true);
    });
}
