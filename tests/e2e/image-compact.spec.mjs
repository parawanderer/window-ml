// image-compact.spec.mjs — the WebP encoder that shrinks saved screenshots, in the BUILT extension: the offscreen
// document's relay (IMAGE_COMPACT), the dedicated image worker, libwebp's wasm found beside a classic bundle, and the
// pixel check. None of that exists in node, where the walk, the store's rewrite and the pass are tested
// (tests/image-compaction.test.mjs) against a fake encoder.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

/** Ask the offscreen image worker for one image, from the service worker, as sw-image-compact.ts does. */
async function compact(ext, url) {
    return ext.sw.evaluate(async (url) => {
        if (!(await chrome.offscreen.hasDocument())) {
            await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "image compaction e2e" }).catch(() => { /* already there */ });
        }
        for (let i = 0; ; i++) {
            try { return await chrome.runtime.sendMessage({ type: "IMAGE_COMPACT", url }); }
            catch (e) { if (i >= 50 || !/Receiving end does not exist/.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, 100)); }
        }
    }, url);
}

// --- the encoder in a real browser ---

test("a screenshot-like PNG comes back as a smaller WebP with every pixel the same; a translucent one stays PNG", async () => {
    const ext = await launchExtension();
    try {
        // Drawn in the service worker: text, hard edges and a gradient, opaque like a capture; and a translucent one.
        const [shot, translucent] = await ext.sw.evaluate(async () => {
            const draw = async (alpha) => {
                const c = new OffscreenCanvas(480, 300), g = c.getContext("2d");
                const grad = g.createLinearGradient(0, 0, 480, 300);
                grad.addColorStop(0, "#f4f6fb"); grad.addColorStop(1, "#c9d4ea");
                g.fillStyle = grad; g.fillRect(0, 0, 480, 300);
                g.fillStyle = "#1d2433"; g.font = "14px sans-serif";
                for (let y = 30; y < 300; y += 22) g.fillText(`Row ${y}: €4.20 per kilo, brass lamp, 40 euros`, 12, y);
                g.fillStyle = "#3b6ef5"; g.fillRect(360, 20, 100, 32);
                if (alpha) { g.clearRect(0, 0, 40, 40); g.fillStyle = "rgba(200, 0, 0, 0.5)"; g.fillRect(0, 0, 40, 40); }
                const b = await c.convertToBlob({ type: "image/png" });
                const bytes = new Uint8Array(await b.arrayBuffer());
                let bin = ""; for (const x of bytes) bin += String.fromCharCode(x);
                return `data:image/png;base64,${btoa(bin)}`;
            };
            return [await draw(false), await draw(true)];
        });

        const r = await compact(ext, shot);
        expect(r.error, r.error).toBeUndefined();
        expect(r.url).toMatch(/^data:image\/webp;base64,/);
        expect(r.url.length).toBeLessThan(shot.length);

        // Decoded in the worker again, independently of the image worker's own check.
        const same = await ext.sw.evaluate(async ([a, b]) => {
            const px = async (url) => {
                const bm = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
                const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext("2d");
                g.drawImage(bm, 0, 0);
                return g.getImageData(0, 0, c.width, c.height).data;
            };
            const [x, y] = [await px(a), await px(b)];
            return x.length === y.length && x.every((v, i) => v === y[i]);
        }, [shot, r.url]);
        expect(same).toBe(true);

        expect((await compact(ext, translucent)).url).toBeNull();
    } finally {
        await ext.close();
    }
});

test("the relay answers only about PNG data URLs: anything else is never fetched", async () => {
    const ext = await launchExtension();
    try {
        // A PNG is answered (here: kept, since a 1x1 WebP is no smaller), so the silence below is the guard, not a
        // missing listener.
        expect(await compact(ext, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")).toHaveProperty("url");
        for (const url of ["https://example.com/a.png", "data:image/jpeg;base64,/9j/AAAA", "data:text/html,<p>x</p>"]) {
            // No listener takes it, so the message resolves with nothing.
            expect(await compact(ext, url)).toBeUndefined();
        }
    } finally {
        await ext.close();
    }
});

// --- the whole chain: a saved session, the quiet timer, the worker, the store's rewrite ---

/** Every stored event of every saved session, and every row, read straight from the store's IndexedDB. */
async function savedStore(ext) {
    return ext.sw.evaluate(() => new Promise((resolve, reject) => {
        const req = indexedDB.open("ml-saved-sessions");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            const tx = req.result.transaction(["sessions", "events"], "readonly");
            const rows = tx.objectStore("sessions").getAll(), events = tx.objectStore("events").getAll();
            tx.oncomplete = () => { resolve({ rows: rows.result, events: events.result }); req.result.close(); };
        };
    }));
}

test("a saved chat's screenshot is stored as PNG, then rewritten as WebP once the store goes quiet; its history stays PNG", async () => {
    test.setTimeout(90_000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "a page of text" }]);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        // Let the pass a starting worker schedules go by with nothing to do, so the one below is the pass a WRITE
        // scheduled: otherwise this test passes with the store's write hook disconnected.
        await page.waitForTimeout(17_000);
        const shot = await page.evaluate(async () => {
            const c = document.createElement("canvas");
            c.width = 480; c.height = 300;
            const g = c.getContext("2d");
            g.fillStyle = "#f4f6fb"; g.fillRect(0, 0, 480, 300);
            g.fillStyle = "#1d2433"; g.font = "14px sans-serif";
            for (let y = 30; y < 300; y += 22) g.fillText(`Row ${y}: €4.20 per kilo, brass lamp`, 12, y);
            const url = c.toDataURL("image/png");
            await window.ml.chat("what is on this?", { images: [url], save: true });
            return url;
        });
        const holding = (s, prefix) => s.events.some((e) => JSON.stringify(e).includes(prefix));
        await expect.poll(async () => holding(await savedStore(ext), shot.slice(0, 200)), { timeout: 10_000 }).toBe(true);

        // COMPACT_QUIET_MS after the last write, the event holds a WebP instead.
        await expect.poll(async () => { const s = await savedStore(ext); return holding(s, "data:image/webp;base64,") && !holding(s, shot.slice(0, 200)); }, { timeout: 60_000, intervals: [2000] }).toBe(true);
        const { rows } = await savedStore(ext);
        const row = rows.find((r) => r.compacted);
        expect(row, JSON.stringify(rows.map((r) => ({ hash: r.hash, count: r.count, compacted: r.compacted })))).toBeTruthy();
        expect(row.compacted).toBe(row.count);
        // What a resume would send the model is untouched.
        if (row.history) expect(JSON.stringify(row.history)).not.toContain("data:image/webp");
        // And the pass is in the housekeeping log, start to finish.
        const log = await ext.sw.evaluate(async () => (await chrome.storage.session.get("ml_hk_log")).ml_hk_log ?? []);
        const mine = log.filter((e) => e.subsystem === "sessions" && e.kind.startsWith("compact"));
        expect(mine.map((e) => e.kind)).toEqual(["compact-pass", "compact-images", "compact-pass-done"]);
        expect(mine[1]).toMatchObject({ key: row.hash, detail: { found: 1, compacted: 1, from: 0 } });
        expect(mine[2].bytes).toBeGreaterThan(0);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("a browser closed before the pass ran: the next start finds the saved PNG and compacts it", async () => {
    test.setTimeout(120_000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-compact-"));
    try {
        let ext = await launchExtension({ userDataDir });
        let shot;
        try {
            await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
            fake.setScript([{ content: "a page of text" }]);
            const page = await ext.context.newPage();
            await page.goto(site.url + "/");
            await waitForMl(page);
            shot = await page.evaluate(async () => {
                const c = document.createElement("canvas");
                c.width = 480; c.height = 300;
                const g = c.getContext("2d");
                g.fillStyle = "#fbf6f4"; g.fillRect(0, 0, 480, 300);
                g.fillStyle = "#33241d"; g.font = "14px sans-serif";
                for (let y = 30; y < 300; y += 22) g.fillText(`Line ${y}: a receipt, 12 items, total 40 euros`, 12, y);
                const url = c.toDataURL("image/png");
                await window.ml.chat("what is on this?", { images: [url], save: true });
                return url;
            });
            await expect.poll(async () => JSON.stringify((await savedStore(ext)).events).includes(shot.slice(0, 200)), { timeout: 10_000 }).toBe(true);
        } finally { await ext.close(); }   // well inside the quiet period: no pass has run

        ext = await launchExtension({ userDataDir });
        try {
            const { rows } = await savedStore(ext);
            expect(rows.every((r) => !r.compacted), "nothing was compacted before the browser closed").toBe(true);
            await expect.poll(async () => { const s = JSON.stringify((await savedStore(ext)).events); return s.includes("data:image/webp;base64,") && !s.includes(shot.slice(0, 200)); }, { timeout: 60_000, intervals: [2000] }).toBe(true);
        } finally { await ext.close(); }
    } finally { await fake.stop(); await site.stop(); fs.rmSync(userDataDir, { recursive: true, force: true }); }
});
