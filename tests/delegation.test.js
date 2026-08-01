// Design A — page-side tool delegation (run-delegation.ts). Two angles:
//  1. The pure registry + envelope reduction (dist/run-delegation.js), unit-tested directly.
//  2. The window round-trip through the REAL content.js reverse channel (loadPageWorld): the
//     background's RUN_TOOL_IN_PAGE → PAGE_TOOL_RUN → executeTool → PAGE_TOOL_RESULT → sendResponse.
const { test } = require("node:test");
const assert = require("node:assert");
const { registerRun, runDelegatedTool, endRun, getRun } = require("../dist/run-delegation.js");
const { loadPageWorld } = require("./helpers");

const tool = (over = {}) => ({
    name: "probe", description: "", parameters: { type: "object", properties: {} },
    requiresApproval: false, capabilities: [], run: async () => "ok", ...over,
});

/* ---- 1. the pure registry (no window) ---- */

test("runDelegatedTool runs the registered tool and returns its result string", async () => {
    registerRun("r1", [tool({ run: async ({ x }) => `got ${x}` })]);
    const env = await runDelegatedTool("r1", "probe", { x: 42 });
    assert.equal(env.result, "got 42");
    endRun("r1");
});

test("real DOM nodes are reduced to a COUNT (they can't cross the window bus)", async () => {
    registerRun("r2", [tool({ run: async () => ({ content: "found", elements: [{}, {}, {}] }) })]);
    const env = await runDelegatedTool("r2", "probe", {});
    assert.equal(env.result, "found");
    assert.equal(env.elementCount, 3);
    assert.ok(!("elements" in env), "the nodes themselves never appear in the serializable envelope");
    endRun("r2");
});

test("an answer-capable tool's nodes are STASHED page-side for AgentResult.elements", async () => {
    const n1 = {}, n2 = {};
    registerRun("r3", [
        tool({ name: "answer", capabilities: ["answer"], run: async () => ({ content: "picked", elements: [n1, n2] }) }),
        tool({ name: "plain", run: async () => ({ content: "seen", elements: [{}] }) }),
    ]);
    await runDelegatedTool("r3", "answer", {});
    await runDelegatedTool("r3", "plain", {});
    const run = getRun("r3");
    assert.deepEqual(run.answered, [n1, n2], "only the answer-capable tool's nodes accumulate");
    // endRun hands back the record so ml.agent can assemble AgentResult.elements after the run finishes.
    assert.strictEqual(endRun("r3"), run);
    assert.equal(getRun("r3"), undefined, "the run is gone after endRun");
});

test("serializable render descriptors + image cross back untouched", async () => {
    registerRun("r4", [tool({ run: async () => ({
        content: "c", image: "data:image/png;base64,AAA", imageLabel: "shot",
        render: { type: "image", src: "data:image/png;base64,BBB" },
        renderIn: { type: "code", text: "1+1" },
    }) })]);
    const env = await runDelegatedTool("r4", "probe", {});
    assert.equal(env.image, "data:image/png;base64,AAA");
    assert.equal(env.imageLabel, "shot");
    assert.deepEqual(env.render, { type: "image", src: "data:image/png;base64,BBB" });
    assert.deepEqual(env.renderIn, { type: "code", text: "1+1" });
    endRun("r4");
});

test("an unknown tool name → a clean error envelope (never a throw)", async () => {
    registerRun("r5", [tool()]);
    const env = await runDelegatedTool("r5", "nope", {});
    assert.match(env.result, /no tool named "nope"/);
    endRun("r5");
});

test("an unknown / ended run → a clean error envelope", async () => {
    const env = await runDelegatedTool("ghost", "probe", {});
    assert.match(env.result, /no active agent run "ghost"/);
});

test("a tool that throws is caught by executeTool → Error: result (loop keeps going)", async () => {
    registerRun("r6", [tool({ run: async () => { throw new Error("boom"); } })]);
    const env = await runDelegatedTool("r6", "probe", {});
    assert.match(env.result, /Error: boom/);
    endRun("r6");
});

/* ---- 2. the full window round-trip through content.js's reverse channel ---- */

test("RUN_TOOL_IN_PAGE relays through content.js → the page runs the tool → envelope via sendResponse", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "ok" }) });
    // ml.agent's START_RUN shim will do this; here we register directly to test the transport.
    world.ml._registerRun("run-A", [world.ml.defineTool({
        name: "echo", parameters: { type: "object", properties: { msg: { type: "string" } } },
        run: ({ msg }) => `echo:${msg}`,
    })]);

    const envelope = await world.fireRuntimeMessage({
        type: "RUN_TOOL_IN_PAGE", payload: { runId: "run-A", name: "echo", args: { msg: "hi" } },
    });
    assert.equal(envelope.result, "echo:hi");
    world.ml._endRun("run-A");
});

test("a non-RUN_TOOL_IN_PAGE message is ignored by the reverse channel (returns undefined)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "ok" }) });
    const r = await world.fireRuntimeMessage({ type: "SOMETHING_ELSE", payload: {} });
    assert.equal(r, undefined);
});
