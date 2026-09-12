// A NARRATED DEMO, not a test: the "Whole box" view across the machine shapes people actually run — and how the
// links BETWEEN cards are drawn on it (NVLink, NVSwitch, AMD's Infinity Fabric, and plain PCIe).
//
//   npm run build && node --import tsx tests/e2e/whole-box-demo.mjs
//
// Whole box lays every pool end to end on one axis, each as tall as its own capacity, with the WALLS between
// them. Where two adjacent cards share a direct fabric (NVLink / xGMI) the wall is drawn as a hatched BRIDGE,
// cards are reordered so linked pairs sit side by side, and a group that is not a full mesh is drawn lighter.
//
// The boxes are tests/fixtures/boxes.mjs, shared with the unit tests' drift guards. The gpubox PCIe topology is a
// REAL capture; every NVLink and xGMI topology is a MOCK written against the design doc, because no machine the
// server was built on has that silicon — the first real capture replaces the matching mock.
//
// HOLD=0 exits instead of holding the browser open; PACE sets the beat (ms); HEADLESS=1 runs it unseen.
// Screenshots land in tests/e2e/artifacts/whole-box-demo/.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { BOXES, TOPOLOGIES, pci, GiB } from "../fixtures/boxes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";
const PACE = Number(process.env.PACE || 4200);
const ART = path.resolve("tests/e2e/artifacts/whole-box-demo");
mkdirSync(ART, { recursive: true });

/** A model resident on some cards: `on` maps card index → bytes there. */
const model = (name, quant, on) => ({ name, quant, on });

/** The beats: which box, which topology, what is loaded, and what to say about it. */
const SCENES = [
    { key: "gpubox", title: "gpubox — two 96 GB cards over PCIe (a REAL capture)", box: BOXES.cuda, topo: TOPOLOGIES.pcie2,
      sub: "No NVLink on either card: plain walls, and the tip says the pair talks through the CPU's host bridge.",
      models: [model("gemma4:31b", "Q4_K_M", { 0: 18 * GiB }), model("qwen3.5:35b", "Q4_K_M", { 1: 22 * GiB })] },
    { key: "rig-adjacent", title: "4× RTX 3090, NVLink bridges on 0–1 and 2–3", box: BOXES.rig, topo: TOPOLOGIES.rigAdjacent,
      sub: "A 70B model split across all four. The bridged pairs' walls are hatched; the wall between the pairs is plain PCIe.",
      models: [model("llama4:70b", "Q4_K_M", { 0: 10.5 * GiB, 1: 10.5 * GiB, 2: 10.5 * GiB, 3: 10.5 * GiB }), model("qwen3.5:14b", "Q4_K_M", { 0: 9 * GiB })] },
    { key: "rig-crossed", title: "The same four 3090s, bridged 0–2 and 1–3 instead", box: BOXES.rig, topo: TOPOLOGIES.rigCrossed,
      sub: "The cards are REORDERED 0, 2, 1, 3 — a wall between neighbours is the only place a bridge can be drawn on one axis.",
      models: [model("llama4:70b", "Q4_K_M", { 0: 10.5 * GiB, 1: 10.5 * GiB, 2: 10.5 * GiB, 3: 10.5 * GiB })] },
    { key: "nvswitch", title: "8× A100 80 GB on an NVSwitch", box: BOXES.lab, topo: TOPOLOGIES.nvswitch8,
      sub: "Every pair is directly linked, so every wall between cards is a bridge: one group of eight.",
      models: [model("deepseek:671b", "Q4_K_M", Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, 48 * GiB]))), model("gemma4:31b", "Q4_K_M", { 0: 18 * GiB })] },
    { key: "dgx1", title: "8× GPUs in a DGX-1 hybrid cube-mesh", box: BOXES.lab, topo: TOPOLOGIES.dgx1,
      sub: "Each card is linked to 4 of its 7 peers. A chain can bridge every ADJACENT pair without being a full mesh — so the group is drawn lighter, and the tip names the pairs that are not linked.",
      models: [model("deepseek:671b", "Q4_K_M", Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, 48 * GiB])))] },
    { key: "amd-pair", title: "AMD: 2× Instinct MI210 with an Infinity Fabric Link bridge", box: BOXES.amd, topo: TOPOLOGIES.amdBridged,
      sub: "AMD's NVLink equivalent is xGMI (Infinity Fabric). The server reports it as a direct fabric, and it is drawn as a bridge the same way.",
      models: [model("qwen3.5:35b", "Q4_K_M", { 0: 11 * GiB, 1: 11 * GiB }), model("phi5:14b", "Q8_0", { 1: 9 * GiB })] },
    { key: "mi300x", title: "AMD: 8× Instinct MI300X, all-to-all over xGMI", box: BOXES.mi300x, topo: TOPOLOGIES.xgmi8,
      sub: "Every card has a direct Infinity Fabric link to every other, with no switch: a full mesh of eight 192 GB cards.",
      models: [model("deepseek:671b", "Q8_0", Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, 90 * GiB]))), model("gemma4:31b", "Q4_K_M", { 3: 18 * GiB })] },
];

function infoFor(shape, topo, models) {
    const onCard = (i) => models.reduce((n, m) => n + (m.on[i] ?? 0), 0);
    return { compute: {
        system_compute: { cpu_cores: 64, total_memory: shape.hostTotal, free_memory: Math.round(shape.hostTotal * 0.8) },
        supported_gpus: shape.devices.map((d, i) => ({ ...d, pci_id: topo?.gpus?.[i] ?? pci(i),
            free_memory: d.total_memory - shape.idleHeld - onCard(i) })),
        ...(topo ? { topology: topo } : {}),
    } };
}
function psFor(shape, models) {
    return models.map((m) => {
        const cards = Object.entries(m.on);
        const size = cards.reduce((n, [, b]) => n + b, 0);
        return { name: m.name, model: m.name, size, size_vram: size, context_length: 32768,
            expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
            details: { format: "gguf", quantization_level: m.quant },
            gpus: cards.map(([id, b]) => ({ gpu_id: id, runner: shape.runner, size_vram: b })) };
    });
}

const main = async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension({ headful: process.env.HEADLESS !== "1" });
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_window: 60, ml_res_sections: { lane: false, models: true }, ml_vram_h: 560 }));

        /** Open the panel on a fresh tab against whatever box the fake currently is. */
        const openOn = async () => {
            const page = await ext.context.newPage();
            await page.setViewportSize({ width: 1500, height: 1000 });
            await page.goto(`${fake.url}/api/version`);
            await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
            await page.evaluate(() => {
                const root = document.getElementById("ml-sb-root").shadowRoot;
                const panel = root.getElementById("ml-sb-host");
                panel.style.width = "720px"; panel.classList.add("open");
                root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
            });
            let frame = null;
            for (let i = 0; i < 80 && !frame; i++) { frame = page.frames().find((fr) => /sidebar\.html/.test(fr.url())) || null; if (!frame) await sleep(100); }
            if (!frame) throw new Error("sidebar iframe never appeared");
            for (let i = 0; i < 5 && !(await frame.locator(".vram").count()); i++) {
                await frame.locator('[aria-label="VRAM monitor"]').click();
                await sleep(400);
            }
            return { page, frame };
        };

        let prev = null;
        for (const [n, s] of SCENES.entries()) {
            fake.setCapacity(infoFor(s.box, s.topo, s.models));
            fake.setResident(psFor(s.box, s.models));
            const { page, frame } = await openOn();
            if (prev) await prev.close();
            prev = page;
            await narrate(page, `${n + 1} · ${s.title}`, { sub: s.sub });
            // THE VIEW, picked the way a user picks it.
            const picker = frame.locator("select.rc-preset");
            await picker.waitFor({ timeout: 20000 });
            await picker.selectOption("box");
            await sleep(4500);   // a few polls, so each pool has a trace to draw
            await page.screenshot({ path: path.join(ART, `${String(n + 1).padStart(2, "0")}-${s.key}.png`) });
            await sleep(PACE);
            // …and the words for it: hovering a card opens the pool tip, whose links section says what each wall is.
            const plot = await frame.locator(".rc-plot").first().boundingBox();
            await page.mouse.move(plot.x + plot.width * 0.6, plot.y + plot.height * 0.9, { steps: 6 });
            await sleep(900);
            await page.screenshot({ path: path.join(ART, `${String(n + 1).padStart(2, "0")}-${s.key}-tip.png`) });
            await sleep(PACE);
        }

        // THE MAC: one unified pool, so there is no "whole box" to lay end to end — the axis IS that pool.
        const metal = BOXES.metal;
        fake.setCapacity({ compute: {
            system_compute: { cpu_cores: 12, total_memory: metal.hostTotal, free_memory: 14 * GiB },
            supported_gpus: metal.devices.map((d) => ({ ...d, free_memory: d.total_memory - 9 * GiB })) } });
        fake.setResident([{ name: "gemma4:12b", model: "gemma4:12b", size: 9 * GiB, size_vram: 9 * GiB, context_length: 32768,
            expires_at: new Date(Date.now() + 9 * 60_000).toISOString(), details: { format: "gguf", quantization_level: "Q4_K_M" },
            gpus: [{ gpu_id: "0", runner: "Metal", size_vram: 9 * GiB }] }]);
        const { page: mac, frame: mf } = await openOn();
        if (prev) await prev.close();
        await sleep(3000);
        const views = await mf.locator("select.rc-preset option").allTextContents().catch(() => []);
        await narrate(mac, `${SCENES.length + 1} · A Mac — one unified pool`, { sub: `No “Whole box” here, deliberately: the GPU and the system share one pool, so laying pools end to end would draw the same memory twice. Views offered: ${views.join(" · ") || "(one)"}.` });
        await mac.screenshot({ path: path.join(ART, `${String(SCENES.length + 1).padStart(2, "0")}-metal.png`) });
        await sleep(PACE * 1.5);
        await narrateDone(mac, "Demo finished — the browser is yours");
        console.log(`screenshots: ${ART}`);
        if (HOLD) { console.log("Holding the browser open — close it (or Ctrl+C) to exit."); await new Promise((r) => ext.context.on("close", r)); }
    } finally {
        await ext.close().catch(() => {});
        await fake.stop();
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
