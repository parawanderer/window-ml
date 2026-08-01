// Design A — page-side tool delegation (run-delegation.ts). Two angles:
//  1. The pure registry + envelope reduction (run-delegation.ts), unit-tested directly.
//  2. The window round-trip through the REAL content.js reverse channel (loadPageWorld): the
//     background's RUN_TOOL_IN_PAGE → PAGE_TOOL_RUN → executeTool → PAGE_TOOL_RESULT → sendResponse.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { registerRun, runDelegatedTool, endRun, getRun } from "../run-delegation.ts";
import { loadPageWorld } from "./helpers.js";

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

test("run()-precomputed render slots become renderIn/renderOut (descriptorFor)", async () => {
    registerRun("r4", [tool({ run: async () => ({
        content: "c",
        render: { type: "image", src: "data:image/png;base64,BBB" },   // Out precomputed
        renderIn: { type: "code", text: "1+1" },                        // In precomputed
    }) })]);
    const env = await runDelegatedTool("r4", "probe", {});
    assert.deepEqual(env.renderIn, { type: "code", text: "1+1" });
    assert.deepEqual(env.renderOut, { type: "image", src: "data:image/png;base64,BBB" });
    endRun("r4");
});

test("auto-derived elements render uses clickSelector (the model's currency), NOT elPath", async () => {
    // The rendered element list must PAIR with the selectors the tool hands the model in its text
    // (click/type/answer take clickSelector). elPath's full path wouldn't match; also no bogus
    // querySelectorAll index (clickSelector is unique → a bare document.querySelector).
    const dom = new JSDOM('<body><div class="bar"><button id="go">Go</button><button>x</button></div></body>');
    const prevDoc = globalThis.document, prevEl = globalThis.Element;
    globalThis.document = dom.window.document; globalThis.Element = dom.window.Element;
    try {
        const el = dom.window.document.querySelector("#go");
        registerRun("rcs", [tool({ run: async () => ({ content: "found", elements: [el] }) })]);
        const env = await runDelegatedTool("rcs", "probe", {});
        endRun("rcs");
        assert.equal(env.renderOut.type, "elements");
        assert.equal(env.renderOut.items[0].path, "#go", "clickSelector's id — not elPath's 'body > div.bar > button#go'");
        assert.ok(!("index" in env.renderOut.items[0]), "no querySelectorAll index (the selector is already unique)");
    } finally {
        globalThis.document = prevDoc; globalThis.Element = prevEl;
    }
});

test("the Out slot auto-derives an image; the In slot uses the tool's render() method", async () => {
    registerRun("r4b", [tool({
        render: (_input, args) => ({ type: "code", text: String(args.js || "") }),   // In from the method
        run: async () => ({ content: "c", image: "data:image/png;base64,AAA", imageLabel: "shot" }),
    })]);
    const env = await runDelegatedTool("r4b", "probe", { js: "doThing()" });
    assert.deepEqual(env.renderIn, { type: "code", text: "doThing()" });
    assert.deepEqual(env.renderOut, { type: "image", src: "data:image/png;base64,AAA", label: "shot" });
    endRun("r4b");
});

test("renderOnly computes the In render WITHOUT running the tool (approval preview)", async () => {
    // The background asks for this before a blocking approval — it must be side-effect-free (the tool
    // hasn't been approved yet), yet still produce the pretty In (e.g. exec's beautified JS).
    let ran = false;
    registerRun("rr", [tool({
        render: (_i, args) => ({ type: "code", text: String(args.js || ""), format: true }),
        run: async () => { ran = true; return "SHOULD NOT RUN"; },
    })]);
    const env = await runDelegatedTool("rr", "probe", { js: "doThing()" }, { renderOnly: true });
    assert.equal(ran, false, "renderOnly must NOT execute the tool — approval hasn't happened yet");
    assert.equal(env.result, "");
    assert.deepEqual(env.renderIn, { type: "code", text: "doThing()", format: true });
    endRun("rr");
});

test("renderOnly with no render() method → empty result, no renderIn (falls back to raw args)", async () => {
    registerRun("rr2", [tool()]);   // no render method + no run()-returned renderIn (nothing ran)
    const env = await runDelegatedTool("rr2", "probe", {}, { renderOnly: true });
    assert.equal(env.result, "");
    assert.equal(env.renderIn, undefined);
    endRun("rr2");
});

test("readonlyTry: an in-dialect exec survey runs via the INTERPRETER (readonly:true, tool.run never called)", async () => {
    const dom = new JSDOM('<button class="x">A</button><button class="x">B</button>');
    const [prevDoc, prevEl] = [globalThis.document, globalThis.Element];
    globalThis.document = dom.window.document; globalThis.Element = dom.window.Element;
    try {
        let ran = false;
        registerRun("ro", [{
            name: "exec", description: "", parameters: { type: "object", properties: {} },
            requiresApproval: true, capabilities: [],
            render: (_i, a) => ({ type: "code", text: String(a.js), format: true }),
            run: () => { ran = true; return "eval-backed run() SHOULD NOT be called"; },
        }]);
        const env = await runDelegatedTool("ro", "exec",
            { js: "[...document.querySelectorAll('.x')].map(e => e.textContent)" }, { readonlyTry: true });
        assert.equal(env.readonly, true, "the interpreter handled it → auto-approvable");
        assert.equal(ran, false, "the tool's eval-backed run() is never invoked — the interpreter ran it");
        assert.match(env.result, /A|B/);
        assert.ok(env.renderIn, "the pretty-JS In render is computed too");
        endRun("ro");
    } finally { globalThis.document = prevDoc; globalThis.Element = prevEl; }
});

test("readonlyTry: a non-exec tool or non-string js → readonly:false (falls through to the gate)", async () => {
    registerRun("ro2", [tool({ name: "click" }), tool({ name: "exec" })]);
    assert.equal((await runDelegatedTool("ro2", "click", { x: 1 }, { readonlyTry: true })).readonly, false, "only exec is tried");
    assert.equal((await runDelegatedTool("ro2", "exec", { js: 123 }, { readonlyTry: true })).readonly, false, "non-string js");
    endRun("ro2");
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
