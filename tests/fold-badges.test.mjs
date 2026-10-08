// fold-badges.test.mjs — which badges a short row folds into its "+N" chip (src/sidebar/resource/fold-badges.tsx): the rule is
// pure, so every case is a list of widths and a room. What a real row does with it is in resource-panel.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

const { foldPlan } = await import("../src/sidebar/resource/fold-badges.tsx");

// The row from the report: kind, quant, ctx, fill, expected rate, RAM cache, phase, deadline.
const ROW = [
    { key: "kind", fold: 2, w: 30 }, { key: "quant", fold: 2, w: 80 }, { key: "ctx", fold: 1, w: 40 }, { key: "kv", fold: 1, w: 50 },
    { key: "expect", fold: 2, w: 150 }, { key: "pcache", fold: 2, w: 180 }, { key: "phase", fold: 0, w: 50 }, { key: "ttl", fold: 0, w: 60 },
];
const total = ROW.reduce((a, b) => a + b.w, 0) + 6 * (ROW.length - 1);
const plan = (room) => [...foldPlan(ROW, room, 6, 24)].sort();

// --- what folds, and in what order ---

test("a row with room folds nothing, and no chip is drawn for it", () => {
    assert.deepEqual(plan(total), []);
    assert.deepEqual(plan(total + 500), []);
});

test("short of room, the first tier folds from the right until the rest and the chip fit", () => {
    // 4px short: the rightmost first-tier badge (the RAM cache) goes, and the chip fits in what it freed.
    assert.deepEqual(plan(total - 4), ["pcache"]);
    // Shorter: the expected rate goes next, then the build, then the kind.
    assert.deepEqual(plan(total - 200), ["expect", "pcache"]);
    assert.deepEqual(plan(total - 400), ["expect", "kind", "pcache", "quant"]);
});

test("the second tier folds only once the first is gone, and live state never folds", () => {
    const all = plan(0);
    assert.deepEqual(all, ["ctx", "expect", "kind", "kv", "pcache", "quant"]);
    assert.ok(!all.includes("phase") && !all.includes("ttl"), "what the runner is doing and its deadline stay");
    // Just past the first tier: the fill goes before the context window, rightmost first.
    const firstTier = 30 + 80 + 150 + 180 + 6 * 4;
    assert.deepEqual(plan(total - firstTier - 10), ["expect", "kind", "kv", "pcache", "quant"]);
});

test("the chip's own width is counted: a fold that frees less than the chip needs folds one more", () => {
    const two = [{ key: "a", fold: 2, w: 10 }, { key: "b", fold: 2, w: 10 }, { key: "c", fold: 0, w: 40 }];
    // 66 wide (10+6+10+6+40), 60 of room: folding "b" leaves 10+6+40 = 56, and the chip (24) needs 6+24 more.
    assert.deepEqual([...foldPlan(two, 60, 6, 24)].sort(), ["a", "b"]);
    assert.deepEqual([...foldPlan(two, 90, 6, 24)].sort(), [], "it all fits");
});
