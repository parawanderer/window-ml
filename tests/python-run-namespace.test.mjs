// python-run-namespace.test.mjs — ROOT C and the `ml` wire's offscreen half: a run's kept Python namespace, its lifetime and loss.

// The offscreen document (src/offscreen.ts) imported for real under a mocked `chrome` and a fake `Worker`, so the
// message routing is the shipped code and no Pyodide is needed: what is NOT reached here is the worker's own dict
// (python-worker.ts `runs`), which only real CPython can show. The service worker's half runs in the built worker
// (tests/ml-wire-harness.mjs). Which calls share a namespace: docs/dev/python-sandbox.md, "A run's namespace".
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireRun } from "./ml-wire-harness.mjs";

// --- a fake chrome and Worker around the real offscreen document ---

const listeners = [];
const sentToWorker = [];   // chrome.runtime.sendMessage payloads (the offscreen document talking to the service worker)
let sendReply = () => undefined;
const workers = [];   // every Worker the document spawned, in order
class FakeWorker {
    constructor(url, opts) { this.url = url; this.name = opts?.name; this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    /** Play the worker's reply to the document. */
    reply(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => { sentToWorker.push(m); return Promise.resolve(sendReply(m)); },
    },
};
await import("../src/offscreen.ts");

/** Deliver a runtime message to the document's listeners, as the service worker would; resolves with its answer. */
const send = (msg, sender = { id: "test" }) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const lastPost = (w) => w.posts.at(-1);
/** Start a PY_RUN and answer it from the fake worker with `result`; resolves with the document's answer. */
async function runCell(msg, result) {
    const before = workers.length;
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, ...msg });
    await tick();
    // The worker the cell was posted to: a new one, or a reused one (the shared `full` worker).
    const w = workers.find((x) => x.posts.length > (posted.get(x) ?? 0));
    const post = lastPost(w);
    assert.ok(post && typeof post.id === "number", "the cell reached a worker");
    w.reply({ id: post.id, ok: true, stdout: "", ...result });
    return { answer: await answer, w, post, spawned: workers.length - before };
}
const bench = (names) => ({ bench: { id: "run-x", vars: names.map((name) => ({ name, type: "int" })) } });

// --- deleting a run's namespace ---

test("PY_DELETE_RUN reaches the worker of that run's principal as deleteRun, and not another run's", async () => {
    const a = await runCell({ principal: "run:del-a", wire: { client: "mlw-a", run: "del-a" } }, bench(["x"]));
    const b = await runCell({ principal: "run:del-b", wire: { client: "mlw-b", run: "del-b" } }, bench(["y"]));
    const done = send({ type: "PY_DELETE_RUN", run: "del-a", principal: "run:del-a" });
    await tick();
    const asked = lastPost(a.w);
    assert.equal(asked.deleteRun, "del-a", "the run's own worker was told");
    assert.equal(lastPost(b.w).deleteRun, undefined, "positive control: the other run's worker was not");
    a.w.reply({ id: asked.id, ok: true, stdout: "" });
    assert.deepEqual(await done, { ok: true });
});

test("PY_DELETE_RUN for a run with no live worker answers ok and spawns nothing", async () => {
    const before = workers.length;
    assert.deepEqual(await send({ type: "PY_DELETE_RUN", run: "never-ran" }), { ok: true });
    assert.equal(workers.length, before);
});

test("PY_DELETE_RUN without a run id is not handled", async () => {
    assert.equal(await send({ type: "PY_DELETE_RUN", run: "" }), undefined);
    assert.equal(await send({ type: "PY_DELETE_RUN" }), undefined);
});

test("a deleted run that runs again starts without a loss notice", async () => {
    await runCell({ principal: "run:del-c", wire: { client: "mlw-c1", run: "del-c" } }, bench(["x"]));
    const w = workers.at(-1);
    const done = send({ type: "PY_DELETE_RUN", run: "del-c", principal: "run:del-c" });
    await tick();
    w.reply({ id: lastPost(w).id, ok: true, stdout: "" });
    await done;
    const again = await runCell({ principal: "run:del-c", wire: { client: "mlw-c2", run: "del-c" } }, bench(["z"]));
    assert.ok(!("nsReset" in again.answer), "a run closed on purpose is not a reset");
});

test("PY_DELETE_RUN for a FULL-mode run reaches the shared full worker as deleteRun", async () => {
    const a = await runCell({ hardened: false, principal: "full", wire: { client: "mlw-f", run: "full-a" } }, bench(["x"]));
    const done = send({ type: "PY_DELETE_RUN", run: "full-a", principal: "full" });
    await tick();
    const asked = lastPost(a.w);
    assert.equal(asked.deleteRun, "full-a", "the full worker was told");
    a.w.reply({ id: asked.id, ok: true, stdout: "" });
    assert.deepEqual(await done, { ok: true });
});

test("the service worker's PY_DELETE_RUN (principal run:<id>) reaches EVERY worker holding the run's dict, the full one included", async () => {
    // What deletePythonRun sends: the run's own principal only. A full-mode cell's dict is on the shared `full`
    // worker, where another full-mode run's cell can read it (gc.get_objects()), so it must be told too.
    const full = await runCell({ hardened: false, principal: "full", wire: { client: "mlw-g1", run: "both-a" } }, bench(["x"]));
    const other = await runCell({ hardened: false, principal: "full", wire: { client: "mlw-g2", run: "both-b" } }, bench(["y"]));
    assert.equal(other.w, full.w, "both full-mode runs share one worker");
    const ro = await runCell({ principal: "run:both-a", wire: { client: "mlw-g3", run: "both-a" } }, bench(["z"]));
    const mark = full.w.posts.length;   // the shared worker carries earlier tests' posts
    const done = send({ type: "PY_DELETE_RUN", run: "both-a", principal: "run:both-a" });
    await tick();
    const toFull = full.w.posts.slice(mark).filter((p) => p.deleteRun);
    assert.deepEqual(toFull.map((p) => p.deleteRun), ["both-a"], "the full worker drops both-a's dict, and only that one");
    assert.equal(lastPost(ro.w).deleteRun, "both-a", "the run's own readonly worker is told too");
    full.w.reply({ id: toFull[0].id, ok: true, stdout: "" });
    ro.w.reply({ id: lastPost(ro.w).id, ok: true, stdout: "" });
    assert.deepEqual(await done, { ok: true });
});

// --- a killed worker tells the run's next cell ---

test("a kill of the shared full worker tells EVERY run that kept a dict there, and no other", async () => {
    const a = await runCell({ hardened: false, principal: "full", wire: { client: "mlw-k1", run: "fk-a" } }, bench(["x"]));
    await runCell({ hardened: false, principal: "full", wire: { client: "mlw-k2", run: "fk-b" } }, bench(["y"]));
    await runCell({ principal: "run:fk-c", wire: { client: "mlw-k3", run: "fk-c" } }, bench(["z"]));
    a.w.onerror({ message: "boom" });
    assert.ok(a.w.terminated, "positive control: the full worker died");
    for (const run of ["fk-a", "fk-b"]) {
        const next = await runCell({ hardened: false, principal: "full", wire: { client: `mlw-k-${run}`, run } }, { stdout: "next" });
        assert.match(next.answer.stdout, /^namespace reset at .*: crashed\nnext$/, `${run} is told its full-mode dict is gone`);
    }
    const c = await runCell({ principal: "run:fk-c", wire: { client: "mlw-k4", run: "fk-c" } }, { stdout: "next" });
    assert.equal(c.answer.stdout, "next", "a run whose dict was on its own readonly worker lost nothing");
});


test("a worker that dies between two cells of a run puts the reset line at the head of the second cell's output", async () => {
    const first = await runCell({ principal: "run:loss-a", wire: { client: "mlw-l1", run: "loss-a" } }, { ...bench(["x"]), stdout: "one" });
    assert.equal(first.answer.stdout, "one");
    assert.ok(!("nsReset" in first.answer), "the first cell has nothing to report");
    first.w.onerror({ message: "out of memory" });
    assert.ok(first.w.terminated, "positive control: the crash killed the worker");
    const second = await runCell({ principal: "run:loss-a", wire: { client: "mlw-l2", run: "loss-a" } }, { stdout: "two" });
    assert.equal(second.spawned, 1, "the second cell ran in a fresh worker");
    assert.match(second.answer.stdout, /^namespace reset at \d{4}-\d\d-\d\dT[\d:.]+Z: crashed\ntwo$/);
    assert.match(second.answer.nsReset, /^namespace reset at .*: crashed$/);
    const third = await runCell({ principal: "run:loss-a", wire: { client: "mlw-l3", run: "loss-a" } }, { stdout: "three" });
    assert.equal(third.answer.stdout, "three", "the notice is told once");
});

test("a run that never kept a namespace is not told it lost one", async () => {
    const first = await runCell({ principal: "run:loss-b", wire: { client: "mlw-m1", run: "loss-b" } }, { stdout: "one" });
    first.w.onerror({ message: "boom" });
    const second = await runCell({ principal: "run:loss-b", wire: { client: "mlw-m2", run: "loss-b" } }, { stdout: "two" });
    assert.equal(second.answer.stdout, "two");
});

test("a cell with no wire (a page-started cell) never gets the reset line", async () => {
    const first = await runCell({ principal: "page:9" }, {});
    first.w.onerror({ message: "boom" });
    const second = await runCell({ principal: "page:9" }, { stdout: "two" });
    assert.equal(second.answer.stdout, "two");
});

// --- the wire's stamp stays in the document ---

test("a cell's ml call is sent on with the document's own client and run; an ask holds until the later ML_ANSWER", async () => {
    sentToWorker.length = 0;
    const calls = [];
    sendReply = (m) => { if (m.type === "ML_CALL") { calls.push(m); return m.call === "gated" ? { seq: m.seq, ask: { card: "?" } } : { seq: m.seq, value: 1 }; } return undefined; };
    try {
        const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, principal: "run:stamp", wire: { client: "mlw-s", run: "stamp" } });
        await tick();
        const w = workers.at(-1);
        const id = lastPost(w).id;
        assert.deepEqual([lastPost(w).wire, lastPost(w).run], [true, "stamp"], "the worker is told there is a wire and whose run, not the handle");
        assert.ok(!JSON.stringify(lastPost(w)).includes("mlw-s"), "the handle never reaches the worker");
        w.reply({ id, mlCall: { seq: 1, call: "config", args: [], client: "forged", run: "forged" } });
        await tick();
        assert.deepEqual([calls[0].client, calls[0].run], ["mlw-s", "stamp"], "stamped here, whatever the worker put in");
        assert.deepEqual(w.posts.at(-1).mlAnswer, { seq: 1, answer: { seq: 1, value: 1 } });
        w.reply({ id, mlCall: { seq: 2, call: "gated", args: [] } });
        await tick();
        assert.equal(w.posts.filter((p) => p.mlAnswer?.seq === 2).length, 0, "an ask first answer is not relayed down");
        assert.deepEqual(await send({ type: "ML_ANSWER", client: "mlw-s", answer: { seq: 2, value: "yes" } }), { ok: true });
        assert.deepEqual(w.posts.at(-1).mlAnswer, { seq: 2, answer: { seq: 2, value: "yes" } });
        w.reply({ id, ok: true, stdout: "" });
        await answer;
    } finally { sendReply = () => undefined; }
});

// --- UPGRADE: a PY_RUN shaped the way the old service worker sent it ---

test("UPGRADE: a PY_RUN with no wire and no run (the old shape) runs as before: no wire flag, no kept namespace, no notice", async () => {
    // Old state meeting new code: a service worker that has not reloaded (or a cached build) sends PY_RUN without
    // `wire`, and the bench and page-started cells still do. The document must pass nothing new to the worker for
    // it, and must not answer with the namespace-reset line or an `ml` stamp.
    const old = { type: "PY_RUN", principal: "page:41", code: "print(1)", image: null, hardened: true, tables: null, stream: false };
    const { answer, post } = await runCell(old, { stdout: "1\n", value: 1 });
    assert.ok(!("wire" in post) && !("run" in post), "the worker message carries neither");
    assert.equal(post.code, "print(1)");
    assert.equal(post.hardened, true);
    assert.deepEqual(answer, { ok: true, stdout: "1\n", value: 1 });
    // And a worker that answers with an `mlCall` for a cell that has no wire gets a refusal, not a hang.
    const w = workers.at(-1);
    const pending = send({ ...old, code: "ml" });
    await tick();
    const id = lastPost(w).id;
    w.reply({ id, mlCall: { seq: 5, call: "config", args: [] } });
    await tick();
    assert.equal(w.posts.at(-1).mlAnswer.answer.error.code, "Refused");
    w.reply({ id, ok: true, stdout: "" });
    await pending;
});

// --- the service worker ends a run's namespace when the run settles ---

test("a worker-hosted run that settles sends PY_DELETE_RUN for its own run and principal", { timeout: 30000 }, async () => {
    let wire;
    const { bg } = await wireRun(async (w) => { wire = w; });
    assert.ok(wire?.run, "positive control: the cell ran with a run id");
    assert.deepEqual(bg.pyDeletes.map((m) => [m.type, m.run, m.principal]), [["PY_DELETE_RUN", wire.run, `run:${wire.run}`]]);
});
