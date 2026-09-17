// The table view's column summary (src/table-summary.ts): per-column counts and a kind-appropriate description.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeColumns, summarizeRows, HIST_BINS } from "../src/table-summary.ts";

test("numeric column: range, mean and a histogram whose counts add up to the non-null values", () => {
    const [s] = summarizeColumns(["n"], [[1, 2, 3, 4, null, 100]], { n: "float64" });
    assert.deepEqual([s.count, s.nulls, s.distinct], [5, 1, 5]);
    assert.deepEqual([s.numeric.min, s.numeric.max, s.numeric.mean], [1, 100, 22]);
    assert.equal(s.numeric.hist.length, HIST_BINS);
    assert.equal(s.numeric.hist.reduce((a, b) => a + b, 0), 5);
    assert.equal(s.numeric.hist[HIST_BINS - 1], 1, "the maximum lands in the last bucket, not past it");
    const [flat] = summarizeColumns(["c"], [[7, 7, 7]], { c: "int64" });
    assert.equal(flat.numeric.hist[0], 3, "a constant column has no span: every value in the first bucket");
});

test("object column: the most frequent values, ties broken by name, and the share they cover; the empty string is null", () => {
    const [s] = summarizeColumns(["r"], [["north", "south", "north", "", "east", "west", "north", "south"]], { r: "str" });
    assert.deepEqual([s.count, s.nulls, s.distinct], [7, 1, 4]);
    assert.deepEqual(s.top, [{ value: "north", count: 3 }, { value: "south", count: 2 }, { value: "east", count: 1 }]);
    assert.equal(s.topShare, 6 / 7);
    assert.equal(s.numeric, undefined);
});

test("bool column: the split; a column with no dtype is numeric only when every value is a number", () => {
    const [b] = summarizeColumns(["ok"], [[true, false, true, null]], { ok: "bool" });
    assert.deepEqual(b.bool, { true: 2, false: 1 });
    const [guessNum, guessObj] = summarizeRows(["a", "b"], [[1, "x"], [2, 3]]);
    assert.equal(guessNum.dtype, "float64");
    assert.ok(guessNum.numeric);
    assert.equal(guessObj.dtype, "object", "one string makes it an object column");
    assert.deepEqual(guessObj.top.map((t) => t.value), ["3", "x"]);
});
