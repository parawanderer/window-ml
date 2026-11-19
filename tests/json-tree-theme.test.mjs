// json-tree-theme.test.mjs — the JSON tree draws every kind of value in the same highlight.js token classes as the text view
// of the same JSON, so a code theme colours the two alike.

import { test, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, JsonNode, hljs, doc, host;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    doc = dom.window.document;
    Object.assign(globalThis, { window: dom.window, document: doc, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter });
    host = doc.getElementById("root");
    ({ h, render } = require_("preact"));
    ({ JsonNode } = await import("../src/sidebar/transcript/json-tree.tsx"));
    hljs = require_("highlight.js/lib/core");
    hljs.registerLanguage("json", require_("highlight.js/lib/languages/json"));
});

/** The `hljs-*` classes from a value's outermost token down to the one holding its text: what a theme's rules would meet. */
const chain = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1; n = [...n.children].find((c) => c.className.includes("hljs-") && !/comma|punctuation/.test(c.className))) {
        out.push(...[...n.classList].filter((c) => c.startsWith("hljs-")));
    }
    return out;
};

// --- every kind of primitive, as the text view draws it ---
test("each primitive in the tree carries the token classes highlight.js gives it in the text view, nesting included", async () => {
    const value = { str: "text", num: 12, neg: -1.5, yes: true, no: false, none: null };
    render(h(JsonNode, { v: value, defaultOpen: true }), host);
    await new Promise((r) => setTimeout(r, 40));
    const text = doc.createElement("div");
    text.innerHTML = hljs.highlight(JSON.stringify(value), { language: "json" }).value;
    for (const [key, v] of Object.entries(value)) {
        const treeVal = [...host.querySelectorAll(".jt-row")].find((r) => r.querySelector(".jt-key-text")?.textContent === JSON.stringify(key)).querySelector(".jt-val");
        // The text view's span for this value: the one right after this key's colon.
        const keySpan = [...text.querySelectorAll(".hljs-attr")].find((s) => s.textContent === JSON.stringify(key));
        const textVal = keySpan.nextElementSibling.nextElementSibling;
        assert.deepEqual(chain(treeVal), chain(textVal), `${key} (${JSON.stringify(v)}): the tree's classes ${JSON.stringify(chain(treeVal))}, the text's ${JSON.stringify(chain(textVal))}`);
    }
    render(null, host);
});

test("the literal and its keyword are both there for true and null (the inner one is what a theme colours)", async () => {
    render(h(JsonNode, { v: { a: true, b: null }, defaultOpen: true }), host);
    await new Promise((r) => setTimeout(r, 40));
    for (const w of ["true", "null"]) {
        const inner = [...host.querySelectorAll(".jt-val .hljs-keyword")].find((e) => e.textContent === w);
        assert.ok(inner, `${w}: an inner hljs-keyword`);
        assert.ok(inner.parentElement.classList.contains("hljs-literal"), `${w}: inside an hljs-literal`);
    }
    render(null, host);
});
