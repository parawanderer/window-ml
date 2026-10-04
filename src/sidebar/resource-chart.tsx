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
import { Fragment } from "preact";
import { useMemo, useState, useEffect } from "preact/hooks";
import {
    ceilingsFor, formatBytes, formatShare, isCpuResident,

    type ResourceEvent,

    type ResourceSample, type Capacity, type DeviceCapacity,
} from "../resource-model";
import { ribbonSpans } from "../resource-gens";
import { boxAxis, presetsFor, type TrackDef } from "../resource-presets";
import { bridgeOrder, bridgeWalls, linkPhrase, linkBetween, isBridge } from "../resource-topology";
import {
    segments, chartWindow, axisOf, scrubExtent, scrubPinch,
    windowSamples, scrubNudge, wheelScrubFraction, runWeight, runFrac, runGap} from "../resource-axis";
import { scopeToSpan, filterEvents, sessionWindow } from "../resource-lane";
import { deviceBands, hostBands, OTHER_BAND_NOTE, residualRank, type Band } from "../resource-bands";
import { editLayout, capacity, poolColor, hiddenPools, togglePool, VRAM_POLL_MS, laneFilter, streamLive, sampleGapMs, layout } from "./panel-state";
import { chartHeld, enterPool, eventHover, HOLD_LAPSE_MS, holdAxis, holdKey, hoverAt, hoverPool, lastPointerAt, leavePool, live, noteRuns, poolHover, readingSurface, releaseAxis, snapUnder, tipMuted, trackCursor } from "./chart-interaction";
import { hoverModel, kbFocus, kbPool } from "./vram-focus";
import { scopedHash, resWindowS, zoomRange, crosshair, laneScoped, laneEnabled, predictView } from "./store";
import { startBrush, BrushOverlay, EventTip, EventLane } from "./resource-lane-ui";
import { W, H, bandFill } from "./chart-paint";
import { useInstants, PhaseStrip, trackCrosshair, TimeGrid, onAxis, PredictLines, InstantRules, HoverSpan, Crosshair, AXIS_TICK_MS } from "./resource-overlays";
import { StackedArea, KvFill } from "./resource-area";
import { hoveredSample, BandTip, PlotTip, GapTip, PoolsTip, UtilTip, utilOf } from "./resource-tips";
import { settleScrub, ScrubStrip } from "./resource-scrub";

/** Mute the cursor tip if one is showing, and say whether that happened — so the Esc handler can fall through
 *  to leaving the zoom when there was nothing to hide. The decision lives HERE, beside the signals it reads,
 *  rather than exporting the hover state so another module can ask the same question less well. */
export function muteTip(): boolean {
    if (!hoverAt.value || tipMuted.value) return false;
    tipMuted.value = true;
    return true;
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
/** The links from this card to every OTHER card, as rows of the facts grid — one per peer, direct fabric first.
 *  A link belongs to a PAIR, never to one card, so there is no single "interconnect" line. */
function DeviceLinks({ device }: { device: DeviceCapacity }) {
    const cap = capacity.value;
    const t = cap?.topology;
    const peers = (cap?.devices ?? []).filter((d) => d.id !== device.id);
    const cards = peers.length === 1 ? "card" : "cards";
    if (!t) return <span class="rc-df-note">Links to the other {cards}: not reported by this server — nothing is assumed either way.</span>;
    if (t.status === "unavailable" || !device.pciId) return (
        <span class="rc-df-note">Links to the other {cards}: could not be measured{t.detail ? <> (<code>{t.detail}</code>)</> : null} — that is not "no NVLink".</span>
    );
    const rows = peers.map((p) => ({ p, l: linkBetween(t, device.pciId, p.pciId) }))
        .sort((x, y) => Number(isBridge(y.l)) - Number(isBridge(x.l)));
    return (
        <>
            <span class="rc-df-grid">
                {rows.map(({ p, l }) => (
                    <>
                        <span class="rc-df-k" key={`k:${p.id}`}>to {p.name}</span>{" "}
                        <span class={`rc-df-v rc-df-wide${l ? "" : " rc-df-miss"}`} key={`v:${p.id}`}>{l
                            ? linkPhrase(l)
                            : "missing from the server's link list — a bug on one side, not a PCIe link"}</span>{" "}
                    </>
                ))}
            </span>
            {t.status !== "measured" ? <span class="rc-df-note">Only partly measured{t.detail ? <> (<code>{t.detail}</code>)</> : null}.</span> : null}
        </>
    );
}

/**
 * A CARD'S OWN FACTS, behind its name on the track header: what the card IS, then a grid of short label/value
 * rows, then the one explanation that is always needed, in a quiet line. It was a column of sentences in two
 * weights, and the figures sat in the middle of them — hard to read, and the explanation of each number was as
 * loud as the number.
 *
 * The header says what the card is in the driver's own words (`description`, from a patched server) beside the
 * backend's label and the bus address — the same identity the fault banner uses, so a card can be recognised
 * before and after it fails.
 */
function DeviceFacts({ device, label }: { device: DeviceCapacity; label: string }) {
    // How many OTHER devices there are — a single card has no pair to have a link with, so the
    // interconnect rows are shown only where the question exists.
    const others = (capacity.value?.devices.length ?? 1) - 1;
    const two = device.physicalBytes && device.physicalBytes !== device.totalBytes;
    const row = (k: string, v: preact.ComponentChildren, note?: string) => (
        <>
            <span class="rc-df-k">{k}</span>{" "}<span class="rc-df-v">{v}</span>{" "}
            {note ? <span class="rc-df-n">{note}</span> : <span />}{" "}
        </>
    );
    return (
        // THE NAME STAYS THE NAME. A `.tt-pop` only works inside an element carrying `tt`, so the trigger is a
        // WRAPPER around `.rc-name` rather than `.rc-name` itself — put the tooltip inside the name element
        // and the name's own text content becomes the name plus the whole tooltip, which every reader of that
        // element then picks up. The panel reads `.rc-name` as a label in several places.
        <span class="tt rc-devfacts">
            <span class="rc-name">{label}</span>
            <span class="tt-pop wide" role="tooltip"><span class="rc-df">
                <span class="rc-df-head"><b>{device.name}</b>{device.description ? <> · {device.description}</> : null}</span>{" "}
                <span class="rc-df-sub">{device.runner}{device.unified ? " · unified memory" : ""}{device.pciId ? <> · <code>{device.pciId}</code></> : null}</span>{" "}
                <span class="rc-df-grid">
                    {/* THE TWO TOTALS, and which decides what — the counter-intuitive one, and the reason the hover
                        exists at all. */}
                    {row("usable", formatBytes(device.totalBytes), "what placement decides against")}
                    {two ? row("on the card", formatBytes(device.physicalBytes!), "what the driver and nvidia-smi report") : null}
                    {/* THE CARD'S CEILINGS, fixed properties read once — never live readings. Bandwidth is what decode
                        is bound by; the host link rules ITSELF out (it sets load time, and almost nothing about
                        inference), and the width is the narrower of card and slot. */}
                    {device.memoryBandwidth ? row("bandwidth", `${(device.memoryBandwidth / 1e12).toFixed(2)} TB/s`, "the ceiling decode is bound by") : null}
                    {/* WHAT DECODE ACTUALLY GETS, measured on this box (`compute.profile`): the rated figure above is a
                        ceiling, this is the gap between the roofline and what any model reaches — 90% of rated on the
                        box it was built against. The per-layer cost is why a deep, narrow model falls furthest below
                        its roofline. Said plainly while it has not been measured, and with the engine's words when it
                        could not be. */}
                    {(() => {
                        const dp = device.decodeProfile, prof = capacity.value?.profile;
                        const failed = prof?.failures.find((f) => device.pciId && f.pciIds.includes(device.pciId));
                        if (dp) return row("at decode", `${(dp.bandwidth / 1e12).toFixed(2)} TB/s${device.memoryBandwidth ? ` · ${Math.round((dp.bandwidth / device.memoryBandwidth) * 100)}% of rated` : ""}`,
                            `measured on this box${dp.tokenOverheadMs != null ? `; +${dp.tokenOverheadMs} ms every token` : ""}${dp.layerOverheadUs != null ? `, +${dp.layerOverheadUs.toFixed(1)} µs every layer` : ""}`);
                        if (failed) return row("at decode", "could not be measured", failed.error);
                        if (prof?.state === "pending") return row("at decode", "not measured yet", "measured once, the first time the box is idle for a minute with nothing loaded");
                        if (prof?.state === "measuring") return row("at decode", "being measured now", "a short run on an empty model; a request arriving interrupts it");
                        return null;
                    })()}
                    {device.pcieMaxGeneration || device.pcieMaxWidth
                        ? row("host link", `PCIe${device.pcieMaxGeneration ? ` Gen ${device.pcieMaxGeneration}` : ""}${device.pcieMaxWidth ? ` x${device.pcieMaxWidth}` : ""}`, "at most — sets how fast a model loads, not how fast it runs")
                        : null}
                    {device.compute ? row("compute", device.compute, device.driver ? `driver ${device.driver}` : undefined)
                        : device.driver ? row("driver", device.driver) : null}
                </span>
                {two ? <span class="rc-df-note">The two totals differ by what the driver reserves before anything loads; neither figure is wrong.</span> : null}
                {others > 0 ? <DeviceLinks device={device} /> : null}
            </span></span>
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
    const instants = useInstants(events);
    // WHAT THIS CARD WAS DOING — its phase ribbon, from the same (kind-filtered) events the rules come from.
    // Keyed on the COUNTS, never the arrays: `timeline()` rebuilds `events` every render (see AGENTS.md).
    const deviceCount = capacity.value?.devices.length ?? 1;
    const ribbon = useMemo(() => (device ? ribbonSpans(events, samples, device.id, deviceCount) : []),
        [events.length, samples.length, samples.at(-1)?.t, device?.id, deviceCount]);
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
            {/* WHAT THIS CARD WAS DOING, in a strip of its own ABOVE the plot rather than along its top edge: drawn on the
                plot, a card near full memory hid it in its own bands. Same axis as the plot, same runs and gaps. */}
            {/* Drawn drilled in too: hovering a lane generation drills the chart into its model, and that hover is exactly
                when the strip has something to show (the stretches of the hovered event, lit). Same height either way. */}
            {ribbon.length ? <PhaseStrip runs={runs} spans={ribbon} events={events} scope={scope} /> : null}
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
                <TimeGrid />
                {onAxis(runs, samples, scope, (run, i) => (<>
                        <StackedArea frames={run.map(bandsOf)} times={run.map((sm) => sm.t)} ceiling={ceiling} hidden={hidden} scope={scope}
                            deep={deep} loads={deep ? events.filter((e) => e.kind === "load" && e.model === deep.model && e.until != null) : []}
                            snapIndex={snapUnder(runs)?.run === i ? snapUnder(runs)!.index : null} />
                        {deep && laneGen && laneGen.model === deep.model
                            ? <KvFill run={run} bandsOf={bandsOf} deep={deep} ev={laneGen} /> : null}
                        {predictView.value && !deep && device
                            ? <PredictLines run={run} loads={events} deviceId={device.id} ceiling={ceiling} /> : null}
                    </>))}
                <InstantRules instants={instants} scope={scope} />
                <HoverSpan scope="lane" />
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                {soft ? <div class="rc-soft" style={{ bottom: `${Math.min(100, (soft.bytes / ceiling) * 100)}%` }}
                    title={soft.label} /> : null}
                <BandTip bands={bands} frame={hoverSample ? bandsOf(hoverSample) : null}
                    history={samples.map(bandsOf)} samples={samples} ceiling={ceiling} scope={scope} label={label}
                    cardId={device?.id} hidden={hidden} at={hoverSample} />
                {/* Hovering the plot ANYWHERE, not just a model's band, answers the question this track's
                    header answers for the present: how full was this pool, then. Without it the free area
                    and the space above the stack were the only parts of the chart that said nothing. */}
                {hoverSample && !hoverModel.value
                    ? <PlotTip at={hoverSample} bands={bandsOf(hoverSample)} ceiling={ceiling} label={label} hidden={hidden} scope={scope} />
                    : null}
                <EventTip scope={scope} />
                <GapTip scope={scope} />
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
 * reason `live.runs` is one: written DURING render, and a signal written during render re-enters rendering.
 */
// PER SURFACE: the overlaid view and a whole-box track both draw POOLS, and a layout can hold both — one shared
// list meant whichever rendered last owned the keys, and the whole-box view published none at all, so ↑↓ there
// fell through to stepping MODELS (nothing, on an idle box) under a tip that said "↑↓ pick a line".
const poolRefs = new Map<string, PoolRef[]>();
/** Publish the pools the arrow keys step through on `surface` — call it from the render that DRAWS them. */
export const notePools = (surface: string, pools: PoolRef[]): void => { poolRefs.set(surface, pools); };
/** Does the view being read draw POOLS (the overlaid lines, a whole-box track)? Decides which list the keys step. */
export const readingIsOverlay = (): boolean => readingSurface != null && poolRefs.has(readingSurface);
/** Cycle the focused POOL in the view being read, wrapping through "nothing picked out" at index 0. Hidden
 *  pools are skipped: switching one off takes it off the chart, so there is nothing left to point at. */
export function stepPool(dir: number): void {
    const shown = (poolRefs.get(readingSurface ?? "") ?? []).filter((p) => !hiddenPools.value.has(p.id));
    const list: (PoolRef | null)[] = [null, ...shown];
    const cur = kbPool.value ? kbPool.value.id : poolHover.value?.id ?? null;
    const at = list.findIndex((p) => (p?.id ?? null) === (cur ?? null));
    const next = list[((at < 0 ? 0 : at) + dir + list.length) % list.length];
    kbPool.value = { id: next?.id ?? null };
    if (next) enterPool(next); else leavePool();
}

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
    // SAID PER RUN of bridged cards, not per wall — the facts are about the run. A FULL MESH of more than two is
    // one line ("every pair directly linked"): listing its adjacent walls read as a chain, which is exactly the
    // shape it is not. A PARTIAL mesh keeps its bridge lines and names what is NOT linked ONCE, after the last:
    // the same twelve-pair list under each of seven bridges buried the reading it was there to qualify.
    const links: { label: string; phrase: string; note?: string }[] = [];
    for (let i = 0; i < walls.length;) {
        if (!walls[i].bridge || !walls[i].link) { i++; continue; }
        let j = i;
        while (j + 1 < walls.length && walls[j + 1].bridge && walls[j + 1].link) j++;
        const run = walls.slice(i, j + 1), cards = j - i + 2;
        const phrases = new Set(run.map((w) => linkPhrase(w.link!)));
        if (run[0].mesh === "full" && cards > 2 && phrases.size === 1) {
            links.push({ label: `${pools[i].name} … ${pools[j + 1].name}`,
                phrase: `all ${cards} cards, every pair directly linked (${(cards * (cards - 1)) / 2} pairs) · ${[...phrases][0]}` });
        } else {
            run.forEach((w, k) => links.push({
                label: `${pools[i + k].name} ═ ${pools[i + k + 1].name}`, phrase: linkPhrase(w.link!),
                note: k === run.length - 1 && w.mesh === "partial"
                    ? `these ${cards} cards are a PARTIAL mesh — not directly linked: ${w.unlinked.map(([a, b]) => `${pools[a].name}–${pools[b].name}`).join(", ")}` : undefined,
            }));
        }
        i = j + 1;
    }
    if (!pools.length) return null;
    const axis = boxAxis(pools);
    if (!axis.total) return null;
    const usedOf = (sm: ResourceSample, p: typeof pools[number]) =>
        p.bandsOf(sm).filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    const runs = noteRuns(segments(samples, sampleGapMs()).filter((r) => r.length > 1));
    const instants = useInstants(events);
    const held = pools.reduce((n, p) => n + usedOf(latest, p), 0);
    // THE SAME READING THE OVERLAID VIEW GIVES, because it is the same question asked of the same pools — this
    // view had none, so pointing at it (or at a key) answered nothing. Colours are the ones the bands are drawn
    // in; the pool you are pointing at is the band you are INSIDE, since the pools here own heights rather
    // than drawing lines to be near.
    const tipPools = pools.map((p) => {
        const bi = axis.bands.findIndex((b) => b.id === p.id);
        return { ...p, color: poolColor(bi < 0 ? 0 : bi, axis.bands.length) };
    });
    // ↑↓ step through THESE pools while the pointer is on this track, in the order they are stacked.
    notePools(scope, tipPools);
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
                <GapTip scope={scope} />
                <TimeGrid />
                {onAxis(runs, samples, scope, (run) => (<>
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
                    </>))}
                <InstantRules instants={instants} scope={scope} />
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
    const instants = useInstants(events);
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
                <GapTip scope={scope} />
                <TimeGrid />
                {onAxis(runs, samples, scope, (run) => (<>
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
                    </>))}
                <InstantRules instants={instants} scope={scope} />
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
    notePools("overlay", pools.map((p, pi) => ({ ...p, color: poolColor(pi, pools.length) })));

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
    const instants = useInstants(events);
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
                <GapTip scope="overlay" />
                <TimeGrid />
                {onAxis(runs, samples, "overlay", (run, ri) => (<>
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
                    </>))}
                <InstantRules instants={instants} scope="overlay" />
                <HoverSpan scope="lane" />
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

// THREE WAYS A HOLD ENDS, because the one that should suffice (`pointerleave`) is not delivered when the pointer leaves
// the panel's iframe for the page: moving anywhere in the panel off the chart; the shell saying the pointer is on the
// page; and the lapse, in the chart's tick.
if (typeof document !== "undefined") document.addEventListener("pointermove", (e) => {
    if (chartHeld.value && !(e.target as Element | null)?.closest?.(".rc, .rc-lane")) chartHeld.value = null;
}, { passive: true });

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
    // A live session FILLS its window and then scrolls at the width on screen, rather than growing to fit (which is a
    // continuous zoom, and snapped to a new window when the run ended): see `sessionWindow`.
    const scopedWindow = useMemo(
        () => (laneScoped.value ? sessionWindow(events, scopedHash(), Date.now(), { followMs: resWindowS.value * 1000 }) : null),
        [laneScoped.value, scopedHash(), events.length, samples.at(-1)?.t, resWindowS.value]);
    // KEYED ON THE NEWEST SAMPLE'S TIME, never on how many there are. The history is capped (RESOURCE_HISTORY), and a
    // streamed box reaches the cap in about twenty minutes; from then on every reading drops one and adds one, the
    // length never changes, and this memo never ran again. The window's right edge froze at the moment of the last
    // recompute, the scrub strip read the view as scrolled back ("⏸ live"), and the live button did nothing, because
    // it clears a zoom that was already clear.
    const window_ = useMemo(
        () => chartWindow(zoomRange.value, scopedWindow, resWindowS.value, Date.now(), samples[0]?.t),
        [resWindowS.value, zoomRange.value, samples.at(-1)?.t, samples[0]?.t, scopedWindow]);
    // The samples in the window, plus the nearest either side when the window is too narrow to draw itself —
    // see `windowSamples`. Zooming inside one long event used to leave fewer than two samples and an empty
    // chart, which reads as the panel having broken rather than as a window between two polls.
    // While the pointer holds the axis still (see chartHeld), the SAMPLES hold too: the window keeps moving as readings
    // arrive, and drawing the moved window's samples on the held axis left its left part empty under the pointer.
    // Read unconditionally, so the chart subscribes to it (the minify gotcha). A hold taken under a different view (a zoom
    // or scrub since) no longer applies: see holdKey.
    const heldNow = chartHeld.value;
    const held = heldNow && heldNow.key === holdKey() ? heldNow.axis : null;
    // Both neighbours, so the trace reaches both edges as it scrolls — except the right one on a window HELD at the live
    // edge: every reading that arrives is the one after it, and taking it moved the chart under the pointer.
    const windowed = useMemo(() => windowSamples(samples, held ?? window_, { edges: held && (!window_ || window_.live) ? "left" : true }), [samples, window_, held]);
    // THE AXIS FOLLOWS THE CLOCK, not the last sample. The window above is recomputed when samples arrive (every
    // second while the box works, every 15 s idle), and a chart whose right edge is the last sample steps and freezes
    // at that cadence. So the DRAWN axis slides the window along to now on a short tick, while the window itself —
    // what is sampled, what the scrub strip reasons about — keeps its sample cadence (see the note on its memo: a
    // right edge moving at another cadence breaks the scrub gestures). Only a window that follows the clock slides:
    // a zoom stays where you put it, and so does a finished session.
    const following = window_ ? !!window_.live : true;
    const [tickNow, setTickNow] = useState(() => Date.now());
    useEffect(() => {
        if (!following) return;
        const id = setInterval(() => {
            const now = Date.now();
            if (chartHeld.value && now - lastPointerAt > HOLD_LAPSE_MS) chartHeld.value = null;
            setTickNow(now);
        }, AXIS_TICK_MS);
        return () => clearInterval(id);
    }, [following]);
    live.axis = held ?? (!window_ ? axisOf(null, [windowed], tickNow)
        : window_.live && tickNow > window_.to ? { from: window_.from + (tickNow - window_.to), to: tickNow }
        : window_);
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
    // Whether the unzoomed view follows the clock: not for a scoped session that has finished (see `scrubIntent`).
    const follows = !scopedWindow || !!scopedWindow.live;
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
            settleScrub(scrubPinch({ from: ex.from, to: ex.to }, w, e.deltaY, at), ex, follows);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const by = wheelScrubFraction(e.deltaX, e.deltaY, e.deltaMode, box.width);
        if (!by) return;
        settleScrub(scrubNudge({ from: ex.from, to: ex.to }, w, by), ex, follows);
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
            <div class="rc" onWheel={wheelScrub} onPointerEnter={holdAxis} onPointerMove={holdAxis} onPointerLeave={releaseAxis}>
                {/* The plots' RULES obey the same kind filter as the lane and the strip: hiding "loads" takes the
                    load steps off the chart too, rather than leaving them ruled through a trace whose lane bars
                    are gone. */}
                {tracks.map((t) => <TrackView key={t.id} def={t} samples={filled} latest={latest} hidden={hidden} events={stripEvents} />)}
            </div>
            {/* Directly under the tracks: where this window sits in the whole session. It sits ABOVE the lane
                rather than below it because the lane RE-PACKS as the window moves — a step entering the view
                can add a row — and anything below a control whose height changes shifts out from under the
                pointer mid-drag. The strip is the thing being dragged, so it goes where nothing moves it. */}
            {/* The strip is about the stretch that HAS data, so while the window is still filling (its right edge
                ahead of the last reading, see `chartWindow`) it is given the window clipped to that reading: a drag
                on its left edge then means "fewer seconds than the history", which is what narrowing is. */}
            <ScrubStrip samples={samples} window={window_ && samples.length && window_.to > samples[samples.length - 1].t
                ? { from: window_.from, to: samples[samples.length - 1].t } : window_} pan={window_} events={stripEvents} follows={follows} />
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
