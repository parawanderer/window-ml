// The RENDERABLE model behind the resource panel (VRAM / RAM over time). Pure — no DOM, no chrome, no preact
// — so the chart is a function of this and every derivation is unit-testable without mounting anything.
//
// It normalizes two Ollama endpoints into one shape:
//   • /api/info → CAPACITY (per-device totals + free, system RAM). Changes slowly; absent on stock Ollama.
//   • /api/ps   → RESIDENCY (which models are loaded, how much each holds, on which devices). Polled.
//
// Three hard-won facts from the backend work drive the whole design (tmp/vram-gauge-handover.md):
//   1. A device's `free` is NOT "capacity minus our models" — non-Ollama processes hold VRAM too (a live box
//      showed 18 GB held on card 0 with `models.running: 0`). So a device decomposes into THREE bands —
//      attributed / other / free — never two.
//   2. Per-device attribution is wrong on the currently deployed server for placements that don't start at
//      card 0: it reports 0 per device while the total is right. A per-device 0 under a non-zero total is
//      therefore UNKNOWN, never zero, and must render as such.
//   3. Metal is UNIFIED memory: the device "total" is a recommended working set that OVERLAPS system RAM, so
//      device and host capacity must never be summed. `runner` is the discriminator.

// --- rendering ------------------------------------------------------------------------------------------
// EVERY memory figure this API returns is raw bytes, and every one of them is BINARY. GPU and system memory
// are sold and reported in binary units while spelled "GB", so a card sold as 96GB really is 96 GiB — and the
// whole toolchain around it agrees: nvidia-smi reports MiB, llama.cpp logs MiB, ollama's scheduler logs GiB.
// Dividing by 1000³ makes this UI the only component disagreeing with every other, by 7.4%:
//
//     101,972,967,424 bytes  ÷ 1024³ =  94.97 GiB   correct
//                            ÷ 1000³ = 101.97 GB    wrong — and it reads as a plausible number
//
// That is what makes it dangerous rather than obviously broken. So: keep BYTES internally (every derivation
// here does), convert once at the render boundary, through this and only this.
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Bytes → a rendered figure, binary units. Two decimals below 100, one above: VRAM decisions turn on hundreds
 *  of MiB, so a whole-number GiB render hides exactly the margin that matters. Never returns a bare number —
 *  the unit is part of the value, because "94.4" is a support ticket and "94.4 GiB" is not. */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes)) return "—";
    const neg = bytes < 0;
    let v = Math.abs(bytes), i = 0;
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
    const digits = i === 0 ? 0 : v >= 100 ? 1 : 2;
    return `${neg ? "-" : ""}${v.toFixed(digits)} ${UNITS[i]}`;
}

/** The same figure split, for a UI that wants to style the unit separately. */
export const splitBytes = (bytes: number | null | undefined): { value: string; unit: string } => {
    const s = formatBytes(bytes);
    const i = s.lastIndexOf(" ");
    return i === -1 ? { value: s, unit: "" } : { value: s.slice(0, i), unit: s.slice(i + 1) };
};

export type Runner = "CUDA" | "ROCm" | "Metal" | (string & {});

// Runners whose memory is a pool genuinely SEPARATE from system RAM. Anything else (Metal today) is treated
// as unified — the conservative default, because the failure mode of guessing "discrete" is a summed number
// that is simply wrong, while guessing "unified" only declines to add two figures.
const DISCRETE_RUNNERS = new Set(["CUDA", "ROCm"]);
export const isDiscrete = (runner: string | null | undefined): boolean => !!runner && DISCRETE_RUNNERS.has(runner);

export interface DeviceCapacity {
    id: string;
    /** The server's label ("CUDA0"), not a marketing name. */
    name: string;
    runner: Runner;
    totalBytes: number;
    freeBytes: number;
    /** Metal: `totalBytes` is a recommended working set overlapping host RAM — never add it to the host total. */
    unified: boolean;
}

export interface HostCapacity {
    cores: number | null;
    totalBytes: number;
    freeBytes: number;
    /** 0 is reported on macOS whether or not swap exists, so 0 means UNKNOWN, not "no swap". */
    swapFreeBytes: number | null;
}

export interface Capacity {
    devices: DeviceCapacity[];
    host: HostCapacity;
    /** Any unified device → device and host memory overlap, so they can never be stacked or summed. */
    unified: boolean;
}

/** Parse `/api/info`. Returns null for anything that isn't the expected JSON — a stock Ollama or unpatched
 *  OpenWebUI answers this route with SPA HTML, and every user but one is in that position. Null means
 *  "capacity unknown", which the panel must render as a missing ceiling, never as zero. */
export function parseInfo(raw: unknown): Capacity | null {
    const r = raw as { compute?: { system_compute?: Record<string, number>; supported_gpus?: Record<string, unknown>[] } };
    const c = r?.compute;
    if (!c || typeof c !== "object") return null;
    const sys = c.system_compute;
    if (!sys || typeof sys.total_memory !== "number") return null;
    const devices: DeviceCapacity[] = (Array.isArray(c.supported_gpus) ? c.supported_gpus : []).flatMap((g) => {
        const total = Number(g.total_memory), free = Number(g.free_memory);
        if (!Number.isFinite(total) || total <= 0) return [];
        const runner = String(g.runner ?? "");
        return [{
            id: String(g.gpu_id ?? ""),
            name: String(g.name ?? runner ?? "device"),
            runner,
            totalBytes: total,
            freeBytes: Number.isFinite(free) ? free : 0,
            unified: !isDiscrete(runner),
        }];
    });
    return {
        devices,
        host: {
            cores: typeof sys.cpu_cores === "number" ? sys.cpu_cores : null,
            totalBytes: sys.total_memory,
            freeBytes: typeof sys.free_memory === "number" ? sys.free_memory : 0,
            swapFreeBytes: sys.free_swap ? sys.free_swap : null,   // 0 → unknown (see HostCapacity)
        },
        unified: devices.some((d) => d.unified),
    };
}

/** One resident model at one instant. Bytes, not the rounded GB `LoadedModel` carries for display — the
 *  band arithmetic subtracts these from exact capacity figures, so rounding would accumulate visible error. */
export interface ModelResidency {
    model: string;
    /** Total across all devices. */
    vramBytes: number;
    /** Spilled to system RAM (`size - size_vram`); 0 when fully GPU-resident. */
    ramBytes: number;
    /** deviceId → bytes, or null when the server reports 0 under a non-zero total (attribution unknown). */
    perDevice: Record<string, number | null>;
    contextLength: number | null;
    expiresAt: number | null;
}

/** One poll: what was resident at `t`. Capacity rides along because it can change (a card appears, another
 *  process frees memory) and because a sample read back from history must know the ceiling it was drawn against. */
export interface ResourceSample {
    t: number;
    models: ModelResidency[];
    capacity: Capacity | null;
}

/** Raw `/api/ps` entry → residency. `gpus` is ABSENT for a CPU-resident model — that is the contract, and it
 *  is why an empty device map plus a zero `size_vram` reads as "on the CPU" rather than "placement unknown". */
export function residencyFrom(raw: unknown): ModelResidency {
    const m = raw as Record<string, unknown>;
    const size = Number(m.size) || 0;
    const vram = Number(m.size_vram) || 0;
    const perDevice: Record<string, number | null> = {};
    const gpus = Array.isArray(m.gpus) ? m.gpus as Record<string, unknown>[] : [];
    for (const g of gpus) {
        const bytes = Number(g.size_vram) || 0;
        // The deployed server reports 0 per device for a placement that doesn't start at card 0 while the
        // TOTAL is right. Zero-under-a-nonzero-total is therefore unknown, not zero (caveat 2).
        perDevice[String(g.gpu_id ?? "")] = bytes === 0 && vram > 0 ? null : bytes;
    }
    return {
        model: String(m.model || m.name || ""),
        vramBytes: vram,
        ramBytes: Math.max(0, size - vram),
        perDevice,
        contextLength: typeof m.context_length === "number" ? m.context_length : null,
        expiresAt: m.expires_at ? Date.parse(String(m.expires_at)) || null : null,
    };
}

/** The line(s) a track is drawn against. A discrete card has one real ceiling. A unified device has two: the
 *  system total is the hard limit, and the device's reported total is a RECOMMENDED WORKING SET inside it —
 *  the "will this model fit" number, not a second pool. Measured on a 16 GB Mac: 12.71 GB working set of a
 *  17.18 GB system. */
export interface Ceilings { hardBytes: number; softBytes: number | null; softLabel: string | null }
export function ceilingsFor(sample: ResourceSample, deviceId: string): Ceilings | null {
    const cap = sample.capacity;
    const dev = cap?.devices.find((d) => d.id === deviceId);
    if (!cap || !dev) return null;
    return dev.unified
        ? { hardBytes: cap.host.totalBytes, softBytes: dev.totalBytes, softLabel: "recommended working set" }
        : { hardBytes: dev.totalBytes, softBytes: null, softLabel: null };
}

/** Is this model on the CPU? `gpus` absent (or nothing in VRAM) is the server's way of saying so. */
export const isCpuResident = (m: ModelResidency): boolean => m.vramBytes === 0;

// --- bands: how ONE device's (or the host's) capacity decomposes at one instant ------------------------------

export type BandKind = "model" | "other" | "free" | "unknown";

/** What the unattributed band actually contains — NOT simply "other processes". `size_vram` is llama-server's
 *  own buffer accounting, and the driver consistently reports 0.7–1.8 GiB MORE per model (roughly constant
 *  regardless of model size): the CUDA context, which no buffer line reports. So this band holds our own
 *  models' context overhead as well as genuinely foreign allocations, and "model is using X" will never
 *  reconcile with "card has Y free". That residual is expected and is not worth trying to correct — but the
 *  band must not CLAIM to be other processes, or the reader will go looking for a process that isn't there. */
export const OTHER_BAND_LABEL = "unattributed";
export const OTHER_BAND_NOTE =
    "In use but not accounted for by a model's reported buffers — mostly each loaded model's CUDA context "
    + "(0.7-1.8 GiB per model, which no buffer line reports), plus anything else on the card.";
export interface Band {
    key: string;
    label: string;
    bytes: number;
    kind: BandKind;
    /** Set on a `model` band, so the chart can colour it with the model's own colour and hide it with the row. */
    model?: string;
}

/** How much of `device` this model holds, or null when the server couldn't attribute it. A single-device box
 *  needs no attribution at all: the model's total IS its share. */
function shareOf(m: ModelResidency, deviceId: string, deviceCount: number): number | null {
    if (deviceCount <= 1) return m.vramBytes;
    if (!(deviceId in m.perDevice)) return 0;      // it names its devices and this isn't one of them
    return m.perDevice[deviceId];
}

/** One device's capacity split into stacked bands: each model's share, then memory held by processes that
 *  are NOT ours, then what is actually free. The middle band is the reason a bare "18 of 102 GB" misleads —
 *  it is real usage that no model of ours accounts for. An unattributable model becomes an `unknown` band
 *  rather than silently vanishing from the stack or being counted as zero. */
export function deviceBands(sample: ResourceSample, deviceId: string): Band[] {
    const cap = sample.capacity?.devices.find((d) => d.id === deviceId);
    if (!cap) return [];
    // UNIFIED memory: the device's own `free_memory` only tracks the accelerator's working set and is blind to
    // everything else on the machine — a 16 GB Mac reported 12.711 of 12.713 GB device-free while the SYSTEM
    // was 13.5 GB deep in the very same silicon. Reading "other processes" off the device would therefore show
    // ~0 on a nearly-full machine. The pool is the host's, so the occupancy comes from there; the device total
    // survives only as the soft ceiling (see ceilingsFor).
    if (cap.unified) return hostBands(sample);
    const count = sample.capacity!.devices.length;
    const bands: Band[] = [];
    let attributed = 0, unknown = 0;
    for (const m of sample.models) {
        const share = shareOf(m, deviceId, count);
        if (share == null) { unknown += m.vramBytes; continue; }
        if (share <= 0) continue;
        attributed += share;
        bands.push({ key: `m:${m.model}`, label: m.model, bytes: share, kind: "model", model: m.model });
    }
    if (unknown > 0) bands.push({ key: "unknown", label: "placement unknown", bytes: unknown, kind: "unknown" });
    // Everything in use that we cannot attribute to a model of ours. Clamped: `free` is sampled independently
    // of `ps`, so a race can make the arithmetic go slightly negative.
    const used = Math.max(0, cap.totalBytes - cap.freeBytes);
    bands.push({ key: "other", label: OTHER_BAND_LABEL, bytes: Math.max(0, used - attributed - unknown), kind: "other" });
    bands.push({ key: "free", label: "free", bytes: Math.max(0, cap.freeBytes), kind: "free" });
    return bands;
}

/** The host's RAM split the same way — model spill first, then everything else in use, then free. */
export function hostBands(sample: ResourceSample): Band[] {
    const host = sample.capacity?.host;
    if (!host) return [];
    // On UNIFIED memory the whole footprint sits in this one pool, so a GPU-resident model must be attributed
    // in full — `size == size_vram` there, which would otherwise attribute NOTHING and leave a model that is
    // plainly resident invisible in the stack. On a discrete box the GPU half lives in its own pool and only
    // the spill (`size - size_vram`) belongs here.
    const unified = !!sample.capacity?.unified;
    const bands: Band[] = [];
    let attributed = 0;
    for (const m of sample.models) {
        const bytes = unified ? m.vramBytes + m.ramBytes : m.ramBytes;
        if (bytes <= 0) continue;
        attributed += bytes;
        bands.push({ key: `m:${m.model}`, label: m.model, bytes, kind: "model", model: m.model });
    }
    const used = Math.max(0, host.totalBytes - host.freeBytes);
    bands.push({ key: "other", label: OTHER_BAND_LABEL, bytes: Math.max(0, used - attributed), kind: "other" });
    bands.push({ key: "free", label: "free", bytes: Math.max(0, host.freeBytes), kind: "free" });
    return bands;
}

// --- series + tracks: what the panel can plot, and how the user may combine it ------------------------------

export type SeriesScope = "device" | "host";
export interface SeriesDef {
    id: string;
    label: string;
    scope: SeriesScope;
    /** Which pool this series measures — two series with different pools must not share a stacked axis. */
    pool: string;
    deviceId?: string;
    model?: string;
    capacityBytes: number | null;
}

/** Everything this box can actually plot, derived from the devices it reports rather than hardcoded — a
 *  one-device Mac and a two-card server produce different catalogs from the same code. */
export function seriesCatalog(sample: ResourceSample): SeriesDef[] {
    const cap = sample.capacity;
    const out: SeriesDef[] = [];
    // One pool → ONE capacity series. Offering a separate device and host series here would invite exactly the
    // double-count `stackRefusal` exists to block, so unified memory doesn't produce the pair in the first
    // place. Per-model series remain: `size_vram` still says what Ollama put on the GPU versus spilled.
    if (cap?.unified) {
        const dev = cap.devices[0];
        out.push({ id: "mem", label: `${dev?.name ?? "Memory"} · unified`, scope: "host", pool: "host", capacityBytes: cap.host.totalBytes });
        for (const m of sample.models) out.push({ id: `mem.${m.model}`, label: m.model, scope: "host", pool: "host", model: m.model, capacityBytes: cap.host.totalBytes });
        return out;
    }
    for (const d of cap?.devices ?? []) {
        out.push({ id: `vram.${d.id}`, label: d.name, scope: "device", pool: `device:${d.id}`, deviceId: d.id, capacityBytes: d.totalBytes });
        for (const m of sample.models) {
            if (!isCpuResident(m)) out.push({ id: `vram.${d.id}.${m.model}`, label: `${m.model} on ${d.name}`, scope: "device", pool: `device:${d.id}`, deviceId: d.id, model: m.model, capacityBytes: d.totalBytes });
        }
    }
    if (cap?.host) {
        out.push({ id: "ram", label: "System RAM", scope: "host", pool: "host", capacityBytes: cap.host.totalBytes });
        for (const m of sample.models) {
            if (m.ramBytes > 0) out.push({ id: `ram.${m.model}`, label: `${m.model} (CPU)`, scope: "host", pool: "host", model: m.model, capacityBytes: cap.host.totalBytes });
        }
    }
    return out;
}

export interface TrackDef {
    id: string;
    series: string[];
    /** `stack` sums the series against one ceiling; `overlay` draws them independently, each on its own scale. */
    mode: "stack" | "overlay";
    heightPx: number;
}

/** Why these series cannot share a STACKED axis, or null when they can. Stacking asserts the parts sum to a
 *  meaningful whole: true within one device, false across two (a model uses one card's capacity, not their
 *  sum) and false across device+host on unified memory, where the two totals describe the SAME silicon.
 *  `overlay` has no such constraint — it makes no claim about a total — so this gates only stacking. */
export function stackRefusal(defs: SeriesDef[], cap: Capacity | null): string | null {
    const pools = new Set(defs.map((d) => d.pool));
    if (pools.size <= 1) return null;
    const scopes = new Set(defs.map((d) => d.scope));
    if (cap?.unified && scopes.size > 1)
        return "This device shares one pool of memory between the GPU and the system, so its VRAM and RAM figures describe the same silicon — stacking them would double-count. Overlay them instead.";
    if ([...pools].filter((p) => p.startsWith("device:")).length > 1)
        return "Each card has its own capacity and a model can only use one card's, so a stack of several cards has no meaningful total. Show a track per card, or overlay them.";
    return "These series measure different pools, so their sum isn't a real quantity. Overlay them instead.";
}

export interface Preset { id: string; label: string; description: string; tracks: TrackDef[] }

/** Starting layouts, generated from the box: a two-card server opens on placement (where did it land?), a
 *  single-device machine on the split that actually matters there (GPU vs CPU spill). */
export function presetsFor(sample: ResourceSample): Preset[] {
    const cap = sample.capacity;
    const devices = cap?.devices ?? [];
    const track = (id: string, series: string[], mode: TrackDef["mode"] = "stack"): TrackDef => ({ id, series, mode, heightPx: 96 });
    const overview: Preset = {
        id: "overview", label: "Overview", description: "Everything resident, stacked against capacity.",
        tracks: [track("overview", devices.map((d) => `vram.${d.id}`))].filter((t) => t.series.length > 0),
    };
    const placement: Preset = {
        id: "placement", label: "Placement", description: "One track per card, so you can see where a model landed.",
        tracks: devices.map((d) => track(`dev-${d.id}`, [`vram.${d.id}`])),
    };
    const withRam: Preset = {
        id: "memory", label: "GPU + RAM", description: "Accelerator memory alongside system RAM.",
        tracks: [...devices.map((d) => track(`dev-${d.id}`, [`vram.${d.id}`])), track("ram", ["ram"])],
    };
    // A single-device box has nothing to place, so lead with the split that means something there.
    return devices.length > 1 ? [placement, overview, withRam] : [withRam, overview];
}

// --- history ------------------------------------------------------------------------------------------------

/** Polling is gated on the panel being open, so the history has HOLES. A gap wider than this breaks the line
 *  instead of being drawn across: an interpolated segment over a ten-minute hole is a confident lie about
 *  memory that was never measured. (Same rule as never inventing a timestamp for an unmarked line.) */
export const MAX_SAMPLE_GAP_MS = 15_000;

/** Split history into contiguous runs, so the chart draws several segments rather than one line bridging
 *  every gap. A single sample is its own segment (it renders as a point, not a line). */
export function segments(samples: ResourceSample[], maxGapMs: number = MAX_SAMPLE_GAP_MS): ResourceSample[][] {
    const out: ResourceSample[][] = [];
    let run: ResourceSample[] = [];
    for (const s of samples) {
        const prev = run[run.length - 1];
        if (prev && s.t - prev.t > maxGapMs) { out.push(run); run = []; }
        run.push(s);
    }
    if (run.length) out.push(run);
    return out;
}

/** An annotation on the time axis — a run starting, a model loading or being evicted, a context reload.
 *  Kept separate from the samples because events are instants while samples are a cadence, and because the
 *  event source (the debug bus) is independent of the poll. */
export interface ResourceEvent {
    t: number;
    kind: "run" | "load" | "evict" | "error" | "note";
    label: string;
    model?: string;
}

/** Events inside a window, in time order — what the chart's event lane draws, and what a vertical rule
 *  through the plot is placed by. */
export function eventsIn(events: ResourceEvent[], from: number, to: number): ResourceEvent[] {
    return events.filter((e) => e.t >= from && e.t <= to).sort((a, b) => a.t - b.t);
}
