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

// --- a stacked area's samples ---

const { thinStack } = await import("../src/resource/resource-decimate.ts");
const band = (model, bytes) => ({ key: model, label: model, kind: "model", model, bytes });
const free = (bytes) => ({ key: "free", label: "free", kind: "free", bytes });

test("a stack keeps the samples where ANY band's top peaks, so a spike in an upper band is drawn", () => {
    const n = 5000;
    const frames = Array.from({ length: n }, (_, i) => [band("a", 10), band("b", i === 3333 ? 9 : 2), free(100)]);
    const times = frames.map((_, i) => i * 1000);
    const kept = thinStack(frames, times, 40);
    assert.ok(kept.includes(3333), "b's spike, on top of a, survives");
    assert.ok(kept.length <= 40 * 4 * 2, `${kept.length} kept`);
    assert.equal(kept[0], 0);
    assert.equal(kept.at(-1), n - 1);
    assert.ok(kept.every((k, j) => j === 0 || k > kept[j - 1]), "strictly increasing");
});

test("a band appearing and leaving inside a column keeps the samples where it did", () => {
    const n = 4000;
    // c is resident for samples 1500..1520 only: its arrival raises every top above it, its departure drops them.
    const frames = Array.from({ length: n }, (_, i) => [band("a", 10), ...(i >= 1500 && i <= 1520 ? [band("c", 5)] : []), free(100)]);
    const kept = thinStack(frames, frames.map((_, i) => i), 20);
    assert.ok(kept.some((k) => k >= 1500 && k <= 1520), "a sample with c resident is drawn");
    assert.ok(kept.some((k) => k > 1520 && k < 2000) || kept.includes(1999), "and one after it left, in the same column");
});

test("a stack with no more than four samples a column is drawn whole", () => {
    const frames = Array.from({ length: 30 }, (_, i) => [band("a", i), free(100)]);
    assert.deepEqual(thinStack(frames, frames.map((_, i) => i), 10), [...Array(30).keys()]);
});
