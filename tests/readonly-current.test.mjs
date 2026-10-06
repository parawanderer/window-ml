"use strict";
// readonly-current.test.mjs — `ml.current`: a run reading its own context from a read-only `exec`
// (docs/spec/CURRENT_CONTEXT.md), and the WORKER realm it is read in.
//
// Four layers, in the order data flows: the loop RECORDS what only the moment of appending knows, the snapshot
// ASSEMBLES it, the dialect READS it under its usual guarantees, and the worker realm keeps it out of the page. The
// security property is the last one, and it is a property of two realms together: the worker has the run's context and
// no page, the page has a DOM and no run context, so a survey needing both is refused on both sides.
import { test, after } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { Worker } from "node:worker_threads";
import { runAgentLoop } from "../src/agent-loop.ts";
import { snapshotCurrent, logText, messageId, UNRECORDED } from "../src/current-context.ts";
import { evalReadonly, NotInDialect, Denied, NeedsPage, ABRIDGE_OVER } from "../src/readonly-exec.ts";
import { evalReadonlyInWorker } from "../src/sw-readonly.ts";
import { mlPipe } from "../src/text-pipe.ts";
import { toolToken } from "../src/util.ts";

const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;
const LONG_SYSTEM = "You are an agent. ".repeat(200);   // 3,600 chars, like the real one: what the print boundary is for

/** A snapshot of a small, realistic run: a system prompt, the task, an assistant turn calling a tool, its result. */
function sampleSnapshot(now = 1_000_000) {
    return snapshotCurrent({
        run: { id: "runhash1", model: "gemma4:31b", step: 2, maxSteps: 10, startedTs: now - 60_000 },
        messages: [
            { role: "system", content: LONG_SYSTEM },
            { role: "user", content: "find the price" },
            { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }] },
            { role: "tool", tool_call_id: "c1", content: "x".repeat(900) },
        ],
        recorded: [
            { ...UNRECORDED, ts: now - 60_000, step: 0 },
            { ...UNRECORDED, ts: now - 60_000, step: 0, surface: "hud" },
            { ...UNRECORDED, ts: now - 50_000, step: 1, counted: 37 },
            { ...UNRECORDED, ts: now - 10_000, step: 1, seq: 1, tool: "exec", truncated: true },
        ],
        log: [{ t: now - 20_000, subsystem: "page", kind: "discarded", origin: "sw", run: "runhash1", key: "SECRET-KEY" },
              { t: now - 15_000, subsystem: "page", kind: "reloaded", reason: "gone", origin: "sw", run: "runhash1", detail: { tab: 7 } }],
        now,
    });
}
const doc = () => new JSDOM("<!doctype html><body><p id='p'>hi</p></body>").window.document;
/** The worker realm, with what a worker can answer for itself. */
const workerMl = { config: async () => ({ model: "gemma4:31b" }), range: (n) => Array.from({ length: n }, (_, i) => i), pipe: mlPipe };
const inWorkerRealm = (js, snap = sampleSnapshot()) => evalReadonly(js, null, workerMl, undefined, { realm: "worker", current: snap });

// --- the snapshot: what `ml.current` is, assembled from what the loop recorded ------------------------------------------

test("meta is parallel to messages, with ages, gaps, sizes and where a prompt was typed", () => {
    const s = sampleSnapshot();
    assert.equal(s.meta.length, s.messages.length);
    const [sys, task, asst, tool] = s.meta;
    assert.equal(task.surface, "hud", "a user message says where it was typed");
    assert.equal(sys.surface, null, "and nothing else does");
    assert.equal(task.ageMs, 60_000);
    assert.equal(tool.gapMs, 40_000, "the gap since the previous message, pre-computed");
    assert.deepEqual([asst.tokens, asst.tokensBasis], [37, "counted"], "the engine's own count, labelled as one");
    assert.equal(sys.tokensBasis, "estimated");
    assert.equal(sys.tokens, Math.ceil(LONG_SYSTEM.length / 4));
    assert.deepEqual([tool.tool, tool.seq, tool.step, tool.truncated], ["exec", 1, 1, true]);
});

test("a message's id is stable across snapshots, checkable, and never a @tool: id of the same run", () => {
    const a = sampleSnapshot(1_000_000), b = sampleSnapshot(2_000_000);
    assert.deepEqual(a.meta.map((m) => m.id), b.meta.map((m) => m.id), "the same message has the same id at another instant");
    assert.equal(new Set(a.meta.map((m) => m.id)).size, a.meta.length, "distinct");
    for (let i = 0; i < 4; i++) assert.notEqual(messageId("runhash1", i), toolToken("runhash1", i), "its own namespace");
});

test("history from an earlier turn is UNKNOWN, never stamped now; images are counted and kept out of the estimate", () => {
    const s = snapshotCurrent({
        run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 },
        messages: [{ role: "user", content: "old" }, { role: "user", content: "look", images: ["data:image/png;base64," + "A".repeat(50_000)] }],
        recorded: [], now: 10,
    });
    assert.deepEqual([s.meta[0].ts, s.meta[0].ageMs, s.meta[0].gapMs], [null, null, null]);
    assert.equal(s.meta[1].images, 1);
    assert.equal(s.meta[1].tokens, 1, "the 50k-char data URL is not estimated as 12,500 tokens of text");
});

test("the snapshot is a COPY: nothing done to it reaches the messages the loop holds", () => {
    const loopMessages = [{ role: "user", content: "keep me" }];
    const s = snapshotCurrent({ run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 }, messages: loopMessages, recorded: [], now: 1 });
    s.messages[0].content = "changed";
    assert.equal(loopMessages[0].content, "keep me");
});

test("the log is records AND greppable text; the withheld key never appears", () => {
    const { log } = sampleSnapshot();
    assert.ok(Array.isArray(log));
    assert.deepEqual(log.map((r) => r.kind), ["discarded", "reloaded"]);
    assert.deepEqual(Object.keys(log[1]).sort(), ["detail", "kind", "reason", "subsystem", "ts"]);
    assert.ok(!JSON.stringify(log).includes("SECRET-KEY") && !log.text.includes("SECRET-KEY"), "`key` is withheld from a model as from a page");
    assert.equal(log.text, logText(log));
    assert.match(log.text, /^1970-01-01T00:16:20Z page discarded\n1970-01-01T00:16:25Z page reloaded gone \{"tab":7\}$/);
    assert.doesNotMatch(log.text, / {2}/, "no padding: a model reads it");
});

// --- the loop records each message as it is appended -----------------------------------------------------------------

function loopDeps(turns, { onTool } = {}) {
    let i = 0, snap = null;
    const queued = [];
    const deps = {
        callModel: async () => turns[i++] || { content: "" },
        runTool: async (name, args) => onTool ? onTool(name, args) : { result: `ran:${name}` },
        approve: async () => true,
        autoApprove: () => "readonly",
        buildMessages: (task) => [{ role: "system", content: "sys" }, { role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        pushUser: (m, text) => m.push({ role: "user", content: text }),
        drainInbox: () => queued.splice(0),
    };
    return { deps, queued, sink: (f) => { snap = f; }, snap: (x) => snap(x) };
}

test("the loop records the task's surface, each step, each tool, a counted reply, and a steered prompt's own surface", async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 12 };
    const L = loopDeps([
        { content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }], usage },
        { content: "thinking out loud", tool_calls: [{ id: "c2", name: "exec", arguments: { js: "2" } }], usage, reasoning: "hidden chain" },
        { content: "done", tool_calls: [], usage },
    ]);
    let seen;
    L.deps.runTool = async () => {
        if (!seen) L.queued.push({ text: "also check the tax", origin: { surface: "chat", remote: true } });
        seen = true;
        return { result: "ok", renderOut: { type: "exec-out", stdout: "y".repeat(800), seen: 500 } };
    };
    await runAgentLoop("find the price", { tools: [{ name: "exec" }], runHash: "h1", origin: { surface: "hud" }, contextSink: L.sink }, L.deps);
    const s = L.snap({ model: "gemma4:31b" });
    const roles = s.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user", "assistant", "tool", "assistant"]);
    const m = s.meta;
    assert.equal(m[1].surface, "hud", "the task carries the run's own surface");
    assert.equal(m[4].surface, "chat", "a steering message carries where IT was typed");
    assert.deepEqual([m[2].tokensBasis, m[2].tokens], ["counted", 12], "a reply with no reasoning is measured by its count");
    assert.equal(m[5].tokensBasis, "estimated", "a reply that also reasoned is NOT: its count includes reasoning not re-sent");
    assert.deepEqual([m[3].tool, m[3].seq, m[3].step, m[3].truncated], ["exec", 1, 1, true], "the model saw 500 of 800");
    assert.ok(m.every((x) => typeof x.ts === "number"), "every message this turn appended has a time");
    assert.equal(s.run.model, "gemma4:31b");
    assert.equal(s.run.id, "h1");
});

// --- the dialect reads it: plain data, a synchronous join, and the write rules -----------------------------------------

test("the spec's own join runs as written: messages and meta zip by index, synchronously, inside a callback", async () => {
    const { value } = await inWorkerRealm(`const meta = ml.current.meta;
return ml.current.messages
    .map((m, i) => ({ m, meta: meta[i] }))
    .filter(x => x.meta.tokens > 100)
    .map(x => x.meta.id + " " + x.m.role + " " + x.meta.tokens + "t");`);
    assert.equal(value.length, 2, "the system prompt and the long tool result");
    assert.match(value[0], / system 900t$/);
});

test("WRITE RULES: messages throw a TypeError the model reads (never the approval gate); meta and run are copies it owns", async () => {
    for (const js of [
        `ml.current.messages[0].content = "x"`,
        `ml.current.messages.push({ role: "user", content: "x" })`,
        `ml.current.messages.splice(0, 1)`,
        `ml.current.messages.sort()`,
        `ml.current.messages[2].tool_calls[0].name = "evil"`,
        `ml.current.messages[2].tool_calls.pop()`,
        `const m = ml.current.messages[1]; m.content += "!"`,
        `const { messages } = ml.current; messages.length = 0`,
    ]) {
        await assert.rejects(inWorkerRealm(js), (e) => e instanceof TypeError && /ml\.current\.messages is read-only/.test(e.message), js);
    }
    // A top-level copy is the script's own: writable one level down, and the protection stays on what it aliases.
    assert.equal((await inWorkerRealm(`const c = { ...ml.current.messages[1] }; c.content = "mine"; return c.content`)).value, "mine");
    await assert.rejects(inWorkerRealm(`const c = { ...ml.current.messages[2] }; c.tool_calls.push(1)`), TypeError);
    // meta: annotate a working copy, which is how a compaction is planned.
    assert.equal((await inWorkerRealm(`const m = ml.current.meta; m[0].drop = true; m.push({ note: 1 }); return m.length + ":" + m[0].drop`)).value, "5:true");
    assert.equal((await inWorkerRealm(`ml.current.run.step = 99; return ml.current.run.step`)).value, 99);
});

test("WRITE RULES: an annotated meta never reaches the next snapshot, and the snapshot source is never touched", async () => {
    const snap = sampleSnapshot();
    await inWorkerRealm(`ml.current.meta[0].tokens = 1; ml.current.meta.pop(); ml.current.run.id = "forged"`, snap);
    assert.equal(snap.meta.length, 4, "the snapshot's own meta array is unchanged");
    assert.notEqual(snap.meta[0].tokens, 1);
    assert.equal(snap.run.id, "runhash1");
});

test("ADVERSARIAL: nothing on ml.current is a live object, a realm, or a way to address another run", async () => {
    assert.deepEqual((await inWorkerRealm(`Object.keys(ml.current)`)).value, ["run", "messages", "meta", "log"], "no id lookup to forge");
    for (const js of [
        `ml.current.constructor`, `ml.current.messages.constructor`, `ml.current.meta[0].__proto__`,
        `ml.current.log.constructor.constructor("return this")()`, `ml.current["__proto__"]`,
    ]) await assert.rejects(inWorkerRealm(js), outOfDialect, js);
});

test("THE PRINT BOUNDARY: a large message prints as a summary naming how to print it whole; the value is untouched", async () => {
    const { value, logs } = await inWorkerRealm(`console.log(ml.current.messages); return ml.current.messages[0].content.length`);
    assert.equal(value, LONG_SYSTEM.length, "the real length, whatever the print showed");
    const printed = JSON.parse(logs[0]);
    assert.equal(printed[0].abridged, "print ml.current.messages[0].content for all 3600 chars");
    assert.equal(printed[0].chars, 3600);
    assert.equal(printed[1].content, "find the price", "a small message prints whole");
    assert.match(printed[3].abridged, /messages\[3\]/, "by SIZE, not role: a large tool result abridges too");
    // Naming the content prints it, an explicit act over honest data.
    const named = await inWorkerRealm(`console.log(ml.current.messages[0].content)`);
    assert.equal(named.logs[0].length, LONG_SYSTEM.length);
    // A RETURNED row is abridged the same way, wherever it sits in the result.
    const ret = await inWorkerRealm(`return ml.current.messages.slice(0, 1).map(m => ({ m }))`);
    assert.match(ret.value[0].m.abridged, /messages\[0\]/);
    assert.ok(ABRIDGE_OVER < 900);
});

test("the log: an ordinary Array for filtering, and `.text` for ml.pipe", async () => {
    assert.deepEqual((await inWorkerRealm(`ml.current.log.filter(r => r.kind === "reloaded").map(r => r.reason)`)).value, ["gone"]);
    assert.equal((await inWorkerRealm(`ml.pipe(ml.current.log, "grep reloaded")`)).value, "1970-01-01T00:16:25Z page reloaded gone {\"tab\":7}");
});

// --- the worker realm: run context and no page; the page: a DOM and no run context -------------------------------------

test("WORKER REALM: every route to the page defers the survey to the page — by name, by alias, by destructuring", async () => {
    for (const js of [
        `document.title`, `typeof document`, `getComputedStyle`, `ml.queryAll("p")`, `ml.a11y`,
        `ml.answer.add("x")`, `const { answer } = ml; answer`, `const m = ml; m.queryAll("p")`,
        `ml.fetch("https://example.test/")`, `ml.somethingAddedLater()`,
        `ml.current.messages.length; document.body`,
    ]) await assert.rejects(inWorkerRealm(js), (e) => e instanceof NeedsPage, js);
});

test("WORKER REALM: a script's try/catch cannot keep it in the worker after it reached for the page", async () => {
    await assert.rejects(inWorkerRealm(`let n = ml.current.messages.length; try { document.body } catch (e) { n = -1 } return n`), NeedsPage);
});

test("WORKER REALM: what the worker can answer for itself runs there", async () => {
    assert.equal((await inWorkerRealm(`(await ml.config()).model`)).value, "gemma4:31b");
    assert.deepEqual((await inWorkerRealm(`ml.range(3)`)).value, [0, 1, 2]);
    assert.equal((await inWorkerRealm(`ml.pipe("a\\nb", "grep b")`)).value, "b");
});

test("THE PAGE HAS NO RUN CONTEXT: ml.current there is a refusal, so a survey needing both reaches the human either way", async () => {
    await assert.rejects(evalReadonly(`ml.current.messages`, doc(), workerMl), (e) => outOfDialect(e) && !(e instanceof NeedsPage));
    // Not `undefined`: that would let a survey needing both evaluate to a plausible wrong answer with no one asked.
    await assert.rejects(evalReadonly(`document.title + ml.current.messages.length`, doc(), workerMl), (e) => outOfDialect(e) && !(e instanceof NeedsPage));
    await assert.rejects(evalReadonly(`const { current } = ml; current`, doc(), workerMl), outOfDialect);
    // Both orders. In the worker it trips on the page; on the page it is refused on the run. Neither runs it.
    for (const js of [`document.body; ml.current.messages`, `ml.current.messages; document.body`]) {
        await assert.rejects(inWorkerRealm(js), NeedsPage, `worker: ${js}`);
        await assert.rejects(evalReadonly(js, doc(), workerMl), (e) => outOfDialect(e) && !(e instanceof NeedsPage), `page: ${js}`);
    }
});

// --- evalReadonlyInWorker: what a host calls -------------------------------------------------------------------------

test("evalReadonlyInWorker answers, defers, refuses, and reports a script's own error with its line", async () => {
    let snaps = 0;
    const deps = { current: () => { snaps++; return sampleSnapshot(); }, ml: workerMl };
    const a = await evalReadonlyInWorker({ js: "return ml.current.meta.length" }, deps);
    assert.equal(a.kind, "answered"); assert.equal(a.result, "4");
    assert.equal((await evalReadonlyInWorker({ js: "document.title" }, deps)).kind, "needs-page");
    assert.equal((await evalReadonlyInWorker({ js: "window.location" }, deps)).kind, "refused");
    assert.equal((await evalReadonlyInWorker({ js: "return 1", maxChars: 6000 }, deps)).kind, "refused", "a raised cap is the human's to grant");
    const err = await evalReadonlyInWorker({ js: "const a = 1;\nJSON.parse(\"{\")" }, deps);
    assert.equal(err.kind, "answered"); assert.match(err.result, /^Error: .*\(line 2\)$/);
    // A survey that never says `current` copies nothing.
    snaps = 0;
    await evalReadonlyInWorker({ js: "return 1 + 1" }, deps);
    assert.equal(snaps, 0);
    // `@tool:` defers until the host gives the worker a `dereference` (the site-access slice 2's).
    assert.equal((await evalReadonlyInWorker({ js: "return @tool:abc1234.length" }, deps)).kind, "needs-page");
});

// --- HALTING and FAILURE ----------------------------------------------------------------------------------------------
// The halting argument for a loop over `messages` is that the array cannot grow. That argument dies with the write half
// (`for (const m of ml.current.messages) ml.current.drop(m)` is the Set/Map mutator bug again), so it is tested NOW,
// against the read-only shape, in a worker with a timeout, so a regression fails instead of hanging the runner.

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const CC_URL = new URL("../src/current-context.ts", import.meta.url).href;
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return Promise.all([import(workerData.ro), import(workerData.cc)]); });
        parentPort.on("message", ({ id, src, n }) => ready
            .then(([ro, cc]) => ro.evalReadonly(src, null, {}, undefined, { realm: "worker", stepBudget: 200000,
                current: cc.snapshotCurrent({ run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 },
                    messages: Array.from({ length: n }, (_, i) => ({ role: "user", content: "m" + i })), recorded: [], now: 1 }) }))
            .then((r) => parentPort.postMessage({ id, value: r.value }),
                  (e) => parentPort.postMessage({ id, threw: e.constructor.name, message: e.message })));`,
        { eval: true, workerData: { ro: RO_URL, cc: CC_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API } });
    worker.on("message", ({ id, ...r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: "WorkerError", message: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());
function inThread(src, n = 3, ms = 5000) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, n });
    });
}

test("HALTING: a loop that tries to grow the messages it iterates ends at once, with the read-only error", async () => {
    for (const src of [
        `for (const m of ml.current.messages) ml.current.messages.push(m); 0`,
        `ml.current.messages.forEach(m => ml.current.messages.push(m)); 0`,
        `const all = ml.current.messages; for (const m of all) all[all.length] = m; 0`,
    ]) {
        const r = await inThread(src);
        assert.ok(!r.hung, `${src}: still running after 5 s`);
        assert.equal(r.threw, "TypeError", src);
    }
});

test("HALTING: a survey over a large context is bounded by the step budget, not by how big the context is", async () => {
    const r = await inThread(`ml.current.messages.map(a => ml.current.messages.map(b => a.content + b.content).length).length`, 2000);
    assert.ok(!r.hung, "still running after 5 s");
    assert.equal(r.threw, "NotInDialect", "4 million pairs: over budget, so it goes to the human");
    assert.match(r.message, /too much work/);
});

test("FAILURE: a survey that reads ml.current and then falls out of dialect leaves the snapshot as it was", async () => {
    const snap = sampleSnapshot();
    await assert.rejects(inWorkerRealm(`const m = ml.current.meta; m[0].tokens = 0; m.length = 0; window.x`, snap), outOfDialect);
    assert.equal(snap.meta.length, 4);
    assert.notEqual(snap.meta[0].tokens, 0);
});
