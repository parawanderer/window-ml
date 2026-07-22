"use strict";
// The Set-of-Marks hit-test engine (som.ts, built to dist/som.js). elementFromPoint
// is a jsdom no-op, so collectCandidates/drawMarks (which need real layout + canvas)
// can't run here — but representativeFor is the accessibility-agnostic CORE (climb a
// raw hit to the meaningful element) and IS testable against a real DOM.
const { test } = require("node:test");
const assert = require("node:assert");
const { JSDOM } = require("jsdom");

// som.js reads global document/window/getComputedStyle at call time; wire them.
function world(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    global.window = dom.window;
    global.document = dom.window.document;
    global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    return dom.window.document;
}
const som = require("../dist/som.js");
const { representativeFor, isClickish, buildMarks, viewportBox } = som;

test("viewportBox maps model coords (any range) to a viewport box, min/max-normalized", () => {
    // 0–1000 normalized on a 1600×900 viewport.
    assert.deepEqual(viewportBox([250, 250, 750, 750], 1000, 1600, 900),
        { left: 400, top: 225, right: 1200, bottom: 675 });
    // 0–100 percent (Molmo).
    assert.deepEqual(viewportBox([10, 20, 30, 40], 100, 1000, 500),
        { left: 100, top: 100, right: 300, bottom: 200 });
    // Corners given bottom-right-first still normalize to a valid box.
    assert.deepEqual(viewportBox([750, 750, 250, 250], 1000, 1000, 1000),
        { left: 250, top: 250, right: 750, bottom: 750 });
    // range 0 falls back to 1000 (no divide-by-zero).
    assert.equal(viewportBox([500, 0, 500, 0], 0, 1000, 1000).left, 500);
});

test("clickables: climbs from a raw hit to the nearest semantic-interactive ancestor", () => {
    const doc = world(`<button id="b"><span id="label"><svg id="icon"></svg></span></button>`);
    // A hit on the deep <svg>/<span> should resolve UP to the <button>.
    assert.equal(representativeFor(doc.getElementById("icon"), "clickables").id, "b");
    assert.equal(representativeFor(doc.getElementById("label"), "clickables").id, "b");
    assert.equal(representativeFor(doc.getElementById("b"), "clickables").id, "b");
});

test("clickables: a non-semantic div with cursor:pointer is caught via the pointer boundary", () => {
    // No role/tabindex/handler — only a pointer cursor, the case ARIA enumeration misses.
    const doc = world(`<div id="card" style="cursor:pointer"><span id="t">Buy now</span></div><p id="plain">text</p>`);
    // The inner span inherits the pointer cursor; representativeFor climbs to the
    // OUTERMOST pointer element (the clickable card), not the leaf.
    assert.equal(representativeFor(doc.getElementById("t"), "clickables").id, "card");
    // Plain text with no pointer + no semantics → nothing qualifies.
    assert.equal(representativeFor(doc.getElementById("plain"), "clickables"), null);
});

test("images / inputs filters climb to the nearest matching element; all passes the hit through", () => {
    const doc = world(`
        <a id="imglink" href="#"><img id="img" src="x.png"></a>
        <label id="lbl">Name <input id="inp"></label>
        <div id="bare">nothing</div>`);
    assert.equal(representativeFor(doc.getElementById("img"), "images").id, "img");
    assert.equal(representativeFor(doc.getElementById("inp"), "inputs").id, "inp");
    assert.equal(representativeFor(doc.getElementById("lbl"), "inputs"), null); // label is not an input; nothing above it matches
    assert.equal(representativeFor(doc.getElementById("bare"), "all").id, "bare");
    assert.equal(representativeFor(doc.getElementById("bare"), "clickables"), null);
});

test("isClickish recognises semantic roles and the pointer-cursor convention", () => {
    const doc = world(`
        <div id="role" role="button">x</div>
        <a id="a" href="#">y</a>
        <div id="ptr" style="cursor:pointer">z</div>
        <div id="plain">w</div>`);
    assert.ok(isClickish(doc.getElementById("role")));
    assert.ok(isClickish(doc.getElementById("a")));
    assert.ok(isClickish(doc.getElementById("ptr")));
    assert.ok(!isClickish(doc.getElementById("plain")));
});

test("buildMarks numbers candidates 1-based and carries role/name/selector", () => {
    const doc = world(`<button id="one" aria-label="Save">A</button><a id="two" href="#">Open</a>`);
    const marks = buildMarks([doc.getElementById("one"), doc.getElementById("two")]);
    assert.equal(marks.length, 2);
    assert.deepEqual(marks.map(m => m.id), [1, 2]);
    assert.equal(marks[0].role, "button");
    assert.equal(marks[0].name, "Save");            // accessible name from aria-label
    assert.match(marks[0].selector, /#one|button/); // clickSelector anchors on the id
    assert.equal(marks[1].name, "Open");            // accessible name from text
});
