// python-lease.test.mjs — mode 1 of docs/spec/ASYNC_CALLS.md on python_exec: a worker-hosted run's cell that outruns its
// lease detaches into a task (sw-python-task.ts `leaseCell`), the kernel lock, the late result, the cancel and the tail
// through the task table (sw-tasks.ts), a Stop, the turn's end, and the pure rules of py-lease.ts.
//
// The real worker modules under a mocked `chrome`: `runtime.sendMessage` records what the worker asks the offscreen
// document (PY_CANCEL, PY_TAIL, PY_RUN) and answers with what a test chose. The cell's own run is a promise the test
// settles; the lease starts when the test says PY_STARTED, as the offscreen document does. Real timers, small leases.

import { test } from "node:test";
import assert from "node:assert/strict";

const T = { timeout: 20000 };
const EXT = "ext-id";

const sent = [];
let cancelHow = "interrupted";
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
        sync: { get: async (d) => ({ ...(d ?? {}), chatUrl: "http://host/api/chat/completions", apiKey: "sk-test" }), set: async () => {} },
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
const { ringAppend, PY_LEASE_MS, PY_INTERRUPT_KILL_MS } = await import("../src/python/py-lease.ts");

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
        runId, cell: id, expectMs: o.expectMs ?? null, call, onDetach: () => { detaches++; },
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
    const c = await detached({ expectMs: 40 });
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
    assert.equal(rec[0].detail.id, c.r.id);
    tailAnswer = { running: true, text: "" };
    await done(c);
});

test("pyDetachedText says 'you expected ~N s' with expect_ms and 'no expect_ms was given' without it, and names the task, the end of the turn and the ceiling", () => {
    const withE = pyDetachedText("tabc123", 15_000, 45_000, "");
    assert.match(withE, /task tabc123 after 15 s/);
    assert.match(withE, /you expected ~45 s/);
    assert.doesNotMatch(withE, /no expect_ms/);
    assert.match(withE, /cancelled when this turn ends/);
    assert.match(withE, /the sandbox ends it at 300 s/);
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

test("a Stop after the cell detached does not send PY_CANCEL: the task is the turn's end to cancel", T, async () => {
    const c = await detached();
    const before = sentOf("PY_CANCEL").length;
    c.ctl.abort();
    await sleep(60);
    assert.equal(sentOf("PY_CANCEL").length, before);
    c.resolve({ out: "x" });
    await until(() => c.inbox().length > 0);
    await done(c);
});

test("endTasks on a run with a detached cell sends PY_CANCEL for it", T, async () => {
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

test("a late result is the formatter's text: done, or failed for a Python error, with no pointer", async () => {
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

test("a late result cut at the output limit says so, and that no pointer to the rest exists; an uncut one does not", async () => {
    const { tool, seen } = await pyTool();
    await tool.run({ code: "x" });
    const big = await seen.opts.late({ ok: true, stdout: "y".repeat(200_000), value: null });
    assert.match(big.text, /Cut at the output limit; no pointer to the rest exists for a task's result\./);
    const small = await seen.opts.late({ ok: true, stdout: "y", value: 1 });
    assert.doesNotMatch(small.text, /Cut at the output limit/);
});

test("a late figure is named as not shown, never as an image that came back", async () => {
    const { tool, seen } = await pyTool();
    await tool.run({ code: "x" });
    const fig = await seen.opts.late({ ok: true, stdout: "", value: "data:image/png;base64,iVBORw0KGgo=", render: "figure" });
    assert.match(fig.text, /1 figure, not shown \(a task's result carries text only\)\./);
    assert.doesNotMatch(fig.text, /came back as an image|Returned an image/);
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

test("__PY_LEASE_MS__ and __PY_DETACHED_MAX_MS__ set what a build ships; absent, the 15 s lease and the measured 5 min ceiling", async () => {
    const esbuild = await import("esbuild");
    const vm = await import("node:vm");
    const entry = new URL("../src/python/py-lease.ts", import.meta.url).pathname;
    const of = async (define) => {
        const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral", logLevel: "silent", ...(define ? { define } : {}) });
        const mod = { exports: {} };
        vm.runInNewContext(out.outputFiles[0].text, { module: mod, exports: mod.exports });
        return { lease: mod.exports.PY_LEASE_MS, max: mod.exports.PY_DETACHED_MAX_MS };
    };
    assert.deepEqual(await of(), { lease: 15_000, max: 300_000 }, "undefined: the shipped values");
    assert.deepEqual(await of({ __PY_LEASE_MS__: "5000", __PY_DETACHED_MAX_MS__: "60000" }), { lease: 5000, max: 60_000 });
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
