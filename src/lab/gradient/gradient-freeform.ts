// gradient-freeform.ts — the Freeform gradient's CPU reference: values pinned at scattered points, interpolated by a
// thin-plate spline or by inverse-distance weighting (Lines mode samples curves into more such points), evaluated in Float64 with the vector-Jacobian product for every
// parameter. The maths and its derivation: docs/spec/GRADIENT_FILLS.md §Freeform gradient.

import { luFactor, luSolve, type Lu } from "./gradient-linalg";

/** One pinned point: where it is (height-normalised, y down), its value (k channels) and, for `shepard`, its spread. */
export interface FreeformPoint { x: number; y: number; value: number[]; spread?: number }

/** A line of Lines mode: the stops a Catmull-Rom curve passes through, in order, and how many samples per segment. */
export interface FreeformLine { stops: FreeformPoint[]; samples?: number }

/** A Freeform gradient. `tps` (default) interpolates exactly; `shepard` is local and honours each point's spread. */
export interface Freeform {
    mode?: "tps" | "shepard";
    points: FreeformPoint[];
    /** Lines mode: values along curves, sampled into constraint points beside `points` (`flattenFreeform`). */
    lines?: FreeformLine[];
    /** `tps`: λ, added to the kernel's diagonal; 0 interpolates exactly. */
    smoothing?: number;
    /** `shepard`: the distance power q. */
    power?: number;
    /** `shepard`: ε, which keeps the weights finite and differentiable at the points. */
    soften?: number;
}

/** The gradient of a loss with respect to one point or stop: its position, value and spread. */
export interface PointGrad { x: number; y: number; value: number[]; spread: number }

/** The gradient of a loss with respect to every parameter of a Freeform gradient, shaped like its points and lines. */
export interface FreeformGrad { points: PointGrad[]; lines?: { stops: PointGrad[] }[] }

/** The solved thin-plate system: `weights` is (N+3) × k row-major (N kernel weights, then the affine a0, a1, a2). */
export interface TpsSolution { n: number; k: number; weights: Float64Array; lu: Lu }

/** The defaults the spec names, in one place so the renderer and the reference cannot disagree. */
export const FREEFORM_DEFAULTS = { smoothing: 0, power: 2, soften: 1e-3, lineSamples: 8 } as const;

/** The number of channels a fill carries: the longest value among its points and stops (shorter ones read as 0). */
export function freeformChannels(ff: Freeform): number {
    let k = 0;
    for (const p of ff.points) k = Math.max(k, p.value.length);
    for (const l of ff.lines ?? []) for (const p of l.stops) k = Math.max(k, p.value.length);
    return k;
}

/** One line sample's recipe: its line, and its weights over that line's stops for position (`at`) and value (`mix`). */
export interface LineSample { line: number; at: [stop: number, weight: number][]; mix: [stop: number, weight: number][] }

/** The uniform Catmull-Rom weights of segment `i` (of a line of `m` stops) at `t`, the ends extended by reflection. */
function catmullRom(i: number, m: number, t: number): [number, number][] {
    const t2 = t * t, t3 = t2 * t;
    const b = [0.5 * (-t3 + 2 * t2 - t), 0.5 * (3 * t3 - 5 * t2 + 2), 0.5 * (-3 * t3 + 4 * t2 + t), 0.5 * (t3 - t2)];
    const w = new Map<number, number>();
    const add = (j: number, v: number) => w.set(j, (w.get(j) ?? 0) + v);
    if (i > 0) add(i - 1, b[0]); else { add(i, 2 * b[0]); add(i + 1, -b[0]); }        // P_{−1} = 2P_0 − P_1
    add(i, b[1]); add(i + 1, b[2]);
    if (i + 2 < m) add(i + 2, b[3]); else { add(i + 1, 2 * b[3]); add(i, -b[3]); }      // P_M = 2P_{M−1} − P_{M−2}
    return [...w];
}

/**
 * Lines mode as plain points: every line sampled into constraint points (docs/spec/GRADIENT_FILLS.md §Lines), appended
 * after `points`, with each sample's recipe so a gradient can be pulled back to the stops. A fill with no lines comes
 * back with the same points.
 */
export function flattenFreeform(ff: Freeform): { fill: Freeform; samples: LineSample[] } {
    const { lines, ...rest } = ff;
    const points = ff.points.slice(), samples: LineSample[] = [];
    (lines ?? []).forEach((l, li) => {
        const st = l.stops, m = st.length, per = Math.max(1, Math.round(l.samples ?? FREEFORM_DEFAULTS.lineSamples));
        const push = (at: [number, number][], mix: [number, number][]) => {
            let x = 0, y = 0, spread = 0;
            const value: number[] = [];
            for (const [j, a] of at) { x += a * st[j].x; y += a * st[j].y; }
            for (const [j, g] of mix) {
                spread += g * (st[j].spread ?? 1);
                st[j].value.forEach((v, c) => { value[c] = (value[c] ?? 0) + g * v; });
            }
            for (let c = 0; c < value.length; c++) value[c] ??= 0;
            points.push({ x, y, value, spread });
            samples.push({ line: li, at, mix });
        };
        for (let i = 0; i + 1 < m; i++) {
            for (let s = 0; s < per; s++) { const t = s / per; push(catmullRom(i, m, t), [[i, 1 - t], [i + 1, t]]); }
        }
        if (m) push([[m - 1, 1]], [[m - 1, 1]]);
    });
    return { fill: { ...rest, points }, samples };
}

/** φ(r) = r² log r from r², with φ(0) = 0. */
const phi = (r2: number) => (r2 > 0 ? 0.5 * r2 * Math.log(r2) : 0);
/** ψ(r) = φ′(r)/r = 2 log r + 1 from r²; its product with a vanishing displacement is 0, so 0 at r = 0. */
const psi = (r2: number) => (r2 > 0 ? Math.log(r2) + 1 : 0);

/** Are the points too few, or too close to one line, for the thin-plate spline's affine part? */
export function tpsDegenerate(points: FreeformPoint[]): boolean {
    const n = points.length;
    if (n < 3) return true;
    let mx = 0, my = 0;
    for (const p of points) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let a = 0, b = 0, c = 0;
    for (const p of points) { const dx = p.x - mx, dy = p.y - my; a += dx * dx; b += dx * dy; c += dy * dy; }
    const tr = a + c, disc = Math.sqrt(((a - c) / 2) ** 2 + b * b);
    const lmax = tr / 2 + disc, lmin = tr / 2 - disc;
    return !(lmax > 0) || lmin / lmax < 1e-10;
}

/** The thin-plate system matrix A, (N+3)-square, row-major. */
function tpsMatrix(points: FreeformPoint[], lambda: number): Float64Array {
    const n = points.length, m = n + 3;
    const a = new Float64Array(m * m);
    for (let i = 0; i < n; i++) {
        const pi = points[i];
        for (let j = 0; j < n; j++) {
            const dx = pi.x - points[j].x, dy = pi.y - points[j].y;
            a[i * m + j] = i === j ? lambda : phi(dx * dx + dy * dy);
        }
        const poly = [1, pi.x, pi.y];
        for (let c = 0; c < 3; c++) { a[i * m + n + c] = poly[c]; a[(n + c) * m + i] = poly[c]; }
    }
    return a;
}

/** Solve the thin-plate system, or null when it is degenerate (too few points, collinear, or coincident with λ = 0). */
export function solveTps(ff: Freeform): TpsSolution | null {
    const pts = ff.points;
    if (tpsDegenerate(pts)) return null;
    const n = pts.length, k = freeformChannels(ff), m = n + 3;
    const lu = luFactor(tpsMatrix(pts, ff.smoothing ?? FREEFORM_DEFAULTS.smoothing), m);
    if (lu.singular) return null;
    const b = new Float64Array(m * k);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) b[i * k + c] = pts[i].value[c] ?? 0;
    return { n, k, weights: luSolve(lu, b, k), lu };
}

/** What `evalFreeform` returns: S × k values, the mode actually used, and whether `tps` fell back to `shepard`. */
export interface FreeformEval { values: Float64Array; k: number; mode: "tps" | "shepard"; degenerate: boolean }

/** Evaluate the fill at sample points `xs` (x0, y0, x1, y1, …). The values are unclamped. */
export function evalFreeform(ff: Freeform, xs: ArrayLike<number>): FreeformEval {
    if (ff.lines) return evalFreeform(flattenFreeform(ff).fill, xs);
    const k = freeformChannels(ff), s = xs.length >> 1;
    const values = new Float64Array(s * k);
    if (!ff.points.length || !k) return { values, k, mode: ff.mode ?? "tps", degenerate: !ff.points.length };
    if ((ff.mode ?? "tps") === "tps") {
        const sol = solveTps(ff);
        if (sol) {
            const { n, weights: w } = sol;
            for (let si = 0; si < s; si++) {
                const x = xs[2 * si], y = xs[2 * si + 1];
                for (let c = 0; c < k; c++) values[si * k + c] = w[n * k + c] + w[(n + 1) * k + c] * x + w[(n + 2) * k + c] * y;
                for (let i = 0; i < n; i++) {
                    const dx = x - ff.points[i].x, dy = y - ff.points[i].y, f = phi(dx * dx + dy * dy);
                    if (f !== 0) for (let c = 0; c < k; c++) values[si * k + c] += w[i * k + c] * f;
                }
            }
            return { values, k, mode: "tps", degenerate: false };
        }
        shepardInto(ff, xs, k, values);
        return { values, k, mode: "shepard", degenerate: true };
    }
    shepardInto(ff, xs, k, values);
    return { values, k, mode: "shepard", degenerate: false };
}

/** The Shepard weight ω_i(x) and the shared denominator term (d² + ε²). */
function shepardWeight(p: FreeformPoint, x: number, y: number, q: number, eps2: number): [number, number] {
    const dx = x - p.x, dy = y - p.y, d2e = dx * dx + dy * dy + eps2;
    return [(p.spread ?? 1) * Math.pow(d2e, -q / 2), d2e];
}

/** Inverse-distance weighting into `out`. A sample exactly on a point with ε = 0 takes that point's value. */
function shepardInto(ff: Freeform, xs: ArrayLike<number>, k: number, out: Float64Array): void {
    const q = ff.power ?? FREEFORM_DEFAULTS.power, eps = ff.soften ?? FREEFORM_DEFAULTS.soften, eps2 = eps * eps;
    const s = xs.length >> 1;
    for (let si = 0; si < s; si++) {
        const x = xs[2 * si], y = xs[2 * si + 1];
        let total = 0;
        const hit = ff.points.find((p) => eps2 === 0 && p.x === x && p.y === y);
        if (hit) { for (let c = 0; c < k; c++) out[si * k + c] = hit.value[c] ?? 0; continue; }
        for (const p of ff.points) {
            const [w] = shepardWeight(p, x, y, q, eps2);
            total += w;
            for (let c = 0; c < k; c++) out[si * k + c] += w * (p.value[c] ?? 0);
        }
        for (let c = 0; c < k; c++) out[si * k + c] /= total;
    }
}

/** An all-zero gradient for one point or stop. */
const zeroPoint = (k: number): PointGrad => ({ x: 0, y: 0, value: new Array(k).fill(0), spread: 0 });

/** An all-zero gradient shaped like `ff`. */
function zeroGrad(ff: Freeform, k: number): FreeformGrad {
    const grad: FreeformGrad = { points: ff.points.map(() => zeroPoint(k)) };
    if (ff.lines) grad.lines = ff.lines.map((l) => ({ stops: l.stops.map(() => zeroPoint(k)) }));
    return grad;
}

/**
 * The vector-Jacobian product: given the upstream gradient `g` (S × k, ∂L/∂f at each sample), the gradient of L with
 * respect to every point's position, value and spread. It follows the mode `evalFreeform` actually used, fallback
 * included; a line's stops get the samples' gradient pulled back through `flattenFreeform`'s weights. `smoothing`,
 * `power`, `soften` and a line's `samples` are hyperparameters and get none.
 */
export function vjpFreeform(ff: Freeform, xs: ArrayLike<number>, g: ArrayLike<number>): FreeformGrad {
    const k = freeformChannels(ff);
    const grad = zeroGrad(ff, k);
    if (ff.lines) {
        const { fill, samples } = flattenFreeform(ff), n0 = ff.points.length;
        const flat = vjpFreeform(fill, xs, g);
        grad.points = flat.points.slice(0, n0);
        samples.forEach((smp, j) => {
            const gp = flat.points[n0 + j], stops = grad.lines![smp.line].stops;
            for (const [m, a] of smp.at) { stops[m].x += a * gp.x; stops[m].y += a * gp.y; }
            for (const [m, w] of smp.mix) {
                stops[m].spread += w * gp.spread;
                for (let c = 0; c < k; c++) stops[m].value[c] += w * gp.value[c];
            }
        });
        return grad;
    }
    if (!ff.points.length || !k) return grad;
    const sol = (ff.mode ?? "tps") === "tps" ? solveTps(ff) : null;
    if (sol) tpsVjp(ff, sol, xs, g, grad);
    else shepardVjp(ff, xs, g, k, grad);
    return grad;
}

/** The thin-plate VJP, term by term as the spec writes it. */
function tpsVjp(ff: Freeform, sol: TpsSolution, xs: ArrayLike<number>, g: ArrayLike<number>, grad: FreeformGrad): void {
    const { n, k, weights: w, lu } = sol, m = n + 3, pts = ff.points, s = xs.length >> 1;
    // Ḡ_W = Σ_s K(x_s)ᵀ G_s, and the direct term through K.
    const gw = new Float64Array(m * k);
    for (let si = 0; si < s; si++) {
        const x = xs[2 * si], y = xs[2 * si + 1];
        for (let c = 0; c < k; c++) {
            const gc = g[si * k + c];
            gw[n * k + c] += gc; gw[(n + 1) * k + c] += gc * x; gw[(n + 2) * k + c] += gc * y;
        }
        for (let i = 0; i < n; i++) {
            const dx = x - pts[i].x, dy = y - pts[i].y, r2 = dx * dx + dy * dy, f = phi(r2), ps = psi(r2);
            let gdotw = 0;
            for (let c = 0; c < k; c++) { const gc = g[si * k + c]; gw[i * k + c] += gc * f; gdotw += gc * w[i * k + c]; }
            grad.points[i].x -= gdotw * ps * dx;
            grad.points[i].y -= gdotw * ps * dy;
        }
    }
    // Ḡ_B = A⁻¹ Ḡ_W (A symmetric); ∂L/∂c_i = Ḡ_B[i].
    const gb = luSolve(lu, gw, k);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) grad.points[i].value[c] = gb[i * k + c];
    // Ḡ_A = −Ḡ_B Wᵀ, read only where A depends on the points.
    const ga = (i: number, j: number) => { let v = 0; for (let c = 0; c < k; c++) v -= gb[i * k + c] * w[j * k + c]; return v; };
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, ps = psi(dx * dx + dy * dy);
            if (ps === 0) continue;
            const sym = ga(i, j) + ga(j, i);
            grad.points[i].x += sym * ps * dx;
            grad.points[i].y += sym * ps * dy;
        }
        grad.points[i].x += ga(i, n + 1) + ga(n + 1, i);
        grad.points[i].y += ga(i, n + 2) + ga(n + 2, i);
    }
}

/** The Shepard VJP. */
function shepardVjp(ff: Freeform, xs: ArrayLike<number>, g: ArrayLike<number>, k: number, grad: FreeformGrad): void {
    const q = ff.power ?? FREEFORM_DEFAULTS.power, eps = ff.soften ?? FREEFORM_DEFAULTS.soften, eps2 = eps * eps;
    const s = xs.length >> 1, n = ff.points.length;
    const f = evalFreeform({ ...ff, mode: "shepard" }, xs).values;
    const om = new Float64Array(n), den = new Float64Array(n);
    for (let si = 0; si < s; si++) {
        const x = xs[2 * si], y = xs[2 * si + 1];
        let total = 0;
        for (let i = 0; i < n; i++) { [om[i], den[i]] = shepardWeight(ff.points[i], x, y, q, eps2); total += om[i]; }
        if (!Number.isFinite(total) || total === 0) continue;   // on a point with ε = 0: the value is pinned, no gradient
        for (let i = 0; i < n; i++) {
            const p = ff.points[i], gi = grad.points[i];
            let dfdw = 0;   // gᵀ ∂f/∂ω_i = gᵀ (c_i − f) / Ω
            for (let c = 0; c < k; c++) {
                const gc = g[si * k + c];
                gi.value[c] += gc * om[i] / total;
                dfdw += gc * ((p.value[c] ?? 0) - f[si * k + c]) / total;
            }
            const dwdp = q * om[i] / den[i];
            gi.x += dfdw * dwdp * (x - p.x);
            gi.y += dfdw * dwdp * (y - p.y);
            gi.spread += dfdw * om[i] / (p.spread ?? 1);
        }
    }
}

/** The loss ½ Σ ‖f(x_s) − t_s‖² against targets (S × k) and its gradient, through `vjpFreeform`. */
export function freeformMse(ff: Freeform, xs: ArrayLike<number>, targets: ArrayLike<number>): { loss: number; grad: FreeformGrad } {
    const { values } = evalFreeform(ff, xs);
    const g = new Float64Array(values.length);
    let loss = 0;
    for (let i = 0; i < values.length; i++) { g[i] = values[i] - targets[i]; loss += 0.5 * g[i] * g[i]; }
    return { loss, grad: vjpFreeform(ff, xs, g) };
}
