// shot-mask.test.mjs — painting the extension's own UI out of a worker's screenshot (src/sw/shot-mask.ts): the shell's
// viewport rects scaled to the capture per answer, padded, clamped, unioned across the before and after answers,
// refused when unreadable or when they would cover most of the shot, and filled opaque through the worker's Raster.

import test from "node:test";
import assert from "node:assert/strict";
import { coverage, deviceRects, maskShot, MASK_FILL, MASK_REFUSE_SHARE } from "../src/sw/shot-mask.ts";

/** A Raster that records what is drawn and filled, and encodes to a fixed URL. */
function fakeRaster() {
    const log = { decoded: [], fills: [], fillStyles: [], drawn: 0, closed: 0, canvas: null };
    return {
        log,
        decode: async (url) => { log.decoded.push(url); return { source: { url }, width: 1600, height: 1200, close: () => { log.closed++; } }; },
        canvas: (w, h) => {
            const g = { fillStyle: "", drawImage: () => { log.drawn++; }, fillRect: (...a) => { log.fills.push(a); log.fillStyles.push(g.fillStyle); } };
            log.canvas = { w, h };
            return { width: w, height: h, getContext: () => g };
        },
        encode: async () => "data:image/png;base64,MASKED",
    };
}
const SHOT = { dataUrl: "data:image/png;base64,RAW", w: 1600, h: 1200 };
const answer = (rects, vw = 800, vh = 600) => ({ vw, vh, rects });

// --- scaling and clamping ---

test("rects are scaled by capture width / viewport width on both axes, padded 2 CSS px, and clamped to the image", () => {
    const r = deviceRects([answer([{ x: 600, y: 0, w: 300, h: 600, kind: "sidebar" }])], 1600, 1200);
    assert.deepEqual(r, [{ x: 1196, y: 0, w: 404, h: 1200, kind: "sidebar" }]);
    // A capture shorter than the viewport (the debugger's infobar: measured 1280x611 for a 1280x720 viewport) is a crop
    // of its top, not a squeeze: y keeps the width's scale, and what falls below is clamped off.
    assert.deepEqual(deviceRects([answer([{ x: 1246, y: 285, w: 34, h: 150, kind: "sidebar" }, { x: 0, y: 650, w: 10, h: 10, kind: "card" }], 1280, 720)], 1280, 611),
        [{ x: 1244, y: 283, w: 36, h: 154, kind: "sidebar" }]);
    // A capture taller than the viewport at that scale fits no layout the shell measured: refused.
    assert.throws(() => deviceRects([answer([], 100, 100)], 200, 400), /does not match the page's viewport/);
    // Each answer by its own viewport: the after answer measured at another size.
    const two = deviceRects([answer([{ x: 0, y: 0, w: 100, h: 100, kind: "card" }], 800, 600), answer([{ x: 0, y: 0, w: 100, h: 100, kind: "card" }], 400, 300)], 1600, 1200);
    assert.deepEqual(two.map((x) => x.w), [204, 408]);
});

test("a rect wholly off the image, or empty after clamping, paints nothing; no content script (null) adds nothing", () => {
    assert.deepEqual(deviceRects([answer([{ x: -500, y: 0, w: 100, h: 100, kind: "card" }, { x: 900, y: 0, w: 10, h: 10, kind: "card" }]), null], 1600, 1200), []);
    assert.deepEqual(deviceRects([null, null], 1600, 1200), []);
});

test("an answer that is not the shell's shape is refused, not read as no UI: NaN, Infinity, strings, missing fields, unknown kinds, a zero viewport", () => {
    const bad = [
        undefined, {}, { vw: 800, vh: 600 }, { vw: 0, vh: 600, rects: [] }, { vw: NaN, vh: 600, rects: [] }, { vw: 800, vh: Infinity, rects: [] },
        answer([{ x: NaN, y: 0, w: 1, h: 1, kind: "card" }]), answer([{ x: 0, y: 0, w: Infinity, h: 1, kind: "card" }]),
        answer([{ x: "0", y: 0, w: 1, h: 1, kind: "card" }]), answer([{ x: 0, y: 0, w: 1, h: 1, kind: "page" }]), answer([null]),
    ];
    for (const a of bad) assert.throws(() => deviceRects([a], 1600, 1200), /can't be read/, JSON.stringify(a));
});

// --- refusing a mask that leaves little of the page ---

test("coverage is the union's share, overlapping rects counted once, and names the kind covering most", () => {
    const rects = [{ x: 0, y: 0, w: 50, h: 100, kind: "sidebar" }, { x: 25, y: 0, w: 50, h: 100, kind: "card" }];
    const c = coverage(rects, 100, 100);
    assert.equal(c.share, 0.75);
    assert.equal(c.largest, "sidebar");
    assert.deepEqual(coverage([], 100, 100), { share: 0, largest: null });
});

test("the image viewer (the whole viewport) is refused with a sentence saying to close it, not sent to the model as a grey image", async () => {
    const raster = fakeRaster();
    await assert.rejects(maskShot(SHOT, [answer([{ x: 0, y: 0, w: 800, h: 600, kind: "lightbox" }])], raster), /image viewer is open over the page: close it/);
    assert.equal(raster.log.decoded.length, 0, "nothing was drawn");
    await assert.rejects(maskShot(SHOT, [answer([{ x: 30, y: 0, w: 770, h: 600, kind: "sidebar" }])], raster), /sidebar covers most of the page/);
});

test(`just under ${MASK_REFUSE_SHARE * 100}% is masked; at it, refused`, async () => {
    const under = answer([{ x: 0, y: 0, w: 800 * (MASK_REFUSE_SHARE - 0.05), h: 596, kind: "sidebar" }]);
    assert.equal((await maskShot(SHOT, [under], fakeRaster())).dataUrl, "data:image/png;base64,MASKED");
    const at = answer([{ x: 0, y: 0, w: 800 * (MASK_REFUSE_SHARE + 0.01), h: 600, kind: "card" }]);
    await assert.rejects(maskShot(SHOT, [at], fakeRaster()), /run card covers most/);
});

// --- painting ---

test("the union of the before and after rects is filled opaque over the capture, and the image is freed", async () => {
    const raster = fakeRaster();
    const before = answer([{ x: 700, y: 10, w: 90, h: 40, kind: "card" }]);
    const after = answer([{ x: 690, y: 20, w: 90, h: 40, kind: "card" }, { x: 100, y: 100, w: 8, h: 2, kind: "highlight" }]);
    const out = await maskShot(SHOT, [before, after], raster);
    assert.deepEqual(out, { dataUrl: "data:image/png;base64,MASKED", w: 1600, h: 1200 });
    assert.deepEqual(raster.log.canvas, { w: 1600, h: 1200 });
    assert.equal(raster.log.drawn, 1);
    assert.deepEqual(raster.log.fills, [[1396, 16, 188, 88], [1376, 36, 188, 88], [196, 196, 24, 12]]);
    assert.ok(raster.log.fillStyles.every((s) => s === MASK_FILL), "every rect in the opaque fill");
    assert.equal(raster.log.closed, 1);
});

test("no rects: the capture comes back as it was, never decoded or re-encoded", async () => {
    const raster = fakeRaster();
    assert.equal(await maskShot(SHOT, [answer([]), null], raster), SHOT);
    assert.equal(raster.log.decoded.length, 0);
});
