// python-reap.test.mjs — the offscreen document's clocks on a Python worker: the idle reap and the keep (py-reap.ts),
// and the cell's kill when it lands during the cancel's spend.

// The offscreen document (src/offscreen.ts) imported for real under a mocked `chrome`, a fake `Worker` and mocked
// timers, so the clocks are the shipped ones and minutes pass in a tick. The service worker's half (PY_REAPED into the
// run log, a keep reaching PY_RUN) is in python-run-namespace.test.mjs. The rules: docs/dev/python-sandbox.md, "The
// idle reap".
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { REAP_SETTLED_MS, REAP_LIVE_MS, DEFAULT_REAP_BETWEEN_MS, reapDelay } from "../src/python/py-reap.ts";

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
const { SPEND_KILLED, memoryKilled } = await import("../src/offscreen.ts");

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
/** Release a run's session: PY_DELETE_RUN, answered by the run's worker. */
async function release(run, w) {
    const done = send({ type: "PY_DELETE_RUN", run, principal: `run:${run}` });
    await settle();
    w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "" });
    return done;
}
/** End a turn: PY_END_TURN, which carries the between-turns delay (the setting, in ms) and asks no worker of its own. */
async function endTurn(run, ms = DEFAULT_REAP_BETWEEN_MS) {
    const answer = await send({ type: "PY_END_TURN", run, ms });
    await settle();
    return answer;
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
    await release("s1", w);
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
    await release("s2", w);
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
    await release("h1", w);
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
    await endTurn("k1");
    mock.timers.tick(DEFAULT_REAP_BETWEEN_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true, "the turn ended: the keep went with it, and the between-turns clock applies");
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
    await endTurn("k5");
    await turnCell("k5", { turnLive: true });
    mock.timers.tick(REAP_LIVE_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
});

// --- the run's namespace between turns (PY_END_TURN) ---

test("a turn's end leaves the run's own worker and namespace alone: no deleteRun, the next cell finds the same worker and no loss line", async () => {
    const { w } = await turnCell("e1", { turnLive: true });
    const posts = w.posts.length;
    await endTurn("e1");
    assert.equal(w.posts.length, posts, "the worker was told nothing");
    assert.equal(w.posts.some((m) => m.deleteRun), false);
    const { w: again, answer } = await turnCell("e1", { turnLive: true });
    assert.equal(again, w, "the same worker, so the names the earlier turn defined are still in its dict");
    assert.equal(answer.nsReset, undefined);
    assert.equal(w.posts.some((m) => m.deleteRun), false);
});

test("a turn's end drops the run's dict in the shared full worker, and only there", async () => {
    const { w: own } = await turnCell("e2", { turnLive: true });
    const { w: full } = await runCell({ principal: "full", hardened: false, wire: { client: "mlw-e2-full", run: "e2" } });
    assert.notEqual(own, full);
    await endTurn("e2");
    assert.equal(full.posts.at(-1).deleteRun, "e2", "the full worker was told to drop the run's dict");
    assert.equal(own.posts.some((m) => m.deleteRun), false, "the run's own worker was not");
    // The full worker holds no dict for the run any more: a kill of it now is no loss for the run.
    full.onerror({ message: "x" });
    const { answer } = await turnCell("e2", { turnLive: true });
    assert.equal(answer.nsReset, undefined);
});

test("a release (PY_DELETE_RUN) after a turn's end still drops the run's own worker's dict", async () => {
    const { w } = await turnCell("e3", { turnLive: true });
    await endTurn("e3");
    const done = send({ type: "PY_DELETE_RUN", run: "e3", principal: "run:e3" });
    await settle();
    assert.equal(w.posts.at(-1).deleteRun, "e3");
    w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "" });
    await done;
});

test("between turns the run's worker is shut after the delay the turn's end carried, not before", async () => {
    const { w } = await turnCell("e4", { turnLive: true });
    await endTurn("e4", 120_000);
    mock.timers.tick(119_999);
    await settle();
    assert.equal(w.terminated, false);
    assert.equal(w.posts.at(-1).takeDropped, undefined);
    mock.timers.tick(1);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
    assert.deepEqual(reapedOf("e4").map((m) => [m.live, m.between, m.idleMs]), [[true, true, 120_000]]);
    assert.equal(reapRecords("run:e4")[0].detail.between, true);
    const { w: again, answer } = await turnCell("e4", { turnLive: true });
    assert.notEqual(again, w);
    assert.match(answer.nsReset, /^namespace reset at \S+: idle between turns$/);
});

test("the default delay is ten minutes", async () => {
    assert.equal(DEFAULT_REAP_BETWEEN_MS, 10 * 60_000);
    const { w } = await turnCell("e5", { turnLive: true });
    await endTurn("e5");
    mock.timers.tick(10 * 60_000 - 1);
    await settle();
    assert.equal(w.terminated, false);
    mock.timers.tick(1);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
});

test("a delay of 0 never reaps a namespace between turns for idleness", async () => {
    const { w } = await turnCell("e6", { turnLive: true });
    await endTurn("e6", 0);
    mock.timers.tick(DAY);
    await settle();
    assert.equal(w.terminated, false);
});

test("the idle clock only runs while nothing of the principal is pending: a running cell between turns is never reaped", async () => {
    const { w } = await turnCell("e7", { turnLive: true });
    await endTurn("e7", 5000);
    const posted = w.posts.length;
    const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, principal: "run:e7", wire: { client: "mlw-e7-b", run: "e7" } });
    await settle();
    assert.equal(w.posts.length, posted + 1);
    mock.timers.tick(14_000);   // past the delay, inside the cell's own 15 s
    await settle();
    assert.equal(w.terminated, false, "the cell is still running");
    w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "" });
    await answer;
});

test("a keep from the turn that ended does not exempt the reap, and a keep arriving after the end arms nothing", async () => {
    const { w } = await turnCell("e8", { keep: true, turnLive: true });
    await endTurn("e8");
    mock.timers.tick(DEFAULT_REAP_BETWEEN_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true, "the keep went with its turn");
    // A cell of the ended turn landing late, keep and all (no turnLive: the service worker saw the turn gone).
    const { w: late } = await turnCell("e9", { turnLive: true });
    await endTurn("e9");
    await turnCell("e9", { keep: true });
    mock.timers.tick(DEFAULT_REAP_BETWEEN_MS);
    await settle();
    await answerReap(late);
    assert.equal(late.terminated, true, "the late keep armed nothing");
});

test("a cell of a live turn puts the run back on the live clock", async () => {
    const { w } = await turnCell("e10", { turnLive: true });
    await endTurn("e10");
    await turnCell("e10", { turnLive: true });
    mock.timers.tick(DEFAULT_REAP_BETWEEN_MS);
    await settle();
    assert.equal(w.terminated, false, "a live turn is on REAP_LIVE_MS, not the between-turns delay");
    mock.timers.tick(REAP_LIVE_MS - DEFAULT_REAP_BETWEEN_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true);
});

test("PY_END_TURN is the service worker's word only", async () => {
    const { w } = await turnCell("e11", { turnLive: true });
    const answered = await new Promise((resolve) => {
        let handled = false;
        for (const fn of listeners) { if (fn({ type: "PY_END_TURN", run: "e11", ms: 1000 }, { id: "test", tab: { id: 3 } }, resolve) === true) handled = true; }
        setImmediate(() => resolve(handled ? "handled" : "ignored"));
    });
    assert.equal(answered, "ignored");
    mock.timers.tick(1000);
    await settle();
    assert.equal(w.terminated, false, "a tab's message re-armed nothing");
});

// --- reapDelay: every combination ---

test("reapDelay: every principal kind x holdsRun x kept x betweenTurns", () => {
    const S = REAP_SETTLED_MS, L = REAP_LIVE_MS, B = DEFAULT_REAP_BETWEEN_MS;
    // [principal, holdsRun, kept, betweenTurns] -> delay; a hand-written table, not the rule again.
    const table = [
        ["run:r", false, false, false, S], ["run:r", false, false, true, S], ["run:r", false, true, false, S], ["run:r", false, true, true, S],
        ["run:r", true, false, false, L], ["run:r", true, false, true, B], ["run:r", true, true, false, null], ["run:r", true, true, true, B],
        ["page:7", false, false, false, S], ["page:7", false, false, true, S], ["page:7", false, true, false, S], ["page:7", false, true, true, S],
        ["page:7", true, false, false, S], ["page:7", true, false, true, S], ["page:7", true, true, false, S], ["page:7", true, true, true, S],
        ...["own", "full"].flatMap((p) => [false, true].flatMap((h) => [false, true].flatMap((k) => [false, true].map((b) => [p, h, k, b, null])))),
    ];
    assert.equal(table.length, 32);
    for (const [p, h, k, b, want] of table) assert.equal(reapDelay(p, h, k, b), want, `${p} holds=${h} kept=${k} between=${b}`);
    // The default for the fourth argument is "the turn is live", and the delay's default is ten minutes.
    assert.equal(reapDelay("run:r", true, false), L);
    assert.equal(reapDelay("run:r", true, true), null);
    assert.equal(reapDelay("run:r", true, false, true), 10 * 60_000);
    assert.equal(reapDelay("run:r", true, false, true, 90_000), 90_000);
    assert.equal(reapDelay("run:r", true, false, true, 0), null, "0 is never");
});

// --- the kill during the cancel's spend (the never-yield bound's last path) ---
// A task the cell left that will not stop inside a C function is beyond the spend's bound; the 15 s kill ends it. The
// worker marks the spend's start (`spending`), so the kill names the leftover task instead of the cell's computation.

/** Post a cell, let it start, and optionally mark its spend; resolves with the worker and the pending answer. */
async function startedCell(principal, { spending }) {
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, principal });
    await settle();
    const w = workers.find((x) => x.posts.length > (posted.get(x) ?? 0));
    const id = w.posts.at(-1).id;
    w.reply({ id, started: true });
    if (spending) w.reply({ id, spending: true });
    await settle();
    return { w, answer };
}

test("a kill during the spend names the task the cell left, not the cell's computation", async () => {
    const { w, answer } = await startedCell("page:21", { spending: true });
    mock.timers.tick(15000);
    await settle();
    const r = await answer;
    assert.equal(r.ok, false);
    assert.equal(r.error, SPEND_KILLED);
    assert.equal(w.terminated, true);
});

test("control: a kill with no spending mark still blames the computation", async () => {
    const { w, answer } = await startedCell("page:22", { spending: false });
    mock.timers.tick(15000);
    await settle();
    const r = await answer;
    assert.match(r.error, /exceeded 15s and was terminated — simplify the computation/);
    assert.equal(w.terminated, true);
});

// --- a worker that dies of memory ---
// A heavier callback per entry in a flood can reach the heap limit before the 15 s kill (PYTHON_CANCEL_GAPS.md, pin 15):
// the worker's own error then reaches the offscreen, and the run names memory as the cause, and the spend when it was in it.

const WASM_OOM = "RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded";

test("a worker that dies of memory during the spend names memory and the spend", async () => {
    const { w, answer } = await startedCell("page:31", { spending: true });
    w.onerror({ message: WASM_OOM });
    const r = await answer;
    assert.equal(r.ok, false);
    assert.equal(r.error, memoryKilled(WASM_OOM, true));
    assert.match(r.error, /ran out of memory while the cancel was spending what this cell left/);
    assert.equal(w.terminated, true);
});

test("a worker that dies of memory in the cell's own code names memory, not the spend", async () => {
    const { w, answer } = await startedCell("page:32", { spending: false });
    w.onerror({ message: "Uncaught RangeError: Array buffer allocation failed" });
    const r = await answer;
    assert.match(r.error, /^The Python sandbox ran out of memory, so it was stopped/);
    assert.doesNotMatch(r.error, /spending/);
});

test("control: any other worker death keeps its own message, with no memory named", async () => {
    const { w, answer } = await startedCell("page:33", { spending: true });
    w.onerror({ message: "Uncaught TypeError: x is not a function" });
    const r = await answer;
    assert.equal(r.error, "Python worker stopped (Uncaught TypeError: x is not a function).");
});
