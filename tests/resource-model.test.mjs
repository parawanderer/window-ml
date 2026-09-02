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
// Live capture from a 16 GB Mac: ONE device named "MTL0", `compute`/`driver` absent, and a 12.71 GB working
// set inside a 17.18 GB system. Note the two "free" figures disagree wildly — the device reports itself all
// but empty while the SYSTEM is 13.5 GB deep in the same silicon. That is what makes device-side occupancy
// meaningless here, and it is asserted below.
const METAL_INFO = {
    compute: {
        system_compute: { cpu_cores: 10, total_memory: 17179869184, free_memory: 3682385920, free_swap: 0 },
        supported_gpus: [{ gpu_id: "0", name: "MTL0", total_memory: 12712935424, free_memory: 12711886848, runner: "Metal" }],
    },
};
// Live capture: the same model GPU-resident, then forced to the CPU with options {"num_gpu": 0}.
const METAL_PS_GPU = { name: "qwen3:0.6b", model: "qwen3:0.6b", size: 1039086387, size_vram: 1039086387,
    context_length: 4096, expires_at: "2026-09-02T16:32:54.167053+02:00",
    gpus: [{ gpu_id: "0", runner: "Metal", size_vram: 1039086387 }] };
const METAL_PS_CPU = { name: "qwen3:0.6b", model: "qwen3:0.6b", size: 1018523810, size_vram: 0,
    context_length: 4096, expires_at: "2026-09-02T16:33:04.541311+02:00" };

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
    assert.equal(cap.devices[0].runner, "Metal", "the confirmed literal from a live Mac");
    assert.equal(cap.devices[0].name, "MTL0", "…and the device label the track header shows");
    assert.equal(cap.devices[0].unified, true);
    assert.equal(cap.unified, true, "the capacity as a whole is flagged, so nothing sums device + host");
    assert.equal(cap.host.swapFreeBytes, null, "free_swap 0 is UNKNOWN on macOS, not 'no swap'");
    // Two ceilings for one pool: the working set is the "will it fit" number INSIDE the system total.
    const ceil = M.ceilingsFor({ t: 1, models: [], capacity: cap }, "0");
    assert.equal(ceil.hardBytes, 17179869184, "the hard limit is the system's, not the device's");
    assert.equal(ceil.softBytes, 12712935424, "the device total survives as a soft working-set line");
    // A discrete card has exactly one, real ceiling.
    const cudaCeil = M.ceilingsFor({ t: 1, models: [], capacity: M.parseInfo(CUDA_INFO) }, "0");
    assert.equal(cudaCeil.hardBytes, 101972967424);
    assert.equal(cudaCeil.softBytes, null);
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

test("deviceBands: a single DISCRETE device needs no attribution — the total IS the share", () => {
    const cap = M.parseInfo({ compute: { system_compute: { total_memory: 64e9, free_memory: 32e9 },
        supported_gpus: [{ gpu_id: "0", name: "CUDA0", total_memory: 24e9, free_memory: 19e9, runner: "CUDA" }] } });
    const sample = { t: 1, capacity: cap, models: [
        M.residencyFrom({ name: "solo", size: 5 * GB, size_vram: 5 * GB }),   // no gpus[] reported at all
    ] };
    const band = M.deviceBands(sample, "0").find((b) => b.kind === "model");
    assert.equal(band.bytes, 5 * GB, "with one card there is nowhere else it could be");
});

// The Mac capture's most important consequence. Its device reported 12.711 of 12.713 GB FREE while the system
// was 13.5 GB deep in the very same memory — so occupancy read off the device would show a nearly-empty box.
test("unified memory: occupancy comes from the HOST, and the model is attributed in FULL", () => {
    const sample = { t: 1, capacity: M.parseInfo(METAL_INFO), models: [M.residencyFrom(METAL_PS_GPU)] };
    const bands = M.deviceBands(sample, "0");
    const model = bands.find((b) => b.kind === "model");
    // size == size_vram on Metal, so ramBytes is 0; attributing only the spill would show NOTHING resident.
    assert.equal(model.bytes, 1039086387, "the whole footprint occupies the one pool, GPU-resident or not");
    const other = bands.find((b) => b.kind === "other");
    const free = bands.find((b) => b.kind === "free");
    assert.equal(free.bytes, 3682385920, "free is the SYSTEM's, not the device's near-empty figure");
    assert.ok(other.bytes > 12 * GB, "the 12.5 GB held by the rest of the machine is visible, not hidden as ~0");
    const total = bands.reduce((n, b) => n + b.bytes, 0);
    assert.equal(total, 17179869184, "the bands account for exactly the system total — one pool, no double-count");
});

test("Metal residency: GPU-resident reports gpus[]; CPU-forced omits it entirely", () => {
    const gpu = M.residencyFrom(METAL_PS_GPU);
    assert.deepEqual(gpu.perDevice, { 0: 1039086387 }, "Metal DOES attribute per device, with gpu_id '0'");
    assert.equal(gpu.ramBytes, 0, "size == size_vram when it is on the GPU");
    assert.equal(M.isCpuResident(gpu), false);
    assert.ok(gpu.expiresAt > 0, "the keep-alive TTL parses");

    const cpu = M.residencyFrom(METAL_PS_CPU);
    assert.deepEqual(cpu.perDevice, {}, "gpus is ABSENT when forced to the CPU — the contract holds on Metal");
    assert.equal(cpu.ramBytes, 1018523810);
    assert.equal(M.isCpuResident(cpu), true);
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
    // Unified memory yields ONE capacity series, not a device/host pair — offering both would invite exactly
    // the double-count stackRefusal exists to block.
    const cat = M.seriesCatalog({ t: 1, capacity: M.parseInfo(METAL_INFO), models: [M.residencyFrom(METAL_PS_GPU)] });
    assert.deepEqual(cat.map((s) => s.id), ["mem", "mem.qwen3:0.6b"], "one pool, one ceiling, plus the model");
    assert.match(cat[0].label, /MTL0/, "labelled with the device the machine reported");

    // A resident model on a DISCRETE box adds its own per-device and (when it spills) per-host series.
    const withModel = M.seriesCatalog({ t: 1, capacity: M.parseInfo(CUDA_INFO), models: [
        M.residencyFrom({ name: "m", size: 10 * GB, size_vram: 6 * GB, gpus: [{ gpu_id: "0", size_vram: 6 * GB }] }),
    ] }).map((s) => s.id);
    assert.ok(withModel.includes("vram.0.m"), "the model is plottable on the device");
    assert.ok(withModel.includes("ram.m"), "…and its spill is plottable against host RAM");
});

test("presetsFor: the default layout follows the hardware", () => {
    const multi = M.presetsFor({ t: 1, capacity: M.parseInfo(CUDA_INFO), models: [] });
    assert.equal(multi[0].id, "placement", "two cards → lead with WHERE the model landed");
    assert.equal(multi[0].tracks.length, 2, "one track per card — small multiples, not a shared axis");

    const single = M.presetsFor({ t: 1, capacity: M.parseInfo(METAL_INFO), models: [] });   // the Mac
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

// Every memory figure this API returns is raw bytes, and every one of them is BINARY. Dividing by 1000³ makes
// the UI the only component disagreeing with nvidia-smi, llama.cpp and ollama's own logs — by 7.4%, which is
// large enough to look like a real discrepancy and small enough to be believed.
test("formatBytes: binary units, matching what the rest of the toolchain reports", () => {
    // The exact trap: a card sold as "96GB". Decimal would render 101.97 GB — a plausible-looking wrong number.
    assert.equal(M.formatBytes(101972967424), "94.97 GiB");
    assert.ok(!M.formatBytes(101972967424).includes("101"), "never the decimal reading");
    // A 16 GB Mac's system memory really is 16 GiB.
    assert.equal(M.formatBytes(17179869184), "16.00 GiB");
    assert.equal(M.formatBytes(12712935424), "11.84 GiB", "…and its Metal working set");
    // A model file: ollama list prints this as 111 GB (decimal); on OUR screens it is GiB, because users
    // subtract adjacent numbers and a mixed ruler makes a model look like it can't fit when it can.
    assert.equal(M.formatBytes(119057326592), "110.9 GiB");
});

test("formatBytes: two decimals below 100, one above — the margin that matters", () => {
    assert.equal(M.formatBytes(5453182401), "5.08 GiB", "VRAM decisions turn on hundreds of MiB");
    assert.equal(M.formatBytes(119057326592), "110.9 GiB");
    assert.equal(M.formatBytes(1039086387), "990.9 MiB", "…and it steps down a unit rather than saying 0.97 GiB");
    assert.equal(M.formatBytes(668991488), "638.0 MiB");
    assert.equal(M.formatBytes(1023), "1023 B", "raw bytes get no decimals");
    assert.equal(M.formatBytes(1024), "1.00 KiB");
});

test("formatBytes: never a bare number — an unlabelled figure is a support ticket", () => {
    for (const b of [0, 1, 1024, 1e9, 1e12]) assert.match(M.formatBytes(b), /\d ?(B|KiB|MiB|GiB|TiB)$/);
    assert.equal(M.formatBytes(null), "—", "unknown renders as unknown, not as zero");
    assert.equal(M.formatBytes(undefined), "—");
    assert.equal(M.formatBytes(NaN), "—");
    // splitBytes is the same figure for a UI that styles the unit separately — never a value without its unit.
    assert.deepEqual(M.splitBytes(101972967424), { value: "94.97", unit: "GiB" });
    assert.deepEqual(M.splitBytes(null), { value: "—", unit: "" });
});

// `size_vram` is llama-server's buffer accounting; the driver reports 0.7-1.8 GiB more per model (the CUDA
// context, which no buffer line reports). So the unattributed band holds OUR models' overhead too, and must
// not claim to be other processes — or the reader goes hunting for a process that isn't there.
test("the residual band is named by MAGNITUDE, so an idle card shows no phantom usage", () => {
    const mk = (usedBytes, modelBytes) => {
        const cap = M.parseInfo(CUDA_INFO);
        cap.devices[0].freeBytes = cap.devices[0].totalBytes - usedBytes;
        const models = modelBytes ? [M.residencyFrom({ name: "m", size: modelBytes, size_vram: modelBytes, gpus: [{ gpu_id: "0", size_vram: modelBytes }] })] : [];
        return M.deviceBands({ t: 1, capacity: cap, models }, "0").find((b) => b.kind === "other");
    };
    // An IDLE card is the case the naive formula gets wrong: ~0.55 GiB is ollama's discovery context, held on
    // every visible card whether or not anything is loaded. Calling that "other processes" invents a process.
    const idle = mk(0.55 * GB, 0);
    assert.equal(idle.label, "driver overhead");
    assert.equal(idle.label, M.DRIVER_BAND_LABEL);
    // A loaded model adds its CUDA context on top — size_vram is llama-server's buffer accounting and the
    // driver reports 0.7-1.8 GiB more, so this residual is still OURS, not a third party.
    assert.equal(mk(21 * GB, 20 * GB).label, "driver overhead", "a model's context stays under the floor");
    // Clear the floor and there really is something else on the card worth naming.
    const foreign = mk(30 * GB, 20 * GB);
    assert.equal(foreign.label, M.OTHER_BAND_LABEL);
    assert.equal(foreign.label, "unattributed");
    assert.ok(!/other process/i.test(foreign.label), "still never claims to be a process we can point at");
    assert.match(M.OTHER_BAND_NOTE, /CUDA context/);
});

// Three totals exist and all are correct: nominal (no API reports it), the driver framebuffer total
// (physical_memory, what nvidia-smi shows), and cuDeviceTotalMem (total_memory, what ollama places against).
test("ceilings: display the DRIVER total when reported, decide fit against ollama's", () => {
    const withPhysical = { compute: { ...CUDA_INFO.compute, supported_gpus: [
        { ...CUDA_INFO.compute.supported_gpus[0], physical_memory: 102638980956 },   // 95.59 GiB — the driver framebuffer total nvidia-smi shows
    ] } };
    const cap = M.parseInfo(withPhysical);
    assert.equal(M.formatBytes(cap.devices[0].physicalBytes), "95.59 GiB", "the driver framebuffer total");
    assert.equal(M.formatBytes(cap.devices[0].totalBytes), "94.97 GiB", "…and ollama's, ~638 MiB below it");

    const c = M.ceilingsFor({ t: 1, models: [], capacity: cap }, "0");
    assert.equal(M.formatBytes(c.displayBytes), "95.59 GiB", "shown as 'total on the machine' — matches nvidia-smi");
    assert.equal(c.displayIsFit, false, "…and flagged as NOT the fit figure");
    assert.equal(M.formatBytes(c.hardBytes), "94.97 GiB", "placement decides against ollama's total");
});

test("ceilings: without physical_memory, fall back honestly rather than synthesising the nominal size", () => {
    const cap = M.parseInfo(CUDA_INFO);   // today's server: no physical_memory
    assert.equal(cap.devices[0].physicalBytes, undefined);
    const c = M.ceilingsFor({ t: 1, models: [], capacity: cap }, "0");
    assert.equal(M.formatBytes(c.displayBytes), "94.97 GiB", "shows what IS reported");
    assert.equal(c.displayIsFit, true, "flagged so the UI can label it honestly");
    // The nominal 96 GiB is a spec-sheet number no API reports; rounding up to it breaks on ECC or an odd
    // config, so nothing here may ever produce it.
    assert.ok(!M.formatBytes(c.displayBytes).startsWith("96"), "never synthesised by rounding");
});
