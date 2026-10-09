// residency.ts — one `/api/ps` row (as `loadedFrom` reads it) as the residency the resource chart draws. Pure, so the
// panel's feed and the bench's own poller (tests/e2e/bench/resource-poll.mjs) build the same sample from the same body.

import type { LoadedModel } from "../contract";
import { activityFrom, rooflineFrom, expectedDecodeFrom } from "./resource-decode";
import { type ModelResidency, memorySplit, type MemoryBreakdown, placementFrom, normModel } from "./resource-model";

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

// A `state: "loading"` ROW IS A PLACEHOLDER, NOT A MODEL HOLDING ZERO BYTES. It carries its name and
// zeros for everything else — no `size_vram`, no `gpus` — so read as a residency it says the model is
// here and using nothing, which is the notch: a band straight down to the axis and back up.
//
// And it was not only said of a model that is genuinely loading. Measured on a real box (capture
// 2026-09-05, t=76085..77473): a model RESIDENT and serving with 94,171,928,982 bytes on CUDA0 was
// re-reported as `loading` with zeros while a DIFFERENT model loaded, then back to its full figure 2ms
// later — with the server's own top-level `vram_used` unchanged at 94,171,928,982 through every frame.
//
// FIXED SERVER-SIDE since (parawanderer/ollama `slop`, deployed as ollama-slop:latest). The cause was
// narrower and worse than it looked: `state: "loading"` meant "I could not take this runner's lock just
// now", and ordinary traffic holds that lock — a request finishing, an expiry being reset, another model
// being admitted. `vram_used` disagreed because device discovery never consulted it. A `loading` row now
// appears only for a model that genuinely has no runner.
//
// KEPT ANYWAY, because it costs one comparison and it is the difference between a wrong reading and a
// right one on every build older than that fix — including whatever a user happens to be running. The
// one case it is imprecise in is a model evicted and reloaded inside a single poll, where it carries a
// stale figure for one reading; that is self-correcting and far cheaper than the notch.
// So a placeholder is NO NEWS, not news of zero — and for a model we last measured as resident, no news
// means it is still there. Carrying the previous reading forward is what keeps the band flat across the
// flicker; dropping the row instead would leave the model with no row at all for that frame, which draws
// the same notch by a different route. A model that genuinely goes away stops appearing in `ps` entirely,
// or arrives as an `unload` edge — neither of which this touches.
/**
 * One `/api/ps` reading as what is RESIDENT: names normalised (`normModel`), and each `loading` placeholder row either
 * the model's last reading (`previous`, when it was measured holding memory) or just a name in `placeholders`.
 */
export function residentFrom(raw: readonly LoadedModel[], previous: readonly LoadedModel[]): { loaded: LoadedModel[]; placeholders: string[] } {
    const named = raw.map((m) => (m.model === normModel(m.model) ? m : { ...m, model: normModel(m.model) }));
    const wasResident = new Map(previous.map((m) => [m.model, m]));
    const placeholders: string[] = [];
    const loaded: LoadedModel[] = [];
    for (const m of named) {
        if (m.state !== "loading") { loaded.push(m); continue; }
        const known = wasResident.get(m.model);
        if (known && (known.vramBytes ?? 0) > 0) loaded.push(known);   // still here; the row just said nothing
        else placeholders.push(m.model);                               // genuinely loading — a name, no figures
    }
    return { loaded, placeholders };
}
