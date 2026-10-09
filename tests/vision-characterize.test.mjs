// vision-characterize.test.mjs — what the vision tools (look, locate, the verify after click/type/navigate) of a run the
// WORKER built do today, pinned ahead of moving their screenshot and their model calls into the worker (site-access part 3,
// docs/dev/site-access.md, "Tools of a worker-built run that run in the worker").
//
// These are CHARACTERIZATION tests: they assert what the code does now, not what it should do. The move must keep what the
// MODEL sees (the tool result text, the inline image or the reader's description, the reader's prompt and which model it
// goes to) and may change WHO sends what (the page today, the worker after). A test here that fails after the move is
// either a change in what the model sees, which is a regression, or a pinned page-side message that moved, which is the
// point of the move: update that assertion and say so in the PR.
//
// The world is the real thing in node:vm, end to end: the background bundle (loadBackground, the real origin gate) starts
// a run the person asked for (`__mlStartUserRunForTest`), and its tab is the real content.js + injected.js over a jsdom
// document. The two are wired to each other: the worker's chrome.tabs.sendMessage reaches the content script, and the
// content script's chrome.runtime.sendMessage reaches the worker as the tab's own top frame, on an origin nobody approved.
// jsdom has no layout and no canvas, so rects are set per element, and the canvas is a recorder: every image it produces
// is a token whose recipe (which image it was drawn from, which source rect) the tests read back. That is how "the model
// saw the viewport capture cropped to this rect at this pixel ratio" is asserted without pixels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 20000 };
const DIST = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dist");
const SITE = { id: 7, windowId: 3, active: true, url: "https://site.example/page", title: "Site" };
const VIEWPORT = "data:image/png;base64,VIEWPORTCAPTURE";

// --- the fake canvas: every image is a token with a recipe ---

/**
 * A recorder standing in for <canvas> and Image. `toDataURL` mints `data:image/png;base64,IMG<n>` and remembers how it
 * was made: its size and every drawImage, with the source image named by ITS data URL.
 * @returns the registry and the two constructors to install in the page
 */
function makeCanvasRecorder({ viewportW, viewportH }) {
    const images = new Map([[VIEWPORT, { w: viewportW, h: viewportH, draws: [], ops: [] }]]);
    let seq = 0;
    class FakeImage {
        constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.onload = null; this.onerror = null; this._src = ""; }
        get width() { return this.naturalWidth; }
        get height() { return this.naturalHeight; }
        get src() { return this._src; }
        set src(v) {
            this._src = String(v);
            const known = images.get(this._src);
            setTimeout(() => {
                if (!known) { this.onerror && this.onerror(new Error("unknown image")); return; }
                this.naturalWidth = known.w; this.naturalHeight = known.h;
                this.onload && this.onload();
            }, 0);
        }
        decode() { return Promise.resolve(); }
    }
    const makeCanvas = () => {
        const draws = [], ops = [];
        const state = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "10px sans-serif", textBaseline: "alphabetic", globalAlpha: 1 };
        const ctx2d = new Proxy(state, {
            get(t, p) {
                if (p in t) return t[p];
                if (p === "drawImage") return (img, ...nums) => draws.push([img && img._src !== undefined ? img._src : (img && img.__canvasUrl) || "?", ...nums]);
                if (p === "getImageData") return (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
                if (p === "measureText") return (s) => ({ width: String(s).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
                if (p === "createLinearGradient" || p === "createRadialGradient") return () => ({ addColorStop() {} });
                if (typeof p === "symbol") return undefined;
                return (...args) => { ops.push([p, ...args.filter((a) => typeof a !== "object")]); };
            },
            set(t, p, v) { t[p] = v; return true; },
        });
        const canvas = {
            width: 300, height: 150, style: {},
            getContext: () => ctx2d,
            toDataURL: () => {
                const url = `data:image/png;base64,IMG${++seq}`;
                images.set(url, { w: canvas.width, h: canvas.height, draws: [...draws], ops: [...ops] });
                return url;
            },
        };
        return canvas;
    };
    return { images, FakeImage, makeCanvas };
}

/**
 * How an image token was made: its size, what it was drawn from (`VIEWPORT` for the capture, else another token) with the
 * drawImage numbers, and the names of the other drawing calls on it (badges, outlines, grid lines).
 */
function recipe(images, url) {
    const r = images.get(url);
    if (!r) return null;
    return { w: r.w, h: r.h, draws: r.draws.map(([src, ...nums]) => [src === VIEWPORT ? "VIEWPORT" : src.replace("data:image/png;base64,", ""), ...nums]), ops: [...new Set(r.ops.map((o) => o[0]))] };
}

// --- the page: content.js + injected.js over jsdom ---

/**
 * The run's tab: the real content script and page script over a jsdom document, with every window message and every
 * message to the worker recorded.
 * @param opts.html the body
 * @param opts.dpr the device pixel ratio
 * @param opts.toWorker how a chrome.runtime.sendMessage from the content script reaches the worker
 */
function loadRunPage({ html = "", dpr = 1, toWorker }) {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: SITE.url, runScripts: "outside-only" });
    const win = dom.window;
    const posted = [];    // every window.postMessage, in order: what any script on the page can read
    const sent = [];      // every message the content script sent the worker
    const runtimeListeners = [];
    const canvas = makeCanvasRecorder({ viewportW: Math.round(win.innerWidth * dpr), viewportH: Math.round(win.innerHeight * dpr) });
    win.postMessage = (data) => {
        posted.push(data);
        setTimeout(() => {
            const ev = new win.MessageEvent("message", { data });
            Object.defineProperty(ev, "source", { value: win });
            win.dispatchEvent(ev);
        }, 0);
    };
    Object.defineProperty(win, "devicePixelRatio", { value: dpr, configurable: true });
    win.Image = canvas.FakeImage;
    const create = win.document.createElement.bind(win.document);
    win.document.createElement = (tag, o) => String(tag).toLowerCase() === "canvas" ? canvas.makeCanvas() : create(tag, o);
    win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    win.structuredClone = structuredClone;
    win.Element.prototype.scrollIntoView = function () {};
    // Hit-testing over the boxes `place` gave out: the last placed element under the point (placed later = on top).
    const placed = [];
    win.document.elementFromPoint = (x, y) => {
        for (let i = placed.length - 1; i >= 0; i--) {
            const r = placed[i].getBoundingClientRect();
            if (x >= r.left && x < r.right && y >= r.top && y < r.bottom && placed[i].isConnected) return placed[i];
        }
        return win.document.body;
    };
    win.document.elementsFromPoint = (x, y) => { const e = win.document.elementFromPoint(x, y); return e ? [e] : []; };
    win.chrome = {
        runtime: {
            getURL: (p) => `chrome-extension://test/${p}`,
            lastError: undefined,
            sendMessage: (message, cb) => {
                sent.push(message);
                Promise.resolve(toWorker(message)).then((r) => cb && cb(r), (e) => cb && cb({ error: String(e?.message || e) }));
            },
            connect: () => { throw new Error("no streaming port in this harness"); },
            onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        },
    };
    const ctx = dom.getInternalVMContext();
    vm.runInContext(fs.readFileSync(path.join(DIST, "content.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(DIST, "injected.js"), "utf8"), ctx);
    /** The worker's chrome.tabs.sendMessage arriving at this tab's content script. */
    const deliver = (message) => new Promise((resolve) => {
        let kept = false;
        for (const fn of runtimeListeners) if (fn(message, {}, resolve) === true) kept = true;
        if (!kept) resolve(undefined);
    });
    /** Give an element a layout box (jsdom has none). */
    const place = (sel, { x, y, w, h }) => {
        const el = win.document.querySelector(sel);
        el.getBoundingClientRect = () => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} });
        el.getClientRects = () => [el.getBoundingClientRect()];
        placed.push(el);
        return el;
    };
    return { win, document: win.document, posted, sent, deliver, place, images: canvas.images, close: () => win.close() };
}

// --- the worker, wired to the page ---

/** Ollama capabilities by model: what `/api/show` answers. */
const CAPS = { "vlm-driver": ["completion", "vision", "tools"], "text-driver": ["completion", "tools"], "reader-vl": ["completion", "vision"], "qwen-ground": ["completion", "vision"] };

/**
 * A run the worker built, on SITE (an origin nobody approved), with its page loaded and wired.
 * @param opts.model the driver: "vlm-driver" sees natively, "text-driver" does not (the reader is `ocrModel`)
 * @param opts.turns the driver's tool calls, one per turn: `{ name, args }`; after them it answers "done"
 * @param opts.reader the vision sub-call's reply, from its body
 * @param opts.capture the viewport capture, or a function that throws
 */
async function startVisionRun({ model = "vlm-driver", turns = [], reader = () => "a page with a button", capture = () => VIEWPORT, html = "", dpr = 1, cfg = {}, before, onDriverTurn } = {}) {
    const chats = [];      // every model call, driver and sub-call: { url, body, kind }
    let page, bg;
    const runIdOf = () => bg.tabMessages.find(([, m]) => m.type === "ADOPT_RUN_NOW")?.[1].payload.runId;
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model, apiFormat: "openai", ocrModel: "reader-vl", debugMode: "off", ...cfg },
        openTabs: [SITE],
        siteGate: true,
        onCaptureTab: () => capture(),
        // With CDP on, the worker captures through the debugger: the same capture, as Page.captureScreenshot's base64.
        onDebuggerCommand: (method) => method === "Page.captureScreenshot" ? { data: capture().slice("data:image/png;base64,".length) } : undefined,
        onFetch: async (call) => {
            if (call.url.endsWith("/api/show")) {
                const caps = CAPS[call.body?.model];
                return caps ? jsonResponse({ capabilities: caps, model_info: {} }) : jsonResponse({}, 404);
            }
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const driver = Array.isArray(call.body?.tools) && call.body.tools.length > 0;
            chats.push({ body: call.body, kind: driver ? "driver" : "sub" });
            if (!driver) return jsonResponse({ choices: [{ message: { content: reader(call.body) } }] });
            const n = chats.filter((c) => c.kind === "driver").length - 1;
            if (onDriverTurn) await onDriverTurn(n, { page, bg, runId: runIdOf() });
            const t = turns[n];
            if (!t) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }] }, finish_reason: "tool_calls" }] });
        },
        onTabMessage: async (tabId, msg) => tabId === SITE.id && page ? page.deliver(msg) : undefined,
    });
    const sender = { tab: { id: SITE.id, windowId: SITE.windowId, url: SITE.url }, url: SITE.url, origin: "https://site.example", frameId: 0 };
    page = loadRunPage({ html, dpr, toWorker: (m) => bg.send(m, sender) });
    if (before) before(page);
    await settle(() => page.sent.some((m) => m.type === "CONTENT_READY"));
    const { hash } = await bg.context.__mlStartUserRunForTest(SITE.id, { task: "look at the page", surface: "hud" }, { approvalRouting: "both" });
    const driverTurns = () => chats.filter((c) => c.kind === "driver");
    // Done when the driver has been asked once more than it has tool calls (its "done" turn).
    await settle(() => {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        return driverTurns().length > turns.length;
    });
    await new Promise((r) => setTimeout(r, 30));
    return { bg, page, hash, chats, driverTurns, subs: () => chats.filter((c) => c.kind === "sub") };
}

/** Wait (bounded) for `cond`, on real timers: the run crosses both worlds through timeouts. */
async function settle(cond, ms = 8000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("timed out waiting for the run");
        await new Promise((r) => setTimeout(r, 5));
    }
}

/** The data-URL images in a model request body, in order. */
const imagesIn = (body) => JSON.stringify(body).match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [];
/** The last user-turn text of a request body (a vision sub-call's prompt). */
const promptOf = (body) => {
    const m = body.messages.at(-1);
    return typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
};
/** What the driver's NEXT turn shows it after its tool call: the tool message and whatever follows it. */
function afterToolCall(body) {
    const i = body.messages.findIndex((m) => m.role === "tool");
    return { tool: body.messages[i], rest: body.messages.slice(i + 1) };
}
/** A value from either vm realm as a plain object of this one, so deepEqual compares content, not prototypes. */
const plain = (x) => JSON.parse(JSON.stringify(x));
/** The page→worker message types, without the boot handshake. */
const pageSent = (page) => page.sent.map((m) => m.type).filter((t) => t !== "CONTENT_READY");
/** The worker→page RUN_TOOL_IN_PAGE payloads. */
const toolCallsToPage = (bg) => plain(bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && !m.payload.finish).map(([, m]) => m.payload));

/** A whole tool result as the driver's next turn has it: the tool message's text and the images that follow it. */
function seenByDriver(w) {
    const { tool, rest } = afterToolCall(w.driverTurns().at(-1).body);
    return { text: tool.content, images: rest.flatMap((m) => imagesIn(m)), labels: rest.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text) : []) };
}
/** The FETCH_LLM payloads the page sent, in order. */
const pageModelCalls = (page) => plain(page.sent.filter((m) => m.type === "FETCH_LLM").map((m) => m.payload));

const BTNS = '<div id="bar"><button id="save" style="background:blue">Save</button><button id="del">Delete</button></div><p id="msg">Ready</p>';
/** Lay the buttons out: #save at (300,200) 120×40, #del at (500,200), inside #bar. */
const placeBtns = (p) => { p.place("#bar", { x: 280, y: 180, w: 400, h: 80 }); p.place("#save", { x: 300, y: 200, w: 120, h: 40 }); p.place("#del", { x: 500, y: 200, w: 120, h: 40 }); p.place("#msg", { x: 20, y: 20, w: 200, h: 20 }); };
/** A viewport coordinate (1024 wide, the letterbox's fit side) in the grounding model's 0..1000 square. */
const sq = (v) => Math.round(v * 1000 / 1024);
const GROUNDING = { groundingEnabled: true, groundingModel: "qwen-ground" };

// --- look: the driver sees the pixels itself (native) ---

test("native look of the viewport: the page sends one CAPTURE_TAB and no model call; the driver gets the raw capture inline", T, async () => {
    const w = await startVisionRun({ model: "vlm-driver", turns: [{ name: "look", args: {} }] });
    try {
        assert.deepEqual(toolCallsToPage(w.bg).map((p) => [p.name, !!p.renderOnly]), [["look", true], ["look", false]], "the worker asks the page for the call's preview, then runs it there");
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB"], "the page captures through the worker, and calls no model");
        assert.equal(w.subs().length, 0);
        assert.deepEqual(w.bg.debuggerCalls.filter((c) => c[0] === "sendCommand").map((c) => [c[1].tabId, c[2]]), [[SITE.id, "Page.captureScreenshot"]],
            "CDP is on by default: the worker serves the page's CAPTURE_TAB through the debugger, on the sender's tab");
        assert.equal(w.bg.captures.length, 0);
        const seen = seenByDriver(w);
        assert.equal(seen.text, "Screenshot of the viewport captured — shown to you in the next message.");
        assert.deepEqual(seen.labels, ["[Screenshot: viewport]"]);
        assert.deepEqual(seen.images, [VIEWPORT], "the capture itself, uncropped, as the next user turn");
    } finally { w.page.close(); }
});

test("with CDP off, the page's CAPTURE_TAB is a captureVisibleTab of the sender tab's window, taken while that tab is the one showing", T, async () => {
    const w = await startVisionRun({ model: "vlm-driver", cfg: { cdp: false }, turns: [{ name: "look", args: {} }] });
    try {
        assert.deepEqual(plain(w.bg.captures), [[SITE.windowId, { format: "png" }]], "the window's capture, which is the run's tab because it is showing (#479 refuses otherwise)");
        assert.deepEqual(seenByDriver(w).images, [VIEWPORT]);
    } finally { w.page.close(); }
});

test("native look of an element: the page crops the capture to the element's box times the pixel ratio", T, async () => {
    const w = await startVisionRun({ model: "vlm-driver", dpr: 2, html: BTNS, before: placeBtns, turns: [{ name: "look", args: { selector: "#bar" } }] });
    try {
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB"]);
        const seen = seenByDriver(w);
        assert.equal(seen.text, 'Screenshot of the element "#bar" captured — shown to you in the next message.');
        assert.deepEqual(seen.labels, ['[Screenshot: element "#bar"]']);
        assert.equal(seen.images.length, 1);
        assert.deepEqual(recipe(w.page.images, seen.images[0]), { w: 800, h: 160, draws: [["VIEWPORT", 560, 360, 800, 160, 0, 0, 800, 160]], ops: [] },
            "#bar is 400×80 at (280,180): at dpr 2 the crop is the capture's (560,360) 800×160");
    } finally { w.page.close(); }
});

// --- look: a reader describes the pixels (delegated) ---

test("delegated look: CAPTURE_TAB then FETCH_LLM to the run's reader; the driver gets its words and the page's DOM legend, never the image", T, async () => {
    const w = await startVisionRun({ model: "text-driver", html: BTNS, before: placeBtns, turns: [{ name: "look", args: {} }], reader: () => "Two buttons." });
    try {
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB", "FETCH_LLM"], "the capture, then the reader's call, both sent by the page");
        const [call] = pageModelCalls(w.page);
        assert.deepEqual(call, {
            messages: [{ role: "user", content: "Describe the current page concisely — what is shown and what stands out.\n\nThen list a few EXACT on-screen text strings (quoted, verbatim — labels, badges, prices, delivery text) I could search for with findByText to locate the key items.", images: [VIEWPORT] }],
            think: false, model: "reader-vl", extend: null, numCtx: 8192, numGpu: null, schema: null, toolIds: null, maxTokens: 512,
            hint: { use: "agent", session: `wml-${w.hash}` },
        }, "the reader call as the page builds it: the resolved reader (the config's OCR model), 512 tokens, an 8192 context, labelled as the run's");
        assert.equal(w.subs().length, 1);
        assert.equal(w.subs()[0].body.model, "reader-vl");
        assert.deepEqual(imagesIn(w.subs()[0].body), [VIEWPORT], "the reader sees the raw capture");
        const seen = seenByDriver(w);
        assert.equal(seen.text, "Two buttons.\n\nDOM in view (use these selectors with click/type/findByText):\n• controls: «Save» `#save` · «Delete» `#del`",
            "the reader's reply, then the DOM legend of what the shot covers, read from the page");
        assert.deepEqual(seen.images, [], "no image reaches a driver that cannot see");
    } finally { w.page.close(); }
});

test("a capture that fails: the tool result is the error, and no model call is made, native or delegated", T, async () => {
    for (const model of ["vlm-driver", "text-driver"]) {
        const w = await startVisionRun({ model, turns: [{ name: "look", args: {} }], capture: () => { throw new Error("Cannot capture a chrome:// page"); } });
        try {
            assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB"], model);
            assert.equal(w.subs().length, 0, model);
            const seen = seenByDriver(w);
            assert.equal(seen.text, "Error: Cannot capture a chrome:// page", model);
            assert.deepEqual(seen.images, [], model);
        } finally { w.page.close(); }
    }
});

// --- locate ---

test("locate by grounding: the capture is letterboxed top-left into a 1000 square for the grounding model, and its box is snapped to the DOM in the page", T, async () => {
    const box = `${sq(305)},${sq(205)},${sq(415)},${sq(235)}`;   // around #save, in the square's coordinates
    const w = await startVisionRun({ model: "vlm-driver", html: BTNS, before: placeBtns, cfg: GROUNDING,
        turns: [{ name: "locate", args: { description: "a blue button labelled Save", verify: true } }], reader: () => box });
    try {
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB", "FETCH_LLM", "CAPTURE_TAB"], "capture, grounding call, then a second capture for verify:true");
        const [call] = pageModelCalls(w.page);
        assert.equal(call.model, "qwen-ground");
        assert.equal(call.maxTokens, 64);
        assert.equal(call.messages[0].content, 'Locate "a blue button labelled Save" in this image. Reply with ONLY its bounding box as four numbers x1,y1,x2,y2 — top-left then bottom-right corner, each from 0 to 1000 (x: 0=left→1000=right; y: 0=top→1000=bottom). If it isn\'t visible, reply "NONE".');
        const square = recipe(w.page.images, call.messages[0].images[0]);
        assert.equal(square.w, 1000); assert.equal(square.h, 1000);
        assert.equal(square.draws.length, 1);
        assert.deepEqual(square.draws[0].slice(1), [0, 0, 1000, 750], "the viewport, scaled to fit, at the square's TOP-LEFT (padding below)");
        assert.deepEqual(recipe(w.page.images, "data:image/png;base64," + square.draws[0][0]).draws, [["VIEWPORT", 0, 0, 1024, 768, 0, 0, 1024, 768]], "drawn from the whole capture, unscoped");
        const seen = seenByDriver(w);
        assert.equal(seen.text, 'Grounded "a blue button labelled Save" → [button] "Save" → #save\n(verify it with look() first, then click/type/answer with this selector)\n\nOther elements in that region:\n#1 [button] "Save" → #save\n\n Marked crop shown in the next prompt. If it\'s on target, act now (no need to look() first).');
        assert.deepEqual(seen.labels, ["[Screenshot: grounded element]"]);
        assert.deepEqual(recipe(w.page.images, seen.images[0]), { w: 120, h: 40, draws: [["VIEWPORT", 300, 200, 120, 40, 0, 0, 120, 40]], ops: [] },
            "verify:true on a vision driver: a plain crop of the snapped element, from a fresh capture");
    } finally { w.page.close(); }
});

test("locate by Set-of-Marks (no grounding model): one capture, numbered badges drawn on it in the page, the reader picks a number, the driver gets the selector", T, async () => {
    const w = await startVisionRun({ model: "text-driver", html: BTNS, before: placeBtns, turns: [{ name: "locate", args: { description: "a blue button labelled Save" } }], reader: () => "1" });
    try {
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB", "FETCH_LLM"]);
        const [call] = pageModelCalls(w.page);
        assert.equal(call.model, "reader-vl");
        assert.equal(call.maxTokens, 64);
        assert.equal(call.messages[0].content, 'The screenshot has numbered badges (#1–#2) drawn over candidate elements. Which single badge number best matches this element: "a blue button labelled Save"? Reply with ONLY the number, or "NONE" if none match.');
        const badged = recipe(w.page.images, call.messages[0].images[0]);
        assert.deepEqual(badged.draws, [["VIEWPORT", 0, 0]], "the whole capture, drawn as is");
        assert.deepEqual(badged.ops.sort(), ["fillRect", "fillText", "strokeRect"], "with the badges drawn over it");
        assert.deepEqual(w.page.images.get(call.messages[0].images[0]).ops.filter((o) => o[0] === "fillText").map((o) => o.slice(1)), [["1", 303, 184], ["2", 503, 184]], "badge 1 on #save, badge 2 on #del");
        assert.equal(seenByDriver(w).text, 'Matched "a blue button labelled Save" → #1 [button] "Save" → #save\n(verify it with look() first, then click/type/answer with this selector)\n\nAll candidates:\n#1 [button] "Save" → #save\n#2 [button] "Delete" → #del');
        assert.deepEqual(seenByDriver(w).images, []);
    } finally { w.page.close(); }
});

test("locate by grid: the reader picks a cell on a gridded capture, and the cell is snapped to the DOM in the page", T, async () => {
    const w = await startVisionRun({ model: "text-driver", html: BTNS, before: placeBtns, turns: [{ name: "locate", args: { description: "a blue button labelled Save", strategy: "grid" } }], reader: () => "2" });
    try {
        const [call] = pageModelCalls(w.page);
        assert.equal(call.model, "reader-vl");
        assert.equal(call.messages[0].content, 'This image is divided into a 5×3 numbered grid (cells 1–15, numbered left-to-right, top-to-bottom). Which cell contains a blue button labelled Save? If the target sits ON a grid line or spans more than one cell, reply with the 2 adjacent cells (or a 2×2 block of 4) that cover it; otherwise the single cell. Reply with ONLY the cell number(s), comma-separated, or "NONE".');
        const grid = recipe(w.page.images, call.messages[0].images[0]);
        assert.equal(grid.w, 1024); assert.equal(grid.h, 768);
        assert.ok(grid.ops.includes("lineTo") && grid.ops.includes("fillText"), "grid lines and cell numbers drawn in the page");
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB", "FETCH_LLM"], "one capture, one cell pick; the snap to #save is a DOM read in the page");
        assert.equal(seenByDriver(w).text, 'Grid cell 2 → [button] "Save" → #save\n(verify it with look() first, then click/type/answer with this selector)\n\nzoom in — locate({ description: "a blue button labelled Save", strategy: "grid", cells: [2] }) draws a fresh grid inside that cell. If it\'s actually in a neighbouring cell, try — left 1, right 3, bottom 7 — e.g. locate({ description: "a blue button labelled Save", strategy: "grid", cells: [1] }).\n\nCandidates in that region:\n#1 [button] "Save" → #save');
        assert.deepEqual(seenByDriver(w).images, []);
    } finally { w.page.close(); }
});

// --- verify after an action ---

test("click verify, page-side, native: a 300 px crop centred on the element, inline, with a fresh @pt to look at", T, async () => {
    const w = await startVisionRun({ model: "vlm-driver", html: BTNS, before: placeBtns, turns: [{ name: "click", args: { selector: "#save", verify: true } }] });
    try {
        assert.deepEqual(toolCallsToPage(w.bg).map((p) => Object.keys(p).filter((k) => k !== "runId" && k !== "args" && k !== "name").join(",")), ["renderOnly", "precheck", "renderOnly", "stream"],
            "preview, the doomed-action precheck, the gate's preview, then the call");
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB"]);
        const seen = seenByDriver(w);
        assert.match(seen.text, /^Clicked button#save "Save"\. Page title: \.\n\n Here's the area where you clicked\. The target you clicked is at the CENTRE of this crop; to see the exact click point, look\(\{ selector: "@pt:[0-9a-f]{8}" \}\)\. Read the result and continue — no need to look\(\) first\.$/);
        assert.deepEqual(seen.labels, ["[Screenshot: after the action]"]);
        assert.deepEqual(recipe(w.page.images, seen.images[0]), { w: 300, h: 300, draws: [["VIEWPORT", 210, 70, 300, 300, 0, 0, 300, 300]], ops: [] },
            "#save's centre is (360,220): the crop is 150 px each way, clean (no click mark)");
    } finally { w.page.close(); }
});

test("click verify, page-side, delegated: the reader describes the same crop, with a 256-token cap", T, async () => {
    const w = await startVisionRun({ model: "text-driver", html: BTNS, before: placeBtns, turns: [{ name: "click", args: { selector: "#save", verify: true } }], reader: () => "Saved." });
    try {
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB", "FETCH_LLM"]);
        const [call] = pageModelCalls(w.page);
        assert.equal(call.model, "reader-vl");
        assert.equal(call.maxTokens, 256);
        assert.equal(call.messages[0].content, 'The image is a crop of the page just AFTER a "clicked" action; the target is at the exact CENTRE. Describe what is now shown there and around it — especially anything that CHANGED (a menu/panel/result that appeared, a new field value, a navigation).');
        assert.deepEqual(recipe(w.page.images, call.messages[0].images[0]).draws, [["VIEWPORT", 210, 70, 300, 300, 0, 0, 300, 300]]);
        const seen = seenByDriver(w);
        assert.match(seen.text, /^Clicked button#save "Save"\. Page title: \.\n\n👁 Here's the area where you clicked\. You can't see images, so this is reader-vl's description:\nSaved\. The target you clicked is at the CENTRE of this crop; to see the exact click point, look\(\{ selector: "@pt:[0-9a-f]{8}" \}\)\.$/);
        assert.deepEqual(seen.images, []);
    } finally { w.page.close(); }
});

test("a canvas click with CDP on: the worker clicks through the debugger, then rings the page back (verifyAt) to capture and describe", T, async () => {
    const w = await startVisionRun({ model: "text-driver", cfg: { cdp: true }, html: '<canvas id="game"></canvas>', before: (p) => p.place("#game", { x: 100, y: 100, w: 400, h: 300 }),
        turns: [{ name: "click", args: { selector: "#game", verify: true } }], reader: () => "A game board." });
    try {
        const ring = toolCallsToPage(w.bg).at(-1);
        assert.deepEqual(ring, { runId: w.hash, verifyAt: { x: 300, y: 250 } }, "after its own click, the worker asks the page for the verify at the canvas centre");
        assert.deepEqual(w.bg.debuggerCalls.map((c) => c[0] === "sendCommand" ? c[2] : c[0]), ["attach", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Page.captureScreenshot", "detach"],
            "the click, then the page's CAPTURE_TAB served through the debugger (CDP on), all in the worker");
        assert.equal(w.bg.captures.length, 0, "no captureVisibleTab with CDP on");
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB", "FETCH_LLM"], "the ring-back's capture and its reader call are still sent by the page");
        assert.equal(pageModelCalls(w.page)[0].model, "reader-vl");
        assert.deepEqual(recipe(w.page.images, pageModelCalls(w.page)[0].messages[0].images[0]).draws, [["VIEWPORT", 150, 100, 300, 300, 0, 0, 300, 300]]);
        assert.match(seenByDriver(w).text, /^Clicked the reserved target at \(300, 250\) via the debugger\.\n\n👁 Here's the area where you clicked\. You can't see images, so this is reader-vl's description:\nA game board\. The target you clicked is at the CENTRE of this crop; to see the exact click point, look\(\{ selector: "@pt:[0-9a-f]{8}" \}\)\.\n\nDOM in view \(use these selectors with click\/type\/findByText\):\n• media: canvas `#game`$/);
    } finally { w.page.close(); }
});

test("a trusted type with CDP on rings back verifyFocus for @focus, and verifyElement for a canvas: the page crops the whole element", T, async () => {
    const focus = await startVisionRun({ model: "vlm-driver", cfg: { cdp: true }, html: '<input id="q">', before: (p) => { p.place("#q", { x: 10, y: 10, w: 200, h: 30 }); p.document.getElementById("q").focus(); },
        turns: [{ name: "type", args: { selector: "@focus", text: "hi", verify: true } }] });
    try {
        assert.deepEqual(toolCallsToPage(focus.bg).at(-1), { runId: focus.hash, verifyFocus: true });
        assert.deepEqual(pageSent(focus.page), ["CAPTURE_TAB"]);
        const seen = seenByDriver(focus);
        assert.equal(seen.text, "Typed \"hi\" into the page's current focus via the debugger (trusted keyboard, additive).\n\n Here's the focused element input#q after you typed it. Read the result and continue — no need to look() first.");
        assert.deepEqual(recipe(focus.page.images, seen.images[0]).draws, [["VIEWPORT", 10, 10, 200, 30, 0, 0, 200, 30]], "the focused field's own box");
    } finally { focus.page.close(); }
    const canvas = await startVisionRun({ model: "vlm-driver", cfg: { cdp: true }, html: '<canvas id="game"></canvas>', before: (p) => p.place("#game", { x: 100, y: 100, w: 400, h: 300 }),
        turns: [{ name: "type", args: { selector: "#game", text: "hi", verify: true } }] });
    try {
        assert.deepEqual(toolCallsToPage(canvas.bg).at(-1), { runId: canvas.hash, verifyElement: "#game" });
        const seen = seenByDriver(canvas);
        assert.equal(seen.text, "Typed \"hi\" into the target at (300, 250) via the debugger (trusted keyboard, additive).\n\n Here's \"#game\" after you typed it. Read the result and continue — no need to look() first.");
        assert.deepEqual(recipe(canvas.page.images, seen.images[0]).draws, [["VIEWPORT", 100, 100, 400, 300, 0, 0, 400, 300]], "the whole canvas");
    } finally { canvas.page.close(); }
});

test("the navigate verify ring-back (verifyViewport): the page captures the whole viewport and the reader gets the after-a-wait prompt", T, async () => {
    // A real navigation cannot be driven in jsdom; the worker's half (it sends verifyViewport after the new page re-adopts,
    // and merges the reply into the navigate result) is pinned in tests/background.test.js, "navigate({ verify: true })".
    // Here the page's half: the same ring-back, delivered while the run is live.
    let env;
    const w = await startVisionRun({ model: "text-driver", turns: [], reader: () => "The new page.",
        onDriverTurn: async (n, { page, runId }) => { if (n === 0) env = await page.deliver({ type: "RUN_TOOL_IN_PAGE", payload: { runId, verifyViewport: true } }); } });
    try {
        // The ring-back is delivered from the driver's first turn: under load that comes after the run has started.
        for (let i = 0; i < 2000 && env === undefined; i++) await new Promise((r) => setTimeout(r, 1));
        assert.ok(env !== undefined, "the ring-back was delivered and answered");
        assert.deepEqual(pageSent(w.page), ["CAPTURE_TAB", "FETCH_LLM"]);
        const [call] = pageModelCalls(w.page);
        assert.equal(call.messages[0].content, "The image is a screenshot of the page after it settled following a wait. Describe the current state — especially anything that just finished loading or changed.",
            "a navigate verify reuses the wait verify's prompt");
        assert.deepEqual(call.messages[0].images, [VIEWPORT]);
        assert.equal(call.maxTokens, 256);
        assert.deepEqual(plain(env), { result: "\n\n👁 The page settled — here's the current viewport. You can't see images, so this is reader-vl's description:\nThe new page.",
            feedback: { reason: "after wait", via: "text", text: "The new page.", prompt: call.messages[0].content, image: VIEWPORT } });
    } finally { w.page.close(); }
});

// --- the sidebar is hidden for the shot ---

/** The window messages around a capture: the sidebar handshake and the capture's request, in order. */
const shotOrder = (page) => page.posted.map((d) => d.__mlSidebarShot ? `sidebar:${d.__mlSidebarShot}` : d.type).filter((t) => /^sidebar:|^CAPTURE_TAB/.test(t));

test("with the sidebar mounted, the page posts hide, waits for the shell's hidden, captures, then posts show", T, async () => {
    const shell = (p) => p.win.addEventListener("message", (e) => { if (e.data && e.data.__mlSidebarShot === "hide") p.win.postMessage({ __mlSidebarShot: "hidden" }, "*"); });
    const w = await startVisionRun({ model: "vlm-driver", html: '<div id="ml-sb-root"></div>', before: shell, turns: [{ name: "look", args: {} }] });
    try {
        assert.deepEqual(shotOrder(w.page), ["sidebar:hide", "sidebar:hidden", "CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", "sidebar:show"]);
    } finally { w.page.close(); }
});

test("with the sidebar mounted and no answer from the shell, the capture still goes after the wait; with none mounted there is no hide, and show is still posted", T, async () => {
    const silent = await startVisionRun({ model: "vlm-driver", html: '<div id="ml-sb-root"></div>', turns: [{ name: "look", args: {} }] });
    try {
        assert.deepEqual(shotOrder(silent.page), ["sidebar:hide", "CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", "sidebar:show"], "the 200 ms safety net, then the capture");
        assert.equal(seenByDriver(silent).images.length, 1);
    } finally { silent.page.close(); }
    const none = await startVisionRun({ model: "vlm-driver", turns: [{ name: "look", args: {} }] });
    try {
        assert.deepEqual(shotOrder(none.page), ["CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", "sidebar:show"]);
    } finally { none.page.close(); }
});

// --- what the page's own scripts can see and do while the run lives ---

test("every capture, every reader reply and every tool result crosses the page's window, where any script on the page reads it", T, async () => {
    const w = await startVisionRun({ model: "text-driver", html: BTNS, before: placeBtns, turns: [{ name: "look", args: { question: "what is the secret?" } }], reader: () => "The secret is 42." });
    try {
        const byType = (t) => w.page.posted.filter((d) => d.type === t);
        assert.equal(byType("PAGE_TOOL_RUN").find((d) => !d.renderOnly && d.name === "look").args.question, "what is the secret?", "the call's arguments");
        assert.equal(byType("CAPTURE_TAB_RESPONSE")[0].result, VIEWPORT, "the capture");
        assert.ok(byType("LLM_REQUEST").some((d) => d.payload.model === "reader-vl" && d.payload.messages[0].images[0] === VIEWPORT), "the reader's request, image included");
        assert.equal(byType("LLM_RESPONSE")[0].result, "The secret is 42.", "the reader's reply");
        assert.ok(byType("PAGE_TOOL_RESULT").some((d) => String(d.envelope.result).startsWith("The secret is 42.") && d.envelope.renderOut?.image === VIEWPORT), "and the tool's result, with the image its render shows");
    } finally { w.page.close(); }
});

test("while the run lives, the page itself may send CAPTURE_TAB and FETCH_LLM from an unapproved origin; once it ends, both are refused", T, async () => {
    const sender = { tab: { id: SITE.id, windowId: SITE.windowId, url: SITE.url }, url: SITE.url, origin: "https://site.example", frameId: 0 };
    const llm = { type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "spend my tokens" }], model: "reader-vl" } };
    let during;
    const w = await startVisionRun({ model: "text-driver", turns: [],
        onDriverTurn: async (n, { bg }) => { if (n === 0) during = { capture: await bg.send({ type: "CAPTURE_TAB", payload: {} }, sender), llm: await bg.send(llm, sender) }; } });
    try {
        assert.equal(during.capture.data, VIEWPORT, "RUN_TAB_TYPES lets the run's tab capture itself");
        assert.equal(typeof during.llm.data, "string", "and call a model of its choosing");
        const after = { capture: await w.bg.send({ type: "CAPTURE_TAB", payload: {} }, sender), llm: await w.bg.send(llm, sender) };
        assert.match(after.capture.error, /^Refused/);
        assert.match(after.llm.error, /^Refused/);
    } finally { w.page.close(); }
});
