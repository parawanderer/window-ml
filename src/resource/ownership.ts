// ownership.ts — whose a resident model is: loaded for one of OUR sessions, loaded by someone else but used by ours, or
// neither, read from the box's own events and the session each generation named (`gen.end.hint.session`).
//
// The server names a session on generations only, never on a load, so "loaded for us" is read off the FIRST generation
// a load served: the request that made the load is the one waiting for it. Two requests queued on one cold model can
// finish in either order, so this is a reading, and the words that show it say what it was read from.

import { type ResourceEvent } from "./resource-timeline";
import { normModel } from "./resource-model";

/** Whose a residency is: `ours` (its first generation was ours), `used` (someone else's load that served ours too),
 *  `other` (ours never touched it, or it was loaded before the events begin and ours never used it). */
export type Owner = "ours" | "used" | "other";

/** One stretch of a model in memory: from a load (or from before the events begin, `from` -Infinity) to an eviction. */
interface Residency { from: number; to: number; first: { t: number; ours: boolean } | null; used: boolean }

/**
 * Whose each resident model was, at any instant, over `events` (the box's derived events: loads, evictions, server
 * generations with their hints). `ours(session)` says whether a hint's session is one of ours.
 *
 * Returns null when no generation in `events` names a session at all: a server that does not echo hints (stock
 * Ollama) would otherwise read as "nothing is ours", which is a claim, not an absence. The reader gives null for a
 * model with no residency at that instant.
 */
export function ownership(events: ResourceEvent[], ours: (session: string) => boolean): ((model: string, t: number) => Owner | null) | null {
    if (!events.some((e) => e.kind === "gen" && e.hint?.session)) return null;
    const byModel = new Map<string, Residency[]>();
    const stretches = (m: string) => byModel.get(m) ?? byModel.set(m, []).get(m)!;
    // Loads and evictions first, in time order, to cut each model's timeline into residencies.
    const edges = events.filter((e) => e.model && (e.kind === "load" || e.kind === "evict")).sort((a, b) => a.t - b.t);
    for (const e of edges) {
        const list = stretches(normModel(e.model!));
        const last = list.at(-1);
        if (e.kind === "load") {
            if (last && last.to === Infinity) last.to = e.t;
            list.push({ from: e.t, to: Infinity, first: null, used: false });
        } else if (!last) list.push({ from: -Infinity, to: e.t, first: null, used: false });
        else if (last.to === Infinity) last.to = e.t;
    }
    const covering = (list: Residency[], t: number) => {
        for (let i = list.length - 1; i >= 0; i--) if (list[i].from <= t) return list[i].to >= t ? list[i] : null;
        return null;
    };
    for (const g of events) {
        if (g.kind !== "gen" || !g.model) continue;
        const list = stretches(normModel(g.model));
        // A generation with no load or eviction before it: the model was resident before the events begin.
        if (!list.length || list[0].from > g.t) list.unshift({ from: -Infinity, to: list[0]?.from ?? Infinity, first: null, used: false });
        const r = covering(list, g.t);
        if (!r) continue;
        const mine = !!g.hint?.session && ours(g.hint.session);
        if (mine) r.used = true;
        if (r.from > -Infinity && (!r.first || g.t < r.first.t)) r.first = { t: g.t, ours: mine };
    }
    return (model, t) => {
        const r = covering(byModel.get(normModel(model)) ?? [], t);
        // No load or eviction seen and no generation: resident since before the events begin, and ours never used it.
        if (!r) return byModel.has(normModel(model)) ? null : "other";
        return r.first?.ours ? "ours" : r.used ? "used" : "other";
    };
}
