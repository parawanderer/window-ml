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
