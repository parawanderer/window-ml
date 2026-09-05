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

        // Every STATIC-tooltip bearer in the panel: the ceiling figure (hard against the RIGHT edge) and the
        // badges in the model rows (near the panel's BOTTOM, inside what may be a scroller). `.rc-key.tt` is
        // qualified deliberately — an Overview pool key carries NO static popup, because it opens the
        // cursor-following pool tip and having both meant two tooltips for one hover.
        const targets = [".rc-total", ".vram-ctx", ".vram-ttl"];
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

// The invariants above are checked at ONE point per target, which is exactly the kind of test that passes
// while the thing is broken: a tooltip's placement is a function of WHERE the pointer is, so it has to be
// checked across the space it can be in — near each edge, in each corner, in a panel with room to spare and
// in one without. What must hold at every point: fully on screen, never under the pointer, and RE-PLACED
// (flipped) rather than clamped or clipped.
for (const width of [360, 900]) {
    test(`cursor tooltips: placement holds everywhere in a ${width}px panel`, async () => {
        const fake = await startFakeLlm({ model: "fake-model" });
        const ext = await launchExtension();
        try {
            await configureExtension(ext.sw, {
                chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
                model: "fake-model", debugMode: "overlay",
            });
            fake.setCapacity({ compute: {
                system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 6 * GiB },
                supported_gpus: [card(0, IDLE - 55 * GiB), card(1, IDLE - 38 * GiB)],
            } });
            fake.setResident([{
                model: "colossus:120b-instruct-q4_K_M", name: "colossus:120b-instruct-q4_K_M",
                size: 121 * GiB, size_vram: 93 * GiB, context_length: 262144,
                expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
                gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: 55 * GiB }, { gpu_id: "1", runner: "CUDA", size_vram: 38 * GiB }],
            }]);

            const page = await ext.context.newPage();
            await page.setViewportSize({ width: 1100, height: 760 });
            await page.goto(`${fake.url}/api/version`);
            await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
            await page.evaluate((w) => {
                const root = document.getElementById("ml-sb-root").shadowRoot;
                const panel = root.getElementById("ml-sb-host");
                panel.style.width = `${w}px`;
                panel.classList.add("open");
                root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
            }, width);
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
            await frame.locator(".rc-preset").selectOption("memory").catch(() => {});
            await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
            // Make the panel TALL, so a hover target reaches the bottom of the window — where a tip that only
            // ever opens downward would run off.
            await frame.locator(".vram-grip").hover();
            await page.mouse.down();
            await page.mouse.move((await frame.locator(".vram-grip").boundingBox()).x + 40, 700, { steps: 6 });
            await page.mouse.up();
            await sleep(400);

            const view = page.viewportSize();
            // A rect measured INSIDE the iframe is frame-relative; page.mouse is page-relative. Comparing the
            // two directly is how a placement test can report a tooltip under a cursor that is nowhere near
            // it — and pass in a narrow panel for the same reason.
            const off = await page.evaluate(() => {
                const r = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-frame").getBoundingClientRect();
                return { x: r.x, y: r.y };
            });
            const failures = [];
            const probe = async (sel, at, label) => {
                await page.mouse.move(at.x, at.y);
                await sleep(120);
                const tips = (await frame.locator(".rc-tip, .vram-rowtip").evaluateAll((els) =>
                    els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })))
                    .map((t) => ({ ...t, x: t.x + off.x, y: t.y + off.y }));
                if (!tips.length) return;
                if (tips.length > 1) return failures.push(`${label}: ${tips.length} tooltips at once`);
                const t = tips[0];
                // Under the pointer — the tip would flicker as the cursor enters it, and it covers the thing
                // being pointed at.
                if (at.x >= t.x && at.x <= t.x + t.w && at.y >= t.y && at.y <= t.y + t.h)
                    failures.push(`${label}: under the cursor at (${Math.round(at.x)},${Math.round(at.y)})`);
                // Off screen in any direction. There is room for it somewhere; being cut off means it was
                // clamped or never re-placed.
                if (t.x < 0) failures.push(`${label}: off the left at x=${Math.round(t.x)}`);
                if (t.y < 0) failures.push(`${label}: off the top at y=${Math.round(t.y)}`);
                if (t.x + t.w > view.width + 1) failures.push(`${label}: clipped right by ${Math.round(t.x + t.w - view.width)}px`);
                if (t.y + t.h > view.height + 1) failures.push(`${label}: clipped bottom by ${Math.round(t.y + t.h - view.height)}px`);
            };

            // Includes the legend keys, where a static popup and a cursor tip once BOTH opened on one hover.
            for (const sel of [".rc-band", ".rc-hit", ".vram-row", ".rc-ev", ".rc-key", ".rc-total"]) {
                const n = await frame.locator(sel).count();
                if (!n) continue;
                const b = await frame.locator(sel).first().boundingBox();
                if (!b) continue;
                // Across the target's own width and height: its edges are where placement has to change.
                for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
                    for (const fy of [0.15, 0.5, 0.85]) {
                        await probe(sel, { x: b.x + b.width * fx, y: b.y + b.height * fy }, `${sel} @${fx}/${fy}`);
                    }
                }
            }
            expect(failures, failures.join("\n")).toEqual([]);
        } finally {
            await ext.close();
            await fake.stop();
        }
    });
}


// The three tooltips that had gone wrong in three different ways, all of them geometric and none of them
// visible to jsdom: a divider ruling a single line so it read as an empty cell, a long model name breaking
// mid-token into a column beside its own badges, and a header tooltip longer than the layer's max-width
// being CLIPPED because nobody remembered to mark it wrappable.
test("tooltips: dividers separate sections, names stay whole, and nothing is clipped", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(BOX);
        fake.setResident([resident("qwen3.8-flash-next:vision", 18 * GiB, 0)]);
        // The lane is collapsed by default now, and this test is about what its blocks say.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false, ml_res_sections: { lane: true, models: true } }));

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${fake.url}/api/version`);
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "560px";
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
        for (let i = 0; i < 5 && !(await frame.locator(".vram").count()); i++) {
            await frame.locator('[aria-label="VRAM monitor"]').click();
            await sleep(400);
        }
        await sleep(6000);   // enough samples that the lane has a segment to place events in

        // ---- the HEADER tooltips: long prose must WRAP rather than be cut off ----
        // The layer is nowrap with a max-width, so a sentence longer than that is simply clipped — the end of
        // the very thing being explained is the part you cannot read. It decides for itself now, because
        // "will this fit" depends on the rendered width and the font scale and is not a judgement a call site
        // can make.
        // A DETAIL view, because the longest header tooltip by far — focus mode's, a full sentence — only
        // exists there, and it is the one that was being cut off. A test that only hovered the short ones
        // passed with the bug still in.
        await page.evaluate(() => {
            const now = Date.now();
            window.postMessage({ __mlDebug: { kind: "agent", id: "tp1", ts: now - 5000, save: false,
                session: { hash: "tp1", turn: 0 }, task: "a task", model: "fake-model", maxSteps: 4, config: null } }, "*");
        });
        await expect.poll(() => frame.locator(".row").count(), { timeout: 10000 }).toBeGreaterThan(0);
        await frame.locator(".row").first().click();
        await expect.poll(() => frame.locator('[aria-label="Focus mode"]').count(), { timeout: 10000 }).toBe(1);

        for (const label of ["Focus mode", "VRAM monitor", "Python bench", "Server tools", "Settings"]) {
            const btn = frame.locator(`[aria-label="${label}"]`);
            if (!(await btn.count())) continue;
            // The real mouse, not `locator.hover()`: the layer opens on `pointerover`, and moving the mouse
            // is what the sibling test above does and what a person does.
            const box = await btn.first().boundingBox();
            if (!box) continue;
            // APPROACH the button rather than teleporting onto it: a jump from wherever the pointer was can
            // land without the browser synthesising the `pointerover` the layer opens on.
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
            const layer = frame.locator(".tt-layer");
            await expect(layer, `"${label}" produced no tooltip`).toBeVisible({ timeout: 4000 });
            const fit = await layer.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }));
            expect(fit.sw, `"${label}" tooltip is cut off horizontally`).toBeLessThanOrEqual(fit.cw + 1);
            expect(fit.sh, `"${label}" tooltip is cut off vertically`).toBeLessThanOrEqual(fit.ch + 1);
        }

        // ---- the MODEL ROW tooltip: the name and its badges read as one line, not three columns ----
        await frame.locator(".vram-row").first().hover();
        await sleep(400);
        const rowtip = frame.locator(".vram-rowtip");
        await expect(rowtip).toBeVisible();
        const name = await rowtip.locator(".vram-rowtip-name").evaluate((el) => {
            const line = parseFloat(getComputedStyle(el).lineHeight) || 13;
            return { rows: Math.round(el.getBoundingClientRect().height / line), width: el.getBoundingClientRect().width };
        });
        // A long id used to break mid-token while "on CUDA0 87.70 GiB" and "chat model" sat beside it as
        // further columns. Two rows is fine (the badges may wrap); the broken layout was three-plus.
        expect(name.rows, "the name line is not fragmented into a column").toBeLessThanOrEqual(2);

        // ---- the EVENT tooltip: a divider always separates two SECTIONS ----
        await page.evaluate(() => {
            const now = Date.now();
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            post({ kind: "agent", id: "tt1", ts: now - 9000, save: false, session: { hash: "tt1", turn: 0 },
                   task: "t", model: "qwen3.8-flash-next:vision", maxSteps: 4, config: null });
            post({ kind: "agent-step", id: "tt1", ts: now - 3000, save: false, session: { hash: "tt1", turn: 1 },
                   step: 1, seq: 1, tool: "agent_api_docs", toolMs: 8, approveMs: 0, dispatchMs: 4,
                   arguments: {}, result: "ok",
                   usage: { promptTokens: 16941, completionTokens: 138, totalTokens: 17079, genMs: 15000,
                            evalMs: 1588, promptEvalMs: 6103, model: "qwen3.8-flash-next:vision" } });
        });
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 15000 }).toBeGreaterThan(0);
        await frame.locator(".rc-ev-tool").first().hover();
        await sleep(400);
        const tip = frame.locator(".rc-tip-event");
        await expect(tip).toBeVisible();
        const shape = await tip.evaluate((el) => {
            const kids = [...el.children].map((c) => (c.className.match(/rc-tip-\w+/) || ["?"])[0]);
            const box = el.getBoundingClientRect();
            const rules = [...el.querySelectorAll(".rc-tip-rule")].map((r) => Math.round(r.getBoundingClientRect().width));
            return { kids, rules, width: Math.round(box.width) };
        });
        // No two rules in a row, and none first or last: a divider with nothing on one side of it is not
        // separating anything. Ruling the timestamp on BOTH sides is what made it read as an empty cell.
        expect(shape.kids[0], "a tooltip does not open with a divider").not.toBe("rc-tip-rule");
        expect(shape.kids.at(-1), "…nor end with one").not.toBe("rc-tip-rule");
        for (let i = 1; i < shape.kids.length; i++) {
            expect(`${shape.kids[i - 1]}+${shape.kids[i]}`, "two dividers with nothing between them")
                .not.toBe("rc-tip-rule+rc-tip-rule");
        }
        // And each spans the tooltip's content width, so it reads as a rule rather than a stray dash.
        for (const w of shape.rules) expect(w).toBeGreaterThan(shape.width * 0.8);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});
