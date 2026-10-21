// live-call-reveal.test.mjs — the pace a live call's code is typed out at (reveal.ts): never ahead of what arrived,
// caught up within about one gap between arrivals, and shown at once whenever typing it out would only cost or lag.
import { test } from "node:test";
import assert from "node:assert";
import { REVEAL, advance, nextGap, revealJumps, revealRate, tickDelay } from "../src/sidebar/transcript/reveal.ts";

// --- the pace: even between arrivals, drained within one gap, never past what arrived ---

test("advance never passes what arrived, and always moves at least one character while behind", () => {
    for (const target of [0, 1, 5, 300, 4000])
        for (const shown of [0, 1, Math.floor(target / 2), target])
            for (const rate of [0, 0.001, 1, 50])
                for (const dt of [0, 16, 90, 1000]) {
                    const next = advance(Math.min(shown, target), target, rate, dt);
                    assert.ok(next <= target, `past the text: ${next} > ${target}`);
                    if (shown < target) assert.ok(next > shown, "behind, so it moves");
                }
});

test("a burst is shown in full after one gap at the rate set for it, at an even speed", () => {
    for (const gap of [REVEAL.minGapMs, 90, 200, REVEAL.maxGapMs])
        for (const backlog of [1, 40, 900, REVEAL.jumpChars]) {
            const rate = revealRate(backlog, gap);
            let shown = 0, ticks = 0;
            for (let t = 0; t < gap && shown < backlog; t += REVEAL.frameMs, ticks++) shown = advance(shown, backlog, rate, REVEAL.frameMs);
            shown = advance(shown, backlog, rate, gap - ticks * REVEAL.frameMs);
            assert.equal(shown, backlog, `gap ${gap}, backlog ${backlog}`);
        }
    assert.equal(revealRate(-5, 90), 0, "nothing behind, nothing to show");
});

test("the gap is smoothed and held to its bounds, so one late burst does not stall the pace", () => {
    let gap = 90;
    gap = nextGap(gap, 60_000);
    assert.ok(gap <= REVEAL.maxGapMs, `a long silence does not slow the next reveal to a crawl: ${gap}`);
    for (let i = 0; i < 50; i++) gap = nextGap(gap, 1);
    assert.ok(Math.abs(gap - REVEAL.minGapMs) < 1, "a flood settles at the floor");
});

// --- the cost: every frame while cheap, less often as the cell grows ---

test("a cheap render ticks every frame; an expensive one ticks less often, within its share of the thread", () => {
    assert.equal(tickDelay(0), REVEAL.frameMs);
    assert.equal(tickDelay(2), REVEAL.frameMs, "2 ms (about 5k characters of JS) still every frame");
    for (const cost of [5, 12, 27]) assert.ok(cost / tickDelay(cost) <= REVEAL.budgetShare + 1e-9, `cost ${cost}`);
    assert.ok(tickDelay(12) > tickDelay(5));
});

// --- shown at once: whenever typing it out would lag, mislead or cost ---

test("arrived text is typed out only when it extends what is shown, is short enough, cheap and motion is allowed", () => {
    const base = { shownText: "import ma", text: "import math\n", costMs: 1, reduced: false };
    assert.equal(revealJumps(base), false, "the ordinary case: typed out");
    assert.equal(revealJumps({ ...base, reduced: true }), true, "reduced motion");
    assert.equal(revealJumps({ ...base, text: "from x import y" }), true, "the text was replaced: what is shown is not its start");
    assert.equal(revealJumps({ ...base, text: base.shownText + "x".repeat(REVEAL.jumpChars + 1) }), true, "a backlog too long to type out");
    assert.equal(revealJumps({ ...base, text: base.shownText + "x".repeat(REVEAL.jumpChars) }), false, "…and at the bound, still typed");
    assert.equal(revealJumps({ ...base, costMs: REVEAL.maxCostMs + 1 }), true, "a render too expensive to repeat");
    assert.equal(revealJumps({ ...base, shownText: "", text: "" }), false, "nothing to show is not a jump");
});
