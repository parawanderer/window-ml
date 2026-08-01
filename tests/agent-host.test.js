// Design A — the background host (agent-host.ts → dist/agent-host.js). Drives runBackgroundAgent with a
// scripted model + mocked delegateTool/approve, asserting the assembly: neutral-message building, the
// TRUSTED python auto-approve skipping the gate (and full-mode / external-sheet still asking), a
// non-approval tool delegating straight through, and the gate-before-execute invariant end-to-end.
const { test } = require("node:test");
const assert = require("node:assert");
const { runBackgroundAgent } = require("../dist/agent-host.js");

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
    const res = await runBackgroundAgent(
        { task: "t", systemPrompt: "SYS", tools: [{ name: "look", requiresApproval: false }] }, deps);
    assert.equal(res.summary, "saw it");
    assert.deepEqual(deps.delegated, [{ name: "look", args: {} }]);
    assert.equal(deps.approvals.length, 0, "a non-approval tool must not hit the gate");
    assert.deepEqual(res.transcript, [{ tool: "look", arguments: {}, result: "ran look" }]);
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

test("python_exec readonly + autoApprovePython → SANDBOX auto-approve, gate skipped, tool delegated", async () => {
    const deps = baseDeps({ callModel: scriptedModel([call("python_exec", { code: "return 1" }), answer("ok")]) });
    const res = await runBackgroundAgent(
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
    const res = await runBackgroundAgent({ task: "t", systemPrompt: "S", tools: [{ name: "danger", requiresApproval: true }] }, deps);
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
