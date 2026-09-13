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
}

/** One PAIR of GPUs and what connects them, keyed on bus addresses (`a` < `b` after parsing). `type` is the
 *  vendor-neutral kind — `nvlink` and `xgmi` are a DIRECT GPU-to-GPU fabric, `pcie` goes through the host's
 *  bridges, `unknown` is a pair the server could not classify (with its `reason`). `path` is the vendor tool's
 *  own vocabulary (`NV4`, `PHB`, …) so it can be matched against `nvidia-smi topo -m`; `pciePath` is the PCIe
 *  route that still exists underneath a bridge. Bandwidth only when the driver READ it — never a table. */
export interface TopoLink {
    a: string;
    b: string;
    type: "nvlink" | "xgmi" | "pcie" | "unknown" | string;
    path?: string;
    pciePath?: string;
    linkCount?: number;
    /** NVLink generation, as the driver reports it — on a direct NVLink pair only. */
    version?: number;
    bandwidthBytesPerSec?: number;
    /** WHERE the bandwidth figure came from: `derived_from_pcie_link` is the PCIe spec applied to the narrower
     *  end's capability — a PEAK (measured peer-to-peer on gpubox: 27.7 GB/s against 31.5 derived); `kfd_io_link`
     *  is the AMD driver's own figure. An NVLink rate is never derived from a table, so it is absent until the
     *  driver can be read. */
    bandwidthSource?: string;
    reason?: string;
}

/** The pair list, parsed. `status` separates "measured, and here is every pair" from "could not look"
 *  (`unavailable`) and "some pairs only" (`partial`), with the driver's own `detail`. `missing` is every
 *  unordered pair of `gpus` the list does NOT contain: the server promises each pair exactly once, so a missing
 *  one is a BUG on one side and is reported as such rather than read as PCIe. */
export interface Topology {
    status: "measured" | "partial" | "unavailable" | string;
    detail?: string;
    gpus: string[];
    links: TopoLink[];
    missing: [string, string][];
}

/** Parse the server's topology. Null when absent or unshaped — "not reported", which every consumer must
 *  render as nothing measured, never as "PCIe only". Pairs are normalised to one unordered key and deduped, so
 *  a producer that emitted both directions (KFD's io_links are directed) cannot double-count coverage. */
export function topologyFrom(raw: unknown): Topology | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const status = typeof o.status === "string" && o.status ? o.status : null;
    if (!status) return null;
    const gpus = Array.isArray(o.gpus) ? o.gpus.filter((g): g is string => typeof g === "string" && !!g.trim()).map((g) => g.trim()) : [];
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const seen = new Map<string, TopoLink>();
    for (const x of Array.isArray(o.links) ? o.links : []) {
        const l = x as Record<string, unknown>;
        const a0 = typeof l.a === "string" ? l.a.trim() : "", b0 = typeof l.b === "string" ? l.b.trim() : "";
        if (!a0 || !b0 || a0 === b0) continue;          // a diagonal is not a link
        const [a, b] = a0 < b0 ? [a0, b0] : [b0, a0];
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.set(key, {
            a, b, type: typeof l.type === "string" && l.type ? l.type : "unknown",
            ...(typeof l.path === "string" && l.path ? { path: l.path } : {}),
            ...(typeof l.pcie_path === "string" && l.pcie_path ? { pciePath: l.pcie_path } : {}),
            ...(n(l.nvlink_count) ?? n(l.link_count) ? { linkCount: (n(l.nvlink_count) ?? n(l.link_count))! } : {}),
            ...(n(l.nvlink_version) ? { version: n(l.nvlink_version)! } : {}),
            ...(n(l.bandwidth_bytes_per_sec) ? { bandwidthBytesPerSec: n(l.bandwidth_bytes_per_sec)! } : {}),
            ...(typeof l.bandwidth_source === "string" && l.bandwidth_source ? { bandwidthSource: l.bandwidth_source } : {}),
            ...(typeof l.reason === "string" && l.reason ? { reason: l.reason } : {}),
        });
    }
    const missing: [string, string][] = [];
    for (let i = 0; i < gpus.length; i++) for (let j = i + 1; j < gpus.length; j++) {
        const [a, b] = gpus[i] < gpus[j] ? [gpus[i], gpus[j]] : [gpus[j], gpus[i]];
        if (!seen.has(`${a}|${b}`)) missing.push([a, b]);
    }
    return { status, ...(typeof o.detail === "string" && o.detail ? { detail: o.detail } : {}), gpus, links: [...seen.values()], missing };
}

/** The link between two cards, by bus address, or null when the topology does not name the pair. */
export function linkBetween(t: Topology | null | undefined, x: string | undefined, y: string | undefined): TopoLink | null {
    if (!t || !x || !y || x === y) return null;
    const [a, b] = x < y ? [x, y] : [y, x];
    return t.links.find((l) => l.a === a && l.b === b) ?? null;
}

/** A DIRECT GPU-to-GPU fabric — the only kind of link a bridge is drawn for. */
export const isBridge = (l: TopoLink | null | undefined): boolean => !!l && (l.type === "nvlink" || l.type === "xgmi");

/** The order to lay cards out in so that DIRECTLY-linked pairs sit side by side — the only place a bridge can
 *  be drawn on a one-dimensional axis. Greedy and stable: start from the first unplaced card in the server's
 *  order, keep appending a card bridged to the last one placed, and when none is left take the next in order.
 *  Bridges 0–1 and 2–3 keep 0,1,2,3; bridges 0–2 and 1–3 become 0,2,1,3; an all-to-all switch keeps the order.
 *  Only a `measured` topology reorders anything — the order is a claim about the links. */
export function bridgeOrder<T extends { pciId?: string }>(cards: T[], t: Topology | null | undefined): T[] {
    if (!t || t.status !== "measured" || cards.length < 3) return cards;
    const left = cards.slice(), out: T[] = [];
    while (left.length) {
        let next = left.shift()!;
        out.push(next);
        for (;;) {
            const i = left.findIndex((c) => isBridge(linkBetween(t, next.pciId, c.pciId)));
            if (i < 0) break;
            next = left.splice(i, 1)[0];
            out.push(next);
        }
    }
    return out;
}

/** Each WALL between adjacent cards (in the order given), and what to draw there: whether that exact pair is
 *  bridged, and whether the RUN of bridged cards the wall belongs to is a full mesh.
 *
 *  The second half exists because per-wall honesty is not enough. On a DGX-1 hybrid cube-mesh every card is
 *  linked to 4 of its 7 peers, and the ordering finds a chain in which every ADJACENT pair is linked — so a
 *  bridge on every wall, which draws exactly like an all-to-all NVSwitch box. Each bridge is true and the
 *  picture as a whole is false. So a run of bridged cards is checked as a whole: `full` when every pair inside
 *  it is directly linked (an NVSwitch, or a bridged pair), `partial` when some are not — drawn differently, and
 *  its tooltip says which pairs are missing. Nothing at all unless the topology was `measured`. */
export function bridgeWalls(cards: { pciId?: string }[], t: Topology | null | undefined): { bridge: boolean; mesh: "full" | "partial" | null; link: TopoLink | null; unlinked: [number, number][] }[] {
    const walls = cards.slice(1).map((c, i) => {
        const link = t?.status === "measured" ? linkBetween(t, cards[i].pciId, c.pciId) : null;
        return { bridge: isBridge(link), mesh: null as "full" | "partial" | null, link, unlinked: [] as [number, number][] };
    });
    // Maximal runs of consecutive bridged walls → the card range they join, checked as a clique.
    for (let i = 0; i < walls.length;) {
        if (!walls[i].bridge) { i++; continue; }
        let j = i;
        while (j + 1 < walls.length && walls[j + 1].bridge) j++;
        const unlinked: [number, number][] = [];
        for (let x = i; x <= j + 1; x++) for (let y = x + 1; y <= j + 1; y++)
            if (!isBridge(linkBetween(t, cards[x].pciId, cards[y].pciId))) unlinked.push([x, y]);
        for (let k = i; k <= j; k++) { walls[k].mesh = unlinked.length ? "partial" : "full"; walls[k].unlinked = unlinked; }
        i = j + 1;
    }
    return walls;
}

/** What a PCIe route crosses, in words — the `nvidia-smi topo -m` rungs, nearest first. */
const PCIE_PATH_WORDS: Record<string, string> = {
    PIX: "through one PCIe switch",
    PXB: "through several PCIe switches",
    PHB: "through the CPU's host bridge",
    NODE: "across host bridges within one CPU",
    SYS: "across CPU sockets",
};

/** One link, said plainly, for a hover: "NVLink ×4 (NV4) · 112.5 GB/s" or "PCIe, through the CPU's host bridge
 *  (PHB)". Bandwidth is decimal GB/s because that is how link rates are quoted everywhere — unlike memory,
 *  which is binary. An unknown pair says so, with the server's reason. */
export function linkPhrase(l: TopoLink): string {
    // A DERIVED figure is a peak, and says so: measured peer-to-peer lands below it (27.7 against 31.5 GB/s on
    // gpubox), and an unqualified number beside a measured memory trace reads as a measurement.
    const bw = l.bandwidthBytesPerSec
        ? ` · ${(l.bandwidthBytesPerSec / 1e9).toFixed(1)} GB/s${l.bandwidthSource === "derived_from_pcie_link" ? " peak" : ""}` : "";
    if (l.type === "nvlink" || l.type === "xgmi") {
        const name = l.type === "nvlink" ? `NVLink${l.version ? ` ${l.version}` : ""}` : "xGMI";
        // No link count on an NVLink pair is the SWITCH case (peer-to-peer over NVLink with no direct link),
        // which carries the server's reason: said, so it is not read as a bridge between the two cards.
        const via = l.type === "nvlink" && !l.linkCount && l.reason ? ` — ${l.reason}` : "";
        return `${name}${l.linkCount ? ` ×${l.linkCount}` : ""}${l.path ? ` (${l.path})` : ""}${bw}${via}`;
    }
    if (l.type === "pcie") {
        const p = l.path || l.pciePath;
        return `PCIe${p ? `, ${PCIE_PATH_WORDS[p] ?? "route"} (${p})` : ""}${bw}`;
    }
    return `not classified${l.reason ? `: ${l.reason}` : ""}`;
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

/** Parse `compute.unavailable_gpus[]`. Kept SEPARATE from `devices` rather than folded in with a state
 *  field, which is the trap: every consumer iterating the device list is correct today, and merging would
 *  make all of them wrong until each learned about the flag — failing OPEN, on hardware that is broken.
 *
 *  An entry with no `pci_id` is dropped: the bus address is the identity (two cards share a name), so an
 *  entry without one cannot be told from another, and a fault that cannot be attributed cannot be shown. */
export function unavailableFrom(raw: unknown): UnavailableGpu[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((x) => {
        const g = x as Record<string, any>;
        const pciId = String(g.pci_id ?? "").trim();
        if (!pciId) return [];
        const bus = g.bus && typeof g.bus === "object" ? g.bus as Record<string, any> : null;
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
function processesOf(g: Record<string, unknown>): Partial<DeviceCapacity> {
    const scope = typeof g.processes_scope === "string" && g.processes_scope ? g.processes_scope : undefined;
    if (!Array.isArray(g.processes) && !scope) return {};
    const processes: DeviceProcess[] = (Array.isArray(g.processes) ? g.processes : []).flatMap((x) => {
        const p = (x ?? {}) as Record<string, unknown>;
        const pid = Number(p.pid), used = Number(p.used_memory);
        if (!Number.isFinite(pid) || !Number.isFinite(used) || used < 0) return [];
        const r = p.runner && typeof p.runner === "object" ? p.runner as Record<string, unknown> : null;
        return [{
            pid, usedBytes: used,
            ...(typeof p.name === "string" && p.name ? { name: p.name } : {}),
            ...(r && typeof r.model === "string" && r.model ? { runner: { model: r.model, loading: r.loading === true } } : {}),
            helper: p.ollama_helper === true,
        }];
    });
    return { processes, ...(scope ? { processesScope: scope } : {}) };
}

/** A card's fixed ceilings and its utilization reading, each kept only when it is a real number — absent is
 *  "could not read", and `0` survives as a reading (idle), never collapsed into absent or vice versa. */
function ceilingsOf(g: Record<string, unknown>): Partial<DeviceCapacity> {
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined);
    const u = g.utilization && typeof g.utilization === "object" ? g.utilization as Record<string, unknown> : null;
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

export function parseInfo(raw: unknown): Capacity | null {
    const r = raw as { compute?: { system_compute?: Record<string, number>; supported_gpus?: Record<string, unknown>[]; unavailable_gpus?: unknown } };
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
            ...(g.compute ? { compute: String(g.compute) } : {}),
            ...(g.driver ? { driver: String(g.driver) } : {}),
            ...(typeof g.pci_id === "string" && g.pci_id.trim() ? { pciId: g.pci_id.trim() } : {}),
            ...(typeof g.description === "string" && g.description.trim() ? { description: g.description.trim() } : {}),
            ...ceilingsOf(g),
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
    };
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
}

/** What the engine is doing with a model right now, from `llama-server`'s `/slots`.
 *
 *  Two DIFFERENT KINDS of fact live in here and must not be read alike. `promptTokens` is OCCUPANCY: it is
 *  `n_past`, it survives the task that filled it, and it is the honest answer to "would less context help".
 *  Everything else describes the task IN FLIGHT, and the server clears those the moment it ends — so on an
 *  idle runner they are absent while `promptTokens` still stands, describing the LAST task. Reading a
 *  `promptTokens` on an idle runner as work in progress is the one mistake this shape invites. */
export interface RunnerActivity {
    /** `prefill` reads the prompt, `decode` generates, `idle` is neither. The discriminator for everything
     *  else here: while idle, the in-flight counts are gone and only the occupancy is meaningful. */
    phase: "prefill" | "decode" | "idle";
    /** Slots on this runner, and how many are working. `slots` is 1 on all hardware this has been seen on,
     *  so a `slotsBusy` above 1 is untested rather than impossible. */
    slots: number;
    slotsBusy: number;
    /** `n_past` — tokens resident in the KV cache. Against `contextLength` it is the occupancy, and that
     *  denominator is the PER-SLOT context the server already divided, so no arithmetic is owed here. */
    promptTokens?: number;
    /** How much of the prompt has been read, in the engine's batch-sized steps. Prefill PROGRESS, so a
     *  prefill can be drawn filling rather than as an opaque block. Absent once the task ends. */
    promptTokensDone?: number;
    /** How much of the prompt came from the prefix cache and was never computed. This is the explanation for
     *  a prefill too short to draw: measured on the box, a repeat of the same 4098-token prompt hit 4097 of
     *  them, leaving one token to compute — so the phase did not last long enough to be sampled at all. An
     *  impossibly fast prompt is a cache hit, not a broken clock, and this is the field that says so. */
    promptTokensCached?: number;
    /** Tokens generated so far for the task in flight. Absent once it ends. */
    decoded?: number;
    /** The model's HOST-RAM PROMPT CACHE (`--cache-ram`): the conversations parked in system RAM while another
     *  took the model's one slot, their combined length and size, and the limit (llama-server's default 8 GiB,
     *  per model). Host RAM, never VRAM. Absent until the model's first request, since the engine only reports
     *  it then — absent is "not reported", not an empty cache. Unlike the in-flight counts it survives idle:
     *  those conversations really are still parked. */
    promptCache?: { entries: number; tokens: number; bytes: number; limitBytes?: number };
}

/**
 * THE DECODE CEILING the server computed for a model's placement — how fast decode COULD go if every token did
 * nothing but read the memory it has to read — or the server's reason for not computing one.
 *
 * Decode is memory-bandwidth-bound, so the ceiling is bytes-read-per-token over bandwidth, summed over the
 * devices a layer-split model is on in turn: `1 / Σ_d (bytes_d / bw_d)`. The measured split-vs-single figures
 * on gpubox came out identical, as that predicts. What the server sends is the EMPTY-context figure plus a
 * per-token KV rate, because the cache is read every token too and grows with the context: at 38k tokens a 32B
 * model reads 9.9 GB of cache against 19.8 GB of weights per token, and decode fell 30% (the ceiling predicted
 * 33%). So a measured speed is compared against the ceiling AT ITS OCCUPANCY (`decodeCeiling`) — against the
 * empty one, a box running at a steady 80% efficiency reads as collapsing to 53%.
 *
 * `unavailable` carries the reason there is no honest ceiling: `mixture_of_experts` (an MoE model reads only
 * its active experts — a dense bound on one measured at 165%, which reads as a server bug), `partly_on_cpu`,
 * `bandwidth_unknown`. `kvBytesPerToken` is absent for a sliding-window model, whose windowed layers stop growing
 * at the window, so the cache follows no single per-token rate.
 */
export type Roofline =
    | { basis: string; bytesPerToken: number; ceilingTps: number; kvBytesPerToken?: number;
        devices: { gpuId?: string; pciId?: string; bytesPerToken: number; kvBytesPerToken?: number; bandwidth: number }[] }
    | { unavailable: string };

/** Parse `/api/ps` `roofline`. Null when absent or unshaped — not reported, which draws nothing. */
export function rooflineFrom(raw: unknown): Roofline | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.unavailable === "string" && o.unavailable) return { unavailable: o.unavailable };
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const bpt = pos(o.bytes_per_token), tps = pos(o.ceiling_tokens_per_sec);
    if (!bpt || !tps) return null;
    const devices = (Array.isArray(o.devices) ? o.devices : []).flatMap((x) => {
        const d = x as Record<string, unknown>;
        const b = pos(d.bytes_per_token), bw = pos(d.memory_bandwidth_bytes_per_sec);
        if (!b || !bw) return [];
        return [{ ...(d.gpu_id != null ? { gpuId: String(d.gpu_id) } : {}), ...(typeof d.pci_id === "string" ? { pciId: d.pci_id } : {}),
            bytesPerToken: b, bandwidth: bw, ...(pos(d.kv_bytes_per_context_token) ? { kvBytesPerToken: pos(d.kv_bytes_per_context_token) } : {}) }];
    });
    return { basis: typeof o.basis === "string" ? o.basis : "", bytesPerToken: bpt, ceilingTps: tps, devices,
        ...(pos(o.kv_bytes_per_context_token) ? { kvBytesPerToken: pos(o.kv_bytes_per_context_token) } : {}) };
}

/** The decode ceiling AT A GIVEN CONTEXT OCCUPANCY, in tokens per second: `1 / Σ_d ((bytes_d + occ × kv_d) /
 *  bw_d)`, per device with each device's own KV rate. For a generation, occupancy is its mean over the decode
 *  — `prompt_tokens + decoded / 2`. Null when there is no honest figure: an unavailable ceiling, no per-device
 *  figures, or any device with no KV rate (a sliding-window cache follows no single rate, and leaving it out
 *  would OVERSTATE the ceiling by exactly the traffic the comparison exists to count). */
export function decodeCeiling(r: Roofline | null | undefined, occupancy: number): number | null {
    if (!r || "unavailable" in r || !r.devices.length) return null;
    let secs = 0;
    for (const d of r.devices) {
        if (d.kvBytesPerToken == null) return null;
        secs += (d.bytesPerToken + Math.max(0, occupancy) * d.kvBytesPerToken) / d.bandwidth;
    }
    return secs > 0 ? 1 / secs : null;
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

/** The round intervals a time grid may use, in ms. */
export const GRID_STEPS_MS = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 216e5];

/** A TIME GRID's spacing: the smallest round interval that keeps its lines at least `minPx` apart when `totalMs`
 *  of runs is drawn across `widthPx` — the width a track is guaranteed (they tile at 300px), so a wider one only
 *  spaces them further. The largest step past that. */
export function gridStep(totalMs: number, widthPx = 300, minPx = 48): number {
    const need = (totalMs / Math.max(1, widthPx)) * minPx;
    return GRID_STEPS_MS.find((s) => s >= need) ?? GRID_STEPS_MS[GRID_STEPS_MS.length - 1];
}

/** Where a time grid's lines fall inside one run: every multiple of `step` on the LOCAL clock (a line lands on
 *  the minute, the half-minute), between the run's first and last sample. A gap between runs has none — nothing
 *  was measured there, and the run boundary is where the spacing visibly restarts. */
export function gridTimes(run: { t: number }[], step: number): number[] {
    if (run.length < 2 || step <= 0) return [];
    const first = run[0].t, last = run[run.length - 1].t;
    const off = -new Date(first).getTimezoneOffset() * 60_000;
    const out: number[] = [];
    for (let t = Math.ceil((first + off) / step) * step - off; t <= last && out.length < 500; t += step) out.push(t);
    return out;
}

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
    const e = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const predicted = num(e?.predicted);
    if (!e || predicted == null) return null;
    const b = e.breakdown && typeof e.breakdown === "object" ? e.breakdown as Record<string, unknown> : {};
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

export function activityFrom(raw: unknown): RunnerActivity | null {
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Record<string, unknown>;
    const phase = a.phase === "prefill" || a.phase === "decode" || a.phase === "idle" ? a.phase : null;
    if (!phase) return null;   // an unrecognised phase is not a fourth state to invent a rendering for
    const n = (k: string) => (typeof a[k] === "number" && Number.isFinite(a[k]) && (a[k] as number) >= 0
        ? Math.floor(a[k] as number) : undefined);
    const out: RunnerActivity = {
        phase, slots: n("slots") ?? 1, slotsBusy: n("slots_busy") ?? 0,
    };
    const past = n("prompt_tokens"), done = n("prompt_tokens_done");
    const cached = n("prompt_tokens_cached"), dec = n("decoded");
    if (past !== undefined) out.promptTokens = past;
    // The in-flight counts are meaningless once the task is over, and the server already drops them — but an
    // older or oddly-behaved build that keeps them would have this UI drawing the last task as a live one.
    // Phase is the discriminator the server intends, so it is applied here rather than trusted to hold.
    if (phase !== "idle") {
        if (done !== undefined) out.promptTokensDone = done;
        if (cached !== undefined) out.promptTokensCached = cached;
        if (dec !== undefined) out.decoded = dec;
    }
    const pc = a.prompt_cache && typeof a.prompt_cache === "object" ? a.prompt_cache as Record<string, unknown> : null;
    const pn = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    if (pc && pn(pc.entries) != null && pn(pc.bytes) != null) out.promptCache = {
        entries: pn(pc.entries)!, tokens: pn(pc.tokens) ?? 0, bytes: pn(pc.bytes)!,
        ...(pn(pc.limit_bytes) ? { limitBytes: pn(pc.limit_bytes) } : {}),
    };
    return out;
}

/** KV cache occupancy as a fraction, or null when either half is unknown.
 *
 *  The denominator is the model's own `context_length`, which is the PER-SLOT window the server has already
 *  divided by the parallel slot count — so this is a straight ratio and dividing again would be wrong. Null
 *  rather than 0 when there is nothing to divide: a model whose runner cannot be asked has an UNKNOWN cache,
 *  and an empty bar is a claim about memory nobody measured. */
export function kvOccupancy(r: { activity?: RunnerActivity; contextLength: number | null }): number | null {
    const past = r.activity?.promptTokens;
    const ctx = r.contextLength;
    if (past === undefined || !ctx || ctx <= 0) return null;
    return Math.min(1, past / ctx);
}

/** A fraction as a percentage for a chip, where 0 and "nearly 0" must not read the same.
 *
 *  A cache holding 30 of 262,144 tokens rounds to 0%, and "0%" beside a reserved 40 GiB says the cache is
 *  EMPTY — which is the answer the reader is about to act on, and it is wrong. `<1%` is the same
 *  glance-width and says the true thing. Zero itself still prints `0%`: an empty cache is a real reading and
 *  hedging it would throw away the one case the number is exactly right about. */
export function fmtOccupancy(frac: number): string {
    const pct = frac * 100;
    if (pct > 0 && pct < 1) return "<1%";
    if (pct < 100 && pct > 99) return ">99%";
    return `${Math.round(pct)}%`;
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
    const p = raw as Record<string, unknown>;
    const num = Number(p.num_layers) || 0;
    const list = Array.isArray(p.devices) ? p.devices as Record<string, unknown>[] : [];
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
    const m = raw as Record<string, unknown>;
    const n = (k: string) => Number(m[k]) || 0;   // a key is OMITTED when zero, so missing IS zero here
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
        else if (i > 0 && base && base[i - 1] !== base[i]) out.push([i, (base[i - 1] ?? 0) + (series[i] ?? 0) - (base[i] ?? 0)]);
        out.push([i, series[i] ?? 0]);
    }
    return out;
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

// --- series + tracks: what the panel can plot, and how the user may combine it ------------------------------

/** What a series MEASURES: a device's memory, the host's, or a device's UTILIZATION — a share of TIME, not
 *  of capacity, which is why it never shares a track with the other two (see `kindRefusal`). */
export type SeriesScope = "device" | "host" | "util";
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
    // HOW BUSY each card is — only for a card that reports a reading at all. Absent is "not read", and a series
    // for a card that never reports would be a line that is never drawn, or worse, one drawn at zero.
    for (const d of cap?.devices ?? []) {
        if (d.utilization && (d.utilization.gpuPercent != null || d.utilization.memoryPercent != null))
            out.push({ id: `util.${d.id}`, label: `${d.name} busy`, scope: "util", pool: `util:${d.id}`, deviceId: d.id, capacityBytes: null });
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
    /** `stack` sums the series against one ceiling; `overlay` draws them independently, each on its own scale;
     *  `total` lays them END TO END up one axis — see {@link boxAxis}. */
    mode: "stack" | "overlay" | "total";
    heightPx: number;
}

/**
 * THE WHOLE BOX ON ONE AXIS, without pretending its memory is ONE pool.
 *
 * Pools DO combine: ollama splits a model too big for one card across several (by layer), and spills what
 * still does not fit into system RAM — the panel draws both. But not one-for-one, and that is what a single
 * combined figure hides: every extra card a model spans carries its own compute buffer (flat per device, not
 * pro-rated) and, on a card that held nothing, ~0.65 GiB of driver context; layers do not divide, so free
 * space smaller than the next layer is stranded; and a spill into RAM runs far slower, since those weights
 * cross PCIe on every token. So two cards with 20 GiB free each are not 40 GiB of room, and a GiB of RAM is
 * not a GiB of VRAM. The question behind "add up my box" is real — how much of this machine is in use — and
 * the answer only misleads when the pools are MERGED into one.
 *
 * So they are laid END TO END up the axis rather than poured into one: each pool owns a band whose height is
 * its own capacity, and fills that band from its own floor. The axis total is then a true total of capacity,
 * every fill is a real reading against a real ceiling (which card is full is what decides where the next load
 * lands), and the WALLS between the bands are drawn — so the boundaries a split has to pay to cross are
 * visible rather than something the reader has to know.
 *
 * It also makes the box's SHAPE visible, which the per-pool tracks cannot: those give every pool the same
 * height whatever its size, so a 12 GiB laptop card and a 96 GiB card look alike. Here a pool's height IS its
 * share of the machine.
 *
 * Hiding a pool removes its band and shrinks the axis, which is what makes "just my two cards" a view rather
 * than a calculation.
 */
export function boxAxis(pools: { id: string; ceiling: number }[]): { total: number; bands: { id: string; base: number; ceiling: number }[] } {
    let base = 0;
    const bands = pools.filter((p) => p.ceiling > 0).map((p) => {
        const at = base;
        base += p.ceiling;
        return { id: p.id, base: at, ceiling: p.ceiling };
    });
    return { total: base, bands };
}

/** Why these series cannot share a STACKED axis, or null when they can. Stacking asserts the parts sum to a
 *  meaningful whole: true within one device, false across two (a model uses one card's capacity, not their
 *  sum) and false across device+host on unified memory, where the two totals describe the SAME silicon.
 *  `overlay` has no such constraint — it makes no claim about a total — so this gates only stacking. */
/** Why these series cannot share ONE track in any mode, or null. Utilization is a share of TIME (how busy the
 *  card was) and memory a share of CAPACITY; drawn on one 0–100% axis they would line up as though comparable,
 *  and a card "90% busy" beside a card "90% full" says nothing about either. Separate tracks. */
export function kindRefusal(defs: SeriesDef[]): string | null {
    const util = defs.filter((d) => d.scope === "util").length;
    return util && util < defs.length
        ? "How busy a card is is a share of TIME; memory is a share of CAPACITY. One axis for both would line them up as though they were comparable. Put utilization in a track of its own."
        : null;
}

export function stackRefusal(defs: SeriesDef[], cap: Capacity | null): string | null {
    // A busy percentage is not an AMOUNT: there is nothing in it to add up, and a stack is a sum.
    if (defs.some((d) => d.scope === "util"))
        return "A card's utilization is a share of time, not an amount of memory — a stack adds its parts up, and there is nothing here to add. Overlay it.";
    const pools = new Set(defs.map((d) => d.pool));
    if (pools.size <= 1) return null;
    const scopes = new Set(defs.map((d) => d.scope));
    if (cap?.unified && scopes.size > 1)
        return "This device shares one pool of memory between the GPU and the system, so its VRAM and RAM figures describe the same silicon — stacking them would double-count. Overlay them instead.";
    if ([...pools].filter((p) => p.startsWith("device:")).length > 1)
        return "Each card has its own capacity, and a stack draws its parts against ONE ceiling — so several cards stacked would draw one card's models in memory another card does not have. (A model split across cards already shows on each card it uses.) Show a track per card, overlay them, or use Whole box, which lays each card's capacity end to end.";
    return "These series measure different pools, each against its own ceiling, so one stack has no single ceiling to draw them against. Overlay them, or use Whole box.";
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
        { const r = kindRefusal(defs); if (r) return r; }
        if (t.mode === "total" && defs.some((d) => d.scope === "util")) return "utilization has no capacity to lay end to end";
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
        // OVERLAY, not stack: each pool has its own ceiling and a stack draws against one, so stackRefusal
        // rightly refuses a stack across pools. A preset must never propose a layout the rule then rejects. Overlaying claims nothing about a total, so it is the honest way to compare them.
        // The HOST pool is included: a CPU-resident model holds no VRAM, so a cards-only overview would make
        // it vanish from the chart while it still sits in the legend below — the same flaw that took Placement
        // out of the default slot.
        // THE MODE IS DECIDED BY HOW MANY POOLS THE TRACK ENDED UP WITH, not by how many CARDS the box has.
        // Asking about cards got the one-card machine wrong — the commonest machine there is: one GPU plus
        // host RAM is still TWO pools, so the default preset proposed a stack of a card and the host, which
        // `stackRefusal` refuses ("their sum isn't a real quantity"). The panel's own default offered a
        // layout the panel then told you off for.
        //
        // It has to be read off the track AFTER `track()` has filtered the series to what this machine
        // actually has, or the count is of series we hoped for rather than series we got.
        tracks: ((): TrackDef[] => {
            const t = track("overview", [...devices.map((d) => `vram.${d.id}`), "ram"]);
            return [{ ...t, mode: (t.series.length > 1 ? "overlay" : "stack") as TrackDef["mode"] }].filter(nonEmpty);
        })(),
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
    //
    // A THIRD KIND, though, not a narrowing: every pool END TO END on one axis. It is a different QUESTION
    // from the other two — not "how full is each" (Overview) or "what is in each" (GPU + RAM) but "what shape
    // is this box, and how much of it is spoken for" — and the per-pool tracks cannot answer it, because they
    // give every pool the same height whatever its capacity, so a 12 GiB card and a 96 GiB one look alike.
    //
    // It had no preset and could only be reached by editing tracks by hand, which made Custom carry a whole
    // view rather than what Custom should mean: a preset with something excluded or a mode changed. A mode
    // nobody can find is a mode nobody uses.
    //
    // Only where there is more than one pool. On a single-pool box the axis IS that pool's, so laying it
    // "end to end" is the same picture under a name that promises something else.
    const pools = [...devices.map((d) => `vram.${d.id}`), "ram"].filter((id) => have.has(id));
    const box: Preset = {
        id: "box", label: "Whole box", description: "Every pool end to end on one axis, with the walls drawn between them.",
        tracks: [{ ...track("box", pools, "total"), heightPx: 150 }].filter(nonEmpty),
    };
    // A FOURTH QUESTION, not a memory view: how BUSY is each card. Its own preset because it is its own unit — a
    // share of time — and offered only where some card reports a reading; a preset of lines that are never
    // drawn would read as an idle box. Unified memory returns earlier and has no per-card counter to show.
    const util = [...have].filter((id) => id.startsWith("util."));
    const activity: Preset = {
        id: "activity", label: "Activity",
        description: "How busy each card is — the GPU and its memory controller, as the driver averages them.",
        tracks: [track("activity", util, "overlay")].filter(nonEmpty),
    };
    return [overview, withRam, ...(pools.length > 1 ? [box] : []), ...(util.length ? [activity] : [])];
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

// --- history ------------------------------------------------------------------------------------------------

/** Polling is gated on the panel being open, so the history has HOLES. A gap wider than this breaks the line
 *  instead of being drawn across: an interpolated segment over a ten-minute hole is a confident lie about
 *  memory that was never measured. (Same rule as never inventing a timestamp for an unmarked line.) */
export const MAX_SAMPLE_GAP_MS = 15_000;

/** The same rule, for a STREAMED history. It is a different number because a gap means a different thing on
 *  each transport, and using the polling one under the stream is a bug that hides the whole event lane.
 *
 *  Polling runs at a fixed 2s while the panel is open, so 15s between samples really did mean nobody was
 *  watching. The stream's cadence is ADAPTIVE by design — 1s while a load is in flight or the body is
 *  changing, 15s when nothing is happening — so 15s apart is the NORMAL idle spacing and means "nothing
 *  changed", the opposite of "nothing was measured". Reading it as a hole broke an idle history into
 *  single-sample segments, and since a lone sample draws no line, every event placed in one was dropped:
 *  a lane counting four loads and drawing none.
 *
 *  Three missed idle samples, which is a stream that has genuinely stopped rather than one that is quiet. */
export const STREAM_MAX_GAP_MS = 45_000;

/** The stream's IDLE cadence. It is the grace `placeEvents` needs on a streamed history for the same reason
 *  the poll interval is on a polled one: the last sample can be a whole idle interval old while the chart's
 *  right edge means "now", so without it the newest events — the ones you are watching for — are the only
 *  ones that never appear. Fifteen seconds is a long time to be blind to the thing you opened the panel for. */
export const STREAM_SAMPLE_MS = 15_000;

/** Split history into contiguous runs, so the chart draws several segments rather than one line bridging
 *  every gap. A single sample is its own segment (it renders as a point, not a line). */
export function segments(samples: ResourceSample[], maxGapMs: number = MAX_SAMPLE_GAP_MS): ResourceSample[][] {
    const out: ResourceSample[][] = [];
    let run: ResourceSample[] = [];
    for (const s of samples) {
        const prev = run[run.length - 1];
        // A REPORTED hole breaks the run as surely as a measured one. `gapBefore` is the stream saying it lost
        // frames on our behalf, and it is checked separately from the interval because a drop leaves no
        // interval to notice: the readings either side can be adjacent in time.
        if (prev && (s.gapBefore || s.t - prev.t > maxGapMs)) { out.push(run); run = []; }
        run.push(s);
    }
    if (run.length) out.push(run);
    return out;
}

/** A BREAK the chart cut out between two drawn runs. The plot collapses it to a few pixels whatever its length,
 *  so a missing minute and a missing ten hours look the same unless something says which it was. */
export interface RunGap {
    /** The last reading before the break and the first after it. */
    from: number;
    to: number;
    /** The server said it dropped frames on our behalf here (`gapBefore`), as opposed to nothing sampling. */
    reported: boolean;
    /** Readings inside the stretch that were too few to draw (a lone sample draws no line). */
    isolated: number;
}

/** What the break between run `prev` and run `next` stands for. `samples` is the full history, so a lone
 *  reading the plot skipped is counted rather than the stretch being called unmeasured. */
export function runGap(prev: readonly { t: number }[], next: readonly { t: number; gapBefore?: true }[],
    samples: readonly { t: number; gapBefore?: true }[] = []): RunGap {
    const from = prev[prev.length - 1].t, to = next[0].t;
    const inside = samples.filter((s) => s.t > from && s.t < to);
    return { from, to, reported: !!next[0].gapBefore || inside.some((s) => s.gapBefore), isolated: inside.length };
}

/** Where an event sits on the chart's x-axis — which SEGMENT, and how far across it.
 *
 *  The plot is split into contiguous runs of samples (a gap is drawn as a gap, never interpolated across),
 *  and each run is linear in time and weighted by its duration (`runWeight`/`runFrac`) — but the GAPS
 *  collapse, so a pixel is not a fixed duration across the whole axis. An event therefore has to be placed
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
        for (const m of before) if (!after.has(m)) out.push({ t, kind: "evict", label: `${m} evicted`, model: m, via: "poll" });
        for (const m of after) {
            if (before.has(m)) continue;
            // Within a poll of a load span for the same model → that span already tells the story.
            const covered = knownLoads.some((e) => e.model === m && e.kind === "load" &&
                t >= e.t - MAX_SAMPLE_GAP_MS && t <= (e.until ?? e.t) + MAX_SAMPLE_GAP_MS);
            if (!covered) out.push({ t, kind: "load", label: `${m} appeared`, model: m, via: "poll" });
        }
    }
    return out;
}

/** The SCRUB strip's geometry: where the visible window sits inside the whole session.
 *
 *  The strip is a compressed view of every sample the session holds (~30 minutes at a 2s poll), with a box
 *  showing which slice of it the chart above is drawing. Unlike the chart, the strip's own axis IS linear in
 *  time — it is an overview, and a 10-minute hole in the middle of a session is a fact about the session that
 *  an overview should show at its true width, not collapse the way the chart's segments do.
 *
 *  Returns null only when there is no WINDOW at all (the "everything" setting, which is not a viewport onto
 *  anything) or no session to draw. It deliberately does NOT return null for a window that happens to cover
 *  the whole session: that is a state a live view passes through constantly — the rolling window is wider
 *  than a session that has just started, and a width dragged while following is REMEMBERED, so stretching
 *  the box to the full width once made the control delete itself and reappear minutes later when the session
 *  outgrew it. A control that vanishes is worse than one that is momentarily at its limit, and it took the
 *  only way back with it: the chart's wheel-scrub reads this too. Full-width and draggable says the same
 *  thing honestly. */
export interface ScrubExtent {
    /** First and last sample in the session. */
    from: number;
    to: number;
    /** The visible window, as fractions of that span. */
    windowFrom: number;
    windowTo: number;
    /** Whether the window's right edge is at the session's tail — i.e. it is following live samples. */
    atTail: boolean;
}

/** How close to the tail still counts as AT it. One poll of slack: a window pinned to live is always a
 *  moment behind the newest sample, and calling that "scrolled back" would unpin the view for nobody. */
export const TAIL_SLACK_MS = 3000;

export function scrubExtent(
    samples: readonly { t: number }[],
    window: { from: number; to: number } | null,
): ScrubExtent | null {
    if (!window) return null;   // no viewport: the plot already IS the whole session
    if (samples.length < 2) return null;
    const from = samples[0].t, to = samples[samples.length - 1].t;
    const span = to - from;
    if (span <= 0) return null;
    // Clamped, because a window can legitimately extend past the samples (the rolling window reaches back
    // before the first sample on a fresh open, and forward to now).
    const clamp = (t: number) => Math.min(1, Math.max(0, (t - from) / span));
    return {
        from, to,
        windowFrom: clamp(window.from), windowTo: clamp(window.to),
        atTail: window.to >= to - TAIL_SLACK_MS,
    };
}

/** Move a window to a new position on the strip, keeping its DURATION. Dragging the box scrolls time; it does
 *  not zoom, which is what the drag-on-the-chart gesture is for. The result is clamped to the session, so a
 *  drag past either end parks against it rather than scrolling into time that was never sampled. */
export function scrubTo(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    centerFrac: number,
): { from: number; to: number } {
    const span = extent.to - extent.from;
    const width = window.to - window.from;
    const center = extent.from + Math.min(1, Math.max(0, centerFrac)) * span;
    let start = center - width / 2;
    start = Math.max(extent.from, Math.min(start, extent.to - width));
    // A window WIDER than the session sits over all of it rather than being squeezed.
    if (width >= span) return { from: extent.from, to: extent.to };
    return { from: start, to: start + width };
}

/** Which part of the scrub window a pointer landed on. The EDGES resize, the middle pans — the same
 *  vocabulary every timeline control uses, and the reason a drag on the box must not silently mean
 *  "recentre on the cursor" when the cursor is on a handle.
 *
 *  `edgePx` is converted to a fraction against the track's width so the handles are a constant, clickable
 *  size on screen rather than a constant slice of a window that may be 2% wide.
 *
 *  THE CAP APPLIES INSIDE THE WINDOW ONLY. A handle is capped at a third of the window so a narrow one keeps
 *  a middle to pan by — but the cap was applied to the OUTSIDE reach as well, which is what made a hairline
 *  window impossible to widen: a few pixels across, its handles were one or two pixels on either side of it,
 *  so every grab landed on the pan zone and the only way out was discarding the zoom.
 *
 *  Outside, the reach is always the full `edgePx`. Nothing is given up for it — the pan middle is exactly as
 *  it was — and the narrower the window, the more the reach outside it is what you actually hit, which is
 *  the right way round: a window too small to aim at is a window you want to make bigger. */
export function scrubZone(
    extent: { windowFrom: number; windowTo: number },
    frac: number,
    trackPx: number,
    edgePx = 7,
): "from" | "to" | "pan" | "outside" {
    const { windowFrom: a, windowTo: b } = extent;
    const outer = trackPx > 0 ? edgePx / trackPx : 0;   // never capped: this is the reach OUTSIDE the window
    const inner = Math.min(outer, (b - a) / 3);         // capped: the window must keep a middle to pan by
    if (frac < a - outer || frac > b + outer) return "outside";
    if (frac <= a + inner) return "from";
    if (frac >= b - inner) return "to";
    return "pan";
}

/** Move ONE edge of the window, keeping the other fixed. Clamped to the session and to a minimum span, so a
 *  drag past the opposite edge parks against it rather than inverting the range into something with a
 *  negative duration that every consumer would then have to defend against. */
export function scrubResize(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    edge: "from" | "to",
    frac: number,
    minMs = MIN_SCOPE_MS,
): { from: number; to: number } {
    const span = extent.to - extent.from;
    const at = extent.from + Math.min(1, Math.max(0, frac)) * span;
    const min = Math.min(minMs, span);
    return edge === "from"
        ? { from: Math.max(extent.from, Math.min(at, window.to - min)), to: window.to }
        : { from: window.from, to: Math.min(extent.to, Math.max(at, window.from + min)) };
}

/** A SELECTED WINDOW, never narrower than the panel can draw. Widened symmetrically about its own centre, so
 *  the stretch you picked stays in the middle of what you get rather than sliding to one end.
 *
 *  A drag can resolve to almost no time at all even when the hand moved a long way, because the axis is
 *  SEGMENTED: a densely-sampled run occupies a lot of width for a little time. The result is a window of a
 *  few milliseconds, which contains no samples, draws as an empty plot, and reads as the panel breaking
 *  rather than as a selection that was too small to mean anything. `scopeToSpan` already widens a too-short
 *  block for the same reason; this is the same rule for a hand-made selection.
 *
 *  Returns null for a window with no extent at all (from >= to), which is not a selection to widen but a
 *  click to ignore. */
export function clampWindow(win: { from: number; to: number }, minMs = MIN_SCOPE_MS): { from: number; to: number } | null {
    const span = win.to - win.from;
    if (span <= 0) return null;
    if (span >= minMs) return win;
    const mid = win.from + span / 2, half = minMs / 2;
    return { from: mid - half, to: mid + half };
}

/**
 * THE STRETCH THE CHART DRAWS, in priority order: an explicit zoom, then a scoped session's own extent, then
 * the rolling window. A zoom REPLACES the rolling one — you asked for a stretch, so the panel stops sliding
 * away from it.
 *
 * Pure and shared, because the HEADER has to describe the same instant the tracks do. It used to read the
 * live resident set whatever the window was, so scrubbing back put two different moments side by side with
 * nothing saying so: "6.53 GiB in use" above a track whose own edge read 19.95 GiB unattributed, which reads
 * as arithmetic going wrong rather than as two clocks. Deriving the window twice would have been the same bug
 * waiting to come back.
 */
export function chartWindow(zoom: { from: number; to: number } | null, scoped: { from: number; to: number } | null,
    secs: number, now: number): { from: number; to: number } | null {
    if (zoom) return zoom;
    if (scoped) return scoped;
    if (!secs) return null;                        // "everything" — no window to draw
    return { from: now - secs * 1000, to: now };
}

/** THE SAMPLES A WINDOW SHOULD DRAW — the ones inside it, PLUS the nearest on each side.
 *
 *  A plain filter is wrong once the window gets narrower than the poll interval, which is exactly what
 *  zooming into a single long event does: the window falls between two polls, the filter returns fewer than
 *  two samples, and the chart draws an empty box. The panel then looks broken rather than zoomed — no line,
 *  no ceiling, no tracks — while the thing you zoomed in ON, an event spanning the whole window, is still
 *  perfectly well defined.
 *
 *  The BRACKETING samples are what a line needs to cross the window at all: the value did not stop existing
 *  between two measurements. They sit outside the window by construction, so a renderer must clip to the
 *  window rather than to the data's extent — which is what a time axis does anyway.
 *
 *  Not interpolation: these are real measurements, drawn where they were actually taken. Inventing a sample
 *  at the window's edge would be a reading nobody took, which is the thing this panel refuses to do
 *  everywhere else (see the gaps, which stay gaps). */
export function windowSamples<T extends { t: number }>(all: readonly T[], window: { from: number; to: number } | null): T[] {
    if (!window) return [...all];
    const inside: T[] = [];
    let before: T | null = null, after: T | null = null;
    for (const s of all) {
        if (s.t < window.from) { before = s; continue; }         // `all` is ordered, so the last one wins
        if (s.t > window.to) { if (!after) after = s; continue; }   // …and the first one past the end
        inside.push(s);
    }
    // Only reach outside when the window cannot draw itself. A window with plenty of samples must not have
    // its scale stretched by a neighbour that is minutes away.
    if (inside.length >= 2) return inside;
    return [...(before ? [before] : []), ...inside, ...(after ? [after] : [])];
}

/** WHAT A FINISHED SCRUB DRAG MEANT. Two outcomes, and telling them apart is the whole point: a window
 *  PINNED to a range, or FOLLOWING with a width.
 *
 *  The rule that used to be here — "ends at the tail → rejoin live" — is right for a PAN (you dragged the
 *  box to the end, you want to follow) and wrong for a RESIZE of the left edge, which never moves `to` at
 *  all. So every widen-while-following was read as "rejoin live", which threw the new width away and
 *  snapped the strip back: the window could be narrowed but never stretched.
 *
 *  Following with a width is not a special case of a pinned range — it IS `resWindowS`, the same quantity
 *  Settings names — so a left-edge drag against the tail returns seconds, and the caller stores it. */
export function scrubIntent(
    extent: { from: number; to: number },
    next: { from: number; to: number },
    tailSlackMs: number,
): { live: true; windowS: number } | { live: false; window: { from: number; to: number } } {
    // AT THE TAIL → follow, AT THE WIDTH ON SCREEN. One rule for every gesture, which is what makes it
    // predictable: whatever the window looks like when you let go against the right edge is what live then
    // means. Two separate bugs came from not having it. Rejoining live RESTORED whatever `resWindowS` was
    // last set to, so narrowing a pinned window and dragging it back to the edge made it snap large again —
    // and a left-edge stretch while already following was read as "you dropped at the tail, rejoin live",
    // which threw the new width away, so the window could be narrowed but never widened.
    if (next.to >= extent.to - tailSlackMs)
        return { live: true, windowS: Math.max(1, Math.round((next.to - next.from) / 1000)) };
    return { live: false, window: next };
}

/** Slide the window along the strip by a fraction of ITS OWN width, for a wheel gesture over the plot.
 *  Relative to the window rather than to the session, so one notch moves the same visible distance whether
 *  you are looking at ten seconds of a ten-minute session or all of it. */
export function scrubNudge(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    byWindowFraction: number,
): { from: number; to: number } {
    const width = window.to - window.from;
    const span = extent.to - extent.from;
    if (width >= span) return { from: extent.from, to: extent.to };
    const center = (window.from + window.to) / 2 + width * byWindowFraction;
    return scrubTo(extent, window, (center - extent.from) / span);
}

/**
 * A PINCH → a narrower or wider window, ANCHORED so the instant under your fingers stays under them.
 *
 * A trackpad pinch reaches the page as a `wheel` carrying `ctrlKey`, which is the platform convention rather
 * than anything we invented — it is how the browser tells its own page-zoom apart from a scroll. So zooming
 * the timeline costs no new surface: the same handler that scrolls the window along reads one more flag and
 * changes what the gesture means. Sideways slides, pinch zooms, which is what both gestures already mean
 * everywhere else on a trackpad.
 *
 * The factor is EXPONENTIAL in the delta, so the gesture is smooth and symmetric: pinching out by an amount
 * and back in by the same amount returns to where you started, where a linear step accumulates drift and a
 * `sign(delta) * step` moves in visible jumps.
 *
 * The anchor is read LINEARLY across the window, which the plot's own axis is not quite — its runs are
 * linear in time but the gaps between them collapse. That is deliberate and matches `scrubNudge`, which slides by a fraction of
 * the window's own width for the same reason: consistency between the two gestures on one axis matters more
 * than an exactness neither of them has, and the anchor is about the zoom FEELING fixed rather than about
 * naming an instant.
 */
export function scrubPinch(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    deltaY: number,
    anchorFrac: number,
    minMs = MIN_SCOPE_MS,
): { from: number; to: number } {
    const span = extent.to - extent.from;
    const width = window.to - window.from;
    if (!(span > 0) || !(width > 0)) return window;
    // Pinching OUT gives a negative delta (the same sign a scroll-up carries) and means "closer", so the
    // window gets narrower. Capped per event, because a trackpad can deliver a very large delta in one frame
    // and a single flick should not cross the whole zoom range.
    const factor = Math.exp(Math.max(-0.5, Math.min(0.5, deltaY * 0.01)));
    const next = Math.max(Math.min(minMs, span), Math.min(span, width * factor));
    const anchor = window.from + Math.min(1, Math.max(0, anchorFrac)) * width;
    // Keep the anchored instant at the same FRACTION of the window, which is what makes it stay under the
    // pointer as the width changes.
    let from = anchor - (anchor - window.from) * (next / width);
    from = Math.max(extent.from, Math.min(from, extent.to - next));
    return { from, to: from + next };
}

/**
 * How far a wheel gesture should slide the window, as a fraction of the window's own width.
 *
 * Two things this gets right that a `Math.sign(delta) * step` does not, and both were visible as the same
 * symptom — the chart scrubbing erratically under a trackpad:
 *
 * It reads BOTH AXES, taking whichever dominates. A trackpad swipe is a stream of events carrying a mixture
 * of `deltaX` and `deltaY`, so reading only one axis means a horizontal swipe does nothing except through
 * whatever incidental vertical jitter it happens to carry. Dominant-axis rather than summed, so a diagonal
 * gesture is not counted twice.
 *
 * And it is PROPORTIONAL to the distance, scaled by the plot's own width, so the window travels 1:1 with the
 * gesture: swipe across half the plot and the window moves half its width. A fixed step per event is what
 * made it inconsistent — one mouse notch and one of the dozens of tiny events a trackpad emits for the same
 * physical movement were treated identically, so the same swipe moved wildly different distances depending
 * on how the hardware chose to quantise it.
 *
 * `deltaMode` is honoured because a mouse reports LINES and a page gesture reports PAGES; treating either as
 * pixels moves the window by a few pixels for a gesture that meant a screenful.
 */
export function wheelScrubFraction(deltaX: number, deltaY: number, deltaMode: number, plotPx: number): number {
    if (!(plotPx > 0)) return 0;
    const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? plotPx : 1;
    const dx = deltaX * scale, dy = deltaY * scale;
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    return d / plotPx;
}

/** The TIME at a fraction across the whole plot — the inverse of `placeEvents`, for turning a drag into a
 *  time range. The plot is segments laid out with flex weights proportional to their sample counts, so the
 *  fraction is spent across the segments in those proportions and then interpolated INSIDE the one it lands
 *  in. A fraction landing in a gap between segments resolves to that gap's near edge: nothing was measured
 *  there, so the honest answer is the last moment that was. */
export function locateFraction<T extends { t: number }>(runs: T[][], frac: number): { run: T[]; within: number } | null {
    const live = runs.filter((r) => r.length > 0);
    if (!live.length) return null;
    const weights = live.map(runWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    const f = Math.min(1, Math.max(0, frac));
    for (let i = 0; i < live.length; i++) {
        const share = weights[i] / total;
        if (f <= acc + share || i === live.length - 1)
            return { run: live[i], within: share > 0 ? Math.min(1, Math.max(0, (f - acc) / share)) : 0 };
        acc += share;
    }
    return { run: live.at(-1)!, within: 1 };
}

/**
 * THE CHART'S TIME AXIS IS LINEAR IN TIME, within each run of samples. One second is the same width wherever it
 * falls; only a GAP (no samples at all) is collapsed, since there is nothing measured to draw there.
 *
 * It used to space samples EVENLY — sample i at i/(n-1) of its run, runs weighted by sample COUNT. That was
 * harmless while the panel polled every 2 s, and it warped badly once the event stream sampled adaptively (250 ms
 * during a load, 1 s while working, 15 s idle): busy stretches stretched, idle ones shrank, and scrolling changed
 * the mix of samples in view and so the warp — which read as the chart compressing at random, and put an unload
 * rule over a band that was still resident. So: a run's WIDTH is its duration (`runWeight`), and a time's
 * position is linear across it (`runFrac`). Every mapping between the screen and time — drawing, events, the
 * crosshair, the snap, the selection — goes through these two, so none of them can disagree.
 */
export const runWeight = (run: readonly { t: number }[]): number =>
    run.length > 1 ? Math.max(1, run[run.length - 1].t - run[0].t) : 1;

/** Where time `t` sits across its run, 0–1, linear in time. A run with no width (one sample) has no interior,
 *  so everything in it sits at the middle. */
export const runFrac = (run: readonly { t: number }[], t: number): number => {
    const n = run.length;
    if (n < 2) return 0.5;
    const w = run[n - 1].t - run[0].t;
    return w > 0 ? Math.min(1, Math.max(0, (t - run[0].t) / w)) : 0.5;
};

/** The index of the sample nearest in TIME to `t` within a run (binary search — runs can hold thousands). */
const nearestIndex = (run: readonly { t: number }[], t: number): number => {
    let lo = 0, hi = run.length - 1;
    if (hi <= 0 || t <= run[0].t) return 0;
    if (t >= run[hi].t) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (run[mid].t <= t) lo = mid; else hi = mid; }
    return t - run[lo].t <= run[hi].t - t ? lo : hi;
};

export function timeAtFraction(runs: { t: number }[][], frac: number): number | null {
    const at = locateFraction(runs, frac);
    if (!at) return null;
    // Linear across the run, the inverse of `runFrac` — the same mapping the bands are drawn with.
    const { run, within } = at;
    if (run.length === 1) return run[0].t;
    return run[0].t + (run[run.length - 1].t - run[0].t) * within;
}

/** The DATAPOINT under a fraction of the plot's width — what a Grafana-style hover reads, as opposed to the
 *  interpolated instant the crosshair labels. It snaps to a real sample rather than interpolating between
 *  two, because the values in the tooltip are measurements: a figure halfway between two polls was never
 *  observed, and presenting one as though it had been is the whole failure mode a memory panel must not have.
 *  Nearest in TIME, since that is what the axis is. */
export function sampleAtFraction<T extends { t: number }>(runs: T[][], frac: number): T | null {
    const at = locateFraction(runs, frac);
    if (!at) return null;
    const { run, within } = at;
    if (run.length === 1) return run[0];
    return run[nearestIndex(run, run[0].t + (run[run.length - 1].t - run[0].t) * within)] ?? null;
}

/**
 * WHERE THE NEAREST DATAPOINT SITS — the inverse of {@link sampleAtFraction}, so the crosshair can SNAP to
 * the sample it is already reading instead of floating between two.
 *
 * The tooltip has always named a real measurement (a figure halfway between two polls was never observed),
 * but the line was drawn wherever the pointer happened to be, so the number and the mark disagreed by up to
 * half a sample gap. At a 15s idle cadence that is seven seconds of daylight between "here" and "the reading
 * you are being shown".
 *
 * Returns null when there is nothing to snap to. Inverts exactly the axis's own mapping (`runWeight`,
 * `runFrac`), so the snapped fraction is where that sample is DRAWN.
 */
export function snapFraction<T extends { t: number }>(runs: T[][], frac: number): { frac: number; index: number; run: number } | null {
    // The ORIGINAL indices, so a caller mapping over `runs` can ask "is the snapped sample in THIS segment?".
    // Filtering first and returning a position in the filtered list would silently name the wrong segment on
    // any window that contains an empty one.
    const liveAt = runs.map((r, i) => [r, i] as const).filter(([r]) => r.length > 0);
    const live = liveAt.map(([r]) => r);
    if (!live.length) return null;
    const weights = live.map(runWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    const f = Math.min(1, Math.max(0, frac));
    let acc = 0;
    for (let i = 0; i < live.length; i++) {
        const share = weights[i] / total;
        if (f <= acc + share || i === live.length - 1) {
            const run = live[i];
            const within = share > 0 ? Math.min(1, Math.max(0, (f - acc) / share)) : 0;
            const index = run.length === 1 ? 0 : nearestIndex(run, run[0].t + (run[run.length - 1].t - run[0].t) * within);
            return { frac: acc + runFrac(run, run[index].t) * share, index, run: liveAt[i][1] };
        }
        acc += share;
    }
    return null;
}


/** What the lane draws. Everything is shown by default; this is how a busy session is narrowed.
 *
 *  Two independent axes, because they answer different questions. SCOPE answers "whose events" — a browsing
 *  session accumulates every run, and when you are reading one of them the others are noise. KINDS answers
 *  "which of them" — sub-calls are the numerous ones (a vision reader fires several per step) and loads and
 *  evictions are the rare, expensive ones you may want alone. */
export interface LaneFilter {
    /** The session being read, or null when none is (the overview list). */
    hash: string | null;
    /** Whether the lane shows only that session's events, or every session's. Scoping is the DEFAULT: the
     *  lane sits above a transcript, and events from runs you are not reading are noise against it. With
     *  scoping on and no session open there is nothing to scope to, so a run's events are shown NOWHERE —
     *  which is the intended overview, not an empty-looking bug. */
    scope: "session" | "all";
    /** Kinds to HIDE. An exclusion list, so a kind added later is visible by default rather than silently
     *  filtered out by a stored preference that predates it. */
    hidden: readonly ResourceEvent["kind"][];
    /** The models the scoped session actually ran, delegated readers included. A MACHINE event carries no
     *  session, so scoping cannot ask who owns it — but it can ask whether the model is one this session was
     *  using, which is the question a reader is really asking. Undefined means "not known", and everything
     *  machine-side is kept, since inventing an empty set would silently hide the lot. */
    models?: readonly string[];
}

export const EMPTY_LANE_FILTER: LaneFilter = { hash: null, scope: "all", hidden: [] };

/** Apply a filter. An event with no `ref` belongs to the MACHINE rather than to a run — a load, an eviction,
 *  the box serving someone else — so a session scope cannot ask who owns it. It asks the useful question
 *  instead: is this a model the session was using? A qwen session was drawing gemma's loads and evictions
 *  because "no ref" was read as "always relevant", and on a shared box that is most of the lane. Kept when
 *  the models are unknown, since an empty set would hide everything the chart exists to show. */
export function filterEvents(events: readonly ResourceEvent[], filter: LaneFilter): ResourceEvent[] {
    const hidden = new Set(filter.hidden);
    const mine = filter.models ? new Set(filter.models) : null;
    return events.filter((e) => {
        if (hidden.has(e.kind)) return false;
        if (filter.scope !== "session") return true;
        if (e.ref) return e.ref.hash === filter.hash;
        // A machine event about a model this session ran EXPLAINS the session — an eviction mid-run is why
        // the next turn paid a load. One about a model it never touched is another tenant's traffic.
        if (!mine) return true;
        // An event with no model at all cannot be attributed either way (the server emits a bare `unload`).
        // Dropped while scoped and kept in full: unattributable is not the same as unrelated, but a lane
        // asked for one session should not answer with something it cannot place.
        return e.model ? mine.has(e.model) : false;
    });
}

/** The stretch of time a SESSION occupies, for a panel scoped to it. Scoping the lane and the model list but
 *  not the axis left the two disagreeing about what "this session" means: the list said one model, the chart
 *  still drew ten minutes of a shared box either side of it.
 *
 *  Derived from the session's own events rather than from its turns, so it covers whatever the lane draws —
 *  including a tool that was still running when the snapshot was taken. `now` extends a LIVE session to the
 *  present instead of stopping at its last finished event, which would otherwise pin the window behind the
 *  memory trace it is meant to sit under.
 *
 *  `minMs` is a floor, because a three-second session is a slit: a window narrower than a couple of samples
 *  contains no measurements and draws as an empty plot, which reads as the panel breaking rather than as a
 *  short run. Returns null when the session has no events at all — there is nothing to frame, and inventing
 *  a window would be a claim about when it happened. */
export function sessionWindow(
    events: readonly ResourceEvent[], hash: string | null, now: number,
    { minMs = 30_000, padFrac = 0.04 }: { minMs?: number; padFrac?: number } = {},
): { from: number; to: number } | null {
    if (!hash) return null;
    let from = Infinity, to = -Infinity;
    for (const e of events) {
        if (e.ref?.hash !== hash) continue;
        from = Math.min(from, e.t);
        // An OPEN span has no end; `until` is where it had reached, which is the right right-edge for it.
        to = Math.max(to, e.until ?? e.t);
    }
    if (!Number.isFinite(from)) return null;
    // Still going, or only just finished: follow the clock rather than stopping short of it.
    if (now - to < minMs) to = now;
    const pad = Math.max((to - from) * padFrac, 1000);
    from -= pad; to += pad;
    // Widen around the CENTRE, so a short session sits in the middle of its window instead of against an edge.
    const grow = minMs - (to - from);
    if (grow > 0) { from -= grow / 2; to += grow / 2; }
    return { from, to };
}

/** Is this the SAME machine edge we already hold? A subscriber that reconnects is backfilled with the ring
 *  again — the whole ten minutes when the worker is fresh, which an MV3 respawn guarantees — so every span
 *  in that window arrives a second time and the lane doubles. Measured on a real box: four serving periods
 *  drawn as "serving 8", two loads as three (one load's opening edge fell outside the replayed window, so
 *  only its duplicate closed).
 *
 *  Identity is kind + model + when, with a TOLERANCE. The instant is derived as `helloAt + frame.t`, and
 *  since each connection anchors on its own hello the same edge lands within the jitter between two hellos
 *  rather than on the exact same millisecond. A second is far tighter than the spacing of anything the
 *  server actually emits, and collapsing two genuinely distinct edges that close together is a far smaller
 *  error than drawing everything twice. */
export function sameMachineEvent(a: ResourceEvent, b: ResourceEvent, tolMs = 1500): boolean {
    if (a.kind !== b.kind || a.model !== b.model) return false;
    // A GENERATION is identified by its END and the engine's own figures, never its start: a replay that
    // lost its `gen.start` (it fell outside the requested window) starts the same span somewhere else, while
    // two short generations of one model can end milliseconds apart (3-token calls at 35 ms in a real capture)
    // and must stay two. The figures are the identity — a replay carries them verbatim since the backfill fix.
    if (a.kind === "gen" && a.gen && b.gen) {
        return a.until != null && b.until != null && Math.abs(a.until - b.until) <= tolMs
            && a.gen.promptMs === b.gen.promptMs && a.gen.evalMs === b.gen.evalMs && a.gen.decoded === b.gen.decoded;
    }
    if (Math.abs(a.t - b.t) > tolMs) return false;
    // A span and an instant of the same kind at the same moment are not the same thing, and two spans that
    // start together but end apart are two different periods of work.
    if ((a.until == null) !== (b.until == null)) return false;
    return a.until == null || Math.abs((a.until as number) - (b.until as number)) <= tolMs;
}

/** Append unless we already hold it. Bounded by `cap`, dropping oldest. */
export function addMachineEvent(list: readonly ResourceEvent[], e: ResourceEvent, cap: number, tolMs = 1500): ResourceEvent[] {
    // Backwards: a duplicate arrives in a REPLAY of recent history, so the match is near the end.
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].t < e.t - tolMs - 1) break;          // the list is time-ordered; nothing older can match
        if (sameMachineEvent(list[i], e, tolMs)) return list as ResourceEvent[];
    }
    const next = [...list, e];
    return next.length > cap ? next.slice(next.length - cap) : next;
}

/** How many of each kind are in a set — for a filter control that says what it is hiding rather than making
 *  you toggle blindly. */
export function countByKind(events: readonly ResourceEvent[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of events) out[e.kind] = (out[e.kind] || 0) + 1;
    return out;
}

/** An event's whole lineage: itself, everything it descends from, and everything descended from it. Hovering
 *  a sub-call should leave the step that spawned it and the run that contains it lit — the relationship is
 *  what makes the bar mean anything — and hovering the step should keep what it spawned, which is the same
 *  relationship read the other way. */
export function lineageOf(events: readonly ResourceEvent[], id: string | undefined): Set<string> {
    const out = new Set<string>();
    if (!id) return out;
    const byId = new Map(events.filter((e) => e.id).map((e) => [e.id!, e]));
    // A focus on an event that is NOT DRAWN is not a focus. The hover is held in a signal, so it outlives the
    // thing it pointed at — a click that navigates, a filter chip, the window moving — and an id that matches
    // nothing produced a lineage of exactly one unmatchable member, which dimmed every bar and every step at
    // once. That reads as the whole lane disappearing rather than as a stale highlight.
    if (!byId.has(id)) return out;
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
/** The narrowest window double-clicking a bar will scope to. A tool call that took 40ms is a real event
 *  worth pointing at, but a 40ms window contains no samples at all and draws as an empty plot — so a short
 *  block is widened around its own centre rather than scoped to exactly itself. */
export const MIN_SCOPE_MS = 2500;

/**
 * The time window to scope the panel to when a lane block is double-clicked: the block's own extent,
 * widened symmetrically if it is shorter than {@link MIN_SCOPE_MS}.
 *
 * An OPEN event (work still in flight) has no end, so `now` stands in for one — scoping to it while it
 * runs is the case where this is most useful and least able to know where it stops.
 */
export function scopeToSpan(from: number, until: number | null | undefined, now: number, minMs = MIN_SCOPE_MS): { from: number; to: number } {
    const to = until ?? now;
    const pad = Math.max(0, (minMs - (to - from)) / 2);
    return { from: from - pad, to: to + pad };
}

/**
 * The same thing, but guaranteed to contain enough SAMPLES to draw.
 *
 * A window is only as useful as the trace inside it, and everything here needs a segment of at least two
 * samples: `segments()` drops shorter ones, so the tracks, the lane and the strip all render nothing and the
 * panel appears to vanish. A time floor cannot promise that — scoping to a 400ms tool call on a box polled
 * every two seconds is a window with one sample in it, or none — so this widens symmetrically until the
 * window actually covers `minSamples`, and gives up only when the session does not have that many.
 */
export function scopeAround(
    samples: readonly { t: number }[],
    from: number,
    until: number | null | undefined,
    now: number,
    minSamples = 3,
): { from: number; to: number } {
    let w = scopeToSpan(from, until, now);
    if (samples.length <= minSamples) return { from: samples[0]?.t ?? w.from, to: samples[samples.length - 1]?.t ?? w.to };
    const covered = (r: { from: number; to: number }) => samples.reduce((n, s) => n + (s.t >= r.from && s.t <= r.to ? 1 : 0), 0);
    // Grow by the window's own width each round, so a very short scope reaches a useful size in a few steps
    // rather than crawling, and a long one is left alone.
    for (let i = 0; i < 40 && covered(w) < minSamples; i++) {
        const grow = Math.max(1000, (w.to - w.from) / 2);
        w = { from: w.from - grow, to: w.to + grow };
    }
    return w;
}

/** A hair of separation reserved BETWEEN bars in a row. Two bars that merely touch read as one bar with a
 *  seam — which is the same misreading as an overlap, arrived at differently. */
export const EV_ROW_GAP = 0.004;

/**
 * Pack placed events into rows, ONE RUN AT A TIME.
 *
 * A run and everything under it — its steps, their sub-calls — is a tree, and the tree is what a reader is
 * following. Packing every event together by start time interleaves two concurrent runs into the same rows,
 * so a step of one sits between two steps of the other and the shape of neither survives. Each run instead
 * gets a contiguous BAND: its own container bar, its steps beneath, its sub-calls beneath those. A second
 * run overlapping in time starts a new band below rather than filling gaps in the first.
 *
 * This is not only a multi-model case: a server or cloud backend runs the SAME model several times at once,
 * so the grouping is by RUN, never by model.
 *
 * Events belonging to no run (an eviction — a fact about the machine) are packed last, in a band of their
 * own, so they cannot push a run's rows apart.
 */
/** The most rows the lane will ever draw, across every band. Each row is a few pixels, so without a TOTAL
 *  cap a box running ten agents at once would push the transcript off the screen — banding made the per-run
 *  cap insufficient, because the number of bands is the number of concurrent runs. */
export const MAX_LANE_ROWS = 10;

export function laneRows(placed: EventPlacement[], maxRows = 4, minSpan = MIN_EV_SPAN, maxTotal = MAX_LANE_ROWS): EventPlacement[][] {
    const groups = new Map<string, EventPlacement[]>();
    for (const p of placed) {
        const key = p.event.ref?.hash ?? "";
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }
    // Runs in the order they STARTED, and the machine's own events last: a band's position should say when
    // its run began, and an eviction belongs to no run at all.
    const order = [...groups.entries()].sort((a, b) => {
        if (!a[0] !== !b[0]) return a[0] ? -1 : 1;
        return Math.min(...a[1].map((p) => p.run + p.from)) - Math.min(...b[1].map((p) => p.run + p.from));
    });
    const out: EventPlacement[][] = [];
    // The drawn end of each existing row, so a later band can be told whether it would collide.
    const ends: number[] = [];
    const endOf = (p: EventPlacement) => p.run + Math.max(p.to, p.from + minSpan) + EV_ROW_GAP;
    const startOf = (p: EventPlacement) => p.run + p.from;

    for (const [, band] of order) {
        const rows = packBand(band, maxRows, minSpan);
        // REUSE rows where the band cannot collide. Banding exists so a tree is never interleaved with
        // another — but two runs that never overlap in TIME cannot interleave, so stacking them costs rows
        // for nothing, and most runs are sequential rather than concurrent. The band is placed as a WHOLE at
        // the first depth where every one of its rows clears what is already there: moving rows independently
        // would let one run's steps slide under another's container, which is the interleaving this prevents.
        // Placed at the TOP only when everything already drawn has finished before this band begins — which
        // is exactly the sequential case. Anything else appends. Allowing a band to start partway down would
        // let it share a row with another run's sub-calls while overlapping that run's container, so the two
        // trees would interleave by depth: the thing banding exists to prevent, arrived at sideways.
        const bandStart = Math.min(...band.map(startOf));
        const clearsEverything = ends.length > 0 && ends.every((e) => bandStart >= e);
        let at = clearsEverything ? 0 : out.length;
        // Out of room even appending: everything left CROWDS into the last row rather than being dropped. A
        // bar drawn overlapping is a legibility problem; a run not drawn at all is a lie about what ran.
        if (at >= out.length && out.length + rows.length > maxTotal) {
            const last = out[out.length - 1] ?? (out.push([]), ends.push(0), out[0]);
            for (const r of rows) last.push(...r);
            continue;
        }
        rows.forEach((row, i) => {
            const k = at + i;
            if (!out[k]) { out[k] = []; ends[k] = 0; }
            out[k].push(...row);
            ends[k] = Math.max(ends[k], ...row.map(endOf));
        });
    }
    return out;
}

/** One run's own rows — the greedy first-fit the whole lane used to get, applied within a band. */
/** Which row-tier an event belongs to. The lane is a CONTAINMENT picture, so depth has to mean something:
 *  a run CONTAINS its steps, so it goes above them; the machine's own spans are the ground the run happened
 *  on, so they go below. Packing by start time alone made the order incidental — a container whose first
 *  step began at the same instant landed UNDER its own children, and a model load could take the top row
 *  from the run it was loading for.
 *
 *  A tier is only a preference between things drawn at the same time: within one tier, packing is unchanged
 *  and two bars still share a row whenever they cannot overlap. */
export function laneTier(kind: string): number {
    if (kind === "run" || kind === "session") return 0;      // the container
    if (kind === "gen" || kind === "tool" || kind === "embed") return 1;   // its own work
    return 2;                                               // the machine: loads, serving, evictions
}

function packBand(placed: EventPlacement[], maxRows: number, minSpan: number): EventPlacement[][] {
    const rows: EventPlacement[][] = [];
    // The END is the DRAWN end, not the true one: see MIN_EV_SPAN.
    const start = (p: EventPlacement) => p.run + p.from;
    const end = (p: EventPlacement, pad: boolean) =>
        p.run + Math.max(p.to, p.from + minSpan) + (pad ? EV_ROW_GAP : 0);
    // A true INTERVAL test against the row's members, not a running end. The running end assumed events
    // arrived in increasing start order, which stopped being true the moment they were sorted by tier — a
    // load that abuts a step it precedes was then refused the row it belongs on, because a later-starting
    // member had already pushed the end past it.
    const fits = (row: EventPlacement[], p: EventPlacement, pad: boolean) =>
        row.every((q) => end(q, pad) <= start(p) || end(p, pad) <= start(q));
    // TIER first, then time. Sorting by time alone let whatever happened to begin earliest take the top row,
    // which on a lane whose depth means containment is a wrong picture rather than an untidy one.
    for (const p of [...placed].sort((a, b) =>
        laneTier(a.event.kind) - laneTier(b.event.kind) || start(a) - start(b))) {
        let r = rows.findIndex((row) => fits(row, p, true));
        // Nothing fits WITH the separation reserved. Before opening a row, try again without it. Rows are the
        // lane's scarcest resource and its only claim about time: two bars on separate rows say they OVERLAP.
        // Spending a row to buy a bar 0.4% of clearance therefore asserts an overlap that isn't there, which
        // is the same misreading the separation exists to prevent, arrived at from the other side. This is the
        // ordinary case rather than an edge one — a model LOAD ends exactly where the block it precedes
        // begins, so every load abutted its own step and was pushed below it.
        if (r < 0) r = rows.findIndex((row) => fits(row, p, false));
        if (r < 0) {
            if (rows.length >= maxRows) r = rows.length - 1;   // out of rows: crowd the last one rather than drop the event
            else { rows.push([]); r = rows.length - 1; }
        }
        rows[r].push(p);
    }
    // Each row back in time order: it is packed by tier, and a row read left to right should be in the order
    // the things on it happened.
    for (const row of rows) row.sort((a, b) => start(a) - start(b));
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
        // On the SAME axis the bands are drawn on: linear in time across the run (`runFrac`). The run's own last
        // sample bounds it — the grace decides membership, and a time past the last sample sits at the right
        // edge rather than squashing every bar left by however long the poll happens to be.
        const r = spans[idx], run = runs[idx];
        const at = (t: number): number => (run.length < 2 ? 0 : runFrac(run, t));
        out.push({ event: e, run: idx, from: at(e.t), to: at(Math.min(end, r.to)), clipped: end > r.to });
    }
    return out;
}

/** An annotation on the time axis — a run starting, a model loading or being evicted, a context reload.
 *  Kept separate from the samples because events are instants while samples are a cadence, and because the
 *  event source (the debug bus) is independent of the poll. */
/** The parts a span divides into. Named rather than inline because the surfaces that render a phase have to
 *  be TOTAL over it: a tooltip that fell through to a default label shipped a model load's two halves as the
 *  word "tool", which reads as a wrong fact rather than as a missing one. */
// `boot` is an executor's COLD START — a sandbox fetching its runtime before the code runs. Like a model
// load it is the step's wall time and none of the work you asked for, so it is drawn apart from `tool`.
export type PhaseKind = "model" | "wait" | "tool" | "think" | "answer" | "call" | "queue" | "net" | "boot" | "dispatch" | "weights" | "context"
    | "prefill" | "decode" | "other" | "swap";

/** What the ENGINE measured for one generation (`gen.end.timings`, patched Ollama). Every figure is the
 *  executor's own, which is what makes a prefill/decode boundary drawable at all: the event stream carries no
 *  phase transition (llama.cpp emits none, and a sampled one would stamp the moment a poll NOTICED), so the
 *  split exists only as these two durations, anchored at the end.
 *
 *  `promptTokensCached` keeps the server's three states apart: `0` is a cold prefill, a number is a cache hit,
 *  ABSENT is "not reported" (an older build omitted the cold case, and so does a route that never had it).
 *  Collapsing absent into 0 would claim a cold prefill nobody measured. `promptTokens` alone hides a cache hit
 *  completely — it is the same on both — so the count of cached tokens and the DURATION are the evidence. */
export interface GenTimings {
    promptTokens?: number;
    promptTokensCached?: number;
    promptMs: number;
    evalMs: number;
    decoded?: number;
    /** A HOST-RAM PROMPT-CACHE SWAP this request paid for, before its prefill: the conversation in the slot was
     *  saved to RAM (`savedTokens`/`savedBytes`) and this one read back if it was there (`restored`, always
     *  present — `false` is information), with other conversations evicted to make room (`evicted`,
     *  `evictedBytes`) or the outgoing one too large to keep (`tooLarge`). `ms` is the ENGINE's measure of the
     *  copy, and it is in no other timing: a turn with a 24 ms prefill took 670 ms, 500 of them swapping.
     *  Present only on a request that switched conversations, and only on a one-slot model (with more slots
     *  the log cannot say whose swap is whose, so none is reported). */
    swap?: { ms: number; restored: boolean; savedTokens?: number; savedBytes?: number; evicted?: number; evictedBytes?: number; tooLarge?: boolean };
}

/** Parse `gen.end.timings`. Null unless BOTH durations are present, since the split is built from the pair —
 *  one without the other is a boundary with only one side. */
export function genTimingsFrom(raw: unknown): GenTimings | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const promptMs = n(o.prompt_ms), evalMs = n(o.eval_ms);
    if (promptMs == null || evalMs == null) return null;
    return {
        promptMs, evalMs,
        ...(n(o.prompt_tokens) != null ? { promptTokens: n(o.prompt_tokens) } : {}),
        ...(n(o.prompt_tokens_cached) != null ? { promptTokensCached: n(o.prompt_tokens_cached) } : {}),
        ...(n(o.decoded) != null ? { decoded: n(o.decoded) } : {}),
        ...((() => {
            const sw = o.prompt_cache_swap && typeof o.prompt_cache_swap === "object" ? o.prompt_cache_swap as Record<string, unknown> : null;
            if (!sw || n(sw.ms) == null || typeof sw.restored !== "boolean") return {};
            return { swap: { ms: n(sw.ms)!, restored: sw.restored,
                ...(n(sw.saved_tokens) != null ? { savedTokens: n(sw.saved_tokens) } : {}),
                ...(n(sw.saved_bytes) != null ? { savedBytes: n(sw.saved_bytes) } : {}),
                ...(n(sw.evicted) ? { evicted: n(sw.evicted) } : {}),
                ...(n(sw.evicted_bytes) ? { evictedBytes: n(sw.evicted_bytes) } : {}),
                ...(sw.too_large === true ? { tooLarge: true } : {}) } };
        })()),
    };
}

/** The phases a CARD's ribbon draws: the two halves of a generation as the engine timed them, our own streamed
 *  calls' channels (which ARE the decode, per `joinGens`), and the prompt-cache swap. Everything else in a block
 *  — a tool running, a person at the gate, the undifferentiated `model` stretch — is not the card doing a known
 *  kind of work, so it is not drawn rather than drawn as a guess. */
export const RIBBON_KINDS: ReadonlySet<string> = new Set(["prefill", "decode", "swap", "think", "answer", "call"]);

/**
 * WHAT A CARD WAS DOING, as spans for its ribbon: every timed generation phase of every model that was ON this
 * card at the time. Which card is read from the sample nearest the span (a split model is on several, and its
 * work shows on each; a one-card box needs no attribution at all). A span whose model no sample places on the
 * card is not drawn here — it may be off-box, or on another card.
 *
 * Absence is NOT idle: an unpatched server times no phases at all, so an empty ribbon claims nothing.
 */
export function ribbonSpans(events: ResourceEvent[], samples: ResourceSample[], deviceId: string, deviceCount: number): { t: number; until: number; kind: PhaseKind; model: string }[] {
    const sorted = [...samples].sort((a, b) => a.t - b.t);
    const nearest = (t: number): ResourceSample | undefined => {
        let best: ResourceSample | undefined, d = Infinity;
        for (const s of sorted) { const dd = Math.abs(s.t - t); if (dd < d) { d = dd; best = s; } if (s.t > t && dd > d) break; }
        return best;
    };
    const onCard = (model: string, t: number): boolean => {
        const m = nearest(t)?.models.find((x) => normModel(x.model) === normModel(model));
        if (!m || m.vramBytes <= 0) return false;
        return deviceCount <= 1 || (m.perDevice[deviceId] ?? 0) > 0 || m.perDevice[deviceId] === null;
    };
    const out: { t: number; until: number; kind: PhaseKind; model: string }[] = [];
    for (const e of events) {
        if (!e.model || !e.phases?.length || e.until == null) continue;
        if (!e.phases.some((p) => RIBBON_KINDS.has(p.kind))) continue;
        if (!onCard(e.model, (e.t + e.until) / 2)) continue;
        let from = e.t;
        for (const p of e.phases) {
            if (RIBBON_KINDS.has(p.kind) && p.until > from) out.push({ t: from, until: p.until, kind: p.kind, model: normModel(e.model) });
            from = p.until;
        }
    }
    return out;
}

/**
 * ONE GENERATION as the lane draws it, from the server's own edges — split into PREFILL and DECODE.
 *
 * Anchored at `gen.end` and built BACKWARDS, like every span in the lane: decode occupied the last `evalMs`,
 * prefill the `promptMs` before that. Both are the engine's figures, so the boundary between them is
 * MEASURED — which is the one thing sampling could never give us (a ~400 ms prefill against a 1–2 s cadence).
 *
 * `gen.start` is OLLAMA's stamp, the moment the request took the runner, so it is the near end of a
 * REMAINDER: whatever lies between it and the prefill is neither phase — scheduling, tokenizing, sampler setup
 * — and is drawn as `other` rather than folded into either. Usually 12–15 ms; measured at 1.78 s once, on a
 * generation whose model was still LOADING. That load is drawn as its own span, so when one ended inside the
 * generation the span starts where it ended (`loadEnd`) — otherwise the same seconds would be drawn twice.
 *
 * A re-entry into prefill after decode (a context shift) cannot be represented: the engine reports one pair
 * of durations per request, so it is one stretch each. Without a `gen.start` (a reconnect mid-generation)
 * there is no remainder to draw, and none is invented.
 */
export function genSpan(o: { model: string; startAt?: number; endAt: number; timings: GenTimings; loadEnd?: number; hint?: ServerHint | null }): ResourceEvent {
    const { model, endAt, timings } = o;
    const decodeFrom = endAt - timings.evalMs;
    const prefillFrom = decodeFrom - timings.promptMs;
    // A prompt-cache SWAP happens before the prefill and is the engine's own measure too, so it is a measured
    // phase of its own rather than part of the remainder.
    const swapFrom = prefillFrom - (timings.swap?.ms ?? 0);
    // The remainder begins at the later of the runner being taken and any load finishing; a start AFTER the
    // measured phases began would mean the two clocks disagree by more than the gap, and then there is none.
    let t = Math.max(o.startAt ?? swapFrom, o.loadEnd ?? -Infinity);
    if (t > swapFrom) t = swapFrom;
    const phases: { kind: PhaseKind; until: number }[] = [];
    if (swapFrom - t >= 1) phases.push({ kind: "other", until: swapFrom });
    if (timings.swap?.ms) phases.push({ kind: "swap", until: prefillFrom });
    phases.push({ kind: "prefill", until: decodeFrom }, { kind: "decode", until: endAt });
    return { t, until: endAt, kind: "gen", label: `${model} generating`, model, via: "server", phases, gen: timings,
        ...(o.hint ? { hint: o.hint } : {}) };
}

/** What a request told a patched ollama it was for, as the server echoes it on `gen.end` (`ollama-slop:hints2`):
 *  ours (RequestHint in contract.ts, plus the `request` id we minted) or any other client's — Open WebUI labels its
 *  own task calls `use: "utility"` in an `owui-` session. Every field optional; absent means the request said
 *  nothing, never a default. */
export interface ServerHint {
    use?: string;
    session?: string;
    request?: string;
    after?: string;
    synthetic?: boolean;
}

/** What the lane says about a SERVER generation no session of ours matched. It used to say only that it was not
 *  started from this browser; with a hint it can say whose it was — Open WebUI's own calls are `owui-`, another
 *  window.ml session is `wml-` (a tab or browser this panel is not showing, since ours would have matched) — and
 *  what kind of work (`use`, in words). An unknown `use` is quoted as sent rather than translated. */
export function serverGenNote(h?: ServerHint | null, isShown?: (session: string) => boolean): string {
    const base = "reported by the server — not started from this browser";
    if (!h) return base;
    // ONE OF THE SESSIONS THIS PANEL SHOWS. The panel's own side tasks about a session — its title, a step summary —
    // are not drawn as lane events of their own, so nothing matches them; calling them "a session this panel isn't
    // showing" was wrong about a session sitting right there (caught live).
    if (h.session && isShown?.(h.session)) {
        return h.use === "utility"
            ? "a side task this panel ran for one of its sessions (its title or a summary)"
            : "a request in one of this panel's sessions that matched none of its steps";
    }
    const who = !h.session ? null
        : h.session.startsWith("owui-") ? "Open WebUI"
        : h.session.startsWith("wml-") ? "a window.ml session this panel isn't showing (another tab or browser)"
        : "another client";
    const what = !h.use ? null
        : ({ interactive: "a person reading it", agent: "an agent step", utility: "a side task", batch: "bulk work" } as Record<string, string>)[h.use]
            ?? `"${h.use}"`;
    const parts = [who, what, h.synthetic ? "synthetic traffic" : null].filter(Boolean);
    return parts.length ? `reported by the server: ${parts.join(", ")}` : base;
}

/** Read `gen.end.hint`. Unknown values are kept as sent (the server accepts any `use`); anything that is not a
 *  string is dropped rather than coerced, and an empty result is null. */
export function hintFrom(raw: unknown): ServerHint | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const h: ServerHint = {
        ...(str(o.use) ? { use: str(o.use) } : {}), ...(str(o.session) ? { session: str(o.session) } : {}),
        ...(str(o.request) ? { request: str(o.request) } : {}), ...(str(o.after) ? { after: str(o.after) } : {}),
        ...(o.synthetic === true ? { synthetic: true } : {}),
    };
    return Object.keys(h).length ? h : null;
}

/** WHAT ONE GENERATION LEFT IN THE KV CACHE, as shares of the cache's token capacity, bottom to top:
 *  reused from the cache, computed this turn (prefill), decoded this turn. The cache is reserved in full at
 *  load and its bytes never move, so this is the only place its FILL can be read — and it is read from the
 *  engine's own counts, not sampled.
 *
 *  - The capacity is `context_length × slots`: the context is PER SLOT (llama.cpp rounds each up to a multiple
 *    of 256), and the reservation covers every slot.
 *  - When the cached count was NOT reported (an older build omitted it; a route that never had it), the prompt
 *    is ONE layer (`prompt`) rather than a guessed split — 0 cached is a cold prefill and absent is unknown.
 *  - Shares are of TOKENS, not bytes: a sliding-window layer stops growing at its window and recurrent state
 *    does not grow per token at all, so "40% of the band" must never be read as 40% of the bytes in use.
 *  - `overflow` when the tokens exceed the capacity: the context SHIFTED (older tokens were dropped to make
 *    room), and the layers are scaled to fit rather than drawn past the band.
 *
 *  Null when there is no prompt count or no capacity to be a share OF. */
export function kvFill(gen: GenTimings, contextTokens: number | null | undefined, slots = 1): { cached?: number; computed?: number; prompt?: number; decoded: number; overflow: boolean } | null {
    const cap = (contextTokens ?? 0) * Math.max(1, slots);
    if (!(cap > 0) || gen.promptTokens == null) return null;
    const decoded = gen.decoded ?? 0;
    const total = gen.promptTokens + decoded;
    const scale = total > cap ? cap / total : 1;
    const f = (n: number) => (n * scale) / cap;
    const cached = gen.promptTokensCached;
    return {
        ...(cached != null
            ? { cached: f(Math.min(cached, gen.promptTokens)), computed: f(Math.max(0, gen.promptTokens - cached)) }
            : { prompt: f(gen.promptTokens) }),
        decoded: f(decoded),
        overflow: total > cap,
    };
}

/** How far apart OUR finish stamp and the server's `gen.end` may be and still be one generation. Our stamp is
 *  taken in the service worker when the response completes, so it trails the server's by the return leg of the
 *  network, and the server's clock reaches us through one `hello` anchor. Wide enough for both; a model runs
 *  one request at a time at `n_parallel` 1, so a neighbour of the same model is seconds away, not this. */
export const GEN_JOIN_TOLERANCE_MS = 1500;

/** Where a SESSION block's model work ends — the whole block for a plain turn, the last model-ish phase for a
 *  tool step (the rest is dispatch, a human at a gate, the tool). */
const modelEndOf = (e: ResourceEvent): number | null => {
    if (e.kind === "gen") return e.until ?? null;
    if (e.kind !== "tool" || !e.phases?.length) return null;
    let end: number | null = null;
    for (const ph of e.phases) if (["model", "think", "answer", "call"].includes(ph.kind)) end = ph.until;
    return end;
};

/**
 * JOIN the server's generations to the session blocks they ARE. Our own calls reach the server too, so with
 * the stream carrying, every one of them arrives twice — once as the step block the session drew, once as a
 * server `gen` span — and drawing both is the same generation on the lane twice.
 *
 * The session block wins (it carries the click-through, the cost and the channel phases), and takes the
 * server's figures: `gen` goes onto it, and its model stretch is split with the measured prefill — the
 * leading, pre-first-token stretch of a streamed call becomes `other | prefill` (its channel phases ARE the
 * decode); a non-streamed call's single `model` phase becomes `other | prefill | decode`, anchored backwards
 * from where the model work ended. A split that does not FIT the stretch it would subdivide (clock skew, a
 * mis-join) is not drawn: the figures still attach, the phases are left as they were.
 *
 * Matched per model, nearest first, each side at most once. Server gens that match nothing are other traffic
 * and are returned to be drawn as they are.
 */
export function joinGens(sessionEvents: ResourceEvent[], serverEvents: ResourceEvent[]): { session: ResourceEvent[]; server: ResourceEvent[] } {
    const gens = serverEvents.filter((e) => e.kind === "gen" && e.via === "server" && e.gen && e.model && e.until != null);
    if (!gens.length) return { session: sessionEvents, server: serverEvents };
    const pairs: { si: number; g: ResourceEvent; d: number }[] = [];
    // EXACT FIRST. A generation the server records with OUR request id is that call's, wherever its end landed:
    // no tolerance to tune, and two calls of one model finishing together cannot swap. `d: -1` sorts these ahead
    // of every timing match below.
    const byRequest = new Map<string, ResourceEvent>();
    for (const g of gens) if (g.hint?.request) byRequest.set(g.hint.request, g);
    sessionEvents.forEach((s, si) => {
        if (s.open || !s.model) return;
        const g = s.requestId ? byRequest.get(s.requestId) : undefined;
        if (g) { pairs.push({ si, g, d: -1 }); return; }
        // By TIMING only when an id cannot settle it: either side has none (an older build, a route that dropped
        // the hint). When both carry one and they differ, the generation is somebody else's call — another tab,
        // another browser — however close its end is.
        const end = modelEndOf(s);
        if (end == null) return;
        for (const g of gens) {
            if (g.model !== s.model) continue;
            if (s.requestId && g.hint?.request) continue;
            const d = Math.abs(end - g.until!);
            if (d <= GEN_JOIN_TOLERANCE_MS) pairs.push({ si, g, d });
        }
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedS = new Set<number>(), usedG = new Set<ResourceEvent>();
    const session = sessionEvents.slice();
    for (const { si, g } of pairs) {
        if (usedS.has(si) || usedG.has(g)) continue;
        usedS.add(si); usedG.add(g);
        session[si] = withGen(session[si], g.gen!);
    }
    return { session, server: serverEvents.filter((e) => !usedG.has(e)) };
}

/** One session block with a matched generation's figures, and its model stretch split where they fit. */
function withGen(e: ResourceEvent, timings: GenTimings): ResourceEvent {
    const phases = e.phases?.length ? e.phases : [{ kind: "model" as PhaseKind, until: e.until ?? e.t }];
    const out: { kind: PhaseKind; until: number }[] = [];
    let from = e.t, split = false;
    for (const [i, ph] of phases.entries()) {
        const next = phases[i + 1];
        if (!split && ph.kind === "model") {
            const len = ph.until - from;
            // Followed by a channel phase → this is the stretch BEFORE the first token: prefill ends where it
            // ends. Otherwise it is the whole model call: decode ends where it ends, prefill before that.
            const streamed = !!next && ["think", "answer", "call"].includes(next.kind);
            const swapMs = timings.swap?.ms ?? 0;
            const need = swapMs + timings.promptMs + (streamed ? 0 : timings.evalMs);
            if (need <= len) {
                const prefillEnd = streamed ? ph.until : ph.until - timings.evalMs;
                const prefillFrom = prefillEnd - timings.promptMs;
                const swapFrom = prefillFrom - swapMs;
                if (swapFrom - from >= 1) out.push({ kind: "other", until: swapFrom });
                if (swapMs) out.push({ kind: "swap", until: prefillFrom });
                out.push({ kind: "prefill", until: prefillEnd });
                if (!streamed) out.push({ kind: "decode", until: ph.until });
                split = true;
                from = ph.until;
                continue;
            }
        }
        out.push(ph);
        from = ph.until;
    }
    return { ...e, gen: timings, ...(split ? { phases: out } : {}) };
}

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
    /** `aside` is a model call YOU triggered while reading — the code annotator, a summary. It belongs on the
     *  timeline because it spent tokens on this box and takes time you can see, and it is a separate kind
     *  because it is NOT part of the run: charging it to the run would make two runs incomparable on the
     *  strength of how much someone poked at one of them. Drawn outlined rather than filled, for the same
     *  reason. */
    kind: "run" | "session" | "gen" | "tool" | "embed" | "load" | "evict" | "error" | "note" | "serve" | "aside";
    label: string;
    /**
     * WHERE THIS EDGE CAME FROM, for the kinds a box can produce two ways.
     *
     * `"poll"` is INFERRED by diffing `/api/ps` — it says a model was there and then was not, which is the
     * most that can be read off polls: they cannot see a load happening (for most of one there is no runner
     * object at all), and they cannot tell an eviction that made room from an idle expiry. `"server"` is the
     * event stream's own edge, which knows both.
     *
     * The distinction has to travel because the panel SAYS which it is: a note reading "nothing reports an
     * eviction" is honest about an inference and false about an edge the server reported, on the very setup
     * the stream exists for. Absent on the kinds that are neither (a run, a generation).
     */
    via?: "poll" | "server";
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
    /** Where clicking this span goes. `seq` names a STEP; without one it is a container, and `answer` says
     *  WHICH of the session's answers it ends at — a session holds one per run, so without it every run
     *  clicked through to the same final answer. */
    ref?: { hash: string; seq?: number; answer?: number };
    /** A composite span's PHASES, in order, each ending at `until`. A tool step is one block because it is one
     *  step and you reason about its parts together — but the parts are different kinds of time and must look
     *  different: the model generating the call, the human deciding whether to allow it, and the tool actually
     *  running. A step that waited two minutes for a click otherwise looked exactly like one that ran
     *  instantly, since only the last part is work the machine did.
     *
     *  `think`/`answer`/`call` SUBDIVIDE the model's own time, and only on a STREAMED call, where the channel
     *  each chunk arrived on is observable. `model` is the undifferentiated fallback — a non-streamed call,
     *  and the stretch before the first token (prompt eval, queue, network), which is the model's time but
     *  not any of its channels.
     *
     *  `queue`/`net` subdivide a REMOTE tool's time the same way, and for the same reason — because the
     *  executor reported its own numbers. What it said it spent evaluating is `tool`, what it spent getting
     *  started is `queue`, and whatever is left of OUR wall clock is `net`: the network and the far end's
     *  overhead. A local tool is all `tool`, which is exactly true rather than a fallback.
     *
     *  `weights`/`context` split a LOAD, and only when the server reported the boundary. They are not
     *  "loading" and "warming up": the second half ALLOCATES, and on a long-context model it allocates most
     *  of the footprint — measured as a second memory step some seconds after the weights land, immediately
     *  before the model will serve. So the span says "resident at 4s, usable at 10s", which is a readiness
     *  fact and the explanation a reader otherwise lacks for a memory trace that went flat while they waited. */
    phases?: { kind: PhaseKind; until: number }[];
    /** What a model LOAD moved into memory, as the server measured it: `loadBytes` is the whole load,
     *  `weightsBytes` the first half — so the context is the difference. Only a patched Ollama reports them
     *  (`size_vram` on the `load.weights` and `load.complete` edges).
     *
     *  They differ from the DEVICE's own step by the CUDA context floor (~0.69 GiB per card), which is
     *  agreement rather than drift: the device figure includes the driver context, the model's does not.
     *  Do not reconcile the two to zero. */
    loadBytes?: number;
    weightsBytes?: number;
    /** The WHOLE model, against `loadBytes` which is what reached the DEVICE. They are equal when it fit and
     *  differ when it did not: llama-server re-fits against the memory actually free, so an under-predicted
     *  load does not fail — it quietly runs the remainder on the CPU and is merely slow. There is no error
     *  and no other signal, so this difference is the only way to know a load was degraded. */
    totalBytes?: number;
    /** What the server's PREDICTOR expected this load to hold (the last `estimate` frame before it completed),
     *  and what the load actually held by kind (`load.complete`'s `memory`). For tuning the predictor, so the
     *  panel shows them only when asked (`predictView`). */
    estimate?: LoadEstimate;
    measured?: MemoryBreakdown;
    /** The ENGINE's own figures for a generation — prompt and cached tokens, prefill and decode durations,
     *  tokens decoded — when the server's event stream reported it (`gen.end.timings`). On a server `gen`
     *  span, and on a session block the server's generation was JOINED to (see `joinGens`). */
    gen?: GenTimings;
    /** On a session model call: OUR id for its request (`hint.request`, from its usage), so the server's record of
     *  the same generation joins to it exactly (see `joinGens`). */
    requestId?: string;
    /** On a SERVER generation: what the request said it was for (`gen.end.hint`, see `hintFrom`) — ours, when it
     *  carries our request id, or another client's traffic, which the lane can then name. */
    hint?: ServerHint;
    /** The model's KV-cache CAPACITY when a generation ended — its context (per slot) and slot count, read from
     *  the sample at that moment — so the cache fill can be drawn as shares wherever the span is shown, not only
     *  inside a drilled-in chart. Absent when no sample carried the model then. */
    genCtx?: { contextTokens: number; slots: number };
    /** The model's decode CEILING (or the reason it has none) at the generation's end, from the same sample as
     *  `genCtx` — so the tooltip can put the measured decode rate against the ceiling AT THAT CONTEXT. */
    genRoofline?: Roofline;
    /** This span has NOT FINISHED: `until` is where it had reached when the snapshot was taken, not where it
     *  ended. Only ever set by an `eventsFrom` given a `now` — a surface drawing live. It exists so the UI can
     *  say "still going" rather than drawing a bar whose right edge looks like a measured end. */
    open?: true;
    /** The tool that ran, for a composite span. */
    tool?: string;
    /** What it cost, for the kinds that spend tokens. Plain numbers rather than a RunStats import: this module
     *  stays standalone, and the surface that renders it already knows how to say "eval" vs "wall". */
    cost?: {
        inTokens: number; outTokens: number; tokPerSec: number | null;
        genBasis: "eval" | "wall" | "mixed" | null;
        /** Ollama's generation-only time and our own wall clock for the same call, when both are known. Their
         *  DIFFERENCE is what the network and the queue cost — the one number that separates "the model is
         *  slow" from "getting to the model is slow", and it exists only where the native route reports
         *  `eval_duration` beside our measurement. */
        evalMs?: number;
        wallMs?: number;
        /** Reading the prompt, when the native route reports it. Splits the wall-minus-generation remainder
         *  into model work and box latency, which are not the same kind of thing and cannot be compared
         *  between two models while they are one number. */
        promptEvalMs?: number;
        /** How long the model took to LOAD before this call could start (`load_duration`). Inside `wallMs`,
         *  so anything deriving "network" from the wall clock has to subtract it — see the tooltip. */
        loadMs?: number;
        /** How many of `inTokens` the server's prefix cache served — see `TokenUsage.cachedTokens`. Time, not
         *  spend: shown beside the count, never subtracted from it. */
        cachedTokens?: number;
    };
}

/** A LOAD's two internal edges, as instants to rule through the PLOT: where the weights finished arriving, and
 *  where the KV cache and compute buffers finished being allocated (the model can serve from there). Those are
 *  exactly the two steps in the device's free-memory trace during a load, and the lane — where the load's
 *  halves live as phases — is often collapsed, so without these the chart showed a two-step ramp with nothing
 *  saying what either step was. Only for a load whose boundary the SERVER reported (it has `phases`); an
 *  inferred load has no boundary and gets no rules, since a rule is a claim about when something happened.
 *  Each carries the bytes that half moved, when reported. */
export function loadEdges(e: ResourceEvent): ResourceEvent[] {
    if (e.kind !== "load" || e.until == null || !e.model) return [];
    const w = e.phases?.find((ph) => ph.kind === "weights");
    if (!w) return [];
    const ctx = e.loadBytes != null && e.weightsBytes != null ? e.loadBytes - e.weightsBytes : null;
    return [
        { t: w.until, kind: "load", model: e.model, ...(e.via ? { via: e.via } : {}),
          label: `${e.model} weights loaded${e.weightsBytes != null ? ` (${formatBytes(e.weightsBytes)})` : ""}` },
        { t: e.until, kind: "load", model: e.model, ...(e.via ? { via: e.via } : {}),
          label: `${e.model} KV cache and compute buffers allocated${ctx != null ? ` (${formatBytes(ctx)})` : ""} — ready to serve` },
    ];
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
