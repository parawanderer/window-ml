// resource-decimate.ts — which samples of a run a plot needs to DRAW at the width it is drawn: at most four per screen
// column (the first, the lowest, the highest and the last), so a long history costs what the screen can show rather
// than what was recorded.
//
// The lines are the expensive part of hovering a busy chart: every pointer move re-renders the plot, and the browser
// hit-tests and repaints each polyline at every point it holds, thousands of them inside a few hundred pixels. Keeping
// each column's extremes and its two ends draws the same picture (a spike one sample wide still reaches its peak, in
// the column it happened in), and a zoom spreads the run over more columns, so the detail comes back as the window
// narrows. Readings (a tooltip, the snapped dot) keep using the full run: only the drawing is thinned.

/**
 * The indices of `n` samples worth drawing across `columns` screen columns: per column (samples bucketed by `x`), the
 * first, the one with the lowest `y`, the one with the highest, and the last, in order and without repeats. Every
 * index when there are no more samples than four per column, so a short or zoomed run is drawn exactly.
 *
 * @param x each sample's position along the run, 0..1 (`runFrac`), non-decreasing
 * @param y each sample's value
 */
export function m4Indices(n: number, x: (i: number) => number, y: (i: number) => number, columns: number): number[] {
    const cols = Math.max(1, Math.floor(columns));
    if (n <= cols * 4) return Array.from({ length: n }, (_, i) => i);
    const out: number[] = [];
    let i = 0;
    while (i < n) {
        const col = Math.min(cols - 1, Math.floor(x(i) * cols));
        let lo = i, hi = i, last = i;
        let loV = y(i), hiV = loV;
        let j = i + 1;
        for (; j < n && Math.min(cols - 1, Math.floor(x(j) * cols)) === col; j++) {
            const v = y(j);
            if (v < loV) { loV = v; lo = j; }
            if (v > hiV) { hiV = v; hi = j; }
            last = j;
        }
        // In time order, so the line visits them as the samples did.
        for (const k of [...new Set([i, lo, hi, last])].sort((a, b) => a - b)) out.push(k);
        i = j;
    }
    return out;
}

/** The same selection shared by several series drawn from one set of samples (a stacked area's bands, whose edges
 *  must stay on common samples): the union of each series' `m4Indices`, in order. */
export function m4IndicesMany(n: number, x: (i: number) => number, ys: ((i: number) => number)[], columns: number): number[] {
    if (n <= Math.max(1, Math.floor(columns)) * 4) return Array.from({ length: n }, (_, i) => i);
    const keep = new Set<number>();
    for (const y of ys) for (const i of m4Indices(n, x, y, columns)) keep.add(i);
    return [...keep].sort((a, b) => a - b);
}
