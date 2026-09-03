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
