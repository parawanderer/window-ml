"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { JSDOM } = require("jsdom");
const { evalReadonly, NotInDialect, Denied } = require("../dist/readonly-exec.js");

function world() {
    const dom = new JSDOM(`<!doctype html><body>
      <input placeholder="Ask Gemini" id="a" class="x">
      <textarea aria-label="Ask Gemini please" id="b"></textarea>
      <div contenteditable="true" id="c">hello Ask Gemini world</div>
      <input placeholder="other" id="d">
    </body>`);
    // jsdom doesn't implement innerText — alias it to textContent so the canonical
    // survey (which reads el.innerText) runs verbatim.
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
        get() { return this.textContent; }, configurable: true,
    });
    return dom.window.document;
}
const run = (js, doc = world()) => evalReadonly(js, doc);

test("canonical survey #1 (querySelectorAll → filter → map) returns the summary", () => {
    const js = `Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
      .filter(el => el.placeholder === 'Ask Gemini'
                 || el.innerText.includes('Ask Gemini')
                 || el.getAttribute('aria-label')?.includes('Ask Gemini'))
      .map(el => ({ tagName: el.tagName, id: el.id, className: el.className, outerHTML: el.outerHTML.slice(0, 100) }))`;
    const { value } = run(js);
    const ids = value.map(v => v.id).sort();
    // a: placeholder match · b: aria-label match · c: innerText contains "Ask Gemini"
    assert.deepEqual(ids, ["a", "b", "c"]);
    assert.equal(value.find(v => v.id === "a").tagName, "INPUT");
    assert.ok(value.find(v => v.id === "a").outerHTML.startsWith("<input"));
});

test("canonical survey #2 (contenteditable/textarea) returns the summary", () => {
    const js = `Array.from(document.querySelectorAll("div, textarea"))
      .filter(el => el.getAttribute("contenteditable") === "true" || el.tagName === "TEXTAREA")
      .map(el => ({ selector: el.outerHTML.slice(0, 100), tag: el.tagName }))`;
    const tags = run(js).value.map(v => v.tag).sort();
    assert.deepEqual(tags, ["DIV", "TEXTAREA"]);
});

test("pure computation: arrows, ternary, optional chaining, template-free literals", () => {
    assert.equal(run("[1,2,3,4].map(x => x*2).filter(x => x > 4).reduce((a,b) => a+b, 0)").value, 14);
    assert.equal(run("const n = 5; n > 3 ? 'big' : 'small'").value, "big");
    assert.deepEqual(run("({ a: 1, b: [2, 3], c: 'x'.toUpperCase() })").value, { a: 1, b: [2, 3], c: "X" });
    assert.equal(run("null?.foo").value, undefined);
});

test("captures console output alongside the value", () => {
    const { value, logs } = run("console.log('n:', [1,2].length); [1,2].length");
    assert.equal(value, 2);
    assert.deepEqual(logs, ["n: 2"]);
});

// --- the security surface: every one of these must throw (→ caller falls back) ---
const ESCAPES = {
    "node → window → fetch": `document.querySelectorAll("input")[0].ownerDocument.defaultView.fetch("/x")`,
    "constructor → Function": `({}).constructor.constructor("return fetch")()`,
    "computed owner-document": `document.querySelectorAll("input")[0]["owner" + "Document"]`,
    "__proto__ access": `({}).__proto__`,
    "bare fetch": `fetch("/x")`,
    "window global": `window.location`,
    "self global": `self.fetch`,
    "setAttribute (mutation)": `document.body.setAttribute("x", "y")`,
    "innerHTML assign": `document.body.innerHTML = "x"`,
    "click (effect)": `document.querySelector("input").click()`,
    "method as value": `const g = document.body.getAttribute; g("x")`,
};
for (const [name, js] of Object.entries(ESCAPES)) {
    test(`blocked: ${name}`, () => {
        assert.throws(() => run(js), e => e instanceof NotInDialect || e instanceof Denied,
            `"${name}" must be rejected, not executed`);
    });
}

// --- out-of-dialect syntax must throw NotInDialect (fail closed, not crash) ---
const OUT = {
    "for loop": `for (const x of []) { x }`,
    "function expression": `(function(){ return 1 })()`,
    "assignment": `let x = 1; x = 2; x`,
    "new": `new Object()`,
    "template literal": "`hi ${1}`",
};
for (const [name, js] of Object.entries(OUT)) {
    test(`falls back (NotInDialect): ${name}`, () => {
        assert.throws(() => run(js), e => e instanceof NotInDialect || e instanceof Denied);
    });
}
