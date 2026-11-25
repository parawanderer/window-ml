// usage-axis.test.mjs — the summary's usage chart: the gap-folding time axis, and the zoom and selection that ride on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const { usageAxis, fracOfTime, timeOfFrac, idleLabel, nudgeWindow, pinchWindow, GAP_MS, GAP_SHARE, GAPS_MAX_SHARE } = await import("../src/chat/usage-axis.ts");
const { usageChart } = await import("../src/chat/session-resources.tsx");

const DAY = 86_400_000, MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
/** Three bursts of calls, five minutes apart for twenty minutes each, with idle days between them. */
const burst = (start, n = 5) => Array.from({ length: n }, (_, k) => start + k * 5 * MIN);
const THREE = [...burst(T0), ...burst(T0 + 2 * DAY), ...burst(T0 + 5 * DAY + 3 * 3_600_000)];
const pts = (ts) => ts.map((ts, k) => ({ ts, prompt: 100 * (k + 1), completion: 10 * (k + 1) }));

// --- the axis: stretches, gaps, and a mapping that is its own inverse ---

test("calls split into stretches at gaps over GAP_MS, each gap a fixed marker, each stretch as wide as it lasted", () => {
    const a = usageAxis(THREE);
    const stretches = a.pieces.filter((p) => p.kind === "stretch"), gaps = a.pieces.filter((p) => p.kind === "gap");
    assert.equal(stretches.length, 3);
    assert.equal(gaps.length, 2);
    for (const g of gaps) assert.ok(Math.abs(g.f1 - g.f0 - GAP_SHARE) < 1e-9, "a gap is a fixed share however long it was");
    const widths = stretches.map((p) => p.f1 - p.f0);
    assert.ok(Math.max(...widths) / Math.min(...widths) < 1.01, "equal stretches draw equally wide");
    assert.equal(usageAxis([T0, T0 + GAP_MS]).pieces.length, 1, "exactly GAP_MS apart is still one stretch");
    assert.equal(usageAxis([T0, T0 + GAP_MS + 1]).pieces.length, 3, "one ms more is a gap");
    assert.equal(usageAxis([]), null);
});

test("a multi-day session spreads over the plot where a linear axis would clump", () => {
    const c = usageChart(pts(THREE));
    const inner = c.plot.r - c.plot.l - 12;
    const byStretch = [c.marks.slice(0, 5), c.marks.slice(5, 10), c.marks.slice(10)];
    for (const s of byStretch) assert.ok((s[4].x - s[0].x) / inner > 0.25, "each burst takes a real share of the plot");
    const linear = (THREE[4] - THREE[0]) / (THREE[14] - THREE[0]);
    assert.ok(linear < 0.01, "on a linear axis the first burst would be a sliver");
    assert.equal(c.gaps.length, 2);
    assert.equal(c.gaps[0].idleMs, THREE[5] - THREE[4]);
    assert.ok(c.marks[4].x < c.gaps[0].x0 + 1e-9 && c.gaps[0].x1 <= c.marks[5].x + 1e-9, "the gap sits between its two bursts");
});

test("time to fraction and back is the identity on every call, and both ways are monotone", () => {
    const ts = [...THREE, T0 + 9 * DAY];   // the last call alone: a one-call stretch
    const a = usageAxis(ts);
    let prev = -1;
    for (const t of ts) {
        const f = fracOfTime(a, t);
        assert.ok(f >= prev, "monotone in time");
        prev = f;
        assert.equal(timeOfFrac(a, f), t, "round trip");
    }
    let pt = -Infinity;
    for (let i = 0; i <= 1000; i++) { const t = timeOfFrac(a, i / 1000); assert.ok(t >= pt, "monotone in fraction"); pt = t; }
    assert.equal(timeOfFrac(a, 0), ts[0]);
    assert.equal(timeOfFrac(a, 1), ts[ts.length - 1]);
    const gap = a.pieces.find((p) => p.kind === "gap");
    const inGap = timeOfFrac(a, (gap.f0 + gap.f1) / 2);
    assert.ok(inGap > gap.t0 && inGap < gap.t1, "a fraction in a gap is a time between the gap's edges");
    const lone = a.pieces[a.pieces.length - 1];
    assert.ok(lone.f1 - lone.f0 > 0, "a one-call stretch has a width of its own, off the gap marker");
});

test("many idle gaps narrow each marker instead of the stretches: at 34 or more gaps the axis stays monotone and its own inverse", () => {
    const DAY = 24 * 3_600_000;
    for (const bursts of [34, 35, 42, 60, 200]) {
        const ts = Array.from({ length: bursts }, (_, i) => T0 + i * DAY);
        const a = usageAxis(ts);
        const gaps = a.pieces.filter((p) => p.kind === "gap"), stretches = a.pieces.filter((p) => p.kind === "stretch");
        assert.equal(gaps.length, bursts - 1);
        for (const p of a.pieces) assert.ok(p.f1 > p.f0, `${bursts} bursts: every piece has positive width`);
        for (let i = 1; i < a.pieces.length; i++) assert.ok(Math.abs(a.pieces[i].f0 - a.pieces[i - 1].f1) < 1e-9, "pieces tile the axis");
        const gapTotal = gaps.reduce((s, p) => s + p.f1 - p.f0, 0);
        assert.ok(gapTotal <= GAPS_MAX_SHARE + 1e-9, `${bursts} bursts: gaps take at most ${GAPS_MAX_SHARE} of the axis`);
        assert.ok(stretches.reduce((s, p) => s + p.f1 - p.f0, 0) >= 1 - GAPS_MAX_SHARE - 1e-9, "the stretches keep the rest");
        for (const t of ts) assert.equal(timeOfFrac(a, fracOfTime(a, t)), t, `${bursts} bursts: round trip at ${t - T0}`);
        const fr = ts.map((t) => fracOfTime(a, t));
        for (let i = 1; i < fr.length; i++) assert.ok(fr[i] > fr[i - 1], "monotone");
        assert.equal(timeOfFrac(a, 0), ts[0], "a drag from the left edge starts at the first call");
    }
    const few = usageAxis([T0, T0 + 2 * GAP_MS, T0 + 4 * GAP_MS]).pieces.filter((p) => p.kind === "gap");
    for (const g of few) assert.ok(Math.abs(g.f1 - g.f0 - GAP_SHARE) < 1e-9, "a few gaps keep the full marker width");
});

test("a session with no gap is one stretch on a linear axis, as before the fold", () => {
    const ts = [1000, 1100, 2000];
    const a = usageAxis(ts);
    assert.equal(a.pieces.length, 1);
    assert.equal(fracOfTime(a, 1100), 0.1);
    const c = usageChart(pts(ts));
    const inner = c.plot.r - c.plot.l - 12;
    assert.equal(c.gaps.length, 0);
    assert.ok(Math.abs(c.marks[1].x - (c.plot.l + 6 + 0.1 * inner)) < 1e-9);
});

test("a window keeps only the calls inside it, none borrowed from outside, and zooming one burst spreads it across the plot", () => {
    const win = { from: THREE[5], to: THREE[9] };
    const c = usageChart(pts(THREE), 320, 130, win);
    assert.deepEqual(c.marks.map((m) => m.i), [5, 6, 7, 8, 9]);
    assert.equal(c.gaps.length, 0);
    const inner = c.plot.r - c.plot.l - 12;
    assert.ok((c.marks[4].x - c.marks[0].x) / inner > 0.99);
    assert.equal(idleLabel(2 * DAY + 4 * 3_600_000), "2d 4h idle");
    assert.equal(idleLabel(45 * MIN), "45m idle");
});

test("gestures work in fractions of the axis: a nudge or a pinch never lands on time inside a gap's length", () => {
    const a = usageAxis(THREE);
    const first = { from: THREE[0], to: THREE[4] };
    const next = nudgeWindow(a, first, 1.2);   // slide right by more than the window
    assert.ok(next.from > first.to, "moved on to a later stretch");
    assert.equal(nudgeWindow(a, null, 0.5), null, "nothing to slide while everything is shown");
    const pinched = pinchWindow(a, null, -40, 0.5);
    assert.ok(pinched && pinched.to - pinched.from < a.t1 - a.t0, "pinching in selects a narrower range");
});

// --- the component: thinning, the selection and the totals, and the panel left alone ---

function mount() {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://chat.test/" });
    for (const k of ["localStorage", "window", "document", "Node", "FileReader", "Event", "HTMLElement"]) {
        Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    }
    return { dom, host: dom.window.document.getElementById("root"), ...createRequire(import.meta.url)("preact") };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const box = (plot) => { plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 }); };

test("thousands of calls draw far fewer marks, and the readout still reaches every call", async () => {
    const { dom, host, h, render } = mount();
    const { UsageChartView } = await import("../src/chat/session-resources.tsx");
    const { cursorTip } = await import("../src/sidebar/ui-kit.tsx");
    const n = 5000;
    const ts = Array.from({ length: n }, (_, k) => T0 + k * 1000);
    const points = ts.map((t, k) => ({ ts: t, prompt: 1000 + ((k * 7919) % 5000), completion: (k * 31) % 700 }));
    points[n - 1].prompt = 123456;
    const c = usageChart(points);
    assert.equal(c.marks.length, n);
    assert.ok(c.drawn.length < n / 2, `drawn ${c.drawn.length} of ${n}`);
    render(h(UsageChartView, { points }), host);
    await tick();
    assert.equal(host.querySelectorAll(".sum-chart circle").length, c.drawn.length);
    assert.match(host.querySelector(".sum-plot").getAttribute("aria-label"), /5000 calls/);
    const plot = host.querySelector(".sum-plot");
    const key = (k) => plot.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    const text = () => { const d = dom.window.document.createElement("div"); render(cursorTip.value.node, d); return d.textContent; };
    key("ArrowLeft"); await tick();   // from none: the last call
    assert.match(text(), /Prompt123,?456/);
    // A call the drawing skipped is still read.
    const skipped = c.marks.findIndex((_, k) => !c.drawn.includes(k));
    assert.ok(skipped >= 0);
    key("Escape"); await tick();
    for (let k = 0; k <= skipped; k++) { key("ArrowRight"); await tick(); }
    assert.match(text(), new RegExp(`Prompt${points[skipped].prompt.toLocaleString().replace(",", ",?")}`));
    render(null, host);
});

test("a selection changes the totals and clearing it restores the whole session; the resource panel's view never moves", async () => {
    const { dom, host, h, render } = mount();
    const { SessionUsage } = await import("../src/chat/session-resources.tsx");
    const { sessionMap, rev } = await import("../src/sidebar/store.ts");
    const { panelView, createChartView } = await import("../src/sidebar/resource/chart-interaction.ts");
    const panelBefore = JSON.stringify([panelView.zoom.value, panelView.brush.value, panelView.windowS.value]);
    assert.notEqual(createChartView().zoom, panelView.zoom, "a chart's own view is its own signals");
    sessionMap.set("local:day", { hash: "local:day", kind: "agent", model: "m", config: { model: "m" }, turns: [],
        steps: THREE.map((ts, k) => ({ step: k + 1, ts, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })) });
    rev.value++;
    render(h(SessionUsage, { mapKey: "local:day" }), host);
    await tick();
    const calls = () => host.querySelector('.sum-totals [data-field="calls"] dd')?.textContent;
    assert.equal(calls(), "15");
    assert.equal(host.querySelector(".sum-scope"), null, "the whole session says nothing about a range");
    const plot = host.querySelector(".sum-plot");
    box(plot);
    const mouse = (type, x, buttons) => (type === "pointerdown" ? plot : dom.window).dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 50, button: 0, buttons }));
    plot.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 190, clientY: 50 }));   // a call is under the pointer: its index outlives the zoom
    await tick();
    mouse("pointerdown", 2, 1);
    mouse("pointermove", 60, 1);
    mouse("pointerup", 60, 0);
    await tick();
    assert.equal(calls(), "4", "the first burst's calls up to the pointer");
    assert.match(host.querySelector(".sum-scope").textContent, /This range: 4 calls of 15/);
    assert.equal(host.querySelectorAll(".sum-chart circle").length, 4, "the chart drew the range");
    assert.equal(JSON.stringify([panelView.zoom.value, panelView.brush.value, panelView.windowS.value]), panelBefore, "the panel did not zoom with it");
    // Scrolling slides the selection on; a pinch resizes it; neither touches the panel.
    const edges = () => [...host.querySelectorAll(".sum-axis")].map((t) => t.textContent).join("|");
    const before = edges();
    plot.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100, clientX: 100 }));
    await tick();
    assert.notEqual(edges(), before, "the selection slid along");
    assert.equal(JSON.stringify([panelView.zoom.value, panelView.brush.value, panelView.windowS.value]), panelBefore);
    host.querySelector(".vram-zoom").click();
    await tick();
    assert.equal(calls(), "15", "clearing the selection restores the whole session");
    assert.equal(host.querySelector(".sum-scope"), null);
    render(null, host);
    sessionMap.delete("local:day");
});
