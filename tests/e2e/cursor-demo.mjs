// A NARRATED DEMO, not a test: everything the pointer does on the resource chart.
//
//   npm run build && node --import tsx tests/e2e/cursor-demo.mjs
//
// The chart is read by pointing at it, and every one of these came from watching that go wrong: a mark that
// drifted off the reading it named, two marks competing to say where you were, a tooltip covering the shape
// you paused to look at. Deterministic — a fake box, no model and no key.
//
// HOLD=0 exits instead of holding the browser open; PACE sets the beat. The assertions are in
// resource-panel.spec.mjs.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";
const PACE = Number(process.env.PACE || 2400);
const ART = path.resolve("tests/e2e/artifacts/cursor-demo");
mkdirSync(ART, { recursive: true });

const GiB = 1024 ** 3, TOTAL = 101972967424, IDLE = TOTAL - 589824;
const card = (id, free) => ({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0",
    driver: "13.2", total_memory: TOTAL, physical_memory: 102641958912, free_memory: free });
const boxOf = (f0, f1) => ({ compute: {
    system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 100 * GiB },
    supported_gpus: [card(0, f0), card(1, f1)] } });
const resident = (name, bytes, gpu) => ({
    model: name, name, size: bytes, size_vram: bytes, context_length: 262144,
    expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
    gpus: [{ gpu_id: String(gpu), runner: "CUDA", size_vram: bytes }],
});

const main = async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // Per-device tracks: bands to hover, and two plots so a shared mark can be seen agreeing across them.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "memory", tracks: [
            { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 110 },
            { id: "dev-1", series: ["vram.1"], mode: "stack", heightPx: 110 },
        ] }, ml_res_window: 300 }));
        fake.setCapacity(boxOf(IDLE - 18 * GiB, IDLE - 7 * GiB));
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.8-flash-next:vision", 7 * GiB, 1)]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 1000 });
        await page.goto(`${fake.url}/api/version`);
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "620px"; panel.classList.add("open");
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
        await sleep(10000);   // enough history that a datapoint is a visible distance from its neighbour

        const plot = async () => frame.locator(".rc-plot").first().boundingBox();
        const shot = (n) => page.screenshot({ path: path.join(ART, n) });

        // 1 — the free crosshair.
        await narrate(page, "By default the crosshair follows the pointer",
            { sub: "the tooltip names a real sample; the line sits wherever you are — they disagree" });
        let p = await plot();
        await page.mouse.move(p.x + p.width * 0.55, p.y + p.height * 0.5);
        await sleep(PACE); await shot("1-free.png");

        // 2 — turn it on, in the panel's own settings.
        await narrate(page, "The panel's own settings — Cursor: snap to datapoint",
            { sub: "beside what the chart draws, not in Settings: it is a mode you flip while reading" });
        await frame.locator('[aria-label="Edit tracks"]').click();
        await sleep(900);
        await frame.locator(".rc-eopt", { hasText: "snap to datapoint" }).locator("input").check();
        await sleep(PACE); await shot("2-toggle.png");
        await frame.locator('[aria-label="Edit tracks"]').click();
        await sleep(800);

        // 3 — a dot on every line.
        await narrate(page, "Now it lands ON the reading — one dot per line",
            { sub: "over the plot's background you get the overview: every boundary at that sample" });
        p = await plot();
        for (const fx of [0.5, 0.58, 0.66]) { await page.mouse.move(p.x + p.width * fx, p.y + p.height * 0.08); await sleep(700); }
        await sleep(PACE); await shot("3-dots.png");

        // 4 — focus.
        await narrate(page, "Hover ONE band and it narrows to one dot",
            { sub: "the panel already dimmed the others to say 'this one' — a full set would contradict that" });
        await frame.locator(".rc-band").first().hover();
        await sleep(PACE); await shot("4-focus.png");

        // 5 — the selection snaps too.
        await narrate(page, "A selection snaps to datapoints as well",
            { sub: "one rule for where the pointer is — and the edges are then real measurements" });
        p = await plot();
        const y = p.y + p.height * 0.5;
        await page.mouse.move(p.x + p.width * 0.3, y);
        await page.mouse.down();
        for (const fx of [0.4, 0.5, 0.6, 0.68]) { await page.mouse.move(p.x + p.width * fx, y); await sleep(220); }
        await sleep(900); await shot("5-select.png");
        await page.mouse.up();
        await sleep(PACE); await shot("6-zoomed.png");
        await frame.locator(".vram-zoom").click().catch(() => {});   // back to live
        await sleep(900);

        // 6 — an event rule owns the pointer.
        await narrate(page, "An eviction rules through the plot", { sub: "watch what the crosshair does when you point at it" });
        fake.setResident([resident("qwen3.8-flash-next:vision", 7 * GiB, 1)]);
        fake.setCapacity(boxOf(IDLE, IDLE - 7 * GiB));
        for (let i = 0; i < 40 && !(await frame.locator(".rc-rule").count()); i++) await sleep(500);
        await sleep(1500);
        const rule = await frame.locator(".rc-rule").first().boundingBox();
        if (rule) {
            await page.mouse.move(rule.x + rule.width / 2, rule.y + rule.height / 2 + 25);
            await page.mouse.move(rule.x + rule.width / 2, rule.y + rule.height / 2, { steps: 3 });
            await sleep(PACE); await shot("7-rule.png");
            await narrate(page, "The line and its dots stand down",
                { sub: "a rule names an INSTANT, the crosshair the nearest SAMPLE — never the same x" });
            await sleep(PACE);
        }

        // 7 — Esc.
        p = await plot();
        await page.mouse.move(p.x + p.width * 0.45, p.y + p.height * 0.45);
        await sleep(900);
        await narrate(page, "Esc hides the tooltip so you can LOOK at the shape",
            { sub: "the mark stays — it is where you were looking" });
        await page.keyboard.press("Escape");
        await sleep(PACE); await shot("8-esc.png");
        await narrate(page, "Move, and it is back", { sub: "not a mode you have to leave" });
        await page.mouse.move(p.x + p.width * 0.5, p.y + p.height * 0.45);
        await sleep(PACE); await shot("9-back.png");

        await narrate(page, null);
        await sleep(600); await shot("10-final.png");
        await narrateDone(page);
        console.log(`\nscreenshots → ${ART}`);
        if (HOLD) { console.log("holding the browser open — close the window or Ctrl+C to exit"); await new Promise(() => {}); }
    } finally {
        if (!HOLD) { await ext.context.close(); await fake.stop(); }
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
