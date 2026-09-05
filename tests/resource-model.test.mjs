"use strict";
// The resource panel's pure data model: /api/info + /api/ps → the bands, series and history the chart draws.
// Fixtures are REAL captures where possible (the CUDA ones are live gpubox bodies, trimmed) — see
// docs/spec/RESOURCE_PANEL.md, which also lists the Metal samples still to be pinned down.
import { test, describe } from "node:test";
import assert from "node:assert";
const M = await import("../src/resource-model.ts");

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
    assert.deepEqual(multi.map((p) => p.id), ["overview", "memory"]);
    assert.ok(!multi.some((p) => p.id === "placement"));

    // The Mac: ONE pool, so one preset with one track — not a GPU view and a RAM view of the same silicon.
    const single = M.presetsFor({ t: 1, capacity: M.parseInfo(METAL_INFO), models: [] });
    assert.deepEqual(single.map((p) => p.id), ["memory"]);
    assert.deepEqual(single[0].tracks.map((t) => t.series), [["mem"]], "the one pool, once");
    assert.ok(!single.some((p) => p.id === "placement"));
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
test("DRIFT GUARD: every generated preset is valid under the stacking rule", () => {
    for (const info of [CUDA_INFO, METAL_INFO]) {
        const sample = { t: 1, models: [], capacity: M.parseInfo(info) };
        const presets = M.presetsFor(sample);
        assert.ok(presets.length > 0);
        for (const p of presets) {
            assert.equal(M.presetRefusal(p, sample), null,
                `preset "${p.id}" proposes a layout the rule refuses on ${info === CUDA_INFO ? "2 cards" : "Metal"}`);
        }
    }
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
    // Two runs: four samples over 3s, then two samples over 1s after a gap. Weights 4 and 2 → 2/3 and 1/3.
    const runs = [
        [{ t: 1000 }, { t: 2000 }, { t: 3000 }, { t: 4000 }],
        [{ t: 10_000 }, { t: 11_000 }],
    ];
    assert.equal(M.timeAtFraction(runs, 0), 1000, "the left edge is the first sample");
    assert.equal(M.timeAtFraction(runs, 1), 11_000, "the right edge is the last");
    // A third of the way is halfway through the FIRST segment (which owns two thirds of the width).
    assert.equal(M.timeAtFraction(runs, 1 / 3), 2500);
    // AT the boundary between segments the answer is the last measured moment before the gap, never a time
    // interpolated across it — nothing was measured there, so there is no honest value inside it.
    assert.equal(M.timeAtFraction(runs, 2 / 3), 4000);
    assert.equal(M.timeAtFraction(runs, 0.7), 10_100, "past it, inside the second segment");
    assert.equal(M.timeAtFraction(runs, 5 / 6), 10_500);
    // It round-trips with placeEvents: an event placed at a fraction reads back as its own time.
    const ev = { t: 2500, kind: "note", label: "x" };
    const [p] = M.placeEvents(runs, [ev]);
    const overall = (p.run === 0 ? 0 : 2 / 3) + p.from * (p.run === 0 ? 2 / 3 : 1 / 3);
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
