// The chart's view state (src/sidebar/resource/chart-interaction.ts, `ChartView`): the zoom, the drag in progress, the
// window width and the axis hold that the brush, the scrub strip and the window chip read and write. The resource panel
// uses `panelView` (its own global signals); a second chart makes one with `createChartView`, and neither may reach the other.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, doc, win, CI, LANE, SCRUB, STORE;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    win = dom.window;
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.Node = win.Node;
    globalThis.HTMLElement = win.HTMLElement;
    doc = win.document;
    ({ h, render } = require_("preact"));
    STORE = await import("../src/sidebar/store.ts");
    CI = await import("../src/sidebar/resource/chart-interaction.ts");
    LANE = await import("../src/sidebar/resource/resource-lane-ui.tsx");
    SCRUB = await import("../src/sidebar/resource/resource-scrub.tsx");
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const mount = (vnode) => { const host = doc.getElementById("root"); render(vnode, host); return host; };

// --- the panel's view is the panel's globals, not a copy ---

test("panelView bundles the very signals the rest of the panel reads", () => {
    assert.equal(CI.panelView.zoom, STORE.zoomRange);
    assert.equal(CI.panelView.brush, STORE.brush);
    assert.equal(CI.panelView.windowS, STORE.resWindowS);
    assert.equal(CI.panelView.windowDefault, STORE.resWindowPref);
    assert.equal(CI.panelView.live, CI.live);
    assert.equal(CI.panelView.held, CI.chartHeld);
});

// --- two views do not reach each other ---

test("a zoom, a drag and a width on a local view leave the panel's signals alone", () => {
    const v = CI.createChartView({ windowS: 300 });
    assert.notEqual(v.zoom, CI.panelView.zoom);
    assert.equal(v.windowS.value, 300);
    assert.equal(v.windowDefault.value, 300);
    v.zoom.value = { from: 1, to: 2 };
    v.brush.value = { from: 0.1, to: 0.2 };
    v.windowS.value = 60;
    v.held.value = { axis: { from: 0, to: 1 }, key: "k" };
    assert.equal(STORE.zoomRange.value, null);
    assert.equal(STORE.brush.value, null);
    assert.equal(CI.chartHeld.value, null);
    assert.notEqual(STORE.resWindowS.value, 60);
});

test("a zoom on the panel's view leaves a local view alone", () => {
    const v = CI.createChartView();
    STORE.zoomRange.value = { from: 5, to: 9 };
    try { assert.equal(v.zoom.value, null); } finally { STORE.zoomRange.value = null; }
});

test("settleScrub on a local view pins and un-pins its own zoom, remembers its own width, and never touches the panel", async () => {
    const remembered = [];
    const v = CI.createChartView({ windowS: 300, remember: (s) => remembered.push(s) });
    const ex = { from: 0, to: 100_000 };
    SCRUB.settleScrub({ from: 10_000, to: 30_000 }, ex, true, v);   // not at the tail: pins
    assert.deepEqual(v.zoom.value, { from: 10_000, to: 30_000 });
    assert.equal(STORE.zoomRange.value, null);
    SCRUB.settleScrub({ from: 50_000, to: 100_000 }, ex, true, v);  // at the tail while following: live again, at that width
    assert.equal(v.zoom.value, null);
    assert.equal(v.windowS.value, 50);
    assert.notEqual(STORE.resWindowS.value, 50);
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(remembered, [50]);
});

test("the window chip names its own view's zoom, and its undo clears only that view", () => {
    const v = CI.createChartView();
    v.zoom.value = { from: 0, to: 90_000 };
    const host = mount(h(SCRUB.WindowChip, { view: v }));
    const chip = host.querySelector("button.vram-zoom");
    assert.ok(chip, "a pinned local view shows its chip");
    assert.match(chip.textContent, /1m 30s/);
    mount(h(SCRUB.WindowChip, {}));
    assert.equal(doc.querySelector("button.vram-zoom"), null, "the panel's chip is untouched by it");
    STORE.zoomRange.value = { from: 0, to: 5_000 };
    try {
        mount(h(SCRUB.WindowChip, { view: v }));
        doc.querySelector("button.vram-zoom").click();
        assert.equal(v.zoom.value, null);
        assert.deepEqual(STORE.zoomRange.value, { from: 0, to: 5_000 });
    } finally { STORE.zoomRange.value = null; mount(null); }
});

test("a drag across a local view's plot selects on its own axis and brush, not the panel's", () => {
    const v = CI.createChartView();
    v.live.axis = { from: 0, to: 100_000 };
    const plot = doc.createElement("div");
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 100, right: 800, bottom: 100, x: 0, y: 0 });
    doc.body.appendChild(plot);
    const P = (type, x, buttons) => { const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: 5, button: 0, buttons }); return e; };
    const down = P("pointerdown", 100, 1);
    Object.defineProperty(down, "currentTarget", { value: plot });
    const snap = STORE.snapDot.value;
    STORE.snapDot.value = false;
    try {
        LANE.startBrush([], v)(down);
        assert.deepEqual(v.brush.value, { from: 0.125, to: 0.125 });
        assert.equal(STORE.brush.value, null, "the panel's brush is not drawn");
        win.dispatchEvent(P("pointermove", 500, 1));
        assert.equal(v.brush.value.to, 0.625);
        win.dispatchEvent(P("pointerup", 500, 0));
        assert.equal(v.brush.value, null);
        assert.deepEqual(v.zoom.value, { from: 12_500, to: 62_500 });
        assert.equal(STORE.zoomRange.value, null);
    } finally { STORE.snapDot.value = snap; plot.remove(); }
});

test("a hold taken on one view is not read as held by the other", () => {
    const v = CI.createChartView();
    v.live.axis = { from: 0, to: 10 };
    CI.holdAxisOf(v)();
    assert.ok(v.held.value);
    assert.equal(CI.chartHeld.value, null);
    assert.notEqual(CI.holdKey(v), "");
    CI.releaseAxisOf(v)({ relatedTarget: null });
    assert.equal(v.held.value, null);
});
