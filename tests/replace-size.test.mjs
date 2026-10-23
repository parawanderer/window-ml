// replace-size.test.mjs — the size a String replace builds, counted before the host builds it
// (src/readonly-exec/replace-size.ts): never under what the host builds, and equal to it but for `$n`. The dialect's
// refusals through it are tests/readonly-soundness.test.mjs; sed's are tests/text-pipe.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceSize, replaceWorstCase } from "../src/readonly-exec/replace-size.ts";

const BIG = Number.MAX_SAFE_INTEGER;

// --- the count against what the host builds ------------------------------------------------------------------------

test("the measured size is exactly what the host builds, for every reference, over every kind of match", () => {
    const inputs = ["", "a", "aaaa", "abcabc", "the cat sat on the mat", "a-b-c-", "x".repeat(50) + "y" + "x".repeat(50)];
    const patterns = [/a/g, /a/, /(?:)/g, /(?:)/, /\w+/g, /b/, /-/g, /x+/g, /y$/, /^/g, /t/y, "a", "-", "", "cat"];
    const texts = ["", "Z", "$&", "$`", "$'", "<$&>", "$'$`", "$$", "$$'", "$$$&", "[$&|$`|$']", "$<n>", "$9", "$0", "$1", "$10", "$01"];
    for (const s of inputs) for (const p of patterns) for (const t of texts) for (const g of [true, false]) {
        const isRe = p instanceof RegExp;
        if (isRe && g !== p.global) continue;
        if (isRe) p.lastIndex = 0;
        // Measured first, as the dialect does: the host's replace moves a sticky pattern's lastIndex.
        const { size } = replaceSize(s, p, t, g, BIG);
        const built = isRe ? s.replace(p, t) : g ? s.replaceAll(p, t) : s.replace(p, t);
        assert.equal(size, built.length, `${JSON.stringify(s)}.${g && !isRe ? "replaceAll" : "replace"}(${p}, ${JSON.stringify(t)})`);
    }
});

test("$n, $nn and $<name> are counted as GetSubstitution reads them, captured or not", () => {
    for (const [s, p, t] of [
        ["2026-10-23", /(\d+)-(\d+)-(\d+)/, "$3/$2/$1"],
        ["aaaa", /(?=(a*))/g, "$1"],
        ["in 2026 and 2027", /(?<y>\d{4})/g, "[$<y>|$<z>]"],
        ["ab", /(a)|(b)/g, "$1$2"],
        ["abcdefghijk", /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/, "$11$10$1$12$0$00"],
        ["abc", /(a)/, "$10$2$<a>"],
    ]) assert.equal(replaceSize(s, p, t, p.global, BIG).size, s.replace(p, t).length, `${p} ${t}`);
});

test("an identity rewrite measures as its receiver, which the first version counted four times over", () => {
    const s = "a".repeat(100000);
    assert.equal(replaceSize(s, /a/g, "$&", true, BIG).size, s.length);
    assert.equal(replaceSize(s, /a/, "$&", false, BIG).size, s.length);
    assert.equal(replaceSize("word ".repeat(1000), /\w+/g, "<$&>", true, BIG).size, 7000);
});

// --- the worst case and the stop ----------------------------------------------------------------------------------

test("the worst case is never under the measured size, and counting stops once past the limit", () => {
    for (const [s, p, t] of [["aaaa", /a/g, "$'"], ["abc", /(?:)/g, "<$&$`>"], ["a-b", "-", "$'$`"], ["aaa", /a/, "$&$&"]]) {
        const g = typeof p === "string" ? true : p.global;
        assert.ok(replaceWorstCase(s.length, t, g) >= replaceSize(s, p, t, g, BIG).size, `${p} ${t}`);
    }
    const { size, matches } = replaceSize("a".repeat(30000), /a/g, "$'", true, 1000000);
    assert.ok(size > 1000000 && matches < 100, `stopped at match ${matches}, size ${size}`);
});

test("a sticky RegExp that is not global is measured from its lastIndex, as the host runs it", () => {
    const re = /a/y;
    re.lastIndex = 2;
    assert.equal(replaceSize("bba", re, "$`", false, BIG).size, "bba".replace(Object.assign(/a/y, { lastIndex: 2 }), "$`").length);
});
