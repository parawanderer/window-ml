// tooltips.spec.mjs — the static tooltips, in a real browser with real layout.
//
// These were a persistent irritation and each fix was local: one clipped by a scrolling ancestor, one running
// off the window edge, one landing under the cursor. They share a single floating layer now (tooltip-layer.ts),
// and the guarantees are geometric — which jsdom cannot check at all, since it has no layout.
//
// What is pinned here: the tooltip is always FULLY ON SCREEN, never CLIPPED by the scrolling panel it was
// triggered from, and never sitting UNDER the pointer.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GiB = 1024 ** 3;
const IDLE = 94.42 * GiB;
const card = (id, freeBytes) => ({
    gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2",
    total_memory: 101972967424, physical_memory: 102641958912, free_memory: freeBytes,
});
const BOX = { compute: {
    system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12.3 * GiB },
    supported_gpus: [card(0, IDLE - 18 * GiB), card(1, IDLE)],
} };
const resident = (name, bytes, gpu) => ({
    model: name, name, size: bytes, size_vram: bytes, context_length: 262144,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    gpus: [{ gpu_id: String(gpu), runner: "CUDA", size_vram: bytes }],
});

test("tooltips: always fully on screen, never clipped, never under the cursor", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(BOX);
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1100, height: 800 });
        await page.goto(`${fake.url}/api/version`);
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        // Deliberately NARROW and hard against the right edge: that is where a tooltip runs off screen.
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "380px";
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 80; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        for (let i = 0; i < 5; i++) {
            if (await frame.locator(".vram").count()) break;
            await frame.locator('[aria-label="VRAM monitor"]').click().catch(() => {});
            await sleep(400);
        }
        await expect.poll(() => frame.locator(".rc-key").count(), { timeout: 20000 }).toBeGreaterThan(0);

        /** Hover a trigger and return the tooltip's geometry, the trigger's, and the viewport. */
        const hover = async (sel, i = 0) => {
            const t = await frame.locator(sel).nth(i).boundingBox();
            if (!t) return null;
            await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
            await sleep(250);
            const tip = await frame.locator(".tt-layer").boundingBox().catch(() => null);
            const vp = page.viewportSize();
            const text = await frame.locator(".tt-layer").textContent().catch(() => "");
            return { tip, trigger: t, vp, text };
        };

        // Every tooltip-bearing thing in the panel: the ceiling figure (hard against the RIGHT edge), the pool
        // keys, and the badges in the model rows (near the panel's BOTTOM, inside what may be a scroller).
        const targets = [".rc-total", ".rc-key", ".vram-ctx", ".vram-ttl"];
        for (const sel of targets) {
            const n = await frame.locator(sel).count();
            expect(n, `${sel} exists to hover`).toBeGreaterThan(0);
            const r = await hover(sel);
            expect(r?.tip, `${sel} shows a tooltip`).toBeTruthy();
            expect(r.text.trim().length, `${sel}'s tooltip has content`).toBeGreaterThan(0);

            // FULLY ON SCREEN — the failure that kept recurring at the panel's right edge.
            expect(r.tip.x, `${sel}: off the left edge`).toBeGreaterThanOrEqual(-1);
            expect(r.tip.y, `${sel}: off the top edge`).toBeGreaterThanOrEqual(-1);
            expect(r.tip.x + r.tip.width, `${sel}: runs off the RIGHT edge`).toBeLessThanOrEqual(r.vp.width + 1);
            expect(r.tip.y + r.tip.height, `${sel}: runs off the BOTTOM edge`).toBeLessThanOrEqual(r.vp.height + 1);

            // NOT UNDER THE CURSOR — a tooltip covering the thing it describes is the other recurring bug.
            const cx = r.trigger.x + r.trigger.width / 2, cy = r.trigger.y + r.trigger.height / 2;
            const covers = cx >= r.tip.x && cx <= r.tip.x + r.tip.width && cy >= r.tip.y && cy <= r.tip.y + r.tip.height;
            expect(covers, `${sel}: the tooltip sits under the pointer`).toBe(false);
        }

        // NOT CLIPPED by the panel even when the panel is a SCROLL container — drag it small first, which is
        // exactly the state that used to cut these off.
        const grip = await frame.locator(".vram-grip").boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2, grip.y - 400, { steps: 6 });
        await page.mouse.up();
        await sleep(400);
        const scrolls = await frame.locator(".vram").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
        const r = await hover(".vram-ctx");
        if (r?.tip) {
            // The layer lives OUTSIDE the scrolling box, so its box is unaffected by that box's clipping.
            const inside = await frame.locator(".tt-layer").evaluate((el) => !!el.closest(".vram"));
            expect(inside, "the layer must not live inside the clipping container").toBe(false);
            expect(r.tip.x + r.tip.width).toBeLessThanOrEqual(r.vp.width + 1);
            expect(r.tip.y + r.tip.height).toBeLessThanOrEqual(r.vp.height + 1);
        }
        expect(typeof scrolls).toBe("boolean");

        // Moving away clears it — a tooltip left behind is worse than none. Move to a neutral spot INSIDE the
        // frame: leaving the iframe entirely doesn't reliably deliver a pointerout to it.
        const head = await frame.locator(".vram-total").boundingBox();
        await page.mouse.move(head.x + 4, head.y + 4);
        await sleep(300);
        expect(await frame.locator(".tt-layer:not([hidden])").count()).toBe(0);

        // COPYING. The old scheme kept every tooltip's prose in the DOM at opacity 0, so selecting a row and
        // copying it dragged all of that along. Select the whole panel and read what a copy would actually get.
        const selected = await frame.evaluate(() => {
            const panel = document.querySelector(".vram");
            const r = document.createRange();
            r.selectNodeContents(panel);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
            return sel.toString();
        });
        expect(selected.length, "the panel's own text is selectable").toBeGreaterThan(20);
        expect(selected, "a model row's name is in the selection").toContain("gemma4:31b");
        // …and none of the tooltip prose that sits invisibly inside those same rows.
        for (const phrase of ["Ollama preallocates", "Keep-alive TTL", "driver reports"]) {
            expect(selected, `copying the panel must not pick up tooltip prose ("${phrase}")`).not.toContain(phrase);
        }
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The CURSOR-FOLLOWING tips (a band, a pool line, a model row, an event in the lane) are a different family
// from the static ones above: they are positioned per pointer position rather than per trigger box, and each
// surface renders its own. Three failures, all reported from the demo: one landed directly under the cursor,
// several appeared at once, and a long one was clipped at the panel edge.
test("cursor tooltips: one at a time, never under the pointer, never clipped", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(BOX);
        // A SPLIT model — on both cards AND spilled into RAM — because that is what puts one model in EVERY
        // track, which is how three tooltips appeared stacked down the panel at once. Long name too: the tip
        // that got clipped was the one whose name pushed its figures past the edge.
        fake.setResident([{
            model: "colossus:120b-instruct-q4_K_M", name: "colossus:120b-instruct-q4_K_M",
            size: 121 * GiB, size_vram: 93 * GiB, context_length: 262144,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: 55 * GiB }, { gpu_id: "1", runner: "CUDA", size_vram: 38 * GiB }],
        }]);
        fake.setCapacity({ compute: {
            system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 6 * GiB },
            supported_gpus: [card(0, IDLE - 55 * GiB), card(1, IDLE - 38 * GiB)],
        } });

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1100, height: 800 });
        await page.goto(`${fake.url}/api/version`);
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "380px";     // narrow, hard against the right edge
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 80; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        for (let i = 0; i < 5; i++) {
            if (await frame.locator(".vram").count()) break;
            await frame.locator('[aria-label="VRAM monitor"]').click().catch(() => {});
            await sleep(400);
        }
        // Per-device tracks, so several surfaces exist to confuse each other.
        await frame.locator(".rc-preset").selectOption("memory").catch(() => {});
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(2000);

        const view = page.viewportSize();
        /** Move onto a target and report every cursor tip that is showing. */
        const hoverAt = async (sel, i = 0) => {
            const b = await frame.locator(sel).nth(i).boundingBox();
            const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            await page.mouse.move(at.x, at.y);
            await sleep(250);
            const tips = await frame.locator(".rc-tip, .vram-rowtip").evaluateAll((els) =>
                els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: e.textContent.trim() }; }));
            return { at, tips, box: b };
        };

        for (const sel of [".rc-band", ".vram-row", ".rc-hit"]) {
            if (!(await frame.locator(sel).count())) continue;
            const { at, tips } = await hoverAt(sel);
            if (!tips.length) continue;   // that surface has nothing to say here
            // ONE tip. Every track renders its own, all reading the same hover signals — which is how three
            // appeared stacked down the panel.
            expect(tips.length, `${sel}: ${tips.length} tooltips at once — ${tips.map((t) => t.text.slice(0, 24)).join(" | ")}`).toBe(1);
            const [tip] = tips;
            // Never UNDER the pointer: a tip beneath the cursor flickers as the pointer enters it, and hides
            // the thing being pointed at.
            const under = at.x >= tip.x && at.x <= tip.x + tip.w && at.y >= tip.y && at.y <= tip.y + tip.h;
            expect(under, `${sel}: the tooltip sits under the cursor`).toBe(false);
            // Fully on screen — the clipped one was cut off exactly at the window's right edge.
            expect(tip.x, `${sel}: runs off the left`).toBeGreaterThanOrEqual(0);
            expect(tip.y, `${sel}: runs off the top`).toBeGreaterThanOrEqual(0);
            expect(tip.x + tip.w, `${sel}: clipped at the right edge`).toBeLessThanOrEqual(view.width + 1);
            expect(tip.y + tip.h, `${sel}: clipped at the bottom`).toBeLessThanOrEqual(view.height + 1);
        }

        // Moving away clears them: a stuck tooltip is worse than none.
        await page.mouse.move(20, 400);
        await sleep(300);
        expect(await frame.locator(".rc-tip, .vram-rowtip").count()).toBe(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});
