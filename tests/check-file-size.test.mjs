// The file-size ratchet's decision (scripts/check-file-size.mjs `decide`): which grown oversized files SPEAK
// and which are only named. The rule is in the script's header, "WHY THE RATCHET ALSO READS COST": a file
// speaks when it crossed 800 lines in this change (or is new), grew by 25 or more, or carries 5% or more of
// the repo's edit cost. Every case below is one side of one threshold.
import { test } from "node:test";
import assert from "node:assert";
import { decide } from "../scripts/check-file-size.mjs";

const one = (f, share) => {
    const shares = new Map(share === undefined ? [] : [[f.path, share]]);
    const { speak, quiet } = decide([f], shares);
    assert.strictEqual(speak.length + quiet.length, 1);
    return speak.length ? "speak" : "quiet";
};

// --- crossing the limit, or arriving over it ---

test("a file that crosses the limit in this change speaks, however small the step", () => {
    assert.strictEqual(one({ path: "src/a.ts", before: 800, now: 801 }, 0), "speak");
});

test("a NEW oversized file speaks", () => {
    assert.strictEqual(one({ path: "src/a.ts", before: 0, now: 900 }, 0), "speak");
});

// --- growth of an already oversized file ---

test("an oversized file grown by 24 lines with a cold share stays quiet", () => {
    assert.strictEqual(one({ path: "src/a.ts", before: 2000, now: 2024 }, 0.049), "quiet");
});

test("an oversized file grown by exactly 25 lines speaks", () => {
    assert.strictEqual(one({ path: "src/a.ts", before: 2000, now: 2025 }, 0), "speak");
});

// --- share of the repo's edit cost ---

test("a hot file (5% of the cost or more) speaks for a single added line", () => {
    assert.strictEqual(one({ path: "src/a.ts", before: 2000, now: 2001 }, 0.05), "speak");
});

test("no history: an absent share counts as 0 and the growth rule decides alone", () => {
    assert.strictEqual(one({ path: "src/a.ts", before: 2000, now: 2005 }), "quiet");
    assert.strictEqual(one({ path: "src/a.ts", before: 2000, now: 2030 }), "speak");
});

test("every item comes back carrying its share, and a mixed list is split, not reordered", () => {
    const grown = [
        { path: "src/hot.ts", before: 2300, now: 2301 },
        { path: "src/cold.ts", before: 2000, now: 2005 },
        { path: "src/big.ts", before: 1000, now: 1030 },
        { path: "src/cold2.ts", before: 900, now: 903 },
    ];
    const { speak, quiet } = decide(grown, new Map([["src/hot.ts", 0.13], ["src/cold.ts", 0.041]]));
    assert.deepStrictEqual(speak.map((f) => [f.path, f.share]), [["src/hot.ts", 0.13], ["src/big.ts", 0]]);
    assert.deepStrictEqual(quiet.map((f) => [f.path, f.share]), [["src/cold.ts", 0.041], ["src/cold2.ts", 0]]);
});
