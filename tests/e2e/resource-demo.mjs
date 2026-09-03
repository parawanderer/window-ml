// resource-demo.mjs — a NARRATED DEMO of the resource panel (not a test; the assertions are
// resource-panel.spec.mjs). Drives a scripted fake box so the tracks fill with movement you can watch:
// models load onto different cards, one evicts, one spills to the CPU, and the panel is CLOSED for a spell so
// the history shows an honest GAP rather than a line drawn across memory nobody measured.
//
//   npm run build && node --import tsx tests/e2e/resource-demo.mjs
//
// Env: HOLD=0 exits at the end instead of holding the browser open. PACE scales every wait.
//      BOX=cuda (default) | amd | metal picks which machine to pretend to be — two discrete cards naming
//      nvidia-smi, two naming rocm-smi, or a Mac's single unified pool that names no vendor tool at all.
// Screenshots land in tests/e2e/artifacts/resource-demo/ (BOX=metal → …/resource-demo-metal/).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HOLD = process.env.HOLD !== "0";
const PACE = Number(process.env.PACE || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const log = (m) => console.log(`  ${m}`);

const GiB = 1024 ** 3;

// WHICH MACHINE to pretend to be: BOX=cuda (default) | amd | metal. The panel reads differently on each —
// a discrete card names nvidia-smi/rocm-smi in its ceiling note, while a Mac has ONE pool shared with the
// system and names no vendor tool at all — and the only way to see that without the hardware is to fake it.
const BOX = process.env.BOX || "cuda";
const ART = path.resolve(`tests/e2e/artifacts/resource-demo${BOX === "cuda" ? "" : `-${BOX}`}`);

const gpu = (o) => ({ compute: "12.0", driver: "13.2", ...o });
/** Each shape: the devices, the host total, and a model catalogue sized to fit THAT machine. */
const BOXES = {
    // gpubox's real shape: two ~95 GiB cards and 121 GiB of system RAM. `physical_memory` is the DRIVER
    // framebuffer total (what nvidia-smi shows); `total_memory` is ollama's own, ~638 MiB lower.
    cuda: {
        runner: "CUDA", hostTotal: 130142785536, idleHeld: 0.55 * GiB,
        devices: [0, 1].map((id) => gpu({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA",
            total_memory: 101972967424, physical_memory: 102641958912 })),
        models: { a: ["gemma4:31b", 18 * GiB], b: ["qwen3.5:35b", 22 * GiB], c: ["phi5:14b", 9 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["gemma4:31b", 30 * GiB], cpu: ["util:2b", 7 * GiB] },
    },
    // An AMD box: two Instinct-class cards. Same discrete shape, different vendor tool in the note.
    amd: {
        runner: "ROCm", hostTotal: 274877906944, idleHeld: 0.4 * GiB,
        devices: [0, 1].map((id) => gpu({ gpu_id: String(id), name: `ROCm${id}`, runner: "ROCm",
            total_memory: 68719476736, physical_memory: 68719476736 })),
        models: { a: ["gemma4:31b", 18 * GiB], b: ["qwen3.5:35b", 22 * GiB], c: ["phi5:14b", 9 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["gemma4:31b", 30 * GiB], cpu: ["util:2b", 7 * GiB] },
    },
    // A Mac: ONE unified pool. `total_memory` is the advised working set (~75% of the system), NOT a second
    // pool — and there is no physical_memory and no vendor tool to point at.
    metal: {
        runner: "Metal", hostTotal: 34359738368, idleHeld: 0.2 * GiB,
        devices: [gpu({ gpu_id: "0", name: "MTL0", runner: "Metal", total_memory: 25769803776 })],
        models: { a: ["gemma4:12b", 7 * GiB], b: ["qwen3.5:8b", 5 * GiB], c: ["phi5:4b", 3 * GiB],
                  d: ["coder:3b", 2 * GiB], big: ["gemma4:12b", 11 * GiB], cpu: ["util:1b", 2 * GiB] },
    },
};
const SHAPE = BOXES[BOX] || BOXES.cuda;
const M = SHAPE.models;                       // M.a[0] is a name, M.a[1] its size on this machine
const DEVS = SHAPE.devices.length;
const devTotal = (i) => SHAPE.devices[i % DEVS].total_memory;
const IDLE = (i = 0) => devTotal(i) - SHAPE.idleHeld;   // an idle card still holds ollama's discovery context

/** A box reading: free bytes per device (indexed), and the host's free bytes. */
const box = (free, hostFree) => ({
    models: { count: 32, running: 0, vram_used: 0 },
    compute: {
        system_compute: { cpu_cores: 32, total_memory: SHAPE.hostTotal, free_memory: hostFree, free_swap: 3330347008 },
        supported_gpus: SHAPE.devices.map((d, i) => ({ ...d, free_memory: free[i] ?? IDLE(i) })),
    },
});
/** A resident model. `gpu` may be an index, or a {gpuIndex: bytes} map for a model SPLIT across cards; any
 *  bytes beyond the sum sit in system RAM (the spilled part). */
const resident = (name, vramBytes, gpuOrSplit, sizeBytes = vramBytes) => {
    const split = typeof gpuOrSplit === "object" && gpuOrSplit !== null;
    const gpus = split
        ? Object.entries(gpuOrSplit).map(([id, size]) => ({ gpu_id: String(id), runner: SHAPE.runner, size_vram: size }))
        : (vramBytes ? [{ gpu_id: String(gpuOrSplit), runner: SHAPE.runner, size_vram: vramBytes }] : []);
    const onGpu = gpus.reduce((n, g) => n + g.size_vram, 0);
    return {
        model: name, name, size: sizeBytes, size_vram: onGpu, context_length: 262144,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        ...(gpus.length ? { gpus } : {}),
    };
};
/** Free bytes per device given what is resident on each. */
const freeWith = (onDev) => SHAPE.devices.map((_, i) => IDLE(i) - (onDev[i] || 0));

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
        fake.setCapacity(box(freeWith([]), 12.3 * GiB));
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
        fake.setResident([resident(M.a[0], M.a[1], 0)]);
        fake.setCapacity(box(freeWith([M.a[1]]), 12.3 * GiB));
        log("gemma4:31b loaded onto CUDA0 (18 GiB).");
        await sleep(6000);
        await capture(page, "one-model");

        // 2. A second model, on the OTHER card — the reason tracks are small multiples.
        fake.setResident([resident(M.a[0], M.a[1], 0), resident(M.b[0], M.b[1], 1 % DEVS)]);
        fake.setCapacity(box(freeWith(DEVS > 1 ? [M.a[1], M.b[1]] : [M.a[1] + M.b[1]]), 12.3 * GiB));
        log("qwen3.5:35b loaded onto CUDA1 (22 GiB) — a model can only use ONE card's capacity.");
        await sleep(6000);
        await capture(page, "two-cards");

        // 3. A third, CPU-resident: no gpus[] at all, so it lives in the System RAM track.
        fake.setResident([
            resident(M.a[0], M.a[1], 0), resident(M.b[0], M.b[1], 1 % DEVS),
            resident(M.cpu[0], 0, null, M.cpu[1]),
        ]);
        fake.setCapacity(box(freeWith(DEVS > 1 ? [M.a[1], M.b[1]] : [M.a[1] + M.b[1]]), 5.3 * GiB));
        log("util:2b forced to the CPU — it holds no VRAM, so it appears against System RAM.");
        await sleep(6000);
        await capture(page, "cpu-resident");

        // 4. Evict the big one: the stack drops and the history keeps the shape.
        fake.setResident([resident(M.b[0], M.b[1], 1 % DEVS), resident(M.cpu[0], 0, null, M.cpu[1])]);
        fake.setCapacity(box(freeWith(DEVS > 1 ? [0, M.b[1]] : [M.b[1]]), 5.3 * GiB));
        log("gemma4:31b evicted — CUDA0 falls back to its driver context.");
        await sleep(6000);
        await capture(page, "evicted");

        // 5. CLOSE the panel for longer than the sample gap, then reopen. Polling is gated on the panel being
        //    open, so nothing is measured meanwhile — and the chart must show a BREAK, not a line across it.
        await setPanel(false);
        log("panel closed for 20s — nothing is polled, so nothing is measured…");
        fake.setResident([resident(M.b[0], M.b[1], 1 % DEVS), resident(M.big[0], M.big[1], 0)]);
        fake.setCapacity(box(freeWith(DEVS > 1 ? [M.big[1], M.b[1]] : [M.big[1] + M.b[1]]), 8 * GiB));
        await sleep(20000);
        await setPanel(true);
        log("…reopened. The history shows a GAP, not a line drawn across memory nobody measured.");
        await sleep(6000);
        await capture(page, "gap");

        // 6. CHURN: models loading and evicting on their own, including TWO on the same card — the case the
        //    scripted steps never produce, where one device's stack has to divide between two models and the
        //    attribution has to keep up.
        log("churn: models load and evict at random, and CUDA0 takes two at once…");
        const POOL = [M.a, M.b, M.c, M.d].map(([name, bytes]) => ({ name, bytes }));
        // Seeded, so a screenshot of a run can be reproduced — random-LOOKING is the point, not unrepeatable.
        let seed = 20260903;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const live = new Map();   // name → { bytes, gpu }
        const push = () => {
            const models = [...live].map(([name, m]) => resident(name, m.bytes, m.gpu));
            const on = (g) => [...live.values()].filter((m) => m.gpu === g).reduce((n, m) => n + m.bytes, 0);
            fake.setResident(models);
            fake.setCapacity(box(SHAPE.devices.map((_, i) => IDLE(i) - on(i)), 8 * GiB));
        };
        // Start with the pair on ONE card, so the two-on-a-GPU case is guaranteed rather than hoped for.
        live.set(M.a[0], { bytes: M.a[1], gpu: 0 });
        live.set(M.c[0], { bytes: M.c[1], gpu: 0 });
        push();
        await sleep(7000);
        await capture(page, "two-on-one-card");
        for (let i = 0; i < 8; i++) {
            const pick = POOL[Math.floor(rnd() * POOL.length)];
            if (live.has(pick.name)) { live.delete(pick.name); log(`  ${pick.name} evicted`); }
            else { const g = DEVS > 1 ? (rnd() < 0.5 ? 0 : 1) : 0; live.set(pick.name, { bytes: pick.bytes, gpu: g }); log(`  ${pick.name} → ${SHAPE.devices[g].name}`); }
            push();
            await sleep(3000);
        }
        await capture(page, "churn");

        // 7. The same data, drawn both ways. A track can STACK its series (each one's own share of the pool,
        //    summing to the whole) or OVERLAY them (each as its own line) — the editor is where you choose,
        //    and the difference is easiest to see on a card that is holding two models.
        live.clear();
        live.set(M.a[0], { bytes: M.a[1], gpu: 0 });
        live.set(M.c[0], { bytes: M.c[1], gpu: 0 });
        live.set(M.b[0], { bytes: M.b[1], gpu: 1 % DEVS });
        push();
        await sleep(6000);
        log("stack vs overlay: the same series, summed into one shape or drawn as separate lines.");
        await frame.locator('[aria-label="Edit tracks"]').click();
        await sleep(1200);
        await capture(page, "editor-open");
        const mode = frame.locator(".rc-emode").first();
        if (await mode.count()) {
            await mode.selectOption("overlay");
            await sleep(4000);
            await capture(page, "overlay-mode");
            await mode.selectOption("stack");
            await sleep(4000);
            await capture(page, "stack-mode");
        }
        await frame.locator('[aria-label="Edit tracks"]').click();
        await sleep(1000);

        // 8. A model too big for one card: SPLIT unevenly across both, with the remainder in system RAM. Each
        //    device's stack shows only ITS share, the row says how it was divided, and nothing is summed
        //    across pools — the parts of one model living in three places is exactly the case a single
        //    "30 GiB resident" figure hides.
        if (DEVS > 1) {
            const onA = 26 * GiB, onB = 14 * GiB, spill = 8 * GiB;
            log(`split: one model across ${SHAPE.devices[0].name} (${(onA / GiB).toFixed(0)} GiB) + ${SHAPE.devices[1].name} (${(onB / GiB).toFixed(0)} GiB) + ${(spill / GiB).toFixed(0)} GiB in RAM.`);
            fake.setResident([resident("colossus:120b", 0, { 0: onA, 1: onB }, onA + onB + spill)]);
            fake.setCapacity(box(freeWith([onA, onB]), 6 * GiB));
            await sleep(7000);
            await capture(page, "split-model");
        }

        // 9. Capacity STOPS answering. What was already measured stands — a box does not lose its hardware
        //    because one poll came back empty, and forgetting it swapped the panel for the legacy chart at
        //    random.
        log("the box stops answering /api/info — the panel keeps what it measured rather than flipping views.");
        fake.setCapacity(null);
        await sleep(14000);
        await capture(page, "capacity-silent");

        // 10. The real degrade: a box that has NEVER answered. Fresh page, since that is a different state.
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
        fake.setCapacity(box(freeWith(DEVS > 1 ? [M.big[1], M.b[1]] : [M.big[1] + M.b[1]]), 8 * GiB));
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
