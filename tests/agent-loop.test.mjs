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

test("CANCEL while awaiting approval → tool NOT run, a generic 'cancelled' result is stored, run exits cancelled", async () => {
    // Simulate Stop pressed while the gate is open: approve() aborts the run's signal (as CANCEL_RUN does)
    // then resolves (the background resolves the pending gate so the blocked loop can wake). The loop must
    // treat the aborted signal as a CANCEL — not a deny — store a non-accusatory result, and exit cancelled.
    const ctrl = new AbortController();
    const { deps, calls } = makeDeps({
        turns: [toolCall("danger"), reply("done")],
        approve: () => { ctrl.abort(); return false; },
    });
    const res = await runAgentLoop("x", { tools: [danger], signal: ctrl.signal }, deps);
    assert.equal(calls.runTool.length, 0, "SECURITY still holds: the tool NEVER ran (cancelled, not approved)");
    const done = calls.emits.find(e => e.tool === "danger" && !e.pending);
    assert.equal(done.approval, "cancelled", "provenance is 'cancelled', NOT 'denied' (it wasn't a rejection)");
    assert.match(done.result, /cancelled the run/i, "a generic 'cancelled the run' result is emitted (clears the buttons)");
    assert.match(res.transcript[0].result, /cancelled the run/i, "and it's stored in the transcript — coherent for a follow-up turn");
    assert.doesNotMatch(done.result, /denied/i, "it does NOT read as 'denied/refused'");
    assert.ok(res.cancelled, "the run resolves as cancelled");
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

test("a DOOMED action (precheck error) skips the gate AND the executor — no approval prompt", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("click", { selector: "#nope" }), reply("done")] });
    deps.precheck = async () => `No element matches "#nope".`;   // the target can't resolve
    const res = await runAgentLoop("x", { tools: [{ name: "click", requiresApproval: true }] }, deps);
    assert.equal(calls.approve.length, 0, "no approval prompt for an action that can only fail");
    assert.equal(calls.runTool.length, 0, "and the executor is NOT reached (no side effect)");
    assert.match(res.transcript.find(t => t.result)?.result || calls.emits.find(e => e.tool === "click" && !e.pending).result, /No element matches/);
    // "skipped" provenance — it never ran, never gated, but the UI shows WHY there was no prompt.
    assert.equal(calls.emits.find(e => e.tool === "click" && !e.pending).approval, "skipped");
});

test("a precheck that PASSES (null) proceeds to the gate as normal", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("click", { selector: "#ok" }), reply("done")], approve: () => true });
    deps.precheck = async () => null;   // target resolves → gate
    await runAgentLoop("x", { tools: [{ name: "click", requiresApproval: true }] }, deps);
    assert.equal(calls.approve.length, 1, "a resolvable target still gates");
    assert.equal(calls.runTool.length, 1, "and runs after approval");
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

test("a meta-capability tool (chat_metadata) is answered BY THE LOOP with live token stats, not runTool", async () => {
    const { deps, calls } = makeDeps({ turns: [
        // The turn that CALLS chat_metadata carries usage → the summary reflects it (prompt=context used,
        // completion=generated). REAL usage is camelCase (TokenUsage), which was the "0 tokens" regression.
        { content: "", tool_calls: [{ id: "m1", name: "chat_metadata", arguments: {} }], usage: { promptTokens: 1200, completionTokens: 40, totalTokens: 1240 } },
        reply("here's your info"),
    ] });
    deps.chatMeta = async () => ({
        model: "gemma4:31b", contextWindow: 262144, capabilities: ["tools", "vision"],
        vramGB: 21.4, local: true, backend: "Ollama (native)", systemTokens: 900, toolTokens: 1500,
    });
    // Model IS vision-capable (caps include "vision"), so `look` inlines the image into context (NOT a
    // sub-call → not flagged). `locate` is ALWAYS a delegated sub-call → flagged.
    await runAgentLoop("what model am I?", { tools: [{ name: "chat_metadata", capabilities: ["meta"] }, { name: "look", capabilities: ["vision"] }, { name: "locate", capabilities: ["vision"] }] }, deps);

    assert.ok(!calls.runTool.some(c => c.name === "chat_metadata"), "the loop answers it itself — runTool is never called");
    const done = calls.emits.find(e => e.tool === "chat_metadata" && !e.pending);
    assert.match(done.result, /gemma4:31b \(local · Ollama\)/, "reports the model + local/cloud");
    assert.match(done.result, /262144 tokens/, "reports the context window");
    assert.match(done.result, /tools, vision/, "reports capabilities");
    assert.match(done.result, /~1200 tokens/, "context in use = the last prompt-token count");
    assert.match(done.result, /40 tokens/, "generated = summed completion tokens");
    assert.match(done.result, /fixed overhead: ~2400 tokens.*system prompt ~900.*tool list ~1500/, "system + tool overhead");
    assert.match(done.result, /21\.4 GB/, "VRAM resident");
    assert.match(done.result, /routed via: Ollama \(native\)/, "backend");
    assert.match(done.result, /`locate`.*NOT counted/, "flags locate's untracked sub-call tokens");
    assert.doesNotMatch(done.result, /`look`/, "a VISION model's look inlines the image into context — NOT flagged as untracked");
});

test("chat_metadata reports the METERED delegated sub-call tokens when a tally exists (not just the note)", async () => {
    const { deps } = makeDeps({ turns: [
        { content: "", tool_calls: [{ id: "m1", name: "chat_metadata", arguments: {} }], usage: { promptTokens: 1200, completionTokens: 40, totalTokens: 1240 } },
        reply("info"),
    ] });
    deps.chatMeta = async () => ({ model: "qwen3", contextWindow: 40960, capabilities: ["tools"], vramGB: null, local: true, backend: null, systemTokens: 100, toolTokens: 200 });
    // bus.ts metered 3 delegated vision sub-calls this turn (look/locate/verify) → 3300 prompt + 210 completion.
    deps.subcallTokens = () => ({ prompt: 3300, completion: 210, calls: 3 });
    const calls = { emits: [] }; deps.emit = (ev) => calls.emits.push(ev);
    await runAgentLoop("x", { tools: [{ name: "chat_metadata", capabilities: ["meta"] }, { name: "locate", capabilities: ["vision"] }] }, deps);
    const done = calls.emits.find(e => e.tool === "chat_metadata" && !e.pending);
    assert.match(done.result, /delegated vision sub-calls this turn: 3510 tokens over 3 calls/, "reports the metered number (prompt+completion)");
    assert.match(done.result, /SEPARATE context.*not part of the occupancy/, "clarifies it's spend, not occupancy");
    assert.doesNotMatch(done.result, /none yet this turn/, "the fallback note is replaced by the real number");
});

test("reasoning_content is emitted per step, distinct from the content prose", async () => {
    // The model thinks in reasoning_content and leaves content empty while tool-calling.
    const { deps, calls } = makeDeps({ turns: [
        { content: "", reasoning: "Let me find the button.", tool_calls: [{ id: "c1", name: "safe", arguments: {} }] },
        { content: "done", reasoning: "That worked.", tool_calls: [] },
    ] });
    await runAgentLoop("x", { tools: [{ name: "safe" }] }, deps);
    const withReasoning = calls.emits.filter(e => e.reasoning);
    assert.equal(withReasoning.length, 2, "both the tool-call turn and the final answer emit reasoning");
    assert.equal(withReasoning[0].reasoning, "Let me find the button.");
    assert.equal(withReasoning[0].thought, undefined, "content was empty → no prose thought, but reasoning still emits");
    assert.equal(withReasoning[1].reasoning, "That worked.");
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
