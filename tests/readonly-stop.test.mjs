"use strict";
// readonly-stop.test.mjs — Stop pressed while a read-only `exec` survey runs: the interpreter is not resumed again, the
// loop does not wait for the call, and nothing the script wrote can keep it going (docs/dev/readonly-exec.md, "Stopped
// by the run"). The page realm, the worker realm and the delegated page leg each take the run's stop; the loop races
// every tool call against it.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import { evalReadonly, Stopped, NotInDialect } from "../src/readonly-exec.ts";
import { evalReadonlyInWorker } from "../src/sw/sw-readonly.ts";
import { registerRun, runDelegatedTool, endRun, stopSurvey, installToolDelegation } from "../src/agent/run-delegation.ts";
import { readonlyRefused } from "../src/agent/approval.ts";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hi</p></body>").window.document;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** An `ml` whose `ps()` takes `ms`, as a real round trip does: the await a stop lands on. */
const slowMl = (ms = 20) => ({ ps: () => new Promise((r) => setTimeout(() => r([]), ms)) });
const SLOW = `for (const c of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { console.log("checked " + c); await ml.ps(); } return "finished"`;

/** Run `src` and abort once `lines` lines have printed. Resolves to what it threw and every line it printed. */
async function stopAfter(src, lines, { ml = slowMl(), realm } = {}) {
    const ctl = new AbortController(), seen = [];
    const p = evalReadonly(src, realm === "worker" ? null : doc(), ml, undefined, { realm, signal: ctl.signal, onLog: (l) => { seen.push(l); if (seen.length === lines) ctl.abort(); } });
    const err = await p.then(() => null, (e) => e);
    await tick(150);   // anything the script would still do after the stop has had time to print
    return { err, seen };
}

// --- the driver: a stopped survey is never resumed ---

test("Stop during an await halts the survey: it throws Stopped, a refusal, and prints nothing more", { timeout: 5000 }, async () => {
    const { err, seen } = await stopAfter(SLOW, 3);
    assert.ok(err instanceof Stopped, `threw ${err}`);
    assert.ok(err instanceof NotInDialect && readonlyRefused(err), "a refusal to every caller that does not know Stopped");
    assert.deepEqual(seen, ["checked 1", "checked 2", "checked 3"]);
});

test("Stop lands DURING a slow host call, not after it: the survey ends before the call answers", { timeout: 5000 }, async () => {
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = evalReadonly(`await ml.ps(); console.log("after")`, doc(), slowMl(2000), undefined, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(p, Stopped);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test("a signal already aborted runs nothing at all", async () => {
    const ctl = new AbortController(); ctl.abort();
    const seen = [];
    await assert.rejects(evalReadonly(`console.log("ran")`, doc(), undefined, undefined, { signal: ctl.signal, onLog: (l) => seen.push(l) }), Stopped);
    assert.deepEqual(seen, []);
});

test("no signal, or one that never aborts: the survey runs to its end as before", async () => {
    assert.equal((await evalReadonly(SLOW, doc(), slowMl(1))).value, "finished");
    assert.equal((await evalReadonly(SLOW, doc(), slowMl(1), undefined, { signal: new AbortController().signal })).value, "finished");
});

// --- adversarial: nothing the script writes keeps a stopped survey going ---

test("ESCAPE: the script's own try/catch cannot catch the stop and carry on", { timeout: 5000 }, async () => {
    const src = `for (const c of [1, 2, 3, 4, 5, 6]) { try { console.log("try " + c); await ml.ps(); } catch (e) { console.log("caught " + e); } } return "kept going"`;
    const { err, seen } = await stopAfter(src, 2);
    assert.ok(err instanceof Stopped, `threw ${err}`);
    assert.deepEqual(seen, ["try 1", "try 2"]);
});

test("ESCAPE: a finally block does not run after the stop, not even one that awaits and prints", { timeout: 5000 }, async () => {
    const src = `try { console.log("start"); await ml.ps(); await ml.ps(); } finally { for (const c of [1, 2, 3]) { console.log("finally " + c); await ml.ps(); } }`;
    const { err, seen } = await stopAfter(src, 1);
    assert.ok(err instanceof Stopped, `threw ${err}`);
    assert.deepEqual(seen, ["start"]);
});

test("ESCAPE: an async IIFE or a .then callback is driven by the same stopped driver", { timeout: 5000 }, async () => {
    const iife = await stopAfter(`await (async () => { for (const c of [1, 2, 3, 4]) { console.log("in " + c); await ml.ps(); } })(); console.log("out")`, 2);
    assert.ok(iife.err instanceof Stopped, `threw ${iife.err}`);
    assert.deepEqual(iife.seen, ["in 1", "in 2"]);
    const then = await stopAfter(`console.log("a"); await ml.ps().then((x) => { console.log("then"); return x; }); console.log("b")`, 1, { ml: slowMl(80) });
    assert.ok(then.err instanceof Stopped, `threw ${then.err}`);
    assert.ok(!then.seen.includes("b"), then.seen.join("|"));
});

test("ESCAPE: Stopped is not a name the script can reach, construct or throw", async () => {
    for (const src of [`Stopped`, `new Stopped("x")`, `ml.Stopped`]) {
        const r = await evalReadonly(src, doc(), slowMl()).then((v) => v.value, (e) => e);
        assert.ok(r === undefined || r instanceof Error, `${src} → ${r}`);
        assert.ok(!(r instanceof Stopped), `${src} produced a Stopped`);
    }
});

// --- failure: a stopped survey leaves nothing behind ---

test("FAILURE: a stopped survey's checkpoint is restored, as for any refusal", { timeout: 5000 }, async () => {
    let restored = 0;
    const ctl = new AbortController();
    const p = evalReadonly(`console.log("x"); await ml.ps(); console.log("y")`, doc(), slowMl(), undefined,
        { signal: ctl.signal, checkpoint: () => () => { restored++; }, onLog: () => ctl.abort() });
    await assert.rejects(p, Stopped);
    assert.equal(restored, 1);
});

// --- the hosts: the worker realm and the delegated page leg take the stop ---

test("the worker realm: a stopped survey is refused", { timeout: 5000 }, async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 60);
    const t0 = Date.now();
    const out = await evalReadonlyInWorker({ js: SLOW }, { ml: slowMl(), signal: ctl.signal });
    assert.equal(out.kind, "refused");
    assert.ok(Date.now() - t0 < 150, `took ${Date.now() - t0} ms`);
});

test("the page leg: stopSurvey stops the named run's survey only, and the page answers it refused", { timeout: 5000 }, async () => {
    const d = new JSDOM("<p class='x'>A</p>");
    const [prevDoc, prevEl, prevWin] = [globalThis.document, globalThis.Element, globalThis.window];
    globalThis.document = d.window.document; globalThis.Element = d.window.Element;
    globalThis.window = { ml: slowMl() };
    const tool = [{ name: "exec", description: "", parameters: { type: "object", properties: {} }, requiresApproval: true, capabilities: [], run: () => "never" }];
    try {
        registerRun("stopA", tool); registerRun("stopB", tool);
        const lines = { stopA: [], stopB: [] };
        const a = runDelegatedTool("stopA", "exec", { js: SLOW }, { readonlyTry: true, onStream: (c) => lines.stopA.push(c) });
        const b = runDelegatedTool("stopB", "exec", { js: SLOW }, { readonlyTry: true, onStream: (c) => lines.stopB.push(c) });
        await tick(70);
        stopSurvey("stopA");
        stopSurvey("no-such-run");   // a stop for a run with nothing in flight is nothing
        const [ea, eb] = await Promise.all([a, b]);
        // A refused envelope: the worker reads it as "ask the person", which is what a page forging the stop gets.
        assert.equal(ea.readonly, false);
        assert.ok(lines.stopA.length < 10, `stopA printed ${lines.stopA.length} lines`);
        assert.equal(eb.readonly, true, "the other run's survey is untouched");
        assert.match(eb.result, /finished/);
        endRun("stopA"); endRun("stopB");
    } finally { globalThis.document = prevDoc; globalThis.Element = prevEl; globalThis.window = prevWin; }
});

// --- the loop: Stop does not wait for a call that is running ---

/** A loop whose model makes `calls` (each an exec), then answers; records emits, model calls and tool runs. */
function loopDeps(calls, { tryReadonly, runTool } = {}) {
    const emits = [], ran = [];
    let model = 0;
    const turns = [{ content: "", tool_calls: calls.map((js, i) => ({ id: `c${i}`, name: "exec", arguments: { js } })) }, { content: "done", tool_calls: [] }];
    return {
        emits, ran, models: () => model,
        deps: {
            callModel: async () => turns[model++],
            runTool: async (n, a, push) => { ran.push(a.js); return runTool ? runTool(n, a, push) : { result: "ran" }; },
            approve: async () => true,
            tryReadonly,
            buildMessages: (task) => [{ role: "user", content: task }],
            emit: (ev) => emits.push(ev),
            pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
            pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        },
    };
}
const never = () => new Promise(() => {});
const done = (emits) => emits.filter((e) => e.tool && !e.pending && e.result != null);

test("Stop while a read-only survey runs: the run ends at once, the step says the survey was stopped, no model call follows", { timeout: 5000 }, async () => {
    const ctl = new AbortController();
    const { deps, emits, models } = loopDeps(["survey"], { tryReadonly: () => never() });
    setTimeout(() => ctl.abort(), 30);
    const r = await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], signal: ctl.signal }, deps);
    assert.equal(r.cancelled, true);
    assert.equal(models(), 1);
    const step = done(emits).at(-1);
    assert.match(step.result, /^Error: the user cancelled the run while this survey was running, and it was stopped/);
    assert.equal(step.approval, "readonly");
});

test("Stop while an approved call runs: the run ends at once, and the step never claims the call stopped", { timeout: 5000 }, async () => {
    const ctl = new AbortController();
    const { deps, emits } = loopDeps(["approved"], { tryReadonly: async () => null, runTool: () => never() });
    setTimeout(() => ctl.abort(), 30);
    const r = await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], signal: ctl.signal }, deps);
    assert.equal(r.cancelled, true);
    const step = done(emits).at(-1);
    assert.match(step.result, /while this call was running, so its result was not waited for; it may not have stopped/);
    assert.ok(!step.tokenId, "no pointer is minted for a stopped call");
});

test("Stop during the first of several calls in one message: none of the rest runs, and each still gets a result", { timeout: 5000 }, async () => {
    const ctl = new AbortController();
    const { deps, emits, ran } = loopDeps(["first", "second", "third"], { tryReadonly: async () => null, runTool: () => never() });
    setTimeout(() => ctl.abort(), 30);
    const r = await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], signal: ctl.signal }, deps);
    assert.equal(r.cancelled, true);
    assert.deepEqual(ran, ["first"]);
    const steps = done(emits);
    assert.equal(steps.length, 3);
    assert.deepEqual(steps.slice(1).map((s) => s.approval), ["cancelled", "cancelled"]);
});

test("a call that answers before any Stop is unaffected, and a late answer after a Stop is never read", { timeout: 5000 }, async () => {
    const quick = loopDeps(["q"], { tryReadonly: async () => ({ result: "value: 1" }) });
    const r1 = await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], signal: new AbortController().signal }, quick.deps);
    assert.equal(r1.cancelled, undefined);
    assert.equal(done(quick.emits)[0].result, "value: 1");
    const ctl = new AbortController();
    const late = loopDeps(["l"], { tryReadonly: () => tick(200).then(() => ({ result: "LATE" })) });
    setTimeout(() => ctl.abort(), 20);
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], signal: ctl.signal }, late.deps);
    await tick(300);
    assert.ok(!late.emits.some((e) => String(e.result ?? "").includes("LATE")));
});

test("nothing is emitted after a stopped step's DONE: a late line, and a late refusal's discard, are dropped", { timeout: 5000 }, async () => {
    const ctl = new AbortController();
    let sink;
    const { deps, emits } = loopDeps(["survey"], { tryReadonly: (_n, _a, live) => { sink = live; live.push("early\n"); return never(); } });
    setTimeout(() => ctl.abort(), 30);
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }], signal: ctl.signal, stream: true }, deps);
    const after = emits.length;
    sink.push("late\n");   // a chunk still in flight from the page
    sink.discard();         // the host's refusal of the stopped survey (sw-readonly.ts `drop`)
    await tick(200);
    assert.equal(emits.length, after, JSON.stringify(emits.slice(after)));
});

// --- red team: what a page that posts PAGE_TOOL_CANCEL itself gets (run-delegation.ts installToolDelegation) ---
//
// The page shares the main world with the bridge, sees every PAGE_TOOL_RUN (so every run id) and can post the stop
// message itself. These drive the bridge the way the page reaches it: window messages whose source is the window.

/** The page leg's window bridge over a fresh JSDOM page, with `ml` as `window.ml`. `post` dispatches a window message
 *  as the page (or as `source`) would; `survey` posts a PAGE_TOOL_RUN read-only try and resolves to its envelope. */
function pageBridge(ml = slowMl()) {
    const d = new JSDOM("<!doctype html><title>T</title><p class='x'>A</p>", { url: "https://evil.example/" });
    const prev = [globalThis.document, globalThis.Element, globalThis.window];
    globalThis.document = d.window.document; globalThis.Element = d.window.Element; globalThis.window = d.window;
    d.window.ml = ml;
    installToolDelegation();
    const results = new Map();
    d.window.addEventListener("message", (e) => { if (e.data?.type === "PAGE_TOOL_RESULT") results.set(e.data.callId, e.data.envelope); });
    const post = (data, source = d.window) => d.window.dispatchEvent(new d.window.MessageEvent("message", { data, source }));
    let ran = 0;
    const tool = [{ name: "exec", description: "", parameters: { type: "object", properties: {} }, requiresApproval: true, capabilities: [], run: () => { ran++; return "THE TOOL RAN"; } }];
    const survey = (callId, runId, js = SLOW) => {
        post({ type: "PAGE_TOOL_RUN", callId, runId, name: "exec", args: { js }, readonlyTry: true });
        return (async () => { for (let i = 0; i < 400 && !results.has(callId); i++) await tick(10); return results.get(callId); })();
    };
    const restore = () => { globalThis.document = prev[0]; globalThis.Element = prev[1]; globalThis.window = prev[2]; };
    return { d, post, survey, register: (id) => registerRun(id, tool), ran: () => ran, restore };
}

test("a page's forged PAGE_TOOL_CANCEL refuses only its own survey: readonly:false with no result, and the tool never runs", { timeout: 10000 }, async () => {
    const b = pageBridge();
    try {
        b.register("rtA");
        const control = await b.survey("ctl", "rtA");   // positive control: unstopped, the same survey is answered
        assert.equal(control?.readonly, true, JSON.stringify(control));
        assert.match(control.result, /finished/);
        const p = b.survey("forged", "rtA");
        await tick(50);
        b.post({ type: "PAGE_TOOL_CANCEL", runId: "rtA" });
        const env = await p;
        assert.equal(env?.readonly, false, JSON.stringify(env));
        assert.equal(env.result, "", "a refused try carries no text the worker could use as an answer");
        assert.equal(env.answerOps, undefined, "and no answer-set changes");
        assert.equal(b.ran(), 0, "a stop never turns into running the tool itself in the page");
        endRun("rtA");
    } finally { b.restore(); }
});

test("a PAGE_TOOL_CANCEL stops only the run it names: another run's survey, a non-string runId and another window's message stop nothing", { timeout: 10000 }, async () => {
    const b = pageBridge();
    const other = new JSDOM("").window;   // an iframe's window, posting into this one
    try {
        b.register("rtB1"); b.register("rtB2");
        const p1 = b.survey("b1", "rtB1"), p2 = b.survey("b2", "rtB2");
        await tick(50);
        for (const runId of [{ toString: () => "rtB2" }, ["rtB2"], 7, null, undefined]) b.post({ type: "PAGE_TOOL_CANCEL", runId });
        b.post({ type: "PAGE_TOOL_CANCEL", runId: "rtB2" }, other);
        b.post({ type: "PAGE_TOOL_CANCEL", runId: "rtB1" });   // positive control: the named run's survey stops
        const [e1, e2] = await Promise.all([p1, p2]);
        assert.equal(e1?.readonly, false, "the named run's survey was stopped");
        assert.equal(e2?.readonly, true, `run rtB2's survey went on: ${JSON.stringify(e2)}`);
        assert.match(e2.result, /finished/);
        endRun("rtB1"); endRun("rtB2");
    } finally { b.restore(); }
});

test("no stale controller: a stop posted before a survey, or for one that ended, does not pre-stop the run's next survey", { timeout: 15000 }, async () => {
    const b = pageBridge(slowMl(2));
    try {
        b.register("rtC");
        b.post({ type: "PAGE_TOOL_CANCEL", runId: "rtC" });   // nothing in flight yet
        const first = await b.survey("c1", "rtC");
        assert.equal(first?.readonly, true, `a stop with nothing in flight is nothing: ${JSON.stringify(first)}`);
        const p = b.survey("c2", "rtC", `for (const c of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { await ml.ps(); await ml.ps(); await ml.ps(); } return "finished"`);
        await tick(15);
        b.post({ type: "PAGE_TOOL_CANCEL", runId: "rtC" });
        assert.equal((await p)?.readonly, false, "positive control: the stop in flight landed");
        b.post({ type: "PAGE_TOOL_CANCEL", runId: "rtC" });   // late, after it ended
        const next = await b.survey("c3", "rtC");
        assert.equal(next?.readonly, true, `the next survey starts unstopped: ${JSON.stringify(next)}`);
        assert.match(next.result, /finished/);
        endRun("rtC");
    } finally { b.restore(); }
});
