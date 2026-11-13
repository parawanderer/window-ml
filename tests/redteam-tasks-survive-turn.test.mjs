// redteam-tasks-survive-turn.test.mjs — the red team's pass on ASYNC_CALLS.md rule 4b, slice A (#1810) and slice B
// (#1854): the surface a task that OUTLIVES its turn adds (src/sw/sw-tasks.ts `closeTurnTasks`/`openTasks`/`endTasks`,
// `persist`/`hydrateTasks`/`readBack`, src/sw/sw-python-task.ts `detachedCells`, src/sw/sw-python.ts `pythonDone`,
// src/offscreen.ts's held-result ring; docs/spec/ASYNC_CALLS.md, rule 4b "When a task ends" and "Durable" in full).
//
// What must not be reachable, each a row:
//   A. a parked result (one that finished between turns) reaches the NEXT turn of ITS OWN run exactly once — never
//      another run's turn, which must not receive it, drain it or await it, and never a third turn after delivery.
//      (The own-run, once-and-once half is the lane's row; here it is the control that makes the cross-run half a
//      measurement rather than a refusal of nothing.)
//   B. a parked result does not outlive the session: after a release or an archive, no later turn of the run receives
//      it (endTasks deletes the table, so there is nothing to queue);
//   C. the kernel lock a detached cell holds into the next turns is ITS RUN'S: another run's cell settling leaves this
//      run's lock in place, and each lock is released when its own cell ends;
//   D. the parked path adds no page surface: `PY_END_TURN` and `PY_DELETE_RUN`, the two messages the turn's end and a
//      run's release send the offscreen document, are absent from the relay tables and reach nothing when a page posts
//      them;
//   E. the DURABLE table (slice B, `ml_tasks:<runId>`) is no page's to read or write under any page-started type or
//      relayed request shape, and no message a page sends writes the cap (`detachedTaskMaxMin`) or any setting but the
//      model;
//   F. a detached cell's held result is handed to the run whose STORED ROW names it, once: another run's `PY_DONE`
//      settles nothing and uses up nothing, and after the run's end no late `PY_DONE` puts the row or the table back.
//
// Not duplicated here, because another file pins it: parking, exactly-once and the third turn within ONE run
// (tests/sh-lease.test.mjs, "a result that arrives between turns is parked…"), a Stop after a cell detached not
// cancelling it (tests/python-lease.test.mjs, "a Stop after the cell detached does not send PY_CANCEL"), release and
// archive ending a RUNNING task (same file, the two rows above the Stop pair), the FIVE cell messages on the page
// (tests/redteam-python-lease.test.mjs row 1, `PY_RESULT` included — this file's D covers the two NEW types only),
// another run's task handle under hostile id shapes (tests/redteam-task.test.mjs), the ceiling (`PY_DETACHED_MAX_MS`,
// 60 min) armed at a cell's start and the person's cap clamped to it (tests/python-lease-offscreen.test.mjs), and the
// cap's own 1..60 reading (tests/python-lease.test.mjs).
//
// TWO harnesses, as redteam-python-lease.test.mjs does: rows A-C and F drive the REAL sw-tasks, sw-python-task and
// sw-python modules under python-lease.test.mjs's `globalThis.chrome` mock (copied below, with its
// `cell`/`detached`/`sent`/`until`), and rows D and E drive the ROUTER in a vm (helpers.js `loadBackground`), whose own
// copy of the modules shares no state with them.
//
// Mutations measured for each row are noted above it. Each was applied alone to the branch, the row re-run (with
// `node build.mjs` first where the mutation is in a file the vm loads), and reverted.

// MEASURED AT b122899e (slice A's head; run 20261113T101652-e8d8c7, one leg per row, the sources restored between
// legs): baseline 4/4 green. Row A red on "another run's turn was handed this run's parked result" with `openTasks`
// reading every run's table, and on "a delivered parked result was queued again into a later turn" with the
// `!t.delivered` filter dropped. Row B red on "a session-release run's parked result was queued into a later turn" with
// `endTasks`'s `tasks.delete(runId)` removed. Row C red on "another run's cell settling freed this run's kernel lock"
// with the settle's guarded delete replaced by `detachedCells.clear()`. Row D red on "PY_END_TURN is in
// PAGE_STARTED_TYPES" with the type added to PAGE_RELAYED_EXTRA.
//
// MEASURED AT 0f789112 (slice B's head, rows E and F, each leg alone with `node build.mjs` where the mutation is in a
// file the vm loads, sources restored after each; baseline 8/8 green): E1 red on "an answer to a page carried a run's
// parked output" with a router branch answering a page's `GET_MODEL` carrying a run id from `ml_tasks:<runId>`, and on
// "a page's message changed a stored task row" with that branch writing a row built from the payload. E2 red on "a
// page's message set the cap" with a router branch writing `payload.config` to sync storage. F1 red on "another run's
// PY_DONE asked for this run's held result" with `pythonDone` hydrating EVERY `ml_tasks:` key and `rehydratedCellTask`
// scanning every run's table (the pair is one defect: the run the message NAMES is not the run whose row names the
// cell). F2 red on "a released run's table was written back" with `pythonDone`'s no-row branch persisting a row built
// from the message. `PY_RESULT`'s router-branch mutation is row 1 of tests/redteam-python-lease.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground, jsonResponse } = require("./helpers");
const { HANDLE_MAP, PAGE_STARTED_TYPES, PAGE_UNGATED_TYPES, RUN_CONTROL_TYPES } = require("../src/page-relay.ts");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });

// ===== the real-module harness (python-lease.test.mjs's, copied: see the header) =====

const T = { timeout: 20000 };
const EXT = "ext-id";
const sent = [];
const session = {};
/** What the offscreen document answers a `PY_RESULT` with: a held cell result, or none (`{ result: null }`). */
let resultAnswer = { result: null };
globalThis.chrome = {
    runtime: {
        id: EXT, lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => `chrome-extension://${EXT}/${p}`,
        sendMessage: async (m) => {
            sent.push(JSON.parse(JSON.stringify(m)));
            if (m.type === "PY_CANCEL") return { how: "interrupted" };
            if (m.type === "PY_TAIL") return { running: true, text: "" };
            if (m.type === "PY_RESULT") return resultAnswer;
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
const { leaseCell, pyKernelBusy, dropPyTaskMemory } = await import("../src/sw/sw-python-task.ts");
const { pythonStarted, pythonDone } = await import("../src/sw/sw-python.ts");
const { taskAction, endTasks, closeTurnTasks, openTasks, taskDrained, dropAllTaskMemory } = await import("../src/sw/sw-tasks.ts");
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
/** What a worker eviction does to this realm: the task table and the kernel lock go, the stored copy stays. */
const evict = () => { dropAllTaskMemory(); dropPyTaskMemory(); };

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

// --- E. the durable table (slice B) and the cap: no page surface ---
// Mutations measured at 0f789112 (not committed, each alone, sources restored): a router branch that answers a page's
// run-scoped type from `ml_tasks:<runId>` hands it a run's parked output (E1 reds on "an answer to a page carried a
// run's parked output"); a branch that persists a row from the payload writes one the next turn hydrates as real (E1
// reds on "a page's message changed a stored task row"); a branch that writes the payload's `config` sets the cap from a
// page (E2 reds on "a page's message set the cap"). The positive controls fail if the instruments see nothing.

/** Every shape a page can put on the wire carrying `payload`: each page-started type bare and wrapped as
 *  `{requestId, payload}`, and each HANDLE_MAP request in its page form and as the background type it maps to. */
const pageShapes = (payload) => [
    ...[...PAGE_STARTED_TYPES].flatMap((t) => [{ type: t, ...payload }, { type: t, requestId: "r1", payload }]),
    ...Object.entries(HANDLE_MAP).flatMap(([k, v]) => [{ type: k, requestId: "r1", payload }, { type: v.type, requestId: "r1", payload }]),
];

/** Ask the vm router as a page, never hanging: a handler that keeps the channel open answers `undefined` after 5 ms. */
const askPage = (bg, page) => async (m) => { try { return await Promise.race([bg.send(m, page), sleep(5)]); } catch (e) { return { threw: String(e?.message || e) }; } };

test("RED TEAM: a page cannot read or write a run's stored task table, under any page-started type or relayed request shape", async () => {
    // The table is a run's parked python_exec output in session storage. A page that could tail it would read another
    // run's output; one that could write it would be handed that output as its own run's next turn.
    const ROW = { v: 1, id: "t00victim", tool: "python_exec", startedMs: 1, leaseMs: 1, expectMs: null, status: "done", result: null, text: "SECRET-PARKED-OUTPUT", delivered: false, endedMs: 2, code: null, ref: { kind: "py", cell: "wpy-victim" } };
    const bg = loadBackground({ config: baseConfig(), session: { "ml_tasks:run-victim": [ROW] }, local: { ml_site_schema: 2, ml_site_selfapprove: ["https://evil.example"] } });
    const page = { tab: { id: 9 }, url: "https://evil.example/attack" };
    assert.equal(bg.sessionStore["ml_tasks:run-victim"][0].text, "SECRET-PARKED-OUTPUT", "positive control: the instrument reads the table the page must not");
    const ask = askPage(bg, page);
    const answers = [];
    for (const m of pageShapes({ run: "run-victim", runId: "run-victim", id: "t00victim", task: "t00victim", op: "tail", lines: 50 })) answers.push(await ask(m));
    assert.deepEqual(answers.filter((a) => JSON.stringify(a ?? null).includes("SECRET-PARKED-OUTPUT")), [], "an answer to a page carried a run's parked output");
    assert.equal(JSON.stringify([...bg.runtimeSent, ...bg.tabMessages]).includes("SECRET-PARKED-OUTPUT"), false, "the worker sent a run's parked output outward");
    assert.deepEqual(bg.sessionStore["ml_tasks:run-victim"], [ROW], "a page's message changed a stored task row");
    assert.deepEqual(Object.keys(bg.sessionStore).filter((k) => k.startsWith("ml_tasks:")), ["ml_tasks:run-victim"], "a page's message created a stored task row");
    // Positive control: the scan does see the answers a page gets, carrying the values that are its own to read.
    assert.equal((await ask({ type: "GET_MODEL", payload: {} })).data, bg.stored.model, "positive control: a page's answer is captured by the scan");
});

test("RED TEAM: no page-started or relayed message writes the cap (`detachedTaskMaxMin`) or any setting but the model", async () => {
    // The cap bounds how long a detached cell may hold the person's kernel (1..60 min, DevTools Settings). A page that
    // could raise it hands itself a longer hold; one that could lower it ends every detached call early.
    // The control needs the server's list, since setModel validates the model against it: `/api/models` answers with the
    // one model the page is allowed to pick, and every other fetch is refused.
    const bg = loadBackground({ config: baseConfig({ detachedTaskMaxMin: 60 }), onFetch: (call) => (call.url.endsWith("/api/models") ? jsonResponse({ data: [{ id: "good-1" }] }) : { ok: false, status: 500, headers: { get: () => "text/plain" }, json: async () => ({}), text: async () => "" }), local: { ml_site_schema: 2, ml_site_selfapprove: ["https://evil.example"] } });
    const page = { tab: { id: 9 }, url: "https://evil.example/attack" };
    const ask = askPage(bg, page);
    const before = JSON.stringify(bg.stored);
    const carrying = { detachedTaskMaxMin: 1, config: { detachedTaskMaxMin: 1 }, overrides: { detachedTaskMaxMin: 1 }, settings: { detachedTaskMaxMin: 1 } };
    for (const m of pageShapes(carrying)) await ask(m);
    assert.equal(bg.stored.detachedTaskMaxMin, 60, "a page's message set the cap");
    assert.equal(JSON.stringify(bg.stored), before, "a page's message wrote a setting (only the model is a page's to change)");
    // Positive control: the model IS a page's to change, and the same instrument sees that write land.
    const set = await ask({ type: "SET_MODEL", payload: { model: "good-1" } });
    assert.equal(set.data, "good-1", `the control's SET_MODEL was refused: ${JSON.stringify(set)}`);
    assert.equal(bg.stored.model, "good-1", "positive control: the page's SET_MODEL write is visible in the store");
});

// --- F. a held result is handed to the run whose stored row names its cell, once ---
// Mutations measured at 0f789112 (not committed, each alone, sources restored): `pythonDone` hydrating every
// `ml_tasks:` key and `rehydratedCellTask` matching across every run's table instead of `tasks.get(runId)` — another
// run's PY_DONE asks the offscreen document for this run's held result (F1 reds on "another run's PY_DONE asked for
// this run's held result", the ring's one-shot read being what it spends). `pythonDone`'s no-row branch persisting a row
// built from the message — a released run's table comes back with a row nobody's worker wrote (F2 reds on "a released
// run's table was written back").

test("RED TEAM: another run's PY_DONE neither settles this run's stored row nor uses up the result held for it", T, async () => {
    const a = await detached();
    closeTurn(a.runId);                       // the turn is over; the row stays in the store
    evict();
    const key = `ml_tasks:${a.runId}`;
    assert.equal(session[key]?.[0]?.status, "running", "positive control: the row is stored as running");
    resultAnswer = { result: { ok: true, stdout: "hello\n", value: 42 } };
    const b = sent.length;
    await pythonDone({ type: "PY_DONE", cell: a.id, run: "run-other" }, OFFSCREEN);
    assert.equal(session[key][0].status, "running", "another run's PY_DONE settled this run's row");
    assert.equal(sent.slice(b).some((m) => m.type === "PY_RESULT"), false, "another run's PY_DONE asked for this run's held result");
    // Its own run's PY_DONE then hands the held result into its stored row, so the ring still held it.
    await pythonDone({ type: "PY_DONE", cell: a.id, run: a.runId }, OFFSCREEN);
    await until(() => session[key][0].status === "done");
    assert.match(session[key][0].text, /hello/);
    assert.match(session[key][0].text, /42/);
    assert.match(session[key][0].text, /formatted after the service worker restarted/, "the late path's plain formatting");
    // Handed over ONCE: a second PY_DONE for the ended row asks for nothing again.
    const c = sent.length;
    await pythonDone({ type: "PY_DONE", cell: a.id, run: a.runId }, OFFSCREEN);
    assert.equal(sent.slice(c).some((m) => m.type === "PY_RESULT"), false, "a second PY_DONE asked for the result again");
    resultAnswer = { result: null };
    await endTasks(a.runId);
});

test("RED TEAM: after the run's end a late PY_DONE settles nothing and puts neither the table nor a fabricated row back", T, async () => {
    const a = await detached();
    closeTurn(a.runId);
    evict();
    await endTasks(a.runId);
    const key = `ml_tasks:${a.runId}`;
    assert.equal(session[key], undefined, "positive control: the run's end removed the table");
    resultAnswer = { result: { ok: true, stdout: "late", value: 1 } };
    const b = sent.length;
    const forged = { v: 1, id: "t00forged", tool: "python_exec", status: "done", text: "FORGED-ROW", delivered: false };
    await pythonDone({ type: "PY_DONE", cell: a.id, run: a.runId, ok: true, bytes: 1, row: forged, rows: [forged], text: "FORGED-ROW" }, OFFSCREEN);
    assert.equal(session[key], undefined, "a released run's table was written back");
    assert.equal(sent.slice(b).some((m) => m.type === "PY_RESULT"), false, "a released run's result was asked for");
    assert.equal(JSON.stringify(session).includes("FORGED-ROW"), false, "a row a message carried was stored");
    const next = openTurn(a.runId);
    assert.deepEqual(next.queue, [], "a released run's late result was queued into a later turn");
    runInboxes.delete(a.runId);
    resultAnswer = { result: null };
});
