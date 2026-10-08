// resource-device-view.tsx — one memory pool's track: the header carrying its denominator and its card's facts
// (links, ceilings), then the stacked history from resource-area with its overlays and tips, gaps left as gaps.
//
// The per-card view every preset falls back to. The whole-box, utilization and overlaid views are in
// resource-box-views.tsx, and resource-chart.tsx picks between them.

import { useMemo } from "preact/hooks";
import { segments } from "../../resource/resource-axis";
import { type Band, OTHER_BAND_NOTE } from "../../resource/resource-bands";
import { ribbonSpans } from "../../resource/resource-gens";
import { formatBytes, type ResourceSample, formatShare } from "../../resource/resource-model";
import { type ResourceEvent } from "../../resource/resource-timeline";
import { type DeviceCapacity } from "../../resource/resource-capacity";
import { linkBetween, isBridge, linkPhrase } from "../../resource/resource-topology";
import { noteRuns, eventHover, trackCursor, hoverAt, snapUnder } from "./chart-interaction";
import { bandFill } from "./chart-paint";
import { capacity, sampleGapMs, streamLive } from "./panel-state";
import { StackedArea, KvFill } from "./resource-area";
import { startBrush, BrushOverlay, EventTip } from "./resource-lane-ui";
import { useInstants, PhaseStrip, trackCrosshair, TimeGrid, onAxis, PredictLines, InstantRules, HoverSpan, Crosshair } from "./resource-overlays";
import { hoveredSample, BandTip, PlotTip, GapTip } from "./resource-tips";
import { crosshair, predictView } from "../store";
import { kbFocus, hoverModel } from "./vram-focus";

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

/** What `DeviceView` needs to draw one pool: its samples, how a sample splits into bands, and its ceiling. */
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
export function HideTrack({ onHide, label }: { onHide?: () => void; label: string }) {
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
