// A streamed agent turn's TOOL CALL as it is written: the worker's `agent-stream` carries the call's name and its
// argument text so far (`calls`), so a long argument is watched arriving instead of appearing whole when the model
// stops. Display only: what runs is still the parsed call. Against the built bundle, like background.test.js.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { streamResponse, binaryStreamResponse, loadBackground } = require("./helpers");

const T = { timeout: 10000 };
const config = (over = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", ...over });
// `survey_page` stands in for the captures' `python_exec` (fixtures/tool-call-deltas/README.md): a page tool, so the
// call runs without a Python sandbox.
const TOOLS = ["findByText", "survey_page"].map((name) => ({ name, description: "", parameters: { type: "object", properties: { text: { type: "string" }, code: { type: "string" } } }, requiresApproval: false, capabilities: [] }));

/** Run one streamed agent whose first turn is `first` (lines, or a whole response) and whose second answers, and
 *  collect what the panel saw, what the page tool was handed, and what the second request told the model. */
async function run(cfg, first, second) {
    let call = 0, delegated = null;
    const requests = [];
    const bg = loadBackground({
        config: cfg,
        onTabMessage: (_tabId, msg) => {
            if (msg?.type === "RUN_TOOL_IN_PAGE" && TOOLS.some((t) => t.name === msg.payload?.name) && !msg.payload.renderOnly) { delegated = msg.payload.args; return { result: "found" }; }
            return undefined;
        },
        onFetch: (req) => {
            requests.push(req.body);
            const turn = ++call === 1 ? first : second;
            return Array.isArray(turn) ? streamResponse(turn) : turn;
        },
    });
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const reply = await bg.send({ type: "START_RUN", payload: {
        runId: "sc", task: "t", systemPrompt: "s", tools: TOOLS, model: "m", think: null, maxSteps: 3,
        autoApprovePython: false, autoApproveReadonly: false, surface: "devtools", stream: true,
    } }, { tab: { id: 7 } });
    const streams = panel.messages.map((m) => m.__mlDebug).filter((e) => e?.kind === "agent-stream");
    const told = requests[1]?.messages?.find((m) => m.role === "tool")?.content;
    return { streams, delegated, reply, told };
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

// --- real streams from the patched server (fixtures/tool-call-deltas), replayed through the worker ---

const FIX = path.join(__dirname, "fixtures", "tool-call-deltas");
/** A capture's bytes, its tool renamed to the same-length page tool (fixtures/tool-call-deltas/README.md). */
const capture = (file) => {
    const b = fs.readFileSync(path.join(FIX, file));
    const from = Buffer.from("python_exec"), to = Buffer.from("survey_page");
    for (let i = b.indexOf(from); i >= 0; i = b.indexOf(from, i + 1)) to.copy(b, i);
    return b;
};
/** A text capture as the lines a server sends, newline kept. */
const lines = (file) => capture(file).toString("utf8").split(/(?<=\n)/);
const NATIVE = { apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" };
const ndAnswer = [`${JSON.stringify({ model: "m", message: { role: "assistant", content: "done" }, done: true })}\n`];
const sseAnswer = [sse({ content: "done" }), "data: [DONE]\n"];

/** Every native delta's argument text, joined: the line that carries the whole call can carry the last delta too,
 *  and the preview stops at the whole call, so the panel's last preview may lack that final piece. */
const joinDeltas = (wire) => wire.flatMap((l) => JSON.parse(l).message?.tool_call_deltas ?? []).map((d) => d.function?.arguments ?? "").join("");

/** What every capture must show: the call named, its text growing as prefixes of the fragments' join (the last
 *  preview, where nothing follows the fragments), and that join's VALUE being what ran (bytes may differ: the
 *  llama-server path re-encodes the final call). */
function expectReplayed({ streams, delegated }, joined) {
    const previews = streams.filter((e) => e.calls).map((e) => e.calls[0]);
    assert.ok(previews.length > 1, "the call was seen while it was written");
    assert.ok(previews.every((c) => c.name === "survey_page"), "named from its first fragment");
    joined ??= previews.at(-1).args;
    for (const c of previews) assert.ok(joined.startsWith(c.args), `each preview is a prefix of the join: ${c.args.slice(-40)}`);
    assert.ok(new Set(previews.map((c) => c.args.length)).size > 1, "it grew");
    assert.deepEqual(JSON.parse(joined), delegated, "the fragments' value is the call that ran");
    assert.equal(typeof delegated?.code, "string");
    return joined;
}

test("capture, qwen3.6 native: tool_call_deltas grow the preview, and the whole call that runs equals their join", T, async () => {
    const wire = lines("qwen3.6-native-2026-10-21.ndjson");
    const r = await run(config(NATIVE), wire, ndAnswer);
    const joined = expectReplayed(r, joinDeltas(wire));
    const whole = JSON.parse(wire.find((l) => l.includes('"tool_calls"'))).message.tool_calls[0].function.arguments;
    assert.deepEqual(r.delegated, whole, "what ran is the server's whole call");
    assert.equal(joined, JSON.stringify(whole), "on the Go parser the join is byte for byte");
});

test("capture, qwen3.8-flash-next native (llama-server): fragments and the whole call differ in bytes, not in value", T, async () => {
    const wire = lines("qwen3.8-flash-next-native-2026-10-21.ndjson");
    const r = await run(config(NATIVE), wire, ndAnswer);
    const joined = expectReplayed(r, joinDeltas(wire));
    const wholeLine = wire.find((l) => l.includes('"tool_calls"'));
    assert.match(wholeLine, /\\u003c/, "the whole call is Go's encoding");
    assert.ok(joined.includes("<") && !joined.includes("\\u003c"), "the fragments are llama.cpp's");
    assert.deepEqual(r.delegated, JSON.parse(wholeLine).message.tool_calls[0].function.arguments);
});

test("capture, qwen3.6 /v1 SSE: the fragments are the call, and it runs", T, async () => {
    expectReplayed(await run(config(), lines("qwen3.6-v1-2026-10-21.sse"), sseAnswer));
});

test("capture, qwen3.6 /v1 protobuf: the same, from Delta.tool_calls frames split across arbitrary reads", T, async () => {
    const b = capture("qwen3.6-v1-protobuf-2026-10-21.bin");
    const reads = [];
    for (let i = 0; i < b.length; i += 7) reads.push([...b.subarray(i, i + 7)]);
    expectReplayed(await run(config({ protoStream: "auto" }), binaryStreamResponse(reads), sseAnswer));
});

// --- a call that never became whole: not run, and the model or the run is told ---

const NOT_JSON = /did not arrive as complete JSON, so it did not run/;

test("/v1 fragments that stop being JSON (a parameter written twice) are not run; the model is told", T, async () => {
    // The fork's documented case: the parser saw `a` again, so no rest can follow, and the stream still says tool_calls.
    const r = await run(config(), [
        sse({ tool_calls: [{ index: 0, id: "c1", function: { name: "findByText", arguments: '{"text":"1",' } }] }),
        sse({ tool_calls: [{ index: 0, function: { arguments: '"b":"2"' } }] }),
        sse({}, { finish_reason: "tool_calls" }),
        "data: [DONE]\n",
    ], sseAnswer);
    assert.equal(r.delegated, null, "never run on a guess");
    assert.match(r.told, NOT_JSON);
});

test("native: a call still open when generation stops (fragments, no whole call) is not run; the model is told", T, async () => {
    const r = await run(config(NATIVE), [
        nd({ tool_call_deltas: [{ index: 0, id: "c1", function: { name: "findByText", arguments: '{"text":"hal' } }] }),
        `${JSON.stringify({ model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "length" })}\n`,
    ], ndAnswer);
    assert.equal(r.delegated, null);
    assert.match(r.told, NOT_JSON, "not an empty answer: the model hears its call was cut off");
});

test("native: complete-looking fragments with no whole call still do not run (only the whole call is the call)", T, async () => {
    const r = await run(config(NATIVE), [
        nd({ tool_call_deltas: [{ index: 0, id: "c1", function: { name: "findByText", arguments: '{"text":"x"}' } }] }),
        `${JSON.stringify({ model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`,
    ], ndAnswer);
    assert.equal(r.delegated, null);
    assert.match(r.told, NOT_JSON);
});

test("an error the server writes into the stream after fragments fails the run with its text", T, async () => {
    for (const [cfg, errLine] of [
        [config(NATIVE), `${JSON.stringify({ error: "XML syntax error on line 3" })}\n`],
        [config(), `data: ${JSON.stringify({ error: { message: "XML syntax error on line 3" } })}\n`],
    ]) {
        const frag = cfg.apiFormat === "ollama"
            ? nd({ tool_call_deltas: [{ index: 0, id: "c1", function: { name: "findByText", arguments: '{"text":"hal' } }] })
            : sse({ tool_calls: [{ index: 0, id: "c1", function: { name: "findByText", arguments: '{"text":"hal' } }] });
        const r = await run(cfg, [frag, errLine], cfg.apiFormat === "ollama" ? ndAnswer : sseAnswer);
        assert.equal(r.delegated, null, cfg.apiFormat);
        assert.match(String(r.reply?.error), /mid-stream: XML syntax error on line 3/, `${cfg.apiFormat}: not an empty answer`);
    }
});
