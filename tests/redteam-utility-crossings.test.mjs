// redteam-utility-crossings.test.mjs — no registered value reaches the utility backend, whichever of the ways a call
// takes gets it there (#2007): an extension frame's FETCH_LLM, the LLM_STREAM port, a turn's tool_calls arguments, and
// a worker run's own reader (runChat). Each crossing admits ONE message shape, and each guard reads ONE of the two
// shapes a tool call arrives in (neutral `{id, name, arguments}` vs OpenAI's `{function: {name, arguments}}`).
//
// The callers of the utility profile were enumerated rather than sampled (grep `extend: "utility"` over src/): the
// sidebar's services-ext one-shot, the settings panel's constant ping, sw-sessions' utilityCall (side.call and the
// runtime's titles), worker-tools' meteredChat, and a page's own FETCH_LLM/LLM_STREAM — the last through the same
// `forBackendFromPage` as the rows below, so its hole is this hole. None is missing from the list in
// tests/background-sessions.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 20000 };
const VALUE = "REALSECRET-4b1d-77";
const NAME = "PLUG_PASSWORD";
const MARK = `[REDACTED:${NAME}]`;
const SECRET = { name: NAME, value: VALUE };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", utilityModel: "tiny" };
const EXT = { url: "chrome-extension://test/sidebar/sidebar.html" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A worker with a utility model, one registered secret, and every request body the backend got. A streamed call is
 *  answered as SSE, which is what streamLLM reads; a one-shot call gets a JSON completion. */
function world() {
    const bodies = [];
    const bg = loadBackground({
        config,
        local: { ml_secret_registry: [SECRET] },
        onFetch: (call) => {
            if (call.body) bodies.push(JSON.stringify(call.body));
            if (call.body?.stream) return new Response(`data: {"message":{"content":"ok"},"done":true}\n\n`, { headers: { "content-type": "text/event-stream" } });
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    return { bg, bodies };
}
const carried = (bodies) => bodies.some((b) => b.includes(VALUE));
const plain = (v) => JSON.parse(JSON.stringify(v));

// --- an extension frame's one-shot utility call (FETCH_LLM) ---

test("an extension frame's utility FETCH_LLM scrubs the message text (control)", T, async () => {
    const { bg, bodies } = world();
    const r = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: `summarise: password ${VALUE}` }], extend: "utility", maxTokens: 32 } }, EXT);
    await flush();
    assert.equal(r.data, "ok", "the call was made");
    const body = bodies.find((b) => b.includes("summarise"));
    assert.ok(body.includes("[REDACTED]"), body);
    assert.ok(!carried(bodies), "no request carried the value");
});

test("an extension frame's utility FETCH_LLM scrubs a NEUTRAL tool call's arguments, the shape every sender builds", T, async () => {
    const { bg, bodies } = world();
    // API_FORMATS.buildMessage converts `{id, name, arguments}` into either wire shape at send time, so a guard that
    // reads only OpenAI's `function.arguments` watches a field this payload does not have.
    const messages = [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "type", arguments: `{"text":"${VALUE}"}` }] }, { role: "user", content: "name this" }];
    const sent = plain(messages);
    const r = await bg.send({ type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 32 } }, EXT);
    await flush();
    assert.equal(r.data, "ok", "the call was made");
    assert.ok(!carried(bodies), `the value went to the backend: ${bodies.find((b) => b.includes(VALUE))?.slice(0, 300)}`);
    assert.deepEqual(plain(messages), sent, "the asker's array is left as it was");
});

test("an extension frame's utility FETCH_LLM scrubs an assistant turn's reasoning", T, async () => {
    const { bg, bodies } = world();
    // The by-value scrub reads content, parts and arguments. This row is green because the wire body measured here has
    // no `reasoning_content` at all (the utility profile builds none): it stays green only while that holds, and the
    // scrub would not catch the field if a later profile started sending it.
    const messages = [{ role: "assistant", content: "", reasoning: `the password is ${VALUE}`, tool_calls: [{ id: "c1", name: "type", arguments: `{"text":"ok"}` }] }, { role: "user", content: "name this" }];
    const r = await bg.send({ type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 32 } }, EXT);
    await flush();
    assert.equal(r.data, "ok", "the call was made");
    assert.ok(!carried(bodies), `the value went to the backend: ${bodies.find((b) => b.includes(VALUE))?.slice(0, 300)}`);
});

// --- the same call on the streaming port (LLM_STREAM) ---

test("an extension frame's utility LLM_STREAM scrubs the message text (control)", T, async () => {
    const { bg, bodies } = world();
    const port = bg.connect("LLM_STREAM", { ...EXT });
    port.send({ payload: { messages: [{ role: "user", content: `summarise: password ${VALUE}` }], extend: "utility" } });
    for (let i = 0; i < 200 && !port.messages.some((m) => m.type === "done" || m.type === "error"); i++) await flush();
    assert.ok(port.messages.some((m) => m.type === "done"), "the call was made");
    const body = bodies.find((b) => b.includes("summarise"));
    assert.ok(body.includes("[REDACTED]"), body);
    assert.ok(!carried(bodies), "no request carried the value");
});

test("an extension frame's utility LLM_STREAM scrubs a NEUTRAL tool call's arguments too", T, async () => {
    const { bg, bodies } = world();
    const port = bg.connect("LLM_STREAM", { ...EXT });
    port.send({ payload: { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "type", arguments: `{"text":"${VALUE}"}` }] }, { role: "user", content: "name this" }], extend: "utility" } });
    for (let i = 0; i < 200 && !port.messages.some((m) => m.type === "done" || m.type === "error"); i++) await flush();
    assert.ok(port.messages.some((m) => m.type === "done"), "the call was made");
    assert.ok(!carried(bodies), `the value went to the backend: ${bodies.find((b) => b.includes(VALUE))?.slice(0, 300)}`);
});

// --- a worker run's own utility reader (runChat: fetch_url's ASK mode, python's ml.chat) ---

test("a worker run's utility call scrubs a neutral tool call's arguments (control)", T, async () => {
    const { bg, bodies } = world();
    bg.context.__mlWorkerVisionForTest.seedRun("run-u", 3);
    const messages = [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "type", arguments: `{"text":"${VALUE}"}` }] }, { role: "user", content: "name this" }];
    assert.equal(await bg.context.__mlWorkerVisionForTest.runChat("run-u", { messages, extend: "utility", think: false }), "ok");
    assert.ok(!carried(bodies), `the value went to the backend: ${bodies.find((b) => b.includes(VALUE))?.slice(0, 300)}`);
});

test("a worker run's utility call of an OpenAI-shaped call loses no unread field to the wire", T, async () => {
    const { bg, bodies } = world();
    bg.context.__mlWorkerVisionForTest.seedRun("run-u", 3);
    // forModelMessages reads `tc.arguments`; this shape has none. buildMessage then reads `tc.name`/`tc.arguments`,
    // which are absent too, so nothing of the OpenAI shape is forwarded: the row asserts that, not the scrub.
    const messages = [{ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "type", arguments: `{"text":"${VALUE}"}` } }] }, { role: "user", content: "name this" }];
    assert.equal(await bg.context.__mlWorkerVisionForTest.runChat("run-u", { messages, extend: "utility", think: false }), "ok");
    assert.ok(!carried(bodies), `the value went to the backend: ${bodies.find((b) => b.includes(VALUE))?.slice(0, 300)}`);
});
