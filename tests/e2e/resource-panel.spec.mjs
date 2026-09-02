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
        await sleep(18000);
        await setPanel(true);
        await expect.poll(() => frame.locator(".rc-track").first().locator(".rc-seg").count(), { timeout: 20000 })
            .toBe(2);   // two runs = one honest gap between them

        // A server without the /api/info patch answers with the SPA's HTML. Capacity is UNKNOWN, so the panel
        // must draw NO ceiling — degrading to the auto-scaled sparkline rather than inventing one.
        fake.setCapacity(null);
        await setPanel(false); await sleep(500); await setPanel(true);
        await expect.poll(() => frame.locator(".rc-track").count(), { timeout: 20000 }).toBe(0);
        expect(await frame.locator(".vram-spark").count()).toBe(1);
        // The in-use total still renders, still in binary units.
        expect(await frame.locator(".vram-total").textContent()).toMatch(/GiB in use/);
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
