"use strict";
// Standalone tests for the queryAll selector engine (dom.ts): the `>>>` hop crossing, the extended
// pseudos (:contains / :has-text / :eq / text=), and — the reason this got rewritten — the
// COMBINATOR-AWARE evaluation so `:contains` works on ANY step, not just the last element.
//
// dom.ts references the GLOBAL `document`, so we point it at a jsdom document before each call. queryAll
// reads the global at call time, so swapping globalThis.document between cases is enough.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { queryAll } from "../dom.ts";

/** Boot a jsdom document and install it as the global queryAll reads. Returns the document. */
function mount(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    // jsdom lacks innerText; alias to textContent so text filters behave like the browser.
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, configurable: true });
    return dom.window.document;
}
const ids = els => els.map(e => e.id || e.tagName.toLowerCase()).join(",");

// ---------------------------------------------------------------- native (unchanged) path ---

test("plain CSS selector — native path, unchanged", () => {
    mount(`<div class="card" id="a"></div><div class="card" id="b"></div><span id="c"></span>`);
    assert.equal(ids(queryAll(".card")), "a,b");
    assert.equal(ids(queryAll("span")), "c");
    assert.equal(queryAll(".nope").length, 0);
});

test("an INVALID selector THROWS (tools report it) — not a silent []", () => {
    mount(`<div></div>`);
    assert.throws(() => queryAll("div::::"), /./);
});

test("native :nth-of-type fallback (positional pick when nothing matched natively)", () => {
    mount(`<ul><li id="x"></li><li id="y"></li><li id="z"></li></ul>`);
    // li:nth-of-type(2) is valid CSS and matches natively — sanity.
    assert.equal(ids(queryAll("li:nth-of-type(2)")), "y");
});

// ---------------------------------------------------------------- :contains / :eq / text= ---

test(":contains on the LAST element of a compound", () => {
    mount(`<div class="row"><span id="a">hello world</span></div><div class="row"><span id="b">goodbye</span></div>`);
    assert.equal(ids(queryAll('span:contains("world")')), "a");
    assert.equal(ids(queryAll('span:contains("WORLD")')), "a", "case-insensitive");
    assert.equal(queryAll('span:contains("nope")').length, 0);
});

test(":has-text is an alias for :contains", () => {
    mount(`<button id="a">Save</button><button id="b">Cancel</button>`);
    assert.equal(ids(queryAll('button:has-text("Save")')), "a");
});

test(":eq(n) positional pick", () => {
    mount(`<li class="i" id="a"></li><li class="i" id="b"></li><li class="i" id="c"></li>`);
    assert.equal(ids(queryAll(".i:eq(0)")), "a");
    assert.equal(ids(queryAll(".i:eq(2)")), "c");
    assert.equal(queryAll(".i:eq(9)").length, 0);
});

test("text= engine matches the smallest carrier (deepest)", () => {
    mount(`<div id="outer">wrap <span id="inner">Click me</span></div>`);
    // both #outer and #inner contain "Click me"; text= keeps the leaf.
    assert.equal(ids(queryAll('text="Click me"')), "inner");
});

// ------------------------------------------------------- COMBINATOR-AWARE :contains (the fix) ---

test(":contains on a NON-final step: div:contains(foo) span:contains(bar)", () => {
    mount(`
        <div class="box" id="d1">foo <span id="s1">bar target</span><span id="s2">other</span></div>
        <div class="box" id="d2">nope <span id="s3">bar decoy</span></div>
    `);
    // spans-with-"bar" that live inside divs-with-"foo" → only s1 (d2 lacks "foo").
    assert.equal(ids(queryAll('div:contains("foo") span:contains("bar")')), "s1");
});

test("child combinator with :contains on the parent step", () => {
    mount(`
        <ul class="menu" id="m1">apple<li id="l1">go</li></ul>
        <ul class="menu" id="m2">banana<li id="l2">go</li></ul>
    `);
    // direct-child li of a .menu whose text contains "banana" → l2 only.
    assert.equal(ids(queryAll('ul:contains("banana") > li')), "l2");
});

test("combinator + :contains does NOT collapse to a single element (regression guard)", () => {
    // The OLD peel turned `A:contains(x) B` into just `A` (dropping B). Assert B is honored.
    mount(`<section id="sec">keyword <article id="art">body</article></section>`);
    assert.equal(ids(queryAll('section:contains("keyword") article')), "art");
});

test("mid-compound :contains no longer throws a raw SyntaxError", () => {
    mount(`<div>x <p id="p">y</p></div>`);
    assert.doesNotThrow(() => queryAll('div:contains("x") p:contains("y")'));
    assert.equal(ids(queryAll('div:contains("x") p:contains("y")')), "p");
});

// ------------------------------------------------------------------- >>> shadow / iframe hops ---

test(">>> crosses an OPEN shadow root", () => {
    const doc = mount(`<my-widget id="host"></my-widget>`);
    const host = doc.getElementById("host");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="ok">OK</button><button id="cancel">Cancel</button>`;
    const els = queryAll("#host >>> button");
    assert.equal(els.length, 2);
});

test(">>> hop carries its OWN :contains (the run-log bug: it was silently dropped before)", () => {
    const doc = mount(`<my-widget id="host"></my-widget>`);
    const root = doc.getElementById("host").attachShadow({ mode: "open" });
    root.innerHTML = `<span id="a">Same-origin secret: 1234</span><span id="b">unrelated</span>`;
    const els = queryAll('#host >>> span:contains("secret")');
    assert.equal(els.length, 1);
    assert.equal(els[0].textContent.includes("secret"), true);
});

test("Playwright forms PIERCE a same-origin iframe with NO explicit >>> (deepQueryAll crosses it)", () => {
    const dom = new JSDOM(`<!doctype html><body><h1 id="decoy">outer secret decoy</h1><iframe id="f"></iframe></body>`);
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, configurable: true });
    const ifr = dom.window.document.getElementById("f");
    if (!ifr.contentDocument) { console.log("jsdom: no iframe contentDocument — skipping"); return; }
    ifr.contentDocument.body.innerHTML = `<span id="inner">Same-origin secret: 1234</span>`;
    // span:contains("secret") (no >>>) finds the one INSIDE the iframe; the h1 decoy isn't a <span>.
    assert.deepEqual(queryAll('span:contains("secret")').map(e => e.id), ["inner"]);
    // and the explicit >>> hop resolves the same element.
    assert.deepEqual(queryAll('#f >>> span:contains("secret")').map(e => e.id), ["inner"]);
});

test(":contains on the INNER >>> hop filters after crossing the boundary", () => {
    const doc = mount(`<x-a id="h1"></x-a><x-a id="h2"></x-a>`);
    for (const [id, label] of [["h1", "alpha"], ["h2", "beta"]]) {
        const r = doc.getElementById(id).attachShadow({ mode: "open" });
        r.innerHTML = `<button id="btn-${id}">${label} go</button>`;
    }
    // cross into every x-a's shadow, then keep only the button whose text contains "beta".
    assert.equal(ids(queryAll('x-a >>> button:contains("beta")')), "btn-h2");
    assert.equal(ids(queryAll('x-a >>> button:contains("go")')), "btn-h1,btn-h2");
});

// ------------------------------------------------------------ role= / label= engines (a11y) ---

test("role= matches native tags AND aria-role widgets", () => {
    mount(`<button id="native">Save</button><div role="button" id="widget">Cancel</div><a id="lnk" href="#">go</a>`);
    assert.deepEqual(queryAll('role=button').map(e => e.id).sort(), ["native", "widget"]);   // <a> is a link, not a button
});

test("role= with [name=...] filters by accessible name (case-insensitive substring)", () => {
    mount(`<button id="a">Save changes</button><button id="b">Cancel</button>`);
    assert.deepEqual(queryAll('role=button[name="save"]').map(e => e.id), ["a"]);
    assert.equal(queryAll('role=button[name="nope"]').length, 0);
});

test("role=heading[level=N] (implicit role + aria-level)", () => {
    mount(`<h1 id="h1">Title</h1><h2 id="h2">Sub</h2><div role="heading" aria-level="1" id="hx">Aria</div>`);
    assert.deepEqual(queryAll('role=heading[level=1]').map(e => e.id).sort(), ["h1", "hx"]);
    assert.deepEqual(queryAll('role=heading[level=2]').map(e => e.id), ["h2"]);
});

test("role=checkbox[checked] boolean state (native + aria)", () => {
    mount(`<input type="checkbox" id="on" checked><input type="checkbox" id="off"><div role="checkbox" aria-checked="true" id="aria">x</div>`);
    assert.deepEqual(queryAll('role=checkbox[checked]').map(e => e.id).sort(), ["aria", "on"]);
});

test("label= finds a control by its accessible name (wrapping label / aria-label)", () => {
    mount(`<label>Username <input id="u"></label><label>Password <input id="p"></label><input id="bare" aria-label="Search box">`);
    assert.deepEqual(queryAll('label="Username"').map(e => e.id), ["u"]);
    assert.deepEqual(queryAll('label=Search').map(e => e.id), ["bare"]);
});

test("role= / label= pierce a same-origin iframe with no explicit >>>", () => {
    const dom = new JSDOM(`<!doctype html><body><iframe id="f"></iframe></body>`);
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const ifr = dom.window.document.getElementById("f");
    if (!ifr.contentDocument) { console.log("jsdom: no iframe contentDocument — skipping"); return; }
    ifr.contentDocument.body.innerHTML = `<button id="inner">Reveal</button>`;
    assert.deepEqual(queryAll('role=button[name="Reveal"]').map(e => e.id), ["inner"]);
});
