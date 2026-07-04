const { test } = require("node:test");
const assert = require("node:assert");
const { jsonResponse, htmlResponse, loadBackground } = require("./helpers");

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
            return jsonResponse({ choices: [{ message: { content: "answer" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "weather?" }], toolIds: ["web_search"] }
    });
    assert.equal(res.data, "answer");
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
