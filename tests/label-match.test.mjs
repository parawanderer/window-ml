"use strict";
// Lexical similarity for pointer labels. The strings are short natural phrases the model authored itself,
// and it misremembers them by REWORDING rather than mistyping — which is why the metric choice matters and
// why it is swappable.
import { test } from "node:test";
import assert from "node:assert";
import { editSimilarity, trigramJaccard, tokenSetOverlap, hybridSimilarity, lexicalSimilarity, LEXICAL_METRICS } from "../label-match.ts";

test("each metric has the strength and the blind spot it was chosen for", () => {
    // Token-set is perfect on rewording and reordering; edit distance is close to useless there.
    assert.equal(tokenSetOverlap("sales table", "the table of sales"), 1);
    assert.equal(tokenSetOverlap("q3 payroll", "payroll for q3"), 1);
    assert.ok(editSimilarity("sales table", "the table of sales") < 0.4, "edit distance punishes a word MOVING");
    // …and blind to a typo, where edit distance is the best of the three.
    assert.ok(editSimilarity("the sales table", "the sales tabel") > 0.85);
    assert.ok(tokenSetOverlap("the sales table", "the sales tabel") < 0.5, "a typo makes a different WORD");
    // Trigram is the middle ground: survives both, excels at neither.
    const tri = trigramJaccard("the sales table", "the sales tabel");
    assert.ok(tri > 0.5 && tri < 0.85);
    // All are normalised similarities, and normalisation is case/space-insensitive.
    for (const m of LEXICAL_METRICS) {
        assert.equal(lexicalSimilarity(m, "The  Sales Table", "the sales table"), 1, `${m} should ignore case and spacing`);
        assert.equal(lexicalSimilarity(m, "", ""), 1);
        assert.ok(lexicalSimilarity(m, "abc", "xyz") < 0.5);
    }
});

// The reason hybrid is the default: on the motivating cases NO single metric separates right from wrong, and
// plain edit distance actually INVERTS — it ranks a different table above the correct one reworded.
test("hybrid separates correct matches from wrong ones, where edit distance inverts", () => {
    const CORRECT = [["sales table", "the table of sales"], ["q3 payroll", "payroll for q3"], ["the sales table", "the sales tabel"]];
    const WRONG = [["the sales table", "the revenue table"], ["the sales table", "the pricing table"], ["the sales table", "the dashboard screenshot"]];

    const lowestCorrect = Math.min(...CORRECT.map(([a, b]) => hybridSimilarity(a, b)));
    const highestWrong = Math.max(...WRONG.map(([a, b]) => hybridSimilarity(a, b)));
    assert.ok(lowestCorrect > highestWrong, `hybrid must separate them: ${lowestCorrect} vs ${highestWrong}`);
    assert.ok(lowestCorrect > 0.5 && highestWrong < 0.5, "…with a usable threshold around 0.5");

    // The inversion that motivated all of this: under `edit`, the WRONG table beats the RIGHT one.
    assert.ok(editSimilarity("the sales table", "the pricing table") > editSimilarity("sales table", "the table of sales"),
        "edit distance ranks a different table above the correct one reworded — the bug hybrid exists to avoid");
});

// The drift case is LOW under every lexical metric, correctly — "revenue" and "sales" are lexically
// unrelated. That is precisely the case only a semantic tier can rescue, and why the tiers exist.
test("semantic drift scores low on ALL lexical metrics — the gap embeddings are for", () => {
    for (const m of LEXICAL_METRICS) {
        const score = lexicalSimilarity(m, "the sales table", "the revenue table");
        assert.ok(score < 0.7, `${m} cannot recognise a synonym (${score}) — by design, not by failure`);
    }
});

test("an unknown metric falls back rather than throwing", () => {
    // A stale config value must never break pointer resolution.
    assert.equal(lexicalSimilarity("nonsense", "sales table", "the table of sales"), hybridSimilarity("sales table", "the table of sales"));
    assert.equal(lexicalSimilarity(undefined, "a b", "b a"), hybridSimilarity("a b", "b a"));
});
