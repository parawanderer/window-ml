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
//
// Split on 2026-10-04: what the box HAS (the `/api/info` parse) is resource-capacity.ts, how fast a model should run
// and what it is doing is resource-decode.ts, and the events the lane draws are resource-timeline.ts. This file keeps
// residency, memory parts, load estimates, ceilings, box identity and the byte formatting everything else uses.
import type { Wire,
    LoadEstimate as WireLoadEstimate, MemoryBreakdown as WireMemoryBreakdown,
    ModelPlacement, ProcessModelResponse } from "./events-wire";
import { Capacity, DeviceCapacity } from "./resource-capacity";
import { RunnerActivity, Roofline, ExpectedDecode } from "./resource-decode";

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

/** One resident model at one instant. Bytes, not the rounded GB `LoadedModel` carries for display — the
 *  band arithmetic subtracts these from exact capacity figures, so rounding would accumulate visible error. */
/** WHAT a model's VRAM is holding, in bytes — the server's own split, not ours.
 *
 *  `size_vram` alone cannot tell a BIG MODEL from a BIG CONTEXT: lots of weights with a small cache, and
 *  modest weights with an enormous one, are the same number and call for opposite responses (a smaller quant
 *  vs. less context). This is that distinction.
 *
 *  The parts SUM EXACTLY to `size_vram`, to the byte — which is what lets the chart subdivide a band with no
 *  remainder slice. Where they do not, that is the server's bug to report and never ours to paper over, so
 *  {@link memorySplit} refuses rather than inventing the difference. */
export interface MemoryBreakdown {
    /** Model tensors. Fixed once the model is chosen. */
    weights: number;
    /** Attention cache — grows with the context length, and the part a context setting moves. */
    kvCache: number;
    /** Scratch for the forward pass. */
    compute: number;
    /** Hybrid/SSM per-sequence state: some layers keep this INSTEAD of a KV cache, so there are literally no
     *  keys or values in them. Reported apart because calling it "KV cache" would be wrong, but it answers
     *  the same question — together with `kvCache` it is what the CONTEXT costs. Not small: 784 MB on a 27b. */
    recurrentState: number;
    /** Logits buffer. */
    output: number;
    /** A vision model's image encoder, and often the largest non-weights term (2.32 GB of a 5.46 GB model).
     *  A WORST-CASE reservation — sized for the largest image the model accepts, not for what is held with
     *  none loaded — so it reads large against what the user is actually doing. */
    projector: number;
    /** Allocation kinds the server did not recognise. Normally 0; a LARGE one means the breakdown has gone
     *  stale against the engine, which is worth showing rather than hiding. */
    other: number;
}

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
    /** What the VRAM holds, summed across devices. ABSENT — never zeroed — when the server cannot split it
     *  (a model still loading, a runner that reports one total without naming its parts). An all-zero split
     *  beside a non-zero `size_vram` would be a contradiction, so treat missing as "not reported" and fall
     *  back to the total alone. */
    memory?: MemoryBreakdown;
    /** deviceId → that device's own split, which is what makes a SPLIT model worth looking at: weights on
     *  one card and cache on another is a placement, not a number. */
    perDeviceMemory?: Record<string, MemoryBreakdown>;
    /** The size of the files it was loaded from. Deliberately NOT part of `memory` — it is not resident
     *  memory, and including it would break the sum. Against `memory.weights` it says what the load cost
     *  over the file; they are close and never equal, in either direction. */
    weightsOnDisk?: number;
    /** What did NOT fit on a GPU, in the same shape. Present only on a SPILL — which is otherwise silent,
     *  since the model loads, answers correctly and is merely slow. `size_total > size_vram` already says
     *  how MUCH went to host memory; this says WHAT went, and 2 GB of spilled weights is a different problem
     *  from 2 GB of spilled cache. */
    memoryHost?: MemoryBreakdown;
    /** WHICH LAYERS WENT WHERE, when the server was started with `OLLAMA_LAYER_PLACEMENT=1`. Absent by
     *  default, exactly like `gpus[].memory` — the engine states the assignment only at a verbosity that also
     *  emits about a line per tensor, so it is opt-in. Treat missing as "not reported" and draw without it. */
    placement?: LayerPlacement;
    /** WHAT THE RUNNER IS DOING, and how full its KV cache is. Absent means the runner could not be asked,
     *  which is a different thing from `phase: "idle"` — and the difference matters, because idle is the
     *  answer that carries the occupancy figure. */
    activity?: RunnerActivity;
    /** The server's decode ceiling for this placement, or its reason for not having one — see `Roofline`. */
    roofline?: Roofline;
    /** The decode speed PREDICTED for this model where it is placed now — see {@link ExpectedDecode}. */
    expectedDecode?: ExpectedDecode;
}

/** Parse a server `activity` object, or null when it is absent or unusable.
 *
 *  Absent is NOT idle. The server omits the whole object when it could not ask the runner — a model still
 *  loading, a backend with no `/slots`, a failed poll, any build before it read them — and `idle` is a
 *  positive answer with an occupancy figure attached. Collapsing the two would draw a full cache as an empty
 *  one on every unpatched server, which is the same "absent is never zero" rule `memory` follows.
 *
 *  The counts are `omitempty` on the wire, so a missing one is genuinely zero for an in-flight task and is
 *  simply gone once the task ends. They are kept OPTIONAL rather than defaulted to 0 for that second case:
 *  an idle runner reporting `decoded: 0` would read as a generation that has produced nothing yet. */
// A model pulled from elsewhere (`hf.co/user/model`) keeps its prefix, because ps keeps it too, and stripping to
// the last path segment would collide two genuinely different models that happen to share a name.
const DEFAULT_REGISTRY = "registry.ollama.ai/";
const DEFAULT_NAMESPACE = "library/";
/** ONE CANONICAL NAME for a model. The event stream names them fully-qualified
 *  (`registry.ollama.ai/library/gemma4:31b`) while `/api/ps` names them short, in the same frame — so
 *  without this every streamed model is drawn TWICE, once as a phantom "off-box" row. The inverse of
 *  Ollama's own ShortName: default registry, default `library` namespace, implicit `:latest`. */
export const normModel = (m: string): string => {
    let s = m.startsWith(DEFAULT_REGISTRY) ? m.slice(DEFAULT_REGISTRY.length) : m;
    if (s.startsWith(DEFAULT_NAMESPACE)) s = s.slice(DEFAULT_NAMESPACE.length);
    return s.replace(/:latest$/, "");
};

/**
 * A QUANTIZATION CODE IN WORDS — "Q4_K_M" is a code, "4-bit weights" is what it means.
 *
 * `short` is the chip, `detail` the sentence behind it. The two families are kept apart because they are
 * different things: `Q4_*` is a 4-bit INTEGER with a scale per block of weights, not a 4-bit float, while
 * `MXFP4` (gpt-oss) and `F16`/`BF16` really are floats. The K-quant suffix says how the precision is MIXED —
 * `_S`/`_M`/`_L` keep progressively more tensors at a higher precision, so a "4-bit" model averages somewhat
 * above four bits per weight. Null for a code this does not know; the caller shows the code itself rather
 * than a guess about it.
 */
export function quantPlain(code: string): { short: string; detail: string } | null {
    const q = code.trim().toUpperCase();
    const floats: Record<string, [string, string]> = {
        F32: ["32-bit floats", "full precision, unquantized"],
        F16: ["16-bit floats", "half precision, unquantized"],
        BF16: ["bfloat16", "16-bit brain-float, unquantized — the precision most models are trained in"],
        MXFP4: ["4-bit floats", "MXFP4: 4-bit floating point with a shared scale per block of 32"],
        NVFP4: ["4-bit floats", "NVFP4: 4-bit floating point with a scale per block of 16"],
    };
    if (floats[q]) return { short: floats[q][0], detail: `Weights stored as ${floats[q][0]} (${floats[q][1]}).` };
    const mix: Record<string, string> = { S: "small", M: "medium", L: "large", XS: "extra small", XXS: "extra extra small" };
    const k = /^Q(\d)_K(?:_(S|M|L))?$/.exec(q);
    if (k) return { short: `${k[1]}-bit weights`, detail: `Weights stored as ${k[1]}-bit integers with a scale per block (a K-quant${k[2] ? `, ${mix[k[2]]} mix: some tensors are kept at a higher precision, so it averages somewhat above ${k[1]} bits` : ""}).` };
    const legacy = /^Q(\d)_([01])$/.exec(q);
    if (legacy) return { short: `${legacy[1]}-bit weights`, detail: `Weights stored as ${legacy[1]}-bit integers with a scale per block of 32${legacy[2] === "1" ? " and an offset" : ""} (a legacy quant).` };
    const iq = /^IQ(\d)_(XXS|XS|S|M|NL)$/.exec(q);
    if (iq) return { short: `~${iq[1]}-bit weights`, detail: `Weights stored at about ${iq[1]} bits each (an i-quant, ${iq[2] === "NL" ? "non-linear" : mix[iq[2]] + " mix"}: packed with an importance matrix, smaller than a K-quant of the same bit count).` };
    return null;
}

/**
 * WHAT THE SERVER'S PREDICTOR EXPECTED A LOAD TO HOLD — an `estimate` frame, sent as a load is being placed.
 *
 * For tuning the predictor, not for a user: it is the input the placement decision was made on. `predicted` is
 * the predictor's own figure and `forLoad` adds the generation-batch surcharge, and it is `forLoad` that
 * placement fits against — so comparing the bare figure with a finished load makes the predictor look ~15% low
 * across the board. `source` says which predictor answered: `calibration` (a fit over this model's measured
 * loads), `metadata` (derived from the model file alone, when there is nothing to fit yet) or `probe`.
 *
 * `weights`/`kvCache` are the METADATA model's split whatever `source` says, and only those two are populated:
 * they do not sum to either total and are compared term by term with the load's measured `memory`, never
 * summed and never drawn as a stack.
 */
export interface LoadEstimate {
    predicted: number;
    forLoad?: number;
    source?: string;
    numCtx?: number;
    numGpu?: number;
    numBatch?: number;
    metadataComplete?: boolean;
    weights?: number;
    kvCache?: number;
}

/** Parse `estimate` off an `estimate` frame, or null when there is no predicted total to compare. */
export function estimateFrom(raw: unknown): LoadEstimate | null {
    const e = raw && typeof raw === "object" ? raw as Wire<WireLoadEstimate> : null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const predicted = num(e?.predicted);
    if (!e || predicted == null) return null;
    const b: Wire<WireMemoryBreakdown> = e.breakdown && typeof e.breakdown === "object" ? e.breakdown : {};
    const out: LoadEstimate = { predicted };
    const set = <K extends keyof LoadEstimate>(k: K, v: LoadEstimate[K] | undefined) => { if (v !== undefined) out[k] = v; };
    set("forLoad", num(e.predicted_for_load));
    set("source", typeof e.source === "string" && e.source ? e.source : undefined);
    set("numCtx", num(e.num_ctx));
    set("numGpu", num(e.num_gpu));
    set("numBatch", num(e.num_batch));
    set("metadataComplete", typeof e.metadata_complete === "boolean" ? e.metadata_complete : undefined);
    // A 0 in the breakdown is "not modelled" (compute is always 0 there), never a prediction of nothing.
    set("weights", num(b.weights) || undefined);
    set("kvCache", num(b.kv_cache) || undefined);
    return out;
}

/**
 * WHAT A LOAD ACTUALLY TOOK, over time — the ground truth a prediction is checked against.
 *
 * VRAM does not rise monotonically through a load: a fit probe and device discovery come and go, the weights
 * land, then the context allocates, and it settles below its peak. A fit decision has to cover the PEAK, so
 * the trace reports the peak beside where it settled, and every point in between for anyone fitting a model
 * to it.
 *
 * Two bases, and the trace says which it used. `runner`: the loading model's own process memory, summed over
 * the cards the driver lists it on — exact, and blind to anything else on the card. `device`: the growth of
 * each card's used memory over its level just before the load began — the fallback on a server that lists no
 * processes, and wrong whenever something else moves at the same time (an eviction making room does exactly
 * that, and reads here as negative growth).
 */
export interface LoadTrace {
    basis: "runner" | "device";
    /** Each card's used memory in the last sample at or before the load began. */
    baseline: Record<string, number>;
    /** The cards the load landed on: the runner's, or on the device basis the ones that grew. */
    cards: string[];
    points: { t: number; bytes: number }[];
    peak: { t: number; bytes: number } | null;
    /** The first reading at or after the load ended, or null while it has not arrived. */
    final: { t: number; bytes: number } | null;
}

/** Trace one load through the samples. Null when no sample precedes it, since growth needs a starting level. */
export function loadTrace(samples: ResourceSample[], load: { t: number; until?: number; model?: string }, settleWithinMs = 30_000): LoadTrace | null {
    const sorted = [...samples].sort((a, b) => a.t - b.t);
    const before = [...sorted].reverse().find((s) => s.t <= load.t && s.capacity);
    if (!before?.capacity) return null;
    const baseline: Record<string, number> = {};
    for (const d of before.capacity.devices) baseline[d.id] = Math.max(0, d.totalBytes - d.freeBytes);
    const end = load.until ?? Infinity;
    // Every reading during the load, and the first one after it — which is where it SETTLED, however long the
    // stream's cadence made us wait for it (15 s when idle), up to a bound past which it is a different moment.
    const after = sorted.find((s) => s.t >= end && s.capacity && s.t <= end + settleWithinMs);
    const within = sorted.filter((s) => s.t > load.t && s.t < end && s.capacity).concat(after ? [after] : []);
    // The runner basis needs the model's runner to actually be FOUND: a list with no marks (an earlier server
    // build) or with the runner absent would otherwise trace a load of zero bytes.
    const runnerOn = (s: ResourceSample): Record<string, number> => {
        const by: Record<string, number> = {};
        for (const d of s.capacity!.devices)
            for (const p of d.processes ?? []) if (p.runner && load.model && normModel(p.runner.model) === normModel(load.model)) by[d.id] = (by[d.id] ?? 0) + p.usedBytes;
        return by;
    };
    const basis: LoadTrace["basis"] = load.model && within.some((s) => Object.keys(runnerOn(s)).length) ? "runner" : "device";
    const cards = new Set<string>();
    const points = within.map((s) => {
        if (basis === "runner") {
            const by = runnerOn(s);
            Object.keys(by).forEach((c) => cards.add(c));
            return { t: s.t, bytes: Object.values(by).reduce((n, v) => n + v, 0) };
        }
        let grown = 0;
        for (const d of s.capacity!.devices) {
            const g = Math.max(0, d.totalBytes - d.freeBytes) - (baseline[d.id] ?? 0);
            if (g > 64 * 1024 ** 2) cards.add(d.id);
            grown += g;
        }
        return { t: s.t, bytes: grown };
    });
    const during = points.filter((p) => p.t <= end);
    const peak = during.length ? during.reduce((m, p) => (p.bytes > m.bytes ? p : m)) : null;
    const final = points.find((p) => p.t >= end) ?? null;
    return { basis, baseline, cards: [...cards].sort(), points, peak, final };
}

/** Which layers a model put on which device. */
export interface LayerPlacement {
    /** The model's total, so a per-device count means something. */
    numLayers: number;
    /** One entry per contiguous RUN of layers — usually one per card, but built by scanning consecutive
     *  layers, so a non-contiguous assignment appears as several entries rather than as a span that never
     *  existed. `devices.length` is therefore NOT the number of cards. */
    devices: { device: string; firstLayer: number; lastLayer: number; layers: number;
        /** The ollama `gpu_id` of the card this run is on — the same id `gpus[]` and `supported_gpus` use. Sent
         *  since the placement naming fix (2026-09-13); absent on older builds, which named the card by the
         *  RUNNER's own enumeration, so with a card leased away a model on GPU1 reported `CUDA0`. */
        gpuId?: string }[];
    /** WHICH layers use sliding-window attention, from the engine's own `hparams.is_swa`. A list rather than
     *  a count because the pattern is irregular — gemma2 alternates 1:1, gemma4:31b is 50 of 61. Empty for
     *  architectures with none. */
    swaLayers: number[];
}

/** Parse a server `placement` object, or null when it is absent or unusable.
 *
 *  `device` is the ENGINE's name (`"CUDA0"`), NOT the ollama `gpu_id` — they are different fields and a
 *  filtered-device host can make them disagree, so a consumer matches on the name it was given and treats a
 *  mismatch as unknown rather than guessing a mapping. Nothing here is reconciled against `gpus[]`. */
export function placementFrom(raw: unknown): LayerPlacement | null {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Wire<ModelPlacement>;
    const num = Number(p.num_layers) || 0;
    const list = Array.isArray(p.devices) ? p.devices : [];
    const devices = list.map((d) => ({
        device: String(d.device ?? ""),
        firstLayer: Number(d.first_layer) || 0,
        lastLayer: Number(d.last_layer) || 0,
        layers: Number(d.layers) || 0,
        ...(typeof d.gpu_id === "string" && d.gpu_id ? { gpuId: d.gpu_id } : {}),
    })).filter((d) => d.device && d.layers > 0);
    if (!num || !devices.length) return null;
    const swa = Array.isArray(p.swa_layers) ? (p.swa_layers as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : [];
    return { numLayers: num, devices, swaLayers: swa };
}

/** The placement runs on ONE card. By `gpu_id` when the entry carries one and the card's id is known — the id both
 *  lists share, so it cannot land on the wrong card. By NAME otherwise (an older build), which is right only while
 *  the runner sees every card: an old build named cards by its own enumeration, so with GPU0 leased away a model
 *  on GPU1 said `CUDA0` and its layers were drawn on the wrong track. Nothing is ever matched by position. */
export function layersOnCard(placement: LayerPlacement, card: { id?: string | null; name: string }): LayerPlacement["devices"] {
    return placement.devices.filter((d) => (d.gpuId != null && card.id != null ? d.gpuId === card.id : d.device === card.name));
}

/** Parse a server `memory` object, or null when it cannot be trusted as a split.
 *
 *  Refuses on two counts, both because a WRONG split is worse than none: an absent object (the server says it
 *  cannot divide this figure — a loading row, an MLX runner), and one whose parts do not sum to the total it
 *  is meant to divide. The second is the server's invariant, verified to the byte on every model it reports,
 *  so a mismatch is a bug to report rather than a remainder to invent. */
export function memorySplit(raw: unknown, total: number): MemoryBreakdown | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Wire<WireMemoryBreakdown>;
    const n = (k: keyof WireMemoryBreakdown) => Number(m[k]) || 0;   // a key is OMITTED when zero, so missing IS zero here
    const out: MemoryBreakdown = {
        weights: n("weights"), kvCache: n("kv_cache"), compute: n("compute"),
        recurrentState: n("recurrent_state"), output: n("output"),
        projector: n("projector"), other: n("other"),
    };
    const sum = out.weights + out.kvCache + out.compute + out.recurrentState + out.output + out.projector + out.other;
    if (!(sum > 0)) return null;
    if (total > 0 && sum !== total) return null;
    return out;
}

/** The parts in the order a stack draws them, largest concern first — weights and context are what a user can
 *  act on, the rest is overhead they cannot. Zero parts are dropped, so a text-only model shows no projector
 *  slice rather than an empty label. */
export const MEMORY_PARTS: { key: keyof MemoryBreakdown; label: string }[] = [
    { key: "weights", label: "weights" },
    { key: "kvCache", label: "context (KV cache)" },
    { key: "recurrentState", label: "context (recurrent state)" },
    { key: "projector", label: "vision encoder" },
    { key: "compute", label: "compute buffers" },
    { key: "output", label: "logits" },
    { key: "other", label: "unrecognised" },
];

/** The parts that are worth drawing, in stack order. */
export function memoryParts(m: MemoryBreakdown): { key: keyof MemoryBreakdown; label: string; bytes: number }[] {
    return MEMORY_PARTS.map((p) => ({ ...p, bytes: m[p.key] })).filter((p) => p.bytes > 0);
}

/** What the CONTEXT costs — the one figure that answers "would less context help?". `recurrent_state` is
 *  added in because for this question it is the same thing as a KV cache; only the LABEL must not be. */
export const contextBytes = (m: MemoryBreakdown): number => m.kvCache + m.recurrentState;

/** One poll: what was resident at `t`. Capacity rides along because it can change (a card appears, another
 *  process frees memory) and because a sample read back from history must know the ceiling it was drawn against. */
export interface ResourceSample {
    t: number;
    models: ModelResidency[];
    capacity: Capacity | null;
    /** Models the server said were LOADING at this instant — a `load.start` with no `load.complete` yet.
     *
     *  For most of a load there is no runner object in Ollama at all, so `/api/ps` does not report the model
     *  coarsely, it does not report it AT ALL — while the device's own `free_memory` has already dropped by
     *  the whole allocation. Read literally that is a card 92% full with nothing accounting for it, and the
     *  panel said exactly that: "unattributed 87.82 GiB", beside a model row calling the model off-box. Both
     *  claims came from treating an absence as a measurement. This is the evidence that it is neither. */
    loading?: string[];
    /** The record has a HOLE immediately before this sample — the stream told us it dropped frames for us
     *  (`lostSince`), so what happened between the previous reading and this one was never delivered.
     *
     *  It is a separate fact from a sampling gap and cannot be derived from the timestamps: the two readings
     *  either side of a drop can be milliseconds apart, so `maxGapMs` sees nothing wrong and draws a straight
     *  line across the interval the server has just said it cannot account for. Frames are dropped when a
     *  subscriber falls behind, which is when the box is busiest — so the line would be interpolated over
     *  exactly the movement it exists to show. */
    gapBefore?: true;
}

/** Raw `/api/ps` entry → residency. `gpus` is ABSENT for a CPU-resident model — that is the contract, and it
 *  is why an empty device map plus a zero `size_vram` reads as "on the CPU" rather than "placement unknown". */
export function residencyFrom(raw: unknown): ModelResidency {
    const m = raw as Wire<ProcessModelResponse>;
    const size = Number(m.size) || 0;
    const vram = Number(m.size_vram) || 0;
    const perDevice: Record<string, number | null> = {};
    const gpus = Array.isArray(m.gpus) ? m.gpus : [];
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
        // WHAT the VRAM holds. Each device carries its own split summing to that device's own total, so a
        // split model's cards are decomposed separately rather than sharing one average that describes
        // neither. Absent stays absent — see `memorySplit`.
        ...(() => {
            const whole = memorySplit(m.memory, vram);
            const per: Record<string, MemoryBreakdown> = {};
            for (const g of gpus) {
                const one = memorySplit(g.memory, Number(g.size_vram) || 0);
                if (one) per[String(g.gpu_id ?? "")] = one;
            }
            const host = memorySplit(m.memory_host, 0);
            return {
                ...(whole ? { memory: whole } : {}),
                ...(Object.keys(per).length ? { perDeviceMemory: per } : {}),
                ...(typeof m.weights_on_disk === "number" ? { weightsOnDisk: m.weights_on_disk } : {}),
                ...(host ? { memoryHost: host } : {}),
                ...((() => { const pl = placementFrom(m.placement); return pl ? { placement: pl } : {}; })()),
            };
        })(),
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
        const dev = cap?.devices.find((d) => d.id === id);
        // A card can stop being reported while a model is still resident on it (a driver crash, a reset). The
        // honest label says the device is gone rather than printing an id as though it were still there.
        const name = dev?.name ?? (cap ? `device ${id} (no longer reported)` : `device ${id}`);
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

// --- series + tracks: what the panel can plot, and how the user may combine it ------------------------------

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

/** How the box CHANGED between two capacity readings. Not every difference is a different machine, and the
 *  distinction decides whether the history survives:
 *
 *  - `same` — nothing that matters moved.
 *  - `shrank` — a device stopped being reported. A card can vanish mid-session (a driver crash, a GPU reset,
 *    a container losing its device), and that is an INCIDENT: the samples leading up to it are the most
 *    valuable ones on screen, so they are kept and the vanished pool's series simply ends.
 *  - `grew` — a device appeared. Nothing measured before is invalidated by that either.
 *  - `switched` — a device's identity changed under the same id (different name, runner or total), or the
 *    host total changed. THAT is another machine, and its readings cannot be redrawn against this one's
 *    ceilings: an 18 GiB band against a 12 GiB pool clips to full height and looks like a measurement.
 */
export function boxChange(prev: Capacity | null, next: Capacity | null): "same" | "grew" | "shrank" | "switched" {
    if (!prev || !next) return "same";                       // nothing to compare against
    if (prev.host.totalBytes !== next.host.totalBytes) return "switched";
    const ident = (d: DeviceCapacity) => `${d.name}:${d.runner}:${d.totalBytes}`;
    const before = new Map(prev.devices.map((d) => [d.id, ident(d)]));
    const after = new Map(next.devices.map((d) => [d.id, ident(d)]));
    for (const [id, sig] of after) if (before.has(id) && before.get(id) !== sig) return "switched";
    const gone = [...before.keys()].filter((id) => !after.has(id));
    const added = [...after.keys()].filter((id) => !before.has(id));
    if (gone.length && added.length) return "switched";      // one replaced by another is a different box
    if (gone.length) return "shrank";
    if (added.length) return "grew";
    return "same";
}

/** Samples that describe the CURRENT box./** Samples that describe the CURRENT box. Anything recorded against a different machine is dropped rather than
 *  redrawn against a ceiling it was never measured under.
 *
 *  `switched` is the case that bites: a sample taken before capacity was first known carries none, and a
 *  capacity-less sample gets the CURRENT capacity backfilled at render. On a normal open that is right (it was
 *  measured moments ago on this box). After a backend SWITCH it is a category error — an 18 GiB reading from a
 *  CUDA server, backfilled with a Mac's 16 GiB pool, clips to the full height and looks like a measurement. So
 *  when the box changed, an unattributable sample is dropped rather than assumed to belong to either machine. */
export function sameBoxOnly(samples: ResourceSample[], cap: Capacity | null, switched = false): ResourceSample[] {
    if (!cap) return samples;   // capacity unknown → nothing to contradict; keep what we have
    // Compared through boxChange, not by whole signature: a sample taken while a now-vanished card was still
    // reported describes THIS machine, one card ago. Comparing signatures dropped exactly the samples that
    // show what happened just before the card went — the reason to look at all.
    return samples.filter((s) => (s.capacity ? boxChange(s.capacity, cap) !== "switched" : !switched));
}
