// lane-bars.tsx — the event lane's ROWS OF BARS, as one component: what the panel's lane draws, and what a page with no
// panel (the bench's sweep timeline and a run's own page) draws with the same code.
//
// It takes rows already packed (`laneRows`) and paints each bar from `barShape`. Everything a surface adds on top, the
// panel's hover lineage, its brush, click-to-step and double-click-to-scope, comes in through `barAttrs`/`rowAttrs`, so
// a bar here and a bar in the panel are the same element with the same classes and paint.
//
// ONE SVG FOR THE WHOLE LANE, a `<g>` per row and per bar. It was a positioned element per bar in a clipping element
// per row, and every one of those is a layer the browser re-layerizes and hit-tests on every repaint anywhere on the
// page: on a long sweep (~2,800 bars) that was most of what a pointer move over the memory chart above it cost, though
// no bar changed. Shapes inside one SVG are neither, and they keep what the elements had: pointer events, classes the
// lineage dims by, focus and a name. Dimming is `fill-opacity` (sidebar.css), never `opacity`, which would make each
// dimmed bar a layer again.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { EventPlacement } from "../../resource/resource-timeline";
import { barShape, type Paint } from "./lane-paint";

/** Extra attributes for one bar: classes appended to its own, and anything else (handlers, data, a title). */
export type BarAttrs = { class?: string } & Omit<JSX.SVGAttributes<SVGGElement>, "class" | "style">;

/** A lane row's height and the gap under it, in px. */
export const LANE_ROW_PX = 9, LANE_GAP_PX = 2;

/** The narrowest a bar is drawn, in px: the packer reserves at least this much (resource-lane-ui.tsx `MIN_BAR_PX`). */
const MIN_BAR_PX = 3;

/** The width a lane is drawn at before it has been measured, stretched to its box. */
const NOMINAL_PX = 1000;

/**
 * One SLICE of a rounded bar as path data: the part of the bar at `X`..`X + BW` (2px corners, less on a bar too small
 * for them) between `x0` and `x1`. A phase at either end follows the corner's curve, however thin; one in the middle is
 * a rectangle. So a bar cut into phases is rounded as ONE bar, and its cuts stay straight.
 */
export function barSlice(X: number, BW: number, y: number, h: number, x0: number, x1: number): string {
    const r = Math.min(2, BW / 2, h / 2), n = (v: number) => +v.toFixed(2);
    /** How far the bar's top edge sits below `y` at `x`: zero except inside a corner. */
    const dip = (x: number) => {
        const d = x < X + r ? X + r - x : x > X + BW - r ? x - (X + BW - r) : 0;
        return r - Math.sqrt(Math.max(0, r * r - Math.min(d, r) ** 2));
    };
    const xs = [x0, x1];
    for (let k = 0; k <= 4; k++) xs.push(X + (r * k) / 4, X + BW - r + (r * k) / 4);
    const at = [...new Set(xs.filter((x) => x >= x0 && x <= x1).map(n))].sort((a, b) => a - b);
    const top = at.map((x) => `${n(x)},${n(y + dip(x))}`), bottom = at.map((x) => `${n(x)},${n(y + h - dip(x))}`).reverse();
    return `M${[...top, ...bottom].join("L")}Z`;
}

/** A pattern's id, from what it draws, so every bar with the same fill shares one definition. */
const patternId = (p: Paint): string => `rcp-${[...JSON.stringify(p)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;

/** The SVG `fill` for a paint: the colour itself, or a reference to its pattern. */
const fillOf = (p: Paint): string => ("color" in p ? p.color : `url(#${patternId(p)})`);

/** One pattern's definition: its ground, then the dots or the stripes on it, the stripes leaning as the CSS angle does. */
function PatternDef({ p }: { p: Exclude<Paint, { color: string }> }) {
    if ("dots" in p) {
        return <pattern id={patternId(p)} patternUnits="userSpaceOnUse" width={p.cell} height={p.cell}>
            <rect width={p.cell} height={p.cell} style={{ fill: p.ground }} />
            <circle cx={p.cell / 2} cy={p.cell / 2} r={p.r + 0.25} style={{ fill: p.dots }} />
        </pattern>;
    }
    return <pattern id={patternId(p)} patternUnits="userSpaceOnUse" width={8} height={8} patternTransform={`rotate(${-p.lean})`}>
        <rect width={8} height={8} style={{ fill: p.ground }} />
        <rect width={3} height={8} style={{ fill: p.stripes }} />
    </pattern>;
}

/**
 * Rows of event bars, one `<g class="rc-lane-row">` each, in one SVG. Only what reaches the screen is drawn (a bar can
 * sit off either edge: the panel packs over a window to the left of what it shows); a bar shorter than `minSpan` is
 * drawn at `minSpan`, the width it was packed at, and never under `MIN_BAR_PX`.
 *
 * Each bar is a `<g class="rc-ev rc-ev-<kind>">` carrying `data-model`, `data-label`, and its place on the lane as
 * `data-x`/`data-w` (percent of the lane), with `role="button"` and a name when it navigates (`as`).
 */
export function LaneBars({ rows, minSpan, barAttrs, rowAttrs, rowPrefix, keyOf, as = "span" }: {
    rows: EventPlacement[][];
    minSpan: number;
    barAttrs?: (p: EventPlacement) => BarAttrs;
    /** on the lane's box: the brush's drag and the cursor, which every row used to carry */
    rowAttrs?: Omit<JSX.HTMLAttributes<HTMLDivElement>, "class">;
    /** drawn over the rows, once (the panel's brush overlay) */
    rowPrefix?: () => ComponentChildren;
    keyOf?: (p: EventPlacement, i: number) => string | number;
    /** the panel's bars navigate, so they are buttons to a keyboard and a screen reader; a document's are plain */
    as?: "button" | "span";
}) {
    // DRAWN IN PIXELS, at the lane's measured width: the 3px floor is then exact, and a bar's rounded ends are plain path
    // data. Placing by percentages took a `calc()` per shape and a `<use>` per rounded end, and each of those is per-
    // element compositing state again. Until the first measurement (and where nothing is laid out, as in jsdom) it draws
    // at a nominal width, stretched to the box.
    const box = useRef<HTMLDivElement>(null);
    const [measured, setMeasured] = useState(0);
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const read = () => { const w = el.getBoundingClientRect().width; if (w > 0) setMeasured((old) => (Math.abs(old - w) >= 0.5 ? w : old)); };
        read();
        if (typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const W = measured || NOMINAL_PX;
    const drawn = rows.map((row) => row.filter((p) => Math.max(p.to, p.from + minSpan) >= 0 && p.from <= 1)
        .map((p) => ({ p, shape: barShape(p.event) })));
    const patterns = new Map<string, Exclude<Paint, { color: string }>>();
    for (const row of drawn) for (const { shape } of row) for (const sg of [...shape.segs, ...shape.over]) {
        if (!("color" in sg.paint)) patterns.set(patternId(sg.paint), sg.paint);
    }
    const height = Math.max(0, rows.length * (LANE_ROW_PX + LANE_GAP_PX) - LANE_GAP_PX);
    const n = (v: number) => +v.toFixed(2);
    return (
        <div class="rc-lane-bars" ref={box} style={{ height: `${height}px` }} {...rowAttrs}>
            {rowPrefix?.()}
            <svg class="rc-lane-svg" width="100%" height={height} viewBox={`0 0 ${n(W)} ${height}`} preserveAspectRatio="none">
                <defs>
                    {[...patterns.values()].map((p) => <PatternDef key={patternId(p)} p={p} />)}
                    {/* An OPEN bar's fill dissolves toward its right edge (`.rc-ev.open`): it has not ended there. */}
                    {drawn.some((row) => row.some(({ p }) => p.event.open)) ? (<>
                        <linearGradient id="rc-ev-open-fade"><stop offset="0.6" stop-color="#fff" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient>
                        <mask id="rc-ev-open" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#rc-ev-open-fade)" /></mask>
                    </>) : null}
                </defs>
                {drawn.map((row, ri) => (
                    // Placed by `y`, not a transform per row: a transform is per-row compositing state too.
                    <g class="rc-lane-row" key={ri}>
                        {row.map(({ p, shape }, i) => {
                            const top = ri * (LANE_ROW_PX + LANE_GAP_PX);
                            const left = p.from * 100;
                            const w = Math.max(minSpan * 100, (p.to - p.from) * 100);   // packed at this width too
                            const x = p.from * W, bw = Math.max(MIN_BAR_PX, (w / 100) * W);
                            const y = top + (shape.half ? LANE_ROW_PX / 4 : 0), h = shape.half ? LANE_ROW_PX / 2 : LANE_ROW_PX;
                            /** A stretch of this bar, `a`..`b` of its width, `l`/`r` px in from each side, as x and width. */
                            const at = (a: number, b: number, l = 0, r = l) => ({ x: n(x + a * bw + l), width: n(Math.max(0, (b - a) * bw - l - r)) });
                            const { class: extra, ...attrs } = barAttrs?.(p) ?? {};
                            const onClick = (attrs as { onClick?: (e: Event) => void }).onClick;
                            return (
                                <g class={`rc-ev ${shape.cls}${extra ? ` ${extra}` : ""}`} key={keyOf ? keyOf(p, i) : i}
                                    // Which model this block belongs to, readable from OUTSIDE the colour, and WHAT it is: two
                                    // asides of one model (a session's title and a code annotation) are otherwise told apart only
                                    // by hovering.
                                    data-model={p.event.model ?? undefined} data-label={p.event.label}
                                    data-x={left.toFixed(4)} data-w={w.toFixed(4)} style={shape.model ? { "--model": shape.model } : undefined}
                                    // `tabindex` in lower case: an SVG attribute keeps the case it is given, and `tabIndex` names nothing.
                                    {...(as === "button" ? { role: "button", tabindex: 0, "aria-label": p.event.label,
                                        onKeyDown: (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onClick?.(ev); } } } : {})}
                                    {...(attrs as Record<string, unknown>)}>
                                    {/* A hairline in the panel's own colour just OUTSIDE the bar, so two bars packed flush read as TWO
                                        (inside it would show through the fills, which are not opaque). Its area is what the pointer hits. */}
                                    <rect class="rc-ev-gap" y={y - 0.5} height={h + 1} rx={2.5} {...at(0, 1, -0.5)} />
                                    {/* The segments, a 1px cut in the panel's colour between phases (two weights of one colour side by
                                        side read as a gradient, not a boundary). The bar is rounded as ONE bar: only its own two ends. */}
                                    {shape.segs.map((sg, k) => {
                                        const g = at(sg.start, sg.end, shape.cuts && k > 0 ? 1 : 0, 0);
                                        return <path key={k} class={`rc-ev-seg${sg.cls ? ` ${sg.cls}` : ""}`} style={{ fill: fillOf(sg.paint) }}
                                            d={barSlice(x, bw, y, h, g.x, g.x + g.width)} />;
                                    })}
                                    {shape.over.map((sg, k) => <rect key={`o${k}`} class={`rc-ev-over${sg.cls ? ` ${sg.cls}` : ""}`} y={y} height={h}
                                        {...at(sg.start, sg.end)} style={{ fill: fillOf(sg.paint) }} />)}
                                    {[...shape.segs, ...shape.over].filter((sg) => sg.edge).map((sg, k) => <rect key={`e${k}`} class="rc-ev-edge" y={y} height={h}
                                        x={at(sg.start, sg.end).x} width={1} style={{ fill: sg.edge }} />)}
                                    {shape.outline ? <rect class={`rc-ev-outline${shape.outline.dash ? " dash" : ""}`} y={y + 0.5} height={h - 1} rx={shape.outline.radius ?? 2}
                                        {...at(0, 1, 0.5)} style={{ stroke: shape.outline.color }} /> : null}
                                    {/* The hover ring and the double-click pulse, drawn INSIDE the bar and over its fills, so they look
                                        the same on every fill: flat, cut into phases, dotted or striped. */}
                                    <rect class="rc-ev-ring" y={y + 0.5} height={h - 1} rx={2} {...at(0, 1, 0.5)} />
                                </g>
                            );
                        })}
                    </g>
                ))}
            </svg>
        </div>
    );
}
