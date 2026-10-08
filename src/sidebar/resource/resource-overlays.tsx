// resource-overlays.tsx — what is drawn OVER a resource plot rather than as its data: the dashed event rules, the
// gap marks, the crosshair and the hovered span, the predicted-load lines, the phase strip and the time grid.
//
// Every track view draws the same overlays, which is why they are shared here: an overlay written into one view
// is how the Overview preset once ended up with no event rules while the per-pool tracks had them.

import { type RunGap, axisGaps, axisFrac, timeAtFraction, runFrac, gridStep, gridTimes } from "../../resource/resource-axis";
import type { RibbonSpan } from "../../resource/resource-gens";
import { placeEvents } from "../../resource/resource-lane";
import { type ResourceSample, loadTrace } from "../../resource/resource-model";
import { type ResourceEvent, type EventPlacement, loadEdges, eventsIn } from "../../resource/resource-timeline";
import { live, eventKey, hotEvent, barKey, eventHover, trackCursor, gapHover, snapUnder, litBy, hoverAt } from "./chart-interaction";
import { resourceHistory } from "./panel-state";
import { colorFor } from "../palette";
import { phaseFill } from "./resource-lane-ui";
import { crosshair, timeGrid } from "../store";
import { clockAt } from "../timestamps";
import { hoverModel } from "./vram-focus";

/** The instants to rule through a plot, placed against its own segments. Shared, because writing them inline
 *  in one view is exactly how the Overview preset ended up with no rules at all while the per-pool tracks had
 *  them: the same events, drawn in one place and not the other. */
export function useInstants(events: ResourceEvent[]): EventPlacement[] {
    // Not memoised: the axis moves on every tick of a live chart, and the instants in a window are few.
    const axis = live.axis;
    if (!axis) return [];
    // The moments themselves, plus a server-split load's two internal edges (`loadEdges`) — the steps in the
    // memory trace a load draws, which otherwise had nothing on the plot saying what they were. Placed on the axis
    // by time alone: an eviction that happened in a gap is drawn in the gap, where it happened.
    const moments = [...events.filter((e) => e.until == null), ...events.flatMap(loadEdges)];
    return placeEvents(axis, eventsIn(moments, axis.from, axis.to));
}

/** The dashed rules themselves — an eviction is a moment in the memory trace, and its meaning is WHERE the
 *  curve steps, so it belongs on the plot rather than in the lane below. */
export function InstantRules({ instants, scope }: { instants: EventPlacement[]; scope: string }) {
    return <>{instants.map((p) => (
        // Keyed by the EVENT, not the element: the same eviction is drawn in every track, so hovering it in
        // one plot thickens it in all of them — one thing that happened, not three.
        <div class={`rc-rule rc-rule-${p.event.kind}${eventKey(p.event) === hotEvent.value ? " hot" : ""}`}
            key={barKey(p.event)}
            // A rule about a MODEL carries that model's colour, the same one its row, its band and its lane
            // blocks already use — so "gemma was evicted here" is legible from the line without reading the
            // tooltip. Generic red said only "something bad", which on a box running four models is the one
            // thing you already knew. Falls back to the danger colour when the event names no model.
            style={{ left: `${p.from * 100}%`, ...(p.event.model ? { "--model": colorFor(p.event.model) } : {}) }}
            data-model={p.event.model ?? undefined}
            onPointerEnter={(e: PointerEvent) => { eventHover.value = { p, scope }; hotEvent.value = eventKey(p.event); trackCursor(scope)(e); }}
            onPointerLeave={() => { eventHover.value = null; hotEvent.value = null; }} />
    ))}</>;
}

/**
 * A BREAK in the plot, and what it cut out: drawn at its TRUE width, hatched, because the axis is linear in time and
 * the hole is part of the history. (It used to be a 3px marker whatever its length, so a minute and ten hours looked
 * the same.) Pointing at one says how long it was and why the chart knows. Keyed by its start, so the same break
 * lights in every track, the way a ruled instant does.
 */
function GapMark({ gap, from, to, scope }: { gap: RunGap; from: number; to: number; scope: string }) {
    const hot = gapHover.value?.gap.from === gap.from;
    const left = Math.max(0, from), right = Math.min(1, to);
    if (!(right > left)) return null;
    return <div class={`rc-gap${gap.reported ? " reported" : ""}${hot ? " hot" : ""}`}
        style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
        onPointerEnter={(e: PointerEvent) => { gapHover.value = { gap, scope }; trackCursor(scope)(e); }}
        onPointerLeave={() => { gapHover.value = null; }} />;
}

/** The plot's runs, each in a box PLACED ON THE AXIS, with the breaks between them drawn at their true width — the one
 *  loop every view draws its runs in. A run's own drawing works in run-local fractions (`runFrac`), which is the
 *  axis restricted to that run, so the box is all the placement it needs. */
export function onAxis(runs: ResourceSample[][], samples: ResourceSample[], scope: string, seg: (run: ResourceSample[], i: number) => preact.JSX.Element) {
    const axis = live.axis;
    if (!axis) return null;
    return <>
        {axisGaps(runs, samples, axis).map((g) => <GapMark key={`g${g.gap.from}`} gap={g.gap} from={g.from} to={g.to} scope={scope} />)}
        {runs.map((run, i) => {
            const a = axisFrac(axis, run[0].t), b = axisFrac(axis, run[run.length - 1].t);
            return <div class="rc-seg" key={i} style={{ left: `${a * 100}%`, width: `${Math.max(0, b - a) * 100}%` }}>{seg(run, i)}</div>;
        })}
    </>;
}

/** The crosshair, mirrored into every track: a line where the pointer is, and the instant it names. Reading
 *  one pool against another at a given moment is the whole reason these are small multiples, and doing it by
 *  eye across three plots is exactly what a shared line removes. */
export function Crosshair({ runs }: { runs?: ResourceSample[][] } = {}) {
    const c = crosshair.value;
    if (!c) return null;
    if (eventHover.value || gapHover.value) return null;   // the rule or gap you are pointing at is the mark — see snapUnder
    // RECOMPUTED, never the stored fraction, whenever we are snapped to a known sample. The stored one is a
    // fact about the sample COUNT at the instant the pointer moved; one poll later the same sample sits at a
    // different fraction, and a line holding the old number drifts off the dots that were recomputed — by a
    // whole sample's width on a short history (measured at 0.601 against 0.500, one poll apart).
    const snap = runs ? snapUnder(runs) : null;
    const frac = snap ? snap.frac : c.frac;
    // Past the middle the label would run off the right edge, so it hangs on the other side of the line.
    const flip = frac > 0.72;
    return (
        <div class={`rc-cross${snap ? " snapped" : ""}`} style={{ left: `${frac * 100}%` }}>
            {/* The DOTS are drawn inside each plot, on the band boundaries they are points of — see
                StackedArea. Nothing here: a mark riding at the pointer's height is the cursor with a circle on
                it, not a datapoint. */}
            {/* Snapped, the label names the SAMPLE's own instant rather than the interpolated one under the
                pointer — the dot is on a measurement, so the clock beside it has to be that measurement's. */}
            {(() => {
                const t = snap && runs ? (runs[snap.run]?.[snap.index]?.t ?? c.t) : c.t;
                return t != null ? <span class={`rc-cross-t${flip ? " flip" : ""}`}>{clockAt(t, c.msPerPx ?? Infinity)}</span> : null;
            })()}
        </div>
    );
}

/** Track the pointer along the time axis. The fraction positions the line; the TIME comes from the axis, the same
 *  mapping the brush and every drawing use, so the label names the instant under the line. */
export const trackCrosshair = (_runs?: ResourceSample[][]) => (e: PointerEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const raw = Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
    // SNAPPED, when asked: the tooltip already reads a real SAMPLE rather than interpolating between two, so
    // a line drawn at the pointer instead disagrees with its own number by up to half a sample gap — seven
    // seconds of daylight at an idle cadence, and a gap that changes width as you move, which reads as drift.
    // THE RAW POINTER POSITION is what is stored. Snapping is derived at RENDER, never here, and the
    // difference is the whole behaviour: with the pointer parked and the timeline advancing, "the sample I am
    // pointing at" becomes a NEWER sample every poll. Resolving it once and holding the answer made the line
    // and its dots slide left with the data they were pinned to, away from a cursor that had not moved.
    const frac = raw;
    // How much time ONE PIXEL is worth here, which is what decides whether milliseconds mean anything in the
    // label: zoomed into ten seconds they do, over five minutes of history they are noise.
    const axis = live.axis;
    const msPerPx = axis && box.width > 0 ? (axis.to - axis.from) / box.width : Infinity;
    // The TIME comes from the unsnapped position when floating and from the snapped one when not, so the
    // label always names the instant the line is actually drawn at.
    crosshair.value = { frac, t: timeAtFraction(axis, frac), msPerPx };
};

/** The hovered EVENT's stretch, shaded on the plot above it. The lane and the chart share an axis and that
 *  is the whole point of the panel — "did that forty-second turn spend its time loading a model, or was the
 *  model already there" — but reading a block against the trace meant eyeballing two x positions a couple of
 *  rows apart. This says it: hover a block, and the memory that was measured WHILE it ran is picked out.
 *
 *  Drawn inside its own SEGMENT, exactly like the block is, because the axis is segmented by gaps and is not
 *  linear in time — a fraction of the whole plot would land somewhere else entirely. Carries the model's
 *  colour so the shade and the block are visibly the same thing, and disappears with the hover. */
export function HoverSpan({ scope }: { scope: string }) {
    const h = eventHover.value;
    if (!h || h.scope !== scope) return null;
    const from = Math.max(0, h.p.from), to = Math.min(1, h.p.to);
    // An INSTANT has no width; the dashed rule already marks it, and a zero-width shade would be a hairline
    // competing with it.
    if (!(to > from)) return null;
    const e = h.p.event;
    return <div class="rc-hoverspan" style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%`,
        ...(e.model ? { "--model": colorFor(e.model) } : {}) }} />;
}

/** How often a chart that follows the clock redraws its axis. Fast enough to read as scrolling, slow enough that a
 *  re-render of every track is not the panel's main cost. */
export const AXIS_TICK_MS = 250;

/**
 * WHERE THE PREDICTOR SAID A LOAD WOULD LAND, on the card it landed on: a dashed line at the card's used memory
 * before the load plus the placement figure, across the load. The gap between the line and where the band
 * settles IS the prediction's error, read without a tooltip — and the overshoot above it during the load is the
 * part a fit has to budget for. Drawn only for a load on exactly ONE card: the prediction is a whole-model
 * figure, and dividing it between cards would be pro-rating, which this panel never does.
 */
export function PredictLines({ run, loads, deviceId, ceiling }: { run: ResourceSample[]; loads: ResourceEvent[]; deviceId: string; ceiling: number }) {
    if (run.length < 2 || ceiling <= 0) return null;
    const first = run[0].t, last = run[run.length - 1].t;
    return (
        <>
            {loads.filter((e) => e.kind === "load" && e.estimate && e.t < last && (e.until ?? last) > first).map((e) => {
                const trace = loadTrace(resourceHistory.value, e);
                if (!trace || trace.cards.length !== 1 || trace.cards[0] !== deviceId) return null;
                const level = (trace.baseline[deviceId] ?? 0) + (e.estimate!.forLoad ?? e.estimate!.predicted);
                const from = runFrac(run, Math.max(first, e.t)), to = runFrac(run, Math.min(last, (e.until ?? last) + 5000));
                return <i key={`p:${e.model}:${e.t}`} class="rc-predict" aria-hidden="true"
                    style={{ left: `${from * 100}%`, width: `${Math.max(0.5, (to - from) * 100)}%`,
                             bottom: `${Math.min(100, (level / ceiling) * 100)}%`, "--model": e.model ? colorFor(e.model) : undefined }} />;
            })}
        </>
    );
}

/** Height of one model's row in the phase strip, gap included (px). */
const STRIP_ROW = 6;

/**
 * WHAT A CARD WAS DOING, in a reserved strip above its plot: one row per model that generated on it, each timed phase in
 * the lane's own fill for that kind (prefill dense, decode lighter, a cache swap striped), so the strip and the lane
 * read as one legend. Nothing is drawn for time nobody timed (an unpatched server, a tool running), which is why an
 * empty stretch claims nothing, idle included. Rows are per MODEL because two models on one card do generate at once.
 *
 * It is the lane's content seen per card, so it answers the way the lane does: hovering a stretch shows that event's
 * tooltip, lights it in the lane and dims every other event there and in every card's strip; hovering a lane bar lights
 * its stretches here. It used to sit on the plot's top edge, where a card near full memory drew over it.
 */
export function PhaseStrip({ runs, spans, events, scope }: { runs: ResourceSample[][]; spans: RibbonSpan[]; events: ResourceEvent[]; scope: string }) {
    const axis = live.axis;
    if (!axis) return null;
    const rows = [...new Set(spans.map((s) => s.model))].sort().slice(0, 3);
    // The same focus the lane dims by: the hovered event, its ancestors and its own descendants.
    const lit = litBy(events, eventHover.value?.p.event);
    const isLit = (e: ResourceEvent): boolean => !lit || lit(e);
    return (
        <div class="rc-strip" style={{ height: `${rows.length * STRIP_ROW - 1}px` }}>
            {runs.map((run, i) => {
                if (run.length < 2) return null;
                const first = run[0].t, last = run[run.length - 1].t;
                const a = axisFrac(axis, first), b = axisFrac(axis, last);
                return (
                    <div class="rc-seg" key={i} style={{ left: `${a * 100}%`, width: `${Math.max(0, b - a) * 100}%` }}>
                        {spans.filter((s) => s.until > first && s.t < last && rows.includes(s.model)).map((s) => {
                            const from = runFrac(run, Math.max(first, s.t)), to = runFrac(run, Math.min(last, s.until));
                            // The event's own placement on the axis, as the lane places it, so the tooltip is the lane's.
                            const p: EventPlacement = { event: s.event, run: 0, from: axisFrac(axis, s.event.t), to: axisFrac(axis, s.event.until ?? s.event.t), clipped: false };
                            return <i key={`${s.model}:${s.t}:${s.kind}`} class={`rc-ribbon-seg k-${s.kind}${isLit(s.event) ? "" : " away"}`}
                                data-model={s.model}
                                style={{ left: `${from * 100}%`, width: `max(1px, ${(to - from) * 100}%)`, top: `${rows.indexOf(s.model) * STRIP_ROW}px`,
                                         background: phaseFill(s.kind, s.model) }}
                                onPointerEnter={(ev: PointerEvent) => { eventHover.value = { p, scope }; hoverModel.value = s.model; trackCursor(scope)(ev); }}
                                onPointerMove={trackCursor(scope)}
                                onPointerLeave={() => { eventHover.value = null; hoverModel.value = null; hoverAt.value = null; }} />;
                        })}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * THE TIME GRID: faint vertical lines at round clock intervals through a plot, behind the gear's "time grid"
 * (off by default). The axis is linear in time within a run, and even spacing is what makes that visible; at a
 * gap the runs collapse and the spacing visibly restarts. Every plot draws the SAME step, derived from the same
 * runs, so the lines of stacked tracks line up. Vertical only: memory gridlines would mean a different amount on
 * every card, each having its own ceiling.
 */
export function TimeGrid() {
    const axis = live.axis;
    if (!timeGrid.value || !axis) return null;
    const step = gridStep(axis.to - axis.from);
    // The spacing, said once per plot: a grid whose interval you have to work out by counting lines against the
    // crosshair's clock is half a reading aid. A round interval, so round words. Across the WHOLE axis, gaps
    // included: the clock did not stop while nothing was measured.
    const label = step < 60_000 ? `${step / 1000} s` : step < 3_600_000 ? `${step / 60_000} min` : `${step / 3_600_000} h`;
    return <>
        {gridTimes([{ t: axis.from }, { t: axis.to }], step).map((t) => <i key={t} class="rc-grid" aria-hidden="true" style={{ left: `${axisFrac(axis, t) * 100}%` }} />)}
        <span class="rc-grid-step">grid {label}</span>
    </>;
}
