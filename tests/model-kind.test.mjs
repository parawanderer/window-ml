"use strict";
// Which models belong in which picker. The rules here are not guesses: they were settled by probing a real
// Ollama (39 models) on 2026-09-03, and the obvious rule turned out to be wrong.
import { test } from "node:test";
import assert from "node:assert";
const { generatesText, producesEmbeddings } = await import("../sw-llm.ts");

// Verbatim from that probe.
const REAL = {
    "embeddinggemma:300m": ["embedding"],
    "nomic-embed-text-v2-moe:latest": ["embedding"],
    "qwen3-embedding:0.6b": ["tools", "thinking", "embedding"],
    "qwen3-embedding:8b": ["tools", "embedding"],
    "qwen3.8:27b": ["completion", "vision", "tools", "thinking"],
    "gemma4:e2b": ["completion", "vision", "audio", "tools", "thinking"],
};

test("generatesText: requires `completion`, because an embedding model may claim other capabilities", () => {
    // The trap: hiding anything that lists `embedding` happens to work here, but qwen3-embedding also
    // advertises tools/thinking — so the discriminating fact is the ABSENCE of completion, not the
    // presence of embedding. Requiring completion also survives a model that genuinely does both.
    assert.equal(generatesText(REAL["qwen3.8:27b"]), true);
    assert.equal(generatesText(REAL["gemma4:e2b"]), true);
    for (const m of ["embeddinggemma:300m", "nomic-embed-text-v2-moe:latest", "qwen3-embedding:0.6b", "qwen3-embedding:8b"]) {
        assert.equal(generatesText(REAL[m]), false, `${m} must not be offered as a chat model`);
    }
    // A hypothetical model that does both is offered for chat, correctly — the embedding-exclusion rule
    // would have hidden it.
    assert.equal(generatesText(["completion", "embedding"]), true);
    // Unknown = a cloud/non-Ollama model we cannot interrogate. Fail OPEN, as modelFilter does: never hide
    // a model merely because we failed to classify it.
    assert.equal(generatesText(null), true);
});

test("producesEmbeddings: fails CLOSED, because a wrong pick fails confusingly at runtime", () => {
    for (const m of ["embeddinggemma:300m", "nomic-embed-text-v2-moe:latest", "qwen3-embedding:0.6b", "qwen3-embedding:8b"]) {
        assert.equal(producesEmbeddings(REAL[m]), true, `${m} should be offered as an embedding model`);
    }
    assert.equal(producesEmbeddings(REAL["qwen3.8:27b"]), false);
    assert.equal(producesEmbeddings(REAL["gemma4:e2b"]), false);
    // Unknown is NOT offered — unlike the chat list, a shorter list is cheaper than a runtime surprise.
    assert.equal(producesEmbeddings(null), false);
    assert.equal(producesEmbeddings([]), false);
});

// The two pickers must partition today's models with no overlap and nothing stranded.
test("the two predicates partition a real model list", () => {
    const chat = Object.keys(REAL).filter((m) => generatesText(REAL[m]));
    const embed = Object.keys(REAL).filter((m) => producesEmbeddings(REAL[m]));
    assert.deepEqual(chat, ["qwen3.8:27b", "gemma4:e2b"]);
    assert.equal(embed.length, 4);
    assert.equal(chat.filter((m) => embed.includes(m)).length, 0, "no model appears in both");
    assert.equal(chat.length + embed.length, Object.keys(REAL).length, "and none is stranded");
});
