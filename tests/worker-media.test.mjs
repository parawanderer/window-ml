// worker-media.test.mjs — the answer's HUD media and python_exec's `image` of a run whose vision is the worker's
// (src/sw/worker-media.ts), in node:vm: the built worker crops each from its own capture, asks the page geometry only,
// and checks every value the page answers. Each is held to what the page's own path makes today (the same crop box,
// the same shape, the same crop transform), and to what must never reach the page: an image, a prompt, a note, a model.
//
// The page is the real page geometry (page-geometry.ts `answerGeometry`) over a jsdom document, answering the worker's
// RUN_TOOL_IN_PAGE as a message (JSON-cloned on the way), as in worker-vision-host.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { pageGeometry, answerGeometry } from "../src/dom/page-geometry.ts";
import { shootVia, _shotBox } from "../src/ml/ml-vision.ts";
import { mintPoint, mintBox } from "../src/util.ts";
import { answerMediaShape, ANSWER_MEDIA_MAX } from "../src/tools/tools.ts";
import { checkSelection, MAX_MEDIA, MAX_IMAGE } from "../src/sw/worker-answer.ts";
import { pageOnlyPython, mixedPythonRefusalFor } from "../src/sw/worker-tools.ts";
import { GEOMETRY_OPS, GEOMETRY_REFUSED, GEOMETRY_MOVED, GEOMETRY_SLOW } from "../src/sw/geometry-check.ts";
import { PY_IMAGE_NO_DOCUMENT } from "../src/sw/worker-media.ts";

const require = createRequire(import.meta.url);
const { loadBackground, jsonResponse } = require("./helpers");

const T = { timeout: 20000 };
const SAVE = { left: 300, top: 200, width: 120, height: 40 };
const DEL = { left: 500, top: 200, width: 120, height: 40 };
const PIC = { left: 100, top: 400, width: 160, height: 90 };
/** A value out of the vm's realm, so deepEqual compares it by structure. */
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const rect = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height });
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", cdp: false };

/** A PNG's first 24 bytes (signature + IHDR) for a `w`×`h` image: enough for the worker to read its size. */
function png(w, h) {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return `data:image/png;base64,${b.toString("base64")}`;
}

// --- a raster that draws nothing, recording the size of every canvas it is asked for ---

/** A Raster with no pixels: decode accepts any data URL, every canvas's size is recorded, encode mints a token. */
function blankRaster() {
    let n = 0;
    const ctx = new Proxy({}, {
        get(t, p) {
            if (p in t) return t[p];
            if (p === "getImageData") return (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
            if (p === "measureText") return (s) => ({ width: String(s).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            if (typeof p === "symbol") return undefined;
            return () => {};
        },
        set(t, p, v) { t[p] = v; return true; },
    });
    const sizes = [];
    return {
        sizes,
        decode: async () => ({ source: {}, width: 1024, height: 768, close() {} }),
        canvas: (w, h) => { sizes.push([w, h]); return { width: w, height: h, getContext: () => ctx }; },
        encode: async () => `data:image/png;base64,RASTER${++n}`,
    };
}

// --- the page: a jsdom document with a Save and a Delete button and an image ---

/** Put the page on the globals the page geometry reads for `fn`; `boxes` lays out more elements. */
async function onPage(fn) {
    const dom = new JSDOM(`<!doctype html><html><body><button id="save">Save</button><button id="del">Delete</button><img id="pic" alt="a cat" src="https://cdn.example/cat.png"></body></html>`, { pretendToBeVisual: true });
    const win = dom.window, doc = win.document;
    const placed = [];
    for (const [sel, r] of [["#save", SAVE], ["#del", DEL], ["#pic", PIC]]) {
        const el = doc.querySelector(sel);
        el.getBoundingClientRect = () => ({ ...rect(r), x: r.left, y: r.top, toJSON() {} });
        el.getClientRects = () => [el.getBoundingClientRect()];
        placed.push(el);
    }
    doc.elementFromPoint = (x, y) => placed.find((el) => { const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }) || doc.body;
    doc.elementsFromPoint = (x, y) => [doc.elementFromPoint(x, y)];
    win.scrollTo = () => {};
    const globals = { window: win, document: doc, getComputedStyle: win.getComputedStyle.bind(win), Element: win.Element, HTMLElement: win.HTMLElement, Node: win.Node, ShadowRoot: win.ShadowRoot, NodeFilter: win.NodeFilter, HTMLIFrameElement: win.HTMLIFrameElement, HTMLImageElement: win.HTMLImageElement, CSS: win.CSS, location: win.location };
    const before = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    try { return await fn(doc); }
    finally {
        for (const [k, d] of Object.entries(before)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
        win.close();
    }
}

// --- the worker, wired to the page ---

/**
 * The built worker with the run's tab 3 showing (document `doc-3`), its capture `shot`, and the page answering geometry
 * with its real page geometry, unless `page(geometry, n)` answers first (undefined falls through). Every message the
 * worker sent the tab is in `bg.tabMessages`.
 */
function world({ shot = png(1024, 768), page } = {}) {
    const geo = pageGeometry();
    let n = 0;
    const raster = blankRaster();
    const bg = loadBackground({
        config,
        openTabs: [{ id: 3, windowId: 1, active: true, url: "https://site.example/" }],
        onCaptureTab: async () => shot,
        onTabMessage: async (_tabId, msg) => {
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type !== "RUN_TOOL_IN_PAGE" || !msg.payload?.geometry) return undefined;
            const q = JSON.parse(JSON.stringify(msg.payload.geometry));
            const own = page ? await page(q, ++n) : undefined;
            if (own !== undefined) return JSON.parse(JSON.stringify(own));
            const a = await answerGeometry(geo, q);
            return JSON.parse(JSON.stringify(a ? { result: "", geometry: a } : { result: "Error: unknown op" }));
        },
    });
    const wv = bg.context.__mlWorkerVisionForTest;
    wv.seedRun("run-1", 3);
    wv.useRaster(raster);
    return { bg, wv, raster, geoMsgs: () => bg.tabMessages.filter((a) => a[1].type === "RUN_TOOL_IN_PAGE").map((a) => a[1].payload.geometry) };
}

/** A geometry reply of the page's own making, for op `op` only. */
const answer = (op, reply) => (q) => (q.op === op ? { result: "", geometry: { seq: q.seq, reply } } : undefined);

/**
 * Everything the worker sent the page was a SHOT_RECTS read or a geometry question, pinned to the call's document, with
 * no image, no note, no prompt and no model name in it.
 */
function assertOnlyGeometry(bg, forbidden = []) {
    for (const [tabId, msg, o] of bg.tabMessages) {
        assert.equal(tabId, 3);
        assert.equal(o?.documentId, "doc-3", `pinned to the call's document: ${JSON.stringify(msg)}`);
        if (msg.type === "SHOT_RECTS") continue;
        assert.equal(msg.type, "RUN_TOOL_IN_PAGE");
        assert.deepEqual(Object.keys(msg.payload).sort(), ["geometry", "runId"]);
        assert.ok(GEOMETRY_OPS.includes(msg.payload.geometry.op), msg.payload.geometry.op);
        const s = JSON.stringify(msg);
        assert.doesNotMatch(s, /data:image|base64/, "no image");
        for (const f of forbidden) assert.ok(!s.includes(f), `the page was sent "${f}": ${s}`);
    }
}

/** What the page's own crop of `selector` (the `index`th match) makes, over the page's geometry: the crop canvas's size. */
async function pageCropSize(selector, opts) {
    const raster = blankRaster();
    await shootVia({ capture: async () => ({ dataUrl: png(1024, 768) }), geo: pageGeometry(), raster }, selector, opts);
    return raster.sizes.at(-1);
}

// --- the answer's media: the page's shape, the worker's crops ---

/** What injected.ts `captureAnswer` built for each element before this change (its kind, mode and path). */
const oldShape = (el, show, elPath) => {
    const isImg = el instanceof HTMLImageElement;
    return { selector: elPath(el), kind: isImg ? "image" : "element", mode: show || (isImg ? "inline" : "highlight") };
};

test("each media item's shape is what the page's own capture gave it: an <img> inline, anything else a highlight, show overriding", T, async () => {
    await onPage(async (doc) => {
        const { elPath } = await import("../src/dom/dom.ts");
        const els = [doc.querySelector("#pic"), doc.querySelector("#save"), doc.querySelector("#del")];
        for (const show of [undefined, "inline", "highlight"]) {
            assert.deepEqual(answerMediaShape(els, show).map(({ image, ...m }) => { assert.equal(image, ""); return m; }), els.map((el) => oldShape(el, show, elPath)));
        }
        const many = Array.from({ length: 9 }, () => doc.querySelector("#save"));
        assert.equal(answerMediaShape(many).length, ANSWER_MEDIA_MAX);
        assert.equal(ANSWER_MEDIA_MAX, MAX_MEDIA, "the page makes no more items than the worker accepts");
    });
});

test("the page's selector resolution for a worker crop captures nothing: no capture call, each item its shape with an empty image", T, async () => {
    await onPage(async () => {
        const { makeDomTools } = await import("../src/tools/tools.ts");
        const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
        const captured = [];
        const answerTool = makeDomTools(defineTool, undefined, async (els) => { captured.push(els.length); return els.map(() => ({ image: "data:image/png;base64,PAGE" })); }).find((t) => t.name === "answer");
        const shapeOnly = await answerTool.selectAnswer("#pic, #save", undefined, "a note", undefined, false);
        assert.deepEqual(captured, [], "nothing captured in the page");
        assert.equal(shapeOnly.count, 2);
        assert.deepEqual(shapeOnly.media.map((m) => ({ ...m })), [
            { image: "", selector: "body > button#save", kind: "element", mode: "highlight" },
            { image: "", selector: "body > img#pic", kind: "image", mode: "inline" },
        ], "each item its shape, with no image and no note");
        const pageBuilt = await answerTool.selectAnswer("#pic", undefined, "a note", undefined);
        assert.deepEqual(captured, [1], "positive control: a page-built run's resolution still captures");
        assert.equal(pageBuilt.media[0].image, "data:image/png;base64,PAGE");
    });
});

test("the worker crops each item from its own capture, the box the page's crop of the same element uses, and asks the page geometry only", T, async () => {
    await onPage(async () => {
        const w = world();
        const media = [{ image: "", selector: "body > img#pic", kind: "image", mode: "inline" }];
        const out = plain(await w.wv.workerAnswerMedia("run-1", 3, "doc-3", "#pic", undefined, media));
        assert.equal(out.length, 1);
        assert.match(out[0].image, /^data:image\/png;base64,RASTER\d+$/, "a crop of the worker's raster");
        assert.deepEqual({ ...out[0], image: "" }, media[0], "the page's shape kept as it was");
        assert.deepEqual(w.raster.sizes.at(-1), await pageCropSize("#pic", { noOverlay: true }), "the page's crop box");
        assert.deepEqual(w.raster.sizes.at(-1), [160, 90], "the image as drawn, not its source file");
        assert.equal(w.bg.captures.length, 1, "one capture for the item");
        assertOnlyGeometry(w.bg, ["cdn.example", "a cat"]);
    });
});

test("item i is the selector's i-th match, or the call's own index for every item", T, async () => {
    await onPage(async () => {
        const w = world();
        const two = [{ image: "", kind: "element", mode: "highlight" }, { image: "", kind: "element", mode: "highlight" }];
        const out = plain(await w.wv.workerAnswerMedia("run-1", 3, "doc-3", "button", undefined, two));
        assert.ok(out.every((m) => m.image.startsWith("data:image/png")));
        assert.deepEqual(w.geoMsgs().filter((g) => g.op === "target").map((g) => [g.selector, g.index]), [["button", 0], ["button", 1]]);
        assert.deepEqual(w.raster.sizes.slice(-2), [[120, 40], [120, 40]]);
        const w2 = world();
        await w2.wv.workerAnswerMedia("run-1", 3, "doc-3", "button", 1, two.slice(0, 1));
        assert.deepEqual(w2.geoMsgs().filter((g) => g.op === "target").map((g) => g.index), [1]);
    });
});

// --- the answer's media: every value the page answers is checked ---

test("checkSelection with the worker cropping: a page that sends any image of its own is refused whole; its shape alone passes", T, () => {
    const shape = { image: "", selector: "body > img#pic", kind: "image", mode: "inline" };
    assert.deepEqual(checkSelection({ count: 1, preview: "img", media: [shape] }, { mediaInWorker: true }), { count: 1, preview: "img", media: [shape] }, "positive control");
    const img = "data:image/png;base64,iVBORw0KGgo=";
    assert.equal(checkSelection({ count: 1, media: [{ ...shape, image: img }] }, { mediaInWorker: true }), null, "an image the page drew");
    assert.notEqual(checkSelection({ count: 1, media: [{ ...shape, image: img }] }), null, "the page-built path still takes the page's crops");
    for (const bad of [
        { count: NaN }, { count: -1 }, { count: 1e20 }, { count: "3" }, { count: 1, preview: 7 },
        { count: 1, media: Array.from({ length: MAX_MEDIA + 1 }, () => shape) }, { count: 1, media: "x" },
        { count: 1, media: [{ ...shape, kind: "video" }] }, { count: 1, media: [{ ...shape, mode: "popup" }] },
        { count: 1, media: [{ ...shape, selector: "s".repeat(1001) }] }, { count: 1, media: [{ ...shape, image: 5 }] }, { count: 1, media: [null] },
        { count: 1, media: [{ ...shape, image: "https://tracker.example/b.png" }] },
    ]) assert.equal(checkSelection(bad, { mediaInWorker: true }), null, JSON.stringify(bad).slice(0, 120));
    assert.equal(checkSelection({ count: 1, preview: "p".repeat(5000) }, { mediaInWorker: true }).preview.length, 1000, "a preview is cut to the page's own length");
});

test("an element the page puts off the capture, or at a huge offset, keeps its chip with no image; the others are still cropped", T, async () => {
    await onPage(async () => {
        const off = world({ page: (q) => (q.op === "target" && q.index === 0 ? { result: "", geometry: { seq: q.seq, reply: { rect: rect({ left: 5000, top: 200, width: 100, height: 40 }) } } } : undefined) });
        const two = [{ image: "", kind: "element", mode: "highlight" }, { image: "", kind: "element", mode: "highlight" }];
        const out = plain(await off.wv.workerAnswerMedia("run-1", 3, "doc-3", "button", undefined, two));
        assert.equal(out[0].image, "", "off the capture: no crop");
        assert.match(out[1].image, /^data:image\/png/, "positive control: the next item is cropped");
        const huge = world({ page: (q) => (q.op === "target" ? { result: "", geometry: { seq: q.seq, reply: { rect: rect({ left: 1e9, top: -1e9, width: 1e9, height: 1e9 }) } } } : undefined) });
        const h = plain(await huge.wv.workerAnswerMedia("run-1", 3, "doc-3", "button", undefined, two.slice(0, 1)));
        assert.equal(h[0].image, "", "clamped to the bounds and still off the capture");
    });
});

test("a malformed geometry answer (NaN, a wrong type) refuses the crops: no image for that item or any after it, and nothing more asked", T, async () => {
    await onPage(async () => {
        for (const reply of [{ rect: { left: NaN, top: 0, right: 10, bottom: 10, width: 10, height: 10 } }, { rect: "everything" }, { w: 1024 }]) {
            const w = world({ page: answer("target", reply) });
            const two = [{ image: "", kind: "element", mode: "highlight" }, { image: "", kind: "element", mode: "highlight" }];
            const out = plain(await w.wv.workerAnswerMedia("run-1", 3, "doc-3", "button", undefined, two));
            assert.deepEqual(out.map((m) => m.image), ["", ""], JSON.stringify(reply));
            assert.equal(w.geoMsgs().length, 1, "the second item was never asked about");
            assert.equal(w.bg.captures.length, 0, "nothing captured");
        }
    });
});

test("a document change while the media are cropped drops every image from then on; a call with no document asks the page nothing", T, async () => {
    await onPage(async () => {
        let w;
        w = world({ page: (q) => { if (q.op === "view") w.bg.commit(3, { documentId: "doc-3b" }); return undefined; } });
        const out = plain(await w.wv.workerAnswerMedia("run-1", 3, "doc-3", "#save", undefined, [{ image: "", kind: "element" }, { image: "", kind: "element" }]));
        assert.deepEqual(out.map((m) => m.image), ["", ""]);
        const none = world();
        const n = plain(await none.wv.workerAnswerMedia("run-1", 3, null, "#save", undefined, [{ image: "", kind: "element" }]));
        assert.deepEqual(n, [{ image: "", kind: "element" }]);
        assert.equal(none.bg.tabMessages.length, 0, "no document: the page is not asked");
    });
});

test("a crop past the longest image the card keeps, or one the tab navigated away under while it was drawn, is dropped (the chip stays)", T, async () => {
    await onPage(async () => {
        const big = world();
        big.raster.encode = async () => `data:image/png;base64,${"A".repeat(MAX_IMAGE + 4)}`;
        const out = plain(await big.wv.workerAnswerMedia("run-1", 3, "doc-3", "#save", undefined, [{ image: "", kind: "element" }]));
        assert.deepEqual(out, [{ image: "", kind: "element" }]);
        const ok = world();
        ok.raster.encode = async () => `data:image/png;base64,${"A".repeat(1000)}`;
        assert.equal(plain(await ok.wv.workerAnswerMedia("run-1", 3, "doc-3", "#save", undefined, [{ image: "", kind: "element" }]))[0].image.length, 1022, "positive control: a crop within the bound is kept");
        let moved;
        moved = world();
        // The navigation lands while the crop is drawn, after the capture's own document check.
        moved.raster.encode = async () => { moved.bg.commit(3, { documentId: "doc-3b" }); return "data:image/png;base64,AAAA"; };
        const m = plain(await moved.wv.workerAnswerMedia("run-1", 3, "doc-3", "#save", undefined, [{ image: "", kind: "element" }]));
        assert.equal(m[0].image, "", "a crop that may be of another page");
    });
});

test("a page that stalls its geometry answer gets no image, bounded by the per-question timeout", T, async () => {
    await onPage(async () => {
        const w = world({ page: (q) => (q.op === "target" ? new Promise((r) => setTimeout(() => r({ result: "", geometry: { seq: q.seq, reply: { rect: rect(SAVE) } } }), 400)) : undefined) });
        const t0 = Date.now();
        const out = plain(await w.wv.workerAnswerMedia("run-1", 3, "doc-3", "#save", undefined, [{ image: "", kind: "element" }], { opMs: 80 }));
        assert.equal(out[0].image, "");
        assert.ok(Date.now() - t0 < 2000, "bounded");
        const h = w.wv.workerVisionHost("run-1", 3, "doc-3", { opMs: 80 });
        await assert.rejects(h.geo.target({ selector: "#save" }), (e) => e.message === GEOMETRY_SLOW, "the same bound a vision call has");
    });
});

// --- python_exec's image: the worker's crop, the page's crop transform ---

test("python's image of a selector, an @pt with a margin, and an @box: the page's crop box and the page's crop transform (`_shotBox`)", T, async () => {
    await onPage(async () => {
        const pt = mintPoint(360, 220);
        const box = mintBox({ left: 500, top: 200, right: 620, bottom: 240 });
        for (const [image, margin] of [["#save", 0], [pt, 0], [pt, 30], [box, 0]]) {
            const w = world();
            const r = plain(await w.wv.workerPythonImage("run-1", 3, image, margin));
            assert.match(r.image, /^data:image\/png;base64,RASTER\d+$/, image);
            assert.equal(r.documentId, "doc-3");
            assert.deepEqual(r.imageBox, _shotBox(image, margin), `${image} m${margin}: the page's crop transform`);
            assert.deepEqual(w.raster.sizes.at(-1), await pageCropSize(image, { raw: true, margin }), `${image} m${margin}: the page's crop box`);
            assertOnlyGeometry(w.bg);
        }
    });
});

test("python's image refuses as the page's does for a missing element, and with the host's fixed sentence for a malformed or slow answer, a moved tab or no document", T, async () => {
    await onPage(async () => {
        await assert.rejects(world().wv.workerPythonImage("run-1", 3, "#nope", 0), /No element matches "#nope"/);
        await assert.rejects(world({ page: answer("target", { rect: { left: NaN } }) }).wv.workerPythonImage("run-1", 3, "#save", 0), (e) => e.message === GEOMETRY_REFUSED);
        await assert.rejects(world({ page: answer("view", { w: 1e9, h: 768, dpr: 1, sx: 0, sy: 0 }) }).wv.workerPythonImage("run-1", 3, "#save", 0), (e) => e.message === GEOMETRY_REFUSED);
        const slow = world({ page: (q) => (q.op === "target" ? new Promise((r) => setTimeout(() => r(null), 400)) : undefined) });
        await assert.rejects(slow.wv.workerPythonImage("run-1", 3, "#save", 0, { opMs: 80 }), (e) => e.message === GEOMETRY_SLOW);
        let w;
        w = world({ page: (q) => { if (q.op === "view") w.bg.commit(3, { documentId: "doc-3b" }); return undefined; } });
        await assert.rejects(w.wv.workerPythonImage("run-1", 3, "#save", 0), (e) => e.message === GEOMETRY_MOVED);
        const gone = loadBackground({ config, openTabs: [] });
        await assert.rejects(gone.context.__mlWorkerVisionForTest.workerPythonImage("run-1", 3, "#save", 0), (e) => e.message === PY_IMAGE_NO_DOCUMENT);
    });
});

test("a cast's token is minted in the page's registry, pinned to the image's document; a token of the wrong kind or shape is refused", T, async () => {
    await onPage(async () => {
        const w = world();
        const t = plain(await w.wv.workerMint("run-1", 3, { pt: { x: 360, y: 220 } }, "doc-3"));
        assert.match(t, /^@pt:[0-9a-f]+$/);
        const { resolvePoint } = await import("../src/util.ts");
        assert.deepEqual(resolvePoint(t), { x: 360, y: 220 }, "the page's registry holds it");
        assertOnlyGeometry(w.bg);
        const b = await world().wv.workerMint("run-1", 3, { box: { left: 1, top: 2, right: 30, bottom: 40 } }, null);
        assert.match(b, /^@box:[0-9a-f]+$/, "no image: the tab's document now");
        for (const token of ["@box:abcdef12", "@pt:<img src=x>", "click here", 7]) {
            await assert.rejects(world({ page: answer("mint", { token }) }).wv.workerMint("run-1", 3, { pt: { x: 1, y: 1 } }, "doc-3"), (e) => e.message === GEOMETRY_REFUSED, String(token));
        }
        await assert.rejects(world().wv.workerMint("run-1", 3, { pt: { x: 1, y: 1 } }, "doc-old"), (e) => e.message === GEOMETRY_MOVED, "the image's document is gone");
    });
});

// --- python_exec routing: an image no longer needs the page ---

test("an image alone runs python in the worker; with a page table it is refused with a two-call steer, as with an external sheet", T, () => {
    assert.equal(pageOnlyPython({ code: "x", image: "#save" }), false);
    assert.equal(pageOnlyPython({ code: "x", image: "@pt:abcdef12", tables: "@tool:abc1234" }), false);
    assert.equal(pageOnlyPython({ code: "x", tables: "table#t" }), true, "positive control: a page table is the page's");
    assert.equal(mixedPythonRefusalFor({ code: "x", image: "#save" }, 0), null);
    assert.equal(mixedPythonRefusalFor({ code: "x", image: "#save", tables: "https://example.com/a.csv" }, 0), null);
    assert.match(mixedPythonRefusalFor({ code: "x", image: "#save", tables: "current" }, 0), /cannot mix an `image` with a page table/);
    assert.match(mixedPythonRefusalFor({ code: "x", image: "#save", tables: { t: "table#t" } }, 0), /cannot mix an `image` with a page table/);
    assert.match(mixedPythonRefusalFor({ code: "x", tables: { t: "table#t", s: "https://docs.google.com/spreadsheets/d/x/edit" } }, 1), /cannot mix an external Google Sheet/);
    assert.equal(mixedPythonRefusalFor({ code: "x", tables: "table#t" }, 0), null, "a page table alone goes to the page");
});

// --- python_exec with an image in a worker-built run: the call never reaches the page ---

test("a worker-built run's python_exec with an image and a cast: the sandbox gets the worker's crop, the token is the page's, and the page is sent geometry only", T, async () => {
    await onPage(async () => {
        const geo = pageGeometry();
        const raster = blankRaster();
        const runs = [];
        let turns = 0, bg, last = null;
        bg = loadBackground({
            config: { ...config, autoApprovePython: true, debugMode: "off" },
            openTabs: [{ id: 3, windowId: 1, active: true, url: "https://site.example/" }],
            onCaptureTab: async () => png(1024, 768),
            onFetch: (call) => {
                if (!call.url.includes("/chat/completions")) return jsonResponse({});
                last = call.body.messages;
                return ++turns === 1
                    ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "python_exec", arguments: JSON.stringify({ code: "return [10, 5]", image: "#save", cast: "pt" }) } }] } }] })
                    : jsonResponse({ choices: [{ message: { content: "done" } }] });
            },
            onPyRun: async (msg) => {
                if (msg.type !== "PY_RUN") return { ok: true, prewarm: "started" };
                runs.push(JSON.parse(JSON.stringify(msg)));
                return { ok: true, value: [10, 5], stdout: "" };
            },
            onTabMessage: async (_t, msg) => {
                if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
                if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
                if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
                if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
                if (msg.payload.finish) return { result: "" };
                if (msg.payload.geometry) { const a = await answerGeometry(geo, JSON.parse(JSON.stringify(msg.payload.geometry))); return JSON.parse(JSON.stringify({ result: "", geometry: a })); }
                if (msg.payload.renderOnly || msg.payload.precheck) return {};
                return { result: "FROM THE PAGE" };
            },
        });
        bg.context.__mlWorkerVisionForTest.useRaster(raster);
        await bg.context.__mlStartUserRunForTest(3, { task: "find the spot", surface: "hud" });
        for (let i = 0; i < 2000 && turns < 2; i++) await new Promise((r) => setTimeout(r, 0));
        assert.equal(runs.length, 1, "positive control: the sandbox ran the call");
        assert.match(runs[0].image, /^data:image\/png;base64,RASTER\d+$/, "the worker's crop");
        assert.deepEqual(raster.sizes.at(-1), [120, 40], "#save's box");
        const result = (last ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
        const token = result.match(/@pt:[0-9a-f]+/)?.[0];
        assert.ok(token, result.slice(0, 300));
        assert.match(result, /at \(310, 205\)/, "(10, 5) in #save's crop is (310, 205) on the page");
        const { resolvePoint } = await import("../src/util.ts");
        assert.deepEqual(resolvePoint(token), { x: 310, y: 205 }, "minted in the page's registry");
        const sends = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE").map(([, m]) => m.payload);
        assert.deepEqual(sends.filter((p) => p.name === "python_exec" && !p.renderOnly && !p.precheck), [], "the call never went to the page");
        for (const p of sends.filter((x) => x.geometry)) assert.doesNotMatch(JSON.stringify(p), /data:image|return \[10|find the spot|default-model/);
        assert.ok(sends.some((p) => p.geometry?.op === "mint"), "positive control: the mint was asked of the page");
    });
});

// --- python_exec's cast with no crop transform ---

test("a cast over an image whose crop transform is unknown is refused with a fixed sentence, and nothing is minted; with one it is projected and minted", T, async () => {
    const { buildPythonTool, CAST_NO_TRANSFORM } = await import("../src/python/python-tool.ts");
    const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
    const minted = [];
    const tool = (imageBox, value = [10, 5]) => buildPythonTool({
        defineTool, _queryAll: () => [],
        pythonExec: async () => ({ ok: true, value, stdout: "", inputImage: "data:image/png;base64,AAAA", ...(imageBox ? { imageBox } : {}) }),
        _mintToken: async (q) => { minted.push(q); return "@pt:abcdef12"; },
    });
    const text = (r) => (typeof r === "string" ? r : r.content);
    for (const cast of ["pt", "box"]) {
        const r = text(await tool(null, cast === "box" ? [1, 2, 30, 40] : [10, 5]).run({ code: "x", image: "#save", cast }));
        assert.ok(r.includes(CAST_NO_TRANSFORM), r);
    }
    assert.deepEqual(minted, [], "nothing minted from raw image pixels");
    const ok = text(await tool({ left: 300, top: 200, dpr: 1 }).run({ code: "x", image: "#save", cast: "pt" }));
    assert.match(ok, /@pt:abcdef12 at \(310, 205\)/, "positive control");
    assert.deepEqual(minted, [{ pt: { x: 310, y: 205 } }]);
});
