// A NARRATED DEMO, not a test: what a model's VRAM is HOLDING, and the crosshair snapping to a datapoint.
//
//   npm run build && node --import tsx tests/e2e/memory-split-demo.mjs
//
// `size_vram` alone cannot tell a big MODEL from a big CONTEXT — lots of weights with a small cache, and
// modest weights with an enormous one, are the same number and want opposite responses (a smaller quant vs.
// less context). A patched Ollama splits it, and hovering a model subdivides its band IN PLACE rather than
// opening a second picture of the same memory somewhere else.
//
// Deterministic: a fake box, no model and no key. The figures are real captures — `gemma4:e2b` from this
// laptop's own box, and `qwen3:235b` split across two 96 GB cards from the mlbox report — so what you are
// looking at is a shape the server actually produces rather than one that makes a nice picture.
//
// HOLD=0 exits instead of holding the browser open. The assertions are in resource-panel.spec.mjs.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";
const PACE = Number(process.env.PACE || 2600);
const ART = path.resolve("tests/e2e/artifacts/memory-split-demo");
mkdirSync(ART, { recursive: true });

const GiB = 1024 ** 3;
const TOTAL = 101972967424;                 // a 96 GB card, as the driver reports it
const card = (id, free) => ({
    gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2",
    total_memory: TOTAL, physical_memory: 102641958912, free_memory: free,
});
const boxOf = (free0, free1) => ({ compute: {
    system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 100 * GiB },
    supported_gpus: [card(0, free0), card(1, free1)],
} });

// A VISION model on one card. The projector is a worst-case reservation — sized for the largest image the
// model accepts — so it reads large against what you are actually doing, and it is often the biggest
// non-weights term. Captured from the box.
const VISION_MEM = { weights: 1465426903, kv_cache: 836763648, compute: 1129588981, projector: 1208032952 };
const VISION_VRAM = 4639812484;
const vision = {
    model: "gemma4:e2b", name: "gemma4:e2b", size: VISION_VRAM, size_vram: VISION_VRAM,
    context_length: 262144, expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
    memory: VISION_MEM, weights_on_disk: 7162394016,
    gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VISION_VRAM, memory: VISION_MEM }],
};

// A 142 GB model SPLIT across both cards. Each card carries its own split, summing to that card's own total —
// which is what lets either band be subdivided with no remainder. Note the compute: identical on both, because
// it is a flat per-device cost rather than a share of anything.
const big = {
    model: "qwen3:235b", name: "qwen3:235b", size: 144314759904, size_vram: 144314759904,
    context_length: 262144, expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
    memory: { weights: 141798009732, kv_cache: 1577058304, compute: 939691868 },
    gpus: [
        { gpu_id: "0", runner: "CUDA", size_vram: 73320093450,
          memory: { weights: 72044941148, kv_cache: 805306368, compute: 469845934 } },
        { gpu_id: "1", runner: "CUDA", size_vram: 70994666454,
          memory: { weights: 69753068584, kv_cache: 771751936, compute: 469845934 } },
    ],
};

const main = async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // Per-device TRACKS, or there are no per-model bands to subdivide — the Overview overlays everything
        // into one line. Seeded through storage, which also exercises the restore path.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "memory", tracks: [
            { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 120 },
            { id: "dev-1", series: ["vram.1"], mode: "stack", heightPx: 120 },
        ] } }));

        fake.setCapacity(boxOf(TOTAL - VISION_VRAM, TOTAL - 589824));
        fake.setResident([vision]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 1000 });
        await page.goto(`${fake.url}/api/version`);
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "620px";
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

        await narrate(page, "A vision model, resident", { sub: "one number: 4.32 GiB. It cannot tell you WHY." });
        await sleep(8000);   // enough samples that the areas have something to span
        await page.screenshot({ path: path.join(ART, "1-resident.png") });

        await narrate(page, "Hover it — the band subdivides IN PLACE",
            { sub: "weights · context (KV cache) · vision encoder · compute — summing to the band exactly" });
        const band = frame.locator(".rc-band").first();
        await band.hover();
        await sleep(PACE);
        await page.screenshot({ path: path.join(ART, "2-split.png") });

        await narrate(page, "The encoder is bigger than the weights here",
            { sub: "a worst-case reservation, sized for the largest image the model accepts — not what is loaded now" });
        await sleep(PACE);

        // A SPLIT model: each card decomposes by its OWN figures.
        await narrate(page, "Now a 142 GB model across BOTH cards",
            { sub: "each card carries its own split — and its compute is identical, because compute is flat per device" });
        fake.setCapacity(boxOf(TOTAL - VISION_VRAM - big.gpus[0].size_vram, TOTAL - big.gpus[1].size_vram));
        fake.setResident([vision, big]);
        await sleep(9000);
        await page.screenshot({ path: path.join(ART, "3-split-model.png") });

        await narrate(page, "Hover it on either card", { sub: "the same model, decomposed by what is on THAT card" });
        const bands = frame.locator(".rc-track").nth(1).locator(".rc-band");
        if (await bands.count()) { await bands.first().hover(); await sleep(PACE); }
        await page.screenshot({ path: path.join(ART, "4-per-card.png") });

        // THE CROSSHAIR SNAP, the other half of this change.
        await narrate(page, "The crosshair floats by default",
            { sub: "the tooltip names a real sample, but the line sits wherever the pointer is — they disagree" });
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.55, plot.y + plot.height * 0.5);
        await sleep(PACE);
        await page.screenshot({ path: path.join(ART, "5-floating.png") });

        // In the PANEL'S OWN editor, beside what it draws — not in Settings, which you would have to leave
        // the chart to reach for a mode you flip while reading a datapoint.
        await narrate(page, "The panel's own settings — Cursor: snap to datapoint", { sub: "off by default" });
        await frame.locator('[aria-label="Edit tracks"]').click();
        await sleep(800);
        await frame.locator(".rc-eopt", { hasText: "snap to datapoint" }).locator("input").check();
        await sleep(PACE);
        await page.screenshot({ path: path.join(ART, "6-setting.png") });

        await frame.locator('[aria-label="Edit tracks"]').click();   // close it, or it covers the plot
        await sleep(900);
        await narrate(page, "Now it lands ON the reading it is showing you",
            { sub: "a dot at the sample, at the pointer's own height — the line and the number agree" });
        for (const fx of [0.5, 0.56, 0.62, 0.68]) {
            await page.mouse.move(plot.x + plot.width * fx, plot.y + plot.height * 0.45);
            await sleep(600);
        }
        await page.screenshot({ path: path.join(ART, "7-snapped.png") });

        await narrate(page, null);   // the last shot shows the product alone
        await sleep(500);
        await page.screenshot({ path: path.join(ART, "8-final.png") });
        await narrateDone(page);
        console.log(`\nscreenshots → ${ART}`);
        if (HOLD) { console.log("holding the browser open — close the window or Ctrl+C to exit"); await new Promise(() => {}); }
    } finally {
        if (!HOLD) { await ext.context.close(); await fake.stop(); }
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
