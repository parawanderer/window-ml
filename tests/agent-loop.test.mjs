// The world-agnostic agent orchestrator (agent-loop.ts), design A's reusable
// heart. These lock the SECURITY INVARIANT that makes moving the loop to the background safe:
// a requiresApproval tool's executor is invoked ONLY after the gate (or a trusted auto-approve)
// grants it — the decision never depends on the executor, so a hostile executor can't self-approve.
import { test } from "node:test";
import assert from "node:assert";
import { runAgentLoop } from "../agent-loop.ts";

// Deps factory: scripted model turns + spies recording the ORDER of approve/runTool calls.
function makeDeps({ turns = [], approve, autoApprove } = {}) {
    let i = 0;
    const calls = { runTool: [], approve: [], order: [], emits: [] };
    const deps = {
        callModel: async () => turns[i++] || { content: "" },
        runTool: async (name, args) => { calls.runTool.push({ name, args }); calls.order.push(`run:${name}`); return { result: `ran:${name}` }; },
        approve: async (req) => { calls.approve.push(req); calls.order.push(`approve:${req.tool}`); return approve ? approve(req) : true; },
        autoApprove: autoApprove || (() => null),
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        emit: (ev) => calls.emits.push(ev),
    };
    return { deps, calls };
}
const toolCall = (name, args = {}, id = "c1") => ({ content: "", tool_calls: [{ id, name, arguments: args }] });
const reply = (content) => ({ content, tool_calls: [] });
const danger = { name: "danger", requiresApproval: true };

test("INVARIANT: a DENIED requiresApproval tool is NEVER executed", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("danger", { js: "exfiltrate()" }), reply("done")], approve: () => false });
    const res = await runAgentLoop("x", { tools: [danger] }, deps);
    assert.equal(calls.runTool.length, 0, "SECURITY: runTool was never reached for a denied tool");
    assert.equal(calls.approve.length, 1, "the gate WAS consulted");
    assert.match(res.transcript[0].result, /Denied by the user/);
});

test("INVARIANT: the gate resolves BEFORE the executor runs (ordering)", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("danger"), reply("done")], approve: () => true });
    await runAgentLoop("x", { tools: [danger] }, deps);
    assert.deepEqual(calls.order, ["approve:danger", "run:danger"], "approve completes, THEN runTool — never the reverse");
});

test("auto-approve (a TRUSTED-world decision) skips the gate but still executes", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("exec", { js: "readonlySurvey()" }), reply("done")], autoApprove: () => "readonly" });
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }] }, deps);
    assert.equal(calls.approve.length, 0, "the UI gate is skipped for an auto-approved call");
    assert.equal(calls.runTool.length, 1, "but the tool still runs");
    assert.equal(calls.emits.find(e => e.tool === "exec" && !e.pending).approval, "readonly", "provenance recorded");
});

test("a non-approval tool runs directly — the gate is never consulted", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("safe"), reply("done")] });
    await runAgentLoop("x", { tools: [{ name: "safe" }] }, deps);
    assert.equal(calls.approve.length, 0);
    assert.equal(calls.runTool.length, 1);
});

test("a denial's feedback is fed back to the model", async () => {
    const { deps } = makeDeps({ turns: [toolCall("danger"), reply("ok")], approve: () => ({ approved: false, feedback: "not on this page" }) });
    const res = await runAgentLoop("x", { tools: [danger] }, deps);
    assert.match(res.transcript[0].result, /Denied by the user: not on this page/);
});

test("approve-with-edited-args executes the EDITED args", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("danger", { js: "orig()" }), reply("ok")], approve: () => ({ approved: true, arguments: { js: "edited()" } }) });
    await runAgentLoop("x", { tools: [danger] }, deps);
    assert.deepEqual(calls.runTool[0].args, { js: "edited()" }, "the executor runs what was approved, not the model's original");
});

test("an unknown tool errors without touching the executor", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("ghost"), reply("gave up")] });
    const res = await runAgentLoop("x", { tools: [danger] }, deps);
    assert.equal(calls.runTool.length, 0);
    assert.match(res.transcript[0].result, /no tool named "ghost"/);
});

test("a plain reply ends with the summary; maxSteps flags hitCap", async () => {
    const { deps } = makeDeps({ turns: [reply("all done")] });
    const r1 = await runAgentLoop("x", { tools: [] }, deps);
    assert.equal(r1.summary, "all done");
    assert.equal(r1.steps, 0);

    const { deps: d2 } = makeDeps({ turns: [toolCall("safe"), toolCall("safe"), toolCall("safe")] });
    const r2 = await runAgentLoop("x", { tools: [{ name: "safe" }], maxSteps: 2 }, d2);
    assert.equal(r2.hitCap, true);
    assert.equal(r2.steps, 2);
});

test("a pre-aborted signal cancels before any model call", async () => {
    const ac = new AbortController(); ac.abort();
    let modelCalls = 0;
    const { deps } = makeDeps({ turns: [reply("should not run")] });
    const wrapped = { ...deps, callModel: async (...a) => { modelCalls++; return deps.callModel(...a); } };
    const res = await runAgentLoop("x", { tools: [], signal: ac.signal }, wrapped);
    assert.equal(res.cancelled, true);
    assert.equal(res.steps, 0);
    assert.equal(modelCalls, 0, "no model call once aborted");
});

test("a tool step emits a pending START then a DONE with the same seq", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("safe"), reply("done")] });
    await runAgentLoop("x", { tools: [{ name: "safe" }] }, deps);
    const steps = calls.emits.filter(e => e.tool === "safe");
    assert.equal(steps.length, 2, "START + DONE");
    assert.equal(steps[0].pending, true);
    assert.equal(steps[1].pending, undefined);
    assert.equal(steps[0].seq, steps[1].seq, "same seq → the sidebar patches the row");
});

test("token usage is emitted per step (so the background run's usage gauge isn't blank)", async () => {
    // A thought+tool step carries usage on its thought emit; the final-answer step emits usage-only.
    const { deps, calls } = makeDeps({ turns: [
        { content: "thinking", tool_calls: [{ id: "c1", name: "safe", arguments: {} }], usage: { totalTokens: 100 } },
        { content: "done", tool_calls: [], usage: { totalTokens: 250 } },
    ] });
    await runAgentLoop("x", { tools: [{ name: "safe" }] }, deps);
    const withUsage = calls.emits.filter(e => e.usage);
    assert.equal(withUsage.length, 2, "step 1 (thought) + the final-answer step both carry usage");
    assert.deepEqual(withUsage.map(e => e.usage.totalTokens), [100, 250]);
    // The final one (the sidebar reads the LAST) reflects the run's peak context.
    assert.equal(withUsage[withUsage.length - 1].usage.totalTokens, 250);
});

test("a step with usage but NO prose still emits usage (usage-only emit)", async () => {
    const { deps, calls } = makeDeps({ turns: [
        { content: "", tool_calls: [{ id: "c1", name: "safe", arguments: {} }], usage: { totalTokens: 42 } },
        reply("done"),
    ] });
    await runAgentLoop("x", { tools: [{ name: "safe" }] }, deps);
    assert.ok(calls.emits.some(e => e.usage && e.usage.totalTokens === 42), "usage rides even without a thought");
});

test("inline vision: a tool that returns an image → pushToolImages injects it after the step", async () => {
    const { deps } = makeDeps({ turns: [toolCall("look"), reply("done")] });
    deps.runTool = async () => ({ result: "captured", image: "data:img,SHOT", imageLabel: "viewport" });
    const pushed = [];
    deps.pushToolImages = (m, imgs) => { pushed.push(imgs); };
    await runAgentLoop("x", { tools: [{ name: "look", capabilities: ["vision"] }] }, deps);
    assert.deepEqual(pushed, [[{ image: "data:img,SHOT", label: "viewport" }]], "the screenshot is handed to the next turn");
});

test("no image → pushToolImages is never called (text-only driver / non-vision tool)", async () => {
    const { deps } = makeDeps({ turns: [toolCall("noop"), reply("done")] });   // default runTool returns no image
    let called = false;
    deps.pushToolImages = () => { called = true; };
    await runAgentLoop("x", { tools: [{ name: "noop" }] }, deps);
    assert.equal(called, false);
});

test("tryReadonly: an in-dialect readonly result skips BOTH the gate and runTool", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("exec", { js: "survey()" }), reply("done")] });
    deps.tryReadonly = async () => ({ result: "readonly-result" });   // the interpreter handled it
    const res = await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }] }, deps);
    assert.equal(calls.approve.length, 0, "no human gate — a side-effect-free read is auto-approved");
    assert.equal(calls.runTool.length, 0, "runTool skipped — the interpreter already produced the result");
    assert.equal(res.transcript[0].result, "readonly-result");
    const done = calls.emits.find(e => e.tool === "exec" && !e.pending);
    assert.equal(done.approval, "readonly");
});

test("tryReadonly returning null → falls through to the normal gate", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("exec"), reply("done")], approve: () => true });
    deps.tryReadonly = async () => null;   // out-of-dialect / mutating
    await runAgentLoop("x", { tools: [{ name: "exec", requiresApproval: true }] }, deps);
    assert.equal(calls.approve.length, 1, "out-of-dialect → the gate is consulted");
    assert.equal(calls.runTool.length, 1);
});
