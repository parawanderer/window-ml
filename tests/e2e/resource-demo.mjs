// resource-demo.mjs — a NARRATED DEMO of the resource panel (not a test; the assertions are
// resource-panel.spec.mjs). Drives a scripted fake box so the tracks fill with movement you can watch:
// models load onto different cards, one evicts, one spills to the CPU, and the panel is CLOSED for a spell so
// the history shows an honest GAP rather than a line drawn across memory nobody measured.
//
//   npm run build && node --import tsx tests/e2e/resource-demo.mjs
//
// Env: HOLD=0 exits at the end instead of holding the browser open. PACE scales every wait.
// Screenshots land in tests/e2e/artifacts/resource-demo/.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HOLD = process.env.HOLD !== "0";
const PACE = Number(process.env.PACE || 1);
const ART = path.resolve("tests/e2e/artifacts/resource-demo");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const log = (m) => console.log(`  ${m}`);

const GiB = 1024 ** 3;
// gpubox's real shape: two ~95 GiB cards and 121 GiB of system RAM. `physical_memory` is the DRIVER
// framebuffer total (what nvidia-smi shows); `total_memory` is ollama's own, ~638 MiB lower.
const card = (id, freeBytes) => ({
    gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2",
    total_memory: 101972967424, physical_memory: 102641958912, free_memory: freeBytes,
});
const IDLE = 94.42 * GiB;   // an idle card still holds ~0.55 GiB: ollama's discovery context, not a process
const box = (free0, free1, hostFree) => ({
    models: { count: 32, running: 0, vram_used: 0 },
    compute: {
        system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: hostFree, free_swap: 3330347008 },
        supported_gpus: [card(0, free0), card(1, free1)],
    },
});
const resident = (name, vramBytes, gpu, sizeBytes = vramBytes) => ({
    model: name, name, size: sizeBytes, size_vram: vramBytes, context_length: 262144,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...(vramBytes ? { gpus: [{ gpu_id: String(gpu), runner: "CUDA", size_vram: vramBytes }] } : {}),
});

async function main() {
    mkdirSync(ART, { recursive: true });
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    let shot = 0;
    const capture = async (page, label) => {
        await page.screenshot({ path: path.join(ART, `${String(++shot).padStart(2, "0")}-${label}.png`) }).catch(() => {});
    };
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        fake.setCapacity(box(IDLE, IDLE, 12.3 * GiB));
        fake.setResident([]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto("about:blank");
        await page.goto(`${fake.url}/api/version`);   // any page the content script can attach to
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });

        // Slide the overlay open and switch to the VRAM monitor. A reload re-mounts the shell, so this is a
        // function rather than a one-off.
        const openOverlay = () => page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "460px";
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        // The iframe is replaced on every page load, so hold it in a variable the reload can refresh.
        const findFrame = async () => {
            for (let i = 0; i < 80; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        };
        await openOverlay();
        let frame = await findFrame();
        // Toggling blind desyncs (a missed click leaves the panel in the opposite state and every later step
        // is inverted), so drive it to the state we want and verify.
        const setPanel = async (open) => {
            for (let i = 0; i < 4; i++) {
                const showing = (await frame.locator(".vram").count()) > 0;
                if (showing === open) return;
                await frame.locator('[aria-label="VRAM monitor"]').click();
                await sleep(400);
            }
            throw new Error(`couldn't put the VRAM panel ${open ? "open" : "closed"}`);
        };
        await setPanel(true);
        log("panel open — two idle cards, each holding only ollama's driver context.");
        await sleep(3000);
        await capture(page, "idle");

        // 1. A model lands on card 0.
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0)]);
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE, 12.3 * GiB));
        log("gemma4:31b loaded onto CUDA0 (18 GiB).");
        await sleep(6000);
        await capture(page, "one-model");

        // 2. A second model, on the OTHER card — the reason tracks are small multiples.
        fake.setResident([resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1)]);
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 22 * GiB, 12.3 * GiB));
        log("qwen3.5:35b loaded onto CUDA1 (22 GiB) — a model can only use ONE card's capacity.");
        await sleep(6000);
        await capture(page, "two-cards");

        // 3. A third, CPU-resident: no gpus[] at all, so it lives in the System RAM track.
        fake.setResident([
            resident("gemma4:31b", 18 * GiB, 0), resident("qwen3.5:35b", 22 * GiB, 1),
            resident("util:2b", 0, null, 7 * GiB),
        ]);
        fake.setCapacity(box(IDLE - 18 * GiB, IDLE - 22 * GiB, 5.3 * GiB));
        log("util:2b forced to the CPU — it holds no VRAM, so it appears against System RAM.");
        await sleep(6000);
        await capture(page, "cpu-resident");

        // 4. Evict the big one: the stack drops and the history keeps the shape.
        fake.setResident([resident("qwen3.5:35b", 22 * GiB, 1), resident("util:2b", 0, null, 7 * GiB)]);
        fake.setCapacity(box(IDLE, IDLE - 22 * GiB, 5.3 * GiB));
        log("gemma4:31b evicted — CUDA0 falls back to its driver context.");
        await sleep(6000);
        await capture(page, "evicted");

        // 5. CLOSE the panel for longer than the sample gap, then reopen. Polling is gated on the panel being
        //    open, so nothing is measured meanwhile — and the chart must show a BREAK, not a line across it.
        await setPanel(false);
        log("panel closed for 20s — nothing is polled, so nothing is measured…");
        fake.setResident([resident("qwen3.5:35b", 22 * GiB, 1), resident("gemma4:31b", 30 * GiB, 0)]);
        fake.setCapacity(box(IDLE - 30 * GiB, IDLE - 22 * GiB, 8 * GiB));
        await sleep(20000);
        await setPanel(true);
        log("…reopened. The history shows a GAP, not a line drawn across memory nobody measured.");
        await sleep(6000);
        await capture(page, "gap");

        // 6. Capacity STOPS answering. What was already measured stands — a box does not lose its hardware
        //    because one poll came back empty, and forgetting it swapped the panel for the legacy chart at
        //    random.
        log("the box stops answering /api/info — the panel keeps what it measured rather than flipping views.");
        fake.setCapacity(null);
        await sleep(14000);
        await capture(page, "capacity-silent");

        // 7. The real degrade: a box that has NEVER answered. Fresh page, since that is a different state.
        log("a box that never answers /api/info — capacity unknown, so no ceiling is invented.");
        await page.reload();
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await openOverlay();
        frame = await findFrame();
        await setPanel(true);
        await sleep(4000);
        await capture(page, "no-capacity");

        // Restore a full box and let it rebuild, so the browser is HELD OPEN on the interesting view rather
        // than on the degraded one — the last step is a demonstration, not the resting state.
        fake.setCapacity(box(IDLE - 30 * GiB, IDLE - 22 * GiB, 8 * GiB));
        log("capacity restored — holding here.");
        await sleep(8000);
        await capture(page, "restored");

        console.log(`\n  screenshots in ${ART}`);
        if (HOLD) {
            log("holding the browser open (HOLD=0 to skip). Close the window or Ctrl+C to exit.");
            await new Promise(() => {});
        }
    } finally {
        if (!HOLD) { await ext.close().catch(() => {}); await fake.stop().catch(() => {}); }
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
