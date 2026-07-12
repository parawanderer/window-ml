const { test } = require("node:test");
const assert = require("node:assert");
const { jsonResponse, htmlResponse, streamResponse, loadBackground } = require("./helpers");

const IMG = "data:image/png;base64,AAA";

function baseConfig(overrides = {}) {
    return {
        chatUrl: "http://host/api/chat/completions",
        apiKey: "sk-test",
        model: "default-model",
        apiFormat: "openai",
        ocrModel: "",
        ...overrides
    };
}

test("FETCH_LLM builds an OpenAI body and extracts the reply", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.equal(call.url, "http://host/api/chat/completions");
            assert.equal(call.opts.method, "POST");
            assert.equal(call.opts.headers["Authorization"], "Bearer sk-test");
            assert.equal(call.body.model, "default-model");
            assert.equal(call.body.stream, false);
            assert.equal(call.body.think, false);
            assert.deepEqual(call.body.messages, [{ role: "user", content: "hi" }]);
            return jsonResponse({ choices: [{ message: { content: "yo" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }], think: false }
    });
    assert.deepEqual(res, { data: "yo" });
});

test("FETCH_LLM omits think unless it is a boolean", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.ok(!("think" in call.body));
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }], think: null }
    });
    assert.equal(res.data, "ok");
});

test("FETCH_LLM maxTokens becomes max_tokens (openai) and is omitted otherwise", async () => {
    let sawBody;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => { sawBody = call.body; return jsonResponse({ choices: [{ message: { content: "ok" } }] }); }
    });

    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], maxTokens: 512 } });
    assert.equal(sawBody.max_tokens, 512);

    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.ok(!("max_tokens" in sawBody), "no cap → no max_tokens field");

    // Non-positive / non-integer caps are ignored (no runaway guard, but no bad body).
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], maxTokens: 0 } });
    assert.ok(!("max_tokens" in sawBody));
});

test("FETCH_LLM maxTokens becomes options.num_predict on the ollama format", async () => {
    let sawBody;
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: (call) => { sawBody = call.body; return jsonResponse({ message: { content: "ok" } }); }
    });

    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], maxTokens: 256 } });
    assert.equal(sawBody.options.num_predict, 256);
});

test("FETCH_LLM extend:'utility' resolves the utility model + num_ctx/num_gpu (ollama)", async () => {
    let sawBody;
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat", model: "big:70b", utilityModel: "small:0.8b", utilityNumCtx: 2048, utilityForceCpu: true }),
        onFetch: (call) => { sawBody = call.body; return jsonResponse({ message: { content: "ok" } }); }
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], extend: "utility" } });
    assert.equal(sawBody.model, "small:0.8b", "utility model");
    assert.equal(sawBody.options.num_ctx, 2048);
    assert.equal(sawBody.options.num_gpu, 0, "force CPU → num_gpu 0");
});

test("FETCH_LLM extend:'utility' falls back to the default model when unset", async () => {
    let sawBody;
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat", model: "big:70b", utilityModel: "" }),
        onFetch: (call) => { sawBody = call.body; return jsonResponse({ message: { content: "ok" } }); }
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], extend: "utility" } });
    assert.equal(sawBody.model, "big:70b");
});

test("FETCH_LLM explicit model + numCtx override the extend profile ({...profile, ...explicit})", async () => {
    let sawBody;
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat", utilityModel: "small:0.8b", utilityNumCtx: 2048 }),
        onFetch: (call) => { sawBody = call.body; return jsonResponse({ message: { content: "ok" } }); }
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], extend: "utility", model: "mid:14b", numCtx: 8192 } });
    assert.equal(sawBody.model, "mid:14b", "explicit model wins");
    assert.equal(sawBody.options.num_ctx, 8192, "explicit numCtx wins");
});

test("FETCH_LLM num_ctx/num_gpu ride the options body on the openai format too (OpenWebUI forwards them)", async () => {
    let sawBody;
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "openai", utilityModel: "small", utilityNumCtx: 2048, utilityForceCpu: true }),
        onFetch: (call) => { sawBody = call.body; return jsonResponse({ choices: [{ message: { content: "ok" } }] }); }
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], extend: "utility" } });
    assert.equal(sawBody.model, "small", "utility model applies");
    assert.equal(sawBody.options.num_ctx, 2048);
    assert.equal(sawBody.options.num_gpu, 0);
});

test("GET_CONFIG exposes the utility-model fields", async () => {
    const bg = loadBackground({
        config: baseConfig({ utilityModel: "small:0.8b", utilityNumCtx: 2048, utilityForceCpu: true }),
        onFetch: () => jsonResponse({})
    });
    const resp = await bg.send({ type: "GET_CONFIG", payload: {} });
    assert.equal(resp.data.utilityModel, "small:0.8b");
    assert.equal(resp.data.utilityNumCtx, 2048);
    assert.equal(resp.data.utilityForceCpu, true);
});

test("FETCH_LLM honors a per-call model override", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.equal(call.body.model, "override-model");
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }], model: "override-model" }
    });
    assert.equal(res.data, "ok");
});

test("FETCH_LLM ocr flag resolves the dedicated ocrModel", async () => {
    const bg = loadBackground({
        config: baseConfig({ model: "qwen3:235b", ocrModel: "qwen2.5vl" }),
        onFetch: (call) => {
            if (call.url.endsWith("/api/show")) {
                return jsonResponse({ capabilities: ["completion", "vision"] });
            }
            assert.equal(call.body.model, "qwen2.5vl"); // not the reasoning model
            return jsonResponse({ choices: [{ message: { content: "hello world" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "transcribe", images: [IMG] }], ocr: true }
    });
    assert.equal(res.data, "hello world");
});

test("FETCH_LLM ocr flag errors clearly when no OCR model is set", async () => {
    const bg = loadBackground({
        config: baseConfig({ model: "", ocrModel: "" }),
        onFetch: () => assert.fail("no request should be sent")
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "x", images: [IMG] }], ocr: true }
    });
    assert.match(res.error, /No OCR model configured/);
});

test("FETCH_LLM errors clearly when no model is configured", async () => {
    const bg = loadBackground({
        config: baseConfig({ model: "" }),
        onFetch: () => assert.fail("no request should be sent")
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }] }
    });
    assert.match(res.error, /No model configured/);
    assert.equal(bg.calls.length, 0);
});

test("FETCH_LLM openai format attaches images as image_url content parts", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url === "http://host/ollama/api/show") {
                return jsonResponse({ capabilities: ["completion", "vision"] });
            }
            assert.deepEqual(call.body.messages, [{
                role: "user",
                content: [
                    { type: "text", text: "look" },
                    { type: "image_url", image_url: { url: IMG } }
                ]
            }]);
            return jsonResponse({ choices: [{ message: { content: "seen" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "look", images: [IMG] }] }
    });
    assert.equal(res.data, "seen");
});

test("FETCH_LLM ollama format attaches bare-base64 images and reads message.content", async () => {
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: (call) => {
            if (call.url === "http://host/ollama/api/show") {
                return jsonResponse({ capabilities: ["completion", "vision"] });
            }
            assert.deepEqual(call.body.messages, [
                { role: "user", content: "look", images: ["AAA"] }
            ]);
            return jsonResponse({ message: { content: "seen" } });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "look", images: [IMG] }] }
    });
    assert.equal(res.data, "seen");
});

test("FETCH_LLM rejects images for a model without vision, before any chat request", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.equal(call.url, "http://host/ollama/api/show");
            return jsonResponse({ capabilities: ["completion", "thinking"] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "look", images: [IMG] }] }
    });
    assert.match(res.error, /does not support image input/);
    assert.equal(bg.calls.length, 1); // only the capability probe
});

test("FETCH_LLM annotates server errors when vision support is unknown", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url.endsWith("/api/show")) return htmlResponse(405);
            return jsonResponse({ detail: "boom" }, 500);
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "look", images: [IMG] }] }
    });
    assert.match(res.error, /HTTP 500/);
    assert.match(res.error, /may not support image input/);
});

test("MODEL_CAPS returns a model's capability list from /api/show", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.ok(call.url.endsWith("/api/show"));
            assert.equal(call.body.model, "qwen3:32b");
            return jsonResponse({ capabilities: ["completion", "tools", "thinking"] });
        }
    });

    const res = await bg.send({ type: "MODEL_CAPS", payload: { model: "qwen3:32b" } });
    assert.deepEqual(res.data, ["completion", "tools", "thinking"]);
});

test("MODEL_CAPS returns null when capabilities can't be determined", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => htmlResponse(404)   // no /api/show on this backend
    });

    const res = await bg.send({ type: "MODEL_CAPS", payload: { model: "gpt-4o" } });
    assert.equal(res.data, null);
});

test("GET_CONFIG returns the model/ocrModel/apiFormat and withholds the URL and key", async () => {
    const bg = loadBackground({
        config: baseConfig({ model: "qwen3:235b", ocrModel: "qwen2.5vl", apiFormat: "ollama" })
    });

    const res = await bg.send({ type: "GET_CONFIG", payload: {} });
    assert.deepEqual(res.data, {
        model: "qwen3:235b", ocrModel: "qwen2.5vl", apiFormat: "ollama",
        utilityModel: "", utilityNumCtx: 4096, utilityForceCpu: false,
    });
    // The page must never see the server URL or API key (security invariant).
    assert.ok(!("chatUrl" in res.data) && !("apiKey" in res.data), Object.keys(res.data).join());
});

test("FETCH_LLM openai schema becomes a json_schema response_format", async () => {
    const schema = { type: "object", properties: { hide: { type: "boolean" } } };
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.deepEqual(call.body.response_format, {
                type: "json_schema",
                json_schema: { name: "response", strict: true, schema }
            });
            assert.ok(!("format" in call.body));
            return jsonResponse({ choices: [{ message: { content: "{\"hide\":true}" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }], schema }
    });
    assert.equal(res.data, "{\"hide\":true}");
});

test("FETCH_LLM ollama schema becomes the native format field", async () => {
    const schema = { type: "object", properties: { hide: { type: "boolean" } } };
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: (call) => {
            assert.deepEqual(call.body.format, schema);
            assert.ok(!("response_format" in call.body));
            return jsonResponse({ message: { content: "{\"hide\":true}" } });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }], schema }
    });
    assert.equal(res.data, "{\"hide\":true}");
});

test("FETCH_LLM omits format fields when no schema is given", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.ok(!("response_format" in call.body));
            assert.ok(!("format" in call.body));
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        }
    });

    await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }] }
    });
});

test("FETCH_LLM raw mode returns normalized tool_calls (openai, string args)", async () => {
    const tools = [{ type: "function", function: { name: "readDom", parameters: {} } }];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.deepEqual(call.body.tools, tools);
            return jsonResponse({ choices: [{ message: {
                content: null,
                tool_calls: [{ id: "call_abc", function: { name: "readDom", arguments: '{"selector":".menu"}' } }]
            } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "go" }], tools, raw: true }
    });
    assert.deepEqual(res.data, {
        content: null,
        tool_calls: [{ id: "call_abc", name: "readDom", arguments: { selector: ".menu" } }]
    });
});

test("FETCH_LLM raw mode normalizes Ollama tool_calls (object args)", async () => {
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: () => jsonResponse({ message: {
            content: "",
            tool_calls: [{ function: { name: "readDom", arguments: { selector: ".menu" } } }]
        } })
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "go" }], raw: true }
    });
    assert.equal(res.data.tool_calls[0].name, "readDom");
    assert.deepEqual(res.data.tool_calls[0].arguments, { selector: ".menu" });
    assert.equal(res.data.tool_calls[0].id, "call_0");
});

test("FETCH_LLM passes toolIds to OpenWebUI as tool_ids (openai)", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.deepEqual(call.body.tool_ids, ["web_search"]);
            // Forces a server-side execution mode so OpenWebUI runs the tool and
            // returns finished content. The exact label is version-dependent
            // ("legacy" on v0.10.0+, "default" on older); the invariant is that
            // it is NOT "native", which hands back an unexecuted tool_call.
            assert.ok(call.body.params.function_calling);
            assert.notEqual(call.body.params.function_calling, "native");
            return jsonResponse({ choices: [{ message: { content: "answer" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "weather?" }], toolIds: ["web_search"] }
    });
    assert.equal(res.data, "answer");
});

test("FETCH_LLM does not set function_calling when no toolIds", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.equal(call.body.params, undefined);
            return jsonResponse({ choices: [{ message: { content: "hi" } }] });
        }
    });

    await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }] }
    });
});

// OpenWebUI hands back an unexecuted tool_call (empty content + tool_calls) when
// the function_calling mode wasn't the server-side loop. We retry with the next
// mode label rather than sniffing the version.
const handedBack = () => jsonResponse({
    choices: [{
        finish_reason: "tool_calls",
        message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "get_x", arguments: "{}" } }]
        }
    }]
});

test("FETCH_LLM retries a handed-back tool call with the fallback mode", async () => {
    const modes = [];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            modes.push(call.body.params.function_calling);
            // First mode: server hands the call back unexecuted; second: it runs.
            return modes.length === 1
                ? handedBack()
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "go" }], toolIds: ["t"] }
    });
    assert.equal(res.data, "done");
    assert.deepEqual(modes, ["legacy", "default"]);
    assert.equal(bg.calls.length, 2);
});

test("FETCH_LLM throws a clear error when the tool call is never executed", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => handedBack()
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "go" }], toolIds: ["t"] }
    });
    assert.match(res.error, /without executing it/);
    assert.equal(bg.calls.length, 2);     // tried each mode, then gave up
});

test("FETCH_LLM rejects toolIds on the Ollama-native format", async () => {
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: () => assert.fail("no request should be sent")
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "x" }], toolIds: ["web_search"] }
    });
    assert.match(res.error, /requires OpenWebUI/);
    assert.equal(bg.calls.length, 0);
});

test("FETCH_LLM builds tool-call and tool-result messages (openai wire shape)", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            const [asst, toolMsg] = call.body.messages;
            assert.deepEqual(asst.tool_calls[0], {
                id: "call_0", type: "function",
                function: { name: "readDom", arguments: '{"selector":".x"}' }
            });
            assert.deepEqual(toolMsg, { role: "tool", tool_call_id: "call_0", content: "result text" });
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        }
    });

    await bg.send({ type: "FETCH_LLM", payload: { raw: true, messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_0", name: "readDom", arguments: { selector: ".x" } }] },
        { role: "tool", tool_call_id: "call_0", content: "result text" }
    ] } });
});

test("FETCH_LLM omits tool_call_id in tool results for Ollama", async () => {
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: (call) => {
            const toolMsg = call.body.messages.find(m => m.role === "tool");
            assert.deepEqual(toolMsg, { role: "tool", content: "r" });
            assert.ok(!("tool_call_id" in toolMsg));
            return jsonResponse({ message: { content: "done" } });
        }
    });

    await bg.send({ type: "FETCH_LLM", payload: { raw: true, messages: [
        { role: "tool", tool_call_id: "call_0", content: "r" }
    ] } });
});

test("FETCH_LLM explains a response shape mismatch", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ detail: "weird" })
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }] }
    });
    assert.match(res.error, /"openai" format/);
    assert.match(res.error, /choices\[0\]\.message\.content/);
    assert.match(res.error, /detail/);
});

test("SET_MODEL validates against the server list and persists", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.equal(call.url, "http://host/api/models");
            return jsonResponse({ data: [{ id: "a" }, { id: "b" }] });
        }
    });

    const ok = await bg.send({ type: "SET_MODEL", payload: { model: "b" } });
    assert.deepEqual(ok, { data: "b" });
    assert.equal(bg.stored.model, "b");

    const bad = await bg.send({ type: "SET_MODEL", payload: { model: "zzz" } });
    assert.match(bad.error, /Unknown model "zzz"/);
    assert.match(bad.error, /a, b/);
    assert.equal(bg.stored.model, "b"); // unchanged
});

test("LIST_MODELS explains an empty server instead of route-hopping", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            // Valid route, valid response, zero models installed.
            assert.equal(call.url, "http://host/api/models");
            return jsonResponse({ data: [] });
        }
    });

    const res = await bg.send({ type: "LIST_MODELS" });
    assert.match(res.error, /no models installed/);
    assert.match(res.error, /ollama pull/);
    assert.equal(bg.calls.length, 1); // authoritative — no fallback probing
});

test("LIST_MODELS falls back across routes (HTML means wrong path)", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url === "http://host/api/models") return htmlResponse(200);
            if (call.url === "http://host/v1/models") return htmlResponse(405);
            if (call.url === "http://host/api/tags") {
                return jsonResponse({ models: [{ name: "m1" }] });
            }
            assert.fail(`unexpected url ${call.url}`);
        }
    });

    const res = await bg.send({ type: "LIST_MODELS" });
    assert.deepEqual(res, { data: ["m1"] });
});

test("LIST_MODELS ignores config overrides from page-originated messages", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.ok(call.url.startsWith("http://host/"), `leaked to ${call.url}`);
            return jsonResponse({ data: [{ id: "a" }] });
        }
    });

    // sender.tab set = relayed from a web page: override must be ignored.
    const res = await bg.send(
        { type: "LIST_MODELS", payload: { chatUrl: "http://evil:9/api/chat/completions" } },
        { tab: { id: 1 } }
    );
    assert.deepEqual(res, { data: ["a"] });
});

test("LIST_MODELS honors overrides from the popup (no sender.tab)", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.ok(call.url.startsWith("http://other:1/"), `hit ${call.url}`);
            return jsonResponse({ data: [{ id: "a" }] });
        }
    });

    const res = await bg.send(
        { type: "LIST_MODELS", payload: { chatUrl: "http://other:1/api/chat/completions" } },
        {}
    );
    assert.deepEqual(res, { data: ["a"] });
});

test("OLLAMA_UNLOAD evicts every loaded model with keep_alive 0", async () => {
    const generated = [];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url === "http://host/ollama/api/ps") {
                return jsonResponse({ models: [{ model: "a" }, { model: "b" }] });
            }
            if (call.url === "http://host/ollama/api/generate") {
                assert.equal(call.body.keep_alive, 0);
                generated.push(call.body.model);
                return jsonResponse({ done: true });
            }
            assert.fail(`unexpected url ${call.url}`);
        }
    });

    const res = await bg.send({ type: "OLLAMA_UNLOAD", payload: {} });
    assert.deepEqual(res, { data: ["a", "b"] });
    assert.deepEqual(generated, ["a", "b"]);
});

test("OLLAMA_PS reports loaded models with VRAM usage", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({
            models: [{ model: "a", size_vram: 21_400_000_000, expires_at: "soon" }]
        })
    });

    const res = await bg.send({ type: "OLLAMA_PS", payload: {} });
    assert.deepEqual(res, { data: [{ model: "a", vramGB: 21.4, expiresAt: "soon" }] });
});

// A tiny helper: drains microtasks/macrotasks so port messages settle.
const settle = () => new Promise((r) => setTimeout(r, 10));

test("streaming Port relays SSE deltas and finishes with the full content", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.equal(call.body.stream, true);
            return streamResponse([
                'data: {"choices":[{"delta":{"role":"assistant"}}]}\n',
                'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
                'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
                "data: [DONE]\n"
            ]);
        }
    });

    const client = bg.connect("LLM_STREAM");
    client.send({ payload: { messages: [{ role: "user", content: "hi" }] } });
    await settle();

    const deltas = client.messages.filter(m => m.type === "chunk").map(m => m.delta);
    const done = client.messages.find(m => m.type === "done");
    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.equal(done.content, "Hello");
});

test("streaming with toolIds retries the next mode when the first hands back", async () => {
    const modes = [];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            modes.push(call.body.params.function_calling);
            // First mode: native-style hand-back — a tool_call, no content.
            if (modes.length === 1) {
                return streamResponse([
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]},"finish_reason":"tool_calls"}]}\n',
                    "data: [DONE]\n"
                ]);
            }
            // Second mode: the server runs the tool and streams the answer.
            return streamResponse([
                'data: {"choices":[{"delta":{"content":"done"}}]}\n',
                "data: [DONE]\n"
            ]);
        }
    });

    const client = bg.connect("LLM_STREAM");
    client.send({ payload: { messages: [{ role: "user", content: "go" }], toolIds: ["t"] } });
    await settle();

    assert.deepEqual(modes, ["legacy", "default"]);
    const deltas = client.messages.filter(m => m.type === "chunk").map(m => m.delta);
    assert.deepEqual(deltas, ["done"]);          // nothing emitted for the hand-back
    assert.equal(client.messages.find(m => m.type === "done").content, "done");
});

test("streaming surfaces errors as a port error message", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => htmlResponse(500)
    });

    const client = bg.connect("LLM_STREAM");
    client.send({ payload: { messages: [{ role: "user", content: "hi" }] } });
    await settle();

    const err = client.messages.find(m => m.type === "error");
    assert.ok(err, "expected an error message");
    assert.match(err.error, /HTTP 500/);
});

test("FETCH_LLM surfaces top-level sources alongside the reply", async () => {
    const srcs = [{ source: { name: "web/search" }, metadata: [{ source: "https://x.com" }] }];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "hi" } }], sources: srcs })
    });

    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "q" }] } });
    assert.equal(res.data, "hi");
    assert.deepEqual(res.sources, srcs);
});

test("FETCH_LLM omits sources when there are none", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "hi" } }] })
    });

    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "q" }] } });
    assert.deepEqual(res, { data: "hi" });     // no sources key on a plain chat
});

test("streaming delivers sources (their own SSE line) on the done message", async () => {
    const srcs = [{ source: { name: "web" }, metadata: [{ source: "https://x.com" }] }];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => streamResponse([
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
            'data: {"sources":' + JSON.stringify(srcs) + '}\n',
            "data: [DONE]\n"
        ])
    });

    const client = bg.connect("LLM_STREAM");
    client.send({ payload: { messages: [{ role: "user", content: "q" }] } });
    await settle();

    const done = client.messages.find(m => m.type === "done");
    assert.equal(done.content, "hi");
    assert.deepEqual(done.sources, srcs);
});

test("CAPTURE_TAB screenshots the sender's window and returns the data URL", async () => {
    const bg = loadBackground({ config: baseConfig(), onFetch: () => htmlResponse() });
    const res = await bg.send({ type: "CAPTURE_TAB", payload: {} }, { tab: { windowId: 7 } });

    assert.deepEqual(bg.captures[0], [7, { format: "png" }]); // targeted the sender's window
    assert.equal(res.data, "data:image/png;base64,SHOT");
});

test("CAPTURE_TAB surfaces a capture failure as an error", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => htmlResponse(),
        onCaptureTab: () => { throw new Error("cannot capture chrome:// page"); }
    });
    const res = await bg.send({ type: "CAPTURE_TAB", payload: {} }, { tab: { windowId: 1 } });
    assert.match(res.error, /cannot capture/);
});
