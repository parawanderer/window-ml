// python-reap.test.mjs — the idle reap and the keep (py-reap.ts): when the offscreen document shuts a Python worker.

// The offscreen document (src/offscreen.ts) imported for real under a mocked `chrome`, a fake `Worker` and mocked
// timers, so the clocks are the shipped ones and minutes pass in a tick. The service worker's half (PY_REAPED into the
// run log, a keep reaching PY_RUN) is in python-run-namespace.test.mjs. The rules: docs/dev/python-sandbox.md, "The
// idle reap".
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { REAP_SETTLED_MS, REAP_LIVE_MS } from "../src/python/py-reap.ts";

mock.timers.enable({ apis: ["setTimeout"] });

const listeners = [];
const sent = [];   // chrome.runtime.sendMessage payloads (the offscreen document talking to the service worker)
const workers = [];
class FakeWorker {
    constructor() { this.posts = []; this.terminated = false; workers.push(this); }
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
        sendMessage: (m) => { sent.push(m); return Promise.resolve(undefined); },
    },
};
await import("../src/offscreen.ts");

const send = (msg) => new Promise((resolve) => {
    for (const fn of listeners) { if (fn(msg, { id: "test" }, resolve) === true) return; }
    resolve(undefined);
});
/** Let promises and posted replies settle; never a timer, which is mocked. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const DAY = 24 * 60 * 60_000;

/** Run one cell on a principal and answer it; resolves with the worker and the document's answer. */
async function runCell(msg, result = {}) {
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, ...msg });
    await settle();
    const w = workers.find((x) => x.posts.length > (posted.get(x) ?? 0));
    w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "", ...result });
    return { w, answer: await answer };
}
/** A turn's cell on its own worker. */
const turnCell = (run, extra = {}) => runCell({ principal: `run:${run}`, wire: { client: `mlw-${run}-${workers.length}`, run }, ...extra });
/** End a turn: PY_DELETE_RUN, answered by the run's worker. */
async function endTurn(run, w) {
    const done = send({ type: "PY_DELETE_RUN", run, principal: `run:${run}` });
    await settle();
    w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "" });
    return done;
}
/** The reap's ask, if it was posted to `w`, answered with `dropped`; then the reap finishes. */
async function answerReap(w, dropped) {
    const ask = w.posts.at(-1);
    assert.equal(ask?.takeDropped, true, "the reap asked the worker for its late drops");
    w.reply({ id: ask.id, ok: true, stdout: "", ...(dropped ? { dropped } : {}) });
    await settle();
}
const reapedOf = (run) => sent.filter((m) => m.type === "PY_REAPED" && m.run === run);
const reapRecords = (key) => sent.filter((m) => m.type === "HOUSEKEEPING_REPORT" && m.payload.kind === "reap" && m.payload.key === key).map((m) => m.payload);

// --- the idle clock ---

test("a settled turn's worker is shut after REAP_SETTLED_MS idle, not before, and hands over its late drops", async () => {
    const { w } = await turnCell("s1");
    await endTurn("s1", w);
    mock.timers.tick(REAP_SETTLED_MS - 1);
    await settle();
    assert.equal(w.terminated, false, "not before its time");
    assert.equal(w.posts.at(-1).takeDropped, undefined);
    mock.timers.tick(1);
    await settle();
    await answerReap(w, { count: 2, afterCell: 3 });
    assert.equal(w.terminated, true);
    assert.deepEqual(reapedOf("s1").map(({ live, dropped }) => ({ live, dropped })), [{ live: false, dropped: { count: 2, afterCell: 3 } }]);
    assert.deepEqual(reapRecords("run:s1").map((r) => [r.subsystem, r.ms, r.detail.live]), [["pyodide", REAP_SETTLED_MS, false]]);
});

test("a settled turn's worker with no late drops is shut without telling the run", async () => {
    const { w } = await turnCell("s2");
    await endTurn("s2", w);
    mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
    assert.deepEqual(reapedOf("s2"), [], "nothing for the run's log: no namespace lost, nothing dropped");
});

test("a live turn's worker is shut after REAP_LIVE_MS idle, and the run's next cell is told its namespace went", async () => {
    const { w } = await turnCell("l1");
    mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    assert.equal(w.terminated, false, "control: a live turn's worker outlasts a settled one's clock");
    mock.timers.tick(REAP_LIVE_MS - REAP_SETTLED_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
    assert.deepEqual(reapedOf("l1").map((m) => m.live), [true]);
    const { w: again, answer } = await turnCell("l1");
    assert.notEqual(again, w, "the next cell starts a new worker");
    assert.match(answer.nsReset, /^namespace reset at \S+: idle \(python_exec keep: true holds it through long waits\)$/);
});

test("a cell restarts the clock: a worker used just before its time is not shut until it has sat idle again", async () => {
    // No cell runs long enough to meet the clock (a cell has 15 s, PY_TIMEOUT_MS); what matters is that a post stops it.
    const { w } = await turnCell("b1");
    mock.timers.tick(REAP_LIVE_MS - 1000);
    await settle();
    await turnCell("b1");
    mock.timers.tick(REAP_LIVE_MS - 1);
    await settle();
    assert.equal(w.terminated, false, "the clock restarted at the cell's answer");
    assert.equal(w.posts.at(-1).takeDropped, undefined);
    mock.timers.tick(1);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
});

test("a worker that never answers the reap's ask is terminated anyway", async () => {
    const { w } = await turnCell("h1");
    await endTurn("h1", w);
    mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    assert.equal(w.posts.at(-1).takeDropped, true);
    mock.timers.tick(2000);
    await settle();
    assert.equal(w.terminated, true);
});

test("a page's stateless worker is reaped on the settled clock; the bench's own worker never is", async () => {
    const { w: page } = await runCell({ principal: "page:7" });
    const { w: own } = await runCell({ principal: "own" });
    mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    await answerReap(page);
    assert.equal(page.terminated, true);
    assert.deepEqual(reapedOf("7"), [], "a page is no run");
    mock.timers.tick(DAY);
    await settle();
    assert.equal(own.terminated, false, "the bench keeps a person's variables");
    assert.equal(own.posts.at(-1).takeDropped, undefined);
});

// --- the keep ---

test("a kept turn's worker is never shut while the turn lives; the keep ends with the turn", async () => {
    const { w } = await turnCell("k1", { keep: true });
    mock.timers.tick(DAY);
    await settle();
    assert.equal(w.terminated, false, "a day idle, kept");
    assert.equal(w.posts.at(-1).takeDropped, undefined);
    await endTurn("k1", w);
    mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true, "the turn ended: the settled clock applies");
});

test("a keep holds for the turn's later cells that do not repeat it", async () => {
    const { w } = await turnCell("k2", { keep: true });
    await turnCell("k2");
    mock.timers.tick(DAY);
    await settle();
    assert.equal(w.terminated, false);
});

test("a keep is a worker-hosted turn's: on a page's principal, or naming another run's worker, it keeps nothing", async () => {
    const { w: page } = await runCell({ principal: "page:8", keep: true });
    const { w: other } = await runCell({ principal: "run:k3", wire: { client: "mlw-k3", run: "k4" }, keep: true });
    mock.timers.tick(REAP_LIVE_MS);
    await settle();
    await answerReap(page);
    await answerReap(other);
    assert.equal(page.terminated, true);
    assert.equal(other.terminated, true);
});

test("a kept turn whose next turn keeps nothing is reaped on the live clock", async () => {
    const { w } = await turnCell("k5", { keep: true });
    await endTurn("k5", w);
    await turnCell("k5");
    mock.timers.tick(REAP_LIVE_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
});
