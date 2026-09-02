"use strict";
// `dereference` and pointer-aware `look` AS THE LOOP ANSWERS THEM. The unit tests cover the pipe dialect and
// the pointer layer; these drive the real runAgentLoop, so they cover the parts only the loop does: minting a
// pointer with the right TYPE from a step's render descriptor, the reply header (what it is, how stale), the
// tool-level error shapes, and rewriting a `look` at an @tool: pointer into a look at that image.
import { test } from "node:test";
import assert from "node:assert";
const { runAgentLoop } = await import("../agent-loop.ts");

const TOOLS = [
    { name: "exec", description: "", parameters: { type: "object", properties: {} } },
    { name: "python_exec", description: "", parameters: { type: "object", properties: {} } },
    { name: "look", description: "", parameters: { type: "object", properties: {} } },
    { name: "dereference", description: "", parameters: { type: "object", properties: {} } },
];
const call = (name, args, id = "c1") => ({ content: "", tool_calls: [{ id, name, arguments: args }] });

/** Drive the loop over scripted turns; return every tool result the MODEL was handed, plus the args each tool
 *  actually received (so a rewritten `look` is observable). */
async function drive(turns, runTool) {
    const results = [], got = [];
    let i = 0;
    await runAgentLoop("t", { tools: TOOLS, maxSteps: () => turns.length + 2, toolTokens: true, runHash: "abcdef" }, {
        callModel: async () => turns[i++] || { content: "done", tool_calls: [] },
        runTool: async (name, args) => { got.push({ name, args }); return runTool(name, args); },
        autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, c, result) => { results.push({ name: c.name, result }); m.push({ role: "tool", content: result }); },
    });
    return { results, got };
}
const derefResult = (r) => r.results.find((x) => x.name === "dereference").result;

test("dereference: the reply says WHAT the value is and HOW STALE, then the piped text", async () => {
    const full = Array.from({ length: 300 }, (_, i) => `row ${i + 1}: v${i + 1}`).join("\n");
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:exec", pipe: "grep 'row 297:'" })],
        (name) => name === "exec"
            ? { result: full.slice(0, 120) + "… [+truncated]", renderOut: { type: "exec-out", stdout: full, seen: 120 } }
            : { result: "" });

    const out = results.find((r) => r.name === "dereference").result;
    assert.match(out, /^@tool:[0-9a-f]{6} \(exec\) — text, \d+ chars \/ 300 lines/, "leads with what is at the pointer");
    assert.match(out, /chars MORE than you were shown \(your copy was truncated\)/, "…and that this read is worth the step");
    assert.match(out, /captured at step 1, 1 step ago — the page may have changed since/, "…and how stale it is");
    assert.match(out, /row 297: v297/, "then the piped value — a line the model never saw");
});

test("dereference: a hallucinated pointer returns a MemoryFault naming the real ones", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:deadbe" })],
        () => ({ result: "captured" }));
    const out = results.find((r) => r.name === "dereference").result;
    assert.match(out, /^Error: MemoryFault: pointer '@tool:deadbe' does not exist\./);
    assert.match(out, /Nearest valid pointers:/);
    assert.match(out, /\(1 step back: exec\) +\[edit_dist=\d+\]/, "the real pointer, with distance and how far back");
    assert.match(out, /recoverable/i);
});

test("dereference: a missing token argument lists what IS available", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { pipe: "head 2" })],
        () => ({ result: "captured" }));
    const out = results.find((r) => r.name === "dereference").result;
    assert.match(out, /^Error: "token" is required/);
    assert.match(out, /@tool:[0-9a-f]{6} \(exec, step 1\)/, "names the pointer it could have used");
});

test("dereference: a bad pipe stage returns the dialect's own actionable refusal", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:exec", pipe: "jq .name" })],
        () => ({ result: "captured" }));
    assert.match(derefResult({ results }), /^Error: `jq` isn't a supported text command/);
});

// The pointer carries the value's TYPE, taken from the step's render descriptor — that is what makes `keys` on
// a DataFrame mean its COLUMNS rather than whatever re-parsing rendered text would produce.
test("mint: a DataFrame step becomes a TABLE pointer, so keys are its columns", async () => {
    const df = { columns: ["name", "qty", "price"], rows: [["apples", 3, 1.2], ["pears", 5, 0.9]] };
    const { results } = await drive(
        [call("python_exec", { code: "x", token: true }), call("dereference", { token: "@tool:python_exec", pipe: "keys" })],
        (name) => name === "python_exec"
            ? { result: "a DataFrame", renderOut: { type: "python-out", df } }
            : { result: "" });

    const out = derefResult({ results });
    assert.match(out, /a 2x3 table \(name, qty, price\)/, "described as a table, not as N chars of text");
    assert.match(out, /\[\s*"name",\s*"qty",\s*"price"\s*\]/, "keys yields the COLUMNS");
});

test("mint: a JSON-looking result is typed json, a code render is typed code", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:exec", pipe: "keys" })],
        () => ({ result: '{"a":1,"b":2}' }));
    const out = derefResult({ results });
    assert.match(out, /— JSON, \d+ chars/, "a result that parses as JSON is typed json");
    assert.match(out, /\[\s*"a",\s*"b"\s*\]/);
});

// `look` at an @tool: pointer re-examines a screenshot the run already took — a NEW question about the SAME
// pixels, instead of re-shooting a page that may have scrolled since. The LOOP resolves it (it owns the store)
// and hands the image down, so `look` itself never learns about tokens.
test("look: an @tool: image pointer is rewritten into a look at that image", async () => {
    const shot = "data:image/png;base64,AAAA";
    const { got, results } = await drive(
        [call("look", { question: "what is here?", token: true }), call("look", { selector: "@tool:look", question: "any red text?" })],
        () => ({ result: "a page", image: shot, imageLabel: "viewport", renderOut: { type: "image", src: shot } }));

    const second = got.filter((g) => g.name === "look")[1];
    assert.equal(second.args._image, shot, "the loop resolved the pointer to the captured image");
    assert.match(second.args._imageLabel, /@tool:[0-9a-f]{6} \(captured at step 1\)/, "…labelled with where it came from");
    assert.equal(second.args.question, "any red text?", "the model's own question is preserved");
    assert.equal(results.filter((r) => r.name === "look").length, 2);
});

test("look: a pointer to a NON-image says what it actually is and redirects to dereference", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("look", { selector: "@tool:exec" })],
        () => ({ result: "some text output" }));
    const out = results.find((r) => r.name === "look").result;
    assert.match(out, /is text, \d+ chars .*, not an image — there is nothing to look at/);
    assert.match(out, /Read it with dereference instead/);
});

test("look: an unresolvable pointer faults like any other bad pointer", async () => {
    const { results, got } = await drive(
        [call("exec", { js: "x", token: true }), call("look", { selector: "@tool:zzzzzz" })],
        () => ({ result: "captured" }));
    const out = results.find((r) => r.name === "look").result;
    assert.match(out, /MemoryFault: pointer '@tool:zzzzzz' does not exist/);
    assert.equal(got.filter((g) => g.name === "look").length, 0, "and look is never invoked with a broken pointer");
});

test("look: an ordinary selector passes through untouched", async () => {
    const { got } = await drive([call("look", { selector: "#hero" })], () => ({ result: "ok" }));
    const l = got.find((g) => g.name === "look");
    assert.equal(l.args.selector, "#hero");
    assert.ok(!("_image" in l.args), "no pointer machinery on a normal look");
});

// `token` as a LABEL: the string is both the opt-in and the model's own name for the pointer.
test("token as a label: names the pointer in the reply, the listing, and the fault", async () => {
    const { results } = await drive(
        [call("python_exec", { code: "x", token: "the pricing table" }),
         call("dereference", { token: "@tool:python_exec" }),
         call("dereference", { token: "@tool:deadbe" })],
        (name) => name === "python_exec" ? { result: "rows…" } : { result: "" });

    const [read, fault] = results.filter((r) => r.name === "dereference").map((r) => r.result);
    assert.match(read, /\(python_exec: "the pricing table"\) — text, \d+ chars/,
        "the model's own name leads, the DERIVED description still follows it");
    assert.match(fault, /\(2 steps back: python_exec: "the pricing table"\)/, "the fault lists it by name too");
});

test("token as a label: a string still opts IN (it is not just decoration)", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: "nav links" }), call("dereference", { token: "@tool:exec" })],
        () => ({ result: "a\nb" }));
    // If the string hadn't counted as opting in, the id would never have been surfaced to the model.
    const execResult = results.find((r) => r.name === "exec").result;
    assert.match(execResult, /@tool:[0-9a-f]{6}/, "the handle was surfaced because the label opted in");
    assert.match(derefResult({ results }), /"nav links"/);
});
