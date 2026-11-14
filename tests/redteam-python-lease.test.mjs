// redteam-python-lease.test.mjs — the red team's pass on ASYNC_CALLS.md mode 1 as it reaches `python_exec` (#1642): what
// a PAGE must never get from the lease, the detached task and the four messages it added (PY_STARTED, PY_CANCEL,
// PY_TAIL, PY_DONE) plus the one slice B added (PY_RESULT; src/sw/sw-python-task.ts, src/python/py-lease.ts,
// src/offscreen.ts; docs/spec/ASYNC_CALLS.md, mode 1 rules 4 to 6, rule 4b's durable table).
//
// What must not be reachable, each a row: the five worker-only messages, relayed or posted at the router; a page's own
// `ml.pythonExec` leasing a cell, or naming one; another run cancelling or tailing a cell, under any id shape; the API
// key in a detached cell's tail, its `task tail` or the late task's text; and a detached cell outliving its turn, or
// locking a kernel that is not its run's.
//
// Every row has a plain control beside it (the same instrument on honest traffic), so a fixture that cannot see a
// python call at all fails rather than passing by refusing nothing.
//
// TWO harnesses, on purpose. Rows A and B are about what a PAGE can send, so they drive the ROUTER in a vm
// (helpers.js `loadBackground`/`loadPageWorld`, whose `pyRuns`/`runtimeSent` recorders see the executor's traffic).
// Rows C, D and F are about what a RUN can do with a cell it does not own, so they drive the REAL sw-python-task and
// sw-tasks modules under python-lease.test.mjs's `globalThis.chrome` mock — copied below from that file (its `cell`,
// `detached`, `done`, `sent`, `tailAnswer`, `cancelHow`, `sleep`, `until`, `T`, `OFFSCREEN`), since node:test cannot
// import one test file from another without running its tests twice. The vm loads its own copy of the modules, so the
// two harnesses share no state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground, loadPageWorld } = require("./helpers");
const { HANDLE_MAP, PAGE_STARTED_TYPES, PAGE_UNGATED_TYPES, RUN_CONTROL_TYPES } = require("../src/page-relay.ts");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });
const hostilePage = (id = 9, url = "https://evil.example/attack") => ({ tab: { id, url }, url });   // sender.tab set + web origin
const tick = () => new Promise((r) => setTimeout(r, 5));

/** The messages a leased cell adds — #1642's four and slice B's `PY_RESULT`: read by the offscreen document and the
 *  worker, made only by the worker. `PY_RESULT` is the one that HANDS OVER a held result: a page reaching it would be
 *  handed another run's output. */
const CELL_TYPES = ["PY_STARTED", "PY_CANCEL", "PY_TAIL", "PY_DONE", "PY_RESULT"];

// The attacker owns window.postMessage, which the content script no longer hears (SITE_PRESENCE step 2b): its strongest
// position is injected.js's port. Which background messages can it get RELAYED through that? Only HANDLE_MAP
// *_REQUEST types. Returns the forwarded bg types. (The helper is redteam.test.js's, copied with its own assertion.)
async function pageRelays(...msgs) {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: null }) });
    await tick();
    const boot = world.runtimeCalls.length;
    for (const m of msgs) world.context.window.postMessage(m);
    await tick();
    assert.deepEqual(world.runtimeCalls.slice(boot).map((c) => c.type), [], "a message on the page's window relayed something");
    for (const m of msgs) world.asInjected(m);
    await tick();
    return world.runtimeCalls.map((c) => c.type);
}

// --- 1. the five messages are worker-only ---
// Mutation measured (not committed): list any one of the five in PAGE_STARTED_TYPES, or give it a HANDLE_MAP entry, and
// this row goes red on the table assertion first and on the relay second. Slice B's table, measured at 0f789112: a
// router branch that forwards a page's `PY_RESULT` to the offscreen document reds the "forwards none" assertion.


test("GAIN blocked — the lease's five messages are no page's to relay or post: they are absent from the relay tables and the router forwards none", async () => {
    // PY_STARTED arms a lease, PY_CANCEL interrupts a run's cell, PY_TAIL reads its kept output, PY_DONE settles it,
    // PY_RESULT hands over the result held for the worker that lost it. A page reaching any of them would be a confused
    // deputy over another run's Python, so each must be unrelayable and inert from a tab sender even when it names a
    // cell that exists.
    const mapped = Object.entries(HANDLE_MAP).flatMap(([k, v]) => [k, v.type, v.responseType]);
    for (const t of CELL_TYPES) {
        assert.ok(!mapped.some((m) => String(m).startsWith(t)), `${t} is in HANDLE_MAP`);
        for (const [name, set] of [["PAGE_STARTED_TYPES", PAGE_STARTED_TYPES], ["PAGE_UNGATED_TYPES", PAGE_UNGATED_TYPES], ["RUN_CONTROL_TYPES", RUN_CONTROL_TYPES]]) {
            assert.ok(!set.has(t), `${t} is in ${name}`);
        }
    }
    const relayed = await pageRelays(...CELL_TYPES.flatMap((t) => [{ type: t, cell: "c1a2b3d4" }, { type: `${t}_REQUEST`, payload: { cell: "c1a2b3d4" } }]));
    assert.deepEqual(relayed, [], "the content script relayed one of the five");
    // The instrument sees an honest relay: a page's CONFIG_REQUEST reaches the worker as GET_CONFIG.
    const control = await pageRelays({ type: "CONFIG_REQUEST", requestId: "c1", payload: {} });
    assert.ok(control.includes("GET_CONFIG"), `positive control: the page's CONFIG_REQUEST relays (${JSON.stringify(control)})`);

    // Posted straight at the router as if the content script had relayed it: nothing reaches the offscreen document,
    // where the cell's interrupt, its ring and its settled reply live.
    // The page approves itself, so the origin gate is not what refuses the five: the types' own absence is.
    const bg = loadBackground({ config: baseConfig(), local: { ml_site_schema: 2, ml_site_selfapprove: ["https://evil.example"] } });
    for (const t of CELL_TYPES) await Promise.race([bg.send({ type: t, cell: "c1a2b3d4", run: "run-victim", ok: true, bytes: 1 }, hostilePage()), tick()]);
    const forwarded = bg.runtimeSent.filter((m) => CELL_TYPES.includes(m?.type));
    assert.deepEqual(forwarded, [], "the worker forwarded a page's message to the offscreen document");
    // The recorder sees the honest traffic it would have shown: a page's PYTHON_EXEC reaches the offscreen document.
    await bg.send({ type: "PYTHON_EXEC", payload: { code: "1+1" } }, hostilePage());
    assert.ok(bg.runtimeSent.some((m) => m?.type === "PY_RUN"), "positive control: the page's PYTHON_EXEC reached the offscreen document as PY_RUN");
});

// ===== the real-module harness (python-lease.test.mjs's, copied: see the header) =====


const T = { timeout: 20000 };
const EXT = "ext-id";

const sent = [];
let cancelHow = "interrupted";
// The stored API key, so a row can give it a secret's SHAPE: secret-scrub.ts scrubs an apiKey only at 12+ characters
// (MIN_KEY), so a short fake like "sk-test" is not secret-shaped and a row written against one would pass vacuously.
let harnessApiKey = "sk-test";
let tailAnswer = { running: true, text: "" };
let pyRunHold = null;   // set: PY_RUN answers this promise, so a cell stays in flight
const session = {};
globalThis.chrome = {
    runtime: {
        id: EXT, lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => `chrome-extension://${EXT}/${p}`,
        sendMessage: async (m) => {
            sent.push(JSON.parse(JSON.stringify(m)));
            if (m.type === "PY_CANCEL") return { how: cancelHow };
            if (m.type === "PY_TAIL") return tailAnswer;
            if (m.type === "PY_RUN" && pyRunHold) return pyRunHold;
            return { ok: true, stdout: "" };
        },
    },
    offscreen: { hasDocument: async () => true },
    storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), chatUrl: "http://host/api/chat/completions", apiKey: harnessApiKey }), set: async () => {} },
        session: {
            get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k ?? session); return Object.fromEntries(keys.filter((x) => x in session).map((x) => [x, session[x]])); },
            set: async (o) => { Object.assign(session, JSON.parse(JSON.stringify(o))); }, remove: async (k) => { for (const x of [k].flat()) delete session[x]; },
        },
        onChanged: { addListener() {} },
    },
    tabs: {},
};
const { leaseCell, pyKernelBusy, pyDetachedText, pyTailText, pyCancelText } = await import("../src/sw/sw-python-task.ts");
const { pythonStarted, pythonDone, runPython } = await import("../src/sw/sw-python.ts");
const { taskAction, endTasks, openTasks, taskDrained } = await import("../src/sw/sw-tasks.ts");
const { runControllers, runInboxes } = await import("../src/sw/sw-runs.ts");
const { runLog } = await import("../src/sw/sw-run-log.ts");
const { ringAppend, PY_LEASE_MS, PY_LEASE_MAX_MS, PY_DETACHED_MAX_MS, PY_INTERRUPT_KILL_MS } = await import("../src/python/py-lease.ts");

const OFFSCREEN = { id: EXT, url: `chrome-extension://${EXT}/offscreen.html` };
const TASK_ID = /^t[0-9a-f]{6}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(10); } };
const sentOf = (type) => sent.filter((m) => m.type === type);

let n = 0;
/**
 * One leased cell in a live run: its call is a promise the test settles, its inbox is open, a controller is registered.
 * `late` formats the result the way python_exec's does (a stub that quotes it).
 * @param o expectMs, and the run's id
 */
function cell(o = {}) {
    n++;
    const runId = o.runId ?? `run-py-${n}`;
    const id = `cell-${n}`;
    const ctl = new AbortController();
    runControllers.set(runId, ctl);
    runInboxes.set(runId, { tabId: 7, queue: [] });
    openTasks(runId, () => {});
    let ok, err;
    const call = new Promise((res, rej) => { ok = res; err = rej; });
    const lates = [];
    let detaches = 0;
    const answer = leaseCell({
        runId, cell: id, ...(o.seq !== undefined ? { seq: o.seq } : {}), expectMs: o.expectMs ?? null, call, onDetach: () => { detaches++; },
        late: async (r) => { lates.push(r); return { status: "done", text: `out: ${r.out}`, result: null }; },
    });
    return { runId, id, ctl, answer, resolve: ok, reject: err, lates, detaches: () => detaches, inbox: () => runInboxes.get(runId).queue,
        start: () => pythonStarted({ type: "PY_STARTED", cell: id }, OFFSCREEN) };
}
/** Detach a fresh cell and return it with its detached answer. */
async function detached(o = {}) {
    const c = cell({ expectMs: 30, ...o });
    c.start();
    const r = await c.answer;
    assert.ok(r.detached, JSON.stringify(r));
    return { ...c, r: r.detached };
}
const done = async (c) => { runControllers.delete(c.runId); await endTasks(c.runId); runInboxes.delete(c.runId); };

// --- 2. a page's own python call ---
// Mutation measured (not committed): have runPython read the cell off the payload (`caller.cell ?? payload?.cell`) instead of
// the caller only, and a page's own PY_EXEC puts its cell on the PY_RUN: this row fails on `m.cell`.


test("a page's ml.pythonExec cannot lease a cell: the cell and wire stamp it names are dropped from the PY_RUN the executor sees", async () => {
    // A lease starts on PY_STARTED for a cell the PY_RUN named. A page that names a cell and a wire run in its own
    // PYTHON_EXEC must reach the offscreen document as a PY_RUN with neither, so nothing exists for it to arm.
    const bg = loadBackground({ local: { ml_site_schema: 2, ml_site_selfapprove: ["https://evil.example"] } });
    const page = { tab: { id: 9 }, url: "https://evil.example/attack" };
    await bg.send({ type: "PYTHON_EXEC", payload: { code: "1+1", cell: "c1a2b3d4", expect_ms: 120000, wire: { client: "x", run: "victim" }, principal: "run:victim" } }, page);
    const m = bg.pyRuns.find((x) => x.type === "PY_RUN");
    assert.ok(m, "positive control: the page's call reached the executor");
    assert.equal(m.cell, undefined, `a page's PY_EXEC named a cell: ${JSON.stringify(Object.keys(m))}`);
    assert.equal(m.wireRun, undefined, "a page's PY_EXEC named the wire run a lease would be scoped to");
    // Control: the same instrument on the worker's own path DOES carry a cell — the scratch value is real, and the two
    // lines above measured a drop rather than an inert harness.
    const caller = { ownSurface: false, untrusted: async () => false, disclose: false, tabUrl: () => "", runGated: true, pyCodeOk: () => true, wireRun: "run-victim", cell: "c1a2b3d4" };
    const { runPython } = await import("../src/sw/sw-python.ts");
    const b = sent.length;
    await runPython({ code: "1" }, "req", caller);
    const built = sent.slice(b).find((x) => x.type === "PY_RUN");
    assert.equal(built?.cell, "c1a2b3d4", `positive control: a worker-hosted call's PY_RUN carries its cell (${JSON.stringify(built && Object.keys(built))})`);
});

// --- 3. another run's cell ---
// Mutation measured (not committed): key taskAction's lookup by id across every run's tasks instead of `tasks.get(runId)`, and
// a foreign run's cancel/tail/await answers: this row fails on /^UnknownTask/ and on the empty executor slice.


test("another run cannot cancel, tail or await a python cell under any id shape, and nothing reaches its executor", T, async () => {
    // The handle is the run's (ASYNC_CALLS.md mode 1, rule 5): the cell's id belongs to the run that detached it, and
    // `taskAction` is keyed by the loop's run id, never by anything the model's arguments say.
    const c = await detached();
    const before = sent.length;
    for (const runId of ["rt-attacker", "run-py-999"]) for (const op of ["await", "cancel", "tail"])
        assert.match(await taskAction(runId, { op, id: c.r.id, timeout_ms: 10, lines: 5 }), /^UnknownTask/, `${runId} ${op}: a foreign id was answered`);
    // The hostile shapes redteam-task.test.mjs enumerates for the shell's twin, plus the CELL id (which is not the
    // task id) and the two whitespace variants a loose comparison would fold.
    const shapes = [undefined, null, 7, [c.r.id], { id: c.r.id }, "", "t000000", c.id, `${c.r.id}#`, ` ${c.r.id}`, `${c.r.id} `];
    for (const id of shapes) for (const op of ["await", "cancel", "tail"]) assert.match(await taskAction("rt-attacker", { op, id }), /^UnknownTask/, `${op} ${JSON.stringify(id)}`);
    assert.deepEqual(sent.slice(before), [], "a foreign run's attempt reached the executor");
    // Control: the owner's cancel does reach the cell, exactly once, and answers with the cancel's own words.
    cancelHow = "interrupted";
    assert.match(await taskAction(c.runId, { op: "cancel", id: c.r.id }), new RegExp(`^task ${c.r.id}: `));
    assert.deepEqual(sent.slice(before).filter((m) => m.type === "PY_CANCEL").map((m) => m.cell), [c.id], "positive control: the owner's cancel reached the executor");
    c.resolve({ out: "x" });
    await until(() => c.inbox().length > 0);
    await done(c);
});

// --- 4. the ring's text never comes back to the model ---
// Mutation measured (not committed): drop forModel from taskAction's two tail returns, and the ring's key reaches the
// model: this row fails on "task tail carried the API key".

test("a detached cell that printed the API key returns it through neither the detached answer's tail nor a task tail", T, async () => {
    // The ring is the offscreen document's raw output; the two routes the model reads are the Detached answer's tail
    // (leaseCell's forModel) and `task tail` (sw-tasks' forModel). The late task's own text is python_exec's `finish`,
    // a different formatter, and is not measured through this stub.
    // The key is LONG on purpose: secret-scrub.ts's MIN_KEY is 12, so a short fake is not secret-shaped and a row built
    // on one would pass without measuring a scrub. It is also the stored key, which is what forModel is given to remove.
    const KEY = "sk-test-0123456789abcdef";
    harnessApiKey = KEY;
    tailAnswer = { running: true, text: `warming up\n${KEY}\n` };
    const c = await detached({ expectMs: 40 });
    assert.ok(!c.r.tail.includes(KEY), `the detached answer's tail carried the API key: ${JSON.stringify(c.r.tail)}`);
    assert.ok(!String(c.r.text ?? "").includes(KEY), "the detached answer's text carried it");
    // Control: the instrument's ring really held the key, so the assertions above measured a scrub.
    assert.ok(pyTailText(tailAnswer.text, 20, 1e6).text.includes(KEY), "positive control: the ring held the key");
    const tail = await taskAction(c.runId, { op: "tail", id: c.r.id, lines: 20 });
    assert.equal(typeof tail, "string");
    assert.ok(!tail.includes(KEY), `task tail carried the API key: ${JSON.stringify(tail)}`);
    tailAnswer = { running: true, text: "" };
    c.resolve({ out: "ok" });
    await until(() => c.inbox().length > 0);
    await done(c);
});

// --- 5. the turn's end ---
// Mutation measured (not committed): replace endTasks' `t.status === "running"` filter with an always-false predicate, and no
// PY_CANCEL is sent: this row fails on the empty cancel list (and would leave the kernel locked).


test("the turn's end cancels the cell it left detached, and a result that lands after it reaches no model", T, async () => {
    // Rule 4: a detached call never outlives its run. The lane pins that endTasks sends PY_CANCEL; what the red team
    // adds is the model's side of it: the inbox is closed first, so a reply arriving afterwards is dropped, and the
    // kernel is free again for the next turn.
    const c = await detached();
    const before = sent.length;
    await endTasks(c.runId);
    assert.deepEqual(sent.slice(before).filter((m) => m.type === "PY_CANCEL").map((m) => m.cell), [c.id], "the turn's end did not cancel the cell");
    c.resolve({ out: "late" });
    await sleep(30);
    assert.deepEqual(c.inbox(), [], "a result reached the run's inbox after its turn ended");
    assert.equal(pyKernelBusy(c.runId), null, "the run's kernel stayed locked past its turn");
    runControllers.delete(c.runId);
    runInboxes.delete(c.runId);
});
