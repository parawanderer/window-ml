"use strict";
// The Set-of-Marks hit-test engine (som.ts, built to dist/som.js). elementFromPoint
// is a jsdom no-op, so collectCandidates/drawGrid (which need real layout + canvas)
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
const { representativeFor, isClickish, buildMarks, viewportBox, formatBox, projectFromSquare, gridDims, validateCells, cellsBox, adjacentCells, colorWordHues, pickOverlayHex, regionBox, REGION_OVERLAP } = som;

test("colorWordHues extracts hues from colour words in a description (for overlay avoidance)", () => {
    assert.deepEqual(colorWordHues("the bright RED umbrella"), [0]);
    assert.deepEqual(colorWordHues("a green download button").sort((a, b) => a - b), [140]);
    assert.deepEqual(colorWordHues("no colour here mentioned"), []);
    // Word-boundaried: "regenerate" must not match "red".
    assert.deepEqual(colorWordHues("the regenerate icon"), []);
});

test("pickOverlayHex chooses a palette colour that clashes least with the page hues", () => {
    const empty = new Array(12).fill(0);
    // A neutral/grey page → the default red.
    assert.equal(pickOverlayHex(empty), "#ff2d55");
    // A red-heavy page (weight in the 0° bucket) → red is avoided, a far hue chosen.
    const redPage = empty.slice(); redPage[0] = 100;
    assert.notEqual(pickOverlayHex(redPage), "#ff2d55");
    // avoidHues hard-blocks the target's colour even on a neutral page.
    assert.notEqual(pickOverlayHex(empty, [0]), "#ff2d55", "red target → don't overlay in red");
});

test("gridDims matches the grid to the region aspect (a wide strip gets more cols than rows)", () => {
    assert.deepEqual(gridDims({ width: 1000, height: 1000 }, 4), { cols: 4, rows: 4 });   // square → N×N
    const wide = gridDims({ width: 1200, height: 150 }, 4);                                // a toolbar strip
    assert.ok(wide.cols > wide.rows, "wide region → more columns than rows");
    assert.ok(wide.rows >= 2, "rows clamped to a floor of 2");
    const tall = gridDims({ width: 150, height: 1200 }, 4);
    assert.ok(tall.rows > tall.cols, "tall region → more rows than columns");
});

test("regionBox crops to a named directional area — bands full-length, corners quadrants, halves overlap", () => {
    const region = { left: 0, top: 0, width: 1000, height: 1000 };
    const o = REGION_OVERLAP * 1000;   // the overlap in px on this region

    // Bands run the FULL cross-axis length.
    assert.deepEqual(regionBox("left", region), { left: 0, top: 0, right: 500 + o, bottom: 1000 }, "left = left half (overlapping), full height");
    assert.deepEqual(regionBox("right", region), { left: 500 - o, top: 0, right: 1000, bottom: 1000 }, "right = right half, full height");
    assert.deepEqual(regionBox("top", region), { left: 0, top: 0, right: 1000, bottom: 500 + o }, "top = full width, top half");
    assert.deepEqual(regionBox("bottom", region), { left: 0, top: 500 - o, right: 1000, bottom: 1000 });

    // Corners are quadrants (both axes halved).
    assert.deepEqual(regionBox("top-left", region), { left: 0, top: 0, right: 500 + o, bottom: 500 + o });
    assert.deepEqual(regionBox("bottom-right", region), { left: 500 - o, top: 500 - o, right: 1000, bottom: 1000 });

    // Center is the middle box.
    assert.deepEqual(regionBox("center", region), { left: 250, top: 250, right: 750, bottom: 750 });

    // The overlap means a point exactly on the midline is inside BOTH halves.
    const mid = 500;
    const left = regionBox("left", region), right = regionBox("right", region);
    assert.ok(mid < left.right && mid > right.left, "the midline is covered by both left and right (no boundary gap)");

    // Honours the region's own offset (a scoped container, not the viewport).
    const off = regionBox("left", { left: 200, top: 100, width: 400, height: 400 });
    assert.equal(off.left, 200, "left edge = the container's left, not 0");
    assert.equal(off.top, 100);
});

test("adjacentCells names the in-bounds 4-neighbours by direction (the run from the screenshots)", () => {
    // 12×5 grid, cell 38 → row 3, col 1 (0-based). left=37, right=39, top=26, bottom=50.
    assert.deepEqual(adjacentCells([38], 12, 5), { left: 37, right: 39, top: 26, bottom: 50 });
    // A corner cell (1) has no left/top — only the in-bounds neighbours are returned.
    assert.deepEqual(adjacentCells([1], 12, 5), { right: 2, bottom: 13 });
    // Bottom-right corner (60) → only left/top.
    assert.deepEqual(adjacentCells([60], 12, 5), { left: 59, top: 48 });
    // A 2-cell selection: neighbours step out from the bounding box, none inside the pick.
    const adj = adjacentCells([1, 2], 12, 5);   // spans cols 0–1, row 0
    assert.equal(adj.left, undefined, "no left — cell 1 is on the edge");
    assert.equal(adj.right, 3, "right of the 2-cell span");
    assert.equal(adj.top, undefined, "no top — row 0");
});

test("validateCells accepts 1 / 2-adjacent / 2×2, rejects non-adjacent, L-shapes, and 3-cell picks", () => {
    // In a 4×4 grid: 1 is (0,0), 2 is (0,1), 5 is (1,0), 6 is (1,1).
    assert.ok(validateCells([6], 4, 4).ok);
    assert.ok(validateCells([1, 2], 4, 4).ok, "horizontal neighbours");
    assert.ok(validateCells([2, 6], 4, 4).ok, "vertical neighbours");
    assert.ok(validateCells([1, 2, 5, 6], 4, 4).ok, "a 2×2 block");
    assert.ok(!validateCells([1, 3], 4, 4).ok, "not adjacent (a gap)");
    assert.ok(!validateCells([1, 6], 4, 4).ok, "diagonal, not edge-adjacent");
    assert.ok(!validateCells([1, 2, 5], 4, 4).ok, "3 cells is never valid");
    assert.ok(!validateCells([1, 2, 3, 4], 4, 4).ok, "a 1×4 row is not a 2×2 block");
    assert.ok(!validateCells([0], 4, 4).ok, "out of range");
});

test("cellsBox unions a cell selection into the bounding rectangle", () => {
    const region = { left: 0, top: 0, width: 400, height: 400 };   // 4×4 → 100px cells
    assert.deepEqual(cellsBox([1], 4, 4, region), { left: 0, top: 0, right: 100, bottom: 100 });
    assert.deepEqual(cellsBox([2, 3], 4, 4, region), { left: 100, top: 0, right: 300, bottom: 100 });
    assert.deepEqual(cellsBox([1, 2, 5, 6], 4, 4, region), { left: 0, top: 0, right: 200, bottom: 200 });
});

test("projectFromSquare inverts a letterbox: ONE scale (max side) on both axes, + region offset", () => {
    // Full viewport 1600×900, range 1000. Letterbox fits by the long side (1600), so
    // BOTH axes divide by 1600 — unlike viewportBox's per-axis stretch. y past the
    // content (900/1600 of the square) lands in the padding and clamps to the edge.
    const full = { left: 0, top: 0, width: 1600, height: 900 };
    assert.deepEqual(projectFromSquare([250, 250, 750, 750], 1000, full),
        { left: 400, top: 400, right: 1200, bottom: 900 });   // bottom clamps (750 → padding)
    // A scoped region: 400×100 at (100,200). max side = 400; the 100px height maps to
    // the top 250 of the square, so model-y 250 == the region's bottom edge.
    const region = { left: 100, top: 200, width: 400, height: 100 };
    assert.deepEqual(projectFromSquare([0, 0, 1000, 250], 1000, region),
        { left: 100, top: 200, right: 500, bottom: 300 });
    // A square region degenerates to the same mapping as viewportBox (offset aside).
    const sq = { left: 0, top: 0, width: 500, height: 500 };
    assert.deepEqual(projectFromSquare([100, 200, 300, 400], 1000, sq),
        { left: 50, top: 100, right: 150, bottom: 200 });
});

test("formatBox renders a box as two (x,y) pairs — ints stay ints, floats round to 1dp", () => {
    assert.deepEqual(formatBox([28, 242, 45, 264]),
        { text: "(28, 242) → (45, 264)", corners: ["28, 242", "45, 264"] });
    // a 0–1 (range 1) model: decimals kept, `.` separator, 1 decimal place.
    assert.deepEqual(formatBox([0.3, 0.2, 0.5, 0.6]),
        { text: "(0.3, 0.2) → (0.5, 0.6)", corners: ["0.3, 0.2", "0.5, 0.6"] });
});

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
