// resource-capacity.ts — what the box HAS, from Ollama's `/api/info`: each device's totals, free memory, processes
// and links, the host's RAM, the cards the driver could not read, and the box's measured decode profile.
//
// `parseInfo` is the one reader of that body, and absent is never zero here: a device whose free memory the server
// did not report is UNKNOWN, which is why the types keep those fields optional. Split out of resource-model.ts.

import type { Wire, UnavailableGPU, GPUInfo, GPUProcess, BoxProfile as WireBoxProfile, ProfileDevice, ProfileFailure, InfoResponse } from "./events-wire";
import { Topology, topologyFrom } from "./resource-topology";

/** The backend a device runs on, as the server names it; the open string admits one we do not know yet. */
export type Runner = "CUDA" | "ROCm" | "Metal" | (string & {});

// Runners whose memory is a pool genuinely SEPARATE from system RAM. Anything else (Metal today) is treated
// as unified — the conservative default, because the failure mode of guessing "discrete" is a summed number
// that is simply wrong, while guessing "unified" only declines to add two figures.
const DISCRETE_RUNNERS = new Set(["CUDA", "ROCm"]);

/** Is this runner's memory a pool SEPARATE from system RAM (CUDA, ROCm)? Anything else is treated as unified. */
export const isDiscrete = (runner: string | null | undefined): boolean => !!runner && DISCRETE_RUNNERS.has(runner);

/** One accelerator as `/api/info` reports it: its totals and free memory, processes, links and utilization. */
export interface DeviceCapacity {
    id: string;
    /** The server's label ("CUDA0"), not a marketing name. */
    name: string;
    /** What the card IS, in the driver's own words ("NVIDIA RTX PRO 6000 Blackwell Workstation Edition") —
     *  `description` on a patched server, the same string `unavailable_gpus[].name` carries for a card that has
     *  faulted. Absent on every build that does not send it; never derived from `name`, which is the backend's
     *  enumeration label. */
    description?: string;
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
    /** The vendor's compute capability ("12.0") and driver version ("13.2"), verbatim. Reference facts for a
     *  hover, never used in a decision: absent on Metal and on any server that does not report them, and a
     *  panel that BRANCHED on them would be encoding hardware knowledge that rots. */
    compute?: string;
    driver?: string;
    /** The bus address (`pci_id`), the same form `unavailable_gpus` and the topology's links use — which is
     *  what lets a link, or a fault, be joined to a DRAWN card. `gpu_id` cannot: it is an index into one
     *  enumeration and can change when a card drops out and returns. Absent where the backend has none (Metal). */
    pciId?: string;
    /** The card's fixed CEILINGS, read once at discovery — never live readings. `memoryBandwidth` is derived by
     *  the server from the two fields beside it (bus/8 × clock × 2, checked against published GDDR7, GDDR6X and
     *  HBM2e figures); `pcieMaxWidth` is the NARROWER of card and slot, since a link cannot train wider than its
     *  narrower end (x8 on a board that splits its lanes, though each card says x16). Each absent, never zero,
     *  where it could not be read. */
    /** The processes the driver lists on this card, each joined by pid to ollama's own runners (`processes`
     *  on a patched server). Absent on every build before it, and then the residual is named by magnitude. */
    processes?: DeviceProcess[];
    /** Which processes `processes` CAN contain — read it before trusting an empty list. `"all"`: ollama shares
     *  the host's pid namespace and every process on the card is listed. `"pid_namespace"`: ollama is in a
     *  container and the driver lists only its own namespace, so another container's or the host's process
     *  holds memory that `free` counts and nothing names. Any other value is treated as the second. */
    processesScope?: string;
    memoryBandwidth?: number;
    /** What this card ACHIEVES at decode, measured on this box (`compute.profile.devices[]`, joined by `pci_id`) —
     *  the rated `memoryBandwidth` is a ceiling, this is what a model actually gets. Absent until the box has been
     *  measured, and on every build before `ollama-slop:correction`. */
    decodeProfile?: DecodeProfile;
    memoryBusWidthBits?: number;
    memoryClockMaxMhz?: number;
    pcieMaxGeneration?: number;
    pcieMaxWidth?: number;
    /** How busy the card is, as the DRIVER averages it (NVML's own window, 1/6 s to 1 s by product, not
     *  reported). `gpuPercent` and `memoryPercent` are independent: an AMD iGPU has the first and no file for
     *  the second. `0` is idle; ABSENT is "not read" — and a missing reading is not a fault signal (a dead card
     *  and a card without the counter answer alike; faults come from `unavailable_gpus`). */
    utilization?: { gpuPercent?: number; memoryPercent?: number };
}

/** One process the driver lists on a card. The join to ollama's runners is by pid, which holds because NVML
 *  reports pids in the CALLER's namespace. */
export interface DeviceProcess {
    pid: number;
    usedBytes: number;
    /** The executable (`/proc/<pid>/comm`). Absent when unreadable. */
    name?: string;
    /** One of ollama's runners, serving this model — named the way `/api/ps` names it. While `loading` its
     *  memory is still climbing and `/api/ps` has no figures for it, so nothing is subtracted from it. */
    runner?: { model: string; loading: boolean };
    /** Started by ollama and serving no model: a fit probe, or device discovery (a process named `ollama`,
     *  briefly holding ~550 MiB on EVERY card). Not a tenant, though for a second it looks exactly like one. */
    helper: boolean;
}

/** The host's system RAM as `/api/info` reports it. */
export interface HostCapacity {
    cores: number | null;
    totalBytes: number;
    freeBytes: number;
    /** 0 is reported on macOS whether or not swap exists, so 0 means UNKNOWN, not "no swap". */
    swapFreeBytes: number | null;
}

/** A GPU the server can SEE but cannot USE. It is not a device with a problem — it is absent from
 *  `supported_gpus` entirely, which is the worst shape a hardware fault can take in a UI: `/api/ps` looks
 *  normal, `/api/info` returns one healthy card, every figure is internally consistent, and a two-GPU box
 *  with a dead card is byte-identical to a one-GPU box. One sat faulted for five and a half hours on the
 *  reference machine while the panel rendered perfectly.
 *
 *  It carries NO memory fields, deliberately: these devices hold nothing and can hold nothing, so there is
 *  nothing to add to a capacity. */
export interface UnavailableGpu {
    /** Bus address, and the IDENTITY — two cards in one machine share a `name`. */
    pciId: string;
    /** Both may be ABSENT: under `not_reported_by_driver` the kernel sees the card and the driver does not
     *  describe it, so there is nothing to read and nothing is invented. */
    name?: string;
    uuid?: string;
    /** The label (`CUDA1`) this bus address had in the last enumeration that included it — `last_name` on a server
     *  that remembers it. A faulted card has no label TODAY, and the indices can shift once it drops out. */
    lastName?: string;
    /** When the server last saw that address healthy (`last_seen`, epoch ms) — exact within one run, within ten
     *  minutes across a restart (the server keeps its record in a file beside the models). */
    lastSeen?: number;
    /** A stable token to branch on. `not_offered_by_backend` is HEALTHY — a card that answers every query
     *  which no backend claimed, usually `CUDA_VISIBLE_DEVICES` — so it must never draw a warning. */
    reason: string;
    /** The DRIVER's own wording, passed through unparaphrased so it can be searched verbatim in vendor
     *  docs. "GPU requires reset" is NVIDIA's string, not ours — render it as given. */
    detail?: string;
    /** What a person should DO, in plain words. Empty means no known action, NOT that nothing is wrong. */
    recovery?: string;
    /** The PCIe view, read without the driver's help. Deliberately excludes the link speed and width: both
     *  are LIVE readings rather than capabilities (an idle Blackwell drops to 2.5 GT/s and would read as 12x
     *  degraded), and `width < max_width` is by design wherever a board splits its lanes. The error counters
     *  are the part worth having — non-zero points at the SLOT rather than the card, and a card blamed for a
     *  bad slot gets replaced while the fault stays put. */
    bus?: { present?: boolean; fatalErrors?: number; nonFatalErrors?: number };
}

/**
 * WHAT A BUS ADDRESS WAS LAST SEEN AS, so a card that has faulted can be named: once a card fails it is absent
 * from the enumeration, so the server cannot say which "CUDA1" it was — and the indices can shift when a card drops
 * out, so today's CUDA1 may be a different card. What the panel CAN say honestly is what it last saw at that
 * address. Kept per backend, merged from each capacity reading.
 */
export type SeenCards = Record<string, { name: string; description?: string }>;

/** Merge a capacity reading into the cards seen on this backend, so a card that later stops reporting can still be named. */
export function noteSeenCards(seen: SeenCards, cap: Capacity | null): SeenCards {
    if (!cap) return seen;
    let out = seen;
    for (const d of cap.devices) {
        if (!d.pciId) continue;
        const was = seen[d.pciId];
        if (was?.name === d.name && was?.description === d.description) continue;
        out = { ...out, [d.pciId]: { name: d.name, ...(d.description ? { description: d.description } : {}) } };
    }
    return out;
}

/** Whether this entry is a FAULT worth telling someone about. `not_offered_by_backend` is a healthy card
 *  that nothing claimed, and drawing a warning triangle on it tells a person to reseat hardware that
 *  answered every query. */
export const isGpuFault = (g: UnavailableGpu): boolean => g.reason !== "not_offered_by_backend";

/** What the banner says about a fault BEYOND the driver's own words, or null when there is nothing to add.
 *  Only one reason earns a note today: AMD's `reset_in_progress` (the driver answered EBUSY) is USUALLY
 *  TRANSIENT — a successful amdgpu reset takes seconds — so drawn exactly like `reset_required` it tells
 *  someone to power-cycle a machine that is fixing itself. It stays a fault (the card really cannot take
 *  work right now), and the note says when it stops being a transient: when it persists. */
export function gpuFaultNote(g: UnavailableGpu): string | null {
    if (g.reason === "reset_in_progress") return "A reset is under way. This usually clears within seconds; it is only a problem if it persists.";
    return null;
}

/** Everything `/api/info` says the box has: its devices, the host, the cards the driver could not read, and its profile. */
export interface Capacity {
    devices: DeviceCapacity[];
    /** GPUs the server can see and cannot use. **An empty list does NOT mean "all healthy"** — it means
     *  nothing to report OR the server could not look, and the two are not distinguished at the source. So
     *  it may drive a warning and must never drive a reassurance: render nothing, never a tick. */
    unavailable: UnavailableGpu[];
    host: HostCapacity;
    /** Any unified device → device and host memory overlap, so they can never be stacked or summed. */
    unified: boolean;
    /** The server's OWN bound on a load making no progress (`OLLAMA_LOAD_TIMEOUT`, default 5 min), when it
     *  publishes one. Read it rather than hardcoding a duration: it is configurable per host, so a constant
     *  here would silently disagree with the machine it is describing.
     *
     *  It is a STALL bound, NOT a total. The server gives up when a load stops progressing for this long; a
     *  load that keeps progressing runs as long as it needs and the server will not kill it. Measured on the
     *  box, elapsed time cannot stand in for it in either direction: the SAME 142 GB model took 38.8 s warm
     *  and 64.2 s cold with nothing observable differing, and `qwen3.8:27b` spent 1.0 s on weights and 4.3 s
     *  building context — so four fifths of that load had nothing to do with model size, and a size-derived
     *  timeout is wrong in the direction that bites. Null when the server does not publish it. */
    loadStallTimeoutMs?: number | null;
    /** How the GPUs are connected to EACH OTHER — a property of each PAIR, never of a card. Null when the
     *  server does not report it, which must read as "not measured" and never as "no NVLink". */
    topology?: Topology | null;
    /** The box's measured decode profile's state (`compute.profile`); the per-card figures are on each device. */
    profile?: BoxProfile;
}

/** What capacity to hold after a poll answers. Capacity is a fact about the BOX, not about this poll: a null
 *  answer means THIS request learned nothing (a hiccup, a worker that had gone to sleep, a lost race), and
 *  forgetting what was already measured swaps the whole panel for the no-ceiling fallback until some later
 *  poll happens to succeed — which reads as the old chart randomly reappearing. A box that has NEVER answered
 *  still degrades, because there is nothing to keep. */
export function holdCapacity(current: Capacity | null, answered: Capacity | null): Capacity | null {
    return answered ?? current;
}

/** Parse `compute.unavailable_gpus[]`. Kept SEPARATE from `devices` rather than folded in with a state
 *  field, which is the trap: every consumer iterating the device list is correct today, and merging would
 *  make all of them wrong until each learned about the flag — failing OPEN, on hardware that is broken.
 *
 *  An entry with no `pci_id` is dropped: the bus address is the identity (two cards share a name), so an
 *  entry without one cannot be told from another, and a fault that cannot be attributed cannot be shown. */
export function unavailableFrom(raw: unknown): UnavailableGpu[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((x) => {
        const g = x as Wire<UnavailableGPU>;
        const pciId = String(g.pci_id ?? "").trim();
        if (!pciId) return [];
        const bus = g.bus && typeof g.bus === "object" ? g.bus : null;
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
        return [{
            pciId,
            reason: String(g.reason || "unknown"),
            // Absent rather than empty-string: under `not_reported_by_driver` the driver describes nothing,
            // and "" would render as a nameless card rather than as a card whose name is unknown.
            ...(g.name ? { name: String(g.name) } : {}),
            ...(g.uuid ? { uuid: String(g.uuid) } : {}),
            ...(g.last_name ? { lastName: String(g.last_name) } : {}),
            ...(g.last_seen && Number.isFinite(Date.parse(String(g.last_seen))) ? { lastSeen: Date.parse(String(g.last_seen)) } : {}),
            ...(g.detail ? { detail: String(g.detail) } : {}),
            ...(g.recovery ? { recovery: String(g.recovery) } : {}),
            ...(bus ? { bus: {
                ...(typeof bus.present === "boolean" ? { present: bus.present } : {}),
                ...(n(bus.pcie_fatal_errors) !== undefined ? { fatalErrors: n(bus.pcie_fatal_errors) } : {}),
                ...(n(bus.pcie_nonfatal_errors) !== undefined ? { nonFatalErrors: n(bus.pcie_nonfatal_errors) } : {}),
            } } : {}),
        }];
    });
}

/** A card's `processes` and `processes_scope`, or nothing on a server that reports neither. A scope with no
 *  list is an EMPTY list (the server omits an empty array), which is itself a reading; a list with no scope
 *  is kept without claiming completeness. An entry without a pid or a byte count is dropped. */
function processesOf(g: Wire<GPUInfo>): Partial<DeviceCapacity> {
    const scope = typeof g.processes_scope === "string" && g.processes_scope ? g.processes_scope : undefined;
    if (!Array.isArray(g.processes) && !scope) return {};
    const processes: DeviceProcess[] = (Array.isArray(g.processes) ? g.processes : []).flatMap((x) => {
        const p = (x ?? {}) as Wire<GPUProcess>;
        const pid = Number(p.pid), used = Number(p.used_memory);
        if (!Number.isFinite(pid) || !Number.isFinite(used) || used < 0) return [];
        const r = p.runner && typeof p.runner === "object" ? p.runner : null;
        return [{
            pid, usedBytes: used,
            ...(typeof p.name === "string" && p.name ? { name: p.name } : {}),
            ...(r && typeof r.model === "string" && r.model ? { runner: { model: r.model, loading: r.loading === true } } : {}),
            helper: p.ollama_helper === true,
        }];
    });
    return { processes, ...(scope ? { processesScope: scope } : {}) };
}

/** One card's measured decode behaviour (see {@link DeviceCapacity.decodeProfile}). */
export interface DecodeProfile {
    /** The bandwidth decode actually achieves, bytes/s. */
    bandwidth: number;
    /** The fixed cost of every token, whatever the model. */
    tokenOverheadMs?: number;
    /** What each layer costs beyond reading its weights — 25 µs is 1.6 ms of a 64-layer model's 14 ms token. */
    layerOverheadUs?: number;
    /** The worst disagreement between the fit and the timings it came from: a check on the fit, not a confidence. */
    fitErrorPct?: number;
}

/** The box profile's own state (`compute.profile`): whether it has been measured, and what could not be. It runs
 *  once per combination of GPUs, driver and engine, the first time the box is idle, so `pending` is ordinary. */
export interface BoxProfile {
    state: string;
    measuredAt?: number;
    /** A measurement that could not be made, with the engine's words — a result, not retried until something changes. */
    failures: { what: string; pciIds: string[]; error: string }[];
}

/** Read `compute.profile`: the per-card figures keyed by `pci_id` (to be joined onto the cards) and the state. */
function profileFrom(raw: unknown): { byPci: Map<string, DecodeProfile>; profile: BoxProfile } | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Wire<WireBoxProfile>;
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const nn = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const byPci = new Map<string, DecodeProfile>();
    for (const x of Array.isArray(o.devices) ? o.devices : []) {
        const d = x as Wire<ProfileDevice>;
        const bw = pos(d.bandwidth_bytes_per_sec);
        if (typeof d.pci_id !== "string" || !bw) continue;
        byPci.set(d.pci_id, { bandwidth: bw,
            ...(nn(d.token_overhead_ms) != null ? { tokenOverheadMs: nn(d.token_overhead_ms) } : {}),
            ...(nn(d.layer_overhead_us) != null ? { layerOverheadUs: nn(d.layer_overhead_us) } : {}),
            ...(nn(d.fit_error_pct) != null ? { fitErrorPct: nn(d.fit_error_pct) } : {}) });
    }
    const at = typeof o.measured_at === "string" ? Date.parse(o.measured_at) : NaN;
    const failures = (Array.isArray(o.failures) ? o.failures : []).map((x) => {
        const f = x as Wire<ProfileFailure>;
        return { what: String(f.what ?? ""), pciIds: Array.isArray(f.pci_ids) ? f.pci_ids.map(String) : [], error: String(f.error ?? "") };
    });
    return { byPci, profile: { state: typeof o.state === "string" ? o.state : "", ...(Number.isFinite(at) ? { measuredAt: at } : {}), failures } };
}

/** A card's fixed ceilings and its utilization reading, each kept only when it is a real number — absent is
 *  "could not read", and `0` survives as a reading (idle), never collapsed into absent or vice versa. */
function ceilingsOf(g: Wire<GPUInfo>): Partial<DeviceCapacity> {
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined);
    const u = g.utilization && typeof g.utilization === "object" ? g.utilization : null;
    const util = u ? { ...(pct(u.gpu_percent) != null ? { gpuPercent: pct(u.gpu_percent) } : {}),
                       ...(pct(u.memory_percent) != null ? { memoryPercent: pct(u.memory_percent) } : {}) } : null;
    return {
        ...(pos(g.memory_bandwidth_bytes_per_sec) ? { memoryBandwidth: pos(g.memory_bandwidth_bytes_per_sec) } : {}),
        ...(pos(g.memory_bus_width_bits) ? { memoryBusWidthBits: pos(g.memory_bus_width_bits) } : {}),
        ...(pos(g.memory_clock_max_mhz) ? { memoryClockMaxMhz: pos(g.memory_clock_max_mhz) } : {}),
        ...(pos(g.pcie_max_generation) ? { pcieMaxGeneration: pos(g.pcie_max_generation) } : {}),
        ...(pos(g.pcie_max_width) ? { pcieMaxWidth: pos(g.pcie_max_width) } : {}),
        ...(util && Object.keys(util).length ? { utilization: util } : {}),
    };
}

/** Parse an `/api/info` body into a `Capacity`, or null when it is not one (a stock server answers with the SPA's HTML). */
export function parseInfo(raw: unknown): Capacity | null {
    const r = raw as Wire<InfoResponse> | null;
    const c = r?.compute;
    if (!c || typeof c !== "object") return null;
    const sys = c.system_compute;
    if (!sys || typeof sys.total_memory !== "number") return null;
    const prof = profileFrom(c.profile);
    const devices: DeviceCapacity[] = (Array.isArray(c.supported_gpus) ? c.supported_gpus : []).flatMap((g) => {
        const total = Number(g.total_memory), free = Number(g.free_memory);
        const measured = typeof g.pci_id === "string" ? prof?.byPci.get(g.pci_id.trim()) : undefined;
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
            ...(g.compute ? { compute: String(g.compute) } : {}),
            ...(g.driver ? { driver: String(g.driver) } : {}),
            ...(typeof g.pci_id === "string" && g.pci_id.trim() ? { pciId: g.pci_id.trim() } : {}),
            ...(typeof g.description === "string" && g.description.trim() ? { description: g.description.trim() } : {}),
            ...ceilingsOf(g),
            ...(measured ? { decodeProfile: measured } : {}),
            ...processesOf(g),
        }];
    });
    // The server's own stall bound, when it publishes one. Absent on every build before it and on every
    // stock Ollama, so null means "this host states no bound", never "there is none".
    const stall = Number((raw as { load_stall_timeout_ms?: unknown })?.load_stall_timeout_ms);
    return {
        devices,
        unavailable: unavailableFrom(c.unavailable_gpus),
        host: {
            cores: typeof sys.cpu_cores === "number" ? sys.cpu_cores : null,
            totalBytes: sys.total_memory,
            freeBytes: typeof sys.free_memory === "number" ? sys.free_memory : 0,
            swapFreeBytes: sys.free_swap ? sys.free_swap : null,   // 0 → unknown (see HostCapacity)
        },
        unified: devices.some((d) => d.unified),
        ...(Number.isFinite(stall) && stall > 0 ? { loadStallTimeoutMs: stall } : {}),
        // `compute.topology`, beside the two GPU lists it is keyed against — confirmed by the server's own
        // response (tests/fixtures/hw/info-ceilings-and-topology-2026-09-11.json). A top-level `topology` is
        // still accepted, since nothing is lost by it.
        topology: topologyFrom((c as { topology?: unknown }).topology ?? (raw as { topology?: unknown })?.topology),
        ...(prof ? { profile: prof.profile } : {}),
    };
}
