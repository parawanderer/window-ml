// resource-bands.ts — how ONE device's (or the host's) capacity decomposes into drawable bands at one instant.
//
// A band is the unit the chart actually fills, so the arithmetic that decides how tall each one is lives here
// rather than beside the drawing: `deviceBands` and `hostBands` answer "what is in this pool right now", and
// `stepBands`/`bandEdge` answer "where does it sit once the stack below it has taken its space".
//
// The rule that shapes all of it: a device decomposes into THREE bands (attributed / other / free), never two.
// A device's `free` is not capacity minus our models, because processes that are not Ollama hold VRAM too, and
// a per-device 0 under a non-zero total is UNKNOWN rather than zero. `residualNotes` is where each residual
// band explains itself in its OWN backend's terms, which is why the notes are constants here and not strings
// at the call site: CUDA, HIP, host RAM and unified memory are four different explanations of the same gap.

import { MemoryBreakdown, ModelResidency, ResourceSample, DeviceCapacity } from "./resource-model";

/** What a band IS, which decides how it draws and whether it can be explained. `unknown` is the one that
 *  earns its place: a per-device figure of 0 under a non-zero total means the server did not attribute it,
 *  and drawing that as `free` would claim the card is empty when it is not. */
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

/** What the residual is CALLED once it is small enough to be the driver's own context rather than another
 *  process: under DRIVER_OVERHEAD_FLOOR a gap is the runtime's fixed cost, and naming it that stops a reader
 *  hunting for a process that does not exist. */
export const DRIVER_BAND_LABEL = "driver overhead";

/** Below this, a difference between the whole model and what reached the device is bookkeeping rather than a
 *  spill — the two figures are taken independently, so they are not expected to agree to the byte. */
export const SPILL_FLOOR = 8 * 1024 * 1024;

/** The fallback a legend uses for a residual band with no note of its own — backend-NEUTRAL, since it can be
 *  read under any pool; every band `deviceBands`/`hostBands` builds now carries its own, backend-specific note. */
export const OTHER_BAND_NOTE = "In use but not accounted for by a model's reported buffers.";

/**
 * WHAT A RESIDUAL IS, IN THIS BACKEND'S TERMS. The unattributed part of a card is mostly each runner's own GPU
 * context, which no buffer line reports — but that is a CUDA context on NVIDIA, a HIP context under ROCm on AMD,
 * and something else again on Vulkan, and the 0.7–1.8 GiB range was measured on CUDA only. Host RAM is a
 * different question altogether (the operating system and every other program), and on unified memory (a Mac)
 * the GPU and the system share one pool. Saying "CUDA context" under System RAM, a Mac or an AMD card was a fact
 * about a different machine.
 */
export function residualNotes(runner: string): { context: string; unattributed: string; driver: string } {
    const context = runner === "CUDA" ? "CUDA context" : runner === "ROCm" ? "HIP (ROCm) context" : "GPU backend's own context";
    return {
        context,
        unattributed: `In use but not accounted for by a model's reported buffers — mostly each loaded model's ${context}`
            + (runner === "CUDA" ? " (0.7-1.8 GiB per model, which no buffer line reports)" : ", which no buffer line reports")
            + ", plus anything else on the card.",
        driver: `Ollama's own ${context}, held on a card whether or not a model is loaded. Not another process.`,
    };
}

/** Host RAM's residual on a machine with separate GPUs: everything that is not a model. */
export const HOST_RAM_NOTE = "In use by everything that is not a model's weights or cache — the operating system, other "
    + "programs and ollama's own processes. Expected; the part of a model that spilled into RAM is drawn as that model.";

/** A unified-memory machine's residual (a Mac): the GPU and the system share ONE pool. */
export const UNIFIED_NOTE = "In use by everything that is not a model — the operating system, other apps and GPU work "
    + "outside ollama. The GPU and the system share this one pool, so this is memory a model competes with.";

/** One drawable slice of a pool: how many bytes, what kind, and the words it explains itself with. This is the
 *  unit the chart fills, so a band carries its own label and note rather than the drawing deciding them, which
 *  is what keeps a residual's explanation in its own backend's terms. */
export interface Band {
    key: string;
    label: string;
    bytes: number;
    kind: BandKind;
    /** Set on a `model` band, so the chart can colour it with the model's own colour and hide it with the row. */
    model?: string;
    /** What THIS band's bytes are holding, when the server reported it — so hovering a model can subdivide
     *  its area in place rather than opening a separate picture of the same memory. Attached here, where the
     *  device is known, because a split model's cards decompose differently and one average describes
     *  neither. */
    parts?: MemoryBreakdown;
    /** What this band IS, in a sentence, for its legend entry. Set wherever the band is built, since that is
     *  where the evidence for the claim is known. */
    note?: string;
    /** The model a residual band BELONGS to without being the model — a runner's own overhead, or a load in
     *  flight — so it can be tinted with that model's colour. Never its identity: it is not the model's
     *  reported memory, hides with nothing and hovers as nothing. */
    of?: string;
}

/** The part of a card no process ollama can see accounts for, under `processes_scope: "pid_namespace"`.
 *  Not "driver context" and not "nothing": another container's process holding 2.6 GB on a card was
 *  measured exactly here, absent from the list and present in `free`. */
export const OUTSIDE_VIEW_LABEL = "outside ollama's view";

const OUTSIDE_VIEW_NOTE = "In use on this card by nothing ollama can see. It runs in a container, and the driver lists only "
    + "the processes in its own namespace, so another container's or the host's process is counted here and never named.";

const UNOWNED_NOTE = "In use on this card and owned by no listed process: the driver's own reservation.";

/**
 * WHICH BANDS OF A STACK ARE DRAWN AS STEPS: a model's own band, and a residual that belongs to a model (its
 * runner's overhead, a runner `/api/ps` has not caught up with) — but only in an unbroken run from the BOTTOM of
 * the stack. Tops are cumulative, so a band's floor is the top of the band below; a stepped band stacked on a band
 * drawn as a line (a loading runner, whose memory climbs) would hold its top while its floor rose, and the
 * inverted polygon fills as a wedge of the wrong colour. The first band that is a line ends the run.
 */
export function stepBands(order: string[], identity: Record<string, string | undefined>, tint: Record<string, string | undefined>): Set<string> {
    const out = new Set<string>();
    for (const k of order) {
        if (k === "free" || !(identity[k] || (tint[k] && !k.startsWith("load:")))) break;
        out.add(k);
    }
    return out;
}

/**
 * ONE EDGE OF A STACKED BAND, as `[sample index, value]` vertices in draw order. `stepped`: hold the previous value
 * up to each sample, then drop to its own (a model's memory is piecewise-constant). A line with a `base` — a band
 * stacked above stepped ones — turns the base's corners and interpolates only its own thickness above it: the top
 * of a constant residual on a model that arrives is that model's step, shifted up by the residual. Interpolating
 * the cumulative value instead climbed before the step and fell under its floor after an eviction.
 */
export function bandEdge(series: number[], stepped: boolean, base: number[] | null = null): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < series.length; i++) {
        if (i > 0 && stepped) out.push([i, series[i - 1] ?? 0]);
        else if (i > 0 && base && base[i - 1] !== base[i]) {
            const b0 = base[i - 1] ?? 0, b1 = base[i] ?? 0;
            const t0 = (series[i - 1] ?? 0) - b0, t1 = (series[i] ?? 0) - b1;
            // A HAND-OFF: the base rises as this band's thickness falls, or the reverse. That is the same bytes changing
            // owner at this sample (a load becoming the model it loaded), so the thickness is held up to the corner, as
            // the step below it is. Interpolated, the load thinned to nothing across the interval while the model's step
            // waited for the sample, and the stack drew a dip to zero followed by a spike to full.
            const handOff = (b1 - b0) * (t1 - t0) < 0;
            out.push([i, b0 + (handOff ? t0 : t1)]);
        }
        out.push([i, series[i] ?? 0]);
    }
    return out;
}

/** Every band key present anywhere in the window, in a STABLE order — models first (alphabetical, so a row doesn't jump
 *  when one evicts and reloads), then the residual, then free. Without a fixed order the stack would reshuffle between
 *  samples and the areas would cross.
 *
 *  A MODEL LOADING IN THE WINDOW STACKS LAST among the models, with its load directly on top. Its memory arrives first
 *  as `load:<model>` (nothing attributes it to the model yet) and then becomes the model's own band — one thing — but
 *  the load sat above EVERY model while the band it turned into sat in alphabetical order, so the allocation jumped
 *  across the stack the moment it was assigned. The model is moved rather than the load: a `load:` band is a curve,
 *  not a step, and stepping stops at the first band that is not (`stepBands`), so a load in the middle of the models
 *  would have turned every model above it into a slope. */
export function bandOrder(frames: Band[][]): string[] {
    const models = new Set<string>(), rest = new Set<string>(), ctx = new Map<string, string>(), loading = new Map<string, string[]>();
    for (const bands of frames) for (const b of bands) {
        if (b.kind === "model" || b.kind === "unknown") models.add(b.key);
        // A runner's overhead rides directly on its own model, so the pair reads as what that model costs.
        else if (b.key.startsWith("ctx:") && b.of) ctx.set(`m:${b.of}`, b.key);
        else if (b.kind === "other" && b.key !== "other") rest.add(b.key);
    }
    for (const k of rest) {
        const m = /^(?:load|runner):(.+)$/.exec(k);
        if (m && models.has(`m:${m[1]}`)) (loading.get(`m:${m[1]}`) ?? loading.set(`m:${m[1]}`, []).get(`m:${m[1]}`)!).push(k);
    }
    const attached = new Set([...loading.values()].flat());
    const byRank = [...rest].filter((k) => !attached.has(k)).sort((a, b) => residualRank(a) - residualRank(b) || a.localeCompare(b));
    // An overhead whose model never appears in the window still has to be drawn — just not beside anything.
    const orphans = [...ctx].filter(([m]) => !models.has(m)).map(([, k]) => k);
    const withCtx = (k: string) => (ctx.has(k) ? [k, ctx.get(k)!] : [k]);
    const sorted = [...models].sort();
    const settled = sorted.filter((k) => !loading.has(k)).flatMap(withCtx);
    // runner:<m> before load:<m>: the runner is the model's measured process, the load the unattributed growth around it.
    const arriving = sorted.filter((k) => loading.has(k)).flatMap((k) => [...withCtx(k), ...loading.get(k)!.sort((a, b) => b.localeCompare(a))]);
    return [...settled, ...arriving, ...orphans, ...byRank, "other", "free"];
}

/** A residual band's position in the stack. A runner's overhead sits directly on its own model, so the pair
 *  reads as what that model costs; then loads in flight, ollama's helpers, other tenants, and the unlisted
 *  remainder last. Exported for the chart, which must order EVERY key or a band silently drops out. */
export function residualRank(key: string): number {
    if (key.startsWith("load:") || key.startsWith("runner:")) return 1;
    if (key === "helper") return 2;
    if (key.startsWith("proc:")) return 3;
    return 4;
}

/**
 * MEMORY BEING ALLOCATED FOR A MODEL THAT IS STILL LOADING — per sample, in bytes, or 0.
 *
 * For most of a load there is no runner object at all, so nothing attributes the memory arriving on the card:
 * it shows up only as the card's unattributed residual, and the model's own band appears when the load ends.
 * The drilled-in view draws only what IS attributed to the model, so it showed the model springing into
 * existence at full size and dropped exactly the allocation curve a reader zoomed in to see. This attributes
 * the residual's GROWTH during that model's load — above its level just before the load began, which is the
 * driver context and anything else already there — to the load, for the samples where the model is not yet
 * resident. After a load ends the runner takes it over within a sample, so a short grace covers the poll that
 * has not caught up yet; a sample where the model's band already exists is 0, never double-counted.
 */
export function pendingAllocation(frames: Band[][], times: number[], model: string, loads: { t: number; until?: number }[], graceMs = 5000): number[] {
    const residual = (bands: Band[]) => bands.filter((b) => b.kind === "other" || b.kind === "unknown").reduce((n, b) => n + b.bytes, 0);
    return frames.map((bands, i) => {
        if (bands.some((b) => b.model === model)) return 0;
        // THE RUNNER ITSELF, when the driver lists it: the process's own memory is the allocation, measured
        // rather than inferred from what else moved on the card.
        const direct = bands.find((b) => b.key === `load:${model}`);
        if (direct) return direct.bytes;
        const t = times[i];
        const load = loads.find((l) => l.until != null && t >= l.t && t <= l.until + graceMs);
        if (!load) return 0;
        // The residual as it stood just BEFORE the load began: the last sample at or before its start, else the
        // first sample of the run (a load that began before anything was measured).
        let base = 0;
        for (let j = 0; j < frames.length && times[j] <= load.t; j++) base = residual(frames[j]);
        if (times[0] > load.t) base = residual(frames[0]);
        return Math.max(0, residual(bands) - base);
    });
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
        // THIS DEVICE'S split, never the model's total: on a split model the cards hold different things, and
        // the whole-model figure would decompose a card's band into parts that are not on it.
        const parts = m.perDeviceMemory?.[deviceId] ?? (count <= 1 ? m.memory : undefined);
        bands.push({ key: `m:${m.model}`, label: m.model, bytes: share, kind: "model", model: m.model,
            ...(parts ? { parts } : {}) });
    }
    if (unknown > 0) bands.push({ key: "unknown", label: "placement unknown", bytes: unknown, kind: "unknown" });
    // Everything in use that we cannot attribute to a model of ours. Clamped: `free` is sampled independently
    // of `ps`, so a race can make the arithmetic go slightly negative.
    // `ps` and `/api/info` are SEPARATE samples, so a model can be reported resident a poll before the free
    // bytes catch up. Read literally, `total - free` is then just the idle overhead while attribution is the
    // whole model — the residual clamps to zero and the line COLLAPSES to the floor for one sample before
    // springing back, which looks like memory that was freed and re-taken. Attribution is a lower bound on
    // what is in use: what we can see resident is in use whatever the other sample says yet.
    // THE DRIVER'S OWN LIST, when the server reports it: the residual is then named process by process instead
    // of guessed from its size.
    // Only a list WITH a scope: an earlier server build listed bare `{pid, used_memory}` entries with neither the
    // scope nor the runner marks, and read as authoritative that list names ollama's own runner as a stranger.
    const named = cap.processesScope ? processBands(cap, bands) : [];
    const listed = named.reduce((n, b) => n + b.bytes, 0);
    bands.push(...named);
    const used = Math.max(0, cap.totalBytes - cap.freeBytes, attributed + unknown + listed);
    const residual = Math.max(0, used - attributed - unknown - listed);
    if (cap.processesScope) {
        // What no listed process accounts for. With every process listed it is the driver's own; in a
        // container it is whatever ollama cannot see — which may be another tenant, and must not be called
        // overhead just because it is small.
        const all = cap.processesScope === "all";
        bands.push({ key: "other", bytes: residual, kind: "other",
            label: all ? DRIVER_BAND_LABEL : OUTSIDE_VIEW_LABEL, note: all ? UNOWNED_NOTE : OUTSIDE_VIEW_NOTE });
    } else {
        // Name the residual by MAGNITUDE: under the floor it is the driver's own context (present even on an
        // idle card), above it there is genuinely something else on the card worth telling the reader about —
        // UNLESS a load is in flight, in which case we know what it is and "unattributed" is simply wrong. A
        // loading model holds its allocation before any runner exists to report it, so the residual IS the load.
        const small = residual < DRIVER_OVERHEAD_FLOOR;
        bands.push({ key: "other", bytes: residual, kind: "other",
            label: small ? DRIVER_BAND_LABEL : loadingLabel(sample) ?? OTHER_BAND_LABEL,
            note: small ? residualNotes(cap.runner).driver : residualNotes(cap.runner).unattributed });
    }
    bands.push({ key: "free", label: "free", bytes: Math.max(0, cap.freeBytes), kind: "free" });
    return bands;
}

/**
 * THE RESIDUAL, PROCESS BY PROCESS — one band per thing the driver lists on this card that is not already a
 * model's reported memory.
 *
 * - A RUNNER's band is its process minus its model's share of this card: the CUDA context and whatever else
 *   no buffer line reports. Measured per runner, and it is not a constant (444 MiB beside 633 MiB on the same
 *   box), which is why it is drawn per runner rather than as a fixed allowance.
 * - A LOADING runner is drawn whole, as the load: `/api/ps` has no figures for it yet, so there is nothing to
 *   subtract, and its memory climbing IS the allocation curve.
 * - A runner whose model this sample's `/api/ps` does not yet place here is drawn whole under its model's name,
 *   rather than as a multi-gigabyte "overhead" that is really the model a poll behind.
 * - Ollama's HELPERS (fit probes, device discovery) are one band: they are not tenants, and during a load they
 *   appear on every card at once, which unnamed would read as a stranger arriving everywhere.
 * - Anything else is a real TENANT, named by executable and pid.
 */
function processBands(cap: DeviceCapacity, models: Band[]): Band[] {
    const out: Band[] = [];
    let helpers = 0;
    for (const p of cap.processes ?? []) {
        const m = p.runner?.model;
        if (m && p.runner!.loading) {
            out.push({ key: `load:${m}`, label: `loading ${m}`, bytes: p.usedBytes, kind: "other", of: m,
                note: `${m}'s runner, still loading: its memory is the allocation arriving, before the server reports any figures for it.` });
        } else if (m) {
            const share = models.filter((b) => b.model === m).reduce((n, b) => n + b.bytes, 0);
            if (share > 0) {
                out.push({ key: `ctx:${m}`, label: `${m} overhead`, bytes: Math.max(0, p.usedBytes - share), kind: "other", of: m,
                    note: `What ${m}'s runner holds on this card beyond the model's reported buffers: its ${residualNotes(cap.runner).context} and anything else no buffer line reports.` });
            } else {
                out.push({ key: `runner:${m}`, label: `${m} runner`, bytes: p.usedBytes, kind: "other", of: m,
                    note: `${m}'s runner. The model's own figures for this card have not arrived yet.` });
            }
        } else if (p.helper) {
            helpers += p.usedBytes;
        } else {
            out.push({ key: `proc:${p.pid}`, label: p.name ? `${p.name} (pid ${p.pid})` : `pid ${p.pid}`, bytes: p.usedBytes, kind: "other",
                note: "Another process on this card. The driver lists it, and it is not one of ollama's." });
        }
    }
    if (helpers > 0) out.push({ key: "helper", label: "ollama helper", bytes: helpers, kind: "other",
        note: "A process ollama started that serves no model: a fit probe or device discovery. Brief, and not a tenant." });
    return out;
}

/** What a large residual is, when a load explains it: `loading gemma4:31b`, or a count when several are.
 *  Null when nothing is loading, which is when the residual is genuinely unattributed. */
function loadingLabel(sample: ResourceSample): string | null {
    const l = sample.loading;
    if (!l?.length) return null;
    return l.length === 1 ? `loading ${l[0]}` : `loading ${l.length} models`;
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
        // UNIFIED memory only: there the pool holds the whole model, so the model's own split describes this
        // band exactly. On a discrete box this band is the SPILL, and the split we hold describes what is on
        // the GPU — a different quantity, so it is left off rather than drawn against the wrong bytes.
        // (`memoryHost` is the split OF the spill; surfacing it here is worth doing once the panel has a
        // shape for it.)
        bands.push({ key: `m:${m.model}`, label: m.model, bytes, kind: "model", model: m.model,
            ...(unified && m.memory ? { parts: m.memory } : {}) });
    }
    const used = Math.max(0, host.totalBytes - host.freeBytes);
    bands.push({ key: "other", label: OTHER_BAND_LABEL, bytes: Math.max(0, used - attributed), kind: "other",
        note: unified ? UNIFIED_NOTE : HOST_RAM_NOTE });
    bands.push({ key: "free", label: "free", bytes: Math.max(0, host.freeBytes), kind: "free" });
    return bands;
}
