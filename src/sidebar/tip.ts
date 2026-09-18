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
//
// `tileOffsets` is the other placement problem in the panel: several tips anchored to their own TRACKS at
// once, which the keyboard reader produces, and which must not be allowed to sit on each other.

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


/** Gap kept between two tiled tips, and how close to the window's edge one may sit. */
export const TILE_GAP = 6, TILE_EDGE = 4;

/** One tip's measured box, in viewport coordinates, at the position it WANTS: its own track's corner. */
export interface TipRect { left: number; right: number; top: number; height: number; }

/**
 * How far each tip must move DOWN to clear the ones before it, in DOM order, which is reading order.
 *
 * A tip's preferred position is its own track's corner, because that alignment is what tells a reader which
 * trace it describes. So nothing is moved that does not have to be: a tip gives way only to one already
 * placed that it would actually cover, and then only far enough to clear it.
 *
 * OVERLAP IS TWO-DIMENSIONAL, which is the whole of this function. Tracks are not always a column — a custom
 * layout puts two cards SIDE BY SIDE — and two tips in different columns share a top edge while covering
 * nothing of each other. Testing the vertical alone pushed the right-hand one a full tip's height down the
 * window, away from the track it belonged to, with the space it wanted still empty beside it.
 *
 * Each tip is measured against EVERY tip already placed rather than only the last, since in a grid the one
 * above is not the one before. Horizontal ranges do not change (the correction is vertical), so the
 * intersection test is fixed and one pass taking the largest push is exact.
 *
 * The last rule is the window: a stack under a low track would reach past the bottom, so a tip is pulled back
 * up to fit, never below `TILE_EDGE` from either edge. That can put it back over the one before it — there is
 * no room for both, and a tip off the screen says nothing at all.
 */
export function tileOffsets(rects: TipRect[], viewportH: number): number[] {
    const out: number[] = [];
    const placed: { left: number; right: number; bottom: number }[] = [];
    for (const r of rects) {
        let dy = 0;
        for (const p of placed) {
            if (r.right <= p.left || r.left >= p.right) continue;   // different columns: nothing is covered
            dy = Math.max(dy, p.bottom + TILE_GAP - r.top);
        }
        const bottom = r.top + r.height;
        if (bottom + dy > viewportH - TILE_EDGE) dy = Math.max(TILE_EDGE - r.top, viewportH - TILE_EDGE - bottom);
        out.push(dy);
        placed.push({ left: r.left, right: r.right, bottom: bottom + dy });
    }
    return out;
}
