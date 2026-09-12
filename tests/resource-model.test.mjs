"use strict";
// The resource panel's pure data model: /api/info + /api/ps → the bands, series and history the chart draws.
// Fixtures are REAL captures where possible (the CUDA ones are live gpubox bodies, trimmed) — see
// docs/spec/RESOURCE_PANEL.md, which also lists the Metal samples still to be pinned down.
import { test, describe } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
const M = await import("../src/resource-model.ts");
// The machine shapes, shared with resource-demo.mjs — one copy, so a guard and a demo cannot disagree
// about what a box looks like.
import { BOXES, TOPOLOGIES, pci } from "./fixtures/boxes.mjs";

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
// ONE DISCRETE CARD PLUS HOST RAM — the commonest machine there is, and the shape the drift guard was blind
// to. It is not a narrower version of the two-card box: the cards question and the pools question give
// different answers here (one card, two pools), which is exactly where the Overview preset went wrong.
const ONE_CARD_INFO = {
    compute: {
        system_compute: { cpu_cores: 16, total_memory: 68719476736, free_memory: 40000000000, free_swap: 0 },
        supported_gpus: [
            { gpu_id: "0", name: "CUDA0", total_memory: 25757220864, free_memory: 25000000000, compute: "8.9", driver: "13.2", runner: "CUDA" },
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
    assert.match(M.stackRefusal([byId("vram.0"), byId("vram.1")], cudaCap), /each card has its own capacity.*ONE ceiling/i,
        "a stack draws against one ceiling, and two cards have two");
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
    // The default is the most COMPACT view that still hides nothing: one track, every pool overlaid — cards
    // AND the host, since a CPU-resident model holds no VRAM and would otherwise vanish from the chart.
    assert.equal(multi[0].id, "overview", "Overview leads — one track, and it omits no pool");
    assert.equal(multi[0].tracks.length, 1, "one track for the whole machine");
    assert.deepEqual(multi[0].tracks[0].series, ["vram.0", "vram.1", "ram"], "including the host pool");
    assert.equal(multi[0].tracks[0].mode, "overlay");
    const withRam = multi.find((p) => p.id === "memory");
    assert.equal(withRam.tracks.length, 3, "GPU + RAM breaks the same data into a track per pool");
    // There is deliberately no cards-only preset: it would be GPU + RAM minus the host track, and what that
    // hides is your CPU-resident models. The editor can drop the track for anyone who wants it.
    // THREE KINDS, and the third is a different QUESTION rather than a narrowing. Overview asks how full
    // each pool is, GPU + RAM asks what is in each, and Whole box asks what shape the machine is — which the
    // per-pool tracks cannot answer, since they give every pool the same height whatever its capacity. It
    // had no preset and could only be reached by hand-editing tracks, which made Custom carry a whole view
    // instead of meaning "a preset with something excluded".
    assert.deepEqual(multi.map((p) => p.id), ["overview", "memory", "box"]);
    const box = multi.find((p) => p.id === "box");
    assert.equal(box.tracks.length, 1, "one axis, not a track per pool — that is what the other view is for");
    assert.equal(box.tracks[0].mode, "total");
    assert.deepEqual(box.tracks[0].series, ["vram.0", "vram.1", "ram"], "every pool, laid end to end");
    // A preset must never propose a layout `stackRefusal` would reject; `total` is judged separately because
    // it does not merge the pools into one — the walls between them are the point.
    assert.equal(M.presetRefusal(box, { t: 1, capacity: M.parseInfo(CUDA_INFO), models: [] }), null);
    assert.ok(!multi.some((p) => p.id === "placement"));

    // The Mac: ONE pool, so one preset with one track — not a GPU view and a RAM view of the same silicon.
    const single = M.presetsFor({ t: 1, capacity: M.parseInfo(METAL_INFO), models: [] });
    assert.deepEqual(single.map((p) => p.id), ["memory"]);
    assert.deepEqual(single[0].tracks.map((t) => t.series), [["mem"]], "the one pool, once");
    assert.ok(!single.some((p) => p.id === "placement"));
    // …and NO whole-box view there: with one pool the axis already IS that pool, so "end to end" would be
    // the same picture under a name promising something else.
    assert.ok(!single.some((p) => p.id === "box"), "one pool has no end-to-end arrangement to show");
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

test("segments: a REPORTED hole breaks the line even when no time passed", () => {
    const s = (t) => ({ t, models: [], capacity: null });
    // The readings either side of a drop can be adjacent in time — the stream lost frames BETWEEN them, which
    // is a hole nothing in the timestamps can see. Two seconds apart is an ordinary cadence, so this run is
    // split by the flag alone; without it the line is drawn straight across the interval the server has just
    // said it cannot account for, and drops happen when memory is moving fastest.
    const runs = M.segments([s(0), s(2000), { ...s(4000), gapBefore: true }, s(6000)], M.MAX_SAMPLE_GAP_MS);
    assert.equal(runs.length, 2, "the flag splits a run the interval would have kept whole");
    assert.deepEqual(runs.map((r) => r.length), [2, 2]);
    assert.deepEqual(runs[1].map((x) => x.t), [4000, 6000], "the marked sample STARTS the new run");
    // The mark on the very first sample is about a hole before anything we hold, so there is nothing to break.
    assert.equal(M.segments([{ ...s(0), gapBefore: true }, s(2000)]).length, 1);
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
        { ...CUDA_INFO.compute.supported_gpus[0], physical_memory: 102641958912 },   // 95.59 GiB — the driver framebuffer total nvidia-smi shows
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

// A preset PROPOSES a layout and stackRefusal JUDGES it, so the two must agree — otherwise the panel offers a
// view the user can pick and be told off for. This caught exactly that: Overview stacked several cards.
test("DRIFT GUARD: every generated preset is valid under the stacking rule, on every shape of box", () => {
    // ONE PER KIND OF MACHINE PEOPLE ACTUALLY HAVE, not one per number of cards — that assumption is what let
    // a real bug ship. The guard covered two cards and a unified Mac, and Overview chose its mode from how
    // many DEVICES there were; one card plus host RAM is one device and TWO POOLS, so on the commonest
    // machine there is, the panel's own default proposed a stack the rule refuses. "Fewer cards" was taken
    // for the easy case rather than a different one.
    //
    // The shapes are shared with resource-demo.mjs (tests/fixtures/boxes.mjs) so there is one copy: a guard
    // and a demo disagreeing about what a machine looks like is the same drift in a second costume.
    for (const [name, shape] of Object.entries(BOXES)) {
        const info = { compute: {
            system_compute: { cpu_cores: 16, total_memory: shape.hostTotal, free_memory: Math.round(shape.hostTotal / 2) },
            supported_gpus: shape.devices.map((d) => ({ ...d, free_memory: d.total_memory - shape.idleHeld })),
        } };
        const sample = { t: 1, models: [], capacity: M.parseInfo(info) };
        const presets = M.presetsFor(sample);
        assert.ok(presets.length > 0, `${name}: no preset at all`);
        for (const p of presets) {
            assert.equal(M.presetRefusal(p, sample), null,
                `${name}: preset "${p.id}" proposes a layout the rule refuses`);
            assert.ok(p.tracks.length > 0, `${name}: preset "${p.id}" has no tracks`);
            for (const t of p.tracks) assert.ok(t.series.length > 0, `${name}: "${p.id}" has an empty track`);
        }
        // The DEFAULT is the first, and it is the one a user meets without choosing anything — so its
        // validity is the one that matters most and the one that was broken.
        assert.equal(M.presetRefusal(presets[0], sample), null, `${name}: the DEFAULT preset is refused`);
    }
});

test("presets follow the SHAPE of the box, not its vendor or its card count", () => {
    const presetsOn = (name) => {
        const shape = BOXES[name];
        const info = { compute: {
            system_compute: { cpu_cores: 16, total_memory: shape.hostTotal, free_memory: Math.round(shape.hostTotal / 2) },
            supported_gpus: shape.devices.map((d) => ({ ...d, free_memory: d.total_memory - shape.idleHeld })),
        } };
        const sample = { t: 1, models: [], capacity: M.parseInfo(info) };
        return { presets: M.presetsFor(sample), sample };
    };

    // A MAC IS ONE POOL, so there is one preset and nothing to lay end to end — "Whole box" there would be
    // the same picture under a name promising something else.
    const mac = presetsOn("metal");
    assert.deepEqual(mac.presets.map((p) => p.id), ["memory"]);
    assert.deepEqual(mac.presets[0].tracks[0].series, ["mem"]);
    assert.equal(mac.presets[0].tracks[0].mode, "stack", "one pool IS stackable — it is its own total");

    // THE LAPTOP: one discrete card and host RAM. One device, two pools — the case the guard was blind to.
    const laptop = presetsOn("laptop");
    assert.equal(laptop.presets.find((p) => p.id === "overview").tracks[0].mode, "overlay",
        "a card and the host have no shared capacity, however few cards there are");

    // EIGHT CARDS plus the host is nine pools — past the curated palette, and still just as overlaid. The
    // rule does not change with the count, which is the point of deriving it from pools.
    const lab = presetsOn("lab");
    const labOverview = lab.presets.find((p) => p.id === "overview");
    assert.equal(labOverview.tracks[0].series.length, 9, "eight cards and the host");
    assert.equal(labOverview.tracks[0].mode, "overlay");
    assert.equal(lab.presets.find((p) => p.id === "memory").tracks.length, 9, "a track per pool, all nine");

    // AMD differs from NVIDIA in the ceiling note's vendor tool, NOT in the layout — so the presets are the
    // same shape as the two-card CUDA box, and a test that expected otherwise would be encoding a difference
    // that does not exist.
    assert.deepEqual(presetsOn("amd").presets.map((p) => p.id), presetsOn("cuda").presets.map((p) => p.id));
    // …and the prosumer rig: four cards, same rule again.
    assert.equal(presetsOn("rig").presets.find((p) => p.id === "memory").tracks.length, 5);
});

test("presets: ONE card plus host RAM is still two pools, so Overview overlays", () => {
    const sample = { t: 1, models: [], capacity: M.parseInfo(ONE_CARD_INFO) };
    const overview = M.presetsFor(sample).find((p) => p.id === "overview");
    assert.deepEqual(overview.tracks[0].series, ["vram.0", "ram"]);
    assert.equal(overview.tracks[0].mode, "overlay",
        "a card and the host have no shared capacity to stack into — the count that matters is POOLS, not cards");
    // The mode is read off the track AFTER the catalog filter, so it counts the series the machine actually
    // has rather than the ones the preset hoped for.
    assert.equal(M.presetRefusal(overview, sample), null);

    // …and a single-POOL machine still stacks, which is what the ternary was reaching for and got right only
    // by accident on the Mac.
    const mac = { t: 1, models: [], capacity: M.parseInfo(METAL_INFO) };
    const only = M.presetsFor(mac)[0];
    assert.deepEqual(only.tracks[0].series, ["mem"]);
    assert.equal(only.tracks[0].mode, "stack");
});

test("presets: several cards are OVERLAID, never stacked into a total that isn't real", () => {
    const sample = { t: 1, models: [], capacity: M.parseInfo(CUDA_INFO) };
    const overview = M.presetsFor(sample).find((p) => p.id === "overview");
    assert.equal(overview.tracks[0].mode, "overlay", "two cards have no meaningful combined total");
    // On a single-device box there is nothing to overlay, so a stack is both valid and the clearer reading.
    const mac = { t: 1, models: [], capacity: M.parseInfo(METAL_INFO) };
    assert.equal(M.presetsFor(mac).find((p) => p.id === "overview"), undefined,
        "a one-pool machine gets one preset — there is nothing to overlay or place");
});

test("presetRefusal: names a series the machine doesn't have (a layout saved on another box)", () => {
    const mac = { t: 1, models: [], capacity: M.parseInfo(METAL_INFO) };
    // A layout saved on the 2-card server, restored onto a Mac: `vram.1` does not exist here.
    const stale = { id: "saved", label: "Saved", description: "", tracks: [{ id: "t", series: ["vram.1"], mode: "stack", heightPx: 96 }] };
    assert.match(M.presetRefusal(stale, mac), /doesn't have/);
});

// Switching the extension's backend from a CUDA server to a Metal Mac is not a UI nicety — it is a category
// error waiting to happen. Those samples were measured against a 94.97 GiB ceiling on devices whose ids mean
// different hardware; redrawn on a 11.84 GiB Mac, an 18 GiB band clips at 100% and looks like a READING.
test("boxSignature: identifies the machine, and ignores what merely moves", () => {
    const a = M.parseInfo(CUDA_INFO), b = M.parseInfo(CUDA_INFO);
    assert.equal(M.boxSignature(a), M.boxSignature(b), "the same box is the same box");
    // free_memory changes constantly — it must NOT count as a different machine.
    b.devices[0].freeBytes = 1234;
    assert.equal(M.boxSignature(a), M.boxSignature(b), "occupancy is not identity");
    // A different machine is.
    assert.notEqual(M.boxSignature(a), M.boxSignature(M.parseInfo(METAL_INFO)));
    // So is losing a card, or the same card reporting a different size.
    const oneCard = M.parseInfo(CUDA_INFO); oneCard.devices.pop();
    assert.notEqual(M.boxSignature(a), M.boxSignature(oneCard));
    const resized = M.parseInfo(CUDA_INFO); resized.devices[0].totalBytes = 42e9;
    assert.notEqual(M.boxSignature(a), M.boxSignature(resized));
    assert.equal(M.boxSignature(null), "", "unknown capacity has no identity to compare");
});

test("sameBoxOnly: drops history measured on another machine, keeps the current box's", () => {
    const cuda = M.parseInfo(CUDA_INFO), metal = M.parseInfo(METAL_INFO);
    const history = [
        { t: 1, models: [], capacity: cuda },
        { t: 2, models: [], capacity: cuda },
        { t: 3, models: [], capacity: null },     // taken before capacity was known
        { t: 4, models: [], capacity: metal },
    ];
    // Now pointed at the Mac: the two CUDA samples are unusable here.
    assert.deepEqual(M.sameBoxOnly(history, metal).map((s) => s.t), [3, 4]);
    // Back on the server: the Mac sample goes instead.
    assert.deepEqual(M.sameBoxOnly(history, cuda).map((s) => s.t), [1, 2, 3]);
    // Capacity unknown → nothing to contradict, so keep everything rather than blanking the panel.
    assert.equal(M.sameBoxOnly(history, null).length, 4);

    // The case that actually bit: a sample taken BEFORE capacity was known (t:3) is exempt from the filter,
    // and a capacity-less sample gets the CURRENT capacity backfilled when drawn. On a normal open that is
    // right. After a SWITCH it draws the old machine's readings against the new machine's ceiling — an 18 GiB
    // band clipped against an 11.84 GiB pool, which reads as a measurement. So it is dropped instead.
    assert.deepEqual(M.sameBoxOnly(history, metal, true).map((s) => s.t), [4],
        "a switch drops what cannot be attributed to either box");
    assert.deepEqual(M.sameBoxOnly(history, cuda, true).map((s) => s.t), [1, 2]);
});

// A single total hides how a model is placed: 18 GiB reads the same whether it sits on one card, is split
// across two, or is partly offloaded to system RAM — and the last of those is why it can be unexpectedly slow.
test("placementOf: names the devices and shows how a model was split", () => {
    const cap = M.parseInfo(CUDA_INFO);
    const fmt = M.formatBytes;
    const res = (over) => M.residencyFrom({ name: "m", size: 20 * GB, size_vram: 20 * GB, ...over });

    // One card: named, not "device 0".
    assert.equal(M.placementOf(res({ gpus: [{ gpu_id: "0", size_vram: 20 * GB }] }), cap, fmt), "CUDA0 18.63 GiB");
    // Split across two cards — the case a total can't show.
    const two = res({ gpus: [{ gpu_id: "0", size_vram: 12 * GB }, { gpu_id: "1", size_vram: 8 * GB }] });
    assert.equal(M.placementOf(two, cap, fmt), "CUDA0 11.18 GiB + CUDA1 7.45 GiB");
    assert.equal(M.isSplit(two), true);

    // PARTIAL OFFLOAD: part on a card, the rest in system RAM — why a "GPU" model can still be slow.
    const spill = M.residencyFrom({ name: "m", size: 30 * GB, size_vram: 20 * GB, gpus: [{ gpu_id: "0", size_vram: 20 * GB }] });
    assert.match(M.placementOf(spill, cap, fmt), /^CUDA0 18\.63 GiB \+ RAM 9\.31 GiB$/);
    assert.equal(M.isSplit(spill), true, "GPU + RAM is a split too");

    // Fully CPU-resident: no gpus[] at all.
    const cpu = M.residencyFrom({ name: "m", size: 8 * GB, size_vram: 0 });
    assert.match(M.placementOf(cpu, cap, fmt), /^RAM 7\.45 GiB$/);
    assert.equal(M.isSplit(cpu), false, "one place is not a split");

    // Unattributable placement (the deployed server's caveat-2 case) says so rather than dropping the device.
    const odd = M.residencyFrom({ name: "m", size: 20 * GB, size_vram: 20 * GB, gpus: [{ gpu_id: "1", size_vram: 0 }] });
    assert.match(M.placementOf(odd, cap, fmt), /CUDA1 \(unknown\)/);

    // A single-device box with nothing to report gets no line rather than a redundant one.
    const solo = M.parseInfo(METAL_INFO);
    assert.equal(M.placementOf(M.residencyFrom({ name: "m", size: 5 * GB, size_vram: 5 * GB }), solo, fmt), null);
});

test("holdCapacity: a silent poll never unlearns the box", () => {
    const box = M.parseInfo({ compute: {
        system_compute: { cpu_cores: 8, total_memory: 34359738368, free_memory: 8589934592, free_swap: 0 },
        supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 25769803776, free_memory: 25769803776 }],
    } });
    assert.ok(box);
    // Nothing known yet, nothing answered → still nothing. The panel degrades honestly.
    assert.equal(M.holdCapacity(null, null), null);
    // First answer is adopted.
    assert.equal(M.holdCapacity(null, box), box);
    // A poll that answers with nothing leaves what was measured in place — this is the whole point: a box
    // does not lose its hardware because one request came back empty.
    assert.equal(M.holdCapacity(box, null), box);
    // A real answer always wins, including one describing a different machine (the switch is handled after).
    const other = M.parseInfo({ compute: {
        system_compute: { cpu_cores: 10, total_memory: 17179869184, free_memory: 3682385920, free_swap: 0 },
        supported_gpus: [{ gpu_id: "0", name: "MTL0", runner: "Metal", total_memory: 12712935424, free_memory: 12711886848 }],
    } });
    assert.equal(M.holdCapacity(box, other), other);
});

test("formatShare: the bytes and the fraction, never one without the other", () => {
    const GiB = 1024 ** 3;
    // The pair a reader wants — asking them to divide 18 by 95.59 in their head is half an answer.
    assert.equal(M.formatShare(18 * GiB, 95.59 * GiB), "18.00 GiB of 95.59 GiB (19%)");
    // A compact header says the same thing with a slash.
    assert.equal(M.formatShare(18 * GiB, 95.59 * GiB, "/"), "18.00 GiB / 95.59 GiB (19%)");
    // Under 10% gets a decimal: "5%" and "5.4%" are different answers when the pool is 95 GiB.
    assert.equal(M.percentOf(5.4 * GiB, 100 * GiB), "5.4%");
    // Not nothing, but too small to round to a whole percent — "0%" of 400 MiB would be a lie.
    assert.equal(M.percentOf(0.4 * GiB, 95.59 * GiB), "<1%");
    assert.equal(M.percentOf(0, 95.59 * GiB), "0%");
    // No denominator → no share. The figure still stands on its own.
    assert.equal(M.percentOf(8 * GiB, 0), "");
    assert.equal(M.formatShare(8 * GiB, 0), "8.00 GiB of 0 B");
});

test("eventsIn: a span counts when it OVERLAPS the window, an instant when it is inside it", () => {
    const evs = [
        { t: 100, kind: "note", label: "before" },
        { t: 500, kind: "note", label: "inside" },
        { t: 900, kind: "note", label: "after" },
        // Began before the window and ended inside it — the load that started before you looked, which is
        // exactly what the lane exists to show.
        { t: 100, until: 450, kind: "load", label: "straddles the start" },
        { t: 550, until: 5000, kind: "gen", label: "straddles the end" },
        { t: 10, until: 90, kind: "gen", label: "entirely before" },
    ];
    const got = M.eventsIn(evs, 200, 800).map((e) => e.label);
    assert.deepEqual(got, ["straddles the start", "inside", "straddles the end"],
        "membership is overlap for spans; clipping to the window is the renderer's job");
});

// The chart's x-axis is NOT linear in time: it is split into contiguous runs (a gap is a gap), each weighted
// by its sample count. So an event is placed inside the run that contains it, and one that falls in a gap has
// no x at all — putting it at the edge would claim it happened at a moment nothing was measured.
test("placeEvents: inside the run that holds it, dropped when it falls in a gap", () => {
    const runs = [
        [{ t: 1000 }, { t: 2000 }, { t: 3000 }],     // 1s..3s
        [{ t: 9000 }, { t: 10_000 }],                // 9s..10s, after a six-second gap
    ];
    const at = (label, t, until) => ({ t, until, kind: "note", label });
    const got = M.placeEvents(runs, [
        at("start of run 0", 1000),
        at("middle of run 0", 2000),
        at("in the gap", 5000),
        at("in run 1", 9500),
        at("span inside run 0", 1500, 2500),
        at("span crossing the gap", 2000, 9500),
        at("span over before any sample", 100, 900),
        at("span ending inside run 0", 200, 1500),
    ]);
    const by = Object.fromEntries(got.map((p) => [p.event.label, p]));
    assert.equal(by["in the gap"], undefined, "nothing was measured then, so there is nowhere honest to draw it");
    assert.equal(by["start of run 0"].run, 0);
    assert.equal(by["start of run 0"].from, 0);
    assert.equal(by["middle of run 0"].from, 0.5, "placed by TIME within its own run, not by sample index");
    assert.equal(by["in run 1"].run, 1);
    assert.equal(by["in run 1"].from, 0.5);
    // An instant has zero width.
    assert.equal(by["middle of run 0"].to, by["middle of run 0"].from);
    // A span inside one run keeps both ends.
    assert.deepEqual([by["span inside run 0"].from, by["span inside run 0"].to], [0.25, 0.75]);
    assert.equal(by["span inside run 0"].clipped, false);
    // One that runs past the end of its segment is clipped there and SAYS so — a load that ran while the panel
    // was closed is real, and the honest drawing of it stops where the measurements stop.
    assert.equal(by["span crossing the gap"].to, 1);
    assert.equal(by["span crossing the gap"].clipped, true);
    // A span that was OVER before anything was measured has nowhere honest to go; one that began before the
    // first sample and ended inside the run is drawn from the run's left edge — the load that started before
    // you looked. (This used to be asserted in a jsdom test against the wall clock, where which of the two
    // cases it was depended on how fast the machine ran the setup.)
    assert.equal(by["span over before any sample"], undefined);
    assert.equal(by["span ending inside run 0"].from, 0);
    assert.equal(by["span ending inside run 0"].to, 0.25);
});

test("placeEvents: a run of one sample has no width to place within", () => {
    const got = M.placeEvents([[{ t: 500 }]], [{ t: 500, kind: "note", label: "only" }]);
    assert.equal(got[0].from, 0, "no division by zero, and no fabricated position");
});

test("residencyEvents: an eviction is a diff; a load already told as a span isn't repeated", () => {
    const model = (name) => ({ model: name, vramBytes: 1, ramBytes: 0, sizeBytes: 1, gpus: [] });
    const samples = [
        { t: 1000, models: [model("a"), model("b")], capacity: null },
        { t: 3000, models: [model("a")], capacity: null },                    // b evicted
        { t: 5000, models: [model("a"), model("c")], capacity: null },        // c appeared
        { t: 7000, models: [model("a"), model("c"), model("d")], capacity: null },
    ];
    // A load span already covers d — nothing reports an eviction, but a load DOES report itself.
    const loads = [{ t: 6000, until: 6900, kind: "load", label: "loading d", model: "d" }];
    const evs = M.residencyEvents(samples, loads);
    const labels = evs.map((e) => e.label);
    assert.ok(labels.includes("b evicted"), "a model leaving ps is only knowable as a diff");
    assert.ok(labels.includes("c appeared"), "…and one arriving with no load span behind it comes from nowhere otherwise");
    assert.ok(!labels.some((l) => /^d /.test(l)), "d's load is already a span with a real duration — not double-reported");
    assert.deepEqual(evs.find((e) => e.label === "b evicted").t, 3000, "stamped at the sample that noticed");
});

test("laneRows: overlapping spans never share a line", () => {
    const p = (run, from, to) => ({ event: { t: from, kind: "gen", label: `${run}:${from}` }, run, from, to, clipped: false });
    const rows = M.laneRows([p(0, 0, 0.5), p(0, 0.2, 0.7), p(0, 0.8, 0.9), p(0, 0.85, 1)]);
    assert.equal(rows.length, 2, "two overlapping pairs need two rows");
    // Two bars on one line read as a single longer one — a false statement about what happened.
    for (const row of rows) {
        for (let i = 1; i < row.length; i++) {
            assert.ok(row[i].run + row[i].from >= row[i - 1].run + row[i - 1].to, "no overlap within a row");
        }
    }
    // Past the row budget, events crowd the last row rather than vanishing: a dropped event is a lie by
    // omission, an overlapping one is merely ugly.
    const many = Array.from({ length: 12 }, (_, i) => p(0, 0, 1));
    const capped = M.laneRows(many, 3);
    assert.equal(capped.length, 3);
    assert.equal(capped.flat().length, 12, "every event is still drawn");
});

// Concurrency is the normal case in this lane, not an edge: a run contains its generations, a generation may
// have a background embedding call beside it, and each nests under the one that contains it.
test("laneRows: nested and overlapping events stack under the one that contains them", () => {
    const p = (label, from, to) => ({ event: { t: from, until: to, kind: "gen", label }, run: 0, from, to, clipped: false });
    const rows = M.laneRows([
        p("run", 0, 1),          // the driver, spanning everything
        p("generation", 0.1, 0.35),
        p("embed", 0.15, 0.3),   // a background embedding, INSIDE the generation
        p("tool", 0.6, 0.8),
    ]);
    const at = (label) => rows.findIndex((r) => r.some((x) => x.event.label === label));
    assert.equal(at("run"), 0, "the longest span starts first, so it takes the top row");
    assert.equal(at("generation"), 1, "what it contains goes below it");
    assert.equal(at("embed"), 2, "…and what THAT contains goes below again");
    assert.equal(at("tool"), 1, "a later sibling reuses the freed row rather than opening a new one");
});

// A delegated sub-call — a vision reader, an embedding — never happens on its own: it belongs to a step,
// which belongs to a run. Hovering one has to leave that chain lit, or the bar is just "some bar".
test("lineageOf: an event, what spawned it, and what it spawned", () => {
    const evs = [
        { id: "run:a", kind: "run", label: "run", t: 0 },
        { id: "step:a:1", parent: "run:a", kind: "tool", label: "exec", t: 1 },
        { id: "step:a:1:sub0", parent: "step:a:1", kind: "embed", label: "reader", t: 2 },
        { id: "step:a:2", parent: "run:a", kind: "tool", label: "click", t: 3 },
        { id: "run:b", kind: "run", label: "other run", t: 4 },
    ];
    // From the sub-call UP: the step that spawned it and the run that contains it.
    assert.deepEqual([...M.lineageOf(evs, "step:a:1:sub0")].sort(), ["run:a", "step:a:1", "step:a:1:sub0"]);
    // From the step: itself, its run, and what IT spawned — the same relationship read the other way.
    assert.deepEqual([...M.lineageOf(evs, "step:a:1")].sort(), ["run:a", "step:a:1", "step:a:1:sub0"]);
    // From the run: everything under it, but never a sibling run.
    const fromRun = M.lineageOf(evs, "run:a");
    assert.ok(fromRun.has("step:a:2") && fromRun.has("step:a:1:sub0"));
    assert.ok(!fromRun.has("run:b"), "another run is not part of this lineage");
    // Nothing hovered → nothing lit, which is what leaves the lane undimmed at rest.
    assert.equal(M.lineageOf(evs, undefined).size, 0);
});

// Turning a drag into a time range is the INVERSE of placing an event: the plot is segments weighted by
// sample count, so a fraction is spent across them in those proportions and interpolated inside the one it
// lands in. Getting this wrong makes a zoom select a different stretch than the one you dragged over.
test("timeAtFraction: the inverse of placeEvents, across weighted segments", () => {
    // Two runs: 3 s of samples, then 1 s after a gap. The axis is LINEAR IN TIME within a run and each run is as
    // wide as it is LONG (the gap collapses), so the weights are 3 and 1 → three quarters and one quarter.
    const runs = [
        [{ t: 1000 }, { t: 2000 }, { t: 3000 }, { t: 4000 }],
        [{ t: 10_000 }, { t: 11_000 }],
    ];
    assert.equal(M.timeAtFraction(runs, 0), 1000, "the left edge is the first sample");
    assert.equal(M.timeAtFraction(runs, 1), 11_000, "the right edge is the last");
    // Three eighths of the way is halfway through the FIRST run (which owns three quarters of the width).
    assert.equal(M.timeAtFraction(runs, 3 / 8), 2500);
    // AT the boundary between runs the answer is the last measured moment before the gap, never a time
    // interpolated across it — nothing was measured there, so there is no honest value inside it.
    assert.equal(M.timeAtFraction(runs, 3 / 4), 4000);
    assert.equal(M.timeAtFraction(runs, 0.8), 10_200, "past it, inside the second run");
    assert.equal(M.timeAtFraction(runs, 7 / 8), 10_500);
    // It round-trips with placeEvents: an event placed at a fraction reads back as its own time.
    const ev = { t: 2500, kind: "note", label: "x" };
    const [p] = M.placeEvents(runs, [ev]);
    const overall = (p.run === 0 ? 0 : 3 / 4) + p.from * (p.run === 0 ? 3 / 4 : 1 / 4);
    assert.ok(Math.abs(M.timeAtFraction(runs, overall) - 2500) < 1);
    // Out of range clamps rather than extrapolating into time that was never on screen.
    assert.equal(M.timeAtFraction(runs, -3), 1000);
    assert.equal(M.timeAtFraction(runs, 9), 11_000);
    assert.equal(M.timeAtFraction([], 0.5), null, "no samples → no answer, not a guess");
});

// A very short event is WIDENED so it stays visible, so packing has to reserve the same width — otherwise
// two events that don't overlap in time are drawn overlapping, which reads as one longer bar.
test("laneRows: packs at the DRAWN width, not the true one", () => {
    const p = (label, from, to) => ({ event: { t: from, until: to, kind: "embed", label }, run: 0, from, to, clipped: false });
    // Two instants a hair apart: true extents don't overlap, drawn ones do.
    const rows = M.laneRows([p("a", 0.30, 0.3005), p("b", 0.302, 0.3025)]);
    assert.equal(rows.length, 2, "they need separate rows because they are DRAWN overlapping");
    // Far enough apart to share a row.
    assert.equal(M.laneRows([p("a", 0.1, 0.11), p("b", 0.5, 0.51)]).length, 1);
});

// Two bars on separate rows is the lane's only claim that they OVERLAP. Spending a row to buy a hair of
// clearance therefore asserts an overlap that isn't there — and it was the ordinary case, not an edge one: a
// model LOAD ends exactly where the step it precedes begins, so every load was pushed below its own step.
// Two runs at once — a second model, or the SAME model run twice against a server or cloud backend. Packing
// everything together by start time interleaves them into shared rows, so a step of one lands between two
// steps of the other and the shape of neither survives. Each run gets a contiguous BAND instead.
test("laneRows: concurrent runs get their own BANDS, so neither tree is interleaved with the other", () => {
    const ev = (hash, kind, from, to, seq) => ({
        event: { t: from, until: to, kind, ...(hash ? { ref: { hash, ...(seq != null ? { seq } : {}) } } : {}) },
        run: 0, from, to, clipped: false,
    });
    // The sketch: run A spans the first two thirds with four steps and some sub-calls; run B starts halfway
    // and overlaps it.
    const rows = M.laneRows([
        ev("a", "run", 0.00, 0.62),
        ev("a", "tool", 0.02, 0.16, 1), ev("a", "tool", 0.17, 0.31, 2),
        ev("a", "tool", 0.32, 0.46, 3), ev("a", "tool", 0.47, 0.61, 4),
        ev("a", "embed", 0.05, 0.11, 1), ev("a", "embed", 0.20, 0.28, 2),
        ev("b", "run", 0.50, 1.00),
        ev("b", "tool", 0.52, 0.64, 1), ev("b", "tool", 0.65, 0.77, 2), ev("b", "tool", 0.78, 0.99, 3),
        ev("b", "embed", 0.90, 0.97, 3),
    ], 8);

    const hashOf = (row) => [...new Set(row.map((p) => p.event.ref.hash))];
    for (const row of rows) assert.equal(hashOf(row).length, 1, "no row mixes two runs");
    // A's rows all come before B's — a band's position says when its run began.
    const first = rows.map((r) => hashOf(r)[0]);
    assert.deepEqual([...new Set(first)], ["a", "b"], "A's band, then B's");
    // And within each band the tree survives: the container bar alone on top, its steps below it.
    const aRows = rows.filter((r) => hashOf(r)[0] === "a");
    assert.deepEqual(aRows[0].map((p) => p.event.kind), ["run"], "the run bar has its own row");
    assert.ok(aRows.length >= 3, "run, steps, sub-calls");
    const bRows = rows.filter((r) => hashOf(r)[0] === "b");
    assert.deepEqual(bRows[0].map((p) => p.event.kind), ["run"]);
});

test("laneRows: the SAME model running twice at once is still two bands — grouping is by RUN", () => {
    const ev = (hash, kind, from, to) => ({
        event: { t: from, until: to, kind, model: "qwen3.8:27b", ref: { hash } },
        run: 0, from, to, clipped: false,
    });
    const rows = M.laneRows([
        ev("r1", "run", 0, 0.8), ev("r1", "tool", 0.1, 0.4), ev("r1", "tool", 0.45, 0.75),
        ev("r2", "run", 0.2, 1.0), ev("r2", "tool", 0.25, 0.6), ev("r2", "tool", 0.65, 0.95),
    ], 8);
    for (const row of rows) {
        assert.equal([...new Set(row.map((p) => p.event.ref.hash))].length, 1,
            "one model, two concurrent runs — still not interleaved");
    }
});

// An eviction belongs to the machine rather than to any run, and must not push a run's rows apart.
// Banding made the per-run cap insufficient: the number of bands is the number of concurrent runs, so ten
// agents at once would push the transcript off the screen. There is a TOTAL cap, and it crowds rather than
// drops — a bar drawn overlapping is a legibility problem, a run not drawn at all is a lie about what ran.
// Banding keeps a tree from being interleaved with another. Two runs that never overlap in TIME cannot
// interleave, so stacking them costs rows for nothing — and most runs are sequential, not concurrent.
// `ps` and `/api/info` are separate samples. A model reported resident a poll before the free bytes catch up
// used to draw the pool COLLAPSING to the floor and springing back — memory that looked freed and re-taken.
test("bands: a model resident before the free bytes catch up does not collapse the pool", () => {
    const TOTAL = 24 * GB;
    const cap = {
        devices: [{ id: "0", name: "CUDA0", runner: "CUDA", totalBytes: TOTAL, freeBytes: TOTAL - 0.5 * GB, unified: false }],
        host: { cores: 8, totalBytes: 64 * GB, freeBytes: 32 * GB },
        unified: false,
    };
    // The skewed sample: ps says 18 GiB is resident, info still says almost everything is free.
    const sample = { t: 1, capacity: cap, models: [{ model: "m", vramBytes: 18 * GB, ramBytes: 0, perDevice: { 0: 18 * GB }, contextLength: null, expiresAt: null }] };
    const bands = M.deviceBands(sample, "0");
    const total = bands.filter((b) => b.kind !== "free").reduce((a, b) => a + b.bytes, 0);
    assert.ok(total >= 18 * GB, `what is resident is in use whatever the other sample says yet (got ${total})`);
    const model = bands.find((b) => b.kind === "model");
    assert.equal(model.bytes, 18 * GB, "…and it is still attributed to the model, not to a residual");
});

test("laneRows: SEQUENTIAL runs share the same rows; overlapping ones still get their own", () => {
    const ev = (hash, kind, from, to) => ({
        event: { t: from, until: to, kind, ref: { hash } }, run: 0, from, to, clipped: false,
    });
    // A finishes at 0.45, B starts at 0.55 — no overlap at all.
    const sequential = M.laneRows([
        ev("a", "run", 0.00, 0.45), ev("a", "tool", 0.02, 0.20), ev("a", "tool", 0.22, 0.44),
        ev("b", "run", 0.55, 1.00), ev("b", "tool", 0.57, 0.75), ev("b", "tool", 0.77, 0.99),
    ]);
    assert.equal(sequential.length, 2, "one container row and one step row, shared by both runs");
    // …and the rows still say which run each bar is: sharing a row is not merging the trees.
    assert.deepEqual(sequential[0].map((p) => p.event.kind), ["run", "run"]);
    assert.deepEqual([...new Set(sequential[0].map((p) => p.event.ref.hash))].sort(), ["a", "b"]);

    // The overlapping case is unchanged: B starts while A is still going, so it gets its own band.
    const overlapping = M.laneRows([
        ev("a", "run", 0.00, 0.70), ev("a", "tool", 0.02, 0.30), ev("a", "tool", 0.32, 0.68),
        ev("b", "run", 0.40, 1.00), ev("b", "tool", 0.42, 0.70), ev("b", "tool", 0.72, 0.99),
    ]);
    assert.equal(overlapping.length, 4, "two bands of two");
    for (const row of overlapping) {
        assert.equal([...new Set(row.map((p) => p.event.ref.hash))].length, 1, "no row mixes the two");
    }
});

test("laneRows: many concurrent runs are capped in TOTAL, and nothing is dropped", () => {
    const runs = 12, perRun = 3;
    const placed = [];
    for (let r = 0; r < runs; r++) {
        const hash = `r${r}`;
        placed.push({ event: { t: 0, until: 1, kind: "run", ref: { hash } }, run: 0, from: 0, to: 1, clipped: false });
        for (let i = 0; i < perRun; i++) {
            const from = i / perRun, to = (i + 0.9) / perRun;
            placed.push({ event: { t: from, until: to, kind: "tool", ref: { hash } }, run: 0, from, to, clipped: false });
        }
    }
    const rows = M.laneRows(placed);
    assert.ok(rows.length <= M.MAX_LANE_ROWS, `capped at ${M.MAX_LANE_ROWS}, got ${rows.length}`);
    assert.equal(rows.flat().length, placed.length, "every event is still drawn somewhere");
});

test("laneRows: machine events are packed last, in a band of their own", () => {
    const ev = (hash, kind, from, to) => ({
        event: { t: from, until: to, kind, ...(hash ? { ref: { hash } } : {}) },
        run: 0, from, to, clipped: false,
    });
    const rows = M.laneRows([
        ev(null, "load", 0.3, 0.45),
        ev("a", "run", 0.0, 0.9), ev("a", "tool", 0.1, 0.8),
    ], 8);
    assert.equal(rows.at(-1).every((p) => !p.event.ref), true, "the machine's band is last");
    assert.equal(rows[0].map((p) => p.event.kind).join(), "run", "the run still leads its own band");
});

test("laneRows: a bar that merely ABUTS another shares its row rather than claiming an overlap", () => {
    const p = (kind, from, to) => ({ event: { t: from, until: to, kind }, run: 0, from, to, clipped: false });
    const rows = M.laneRows([p("load", 0.20, 0.30), p("tool", 0.30, 0.45)]);
    assert.equal(rows.length, 1, "they touch, they do not overlap");

    // The separation is still taken where it costs nothing — a third bar with room after the second sits on
    // the same row, and a bar that genuinely overlaps still gets its own.
    assert.equal(M.laneRows([p("load", 0.2, 0.3), p("tool", 0.3, 0.45), p("tool", 0.6, 0.7)]).length, 1);
    assert.equal(M.laneRows([p("tool", 0.2, 0.5), p("embed", 0.3, 0.4)]).length, 2, "a real overlap still stacks");
});

test("scopeToSpan: a block's own extent, widened only when it is too short to frame", () => {
    // A long block is scoped to exactly itself — nothing invented around it.
    assert.deepEqual(M.scopeToSpan(1000, 21_000, 99_000), { from: 1000, to: 21_000 });

    // A 40ms tool call is a real event worth pointing at, but a 40ms window contains no samples and draws as
    // an empty plot — so it is widened around its own CENTRE, which stays put.
    const tiny = M.scopeToSpan(10_000, 10_040, 99_000);
    assert.equal(tiny.to - tiny.from, M.MIN_SCOPE_MS);
    assert.equal((tiny.from + tiny.to) / 2, 10_020, "centred on the block, not shifted to one side");

    // Work still IN FLIGHT has no end, so `now` stands in for one — scoping to it while it runs is exactly
    // when this is most useful and least able to know where it stops.
    assert.deepEqual(M.scopeToSpan(50_000, null, 99_000), { from: 50_000, to: 99_000 });
});

// A card can stop being reported mid-session: a driver crash, a GPU reset, a container losing its device.
// That is an INCIDENT, and the samples leading up to it are the most valuable ones on screen — so it must not
// be treated as "a different machine", which is what drops the history.
test("boxChange: a vanished card is not a different box", () => {
    const box = (gpus, hostBytes = 130142785536) => M.parseInfo({ compute: {
        system_compute: { cpu_cores: 32, total_memory: hostBytes, free_memory: 8 * GB },
        supported_gpus: gpus,
    } });
    const c0 = { gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 25 * GB, free_memory: 6 * GB };
    const c1 = { gpu_id: "1", name: "CUDA1", runner: "CUDA", total_memory: 25 * GB, free_memory: 20 * GB };

    assert.equal(M.boxChange(box([c0, c1]), box([c0, c1])), "same", "the same devices, whatever their free memory");
    assert.equal(M.boxChange(box([c0, c1]), box([c0])), "shrank", "a card vanished");
    assert.equal(M.boxChange(box([c0]), box([c0, c1])), "grew", "one appeared");
    // A device's identity changing under the same id IS other hardware, and its readings cannot be redrawn
    // against these ceilings.
    assert.equal(M.boxChange(box([c0]), box([{ ...c0, name: "MTL0", runner: "Metal", total_memory: 12 * GB }])), "switched");
    assert.equal(M.boxChange(box([c0]), box([c0], 68719476736)), "switched", "…and so does the host's total");
    // One replaced by another in the same reading is a swap, not a growth.
    assert.equal(M.boxChange(box([c0]), box([c1])), "switched");
    // Nothing to compare against yet → nothing to conclude.
    assert.equal(M.boxChange(null, box([c0])), "same");

    // And the SAMPLES survive a shrink: sameBoxOnly is only told to drop unattributable ones on a switch.
    // And the SAMPLES survive it: one taken while the vanished card was still reported describes THIS
    // machine, one card ago — comparing whole signatures dropped exactly the samples showing what happened
    // just before it went.
    const samples = [{ t: 1, models: [], capacity: box([c0, c1]) }, { t: 2, models: [], capacity: null }];
    assert.equal(M.sameBoxOnly(samples, box([c0]), false).length, 2, "kept: the pre-incident trace, and one that carries no capacity");
    // A real switch still drops both — the reading and the unattributable one.
    const metal = box([{ ...c0, name: "MTL0", runner: "Metal", total_memory: 12 * GB }], 68719476736);
    assert.equal(M.sameBoxOnly(samples, metal, true).length, 0, "another machine's ceilings cannot redraw these");
});

test("placementOf: a model on a card that stopped being reported says so", () => {
    const cap = M.parseInfo({ compute: {
        system_compute: { cpu_cores: 8, total_memory: 68719476736, free_memory: 8 * GB },
        supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 25 * GB, free_memory: 6 * GB }],
    } });
    // ps still reports it on device 1, which capacity no longer lists.
    const m = M.residencyFrom({ name: "orphan:8b", size: 8 * GB, size_vram: 8 * GB, gpus: [{ gpu_id: "1", size_vram: 8 * GB }] });
    const where = M.placementOf(m, cap, M.formatBytes);
    assert.match(where, /no longer reported/, `honest about the missing card (${where})`);
    assert.doesNotMatch(where, /^device 1 8/, "not a bare id printed as though the card were still there");
});

// The scrub strip: an overview of the whole session, with a box showing which slice the chart is drawing.
test("scrubExtent: where the window sits, and when there is nothing to scrub", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: 1000 + i * 1000 }));   // 1s..10s
    // A window over the last three seconds sits at the right-hand end, and counts as AT THE TAIL.
    const tail = M.scrubExtent(samples, { from: 7000, to: 10_000 });
    assert.equal(tail.from, 1000);
    assert.equal(tail.to, 10_000);
    assert.ok(Math.abs(tail.windowFrom - 6 / 9) < 1e-9);
    assert.equal(tail.windowTo, 1);
    assert.equal(tail.atTail, true);

    // Dragged back: the same width, earlier, and no longer following live.
    const back = M.scrubExtent(samples, { from: 3000, to: 6000 });
    assert.ok(Math.abs(back.windowFrom - 2 / 9) < 1e-9);
    assert.equal(back.atTail, false);

    // A window pinned to live is always a poll behind the newest sample — calling that "scrolled back" would
    // unpin the view for nobody.
    assert.equal(M.scrubExtent(samples, { from: 7000, to: 8500 }).atTail, true, "within the slack");
    assert.equal(M.scrubExtent(samples, { from: 5000, to: 6500 }).atTail, false, "…but not this far back");

    // A WINDOW WIDER THAN THE SESSION still has a strip, at full width. This is the state a live view is in
    // for the first minutes of every session — the rolling window reaches back before the first sample — and
    // it is also where a stretch-while-following lands, since that width is remembered. Returning null here
    // made the control delete itself and reappear minutes later when the session outgrew the window, taking
    // the wheel-scrub with it, so there was no way back at all.
    const wide = M.scrubExtent(samples, { from: 0, to: 99_999 });
    assert.equal(wide.windowFrom, 0, "clamped to the session's own start");
    assert.equal(wide.windowTo, 1);
    assert.equal(wide.atTail, true, "…and following, so the live button reads as on");

    // Nothing to scrub: no viewport at all, or no session to be a viewport onto.
    assert.equal(M.scrubExtent(samples, null), null, "no window means the whole session is shown");
    assert.equal(M.scrubExtent([{ t: 1 }], { from: 0, to: 2 }), null, "one sample is not a session");
    assert.equal(M.scrubExtent([], null), null);
});

test("scrubTo: dragging the box scrolls time, and never past the ends", () => {
    const extent = { from: 0, to: 10_000 };
    const win = { from: 7000, to: 10_000 };   // 3s wide
    // Centred where you dropped it, same width — the box scrolls, it does not zoom.
    const mid = M.scrubTo(extent, win, 0.5);
    assert.deepEqual(mid, { from: 3500, to: 6500 });
    assert.equal(mid.to - mid.from, 3000, "the duration is preserved");
    // Past either end it parks against it rather than scrolling into time nothing was measured in.
    assert.deepEqual(M.scrubTo(extent, win, 0), { from: 0, to: 3000 });
    assert.deepEqual(M.scrubTo(extent, win, 1), { from: 7000, to: 10_000 });
    assert.deepEqual(M.scrubTo(extent, win, 5), { from: 7000, to: 10_000 }, "clamped, not extrapolated");
    // A window wider than the session sits over all of it rather than being squeezed into it.
    assert.deepEqual(M.scrubTo(extent, { from: -5000, to: 30_000 }, 0.2), { from: 0, to: 10_000 });
});

// The lane shows every session's events, which is right until a browsing session has a dozen runs in it.
test("filterEvents: scope answers whose, kinds answer which — and machine events survive both", () => {
    const evs = [
        { t: 1, kind: "run", label: "run a", id: "run:a", ref: { hash: "a" } },
        { t: 2, kind: "tool", label: "exec", id: "s:a:1", ref: { hash: "a", seq: 1 } },
        { t: 3, kind: "embed", label: "reader", id: "s:a:1:sub0", ref: { hash: "a", seq: 1 } },
        { t: 4, kind: "run", label: "run b", id: "run:b", ref: { hash: "b" } },
        // An eviction belongs to the MACHINE, not to a run: it has no ref at all.
        { t: 5, kind: "evict", label: "m evicted", model: "m" },
    ];
    // Everything, by default.
    assert.equal(M.filterEvents(evs, M.EMPTY_LANE_FILTER).length, 5);

    // Scoped to one run: the other run goes, and the machine's own event STAYS — it is what the memory trace
    // is doing, and hiding it for having no owner would remove the events the chart exists for.
    const scoped = M.filterEvents(evs, { hash: "a", scope: "session", hidden: [] });
    assert.deepEqual(scoped.map((e) => e.label), ["run a", "exec", "reader", "m evicted"]);

    // Kinds are an EXCLUSION list, so a kind added later shows up by default instead of being filtered out by
    // a stored preference that predates it.
    assert.deepEqual(M.filterEvents(evs, { hash: null, scope: "all", hidden: ["embed"] }).map((e) => e.label),
        ["run a", "exec", "run b", "m evicted"]);
    assert.deepEqual(M.filterEvents(evs, { hash: "a", hidden: ["embed", "run"] }).map((e) => e.label),
        ["exec", "m evicted"]);

    // And the control can say what it would hide rather than making you toggle blindly.
    assert.deepEqual(M.countByKind(evs), { run: 2, tool: 1, embed: 1, evict: 1 });
});

// Scoping the lane and the model list but not the AXIS left the two disagreeing about what "this session"
// means: the list said one model while the chart still drew ten minutes of a shared box either side of it.
test("sessionWindow: frames the session, follows a live one, and floors a short one", () => {
    const T = 1_700_000_000_000;
    const evs = [
        { t: T, until: T + 60_000, kind: "run", label: "run", ref: { hash: "a" } },
        { t: T + 10_000, until: T + 20_000, kind: "tool", label: "exec", ref: { hash: "a", seq: 1 } },
        // Another session, and a machine event with no session at all — neither frames this one.
        { t: T - 500_000, until: T - 400_000, kind: "run", label: "other", ref: { hash: "b" } },
        { t: T + 900_000, kind: "evict", label: "m evicted", model: "m" },
    ];
    // Long finished: the window is the session's own extent plus a little padding, and nothing else's.
    const w = M.sessionWindow(evs, "a", T + 600_000);
    assert.ok(w.from > T - 10_000 && w.from < T, "starts just before the run");
    assert.ok(w.to > T + 60_000 && w.to < T + 80_000, "…and ends just after it, not at `now`");

    // STILL GOING: the right edge follows the clock, or the window sits behind the memory trace it is
    // meant to be read against.
    const live = M.sessionWindow(evs, "a", T + 70_000);
    assert.ok(live.to >= T + 70_000, "a live session's window reaches the present");

    // A three-second session is a slit: a window narrower than a couple of samples contains no measurements
    // and draws as an empty plot, which reads as the panel breaking rather than as a short run.
    const brief = M.sessionWindow([{ t: T, until: T + 3000, kind: "run", label: "r", ref: { hash: "c" } }], "c", T + 500_000);
    assert.ok(brief.to - brief.from >= 30_000, "floored");
    // …and it is CENTRED in it, rather than pinned against an edge.
    const mid = (brief.from + brief.to) / 2;
    assert.ok(Math.abs(mid - (T + 1500)) < 2000, "the run sits in the middle of its window");

    // Nothing to frame is not a window: inventing one would be a claim about when the session happened.
    assert.equal(M.sessionWindow(evs, "zz", T), null);
    assert.equal(M.sessionWindow(evs, null, T), null);
});

// DEPTH IN THE LANE MEANS CONTAINMENT, so the order of the rows is a claim and not a tidiness preference: a
// run CONTAINS its steps, so it belongs above them, and the machine's own spans are the ground the run
// happened on, so they belong below. Packing by start time alone made it incidental — reproduced from a real
// capture (ml.__events on the box), where the run container sat on row 1 UNDER its own two tool steps while a
// model load took row 0 from the run it was loading for.
test("laneRows: the container is above its children, and the machine is below both", () => {
    // The shape the capture had: a run whose first step begins at the same instant, and a load that starts a
    // hair before the run it is loading for.
    const at = (from, to, kind, extra = {}) => ({
        run: 0, from, to, clipped: false,
        event: { t: from * 1000, until: to * 1000, kind, label: kind, ...extra },
    });
    // THE STEPS COME FIRST IN THE ARRAY, which is what `eventsFrom` actually emits — and with equal starts a
    // stable sort keeps that order, so whichever is first takes the top row. That is precisely how the
    // container ended up under its own children, and an arrangement that puts the run first passes by luck
    // rather than by the rule.
    const placed = [
        at(0.51, 0.53, "load", { model: "qwen:32b" }),
        at(0.52, 0.60, "tool", { ref: { hash: "a", seq: 1 } }),
        at(0.62, 0.70, "tool", { ref: { hash: "a", seq: 2 } }),
        at(0.54, 0.58, "gen", { ref: { hash: "a", seq: 1 } }),
        at(0.52, 0.90, "run", { ref: { hash: "a" } }),
        at(0.55, 0.75, "serve", { model: "qwen:32b" }),
    ];
    const rows = M.laneRows(placed);
    const rowOf = (kind, n = 0) => rows.findIndex((r) => r.filter((p) => p.event.kind === kind).length > n);

    assert.equal(rowOf("run"), 0, "the container is the top row — it holds everything else");
    assert.ok(rowOf("tool") > rowOf("run"), "its steps are below it");
    assert.ok(rowOf("gen") > rowOf("run"), "…and so are its generations");
    // The machine did not belong to the run and did not contain it: it is the ground underneath.
    assert.ok(rowOf("load") > rowOf("tool"), "a load sits below the run's own work, not above it");
    assert.ok(rowOf("serve") > rowOf("tool"), "and so does a serving span");
});

test("laneTier: the three depths, and everything unknown is machine", () => {
    // A tier is only a preference between things drawn at the same time — within one, packing is unchanged.
    assert.equal(M.laneTier("run"), M.laneTier("session"));
    assert.ok(M.laneTier("run") < M.laneTier("tool"));
    assert.equal(M.laneTier("gen"), M.laneTier("tool"));
    assert.equal(M.laneTier("embed"), M.laneTier("tool"));
    assert.ok(M.laneTier("tool") < M.laneTier("load"));
    assert.equal(M.laneTier("serve"), M.laneTier("evict"));
    // A kind added later lands with the machine rather than above a run it has nothing to do with.
    assert.equal(M.laneTier("something-new"), M.laneTier("evict"));
});

test("laneRows: a tier is a preference between OVERLAPPING bars, and costs no rows otherwise", () => {
    // Rows are the lane's scarcest resource and its only claim about time — two bars on separate rows say
    // they overlap — so a tier must never buy depth it does not need. (Bands are a separate axis: a run's
    // tree and the machine's events are banded apart so neither is interleaved with the other, which is why
    // this stays inside one band.)
    const at = (from, to, kind) => ({
        run: 0, from, to, clipped: false,
        event: { t: from * 1000, until: to * 1000, kind, label: kind, model: "m" },
    });
    // Machine kinds only, so it is one band: three bars, none overlapping, one row — even though `load` and
    // `serve` are processed in tier order rather than in time order.
    assert.equal(M.laneRows([at(0.5, 0.6, "serve"), at(0.0, 0.1, "load"), at(0.2, 0.3, "serve")]).length, 1);
    // And the row reads left to right in the order the things happened, whatever order they were packed in.
    const row = M.laneRows([at(0.5, 0.6, "serve"), at(0.0, 0.1, "load"), at(0.2, 0.3, "serve")])[0];
    assert.deepEqual(row.map((p) => p.from), [0.0, 0.2, 0.5]);
});

// On a SHARED box most of the machine half of the lane is someone else's traffic. "This session" was drawing
// all of it, because an event with no ref was read as "belongs to everyone" — so a qwen session showed gemma
// loading, serving and evicting, in gemma's colour, with no way to tell it was another tenant.
test("filterEvents: a scoped lane keeps the machine events about ITS models", () => {
    const evs = [
        { t: 1, kind: "run", label: "run a", id: "run:a", ref: { hash: "a" } },
        { t: 2, kind: "load", label: "loading qwen:7b", model: "qwen:7b" },
        { t: 3, kind: "evict", label: "qwen:7b evicted", model: "qwen:7b" },
        { t: 4, kind: "serve", label: "gemma:2b serving", model: "gemma:2b" },
        { t: 5, kind: "evict", label: "gemma:2b evicted", model: "gemma:2b" },
        // The server emits bare unloads with no model at all.
        { t: 6, kind: "evict", label: "something left memory" },
    ];
    const scoped = M.filterEvents(evs, { hash: "a", scope: "session", hidden: [], models: ["qwen:7b"] });
    // Its own model's load and eviction EXPLAIN the session — an eviction mid-run is why the next turn paid
    // a load. The other tenant's do not.
    assert.deepEqual(scoped.map((e) => e.label), ["run a", "loading qwen:7b", "qwen:7b evicted"]);

    // Unattributable is not the same as unrelated — but a lane asked for one session should not answer with
    // something it cannot place. Kept in full, where there is nothing to be outside of.
    assert.deepEqual(M.filterEvents(evs, { hash: "a", scope: "all", hidden: [], models: ["qwen:7b"] }).length, 6);

    // NOT KNOWN must not collapse into NONE: one hides nothing, the other hides the lot.
    assert.equal(M.filterEvents(evs, { hash: "a", scope: "session", hidden: [] }).length, 6);
    assert.equal(M.filterEvents(evs, { hash: "a", scope: "session", hidden: [], models: [] }).length, 1);
});

// Where you GRAB decides what the drag does. Recentring on the cursor wherever it lands is what made the
// window impossible to widen once narrowed: every grab was a pan, including a grab on a handle.
// Double-clicking a short step scoped to a window with one sample in it. Everything here needs a segment of
// at least two — `segments()` drops shorter ones — so the tracks, the lane and the strip all drew nothing and
// the panel looked like it had disappeared. A time floor cannot promise samples; only counting them can.
// The hover is held in a signal, so it outlives what it pointed at: a click that navigates, a filter chip, the
// window moving on. An id matching nothing used to yield a lineage of one unmatchable member, which dimmed
// every bar and every step at once — read as the whole lane disappearing rather than a stale highlight.
test("lineageOf: an id that is no longer drawn focuses NOTHING, rather than everything-but-nothing", () => {
    const events = [
        { id: "a", kind: "tool" },
        { id: "b", kind: "embed", parent: "a" },
    ];
    assert.deepEqual([...M.lineageOf(events, "a")].sort(), ["a", "b"], "a live id still lights its lineage");
    assert.equal(M.lineageOf(events, "gone").size, 0, "a stale id lights nothing");
    assert.equal(M.lineageOf(events, undefined).size, 0);
    assert.equal(M.lineageOf([], "a").size, 0, "…including when everything was filtered away");
});

test("scopeAround: widens until the window actually contains samples to draw", () => {
    const every2s = Array.from({ length: 30 }, (_, i) => ({ t: 100_000 + i * 2000 }));
    const inWindow = (w) => every2s.filter((s) => s.t >= w.from && s.t <= w.to).length;

    // A 400ms tool call on a box polled every 2s: the raw span, and even the 2.5s floor, can hold one sample.
    const tight = M.scopeToSpan(140_000, 140_400, 200_000);
    assert.ok(inWindow(tight) < 3, "the plain floor is not enough — this is the bug");

    const safe = M.scopeAround(every2s, 140_000, 140_400, 200_000);
    assert.ok(inWindow(safe) >= 3, `widened until it covers samples (got ${inWindow(safe)})`);
    // Still CENTRED on the step: widening must not slide the window off the thing you double-clicked.
    assert.ok(safe.from <= 140_000 && safe.to >= 140_400, "the step is still inside it");

    // A span that already covers plenty is left alone.
    const long = M.scopeAround(every2s, 120_000, 150_000, 200_000);
    assert.equal(long.from, 120_000);
    assert.equal(long.to, 150_000);

    // A session too short to satisfy the floor gives back the whole session rather than an empty window.
    const two = [{ t: 5000 }, { t: 7000 }];
    assert.deepEqual(M.scopeAround(two, 5500, 5600, 9000), { from: 5000, to: 7000 });
});

test("scrubZone: the edges resize, the middle pans, and outside is neither", () => {
    const ex = { windowFrom: 0.30, windowTo: 0.70 };
    const W = 400;   // 7px of handle ≈ 0.0175 of the track
    assert.equal(M.scrubZone(ex, 0.50, W), "pan");
    assert.equal(M.scrubZone(ex, 0.30, W), "from");
    assert.equal(M.scrubZone(ex, 0.70, W), "to");
    assert.equal(M.scrubZone(ex, 0.10, W), "outside");
    assert.equal(M.scrubZone(ex, 0.95, W), "outside");
    // Just OUTSIDE the box but within a handle's reach still grabs the handle — a 7px target you have to hit
    // from exactly one side is not a 7px target.
    assert.equal(M.scrubZone(ex, 0.29, W), "from");

    // Still comfortably wide enough for a middle: 0.30 of a 400px track is 120px against 7px handles.
    const roomy = { windowFrom: 0.50, windowTo: 0.80 };
    assert.equal(M.scrubZone(roomy, 0.65, W), "pan");
});

// A HAIRLINE WINDOW CAN ALWAYS BE WIDENED. The handle is capped at a third of the window so a narrow one
// keeps a middle to pan by — but the cap was applied to the reach OUTSIDE the window too, so a window a few
// pixels across had handles of one or two pixels either side and every grab landed on the pan zone. The only
// way to widen it again was discarding the zoom entirely, which is the position you are in precisely when
// widening is the one thing you want.
test("scrubZone: the handle's reach OUTSIDE the window is never capped by the window's own width", () => {
    const W = 400;   // 7px of handle ≈ 0.0175 of the track
    // 0.006 of the track = 2.4px: narrower than a single handle.
    const hair = { windowFrom: 0.500, windowTo: 0.506 };
    assert.equal(M.scrubZone(hair, 0.49, W), "from", "reaching in from the left grabs the left edge");
    assert.equal(M.scrubZone(hair, 0.515, W), "to", "…and from the right, the right one");
    assert.equal(M.scrubZone(hair, 0.40, W), "outside", "…but the reach is a handle's width, not the track");

    // NOTHING IS GIVEN UP FOR IT. The middle still pans, at every width — a narrow window you can no longer
    // move is a different way to be stuck, and the two gestures both have to survive.
    assert.equal(M.scrubZone(hair, 0.503, W), "pan");
    assert.equal(M.scrubZone({ windowFrom: 0.50, windowTo: 0.80 }, 0.65, W), "pan");

    // The reach is a constant number of PIXELS, so it shrinks as a fraction on a wider track.
    assert.equal(M.scrubZone(hair, 0.49, 4000), "outside", "10px of a 4000px track is far outside");
});

test("scrubResize: one edge moves, the other stays exactly put", () => {
    const ex = { from: 0, to: 100_000 };
    const win = { from: 40_000, to: 60_000 };

    const wider = M.scrubResize(ex, win, "from", 0.10);
    assert.equal(wider.to, 60_000, "the far edge did not drift");
    assert.equal(wider.from, 10_000);

    const narrower = M.scrubResize(ex, win, "to", 0.50);
    assert.equal(narrower.from, 40_000, "…in either direction");
    assert.equal(narrower.to, 50_000);

    // Dragging an edge PAST the other parks against a minimum rather than inverting the range into a
    // negative duration every consumer would then have to defend against.
    const crossed = M.scrubResize(ex, win, "from", 0.90);
    assert.ok(crossed.from < crossed.to, "still a forward range");
    assert.equal(crossed.to - crossed.from, M.MIN_SCOPE_MS);

    // And it cannot be dragged outside the session.
    assert.equal(M.scrubResize(ex, win, "from", -1).from, 0);
    assert.equal(M.scrubResize(ex, win, "to", 2).to, 100_000);
});

test("scrubNudge: one notch moves the same VISIBLE distance at any zoom", () => {
    const ex = { from: 0, to: 600_000 };
    const tight = M.scrubNudge(ex, { from: 300_000, to: 310_000 }, 0.25);
    const loose = M.scrubNudge(ex, { from: 200_000, to: 400_000 }, 0.25);
    assert.equal(tight.from - 300_000, 2_500, "a quarter of a 10s window");
    assert.equal(loose.from - 200_000, 50_000, "…and a quarter of a 200s one");
    // Widths are preserved: this scrolls, it does not zoom.
    assert.equal(tight.to - tight.from, 10_000);
    assert.equal(loose.to - loose.from, 200_000);
    // Parks against the end rather than scrolling into time nobody sampled.
    const end = M.scrubNudge(ex, { from: 590_000, to: 600_000 }, 0.25);
    assert.equal(end.to, 600_000);
    // A window already covering everything has nowhere to go.
    assert.deepEqual(M.scrubNudge(ex, { from: 0, to: 600_000 }, 0.25), { from: 0, to: 600_000 });
});

test("scrubNudge: four small notches land exactly where one big one does", () => {
    // The property the wheel handler exists to guarantee — a fixed step per EVENT is what made the same
    // physical swipe travel wildly different distances depending on how the hardware chose to quantise it,
    // so a trackpad emitting many small deltas has to arrive in the same place as a mouse emitting one large
    // one. That is a claim about composition, and it is exact here in a way it can never be end to end: a
    // browser test measures a window that a poll can pull toward live between two of the four events, which
    // is a real behaviour and not a rounding artefact, so the exact form of the claim belongs at this layer.
    const ex = { from: 0, to: 22_000 };
    const win = { from: 9_000, to: 13_000 };
    const plotPx = 400;
    const one = M.scrubNudge(ex, win, M.wheelScrubFraction(0, 120, 0, plotPx));
    let four = win;
    for (let i = 0; i < 4; i++) four = M.scrubNudge(ex, four, M.wheelScrubFraction(0, 30, 0, plotPx));
    assert.ok(Math.abs(four.from - one.from) < 1e-6, `4x30 landed at ${four.from}, 1x120 at ${one.from}`);
    assert.ok(Math.abs(four.to - one.to) < 1e-6);
    assert.equal(one.from - win.from, 1_200, "and it is the distance the fraction actually names");
    // The same composition holds for a HORIZONTAL gesture, which reaches the same arithmetic by the other
    // axis — `wheelScrubFraction` takes the larger of the two, so the axes cannot drift apart.
    assert.equal(M.wheelScrubFraction(120, 0, 0, plotPx), M.wheelScrubFraction(0, 120, 0, plotPx));
});

// The chart scrubbing erratically under a trackpad was two bugs wearing one symptom: only `deltaY` was read,
// and the step was a fixed fraction regardless of how far the gesture actually went.
test("wheelScrubFraction: proportional to the gesture, and reads whichever axis dominates", () => {
    const W = 400;

    // 1:1 with the plot — swipe across half of it and the window moves half its own width.
    assert.equal(M.wheelScrubFraction(0, 200, 0, W), 0.5);
    assert.equal(M.wheelScrubFraction(200, 0, 0, W), 0.5, "a HORIZONTAL swipe scrubs too — it was ignored");

    // Proportional, so a trackpad's stream of small events accumulates to the same distance as one big one.
    // A fixed step per event is what made the same physical swipe travel wildly different distances
    // depending on how the hardware quantised it.
    const oneBig = M.wheelScrubFraction(0, 120, 0, W);
    const manySmall = Array.from({ length: 12 }, () => M.wheelScrubFraction(0, 10, 0, W)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(oneBig - manySmall) < 1e-9, "twelve notches of 10 equal one of 120");

    // Direction follows the gesture: down and right both move forward in time.
    assert.ok(M.wheelScrubFraction(0, -200, 0, W) < 0);
    assert.ok(M.wheelScrubFraction(-200, 0, 0, W) < 0);

    // A diagonal is counted ONCE, on the dominant axis — not summed, which would make an off-axis swipe
    // travel further than a clean one.
    assert.equal(M.wheelScrubFraction(200, 40, 0, W), 0.5);
    assert.equal(M.wheelScrubFraction(40, 200, 0, W), 0.5);

    // deltaMode: a mouse reports LINES and a page gesture reports PAGES.
    assert.equal(M.wheelScrubFraction(0, 1, 1, W), 16 / W, "one line, not one pixel");
    assert.equal(M.wheelScrubFraction(0, 1, 2, W), 1, "one page = one window width");

    // Degenerate inputs do nothing rather than dividing by zero.
    assert.equal(M.wheelScrubFraction(0, 200, 0, 0), 0);
    assert.equal(M.wheelScrubFraction(0, 0, 0, W), 0);
});

// WHAT A SCRUB DRAG MEANT. The old rule — "the window ends at the tail → rejoin live" — could not tell a
// PAN from a left-edge RESIZE, and a left-edge resize never moves `to`. So every attempt to stretch the
// window while following was read as "rejoin live", the new width was discarded, and the strip snapped back:
// you could narrow the window and never widen it again.
describe("scrubIntent", () => {
    const { scrubIntent } = M;
    const ex = { from: 0, to: 300_000 };          // a five-minute session
    const SLACK = 2000;

    // ONE RULE: dropped at the tail → follow, at the width on screen. Two bugs came from not having it.
    // (1) Rejoining live RESTORED the last `resWindowS`, so narrowing a pinned window and dragging it back
    // to the edge made it snap large again — the width you were looking at was discarded on arrival.
    // (2) A left-edge stretch while already following was read as "dropped at the tail, rejoin live", which
    // threw the new width away, so the window could be narrowed but never widened.
    test("stretching the LEFT edge while at the tail keeps following, at the new width", () => {
        assert.deepEqual(scrubIntent(ex, { from: 60_000, to: 300_000 }, SLACK), { live: true, windowS: 240 });
    });

    test("a NARROW window dragged back to the tail follows at THAT width, not the width it left", () => {
        // The reported bug, exactly: stretch it wide, pin it, narrow it, drag it back to live — and it grew.
        assert.deepEqual(scrubIntent(ex, { from: 285_000, to: 300_000 }, SLACK), { live: true, windowS: 15 });
    });

    test("the width is what was dragged, not the preset it started from", () => {
        assert.equal(scrubIntent(ex, { from: 200_000, to: 300_000 }, SLACK).windowS, 100);
        assert.equal(scrubIntent(ex, { from: 10_000, to: 300_000 }, SLACK).windowS, 290);
    });

    test("away from the tail it pins a range instead — it is no longer following", () => {
        assert.deepEqual(scrubIntent(ex, { from: 60_000, to: 200_000 }, SLACK),
            { live: false, window: { from: 60_000, to: 200_000 } });
    });

    test("panning back and forth without resizing leaves the width alone", () => {
        // A pan never changes the window's width, so returning to live returns the same number — the rule
        // covers a pan without having to special-case it.
        const w = { from: 240_000, to: 300_000 };
        assert.equal(scrubIntent(ex, w, SLACK).windowS, 60);
    });

    test("the tail SLACK is honoured — a hair short of the end still counts as following", () => {
        assert.equal(scrubIntent(ex, { from: 60_000, to: 299_000 }, SLACK).live, true);
        assert.equal(scrubIntent(ex, { from: 60_000, to: 297_000 }, SLACK).live, false,
            "past the slack it is a deliberate pin, not a sloppy drop at the end");
    });

    test("a width never rounds to zero — a sub-second stretch is one second, not 'everything kept'", () => {
        // 0 is the sentinel for "no window at all", so rounding into it would silently mean the opposite.
        assert.equal(scrubIntent(ex, { from: 299_800, to: 300_000 }, SLACK).windowS, 1);
    });
});

// ZOOMING INSIDE A SINGLE LONG EVENT. Dragging the scrub window to sit entirely WITHIN one event —
//   [            event            ]
//              [ window ]
// left the panel drawing nothing: a window narrower than the poll interval falls between two samples, a
// plain filter returns fewer than two, and the chart needs two to draw a line. No line, no ceiling, no
// tracks — which reads as the panel having broken rather than as a window between polls, while the thing
// you zoomed in on is still perfectly well defined.
describe("windowSamples", () => {
    const { windowSamples } = M;
    const at = (...ts) => ts.map((t) => ({ t }));

    test("a window with plenty of samples uses exactly those", () => {
        const got = windowSamples(at(0, 1000, 2000, 3000, 4000), { from: 900, to: 3100 });
        assert.deepEqual(got.map((s) => s.t), [1000, 2000, 3000], "no neighbours dragged in to stretch the scale");
    });

    test("a window between two polls borrows BOTH neighbours, so a line can cross it", () => {
        const got = windowSamples(at(0, 5000, 10000), { from: 6000, to: 7000 });
        assert.deepEqual(got.map((s) => s.t), [5000, 10000], "the measurements either side of the gap");
    });

    test("a window holding ONE sample still borrows, since one point draws no line", () => {
        const got = windowSamples(at(0, 5000, 10000), { from: 4000, to: 6000 });
        assert.deepEqual(got.map((s) => s.t), [0, 5000, 10000]);
    });

    test("a window before the first sample borrows only what exists", () => {
        assert.deepEqual(windowSamples(at(5000, 10000), { from: 0, to: 1000 }).map((s) => s.t), [5000]);
    });

    test("a window after the last borrows the last", () => {
        assert.deepEqual(windowSamples(at(5000, 10000), { from: 20000, to: 30000 }).map((s) => s.t), [10000]);
    });

    test("no samples at all is still no samples — nothing is invented", () => {
        assert.deepEqual(windowSamples([], { from: 0, to: 1000 }), []);
    });

    test("no window means every sample", () => {
        assert.deepEqual(windowSamples(at(1, 2, 3), null).map((s) => s.t), [1, 2, 3]);
    });

    test("the borrowed samples are REAL, at their own timestamps — nothing is interpolated to the edge", () => {
        // The panel refuses to invent a reading anywhere else (a gap stays a gap), and this is the same rule:
        // a sample at the window's boundary would be a measurement nobody took.
        const got = windowSamples(at(0, 5000, 10000), { from: 6000, to: 7000 });
        assert.ok(got.every((s) => [0, 5000, 10000].includes(s.t)), "every returned sample is one that exists");
    });
});

// …and the event that window sits inside must still be DRAWN, cropped to what is on screen.
describe("placeEvents: an event wider than the window", () => {
    const { placeEvents } = M;
    test("an event spanning the whole run is placed across it, not dropped", () => {
        const run = [{ t: 1000 }, { t: 2000 }, { t: 3000 }];
        const [p] = placeEvents([run], [{ kind: "run", t: 0, until: 9000, model: "m" }]);
        assert.ok(p, "the event is placed even though it starts before and ends after the samples");
        assert.equal(p.from, 0, "cropped to the left edge");
        assert.equal(p.to, 1, "…and the right");
        assert.equal(p.clipped, true, "and it SAYS it continues past what is drawn");
    });
});

// A SELECTION TOO SMALL TO MEAN ANYTHING. The axis is SEGMENTED, so a densely-sampled run occupies a lot of
// width for a little time — a deliberate drag across it can resolve to a few milliseconds. That window holds
// no samples, draws as an empty plot, and reads as the panel breaking rather than as a selection that was
// too narrow. `scopeToSpan` already widens a too-short block for the same reason.
describe("clampWindow", () => {
    const { clampWindow, MIN_SCOPE_MS } = M;

    test("a window wider than the minimum is returned untouched", () => {
        const w = { from: 1000, to: 1000 + MIN_SCOPE_MS * 3 };
        assert.deepEqual(clampWindow(w), w);
    });

    test("a window exactly at the minimum is left alone — the bound is inclusive", () => {
        const w = { from: 0, to: MIN_SCOPE_MS };
        assert.deepEqual(clampWindow(w), w);
    });

    test("a narrower one is widened to the minimum, ABOUT ITS OWN CENTRE", () => {
        // Symmetrically: the stretch you picked has to stay in the middle of what you get, or a selection
        // near the end of a run slides off the part you were pointing at.
        const got = clampWindow({ from: 10000, to: 10010 });
        assert.equal(got.to - got.from, MIN_SCOPE_MS, "widened to exactly the minimum");
        assert.equal((got.from + got.to) / 2, 10005, "…keeping the centre it had");
    });

    test("a ZERO-width selection is not a window at all", () => {
        // Not "widen a click into 2.5 seconds": a click is not a selection, and turning one into a zoom is
        // the behaviour the gesture guard upstream exists to prevent.
        assert.equal(clampWindow({ from: 5000, to: 5000 }), null);
    });

    test("an inverted window is refused rather than silently flipped", () => {
        // A negative-duration range is a caller bug; widening it would hand back something plausible and
        // wrong, which every consumer would then have to defend against.
        assert.equal(clampWindow({ from: 5000, to: 4000 }), null);
    });

    test("the minimum is a parameter, so a caller with its own floor is not stuck with this one", () => {
        const got = clampWindow({ from: 0, to: 10 }, 1000);
        assert.equal(got.to - got.from, 1000);
    });
});

// A LOAD IS NOT AN ABSENCE OF EVIDENCE. Measured on a real box (tmp capture, 2026-09-05): between
// `load.start` and `load.complete` there were 22 consecutive samples in which `/api/ps` was completely EMPTY
// while the card reported 76.78 then 87.82 GiB in use — because Ollama has no runner object for a model
// until its load finishes, so ps does not report it vaguely, it omits it. Read literally that is a card 92%
// full with nothing accounting for it, and the panel duly drew "unattributed 87.82 GiB". The load edges are
// what we have instead, and `ResourceSample.loading` carries them into the derivation.
test("deviceBands: a residual a LOAD explains is named as the load, not as unattributed", () => {
    const GB = 1024 ** 3;
    // The capture's own numbers: card 0 with 87.82 GiB gone and ps empty.
    const mid = { compute: { ...CUDA_INFO.compute, supported_gpus: [
        { ...CUDA_INFO.compute.supported_gpus[0], free_memory: CUDA_INFO.compute.supported_gpus[0].total_memory - 87.82 * GB },
        CUDA_INFO.compute.supported_gpus[1],
    ] } };
    const cap = M.parseInfo(mid);

    const blind = M.deviceBands({ t: 1, models: [], capacity: cap }, "0");
    assert.equal(blind.find((b) => b.key === "other").label, M.OTHER_BAND_LABEL,
        "with nothing loading, a big residual really is unattributed");

    const knowing = M.deviceBands({ t: 1, models: [], capacity: cap, loading: ["qwen3.8-flash-next:vision"] }, "0");
    const other = knowing.find((b) => b.key === "other");
    assert.equal(other.label, "loading qwen3.8-flash-next:vision");
    assert.ok(other.bytes > 87 * GB, "…and it is the whole allocation, not a sliver");

    // Several at once are counted rather than listed — a band label is one line in a legend.
    assert.equal(
        M.deviceBands({ t: 1, models: [], capacity: cap, loading: ["a", "b"] }, "0").find((b) => b.key === "other").label,
        "loading 2 models");

    // The FLOOR still wins. An idle card holds ~0.55 GiB of ollama's own discovery context, and a load
    // starting elsewhere must not relabel that as this card loading something.
    const idle = M.parseInfo(CUDA_INFO);
    const quiet = M.deviceBands({ t: 1, models: [], capacity: idle, loading: ["something"] }, "0");
    assert.equal(quiet.find((b) => b.key === "other").label, M.DRIVER_BAND_LABEL,
        "a sub-GiB residual is the driver's context whatever is loading");
});

// THE NOTCH. A `/api/ps` row with `state: "loading"` carries its name and ZEROS — no `size_vram`, no `gpus`.
// Read as a residency it claims the model is present and using nothing, which draws its band straight down to
// the axis and back up a poll later. Pinned against the real frames (capture 2026-09-05, t=76085..77473): the
// SAME model, resident and serving with 94,171,928,982 bytes on CUDA0, was re-reported as `loading` with
// zeros while a DIFFERENT model loaded — twice, 2ms either side of a correct row — while the server's own
// top-level `vram_used` stayed at 94,171,928,982 throughout. The row contradicts its own response's total.
test("residencyFrom: a LOADING row carries no occupancy — it must not read as zero bytes resident", () => {
    const running = M.residencyFrom({
        model: "qwen3.8-flash-next:vision", name: "qwen3.8-flash-next:vision",
        size: 94171928982, size_vram: 94171928982,
        gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: 94171928982 }],
    });
    assert.equal(running.vramBytes, 94171928982);

    // The very next frame, for the same model, with nothing having moved.
    const placeholder = {
        model: "registry.ollama.ai/library/qwen3.8-flash-next:vision", state: "loading",
        size: 0, size_vram: 0, expires_at: "0001-01-01T00:00:00Z",
    };
    // Read literally it is a resident model holding nothing — which is the wrong claim, and the whole reason
    // the caller filters these out before they become a sample. This pins WHY: the parse itself cannot tell.
    assert.equal(M.residencyFrom(placeholder).vramBytes, 0,
        "the row genuinely says zero — so it is the CALLER that must not treat it as a residency");
    assert.equal(placeholder.state, "loading", "…and `state` is the only thing that distinguishes it");
});

// THE SAMPLING RATE IS NOT UNIFORM, so a history bounded only by COUNT is bounded by an amount of wall time
// that varies with what the box was doing. A patched Ollama samples at 250ms while a load is in flight and
// around 16s when idle — measured — so one 60-second load costs 240 slots where a minute of idle costs four.
// Trimmed by count alone, a few loads evict the whole idle history and the chart is left with minutes of wall
// time under a window set to thirty.
test("sample retention: an age horizon, with the count as the memory ceiling", async () => {
    const V = await import("../src/sidebar/vram.tsx").catch(() => null);
    if (!V) return;   // the module pulls in preact; the constants are what matter here
    assert.ok(V.RESOURCE_RETENTION_MS >= 30 * 60_000,
        "the horizon must outlast the longest window the chart offers, or 'Everything kept' cannot draw it");
    assert.ok(V.RESOURCE_HISTORY >= 900, "the count is a memory ceiling, not the thing deciding what is kept");
    // The two together: at the load rate the ceiling must still cover a load without evicting the idle
    // history around it. 250ms for a minute is 240 samples.
    assert.ok(V.RESOURCE_HISTORY > 240 * 4, "several loads in a session must not exhaust the ring");
});

// PINCH TO ZOOM. A trackpad pinch reaches the page as a wheel carrying ctrlKey, so it costs no new surface —
// the handler that slides the window along reads one more flag. What it must get right is the anchor: a zoom
// that does not keep the thing under your fingers under them reads as the chart jumping.
test("scrubPinch: narrows and widens around the pointer, symmetrically", () => {
    const ex = { from: 0, to: 100_000 };
    const win = { from: 40_000, to: 60_000 };

    // Pinching OUT is a negative delta and means closer, so the window narrows.
    const inward = M.scrubPinch(ex, win, -20, 0.5);
    assert.ok(inward.to - inward.from < win.to - win.from, "pinching out zooms IN");
    const outward = M.scrubPinch(ex, win, 20, 0.5);
    assert.ok(outward.to - outward.from > win.to - win.from, "and pinching in zooms OUT");

    // SYMMETRIC: the same amount each way returns to where it started. A linear step accumulates drift, which
    // is what makes a zoom feel like it is sliding away from you.
    const there = M.scrubPinch(ex, win, -20, 0.5);
    const back = M.scrubPinch(ex, there, 20, 0.5);
    assert.ok(Math.abs((back.to - back.from) - (win.to - win.from)) < 1, "out then in is where you began");

    // ANCHORED: the instant under the pointer stays at the same fraction of the window.
    const atStart = M.scrubPinch(ex, win, -20, 0);
    assert.equal(atStart.from, win.from, "pinching on the left edge holds the left edge");
    const atEnd = M.scrubPinch(ex, win, -20, 1);
    assert.ok(Math.abs(atEnd.to - win.to) < 1, "…and on the right edge, the right one");
    // The middle keeps the middle.
    const mid = M.scrubPinch(ex, win, -20, 0.5);
    assert.ok(Math.abs((mid.from + mid.to) / 2 - (win.from + win.to) / 2) < 1, "the centre is where it was");

    // BOUNDED both ways: never past the session, never below the minimum a window may be — a zoom that can
    // reach zero width is a zoom you cannot come back from.
    const huge = M.scrubPinch(ex, win, 10_000, 0.5);
    assert.ok(huge.to - huge.from <= ex.to - ex.from, "cannot be widened past the session");
    assert.ok(huge.from >= ex.from && huge.to <= ex.to, "and stays inside it");
    let tiny = win;
    for (let i = 0; i < 200; i++) tiny = M.scrubPinch(ex, tiny, -50, 0.5);
    assert.ok(tiny.to - tiny.from >= Math.min(M.MIN_SCOPE_MS, ex.to - ex.from), "never collapses to nothing");

    // A single flick cannot cross the whole range: a trackpad can deliver a very large delta in one frame.
    const flick = M.scrubPinch(ex, win, -100_000, 0.5);
    assert.ok(flick.to - flick.from > (win.to - win.from) * 0.5, "one event is capped");

    // Degenerate inputs are returned untouched rather than producing a NaN window.
    assert.deepEqual(M.scrubPinch({ from: 5, to: 5 }, win, -20, 0.5), win);
    assert.deepEqual(M.scrubPinch(ex, { from: 10, to: 10 }, -20, 0.5), { from: 10, to: 10 });
});

// WHAT a model's VRAM is holding, not just how much of it there is. `size_vram` alone cannot tell a BIG
// MODEL from a BIG CONTEXT — lots of weights with a small cache, and modest weights with an enormous one,
// are the same number and call for opposite responses. Captured from a live load of `gemma4:e2b`.
const REAL_PS = {
    model: "gemma4:e2b", name: "gemma4:e2b", size: 4639812484, size_vram: 4639812484,
    weights_on_disk: 7162394016,
    memory: { weights: 1465426903, kv_cache: 836763648, compute: 1129588981, projector: 1208032952 },
    gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: 4639812484,
             memory: { weights: 1465426903, kv_cache: 836763648, compute: 1129588981, projector: 1208032952 } }],
};

test("memorySplit: the parts sum to the total EXACTLY, or it refuses", () => {
    const m = M.memorySplit(REAL_PS.memory, REAL_PS.size_vram);
    assert.ok(m, "the real capture parses");
    // The server's own invariant, verified to the byte on every model it reports. A split that does not sum
    // is a bug to report, never a remainder to invent — so a mismatch yields NOTHING rather than a fifth
    // slice papering over the difference.
    assert.equal(m.weights + m.kvCache + m.compute + m.recurrentState + m.output + m.projector + m.other,
        REAL_PS.size_vram);
    assert.equal(M.memorySplit({ ...REAL_PS.memory, compute: 999 }, REAL_PS.size_vram), null,
        "one byte off and it is not a split of this total");

    // A key is OMITTED when zero, so a missing one reads as zero rather than as absent data.
    const text = M.memorySplit({ weights: 10, kv_cache: 5, compute: 5 }, 20);
    assert.equal(text.projector, 0);
    assert.equal(text.recurrentState, 0);

    // ABSENT is not zero. The server omits the object when it cannot divide the figure (a loading row, an
    // MLX runner), and an all-zero split beside a non-zero total would be a contradiction it never sends.
    assert.equal(M.memorySplit(undefined, 100), null);
    assert.equal(M.memorySplit(null, 100), null);
    assert.equal(M.memorySplit({ weights: 0, kv_cache: 0, compute: 0 }, 0), null, "nothing to draw");
});

test("residencyFrom: carries the split, per device, with the disk size beside it", () => {
    const r = M.residencyFrom(REAL_PS);
    assert.equal(r.memory.weights, 1465426903);
    assert.equal(r.perDeviceMemory["0"].projector, 1208032952, "each card's own split, not an average");
    // DELIBERATELY beside `memory`, not inside it: the file is not resident memory and including it would
    // break the sum. Here it is far LARGER than the resident weights, which is ordinary.
    assert.equal(r.weightsOnDisk, 7162394016);
    assert.equal(r.memoryHost, undefined, "no spill on this one");

    // A server predating the change reports none of it, and that must read as "not reported".
    const old = M.residencyFrom({ model: "x", size: 100, size_vram: 100, gpus: [{ gpu_id: "0", size_vram: 100 }] });
    assert.equal(old.memory, undefined);
    assert.equal(old.vramBytes, 100, "…while everything that was always there still works");
});

test("memoryParts / contextBytes: what a user can act on", () => {
    const m = M.memorySplit(REAL_PS.memory, REAL_PS.size_vram);
    const parts = M.memoryParts(m);
    assert.deepEqual(parts.map((p) => p.key), ["weights", "kvCache", "projector", "compute"],
        "stack order, and a zero part is dropped rather than drawn as an empty label");
    assert.equal(parts.reduce((s, p) => s + p.bytes, 0), REAL_PS.size_vram, "still no remainder");

    // `recurrent_state` answers the same question as a KV cache — some layers keep it INSTEAD of one — so
    // the FIGURE adds them and the LABEL never conflates them.
    const hybrid = M.memorySplit({ weights: 10, kv_cache: 5, compute: 1, recurrent_state: 4 }, 20);
    assert.equal(M.contextBytes(hybrid), 9, "context is the cache AND the recurrent state");
    const labels = M.memoryParts(hybrid).map((p) => p.label);
    assert.ok(labels.some((l) => /recurrent/i.test(l)), "…and it is named as what it is");
    assert.ok(!labels.some((l) => /recurrent/i.test(l) && /KV/i.test(l)), "never as a KV cache");
});

// SNAPPING THE CROSSHAIR to the datapoint it is already reading. The tooltip has always named a real
// measurement — a figure halfway between two polls was never observed — but the line was drawn wherever the
// pointer was, so the number and the mark disagreed by up to half a sample gap.
test("snapFraction: lands exactly where sampleAtFraction reads, and inverts the segmented axis", () => {
    const run = (n, t0) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 1000 }));

    // ONE segment: sample i sits at i/(n-1) of the width, which is where a polyline puts it.
    const one = [run(5, 0)];
    for (const f of [0, 0.12, 0.26, 0.5, 0.74, 0.99, 1]) {
        const snap = M.snapFraction(one, f);
        assert.equal(one[0][snap.index], M.sampleAtFraction(one, f),
            `f=${f}: the snap and the reading must be the SAME sample, or the mark contradicts the number`);
        assert.ok(Math.abs(snap.frac - snap.index / 4) < 1e-9, `f=${f}: it sits where the polyline drew it`);
    }

    // TWO segments, flex-weighted by sample COUNT rather than by elapsed time — a gap is a gap, and the axis
    // is not linear across it. The 8-sample run owns 8/10 of the width, the 2-sample run the rest.
    const two = [run(8, 0), run(2, 600000)];
    const inSecond = M.snapFraction(two, 0.95);
    assert.equal(two[1][inSecond.index], M.sampleAtFraction(two, 0.95), "the second segment reads its own sample");
    assert.ok(inSecond.frac > 0.8, "…and snaps inside that segment, not back across the gap");
    const lastOfFirst = M.snapFraction(two, 0.79);
    assert.equal(two[0][lastOfFirst.index], M.sampleAtFraction(two, 0.79));

    // A ONE-SAMPLE segment has no interior, so it sits in the middle of the share it owns rather than at an
    // edge it does not — an edge would put the dot on the boundary with the neighbouring run.
    const lone = [run(1, 0), run(3, 60000)];
    const only = M.snapFraction(lone, 0.05);
    assert.equal(only.index, 0);
    assert.ok(only.frac > 0 && only.frac < 0.25, `a lone sample sits inside its own share (${only.frac})`);

    // It names the ORIGINAL segment, so a caller mapping over `runs` can ask "is it in THIS one?". Filtering
    // first and returning a position in the filtered list names the wrong segment on any window holding an
    // empty one — and an empty run is ordinary, since a gap is a gap.
    const withHole = [[], run(4, 0), [], run(3, 90000)];
    assert.equal(M.snapFraction(withHole, 0.1).run, 1, "the first NON-EMPTY run is index 1, not 0");
    assert.equal(M.snapFraction(withHole, 0.95).run, 3);

    // Nothing to snap to is null, never 0 — 0 is a real position and would park the dot at the left edge.
    assert.equal(M.snapFraction([], 0.5), null);
    assert.equal(M.snapFraction([[]], 0.5), null);
});

// A GENUINELY SPLIT MODEL, captured from the box rather than constructed here: `qwen3:235b` (142 GB) across
// two 96 GB cards. Every synthetic fixture agrees with itself, which is exactly what makes one useless for
// the question "does the server's per-card split behave the way we assume".
const SPLIT_PS = {
    name: "qwen3:235b", model: "qwen3:235b", size: 144314759904, size_vram: 144314759904,
    memory: { weights: 141798009732, kv_cache: 1577058304, compute: 939691868 },
    gpus: [
        { gpu_id: "0", runner: "CUDA", size_vram: 73320093450,
          memory: { weights: 72044941148, kv_cache: 805306368, compute: 469845934 } },
        { gpu_id: "1", runner: "CUDA", size_vram: 70994666454,
          memory: { weights: 69753068584, kv_cache: 771751936, compute: 469845934 } },
    ],
};

test("a split model decomposes PER CARD, and the sum holds on each one", () => {
    const r = M.residencyFrom(SPLIT_PS);
    const sum = (m) => m.weights + m.kvCache + m.compute + m.recurrentState + m.output + m.projector + m.other;
    assert.equal(sum(r.memory), SPLIT_PS.size_vram, "the model's own split still sums to its total");
    // The invariant that matters for drawing: each CARD's split fills that card's band with no remainder, so
    // a band can be subdivided in place on either one.
    assert.equal(sum(r.perDeviceMemory["0"]), SPLIT_PS.gpus[0].size_vram);
    assert.equal(sum(r.perDeviceMemory["1"]), SPLIT_PS.gpus[1].size_vram);
    // And the bands the chart actually draws carry that card's parts, never the model's total.
    const cap = { devices: [{ id: "0", totalBytes: 103e9, freeBytes: 30e9 }, { id: "1", totalBytes: 103e9, freeBytes: 32e9 }], host: null };
    const sample = { t: 1, models: [r], capacity: cap };
    const b0 = M.deviceBands(sample, "0").find((b) => b.model === "qwen3:235b");
    assert.equal(b0.parts.weights, 72044941148, "card 0 is decomposed by card 0's own figures");
    assert.equal(sum(b0.parts), b0.bytes, "…and they fill exactly the band they are inside");
});

// THE TERM THAT WOULD HAVE PUNISHED PRO-RATING. Weights and KV track the layer share, so a proportional
// guess is nearly right for them — but COMPUTE is a flat per-device cost. Forced 3:1 on `granite4.1:3b`,
// CUDA0 held 31 layers to CUDA1's 10 and both held 115 MiB of compute; on the real split above the two
// cards' figures are byte-identical. So a chart that divided a whole-model `compute` by a layer or byte
// ratio would be right about two buckets and quietly wrong about the third, and more wrong the more lopsided
// the split. Refusing to draw a split we were not given is what avoids that, and this is why.
test("compute is FLAT per device — the reason nothing is ever pro-rated", () => {
    const r = M.residencyFrom(SPLIT_PS);
    assert.equal(r.perDeviceMemory["0"].compute, r.perDeviceMemory["1"].compute,
        "identical compute on cards holding 72 GB and 70 GB of weights");
    // A byte-ratio guess would have put ~51% of the model's compute on card 0. The real answer is 50.0%,
    // which looks close here and diverges with the split: 3:1 by layers is still 1:1 by compute.
    const byRatio = r.memory.compute * (SPLIT_PS.gpus[0].size_vram / SPLIT_PS.size_vram);
    assert.notEqual(Math.round(byRatio), r.perDeviceMemory["0"].compute);

    // WITHOUT a per-card split there is nothing to draw, and that is the correct outcome rather than a gap
    // to fill: a multi-card model whose server reported only the whole-model figure decomposes into nothing.
    const noPerCard = M.residencyFrom({ ...SPLIT_PS, gpus: SPLIT_PS.gpus.map(({ memory, ...g }) => g) });
    assert.equal(noPerCard.perDeviceMemory, undefined);
    const cap = { devices: [{ id: "0", totalBytes: 103e9, freeBytes: 30e9 }, { id: "1", totalBytes: 103e9, freeBytes: 32e9 }], host: null };
    const band = M.deviceBands({ t: 1, models: [noPerCard], capacity: cap }, "0").find((b) => b.model);
    assert.equal(band.parts, undefined, "no split beats a pro-rated one");
    assert.equal(band.bytes, SPLIT_PS.gpus[0].size_vram, "…while the card's own TOTAL is still exact");
});

// A SPLIT IS NOT A SPILL. `memory_host` is populated only when something is on the HOST, so it is absent on a
// multi-card split — which has `size_total == size_vram`. The panel treats the two as different things.
test("a multi-card split carries no memory_host", () => {
    assert.equal(M.residencyFrom(SPLIT_PS).memoryHost, undefined);
    assert.equal(M.residencyFrom(SPLIT_PS).ramBytes, 0, "nothing on the host at all");
});

// A LOPSIDED SPLIT, which is where a proportional assumption would actually show. The captured `qwen3:235b`
// is 73.3 GB against 71.0 GB — near enough to equal that pro-rating would have passed on it, and the reason
// that capture alone is not sufficient evidence.
//
// The SHAPE here is measured (a forced 3:1 of `granite4.1:3b`: 31 layers against 10, and identical compute on
// both); the byte values are RECONSTRUCTED from the MiB the report gives, so the per-card totals are derived
// from the parts rather than quoted. That is the honest form for this test — what it checks is that we use
// each card's own figures, not that the server's rounding is right, and the latter has its own capture above.
const MiB = 1024 * 1024;
const LOPSIDED = (() => {
    const card = (id, weights, kv, compute) => {
        const memory = { weights: weights * MiB, kv_cache: kv * MiB, compute: compute * MiB };
        return { gpu_id: id, runner: "CUDA", size_vram: memory.weights + memory.kv_cache + memory.compute, memory };
    };
    const gpus = [card("0", 1380, 496, 115), card("1", 619, 144, 115)];
    const total = gpus[0].size_vram + gpus[1].size_vram;
    return {
        name: "granite4.1:3b", model: "granite4.1:3b", size: total, size_vram: total,
        memory: { weights: (1380 + 619) * MiB, kv_cache: (496 + 144) * MiB, compute: 230 * MiB },
        gpus,
    };
})();

test("an UNEQUAL split decomposes by each card's own figures, not by its share of the bytes", () => {
    const r = M.residencyFrom(LOPSIDED);
    const sum = (m) => m.weights + m.kvCache + m.compute + m.recurrentState + m.output + m.projector + m.other;
    assert.equal(sum(r.perDeviceMemory["0"]), LOPSIDED.gpus[0].size_vram);
    assert.equal(sum(r.perDeviceMemory["1"]), LOPSIDED.gpus[1].size_vram);

    const cap = { devices: [{ id: "0", totalBytes: 8e9, freeBytes: 6e9 }, { id: "1", totalBytes: 8e9, freeBytes: 7e9 }], host: null };
    const sample = { t: 1, models: [r], capacity: cap };
    const b0 = M.deviceBands(sample, "0").find((b) => b.model);
    const b1 = M.deviceBands(sample, "1").find((b) => b.model);

    // Each band is that card's own total, and its parts fill exactly it — on BOTH cards, at 2.2:1.
    assert.equal(b0.bytes, LOPSIDED.gpus[0].size_vram);
    assert.equal(b1.bytes, LOPSIDED.gpus[1].size_vram);
    assert.equal(sum(b0.parts), b0.bytes);
    assert.equal(sum(b1.parts), b1.bytes);

    // THE DISCRIMINATOR. A byte-ratio guess would put 69% of the model's compute on card 0; the truth is 50%,
    // because compute is flat per device. The bigger the imbalance the wider that gap, which is why an even
    // split cannot test this: at 50/50 the wrong answer and the right one coincide.
    const ratio = b0.bytes / (b0.bytes + b1.bytes);
    assert.ok(ratio > 0.65, `the fixture is genuinely lopsided (${(ratio * 100).toFixed(0)}% on card 0)`);
    assert.equal(b0.parts.compute, b1.parts.compute, "…and compute is still identical across it");
    assert.notEqual(Math.round(r.memory.compute * ratio), b0.parts.compute,
        "a pro-rated compute would differ from the real one here, which it does not at an even split");

    // The weights DO track the layer share, so the same test on weights alone would pass either way — which
    // is the trap: two of the three buckets forgive a proportional guess.
    assert.ok(b0.parts.weights > b1.parts.weights * 2, "weights follow the layers");
});

// LAYER PLACEMENT is opt-in on the server (`OLLAMA_LAYER_PLACEMENT=1`) and absent by default, so the parse
// has to answer "not reported" far more often than it answers with a value.
test("placementFrom: absent, unusable and real", () => {
    assert.equal(M.placementFrom(undefined), null, "absent is not zero");
    assert.equal(M.placementFrom(null), null);
    assert.equal(M.placementFrom({ num_layers: 95 }), null, "a total with no devices says nothing");
    assert.equal(M.placementFrom({ devices: [{ device: "CUDA0", layers: 4 }] }), null, "…and devices with no total");
    // A device entry carrying no layers is dropped rather than drawn as an empty run.
    assert.equal(M.placementFrom({ num_layers: 95, devices: [{ device: "CUDA0", layers: 0 }] }), null);

    const p = M.placementFrom({
        num_layers: 95,
        devices: [{ device: "CUDA0", first_layer: 0, last_layer: 47, layers: 48 },
                  { device: "CUDA1", first_layer: 48, last_layer: 94, layers: 47 }],
        swa_layers: [1, 3, 5],
    });
    assert.equal(p.numLayers, 95);
    assert.deepEqual(p.devices.map((d) => d.device), ["CUDA0", "CUDA1"]);
    assert.equal(p.devices[1].firstLayer, 48);
    assert.deepEqual(p.swaLayers, [1, 3, 5]);
});

// `devices` IS A LIST OF RUNS, not one entry per card — it is built by scanning consecutive layers, so a
// non-contiguous assignment appears as several entries rather than as a span that never existed. A consumer
// that read `devices.length` as a card count would be wrong here, which is why the panel sums by NAME.
test("placementFrom: several runs on one device stay several runs", () => {
    const p = M.placementFrom({
        num_layers: 12,
        devices: [{ device: "CUDA0", first_layer: 0, last_layer: 3, layers: 4 },
                  { device: "CUDA1", first_layer: 4, last_layer: 7, layers: 4 },
                  { device: "CUDA0", first_layer: 8, last_layer: 11, layers: 4 }],
    });
    assert.equal(p.devices.length, 3, "three runs, two cards");
    assert.equal(p.devices.filter((d) => d.device === "CUDA0").reduce((n, d) => n + d.layers, 0), 8);
});

// THE ENGINE'S NAME, NOT THE OLLAMA gpu_id. They are different fields and a filtered-device host can make
// them disagree, so nothing is reconciled here — the string is carried through as given.
test("placementFrom: the device name is carried through, never mapped", () => {
    const p = M.placementFrom({ num_layers: 2, devices: [{ device: "ROCm1", first_layer: 0, last_layer: 1, layers: 2 }] });
    assert.equal(p.devices[0].device, "ROCm1");
});

// THE WHOLE BOX ON ONE AXIS. Pools combine only at a cost (a split pays per-card overhead, a spill into RAM
// is slow), so they are laid END TO END rather than merged: each owns a band the height of its own capacity
// and fills it from its own floor, and the walls between them are what make that visible.
test("boxAxis: pools are laid end to end, and the total is real", () => {
    const a = M.boxAxis([{ id: "vram.0", ceiling: 96 }, { id: "vram.1", ceiling: 96 }, { id: "ram", ceiling: 128 }]);
    assert.equal(a.total, 320, "the axis total is the sum of real capacities");
    assert.deepEqual(a.bands.map((b) => [b.base, b.ceiling]), [[0, 96], [96, 96], [192, 128]]);
    // Each band starts where the previous one ended — the walls are the boundaries, and nothing crosses them.
    for (let i = 1; i < a.bands.length; i++) {
        assert.equal(a.bands[i].base, a.bands[i - 1].base + a.bands[i - 1].ceiling);
    }
});

test("boxAxis: hiding a pool shrinks the axis rather than leaving a hole", () => {
    // Which is what makes "just my two cards" a VIEW rather than arithmetic the reader has to do.
    const a = M.boxAxis([{ id: "vram.0", ceiling: 96 }, { id: "vram.1", ceiling: 96 }]);
    assert.equal(a.total, 192);
    assert.deepEqual(a.bands.map((b) => b.base), [0, 96]);
});

test("boxAxis: a pool with no capacity takes no band", () => {
    // A device whose total is unknown (the box has never answered /api/info) would otherwise take a
    // zero-height band and shift every wall above it by nothing, which is a band that cannot be pointed at.
    const a = M.boxAxis([{ id: "vram.0", ceiling: 96 }, { id: "unknown", ceiling: 0 }, { id: "ram", ceiling: 128 }]);
    assert.deepEqual(a.bands.map((b) => b.id), ["vram.0", "ram"]);
    assert.equal(a.total, 224);
});

// A GPU THE SERVER CAN SEE AND CANNOT USE. The failure this exists for is that a faulted card is not
// reported BROKEN, it is reported ABSENT: it vanishes from `supported_gpus`, so /api/ps looks normal,
// /api/info returns one healthy GPU, every number is internally consistent, and a two-GPU box with a dead
// card is byte-identical to a one-GPU box. One sat faulted for five and a half hours on the reference
// machine while the panel rendered perfectly and was silently wrong.
//
// The capture is real (mlbox, 2026-09-11, taken live while the GPU was faulted).
const FAULT_INFO = {
    compute: {
        system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12330946560 },
        supported_gpus: [
            { gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 101972967424, free_memory: 101972377600 },
        ],
        unavailable_gpus: [{
            pci_id: "0000:03:00.0",
            name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            uuid: "GPU-ea77999f-c55b-d5ed-bcae-71115e033a47",
            reason: "reset_required",
            detail: "GPU requires reset",
            recovery: "a cold power cycle: shut down, wait for the rails to drain, power on.",
            bus: { present: true, link_speed: "5.0 GT/s PCIe", link_width: 8, power_state: "D0",
                   max_link_speed: "32.0 GT/s PCIe", max_link_width: 16,
                   pcie_fatal_errors: 0, pcie_nonfatal_errors: 0 },
        }],
    },
};

test("unavailableFrom: a faulted card is carried, and never becomes a device", () => {
    const cap = M.parseInfo(FAULT_INFO);
    assert.equal(cap.devices.length, 1, "the faulted card is NOT a device — it is absent from the list");
    assert.equal(cap.unavailable.length, 1);
    const g = cap.unavailable[0];
    assert.equal(g.pciId, "0000:03:00.0");
    assert.equal(g.reason, "reset_required");
    assert.equal(g.detail, "GPU requires reset", "the DRIVER's own string, unparaphrased so it is searchable");
    assert.match(g.recovery, /cold power cycle/);

    // NEVER COUNTED TOWARD CAPACITY. These devices hold nothing and can hold nothing, which is why the
    // entry carries no memory fields at all — there is nothing here that could be summed by accident.
    assert.equal(cap.devices[0].totalBytes, 101972967424, "the ONE working card, and only it");
    assert.ok(!("totalBytes" in g) && !("freeBytes" in g), "a faulted card has no memory to report");
});

test("unavailableFrom: the shapes that are NOT a fault, and the ones with nothing to read", () => {
    // `not_offered_by_backend` is a HEALTHY card that answers every query and that no backend claimed —
    // usually CUDA_VISIBLE_DEVICES. A warning triangle there tells someone to reseat working hardware.
    const idle = M.unavailableFrom([{ pci_id: "0000:01:00.0", name: "CUDA1", reason: "not_offered_by_backend" }]);
    assert.equal(idle.length, 1, "still reported — the panel may want to say why a card is not in use");
    assert.equal(M.isGpuFault(idle[0]), false, "…but it is not a fault");
    assert.equal(M.isGpuFault({ reason: "reset_required" }), true);
    assert.equal(M.isGpuFault({ reason: "not_reported_by_driver" }), true);

    // `not_reported_by_driver`: the kernel enumerates the card and the driver does not describe it, so
    // there is no name and no uuid to read. They stay ABSENT rather than becoming empty strings — "" would
    // render as a nameless card instead of a card whose name is unknown.
    const mute = M.unavailableFrom([{ pci_id: "0000:03:00.0", reason: "not_reported_by_driver",
        detail: "the kernel enumerates this GPU but the driver does not report it",
        bus: { present: true, power_state: "D0", max_link_width: 16, pcie_fatal_errors: 0 } }]);
    assert.equal(mute[0].name, undefined);
    assert.equal(mute[0].uuid, undefined);
    assert.equal(mute[0].bus.present, true);

    // The PCI address is the IDENTITY — two cards in one machine share a `name` — so an entry without one
    // cannot be attributed and is dropped rather than drawn against the wrong card.
    assert.deepEqual(M.unavailableFrom([{ reason: "lost", name: "CUDA0" }]), []);
    // Absent, not-an-array and a stock server all mean the same thing here, and none of them mean "healthy".
    assert.deepEqual(M.unavailableFrom(undefined), []);
    assert.deepEqual(M.unavailableFrom("nope"), []);
    assert.deepEqual(M.parseInfo(CUDA_INFO).unavailable, [], "a server that says nothing reports nothing");
});

test("unavailableFrom: an AMD fault — no name, no uuid, and a reset in progress is not a dead card", () => {
    // The shape `gpuhealth5` serves for AMD: read from PCI sysfs rather than a vendor library, so there is no
    // name and no uuid, ever — keyed on `pci_id` like every other entry.
    const [busy, dead] = M.unavailableFrom([
        { pci_id: "0000:0c:00.0", reason: "reset_in_progress", detail: "EBUSY" },
        { pci_id: "0000:0d:00.0", reason: "unresponsive", detail: "ETIMEDOUT" },
    ]);
    assert.equal(busy.name, undefined);
    assert.equal(busy.uuid, undefined);
    assert.equal(M.isGpuFault(busy), true, "it cannot take work right now, so it is still reported");
    assert.equal(M.isGpuFault(dead), true);
    // A reset usually completes in seconds. Drawn identically to `reset_required` it sends someone to power-
    // cycle a machine that is fixing itself, so it carries a note saying when it stops being transient.
    assert.match(M.gpuFaultNote(busy), /usually clears within seconds/);
    assert.equal(M.gpuFaultNote(dead), null, "an unresponsive card gets the driver's words and nothing reassuring");
    assert.equal(M.gpuFaultNote({ reason: "reset_required" }), null);
});

test("a faulted card is an INCIDENT, not a different machine — the history survives it", () => {
    // This is the mid-session half. A card vanishing changes the device list, and if that read as "you
    // pointed at another box" the samples leading up to the fault — the most valuable ones on screen —
    // would be dropped at the exact moment they became evidence.
    const before = M.parseInfo(CUDA_INFO);            // two healthy cards
    const after = M.parseInfo(FAULT_INFO);            // one, and a fault report
    assert.equal(M.boxChange(before, after), "shrank", "a card that vanishes is an incident, not a switch");
    assert.notEqual(M.boxChange(before, after), "switched");
    // And coming back is equally not a switch: nothing measured before is invalidated by a card returning.
    assert.equal(M.boxChange(after, before), "grew");
});

// ---- GENERATIONS: prefill and decode from the engine's own durations (gen.end.timings) ----

test("genTimingsFrom: keeps the server's three cache states apart, and needs both durations", () => {
    // Taken from the real capture (tests/e2e/fixtures/events-gen-timings.json).
    const hit = M.genTimingsFrom({ prompt_tokens: 2223, prompt_tokens_cached: 2222, prompt_ms: 5.524, eval_ms: 528.904, decoded: 168 });
    assert.deepEqual(hit, { promptTokens: 2223, promptTokensCached: 2222, promptMs: 5.524, evalMs: 528.904, decoded: 168 });
    // `0` is a COLD prefill; ABSENT is "not reported". Collapsing them claims a measurement nobody made.
    assert.equal(M.genTimingsFrom({ prompt_ms: 99.567, eval_ms: 471.354, prompt_tokens_cached: 0 }).promptTokensCached, 0);
    assert.equal("promptTokensCached" in M.genTimingsFrom({ prompt_ms: 99.567, eval_ms: 471.354 }), false);
    // One duration without the other is a boundary with one side.
    assert.equal(M.genTimingsFrom({ prompt_ms: 5 }), null);
    assert.equal(M.genTimingsFrom({ eval_ms: 5 }), null);
    assert.equal(M.genTimingsFrom(null), null);
    assert.equal(M.genTimingsFrom({ prompt_ms: -1, eval_ms: 5 }), null, "a negative duration is not a duration");
});

test("genSpan: anchored at gen.end and built backwards, the remainder named as neither phase", () => {
    // The capture's first generation: gen.start at 14064, gen.end at 14648, prefill 99.567 ms, decode 471.354.
    const e = M.genSpan({ model: "gemma4:e2b", startAt: 14064, endAt: 14648, timings: { promptMs: 99.567, evalMs: 471.354, promptTokens: 2223, decoded: 152 } });
    assert.equal(e.kind, "gen");
    assert.equal(e.via, "server");
    assert.equal(e.t, 14064);
    assert.equal(e.until, 14648);
    const [other, prefill, decode] = e.phases;
    assert.equal(other.kind, "other");
    assert.equal(prefill.kind, "prefill");
    assert.equal(decode.kind, "decode");
    assert.ok(Math.abs(decode.until - 14648) < 1e-9, "decode ends at the end");
    assert.ok(Math.abs((decode.until - prefill.until) - 471.354) < 1e-9, "decode is the engine's eval_ms, exactly");
    assert.ok(Math.abs((prefill.until - other.until) - 99.567) < 1e-9, "prefill is the engine's prompt_ms, exactly");
    // The remainder is what is LEFT — 13 ms here, which matches what both ends measured independently.
    assert.ok(Math.abs((other.until - e.t) - 13.079) < 1e-6, `remainder ${other.until - e.t}`);
    assert.equal(e.gen.promptTokens, 2223, "the figures travel with the span, for the tooltip and the cache fill");
});

test("genSpan: a load inside the generation is not drawn twice, and nothing is invented without a start", () => {
    const timings = { promptMs: 161.6, evalMs: 115.7 };
    // Their capture: 2056 ms from gen.start to gen.end on a generation that included a LOAD, against 277 ms of
    // prefill + decode. The load is its own span, so the generation starts where the load ended.
    const loaded = M.genSpan({ model: "m", startAt: 10_000, endAt: 12_056, timings, loadEnd: 11_700 });
    assert.equal(loaded.t, 11_700, "starts where the load finished, not where the request took the runner");
    assert.equal(loaded.phases[0].kind, "other");
    // No gen.start (a reconnect mid-generation): prefill is the first thing drawn, and no remainder is made up.
    const noStart = M.genSpan({ model: "m", endAt: 12_056, timings });
    assert.deepEqual(noStart.phases.map((p) => p.kind), ["prefill", "decode"]);
    assert.ok(Math.abs(noStart.t - (12_056 - 277.3)) < 1e-9);
    // Two clocks disagreeing by more than the remainder (a start AFTER the prefill began): no remainder, and the
    // span still starts where the measured prefill does.
    const skew = M.genSpan({ model: "m", startAt: 11_900, endAt: 12_056, timings });
    assert.deepEqual(skew.phases.map((p) => p.kind), ["prefill", "decode"]);
    assert.ok(Math.abs(skew.t - (12_056 - 277.3)) < 1e-9);
});

test("sameMachineEvent: a generation is identified by its end and the engine's figures, never its start", () => {
    const timings = { promptMs: 14.89, evalMs: 17.948, decoded: 3 };
    const a = M.genSpan({ model: "g", startAt: 15_086, endAt: 15_121, timings });
    // The same edge replayed without its gen.start, landing a few ms off (each connection anchors on its own
    // hello): its START moved, and it is still the same generation.
    const replay = M.genSpan({ model: "g", endAt: 15_140, timings });
    assert.ok(M.sameMachineEvent(a, replay), "a replay that lost its start is still one generation");
    assert.equal(M.addMachineEvent([a], replay, 100).length, 1, "and is not added twice");
    // Two short generations of one model ending 40 ms apart (3-token calls take ~35 ms) are TWO.
    const next = M.genSpan({ model: "g", startAt: 15_125, endAt: 15_161, timings: { promptMs: 12.1, evalMs: 18.2, decoded: 3 } });
    assert.ok(!M.sameMachineEvent(a, next), "different figures, different generation");
});

test("joinGens: our own call is joined to its server generation, not drawn twice; other traffic stays", () => {
    const timings = { promptMs: 200, evalMs: 800, promptTokens: 4000, promptTokensCached: 3990, decoded: 64 };
    // A NON-STREAMED plain turn of ours: one `model` stretch, 1000..2400. Our finish stamp trails the server's
    // gen.end by the return leg of the network.
    const ours = { t: 1000, until: 2400, kind: "gen", label: "turn", model: "m", ref: { hash: "h1", seq: 1 } };
    const theirs = M.genSpan({ model: "m", startAt: 1100, endAt: 2350, timings });
    const other = M.genSpan({ model: "m", startAt: 9000, endAt: 10_000, timings: { promptMs: 50, evalMs: 500 } });
    const otherModel = M.genSpan({ model: "q", startAt: 1100, endAt: 2350, timings });
    const { session, server } = M.joinGens([ours], [theirs, other, otherModel]);
    assert.equal(server.length, 2, "the matched generation is dropped; the unmatched and the other model's stay");
    assert.ok(!server.includes(theirs));
    const j = session[0];
    assert.equal(j.ref.hash, "h1", "OUR block wins — it carries the click-through");
    assert.deepEqual(j.gen, timings, "and takes the engine's figures");
    // The single model stretch is split, anchored backwards from where the model work ended.
    assert.deepEqual(j.phases.map((p) => p.kind), ["other", "prefill", "decode"]);
    assert.equal(j.phases.at(-1).until, 2400);
    assert.equal(j.phases[1].until, 2400 - 800, "decode is the last eval_ms of our stretch");
    assert.equal(j.phases[0].until, 2400 - 800 - 200);
});

test("joinGens: a STREAMED call keeps its channels as the decode; only the pre-first-token stretch is split", () => {
    const timings = { promptMs: 300, evalMs: 900 };
    // model (pre-first-token) 0..500, then think and answer — the channels ARE the decode.
    const ours = { t: 0, until: 1500, kind: "gen", label: "turn", model: "m",
        phases: [{ kind: "model", until: 500 }, { kind: "think", until: 1000 }, { kind: "answer", until: 1500 }] };
    const theirs = M.genSpan({ model: "m", startAt: 100, endAt: 1450, timings });
    const j = M.joinGens([ours], [theirs]).session[0];
    assert.deepEqual(j.phases.map((p) => p.kind), ["other", "prefill", "think", "answer"]);
    assert.equal(j.phases[1].until, 500, "prefill ends where the first token arrived");
    assert.equal(j.phases[0].until, 200);
});

test("joinGens: a split that does not FIT is not drawn, and a far-off generation is not ours", () => {
    const timings = { promptMs: 900, evalMs: 900 };
    // Our stretch is 1000 ms; the engine's figures need 1800. A mis-join or a skewed clock — the figures still
    // attach, the phases are left alone rather than drawn outside the block.
    const ours = { t: 1000, until: 2000, kind: "gen", label: "turn", model: "m" };
    const j = M.joinGens([ours], [M.genSpan({ model: "m", endAt: 2000, timings })]).session[0];
    assert.deepEqual(j.gen, timings);
    assert.equal(j.phases, undefined, "no split drawn");
    // Beyond the tolerance: not ours, drawn as the server's own.
    const far = M.genSpan({ model: "m", endAt: 2000 + M.GEN_JOIN_TOLERANCE_MS + 1, timings: { promptMs: 10, evalMs: 10 } });
    const r = M.joinGens([ours], [far]);
    assert.equal(r.server.length, 1);
    assert.equal(r.session[0].gen, undefined);
    // Each side at most once: two of our turns cannot both claim one generation, and the NEAREST wins.
    const g = M.genSpan({ model: "m", endAt: 5000, timings: { promptMs: 10, evalMs: 10 } });
    const a = { t: 4000, until: 4990, kind: "gen", label: "a", model: "m" };
    const b = { t: 4100, until: 5400, kind: "gen", label: "b", model: "m" };
    const two = M.joinGens([a, b], [g]);
    assert.ok(two.session[0].gen && !two.session[1].gen, "the nearer turn takes it, the other gets nothing");
});

test("kvFill: what a generation left in the cache, as shares of its token capacity", () => {
    // The capture's cache hit: 2,223 prompt tokens, 2,222 of them reused, 168 decoded, in an 8,192 context.
    const hit = M.kvFill({ promptTokens: 2223, promptTokensCached: 2222, promptMs: 5.5, evalMs: 528.9, decoded: 168 }, 8192);
    assert.ok(Math.abs(hit.cached - 2222 / 8192) < 1e-12);
    assert.ok(Math.abs(hit.computed - 1 / 8192) < 1e-12, "one token actually computed");
    assert.ok(Math.abs(hit.decoded - 168 / 8192) < 1e-12);
    assert.equal(hit.prompt, undefined);
    assert.equal(hit.overflow, false);
    // 0 cached is a COLD prefill and splits as such; ABSENT is unknown and draws ONE prompt layer, unsplit.
    const cold = M.kvFill({ promptTokens: 4096, promptTokensCached: 0, promptMs: 99, evalMs: 400, decoded: 100 }, 8192);
    assert.equal(cold.cached, 0);
    assert.equal(cold.computed, 0.5);
    const unknown = M.kvFill({ promptTokens: 4096, promptMs: 99, evalMs: 400, decoded: 100 }, 8192);
    assert.equal(unknown.prompt, 0.5);
    assert.equal("cached" in unknown, false, "no guessed split");
    // The capacity covers every SLOT: the context is per slot, the reservation is for all of them.
    assert.equal(M.kvFill({ promptTokens: 4096, promptMs: 1, evalMs: 1, decoded: 0 }, 8192, 2).prompt, 0.25);
    // More tokens than the cache holds: the context SHIFTED. Scaled to fit and flagged, never drawn past the band.
    const shifted = M.kvFill({ promptTokens: 7000, promptTokensCached: 6000, promptMs: 1, evalMs: 1, decoded: 3000 }, 8192);
    assert.equal(shifted.overflow, true);
    assert.ok(Math.abs(shifted.cached + shifted.computed + shifted.decoded - 1) < 1e-12, "fills the band exactly");
    // Nothing to be a share OF, or no prompt count: nothing drawn.
    assert.equal(M.kvFill({ promptTokens: 10, promptMs: 1, evalMs: 1 }, 0), null);
    assert.equal(M.kvFill({ promptTokens: 10, promptMs: 1, evalMs: 1 }, null), null);
    assert.equal(M.kvFill({ promptMs: 1, evalMs: 1, decoded: 5 }, 8192), null);
});

// ---- TOPOLOGY: how the cards connect to each other. Run against the MOCKS in tests/fixtures/boxes.mjs, which
// are unverified against real NVLink hardware by agreement — see the note there. ----

test("topologyFrom: a pair list, normalised, with coverage checked against the server's promise", () => {
    const t = M.topologyFrom(TOPOLOGIES.rigAdjacent);
    assert.equal(t.status, "measured");
    assert.equal(t.links.length, 6, "4 cards → 6 unordered pairs");
    assert.deepEqual(t.missing, [], "every pair present");
    const nv = M.linkBetween(t, pci(1), pci(0));
    assert.equal(nv.type, "nvlink", "looked up in either direction");
    assert.equal(nv.linkCount, 4);
    assert.equal(nv.pciePath, "PHB", "the PCIe route under the bridge is kept");
    // A producer that emitted a pair from BOTH ends (KFD's io_links are directed) cannot double-count coverage.
    const [ga, gb] = TOPOLOGIES.pcie2.gpus;
    const doubled = M.topologyFrom({ ...TOPOLOGIES.pcie2, links: [...TOPOLOGIES.pcie2.links,
        { a: gb, b: ga, type: "pcie", path: "PHB" }, { a: ga, b: ga, type: "nvlink" }] });
    assert.equal(doubled.links.length, 1, "one pair, and no diagonal");
    // A pair the server simply OMITTED from a "measured" list is its bug — named, never read as PCIe.
    const gap = M.topologyFrom(TOPOLOGIES.missing);
    assert.deepEqual(gap.missing, [[pci(0), pci(2)], [pci(1), pci(2)]]);
    assert.equal(M.linkBetween(gap, pci(0), pci(2)), null);
    // Absent or unshaped is "not measured", which is null — never an empty topology that reads as "no NVLink".
    assert.equal(M.topologyFrom(undefined), null);
    assert.equal(M.topologyFrom({ links: [] }), null, "no status, no claim");
    // REAL (the server with NVML made unloadable): coverage STILL holds — the pair is there, `unknown`, with
    // the driver's words — which is what keeps "could not look" from reading as "no link".
    const un = M.topologyFrom(TOPOLOGIES.unavailable);
    assert.equal(un.status, "unavailable");
    assert.match(un.detail, /^NVML is not available: dlopen libnvidia-ml\.so\.1/, "the driver's own words");
    assert.deepEqual(un.missing, []);
    assert.equal(un.links[0].type, "unknown");
    // REAL: one visible GPU — measured, and there are no pairs to have.
    const one = M.topologyFrom(TOPOLOGIES.oneGpu);
    assert.equal(one.status, "measured");
    assert.deepEqual([one.links, one.missing], [[], []]);
});

test("the REAL /api/info capture: ceilings, pci_id and the PCIe pair, as gpubox serves them", async () => {
    const { readFileSync } = await import("node:fs");
    const info = JSON.parse(readFileSync(new URL("./fixtures/hw/info-ceilings-and-topology-2026-09-11.json", import.meta.url), "utf8"));
    const cap = M.parseInfo(info);
    const [c0, c1] = cap.devices;
    assert.equal(c0.pciId, "0000:01:00.0");
    assert.equal(c1.pciId, "0000:03:00.0");
    assert.equal(c0.memoryBandwidth, 1792128000000);
    assert.equal(c0.memoryBusWidthBits, 512);
    // x8, not the card's own x16: the narrower of card and slot, on a board that splits its lanes.
    assert.deepEqual([c0.pcieMaxGeneration, c0.pcieMaxWidth], [5, 8]);
    assert.equal(c0.utilization, undefined, "this capture predates utilization — absent, never 0");
    const l = M.linkBetween(cap.topology, c0.pciId, c1.pciId);
    assert.equal(l.bandwidthSource, "derived_from_pcie_link");
    // A DERIVED rate is a peak (measured peer-to-peer: 27.7 GB/s against 31.5 derived), and says so.
    assert.equal(M.linkPhrase(l), "PCIe, through the CPU's host bridge (PHB) · 31.5 GB/s peak");
    // Utilization, when present: each figure independent, 0 kept as idle, out-of-range dropped.
    const u = M.parseInfo({ ...info, compute: { ...info.compute, supported_gpus: [
        { ...info.compute.supported_gpus[0], utilization: { gpu_percent: 99, memory_percent: 90 } },
        { ...info.compute.supported_gpus[1], utilization: { gpu_percent: 0 } }] } });
    assert.deepEqual(u.devices.map((d) => d.utilization), [{ gpuPercent: 99, memoryPercent: 90 }, { gpuPercent: 0 }]);
});

test("rooflineFrom + decodeCeiling reproduce the server's own ceilings off the REAL split capture", async () => {
    const { readFileSync } = await import("node:fs");
    const cap = JSON.parse(readFileSync(new URL("./fixtures/hw/roofline-qwen3-32b-split-2026-09-11.json", import.meta.url), "utf8"));
    const r = M.rooflineFrom(cap.roofline);
    assert.equal(r.devices.length, 2);
    assert.equal(r.kvBytesPerToken, 262144);
    // Each run in the capture carries the ceiling the server computed at that occupancy; ours must match it.
    for (const run of cap.runs) {
        const c = M.decodeCeiling(r, run.occupancy);
        assert.ok(Math.abs(c - run.ceiling_at_occupancy) < 1e-9, `occupancy ${run.occupancy}: ${c} vs ${run.ceiling_at_occupancy}`);
    }
    // At 38k the ceiling falls to 60.4 from 90.7 empty — measured decode 48.6 is 80% of it, not 54%.
    const long = cap.runs.find((x) => x.label === "long");
    assert.ok(Math.abs(long.decode_tps / M.decodeCeiling(r, long.occupancy) - 0.8045) < 0.001);
    // The honest refusals: a reason instead of a number, and no number where a device has no KV rate.
    const moe = JSON.parse(readFileSync(new URL("./fixtures/hw/roofline-moe-lfm2.5-2026-09-11.json", import.meta.url), "utf8"));
    assert.deepEqual(M.rooflineFrom(moe.roofline), { unavailable: "mixture_of_experts" });
    assert.equal(M.decodeCeiling(M.rooflineFrom(moe.roofline), 100), null);
    const swa = M.rooflineFrom({ ...cap.roofline, devices: cap.roofline.devices.map(({ kv_bytes_per_context_token, ...d }) => d) });
    assert.equal(M.decodeCeiling(swa, 1000), null, "no KV rate → no figure, never the weights-only overstatement");
    assert.equal(M.rooflineFrom(undefined), null);
});

test("parseInfo: pci_id joins a drawn card to its links, and topology rides /api/info", () => {
    const info = { compute: { system_compute: { total_memory: 1e11, free_memory: 5e10, cpu_cores: 8 },
        supported_gpus: [
            { gpu_id: "0", pci_id: pci(0), name: "CUDA0", runner: "CUDA", total_memory: 2.5e10, free_memory: 2e10 },
            { gpu_id: "1", pci_id: pci(1), name: "CUDA1", runner: "CUDA", total_memory: 2.5e10, free_memory: 2e10 }],
        topology: { status: "measured", gpus: [pci(0), pci(1)], links: [{ a: pci(0), b: pci(1), type: "pcie", path: "PHB" }] } } };
    const cap = M.parseInfo(info);
    assert.deepEqual(cap.devices.map((d) => d.pciId), [pci(0), pci(1)]);
    assert.equal(M.linkBetween(cap.topology, cap.devices[0].pciId, cap.devices[1].pciId).type, "pcie");
    assert.equal(M.parseInfo({ compute: { system_compute: { total_memory: 1 }, supported_gpus: [] } }).topology, null);
});

test("bridgeOrder: directly-linked cards sit side by side, and only a measured topology reorders", () => {
    const cards = [0, 1, 2, 3].map((i) => ({ name: `CUDA${i}`, pciId: pci(i) }));
    const names = (t) => M.bridgeOrder(cards, M.topologyFrom(t)).map((c) => c.name);
    assert.deepEqual(names(TOPOLOGIES.rigAdjacent), ["CUDA0", "CUDA1", "CUDA2", "CUDA3"], "already adjacent");
    assert.deepEqual(names(TOPOLOGIES.rigCrossed), ["CUDA0", "CUDA2", "CUDA1", "CUDA3"], "reordered so each bridge has a wall");
    // Every wall of the reordered crossed rig: bridge, PCIe, bridge — the two pairs, and the line between them.
    const t = M.topologyFrom(TOPOLOGIES.rigCrossed);
    const order = M.bridgeOrder(cards, t);
    assert.deepEqual(order.slice(1).map((c, i) => M.isBridge(M.linkBetween(t, order[i].pciId, c.pciId))), [true, false, true]);
    // An all-to-all switch keeps the server's order, and every adjacent pair is a bridge.
    const eight = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `CUDA${i}`, pciId: pci(i) }));
    const sw = M.topologyFrom(TOPOLOGIES.nvswitch8);
    const swOrder = M.bridgeOrder(eight, sw);
    assert.deepEqual(swOrder.map((c) => c.name), eight.map((c) => c.name));
    assert.ok(swOrder.slice(1).every((c, i) => M.isBridge(M.linkBetween(sw, swOrder[i].pciId, c.pciId))));
    // A PARTIAL MESH (DGX-1): the ordering finds a chain in which every ADJACENT pair is linked (0-1-2-3-7-4-5-6),
    // so every wall is a bridge — true wall by wall, and drawn alone it would look exactly like the NVSwitch box.
    // `bridgeWalls` checks the run as a whole: the switch is a FULL mesh, the cube-mesh is PARTIAL, with the
    // pairs that are not linked named.
    const mesh = M.topologyFrom(TOPOLOGIES.dgx1);
    const meshWalls = M.bridgeWalls(M.bridgeOrder(eight, mesh), mesh);
    assert.ok(meshWalls.every((w) => w.bridge), "every adjacent pair of the chosen chain IS linked");
    assert.ok(meshWalls.every((w) => w.mesh === "partial"), "…and the run is marked partial, not a group of eight");
    assert.equal(meshWalls[0].unlinked.length, 28 - 16, "the 12 pairs of 28 with no direct link are named");
    const swWalls = M.bridgeWalls(swOrder, sw);
    assert.ok(swWalls.every((w) => w.bridge && w.mesh === "full" && !w.unlinked.length), "the switch is a full mesh");
    // Two bridged PAIRS are two full runs of two, with a solid wall between them.
    const rigWalls = M.bridgeWalls(order, t);
    assert.deepEqual(rigWalls.map((w) => w.mesh), ["full", null, "full"]);
    // Not measured → no bridges anywhere, whatever the links say.
    assert.ok(M.bridgeWalls(cards, M.topologyFrom(TOPOLOGIES.unavailable)).every((w) => !w.bridge && w.mesh === null));
    // Nothing measured → the server's order, untouched.
    assert.deepEqual(names(TOPOLOGIES.unavailable), cards.map((c) => c.name));
    assert.deepEqual(M.bridgeOrder(cards, null), cards);
});

test("linkPhrase: a link said plainly, in the vendor's own vocabulary", () => {
    const t = M.topologyFrom(TOPOLOGIES.rigAdjacent);
    assert.equal(M.linkPhrase(M.linkBetween(t, pci(0), pci(1))), "NVLink ×4 (NV4) · 112.5 GB/s");
    assert.equal(M.linkPhrase(M.linkBetween(t, pci(0), pci(2))), "PCIe, through the CPU's host bridge (PHB)");
    const p = M.topologyFrom(TOPOLOGIES.partial);
    assert.equal(M.linkPhrase(M.linkBetween(p, pci(1), pci(2))), "not classified: NVML did not report a path for this pair");
    assert.equal(M.linkPhrase({ a: "x", b: "y", type: "xgmi", linkCount: 2 }), "xGMI ×2");
});

test("utilization: its own series, its own preset where a card reports it, and never mixed with memory", () => {
    const sampleOf = (box) => ({ t: 1, capacity: M.parseInfo({ compute: {
        system_compute: { total_memory: box.hostTotal, free_memory: box.hostTotal / 2, cpu_cores: 16 },
        supported_gpus: box.devices.map((d) => ({ ...d, free_memory: d.total_memory / 2 })) } }), models: [] });
    // CUDA reports both figures; the AMD shape reports only GPU busy — still a series, still the preset.
    for (const name of ["cuda", "amd"]) {
        const s = sampleOf(BOXES[name]);
        const cat = M.seriesCatalog(s);
        assert.deepEqual(cat.filter((d) => d.scope === "util").map((d) => d.id), ["util.0", "util.1"], name);
        const act = M.presetsFor(s).find((p) => p.id === "activity");
        assert.ok(act, `${name}: Activity is offered where a card reports`);
        assert.deepEqual(act.tracks[0].series, ["util.0", "util.1"]);
        assert.equal(M.presetRefusal(act, s), null, "and the rule accepts what the preset proposes");
    }
    assert.deepEqual(M.parseInfo({ compute: { system_compute: { total_memory: 1 },
        supported_gpus: [{ ...BOXES.amd.devices[0], free_memory: 1 }] } }).devices[0].utilization, { gpuPercent: 40 }, "the absent figure stays absent");
    // A machine whose cards report nothing gets no series and no preset — a preset of lines that are never
    // drawn would read as an idle box.
    for (const name of ["laptop", "rig", "lab", "metal"]) {
        const s = sampleOf(BOXES[name]);
        assert.equal(M.seriesCatalog(s).some((d) => d.scope === "util"), false, name);
        assert.equal(M.presetsFor(s).some((p) => p.id === "activity"), false, name);
    }
    // THE RULES. A share of time never shares a track with a share of memory, in ANY mode; it never stacks;
    // and it has no capacity to lay end to end.
    const s = sampleOf(BOXES.cuda);
    const cat = M.seriesCatalog(s);
    const def = (id) => cat.find((d) => d.id === id);
    assert.match(M.kindRefusal([def("util.0"), def("vram.0")]), /share of TIME/);
    assert.equal(M.kindRefusal([def("util.0"), def("util.1")]), null);
    assert.equal(M.kindRefusal([def("vram.0"), def("ram")]), null);
    assert.match(M.stackRefusal([def("util.0")], s.capacity), /nothing here to add/);
    const mixed = { id: "x", label: "x", description: "", tracks: [{ id: "t", series: ["util.0", "vram.0"], mode: "overlay", heightPx: 96 }] };
    assert.match(M.presetRefusal(mixed, s), /share of TIME/, "a saved layout mixing them is refused at restore");
    const total = { ...mixed, tracks: [{ id: "t", series: ["util.0", "util.1"], mode: "total", heightPx: 96 }] };
    assert.match(M.presetRefusal(total, s), /no capacity to lay end to end/);
});

// ---- THE HOST-RAM PROMPT CACHE (`ollama-slop:promptcache2`), against the server's real captures ----
const ndjson = async (name) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(new URL(`./fixtures/hw/${name}-2026-09-11.ndjson`, import.meta.url), "utf8")
        .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};

test("prompt-cache swap: parsed off real gen.end frames, and drawn as a measured phase before the prefill", async () => {
    const restore = (await ndjson("prompt-cache-restore")).filter((f) => f.kind === "gen.end");
    // The first request switched nothing: no swap, no field.
    assert.equal(M.genTimingsFrom(restore[0].timings).swap, undefined);
    // THE CACHE WORKING: 500 ms moving the other conversation out and this one back, then a 23 ms prefill with
    // 6,515 of 6,537 tokens reused — the 500 ms is in no other timing.
    const t = M.genTimingsFrom(restore[3].timings);
    assert.deepEqual(t.swap, { ms: 499.75, restored: true, savedTokens: 6549, savedBytes: 1716860747 });
    assert.equal(t.promptTokensCached, 6515);
    const e = M.genSpan({ model: "qwen3:32b", endAt: 10_000, timings: t });
    assert.deepEqual(e.phases.map((p) => p.kind), ["swap", "prefill", "decode"]);
    const [swap, prefill, decode] = e.phases;
    assert.ok(Math.abs((decode.until - prefill.until) - 123.127) < 1e-9);
    assert.ok(Math.abs((prefill.until - swap.until) - 23.645) < 1e-9);
    assert.ok(Math.abs((swap.until - e.t) - 499.75) < 1e-9, "the swap is the engine's own measure");
    // THE THRASH: not restored, and conversations evicted to make room — every turn.
    const thrash = (await ndjson("prompt-cache-thrash")).filter((f) => f.kind === "gen.end").map((f) => M.genTimingsFrom(f.timings));
    assert.ok(thrash.slice(1).every((x) => x.swap.restored === false && x.swap.evicted > 0), "each later turn evicts");
    assert.deepEqual(thrash[2].swap, { ms: 1344, restored: false, savedTokens: 21635, savedBytes: 5671746535, evicted: 3, evictedBytes: 7421117333 });
    // `restored` is ALWAYS present on a swap; without it the object is not the swap this client understands.
    assert.equal(M.genTimingsFrom({ prompt_ms: 1, eval_ms: 1, prompt_cache_swap: { ms: 5 } }).swap, undefined);
});

test("prompt-cache swap: a joined call of ours gets the swap before its prefill", () => {
    const timings = { promptMs: 20, evalMs: 100, swap: { ms: 500, restored: true } };
    const ours = { t: 0, until: 1000, kind: "gen", label: "turn", model: "m" };
    const j = M.joinGens([ours], [M.genSpan({ model: "m", endAt: 990, timings })]).session[0];
    assert.deepEqual(j.phases.map((p) => p.kind), ["other", "swap", "prefill", "decode"]);
    assert.equal(j.phases[1].until, 1000 - 100 - 20);
    assert.equal(j.phases[0].until, 1000 - 100 - 20 - 500);
});

test("activityFrom: the host-RAM prompt cache, off a real sample — and it survives idle", async () => {
    const [sample] = (await ndjson("prompt-cache-occupancy-sample")).filter((f) => f.kind === "sample");
    const row = sample.ps.models.find((m) => m.name === "qwen3:32b");
    const a = M.activityFrom(row.activity);
    assert.deepEqual(a.promptCache, { entries: 2, tokens: 6582, bytes: 1725513596, limitBytes: 8589934592 });
    // The in-flight counts go at idle; the parked conversations do not — they really are still there.
    assert.deepEqual(M.activityFrom({ phase: "idle", prompt_cache: { entries: 1, tokens: 10, bytes: 100 } }).promptCache,
        { entries: 1, tokens: 10, bytes: 100 });
    assert.equal(M.activityFrom({ phase: "idle" }).promptCache, undefined, "absent until the first request — not an empty cache");
});

test("loadEdges: a server-split load rules its two steps through the plot, with what each moved", () => {
    const GiB = 1024 ** 3;
    // gemma4:31b off the user's dump: weights in after 1.0 s (17.37 GiB), KV cache and compute after 1.5 s more.
    const load = { t: 1000, until: 3517, kind: "load", label: "loading gemma4:31b", model: "gemma4:31b", via: "server",
        phases: [{ kind: "weights", until: 2002 }, { kind: "context", until: 3517 }], weightsBytes: 18654282383, loadBytes: 46006565599 };
    const [w, c] = M.loadEdges(load);
    assert.deepEqual([w.t, c.t], [2002, 3517], "at the two steps the device trace draws");
    assert.equal(w.until, undefined, "instants — rules, not spans");
    assert.match(w.label, /^gemma4:31b weights loaded \(17\.37 GiB\)$/);
    assert.match(c.label, /^gemma4:31b KV cache and compute buffers allocated \(25\.47 GiB\) — ready to serve$/);
    assert.equal(w.via, "server");
    // An inferred load has no boundary, so no rules: a rule is a claim about WHEN something happened.
    assert.deepEqual(M.loadEdges({ t: 0, until: 5000, kind: "load", label: "x", model: "m" }), []);
    assert.deepEqual(M.loadEdges({ t: 0, kind: "evict", label: "x", model: "m" }), []);
    // Bytes unreported → the edges still say what they are.
    assert.match(M.loadEdges({ ...load, weightsBytes: undefined, loadBytes: undefined })[1].label, /allocated — ready to serve$/);
    void GiB;
});

test("the axis is LINEAR IN TIME on an adaptive cadence: an event, a sample and the crosshair agree", () => {
    // The stream samples every 250 ms during a load and every 15 s idle. The axis used to space samples evenly,
    // so the load's one second took four fifths of the run and the 15 s idle stretch one fifth — the chart
    // compressed at random as the mix of samples in view changed, and an unload was ruled over a band that was
    // still resident. Linear in time, 8 s into a 15.75 s run is 8/15.75 of the way, wherever the samples fall.
    const run = [{ t: 0 }, { t: 250 }, { t: 500 }, { t: 750 }, { t: 15_750 }];
    const [p] = M.placeEvents([run], [{ t: 8000, kind: "evict", label: "unloaded" }]);
    assert.ok(Math.abs(p.from - 8000 / 15_750) < 1e-12, `placed at ${p.from}`);
    // A sample's position is its time's position — the same mapping the bands are drawn with (`runFrac`).
    assert.equal(M.runFrac(run, 750), 750 / 15_750);
    // The crosshair's time and the placement round-trip exactly.
    assert.ok(Math.abs(M.timeAtFraction([run], p.from) - 8000) < 1e-9);
    // The DATAPOINT under a position is the one nearest in TIME — at 8 s, sample 750 (7.25 s away) rather than
    // 15 750 (7.75 s away) — and snapping lands exactly on where that sample is drawn.
    assert.equal(M.sampleAtFraction([run], p.from).t, 750);
    const snap = M.snapFraction([run], p.from);
    assert.deepEqual([snap.index, snap.frac], [3, 750 / 15_750]);
    // A run is as wide as it is LONG: a 1 s run beside a 3 s one takes a quarter of the width.
    assert.deepEqual([M.runWeight([{ t: 0 }, { t: 1000 }]), M.runWeight([{ t: 0 }, { t: 3000 }]), M.runWeight([{ t: 5 }])], [1000, 3000, 1]);
});

test("pendingAllocation: a loading model's memory is its own before the runner exists to say so", () => {
    const GiB = 1024 ** 3;
    const other = (b) => ({ key: "other", label: "driver overhead", kind: "other", bytes: b });
    const model = (b) => ({ key: "model:m", label: "m", kind: "model", model: "m", bytes: b });
    // Driver context 0.6 GiB; a load from t=1000 to t=3500 lands weights then context in the residual; at t=4000
    // the runner exists and the model's band takes it over.
    const times = [0, 1000, 2000, 3000, 3500, 4000];
    const frames = [[other(0.6 * GiB)], [other(0.6 * GiB)], [other(4 * GiB)], [other(10 * GiB)], [other(12.6 * GiB)], [other(0.6 * GiB), model(12 * GiB)]];
    const got = M.pendingAllocation(frames, times, "m", [{ t: 1000, until: 3500 }]);
    assert.deepEqual(got.map((b) => b / GiB).map((x) => Math.round(x * 10) / 10), [0, 0, 3.4, 9.4, 12, 0],
        "the growth above the pre-load residual, until the model's own band appears — never both");
    // No load of this model (the caller passes that model's loads only): nothing is attributed to it.
    assert.deepEqual(M.pendingAllocation(frames, times, "m", []), [0, 0, 0, 0, 0, 0]);
});

// RUNNER PIDS, against real captures off the box (`ollama-slop:runnerpids2`). The driver's list of processes
// on each card, joined to ollama's runners by pid, is what lets the residual be NAMED rather than guessed.
const hwJson = (name) => JSON.parse(readFileSync(new URL(`./fixtures/hw/${name}`, import.meta.url), "utf8"));

test("parseInfo: a card's processes, and the scope that says what the list CAN contain", () => {
    const cap = M.parseInfo(hwJson("runner-pids-other-processes-2026-09-11.json"));
    const [c0, c1] = cap.devices;
    assert.equal(c0.processesScope, "pid_namespace");
    assert.deepEqual(c0.processes, [{ pid: 317, usedBytes: 6348079104, name: "llama-server", runner: { model: "qwen3.5:0.8b", loading: false }, helper: false }]);
    // A llama-server started by hand inside ollama's container: listed and named, and neither a runner nor a helper.
    assert.deepEqual(c1.processes, [{ pid: 417, usedBytes: 3164602368, name: "llama-server", helper: false }]);
    // A scope with NO list is an empty list (the server omits an empty array) — a reading, not an absence.
    const idle = M.parseInfo(hwJson("runner-pids-context-band-2026-09-11.json").info);
    assert.ok(idle.devices.every((d) => Array.isArray(d.processes)));
    const bare = M.parseInfo({ compute: { system_compute: { total_memory: 8e9 }, supported_gpus: [{ gpu_id: "0", runner: "CUDA", total_memory: 4e9, free_memory: 3e9, processes_scope: "pid_namespace" }] } });
    assert.deepEqual([bare.devices[0].processes, bare.devices[0].processesScope], [[], "pid_namespace"]);
    // An older build reports neither, and nothing is invented for it.
    assert.equal("processes" in M.parseInfo(CUDA_INFO).devices[0], false);
});

test("deviceBands: a runner's overhead is measured per runner, and is not a constant", () => {
    const { ps, info } = hwJson("runner-pids-context-band-2026-09-11.json");
    const sample = { t: 1, capacity: M.parseInfo(info), models: ps.models.map(M.residencyFrom) };
    const ctx = (id, model) => M.deviceBands(sample, id).find((b) => b.key === `ctx:${model}`);
    // used_memory minus the model's size_vram on that card, both from the same instant.
    assert.equal(ctx("0", "qwen3.5:0.8b").bytes, 6348079104 - 5883004189);
    assert.equal(Math.round(ctx("0", "qwen3.5:0.8b").bytes / MiB), 444);
    assert.equal(Math.round(ctx("1", "granite4.1:3b").bytes / MiB), 633);
    assert.equal(ctx("1", "granite4.1:3b").of, "granite4.1:3b", "tinted with its model, never the model's identity");
    assert.equal(ctx("1", "granite4.1:3b").model, undefined);
    // Every byte in use is accounted for exactly once: the model, its runner's overhead, and what nothing lists.
    const b0 = M.deviceBands(sample, "0");
    const used = info.compute.supported_gpus[0].total_memory - info.compute.supported_gpus[0].free_memory;
    assert.equal(b0.filter((b) => b.kind !== "free").reduce((n, b) => n + b.bytes, 0), used);
    const rest = b0.find((b) => b.key === "other");
    assert.equal(rest.label, M.OUTSIDE_VIEW_LABEL, "in a container, the unlisted remainder is not called overhead");
    assert.equal(rest.bytes, used - 6348079104);
});

test("deviceBands: a process ollama cannot see is named as unseen, and one it can see as a tenant", () => {
    const raw = hwJson("runner-pids-other-processes-2026-09-11.json");
    const sample = { t: 1, capacity: M.parseInfo(raw), models: [] };
    const bands = M.deviceBands(sample, "1");
    const g = raw.compute.supported_gpus[1];
    const tenant = bands.find((b) => b.key === "proc:417");
    assert.deepEqual([tenant.label, tenant.bytes], ["llama-server (pid 417)", 3164602368]);
    // The other container's torch process is NOT listed; the gap between the listed memory and what is in use
    // is exactly it (~2.6 GB, measured on the host with nvidia-smi).
    const unseen = bands.find((b) => b.key === "other");
    assert.equal(unseen.label, M.OUTSIDE_VIEW_LABEL);
    assert.equal(unseen.bytes, g.total_memory - g.free_memory - 3164602368);
    assert.ok(unseen.bytes > 2.5 * 1024 ** 3);
    // With every process listed (`all`), what is left owns no process: the driver's own.
    const all = structuredClone(raw);
    for (const d of all.compute.supported_gpus) d.processes_scope = "all";
    assert.equal(M.deviceBands({ t: 1, capacity: M.parseInfo(all), models: [] }, "1").find((b) => b.key === "other").label, M.DRIVER_BAND_LABEL);
});

test("deviceBands: through a load, helpers are not tenants and the loading runner IS the allocation", () => {
    // Every process entry one 100 ms poll saw across one load, each placed alone on a one-card box.
    const lines = readFileSync(new URL("./fixtures/hw/runner-pids-during-load-2026-09-11.ndjson", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const TOTAL = 101972967424;
    const at = (p) => ({ t: 1, models: [], capacity: M.parseInfo({ compute: { system_compute: { total_memory: 8e9 },
        supported_gpus: [{ gpu_id: "0", runner: "CUDA", total_memory: TOTAL, free_memory: TOTAL - p.used_memory, processes_scope: "pid_namespace", processes: [p] }] } }) });
    const kinds = lines.map((p) => M.deviceBands(at(p), "0").find((b) => b.kind === "other" && b.bytes > 0).key);
    // The fit probe (`llama-server`) and device discovery (`ollama`) are ollama's own, and never read as a stranger.
    assert.ok(!kinds.some((k) => k.startsWith("proc:")), `no helper drawn as a tenant: ${kinds}`);
    assert.equal(kinds.filter((k) => k === "helper").length, lines.filter((p) => p.ollama_helper).length);
    // The runner is the load until its load returns, drawn whole — /api/ps has no figures to subtract yet.
    const loading = lines.filter((p) => p.runner?.loading);
    assert.ok(loading.length >= 5);
    for (const p of loading) {
        const b = M.deviceBands(at(p), "0").find((x) => x.key === "load:qwen3.5:0.8b");
        assert.equal(b.bytes, p.used_memory);
    }
    // …and pendingAllocation reads it directly: the process's memory, not the residual's growth.
    const frames = loading.map((p) => M.deviceBands(at(p), "0"));
    assert.deepEqual(M.pendingAllocation(frames, frames.map((_, i) => i), "qwen3.5:0.8b", []), loading.map((p) => p.used_memory));
    // Once it is resident but /api/ps has not caught up, it is the model's runner — not gigabytes of "overhead".
    const done = lines.at(-1);
    assert.equal(M.deviceBands(at(done), "0").find((b) => b.kind === "other" && b.bytes > 0).key, "runner:qwen3.5:0.8b");
});

test("deviceBands: a process list with no scope is an EARLIER build's, and names nothing", () => {
    // tests/e2e/fixtures/events-load-lifecycle.json was recorded on a build that listed bare `{pid, used_memory}`
    // entries — no scope, no runner marks — so pid 956 is ollama's own runner and must not become a tenant.
    const frames = JSON.parse(readFileSync(new URL("./e2e/fixtures/events-load-lifecycle.json", import.meta.url), "utf8"));
    const f = frames.filter((x) => x.kind === "sample" && x.info).at(-1);
    const sample = { t: 1, capacity: M.parseInfo(f.info), models: (f.ps?.models || []).map(M.residencyFrom) };
    const bands = M.deviceBands(sample, "0");
    assert.ok(!bands.some((b) => b.key.startsWith("proc:")), `no tenant invented: ${bands.map((b) => b.key)}`);
    assert.notEqual(bands.find((b) => b.key === "other").label, M.OUTSIDE_VIEW_LABEL, "and the size rule still names the residual");
});

test("estimateFrom: the predictor's figures off a real estimate frame, and nothing without a total", () => {
    const frames = JSON.parse(readFileSync(new URL("./e2e/fixtures/events-gen-timings.json", import.meta.url), "utf8"));
    const f = frames.find((x) => x.kind === "estimate" && x.estimate.source === "calibration" && /gemma4:e2b/.test(x.model));
    assert.deepEqual(M.estimateFrom(f.estimate), {
        predicted: 4639812484, forLoad: 6787296132, source: "calibration", numCtx: 131072, numGpu: 1, numBatch: 2048,
        metadataComplete: false, weights: 2448863116, kvCache: 9395240960,
    });
    // `compute: 0` in the breakdown is "not modelled", so it is not carried as a prediction of nothing.
    assert.equal("compute" in M.estimateFrom(f.estimate), false);
    assert.equal(M.estimateFrom({ source: "metadata" }), null);
    assert.equal(M.estimateFrom(null), null);
});

test("quantPlain: a quantization code in words, integer and float kept apart, unknown left alone", () => {
    assert.equal(M.quantPlain("Q4_K_M").short, "4-bit weights");
    assert.match(M.quantPlain("Q4_K_M").detail, /4-bit integers with a scale per block \(a K-quant, medium mix/);
    assert.equal(M.quantPlain("q8_0").short, "8-bit weights");
    assert.match(M.quantPlain("Q4_1").detail, /and an offset/);
    // A float is a float: MXFP4 is not "4-bit weights" in the integer sense, and BF16 is not quantized at all.
    assert.equal(M.quantPlain("MXFP4").short, "4-bit floats");
    assert.match(M.quantPlain("BF16").detail, /unquantized/);
    assert.equal(M.quantPlain("IQ4_XS").short, "~4-bit weights");
    assert.equal(M.quantPlain("TQ1_0"), null, "a code it does not know is shown as itself, not guessed at");
});

test("loadTrace: through a real load, the runner's peak beside where it settled", () => {
    // Every runner reading a 100 ms poll saw across one load (fixtures/hw), each on card 0 of a box that
    // lists processes, after a baseline reading from before the load began.
    const lines = readFileSync(new URL("./fixtures/hw/runner-pids-during-load-2026-09-11.ndjson", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const TOTAL = 101972967424, BASE = 600 * MiB;
    const cap = (procs, used) => M.parseInfo({ compute: { system_compute: { total_memory: 8e9 },
        supported_gpus: [{ gpu_id: "0", runner: "CUDA", total_memory: TOTAL, free_memory: TOTAL - used, processes_scope: "pid_namespace", processes: procs }] } });
    const samples = [{ t: 0, models: [], capacity: cap([], BASE) },
        ...lines.map((p, i) => ({ t: 100 * (i + 1), models: [], capacity: cap([p], BASE + p.used_memory) }))];
    const end = 100 * lines.length - 50;   // the edge lands between the last loading reading and the resident one
    const tr = M.loadTrace(samples, { t: 50, until: end, model: "registry.ollama.ai/library/qwen3.5:0.8b" });
    assert.equal(tr.basis, "runner", "the runner is listed, so its own memory is the measure");
    assert.deepEqual(tr.cards, ["0"]);
    assert.equal(tr.baseline["0"], BASE);
    assert.equal(tr.peak.bytes, 6348079104);
    assert.equal(tr.final.bytes, 6348079104);
    // Helpers are not the runner: the fit probe's and discovery's memory is not counted as this load's.
    assert.ok(tr.points.slice(0, 4).every((p) => p.bytes === 0), `before the runner exists: ${tr.points.slice(0, 4).map((p) => p.bytes)}`);
    // No sample before the load: nothing to measure growth from.
    assert.equal(M.loadTrace(samples.slice(1), { t: 50, until: end, model: "qwen3.5:0.8b" }), null);
});

test("loadTrace: with no runner to read, the cards' growth — peak above where it settled", () => {
    const cap = (used0) => M.parseInfo({ compute: { system_compute: { total_memory: 8e9 },
        supported_gpus: [{ gpu_id: "0", runner: "CUDA", total_memory: 100 * GB, free_memory: 100 * GB - used0 }, { gpu_id: "1", runner: "CUDA", total_memory: 100 * GB, free_memory: 100 * GB }] } });
    const s = (t, used) => ({ t, models: [], capacity: cap(used) });
    // 1 GB before; the load overshoots to 14 GB (a transient buffer) and settles at 11.
    const tr = M.loadTrace([s(0, 1 * GB), s(1000, 5 * GB), s(2000, 15 * GB), s(3000, 12 * GB)], { t: 500, until: 2500, model: "m" });
    assert.equal(tr.basis, "device");
    assert.deepEqual(tr.cards, ["0"], "only the card that grew");
    assert.deepEqual([tr.peak.bytes, tr.final.bytes], [14 * GB, 11 * GB]);
    // A box that LISTS processes but not this model's runner (another tenant only) is still measured, by the
    // cards' growth — reading the absent runner as zero bytes would record a load that took nothing.
    const scoped = (used0) => { const c = cap(used0); c.devices[0].processesScope = "pid_namespace"; c.devices[0].processes = [{ pid: 9, usedBytes: 1 * GB, helper: false }]; return c; };
    const t2 = M.loadTrace([0, 1000, 2000, 3000].map((t, i) => ({ t, models: [], capacity: scoped([1, 5, 15, 12][i] * GB) })), { t: 500, until: 2500, model: "m" });
    assert.equal(t2.basis, "device");
    assert.equal(t2.peak.bytes, 14 * GB);
});

test("gridStep: the smallest round interval that keeps the lines apart at a track's width", () => {
    assert.equal(M.gridStep(30_000), 5_000, "30 s across 300 px: a line every 5 s is 50 px apart");
    assert.equal(M.gridStep(300_000), 60_000, "five minutes: one a minute");
    assert.equal(M.gridStep(300_000, 1200), 15_000, "a wider track affords a finer grid");
    assert.equal(M.gridStep(1e12), M.GRID_STEPS_MS.at(-1), "past the last step, the last step");
});

test("gridTimes: on the LOCAL clock's round multiples, and only inside the run it is given", () => {
    const start = new Date(2026, 8, 12, 10, 4, 7, 300).getTime();   // 10:04:07.300 local
    const run = [{ t: start }, { t: start + 95_000 }];
    const times = M.gridTimes(run, 30_000);
    assert.deepEqual(times.map((t) => { const d = new Date(t); return `${d.getMinutes()}:${d.getSeconds()}.${d.getMilliseconds()}`; }),
        ["4:30.0", "5:0.0", "5:30.0"], "on the half-minute, by the clock on the wall");
    assert.ok(times.every((t) => t >= run[0].t && t <= run[1].t));
    assert.deepEqual(M.gridTimes([{ t: start }], 30_000), [], "one sample is not a stretch of time");
});

test("ribbonSpans: a card's timed generation phases, on every card the model is on and no other", () => {
    const res = (model, perDevice) => ({ model, vramBytes: 10 * GB, ramBytes: 0, perDevice, contextLength: 8192, expiresAt: null });
    const samples = [{ t: 0, models: [res("split:70b", { 0: 6 * GB, 1: 4 * GB }), res("small:3b", { 1: 3 * GB })] },
                     { t: 10_000, models: [res("split:70b", { 0: 6 * GB, 1: 4 * GB }), res("small:3b", { 1: 3 * GB })] }];
    // A server generation (engine-timed) and one of OUR agent steps (streamed channels + a tool running).
    const gen = { t: 1000, until: 3000, kind: "gen", label: "", model: "registry.ollama.ai/library/split:70b",
        phases: [{ kind: "other", until: 1100 }, { kind: "prefill", until: 1500 }, { kind: "decode", until: 3000 }] };
    const step = { t: 4000, until: 9000, kind: "tool", label: "", model: "small:3b",
        phases: [{ kind: "model", until: 4500 }, { kind: "think", until: 6000 }, { kind: "call", until: 6500 }, { kind: "tool", until: 9000 }] };
    const on0 = M.ribbonSpans([gen, step], samples, "0", 2);
    assert.deepEqual(on0, [{ t: 1100, until: 1500, kind: "prefill", model: "split:70b" }, { t: 1500, until: 3000, kind: "decode", model: "split:70b" }],
        "the split model's work on its first card; the small model is not on this card");
    const on1 = M.ribbonSpans([gen, step], samples, "1", 2);
    assert.equal(on1.filter((s) => s.model === "split:70b").length, 2, "…and on its second, since a split model works on both");
    assert.deepEqual(on1.filter((s) => s.model === "small:3b").map((s) => s.kind), ["think", "call"],
        "our own streamed channels ARE the decode; the undifferentiated stretch and the tool running are not drawn");
    // One card needs no attribution: the model's whole footprint is on it.
    assert.equal(M.ribbonSpans([step], [{ t: 5000, models: [res("small:3b", {})] }], "0", 1).length, 2);
    // A model no sample places anywhere (off-box, or not loaded) draws on no card.
    assert.deepEqual(M.ribbonSpans([{ ...gen, model: "cloud:xl" }], samples, "0", 2), []);
});

test("AMD's fabric (xGMI) is a bridge like NVLink: a pair, a full mesh, and said in AMD's own words", () => {
    // MOCKS (tests/fixtures/boxes.mjs): no AMD topology has been captured yet.
    const pair = M.topologyFrom(TOPOLOGIES.amdBridged);
    const link = M.linkBetween(pair, pci(0), pci(1));
    assert.equal(M.isBridge(link), true);
    assert.equal(M.linkPhrase(link), "xGMI ×1 (XGMI) · 64.0 GB/s", "the AMD driver's rate is not a PCIe peak, so it is not marked as one");
    // Eight MI300X, every pair linked with no switch: one fully bridged group, every wall a bridge.
    const mesh = M.topologyFrom(TOPOLOGIES.xgmi8);
    const walls = M.bridgeWalls([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ pciId: pci(i) })), mesh);
    assert.ok(walls.every((w) => w.bridge && w.mesh !== "partial"), JSON.stringify(walls));
});

test("naming a card: its description, the label a faulted one had, and what each address was last seen as", () => {
    const cap = M.parseInfo({ compute: { system_compute: { total_memory: 8e9 }, supported_gpus: [
        { gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 4e9, free_memory: 4e9, pci_id: "0000:01:00.0", description: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition" },
        { gpu_id: "1", name: "CUDA1", runner: "CUDA", total_memory: 4e9, free_memory: 4e9, pci_id: "0000:03:00.0" }] } });
    assert.equal(cap.devices[0].description, "NVIDIA RTX PRO 6000 Blackwell Workstation Edition");
    assert.equal("description" in cap.devices[1], false, "absent stays absent — never derived from `name`");
    // The server's own memory of a faulted card's label, when it sends it.
    assert.equal(M.unavailableFrom([{ pci_id: "0000:03:00.0", reason: "reset_required", last_name: "CUDA1" }])[0].lastName, "CUDA1");
    assert.equal("lastName" in M.unavailableFrom([{ pci_id: "0000:03:00.0", reason: "reset_required" }])[0], false);
    // What each bus address was last seen as — the same object back when nothing changed, so it can gate a write.
    const seen = M.noteSeenCards({}, cap);
    assert.deepEqual(seen, { "0000:01:00.0": { name: "CUDA0", description: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition" }, "0000:03:00.0": { name: "CUDA1" } });
    assert.equal(M.noteSeenCards(seen, cap), seen);
    // After CUDA1 faults, the survivor is still CUDA0 — and the faulted address keeps what it was last seen as.
    const after = M.noteSeenCards(seen, { ...cap, devices: [cap.devices[0]] });
    assert.equal(after["0000:03:00.0"].name, "CUDA1");
});
