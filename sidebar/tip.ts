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
    /** Height of that space, when the tip's own height is known too (see `size`). */
    h?: number;
}

/** The tip's MEASURED size, when the caller has it. Without it the side is chosen by a heuristic — sit right
 *  of the cursor until past the middle — which is wrong for any tip wide enough to matter: at the centre of a
 *  360px panel a 190px tooltip still runs off the edge, because "past the middle" says nothing about whether
 *  the thing FITS. With it, the question becomes the real one: is there room on this side? */
export interface TipSize { w: number; h: number; }

/** A style object for a cursor-following tip. `left`/`right` are always BOTH set, so a previous frame's value
 *  can't linger when the tip flips sides. */
export function tipStyle(at: TipAt, size?: TipSize): Record<string, string> {
    // With a measured width, flip only when the tip does NOT FIT to the right — and when it fits on neither
    // side, take the roomier one, since something has to give and the wider side clips less.
    const roomRight = at.w - (at.x + TIP_GAP);
    const flipX = size
        ? (size.w > roomRight && at.x - TIP_GAP > roomRight)
        : at.x > at.w * 0.55;
    // Vertical: prefer above, but only if the tip's own height fits there. Without a measurement this is the
    // old guess (one line's worth); with one it is the real question.
    const needAbove = size ? size.h + TIP_GAP : TIP_ABOVE;
    const above = at.y - needAbove >= 2;
    let top = above ? at.y - needAbove : at.y + TIP_BELOW;
    // …and never past the bottom: a tip placed below near the window's edge would hang off it.
    if (size && at.h != null) top = Math.max(2, Math.min(top, at.h - size.h - 2));
    return {
        ...(flipX
            ? { right: `${Math.max(2, at.w - at.x + TIP_GAP)}px`, left: "auto" }
            : { left: `${Math.max(2, Math.min(at.x + TIP_GAP, size ? at.w - size.w - 2 : at.x + TIP_GAP))}px`, right: "auto" }),
        top: `${top}px`,
    };
}
