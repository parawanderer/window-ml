// acceptLanguageFrom (contract.ts) — build a browser-style Accept-Language from navigator.languages so an
// ml.fetch looks like the user's own browser. Pure; the background's browserFetchHeaders relies on this shape.
import { test } from "node:test";
import assert from "node:assert";
import { acceptLanguageFrom } from "../src/contract.ts";

test("first language is q=1.0 (bare), the rest descend by 0.1", () => {
    assert.equal(acceptLanguageFrom(["en-US", "en", "fr"]), "en-US,en;q=0.9,fr;q=0.8");
    assert.equal(acceptLanguageFrom(["en-US"]), "en-US");
});

test("dedupes, trims, and drops empties", () => {
    assert.equal(acceptLanguageFrom([" en-US ", "en-US", "", "en"]), "en-US,en;q=0.9");
});

test("empty / missing list → empty string (header omitted)", () => {
    assert.equal(acceptLanguageFrom([]), "");
    assert.equal(acceptLanguageFrom(undefined), "");
});

test("q-weight is floored at 0.1 for long lists (never 0 or negative)", () => {
    const langs = Array.from({ length: 15 }, (_, i) => `l${i}`);
    const out = acceptLanguageFrom(langs);
    assert.ok(!/q=0\.0/.test(out), "never emits q=0.0");
    assert.ok(!/q=-/.test(out), "never emits a negative q");
    assert.ok(out.endsWith("l14;q=0.1"), "tail languages clamp to q=0.1");
});
