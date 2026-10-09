// residency.ts — one `/api/ps` row (as `loadedFrom` reads it) as the residency the resource chart draws. Pure, so the
// panel's feed and the bench's own poller (tests/e2e/bench/resource-poll.mjs) build the same sample from the same body.

import type { LoadedModel } from "../contract";
import { activityFrom, rooflineFrom, expectedDecodeFrom } from "./resource-decode";
import { type ModelResidency, memorySplit, type MemoryBreakdown, placementFrom } from "./resource-model";

/** A LoadedModel (the ps relay's shape) → the residency the chart works in. Bytes, never the rounded GB: the
 *  bands subtract these from exact capacity figures. `gpus` absent means CPU-resident, and that absence is
 *  preserved as an empty device map rather than invented placement. */
export function residencyOf(m: LoadedModel): ModelResidency {
    const vram = m.vramBytes ?? 0, size = m.sizeBytes ?? 0;
    const perDevice: Record<string, number | null> = {};
    for (const g of m.gpus ?? []) perDevice[g.id] = g.vramBytes === 0 && vram > 0 ? null : g.vramBytes;
    // Parsed HERE, once — `memorySplit` is what checks the server's sum invariant, so every consumer reads a
    // split that has already been refused if it did not add up.
    const whole = memorySplit(m.memory, vram);
    const per: Record<string, MemoryBreakdown> = {};
    for (const g of m.gpus ?? []) {
        const one = memorySplit(g.memory, g.vramBytes ?? 0);
        if (one) per[g.id] = one;
    }
    const host = memorySplit(m.memoryHost, 0);
    return {
        model: m.model, vramBytes: vram, ramBytes: Math.max(0, size - vram), perDevice,
        contextLength: m.contextLength, expiresAt: m.expiresAt ? Date.parse(m.expiresAt) || null : null,
        ...(whole ? { memory: whole } : {}),
        ...(Object.keys(per).length ? { perDeviceMemory: per } : {}),
        ...(typeof m.weightsOnDisk === "number" ? { weightsOnDisk: m.weightsOnDisk } : {}),
        ...(host ? { memoryHost: host } : {}),
        ...((() => { const pl = placementFrom(m.placement); return pl ? { placement: pl } : {}; })()),
        ...((() => { const ac = activityFrom(m.activity); return ac ? { activity: ac } : {}; })()),
        ...((() => { const rf = rooflineFrom(m.roofline); return rf ? { roofline: rf } : {}; })()),
        ...((() => { const ed = expectedDecodeFrom(m.expectedDecode); return ed ? { expectedDecode: ed } : {}; })()),
    };
}
