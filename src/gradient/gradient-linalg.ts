// gradient-linalg.ts — dense LU with partial pivoting: the one solver the gradient fills need (the thin-plate system,
// (N+3)-square with N at most a few hundred). Float64, row-major, no dependencies.

/** An LU factorisation of a square matrix with its row permutation; `singular` when a pivot vanished. */
export interface Lu { n: number; lu: Float64Array; perm: Int32Array; singular: boolean }

/** Factor the `n × n` row-major matrix `a` (left untouched). A pivot below `1e-13 ×` the largest entry counts as zero. */
export function luFactor(a: ArrayLike<number>, n: number): Lu {
    const lu = Float64Array.from(a);
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    let scale = 0;
    for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.abs(lu[i]));
    const tiny = 1e-13 * (scale || 1);
    let singular = false;
    for (let k = 0; k < n; k++) {
        let p = k, best = Math.abs(lu[k * n + k]);
        for (let i = k + 1; i < n; i++) {
            const v = Math.abs(lu[i * n + k]);
            if (v > best) { best = v; p = i; }
        }
        if (best <= tiny) { singular = true; continue; }
        if (p !== k) {
            for (let j = 0; j < n; j++) { const t = lu[k * n + j]; lu[k * n + j] = lu[p * n + j]; lu[p * n + j] = t; }
            const t = perm[k]; perm[k] = perm[p]; perm[p] = t;
        }
        const d = lu[k * n + k];
        for (let i = k + 1; i < n; i++) {
            const f = (lu[i * n + k] /= d);
            if (f === 0) continue;
            for (let j = k + 1; j < n; j++) lu[i * n + j] -= f * lu[k * n + j];
        }
    }
    return { n, lu, perm, singular };
}

/** Solve `A X = B` for `X`, where `B` is `n × cols` row-major. Only meaningful when the factorisation is not singular. */
export function luSolve(f: Lu, b: ArrayLike<number>, cols: number): Float64Array {
    const { n, lu, perm } = f;
    const x = new Float64Array(n * cols);
    for (let i = 0; i < n; i++) for (let c = 0; c < cols; c++) x[i * cols + c] = b[perm[i] * cols + c];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < i; k++) {
            const l = lu[i * n + k];
            if (l !== 0) for (let c = 0; c < cols; c++) x[i * cols + c] -= l * x[k * cols + c];
        }
    }
    for (let i = n - 1; i >= 0; i--) {
        for (let k = i + 1; k < n; k++) {
            const u = lu[i * n + k];
            if (u !== 0) for (let c = 0; c < cols; c++) x[i * cols + c] -= u * x[k * cols + c];
        }
        const d = lu[i * n + i];
        for (let c = 0; c < cols; c++) x[i * cols + c] /= d;
    }
    return x;
}
