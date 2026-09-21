// mobile-attach.test.mjs — how much image the phone's composer lets one message carry (mobile/src/image-budget.ts): all
// of a message's images together fit a sealed hub command, the first of several cannot take the whole budget, and a
// resize keeps the picture's shape and never enlarges it.
import { test } from "node:test";
import assert from "node:assert/strict";

const { IMAGE_BUDGET, MAX_IMAGES, SHRINK_STEPS, fitEdge, roomLeft, shareFor } = await import("../mobile/src/image-budget.ts");
const { MAX_SEALED_BYTES } = await import("../src/hub/seal.ts");

test("every image of a message together leaves room in a sealed command for the text and the envelope", () => {
    // base64 is already in the data URL's length; what is left covers the text, the JSON and the seal.
    assert.ok(IMAGE_BUDGET <= MAX_SEALED_BYTES * 0.65, `${IMAGE_BUDGET} of ${MAX_SEALED_BYTES}`);
    assert.ok(MAX_IMAGES >= 1);
});

test("the room left shrinks with each image, never below nothing", () => {
    assert.equal(roomLeft([]), IMAGE_BUDGET);
    assert.equal(roomLeft(["x".repeat(1000)]), IMAGE_BUDGET - 1000);
    assert.equal(roomLeft(["x".repeat(IMAGE_BUDGET + 5)]), 0);
});

test("several images picked at once share what is left evenly: the first cannot take it all", () => {
    assert.equal(shareFor([], 4), Math.floor(IMAGE_BUDGET / 4));
    assert.equal(shareFor(["x".repeat(40_000)], 2), Math.floor((IMAGE_BUDGET - 40_000) / 2));
    assert.equal(shareFor([], 0), IMAGE_BUDGET, "a count of none is one");
});

test("a resize keeps the shape, fits the longest edge, and never enlarges a small image", () => {
    assert.deepEqual(fitEdge(4032, 3024, 1568), { width: 1568, height: 1176 });
    assert.deepEqual(fitEdge(3024, 4032, 1568), { width: 1176, height: 1568 });
    assert.deepEqual(fitEdge(800, 600, 1568), { width: 800, height: 600 });
});

test("each shrink step is smaller than the last, in edge and in quality", () => {
    for (let i = 1; i < SHRINK_STEPS.length; i++) {
        assert.ok(SHRINK_STEPS[i].edge < SHRINK_STEPS[i - 1].edge);
        assert.ok(SHRINK_STEPS[i].quality <= SHRINK_STEPS[i - 1].quality);
    }
});
