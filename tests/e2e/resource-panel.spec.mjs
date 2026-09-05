// resource-panel.spec.mjs — the resource panel against a scripted fake BOX, in a real browser.
//
// The band arithmetic is unit-tested (resource-model.test.mjs) and the rendering is jsdom-tested
// (sidebar.test.js). What only a real browser can show is the panel driven by an actual /api/info + /api/ps
// over time: capacity refreshing as models load, and a GAP appearing because polling really did stop while
// the panel was closed. The narrated version of the same script is resource-demo.mjs.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GiB = 1024 ** 3;
const IDLE = 94.42 * GiB;   // an idle card still holds ~0.55 GiB of ollama's discovery context
const card = (id, freeBytes) => ({
    gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2",
    total_memory: 101972967424, physical_memory: 102641958912, free_memory: freeBytes,
});
const box = (free0, free1, hostFree = 12.3 * GiB) => ({
    compute: {
        system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: hostFree },
        supported_gpus: [card(0, free0), card(1, free1)],
    },
});
const resident = (name, vramBytes, gpu, sizeBytes = vramBytes) => ({
    model: name, name, size: sizeBytes, size_vram: vramBytes, context_length: 262144, expires_at: null,
    ...(vramBytes ? { gpus: [{ gpu_id: String(gpu), runner: "CUDA", size_vram: vramBytes }] } : {}),
});

/** The stacked per-pool view. The DEFAULT is Overview — one compact overlaid track — so a test about per-pool
 *  TRACKS and per-model bands must choose the view that has them. Seeded through storage, which also exercises
 *  the restore path. */
async function seedStacked(ext) {
    await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "memory", tracks: [
        { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 96 },
        { id: "dev-1", series: ["vram.1"], mode: "stack", heightPx: 96 },
        { id: "ram", series: ["ram"], mode: "stack", heightPx: 96 },
    ] } }));
}

/** Boot the extension against the fake box and return the sidebar frame with the VRAM panel open. */
async function openPanel(fake, ext) {
    // The event LANE is collapsed by default (its chip row is the control). These specs are about what the
    // lane draws, so they state that as a precondition rather than relying on a default that can change —
    // the default itself is pinned by its own test.
    await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_sections: { lane: true, models: true } }));
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fake.url}/api/version`);
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = "460px";
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
    // Drive the toggle to a known state rather than clicking blind — a missed click inverts every later step.
    const setPanel = async (open) => {
        for (let i = 0; i < 5; i++) {
            if (((await frame.locator(".vram").count()) > 0) === open) return;
            await frame.locator('[aria-label="VRAM monitor"]').click();
            await sleep(400);
        }
        throw new Error(`couldn't put the panel ${open ? "open" : "closed"}`);
    };
    await setPanel(true);
    return { page, frame, setPanel };
}

test("resource panel: a real ceiling, per-model bands, and capacity that tracks a load", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE, IDLE));
        fake.setResident([]);
        await seedStacked(ext);
        const { frame } = await openPanel(fake, ext);

        // One track per card, plus the host pool — small multiples, because a model can only ever use one
        // card's capacity and a shared axis would be a lie.
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(3);
        expect(await frame.locator(".rc-name").allTextContents()).toEqual(["CUDA0", "CUDA1", "System RAM"]);

        // An IDLE card's residual is ollama's own context — never presented as another process.
        const idleLegend = await frame.locator(".rc-track").first().locator(".rc-legend").textContent();
        expect(idleLegend).toMatch(/driver overhead/);

        // Load a model onto card 0. Capacity carries `free_memory`, which is NOT slow-moving, so the panel
        // must refresh it — otherwise the header and the free band disagree forever.
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        const head = frame.locator(".rc-track").first().locator(".rc-total");
        const legend = frame.locator(".rc-track").first().locator(".rc-legend");
        // Poll the FREE band, not the header: free_memory is what proves capacity was re-fetched (the header
        // moves as soon as ps reports the model). CAPACITY_EVERY is 5 polls at 2s, so allow well past 10s.
        await expect.poll(async () => (await legend.textContent()) || "", { timeout: 40000 })
            .toMatch(/free 76\.42 GiB/);

        // The ceiling is the DRIVER framebuffer total (physical_memory), so the panel agrees with nvidia-smi
        // rather than appearing to lose a gigabyte.
        expect(await head.textContent()).toContain("95.59 GiB");
        // Used + free reconcile to ollama's own total (94.97 GiB); the rest of the way to the displayed 95.59
        // is the driver's own reserve, which is expected and must never be shown as an error.
        expect(await head.textContent()).toMatch(/18\.\d+ GiB \//);
        // Binary units everywhere: a decimal reading would be 7.4% out and look plausible.
        expect(await frame.locator(".rc").textContent()).not.toMatch(/\d GB\b/);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

test("resource panel: a closed spell leaves a GAP, and no /api/info draws no ceiling", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await seedStacked(ext);
        const { frame, setPanel } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(3);

        // Sample for a while, so there is a run to break.
        await expect.poll(() => frame.locator(".rc-track").first().locator(".rc-seg").count(), { timeout: 20000 })
            .toBeGreaterThan(0);
        await sleep(6000);
        expect(await frame.locator(".rc-track").first().locator(".rc-seg").count()).toBe(1);

        // Polling is gated on the panel being open, so a closed spell genuinely measures nothing. Longer than
        // MAX_SAMPLE_GAP_MS, so the history must BREAK rather than draw a line across it.
        await setPanel(false);
        // Comfortably past MAX_SAMPLE_GAP_MS (15s), not just over it: a poll already in flight when the panel
        // closes lands after it, so an 18s spell could measure as a 14s gap and the two runs merged — a flake
        // in a test whose whole subject is the gap.
        await sleep(24000);
        await setPanel(true);
        await expect.poll(() => frame.locator(".rc-track").first().locator(".rc-seg").count(), { timeout: 20000 })
            .toBe(2);   // two runs = one honest gap between them

        // A server that stops answering mid-session does NOT wipe what was already measured — capacity is a
        // fact about the box, and forgetting it flipped the whole panel to the legacy sparkline and back at
        // random. The tracks must stay through several failed polls.
        fake.setCapacity(null);
        await sleep(14000);   // longer than CAPACITY_EVERY (5 polls at 2s), so several answers came back empty
        expect(await frame.locator(".rc-track").count()).toBe(3);
        expect(await frame.locator(".vram-spark").count()).toBe(0);

        // A box that has NEVER answered is the real degrade: capacity is UNKNOWN, so the panel draws no
        // ceiling and falls back to the auto-scaled sparkline rather than inventing one. Fresh page, because
        // "never answered" is a different state from "stopped answering".
        const fresh = await openPanel(fake, ext);
        await expect.poll(() => fresh.frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(0);
        expect(await fresh.frame.locator(".vram-spark").count()).toBe(1);
        // The in-use total still renders, still in binary units.
        expect(await fresh.frame.locator(".vram-total").textContent()).toMatch(/GiB in use/);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Swapping the backend from a CUDA server to a Metal Mac. Not a cosmetic case: those samples were measured
// against a 94.97 GiB ceiling on devices whose ids mean different hardware, so redrawn on an 11.84 GiB Mac an
// 18 GiB band would clip at 100% and read as a measurement rather than a category error.
const METAL_BOX = {
    compute: {
        system_compute: { cpu_cores: 10, total_memory: 17179869184, free_memory: 3682385920, free_swap: 0 },
        supported_gpus: [{ gpu_id: "0", name: "MTL0", runner: "Metal", total_memory: 12712935424, free_memory: 12711886848 }],
    },
};
const metalResident = (name, bytes) => ({
    model: name, name, size: bytes, size_vram: bytes, context_length: 4096, expires_at: null,
    gpus: [{ gpu_id: "0", runner: "Metal", size_vram: bytes }],
});

test("resource panel: switching CUDA → Metal re-shapes the panel and drops the old box's history", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await seedStacked(ext);
        const { frame } = await openPanel(fake, ext);

        // The server: three tracks, ~95 GiB ceilings.
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(3);
        await sleep(5000);   // accumulate history that must NOT survive the switch
        expect(await frame.locator(".rc-total").first().textContent()).toContain("95.59 GiB");

        // Now the same extension, pointed at a Mac.
        fake.setCapacity(METAL_BOX);
        fake.setResident([metalResident("qwen3:0.6b", 1 * GiB), metalResident("gemma4:e2b", 3 * GiB)]);

        // ONE track: unified memory is a single pool, so a separate RAM track would double-count the silicon.
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 40000 }).toBe(1);
        const name = await frame.locator(".rc-name").textContent();
        expect(name).toMatch(/MTL0/);
        expect(name).toMatch(/unified/, "and it says so, rather than looking like a small GPU");

        // The ceiling is the SYSTEM total (16 GiB), with the working set as a soft line inside it — never the
        // device total presented as the whole machine.
        const head = await frame.locator(".rc-total").textContent();
        expect(head).toContain("16.00 GiB");
        expect(await frame.locator(".rc-soft").count()).toBe(1);

        // The old box's samples are GONE, so the chart has to rebuild from scratch — it takes two polls before
        // there is a drawable run at all (one point has no shape). That wait is the proof the history was
        // dropped rather than redrawn against the new ceiling.
        await expect.poll(() => frame.locator(".rc-seg").count(), { timeout: 30000 }).toBeGreaterThan(0);
        // Nothing on screen still claims the server's capacity.
        expect(await frame.locator(".rc").textContent()).not.toContain("95.59 GiB");

        // Two models in ONE pool DO stack — within a single pool the parts genuinely sum to its occupancy.
        // (It is only ACROSS pools that a stack would assert a total nothing is measured against.)
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 20000 }).toBe(2);
        // Neither band may reach the top of the plot: 1 + 3 GiB of a 16 GiB pool is a quarter of it, and a
        // band pinned at y=0 is the clipping that happens when another machine's readings are drawn here.
        const geom = await frame.locator(".rc-band").evaluateAll((els) => els.map((e) => {
            const ys = e.getAttribute("points").split(" ").map((p) => Number(p.split(",")[1]));
            return { top: Math.min(...ys), bottom: Math.max(...ys) };
        }));
        expect(geom.every((g) => g.top > 8), `no band is clipped at the ceiling — got ${JSON.stringify(geom)}`).toBe(true);
        // …and they STACK: within one pool the parts genuinely sum to its occupancy, so the second sits on top
        // of the first rather than behind it. (It is only ACROSS pools that a stack asserts a false total.)
        const tops = geom.map((g) => g.top).sort((a, b) => b - a);
        expect(tops[1]).toBeLessThan(tops[0], "one band's top is the other's baseline");
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Resizing, with REAL geometry — the one thing jsdom cannot check. The panel is dragged tall (the chart must
// actually grow into it), then collapsed to its floor, where the failure to catch is content OVERLAPPING:
// at 80px the header, plot and rows could not fit and spilled over each other and over the session list.
test("resource panel: drags to expand and collapse, and never overlaps at its smallest", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);

        const boxOf = (sel, i = 0) => frame.locator(sel).nth(i).boundingBox();
        const drag = async (fromY, toY) => {
            const grip = await frame.locator(".vram-grip").boundingBox();
            await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await page.mouse.down();
            await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + (toY - fromY), { steps: 8 });
            await page.mouse.up();
            await sleep(300);
        };

        // EXPAND: the chart itself must grow, not just the panel (a fixed-height plot would leave dead space).
        const plot0 = await boxOf(".rc-plot");
        const panel0 = await boxOf(".vram");
        await drag(0, 220);
        const plot1 = await boxOf(".rc-plot");
        const panel1 = await boxOf(".vram");
        expect(panel1.height).toBeGreaterThan(panel0.height + 100);
        expect(plot1.height, "the chart grows with the panel, not empty space below it").toBeGreaterThan(plot0.height + 60);

        // COLLAPSE: drag far past the floor; it must clamp rather than shrink into nothing.
        // COLLAPSE: drag far past the floor. It must clamp to a usable size rather than shrink into nothing —
        // and the grip must still be REACHABLE after the expand (it used to scroll away with the content).
        await drag(0, -900);
        // The drag itself is unclamped — the panel corrects AFTER you let go, so wait for it to settle rather
        // than reading mid-correction. (That ordering is the point: nothing resizes under your hand.)
        // Dragging UP stops where the content stops fitting — it must not keep shrinking and mangle the text
        // until release. So there is nothing to settle: it already fits, mid-drag.
        const overDuring = await frame.locator(".vram").evaluate((el) => el.scrollHeight - el.clientHeight);
        expect(overDuring, "the drag itself is blocked at the fit point, not corrected afterwards")
            .toBeLessThanOrEqual(2);
        const small = await boxOf(".vram");
        expect(small.height, "collapses below the expanded size").toBeLessThan(panel1.height);
        // The floor is LEARNED (the height at which the content stops overflowing), not a magic number — so
        // the contract is "it stops somewhere the content fits", never a fixed px value that would go stale
        // the moment a track grows a row.
        expect(small.height, "doesn't shrink into nothing").toBeGreaterThan(80);
        expect(small.height, "…and settles where the content fits").toBeGreaterThan(80);

        // …and at that smallest size NOTHING may overlap. Collect the panel's own stacked parts and assert
        // each begins at or below the previous one's bottom.
        const parts = [];
        for (const sel of [".vram-head", ".rc-plot", ".rc-legend", ".vram-row"]) {
            const n = await frame.locator(sel).count();
            for (let i = 0; i < n; i++) {
                const b = await frame.locator(sel).nth(i).boundingBox();
                if (b && b.height > 0) parts.push({ sel, ...b });
            }
        }
        expect(parts.length).toBeGreaterThan(2);
        parts.sort((a, b) => a.y - b.y);
        for (let i = 1; i < parts.length; i++) {
            const prev = parts[i - 1], cur = parts[i];
            expect(cur.y, `${cur.sel} overlaps ${prev.sel} at the panel's smallest size`)
                .toBeGreaterThanOrEqual(prev.y + prev.height - 1.5);
        }

        // Nothing may spill past the panel into the session list below: what doesn't fit SCROLLS.
        const scrolls = await frame.locator(".vram").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
        const spilled = await frame.locator(".vram").evaluate((el) => {
            const box = el.getBoundingClientRect();
            return [...el.children].some((c) => c.getBoundingClientRect().bottom > box.bottom + 2);
        });
        expect(spilled && !scrolls, "content past the bottom edge must scroll, not spill over the list").toBe(false);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// A height saved when the panel held a different layout comes back too small for the current one. The failure
// is GEOMETRIC — parts rendering on top of each other — so it is measured by bounding box: no two of the
// panel's stacked parts may intersect, at load and after switching views.
test("resource panel: a too-small saved height never leaves parts overlapping", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // A height from a previous session, far too small for anything.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_vram_h: 96 }));
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-key").count(), { timeout: 20000 }).toBeGreaterThan(0);

        /** Every intersecting pair among the panel's stacked parts. */
        const overlaps = async () => frame.evaluate(() => {
            const sels = [".vram-head", ".rc-head", ".rc-plot", ".rc-legend", ".vram-row"];
            const parts = [];
            for (const sel of sels) {
                for (const el of document.querySelectorAll(sel)) {
                    const r = el.getBoundingClientRect();
                    if (r.height > 0 && r.width > 0) parts.push({ sel, top: r.top, bottom: r.bottom });
                }
            }
            const bad = [];
            for (let i = 0; i < parts.length; i++) {
                for (let j = i + 1; j < parts.length; j++) {
                    const a = parts[i], b = parts[j];
                    // Vertical intersection of more than a hairline means one is drawn over the other.
                    const over = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                    if (over > 1.5) bad.push(`${a.sel} × ${b.sel} (${over.toFixed(1)}px)`);
                }
            }
            return bad;
        });

        // Settle: the panel measures itself and grows into its floor after the first paint.
        await expect.poll(async () => (await overlaps()).length, { timeout: 15000 }).toBe(0);

        // …and it must still hold after switching to the layout with the MOST parts, which is where a floor
        // computed for a one-track view falls short.
        await frame.locator(".rc-preset").selectOption("memory");
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 15000 }).toBe(3);
        await expect.poll(async () => (await overlaps()).length, { timeout: 15000 }).toBe(0);

        // Nothing is achieved by overlapping instead of scrolling: what doesn't fit must scroll.
        const fits = await frame.locator(".vram").evaluate((el) => el.scrollHeight <= el.clientHeight + 2 || getComputedStyle(el).overflowY === "auto");
        expect(fits, "content that doesn't fit scrolls rather than spilling").toBe(true);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// A UI that pulls against your hand is worse than one that is slightly wrong. The panel corrects itself —
// growing when content no longer fits — but that must NEVER happen while you are dragging, and a drag must
// take over instantly from an animation already in flight.
test("resource panel: a manual drag always wins over a programmatic resize", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // A stored height far too small: the panel will want to correct itself the moment it renders.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_vram_h: 100 }));
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-key").count(), { timeout: 20000 }).toBeGreaterThan(0);

        const h = () => frame.locator(".vram").evaluate((el) => el.getBoundingClientRect().height);
        // It corrects itself first — that is the behaviour a drag must be able to override.
        await expect.poll(h, { timeout: 15000 }).toBeGreaterThan(120);

        // GRAB and hold. While the button is down, the height must be exactly where the pointer put it and
        // must not drift under it, even though the panel would otherwise be correcting.
        const grip = await frame.locator(".vram-grip").boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + 260, { steps: 10 });
        await sleep(150);
        const held = await h();
        await sleep(700);                       // long enough for any ease to have run to completion
        const stillHeld = await h();
        expect(Math.abs(stillHeld - held), "the panel moved under the user's hand").toBeLessThan(3);

        // Drag SMALLER than fits and hold: still no correction while held.
        await page.mouse.move(grip.x + grip.width / 2, grip.y - 400, { steps: 10 });
        await sleep(150);
        const small = await h();
        await sleep(700);
        expect(Math.abs((await h()) - small), "no correction while the button is down").toBeLessThan(3);

        // RELEASE: now it may correct, and it grows until the content fits.
        await page.mouse.up();
        await expect.poll(async () => {
            const over = await frame.evaluate(() => {
                const el = document.querySelector(".vram");
                return el.scrollHeight - el.clientHeight;
            });
            return over;
        }, { timeout: 15000 }).toBeLessThanOrEqual(2);
        // It never ends up SMALLER than where you let go — a correction may only grow. (Here it already fit,
        // because the drag was clamped at the learned floor, so the correction is a no-op — which is the point:
        // the floor is a lower bound the drag respects, not something that yanks the panel afterwards.)
        expect(await h(), "a correction never shrinks below where you let go").toBeGreaterThanOrEqual(small - 1);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The track editor stays MOUNTED while closed so it can animate both ways — which cost a strip of empty panel
// between the header and the plot, because min-height:0 zeroes only the content box and a zero-height flex
// item still takes the column's gap on both sides. jsdom has no layout, so the slack is only visible here.
test("resource panel: a closed editor takes no space, an open one takes its own", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);

        const gap = async () => {
            const head = await frame.locator(".vram-head").boundingBox();
            const plot = await frame.locator(".rc").boundingBox();
            return plot.y - (head.y + head.height);
        };
        // One gap, not two — anything more reads as the panel having lost something.
        expect(await gap()).toBeLessThanOrEqual(8);
        expect(await frame.locator(".rc-editor-wrap").boundingBox().then((b) => b.height)).toBe(0);

        // Opening it costs real height, and the panel grows rather than eating the plot.
        const before = (await frame.locator(".vram").boundingBox()).height;
        await frame.locator('[aria-label="Edit tracks"]').click();
        await expect.poll(async () => (await frame.locator(".rc-editor-wrap").boundingBox()).height, { timeout: 5000 })
            .toBeGreaterThan(20);
        expect((await frame.locator(".vram").boundingBox()).height).toBeGreaterThan(before);

        // …and closing it gives every pixel back.
        await frame.locator('[aria-label="Edit tracks"]').click();
        await expect.poll(async () => (await frame.locator(".rc-editor-wrap").boundingBox()).height, { timeout: 5000 }).toBe(0);
        expect(await gap()).toBeLessThanOrEqual(8);

        // Nothing below the last row but the grip: the panel's bottom edge IS the handle.
        const rows = frame.locator(".vram-row");
        const last = await rows.nth((await rows.count()) - 1).boundingBox();
        const panel = await frame.locator(".vram").boundingBox();
        expect(panel.y + panel.height - (last.y + last.height)).toBeLessThanOrEqual(20);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

test("resource panel: clicking a legend key switches that pool's line off, and back on", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        const { frame } = await openPanel(fake, ext);
        // Overview is the default: one track, a line per pool, a key per line.
        await expect.poll(() => frame.locator(".rc-legend .rc-key").count(), { timeout: 20000 }).toBeGreaterThan(1);
        const keys = frame.locator(".rc-legend .rc-key");
        const lines = () => frame.locator(".rc-line").count();
        const drawn = await lines();
        expect(drawn).toBeGreaterThan(1);

        // The key IS the line's identity, so it is the switch. Clicking removes the line entirely rather than
        // dimming it: the point of switching a pool off is to get it out of the way of the ones being read,
        // and a ghost still crosses them.
        await keys.first().click();
        await expect.poll(() => lines(), { timeout: 5000 }).toBe(drawn - 1);
        await expect(keys.first()).toHaveClass(/off/);
        expect(await keys.first().getAttribute("aria-pressed")).toBe("false");

        // The tooltip reads the LINES, so a pool that is not drawn gets no row in it either — reporting a
        // series the reader deliberately removed would be answering about something not on screen.
        await frame.locator(".rc-plot").first().hover();
        const tipRows = frame.locator(".rc-tip-pools .rc-tip-poolrow");
        await expect.poll(() => tipRows.count(), { timeout: 5000 }).toBe(drawn - 1);

        // And back. Nothing about this is persisted — it is a reading choice about what is on screen now.
        await keys.first().click();
        await expect.poll(() => lines(), { timeout: 5000 }).toBe(drawn);
        await expect(keys.first()).not.toHaveClass(/off/);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

test("resource panel: a BUSY runner holds its countdown, and a LOADING one has no deadline to show", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        // Idle, with a real deadline four minutes out: the ordinary case, a chip that ticks.
        const deadline = () => new Date(Date.now() + 4 * 60_000).toISOString();
        fake.setResident([{ ...resident("gemma4:31b", 18 * GiB, 0), expires_at: deadline() }]);
        const { frame } = await openPanel(fake, ext);
        const chip = frame.locator(".vram-row", { hasText: "gemma4:31b" }).locator(".vram-ttl");
        // The chip carries its tooltip INSIDE it, so read the chip's own text node rather than textContent.
        const ttl = { textContent: () => chip.evaluate((el) => el.firstChild?.textContent ?? ""),
                      getAttribute: (a) => chip.getAttribute(a), count: () => chip.count() };
        await expect.poll(() => ttl.textContent(), { timeout: 20000 }).toMatch(/^[34]m \d+s$/);
        expect(await ttl.getAttribute("class")).not.toContain("busy");

        // Now it starts serving a request. The server does NOT move the deadline until that request finishes,
        // so a chip that kept counting would be counting against a stamp that has stopped moving — and on a
        // generation longer than the TTL it would pass zero while the model sits there working.
        fake.setResident([{ ...resident("gemma4:31b", 18 * GiB, 0), expires_at: deadline(), busy: true }]);
        await expect.poll(() => ttl.textContent(), { timeout: 20000 }).toBe("in use");
        expect(await ttl.getAttribute("class")).toContain("busy");

        // A second model arrives, still LOADING: the patched server sends its name and zeros for everything
        // else, and Go's zero time reads as a deadline in year 1. It must show no countdown rather than one.
        fake.setResident([
            { ...resident("gemma4:31b", 18 * GiB, 0), expires_at: deadline(), busy: true },
            { model: "qwen3.5:35b", name: "qwen3.5:35b", size: 0, size_vram: 0,
              expires_at: "0001-01-01T00:00:00Z", state: "loading" },
        ]);
        const loading = frame.locator(".vram-row", { hasText: "qwen3.5:35b" });
        await expect.poll(() => loading.count(), { timeout: 20000 }).toBe(1);
        expect(await loading.locator(".vram-ttl").count()).toBe(0);   // no stamp is better than a negative one

        // And when it goes idle again the clock restarts, from full.
        fake.setResident([{ ...resident("gemma4:31b", 18 * GiB, 0), expires_at: deadline() }]);
        await expect.poll(() => ttl.textContent(), { timeout: 20000 }).toMatch(/^[34]m \d+s$/);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The real thing the unit test can only approximate: a browser hit-testing an SVG stroke. Hovering the EDGE
// of an overview line made the tooltip flicker many times a second — the visible stroke thickens on hover and,
// painted above the hit target, took the pointer, which fired pointerleave on the target, which thinned it.
test("resource panel: hovering the edge of an overview line doesn't flicker", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        const { page, frame } = await openPanel(fake, ext);
        // Overview is the default view; a line needs a couple of samples to have any shape.
        await expect.poll(() => frame.locator(".rc-hit").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(5000);

        // Where the newest end of the line is painted. Measured INSIDE the frame as a fraction of the plot,
        // then mapped onto the plot's box in page coordinates — a client rect from inside an iframe is
        // frame-relative and page.mouse is not.
        const rel = await frame.locator(".rc-hit").first().evaluate((el) => {
            const pts = el.getAttribute("points").trim().split(/\s+/);
            const last = pts[pts.length - 1].split(",").map(Number);
            const svg = el.ownerSVGElement.getBoundingClientRect();
            const plot = el.closest(".rc-plot").getBoundingClientRect();
            const vb = el.ownerSVGElement.viewBox.baseVal;
            return { fx: (svg.left + (last[0] / vb.width) * svg.width - plot.left) / plot.width,
                     fy: (svg.top + (last[1] / vb.height) * svg.height - plot.top) / plot.height };
        });
        const plotBox = await frame.locator(".rc-plot").boundingBox();
        const spot = { x: plotBox.x + rel.fx * plotBox.width - 3, y: plotBox.y + rel.fy * plotBox.height };
        const inFrame = { dx: plotBox.x, dy: plotBox.y };

        await page.mouse.move(spot.x, spot.y);
        await expect.poll(() => frame.locator(".rc-tip-pools").count(), { timeout: 5000 }).toBe(1);

        // THE invariant: while the line is hovered and drawn at its thick width, every point within that thick
        // stroke must still hit-test to the TARGET. If the fat visible line answers here, the pointer leaves
        // the target the moment the highlight appears — which is the oscillation.
        const owners = await frame.evaluate(({ fx, fy, ox, oy }) => {
            const plot = document.querySelector(".rc-plot").getBoundingClientRect();
            const x = plot.left + fx - ox, y = plot.top + fy - oy;
            return [-1.4, -1, -0.5, 0, 0.5, 1, 1.4].map((dy) => {
                const el = document.elementFromPoint(x, y + dy);
                return el ? (typeof el.className === "object" ? el.getAttribute("class") : el.className) || el.tagName : "none";
            });
        }, { fx: spot.x - inFrame.dx, fy: spot.y - inFrame.dy, ox: 0, oy: 0 });
        expect(owners.filter((c) => /rc-line/.test(c)),
            `the thickened line took the pointer from its own hit target (${owners.join(", ")})`).toEqual([]);

        // And behaviourally: sit on the edge and the tooltip stays up.
        let missing = 0;
        for (let i = 0; i < 10; i++) {
            await page.mouse.move(spot.x, spot.y + (i % 2 ? 1.2 : 0.9));
            await sleep(50);
            if (!(await frame.locator(".rc-tip-pools").count())) missing++;
        }
        expect(missing, "the tooltip flickered while the pointer sat on the line's edge").toBe(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Dragging up stops at the floor — and STAYS there. It used to settle a few px away after release: the drag
// read its own shortfall in the same frame as the height that caused it (the chart's flex box and its SVG
// settle a frame later), so it stopped just off the true minimum and the next correction moved it.
test("resource panel: releasing the drag doesn't move the panel", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(3000);

        const height = async () => (await frame.locator(".vram").boundingBox()).height;
        const tall = await height();
        const grip = await frame.locator(".vram-grip").boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        // Well past the floor: the clamp is what stops it, not the pointer.
        await page.mouse.move(grip.x + grip.width / 2, grip.y - 400, { steps: 12 });
        await sleep(150);
        const held = await height();
        expect(held, "the drag squeezed the panel").toBeLessThan(tall - 20);

        await page.mouse.up();
        // Through the correction tick (1s) and well past it: the height must not move AT ALL.
        for (const wait of [100, 400, 1200, 2000]) {
            await sleep(wait);
            expect(Math.abs((await height()) - held), `the panel moved ${Math.round((await height()) - held)}px after release`)
                .toBeLessThanOrEqual(1);
        }
        // And it really is the floor: the content fits, with nothing overflowing.
        const over = await frame.locator(".vram").evaluate((el) => el.scrollHeight - el.clientHeight);
        expect(over, "it stopped where everything still fits").toBeLessThanOrEqual(2);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Dragged out to a full page, the panel used to stretch each track to the full width — a 1400px-wide, 44px-tall
// sparkline is a worse chart than two 700px ones, and a wide sidebar is exactly when you are looking closely.
test("resource panel: wide tiles the tracks instead of stretching them", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        await seedStacked(ext);   // three tracks: two cards and the host pool
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(3);

        const rows = async () => {
            const boxes = await frame.locator(".rc-track").evaluateAll((els) =>
                els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; }));
            return { boxes, distinctRows: new Set(boxes.map((b) => b.y)).size };
        };

        // Narrow (the default 460px sidebar): one per row, full width.
        const narrow = await rows();
        expect(narrow.distinctRows, "a narrow panel stacks them").toBe(3);

        // Drag the sidebar out to a full page.
        await page.evaluate(() => {
            document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host").style.width = "1200px";
        });
        await sleep(600);
        const wide = await rows();
        expect(wide.distinctRows, "a wide panel tiles them side by side").toBe(1);
        expect(wide.boxes[0].w, "…and each track is narrower than the panel, not stretched across it")
            .toBeLessThan(narrow.boxes[0].w * 2);
        // Every tile is readable: none squeezed under the column minimum.
        for (const b of wide.boxes) expect(b.w).toBeGreaterThanOrEqual(280);

        // In BETWEEN, it fits what it can and wraps the rest — the layout decides, so there is no breakpoint
        // to keep in sync with the panel's real width.
        await page.evaluate(() => {
            document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host").style.width = "760px";
        });
        await sleep(600);
        const mid = await rows();
        expect(mid.distinctRows, "two fit, the third wraps").toBe(2);
        expect(new Set(mid.boxes.map((b) => b.x)).size, "…into a column, not on top of each other").toBe(2);

        // Nothing overlaps in ANY of those arrangements: same-row tiles are side by side, and a wrapped tile
        // starts below the row above it.
        for (const { boxes } of [narrow, wide, mid]) {
            for (const a of boxes) for (const b of boxes) {
                if (a === b) continue;
                const apart = a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y !== b.y;
                expect(apart, `tracks overlap at ${JSON.stringify([a, b])}`).toBe(true);
            }
        }

        // And the panel can now be SHORTER than it could when narrow: tiling needs less height, and the floor
        // is keyed by width so it comes back down instead of ratcheting.
        await page.evaluate(() => {
            document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host").style.width = "1200px";
        });
        await sleep(600);
        const floorAt = async () => {
            const grip = await frame.locator(".vram-grip").boundingBox();
            await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await page.mouse.down();
            await page.mouse.move(grip.x + grip.width / 2, grip.y - 500, { steps: 10 });
            await sleep(150);
            const h = (await frame.locator(".vram").boundingBox()).height;
            await page.mouse.up();
            await sleep(300);
            return h;
        };
        const wideFloor = await floorAt();
        await page.evaluate(() => {
            document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host").style.width = "460px";
        });
        await sleep(800);
        const narrowFloor = await floorAt();
        expect(wideFloor, "one row of tiles needs less height than three stacked").toBeLessThan(narrowFloor - 40);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The event lane in a real browser: jsdom has no layout, so the alignment of a bar to the segment it belongs
// to, and the click that navigates to the step, can only be checked here. The run is SCRIPTED — posted as the
// same __mlDebug events a real run emits — because the fake box moves memory but runs no model.
test("resource panel: the event lane draws phased blocks, dims by lineage, and clicks through", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // The lane is SCOPED to the open session by default, and this test posts events without opening
        // one, so it asks for the all-sessions view the toggle offers. Tests that read the default are
        // the scoping ones below.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);
        // Sample for a while: an event outside the window is correctly dropped, so there must BE a window.
        await sleep(9000);

        await page.evaluate(() => {
            const now = Date.now(), span = 7000;
            const at = (f) => now - Math.round(span * f);
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            const hash = "e2e-run";
            post({ kind: "agent", id: hash, ts: at(1), save: false, session: { hash, turn: 0 },
                   task: "check the page", model: "gemma4:31b", maxSteps: 4, config: null });
            post({ kind: "agent-step", id: hash, ts: at(0.5), save: false, session: { hash, turn: 1 },
                   step: 1, seq: 1, tool: "python_exec", toolMs: 1200, arguments: { code: "1" }, result: "ok",
                   // A real load in front of it: the model wasn't resident yet.
                   usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, genMs: 800, loadMs: 1800 },
                   subUsage: { calls: 1, prompt: 400, completion: 10,
                               byModel: [{ model: "minicpm-v:8b", prompt: 400, completion: 10, calls: 1 }],
                               calls_: [{ model: "minicpm-v:8b", ts: at(0.55), ms: 500, prompt: 400, completion: 10 }] } });
            // A gated step: most of its block is a person deciding.
            post({ kind: "agent-step", id: hash, ts: at(0.05), save: false, session: { hash, turn: 2 },
                   step: 2, seq: 2, tool: "exec", toolMs: 300, approveMs: 2500, approval: "user",
                   arguments: { js: "1" }, result: "ok",
                   usage: { promptTokens: 120, completionTokens: 12, totalTokens: 132, genMs: 400 } });
        });
        await expect.poll(() => frame.locator(".rc-ev").count(), { timeout: 15000 }).toBeGreaterThan(2);

        // Every bar is INSIDE the plot's horizontal span — the lane mirrors the chart's segments, so a bar
        // that drifted off them would be pointing at a moment the trace doesn't cover.
        const frameOrigin = await page.evaluate(() => {
            const r = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-frame").getBoundingClientRect();
            return { x: r.x, y: r.y };
        });
        const inFrameX = frameOrigin.x, inFrameY = frameOrigin.y;
        // Measured on ONE side of the frame boundary: a locator's boundingBox is page-relative while a rect
        // read inside the frame is frame-relative, and mixing them compares two different origins.
        const geo = await frame.evaluate(() => {
            const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, w: b.width }; };
            return {
                plot: r(document.querySelector(".rc-plot")),
                bars: [...document.querySelectorAll(".rc-ev")].map(r),
            };
        });
        for (const b of geo.bars) {
            expect(b.x, "a bar starts left of the trace it annotates").toBeGreaterThanOrEqual(geo.plot.x - 1);
            expect(b.x + b.w, "…or runs past its right edge").toBeLessThanOrEqual(geo.plot.x + geo.plot.w + 1);
        }

        // A tool step is one block with hard stops where the work changes hands.
        const toolBar = frame.locator(".rc-ev-tool").first();
        const toolBg = await toolBar.evaluate((e) => getComputedStyle(e).backgroundImage);
        expect(toolBg).toContain("gradient");

        // A LOAD is time spent NOT generating, so it is striped rather than a solid block of the model's
        // time — but it is that model's wait, so it keeps the colour. (An inline model-colour once overrode
        // the striped class entirely, which is the exact confusion the stripes exist to prevent.)
        const loadBg = await frame.locator(".rc-ev-load").first().evaluate((e) => getComputedStyle(e).backgroundImage);
        expect(loadBg, "the load is striped").toContain("repeating-linear-gradient");
        expect(toolBg, "…and the tool block is not, so the two can't be confused").not.toContain("repeating-linear-gradient");

        // FREEZE the chart first. The panel keeps sampling, so the window slides and every bar moves left
        // underneath a stationary pointer — the hover then belongs to the bar that was entered while the
        // assertion reads whatever is under the cursor now, which is a race no amount of waiting fixes. A
        // drag-selected range pins the window (samples outside it are filtered out), so the geometry holds
        // still while this is measured.
        const plotBox = await frame.locator(".rc-plot").first().boundingBox();
        const midY = plotBox.y + plotBox.height / 2;
        await page.mouse.move(plotBox.x + plotBox.width * 0.02, midY);
        await page.mouse.down();
        await page.mouse.move(plotBox.x + plotBox.width * 0.98, midY, { steps: 6 });
        await page.mouse.up();
        await expect(frame.locator(".vram-zoom")).toBeVisible();
        await sleep(500);

        // Hovering the delegated reader lights its lineage and drops the rest back.
        const sub = frame.locator(".rc-ev-embed").first();
        expect(await sub.count()).toBe(1);
        const at = await sub.boundingBox();
        await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
        await sleep(200);
        // Read WHAT IS UNDER THE POINTER and every opacity in ONE evaluate. The chart keeps sampling, so the
        // lane re-packs and the bars slide left underneath a stationary cursor — measuring the two separately
        // let the pointer end up over a neighbour between the hover and the assertion, which is what failed
        // in CI (a dimmed sub-call) and never locally, where the timing differed.
        const shot = await frame.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            const bar = el?.closest?.(".rc-ev") ?? null;
            return {
                under: bar ? bar.className : String(el?.className || "none"),
                underOpacity: bar ? Number(getComputedStyle(bar).opacity) : null,
                all: [...document.querySelectorAll(".rc-ev")].map((e) => ({ cls: e.className, o: Number(getComputedStyle(e).opacity) })),
            };
        }, { x: at.x + at.width / 2 - inFrameX, y: at.y + at.height / 2 - inFrameY });

        expect(shot.all.some((d) => d.o < 0.3), "unrelated events drop back").toBe(true);
        // Whatever the pointer is actually over must be LIT — that is the invariant, and it holds however the
        // lane has re-packed by the time it is read.
        expect(shot.underOpacity, `the hovered bar stays lit (${shot.under})`).toBeGreaterThan(0.5);
        // …and when that bar is the sub-call, its parent step and the run are lit with it.
        if (/rc-ev-embed/.test(shot.under)) {
            const lit = shot.all.filter((d) => d.o > 0.5).map((d) => d.cls);
            expect(lit.some((c) => /rc-ev-tool/.test(c)), `the step that spawned it (${lit.join(" | ")})`).toBe(true);
            expect(lit.some((c) => /rc-ev-run/.test(c)), `and the run that contains it (${lit.join(" | ")})`).toBe(true);
        }

        // And clicking it opens the step that produced it.
        await sub.click();
        await sleep(600);
        expect(await frame.locator(".astep, [data-astep-seq]").count(), "it navigated into the run").toBeGreaterThan(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Drag across a plot to select a time range, Grafana-style. Two things only a real browser can check: that
// the selection is MIRRORED into every track while it is being drawn (the ranges only mean anything compared
// across pools), and that the drag maps back to the right stretch of TIME through a segmented axis.
test("resource panel: drag selects a range, mirrored across every track, Esc leaves it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        await seedStacked(ext);   // three tracks, so mirroring has something to mirror into
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(3);
        await sleep(9000);   // a window worth selecting inside

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        const y = plot.y + plot.height / 2;
        await page.mouse.move(plot.x + plot.width * 0.3, y);
        await page.mouse.down();
        await page.mouse.move(plot.x + plot.width * 0.6, y, { steps: 8 });
        await sleep(200);

        // MID-DRAG: every track shows the same selection, not just the one under the pointer.
        const mid = await frame.locator(".rc-brush").evaluateAll((els) => els.map((e) => {
            const r = e.getBoundingClientRect(); const p = e.parentElement.getBoundingClientRect();
            return { from: (r.x - p.x) / p.width, w: r.width / p.width };
        }));
        expect(mid.length, "the selection is drawn in every track").toBe(3);
        for (const m of mid) {
            expect(Math.abs(m.from - 0.3), `mirrored at the same place (${JSON.stringify(mid)})`).toBeLessThan(0.03);
            expect(Math.abs(m.w - 0.3), "…and the same width").toBeLessThan(0.03);
        }

        await page.mouse.up();
        await sleep(400);
        // Released: the brush is gone and the panel is showing the selected stretch instead of the rolling
        // window, with a way out.
        expect(await frame.locator(".rc-brush").count()).toBe(0);
        const chip = frame.locator(".vram-zoom");
        await expect(chip).toBeVisible();
        // The range is the ~30% of the window that was dragged over, not the whole thing.
        expect(await chip.textContent()).toMatch(/\d+s|\dm/);

        // Esc goes back to live — a zoom you cannot leave is a trap.
        await page.keyboard.press("Escape");
        await sleep(300);
        expect(await frame.locator(".vram-zoom").count()).toBe(0);

        // And a plain CLICK is not a selection: without that guard every click on the chart zooms to an instant.
        await page.mouse.click(plot.x + plot.width * 0.5, y);
        await sleep(300);
        expect(await frame.locator(".vram-zoom").count()).toBe(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Grafana's crosshair: hovering any plot draws a line in EVERY track at the same instant, labelled with the
// time. Reading one pool against another at a given moment is the whole reason these are small multiples,
// and doing it by eye across three plots is exactly what a shared line removes.
test("resource panel: the crosshair is mirrored across tracks and names the instant", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(3);
        await sleep(7000);

        // Park the pointer off the chart first: opening the panel leaves it wherever the last click was, which
        // may well be over a plot.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        const head0 = await frame.locator(".vram-head").boundingBox();
        await page.mouse.move(head0.x + head0.width / 2, head0.y + head0.height / 2);
        await sleep(250);
        expect(await frame.locator(".rc-cross").count(), "nothing until you hover").toBe(0);
        await page.mouse.move(plot.x + plot.width * 0.4, plot.y + plot.height / 2);
        await sleep(250);

        const lines = await frame.locator(".rc-cross").evaluateAll((els) => els.map((e) => {
            const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
            return { frac: (r.x - p.x) / p.width, label: e.textContent.trim() };
        }));
        expect(lines.length, "one line per track").toBe(3);
        for (const l of lines) expect(Math.abs(l.frac - 0.4), "at the same instant in each").toBeLessThan(0.03);
        // The time is the point: a line with no label says where, not when. Milliseconds appear only when a
        // pixel is worth a few of them — this window is seconds wide, so they do (clockAt).
        for (const l of lines) expect(l.label, `labelled (${JSON.stringify(lines)})`).toMatch(/^\d{2}:\d{2}:\d{2}(\.\d{3})?$/);
        // And they all name the SAME instant — three plots disagreeing about the moment would be worse than none.
        expect(new Set(lines.map((l) => l.label)).size).toBe(1);

        // It follows the pointer, and leaves with it.
        await page.mouse.move(plot.x + plot.width * 0.8, plot.y + plot.height / 2);
        await sleep(250);
        const moved = await frame.locator(".rc-cross").first().evaluate((e) => {
            const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
            return (r.x - p.x) / p.width;
        });
        expect(Math.abs(moved - 0.8)).toBeLessThan(0.03);
        // Off the chart entirely — onto the panel header, which is inside the same frame.
        const head = await frame.locator(".vram-head").boundingBox();
        await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
        await sleep(300);
        expect(await frame.locator(".rc-cross").count(), "the line leaves with the pointer").toBe(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Bars in the same lane row must never overlap: two bars on one line read as a single longer one, which is a
// false statement about what happened. Packing reserves the width a bar is DRAWN at (short events are widened
// to stay visible), and this is the check that the reserved width and the drawn width actually agree — in a
// real browser, where the pixels are real.
test("resource panel: no two lane bars overlap on the same row", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // The lane is SCOPED to the open session by default, and this test posts events without opening
        // one, so it asks for the all-sessions view the toggle offers. Tests that read the default are
        // the scoping ones below.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);

        // Deliberately adversarial: sub-calls that OVERLAP each other, sub-calls that merely touch, and a
        // couple of instant-length ones — the case where the widening for visibility creates the overlap.
        await page.evaluate(() => {
            const now = Date.now(), span = 8000, t0 = now - span;
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            const hash = "overlap";
            post({ kind: "agent", id: hash, ts: t0, save: false, session: { hash, turn: 0 },
                   task: "t", model: "gemma4:31b", maxSteps: 4, config: null });
            const ts1 = t0 + 4000;
            post({ kind: "agent-step", id: hash, ts: ts1, save: false, session: { hash, turn: 1 },
                   step: 1, seq: 1, tool: "python_exec", toolMs: 2500,
                   usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, genMs: 500 },
                   subUsage: { calls: 4, prompt: 40, completion: 8,
                               byModel: [{ model: "minicpm-v:8b", prompt: 40, completion: 8, calls: 4 }],
                               calls_: [
                                   { model: "minicpm-v:8b", ts: ts1 - 1800, ms: 900, prompt: 10, completion: 2 },  // overlaps the next
                                   { model: "minicpm-v:8b", ts: ts1 - 1200, ms: 800, prompt: 10, completion: 2 },
                                   { model: "minicpm-v:8b", ts: ts1 - 300, ms: 5, prompt: 10, completion: 2 },     // an instant…
                                   { model: "minicpm-v:8b", ts: ts1 - 260, ms: 5, prompt: 10, completion: 2 },     // …right beside another
                               ] } });
            post({ kind: "agent-step", id: hash, ts: t0 + 7500, save: false, session: { hash, turn: 2 },
                   step: 2, seq: 2, tool: "exec", toolMs: 100, approveMs: 900,
                   usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, genMs: 200 } });
        });
        await expect.poll(() => frame.locator(".rc-ev").count(), { timeout: 15000 }).toBeGreaterThan(4);

        const rows = await frame.evaluate(() => [...document.querySelectorAll(".rc-lane-row")].map((row) =>
            [...row.querySelectorAll(".rc-ev")].map((e) => {
                const r = e.getBoundingClientRect();
                return { cls: e.className.replace("rc-ev ", ""), x: Math.round(r.x), right: Math.round(r.right) };
            }).sort((a, b) => a.x - b.x)));

        const clashes = [];
        rows.forEach((row, i) => {
            for (let k = 1; k < row.length; k++) {
                // Not just overlap: bars that merely TOUCH read as one bar with a seam, which is the same
                // misreading arrived at differently. A hair of daylight is required.
                const gap = row[k].x - row[k - 1].right;
                if (gap < 1) clashes.push(`row ${i}: ${row[k - 1].cls} [${row[k - 1].x}..${row[k - 1].right}] ${gap < 0 ? "overlaps" : "touches"} ${row[k].cls} [${row[k].x}..${row[k].right}]`);
            }
        });
        // Capture what it looked like, so a failure is a picture and not just numbers.
        await frame.locator(".vram").screenshot({ path: "tests/e2e/artifacts/lane-overlap.png" }).catch(() => {});
        expect(clashes, clashes.join("\n")).toEqual([]);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The scrub strip's round trip, which needs a session long enough that "dragged back" is genuinely not "at
// the tail" — in a few seconds of history every position is within one poll of live (TAIL_SLACK_MS), so this
// only means anything here.
test("resource panel: scrubbing back unpins live, and the live button returns", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        // A short window, so the session outgrows it quickly.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 4 }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        // Long enough that the far end of the strip is well outside the tail slack.
        await expect.poll(() => frame.locator(".rc-scrub").count(), { timeout: 30000 }).toBe(1);
        await sleep(14000);

        const live = frame.locator(".rc-scrub-live");
        await expect(live).toHaveText(/▶\s*live/);
        const before = await frame.locator(".rc-scrub-win").evaluate((e) => e.style.left);

        // Drag the window box to the start of the session.
        const track = await frame.locator(".rc-scrub-track").boundingBox();
        const y = track.y + track.height / 2;
        await page.mouse.move(track.x + track.width * 0.9, y);
        await page.mouse.down();
        await page.mouse.move(track.x + 2, y, { steps: 8 });
        await page.mouse.up();
        await sleep(600);

        // It stopped following: the button now offers the way back, and the panel says it is holding a range.
        await expect(live).toHaveText(/⏸/);
        await expect(frame.locator(".vram-zoom")).toBeVisible();
        expect(await frame.locator(".rc-scrub-win").evaluate((e) => e.style.left)).not.toBe(before);
        // The chart is showing that earlier stretch, not the newest samples.
        const shown = await frame.locator(".rc-seg").count();
        expect(shown, "the chart still draws the scrubbed-to window").toBeGreaterThan(0);

        // And back to live — a view that has silently stopped following is the failure this prevents.
        await live.click();
        await sleep(600);
        await expect(live).toHaveText(/▶\s*live/);
        expect(await frame.locator(".vram-zoom").count()).toBe(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Three panel behaviours that only exist once there is layout and a real input device: a wheel over a fixed
// header region, a double-click that reframes the window, and a section toggle that changes what is drawn.
test("resource panel: wheel scrolls through, double-click scopes, and the sections hide", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // The lane is SCOPED to the open session by default, and this test posts events without opening
        // one, so it asks for the all-sessions view the toggle offers. Tests that read the default are
        // the scoping ones below.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        // A short rolling window, so the session outgrows it and the scrub strip (and its connector to the
        // lane) actually exist — with the default window covering everything there is no strip, and the
        // assertions about it would pass by describing nothing.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 4 }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await expect.poll(() => frame.locator(".rc-scrub").count(), { timeout: 30000 }).toBe(1);
        await sleep(9000);

        // A run long enough to have somewhere to scroll to, and a load in front of a step so the abutting
        // case the packing was getting wrong is actually present.
        await page.evaluate(() => {
            const now = Date.now(), span = 7000;
            const at = (f) => now - Math.round(span * f);
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            const hash = "e2e-scope";
            post({ kind: "agent", id: hash, ts: at(1), save: false, session: { hash, turn: 0 },
                   task: "a long run", model: "gemma4:31b", maxSteps: 20, config: null });
            for (let i = 1; i <= 12; i++) {
                post({ kind: "agent-step", id: hash, ts: at(0.9 - i * 0.07), save: false, session: { hash, turn: i },
                       step: i, seq: i, tool: "exec", toolMs: 200, arguments: { js: `step ${i}` },
                       result: `line\n`.repeat(40),
                       usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, genMs: 300,
                                ...(i % 3 === 0 ? { loadMs: 1500 } : {}) } });
            }
        });
        await expect.poll(() => frame.locator(".rc-ev").count(), { timeout: 15000 }).toBeGreaterThan(4);
        await frame.locator(".rc-ev.linked").first().click();
        // Enough transcript to actually have somewhere to scroll to — asserted rather than assumed, since a
        // wheel test against a view that already fits would pass by doing nothing.
        await expect.poll(() => frame.evaluate(() => {
            const v = document.querySelector(".view");
            return v ? v.scrollHeight - v.clientHeight : 0;
        }), { timeout: 10000 }).toBeGreaterThan(120);

        // ---- the wheel goes THROUGH the panel to the transcript underneath it ----
        // The panel is a fixed-height sibling of the scroll container, so the pointer resting on the chart
        // used to mean the gesture did nothing at all.
        await frame.evaluate(() => { document.querySelector(".view").scrollTop = 0; });
        // Over the panel's HEADER, not its middle: the middle is the chart, and once there is a window to
        // move the chart claims the wheel for scrubbing (which the scrubber test covers). This is about the
        // rest of the panel still passing the gesture through to the transcript.
        const headBox = await frame.locator(".vram-head").boundingBox();
        await page.mouse.move(headBox.x + headBox.width / 2, headBox.y + headBox.height / 2);
        await page.mouse.wheel(0, 500);
        await expect.poll(() => frame.evaluate(() => document.querySelector(".view").scrollTop), { timeout: 5000 })
            .toBeGreaterThan(0);
        // …and back the other way, so it is a scroll and not a one-directional nudge.
        await page.mouse.wheel(0, -500);
        await expect.poll(() => frame.evaluate(() => document.querySelector(".view").scrollTop), { timeout: 5000 })
            .toBeLessThan(40);

        // ---- double-click scopes the window to that block ----
        expect(await frame.locator(".vram-zoom").count(), "nothing scoped yet").toBe(0);
        await frame.locator(".rc-ev-tool").first().dblclick();
        await expect(frame.locator(".vram-zoom")).toBeVisible();
        // The window is necessarily WIDER than a short block (it needs samples in it to draw at all), so the
        // block says which one you landed on rather than leaving the answer as "somewhere in here".
        await expect.poll(() => frame.locator(".rc-ev.pulse").count(), { timeout: 5000 }).toBeGreaterThan(0);
        // And the strip's window is joined to the lane, so the magnification between the two is visible
        // instead of reading as two charts disagreeing.
        await expect.poll(() => frame.locator(".rc-zoomlink path").count(), { timeout: 5000 }).toBe(2);
        // It scoped to the BLOCK, not to some default window: a single step is seconds, and the chip names
        // the span it framed.
        const span = await frame.locator(".vram-zoom").innerText();
        expect(span, `chip read "${span}"`).toMatch(/^\d+s/);
        await frame.locator(".vram-zoom").click();
        await expect.poll(() => frame.locator(".vram-zoom").count()).toBe(0);

        // ---- a run block is drawn as a container, not as the heaviest work in the lane ----
        // HEIGHT is what says so: the top row is always a run wrapper, so a half-height bar reads as the span
        // everything below happens within, where a full-height one read as the biggest piece of work.
        const runH = await frame.locator(".rc-ev-run").first().evaluate((e) => e.getBoundingClientRect().height);
        const toolH = await frame.locator(".rc-ev-tool").first().evaluate((e) => e.getBoundingClientRect().height);
        expect(runH, "the run bar is shorter than a step's").toBeLessThan(toolH * 0.75);
        expect(runH, "…but still drawn").toBeGreaterThan(1);

        // ---- both sections hide, and come back ----
        await frame.locator('[aria-label="Edit tracks"]').click();
        const lane = frame.locator('.rc-esections label', { hasText: "event lane" }).locator("input");
        const list = frame.locator('.rc-esections label', { hasText: "model list" }).locator("input");
        expect(await frame.locator(".rc-zoomlink").count(), "the connector is drawn while the lane is").toBe(1);
        await lane.uncheck();
        // THE WHOLE SECTION GOES, header included. The checkbox and the disclosure's chevron used to drive
        // one signal between them, so unchecking merely collapsed the section and left its `events …` header
        // sitting there — a setting that visibly does nothing. They are separate now: this is the ENABLE, the
        // chevron is the fold, and the way back is the checkbox you just used.
        await expect.poll(() => frame.locator(".rc-lane-row").count()).toBe(0);
        expect(await frame.locator(".disc-head").filter({ hasText: "events" }).count(),
            "…and nothing of it is left behind").toBe(0);
        expect(await frame.locator(".rc-track").count(), "the chart stays").toBeGreaterThan(0);
        // The connector joins the scrub window to the LANE, so with the lane hidden it points into empty
        // space — lines to nothing are worse than no lines.
        expect(await frame.locator(".rc-zoomlink").count(), "the connector goes with it").toBe(0);
        await list.uncheck();
        await expect.poll(() => frame.locator(".vram-row").count()).toBe(0);
        // …and turning it back on restores the section AS IT WAS — open, because the fold it had was never
        // touched by the switch.
        await lane.check();
        await expect.poll(() => frame.locator(".rc-lane-row").count()).toBeGreaterThan(0);
        await expect.poll(() => frame.locator(".rc-zoomlink").count(), { timeout: 5000 }).toBe(1);
        await list.check();
        await expect.poll(() => frame.locator(".vram-row").count()).toBeGreaterThan(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The scrub window's two gestures. Only meaningful with layout and a real pointer: the difference between
// them is WHERE the drag started relative to a box whose position is computed at render time.
test("resource panel: the scrubber resizes from its edges and pans from its middle", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        // A short rolling window, so the session outgrows it and the strip appears.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 4 }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-scrub").count(), { timeout: 30000 }).toBe(1);
        await sleep(14000);

        // Read the window as PERCENTAGES off its own style, the way the sibling scrub test does: the box is a
        // few pixels tall and a boundingBox on it is not a stable measurement.
        const pct = (v) => parseFloat(v);
        const winAt = async () => frame.locator(".rc-scrub-win").evaluate((e) => ({ left: e.style.left, width: e.style.width }));
        const track = await frame.locator(".rc-scrub-track").boundingBox();
        const y = track.y + track.height / 2;
        const xOf = (p) => track.x + track.width * (p / 100);
        const dragFromTo = async (fromPct, toPct) => {
            await page.mouse.move(xOf(fromPct), y);
            await page.mouse.down();
            await page.mouse.move(xOf(toPct), y, { steps: 10 });
            await page.mouse.up();
            await sleep(400);
        };

        // Park it WELL away from the tail first. Not just "away": a drop within TAIL_SLACK_MS of the end is
        // read as rejoining live, which is correct behaviour and a different gesture from the one under test
        // — and on a session this short three seconds is a big slice of the strip, so the widen below has to
        // land with room to spare or it measures the re-anchor to `now` instead of the resize.
        const w0 = await winAt();
        await dragFromTo(pct(w0.left) + pct(w0.width) / 2, 28);
        const before = await winAt();
        expect(pct(before.width), "a window narrower than the strip").toBeLessThan(60);

        // The header GAINS a control when you scrub (the zoom chip), and the panel's header must hold its
        // height when it does — everything below it, including the strip you are still dragging, moves
        // otherwise. It really did: adding one control to that row made the chip's arrival push the strip
        // 12px down, so every later drag in this test landed above the track and silently did nothing.
        const after = await frame.locator(".rc-scrub-track").boundingBox();
        expect(Math.abs(after.y - track.y), "the strip did not move when the header gained a control").toBeLessThan(4);

        // ---- the RIGHT EDGE widens it, and the left edge stays put ----
        // "Held" is measured against the window's OWN width, not an absolute slice of the strip: how many
        // percent a pixel is worth depends on how long the session has grown, so a fixed tolerance is really
        // a bet on the machine's speed. A tenth of the window is the same claim either way.
        //
        // AND THE FLOOR IS A POLL, not zero. These are percentages of a session that KEEPS GROWING while the
        // drag happens, so the untouched edge genuinely drifts a few percent between the two readings — a
        // poll's worth of new samples stretches the denominator under it. The claim being made is "this edge
        // did not move the way the other one did" (the dragged edge moves 20%+), which is the claim the
        // gesture is about; "did not move at all" is not expressible in a coordinate system that is itself
        // moving.
        const held = (w) => Math.max(9, pct(w) * 0.12);
        const rightEdge = pct(before.left) + pct(before.width);
        await dragFromTo(rightEdge, Math.min(62, rightEdge + 20));
        const widened = await winAt();
        expect(pct(widened.width), "the window got wider").toBeGreaterThan(pct(before.width) + 5);
        expect(Math.abs(pct(widened.left) - pct(before.left)), "…and the far edge did not move")
            .toBeLessThan(held(widened.width));

        // ---- the LEFT EDGE narrows it, and the RIGHT edge stays put ----
        const rightBefore = pct(widened.left) + pct(widened.width);
        await dragFromTo(pct(widened.left), pct(widened.left) + 15);
        const narrowed = await winAt();
        expect(pct(narrowed.width), "the window got narrower").toBeLessThan(pct(widened.width) - 5);
        expect(Math.abs((pct(narrowed.left) + pct(narrowed.width)) - rightBefore), "…and this time the RIGHT edge held")
            .toBeLessThan(held(widened.width));

        // ---- the MIDDLE moves it without changing its width ----
        const mid = pct(narrowed.left) + pct(narrowed.width) / 2;
        await dragFromTo(mid, Math.max(pct(narrowed.width) / 2 + 1, mid - 20));
        const panned = await winAt();
        expect(Math.abs(pct(panned.width) - pct(narrowed.width)), "a pan does not resize").toBeLessThan(held(narrowed.width));
        expect(pct(panned.left), "…it moved").toBeLessThan(pct(narrowed.left) - 3);

        // ---- and a wheel over the CHART scrubs, rather than scrolling the page ----
        const scrolled = await frame.evaluate(() => document.querySelector(".view")?.scrollTop ?? 0);
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        const overPlot = async () => page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
        await overPlot();
        await page.mouse.wheel(0, 120);
        await sleep(400);
        const nudged = await winAt();
        expect(pct(nudged.left), "the window moved along the session").toBeGreaterThan(pct(panned.left) + 1);
        expect(Math.abs(pct(nudged.width) - pct(panned.width)), "…without resizing").toBeLessThan(3);
        expect(await frame.evaluate(() => document.querySelector(".view")?.scrollTop ?? 0),
            "and the transcript underneath did NOT scroll — the chart claimed the gesture").toBe(scrolled);
        // Measured from a FIXED starting position each time. The window clamps against the end of the
        // session, so comparing two gestures made from wherever the previous one left off compares one free
        // movement against one that ran out of room.
        const park = async () => {
            const w = await winAt();
            await dragFromTo(pct(w.left) + pct(w.width) / 2, 35);
            return pct((await winAt()).left);
        };
        const travelled = async (dx, dy, notches = 1) => {
            const from = await park();
            for (let i = 0; i < notches; i++) { await overPlot(); await page.mouse.wheel(dx, dy); await sleep(120); }
            await sleep(300);
            return pct((await winAt()).left) - from;
        };

        const vertical = await travelled(0, 120);
        expect(vertical, "a vertical wheel scrubs forward").toBeGreaterThan(1);

        // A HORIZONTAL swipe scrubs too, and by the same distance. Reading only deltaY meant a trackpad's
        // horizontal gesture did nothing except through whatever vertical jitter it happened to carry.
        const horizontal = await travelled(120, 0);
        expect(Math.abs(horizontal - vertical), "…and a horizontal one goes exactly as far")
            .toBeLessThan(Math.max(1, vertical * 0.35));

        // PROPORTIONAL: four small notches travel the same distance as one big one. A fixed step per event
        // is what made the same physical swipe move wildly different distances depending on how the hardware
        // chose to quantise it.
        const inFour = await travelled(0, 30, 4);
        expect(Math.abs(inFour - vertical), "4x30 goes as far as 1x120")
            .toBeLessThan(Math.max(1, vertical * 0.35));

        // Back the other way, so it is a scrub and not a one-directional ratchet.
        expect(await travelled(0, -120), "and it goes backwards").toBeLessThan(-1);

        // ---- and the same gesture over the STRIP pans it, never resizes it ----
        // A wheel has no way to say which edge it meant, so resizing stays a deliberate grab on a handle.
        const parked = await park();
        const parkedW = pct((await winAt()).width);
        await page.mouse.move(track.x + track.width / 2, y);
        await page.mouse.wheel(120, 0);
        await sleep(400);
        const strip = await winAt();
        expect(pct(strip.left), "the strip scrolls the window along").toBeGreaterThan(parked + 1);
        expect(Math.abs(pct(strip.width) - parkedW), "…without resizing it").toBeLessThan(3);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The lane and the transcript are two views of the same run, so a hover in one should pick out the other.
// And "click to open this step" has to actually open it: landing on a collapsed row that merely pulses shows
// you WHERE it is and not WHAT it was, which is the thing you clicked for.
test("resource panel: hovering a lane block dims the rest of the log, and clicking opens the step", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // The lane is SCOPED to the open session by default, and this test posts events without opening
        // one, so it asks for the all-sessions view the toggle offers. Tests that read the default are
        // the scoping ones below.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);

        await page.evaluate(() => {
            const now = Date.now(), span = 7000;
            const at = (f) => now - Math.round(span * f);
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            const hash = "e2e-focus";
            post({ kind: "agent", id: hash, ts: at(1), save: false, session: { hash, turn: 0 },
                   task: "three steps", model: "gemma4:31b", maxSteps: 6, config: null });
            for (let i = 1; i <= 3; i++) {
                post({ kind: "agent-step", id: hash, ts: at(0.8 - i * 0.2), save: false, session: { hash, turn: i },
                       step: i, seq: i, tool: "exec", toolMs: 400, arguments: { js: `step ${i}` },
                       result: `result of step ${i}`,
                       usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, genMs: 300 } });
            }
        });
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 15000 }).toBeGreaterThanOrEqual(3);
        // Into the run's own transcript, so the lane and the log are both on screen.
        await frame.locator(".rc-ev-tool").first().click();
        await expect.poll(() => frame.locator(".astep").count(), { timeout: 10000 }).toBeGreaterThanOrEqual(3);
        // The click left the pointer ON the bar, which is itself a hover — move off before asserting the
        // resting state, or this measures the very thing the next step is about to test. Off the LANE
        // specifically (its pointerleave is what clears the focus), so aim below the whole panel.
        const panelBox = await frame.locator(".vram").boundingBox();
        await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height + 60);
        await expect.poll(() => frame.locator(".astep.away").count(), { timeout: 5000 }).toBe(0);

        // ---- hovering one block dims the steps outside its lineage ----
        const bar = await frame.locator(".rc-ev-tool").first().boundingBox();
        await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
        await expect.poll(() => frame.locator(".astep.away").count(), { timeout: 5000 }).toBeGreaterThan(0);
        const total = await frame.locator(".astep").count();
        expect(await frame.locator(".astep.away").count(), "…but not ALL of them — one is the step it points at")
            .toBeLessThan(total);

        // Moving off the lane puts every step back, rather than leaving the log stuck dim.
        await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height + 60);
        await expect.poll(() => frame.locator(".astep.away").count(), { timeout: 5000 }).toBe(0);

        // ---- clicking OPENS the step it points at, not just highlights it ----
        // Collapse everything first, so an already-open row cannot pass this by accident.
        const heads = frame.locator(".astep.open .astep-head");
        for (let i = await heads.count(); i > 0; i--) await heads.first().click().catch(() => {});
        await expect.poll(() => frame.locator(".astep.open").count(), { timeout: 5000 }).toBe(0);

        await frame.locator(".rc-ev-tool").first().click();
        await expect.poll(() => frame.locator(".astep.open").count(), { timeout: 8000 }).toBeGreaterThan(0);
        // It STAYS open after the reveal auto-clears — a step that shuts again a second later is worse than
        // one that never opened, because you saw it and then lost it.
        await sleep(2500);
        expect(await frame.locator(".astep.open").count(), "still open once the pulse has passed").toBeGreaterThan(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Hiding a model takes it out of the totals and the bands. Leaving its lane blocks and its strip ticks
// behind left the panel saying two different things about one model at once.
test("resource panel: hiding a model hides its events too, and unhiding brings them back", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // The lane is SCOPED to the open session by default, and this test posts events without opening
        // one, so it asks for the all-sessions view the toggle offers. Tests that read the default are
        // the scoping ones below.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);

        await page.evaluate(() => {
            const now = Date.now(), span = 7000;
            const at = (f) => now - Math.round(span * f);
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            const hash = "e2e-hide";
            post({ kind: "agent", id: hash, ts: at(1), save: false, session: { hash, turn: 0 },
                   task: "two steps", model: "gemma4:31b", maxSteps: 4, config: null });
            for (let i = 1; i <= 2; i++) {
                post({ kind: "agent-step", id: hash, ts: at(0.7 - i * 0.25), save: false, session: { hash, turn: i },
                       step: i, seq: i, tool: "exec", toolMs: 400, arguments: { js: `s${i}` }, result: "ok",
                       usage: { promptTokens: 80, completionTokens: 10, totalTokens: 90, genMs: 300 } });
            }
        });
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 15000 }).toBeGreaterThan(0);
        const bars = await frame.locator(".rc-ev-tool").count();
        const ticks = await frame.locator(".rc-scrub-ev").count();

        // The dot on the model's row is the hide toggle.
        await frame.locator('.vram-row', { hasText: "gemma4:31b" }).locator(".vram-dot").click();
        await expect.poll(() => frame.locator(".vram-row.off").count(), { timeout: 5000 }).toBeGreaterThan(0);
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 5000 }).toBe(0);
        if (ticks) await expect.poll(() => frame.locator(".rc-scrub-ev").count(), { timeout: 5000 }).toBe(0);

        // …and it comes back, rather than being dropped for the session.
        await frame.locator('.vram-row', { hasText: "gemma4:31b" }).locator(".vram-dot").click();
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 5000 }).toBe(bars);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// Scrolling to the end must REJOIN live, not park a pinned window that happens to sit at the end. The drag
// path has always unpinned on release; the wheel paths did not, so scrolling to the end looked like rejoining
// live and then silently fell behind as new samples arrived — with the button still reading live, because
// that is computed from where the window sits rather than from whether it is following.
test("resource panel: scrolling the window to the end sticks to live, and stays stuck", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 4 }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-scrub").count(), { timeout: 30000 }).toBe(1);
        await sleep(12000);

        // Scrub BACK first, so there is a pinned range to leave.
        const track = await frame.locator(".rc-scrub-track").boundingBox();
        const y = track.y + track.height / 2;
        await page.mouse.move(track.x + track.width * 0.9, y);
        await page.mouse.down();
        await page.mouse.move(track.x + 2, y, { steps: 8 });
        await page.mouse.up();
        await expect(frame.locator(".vram-zoom")).toBeVisible();
        await expect(frame.locator(".rc-scrub-live")).toHaveText(/⏸\s*live/);

        // Now WHEEL forward to the end. Several notches, because one is a fraction of the window's width.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        for (let i = 0; i < 25; i++) {
            if (!(await frame.locator(".vram-zoom").count())) break;
            await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
            await page.mouse.wheel(0, 200);
            await sleep(120);
        }
        // Reaching the end IS rejoining live: no pinned range left behind.
        await expect.poll(() => frame.locator(".vram-zoom").count(), { timeout: 5000 }).toBe(0);
        await expect(frame.locator(".rc-scrub-live")).toHaveText(/▶\s*live/);

        // …and it STAYS live as new samples arrive. This is the half that failed: a window pinned at the tail
        // reads as live for one moment and then falls behind, because nothing moves it forward.
        await sleep(6000);
        expect(await frame.locator(".vram-zoom").count(), "still following, not pinned at where the end was").toBe(0);
        await expect(frame.locator(".rc-scrub-live")).toHaveText(/▶\s*live/);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// The log belongs to ONE session. A hovered block from ANOTHER run shares no step with it, so "dim everything
// outside the lineage" was the whole transcript — hovering run B greyed out run A's log entirely.
test("resource panel: hovering another session's block leaves the open session's log alone", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        // Both sessions' events, or there is nothing from the other run to hover.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);

        await page.evaluate(() => {
            const now = Date.now(), span = 7000;
            const at = (f) => now - Math.round(span * f);
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            for (const [hash, model, off] of [["sess-a", "gemma4:31b", 0], ["sess-b", "qwen3.5:35b", 0.35]]) {
                post({ kind: "agent", id: hash, ts: at(0.95 - off), save: false, session: { hash, turn: 0 },
                       task: `task ${hash}`, model, maxSteps: 4, config: null });
                for (let i = 1; i <= 2; i++) {
                    post({ kind: "agent-step", id: hash, ts: at(0.8 - off - i * 0.15), save: false,
                           session: { hash, turn: i }, step: i, seq: i, tool: "exec", toolMs: 300,
                           arguments: { js: `s${i}` }, result: "ok",
                           usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, genMs: 250 } });
                }
            }
        });
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 15000 }).toBeGreaterThanOrEqual(4);

        // Open session A.
        await frame.locator('.row', { hasText: "task sess-a" }).first().click();
        await expect.poll(() => frame.locator(".astep").count(), { timeout: 10000 }).toBeGreaterThan(0);

        // Hovering a bar belonging to the OTHER session must not touch this log.
        const other = frame.locator(".rc-ev").filter({ hasNot: frame.locator("nothing") });
        const bars = await frame.locator(".rc-ev-tool").all();
        const boxes = [];
        for (const b of bars) boxes.push({ b, box: await b.boundingBox() });
        // The rightmost tool bars belong to sess-b (it starts later).
        const foreign = boxes.sort((x, y) => y.box.x - x.box.x)[0];
        await page.mouse.move(foreign.box.x + foreign.box.width / 2, foreign.box.y + foreign.box.height / 2);
        await sleep(400);
        expect(await frame.locator(".astep.away").count(),
            "another session's block must not dim this session's steps").toBe(0);
        expect(await frame.evaluate(() => document.documentElement.hasAttribute("data-lane-focus")),
            "…nor its messages").toBe(false);
        void other;

        // A bar of THIS session still focuses the log — the feature is intact, only its scope is fixed.
        const own = boxes.sort((x, y) => x.box.x - y.box.x)[0];
        await page.mouse.move(own.box.x + own.box.width / 2, own.box.y + own.box.height / 2);
        await expect.poll(() => frame.evaluate(() => document.documentElement.hasAttribute("data-lane-focus")),
            { timeout: 5000 }).toBe(true);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// `ml.embed()` reports through the chat events — a model call is a model call, and reusing the machinery
// costs no new event kind — but it is NOT a conversation, and every surface that presents it as one is
// claiming something that never happened. The session is the invocation; the calls are its history.
test("resource panel: an ml.embed() session is never presented as a chat", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);

        await page.evaluate(() => {
            const now = Date.now();
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            const hash = "e2e-embed";
            post({ kind: "chat", id: "c1", ts: now - 6000, save: false, session: { hash, turn: 0 },
                   streaming: false, sessionKind: "embed", config: null,
                   request: { model: "nomic-embed-text", extend: null,
                              messages: [{ role: "user", content: "embed 24 inputs" }],
                              images: null, toolIds: null, schema: false, think: null, maxTokens: null } });
            post({ kind: "chat-result", id: "c1", ts: now - 5000, save: false, session: { hash, turn: 0 },
                   content: "24 vectors · 1024 dimensions", sources: null, structured: false,
                   model: "nomic-embed-text", extend: null, reasoning: null,
                   usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, genMs: 1000 } });
        });

        // The LIST names it by what was invoked, and badges it as an embed rather than a generic session.
        const row = frame.locator(".row", { hasText: "ml.embed()" });
        await expect.poll(() => row.count(), { timeout: 10000 }).toBe(1);
        expect(await row.locator(".embed-badge").count(), "badged as an embed, not left generic").toBe(1);
        expect(await row.innerText(), "the title is the invocation, not a call's description")
            .not.toContain("embed 24 inputs");

        // The LANE counts it as a session, never a run, and draws its container hollow.
        expect(await frame.locator(".rc-lane-chip", { hasText: /^sessions/ }).count()).toBe(1);
        expect(await frame.locator(".rc-ev-session").count(), "a container, not a run bar").toBeGreaterThan(0);

        // And OPENING it shows CALLS, not a conversation — this used to blank the view entirely.
        await row.click();
        await expect.poll(() => frame.locator(".embed-call").count(), { timeout: 10000 }).toBe(1);
        expect(await frame.locator(".msg.user, .msg.asst").count(), "no chat bubbles anywhere").toBe(0);
        const call = await frame.locator(".embed-call").innerText();
        expect(call).toContain("embed 24 inputs");
        expect(call).toContain("24 vectors");
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// THE FULL ROUND TRIP, which is where this actually broke: stretch the window wider than the preset, pin it,
// narrow it, then drag it back to the right edge to rejoin live — and it grew again. Rejoining live restored
// whatever `resWindowS` was last set to rather than the width on screen, so the width you had just chosen was
// discarded the moment you arrived. The unit tests pin `scrubIntent`; only a real browser exercises the drag,
// the signal, and the storage write as one gesture.
test("resource panel: the width you drag is the width live keeps", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 4 }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await expect.poll(() => frame.locator(".rc-scrub").count(), { timeout: 30000 }).toBe(1);
        await sleep(14000);   // enough history that the far end is well outside the tail slack

        const track = await frame.locator(".rc-scrub-track").boundingBox();
        const y = track.y + track.height / 2;
        const winW = () => frame.locator(".rc-scrub-win").evaluate((e) => parseFloat(e.style.width));
        const windowS = () => ext.sw.evaluate(() => new Promise((r) =>
            chrome.storage.local.get({ ml_res_window: 0 }, (d) => r(d.ml_res_window))));
        // Fixed sleeps are not enough on a slow runner: this passed locally and failed in CI, where the
        // panel re-renders behind the drag. Each step settles by POLLING for the thing it changed.
        const dragFrom = async (fromX, toX) => {
            await page.mouse.move(fromX, y);
            await page.mouse.down();
            await page.mouse.move(toX, y, { steps: 10 });
            await page.mouse.up();
            await sleep(900);
        };
        const liveText = () => frame.locator(".rc-scrub-live").textContent();

        // 1. STRETCH the left edge well past the 4s preset, while still following.
        const box0 = await frame.locator(".rc-scrub-win").boundingBox();
        // Not all the way to the left edge: a window that covers nearly the whole strip cannot then be
        // PANNED off the tail (it clamps), and step 2 needs it genuinely pinned.
        await dragFrom(box0.x + 2, track.x + track.width * 0.45);
        const wide = await winW();
        expect(wide, "the window stretched").toBeGreaterThan(40);
        await expect.poll(liveText, { timeout: 10000 }).toMatch(/▶\s*live/);
        await expect.poll(windowS, { timeout: 10000 }).toBeGreaterThan(4);   // following means THIS much history now

        // 2. PIN it away from the tail, then NARROW it right down.
        const box1 = await frame.locator(".rc-scrub-win").boundingBox();
        await dragFrom(box1.x + box1.width / 2, track.x + 2);
        await expect.poll(liveText, { timeout: 10000 }).toMatch(/⏸/);
        const box2 = await frame.locator(".rc-scrub-win").boundingBox();
        await dragFrom(box2.x + 2, box2.x + box2.width * 0.55);
        const narrow = await winW();
        expect(narrow, "narrower than the stretch").toBeLessThan(wide);
        // …but still a REAL TARGET. This test is about the width surviving a rejoin, and step 3 has to grab
        // the window's MIDDLE to pan it — so a window only a few pixels wide makes the grab land within
        // rounding distance of its left handle, which RESIZES (leaving `to` exactly where it was) and never
        // reaches the tail. That is what it did on CI while passing locally, deterministically, for three
        // runs: same viewport, same panel width, different rounding. Hit-testing a hairline is its own
        // question and has its own unit test (scrubZone); this one must not accidentally be about it.
        const mid = await frame.locator(".rc-scrub-win").boundingBox();
        expect(mid.width, "the window is wide enough that its middle is unambiguously its middle")
            .toBeGreaterThan(24);

        // 3. DRAG IT BACK to the right edge. It rejoins live — at the width it is, not the width it was.
        const box3 = await frame.locator(".rc-scrub-win").boundingBox();
        // PAST the right edge, not onto it: the window clamps at the end anyway, and aiming exactly at the
        // last pixel leaves nothing for a slow runner's rounding to give away.
        await dragFrom(box3.x + box3.width / 2, track.x + track.width + 20);
        await expect.poll(liveText, { timeout: 10000 }).toMatch(/▶\s*live/);
        expect(await frame.locator(".vram-zoom").count()).toBe(0);
        const after = await winW();
        expect(after, "it did NOT snap back to the wide window it left").toBeLessThan(wide * 0.9);
        expect(Math.abs(after - narrow), "it kept the width on screen").toBeLessThan(15);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});

// DRAGGING ON THE EVENT LANE draws the same selection box the tracks do. The lane already shared the drag —
// it is the same `startBrush` — but drew nothing while you made it, so the gesture worked and looked like it
// had not: you released and the window jumped with no sign of what you had chosen. Every surface on this
// axis draws the same fractions, which is the point of the axis being shared.
test("resource panel: dragging the event lane shows the selection box, and a tiny drag still yields a usable window", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        // The lane scopes to the session being READ by default, and the events below belong to a run this
        // panel is not looking at — scoped, they are correctly filtered out and the lane draws no rows at
        // all, which would make this pass by having nothing to drag on.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);

        // SAMPLES FIRST, then events. An event is placed inside the RUN OF SAMPLES that contains it — one
        // landing where nothing was measured is correctly dropped, so seeding events before there is history
        // to hold them draws an empty lane and this would pass by having nothing to drag on.
        await sleep(9000);
        await page.evaluate(() => {
            const now = Date.now(), span = 7000;
            const at = (f) => now - Math.round(span * f);
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            post({ kind: "agent", id: "bl1", ts: at(1), save: false, session: { hash: "bl1", turn: 0 },
                   task: "t", model: "gemma4:31b", maxSteps: 4, config: null });
            for (let i = 1; i <= 3; i++) {
                post({ kind: "agent-step", id: "bl1", ts: at(0.8 - i * 0.2), save: false, session: { hash: "bl1", turn: i },
                       step: i, seq: i, tool: "exec", toolMs: 400, arguments: { js: `step ${i}` }, result: `r${i}`,
                       usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, genMs: 300 } });
            }
        });
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 20000 }).toBeGreaterThanOrEqual(3);

        const row = await frame.locator(".rc-lane-row").first().boundingBox();
        const y = row.y + row.height / 2;
        // Hold the drag OPEN and look: the box has to be visible WHILE selecting, which is the whole point.
        await page.mouse.move(row.x + row.width * 0.25, y);
        await page.mouse.down();
        await page.mouse.move(row.x + row.width * 0.65, y, { steps: 8 });
        await expect(frame.locator(".rc-lane-row .rc-brush").first()).toBeVisible({ timeout: 4000 });
        const w = await frame.locator(".rc-lane-row .rc-brush").first().evaluate((el) => el.getBoundingClientRect().width);
        expect(w, "the box spans what is being selected, not a sliver").toBeGreaterThan(20);
        await page.mouse.up();
        await sleep(600);

        // …and it applied: the panel is holding a chosen range now.
        await expect(frame.locator(".vram-zoom")).toBeVisible({ timeout: 5000 });
        // The chart still DRAWS. A window narrower than the poll interval used to leave fewer than two
        // samples and an empty box, which is what "the panel breaks" looked like.
        expect(await frame.locator(".rc-plot").count(), "the plot survives the zoom").toBeGreaterThan(0);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});
