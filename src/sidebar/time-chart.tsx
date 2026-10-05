// time-chart.tsx — a stacked time series you can READ: point at (or tap, or arrow-key to) any moment and the tooltip
// says when it was, how much of each series there was then, and the total.
//
// Generic on purpose: the points are `{ t, values }`, the series say their label and CSS class, and the caller says
// how a value and a time are written. The first user is the Storage section's history; anything else that wants a
// small stacked chart over time takes this rather than drawing its own SVG. The resource panel's chart is NOT built on
// it: that one has an axis with gaps, bands that belong to models and keyboard depth, which this deliberately lacks.
//
// The x axis is linear in TIME, not in sample index, so two samples a week apart sit a week apart. The tooltip uses
// the panel's one cursor layer (`cursorTip`, ui-kit.tsx), so it looks and behaves like every other tip here.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cursorTip } from "./ui-kit";

/** One stacked series: its key in each point's `values`, what the tooltip and legend call it, and the class that
 *  colours it (the class sets `fill` for the area and `background` for the tooltip's swatch). */
export interface TimeSeries { key: string; label: string; cls: string }

/** One sample: a time in epoch milliseconds, and each series' value then. A missing key counts as zero. */
export interface TimePoint { t: number; values: Record<string, number | undefined> }

/** The viewBox the areas are drawn in; the SVG is stretched to the box, so these are units, not pixels. */
const W = 1000, H = 100;

/** The default way to write a sample's time: the date, and the time of day. */
const defaultTime = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The index of the sample nearest to time `t`. `points` is sorted by time. */
export function nearestPoint(points: TimePoint[], t: number): number {
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    return best;
}

/**
 * A stacked area chart over time with a hover readout: a rule at the nearest sample, a dot on each series' top edge,
 * and a tooltip naming the time, every series' value and the total.
 *
 * @param points the samples, oldest first; fewer than two draws nothing (a caller says why in its own words)
 * @param series stacking order, bottom first
 * @param format how a value is written (bytes, a count, a percentage)
 * @param formatTime how a sample's time is written in the tooltip
 * @param label the chart's accessible name: what a screen reader hears instead of the picture
 * @param axis what goes under the chart, usually its first time, its peak and its last time
 */
export function TimeChart({ points, series, format, formatTime = defaultTime, label, axis, height = 90 }: {
    points: TimePoint[]; series: TimeSeries[]; format: (v: number) => string; formatTime?: (t: number) => string;
    label: string; axis?: ComponentChildren; height?: number;
}) {
    const [at, setAt] = useState<number | null>(null);
    const box = useRef<HTMLDivElement>(null);
    // A tip this chart put up is taken down if the chart goes away under a still pointer, which raises no leave.
    const owns = useRef(false);
    useEffect(() => () => { if (owns.current) cursorTip.value = null; }, []);
    if (points.length < 2) return null;

    const t0 = points[0].t, t1 = points[points.length - 1].t, span = Math.max(1, t1 - t0);
    const v = (p: TimePoint, k: string) => p.values[k] ?? 0;
    const tops = points.map((p) => { let sum = 0; return series.map((s) => (sum += v(p, s.key))); });
    const max = Math.max(1, ...tops.map((stack) => stack[stack.length - 1] ?? 0));
    const x = (t: number) => ((t - t0) / span) * W;
    const y = (val: number) => H - (val / max) * H;
    const areas = series.map((s, si) => {
        const top = points.map((p, i) => `${x(p.t)},${y(tops[i][si])}`);
        const below = points.map((p, i) => `${x(p.t)},${y(si ? tops[i][si - 1] : 0)}`).reverse();
        return <path key={s.key} class={s.cls} d={`M${top.join("L")}L${below.join("L")}Z`} />;
    });

    /** The tooltip for sample `i`: its time, then each series with a value, then the total when there is more than one. */
    const tip = (i: number) => {
        const p = points[i];
        const rows = series.filter((s) => v(p, s.key) > 0).reverse();   // top of the stack first, as it is drawn
        const total = series.reduce((sum, s) => sum + v(p, s.key), 0);
        return (
            <div class="tc-tip">
                <div class="tc-tip-time">{formatTime(p.t)}</div>
                {rows.map((s) => <div key={s.key} class="rc-tip-line"><span class="rc-tip-name"><i class={`tc-sw ${s.cls}`} />{s.label}</span><span>{format(v(p, s.key))}</span></div>)}
                {rows.length !== 1 ? <div class="rc-tip-line tc-tip-total"><span class="rc-tip-name">Total</span><span>{format(total)}</span></div> : null}
            </div>
        );
    };
    /** Show sample `i`, with the tip at the pointer, or at the rule when the keyboard moved it. */
    const show = (i: number, cx?: number, cy?: number) => {
        setAt(i);
        const r = box.current?.getBoundingClientRect();
        const px = cx ?? (r ? r.left + (x(points[i].t) / W) * r.width : 0);
        const py = cy ?? (r ? r.top + r.height / 2 : 0);
        owns.current = true;
        cursorTip.value = { x: px, y: py, node: tip(i) };
    };
    const hide = () => { setAt(null); if (owns.current) { cursorTip.value = null; owns.current = false; } };
    const fromPointer = (e: PointerEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const frac = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
        show(nearestPoint(points, t0 + frac * span), e.clientX, e.clientY);
    };
    const onKey = (e: KeyboardEvent) => {
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (e.key === "Escape") { hide(); return; }
        if (!step) return;
        e.preventDefault();
        show(Math.min(points.length - 1, Math.max(0, (at ?? (step > 0 ? -1 : points.length)) + step)));
    };

    const p = at != null ? points[at] : null;
    return (
        <div class="tc">
            <div class="tc-plot" ref={box} style={{ height: `${height}px` }} tabIndex={0} role="img" aria-label={label}
                onPointerMove={fromPointer} onPointerDown={fromPointer} onPointerLeave={hide} onKeyDown={onKey} onBlur={hide}>
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">{areas}</svg>
                {p ? <>
                    <div class="tc-rule" style={{ left: `${(x(p.t) / W) * 100}%` }} />
                    {series.map((s, si) => (v(p, s.key) > 0
                        ? <i key={s.key} class={`tc-dot ${s.cls}`} style={{ left: `${(x(p.t) / W) * 100}%`, top: `${(y(tops[at!][si]) / H) * 100}%` }} />
                        : null))}
                </> : null}
            </div>
            {axis ? <div class="tc-axis">{axis}</div> : null}
        </div>
    );
}
