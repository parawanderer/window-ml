// worker-shot.spec.mjs — the worker's screenshot of a run's tab with the debug sidebar hidden through the extension's
// shell (src/sw/worker-vision.ts `workerShot`, src/sidebar/shell-shot.ts), in a real browser: the two frames the shell
// waits and the sidebar's absence are only real in pixels. Driven through the test-only `__mlWorkerVisionForTest`
// (background.ts), since no tool takes its shots this way yet. The oracle is the capture: the page is one flat colour,
// so any other pixel is the sidebar.
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

/** How many pixels of a capture are not the page's green, decoded in `page`. */
const offGreen = (page, dataUrl) => page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (!(d[i] < 8 && d[i + 1] > 247 && d[i + 2] < 8)) n++;
    return n;
}, dataUrl);

// --- the worker's shot hides the sidebar through the shell ---

test("the worker's shot has no sidebar in it, even with a page script posting show every frame, and the sidebar is back after", async () => {
    const site = await greenSite();
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { debugMode: "overlay", cdp: false });
        const page = await ext.context.newPage();
        await page.goto(site.url);
        await page.waitForSelector("#ml-sb-root", { state: "attached", timeout: 15000 });
        await page.bringToFront();
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, site.url);
        const visibility = () => page.evaluate(() => document.getElementById("ml-sb-root").style.visibility);

        // Control: a capture with no hide has the sidebar in it.
        const shown = await visibility();
        const bareShot = () => ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.captureRunTab(id), tabId);
        expect(await offGreen(page, (await bareShot()).dataUrl), "the sidebar shows in a capture that does not hide it").toBeGreaterThan(50);

        const shot = await ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.workerShot(id), tabId);
        expect(shot.w).toBeGreaterThan(0);
        expect(await offGreen(page, shot.dataUrl), "the sidebar is in the worker's shot").toBe(0);
        await expect.poll(visibility).toBe(shown);
        expect(await offGreen(page, (await bareShot()).dataUrl), "the sidebar is back after the shot").toBeGreaterThan(50);

        // A hostile page posting the page handshake's "show" on every frame does not bring the sidebar into the shot.
        await page.evaluate(() => { const tick = () => { window.postMessage({ __mlSidebarShot: "show" }, "*"); requestAnimationFrame(tick); }; tick(); });
        const raced = await ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.workerShot(id), tabId);
        expect(await offGreen(page, raced.dataUrl), "the page's show put the sidebar back into the worker's shot").toBe(0);
        await expect.poll(visibility).toBe(shown);
    } finally {
        await ext.close();
        await site.close();
    }
});
