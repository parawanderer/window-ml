// Where a CURSOR-FOLLOWING tooltip goes. One implementation, because the panel has several of them (a chart
// band, a pool's line, a model row) and each hand-rolled variant got the edges subtly wrong in its own way:
// one clamped instead of flipping and landed under the pointer, another never flipped horizontally at all and
// was cut off by the window edge.
//
// Two rules, both about never covering what you are pointing at:
//   • HORIZONTAL — sit to the right of the cursor, unless that would run past the right bound, in which case
//     sit to its left. Never clamp: a clamped tip ends up beneath the pointer.
//   • VERTICAL — sit above the cursor, unless there isn't room, in which case sit below. Same reason.
//
// Pure and unit-tested: the bounds are passed in, so it works for a tip positioned inside a plot (bounds = the
// plot) and one positioned against the viewport (bounds = the window).

/** Gap between the cursor and the tip, and how far above/below it sits. */
export const TIP_GAP = 10, TIP_ABOVE = 26, TIP_BELOW = 18;

export interface TipAt {
    /** Cursor position, in the same coordinate space as `w` (plot-relative, or viewport). */
    x: number;
    y: number;
    /** Width of the space the tip must stay inside. */
    w: number;
}

/** A style object for a cursor-following tip. `left`/`right` are always BOTH set, so a previous frame's value
 *  can't linger when the tip flips sides. */
export function tipStyle(at: TipAt): Record<string, string> {
    // Past the middle, there is more room on the left — flip rather than run off the edge.
    const flipX = at.x > at.w * 0.55;
    const above = at.y - TIP_ABOVE >= 2;
    return {
        ...(flipX
            ? { right: `${Math.max(2, at.w - at.x + TIP_GAP)}px`, left: "auto" }
            : { left: `${at.x + TIP_GAP}px`, right: "auto" }),
        top: `${above ? at.y - TIP_ABOVE : at.y + TIP_BELOW}px`,
    };
}
