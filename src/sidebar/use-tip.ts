// Placement for a CURSOR-FOLLOWING tooltip, shared by every one of them (a band, a pool line, a model row, an
// event in the lane) so they cannot drift apart again — the last round of tooltip bugs was four call sites
// each getting the edges wrong in its own way.
import { useRef, useState, useLayoutEffect } from "preact/hooks";
import { tipStyle } from "./tip";

/** A cursor-following tip that places itself against its OWN measured size. Without the measurement the side
 *  is chosen by a heuristic ("past the middle, flip"), which says nothing about whether the tooltip actually
 *  fits — so at the centre of a narrow panel it still ran off the right edge. Measured in a layout effect, so
 *  the correction lands before the browser paints. */
export function useTipPlacement(at: { x: number; y: number; w: number } | null) {
    const ref = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!size || Math.abs(size.w - r.width) > 1 || Math.abs(size.h - r.height) > 1) setSize({ w: r.width, h: r.height });
    });
    const style = at
        ? tipStyle({ ...at, h: typeof window !== "undefined" ? window.innerHeight : 768 }, size ?? undefined)
        : undefined;
    return { ref, style };
}

