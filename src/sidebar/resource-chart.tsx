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
    placeEvents, laneRows, eventsIn, lineageOf, timeAtFraction, sampleAtFraction, MIN_EV_SPAN, scrubExtent, scrubTo, TAIL_SLACK_MS,
    scopeToSpan, scopeAround, scrubZone, scrubResize, scrubNudge, wheelScrubFraction,
    filterEvents, countByKind, sessionWindow, type ResourceEvent, type EventPlacement, type PhaseKind,
    OTHER_BAND_NOTE, DRIVER_BAND_LABEL,
    presetsFor,
    type ResourceSample, type Band, type Capacity, type TrackDef,
} from "../resource-model";
import { colorFor, poolColor, hoverModel, poolHover, poolFacts, hiddenPools, togglePool, ModelFacts, CostFacts, VRAM_POLL_MS, laneFilter, scopedHash, streamLive, sampleGapMs, sampleGraceMs } from "./vram";
import { models, ollamaIds, loadedModels, resWindowS, view, zoomRange, brush, crosshair, laneHidden, laneScoped, LANE_HIDDEN_KEY, LANE_SCOPE_KEY, showLane, showModels, SECTIONS_KEY, laneLitSeqs } from "./store";
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
/** Read the cursor for a surface, or null when the pointer is somewhere else. */
const cursorOn = (surface: string) => (hoverAt.value?.surface === surface ? hoverAt.value : null);
/** Track a pointer against the viewport, tagged with the surface it is over. */
const trackCursor = (surface: string) => (e: PointerEvent) => {
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
    const models = new Set<string>();
    for (const bands of frames) for (const b of bands) if (b.kind === "model" || b.kind === "unknown") models.add(b.key);
    return [...[...models].sort(), "other", "free"];
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

const bandFill = (key: string, model: string | undefined): string => {
    if (key === "free") return "transparent";
    if (key === "other" || key === "unknown") return "var(--fg-faint)";
    return model ? colorFor(model) : "var(--fg-faint)";
};

/** One device (or the host pool) as a stacked area over time. `frames` is one band list per sample. */
function StackedArea({ frames, ceiling, hidden, scope }: { frames: Band[][]; ceiling: number; hidden: Set<string>; scope: string }) {
    const order = useMemo(() => bandOrder(frames), [frames]);
    const identity = useMemo(() => bandIdentity(frames), [frames]);
    if (frames.length < 2 || ceiling <= 0) return <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" />;
    const x = (i: number) => (i / (frames.length - 1)) * W;
    const y = (v: number) => H - Math.min(1, v / ceiling) * H;

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

    const areas = order.filter((k) => k !== "free").map((key, ki, keys) => {
        const below = ki === 0 ? null : keys[ki - 1];
        const top = tops[key] || [];
        const pts: string[] = [];
        for (let i = 0; i < frames.length; i++) pts.push(`${x(i).toFixed(1)},${y(top[i] ?? 0).toFixed(1)}`);
        for (let i = frames.length - 1; i >= 0; i--) pts.push(`${x(i).toFixed(1)},${y(below ? (tops[below]?.[i] ?? 0) : 0).toFixed(1)}`);
        // The band knows which model it is, so hovering it can name it — and dim its neighbours, so a stack of
        // similar colours resolves into one identifiable shape.
        const model = identity[key];
        const dim = hoverModel.value && model && hoverModel.value !== model;
        const hot = !!model && hoverModel.value === model;
        return <polygon key={key} points={pts.join(" ")} fill={bandFill(key, model)}
            class={model ? `rc-band${hot ? " hot" : ""}` : undefined} vector-effect="non-scaling-stroke"
            onPointerEnter={model ? (e: PointerEvent) => { hoverModel.value = model; trackCursor(scope)(e); } : undefined}
            onPointerLeave={model ? () => { hoverModel.value = null; hoverAt.value = null; } : undefined}
            opacity={dim ? 0.18 : key === "other" ? 0.35 : 0.75} />;
    });
    return (
        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {areas}
        </svg>
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
    hidden: Set<string>;
    /** Instants to rule through this plot (evictions). Spans live in the lane below, not here. */
    events?: ResourceEvent[];
}

/** One track: a header carrying the denominator, then the stacked history, gaps left as gaps. */
export function DeviceView({ label, samples, bandsOf, ceiling, soft, ceilingNote, hidden, events = [] }: DeviceViewProps) {
    const scope = `track:${label}`;   // one track per pool, so the label identifies the surface
    const latest = samples.at(-1);
    const bands = latest ? bandsOf(latest) : [];
    const used = bands.filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    // Each contiguous run is drawn separately — a gap is a gap, never interpolated across.
    // A run of ONE sample has no shape to draw — StackedArea needs two points — and giving it a 2px column
    // leaves a pale sliver where the band wash is missing, which reads as a rendering artifact rather than as
    // data. Undrawable runs are skipped; nothing is lost, because a lone point conveys no trend either.
    const runs = useMemo(() => segments(samples, sampleGapMs()).filter((r) => r.length > 1), [samples, streamLive.value]);
    // Only the instants: a span is a duration and belongs in the lane, where its length can be read.
    const instants = useInstants(runs, events);
    // The DATAPOINT under the pointer, resolved through the same segmented geometry the crosshair uses, so
    // the tooltip's figures and the instant the crosshair names are the same sample and cannot drift apart.
    const hoverSample = hoveredSample(runs, scope);
    return (
        <div class="rc-track">
            <div class="rc-head">
                <span class="rc-name">{label}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    {formatShare(used, ceiling, "/")}
                    {/* RIGHT-anchored (the default): this figure sits at the panel's right edge, so a
                        left-anchored pop extends rightward and is clipped. `wrap` because it is prose. */}
                    <span class="tt-pop wrap" role="tooltip">{ceilingNote}</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor(scope)(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => { hoverAt.value = null; hoverModel.value = null; eventHover.value = null; crosshair.value = null; }}>
                {runs.map((run, i) => (
                    <div class="rc-seg" key={i} style={{ flex: `${Math.max(1, run.length)} 1 0` }}>
                        <StackedArea frames={run.map(bandsOf)} ceiling={ceiling} hidden={hidden} scope={scope} />
                        <InstantRules instants={instants} run={i} scope={scope} />
                        <HoverSpan run={i} scope="lane" />
                    </div>
                ))}
                <BrushOverlay />
                <Crosshair />
                {soft ? <div class="rc-soft" style={{ bottom: `${Math.min(100, (soft.bytes / ceiling) * 100)}%` }}
                    title={soft.label} /> : null}
                <BandTip bands={bands} frame={hoverSample ? bandsOf(hoverSample) : null}
                    history={samples.map(bandsOf)} ceiling={ceiling} scope={scope} at={hoverSample} />
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
                        <i class="rc-swatch rc-swatch-other" /> {b.label} {formatBytes(b.bytes)}
                        {/* The label is kept compact, so the SHARE of the pool — the thing that says whether a
                            figure matters — lives in the hover text. */}
                        <span class="tt-pop left above" role="tooltip">{formatShare(b.bytes, ceiling)} — {b.label === DRIVER_BAND_LABEL
                            ? "Ollama's own driver context, held on every visible card whether or not a model is loaded. Not another process."
                            : OTHER_BAND_NOTE}</span>
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
    if (!c || !cursorOn(scope)) return null;
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
            <span>{hhmmss(at.t)}</span>
            {/* "how long ago" is what makes a clock time mean something at a glance on a plot with no axis
                labels; the clock time is what makes it comparable with the transcript and the event lane. */}
            <span class="rc-tip-ago">{ago < 1500 ? "now" : `${fmtAge(ago)} ago`}</span>
        </div>
    );
}

/** What the hovered band is, shown over the plot. Deliberately the SAME facts as the legend row (ModelFacts),
 *  because a band and its row describe one model — an SVG <title> could carry none of it: no colour, no live
 *  TTL, no badge, and a half-second delay before it appears. */
function BandTip({ bands, frame, history, ceiling, scope, at: hoverSample }: { bands: Band[]; frame: Band[] | null; history: Band[][]; ceiling: number; scope: string; at: ResourceSample | null }) {
    const name = hoverModel.value;
    const at = cursorOn(scope);
    if (!name || !at) return null;
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
    const gone = !bands.some((b) => b.model === name);
    const m = (loadedModels.value || []).find((x) => x.model === name);
    // Follows the cursor, offset up-left so it never sits under the pointer (which would flicker as the
    // pointer enters the tip itself) and clamped inside the plot so it can't run off the narrow panel.
    const { ref, style } = useTipPlacement(at);
    return (
        // A STACK, not a row: name, then the figure, then the badges. On one line the name and the figure set
        // the tip's width and every shorter line left a slab of empty space beside it.
        <div class="rc-tip rc-tip-model" role="tooltip" ref={ref} style={style}>
            <div class="rc-tip-line"><i class="rc-tip-dot" style={{ background: colorFor(name) }} />
                <span class="rc-tip-name">{name}</span></div>
            {/* Bytes AND the share of this device — a model is "big" only relative to the card it is on. */}
            <div class="rc-tip-line"><span class="rc-tip-size">{formatBytes(band.bytes)} <span class="rc-tip-pct">({percentOf(band.bytes, ceiling)})</span></span></div>
            <SampleStamp at={hoverSample} />
            {/* The figure above is from an instant that has passed, so the tip has to say whether the model is
                STILL there — otherwise a reader takes a historical reading for a current one, which is the
                one misreading a time-travelling tooltip makes easy. Its row is also gone from the list
                below, so this is the only place that can explain why the colour is still on the chart. */}
            {gone ? <span class="rc-tip-gone">not resident now</span> : null}
            {/* Badges and cost each break onto their OWN line. On one line the tip grew past the panel and was
                clipped at the window edge — and the figure that matters (how much, what share) is the part
                that got cut. */}
            {m ? <div class="rc-tip-facts"><ModelFacts m={m} tips={false} /></div> : null}
            <CostFacts model={name} />
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
            <div class="rc-tip-line"><span class="rc-tip-name">{label}</span>
                <span class="rc-tip-size">{formatShare(used, ceiling)}</span></div>
            <SampleStamp at={at} />
            {/* Named, because "62% full" invites "of what" as the immediate next question, and the answer is
                on the screen already but only in a list that shows the PRESENT. */}
            {models.length
                ? <div class="rc-tip-line rc-tip-dim rc-tip-holders">{models.map((b) => (
                    <span class="rc-tip-consumer" key={b.key}>
                        <i class="rc-tip-dot" style={{ background: colorFor(b.model!) }} />{b.model}</span>))}</div>
                : <div class="rc-tip-line rc-tip-dim">nothing resident</div>}
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
function PoolsTip({ pools, latest, at: hoverSample, fracOf, usedOf }: {
    pools: { id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] }[];
    latest: ResourceSample;
    at: ResourceSample | null;
    fracOf: (s: ResourceSample, p: any) => number;
    usedOf: (s: ResourceSample, p: any) => number;
}) {
    const cur = cursorOn("overlay");
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
    const picked = poolHover.value ? rows.find((r) => r.p.id === poolHover.value!.id) : null;
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
                                    {c.model && !now.has(c.label) ? <span class="rc-tip-gone">gone</span> : null}
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
    const cap = latest.capacity!;
    const deviceOf = (id: string) => cap.devices.find((d) => d.id === id.replace(/^vram\./, ""));
    const first = def.series[0] ?? "";
    const isHost = first === "ram" || first === "mem";

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
            return <DeviceView label={label} samples={samples} bandsOf={hostBands}
                ceiling={c?.hardBytes ?? cap.host.totalBytes} ceilingNote={note}
                soft={c?.softBytes ? { bytes: c.softBytes, label: c.softLabel || "" } : null} hidden={hidden} events={events} />;
        }
        const d = deviceOf(first);
        if (!d) return null;
        const c = ceilingsFor(latest, d.id);
        return <DeviceView label={d.name} samples={samples} bandsOf={(s) => deviceBands(s, d.id)}
            ceiling={c?.displayBytes ?? d.totalBytes} ceilingNote={deviceCeilingNote(d)}
            soft={c?.softBytes ? { bytes: c.softBytes, label: c.softLabel || "" } : null} hidden={hidden} events={events} />;
    }
    return <OverlayView def={def} samples={samples} latest={latest} hidden={hidden} events={events} />;
}

/** Several series in ONE track, drawn as independent lines rather than a stack: their sum is not a quantity
 *  anything is measured against (a model can only use one card's capacity), so the chart must not draw one. */
function OverlayView({ def, samples, latest, hidden, events = [] }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string>; events?: ResourceEvent[] }) {
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

    const runs = segments(samples, sampleGapMs()).filter((r) => r.length > 1);
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
                onPointerLeave={() => { hoverAt.value = null; leavePool(); crosshair.value = null; }}>
                <BrushOverlay />
                <Crosshair />
                <PoolsTip pools={pools.map((p, pi) => ({ ...p, color: poolColor(pi, pools.length) }))}
                    latest={latest} at={hoveredSample(runs, "overlay")} fracOf={frac} usedOf={usedOf} />
                {/* This view has rules of its own now, so it needs the tip that explains them. */}
                <EventTip scope="overlay" />
                {runs.map((run, ri) => (
                    <div class="rc-seg" key={ri} style={{ flex: `${Math.max(1, run.length)} 1 0` }}>
                        <InstantRules instants={instants} run={ri} scope="overlay" />
                        <HoverSpan run={ri} scope="lane" />
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {pools.map((p, pi) => {
                                const pts = run.map((s, i) => `${((i / (run.length - 1)) * W).toFixed(1)},${(H - frac(s, p) * H).toFixed(1)}`).join(" ");
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
                        title={hiddenPools.value.has(p.id) ? `Show ${p.name}` : `Hide ${p.name}`}
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
/** A phase's swatch, matching its stripe in the bar exactly — so the tooltip's sections and the block's parts
 *  are visibly the same three things, rather than a list you have to map onto a picture yourself. */
const loadStripes = (model?: string): string => {
    const c = model ? colorFor(model) : "var(--warn, #f59e0b)";
    return `repeating-linear-gradient(45deg, ${c} 0 3px, var(--panel) 3px 8px)`;
};

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
        // work; the difference between them is weight, so the divider is what reads.
        : kind === "weights" ? loadStripes(model)
        : kind === "context" ? `repeating-linear-gradient(45deg, color-mix(in srgb, ${base} 45%, transparent) 0 3px, var(--panel) 3px 8px)`
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
        return placeEvents(runs, eventsIn(events.filter((e) => e.until == null), from, to + sampleGraceMs()), sampleGraceMs());
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
function applyScrub(next: { from: number; to: number }, ex: { to: number }): void {
    zoomRange.value = next.to >= ex.to - TAIL_SLACK_MS ? null : next;
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
        const move = (ev: PointerEvent) => {
            if (ev.buttons === 0 && ev.type === "pointermove") return up();
            zoomRange.value = zone === "from" || zone === "to"
                ? scrubResize(ex, start, zone, at(ev.clientX))
                : scrubTo(ex, win, at(ev.clientX));
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            // Dropped against the right edge → back to live, rather than a pinned window that happens to end
            // at the tail and then falls behind it as new samples arrive.
            const z = zoomRange.value;
            if (z && z.to >= ex.to - TAIL_SLACK_MS) zoomRange.value = null;
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
                    const by = wheelScrubFraction(ev.deltaX, ev.deltaY, ev.deltaMode, b.width);
                    if (!by) return;
                    applyScrub(scrubNudge({ from: ex.from, to: ex.to }, win, by), ex);
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
            {geom && showLane.value ? (
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
function Crosshair() {
    const c = crosshair.value;
    if (!c) return null;
    // Past the middle the label would run off the right edge, so it hangs on the other side of the line.
    const flip = c.frac > 0.72;
    return (
        <div class="rc-cross" style={{ left: `${c.frac * 100}%` }}>
            {c.t != null ? <span class={`rc-cross-t${flip ? " flip" : ""}`}>{clockAt(c.t, c.msPerPx ?? Infinity)}</span> : null}
        </div>
    );
}

/** Track the pointer along the time axis. The fraction positions the line; the TIME comes from the same
 *  segmented mapping the brush uses, because the axis is not linear and a label read off the pixels would
 *  name the wrong instant. */
const trackCrosshair = (runs: ResourceSample[][]) => (e: PointerEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
    // How much time ONE PIXEL is worth here, which is what decides whether milliseconds mean anything in the
    // label: zoomed into ten seconds they do, over five minutes of history they are noise.
    const first = runs[0]?.[0]?.t, last = runs.at(-1)?.at(-1)?.t;
    const msPerPx = first != null && last != null && box.width > 0 ? (last - first) / box.width : Infinity;
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
function BrushOverlay() {
    const b = brush.value;
    if (!b) return null;
    const from = Math.min(b.from, b.to), to = Math.max(b.from, b.to);
    return <div class="rc-brush" style={{ left: `${from * 100}%`, width: `${Math.max(0, to - from) * 100}%` }} />;
}

/** Drag across a plot to select a time range (and release to apply it). The fractions are mapped back to TIME
 *  through the same segmented geometry events are placed with — the axis is not linear, so a range read off
 *  the pixels alone would select a different stretch than the one under the pointer. */
const startBrush = (runs: ResourceSample[][]) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = (e.currentTarget as HTMLElement);
    const box = el.getBoundingClientRect();
    const frac = (x: number) => Math.min(1, Math.max(0, (x - box.left) / Math.max(1, box.width)));
    const start = frac(e.clientX);
    let moved = false;
    brush.value = { from: start, to: start };
    const move = (ev: PointerEvent) => {
        if (ev.buttons === 0) return up(ev);
        moved = true;
        brush.value = { from: start, to: frac(ev.clientX) };
    };
    const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const end = frac(ev.clientX);
        brush.value = null;
        // A CLICK is not a selection: without this every click on the chart would zoom to an instant.
        if (!moved || Math.abs(end - start) < 0.01) return;
        const a = timeAtFraction(runs, Math.min(start, end)), b = timeAtFraction(runs, Math.max(start, end));
        if (a != null && b != null && b > a) zoomRange.value = { from: a, to: b };
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

function EventTip({ scope }: { scope: string }) {
    const h = eventHover.value, at = cursorOn(scope);
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
    const overheadMs = e.cost?.evalMs != null && e.cost.wallMs != null
        ? Math.max(0, e.cost.wallMs - e.cost.evalMs - (promptMs ?? 0)) || null : null;
    const phases = (e.phases || []).map((ph, i) => ({ ...ph, from: i ? e.phases![i - 1].until : e.t }));
    // The two halves of a load, in bytes: the weights as the server measured them, and the context as the
    // difference between the whole load and the weights. Null unless the server reported both.
    const phaseBytes = (kind: string): number | null =>
        kind === "weights" ? (e.weightsBytes ?? null)
        : kind === "context" ? (e.loadBytes != null && e.weightsBytes != null ? e.loadBytes - e.weightsBytes : null)
        : null;
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
            <div class="rc-tip-note">{e.kind === "evict"
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
                        <span class="rc-tip-size">{ms(ph.until - ph.from)}</span></div>
                </>
            ))}
            {/* An OPEN span has no end yet, so every duration in this tooltip is "so far". Said once, plainly,
                because the alternative is a reader taking a number that is still growing as a measurement. */}
            {e.open ? <div class="rc-tip-note">still running — these durations are so far, not final</div> : null}
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
                    h.p.clipped ? "continues past what was measured" : null,
                    e.ref ? `click to open this ${e.ref.seq != null ? "step" : "run"}` : null,
                ].filter(Boolean) as string[];
                return notes.map((n, i) => <div class={`rc-tip-note${i === 0 ? " sep" : ""}`} key={n}>{n}</div>);
            })()}
            {/* WHEN, exactly. The durations say how long each part took; this is what lets a block be lined up
                against another one, or against a timestamped log. Milliseconds because an event's own timings
                are exact — unlike the crosshair, which interpolates between samples. */}
            <div class={`rc-tip-when${(e.kind === "load" || e.kind === "aside" || h.p.clipped || e.ref) ? "" : " sep"}`}>{hhmmssms(e.t)} → {hhmmssms(e.until ?? e.t)}</div>
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
    const runs = useMemo(() => segments(samples, sampleGapMs()).filter((r) => r.length > 1), [samples, streamLive.value]);
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
            {showLane.value ? rows.map((row, ri) => (
                <div class="rc-lane-row" key={ri}
                    onPointerDown={startBrush(runs)}
                    onPointerMove={trackCursor("lane")}>
                    {runs.map((run, i) => (
                        <div class="rc-lane-seg" key={i} style={{ flex: `${Math.max(1, run.length)} 1 0` }}>
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
            )) : null}
            <EventTip scope="lane" />
            <LaneFilterBar counts={counts} shown={events.length} total={all.length} />
        </div>
    );
}

/** What the lane is drawing, and what it is leaving out. Each kind is a chip with its count: a filter that
 *  makes you toggle blindly to find out what it hides is worse than none. */
function LaneFilterBar({ counts, shown, total }: { counts: Record<string, number>; shown: number; total: number }) {
    const hidden = new Set(laneHidden.value);
    const KINDS: { kind: ResourceEvent["kind"]; label: string }[] = [
        { kind: "run", label: "runs" }, { kind: "session", label: "sessions" },
        { kind: "tool", label: "steps" }, { kind: "gen", label: "calls" },
        { kind: "embed", label: "sub-calls" }, { kind: "load", label: "loads" }, { kind: "evict", label: "evictions" },
        // What the BOX was doing, as opposed to what this browser asked for — a serving span covers traffic
        // from any client, which is exactly why it is worth drawing and why it is separately hideable.
        { kind: "serve", label: "serving" },
    ];
    const toggle = (k: string) => {
        const next = hidden.has(k) ? laneHidden.value.filter((x) => x !== k) : [...laneHidden.value, k];
        laneHidden.value = next;
        try { chrome.storage.local.set({ [LANE_HIDDEN_KEY]: next }); } catch { /* opaque origin */ }
    };
    const open = showLane.value;
    // What is in there, on the header — the thing that makes the row worth opening. Counts only, no filter
    // state: a filter is about what is DRAWN, and nothing is drawn while it is closed.
    const summary = KINDS.filter((k) => counts[k.kind]).map((k) => `${counts[k.kind]} ${k.label}`).join(" · ");
    const setOpen = (v: boolean) => {
        showLane.value = v;
        try { chrome.storage.local.set({ [SECTIONS_KEY]: { lane: v, models: showModels.value } }); } catch { /* opaque origin */ }
    };
    return (
        // The SAME disclosure the two sections directly below it use (`agent options`, `other models on the
        // box`), rather than a bespoke chevron in a box beside a row of chips — which read as unrelated
        // chrome and gave no hint that the chips and the fold were the same control. Header: what it is, and
        // how much of it there is. Body: the filters, beside the lane they filter.
        <Disclosure label="events" note={summary} open={open} onToggle={setOpen}>
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
        </Disclosure>
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
    const window_ = useMemo(() => {
        const z = zoomRange.value;
        if (z) return z;
        if (scopedWindow) return scopedWindow;
        const secs = resWindowS.value;
        if (!secs) return null;                    // "everything" — no window to draw
        const now = Date.now();
        return { from: now - secs * 1000, to: now };
    }, [resWindowS.value, zoomRange.value, samples.length, scopedWindow]);
    const windowed = useMemo(
        () => (window_ ? samples.filter((s) => s.t >= window_.from && s.t <= window_.to) : samples),
        [samples, window_]);
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
        const width = (e.currentTarget as HTMLElement).getBoundingClientRect().width;
        const by = wheelScrubFraction(e.deltaX, e.deltaY, e.deltaMode, width);
        if (!by) return;
        applyScrub(scrubNudge({ from: ex.from, to: ex.to }, w, by), ex);
        e.preventDefault();
        e.stopPropagation();
    };
    return (
        <>
            <div class="rc" onWheel={wheelScrub}>
                {tracks.map((t) => <TrackView key={t.id} def={t} samples={filled} latest={latest} hidden={hidden} events={shown} />)}
            </div>
            {/* Directly under the tracks: where this window sits in the whole session. It sits ABOVE the lane
                rather than below it because the lane RE-PACKS as the window moves — a step entering the view
                can add a row — and anything below a control whose height changes shifts out from under the
                pointer mid-drag. The strip is the thing being dragged, so it goes where nothing moves it. */}
            <ScrubStrip samples={samples} window={window_} events={stripEvents} />
            {/* And below that, sharing the tracks' x-axis: what happened, against what memory was doing. The
                connector says the second is the first opened out — see ZoomLink. */}
            {/* ALWAYS rendered: `showLane` collapses its ROWS, and its chip row is the control that brings
                them back. Gating the component itself is what made the only way in a settings checkbox. */}
            <EventLane samples={filled} events={shown} session={samples} />
        </>
    );
}

/** Models resident on the CPU — they hold no VRAM, so they never appear in a device track and would otherwise
 *  vanish from the panel entirely. */
export const cpuResident = (s: ResourceSample | undefined) => (s?.models ?? []).filter(isCpuResident);
