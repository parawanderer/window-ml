// chart-paint.ts — how the resource chart paints: the plot's viewBox and the colour each band and memory part fills with.
//
// Shared by the stacked area, the track views and the reading tooltips, which is why it sits below all three
// rather than in resource-chart.tsx: a tooltip that names a band's colour and the plot that fills it must agree.

import type { Band } from "../../resource/resource-bands";
import type { MemoryBreakdown } from "../../resource/resource-model";
import { colorFor } from "../palette";

/** The plot's SVG viewBox, width and height; every plot is stretched to its track, so these are units, not pixels. */
export const W = 300, H = 72;

/** Which model each residual band is TINTED with (`Band.of`) — a runner's overhead, a load in flight. Kept
 *  apart from `bandIdentity` on purpose: identity makes a band hoverable, hideable and stepped as the model. */
export function bandTint(frames: Band[][]): Record<string, string | undefined> {
    const by: Record<string, string | undefined> = {};
    for (const bands of frames) for (const b of bands) if (b.of && !by[b.key]) by[b.key] = b.of;
    return by;
}

/** Which model each band key belongs to, from ANY frame in the window. Read only from the LAST frame, a model
 *  that evicted before the newest sample had no entry there — so its whole history lost its colour and turned
 *  into anonymous grey, and it stopped being hoverable, exactly where the chart's job is to say what WAS
 *  there. The history is the point; a band keeps its identity for as long as it is drawn. */
export function bandIdentity(frames: Band[][]): Record<string, string | undefined> {
    const by: Record<string, string | undefined> = {};
    for (const bands of frames) for (const b of bands) if (b.model && !by[b.key]) by[b.key] = b.model;
    return by;
}

/** The fill a band is drawn with: its model's colour, a thin wash of it for a residual that belongs to a model, grey otherwise. */
export const bandFill = (key: string, model: string | undefined, tint?: string): string => {
    if (key === "free") return "transparent";
    if (key === "other" || key === "unknown") return "var(--fg-faint)";
    // A residual that BELONGS to a model (its runner's overhead, its load) takes a thin wash of that model's
    // colour — related to the model at a glance, and never mistaken for the model's own memory.
    if (!model && tint) return `color-mix(in srgb, ${colorFor(tint)} 30%, var(--fg-faint))`;
    return model ? colorFor(model) : "var(--fg-faint)";
};

/** A memory PART, in the model's own colour so the decomposition still reads as that model rather than as a
 *  new set of things. The parts are told apart by WEIGHT, not by hue: weights keep the full colour (they are
 *  the model), context is lighter, and the overhead a user cannot act on is lighter still. A hue per part
 *  would put four unrelated colours inside one band and lose the identity the band exists to carry. */
const PART_MIX: Record<keyof MemoryBreakdown, number> = {
    weights: 100, kvCache: 62, recurrentState: 62, projector: 44, compute: 26, output: 18, other: 18,
};

/** The fill for one memory part of a model, at the weight `PART_MIX` gives it. */
export const partFill = (model: string, key: keyof MemoryBreakdown): string => {
    const c = colorFor(model);
    const mix = PART_MIX[key];
    return mix >= 100 ? c : `color-mix(in srgb, ${c} ${mix}%, transparent)`;
};
