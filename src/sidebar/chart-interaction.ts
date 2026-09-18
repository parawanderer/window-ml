// chart-interaction.ts — what the pointer and the keyboard are currently on in the resource chart, and what the
// chart publishes as it renders.
//
// This is SHARED STATE, and it is a module because of who reads it rather than for tidiness. The chart, the event
// lane, every track's band tip and the pool tips all place a tooltip from the same cursor and all decide what is
// lit from the same hover — and they live in different files. Holding this in the chart meant the lane could not
// leave it, and holding the pool half in vram.tsx meant the two files imported each other.
//
// Two shapes on purpose. Signals for what a POINTER does, because a render must react to it. A plain `live`
// holder for what the chart publishes as it draws, because that is written DURING render, where a signal either
// warns or re-enters.

import { signal } from "@preact/signals";
import type { Band } from "../resource-bands";
import type { EventPlacement, ResourceEvent, ResourceSample } from "../resource-model";
import type { Axis, RunGap } from "../resource-axis";
import { lineageOf } from "../resource-lane";
import { zoomRange, resWindowS, laneScoped, scopedHash } from "./store";
import { releaseFocus, kbPool } from "./vram-focus";

/** The pool (card or host) currently hovered in the chart, and which models sit on it. The model rows below
 *  ARE the legend, so rows not on that pool grey out — reusing what is already on screen instead of injecting
 *  a row that shifts the layout under the cursor. */
// WHICH pool is hovered, not what it held when you got there — the pool is identified by the LINE, while the
// figures come from the DATAPOINT the pointer is on (see PoolTip). Keeping the reading out of this signal is
// what lets the tip follow the cursor along a line and report a different instant at each x.
export const poolHover = signal<{ id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] } | null>(null);

/** Which overlay POOL (a card, or the host) is hovered — the line and its key light together. */
export const hoverPool = signal<string | null>(null);

/** Where in the PLOT the pointer is (CSS px, and the plot's own width), so the tip can follow it and decide
 *  which side to sit on. Tracked on the plot rather than on each polygon: a polygon's offsetX is relative to
 *  its own segment's SVG, so with several segments it would jump, and the viewBox is 300 units wide whatever
 *  the panel's real pixel width is. */
// The cursor, in VIEWPORT coordinates, plus WHICH surface it is over. Two fixes in one:
//   • Viewport, not element-relative. A tip positioned inside a 9px lane row has nowhere to go but under the
//     pointer, which is exactly where a tooltip must never be. Against the window it flips like every other
//     tip in the panel (tip.ts), so the behaviour is one implementation rather than per-container luck.
//   • A surface, because every track renders a BandTip and the lane renders an EventTip, all reading these
//     same signals — so hovering a lane bar (which cross-highlights a model) made every track's band tip
//     appear at once. A tip renders only for the surface the pointer is actually on.
export const hoverAt = signal<{ x: number; y: number; w: number; surface: string; yFrac?: number } | null>(null);

/**
 * IS THE TOOLTIP MUTED? Esc hides it so you can LOOK at the chart, and the next pointer movement brings it
 * back. A cursor tip has to sit near the pointer to be readable, which means it sits on top of the trace you
 * paused over — so the one moment you want to study a shape is the one moment something is covering it.
 *
 * Deliberately not sticky: it clears on the next move rather than needing a second Esc, because the gesture
 * is "get out of the way for a second", not a mode. Nothing else about the hover changes — the crosshair and
 * its dots stay, since they mark WHERE you were looking and that is the thing being preserved.
 */
export const tipMuted = signal(false);

/** Read the cursor for a surface, or null when the pointer is somewhere else. */
export const cursorAt = (surface: string) => (tipMuted.value || hoverAt.value?.surface !== surface ? null : hoverAt.value);

/** Track a pointer against the viewport, tagged with the surface it is over. */
export const trackCursor = (surface: string) => (e: PointerEvent) => {
    tipMuted.value = false;   // moving is the ask for it back — see tipMuted
    // MOVING HANDS THE FOCUS BACK. A keyboard selection holds against everything else — including a band
    // sliding under a still cursor as samples arrive, which raises `pointerenter` with nobody having touched
    // anything — and it is a real move that ends it. See releaseFocus.
    releaseFocus(e.target);
    releasePool(e.target);
    readingSurface = surface;
    // `yFrac` is the pointer's height within the PLOT (0 = top, 1 = bottom), which is the only thing that can
    // say which of several overlaid lines the pointer is nearest. Read off the plot element rather than the
    // event target: the hit targets are strokes inside it, so measuring against those would give the pointer's
    // position within a 10px band and mean nothing.
    const plot = (e.currentTarget as HTMLElement)?.closest?.(".rc-plot") as HTMLElement | null;
    const box = plot?.getBoundingClientRect();
    hoverAt.value = {
        x: e.clientX, y: e.clientY, w: typeof window !== "undefined" ? window.innerWidth : 1024, surface,
        ...(box && box.height > 0 ? { yFrac: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) } : {}),
    };
};

/**
 * WHICH SURFACE THE READING IS ON, so one key can mean "the thing this view draws" in every view. Recorded from
 * the pointer's own surface rather than from the layout, because a layout may hold tracks of several kinds and
 * the answer is about where the reader is pointing. It OUTLIVES a pointerleave deliberately: the keyboard keeps
 * reading after the pointer wanders off, and it has to keep reading the same view.
 */
export let readingSurface: string | null = null;

/** Hand the LINE focus back to the pointer, on a real move and nothing else — the twin of `releaseFocus`. */
function releasePool(target: EventTarget | null): void {
    if (!kbPool.value) return;
    kbPool.value = null;
    if (!(target as Element | null)?.closest?.(".rc-hit")) leavePool();
}

/** The pointer is now over a POOL (a device track, or the whole box): remember which, so the plots dim the
 *  others, and remember the pool itself so its tip can be drawn from the sample under the cursor. */
export function enterPool(p: { id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] }): void {
    hoverPool.value = p.id;
    // The pool itself, not a reading of it — every figure is derived from the sample under the cursor at
    // render time. Its COLOUR rides along so the tip can carry the same swatch its legend key does: several
    // lines cross in one plot, and a tip that only names a device leaves you matching a name to a stroke by
    // eye, which is the work the legend's swatches already do everywhere else.
    poolHover.value = { id: p.id, name: p.name, ceiling: p.ceiling, color: p.color, bandsOf: p.bandsOf };
}

/** The pointer has left every pool. Both halves are cleared together: `hoverPool` is what the chart dims by
 *  and `poolHover` is what the tip reads, and one surviving the other leaves a tip with nothing under it. */
export function leavePool(): void { hoverPool.value = null; poolHover.value = null; }

/**
 * THE RUNS THE PLOTS ARE CURRENTLY DRAWN FROM.
 *
 * A drag outlives the render that started it: `onPointerDown={startBrush(runs)}` closes over the array from
 * whichever render attached the handler, and every poll after that leaves it one sample staler. The mark
 * re-resolves per render and the brush did not, which is exactly how they came to name different samples.
 *
 * A plain module-level ref rather than a signal, deliberately: it is written DURING render, and a signal
 * written during render re-enters rendering. Nothing reads it to decide what to DRAW — only the pointer
 * handlers, which run outside render and want the newest data there is.
 */
/**
 * WHAT THE CHART PUBLISHES AS IT RENDERS, for every plot, overlay and pointer handler to read.
 *
 * `axis` is the window the plots are drawn on ({@link Axis}), linear in clock time, so they all place a moment at
 * the same x. `runs` is the sample data a plot is about to draw, which a drag begun in the same frame must not
 * read a previous version of.
 *
 * Plain refs rather than signals, deliberately: both are written DURING RENDER, and a signal written during
 * render either warns or re-enters. They live in one object rather than as two `let`s so the binding can be
 * imported — an imported `let` is read-only, which is what stopped the lane and the pointer state moving out of
 * this file at all.
 */
export const live: { axis: Axis | null; runs: ResourceSample[][] | null } = { axis: null, runs: null };

/**
 * THE AXIS HOLDS STILL UNDER THE POINTER. A chart that scrolls while you read it moves the thing you are pointing at:
 * the crosshair's sample walks away, a tooltip changes under a still cursor, a drag's anchored edge slides. So while
 * the pointer is over the plots or the lane, the axis it entered on is held, and the chart catches up to now when
 * the pointer leaves. Samples keep arriving meanwhile; they are drawn past the right edge until then.
 */
export const chartHeld = signal<{ axis: Axis; key: string } | null>(null);

/** WHAT the held axis was a view OF. Holding is for passive reading only: a zoom, a scrub, a new width or a change of
 *  scope is you navigating, and a hold taken before it would pin the chart to the stretch you just asked to leave. */
export const holdKey = (): string =>
    `${zoomRange.value?.from ?? ""}:${zoomRange.value?.to ?? ""}:${resWindowS.value}:${laneScoped.value}`
    // The open session changes the window only when the chart is SCOPED to it. Keying it in regardless released the hold
    // on the first click of a double-click (a click opens the step), so the chart jumped between the two clicks and the
    // second one missed the bar it was meant for.
    + (laneScoped.value ? `:${scopedHash() ?? ""}` : "");

/** When the pointer last did anything over a chart surface. */
export let lastPointerAt = 0;

/** A hold with no pointer activity over the chart for this long lets go. The backstop for where nothing can say the
 *  pointer has left: the DevTools panel, and any exit the browser does not report into the iframe. */
export const HOLD_LAPSE_MS = 8000;

/** Hold the axis as the pointer comes onto (or moves over) a chart surface. */
export const holdAxis = () => {
    lastPointerAt = Date.now();
    if (!chartHeld.value && live.axis) chartHeld.value = { axis: live.axis, key: holdKey() };
};

/** Let it go when the pointer leaves for somewhere that is not another chart surface (plots → lane keeps it held). */
export const releaseAxis = (e: PointerEvent) => {
    const to = e.relatedTarget as Element | null;
    if (!to?.closest?.(".rc, .rc-lane")) chartHeld.value = null;
};

/** Let go outright: the pointer is somewhere else entirely. Called when the overlay's shell reports the pointer on the
 *  PAGE, which the iframe is otherwise never told (see `relayPointerOut` in shell.ts). */
export function releaseAxisHold(): void { if (chartHeld.value) chartHeld.value = null; }

/** Publish the runs a plot is about to draw, for the pointer handlers. Call it from a render, not an effect:
 *  a drag begun in the same frame must not consult the previous one's data. */
export const noteRuns = (runs: ResourceSample[][]): ResourceSample[][] => (live.runs = runs);

/** One event's identity across surfaces: the same eviction is drawn in every track, so hovering it anywhere
 *  must highlight it everywhere. Its time and what it was are enough to identify it. */
export const eventKey = (e: ResourceEvent): string => `${e.kind}:${e.t}:${e.model ?? ""}`;

/** A lane bar's DOM identity: the event it draws, never its index in a row. Keyed by index, a row that re-packed as a
 *  live run grew handed the same button to a different event under a still pointer; no `pointerenter` fired, so the
 *  hover went on naming the event that button used to be (a hovered aside showed the run's tooltip). */
export const barKey = (e: ResourceEvent): string => e.id ?? `${eventKey(e)}:${e.ref?.hash ?? ""}:${e.ref?.seq ?? ""}:${e.label}`;

/** The event the pointer is ON, by `barKey` — the one thing every lane bar, phase strip and card checks to
 *  decide whether it is the lit one. A key rather than the event, because the same event is re-derived each
 *  render and an object identity would not survive it. */
export const hotEvent = signal<string | null>(null);

/** WHICH EVENTS A HOVER LIGHTS, for every surface that dims around it (the lane, each card's phase strip): the hovered event
 *  itself, by its bar key, plus its lineage. Null when nothing should dim — no hover, or a hover on an event that is no
 *  longer among `events` (a held signal outlives the bar it named, and dimming everything for it reads as the lane
 *  vanishing). The key, not only the lineage id: a server-reported generation has no id, so hovering one dimmed nothing. */
export function litBy(events: readonly ResourceEvent[], hovered: ResourceEvent | undefined): ((e: ResourceEvent) => boolean) | null {
    if (!hovered) return null;
    const key = barKey(hovered);
    if (!events.some((e) => barKey(e) === key)) return null;
    const lineage = lineageOf(events, hovered.id);
    return (e) => barKey(e) === key || (e.id != null && lineage.has(e.id));
}

/** The hovered event, and WHICH surface owns it. Every track's plot renders a tip (a ruled instant is hovered
 *  in the plot, where its meaning is) and so does the lane — all driven by this one signal, so without an
 *  owner every one of them rendered the same tooltip at once, four deep on a three-track panel. */
export const eventHover = signal<{ p: EventPlacement; scope: string } | null>(null);

/** The hovered GAP between two runs, and which surface owns it — the same arrangement as `eventHover`, and for the
 *  same reason: the plot's own reading stands down while it is pointed at (see `cursorOn`). */
export const gapHover = signal<{ gap: RunGap; scope: string } | null>(null);
