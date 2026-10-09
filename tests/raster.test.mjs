// raster.test.mjs — the worker's raster (src/raster.ts) under the vision helpers, against a recording fake of what a
// service worker has: fetch of a data URL, createImageBitmap, OffscreenCanvas and convertToBlob. What it pins: a helper
// handed `workerRaster` decodes, draws and encodes through those (never Image or a document canvas), a crop asks for
// the right source rect, the encoding is a PNG data URL of the canvas's bytes, and every ImageBitmap is closed, also
// when the drawing fails. That the real worker's pixels equal the page's is tests/e2e/raster.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { workerRaster, withDecoded } from "../src/raster.ts";
import { cropDataUrl } from "../src/util.ts";
import { annotate, letterboxToSquare, pickOverlayColor } from "../src/dom/locate.ts";

/**
 * Install a fake worker realm for one test: images by data URL with their sizes, bitmaps that record `close()`,
 * canvases that record their size and every drawImage, and a convertToBlob whose bytes are `blobBytes`.
 * @returns the records and an `uninstall`
 */
function fakeWorkerRealm({ images, blobBytes = new Uint8Array([1, 2, 3]) }) {
    const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
    const bitmaps = [], canvases = [], blobTypes = [];
    globalThis.fetch = async (url) => {
        if (!images[url]) throw new TypeError("Failed to fetch");
        return { blob: async () => ({ url }) };
    };
    globalThis.createImageBitmap = async (blob) => {
        const bm = { url: blob.url, ...images[blob.url], closed: false, close() { this.closed = true; } };
        bitmaps.push(bm);
        return bm;
    };
    globalThis.OffscreenCanvas = class {
        constructor(w, h) {
            this.width = w; this.height = h; this.draws = []; this.noContext = false;
            canvases.push(this);
            const draws = this.draws;
            this.ctx = new Proxy({ font: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1 }, {
                get(t, p) {
                    if (p in t) return t[p];
                    if (p === "drawImage") return (img, ...nums) => draws.push([img.url, ...nums]);
                    if (p === "getImageData") return (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
                    if (p === "measureText") return (s) => ({ width: String(s).length * 7 });
                    return () => {};
                },
                set(t, p, v) { t[p] = v; return true; },
            });
        }
        getContext() { return this.noContext ? null : this.ctx; }
        async convertToBlob(opts) { blobTypes.push(opts?.type); return new Blob([blobBytes], { type: opts?.type }); }
    };
    return {
        bitmaps, canvases, blobTypes,
        uninstall() { Object.assign(globalThis, saved); },
    };
}

const SHOT = "data:image/png;base64,SHOT";

// --- a crop through the worker's raster ---

test("cropDataUrl with workerRaster draws the dpr-scaled, clamped source rect onto an OffscreenCanvas of that size", async () => {
    const realm = fakeWorkerRealm({ images: { [SHOT]: { width: 200, height: 100 } } });
    try {
        const url = await cropDataUrl(SHOT, { left: 10, top: 20, width: 30, height: 40 }, 2, workerRaster);
        // sx 20, sy 40; sw = min(60, 200-20) = 60; sh = min(80, 100-40) = 60: clamped to the image's bottom edge.
        assert.equal(realm.canvases.length, 1);
        assert.deepEqual([realm.canvases[0].width, realm.canvases[0].height], [60, 60]);
        assert.deepEqual(realm.canvases[0].draws, [[SHOT, 20, 40, 60, 60, 0, 0, 60, 60]]);
        assert.deepEqual(realm.blobTypes, ["image/png"]);
        assert.equal(url, "data:image/png;base64,AQID");
        assert.equal(realm.bitmaps.length, 1);
        assert.ok(realm.bitmaps[0].closed, "the bitmap is closed once drawn");
    } finally { realm.uninstall(); }
});

test("a data URL that is not an image rejects with the helper's own sentence, and no canvas is made", async () => {
    const realm = fakeWorkerRealm({ images: {} });
    try {
        await assert.rejects(cropDataUrl("data:image/png;base64,NOPE", { left: 0, top: 0, width: 5, height: 5 }, 1, workerRaster), /failed to load the captured screenshot/);
        assert.equal(realm.canvases.length, 0);
    } finally { realm.uninstall(); }
});

// --- encoding ---

test("encode is the canvas's PNG bytes as base64, whole, past the chunk size of the byte-to-string step", async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, i) => (i * 31) & 0xff);
    const realm = fakeWorkerRealm({ images: {}, blobBytes: bytes });
    try {
        const url = await workerRaster.encode(workerRaster.canvas(4, 4));
        assert.ok(url.startsWith("data:image/png;base64,"));
        assert.deepEqual(new Uint8Array(Buffer.from(url.slice("data:image/png;base64,".length), "base64")), bytes);
    } finally { realm.uninstall(); }
});

// --- bitmaps are closed ---

test("a drawing that throws still closes its bitmap, and the helper rejects", async () => {
    const realm = fakeWorkerRealm({ images: { [SHOT]: { width: 50, height: 50 } } });
    try {
        await assert.rejects(withDecoded(workerRaster, SHOT, "unused", () => { throw new Error("drawing failed"); }), /drawing failed/);
        assert.equal(realm.bitmaps.length, 1);
        assert.ok(realm.bitmaps[0].closed);
    } finally { realm.uninstall(); }
});

test("annotate, letterboxToSquare and pickOverlayColor with workerRaster each close the one bitmap they decode", async () => {
    const realm = fakeWorkerRealm({ images: { [SHOT]: { width: 400, height: 200 } } });
    try {
        await annotate(SHOT, [{ rect: { left: 5, top: 5, width: 20, height: 10 }, color: "#f00", badge: 1 }], 1, workerRaster);
        await letterboxToSquare(SHOT, 100, "#141414", workerRaster);
        await pickOverlayColor(SHOT, [], undefined, workerRaster);
        assert.equal(realm.bitmaps.length, 3);
        assert.ok(realm.bitmaps.every((b) => b.closed));
        // The letterbox scales the 400×200 image by 100/400 onto a 100×100 square.
        const square = realm.canvases[1];
        assert.deepEqual([square.width, square.height], [100, 100]);
        assert.deepEqual(square.draws, [[SHOT, 0, 0, 100, 50]]);
    } finally { realm.uninstall(); }
});

// --- the full-page stitch's compose ---

test("composeStitch with workerRaster draws each tile at its scroll offset × dpr on a canvas as wide as the first tile", async () => {
    const { composeStitch } = await import("../src/ml/ml-vision.ts");
    const A = "data:image/png;base64,TILEA", B = "data:image/png;base64,TILEB";
    const realm = fakeWorkerRealm({ images: { [A]: { width: 1600, height: 1200 }, [B]: { width: 1600, height: 1200 } } });
    try {
        await composeStitch([{ y: 0, url: A }, { y: 450, url: B }], 1050, 2, workerRaster);
        assert.deepEqual([realm.canvases[0].width, realm.canvases[0].height], [1600, 2100]);
        assert.deepEqual(realm.canvases[0].draws, [[A, 0, 0], [B, 0, 900]]);
        assert.ok(realm.bitmaps.every((b) => b.closed));
    } finally { realm.uninstall(); }
});

test("composeStitch rejects when one tile does not decode, and closes the tiles that did", async () => {
    const { composeStitch } = await import("../src/ml/ml-vision.ts");
    const A = "data:image/png;base64,TILEA";
    const realm = fakeWorkerRealm({ images: { [A]: { width: 100, height: 100 } } });
    try {
        await assert.rejects(composeStitch([{ y: 0, url: A }, { y: 100, url: "data:image/png;base64,BAD" }], 200, 1, workerRaster), /failed to load a capture/);
        assert.equal(realm.canvases.length, 0);
        assert.equal(realm.bitmaps.length, 1);
        assert.ok(realm.bitmaps[0].closed);
    } finally { realm.uninstall(); }
});
