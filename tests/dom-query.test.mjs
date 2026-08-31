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
import { queryAll, shadowHostReport, firstHopSealed } from "../dom.ts";

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

test(">>> is FORGIVING: with no shadow/iframe boundary it falls back to the host's light subtree", () => {
    // Angular-style EMULATED encapsulation: a custom element that LOOKS like a web component but is light DOM
    // (no shadow root). A model can't tell it apart, so `host >>> inner` must still find the light descendant.
    mount(`<temp-chat-button id="host"><gem-icon-button><button id="btn">Temporary chat</button></gem-icon-button></temp-chat-button>`);
    assert.equal(ids(queryAll("temp-chat-button >>> gem-icon-button")), "gem-icon-button", "light-DOM child found via >>>");
    assert.equal(ids(queryAll("temp-chat-button >>> button")), "btn", "light-DOM descendant found via >>>");
    assert.equal(queryAll("temp-chat-button >>> .nope").length, 0, "still empty when nothing matches");
});
test(">>> prefers a REAL shadow root over the light fallback (unchanged for genuine web components)", () => {
    const doc = mount(`<my-widget id="host"><span id="lightspan">light</span></my-widget>`);
    const root = doc.getElementById("host").attachShadow({ mode: "open" });
    root.innerHTML = `<span id="shadowspan">shadow</span>`;
    // With a shadow root present, >>> steps INTO it (finds the shadow span), not the light one.
    assert.equal(ids(queryAll("#host >>> span")), "shadowspan", "crosses into the shadow root, not the light child");
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

// -------------------------------------------------------- ml.shadowRoots() diagnostic report ---

test("shadowRoots report: open roots counted; hyphenated hosts split into SEALED (renders a box) vs EMPTY", () => {
    const doc = mount(`<x-open id="o"></x-open><x-empty id="e"></x-empty><x-sealed id="s"></x-sealed><x-light id="l">has text</x-light><div id="plain"></div>`);
    doc.getElementById("o").attachShadow({ mode: "open" }).innerHTML = "<span>hi</span>";
    doc.getElementById("s").getBoundingClientRect = () => ({ width: 40, height: 20 });   // jsdom has no layout — force a rendered box
    const r = shadowHostReport(doc);
    const byTag = Object.fromEntries(r.hosts.map(h => [h.tag, h.state]));
    assert.equal(r.open, 1, "one open shadow root");
    assert.equal(byTag["x-open"], "open");
    assert.equal(byTag["x-sealed"], "sealed", "hyphenated + no light content + a rendered box → sealed (a real barrier)");
    assert.equal(byTag["x-empty"], "empty", "hyphenated + no content + no box → empty (an unopened/emulated host, NOT a barrier)");
    assert.ok(!("x-light" in byTag), "a host with light text content is reachable — not flagged");
    assert.ok(!("div" in byTag), "a plain element is never a shadow host");
    assert.equal(r.sealed, 1); assert.equal(r.empty, 1);
    // Each host carries a selector to inspect/locate it.
    assert.ok(r.hosts.every(h => typeof h.selector === "string" && h.selector.length));
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

// ---------------------------------------------------------------- firstHopSealed (CDP trigger) ---
// firstHopSealed is the ONLY gate for the CDP shadow resolver: true → the first `>>>` hop lands on a
// genuinely SEALED closed/declarative shadow host (a page selector can't enter it), so the tools resolve/act
// via the debugger instead of dead-ending. isSealedHost requires a RENDERED box, which jsdom lacks — so a
// positive case stubs getBoundingClientRect on the host. The negatives (no `>>>`, open root, empty host) need
// no layout.

// Give a host a non-zero box so isSealedHost promotes it from "empty" to "sealed".
const paint = (el) => { el.getBoundingClientRect = () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30 }); };

test("firstHopSealed: TRUE for a `>>>` into a painted, hyphenated, light-empty host (a sealed closed root)", () => {
    mount(`<sealed-box id="s"></sealed-box>`);
    paint(document.getElementById("s"));
    assert.equal(firstHopSealed("sealed-box >>> .inner"), true);
});

test("firstHopSealed: FALSE without a `>>>` (a single hop is never this resolver's job)", () => {
    mount(`<sealed-box id="s"></sealed-box>`);
    paint(document.getElementById("s"));
    assert.equal(firstHopSealed("sealed-box"), false);
});

test("firstHopSealed: FALSE for an OPEN shadow host (the JS path already enters it)", () => {
    mount(`<open-box id="o"></open-box>`);
    const o = document.getElementById("o");
    paint(o);
    o.attachShadow({ mode: "open" }).innerHTML = `<button class="inner">Go</button>`;
    assert.equal(firstHopSealed("open-box >>> .inner"), false);
});

test("firstHopSealed: FALSE for an EMPTY emulated host (no rendered box — an unopened menu/outlet, not a barrier)", () => {
    mount(`<router-outlet id="r"></router-outlet>`);
    // jsdom's default getBoundingClientRect returns a 0-box → isSealedHost false → not sealed.
    assert.equal(firstHopSealed("router-outlet >>> .inner"), false);
});

test("firstHopSealed: FALSE for a non-hyphenated host (a plain <div> is never a Web Component barrier)", () => {
    mount(`<div id="d"></div>`);
    paint(document.getElementById("d"));
    assert.equal(firstHopSealed("div >>> .inner"), false);
});

test("firstHopSealed: FALSE when the host has light children (its content is reachable in the light DOM)", () => {
    mount(`<my-widget id="w"><span>hi</span></my-widget>`);
    paint(document.getElementById("w"));
    assert.equal(firstHopSealed("my-widget >>> span"), false);
});

test("firstHopSealed: FALSE for a bad first-hop selector (never throws)", () => {
    mount(`<sealed-box id="s"></sealed-box>`);
    assert.equal(firstHopSealed("((( >>> .inner"), false);
});
