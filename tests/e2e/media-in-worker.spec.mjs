// media-in-worker.spec.mjs — the ratchet of site-access part 3 (the vision split): a run whose vision is the worker's
// sends nothing vision-shaped from its page. A full run (look, locate, a click and a type each with `verify`, an answer
// with media, python_exec with an `image`) on a real tab, counted at the worker's router by sender: the run's page sent
// ZERO of CAPTURE_TAB, FETCH_LLM, MODEL_CAPS, GET_CONFIG and FETCH_IMAGE_B64, nor opened a model stream. Once for a run the
// worker built, once for a page-built run after it was handed to the worker (an eviction's durable resume,
// `makeWorkerRun`). Any later change that has the page capture, call a model or read the config for such a run fails here.
//
// The answer's media and python's image are cropped from the worker's own masked capture (src/sw/worker-media.ts), never
// fetched from a page-supplied src: the <img> here is a flat green PNG the page draws at 120×80, and the HUD card's crop is
// that green at that size.
import { test, expect } from "@playwright/test";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

test.describe.configure({ mode: "default" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a page must not send for a run whose vision is the worker's (the part-3 goal, docs/spec/SITE_ACCESS.md). */
const FORBIDDEN = ["CAPTURE_TAB", "FETCH_LLM", "MODEL_CAPS", "GET_CONFIG", "FETCH_IMAGE_B64"];

/** A `w`×`h` PNG of one colour, built by hand (no image library in the test). */
function solidPng(w, h, [r, g, b]) {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// The image is 240×160 at its source and drawn at 120×80: a crop of the capture is 120×80, a fetch of the src 240×160.
const PIC = solidPng(240, 160, [0, 255, 0]);
const PAGE = `<!doctype html><html><head><title>Ratchet</title><style>
html,body{margin:0;background:#fff} button,input,img{position:absolute;border:0;padding:0;margin:0}
button{width:200px;height:100px;font-size:0} #a{left:50px;top:40px;background:rgb(255,0,0)} #b{left:400px;top:300px;background:rgb(0,0,255)}
#f{left:50px;top:300px;width:200px;height:40px;background:#eee;font-size:16px} #pic{left:600px;top:60px;width:120px;height:80px}
</style></head><body><button id="a" onclick="this.dataset.clicked='1'">Red</button><button id="b">Blue</button>
<input id="f" aria-label="Name"><img id="pic" alt="green" src="/pic.png"></body></html>`;

/** Serve PAGE and its image on 127.0.0.1. */
async function servePage() {
    const srv = http.createServer((req, res) => {
        if (req.url?.startsWith("/pic.png")) { res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(PIC); return; }
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(PAGE);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/**
 * Count every message and port a TAB opens to the worker, at the worker's own router: a listener beside the real one
 * sees each `chrome.runtime.sendMessage` and `connect` with the sender the browser set. The extension's own frames
 * (the sidebar, a chrome-extension:// page) are not the page and are left out.
 */
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
/** The forbidden sends among `msgs`: a FORBIDDEN type, or a model stream port. */
const forbidden = (msgs) => msgs.filter((m) => FORBIDDEN.includes(m.type) || /^PORT:.*(llm|LLM)/.test(m.type));

/** What a tab hosting a run may still send whatever its origin (src/page-relay.ts `RUN_TAB_TYPES`), read from the source
 *  so the list here is never a stale copy: none of it is sent by this script's run, whose every tool runs in the worker
 *  or answers geometry. */
const RUN_TAB_TYPES = (() => {
    const src = fs.readFileSync(new URL("../../src/page-relay.ts", import.meta.url), "utf8");
    const body = src.match(/export const RUN_TAB_TYPES[^[]*\[([^\]]*)\]/);
    if (!body) throw new Error("RUN_TAB_TYPES not found in src/page-relay.ts");
    return [...body[1].matchAll(/"([A-Z_0-9]+)"/g)].map((m) => m[1]);
})();

/** Decode `src` in `page` and read its size and the colour at its centre. */
const centre = (page, src) => page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, at: Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)) };
}, src);

/**
 * The fake model's turns once the run is the worker's: every vision tool, each verify, python over an image (once to
 * read its pixels, once to `cast` a point in it and click the token that comes back), and the answer of an `<img>` and of
 * a button.
 */
const SCRIPT = [
    { tool: "look", args: {} },
    { tool: "locate", args: { description: "a red rectangle", strategy: "marks" } },
    { tool: "click", args: { selector: "#a", verify: true } },
    { tool: "type", args: { selector: "#f", text: "hello", verify: true } },
    { tool: "python_exec", args: { code: "return [int(x) for x in img_np.shape] + [int(v) for v in img_np[50, 100]]", image: "#b" } },
    { tool: "python_exec", args: { code: "return [100, 50]", image: "#b", cast: "pt" } },
    // The token python minted: a click on it resolves in the page's registry, or fails.
    (body) => {
        const t = JSON.stringify(body.messages).match(/@pt:[0-9a-f]+/g)?.at(-1);
        return t ? { tool: "click", args: { selector: t } } : { content: "no token" };
    },
    { tool: "answer", args: { selector: "#pic", note: "the picture" } },
    { tool: "answer", args: { selector: "#a" } },
    { content: "done" },
];

/** Every gate approved as it opens, the way an approver outside the browser does. */
function approveAll(ext) {
    let stop = false;
    const loop = (async () => {
        while (!stop) {
            const gates = await ext.sw.evaluate(() => globalThis.__mlApprovals?.list?.() ?? []).catch(() => []);
            for (const g of gates) await ext.sw.evaluate(({ key }) => globalThis.__mlApprovals.resolve(key, true), { key: g.key }).catch(() => {});
            await sleep(100);
        }
    })();
    return async () => { stop = true; await loop; };
}

/** The tool results the driver was sent in its last call, in order. */
const toolResults = (fake) => (fake.calls().filter((c) => c.tools?.length).at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

/** A fake model (declared vision-capable, so it is its own reader), the page's server, and the extension. */
async function setup() {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await servePage();
    const ext = await launchExtension();
    const subs = [];
    fake.setSide((body) => {
        subs.push(body);
        const m = body.messages.at(-1);
        const p = typeof m.content === "string" ? m.content : m.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
        return { content: p.startsWith("The screenshot has numbered badges") ? "1" : "a red button" };
    });
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", defaultModelVision: "yes", debugMode: "off", autoApprovePython: true });
    return { fake, site, ext, subs, close: async () => { await ext.close(); fake.stop?.(); await site.close(); } };
}

/**
 * Watch a tab's run events from an extension page in a WINDOW OF ITS OWN, as the DevTools panel does. Not
 * `watchRunEvents`, which opens its page as a tab beside the run's: a headless capture of the run's window can show that
 * most recently opened page whatever `chrome.tabs` says is active, and every crop would be of the watcher.
 */
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

/** The run's `n`th agent-result, as the worker fanned it. */
async function untilResult(events, n = 1, ms = 90000) {
    for (let i = 0; i < ms / 100 && events.filter((e) => e.kind === "agent-result").length < n; i++) await sleep(100);
    return events.filter((e) => e.kind === "agent-result")[n - 1];
}

/** A fresh 800×600 tab of the page, and its tab id. */
async function openPage(r, approve) {
    const page = await r.ext.context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(r.site.url);
    await waitForMl(page, { approve });
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    const tabId = await r.ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, r.site.url);
    return { page, tabId };
}

/**
 * What the run did, as the model and the person were given it, held to the page's own pixels: look and locate
 * answered, each verify a picture, python's image #b's 200×100 blue crop, its cast's token clickable in the page, and
 * the HUD card's media each cropped from the capture (the `<img>` at its drawn 120×80, green, never its 240×160 file).
 */
async function expectTheRun(r, page, result) {
    expect(result, "the run finished").toBeTruthy();
    expect(result.error, "the run did not fail").toBeFalsy();
    const out = toolResults(r.fake);
    expect(out.length, JSON.stringify(out)).toBe(SCRIPT.length - 1);
    expect(out[0]).toContain("Screenshot of the viewport captured");
    expect(out[1]).toContain('Matched "a red rectangle" → #1 [button] "Red" → #a');
    expect(out[2]).toContain("Here's the area where you clicked");
    expect(out[3]).toContain("Here's the field input#f after you typed it");
    expect(out[4], "python saw #b's crop: 100 rows, 200 columns, blue").toContain("[100,200,3,0,0,255]");
    // (100, 50) in #b's crop is (500, 350) on the page: #b's centre.
    expect(out[5]).toMatch(/→ @pt:[0-9a-f]+ at \(500, 350\)/);
    expect(out[6], "the cast's token resolved in the page's registry").not.toMatch(/Unknown point token|Error/);
    expect(await page.evaluate(() => document.querySelector("#a").dataset.clicked), "the verified click landed").toBe("1");
    expect(await page.evaluate(() => document.querySelector("#f").value)).toBe("hello");
    const media = result.answerMedia || [];
    expect(media.map(({ image: _i, ...m }) => m)).toEqual([
        { selector: "body > img#pic", kind: "image", mode: "inline", label: "the picture" },
        { selector: "body > button#a", kind: "element", mode: "highlight" },
    ]);
    const pic = await centre(page, media[0].image);
    expect(pic, "the <img> cropped from the capture at its drawn size, not fetched from its src").toEqual({ w: 120, h: 80, at: [0, 255, 0] });
    const btn = await centre(page, media[1].image);
    expect(btn).toEqual({ w: 200, h: 100, at: [255, 0, 0] });
}

/** The ratchet itself: the tab sent none of FORBIDDEN, and nothing of RUN_TAB_TYPES at all. */
function expectNothingSent(sent) {
    expect(forbidden(sent), `the run's page sent a vision message: ${JSON.stringify(sent.map((m) => m.type))}`).toEqual([]);
    expect(sent.filter((m) => RUN_TAB_TYPES.includes(m.type)).map((m) => m.type), "the run's page needed none of what a run tab may send").toEqual([]);
}

// --- the ratchet: a run the worker built ---

test("a worker-built run's look, locate, verified click and type, answer media and python image: its page sends no capture, model call, capability or config read, and no image fetch", async () => {
    test.setTimeout(150000);
    const r = await setup();
    const stopApprover = approveAll(r.ext);
    try {
        const { page, tabId } = await openPage(r, false);
        const events = [];
        const watch = await watchInOwnWindow(r.ext, tabId, (ev) => events.push(ev));
        await page.bringToFront();
        await startCounting(r.ext.sw);
        r.fake.setScript(SCRIPT);
        await r.ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "look around and hand me the picture", hud: "quiet", surface: "hud" }, { approvalRouting: "both", answer: true }), tabId);
        const result = await untilResult(events);
        await watch.close();
        await expectTheRun(r, page, result);
        expectNothingSent(await counted(r.ext.sw, tabId));
    } finally { await stopApprover(); await r.close(); }
});

// --- the ratchet: a page-built run, once it is handed to the worker ---

test("a page-built run handed to the worker (an eviction's durable resume): after the hand-over its page sends no capture, model call, capability or config read, and no image fetch", async () => {
    test.setTimeout(150000);
    const r = await setup();
    let stopApprover = null;
    try {
        const { page, tabId } = await openPage(r, true);
        // The page builds the run, which pauses at its first gate (an exec that writes).
        r.fake.setScript([{ tool: "exec", args: { js: "document.title = 'X'; 'ok'" } }, ...SCRIPT]);
        await page.evaluate(() => { window.ml.agent("look around and hand me the picture", { env: false, approvalRouting: "external", answer: true, extraTools: [window.ml.pythonTool()] }); return true; });
        await expect.poll(async () => (await r.ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 20000 }).toBe(1);
        // The worker restarts; the run is the worker's from here (`makeWorkerRun`), and continues once its page re-adopts it.
        await r.ext.sw.evaluate(() => globalThis.__mlEvictForTest());
        const events = [];
        const watch = await watchInOwnWindow(r.ext, tabId, (ev) => events.push(ev));
        await page.bringToFront();
        stopApprover = approveAll(r.ext);
        await startCounting(r.ext.sw);
        const before = (await counted(r.ext.sw, tabId)).length;
        await page.reload();
        await waitForMl(page, { approve: false });
        const result = await untilResult(events);
        await watch.close();
        await expectTheRun(r, page, result);
        expectNothingSent((await counted(r.ext.sw, tabId)).slice(before));
    } finally { await stopApprover?.(); await r.close(); }
});
