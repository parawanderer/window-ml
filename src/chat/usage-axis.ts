// usage-axis.ts — the usage chart's time axis: calls split into stretches at long idle gaps, each gap collapsed to a marker.
//
// A session over several days is a few bursts of calls with idle days between, which a linear axis draws as clumps at the
// ends of a wide empty plot. This axis gives each stretch of activity a width proportional to its own duration and shrinks
// every gap to a fixed-width marker. It is local to the usage chart: the resource panel's axis stays linear in clock time.
// Pure: no DOM, no signals. A session with no gap is one stretch and the axis is linear, exactly the plain time axis.
//
// `fracOfTime` and `timeOfFrac` are an inverse pair over the whole session, monotone, piecewise linear: inside a stretch
// time is linear, and inside a gap the gap's real duration is spread linearly over the marker, so a frac in a gap lands
// between the gap's edges. A zoom window is held in TIMES; a gesture on it is done in fractions of the whole axis
// (`nudgeWindow`, `pinchWindow`) with the panel's scrub helpers, which only assume their extent is a plain interval.

import { clampWindow, scrubNudge, scrubPinch } from "../resource/resource-axis";

/** An inter-call interval longer than this is a gap: the session was idle, and the chart folds it away. */
export const GAP_MS = 30 * 60_000;

/** The share of the whole axis one gap marker takes (about 8 px of the summary's plot), while there are few gaps. */
export const GAP_SHARE = 0.03;

/** The most of the axis all gap markers together may take: past it each marker narrows, so the stretches keep the rest. */
export const GAPS_MAX_SHARE = 0.6;

/** The narrowest a window of a gesture may get, as a share of the whole axis. */
const MIN_WINDOW_FRAC = 0.01;

/** One piece of the axis: a stretch of activity or the idle gap after it, with the times it covers and the span of the
 *  whole axis (`f0`..`f1`, 0 to 1) it is drawn in. */
export interface AxisPiece { kind: "stretch" | "gap"; t0: number; t1: number; f0: number; f1: number; /** calls in a stretch */ calls: number }

/** The axis of a session: its pieces in order, from the first call to the last. */
export interface UsageAxis { t0: number; t1: number; pieces: AxisPiece[] }

/**
 * The axis for calls stamped `ts`, or null when there are none. Stretches are runs of calls no more than `gapMs` apart.
 * A stretch's width is proportional to its duration; a stretch of one call (duration 0) gets a floor so its mark is not
 * on the gap marker beside it: the larger of the shortest non-zero stretch and 1% of the stretches' total (all equal
 * when no stretch has any duration). Each gap is `GAP_SHARE` of the axis, narrowed when there are so many that together
 * they would pass `GAPS_MAX_SHARE`, so the stretches always keep at least the rest. One stretch is the whole axis, linear.
 * @param ts the calls' stamps, any order
 */
export function usageAxis(ts: readonly number[], gapMs = GAP_MS): UsageAxis | null {
    const sorted = ts.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const runs: { t0: number; t1: number; calls: number }[] = [];
    for (const t of sorted) {
        const r = runs[runs.length - 1];
        if (r && t - r.t1 <= gapMs) { r.t1 = t; r.calls++; } else runs.push({ t0: t, t1: t, calls: 1 });
    }
    const durs = runs.map((r) => r.t1 - r.t0);
    const total = durs.reduce((a, b) => a + b, 0);
    const minPos = Math.min(Infinity, ...durs.filter((d) => d > 0));
    const floor = total > 0 ? Math.max(minPos, total * 0.01) : 1;
    const weights = durs.map((d) => (d > 0 ? d : floor));
    const wSum = weights.reduce((a, b) => a + b, 0);
    const gaps = runs.length - 1;
    const share = Math.min(GAP_SHARE, GAPS_MAX_SHARE / Math.max(1, gaps));
    const room = 1 - gaps * share;
    const pieces: AxisPiece[] = [];
    let f = 0;
    runs.forEach((r, i) => {
        const w = (weights[i] / wSum) * room;
        pieces.push({ kind: "stretch", t0: r.t0, t1: r.t1, f0: f, f1: f + w, calls: r.calls });
        f += w;
        if (i < gaps) { pieces.push({ kind: "gap", t0: r.t1, t1: runs[i + 1].t0, f0: f, f1: f + share, calls: 0 }); f += share; }
    });
    if (pieces.length) pieces[pieces.length - 1].f1 = 1;
    return { t0: sorted[0], t1: sorted[sorted.length - 1], pieces };
}

/** Where time `t` sits across the whole axis, 0 to 1, clamped. A lone call's stretch has no duration: it reads its middle. */
export function fracOfTime(a: UsageAxis, t: number): number {
    if (t <= a.t0 && a.pieces[0].t1 > a.pieces[0].t0) return 0;
    if (t >= a.t1 && a.pieces[a.pieces.length - 1].t1 > a.pieces[a.pieces.length - 1].t0) return 1;
    let hit: AxisPiece | null = null;
    for (const p of a.pieces) {
        if (p.kind === "stretch" && p.t0 === p.t1 && t === p.t0) return (p.f0 + p.f1) / 2;
        if (!hit && t >= p.t0 && t <= p.t1) hit = p;
    }
    if (!hit) return t < a.t0 ? 0 : 1;
    const span = hit.t1 - hit.t0;
    return span > 0 ? hit.f0 + ((t - hit.t0) / span) * (hit.f1 - hit.f0) : (hit.f0 + hit.f1) / 2;
}

/** The time at a fraction of the whole axis, clamped to it: the inverse of `fracOfTime`. A frac inside a gap lands
 *  between the gap's two edge times. */
export function timeOfFrac(a: UsageAxis, f: number): number {
    const c = Math.min(1, Math.max(0, f));
    const p = a.pieces.find((q) => c <= q.f1) ?? a.pieces[a.pieces.length - 1];
    const w = p.f1 - p.f0;
    return w > 0 ? p.t0 + ((c - p.f0) / w) * (p.t1 - p.t0) : p.t0;
}

/** A zoom window (times) as fractions of the whole axis; the whole axis when there is none. */
export function windowFracs(a: UsageAxis, win: { from: number; to: number } | null): { from: number; to: number } {
    return win ? { from: fracOfTime(a, win.from), to: fracOfTime(a, win.to) } : { from: 0, to: 1 };
}

/** A window held in fractions of the axis, as times: null when it covers the whole axis (no selection at all). */
function toWindow(a: UsageAxis, f: { from: number; to: number }): { from: number; to: number } | null {
    if (f.from <= 1e-9 && f.to >= 1 - 1e-9) return null;
    return clampWindow({ from: timeOfFrac(a, f.from), to: timeOfFrac(a, f.to) });
}

/** The window after sliding it by a fraction of ITS OWN width (a wheel gesture), done in fractions of the axis so a gap
 *  costs a marker's width, not its length. Null when the result covers everything. */
export function nudgeWindow(a: UsageAxis, win: { from: number; to: number } | null, byWindowFraction: number): { from: number; to: number } | null {
    return toWindow(a, scrubNudge({ from: 0, to: 1 }, windowFracs(a, win), byWindowFraction));
}

/** The window after a pinch, the instant under `anchorFrac` (0 to 1 across the window) held in place. See `scrubPinch`. */
export function pinchWindow(a: UsageAxis, win: { from: number; to: number } | null, deltaY: number, anchorFrac: number): { from: number; to: number } | null {
    return toWindow(a, scrubPinch({ from: 0, to: 1 }, windowFracs(a, win), deltaY, anchorFrac, MIN_WINDOW_FRAC));
}

/** An idle length for a gap marker and its tip: "2d 4h idle", "45m idle". The two largest units, zeros dropped. */
export function idleLabel(ms: number): string {
    const m = Math.max(1, Math.round(ms / 60_000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
    const parts = d ? [`${d}d`, h ? `${h}h` : ""] : h ? [`${h}h`, min ? `${min}m` : ""] : [`${min}m`];
    return `${parts.filter(Boolean).join(" ")} idle`;
}
