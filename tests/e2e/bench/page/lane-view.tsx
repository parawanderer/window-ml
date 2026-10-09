// lane-view.tsx — one set of events drawn as the resource panel's event lane, on a given time axis: the rows (packed by
// the panel's own `laneRows`, painted by its `LaneBars`) and, optionally, the axis under them. Used by the bench page's
// sweep timeline (many runs, one shared axis) and by a run's own page (one run).

import { eventsIn, type ResourceEvent } from "../../../../src/resource/resource-timeline";
import { placeEvents, laneRows, MIN_EV_SPAN } from "../../../../src/resource/resource-lane";
import { useState } from "preact/hooks";
import { LaneBars } from "../../../../src/sidebar/resource/lane-bars";
import { EventTipBody } from "../../../../src/sidebar/resource/event-tip";
import { useTipPlacement } from "../../../../src/sidebar/use-tip";
import type { EventPlacement } from "../../../../src/resource/resource-timeline";
import { fmtSpan } from "./format";

export type Axis = { from: number; to: number };

/** The window a set of events spans: earliest start to latest end (an open event's end is `now`); null when nothing
 *  has an extent. */
export function laneWindow(events: readonly ResourceEvent[], now?: number): Axis | null {
    const spans = events.filter((e) => e.until != null || e.open);
    if (!spans.length) return null;
    const from = Math.min(...spans.map((e) => e.t));
    return { from, to: Math.max(...spans.map((e) => e.until ?? now ?? e.t), from + 1) };
}

/** What a bar is, in one line: its label and model, how long, its phases, whether it is still going. The bar's
 *  accessible name; the tooltip (`LaneTip`) says the rest. */
export function barTitle(e: ResourceEvent): string {
    const dur = e.until != null ? ` · ${fmtSpan(e.until - e.t)}` : "";
    const phases = e.phases?.length ? ` · ${e.phases.map((ph, i) => `${ph.kind} ${fmtSpan(ph.until - (i ? e.phases![i - 1].until : e.t))}`).join(", ")}` : "";
    return `${e.label}${e.model && !e.label.includes(e.model) ? ` (${e.model})` : ""}${dur}${phases}${e.open ? " · still running" : ""}`;
}

/**
 * The lane's rows for `events` on `axis`. Instants (no end) are not bars, as in the panel; work still in flight runs to
 * `now`. A page has more height to spend than the panel, so the row caps are the caller's.
 */
export function LaneRows({ events, axis, now, maxRows = 8, maxTotal = 24 }: { events: readonly ResourceEvent[]; axis: Axis; now?: number; maxRows?: number; maxTotal?: number }) {
    const spans = events.filter((e) => e.until != null || e.open)
        .map((e) => (e.until == null && e.open && now != null ? { ...e, until: now } : e));
    const rows = laneRows(placeEvents(axis, eventsIn(spans, axis.from, axis.to)), maxRows, MIN_EV_SPAN, maxTotal);
    const [hover, setHover] = useState<{ p: EventPlacement; x: number; y: number } | null>(null);
    const at = (p: EventPlacement) => (ev: PointerEvent) => setHover({ p, x: ev.clientX, y: ev.clientY });
    return (
        <div class="rc-lane-rows">
            <LaneBars rows={rows} minSpan={MIN_EV_SPAN} barAttrs={(p) => ({
                "aria-label": barTitle(p.event),
                onPointerEnter: at(p), onPointerMove: at(p),
                onPointerLeave: () => setHover(null),
            })} />
            {hover ? <LaneTip p={hover.p} x={hover.x} y={hover.y} /> : null}
        </div>
    );
}

/**
 * The panel's tooltip for the bar under the pointer (event-tip.tsx `EventTipBody`), following the cursor and placed
 * as the panel places it. A page knows nothing of the box the run used, so only what the event itself carries.
 */
export function LaneTip({ p, x, y }: { p: EventPlacement; x: number; y: number }) {
    const { ref, style } = useTipPlacement({ x, y, w: window.innerWidth });
    return <div class="rc-tip rc-tip-event" role="tooltip" ref={ref} style={style}><EventTipBody e={p.event} clipped={!!p.clipped} /></div>;
}

/** Tick spacing for a window: the smallest of the usual steps that gives at most `max` ticks. */
function tickStep(spanMs: number, max = 8): number {
    const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
    return steps.find((s) => spanMs / s <= max) ?? steps[steps.length - 1];
}

/** The time axis under a lane: ticks in time since `axis.from`. */
export function LaneAxis({ axis }: { axis: Axis }) {
    const span = axis.to - axis.from, step = tickStep(span);
    const ticks: number[] = [];
    for (let t = 0; t <= span; t += step) ticks.push(t);
    return (
        <div class="wml-lane-axis">
            {ticks.map((t) => <span key={t} style={{ left: `${(t / span) * 100}%` }}>{fmtSpan(t)}</span>)}
        </div>
    );
}

/** One run's lane, with its axis: what a run's own page shows. */
export function RunLane({ events, now }: { events: readonly ResourceEvent[]; now?: number }) {
    const axis = laneWindow(events, now);
    if (!axis) return null;
    return (
        <section class="wml-lane" aria-label="event timeline">
            <LaneRows events={events} axis={axis} now={now} />
            <LaneAxis axis={axis} />
        </section>
    );
}
