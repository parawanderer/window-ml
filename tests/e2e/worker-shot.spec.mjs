// worker-shot.spec.mjs — the worker's screenshot of a run's tab with the extension's own UI masked out
// (src/sw/worker-vision.ts `workerShot`, src/sw/shot-mask.ts, src/sidebar/shell-shot.ts `extensionRects`), in a real
// browser: that the shell's rects cover the real sidebar's pixels is only real in pixels. Driven through the test-only
// `__mlWorkerVisionForTest` (background.ts), since no tool takes its shots this way yet. The oracle is the capture: the
// page is one flat green and the mask one flat grey (MASK_FILL), so any other pixel is the extension's UI.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension } from "./harness.mjs";

/** A page that is one flat green, on a local http server (content scripts run on http, not on about:blank). */
async function greenSite() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>green</title><style>html,body{margin:0;height:100%;background:#00ff00}</style><body></body>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

/** How many pixels of a capture are neither the page's green nor the mask's grey, decoded in `page`. */
const offGreen = (page, dataUrl) => page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
        const green = d[i] < 8 && d[i + 1] > 247 && d[i + 2] < 8, grey = d[i] === 128 && d[i + 1] === 128 && d[i + 2] === 128;
        if (!green && !grey) n++;
    }
    return n;
}, dataUrl);

/** How many pixels of a capture are the page's green: what the mask left of the page. */
const greenPx = (page, dataUrl) => page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 8 && d[i + 1] > 247 && d[i + 2] < 8) n++;
    return { green: n, total: d.length / 4 };
}, dataUrl);

// --- the worker's shot masks the extension's UI and changes nothing on the page ---

test("the worker's shot has no sidebar pixels and most of the page, the page sees no mutation while it is taken, and a page posting show changes nothing", async () => {
    const site = await greenSite();
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { debugMode: "overlay", cdp: false });
        const page = await ext.context.newPage();
        await page.goto(site.url);
        await page.waitForSelector("#ml-sb-root", { state: "attached", timeout: 15000 });
        await page.bringToFront();
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, site.url);
        const shoot = () => ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.workerShot(id), tabId);

        // Control: a capture with no mask has the sidebar in it.
        const bare = await ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.captureRunTab(id), tabId);
        expect(await offGreen(page, bare.dataUrl), "the sidebar shows in a capture that does not mask it").toBeGreaterThan(50);

        // The page watches everything it can: its document and the shell's open shadow root, every attribute and node.
        await page.evaluate(() => {
            window.__mutations = 0;
            const mo = new MutationObserver((l) => { window.__mutations += l.length; });
            const all = { attributes: true, childList: true, subtree: true, characterData: true };
            mo.observe(document.documentElement, all);
            mo.observe(document.getElementById("ml-sb-root").shadowRoot, all);
        });
        const shot = await shoot();
        expect(shot.w).toBeGreaterThan(0);
        expect(await offGreen(page, shot.dataUrl), "the sidebar is in the worker's shot").toBe(0);
        const left = await greenPx(page, shot.dataUrl);
        expect(left.green / left.total, "the mask blanked the page, not just the sidebar").toBeGreaterThan(0.5);
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => window.__mutations), "the page saw the shot as a DOM change").toBe(0);

        // A page posting the page handshake's "show" on every frame has nothing to undo.
        await page.evaluate(() => { const tick = () => { window.postMessage({ __mlSidebarShot: "show" }, "*"); requestAnimationFrame(tick); }; tick(); });
        expect(await offGreen(page, (await shoot()).dataUrl), "the page's show put the sidebar into the worker's shot").toBe(0);
    } finally {
        await ext.close();
        await site.close();
    }
});
