"use strict";
// Where a cursor-following tip goes. Pure, so the edge behaviour is testable without a browser — and it needs
// testing, because each hand-rolled variant got a different edge wrong: one clamped instead of flipping and
// landed under the pointer, another never flipped horizontally and was cut off by the window.
import { test } from "node:test";
import assert from "node:assert";
const { tipStyle, TIP_GAP, TIP_ABOVE, TIP_BELOW } = await import("../sidebar/tip.ts");

const W = 400;
const px = (v) => parseFloat(v);

test("horizontal: right of the cursor, flipping left rather than running off the edge", () => {
    const near = tipStyle({ x: 50, y: 100, w: W });
    assert.equal(near.left, `${50 + TIP_GAP}px`, "to the right when there is room");
    assert.equal(near.right, "auto");

    const far = tipStyle({ x: 380, y: 100, w: W });
    assert.equal(far.left, "auto");
    assert.equal(px(far.right), W - 380 + TIP_GAP, "measured from the right edge, so it opens leftward");
    // BOTH are always set, so a previous frame's value can't linger when the tip flips sides.
    for (const s of [near, far]) { assert.ok("left" in s && "right" in s); }
});

test("vertical: above the cursor, flipping BELOW rather than clamping onto it", () => {
    const roomy = tipStyle({ x: 50, y: 100, w: W });
    assert.equal(px(roomy.top), 100 - TIP_ABOVE, "above when there is room");

    // Near the top edge the old code clamped to 2px — which put the tip UNDER the pointer, covering the very
    // thing being described.
    const tight = tipStyle({ x: 50, y: 4, w: W });
    assert.equal(px(tight.top), 4 + TIP_BELOW, "below the cursor instead");
    assert.ok(px(tight.top) > 4, "never on top of the pointer");
});

test("the flip happens past the middle, so the tip always has room to open", () => {
    assert.equal(tipStyle({ x: W * 0.5, y: 50, w: W }).right, "auto", "left half → opens rightward");
    assert.equal(tipStyle({ x: W * 0.9, y: 50, w: W }).left, "auto", "right edge → opens leftward");
    // Even hard against the edge it stays inside the bounds.
    assert.ok(px(tipStyle({ x: W, y: 50, w: W }).right) >= 2);
    assert.ok(px(tipStyle({ x: 0, y: 50, w: W }).left) >= 0);
});
