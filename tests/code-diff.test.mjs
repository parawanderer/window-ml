// The diff's rows as the panel draws them (src/sidebar/code-diff.tsx `DiffLines`), shared by a retry's diff in the
// transcript and the bench's Spec card: the two-column gutter, the signs, the elision, highlighting, and text that
// stays text.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, DiffLines, codeDiff, doc;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    ({ DiffLines } = await import("../src/sidebar/code-diff.tsx"));
    ({ codeDiff } = await import("../src/diff.ts"));
});

const show = (props) => { const host = doc.getElementById("root"); render(null, host); render(h(DiffLines, props), host); return host; };
const BEFORE = ["const a = 1;", "const b = 2;", ...[..."cdefghij"].map((v, i) => `const ${v} = ${i + 3};`), "return a;"].join("\n");
const AFTER = BEFORE.replace("const b = 2;", "const b = 20;").replace("return a;", "return a + b;");

// --- the rows and their gutter ---

test("each row carries its old and new line number; an added or removed row leaves the other column blank", () => {
    const host = show({ rows: codeDiff(BEFORE, AFTER), lang: "javascript" });
    const row = (sel) => [...host.querySelectorAll(sel)].map((r) => [...r.querySelectorAll(".dno")].map((n) => n.textContent).concat(r.querySelector(".dsign").textContent, r.querySelector(".dtext").textContent));
    assert.deepEqual(row(".dline-del"), [["2", "", "−", "const b = 2;"], ["11", "", "−", "return a;"]]);
    assert.deepEqual(row(".dline-add"), [["", "2", "+", "const b = 20;"], ["", "11", "+", "return a + b;"]]);
    assert.deepEqual(row(".dline-same")[0], ["1", "1", " ", "const a = 1;"]);
    assert.match(host.querySelector(".dline-gap .dtext").textContent, /^⋮ \d+ unchanged lines$/);
    assert.ok(host.querySelector(".dline-add .hljs-keyword"), "highlighted as the language");
    assert.ok(host.querySelector("pre.code.dlines.numbered > code.hljs"), "a code block's surface");
});

test("without numbers there is no gutter; the frame's class is added to the code block's", () => {
    const host = show({ rows: codeDiff(BEFORE, AFTER), numbers: false, class: "r-diff-body" });
    assert.equal(host.querySelectorAll(".dno").length, 0);
    assert.ok(host.querySelector("pre.code.dlines.r-diff-body:not(.numbered)"));
});

test("a row's text is text: markup in the source is shown, never parsed", () => {
    const host = show({ rows: codeDiff("x", "<img src=x onerror=\"window.__pwned=1\">"), lang: "javascript" });
    assert.equal(host.querySelectorAll("img").length, 0);
    assert.match(host.querySelector(".dline-add .dtext").textContent, /<img src=x/);
});

test("the gutter's rule runs the whole height of a wrapped row, in a diff and in a numbered code block", () => {
    // The rule is a border on the number cell, so the row must stretch it: aligned to the first row, it left a gap
    // in the rule beside every wrapped line.
    const css = readFileSync(new URL("../src/sidebar/sidebar.css", import.meta.url), "utf8");
    assert.match(css, /\.cline \{ display: flex; align-items: stretch; \}/);
    assert.match(css, /\.dline \{ display: flex; align-items: stretch; \}/);
});
