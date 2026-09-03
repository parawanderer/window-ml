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
        await expect.poll(() => frame.locator(".rc-tip-pool").count(), { timeout: 5000 }).toBe(1);

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
            if (!(await frame.locator(".rc-tip-pool").count())) missing++;
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
                   usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, genMs: 800 },
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
        expect(await toolBar.evaluate((e) => getComputedStyle(e).backgroundImage)).toContain("gradient");

        // Hovering the delegated reader lights its lineage and drops the rest back.
        const sub = frame.locator(".rc-ev-embed").first();
        expect(await sub.count()).toBe(1);
        await sub.hover();
        await sleep(300);
        const dimmed = await frame.locator(".rc-ev").evaluateAll((els) =>
            els.map((e) => ({ cls: e.className, o: Number(getComputedStyle(e).opacity) })));
        expect(dimmed.some((d) => d.o < 0.3), "unrelated events drop back").toBe(true);
        expect(dimmed.find((d) => /rc-ev-embed/.test(d.cls)).o, "the hovered sub-call stays lit").toBeGreaterThan(0.5);

        // And clicking it opens the step that produced it.
        await sub.click();
        await sleep(600);
        expect(await frame.locator(".astep, [data-astep-seq]").count(), "it navigated into the run").toBeGreaterThan(0);
    } finally {
        await ext.close();
        await fake.stop();
    }
});
