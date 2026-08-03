// Design A — the background host (agent-host.ts). Drives runBackgroundAgent with a
// scripted model + mocked delegateTool/approve, asserting the assembly: neutral-message building, the
// TRUSTED python auto-approve skipping the gate (and full-mode / external-sheet still asking), a
// non-approval tool delegating straight through, and the gate-before-execute invariant end-to-end.
import { test } from "node:test";
import assert from "node:assert";
import { runBackgroundAgent } from "../agent-host.ts";

// A model that plays a scripted list of assistant turns (one per step).
const scriptedModel = (turns) => {
    let i = 0;
    return async () => turns[i++] || { content: "done" };
};
const call = (name, args = {}, id = "c1") => ({ content: "", tool_calls: [{ id, name, arguments: args }] });
const answer = (content) => ({ content, tool_calls: [] });

const baseDeps = (over = {}) => {
    const delegated = [];
    const approvals = [];
    return {
        delegated, approvals,
        callModel: over.callModel,
        delegateTool: over.delegateTool || (async (name, args) => { delegated.push({ name, args }); return { result: `ran ${name}` }; }),
        approve: over.approve || (async (req) => { approvals.push(req); return true; }),
        isSheetApproved: over.isSheetApproved,
        emit: over.emit,
        signal: over.signal,
    };
};

test("a non-approval tool is delegated straight through — the gate is never consulted", async () => {
    const deps = baseDeps({ callModel: scriptedModel([call("look"), answer("saw it")]) });
    const { result: res } = await runBackgroundAgent(
        { task: "t", systemPrompt: "SYS", tools: [{ name: "look", requiresApproval: false }] }, deps);
    assert.equal(res.summary, "saw it");
    assert.deepEqual(deps.delegated, [{ name: "look", args: {} }]);
    assert.equal(deps.approvals.length, 0, "a non-approval tool must not hit the gate");
    assert.deepEqual(res.transcript, [{ tool: "look", arguments: {}, result: "ran look" }, { assistant: "saw it" }]);
});

test("buildMessages seeds system + user(task); the loop grows history through the injected pushers", async () => {
    let first;
    const deps = baseDeps({
        callModel: async (messages) => {
            if (!first) { first = messages.map(m => ({ role: m.role, content: m.content })); return call("look"); }
            return answer("k");
        },
    });
    await runBackgroundAgent({ task: "hello", systemPrompt: "SYS", tools: [{ name: "look" }] }, deps);
    assert.deepEqual(first, [{ role: "system", content: "SYS" }, { role: "user", content: "hello" }]);
});

test("returns { result, messages }; the final answer is recorded in history (for a RESUME to keep context)", async () => {
    const deps = baseDeps({ callModel: scriptedModel([call("look"), answer("the answer")]) });
    const { result, messages } = await runBackgroundAgent(
        { task: "first task", systemPrompt: "SYS", tools: [{ name: "look" }] }, deps);
    assert.equal(result.summary, "the answer");
    // The mutated history the caller persists for resume: system, task, the tool round-trip, the ANSWER.
    assert.equal(messages[0].content, "SYS");
    assert.equal(messages[1].content, "first task");
    assert.ok(messages.some(m => m.role === "assistant" && m.content === "the answer"), "the final answer is in history");
});

test("resumeMessages seeds the prior history + the new task (no fresh system prompt)", async () => {
    let seen;
    const prior = [
        { role: "system", content: "SYS" },
        { role: "user", content: "first task" },
        { role: "assistant", content: "first answer" },
    ];
    const deps = baseDeps({ callModel: async (messages) => { seen = messages.map(m => ({ role: m.role, content: m.content })); return answer("second answer"); } });
    const { result } = await runBackgroundAgent(
        { task: "second task", systemPrompt: "IGNORED-ON-RESUME", tools: [{ name: "look" }], resumeMessages: prior }, deps);
    assert.equal(result.summary, "second answer");
    // Continues the stored history (keeps the ORIGINAL system) + appends the follow-up as the last user turn.
    assert.deepEqual(seen, [...prior, { role: "user", content: "second task" }]);
});

test("resumeMessages: empty task appends NO user turn; a history without a system gets one prepended", async () => {
    // a.run() with no arg over prior say()s → no empty user turn. And an idle say() before the first run()
    // leaves a system-less history → the system prompt is prepended so the model is still oriented.
    let seen;
    const prior = [{ role: "user", content: "a thought I say()'d before running" }];
    const deps = baseDeps({ callModel: async (m) => { seen = m.map(x => ({ role: x.role, content: x.content })); return answer("done"); } });
    await runBackgroundAgent({ task: "", systemPrompt: "SYS", tools: [{ name: "look" }], resumeMessages: prior }, deps);
    assert.deepEqual(seen, [
        { role: "system", content: "SYS" },   // prepended (prior history had none)
        { role: "user", content: "a thought I say()'d before running" },
        // …and NO trailing empty user turn for the empty task.
    ]);
});

test("python_exec readonly + autoApprovePython → SANDBOX auto-approve, gate skipped, tool delegated", async () => {
    const deps = baseDeps({ callModel: scriptedModel([call("python_exec", { code: "return 1" }), answer("ok")]) });
    const { result: res } = await runBackgroundAgent(
        { task: "t", systemPrompt: "S", autoApprovePython: true, tools: [{ name: "python_exec", requiresApproval: true }] }, deps);
    assert.equal(deps.approvals.length, 0, "readonly python with the flag on must skip the gate");
    assert.deepEqual(deps.delegated, [{ name: "python_exec", args: { code: "return 1" } }]);
    assert.equal(res.summary, "ok");
});

test("python_exec FULL mode always asks the gate, even with the flag on", async () => {
    const deps = baseDeps({ callModel: scriptedModel([call("python_exec", { code: "x", mode: "full" }), answer("ok")]) });
    await runBackgroundAgent(
        { task: "t", systemPrompt: "S", autoApprovePython: true, tools: [{ name: "python_exec", requiresApproval: true }] }, deps);
    assert.equal(deps.approvals.length, 1, "full-mode network python must be gated regardless of the flag");
});

test("an UN-approved external sheet asks; once isSheetApproved → auto (no gate)", async () => {
    const args = { code: "return df", tables: "https://docs.google.com/spreadsheets/d/ABC/edit" };
    const asks = baseDeps({ callModel: scriptedModel([call("python_exec", args), answer("ok")]), isSheetApproved: () => false });
    await runBackgroundAgent({ task: "t", systemPrompt: "S", autoApprovePython: true, tools: [{ name: "python_exec", requiresApproval: true }] }, asks);
    assert.equal(asks.approvals.length, 1, "an external sheet not yet consented → ask");

    const auto = baseDeps({ callModel: scriptedModel([call("python_exec", args), answer("ok")]), isSheetApproved: () => true });
    await runBackgroundAgent({ task: "t", systemPrompt: "S", autoApprovePython: true, tools: [{ name: "python_exec", requiresApproval: true }] }, auto);
    assert.equal(auto.approvals.length, 0, "once the spreadsheet is approved this run → auto");
});

test("gate DENY → the tool is never delegated (the security invariant, through the host)", async () => {
    const deps = baseDeps({
        callModel: scriptedModel([call("danger"), answer("gave up")]),
        approve: async () => false,
    });
    const { result: res } = await runBackgroundAgent({ task: "t", systemPrompt: "S", tools: [{ name: "danger", requiresApproval: true }] }, deps);
    assert.equal(deps.delegated.length, 0, "a denied tool must NOT be delegated to the page");
    assert.match(res.transcript[0].result, /Denied by the user/);
});

test("emit fires a pending START then a DONE with the approval provenance", async () => {
    const events = [];
    const deps = baseDeps({
        callModel: scriptedModel([call("python_exec", { code: "return 1" }), answer("ok")]),
        emit: (ev) => events.push(ev),
    });
    await runBackgroundAgent({ task: "t", systemPrompt: "S", autoApprovePython: true, tools: [{ name: "python_exec", requiresApproval: true }] }, deps);
    const pend = events.find(e => e.pending);
    const done = events.find(e => !e.pending && e.tool === "python_exec" && e.result);
    assert.ok(pend && pend.tool === "python_exec", "a pending START is emitted");
    assert.equal(done.approval, "sandbox", "the DONE carries the auto-approve provenance");
    assert.equal(pend.seq, done.seq, "START and DONE share a seq so the sidebar patches in place");
});

test("inline vision: a native look screenshot reaches the NEXT model turn as a user image", async () => {
    // The design-A parity fix — the background loop injects the delegated tool's screenshot into the
    // model's history (a tool result can't carry an image), so a vision-capable driver sees the pixels.
    const seen = [];
    const deps = baseDeps({
        callModel: async (messages) => {
            seen.push(messages.map(m => ({ role: m.role, images: m.images })));
            return seen.length === 1 ? call("look") : answer("saw it");
        },
        delegateTool: async () => ({ result: "captured", image: "data:image/png;base64,SHOT", imageLabel: "viewport" }),
    });
    await runBackgroundAgent({ task: "t", systemPrompt: "S", tools: [{ name: "look", capabilities: ["vision"] }] }, deps);
    const imgTurn = seen[1].find(m => m.role === "user" && m.images);   // the 2nd call's messages
    assert.ok(imgTurn, "a user turn carrying the screenshot was injected before the next model call");
    assert.deepEqual(imgTurn.images, ["data:image/png;base64,SHOT"]);
});
