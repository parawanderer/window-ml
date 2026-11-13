// redteam-tasks-survive-turn.test.mjs — the red team's pass on ASYNC_CALLS.md rule 4b, slice A (#1810): the surface a
// task that OUTLIVES its turn adds (src/sw/sw-tasks.ts `closeTurnTasks`/`openTasks`/`endTasks`, src/sw/sw-python-task.ts
// `detachedCells`, src/sw/sw-run-host.ts `settle`; docs/spec/ASYNC_CALLS.md, rule 4b "When a task ends" and the parking
// half of "Durable": `ml.sh` and `python_exec` detached, not the durable slice B).
//
// What must not be reachable, each a row:
//   A. a parked result (one that finished between turns) reaches the NEXT turn of ITS OWN run exactly once — never
//      another run's turn, which must not receive it, drain it or await it, and never a third turn after delivery.
//      (The own-run, once-and-once half is the lane's row; here it is the control that makes the cross-run half a
//      measurement rather than a refusal of nothing.);//   B. a parked result does not outlive the session: after a release or an archive, no later turn of the run receives
//      it (endTasks deletes the table, so there is nothing to queue);
//   C. the kernel lock a detached cell holds into the next turns is ITS RUN'S: another run's cell settling leaves this
//      run's lock in place, and each lock is released when its own cell ends;
//   D. the parked path adds no page surface: `PY_END_TURN` and `PY_DELETE_RUN`, the two messages the turn's end and a
//      run's release send the offscreen document, are absent from the relay tables and reach nothing when a page posts
//      them.
//
// Not duplicated here, because another file pins it: parking, exactly-once and the third turn within ONE run
// (tests/sh-lease.test.mjs, "a result that arrives between turns is parked…"), a Stop after a cell detached not
// cancelling it (tests/python-lease.test.mjs, "a Stop after the cell detached does not send PY_CANCEL"), release and
// archive ending a RUNNING task (same file, the two rows above the Stop pair), the four cell messages on the page
// (tests/redteam-python-lease.test.mjs row 1 — this file's D covers the two NEW types only), another run's task handle
// under hostile id shapes (tests/redteam-task.test.mjs), and the 5 min `PY_DETACHED_MAX_MS` ceiling armed at a cell's
// start (tests/python-lease-offscreen.test.mjs).
//
// TWO harnesses, as redteam-python-lease.test.mjs does: rows A-C drive the REAL sw-tasks and sw-python-task modules under
// python-lease.test.mjs's `globalThis.chrome` mock (copied below, with its `cell`/`detached`/`sent`/`until`), and row D
// drives the ROUTER in a vm (helpers.js `loadBackground`), whose own copy of the modules shares no state with them.
//
// Mutations measured for each row are noted above it. Each was applied alone to the branch, the row re-run (with
// `node build.mjs` first where the mutation is in a file the vm loads), and reverted.

// MEASURED AT b122899e (the branch head this file was written on, after `node build.mjs`; run 20261113T101652-e8d8c7,
// one leg per row, the sources restored between legs): baseline 4/4 green. Row A red on "another run's turn was handed
// this run's parked result" with `openTasks` reading every run's table, and on "a delivered parked result was queued
// again into a later turn" with the `!t.delivered` filter dropped. Row B red on "a session-release run's parked result
// was queued into a later turn" with `endTasks`'s `tasks.delete(runId)` removed. Row C red on "another run's cell
// settling freed this run's kernel lock" with the settle's guarded delete replaced by `detachedCells.clear()`. Row D
// red on "PY_END_TURN is in PAGE_STARTED_TYPES" with the type added to PAGE_RELAYED_EXTRA. The tree held only this
// file after each leg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");
const { HANDLE_MAP, PAGE_STARTED_TYPES, PAGE_UNGATED_TYPES, RUN_CONTROL_TYPES } = require("../src/page-relay.ts");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });

// ===== the real-module harness (python-lease.test.mjs's, copied: see the header) =====

const T = { timeout: 20000 };
const EXT = "ext-id";
const sent = [];
const session = {};
globalThis.chrome = {
    runtime: {
        id: EXT, lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => `chrome-extension://${EXT}/${p}`,
        sendMessage: async (m) => {
            sent.push(JSON.parse(JSON.stringify(m)));
            if (m.type === "PY_CANCEL") return { how: "interrupted" };
            if (m.type === "PY_TAIL") return { running: true, text: "" };
            return { ok: true, stdout: "" };
        },
    },
    offscreen: { hasDocument: async () => true },
    storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), chatUrl: "http://host/api/chat/completions", apiKey: "sk-test" }), set: async () => {} },
        session: {
            get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k ?? session); return Object.fromEntries(keys.filter((x) => x in session).map((x) => [x, session[x]])); },
            set: async (o) => { Object.assign(session, JSON.parse(JSON.stringify(o))); }, remove: async (k) => { for (const x of [k].flat()) delete session[x]; },
        },
        onChanged: { addListener() {} },
    },
    tabs: {},
};
const { leaseCell, pyKernelBusy } = await import("../src/sw/sw-python-task.ts");
const { pythonStarted } = await import("../src/sw/sw-python.ts");
const { taskAction, endTasks, closeTurnTasks, openTasks, taskDrained } = await import("../src/sw/sw-tasks.ts");
const { runControllers, runInboxes } = await import("../src/sw/sw-runs.ts");
const { runLog } = await import("../src/sw/sw-run-log.ts");

const OFFSCREEN = { id: EXT, url: `chrome-extension://${EXT}/offscreen.html` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(10); } };

let n = 0;
/** One leased cell in a live run: its call is a promise the test settles, its inbox is open, a controller is registered. */
function cell(o = {}) {
    n++;
    const runId = o.runId ?? `run-tst-${n}`;
    const id = `cell-${n}`;
    const ctl = new AbortController();
    runControllers.set(runId, ctl);
    runInboxes.set(runId, { tabId: 7, queue: [] });
    openTasks(runId, () => {});
    let ok, err;
    const call = new Promise((res, rej) => { ok = res; err = rej; });
    const answer = leaseCell({
        runId, cell: id, expectMs: o.expectMs ?? null, call, onDetach: () => {},
        late: async (r) => ({ status: "done", text: `out: ${r.out}`, result: null }),
    });
    return { runId, id, ctl, answer, resolve: ok, reject: err, start: () => pythonStarted({ type: "PY_STARTED", cell: id }, OFFSCREEN) };
}
/** Detach a fresh cell and return it with its detached answer. */
async function detached(o = {}) {
    const c = cell({ expectMs: 30, ...o });
    c.start();
    const r = await c.answer;
    assert.ok(r.detached, JSON.stringify(r));
    return { ...c, r: r.detached };
}
/** End a turn the way the run host does: close the inbox, then `closeTurnTasks`. */
function closeTurn(runId) { runInboxes.delete(runId); closeTurnTasks(runId); }
/** Open a next turn and return its inbox. */
function openTurn(runId, tabId = 7) { const inbox = { tabId, queue: [] }; runInboxes.set(runId, inbox); openTasks(runId, () => {}); return inbox; }
const parkedOf = async (runId) => (await runLog.forRun(runId)).filter((e) => e.subsystem === "task" && e.kind === "parked");

// --- A. a parked result: its own run's next turn, once, and no other run's ---
// Mutation measured (not committed): `openTasks` scanning every run's table (`[...tasks.values()]`) instead of
// `tasks.get(runId)` hands another run A's parked result; dropping the `!t.delivered` filter queues it into a THIRD turn.

test("RED TEAM: a parked result is queued into its own run's next turn exactly once, and another run's turn never receives, drains or awaits it", T, async () => {
    const a = await detached();
    closeTurn(a.runId);
    a.resolve({ out: "between turns" });
    await until(async () => (await parkedOf(a.runId)).length === 1);

    // Another run's turn opens first, with its own id, controller and inbox.
    const bId = "run-other-holder";
    runControllers.set(bId, new AbortController());
    const bInbox = openTurn(bId, 8);
    assert.deepEqual(bInbox.queue, [], "another run's turn was handed this run's parked result");
    assert.doesNotMatch(JSON.stringify(bInbox.queue), new RegExp(a.r.id));
    // And it cannot take it by other means: the drain is the run's, the handle is the run's.
    assert.equal(taskDrained(bId, a.r.id, `[task ${a.r.id} done after 1 s: out: between turns]`), false, "another run marked the parked result delivered");
    assert.match(await taskAction(bId, { op: "await", id: a.r.id, timeout_ms: 10 }), /^UnknownTask/, "another run awaited the parked result");

    // Its own next turn: queued once, with the task's id, and delivered once.
    const next = openTurn(a.runId);
    assert.equal(next.queue.length, 1, `the own run's next turn did not get its parked result (${JSON.stringify(next.queue)})`);
    assert.equal(next.queue[0].task, a.r.id);
    assert.equal(taskDrained(a.runId, a.r.id, next.queue[0].text), true, "the queued parked result could not be drained");
    // A third turn of the same run gets nothing: the result was delivered, not re-queued.
    const third = openTurn(a.runId);
    assert.deepEqual(third.queue, [], "a delivered parked result was queued again into a later turn");
    runControllers.delete(bId); runInboxes.delete(bId);
    await endTasks(a.runId);
});

// --- B. a parked result does not outlive its session ---
// Mutation measured (not committed): `endTasks` keeping the table (the `tasks.delete(runId)` line removed) leaves the
// parked entry for the next turn's `openTasks` to queue, so the released run's result arrives after release.

test("RED TEAM: a release or an archive ends a parked result — no later turn of the run receives it", T, async () => {
    for (const reason of [undefined, "archived"]) {
        const a = await detached();
        closeTurn(a.runId);
        a.resolve({ out: "finished after the turn, before the end" });
        await until(async () => (await parkedOf(a.runId)).length === 1);
        assert.equal((await parkedOf(a.runId)).length, 1, "positive control: the result is parked before the session ends");
        await endTasks(a.runId, reason);
        const next = openTurn(a.runId);
        assert.deepEqual(next.queue, [], `a ${reason ?? "session-release"} run's parked result was queued into a later turn`);
        assert.match(await taskAction(a.runId, { op: "await", id: a.r.id, timeout_ms: 10 }), /^UnknownTask/, "an ended session still holds a task table");
        runInboxes.delete(a.runId);
    }
});

// --- C. the kernel lock is the run's, and only its own cell frees it ---
// Mutation measured (not committed): one shared `busy` slot (or `detachedCells.clear()` in the settle's `finally`), and
// another run's cell settling frees THIS run's lock: the "still locked" assertion fails.

test("RED TEAM: another run's detached cell settling leaves this run's kernel lock in place, and each lock releases with its own cell", T, async () => {
    const a = await detached();
    const b = await detached({ runId: "run-lock-other" });
    assert.match(pyKernelBusy(a.runId), new RegExp(`task ${a.r.id}`), "positive control: this run's lock names its own task");
    assert.match(pyKernelBusy(b.runId), new RegExp(`task ${b.r.id}`), "positive control: the other run's lock names its own task");
    assert.doesNotMatch(String(pyKernelBusy(b.runId)), new RegExp(a.r.id), "this run's task id appeared in another run's lock");
    // The other run's cell ends first: its lock goes, this run's stays.
    b.resolve({ out: "b" });
    await until(() => pyKernelBusy(b.runId) === null);
    assert.match(pyKernelBusy(a.runId), new RegExp(`task ${a.r.id}`), "another run's cell settling freed this run's kernel lock");
    // And this run's own end releases its own.
    a.resolve({ out: "a" });
    await until(() => pyKernelBusy(a.runId) === null);
    await endTasks(a.runId); await endTasks(b.runId);
});

// --- D. no page surface: the turn's end and a run's release are the worker's to send ---
// Mutation measured (not committed): listing `PY_END_TURN` (or `PY_DELETE_RUN`) in HANDLE_MAP or PAGE_STARTED_TYPES
// relays a page's message; a router branch that forwards either sends it on to the offscreen document. The table
// assertion fails first, the forward assertion second.

test("RED TEAM: PY_END_TURN and PY_DELETE_RUN reach nothing from a page: absent from the relay tables, forwarded by no router branch", async () => {
    // PY_END_TURN with ms=0 reaps a run's Python namespace at once; PY_DELETE_RUN drops it outright. A page reaching
    // either would be a confused deputy over the name-space a run is relying on between its turns.
    const WORKER_ONLY = ["PY_END_TURN", "PY_DELETE_RUN"];
    const mapped = Object.entries(HANDLE_MAP).flatMap(([k, v]) => [k, v.type, v.responseType]);
    for (const t of WORKER_ONLY) {
        assert.ok(!mapped.some((m) => String(m).startsWith(t)), `${t} is in HANDLE_MAP`);
        for (const [name, set] of [["PAGE_STARTED_TYPES", PAGE_STARTED_TYPES], ["PAGE_UNGATED_TYPES", PAGE_UNGATED_TYPES], ["RUN_CONTROL_TYPES", RUN_CONTROL_TYPES]]) assert.ok(!set.has(t), `${t} is in ${name}`);
    }
    // The router itself: a page that approves itself posts them straight at the background, and the offscreen document —
    // where a turn's end and a run's release are acted on — receives none of them.
    const bg = loadBackground({ config: baseConfig(), local: { ml_site_schema: 2, ml_site_selfapprove: ["https://evil.example"] } });
    const page = { tab: { id: 9 }, url: "https://evil.example/attack" };
    for (const t of WORKER_ONLY) await Promise.race([bg.send({ type: t, run: "run-victim", ms: 0 }, page), sleep(5)]);
    assert.deepEqual(bg.runtimeSent.filter((m) => WORKER_ONLY.includes(m?.type)), [], "the worker forwarded a page's worker-only message");
    assert.deepEqual([...bg.pyEnds, ...bg.pyDeletes], [], "the offscreen document was told to end a turn or drop a namespace a page named");
    // Positive control: the same instrument sees the page's honest Python call reach the offscreen document.
    await bg.send({ type: "PYTHON_EXEC", payload: { code: "1+1" } }, page);
    assert.ok(bg.runtimeSent.some((m) => m?.type === "PY_RUN"), "positive control: the page's PYTHON_EXEC reached the offscreen document");
});
