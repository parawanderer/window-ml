// resource-demo.mjs — a NARRATED DEMO of the resource panel (not a test; the assertions are
// resource-panel.spec.mjs). Drives a scripted fake box so the tracks fill with movement you can watch:
// models load onto different cards, one evicts, one spills to the CPU, and the panel is CLOSED for a spell so
// the history shows an honest GAP rather than a line drawn across memory nobody measured.
//
//   npm run build && node --import tsx tests/e2e/resource-demo.mjs
//
// Env: HOLD=0 exits at the end instead of holding the browser open. PACE scales every wait.
//      ONLY=events skips the memory narrative and goes straight to the event lane (~20s instead of ~2min).
//      The final beats script a RUN (posted as the same __mlDebug events a real one emits) so the event lane
//      has something in it: a model load, a delegated vision sub-call, and a step that waited at an approval
//      gate — the three shapes the lane exists to tell apart.
//      BOX=cuda (default) | amd | laptop | rig | lab | metal picks which machine to pretend to be — two
//      discrete cards naming nvidia-smi, two naming rocm-smi, a 12 GiB laptop 4080 where a 27B model has to
//      spill into RAM, four NVLinked 3090s a 70B is split across, an eight-A100 lab node (nine pools, past
//      the curated palette), or a Mac's single unified pool.
// Screenshots land in tests/e2e/artifacts/resource-demo/ (BOX=metal → …/resource-demo-metal/).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HOLD = process.env.HOLD !== "0";
const PACE = Number(process.env.PACE || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const log = (m) => console.log(`  ${m}`);
const gb = (b) => `${(b / GiB).toFixed(0)} GiB`;

const GiB = 1024 ** 3;

// WHICH MACHINE to pretend to be: BOX=cuda (default) | amd | laptop | rig | lab | metal. The panel reads differently on each —
// a discrete card names nvidia-smi/rocm-smi in its ceiling note, while a Mac has ONE pool shared with the
// system and names no vendor tool at all — and the only way to see that without the hardware is to fake it.
const BOX = process.env.BOX || "cuda";
// ONLY=events jumps straight to the event lane (the full walk takes ~2 minutes to reach it).
const ONLY = process.env.ONLY || "";
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
    // The homelab rig: four RTX 3090s (24 GiB each, NVLink-paired) and 128 GiB of system RAM. The point of
    // this shape is that a 70B model does NOT fit on any one card — it is split across all four, and each
    // card's track shows only its own share.
    rig: {
        runner: "CUDA", hostTotal: 137438953472, idleHeld: 0.35 * GiB,
        devices: [0, 1, 2, 3].map((id) => gpu({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA",
            total_memory: 25757220864, physical_memory: 25769803776 })),
        models: { a: ["qwen3.5:14b", 9 * GiB], b: ["gemma4:12b", 7 * GiB], c: ["phi5:14b", 8 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["llama4:70b", 21 * GiB], cpu: ["util:2b", 3 * GiB] },
    },
    // The ordinary consumer machine: an RTX 4080 Laptop (12 GiB GDDR6) and 32 GiB of system RAM. The whole
    // point of this shape is that things DON'T fit — a 27B model has to be split between the card and RAM,
    // which is the everyday case the big boxes never show.
    //
    // ONE device, deliberately: the laptop also has an integrated GPU, but ollama's CUDA build enumerates CUDA
    // devices only, so an Intel/AMD iGPU doesn't appear unless the Vulkan backend is in play. (If it ever
    // does, it is a UNIFIED device — it has no memory of its own, it shares system RAM — sitting beside a
    // discrete one, which is a shape the model does not handle today: `Capacity.unified` is true when ANY
    // device is unified, which would collapse the 4080's own pool into the host's. Wants a real capture.)
    laptop: {
        runner: "CUDA", hostTotal: 34359738368, idleHeld: 0.3 * GiB,
        devices: [gpu({ gpu_id: "0", name: "CUDA0", runner: "CUDA",
            total_memory: 12736200704, physical_memory: 12884901888 })],
        models: { a: ["qwen3.5:8b", 5 * GiB], b: ["gemma4:12b", 7 * GiB], c: ["phi5:4b", 3 * GiB],
                  d: ["coder:3b", 2 * GiB], big: ["gemma4:27b", 9 * GiB], cpu: ["util:1b", 2 * GiB] },
    },
    // The lab node: eight A100 80GB and a terabyte of RAM. NINE pools — past the curated palette, which is
    // where "colour per pool" has to keep meaning something.
    lab: {
        runner: "CUDA", hostTotal: 1099511627776, idleHeld: 0.6 * GiB,
        devices: [0, 1, 2, 3, 4, 5, 6, 7].map((id) => gpu({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA",
            total_memory: 85899345920, physical_memory: 85899345920 })),
        models: { a: ["gemma4:31b", 18 * GiB], b: ["qwen3.5:35b", 22 * GiB], c: ["phi5:14b", 9 * GiB],
                  d: ["coder:7b", 5 * GiB], big: ["deepseek:671b", 70 * GiB], cpu: ["util:2b", 7 * GiB] },
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

/** The scripted run the event lane draws. Posted as the same `__mlDebug` events a real run emits, so the
 *  shell relays them exactly as it would its own — the fake box moves memory but runs no model.
 *
 *  Every timestamp is relative to NOW and must land inside the sampled window, so the caller says how far
 *  back the history actually reaches: an event before the first sample is correctly dropped (nothing was
 *  measured then), which on a short warm-up would silently leave the lane looking empty. */
const scriptRun = (page, spanMs) => page.evaluate((span) => {
    const now = Date.now();
    const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
    const hash = "demo-run";
    // Built FORWARD from the run's start, not backward from now: a step's timestamp is when it FINISHED, so
    // laying these out by counting back is how the first version ended up with a model load that began
    // BEFORE the run that waited through it — a fixture claiming something the loop could never produce.
    const t0 = now - span;                   // the agent starts
    const gap = Math.round(span * 0.03);     // a beat before the first call
    const step = (from, parts) => from + parts.reduce((a, b) => a + b, 0);

    post({ kind: "agent", id: hash, ts: t0, save: false, session: { hash, turn: 0 },
           task: "summarise the spreadsheet", model: "gemma4:31b", maxSteps: 8, config: null });

    // Step 1: the model wasn't resident. A long load, a short generation, a quick tool.
    const load1 = Math.round(span * 0.30), gen1 = Math.round(span * 0.10), tool1 = Math.round(span * 0.06);
    const ts1 = step(t0 + gap, [load1, gen1, tool1]);
    post({ kind: "agent-step", id: hash, ts: ts1, save: false, session: { hash, turn: 1 },
           step: 1, seq: 1, tool: "exec", toolMs: tool1,
           arguments: { js: "document.title" }, result: "ok",
           renderIn: { type: "code", lang: "javascript", code: "document.title", format: true },
           usage: { promptTokens: 2400, completionTokens: 90, totalTokens: 2490, genMs: gen1, loadMs: load1 } });

    // Step 2: resident now, so the cost is generation + a slow tool — and it DELEGATED: a vision reader ran
    // INSIDE the tool's own window, twice. Hovering one lights only its lineage.
    const gen2 = Math.round(span * 0.08), tool2 = Math.round(span * 0.22);
    const ts2 = step(ts1, [gen2, tool2]);
    const readerEnd = ts2 - Math.round(tool2 * 0.15);
    post({ kind: "agent-step", id: hash, ts: ts2, save: false, session: { hash, turn: 2 },
           step: 2, seq: 2, tool: "python_exec", toolMs: tool2,
           arguments: { code: "df.describe()" }, result: "ok",
           renderIn: { type: "python-in", mode: "readonly", source: "df.describe()",
                       tables: [{ name: "df", source: "#sales", kind: "dom",
                                  df: { columns: ["Rep", "Q1", "Q2"],
                                        rows: [["Gia", 320, 530], ["Kim", 410, 400], ["Ada", 275, 610]] } }] },
           renderOut: { type: "python-out", stdout: "count    3.000000\nmean   513.333333\nstd    105.4",
                        df: { columns: ["", "Q1", "Q2"],
                              rows: [["count", 3, 3], ["mean", 335, 513.33], ["std", 68.4, 105.4]] } },
           usage: { promptTokens: 3100, completionTokens: 210, totalTokens: 3310, genMs: gen2, loadMs: 40 },
           subUsage: { calls: 2, prompt: 1600, completion: 60,
                       byModel: [{ model: "minicpm-v:8b", prompt: 1600, completion: 60, calls: 2 }],
                       calls_: [{ model: "minicpm-v:8b", ts: readerEnd - Math.round(tool2 * 0.35), ms: Math.round(tool2 * 0.3), prompt: 800, completion: 30 },
                                { model: "minicpm-v:8b", ts: readerEnd, ms: Math.round(tool2 * 0.25), prompt: 800, completion: 30 }] } });

    // Step 3: gated. The model wrote the call quickly, a human took far longer to allow it, the tool ran in
    // no time — so most of that block is a person deciding, and it must not read as work.
    const gen3 = Math.round(span * 0.05), wait3 = Math.round(span * 0.14), tool3 = Math.round(span * 0.02);
    const ts3 = step(ts2, [gen3, wait3, tool3]);
    post({ kind: "agent-step", id: hash, ts: ts3, save: false, session: { hash, turn: 3 },
           step: 3, seq: 3, tool: "exec", toolMs: tool3, approveMs: wait3, approval: "user",
           arguments: { js: "document.querySelectorAll('tr').length" }, result: "41",
           renderIn: { type: "code", lang: "javascript", code: "document.querySelectorAll('tr').length", format: true },
           renderOut: { type: "keyval", pairs: [["value", "41"]] },
           usage: { promptTokens: 3300, completionTokens: 45, totalTokens: 3345, genMs: gen3, loadMs: 30 } });
    post({ kind: "agent-result", id: hash, ts: ts3 + Math.round(span * 0.01), save: false,
           session: { hash, turn: 3 }, summary: "done", steps: 3, hitCap: false });
}, spanMs);

async function main() {
    mkdirSync(ART, { recursive: true });
    const fake = await startFakeLlm({ model: "fake-model" });
    // A NARRATED DEMO: it exists to be watched, so it keeps a real window even though the harness is now
    // headless by default. (Everything else — the e2e suite, bench cells, observe without WATCH — runs
    // headless, because a window that steals focus on every launch makes the machine unusable.)
    const ext = await launchExtension({ headful: true });
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

        // ONLY=events — skip the memory narrative and go straight to the lane. It still needs an AXIS to draw
        // against (an event outside the sampled window is correctly dropped), so this warms up just long
        // enough for a run of samples, moves a model to give the trace some shape, and scripts the run across
        // exactly the window that exists.
        if (ONLY === "events") {
            const warm = 16_000;
            log("ONLY=events — warming the axis for 16s, then scripting the run.");
            fake.setResident([resident(M.a[0], M.a[1], 0)]);
            fake.setCapacity(box(freeWith([M.a[1]]), 10 * GiB));
            await sleep(warm / 2);
            // A second model, then an eviction: something for the trace to do, and a rule to hover.
            fake.setResident([resident(M.a[0], M.a[1], 0), resident(M.b[0], M.b[1], 1 % DEVS)]);
            fake.setCapacity(box(freeWith(DEVS > 1 ? [M.a[1], M.b[1]] : [M.a[1] + M.b[1]]), 9 * GiB));
            await sleep(warm / 3);
            fake.setResident([resident(M.b[0], M.b[1], 1 % DEVS)]);
            fake.setCapacity(box(freeWith(DEVS > 1 ? [0, M.b[1]] : [M.b[1]]), 9 * GiB));
            await sleep(warm / 6);
            log("events: a model load, a delegated reader, and a step that waited at an approval gate.");
            await scriptRun(page, warm * 0.75);
            await sleep(4000);
            await capture(page, "events");
            console.log(`\n  screenshots in ${ART}`);
            if (HOLD) { log("holding the browser open (HOLD=0 to skip)."); await new Promise(() => {}); }
            return;
        }

        log(`panel open — ${DEVS === 1 ? "one idle device" : `${DEVS} idle cards`}, holding only ollama's driver context.`);
        await sleep(3000);
        await capture(page, "idle");

        // 1. A model lands on card 0.
        fake.setResident([resident(M.a[0], M.a[1], 0)]);
        fake.setCapacity(box(freeWith([M.a[1]]), 12.3 * GiB));
        log(`${M.a[0]} loaded onto ${SHAPE.devices[0].name} (${gb(M.a[1])}).`);
        await sleep(6000);
        await capture(page, "one-model");

        // 2. A second model, on the OTHER card — the reason tracks are small multiples.
        fake.setResident([resident(M.a[0], M.a[1], 0), resident(M.b[0], M.b[1], 1 % DEVS)]);
        fake.setCapacity(box(freeWith(DEVS > 1 ? [M.a[1], M.b[1]] : [M.a[1] + M.b[1]]), 12.3 * GiB));
        log(`${M.b[0]} loaded onto ${SHAPE.devices[1 % DEVS].name} (${gb(M.b[1])}) — a model can only use ONE card's capacity.`);
        await sleep(6000);
        await capture(page, "two-cards");

        // 3. A third, CPU-resident: no gpus[] at all, so it lives in the System RAM track.
        fake.setResident([
            resident(M.a[0], M.a[1], 0), resident(M.b[0], M.b[1], 1 % DEVS),
            resident(M.cpu[0], 0, null, M.cpu[1]),
        ]);
        fake.setCapacity(box(freeWith(DEVS > 1 ? [M.a[1], M.b[1]] : [M.a[1] + M.b[1]]), 5.3 * GiB));
        log(`${M.cpu[0]} forced to the CPU — it holds no VRAM, so it appears against System RAM.`);
        await sleep(6000);
        await capture(page, "cpu-resident");

        // 4. Evict the big one: the stack drops and the history keeps the shape.
        fake.setResident([resident(M.b[0], M.b[1], 1 % DEVS), resident(M.cpu[0], 0, null, M.cpu[1])]);
        fake.setCapacity(box(freeWith(DEVS > 1 ? [0, M.b[1]] : [M.b[1]]), 5.3 * GiB));
        log(`${M.a[0]} evicted — ${SHAPE.devices[0].name} falls back to its driver context.`);
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
        log(`churn: models load and evict at random, and ${SHAPE.devices[0].name} takes two at once…`);
        const POOL = [M.a, M.b, M.c, M.d].map(([name, bytes]) => ({ name, bytes }));
        // Seeded, so a screenshot of a run can be reproduced — random-LOOKING is the point, not unrepeatable.
        let seed = 20260903;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const live = new Map();   // name → { bytes, gpu }
        // Place them the way ollama would: a model takes what FITS on its card and spills the rest to system
        // RAM. Without this the churn could stack 17 GiB of models onto a 12 GiB laptop card and the panel
        // would faithfully report 128% of a capacity — a number no real box can produce.
        const push = () => {
            const room = SHAPE.devices.map((_, i) => IDLE(i));
            const models = [];
            for (const [name, m] of live) {
                const fits = Math.max(0, Math.min(m.bytes, room[m.gpu]));
                room[m.gpu] -= fits;
                models.push(fits > 0 ? resident(name, 0, { [m.gpu]: fits }, m.bytes) : resident(name, 0, null, m.bytes));
            }
            fake.setResident(models);
            fake.setCapacity(box(room, 8 * GiB));
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
            else { const g = Math.floor(rnd() * DEVS); live.set(pick.name, { bytes: pick.bytes, gpu: g }); log(`  ${pick.name} → ${SHAPE.devices[g].name}`); }
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
        if (DEVS > 2) live.set(M.d[0], { bytes: M.d[1], gpu: 2 });
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
        // Editing a track flipped the picker to Custom (a layout is no longer that preset), which left every
        // later beat rendering ONE track — the split across four cards is not much of a demonstration on one.
        await frame.locator(".rc-preset").selectOption("memory").catch(() => {});
        await sleep(1500);

        // 8. A model too big for one card: SPLIT unevenly across both, with the remainder in system RAM. Each
        //    device's stack shows only ITS share, the row says how it was divided, and nothing is summed
        //    across pools — the parts of one model living in three places is exactly the case a single
        //    "30 GiB resident" figure hides.
        if (DEVS === 1 && !SHAPE.devices[0].name.startsWith("MTL")) {
            // One card, and a model bigger than it: part on the GPU, the rest in system RAM. The row says how
            // it was divided; the card's track shows only its share.
            const onGpu = Math.round(devTotal(0) * 0.78 / GiB) * GiB;
            const spill = 8 * GiB;
            log(`partial offload: ${gb(onGpu)} of a ${gb(onGpu + spill)} model on ${SHAPE.devices[0].name}, ${gb(spill)} in RAM — the everyday case on one card.`);
            fake.setResident([resident("gemma4:27b", 0, { 0: onGpu }, onGpu + spill)]);
            fake.setCapacity(box(freeWith([onGpu]), 6 * GiB));
            await sleep(7000);
            await capture(page, "partial-offload");
        }
        if (DEVS > 1) {
            // Uneven ON PURPOSE: a split is not a clean division. Card 0 usually takes the most (it holds the
            // KV cache and the output layer), the rest take what fits, and the remainder lives in system RAM.
            const shares = SHAPE.devices.map((_, i) => Math.round((devTotal(i) * (i === 0 ? 0.72 : 0.5 + 0.06 * i)) / GiB) * GiB);
            const spill = Math.round(devTotal(0) * 0.3 / GiB) * GiB;
            const onDev = Object.fromEntries(shares.map((b, i) => [i, b]));
            log(`split: ${DEVS === 2 ? "one model across both cards" : `one model across all ${DEVS} cards`} — ` +
                `${shares.map((b, i) => `${SHAPE.devices[i].name} ${(b / GiB).toFixed(0)} GiB`).join(" + ")} + ${(spill / GiB).toFixed(0)} GiB in RAM.`);
            fake.setResident([resident(DEVS > 2 ? "llama4:70b" : "colossus:120b", 0, onDev,
                shares.reduce((n, b) => n + b, 0) + spill)]);
            fake.setCapacity(box(freeWith(shares), 6 * GiB));
            await sleep(7000);
            await capture(page, "split-model");
        }

        // 9. The EVENT LANE: what happened, under what it happened to. The fake box moves memory but runs no
        //    model, so the run is scripted — these are the same `__mlDebug` events a real run emits, posted
        //    from the page so the shell relays them exactly as it would its own. The timings are the point:
        //    a model load, a slow generation, and a tool that took longer than the model did.
        log("events: a scripted run on the same axis — a model load, a delegated reader, and a step that waited at an approval gate.");
        await scriptRun(page, 26_000);
        await sleep(6000);
        await capture(page, "events");

        // 10. Capacity STOPS answering. What was already measured stands — a box does not lose its hardware
        //    because one poll came back empty, and forgetting it swapped the panel for the legacy chart at
        //    random.
        log("the box stops answering /api/info — the panel keeps what it measured rather than flipping views.");
        fake.setCapacity(null);
        await sleep(14000);
        await capture(page, "capacity-silent");

        // 11. The real degrade: a box that has NEVER answered. Fresh page, since that is a different state.
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
