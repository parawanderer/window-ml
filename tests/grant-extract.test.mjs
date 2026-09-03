// grant-extract.test.mjs — button #3's static egress extraction. It must find the LITERAL ml.fetch URLs a
// human would see (so "remember" persists exactly those) and skip everything dynamic (a URL the human never
// saw can't be remembered). Pure + chrome-free — imported straight from source via tsx.

import test from "node:test";
import assert from "node:assert/strict";
import { extractGrants, fetchUrlLiterals } from "../src/grant-extract.ts";

test("extracts ml.fetch string literals from exec", () => {
    const grants = extractGrants("exec", { js: `const a = await ml.fetch("https://x.test/data.json"); a.text` });
    assert.deepEqual(grants, [{ kind: "fetch-url", urls: ["https://x.test/data.json"] }]);
});

test("window.ml.fetch and quasi-only template literals count", () => {
    assert.deepEqual(fetchUrlLiterals("window.ml.fetch(`https://a.test/b`)"), ["https://a.test/b"]);
    assert.deepEqual(fetchUrlLiterals("ml.fetch('https://a.test/c')"), ["https://a.test/c"]);
});

test("dynamic targets are NOT persistable (variable, interpolated template, member)", () => {
    assert.deepEqual(fetchUrlLiterals("ml.fetch(url)"), []);
    assert.deepEqual(fetchUrlLiterals("ml.fetch(`https://a.test/${id}`)"), []);
    assert.deepEqual(fetchUrlLiterals("ml.fetch(cfg.url)"), []);
    assert.deepEqual(extractGrants("exec", { js: "ml.fetch(paths[0])" }), []);
});

test("multiple + de-duplicated, in source order", () => {
    const js = `ml.fetch("https://a.test/1"); ml.fetch("https://a.test/2"); ml.fetch("https://a.test/1")`;
    assert.deepEqual(fetchUrlLiterals(js), ["https://a.test/1", "https://a.test/2"]);
});

test("ml.fetch inside a string or comment is NOT a call (real parser, not regex)", () => {
    assert.deepEqual(fetchUrlLiterals(`const s = 'ml.fetch("https://evil.test/x")'; s`), []);
    assert.deepEqual(fetchUrlLiterals(`// ml.fetch("https://evil.test/y")\n1`), []);
});

test("a DIFFERENT .fetch (not ml/window.ml) is ignored", () => {
    assert.deepEqual(fetchUrlLiterals(`fetch("https://a.test/raw"); other.fetch("https://a.test/z")`), []);
    assert.deepEqual(fetchUrlLiterals(`api.ml.fetch("https://a.test/no")`), []);   // obj.ml.fetch where obj≠window
});

test("unparseable code yields no grants (falls through to one-off)", () => {
    assert.deepEqual(fetchUrlLiterals("this is (not js"), []);
    assert.deepEqual(extractGrants("exec", { js: "@@@" }), []);
});

test("unknown tool → no extractor → []", () => {
    assert.deepEqual(extractGrants("click", { selector: "#x" }), []);
    assert.deepEqual(extractGrants("exec", {}), []);   // no js arg
});
