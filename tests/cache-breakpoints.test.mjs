// cache-breakpoints.test.mjs — where an Anthropic model's request is marked for prompt caching, and that nothing else is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAnthropicModel, withCacheBreakpoints } from "../src/sw/cache-breakpoints.ts";

const MARK = { cache_control: { type: "ephemeral" } };

/** A loop's wire messages after two tool turns, the second assistant turn with text. */
const loop = () => [
    { role: "system", content: "S" },
    { role: "user", content: "the task" },
    { role: "assistant", content: "", tool_calls: [{ id: "a" }] },
    { role: "tool", tool_call_id: "a", content: "r1" },
    { role: "assistant", content: "checking", tool_calls: [{ id: "b" }] },
    { role: "tool", tool_call_id: "b", content: "r2" },
    { role: "assistant", content: "", tool_calls: [{ id: "c" }] },
    { role: "tool", tool_call_id: "c", content: "r3" },
];

// --- which models: every spelling of an Anthropic id, and nothing else ---

test("Anthropic ids are recognised through any server prefix; other models are not", () => {
    for (const id of ["openrouter.anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "claude-haiku-4-5-20251001", "litellm.anthropic.claude-opus-5-5", "bedrock:claude-sonnet"])
        assert.equal(isAnthropicModel(id), true, id);
    for (const id of ["gemma4:31b", "openrouter.openai/gpt-6-luna", "deepseek.deepseek-v4-pro", "moonshot.kimi-k3", "claudette-7b-x", "", null, undefined])
        assert.equal(isAnthropicModel(id), false, String(id));
});

test("a model that is not Anthropic's gets the very same messages back", () => {
    const m = loop();
    assert.equal(withCacheBreakpoints(m, "gemma4:31b"), m);
});

// --- where: the first user message and the last assistant message with text ---

test("an Anthropic request is marked on the first user message and the last assistant turn with text, nowhere else", () => {
    const m = loop();
    const out = withCacheBreakpoints(m, "openrouter.anthropic/claude-sonnet-5.5");
    assert.deepEqual(out[1].content, [{ type: "text", text: "the task", ...MARK }]);
    assert.deepEqual(out[4].content, [{ type: "text", text: "checking", ...MARK }]);
    assert.deepEqual(out[4].tool_calls, [{ id: "b" }], "the rest of the message is kept");
    const marked = out.map((x, i) => (JSON.stringify(x).includes("cache_control") ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(marked, [1, 4], "never the system message (OpenWebUI drops it there), a tool result, or an empty turn");
    assert.deepEqual(m, loop(), "the caller's messages are not mutated");
});

test("an image message keeps its parts and carries the marker on its last one", () => {
    const parts = [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:x" } }];
    const out = withCacheBreakpoints([{ role: "user", content: parts }], "claude-sonnet-5-5");
    assert.deepEqual(out[0].content, [parts[0], { ...parts[1], ...MARK }]);
});

test("a first call (no assistant turn yet) and a request with no user message mark what they have", () => {
    assert.deepEqual(withCacheBreakpoints([{ role: "system", content: "S" }, { role: "user", content: "hi" }], "claude-x")[1].content, [{ type: "text", text: "hi", ...MARK }]);
    const only = [{ role: "system", content: "S" }];
    assert.equal(withCacheBreakpoints(only, "claude-x"), only);
});
