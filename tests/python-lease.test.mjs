// python-lease.test.mjs — mode 1 of docs/spec/ASYNC_CALLS.md on python_exec: a worker-hosted run's cell that outruns its
// lease detaches into a task (sw-python-task.ts `leaseCell`), the kernel lock, the late result, the cancel and the tail
// through the task table (sw-tasks.ts), a Stop, the turn's end, and the pure rules of py-lease.ts.
//
// The real worker modules under a mocked `chrome`: `runtime.sendMessage` records what the worker asks the offscreen
// document (PY_CANCEL, PY_TAIL, PY_RUN) and answers with what a test chose. The cell's own run is a promise the test
// settles; the lease starts when the test says PY_STARTED, as the offscreen document does. Real timers, small leases.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// A real value store (fake-indexeddb): a cut late result's whole is stored where its pointer reads it.
const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
globalThis.indexedDB = new IDBFactory();

const T = { timeout: 20000 };
const EXT = "ext-id";

const sent = [];
let cancelHow = "interrupted";
let tailAnswer = { running: true, text: "" };
let resultAnswer = { result: null };   // what the offscreen document answers PY_RESULT with
let syncExtra = {};   // settings the mocked sync storage holds beyond the defaults
let pyRunHold = null;   // set: PY_RUN answers this promise, so a cell stays in flight
const session = {};
globalThis.chrome = {
    runtime: {
        id: EXT, lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => `chrome-extension://${EXT}/${p}`,
        sendMessage: async (m) => {
            sent.push(JSON.parse(JSON.stringify(m)));
            if (m.type === "PY_CANCEL") return { how: cancelHow };
            if (m.type === "PY_TAIL") return tailAnswer;
            if (m.type === "PY_RESULT") return resultAnswer;
            if (m.type === "PY_RUN" && pyRunHold) return pyRunHold;
            return { ok: true, stdout: "" };
        },
    },
    offscreen: { hasDocument: async () => true },
    storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", ...syncExtra }), set: async () => {} },
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
const { taskAction, endTasks, closeTurnTasks, openTasks, taskDrained, cancelPageTasks, hydrateTasks, dropAllTaskMemory, detachedCapMs, capMinutes } = await import("../src/sw/sw-tasks.ts");
const { dropPyTaskMemory } = await import("../src/sw/sw-python-task.ts");
const { resetStateRegistry } = await import("../src/state-registry.ts");
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
 * `late` formats the result the way python_exec's does (a stub that quotes it); `carry` adds the outcome's whole or image.
 * @param o expectMs, the run's id, and `carry`
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
        late: async (r) => { lates.push(r); return { status: "done", text: `out: ${r.out}`, result: null, ...(o.carry?.(r) ?? {}) }; },
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

// --- the lease: inside it a cell is a value; past it, started, it detaches ---

test("a cell that answers inside its lease resolves with its own result, with no task and no kernel lock", T, async () => {
    const c = cell({ expectMs: 5000 });
    c.start();
    c.resolve({ out: "hi" });
    assert.deepEqual(await c.answer, { out: "hi" });
    assert.equal(pyKernelBusy(c.runId), null);
    assert.match(await taskAction(c.runId, { op: "await", id: "t000000" }), /^UnknownTask/);
    assert.deepEqual(c.inbox(), []);
    assert.equal(c.detaches(), 0);
    await done(c);
});

test("the lease starts at PY_STARTED, not at the call: a cell that has not started is not detached after expectMs; started, it detaches after expectMs", T, async () => {
    const c = cell({ expectMs: 80 });
    let settled = false;
    c.answer.then(() => { settled = true; });
    await sleep(250);
    assert.equal(settled, false, "a cell still waiting for its runtime was detached");
    assert.equal(pyKernelBusy(c.runId), null);
    const t0 = Date.now();
    c.start();
    const r = await c.answer;
    assert.ok(r.detached, JSON.stringify(r));
    assert.ok(Date.now() - t0 >= 70, `detached ${Date.now() - t0} ms after its start, expected ~80`);
    await done(c);
});

test("past the lease the answer is {detached: {id, elapsedMs, tail, text}}, onDetach ran, and python/detached is in the run log", T, async () => {
    tailAnswer = { running: true, text: "step 1\nstep 2\n" };
    const c = await detached({ expectMs: 40, seq: 3 });
    assert.match(c.r.id, TASK_ID);
    assert.ok(c.r.elapsedMs >= 30, String(c.r.elapsedMs));
    assert.match(c.r.tail, /step 2/);
    assert.match(c.r.text, new RegExp(`task ${c.r.id}`));
    assert.match(c.r.text, /you expected ~0 s/);
    assert.match(c.r.text, /Output so far:\nstdout \(2 lines so far\):\nstep 1\nstep 2/);
    assert.equal(c.detaches(), 1);
    const rec = (await runLog.forRun(c.runId)).filter((e) => e.subsystem === "python" && e.kind === "detached");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].reason, "expected");
    assert.deepEqual(rec[0].detail, { seq: 3, id: c.r.id, leaseMs: 40, expectMs: 40 }, "the shell twin's { seq, id, leaseMs, expectMs? }");
    tailAnswer = { running: true, text: "" };
    await done(c);
});

test("python/detached with no expect_ms and no seq logs { id, leaseMs } with the default lease", T, async () => {
    const c = cell();
    mock.timers.enable({ apis: ["setTimeout"] });
    try { c.start(); mock.timers.tick(PY_LEASE_MS); } finally { mock.timers.reset(); }
    const r = await c.answer;
    assert.ok(r.detached, JSON.stringify(r));
    const rec = (await runLog.forRun(c.runId)).filter((e) => e.subsystem === "python" && e.kind === "detached");
    assert.equal(rec[0].reason, "default");
    assert.deepEqual(rec[0].detail, { id: r.detached.id, leaseMs: PY_LEASE_MS });
    await done(c);
});

test("an expect_ms at or over the detached ceiling still detaches, at half the ceiling, so the task keeps as long again to run", T, async () => {
    assert.equal(PY_LEASE_MAX_MS, 150_000, "the lease cap is fixed, not half the 60 min ceiling");
    assert.equal(PY_DETACHED_MAX_MS, 3_600_000);
    for (const expectMs of [PY_DETACHED_MAX_MS, PY_DETACHED_MAX_MS * 10]) {
        const c = cell({ expectMs });
        let settled = false;
        c.answer.then(() => { settled = true; });
        mock.timers.enable({ apis: ["setTimeout"] });
        try {
            c.start();
            mock.timers.tick(PY_LEASE_MAX_MS - 1);
            await Promise.resolve();
            assert.equal(settled, false, `expect_ms ${expectMs} detached before PY_LEASE_MAX_MS`);
            mock.timers.tick(1);
        } finally { mock.timers.reset(); }
        const r = await c.answer;
        assert.ok(r.detached, `expect_ms ${expectMs} never detached: ${JSON.stringify(r)}`);
        const rec = (await runLog.forRun(c.runId)).filter((e) => e.subsystem === "python" && e.kind === "detached");
        assert.equal(rec[0].detail.leaseMs, PY_LEASE_MAX_MS);
        assert.equal(rec[0].detail.expectMs, expectMs);
        assert.match(r.detached.text, new RegExp(`you expected ~${Math.round(expectMs / 1000)} s, and a cell runs attached for at most ${PY_LEASE_MAX_MS / 1000} s, so it is running as expected`));
        assert.doesNotMatch(r.detached.text, /stall/, "a cell the cap detached is not called stalled");
        await done(c);
    }
});

test("pyDetachedText says 'you expected ~N s' with expect_ms and 'no expect_ms was given' without it, and names the task, the end of the turn and the ceiling", () => {
    const withE = pyDetachedText("tabc123", 15_000, 45_000, "");
    assert.match(withE, /task tabc123 after 15 s/);
    assert.match(withE, /you expected ~45 s/);
    assert.doesNotMatch(withE, /no expect_ms/);
    assert.doesNotMatch(withE, /running as expected/, "an estimate the lease ran out on is a stall, not the cap");
    const capped = pyDetachedText("tabc123", PY_LEASE_MAX_MS, PY_LEASE_MAX_MS + 1000, "");
    assert.match(capped, new RegExp(`you expected ~${PY_LEASE_MAX_MS / 1000 + 1} s, and a cell runs attached for at most ${PY_LEASE_MAX_MS / 1000} s, so it is running as expected: wait for it, or use the task tool`));
    assert.doesNotMatch(capped, /stall|no expect_ms/);
    assert.match(pyDetachedText("tabc123", PY_LEASE_MAX_MS, PY_LEASE_MAX_MS, ""), /investigate the stall/, "an estimate equal to the cap ran out: a stall");
    assert.match(withE, /keeps running after your answer/);
    assert.match(withE, /read at the start of the next turn/);
    assert.doesNotMatch(withE, /turn ends/, "the turn no longer ends the task");
    assert.match(withE, /the sandbox ends it at 60 min/, "no cap given: the ceiling");
    assert.match(pyDetachedText("tabc123", 15_000, 45_000, "", 600_000), /the sandbox ends it at 10 min/, "the cap applied, not the ceiling");
    assert.match(pyDetachedText("tabc123", 15_000, 45_000, "", 90_000), /the sandbox ends it at 90 s/, "a cap that is not whole minutes is in seconds");
    assert.doesNotMatch(withE, /Output so far/);
    const without = pyDetachedText("tabc123", PY_LEASE_MS, null, "x");
    assert.match(without, /no expect_ms was given, so the \d+ s default applied/);
    assert.doesNotMatch(without, /you expected/);
    assert.match(without, /Output so far:\nx$/);
});

// --- the kernel lock ---

test("while a cell is detached pyKernelBusy names its task id; once the cell settles it is null again", T, async () => {
    const c = await detached();
    assert.match(pyKernelBusy(c.runId), new RegExp(`task ${c.r.id} is still running`));
    assert.equal(pyKernelBusy("some-other-run"), null, "another run's kernel is not locked");
    c.resolve({ out: "x" });
    await until(() => pyKernelBusy(c.runId) === null);
    await done(c);
});

test("the kernel stays locked into the next turn: after the turn settles pyKernelBusy still names the task", T, async () => {
    const c = await detached();
    runInboxes.delete(c.runId); runControllers.delete(c.runId); closeTurnTasks(c.runId);   // what settle does
    assert.match(pyKernelBusy(c.runId), new RegExp(`task ${c.r.id} is still running`));
    c.resolve({ out: "x" });
    await until(() => pyKernelBusy(c.runId) === null);
    await endTasks(c.runId);
});

// --- the late result ---

test("a result after detach goes through `late` and reaches the inbox as [task <id> done after N s: …]; an await instead gets it directly", T, async () => {
    const c = await detached();
    assert.deepEqual(c.inbox(), [], "nothing is queued while it runs");
    c.resolve({ out: "42" });
    await until(() => c.inbox().length > 0);
    assert.deepEqual(c.lates, [{ out: "42" }]);
    const [item] = c.inbox();
    assert.equal(item.task, c.r.id);
    assert.match(item.text, new RegExp(`^\\[task ${c.r.id} done after \\d+ s: out: 42\\]$`));
    assert.ok(taskDrained(c.runId, c.r.id, item.text));
    await done(c);

    const d = await detached();
    const waiting = taskAction(d.runId, { op: "await", id: d.r.id, timeout_ms: 5000 });
    await sleep(20);
    d.resolve({ out: "7" });
    assert.match(await waiting, new RegExp(`^task ${d.r.id} done after \\d+ s: out: 7$`));
    assert.deepEqual(d.inbox(), [], "an awaited result is not also queued");
    await done(d);
});

test("a cut late result's whole is scrubbed and stored, and the inbox carries its key, its length and its figure", T, async () => {
    const { readStoredText, claimValue } = await import("../src/sw/sw-values.ts");
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const whole = `${"row\n".repeat(2000)}at http://host/api/chat/completions end`;
    const c = await detached({ carry: () => ({ whole, image: png }) });
    c.resolve({ out: "cut" });
    await until(() => c.inbox().length > 0);
    const [item] = c.inbox();
    assert.equal(typeof item.value, "string", "the stored whole's key rides the inbox item");
    assert.equal(item.images?.[0], png, "the figure rides it as the call's own return would carry it");
    await claimValue(item.value, c.runId);
    const stored = await readStoredText(item.value, c.runId);
    assert.equal(item.chars, stored.length);
    assert.ok(stored.includes("end") && stored.length > item.text.length, "the store holds the whole, past the text");
    assert.ok(!stored.includes("http://host"), "the stored whole is scrubbed before it is stored");
    await done(c);
});

test("an await of a cut late result answers its text with the stored whole's key and length, and its figure", T, async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const d = await detached({ carry: () => ({ whole: "w".repeat(9000), image: png }) });
    const waiting = taskAction(d.runId, { op: "await", id: d.r.id, timeout_ms: 5000 });
    await sleep(20);
    d.resolve({ out: "7" });
    const a = await waiting;
    assert.equal(typeof a, "object", JSON.stringify(a));
    assert.match(a.content, new RegExp(`^task ${d.r.id} done after \\d+ s: out: 7$`));
    assert.equal(a.textChars, 9000);
    assert.equal(typeof a.textValue, "string");
    assert.equal(a.image, png);
    const again = await taskAction(d.runId, { op: "await", id: d.r.id });
    assert.equal(again.textValue, a.textValue, "an await after the end answers the same");
    await done(d);
});

test("a late whole no longer than its text is not stored: the answer is the text alone", T, async () => {
    const c = await detached({ carry: () => ({ whole: "out" }) });
    c.resolve({ out: "a much longer text than the whole" });
    await until(() => c.inbox().length > 0);
    assert.equal(c.inbox()[0].value, undefined);
    assert.equal(c.inbox()[0].images, undefined);
    await done(c);
});

test("a call that rejects after detach is a failed task whose text carries the error", T, async () => {
    const c = await detached();
    c.reject(new Error("sandbox exploded"));
    await until(() => c.inbox().length > 0);
    assert.match(c.inbox()[0].text, new RegExp(`^\\[task ${c.r.id} failed after \\d+ s: python_exec failed: sandbox exploded\\]$`));
    assert.deepEqual(c.lates, [], "`late` is for a result, not an error");
    assert.equal(pyKernelBusy(c.runId), null);
    await done(c);
});

test("a call that rejects inside its lease rejects the tool call", T, async () => {
    const c = cell({ expectMs: 5000 });
    c.start();
    c.reject(new Error("boom"));
    await assert.rejects(c.answer, /boom/);
    assert.equal(pyKernelBusy(c.runId), null);
    await done(c);
});

// --- cancel ---

test("task cancel sends PY_CANCEL for the cell; 'interrupted' says the names are kept, and the late result is recorded as cancelled", T, async () => {
    const c = await detached();
    cancelHow = "interrupted";
    const before = sentOf("PY_CANCEL").length;
    const text = await taskAction(c.runId, { op: "cancel", id: c.id === c.r.id ? "" : c.r.id });
    assert.equal(text, `task ${c.r.id}: ${pyCancelText("interrupted")}`);
    assert.match(text, /names are kept/);
    const cancels = sentOf("PY_CANCEL").slice(before);
    assert.deepEqual(cancels, [{ type: "PY_CANCEL", cell: c.id }]);
    c.resolve({ out: "KeyboardInterrupt" });
    await until(() => c.inbox().length > 0);
    assert.match(c.inbox()[0].text, new RegExp(`^\\[task ${c.r.id} cancelled after \\d+ s: interrupted \\(KeyboardInterrupt\\); its names are kept\\. out: KeyboardInterrupt\\]$`));
    await done(c);
});

test("task cancel answered 'killed' says the names are lost and names the interrupt bound", T, async () => {
    const c = await detached();
    cancelHow = "killed";
    const text = await taskAction(c.runId, { op: "cancel", id: c.r.id });
    cancelHow = "interrupted";
    assert.equal(text, `task ${c.r.id}: ${pyCancelText("killed")}`);
    assert.match(text, /names are lost/);
    assert.match(text, new RegExp(`within ${Math.round(PY_INTERRUPT_KILL_MS / 1000)} s of its interrupt`));
    assert.match(text, /terminated/);
    c.reject(new Error("worker terminated"));
    await until(() => c.inbox().length > 0);
    assert.match(c.inbox()[0].text, /^\[task \w+ cancelled after \d+ s: python_exec failed: worker terminated\]$/);
    await done(c);
});

test("task cancel answered 'ended' does not mark the task cancelled: a result that follows is a done task", T, async () => {
    const c = await detached();
    cancelHow = "ended";
    assert.equal(await taskAction(c.runId, { op: "cancel", id: c.r.id }), `task ${c.r.id}: it had already ended.`);
    cancelHow = "interrupted";
    c.resolve({ out: "finished" });
    await until(() => c.inbox().length > 0);
    assert.match(c.inbox()[0].text, new RegExp(`^\\[task ${c.r.id} done after \\d+ s: out: finished\\]$`));
    await done(c);
});

// --- tail ---

test("task tail sends PY_TAIL for the cell and returns the last `lines` lines under pyTailText's header", T, async () => {
    const c = await detached();
    tailAnswer = { running: true, text: "a\nb\nc\nd\n" };
    const before = sentOf("PY_TAIL").length;
    const text = await taskAction(c.runId, { op: "tail", id: c.r.id, lines: 2 });
    assert.deepEqual(sentOf("PY_TAIL").slice(before), [{ type: "PY_TAIL", cell: c.id }]);
    assert.equal(text, pyTailText("a\nb\nc\nd\n", 2, 1e6).text);
    assert.equal(text, "stdout (last 2 lines so far):\nc\nd");
    tailAnswer = { running: true, text: "" };
    await done(c);
});

test("task tail on a cell the offscreen document no longer runs answers 'It has just ended…'", T, async () => {
    const c = await detached();
    tailAnswer = { running: false };
    assert.match(await taskAction(c.runId, { op: "tail", id: c.r.id }), /^It has just ended; its result arrives on its own\.$/);
    tailAnswer = { running: true, text: "" };
    await done(c);
});

// --- Stop and the turn's end ---

test("a Stop while the cell is attached sends PY_CANCEL for it", T, async () => {
    const c = cell({ expectMs: 5000 });
    c.start();
    const before = sentOf("PY_CANCEL").length;
    c.ctl.abort();
    await until(() => sentOf("PY_CANCEL").length > before);
    assert.deepEqual(sentOf("PY_CANCEL").slice(before), [{ type: "PY_CANCEL", cell: c.id }]);
    c.resolve({ out: "KeyboardInterrupt" });
    assert.deepEqual(await c.answer, { out: "KeyboardInterrupt" }, "the tool call answers with the interrupted cell's result");
    await done(c);
});

test("a Stop after the cell detached does not send PY_CANCEL: the task is the model's to cancel (task cancel)", T, async () => {
    const c = await detached();
    const before = sentOf("PY_CANCEL").length;
    c.ctl.abort();
    await sleep(60);
    assert.equal(sentOf("PY_CANCEL").length, before);
    c.resolve({ out: "x" });
    await until(() => c.inbox().length > 0);
    await done(c);
});

test("endTasks (session release) on a run with a detached cell sends PY_CANCEL for it", T, async () => {
    const c = await detached();
    const before = sentOf("PY_CANCEL").length;
    await endTasks(c.runId);
    assert.deepEqual(sentOf("PY_CANCEL").slice(before), [{ type: "PY_CANCEL", cell: c.id }]);
    c.resolve({ out: "x" });
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
});

// --- PY_STARTED is trusted from our own offscreen document only, for a cell the worker leased ---

test("pythonStarted ignores a sender with a tab, a page sender and a cell nobody registered", T, async () => {
    const c = cell({ expectMs: 40 });
    let settled = false;
    c.answer.then(() => { settled = true; });
    pythonStarted({ type: "PY_STARTED", cell: c.id }, { ...OFFSCREEN, tab: { id: 3, url: "https://x.example/" } });
    pythonStarted({ type: "PY_STARTED", cell: c.id }, { id: EXT, url: "https://evil.example/", tab: { id: 3 } });
    pythonStarted({ type: "PY_STARTED", cell: c.id }, { url: "https://evil.example/" });
    pythonStarted({ type: "PY_STARTED", cell: c.id }, undefined);
    pythonStarted({ type: "PY_STARTED", cell: 12 }, OFFSCREEN);
    pythonStarted({ type: "PY_STARTED", cell: "nobody-registered" }, OFFSCREEN);
    pythonStarted(undefined, OFFSCREEN);
    await sleep(200);
    assert.equal(settled, false, "a refused sender started the lease");
    c.start();
    assert.ok((await c.answer).detached, "positive control: the extension's own document starts it");
    c.start();   // a second start for a forgotten cell is a no-op, not a throw
    await done(c);
});

// --- runPython puts the cell's id on PY_RUN only for a run the worker hosts ---

test("PY_RUN carries `cell` only when the caller also names a wireRun", T, async () => {
    const caller = (extra = {}) => ({ ownSurface: false, untrusted: async () => false, disclose: false, tabUrl: () => "", runGated: true, pyCodeOk: () => true, ...extra });
    const run = async (c) => { const b = sent.length; const r = await runPython({ code: "1" }, "req", c); return sent.slice(b).find((m) => m.type === "PY_RUN") ?? assert.fail(JSON.stringify(r)); };
    const leased = await run(caller({ wireRun: "run-w", cell: "cell-x" }));
    assert.ok(leased, "positive control: the cell was sent");
    assert.equal(leased.cell, "cell-x");
    const noWire = await run(caller({ cell: "cell-x" }));
    assert.ok(noWire);
    assert.equal("cell" in noWire, false, "a cell id from a caller that is no worker-hosted run");
    const noCell = await run(caller({ wireRun: "run-w" }));
    assert.ok(noCell);
    assert.equal("cell" in noCell, false);
});

// --- the pure rules: the tail text and the ring ---

test("pyTailText: an empty ring, fewer lines than asked, more than asked, and a cut at cap that starts with '…'", () => {
    assert.equal(pyTailText("", 5, 100).text, "stdout: nothing printed yet");
    assert.equal(pyTailText("a\nb\n", 5, 100).text, "stdout (2 lines so far):\na\nb");
    assert.equal(pyTailText("a\nb\nc\nd", 2, 100).text, "stdout (last 2 lines so far):\nc\nd");
    assert.equal(pyTailText("a\r\nb\r\n", 5, 100).text, "stdout (2 lines so far):\na\nb");
    assert.equal(pyTailText("a\nb", 0, 100).text, "stdout (last 1 lines so far):\nb", "lines below 1 read as 1");
    const cut = pyTailText("first\n" + "x".repeat(50), 5, 10);
    assert.equal(cut.cut, true);
    assert.equal(cut.text, `stdout (2 lines so far):\n…${"x".repeat(10)}`);
    assert.match(cut.whole, /first\n/, "`whole` keeps everything the cut dropped");
    assert.equal(pyTailText("a\nb", 5, 100).cut, false);
    // a cut that would start in the middle of a surrogate pair drops the orphan half
    const emoji = pyTailText("😀😀", 1, 3);
    assert.equal(emoji.text, "stdout (1 lines so far):\n…😀");
});

test("ringAppend keeps at most `max` characters, and cuts at a line start when one is within 200 characters", () => {
    assert.equal(ringAppend("ab", "cd", 10), "abcd");
    assert.equal(ringAppend("ab", "cd", 3).length, 3);
    assert.equal(ringAppend("ab", "cd", 3), "bcd");
    // a newline near the cut: the ring starts at the line after it
    assert.equal(ringAppend("0123456789\nABCDEF", "GH\n", 12), "ABCDEFGH\n");
    // no newline within 200 characters of the cut: a hard cut
    const long = "x".repeat(500) + "\n" + "y".repeat(10);
    assert.equal(ringAppend("", long, 400).length, 400);
    // a newline at index 200 of the cut is too far: a hard cut
    const far = "a".repeat(300) + "\n" + "b".repeat(99);
    const farCut = ringAppend("", far, 300);
    assert.equal(farCut, far.slice(100));
    assert.equal(farCut.length, 300);
    assert.equal(ringAppend("", "", 5), "");
    assert.ok(ringAppend("q".repeat(100_000), "z").length <= 64 * 1024, "the default bound");
});

// --- which runs are offered task ---

test("task is offered wherever a call can detach: ml.sh turned on, or python_exec among the run's tools; otherwise not", async () => {
    const { offersTask } = await import("../src/tools/task-tool.ts");
    assert.equal(offersTask(true, ["exec"]), true, "the shell on");
    assert.equal(offersTask(false, ["exec", "python_exec"]), true, "a python-only run, whose cell can detach");
    assert.equal(offersTask(false, ["exec", "fetch_url"]), false, "neither: nothing can detach, and the description costs tokens");
    assert.equal(offersTask(false, []), false);
});

// --- python_exec's own formatter for a late result ---

/** python_exec built on a fake `ml`: `worker` gives it the worker's `_mintToken` (a worker-hosted run), whose cells lease. */
async function pyTool({ worker = true, answer = { detached: { text: "Detached: python_exec detached as task t000001" } } } = {}) {
    const { buildPythonTool } = await import("../src/python/python-tool.ts");
    const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
    const seen = {};
    const ml = { defineTool, _queryAll: () => [], pythonExec: async (code, opts) => { seen.opts = opts; return answer; }, ...(worker ? { _mintToken: async () => "@pt:abcdef12" } : {}) };
    return { tool: buildPythonTool(ml), seen };
}

test("a worker-hosted run's python_exec leases: it passes its formatter and expect_ms, and answers the detached text", async () => {
    const { tool, seen } = await pyTool();
    assert.ok(tool.parameters.properties.expect_ms, "expect_ms is offered");
    assert.match(tool.parameters.properties.expect_ms.description, new RegExp(`At most ${PY_LEASE_MAX_MS / 1000} s`), "the description states the cap");
    const out = await tool.run({ code: "x", expect_ms: 4000 });
    assert.equal(out, "Detached: python_exec detached as task t000001");
    assert.equal(typeof seen.opts.late, "function");
    assert.equal(seen.opts.expectMs, 4000);
});

test("a page-hosted run's python_exec does not lease: no formatter, no expectMs, no expect_ms parameter", async () => {
    const { tool, seen } = await pyTool({ worker: false, answer: { ok: true, stdout: "", value: 1 } });
    assert.equal(tool.parameters.properties.expect_ms, undefined);
    await tool.run({ code: "x", expect_ms: 4000 });
    assert.equal(seen.opts.late, undefined);
    assert.equal(seen.opts.expectMs, undefined);
});

test("a late result is the formatter's text: done, or failed for a Python error; the pointer is minted where it is read, not here", async () => {
    const { tool, seen } = await pyTool();
    await tool.run({ code: "x" });
    const ok = await seen.opts.late({ ok: true, stdout: "hi\n", value: 42 });
    assert.equal(ok.status, "done");
    assert.equal(ok.result, null);
    assert.match(ok.text, /stdout:\nhi/);
    assert.match(ok.text, /42/);
    const bad = await seen.opts.late({ ok: false, stdout: "", error: "ZeroDivisionError: division by zero" });
    assert.equal(bad.status, "failed");
    assert.match(bad.text, /Python error: ZeroDivisionError/);
});

test("a late result cut at the output limit carries the fuller capture it was cut from; an uncut one carries nothing longer", async () => {
    const { tool, seen } = await pyTool();
    await tool.run({ code: "x" });
    const big = await seen.opts.late({ ok: true, stdout: "y".repeat(200_000), value: null });
    assert.ok(big.whole && big.whole.length > big.text.length, "the whole the pointer reads is longer than the text the model reads");
    const small = await seen.opts.late({ ok: true, stdout: "y", value: 1 });
    assert.ok(!small.whole || small.whole.length <= small.text.length, "nothing past the text when the cap cut nothing");
});

test("a late figure carries its image, said as the call's own return says it", async () => {
    const { tool, seen } = await pyTool();
    await tool.run({ code: "x" });
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const fig = await seen.opts.late({ ok: true, stdout: "", value: png, render: "figure" });
    assert.equal(fig.image, png);
    assert.match(fig.text, /came back as an image/);
    assert.doesNotMatch(fig.text, /not shown/);
});

// --- a cell whose worker died: PY_DONE logs it as orphaned ---

const orphans = async (run) => (await runLog.forRun(run)).filter((e) => e.subsystem === "python" && e.kind === "orphaned");
const wcaller = (cell) => ({ ownSurface: false, untrusted: async () => false, disclose: false, tabUrl: () => "", runGated: true, pyCodeOk: () => true, wireRun: "run-orph", cell });

test("PY_DONE for a cell this worker never sent is logged python/orphaned with its id, size and outcome", async () => {
    pythonDone({ type: "PY_DONE", cell: "wpy-from-a-dead-worker", run: "run-orph-1", ok: true, bytes: 1234 }, OFFSCREEN);
    await new Promise((r) => setTimeout(r, 20));
    const recs = await orphans("run-orph-1");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].detail.cell, "wpy-from-a-dead-worker");
    assert.equal(recs[0].bytes, 1234);
    assert.equal(recs[0].detail.ok, true);
});

test("PY_DONE for a cell this worker is still waiting on, or has just settled, is not an orphan", async () => {
    let release;
    pyRunHold = new Promise((r) => { release = r; });
    const p = runPython({ code: "1" }, "req-o1", wcaller("wpy-live"));
    await new Promise((r) => setTimeout(r, 20));
    pythonDone({ type: "PY_DONE", cell: "wpy-live", run: "run-orph", ok: true, bytes: 1 }, OFFSCREEN);   // PY_DONE before the reply
    release({ ok: true, stdout: "" });
    pyRunHold = null;
    await p;
    await runPython({ code: "1" }, "req-o2", wcaller("wpy-settled"));
    pythonDone({ type: "PY_DONE", cell: "wpy-settled", run: "run-orph", ok: true, bytes: 1 }, OFFSCREEN);   // the reply first
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await orphans("run-orph")).length, 0);
});

test("PY_DONE from a tab, or without a run, logs nothing", async () => {
    pythonDone({ type: "PY_DONE", cell: "wpy-x", run: "run-orph-2", ok: true, bytes: 1 }, { ...OFFSCREEN, tab: { id: 3, url: "https://x.example/" } });
    pythonDone({ type: "PY_DONE", cell: "wpy-y", ok: true, bytes: 1 }, OFFSCREEN);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await orphans("run-orph-2")).length, 0);
});

// --- the build defines a bench cell sets ---

test("__PY_LEASE_MS__ and __PY_DETACHED_MAX_MS__ set what a build ships; absent, the 15 s lease, the 60 min ceiling and the fixed 150 s lease cap", async () => {
    const esbuild = await import("esbuild");
    const vm = await import("node:vm");
    const entry = new URL("../src/python/py-lease.ts", import.meta.url).pathname;
    const of = async (define) => {
        const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral", logLevel: "silent", ...(define ? { define } : {}) });
        const mod = { exports: {} };
        vm.runInNewContext(out.outputFiles[0].text, { module: mod, exports: mod.exports });
        return { lease: mod.exports.PY_LEASE_MS, max: mod.exports.PY_DETACHED_MAX_MS, leaseMax: mod.exports.PY_LEASE_MAX_MS };
    };
    assert.deepEqual(await of(), { lease: 15_000, max: 3_600_000, leaseMax: 150_000 }, "undefined: the shipped values");
    assert.deepEqual(await of({ __PY_LEASE_MS__: "5000", __PY_DETACHED_MAX_MS__: "60000" }), { lease: 5000, max: 60_000, leaseMax: 30_000 }, "the lease's cap never passes half a bench build's ceiling");
});

test("build.mjs refuses a __PY_LEASE_MS__ or __PY_DETACHED_MAX_MS__ that is not a positive integer, before it builds anything", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = new URL("..", import.meta.url).pathname;
    for (const name of ["__PY_LEASE_MS__", "__PY_DETACHED_MAX_MS__"]) for (const bad of ["0", "15s", ""]) {
        const out = mkdtempSync(join(tmpdir(), "wml-pylease-"));
        try {
            const r = spawnSync(process.execPath, ["build.mjs", "--outdir", join(out, "d"), "--define", `${name}=${bad}`], { cwd: root, encoding: "utf8", timeout: 20000 });
            assert.notEqual(r.status, 0, `${name}=${JSON.stringify(bad)} built`);
            assert.match(r.stderr, new RegExp(`${name} must be a positive integer of milliseconds`));
        } finally { rmSync(out, { recursive: true, force: true }); }
    }
});

// --- a page change ends the page's tasks, not the run's (ASYNC_CALLS.md rule 4a) ---

test("a page change leaves a detached cell running (runtime-bound): no PY_CANCEL, and its late result still reaches the inbox", T, async () => {
    const c = await detached();
    const before = sentOf("PY_CANCEL").length;
    await cancelPageTasks(c.runId);
    assert.equal(sentOf("PY_CANCEL").length, before, "the offscreen document was asked to cancel a runtime-bound cell");
    assert.deepEqual(c.inbox(), []);
    c.resolve({ out: "after the page changed" });
    await until(() => c.inbox().length > 0);
    assert.match(c.inbox()[0].text, new RegExp(`^\\[task ${c.r.id} done after \\d+ s: out: after the page changed\\]$`));
    await done(c);
});

// --- the durable task table: filed under ml_tasks:<runId>, read back by a worker started since (rule 4b, slice B) ---

const keyOf = (run) => `ml_tasks:${run}`;
const stored = (run) => session[keyOf(run)];
/** What a worker eviction does to this realm's memory: the table, the kernel lock. The stored copy stays. */
const evict = () => { dropAllTaskMemory(); dropPyTaskMemory(); };
/** A later turn of the run opens: an inbox, the table read back first, then opened. */
async function nextTurn(runId) {
    runInboxes.set(runId, { tabId: 7, queue: [] });
    await hydrateTasks(runId);
    const fanned = [];
    openTasks(runId, (text, task) => fanned.push({ text, task }));
    return { inbox: () => runInboxes.get(runId).queue, fanned };
}
const taskRecs = async (run, kind) => (await runLog.forRun(run)).filter((e) => e.subsystem === "task" && e.kind === kind);

test("a detached cell is written through as a v1 row with its ref; its end, then its delivery, are written too", T, async () => {
    const c = await detached({ carry: () => ({ image: "data:image/png;base64,AAAA" }) });
    let rows = stored(c.runId);
    assert.equal(rows.length, 1);
    assert.deepEqual({ v: rows[0].v, id: rows[0].id, tool: rows[0].tool, status: rows[0].status, delivered: rows[0].delivered, ref: rows[0].ref }, { v: 1, id: c.r.id, tool: "python_exec", status: "running", delivered: false, ref: { kind: "py", cell: c.id, capMs: PY_DETACHED_MAX_MS } }, "the ref carries the cap the sandbox applied (none given: the ceiling)");
    assert.equal(rows[0].expectMs, 30);
    assert.ok(rows[0].startedMs > 0 && rows[0].leaseMs === 30);
    c.resolve({ out: "x" });
    await until(() => stored(c.runId)[0].status === "done");
    rows = stored(c.runId);
    assert.equal(rows[0].text, "out: x");
    assert.equal(rows[0].image, "data:image/png;base64,AAAA");
    assert.equal(typeof rows[0].endedMs, "number");
    assert.equal(rows[0].delivered, false, "queued, not read");
    for (const forbidden of ["exec", "waiter", "ending", "settle"]) assert.equal(forbidden in rows[0], false, `${forbidden} must never be stored`);
    assert.equal(taskDrained(c.runId, c.r.id, c.inbox()[0].text), true);
    assert.equal(stored(c.runId)[0].delivered, true, "delivered flips in the store when the loop drains it");
    await done(c);
});

test("an await that answers a task marks it delivered in the store", T, async () => {
    const c = await detached();
    c.resolve({ out: "y" });
    await until(() => stored(c.runId)[0].status === "done");
    closeTurnTasks(c.runId);
    assert.equal(stored(c.runId)[0].delivered, false);
    await taskAction(c.runId, { op: "await", id: c.r.id });
    assert.equal(stored(c.runId)[0].delivered, true);
    await done(c);
});

test("endTasks removes the stored key, also when this worker holds nothing in memory", T, async () => {
    const c = await detached();
    assert.ok(stored(c.runId));
    await done(c);
    assert.equal(stored(c.runId), undefined);
    session["ml_tasks:run-fresh-end"] = [{ v: 1, id: "t0000aa", tool: "python_exec", startedMs: 1, leaseMs: 1, expectMs: null, status: "done", result: null, text: "x", delivered: true, endedMs: 2, code: null }];
    await endTasks("run-fresh-end");
    assert.equal(session["ml_tasks:run-fresh-end"], undefined, "a worker started since the tasks were detached still clears the run's key");
});

test("a quota failure of the write is run-logged and memory still holds the task", T, async () => {
    const real = chrome.storage.session.set;
    // Only the task table's write fails: the run log lives in the same storage.
    chrome.storage.session.set = async (o) => { if (Object.keys(o).some((k) => k.startsWith("ml_tasks:"))) throw new Error("QUOTA_BYTES quota exceeded"); return real(o); };
    let c;
    try { c = await detached(); } finally { chrome.storage.session.set = real; }
    const recs = await taskRecs(c.runId, "persist-failed");
    assert.ok(recs.length >= 1 && /quota/i.test(recs[0].detail.error), JSON.stringify(recs));
    assert.match(await taskAction(c.runId, { op: "tail", id: c.r.id, lines: 5 }), /stdout|running/);
    await done(c);
});

// --- the upgrade: slice A stored nothing, and a stored v1 row is read by a worker that never held it ---

test("UPGRADE (a): a run with no stored table hydrates to an empty one and a turn opens normally", T, async () => {
    const runId = "run-upgrade-a";
    assert.equal(stored(runId), undefined);
    const turn = await nextTurn(runId);
    assert.deepEqual(turn.inbox(), []);
    assert.equal(pyKernelBusy(runId), null);
    assert.match(await taskAction(runId, { op: "await", id: "t000000" }), /^UnknownTask/);
    runInboxes.delete(runId);
});

test("UPGRADE (b): a stored parked result is queued into the next turn once, by a FRESH module instance, and not again into the turn after", T, async () => {
    const runId = "run-upgrade-b";
    session[keyOf(runId)] = [{ v: 1, id: "t00b00b", tool: "python_exec", startedMs: Date.now() - 90_000, leaseMs: 15_000, expectMs: null, status: "done", result: null, text: "out: parked", delivered: false, endedMs: Date.now() - 30_000, code: null, ref: { kind: "py", cell: "cell-old" } }];
    const open = async (tag) => {
        // The registry refuses a second declaration of run.tasks, as the second copy of the module would make: reset it.
        resetStateRegistry();
        const fresh = await import(`../src/sw/sw-tasks.ts?fresh=${tag}`);
        assert.notEqual(fresh.openTasks, openTasks, "a new instance of the module, with an empty table");
        runInboxes.set(runId, { tabId: 7, queue: [] });
        await fresh.hydrateTasks(runId);
        fresh.openTasks(runId, () => {});
        return { fresh, queue: runInboxes.get(runId).queue };
    };
    const one = await open("b1");
    assert.equal(one.queue.length, 1);
    assert.match(one.queue[0].text, /^\[task t00b00b done after 60 s: out: parked\]$/);
    assert.equal(one.fresh.taskDrained(runId, "t00b00b", one.queue[0].text), true);
    assert.equal(stored(runId)[0].delivered, true, "delivered is persisted when the loop drains it");
    const two = await open("b2");
    assert.deepEqual(two.queue, [], "the turn after does not read it again");
    runInboxes.delete(runId);
    await endTasks(runId);
});

test("UPGRADE (c): a row of an unknown version is dropped with a run-log record; the rows beside it are kept", T, async () => {
    const runId = "run-upgrade-c";
    const ok = { v: 1, id: "t00c00c", tool: "python_exec", startedMs: 1, leaseMs: 1, expectMs: null, status: "done", result: null, text: "kept", delivered: true, endedMs: 2, code: null };
    session[keyOf(runId)] = [{ ...ok, v: 2, id: "t00d00d" }, ok];
    const turn = await nextTurn(runId);
    assert.deepEqual(turn.inbox(), []);
    const recs = await taskRecs(runId, "dropped");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].reason, "unknown-version");
    assert.equal(recs[0].detail.v, "2");
    assert.deepEqual(stored(runId).map((r) => r.id), ["t00c00c"], "the unknown row is gone from the store");
    assert.match(await taskAction(runId, { op: "await", id: "t00c00c" }), /task t00c00c done: kept/);
    assert.match(await taskAction(runId, { op: "await", id: "t00d00d" }), /^UnknownTask/);
    runInboxes.delete(runId);
    await endTasks(runId);
});

// --- after an eviction: PY_DONE of a cell the new worker never sent ---

test("EVICTION: a stored running row, a new worker and PY_DONE: PY_RESULT is asked, the result is parked, the next turn reads it once", T, async () => {
    const c = await detached();
    const task = c.r.id;
    assert.match(pyKernelBusy(c.runId), new RegExp(task));
    runControllers.delete(c.runId); runInboxes.delete(c.runId);   // the turn is over
    evict();
    assert.equal(pyKernelBusy(c.runId), null, "the new worker knows nothing yet");
    resultAnswer = { result: { ok: true, stdout: "hello\n", value: 42 } };
    const b = sent.length;
    await pythonDone({ type: "PY_DONE", cell: c.id, run: c.runId, ok: true, bytes: 9 }, OFFSCREEN);
    const asked = sent.slice(b).filter((m) => m.type === "PY_RESULT");
    assert.deepEqual(asked, [{ type: "PY_RESULT", cell: c.id }]);
    await until(() => stored(c.runId)?.[0]?.status === "done");
    assert.equal(stored(c.runId)[0].delivered, false, "parked, not read");
    assert.equal(pyKernelBusy(c.runId), null, "the kernel lock is released once the cell is settled");
    assert.equal((await orphans(c.runId)).length, 0, "it was delivered, not orphaned");
    evict();   // and the worker may be evicted again before the next turn
    const t1 = await nextTurn(c.runId);
    assert.equal(t1.inbox().length, 1);
    assert.match(t1.inbox()[0].text, new RegExp(`^\\[task ${task} done after \\d+ s: stdout:\\nhello\\n\\n42\\n\\(formatted after the service worker restarted`));
    assert.equal(taskDrained(c.runId, task, t1.inbox()[0].text), true);
    runInboxes.delete(c.runId);
    const t2 = await nextTurn(c.runId);
    assert.deepEqual(t2.inbox(), [], "exactly once");
    resultAnswer = { result: null };
    await done(c);
});

test("EVICTION: a failed cell's result is a failed task with the Python error; a cut stdout uses the tool's output cap", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    resultAnswer = { result: { ok: false, stdout: "x".repeat(5000), error: "ZeroDivisionError: division by zero" } };
    await pythonDone({ type: "PY_DONE", cell: c.id, run: c.runId, ok: false, bytes: 9 }, OFFSCREEN);
    await until(() => stored(c.runId)?.[0]?.status === "failed");
    const text = stored(c.runId)[0].text;
    assert.match(text, /Python error: ZeroDivisionError: division by zero/);
    assert.ok(text.length < 2600, `stdout was clipped to the python_exec cap, got ${text.length}`);
    assert.match(text, /truncated|…/);
    resultAnswer = { result: null };
    await done(c);
});

test("EVICTION: PY_DONE for a cell with no stored row still logs python/orphaned and asks for no result", T, async () => {
    evict();
    const b = sent.length;
    await pythonDone({ type: "PY_DONE", cell: "wpy-nobody-knows", run: "run-no-row", ok: true, bytes: 5 }, OFFSCREEN);
    assert.equal((await orphans("run-no-row")).length, 1);
    assert.equal(sent.slice(b).some((m) => m.type === "PY_RESULT"), false);
});

test("EVICTION: PY_DONE with a row but no result held logs python/orphaned and ends the row, so the kernel is not locked for ever", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    resultAnswer = { result: null };
    await pythonDone({ type: "PY_DONE", cell: c.id, run: c.runId, ok: true, bytes: 5 }, OFFSCREEN);
    assert.equal((await orphans(c.runId)).length, 1);
    await until(() => stored(c.runId)?.[0]?.status === "failed");
    assert.match(stored(c.runId)[0].text, /no longer held/);
    assert.equal(pyKernelBusy(c.runId), null);
    await done(c);
});

test("EVICTION: PY_DONE from a tab, or for a cell whose row is already ended, settles nothing", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    resultAnswer = { result: { ok: true, stdout: "", value: 1 } };
    const b = sent.length;
    await pythonDone({ type: "PY_DONE", cell: c.id, run: c.runId, ok: true, bytes: 1 }, { ...OFFSCREEN, tab: { id: 3, url: "https://x.example/" } });
    assert.equal(sent.slice(b).some((m) => m.type === "PY_RESULT"), false, "a tab's PY_DONE asks for nothing");
    assert.equal(stored(c.runId)[0].status, "running");
    await pythonDone({ type: "PY_DONE", cell: c.id, run: c.runId, ok: true, bytes: 1 }, OFFSCREEN);
    await until(() => stored(c.runId)[0].status === "done");
    const asked = sent.length;
    await pythonDone({ type: "PY_DONE", cell: c.id, run: c.runId, ok: true, bytes: 1 }, OFFSCREEN);
    assert.equal(sent.slice(asked).some((m) => m.type === "PY_RESULT"), false, "a second PY_DONE for an ended row asks for nothing");
    resultAnswer = { result: null };
    await done(c);
});

test("hydrate: a running py row is attached again with the kernel locked, cancel and tail reach the cell, and a cancel marks the late result cancelled", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    assert.equal(pyKernelBusy(c.runId), null);
    await nextTurn(c.runId);
    assert.match(pyKernelBusy(c.runId), new RegExp(`task ${c.r.id} is still running`), "the kernel lock is taken again");
    tailAnswer = { running: true, text: "line1\nline2\n" };
    assert.match(await taskAction(c.runId, { op: "tail", id: c.r.id, lines: 5 }), /line2/);
    cancelHow = "interrupted";
    const b = sent.length;
    assert.match(await taskAction(c.runId, { op: "cancel", id: c.r.id }), /interrupted \(KeyboardInterrupt\)/);
    assert.deepEqual(sent.slice(b).filter((m) => m.type === "PY_CANCEL"), [{ type: "PY_CANCEL", cell: c.id }]);
    resultAnswer = { result: { ok: false, stdout: "", error: "KeyboardInterrupt" } };
    await pythonDone({ type: "PY_DONE", cell: c.id, run: c.runId, ok: false, bytes: 1 }, OFFSCREEN);
    await until(() => stored(c.runId)[0].status === "cancelled");
    assert.match(stored(c.runId)[0].text, /^interrupted \(KeyboardInterrupt\)/);
    assert.equal(pyKernelBusy(c.runId), null);
    resultAnswer = { result: null }; tailAnswer = { running: true, text: "" };
    await done(c);
});

test("hydrate: a cell that ended while no worker listened is settled at attach from the held result: parked, kernel free, PY_TAIL then PY_RESULT asked once", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    tailAnswer = { running: false };
    resultAnswer = { result: { ok: true, stdout: "", value: 7 } };
    const b = sent.length;
    await hydrateTasks(c.runId);
    assert.deepEqual(sent.slice(b).filter((m) => m.type === "PY_TAIL" || m.type === "PY_RESULT").map((m) => m.type), ["PY_TAIL", "PY_RESULT"]);
    await until(() => stored(c.runId)?.[0]?.status === "done");
    assert.equal(pyKernelBusy(c.runId), null, "the kernel is not held for a cell that has ended");
    assert.equal(stored(c.runId)[0].delivered, false, "parked for the next turn");
    const t = await nextTurn(c.runId);
    assert.equal(t.inbox().length, 1);
    assert.match(t.inbox()[0].text, new RegExp(`^\\[task ${c.r.id} done after \\d+ s: 7`));
    resultAnswer = { result: null }; tailAnswer = { running: true, text: "" };
    await done(c);
});

test("hydrate: a cell that ended unheard with no result held is settled failed at attach and logged, not left running with the kernel locked", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    tailAnswer = { running: false };
    resultAnswer = { result: null };
    await hydrateTasks(c.runId);
    await until(() => stored(c.runId)?.[0]?.status === "failed");
    assert.match(stored(c.runId)[0].text, /no longer held/);
    assert.equal(pyKernelBusy(c.runId), null);
    assert.deepEqual((await taskRecs(c.runId, "orphaned")).map((e) => e.reason), ["ended-unheard"]);
    tailAnswer = { running: true, text: "" };
    await done(c);
});

test("hydrate: a cell the sandbox still runs is attached and not settled: PY_RESULT is not asked", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    tailAnswer = { running: true, text: "" };
    resultAnswer = { result: { ok: true, stdout: "", value: 1 } };
    const b = sent.length;
    await hydrateTasks(c.runId);
    assert.equal(sent.slice(b).some((m) => m.type === "PY_RESULT"), false);
    assert.equal(stored(c.runId)[0].status, "running");
    assert.match(pyKernelBusy(c.runId), new RegExp(c.r.id));
    resultAnswer = { result: null };
    await done(c);
});

test("hydrate: a running py row stored with no cap, past the ceiling and its grace, is orphaned, told to the next turn, and logged", T, async () => {
    const runId = "run-past-ceiling";
    session[keyOf(runId)] = [{ v: 1, id: "t00ee00", tool: "python_exec", startedMs: Date.now() - PY_DETACHED_MAX_MS - 61_000, leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null, ref: { kind: "py", cell: "cell-gone" } }];
    const turn = await nextTurn(runId);
    assert.equal(pyKernelBusy(runId), null, "no kernel lock for a cell that is gone");
    assert.equal(turn.inbox().length, 1);
    assert.match(turn.inbox()[0].text, /^\[task t00ee00 orphaned after \d+ s: .*ran past its cap/);
    assert.equal((await taskRecs(runId, "orphaned")).length, 1);
    assert.equal(stored(runId)[0].status, "orphaned", "the orphaning is persisted");
    runInboxes.delete(runId);
    await endTasks(runId);
});

test("hydrate: a running py row stored with no cap, inside the ceiling, is still attached", T, async () => {
    const runId = "run-inside-ceiling";
    session[keyOf(runId)] = [{ v: 1, id: "t00ff00", tool: "python_exec", startedMs: Date.now() - PY_DETACHED_MAX_MS + 5_000, leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null, ref: { kind: "py", cell: "cell-live" } }];
    await nextTurn(runId);
    assert.match(pyKernelBusy(runId), /t00ff00/);
    runInboxes.delete(runId);
    await endTasks(runId);
    assert.equal(pyKernelBusy(runId), null, "session release cancels the rebuilt cell and frees the kernel");
});

test("hydrate: a running py row past its OWN cap and the grace is orphaned, though well inside the ceiling", T, async () => {
    const runId = "run-past-own-cap";
    session[keyOf(runId)] = [{ v: 1, id: "t00cc01", tool: "python_exec", startedMs: Date.now() - 60_000 - 61_000, leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null, ref: { kind: "py", cell: "cell-capped", capMs: 60_000 } }];
    const turn = await nextTurn(runId);
    assert.equal(pyKernelBusy(runId), null, "a cell its sandbox killed at a 1 min cap holds no lock for the 59 min left to the ceiling");
    assert.match(turn.inbox()[0].text, /^\[task t00cc01 orphaned after \d+ s: .*ran past its cap/);
    runInboxes.delete(runId);
    await endTasks(runId);
});

test("hydrate: a running py row inside its own cap and the grace is attached", T, async () => {
    const runId = "run-inside-own-cap";
    session[keyOf(runId)] = [{ v: 1, id: "t00cc02", tool: "python_exec", startedMs: Date.now() - 60_000 - 30_000, leaseMs: 15_000, expectMs: null, status: "running", result: null, text: null, delivered: false, code: null, ref: { kind: "py", cell: "cell-capped-live", capMs: 60_000 } }];
    await nextTurn(runId);
    assert.match(pyKernelBusy(runId), /t00cc02/, "its PY_DONE may still be on its way");
    runInboxes.delete(runId);
    await endTasks(runId);
});

test("hydrate reads the store once for two callers at the same time, and a run with a task detached meanwhile keeps both", T, async () => {
    const runId = "run-two-readers";
    session[keyOf(runId)] = [{ v: 1, id: "t00a11a", tool: "python_exec", startedMs: 1, leaseMs: 1, expectMs: null, status: "done", result: null, text: "z", delivered: true, endedMs: 2, code: null }];
    let reads = 0;
    const real = chrome.storage.session.get;
    chrome.storage.session.get = async (k) => { reads++; return real(k); };
    try { await Promise.all([hydrateTasks(runId), hydrateTasks(runId), hydrateTasks(runId)]); await hydrateTasks(runId); } finally { chrome.storage.session.get = real; }
    assert.equal(reads, 1);
    await endTasks(runId);
});

// --- the cap: one knob, read at the call, clamped by the offscreen document ---

test("detachedTaskMaxMin: default 60; 1..60 is taken; a value outside, or not a number, reads as 60", T, async () => {
    const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
    assert.equal(DEFAULT_CONFIG.detachedTaskMaxMin, 60);
    assert.equal(await detachedCapMs(), 60 * 60_000);
    for (const [v, min] of [[1, 1], [10, 10], [60, 60], [10.9, 10], [0, 60], [-5, 60], [61, 60], [1e9, 60], ["10", 60], [null, 60], [NaN, 60], [Infinity, 60]]) {
        assert.equal(capMinutes(v), min, `capMinutes(${String(v)})`);
        syncExtra = { detachedTaskMaxMin: v };
        assert.equal(await detachedCapMs(), min * 60_000, `config ${String(v)}`);
    }
    syncExtra = {};
});

test("PY_RUN carries detachedMaxMs for a leased cell only, and the tool call reads it from the setting", T, async () => {
    const caller = (extra = {}) => ({ ownSurface: false, untrusted: async () => false, disclose: false, tabUrl: () => "", runGated: true, pyCodeOk: () => true, ...extra });
    const run = async (c) => { const b = sent.length; await runPython({ code: "1" }, "req", c); return sent.slice(b).find((m) => m.type === "PY_RUN"); };
    assert.equal((await run(caller({ wireRun: "run-w", cell: "cell-cap", detachedMaxMs: 120_000 }))).detachedMaxMs, 120_000);
    assert.equal("detachedMaxMs" in await run(caller({ wireRun: "run-w", detachedMaxMs: 120_000 })), false, "no cell: no cap");
    assert.equal("detachedMaxMs" in await run(caller({ wireRun: "run-w", cell: "cell-cap" })), false, "no cap named: none sent");
    // The worker's own tool call: read from the setting at the call.
    const { buildWorkerTools, grantRunPython } = await import("../src/sw/worker-tools.ts");
    syncExtra = { detachedTaskMaxMin: 7 };
    try {
        const tool = buildWorkerTools("run-cap-tool", 7, () => "https://x.example/", ["python_exec"]).find((t) => t.name === "python_exec");
        assert.ok(tool, "python_exec is built for the run");
        grantRunPython("run-cap-tool", { sheets: [], code: "1" });   // the person approved this exact cell
        const b = sent.length;
        await tool.run({ code: "1" });
        const m = sent.slice(b).find((x) => x.type === "PY_RUN");
        assert.ok(m, "the cell was sent");
        assert.equal(m.detachedMaxMs, 7 * 60_000);
    } finally { syncExtra = {}; }
});

test("a lease never reaches half the cap: with a 1 min cap an expect_ms of 10 min detaches at 30 s, and the text says 1 min", T, async () => {
    const runId = "run-half-cap";
    runControllers.set(runId, new AbortController());
    runInboxes.set(runId, { tabId: 7, queue: [] });
    const capped = leaseCell({ runId, cell: "cell-half", expectMs: 600_000, detachedMaxMs: 60_000, call: new Promise(() => {}), late: async () => ({ status: "done", text: "", result: null }) });
    let early = false;
    capped.then(() => { early = true; });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        pythonStarted({ type: "PY_STARTED", cell: "cell-half" }, OFFSCREEN);
        mock.timers.tick(29_999);
        await Promise.resolve();
        assert.equal(early, false, "not yet at 30 s - 1 ms");
        mock.timers.tick(1);
    } finally { mock.timers.reset(); }
    const r = await capped;
    assert.ok(r.detached, "detached at half the cap");
    assert.match(r.detached.text, /the sandbox ends it at 1 min/);
    assert.equal((await runLog.forRun(runId)).find((e) => e.kind === "detached").detail.leaseMs, 30_000);
    await done({ runId });
});

test("endTasks on a worker started since the cell detached reads the table first: it cancels the cell, then removes the key", T, async () => {
    const c = await detached();
    runControllers.delete(c.runId); runInboxes.delete(c.runId);
    evict();
    const b = sent.length;
    await endTasks(c.runId);
    assert.deepEqual(sent.slice(b).filter((m) => m.type === "PY_CANCEL"), [{ type: "PY_CANCEL", cell: c.id }], "the rebuilt cell was cancelled");
    assert.equal(stored(c.runId), undefined);
    assert.equal(pyKernelBusy(c.runId), null);
});

test("PY_RESULT is the service worker's alone: absent from every table a page's message can reach", async () => {
    const { HANDLE_MAP, PAGE_STARTED_TYPES } = await import("../src/page-relay.ts");
    const mapped = Object.entries(HANDLE_MAP).flatMap(([k, v]) => [k, v.type, v.responseType]);
    assert.ok(!mapped.some((m) => String(m).startsWith("PY_RESULT")), "PY_RESULT is in HANDLE_MAP");
    assert.ok(!PAGE_STARTED_TYPES.has("PY_RESULT"), "PY_RESULT is page-started");
});
