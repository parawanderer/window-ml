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
    /** `total_memory` — cuDeviceTotalMem, ollama's own view. The FIT figure: what placement decides against
     *  (ollama actually reserves a little more still). Sits ~638 MiB below the driver's framebuffer total. */
    totalBytes: number;
    /** `physical_memory` — the DRIVER's framebuffer total, what nvidia-smi shows. The DISPLAY figure for
     *  "total VRAM on the machine", so a devtools panel doesn't appear to lose a gigabyte the rest of the
     *  system says is there. Not in the API yet (a follow-up PR adds it), hence optional: absent → fall back
     *  to `totalBytes` and label it honestly. NEVER synthesise the nominal figure by rounding — that breaks on
     *  any card with ECC on or a non-round config. */
    physicalBytes?: number;
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
/** A share as a percentage: "19%", or "<1%" for something too small to round to a whole percent but not
 *  nothing. Empty when there is no denominator to be a share OF. */
export function percentOf(part: number, whole: number): string {
    if (!(whole > 0)) return "";
    const p = (part / whole) * 100;
    if (p > 0 && p < 1) return "<1%";
    // A decimal below 10% ("5.4%", not "5%") — on a 95 GiB pool that is half a gigabyte. Exactly zero has no
    // precision to report.
    return `${p.toFixed(p > 0 && p < 10 ? 1 : 0)}%`;
}

/** "18.00 GiB of 95.59 GiB (19%)". The bytes answer "how much", the percentage answers "how full" — and a
 *  reader asked to divide 18 by 95.59 in their head is being handed half an answer. `sep` is the word between
 *  the two figures, so a compact header can use "/" where a tooltip uses "of". */
export function formatShare(part: number, whole: number, sep = "of"): string {
    const p = percentOf(part, whole);
    return `${formatBytes(part)} ${sep} ${formatBytes(whole)}${p ? ` (${p})` : ""}`;
}

/** What capacity to hold after a poll answers. Capacity is a fact about the BOX, not about this poll: a null
 *  answer means THIS request learned nothing (a hiccup, a worker that had gone to sleep, a lost race), and
 *  forgetting what was already measured swaps the whole panel for the no-ceiling fallback until some later
 *  poll happens to succeed — which reads as the old chart randomly reappearing. A box that has NEVER answered
 *  still degrades, because there is nothing to keep. */
export function holdCapacity(current: Capacity | null, answered: Capacity | null): Capacity | null {
    return answered ?? current;
}

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
            ...(Number.isFinite(Number(g.physical_memory)) && Number(g.physical_memory) > 0 ? { physicalBytes: Number(g.physical_memory) } : {}),
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
export interface Ceilings {
    hardBytes: number;
    softBytes: number | null;
    softLabel: string | null;
    /** What to show as "total on the machine" — the driver framebuffer total when the server reports it, else
     *  ollama's own total. `displayIsFit` says which, so the UI can label it honestly rather than implying it
     *  is the number nvidia-smi shows when it isn't. */
    displayBytes: number;
    displayIsFit: boolean;
}
export function ceilingsFor(sample: ResourceSample, deviceId: string): Ceilings | null {
    const cap = sample.capacity;
    const dev = cap?.devices.find((d) => d.id === deviceId);
    if (!cap || !dev) return null;
    // THREE totals exist and all are correct: nominal (never reported by anything — never synthesise it), the
    // driver framebuffer total (`physical_memory`, what nvidia-smi shows), and cuDeviceTotalMem
    // (`total_memory`, what ollama places against). Display the driver's; decide fit against ollama's.
    const display = dev.physicalBytes ?? dev.totalBytes;
    const displayIsFit = dev.physicalBytes == null;
    return dev.unified
        ? { hardBytes: cap.host.totalBytes, softBytes: dev.totalBytes, softLabel: "recommended working set", displayBytes: cap.host.totalBytes, displayIsFit: true }
        : { hardBytes: dev.totalBytes, softBytes: null, softLabel: null, displayBytes: display, displayIsFit };
}

/** Where a model actually SITS, as one readable line: which device(s), and how it was split. A large model
 *  can be split across several cards, or across a card and system RAM (the classic partial offload), and none
 *  of that is visible from a single total — `18.00 GiB` looks identical whether it is one card or three. Named
 *  devices come from the capacity so the reader sees "CUDA1", not "1".
 *
 *  Returns null when there is nothing to say (a single-device box with everything resident on it). */
export function placementOf(m: ModelResidency, cap: Capacity | null, fmt: (b: number) => string): string | null {
    const parts: string[] = [];
    let unknown = false;
    for (const [id, bytes] of Object.entries(m.perDevice)) {
        const name = cap?.devices.find((d) => d.id === id)?.name ?? `device ${id}`;
        if (bytes == null) { unknown = true; parts.push(`${name} (unknown)`); continue; }
        if (bytes > 0) parts.push(`${name} ${fmt(bytes)}`);
    }
    // The CPU half of a partial offload — the reason a model can be "on the GPU" and still be slow.
    if (m.ramBytes > 0) parts.push(`RAM ${fmt(m.ramBytes)}`);
    if (!parts.length) return m.vramBytes > 0 ? null : `RAM ${fmt(m.ramBytes)}`;
    if (parts.length === 1 && !unknown) return parts[0];
    return parts.join(" + ");
}

/** Is this model SPLIT — across several devices, or between a device and system RAM? That is the case worth
 *  surfacing: a split model is slower than its total size suggests, and the total alone never shows it. */
export function isSplit(m: ModelResidency): boolean {
    const on = Object.values(m.perDevice).filter((b) => b == null || b > 0).length;
    return on > 1 || (on >= 1 && m.ramBytes > 0);
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
/** Below this, a residual is ollama's own driver overhead, not another process. An IDLE card with nothing
 *  loaded still shows ~0.55 GiB (ollama's discovery context, held on every visible card), and a loaded model
 *  adds its CUDA context on top. Computing "used by other processes" naively therefore makes every idle card
 *  display phantom third-party usage. */
export const DRIVER_OVERHEAD_FLOOR = 1024 ** 3;
export const DRIVER_BAND_LABEL = "driver overhead";
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
    const residual = Math.max(0, used - attributed - unknown);
    // Name the residual by MAGNITUDE: under the floor it is the driver's own context (present even on an idle
    // card), above it there is genuinely something else on the card worth telling the reader about.
    bands.push({ key: "other", label: residual < DRIVER_OVERHEAD_FLOOR ? DRIVER_BAND_LABEL : OTHER_BAND_LABEL, bytes: residual, kind: "other" });
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

/** Why this preset is invalid on this machine, or null. A preset proposes a LAYOUT and `stackRefusal` judges
 *  it, so the two must agree: a preset that offers a stack the rule then refuses would be an option the user
 *  can pick and immediately be told off for. Used by the drift guard, and by the layout validator when a saved
 *  layout is restored onto a different box. */
export function presetRefusal(p: Preset, sample: ResourceSample): string | null {
    const cat = seriesCatalog(sample);
    for (const t of p.tracks) {
        const defs = t.series.map((id) => cat.find((s) => s.id === id)).filter(Boolean) as SeriesDef[];
        if (defs.length !== t.series.length) return `references a series this machine doesn't have`;
        if (t.mode === "stack") { const r = stackRefusal(defs, sample.capacity); if (r) return r; }
    }
    return null;
}

/** Starting layouts, generated from the box: a two-card server opens on placement (where did it land?), a
 *  single-device machine on the split that actually matters there (GPU vs CPU spill). */
export function presetsFor(sample: ResourceSample): Preset[] {
    const cap = sample.capacity;
    const devices = cap?.devices ?? [];
    // Build from the CATALOG, not from device ids: on unified memory the catalog collapses to a single `mem`
    // series (one pool, one ceiling), so naming `vram.0`/`ram` here would propose tracks for series that do
    // not exist on that machine. The two must be derived from one source or they drift apart.
    const have = new Set(seriesCatalog(sample).map((s) => s.id));
    const track = (id: string, series: string[], mode: TrackDef["mode"] = "stack"): TrackDef =>
        ({ id, series: series.filter((x) => have.has(x)), mode, heightPx: 96 });
    const nonEmpty = (t: TrackDef) => t.series.length > 0;

    if (cap?.unified) {
        // One physical pool: one track, and no per-card view of a machine with one device.
        return [{ id: "memory", label: "Memory", description: "The single pool this machine shares between GPU and system.",
                  tracks: [track("mem", ["mem"])].filter(nonEmpty) }];
    }
    const overview: Preset = {
        id: "overview", label: "Overview", description: "Every card in one track, overlaid — no false total.",
        // OVERLAY, not stack: several pools have no meaningful combined total (a model can only use one
        // card's capacity), and stackRefusal rightly refuses that. A preset must never propose a layout the
        // rule then rejects. Overlaying claims nothing about a total, so it is the honest way to compare them.
        // The HOST pool is included: a CPU-resident model holds no VRAM, so a cards-only overview would make
        // it vanish from the chart while it still sits in the legend below — the same flaw that took Placement
        // out of the default slot.
        tracks: ([{ ...track("overview", [...devices.map((d) => `vram.${d.id}`), "ram"]),
                    mode: (devices.length > 1 ? "overlay" : "stack") as TrackDef["mode"] }] as TrackDef[]).filter(nonEmpty),
    };
    const withRam: Preset = {
        id: "memory", label: "GPU + RAM", description: "A track per pool, with the models stacked in each.",
        tracks: [...devices.map((d) => track(`dev-${d.id}`, [`vram.${d.id}`])), track("ram", ["ram"])].filter(nonEmpty),
    };
    // TWO views, and they differ in KIND rather than in scope: Overview is one compact track with every pool
    // overlaid (how full is each), GPU + RAM is a track per pool with per-model bands (what is in each). Both
    // include the host, because a CPU-resident model holds no VRAM and a view that omits the host pool makes
    // it vanish from the chart while it sits in the legend below.
    //
    // There was a third, "Placement" — GPU + RAM minus the host track. It was exactly that flaw as a named
    // option: strictly narrower, and what it narrowed AWAY was your CPU-resident models. Anyone who genuinely
    // wants cards-only can drop the RAM track in the editor, which is one click and says what it did.
    return [overview, withRam];
}

/** A stable identity for the MACHINE this capacity describes — its devices (id, name, runner, size) and its
 *  host total. Point the extension at a different backend (a CUDA server, then a Metal Mac) and this changes,
 *  which matters because history from the old box CANNOT be drawn on the new one: the ceiling moves by 8x, the
 *  device ids mean different hardware, and a saved layout may name a card that no longer exists. Samples are
 *  kept per-box and dropped when it changes — the alternative is an 18 GiB band clipped against an 11.84 GiB
 *  ceiling, which looks like a reading rather than a category error. */
export function boxSignature(cap: Capacity | null): string {
    if (!cap) return "";
    const devs = cap.devices.map((d) => `${d.id}:${d.name}:${d.runner}:${d.totalBytes}`).join("|");
    return `${devs}#${cap.host.totalBytes}`;
}

/** Samples that describe the CURRENT box. Anything recorded against a different machine is dropped rather than
 *  redrawn against a ceiling it was never measured under.
 *
 *  `switched` is the case that bites: a sample taken before capacity was first known carries none, and a
 *  capacity-less sample gets the CURRENT capacity backfilled at render. On a normal open that is right (it was
 *  measured moments ago on this box). After a backend SWITCH it is a category error — an 18 GiB reading from a
 *  CUDA server, backfilled with a Mac's 16 GiB pool, clips to the full height and looks like a measurement. So
 *  when the box changed, an unattributable sample is dropped rather than assumed to belong to either machine. */
export function sameBoxOnly(samples: ResourceSample[], cap: Capacity | null, switched = false): ResourceSample[] {
    const sig = boxSignature(cap);
    if (!sig) return samples;   // capacity unknown → nothing to contradict; keep what we have
    return samples.filter((s) => (s.capacity ? boxSignature(s.capacity) === sig : !switched));
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

/** Where an event sits on the chart's x-axis — which SEGMENT, and how far across it.
 *
 *  The axis is not linear in time. The plot is split into contiguous runs of samples (a gap is drawn as a
 *  gap, never interpolated across), and each run is flex-weighted by how many samples it holds — so the same
 *  number of pixels means different durations in different segments. An event therefore has to be placed
 *  INSIDE the run that contains it, by time, and an event that falls in a gap has no x at all: nothing was
 *  measured then, and putting it at the edge would claim it happened at a moment the chart can't speak for.
 *
 *  Spans are clipped to the run they start in. A span crossing a gap is a real thing (a load that ran while
 *  the panel was closed), and the honest drawing of it ends where the measurements do. */
export interface EventPlacement {
    event: ResourceEvent;
    /** Index into the runs array — which segment it is drawn in. */
    run: number;
    /** 0..1 across that run's own width. */
    from: number;
    /** 0..1; equals `from` for an instant. */
    to: number;
    /** The span continues past the end of this run (into a gap, or past the window). */
    clipped: boolean;
}

/** EVICTIONS, read straight off consecutive samples. Nothing reports them — a model simply stops being in
 *  `ps` — so the diff IS the source, and it is the one event kind that needs no cooperation from anything.
 *  Loads are NOT inferred here: `load_duration` gives a real span with a real duration, and a second inferred
 *  instant for the same load would double-report it. A model that APPEARS with no load span behind it (loaded
 *  by another client, or while the panel was closed) is reported, because otherwise it arrives from nowhere. */
export function residencyEvents(samples: ResourceSample[], knownLoads: ResourceEvent[] = []): ResourceEvent[] {
    const out: ResourceEvent[] = [];
    for (let i = 1; i < samples.length; i++) {
        const before = new Set(samples[i - 1].models.map((m) => m.model));
        const after = new Set(samples[i].models.map((m) => m.model));
        const t = samples[i].t;
        for (const m of before) if (!after.has(m)) out.push({ t, kind: "evict", label: `${m} evicted`, model: m });
        for (const m of after) {
            if (before.has(m)) continue;
            // Within a poll of a load span for the same model → that span already tells the story.
            const covered = knownLoads.some((e) => e.model === m && e.kind === "load" &&
                t >= e.t - MAX_SAMPLE_GAP_MS && t <= (e.until ?? e.t) + MAX_SAMPLE_GAP_MS);
            if (!covered) out.push({ t, kind: "load", label: `${m} appeared`, model: m });
        }
    }
    return out;
}

/** The TIME at a fraction across the whole plot — the inverse of `placeEvents`, for turning a drag into a
 *  time range. The plot is segments laid out with flex weights proportional to their sample counts, so the
 *  fraction is spent across the segments in those proportions and then interpolated INSIDE the one it lands
 *  in. A fraction landing in a gap between segments resolves to that gap's near edge: nothing was measured
 *  there, so the honest answer is the last moment that was. */
export function timeAtFraction(runs: { t: number }[][], frac: number): number | null {
    const live = runs.filter((r) => r.length > 0);
    if (!live.length) return null;
    const weights = live.map((r) => Math.max(1, r.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    const f = Math.min(1, Math.max(0, frac));
    for (let i = 0; i < live.length; i++) {
        const share = weights[i] / total;
        if (f <= acc + share || i === live.length - 1) {
            const within = share > 0 ? Math.min(1, Math.max(0, (f - acc) / share)) : 0;
            const from = live[i][0].t, to = live[i].at(-1)!.t;
            return from + (to - from) * within;
        }
        acc += share;
    }
    return live.at(-1)!.at(-1)!.t;
}

/** An event's whole lineage:/** An event's whole lineage: itself, everything it descends from, and everything descended from it. Hovering
 *  a sub-call should leave the step that spawned it and the run that contains it lit — the relationship is
 *  what makes the bar mean anything — and hovering the step should keep what it spawned, which is the same
 *  relationship read the other way. */
export function lineageOf(events: readonly ResourceEvent[], id: string | undefined): Set<string> {
    const out = new Set<string>();
    if (!id) return out;
    const byId = new Map(events.filter((e) => e.id).map((e) => [e.id!, e]));
    out.add(id);
    // ANCESTORS: straight up the chain.
    for (let cur = byId.get(id)?.parent; cur && !out.has(cur); cur = byId.get(cur)?.parent) out.add(cur);
    // DESCENDANTS: only of the hovered event itself, never of its ancestors — a sibling step is not part of
    // this lineage, and pulling one in would light half the run for hovering one sub-call.
    const below = new Set<string>([id]);
    for (let grew = true; grew; ) {
        grew = false;
        for (const e of events) if (e.id && e.parent && below.has(e.parent) && !below.has(e.id)) { below.add(e.id); grew = true; }
    }
    for (const d of below) out.add(d);
    return out;
}

/** Pack placed events into non-overlapping ROWS, greedily and in time order: an event goes in the first row
 *  whose last event ends before it starts. Spans that overlap in TIME must not overlap on screen — two bars on
 *  one line read as a single longer one, which is a false statement about what happened.
 *
 *  Concurrency is the normal case here, not an edge: a run contains its generations, a generation may have a
 *  background embedding call beside it, and each nests under the one that contains it —
 *
 *      [                    run                      ]
 *           [ generation ]            [ tool ]
 *                [ embed ]
 *
 *  which falls out of "first free row, earliest start first" without special-casing nesting: the longest span
 *  starts first, so it takes the top row and everything inside it goes below. */
/** The smallest fraction of the plot a bar is DRAWN at. A shorter event is widened to this so it stays
 *  visible — which means packing has to reserve the same width, or two events that do not overlap in time
 *  are drawn overlapping and read as one longer bar. */
export const MIN_EV_SPAN = 0.006;

export function laneRows(placed: EventPlacement[], maxRows = 4, minSpan = MIN_EV_SPAN): EventPlacement[][] {
    const rows: EventPlacement[][] = [];
    const ends: number[] = [];   // per row: [run, to] as a comparable number
    // The END is the DRAWN end, not the true one: see MIN_EV_SPAN.
    const key = (p: EventPlacement, edge: "from" | "to") =>
        p.run + (edge === "from" ? p.from : Math.max(p.to, p.from + minSpan));
    for (const p of [...placed].sort((a, b) => key(a, "from") - key(b, "from"))) {
        let r = ends.findIndex((e) => e <= key(p, "from"));
        if (r < 0) {
            if (rows.length >= maxRows) r = rows.length - 1;   // out of rows: crowd the last one rather than drop the event
            else { rows.push([]); ends.push(0); r = rows.length - 1; }
        }
        rows[r].push(p);
        ends[r] = Math.max(ends[r], key(p, "to"));
    }
    return rows;
}

/** Place events onto segmented runs. `runs` is what the chart draws: one array of samples per contiguous run,
 *  in order. Events that fall entirely in a gap are DROPPED — see above. */
export function placeEvents(runs: { t: number }[][], events: ResourceEvent[], graceMs = 0): EventPlacement[] {
    // The last sample is up to one poll OLD, but the chart's right edge means "now" — so an event from the
    // last couple of seconds belongs to the final run rather than to nowhere. Without this grace the newest
    // events, which are the ones you are watching for, are the only ones that never appear.
    const spans = runs.map((r, i) => ({ from: r[0]?.t ?? 0, to: (r.at(-1)?.t ?? 0) + (i === runs.length - 1 ? graceMs : 0) }));
    const out: EventPlacement[] = [];
    for (const e of events) {
        const end = e.until ?? e.t;
        // The run that CONTAINS the start, else the first run the event overlaps at all — a span that began
        // during a gap still belongs to the segment it reaches.
        let idx = spans.findIndex((r) => e.t >= r.from && e.t <= r.to);
        if (idx < 0) idx = spans.findIndex((r) => end >= r.from && e.t <= r.to);
        if (idx < 0) continue;   // entirely inside a gap (or outside every run): nothing measured, nothing drawn
        const r = spans[idx];
        // Width is the run's own span, NOT the graced one: the grace decides membership, and using it as a
        // denominator would squash every bar toward the left by however long the poll happens to be.
        const width = (runs[idx].at(-1)?.t ?? 0) - r.from;
        const at = (t: number) => (width > 0 ? Math.min(1, Math.max(0, (t - r.from) / width)) : 0);
        out.push({ event: e, run: idx, from: at(e.t), to: at(Math.min(end, r.to)), clipped: end > r.to });
    }
    return out;
}

/** An annotation on the time axis — a run starting, a model loading or being evicted, a context reload.
 *  Kept separate from the samples because events are instants while samples are a cadence, and because the
 *  event source (the debug bus) is independent of the poll. */
export interface ResourceEvent {
    t: number;
    /** When it ENDED, for the kinds that have a duration. Absent → an instant (a vertical rule); present → a
     *  span (a bar in the lane), and the duration is the interesting part: a 40-second turn that spent 30 of
     *  them loading a model is a different story from one that didn't. */
    until?: number;
    /** `embed` is for background embedding calls — a small model resolving something (a tool-call label) while
     *  the driver runs. It is NOT produced yet; the kind exists so that when it is, it renders and hovers like
     *  everything else instead of arriving as an unlabelled bar. Its whole point is that it OVERLAPS the
     *  driver's own events rather than following them, which the lane's row packing already handles. */
    kind: "run" | "gen" | "tool" | "embed" | "load" | "evict" | "error" | "note";
    label: string;
    model?: string;
    /** This event's own id, and the event that SPAWNED it. A delegated sub-call — a vision reader, an
     *  embedding — never happens on its own: it belongs to a step, which belongs to a run. Hovering one can
     *  then light its whole lineage and dim everything else, which is the difference between "some bar" and
     *  "the reader this step called". */
    id?: string;
    parent?: string;
    /** Where this happened, so a click can go there: a session hash, and the step within it. Events are
     *  CROSS-SESSION — a model load belongs to the machine's timeline, not to whichever chat provoked it — so
     *  the reference is how the lane gets you back to the one that did. */
    ref?: { hash: string; seq?: number };
    /** A composite span's PHASES, in order, each ending at `until`. A tool step is one block because it is one
     *  step and you reason about its parts together — but the parts are different kinds of time and must look
     *  different: the model generating the call, the human deciding whether to allow it, and the tool actually
     *  running. A step that waited two minutes for a click otherwise looked exactly like one that ran
     *  instantly, since only the last part is work the machine did. */
    phases?: { kind: "model" | "wait" | "tool"; until: number }[];
    /** The tool that ran, for a composite span. */
    tool?: string;
    /** What it cost, for the kinds that spend tokens. Plain numbers rather than a RunStats import: this module
     *  stays standalone, and the surface that renders it already knows how to say "eval" vs "wall". */
    cost?: { inTokens: number; outTokens: number; tokPerSec: number | null; genBasis: "eval" | "wall" | "mixed" | null };
}

/** Events inside a window, in time order — what the chart's event lane draws, and what a vertical rule
 *  through the plot is placed by. */
export function eventsIn(events: ResourceEvent[], from: number, to: number): ResourceEvent[] {
    // A SPAN counts when it overlaps the window at all — one that began before it and ended inside it is
    // exactly the case the lane exists to show (the load that started before you looked). Clipping to the
    // window is the renderer's job; deciding membership is this one's.
    return events
        .filter((e) => (e.until != null ? e.until >= from && e.t <= to : e.t >= from && e.t <= to))
        .sort((a, b) => a.t - b.t);
}
