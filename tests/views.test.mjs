// `look`'s two-view mode + the targeted "box over text" detector.
//  - boxIntersectsText (dom.ts): does the click-point overlay box sit ON page text? Powers a TARGETED
//    no-overlay nudge instead of an always-on note. Same-origin DOM only (a cross-origin iframe / canvas
//    @pt has no reachable text → no false positive, falls back to the manual views option).
//  - lookViews (builtin-tools.ts): produce overlay / no-overlay / both crops from ONE viewport capture.
import { test } from "node:test";
import assert from "node:assert";
import { boxIntersectsText } from "../src/dom.ts";
import { lookViews } from "../src/builtin-tools.ts";

// A minimal fake document: elementFromPoint + caret* + createRange, enough to drive the hit-test.
function fakeDoc({ textRect, tag = "SPAN", caretText = "hello", el = null }) {
    const textNode = { nodeType: 3, textContent: caretText };
    const range = { selectNodeContents() {}, getClientRects: () => (textRect ? [textRect] : []) };
    return {
        elementFromPoint: () => el || { tagName: tag },
        caretPositionFromPoint: () => ({ offsetNode: textNode, offset: 0 }),
        createRange: () => range,
    };
}

test("boxIntersectsText: TRUE when a glyph rect overlaps the box", () => {
    const box = { left: 100, top: 100, width: 24, height: 24 };
    assert.equal(boxIntersectsText(box, fakeDoc({ textRect: { left: 105, top: 105, width: 40, height: 12 } })), true);
});

test("boxIntersectsText: FALSE when the caret's text renders elsewhere (rect off the box)", () => {
    const box = { left: 100, top: 100, width: 24, height: 24 };
    assert.equal(boxIntersectsText(box, fakeDoc({ textRect: { left: 500, top: 500, width: 40, height: 12 } })), false);
});

test("boxIntersectsText: FALSE with no text under the box (canvas @pt — no DOM text)", () => {
    const box = { left: 0, top: 0, width: 24, height: 24 };
    const doc = { elementFromPoint: () => ({ tagName: "CANVAS" }), caretPositionFromPoint: () => null, createRange: () => ({}) };
    assert.equal(boxIntersectsText(box, doc), false);
});

test("boxIntersectsText: a CROSS-ORIGIN iframe (no contentDocument) is skipped → FALSE", () => {
    const box = { left: 10, top: 10, width: 24, height: 24 };
    const doc = { elementFromPoint: () => ({ tagName: "IFRAME", contentDocument: null, getBoundingClientRect: () => ({ left: 0, top: 0 }) }), caretPositionFromPoint: () => null, createRange: () => ({}) };
    assert.equal(boxIntersectsText(box, doc), false);
});

test("boxIntersectsText: DESCENDS into a same-origin iframe (coords translated)", () => {
    const innerDoc = fakeDoc({ textRect: { left: 5, top: 5, width: 40, height: 12 } });   // inner-doc coords
    const iframeEl = { tagName: "IFRAME", contentDocument: innerDoc, getBoundingClientRect: () => ({ left: 90, top: 90 }) };
    const topDoc = { elementFromPoint: () => iframeEl, caretPositionFromPoint: () => null, createRange: () => ({}) };
    // Box at top (100,100); iframe origin (90,90) → inner rect (5,5) maps to (95,95) w40 → overlaps the box.
    assert.equal(boxIntersectsText({ left: 100, top: 100, width: 24, height: 24 }, topDoc), true);
});

// --- lookViews: one capture, the requested crops. A @box token skips the @pt text-detect (no document). ---
function fakeMl() {
    const calls = [];
    return {
        _calls: calls,
        screenshot: async (target, opts = {}) => { calls.push({ target, opts }); return `shot:${target ?? "vp"}${opts.noOverlay ? ":clean" : ""}${opts.capture ? ":cap" : ""}`; },
    };
}

test("lookViews default → ONE marked crop, captured internally (no separate viewport shot)", async () => {
    const ml = fakeMl();
    const { images } = await lookViews(ml, "@box:abc", 0);
    assert.equal(images.length, 1);
    assert.equal(ml._calls.filter(c => c.target == null).length, 0, "no separate viewport capture");
    assert.equal(ml._calls[0].opts.noOverlay, undefined, "the one view is the marked one");
});

test("lookViews ['no-overlay'] → ONE clean crop", async () => {
    const ml = fakeMl();
    const { images } = await lookViews(ml, "@box:abc", 0, ["no-overlay"]);
    assert.equal(images.length, 1);
    assert.equal(ml._calls[0].opts.noOverlay, true);
});

test("lookViews ['overlay','no-overlay'] → TWO crops from ONE reused capture", async () => {
    const ml = fakeMl();
    const { images } = await lookViews(ml, "@box:abc", 0, ["overlay", "no-overlay"]);
    assert.equal(images.length, 2, "both crops returned");
    assert.equal(ml._calls.filter(c => c.target == null).length, 1, "exactly ONE tab capture (viewport)");
    assert.equal(ml._calls.filter(c => c.opts.capture).length, 2, "both crops reused that capture — no re-screenshot");
    assert.deepEqual(images.map(i => i.label), ["with region outline", "clean — no box (read text here)"]);
});
