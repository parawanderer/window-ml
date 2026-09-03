"use strict";
// The vector wrapper. Its whole job is that "how similar are these" cannot be got subtly wrong — the failure
// mode being guarded against is never an exception, it is a plausible-looking number that is meaningless.
import { test } from "node:test";
import assert from "node:assert";
import { Embedding } from "../src/embedding.ts";

test("vectors are normalised on construction, so dot IS cosine", () => {
    // Cosine equals the dot product only for UNIT vectors. Every model measured returns them, which is
    // exactly what invites code to assume it — so the invariant is enforced, not trusted.
    const e = Embedding.from([3, 4]);
    assert.deepEqual(e.values.map((v) => +v.toFixed(4)), [0.6, 0.8]);
    assert.equal(e.dims, 2);
    assert.ok(Math.abs(e.dot(e) - 1) < 1e-12, "a vector is maximally similar to itself");
    // A NON-unit model would otherwise give similarities above 1 — wrong, but never an error.
    const big = Embedding.from([300, 400]);
    assert.ok(Math.abs(big.dot(big) - 1) < 1e-12, "scale is removed, so magnitude cannot inflate a score");
    assert.ok(Math.abs(big.dot(e) - 1) < 1e-12, "…and the same direction scores the same at any magnitude");

    assert.equal(Embedding.from([1, 0]).dot(Embedding.from([0, 1])), 0, "orthogonal");
    assert.equal(Embedding.from([1, 0]).dot(Embedding.from([-1, 0])), -1, "opposite");
    // Already-unit input is kept EXACTLY, so a round trip through this class cannot perturb a real embedding.
    const unit = [0.6, 0.8];
    assert.deepEqual([...Embedding.from(unit).values], unit);
    // Drift must not push a self-comparison past 1.0, or every threshold comparison needs its own guard.
    assert.ok(Embedding.from(Array.from({ length: 768 }, () => 1)).dot(Embedding.from(Array.from({ length: 768 }, () => 1))) <= 1);
});

test("input that cannot be a direction throws, rather than poisoning later comparisons", () => {
    assert.throws(() => Embedding.from([]), /empty vector/);
    assert.throws(() => Embedding.from([0, 0, 0]), /zero-length vector/);
    // A NaN would propagate silently through every dot product it touches.
    assert.throws(() => Embedding.from([1, NaN]), /non-finite value at index 1/);
    assert.throws(() => Embedding.from([1, Infinity]), /non-finite/);
    assert.doesNotThrow(() => Embedding.from(new Float32Array([1, 2, 3])), "typed arrays are fine");
});

test("comparing across MODELS throws instead of returning a meaningless number", () => {
    // 768-dim and 1024-dim vectors are different geometries. A prefix comparison would produce a number no
    // caller could tell was nonsense, so the mismatch is refused at the point it can still be explained.
    const a = Embedding.from(Array.from({ length: 768 }, (_, i) => i + 1));
    const b = Embedding.from(Array.from({ length: 1024 }, (_, i) => i + 1));
    assert.throws(() => a.dot(b), /dimension mismatch \(768 vs 1024\).*different models/s);
});

test("rank returns scores, not just a winner — the guard is the MARGIN", () => {
    const q = Embedding.from([1, 0]);
    const ranked = q.rank([
        { key: "orthogonal", embedding: Embedding.from([0, 1]) },
        { key: "close", embedding: Embedding.from([0.9, 0.1]) },
        { key: "exact", embedding: Embedding.from([1, 0]) },
    ]);
    assert.deepEqual(ranked.map((r) => r.key), ["exact", "close", "orthogonal"], "most similar first");
    assert.ok(Math.abs(ranked[0].score - 1) < 1e-12);
    // Scores are exposed because deciding whether to USE the top hit needs its distance from the runner-up,
    // which a bare winner cannot express.
    assert.ok(ranked[0].score - ranked[1].score > 0, "the margin is computable");
    assert.deepEqual(q.rank([]), [], "nothing to rank is not an error");
});

// The clamp is not defensive: measured over 768 dimensions, accumulated floating-point error drifts a
// self-comparison to +1 + 3.55e-15 and an exactly-opposite pair to -1 - 3.55e-15. Without clamping, every
// caller comparing against a threshold would have to defend against 1.0000000000000002 itself — and a
// similarity outside [-1, 1] is not a number any of them could interpret.
test("cosine stays inside [-1, 1] despite floating-point drift at real dimensionality", () => {
    for (let trial = 0; trial < 200; trial++) {
        const raw = Array.from({ length: 768 }, () => Math.random() * 2 - 1);
        const a = Embedding.from(raw);
        const opposite = Embedding.from(raw.map((v) => -v));
        const self = a.dot(a);
        const anti = a.dot(opposite);
        assert.ok(self <= 1, `self similarity exceeded 1: ${self}`);
        assert.ok(anti >= -1, `opposite similarity fell below -1: ${anti}`);
        // …and still MEANS what it should: the bound is reached, not merely approached.
        assert.ok(self > 0.999999 && anti < -0.999999);
    }
});
