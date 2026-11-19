// redteam-pkg-candidate-end.test.mjs — an install's CANDIDATE (window-ml#1934, feat/pkg-scan at 88fa005f): the
// deadline and Stop are meant to end the WHOLE candidate, and a scan that failed must never hand the import to the
// interpreter it failed in. The lane's rows (tests/pkg-install-offscreen.test.mjs) end the candidate in the scan cell
// and in the import cell; these probe the routes they do not: the Stop that lands BEFORE the candidate registers, and
// the end that lands inside a MIRROR READ — the window janitor-2 found at 740f6355, closed by 536779e6 (`ended()`
// after each read) and 88fa005f (`runInWorker` refuses an ended principal) — plus a scan that fails for an ordinary
// reason, where the lane's row uses a fatal one. Real src/offscreen.ts under a mocked chrome, a fake Worker, and a
// fake IndexedDB whose reads the row answers by hand.
import { test } from "node:test";
import assert from "node:assert/strict";

// --- a fake chrome, Worker and package mirror around the real offscreen document ---

const listeners = [];
const workers = [];   // every Worker the document spawned, in order
class FakeWorker {
    constructor(url, opts) { this.url = url; this.name = opts?.name; this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    /** Play the worker's reply to the document. */
    reply(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
// The idle reap arms a clock of minutes on every idle worker, and the candidate a 60 s deadline: neither may hold this
// process open, and a row fires the deadline instead of waiting for it.
const realSetTimeout = globalThis.setTimeout;
const deadlines = [];
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) t.unref(); if (ms === 60_000) deadlines.push(fn); return t; };

// The mirror. IndexedDB is absent in this realm, so `mirroredWheel` resolves undefined at once and a candidate reading
// its wheels is inside no window at all. This fake holds each read until the row fires it, which is what a real wheel's
// read from the mirror costs — and the window a Stop or the deadline has to be checked across.
const reads = [];
globalThis.indexedDB = {
    open: () => {
        const req = {};
        realSetTimeout(() => {
            req.result = { transaction: () => ({ objectStore: () => ({ get: (key) => { const r = { key, done: false }; reads.push(r); return r; } }) }) };
            req.onsuccess?.();
        }, 0);
        return req;
    },
};
const pendingRead = () => reads.filter((x) => !x.done).length;
/** Answer the oldest unanswered mirror read with the wheel the candidate asked for. */
const fireRead = (row) => { const r = reads.find((x) => !x.done); assert.ok(r, "no mirror read was pending"); r.done = true; r.result = row; r.onsuccess?.(); return r; };

const WBYTES = new TextEncoder().encode("PK\u0003\u0004 a wheel, resident in the mirror");
const WSHA = [...new Uint8Array(await crypto.subtle.digest("SHA-256", WBYTES))].map((b) => b.toString(16).padStart(2, "0")).join("");
const WHEEL = { filename: "pkg-1.0-py3-none-any.whl", sha256: WSHA };
const WROW = { sha256: WSHA, bytes: new Blob([WBYTES]) };

globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: () => Promise.resolve(undefined),
    },
};
await import("../src/offscreen.ts");

const SW = { id: "test" };   // the service worker's sender: our id, no tab
const send = (msg, sender = SW) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = () => new Promise((r) => realSetTimeout(r, 0));
/** Wait for `cond`, failing with `what` when it never holds. */
async function until(cond, what) { for (let i = 0; i < 60; i++) { if (cond()) return; await tick(); } assert.ok(cond(), `waited for ${what}`); }
const cellPosts = (w) => w.posts.filter((p) => typeof p.id === "number");
/** Answer the worker's current cell (the last one posted to it). */
const answerCell = async (w, result) => { w.reply({ id: cellPosts(w).at(-1).id, stdout: "", ...result }); for (let i = 0; i < 5; i++) await tick(); };
/** Start a candidate for `run`; resolves once its worker exists, with the deadline the document armed. */
async function candidate(run, wheels = []) {
    const before = workers.length;
    const deadlinesBefore = deadlines.length;
    const answer = send({ type: "PY_INSTALL_TEST", run, wheels, modules: ["pkg"] });
    await until(() => workers.length > before, "the candidate's worker");
    return { answer, w: workers.at(-1), deadline: () => deadlines[deadlinesBefore]() };
}
const SCAN_OK = JSON.stringify({ findings: [], reached: 1 });
/** The answer, or "hung": a candidate that posted a later cell and ran on never answers the row. */
const answered = (p) => Promise.race([p, new Promise((res) => realSetTimeout(() => res("hung"), 500))]);

// --- the Stop that lands before the candidate registers ---

// The service worker's tester arms its abort listener and THEN sends PY_INSTALL_TEST (sw-pkg-install.ts
// `offscreenTester`). A Stop that lands in that gap — the offscreen document is being created, the message is in
// flight — reaches this document first, finds no candidate, and answers `stopped: false`; the TEST then starts one
// anyway. The import the person stopped runs a whole Pyodide boot and the package's code, bounded only by the 60 s
// deadline, and only its ANSWER is thrown away (`installApproved` reads `stop.aborted` after it). Whether this
// document remembers a stopped run or the service worker refuses to send the TEST, nothing should start here.
test("RED TEAM: a Stop that lands before the candidate registers starts no candidate", async () => {
    const before = workers.length;
    assert.deepEqual(await send({ type: "PY_INSTALL_STOP", run: "pre-stop" }), { ok: true, stopped: false }, "the control: the Stop reached the candidate handler and found nothing to stop");
    void send({ type: "PY_INSTALL_TEST", run: "pre-stop", wheels: [], modules: ["pkg"] });
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(workers.length, before, "a candidate was spawned for a run whose Stop had already arrived");
});

// --- the end that lands inside a mirror read ---

// A candidate reads every wheel from the mirror twice, once for the scan cell and once for the import cell, and each
// read is an IndexedDB fetch of the whole file: the widest window between two cells. At 740f6355 the end was checked
// once, after the scan, so an end inside a read killed the worker and the next cell spawned a fresh one whose import
// cell has no timer of its own (`noTimeout`). Each of the four rows below was red at 740f6355 and holds at 88fa005f.
for (const [name, end, reason] of [
    ["the deadline", (c) => c.deadline(), "install-deadline"],
    ["Stop", (_c, run) => send({ type: "PY_INSTALL_STOP", run }), "stopped"],
]) {
    test(`RED TEAM: ${name} inside the candidate's first mirror read posts no cell at all`, async () => {
        const run = `read1-${reason}`;
        const c = await candidate(run, [WHEEL]);
        await until(() => pendingRead() === 1, "the candidate's first mirror read");
        assert.equal(cellPosts(c.w).length, 0, "the control: the scan cell waits for the wheel");
        const before = workers.length;
        await end(c, run);
        fireRead(WROW);
        for (let i = 0; i < 5; i++) await tick();
        assert.equal(cellPosts(c.w).length, 0, "the scan cell was posted after the candidate had ended");
        assert.equal(workers.length, before, "a worker was spawned after the candidate had ended");
        assert.equal(c.w.terminated, true, "the candidate's worker was left alive");
        const r = await answered(c.answer);
        assert.notEqual(r, "hung", "the candidate never answered after it had ended");
        assert.deepEqual([r.ok, r.died, r.error], [false, true, `Python worker stopped (${reason}).`]);
    });

    test(`RED TEAM: ${name} inside the candidate's second mirror read posts no import cell`, async () => {
        const run = `read2-${reason}`;
        const c = await candidate(run, [WHEEL]);
        await until(() => pendingRead() === 1, "the first mirror read");
        fireRead(WROW);
        await until(() => cellPosts(c.w).length === 1, "the scan cell");
        await answerCell(c.w, { ok: true, value: SCAN_OK });
        await until(() => pendingRead() === 1, "the second mirror read");
        const before = workers.length;
        await end(c, run);
        fireRead(WROW);
        for (let i = 0; i < 5; i++) await tick();
        assert.equal(cellPosts(c.w).length, 1, "the import cell was posted after the candidate had ended");
        assert.equal(workers.length, before, "a fresh worker was spawned for the import after the candidate had ended");
        const r = await answered(c.answer);
        assert.notEqual(r, "hung", "the candidate never answered after it had ended");
        assert.deepEqual([r.ok, r.died, r.error], [false, true, `Python worker stopped (${reason}).`]);
    });
}

// --- a scan whose interpreter failed is never the one the import runs in ---

// The lane's row for this uses a FATAL error, which leaves the worker alive answering "already fatally failed". An
// ordinary error is the same branch (`!s.ok`): the candidate must drop that interpreter whatever the reason, or the
// import is tested in one a failed cell already ran in.
test("RED TEAM: a scan that fails for an ordinary reason drops its worker, and the import goes to a fresh one", async () => {
    const c = await candidate("scan-ordinary");
    await until(() => cellPosts(c.w).length === 1, "the scan cell");
    await answerCell(c.w, { ok: false, error: "NameError: name 'click' is not defined" });
    await until(() => workers.at(-1) !== c.w, "a fresh worker for the import");
    const fresh = workers.at(-1);
    assert.equal(c.w.terminated, true, "the interpreter the scan failed in was kept and reused");
    assert.equal(cellPosts(fresh).length, 1, "the import cell went to the fresh worker");
    await answerCell(fresh, { ok: true, value: "null" });
    assert.deepEqual(await c.answer, { ok: true, scan: null });
});
