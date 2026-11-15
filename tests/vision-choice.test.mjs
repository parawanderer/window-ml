// vision-choice.test.mjs — what a model's eye toggle starts as and what it remembers: assumed yes, then the person's word per model.
"use strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readVisionChoices, visionFor, visionKey, visionTip, withVisionChoice } from "../src/vision-choice.ts";

// --- the default, and the person's word ---

test("a model nobody said anything about is assumed to see images, and says so", () => {
    assert.deepEqual(visionFor({}, "r", "m"), { on: true, chosen: false });
});

test("the person's word is per runtime and model, and both answers are remembered", () => {
    let c = withVisionChoice({}, "r", "m", false);
    assert.deepEqual(visionFor(c, "r", "m"), { on: false, chosen: true }, "a no is remembered, not mistaken for 'never asked'");
    assert.deepEqual(visionFor(c, "r", "other"), { on: true, chosen: false }, "another model is untouched");
    assert.deepEqual(visionFor(c, "r2", "m"), { on: true, chosen: false }, "the same id on another runtime is another model");
    c = withVisionChoice(c, "r", "m", true);
    assert.deepEqual(visionFor(c, "r", "m"), { on: true, chosen: true });
});

test("the store stays bounded, dropping the oldest word first", () => {
    let c = {};
    for (let i = 0; i < 250; i++) c = withVisionChoice(c, "r", `m${i}`, false);
    assert.equal(Object.keys(c).length, 200);
    assert.equal(visionFor(c, "r", "m0").chosen, false, "the oldest is forgotten");
    assert.equal(visionFor(c, "r", "m249").chosen, true);
    const again = withVisionChoice(c, "r", "m100", true);
    assert.equal(Object.keys(again).at(-1), visionKey("r", "m100"), "a model said again is the newest");
});

// --- what a stored value may be ---

test("a stored value of any other shape means no choices", () => {
    assert.deepEqual(readVisionChoices(undefined), {});
    assert.deepEqual(readVisionChoices([true]), {});
    assert.deepEqual(readVisionChoices("x"), {});
    assert.deepEqual(readVisionChoices({ a: true, b: "no", c: false, d: 1 }), { a: true, c: false });
});

// --- the words ---

test("the tooltip never says the person said so for the assumption", () => {
    assert.doesNotMatch(visionTip(true, false), /You said/);
    assert.match(visionTip(true, true), /You said this model sees images/);
    assert.match(visionTip(false, true), /You said this model does not see images/);
});
