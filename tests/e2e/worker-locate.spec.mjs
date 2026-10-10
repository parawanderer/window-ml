// worker-locate.spec.mjs — a worker-built run's `locate` in a real browser (site-access part 3 PR 7,
// src/sw/worker-locate.ts): the worker captures the run's tab, draws the Set-of-Marks badges or the grounding letterbox
// with its own raster (OffscreenCanvas), calls the vision model itself, and asks the page for geometry only.
//
// tests/vision-characterize.test.mjs pins the message flow and the drawing recipes in node:vm, where the canvas is a
// recorder. What it cannot show is the real thing: real pixels drawn by a real OffscreenCanvas over a real capture. The
// page is an unapproved http origin with two solid-colour buttons, the run is started the way the Commander starts one,
// and the fake model (declared vision-capable, so it is its own reader) answers locate's vision sub-calls by their prompt.
//
// At device scale 1 only: under Playwright's EMULATED device scale the capture's size and the page's reported ratio
// disagree, which the worker resolves in the capture's favour and logs.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><title>Locate</title><style>
html,body{margin:0;background:#fff} button{position:absolute;border:0;padding:0;margin:0;width:200px;height:100px;font-size:0}
#a{left:50px;top:40px;background:rgb(255,0,0)} #b{left:400px;top:300px;background:rgb(0,0,255)}
</style></head><body><button id="a">Red</button><button id="b">Blue</button></body></html>`;

/** Serve PAGE on 127.0.0.1, an origin nobody approves. */
async function servePage() {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(PAGE); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** Record every message posted on the page's window: what any script on the page can read. */
const recordWindow = (page) => page.evaluate(() => {
    window.__posted = [];
    window.addEventListener("message", (e) => { try { window.__posted.push(JSON.stringify(e.data)); } catch { window.__posted.push("?"); } });
});

/** The page's window carried no capture, model call, config or capability read, image fetch, image, prompt or model name. */
async function expectNoVisionOnPage(page, secrets) {
    const posted = await page.evaluate(() => window.__posted);
    expect(posted.length, "the page answered geometry, so its window carried messages").toBeGreaterThan(0);
    const types = posted.map((m) => { try { return JSON.parse(m)?.type; } catch { return "?"; } });
    expect(types.filter((t) => /CAPTURE_TAB|LLM_REQUEST|LLM_RESPONSE|B64_REQUEST|CONFIG|CAPS/.test(String(t))), "a vision message crossed the page's window").toEqual([]);
    expect(posted.filter((m) => m.includes("data:image")), "an image crossed the page's window").toEqual([]);
    for (const s of secrets) expect(posted.filter((m) => m.includes(s)), `"${s}" crossed the page's window`).toEqual([]);
}

/** Decode `src` in `page` and read its size and the colour at each [x, y]. */
const colours = (page, src, points) => page.evaluate(async ({ src, points }) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, at: points.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))) };
}, { src, points });

/** The data-URL images in a request body. */
const imagesIn = (body) => JSON.stringify(body).match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [];
/** A request's last user text. */
const promptOf = (body) => { const m = body.messages.at(-1); return typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"); };

/** Start a worker-built run on a fresh tab of PAGE whose driver calls `locate(args)` once, the fake answering sub-calls
 *  with `side(prompt)`. Resolves when the driver was asked again after the call. */
async function locateRun(args, side, cfg = {}) {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await servePage();
    const ext = await launchExtension();
    const subs = [];
    fake.setSide((body) => { subs.push(body); return { content: side(promptOf(body)) }; });
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", defaultModelVision: "yes", debugMode: "off", ...cfg });
    fake.setScript([{ tool: "locate", args }, { content: "done" }]);
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(site.url);
    await waitForMl(page, { approve: false });
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    await recordWindow(page);
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
    await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "find the red button", hud: "quiet", surface: "hud" }), tabId);
    const driver = () => fake.calls().filter((c) => c.tools?.length);
    for (let i = 0; i < 200 && driver().length < 2; i++) await sleep(100);
    expect(driver().length, "the driver was asked again after its locate").toBeGreaterThanOrEqual(2);
    return { fake, site, ext, page, subs, turn2: driver()[1], close: async () => { await ext.close(); fake.stop?.(); await site.close(); } };
}

// --- Set-of-Marks, drawn by the worker ---

test("a worker-built locate by Set-of-Marks: the reader gets the worker's real capture with badges drawn on it, the driver the selector, the page's window nothing", async () => {
    const r = await locateRun({ description: "a red rectangle", strategy: "marks" }, (p) => (p.startsWith("The screenshot has numbered badges") ? "1" : "NONE"));
    try {
        expect(r.subs.length, "one reader call, the worker's").toBe(1);
        expect(promptOf(r.subs[0])).toBe('The screenshot has numbered badges (#1–#2) drawn over candidate elements. Which single badge number best matches this element: "a red rectangle"? Reply with ONLY the number, or "NONE" if none match.');
        const [badged] = imagesIn(r.subs[0]);
        // Inside each button, away from its badge (top-left) and outline (edges): the page's own colours; a white margin
        // between them.
        const px = await colours(r.page, badged, [[150, 110], [500, 370], [700, 50]]);
        // A debugger capture in this harness can be shorter than the viewport (its infobar): the width is the viewport's.
        expect(px.w, "the whole viewport's width, from a real capture").toBe(800);
        expect(px.h).toBeGreaterThanOrEqual(400);
        expect(px.h).toBeLessThanOrEqual(600);
        expect(px.at, JSON.stringify(px)).toEqual([[255, 0, 0], [0, 0, 255], [255, 255, 255]]);
        // The page is white, red and blue only: anything else is the worker's badges and outlines.
        const drawn = await r.page.evaluate(async (src) => {
            const img = new Image();
            await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
            const c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
                const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
                if (k !== "255,255,255" && k !== "255,0,0" && k !== "0,0,255") n++;
            }
            return n;
        }, badged);
        expect(drawn, "badges drawn over the capture").toBeGreaterThan(100);
        const text = JSON.stringify(r.turn2.messages);
        expect(text).toContain('Matched \\"a red rectangle\\" → #1 [button] \\"Red\\" → #a');
        await expectNoVisionOnPage(r.page, ["a red rectangle", "numbered badges", "fake-model"]);
    } finally { await r.close(); }
});

// --- grounding: the worker's letterbox, the page's snap, the worker's crop ---

test("a worker-built locate by grounding: the grounding model gets the worker's letterboxed square, the page snaps its box to #a, and verify:true hands the driver #a's crop", async () => {
    // #a is (50,40) 200×100 in an 800×600 viewport: in the 1000 square (scale 1.25, top-left) it is (62,50)–(312,175).
    const r = await locateRun({ description: "a red rectangle", strategy: "grounding", verify: true },
        (p) => (p.startsWith("Locate") ? "70,60,300,165" : "NONE"), { groundingEnabled: true, groundingModel: "fake-model" });
    try {
        expect(r.subs.length, "one grounding call; the driver sees, so the crop goes to it inline").toBe(1);
        expect(promptOf(r.subs[0])).toMatch(/^Locate "a red rectangle" in this image\. Reply with ONLY its bounding box/);
        const square = await colours(r.page, imagesIn(r.subs[0])[0], [[187, 112], [625, 437], [900, 100], [500, 990]]);
        expect([square.w, square.h]).toEqual([1000, 1000]);
        expect(square.at[0], "#a's centre, scaled into the square").toEqual([255, 0, 0]);
        expect(square.at[1], "#b's centre (500,350), scaled").toEqual([0, 0, 255]);
        expect(square.at[2], "the page's white right of the buttons").toEqual([255, 255, 255]);
        expect(square.at[3], "the letterbox's padding below the viewport, not the page").not.toEqual([255, 255, 255]);
        const text = JSON.stringify(r.turn2.messages);
        expect(text).toContain('Grounded \\"a red rectangle\\" → [button] \\"Red\\" → #a');
        const shots = text.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [];
        expect(shots.length, "the element's crop, inline in the driver's next turn").toBe(1);
        const crop = await colours(r.page, shots[0], [[100, 50]]);
        expect([crop.w, crop.h], "#a's 200×100 box").toEqual([200, 100]);
        expect(crop.at[0]).toEqual([255, 0, 0]);
        await expectNoVisionOnPage(r.page, ["a red rectangle", "bounding box", "fake-model"]);
    } finally { await r.close(); }
});
