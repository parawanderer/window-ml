// resource-lane-ui.tsx — DRAWING the event lane: the bars, their tooltip, and the controls that narrow it.
//
// The lane answers "what happened, and when", against the same axis the plots are drawn on. Which events are
// in view and where each one sits is arithmetic and lives in ../resource-lane; this file is only the rendering
// of that answer, plus `EventTip`, which is most of its bulk because explaining one event means saying what
// kind it was, what it cost, what it was waiting for, and what the server said about it.
//
// It is here rather than in resource-chart.tsx because the lane is a separate surface that happens to share an
// axis. Everything the two genuinely share now sits underneath both: the cursor and hover in
// chart-interaction.ts, the panel's own state in panel-state.ts.
//
// `startBrush`/`BrushOverlay` came with it, and that is the one thing to know before editing: a drag on the
// lane and a drag on a plot are the SAME selection, so both surfaces raise it through one implementation. A
// second brush would read the same pixels through different geometry and select a different stretch.

import { signal } from "@preact/signals";
import { useMemo, useState, useEffect } from "preact/hooks";
import { snapFraction, timeAtFraction, clampWindow, segments } from "../resource-axis";
import { SPILL_FLOOR } from "../resource-bands";
import { filterEvents, countByKind, placeEvents, MIN_EV_SPAN, laneRows, lineageOf, scopeAround } from "../resource-lane";
import { type ResourceSample, type ResourceEvent, kvFill, percentOf, loadTrace, formatBytes, decodeCeiling, predictionLine, type PhaseKind, serverGenNote, eventsIn } from "../resource-model";
import { scrollToAnswer } from "./answer-render";
import { live, eventHover, cursorAt, noteRuns, litBy, holdAxis, hoverAt, releaseAxis, trackCursor, barKey } from "./chart-interaction";
import { colorFor, sampleGraceMs, resourceHistory, laneFilter, sampleGapMs, streamLive } from "./panel-state";
import { scrollToStepSeq } from "./step-scroll";
import { brush, snapDot, zoomRange, ollamaIds, models, laneScoped, predictView, sessionMap, view, laneLitSeqs, laneH, LANEH_KEY, LANE_H_DEFAULT, showLane, laneHidden, LANE_HIDDEN_KEY, SECTIONS_KEY, laneEnabled, showModels, LANE_SCOPE_KEY } from "./store";
import { fmtDur, hhmmssms } from "./timestamps";
import { Disclosure } from "./ui-kit";
import { useTipPlacement } from "./use-tip";
import { hoverModel } from "./vram-focus";

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
 *  line above, and repeating it costs the width the REASON needs (`evicted (oom-retry)` against an `unload`,
 *  which the server reports without saying whether a keep-alive ran out or another load displaced it). */
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
// DOTS, not stripes. Two stripe layers leaning opposite ways drew a load as a row of X's — busy at any size, and in a
// 9px lane row it read as noise rather than as "waiting". A grid of dots on the panel's ground says the same thing
// (time, not work) quietly, and a denser, smaller grid tells a load's second half from its first by texture.
const dots = (c: string, r: number, cell: number): string =>
    `radial-gradient(circle, ${c} ${r}px, transparent ${r + 0.5}px) 0 0 / ${cell}px ${cell}px, var(--panel)`;

const loadStripes = (model?: string): string => dots(model ? colorFor(model) : "var(--warn, #f59e0b)", 1.2, 5);

/** One half of a load: same colour, opposite leans, so the two are told apart by DIRECTION at any size. */
const halfStripes = (c: string, lean: 45 | -45): string =>
    `repeating-linear-gradient(${lean}deg, ${c} 0 3px, var(--panel) 3px 8px)`;

/** The paint for ONE phase of an event, keyed by phase kind and whose model it belongs to. A model's phases
 *  share its colour and differ only in weight, so a run reads as one thing doing several, rather than as
 *  several unrelated things that happen to be adjacent. */
export const phaseFill = (kind: string, model?: string): string => {
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
        : kind === "weights" ? dots(base, 1.2, 5)
        // A load inside a step: the same wait the load's own span below it shows, dotted the same way.
        : kind === "load" ? dots(`color-mix(in srgb, ${base} 70%, transparent)`, 1.2, 5)
        : kind === "context" ? dots(`color-mix(in srgb, ${base} 75%, transparent)`, 0.8, 3)
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

/** Whether a phase's fill is a PATTERN (stripes) rather than a colour. A pattern cannot be a gradient stop: one in
 *  the list makes the whole `background` invalid, the declaration is dropped, and the block draws as nothing. So
 *  a patterned phase gets a flat stop here and its stripes as an overlay (see `rc-ev-pattern`). */
const isPattern = (fill: string): boolean => fill.startsWith("repeating-") || fill.startsWith("radial-gradient(");

/** A phase's SWATCH in a tooltip. A pattern squeezed into a 7px circle is unreadable — the stripes drew as a
 *  partial ring, like a spinner — so a patterned phase (a wait: a load's halves, a cold start, a swap) is a HOLLOW
 *  ring in its colour, and work is a solid dot. The distinction the pattern makes in the lane survives. */
const phaseSwatch = (kind: string, model?: string): Record<string, string> => {
    const fill = phaseFill(kind, model);
    if (!isPattern(fill)) return { background: fill };
    const base = model ? colorFor(model) : "var(--accent)";
    const ring = kind === "boot" ? "var(--fg-faint)" : kind === "context" ? `color-mix(in srgb, ${base} 70%, transparent)` : base;
    return { background: "transparent", boxShadow: `inset 0 0 0 1.5px ${ring}` };
};

function phaseGradient(phases: { kind: string; until: number }[], from: number, total: number, model?: string): string {
    const fill = (kind: string) => { const f = phaseFill(kind, model); return isPattern(f) ? "var(--panel)" : f; };
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

/** The selection, mirrored. Every track draws the same fractions, so a drag on ONE plot is visibly a drag on
 *  the whole chart — the ranges only mean anything compared across pools. */
export function BrushOverlay({ runs }: { runs?: ResourceSample[][] } = {}) {
    const b = brush.value;
    if (!b) return null;
    // SNAPPED AT RENDER, from the RAW screen fractions the drag stored — the same rule, and for the same
    // reason, as the mark (`snapUnder`). A fraction is a fact about the sample COUNT when it was taken, so an
    // edge resolved once drifts off the dot it was dragged against the moment a poll lands: measured a whole
    // sample apart (a box edge at 0.600 beside a mark at 0.500). Both now answer "which sample is under this
    // screen position" from the same data at the same instant, which is the only way they cannot disagree.
    const at = (f: number) => (snapDot.value && runs ? snapFraction(runs, f, live.axis, sampleGraceMs())?.frac ?? f : f);
    const from = Math.min(at(b.from), at(b.to)), to = Math.max(at(b.from), at(b.to));
    return <div class="rc-brush" style={{ left: `${from * 100}%`, width: `${Math.max(0, to - from) * 100}%` }} />;
}

/** The narrowest a lane bar is DRAWN, in pixels (`.rc-ev` has the same `min-width`). The packer reserves at least this
 *  much: reserving only `MIN_EV_SPAN` of the lane, which is under 3px on a narrow one, let two bars packed edge to
 *  edge be drawn overlapping. */
const MIN_BAR_PX = 3;

/** The lane's measured width, for turning MIN_BAR_PX into a fraction of it. Written from a callback ref, since the
 *  rows are drawn below the lane's early return where a hook cannot reach. */
const laneWidthPx = signal(0);

/** Drag across a plot to select a time range (and release to apply it). The fractions are mapped back to TIME
 *  through the same segmented geometry events are placed with — the axis is not linear, so a range read off
 *  the pixels alone would select a different stretch than the one under the pointer. */
export const startBrush = (runs: ResourceSample[][]) => (e: PointerEvent) => {
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
        const rs = live.runs ?? runs;
        if (snapDot.value) {
            const s = snapFraction(rs, raw(x), live.axis, sampleGraceMs());
            const t = s ? rs[s.run]?.[s.index]?.t : null;
            if (t != null) return t;
        }
        return timeAtFraction(live.axis, raw(x));
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
            {e.loadBytes != null ? <div class="rc-tip-line"><span class="rc-tip-name">resident (the server's count)</span>{diff(e.loadBytes, target)}<span class="rc-tip-size">{formatBytes(e.loadBytes)}</span></div> : null}
            {est.weights != null && e.measured ? <div class="rc-tip-line"><span class="rc-tip-name">weights: {formatBytes(est.weights)} predicted</span>{diff(e.measured.weights, est.weights)}<span class="rc-tip-size">{formatBytes(e.measured.weights)}</span></div> : null}
            {est.kvCache != null && e.measured ? <div class="rc-tip-line"><span class="rc-tip-name">KV cache: {formatBytes(est.kvCache)} predicted</span>{diff(e.measured.kvCache, est.kvCache)}<span class="rc-tip-size">{formatBytes(e.measured.kvCache)}</span></div> : null}
            {trace ? <div class="rc-tip-note">peak and settled are {basis}{trace.basis === "device" ? " — an eviction making room at the same time reads as negative growth" : ""}. The weights/KV split is the metadata model's, whatever the source.</div> : null}
        </>
    );
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

/** A generation's measured decode against the SERVER'S PREDICTION for it (`gen.end.predicted_decode`), beside the
 *  ceiling: the roofline says what memory bandwidth allows, this says what the box expected of this model at this
 *  context — made before the generation ran, so it is not fitted to the thing it is compared with. */
function PredictionChip({ e }: { e: ResourceEvent }) {
    const line = e.gen ? predictionLine(e.gen) : null;
    return line ? <span class="rc-chip rc-chip-dim">{line}</span> : null;
}

/** The tooltip for the lane bar under the cursor: what kind of event it was, what it cost, what it waited on
 *  and what the server said about it. Renders only for the surface the pointer is actually on (`scope`), since
 *  every track draws a tip from the same hover signals and they would otherwise all appear at once. */
export function EventTip({ scope }: { scope: string }) {
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
        // The first stretch of a call whose wall clock contained a load: the model arriving. Named, because left
        // inside the model's time it was the tooltip's "scheduling and setup", seconds of it, pointing nowhere.
        load: () => `waiting for ${e.model || "the model"} to load`,
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
                polling cannot — above all an OOM-retry eviction and its reason, told from an ordinary unload — so it says
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
                {/* The header names the WHOLE block, so it carries a swatch only when the whole block is one colour
                    (no phases: the model's). A phased block is several colours, and the header used to take its
                    FIRST phase's swatch, so a step that began by waiting for a load led with a hollow ring that
                    described one stretch of the bar while the line beside it named all of it. Each phase row
                    below carries its own swatch. */}
                {!first && e.model ? <i class="rc-tip-dot" style={phaseSwatch("model", e.model)} /> : null}
                {/* WHAT THIS BLOCK IS, always — its own label ("qwen:32b serving", "loading gemma4:e2b"), not
                    a hardcoded "run" and not just the model name. The first PHASE used to take this line,
                    which meant a machine event with no phases said nothing but the model: a serving span and
                    a load looked identical, and neither said which it was. Phases are rows below now, all of
                    them, so the header is the identity and the rows are how the time split. */}
                <span class="rc-tip-name">{e.label || e.model}</span>
                {/* THE MODEL, on every span that has one and does not already say it. This used to be the aside's
                    alone, on the argument that every other span runs on the session's own model — but a tooltip is
                    read on its own, over a chart that draws several models, and a step named only by its tool
                    ("agent_api_docs") left the reader to work out which model generated it. A label that already
                    names the model ("loading qwen3.8…", "qwen:32b serving") is not repeated. */}
                {e.model && !(e.label || "").includes(e.model) ? <span class="rc-tip-aside-model">{e.model}</span> : null}
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
                    {/* THREE COLUMNS: the swatch, a body that wraps (the name, then its chips), and the duration. As one
                        wrapping flex row it inherited `space-between`, so a row whose chips did not fit spread its first
                        line: the swatch at the left edge, the name pushed right or centred, the duration a line of its own. */}
                    <div class="rc-tip-line sep rc-tip-phase" key={i}>
                        <i class="rc-tip-dot" style={phaseSwatch(ph.kind, e.model)} />
                        <span class="rc-tip-phase-body">
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
                        {ph.kind === "decode" ? <><CeilingChip e={e} /><PredictionChip e={e} /></> : null}
                        {ph.kind === "swap" && e.gen?.swap ? <SwapChips swap={e.gen.swap} /> : null}
                        </span>
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
                    // With a hint the server echoed, it also says WHOSE and what kind of work (`serverGenNote`).
                    e.kind === "gen" && e.via === "server" ? serverGenNote(e.hint, (sess) => sessionMap.has(sess.replace(/^wml-/, ""))) : null,
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
export function EventLane({ samples, events: all, session }: { samples: ResourceSample[]; events: ResourceEvent[]; session: ResourceSample[] }) {
    // Filtered before anything is placed, so the rows pack against what is actually drawn — a hidden kind
    // must not leave a hole where it would have been.
    const filter = laneFilter();
    // The model set is part of the filter now, so it has to be part of the KEY — a memo that ignores it holds
    // the previous session's answer, which is the exact bug being fixed, just one render later.
    const evKey = (filter.models || []).join("\u0000");
    const events = useMemo(() => filterEvents(all, filter), [all, filter.hash, filter.scope, filter.hidden, evKey]);
    const counts = useMemo(() => countByKind(all), [all]);
    const runs = noteRuns(useMemo(() => segments(samples, sampleGapMs()).filter((r) => r.length > 1), [samples, streamLive.value]));
    const axis = live.axis;
    // On the chart's axis, by time alone: nothing is dropped for falling between samples. PACKED over a window's
    // width to the LEFT of the screen as well as what is on it, so a bar keeps its row while the chart scrolls,
    // instead of the rows re-packing under it on every tick as bars leave. The minimum drawn width is a fraction of
    // the axis, which does not change while it scrolls at one width.
    const lastT = samples.at(-1)?.t;
    const placed = axis
        ? placeEvents(axis, eventsIn(events, axis.from - (axis.to - axis.from), axis.to), lastT != null ? lastT + sampleGraceMs() : undefined)
        : [];
    // The CONTROL still shows when everything is filtered out — otherwise hiding the last kind hides the way
    // to bring it back.
    if (!axis || !runs.length || (!placed.length && !all.length)) return null;
    const spans = placed.filter((p) => p.event.until != null);
    // Packed at the width a bar is DRAWN at, never less (see MIN_BAR_PX).
    const minSpan = Math.max(MIN_EV_SPAN, laneWidthPx.value > 0 ? MIN_BAR_PX / laneWidthPx.value : 0);
    // Bars may pack FLUSH: a run's steps follow each other within milliseconds, and `.rc-ev`'s hairline keeps two
    // touching bars reading as two.
    const rows = laneRows(spans, 4, minSpan);
    const [pulsed, setPulsed] = useState<string | null>(null);
    const lit = lineageOf(events, eventHover.value?.p.event.id);
    const litFn = litBy(events, eventHover.value?.p.event);
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
        <div class="rc-lane" onPointerEnter={holdAxis} onPointerMove={holdAxis}
            onPointerLeave={(e: PointerEvent) => { eventHover.value = null; hoverAt.value = null; hoverModel.value = null; releaseAxis(e); }}>
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
            {showLane.value ? <div class="rc-lane-rows" style={{ height: `${laneH.value}px` }}
                ref={(el) => { const w = el?.clientWidth ?? 0; if (w > 0 && w !== laneWidthPx.value) laneWidthPx.value = w; }}>{rows.map((row, ri) => (
                <div class="rc-lane-row" key={ri}
                    onPointerDown={startBrush(runs)}
                    onPointerMove={trackCursor("lane")}>
                    {/* The SAME selection box the tracks draw. The lane already took the drag — it shares
                        `startBrush` — but showed nothing while you made it, so the gesture worked and looked
                        like it had not: you released and the window jumped with no sign of what you had
                        chosen. Every surface on this axis draws the same fractions, which is the point of
                        the axis being shared. */}
                    <BrushOverlay runs={runs} />
                    {/* Only what reaches the screen is drawn; the rest was packed so its row is ready. */}
                    {row.filter((p) => Math.max(p.to, p.from + minSpan) >= 0 && p.from <= 1).map((p) => {
                                const e = p.event;
                                const w = Math.max(minSpan * 100, (p.to - p.from) * 100);   // packed at this width too
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
                                const away = !!litFn && !litFn(e);
                                return (
                                    <button class={`rc-ev rc-ev-${e.kind}${e.ref ? " linked" : ""}${away ? " away" : ""}${e.open ? " open" : ""}${e.id && e.id === pulsed ? " pulse" : ""}`} key={barKey(e)}
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
                                        // …and WHAT it is, for the same reason: two asides of one model (a session's
                                        // title and a code annotation) are otherwise told apart only by hovering.
                                        data-label={e.label}
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
                                        {/* Every other STRIPED phase (a load inside a step, a cache swap, a cold
                                            start): the gradient carries a flat stop for it, and its stripes are
                                            drawn here. In the gradient they made the whole background invalid,
                                            and the block vanished. A load's own bar has its stripes already. */}
                                        {e.phases && total > 0 && e.kind !== "load"
                                            ? phaseSpans(e.phases, e.t, total)
                                                .filter((ph) => ph.kind !== "wait" && ph.kind !== "context" && ph.end > ph.start && isPattern(phaseFill(ph.kind, e.model)))
                                                .map((ph, pi) => (
                                                    <i class="rc-ev-pattern" key={`p${pi}`}
                                                        style={{ left: `${ph.start * 100}%`, width: `${(ph.end - ph.start) * 100}%`, background: phaseFill(ph.kind, e.model) }} />
                                                ))
                                            : null}
                                    </button>
                                );
                            })}
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
