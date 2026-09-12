// A NARRATED DEMO, not a test: what is new in the resource panel (2026-09-11/12), in one run.
//
//   npm run build && node --import tsx tests/e2e/panel-news-demo.mjs
//
// A fake box drives the panel over the event stream the way a patched Ollama does — samples at the stream's
// cadence (1 s, 250 ms during a load), edges between them — so every beat shows the product reading the shapes
// the real server sends: which process holds what on a card, a load that overshoots and settles, the
// predictor's estimate against it, the engine's own prefill/decode timings, and a streamed token count.
// Deterministic: no model and no key.
//
// HOLD=0 exits instead of holding the browser open; PACE sets the beat (ms); HEADLESS=1 runs it unseen (for
// checking the script itself). Screenshots land in tests/e2e/artifacts/panel-news-demo/. The assertions are in
// resource-panel.spec.mjs, resource-stream.spec.mjs and orb-stream.spec.mjs.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, narrate, narrateDone, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";
const PACE = Number(process.env.PACE || 3200);
const ART = path.resolve("tests/e2e/artifacts/panel-news-demo");
mkdirSync(ART, { recursive: true });

const GiB = 1024 ** 3, MiB = 1024 ** 2, TOTAL = 101972967424, PHYS = 102641958912;
const FQ = (m) => `registry.ollama.ai/library/${m}`;

// ---- the fake box: what is on each card, as the driver lists it --------------------------------------------
const GEMMA = { name: "gemma4:31b", quant: "Q4_K_M", params: "31.3B", family: "gemma4",
    memory: { weights: 15702717235, kv_cache: 2448264397, compute: 556793856, output: 620756992 } };
const QWEN = { name: "qwen3.8:27b", quant: "Q8_0", params: "27.8B", family: "qwen3",
    memory: { weights: 17287872512, kv_cache: 4187593728, compute: 1073741824 } };
const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
const state = {
    // model → { card, share (bytes on the card), overhead (the runner's own), loading? }
    resident: new Map([[GEMMA.name, { card: 0, share: sum(GEMMA.memory), overhead: 520 * MiB, pid: 317, m: GEMMA }]]),
    loading: null,                 // { card, pid, bytes } while a runner is loading
    helpers: [],                   // [{ pid, name, cards: [..], bytes }]
    // Another container's torch process: its memory is out of free, and the driver does not list it.
    unseen: { 1: 2.5 * GiB },
    // A process the driver DOES list, that is not ollama's.
    tenants: [{ card: 1, pid: 4242, name: "python3", bytes: 3 * GiB }],
    phase: new Map(),              // model → "prefill" | "decode"
};

function info() {
    const cards = [0, 1].map((id) => {
        const procs = [];
        for (const r of state.resident.values()) if (r.card === id)
            procs.push({ pid: r.pid, used_memory: r.share + r.overhead, name: "llama-server", runner: { model: r.m.name } });
        if (state.loading?.card === id)
            procs.push({ pid: state.loading.pid, used_memory: state.loading.bytes, name: "llama-server", runner: { model: state.loading.model, loading: true } });
        for (const h of state.helpers) if (h.cards.includes(id)) procs.push({ pid: h.pid, used_memory: h.bytes, name: h.name, ollama_helper: true });
        for (const t of state.tenants) if (t.card === id) procs.push({ pid: t.pid, used_memory: t.bytes, name: t.name });
        const used = procs.reduce((n, p) => n + p.used_memory, 0) + (state.unseen[id] ?? 0);
        return { gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2", pci_id: `0000:0${id * 2 + 1}:00.0`,
            total_memory: TOTAL, physical_memory: PHYS, free_memory: TOTAL - used,
            processes_scope: "pid_namespace", ...(procs.length ? { processes: procs } : {}) };
    });
    return { compute: { system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 100 * GiB }, supported_gpus: cards } };
}
function ps() {
    return { models: [...state.resident.values()].map((r) => ({
        name: r.m.name, model: r.m.name, size: r.share, size_vram: r.share, context_length: 32768,
        expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
        details: { format: "gguf", family: r.m.family, parameter_size: r.m.params, quantization_level: r.m.quant },
        memory: r.m.memory, gpus: [{ gpu_id: String(r.card), runner: "CUDA", size_vram: r.share, memory: r.m.memory }],
        activity: { phase: state.phase.get(r.m.name) ?? "idle", slots: 1, slots_busy: state.phase.has(r.m.name) ? 1 : 0, prompt_tokens: 2400 },
    })) };
}

const main = async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension({ headful: process.env.HEADLESS !== "1" });
    let ticker = null;
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({
            ml_res_layout: { presetId: "memory", tracks: [
                { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 120 },
                { id: "dev-1", series: ["vram.1"], mode: "stack", heightPx: 120 },
            ] },
            ml_res_window: 60, ml_res_sections: { lane: true, models: true }, ml_lane_scope: false,
        }));
        // Forty seconds of history already in the server's ring, so the chart opens with a past to read.
        fake.setCapacity(info()); fake.setResident(ps().models);
        fake.setEvents(Array.from({ length: 40 }, (_, i) => ({ v: 1, kind: "sample", t: -(40 - i) * 1000, ps: ps(), info: info() })));

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 1000 });
        await page.goto(`${fake.url}/api/version`);
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "640px"; panel.classList.add("open");
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
        // LIVE from here: every frame is stamped against the connection's hello, as the real stream's are.
        for (let i = 0; i < 100 && fake.streamSubscribers() < 1; i++) await sleep(100);
        const helloAt = Date.now();
        const push = (f) => fake.pushFrame({ v: 1, ...f, t: Date.now() - helloAt });
        const sample = () => push({ kind: "sample", ps: ps(), info: info() });
        let cadence = 1000;
        const tick = async () => { for (;;) { sample(); await sleep(cadence); if (ticker === "stop") return; } };
        ticker = tick();
        await sleep(2500);

        const shot = (n) => page.screenshot({ path: path.join(ART, n) });
        const track = (i) => frame.locator(".rc-track").nth(i);
        const beat = async (text, sub) => { await narrate(page, text, sub ? { sub } : {}); await sleep(PACE); };
        /** Take the pointer off the chart the way a hand does — in steps, to a quiet spot inside the panel — so the
         *  chart sees it leave. A one-step jump out of the iframe never tells it, and its last hover stays up. */
        const park = async () => {
            const h = await frame.locator(".vram-head").first().boundingBox();
            await page.mouse.move(h.x + 40, h.y - 20, { steps: 6 });
            await sleep(200);
        };

        // 1 — WHICH BUILD, in words.
        await beat("What is new in the resource panel", "Two cards. gemma4:31b is on CUDA0; CUDA1 holds a stranger's process and something ollama cannot see.");
        await frame.locator(".vram-row .vram-quant").first().hover();
        await beat("1 · The model row says which build it is — in words", "“4-bit weights”, not “Q4_K_M”. The code, what it means, the parameter count and family are in the tooltip.");
        await shot("01-quant.png");

        // 2 — THE RESIDUAL, NAMED BY PROCESS.
        const p1 = await track(1).locator(".rc-plot").boundingBox();
        await page.mouse.move(p1.x + p1.width * 0.7, p1.y + 6);
        await beat("2 · Memory that is not a model is named by process", "CUDA1: python3 (pid 4242) is listed by the driver and is not ollama's; 2.5 GiB is held by something ollama's container cannot see.");
        await shot("02-residual-by-process.png");
        const p0 = await track(0).locator(".rc-plot").boundingBox();
        await page.mouse.move(p0.x + p0.width * 0.7, p0.y + 6);
        await beat("…and a runner's own overhead sits on its model", "gemma4:31b's runner holds 520 MiB beyond the model's buffers — measured per runner, in a wash of the model's colour.");
        await shot("03-runner-overhead.png");

        // 3 — THE GEAR: time grid and load predictions, both off by default.
        await park();
        await frame.locator(".vram-head").first().hover();
        await frame.locator('[aria-label="Edit tracks"]').click();
        await beat("3 · Two new switches in the chart's gear, both off by default", "“time grid” for reading the axis, and “load predictions” for tuning the server's VRAM predictor.");
        await frame.locator(".rc-editor .rc-eopt", { hasText: /time grid/ }).locator("input").check();
        await frame.locator(".rc-editor .rc-eopt", { hasText: /load predictions/ }).locator("input").check();
        await shot("04-gear.png");
        await sleep(PACE / 2);
        await frame.locator('[aria-label="Edit tracks"]').click();
        await beat("The time grid: the axis is LINEAR in time", "Evenly spaced lines at a round interval, named in each plot's corner. Where a gap collapses, the spacing restarts.");
        await shot("05-time-grid.png");

        // 4 — A LIVE LOAD: not monotonic, set against its prediction.
        await narrate(page, "4 · A model loads onto CUDA1 — watch it overshoot and settle", { sub: "The predictor says 20.4 GiB (for placement). Helpers come and go; the weights land; the context allocates." });
        cadence = 250;
        push({ kind: "estimate", model: FQ(QWEN.name), estimate: { predicted: 19.5 * GiB, predicted_for_load: 20.4 * GiB, source: "calibration",
            num_ctx: 32768, num_gpu: 1, num_batch: 512, metadata_complete: true, breakdown: { weights: 17.7 * GiB, kv_cache: 2.2 * GiB, compute: 0 } } });
        push({ kind: "load.start", model: FQ(QWEN.name) });
        state.helpers = [{ pid: 298, name: "ollama", cards: [0, 1], bytes: 550 * MiB }];
        await sleep(900);
        state.helpers = [{ pid: 286, name: "llama-server", cards: [1], bytes: 576 * MiB }];
        await sleep(700);
        state.helpers = [];
        state.loading = { card: 1, pid: 900, model: QWEN.name, bytes: 0.6 * GiB };
        for (const g of [3, 6, 10, 14, 16.1]) { state.loading.bytes = g * GiB; await sleep(500); }
        push({ kind: "load.weights", model: FQ(QWEN.name), size_vram: QWEN.memory.weights });
        for (const g of [18, 21, 23.4, 22.4, 21.6]) { state.loading.bytes = g * GiB; await sleep(500); }
        state.loading = null;
        state.resident.set(QWEN.name, { card: 1, share: sum(QWEN.memory), overhead: 0.6 * GiB - (sum(QWEN.memory) - 21 * GiB), pid: 900, m: QWEN });
        push({ kind: "load.complete", model: FQ(QWEN.name), duration_ms: 7200, weights_ms: 4300, context_ms: 2900,
            size_vram: sum(QWEN.memory), size_total: sum(QWEN.memory), memory: QWEN.memory });
        await sleep(1500);
        cadence = 1000;
        await beat("The dashed line is where the predictor said CUDA1 would land", "The band overshot it during the load and settled above it: that gap is the prediction's error, read without a tooltip.");
        await shot("06-load-dashed-line.png");
        await frame.locator(".rc-ev-load").last().hover();
        await beat("The load's tooltip sets the prediction against what it took", "Peak during the load, where it settled, weights and KV term by term. More than predicted is flagged — the direction that breaks a fit.");
        await shot("07-load-prediction-tooltip.png");

        // 5 — ml.__loads(): the same comparison, as data.
        await park();
        await waitForMl(page);
        const loads = await page.evaluate(() => window.ml.__loads());
        const r = loads.at(-1);
        const gib = (b) => (b / GiB).toFixed(2);
        if (r) console.log(`ml.__loads() → ${loads.length} record(s); last: ${r.model} peak ${gib(r.trace?.peak?.bytes ?? 0)} GiB, settled ${gib(r.trace?.final?.bytes ?? 0)} GiB, predicted ${gib(r.estimate?.predicted_for_load ?? 0)} GiB, ${r.trace?.points?.length ?? 0} trace points`);
        await beat("5 · ml.__loads() hands the same comparison back as data", r
            ? `${loads.length} record: ${r.model} — predicted ${gib(r.estimate.predicted_for_load)} GiB, peak ${gib(r.trace.peak.bytes)}, settled ${gib(r.trace.final.bytes)}, ${r.trace.points.length} trace points. Collected only while the toggle is on.`
            : "No record yet (it lands once the load's settling reading arrives).");

        // 6 — THE PHASE RIBBON: what each card was doing, from the engine's own timings.
        await narrate(page, "6 · Each card now says what it was doing", { sub: "Generations on both models: the engine's own prefill (dense) and decode (lighter) timings, along the top of each card." });
        const gen = async (m, promptMs, evalMs, decoded) => {
            push({ kind: "gen.start", model: FQ(m) });
            state.phase.set(m, "prefill"); await sleep(promptMs);
            state.phase.set(m, "decode"); await sleep(evalMs);
            state.phase.delete(m);
            push({ kind: "gen.end", model: FQ(m), timings: { prompt_tokens: 2400, prompt_tokens_cached: 1800, prompt_ms: promptMs, eval_ms: evalMs, decoded } });
        };
        await Promise.all([gen(QWEN.name, 900, 3200, 260), (async () => { await sleep(1200); await gen(GEMMA.name, 600, 2600, 190); })()]);
        await gen(QWEN.name, 1400, 2000, 150);
        await sleep(1200);
        await beat("The ribbon: prefill dense, decode lighter, a row per model", "Only timed work is drawn, so an empty stretch claims nothing — idle included. The lane's “calls” toggle hides it too.");
        await shot("08-phase-ribbon.png");

        // 7 — DRILLED IN, THE LOAD'S ALLOCATION CURVE IS STILL THERE.
        const q = await track(1).locator(".rc-plot").boundingBox();
        await page.mouse.move(q.x + q.width * 0.55, q.y + q.height * 0.6);
        await sleep(400);
        for (let i = 0; i < 2; i++) { await page.keyboard.press("ArrowDown"); await sleep(250); }
        await page.keyboard.press("ArrowRight");
        await beat("7 · Drilled into a model (→), its load's allocation curve stays", "Memory arriving before the runner reports any figures is drawn as the model's own, dashed — it used to vanish from exactly this view.");
        await shot("09-drilled-in-load-curve.png");
        for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await sleep(150); }

        // 8 — ONE SET OF KIND TOGGLES.
        await park();
        await frame.locator(".vram-head").first().hover();
        await frame.locator('[aria-label="Edit tracks"]').click();
        await frame.locator(".rc-editor .rc-eopt", { hasText: /^\s*loads\s*$/ }).locator("input").uncheck();
        await beat("8 · One set of event toggles, obeyed everywhere", "“loads” off in the gear: the load's rules leave the plot and its bar leaves the lane — the lane's chips are the same switch.");
        await shot("10-kind-toggles.png");
        await frame.locator(".rc-editor .rc-eopt", { hasText: /^\s*loads\s*$/ }).locator("input").check();
        await frame.locator('[aria-label="Edit tracks"]').click();

        // 9 — THE ENGINE'S TOKEN COUNT, through a tool call.
        ticker = "stop";
        await narrate(page, "9 · The live token count is the engine's own", { sub: "It used to be estimated from the streamed text, and froze while a model wrote a tool call. Watch the corner card." });
        const fake2 = await startFakeLlm({ model: "fake-model", streamDelayMs: 140 });
        try {
            await configureExtension(ext.sw, { chatUrl: fake2.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
            fake2.setScript([
                { tool: "findByText", args: { text: "x".repeat(900) }, emit: [{ kind: "think", text: "I will search the page for it." }, ...Array.from({ length: 45 }, () => ({ kind: "call" }))] },
                { content: "Found it." },
            ]);
            const p2 = await ext.context.newPage();
            await p2.setViewportSize({ width: 1500, height: 1000 });
            await p2.goto(`${fake2.url}/api/version`);
            await waitForMl(p2);
            await narrate(p2, "9 · The live token count is the engine's own", { sub: "Exact (no “~”), and still climbing while the model streams a tool call's arguments — the stretch that used to freeze." });
            await p2.evaluate(() => { window.__run = window.ml.agent("find it", { stream: true }); });
            await sleep(2600);
            await p2.screenshot({ path: path.join(ART, "11-token-count.png") });
            await sleep(4000);
            await p2.evaluate(() => window.__run).catch(() => {});
            await narrateDone(p2, "Demo finished — the browser is yours");
        } finally { if (!HOLD) await fake2.stop(); }
        console.log(`screenshots: ${ART}`);
        if (HOLD) { console.log("Holding the browser open — close it (or Ctrl+C) to exit."); await new Promise((r) => ext.context.on("close", r)); }
    } finally {
        ticker = "stop";
        await ext.close().catch(() => {});
        await fake.stop();
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
