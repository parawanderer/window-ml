// raster.spec.mjs — the worker's raster (src/raster.ts) against the page's, in a real browser: the same PNG data URL
// cropped to the same rect by `cropDataUrl` with `workerRaster` in the BUILT extension's service worker (OffscreenCanvas,
// createImageBitmap, convertToBlob) and with `pageRaster` in a page (Image, a <canvas>, toDataURL) must decode to the
// same pixels. The PNG bytes may differ (two encoders); the RGBA may not. tests/raster.test.mjs pins the calls with a fake.
//
// The worker side goes through the test-only `__mlWorkerCropForTest` (background.ts), since nothing in the extension
// crops in the worker yet. The page side is `cropDataUrl` bundled from the checked-out source with esbuild, the way the
// bench builds its page: no page script of the extension exposes it.
import { test, expect } from "@playwright/test";
import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** `cropDataUrl` (page raster by default) as a script that sets `window.__pageCrop`. */
function pageCropScript() {
    const out = buildSync({
        stdin: { contents: 'import { cropDataUrl } from "./src/util.ts"; window.__pageCrop = cropDataUrl;', resolveDir: ROOT, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser", logLevel: "silent",
    });
    return out.outputFiles[0].text;
}

// --- the same crop in the worker and in a page ---

test("a crop with the worker's raster decodes to the same RGBA as the page's, at dpr 1 and 2 and at a clamped edge", async () => {
    const ext = await launchExtension();
    try {
        const page = await ext.context.newPage();
        await page.setContent("<!doctype html><title>raster</title><body></body>");
        await page.addScriptTag({ content: pageCropScript() });

        // A 240×160 source with hard edges, a gradient and translucent pixels, so an offset, a scale or a premultiply
        // difference changes the bytes.
        const source = await page.evaluate(() => {
            const c = document.createElement("canvas");
            c.width = 240; c.height = 160;
            const g = c.getContext("2d");
            const grad = g.createLinearGradient(0, 0, 240, 160);
            grad.addColorStop(0, "rgb(255,0,0)"); grad.addColorStop(0.5, "rgb(0,200,80)"); grad.addColorStop(1, "rgb(20,40,255)");
            g.fillStyle = grad; g.fillRect(0, 0, 240, 160);
            g.fillStyle = "rgba(255,255,0,0.5)"; g.fillRect(30, 20, 50, 70);
            for (let x = 0; x < 240; x += 7) { g.fillStyle = x % 2 ? "#000" : "#fff"; g.fillRect(x, 120, 3, 3); }
            return c.toDataURL("image/png");
        });

        /** Decode a data URL in the page: its size and every RGBA byte. */
        const pixels = (url) => page.evaluate(async (src) => {
            const img = new Image();
            await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
            const c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            return { w: c.width, h: c.height, rgba: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
        }, url);

        const cases = [
            { rect: { left: 25, top: 15, width: 60, height: 80 }, dpr: 1, size: [60, 80] },
            { rect: { left: 10, top: 5, width: 40, height: 30 }, dpr: 2, size: [80, 60] },
            { rect: { left: 200, top: 130, width: 100, height: 100 }, dpr: 1, size: [40, 30] },   // clamped at the corner
        ];
        for (const { rect, dpr, size } of cases) {
            const fromWorker = await ext.sw.evaluate(([u, r, d]) => globalThis.__mlWorkerCropForTest(u, r, d), [source, rect, dpr]);
            const fromPage = await page.evaluate(([u, r, d]) => window.__pageCrop(u, r, d), [source, rect, dpr]);
            expect(fromWorker).toMatch(/^data:image\/png;base64,/);
            const w = await pixels(fromWorker), p = await pixels(fromPage);
            expect([w.w, w.h], JSON.stringify({ rect, dpr })).toEqual(size);
            expect([p.w, p.h]).toEqual(size);
            const diff = w.rgba.findIndex((v, i) => v !== p.rgba[i]);
            expect(diff, `first differing byte for ${JSON.stringify({ rect, dpr })}`).toBe(-1);
        }
    } finally {
        await ext.close();
    }
});
