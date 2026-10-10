// review-media.spec.mjs — the validation and coverage review of #571 in a real browser: the ratchet's counter
// (media-in-worker.spec.mjs) shown to COUNT what a page sends, so its "nothing sent" is not vacuous; a page-built run that
// was never handed over still answers its media the page's way (main's `captureAnswer`: an <img> fetched from its src);
// a worker-built answer of six elements gets six crops of the right element each; and the harness finding that
// `watchRunEvents`'s watcher tab is what a headless capture of the run's window shows.
import { test, expect } from "@playwright/test";
import http from "node:http";
import zlib from "node:zlib";
import { launchExtension, configureExtension, waitForMl, watchRunEvents } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

test.describe.configure({ mode: "default" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The types media-in-worker.spec.mjs forbids, and its port rule, copied so this file proves ITS counter. */
const FORBIDDEN = ["CAPTURE_TAB", "FETCH_LLM", "MODEL_CAPS", "GET_CONFIG", "FETCH_IMAGE_B64"];
const forbidden = (msgs) => msgs.filter((m) => FORBIDDEN.includes(m.type) || /^PORT:.*(llm|LLM)/.test(m.type));

/** A `w`×`h` PNG of one colour. */
function solidPng(w, h, [r, g, b]) {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

// Both <img>s are 240×160 green at their source, drawn at 120×80: #pic served from 127.0.0.1 (which the background's
// FETCH_IMAGE_B64 refuses as loopback, so main's formula falls back to a crop there), #dpic a data: URL (which main's
// formula hands back as its source, 240×160, with no fetch). Six tiles of six colours, each 100×60.
const PIC = solidPng(240, 160, [0, 255, 0]);
const COLOURS = [[255, 0, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [128, 0, 0]];
const PAGE = `<!doctype html><html><head><title>Review</title><style>
html,body{margin:0;background:#fff} .t,img,#a{position:absolute;border:0;padding:0;margin:0}
#a{left:50px;top:40px;width:200px;height:100px;background:rgb(255,0,0);font-size:0}
#pic{left:600px;top:60px;width:120px;height:80px}
#dpic{left:300px;top:200px;width:120px;height:80px}
.t{width:100px;height:60px;top:400px}
${COLOURS.map((c, i) => `#t${i}{left:${20 + i * 125}px;background:rgb(${c.join(",")})}`).join("\n")}
</style></head><body><button id="a">Red</button><img id="pic" alt="green" src="/pic.png"><img id="dpic" alt="green inline" src="data:image/png;base64,${PIC.toString("base64")}">
${COLOURS.map((_, i) => `<div class="t" id="t${i}"></div>`).join("")}</body></html>`;

async function servePage() {
    const srv = http.createServer((req, res) => {
        if (req.url?.startsWith("/pic.png")) { res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(PIC); return; }
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(PAGE);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** media-in-worker.spec.mjs's counter, verbatim: every message and port a tab opens to the worker, by sender. */
const startCounting = (sw) => sw.evaluate(() => {
    const g = globalThis;
    g.__ratchet = [];
    if (g.__ratchetOn) return;
    g.__ratchetOn = true;
    const own = (s) => String(s?.url || s?.origin || "").startsWith("chrome-extension://");
    chrome.runtime.onMessage.addListener((m, s) => { if (s.tab && !own(s)) g.__ratchet.push({ type: String(m?.type), tab: s.tab.id, frame: s.frameId, ts: Date.now() }); return false; });
    chrome.runtime.onConnect.addListener((p) => { const s = p.sender; if (s?.tab && !own(s)) g.__ratchet.push({ type: `PORT:${p.name}`, tab: s.tab.id, frame: s.frameId, ts: Date.now() }); });
});
const counted = (sw, tabId) => sw.evaluate((id) => globalThis.__ratchet.filter((m) => m.tab === id), tabId);

/** Decode `src` in `page`: its size and the colour at its centre. */
const centre = (page, src) => page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, at: Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)) };
}, src);

async function setup() {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await servePage();
    const ext = await launchExtension();
    fake.setSide(() => ({ content: "a page" }));
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", defaultModelVision: "yes", debugMode: "off", autoApprovePython: true });
    return { fake, site, ext, close: async () => { await ext.close(); fake.stop?.(); await site.close(); } };
}

async function openPage(r, approve) {
    const page = await r.ext.context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(r.site.url);
    await waitForMl(page, { approve });
    const tabId = await r.ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, r.site.url);
    return { page, tabId };
}

/** media-in-worker.spec.mjs's watcher: an extension page in a window of its own. */
async function watchInOwnWindow(ext, tabId, onEvent) {
    const opened = ext.context.waitForEvent("page");
    await ext.sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), focused: false }));
    const watcher = await opened;
    await watcher.waitForLoadState();
    await watcher.exposeFunction("__onRunEvent", (ev) => onEvent(ev));
    await watcher.evaluate((id) => new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "ml-devtools" });
        port.onMessage.addListener((m) => {
            if (Array.isArray(m.replay)) { for (const ev of m.replay) window.__onRunEvent(ev); resolve(undefined); }
            else if (m.__mlDebug) window.__onRunEvent(m.__mlDebug);
        });
        port.postMessage({ type: "ml-devtools-init", tabId: id });
    }), tabId);
    return { close: () => watcher.close() };
}

async function untilResult(events, ms = 90000) {
    for (let i = 0; i < ms / 100 && !events.some((e) => e.kind === "agent-result"); i++) await sleep(100);
    return events.find((e) => e.kind === "agent-result");
}

/** A worker-built run of `script` on `tabId`, its events watched by `watch(ext, tabId|page, onEvent)`. */
async function workerRun(r, tabId, script, watchFn) {
    const events = [];
    const watch = await watchFn((ev) => events.push(ev));
    r.fake.setScript(script);
    await r.ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "hand me the tiles", hud: "quiet", surface: "hud" }, { approvalRouting: "both", answer: true }), tabId);
    const result = await untilResult(events);
    await watch.close();
    return result;
}

// --- the ratchet's counter counts: its "nothing sent" is not vacuous ---

test("the ratchet's counter sees a page's CAPTURE_TAB and its model stream port, from the run's tab, and its forbidden rule matches both", async () => {
    test.setTimeout(90000);
    const r = await setup();
    try {
        const { page, tabId } = await openPage(r, true);
        await startCounting(r.ext.sw);
        await page.evaluate(() => window.ml.screenshot());
        r.fake.setScript([{ content: "streamed reply" }]);
        await page.evaluate(() => window.ml.chat("hi", { onToken: () => {} }));
        const sent = await counted(r.ext.sw, tabId);
        expect(sent.map((m) => m.type)).toEqual(expect.arrayContaining(["CAPTURE_TAB", "PORT:LLM_STREAM"]));
        expect(forbidden(sent).map((m) => m.type)).toEqual(expect.arrayContaining(["CAPTURE_TAB", "PORT:LLM_STREAM"]));
        expect(sent.every((m) => m.frame === 0), "the content script runs in the top frame only (no all_frames), so every send is frame 0").toBe(true);
    } finally { await r.close(); }
});

// --- a page-built run never handed over: the page's own vision, as on main ---

test("a page-built run that was never handed over answers its media by main's formula: a data: <img> is its source (240×160), a loopback <img> falls back to a crop after a refused FETCH_IMAGE_B64, a button is cropped; the ratchet's counter sees the page's captures", async () => {
    test.setTimeout(120000);
    const r = await setup();
    try {
        const { page, tabId } = await openPage(r, true);
        await startCounting(r.ext.sw);
        r.fake.setScript([
            { tool: "answer", args: { selector: "#dpic", note: "the picture" } },
            { tool: "answer", args: { selector: "#pic" } },
            { tool: "answer", args: { selector: "#a", show: "inline" } },
            { content: "done" },
        ]);
        const res = await page.evaluate(async () => {
            const out = await window.ml.agent("hand me the picture", { env: false, answer: true });
            return { answerMedia: out.answerMedia, error: out.error };
        });
        expect(res.error).toBeFalsy();
        const media = res.answerMedia || [];
        // main's captureAnswer: the path, kind, mode (show overriding), the note as label.
        expect(media.map(({ image: _i, ...m }) => m)).toEqual([
            { selector: "body > img#dpic", kind: "image", mode: "inline", label: "the picture" },
            { selector: "body > img#pic", kind: "image", mode: "inline" },
            { selector: "body > button#a", kind: "element", mode: "inline" },
        ]);
        expect(media[0].image.startsWith("data:image/png;base64,"), "the data: src handed back as it is").toBe(true);
        expect(await centre(page, media[0].image), "the <img>'s own source, as main hands it back").toEqual({ w: 240, h: 160, at: [0, 255, 0] });
        expect(await centre(page, media[1].image), "loopback src refused: the crop fallback").toEqual({ w: 120, h: 80, at: [0, 255, 0] });
        expect(await centre(page, media[2].image)).toEqual({ w: 200, h: 100, at: [255, 0, 0] });
        const sent = (await counted(r.ext.sw, tabId)).map((m) => m.type);
        expect(sent, "main's formula asked the background for the loopback src").toContain("FETCH_IMAGE_B64");
        expect(forbidden(sent.map((type) => ({ type }))).map((m) => m.type), "positive control for the ratchet: this run's page sends captures").toContain("CAPTURE_TAB");
    } finally { await r.close(); }
});

// --- a worker-built answer of six elements: six captures, each the right element ---

test("a worker-built answer of six elements gets six crops, each of its own element and colour, despite the browser's capture rate", async () => {
    test.setTimeout(150000);
    const r = await setup();
    try {
        const { page, tabId } = await openPage(r, false);
        await page.bringToFront();
        await startCounting(r.ext.sw);
        const result = await workerRun(r, tabId, [{ tool: "answer", args: { selector: ".t" } }, { content: "done" }], (on) => watchInOwnWindow(r.ext, tabId, on));
        const media = result?.answerMedia || [];
        expect(media.length).toBe(6);
        const got = [];
        for (const m of media) got.push(await centre(page, m.image));
        // Each crop is its own tile. Its height is 60, or 57: from about the second capture on, a headless capture of this
        // window clips the tiles' bottom 3px, and a page-built run's crops do the same (checked while writing this), so
        // it is not the worker's.
        expect(got.map((g) => g.at)).toEqual(COLOURS);
        expect(got.every((g) => g.w === 100 && g.h >= 57 && g.h <= 60), JSON.stringify(got)).toBe(true);
        expect(forbidden(await counted(r.ext.sw, tabId))).toEqual([]);
    } finally { await r.close(); }
});

// --- the harness finding: watchRunEvents opens its watcher as a tab in the run's window ---

// Confirmed while writing this: the crop is 320×160 of white (the watcher's popup page), not the red 200×100 button. No
// existing spec asserts pixels under watchRunEvents (answer.spec.mjs's selector answer is cropped from the watcher
// silently; cross-page.spec.mjs's "answer → HUD" run is page-built and checks only a data: prefix), but run-once.mjs
// (observe) watches every run with it, so a headless observe run's look, locate and verify see the watcher.
test("with watchRunEvents watching (the harness's watcher tab beside the run's), a worker-built answer's crop is of the run's tab", async () => {
    test.setTimeout(120000);
    const r = await setup();
    try {
        const { page, tabId } = await openPage(r, false);
        const result = await workerRun(r, tabId, [{ tool: "answer", args: { selector: "#a" } }, { content: "done" }], (on) => watchRunEvents(r.ext, page, on));
        const m = result?.answerMedia?.[0];
        expect(m?.image, "the crop was made").toMatch(/^data:image\//);
        expect(await centre(page, m.image), "the run's red button, not the watcher's popup").toEqual({ w: 200, h: 100, at: [255, 0, 0] });
    } finally { await r.close(); }
});

// --- a stricter ratchet: every page-started type, not only RUN_TAB_TYPES and five vision types ---

test("a worker-built run's page sends no page-started type at all during a look, a python image and an answer of a data: <img>, which is cropped, not handed back", async () => {
    test.setTimeout(150000);
    const r = await setup();
    try {
        const { page, tabId } = await openPage(r, false);
        await page.bringToFront();
        await startCounting(r.ext.sw);
        const result = await workerRun(r, tabId, [
            { tool: "look", args: {} },
            { tool: "python_exec", args: { code: "return [int(x) for x in img_np.shape]", image: "#a" } },
            { tool: "answer", args: { selector: "#dpic" } },
            { content: "done" },
        ], (on) => watchInOwnWindow(r.ext, tabId, on));
        expect(result?.answerMedia?.length, "positive control: the run finished with media").toBe(1);
        expect(await centre(page, result.answerMedia[0].image), "a data: <img> is cropped at its drawn size, never handed back as its src").toEqual({ w: 120, h: 80, at: [0, 255, 0] });
        const { PAGE_STARTED_TYPES } = await import("../../src/page-relay.ts").catch(() => ({ PAGE_STARTED_TYPES: null }));
        const sent = await counted(r.ext.sw, tabId);
        expect(PAGE_STARTED_TYPES, "the relay's list loaded").toBeTruthy();
        expect(sent.filter((m) => PAGE_STARTED_TYPES.has(m.type)).map((m) => m.type)).toEqual([]);
    } finally { await r.close(); }
});

