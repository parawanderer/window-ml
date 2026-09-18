// resource-axis.ts — the mapping between SCREEN and TIME, and the scrubbing that changes it.
//
// Everything the chart draws is positioned by asking this module where a moment sits, so the axis is the one
// place that conversion may happen: `axisFrac` and `axisTime` are the only screen-to-time pair, and the axis is
// linear in clock time with gaps included, so an event is never dropped for falling between two samples. A
// second conversion written at a call site is how a lane and the boxes above it end up disagreeing by a few
// pixels that nobody can account for.
//
// The rest is what MOVES that window: `scrubTo`/`scrubZone`/`scrubResize` for a drag, `scrubNudge`/`scrubPinch`
// for the keyboard and a trackpad, `chartWindow` and `clampWindow` for what a window is allowed to become. A
// too-short selection is widened rather than refused, because a slip of the hand should not read as an empty
// range. `segments` and `axisGaps` are where a non-uniform sampling rate stops being the caller's problem.

import { ResourceSample } from "./resource-model";

/** The round intervals a time grid may use, in ms. */
export const GRID_STEPS_MS = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 216e5];

/** A TIME GRID's spacing: the smallest round interval that keeps its lines at least `minPx` apart when `totalMs`
 *  of runs is drawn across `widthPx` — the width a track is guaranteed (they tile at 300px), so a wider one only
 *  spaces them further. The largest step past that. */
export function gridStep(totalMs: number, widthPx = 300, minPx = 48): number {
    const need = (totalMs / Math.max(1, widthPx)) * minPx;
    return GRID_STEPS_MS.find((s) => s >= need) ?? GRID_STEPS_MS[GRID_STEPS_MS.length - 1];
}

/** Where a time grid's lines fall inside one run: every multiple of `step` on the LOCAL clock (a line lands on
 *  the minute, the half-minute), between the run's first and last sample. A gap between runs has none — nothing
 *  was measured there, and the run boundary is where the spacing visibly restarts. */
export function gridTimes(run: { t: number }[], step: number): number[] {
    if (run.length < 2 || step <= 0) return [];
    const first = run[0].t, last = run[run.length - 1].t;
    const off = -new Date(first).getTimezoneOffset() * 60_000;
    const out: number[] = [];
    for (let t = Math.ceil((first + off) / step) * step - off; t <= last && out.length < 500; t += step) out.push(t);
    return out;
}

/** Polling is gated on the panel being open, so the history has HOLES. A gap wider than this breaks the line
 *  instead of being drawn across: an interpolated segment over a ten-minute hole is a confident lie about
 *  memory that was never measured. (Same rule as never inventing a timestamp for an unmarked line.) */
export const MAX_SAMPLE_GAP_MS = 15_000;

/** The same rule, for a STREAMED history. It is a different number because a gap means a different thing on
 *  each transport, and using the polling one under the stream is a bug that hides the whole event lane.
 *
 *  Polling runs at a fixed 2s while the panel is open, so 15s between samples really did mean nobody was
 *  watching. The stream's cadence is ADAPTIVE by design — 1s while a load is in flight or the body is
 *  changing, 15s when nothing is happening — so 15s apart is the NORMAL idle spacing and means "nothing
 *  changed", the opposite of "nothing was measured". Reading it as a hole broke an idle history into
 *  single-sample segments, and since a lone sample draws no line, every event placed in one was dropped:
 *  a lane counting four loads and drawing none.
 *
 *  Three missed idle samples, which is a stream that has genuinely stopped rather than one that is quiet. */
export const STREAM_MAX_GAP_MS = 45_000;

/** The stream's IDLE cadence. It is the grace `placeEvents` needs on a streamed history for the same reason
 *  the poll interval is on a polled one: the last sample can be a whole idle interval old while the chart's
 *  right edge means "now", so without it the newest events — the ones you are watching for — are the only
 *  ones that never appear. Fifteen seconds is a long time to be blind to the thing you opened the panel for. */
export const STREAM_SAMPLE_MS = 15_000;

/** Split history into contiguous runs, so the chart draws several segments rather than one line bridging
 *  every gap. A single sample is its own segment (it renders as a point, not a line). */
export function segments(samples: ResourceSample[], maxGapMs: number = MAX_SAMPLE_GAP_MS): ResourceSample[][] {
    const out: ResourceSample[][] = [];
    let run: ResourceSample[] = [];
    for (const s of samples) {
        const prev = run[run.length - 1];
        // A REPORTED hole breaks the run as surely as a measured one. `gapBefore` is the stream saying it lost
        // frames on our behalf, and it is checked separately from the interval because a drop leaves no
        // interval to notice: the readings either side can be adjacent in time.
        if (prev && (s.gapBefore || s.t - prev.t > maxGapMs)) { out.push(run); run = []; }
        run.push(s);
    }
    if (run.length) out.push(run);
    return out;
}

/** A BREAK the chart cut out between two drawn runs. The plot collapses it to a few pixels whatever its length,
 *  so a missing minute and a missing ten hours look the same unless something says which it was. */
export interface RunGap {
    /** The last reading before the break and the first after it. */
    from: number;
    to: number;
    /** The server said it dropped frames on our behalf here (`gapBefore`), as opposed to nothing sampling. */
    reported: boolean;
    /** Readings inside the stretch that were too few to draw (a lone sample draws no line). */
    isolated: number;
}

/** What the break between run `prev` and run `next` stands for. `samples` is the full history, so a lone
 *  reading the plot skipped is counted rather than the stretch being called unmeasured. */
export function runGap(prev: readonly { t: number }[], next: readonly { t: number; gapBefore?: true }[],
    samples: readonly { t: number; gapBefore?: true }[] = []): RunGap {
    const from = prev[prev.length - 1].t, to = next[0].t;
    const inside = samples.filter((s) => s.t > from && s.t < to);
    return { from, to, reported: !!next[0].gapBefore || inside.some((s) => s.gapBefore), isolated: inside.length };
}

/** The SCRUB strip's geometry: where the visible window sits inside the whole session.
 *
 *  The strip is a compressed view of every sample the session holds (~30 minutes at a 2s poll), with a box
 *  showing which slice of it the chart above is drawing. Unlike the chart, the strip's own axis IS linear in
 *  time — it is an overview, and a 10-minute hole in the middle of a session is a fact about the session that
 *  an overview should show at its true width, not collapse the way the chart's segments do.
 *
 *  Returns null only when there is no WINDOW at all (the "everything" setting, which is not a viewport onto
 *  anything) or no session to draw. It deliberately does NOT return null for a window that happens to cover
 *  the whole session: that is a state a live view passes through constantly — the rolling window is wider
 *  than a session that has just started, and a width dragged while following is REMEMBERED, so stretching
 *  the box to the full width once made the control delete itself and reappear minutes later when the session
 *  outgrew it. A control that vanishes is worse than one that is momentarily at its limit, and it took the
 *  only way back with it: the chart's wheel-scrub reads this too. Full-width and draggable says the same
 *  thing honestly. */
export interface ScrubExtent {
    /** First and last sample in the session. */
    from: number;
    to: number;
    /** The visible window, as fractions of that span. */
    windowFrom: number;
    windowTo: number;
    /** Whether the window's right edge is at the session's tail — i.e. it is following live samples. */
    atTail: boolean;
}

/** How close to the tail still counts as AT it. One poll of slack: a window pinned to live is always a
 *  moment behind the newest sample, and calling that "scrolled back" would unpin the view for nobody. */
export const TAIL_SLACK_MS = 3000;

/** Where the current window sits inside the whole session, as the fractions a scrollbar thumb needs. Null when
 *  there is nothing to scrub: no viewport means the plot already IS the session, and fewer than two samples has
 *  no span to be a fraction of. Clamped, because a rolling window can legitimately reach back past the oldest
 *  sample it kept. */
export function scrubExtent(
    samples: readonly { t: number }[],
    window: { from: number; to: number } | null,
): ScrubExtent | null {
    if (!window) return null;   // no viewport: the plot already IS the whole session
    if (samples.length < 2) return null;
    const from = samples[0].t, to = samples[samples.length - 1].t;
    const span = to - from;
    if (span <= 0) return null;
    // Clamped, because a window can legitimately extend past the samples (the rolling window reaches back
    // before the first sample on a fresh open, and forward to now).
    const clamp = (t: number) => Math.min(1, Math.max(0, (t - from) / span));
    return {
        from, to,
        windowFrom: clamp(window.from), windowTo: clamp(window.to),
        atTail: window.to >= to - TAIL_SLACK_MS,
    };
}

/** Move a window to a new position on the strip, keeping its DURATION. Dragging the box scrolls time; it does
 *  not zoom, which is what the drag-on-the-chart gesture is for. The result is clamped to the session, so a
 *  drag past either end parks against it rather than scrolling into time that was never sampled. */
export function scrubTo(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    centerFrac: number,
): { from: number; to: number } {
    const span = extent.to - extent.from;
    const width = window.to - window.from;
    const center = extent.from + Math.min(1, Math.max(0, centerFrac)) * span;
    let start = center - width / 2;
    start = Math.max(extent.from, Math.min(start, extent.to - width));
    // A window WIDER than the session sits over all of it rather than being squeezed.
    if (width >= span) return { from: extent.from, to: extent.to };
    return { from: start, to: start + width };
}

/** Which part of the scrub window a pointer landed on. The EDGES resize, the middle pans — the same
 *  vocabulary every timeline control uses, and the reason a drag on the box must not silently mean
 *  "recentre on the cursor" when the cursor is on a handle.
 *
 *  `edgePx` is converted to a fraction against the track's width so the handles are a constant, clickable
 *  size on screen rather than a constant slice of a window that may be 2% wide.
 *
 *  THE CAP APPLIES INSIDE THE WINDOW ONLY. A handle is capped at a third of the window so a narrow one keeps
 *  a middle to pan by — but the cap was applied to the OUTSIDE reach as well, which is what made a hairline
 *  window impossible to widen: a few pixels across, its handles were one or two pixels on either side of it,
 *  so every grab landed on the pan zone and the only way out was discarding the zoom.
 *
 *  Outside, the reach is always the full `edgePx`. Nothing is given up for it — the pan middle is exactly as
 *  it was — and the narrower the window, the more the reach outside it is what you actually hit, which is
 *  the right way round: a window too small to aim at is a window you want to make bigger. */
export function scrubZone(
    extent: { windowFrom: number; windowTo: number },
    frac: number,
    trackPx: number,
    edgePx = 7,
): "from" | "to" | "pan" | "outside" {
    const { windowFrom: a, windowTo: b } = extent;
    const outer = trackPx > 0 ? edgePx / trackPx : 0;   // never capped: this is the reach OUTSIDE the window
    const inner = Math.min(outer, (b - a) / 3);         // capped: the window must keep a middle to pan by
    if (frac < a - outer || frac > b + outer) return "outside";
    if (frac <= a + inner) return "from";
    if (frac >= b - inner) return "to";
    return "pan";
}

/** Move ONE edge of the window, keeping the other fixed. Clamped to the session and to a minimum span, so a
 *  drag past the opposite edge parks against it rather than inverting the range into something with a
 *  negative duration that every consumer would then have to defend against. */
export function scrubResize(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    edge: "from" | "to",
    frac: number,
    minMs = MIN_SCOPE_MS,
): { from: number; to: number } {
    const span = extent.to - extent.from;
    const at = extent.from + Math.min(1, Math.max(0, frac)) * span;
    const min = Math.min(minMs, span);
    return edge === "from"
        ? { from: Math.max(extent.from, Math.min(at, window.to - min)), to: window.to }
        : { from: window.from, to: Math.min(extent.to, Math.max(at, window.from + min)) };
}

/** A SELECTED WINDOW, never narrower than the panel can draw. Widened symmetrically about its own centre, so
 *  the stretch you picked stays in the middle of what you get rather than sliding to one end.
 *
 *  A drag can resolve to almost no time at all even when the hand moved a long way, because the axis is
 *  SEGMENTED: a densely-sampled run occupies a lot of width for a little time. The result is a window of a
 *  few milliseconds, which contains no samples, draws as an empty plot, and reads as the panel breaking
 *  rather than as a selection that was too small to mean anything. `scopeToSpan` already widens a too-short
 *  block for the same reason; this is the same rule for a hand-made selection.
 *
 *  Returns null for a window with no extent at all (from >= to), which is not a selection to widen but a
 *  click to ignore. */
export function clampWindow(win: { from: number; to: number }, minMs = MIN_SCOPE_MS): { from: number; to: number } | null {
    const span = win.to - win.from;
    if (span <= 0) return null;
    if (span >= minMs) return win;
    const mid = win.from + span / 2, half = minMs / 2;
    return { from: mid - half, to: mid + half };
}

/**
 * THE STRETCH THE CHART DRAWS, in priority order: an explicit zoom, then a scoped session's own extent, then
 * the rolling window. A zoom REPLACES the rolling one — you asked for a stretch, so the panel stops sliding
 * away from it.
 *
 * Pure and shared, because the HEADER has to describe the same instant the tracks do. It used to read the
 * live resident set whatever the window was, so scrubbing back put two different moments side by side with
 * nothing saying so: "6.53 GiB in use" above a track whose own edge read 19.95 GiB unattributed, which reads
 * as arithmetic going wrong rather than as two clocks. Deriving the window twice would have been the same bug
 * waiting to come back.
 */
export function chartWindow(zoom: { from: number; to: number } | null, scoped: { from: number; to: number; live?: true } | null,
    secs: number, now: number, firstT?: number): { from: number; to: number; live?: true } | null {
    if (zoom) return zoom;
    if (scoped) return scoped;
    if (!secs) return null;                        // "everything" — no window to draw
    const width = secs * 1000;
    // FILL, THEN SCROLL, the same rule a live session follows (`sessionWindow`). With less history than the window
    // holds, the window starts at the first reading and the data grows rightward into it; once the history is longer,
    // it follows the clock at the same width. It never rescales. (Strictly `now - width` would leave a fresh panel
    // blank on the left; stretching the history to fit is a continuous zoom until the window fills.)
    // `live`: this window FOLLOWS THE CLOCK, so the chart may slide it along between samples (see ResourceTracks).
    if (firstT != null && now - firstT < width) return { from: firstT, to: firstT + width, live: true };
    return { from: now - width, to: now, live: true };
}

/** THE SAMPLES A WINDOW SHOULD DRAW — the ones inside it, PLUS the nearest on each side.
 *
 *  A plain filter is wrong once the window gets narrower than the poll interval, which is exactly what
 *  zooming into a single long event does: the window falls between two polls, the filter returns fewer than
 *  two samples, and the chart draws an empty box. The panel then looks broken rather than zoomed — no line,
 *  no ceiling, no tracks — while the thing you zoomed in ON, an event spanning the whole window, is still
 *  perfectly well defined.
 *
 *  The BRACKETING samples are what a line needs to cross the window at all: the value did not stop existing
 *  between two measurements. They sit outside the window by construction, so a renderer must clip to the
 *  window rather than to the data's extent — which is what a time axis does anyway.
 *
 *  Not interpolation: these are real measurements, drawn where they were actually taken. Inventing a sample
 *  at the window's edge would be a reading nobody took, which is the thing this panel refuses to do
 *  everywhere else (see the gaps, which stay gaps). */
export function windowSamples<T extends { t: number }>(all: readonly T[], window: { from: number; to: number } | null, opts: { edges?: boolean | "left" } = {}): T[] {
    if (!window) return [...all];
    const inside: T[] = [];
    let before: T | null = null, after: T | null = null;
    for (const s of all) {
        if (s.t < window.from) { before = s; continue; }         // `all` is ordered, so the last one wins
        if (s.t > window.to) { if (!after) after = s; continue; }   // …and the first one past the end
        inside.push(s);
    }
    // `edges`: ALWAYS reach outside — what the CHART draws with. Without the neighbours, the stretch between the last
    // reading before the left edge and the first one inside was not drawn at all, so scrolling back made each stretch
    // pop in only once its first reading crossed the edge. The plot clips to the axis, and a neighbour minutes away
    // is still a gap (the runs split there), so this draws what was measured right up to the edge and nothing more.
    // Without it, only when the window cannot draw itself: a caller READING the window's last sample (the header's
    // "in use at") must not be handed one from after it.
    // `"left"`: the neighbour before only. For a window held still at the live edge, where the next reading to arrive
    // is by definition the one after it — borrowing it would change the chart under a pointer that is holding it.
    if (inside.length >= 2 && opts.edges === "left") return [...(before ? [before] : []), ...inside];
    if (inside.length >= 2 && !opts.edges) return inside;
    return [...(before ? [before] : []), ...inside, ...(after ? [after] : [])];
}

/** WHAT A FINISHED SCRUB DRAG MEANT. Two outcomes, and telling them apart is the whole point: a window
 *  PINNED to a range, or FOLLOWING with a width.
 *
 *  The rule that used to be here — "ends at the tail → rejoin live" — is right for a PAN (you dragged the
 *  box to the end, you want to follow) and wrong for a RESIZE of the left edge, which never moves `to` at
 *  all. So every widen-while-following was read as "rejoin live", which threw the new width away and
 *  snapped the strip back: the window could be narrowed but never stretched.
 *
 *  Following with a width is not a special case of a pinned range — it IS `resWindowS`, the same quantity
 *  Settings names — so a left-edge drag against the tail returns seconds, and the caller stores it. */
export function scrubIntent(
    extent: { from: number; to: number },
    next: { from: number; to: number },
    tailSlackMs: number,
): { live: true; windowS: number } | { live: false; window: { from: number; to: number } } {
    // AT THE TAIL → follow, AT THE WIDTH ON SCREEN. One rule for every gesture, which is what makes it
    // predictable: whatever the window looks like when you let go against the right edge is what live then
    // means. Two separate bugs came from not having it. Rejoining live RESTORED whatever `resWindowS` was
    // last set to, so narrowing a pinned window and dragging it back to the edge made it snap large again —
    // and a left-edge stretch while already following was read as "you dropped at the tail, rejoin live",
    // which threw the new width away, so the window could be narrowed but never widened.
    if (next.to >= extent.to - tailSlackMs)
        return { live: true, windowS: Math.max(1, Math.round((next.to - next.from) / 1000)) };
    return { live: false, window: next };
}

/** Slide the window along the strip by a fraction of ITS OWN width, for a wheel gesture over the plot.
 *  Relative to the window rather than to the session, so one notch moves the same visible distance whether
 *  you are looking at ten seconds of a ten-minute session or all of it. */
export function scrubNudge(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    byWindowFraction: number,
): { from: number; to: number } {
    const width = window.to - window.from;
    const span = extent.to - extent.from;
    if (width >= span) return { from: extent.from, to: extent.to };
    const center = (window.from + window.to) / 2 + width * byWindowFraction;
    return scrubTo(extent, window, (center - extent.from) / span);
}

/**
 * A PINCH → a narrower or wider window, ANCHORED so the instant under your fingers stays under them.
 *
 * A trackpad pinch reaches the page as a `wheel` carrying `ctrlKey`, which is the platform convention rather
 * than anything we invented — it is how the browser tells its own page-zoom apart from a scroll. So zooming
 * the timeline costs no new surface: the same handler that scrolls the window along reads one more flag and
 * changes what the gesture means. Sideways slides, pinch zooms, which is what both gestures already mean
 * everywhere else on a trackpad.
 *
 * The factor is EXPONENTIAL in the delta, so the gesture is smooth and symmetric: pinching out by an amount
 * and back in by the same amount returns to where you started, where a linear step accumulates drift and a
 * `sign(delta) * step` moves in visible jumps.
 *
 * The anchor is read LINEARLY across the window, which the plot's own axis is not quite — its runs are
 * linear in time but the gaps between them collapse. That is deliberate and matches `scrubNudge`, which slides by a fraction of
 * the window's own width for the same reason: consistency between the two gestures on one axis matters more
 * than an exactness neither of them has, and the anchor is about the zoom FEELING fixed rather than about
 * naming an instant.
 */
export function scrubPinch(
    extent: { from: number; to: number },
    window: { from: number; to: number },
    deltaY: number,
    anchorFrac: number,
    minMs = MIN_SCOPE_MS,
): { from: number; to: number } {
    const span = extent.to - extent.from;
    const width = window.to - window.from;
    if (!(span > 0) || !(width > 0)) return window;
    // Pinching OUT gives a negative delta (the same sign a scroll-up carries) and means "closer", so the
    // window gets narrower. Capped per event, because a trackpad can deliver a very large delta in one frame
    // and a single flick should not cross the whole zoom range.
    const factor = Math.exp(Math.max(-0.5, Math.min(0.5, deltaY * 0.01)));
    const next = Math.max(Math.min(minMs, span), Math.min(span, width * factor));
    const anchor = window.from + Math.min(1, Math.max(0, anchorFrac)) * width;
    // Keep the anchored instant at the same FRACTION of the window, which is what makes it stay under the
    // pointer as the width changes.
    let from = anchor - (anchor - window.from) * (next / width);
    from = Math.max(extent.from, Math.min(from, extent.to - next));
    return { from, to: from + next };
}

/**
 * How far a wheel gesture should slide the window, as a fraction of the window's own width.
 *
 * Two things this gets right that a `Math.sign(delta) * step` does not, and both were visible as the same
 * symptom — the chart scrubbing erratically under a trackpad:
 *
 * It reads BOTH AXES, taking whichever dominates. A trackpad swipe is a stream of events carrying a mixture
 * of `deltaX` and `deltaY`, so reading only one axis means a horizontal swipe does nothing except through
 * whatever incidental vertical jitter it happens to carry. Dominant-axis rather than summed, so a diagonal
 * gesture is not counted twice.
 *
 * And it is PROPORTIONAL to the distance, scaled by the plot's own width, so the window travels 1:1 with the
 * gesture: swipe across half the plot and the window moves half its width. A fixed step per event is what
 * made it inconsistent — one mouse notch and one of the dozens of tiny events a trackpad emits for the same
 * physical movement were treated identically, so the same swipe moved wildly different distances depending
 * on how the hardware chose to quantise it.
 *
 * `deltaMode` is honoured because a mouse reports LINES and a page gesture reports PAGES; treating either as
 * pixels moves the window by a few pixels for a gesture that meant a screenful.
 */
export function wheelScrubFraction(deltaX: number, deltaY: number, deltaMode: number, plotPx: number): number {
    if (!(plotPx > 0)) return 0;
    const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? plotPx : 1;
    const dx = deltaX * scale, dy = deltaY * scale;
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    return d / plotPx;
}

/**
 * A RUN'S OWN SPAN OF THE AXIS. Within a run of samples, time is linear, and a run is drawn in a box placed on the
 * chart's axis ({@link Axis}) — so its drawing works in run-local fractions (`runFrac`) and the box does the rest.
 *
 * Samples used to be spaced EVENLY (sample i at i/(n-1) of its run), which warped badly once the event stream
 * sampled adaptively (250 ms during a load, 1 s while working, 15 s idle): busy stretches stretched, idle ones
 * shrank, and an unload rule landed over a band that was still resident. Hence linear in time, everywhere.
 */
export const runWeight = (run: readonly { t: number }[]): number =>
    run.length > 1 ? Math.max(1, run[run.length - 1].t - run[0].t) : 1;

/** Where time `t` sits across its run, 0–1, linear in time. A run with no width (one sample) has no interior,
 *  so everything in it sits at the middle. */
export const runFrac = (run: readonly { t: number }[], t: number): number => {
    const n = run.length;
    if (n < 2) return 0.5;
    const w = run[n - 1].t - run[0].t;
    return w > 0 ? Math.min(1, Math.max(0, (t - run[0].t) / w)) : 0.5;
};

/** The index of the sample nearest in TIME to `t` within a run (binary search — runs can hold thousands). */
const nearestIndex = (run: readonly { t: number }[], t: number): number => {
    let lo = 0, hi = run.length - 1;
    if (hi <= 0 || t <= run[0].t) return 0;
    if (t >= run[hi].t) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (run[mid].t <= t) lo = mid; else hi = mid; }
    return t - run[lo].t <= run[hi].t - t ? lo : hi;
};

/**
 * THE CHART'S TIME AXIS: LINEAR IN CLOCK TIME across the whole window, gaps included.
 *
 * It used to be segmented: each run of samples as wide as it lasted, and every gap between two runs collapsed to a
 * 3px marker. That lost events (one inside a gap had nowhere to be drawn and was dropped), could not scroll (the
 * right edge was the LAST SAMPLE, which arrives every second while busy and every 15 s idle, so the whole chart
 * stepped and froze), and drew a minute and ten hours alike. A monitoring view draws a continuous time axis with a
 * hole left at its true width, and so does this one: a gap is drawn, hatched, as wide as it was.
 *
 * Every mapping between the screen and time — drawing, events, the crosshair, the snap, the selection — goes through
 * `axisFrac` and `axisTime`, so none of them can disagree. Within a run, `runFrac` is the same line restricted to
 * that run, which is why a run's own drawing needs no change: its box is simply placed on the axis.
 */
export interface Axis { from: number; to: number }

/** Where time `t` sits across the axis. UNCLAMPED: off the left edge is below 0, off the right above 1. */
export const axisFrac = (a: Axis, t: number): number => (t - a.from) / Math.max(1, a.to - a.from);

/** The time at a fraction across the axis, clamped to it: a drag off the plot means its edge, not time off screen. */
export const axisTime = (a: Axis, frac: number): number => a.from + Math.min(1, Math.max(0, frac)) * (a.to - a.from);

/** The axis to draw: the chosen window, or with none ("everything") the first sample to `now`. Null when there is
 *  nothing to draw. */
export function axisOf(window: Axis | null, runs: readonly (readonly { t: number }[])[], now: number): Axis | null {
    if (window) return window;
    const first = runs.find((r) => r.length)?.[0]?.t;
    return first == null ? null : { from: first, to: Math.max(now, first + 1) };
}

/** The time at a fraction of the plot's width — the inverse of `placeEvents`, for turning a drag into a range. */
export function timeAtFraction(axis: Axis | null, frac: number): number | null {
    return axis ? axisTime(axis, frac) : null;
}

/**
 * WHERE THE NEAREST DATAPOINT SITS, so the crosshair can SNAP to the sample it is reading instead of floating
 * between two. A fraction inside a run reads that run's nearest sample. Just past a run's last sample it still
 * reads that sample, for up to `reachMs`: the next reading has not arrived, and the latest still describes the box
 * — which is the right edge of a live chart, where the pointer spends most of its time. Anywhere else is a gap,
 * where nothing was measured, and reads NOTHING rather than the nearest measurement minutes away.
 *
 * `run` is the index into `runs` as given, so a caller mapping over `runs` can ask "is it in THIS one?".
 */
export function snapFraction<T extends { t: number }>(runs: T[][], frac: number, axis: Axis | null, reachMs = 0): { frac: number; index: number; run: number } | null {
    if (!axis) return null;
    const t = axisTime(axis, frac);
    for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (!run.length) continue;
        const first = run[0].t, last = run[run.length - 1].t;
        if (t < first || t > last + reachMs) continue;
        const index = nearestIndex(run, t);
        return { frac: axisFrac(axis, run[index].t), index, run: i };
    }
    return null;
}

/** The DATAPOINT under a fraction of the plot — what a Grafana-style hover reads, as opposed to the instant the
 *  crosshair labels. A real sample, never one interpolated between two polls: the values in the tooltip are
 *  measurements, and a figure halfway between two readings was never observed. See {@link snapFraction}. */
export function sampleAtFraction<T extends { t: number }>(runs: T[][], frac: number, axis: Axis | null, reachMs = 0): T | null {
    const s = snapFraction(runs, frac, axis, reachMs);
    return s ? runs[s.run][s.index] : null;
}

/** The breaks between runs, as fractions of the axis, each with what it stands for ({@link runGap}). Drawn at their
 *  true width, hatched: the hole is part of the history, and how long it was is part of what it says. */
export function axisGaps(runs: ResourceSample[][], samples: ResourceSample[], axis: Axis): { from: number; to: number; gap: RunGap }[] {
    const out: { from: number; to: number; gap: RunGap }[] = [];
    for (let i = 1; i < runs.length; i++) {
        const gap = runGap(runs[i - 1], runs[i], samples);
        out.push({ from: axisFrac(axis, gap.from), to: axisFrac(axis, gap.to), gap });
    }
    return out;
}

/** The narrowest window double-clicking a bar will scope to. A tool call that took 40ms is a real event
 *  worth pointing at, but a 40ms window contains no samples at all and draws as an empty plot — so a short
 *  block is widened around its own centre rather than scoped to exactly itself. */
export const MIN_SCOPE_MS = 2500;
