// vision-capture.spec.mjs — the pixels a vision tool of a run the WORKER built hands the model, in a real browser, pinned
// ahead of moving the capture and its crop from the page into the worker (site-access part 3, docs/dev/site-access.md).
//
// tests/vision-characterize.test.mjs pins the message flow and the crop RECTS in node:vm, where the canvas is a recorder.
// What it cannot show is the real thing: a real capture (CDP, on by default) cropped by a real canvas. Here the page is an
// unapproved http origin, the run is started the way the Commander starts one, and the driver (a fake model declared
// vision-capable) asks `look` for one solid-colour element away from the origin. The image the model receives must be that
// element's box, and that element's colour edge to edge: an offset or a scale error shows as white at a corner.
//
// At device scale 1 only. Under Playwright's EMULATED device scale (deviceScaleFactor: 2) the capture comes back at 1x
// (800×600 for an 800×600 viewport) while the page reports devicePixelRatio 2, and the page crops with the page's ratio,
// so the crop is the right size from the wrong place. That is the emulation, not a display, but it is the one place this
// shows that the crop is computed from window.devicePixelRatio and never from the capture's own size.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><title>Vision</title><style>
html,body{margin:0;background:#fff} #box{position:absolute;left:50px;top:40px;width:200px;height:100px;background:rgb(255,0,0)}
</style></head><body><div id="box"></div></body></html>`;

/** Serve PAGE on 127.0.0.1, an origin nobody approves. */
async function servePage() {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(PAGE); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

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
    } finally {
        await ext.close();
        fake.stop?.();
        await site.close();
    }
});
