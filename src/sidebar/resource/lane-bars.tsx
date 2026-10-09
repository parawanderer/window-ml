// lane-bars.tsx — the event lane's ROWS OF BARS, as one component: what the panel's lane draws, and what a page with no
// panel (the bench's sweep timeline and a run's own page) draws with the same code.
//
// It takes rows already packed (`laneRows`) and paints each bar with `barPaint`. Everything a surface adds on top, the
// panel's hover lineage, its brush, click-to-step and double-click-to-scope, comes in through `barAttrs`/`rowAttrs`, so
// a bar here and a bar in the panel are the same element with the same classes and paint.

import type { ComponentChildren, JSX } from "preact";
import type { EventPlacement } from "../../resource/resource-timeline";
import { barPaint } from "./lane-paint";

/** Extra attributes for one bar: classes appended to its own, and anything else (handlers, data, a title). */
export type BarAttrs = { class?: string } & Omit<JSX.HTMLAttributes<HTMLElement>, "class" | "style">;

/**
 * Rows of event bars, one `.rc-lane-row` each. Only what reaches the screen is drawn (a bar can sit off either edge:
 * the panel packs over a window to the left of what it shows); a bar shorter than `minSpan` is drawn at `minSpan`,
 * the width it was packed at.
 */
export function LaneBars({ rows, minSpan, barAttrs, rowAttrs, rowPrefix, keyOf, as = "span" }: {
    rows: EventPlacement[][];
    minSpan: number;
    barAttrs?: (p: EventPlacement) => BarAttrs;
    rowAttrs?: Omit<JSX.HTMLAttributes<HTMLDivElement>, "class">;
    /** drawn first in every row (the panel's brush overlay); a function, so each row gets its own element */
    rowPrefix?: () => ComponentChildren;
    keyOf?: (p: EventPlacement, i: number) => string | number;
    /** the panel's bars are buttons (they navigate); a document's are plain */
    as?: "button" | "span";
}) {
    const Tag = as;
    return (
        <>
            {rows.map((row, ri) => (
                <div class="rc-lane-row" key={ri} {...rowAttrs}>
                    {rowPrefix?.()}
                    {row.filter((p) => Math.max(p.to, p.from + minSpan) >= 0 && p.from <= 1).map((p, i) => {
                        const paint = barPaint(p.event);
                        const w = Math.max(minSpan * 100, (p.to - p.from) * 100);   // packed at this width too
                        const { class: extra, ...attrs } = barAttrs?.(p) ?? {};
                        return (
                            <Tag class={`rc-ev ${paint.cls}${extra ? ` ${extra}` : ""}`} key={keyOf ? keyOf(p, i) : i}
                                style={{ left: `${p.from * 100}%`, width: `${w}%`, ...paint.style }}
                                // Which model this block belongs to, readable from OUTSIDE the colour. The identity is
                                // otherwise only a CSS custom property, so "is the lane drawing one model or two" (the
                                // question behind the two-spellings bug) could only be answered by eye.
                                data-model={p.event.model ?? undefined}
                                // …and WHAT it is, for the same reason: two asides of one model (a session's title and a
                                // code annotation) are otherwise told apart only by hovering.
                                data-label={p.event.label}
                                {...(attrs as Record<string, unknown>)}>
                                {paint.overlays.map((o, oi) => (
                                    <i class={o.cls} key={oi}
                                        style={{ left: `${o.start * 100}%`, width: `${(o.end - o.start) * 100}%`, ...(o.background ? { background: o.background } : {}) }} />
                                ))}
                            </Tag>
                        );
                    })}
                </div>
            ))}
        </>
    );
}
