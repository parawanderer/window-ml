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
