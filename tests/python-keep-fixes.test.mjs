// python-keep-fixes.test.mjs — the six fixes to `python_exec keep: true` that tests/redteam-python-keep.test.mjs found (py-reap.ts;
// docs/dev/python-sandbox.md, "The idle reap"), pinned from the fix's side: what a RESUMED turn still gets, which sender may
// arm or end a keep, the page branch of `reapDelay`, and a cell that starts and ends inside the reap's handover ask. The
// red-team rows assert the denials; these pin the positive controls the denials must not break.

// The offscreen document under a mocked `chrome` and a fake `Worker`, as redteam-python-keep.test.mjs does (clocks mocked per test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REAP_SETTLED_MS, REAP_LIVE_MS, reapDelay } from "../src/python/py-reap.ts";

// --- a fake chrome and Worker around the real offscreen document ---

const listeners = [];
const sent = [];   // chrome.runtime.sendMessage payloads (the offscreen document talking to the service worker)
const workers = [];
class FakeWorker {
    constructor() { this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    /** Play the worker's reply to the document. */
    reply(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) t.unref(); return t; };
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => { sent.push(m); return Promise.resolve(undefined); },
    },
};
await import("../src/offscreen.ts");

const SW = { id: "test" };   // the service worker's sender shape: our own document, no tab
const TAB = { id: "test", tab: { id: 9, url: "https://evil.example/" } };   // a content script is an extension context too
const DAY = 24 * 60 * 60_000;

/** Deliver a runtime message to the document's listeners, as the service worker would (or a tab — the rows that name
 *  one); resolves with its answer. */
const send = (msg, sender = SW) => new Promise((resolve) => {
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) return; }
    resolve(undefined);
});
/** Let promises and posted replies settle; never a timer. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** Run one cell on a principal and answer it; resolves with the worker and the document's answer. */
async function runCell(msg, reply = {}, sender = SW) {
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, ...msg }, sender);
    await settle();
    const w = workers.find((x) => x.posts.length > (posted.get(x) ?? 0));
    w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "", ...reply });
    return { w, answer: await answer };
}
/** A turn's cell on its own worker (the wire the service worker stamps: run = the cell's own run). */
const turnCell = (run, extra = {}) => runCell({ principal: `run:${run}`, wire: { client: `mlw-${run}-${workers.length}`, run }, ...extra });
/** Post a cell and let it start (the 15 s script cap arms) WITHOUT answering it; resolves with the worker and its id. */
async function startedCell(msg) {
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, ...msg });
    await settle();
    const w = workers.find((x) => x.posts.length > (posted.get(x) ?? 0));
    const id = w.posts.at(-1).id;
    w.reply({ id, started: true });
    await settle();
    return { w, id, answer };
}
/** End a turn: PY_DELETE_RUN, answered by the run's worker. */
async function endTurn(run, w) {
    const done = send({ type: "PY_DELETE_RUN", run, principal: `run:${run}` });
    await settle();
    w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "" });
    return done;
}
/** The reap's ask, if it was posted to `w`, answered; then the reap finishes. */
async function answerReap(w, dropped) {
    const ask = w.posts.at(-1);
    assert.equal(ask?.takeDropped, true, "the reap asked the worker for its late drops");
    w.reply({ id: ask.id, ok: true, stdout: "", ...(dropped ? { dropped } : {}) });
    await settle();
}
/** After a tick that may have started a reap: answer its handover ask if one waits, so the reap finishes whether or
 *  not the mock clock ran its 2 s (REAP_ANSWER_MS) inside the same tick. Without this a reap stuck mid-ask looks
 *  like a worker that survived. */
async function drainReap(w) {
    if (w.posts.at(-1)?.takeDropped === true) await answerReap(w);
}


// --- a keep is a LIVE turn's, and a resumed turn of the same run id is live again ---

test("a resumed turn re-opens the gate: a keep stamped turnLive after the previous turn's end holds its worker", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = await turnCell("f1", { keep: true, turnLive: true });
    await endTurn("f1", first.w);
    const late = await turnCell("f1", { keep: true });   // the ended turn's late cell: no turnLive
    t.mock.timers.tick(DAY);
    await settle();
    await drainReap(late.w);
    assert.equal(late.w.terminated, true, "control: without the live stamp the ended turn's keep arms nothing");
    await endTurn("f1", late.w).catch(() => {});
    const resumed = await turnCell("f1", { keep: true, turnLive: true });
    t.mock.timers.tick(DAY);
    await settle();
    assert.equal(resumed.w.terminated, false, "the resumed turn (the service worker saw its run live) keeps its worker");
});

test("turnLive is the service worker's word only: a tab-context cell carrying it arms nothing", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { w } = await runCell({ principal: "run:f2", wire: { client: "mlw-f2", run: "f2" }, keep: true, turnLive: true }, {}, TAB);
    t.mock.timers.tick(REAP_LIVE_MS);
    await settle();
    await drainReap(w);
    assert.equal(w.terminated, true);
});

test("a tab-context PY_DELETE_RUN is unanswered, and the ended-run record is the service worker's alone", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { w } = await turnCell("f3", { keep: true });
    assert.equal(await send({ type: "PY_DELETE_RUN", run: "f3", principal: "run:f3" }, TAB), undefined, "no listener answers a tab");
    // f3 was never marked ended, so a keep without the live stamp still arms: the forged delete left no trace.
    const again = await turnCell("f3", { keep: true });
    t.mock.timers.tick(DAY);
    await settle();
    assert.equal(again.w.terminated, false);
    assert.equal(w.terminated, false);
});

// --- reapDelay's page branch ---

test("reapDelay: a page principal is on the settled clock for every flag pair (enumerated)", () => {
    for (const holdsRun of [false, true]) for (const kept of [false, true]) {
        assert.equal(reapDelay("page:7", holdsRun, kept), REAP_SETTLED_MS, `holdsRun=${holdsRun} kept=${kept}`);
    }
    assert.equal(reapDelay("run:r", true, true), null, "control: a run's kept worker is still never reaped");
    assert.equal(reapDelay("run:r", true, false), REAP_LIVE_MS, "control: a run's live worker is on the live clock");
});

// --- the reap's handover ask ---

test("a cell that starts and finishes inside the reap's ask stops the reap; a reap with no use inside it still shuts", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const quiet = await turnCell("g1");
    await endTurn("g1", quiet.w);
    t.mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    await answerReap(quiet.w);
    assert.equal(quiet.w.terminated, true, "control: nothing used the worker inside the window");
    const busy = await turnCell("g2");
    await endTurn("g2", busy.w);
    t.mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    const ask = busy.w.posts.at(-1);
    assert.equal(ask.takeDropped, true);
    const cell = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, principal: "run:g2", wire: { client: "mlw-g2-x", run: "g2" } });
    await settle();
    busy.w.reply({ id: busy.w.posts.at(-1).id, ok: true, stdout: "" });   // the cell finishes inside the window
    await cell;
    busy.w.reply({ id: ask.id, ok: true, stdout: "" });   // then the ask answers
    await settle();
    assert.equal(busy.w.terminated, false, "the worker served a cell during the ask: it was not idle");
});

// --- the service worker's half ---

test("a keep leaves the service worker stamped turnLive, and a call without keep carries neither", { timeout: 30000 }, async () => {
    const { wireRun } = await import("./ml-wire-harness.mjs");
    const calls = [
        { name: "python_exec", args: { code: "x = 1", keep: true } },
        { name: "python_exec", args: { code: "x" } },
    ];
    const { pyRuns } = await wireRun(async () => {}, { calls });
    assert.deepEqual(pyRuns.map((m) => [m.keep ?? null, m.turnLive ?? null]), [[true, true], [null, null]]);
});

// --- what the keep promises ---

test("every copy of the keep's promise names the kill clause: the tool description and the contract's JSDoc", async () => {
    const { buildPythonTool } = await import("../src/python/python-tool.ts");
    const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
    const tool = buildPythonTool({ defineTool, _queryAll: () => [], pythonExec: async () => ({ ok: true, stdout: "" }), _mintToken: async () => "@pt:abcdef12" });
    assert.match(tool.parameters.properties.keep.description, /until this run ends or its sandbox is killed \(a timeout, a crash, a cancel\), which the next cell is told as loss/);
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(new URL("../src/contract.ts", import.meta.url), "utf8"), /until its turn ends or its sandbox is killed \(a timeout, a crash, a cancel\), which the next cell is told as loss/);
});
