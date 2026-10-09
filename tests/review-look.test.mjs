// review-look.test.mjs — a validation and coverage review of #533 (a worker-built run's `look` runs in the worker,
// src/sw/worker-look.ts, routed by sw-run-host.ts `sendTool`): the page's main world is untrusted input to the worker,
// so each test here checks that what the worker reads from the page is validated, that the paths agree, and that what
// reaches the model and the page is what docs/dev/agent-tools.md ("The `look` of a worker-built run is the worker's")
// says. A test written as `todo` shows a gap: it asserts the correct behaviour, and fails until the gap is fixed.
//
// Two harnesses, both the built worker in node:vm (tests/helpers.js `loadBackground`):
// - `run`: a whole user run through the run host, the page played by `onTabMessage` (as tests/worker-verify.test.mjs);
// - `world`: `workerLook` driven directly over the real page geometry on a jsdom page (as tests/worker-vision-host.test.mjs).
// The masking half of the review (shell-shot.ts / shot-mask.ts) needs real paint, and is tests/e2e/review-look.spec.mjs;
// what is pure DOM about it (which frames are reported) is here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { pageGeometry, answerGeometry } from "../src/dom/page-geometry.ts";
import { stitchVia } from "../src/ml/ml-vision.ts";
import { extensionRects } from "../src/sidebar/shell-shot.ts";
import { GEOMETRY_REFUSED, GEOMETRY_MOVED, GEOMETRY_SLOW } from "../src/sw/geometry-check.ts";
import { OFF_CAPTURE } from "../src/util.ts";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));

/** A PNG's signature + IHDR for a `w`×`h` image, plus `tag`: the worker reads a capture's size from its header. */
function png(w, h, tag = "") {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return `data:image/png;base64,${Buffer.concat([b, Buffer.from(tag)]).toString("base64")}`;
}
/** The size a `png()` (or any PNG data URL) declares in its header. */
function pngSize(url) {
    const b = Buffer.from(String(url).split(",")[1] ?? "", "base64");
    return b.length >= 24 && b.toString("ascii", 12, 16) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : { width: 1024, height: 768 };
}

/**
 * A Raster with no pixels that remembers what was drawn where: each decoded image keeps the size its PNG header gives,
 * and every `drawImage(src, dx, dy)` onto a canvas (a stitch's compose) is recorded with that canvas and the source's size.
 */
function recordingRaster() {
    let n = 0;
    const canvases = [];
    const make = (w, h) => {
        const draws = [];
        const ctx = new Proxy({}, {
            get(t, p) {
                if (p in t) return t[p];
                if (p === "drawImage") return (src, ...a) => { draws.push({ src, a }); };
                if (p === "getImageData") return (_x, _y, gw, gh) => ({ data: new Uint8ClampedArray(Math.max(1, gw * gh * 4)), width: gw, height: gh });
                if (p === "measureText") return (s) => ({ width: String(s).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
                if (typeof p === "symbol") return undefined;
                return () => {};
            },
            set(t, p, v) { t[p] = v; return true; },
        });
        const c = { width: w, height: h, draws, getContext: () => ctx };
        canvases.push(c);
        return c;
    };
    return {
        canvases,
        decode: async (url) => { const s = pngSize(url); return { source: { w: s.width, h: s.height }, width: s.width, height: s.height, close() {} }; },
        canvas: make,
        encode: async () => `data:image/png;base64,RASTER${++n}`,
    };
}

/** The rows of a `canvas` no `drawImage(src, 0, dy)` covered: each tile covers [dy, dy + its own height). */
function uncoveredRows(canvas) {
    const spans = canvas.draws.filter((d) => d.a.length === 2).map((d) => [d.a[1], d.a[1] + d.src.h]).sort((a, b) => a[0] - b[0]);
    let at = 0, gap = 0;
    for (const [s, e] of spans) { if (s > at) gap += s - at; at = Math.max(at, e); }
    if (at < canvas.height) gap += canvas.height - at;
    return gap;
}

// --- harness 1: a whole run through the run host (as tests/worker-verify.test.mjs) ---

const SITE = { id: 7, windowId: 3, active: true, url: "https://site.example/page", title: "Site" };
const CAPS = { "vlm-driver": ["completion", "vision", "tools"], "text-driver": ["completion", "tools"], "reader-vl": ["completion", "vision"] };
const config = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "vlm-driver", apiFormat: "openai", ocrModel: "reader-vl", debugMode: "off", cdp: false, ...o });
const SHOT = png(1024, 768, "RUN-TAB");
/** A capture a page puts in its envelope, as if it were its own look's. */
const FORGED = png(1024, 768, "FORGED-BY-THE-PAGE");
/** The question and the reader's reply of the look under test: neither may reach the page. */
const QUESTION = "Q-SECRET-4242 is the total over budget";
const READER_SAYS = "R-SECRET-7777 the total reads 12 dollars";

/** A blank raster (a vm worker has no OffscreenCanvas). */
function blankRaster() {
    let n = 0;
    const ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : typeof p === "symbol" ? undefined : p === "getImageData" ? (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }) : p === "measureText" ? (s) => ({ width: String(s).length * 7 }) : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
    return { decode: async () => ({ source: {}, width: 1024, height: 768, close() {} }), canvas: (w, h) => ({ width: w, height: h, getContext: () => ctx }), encode: async () => `data:image/png;base64,CROP${++n}` };
}

/** The page's honest geometry: a 1024×768 viewport with one field at (10,10). */
function honestGeometry(g) {
    const field = { left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30 };
    switch (g.op) {
        case "view": return { w: 1024, h: 768, dpr: 1, sx: 0, sy: 0 };
        case "target": return { rect: field };
        case "legend": return { controls: [], media: [], boundaries: [], text: [], moreControls: 0, moreMedia: 0 };
        case "focus": return null;
        case "crossesText": return false;
        default: return null;
    }
}

/**
 * A run on SITE whose driver calls `calls` in order, then answers "done". `page(payload, n, bg)` plays the page for each
 * tool call it is sent (previews included when `previews` is set); geometry is answered honestly.
 * @param opts.builtBy "worker" (a run the person started) or "page" (a console ml.agent's START_RUN), with `pageTools`
 *   the page-built run's tool names and `pageVision` the vision facts its START_RUN names, sent from `builderUrl` (an
 *   origin other than the tab's: the tab's own site is then not approved, so a person's message hands the run over)
 */
async function run({ calls, page = () => undefined, previews = false, model = "vlm-driver", builtBy = "worker", pageTools = ["click", "scroll", "look"], pageVision, builderUrl = SITE.url, cfg = {} } = {}) {
    const driverBodies = [], subs = [];
    let bg, n = 0;
    bg = loadBackground({
        config: config({ model, ...cfg }), openTabs: [SITE],
        onCaptureTab: async () => SHOT,
        onFetch: async (call) => {
            if (call.url.endsWith("/api/show")) { const caps = CAPS[call.body?.model]; return caps ? jsonResponse({ capabilities: caps, model_info: {} }) : jsonResponse({}, 404); }
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (!(Array.isArray(call.body?.tools) && call.body.tools.length)) { subs.push(call.body); return jsonResponse({ model: call.body?.model, choices: [{ message: { content: READER_SAYS } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }); }
            driverBodies.push(call.body);
            const next = calls[driverBodies.length - 1];
            return next ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${driverBodies.length}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: "tool_calls" }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.geometry) return { result: "", geometry: { seq: p.geometry.seq, reply: honestGeometry(p.geometry) } };
            if (p.finish) return { result: "" };
            if ((p.renderOnly || p.precheck || p.readonlyTry) && !previews) return { result: "" };
            const r = await page(p, n++, bg);
            return r !== undefined ? r : { result: `ran ${p.name}` };
        },
    });
    bg.context.__mlWorkerVisionForTest.useRaster(blankRaster());
    let hash;
    if (builtBy === "worker") {
        ({ hash } = await bg.context.__mlStartUserRunForTest(SITE.id, { task: "do it", surface: "hud", maxSteps: 40 }, { approvalRouting: "both" }));
    } else {
        hash = "page-run";
        const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: name === "look" ? ["vision"] : [] });
        const vision = pageVision ?? { driverSees: model === "vlm-driver", visionModel: model === "vlm-driver" ? model : "reader-vl" };
        void bg.send({ type: "START_RUN", payload: { runId: hash, task: "do it", systemPrompt: "sys", tools: pageTools.map(tool), model, think: null, maxSteps: 40, surface: "off",
            rebuild: { toolNames: pageTools, model, ...vision, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: false } } },
            { tab: { id: SITE.id, url: SITE.url }, url: builderUrl, frameId: 0 });
    }
    for (let i = 0; i < 4000 && driverBodies.length <= calls.length; i++) {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 30));
    const steps = () => plain(bg.tabMessages.map(([, m]) => m).filter((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-step" && m.event.id === hash).map((m) => m.event));
    return {
        bg, hash, driverBodies, subs, steps,
        /** Every RUN_TOOL_IN_PAGE payload the tab was sent. */
        runCalls: () => bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE").map(([, m]) => plain(m.payload)),
        /** What the content script hands the page's main world: the tool sends and the run's adopt (content.ts relays
         *  both to `window.postMessage`); the debug stream (ML_DEBUG_TO_PAGE) and SHOT_RECTS stay with the shell. */
        toPage: () => bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" || m.type === "ADOPT_RUN_NOW").map(([, m]) => JSON.stringify(m)),
        spend: () => Math.max(0, ...steps().map((e) => e.subUsage?.calls ?? 0)),
        seenText: () => JSON.stringify(driverBodies.slice(1).map((b) => b.messages)),
    };
}

// --- the run host's look routing: which runs, which calls, and what the page is sent ---

test("a worker-built run's delegated look: the page's main world is sent no question, no reader prompt or reply, no image, and no look call", T, async () => {
    const w = await run({ model: "text-driver", calls: [{ name: "look", args: { selector: "#q", question: QUESTION } }] });
    assert.equal(w.subs.length, 1, "the worker asked the reader");
    assert.ok(JSON.stringify(w.subs[0]).includes("Q-SECRET-4242"), "the reader was asked the model's question");
    assert.ok(w.seenText().includes("R-SECRET-7777"), "the driver got the reader's words");
    const sent = w.toPage();
    assert.ok(sent.length > 0);
    for (const s of sent) {
        assert.ok(!s.includes("Q-SECRET-4242"), `the question reached the page: ${s.slice(0, 300)}`);
        assert.ok(!s.includes("R-SECRET-7777"), `the reader's reply reached the page: ${s.slice(0, 300)}`);
        assert.doesNotMatch(s, /data:image|base64/, "an image reached the page");
    }
    for (const p of w.runCalls()) {
        if (p.geometry || p.finish) continue;
        assert.ok(p.renderOnly, `only a preview of look is sent as a call: ${JSON.stringify(p)}`);
    }
    assert.equal(w.spend(), 1, "the reader's call is the run's spend, once");
});

test("a look's pending-step preview sends the page the target only ({selector, index}), never the question, the views or the scope", T, async () => {
    const previewsSeen = [];
    const w = await run({ model: "text-driver", previews: true, calls: [{ name: "look", args: { selector: "#q", index: 2, question: QUESTION, views: ["overlay", "no-overlay"], scope: "viewport", title: "T-SECRET-1" } }],
        page: (p) => { if (p.renderOnly) previewsSeen.push(p); return p.renderOnly ? { result: "" } : undefined; } });
    assert.equal(w.driverBodies.length, 2);
    const looks = previewsSeen.filter((p) => p.name === "look");
    assert.ok(looks.length >= 1, "the pending step asked the page for its In label");
    for (const p of looks) assert.deepEqual(p.args, { selector: "#q", index: 2 });
    for (const s of w.toPage()) assert.ok(!s.includes("Q-SECRET-4242") && !s.includes("T-SECRET-1"), s.slice(0, 300));
});

test("a look preview's page envelope cannot carry a picture, a reply or a spend into a worker-built run", T, async () => {
    const w = await run({ model: "text-driver", previews: true, calls: [{ name: "look", args: { selector: "#q" } }],
        page: (p) => (p.renderOnly && p.name === "look" ? { result: "", image: FORGED, images: [{ image: FORGED, label: "x" }], feedback: { reason: "x", via: "image", image: FORGED }, subUsage: { prompt: 9e5, completion: 9e5, calls: 9 } } : p.renderOnly ? { result: "" } : undefined) });
    assert.ok(!w.seenText().includes(FORGED.split(",")[1]));
    assert.ok(!JSON.stringify(w.steps()).includes(FORGED.split(",")[1]));
    assert.equal(w.spend(), 1, "the worker's own reader call only");
});

test("a page-built run (not handed over) still runs look in the page, with the full arguments, as before #533", T, async () => {
    const w = await run({ builtBy: "page", model: "vlm-driver", calls: [{ name: "look", args: { selector: "#q", question: QUESTION } }],
        page: (p) => (p.name === "look" ? { result: "The page's look.", image: FORGED, imageLabel: "viewport" } : undefined) });
    const look = w.runCalls().find((p) => p.name === "look" && !p.renderOnly);
    assert.ok(look, "the call went to the page");
    assert.equal(look.args.question, QUESTION);
    assert.ok(!w.runCalls().some((p) => p.geometry), "no geometry was asked: the page ran the tool itself");
    assert.ok(w.seenText().includes("The page's look."));
});

test("a page-built run handed to the worker mid-run runs its next look in the worker: no look call to the page, geometry only", T, async () => {
    const w = await run({ builtBy: "page", builderUrl: "https://builder.example/", model: "text-driver", calls: [{ name: "scroll", args: {} }, { name: "look", args: { question: QUESTION } }],
        page: async (p, n, bg) => {
            if (p.name === "scroll") { await bg.context.__mlUserRunActionForTest(p.runId, "send", { text: "and then look" }); return { result: "Scrolled." }; }
            return { result: "The page's look.", image: FORGED };
        } });
    assert.equal(w.driverBodies.length, 3, "the driver was answered for its look and went on");
    assert.ok(!w.runCalls().some((p) => p.name === "look" && !p.renderOnly && !p.geometry), "the look never reached the page as a call");
    assert.ok(w.runCalls().some((p) => p.geometry), "the page was asked geometry");
    assert.ok(!w.seenText().includes("The page's look."));
    assert.ok(!w.seenText().includes(FORGED.split(",")[1]));
    assert.equal(w.subs.length, 1);
    assert.equal(w.subs[0].model, "reader-vl", "the reader the run was built with");
    for (const s of w.toPage().filter((x) => !x.includes("ADOPT_RUN_NOW"))) assert.ok(!s.includes("Q-SECRET-4242"), s.slice(0, 300));
});

test("a worker-built run with no vision (a text driver, no reader) offers no look; a look it names anyway is the page's unknown tool, never a capture", T, async () => {
    const w = await run({ model: "text-driver", cfg: { ocrModel: "" }, calls: [{ name: "look", args: { question: QUESTION } }],
        page: (p) => (p.name === "look" ? { result: `Error: unknown tool "look"` } : undefined) });
    assert.equal(w.driverBodies.length, 2);
    assert.ok(!(w.driverBodies[0].tools || []).some((t) => (t.function?.name ?? t.name) === "look"), "the kit has no look");
    assert.ok(!w.runCalls().some((p) => p.geometry), "no geometry was asked");
    assert.equal(w.bg.captures.length, 0, "nothing was captured");
    assert.equal(w.subs.length, 0, "no reader call");
});

test("a worker-built run's adopt names no model to the page: the driver, the reader and the grounding model stay in the worker", { ...T, todo: "the ADOPT_RUN_NOW rebuild (content.ts posts it to the page's window as ADOPT_RUN) carries `model`, `visionModel` and `groundingModel`; the page still needs the reader for locate until PR 7" }, async () => {
    const w = await run({ model: "text-driver", calls: [{ name: "look", args: {} }] });
    const adopt = w.bg.tabMessages.map(([, m]) => m).find((m) => m.type === "ADOPT_RUN_NOW");
    assert.ok(adopt, "the run was adopted");
    const rb = plain(adopt.payload.rebuild);
    assert.equal(rb.model ?? null, null, `driver model reached the page: ${rb.model}`);
    assert.equal(rb.visionModel ?? null, null, `reader model reached the page: ${rb.visionModel}`);
    assert.equal(rb.groundingModel ?? null, null, `grounding model reached the page: ${rb.groundingModel}`);
    assert.ok(!JSON.stringify(adopt).includes("reader-vl") && !JSON.stringify(adopt).includes("text-driver"));
});

// --- harness 2: workerLook over the real page geometry on a jsdom page (as tests/worker-vision-host.test.mjs) ---

const SAVE = { left: 300, top: 200, width: 120, height: 40 };
const rectOf = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height });
const READER = { driverSees: false, visionModel: "reader-vl" };
const NATIVE = { driverSees: true, visionModel: "vlm-driver" };

/** Put a jsdom page (a Save button, `height` tall, scrolled to `scrollY`) on the globals the page geometry reads for `fn`. */
async function onPage(fn, { height = 2000, scrollY = 0, innerHeight = 768 } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body><button id="save">Save</button></body></html>`, { pretendToBeVisual: true });
    const win = dom.window, doc = win.document;
    const save = doc.querySelector("#save");
    save.getBoundingClientRect = () => ({ ...rectOf(SAVE), x: SAVE.left, y: SAVE.top, toJSON() {} });
    save.getClientRects = () => [save.getBoundingClientRect()];
    doc.elementFromPoint = () => doc.body;
    doc.elementsFromPoint = () => [doc.body];
    Object.defineProperty(doc.documentElement, "scrollHeight", { value: height, configurable: true });
    Object.defineProperty(win, "innerHeight", { value: innerHeight, configurable: true });
    let y = scrollY;
    const scrolls = [];
    Object.defineProperty(win, "scrollY", { get: () => y, configurable: true });
    win.scrollTo = (_x, to) => { y = Math.max(0, Math.min(to, height - innerHeight)); scrolls.push(y); };
    const globals = { window: win, document: doc, getComputedStyle: win.getComputedStyle.bind(win), Element: win.Element, HTMLElement: win.HTMLElement, Node: win.Node, ShadowRoot: win.ShadowRoot, NodeFilter: win.NodeFilter, HTMLIFrameElement: win.HTMLIFrameElement, HTMLImageElement: win.HTMLImageElement, CSS: win.CSS, location: win.location };
    const before = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    try { return await fn({ scrollY: () => y, scrolls }); }
    finally {
        for (const [k, d] of Object.entries(before)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
        win.close();
    }
}

/**
 * The built worker with run-1's tab 3 showing (document `doc-3`), its capture `shot`, and the page answering geometry
 * with its real page geometry unless `page(q, n, bg)` answers first. `active: false` puts the tab in the background.
 */
function world({ shot = png(1024, 768), page, reply = "A page.", active = true } = {}) {
    const geo = pageGeometry();
    const chats = [];
    const openTabs = [{ id: 3, windowId: 1, active, url: "https://site.example/" }];
    let n = 0, bg;
    bg = loadBackground({
        config: config({ model: "default-model" }),
        openTabs,
        onCaptureTab: async () => (typeof shot === "function" ? shot() : shot),
        onFetch: (c) => { if (c.body?.messages) chats.push(c.body); return jsonResponse({ model: "reader-vl", choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); },
        onTabMessage: async (tabId, msg) => {
            if (!openTabs.some((t) => t.id === tabId)) throw new Error(`No tab with id: ${tabId}.`);
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type !== "RUN_TOOL_IN_PAGE" || !msg.payload?.geometry) return undefined;
            const q = JSON.parse(JSON.stringify(msg.payload.geometry));
            const own = page ? await page(q, ++n, bg) : undefined;
            if (own !== undefined) return JSON.parse(JSON.stringify(own));
            const a = await answerGeometry(geo, q);
            return JSON.parse(JSON.stringify(a ? { result: "", geometry: a } : { result: "Error: unknown op" }));
        },
    });
    const wv = bg.context.__mlWorkerVisionForTest;
    wv.seedRun("run-1", 3);
    const look = (args, vision, { raster = blankRaster(), doc = "doc-3", ...opts } = {}) => wv.workerLook("run-1", 3, doc, args, vision, () => "https://site.example/", { raster, ...opts });
    return { bg, wv, chats, look, geoMsgs: () => bg.tabMessages.filter((a) => a[1].type === "RUN_TOOL_IN_PAGE").map((a) => a[1].payload.geometry) };
}
/** A geometry answer for `q`, its seq and stitch echoed. */
const answer = (q, reply) => ({ result: "", geometry: { seq: q.seq, ...(q.stitch !== undefined ? { stitch: q.stitch } : {}), reply } });

// --- document pinning and refusals of a look in the worker ---

test("a same-document navigation (pushState or a fragment) mid-look refuses the call with the fixed sentence, and nothing reaches the reader", T, async () => {
    await onPage(async () => {
        for (const kind of ["history", "fragment"]) {
            const w = world({ reply: "A blue Save button.", page: (q, _n, bg) => { if (q.op === "view") bg.sameDocumentNav(3, { kind }); return undefined; } });
            const env = await w.look({ selector: "#save", question: "is it blue?" }, READER);
            assert.equal(env.result, `Error: ${GEOMETRY_MOVED}`, kind);
            assert.equal(w.chats.length, 0, `${kind}: no reader call`);
            assert.equal(env.image, undefined);
        }
    });
});

test("a look refused after its reader call still counts that call's spend, and hands the model the fixed sentence only", T, async () => {
    await onPage(async () => {
        // The legend is asked after the reader: a navigation there refuses a call whose model call was already paid for.
        const w = world({ reply: "A blue Save button.", page: (q, _n, bg) => { if (q.op === "legend") bg.commit(3, { documentId: "doc-3b" }); return undefined; } });
        const env = await w.look({ selector: "#save", question: "is it blue?" }, READER);
        assert.equal(env.result, `Error: ${GEOMETRY_MOVED}`);
        assert.equal(w.chats.length, 1, "the reader had been asked");
        assert.ok(!JSON.stringify(env).includes("A blue Save button."), "nothing of the reader's reply");
        assert.equal(env.subUsage?.calls, 1, "the spend that happened is counted");
    });
});

test("a run tab that is not showing (debugger off) gets the capture's own refusal, no image, no reader call", T, async () => {
    await onPage(async () => {
        const w = world({ active: false });
        const env = await w.look({ selector: "#save", question: "?" }, READER);
        assert.match(env.result, /^Error: .*isn't the one showing in its window/);
        assert.equal(env.image, undefined);
        assert.equal(w.chats.length, 0);
        assert.equal(w.bg.captures.length, 0, "no captureVisibleTab of whatever tab is showing");
    });
});

test("a tab replaced under its id mid-look (a prerender or a restored discard) refuses the call; no capture of the replacement", T, async () => {
    await onPage(async () => {
        // The replacement lands after the target is measured and before the capture: every later send and shot names a
        // tab id the browser no longer has (the test's tab refuses a message to a tab that is not open, as Chrome does).
        const w = world({ page: (q, _n, bg) => { if (q.op === "target") bg.replaceTab(3, 30); return undefined; } });
        const env = await w.look({ selector: "#save", question: "?" }, READER);
        assert.match(env.result, /^Error: /);
        assert.equal(env.image, undefined);
        assert.equal(w.chats.length, 0, "no reader call");
        assert.equal(w.bg.captures.length, 0, "no capture of whatever the window shows");
    });
});

// --- the stitch: what the page says about it is validated, and the page is put back on every exit ---

test("a stitch begin whose numbers are not numbers (strings, booleans, negatives, Infinity as null, a fraction of a viewport) is refused before any tile", T, async () => {
    await onPage(async () => {
        const cases = [
            ["a string total", { total: "2000", vh: 768, startY: 0, dpr: 1 }],
            ["a boolean vh", { total: 2000, vh: true, startY: 0, dpr: 1 }],
            ["a fractional vh", { total: 2000, vh: 767.5, startY: 0, dpr: 1 }],
            ["a negative total", { total: -2000, vh: 768, startY: 0, dpr: 1 }],
            ["an object startY", { total: 2000, vh: 768, startY: { valueOf: 1 }, dpr: 1 }],
            ["a missing dpr", { total: 2000, vh: 768, startY: 0 }],
            ["an array reply", [2000, 768, 0, 1]],
        ];
        for (const [what, reply] of cases) {
            const w = world({ page: (q) => (q.op === "stitchBegin" ? answer(q, reply) : undefined) });
            const env = await w.look({ scope: "page" }, NATIVE);
            assert.equal(env.result, `Error: ${GEOMETRY_REFUSED}`, what);
            assert.equal(w.geoMsgs().filter((g) => g.op === "stitchTile").length, 0, what);
        }
    });
});

test("a tile whose actualY is negative, a string, null (NaN or Infinity on the wire) or missing ends the look with the fixed sentence", T, async () => {
    await onPage(async () => {
        for (const [what, reply] of [["negative", { actualY: -1, isLast: false }], ["a string", { actualY: "0", isLast: false }], ["null", { actualY: null, isLast: false }], ["missing", { isLast: true }], ["not an object", 0]]) {
            const w = world({ page: (q) => (q.op === "stitchTile" ? answer(q, reply) : undefined) });
            const env = await w.look({ scope: "page" }, NATIVE);
            assert.equal(env.result, `Error: ${GEOMETRY_REFUSED}`, what);
            assert.equal(env.image, undefined, what);
            assert.equal(w.geoMsgs().at(-1).op, "stitchEnd", `${what}: the page is restored`);
        }
    });
});

test("a stitch the worker refuses after the page began it (a viewport that disagrees, a begin answered too late) still ends it, so the page's scroll comes back", { ...T, todo: "stitchEnd is sent only once the worker accepted the begin (worker-vision-host.ts `stitch` is set after the checks), but the page's stitchBegin has already scrolled to probe its pinned overlays; a refused or late begin leaves the page scrolled" }, async () => {
    // The page starts at 300; its own stitchBegin scrolls to 0 and to one viewport down to probe its overlays.
    for (const [what, opts] of [
        ["the viewport the worker measured disagrees with the begin's", { page: (q) => (q.op === "view" ? answer(q, { w: 1024, h: 700, dpr: 1, sx: 0, sy: 300 }) : undefined), shot: png(1024, 700) }],
        ["the begin was answered after the per-question bound", { slow: true }],
    ]) {
        await onPage(async ({ scrollY }) => {
            const geo = pageGeometry();
            const w = world({ shot: opts.shot, page: async (q) => {
                if (opts.page) { const r = opts.page(q); if (r) return r; }
                if (opts.slow && q.op === "stitchBegin") { const a = await answerGeometry(geo, q); await new Promise((r) => setTimeout(r, 400)); return { result: "", geometry: a }; }
                if (q.op.startsWith("stitch")) return { result: "", geometry: await answerGeometry(geo, q) };
                return undefined;
            } });
            const env = await w.look({ scope: "page" }, NATIVE, opts.slow ? { opMs: 100 } : {});
            await new Promise((r) => setTimeout(r, 600));
            assert.match(env.result, /^Error: /, what);
            assert.ok(w.geoMsgs().some((g) => g.op === "stitchEnd"), `${what}: no stitchEnd was sent`);
            assert.equal(scrollY(), 300, `${what}: the page was left scrolled to ${scrollY()}`);
        }, { scrollY: 300 });
    }
});

// --- the stitch's tiles are composed at their real height ---

test("a full-page look in the worker composes each tile at its capture's real height: a capture shorter than the viewport leaves no undrawn band", { ...T, todo: "composeStitch draws each tile at y*dpr and steps the page by the reported viewport height; a debugger capture shorter than the viewport (457 of 600 px in the e2e harness) leaves the bottom of every tile undrawn in the stitch (tests/e2e/vision-capture.spec.mjs reads the bands near each tile's top to step round it)" }, async () => {
    await onPage(async () => {
        const raster = recordingRaster();
        const w = world({ shot: png(1024, 600) });   // the viewport is 768 tall; the capture only its top 600
        const env = await w.look({ scope: "page" }, NATIVE, { raster });
        if (/^Error: /.test(env.result)) return;   // refusing a stitch it cannot cover is also correct
        const compose = raster.canvases.at(-1);
        assert.equal(compose.height, 2000);
        assert.equal(uncoveredRows(compose), 0, `rows no capture drew: ${uncoveredRows(compose)} of ${compose.height}; tiles ${JSON.stringify(compose.draws.map((d) => [d.a[1], d.src.h]))}`);
    });
});

test("the page host's stitch has the same short-capture gap: stitchVia composes tiles at the viewport step whatever each capture's height", { ...T, todo: "shared with the worker: ml-vision.ts `stitchVia`/`composeStitch` never read a tile's own height, so a page-hosted full-page look under the debugger has the same undrawn bands" }, async () => {
    const raster = recordingRaster();
    let y = 0;
    const geo = {
        stitchBegin: async () => ({ total: 1800, vh: 600, startY: 0, dpr: 1 }),
        stitchTile: async ({ y: to }) => { y = Math.min(to, 1200); return { actualY: y, isLast: y + 600 >= 1800 }; },
        stitchEnd: async () => {},
    };
    await stitchVia({ geo, raster }, async () => png(800, 457));
    const compose = raster.canvases.at(-1);
    assert.equal(compose.height, 1800);
    assert.equal(uncoveredRows(compose), 0, `rows no capture drew: ${uncoveredRows(compose)}`);
});

test("an element below a short capture's bottom edge is refused as off the capture, not cropped to a blank the reader is asked about", T, async () => {
    await onPage(async () => {
        const w = world({ shot: png(1024, 600), reply: "A button.", page: (q) => (q.op === "target" && q.selector ? answer(q, { rect: rectOf({ left: 300, top: 650, width: 120, height: 40 }) }) : undefined) });
        const env = await w.look({ selector: "#save", question: "?" }, READER, { raster: recordingRaster() });
        assert.equal(env.result, `Error: ${OFF_CAPTURE}`);
        assert.equal(w.chats.length, 0);
    });
});

// --- the mask: which of the extension's frames the shell reports (pure DOM; the paint is the e2e's) ---

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
/** `extensionRects` on a jsdom page built by `build(doc)`, every element laid out at 100×100 at (10,10). */
function rectsOn(build) {
    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { pretendToBeVisual: true });
    const win = dom.window, doc = win.document;
    build(doc);
    win.Element.prototype.getBoundingClientRect = function () { return { left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100, x: 10, y: 10 }; };
    const saved = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
    Object.assign(globalThis, { document: doc, window: win, getComputedStyle: win.getComputedStyle.bind(win) });
    try { return extensionRects({ hosts: [], lightboxId: "ml-lightbox", highlightId: "ml-highlight", extensionOrigin: EXT }); }
    finally { Object.assign(globalThis, saved); win.close(); }
}

test("an extension frame the page embeds in the document itself is reported for the mask", T, () => {
    const r = rectsOn((doc) => { const f = doc.createElement("iframe"); f.src = `${EXT}sidebar.html`; doc.body.append(f); });
    assert.deepEqual(r.rects.map((x) => x.kind), ["frame"]);
});

test("an extension page the page embeds where `document.querySelectorAll(\"iframe\")` does not look (its own shadow root, an <object>, an <embed>) is still reported for the mask", { ...T, todo: "extensionRects finds extension frames with document.querySelectorAll(\"iframe\") on f.src: sidebar.html is web-accessible to every site, so a page can show it inside its own shadow root, or as an <object>/<embed>, and it is painted into the worker's shot unmasked" }, () => {
    for (const [what, build] of [
        ["an iframe in the page's own shadow root", (doc) => { const h = doc.createElement("div"); doc.body.append(h); const f = doc.createElement("iframe"); f.src = `${EXT}sidebar.html`; h.attachShadow({ mode: "closed" }).append(f); }],
        ["an <object>", (doc) => { const o = doc.createElement("object"); o.data = `${EXT}sidebar.html`; doc.body.append(o); }],
        ["an <embed>", (doc) => { const e = doc.createElement("embed"); e.src = `${EXT}sidebar.html`; doc.body.append(e); }],
    ]) {
        const r = rectsOn(build);
        assert.ok(r.rects.some((x) => x.kind === "frame"), `${what} was not reported`);
    }
});
