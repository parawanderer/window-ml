// A streamed agent turn's TOOL CALL as it is written: the worker's `agent-stream` carries the call's name and its
// argument text so far (`calls`), so a long argument is watched arriving instead of appearing whole when the model
// stops. Display only: what runs is still the parsed call. Against the built bundle, like background.test.js.
const { test } = require("node:test");
const assert = require("node:assert");
const { streamResponse, loadBackground } = require("./helpers");

const T = { timeout: 10000 };
const config = (over = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", ...over });
const TOOLS = [{ name: "findByText", description: "", parameters: { type: "object", properties: { text: { type: "string" } } }, requiresApproval: false, capabilities: [] }];

/** Run one streamed agent whose first turn is `first` and whose second answers, and collect what the panel saw. */
async function run(cfg, first, second) {
    let call = 0, delegated = null;
    const bg = loadBackground({
        config: cfg,
        onTabMessage: (_tabId, msg) => {
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "findByText" && !msg.payload.renderOnly) { delegated = msg.payload.args; return { result: "found" }; }
            return undefined;
        },
        onFetch: () => (++call === 1 ? streamResponse(first) : streamResponse(second)),
    });
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    await bg.send({ type: "START_RUN", payload: {
        runId: "sc", task: "t", systemPrompt: "s", tools: TOOLS, model: "m", think: null, maxSteps: 3,
        autoApprovePython: false, autoApproveReadonly: false, surface: "devtools", stream: true,
    } }, { tab: { id: 7 } });
    const streams = panel.messages.map((m) => m.__mlDebug).filter((e) => e?.kind === "agent-stream");
    return { streams, delegated };
}

const sse = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n`;
const nd = (message, extra = {}) => `${JSON.stringify({ model: "m", message: { role: "assistant", content: "", ...message }, done: false, ...extra })}\n`;

// --- the call being written rides agent-stream, on every wire that fragments it ---

test("OpenAI fragments: agent-stream carries the call's name and its argument text so far, and the last one is all of it", T, async () => {
    const args = JSON.stringify({ text: "Step 1 of the long document" });
    const pieces = [args.slice(0, 5), args.slice(5, 14), args.slice(14)];
    const { streams, delegated } = await run(config(), [
        sse({ tool_calls: [{ index: 0, id: "c1", function: { name: "findByText", arguments: pieces[0] } }] }),
        sse({ tool_calls: [{ index: 0, function: { arguments: pieces[1] } }] }),
        sse({ tool_calls: [{ index: 0, function: { arguments: pieces[2] } }] }),
        sse({}, { finish_reason: "tool_calls" }),
        "data: [DONE]\n",
    ], [sse({ content: "done" }), "data: [DONE]\n"]);
    const withCalls = streams.filter((e) => e.calls);
    assert.ok(withCalls.length >= 1, "the call being written reached the panel");
    for (const e of withCalls) {
        assert.equal(e.calls.length, 1);
        assert.equal(e.calls[0].name, "findByText", "named from its first fragment");
        assert.ok(args.startsWith(e.calls[0].args), `only text the model wrote: ${e.calls[0].args}`);
        assert.equal(e.calls[0].chars, e.calls[0].args.length);
    }
    assert.equal(withCalls.at(-1).calls[0].args, args, "the last preview holds the whole call, so it stays until the step replaces it");
    assert.deepEqual(delegated, { text: "Step 1 of the long document" }, "what runs is the accumulated call, as before");
});

test("a turn that answers in text carries no calls", T, async () => {
    const { streams } = await run(config(), [sse({ content: "just " }), sse({ content: "text" }), "data: [DONE]\n"], []);
    assert.ok(streams.length >= 1);
    assert.ok(streams.every((e) => e.calls === undefined), "no call, no field");
});

// --- Ollama native: fragments only from a patched server's tool_call_deltas, and the whole call is what runs ---

test("Ollama native with tool_call_deltas: the deltas are shown, the WHOLE call is what runs", T, async () => {
    const shown = JSON.stringify({ text: "what the deltas said" });
    const { streams, delegated } = await run(config({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }), [
        nd({ tool_call_deltas: [{ index: 0, id: "c1", function: { name: "findByText", arguments: shown.slice(0, 9) } }] }),
        nd({ tool_call_deltas: [{ index: 0, function: { arguments: shown.slice(9) } }] }),
        // The authority: the parsed call, sent whole at the end. It differs from the deltas on purpose.
        nd({ tool_calls: [{ function: { name: "findByText", arguments: { text: "what the parser decided" } } }] }),
        `${JSON.stringify({ model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 3 })}\n`,
    ], [`${JSON.stringify({ model: "m", message: { role: "assistant", content: "done" }, done: true })}\n`]);
    const withCalls = streams.filter((e) => e.calls);
    assert.ok(withCalls.length >= 1, "the deltas reached the panel");
    for (const e of withCalls) assert.ok(shown.startsWith(e.calls[0].args) && e.calls[0].name === "findByText");
    assert.deepEqual(delegated, { text: "what the parser decided" }, "the deltas are never run: the whole call is");
});

test("Ollama native without deltas (stock): the call arrives whole and no preview is invented", T, async () => {
    const { streams, delegated } = await run(config({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }), [
        nd({ thinking: "hm" }),
        nd({ tool_calls: [{ function: { name: "findByText", arguments: { text: "x" } } }] }),
        `${JSON.stringify({ model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`,
    ], [`${JSON.stringify({ model: "m", message: { role: "assistant", content: "done" }, done: true })}\n`]);
    assert.ok(streams.every((e) => e.calls === undefined), "a stock server's whole call is not a preview");
    assert.deepEqual(delegated, { text: "x" });
});
