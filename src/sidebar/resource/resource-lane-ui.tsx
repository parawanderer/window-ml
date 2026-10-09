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
import { snapFraction, timeAtFraction, clampWindow, segments } from "../../resource/resource-axis";
import { filterEvents, countByKind, placeEvents, MIN_EV_SPAN, laneRows, lineageOf, scopeAround } from "../../resource/resource-lane";
import { type ResourceSample } from "../../resource/resource-model";
import { type ResourceEvent, eventsIn } from "../../resource/resource-timeline";
import { scrollToAnswer } from "../transcript/answer-render";
import { live, eventHover, cursorAt, noteRuns, litBy, holdAxis, hoverAt, releaseAxis, trackCursor, barKey } from "./chart-interaction";
import { sampleGraceMs, resourceHistory, laneFilter, sampleGapMs, streamLive } from "./panel-state";
import { scrollToStepSeq } from "../transcript/step-scroll";
import { brush, snapDot, zoomRange, ollamaIds, models, laneScoped, predictView, sessionMap, view, laneLitSeqs, laneH, LANEH_KEY, LANE_H_DEFAULT, showLane, laneHidden, LANE_HIDDEN_KEY, SECTIONS_KEY, laneEnabled, showModels, LANE_SCOPE_KEY } from "../store";
import { Disclosure } from "../disclosure";
import { useTipPlacement } from "../use-tip";
import { hoverModel } from "./vram-focus";
import { LaneBars } from "./lane-bars";
import { FilterChips } from "../filter-chips";
import { EventTipBody } from "./event-tip";

/** The panel's tracks, from the chosen LAYOUT. A layout is just `TrackDef[]`; a preset is a named starting
 *  point for it (see `presetsFor`), and editing one is the same operation on the same state. */
/** A composite span's fill: hard stops at each phase boundary. The model's own colour for the work it did
 *  (the same one its row and bands carry, so the lane reads against the model list with no legend of its
 *  own), a hatched neutral for the human's wait, and a paler wash of the model colour for the tool. */
/** The fill for a LOAD span: diagonal stripes of the model's own colour against the panel. Waiting for a model
 *  to arrive is not the model working, so it must not look like a solid block of its time — but it IS that
 *  model's wait, so the colour stays. (A plain model-coloured bar is what the inline colouring made of it,
 *  which is exactly the confusion the stripes exist to prevent.) */
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

/** The tooltip for the lane bar under the cursor: what kind of event it was, what it cost, what it waited on
 *  and what the server said about it. Renders only for the surface the pointer is actually on (`scope`), since
 *  every track draws a tip from the same hover signals and they would otherwise all appear at once. The content
 *  is `EventTipBody`, shared with the pages that draw a lane with no panel; this is the panel's hover and what
 *  the panel knows about the box. */
export function EventTip({ scope }: { scope: string }) {
    const h = eventHover.value, at = cursorAt(scope);
    const { ref, style } = useTipPlacement(at);
    if (!h || !at || h.scope !== scope) return null;
    return (
        <div class={`rc-tip rc-tip-event`} role="tooltip" ref={ref} style={style}>
            <EventTipBody e={h.p.event} clipped={!!h.p.clipped} opts={{
                where: modelWhere, showHash: !laneScoped.value,
                predict: predictView.value ? { history: resourceHistory.value } : null,
                ownSession: (sess) => sessionMap.has(sess.replace(/^wml-/, "")),
                clickable: true,
            }} />
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
                ref={(el) => { const w = el?.clientWidth ?? 0; if (w > 0 && w !== laneWidthPx.value) laneWidthPx.value = w; }}>
                {/* The bars themselves are LaneBars, shared with the bench's pages (lane-bars.tsx); this is the panel's
                    wiring around them. */}
                <LaneBars rows={rows} minSpan={minSpan} as="button" keyOf={(p) => barKey(p.event)}
                    rowAttrs={{ onPointerDown: startBrush(runs), onPointerMove: trackCursor("lane") }}
                    // The SAME selection box the tracks draw. The lane already took the drag — it shares `startBrush` —
                    // but showed nothing while you made it, so the gesture worked and looked like it had not: you
                    // released and the window jumped with no sign of what you had chosen. Every surface on this axis
                    // draws the same fractions, which is the point of the axis being shared.
                    rowPrefix={() => <BrushOverlay runs={runs} />}
                    barAttrs={(p) => {
                        const e = p.event;
                        // Hovering one event dims everything outside its LINEAGE: a sub-call only means something next
                        // to the step that spawned it and the run that contains it.
                        const away = !!litFn && !litFn(e);
                        return {
                            class: `${away ? "away" : ""}${e.id && e.id === pulsed ? " pulse" : ""}`.trim() || undefined,
                            title: "",
                            onPointerEnter: (ev: PointerEvent) => { eventHover.value = { p, scope: "lane" }; hoverModel.value = e.model ?? null; trackCursor("lane")(ev); },
                            // Off the bar, its tip goes: moving onto empty lane left the tip of the last bar following
                            // the cursor until the pointer left the whole lane. Only if it is still this bar's (by
                            // `barKey`: the event is re-derived each render), so entering the next bar first is not undone.
                            onPointerLeave: () => { if (eventHover.value && barKey(eventHover.value.p.event) === barKey(e)) { eventHover.value = null; if (hoverModel.value === (e.model ?? null)) hoverModel.value = null; } },
                            onClick: () => open(e),
                            onDblClick: () => scope(e),
                        };
                    }} />
            </div> : null}
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
            <FilterChips hidden={hidden} toggle={toggle} items={KINDS.filter((k) => counts[k.kind]).map((k) => ({
                key: k.kind, label: k.label, count: counts[k.kind], tip: hidden.has(k.kind) ? `Show ${k.label}` : `Hide ${k.label}`,
            }))}>
                {/* The scope switch used to live here, as one more chip in a row of chips — which said it was
                    a filter over KINDS like the others, when it decides the window, the model list and the
                    lane together. It is in the panel HEADER now (`ScopeSwitch`). */}
                {shown < total ? <span class="rc-lane-count">{shown}/{total}</span> : null}
            </FilterChips>
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
