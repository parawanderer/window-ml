// vision-capture.spec.mjs — the pixels a vision tool of a run the WORKER built hands the model, in a real browser. Since
// site-access part 3 PR 6 a worker-built run's `look` runs in the worker (src/sw/worker-look.ts): the worker captures the
// run's tab, crops or stitches with its own raster (OffscreenCanvas), and asks the page for geometry only.
//
// tests/vision-characterize.test.mjs pins the message flow and the crop RECTS in node:vm, where the canvas is a recorder.
// What it cannot show is the real thing: a real capture (CDP, on by default) cropped and stitched by a real canvas. Here
// the page is an unapproved http origin, the run is started the way the Commander starts one, and the driver (a fake model
// declared vision-capable) asks `look` for one solid-colour element away from the origin, or for the whole page. The image
// the model receives must be that element's box, and that element's colour edge to edge: an offset or a scale error shows
// as white at a corner; a stitch must have each band where the page has it.
//
// At device scale 1 only: under Playwright's EMULATED device scale the capture's size and the page's reported ratio
// disagree, which the worker resolves in the capture's favour (worker-vision-host.ts `scaleFor`) and logs.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BANDS = `<!doctype html><html><head><title>Bands</title><style>
html,body{margin:0} div{height:600px} #a{background:rgb(255,0,0)} #b{background:rgb(0,255,0)} #c{background:rgb(0,0,255)}
</style></head><body><div id="a"></div><div id="b"></div><div id="c"></div></body></html>`;

const PAGE = `<!doctype html><html><head><title>Vision</title><style>
html,body{margin:0;background:#fff} #box{position:absolute;left:50px;top:40px;width:200px;height:100px;background:rgb(255,0,0)}
</style></head><body><div id="box"></div></body></html>`;

/** Serve `html` (PAGE by default) on 127.0.0.1, an origin nobody approves. */
async function servePage(html = PAGE) {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(html); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** Record every message posted on the page's window: what any script on the page can read. */
const recordWindow = (page) => page.evaluate(() => {
    window.__posted = [];
    window.addEventListener("message", (e) => { try { window.__posted.push(JSON.stringify(e.data)); } catch { window.__posted.push("?"); } });
});

/** The page's window carried no capture, no model call, no config or capability read and no image fetch, and no image. */
async function expectNoVisionOnPage(page) {
    const posted = await page.evaluate(() => window.__posted);
    expect(posted.length, "the page answered geometry, so its window carried messages").toBeGreaterThan(0);
    const types = posted.map((m) => { try { return JSON.parse(m)?.type; } catch { return "?"; } });
    expect(types.filter((t) => /CAPTURE_TAB|LLM_REQUEST|LLM_RESPONSE|B64_REQUEST|CONFIG|CAPS/.test(String(t))), "a vision message crossed the page's window").toEqual([]);
    expect(posted.filter((m) => m.includes("data:image")), "an image crossed the page's window").toEqual([]);
}

/** Decode `src` in `page` and read the colour at each [x, y]. */
const colours = (page, src, points) => page.evaluate(async ({ src, points }) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, at: points.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))) };
}, { src, points });

// --- a native look of an element ---

test("a native look of an element hands the model exactly the element's box, cropped from a real capture", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await servePage();
    const ext = await launchExtension();
    try {
        // The fake answers no capability probe, so the person's declaration makes the default model see: native look.
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", defaultModelVision: "yes", debugMode: "off" });
        fake.setScript([{ tool: "look", args: { selector: "#box" } }, { content: "done" }]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 800, height: 600 });
        await page.goto(site.url);
        await waitForMl(page, { approve: false });
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
        await recordWindow(page);
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "look at the box", hud: "quiet", surface: "hud" }), tabId);
        for (let i = 0; i < 150 && fake.calls().length < 2; i++) await sleep(100);
        expect(fake.calls().length, "the driver was asked again after its look").toBeGreaterThanOrEqual(2);

        const turn2 = JSON.stringify(fake.calls()[1].messages);
        expect(turn2).toContain('Screenshot of the element \\"#box\\" captured');
        const shots = turn2.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [];
        expect(shots.length, "one image, inline in the driver's next turn").toBe(1);

        // Decode it in a page: its size, and the colour at its corners and centre.
        const px = await page.evaluate(async (src) => {
            const img = new Image();
            await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
            const c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
            const W = c.width - 1, H = c.height - 1;
            return { w: c.width, h: c.height, corners: [at(0, 0), at(W, 0), at(0, H), at(W, H)], centre: at(W >> 1, H >> 1) };
        }, shots[0]);
        expect([px.w, px.h], "the element's 200×100 box").toEqual([200, 100]);
        for (const p of [...px.corners, px.centre]) expect(p, JSON.stringify(px)).toEqual([255, 0, 0]);
        await expectNoVisionOnPage(page);
    } finally {
        await ext.close();
        fake.stop?.();
        await site.close();
    }
});

// --- a native look of the whole page, stitched in the worker ---

test("a full-page look stitches real captures in the worker: each band where the page has it, and the page's window sees no capture", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await servePage(BANDS);
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", defaultModelVision: "yes", debugMode: "off" });
        fake.setScript([{ tool: "look", args: { scope: "page" } }, { content: "done" }]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 800, height: 600 });
        await page.goto(site.url);
        await waitForMl(page, { approve: false });
        await recordWindow(page);
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "look at the whole page", hud: "quiet", surface: "hud" }), tabId);
        for (let i = 0; i < 300 && fake.calls().length < 2; i++) await sleep(100);
        expect(fake.calls().length, "the driver was asked again after its look").toBeGreaterThanOrEqual(2);
        const turn2 = JSON.stringify(fake.calls()[1].messages);
        expect(turn2).toContain("Screenshot of the full page captured");
        const shots = turn2.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [];
        expect(shots.length).toBe(1);
        // Near the top of each tile: a debugger capture in this harness is shorter than the viewport (457 of 600 px), which
        // leaves the bottom of each tile out of the stitch, so the bands are read where every tile has pixels.
        const px = await colours(page, shots[0], [[400, 10], [400, 300], [400, 610], [400, 900], [400, 1210], [400, 1500]]);
        expect([px.w, px.h], "the page's 800×1800, at scale 1").toEqual([800, 1800]);
        expect(px.at, JSON.stringify(px)).toEqual([[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 255, 0], [0, 0, 255], [0, 0, 255]]);
        expect(await page.evaluate(() => window.scrollY), "the page's scroll is restored").toBe(0);
        await expectNoVisionOnPage(page);
    } finally {
        await ext.close();
        fake.stop?.();
        await site.close();
    }
});
