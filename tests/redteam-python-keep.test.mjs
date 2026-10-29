// redteam-python-keep.test.mjs — the red-team pass on `python_exec keep: true` (py-reap.ts; docs/dev/python-sandbox.md,
// "The idle reap"): (a) the keep's SCOPE and what it is not, (b) what ENDS it, (c) what a page or the model cannot get
// through it, (d) the idle clock it rides. The defence's own rows (tests/python-reap.test.mjs, tests/python-run-
// namespace.test.mjs) pin the happy path; these are the adversarial shapes around it — a keep forged at the message, a
// keep outliving its turn, a keep from a tab context. A row asserting the DEFENDED outcome that fails on main lands as
// a todo naming the gap and its owner; every row carries its positive control in the same test, so a harness that
// never delivered the message cannot pass it.

// The offscreen document (src/offscreen.ts) imported for real under a mocked `chrome` and a fake `Worker`, as
// python-reap.test.mjs does; its clocks are mocked PER TEST (node:test's `t.mock.timers`) so the service-worker half
// (tests/helpers.js `loadBackground`, real timers) can live in the same file. Long timers are unref'd so a kept worker
// left alive at a test's end never holds the process open (python-run-namespace.test.mjs's trick).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { REAP_SETTLED_MS, REAP_LIVE_MS, reapDelay } from "../src/python/py-reap.ts";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

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

// --- (a) the keep's scope: what it covers, and what it does not ---

test("a keep is armed only on a worker-hosted run's own worker: every forged shape keeps nothing (enumerated)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const honest = await turnCell("a0", { keep: true });   // positive control: the one shape that keeps
    const shapes = [
        ["no wire at all", { principal: "run:a1", keep: true }],
        ["a wire with no run", { principal: "run:a2", keep: true, wire: { client: "mlw-a2", run: null } }],
        ["a wire with no client", { principal: "run:a3", keep: true, wire: { run: "a3" } }],
        ["a wire naming another run", { principal: "run:a4", keep: true, wire: { client: "mlw-a4", run: "other" } }],
        ["a page's principal under a run's wire", { principal: "page:9", keep: true, wire: { client: "mlw-a5", run: "a5" } }],
    ];
    const forged = [];
    for (const [, msg] of shapes) forged.push(await runCell(msg));
    const own = await runCell({ principal: "own", keep: true });   // the default: the bench's own is never reaped
    t.mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    for (const [i, [name]] of shapes.entries()) {
        await answerReap(forged[i].w);
        assert.equal(forged[i].w.terminated, true, `${name}: a keep needs a wire naming the cell's own run`);
    }
    t.mock.timers.tick(DAY);
    await settle();
    assert.equal(own.w.terminated, false, "the bench keeps a person's variables whatever a cell claims");
    assert.equal(own.w.posts.at(-1).takeDropped, undefined);
    assert.equal(honest.w.terminated, false, "control: the honest shape (wire.run = its own run) survives a day idle");
    assert.equal(honest.w.posts.at(-1).takeDropped, undefined);
});

test("a keep is not a noTimeout: a kept worker's cell is killed at the cell cap like any other", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { w, answer } = await startedCell({ principal: "run:a6", wire: { client: "mlw-a6", run: "a6" }, keep: true });
    t.mock.timers.tick(15000);
    await settle();
    const r = await answer;
    assert.equal(w.terminated, true, "the cap ends the worker (the same kill python-reap.test.mjs pins for plain cells)");
    assert.match(r.error, /exceeded 15s and was terminated/);
});

test("a keep covers its own worker only: the other run's worker is reaped on its clock while the kept one lives", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const kept = await turnCell("a7", { keep: true });
    const other = await turnCell("a8");
    t.mock.timers.tick(REAP_LIVE_MS);
    await settle();
    await answerReap(other.w);
    assert.equal(other.w.terminated, true, "the unkept run's worker is on the live clock");
    assert.equal(kept.w.terminated, false, "one run's keep keeps one worker");
    assert.equal(kept.w.posts.at(-1).takeDropped, undefined);
});

// --- (b) what ends the keep ---

test("a keep never outlives its turn: a keep-bearing cell arriving after the turn ended arms nothing", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { w } = await turnCell("b1", { keep: true });
    t.mock.timers.tick(DAY);
    await settle();
    assert.equal(w.terminated, false, "control: the live turn's keep holds its worker through a day idle");
    await endTurn("b1", w);
    // The retry path's shape (sw-python.ts re-posts after forgetOffscreen; its awaits can also cross settle): a cell
    // of the ENDED turn, keep and all, landing after PY_DELETE_RUN.
    await turnCell("b1", { keep: true });
    t.mock.timers.tick(DAY);
    await settle();
    await drainReap(w);
    assert.equal(w.terminated, true, "the keep is a live turn's: nothing re-arms it after the turn ended");
});

test("the turn's end lands mid-cell: the keep dies with the turn even while the cell runs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { w, id } = await startedCell({ principal: "run:b2", wire: { client: "mlw-b2", run: "b2" }, keep: true });
    await endTurn("b2", w);   // PY_DELETE_RUN while the cell is still running
    w.reply({ id, ok: true, stdout: "" });   // the cell answers anyway
    await settle();
    t.mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    await answerReap(w);
    assert.equal(w.terminated, true, "the keep ended with the turn: the settled clock applies even mid-cell");
});

test("a kill ends the keep and the next cell is told as loss: the keep shields the idle reap only", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // The ruled promise (python-tool.ts): "Keep your names through idle gaps over 30 min (a run that waits hours
    // between calls) until this run ends or its sandbox is killed (a timeout, a crash, a cancel), which the next cell
    // is told as loss." The keep exists against the idle reap, not against loss — a kill has already lost the
    // namespace — and nothing arms it again without a NEW keep: true (the turn is still live here: no PY_DELETE_RUN).
    // The replies carry the run's scope manifest (python-run-namespace.test.mjs's shape) as REALISM only — it is not
    // load-bearing: the kill's loss note is written at killWorker whatever a reply carries (nsLoss, offscreen.ts), and
    // the only reader of result.bench is the state registry's inspector. What guards this half against a vacuous pass
    // is the nsReset match itself: a telling that stopped comes back "" and fails loud.
    const bench = { bench: { id: "run-b3", vars: [{ name: "x", type: "int" }] } };
    const first = await runCell({ principal: "run:b3", wire: { client: "mlw-b3-1", run: "b3" }, keep: true }, bench);
    t.mock.timers.tick(DAY);
    await settle();
    assert.equal(first.w.terminated, false, "control: the keep holds its worker through a day idle (the promise's first half)");
    await startedCell({ principal: "run:b3", wire: { client: "mlw-b3-2", run: "b3" }, keep: true });   // a cell that never answers
    t.mock.timers.tick(15000);   // the cell cap kills the sandbox mid-turn (a timeout)
    await settle();
    assert.equal(first.w.terminated, true, "the kill landed");
    const second = await runCell({ principal: "run:b3", wire: { client: "mlw-b3-3", run: "b3" } }, { ...bench, stdout: "two" });
    assert.match(second.answer.nsReset ?? "", /^namespace reset at .*: timeout$/, "the next cell is told as loss");
    assert.match(second.answer.stdout, /^namespace reset at .*: timeout\ntwo$/, "and the loss line opens its result");
    t.mock.timers.tick(DAY);
    await settle();
    await drainReap(second.w);
    assert.equal(second.w.terminated, true, "the kill ended the keep: a later cell without keep: true keeps nothing");
    const third = await runCell({ principal: "run:b3", wire: { client: "mlw-b3-4", run: "b3" }, keep: true }, bench);
    t.mock.timers.tick(DAY);
    await settle();
    assert.equal(third.w.terminated, false, "only a NEW keep: true arms again");
    assert.equal(third.w.posts.at(-1).takeDropped, undefined);
});

// --- (c) what a page or the model cannot get through it ---

test("a page's python_exec arms no keep and no noTimeout, even carrying forged wire and principal fields", async () => {
    // Self-approving so the cell is allowed to run at all (background.test.js's watchdog row's shape): the property
    // is the FLAGS and the STAMPS, on any allowed path. Without the approval the call is refused before PY_RUN and
    // the row would be vacuous.
    const bg = loadBackground({ local: { ml_site_schema: 2, ml_site_selfapprove: ["https://evil.example"] } });
    const page = { tab: { id: 9 }, url: "https://evil.example/attack" };
    await bg.send({ type: "PYTHON_EXEC", payload: { code: "1+1", keep: true, noTimeout: true, wire: { client: "x", run: "victim" }, principal: "run:victim" } }, page);
    const m = bg.pyRuns.find((x) => x.type === "PY_RUN");
    assert.ok(m, "positive control: the page's call ran (this site approves its own actions)");
    assert.equal(String(m.code), "1+1");
    assert.equal(m.keep, undefined, "a page's keep is dropped: python_exec's caller has no wireRun (sw-python.ts)");
    assert.equal(m.noTimeout, undefined, "a page never lifts the cell cap");
    assert.equal(m.wire?.run ?? null, null, "the wire run is the service worker's stamp, not the payload's claim");
    assert.equal(m.principal, "page:9", "the principal is the sender's tab, not the payload's claim");
});

test("a keep is armed only on the service worker's word: a tab-context PY_RUN arms no keep", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const workerWord = await runCell({ principal: "run:c0", wire: { client: "mlw-c0", run: "c0" }, keep: true }, {}, SW);
    const tabWord = await runCell({ principal: "run:c1", wire: { client: "mlw-c1", run: "c1" }, keep: true }, {}, TAB);
    t.mock.timers.tick(DAY);
    await settle();
    await drainReap(tabWord.w);
    assert.equal(tabWord.w.terminated, true, "a tab sender's keep is not the service worker's word");
    assert.equal(workerWord.w.terminated, false, "control: the same message from the service worker keeps");
});

test("a tab-context PY_DELETE_RUN ends no turn: nothing is posted, no keep cleared", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const mine = await turnCell("c2", { keep: true });   // control: the service worker's delete DOES end a turn
    const theirs = await turnCell("c3", { keep: true });
    await endTurn("c2", mine.w);
    const gone = send({ type: "PY_DELETE_RUN", run: "c3", principal: "run:c3" }, TAB);
    await settle();
    const del = theirs.w.posts.find((p) => p.deleteRun === "c3");
    if (del) theirs.w.reply({ id: del.id, ok: true, stdout: "" });
    await gone;
    assert.ok(mine.w.posts.some((p) => p.deleteRun === "c2"), "control: the service worker's delete reaches the worker");
    assert.equal(theirs.w.posts.some((p) => p.deleteRun === "c3"), false, "a tab context is not the service worker: PY_DELETE_RUN checks no sender");
    t.mock.timers.tick(DAY);
    await settle();
    assert.equal(theirs.w.terminated, false, "the keep still stands");
});

// --- (d) the idle clock it rides ---

test("the clocks are the documented values and reapDelay's decision table is the spec's (enumerated)", () => {
    assert.equal(REAP_SETTLED_MS, 5 * 60_000, "docs/dev/python-sandbox.md: a settled turn's worker gets 5 min");
    assert.equal(REAP_LIVE_MS, 30 * 60_000, "the tool's promise is 'over 30 min' (python-tool.ts)");
    assert.equal(reapDelay("own", true, true), null, "the default: anything that is not a run's or a page's worker is never reaped");
    // The reachable decision table, every input enumerated (armReap passes heldRun(principal) !== null; a page's or
    // the bench's worker never holds one — the two unreachable page cells are the row below's).
    const cases = [
        ["own", false, false, null], ["own", false, true, null], ["own", true, false, null],
        ["full", false, false, null], ["full", false, true, null], ["full", true, false, null], ["full", true, true, null],
        ["library", false, false, null], ["library", true, true, null], ["junk", true, true, null],
        ["page:7", false, false, REAP_SETTLED_MS], ["page:7", false, true, REAP_SETTLED_MS],
        ["run:r", false, false, REAP_SETTLED_MS], ["run:r", false, true, REAP_SETTLED_MS],
        ["run:r", true, false, REAP_LIVE_MS], ["run:r", true, true, null],
    ];
    for (const [principal, holdsRun, kept, want] of cases) {
        assert.equal(reapDelay(principal, holdsRun, kept), want, `reapDelay(${principal}, holdsRun=${holdsRun}, kept=${kept})`);
    }
});

test("a page's worker is on the settled clock whatever the flags say: a keep cannot reach it", () => {
    assert.equal(reapDelay("page:7", true, false), REAP_SETTLED_MS, "a page's worker holds no live turn's namespace (heldRun is null for page:): the settled clock");
    assert.equal(reapDelay("page:7", true, true), REAP_SETTLED_MS, "a keep is a worker-hosted turn's: it cannot reach a page's worker");
});

test("a cell that lands during the reap's handover ask keeps its worker, slow or fast", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // Slow control: the cell is still running when the ask answers — the reap stands down.
    const slow = await turnCell("d1");
    await endTurn("d1", slow.w);
    t.mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    const askSlow = slow.w.posts.at(-1);
    assert.equal(askSlow?.takeDropped, true, "the reap asked");
    const slowCell = await startedCell({ principal: "run:d1" });
    slow.w.reply({ id: askSlow.id, ok: true, stdout: "" });
    await settle();
    assert.equal(slow.w.terminated, false, "control: a cell running when the ask answers stops the reap");
    slow.w.reply({ id: slowCell.id, ok: true, stdout: "" });
    // Fast: the cell starts AND finishes inside the ask's window — posting is what stops the reap, not pendency.
    const fast = await turnCell("d2");
    await endTurn("d2", fast.w);
    t.mock.timers.tick(REAP_SETTLED_MS);
    await settle();
    const askFast = fast.w.posts.at(-1);
    assert.equal(askFast?.takeDropped, true, "the reap asked");
    await runCell({ principal: "run:d2" });   // posts and answers before the ask does
    fast.w.reply({ id: askFast.id, ok: true, stdout: "" });
    await settle();
    assert.equal(fast.w.terminated, false, "a cell that finished inside the ask's window still stopped the reap");
});
