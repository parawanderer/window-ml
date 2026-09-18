// resource-topology.ts — the GPU link graph: what the server measured about each PAIR of cards, and the
// readings the panel takes off it (is this pair bridged, which order do the cards go in, where do the walls
// between them fall, how is one link described). Pure, and never invents a link: an unreported pair is
// missing, never PCIe by default.

import type { Wire, GPUTopology, GPULink } from "./events-wire";

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
    /** How many NVLink links the pair has (`nvlink_count`). NVLink only: no other fabric reports a count. */
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
    const o = raw as Wire<GPUTopology>;
    const status = typeof o.status === "string" && o.status ? o.status : null;
    if (!status) return null;
    const gpus = Array.isArray(o.gpus) ? o.gpus.filter((g): g is string => typeof g === "string" && !!g.trim()).map((g) => g.trim()) : [];
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const seen = new Map<string, TopoLink>();
    for (const x of Array.isArray(o.links) ? o.links : []) {
        const l = x as Wire<GPULink>;
        const a0 = typeof l.a === "string" ? l.a.trim() : "", b0 = typeof l.b === "string" ? l.b.trim() : "";
        if (!a0 || !b0 || a0 === b0) continue;          // a diagonal is not a link
        const [a, b] = a0 < b0 ? [a0, b0] : [b0, a0];
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.set(key, {
            a, b, type: typeof l.type === "string" && l.type ? l.type : "unknown",
            ...(typeof l.path === "string" && l.path ? { path: l.path } : {}),
            ...(typeof l.pcie_path === "string" && l.pcie_path ? { pciePath: l.pcie_path } : {}),
            // NVLink only. A non-NVLink fabric reports NO count: KFD describes an xGMI pair by type and bandwidth and never
            // says how many physical links make it up (fork schema report, 2026-09-17), so no count is inferred for one.
            ...(n(l.nvlink_count) ? { linkCount: n(l.nvlink_count)! } : {}),
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
