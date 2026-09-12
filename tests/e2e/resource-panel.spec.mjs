// resource-panel.spec.mjs — the resource panel against a scripted fake BOX, in a real browser.
//
// The band arithmetic is unit-tested (resource-model.test.mjs) and the rendering is jsdom-tested
// (sidebar.test.js). What only a real browser can show is the panel driven by an actual /api/info + /api/ps
// over time: capacity refreshing as models load, and a GAP appearing because polling really did stop while
// the panel was closed. The narrated version of the same script is resource-demo.mjs.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { TOPOLOGIES, pci } from "../fixtures/boxes.mjs";

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
        await expect(frame.locator(".vram-zoom.pinned")).toBeVisible();
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
        const chip = frame.locator(".vram-zoom.pinned");
        await expect(chip).toBeVisible();
        // The range is the ~30% of the window that was dragged over, not the whole thing.
        expect(await chip.textContent()).toMatch(/\d+s|\dm/);

        // ESC DISMISSES THE MOST TRANSIENT THING FIRST. The pointer is still on the plot here, so a cursor
        // tooltip is sitting over the very trace the selection was made to look at — and "get out of the way"
        // is what Esc means. So the first press hides the TIP and the zoom stands; the second leaves the zoom.
        // Pinned rather than merely tolerated: the alternative order throws away a selection to dismiss a
        // popup, which is the more destructive answer to the less specific gesture.
        await page.keyboard.press("Escape");
        await sleep(300);
        expect(await frame.locator(".rc-tip").count(), "the tip goes first").toBe(0);
        expect(await frame.locator(".vram-zoom.pinned").count(), "…and the selection stands").toBe(1);
        // Esc goes back to live — a zoom you cannot leave is a trap.
        await page.keyboard.press("Escape");
        await sleep(300);
        expect(await frame.locator(".vram-zoom.pinned").count()).toBe(0);

        // And a plain CLICK is not a selection: without that guard every click on the chart zooms to an instant.
        await page.mouse.click(plot.x + plot.width * 0.5, y);
        await sleep(300);
        expect(await frame.locator(".vram-zoom.pinned").count()).toBe(0);
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
        await expect(frame.locator(".vram-zoom.pinned")).toBeVisible();
        expect(await frame.locator(".rc-scrub-win").evaluate((e) => e.style.left)).not.toBe(before);
        // The chart is showing that earlier stretch, not the newest samples.
        const shown = await frame.locator(".rc-seg").count();
        expect(shown, "the chart still draws the scrubbed-to window").toBeGreaterThan(0);

        // And back to live — a view that has silently stopped following is the failure this prevents.
        await live.click();
        await sleep(600);
        await expect(live).toHaveText(/▶\s*live/);
        expect(await frame.locator(".vram-zoom.pinned").count()).toBe(0);
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
        expect(await frame.locator(".vram-zoom.pinned").count(), "nothing scoped yet").toBe(0);
        await frame.locator(".rc-ev-tool").first().dblclick();
        await expect(frame.locator(".vram-zoom.pinned")).toBeVisible();
        // The window is necessarily WIDER than a short block (it needs samples in it to draw at all), so the
        // block says which one you landed on rather than leaving the answer as "somewhere in here".
        await expect.poll(() => frame.locator(".rc-ev.pulse").count(), { timeout: 5000 }).toBeGreaterThan(0);
        // And the strip's window is joined to the lane, so the magnification between the two is visible
        // instead of reading as two charts disagreeing.
        await expect.poll(() => frame.locator(".rc-zoomlink path").count(), { timeout: 5000 }).toBe(2);
        // It scoped to the BLOCK, not to some default window: a single step is seconds, and the chip names
        // the span it framed.
        const span = await frame.locator(".vram-zoom.pinned").innerText();
        expect(span, `chip read "${span}"`).toMatch(/^\d+s/);
        await frame.locator(".vram-zoom.pinned").click();
        await expect.poll(() => frame.locator(".vram-zoom.pinned").count()).toBe(0);

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
        // TRAVEL AS A FRACTION OF THE WINDOW'S OWN WIDTH, which is what a nudge is defined in terms of —
        // "one notch moves the same visible distance whether you are looking at ten seconds or all of it".
        //
        // Measuring it in percent-of-strip made this test flaky at 3/8, and the cause was a moving frame of
        // reference rather than anything the panel did: the window is a fixed FOUR SECONDS of a session that
        // grows by a sample every two, so its share of the strip shrinks between one measurement and the
        // next (24.4% → 21.9% → 19.9% across the three gestures below). Travel is proportional to that
        // width, so two gestures were being compared against two different denominators, and an absolute
        // tolerance absorbed the difference only when the polls happened to fall kindly. Normalised, the
        // vertical and horizontal readings agree to four decimal places, so this is a STRONGER assertion
        // than the one it replaces and not a looser one.
        // IN WINDOW-WIDTHS ALONG THE STRIP, not in percent of it. `left / width` says how many of its own
        // widths the window sits from the start, and a nudge is DEFINED as moving it by a fraction of that
        // width — so this reads the gesture in the units the gesture is specified in, and one notch comes
        // out at 0.2985 whatever the zoom.
        //
        // It also removes the whole reason this test was flaky at 3/8. The window is a fixed FOUR SECONDS of
        // a session that grows by a sample every two, so its share of the strip shrinks continuously — 24.4%
        // → 21.9% → 19.9% across the three gestures below — and a poll landing between the before and after
        // readings shrank both by a factor unrelated to the wheel. On a travel of ~7% of the strip that was
        // up to a third of the measurement, which is how a correct panel produced 0.21 on one run and 0.2985
        // on the next. A ratio of two percentages taken from the same instant is invariant to that growth:
        // the strip lengthening scales `left` and `width` alike, and dividing cancels it exactly.
        const winRatio = async () => {
            const w = await winAt();
            return pct(w.left) / pct(w.width);
        };
        const travelled = async (dx, dy, notches = 1) => {
            await park();
            const before = await winRatio();
            for (let i = 0; i < notches; i++) { await overPlot(); await page.mouse.wheel(dx, dy); await sleep(120); }
            await sleep(300);
            return (await winRatio()) - before;
        };

        const vertical = await travelled(0, 120);
        expect(vertical, "a vertical wheel scrubs forward").toBeGreaterThan(0.05);

        // A HORIZONTAL swipe scrubs too, and by the same distance. Reading only deltaY meant a trackpad's
        // horizontal gesture did nothing except through whatever vertical jitter it happened to carry.
        const horizontal = await travelled(120, 0);
        expect(Math.abs(horizontal - vertical), "…and a horizontal one goes exactly as far")
            .toBeLessThan(vertical * 0.05);

        // PROPORTIONAL: four small notches travel in the same direction and the same order of distance as one
        // big one — a fixed step per event is what made the same physical swipe move wildly different
        // distances depending on how the hardware chose to quantise it.
        //
        // The EXACT claim — that four nudges of a quarter the delta land in precisely the same place as one
        // whole one — is asserted on the pure function instead (`scrubNudge` composes, resource-model.test),
        // because end to end it is not exactly true and the reason is not quantisation: all four wheel events
        // are delivered (verified by counting them in the page), and the shortfall is the window being pulled
        // back toward live by a poll landing mid-gesture. That is a real behaviour rather than a rounding
        // artefact, so the tolerance here is honest about what a four-part gesture can be held to, and the
        // property the assertion was written to protect is checked where it can be checked exactly.
        const inFour = await travelled(0, 30, 4);
        expect(inFour, "4x30 scrubs the same way, in the same order of distance").toBeGreaterThan(vertical * 0.4);
        expect(inFour, "…and never further than the single gesture").toBeLessThan(vertical * 1.2);

        // Back the other way, so it is a scrub and not a one-directional ratchet.
        expect(await travelled(0, -120), "and it goes backwards").toBeLessThan(-0.05);

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
        await expect(frame.locator(".vram-zoom.pinned")).toBeVisible();
        await expect(frame.locator(".rc-scrub-live")).toHaveText(/⏸\s*live/);

        // Now WHEEL forward to the end. Several notches, because one is a fraction of the window's width.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        for (let i = 0; i < 25; i++) {
            if (!(await frame.locator(".vram-zoom.pinned").count())) break;
            await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
            await page.mouse.wheel(0, 200);
            await sleep(120);
        }
        // Reaching the end IS rejoining live: no pinned range left behind.
        await expect.poll(() => frame.locator(".vram-zoom.pinned").count(), { timeout: 5000 }).toBe(0);
        await expect(frame.locator(".rc-scrub-live")).toHaveText(/▶\s*live/);

        // …and it STAYS live as new samples arrive. This is the half that failed: a window pinned at the tail
        // reads as live for one moment and then falls behind, because nothing moves it forward.
        await sleep(6000);
        expect(await frame.locator(".vram-zoom.pinned").count(), "still following, not pinned at where the end was").toBe(0);
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
        /**
         * ONE MOVE AT A TIME, each its own turn of the event loop.
         *
         * `mouse.move(x, y, { steps: 10 })` issues its ten moves back to back, and Chrome COALESCES pending
         * pointermoves into one per RENDERING FRAME. Locally the frame saw all ten; on CI it saw one.
         *
         * The pause helps and does not fix it, which is worth stating plainly because the first version of
         * this comment claimed otherwise: coalescing is paced by the renderer's frames, not by the injector,
         * so on a loaded runner producing a few frames a second, eight moves 25ms apart still arrive as ONE
         * — measured, `[0,1]`. Nothing driven from outside the browser can guarantee otherwise, which is why
         * what this test ASSERTS about the gesture is where it ended up and not how many events carried it.
         */
        const winX = async () => (await frame.locator(".rc-scrub-win").boundingBox())?.x ?? null;
        const dragFrom = async (fromX, toX) => {
            await page.mouse.move(fromX, y);
            await page.mouse.down();
            const STEPS = 8;
            for (let i = 1; i <= STEPS; i++) {
                const was = await winX();
                await page.mouse.move(fromX + ((toX - fromX) * i) / STEPS, y);
                // PACED BY WHAT THE PANEL DID, not by the clock. A fixed sleep assumes the move was
                // DELIVERED, and on a loaded runner it is not: pointermoves are dispatched at the renderer's
                // frame rate, and this drag arrived at the frame as one event carrying the FIRST step's
                // position and then nothing at all — measured, `[[0,165],[1,190]]` for a drag that should
                // have ended at 368. Waiting for the window to move is waiting for delivery, at whatever
                // rate the machine can manage.
                //
                // A SHORT wait that is allowed to expire, not an assertion: a pan into the clamp at either
                // end legitimately moves the window by nothing, so a step that changes nothing is a normal
                // step and not a failure. What the gesture ACHIEVED is asserted after it, once.
                for (let t = 0; t < 12; t++) {
                    if (await winX() !== was) break;
                    await sleep(50);
                }
            }
            /**
             * AND THE LAST POSITION IS INSISTED ON, because a step is allowed to go missing.
             *
             * With the pacing above, CI still delivered about two of the eight moves and the window stopped
             * at 42% of a track it was dragged to the end of — a pan that landed short, which then reads as
             * the panel refusing to rejoin live. Waiting longer does not help: the moves are not late.
             *
             * So the destination is re-sent until the window stops responding to it. The 1px alternation is
             * not superstition — a move to the position the pointer is already at is not a new event, so a
             * plain repeat would be dropped by the browser rather than delivered. It ends when a round
             * changes nothing, which is both "it arrived" and "it is clamped at the end", and those want the
             * same answer: stop pushing. On a machine that delivers the first eight this costs one round.
             */
            for (let t = 0; t < 6; t++) {
                const was = await winX();
                await page.mouse.move(toX - (t % 2), y);
                for (let k = 0; k < 10; k++) {
                    if (await winX() !== was) break;
                    await sleep(50);
                }
                if (await winX() === was) break;
            }
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
        // ASSERT THE GESTURE BEFORE MAKING IT. The strip publishes which zone the pointer is over — the same
        // `scrubZone` the drag itself consults — as a class on the track, so hovering the point we are about
        // to grab says whether this will PAN or RESIZE. Without it a misclassified grab shows up three steps
        // later as an unexplained paused button, which is exactly how this failed on CI while passing
        // locally: the symptom is at the end and the cause is at the start.
        await page.mouse.move(box3.x + box3.width / 2, y);
        await expect.poll(() => frame.locator(".rc-scrub-track").getAttribute("class"), { timeout: 5000 })
            .toContain("z-pan");
        // INSIDE the track, at its last pixel. Aiming PAST it (which this did) puts the pointer over whatever
        // sits beyond — the live button, then the panel's edge — and the handlers are registered on the
        // sidebar iframe's own `window`, so a move that leaves the frame is a move the drag never sees: the
        // gesture then ends wherever the last move INSIDE the frame left it, short of the tail, pinned. That
        // costs nothing to avoid, because `scrubTo` CLAMPS: a centre at 99.7% of the extent parks the window
        // against the end exactly as a centre past 100% would.
        // WHAT THE HANDLER ACTUALLY SAW. The drag registers `pointermove` on the iframe's own `window` and
        // gives up the moment one arrives with `buttons === 0`, so "the moves never landed" and "they landed
        // and did nothing" are different failures that look identical from outside. The POSITION is recorded
        // beside the button state because the count alone cannot tell them apart under coalescing.
        await frame.evaluate(() => {
            window.__mv = [];
            window.addEventListener("pointermove", (e) => window.__mv.push([e.buttons, Math.round(e.clientX)]), true);
        });
        await dragFrom(box3.x + box3.width / 2, track.x + track.width - 1);
        // THE DRAG MUST ACTUALLY TRAVERSE — measured as WHERE IT GOT TO, not how many events carried it.
        // Counting dispatches is not a property of the gesture: the browser is free to merge a burst into one
        // event carrying the final position, which is a correct delivery of the same drag and is what CI does
        // (8 spaced moves → 1 dispatch). A coalesced move still has to arrive at the destination, so the last
        // held-button position is the claim, and it separates "landed short" from "never happened" exactly as
        // the count was meant to.
        //
        // In the FRAME's own coordinates: the target above is a page position, `clientX` is not, and the
        // sidebar is an iframe — so the two are an iframe offset apart.
        const mv = await frame.evaluate(() => window.__mv || []);
        const held = mv.filter(([b]) => b === 1);
        const trackIn = await frame.locator(".rc-scrub-track").evaluate((e) => {
            const r = e.getBoundingClientRect(); return { x: r.x, w: r.width };
        });
        // DIAGNOSTIC, NOT AN ASSERTION — and that distinction is the lesson this test has taught three times.
        // Where the moves got to is a fact about the BROWSER'S input delivery under load, not about the
        // panel: asserting the dispatch count failed on CI, and asserting the last delivered position failed
        // on CI, both while the feature worked. What this test is about is whether the window rejoins live at
        // the width you dragged, so that is the only thing asserted — with the trace carried into ITS message,
        // which is the whole reason the trace was collected.
        const trace = `moves=${JSON.stringify(mv)} trackEnd=${Math.round(trackIn.x + trackIn.w)} `
            + `lastHeld=${held.length ? held.at(-1)[1] : "none"}`;
        // Read the window IMMEDIATELY, before the poll below waits ten seconds. A window that arrived at the
        // tail and then fell behind is a different bug from one that never got there, and once the poll has
        // timed out the two look identical.
        const landed = await frame.locator(".rc-scrub-win").evaluate((e) => e.style.cssText);
        if (!/▶/.test((await liveText()) ?? "")) {
            console.log(`[rejoin] landed="${landed}"`);
            // One line naming the state, because this step has failed on CI while passing locally and the
            // symptom alone ("still paused") does not say which of the three things went wrong: the gesture
            // was read as a resize, the window never reached the tail, or it reached it and the button did
            // not follow. Printed only on the failing path, so a passing run stays quiet.
            const win = await frame.locator(".rc-scrub-win").evaluate((e) => e.style.cssText);
            const stored = await windowS();
            console.log(`[rejoin] track=${Math.round(track.width)} box3=${Math.round(box3.width)} `
                + `win="${win}" ml_res_window=${stored} live="${await liveText()}"`);
        }
        await expect.poll(liveText, { timeout: 10000 }).toMatch(/▶\s*live/);
        expect(await frame.locator(".vram-zoom.pinned").count(), `still zoomed after the pan — ${trace}`).toBe(0);
        const after = await winW();
        expect(after, `it snapped back to the wide window it left — ${trace}`).toBeLessThan(wide * 0.9);
        expect(Math.abs(after - narrow), `it did not keep the width on screen — ${trace}`).toBeLessThan(15);
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
        await expect(frame.locator(".vram-zoom.pinned")).toBeVisible({ timeout: 5000 });
        // The chart still DRAWS. A window narrower than the poll interval used to leave fewer than two
        // samples and an empty box, which is what "the panel breaks" looked like.
        expect(await frame.locator(".rc-plot").count(), "the plot survives the zoom").toBeGreaterThan(0);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});

// SCROLLING BACK TO LIVE KEEPS THE WIDTH YOU HAD. Following-with-a-width is not a special case of a pinned
// range — it IS `resWindowS`, the quantity Settings names — so arriving at the tail must adopt the window on
// screen rather than whatever that setting last held. The drag was fixed for this; the WHEEL had its own
// copy of the rule that only nulled the zoom, so a window you had carefully narrowed sprang back to five
// minutes the moment you scrolled it home.
test("resource panel: scrolling a NARROW window back to live keeps it narrow", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        // A window that is a FRACTION of the session, or there is nothing to pin: a 5-minute window over a
        // 15-second session covers the whole strip, clamps at the tail, and can never be dragged off it.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 6 }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-scrub").count(), { timeout: 30000 }).toBe(1);
        await sleep(16000);   // …so the session outgrows it several times over

        const winW = () => frame.locator(".rc-scrub-win").evaluate((e) => parseFloat(e.style.width));
        const live = () => frame.locator(".rc-scrub-live").textContent();
        const track = await frame.locator(".rc-scrub-track").boundingBox();
        const y = track.y + track.height / 2;

        const drag = async (fromX, toX) => {
            await page.mouse.move(fromX, y);
            await page.mouse.down();
            await page.mouse.move(toX, y, { steps: 8 });
            await page.mouse.up();
            await sleep(700);
        };
        // PIN IT AWAY FROM THE TAIL FIRST, and this ordering is the whole test. Narrowing a window that is
        // still AT the tail is read as "you resized while following", which writes the new width to
        // `resWindowS` — so rejoining live afterwards restores it and the bug cannot show. Pinned, the
        // setting keeps its old wide value, and the only thing that can carry the narrow width home is the
        // rejoin rule itself.
        const box0 = await frame.locator(".rc-scrub-win").boundingBox();
        await drag(box0.x + box0.width / 2, track.x + track.width * 0.35);
        await expect.poll(live, { timeout: 10000 }).toMatch(/⏸/);
        expect(await ext.sw.evaluate(() => new Promise((r) =>
            chrome.storage.local.get({ ml_res_window: 0 }, (d) => r(d.ml_res_window)))),
        "the setting is still the one we seeded — nothing has taught it otherwise").toBe(6);

        // …now narrow it, pinned.
        const box1 = await frame.locator(".rc-scrub-win").boundingBox();
        await drag(box1.x + 2, box1.x + box1.width * 0.55);
        const narrow = await winW();
        expect(narrow, "it is narrower than the strip").toBeLessThan(80);

        // …then SCROLL it home rather than dragging, which is the path that had its own rule.
        for (let i = 0; i < 25; i++) {
            await frame.locator(".rc-scrub-track").evaluate((el) => {
                const r = el.getBoundingClientRect();
                el.dispatchEvent(new WheelEvent("wheel", { deltaX: 120, bubbles: true, cancelable: true,
                    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
            });
            await sleep(40);
            if (/▶/.test((await live()) ?? "")) break;
        }
        await expect.poll(live, { timeout: 5000 }).toMatch(/▶\s*live/);
        // THE POINT: it followed at the width it had, not at the width the setting remembered.
        const after = await winW();
        expect(after, `it sprang back to the stored window (${narrow}% → ${after}%)`).toBeLessThan(narrow * 1.4);
        // …and the width is remembered as the preference, the same quantity Settings names. POLLED, because
        // the write is deliberately deferred to the end of the gesture — a wheel fires dozens of times and
        // storing on each one would be dozens of writes for one scroll.
        await expect.poll(() => ext.sw.evaluate(() => new Promise((r) =>
            chrome.storage.local.get({ ml_res_window: 0 }, (d) => r(d.ml_res_window)))),
        { timeout: 5000 }).toBeLessThan(6);
    } finally { await ext.close(); await fake.stop(); }
});

// PINCH TO ZOOM, the other way to reach the same window. A trackpad pinch arrives as a `wheel` carrying
// `ctrlKey` — the platform's own convention, which is also why it has to be swallowed: left alone, the
// browser zooms the whole panel instead. Playwright's `mouse.wheel` cannot set the flag, so the event is
// dispatched as the trackpad would send it; everything downstream is the real handler.
test("resource panel: pinching zooms the window — on the plot, the lane and the scrub strip", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({
            ml_res_window: 300, ml_lane_scope: false, ml_res_sections: { lane: true, models: true },
        }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        // The lane draws NOTHING when there are no events at all, and half this test is about the lane taking
        // the gesture — so there has to be something in it, or that half would pass by never running.
        await page.evaluate(() => window.postMessage({ __mlDebug: {
            kind: "agent", id: "pz1", ts: Date.now() - 4000, save: false,
            session: { hash: "pz1", turn: 0 }, task: "a task", model: "fake-model", maxSteps: 4, config: null,
        } }, "*"));
        await sleep(8000);   // enough history that there is a window worth narrowing

        /** One pinch event, as a trackpad sends it: a wheel with ctrlKey, at a point inside the target. */
        const pinch = (sel, deltaY) => frame.locator(sel).first().evaluate((el, dy) => {
            const r = el.getBoundingClientRect();
            const ev = new WheelEvent("wheel", {
                deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;   // unprevented, the BROWSER zooms the page instead
        }, deltaY);

        const windowS = () => ext.sw.evaluate(() => new Promise((r) =>
            chrome.storage.local.get({ ml_res_window: 0 }, (d) => r(d.ml_res_window))));
        const winW = () => frame.locator(".rc-scrub-win").evaluate((e) => parseFloat(e.style.width));
        /** Repeat a widening gesture until it has visibly widened, rather than sending a fixed count. A pinch
         *  that arrives while the panel is still settling the previous one is absorbed, so a fixed number of
         *  events is a bet on machine speed — which is the bet that makes a test pass here and fail in CI. */
        const widenUntil = async (gesture, read, from) => {
            for (let i = 0; i < 12; i++) {
                await gesture();
                await sleep(150);
                if ((await read()) > from + 0.5) return;
            }
        };

        const before = await winW();
        // PINCH OUT (a negative delta) means closer, so the window narrows.
        expect(await pinch(".rc-plot", -60), "the pinch is consumed, or the page zooms instead").toBe(true);
        await expect.poll(winW, { timeout: 5000 }).toBeLessThan(before);
        // …and it is still FOLLOWING. Zooming while live changes how much history is drawn; it must not pin
        // the window at wherever it happened to be, which would make the gesture a way to stop following.
        await expect.poll(() => frame.locator(".rc-scrub-live").textContent(), { timeout: 5000 })
            .toMatch(/▶\s*live/);
        // The width is the same quantity Settings names, so it is remembered — written once the gesture
        // settles rather than on every frame of it.
        await expect.poll(windowS, { timeout: 5000 }).toBeLessThan(300);

        // PINCH IN widens it again. INSIST on the destination rather than sending a fixed number of events and
        // hoping: this failed only ever in a full-file run and never in isolation, which is the signature of a
        // gesture arriving faster than a loaded machine settles it, not of the panel being wrong. Each pinch
        // is paced by the panel's own reaction and the loop stops the moment the window has actually widened,
        // so a fast machine sends four and a slow one sends as many as it needs.
        //
        // Not asserted on the stored duration, which would look like the scale-free choice and is not
        // available in time: it is written once the gesture SETTLES rather than on every frame of it, so a
        // poll for it right after the last pinch reads the value from before the widening.
        const narrow = await winW();
        await widenUntil(() => pinch(".rc-plot", 60), () => winW(), narrow);
        expect(await winW(), "pinching in widens the window again").toBeGreaterThan(narrow);

        // AND THE LANE takes it too — it shares the plot's axis, so a gesture that works an inch above it and
        // silently does nothing on it reads as the lane being dead.
        const wide = await winW();
        await expect(frame.locator(".rc-lane")).toBeVisible();
        expect(await pinch(".rc-lane", -60), "the lane consumes it as well").toBe(true);
        await expect.poll(winW, { timeout: 5000 }).toBeLessThan(wide);

        // AND THE SCRUB STRIP — the surface actually DRAWING the range, so it is the one a person reaches for
        // to change it. A wheel there pans and deliberately never resizes (it cannot say which edge it meant);
        // a pinch names a centre rather than an edge, so the objection does not apply to it.
        const beforeStrip = await winW();
        await widenUntil(() => pinch(".rc-scrub-track", 60), () => winW(), beforeStrip);
        expect(await winW(), "and the strip widens it too").toBeGreaterThan(beforeStrip);
        const widened = await winW();
        expect(await pinch(".rc-scrub-track", -60), "the strip consumes it").toBe(true);
        await expect.poll(winW, { timeout: 5000 }).toBeLessThan(widened);
        // A PLAIN wheel there still PANS rather than zooming — the two gestures must not collapse into one.
        const held = await winW();
        await frame.locator(".rc-scrub-track").evaluate((el) => {
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new WheelEvent("wheel", { deltaX: 40, bubbles: true, cancelable: true,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        });
        await sleep(300);
        expect(Math.abs((await winW()) - held), "a plain wheel moves the window, it does not resize it")
            .toBeLessThan(2);
    } finally {
        await ext.close();
        await fake.stop();
    }
});

// HOVERING A MODEL SUBDIVIDES ITS BAND IN PLACE. `size_vram` alone cannot tell a big MODEL from a big
// CONTEXT — lots of weights with a small cache, and modest weights with an enormous one, are the same number
// and want opposite responses — so the server splits it and the chart decomposes the area you are already
// looking at, rather than opening a second picture of the same memory elsewhere.
test("resource panel: hovering a model splits its band into what the memory is holding", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        // The real shape, from a live `gemma4:e2b`: the parts sum to `size_vram` to the byte, which is what
        // lets the band subdivide with no remainder slice.
        const MEM = { weights: 1465426903, kv_cache: 836763648, compute: 1129588981, projector: 1208032952 };
        const VRAM = 4639812484;
        fake.setResident([{
            model: "gemma4:e2b", name: "gemma4:e2b", size: VRAM, size_vram: VRAM, context_length: 262144,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            memory: MEM, weights_on_disk: 7162394016,
            gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VRAM, memory: MEM }],
        }]);
        await seedStacked(ext);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(2500);   // two samples, or a stacked AREA has nothing to span

        // NOTHING until asked: the decomposition is a hover affordance, not a permanent extra four shapes in
        // a chart whose whole problem is how much is already in it.
        expect(await frame.locator(".rc-part").count(), "no parts before hovering").toBe(0);

        await frame.locator(".rc-band").first().hover();
        await expect.poll(() => frame.locator(".rc-part").count(), { timeout: 5000 }).toBe(4);
        // The FOUR the capture has, in stack order, and no fifth — a remainder slice would mean the sum
        // invariant had been papered over instead of trusted.
        const classes = await frame.locator(".rc-part").evaluateAll((els) => els.map((e) => e.getAttribute("class")));
        expect(classes.join(" ")).toContain("rc-part-weights");
        expect(classes.join(" ")).toContain("rc-part-kvCache");
        expect(classes.join(" ")).toContain("rc-part-projector");
        expect(classes.join(" ")).toContain("rc-part-compute");
        expect(classes.join(" "), "nothing the model does not have").not.toContain("rc-part-output");

        // THE SHARES ARE THE BYTES. Measured off the drawn geometry rather than trusted from the source:
        // the whole point is that the picture is the split, so a decomposition that draws four equal slices
        // would look right and mean nothing.
        const heights = await frame.locator(".rc-part").evaluateAll((els) => els.map((e) => {
            const ys = e.getAttribute("points").split(" ").map((p) => parseFloat(p.split(",")[1]));
            return Math.max(...ys) - Math.min(...ys);
        }));
        const total = heights.reduce((a, b) => a + b, 0);
        const share = (i) => heights[i] / total;
        expect(share(0)).toBeCloseTo(MEM.weights / VRAM, 1);
        expect(share(1)).toBeCloseTo(MEM.kv_cache / VRAM, 1);

        // …and the band it decomposes is still exactly as tall, because the parts sum to it.
        const bandH = await frame.locator(".rc-band").first().evaluate((e) => {
            const ys = e.getAttribute("points").split(" ").map((p) => parseFloat(p.split(",")[1]));
            return Math.max(...ys) - Math.min(...ys);
        });
        expect(Math.abs(total - bandH), "no remainder — the split fills the band").toBeLessThan(1.5);

        // It goes with the pointer.
        await frame.locator(".vram-head").hover();
        await expect.poll(() => frame.locator(".rc-part").count(), { timeout: 5000 }).toBe(0);
    } finally { await ext.close(); await fake.stop(); }
});

// THE CROSSHAIR SNAPS TO THE DATAPOINT IT IS READING. The tooltip has always named a real sample — a figure
// halfway between two polls was never observed — but the line was drawn wherever the pointer was, so the mark
// and the number disagreed by up to half a sample gap. Off by default: it is a precision affordance for
// reading ONE reading, and a dot that jumps with every movement is noise when scanning the trace's shape.
test("resource panel: the crosshair snaps to a datapoint, and only when asked", async () => {
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
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);   // several samples, or "the nearest one" has nothing to choose between

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        const hoverAt = async (fx) => {
            await page.mouse.move(plot.x + plot.width * fx, plot.y + plot.height * 0.5);
            await sleep(200);
            const cross = await frame.locator(".rc-cross").first().boundingBox().catch(() => null);
            return cross ? (cross.x + cross.width / 2 - plot.x) / plot.width : null;
        };
        /** Every dot's position within the plot, as fractions. */
        const dots = async () => frame.locator(".rc-snapdot").evaluateAll((els, p) => els.map((e) => {
            const r = e.getBoundingClientRect();
            return { x: (r.x + r.width / 2 - p.x) / p.width, y: (r.y + r.height / 2 - p.y) / p.height,
                     w: Math.round(r.width), h: Math.round(r.height) };
        }), plot);

        /**
         * HOW MANY PROBES, and why it is not four or six.
         *
         * The bound this test asserts is "snapping halves the positions", and both sides of that scale
         * differently: unsnapped, every probe is its own position, so the free count IS the probe count;
         * snapped, the count is however many SAMPLES the swept stretch crosses, which is a property of the
         * data and not of the sweep. So the margin comes from probing more densely than the samples sit —
         * six probes over a tenth of a forty-sample window can legitimately land on four distinct samples,
         * which is a correct snap failing a bound of three. Twelve probes over the same stretch still cross
         * those four while raising the bound to six.
         */
        const PROBES = 12;
        /** Sweep a short stretch and report how many DISTINCT positions the crosshair took. */
        const distinct = async (from, to, n) => {
            const seen = new Set();
            for (let i = 0; i < n; i++) seen.add((await hoverAt(from + ((to - from) * i) / (n - 1))).toFixed(3));
            return seen.size;
        };

        // OFF by default: the line follows the pointer exactly, so every position in a sweep is its own.
        // Asserted as QUANTISATION rather than by comparing absolute positions, because the axis is LIVE —
        // samples accumulate while the test hovers, so every snapped position shifts between probes and a
        // test comparing them across several seconds is racing its own data. How many distinct places the
        // line can be is stable under that; where they are is not.
        const freeSpread = await distinct(0.40, 0.50, PROBES);
        expect(freeSpread, `unsnapped, ${PROBES} positions are ${PROBES} positions`).toBeGreaterThan(PROBES - 3);
        expect(await frame.locator(".rc-snapdot").count(), "and no dot until asked").toBe(0);

        // Turned on through the CONTROL, not by writing storage behind the panel's back: the preference is
        // read at mount, so a poked key would leave the signal stale and the test would be asserting on a
        // path no user takes.
        //
        // It lives in the PANEL'S OWN track editor, beside what the panel draws — not in Settings, which is a
        // surface you have to leave the chart to reach for a mode you flip while reading one datapoint. The
        // lane and model-list toggles are there for the same reason.
        await frame.locator('[aria-label="Edit tracks"]').click();
        await frame.locator(".rc-eopt", { hasText: "snap to datapoint" }).locator("input").check();
        await frame.locator('[aria-label="Edit tracks"]').click();   // close it, or it covers the plot
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 10000 }).toBeGreaterThan(0);
        await expect.poll(async () => {
            await page.mouse.move(plot.x + plot.width * 0.42, plot.y + plot.height * 0.5);
            await sleep(120);
            return frame.locator(".rc-snapdot").count();
        }, { timeout: 10000 }).toBeGreaterThan(0);

        // SNAPPED: the same sweep collapses onto a handful of datapoints. That is the whole behaviour, and
        // what a line merely following the pointer can never do.
        // RELATIVE to the unsnapped sweep, not an absolute count. The snapped position is RECOMPUTED as data
        // arrives (it must be — see the alignment check below), so a poll landing mid-sweep moves the same
        // sample slightly and adds a distinct value. Halving is the property that survives that: quantisation
        // collapses positions, and losing half of six to a live axis would still be a broken snap.
        const snapSpread = await distinct(0.40, 0.50, PROBES);
        expect(snapSpread, `${PROBES} positions snapped to ${snapSpread} places (unsnapped: ${freeSpread})`)
            .toBeLessThanOrEqual(Math.ceil(freeSpread / 2));

        // THE DOT SITS ON A LINE, and does not follow the pointer. It rode at the cursor's height at first,
        // on the argument that a stacked area has many values at one x and so no single y — which was wrong
        // twice: the lines ARE there, and a mark tracking the cursor vertically is the cursor with a circle
        // on it rather than a datapoint.
        //
        // PROBED WITHIN ONE FOCUS, not across the plot's whole height. Two far-apart heights each pick out a
        // DIFFERENT thing to mark — a band in the stacked view, a pool's line here — so a mark that correctly
        // stays put still reports two different heights, and the version of this that swept top to bottom was
        // reading the focus feature and calling it a moving dot. Nudging inside one hit target is also the
        // sharper probe: a dot that rode the cursor would move by exactly the nudge, and 4px is a difference
        // this asserts to the pixel where 50px only ever showed up as "wrong".
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
        await sleep(250);
        const anchor = (await dots())[0];
        expect(anchor, "at least one line is marked").toBeTruthy();
        // ONTO the mark itself, so a cursor-following dot and a datapoint agree here and can only be told
        // apart by what the NEXT move does — which is the point.
        const onDot = plot.y + anchor.y * plot.height;
        await page.mouse.move(plot.x + plot.width * 0.5, onDot);
        await sleep(250);
        const at0 = await dots();
        await page.mouse.move(plot.x + plot.width * 0.5, onDot + 4);
        await sleep(250);
        const at4 = await dots();
        expect(at4.length, "the same marks, four pixels lower").toBe(at0.length);
        for (const [i, d] of at4.entries())
            expect(Math.abs(d.y - at0[i].y) * plot.height, `mark ${i} moved with the pointer`).toBeLessThan(1);
        // …and it is ROUND. A <circle> inside a `preserveAspectRatio="none"` viewBox draws as an ellipse whose
        // eccentricity depends on the plot's current size, which is why these are positioned HTML.
        expect(Math.abs(at0[0].w - at0[0].h), `${at0[0].w}x${at0[0].h}`).toBeLessThanOrEqual(1);
        // Every dot shares the snapped x — they are points of the SAME sample on different lines.
        expect(Math.max(...at0.map((d) => d.x)) - Math.min(...at0.map((d) => d.x))).toBeLessThan(0.02);

        // ON THE LINE, TO THE PIXEL — against the crosshair and against the polyline's own point, because
        // "near enough" is what this looked like when it was 50px out. Two separate faults produced that:
        // the crosshair stored a fraction computed at pointermove while the dots recomputed theirs at render,
        // so one poll's worth of new samples moved only one of them; and the 1px rule started AT its position
        // instead of straddling it, leaving a permanent half-pixel.
        // A PARKED POINTER KEEPS ITS MARK. The pointer is a position on SCREEN; which sample sits under it
        // changes as the timeline advances, so resolving that once and holding it pins the mark to a sample
        // that then walks left out from under a cursor that has not moved. Both this and the alignment below
        // need a poll to have LANDED — the fault is invisible until new data arrives, which is why measuring
        // straight after the hover passed with it reintroduced.
        const countSamples = () => frame.locator(".rc-plot").first().evaluate((el) => {
            const poly = el.querySelector(".rc-line") || el.querySelector("polygon");
            return (poly?.getAttribute("points") || "").trim().split(/\s+/).length;
        });
        // Measured against a FRESH box: the panel grows as rows arrive, so a bounding box captured earlier
        // puts these fractions outside the plot entirely and the numbers stop meaning anything.
        const dotX = async () => {
            const p = await frame.locator(".rc-plot").first().boundingBox();
            const d = await frame.locator(".rc-snapdot").first().boundingBox();
            return (d.x + d.width / 2 - p.x) / p.width;
        };
        const before = await countSamples();
        // One sample's width on the axis. Derived from the count rather than by probing two positions, since
        // the count is what the spacing IS and probing costs two more hovers that would themselves race polls.
        const gap = 1 / Math.max(1, before - 1);
        const parkedX = await dotX();
        // SEVERAL polls, not one. Re-snapping legitimately moves the mark by up to half a sample gap as the
        // nearest sample changes under a stationary pointer — so after ONE poll the right behaviour and the
        // wrong one are barely a gap apart. Pinned to a sample, the mark walks a further gap with EVERY poll
        // and never comes back; re-derived, it stays put however many land.
        await expect.poll(countSamples, { timeout: 20000 }).toBeGreaterThan(before + 2);
        const afterX = await dotX();
        expect(Math.abs(afterX - parkedX), `the mark slid from ${parkedX.toFixed(3)} to ${afterX.toFixed(3)}`)
            .toBeLessThan(gap * 0.75);

        const align = await frame.evaluate(() => {
            const plotEl = document.querySelector(".rc-plot");
            const cb = plotEl.querySelector(".rc-cross")?.getBoundingClientRect();
            const d = plotEl.querySelector(".rc-snapdot")?.getBoundingClientRect();
            const poly = plotEl.querySelector(".rc-line") || plotEl.querySelector("polygon");
            if (!cb || !d || !poly) return null;
            const vb = poly.ownerSVGElement.viewBox.baseVal, sb = poly.ownerSVGElement.getBoundingClientRect();
            const pts = (poly.getAttribute("points") || "").trim().split(/\s+/).map((p) => {
                const [x, y] = p.split(",").map(Number);
                return { x: sb.x + (x / vb.width) * sb.width, y: sb.y + (y / vb.height) * sb.height };
            });
            const dot = { x: d.x + d.width / 2, y: d.y + d.height / 2 };
            const near = pts.reduce((a, p) => (Math.abs(p.x - dot.x) < Math.abs(a.x - dot.x) ? p : a), pts[0]);
            return { dx: Math.abs(dot.x - (cb.x + cb.width / 2)), dy: Math.abs(dot.y - near.y),
                     ddx: Math.abs(dot.x - near.x) };
        });
        expect(align, "the plot draws a line to compare against").toBeTruthy();
        expect(align.dx, "the dot is centred on the crosshair").toBeLessThan(0.6);
        expect(align.ddx, "…and on the datapoint's own x").toBeLessThan(0.6);
        expect(align.dy, "…and sits ON the line, not beside it").toBeLessThan(0.6);

    } finally { await ext.close(); await fake.stop(); }
});

// THREE THINGS THE MARK MUST NOT DO, all reported from watching it rather than caught by a test — which is
// what they have in common: each is about what the chart says when two marks are on screen at once, and no
// assertion about a single one of them could have found any of them.
test("resource panel: the snap mark yields, focuses, and says what it is out of", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_snapdot: true }));
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(6000);

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        // Over the plot's own background, low in the track where no band is drawn: an OVERVIEW, so every
        // boundary is marked.
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(300);
        const all = await frame.locator(".rc-snapdot").count();
        expect(all, "over the background, every line is marked").toBeGreaterThan(1);

        // HOVERING ONE BAND narrows it to that band. The panel has already dimmed the others to say "this
        // one", and a full set of dots contradicts that by marking what it just faded.
        await frame.locator(".rc-band").first().hover();
        await sleep(300);
        expect(await frame.locator(".rc-snapdot").count(), "focused, one mark").toBe(1);

        // AN EVENT RULE OWNS THE POINTER. A dashed instant is its own vertical mark, naming an INSTANT where
        // the crosshair names the nearest SAMPLE — never the same x — so together they read as one thing that
        // cannot decide where it is.
        fake.setResident([]);   // an eviction rules through the plot
        await expect.poll(() => frame.locator(".rc-rule").count(), { timeout: 30000 }).toBeGreaterThan(0);
        const rule = await frame.locator(".rc-rule").first().boundingBox();
        await page.mouse.move(rule.x + rule.width / 2, rule.y + rule.height / 2 + 20);
        await page.mouse.move(rule.x + rule.width / 2, rule.y + rule.height / 2, { steps: 3 });
        await sleep(350);
        expect(await frame.locator(".rc-snapdot").count(), "the dots stand down").toBe(0);
        // EVERY track's line, not just this one — the crosshair is drawn per track off a shared signal, so
        // one standing down while its siblings stayed would be the same contradiction one row lower.
        expect(await frame.locator(".rc-cross").count(), "…and so does the line, on every track").toBe(0);

        // …and both come back when the pointer leaves it, or "temporarily" would be a one-way door.
        await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height * 0.06);
        await sleep(350);
        expect(await frame.locator(".rc-cross").count()).toBeGreaterThan(0);
    } finally { await ext.close(); await fake.stop(); }
});

// THE DENOMINATOR IS A CONSTANT, so it recedes. On one line the ceiling competes with the reading for the
// same glance, and it is the one number in the tooltip that never changes as the pointer moves.
test("resource panel: the pool tooltip puts the ceiling on its own dimmer line", async () => {
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
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
        await expect.poll(() => frame.locator(".rc-tip-pool").count(), { timeout: 8000 }).toBe(1);

        const first = await frame.locator(".rc-tip-pool .rc-tip-size").first().textContent();
        expect(first, "the reading leads, with its share").toMatch(/in use \(\d+%\)/);
        const of = await frame.locator(".rc-tip-of").textContent();
        expect(of, "the ceiling is on its own line").toMatch(/^out of /);
        // DIMMER, which is the whole point of moving it — same-coloured it would just be a second line.
        const [c1, c2] = await frame.locator(".rc-tip-pool").evaluate((el) => [
            getComputedStyle(el.querySelector(".rc-tip-size")).color,
            getComputedStyle(el.querySelector(".rc-tip-of")).color,
        ]);
        expect(c2).not.toBe(c1);

        // AND THE SAME ON A MODEL'S OWN TIP. Its percentage is a share of THIS pool, and a share with no
        // denominator on screen is the one figure a reader has to go and find — so the band tip carries the
        // line too, dimmed for the same reason: the ceiling is the one number in the tooltip that does not
        // change as the pointer moves along the trace, so it is the one that should recede.
        await frame.locator(".rc-band").first().hover();
        await expect.poll(() => frame.locator(".rc-tip-model").count(), { timeout: 8000 }).toBe(1);
        const band = frame.locator(".rc-tip-model");
        expect(await band.locator(".rc-tip-size").first().textContent(), "the reading leads").toMatch(/\(\d+%\)/);
        expect(await band.locator(".rc-tip-of").first().textContent(), "…with what it is OF beneath it")
            .toMatch(/^out of /);
        const [m1, m2] = await band.evaluate((el) => [
            getComputedStyle(el.querySelector(".rc-tip-size")).color,
            getComputedStyle(el.querySelector(".rc-tip-of")).color,
        ]);
        expect(m2, "dimmer than the figure above it").not.toBe(m1);
    } finally { await ext.close(); await fake.stop(); }
});

// THE SELECTION SNAPS TOO. A box drawn to free fractions beside a crosshair that lands on datapoints is the
// panel using two different rules for "where the pointer is" at once — and you can see it, because the edges
// sit between the dots they were dragged against.
test("resource panel: in snap mode the selection box lands on datapoints, not between them", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_snapdot: true, ml_res_window: 300 }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);   // several samples, so a drag spans more than one

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        const y = plot.y + plot.height * 0.5;
        /** The selection box and the snap mark, as fractions of the plot, read in ONE go — genuinely: one
         *  synchronous evaluation in the frame, so no render can land between the two rectangles. It was two
         *  Playwright `boundingBox()` calls, and a sample arriving between them moved every fraction on the
         *  live axis, so the box was measured against the mark one sample later: 0.405 against 0.500 on CI. */
        const edges = () => frame.evaluate(() => {
            const plotEl = document.querySelector(".rc-plot"), sel = document.querySelector(".rc-brush"), dot = document.querySelector(".rc-snapdot");
            if (!plotEl || !sel || !dot) return null;
            const p = plotEl.getBoundingClientRect(), b = sel.getBoundingClientRect(), d = dot.getBoundingClientRect();
            return { left: (b.left - p.left) / p.width, right: (b.right - p.left) / p.width, mark: (d.left + d.width / 2 - p.left) / p.width };
        });

        /**
         * THE MARK IS THE WITNESS, and it is read at the SAME INSTANT as the box.
         *
         * The first version of this measured where a datapoint sat, dragged, and compared the box against
         * that — and the axis is LIVE. Samples arrive during the drag, every sample's fraction moves, and a
         * correctly snapped edge then disagrees with a reading taken ten seconds earlier: it failed with the
         * left edge at 0.333 against a datapoint recorded at 0.400, which is the test racing its own data
         * rather than the panel putting the box in the wrong place.
         *
         * The claim does not need that reading. Snapping means the box and the mark answer "which sample is
         * under the pointer" the same way — so comparing the two AT ONE MOMENT is the whole invariant, and
         * it holds however far the axis has walked since the drag began.
         */
        await page.mouse.move(plot.x + plot.width * 0.33, y);
        await page.mouse.down();
        const seen = [];
        for (const fx of [0.45, 0.55, 0.65, 0.72]) {
            await page.mouse.move(plot.x + plot.width * fx, y);
            await sleep(180);
            const e = await edges();
            expect(e, "a selection box is drawn while dragging").toBeTruthy();
            expect(Math.abs(e.right - e.mark), `the box's leading edge ${e.right.toFixed(3)} is not on the mark ${e.mark.toFixed(3)}`)
                .toBeLessThan(0.02);
            seen.push({ ...e, fx });
        }
        await page.mouse.up();

        // THE PREMISE: snapping has to be DOING something here, or an edge that merely followed the pointer
        // would satisfy the check above just as well. At least one probe must have moved the edge visibly off
        // the pointer — not all of them, since a pointer can land on a datapoint by luck.
        const offPointer = seen.filter((e) => Math.abs(e.right - e.fx) > 0.01);
        expect(offPointer.length, `every edge sat exactly under the pointer, so nothing was snapped: ${JSON.stringify(seen)}`)
            .toBeGreaterThan(0);
        // …and the trailing edge did not follow the pointer: it stays on the sample under the position the
        // press landed on, while the leading edge travels the width of the drag.
        //
        // TOLERANCED IN SAMPLES, derived from this run's own data rather than written down. The anchor is a
        // fixed SCREEN position and the axis walks under it, so which sample sits there genuinely changes as
        // polls land — by up to one gap between samples, which would fail any fixed tolerance tight enough to be
        // worth asserting. The axis is LINEAR IN TIME and polls are not evenly spaced, so the gaps differ: the
        // bound is the WIDEST gap between the places the leading edge stopped (the smallest one undercounted
        // it and failed on CI at 0.156 against a 0.104 gap, with the pointer 0.39 away). Capped at half the
        // pointer's travel, so an anchor that followed the pointer still fails however sparse the samples.
        const stops = [...new Set(seen.map((e) => +e.right.toFixed(3)))].sort((a, b) => a - b);
        const gaps = stops.slice(1).map((v, i) => v - stops[i]);
        const spacing = gaps.length ? Math.min(...gaps) : 0.1;
        const travel = seen.at(-1).fx - 0.33;
        expect(Math.abs(seen.at(-1).left - seen[0].left), `the anchored edge moved with the pointer: ${JSON.stringify(seen)}`)
            .toBeLessThan(Math.min((gaps.length ? Math.max(...gaps) : 0.1) * 1.5, travel / 2));
        expect(seen.at(-1).right - seen.at(-1).left, "…while the leading edge covered the drag")
            .toBeGreaterThan(spacing);
    } finally { await ext.close(); await fake.stop(); }
});

// ESC HIDES THE TOOLTIP so you can look at the chart. A cursor tip has to sit near the pointer to be
// readable, which means it sits on top of the trace you paused over — so the one moment you want to study a
// shape is the one moment something is covering it.
test("resource panel: Esc hides the cursor tip, and moving brings it back", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_snapdot: true }));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(5000);

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
        await expect.poll(() => frame.locator(".rc-tip").count(), { timeout: 8000 }).toBeGreaterThan(0);

        await page.keyboard.press("Escape");
        await expect.poll(() => frame.locator(".rc-tip").count(), { timeout: 4000 }).toBe(0);
        // THE MARK STAYS. It is where you were looking, which is the thing being preserved — hiding it too
        // would just be "leave the chart", and you would have to find your place again.
        expect(await frame.locator(".rc-snapdot").count(), "the dots are still there").toBeGreaterThan(0);
        expect(await frame.locator(".rc-cross").count()).toBeGreaterThan(0);

        // MOVING is the ask for it back — not a second Esc. The gesture is "get out of the way for a second",
        // not a mode you have to leave.
        await page.mouse.move(plot.x + plot.width * 0.55, plot.y + plot.height * 0.5);
        await expect.poll(() => frame.locator(".rc-tip").count(), { timeout: 4000 }).toBeGreaterThan(0);
    } finally { await ext.close(); await fake.stop(); }
});

// …and with NO tip showing, Esc still does what it always did.
test("resource panel: Esc with no tip up still leaves the zoom", async () => {
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
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(9000);

        // Select a range, then take the pointer OFF the chart so no tip is showing.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        const y = plot.y + plot.height * 0.5;
        await page.mouse.move(plot.x + plot.width * 0.3, y);
        await page.mouse.down();
        for (const fx of [0.45, 0.6, 0.7]) { await page.mouse.move(plot.x + plot.width * fx, y); await sleep(30); }
        await page.mouse.up();
        await expect.poll(() => frame.locator(".vram-zoom.pinned").count(), { timeout: 8000 }).toBe(1);

        await frame.locator(".vram-head").hover();
        await sleep(300);
        await page.keyboard.press("Escape");
        await expect.poll(() => frame.locator(".vram-zoom.pinned").count(), { timeout: 5000 }).toBe(0);
    } finally { await ext.close(); await fake.stop(); }
});

// THE TIME GRID: off by default; from the gear, faint lines at a round interval through every plot, evenly spaced
// (the axis is linear in time within a run) and at the SAME places on every track, with the spacing named.
test("resource panel: the time grid is off by default, and on it rules every plot at the same round times", async () => {
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
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 25000 }).toBe(3);
        await sleep(12000);   // enough samples that the window holds more than one grid interval

        expect(await frame.locator(".rc-grid").count(), "off by default").toBe(0);
        await frame.locator(".vram-head").first().hover();
        await frame.locator('[aria-label="Edit tracks"]').click();
        await frame.locator(".rc-editor .rc-eopt", { hasText: /time grid/ }).locator("input").check();
        await frame.locator('[aria-label="Edit tracks"]').click();

        await expect.poll(() => frame.locator(".rc-grid").count(), { timeout: 5000 }).toBeGreaterThan(0);
        // ONE synchronous read, so a sample landing between two measurements cannot move one track's lines.
        const read = () => frame.evaluate(() => [...document.querySelectorAll(".rc-track")].map((tr) => {
            const plot = tr.querySelector(".rc-plot").getBoundingClientRect();
            return { xs: [...tr.querySelectorAll(".rc-grid")].map((g) => Math.round(g.getBoundingClientRect().left - plot.left)),
                     step: tr.querySelector(".rc-grid-step")?.textContent };
        }));
        const tracks = await read();
        expect(new Set(tracks.map((t) => JSON.stringify(t.xs))).size, `every track rules the same times: ${JSON.stringify(tracks)}`).toBe(1);
        expect(tracks[0].step).toMatch(/^grid \d+ (s|min)$/);
        const xs = tracks[0].xs;
        expect(xs.length, "more than one line, so the spacing can be seen").toBeGreaterThan(1);
        const gaps = xs.slice(1).map((x, i) => x - xs[i]);
        expect(Math.max(...gaps) - Math.min(...gaps), `evenly spaced — the axis is linear in time: ${gaps}`).toBeLessThanOrEqual(2);
    } finally { await ext.close(); await fake.stop(); }
});

// THE RESIDUAL, NAMED BY PROCESS (`processes` + `processes_scope` on a patched /api/info). The arithmetic is
// pinned against real captures in resource-model.test.mjs; what only the drawn panel shows is that every new
// band is IN THE STACK — `bandOrder` has to name each key or a band silently drops out of the drawing — with a
// runner's overhead directly on its own model, and the legend and the tip naming what the driver cannot see.
test("resource panel: the residual is named process by process when the driver lists them", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const TOTAL = 101972967424, MODEL = 18 * GiB, RUNNER = MODEL + 0.6 * GiB, TENANT = 3 * GiB, UNSEEN = 2.5 * GiB;
        const info = box(TOTAL - RUNNER - TENANT - UNSEEN, TOTAL - 589824);
        const [c0, c1] = info.compute.supported_gpus;
        Object.assign(c0, { processes_scope: "pid_namespace", processes: [
            { pid: 317, used_memory: RUNNER, name: "llama-server", runner: { model: "gemma4:31b" } },
            { pid: 990, used_memory: TENANT, name: "python3" },
        ] });
        c1.processes_scope = "pid_namespace";
        fake.setCapacity(info);
        fake.setResident([resident("gemma4:31b", MODEL, 0)]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);

        const track = frame.locator(".rc-track").first();
        const legend = track.locator(".rc-legend");
        await expect.poll(async () => (await legend.textContent()) || "", { timeout: 25000 }).toMatch(/gemma4:31b overhead 614\.4 MiB/);
        const text = await legend.textContent();
        expect(text).toMatch(/python3 \(pid 990\) 3\.00 GiB/);
        expect(text).toMatch(/outside ollama's view 2\.50 GiB/);
        expect(text, "the size rule no longer guesses once processes are named").not.toMatch(/unattributed|driver overhead/);

        // IN THE STACK, and the overhead sits directly on the model it belongs to, tinted with its colour.
        await expect.poll(() => track.locator(".rc-area polygon").count(), { timeout: 10000 }).toBeGreaterThanOrEqual(4);
        const fills = await track.locator(".rc-area").first().locator("polygon").evaluateAll((ps) => ps.map((p) => ({ band: p.classList.contains("rc-band"), fill: p.getAttribute("fill") })));
        const at = fills.findIndex((f) => f.band);
        expect(at, `the model's band is drawn: ${JSON.stringify(fills)}`).toBeGreaterThanOrEqual(0);
        expect(fills[at + 1].fill, "its runner's overhead is the next band up, in a wash of its colour").toMatch(/^color-mix\(in srgb, .+ 30%/);
        expect(fills.length, "model, overhead, tenant and the unseen remainder are all drawn").toBeGreaterThanOrEqual(4);

        // Pointing at the plot away from the model names them at that instant too.
        const plot = await track.locator(".rc-plot").boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.6, plot.y + 4);
        const tip = frame.locator(".rc-tip-pool");
        await expect(tip).toBeVisible({ timeout: 5000 });
        expect(await tip.textContent()).toMatch(/python3 \(pid 990\).*outside ollama's view/);
    } finally { await ext.close(); await fake.stop(); }
});

// THE MARK IS DRAWN ON TOP OF THE LINE, and this is asserted in PIXELS because it is a pixel claim: the dot's
// legibility over a band of any shade comes entirely from a 1.5px ring of the panel's own colour, and the
// crosshair — one pixel of accent at 55% — was painted after it, cutting that ring at the top and bottom. It
// is a two-character CSS difference (a z-index) that no DOM assertion can see: the elements, their positions
// and their computed styles are all identical either way. Only the rendered image differs.
test("resource panel: the crosshair does not cut the mark's ring", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_snapdot: true }));
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(6000);   // several samples, or there is nothing to snap between

        // OVER A BAND, deliberately: the ring exists to keep the mark legible against a filled area, so the
        // cut is worth seeing where the fill is. Hovering one band also narrows it to a single dot, which is
        // the one this measures.
        await frame.locator(".rc-band").first().hover();
        await expect.poll(() => frame.locator(".rc-snapdot").count(), { timeout: 10000 }).toBe(1);
        // Then ONTO the sample it snapped to. The axis is linear in time, so the nearest sample can be tens of
        // pixels from where the pointer landed — and the tip, placed against the POINTER, then sat over the
        // line above the mark, hiding the premise below rather than failing the claim.
        const snapped = await frame.locator(".rc-snapdot").first().boundingBox();
        const bandBox = await frame.locator(".rc-band").first().boundingBox();
        await page.mouse.move(snapped.x + snapped.width / 2, bandBox.y + bandBox.height / 2);
        await sleep(200);
        expect(await frame.locator(".rc-cross").count(), "the line is drawn, or there is nothing to be cut BY")
            .toBeGreaterThan(0);

        /**
         * WHAT THE LINE PAINTS, and where. Shot once with the rule drawn and once with it made transparent:
         * every pixel that differs between the two IS the line, so no colour has to be named and no theme,
         * accent or panel shade is baked in. Only its own `background` is dropped — the clock label is a
         * CHILD of the rule, and hiding the whole element would remove that too and show up as a difference
         * that has nothing to do with the line.
         *
         * Then the claim is about ROWS rather than points: painted UNDER the mark, the line is interrupted by
         * it, so the rows the mark occupies contain no difference at all while the rows above and below do.
         * Painted OVER it, every row differs. That needs no centre, no radius and no sub-pixel arithmetic —
         * which is what the first version of this test needed, and it measured the wrong pixels because a
         * 7px dot's rendered centre is not exactly where its box says.
         *
         * Decoded in the PAGE (a canvas over a data URL) rather than with a PNG library: this repo ships no
         * decoder, and adding a dependency to read a 21x21 window is a worse trade than four lines of canvas.
         */
        const R = 10;                                   // a 21x21 window: taller than the mark (10px with its ring)
        const clipAt = (b) => ({ x: Math.round(b.x + b.width / 2) - R, y: Math.round(b.y + b.height / 2) - R,
            width: R * 2 + 1, height: R * 2 + 1 });
        const rows = await (async () => {
            // RETRIED, because the axis is LIVE: a poll landing between the two shots moves the mark, and
            // every row would then differ for a reason that is not the one under test. Cheap to detect —
            // the mark's own box is the witness — and cheaper to retry than to freeze the panel.
            for (let attempt = 0; attempt < 5; attempt++) {
                const before = await frame.locator(".rc-snapdot").first().boundingBox();
                const clip = clipAt(before);
                const withLine = (await page.screenshot({ clip })).toString("base64");
                const tag = await frame.addStyleTag({ content: ".rc-cross { background: transparent !important; }" });
                const noLine = (await page.screenshot({ clip })).toString("base64");
                await tag.evaluate((e) => e.remove());
                const after = await frame.locator(".rc-snapdot").first().boundingBox();
                if (after.x !== before.x || after.y !== before.y) continue;   // it moved under us — shoot again
                return await page.evaluate(async ({ a, b }) => {
                    const load = async (b64) => {
                        const img = new Image();
                        await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = `data:image/png;base64,${b64}`; });
                        const c = document.createElement("canvas");
                        c.width = img.width; c.height = img.height;
                        c.getContext("2d").drawImage(img, 0, 0);
                        return { d: c.getContext("2d").getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
                    };
                    const A = await load(a), B = await load(b);
                    // Per ROW, how many pixels the line is responsible for. A tolerance because the rule is
                    // drawn at 55% opacity over whatever is behind it and a hair of that survives rounding.
                    return Array.from({ length: A.h }, (_, y) => {
                        let n = 0;
                        for (let x = 0; x < A.w; x++) {
                            const i = (y * A.w + x) * 4;
                            if (Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2])) > 8) n++;
                        }
                        return n;
                    });
                }, { a: withLine, b: noLine });
            }
            return null;
        })();
        expect(rows, "the mark would not hold still long enough to shoot it twice").toBeTruthy();

        // THE PREMISE: the line is actually drawn in this window, top and bottom. Without it a mark on a
        // plot with no crosshair would pass this test while proving nothing.
        expect(rows[0], `no line above the mark, so there is nothing to be cut BY: ${rows}`).toBeGreaterThan(0);
        expect(rows.at(-1), `no line below the mark: ${rows}`).toBeGreaterThan(0);
        // THE CLAIM: the mark interrupts it, for the mark's FULL HEIGHT — 7px of fill plus 1.5px of ring on
        // each side, so ten rows of the window carry no difference at all.
        //
        // The run LENGTH is the assertion, not a fixed slice of rows, and the difference is the whole test.
        // The bug's signature is that the fill rows still look untouched: a 55%-opacity accent line over an
        // accent fill is a change too small to see, so only the RING rows differ — measured, the run went
        // 10 → 7 with the fix reverted while the middle stayed identical. A test that sampled fixed rows
        // would have passed or failed on where the mark happened to sit rather than on whether it was cut.
        const run = rows.reduce((best, n) => (n === 0 ? { cur: best.cur + 1, max: Math.max(best.max, best.cur + 1) } : { cur: 0, max: best.max }), { cur: 0, max: 0 }).max;
        expect(run, `the line is painted OVER the mark, cutting its ring — rows ${rows}`).toBeGreaterThanOrEqual(9);
    } finally { await ext.close(); await fake.stop(); }
});

// READING THE CHART FROM THE KEYBOARD. The chart asks two questions of one pointer — x is WHEN, y is WHAT AM
// I READING — so changing one disturbs the other, and the y targets are a 10px hit stroke or a band three
// pixels tall. The arrows give the second question its own input, on the two axes the data actually has: a
// LIST (the models drawn at this instant) and a DEPTH (what one model's memory is holding).
test("resource panel: the arrow keys pick a model without moving the pointer", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8:27b", 7 * GiB, 1)]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(5000);

        /** Whichever model the panel is currently picking out, read from the tip's own name. */
        const focused = async () => {
            const n = await frame.locator(".rc-tip-model .rc-tip-name").allTextContents();
            return n.length ? n : null;
        };
        // The pointer PARKS on the plot's background — low, where no band is drawn — and never moves again.
        // That is the whole feature: the instant stays put while the reading walks.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(300);
        expect(await focused(), "the overview, to begin with").toBeNull();
        const at = { x: plot.x + plot.width * 0.5, y: plot.y + plot.height * 0.06 };
        const crossAt = (await frame.locator(".rc-cross").first().boundingBox()).x;

        // DOWN steps into the list, in the order the panel LISTS the models — the rows under the chart are
        // its legend, so stepping onto a name that is not on screen would light a band with nothing to
        // explain the colour.
        await page.keyboard.press("ArrowDown");
        await sleep(250);
        expect(await focused(), "the first row").toEqual(["gemma4:31b"]);
        await page.keyboard.press("ArrowDown");
        await sleep(250);
        expect(await focused(), "the next one").toEqual(["qwen3.8:27b"]);
        // …and WRAPS back through the overview, which is index 0 rather than a fourth state to discover.
        await page.keyboard.press("ArrowDown");
        await sleep(250);
        expect(await focused(), "round to the overview").toBeNull();
        // UP is the same list backwards.
        await page.keyboard.press("ArrowUp");
        await sleep(250);
        expect(await focused(), "up goes back the other way").toEqual(["qwen3.8:27b"]);

        // THE INSTANT NEVER MOVED. Asserted rather than assumed: if the pointer had shifted, everything above
        // could be the ordinary hover doing the work. The crosshair IS where the pointer is, so its position
        // holding still across four keypresses is the claim — and it is the property the feature exists for,
        // since the reading walks while the moment you are reading stays put.
        const line = await frame.locator(".rc-cross").first().boundingBox();
        expect(Math.abs(line.x - crossAt), `the crosshair moved from ${crossAt} to ${line.x}`).toBeLessThan(2);

        // MOVING HANDS IT BACK. A keyboard reading holds against a band sliding under a parked cursor as
        // samples arrive — which raises pointerenter with nobody having touched anything — but a real move
        // ends it, because the pointer is what the reader just used.
        await page.mouse.move(at.x + 40, at.y);
        await sleep(300);
        expect(await focused(), "the pointer is over the background, so nothing is picked out").toBeNull();

        // ESCAPE UNWINDS ONE RUNG AT A TIME: the tip first, then the keyboard focus, then the zoom. Here
        // there is a focus and no zoom, so the second press leaves the reading and the panel stays put.
        await page.keyboard.press("ArrowDown");
        await sleep(250);
        expect(await focused()).toEqual(["gemma4:31b"]);
        await page.keyboard.press("Escape");   // hides the tip
        await sleep(200);
        await page.keyboard.press("Escape");   // …then drops the focus
        await sleep(250);
        expect(await frame.locator(".rc-band.hot").count(), "nothing is picked out any more").toBe(0);
    } finally { await ext.close(); await fake.stop(); }
});

// A SPLIT MODEL ANSWERS ON EVERY CARD IT IS ON. Pinned against a REAL capture — `granite4.1:3b` forced 3:1
// across two cards — because every synthetic split agrees with itself, and the one term that discriminates
// here is the one a fixture invented from a ratio would get wrong.
const SPLIT_LO = { weights: 1447034880, kv_cache: 520093696, compute: 120586240 };   // CUDA0, 31 layers
const SPLIT_HI = { weights: 649068544, kv_cache: 150994944, compute: 120586240 };    // CUDA1, 10 layers
const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);

test("resource panel: drilling into a split model answers on both cards, per card", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const v0 = sum(SPLIT_LO), v1 = sum(SPLIT_HI);
        fake.setCapacity(box(IDLE - v0, IDLE - v1));
        fake.setResident([{
            model: "granite4.1:3b", name: "granite4.1:3b", size: v0 + v1, size_vram: v0 + v1,
            context_length: 262144, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            memory: { weights: SPLIT_LO.weights + SPLIT_HI.weights, kv_cache: SPLIT_LO.kv_cache + SPLIT_HI.kv_cache,
                compute: SPLIT_LO.compute + SPLIT_HI.compute },
            gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: v0, memory: SPLIT_LO },
                   { gpu_id: "1", runner: "CUDA", size_vram: v1, memory: SPLIT_HI }],
            // OPT-IN ON THE SERVER (`OLLAMA_LAYER_PLACEMENT=1`) and absent by default, so its presence here
            // is the point: 31 layers against 10, which is the 3:1 the memory figures were forced to.
            placement: {
                num_layers: 41,
                devices: [{ device: "CUDA0", first_layer: 0, last_layer: 30, layers: 31 },
                          { device: "CUDA1", first_layer: 31, last_layer: 40, layers: 10 }],
                swa_layers: [1, 3, 5, 7],
            },
        }]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(300);
        await page.keyboard.press("ArrowDown");    // pick the model
        await sleep(250);
        // ON EVERY CARD IT IS ON, from the moment it is picked. A keyboard focus names a MODEL rather than a
        // position, and this one is on two cards — so "where is it" already has two answers, and showing one
        // would be picking a card for the reader without saying so. (A POINTER hover still answers only on
        // the track under it: there the question was asked at a place.)
        const tips = frame.locator(".rc-tip-model");
        await expect.poll(() => tips.count(), { timeout: 5000 }).toBe(2);

        // RIGHT digs in — and the cards hold DIFFERENT things, so each tip decomposes its own.
        await page.keyboard.press("ArrowRight");
        await sleep(400);
        await expect.poll(() => frame.locator(".rc-tip-part:not(.rc-tip-lrow)").count(), { timeout: 5000 }).toBe(6);
        const text = (await tips.allTextContents()).map((t) => t.replace(/\s+/g, " "));
        // Each names its own card, so two tips with different figures are not two answers to one question.
        expect(text.some((t) => /on CUDA0/.test(t)), `no card named: ${text}`).toBe(true);
        expect(text.some((t) => /on CUDA1/.test(t)), `no card named: ${text}`).toBe(true);

        /** One tip's parts, as { label: bytesText }. */
        const partsOf = async (i) => Object.fromEntries(await tips.nth(i).locator(".rc-tip-part:not(.rc-tip-lrow)").evaluateAll(
            (els) => els.map((e) => [e.querySelector(".rc-tip-plabel")?.textContent,
                e.querySelector(".rc-tip-pbytes")?.textContent])));
        const [a, b] = [await partsOf(0), await partsOf(1)];

        // THE WEIGHTS DIFFER, because the cards hold 31 layers and 10 — a per-card reading, not a share of
        // one total.
        expect(a.weights, `${JSON.stringify(a)}`).not.toBe(b.weights);
        // …AND THE COMPUTE IS IDENTICAL, which is the whole reason nothing here is pro-rated. Three times the
        // layers, byte-identical compute buffers: a chart dividing a whole-model figure by a layer or byte
        // ratio would be right about two of these three and quietly wrong about the third, more so the more
        // lopsided the split.
        expect(a["compute buffers"], "compute is FLAT per device").toBe(b["compute buffers"]);
        expect(a.weights).not.toBe(a["compute buffers"]);   // …and they are not equal by accident of formatting

        // THE HINT NAMES EVERYTHING THE KEY REACHES. "another model" was wrong: the list wraps through the
        // OVERVIEW, so a reader told only about models stops pressing before finding their way back to it.
        expect(text[0], `the hint under-sells the keys: ${text[0]}`).toMatch(/models & overview/);
        // HOW BIG THE MODEL IS — on BOTH tips, not just the one the pointer happens to be near. Neither
        // card's figure can answer it, and 1.94 GiB beside 878 MiB under two identical denominators invites
        // the reader to take either one for the model.
        for (const [i, t] of text.entries()) expect(t, `tip ${i} names no whole-model total: ${t}`).toMatch(/across 2 cards/);
        // …and the SHARE each card holds, which is the relationship between the per-card figure and the whole
        // rather than a third number to reconcile. 3:1 by design, so the two must not read the same.
        const heres = await tips.locator(".rc-tip-here").allTextContents();
        expect(heres.length, `both tips say what share is here: ${heres}`).toBe(2);
        expect(heres[0]).not.toBe(heres[1]);

        // THEY DO NOT SIT ON EACH OTHER, and their ORDER still says which track each belongs to. A drilled-in
        // tip is taller than the ~110px track it is anchored to, so the second one landed on the first; they
        // are tiled down a column now, pushed only as far as the one above requires. Putting them on
        // alternating SIDES also stopped them colliding, and was worse: which side a tip sat on then said
        // nothing about which card it was for, which is the whole reason they are anchored per track.
        const boxes = await tips.evaluateAll((els) => els.map((e) => {
            const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left };
        }));
        expect(boxes[0].top, "top to bottom, in track order").toBeLessThan(boxes[1].top);
        expect(boxes[0].bottom, "and never overlapping").toBeLessThanOrEqual(boxes[1].top);
        expect(Math.abs(boxes[0].left - boxes[1].left), "…on the same side, since tiling is what keeps them apart")
            .toBeLessThan(2);
        // THE SHARED LINES ARE SAID ONCE, at the bottom of the stack. The instant being read and the keys
        // that move the reading are facts about the READING, not about a card, so repeating them per card is
        // the same two lines twice in the one view where height is what everything competes for — and it is
        // the difference between a tip beside the trace it describes and a tip on top of it.
        // COUNTED AS SHOWN, not as present: the trimmed lines are still in the DOM (they are hidden by class,
        // which is what keeps the tiler's measurement and the markup in one place), and `count()` would
        // happily report two of something nobody can see.
        const shown = async (sel) => tips.locator(sel).evaluateAll(
            (els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
        expect(await shown(".rc-tip-keys"), "one set of key hints, not one per card").toBe(1);
        expect(await shown(".rc-tip-when"), "…and one timestamp").toBe(1);
        expect(await tips.nth(1).locator(".rc-tip-keys").evaluateAll(
            (els) => els.some((e) => getComputedStyle(e).display !== "none")),
            "on the LAST one, so the stack ends with what applies to all of it").toBe(true);
        // …but everything that IS about the card is on both.
        expect(await tips.locator(".rc-tip-sec").count(), "each still has its own sections").toBeGreaterThan(2);

        // LAYERS, in their OWN section with their own units — never a bar beside the memory ones, because
        // layers are not a proxy for memory. Matched by the ENGINE's device name, and a card whose name is
        // not in the list shows nothing rather than being handed the entry at its ordinal.
        expect(text[0], `CUDA0's layers: ${text[0]}`).toMatch(/layers.*31 of 41.*#0.30/);
        expect(text[1], `CUDA1's layers: ${text[1]}`).toMatch(/layers.*10 of 41.*#31.40/);
        // …and the sliding-window layers COUNTED FOR THIS CARD. All four of them are in CUDA0's range, so a
        // tip repeating the model's total would put four on both cards.
        expect(text[0]).toMatch(/4 sliding-window/);
        expect(text[1], "none of them landed here").not.toMatch(/sliding-window/);
    } finally { await ext.close(); await fake.stop(); }
});

// TWO HONEST ABSENCES, which are most of what this view has to get right: a part the server could not name,
// and a server that could not split the figure at all.
test("resource panel: an unnamed part is a signal, and no split says so", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // `other` is the catch-all for buffer kinds the server did not recognise, so a LARGE one means its
        // breakdown is behind the engine it is reporting on — the one part whose size is itself the message.
        const MEM = { weights: 8 * GiB, kv_cache: 2 * GiB, compute: 512 * 1024 * 1024, other: 1536 * 1024 * 1024 };
        const V = 8 * GiB + 2 * GiB + 512 * 1024 * 1024 + 1536 * 1024 * 1024;
        fake.setCapacity(box(IDLE - V, IDLE - 3 * GiB));
        fake.setResident([
            { model: "odd:7b", name: "odd:7b", size: V, size_vram: V, context_length: 8192,
              expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
              memory: MEM, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: V, memory: MEM }] },
            // …and one the server would not split at all (an MLX runner, a build predating the field).
            resident("mystery:3b", 3 * GiB, 1),
        ]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(300);
        await page.keyboard.press("ArrowDown");
        await sleep(250);
        await page.keyboard.press("ArrowRight");
        await sleep(400);
        // The rows are listed alphabetically, so the first step lands on the model the server would NOT
        // split. ABSENT IS NOT ZERO: an empty decomposition would read as "it is holding nothing", which is a
        // claim the server never made.
        const first = (await frame.locator(".rc-tip-model").first().textContent()).replace(/\s+/g, " ");
        expect(first, `expected the unsplit model: ${first}`).toMatch(/mystery:3b/);
        expect(first, "it says the server did not report it").toMatch(/did not report what this is holding/);
        expect(await frame.locator(".rc-tip-part:not(.rc-tip-lrow)").count(), "and draws no parts").toBe(0);
        // …and no LAYERS section either, since `placement` is opt-in on the server and absent by default.
        expect(first, "no layers were reported").not.toMatch(/layers/);

        // THE NEXT MODEL reported a part it could not name.
        await page.keyboard.press("ArrowDown");
        await sleep(400);
        const second = (await frame.locator(".rc-tip-model").first().textContent()).replace(/\s+/g, " ");
        expect(second, `expected the model with the unnamed part: ${second}`).toMatch(/odd:7b/);
        expect(second, "the part is listed").toMatch(/unrecognised/);
        // …and CALLED OUT rather than sitting quietly as one more slice, because what it means is that the
        // breakdown is stale relative to the engine — not that the memory is unaccounted for.
        expect(await frame.locator(".rc-tip-warn").count(), "a part the server could not name is flagged").toBe(1);
    } finally { await ext.close(); await fake.stop(); }
});

// THE KEYS HAVE TO BE DISCOVERABLE FROM THE MOUSE, which is how everybody arrives. The hint was gated on the
// keyboard already driving — so it was shown exclusively to readers who had found it, the one group that did
// not need telling. And the seam has to WORK: pressing right while pointing at a band means "this one, in
// detail", which did nothing while the tip sat there naming the key.
test("resource panel: the keys are advertised on a hover, and work from one", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const MEM = { weights: 12 * GiB, kv_cache: 4 * GiB, compute: 2 * GiB };
        const V = 18 * GiB;
        fake.setCapacity(box(IDLE - V, IDLE));
        fake.setResident([{
            model: "gemma4:31b", name: "gemma4:31b", size: V, size_vram: V, context_length: 262144,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            memory: MEM, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: V, memory: MEM }],
        }]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        // POINTING AT THE PLOT, nothing picked out: the overview tip says how to pick something.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(350);
        const pool = (await frame.locator(".rc-tip-pool").first().textContent()).replace(/\s+/g, " ");
        expect(pool, `the overview tip does not mention the keys: ${pool}`).toMatch(/pick a model/);

        // POINTING AT A BAND — no key pressed yet — already names both directions.
        await frame.locator(".rc-band").first().hover();
        await sleep(350);
        const band = (await frame.locator(".rc-tip-model").first().textContent()).replace(/\s+/g, " ");
        expect(band, `a hovered band does not mention the keys: ${band}`).toMatch(/models & overview/);
        expect(band, "…including the way in").toMatch(/details/);

        // AND THE KEY WORKS FROM THERE. This is the seam: arriving by pointer and arriving by keyboard have
        // to behave the same, or the hint above is advertising something that silently does nothing.
        await page.keyboard.press("ArrowRight");
        await sleep(350);
        const deep = (await frame.locator(".rc-tip-model").first().textContent()).replace(/\s+/g, " ");
        expect(deep, `right did nothing from a hover: ${deep}`).toMatch(/holding/);
        expect(deep, "…and offers the way back out").toMatch(/back/);
        expect(await frame.locator(".rc-tip-part:not(.rc-tip-lrow)").count(), "the parts are drawn").toBe(3);
    } finally { await ext.close(); await fake.stop(); }
});

// WHICH POOLS ARE ON SCREEN is a decision you make WHILE reading — a card you are not interested in is
// costing height the ones you are could use — and it lived only behind the gear, which means leaving the
// chart to change what the chart shows.
test("resource panel: a track can be dropped from its own header", async () => {
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
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 25000 }).toBe(3);
        const names = async () => frame.locator(".rc-track .rc-name").allTextContents();
        expect(await names()).toEqual(["CUDA0", "CUDA1", "System RAM"]);

        // IT SAYS WHAT IT WILL DO, before you press it. The explanation was there and INERT: the floating
        // layer finds a trigger by its `tt` class and reads the `.tt-pop` inside, so without that class the
        // markup is display:none with nothing to clone it — a tooltip nobody could ever see. And what it says
        // matters here more than most: the same glyph on a MODEL row evicts from VRAM, so this one has to be
        // explicit that nothing is unloaded.
        await frame.locator(".rc-track", { hasText: "CUDA1" }).first().locator(".rc-hide").hover();
        await expect.poll(() => frame.locator(".tt-layer").textContent().catch(() => ""), { timeout: 5000 })
            .toMatch(/Stop drawing/);
        const tip = await frame.locator(".tt-layer").textContent();
        expect(tip, "it names the track").toMatch(/CUDA1/);
        expect(tip, "…and says what it does NOT do").toMatch(/nothing is unloaded/);
        expect(tip, "…and where the layout ends up").toMatch(/Custom/);

        // Dropping the middle one leaves the others in place…
        await frame.locator(".rc-track", { hasText: "CUDA1" }).first().locator(".rc-hide").click();
        await expect.poll(names, { timeout: 5000 }).toEqual(["CUDA0", "System RAM"]);
        // …and the view is CUSTOM, because the layout is no longer the preset it started as. Saying so is the
        // point: the picker would otherwise name a preset that does not describe what is drawn.
        await expect.poll(() => frame.locator("select.rc-preset").inputValue(), { timeout: 5000 }).toBe("custom");
        expect(await frame.locator("select.rc-preset option[value=custom]").count(),
            "…and Custom is offered as a destination, not only fallen into").toBe(1);
        // It PERSISTS, like every other layout edit — this is the same operation the editor's remove is, not
        // a per-session visibility toggle.
        const saved = await ext.sw.evaluate(() => chrome.storage.local.get("ml_res_layout"));
        expect(saved.ml_res_layout.presetId).toBe("custom");
        expect(saved.ml_res_layout.tracks.length).toBe(2);

        // NOT OFFERED ON THE LAST ONE: a panel with no tracks is not a layout, and a control that refuses
        // when pressed is worse than one that is visibly unavailable. It keeps its SPACE, though, or the
        // header reflows and shifts every surface below it.
        await frame.locator(".rc-track", { hasText: "System RAM" }).first().locator(".rc-hide").click();
        await expect.poll(names, { timeout: 5000 }).toEqual(["CUDA0"]);
        const last = frame.locator(".rc-track .rc-hide").first();
        await expect(last).toBeDisabled();
        expect(await last.evaluate((e) => getComputedStyle(e).visibility), "hidden, not gone").toBe("hidden");
    } finally { await ext.close(); await fake.stop(); }
});

// TWO TOOLTIPS FOR ONE POINTER is the thing this panel is not allowed to do, and a model row had it: its
// cursor tip FOLLOWS the pointer, so moving onto a control that has an anchored tooltip of its own left the
// two on top of each other — the answer you did not ask for covering the one you did.
test("resource panel: a row control's own tooltip stands the row tip down", async () => {
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
        await expect.poll(() => frame.locator(".vram-row").count(), { timeout: 25000 }).toBeGreaterThan(0);

        // Over the row's NAME: the cursor tip is the answer, and it is the only one.
        const row = frame.locator(".vram-row").first();
        await row.locator(".vram-name").hover();
        await sleep(300);
        await expect.poll(() => frame.locator(".vram-rowtip").count(), { timeout: 5000 }).toBe(1);

        // Onto the EVICT control, which carries its own anchored tooltip. That one is the answer now — it
        // describes a destructive action, so it must not be the one that gets covered.
        const x = frame.locator(".vram-row .vram-x").first();
        await x.hover();
        await sleep(300);
        expect(await frame.locator(".vram-rowtip").count(), "the row tip stands down").toBe(0);
        // ON THE `.tt-layer`, not the `.tt-pop`: the source node never renders — it is read and cloned into
        // the one floating layer on hover, which is what stops its prose being selected along with the row.
        await expect.poll(() => frame.locator(".tt-layer").textContent().catch(() => ""), { timeout: 5000 })
            .toMatch(/Evict from VRAM/);

        // …and the same for the colour dot, which is a control too (it hides the model from the totals).
        await row.locator(".vram-dot").hover();
        await sleep(300);
        expect(await frame.locator(".vram-rowtip").count(), "…and under the dot").toBe(0);

        // BACK TO THE ROW and the tip returns: standing down is for as long as you are on the control, not a
        // one-way door.
        await row.locator(".vram-name").hover();
        await sleep(300);
        await expect.poll(() => frame.locator(".vram-rowtip").count(), { timeout: 5000 }).toBe(1);
        expect(page).toBeTruthy();
    } finally { await ext.close(); await fake.stop(); }
});

// A MODEL THAT WAS HERE AND LEFT IS "EVICTED", NEVER "OFF-BOX". The two rows look alike and say opposite
// things: off-box claims the model was NEVER resident here (a cloud model, or one gone before the panel
// opened), which about a model you just watched load and evict is simply false — and it is the row's whole
// job to explain a colour the chart is still drawing.
test("resource panel: an evicted model is not called off-box", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8:27b", 7 * GiB, 1)]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".vram-row:not(.ghost)").count(), { timeout: 25000 }).toBe(2);
        await sleep(4000);   // several samples, so the history genuinely holds them

        // Both leave. The chart still draws them across the window they were loaded in.
        fake.setResident([]);
        await expect.poll(() => frame.locator(".vram-row:not(.ghost)").count(), { timeout: 20000 }).toBe(0);
        await sleep(1500);

        /** The kind badge on each ghost row, without the tooltip prose that sits inside it. */
        const kinds = async () => {
            await frame.locator(".disc-head", { hasText: "not resident" }).first().click().catch(() => {});
            await sleep(400);
            return frame.locator(".vram-row.ghost .vram-embed").evaluateAll(
                (els) => els.map((e) => (e.firstChild?.textContent ?? "").trim()));
        };
        expect(await kinds(), "evicted, while the window still covers them").toEqual(["evicted", "evicted"]);

        // NOW NARROW THE WINDOW PAST THEM — BY DRAGGING, because that is the path that writes `resWindowS`
        // (the scrub gesture IS what the zoom chip reports, and poking the storage key does not reach the
        // signal, which is read at mount: a first version of this narrowed it that way and passed with the
        // fix reverted, proving nothing).
        //
        // The ghost list is cut to that window deliberately — it explains colours that are DRAWN. The
        // "off-box" claim was cut to it too, and that is a different question: a model this panel watched
        // load and evict is not one that was never here, however little of it is still on screen.
        const track = await frame.locator(".rc-scrub-track").boundingBox();
        const win = await frame.locator(".rc-scrub-win").boundingBox();
        const y = track.y + track.height / 2;
        await page.mouse.move(win.x + 1, y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) {
            await page.mouse.move(win.x + 1 + ((track.x + track.width - 3 - win.x) * i) / 8, y);
            await sleep(60);
        }
        await page.mouse.up();
        await sleep(2500);
        // The window really did shrink, or the assertion below is about nothing.
        const after = await frame.locator(".rc-scrub-win").boundingBox();
        expect(after.width, `the window did not narrow: ${win.width} -> ${after.width}`).toBeLessThan(win.width / 2);
        expect(await kinds(), "…and STILL evicted once the window has moved past them").toEqual(["evicted", "evicted"]);
    } finally { await ext.close(); await fake.stop(); }
});

// A FRAME THE SERVER COULD NOT SPLIT IS NOT AN EMPTY ONE. `memory` is omitted whenever it cannot divide the
// figure, and stacking nothing for those frames drops the drilled-in area to ZERO — which says the model was
// not resident. It was: what is unknown is the composition, not the presence.
test("resource panel: a stretch with no split is drawn at its real height, not as nothing", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const MEM = { weights: 12 * GiB, kv_cache: 4 * GiB, compute: 2 * GiB };
        const V = 18 * GiB;
        const withSplit = {
            model: "gemma4:31b", name: "gemma4:31b", size: V, size_vram: V, context_length: 262144,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            memory: MEM, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: V, memory: MEM }],
        };
        fake.setCapacity(box(IDLE - V, IDLE));
        fake.setResident([withSplit]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        // THE SAME MODEL, still resident, with the server no longer able to split it — an MLX runner, or a
        // build that predates the field. Its total is unchanged.
        fake.setResident([{ ...withSplit, memory: undefined, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: V }] }]);
        await sleep(4000);

        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(300);
        await page.keyboard.press("ArrowDown");
        await sleep(250);
        await page.keyboard.press("ArrowRight");
        await sleep(500);

        // The parts are still there for the stretch that HAD them…
        expect(await frame.locator(".rc-part:not(.rc-part-unsplit)").count(), "the split stretch keeps its parts")
            .toBeGreaterThan(0);
        // …and the rest is one undifferentiated shape at the model's real height, rather than a hole.
        const un = frame.locator(".rc-part-unsplit").first();
        await expect(un).toHaveCount(1);
        const h = await un.evaluate((e) => e.getBoundingClientRect().height);
        expect(h, "drawn at a real height, not collapsed to zero").toBeGreaterThan(4);
    } finally { await ext.close(); await fake.stop(); }
});

// SWITCHING A MODEL OFF takes it out of the stack, the totals and every earlier frame — so there is no shape
// left for the keyboard to point AT, and latching onto it names something that is not drawn.
test("resource panel: a model switched off is skipped by the keys", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8:27b", 7 * GiB, 1)]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".vram-row:not(.ghost)").count(), { timeout: 25000 }).toBe(2);
        await sleep(3000);

        const focused = async () => {
            const n = await frame.locator(".rc-tip-model .rc-tip-name").allTextContents();
            return n.length ? n[0] : null;
        };
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(300);

        // Both are reachable to begin with.
        await page.keyboard.press("ArrowDown"); await sleep(250);
        expect(await focused()).toBe("gemma4:31b");
        await page.keyboard.press("ArrowDown"); await sleep(250);
        expect(await focused()).toBe("qwen3.8:27b");
        await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await sleep(250);

        // Switch the first one off by its colour dot — the same control that takes it out of the totals.
        await frame.locator(".vram-row", { hasText: "gemma4:31b" }).first().locator(".vram-dot").click();
        await sleep(600);

        // …and the keys walk straight past it.
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.06);
        await sleep(250);
        await page.keyboard.press("ArrowDown"); await sleep(300);
        expect(await focused(), "the switched-off model is not a place the keys can land").toBe("qwen3.8:27b");
        await page.keyboard.press("ArrowDown"); await sleep(300);
        expect(await focused(), "…and the list wraps back to the overview past it").toBeNull();
    } finally { await ext.close(); await fake.stop(); }
});

// A ROW THAT IS DRAWN NEEDS A WORKING SWITCH. A ghost's only presence may be the LANE, and its dot was inert
// there — a control on a row that IS on screen, which could not remove the one thing it drew.
test("resource panel: a ghost row's dot switches it off everywhere", async () => {
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
        await expect.poll(() => frame.locator(".vram-row:not(.ghost)").count(), { timeout: 25000 }).toBe(1);
        await sleep(3000);
        fake.setResident([]);
        await expect.poll(() => frame.locator(".vram-row:not(.ghost)").count(), { timeout: 20000 }).toBe(0);
        await sleep(1200);

        await frame.locator(".disc-head", { hasText: "not resident" }).first().click();
        await sleep(400);
        const dot = frame.locator(".vram-row.ghost .vram-dot").first();
        await expect(dot).toHaveCount(1);
        const lit = await frame.locator(".rc-ev, .rc-rule").count();
        expect(lit, "it is drawn somewhere — a lane block or a rule").toBeGreaterThan(0);

        // Switching it off removes what it draws, and says so.
        await dot.click();
        await sleep(700);
        await expect(dot).toHaveClass(/off/);
        expect(await frame.locator(".rc-ev, .rc-rule").count(), "…and its marks go with it").toBeLessThan(lit);

        // …and back on again: the row is the control, so it must not be a one-way door.
        await dot.click();
        await sleep(700);
        await expect.poll(() => frame.locator(".rc-ev, .rc-rule").count(), { timeout: 5000 }).toBe(lit);
    } finally { await ext.close(); await fake.stop(); }
});

// THE POINTER LEAVING THE PLOT IS NOT A DECISION TO STOP READING — and this mode makes it happen without
// anyone touching the mouse: drilling in collapses the cards the model is NOT on, so the track the pointer
// was over shrinks away, fires a `pointerleave`, and the handler threw away the focus. The chart stayed
// drilled in (that comes from the keyboard) while its tooltip lost its subject.
test("resource panel: drilling into a model on ANOTHER card keeps its tooltip", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const A = { weights: 12 * GiB, kv_cache: 4 * GiB, compute: 2 * GiB };
        const B = { weights: 4 * GiB, kv_cache: 2 * GiB, compute: 1 * GiB };
        const va = 18 * GiB, vb = 7 * GiB;
        fake.setCapacity(box(IDLE - va, IDLE - vb));
        fake.setResident([
            { model: "gemma4:31b", name: "gemma4:31b", size: va, size_vram: va, context_length: 262144,
              expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
              memory: A, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: va, memory: A }] },
            { model: "qwen3.8:27b", name: "qwen3.8:27b", size: vb, size_vram: vb, context_length: 262144,
              expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
              memory: B, gpus: [{ gpu_id: "1", runner: "CUDA", size_vram: vb, memory: B }] },
        ]);
        await seedStacked(ext);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        // THE POINTER PARKS ON THE FIRST CARD'S TRACK and never moves again — HALFWAY DOWN IT, which is what
        // makes this the real case: drilling in collapses that track to a strip, so the plot is pulled out
        // from under a still cursor and fires a leave. Parked near the TOP the pointer stays inside even the
        // collapsed strip, no leave fires, and the test passes with the bug present (it did).
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
        await sleep(300);

        // Cycle to the model that lives on the OTHER card — its tip appears on the track that holds it.
        await page.keyboard.press("ArrowDown"); await sleep(250);
        await page.keyboard.press("ArrowDown"); await sleep(300);
        expect(await frame.locator(".rc-tip-model .rc-tip-name").allTextContents()).toEqual(["qwen3.8:27b"]);

        // …and RIGHT keeps it. This is where the track under the pointer collapses.
        await page.keyboard.press("ArrowRight");
        await sleep(500);
        expect(await frame.locator(".rc-tip-model").count(), "the tooltip survives the drill-down").toBe(1);
        const tip = (await frame.locator(".rc-tip-model").first().textContent()).replace(/\s+/g, " ");
        expect(tip, `it still names the model: ${tip}`).toMatch(/qwen3\.8:27b/);
        expect(tip, "…and answers what it is holding, which is what was asked for").toMatch(/holding/);
        expect(await frame.locator(".rc-tip-part:not(.rc-tip-lrow)").count(), "with its parts").toBe(3);
        // The chart went with it — the mode and its tooltip are one reading, not two states that can differ.
        expect(await frame.locator(".rc-track.deep").count(), "and the chart is in the same mode").toBeGreaterThan(0);
    } finally { await ext.close(); await fake.stop(); }
});

// TWO CLOCKS IN ONE PANEL. A track's header and legend read the last sample of the DRAWN window; the panel's
// own total read the LIVE resident set whatever the window was. Scrubbed back they sat one above the other
// describing different moments with nothing saying so, which reads as arithmetic going wrong.
test("resource panel: scrubbed back, the header reads the instant the tracks do", async () => {
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
        await expect.poll(() => frame.locator(".vram-row:not(.ghost)").count(), { timeout: 25000 }).toBe(1);
        await sleep(4000);

        const headline = async () => (await frame.locator(".vram-head").first().textContent()).replace(/\s+/g, " ");
        expect(await headline(), "18 GiB is resident and the panel is live").toMatch(/18\.00 GiB in use/);
        expect(await frame.locator(".vram-at").count(), "…and nothing to say about WHEN, because it is now").toBe(0);

        // THE MODEL LEAVES — and the card's free memory comes back with it. Both, because with only the
        // resident set cleared the DEVICES still report 18 GiB held, and the header falls back to what they
        // say (which is the honest answer during a load, and here would just be the old figure by a second
        // route rather than the live one this test is contrasting against).
        fake.setResident([]);
        fake.setCapacity(box(IDLE, IDLE));
        // Whatever it settles on, it is no longer the model's figure — asserted as that rather than as an
        // exact number, since what a box with nothing resident reports is the driver's own overhead and not
        // this test's business.
        await expect.poll(headline, { timeout: 20000 }).not.toMatch(/18\.00 GiB in use/);
        await sleep(2500);

        // NOW SCRUB BACK over the stretch where it was resident, by dragging the window's right edge left —
        // the panel stops following and draws a range that ENDS in the past.
        const track = await frame.locator(".rc-scrub-track").boundingBox();
        const win = await frame.locator(".rc-scrub-win").boundingBox();
        const y = track.y + track.height / 2;
        await page.mouse.move(win.x + win.width - 1, y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) {
            await page.mouse.move(win.x + win.width - 1 - ((win.width * 0.7) * i) / 8, y);
            await sleep(60);
        }
        await page.mouse.up();
        await sleep(1500);
        await expect.poll(() => frame.locator(".rc-scrub-live").textContent(), { timeout: 8000 }).toMatch(/⏸/);

        // The header now describes the window's own edge — the same instant the tracks below it do — and SAYS
        // which instant that is, because a figure from a moment you scrubbed to is only honest if it names it.
        await expect.poll(() => frame.locator(".vram-at").count(), { timeout: 8000 }).toBe(1);
        const stamp = (await frame.locator(".vram-at").textContent()).trim();
        expect(stamp, `it names the instant: ${stamp}`).toMatch(/^at \d{2}:\d{2}:\d{2}/);
        // …and the figure is that instant's, not the present's: the model was resident then and is not now.
        expect(await headline(), "the reading is from the drawn edge").toMatch(/18\.00 GiB in use/);

        // IT READS AS ONE LINE WITH THE FIGURE. The row is centre-aligned — it holds buttons and selects,
        // which baseline-aligning would drag around — and centring only yields a shared baseline when the
        // boxes are the same SIZE. At 1em against the figure's 0.92em it sat visibly off, in what looked like
        // a different font. Lighter and fainter is what makes it recede; a different size just looked broken.
        const metrics = await frame.locator(".vram-head").first().evaluate((el) => {
            const at = el.querySelector(".vram-at"), tot = el.querySelector(".vram-total");
            const a = at.getBoundingClientRect(), t = tot.getBoundingClientRect();
            const cs = getComputedStyle(at), ct = getComputedStyle(tot);
            return { size: cs.fontSize, totalSize: ct.fontSize, colour: cs.color, totalColour: ct.color,
                dTop: Math.abs(a.top - t.top), h: a.height, lines: at.getClientRects().length };
        });
        expect(metrics.size, "the same type as the figure it stamps").toBe(metrics.totalSize);
        expect(metrics.colour, "…but dimmer, which is what makes it recede").not.toBe(metrics.totalColour);
        expect(metrics.dTop, `not on the same line: ${JSON.stringify(metrics)}`).toBeLessThan(2);
        // …and never broken across two, which a clock cannot survive.
        expect(metrics.lines, "one line").toBe(1);

        // BACK TO LIVE and the stamp goes with it — there is nothing to say when the edge IS the present.
        await frame.locator(".rc-scrub-live").click();
        await sleep(1200);
        await expect.poll(() => frame.locator(".vram-at").count(), { timeout: 8000 }).toBe(0);
        expect(await headline(), "…and the figure is the present's again").not.toMatch(/18\.00 GiB in use/);
    } finally { await ext.close(); await fake.stop(); }
});

// EVERY OPTION THE PANEL OFFERS HAS TO DRAW SOMETHING. A view or a mode you can pick and that renders an
// empty box is indistinguishable from the panel breaking — and the controls multiply (a preset per layout, a
// mode per track), so the combination nobody tried is the one that ships blank.
test("resource panel: every view and every track mode draws something for the same data", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8:27b", 7 * GiB, 1)]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(5000);   // several samples, so every mode has a shape it COULD draw

        /** Any actual geometry on screen — a filled band, a pool line — not merely an <svg> element. */
        const shapes = () => frame.locator(".rc-area polygon, .rc-area polyline").evaluateAll(
            (els) => els.filter((e) => (e.getAttribute("points") || "").trim().length > 0).length);

        const views = await frame.locator("select.rc-preset option").evaluateAll(
            (els) => els.map((e) => ({ value: e.value, label: e.textContent })));
        expect(views.length, "there are views to check").toBeGreaterThan(1);

        for (const v of views) {
            await frame.locator("select.rc-preset").selectOption(v.value);
            await sleep(900);
            expect(await shapes(), `the "${v.label}" view draws nothing`).toBeGreaterThan(0);

            // …and every MODE of every track in it. The mode control is per track and independent of the
            // view, so this is where the untried combination lives.
            const tracks = await frame.locator(".rc-emode").count().catch(() => 0);
            if (!tracks) {
                await frame.locator('[aria-label="Edit tracks"]').click();
                await sleep(500);
            }
            const modes = await frame.locator(".rc-emode").count();
            for (let i = 0; i < modes; i++) {
                const sel = frame.locator(".rc-emode").nth(i);
                for (const m of ["stack", "overlay"]) {
                    // A MODE THE RULE REFUSES IS NOT OFFERED. A stack draws against ONE ceiling and several
                    // pools have several — and the guard used to cover only the
                    // series checkboxes, so the mode itself could be switched to it. Skipped rather than
                    // asserted-on here: what it must never be is SELECTABLE and empty.
                    if (await sel.locator(`option[value=${m}]`).isDisabled()) continue;
                    await sel.selectOption(m);
                    await sleep(800);
                    expect(await shapes(), `"${v.label}", track ${i} in "${m}" mode draws nothing`).toBeGreaterThan(0);
                    // …and it drew every series it was given, rather than the first one alone.
                    const drew = await frame.locator(".rc-track").count();
                    expect(drew, `"${v.label}" lost a track in "${m}" mode`).toBeGreaterThan(0);
                }
            }
            await frame.locator('[aria-label="Edit tracks"]').click().catch(() => {});
            await sleep(400);
        }
    } finally { await ext.close(); await fake.stop(); }
});

// STACKING SEVERAL POOLS HAS NO SINGLE CEILING — a stack draws against one, and each pool has its own — and the rule
// that says so guarded the series checkboxes while leaving the MODE unguarded. So a three-pool Overview track
// could simply be switched to "stack", the renderer drew its FIRST series alone, and two were silently
// dropped. On a card that happened to be empty, that reads as the panel rendering nothing at all.
test("resource panel: a track that cannot be stacked will not offer it, and never drops series", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // The shape that produced it: nothing on the FIRST card, the model on the second. Stacking then drew
        // an all-but-empty card 0 and dropped the pool that had something in it.
        fake.setCapacity(box(IDLE, IDLE - 7 * GiB));
        fake.setResident([resident("qwen3.8:27b", 7 * GiB, 1)]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        // Overview: one track carrying every pool, overlaid.
        await frame.locator("select.rc-preset").selectOption("overview");
        await sleep(900);
        await frame.locator('[aria-label="Edit tracks"]').click();
        await sleep(500);
        const sel = frame.locator(".rc-emode").first();
        await expect(sel).toHaveValue("overlay");

        // THE OPTION IS REFUSED, with the reason — not merely absent, which teaches nothing.
        await expect(sel.locator("option[value=stack]")).toBeDisabled();
        await sel.hover();
        await expect.poll(() => frame.locator(".tt-layer").textContent().catch(() => ""), { timeout: 5000 })
            .toMatch(/ONE ceiling|double-count|different pools/);

    } finally { await ext.close(); await fake.stop(); }
});

// …AND A LAYOUT THAT ALREADY HAS ONE — saved before the guard existed, or written straight to storage — is
// REFUSED AT RESTORE (`restoreLayout` → `presetRefusal`) and the default preset is drawn instead. Worth
// pinning because it is what makes the editor guard sufficient rather than merely tidy: with both, there is
// no route by which an unstackable track reaches the renderer, which would silently draw its first series
// alone. A first version of this test asserted a fallback inside the renderer and passed without it — this
// path was doing the work.
test("resource panel: a saved unstackable track is refused, and the box is drawn whole", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE, IDLE - 7 * GiB));
        fake.setResident([resident("qwen3.8:27b", 7 * GiB, 1)]);
        // Seeded BEFORE the panel opens, which is the only way a layout is really restored — poking the key
        // mid-session changes storage and nothing else.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "overview", series: ["vram.0", "vram.1", "ram"], mode: "stack", heightPx: 96 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(3000);

        // The saved layout is not what is drawn — it could not be, and the panel says so by showing a preset.
        await expect.poll(() => frame.locator("select.rc-preset").inputValue(), { timeout: 8000 }).not.toBe("custom");
        // AND NOTHING WAS LOST: every pool the saved track named is still on screen somewhere.
        const heads = (await frame.locator(".rc-track .rc-name").allTextContents()).join(" ");
        for (const pool of ["CUDA0", "CUDA1", "System RAM"]) {
            expect(heads, `${pool} vanished with the refused layout: ${heads}`).toContain(pool);
        }
    } finally { await ext.close(); await fake.stop(); }
});

// THE SAME KEY, THE THING THIS VIEW DRAWS. Overview draws pool LINES rather than model bands, so `↑↓` steps
// through pools there — leaving it working in one view and dead in the other meant the same key was "change
// what I am reading" or "scroll the page" depending on where the pointer happened to be. Nothing else is
// copied over: a pool has no memory breakdown of its own, so there is no depth to descend into.
test("resource panel: in Overview the keys pick a line, and there is no depth to go into", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8:27b", 7 * GiB, 1)]);
        const { page, frame } = await openPanel(fake, ext);
        await frame.locator("select.rc-preset").selectOption("overview");
        await expect.poll(() => frame.locator(".rc-hit").count(), { timeout: 25000 }).toBeGreaterThan(1);
        await sleep(4000);

        // THE POINTER PARKS on the plot and never moves again — the whole point, since the alternative here
        // is hitting a 1.5px line through a 10px target.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
        await sleep(400);

        /** Which line the tip is picking out, by the row it marks. */
        const picked = async () => frame.locator(".rc-tip-pools .rc-tip-poolrow.near .rc-tip-label")
            .first().textContent().catch(() => null);
        await expect.poll(() => frame.locator(".rc-tip-pools").count(), { timeout: 8000 }).toBe(1);
        // THE TIP ADVERTISES THE KEY, because nobody presses one they have not been told about.
        expect(await frame.locator(".rc-tip-pools .rc-tip-keys").count(), "the tip says the keys exist").toBe(1);
        expect(await frame.locator(".rc-tip-pools .rc-tip-keys").textContent()).toMatch(/pick a line/);

        // Stepping walks the pools, and the crosshair does not move: the INSTANT is the pointer's, the LINE
        // is the keyboard's.
        const crossAt = (await frame.locator(".rc-cross").first().boundingBox()).x;
        const seen = [];
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press("ArrowDown");
            await sleep(300);
            seen.push((await picked())?.trim() ?? null);
        }
        expect(new Set(seen.filter(Boolean)).size, `the keys walk the lines: ${JSON.stringify(seen)}`).toBeGreaterThan(1);
        const line = await frame.locator(".rc-cross").first().boundingBox();
        expect(Math.abs(line.x - crossAt), "the instant held still while the reading walked").toBeLessThan(2);

        // AND NO DEPTH. A pool has no breakdown of its own — that is per model — so right does nothing here
        // rather than half-entering a mode this view cannot show.
        const before = await picked();
        await page.keyboard.press("ArrowRight");
        await sleep(350);
        expect(await picked(), "right is not a gesture in this view").toBe(before);
        expect(await frame.locator(".rc-tip-part").count(), "…and nothing was decomposed").toBe(0);
        expect(await frame.locator(".rc-track.deep").count(), "…nor did the chart change mode").toBe(0);
    } finally { await ext.close(); await fake.stop(); }
});

// THE WHOLE BOX ON ONE AXIS, without drawing its memory as one pool. Pools combine only at a cost (a split
// pays per-card overhead, a spill into RAM is slow), so they are laid END TO END, each filling a band the
// height of its own capacity, with the walls between them drawn.
test("resource panel: the total view lays every pool end to end, with walls", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8:27b", 7 * GiB, 1)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "box", series: ["vram.0", "vram.1", "ram"], mode: "total", heightPx: 120 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-boxfill").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(3000);

        // A BAND PER POOL, and a WALL between each pair — without them a reader sees one column and infers
        // one pool, which is the claim this view exists to avoid making.
        await expect.poll(() => frame.locator(".rc-boxwall").count(), { timeout: 8000 }).toBe(2);

        // THE HEADER SAYS HELD, NEVER FREE. Those bytes are genuinely held, so the figure is true; the space
        // above them is not available to a model, which is what a "free" figure would quietly claim.
        const head = (await frame.locator(".rc-track .rc-total").first().textContent()).replace(/\s+/g, " ");
        expect(head, `the header does not say what is held: ${head}`).toMatch(/held/);
        expect(head, "…and never offers a free figure").not.toMatch(/free/i);
        // The axis total is the SUM of the real capacities — 95.59 + 95.59 + 121.2 GiB.
        expect(head, `the axis total is not the box's: ${head}`).toMatch(/312|313/);

        // THE POOLS ARE PROPORTIONAL TO THEIR CAPACITY, which is the thing the per-pool tracks cannot show:
        // they give every pool the same height whatever its size. RAM is the biggest here, so its band is.
        const walls = await frame.locator(".rc-boxwall").evaluateAll((els) => els.map((e) => e.style.bottom));
        expect(walls.length, `walls at: ${walls}`).toBe(2);

        // SWITCHING A POOL OFF SHRINKS THE AXIS rather than leaving a hole — that is what makes "just my two
        // cards" a view rather than arithmetic the reader has to do.
        await frame.locator(".rc-legend .rc-key", { hasText: "System RAM" }).first().click();
        await sleep(900);
        await expect.poll(() => frame.locator(".rc-boxwall").count(), { timeout: 8000 }).toBe(1);
        const head2 = (await frame.locator(".rc-track .rc-total").first().textContent()).replace(/\s+/g, " ");
        expect(head2, `the axis did not shrink: ${head2}`).toMatch(/191|192/);
    } finally { await ext.close(); await fake.stop(); }
});

// THE TOTAL VIEW ANSWERS A HOVER, as every other view does. It shipped with none: pointing at the plot or at a
// legend key read nothing, while the same pools drawn as lines one preset over opened a reading of each.
// HOW THE CARDS CONNECT, against the MOCK topologies (tests/fixtures/boxes.mjs — unverified against real NVLink
// hardware by agreement; replace with the first real capture). A 4x3090 cabled 0–2 and 1–3: the bands must
// reorder so each bridge falls on a wall, and every card's hover names its link to every other card.
test("resource panel: whole box bridges directly-linked cards, reordered so each bridge has a wall", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const rig = (topology) => ({ compute: {
            system_compute: { cpu_cores: 32, total_memory: 137438953472, free_memory: 100 * GiB },
            supported_gpus: [0, 1, 2, 3].map((i) => ({ gpu_id: String(i), pci_id: pci(i), name: `CUDA${i}`, runner: "CUDA",
                total_memory: 25757220864, physical_memory: 25769803776, free_memory: 25757220864 - (i + 1) * GiB })),
            topology } });
        fake.setCapacity(rig(TOPOLOGIES.rigCrossed));
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "box", series: ["vram.0", "vram.1", "vram.2", "vram.3", "ram"], mode: "total", heightPx: 140 },
            { id: "c0", series: ["vram.0"], mode: "stack", heightPx: 80 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-boxfill").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(2500);

        // ORDER: the bridges join 0–2 and 1–3, so the cards are laid out 0, 2, 1, 3 — each bridge on a wall.
        const keys = (await frame.locator(".rc-track").first().locator(".rc-legend .rc-key").allTextContents()).map((k) => k.trim().split(" ")[0]);
        expect(keys).toEqual(["CUDA0", "CUDA2", "CUDA1", "CUDA3", "System"]);
        // Two bridges — the two bridged pairs — and the walls between them and to RAM stay solid.
        await expect(frame.locator(".rc-boxwall.bridge").first()).toBeAttached({ timeout: 5000 });
        const perSeg = await frame.locator(".rc-track").first().locator(".rc-seg").first().locator(".rc-boxwall")
            .evaluateAll((els) => els.map((e) => e.className.replace("rc-boxwall", "").trim() || "solid"));
        expect(perSeg).toEqual(["bridge", "solid", "bridge", "solid"]);

        // THE POOL READING SAYS WHAT EACH BRIDGE IS — the walls themselves open no tooltip.
        const plot = frame.locator(".rc-track").first().locator(".rc-plot");
        const bb = await plot.boundingBox();
        await plot.hover({ position: { x: bb.width / 2, y: bb.height * 0.9 } });
        const links = frame.locator(".rc-tip-pools .rc-tip-links");
        await expect(links).toBeVisible({ timeout: 5000 });
        const lt = (await links.textContent()).replace(/\s+/g, " ");
        expect(lt).toMatch(/CUDA0 ═ CUDA2\s*NVLink ×4 \(NV4\) · 112\.5 GB\/s/);
        expect(lt).toMatch(/CUDA1 ═ CUDA3/);

        // THE CARD'S HOVER: one line per OTHER card, direct fabric first — never one "interconnect" for the card.
        // Read from the `.tt-pop` in the DOM, as the other facts test does: the floating layer shows a COPY, so
        // the original is present and hidden by design.
        const facts = frame.locator(".rc-devfacts .tt-pop").first();
        const ft = (await facts.textContent()).replace(/\s+/g, " ");
        expect(ft).toMatch(/to CUDA2 NVLink ×4 \(NV4\)/);
        expect(ft).toMatch(/to CUDA1 PCIe, through the CPU's host bridge \(PHB\)/);
        expect(ft.indexOf("CUDA2"), "the bridged peer is listed first").toBeLessThan(ft.indexOf("CUDA1"));

        // NOTHING MEASURED IS NOT "NO NVLINK": the same box, with the driver refusing the NVLink calls.
        fake.setCapacity(rig({ ...TOPOLOGIES.unavailable, gpus: [0, 1, 2, 3].map(pci) }));
        await expect.poll(() => frame.locator(".rc-boxwall.bridge").count(), { timeout: 10000 }).toBe(0);
        await expect.poll(async () => (await facts.textContent()).replace(/\s+/g, " "), { timeout: 5000 })
            .toMatch(/could not be measured \(NVML is not available/);
        expect((await facts.textContent())).not.toMatch(/PCIe/);
    } finally { await ext.close(); await fake.stop(); }
});

// HOW BUSY, not how full: the Activity view. Lines per card — solid GPU, dashed memory controller — and a card
// that stops reporting draws no line rather than a line at zero.
test("resource panel: Activity draws each card's utilization, and a missing reading is a gap, not zero", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const info = (u1) => ({ compute: {
            system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 100 * GiB },
            supported_gpus: [0, 1].map((i) => ({ gpu_id: String(i), pci_id: pci(i), name: `CUDA${i}`, runner: "CUDA",
                total_memory: 101972967424, physical_memory: 102641958912, free_memory: 90 * GiB,
                ...(i === 0 ? { utilization: { gpu_percent: 99, memory_percent: 90 } } : u1 ? { utilization: u1 } : {}) })) } });
        fake.setCapacity(info({ gpu_percent: 0, memory_percent: 0 }));
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "activity", tracks: [
            { id: "activity", series: ["util.0", "util.1"], mode: "overlay", heightPx: 110 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-util-gpu").count(), { timeout: 25000 }).toBeGreaterThan(1);
        const keys = frame.locator(".rc-legend .rc-key");
        await expect(keys.first()).toHaveText(/CUDA0 99% · memory 90%/);
        // 0 is IDLE, and drawn as such: a real reading of an idle card.
        await expect(keys.nth(1)).toHaveText(/CUDA1 0% · memory 0%/);
        expect(await frame.locator(".rc-util-mem").count(), "the memory controller is its own (dashed) line").toBeGreaterThan(1);

        // The second card STOPS reporting: its line ends and its figure reads as not reported — never a 0.
        fake.setCapacity(info(null));
        await expect(keys.nth(1)).toHaveText(/CUDA1 —/, { timeout: 15000 });
        const plot = frame.locator(".rc-plot").first();
        const bb = await plot.boundingBox();
        await plot.hover({ position: { x: bb.width - 4, y: bb.height / 2 } });
        const tip = frame.locator(".rc-tip-pools");
        await expect(tip).toBeVisible({ timeout: 5000 });
        const t = (await tip.textContent()).replace(/\s+/g, " ");
        expect(t).toMatch(/CUDA1\s*GPU not reported/);
        expect(t).toMatch(/averaged by the driver/);
    } finally { await ext.close(); await fake.stop(); }
});

// A PARTIAL MESH must not read as a switch: on a DGX-1 cube-mesh every ADJACENT pair of the chosen order is linked,
// so every wall is a bridge — and the run is marked partial, with the pairs that are not linked named.
test("resource panel: a partial NVLink mesh is drawn as partial, never as one group of eight", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const ids = [0, 1, 2, 3, 4, 5, 6, 7];
        fake.setCapacity({ compute: {
            system_compute: { cpu_cores: 64, total_memory: 1099511627776, free_memory: 900 * GiB },
            supported_gpus: ids.map((i) => ({ gpu_id: String(i), pci_id: pci(i), name: `CUDA${i}`, runner: "CUDA",
                total_memory: 34359738368, physical_memory: 34359738368, free_memory: 30 * GiB })),
            topology: TOPOLOGIES.dgx1 } });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "box", series: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `vram.${i}`), mode: "total", heightPx: 160 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-boxfill").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(2500);
        const walls = await frame.locator(".rc-seg").first().locator(".rc-boxwall")
            .evaluateAll((els) => els.map((e) => e.className.replace("rc-boxwall", "").trim()));
        expect(walls.length).toBe(7);
        expect(walls.every((w) => w === "bridge partial"), `walls: ${walls}`).toBe(true);
        const plot = frame.locator(".rc-plot").first();
        const bb = await plot.boundingBox();
        await plot.hover({ position: { x: bb.width / 2, y: bb.height * 0.5 } });
        await expect(frame.locator(".rc-tip-pools .rc-tip-links")).toContainText("PARTIAL mesh", { timeout: 5000 });
        // Said ONCE, for the run — the same list under each of seven bridges buried the reading it qualifies.
        const text = await frame.locator(".rc-tip-pools .rc-tip-links").textContent();
        expect(text.split("PARTIAL mesh").length - 1, text).toBe(1);
    } finally { await ext.close(); await fake.stop(); }
});

// A FULL MESH is one fact, said once: eight cards every pair of which is directly linked — AMD's MI300X over
// Infinity Fabric (xGMI) here, a MOCK like every fabric topology. Listing its seven adjacent walls instead read as a
// chain, which is exactly the shape it is not.
test("resource panel: a full mesh is said as one — every pair linked — and AMD's xGMI draws as a bridge", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const ids = [0, 1, 2, 3, 4, 5, 6, 7];
        fake.setCapacity({ compute: {
            system_compute: { cpu_cores: 64, total_memory: 2199023255552, free_memory: 1800 * GiB },
            supported_gpus: ids.map((i) => ({ gpu_id: String(i), pci_id: pci(i), name: `ROCm${i}`, runner: "ROCm",
                total_memory: 205520896000, physical_memory: 206158430208, free_memory: 150 * GiB })),
            topology: TOPOLOGIES.xgmi8 } });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "box", series: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `vram.${i}`), mode: "total", heightPx: 160 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-boxfill").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(2500);
        const walls = await frame.locator(".rc-seg").first().locator(".rc-boxwall")
            .evaluateAll((els) => els.map((e) => e.className.replace("rc-boxwall", "").trim()));
        expect(walls.length).toBe(7);
        expect(walls.every((w) => w === "bridge"), `a full mesh draws every wall as a bridge: ${walls}`).toBe(true);
        const plot = frame.locator(".rc-plot").first();
        const bb = await plot.boundingBox();
        await plot.hover({ position: { x: bb.width / 2, y: bb.height * 0.5 } });
        const links = frame.locator(".rc-tip-pools .rc-tip-links");
        await expect(links).toContainText("all 8 cards, every pair directly linked (28 pairs) · xGMI ×1 (XGMI) · 64.0 GB/s", { timeout: 5000 });
        expect(await links.locator(".rc-tip-row").count(), "one line for the mesh, not seven adjacent walls").toBe(1);
    } finally { await ext.close(); await fake.stop(); }
});

test("resource panel: the total view's plot and keys open the pool reading, picking the band you are inside", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8:27b", 7 * GiB, 1)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "box", series: ["vram.0", "vram.1", "ram"], mode: "total", heightPx: 120 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-boxfill").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(3000);
        const near = () => frame.locator(".rc-tip-pools .rc-tip-poolrow.near .rc-tip-label").textContent().catch(() => "");

        // POINTING INSIDE A BAND NAMES THAT POOL. The axis stacks CUDA0 (bottom ~31%), CUDA1 (~31-61%) and
        // System RAM (the top ~39%). The overlaid view's rule — nearest by each pool's OWN fill share — means
        // nothing on this axis, and it happens to agree with the band at some heights (CUDA0 is ~19% full,
        // which is where a pointer 20% up sits), so ONE probe can pass by coincidence; that is how the first
        // version of this test passed with the band rule removed. Three heights, one per band, cannot all
        // agree with a rule that is not reading the bands.
        const plot = frame.locator(".rc-track .rc-plot").first();
        const bb = await plot.boundingBox();
        for (const [up, pool] of [[0.15, /CUDA0/], [0.46, /CUDA1/], [0.85, /System RAM/]]) {
            await plot.hover({ position: { x: bb.width / 2, y: bb.height * (1 - up) } });
            await expect.poll(() => frame.locator(".rc-tip-pools").count(), { timeout: 5000 }).toBe(1);
            await expect.poll(near, { timeout: 5000, message: `${Math.round(up * 100)}% up is inside ${pool}` }).toMatch(pool);
        }
        expect(await frame.locator(".rc-tip-pools .rc-tip-poolrow").count(), "every pool on the axis gets a row").toBe(3);

        // A LEGEND KEY OPENS THE SAME READING, for its own pool — the overlaid view's keys already did.
        await frame.locator(".rc-legend").hover({ position: { x: 2, y: 2 } });
        await frame.locator(".rc-legend .rc-key", { hasText: "CUDA1" }).hover();
        await expect.poll(() => frame.locator(".rc-tip-pools").count(), { timeout: 5000 }).toBe(1);
        await expect.poll(near, { timeout: 5000 }).toMatch(/CUDA1/);
        // …and names the control for a screen reader rather than adding a SECOND, native tooltip to the hover.
        const key = frame.locator(".rc-legend .rc-key", { hasText: "CUDA1" });
        expect(await key.getAttribute("title")).toBeNull();
        expect(await key.getAttribute("aria-label")).toBe("Hide CUDA1");
    } finally { await ext.close(); await fake.stop(); }
});

// KV OCCUPANCY AND PHASE — what the runner is DOING, from `activity` on `/api/ps`.
//
// The context chip has always said what window a model was loaded with, and its tooltip ends by advising a
// smaller `num_ctx`. It had no way to know whether that advice applies: Ollama reserves the cache for the
// whole window at load and the bytes never move, so a 256K window at 2% and the same window at 90% are the
// same number everywhere else in the panel. The three cases below are the ones the field's shape makes easy
// to get wrong, and each is drawn from a real capture (tests/e2e/fixtures/runner-activity.json).
test("resource panel: the cache says how full it is, and idle is not the same as unknown", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 20 * GiB, IDLE));
        // Three models on one box, so the three cases are told apart by what is DRAWN and not by timing:
        //  - `busy`: mid-generation, the shape the phase chip exists for.
        //  - `idle`: the task is over, the in-flight counts are gone, and the occupancy STILL STANDS. That is
        //    llama.cpp's own behaviour and the reason "phase is the discriminator" is sufficient.
        //  - `mute`: no `activity` at all — every stock server, and every patched one that could not reach
        //    its runner. Absent must not render as an empty cache.
        const withCtx = (m, ctx, activity) => ({ ...m, context_length: ctx, ...(activity ? { activity } : {}) });
        fake.setResident([
            withCtx(resident("busy:1b", 8 * GiB, 0), 8192,
                { phase: "decode", slots: 1, slots_busy: 1, prompt_tokens: 4134, prompt_tokens_done: 4098, decoded: 36 }),
            withCtx(resident("idle:1b", 6 * GiB, 0), 8192,
                { phase: "idle", slots: 1, slots_busy: 0, prompt_tokens: 4177 }),
            withCtx(resident("mute:1b", 6 * GiB, 1), 8192, null),
        ]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".vram-row").count(), { timeout: 25000 }).toBe(3);

        const row = (n) => frame.locator(".vram-row").filter({ hasText: n }).first();
        // The chip's OWN text, not its subtree: the `.tt-pop` explanation is a child of the trigger (that is
        // how the floating layer finds it), so reading textContent would assert against the tooltip prose too
        // and pass on a chip showing anything at all.
        const chip = (n, cls) => row(n).locator(cls).evaluate((e) => e.firstChild?.textContent?.trim() ?? "");
        // 4134/8192 and 4177/8192 both round to 50% and 51% — deliberately close, so a chip reading the wrong
        // model's figure would still look plausible and only the exact value catches it.
        expect(await chip("busy:1b", ".vram-kv")).toBe("50%");
        expect(await chip("idle:1b", ".vram-kv")).toBe("51%");

        // AN IDLE RUNNER STILL REPORTS ITS CACHE. Occupancy survives the task that filled it — those tokens
        // really are still resident — so the answer to "would less context help" does not evaporate the moment
        // the box goes quiet, which is when someone is most likely to be looking at this panel.
        await expect(row("idle:1b").locator(".vram-phase")).toHaveCount(0, { timeout: 5000 });

        // …AND AN ABSENT `activity` IS NOT AN EMPTY CACHE. This is the one that would ship silently: every
        // stock Ollama omits the object, and a chip reading "0%" there is a confident wrong answer about
        // memory nobody measured, on the majority of installs.
        await expect(row("mute:1b").locator(".vram-kv")).toHaveCount(0);
        await expect(row("mute:1b").locator(".vram-ctx")).toHaveCount(1, { timeout: 5000 });

        // THE PHASE CHIP IS DRAWN ONLY WHILE THERE IS A PHASE, and it is a different fact from the TTL chip
        // beside it — measured on the box, a request in flight while the slot has not started reads
        // `busy: true, phase: idle`, so folding one into the other would report work that had not begun.
        expect(await chip("busy:1b", ".vram-phase")).toBe("decode");
        await expect(row("mute:1b").locator(".vram-phase")).toHaveCount(0);

        // A PREFILL SAYS SO, and the transition is what the chip is for: the same row, a moment later.
        fake.setResident([
            withCtx(resident("busy:1b", 8 * GiB, 0), 8192,
                { phase: "prefill", slots: 1, slots_busy: 1, prompt_tokens: 2048, prompt_tokens_done: 1024 }),
            withCtx(resident("idle:1b", 6 * GiB, 0), 8192, { phase: "idle", slots: 1, slots_busy: 0, prompt_tokens: 4177 }),
            withCtx(resident("mute:1b", 6 * GiB, 1), 8192, null),
        ]);
        await expect.poll(() => chip("busy:1b", ".vram-phase"), { timeout: 15000 }).toBe("prefill");
        expect(await chip("busy:1b", ".vram-kv")).toBe("25%");

        // AND A NEARLY-EMPTY CACHE DOES NOT READ AS AN EMPTY ONE. 30 tokens of a 262,144 window rounds to
        // "0%", which beside a reserved 40 GiB says the cache is empty — the exact claim a reader would act
        // on, and false. It is the case a percentage chip invites and the only one worth a special string.
        fake.setResident([withCtx(resident("busy:1b", 8 * GiB, 0), 262144,
            { phase: "idle", slots: 1, slots_busy: 0, prompt_tokens: 30 })]);
        await expect.poll(() => chip("busy:1b", ".vram-kv"), { timeout: 15000 }).toBe("<1%");
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE MARK CARRIES THE MODEL'S COLOUR. A model's colour is its identity across the whole panel — the band,
// the row, its blocks in the lane, its ticks on the strip — and the mark sitting ON that band was drawn in
// the panel's accent, which says "a reading" where every other surface says "this model". The overlaid view
// already colours its marks by pool, so the two views disagreed about what a mark means.
test("resource panel: a mark on a model's band is drawn in that model's colour", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_snapdot: true }));
        await seedStacked(ext);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(6000);   // several samples, or there is nothing to snap between

        // Hovering one band narrows the marks to that band's own boundary, which is the one this is about.
        await frame.locator(".rc-band").first().hover();
        await expect.poll(() => frame.locator(".rc-snapdot").count(), { timeout: 10000 }).toBe(1);

        // THE MARK AND THE THING IT MARKS MUST NOT DISAGREE, so this compares the mark against the BAND's own
        // resolved fill rather than against a colour named here — the palette is a preference and a literal
        // would pin the test to whichever one happened to be set.
        const bandFill = await frame.locator(".rc-band").first().evaluate((e) => getComputedStyle(e).fill);
        const dotBg = await frame.locator(".rc-snapdot").first().evaluate((e) => getComputedStyle(e).backgroundColor);
        expect(dotBg, "the mark is drawn in the band's own colour").toBe(bandFill);

        // …and it is NOT the panel accent, which is what it used to be. Without this the assertion above
        // would still pass on a palette whose first colour happened to be the accent.
        const accent = await frame.locator(".rc-snapdot").first().evaluate((e) => {
            const probe = document.createElement("i");
            probe.style.backgroundColor = getComputedStyle(e).getPropertyValue("--accent").trim();
            document.body.appendChild(probe);
            const v = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return v;
        });
        expect(dotBg, "a model's mark is no longer the generic accent").not.toBe(accent);
    } finally { await ext.context.close(); await fake.stop(); }
});

// A MODEL'S MEMORY IS PIECEWISE-CONSTANT, SO ITS BAND IS A STEP.
//
// A resident model does not drift: the runner appears holding its whole footprint and the KV cache is
// preallocated for the full window at load. A straight line between two samples therefore drew a decay that
// cannot happen — and on an eviction it drew the worst version of it, because the stream's idle cadence is
// 15s: two samples that far apart, resident at one end and gone at the other, rendered as fifteen seconds of
// memory gently draining away, while the `unload` rule sat at the true instant. The chart and the lane
// disagreed by up to a whole sample interval.
test("resource panel: a model's band steps, and the device's own bands do not", async () => {
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
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(5000);   // several samples, or there are no segments to join

        // …now it goes, between two samples. The band must hold its height and DROP, not slope.
        fake.setResident([]);
        await sleep(5000);

        /**
         * Read the polygon itself: the claim is about SHAPE and there is no other way to see it. A stepped
         * edge emits a CORNER — two points sharing an x — where an interpolated one emits exactly one point
         * per sample and never repeats an x.
         *
         * The top edge has to be isolated first, and neither obvious way of doing it works. Splitting at the
         * midpoint is wrong because a stepped edge emits about twice the points a plain one does, so the
         * halves are not equal. Splitting where x first stops rising is wrong because the polygon CLOSES with
         * a vertical at the right-hand edge — a shared x that is the shape joining top to floor, not a step,
         * and it made the residual look stepped when it is not.
         */
        const topEdge = (pts) => {
            const p = pts.trim().split(/\s+/).map((q) => q.split(",").map(Number));
            let turn = p.length;
            for (let i = 1; i < p.length; i++) if (p[i][0] < p[i - 1][0]) { turn = i; break; }
            const head = p.slice(0, turn);
            // Drop the closing vertical: everything after the FIRST point that reaches the rightmost x.
            const maxX = Math.max(...head.map((q) => q[0]));
            const at = head.findIndex((q) => q[0] === maxX);
            return head.slice(0, at + 1);
        };
        const stepsIn = (pts) => topEdge(pts).filter((q, i, a) => i > 0 && q[0] === a[i - 1][0]).length;

        const band = frame.locator(".rc-band").first();
        await expect(band).toHaveCount(1);
        expect(stepsIn(await band.getAttribute("points")),
            "the model's band turns square corners rather than sloping").toBeGreaterThan(0);

        // THE DEVICE'S OWN BANDS STAY LINES, and that difference is deliberate rather than an inconsistency:
        // a card's free memory really does fall progressively while weights land, so stepping it would be the
        // same error pointed the other way. The residual is the polygon with no `.rc-band` class — it belongs
        // to no model. Its FLOOR is stepped, because it sits on the models and a shared edge has to match on
        // both sides or the stack opens a seam; only its own top is checked here.
        const plain = frame.locator(".rc-plot").first().locator("polygon:not(.rc-band)");
        if (await plain.count()) {
            expect(stepsIn(await plain.first().getAttribute("points")),
                "a device band's own edge is still a line").toBe(0);
        }
    } finally { await ext.context.close(); await fake.stop(); }
});

// …AND SO DOES WHAT BELONGS TO IT. A runner's own overhead (its process minus its model's share, stacked on the
// model in a wash of its colour) is the same runner's memory: constant while it lives, gone at the same eviction.
// Drawn as a line it sloped from the last sample before the eviction to the first after — a `\` wedge beside the
// model's `|` at every eviction, which snapped square only when a hover subdivided the band.
test("resource panel: a runner's overhead steps with its model at an eviction, never a wedge", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const TOTAL = 101972967424, MODEL = 18 * GiB, OVERHEAD = 0.6 * GiB;
        const info = (on) => { const b = box(TOTAL - (on ? MODEL + OVERHEAD : 0), TOTAL);
            b.compute.supported_gpus[0].processes_scope = "pid_namespace";
            b.compute.supported_gpus[1].processes_scope = "pid_namespace";
            if (on) b.compute.supported_gpus[0].processes = [{ pid: 317, used_memory: MODEL + OVERHEAD, name: "llama-server", runner: { model: "gemma4:31b" } }];
            return b; };
        const ps = (on) => ({ models: on ? [resident("gemma4:31b", MODEL, 0)] : [] });
        // Resident for 12 s, then evicted: every sample carries its own ps and info, as the real stream's do.
        fake.setEvents([...[-14000, -12000, -10000, -8000, -6000, -4000].map((t) => ({ v: 1, kind: "sample", t, ps: ps(true), info: info(true) })),
                        ...[-2000, -1000].map((t) => ({ v: 1, kind: "sample", t, ps: ps(false), info: info(false) }))]);
        fake.setCapacity(info(false)); fake.setResident([]);
        await seedStacked(ext);
        const { frame } = await openPanel(fake, ext);
        const overhead = frame.locator(".rc-track").first().locator('.rc-area polygon[fill*="30%, var(--fg-faint)"]');
        await expect.poll(() => overhead.count(), { timeout: 20000 }).toBeGreaterThan(0);
        const pts = (await overhead.first().getAttribute("points")).trim().split(/\s+/).map((q) => q.split(",").map(Number));
        // The top edge runs left to right until the polygon turns back along its floor.
        let turn = pts.length;
        for (let i = 1; i < pts.length; i++) if (pts[i][0] < pts[i - 1][0]) { turn = i; break; }
        const top = pts.slice(0, turn);
        const maxX = Math.max(...top.map((q) => q[0]));
        const edge = top.slice(0, top.findIndex((q) => q[0] === maxX) + 1);
        const corners = edge.filter((q, i) => i > 0 && q[0] === edge[i - 1][0]).length;
        expect(corners, `the overhead drops square, like its model: ${JSON.stringify(edge)}`).toBeGreaterThan(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE WAY BACK FROM A RESIZED WINDOW, produced by a real gesture — which is the half of this a jsdom test
// cannot make. The rule and the reset are asserted there; what is only true in a browser is that a pinch
// actually lands on the quantity the chip watches. The bug was precisely "I resized it and nothing appeared",
// so the resize has to be a gesture rather than a seeded value.
test("resource panel: resizing the window offers a way back to the default", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        // At the default, so the chip's absence at the start means something.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 300, ml_res_window_pref: 300 }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(3000);

        await expect(frame.locator(".vram-zoom.resized")).toHaveCount(0, { timeout: 5000 });

        /** A trackpad pinch: a wheel carrying ctrlKey, at a point inside the plot. */
        const pinch = (dy) => frame.locator(".rc-plot").first().evaluate((el, d) => {
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new WheelEvent("wheel", { deltaY: d, ctrlKey: true, bubbles: true, cancelable: true,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        }, dy);

        // NARROW IT — still following live, which is the case that had no way back.
        for (let i = 0; i < 3; i++) { await pinch(-60); await sleep(150); }
        await expect.poll(() => frame.locator(".vram-zoom.resized").count(), { timeout: 8000 }).toBe(1);
        // Still LIVE: this is not a pinned range, which is the distinction the old gate collapsed.
        await expect.poll(() => frame.locator(".rc-scrub-live").textContent(), { timeout: 5000 }).toMatch(/live/);

        // …and the way back actually goes back, to the width the picker names rather than a number baked in.
        await frame.locator(".vram-zoom.resized").click();
        await expect.poll(() => frame.locator(".vram-zoom.resized").count(), { timeout: 8000 }).toBe(0);
        const restored = await ext.sw.evaluate(() => new Promise((r) =>
            chrome.storage.local.get({ ml_res_window: 0 }, (d) => r(d.ml_res_window))));
        expect(restored, "back at the default the picker names").toBe(300);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE CARD'S OWN FACTS, behind a hover on the track name. The panel draws a pool's occupancy and says almost
// nothing about the hardware under it, so "which card is this, and why do two totals for it disagree" had no
// answer on screen — and the two totals are exactly the thing a reader spots elsewhere and cannot resolve:
// ollama places against `total_memory` while the header draws `physical_memory`, ~638 MiB apart.
test("resource panel: a card's facts are on its name, and the interconnect is not guessed", async () => {
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
        await expect.poll(() => frame.locator(".rc-name").count(), { timeout: 25000 }).toBeGreaterThan(0);

        // THE NAME IS STILL THE NAME. The tooltip is a SIBLING inside the trigger, not a child of `.rc-name`
        // — put it inside and the label's own text becomes the label plus three sentences of prose, which
        // every reader of that element then picks up. Several tests and the panel itself read this as a label.
        expect(await frame.locator(".rc-name").first().textContent()).toBe("CUDA0");

        const tip = frame.locator(".rc-devfacts").first().locator(".tt-pop");
        const text = (await tip.textContent()).replace(/\s+/g, " ");
        // THE TWO TOTALS, and which decides what — the reason this hover exists.
        expect(text, "what placement decides against").toMatch(/usable 94\.97 GiB what placement decides against/);
        expect(text, "…and what the driver reports, named as such").toMatch(/on the card 95\.59 GiB/);
        expect(text).toMatch(/nvidia-smi/);
        expect(text, "neither figure is presented as the wrong one").toMatch(/neither figure is wrong/);
        expect(text, "reference facts, verbatim").toMatch(/compute 12\.0/);

        // THE INTERCONNECT IS NOT GUESSED. The server reports no topology, and an absent matrix must never
        // render as "PCIe only": interconnect is a property of a PAIR, so on a four-card box some pairs can
        // be NVLinked while others fall back — claiming a per-card answer is unrepresentable-wrong there.
        expect(text, "says it is unknown").toMatch(/not reported by this server/);
        expect(text, "and never asserts the absence of NVLink").not.toMatch(/PCIe only|no NVLink/i);

        // LINK SPEED AND WIDTH ARE ABSENT ON A HEALTHY CARD. Both are LIVE readings rather than capabilities
        // — an idle Blackwell drops to 2.5 GT/s under ASPM and would read as 12x degraded while perfectly
        // healthy — and a board that splits its lanes x8/x8 is correct, not degraded.
        expect(text, "no live link reading dressed as a spec").not.toMatch(/GT\/s|x8|x16/);

        // THE HOST POOL HAS NO CARD, so it gets no hardware hover at all rather than an empty one.
        const names = await frame.locator(".rc-name").allTextContents();
        expect(names).toContain("System RAM");
        const ramHead = frame.locator(".rc-track").filter({ hasText: "System RAM" }).first();
        expect(await ramHead.locator(".rc-devfacts").count(), "no device, no device facts").toBe(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

// "OFF-BOX" IS A CLAIM ABOUT WHERE A MODEL RUNS, and it was the FALL-THROUGH. Any model the lane named that the
// panel had not seen resident was labelled off-box — so asking the Commander for a LOCAL model that was not
// loaded yet called it off-box for the whole stretch between the request going out (the lane names it at once)
// and the server reporting a `load.start`. Then it flipped to "loading", then to resident: two corrections of a
// claim that should never have been made. Reported from a real box, on a model ollama serves.
//
// Off-box needs evidence that the model runs ELSEWHERE, and the only such evidence is the server's own
// provenance list saying it is not one of its models (`isCloudModel`). The fake lists its model as
// `owned_by: "ollama"`, so a run against it that nothing reports loading is exactly the reported case.
test("resource panel: a local model the box has not loaded yet is not called off-box", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setScript([{ content: "done" }]);
        fake.setCapacity(box(IDLE, IDLE));
        // NOT RESIDENT, and no load reported — the gap between the request and the server's first word.
        fake.setResident([]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 950 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => { window.ml.agent("say done", { approvalRouting: "both" }); });
        const frame = await openRunInSidebar(page, { task: "say done" });
        for (let i = 0; i < 5 && !(await frame.locator(".vram").count()); i++) {
            await frame.locator('[aria-label="VRAM monitor"]').click();
            await sleep(400);
        }
        await expect(frame.locator(".vram")).toBeVisible();

        /** The kind badge on a not-resident row, without the tooltip prose inside it. */
        const kindOf = async (name) => {
            const head = frame.locator(".disc-head", { hasText: "not resident" }).first();
            if (await head.count()) await head.click().catch(() => {});
            await sleep(400);
            const row = frame.locator(".vram-row.ghost").filter({ hasText: name }).first();
            if (!(await row.count())) return null;
            return row.locator(".vram-embed").evaluate((e) => (e.firstChild?.textContent ?? "").trim());
        };

        // The lane has to be naming the model, or its absence from the row list would mean nothing.
        await expect.poll(() => kindOf("fake-model"), { timeout: 25000 }).not.toBeNull();
        const kind = await kindOf("fake-model");
        expect(kind, "a model ollama serves is never off-box — when it runs, it runs here").not.toBe("off-box");
        expect(kind, "it is simply not loaded yet").toBe("not loaded");

        // …and the moment the server DOES report a load, the row says so. Not loaded → loading → resident,
        // each step true when it is shown, rather than off-box → loading → resident.
        fake.setResident([{ model: "fake-model", name: "fake-model", state: "loading" }]);
        await expect.poll(() => kindOf("fake-model"), { timeout: 15000 }).toBe("loading");
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE BREAKDOWN STEPS WITH THE BAND IT BREAKS DOWN. The step was first applied to the band edges alone, so
// the band held flat while the parts drawn INSIDE it on hover still sloped — a flat band with diagonal lines
// across it, which reads as the breakdown disagreeing with the total. Every part is one model's memory, and a
// model's memory is piecewise-constant, so every part edge steps too. Reported from a real eviction.
test("resource panel: a model's breakdown steps with its band, not across it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE));
        // The real shape from a live `gemma4:e2b`, whose parts sum to `size_vram` to the byte.
        const MEM = { weights: 1465426903, kv_cache: 836763648, compute: 1129588981, projector: 1208032952 };
        const VRAM = 4639812484;
        const model = {
            model: "gemma4:e2b", name: "gemma4:e2b", size: VRAM, size_vram: VRAM, context_length: 262144,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            memory: MEM, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VRAM, memory: MEM }],
        };
        fake.setResident([model]);
        await seedStacked(ext);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-band").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(4000);

        // …then it goes, so the parts have a descent to draw.
        fake.setResident([]);
        await sleep(4500);

        /** Corners in a polygon's TOP edge — two points sharing an x. The top edge is isolated by cutting at the
         *  closing vertical at the right-hand end, which is the shape joining top to floor rather than a step. */
        const stepsIn = (pts) => {
            const p = pts.trim().split(/\s+/).map((q) => q.split(",").map(Number));
            let turn = p.length;
            for (let i = 1; i < p.length; i++) if (p[i][0] < p[i - 1][0]) { turn = i; break; }
            const head = p.slice(0, turn);
            const maxX = Math.max(...head.map((q) => q[0]));
            const top = head.slice(0, head.findIndex((q) => q[0] === maxX) + 1);
            // Only corners that actually MOVE vertically: a hold across an unchanged value emits a zero-height
            // pair, which is a step of nothing and would pass this test without the fix.
            return top.filter((q, i, a) => i > 0 && q[0] === a[i - 1][0] && Math.abs(q[1] - a[i - 1][1]) > 0.5).length;
        };

        // The breakdown is a HOVER affordance, so hover the band to draw it.
        await frame.locator(".rc-band").first().hover();
        await expect.poll(() => frame.locator(".rc-part").count(), { timeout: 8000 }).toBeGreaterThan(0);
        const parts = await frame.locator(".rc-part").evaluateAll((els) => els.map((e) => e.getAttribute("points")));
        for (const pts of parts) {
            expect(stepsIn(pts), "every part of the breakdown drops square, like the band it sits in").toBeGreaterThan(0);
        }
    } finally { await ext.context.close(); await fake.stop(); }
});
