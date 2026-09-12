// The resource panel's chart: memory over time, stacked BY MODEL, against a real ceiling.
//
// All the arithmetic lives in ../resource-model (pure, unit-tested) — this file is only the drawing. Three
// things it must get right, each one a way the old sparkline misled:
//
//   • A DENOMINATOR. "18 GiB in use" answers nothing without "of 94.97". The ceiling comes from /api/info.
//   • ATTRIBUTION. A device splits into per-model bands, then the residual, then free — never a single total.
//     The residual is named by magnitude (driver overhead vs unattributed), because an idle card still holds
//     ~0.55 GiB of ollama's discovery context and calling that "other processes" invents a process.
//   • HONEST GAPS. Polling is gated on the panel being open, so history is discontinuous. A line drawn across
//     a ten-minute hole is a confident claim about memory nobody measured; `segments` breaks it instead.
import { useMemo, useRef, useState, useLayoutEffect, useEffect } from "preact/hooks";
import {
    deviceBands, hostBands, ceilingsFor, segments, formatBytes, formatShare, percentOf, isCpuResident,
    boxAxis, chartWindow, placeEvents, laneRows, eventsIn, lineageOf, timeAtFraction, sampleAtFraction, MIN_EV_SPAN, scrubExtent, scrubTo, scrubPinch, snapFraction, TAIL_SLACK_MS,
    scopeToSpan, scopeAround, scrubZone, scrubResize, scrubIntent, windowSamples, clampWindow, scrubNudge, wheelScrubFraction,
    filterEvents, countByKind, sessionWindow, type ResourceEvent, type EventPlacement, type PhaseKind,
    OTHER_BAND_NOTE, OUTSIDE_VIEW_LABEL, SPILL_FLOOR, residualRank, MEMORY_PARTS, memoryParts, type MemoryBreakdown, type LayerPlacement,
    presetsFor, kvFill, bridgeOrder, bridgeWalls, linkPhrase, linkBetween, isBridge, decodeCeiling, loadEdges, runWeight, runFrac, pendingAllocation, loadTrace, gridStep, gridTimes,
    type ResourceSample, type Band, type Capacity, type TrackDef, type DeviceCapacity,
} from "../resource-model";
import { resourceHistory, capacity, colorFor, poolColor, hoverModel, poolHover, poolFacts, hiddenPools, togglePool, ModelFacts, CostFacts, VRAM_POLL_MS, laneFilter, scopedHash, streamLive, sampleGapMs, sampleGraceMs, kbFocus, kbPool, focusDepth, releaseFocus, layout, editLayout } from "./vram";
import { models, ollamaIds, loadedModels, resWindowS, RESWIN_KEY, view, zoomRange, brush, crosshair, laneHidden, laneScoped, LANE_HIDDEN_KEY, LANE_SCOPE_KEY, laneEnabled, showLane, showModels, SECTIONS_KEY, laneLitSeqs, laneH, LANEH_KEY, LANE_H_DEFAULT, snapDot, predictView, timeGrid } from "./store";
import { Disclosure } from "./ui-kit";
import { clockAt, hhmmss, hhmmssms, fmtDur, fmtAge } from "./timestamps";
import { scrollToStepSeq, scrollToAnswer } from "./answer-render";
import { useTipPlacement } from "./use-tip";
import { signal } from "@preact/signals";

/** Which overlay POOL (a card, or the host) is hovered — the line and its key light together. */
const hoverPool = signal<string | null>(null);

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
const hoverAt = signal<{ x: number; y: number; w: number; surface: string; yFrac?: number } | null>(null);
/** Which part of the scrub window the pointer is over, so the cursor can say a handle is there before you
 *  try to use it. A resize affordance you can only discover by failing to pan is not an affordance. */
const scrubGrab = signal<"from" | "to" | "pan" | "outside" | null>(null);
/** WHICH SAMPLE the pointer is over, resolved from the LIVE data every time it is asked.
 *
 *  Deliberately a function of the current `runs` rather than a stored answer. The pointer is a position on
 *  screen; which sample sits under it changes as the timeline advances, so holding the resolution pins the
 *  mark to a sample that then walks out from under the cursor. Cheap enough to call per render — it is a
 *  weighted walk over the segment list. */
const snapUnder = (runs: ResourceSample[][]) => {
    const c = crosshair.value;
    if (!snapDot.value || !c) return null;
    // AN EVENT RULE OWNS THE POINTER while it is hovered. A dashed instant is a vertical mark of its own, a
    // pixel or two from the crosshair and never on the same x — it names an INSTANT, the crosshair names the
    // nearest SAMPLE — so drawn together they read as one thing that cannot decide where it is. The same rule
    // the reading tooltips already follow (`cursorOn`), applied to the mark.
    if (eventHover.value) return null;
    return snapFraction(runs, c.frac);
};
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

/** Mute the cursor tip if one is showing, and say whether that happened — so the Esc handler can fall through
 *  to leaving the zoom when there was nothing to hide. The decision lives HERE, beside the signals it reads,
 *  rather than exporting the hover state so another module can ask the same question less well. */
export function muteTip(): boolean {
    if (!hoverAt.value || tipMuted.value) return false;
    tipMuted.value = true;
    return true;
}

/** Read the cursor for a surface, or null when the pointer is somewhere else. */
const cursorAt = (surface: string) => (tipMuted.value || hoverAt.value?.surface !== surface ? null : hoverAt.value);
/** The cursor for a surface, for the tips that READ THE PLOT (the sample stamp, a band, the pool rows) —
 *  null while an EVENT on that same surface is hovered, because then the event's own tip is the answer.
 *
 *  A dashed instant rule is drawn INSIDE the plot, so pointing at one is also pointing at the plot: both tips
 *  fired, both are placed at the pointer, and they stacked — with the one you actually pointed at underneath
 *  the memory reading you did not ask for. The same "only the surface the pointer is on renders a tip" rule
 *  as everywhere else in this panel, applied to two things sharing ONE surface. `cursorAt` is the unguarded
 *  read, and only EventTip wants it. */
const cursorOn = (surface: string) =>
    (eventHover.value?.scope === surface ? null : cursorAt(surface));
/** Track a pointer against the viewport, tagged with the surface it is over. */
const trackCursor = (surface: string) => (e: PointerEvent) => {
    tipMuted.value = false;   // moving is the ask for it back — see tipMuted
    // MOVING HANDS THE FOCUS BACK. A keyboard selection holds against everything else — including a band
    // sliding under a still cursor as samples arrive, which raises `pointerenter` with nobody having touched
    // anything — and it is a real move that ends it. See releaseFocus.
    releaseFocus(e.target);
    releasePool(e.target);
    readingOverlay = surface === "overlay";
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

const W = 300, H = 72;

/** Every band key present anywhere in the window, in a STABLE order — models first (alphabetical, so a row
 *  doesn't jump when one evicts and reloads), then the residual, then free. Without a fixed order the stack
 *  would reshuffle between samples and the areas would cross. */
function bandOrder(frames: Band[][]): string[] {
    const models = new Set<string>(), rest = new Set<string>(), ctx = new Map<string, string>();
    for (const bands of frames) for (const b of bands) {
        if (b.kind === "model" || b.kind === "unknown") models.add(b.key);
        // A runner's overhead rides directly on its own model, so the pair reads as what that model costs.
        else if (b.key.startsWith("ctx:") && b.of) ctx.set(`m:${b.of}`, b.key);
        else if (b.kind === "other" && b.key !== "other") rest.add(b.key);
    }
    const byRank = [...rest].sort((a, b) => residualRank(a) - residualRank(b) || a.localeCompare(b));
    // An overhead whose model never appears in the window still has to be drawn — just not beside anything.
    const orphans = [...ctx].filter(([m]) => !models.has(m)).map(([, k]) => k);
    return [...[...models].sort().flatMap((k) => (ctx.has(k) ? [k, ctx.get(k)!] : [k])), ...orphans, ...byRank, "other", "free"];
}

/** Which model each residual band is TINTED with (`Band.of`) — a runner's overhead, a load in flight. Kept
 *  apart from `bandIdentity` on purpose: identity makes a band hoverable, hideable and stepped as the model. */
function bandTint(frames: Band[][]): Record<string, string | undefined> {
    const by: Record<string, string | undefined> = {};
    for (const bands of frames) for (const b of bands) if (b.of && !by[b.key]) by[b.key] = b.of;
    return by;
}

/** Which model each band key belongs to, from ANY frame in the window. Read only from the LAST frame, a model
 *  that evicted before the newest sample had no entry there — so its whole history lost its colour and turned
 *  into anonymous grey, and it stopped being hoverable, exactly where the chart's job is to say what WAS
 *  there. The history is the point; a band keeps its identity for as long as it is drawn. */
function bandIdentity(frames: Band[][]): Record<string, string | undefined> {
    const by: Record<string, string | undefined> = {};
    for (const bands of frames) for (const b of bands) if (b.model && !by[b.key]) by[b.key] = b.model;
    return by;
}

const bandFill = (key: string, model: string | undefined, tint?: string): string => {
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
const partFill = (model: string, key: keyof MemoryBreakdown): string => {
    const c = colorFor(model);
    const mix = PART_MIX[key];
    return mix >= 100 ? c : `color-mix(in srgb, ${c} ${mix}%, transparent)`;
};

/**
 * WHAT ONE GENERATION LEFT IN THE KV CACHE, drawn inside the drilled-in cache part while its lane span is
 * hovered. The part is the cache's RESERVATION — allocated in full at load, so its height never moves — and
 * this is the only view of how much of it a turn actually filled: bottom to top, the prefix reused from the
 * cache (dotted), the prompt computed this turn (dense), the tokens decoded (light), and above that the part
 * as it always looks, reserved and empty.
 *
 * Placed at the generation's own position on the axis and read from the sample at its end, where the counts
 * describe the cache. Positioned HTML over the segment rather than SVG inside it: the plot's SVG is stretched
 * to the track, and a dotted pattern drawn in it would smear into lines. A share of TOKENS, never bytes — see
 * `kvFill` — and a composition rather than a ramp over time, since the engine reports counts, not a timeline.
 */
function KvFill({ run, bandsOf, deep, ev }: { run: ResourceSample[]; bandsOf: (s: ResourceSample) => Band[]; deep: { model: string; ceiling: number }; ev: ResourceEvent }) {
    const n = run.length;
    if (n < 2 || !ev.gen || ev.until == null) return null;
    const t0 = run[0].t, t1 = run[n - 1].t;
    // A generation outside this run belongs to another segment (or to a gap, where nothing was measured).
    if (ev.until < t0 || ev.t > t1 + sampleGraceMs()) return null;
    // On the chart's axis — linear in time across the run — and read from the first sample at or after the
    // generation's end, where the counts describe the cache.
    const a = runFrac(run, ev.t), b = runFrac(run, ev.until);
    const at = run.find((sm) => sm.t >= ev.until!) ?? run[n - 1];
    const band = bandsOf(at).find((x) => x.model === deep.model);
    const parts = band?.parts;
    const r = at.models.find((x) => x.model === deep.model);
    const fill = kvFill(ev.gen, r?.contextLength, r?.activity?.slots ?? 1);
    if (!parts || !(parts.kvCache > 0) || !fill) return null;
    // The cache part sits directly above the weights in the stack (MEMORY_PARTS order).
    const floor = parts.weights, kv = parts.kvCache;
    const pct = (bytes: number) => (bytes / Math.max(1, deep.ceiling)) * 100;
    const layers = (fill.prompt != null
        ? [{ k: "prompt", share: fill.prompt }]
        : [{ k: "cached", share: fill.cached ?? 0 }, { k: "computed", share: fill.computed ?? 0 }])
        .concat([{ k: "decoded", share: fill.decoded }]);
    let acc = floor;
    // A generation is often a few ms against a window of minutes, so it is WIDENED to stay visible; double-
    // clicking its span frames the panel on it, which is the gesture for seeing it at its real width.
    const w = Math.max(1.2, (b - a) * 100);
    return (
        <div class={`rc-kvfill${fill.overflow ? " overflow" : ""}`} aria-hidden="true"
            style={{ left: `${Math.min(100 - w, a * 100)}%`, width: `${w}%`, "--model": colorFor(deep.model) }}>
            {layers.map((l) => {
                const h = l.share * kv;
                const el = <i key={l.k} class={`rc-kvfill-${l.k}`} style={{ bottom: `${pct(acc)}%`, height: `${pct(h)}%` }} />;
                acc += h;
                return el;
            })}
            {/* The reservation's top edge, so the empty remainder above the fill reads as part of the SAME cache
                rather than as whatever happens to be drawn over it. */}
            <i class="rc-kvfill-cap" style={{ bottom: `${pct(floor + kv)}%` }} />
        </div>
    );
}

/** One device (or the host pool) as a stacked area over time. `frames` is one band list per sample. */
function StackedArea({ frames, times, ceiling, hidden, scope, snapIndex = null, deep = null, loads = [] }: { frames: Band[][]; times: number[]; ceiling: number; hidden: Set<string>; scope: string; snapIndex?: number | null; deep?: { model: string; ceiling: number } | null; loads?: { t: number; until?: number }[] }) {
    const order = useMemo(() => bandOrder(frames), [frames]);
    const identity = useMemo(() => bandIdentity(frames), [frames]);
    const tint = useMemo(() => bandTint(frames), [frames]);
    if (frames.length < 2 || ceiling <= 0) return <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" />;
    // LINEAR IN TIME across the run (`runFrac`), the axis every other mapping on the chart uses.
    const tr = times.map((t) => ({ t }));
    const x = (i: number) => runFrac(tr, times[i]) * W;
    const y = (v: number) => H - Math.min(1, v / ceiling) * H;
    /** One edge as points, left to right, against a given vertical mapping. A stepped edge emits the corner
     *  first: hold the previous value up to this sample's x, then drop to this sample's. Reversing the list
     *  retraces the same shape, which is how a floor is drawn without a second implementation that could
     *  disagree with this one.
     *
     *  Defined HERE, above the drilled-in branch, because every polygon in this component needs it and that
     *  branch returns early: the band edges, the hover breakdown AND the drilled-in parts. It was first written
     *  for the bands alone, so a band stepped while the parts drawn INSIDE it still sloped — a flat band with
     *  diagonal lines across it, which reads as the breakdown disagreeing with the total it breaks down. The
     *  y-mapper is a parameter because the drilled-in view draws against its OWN shared ceiling. (After `x`/`y`,
     *  never before: a closure here running ahead of those consts is the TDZ crash this function has had once.) */
    const stepEdge = (series: number[], stepped: boolean, yOf: (v: number) => number): string[] => {
        const out: string[] = [];
        for (let i = 0; i < frames.length; i++) {
            if (stepped && i > 0) out.push(`${x(i).toFixed(1)},${yOf(series[i - 1] ?? 0).toFixed(1)}`);
            out.push(`${x(i).toFixed(1)},${yOf(series[i] ?? 0).toFixed(1)}`);
        }
        return out;
    };
    const zeros = new Array<number>(frames.length).fill(0);
    /**
     * DRILLED IN: ONE MODEL, FROM THE BASELINE, ON A SHARED SCALE.
     *
     * A model is usually a few percent of a card — 6.8% in the case that prompted this — so its decomposition
     * is drawn into three pixels and the parts are a rumour. Here the track stops being "how full is this
     * pool" and becomes "what is this model holding, over time, on this card": the band lifts to the baseline
     * and everything else drops away, which is also the reading a CHART is uniquely good at, since weights
     * sit still while the cache steps with the context.
     *
     * THE SCALE IS SHARED ACROSS THE CARDS, and that is the part that must not be got wrong. Scaling each
     * track to its own contents would draw a card holding 1,991 MiB and one holding 878 MiB at the SAME
     * height — the pro-rating mistake in a different costume, in the one mode built to show that the cards
     * hold different amounts. `deep.ceiling` is the largest of them over the window, computed identically by
     * every track from the samples they all share, so no cross-track plumbing can get it out of step.
     */
    if (deep) {
        const dy = (v: number) => H - (v / Math.max(1, deep.ceiling)) * H;
        const seen = new Set<keyof MemoryBreakdown>();
        for (const bands of frames) {
            const p = bands.find((b) => b.model === deep.model)?.parts;
            if (p) for (const q of memoryParts(p)) seen.add(q.key);
        }
        const keys = MEMORY_PARTS.filter((k) => seen.has(k.key));
        // MEMORY ARRIVING FOR THIS MODEL BEFORE IT IS ATTRIBUTED — the allocation curve of a load in flight
        // (`pendingAllocation`), which otherwise vanished from exactly the view a reader drilled into to see it.
        const pending = pendingAllocation(frames, times, deep.model, loads).map((v) => Math.min(v, deep.ceiling));
        const anyPending = pending.some((v) => v > 0);
        if (!keys.length && !anyPending) return <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" />;
        const tops = keys.map(() => new Array<number>(frames.length).fill(0));
        /**
         * A FRAME THE SERVER COULD NOT SPLIT IS NOT AN EMPTY ONE.
         *
         * `memory` is omitted whenever the server cannot divide the figure — a loading row, an MLX runner, a
         * build predating the field — and stacking nothing for those frames drops the area to ZERO, which
         * says the model was not resident. It was: we know its total, we do not know its composition, and
         * those are different absences. Drawn as an undifferentiated area at its real height instead, so the
         * trace stays continuous and only the SUBDIVISION goes missing where it is missing.
         *
         * Told apart from a frame where the model is genuinely absent by whether a BAND exists at all — no
         * band means it is not on this card at that instant, which really is zero.
         */
        const unsplit = new Array<number>(frames.length).fill(0);
        frames.forEach((bands, i) => {
            const b = bands.find((x2) => x2.model === deep.model);
            const p = b?.parts;
            let acc = 0;
            keys.forEach((part, pi) => { if (p) acc += p[part.key]; tops[pi][i] = acc; });
            unsplit[i] = !p && b ? b.bytes : 0;
        });
        const anyUnsplit = unsplit.some((v) => v > 0);
        return (
            <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                {/* LINES, not steps: memory really does arrive progressively while a load lands (the server calls
                    it a continuous progress signal), the same reason the device's own bands are lines. Faint and
                    dashed along its top, in the model's colour, because it is the model's load but not yet
                    anything the server has said the model holds. */}
                {anyPending ? (
                    <polygon key="d:pending" class="rc-part rc-part-pending" vector-effect="non-scaling-stroke"
                        points={[...stepEdge(pending, false, dy), ...stepEdge(zeros, false, dy).reverse()].join(" ")}
                        fill={partFill(deep.model, "other")} style={{ "--model": colorFor(deep.model) }} />
                ) : null}
                {anyUnsplit ? (() => {
                    // ONE shape for the whole stretch, at the model's own height, in its own colour but
                    // deliberately flat and faint with a dashed top: it must not read as a part, because
                    // which part it is is precisely what is not known.
                    const pts: string[] = [];
                    pts.push(...stepEdge(unsplit, true, dy), ...stepEdge(zeros, true, dy).reverse());
                    return <polygon key="d:unsplit" points={pts.join(" ")} class="rc-part rc-part-unsplit"
                        fill={partFill(deep.model, "other")} vector-effect="non-scaling-stroke" />;
                })() : null}
                {keys.map((part, pi) => {
                    const pts: string[] = [];
                    // ONE model's memory, all of it piecewise-constant, so every part edge steps — a part's floor included,
                    // since it is the part beneath it (or the baseline) and must match that edge exactly.
                    pts.push(...stepEdge(tops[pi], true, dy), ...stepEdge(pi === 0 ? zeros : tops[pi - 1], true, dy).reverse());
                    return <polygon key={`d:${part.key}`} points={pts.join(" ")} class={`rc-part rc-part-${part.key}`}
                        fill={partFill(deep.model, part.key)} vector-effect="non-scaling-stroke" />;
                })}
            </svg>
        );
    }

    // Cumulative tops per key, so each band is drawn between its own top and the one below it.
    const tops: Record<string, number[]> = {};
    frames.forEach((bands, i) => {
        let acc = 0;
        for (const key of order) {
            if (key === "free") continue;
            const b = bands.find((x2) => x2.key === key);
            // A hidden model drops out of the STACK entirely (and so out of every earlier frame too), which is
            // why the whole series is recomputed on toggle rather than only new points.
            if (b && !hidden.has(b.model ?? "")) acc += b.bytes;
            (tops[key] ||= [])[i] = acc;
        }
    });

    /**
     * A MODEL'S MEMORY IS PIECEWISE-CONSTANT, SO ITS EDGE IS A STEP.
     *
     * A resident model does not drift: the runner appears holding its whole footprint, and the KV cache is
     * preallocated for the FULL context window at load and never grows — verified on the box, byte-identical
     * before and after 4,217 tokens went through it. So a straight line between two samples was drawing a
     * decay that cannot happen, and on an eviction it drew the worst version of it: samples 14 seconds apart
     * (the stream's idle cadence) with the model resident at one end and gone at the other, rendered as
     * fourteen seconds of memory gently draining away. The `unload` edge sits at the true instant, so the
     * dashed rule and the descent disagreed by up to a whole sample interval, which reads as the lane being
     * misaligned with the chart rather than as the chart interpolating.
     *
     * Held at its last measured value and dropped where the next reading says, the descent lands on the
     * sample that reported it — 2 ms after the edge in the capture that prompted this — so the two agree
     * without either being moved to suit the other.
     *
     * THE DEVICE'S OWN BANDS STAY LINES, and that difference is the point rather than an inconsistency. A
     * card's free memory really does fall progressively while weights land — the server describes it as a
     * continuous progress signal during the long half of a load — so stepping it would be the same error
     * pointed the other way. A band is drawn stepped when its top is a MODEL's, which is what `identity`
     * already answers for the fill.
     *
     * Adjacent bands SHARE an edge (this band's floor is the one below's ceiling), so the floor is drawn with
     * the step-ness of the band BELOW, never its own. Get that wrong and the two disagree by a step's height
     * and the stack opens a seam. It also means a residual sitting on models is exactly right: its base jumps
     * when a model goes, while its own thickness still varies smoothly.
     */
    const isStep = (k: string | null): boolean => !!k && !!identity[k];
    const areas = order.filter((k) => k !== "free").map((key, ki, keys) => {
        const below = ki === 0 ? null : keys[ki - 1];
        const top = tops[key] || [];
        const floor = below ? (tops[below] || []) : zeros;
        const pts: string[] = [...stepEdge(top, isStep(key), y), ...stepEdge(floor, isStep(below), y).reverse()];
        // The band knows which model it is, so hovering it can name it — and dim its neighbours, so a stack of
        // similar colours resolves into one identifiable shape.
        const model = identity[key];
        const dim = hoverModel.value && model && hoverModel.value !== model;
        const hot = !!model && hoverModel.value === model;
        return <polygon key={key} points={pts.join(" ")} fill={bandFill(key, model, tint[key])}
            class={model ? `rc-band${hot ? " hot" : ""}` : undefined} vector-effect="non-scaling-stroke"
            onPointerEnter={model ? (e: PointerEvent) => {
                // THE KEYBOARD OWNS THE FOCUS while it has one. This fires without the reader touching
                // anything whenever a band moves under a parked pointer, so honouring it here would let an
                // arriving sample overwrite a selection the keys had just made. `trackCursor` still runs —
                // the tip has to follow the cursor either way — and it is what releases the focus, on a real
                // move rather than on a boundary event.
                if (!kbFocus.value) hoverModel.value = model;
                trackCursor(scope)(e);
            } : undefined}
            onPointerLeave={model ? () => { if (!kbFocus.value) { hoverModel.value = null; hoverAt.value = null; } } : undefined}
            opacity={dim ? 0.18 : key === "other" ? 0.35 : model ? 0.75 : 0.55} />;
    });

    /**
     * THE HOVERED MODEL'S BAND, SUBDIVIDED IN PLACE.
     *
     * `size_vram` alone cannot tell a big MODEL from a big CONTEXT — lots of weights with a small cache, and
     * modest weights with an enormous one, are the same number and want opposite responses. The server splits
     * it now, so hovering decomposes the area you are already looking at rather than opening a second picture
     * of the same memory somewhere else. Which also shows the part a chart is uniquely good at: weights sit
     * still while the cache steps with the context, and that is visible over TIME and nowhere in a total.
     *
     * Drawn OVER the solid band rather than instead of it, so a frame the server could not split (a loading
     * row, an MLX runner, a sample from before the field existed) simply shows the band it always had — the
     * parts collapse to zero height there instead of the whole decomposition vanishing or, worse, stretching
     * a neighbouring frame's shares across a gap it never measured.
     */
    const split = (() => {
        const model = hoverModel.value;
        if (!model) return null;
        const key = order.find((k) => identity[k] === model && k !== "free");
        if (!key || hidden.has(model)) return null;
        const ki = order.filter((k) => k !== "free").indexOf(key);
        if (ki < 0) return null;
        const belowKey = ki === 0 ? null : order.filter((k) => k !== "free")[ki - 1];
        // The parts present in ANY frame, in stack order, so a slice does not appear and disappear as the
        // window scrolls over the moment a projector was allocated.
        const seen = new Set<keyof MemoryBreakdown>();
        for (const bands of frames) {
            const p = bands.find((b) => b.key === key)?.parts;
            if (p) for (const q of memoryParts(p)) seen.add(q.key);
        }
        if (!seen.size) return null;
        const keys = MEMORY_PARTS.filter((p) => seen.has(p.key));
        const base = frames.map((_f, i) => (belowKey ? (tops[belowKey]?.[i] ?? 0) : 0));
        // Cumulative sub-tops, one row per part.
        const subTops = keys.map(() => new Array<number>(frames.length).fill(0));
        frames.forEach((bands, i) => {
            const p = bands.find((b) => b.key === key)?.parts;
            let acc = base[i];
            keys.forEach((part, pi) => {
                if (p) acc += p[part.key];
                subTops[pi][i] = acc;   // no parts → every sub-top is the base, so nothing is drawn here
            });
        });
        return keys.map((part, pi) => {
            const pts: string[] = [];
            // Every part is this model's, so every top steps. The FIRST part's floor is the band beneath the model and
            // takes THAT band's step-ness: it is the same edge the model's own band sits on, and two renderings of one
            // edge that disagree open a seam between the parts and the band.
            pts.push(...stepEdge(subTops[pi], true, y), ...stepEdge(pi === 0 ? base : subTops[pi - 1], pi === 0 ? isStep(belowKey) : true, y).reverse());
            return <polygon key={`p:${part.key}`} points={pts.join(" ")} class={`rc-part rc-part-${part.key}`}
                fill={partFill(model, part.key)} vector-effect="non-scaling-stroke" />;
        });
    })();
    /**
     * THE DATAPOINT, ON THE LINES IT IS A POINT OF.
     *
     * The dot used to ride at the POINTER's height on the argument that a stacked area has many values at one
     * x and so no single y to choose. That was wrong twice over: the lines ARE there — they are the band
     * boundaries the chart already draws — and a mark that tracks the cursor vertically is not a datapoint at
     * all, it is the cursor with a circle on it. Marking every boundary is what "where does this sample sit"
     * actually means in a stack, and it is exactly what `tops` already holds.
     *
     * The FREE band is excluded: its boundary is the ceiling, which is a constant and not a reading.
     */
    const dots = (() => {
        if (snapIndex == null || snapIndex < 0 || snapIndex >= frames.length) return null;
        // HOVERING ONE BAND narrows this to that band alone. Every boundary marked is an OVERVIEW — right
        // when the pointer is on the plot's background and nothing is picked out — but once a band is
        // hovered the panel has already dimmed its neighbours to say "this one", and a full set of dots
        // contradicts that by marking the things it just faded.
        const focus = hoverModel.value;
        const keys = order.filter((k) => k !== "free")
            .filter((k) => !focus || identity[k] === focus);
        const seen = new Set<number>();
        return keys.map((key) => {
            const v = tops[key]?.[snapIndex];
            if (v == null) return null;
            const cy = y(v);
            // Two boundaries at the same height are one line on screen, and two dots on it read as a
            // rendering fault rather than as two bands that happen to meet.
            const at = Math.round(cy * 10);
            if (seen.has(at)) return null;
            seen.add(at);
            // THE MARK CARRIES THE MODEL'S COLOUR, the way the overlaid view's marks carry their pool's. A
            // model's colour is its identity across the whole panel — the band, the row, its blocks in the
            // lane — so a mark sitting ON that band in the panel's accent said "a reading" where every other
            // surface says "this model", and with several boundaries marked at once there was nothing to tell
            // them apart. Read from `identity`, which is what `bandFill` colours the band from, so the mark
            // and the thing it is marking cannot disagree.
            //
            // A boundary with NO model keeps the accent rather than taking `bandFill`'s grey: driver overhead
            // and the unattributed residual are drawn in `--fg-faint`, and a faint grey mark on a faint grey
            // band is a mark you cannot find. Blue there is not a fallback, it is "a reading, of nothing named".
            const model = identity[key];
            // HTML, not an SVG <circle>: the viewBox is stretched with `preserveAspectRatio="none"`, so a
            // circle inside it draws as an ELLIPSE whose eccentricity depends on the plot's current size.
            // Percentages of the same box put it in exactly the same place and keep it round.
            return <i key={`d:${key}`} class="rc-snapdot" aria-hidden="true"
                style={{ left: `${(x(snapIndex) / W) * 100}%`, top: `${(cy / H) * 100}%`,
                         ...(model ? { background: colorFor(model) } : {}) }} />;
        });
    })();
    return (
        <>
            <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                {areas}
                {split}
            </svg>
            {dots}
        </>
    );
}

/** The device name, with the card's own facts behind a hover.
 *
 *  WHAT IT IS FOR: the panel draws a pool's occupancy and says almost nothing about the hardware under it,
 *  so "which card is this, and why do two totals for it disagree" has no answer on screen. The two totals
 *  are the part worth the space — `total_memory` is what ollama PLACES against and `physical_memory` is what
 *  nvidia-smi shows, ~638 MiB apart on the reference cards, and a reader who spots the difference elsewhere
 *  has no way to learn it is expected rather than a bug in one of them.
 *
 *  WHAT IT DELIBERATELY DOES NOT SAY:
 *
 *  - **The interconnect, beyond admitting it is unknown.** Interconnect is a property of a PAIR, not of a
 *    card — consumer NVLink is 2-way, so a four-card box has some NVLinked pairs and some that fall back to
 *    PCIe, and a per-device "interconnect: PCIe" would be unrepresentable-wrong there. The server does not
 *    report the matrix at all yet, and an absent matrix must never render as "no NVLink": on a 4x3090, which
 *    is a very common rig, that is a confident lie. So the line says NOT REPORTED, which is true now and
 *    becomes a real answer when the field ships. Shown only where there is more than one device, since a
 *    single card has no pair to have a link with.
 *  - **Link speed and width.** Available only for FAULTED cards today, and both are LIVE readings rather
 *    than capabilities: an idle Blackwell drops to 2.5 GT/s under ASPM and would read as 12x degraded while
 *    perfectly healthy, and `width < max_width` is by design wherever a board splits its lanes x8/x8.
 *  - **Any derived ceiling or grade.** `compute` and `driver` are printed verbatim as reference facts and
 *    nothing branches on them — a panel that did would be encoding hardware knowledge that rots. */
/** This card's links to EACH OTHER card, from the server's topology — one line per peer, direct fabric first,
 *  never a single "interconnect" value for the card. What it says when it cannot say that is the point:
 *  unreported, unmeasured (with the driver's words) and a pair the server's list OMITTED are three different
 *  answers, and none of them is "PCIe only" — on a bridged 4x3090 that would be a confident lie. */
function DeviceLinks({ device }: { device: DeviceCapacity }) {
    const cap = capacity.value;
    const t = cap?.topology;
    const peers = (cap?.devices ?? []).filter((d) => d.id !== device.id);
    if (!t) return (
        <span class="rc-df-row rc-df-dim">Link to the other {peers.length === 1 ? "card" : "cards"}: not reported by this server. It is a property of each PAIR rather than of a card — some pairs can be NVLinked while others fall back to PCIe — so nothing is assumed either way.</span>
    );
    if (t.status === "unavailable" || !device.pciId) return (
        <span class="rc-df-row rc-df-dim">Links to the other {peers.length === 1 ? "card" : "cards"}: could not be measured{t.detail ? <> (<code>{t.detail}</code>)</> : null}. That is not the same as "no NVLink" — nothing is assumed either way.</span>
    );
    const rows = peers.map((p) => ({ p, l: linkBetween(t, device.pciId, p.pciId) }))
        .sort((x, y) => Number(isBridge(y.l)) - Number(isBridge(x.l)));
    return (
        <>
            {rows.map(({ p, l }) => (
                <span class="rc-df-row" key={p.id}>to <b>{p.name}</b>: {l
                    ? linkPhrase(l)
                    : <span class="rc-df-dim">missing from the server's link list — a bug on one side, not a PCIe link</span>}</span>
            ))}
            {t.status !== "measured"
                ? <span class="rc-df-row rc-df-dim">Only partly measured{t.detail ? <> (<code>{t.detail}</code>)</> : null}.</span> : null}
        </>
    );
}

function DeviceFacts({ device, label }: { device: DeviceCapacity; label: string }) {
    // How many OTHER devices there are — a single card has no pair to have a link with, so the
    // interconnect line is shown only where the question exists.
    const others = (capacity.value?.devices.length ?? 1) - 1;
    return (
        // THE NAME STAYS THE NAME. A `.tt-pop` only works inside an element carrying `tt`, so the trigger is a
        // WRAPPER around `.rc-name` rather than `.rc-name` itself — put the tooltip inside the name element
        // and the name's own text content becomes the name plus three sentences of prose, which every reader
        // of that element then picks up. The panel reads `.rc-name` as a label in several places.
        <span class="tt rc-devfacts">
            <span class="rc-name">{label}</span>
            <span class="tt-pop wrap" role="tooltip">
                <span class="rc-df-row"><b>{device.name}</b> · {device.runner}{device.unified ? " · unified memory" : ""}</span>
                {/* THE TWO TOTALS, and which decides what. This is the counter-intuitive one and the reason
                    the hover exists at all. */}
                <span class="rc-df-row">{formatBytes(device.totalBytes)} usable — what placement decides against</span>
                {device.physicalBytes && device.physicalBytes !== device.totalBytes ? (
                    <span class="rc-df-row rc-df-dim">{formatBytes(device.physicalBytes)} on the card — what the driver and nvidia-smi report. The difference is reserved before anything loads; neither figure is wrong.</span>
                ) : null}
                {device.compute || device.driver ? (
                    <span class="rc-df-row rc-df-dim">
                        {device.compute ? <>compute {device.compute}</> : null}
                        {device.compute && device.driver ? " · " : null}
                        {device.driver ? <>driver {device.driver}</> : null}
                    </span>
                ) : null}
                {/* THE CARD'S CEILINGS, fixed properties read once — never live readings. Bandwidth is what
                    decode is bound by; the host link rules ITSELF out, since it governs load time and almost
                    nothing about inference (cross-card traffic measured at 0.2% of a step), and the width is the
                    narrower of card and slot, which is what the link can actually train at. */}
                {device.memoryBandwidth ? (
                    <span class="rc-df-row">memory bandwidth {(device.memoryBandwidth / 1e12).toFixed(2)} TB/s — the ceiling decode is bound by</span>
                ) : null}
                {device.pcieMaxGeneration || device.pcieMaxWidth ? (
                    <span class="rc-df-row rc-df-dim">host link: PCIe{device.pcieMaxGeneration ? ` Gen ${device.pcieMaxGeneration}` : ""}{device.pcieMaxWidth ? ` x${device.pcieMaxWidth}` : ""} at most — this governs how fast a model LOADS, and almost nothing about how fast it runs</span>
                ) : null}
                {others > 0 ? <DeviceLinks device={device} /> : null}
            </span>
        </span>
    );
}

export interface DeviceViewProps {
    label: string;
    /** The samples to draw — already the window the panel wants. */
    samples: ResourceSample[];
    /** Bands for one sample: the device's, or the host pool's. */
    bandsOf: (s: ResourceSample) => Band[];
    ceiling: number;
    /** A soft ceiling inside the hard one (unified memory's recommended working set), or null. */
    soft?: { bytes: number; label: string } | null;
    /** What the denominator IS, in this track's own terms. Passed in rather than derived here, because the
     *  honest sentence differs per pool: a discrete card's driver total names that vendor's tool, a unified
     *  device's is the system total, and the host pool has no driver in the story at all. */
    ceilingNote: string;
    /** The DEVICE this track draws, when it is one. Absent for the host pool, which has no card behind it —
     *  so the hover carries hardware facts only where there is hardware to describe. */
    device?: DeviceCapacity;
    hidden: Set<string>;
    /** Instants to rule through this plot (evictions). Spans live in the lane below, not here. */
    events?: ResourceEvent[];
    /** Drop this track from the layout. Absent when there is only one left — an empty chart is not a layout,
     *  and a control that refuses on click is worse than one that is not offered. */
    onHide?: () => void;
}

/**
 * DROP THIS TRACK, from the track itself.
 *
 * Which pools you want on screen is a decision you make WHILE reading — a card you are not interested in is
 * costing height the ones you are could use — and it lived only behind the gear, which means leaving the
 * chart to change what the chart shows. This is the same operation the editor's remove is (`editLayout`,
 * which flips the picker to Custom and remembers the layout), put where the decision is made.
 *
 * ✕ MATCHES THE EDITOR'S OWN VOCABULARY for this action, not the model rows' — where the same glyph means
 * EVICT FROM VRAM, which unloads the model from the card. Same shape, wildly different consequence, so the
 * tip says plainly that this only changes what is drawn, and how to get it back.
 *
 * It holds its space when idle rather than appearing on hover: the header gains and loses controls as you use
 * the panel, and a row that reflows when one arrives shifts every surface below it — which is how a drag on
 * the scrub strip once started landing 12px off.
 */
function HideTrack({ onHide, label }: { onHide?: () => void; label: string }) {
    return (
        // `tt` IS WHAT MAKES THE TOOLTIP EXIST. The floating layer finds a trigger by that class and reads its
        // `.tt-pop`; without it the markup is inert — display:none and nothing to clone it — so the button
        // carried an explanation nobody could ever see. And `left`, because this sits at the panel's far edge
        // and the default right-anchored pop opens off the side of it.
        <button class={`tt rc-hide${onHide ? "" : " none"}`} aria-label={`Hide the ${label} track`}
            disabled={!onHide} onClick={onHide}>
            ✕
            {onHide ? <span class="tt-pop wrap left" role="tooltip">Stop drawing <b>{label}</b> here. It only
                changes the chart — nothing is unloaded and no memory is freed — and the view becomes
                <b> Custom</b>; add the track back under the gear.</span> : null}
        </button>
    );
}

/** One track: a header carrying the denominator, then the stacked history, gaps left as gaps. */
export function DeviceView({ label, samples, bandsOf, ceiling, soft, ceilingNote, hidden, events = [], onHide, device }: DeviceViewProps) {
    const scope = `track:${label}`;   // one track per pool, so the label identifies the surface
    const latest = samples.at(-1);
    const bands = latest ? bandsOf(latest) : [];
    const used = bands.filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    // Each contiguous run is drawn separately — a gap is a gap, never interpolated across.
    // A run of ONE sample has no shape to draw — StackedArea needs two points — and giving it a 2px column
    // leaves a pale sliver where the band wash is missing, which reads as a rendering artifact rather than as
    // data. Undrawable runs are skipped; nothing is lost, because a lone point conveys no trend either.
    const runs = noteRuns(useMemo(() => segments(samples, sampleGapMs()).filter((r) => r.length > 1), [samples, streamLive.value]));
    // Only the instants: a span is a duration and belongs in the lane, where its length can be read.
    const instants = useInstants(runs, events);
    // The DATAPOINT under the pointer, resolved through the same segmented geometry the crosshair uses, so
    // the tooltip's figures and the instant the crosshair names are the same sample and cannot drift apart.
    const hoverSample = hoveredSample(runs, scope);
    /**
     * DRILLED IN, on this track. Two facts have to line up: the model has to BE on this card (a split holds
     * different amounts on each, and a card it is not on has nothing to decompose), and the scale has to be
     * the same on every card it IS on.
     *
     * Both come out of `samples`, which every track already has in full — so the shared ceiling is computed
     * independently and identically by each of them rather than passed down from a parent that would have to
     * know about all the tracks. There is no cross-track state to get out of step, which is the failure the
     * one-scale rule exists to prevent in the first place.
     */
    // READ UNCONDITIONALLY, AT THE TOP, AND KEEP THE VALUE. A signal read buried in a helper or behind a
    // condition does not reliably subscribe the component to it once the bundle is minified — the panel's
    // oldest rendering gotcha. It showed here as ONE track entering the drilled-in mode while its siblings
    // kept drawing the summary: they had subscribed to `hoverModel` (which the previous keypress also wrote)
    // and not to this, so the depth change reached exactly one of them.
    const kbNow = kbFocus.value;
    // A GENERATION HOVERED IN THE LANE drills its model in too, so its cache fill has somewhere to be drawn —
    // the same mode the keys enter, so it keeps the one scale across every card the model is on. The keyboard
    // wins when both are set: it is the deliberate selection. Read here, unconditionally, for the same
    // subscription reason as `kbFocus`.
    const evNow = eventHover.value;
    const laneGen = evNow?.scope === "lane" && evNow.p.event.gen && evNow.p.event.model ? evNow.p.event : null;
    const deepModel = kbNow && kbNow.depth > 0 ? kbNow.model : laneGen?.model ?? null;
    const deep = (() => {
        if (!deepModel || hidden.has(deepModel)) return null;
        let mine = 0, most = 0;
        for (const s of samples) {
            const r = s.models.find((x) => x.model === deepModel);
            if (!r) continue;
            for (const v of Object.values(r.perDevice)) most = Math.max(most, v ?? 0);
        }
        for (const b of bands) if (b.model === deepModel) mine = Math.max(mine, b.bytes);
        for (const s of samples) {
            const bs = bandsOf(s).find((b) => b.model === deepModel);
            if (bs) mine = Math.max(mine, bs.bytes);
        }
        return mine > 0 && most > 0 ? { model: deepModel, ceiling: most } : null;
    })();
    return (
        <div class={`rc-track${deepModel ? " deep" : ""}${deepModel && !deep ? " away" : ""}`}>
            <div class="rc-head">
                <HideTrack onHide={onHide} label={label} />
                {device ? <DeviceFacts device={device} label={label} /> : <span class="rc-name">{label}</span>}
                <span class="sp" />
                {/* A RESCALED AXIS HAS TO SAY SO. Drilled in, this track stops being "how full is this pool"
                    and becomes "what is this model holding here" — the band is lifted to the baseline and
                    everything else dropped, so the same shape now means something completely different.
                    Reporting the pool's occupancy over it would be a confidently wrong picture, and a chart
                    that quietly changes what its height means is the worst kind. */}
                {deep ? (
                    <span class="rc-total tt rc-scaled">
                        full height {formatBytes(deep.ceiling)}
                        <span class="tt-pop wrap" role="tooltip">Scaled to {deep.model}, not to this pool — and to the SAME height on every card it is on, so a card holding less of it draws shorter. Scaling each card to its own contents would draw them the same size, which is the one thing this view exists to disprove.</span>
                    </span>
                ) : deepModel ? (
                    // A card the model is not on has nothing to decompose, and saying so beats leaving its
                    // ordinary stack up as though it were part of the answer.
                    <span class="rc-total rc-scaled">not on this card</span>
                ) : (
                    <span class="rc-total tt">
                        {formatShare(used, ceiling, "/")}
                        {/* RIGHT-anchored (the default): this figure sits at the panel's right edge, so a
                            left-anchored pop extends rightward and is clipped. `wrap` because it is prose. */}
                        <span class="tt-pop wrap" role="tooltip">{ceilingNote}</span>
                    </span>
                )}
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor(scope)(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => {
                    // THE KEYBOARD OWNS THE READING, and the pointer leaving the plot is not a decision to
                    // stop reading. Clearing the focus here threw away the whole reading whenever the surface
                    // moved out from under a still cursor — which THIS MODE CAUSES: drilling in collapses the
                    // cards the model is not on, so the track the pointer was over shrinks, fires a leave,
                    // and the chart stayed drilled in (that comes from `kbFocus`) while its tooltip lost its
                    // subject. The crosshair stays too: it is the instant being read, the keys are gated on
                    // it, and a reading anchored to a moment does not stop being anchored because the mouse
                    // wandered. Only a real move (`releaseFocus`) or Escape ends it.
                    hoverAt.value = null;                     // the cursor-following tips do go
                    if (kbFocus.value) return;
                    hoverModel.value = null; eventHover.value = null; crosshair.value = null;
                }}>
                {runs.map((run, i) => (
                    <div class="rc-seg" key={i} style={{ flex: `${runWeight(run)} 1 0` }}>
                        <TimeGrid runs={runs} run={run} />
                        <StackedArea frames={run.map(bandsOf)} times={run.map((sm) => sm.t)} ceiling={ceiling} hidden={hidden} scope={scope}
                            deep={deep} loads={deep ? events.filter((e) => e.kind === "load" && e.model === deep.model && e.until != null) : []}
                            snapIndex={snapUnder(runs)?.run === i ? snapUnder(runs)!.index : null} />
                        {deep && laneGen && laneGen.model === deep.model
                            ? <KvFill run={run} bandsOf={bandsOf} deep={deep} ev={laneGen} /> : null}
                        <InstantRules instants={instants} run={i} scope={scope} />
                        {predictView.value && !deep && device
                            ? <PredictLines run={run} loads={events} deviceId={device.id} ceiling={ceiling} /> : null}
                        <HoverSpan run={i} scope="lane" />
                    </div>
                ))}
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                {soft ? <div class="rc-soft" style={{ bottom: `${Math.min(100, (soft.bytes / ceiling) * 100)}%` }}
                    title={soft.label} /> : null}
                <BandTip bands={bands} frame={hoverSample ? bandsOf(hoverSample) : null}
                    history={samples.map(bandsOf)} samples={samples} ceiling={ceiling} scope={scope} label={label}
                    hidden={hidden} at={hoverSample} />
                {/* Hovering the plot ANYWHERE, not just a model's band, answers the question this track's
                    header answers for the present: how full was this pool, then. Without it the free area
                    and the space above the stack were the only parts of the chart that said nothing. */}
                {hoverSample && !hoverModel.value
                    ? <PlotTip at={hoverSample} bands={bandsOf(hoverSample)} ceiling={ceiling} label={label} hidden={hidden} scope={scope} />
                    : null}
                <EventTip scope={scope} />
            </div>
            <div class="rc-legend">
                {bands.filter((b) => b.kind === "other" && b.bytes > 0).map((b) => (
                    <span class="rc-key tt" key={b.key}>
                        <i class="rc-swatch rc-swatch-other" style={b.of ? { background: bandFill(b.key, undefined, b.of) } : undefined} /> {b.label} {formatBytes(b.bytes)}
                        {/* The label is kept compact, so the SHARE of the pool — the thing that says whether a
                            figure matters — lives in the hover text. */}
                        <span class="tt-pop left above" role="tooltip">{formatShare(b.bytes, ceiling)} — {b.note ?? OTHER_BAND_NOTE}</span>
                    </span>
                ))}
                {bands.filter((b) => b.kind === "free").map((b) => (
                    <span class="rc-key tt" key={b.key}><i class="rc-swatch rc-swatch-free" /> free {formatBytes(b.bytes)}
                        <span class="tt-pop left above" role="tooltip">{formatShare(b.bytes, ceiling)} of this pool is unused.</span>
                    </span>
                ))}
            </div>
        </div>
    );
}

/** The sample under the pointer, or null when the pointer is not over this plot. The fraction comes from the
 *  crosshair — one pointermove sets both — so a tooltip can never name a different datapoint than the line
 *  the crosshair is drawn at, which is the drift you get from measuring the pointer twice. */
function hoveredSample(runs: ResourceSample[][], scope: string): ResourceSample | null {
    const c = crosshair.value;
    if (!c) return null;
    // EVERY TRACK RESOLVES ONE WHEN THE KEYBOARD HAS THE FOCUS. Normally only the surface the pointer is on
    // reads a datapoint — a tooltip per track under one cursor is four answers to a question asked once. But
    // a keyboard focus is not asked at a position: it names a MODEL, and a model split across cards is on
    // several tracks at once, each holding different things (compute is flat per device, so one card's
    // breakdown genuinely does not describe the other). Reading only the pointed-at track would show one
    // half of a split and silently omit the rest.
    if (!kbFocus.value?.model && !cursorOn(scope)) return null;
    return sampleAtFraction(runs, c.frac);
}

/** WHEN the figures above were measured. A tooltip that reads a historical datapoint has to say which one,
 *  or every reading in it is ambiguous between "now" and "some time back". Nothing is shown when the pointer
 *  is not over the plotted area (a legend key), because there is no datapoint to stamp — inventing "now"
 *  there would be the same wrong claim from the other direction. */
function SampleStamp({ at }: { at: ResourceSample | null }) {
    if (!at) return null;
    const ago = Math.max(0, Date.now() - at.t);
    return (
        <div class="rc-tip-line rc-tip-when">
            {/* TO THE MILLISECOND. Samples land ~250ms apart during a load and the interesting ones are
                consecutive — two readings a quarter-second apart both stamped "19:21:40" cannot be told
                apart, which is exactly the stretch you hover when something looks wrong. */}
            <span>{hhmmssms(at.t)}</span>
            {/* "how long ago" is what makes a clock time mean something at a glance on a plot with no axis
                labels; the clock time is what makes it comparable with the transcript and the event lane. */}
            <span class="rc-tip-ago">{ago < 1500 ? "now" : `${fmtAge(ago)} ago`}</span>
        </div>
    );
}

/**
 * WHAT THIS MODEL'S MEMORY IS HOLDING, on THIS card.
 *
 * `size_vram` alone cannot tell a big MODEL from a big CONTEXT — lots of weights with a small cache, and
 * modest weights with an enormous one, are the same number and want opposite responses (a smaller quant, or
 * less context). This is the answer, and it is drawn as ROWS rather than as a second chart because the chart
 * is already showing it: the swatches are the exact fills the band is subdivided with, so the tip and the
 * plot are one picture rather than two pictures of the same memory.
 *
 * PER CARD, and that is not a detail. `gpus[].memory` sums to that entry's own `size_vram` exactly, so each
 * card's figures are MEASUREMENTS — while a whole-model split divided by a layer or byte ratio would be
 * right about weights and cache and quietly wrong about `compute`, which is FLAT PER DEVICE (measured: 31
 * layers against 10, and both cards holding 115 MiB of it).
 *
 * NO TOTAL ROW. The parts sum to `size_vram` to the byte, and that figure is already two lines above — a
 * total would print the same number twice, and the panel refuses a split that does not add up rather than
 * padding one with a remainder.
 */
function HoldingRows({ model, parts }: { model: string; parts: MemoryBreakdown }) {
    const rows = memoryParts(parts);
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    if (!rows.length || total <= 0) return null;
    return (
        <>
            <div class="rc-tip-line rc-tip-sec">holding</div>
            {rows.map((r) => (
                <div class={`rc-tip-line rc-tip-part${r.key === "other" ? " odd" : ""}`} key={r.key}>
                    <i class="rc-tip-dot" style={{ background: partFill(model, r.key) }} />
                    <span class="rc-tip-plabel">{r.label}</span>
                    <span class="rc-tip-pbytes">{formatBytes(r.bytes)}</span>
                    <span class="rc-tip-ppct">{percentOf(r.bytes, total)}</span>
                </div>
            ))}
            {/* `other` IS THE SIGNAL, not a slice. It is what the server could not name, so it means the
                breakdown is behind the engine — the one part whose SIZE is the message. Called out rather
                than left to sit quietly in the list, and only when it is big enough to matter: a rounding
                crumb under a percent is not news. */}
            {parts.other > 0 && parts.other / total >= 0.01 ? (
                <div class="rc-tip-line rc-tip-dim rc-tip-warn">the server could not name this part — its
                    breakdown is behind the engine it is reporting on</div>
            ) : null}
        </>
    );
}

/**
 * KEEP THE KEYBOARD TIPS FROM SITTING ON EACH OTHER — by TILING them, not by dodging.
 *
 * Each of these is anchored to the track whose reading it is, which is what makes a split model's two answers
 * legible as belonging to two cards. But a drilled-in tip is taller than the ~110px track it belongs to, so
 * the second one landed on the first. The first fix put them on alternating SIDES, which stopped them
 * colliding with each other and did nothing about the plot underneath — and it broke the correspondence,
 * since which side a tip sat on then said nothing about which track it was for.
 *
 * So they are laid out in a column instead: each one wants to start at its own track's top, and is pushed
 * down only as far as the one above it requires. ORDER IS PRESERVED, which is what carries the meaning — the
 * top tip is the top track's — and a track with no tip leaves a real gap, because the next tip's preferred
 * position is still its own track's top and nothing pushed it up.
 *
 * ONLY WHEN THEY WOULD ACTUALLY OVERLAP. A single tip, or two far enough apart, is not moved at all, so the
 * common case keeps the exact alignment with its track that makes it readable.
 *
 * Done imperatively after layout because it is a measurement: how tall a tip is depends on how many parts the
 * server reported, which nothing knows until it is drawn. Idempotent — it resets each transform before
 * measuring — so every tip may safely run it.
 */
const KB_TIP_GAP = 6;
function tileKbTips(root: Document | null): void {
    if (!root) return;
    // DOM ORDER IS TRACK ORDER: the tips are rendered inside their tracks, top to bottom.
    const els = Array.from(root.querySelectorAll(".rc-tip-kb")) as HTMLElement[];
    // SAID ONCE, AT THE BOTTOM. The instant being read and the keys that move the reading are facts about the
    // READING, not about a card — so a split model repeating both on every tip is the same two lines two or
    // three times, in the one view where height is what everything is competing for. Trimming them is what
    // takes a stack of tips from taller than its tracks to shorter, which is the difference between a tip
    // beside the trace it describes and a tip on top of it. Marked before measuring, or the layout below
    // would be computed from heights that are about to change.
    els.forEach((el, i) => el.classList.toggle("dup", i < els.length - 1));
    let prevBottom = -Infinity;
    for (const el of els) {
        el.style.transform = "";                       // measure where it WANTS to be
        const r = el.getBoundingClientRect();
        const dy = r.top < prevBottom + KB_TIP_GAP ? prevBottom + KB_TIP_GAP - r.top : 0;
        if (dy) el.style.transform = `translateY(${dy}px)`;
        prevBottom = r.bottom + dy;
    }
}

/**
 * WHICH LAYERS THIS CARD IS HOLDING.
 *
 * Its OWN section with its OWN units, never a bar beside the memory ones: layers are NOT a proxy for memory
 * and must not share a scale. On an even split of `granite4.1:3b` one card held MORE layers and LESS weight —
 * the output layer is large and carries no KV — so a layers bar and a memory bar drawn together would
 * disagree, correctly, and read as a bug.
 *
 * MATCHED BY NAME, and unmatched means UNKNOWN. `device` is the ENGINE's name (`"CUDA0"`), not the ollama
 * `gpu_id`; they are different fields and a filtered-device host can make them disagree, so a card whose name
 * is not in the list simply shows nothing rather than being handed the entry that happens to sit at its
 * ordinal. `devices` is a list of RUNS rather than one entry per card, so they are summed.
 */
function LayerRows({ placement, device }: { placement: LayerPlacement; device: string }) {
    const mine = placement.devices.filter((d) => d.device === device);
    if (!mine.length) return null;
    const held = mine.reduce((n, d) => n + d.layers, 0);
    const span = mine.map((d) => `#${d.firstLayer}\u2013${d.lastLayer}`).join(", ");
    const swa = placement.swaLayers.filter((n) => mine.some((d) => n >= d.firstLayer && n <= d.lastLayer)).length;
    return (
        <>
            <div class="rc-tip-line rc-tip-sec">layers</div>
            {/* Its OWN class, sharing the parts' layout but not their identity: a layer count is not a
                memory part, and anything counting the parts must not pick this up as a seventh one. */}
            <div class="rc-tip-line rc-tip-part rc-tip-lrow">
                <span class="rc-tip-plabel">{held} of {placement.numLayers}</span>
                <span class="rc-tip-pbytes">{span}</span>
            </div>
            {/* A LIST, not a count, upstream — the pattern is irregular (gemma2 alternates 1:1, gemma4:31b is
                50 of 61), so this counts the ones that landed on THIS card rather than repeating a total. */}
            {swa ? <div class="rc-tip-line rc-tip-dim">{swa} sliding-window</div> : null}
        </>
    );
}

/** What the hovered band is, shown over the plot. Deliberately the SAME facts as the legend row (ModelFacts),
 *  because a band and its row describe one model — an SVG <title> could carry none of it: no colour, no live
 *  TTL, no badge, and a half-second delay before it appears. */
function BandTip({ bands, frame, history, samples, ceiling, scope, label, hidden, at: hoverSample }: { bands: Band[]; frame: Band[] | null; history: Band[][]; samples: ResourceSample[]; ceiling: number; scope: string; label?: string; hidden: Set<string>; at: ResourceSample | null }) {
    const name = hoverModel.value;
    // ANCHORED TO THE TRACK, not to the cursor, whenever the keyboard owns the focus. Two reasons, and the
    // second is the one that forces it: a reader who is not moving the mouse does not want an answer that
    // moves; and a split model shows a tip on EVERY card it is on, which under one cursor would be two
    // tooltips stacked on the same few pixels.
    const kb = kbFocus.value?.model ? kbFocus.value : null;
    const at = cursorOn(scope);
    if (!name || (!kb && !at)) return null;
    // NOTHING TO DESCRIBE once a model is switched off: it is out of the stack and out of the totals, so a
    // tip naming it would be a reading of a shape that is not on the chart.
    if (hidden.has(name)) return null;
    // READ THE DATAPOINT UNDER THE CURSOR, not the newest one. The chart is a history, so the shape being
    // hovered is a measurement from some earlier instant — often of a model that has since evicted, and
    // almost always of a different figure than the model holds now. Answering with the current value would
    // put a number in the tooltip that was never true at the place the pointer is.
    const band = (frame ?? bands).find((b) => b.model === name && b.bytes > 0)
        // Nothing at this instant: the pointer is over the model's shape in a neighbouring column, or the
        // hover fell in a gap. The last frame that held it still answers what the colour IS, rather than
        // leaving a coloured area on the chart with nothing below it to explain it.
        ?? [...history].reverse().flatMap((f) => f.filter((b) => b.model === name && b.bytes > 0)).at(0);
    if (!band) return null;   // hovering a model that isn't on THIS device — its own track shows the tip
    const m = (loadedModels.value || []).find((x) => x.model === name);
    const deep = !!kb && focusDepth() > 0;
    /**
     * THE WHOLE MODEL, found the SAME WAY ITS BAND IS.
     *
     * `perDevice` names every card it is on, so the card count is measured rather than inferred from how many
     * tracks happen to be drawn. But it has to be read from the same instant the band came from: the band
     * lookup already falls back to the last frame that held this model (the pointer is often parked on a
     * stretch from before it loaded), and reading the TOTAL from the hovered sample alone meant the tip drew
     * a band from one instant and looked for its size at another — found nothing, and silently printed
     * nothing. A split model's tips then named no total at all, which is the one figure a per-card reading
     * cannot supply.
     */
    const resAt = (sm: ResourceSample | null) => sm?.models.find((x) => x.model === name);
    let res = resAt(hoverSample);
    for (let i = samples.length - 1; i >= 0 && !res; i--) res = resAt(samples[i]);
    const across = res ? { bytes: res.vramBytes, cards: Object.values(res.perDevice).filter((v) => (v ?? 0) > 0).length } : null;
    // WHICH SIDE. One tip goes wherever the crosshair is not, which is all that matters when there is one.
    // Several — a split model puts one on every card — must not stack, and they are only ~110px of track
    // apart while a drilled-in tip is taller than that, so they alternate instead. Measured before it was
    // fixed: the first tip's last row sat underneath the second tip's header.
    // Away from the mark rather than over it: the crosshair is what the reading belongs to. ALL of them on
    // the same side — several tips are kept apart by tiling them down the column (see tileKbTips), which
    // preserves the correspondence with the tracks that alternating sides destroyed.
    const side = (crosshair.value?.frac ?? 0) < 0.5 ? " right" : " left";
    // Follows the cursor, offset up-left so it never sits under the pointer (which would flicker as the
    // pointer enters the tip itself) and clamped inside the plot so it can't run off the narrow panel.
    const { ref, style } = useTipPlacement(kb ? null : at);
    // AFTER EVERY RENDER, because what decides the layout is how TALL these turned out — which depends on how
    // many parts the server reported and is not knowable until they are drawn. Every tip runs it and the pass
    // is idempotent, so no coordinator has to know how many there are.
    useLayoutEffect(() => { tileKbTips(ref.current?.ownerDocument ?? null); });
    return (
        // A STACK, not a row: name, then the figure, then the badges. On one line the name and the figure set
        // the tip's width and every shorter line left a slab of empty space beside it.
        <div class={`rc-tip rc-tip-model${kb ? ` rc-tip-kb${side}` : ""}`} role="tooltip" ref={ref} style={style}>
            <div class="rc-tip-line"><i class="rc-tip-dot" style={{ background: colorFor(name) }} />
                <span class="rc-tip-name">{name}</span>
                {/* WHICH CARD, once you are reading one card's contents. A split model shows one of these per
                    track and their figures differ on purpose, so a tip that did not name its own device
                    would be two unlabelled answers to the same question. */}
                {deep && label ? <span class="rc-tip-of rc-tip-onwhat">on {label}</span> : null}</div>
            {/* Bytes AND the share of this device — a model is "big" only relative to the card it is on. */}
            <div class="rc-tip-line"><span class="rc-tip-size">{formatBytes(band.bytes)} <span class="rc-tip-pct">({percentOf(band.bytes, ceiling)})</span></span></div>
            {/* THE DENOMINATOR, dimmed and on its own row — the same line the pool tip carries, because the
                percentage above is a share of THIS pool and a share with no denominator on screen is the one
                figure a reader has to go and find. Dimmed because it is a CONSTANT: it does not change as
                you move along the trace, so it is the number that should recede rather than be read first.
                On the same line it competed with the reading for one glance. */}
            {/* The CARD's denominator, and only while the card is the subject. Drilled in it is not — the
                question became "what is this model holding", the rows below answer it as shares of the model,
                and a second denominator in the same tip is one the reader has to work out is unused. Dropping
                it also buys back a line, which is the difference between a tip that fits inside its track and
                one that covers the shape it is describing. */}
            {!deep ? <div class="rc-tip-line rc-tip-of">out of {formatBytes(ceiling)}</div> : null}
            {/* HOW BIG THE MODEL IS, when this card holds only part of it — the per-card figure above cannot
                answer that, and on a split it is the first thing you want. Only when it IS split: on one card
                the card's figure IS the total, and printing it twice is the same noise as a total row under
                the parts. Read from the SAMPLE rather than from what is resident now, so the whole tip stays
                a reading of one instant. */}
            {/* HOW BIG THE MODEL IS, on EVERY card's tip. A split model's per-card figure answers "how much of
                this card" and cannot answer "how big is this thing" — and 1.94 GiB beside 878 MiB, each under
                its own denominator, invites the reader to take either one for the model. So both tips carry
                the whole, and say what share of it this card is holding, which is the relationship between
                the two numbers rather than a third number to reconcile. Only when it IS split: on one card
                the card's figure IS the total, and printing it twice is the noise a total row would be. */}
            {across && across.cards > 1
                ? <div class="rc-tip-line rc-tip-of">{formatBytes(across.bytes)} across {across.cards} cards
                    <span class="rc-tip-here">{percentOf(band.bytes, across.bytes)} here</span></div>
                : null}
            {deep && band.parts ? <HoldingRows model={name} parts={band.parts} /> : null}
            {deep && res?.placement && label ? <LayerRows placement={res.placement} device={label} /> : null}
            {deep && !band.parts
                // ABSENT IS NOT ZERO. A loading row, an MLX runner, or a build predating the field reports no
                // split at all — and an empty decomposition would read as "it is holding nothing".
                ? <div class="rc-tip-line rc-tip-dim">the server did not report what this is holding</div>
                : null}
            <SampleStamp at={hoverSample} />
            {/* NO "not resident now" HERE, and none on the consumer rows either. This tooltip reads a sample
                from the PAST: it answers what was on this card at that instant, the stamp above says which
                instant, and at that instant the model WAS there. Annotating it with what happened afterwards
                answers a question nobody asked at the place they asked it. It was here to explain why a
                colour was still on the chart with no row under it — which the model list's GHOST rows now do,
                where "is it resident" is actually the question being asked. */}
            {/* Badges and cost each break onto their OWN line. On one line the tip grew past the panel and was
                clipped at the window edge — and the figure that matters (how much, what share) is the part
                that got cut. */}
            {m && !deep ? <div class="rc-tip-facts"><ModelFacts m={m} tips={false} /></div> : null}
            {!deep ? <CostFacts model={name} /> : null}
            {/* WHAT THE KEYS DO, and only while the keys are what is driving. A hint under a tip the pointer
                summoned would advertise a mode at the one moment the reader is already in another one. */}
            {/* WHENEVER A TIP IS UP, not only once the keys are already driving. Gating it on the keyboard
                showed the affordance exclusively to readers who had discovered it — the one group that did
                not need telling — so nobody arrived at it from the mouse, which is how everybody arrives.
                The keys work from a hover exactly as they do from a keyboard focus (see stepDepth), so the
                hint is true in both.

                And it names EVERYTHING the key reaches: "another model" was wrong, because the list wraps
                through the OVERVIEW, and a reader told half of what a key does stops pressing before finding
                the rest. */}
            <div class="rc-tip-line rc-tip-keys">
                <span><kbd>↑↓</kbd> models &amp; overview</span>
                <span>{deep ? <><kbd>←</kbd> back</> : <><kbd>→</kbd> details</>}</span>
            </div>
        </div>
    );
}

/** The whole pool's occupancy at the hovered instant — the stacked view's answer to "how full was it then",
 *  which is the reading a memory chart is hovered for most often and the one the band tips could not give
 *  (they each describe one model). Suppressed while a band IS hovered, so one pointer never opens two tips. */
function PlotTip({ at, bands, ceiling, label, hidden, scope }: { at: ResourceSample; bands: Band[]; ceiling: number; label: string; hidden: Set<string>; scope: string }) {
    const cur = cursorOn(scope);
    if (!cur) return null;
    const { ref, style } = useTipPlacement(cur);
    // Hidden models are excluded, exactly as they are from the drawn stack and the header total: the figure
    // has to match the shape under the pointer, and hiding a model changes that shape retroactively.
    const used = bands.filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    const models = bands.filter((b) => b.kind === "model" && b.bytes > 0 && !(b.model && hidden.has(b.model)));
    return (
        <div class="rc-tip rc-tip-pool" role="tooltip" ref={ref} style={style}>
            {/* THE FIGURE FIRST, THE DENOMINATOR UNDER IT. On one line the ceiling competes with the reading
                for the same glance — and the ceiling is a CONSTANT, the one number in the tooltip that never
                changes as you move along the trace, so it is the one that should recede. Dimmed and on its
                own row it is still there to answer "of what", which is the question the panel exists to make
                unavoidable, without being read first. */}
            <div class="rc-tip-line"><span class="rc-tip-name">{label}</span>
                <span class="rc-tip-size">{formatBytes(used)} in use{percentOf(used, ceiling) ? ` (${percentOf(used, ceiling)})` : ""}</span></div>
            <div class="rc-tip-line rc-tip-of">out of {formatBytes(ceiling)}</div>
            <SampleStamp at={at} />
            {/* Named, because "62% full" invites "of what" as the immediate next question, and the answer is
                on the screen already but only in a list that shows the PRESENT. */}
            {models.length
                ? <div class="rc-tip-line rc-tip-dim rc-tip-holders">{models.map((b) => (
                    <span class="rc-tip-consumer" key={b.key}>
                        <i class="rc-tip-dot" style={{ background: colorFor(b.model!) }} />{b.model}</span>))}</div>
                // NOT "nothing resident" WHEN THE POOL IS FULL. Read off `ps`, which has no runner object
                // during a load, that put "88.28 GiB of 95.59 GiB (92%)" and "nothing resident" in the SAME
                // tooltip. The sample knows what was loading; when it does not, "not attributed" is still the
                // honest phrasing, because the memory is plainly there.
                : used > 0
                    ? <div class="rc-tip-line rc-tip-dim">{at.loading?.length
                        ? `loading ${at.loading.join(", ")} — not attributed yet`
                        : "in use, not attributed to a model"}</div>
                    : <div class="rc-tip-line rc-tip-dim">nothing resident</div>}
            {/* THE WAY IN. This is the tip you get by pointing anywhere on the plot, so it is where a reader
                who does not know the keys exist is standing — and the models it just listed are exactly what
                the key steps through. */}
            {/* THE REST OF "IN USE", named — a runner's overhead, a tenant, what ollama cannot see. Only once the
                server names processes: before that the residual is one guess, already in the legend. */}
            {bands.some((b) => b.kind === "other" && (b.key !== "other" || b.label === OUTSIDE_VIEW_LABEL))
                ? <div class="rc-tip-line rc-tip-dim rc-tip-holders">{bands.filter((b) => b.kind === "other" && b.bytes >= 1024 ** 2).map((b) => (
                    <span class="rc-tip-consumer" key={b.key}>
                        <i class="rc-tip-dot" style={{ background: bandFill(b.key, undefined, b.of) }} />{b.label} {formatBytes(b.bytes)}</span>))}</div>
                : null}
            {models.length ? <div class="rc-tip-line rc-tip-keys"><span><kbd>↑↓</kbd> pick a model</span></div> : null}
        </div>
    );
}

/** EVERY series at the datapoint under the cursor, one row each — the Grafana reading. Hovering a single line
 *  could only ever answer for the line that happened to be drawn on top: where two lines meet, the one
 *  underneath is unreachable, and that crossing is exactly the moment worth reading (one pool filling as
 *  another empties). So the plot itself opens the tip and every pool gets a row, with the nearest one marked
 *  rather than being the only one present.
 *
 *  Each row carries the pool's own swatch, its occupancy and its share — the shares are what the lines plot,
 *  since the pools have different capacities and a common axis of bytes would compare nothing. */
function PoolsTip({ pools, latest, at: hoverSample, fracOf, usedOf, surface = "overlay", bandOf, links = [] }: {
    pools: { id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] }[];
    latest: ResourceSample;
    at: ResourceSample | null;
    fracOf: (s: ResourceSample, p: any) => number;
    usedOf: (s: ResourceSample, p: any) => number;
    /** The surface the view tracks its pointer as — the overlaid view's, or a whole-box track's own scope. */
    surface?: string;
    /** The BRIDGES between adjacent pools, said in words — the walls in the whole-box view are visuals and do
     *  not open a tooltip of their own (a hover target inside the plot would stack a second tip on this one). */
    links?: { label: string; phrase: string; note?: string }[];
    /** Where a pool OWNS the height, as [bottom, top] fractions of the plot. The whole-box view lays pools end
     *  to end, so the pool you are pointing at is the band the pointer is inside, not the fill top nearest to
     *  it — nearest-by-line would name a neighbour whenever you point low inside a tall band. */
    bandOf?: (p: any) => [number, number];
}) {
    const cur = cursorOn(surface);
    if (!cur || !pools.length) return null;
    const frame = hoverSample ?? latest;
    const { ref, style } = useTipPlacement(cur);
    // Nearest by the pointer's height in the plot, which is where the lines are: a line at 92% is drawn near
    // the TOP, so the comparison is against 1 - frac.
    // A pool that is not drawn gets no row: the tip reads the LINES, and reporting a series that is not on
    // screen would be answering about something the reader deliberately removed.
    const rows = pools.filter((p) => !hiddenPools.value.has(p.id)).map((p) => {
        const frac = fracOf(frame, p);
        return { p, frac, used: usedOf(frame, p), dy: cur.yFrac == null ? Infinity : Math.abs((1 - frac) - cur.yFrac) };
    });
    // A DELIBERATE hover wins over proximity: pointing at a line, or at its key in the legend, says which pool
    // you mean more precisely than the pointer's height can. Height decides only when the pointer is just
    // somewhere on the plot, which is the case the stacked reading exists for.
    const inside = bandOf && cur.yFrac != null ? rows.find((r) => { const [lo, hi] = bandOf(r.p); const h = 1 - cur.yFrac!; return h >= lo && h <= hi; }) : null;
    const picked = (poolHover.value ? rows.find((r) => r.p.id === poolHover.value!.id) : null) ?? inside;
    const near = picked ?? rows.reduce((a, b) => (b.dy < a.dy ? b : a), rows[0]);
    const hasNear = !!picked || near.dy < Infinity;
    return (
        // ONE GRID, not a stack of independently-laid-out rows. Every row — a pool's and a consumer's alike —
        // places its name, its amount and its share in the SAME three columns, so the numbers line up on one
        // right edge whatever their nesting depth. Formatting each row's tail separately is what produced
        // three different right edges and two different percent styles in the same tooltip.
        <div class="rc-tip rc-tip-pools" role="tooltip" ref={ref} style={style}>
            <SampleStamp at={hoverSample} />
            {rows.map((r) => {
                const isNear = r === near && hasNear;
                // Only the NEAREST pool is decomposed. Listing what is resident on all three at once is the
                // detail the model rows below already carry, and it turns a reading into a wall — the stack
                // exists so a crossing can be read at a glance.
                const consumers = isNear ? poolFacts(r.p.bandsOf(frame)).consumers : [];
                const now = isNear ? new Set(poolFacts(r.p.bandsOf(latest)).consumers.map((c) => c.label)) : new Set<string>();
                return (
                    // One SECTION per pool: the pool's own line, then whatever is resident on it. The rule
                    // between sections is what stops a consumer reading as another device.
                    <div class="rc-tip-sect" key={r.p.id}>
                        <div class={`rc-tip-row rc-tip-poolrow${isNear ? " near" : ""}`}>
                            <span class="rc-tip-label"><i class="rc-swatch" style={{ background: r.p.color }} />{r.p.name}</span>
                            {/* Split into the grid's own columns rather than one formatted string: the whole
                                point is that the amount and the share are COLUMNS, and formatShare renders
                                them as a sentence. "of <ceiling>" rides with the amount, since it is what the
                                share is a share OF. */}
                            <span class="rc-tip-amt">{formatBytes(r.used)}<span class="rc-tip-of"> of {formatBytes(r.p.ceiling)}</span></span>
                            <span class="rc-tip-pct">{percentOf(r.used, r.p.ceiling)}</span>
                        </div>
                        {consumers.map((c) => (
                            <div class="rc-tip-row rc-tip-consumer-row" key={c.label}>
                                <span class="rc-tip-label">
                                    {/* A model's own dot, the same one its row carries. The residual gets a
                                        HOLLOW one: an empty ring holds the same space so the names line up,
                                        while visibly not being a colour swatch — which is the thing that
                                        would claim the residual is a model. Omitting it entirely aligned
                                        nothing and left the column ragged. */}
                                    {c.model
                                        ? <i class="rc-tip-dot" style={{ background: colorFor(c.model) }} />
                                        : <i class="rc-tip-dot rc-tip-dot-none" />}
                                    <span class="rc-tip-cname">{c.label}</span>
                                    {/* NO "gone" MARKER HERE. This tooltip reads a sample from the PAST — it
                                        answers "what was on this card at that instant", and at that instant
                                        the model was resident, so annotating it with what happened later is
                                        answering a question nobody asked at the place they asked it. Whether
                                        a model is resident NOW is the model list's job, where the row says
                                        so and the tooltip on it explains. */}
                                </span>
                                <span class="rc-tip-amt">{formatBytes(c.bytes)}</span>
                                <span class="rc-tip-pct">{percentOf(c.bytes, r.p.ceiling)}</span>
                            </div>
                        ))}
                        {isNear && !consumers.length
                            ? <div class="rc-tip-row rc-tip-consumer-row"><span class="rc-tip-label rc-tip-dim">nothing resident</span></div>
                            : null}
                    </div>
                );
            })}
            {/* THE BRIDGES the walls are drawn for, in words: which pairs are directly linked and by what. A
                section of its own, after the pools, because a link belongs to a PAIR and never to one row. */}
            {links.length ? (
                <div class="rc-tip-sect rc-tip-links">
                    {links.map((l) => (
                        <div class="rc-tip-row" key={l.label}>
                            <span class="rc-tip-label">{l.label}</span>
                            <span class="rc-tip-amt">{l.phrase}</span>
                            {l.note ? <span class="rc-tip-note rc-tip-linknote">{l.note}</span> : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {/* AT THE BOTTOM, where the other view puts it — a hint that moves between views is one more
                thing to find. ONLY ↑↓: there is no depth here to descend into, since a pool has no memory
                breakdown of its own (the decomposition is per MODEL), and naming a key that silently does
                nothing is worse than naming none. */}
            {rows.length > 1 ? <div class="rc-tip-row rc-tip-keys"><span><kbd>↑↓</kbd> pick a line</span></div> : null}
        </div>
    );
}

/** Every track this machine warrants: one per accelerator, plus the host pool on a discrete box. A unified
 *  device has ONE pool, so it gets one track (its bands already come from the host) and no separate RAM track
 *  — two would double-count the same silicon. */
/** Hovering a pool's line publishes WHICH POOL and WHAT IS ON IT. The model rows below the chart already list
 *  every resident model, so they are the legend: rows not on this pool grey out, and a tooltip on the plot
 *  names the device. That reuses what is on screen instead of injecting a row that pushes the layout around
 *  under the cursor. */
type PoolRef = { id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] };
/**
 * THE LINES THE KEYS STEP THROUGH, published from the render that draws them — the key handler runs outside
 * render, and "which pools are on screen" is a fact about what was just drawn. A plain ref for the same
 * reason `liveRuns` is one: written DURING render, and a signal written during render re-enters rendering.
 */
let poolRefs: PoolRef[] = [];
/** Publish the lines the arrow keys step through — call it from the render that DRAWS them. */
export const notePools = (pools: PoolRef[]): void => { poolRefs = pools; };
/** Is the reading currently in the overlaid view? Decides which list the arrow keys step through. */
export const readingIsOverlay = (): boolean => readingOverlay;
/**
 * WHICH VIEW THE READING IS IN, so one key can mean "the thing this view draws" in both. Recorded from the
 * pointer's own surface rather than from the layout, because a layout may hold tracks of both kinds and the
 * answer is about where the reader is pointing. It OUTLIVES a pointerleave deliberately: the keyboard keeps
 * reading after the pointer wanders off, and it has to keep reading the same view.
 */
let readingOverlay = false;
/** Cycle the focused LINE in the overlaid view, wrapping through "nothing picked out" at index 0. Hidden
 *  pools are skipped: switching a line off takes it off the chart, so there is nothing left to point at. */
export function stepPool(dir: number): void {
    const shown = poolRefs.filter((p) => !hiddenPools.value.has(p.id));
    const list: (PoolRef | null)[] = [null, ...shown];
    const cur = kbPool.value ? kbPool.value.id : poolHover.value?.id ?? null;
    const at = list.findIndex((p) => (p?.id ?? null) === (cur ?? null));
    const next = list[((at < 0 ? 0 : at) + dir + list.length) % list.length];
    kbPool.value = { id: next?.id ?? null };
    if (next) enterPool(next); else leavePool();
}
/** Hand the LINE focus back to the pointer, on a real move and nothing else — the twin of `releaseFocus`. */
function releasePool(target: EventTarget | null): void {
    if (!kbPool.value) return;
    kbPool.value = null;
    if (!(target as Element | null)?.closest?.(".rc-hit")) leavePool();
}

function enterPool(p: { id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] }): void {
    hoverPool.value = p.id;
    // The pool itself, not a reading of it — every figure is derived from the sample under the cursor at
    // render time. Its COLOUR rides along so the tip can carry the same swatch its legend key does: several
    // lines cross in one plot, and a tip that only names a device leaves you matching a name to a stroke by
    // eye, which is the work the legend's swatches already do everywhere else.
    poolHover.value = { id: p.id, name: p.name, ceiling: p.ceiling, color: p.color, bandsOf: p.bandsOf };
}
function leavePool(): void { hoverPool.value = null; poolHover.value = null; }

/** The per-vendor name for "the tool that shows this card's memory". Saying "nvidia-smi" on an AMD box is
 *  worse than saying nothing — it tells the reader to check something that isn't there. */
const smiFor = (runner: string): string =>
    runner === "CUDA" ? "nvidia-smi" : runner === "ROCm" ? "rocm-smi" : "";

/** What a device track's denominator is, in that device's own terms. */
function deviceCeilingNote(dev: { runner: string; unified: boolean; physicalBytes?: number }): string {
    if (dev.unified) return "This machine shares ONE pool of memory between the GPU and the system, so the ceiling is the system total. The dashed line is the working set the accelerator is advised to stay within — it is not a second pool, and the two are never added together.";
    const smi = smiFor(dev.runner);
    if (dev.physicalBytes != null)
        return `Total as the driver reports it${smi ? `, matching ${smi}` : ""}. Ollama places against a slightly lower figure (its own reserve), so a model can fail to fit slightly before this line.`;
    return `Capacity as Ollama reports it — the figure placement decides against. It sits a little below the driver's own total${smi ? `, which ${smi} shows` : ""}; this server doesn't report that one.`;
}

/** Draw one TrackDef. A track's series resolve to band sources: `vram.<id>` is that device's decomposition,
 *  `ram`/`mem` the host pool's. STACK renders the bands (the parts do sum to that pool's occupancy); OVERLAY
 *  renders one line per series, each against its own ceiling, because several pools have no shared total —
 *  which is exactly what `stackRefusal` refuses and why the Overview preset overlays. */
function TrackView({ def, samples, latest, hidden, events = [] }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string>; events?: ResourceEvent[] }) {
    // NOT OFFERED ON THE LAST ONE. A panel with no tracks is not a layout you can get back from by the same
    // gesture, and a button that refuses when pressed is worse than one that is visibly unavailable.
    const all = layout.value ?? [];
    const onHide = all.length > 1 ? () => editLayout(all.filter((t) => t.id !== def.id)) : undefined;
    const cap = latest.capacity!;
    const deviceOf = (id: string) => cap.devices.find((d) => d.id === id.replace(/^vram\./, ""));
    const first = def.series[0] ?? "";
    const isHost = first === "ram" || first === "mem";
    // HOW BUSY, not how full — its own view, since it is its own unit. The editor refuses a track that mixes it
    // with memory series (`kindRefusal`), so a utilization track is all utilization.
    if (def.series.length && def.series.every((id) => id.startsWith("util.")))
        return <UtilView def={def} onHide={onHide} samples={samples} latest={latest} events={events} />;

    // `overlay` is meaningful even for ONE series — it is a LINE of that pool's occupancy rather than the
    // per-model bands, which is the compact-vs-detailed choice. Short-circuiting to the stacked view below two
    // series made the mode control inert on exactly the layout the presets produce (a track per pool).
    if (def.mode === "stack") {
        if (isHost) {
            const label = first === "mem" ? `${cap.devices[0]?.name ?? "Memory"} · unified memory` : "System RAM";
            const c = first === "mem" ? ceilingsFor(latest, cap.devices[0]?.id ?? "") : null;
            // The HOST pool: no driver, no framebuffer — just the machine's RAM. On unified memory this same
            // track IS the accelerator's pool, so it carries that explanation instead.
            const note = first === "mem" && cap.devices[0]
                ? deviceCeilingNote(cap.devices[0])
                : "Total system memory. Models here are running on the CPU, or are the spilled part of a model too large for the accelerator.";
            return <DeviceView label={label} onHide={onHide} samples={samples} bandsOf={hostBands}
                ceiling={c?.hardBytes ?? cap.host.totalBytes} ceilingNote={note}
                soft={c?.softBytes ? { bytes: c.softBytes, label: c.softLabel || "" } : null} hidden={hidden} events={events} />;
        }
        const d = deviceOf(first);
        if (!d) return null;
        const c = ceilingsFor(latest, d.id);
        return <DeviceView label={d.name} onHide={onHide} device={d} samples={samples} bandsOf={(s) => deviceBands(s, d.id)}
            ceiling={c?.displayBytes ?? d.totalBytes} ceilingNote={deviceCeilingNote(d)}
            soft={c?.softBytes ? { bytes: c.softBytes, label: c.softLabel || "" } : null} hidden={hidden} events={events} />;
    }
    if (def.mode === "total") {
        return <BoxView def={def} onHide={onHide} samples={samples} latest={latest} hidden={hidden} events={events} />;
    }
    return <OverlayView def={def} onHide={onHide} samples={samples} latest={latest} hidden={hidden} events={events} />;
}

/**
 * THE WHOLE BOX ON ONE AXIS — every pool laid END TO END, each filling its own band from its own floor.
 *
 * The question it answers is "how much of this machine is in use", which the per-pool tracks cannot: they
 * give every pool the same height whatever its size, so a 12 GiB card and a 96 GiB one look alike and the
 * box's shape is invisible. Here a pool's height IS its share of the machine.
 *
 * What it must never do is draw the memory as ONE pool. Pools do combine — ollama splits a model across
 * cards and spills the rest into RAM — but at a cost per boundary (a compute buffer and driver context per
 * extra card, layers that do not divide, a RAM spill that is far slower), so the pools are concatenated
 * rather than poured together, and the WALLS between them are drawn. The axis total is then a true total of capacity and every fill is a real
 * reading against a real ceiling. The header says what is HELD and never what is free, which is the one
 * sentence the walls exist to deny.
 */
function BoxView({ def, samples, latest, hidden, events = [], onHide }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string>; events?: ResourceEvent[]; onHide?: () => void }) {
    const cap = latest.capacity!;
    const scope = `total:${def.id}`;
    const all = def.series.map((id) => {
        if (id === "ram" || id === "mem") {
            const c = id === "mem" ? ceilingsFor(latest, cap.devices[0]?.id ?? "") : null;
            return { id, name: id === "mem" ? `${cap.devices[0]?.name ?? "Memory"}` : "System RAM",
                ceiling: c?.hardBytes ?? cap.host.totalBytes, bandsOf: hostBands };
        }
        const d = cap.devices.find((x) => x.id === id.replace(/^vram\./, ""));
        if (!d) return null;
        const c = ceilingsFor(latest, d.id);
        return { id, name: d.name, ceiling: c?.displayBytes ?? d.totalBytes,
            bandsOf: (sm: ResourceSample) => deviceBands(sm, d.id) };
    }).filter(Boolean) as { id: string; name: string; ceiling: number; bandsOf: (s: ResourceSample) => Band[] }[];
    // CARDS THAT ARE DIRECTLY LINKED SIT SIDE BY SIDE (`bridgeOrder`), because a wall between two adjacent bands
    // is the only place a bridge can be drawn on one axis. Only a MEASURED topology reorders; the host pool and
    // anything that is not a card keep their place after the cards.
    const devOrder = bridgeOrder(cap.devices, cap.topology).map((d) => `vram.${d.id}`);
    const rank = (id: string) => { const i = devOrder.indexOf(id); return i < 0 ? 1e6 + def.series.indexOf(id) : i; };
    all.sort((a, b) => rank(a.id) - rank(b.id));
    // A pool switched off leaves the axis entirely rather than sitting there empty: shrinking the total is
    // what makes "just my two cards" a view rather than arithmetic the reader has to do.
    const pools = all.filter((p) => !hiddenPools.value.has(p.id));
    const pciOf = (id: string) => (id.startsWith("vram.") ? cap.devices.find((d) => d.id === id.slice(5))?.pciId : undefined);
    // What each wall between two adjacent pools is: a bridge when THAT pair is directly linked, and whether the
    // run of bridged cards it belongs to is a full mesh (see `bridgeWalls`). Walls between visible pools only —
    // hiding a card re-adjoins its neighbours, and their wall is then about THEM.
    const walls = bridgeWalls(pools.map((p) => ({ pciId: pciOf(p.id) })), cap.topology);
    const links = walls.flatMap((w, i) => (w.bridge && w.link ? [{
        label: `${pools[i].name} ═ ${pools[i + 1].name}`, phrase: linkPhrase(w.link),
        note: w.mesh === "partial" ? `part of a PARTIAL mesh — not directly linked: ${w.unlinked.map(([a, b]) => `${pools[a].name}–${pools[b].name}`).join(", ")}` : undefined,
    }] : []));
    if (!pools.length) return null;
    const axis = boxAxis(pools);
    if (!axis.total) return null;
    const usedOf = (sm: ResourceSample, p: typeof pools[number]) =>
        p.bandsOf(sm).filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    const runs = noteRuns(segments(samples, sampleGapMs()).filter((r) => r.length > 1));
    const instants = useInstants(runs, events);
    const held = pools.reduce((n, p) => n + usedOf(latest, p), 0);
    // THE SAME READING THE OVERLAID VIEW GIVES, because it is the same question asked of the same pools — this
    // view had none, so pointing at it (or at a key) answered nothing. Colours are the ones the bands are drawn
    // in; the pool you are pointing at is the band you are INSIDE, since the pools here own heights rather
    // than drawing lines to be near.
    const tipPools = pools.map((p) => {
        const bi = axis.bands.findIndex((b) => b.id === p.id);
        return { ...p, color: poolColor(bi < 0 ? 0 : bi, axis.bands.length) };
    });
    const bandOf = (p: { id: string }): [number, number] => {
        const b = axis.bands.find((x) => x.id === p.id);
        return b ? [b.base / axis.total, (b.base + b.ceiling) / axis.total] : [0, 0];
    };
    return (
        <div class="rc-track">
            <div class="rc-head">
                <HideTrack onHide={onHide} label={pools.map((p) => p.name).join(" · ")} />
                <span class="rc-name">{pools.map((p) => p.name).join(" · ")}</span>
                <span class="sp" />
                {/* HELD, never FREE. Those bytes are measured, so the figure is true. A "free" total would
                    overstate the room — per-card overheads and layer-sized leftovers mean the gap is not all
                    usable — and would count a GiB of slow RAM the same as a GiB of VRAM. */}
                <span class="rc-total tt">
                    {formatBytes(held)} of {formatBytes(axis.total)} held
                    <span class="tt-pop wrap" role="tooltip">Every pool on one axis, laid end to end — each band is one pool's own capacity, filled from its own floor. Pools do combine: a model too big for one card is split across several, and what still does not fit spills into System RAM. But not one-for-one: each extra card a model spans carries its own compute buffer and driver context, layers do not divide, and a spill into RAM runs far slower — so the room above the fills does not simply add up. Switch a pool off in the legend to take it out of the axis.</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor(scope)(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => {
                    hoverAt.value = null;
                    if (kbFocus.value || kbPool.value) return;
                    crosshair.value = null;
                }}>
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                <PoolsTip pools={tipPools} latest={latest} at={hoveredSample(runs, scope)} surface={scope} bandOf={bandOf}
                    fracOf={(sm, p) => (p.ceiling > 0 ? Math.min(1, usedOf(sm, p) / p.ceiling) : 0)} usedOf={usedOf} links={links} />
                <EventTip scope={scope} />
                {runs.map((run, ri) => (
                    <div class="rc-seg" key={ri} style={{ flex: `${runWeight(run)} 1 0` }}>
                        <TimeGrid runs={runs} run={run} />
                        <InstantRules instants={instants} run={ri} scope={scope} />
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {axis.bands.map((b, bi) => {
                                const p = pools.find((x) => x.id === b.id)!;
                                const y = (v: number) => H - (v / axis.total) * H;
                                const pts: string[] = [];
                                run.forEach((sm) => {
                                    const x = runFrac(run, sm.t) * W;
                                    pts.push(`${x.toFixed(1)},${y(b.base + Math.min(b.ceiling, usedOf(sm, p))).toFixed(1)}`);
                                });
                                for (let i = run.length - 1; i >= 0; i--) {
                                    const x = runFrac(run, run[i].t) * W;
                                    pts.push(`${x.toFixed(1)},${y(b.base).toFixed(1)}`);
                                }
                                return <polygon key={b.id} points={pts.join(" ")} class="rc-boxfill"
                                    fill={poolColor(bi, axis.bands.length)} vector-effect="non-scaling-stroke" />;
                            })}
                        </svg>
                        {/* THE WALLS. Drawn per segment so they sit inside the same clipped box the fills do,
                            and they are the whole reason this axis is honest: without them a reader sees one
                            column and infers one pool. */}
                        {axis.bands.slice(1).map((b, wi) => (
                            // A BRIDGE where that exact pair is directly linked (NVLink, xGMI): the wall a
                            // model split across the two pays least to cross. Hatched, and lighter when the run
                            // it belongs to is only a PARTIAL mesh, so a cube-mesh never reads as a switch.
                            <i key={`w:${b.id}`} class={`rc-boxwall${walls[wi]?.bridge ? ` bridge${walls[wi].mesh === "partial" ? " partial" : ""}` : ""}`} aria-hidden="true"
                                style={{ bottom: `${(b.base / axis.total) * 100}%` }} />
                        ))}
                    </div>
                ))}
            </div>
            {/* One key per pool, carrying what it holds OF ITS OWN capacity — the per-pool reading the axis
                deliberately refuses to compute for you. Clicking one takes it off the axis.
                THE SAME KEY THE OVERLAID VIEW USES, down to the element: `.rc-key` is styled for a SPAN with
                `role="button"`, so a native <button> here picked up the browser's own chrome and the two
                legends stopped looking like the same control. Reused rather than restyled — a second key that
                merely resembles the first is how the pointer chip got cloned. */}
            <div class="rc-legend">
                {all.map((p, i) => {
                    const off = hiddenPools.value.has(p.id);
                    const idx = axis.bands.findIndex((b) => b.id === p.id);
                    const color = poolColor(idx < 0 ? i : idx, Math.max(1, axis.bands.length));
                    return (
                        <span class={`rc-key${off ? " off" : ""}${hoverPool.value && hoverPool.value !== p.id ? " away" : ""}`}
                            key={p.id} role="button" tabIndex={0} aria-pressed={!off}
                            // A NAME, not an explanation: the reading is the pool tip this hover opens, exactly as
                            // on the overlaid view's keys. A native `title` as well was a second tooltip, a second
                            // late, for a hint the pressed state already carries.
                            aria-label={off ? `Show ${p.name}` : `Hide ${p.name}`}
                            onClick={() => togglePool(p.id)}
                            onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePool(p.id); } }}
                            onPointerEnter={(e: PointerEvent) => { enterPool({ ...p, color }); trackCursor(scope)(e); }}
                            onPointerMove={trackCursor(scope)}
                            onPointerLeave={() => { leavePool(); hoverAt.value = null; }}>
                            <i class="rc-swatch" style={{ background: off ? "var(--fg-faint)" : color }} />
                            {p.name} {off ? "off" : formatShare(usedOf(latest, p), p.ceiling, "/")}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

/** The utilization figures a sample carries for one card, or undefined — "not read", never idle. */
const utilOf = (s: ResourceSample, id: string) => s.capacity?.devices.find((d) => d.id === id)?.utilization;

/**
 * HOW BUSY EACH CARD IS, over time — the Activity preset. Two lines per card in its own colour: SOLID for the
 * GPU, DASHED for its memory controller, which is the one to watch for decode (decode is bound by memory
 * bandwidth, and 90% there is the controller saturating). A share of TIME, so it never shares a track with a
 * share of memory (`kindRefusal`).
 *
 * Both figures are averages the DRIVER takes over its own window (1/6 s to 1 s by product, and the call does
 * not say which), so a reading cannot show two cards of a split model taking turns within one token — the
 * header says "averaged by the driver" rather than implying an instant. A missing reading BREAKS the line: it
 * is "not reported", which is not idle (0 is idle) and not a fault either — a dead card and a card without the
 * counter answer alike, and faults come from `unavailable_gpus`. The two figures are independent (an AMD iGPU
 * has the first and no file for the second), so each is drawn on its own.
 */
function UtilView({ def, samples, latest, events = [], onHide }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; events?: ResourceEvent[]; onHide?: () => void }) {
    const cap = latest.capacity!;
    const scope = `util:${def.id}`;
    const cards = def.series.map((id) => cap.devices.find((d) => d.id === id.slice("util.".length))).filter(Boolean) as DeviceCapacity[];
    const runs = noteRuns(segments(samples, sampleGapMs()).filter((r) => r.length > 1));
    const instants = useInstants(runs, events);
    if (!cards.length) return null;
    const color = (i: number) => poolColor(i, cards.length);
    const names = cards.map((c) => c.name).join(" · ");
    return (
        <div class="rc-track">
            <div class="rc-head">
                <HideTrack onHide={onHide} label={names} />
                <span class="rc-name">{names}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    % of time busy
                    <span class="tt-pop wrap" role="tooltip">Solid: how busy each GPU was. Dashed: how busy its memory controller was — the one to watch while decoding, which is bound by memory bandwidth. Both are averages the driver takes over its own window (up to a second), so this cannot show two cards taking turns within one token. A card with no reading draws no line: that means not reported, which is neither idle nor a fault.</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor(scope)(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => { hoverAt.value = null; if (kbFocus.value || kbPool.value) return; crosshair.value = null; }}>
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                <UtilTip cards={cards} color={color} at={hoveredSample(runs, scope)} latest={latest} scope={scope} />
                <EventTip scope={scope} />
                {runs.map((run, ri) => (
                    <div class="rc-seg" key={ri} style={{ flex: `${runWeight(run)} 1 0` }}>
                        <TimeGrid runs={runs} run={run} />
                        <InstantRules instants={instants} run={ri} scope={scope} />
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {cards.flatMap((c, ci) => (["gpuPercent", "memoryPercent"] as const).flatMap((k) => {
                                // Split wherever the reading is ABSENT, so a gap in the counter is a gap in the
                                // line and never a stroke drawn down to zero.
                                const parts: string[][] = [];
                                let cur: string[] = [];
                                run.forEach((sm) => {
                                    const v = utilOf(sm, c.id)?.[k];
                                    if (v == null) { if (cur.length) parts.push(cur); cur = []; return; }
                                    cur.push(`${(runFrac(run, sm.t) * W).toFixed(1)},${(H - (v / 100) * H).toFixed(1)}`);
                                });
                                if (cur.length) parts.push(cur);
                                return parts.filter((pts) => pts.length > 1).map((pts, pi) => (
                                    <polyline key={`${c.id}:${k}:${pi}`} class={`rc-line ${k === "gpuPercent" ? "rc-util-gpu" : "rc-util-mem"}`}
                                        points={pts.join(" ")} fill="none" vector-effect="non-scaling-stroke" stroke={color(ci)} stroke-width={1.5} />
                                ));
                            }))}
                        </svg>
                    </div>
                ))}
            </div>
            <div class="rc-legend">
                {cards.map((c, ci) => {
                    const u = utilOf(latest, c.id);
                    return (
                        <span class="rc-key" key={c.id}>
                            <i class="rc-swatch" style={{ background: color(ci) }} />
                            {c.name} {u?.gpuPercent != null ? `${u.gpuPercent}%` : "—"}{u?.memoryPercent != null ? ` · memory ${u.memoryPercent}%` : ""}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

/** Every card's two figures at the datapoint under the cursor — the same Grafana reading the pools tip gives,
 *  for utilization. A figure the card did not report says so rather than showing a 0. */
function UtilTip({ cards, color, at, latest, scope }: { cards: DeviceCapacity[]; color: (i: number) => string; at: ResourceSample | null; latest: ResourceSample; scope: string }) {
    const cur = cursorOn(scope);
    const { ref, style } = useTipPlacement(cur);
    if (!cur) return null;
    const frame = at ?? latest;
    const fig = (v: number | undefined) => (v != null ? `${v}%` : "not reported");
    return (
        <div class="rc-tip rc-tip-pools" role="tooltip" ref={ref} style={style}>
            <SampleStamp at={at} />
            {cards.map((c, ci) => {
                const u = utilOf(frame, c.id);
                return (
                    <div class="rc-tip-sect" key={c.id}>
                        <div class="rc-tip-row rc-tip-poolrow">
                            <span class="rc-tip-label"><i class="rc-swatch" style={{ background: color(ci) }} />{c.name}</span>
                            <span class="rc-tip-amt">GPU {fig(u?.gpuPercent)}</span>
                            <span class="rc-tip-pct">memory {fig(u?.memoryPercent)}</span>
                        </div>
                    </div>
                );
            })}
            <div class="rc-tip-note">averaged by the driver over its own window</div>
        </div>
    );
}

/** Several series in ONE track, drawn as independent lines rather than a stack: each pool is measured against
 *  its OWN ceiling, so the lines are shares of their own capacity, and one stacked ceiling would compare
 *  nothing. (How much of the whole box is in use is the `total` view's question, answered with walls.) */
function OverlayView({ def, samples, latest, hidden, events = [], onHide }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string>; events?: ResourceEvent[]; onHide?: () => void }) {
    const cap = latest.capacity!;
    // Each series is a POOL: a card, or the host. Including the host matters — a CPU-resident model holds no
    // VRAM, so a cards-only overlay makes it vanish from the chart entirely while it sits in the legend below.
    const pools = def.series.map((id) => {
        if (id === "ram" || id === "mem") {
            const c = id === "mem" ? ceilingsFor(latest, cap.devices[0]?.id ?? "") : null;
            return { id, name: id === "mem" ? `${cap.devices[0]?.name ?? "Memory"}` : "System RAM",
                     ceiling: c?.hardBytes ?? cap.host.totalBytes, bandsOf: hostBands };
        }
        const d = cap.devices.find((x) => x.id === id.replace(/^vram\./, ""));
        if (!d) return null;
        const c = ceilingsFor(latest, d.id);
        return { id, name: d.name, ceiling: c?.displayBytes ?? d.totalBytes, bandsOf: (s: ResourceSample) => deviceBands(s, d.id) };
    }).filter(Boolean) as { id: string; name: string; ceiling: number; bandsOf: (s: ResourceSample) => Band[] }[];
    if (!pools.length) return null;
    // WHAT THE ARROW KEYS STEP THROUGH HERE. Published with the colours the lines are actually drawn in, so a
    // keyboard focus lights the same key the pointer would — `poolColor` is keyed by index among ALL pools,
    // so colouring after any filtering renumbers them.
    notePools(pools.map((p, pi) => ({ ...p, color: poolColor(pi, pools.length) })));

    const runs = noteRuns(segments(samples, sampleGapMs()).filter((r) => r.length > 1));
    const usedOf = (s: ResourceSample, p: typeof pools[number]) =>
        p.bandsOf(s).filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    // Plotted as a FRACTION of each pool's own capacity. Absolute bytes on a shared axis would be a lie here:
    // 121.2 GiB of RAM and 95.59 GiB of VRAM are different denominators, so the same height would mean
    // different things per line. Relative occupancy is the comparison this view exists to make.
    const frac = (s: ResourceSample, p: typeof pools[number]) => (p.ceiling > 0 ? Math.min(1, usedOf(s, p) / p.ceiling) : 0);
    // A pool whose models you have ALL hidden reads as empty, with nothing to say it is a choice rather than
    // the truth. Dim it like the row you hid, so the selection is visible from both ends.
    const allHidden = (p: typeof pools[number]) => {
        const mine = p.bandsOf(latest).filter((b) => b.kind === "model" && b.model);
        return mine.length > 0 && mine.every((b) => hidden.has(b.model!));
    };
    const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
    const instants = useInstants(runs, events);
    return (
        <div class="rc-track">
            <div class="rc-head">
                <HideTrack onHide={onHide} label={pools.map((p) => p.name).join(" · ")} />
                <span class="rc-name">{pools.map((p) => p.name).join(" · ")}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    % of each pool
                    <span class="tt-pop wrap" role="tooltip">Each line is how full THAT pool is, as a share of its own capacity — the pools have different sizes, so absolute heights on one axis would not be comparable. Hover a line's key for the real figure.</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor("overlay")(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => {
                    hoverAt.value = null;                     // …and the same on the overlaid view
                    if (kbFocus.value || kbPool.value) return;
                    leavePool(); crosshair.value = null;
                }}>
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                <PoolsTip pools={pools.map((p, pi) => ({ ...p, color: poolColor(pi, pools.length) }))}
                    latest={latest} at={hoveredSample(runs, "overlay")} fracOf={frac} usedOf={usedOf} />
                {/* This view has rules of its own now, so it needs the tip that explains them. */}
                <EventTip scope="overlay" />
                {runs.map((run, ri) => (
                    <div class="rc-seg" key={ri} style={{ flex: `${runWeight(run)} 1 0` }}>
                        <TimeGrid runs={runs} run={run} />
                        <InstantRules instants={instants} run={ri} scope="overlay" />
                        <HoverSpan run={ri} scope="lane" />
                        {/* ONE DOT PER LINE at the snapped sample — this view is literally lines, so it is the
                            view where "snap to the line" means the most. Positioned HTML rather than an SVG
                            circle for the same reason as the stacked one: the viewBox is stretched, so a
                            circle inside it would draw as an ellipse. */}
                        {snapUnder(runs)?.run === ri && run.length ? pools
                            // COLOURED BEFORE FILTERING: `poolColor` is keyed by the pool's index among ALL
                            // pools, so filtering first renumbers them and a focused pool takes the first
                            // pool's colour.
                            .map((p, pi) => ({ p, color: poolColor(pi, pools.length) }))
                            .filter(({ p }) => !poolHover.value || poolHover.value.id === p.id)
                            .map(({ p, color }) => {
                                const i = Math.min(run.length - 1, Math.max(0, snapUnder(runs)!.index));
                                const cx = runFrac(run, run[i].t) * 100;
                                return <i key={`sd:${p.id}`} class="rc-snapdot" aria-hidden="true"
                                    style={{ left: `${cx}%`, top: `${(1 - frac(run[i], p)) * 100}%`, background: color }} />;
                            }) : null}
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {pools.map((p, pi) => {
                                const pts = run.map((s) => `${(runFrac(run, s.t) * W).toFixed(1)},${(H - frac(s, p) * H).toFixed(1)}`).join(" ");
                                // non-scaling-stroke keeps the width in DEVICE space: without it the
                                // non-uniform viewBox scale makes diagonals visibly fatter than horizontals.
                                // Two directions of the same question. Hovering this pool highlights it; and
                                // hovering a MODEL row dims every pool that model is NOT resident on, so the
                                // chart points back at the row rather than only the other way round.
                                // Switched off in the legend: no line at all, rather than a dimmed one. The
                                // point of turning a pool off is to get it out of the way of the ones you are
                                // reading, and a ghost still crosses them.
                                if (hiddenPools.value.has(p.id)) return null;
                                const holdsHovered = !!hoverModel.value && p.bandsOf(latest).some((b) => b.model === hoverModel.value);
                                const on = hoverPool.value === p.id || holdsHovered;
                                const muted = (!!hoverPool.value && hoverPool.value !== p.id)
                                    || (!!hoverModel.value && !holdsHovered)
                                    || allHidden(p);
                                return (
                                    <g key={p.id}>
                                        {/* A wide TRANSPARENT copy is the hit target: a 1.5px line is almost
                                            impossible to hover, so the visible stroke stays thin. Its width
                                            NEVER changes — it already covers the hovered stroke, so the
                                            target cannot move out from under a still pointer. */}
                                        <polyline points={pts} fill="none" stroke="transparent" stroke-width="10"
                                            vector-effect="non-scaling-stroke" class="rc-hit"
                                            onPointerEnter={(e: PointerEvent) => { enterPool({ ...p, color: poolColor(pi, pools.length) }); trackCursor("overlay")(e); }}
                                            onPointerLeave={() => leavePool()} />
                                        {/* The visible line takes NO pointer events. Painted on top of the hit
                                            target, it would take them by default — and since it THICKENS on
                                            hover, hovering near the edge put the pointer on the fat stroke,
                                            which fired pointerleave on the hit target, which thinned it again:
                                            a tooltip flickering many times a second. Only the fixed-width
                                            target decides. */}
                                        <polyline class="rc-line" points={pts} fill="none" vector-effect="non-scaling-stroke"
                                            stroke={poolColor(pi, pools.length)}
                                            stroke-width={on ? 3 : 1.5} opacity={muted ? 0.25 : 1} />
                                    </g>
                                );
                            })}
                        </svg>
                    </div>
                ))}
            </div>
            <div class="rc-legend">
                {pools.map((p, pi) => (
                    // Dimmed from BOTH ends: hovering a model dims the pools it isn't on, and hovering a pool
                    // (its line or its key) dims the other pools' keys — the legend is the list this selection
                    // is made from, so leaving it lit while the chart and the rows both react is a half answer.
                    // NO `tt` class here: this key opens the cursor-following pool tip (below), and a static
                    // popup as well meant two tooltips for one hover. The pool tip carries the same figure
                    // plus what is resident, so the static one had nothing left to add.
                    // CLICK toggles the line, the way clicking a series in Grafana does — and the way a model
                    // row already works here. Two different "off" states share the styling deliberately: a
                    // pool you switched off, and one whose models you have ALL hidden, both read as a line
                    // that is absent by choice rather than by measurement.
                    <span class={`rc-key${(hoverModel.value && !p.bandsOf(latest).some((b) => b.model === hoverModel.value))
                            || (hoverPool.value && hoverPool.value !== p.id) ? " away" : ""}${allHidden(p) || hiddenPools.value.has(p.id) ? " off" : ""}`} key={p.id}
                        role="button" tabIndex={0} aria-pressed={!hiddenPools.value.has(p.id)}
                        aria-label={hiddenPools.value.has(p.id) ? `Show ${p.name}` : `Hide ${p.name}`}
                        onClick={() => togglePool(p.id)}
                        onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePool(p.id); } }}
                        onPointerEnter={(e: PointerEvent) => { enterPool({ ...p, color: poolColor(pi, pools.length) }); trackCursor("overlay")(e); }} onPointerLeave={() => leavePool()}>
                        <i class="rc-swatch" style={{ background: poolColor(pi, pools.length) }} />
                        {p.name} {pct(frac(latest, p))}
                    </span>
                ))}
            </div>
        </div>
    );
}

/** The panel's tracks, from the chosen LAYOUT. A layout is just `TrackDef[]`; a preset is a named starting
 *  point for it (see `presetsFor`), and editing one is the same operation on the same state. */
/** A composite span's fill: hard stops at each phase boundary. The model's own colour for the work it did
 *  (the same one its row and bands carry, so the lane reads against the model list with no legend of its
 *  own), a hatched neutral for the human's wait, and a paler wash of the model colour for the tool. */
/** The fill for a LOAD span: diagonal stripes of the model's own colour against the panel. Waiting for a model
 *  to arrive is not the model working, so it must not look like a solid block of its time — but it IS that
 *  model's wait, so the colour stays. (A plain model-coloured bar is what the inline colouring made of it,
 *  which is exactly the confusion the stripes exist to prevent.) */
/** The server's own words for an edge, with the model's name taken off the front — the name is already the
 *  line above, and repeating it costs the width the REASON needs (`evicted (made room)` against
 *  `unloaded (idle)`, which is the whole difference between the two things polling reads as one). */
function serverSaid(label: string, model?: string): string {
    const rest = model && label.startsWith(model) ? label.slice(model.length).trim() : label;
    return rest ? `the server reported this — ${rest}` : "reported by the server";
}

/** A phase's swatch, matching its stripe in the bar exactly — so the tooltip's sections and the block's parts
 *  are visibly the same three things, rather than a list you have to map onto a picture yourself. */
// THREE STRIPE PATTERNS THAT DIFFER IN DIRECTION, NOT IN WEIGHT. A load, its weights half and its context
// half were all 45° stripes in the model's colour, separated only by opacity — which is legible in a 200px
// bar and not at all in a 10px tooltip swatch, so the tooltip listed three rows with what read as the same
// glyph three times. Direction survives being tiny:
//
//   load (the whole thing)  ▨  crosshatch — it IS both halves, so it is both leans
//   moving the weights in   ╱  leaning one way
//   allocating the context  ╲  leaning the other
//
// Which also fixes the bar: a load's two halves were told apart by a divider and a shade, and the shade did
// almost none of the work.
const loadStripes = (model?: string): string => {
    const c = model ? colorFor(model) : "var(--warn, #f59e0b)";
    // Two layers: the first leans one way over a transparent gap, the second the other way over the panel's
    // ground, so what shows through the first is the second rather than whatever is behind the element.
    return `repeating-linear-gradient(45deg, ${c} 0 2px, transparent 2px 7px), `
        + `repeating-linear-gradient(-45deg, ${c} 0 2px, var(--panel) 2px 7px)`;
};
/** One half of a load: same colour, opposite leans, so the two are told apart by DIRECTION at any size. */
const halfStripes = (c: string, lean: 45 | -45): string =>
    `repeating-linear-gradient(${lean}deg, ${c} 0 3px, var(--panel) 3px 8px)`;

const phaseFill = (kind: string, model?: string): string => {
    const base = model ? colorFor(model) : "var(--accent)";
    // The model's channels share its colour and differ in WEIGHT, because they are the same model doing the
    // same work — answering is the payload, so it keeps the full colour; thinking and emitting a tool call
    // are lighter. The dividers between them are what makes the split legible; the fills only rank it.
    return kind === "model" || kind === "answer" ? base
        : kind === "think" ? `color-mix(in srgb, ${base} 62%, transparent)`
        : kind === "call" ? `color-mix(in srgb, ${base} 30%, transparent)`
        : kind === "wait" ? "color-mix(in srgb, var(--fg-faint) 45%, transparent)"
        // Time that is NOT the tool and NOT the machine's work: the network getting there and back, and the
        // far end queueing before it started. Both borrow the neutral the approval wait uses rather than the
        // model's colour, because neither is the model or the tool doing anything — `net` fainter still,
        // since it is the one figure we DERIVE by subtraction rather than being told.
        // Plumbing between the model finishing and the tool starting. The faintest of the neutrals: it is
        // ours, it is usually milliseconds, and it exists mainly so the block sits where the work did.
        : kind === "dispatch" ? "color-mix(in srgb, var(--fg-faint) 20%, transparent)"
        : kind === "net" ? "color-mix(in srgb, var(--fg-faint) 26%, transparent)"
        : kind === "queue" ? "color-mix(in srgb, var(--fg-faint) 38%, transparent)"
        // A COLD START is a wait, like a model load — so it is STRIPED for the same reason: a wide flat block
        // reads as a lot of work having happened, and none of this is work you asked for. Neutral rather than
        // the model's colour, since it is the sandbox arriving and not the model.
        : kind === "boot" ? "repeating-linear-gradient(45deg, color-mix(in srgb, var(--fg-faint) 34%, transparent) 0 3px, var(--panel) 3px 8px)"
        // A LOAD's two halves. Both are the model arriving, so both are its colour — but the first is the
        // weights moving (dense, and where the memory trace actually steps) and the second is the context
        // being allocated before it will serve. Striped either way, because a load is a wait rather than
        // work; they LEAN OPPOSITE WAYS, because a difference in shade alone is invisible in a swatch and
        // nearly invisible in a thin bar (see loadStripes).
        // A GENERATION's halves, by weight of the model's own colour like its channels: prefill is the dense
        // one (the whole prompt read at once), decode lighter. The same two weights the KV fill uses, so a
        // lane span and the cache it filled read as one legend. The remainder around them is not the model
        // doing either, so it takes the faintest neutral, like dispatch.
        : kind === "prefill" ? base
        : kind === "decode" ? `color-mix(in srgb, ${base} 55%, transparent)`
        : kind === "other" ? "color-mix(in srgb, var(--fg-faint) 20%, transparent)"
        // A PROMPT-CACHE SWAP: memory being copied for this model before it can read the prompt — a wait, like a
        // load, so it is striped the way a load is, in a lighter weight of the model's colour.
        : kind === "swap" ? halfStripes(`color-mix(in srgb, ${base} 45%, transparent)`, 45)
        : kind === "weights" ? halfStripes(base, 45)
        : kind === "context" ? halfStripes(`color-mix(in srgb, ${base} 55%, transparent)`, -45)
        : `color-mix(in srgb, ${base} 38%, transparent)`;
};


/** Each phase as a [start, end] FRACTION of the block. Phases carry only their end, so a start is the
 *  previous end — which every consumer would otherwise re-derive, and one of them would get wrong. */
function phaseSpans(phases: { kind: string; until: number }[], from: number, total: number) {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    let at = 0;
    return phases.map((ph) => {
        const end = clamp((ph.until - from) / total);
        const span = { kind: ph.kind, start: at, end };
        at = end;
        return span;
    });
}

function phaseGradient(phases: { kind: string; until: number }[], from: number, total: number, model?: string): string {
    const fill = (kind: string) => phaseFill(kind, model);
    const stops: string[] = [];
    // A HAIRLINE between phases, in the panel's own colour so it reads as a cut rather than a fourth colour.
    // Fills alone don't do it: think and call are the same hue at different weights, and two adjacent weights
    // of one colour read as a gradient, not a boundary. Placed in px via calc so it stays one pixel whether
    // the block is 4% or 40% of the lane.
    let at = "0%";
    for (const [i, ph] of phases.entries()) {
        const end = `${Math.min(100, Math.max(0, ((ph.until - from) / total) * 100))}%`;
        if (i > 0) { stops.push(`var(--panel) ${at} calc(${at} + 1px)`); at = `calc(${at} + 1px)`; }
        stops.push(`${fill(ph.kind)} ${at} ${end}`);
        at = end;
    }
    return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** The instants to rule through a plot, placed against its own segments. Shared, because writing them inline
 *  in one view is exactly how the Overview preset ended up with no rules at all while the per-pool tracks had
 *  them: the same events, drawn in one place and not the other. */
function useInstants(runs: ResourceSample[][], events: ResourceEvent[]): EventPlacement[] {
    return useMemo(() => {
        const from = runs[0]?.[0]?.t ?? 0, to = runs.at(-1)?.at(-1)?.t ?? 0;
        // The moments themselves, plus a server-split load's two internal edges (`loadEdges`) — the steps in the
        // memory trace a load draws, which otherwise had nothing on the plot saying what they were.
        const moments = [...events.filter((e) => e.until == null), ...events.flatMap(loadEdges)];
        return placeEvents(runs, eventsIn(moments, from, to + sampleGraceMs()), sampleGraceMs());
    }, [runs, events]);
}

/** The dashed rules themselves — an eviction is a moment in the memory trace, and its meaning is WHERE the
 *  curve steps, so it belongs on the plot rather than in the lane below. */
function InstantRules({ instants, run, scope }: { instants: EventPlacement[]; run: number; scope: string }) {
    return <>{instants.filter((p) => p.run === run).map((p, k) => (
        // Keyed by the EVENT, not the element: the same eviction is drawn in every track, so hovering it in
        // one plot thickens it in all of them — one thing that happened, not three.
        <div class={`rc-rule rc-rule-${p.event.kind}${eventKey(p.event) === hotEvent.value ? " hot" : ""}`}
            key={k}
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

/** The SCRUB strip: the whole session compressed into one bar, with a box showing which slice the chart above
 *  is drawing. Drag the box to move through the session; drag it back to the right edge — or press the live
 *  button — to re-pin to the tail.
 *
 *  Its own axis is LINEAR in time, unlike the chart's: this is an overview, and a ten-minute hole is a fact
 *  about the session that an overview should show at its true width rather than collapse. The runs are drawn
 *  as filled blocks with the gaps left empty, so "nothing was measured here" reads as a hole. */
/**
 * Apply a scrubbed window — and REJOIN LIVE when it reaches the tail.
 *
 * A pinned window that merely happens to sit at the end is not the same as following: new samples arrive,
 * the window stays where it was pinned, and the view silently falls behind while the button still reads
 * live (which is computed from where the window sits, not from whether it is following). The drag path has
 * always done this on release; the wheel paths did not, so scrolling to the end looked like rejoining live
 * and then drifted away from it.
 */


/** Persisting `resWindowS` on every frame of a continuous gesture would write to storage dozens of times for
 *  one pinch, so the value is applied live and only the WRITE is deferred to the end of the gesture. */
let windowWrite: ReturnType<typeof setTimeout> | null = null;

/**
 * Settle ANY gesture that moved or resized the window — the one place the "did this rejoin live" rule lives,
 * so a wheel, a pinch and a drag cannot disagree about what "at the tail" means.
 *
 * The wheel paths used to have their own version of it, which nulled the zoom and nothing else — so scrolling
 * a NARROW window back to the tail rejoined live at whatever `resWindowS` last held, and a window you had
 * carefully narrowed sprang back to five minutes on arrival. The drag had been fixed for exactly that and
 * this was the same bug surviving in the gesture beside it, which is the argument for there being one
 * function rather than two.
 *
 * Following with a width is not a special case of a pinned range: it IS `resWindowS`, the quantity Settings
 * names. So zooming while live changes how much history is drawn and STAYS live, rather than pinning the
 * window at wherever it happened to be when you pinched — which would have made the gesture a way to
 * accidentally stop following.
 */
function settleScrub(next: { from: number; to: number }, ex: { from: number; to: number }): void {
    const intent = scrubIntent(ex, next, TAIL_SLACK_MS);
    if (!intent.live) { zoomRange.value = intent.window; return; }
    resWindowS.value = intent.windowS;
    zoomRange.value = null;
    if (windowWrite) clearTimeout(windowWrite);
    windowWrite = setTimeout(() => {
        windowWrite = null;
        try { chrome.storage.local.set({ [RESWIN_KEY]: resWindowS.value }); } catch { /* opaque origin */ }
    }, 400);
}

function ScrubStrip({ samples, window: win, events = [] }: { samples: ResourceSample[]; window: { from: number; to: number } | null; events?: ResourceEvent[] }) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    // Where the TRACK sits inside the strip, as percentages of the strip — the connector below is drawn in
    // the strip's coordinates but its top ends belong to the track's, and the two differ by the live button.
    const [geom, setGeom] = useState<{ left: number; width: number } | null>(null);
    useLayoutEffect(() => {
        const w = wrapRef.current, t = trackRef.current;
        if (!w || !t) return;
        const wb = w.getBoundingClientRect(), tb = t.getBoundingClientRect();
        if (!(wb.width > 0)) return;
        const next = { left: ((tb.left - wb.left) / wb.width) * 100, width: (tb.width / wb.width) * 100 };
        setGeom((v) => (v && Math.abs(v.left - next.left) < 0.2 && Math.abs(v.width - next.width) < 0.2 ? v : next));
    });
    const ex = scrubExtent(samples, win);
    if (!ex || !win) return null;   // nothing to scrub: the window already covers the session
    const span = ex.to - ex.from;
    const runs = segments(samples, sampleGapMs());
    // WHERE you grabbed decides what the drag does, which is the vocabulary every timeline control uses:
    // the middle pans, an edge resizes. Recentring on the cursor wherever it lands is what made the window
    // impossible to widen once it had been narrowed — every grab was a pan, including a grab on a handle.
    const drag = (e: PointerEvent) => {
        if (e.button !== 0) return;
        const el = e.currentTarget as HTMLElement;
        const box = el.getBoundingClientRect();
        const at = (x: number) => Math.min(1, Math.max(0, (x - box.left) / Math.max(1, box.width)));
        // The window at the moment of the grab. A resize reads from THIS rather than from the live signal, so
        // the fixed edge stays fixed instead of drifting as each move rewrites the range it is measured from.
        const start = { ...win };
        const zone = scrubZone(ex, at(e.clientX), box.width);
        // The window the drag LANDED on. While dragging, the box simply follows the pointer; what the
        // gesture MEANT is decided once, on release — a mid-drag decision would rejoin live the moment you
        // passed the tail and yank the box out from under you.
        let landed: { from: number; to: number } | null = null;
        // A DRAG THAT HAS GONE QUIET IS OVER — but not before it has begun. `buttons === 0` on a move is the
        // backstop for a `pointerup` that never arrived, and reading it on the FIRST move lets one event with
        // an unset button field end the gesture before it starts: the window is then settled at wherever the
        // pointerdown put it, which looks exactly like a drag that did nothing rather than like one that was
        // cancelled. So it takes one move with the button confirmed down first; a release that genuinely
        // happened before any move still arrives as `pointerup`, which is the real end and always was.
        let held = false;
        const move = (ev: PointerEvent) => {
            if (ev.buttons === 0 && ev.type === "pointermove") { if (held) return up(); return; }
            held = true;
            landed = zone === "from" || zone === "to"
                ? scrubResize(ex, start, zone, at(ev.clientX))
                : scrubTo(ex, win, at(ev.clientX));
            zoomRange.value = landed;
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            // What the gesture meant is decided HERE, by pure logic in resource-model.
            const intent = landed && scrubIntent(ex, landed, TAIL_SLACK_MS);
            if (!intent) return;
            if (!intent.live) { zoomRange.value = intent.window; return; }
            // A width dragged while following is a PREFERENCE, like the one in Settings — the same quantity,
            // reached the other way — so it is remembered rather than lost on the next mount.
            resWindowS.value = intent.windowS;
            chrome.storage.local.set({ [RESWIN_KEY]: intent.windowS });
            zoomRange.value = null;

        };
        move(e);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    return (
        <div class="rc-scrub" ref={wrapRef}>
            <div class={`rc-scrub-track${scrubGrab.value ? ` z-${scrubGrab.value}` : ""}`} ref={trackRef} onPointerDown={drag}
                // Scrolling over the strip PANS the window, never resizes it — the same thing dragging its
                // middle does, and the same mapping the chart uses, so one gesture means one thing on both
                // surfaces. Resizing stays a deliberate grab on a handle: a wheel has no way to say which
                // edge it meant.
                onWheel={(ev: WheelEvent) => {
                    const b = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                    // A PINCH names a CENTRE, not an edge, which is why it belongs here where a wheel-resize
                    // does not: the objection above is that a wheel cannot say which edge it meant, and a
                    // pinch does not have to. It is also the surface a person reaches for to change the range,
                    // since it is the one drawing the range.
                    if (ev.ctrlKey) {
                        if (!ev.deltaY) return;
                        // The strip's x is a fraction of the WHOLE SESSION and linear in time; `scrubPinch`
                        // anchors on a fraction of the WINDOW. So resolve the instant under the pointer and
                        // ask where that sits inside the window — which also gives the right degenerate:
                        // pinching outside the window clamps to its nearer edge rather than teleporting it.
                        const at = ex.from + ((ev.clientX - b.left) / Math.max(1, b.width)) * (ex.to - ex.from);
                        const within = (at - win.from) / Math.max(1, win.to - win.from);
                        settleScrub(scrubPinch({ from: ex.from, to: ex.to }, win, ev.deltaY, within), ex);
                        ev.preventDefault();
                        ev.stopPropagation();
                        return;
                    }
                    const by = wheelScrubFraction(ev.deltaX, ev.deltaY, ev.deltaMode, b.width);
                    if (!by) return;
                    settleScrub(scrubNudge({ from: ex.from, to: ex.to }, win, by), ex);
                    ev.preventDefault();
                    ev.stopPropagation();
                }}
                onPointerMove={(ev: PointerEvent) => {
                    // The cursor is the only thing that says a handle is there before you try to use it.
                    const b = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                    scrubGrab.value = scrubZone(ex, Math.min(1, Math.max(0, (ev.clientX - b.left) / Math.max(1, b.width))), b.width);
                }}
                onPointerLeave={() => (scrubGrab.value = null)}>
                {runs.map((run, i) => {
                    const a = (run[0].t - ex.from) / span, b = (run.at(-1)!.t - ex.from) / span;
                    return <div class="rc-scrub-run" key={i}
                        style={{ left: `${a * 100}%`, width: `${Math.max(0.4, (b - a) * 100)}%` }} />;
                })}
                {/* WHERE the work is, so scrubbing is aimed rather than swept: the strip is the only view of
                    the whole session, and without this it says which stretch you are looking at but nothing
                    about which stretch is worth looking at. Carries each event's model colour, the same one
                    its lane bar and its row already use. Runs are skipped — a run spans everything, so a tick
                    for it would just be a wash across the strip. */}
                {/* OVERLAP, not containment. Filtering on the start dropped every event that began before the
                    first sample — and the panel only samples while it is open, so a run started before you
                    looked lost exactly its opening steps, leaving the strip blank on the left while the lane
                    below still drew them. Clamped into the strip instead, so a span that began earlier starts
                    at the edge rather than disappearing. */}
                {events.filter((e) => e.kind !== "run" && (e.until ?? e.t) >= ex.from && e.t <= ex.to).map((e, i) => {
                    // A SPAN, not a tick. Drawing every event at its start made a step that ran for seconds
                    // look identical to an instant, so a busy stretch read as two hairlines instead of as the
                    // block of activity it was. A genuine instant (an eviction) still gets a minimum width so
                    // it stays visible.
                    const from = Math.max(0, (e.t - ex.from) / span);
                    const to = Math.min(1, ((e.until ?? e.t) - ex.from) / span);
                    return (
                        <i class="rc-scrub-ev" key={i}
                            style={{ left: `${from * 100}%`, width: `${Math.max(0.35, (to - from) * 100)}%`,
                                     ...(e.model ? { background: colorFor(e.model) } : {}) }} />
                    );
                })}
                <div class="rc-scrub-win" style={{ left: `${ex.windowFrom * 100}%`,
                    width: `${Math.max(1, (ex.windowTo - ex.windowFrom) * 100)}%` }} />
            </div>
            {/* Says which state you are in, and is the way back. A view that has silently stopped following
                live is the failure this prevents. */}
            {/* The icon slot is ALWAYS filled — playing or paused. An icon present in only one state changes
                the button's width, so the control jumped every time the view left or rejoined live, which is
                exactly the moment you are looking at it. */}
            <button class={`rc-scrub-live${ex.atTail ? " on" : ""}`} title={ex.atTail ? "Following new samples" : "Jump back to live"}
                onClick={() => (zoomRange.value = null)}>
                <span class="rc-live-icon" aria-hidden="true">{ex.atTail ? "▶" : "⏸"}</span>live
            </button>
            {/* Two lines from the window's edges down to the LANE's, so the magnification between them is
                visible. The strip and the lane are different axes and can never line up — the strip is linear
                across the whole session with the window as a sub-range, the lane is only that window spread
                across the full width — and side by side with nothing joining them that reads as two views
                disagreeing rather than as one being the other, opened out.

                The top ends are in the TRACK's coordinates and the bottom ends in the panel's: the track is
                inset by the live button, so drawing both in one space put every line beside the box it was
                supposed to touch. Hence the measurement. And with the lane HIDDEN there is nothing at the
                other end, so lines pointing into empty space are worse than none. */}
            {geom && laneEnabled.value && showLane.value ? (
                <svg class="rc-zoomlink" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                    {/* S-curves, not straight diagonals: each arm leaves the window edge going straight DOWN
                        and arrives at the lane edge going straight down too. A straight line from a window
                        sitting mid-strip cuts across at an arbitrary angle and reads as a stray rule; a curve
                        that starts and ends vertically reads as the selection widening into the view below. */}
                    <path d={`M ${geom.left + ex.windowFrom * geom.width} 0 C ${geom.left + ex.windowFrom * geom.width} 6, 0 4, 0 10`}
                        vector-effect="non-scaling-stroke" />
                    <path d={`M ${geom.left + ex.windowTo * geom.width} 0 C ${geom.left + ex.windowTo * geom.width} 6, 100 4, 100 10`}
                        vector-effect="non-scaling-stroke" />
                </svg>
            ) : null}
        </div>
    );
}

/** The crosshair, mirrored into every track: a line where the pointer is, and the instant it names. Reading
 *  one pool against another at a given moment is the whole reason these are small multiples, and doing it by
 *  eye across three plots is exactly what a shared line removes. */
function Crosshair({ runs }: { runs?: ResourceSample[][] } = {}) {
    const c = crosshair.value;
    if (!c) return null;
    if (eventHover.value) return null;   // the rule you are pointing at is the mark — see snapUnder
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

/** Track the pointer along the time axis. The fraction positions the line; the TIME comes from the same
 *  segmented mapping the brush uses, because the axis is not linear and a label read off the pixels would
 *  name the wrong instant. */
const trackCrosshair = (runs: ResourceSample[][]) => (e: PointerEvent) => {
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
    const first = runs[0]?.[0]?.t, last = runs.at(-1)?.at(-1)?.t;
    const msPerPx = first != null && last != null && box.width > 0 ? (last - first) / box.width : Infinity;
    // The TIME comes from the unsnapped position when floating and from the snapped one when not, so the
    // label always names the instant the line is actually drawn at.
    crosshair.value = { frac, t: timeAtFraction(runs, frac), msPerPx };
};

/** The hovered EVENT's stretch, shaded on the plot above it. The lane and the chart share an axis and that
 *  is the whole point of the panel — "did that forty-second turn spend its time loading a model, or was the
 *  model already there" — but reading a block against the trace meant eyeballing two x positions a couple of
 *  rows apart. This says it: hover a block, and the memory that was measured WHILE it ran is picked out.
 *
 *  Drawn inside its own SEGMENT, exactly like the block is, because the axis is segmented by gaps and is not
 *  linear in time — a fraction of the whole plot would land somewhere else entirely. Carries the model's
 *  colour so the shade and the block are visibly the same thing, and disappears with the hover. */
function HoverSpan({ run, scope }: { run: number; scope: string }) {
    const h = eventHover.value;
    if (!h || h.scope !== scope || h.p.run !== run) return null;
    const { from, to } = h.p;
    // An INSTANT has no width; the dashed rule already marks it, and a zero-width shade would be a hairline
    // competing with it.
    if (!(to > from)) return null;
    const e = h.p.event;
    return <div class="rc-hoverspan" style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%`,
        ...(e.model ? { "--model": colorFor(e.model) } : {}) }} />;
}

/** The selection, mirrored. Every track draws the same fractions, so a drag on ONE plot is visibly a drag on
 *  the whole chart — the ranges only mean anything compared across pools. */
function BrushOverlay({ runs }: { runs?: ResourceSample[][] } = {}) {
    const b = brush.value;
    if (!b) return null;
    // SNAPPED AT RENDER, from the RAW screen fractions the drag stored — the same rule, and for the same
    // reason, as the mark (`snapUnder`). A fraction is a fact about the sample COUNT when it was taken, so an
    // edge resolved once drifts off the dot it was dragged against the moment a poll lands: measured a whole
    // sample apart (a box edge at 0.600 beside a mark at 0.500). Both now answer "which sample is under this
    // screen position" from the same data at the same instant, which is the only way they cannot disagree.
    const at = (f: number) => (snapDot.value && runs ? snapFraction(runs, f)?.frac ?? f : f);
    const from = Math.min(at(b.from), at(b.to)), to = Math.max(at(b.from), at(b.to));
    return <div class="rc-brush" style={{ left: `${from * 100}%`, width: `${Math.max(0, to - from) * 100}%` }} />;
}

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
let liveRuns: ResourceSample[][] | null = null;
/** Publish the runs a plot is about to draw, for the pointer handlers. Call it from a render, not an effect:
 *  a drag begun in the same frame must not consult the previous one's data. */
const noteRuns = (runs: ResourceSample[][]): ResourceSample[][] => (liveRuns = runs);

/** Drag across a plot to select a time range (and release to apply it). The fractions are mapped back to TIME
 *  through the same segmented geometry events are placed with — the axis is not linear, so a range read off
 *  the pixels alone would select a different stretch than the one under the pointer. */
const startBrush = (runs: ResourceSample[][]) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = (e.currentTarget as HTMLElement);
    const box = el.getBoundingClientRect();
    const raw = (x: number) => Math.min(1, Math.max(0, (x - box.left) / Math.max(1, box.width)));
    /**
     * THE SELECTION SNAPS TOO, when snapping is on.
     *
     * A box drawn to free fractions beside a crosshair that lands on datapoints is the panel using two
     * different rules for "where the pointer is" at once, and you can see it: the edges sit between the dots
     * they were dragged against. It is also the more honest range — the edges are then real MEASUREMENTS
     * rather than instants interpolated between two polls, which is the same reason the tooltip refuses to
     * interpolate.
     *
     * Resolved live rather than captured, like the crosshair: a drag can outlast a poll, and a fraction is a
     * fact about the sample count at the instant it was taken.
     */
    /** The INSTANT an edge means, read from the FRESHEST runs there are — a drag can outlast several polls,
     *  and the array this handler closed over stopped being current the moment the first one landed.
     *  Snapped, it is the sample's own stamp, not the axis position read back through `timeAtFraction`,
     *  which would interpolate the very value the snap exists to avoid. */
    const timeAt = (x: number) => {
        const rs = liveRuns ?? runs;
        if (snapDot.value) {
            const s = snapFraction(rs, raw(x));
            const t = s ? rs[s.run]?.[s.index]?.t : null;
            if (t != null) return t;
        }
        return timeAtFraction(rs, raw(x));
    };
    const startX = e.clientX;
    // RAW screen fractions, snapped where they are DRAWN (BrushOverlay) — see there. Storing the snapped
    // value here is what made the box a claim about a sample count that had already changed.
    const start = raw(startX);
    let moved = false;
    brush.value = { from: start, to: start };
    const move = (ev: PointerEvent) => {
        if (ev.buttons === 0) return up(ev);
        moved = true;
        brush.value = { from: start, to: raw(ev.clientX) };
    };
    const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        brush.value = null;
        // A CLICK is not a selection: without this every click on the chart would zoom to an instant. Measured
        // on the RAW positions, because snapped they can collapse onto the same datapoint — which is a real
        // drag across less than one sample, not a click, and the result guard below is what refuses it.
        if (!moved || Math.abs(raw(ev.clientX) - raw(startX)) < 0.01) return;
        const [ta, tb] = [timeAt(startX), timeAt(ev.clientX)];
        if (ta == null || tb == null) return;
        const a = Math.min(ta, tb), b = Math.max(ta, tb);
        // …and neither is a selection that rounds to nothing. The fraction guard above is about the GESTURE
        // (did the hand move); this is about the RESULT, and they are not the same test: the axis is
        // segmented, so a perfectly deliberate drag across a densely-sampled stretch can still resolve to a
        // window of a few milliseconds — which draws as an empty plot and reads as the panel breaking.
        const win = clampWindow({ from: a, to: b });
        if (win) zoomRange.value = win;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
};

/** One event's identity across surfaces: the same eviction is drawn in every track, so hovering it anywhere
 *  must highlight it everywhere. Its time and what it was are enough to identify it. */
const eventKey = (e: ResourceEvent): string => `${e.kind}:${e.t}:${e.model ?? ""}`;
const hotEvent = signal<string | null>(null);

/** The hovered event, and WHICH surface owns it. Every track's plot renders a tip (a ruled instant is hovered
 *  in the plot, where its meaning is) and so does the lane — all driven by this one signal, so without an
 *  owner every one of them rendered the same tooltip at once, four deep on a three-track panel. */
const eventHover = signal<{ p: EventPlacement; scope: string } | null>(null);

/** "local (ollama)" or "cloud" for a model, or "" when the server never told us. Provenance comes from the
 *  ollama id list; without it an absence is not evidence of anything, so nothing is said. */
function modelWhere(model: string): string {
    const ollama = ollamaIds.value;
    if (!ollama) return "";
    return ollama.includes(model) ? "local · ollama" : (models.value.includes(model) ? "cloud" : "");
}

/** THE CACHE A GENERATION LEFT, as a bar in its lane tooltip — the same four textures as the drilled-in fill
 *  (`KvFill`), so it reads in EVERY preset, including Overview, whose pool lines have no cache part to fill.
 *  Left to right: reused (dotted), computed (dense), decoded (light), then the reserved remainder. The figure
 *  beside it is tokens against the cache's token capacity, never bytes. */
function KvBar({ gen, ctx, model }: { gen: NonNullable<ResourceEvent["gen"]>; ctx: NonNullable<ResourceEvent["genCtx"]>; model?: string }) {
    const f = kvFill(gen, ctx.contextTokens, ctx.slots);
    if (!f) return null;
    const cap = ctx.contextTokens * Math.max(1, ctx.slots);
    const held = (gen.promptTokens ?? 0) + (gen.decoded ?? 0);
    const layers = (f.prompt != null ? [{ k: "prompt", share: f.prompt }]
        : [{ k: "cached", share: f.cached ?? 0 }, { k: "computed", share: f.computed ?? 0 }]).concat([{ k: "decoded", share: f.decoded }]);
    return (
        <div class="rc-tip-kv sep">
            <div class="rc-tip-line">
                <span class="rc-tip-name">in the KV cache after this turn</span>
                <span class="rc-tip-size">{Math.min(held, cap).toLocaleString()} of {cap.toLocaleString()} tokens ({percentOf(Math.min(held, cap), cap)})</span>
            </div>
            <div class="rc-kvbar" style={model ? { "--model": colorFor(model) } : undefined} aria-hidden="true">
                {layers.map((l) => <i key={l.k} class={`rc-kvfill-${l.k}`} style={{ width: `${l.share * 100}%` }} />)}
            </div>
            {f.overflow ? <div class="rc-tip-note warn">More tokens than the cache holds — the context shifted, and older tokens were dropped to make room.</div> : null}
        </div>
    );
}

/** What a PROMPT-CACHE SWAP did, beside its duration: whether THIS conversation came back from RAM (the cache
 *  working — a near-total cache hit follows) or was not there (a full prefill follows), what was moved out, and
 *  what was thrown away to make room. An eviction is the one said as a warning: a conversation dropped from RAM
 *  pays a full prefill next time, and when two conversations take turns on one model under a limit too small for
 *  both, every turn evicts the one about to be needed — the thrash, which shows up as exactly this chip on turn
 *  after turn. */
/**
 * WHAT THE PREDICTOR EXPECTED, AGAINST WHAT THE LOAD TOOK — a load tooltip's section for whoever is tuning the
 * predictor, shown only with `predictView` on (the chart's gear).
 *
 * Every difference is taken against `forLoad`, the figure placement fits against; the bare `predicted` is
 * shown beside it but measuring the load against it makes the predictor look ~15% low for a reason that is not
 * an error. The PEAK is the row that decides whether a fit was safe — VRAM overshoots where it settles during a
 * load — so it leads. A load that took MORE than predicted is the dangerous direction and is flagged; less is
 * merely wasteful. Weights and KV are compared term by term and never summed: the prediction's split is the
 * metadata model's and covers only those two.
 */
function PredictionRows({ e }: { e: ResourceEvent }) {
    const est = e.estimate;
    if (!est) return <div class="rc-tip-line sep"><span class="rc-tip-name">no prediction received for this load</span></div>;
    const target = est.forLoad ?? est.predicted;
    const trace = loadTrace(resourceHistory.value, e);
    const diff = (bytes: number, against: number) => {
        const d = bytes - against, pct = against > 0 ? Math.round((d / against) * 100) : null;
        return <span class={`rc-chip ${d > 0 ? "rc-chip-warn" : "rc-chip-dim"}`}>
            {d >= 0 ? "+" : "−"}{formatBytes(Math.abs(d))}{pct != null ? ` (${d >= 0 ? "+" : ""}${pct}%)` : ""}</span>;
    };
    const basis = trace?.basis === "runner" ? "the runner's own memory" : "the cards' growth over their level before the load";
    return (
        <>
            <div class="rc-tip-line sep">
                <span class="rc-tip-name">predicted, for placement</span>
                <span class="rc-tip-size">{formatBytes(target)}</span>
            </div>
            <div class="rc-tip-chips">
                {est.source ? <span class="rc-chip">{est.source}</span> : null}
                {est.forLoad != null && est.forLoad !== est.predicted ? <span class="rc-chip rc-chip-dim">{formatBytes(est.predicted)} before the batch surcharge</span> : null}
                {est.numCtx != null ? <span class="rc-chip rc-chip-dim">num_ctx {est.numCtx.toLocaleString()}</span> : null}
                {est.numBatch != null ? <span class="rc-chip rc-chip-dim">num_batch {est.numBatch.toLocaleString()}</span> : null}
                {est.metadataComplete === false ? <span class="rc-chip rc-chip-dim">metadata incomplete</span> : null}
            </div>
            {trace?.peak ? <div class="rc-tip-line"><span class="rc-tip-name">peak during the load</span>{diff(trace.peak.bytes, target)}<span class="rc-tip-size">{formatBytes(trace.peak.bytes)}</span></div> : null}
            {trace?.final ? <div class="rc-tip-line"><span class="rc-tip-name">settled at</span>{diff(trace.final.bytes, target)}<span class="rc-tip-size">{formatBytes(trace.final.bytes)}</span></div> : null}
            {e.loadBytes != null ? <div class="rc-tip-line"><span class="rc-tip-name">resident, as the server counts it</span>{diff(e.loadBytes, target)}<span class="rc-tip-size">{formatBytes(e.loadBytes)}</span></div> : null}
            {est.weights != null && e.measured ? <div class="rc-tip-line"><span class="rc-tip-name">weights: {formatBytes(est.weights)} predicted</span>{diff(e.measured.weights, est.weights)}<span class="rc-tip-size">{formatBytes(e.measured.weights)}</span></div> : null}
            {est.kvCache != null && e.measured ? <div class="rc-tip-line"><span class="rc-tip-name">KV cache: {formatBytes(est.kvCache)} predicted</span>{diff(e.measured.kvCache, est.kvCache)}<span class="rc-tip-size">{formatBytes(e.measured.kvCache)}</span></div> : null}
            {trace ? <div class="rc-tip-note">peak and settled are {basis}{trace.basis === "device" ? " — an eviction making room at the same time reads as negative growth" : ""}. The weights/KV split is the metadata model's, whatever the source.</div> : null}
        </>
    );
}

/**
 * WHERE THE PREDICTOR SAID A LOAD WOULD LAND, on the card it landed on: a dashed line at the card's used memory
 * before the load plus the placement figure, across the load. The gap between the line and where the band
 * settles IS the prediction's error, read without a tooltip — and the overshoot above it during the load is the
 * part a fit has to budget for. Drawn only for a load on exactly ONE card: the prediction is a whole-model
 * figure, and dividing it between cards would be pro-rating, which this panel never does.
 */
function PredictLines({ run, loads, deviceId, ceiling }: { run: ResourceSample[]; loads: ResourceEvent[]; deviceId: string; ceiling: number }) {
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

/**
 * THE TIME GRID: faint vertical lines at round clock intervals through a plot, behind the gear's "time grid"
 * (off by default). The axis is linear in time within a run, and even spacing is what makes that visible; at a
 * gap the runs collapse and the spacing visibly restarts. Every plot draws the SAME step, derived from the same
 * runs, so the lines of stacked tracks line up. Vertical only: memory gridlines would mean a different amount on
 * every card, each having its own ceiling.
 */
function TimeGrid({ runs, run }: { runs: { t: number }[][]; run: { t: number }[] }) {
    if (!timeGrid.value || run.length < 2) return null;
    const step = gridStep(runs.reduce((n, r) => n + runWeight(r), 0));
    // The spacing, said once per plot (in its last segment): a grid whose interval you have to work out by
    // counting lines against the crosshair's clock is half a reading aid. A round interval, so round words.
    const label = step < 60_000 ? `${step / 1000} s` : step < 3_600_000 ? `${step / 60_000} min` : `${step / 3_600_000} h`;
    return <>
        {gridTimes(run, step).map((t) => <i key={t} class="rc-grid" aria-hidden="true" style={{ left: `${runFrac(run, t) * 100}%` }} />)}
        {run === runs[runs.length - 1] ? <span class="rc-grid-step">grid {label}</span> : null}
    </>;
}

function SwapChips({ swap }: { swap: NonNullable<NonNullable<ResourceEvent["gen"]>["swap"]> }) {
    return (
        <>
            <span class="rc-chip rc-chip-dim">{swap.restored ? "this conversation restored from RAM" : "not in RAM — read from scratch"}</span>
            {swap.savedTokens != null
                ? <span class="rc-chip rc-chip-dim">{swap.savedTokens.toLocaleString()} tokens saved out{swap.savedBytes != null ? ` (${formatBytes(swap.savedBytes)})` : ""}</span> : null}
            {swap.evicted
                ? <span class="rc-chip rc-chip-warn">evicted {swap.evicted} {swap.evicted === 1 ? "conversation" : "conversations"}{swap.evictedBytes ? ` (${formatBytes(swap.evictedBytes)})` : ""} to make room — {swap.evicted === 1 ? "it" : "they"} will need a full prefill</span> : null}
            {swap.tooLarge ? <span class="rc-chip rc-chip-warn">the outgoing conversation was larger than the whole cache, so it was not kept</span> : null}
        </>
    );
}

/** Why the server gave no decode ceiling, in words a reader acts on. */
const CEILING_WHY: Record<string, string> = {
    mixture_of_experts: "no ceiling: a mixture-of-experts model reads only its active experts per token",
    partly_on_cpu: "no ceiling: part of this model runs from system RAM, which nothing here measures",
    bandwidth_unknown: "no ceiling: the card's memory bandwidth could not be read",
};

/** A generation's measured DECODE rate against the ceiling AT ITS CONTEXT (`decodeCeiling` at the mean
 *  occupancy over the decode, `prompt_tokens + decoded / 2`). Against the empty-context ceiling instead, a box
 *  holding a steady 80% reads as collapsing to 53% as the context grows — so that figure is never shown. Over
 *  100% on a dense model is a bug on one side, and is said rather than clamped. When there is no honest
 *  ceiling the server's reason is shown instead. */
function CeilingChip({ e }: { e: ResourceEvent }) {
    const r = e.genRoofline, g = e.gen;
    if (!r || !g || !g.decoded || !(g.evalMs > 0)) return null;
    if ("unavailable" in r) return <span class="rc-chip rc-chip-dim">{CEILING_WHY[r.unavailable] ?? `no ceiling: ${r.unavailable}`}</span>;
    const occ = (g.promptTokens ?? 0) + g.decoded / 2;
    const ceil = decodeCeiling(r, occ);
    if (ceil == null) return <span class="rc-chip rc-chip-dim">no ceiling at this context: the cache follows no single per-token rate</span>;
    const measured = g.decoded / (g.evalMs / 1000);
    const share = measured / ceil;
    return (
        <span class={`rc-chip ${share > 1.02 ? "rc-chip-warn" : "rc-chip-dim"}`}>
            {share > 1.02
                ? `above the computed ceiling (${ceil.toFixed(1)} tok/s) — one side's arithmetic is wrong`
                : `${Math.round(share * 100)}% of the memory-bandwidth ceiling at this context (${ceil.toFixed(1)} tok/s)`}
        </span>
    );
}

function EventTip({ scope }: { scope: string }) {
    const h = eventHover.value, at = cursorAt(scope);
    if (!h || !at || h.scope !== scope) return null;
    const e = h.p.event;
    const dur = (e.until ?? e.t) - e.t;
    const ms = fmtDur;   // one duration scale for the whole panel — see timestamps.ts
    // Each phase's own duration, from where the previous one ended.
    const { ref, style } = useTipPlacement(at);
    // What getting TO the model cost. Wall MINUS generation is not that on its own: it also contains reading
    // the prompt, which is the model's own work and scales with the conversation. Reported as "network" it
    // over-charged the box for something the model did — so prompt eval comes out first, and what is left is
    // queue and network, which really are facts about the box and the moment.
    const promptMs = e.cost?.promptEvalMs ?? null;
    // …and LOADING comes out too, for exactly the same reason prompt eval does. Our wall clock starts when
    // the request goes out, so on a call that triggered a load it contains the whole load — measured at 70.8s
    // on a real box, reported as "+70884ms network", which is a claim about the box's networking that is off
    // by seventy seconds and points the reader at the wrong thing entirely. The load is drawn as its own
    // span; what is left after the model's own three durations is queue and network.
    const loadMs = e.cost?.loadMs ?? null;
    const overheadMs = e.cost?.evalMs != null && e.cost.wallMs != null
        ? Math.max(0, e.cost.wallMs - e.cost.evalMs - (promptMs ?? 0) - (loadMs ?? 0)) || null : null;
    const phases = (e.phases || []).map((ph, i) => ({ ...ph, from: i ? e.phases![i - 1].until : e.t }));
    // The two halves of a load, in bytes: the weights as the server measured them, and the context as the
    // difference between the whole load and the weights. Null unless the server reported both.
    const phaseBytes = (kind: string): number | null =>
        kind === "weights" ? (e.weightsBytes ?? null)
        : kind === "context" ? (e.loadBytes != null && e.weightsBytes != null ? e.loadBytes - e.weightsBytes : null)
        : null;
    // HOW MUCH DID NOT FIT. Null unless the server reported both figures AND they differ by enough to be a
    // real spill rather than the byte or two of bookkeeping that separates two independently-taken readings.
    const spilled = e.totalBytes != null && e.loadBytes != null && e.totalBytes - e.loadBytes > SPILL_FLOOR
        ? e.totalBytes - e.loadBytes : null;
    const first = phases[0];
    // A TOTAL record over the phase kinds, not a chain ending in a default. The chain shipped `weights` and
    // `context` — the two halves of a model load — as the word "tool", because an unknown kind fell through
    // to the tool branch and a fallback cannot tell "no name for this" from "this is a tool". Adding a phase
    // kind without naming it is now a compile error instead of a plausible wrong label.
    const PHASE_NAMES: Record<PhaseKind, string | (() => string)> = {
        model: () => e.model || "model",
        think: "thinking",
        answer: "answering",
        call: "emitting the tool call",
        wait: "waiting for approval",
        // The two halves of getting a model ready. NOT "warmup": the second half allocates the KV cache and
        // the compute buffers, which on a long-context model is most of the footprint — and the halves invert
        // between a cold load and a warm one, which is the whole reason to draw them apart.
        weights: "moving the weights in",
        context: "allocating the context",
        // Said as what it IS rather than as a label: the point of splitting a remote step is that these two
        // are not the tool being slow, and a reader should not have to know that to read the bar.
        dispatch: "dispatching the call",
        net: "network, there and back",
        queue: "queued before it started",
        // A sandbox fetching its runtime. Said as the thing it is, because a reader seeing four seconds in
        // front of a one-line script needs to know it was not the script.
        boot: "starting the sandbox (cold start)",
        tool: () => e.tool || "tool",
        // A generation's two halves, as the ENGINE timed them, and what lies around them. Said as what each
        // is, since "prefill" is jargon a reader should not need to know to read a bar.
        prefill: "reading the prompt (prefill)",
        decode: "generating tokens (decode)",
        other: "neither — scheduling and setup around the call",
        // Moving conversations' KV caches between the slot and host RAM before the prefill — the engine's own
        // measure, and in no other timing.
        swap: "swapping conversations through the RAM cache",
    };
    const nameFor = (kind: string) => {
        const n = PHASE_NAMES[kind as PhaseKind];
        // A kind from OUTSIDE the union — the export's phase kinds are `@unstable` and another producer may
        // time something we have no concept of. Show the kind itself: it is at least true.
        return typeof n === "function" ? n() : (n ?? kind);
    };
    // A run span has no phases and no cost of its own — it is the CONTAINER. Saying "click to open this step"
    // under it was wrong twice over: it is not a step, and its ref carries no seq to scroll to.
    const isRun = e.kind === "run" || e.kind === "session";
    // An INSTANT has no duration and no cost — it is a moment, and the tooltip built for spans reported it as
    // "0ms" with its label dropped entirely, which said nothing at all about the thing you were pointing at.
    const instant = e.until == null;
    if (instant) return (
        <div class="rc-tip rc-tip-event" role="tooltip" ref={ref} style={style}>
            <div class="rc-tip-line">
                {e.model ? <i class="rc-tip-dot" style={{ background: colorFor(e.model) }} /> : null}
                <span class="rc-tip-name">{e.model || e.label}</span>
                {/* WHEN, not how long: that is the only quantity a moment has. */}
                <span class="rc-tip-size">{hhmmssms(e.t)}</span>
            </div>
            {/* WHAT THIS EDGE IS, said differently depending on where it CAME FROM.
                An inferred one is read off `/api/ps` by noticing a model was there and then was not, and the
                note says so. A REPORTED one came from the server's own event stream, which knows things
                polling cannot — above all whether an eviction MADE ROOM or was an idle expiry — so it says
                what the server said. Hardcoding the inference note for both claimed "nothing reports an
                eviction" about an edge the server had just reported, on exactly the setup the stream exists
                for, and hid the reason it had gone to the trouble of sending. */}
            <div class="rc-tip-note">{e.via === "server"
                ? serverSaid(e.label, e.model)
                : e.kind === "evict"
                    ? "left memory here — nothing reports an eviction, so this is the sample where it stopped being resident"
                    : e.kind === "load" ? "appeared here — loaded by something else, or while the panel was closed"
                        : e.label}</div>
        </div>
    );
    return (
        <div class="rc-tip rc-tip-event" role="tooltip" ref={ref} style={style}>
            {/* Each phase, in the order it happened: the model, the human deciding, then the tool. */}
            <div class="rc-tip-line">
                {/* Each section carries the swatch of the stripe it describes, so the tooltip and the block
                    read as the same three things. */}
                {first || e.model ? <i class="rc-tip-dot" style={{ background: phaseFill(first?.kind ?? "model", e.model) }} /> : null}
                {/* WHAT THIS BLOCK IS, always — its own label ("qwen:32b serving", "loading gemma4:e2b"), not
                    a hardcoded "run" and not just the model name. The first PHASE used to take this line,
                    which meant a machine event with no phases said nothing but the model: a serving span and
                    a load looked identical, and neither said which it was. Phases are rows below now, all of
                    them, so the header is the identity and the rows are how the time split. */}
                <span class="rc-tip-name">{e.label || e.model}</span>
                {/* An ASIDE names its MODEL too, and only it does. Every other span's model is the session's
                    own — the panel says it in three places already — but an aside runs on the UTILITY model,
                    and "which model spent this" is most of what a reader wants from a bar they triggered
                    themselves. Elsewhere it would be the same string repeated on every tooltip. */}
                {e.kind === "aside" && e.model ? <span class="rc-tip-aside-model">{e.model}</span> : null}
                <span class="rc-tip-size">{ms(dur)}</span></div>
            {/* WHICH SESSION this belongs to — only while the lane is showing every session. Scoped, every
                block on screen is from the one you are reading, and the pill would repeat the same eight
                characters on every tooltip to say nothing. */}
            {/* WHERE this model runs. A cloud model occupies no local memory ever, so a span with no matching
                line in the chart above is expected of it and puzzling for a local one — the tooltip is the
                place that difference belongs. Omitted when provenance is UNKNOWN (an unpatched server lists
                no ollama ids), because guessing "cloud" from an absence would be a claim we cannot make. */}
            {(!laneScoped.value && e.ref?.hash) || (e.model && modelWhere(e.model))
                ? <div class="rc-tip-chips">
                    {e.model && modelWhere(e.model)
                        ? <span class="rc-chip rc-chip-dim">{modelWhere(e.model)}</span> : null}
                    {!laneScoped.value && e.ref?.hash
                        ? <span class="rc-chip rc-chip-hash">{e.ref.hash}</span> : null}
                </div> : null}
            {/* The figures as BADGES, the same little blocks the model rows use. Loose text on two dim lines
                gave no way to tell which numbers belonged together; a chip is visibly one fact. */}
            {e.cost ? (
                <div class="rc-tip-chips">
                    <span class="rc-chip">{e.cost.inTokens.toLocaleString()} in</span>
                    {/* How many of those the prefix cache served — the reason a long prompt can take no time.
                        "cold" only when the server said 0; nothing when it said nothing. */}
                    {e.cost.cachedTokens != null ? <span class="rc-chip rc-chip-dim">{e.cost.cachedTokens > 0 ? `${e.cost.cachedTokens.toLocaleString()} from cache` : "cold, none cached"}</span> : null}
                    <span class="rc-chip">{e.cost.outTokens.toLocaleString()} out</span>
                    {e.cost.tokPerSec != null ? <span class="rc-chip">{e.cost.tokPerSec.toFixed(1)} tok/s</span> : null}
                    {/* A rate's basis is part of the rate: generation-only and wall-clock measure different
                        things, and the bare number would imply a precision it doesn't have. */}
                    {e.cost.genBasis ? <span class="rc-chip rc-chip-dim">{e.cost.genBasis === "eval" ? "generation only" : e.cost.genBasis === "wall" ? "incl. network" : "mixed timing"}</span> : null}
                    {/* When BOTH timings are known, their difference is the network and the queue — a
                        different diagnosis from a slow model, and not recoverable from the rate alone. */}
                    {promptMs != null ? <span class="rc-chip rc-chip-dim">{Math.round(promptMs)}ms reading the prompt</span> : null}
                    {overheadMs != null ? <span class="rc-chip rc-chip-dim">+{Math.round(overheadMs)}ms network</span> : null}
                </div>
            ) : null}
            {/* A SEPARATOR IS A BORDER ON THE SECTION IT OPENS, never an element of its own. A standalone rule
                can end up with nothing on one side of it — first, last, or next to another rule — and then
                it is a line dividing nothing, which this tooltip produced in three different ways before it
                was made structurally impossible. A border cannot exist without the content it belongs to. */}
            {phases.map((ph, i) => (
                <>
                    <div class="rc-tip-line sep" key={i}>
                        <i class="rc-tip-dot" style={{ background: phaseFill(ph.kind, e.model) }} />
                        {/* A bare "exec" reads as a label of unknown kind. Saying what it IS — a tool call,
                            with the name as code — is the difference between a word and an identifier. */}
                        <span class="rc-tip-name">{ph.kind === "tool"
                            ? <>tool call: <code>{e.tool}</code></>
                            : nameFor(ph.kind)}</span>
                        {/* WHAT IT MOVED, beside how long it took. A six-second weights step that moved 17
                            GiB reads very differently from one that moved 300 MiB, and the duration alone
                            cannot tell them apart. Only when the server measured it. */}
                        {phaseBytes(ph.kind) != null
                            ? <span class="rc-chip rc-chip-dim">{formatBytes(phaseBytes(ph.kind)!)}</span> : null}
                        {/* WHAT EACH HALF OF A GENERATION DID, in the engine's own counts. The prompt count alone
                            hides a cache hit completely — it is the same either way — so the cached share is said
                            beside it, and "cold" only when the server said 0, never when it said nothing. */}
                        {ph.kind === "prefill" && e.gen?.promptTokens != null ? <span class="rc-chip rc-chip-dim">{e.gen.promptTokens.toLocaleString()} tokens
                            {e.gen.promptTokensCached != null ? (e.gen.promptTokensCached > 0 ? ` · ${e.gen.promptTokensCached.toLocaleString()} from cache` : " · cold, none cached") : ""}</span> : null}
                        {ph.kind === "decode" && e.gen?.decoded != null ? <span class="rc-chip rc-chip-dim">{e.gen.decoded.toLocaleString()} tokens
                            {e.gen.evalMs > 0 ? ` · ${(e.gen.decoded / (e.gen.evalMs / 1000)).toFixed(1)} tok/s` : ""}</span> : null}
                        {ph.kind === "decode" ? <CeilingChip e={e} /> : null}
                        {ph.kind === "swap" && e.gen?.swap ? <SwapChips swap={e.gen.swap} /> : null}
                        <span class="rc-tip-size">{ms(ph.until - ph.from)}</span></div>
                </>
            ))}
            {e.gen && e.genCtx ? <KvBar gen={e.gen} ctx={e.genCtx} model={e.model} /> : null}
            {/* An OPEN span has no end yet, so every duration in this tooltip is "so far". Said once, plainly,
                because the alternative is a reader taking a number that is still growing as a measurement. */}
            {e.open ? <div class="rc-tip-note">still running — these durations are so far, not final</div> : null}
            {/* A DEGRADED LOAD, and the only place the fact exists. When the prediction was too low,
                llama-server re-fits against the memory actually free and runs the remainder on the CPU: the
                load SUCCEEDS, nothing errors, and the model is simply slow from then on. The difference
                between what the whole model is and what reached the device is the only signal, so it is
                stated in words rather than left as two numbers to subtract. */}
            {spilled != null
                ? <div class="rc-tip-note warn">{formatBytes(spilled)} of this model did not fit — it is
                    running on the CPU, which is why it will be slow. No error is raised for this.</div>
                : null}
            {predictView.value && e.kind === "load" ? <PredictionRows e={e} /> : null}
            {/* ONE rule opens the footer, and the PROSE comes first inside it. The notes explain the block —
                "the model wasn't resident", "continues past what was measured" — and they were sitting under
                the timestamp, which read as a caption on the clock rather than on the thing. The timestamp is
                the reference line: quiet, last, and the part you go looking for rather than read.

                One rule, not two: ruling the timestamp on both sides put a divider above and below a single
                line, which reads as an empty boxed cell rather than as two sections. */}
            {/* The footer opens with a border on whichever of these actually renders — `sepFirst` hands it to
                the first one, so the section is separated exactly when it has something in it. */}
            {(() => {
                const notes = [
                    e.kind === "load" ? "the model wasn't resident — this is the wait before a token" : null,
                    // Said plainly, because a bar in a run's lane that is not part of the run is exactly the
                    // sort of thing a reader would otherwise spend a minute misattributing.
                    e.kind === "aside" ? "you triggered this while reading — NOT part of the run, and not counted in its tokens" : null,
                    // A generation the SERVER reported and no session of ours matched: another client's traffic.
                    // Said, because a bar nobody here caused otherwise reads as something this browser did.
                    e.kind === "gen" && e.via === "server" ? "reported by the server — not started from this browser" : null,
                    h.p.clipped ? "continues past what was measured" : null,
                    e.ref ? `click to open this ${e.ref.seq != null ? "step" : "run"}` : null,
                ].filter(Boolean) as string[];
                return notes.map((n, i) => <div class={`rc-tip-note${i === 0 ? " sep" : ""}`} key={n}>{n}</div>);
            })()}
            {/* WHEN, exactly. The durations say how long each part took; this is what lets a block be lined up
                against another one, or against a timestamped log. Milliseconds because an event's own timings
                are exact — unlike the crosshair, which interpolates between samples. */}
            <div class={`rc-tip-when${(e.kind === "load" || e.kind === "aside" || (e.kind === "gen" && e.via === "server") || h.p.clipped || e.ref) ? "" : " sep"}`}>{hhmmssms(e.t)} → {hhmmssms(e.until ?? e.t)}</div>
        </div>
    );
}

/** What HAPPENED, on the same axis as what was in memory — the question neither view answers alone: did that
 *  forty-second turn spend its time loading a model, or was the model already there?
 *
 *  Spans are bars in the lane; instants (an eviction) are rules. Both are placed inside the run that contains
 *  them, because the axis is segmented by gaps and is not linear in time. */
function EventLane({ samples, events: all, session }: { samples: ResourceSample[]; events: ResourceEvent[]; session: ResourceSample[] }) {
    // Filtered before anything is placed, so the rows pack against what is actually drawn — a hidden kind
    // must not leave a hole where it would have been.
    const filter = laneFilter();
    // The model set is part of the filter now, so it has to be part of the KEY — a memo that ignores it holds
    // the previous session's answer, which is the exact bug being fixed, just one render later.
    const evKey = (filter.models || []).join("\u0000");
    const events = useMemo(() => filterEvents(all, filter), [all, filter.hash, filter.scope, filter.hidden, evKey]);
    const counts = useMemo(() => countByKind(all), [all]);
    const runs = noteRuns(useMemo(() => segments(samples, sampleGapMs()).filter((r) => r.length > 1), [samples, streamLive.value]));
    const from = runs[0]?.[0]?.t ?? 0, to = runs.at(-1)?.at(-1)?.t ?? 0;
    // The window admits a poll's worth past the last sample, for the same reason placeEvents does.
    const placed = useMemo(() => placeEvents(runs, eventsIn(events, from, to + sampleGraceMs()), sampleGraceMs()),
        [runs, events, from, to]);
    // The CONTROL still shows when everything is filtered out — otherwise hiding the last kind hides the way
    // to bring it back.
    if (!runs.length || (!placed.length && !all.length)) return null;
    const spans = placed.filter((p) => p.event.until != null);
    const rows = laneRows(spans);
    const [pulsed, setPulsed] = useState<string | null>(null);
    const lit = lineageOf(events, eventHover.value?.p.event.id);
    // The same focus, carried into the transcript: the log dims every step outside the hovered lineage, so a
    // bar and the rows it is about light up together. Derived from the lineage rather than from the one
    // hovered event, so a sub-call still points at the step that spawned it.
    useEffect(() => {
        // The log belongs to ONE session. A hovered block from another run shares no step with it, so
        // "everything outside the lineage" was the whole transcript — hovering run B greyed out run A's log
        // entirely. The lane still dims its OWN bars by lineage; that is within one surface and correct.
        const hovered = eventHover.value?.p.event;
        const open = view.value.name === "detail" ? view.value.hash : null;
        const mine = !!hovered?.ref && !!open && hovered.ref.hash === open;
        const on = lit.size > 0 && mine;
        laneLitSeqs.value = on
            ? new Set(events.filter((e) => e.id && lit.has(e.id) && e.ref?.seq != null).map((e) => e.ref!.seq as number))
            : null;
        // The transcript holds more than steps — the task, the answer, a mid-run steer — and none of them is
        // in any lineage, so focusing has to reach them too or the log only half-dims and the effect reads as
        // broken rather than as scoped. Driven by an attribute on <html> and pure CSS, the same way the code
        // wrap and gutter prefs are: it is a display MODE, and the alternative is subscribing every message
        // component to a signal that changes on hover.
        // A generation that produced no tool call IS the answer, so hovering it must leave the answer lit —
        // dimming the very thing the bar points at is the failure this whole affordance exists to avoid. It
        // is the one message the lane can identify: every other message belongs to no lineage at all.
        const answerLit = on && events.some((e) => e.id && lit.has(e.id) && e.kind === "gen" && e.ref?.seq == null);
        try {
            const el = document.documentElement;
            if (on) el.setAttribute("data-lane-focus", answerLit ? "answer" : "step");
            else el.removeAttribute("data-lane-focus");
        } catch { /* no document in this realm */ }
    }, [lit, events]);
    const open = (e: ResourceEvent) => {
        if (!e.ref) return;
        view.value = { name: "detail", hash: e.ref.hash };
        // A generation with no step seq IS the answer — it is the only event in a run that points at a
        // message rather than a step, so it needs the other destination or the click lands nowhere.
        if (e.ref.seq == null) scrollToAnswer(e.ref.hash);
        else scrollToStepSeq(e.ref.seq, e.ref.hash);
    };
    // Double-click scopes the panel to the block: the shortest path from "something happened there" to
    // reading it at a scale where it is legible. Every block, not only a run — zooming to one tool call is
    // the same gesture as zooming to the turn that contains it. The single click still navigates, since
    // going to the step and framing the time around it are the same intent from two sides.
    // Widened to cover a few SAMPLES, not just a few milliseconds: scoping to a 400ms tool call on a box
    // polled every two seconds produced a window with one sample in it, and everything here needs a segment
    // of at least two — so the tracks, the lane and the strip all drew nothing and the panel looked like it
    // had disappeared.
    // Measured against the WHOLE session, not `samples` — those are already windowed, so widening against
    // them would ask "does the new window fit inside the old one", which is the wrong question and answers
    // yes right up until the panel is empty.
    // …and SAY which block you landed on. The window has to be wider than a short block (it needs samples in
    // it to draw at all), so the answer to "which one did I zoom to" is otherwise "somewhere in here".
    const scope = (e: ResourceEvent) => {
        zoomRange.value = scopeAround(session, e.t, e.until, Date.now());
        if (e.id) { setPulsed(e.id); setTimeout(() => setPulsed((v) => (v === e.id ? null : v)), 1400); }
    };
    /** DRAG THE LANE'S OWN EDGE. Pixels, not a ratio: the lane's content is rows of a fixed 9px, so "six rows
     *  of events" is the thing being chosen and it must not change meaning when the panel is resized. Floored
     *  at one row — a lane dragged to nothing is not a smaller lane, it is a lost one, and the grip would go
     *  with it. Capped so it cannot swallow the charts it exists to be read against. */
    const onLaneGrab = (e: PointerEvent) => {
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        const box = el.previousElementSibling as HTMLElement | null;
        if (!box) return;
        const startY = e.clientY, startH = box.getBoundingClientRect().height;
        try { el.setPointerCapture(e.pointerId); } catch { /* older engines */ }
        const move = (ev: PointerEvent) => {
            laneH.value = Math.max(12, Math.min(400, Math.round(startH + (ev.clientY - startY))));
        };
        const up = () => {
            el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
            try { chrome.storage.local.set({ [LANEH_KEY]: laneH.value }); } catch { /* opaque origin */ }
        };
        el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    };
    // Double-click restores the default, the way every other learned size here does — a drag you cannot undo
    // is a setting with no reset.
    const resetLane = () => {
        laneH.value = LANE_H_DEFAULT;
        try { chrome.storage.local.set({ [LANEH_KEY]: LANE_H_DEFAULT }); } catch { /* opaque origin */ }
    };
    return (
        <div class="rc-lane" onPointerLeave={() => { eventHover.value = null; hoverAt.value = null; hoverModel.value = null; }}>
            {/* Rows carry the SAME drag-select the plot has. The lane shares the plot's axis, so a range
                picked out here means exactly what one picked out above does — and having to go up to the
                chart to select the stretch you are looking at down here reads as the lane being a picture
                rather than a control. A short press is not a drag (see startBrush), so a bar's own click and
                double-click still work. */}
            {/* COLLAPSED by default — the chip row below is the control. The lane is CONTENT (what happened);
                the scrub strip above it is NAVIGATION (where you are), which is why only this half folds and
                the strip stays. Folding the pair together also made the panel jump in height the first time
                anything ran, which is the thing that kept moving surfaces out from under the pointer. */}
            {/* THE ROWS SCROLL INSIDE THEIR OWN BOX. The lane RE-PACKS as the window moves — a step entering
                the view can add a row, and a row is a claim that two bars overlap — so its natural height
                changes constantly. Unbounded inside a fixed-height panel, every row it gained came off the
                CHARTS above it: they visibly shrank while you were dragging the panel's edge, which is the
                one moment you are looking at them. Bounded, the lane scrolls and nothing above it moves.
                Its own edge is draggable, so how much of each you want is still yours to say.

                A FIXED height, not a max: a cap still lets the box grow and shrink with its content, which is
                the jumping, just with a ceiling on it. Fixed, the lane occupies exactly what it was given
                whatever happens inside it, and everything above it is nailed down. */}
            {showLane.value ? <div class="rc-lane-rows" style={{ height: `${laneH.value}px` }}>{rows.map((row, ri) => (
                <div class="rc-lane-row" key={ri}
                    onPointerDown={startBrush(runs)}
                    onPointerMove={trackCursor("lane")}>
                    {/* The SAME selection box the tracks draw. The lane already took the drag — it shares
                        `startBrush` — but showed nothing while you made it, so the gesture worked and looked
                        like it had not: you released and the window jumped with no sign of what you had
                        chosen. Every surface on this axis draws the same fractions, which is the point of
                        the axis being shared. */}
                    <BrushOverlay runs={runs} />
                    {runs.map((run, i) => (
                        <div class="rc-lane-seg" key={i} style={{ flex: `${runWeight(run)} 1 0` }}>
                            {row.filter((p) => p.run === i).map((p, k) => {
                                const e = p.event;
                                const w = Math.max(MIN_EV_SPAN * 100, (p.to - p.from) * 100);   // packed at this width too
                                // A composite span is ONE block whose parts are different KINDS of time: the
                                // model, the human deciding, the tool. Drawn as gradient stops rather than
                                // separate elements, so it still hovers and clicks as the single step it is.
                                const total = (e.until ?? e.t) - e.t;
                                // A LOAD keeps its stripe for the whole span — it is a wait, and a flat fill
                                // would read as work. Its two halves are drawn as an OVERLAY below instead,
                                // for exactly the reason the approval wait is: a gradient stop takes a
                                // COLOUR, and a stripe is a pattern. Feeding the phase fills into
                                // phaseGradient produced `linear-gradient(..., repeating-linear-gradient(...)
                                // 0% 8%, ...)`, which is not valid CSS at all: the whole declaration was
                                // dropped and the divider silently never appeared.
                                const bg = e.kind === "load" ? loadStripes(e.model)
                                    : e.phases && total > 0 ? phaseGradient(e.phases, e.t, total, e.model) : undefined;
                                // Hovering one event dims everything outside its LINEAGE: a sub-call only means
                                // something next to the step that spawned it and the run that contains it.
                                const away = lit.size > 0 && !(e.id && lit.has(e.id));
                                return (
                                    <button class={`rc-ev rc-ev-${e.kind}${e.ref ? " linked" : ""}${away ? " away" : ""}${e.open ? " open" : ""}${e.id && e.id === pulsed ? " pulse" : ""}`} key={k}
                                        style={{ left: `${p.from * 100}%`, width: `${w}%`,
                                                 // A `run` is the CONTAINER every other block sits inside, so it is
                                                 // drawn as a pattern rather than a solid fill (see .rc-ev-run) —
                                                 // otherwise the widest, most prominent bar in the lane reads as the
                                                 // heaviest piece of work in it. The pattern is built from `--model`
                                                 // below, so it keeps the same identity; an inline `background`
                                                 // shorthand here would reset the background-image that draws it.
                                                 ...(e.model && !bg && e.kind !== "run" ? { background: colorFor(e.model) } : {}),
                                                 // A model's events carry ITS colour — the same one its row and
                                                 // its band already use, so the lane reads against the list
                                                 // without a legend of its own.
                                                 ...(e.model ? { "--model": colorFor(e.model) } : {}),
                                                 ...(bg ? { background: bg } : {}) }}
                                        title=""
                                        // Which model this block belongs to, readable from OUTSIDE the
                                        // colour. The identity is otherwise only expressed as a CSS custom
                                        // property, so "is the lane drawing one model or two" — the question
                                        // behind the two-spellings bug — could only be answered by eye.
                                        data-model={e.model ?? undefined}
                                        onPointerEnter={(ev: PointerEvent) => { eventHover.value = { p, scope: "lane" }; hoverModel.value = e.model ?? null; trackCursor("lane")(ev); }}
                                        onClick={() => open(e)}
                                        onDblClick={() => scope(e)}>
                                        {/* A person at the approval gate is the step's wall time but none of
                                            the machine's work, so it is STRIPED for the same reason a model
                                            load is: a wide flat block reads as a lot of work having happened.
                                            Drawn over the flat neutral rather than into the gradient, because
                                            a gradient stop takes a colour and a stripe is a pattern. */}
                                        {e.phases && total > 0
                                            ? phaseSpans(e.phases, e.t, total)
                                                .filter((ph) => (ph.kind === "wait" || ph.kind === "context") && ph.end > ph.start)
                                                .map((ph, wi) => (
                                                    // `context` is the second half of a LOAD: the KV cache and
                                                    // compute buffers being allocated, which is where most of a
                                                    // long-context model's footprint actually lands. Denser than
                                                    // the weights half it follows, so the boundary reads as a
                                                    // change of texture rather than needing a drawn line.
                                                    <i class={ph.kind === "context" ? "rc-ev-ctxphase" : "rc-ev-wait"} key={wi}
                                                        style={{ left: `${ph.start * 100}%`, width: `${(ph.end - ph.start) * 100}%` }} />
                                                ))
                                            : null}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            ))}</div> : null}
            {/* Its own grip, under the rows and above the header — a lane too short to show what happened is
                as bad as one that eats the charts, and which you want depends entirely on the run. */}
            {/* ITS EDGE IS THE HANDLE, and the edge is a real rule. A centred pill said "drag me" in a place
                where a pill means a drawer, and the lane is not one — while the box it bounds had no visible
                bottom at all, so the events floated in the panel with nothing saying where their space ended.
                One line does both jobs: it closes the box, and it is what you grab. Same pairing the editor
                and its divider already use — the border IS the line, the strip over it is the grab target. */}
            {showLane.value ? <div class="rc-lane-grip" role="separator" aria-orientation="horizontal"
                aria-label="Drag to resize the event lane" onPointerDown={onLaneGrab} onDblClick={resetLane} /> : null}
            <EventTip scope="lane" />
            <LaneFilterBar counts={counts} shown={events.length} total={all.length} />
        </div>
    );
}

/** What the lane is drawing, and what it is leaving out. Each kind is a chip with its count: a filter that
 *  makes you toggle blindly to find out what it hides is worse than none. */
/** The KINDS of event the panel can hide, in the order the lane's chip row shows them — ONE set, obeyed by the
 *  lane, the scrub strip's ticks AND the rules drawn through the plots, and offered in two places (the lane's
 *  chips and the chart's gear, since the lane is collapsed by default). Two independent sets would let "loads"
 *  be hidden in one surface and shown in another: the panel saying two things about one run. */
export const LANE_KINDS: { kind: ResourceEvent["kind"]; label: string }[] = [
    { kind: "run", label: "runs" }, { kind: "session", label: "sessions" },
    { kind: "tool", label: "steps" }, { kind: "gen", label: "calls" },
    { kind: "embed", label: "sub-calls" }, { kind: "load", label: "loads" }, { kind: "evict", label: "evictions" },
    // What the BOX was doing, as opposed to what this browser asked for — a serving span covers traffic
    // from any client, which is exactly why it is worth drawing and why it is separately hideable.
    { kind: "serve", label: "serving" },
];

/** Show or hide one kind everywhere the panel draws events, and remember it. */
export const toggleLaneKind = (k: string): void => {
    const next = laneHidden.value.includes(k as ResourceEvent["kind"])
        ? laneHidden.value.filter((x) => x !== k) : [...laneHidden.value, k as ResourceEvent["kind"]];
    laneHidden.value = next;
    try { chrome.storage.local.set({ [LANE_HIDDEN_KEY]: next }); } catch { /* opaque origin */ }
};

function LaneFilterBar({ counts, shown, total }: { counts: Record<string, number>; shown: number; total: number }) {
    const hidden = new Set(laneHidden.value);
    const KINDS = LANE_KINDS;
    const toggle = toggleLaneKind;
    const open = showLane.value;
    // What is in there, on the header — the thing that makes the row worth opening. Counts only, no filter
    // state: a filter is about what is DRAWN, and nothing is drawn while it is closed. And ONLY while it is
    // closed: open, the chips directly below say the same counts in the same order, so the header was
    // reciting the row under it.
    const summary = open ? "" : KINDS.filter((k) => counts[k.kind]).map((k) => `${counts[k.kind]} ${k.label}`).join(" · ");
    const setOpen = (v: boolean) => {
        showLane.value = v;
        try { chrome.storage.local.set({ [SECTIONS_KEY]: { laneOn: laneEnabled.value, laneOpen: v, models: showModels.value } }); } catch { /* opaque origin */ }
    };
    return (
        // The SAME disclosure the two sections directly below it use (`agent options`, `other models on the
        // box`), rather than a bespoke chevron in a box beside a row of chips — which read as unrelated
        // chrome and gave no hint that the chips and the fold were the same control.
        //
        // ONE LINE, open or closed. The chips used to be the disclosure's BODY, so opening the lane spent a
        // whole row on them — under a header that was already reciting the same counts in the same order, in
        // a panel whose entire problem is vertical space. Closed, the header says what is in there (that is
        // what makes it worth opening); open, the same counts BECOME the filters, in the same place. Nothing
        // is repeated and nothing costs a row.
        <Disclosure label="events" note={summary} open={open} onToggle={setOpen} aside={open ? (
            <div class="rc-lane-filter">
                {KINDS.filter((k) => counts[k.kind]).map((k) => (
                    <button class={`rc-lane-chip${hidden.has(k.kind) ? " off" : ""}`} key={k.kind}
                        title={hidden.has(k.kind) ? `Show ${k.label}` : `Hide ${k.label}`}
                        onClick={() => toggle(k.kind)}>{k.label} {counts[k.kind]}</button>
                ))}
                {/* The scope switch used to live here, as one more chip in a row of chips — which said it was
                    a filter over KINDS like the others, when it decides the window, the model list and the
                    lane together. It is in the panel HEADER now (`ScopeSwitch`). */}
                {shown < total ? <span class="rc-lane-count">{shown}/{total}</span> : null}
            </div>
        ) : undefined} />
    );
}

/** SESSION or FULL — the one switch that decides what the whole panel is about. It drives three things at
 *  once and that is the point: the time window (the session's own stretch, or the rolling one), which model
 *  rows are listed, and which events the lane draws. As a chip in the filter row it read as one more
 *  kind-filter beside "loads 4"; here, beside the view picker, it reads as what it is.
 *
 *  Offered in the OVERVIEW too, where nothing is open to scope to — because scoping is the default, so it is
 *  the only thing that explains an empty lane and the only way out of it. */
export function ScopeSwitch() {
    const inDetail = view.value.name === "detail";
    const set = (scoped: boolean) => {
        laneScoped.value = scoped;
        try { chrome.storage.local.set({ [LANE_SCOPE_KEY]: scoped }); } catch { /* opaque origin */ }
    };
    return (
        <div class="rc-scope" role="group" aria-label="Scope">
            <button class={`tt rc-scope-seg${laneScoped.value ? " on" : ""}`} aria-pressed={laneScoped.value} onClick={() => set(true)}>
                session
                <span class="tt-pop wrap" role="tooltip">{inDetail
                    ? "The window, the model list and the lane all follow the session you are reading."
                    : "Scoped to the open session — nothing is open, so no run events are drawn. Switch to full for the whole box."}</span>
            </button>
            <button class={`tt rc-scope-seg${laneScoped.value ? "" : " on"}`} aria-pressed={!laneScoped.value} onClick={() => set(false)}>
                full
                <span class="tt-pop wrap left" role="tooltip">The whole box: every session's events, every resident model, and the rolling time window from Settings.</span>
            </button>
        </div>
    );
}

/** THE CHART itself: one track per memory pool on a shared segmented axis, the scrub strip above and the
 *  event lane below. Drawing only — placement, packing, bands and windows are the pure functions in
 *  resource-model.ts, which is what makes the picture testable without a browser. */
export function ResourceTracks({ samples, capacity, hidden, layout, events = [] }: { samples: ResourceSample[]; capacity: Capacity | null; hidden: Set<string>; layout?: TrackDef[] | null; events?: ResourceEvent[] }) {
    // Capacity is fetched once per open and arrives AFTER the first ps poll, so the earliest samples carry
    // none — see the note on `filled` below.
    //
    // The visible window as an explicit RANGE, so the scrub strip can say where it sits in the session and
    // move it. A zoom (or a scrub) REPLACES the rolling window: you asked for a stretch, so the panel stops
    // sliding away from it.
    // SCOPED to a session: the axis is that session's own stretch. One switch drives the lane, the model list
    // and the window, so the three cannot say different things about what "this session" means — the list
    // naming one model while the chart drew ten minutes of a shared box either side of it is exactly the
    // disagreement this collapses. Null in the overview, where there is no session to be the extent of.
    //
    // Its OWN memo, and the rolling window below keeps the key it always had. The separation is load-bearing
    // rather than tidy: the rolling window closes over `Date.now()`, so every extra recomputation walks its
    // right edge further ahead of the last sample — and the scrub drag reads that window to decide what a
    // resize means, so widening its key by one dependency moving at a different cadence made a drag on the
    // right handle snap back to live instead of resizing, and emptied the strip outright in another test.
    // Here the value is a stable `null` whenever nothing is scoped, so it cannot disturb the memo below.
    // (`events.length`, never `events`: `timeline()` rebuilds that array every render.)
    const scopedWindow = useMemo(
        () => (laneScoped.value ? sessionWindow(events, scopedHash(), Date.now()) : null),
        [laneScoped.value, scopedHash(), events.length, samples.length]);
    const window_ = useMemo(
        () => chartWindow(zoomRange.value, scopedWindow, resWindowS.value, Date.now()),
        [resWindowS.value, zoomRange.value, samples.length, scopedWindow]);
    // The samples in the window, plus the nearest either side when the window is too narrow to draw itself —
    // see `windowSamples`. Zooming inside one long event used to leave fewer than two samples and an empty
    // chart, which reads as the panel having broken rather than as a window between two polls.
    const windowed = useMemo(() => windowSamples(samples, window_), [samples, window_]);
    // KNOWN BUG, diagnosed and deliberately still here: this backfills the CURRENT capacity into a sample
    // that has none, and a capacity carries FREE BYTES — which is what usage is computed from. So a sample
    // taken before `/api/info` first answered is drawn with TODAY's usage and MOVES as the present moves: the
    // history changes shape behind you, a flat opening becoming a valley the moment something loads.
    //
    // Three fixes were tried and each was worse. Dropping such samples, or not recording them, blanks the
    // panel whenever the window holds only one or two — which is every fresh open, and which broke twenty-odd
    // tests that assert on exactly that frame. Deriving their free from what they saw resident assumes
    // everything unattributed is free, erasing a card holding memory nobody claims. The real fix is a sample
    // that can say its usage is UNKNOWN and render as a GAP in the line — the same treatment this panel
    // already gives time nobody measured — which the band model cannot express yet.
    const filled = useMemo(() => windowed.map((s) => (s.capacity ? s : { ...s, capacity })), [windowed, capacity]);
    const latest = filled.at(-1);
    if (!latest?.capacity) return null;
    const tracks = layout && layout.length ? layout : (presetsFor(latest)[0]?.tracks ?? []);
    // Hiding a model hides its EVENTS too. The dot on a model row takes it out of the totals and the bands,
    // and leaving its lane blocks and its ticks behind left the panel saying two different things about the
    // same model at once — one surface showing it gone, the other still charging time to it.
    const shown = useMemo(
        () => (hidden.size ? events.filter((e) => !(e.model && hidden.has(e.model))) : events),
        [events, hidden]);
    // The lane's KIND chips have to reach the strip's ticks too. Filtering only inside the lane meant hiding
    // (say) loads left their ticks on the strip — the same "two surfaces disagreeing about one run" the
    // model-hiding fix was about. The lane still receives the unfiltered list, because its chips count from
    // it: a filter you have to toggle blindly to discover what it hides is worse than none.
    const stripFilter = laneFilter();
    const stripEvents = useMemo(() => filterEvents(shown, stripFilter),
        [shown, stripFilter.hash, stripFilter.scope, stripFilter.hidden]);
    // Wheeling over the CHART moves the window along the session — the plot is a viewport onto a timeline, so
    // a scroll gesture on it should scroll the timeline. It nudges by a fraction of the window's own width, so
    // one notch travels the same visible distance whether you are looking at ten seconds or at everything.
    //
    // It only means anything once there is a window to move: with no zoom and no rolling window the plot
    // already shows the whole session, and `scrubExtent` returns null there. In that case the event is left
    // alone so the panel's wheel-through still scrolls the transcript underneath.
    const wheelScrub = (e: WheelEvent) => {
        const w = window_;
        if (!w) return;
        const ex = scrubExtent(samples, w);
        if (!ex) return;
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
        // A TRACKPAD PINCH arrives as a wheel carrying ctrlKey — the platform's own way of telling a zoom from
        // a scroll, which is also why it must be swallowed: unhandled, the browser zooms the whole panel.
        // Sideways slides the window, pinch changes its width, which is what both gestures already mean.
        if (e.ctrlKey) {
            if (!e.deltaY) return;
            const at = box.width > 0 ? (e.clientX - box.left) / box.width : 0.5;
            settleScrub(scrubPinch({ from: ex.from, to: ex.to }, w, e.deltaY, at), ex);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const by = wheelScrubFraction(e.deltaX, e.deltaY, e.deltaMode, box.width);
        if (!by) return;
        settleScrub(scrubNudge({ from: ex.from, to: ex.to }, w, by), ex);
        e.preventDefault();
        e.stopPropagation();
    };
    // OVER THE LANE, only a HORIZONTAL wheel scrubs. The plot can take the gesture in either direction
    // because it has nothing of its own to scroll; the lane's rows do, so a vertical wheel there belongs to
    // them — and `wheelScrubFraction` reads whichever delta is larger, which would have swallowed it. Sideways
    // is the direction that means "move along the timeline" anyway, and it is what the lane was missing: the
    // bars are a window onto the session, and there was no way to push that window along from the half of the
    // panel you are actually looking at.
    const wheelLane = (e: WheelEvent) => {
        // A PINCH is vertical by nature, so it has to be let through before the axis test — otherwise zooming
        // works on the plot and silently does nothing an inch below it, on the surface sharing its axis.
        if (!e.ctrlKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;   // theirs: the rows scroll
        wheelScrub(e);
    };
    return (
        <>
            <div class="rc" onWheel={wheelScrub}>
                {/* The plots' RULES obey the same kind filter as the lane and the strip: hiding "loads" takes the
                    load steps off the chart too, rather than leaving them ruled through a trace whose lane bars
                    are gone. */}
                {tracks.map((t) => <TrackView key={t.id} def={t} samples={filled} latest={latest} hidden={hidden} events={stripEvents} />)}
            </div>
            {/* Directly under the tracks: where this window sits in the whole session. It sits ABOVE the lane
                rather than below it because the lane RE-PACKS as the window moves — a step entering the view
                can add a row — and anything below a control whose height changes shifts out from under the
                pointer mid-drag. The strip is the thing being dragged, so it goes where nothing moves it. */}
            <ScrubStrip samples={samples} window={window_} events={stripEvents} />
            {/* And below that, sharing the tracks' x-axis: what happened, against what memory was doing. The
                connector says the second is the first opened out — see ZoomLink. */}
            {/* Drawn unless the track editor's "event lane" is off — `laneEnabled` is that switch and takes
                the whole section with it, header included. `showLane` is only the fold: it collapses the ROWS
                and leaves the chip row as the control that brings them back. One signal used to do both, so
                unchecking the setting merely collapsed the section and left its header sitting there. */}
            {/* The LANE takes the same wheel gesture as the plot — it is the same axis, so scrolling it means
                the same thing, and the lane is the half you are usually looking at when you want to move
                along. Its rows scroll VERTICALLY inside their own box; horizontally there is nothing to
                scroll, because the lane is a window onto the session rather than a wide strip, and moving
                that window is exactly what this does. */}
            {laneEnabled.value
                ? <div onWheel={wheelLane}><EventLane samples={filled} events={shown} session={samples} /></div>
                : null}
        </>
    );
}

/** Models resident on the CPU — they hold no VRAM, so they never appear in a device track and would otherwise
 *  vanish from the panel entirely. */
export const cpuResident = (s: ResourceSample | undefined) => (s?.models ?? []).filter(isCpuResident);
