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
//
// This file is the chart's FRAME: the window, the axis and the tick, and which view draws each track. The views
// are resource-device-view (one pool) and resource-box-views (several); what they draw with is resource-area,
// resource-overlays, resource-tips and chart-paint; the strip under them is resource-scrub; and what the pointer
// and keyboard are on is chart-interaction.

import { Fragment, type ComponentChildren } from "preact";
import { useMemo, useState, useEffect } from "preact/hooks";
import { ceilingsFor, isCpuResident, type ResourceSample } from "../../resource/resource-model";
import { type ResourceEvent } from "../../resource/resource-timeline";
import { type Capacity } from "../../resource/resource-capacity";
import { presetsFor, type TrackDef } from "../../resource/resource-presets";
import { type Axis, segments, chartWindow, axisOf, scrubExtent, scrubPinch, windowSamples, scrubNudge, wheelScrubFraction, runWeight, runGap } from "../../resource/resource-axis";
import { scopeToSpan, filterEvents, sessionWindow } from "../../resource/resource-lane";
import { deviceBands, hostBands, residualRank } from "../../resource/resource-bands";
import { editLayout, VRAM_POLL_MS, laneFilter, layout, sampleGapMs } from "./panel-state";
import { chartHeld, HOLD_LAPSE_MS, holdAxis, holdKey, hoverAt, lastPointerAt, live, readingIsOverlay, releaseAxis, stepPool, tipMuted, leavePool, poolHover } from "./chart-interaction";
import { scopedHash, resWindowS, zoomRange, laneScoped, laneEnabled, crosshair } from "../store";
import { EventLane } from "./resource-lane-ui";
import { AXIS_TICK_MS } from "./resource-overlays";
import { settleScrub, ScrubStrip } from "./resource-scrub";
import { DeviceView } from "./resource-device-view";
import { UtilView, BoxView, OverlayView } from "./resource-box-views";
import { kbFocus, kbPool, hoverModel, stepFocus, stepDepth } from "./vram-focus";

/** Mute the cursor tip if one is showing, and say whether that happened — so the Esc handler can fall through
 *  to leaving the zoom when there was nothing to hide. The decision lives HERE, beside the signals it reads,
 *  rather than exporting the hover state so another module can ask the same question less well. */
export function muteTip(): boolean {
    if (!hoverAt.value || tipMuted.value) return false;
    tipMuted.value = true;
    return true;
}

/** Every track this machine warrants: one per accelerator, plus the host pool on a discrete box. A unified
 *  device has ONE pool, so it gets one track (its bands already come from the host) and no separate RAM track
 *  — two would double-count the same silicon. */

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

/** Whether `el` is off the chart's readout surfaces: anywhere but the chart, or on a lane (its bars have tips of
 *  their own). The scrub strip sits outside `.rc`, so it is off. */
export const offReadout = (el: Element | null): boolean => !el?.closest?.(".rc") || !!el.closest(".rc-lane, .wml-lane");

/** Close the chart's readout: its crosshair, where the pointer was reading it, a lit pool, and with `keys` a line or a
 *  model the arrow keys were holding. A lane's own reading position (surface "lane") is the lane's to clear. */
function closeReadout(keys: boolean): void {
    if (keys && kbFocus.value) { kbFocus.value = null; hoverModel.value = null; }
    if (keys && kbPool.value) kbPool.value = null;
    if (crosshair.value) crosshair.value = null;
    if (hoverAt.value && hoverAt.value.surface !== "lane") hoverAt.value = null;
    if (poolHover.value) leavePool();
}

// THREE WAYS A HOLD ENDS, because the one that should suffice (`pointerleave`) is not delivered when the pointer leaves
// the panel's iframe for the page: moving anywhere in the panel off the chart; the shell saying the pointer is on the
// page; and the lapse, in the chart's tick.
if (typeof document !== "undefined") document.addEventListener("pointermove", (e) => {
    const on = e.target as Element | null;
    if (chartHeld.value && !on?.closest?.(".rc, .rc-lane")) chartHeld.value = null;
    // THE SAME BACKSTOP FOR THE CHART'S READOUT (its crosshair, where the pointer is reading it, a pool lit). The chart
    // clears them on its plots' pointerleave, but a chart redrawn under a still pointer (a live page's next state) has
    // the browser re-enter whatever element is now under it, and that readout outlived the pointer: up wherever it went
    // next, and over a lane bar on top of the bar's own tip. Only the chart's surfaces set these, so off the chart, or on
    // a lane (whose bars have tips of their own), the readout is over, unless the keyboard holds a line. A lane's own
    // reading position (surface "lane") is the lane's to clear, and event tips are untouched (a model card's ribbon
    // opens one outside the chart).
    if (kbFocus.value || kbPool.value || !offReadout(on)) return;
    closeReadout(false);
}, { passive: true });
// A PRESS off the chart ends the readout even when the arrow keys hold a line: moving away keeps a held line on
// purpose (a reading you are taking), but pressing on the strip or a lane is starting something else, and the readout
// stayed up over it. Captured, since the strip's own handlers take the event.
if (typeof document !== "undefined") document.addEventListener("pointerdown", (e) => {
    if (offReadout(e.target as Element | null)) closeReadout(true);
}, { passive: true, capture: true });

/** THE CHART itself: one track per memory pool on a shared segmented axis, the scrub strip above and the
 *  event lane below. Drawing only — placement, packing, bands and windows are the pure functions in
 *  resource-model.ts, which is what makes the picture testable without a browser. */
/** What a surface drawing its OWN lane under the chart is handed: the axis the tracks were drawn on this render (zoom,
 *  scrub, the rolling window and the hold all applied), the readings in it, and their runs between gaps, which a drag
 *  to select (`startBrush`) snaps against. */
export interface LaneContext { axis: Axis; samples: ResourceSample[]; runs: ResourceSample[][] }

/**
 * @param lane draws the lane in place of the panel's `EventLane`, on the chart's axis: a page with no panel (the bench's
 *   sweep, one lane per run) keeps its own rows and still moves with every zoom, scrub and selection made on the chart
 * @param endAt where a RECORDING that no longer grows ends (a finished bench sweep): the clock the live view follows
 *   stops there. Following the wall clock, "live" on a recording read later slid past its end and drew nothing.
 */
export function ResourceTracks({ samples, capacity, hidden, layout, events = [], lane, endAt }: { samples: ResourceSample[]; capacity: Capacity | null; hidden: Set<string>; layout?: TrackDef[] | null; events?: ResourceEvent[]; lane?: (ctx: LaneContext) => ComponentChildren; endAt?: number }) {
    const clock = () => endAt ?? Date.now();
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
        () => (laneScoped.value ? sessionWindow(events, scopedHash(), clock(), { followMs: resWindowS.value * 1000 }) : null),
        [laneScoped.value, scopedHash(), events.length, samples.at(-1)?.t, resWindowS.value, endAt]);
    // KEYED ON THE NEWEST SAMPLE'S TIME, never on how many there are. The history is capped (RESOURCE_HISTORY), and a
    // streamed box reaches the cap in about twenty minutes; from then on every reading drops one and adds one, the
    // length never changes, and this memo never ran again. The window's right edge froze at the moment of the last
    // recompute, the scrub strip read the view as scrolled back ("⏸ live"), and the live button did nothing, because
    // it clears a zoom that was already clear.
    const window_ = useMemo(
        () => chartWindow(zoomRange.value, scopedWindow, resWindowS.value, clock(), samples[0]?.t),
        [resWindowS.value, zoomRange.value, samples.at(-1)?.t, samples[0]?.t, scopedWindow, endAt]);
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
    const following = endAt == null && (window_ ? !!window_.live : true);
    const [tickState, setTickNow] = useState(() => Date.now());
    const tickNow = endAt ?? tickState;
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
        : window_.live && tickNow > window_.to ? { from: window_.grows ? window_.from : window_.from + (tickNow - window_.to), to: tickNow }
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
            {lane && live.axis
                ? <div onWheel={wheelLane}>{lane({ axis: live.axis, samples: filled, runs: segments(filled, sampleGapMs()).filter((r) => r.length > 1) })}</div>
                : laneEnabled.value
                ? <div onWheel={wheelLane}><EventLane samples={filled} events={shown} session={samples} /></div>
                : null}
        </>
    );
}

/** Models resident on the CPU — they hold no VRAM, so they never appear in a device track and would otherwise
 *  vanish from the panel entirely. */
export const cpuResident = (s: ResourceSample | undefined) => (s?.models ?? []).filter(isCpuResident);

/**
 * ONE KEY, READ BY THE CHART — whether it arrived at this frame's own document or was relayed in from the page.
 * Returns whether the key was used, so the caller calls `preventDefault` only then: the panel must not eat
 * scrolling it had no use for.
 *
 * Esc unwinds ONE RUNG AT A TIME, most transient first: the tooltip, then a keyboard focus, then the zoom. They
 * are different kinds of thing — the tip is in the way right now, the focus is a reading you are taking, the zoom
 * is state you chose — and dismissing a popup should never be what throws away a selection two rungs below it.
 *
 * The arrows only answer while the pointer is ON the chart (`crosshair` is set by the plot's own pointermove and
 * cleared when it leaves), because the whole point is reading the instant you are already pointing at without
 * moving off it. Elsewhere they stay the page's arrows.
 */
export function chartKey(key: string): boolean {
    if (key === "Escape") {
        if (muteTip()) return true;
        if (kbFocus.value) { kbFocus.value = null; hoverModel.value = null; return true; }
        if (zoomRange.value) { zoomRange.value = null; return true; }
        return false;
    }
    if (!crosshair.value) return false;                       // the pointer is not on the chart
    if (key === "ArrowDown" || key === "ArrowUp") {
        // THE SAME KEY, THE THING THIS VIEW DRAWS. Overview draws pool LINES and the stacked view draws model
        // bands, so the noun differs while the question the key answers does not. Leaving it working in one view
        // and dead in the other was the worse option: the same key would mean "change what I am reading" or
        // "scroll the page" depending on where the pointer happened to be.
        if (readingIsOverlay()) stepPool(key === "ArrowDown" ? 1 : -1);
        else stepFocus(key === "ArrowDown" ? 1 : -1);
        return true;
    }
    if (key === "ArrowRight" || key === "ArrowLeft") {
        // NO DEPTH IN THE OVERLAID VIEW — a pool has no breakdown of its own, the decomposition is per model — so
        // these are left to the page there rather than swallowed doing nothing.
        return !readingIsOverlay() && stepDepth(key === "ArrowRight" ? 1 : -1);
    }
    return false;
}

/**
 * The chart's keys on a document: `chartKey` for each keydown, `preventDefault` only when it used the key, so the page
 * keeps scrolling it had no use for; a modified key (other than Esc) is left alone. The panel installs it while it is
 * open, and a page that draws the chart with no panel (the bench's) installs it once. Returns the remover.
 */
export function installChartKeys(doc: Document): () => void {
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape" && (e.altKey || e.ctrlKey || e.metaKey)) return;
        if (chartKey(e.key)) e.preventDefault();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
}
