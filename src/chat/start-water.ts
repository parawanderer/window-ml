// start-water.ts — the WATER under the start page's dot field (start-field.ts): a damped 2D wave equation on the dot
// grid, which the pointer drops energy into and which carries it outward until it dies away.
//
// ∂²h/∂t² = c²∇²h − γ∂h/∂t, stepped explicitly at a fixed rate on the grid of dots (one cell per dot). With the
// velocity v = h − h₋ per step, and the loss taken at the MIDPOINT of the step:
//
//     v' − v = K·Δh − S·h − a·(v' + v),   h' = h + v',   Δh = h[x+1] + h[x−1] + h[y+1] + h[y−1] − 4h
//
// K = c²dt²/dx² must stay below 1/2 for the 2D scheme to be stable (the CFL bound). Taking the loss at the midpoint
// is what makes it a loss: summing by parts, the scheme's energy (`energy`) changes by exactly −a·|v' + v|² a step,
// which is never positive, where scaling the whole update by a factor lets it creep up between steps. The edges
// reflect (a missing neighbour reads as the cell itself), and cells under the box are held at zero, so ripples
// bounce off it rather than running under it; both keep Δ symmetric, which the identity needs.
//
// THE LEVEL. With reflecting edges a uniform rise of the whole sheet has no restoring force, so anything that adds
// volume lifts it for good: the first stir test drifted to a height of 630. A drop therefore MOVES water rather than
// adding it (`splash` stamps zero net volume), and a weak spring to the rest level, S, brings back whatever the edges
// of a stamp or the box still leak.

/** The scheme's K = c²dt²/dx²: about a third of a cell per step, under the 2D stability bound of 1/2. */
export const WAVE_K = 0.12;
/** What is left of a free ripple's speed after a step, at `STEP_HZ`: an e-fold in about two seconds, so a ripple is
 *  gone in five or six. */
export const DAMP = 0.992;
/** The spring back to the rest level, per step²: weak enough that a ripple never feels it (a period of ~6 s). */
export const LEVEL = 0.0003;
/** The fixed rate the water is stepped at, whatever the display's frame rate. */
export const STEP_HZ = 60;

/** A grid of water, `cols`×`rows`, row-major like the dot grid, with its constants (the defaults above). */
export interface Water {
    cols: number; rows: number;
    /** K, DAMP and LEVEL for this sheet: a tuning panel changes them live */
    k: number; damp: number; level: number;
    /** height now, and one step ago */
    h: Float32Array; prev: Float32Array;
    /** 1 where the water is held at zero (under the box) */
    still: Uint8Array;
}

/** Still water, `cols`×`rows`. */
export function water(cols: number, rows: number): Water {
    const n = cols * rows;
    return { cols, rows, k: WAVE_K, damp: DAMP, level: LEVEL, h: new Float32Array(n), prev: new Float32Array(n), still: new Uint8Array(n) };
}

/** Advance the water one step. */
export function stepWater(w: Water): void {
    const { cols, rows, h, prev, still } = w;
    // The midpoint loss `a` that leaves `damp` of the speed: (1 − a)/(1 + a) = damp. K is held under the bound.
    const loss = (1 - w.damp) / (1 + w.damp), k = Math.min(w.k, 0.49), level = w.level;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            if (still[i]) { prev[i] = 0; continue; }
            const c = h[i];
            const lap = (x > 0 ? h[i - 1] : c) + (x < cols - 1 ? h[i + 1] : c)
                + (y > 0 ? h[i - cols] : c) + (y < rows - 1 ? h[i + cols] : c) - 4 * c;
            // prev becomes next in place: it is read only at i, before it is written at i.
            prev[i] = c + ((1 - loss) * (c - prev[i]) + k * lap - level * c) / (1 + loss);
        }
    }
    w.h = prev; w.prev = h;
}

/** Hold the cells `inside(x, y)` says are under the box at zero from now on, and free the rest. */
export function holdStill(w: Water, inside: (x: number, y: number) => boolean): void {
    for (let y = 0; y < w.rows; y++) {
        for (let x = 0; x < w.cols; x++) {
            const i = y * w.cols + x;
            w.still[i] = inside(x, y) ? 1 : 0;
            if (w.still[i]) { w.h[i] = 0; w.prev[i] = 0; }
        }
    }
}

/**
 * Drop `amount` of displacement into the water at grid position (gx, gy) (fractional cells): a Gaussian bump of
 * `radius` cells, so a drop has no single-cell spike for the grid to ring on, less its own mean over the cells it
 * covers, so it moves water about and adds none (see THE LEVEL above).
 */
export function splash(w: Water, gx: number, gy: number, amount: number, radius = 1.4): void {
    const r = Math.ceil(radius * 2.5);
    const x0 = Math.max(0, Math.floor(gx - r)), x1 = Math.min(w.cols - 1, Math.ceil(gx + r));
    const y0 = Math.max(0, Math.floor(gy - r)), y1 = Math.min(w.rows - 1, Math.ceil(gy + r));
    const cells: number[] = [], amounts: number[] = [];
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const i = y * w.cols + x;
            if (w.still[i]) continue;
            cells.push(i); amounts.push(amount * Math.exp(-((x - gx) ** 2 + (y - gy) ** 2) / (2 * radius * radius)));
        }
    }
    const mean = amounts.reduce((t, v) => t + v, 0) / Math.max(cells.length, 1);
    cells.forEach((i, k) => { w.h[i] += amounts[k] - mean; });
}

/**
 * The water's energy as THIS scheme conserves it: Σ(h − h₋)² + K·Σ∇h·∇h₋ + S·Σh·h₋, the leapfrog form, whose
 * potential terms pair two steps (K·Σ|∇h|² is not conserved by it, and wobbles). Undamped it is constant; damping only
 * drains it. What the tests watch.
 */
export function energy(w: Water): number {
    const { h, prev, cols, level } = w, k = Math.min(w.k, 0.49);
    let e = 0;
    for (let i = 0; i < h.length; i++) {
        e += (h[i] - prev[i]) ** 2 + level * h[i] * prev[i];
        if ((i + 1) % cols) e += k * (h[i + 1] - h[i]) * (prev[i + 1] - prev[i]);
        if (i + cols < h.length) e += k * (h[i + cols] - h[i]) * (prev[i + cols] - prev[i]);
    }
    return e;
}
