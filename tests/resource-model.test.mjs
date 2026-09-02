"use strict";
// The resource panel's pure data model: /api/info + /api/ps → the bands, series and history the chart draws.
// Fixtures are REAL captures where possible (the CUDA ones are live gpubox bodies, trimmed) — see
// docs/spec/RESOURCE_PANEL.md, which also lists the Metal samples still to be pinned down.
import { test } from "node:test";
import assert from "node:assert";
const M = await import("../resource-model.ts");

const GB = 1e9;
// Live gpubox: 2x ~102 GB CUDA cards, 130 GB system. Both cards idle here (~0.59 GB held by something else).
const CUDA_INFO = {
    compute: {
        system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12330946560, free_swap: 3330347008 },
        supported_gpus: [
            { gpu_id: "0", name: "CUDA0", total_memory: 101972967424, free_memory: 101386813440, compute: "12.0", driver: "13.2", runner: "CUDA" },
            { gpu_id: "1", name: "CUDA1", total_memory: 101972967424, free_memory: 101386813440, compute: "12.0", driver: "13.2", runner: "CUDA" },
        ],
    },
};
// Metal's shape per the handover: ONE device, `compute`/`driver` absent, a working set well under system RAM.
// The literals are unconfirmed (spec §2.2) — this fixture asserts the treatment, not the strings.
const METAL_INFO = {
    compute: {
        system_compute: { cpu_cores: 10, total_memory: 17179869184, free_memory: 4e9, free_swap: 0 },
        supported_gpus: [{ gpu_id: "0", name: "Metal", total_memory: 12700000000, free_memory: 9e9, runner: "Metal" }],
    },
};

test("parseInfo: reads a live CUDA body — discrete devices, host RAM, swap", () => {
    const cap = M.parseInfo(CUDA_INFO);
    assert.equal(cap.devices.length, 2);
    assert.equal(cap.devices[0].name, "CUDA0");
    assert.equal(cap.devices[0].runner, "CUDA");
    assert.equal(cap.devices[0].unified, false, "CUDA is a pool separate from system RAM");
    assert.equal(cap.unified, false);
    assert.equal(cap.host.cores, 32);
    assert.equal(cap.host.swapFreeBytes, 3330347008);
});

test("parseInfo: Metal is UNIFIED — the device total overlaps system RAM", () => {
    const cap = M.parseInfo(METAL_INFO);
    assert.equal(cap.devices[0].unified, true);
    assert.equal(cap.unified, true, "the capacity as a whole is flagged, so nothing sums device + host");
    assert.equal(cap.host.swapFreeBytes, null, "free_swap 0 is UNKNOWN on macOS, not 'no swap'");
});

test("parseInfo: an unrecognised runner is treated as unified (the safe guess)", () => {
    const cap = M.parseInfo({ compute: { system_compute: { total_memory: 8e9 }, supported_gpus: [{ gpu_id: "0", runner: "Vulkan", total_memory: 4e9, free_memory: 4e9 }] } });
    assert.equal(cap.unified, true, "guessing discrete would produce a wrong SUM; guessing unified only declines to add");
    assert.equal(M.isDiscrete("ROCm"), true, "ROCm is assumed to match CUDA (spec §2.2)");
});

test("parseInfo: a missing route returns null, never a zero capacity", () => {
    // Stock Ollama / unpatched OpenWebUI answers this route with the SPA's HTML.
    assert.equal(M.parseInfo("<!doctype html><html><body>…"), null);
    assert.equal(M.parseInfo({}), null);
    assert.equal(M.parseInfo({ compute: {} }), null);
    assert.equal(M.parseInfo(null), null);
});

test("residencyFrom: GPU-resident, CPU-resident, and unattributable placements", () => {
    const gpu = M.residencyFrom({ name: "qwen3.5:0.8b", size: 5453182401, size_vram: 5453182401,
        context_length: 262144, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: 5453182401 }] });
    assert.equal(gpu.vramBytes, 5453182401);
    assert.equal(gpu.ramBytes, 0);
    assert.deepEqual(gpu.perDevice, { 0: 5453182401 });
    assert.equal(M.isCpuResident(gpu), false);

    // `gpus` ABSENT is the server's contract for "on the CPU" — not an empty array, not unknown.
    const cpu = M.residencyFrom({ name: "qwen3.5:0.8b", size: 5460000000, size_vram: 0 });
    assert.equal(cpu.vramBytes, 0);
    assert.equal(cpu.ramBytes, 5460000000, "everything not in VRAM is host RAM");
    assert.deepEqual(cpu.perDevice, {});
    assert.equal(M.isCpuResident(cpu), true);

    // Caveat 2: the deployed server reports 0 per device for a placement not starting at card 0, while the
    // TOTAL is right. That is UNKNOWN, and reading it as zero would silently drop the model from the chart.
    const odd = M.residencyFrom({ name: "big", size: 20 * GB, size_vram: 20 * GB, gpus: [{ gpu_id: "1", size_vram: 0 }] });
    assert.equal(odd.perDevice["1"], null, "0 under a non-zero total is unknown, not zero");
    assert.equal(odd.vramBytes, 20 * GB, "the total is still trusted");
});

test("deviceBands: attributed / other / free — the middle band is the point", () => {
    // The live box, a few minutes before the idle capture: 18.2 GB free on card 0 with NOTHING of ours loaded.
    const busy = { compute: { ...CUDA_INFO.compute,
        supported_gpus: [{ ...CUDA_INFO.compute.supported_gpus[0], free_memory: 18196987904 }, CUDA_INFO.compute.supported_gpus[1]] } };
    const sample = { t: 1, models: [], capacity: M.parseInfo(busy) };
    const bands = M.deviceBands(sample, "0");
    const by = Object.fromEntries(bands.map((b) => [b.key, b.bytes]));
    assert.equal(by["m:anything"], undefined, "no models of ours are resident");
    assert.ok(by.other > 83 * GB, "83 GB in use that no model of ours accounts for — shown as NOT ours");
    assert.equal(by.free, 18196987904);
    assert.equal(bands.at(-1).kind, "free", "free is the last band, so the stack reads bottom-up to capacity");
});

test("deviceBands: one band per model, plus an explicit unknown for an unattributable one", () => {
    const cap = M.parseInfo(CUDA_INFO);
    // Card 0 holding two models (attributed) and one the server can't place.
    cap.devices[0].freeBytes = cap.devices[0].totalBytes - 41 * GB;
    const sample = { t: 1, capacity: cap, models: [
        M.residencyFrom({ name: "gemma4:31b", size: 18 * GB, size_vram: 18 * GB, gpus: [{ gpu_id: "0", size_vram: 18 * GB }] }),
        M.residencyFrom({ name: "qwen3.5:32b", size: 22 * GB, size_vram: 22 * GB, gpus: [{ gpu_id: "0", size_vram: 22 * GB }] }),
        M.residencyFrom({ name: "mystery", size: 1 * GB, size_vram: 1 * GB, gpus: [{ gpu_id: "0", size_vram: 0 }] }),
    ] };
    const bands = M.deviceBands(sample, "0");
    const models = bands.filter((b) => b.kind === "model").map((b) => b.model);
    assert.deepEqual(models, ["gemma4:31b", "qwen3.5:32b"], "one band per attributable model, carrying its name");
    const unknown = bands.find((b) => b.kind === "unknown");
    assert.equal(unknown.bytes, 1 * GB, "the unplaceable model gets its OWN band, not folded into 'other'");
    const other = bands.find((b) => b.kind === "other");
    assert.equal(other.bytes, 0, "41 GB in use = 18 + 22 + 1, so nothing is left unaccounted for");
});

test("deviceBands: a single-device box needs no attribution — the total IS the share", () => {
    const sample = { t: 1, capacity: M.parseInfo(METAL_INFO), models: [
        M.residencyFrom({ name: "solo", size: 5 * GB, size_vram: 5 * GB }),   // no gpus[] reported at all
    ] };
    const band = M.deviceBands(sample, "0").find((b) => b.kind === "model");
    assert.equal(band.bytes, 5 * GB, "with one device there is nowhere else it could be");
});

test("hostBands: a model's CPU spill is attributed, the rest is not ours", () => {
    const sample = { t: 1, capacity: M.parseInfo(CUDA_INFO), models: [
        M.residencyFrom({ name: "spilled", size: 10 * GB, size_vram: 6 * GB, gpus: [{ gpu_id: "0", size_vram: 6 * GB }] }),
    ] };
    const bands = M.hostBands(sample);
    assert.equal(bands.find((b) => b.kind === "model").bytes, 4 * GB, "size - size_vram is the RAM half");
    assert.ok(bands.find((b) => b.kind === "other").bytes > 100 * GB, "the OS and everything else");
});

test("stackRefusal: stacking asserts a real total, so the false cases are refused", () => {
    const cudaCap = M.parseInfo(CUDA_INFO);
    const metalCap = M.parseInfo(METAL_INFO);
    const sample = { t: 1, capacity: cudaCap, models: [] };
    const cat = M.seriesCatalog(sample);
    const byId = (id) => cat.find((s) => s.id === id);

    assert.equal(M.stackRefusal([byId("vram.0")], cudaCap), null, "one series always stacks");
    assert.match(M.stackRefusal([byId("vram.0"), byId("vram.1")], cudaCap), /each card has its own capacity/i,
        "two cards have no meaningful combined total — a model can only use one card's");
    assert.match(M.stackRefusal([byId("vram.0"), byId("ram")], metalCap), /same silicon|double-count/i,
        "on unified memory the device and host totals describe the same pool");
    assert.match(M.stackRefusal([byId("vram.0"), byId("ram")], cudaCap), /different pools/i,
        "even discrete, VRAM + RAM in ONE stack claims a total that isn't measured against anything");
});

test("seriesCatalog: generated from the devices the box actually reports", () => {
    const two = M.seriesCatalog({ t: 1, capacity: M.parseInfo(CUDA_INFO), models: [] }).map((s) => s.id);
    assert.deepEqual(two, ["vram.0", "vram.1", "ram"], "two cards → two device series, no hardcoding");
    const one = M.seriesCatalog({ t: 1, capacity: M.parseInfo(METAL_INFO), models: [] }).map((s) => s.id);
    assert.deepEqual(one, ["vram.0", "ram"], "the same code yields a one-device catalog on a Mac");

    // A resident model adds its own per-device and (when it spills) per-host series.
    const withModel = M.seriesCatalog({ t: 1, capacity: M.parseInfo(METAL_INFO), models: [
        M.residencyFrom({ name: "m", size: 10 * GB, size_vram: 6 * GB }),
    ] }).map((s) => s.id);
    assert.ok(withModel.includes("vram.0.m"), "the model is plottable on the device");
    assert.ok(withModel.includes("ram.m"), "…and its spill is plottable against host RAM");
});

test("presetsFor: the default layout follows the hardware", () => {
    const multi = M.presetsFor({ t: 1, capacity: M.parseInfo(CUDA_INFO), models: [] });
    assert.equal(multi[0].id, "placement", "two cards → lead with WHERE the model landed");
    assert.equal(multi[0].tracks.length, 2, "one track per card — small multiples, not a shared axis");

    const single = M.presetsFor({ t: 1, capacity: M.parseInfo(METAL_INFO), models: [] });
    assert.equal(single[0].id, "memory", "one device → placement is meaningless, so lead with GPU vs RAM");
    assert.ok(!single.some((p) => p.id === "placement"), "and don't offer a per-card view of one card");
});

test("segments: history breaks at a hole instead of drawing across it", () => {
    const s = (t) => ({ t, models: [], capacity: null });
    const runs = M.segments([s(0), s(2000), s(4000), s(600000), s(602000)], M.MAX_SAMPLE_GAP_MS);
    assert.equal(runs.length, 2, "the ten-minute gap (panel closed) splits the line");
    assert.deepEqual(runs.map((r) => r.length), [3, 2]);
    assert.equal(M.segments([]).length, 0);
    assert.equal(M.segments([s(0)]).length, 1, "a lone sample is its own segment — a point, not a line");
    // A normal cadence is never split.
    assert.equal(M.segments([s(0), s(2000), s(4000)]).length, 1);
});

test("eventsIn: only the window, in time order", () => {
    const ev = (t, label) => ({ t, kind: "note", label });
    const all = [ev(50, "late"), ev(10, "early"), ev(500, "outside"), ev(1, "before")];
    assert.deepEqual(M.eventsIn(all, 5, 100).map((e) => e.label), ["early", "late"]);
    assert.deepEqual(M.eventsIn(all, 0, 0).map((e) => e.label), []);
});
