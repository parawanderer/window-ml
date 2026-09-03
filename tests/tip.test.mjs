"use strict";
// Where a cursor-following tip goes. Pure, so the edge behaviour is testable without a browser — and it needs
// testing, because each hand-rolled variant got a different edge wrong: one clamped instead of flipping and
// landed under the pointer, another never flipped horizontally and was cut off by the window.
import { test } from "node:test";
import assert from "node:assert";
const { tipStyle, TIP_GAP, TIP_ABOVE, TIP_BELOW } = await import("../src/sidebar/tip.ts");

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

// The side used to be chosen by "past the middle, flip", which says nothing about whether the tooltip FITS:
// at the centre of a 360px panel a 190px tip still ran off the right edge. With a measured size the contract
// is the real one — fully inside the bounds, and never covering the cursor.
test("tipStyle: a measured tip stays inside the bounds and off the cursor, wherever it is", () => {
    const size = { w: 190, h: 40 };
    const W = 360, H = 800;
    /** Resolve a style back into a box, the way the browser would. */
    const boxOf = (st) => {
        const top = parseInt(st.top, 10);
        const left = st.left !== "auto" ? parseInt(st.left, 10) : W - parseInt(st.right, 10) - size.w;
        return { left, top, right: left + size.w, bottom: top + size.h };
    };
    for (const x of [0, 5, 90, 170, 180, 200, 300, 355, 360]) {
        for (const y of [0, 8, 40, 300, 700, 795, 800]) {
            const b = boxOf(tipStyle({ x, y, w: W, h: H }, size));
            assert.ok(b.left >= 0 && b.right <= W, `(${x},${y}) runs off the side: ${JSON.stringify(b)}`);
            assert.ok(b.top >= 0 && b.bottom <= H, `(${x},${y}) runs off the top or bottom: ${JSON.stringify(b)}`);
            const covers = x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
            assert.ok(!covers, `(${x},${y}) sits under the cursor: ${JSON.stringify(b)}`);
        }
    }
    // With room, it stays on the natural side rather than flipping for no reason — a flip nobody needs is a
    // jump under the hand.
    assert.equal(tipStyle({ x: 700, y: 300, w: 1400, h: 800 }, size).left, "710px");
    // Without a measurement it falls back to the old heuristic, which is all it can do.
    assert.equal(tipStyle({ x: 170, y: 300, w: 360 }).left, "180px");
});
