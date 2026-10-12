// Thinning a run to the columns it is drawn across (resource-decimate.ts): what the memory chart's lines keep of a long
// history, so a hover stays cheap without the picture changing.
import { test } from "node:test";
import assert from "node:assert/strict";

const { m4Indices, m4IndicesMany } = await import("../src/resource/resource-decimate.ts");

/** `n` samples evenly along the run, with values from `f`. */
const run = (n, f) => ({ x: (i) => i / (n - 1), y: (i) => f(i) });

// --- which samples a column keeps ---

test("no more than four samples a column keeps every one, in order", () => {
    const r = run(40, (i) => i % 7);
    assert.deepEqual(m4Indices(40, r.x, r.y, 10), [...Array(40).keys()]);
});

test("a dense run keeps each column's first, lowest, highest and last, at most four a column, in time order", () => {
    const n = 10_000, cols = 100;
    const r = run(n, (i) => Math.sin(i / 37) + (i % 13) / 13);
    const kept = m4Indices(n, r.x, r.y, cols);
    assert.ok(kept.length <= cols * 4, `${kept.length} kept`);
    assert.ok(kept.every((k, j) => j === 0 || k > kept[j - 1]), "strictly increasing");
    assert.equal(kept[0], 0);
    assert.equal(kept.at(-1), n - 1);
    // Per column, the extremes are among the kept samples.
    for (let c = 0; c < cols; c++) {
        const inCol = [...Array(n).keys()].filter((i) => Math.min(cols - 1, Math.floor(r.x(i) * cols)) === c);
        const vals = inCol.map(r.y);
        const keptVals = kept.filter((k) => inCol.includes(k)).map(r.y);
        assert.equal(Math.max(...keptVals), Math.max(...vals), `column ${c} max`);
        assert.equal(Math.min(...keptVals), Math.min(...vals), `column ${c} min`);
    }
});

test("a one-sample spike survives thinning, at its own sample", () => {
    const n = 5000;
    const r = run(n, (i) => (i === 3217 ? 1 : 0.2));
    const kept = m4Indices(n, r.x, r.y, 50);
    assert.ok(kept.includes(3217));
    assert.ok(kept.length < 250);
});

test("a flat run keeps only each column's two ends", () => {
    const n = 4000, cols = 100;
    const r = run(n, () => 0.5);
    assert.ok(m4Indices(n, r.x, r.y, cols).length <= cols * 2);
});

test("fewer than one column still draws the run's two ends", () => {
    const r = run(100, (i) => i);
    const kept = m4Indices(100, r.x, r.y, 0.3);
    assert.equal(kept[0], 0);
    assert.equal(kept.at(-1), 99);
});

test("samples sharing one time (a run of zero width) are one column, not a crash", () => {
    assert.deepEqual(m4Indices(30, () => 0.5, (i) => i % 5, 10), [...Array(30).keys()]);
    const dense = m4Indices(1000, () => 0.5, (i) => (i === 500 ? 9 : i % 5), 10);
    assert.ok(dense.includes(500) && dense.length <= 4);
});

// --- several series on common samples ---

test("several series share one selection holding each series' extremes", () => {
    const n = 3000;
    const a = (i) => (i === 100 ? 5 : 0), b = (i) => (i === 2900 ? -5 : 0);
    const kept = m4IndicesMany(n, (i) => i / (n - 1), [a, b], 30);
    assert.ok(kept.includes(100) && kept.includes(2900));
    assert.ok(kept.every((k, j) => j === 0 || k > kept[j - 1]));
});
