"use strict";
// readonly-stream.test.mjs — a read-only `exec` survey streams its console lines live, and a survey that is refused
// part way through takes back every line it streamed (docs/dev/readonly-exec.md, "How the dialect reports output").
//
// Three layers: the evaluator hands each line to `onLog` as it prints, the hosts carry it to the loop's stream fan, and
// the loop discards the fan when the try comes back refused, so the approved run (if any) streams from empty.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import { snapshotCurrent, UNRECORDED } from "../src/agent/current-context.ts";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { evalReadonlyInWorker, WORKER_STREAM_HOLD_MS } from "../src/sw/sw-readonly.ts";
import { registerRun, runDelegatedTool, endRun } from "../src/agent/run-delegation.ts";
import { formatReadonlyExec } from "../src/agent/approval.ts";
import { OUTPUT_CAP } from "../src/contract/contract-pointers.ts";
import { UI_OUT_CAP } from "../src/contract/contract-chat.ts";

const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;
const doc = () => new JSDOM("<!doctype html><body><p id='p'>hi</p></body>").window.document;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** A context whose system prompt is long enough for the print boundary to abridge it. */
const snapshot = () => snapshotCurrent({
    run: { id: "run1", model: "m", step: 1, maxSteps: 10, startedTs: 0 },
    messages: [{ role: "system", content: "You are an agent. ".repeat(200) }, { role: "user", content: "go" }],
    recorded: [{ ...UNRECORDED, ts: 0, step: 0 }, { ...UNRECORDED, ts: 0, step: 0 }],
    log: [], now: 1000,
});

// --- the evaluator: `onLog` gets each line as it prints, the same string the model is given ---------------------------

test("onLog receives exactly the strings in `logs`, in order, as they print", async () => {
    const seen = [];
    const ro = await evalReadonly(`console.log("a", 1); console.info({ k: [1, 2] }); console.warn(document.querySelector("#p").textContent)`,
        doc(), undefined, undefined, { onLog: (l) => seen.push(l) });
    assert.deepEqual(seen, ro.logs);
    assert.equal(seen.length, 3);
});

test("onLog gets the ABRIDGED row, never the raw value: what streams is what the model will be given", async () => {
    const seen = [];
    const ro = await evalReadonly(`console.log(ml.current.messages)`, null, {}, undefined,
        { realm: "worker", current: snapshot(), onLog: (l) => seen.push(l) });
    assert.deepEqual(seen, ro.logs);
    assert.match(seen[0], /"abridged":"print ml\.current\.messages\[0\]\.content for all 3600 chars"/);
    assert.ok(seen[0].length < 1000, "the 3,600-char prompt did not stream whole");
});

test("onLog streams BEFORE the survey finishes: a line printed before an await arrives while it waits", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const seen = [];
    const ml = { config: () => gate };
    const p = evalReadonly(`console.log("before"); const c = await ml.config(); console.log("after " + c.model)`,
        null, ml, undefined, { onLog: (l) => seen.push(l) });
    await tick(10);
    assert.deepEqual(seen, ["before"], "the first line is out while the survey is still awaiting");
    release({ model: "m" });
    await p;
    assert.deepEqual(seen, ["before", "after m"]);
});

// --- HALTING: a survey that logs until the step budget trips stops streaming when it trips -----------------------------

test("HALTING: a logging loop that trips the step budget is refused, and nothing streams after the refusal", async () => {
    const seen = [];
    await assert.rejects(evalReadonly(`for (const i of ml.range(100000)) console.log("tick " + i)`, null,
        { range: (n) => Array.from({ length: n }, (_, i) => i) }, undefined, { stepBudget: 500, onLog: (l) => seen.push(l) }), outOfDialect);
    const n = seen.length;
    assert.ok(n > 0 && n < 500, `some lines streamed before the trip (${n})`);
    await tick(20);
    assert.equal(seen.length, n, "nothing after it");
});

// --- FAILURE: a refused try leaves no streamed lines, on both loop paths --------------------------------------------

/** A loop that makes one `exec` call then answers, recording every emit. */
function loopDeps(tryReadonly, runTool) {
    const emits = [];
    let i = 0;
    const turns = [{ content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "x" } }] }, { content: "done", tool_calls: [] }];
    return {
        emits,
        deps: {
            callModel: async () => turns[i++],
            runTool: runTool ?? (async () => ({ result: "ran" })),
            approve: async () => true,
            tryReadonly,
            buildMessages: (task) => [{ role: "user", content: task }],
            emit: (ev) => emits.push(ev),
            pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
            pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        },
    };
}
const deltas = (emits) => emits.filter((e) => e.streamOutput != null && e.tool == null);

test("the loop hands the read-only try the call's live sink, and its lines fan as stream deltas", async () => {
    const { deps, emits } = loopDeps(async (_n, _a, live) => { live.push("one\n"); return { result: "console:\none" }; });
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], stream: true }, deps);
    assert.equal(deltas(emits).at(-1).streamOutput, "one\n");
});

test("streaming OFF: the read-only try gets no live sink", async () => {
    let got = "unset";
    const { deps } = loopDeps(async (_n, _a, live) => { got = live; return { result: "r" }; });
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }] }, deps);
    assert.equal(got, undefined);
});

test("FAILURE: a try that streams and is then refused is DISCARDED before the gate, and the approved run streams from empty", async () => {
    const { deps, emits } = loopDeps(
        async (_n, _a, live) => { live.push("from the refused try\n"); return null; },
        async (_n, _a, onStream) => { await tick(100); onStream("from the approved run\n"); return { result: "ok" }; });
    deps.approve = async () => { approvedAt = emits.length; return true; };
    let approvedAt = -1;
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], stream: true }, deps);
    const d = deltas(emits);
    assert.equal(d[0].streamOutput, "from the refused try\n", "the try's line did stream live");
    const reset = emits.indexOf(d[1]);
    assert.equal(d[1].streamOutput, "", "then the discard: an EMPTY output");
    assert.deepEqual(d[1].streamMarks, []);
    assert.ok(reset < approvedAt, "discarded before the human was asked");
    assert.equal(d.at(-1).streamOutput, "from the approved run\n", "the approved run's output carries nothing of the refused try's");
});

test("FAILURE: a refused try that streamed nothing emits no discard", async () => {
    const { deps, emits } = loopDeps(async () => null);
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], stream: true }, deps);
    assert.equal(deltas(emits).length, 0);
});

test("FAILURE: a THROTTLED line still pending when the try is refused never lands", async () => {
    const { deps, emits } = loopDeps(async (_n, _a, live) => { live.push("a\n"); live.push("b\n"); return null; });
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], stream: true }, deps);
    await tick(150);   // past the fan's 90ms trailing emit
    assert.ok(!deltas(emits).some((e) => /b/.test(e.streamOutput)), "the coalesced trailing emit was cancelled");
});

// The background-hosted path: the page side of the delegation evaluates the survey and posts its lines.
test("delegated try: each line streams to onStream as an approved exec's does, stamped by the executor", async () => {
    const d = new JSDOM("<p class='x'>A</p>");
    const [prevDoc, prevEl] = [globalThis.document, globalThis.Element];
    globalThis.document = d.window.document; globalThis.Element = d.window.Element;
    try {
        registerRun("roStream", [{ name: "exec", description: "", parameters: { type: "object", properties: {} }, requiresApproval: true, capabilities: [], run: () => "never" }]);
        const chunks = [];
        const env = await runDelegatedTool("roStream", "exec", { js: `console.log("A is " + document.querySelector(".x").textContent); return 1` },
            { readonlyTry: true, onStream: (c, ts) => chunks.push([c, typeof ts]) });
        assert.equal(env.readonly, true);
        assert.deepEqual(chunks, [["A is A\n", "number"]]);
        // A refused one streams what it printed before the refusal; the loop's discard takes it back (above).
        const refused = await runDelegatedTool("roStream", "exec", { js: `console.log("half"); document.body.click()` },
            { readonlyTry: true, onStream: (c) => chunks.push([c]) });
        assert.equal(refused.readonly, false);
        endRun("roStream");
    } finally { globalThis.document = prevDoc; globalThis.Element = prevEl; }
});

// The worker realm: its `needs-page` retry on the page would print the same lines again, so it discards first.
test("FAILURE (worker realm): a survey that streams and then needs the page, or is refused, takes back what it showed", async () => {
    const live = () => { const l = { pushed: [], discarded: 0, push: (t) => l.pushed.push(t), discard: () => { l.discarded++; } }; return l; };
    const ok = live();
    assert.equal((await evalReadonlyInWorker({ js: `console.log("w"); return 1` }, { live: ok })).kind, "answered");
    assert.deepEqual(ok.pushed, ["w\n"]);
    assert.equal(ok.discarded, 0);
    // Deferred within the hold: nothing was shown, so nothing flickers (the page prints the same line again).
    const page = live();
    assert.equal((await evalReadonlyInWorker({ js: `console.log("w"); document.title` }, { live: page })).kind, "needs-page");
    assert.deepEqual([page.pushed, page.discarded], [[], 0]);
    const refused = live();
    assert.equal((await evalReadonlyInWorker({ js: `console.log("w"); [].constructor` }, { live: refused })).kind, "refused");
    assert.deepEqual([refused.pushed, refused.discarded], [[], 0]);
    // Waiting past the hold: the line streamed live, and is taken back when the survey then defers.
    const slow = { ps: () => new Promise((r) => setTimeout(() => r([]), WORKER_STREAM_HOLD_MS + 80)) };
    const waited = live();
    assert.equal((await evalReadonlyInWorker({ js: `console.log("w"); await ml.ps(); document.title` }, { live: waited, ml: slow })).kind, "needs-page");
    assert.deepEqual([waited.pushed, waited.discarded], [["w\n"], 1]);
});

// --- the character limit: the stream is the panel's, the cut is the model's -----------------------------------------

test("a survey printing past the model's limit streams EVERY line; only the result is cut, at the same offset the stream marks", async () => {
    const seen = [];
    const ro = await evalReadonly(`for (const i of ml.range(30)) console.log("line " + i + " " + "x".repeat(40))`, null,
        { range: (n) => Array.from({ length: n }, (_, i) => i) }, undefined, { onLog: (l) => seen.push(l) });
    const streamed = seen.map((l) => l + "\n").join("");
    const joined = ro.logs.join("\n");
    assert.ok(streamed.length > OUTPUT_CAP.exec.default * 2, `the stream is not cut at the model's limit (${streamed.length})`);
    const { result, render } = formatReadonlyExec(ro.value, ro.logs);
    assert.equal(render.seen, OUTPUT_CAP.exec.default, "the settled view marks the model's cut at the default limit");
    // The live view greys from the same offset (liveCutoff reads the same default), so the boundary must fall on the
    // same character in the streamed text as in the settled one.
    assert.equal(streamed.slice(0, render.seen), joined.slice(0, render.seen));
    assert.ok(result.includes(joined.slice(0, OUTPUT_CAP.exec.default)), "the model got the head");
    assert.ok(!result.includes("line 29"), "and not the tail");
});

test("a survey printing past the STREAM's cap keeps the head and the LATEST lines, counting the gap; the model's result is unaffected", async () => {
    const lines = 400, width = 50;   // 400 x 51 chars, past UI_OUT_CAP
    // Then a slow read, so the throttled emit lands before the step's DONE supersedes the live view.
    const js = `for (const i of ml.range(${lines})) console.log("${"y".repeat(width - 4)}" + String(i).padStart(4, "0")); await ml.ps()`;
    const ml = { range: (n) => Array.from({ length: n }, (_, i) => i), ps: () => tick(150) };
    const { deps, emits } = loopDeps(async (_n, args, live) => {
        const ro = await evalReadonly(args.js, null, ml, undefined, { onLog: (l) => live?.push(l + "\n") });
        return { result: formatReadonlyExec(ro.value, ro.logs).result };
    });
    deps.callModel = (() => { let i = 0; const t = [{ content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js } }] }, { content: "done", tool_calls: [] }]; return async () => t[i++]; })();
    const res = await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], stream: true }, deps);
    const last = deltas(emits).at(-1).streamOutput;
    const total = lines * (width + 1);
    assert.ok(total > UI_OUT_CAP);
    assert.ok(last.startsWith("y".repeat(width - 4) + "0000\n"), "the HEAD is kept, as the settled clip keeps it");
    assert.ok(last.endsWith("y".repeat(width - 4) + String(lines - 1).padStart(4, "0") + "\n"), "and the newest line, like a terminal");
    const [head, tail] = last.split(/\n… \[\d+ chars dropped here\] …\n/);
    assert.equal(Number(last.match(/\[(\d+) chars dropped here\]/)[1]), total - head.length - tail.length, "the note counts exactly what was dropped");
    assert.ok(res.transcript[0].result.length < 1000, "the model's result is cut at its own limit, not the stream's");
});

test("a survey that RAISES its limit is not tried, so nothing streams from a try: the approved run streams it", async () => {
    const d = new JSDOM("<p>x</p>");
    const [prevDoc, prevEl] = [globalThis.document, globalThis.Element];
    globalThis.document = d.window.document; globalThis.Element = d.window.Element;
    try {
        registerRun("roRaise", [{ name: "exec", description: "", parameters: { type: "object", properties: {} }, requiresApproval: true, capabilities: [], run: () => "never" }]);
        const chunks = [];
        const env = await runDelegatedTool("roRaise", "exec", { js: `console.log("z".repeat(900))`, maxChars: 2000, maxCharsReason: "need it whole" },
            { readonlyTry: true, onStream: (c) => chunks.push(c) });
        assert.equal(env.readonly, false, "a raised limit is the human's to grant");
        assert.deepEqual(chunks, [], "and the try printed nothing");
        endRun("roRaise");
    } finally { globalThis.document = prevDoc; globalThis.Element = prevEl; }
});
