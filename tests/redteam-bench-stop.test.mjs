// redteam-bench-stop.test.mjs — who may STOP the Python bench (#1507: `PYTHON_INTERRUPT` at the service worker,
// `PY_INTERRUPT` at the offscreen document; docs/dev/python-sandbox.md, "Stopping a bench script").
//
// The Stop is a message that names NOTHING: no request, no run, no principal, and the offscreen document interrupts the
// one started `own`-principal bench run it holds (`interruptBench`). That is what keeps it from reaching another run's
// namespace, and it is also what makes the SENDER the whole of the authorisation.
//
// What must not be reachable, each a row: a page's, a foreign extension's, or one of our own tab-bound frames' message
// interrupting the bench's run or killing its worker, at EITHER gate — the offscreen document is on the same runtime
// message bus as every content script, so it is reached directly and does not inherit the service worker's judgement;
// a message that NAMES a target reaching another principal's run; and an attacker's message arming the kill timer, so
// the bench's worker dies a second later even though the Stop was refused.
//
// The shapes are the ones a browser can stamp: always an OBJECT. An absent sender is not enumerated — the document
// reads `sender.id` and a missing sender throws there, which is no answer and no interrupt, but it is not a shape a
// page can manufacture.
//
// Both halves run against ONE runtime bus, as they do in Chrome: the service worker's forward is the only message that
// reaches the document in this instrument, and every other sender is delivered to the document directly.
//
// Every row has a plain control in the same instrument, so a fixture that cannot stop a bench run at all fails rather
// than passing by refusing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

// --- a fake chrome and Worker around the real service worker's half and the real offscreen document ---

const listeners = [];   // the offscreen document's runtime listeners
const outgoing = [];    // every chrome.runtime.sendMessage payload, from either half, in order
let offscreenAnswer;    // what the document would answer the worker's forward; the worker rows set it per row
const workers = [];     // every Worker the document spawned, in order
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
        sendMessage: (m) => { outgoing.push(m); return Promise.resolve(offscreenAnswer); },
    },
    storage: {
        local: { get: async () => ({}), set: async () => {} }, sync: { get: async () => ({}) },
        session: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} },
    },
};
const { pythonInterrupt } = await import("../src/sw/sw-python.ts");
const { BENCH_STOP_KILL_MS, BENCH_STOP_KILLED } = await import("../src/offscreen.ts");

// --- the service worker's half: sw-python's `pythonInterrupt`, driven directly ---

/** Deliver a PYTHON_INTERRUPT from `sender` to the worker; resolves with what the worker answered. */
const ask = (sender) => new Promise((resolve) => { pythonInterrupt(sender, resolve); void 0; });

/** Every message the service worker forwarded to the offscreen document, in order. */
const forwarded = () => outgoing.splice(0);

/** The sender shapes a browser can put in front of the worker, each named for where it comes from. */
const SENDERS = [
    ["a page's content script", { id: "test", url: "https://evil.example/x", origin: "https://evil.example", tab: { id: 4, url: "https://evil.example/x" }, frameId: 0 }],
    ["a content script in a subframe", { id: "test", url: "https://evil.example/x", origin: "https://evil.example", tab: { id: 4, url: "https://evil.example/x" }, frameId: 7 }],
    ["a page whose URL embeds our extension's", { id: "test", url: "https://evil.example/chrome-extension://test/sidebar.html", tab: { id: 4 } }],
    ["another extension", { id: "other", url: "chrome-extension://other/sidebar.html" }],
    ["another extension with no url", { id: "other" }],
    ["an empty sender", {}],
    ["an empty url", { id: "test", url: "" }],
];

test("CONTROL: our own surface's Stop is forwarded, and the forward names nothing a sender could have set", async () => {
    // The overlay bench is an extension iframe INSIDE a tab, so the sender has a `tab` too: the worker's judgement is
    // the sender's URL, and this is the shape it admits (background.test.js pins the same one).
    for (const sender of [{ url: "chrome-extension://test/sidebar.html" }, { id: "test", url: "chrome-extension://test/sidebar.html", tab: { id: 9, url: "https://site.example/" } }]) {
        forwarded();
        offscreenAnswer = { interrupted: true };
        assert.deepEqual(await ask(sender), { data: { interrupted: true } }, `an admitted sender did not reach the offscreen document: ${JSON.stringify(sender)}`);
        assert.deepEqual(forwarded(), [{ type: "PY_INTERRUPT" }], `the forward is not the bare message: ${JSON.stringify(outgoing)}`);
    }
    // No answer, or an answer that says nothing ran: the person's Stop is reported as "nothing was running", never a leak.
    offscreenAnswer = undefined;
    assert.deepEqual(await ask({ url: "chrome-extension://test/sidebar.html" }), { data: { running: false } }, "an unanswered forward");
    offscreenAnswer = { running: false };
    assert.deepEqual(await ask({ url: "chrome-extension://test/sidebar.html" }), { data: { running: false } }, "the offscreen document's own no-op");
    offscreenAnswer = undefined;
    forwarded();
});

test("RED TEAM: no other sender shape is refused-then-forwarded — the offscreen document is never asked", async () => {
    for (const [why, sender] of SENDERS) {
        forwarded();
        offscreenAnswer = { interrupted: true };
        assert.deepEqual(await ask(sender), { error: "refused" }, `${why}: was answered as a surface of ours`);
        assert.deepEqual(forwarded(), [], `${why}: the offscreen document was asked anyway`);
    }
    offscreenAnswer = undefined;
});

// --- the offscreen document's half: on the same bus as every content script, reached directly ---

const SW = { id: "test" };   // the service worker's sender: our id, no tab
/** Deliver a runtime message to the document's listeners; resolves with its answer, or undefined when none came. */
const deliver = (msg, sender = SW) => new Promise((resolve) => {
    let answered = false;
    const answer = (r) => { answered = true; resolve(r); };
    for (const fn of listeners) if (fn(msg, sender, answer) === true) return;
    if (!answered) resolve(undefined);
});
const tick = () => new Promise((r) => realSetTimeout(r, 0));
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
const kills = () => outgoing.filter((m) => m.type === "HOUSEKEEPING_REPORT" && m.payload?.kind === "kill");

/** Post a run and wait until its worker has it; `started` plays the worker's "the cell is starting" note. */
async function startRun(msg, { started = true } = {}) {
    const before = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = deliver({ type: "PY_RUN", code: "while True: pass", hardened: true, tables: null, ...msg });
    await tick();
    const w = workers.find((x) => x.posts.some((p, i) => i >= (before.get(x) ?? 0) && typeof p.id === "number"));
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

/** The sender shapes the document must ignore: every one carries a tab, or is not ours, or names another id. */
const TABBOUND = [
    ["a page's content script", { id: "test", url: "https://evil.example/x", origin: "https://evil.example", tab: { id: 4, url: "https://evil.example/x" }, frameId: 0 }],
    ["a content script in a subframe", { id: "test", url: "https://evil.example/x", tab: { id: 4 }, frameId: 5 }],
    // The shape the WORKER admits (its judgement is the URL), and the document does not: our own frame inside a tab is
    // still a frame inside a tab, and the document acts only on the service worker's own forward.
    ["our overlay sidebar's iframe in a tab", { id: "test", url: "chrome-extension://test/sidebar.html", tab: { id: 9, url: "https://site.example/" } }],
    ["another extension", { id: "other", url: "chrome-extension://other/x.html" }],
    ["another extension with no url", { id: "other" }],
    ["an empty sender", {}],
    ["an empty id", { id: "", url: "chrome-extension://test/sidebar.html" }],
];

test("CONTROL: the worker's own PY_INTERRUPT interrupts a started bench run", async () => {
    const { answer, w, post } = await benchRun();
    assert.deepEqual(await deliver({ type: "PY_INTERRUPT" }), { interrupted: true }, "the service worker's Stop did not reach the bench run");
    assert.equal(Atomics.load(w.flag, 0), 2, "SIGINT written into the run's flag");
    w.reply({ id: post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    await answer;
});

test("RED TEAM: every tab-bound, foreign or absent sender gets no answer and writes nothing", async () => {
    const { answer, w, post } = await benchRun();
    for (const [why, sender] of TABBOUND) {
        assert.equal(await deliver({ type: "PY_INTERRUPT" }, sender), undefined, `${why}: the document answered a sender it must ignore`);
        assert.equal(Atomics.load(w.flag, 0), 0, `${why}: the bench run's flag was written`);
        assert.equal(w.terminated, false, `${why}: the worker was terminated`);
    }
    // Positive control: the same run, from the only sender that may.
    assert.deepEqual(await deliver({ type: "PY_INTERRUPT" }, SW), { interrupted: true }, "the run was not interruptible at all");
    assert.equal(Atomics.load(w.flag, 0), 2);
    w.reply({ id: post.id, ok: false, stdout: "", error: "KeyboardInterrupt" });
    await answer;
});

test("RED TEAM: a message that NAMES a target cannot reach another principal's run", async () => {
    // The Stop's whole safety is that it names nothing. This row hands it everything a caller would need to aim it —
    // a run id, a principal, a request id — from the only sender allowed, while the only started run belongs to
    // another principal: nothing is interrupted, and the other run's flag is untouched.
    const other = await startRun({ principal: "run:rt-stop", persist: true, wire: { client: "mlw-rt", run: "rt-stop" } });
    Atomics.store(other.w.flag, 0, 0);
    const killsBefore = kills().length;
    for (const msg of [
        { type: "PY_INTERRUPT" },
        { type: "PY_INTERRUPT", run: "rt-stop" },
        { type: "PY_INTERRUPT", principal: "run:rt-stop", id: other.post.id, requestId: "rt-stop" },
    ]) {
        assert.deepEqual(await deliver(msg, SW), { running: false }, `the message aimed itself: ${JSON.stringify(msg)}`);
        assert.equal(Atomics.load(other.w.flag, 0), 0, `another principal's run was interrupted: ${JSON.stringify(msg)}`);
        assert.equal(kills().length, killsBefore, "a kill record was written for a run the Stop must not reach");
    }
    other.w.reply({ id: other.post.id, ok: true, stdout: "" });
    await other.answer;
});

test("RED TEAM: an ignored Stop arms no kill, so the bench's worker is still alive past the bound", async () => {
    // The kill timer is the half a refusal could still leak: a message that armed it and was then ignored would end the
    // run a second later. So the wait is the assertion, and the flag is read after it.
    const { answer, w, post } = await benchRun();
    const killsBefore = kills().length;
    for (const [why, sender] of TABBOUND) assert.equal(await deliver({ type: "PY_INTERRUPT" }, sender), undefined, `${why}: answered`);
    await sleep(BENCH_STOP_KILL_MS + 250);
    assert.equal(w.terminated, false, "an ignored Stop's kill fired");
    assert.equal(kills().length, killsBefore, `an ignored Stop logged a kill: ${JSON.stringify(kills().slice(killsBefore))}`);
    assert.equal(Atomics.load(w.flag, 0), 0, "an ignored Stop wrote the flag late");
    // Positive control: the run was there to be killed, so the assertions above are not vacuous.
    assert.deepEqual(await deliver({ type: "PY_INTERRUPT" }), { interrupted: true }, "the bench run had ended by itself");
    await sleep(BENCH_STOP_KILL_MS + 250);
    assert.equal(w.terminated, true, `a real Stop did not kill: ${BENCH_STOP_KILLED.slice(0, 20)}`);
    assert.equal(kills().length, killsBefore + 1, "a real Stop logs its kill");
    assert.equal((await answer).stopped, "restarted");
});
