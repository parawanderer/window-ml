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

// ---- tileOffsets: several track-anchored tips at once (the keyboard reader) ----
const { tileOffsets, TILE_GAP, TILE_EDGE } = await import("../src/sidebar/tip.ts");

// A tip that wants to start at its own track's corner. `h` is measured, because how tall one is depends on how
// many parts the server reported.
const rect = (left, top, { w = 300, h = 200 } = {}) => ({ left, right: left + w, top, height: h });
const VH = 1000;

test("tiling: a tip is not moved when nothing is in its way", () => {
    assert.deepEqual(tileOffsets([rect(20, 30)], VH), [0]);
    // Far enough apart vertically to leave the gap: neither moves.
    assert.deepEqual(tileOffsets([rect(20, 30), rect(20, 30 + 200 + TILE_GAP)], VH), [0, 0]);
});

test("tiling: a tip in the SAME column gives way to the one above it, by exactly what it takes", () => {
    const [a, b] = tileOffsets([rect(20, 30), rect(20, 150)], VH);
    assert.equal(a, 0, "the first one keeps its track's corner");
    assert.equal(b, 30 + 200 + TILE_GAP - 150, "pushed clear of the first and no further");
});

test("tiling: a tip in ANOTHER column is not moved, however much they share vertically", () => {
    // The reported bug: a custom layout side by side. The two tips start at the same height, in columns that
    // do not touch, and the right-hand one was pushed a full tip's height down the window.
    assert.deepEqual(tileOffsets([rect(20, 30), rect(400, 30)], VH), [0, 0]);
    // Touching at the edge is still not overlapping: right === left.
    assert.deepEqual(tileOffsets([rect(20, 30), rect(320, 30)], VH), [0, 0]);
    // One pixel of genuine overlap, and it gives way again.
    const [, dy] = tileOffsets([rect(20, 30), rect(319, 30)], VH);
    assert.equal(dy, 30 + 200 + TILE_GAP - 30);
});

test("tiling: a tip clears EVERY placed tip it overlaps, not only the previous one", () => {
    // A grid: two columns, then a wide tip underneath spanning both. The one before it is the SHORTER of the
    // two, so a rule that looked only backwards would leave it sitting on the taller one.
    const tall = rect(20, 30, { h: 300 }), short = rect(400, 30, { h: 100 });
    const wide = rect(20, 60, { w: 700 });
    const [, , dy] = tileOffsets([tall, short, wide], VH);
    assert.equal(dy, 30 + 300 + TILE_GAP - 60, "cleared the TALLER of the two it overlaps");
});

test("tiling: the window wins — a tip is pulled back up rather than pushed off the bottom", () => {
    const [, dy] = tileOffsets([rect(20, 400, { h: 400 }), rect(20, 500, { h: 400 })], VH);
    assert.equal(500 + 400 + dy, VH - TILE_EDGE, "its bottom sits at the edge inset, not past it");
    // A tip taller than the window is pinned at the top rather than scrolled off it.
    const [only] = tileOffsets([rect(20, 300, { h: 1200 })], VH);
    assert.equal(300 + only, TILE_EDGE);
});

test("tiling: order is preserved and a track with no tip leaves a real gap", () => {
    // Three tracks, the middle one silent. The third still wants its own track's corner, and nothing pulled it
    // up into the empty space — which is what makes the top tip readable as the top track's.
    const [a, b] = tileOffsets([rect(20, 30, { h: 60 }), rect(20, 400, { h: 60 })], VH);
    assert.deepEqual([a, b], [0, 0]);
});
