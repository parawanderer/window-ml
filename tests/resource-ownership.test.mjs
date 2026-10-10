// Whose a resident model was (ownership.ts): loaded for one of our sessions, used by ours after someone else loaded it,
// or neither, read from the box's loads, evictions and the session each generation named. The memory tooltips and the
// bench's memory.md both read it.

import test from "node:test";
import assert from "node:assert/strict";
import { ownership } from "../src/resource/ownership.ts";

const load = (model, t, until = t + 5) => ({ kind: "load", model, t, until, label: `loading ${model}` });
const evict = (model, t) => ({ kind: "evict", model, t, label: `${model} unloaded` });
const gen = (model, t, session) => ({ kind: "gen", model, t, until: t + 1, label: "gen", ...(session ? { hint: { session } } : {}) });
const OURS = (s) => s === "wml-ours";

// --- reading whose a model was ---

test("a load whose first generation was ours is ours; someone else's load that served ours is used; the rest are not ours", () => {
    const of = ownership([
        load("a", 0), gen("a", 10, "wml-ours"), gen("a", 20, "owui-x"),
        load("b", 0), gen("b", 10, "owui-x"), gen("b", 20, "wml-ours"),
        load("c", 0), gen("c", 10, "wml-other"),
    ], OURS);
    assert.equal(of("a", 30), "ours");
    assert.equal(of("b", 30), "used");
    assert.equal(of("c", 30), "other");
});

test("used means anywhere in the residency, including after the hovered instant", () => {
    // Whose an allocation is belongs to the residency, so the tag does not change along one stretch of memory.
    const of = ownership([load("b", 0), gen("b", 10, "owui-x"), gen("b", 50, "wml-ours")], OURS);
    assert.equal(of("b", 20), "used");
});

test("each residency is read on its own: an eviction and a reload start again", () => {
    const of = ownership([
        load("a", 0), gen("a", 10, "owui-x"), evict("a", 30),
        load("a", 40), gen("a", 50, "wml-ours"),
    ], OURS);
    assert.equal(of("a", 20), "other");
    assert.equal(of("a", 60), "ours");
    assert.equal(of("a", 35), null, "between the eviction and the reload it had no residency");
});

test("a model resident before the events begin is not ours until ours use it, and never 'loaded for' us", () => {
    const of = ownership([gen("x", 5, "owui-x"), gen("a", 5, "wml-ours"), gen("a", 6, "wml-ours")], OURS);
    assert.equal(of("never-seen", 10), "other");
    assert.equal(of("a", 10), "used", "its load is not in the history, so whose load it was is unknown");
});

test("the model's name is compared canonically: the stream's full name and ps's short one are one model", () => {
    const of = ownership([load("registry.ollama.ai/library/qwen3:8b", 0), gen("registry.ollama.ai/library/qwen3:8b", 10, "wml-ours")], OURS);
    assert.equal(of("qwen3:8b", 20), "ours");
});

// --- the default: no hints is unknown, not "nothing is ours" ---

test("a box that names no session on any generation gives no reader at all", () => {
    assert.equal(ownership([load("a", 0), gen("a", 10)], OURS), null);
    assert.equal(ownership([], OURS), null);
});
