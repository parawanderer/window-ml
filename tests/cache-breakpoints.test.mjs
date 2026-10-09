// cache-breakpoints.test.mjs — an Anthropic model's request asks for automatic prompt caching, and no other model's does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAnthropicModel, withPromptCache } from "../src/sw/cache-breakpoints.ts";

// --- which models: every spelling of an Anthropic id, and nothing else ---

test("Anthropic ids are recognised through any server prefix; other models are not", () => {
    for (const id of ["litellm.anthropic/claude-sonnet-5-5", "openrouter.anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "claude-haiku-4-5-20251001", "bedrock:claude-sonnet"])
        assert.equal(isAnthropicModel(id), true, id);
    for (const id of ["gemma4:31b", "openrouter.openai/gpt-6-luna", "deepseek.deepseek-v4-pro", "moonshot.kimi-k3", "claudette-7b-x", "", null, undefined])
        assert.equal(isAnthropicModel(id), false, String(id));
});

// --- what: one top-level marker, the messages untouched ---

test("an Anthropic body gains one top-level cache_control and nothing else; the caller's body is not mutated", () => {
    const body = { model: "litellm.anthropic/claude-sonnet-5-5", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] };
    const out = withPromptCache(body);
    assert.deepEqual(out, { ...body, cache_control: { type: "ephemeral" } });
    assert.equal(out.messages, body.messages, "the messages are the same array, with no per-message markers");
    assert.equal("cache_control" in body, false);
});

test("any other model's body comes back as the same object", () => {
    const body = { model: "gemma4:31b", messages: [] };
    assert.equal(withPromptCache(body), body);
});
