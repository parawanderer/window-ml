// shell-shot.test.mjs — the shell's side of keeping the extension's UI out of a screenshot (src/sidebar/shell-shot.ts):
// the page's hide handshake, now bounded, and the read-only rect report the worker masks with, answered for the worker
// alone. The rects are read from fake elements here; that the real shell's rects cover the real sidebar's pixels is
// tests/e2e/worker-shot.spec.mjs.

import test from "node:test";
import assert from "node:assert/strict";

const frames = [];   // requestAnimationFrame callbacks waiting for the next frame
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.chrome = { runtime: { id: "ext-id" } };
const pageIframes = [];
globalThis.document = { querySelectorAll: (sel) => (sel === "iframe" ? pageIframes : []) };
globalThis.window = { innerWidth: 1000, innerHeight: 700 };
globalThis.getComputedStyle = (el) => ({ visibility: el.visibility ?? "visible" });
/** Run one frame's callbacks. */
const frame = () => { for (const fn of frames.splice(0)) fn(); };

const { pageShotGate, extensionRects, answerShotRects, fromWorker, PAGE_SHOT_HOLD_MS } = await import("../src/sidebar/shell-shot.ts");

const WORKER = { id: "ext-id" };   // a chrome.tabs.sendMessage from the worker: this extension, no tab
const PAGE_TAB = { id: "ext-id", tab: { id: 3 }, url: "chrome-extension://ext-id/sidebar.html", frameId: 5 };   // the extension's own frame IN a tab

// --- the page's own hide handshake ---

/** A gate over a surface that records whether it is hidden. */
function gate(holdMs) {
    frames.length = 0;
    const surface = { hidden: false, hide() { this.hidden = true; }, show() { this.hidden = false; } };
    return { surface, gate: pageShotGate(surface, holdMs) };
}

test("the page's handshake: hide, the ack after two frames, show restores", () => {
    const { surface, gate: g } = gate();
    let acked = 0;
    g.pageHide(() => acked++);
    assert.equal(surface.hidden, true);
    frame();
    assert.equal(acked, 0, "one frame is not enough: the hidden state may not have painted");
    frame();
    assert.equal(acked, 1);
    g.pageShow();
    assert.equal(surface.hidden, false);
});

test("the page's hide ends on its own when no show comes, so a page cannot keep the sidebar and the approval card hidden", async () => {
    assert.ok(PAGE_SHOT_HOLD_MS <= 5000, "a few seconds, past an honest page-hosted capture");
    const { surface, gate: g } = gate(40);
    g.pageHide(() => {});
    assert.equal(surface.hidden, true);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(surface.hidden, false);
    // A second hide restarts the bound rather than stacking timers that lift a later hide early.
    g.pageHide(() => {});
    await new Promise((r) => setTimeout(r, 25));
    g.pageHide(() => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(surface.hidden, true, "the second hide's own bound has not run out");
});

// --- the rects the worker masks ---

/** A fake element: a viewport rect, an id, and the ancestors `closest` finds. */
const el = (rect, { id = "", tag = "DIV", within = [], visibility } = {}) => ({
    tagName: tag, id, visibility,
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3], right: rect[0] + rect[2], bottom: rect[1] + rect[3] }),
    closest: (sel) => (id === sel.slice(1) || within.includes(sel.slice(1)) ? {} : null),   // like the real one, the element itself first
});
const host = (children, connected = true) => ({ isConnected: connected, shadowRoot: { querySelectorAll: () => children } });
const roots = (hosts) => ({ hosts, lightboxId: "ml-lightbox", highlightId: "ml-highlight", extensionOrigin: "chrome-extension://ext-id/" });

test("every painted element in the shell's shadow roots is reported in viewport px, with its surface; style elements, hidden and empty ones are not", () => {
    const sidebar = host([el([0, 0, 0, 0], { tag: "STYLE" }), el([700, 0, 300, 700]), el([690, 300, 10, 40]), el([0, 0, 0, 0]), el([5, 5, 50, 50], { visibility: "hidden" })]);
    const card = host([el([20, 500, 200, 150])]);
    const out = extensionRects(roots([{ host: sidebar, kind: "sidebar" }, { host: card, kind: "card" }, { host: null, kind: "highlight" }, { host: host([el([1, 1, 1, 1])], false), kind: "card" }]));
    assert.equal(out.vw, 1000); assert.equal(out.vh, 700);
    assert.deepEqual(out.rects, [
        { x: 700, y: 0, w: 300, h: 700, kind: "sidebar" },
        { x: 690, y: 300, w: 10, h: 40, kind: "sidebar" },
        { x: 20, y: 500, w: 200, h: 150, kind: "card" },
    ]);
});

test("the image viewer is reported as such, wherever it is mounted, so a refusal can name it", () => {
    const card = host([el([0, 0, 1000, 700], { id: "ml-lightbox" }), el([400, 100, 200, 300], { tag: "IMG", within: ["ml-lightbox"] })]);
    assert.deepEqual(extensionRects(roots([{ host: card, kind: "card" }])).rects.map((r) => r.kind), ["lightbox", "lightbox"]);
});

test("the hover highlight is four strips round the element it outlines, never the element itself; its label is a box", () => {
    const hl = host([el([100, 200, 50, 20], { id: "ml-highlight" }), el([100, 222, 60, 14], { within: ["ml-highlight"] })]);
    const rects = extensionRects(roots([{ host: hl, kind: "highlight" }])).rects;
    assert.deepEqual(rects, [
        { x: 96, y: 196, w: 58, h: 8, kind: "highlight" },
        { x: 96, y: 216, w: 58, h: 8, kind: "highlight" },
        { x: 96, y: 196, w: 8, h: 28, kind: "highlight" },
        { x: 146, y: 196, w: 8, h: 28, kind: "highlight" },
        { x: 100, y: 222, w: 60, h: 14, kind: "highlight" },
    ]);
    const inside = (x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    assert.equal(inside(125, 210), false, "the outlined element's middle is left alone");
});

test("a frame of the extension's own pages that the page embedded itself is reported; another site's frame is not", () => {
    pageIframes.push({ src: "chrome-extension://ext-id/sidebar.html", getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }) },
        { src: "https://ads.example/", getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }) });
    try { assert.deepEqual(extensionRects(roots([])).rects, [{ x: 0, y: 0, w: 300, h: 200, kind: "frame" }]); }
    finally { pageIframes.length = 0; }
});

test("past 400 rects, each surface's rects are merged into their bounding box rather than sent without bound", () => {
    const many = host(Array.from({ length: 500 }, (_, i) => el([i, i, 2, 2])));
    assert.deepEqual(extensionRects(roots([{ host: many, kind: "card" }])).rects, [{ x: 0, y: 0, w: 501, h: 501, kind: "card" }]);
});

test("the rect report is answered for the worker only: a sender with a tab, another extension or none gets nothing", () => {
    const r = () => roots([{ host: host([el([0, 0, 10, 10])]), kind: "card" }]);
    let got = null;
    assert.equal(answerShotRects(WORKER, r, (x) => { got = x; }), true);
    assert.equal(got.rects.length, 1);
    for (const sender of [PAGE_TAB, { id: "other-ext" }, { id: "other-ext", tab: { id: 3 } }, { tab: { id: 3 } }, undefined, {}]) {
        assert.equal(answerShotRects(sender, r, () => assert.fail(`answered ${JSON.stringify(sender)}`)), false);
    }
    assert.equal(fromWorker(WORKER), true);
});
