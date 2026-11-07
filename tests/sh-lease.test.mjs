// sh-lease.test.mjs — mode 1 of docs/spec/ASYNC_CALLS.md on ml.sh: a call that outruns its lease detaches into a task
// (sw-shell-call.ts), the task table, the `task` tool's actions, the turn's end and `ml.current.tasks` (sw-tasks.ts),
// driven against the fake native host with the worker's modules imported directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 20000 };

// The worker's chrome, as much of it as sw-shell.ts, sw-shell-call.ts and sw-runs.ts use.
const sync = { shellEnabled: true, shellRoots: ["/w/p0"], shellSandbox: true, shellPath: [], chatUrl: "http://host/api/chat/completions", apiKey: "sk-test" };
let native = null;
let syncDelayMs = 0;
const sessionStore = {};
globalThis.chrome = {
    runtime: {
        id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p,
        connectNative: (name) => {
            const onMsg = [], onDisc = [];
            let closed = false;
            const close = (why) => { if (closed) return; closed = true; setTimeout(() => { globalThis.chrome.runtime.lastError = { message: why }; for (const f of onDisc) f(); globalThis.chrome.runtime.lastError = undefined; }, 0); };
            const end = { send: (m) => { if (!closed) setTimeout(() => { for (const f of onMsg) f(JSON.parse(JSON.stringify(m))); }, 0); }, close };
            const receive = native ? native(name, end) : null;
            if (!receive) close("Specified native messaging host not found.");
            return { name, postMessage: (m) => { if (closed) throw new Error("disconnected"); receive?.(JSON.parse(JSON.stringify(m))); }, disconnect: () => { closed = true; },
                onMessage: { addListener: (f) => onMsg.push(f) }, onDisconnect: { addListener: (f) => onDisc.push(f) } };
        },
    },
    storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        // `syncDelayMs` holds the read open, as a slow storage does: the scrub (sw-scrub.ts) reads the config's secrets.
        sync: { get: async (d) => { if (syncDelayMs) await new Promise((r) => setTimeout(r, syncDelayMs)); return { ...(d ?? {}), ...sync }; }, set: async () => {} },
        // In memory, so the execution log (sw-run-log.ts) can be read back.
        session: {
            get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k ?? sessionStore); return Object.fromEntries(keys.filter((x) => x in sessionStore).map((x) => [x, sessionStore[x]])); },
            set: async (o) => { Object.assign(sessionStore, JSON.parse(JSON.stringify(o))); }, remove: async (k) => { for (const x of [k].flat()) delete sessionStore[x]; },
        },
        onChanged: { addListener() {} },
    },
};
const { shRun, detachedText, SH_TAIL_ABSENT } = await import("../src/sw/sw-shell-call.ts");
const { SH_LEASE_MS, SH_HOST_TIMEOUT_MS } = await import("../src/shell/sh-call.ts");
const { taskAction, endTasks, withTasks, openTasks, taskDrained } = await import("../src/sw/sw-tasks.ts");
const { runInboxes } = await import("../src/sw/sw-runs.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");
const { builtinTool } = await import("../src/tools/tool-registry.ts");

let rootN = 0;
/**
 * A fresh host whose `done` is held until the test releases it, as a long call's is: `cancel` is answered
 * `signalled` and sends the held `done` as cancelled, which is what the real host does (SIGTERM, then the event).
 * @param opts the fake host's options
 */
function slowHost(opts = {}) {
    const host = fakeNativeHost(opts);
    const held = [];
    let end;
    host.onNative = ((inner) => (name, e) => {
        end = e;
        const recv = inner(name, { send: (m) => { if (m?.event === "done") { held.push(m); return; } e.send(m); }, close: e.close });
        return recv && ((m) => {
            if (m.call === "cancel") {
                host.calls.push(m);
                const d = held.findIndex((x) => x.id === m.args.id);
                if (d < 0) { end.send({ seq: m.seq, error: { code: "UnknownId", message: "no such call" } }); return; }
                end.send({ seq: m.seq, value: { signalled: true } });
                const [x] = held.splice(d, 1);
                end.send({ ...x, cancelled: true, ok: false, code: null, signal: "SIGTERM" });
                return;
            }
            recv(m);
        });
    })(host.onNative);
    host.finish = () => { for (const m of held.splice(0)) end.send(m); };
    native = host.onNative;
    sync.shellRoots = [`/w/p${++rootN}`];
    return host;
}

const ctxFor = (runId, extra = {}) => ({ runId, seq: 3, local: { step: 1, seq: 3 }, signal: new AbortController().signal, tokens: new TokenStore(), ...extra });
/** A run whose turn is live: its inbox is open and its task table announces through `fanned`. */
function liveRun(runId) {
    runInboxes.set(runId, { tabId: 7, queue: [] });
    const fanned = [];
    openTasks(runId, (text, task) => fanned.push({ text, task }));
    return { inbox: () => runInboxes.get(runId).queue, fanned };
}
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); } };
const TASK_ID = /^t[0-9a-f]{6}$/;

// --- the lease: inside it a call is a value; past it the call detaches and runs on ---

test("a call that ends inside its lease is a value, with no task and nothing in the inbox", T, async () => {
    fakeNativeHost();
    const host = fakeNativeHost();
    native = host.onNative; sync.shellRoots = [`/w/p${++rootN}`];
    const run = liveRun("run-fast");
    const r = await shRun(ctxFor("run-fast"), [["ls"], { expectMs: 5000 }]);
    assert.ok("ok" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.ok.code, 0);
    assert.deepEqual(run.inbox(), []);
    assert.match(await taskAction("run-fast", { op: "await", id: "t000000" }), /^UnknownTask/);
    await endTasks("run-fast");
});

test("a call past its expectMs detaches: the script's await answers Detached with the task id, the process is not cancelled, and its result arrives through the inbox labelled with the id", T, async () => {
    const host = slowHost();
    const run = liveRun("run-slow");
    const r = await shRun(ctxFor("run-slow"), [["ls"], { expectMs: 60 }]);
    assert.equal(r.code, "Detached", JSON.stringify(r));
    assert.match(r.task, TASK_ID);
    assert.match(r.error, /you expected ~0 s/, "the predicted case, in its own words");
    assert.match(r.error, new RegExp(`task ${r.task}`));
    assert.match(r.error, /cancelled when this turn ends/);
    assert.ok(!host.names().includes("cancel"), "a detach must never cancel the call");
    assert.deepEqual(run.inbox(), [], "nothing is in the inbox while it runs");
    host.finish();
    await until(() => run.inbox().length > 0);
    const [item] = run.inbox();
    assert.equal(item.task, r.task, "the inbox item names its task, which only sw-tasks sets");
    assert.equal(item.origin, undefined, "a task's result claims no person's surface");
    assert.match(item.text, new RegExp(`^\\[task ${r.task} done after \\d+ s: ml\\.sh exit 0, ok; stdout @tool:[0-9a-f]{7} \\(4 B\\): "out\\\\n"; stderr empty\\]$`));
    assert.deepEqual(run.fanned, [], "a queued result was drawn before the model read it");
    taskDrained("run-slow", item.task, item.text);   // the loop drains it at its next step (sw-run-host.ts drainInbox)
    assert.deepEqual(run.fanned.map((f) => [f.task, f.text]), [[r.task, item.text]], "the surfaces are told, as the task's, once the model reads it");
    await endTasks("run-slow");
});

test("a result that settles during the turn's last model call is never drawn: the loop never drained it, and the turn's end drops it", T, async () => {
    const host = slowHost();
    const run = liveRun("run-last-call");
    const r = await shRun(ctxFor("run-last-call"), [["ls"], { expectMs: 30 }]);
    host.finish();   // settles while the model writes its answer: no step boundary follows
    await until(() => run.inbox().length > 0);
    assert.equal(run.inbox()[0].task, r.task, "positive control: it was queued");
    runInboxes.delete("run-last-call");   // the turn ends: the run host closes the inbox, then settles
    await endTasks("run-last-call");
    assert.deepEqual(run.fanned, [], "the transcript would show a result the model never read");
});

test("the Detached text says which case it was: the script's own estimate, or the default, and the host's time limit", () => {
    assert.match(detachedText("t1", 13 * 60_000, { expectMs: 13 * 60_000 }), /you expected ~780 s and it is still running: investigate the stall/);
    const d = detachedText("t1", SH_LEASE_MS, {});
    assert.match(d, new RegExp(`no expectMs was given, so the ${SH_LEASE_MS / 1000} s default applied`));
    assert.doesNotMatch(d, /you expected/, "the two phrasings are never merged");
    assert.match(d, new RegExp(`host kills it at ${SH_HOST_TIMEOUT_MS / 1000} s`));
    assert.match(detachedText("t1", 1000, { timeoutMs: 600_000 }), /host kills it at 600 s/);
    assert.ok(SH_LEASE_MS >= 1000 && SH_LEASE_MS < 60_000, "the placeholder is seconds, not minutes");
});

test("what the model reads about ml.sh.run names no lease number, which a build's __SH_LEASE_MS__ would falsify, and the host's real limit", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/contract.ts", import.meta.url), "utf8");
    const doc = src.slice(src.indexOf("export interface MlSh"), src.indexOf("read(token: string"));
    // The lease a build ships is a define (build.mjs), so the docs say where it is named instead: the Detached error.
    assert.ok(doc.includes("up to `expectMs` (default: a short lease, which the `Detached` error names)"), "the JSDoc's lease wording changed");
    assert.doesNotMatch(doc.slice(0, doc.indexOf("@param argv")), /\b\d+ s\b/, "the JSDoc states a lease in seconds");
    assert.ok(doc.includes(`default ${SH_HOST_TIMEOUT_MS / 1000} s`), "the JSDoc's host limit drifted from SH_HOST_TIMEOUT_MS");
});

test("what the model reads says ml.sh is a namespace called as ml.sh.run(argv), never ml.sh(...) with a shell string", async () => {
    // A bench canary (gemma4:e4b) wrote `await ml.sh('cat ~/.ssh/config')` from the text before this clause.
    const { ML_API_DOCS } = await import("../src/api-docs.gen.ts");
    const text = ML_API_DOCS;
    assert.match(text, /A namespace, not a function: `await ml\.sh\.run\(\[/);
    assert.match(text, /takes an argv array,[\s*]*never a shell string/);
});

test("expectMs is checked like timeoutMs: a positive number, refused otherwise before the host is reached", T, async () => {
    const host = slowHost();
    for (const bad of [0, -5, "10", Infinity, NaN]) {
        const r = await shRun(ctxFor("run-bad-expect"), [["ls"], { expectMs: bad }]);
        assert.equal(r.code, "BadRequest", `${bad}: ${JSON.stringify(r)}`);
    }
    assert.ok(!host.names().includes("spawn"), "a bad expectMs reached the host");
});

test("a call made with lease:false never detaches: the extension's own read waits for its value", T, async () => {
    const host = slowHost();
    liveRun("run-nolease");
    const p = shRun(ctxFor("run-nolease", { lease: false }), [["ls"], { expectMs: 30 }]);
    let settled = false;
    void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(settled, false, "it answered before the call ended");
    host.finish();
    const r = await p;
    assert.ok("ok" in r, JSON.stringify(r));
    await endTasks("run-nolease");
});

// --- the task tool: await, cancel and tail act only on this run's own tasks ---

test("task await answers with the result when the call ends inside its timeout, and the inbox does not carry it a second time", T, async () => {
    const host = slowHost();
    const run = liveRun("run-await");
    const r = await shRun(ctxFor("run-await"), [["ls"], { expectMs: 30 }]);
    const waiting = taskAction("run-await", { op: "await", id: r.task, timeout_ms: 5000 });
    setTimeout(() => host.finish(), 50);
    assert.match(await waiting, new RegExp(`^task ${r.task} done after \\d+ s: ml\\.sh exit 0`));
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(run.inbox(), [], "the awaited result was also queued for the inbox");
    assert.match(await taskAction("run-await", { op: "await", id: r.task }), /^task t[0-9a-f]{6} done: /, "a later await reads the same result");
    await endTasks("run-await");
});

test("an await that lands while a task's end is being scrubbed waits for the text, and the inbox does not carry it too", T, async () => {
    const host = slowHost();
    const run = liveRun("run-scrub-window");
    const r = await shRun(ctxFor("run-scrub-window"), [["ls"], { expectMs: 30 }]);
    syncDelayMs = 80;
    try {
        host.finish();
        await new Promise((res) => setTimeout(res, 20));   // inside the scrub
        const answer = await taskAction("run-scrub-window", { op: "await", id: r.task, timeout_ms: 5000 });
        assert.match(answer, new RegExp(`^task ${r.task} done after \\d+ s: ml\\.sh exit 0`), `an await in the scrub read an empty stub: ${answer}`);
        await new Promise((res) => setTimeout(res, 120));
        assert.deepEqual(run.inbox(), [], "the awaited result was also queued for the inbox");
    } finally { syncDelayMs = 0; }
    await endTasks("run-scrub-window");
});

test("a result queued for the inbox and then read by an await is dropped at the drain: the model never reads it twice", T, async () => {
    const host = slowHost();
    const run = liveRun("run-queued-then-awaited");
    const r = await shRun(ctxFor("run-queued-then-awaited"), [["ls"], { expectMs: 30 }]);
    host.finish();
    await until(() => run.inbox().length === 1);
    assert.match(await taskAction("run-queued-then-awaited", { op: "await", id: r.task }), new RegExp(`^task ${r.task} done: `));
    const [item] = run.inbox().splice(0);
    assert.equal(taskDrained("run-queued-then-awaited", item.task, item.text), false, "the drain would inject a result the model already read");
    assert.deepEqual(run.fanned, [], "a result the drain dropped was drawn");
    await endTasks("run-queued-then-awaited");
});

test("task await that runs out says so in the model's own case and leaves the call running", T, async () => {
    const host = slowHost();
    liveRun("run-await-out");
    const r = await shRun(ctxFor("run-await-out"), [["ls"], { expectMs: 30 }]);
    assert.match(await taskAction("run-await-out", { op: "await", id: r.task, timeout_ms: 40 }), /still running after \d+ s; you expected it within 0 s more\. Investigate the stall/);
    assert.ok(!host.names().includes("cancel"), "an await that runs out cancelled the call");
    const [row] = (await withTasks(snap(), "run-await-out")).tasks.rows;
    assert.equal(row[3], "running");
    host.finish();
    await endTasks("run-await-out");
});

test("task cancel cancels the process on the host, says what happened, and the cancelled result still arrives", T, async () => {
    const host = slowHost();
    const run = liveRun("run-cancel");
    const r = await shRun(ctxFor("run-cancel"), [["ls"], { expectMs: 30 }]);
    assert.match(await taskAction("run-cancel", { op: "cancel", id: r.task }), /cancelled: the host signalled its process group/);
    assert.equal(host.calls.filter((c) => c.call === "cancel").length, 1);
    await until(() => run.inbox().length > 0);
    assert.match(run.inbox()[0].text, new RegExp(`^\\[task ${r.task} cancelled after`));
    assert.match(await taskAction("run-cancel", { op: "cancel", id: r.task }), /already cancelled/);
    await endTasks("run-cancel");
});

test("task tail on a running ml.sh call says the host reports output at the end, never an empty tail", T, async () => {
    const host = slowHost();
    liveRun("run-tail");
    const r = await shRun(ctxFor("run-tail"), [["ls"], { expectMs: 30 }]);
    const t = await taskAction("run-tail", { op: "tail", id: r.task, lines: 5 });
    assert.ok(t.endsWith(SH_TAIL_ABSENT), t);
    host.finish();
    await endTasks("run-tail");
});

test("another run's task id and a made-up one read the same UnknownTask, and no action reaches the host", T, async () => {
    const host = slowHost();
    liveRun("run-own");
    liveRun("run-other");
    const r = await shRun(ctxFor("run-own"), [["ls"], { expectMs: 30 }]);
    const before = host.calls.length;
    for (const op of ["await", "cancel", "tail"]) {
        const foreign = await taskAction("run-other", { op, id: r.task, timeout_ms: 20 });
        const madeUp = await taskAction("run-other", { op, id: "tffffff", timeout_ms: 20 });
        assert.equal(foreign.replace(r.task, "X"), madeUp.replace("tffffff", "X"), `${op}: a foreign id is distinguishable from a made-up one`);
        assert.match(foreign, /^UnknownTask/);
    }
    for (const id of [undefined, 7, { id: r.task }, [r.task]]) assert.match(await taskAction("run-other", { op: "cancel", id }), /^UnknownTask/);
    assert.equal(host.calls.length, before, "an action for another run reached the host");
    assert.equal((await withTasks(snap(), "run-other")).tasks, undefined, "another run's task is in this run's table");
    host.finish();
    await endTasks("run-own");
    await endTasks("run-other");
});

test("task is a builtin the worker runs, offered nothing outside the run: not gated, not citable, no start-card line", () => {
    const t = builtinTool("task");
    assert.ok(t, "not in the registry");
    assert.deepEqual({ gated: t.gated, citable: t.citable, realm: t.realm, cardLine: t.cardLine }, { gated: false, citable: false, realm: "worker", cardLine: null });
});

// --- the turn's end: no task outlives it ---

test("the turn's end cancels a running task on the host, and its result is never injected afterwards", T, async () => {
    const host = slowHost();
    const run = liveRun("run-end");
    const r = await shRun(ctxFor("run-end"), [["ls"], { expectMs: 30 }]);
    const inbox = run.inbox();
    runInboxes.delete("run-end");   // the run host closes the inbox first, then settles
    await endTasks("run-end");
    assert.equal(host.calls.filter((c) => c.call === "cancel" && c.args.id).length, 1, "the turn ended with the call still running on the host");
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(inbox, [], "a result arrived in the ended turn's inbox");
    assert.deepEqual(run.fanned, [], "an ended turn's surfaces were told of a result");
    assert.match(await taskAction("run-end", { op: "await", id: r.task }), /^UnknownTask/, "the task outlived its turn");
});

test("a task whose cancel cannot reach the host is reported as an orphan, not as cancelled", T, async () => {
    const host = slowHost();
    liveRun("run-orphan");
    await shRun(ctxFor("run-orphan"), [["ls"], { expectMs: 30 }]);
    host.exit("host exited");   // the port closes: the cancel has nowhere to go
    const { runLog } = await import("../src/sw/sw-run-log.ts");
    await endTasks("run-orphan");
    const recs = (await runLog.forRun("run-orphan")).filter((e) => e.subsystem === "task");
    assert.deepEqual(recs.map((e) => [e.kind, e.reason, e.level]), [["orphaned", "turn-end", "warn"]], "a cancel that never reached the host was reported as one");
});

// --- ml.current.tasks: the run's own rows, read at the snapshot's instant ---

/** A snapshot as the host makes one, with nothing in it. */
const snap = () => ({ run: { id: "h", model: null, step: 1, maxSteps: 8, startedTs: 0 }, messages: [], meta: [], log: Object.assign([], { text: "" }) });

test("ml.current.tasks is absent with no task, and one row per task with the ruled columns once there is one", T, async () => {
    const host = slowHost();
    liveRun("run-rows");
    assert.equal((await withTasks(snap(), "run-rows")).tasks, undefined);
    const t0 = Date.now();
    const r = await shRun(ctxFor("run-rows"), [["ls"], { expectMs: 40 }]);
    const { tasks } = await withTasks(snap(), "run-rows");
    assert.deepEqual(tasks.columns, ["id", "kind", "tool", "status", "started", "elapsed_ms", "lease_ms", "expect_ms", "tail", "result"]);
    assert.deepEqual(tasks.shape, [1, 10]);
    const [row] = tasks.rows;
    const col = (c) => row[tasks.columns.indexOf(c)];
    assert.deepEqual([col("id"), col("kind"), col("tool"), col("status"), col("lease_ms"), col("expect_ms"), col("tail"), col("result")], [r.task, "call", "ml.sh", "running", 40, 40, null, null]);
    assert.ok(col("started") >= t0 && col("elapsed_ms") >= 40, JSON.stringify(row));
    host.finish();
    await until(() => runInboxes.get("run-rows").queue.length > 0);
    const done = (await withTasks(snap(), "run-rows")).tasks.rows[0];
    assert.equal(done[3], "done");
    assert.match(done[9], /^@tool:[0-9a-f]{7}$/, "a done task's result is its pointer");
    await endTasks("run-rows");
    assert.equal((await withTasks(snap(), "run-rows")).tasks, undefined, "the rows outlived the turn");
});

// --- the bench varies the lease per cell: a build-time define, the shipped 15 s otherwise ---

test("__SH_LEASE_MS__ sets the lease a build ships, as the bench's cells define it; absent, the 15 s placeholder", async () => {
    const esbuild = await import("esbuild");
    const vm = await import("node:vm");
    const entry = new URL("../src/shell/sh-call.ts", import.meta.url).pathname;
    const leaseOf = async (define) => {
        const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral", logLevel: "silent", ...(define ? { define } : {}) });
        const mod = { exports: {} };
        vm.runInNewContext(out.outputFiles[0].text, { module: mod, exports: mod.exports, crypto: globalThis.crypto, TextEncoder, TextDecoder });
        return mod.exports.SH_LEASE_MS;
    };
    assert.equal(await leaseOf({ __SH_LEASE_MS__: "5000" }), 5000);
    assert.equal(await leaseOf({ __SH_LEASE_MS__: "60000" }), 60000);
    assert.equal(await leaseOf(), 15000, "undefined: the shipped placeholder");
});

test("build.mjs refuses an __SH_LEASE_MS__ that is not a positive integer, before it builds anything", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = new URL("..", import.meta.url).pathname;
    for (const bad of ["0", "-5", "15s", "1.5", ""]) {
        const out = mkdtempSync(join(tmpdir(), "wml-lease-"));
        try {
            const r = spawnSync(process.execPath, ["build.mjs", "--outdir", join(out, "d"), "--define", `__SH_LEASE_MS__=${bad}`], { cwd: root, encoding: "utf8", timeout: 20000 });
            assert.notEqual(r.status, 0, `${JSON.stringify(bad)} built`);
            assert.match(r.stderr, /__SH_LEASE_MS__ must be a positive integer of milliseconds/);
        } finally { rmSync(out, { recursive: true, force: true }); }
    }
});

test("the task line reads under a second as \"<1 s\", never \"0 s\"", async () => {
    const { taskLineText } = await import("../src/sidebar/transcript/task-line.tsx");
    assert.equal(taskLineText("t1", { status: "done", ms: 300, code: 0 }), "✓ task t1 finished · <1 s · exit 0");
    assert.equal(taskLineText("t1", { status: "done", ms: 1600, code: 0 }), "✓ task t1 finished · 2 s · exit 0");
});
