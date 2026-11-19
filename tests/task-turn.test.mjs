// task-turn.test.mjs — a finished detached task starts the run's next turn (docs/spec/ASYNC_CALLS.md rule 4b, slice C):
// the decision in sw-tasks.ts (`startTurnFor`) against a fake turn host, with the worker's modules imported directly.
// The real start (userRunAction -> hostRun), the coalescing and the person's message during a start are in
// task-starts-turn.test.mjs, which runs the built bundle.

import { test } from "node:test";
import assert from "node:assert/strict";

const T = { timeout: 20000 };
const sync = { taskNotifyOnly: undefined, taskTurnChainMax: undefined };
const sessionStore = {};
const tabs = new Map([[7, { id: 7, url: "https://site.example/page" }]]);
globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    tabs: { get: async (id) => { const t = tabs.get(id); if (!t) throw new Error("No tab with id"); return { ...t }; } },
    storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => { const o = { ...(d ?? {}) }; for (const [k, v] of Object.entries(sync)) if (v !== undefined) o[k] = v; return o; }, set: async () => {} },
        session: {
            get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k ?? sessionStore); return Object.fromEntries(keys.filter((x) => x in sessionStore).map((x) => [x, structuredClone(sessionStore[x])])); },
            set: async (o) => { Object.assign(sessionStore, structuredClone(o)); }, remove: async (k) => { for (const x of [k].flat()) delete sessionStore[x]; },
        },
        onChanged: { addListener() {} },
    },
};
const { detachTask, endTasks, setTaskTurnHost, resetTaskChain, chainMax, dropAllTaskMemory, hydrateTasks, openTasks } = await import("../src/sw/sw-tasks.ts");
const { bgRuns, runInboxes, startingControllers, beginStart, endStart, runControllers, releaseSessionTokens } = await import("../src/sw/sw-runs.ts");
const { runLog } = await import("../src/sw/sw-run-log.ts");
const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");

let n = 0;
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); } };
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A settled worker-built run on tab 7 (or `builtBy` another), and a fake host that records the turns it is asked to start and the lines it says. */
function world({ builtBy = "worker", tabId = 7, hostStarts = true } = {}) {
    const runId = `run-turn-${++n}`;
    bgRuns.set(runId, { p: { runId, ...(builtBy ? { builtBy } : {}) }, tabId, messages: [] });
    const starts = [], lines = [];
    setTaskTurnHost({
        // Registers the run as starting before its first await, as the real start does.
        start: async (id, task, line) => { starts.push({ id, task, line }); if (!hostStarts) return false; beginStart(id, tabId); return true; },
        say: (id, text) => lines.push({ id, text }),
    });
    /** Detach a task of the run and return a function that ends it. */
    const detach = (target = runId) => {
        let end;
        const settled = new Promise((r) => { end = r; });
        const id = detachTask(target, { tool: "ml.sh", startedMs: Date.now() - 2000, leaseMs: 1000, expectMs: null, exec: { cancel: async () => ({ confirmed: true, text: "x" }), tail: () => null, tailAbsent: "", settled } });
        return { id, end: (o = {}) => end({ status: "done", text: "built", result: null, ...o }) };
    };
    const log = async () => (await runLog.all()).filter((e) => e.run === runId);
    const reasons = async () => (await log()).filter((e) => e.kind === "not-started").map((e) => e.reason);
    /** The turn the fake started has run and ended: the run is settled again. */
    const turnEnds = () => { for (const e of [...(startingControllers.get(runId) ?? [])]) endStart(runId, e.ctl); };
    return { runId, starts, lines, detach, log, reasons, turnEnds };
}
const reset = () => { sync.taskNotifyOnly = undefined; sync.taskTurnChainMax = undefined; setTaskTurnHost(null); tabs.set(7, { id: 7, url: "https://site.example/page" }); };

// --- a completion with no turn running starts one ---

test("a task that finishes with no turn running starts exactly one turn, naming the task, and says nothing else", T, async () => {
    reset();
    const w = world();
    const a = w.detach();
    a.end();
    await until(() => w.starts.length === 1);
    await settle();
    assert.equal(w.starts.length, 1);
    assert.equal(w.starts[0].id, w.runId);
    assert.equal(w.starts[0].task, a.id);
    assert.match(w.starts[0].line, new RegExp(`^Turn started by task ${a.id} \\(done after \\d+ s\\)\\.$`));
    assert.deepEqual(w.lines, [], "the host announces the start line itself, as part of the start");
    assert.ok((await w.log()).some((e) => e.kind === "turn-started" && e.detail?.chain === 1));
    await endTasks(w.runId);
});

test("two results that finish together start one turn: the second sees the first's starting turn and parks as busy", T, async () => {
    reset();
    const w = world();
    const a = w.detach(), b = w.detach();
    a.end(); b.end();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(w.starts.length, 1, "one turn for two completions");
    assert.deepEqual(await w.reasons(), ["busy"]);
    await endTasks(w.runId);
});

test("a result that finishes while a turn is live goes to its inbox and starts nothing", T, async () => {
    reset();
    const w = world();
    runInboxes.set(w.runId, { tabId: 7, queue: [] });
    openTasks(w.runId, () => {});
    const a = w.detach();
    a.end();
    await until(() => runInboxes.get(w.runId).queue.length === 1);
    await settle();
    assert.equal(w.starts.length, 0);
    runInboxes.delete(w.runId);
    await endTasks(w.runId);
});

test("a completion never starts a turn for another run", T, async () => {
    reset();
    const w = world();
    const other = world();   // replaces the fake host with an equal one, over its own run
    const a = other.detach();
    a.end();
    await until(() => other.starts.length === 1);
    await settle();
    assert.equal(other.starts.length, 1);
    assert.equal(other.starts[0].id, other.runId);
    assert.ok(!other.starts.some((s) => s.id === w.runId), "the first run was not started");
    await endTasks(w.runId); await endTasks(other.runId);
});

test("a start the host could not make gives the count back, parks the result and logs start-refused", T, async () => {
    reset();
    const w = world({ hostStarts: false });
    const a = w.detach();
    a.end();
    await until(async () => (await w.reasons()).includes("start-refused"));
    assert.equal(sessionStore[`ml_task_chain:${w.runId}`], 0, "the count was given back");
    await endTasks(w.runId);
});

// --- the reasons a result only parks ---

test("notify-only: the result parks, the person sees the line, no turn starts", T, async () => {
    reset(); sync.taskNotifyOnly = true;
    const w = world();
    const a = w.detach();
    a.end();
    await until(async () => (await w.reasons()).includes("notify-only"));
    assert.equal(w.starts.length, 0);
    assert.match(w.lines[0].text, new RegExp(`^task ${a.id} done; its result is read at your next message`));
    await endTasks(w.runId);
});

test("no tab: the result parks with a run-log record, no turn and no line", T, async () => {
    reset();
    const w = world();
    tabs.delete(7);
    const a = w.detach();
    a.end();
    await until(async () => (await w.reasons()).includes("no-tab"));
    assert.equal(w.starts.length, 0);
    assert.deepEqual(w.lines, []);
    await endTasks(w.runId);
});

test("a tab on a page the extension owns hosts no turn", T, async () => {
    reset();
    const w = world();
    tabs.set(7, { id: 7, url: "chrome-extension://abc/chat.html" });
    const a = w.detach();
    a.end();
    await until(async () => (await w.reasons()).includes("own-page"));
    assert.equal(w.starts.length, 0);
    await endTasks(w.runId);
});

test("a page-built run: the result parks and no turn starts", T, async () => {
    reset();
    const w = world({ builtBy: null });
    const a = w.detach();
    a.end();
    await until(async () => (await w.reasons()).includes("page-run"));
    assert.equal(w.starts.length, 0);
    await endTasks(w.runId);
});

test("a run archived or released first: its late result is dropped with a run-log record and starts nothing", T, async () => {
    reset();
    const w = world();
    const a = w.detach();
    await endTasks(w.runId, "archived");
    a.end();
    await until(async () => (await w.log()).some((e) => e.kind === "dropped"));
    await settle();
    assert.equal(w.starts.length, 0);
    assert.deepEqual(await w.reasons(), []);
    // The same through the session release hook.
    const v = world();
    const b = v.detach();
    releaseSessionTokens(v.runId);
    b.end();
    await until(async () => (await v.log()).some((e) => e.kind === "dropped"));
    assert.equal(v.starts.length, 0);
});

// --- the chain cap ---

test("the chain: 5 started turns in a row, the 6th completion parks with the cap line; the person's message resets the count", T, async () => {
    reset();
    const w = world();
    for (let i = 1; i <= 5; i++) {
        const t = w.detach();
        t.end();
        await until(() => w.starts.length === i);
        w.turnEnds();
    }
    assert.equal(sessionStore[`ml_task_chain:${w.runId}`], 5);
    const six = w.detach();
    six.end();
    await until(async () => (await w.reasons()).includes("chain-cap"));
    assert.equal(w.starts.length, 5, "the sixth started nothing");
    assert.match(w.lines.at(-1).text, new RegExp(`task ${six.id} done; 5 turns in a row .*taskTurnChainMax = 5.*read at your next message`));
    resetTaskChain(w.runId);   // the person's message
    assert.equal(sessionStore[`ml_task_chain:${w.runId}`], undefined);
    const seven = w.detach();
    seven.end();
    await until(() => w.starts.length === 6);
    await endTasks(w.runId);
});

test("the cap is the setting, and a value outside 1..20 reads as 5", T, async () => {
    reset(); sync.taskTurnChainMax = 2;
    const w = world();
    for (let i = 1; i <= 2; i++) { const t = w.detach(); t.end(); await until(() => w.starts.length === i); w.turnEnds(); }
    const c = w.detach(); c.end();
    await until(async () => (await w.reasons()).includes("chain-cap"));
    assert.equal(w.starts.length, 2);
    for (const bad of [0, 21, -3, 2.5 * 100, "7", NaN, null, undefined]) assert.equal(chainMax(bad), 5, String(bad));
    assert.equal(chainMax(1), 1); assert.equal(chainMax(20), 20); assert.equal(chainMax(7.9), 7);
    await endTasks(w.runId);
});

test("the count survives a worker eviction: a fresh worker reads it from session storage and the cap still holds", T, async () => {
    reset(); sync.taskTurnChainMax = 2;
    const w = world();
    for (let i = 1; i <= 2; i++) { const t = w.detach(); t.end(); await until(() => w.starts.length === i); w.turnEnds(); }
    dropAllTaskMemory();   // the worker was evicted: only session storage is left
    await hydrateTasks(w.runId);
    const c = w.detach(); c.end();
    await until(async () => (await w.reasons()).includes("chain-cap"));
    assert.equal(w.starts.length, 2, "the third did not start: the count came back from storage");
    await endTasks(w.runId);
    assert.equal(sessionStore[`ml_task_chain:${w.runId}`], undefined, "the run's end removes the count");
});

// --- the upgrade: what slice B wrote, read by this code ---

test("a stored task table from before slice C (no chain key) reads as count 0, and a config without the new keys reads as the defaults", T, async () => {
    reset();
    const w = world();
    sessionStore[`ml_tasks:${w.runId}`] = [{ v: 1, id: "t0old01", tool: "ml.sh", startedMs: Date.now() - 9000, leaseMs: 1000, expectMs: null, status: "done", result: null, text: "old result", delivered: false, endedMs: Date.now() - 5000, code: 0 }];
    assert.equal(sessionStore[`ml_task_chain:${w.runId}`], undefined);
    await hydrateTasks(w.runId);
    const a = w.detach(); a.end();
    await until(() => w.starts.length === 1);
    assert.equal(sessionStore[`ml_task_chain:${w.runId}`], 1, "counted from 0");
    assert.equal(DEFAULT_CONFIG.taskNotifyOnly, false);
    assert.equal(DEFAULT_CONFIG.taskTurnChainMax, 5);
    await endTasks(w.runId);
});
