// redteam-worker-shot.spec.mjs — the red-team pass on the worker's own screenshot of a run's tab (src/sw/worker-vision.ts
// `workerShot`, src/sw/shot-mask.ts, src/sidebar/shell-shot.ts), in a real browser: what a hostile page sharing the tab
// can do to keep the extension's sidebar in the capture or learn when it is taken. Only real pixels and real frames
// show it. The worker no longer hides anything: it masks the rects the shell reports, so the attacks on the hide
// (restyling it, starving its acknowledgement, watching it) are held here against the mask.
//
// The page is one flat green and the mask one flat grey, so any other pixel in a capture is the sidebar (the oracle of
// worker-shot.spec.mjs), and every test first shows that oracle sees the sidebar when it is there. Driven through `__mlWorkerVisionForTest`
// (background.ts), since no tool takes its shots this way yet.

import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension } from "./harness.mjs";

/** A page that is one flat green, on a local http server. */
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

/** The extension on the green page with the sidebar mounted, and the worker's shot and bare capture of its tab. */
async function setup({ cdp = false } = {}) {
    const site = await greenSite();
    const ext = await launchExtension();
    await configureExtension(ext.sw, { debugMode: "overlay", cdp });
    const page = await ext.context.newPage();
    await page.goto(site.url);
    await page.waitForSelector("#ml-sb-root", { state: "attached", timeout: 15000 });
    await page.bringToFront();
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, site.url);
    const shot = () => ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.workerShot(id), tabId);
    const bare = () => ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.captureRunTab(id), tabId);
    // Control: the oracle sees the sidebar when nothing hides it, and the honest worker shot has none of it.
    expect(await offGreen(page, (await bare()).dataUrl), "the sidebar shows in a capture that does not hide it").toBeGreaterThan(50);
    expect(await offGreen(page, (await shot()).dataUrl), "the honest worker shot has the sidebar in it").toBe(0);
    return { page, shot, bare, close: async () => { await ext.close(); await site.close(); } };
}

/** How long the page blocks its main thread. */
const STARVE_MS = Number(process.env.STARVE_MS || 3000);

/**
 * The page blocks its main thread for `ms`, starting a moment from now. The page no longer sees a shot start (nothing
 * on it changes), so the worst it can do is block at a time of its choosing: here, just as the worker starts.
 */
const blockSoon = (page, ms) => page.evaluate((ms) => {
    setTimeout(() => { const end = performance.now() + ms; while (performance.now() < end) { /* hold the frame */ } }, 30);
}, ms);

// --- the oracle of worker-shot.spec.mjs is not vacuous ---

test("the page's own window handshake still reaches the shell for a page-built run's shot, from the page's own window only", async () => {
    const { page, close } = await setup();
    try {
        const vis = () => page.evaluate(() => document.getElementById("ml-sb-root").style.visibility);
        const shown = await vis();
        await page.evaluate(() => window.postMessage({ __mlSidebarShot: "hide" }, "*"));
        await expect.poll(vis).toBe("hidden");
        await page.evaluate(() => window.postMessage({ __mlSidebarShot: "show" }, "*"));
        await expect.poll(vis).toBe(shown);
        // A subframe's post is not injected.js's: it hides nothing.
        await page.evaluate(() => new Promise((r) => {
            const f = document.createElement("iframe");
            f.srcdoc = "<script>parent.postMessage({ __mlSidebarShot: 'hide' }, '*')<\/script>";
            f.onload = () => setTimeout(r, 200);
            document.body.append(f);
        }));
        expect(await vis(), "a subframe's hide hid the sidebar").toBe(shown);
    } finally { await close(); }
});

// --- (b) the sidebar in the worker's capture ---

test("a page's own CSS cannot put the sidebar back into the worker's shot", async () => {
    const { page, shot, close } = await setup();
    try {
        // A stylesheet rule that would beat an inline hide on the host (what the hide this replaced was).
        await page.evaluate(() => { const s = document.createElement("style"); s.textContent = "#ml-sb-root{visibility:visible!important}"; document.head.append(s); });
        const viaSheet = await offGreen(page, (await shot()).dataUrl);
        // And without touching the host: a node inside the OPEN shadow root set visible overrides an inherited hidden.
        await page.evaluate(() => { document.head.lastElementChild.remove(); document.getElementById("ml-sb-root").shadowRoot.querySelector("#ml-sb-host").style.setProperty("visibility", "visible", "important"); });
        const viaShadow = await offGreen(page, (await shot()).dataUrl);
        // And moved and scaled with a transform: the shell reads rects with getBoundingClientRect, which includes it.
        await page.evaluate(() => { document.getElementById("ml-sb-root").shadowRoot.querySelector("#ml-sb-host").style.transform = "translateX(-200px) scale(1.15)"; });
        const viaTransform = await offGreen(page, (await shot()).dataUrl);
        expect(viaSheet, "the sidebar is in the worker's shot through a page stylesheet").toBe(0);
        expect(viaTransform, "the sidebar is in the worker's shot through a transform").toBe(0);
        expect(viaShadow, "the sidebar is in the worker's shot through a style in its shadow root").toBe(0);
    } finally { await close(); }
});

test("a page that blocks its main thread as the shot starts does not get the sidebar into a shot taken without the debugger", async () => {
    const { page, shot, close } = await setup({ cdp: false });
    try {
        await blockSoon(page, STARVE_MS);
        const got = await shot().then((s) => offGreen(page, s.dataUrl), (e) => `refused: ${e.message}`);
        expect(typeof got === "string" || got === 0, `the sidebar is in the worker's shot: ${got} pixels`).toBe(true);
        if (typeof got === "string") expect(got).toMatch(/too busy/);
    } finally { await close(); }
});

test("with the debugger on, the same blocked main thread still gets no sidebar into the shot", async () => {
    const { page, shot, close } = await setup({ cdp: true });
    try {
        await blockSoon(page, STARVE_MS);
        const got = await shot().then((s) => offGreen(page, s.dataUrl), (e) => `refused: ${e.message}`);
        expect(typeof got === "string" || got === 0, `the sidebar is in the debugger's shot: ${got} pixels`).toBe(true);
    } finally { await close(); }
});

test("with the debugger on, a page that blocks past the debugger's 5 s bound does not get the sidebar in through the own-tab fallback", async () => {
    test.setTimeout(90_000);
    const { page, shot, close } = await setup({ cdp: true });
    try {
        await blockSoon(page, 8000);
        const got = await shot().then((s) => offGreen(page, s.dataUrl), (e) => `refused: ${e.message}`);
        // The shell cannot answer while the page blocks, so the shot is refused at the rect query's bound, before any capture.
        expect(typeof got === "string" || got === 0, `the sidebar is in the fallback's shot: ${got} pixels`).toBe(true);
    } finally { await close(); }
});

// --- what the page learns about the worker's shot ---

test("the page does not learn when the worker takes a screenshot of it: nothing the extension owns changes on the page", async () => {
    const { page, shot, close } = await setup();
    try {
        await page.evaluate(() => {
            window.__seen = [];
            const mo = new MutationObserver((l) => { for (const m of l) window.__seen.push(`${m.type}:${m.attributeName ?? ""}`); });
            const all = { attributes: true, childList: true, subtree: true, characterData: true };
            mo.observe(document.documentElement, all);
            mo.observe(document.getElementById("ml-sb-root").shadowRoot, all);
        });
        await shot();
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => window.__seen)).toEqual([]);
    } finally { await close(); }
});
