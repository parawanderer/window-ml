// Design A — page-side tool delegation (run-delegation.ts). Two angles:
//  1. The pure registry + envelope reduction (run-delegation.ts), unit-tested directly.
//  2. The window round-trip through the REAL content.js reverse channel (loadPageWorld): the
//     background's RUN_TOOL_IN_PAGE → PAGE_TOOL_RUN → executeTool → PAGE_TOOL_RESULT → sendResponse.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { registerRun, runDelegatedTool, endRun, getRun, runAnswer } from "../src/run-delegation.ts";
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

test("the answer tool curates the run's AnswerSet page-side (via ctx.answer); runAnswer reads it", async () => {
    const n1 = {}, n2 = {};
    registerRun("r3", [
        // The real answer tool curates ctx.answer itself; a stub does the same here. A plain tool that merely
        // RETURNS elements must NOT land in the answer (delegation no longer auto-stashes).
        tool({ name: "answer", capabilities: ["answer"], run: async (_a, ctx) => { ctx.answer.add({ kind: "element", nodes: [n1, n2], preview: "picked" }); return "picked"; } }),
        tool({ name: "plain", run: async () => ({ content: "seen", elements: [{}] }) }),
    ]);
    await runDelegatedTool("r3", "answer", {});
    await runDelegatedTool("r3", "plain", {});
    const run = getRun("r3");
    assert.deepEqual(runAnswer(run).elements, [n1, n2], "only what the answer tool designated is in the set");
    // endRun hands back the record so ml.agent can assemble AgentResult.elements/answer after the run finishes.
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

test("a multi-crop look (plural `images`, no single `image`) still renders its screenshot in Out", async () => {
    // Regression: descriptorFor only derived the Out image from `image` (singular). A two-view look
    // (views:["overlay","no-overlay"]) returns `images`, so the debug log showed NO screenshot. Now the
    // FIRST (marked) crop becomes the Out image descriptor.
    registerRun("rimg", [tool({ name: "look", run: async () => ({
        content: "Screenshot captured",
        images: [{ image: "data:image/png;base64,MARKED", label: "with click-point box" }, { image: "data:image/png;base64,CLEAN", label: "clean — no box" }],
    }) })]);
    const env = await runDelegatedTool("rimg", "look", {});
    assert.deepEqual(env.renderOut, { type: "image", src: "data:image/png;base64,MARKED", label: "with click-point box" }, "the primary crop renders instead of vanishing");
    endRun("rimg");
});

test("navigate verify text + pipe: the destination Markdown is scanned through the pipeline (+ footer); a bad pipe is actionable", async () => {
    const dom = new JSDOM("<body><h1>Home</h1><h2>Alpha</h2><p>aaa</p><h2>Beta</h2><p>bbb</p></body>");
    const prevDoc = globalThis.document;
    globalThis.document = dom.window.document;
    try {
        registerRun("rvt", [tool({ name: "exec" })]);   // exec wired → the pipe-error hint is allowed
        const env = await runDelegatedTool("rvt", "navigate", {}, { verifyText: "all", verifyPipe: "grep '^## '" });
        assert.match(env.result, /## Alpha\n## Beta/, "only the heading lines survive the pipe");
        assert.doesNotMatch(env.result, /aaa|bbb/, "the body paragraphs are filtered out before it reaches the model");
        assert.match(env.result, /piped through `grep '\^## '`/, "the size/line footer");
        const bad = await runDelegatedTool("rvt", "navigate", {}, { verifyText: "all", verifyPipe: "sed x" });
        assert.match(bad.result, /pipe error[\s\S]*not a real shell[\s\S]*exec/i, "actionable, with the exec hint (exec is wired)");
        endRun("rvt");
    } finally { globalThis.document = prevDoc; }
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

test("precheck delegation: a doomed action returns precheckFailed + the error, WITHOUT running", async () => {
    let ran = false;
    registerRun("rpc", [tool({ name: "click", requiresApproval: true, precheck: () => `No element matches "#x".`, run: () => { ran = true; return "clicked"; } })]);
    const env = await runDelegatedTool("rpc", "click", { selector: "#x" }, { precheck: true });
    assert.equal(env.precheckFailed, true, "the precheck flagged the action doomed");
    assert.match(env.result, /No element matches/);
    assert.equal(ran, false, "run() was NOT called (side-effect-free)");
    // A precheck that passes (null) → not failed.
    registerRun("rpc2", [tool({ name: "click", requiresApproval: true, precheck: () => null })]);
    const ok = await runDelegatedTool("rpc2", "click", { selector: "#y" }, { precheck: true });
    assert.equal(ok.precheckFailed, false);
    endRun("rpc"); endRun("rpc2");
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

test("readonlyTry: an in-dialect survey that RAISES maxChars must NOT auto-approve — the raise hits the human gate", async () => {
    const dom = new JSDOM('<button class="x">A</button>');
    const [prevDoc, prevEl] = [globalThis.document, globalThis.Element];
    globalThis.document = dom.window.document; globalThis.Element = dom.window.Element;
    try {
        registerRun("roMax", [tool({ name: "exec" })]);
        const js = "[...document.querySelectorAll('.x')].map(e => e.textContent)";   // read-only BY CONSTRUCTION
        assert.equal((await runDelegatedTool("roMax", "exec", { js }, { readonlyTry: true })).readonly, true, "unraised → auto-approves");
        const raised = await runDelegatedTool("roMax", "exec", { js, maxChars: 8000, maxCharsReason: "need the full list" }, { readonlyTry: true });
        assert.equal(raised.readonly, false, "a raised output cap forces the gate even though the code is read-only");
        endRun("roMax");
    } finally { globalThis.document = prevDoc; globalThis.Element = prevEl; }
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
