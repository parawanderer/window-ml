// resource-scrub.tsx — the scrub strip under the resource plots: the whole history in miniature with the visible
// window drawn over it, and every gesture (drag, resize, wheel, pinch) that moves or resizes that window.
//
// `settleScrub` is the one rule for whether a gesture leaves the chart following live, and the chart's own wheel
// handler goes through it too, which is why it is exported rather than private to the strip.

import { signal } from "@preact/signals";
import { useRef, useState, useLayoutEffect } from "preact/hooks";
import { scrubIntent, TAIL_SLACK_MS, scrubExtent, segments, scrubZone, scrubResize, scrubTo, scrubPinch, wheelScrubFraction, scrubNudge } from "../resource-axis";
import type { ResourceSample } from "../resource-model";
import type { ResourceEvent } from "../resource-timeline";
import { sampleGapMs, colorFor } from "./panel-state";
import { zoomRange, resWindowS, RESWIN_KEY, laneEnabled, showLane } from "./store";

/** Which part of the scrub window the pointer is over, so the cursor can say a handle is there before you
 *  try to use it. A resize affordance you can only discover by failing to pan is not an affordance. */
const scrubGrab = signal<"from" | "to" | "pan" | "outside" | null>(null);

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
 *
 * A pinned window that merely happens to sit at the end is not the same as following: new samples arrive,
 * the window stays where it was pinned, and the view silently falls behind while the button still reads
 * live (which is computed from where the window sits, not from whether it is following). The drag path has
 * always done this on release; the wheel paths did not, so scrolling to the end looked like rejoining live
 * and then drifted away from it.
 */
export function settleScrub(next: { from: number; to: number }, ex: { from: number; to: number }, follows: boolean): void {
    const intent = scrubIntent(ex, next, TAIL_SLACK_MS, follows);
    if (!intent.live) { zoomRange.value = intent.window; return; }
    resWindowS.value = intent.windowS;
    zoomRange.value = null;
    if (windowWrite) clearTimeout(windowWrite);
    windowWrite = setTimeout(() => {
        windowWrite = null;
        try { chrome.storage.local.set({ [RESWIN_KEY]: resWindowS.value }); } catch { /* opaque origin */ }
    }, 400);
}

/** The SCRUB strip: the whole session compressed into one bar, with a box showing which slice the chart above
 *  is drawing. Drag the box to move through the session; drag it back to the right edge — or press the live
 *  button — to re-pin to the tail.
 *
 *  Its own axis is LINEAR in time, unlike the chart's: this is an overview, and a ten-minute hole is a fact
 *  about the session that an overview should show at its true width rather than collapse. The runs are drawn
 *  as filled blocks with the gaps left empty, so "nothing was measured here" reads as a hole. */
export function ScrubStrip({ samples, window: win, pan, events = [], follows }: {
    samples: ResourceSample[]; window: { from: number; to: number } | null;
    /** The window at its REAL width, for a pan. `window` is clipped to the last reading while it fills, which is right
     *  for drawing it and for a resize (narrowing means fewer seconds than the history), and wrong for a pan: moving
     *  the clipped one and rejoining live stored the clipped width, so every swipe to the tail and back shrank the
     *  window by the unread gap, until it was a sliver and then nothing. */
    pan?: { from: number; to: number } | null;
    events?: ResourceEvent[]; follows: boolean;
}) {
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
                : scrubTo(ex, pan ?? win, at(ev.clientX));
            zoomRange.value = landed;
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            // What the gesture meant is decided HERE, by pure logic in resource-model.
            const intent = landed && scrubIntent(ex, landed, TAIL_SLACK_MS, follows);
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
                        settleScrub(scrubPinch({ from: ex.from, to: ex.to }, win, ev.deltaY, within), ex, follows);
                        ev.preventDefault();
                        ev.stopPropagation();
                        return;
                    }
                    const by = wheelScrubFraction(ev.deltaX, ev.deltaY, ev.deltaMode, b.width);
                    if (!by) return;
                    settleScrub(scrubNudge({ from: ex.from, to: ex.to }, pan ?? win, by), ex, follows);
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
                {/* The HOLES, at their true width — this axis is linear in clock time, so a missing minute takes a
                    minute here even though the plot cuts it to a 3px break. Hatched rather than left blank, so
                    "nothing was measured" reads as a fact about the session, not as empty strip. They ignore the
                    pointer: dragging across one still scrubs. */}
                {runs.slice(1).map((run, i) => {
                    const a = (runs[i].at(-1)!.t - ex.from) / span, b = (run[0].t - ex.from) / span;
                    return b > a ? <i class={`rc-scrub-gap${run[0].gapBefore ? " reported" : ""}`} key={`g${i}`} aria-hidden="true"
                        style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} /> : null;
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
            {/* Where nothing follows the clock (a scoped session that has finished), clearing the zoom returns to the
                session's own stretch, so the button says that instead of promising a live view it cannot give. */}
            {follows ? (
                <button class={`rc-scrub-live${ex.atTail ? " on" : ""}`} title={ex.atTail ? "Following new samples" : "Jump back to live"}
                    onClick={() => (zoomRange.value = null)}>
                    <span class="rc-live-icon" aria-hidden="true">{ex.atTail ? "▶" : "⏸"}</span>live
                </button>
            ) : (
                <button class={`rc-scrub-live${zoomRange.value ? "" : " on"}`} title="Back to this session's own stretch"
                    onClick={() => (zoomRange.value = null)}>
                    <span class="rc-live-icon" aria-hidden="true">↺</span>session
                </button>
            )}
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
