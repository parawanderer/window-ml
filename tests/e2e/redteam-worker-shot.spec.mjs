// redteam-worker-shot.spec.mjs — the red-team pass on the worker's own screenshot of a run's tab (src/sw/worker-vision.ts
// `workerShot`, src/sidebar/shell-shot.ts), in a real browser: what a hostile page sharing the tab can do to the hide
// that keeps the extension's sidebar out of the capture. Only real pixels and real frames show it.
//
// The page is one flat green, so any other pixel in a capture is the sidebar (the oracle of worker-shot.spec.mjs), and
// every test first shows that oracle sees the sidebar when it is there. Driven through `__mlWorkerVisionForTest`
// (background.ts), since no tool takes its shots this way yet.
//
// Holes follow site-access.spec.mjs: while one is listed in `OPEN`, its test asserts the attack WORKS (proving the
// attack and the oracle both); the fix flips the entry and the same test then has to show it defended.

import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension } from "./harness.mjs";

/** The holes this pass found, open on the PR's commit. */
const OPEN = {
    // The hide is an inline `visibility: hidden` on page-owned DOM: a page stylesheet with !important (or a style on a
    // node inside the OPEN shadow root) wins, and the shell still acknowledges the hide.
    restyle: true,
    // The hide is a DOM mutation the page can observe, so the page knows when the worker shoots.
    timing: true,
    // Without the debugger, a page that blocks its main thread on the hide holds the shell's two-frame ack past the
    // worker's 200 ms wait, and captureVisibleTab gives back the last painted frame at once, sidebar included. (The
    // debugger's screenshot waits for a new frame instead, so the debugger path holds.)
    starve: true,
};

/** Whether `hole` is still open, recording it on the test so the report says which holes this run demonstrated. */
function holeOpen(hole, what) {
    if (OPEN[hole]) test.info().annotations.push({ type: "open hole", description: `${hole}: ${what}` });
    return OPEN[hole];
}

/** A page that is one flat green, on a local http server. */
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

/** How long the page blocks its main thread once it sees the hide. */
const STARVE_MS = Number(process.env.STARVE_MS || 3000);

/** The page blocks its main thread for `ms` as soon as it sees the shell set the host hidden (a style mutation). */
const blockOnHide = (page, ms) => page.evaluate((ms) => {
    new MutationObserver(() => {
        if (document.getElementById("ml-sb-root").style.visibility !== "hidden") return;
        const end = performance.now() + ms; while (performance.now() < end) { /* hold the frame */ }
    }).observe(document.getElementById("ml-sb-root"), { attributes: true, attributeFilter: ["style"] });
}, ms);

// --- the oracle of worker-shot.spec.mjs is not vacuous ---

test("the page's window handshake really reaches the shell (so 'a page posting show is ignored' tests something)", async () => {
    const { page, close } = await setup();
    try {
        const vis = () => page.evaluate(() => document.getElementById("ml-sb-root").style.visibility);
        const shown = await vis();
        await page.evaluate(() => window.postMessage({ __mlSidebarShot: "hide" }, "*"));
        await expect.poll(vis).toBe("hidden");
        await page.evaluate(() => window.postMessage({ __mlSidebarShot: "show" }, "*"));
        await expect.poll(vis).toBe(shown);
    } finally { await close(); }
});

// --- (b) the sidebar in the worker's capture ---

test("a page's own CSS cannot put the sidebar back into the worker's shot", async () => {
    const { page, shot, close } = await setup();
    try {
        // A stylesheet rule beats the shell's inline (non-important) visibility on the host.
        await page.evaluate(() => { const s = document.createElement("style"); s.textContent = "#ml-sb-root{visibility:visible!important}"; document.head.append(s); });
        const viaSheet = await offGreen(page, (await shot()).dataUrl);
        // And without touching the host: a node inside the OPEN shadow root set visible overrides an inherited hidden.
        await page.evaluate(() => { document.head.lastElementChild.remove(); document.getElementById("ml-sb-root").shadowRoot.querySelector("#ml-sb-host").style.setProperty("visibility", "visible", "important"); });
        const viaShadow = await offGreen(page, (await shot()).dataUrl);
        if (holeOpen("restyle", "a page stylesheet or a style inside the open shadow root shows the sidebar through the hide")) {
            expect(viaSheet, "the stylesheet attack did not show the sidebar").toBeGreaterThan(50);
            expect(viaShadow, "the shadow-root attack did not show the sidebar").toBeGreaterThan(50);
            return;
        }
        expect(viaSheet, "the sidebar is in the worker's shot through a page stylesheet").toBe(0);
        expect(viaShadow, "the sidebar is in the worker's shot through a style in its shadow root").toBe(0);
    } finally { await close(); }
});

test("a page that blocks its main thread on the hide does not get the sidebar into a shot taken without the debugger", async () => {
    const { page, shot, close } = await setup({ cdp: false });
    try {
        // The page sees the hide as a style mutation on the host and blocks for 600 ms before anything paints.
        await blockOnHide(page, STARVE_MS);
        const got = await shot().then((s) => offGreen(page, s.dataUrl), (e) => `refused: ${e.message}`);
        if (holeOpen("starve", "a blocked main thread holds the two-frame ack past 200 ms and captureVisibleTab shoots the last painted frame")) {
            expect(typeof got === "number" && got > 50, `the starve attack did not show the sidebar: ${got}`).toBe(true);
            return;
        }
        expect(typeof got === "string" || got === 0, `the sidebar is in the worker's shot: ${got} pixels`).toBe(true);
    } finally { await close(); }
});

test("with the debugger on, the same blocked main thread still gets no sidebar into the shot", async () => {
    const { page, shot, close } = await setup({ cdp: true });
    try {
        await blockOnHide(page, STARVE_MS);
        const got = await shot().then((s) => offGreen(page, s.dataUrl), (e) => `refused: ${e.message}`);
        expect(typeof got === "string" || got === 0, `the sidebar is in the debugger's shot: ${got} pixels`).toBe(true);
    } finally { await close(); }
});

test("with the debugger on, a page that blocks past the debugger's 5 s bound does not get the sidebar in through the own-tab fallback", async () => {
    test.setTimeout(90_000);
    const { page, shot, close } = await setup({ cdp: true });
    try {
        await blockOnHide(page, 8000);
        const got = await shot().then((s) => offGreen(page, s.dataUrl), (e) => `refused: ${e.message}`);
        // Measured: the fallback's captureVisibleTab, sent while the debugger's screenshot is still pending, waits for the
        // same new frame (the block's end) rather than giving back the last painted one. Incidental, so held by a test.
        expect(typeof got === "string" || got === 0, `the sidebar is in the fallback's shot: ${got} pixels`).toBe(true);
    } finally { await close(); }
});

// --- what the page learns about the worker's shot ---

test("the page does not learn when the worker takes a screenshot of it", async () => {
    const { page, shot, close } = await setup();
    try {
        await page.evaluate(() => {
            window.__seen = [];
            new MutationObserver(() => window.__seen.push(document.getElementById("ml-sb-root").style.visibility))
                .observe(document.getElementById("ml-sb-root"), { attributes: true, attributeFilter: ["style"] });
        });
        await shot();
        await page.waitForTimeout(100);
        const seen = await page.evaluate(() => window.__seen);
        if (holeOpen("timing", "the hide and the show are style mutations on a page-owned host: the page sees each shot start and end")) {
            expect(seen, "the page saw nothing of the shot").toContain("hidden");
            return;
        }
        expect(seen).toEqual([]);
    } finally { await close(); }
});
