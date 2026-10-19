// The geometry of dragging a pinned row into a new place (src/chat/pin-order.ts, driven by pin-reorder.ts): where
// it lands, and how far each row stands off its slot on the way. The gesture itself is tested in a browser (tests/e2e/chat-web.spec.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { dropIndex, moved, shifts } from "../src/chat/pin-order.js";

// Three 40px rows, 2px apart, and a taller fourth: rows whose title wraps are taller than the rest.
const slots = [{ top: 0, height: 40 }, { top: 42, height: 40 }, { top: 84, height: 40 }, { top: 126, height: 60 }];

// --- where a dragged row lands ---

test("a row passes another once its leading edge crosses that row's middle, both ways", () => {
    assert.equal(dropIndex(slots, 0, 0), 0);
    assert.equal(dropIndex(slots, 0, 21), 0);   // bottom at 61: not past row 1's middle (62)
    assert.equal(dropIndex(slots, 0, 23), 1);
    assert.equal(dropIndex(slots, 0, 500), 3);
    assert.equal(dropIndex(slots, 3, -60), 2);   // top at 66: above row 2's middle (104), not above row 1's (62)
    assert.equal(dropIndex(slots, 3, -500), 0);
    // A taller row dragged as far as the section lets it (its top on the first row's) still takes the first slot.
    assert.equal(dropIndex([{ top: 0, height: 48 }, { top: 50, height: 49 }], 1, -50), 0);
});

// --- how the rows stand while it moves ---

test("the rows passed move one dragged-row pitch out of the way, and the dragged row ends where its slot starts", () => {
    assert.deepEqual(shifts(slots, 1, 1), [0, 0, 0, 0]);
    // Down past a taller row: its BOTTOM lines up with the bottom of the last row passed.
    assert.deepEqual(shifts(slots, 0, 3), [146, -42, -42, -42]);
    // Up: the row lands at the top of the slot it took, and the tall row pushes the rest down by its own pitch.
    assert.deepEqual(shifts(slots, 3, 1), [0, 62, 62, -84]);
    // After a commit the rows ARE in that order, which `moved` gives.
    assert.deepEqual(moved(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
    assert.deepEqual(moved(["a", "b", "c", "d"], 0, 3), ["b", "c", "d", "a"]);
});
