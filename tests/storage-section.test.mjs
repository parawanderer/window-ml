// The Settings Storage section (src/sidebar/storage-section.tsx) against a scripted report: what it says with no
// history yet, with some, and when the browser keeps nothing.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, StorageBody, doc;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    // Through require: tsx compiles the component to CJS, and a second preact instance has no current component.
    ({ h, render } = require_("preact"));
    ({ StorageBody } = await import("../src/sidebar/storage-section.tsx"));
});

/** Until the report has been drawn: effects run after a paint frame, so a fixed sleep is a guess about that frame. */
const drawn = async (host) => { for (let i = 0; i < 200 && (!host.textContent || /Reading/.test(host.textContent)); i++) await new Promise((r) => setTimeout(r, 5)); };
const snap = (t, over = {}) => ({ t, total: 1000, images: 600, imageCount: 2, toolOutput: 300, other: 100, byTool: { exec: 250, python_exec: 50 }, sessions: 3, events: 40, pinned: 1, unmeasured: 0, ...over });
const mount = async (report, props = { measure: async () => null }) => {
    const host = doc.getElementById("root");
    render(null, host);
    render(h(StorageBody, { load: async () => report, ...props }), host);
    await drawn(host);
    return host;
};

test("today's picture, the tools, the largest sessions, and a chart only once there are two days", async () => {
    const one = await mount({ history: [snap(1)], now: snap(2), largest: [{ hash: "aaaa0001", title: "Lamp hunt", bytes: 900, pinned: true }] });
    assert.match(one.textContent, /3 sessions, 1 pinned/);
    assert.match(one.textContent, /The chart appears after the second day/);
    assert.match(one.textContent, /exec/);
    assert.match(one.textContent, /Lamp hunt \(pinned\)/);
    assert.equal(one.querySelectorAll(".stor-bar > span").length, 3, "a part with no bytes draws nothing");

    const two = await mount({ history: [snap(1), snap(86400000, { total: 2000, images: 1500 })], now: snap(2), largest: [] });
    assert.equal(two.querySelectorAll(".stor-chart path").length, 4);
});

test("a browser that keeps nothing says so", async () => {
    const host = await mount(null);
    assert.match(host.textContent, /keeps no saved sessions/);
});

test("a remote runtime: its own empty text, and no measuring from here", async () => {
    const empty = await mount(null, { emptyText: "Lab box keeps no saved sessions." });
    assert.match(empty.textContent, /Lab box keeps no saved sessions/);
    const host = await mount({ history: [snap(1)], now: snap(2, { unmeasured: 400 }), largest: [] }, {});
    assert.equal(host.querySelector("button"), null);
    assert.doesNotMatch(host.textContent, /Measure exactly/);
});

// --- reading the history chart at a moment, and opening a listed session ---

/** The chart's readout as text: the shared cursor tip, rendered by its own layer into a second host. */
const tipText = async () => {
    const { CursorTipLayer } = await import("../src/sidebar/ui-kit.tsx");
    let host = doc.getElementById("tip");
    if (!host) { host = doc.createElement("div"); host.id = "tip"; doc.body.appendChild(host); }
    render(null, host);
    render(h(CursorTipLayer, {}), host);
    return host.textContent;
};
const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 10));

test("the history chart reads out a day's time and every part's bytes, from the keyboard and the pointer", async () => {
    const { cursorTip } = await import("../src/sidebar/ui-kit.tsx");
    const day0 = Date.UTC(2026, 8, 19, 12), day1 = day0 + 86400000;
    const host = await mount({ history: [snap(day0, { total: 1000, images: 600, toolOutput: 300, other: 100 }), snap(day1, { total: 2048, images: 1024, toolOutput: 0, other: 1024 })], now: snap(day1), largest: [] });
    const plot = host.querySelector(".tc-plot");
    assert.ok(plot, "the chart is a readable plot");
    assert.equal(plot.getAttribute("tabindex"), "0", "and reachable from the keyboard");

    key(plot, "ArrowRight"); await settle();
    assert.equal(cursorTip.value?.node !== undefined, true, "an arrow key shows the readout");
    key(plot, "ArrowRight"); await settle();
    const text = await tipText();
    assert.match(text, new RegExp(new Date(day1).toLocaleString(undefined, { month: "short", day: "numeric" })), "names the second day");
    assert.match(text, /Images1\.00 KiB/);
    assert.match(text, /Everything else1\.00 KiB/);
    assert.doesNotMatch(text, /Tool output/, "a part with nothing that day is left out");
    assert.match(text, /Total2\.00 KiB/);
    assert.ok(host.querySelector(".tc-rule"), "a rule marks the day being read");
    assert.equal(host.querySelectorAll(".tc-dot").length, 2, "and a dot on each part that has bytes");

    plot.dispatchEvent(new window.MouseEvent("pointerleave", { bubbles: true })); await settle();
    assert.equal(cursorTip.value, null, "leaving takes the readout down");
    assert.equal(host.querySelector(".tc-rule"), null);

    plot.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 })); await settle();
    assert.match(await tipText(), /Total1000 B/, "a tap (pointer down) reads the nearest day, here the first");

    render(null, host); await settle();
    assert.equal(cursorTip.value, null, "a chart that goes away under a still pointer takes its readout with it");
});

test("the largest sessions open when the surface can open one, and are plain rows when it cannot", async () => {
    const opened = [];
    const largest = [{ hash: "aaaa0001", title: "Lamp hunt", bytes: 900 }, { hash: "bbbb0002", bytes: 400 }];
    const host = await mount({ history: [snap(1)], now: snap(2), largest }, { onOpen: (hash) => opened.push(hash) });
    const rows = host.querySelectorAll(".stor-largest button.stor-open");
    assert.equal(rows.length, 2);
    assert.match(rows[0].getAttribute("aria-label"), /Open Lamp hunt/);
    rows[1].click();
    assert.deepEqual(opened, ["bbbb0002"], "by the session's own hash, even one with no title");

    const plain = await mount({ history: [snap(1)], now: snap(2), largest }, {});
    assert.equal(plain.querySelector(".stor-largest button"), null);
    assert.match(plain.textContent, /Lamp hunt/);
});

test("nearestPoint picks by time, so uneven samples are read where they are", async () => {
    const { nearestPoint } = await import("../src/sidebar/time-chart.tsx");
    const pts = [{ t: 0, values: {} }, { t: 10, values: {} }, { t: 100, values: {} }];
    assert.equal(nearestPoint(pts, 4), 0);
    assert.equal(nearestPoint(pts, 50), 1, "halfway in TIME is nearer the second sample, though it is the middle index");
    assert.equal(nearestPoint(pts, 60), 2);
});
