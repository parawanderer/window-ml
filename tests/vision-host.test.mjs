// vision-host.test.mjs — the vision tool bodies (look, locate) reach the page only through their VisionHost, and the
// one-shot model request a host builds itself (`oneShotRequest`) is the one the page's `ml.chat` sends.
//
// The first half runs each body twice on the same small page: once over a FAKE host that answers from canned data with
// no DOM in the process at all (so a body that touched `window` or `document` itself would throw), and once over the
// page's own host on a jsdom document. The two must give the model the same text. The fake host also records what the
// body asked of it, which pins the geometry ops each body uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { buildLookTool, buildLocateTool, captureVerify } from "../src/tools/builtin-tools.ts";
import { pageVisionHost } from "../src/dom/page-geometry.ts";
import { defineTool } from "../src/ml/ml-tool-factories.ts";
import { oneShotRequest } from "../src/ml/ml-chat.ts";
import { VISION_NUM_CTX } from "../src/util.ts";

const require = createRequire(import.meta.url);
const { loadPageWorld } = require("./helpers");

const SHOT = "data:image/png;base64,SHOT";
const VIEW = { w: 1024, h: 768, dpr: 1, sx: 0, sy: 0 };
const SAVE = { left: 300, top: 200, width: 120, height: 40 };
const DEL = { left: 500, top: 200, width: 120, height: 40 };
const rect = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height });

// --- a raster that draws nothing: images are tokens, every canvas the same blank ---

/** A Raster with no pixels: decode accepts any data URL, the 2D context records nothing, encode mints a token. */
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
    return {
        decode: async () => ({ source: {}, width: VIEW.w, height: VIEW.h, close() {} }),
        canvas: (w, h) => ({ width: w, height: h, getContext: () => ctx }),
        encode: async () => `data:image/png;base64,RASTER${++n}`,
    };
}

// --- the fake host: canned answers, every call recorded ---

/**
 * A VisionHost whose geometry answers from `answers` (op name → reply or fn(query) → reply), whose shots are `SHOT`
 * and whose model replies `reply`. `calls` records every op, shot and model call in order.
 */
function fakeHost(answers, reply) {
    const calls = [];
    const op = (name) => async (q) => {
        calls.push(["geo." + name, q]);
        const a = answers[name];
        if (a === undefined) throw new Error(`the body asked geo.${name}, which this case did not expect`);
        return typeof a === "function" ? a(q) : a;
    };
    const geo = Object.fromEntries(["view", "target", "marks", "snap", "cell", "mint", "legend", "crossesText", "focus", "stitchBegin", "stitchTile", "stitchEnd"].map((n) => [n, op(n)]));
    return {
        calls,
        capture: async () => { calls.push(["capture"]); return { dataUrl: SHOT }; },
        geo,
        shoot: async (target, opts) => { calls.push(["shoot", target, opts]); return SHOT; },
        chat: async (prompt, o) => { calls.push(["chat", prompt, o]); return reply; },
        raster: blankRaster(),
        memory: null,
    };
}

// --- the page host on jsdom: the same page, its own geometry ---

/**
 * Put a jsdom page with a Save and a Delete button on the globals the page geometry reads, run `fn`, and take them away
 * again. jsdom has no layout, so each button gets its box, and `elementFromPoint` hit-tests those boxes.
 */
async function onPage(fn) {
    const dom = new JSDOM(`<!doctype html><html><body><button id="save">Save</button><button id="del">Delete</button></body></html>`, { pretendToBeVisual: true });
    const win = dom.window, doc = win.document;
    const placed = [];
    for (const [sel, r] of [["#save", SAVE], ["#del", DEL]]) {
        const el = doc.querySelector(sel);
        el.getBoundingClientRect = () => ({ ...rect(r), x: r.left, y: r.top, toJSON() {} });
        el.getClientRects = () => [el.getBoundingClientRect()];
        placed.push(el);
    }
    doc.elementFromPoint = (x, y) => placed.find((el) => { const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }) || doc.body;
    doc.elementsFromPoint = (x, y) => [doc.elementFromPoint(x, y)];
    const globals = { window: win, document: doc, getComputedStyle: win.getComputedStyle.bind(win), Element: win.Element, HTMLElement: win.HTMLElement, Node: win.Node, ShadowRoot: win.ShadowRoot, NodeFilter: win.NodeFilter, HTMLIFrameElement: win.HTMLIFrameElement, HTMLImageElement: win.HTMLImageElement, CSS: win.CSS, location: win.location };
    const before = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    try { return await fn(); }
    finally {
        for (const [k, d] of Object.entries(before)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
        win.close();
    }
}

/** The page's host, with its shot and its model call stubbed (no tab, no backend) and the blank raster. */
function stubbedPageHost(reply) {
    const ml = { screenshot: async () => SHOT, chat: async () => reply };
    return { ...pageVisionHost(ml), raster: blankRaster() };
}

const noDom = () => assert.equal(typeof globalThis.document, "undefined", "the fake host's run has no DOM in the process");

// --- look and locate: the same text over the fake host and over the page's ---

test("delegated look of an element: the fake host's run gives the model the page host's text, through shoot, chat and two geometry ops", async () => {
    const LEGEND = { controls: [{ name: "Save", role: "button", selector: "#save" }], media: [], boundaries: [], text: [], moreControls: 0, moreMedia: 0 };
    const fake = fakeHost({ target: { rect: rect(SAVE) }, legend: LEGEND }, "A blue Save button.");
    noDom();
    const fromFake = await buildLookTool({ defineTool }, { model: "reader-vl", host: fake }).run({ selector: "#save" });
    assert.deepEqual(fake.calls.map((c) => c[0]), ["shoot", "chat", "geo.target", "geo.legend"]);
    assert.deepEqual(fake.calls[0].slice(1), ["#save", { fullPage: false, index: 0, margin: 0 }]);
    assert.deepEqual(fake.calls[1][2], { images: [SHOT], model: "reader-vl", maxTokens: 512, numCtx: VISION_NUM_CTX });
    assert.deepEqual(fake.calls[2][1], { selector: "#save", index: 0, scroll: false }, "the legend's box: the element where it is, not scrolled");
    assert.deepEqual(fake.calls[3][1], { box: { left: 300, top: 200, right: 420, bottom: 240 } });

    const fromPage = await onPage(() => buildLookTool({ defineTool }, { model: "reader-vl", host: stubbedPageHost("A blue Save button.") }).run({ selector: "#save" }));
    assert.equal(fromFake.content, fromPage.content);
    assert.match(fromFake.content, /^A blue Save button\.\n\nDOM in view .*\n• controls: «Save» `#save`$/);
    assert.equal(fromFake.render.prompt, fromPage.render.prompt);
    assert.equal(fromFake.elements, undefined, "a host without a DOM hands back no live elements");
    assert.equal(fromPage.elements.length, 1, "the page's host does, for the debug side channel");
});

test("locate by Set-of-Marks: the fake host's run gives the model the page host's text, through view, marks, shoot and chat", async () => {
    const mark = (ref, id, name, sel, r) => ({ ref, id, role: "button", name, selector: sel, rect: rect(r) });
    const fake = fakeHost({ view: VIEW, marks: { total: 2, marks: [mark(1, 1, "Save", "#save", SAVE), mark(2, 2, "Delete", "#del", DEL)], allOpaque: false, opaque: null } }, "1");
    const args = { description: "a blue button labelled Save", strategy: "marks" };
    noDom();
    const fromFake = await buildLocateTool({ defineTool }, { model: "reader-vl", host: fake }).run(args);
    assert.deepEqual(fake.calls.map((c) => c[0]), ["geo.view", "geo.marks", "shoot", "chat"]);
    assert.deepEqual(fake.calls[1][1], { filter: "clickables", box: { left: 0, top: 0, right: 1024, bottom: 768 }, scoped: false, max: 150, badge: 40 });
    assert.deepEqual(fake.calls[2].slice(1), [null, {}], "one viewport capture to badge");
    assert.deepEqual(fake.calls[3][2], { images: ["data:image/png;base64,RASTER1"], model: "reader-vl", numCtx: VISION_NUM_CTX, maxTokens: 64 });

    const fromPage = await onPage(() => buildLocateTool({ defineTool }, { model: "reader-vl", host: stubbedPageHost("1") }).run(args));
    assert.equal(fromFake.content, fromPage.content);
    assert.match(fromFake.content, /^Matched "a blue button labelled Save" → #1 \[button\] "Save" → #save\n/);
    assert.deepEqual(fromFake.render.substeps.map((s) => s.prompt), fromPage.render.substeps.map((s) => s.prompt));
    assert.equal(fromPage.elements[0].id, "save", "the page's host hands back the picked element");
});

test("locate by grid: the cell is snapped through geo.cell, and the single element in it is the answer on both hosts", async () => {
    const fake = fakeHost({ view: VIEW, cell: { marks: [{ ref: 1, id: 1, role: "button", name: "Save", selector: "#save", rect: rect(SAVE) }], opaque: null } }, "2");
    const args = { description: "a blue button labelled Save", strategy: "grid" };
    noDom();
    const fromFake = await buildLocateTool({ defineTool }, { model: "reader-vl", host: fake }).run(args);
    assert.deepEqual(fake.calls.map((c) => c[0]), ["geo.view", "shoot", "chat", "geo.cell"]);
    const fromPage = await onPage(() => buildLocateTool({ defineTool }, { model: "reader-vl", host: stubbedPageHost("2") }).run(args));
    assert.equal(fromFake.content, fromPage.content);
    assert.match(fromFake.content, /^Grid cell 2 → \[button\] "Save" → #save\n/);
});

test("click verify for a text-only driver: a point minted through geo.mint, its area shot, the reader asked, the legend read", async () => {
    const fake = fakeHost({ mint: { token: "@pt:abc" }, legend: { controls: [], media: [], boundaries: [], text: [], moreControls: 0, moreMedia: 0 } }, "A menu opened.");
    noDom();
    const v = await captureVerify(fake, { driverSees: false, visionModel: "reader-vl" }, { x: 360, y: 220 }, "clicked");
    assert.deepEqual(fake.calls.map((c) => c[0]), ["geo.mint", "shoot", "geo.legend", "chat"]);
    assert.deepEqual(fake.calls[0][1], { pt: { x: 360, y: 220 } });
    assert.deepEqual(fake.calls[1].slice(1), ["@pt:abc", { margin: 150, noOverlay: true }]);
    assert.deepEqual(fake.calls[2][1], { box: { left: 210, top: 70, right: 510, bottom: 370 } });
    assert.deepEqual(fake.calls[3][2], { images: [SHOT], model: "reader-vl", maxTokens: 256, numCtx: VISION_NUM_CTX });
    assert.match(v.content, /^\n\n👁 Here's the area where you clicked\. You can't see images, so this is reader-vl's description:\nA menu opened\. The target you clicked is at the CENTRE of this crop; to see the exact click point, look\(\{ selector: "@pt:abc" \}\)\.$/);
});

// --- oneShotRequest: the request a host builds is the one ml.chat sends ---

/** What the page's `ml.chat(prompt, o)` sends to the worker, in a page world over the built bundle. */
async function pageChatPayload(prompt, o) {
    let payload = null;
    const world = loadPageWorld({ onRuntimeMessage: (msg) => { if (msg.type === "FETCH_LLM") payload = msg.payload; return { data: "ok" }; } });
    await world.ml.chat(prompt, o);
    return payload;
}

for (const [what, prompt, o] of [
    ["look's delegated reader", "Describe the current page concisely — what is shown and what stands out.", { images: [SHOT], model: "reader-vl", maxTokens: 512, numCtx: VISION_NUM_CTX }],
    ["locate's grounding call", 'Locate "a blue button" in this image. Reply with ONLY its bounding box as four numbers x1,y1,x2,y2.', { images: [SHOT], model: "qwen-ground", maxTokens: 64, numCtx: VISION_NUM_CTX }],
    ["verify's 256-token reader", "The image is a crop of the page just AFTER a \"clicked\" action.", { images: [SHOT], model: null, maxTokens: 256, numCtx: VISION_NUM_CTX }],
]) {
    test(`oneShotRequest is byte for byte what ml.chat sends for ${what}`, async () => {
        const sent = await pageChatPayload(prompt, o);
        assert.ok(sent, "the page sent a FETCH_LLM");
        assert.equal(JSON.stringify(oneShotRequest(prompt, o)), JSON.stringify(sent));
    });
}

test("oneShotRequest inside a run carries the run's session as an agent request", () => {
    assert.deepEqual(oneShotRequest("p", { images: [], model: "m", maxTokens: 8, numCtx: null, session: "run:abc" }).hint, { use: "agent", session: "run:abc" });
    assert.equal("images" in oneShotRequest("p", { images: [], model: "m", maxTokens: 8, numCtx: null }).messages[0], false, "no images, no images key, as ml.chat");
});
