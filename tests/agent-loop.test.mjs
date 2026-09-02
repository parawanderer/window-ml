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

test("CANCEL with NO controller (evicted run): a { cancelled } gate decision still exits cancelled — not denied+continue", async () => {
    // The reported bug: a background run whose AbortController is GONE (evicted then re-adopted) gets Stopped.
    // CANCEL_RUN can't abort the signal (no controller), so it resolves the OPEN gate with an explicit
    // cancellation `{ approved:false, cancelled:true }`. Signal is NOT aborted here — the loop must STILL read
    // this as a cancel (exit), not a plain deny that steps on to the next turn (which auto-rejected the exec
    // and left the run "stuck, can't Stop"). No `signal` passed → mirrors the no-live-controller path.
    let approvals = 0;
    const { deps, calls } = makeDeps({
        turns: [toolCall("danger"), reply("SHOULD-NOT-REACH")],   // a 2nd turn exists; a deny would step INTO it
        approve: () => { approvals++; return { approved: false, cancelled: true }; },
    });
    const res = await runAgentLoop("x", { tools: [danger] }, deps);
    assert.equal(calls.runTool.length, 0, "the tool never ran (not approved)");
    assert.equal(approvals, 1, "the gate was consulted exactly once — the loop did NOT continue to a 2nd turn");
    const done = calls.emits.find(e => e.tool === "danger" && !e.pending);
    assert.equal(done.approval, "cancelled", "provenance is 'cancelled', not 'denied' — even with no aborted signal");
    assert.doesNotMatch(done.result, /denied/i, "it does NOT read as a denial");
    assert.ok(res.cancelled, "the run resolves as cancelled");
    assert.notEqual(res.summary, "SHOULD-NOT-REACH", "the loop stopped — it did NOT run the next model turn");
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

// --- tool-token minting: GLOBAL-seq id, no cross-turn collision (shared by BOTH the page loop and the
// background host — both thread their running `seqBase` into this same runAgentLoop, so this locks the fix
// for both "backend" (background) and "non-backend" (page) paths at their common heart). ---------------
const tokenOfRun = async (seqBase, calls = 1) => {
    // A run with `calls` citable python_exec steps, at the given seqBase → the tokens its steps mint.
    const turns = [];
    for (let i = 0; i < calls; i++) turns.push(toolCall("python_exec", {}, `c${i}`));
    turns.push(reply("done"));
    const { deps, calls: c } = makeDeps({ turns });
    await runAgentLoop("t", { tools: [{ name: "python_exec" }], toolTokens: true, runHash: "abcd1234", seqBase }, deps);
    return c.emits.filter(e => e.tool === "python_exec" && e.token).map(e => e.token);
};

test("tool tokens: a citable step's id is seeded by the GLOBAL seq (seqBase + per-turn seq)", async () => {
    // Turn 1 (seqBase 0) and turn 2 (seqBase 1) each run their FIRST python_exec at per-turn seq 1. Without the
    // base, both mint toolToken(runHash, 1) — the SAME id — and a hex citation of turn 2's output resolves to
    // turn 1's earlier step (the reported bug). With the base they DIFFER.
    const [t0] = await tokenOfRun(0);   // turn 1, step 1
    const [t1] = await tokenOfRun(1);   // turn 2, step 1
    assert.ok(t0 && t1, "each turn's citable step mints a token");
    assert.notEqual(t0, t1, "turn 2's id DIFFERS from turn 1's — no cross-turn collision");
});

test("tool tokens: the id is DETERMINISTIC and CONTIGUOUS across turns (a re-render/replay resolves the same)", async () => {
    // Same (runHash, seqBase, seq) → same id, so a persisted/re-adopted transcript still resolves.
    const [a] = await tokenOfRun(0);
    const [aAgain] = await tokenOfRun(0);
    assert.equal(a, aAgain, "same seqBase → same id (deterministic)");
    // And the global seq is CONTIGUOUS: turn 2's step-1 id (seqBase 1) equals turn 1's step-2 id (seqBase 0,
    // its second call at per-turn seq 2) — the base picks up exactly where the prior turn left off, no gap/overlap.
    const twoInTurnOne = await tokenOfRun(0, 2);   // [seq1, seq2]
    const [turnTwoStepOne] = await tokenOfRun(1);  // seqBase 1 + seq 1
    assert.equal(turnTwoStepOne, twoInTurnOne[1], "turn 2 step 1 == turn 1 step 2 (contiguous global seq)");
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

test("chat_metadata reports cumulative token SPEND + generation rate with its basis", async () => {
    const { deps, calls } = makeDeps({ turns: [
        // The chat_metadata turn carries usage WITH Ollama eval timing → cumulative spend + a tok/s rate.
        { content: "", tool_calls: [{ id: "m1", name: "chat_metadata", arguments: {} }], usage: { promptTokens: 1200, completionTokens: 40, totalTokens: 1240, evalMs: 2000 } },
        reply("info"),
    ] });
    deps.chatMeta = async () => ({ model: "qwen3", contextWindow: 40960, capabilities: ["tools"], vramGB: null, local: true, backend: null, systemTokens: 100, toolTokens: 200 });
    await runAgentLoop("x", { tools: [{ name: "chat_metadata", capabilities: ["meta"] }] }, deps);
    const done = calls.emits.find(e => e.tool === "chat_metadata" && !e.pending);
    assert.match(done.result, /cumulative tokens: 1200 in \+ 40 out = 1240 billed across 1 call\b/, "cumulative SPEND (in/out/total across N calls)");
    assert.match(done.result, /generation rate: 20\.0 tok\/s/, "40 out tokens ÷ 2s eval = 20 tok/s");
    assert.match(done.result, /Ollama generation time/, "the rate's basis/provenance is recorded");
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
    assert.match(done.result, /delegated vision sub-calls this session: 3510 tokens over 3 calls/, "reports the metered number (prompt+completion)");
    assert.match(done.result, /SEPARATE context.*not part of the occupancy/, "clarifies it's spend, not occupancy");
    assert.doesNotMatch(done.result, /none yet this session/, "the fallback note is replaced by the real number");
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

test("inline vision: a tool returning images[] injects EACH (look's overlay + no-overlay views)", async () => {
    const { deps } = makeDeps({ turns: [toolCall("look"), reply("done")] });
    deps.runTool = async () => ({ result: "captured", images: [{ image: "MARKED", label: "with box" }, { image: "CLEAN", label: "no box" }] });
    const pushed = [];
    deps.pushToolImages = (m, imgs) => { pushed.push(...imgs); };
    await runAgentLoop("x", { tools: [{ name: "look", capabilities: ["vision"] }] }, deps);
    assert.equal(pushed.length, 2, "both views become separate inline images");
    assert.deepEqual(pushed.map(p => p.image), ["MARKED", "CLEAN"]);
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

test("SALVAGE: empty content + reasoning → the reasoning becomes the answer (thinking model that never 'said' it)", async () => {
    // gemma (esp. right after a vision step) sometimes puts its whole conclusion in the reasoning/thinking
    // channel and returns EMPTY content + no tool call. The loop would otherwise return a BLANK summary even
    // though the model clearly knew the answer — so we fall back to the reasoning text.
    const { deps } = makeDeps({ turns: [{ content: "", tool_calls: [], reasoning: "The code is CROSSPAGE-9471." }] });
    const res = await runAgentLoop("x", { tools: [] }, deps);
    assert.equal(res.summary, "The code is CROSSPAGE-9471.", "reasoning is salvaged as the summary, not an empty string");
    assert.deepEqual(res.transcript.at(-1), { assistant: "The code is CROSSPAGE-9471." }, "and recorded in the transcript");
});

test("SALVAGE: real content WINS over reasoning (salvage only fills a blank content)", async () => {
    const { deps } = makeDeps({ turns: [{ content: "Done: the code is X.", tool_calls: [], reasoning: "internal musing" }] });
    const res = await runAgentLoop("x", { tools: [] }, deps);
    assert.equal(res.summary, "Done: the code is X.", "the model's actual reply is the answer; reasoning stays internal");
});

test("SALVAGE: empty content AND no reasoning → still an empty summary (no spurious salvage)", async () => {
    const { deps } = makeDeps({ turns: [{ content: "", tool_calls: [] }] });
    const res = await runAgentLoop("x", { tools: [] }, deps);
    assert.equal(res.summary, "", "nothing to salvage → empty summary, behaviour unchanged");
});

test("denial attribution: an EXTERNAL approver's rejection reads 'Denied by an external approver', not 'the user'", async () => {
    const danger2 = { name: "danger", requiresApproval: true };
    // The gate returns the rich decision an IPC (__mlApprovals) reject produces: { approved:false, source:"external" }.
    const { deps } = makeDeps({ turns: [toolCall("danger"), reply("ok")], approve: () => ({ approved: false, source: "external" }) });
    const res = await runAgentLoop("x", { tools: [danger2] }, deps);
    assert.match(res.transcript[0].result, /Denied by an external approver/);
    assert.doesNotMatch(res.transcript[0].result, /by the user/);
});

test("denial attribution: a UI/user rejection (no source, or source:'user') still reads 'Denied by the user'", async () => {
    const danger2 = { name: "danger", requiresApproval: true };
    const { deps } = makeDeps({ turns: [toolCall("danger"), reply("ok")], approve: () => false });   // boolean → source defaults to user
    const res = await runAgentLoop("x", { tools: [danger2] }, deps);
    assert.match(res.transcript[0].result, /Denied by the user/);
});

test("live tool output: opt-in `stream` hands the tool a throttled ctx.stream that fans streamOutput deltas", async () => {
    // A non-approval tool that streams two lines >throttle apart (so both flush past the 90ms leading edge).
    const { deps, calls } = makeDeps({ turns: [toolCall("myTool", {}), reply("done")] });
    deps.runTool = async (name, args, onStream) => {
        onStream?.("line 1\n");
        await new Promise(r => setTimeout(r, 120));
        onStream?.("line 2\n");
        return { result: "console:\nline 1\nline 2\n\nvalue: ok" };
    };
    await runAgentLoop("x", { tools: [{ name: "myTool" }], stream: true }, deps);
    const deltas = calls.emits.filter(e => e.streamOutput != null && e.tool == null);
    assert.ok(deltas.length >= 1, "the loop fanned live stream deltas");
    assert.match(deltas.at(-1).streamOutput, /line 1[\s\S]*line 2/, "the delta accumulates the streamed output");
    // Every delta carries the seq (to patch the pending row) and NO tool (so the reducer patches additively).
    assert.ok(deltas.every(d => d.seq != null && d.tool == null), "deltas patch by seq, never rebuild the step");
});

test("live tool output: with streaming OFF, the tool gets no ctx.stream (undefined) and nothing is fanned", async () => {
    const { deps, calls } = makeDeps({ turns: [toolCall("myTool", {}), reply("done")] });
    let onStreamWas = "unset";
    deps.runTool = async (name, args, onStream) => { onStreamWas = onStream === undefined ? "undefined" : "provided"; return { result: "ok" }; };
    await runAgentLoop("x", { tools: [{ name: "myTool" }] }, deps);   // no `stream`
    assert.equal(onStreamWas, "undefined", "runTool gets no onStream when streaming is off (fan?.push is undefined)");
    assert.equal(calls.emits.filter(e => e.streamOutput != null).length, 0, "no stream deltas emitted");
});
