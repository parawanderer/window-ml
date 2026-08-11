"use strict";
// Standalone tests for the sidebar markdown renderer (sidebar/format.ts) — the gaps that used to render
// wrong: nested bullets, ordered lists, and `---` thematic breaks. Escapes untrusted model output first.
import { test } from "node:test";
import assert from "node:assert";
import { markdown } from "../sidebar/format.ts";

test("nested bullets build nested <ul> (2-space / tab indent)", () => {
    const html = markdown("- A\n  - A1\n  - A2\n- B");
    assert.equal(html, "<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>");
});

test("ordered list → <ol> (both `1.` and `1)` markers)", () => {
    assert.equal(markdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
    assert.equal(markdown("1) a\n2) b"), "<ol><li>a</li><li>b</li></ol>");
});

test("ordered list nested inside a bullet", () => {
    const html = markdown("- steps:\n  1. first\n  2. second\n- done");
    assert.equal(html, "<ul><li>steps:<ol><li>first</li><li>second</li></ol></li><li>done</li></ul>");
});

test("`+` is a valid bullet", () => {
    assert.equal(markdown("+ x\n+ y"), "<ul><li>x</li><li>y</li></ul>");
});

test("thematic break: ---, ***, ___", () => {
    assert.equal(markdown("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
    assert.equal(markdown("***"), "<hr>");
    assert.equal(markdown("___"), "<hr>");
});

test("a bullet line is NOT mistaken for a thematic break", () => {
    assert.equal(markdown("- item"), "<ul><li>item</li></ul>");
});

test("a hr flushes an open list", () => {
    assert.equal(markdown("- a\n---\n- b"), "<ul><li>a</li></ul><hr><ul><li>b</li></ul>");
});

test("deep nesting closes correctly on dedent", () => {
    const html = markdown("- 1\n  - 1a\n    - 1a-i\n- 2");
    assert.equal(html, "<ul><li>1<ul><li>1a<ul><li>1a-i</li></ul></li></ul></li><li>2</li></ul>");
});
