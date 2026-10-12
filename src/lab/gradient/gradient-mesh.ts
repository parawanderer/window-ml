// gradient-mesh.ts — the Gradient Mesh's CPU reference: a grid of bicubic Hermite (zero-twist Bézier) patches carrying
// values, evaluated forward in (u, v), inverted per pixel by Newton, and differentiated through the inverse by the
// implicit function theorem. The maths: docs/spec/GRADIENT_FILLS.md §Gradient mesh.

/** A 2-vector. */
export type Vec2 = [number, number];

/** One mesh node: its position, its tangents along a row (`u`) and down a column (`v`) in units of one patch, and its
 *  value. Illustrator's handles are `p + u/3` and `p + v/3` on the far side, and `p − uIn/3`, `p − vIn/3` on the near
 *  side; `uIn` and `vIn` default to `u` and `v` (symmetric handles, a smooth mesh point). */
export interface MeshNode { p: Vec2; u: Vec2; v: Vec2; uIn?: Vec2; vIn?: Vec2; value: number[] }

/** A gradient mesh of `rows × cols` patches, its `(rows+1) × (cols+1)` nodes row-major. */
export interface Mesh {
    rows: number;
    cols: number;
    nodes: MeshNode[];
    /** How values are interpolated over a patch: `bilinear` (PDF's patch meshes, the default) or `bicubic` (C¹). */
    values?: "bilinear" | "bicubic";
    /** The renderer's tessellation per patch side; the reference ignores it. */
    tessellation?: number;
}

/** Where a pixel landed on the mesh: the patch (row-major index) and its parameters. */
export interface MeshHit { patch: number; u: number; v: number }

/** The gradient of a loss with respect to every node's position, tangents and value; `uIn`/`vIn` where the node has them. */
export interface MeshGrad { nodes: { p: Vec2; u: Vec2; v: Vec2; uIn?: Vec2; vIn?: Vec2; value: number[] }[] }

/** The Hermite basis and its derivatives: H0, H1 (positions), T0, T1 (tangents). */
const H0 = (t: number) => 2 * t * t * t - 3 * t * t + 1;
const H1 = (t: number) => -2 * t * t * t + 3 * t * t;
const T0 = (t: number) => t * t * t - 2 * t * t + t;
const T1 = (t: number) => t * t * t - t * t;
const dH0 = (t: number) => 6 * t * t - 6 * t;
const dH1 = (t: number) => -6 * t * t + 6 * t;
const dT0 = (t: number) => 3 * t * t - 4 * t + 1;
const dT1 = (t: number) => 3 * t * t - 2 * t;
/** [H_a, T_a] for corner side a, value or derivative. */
const hermite = (a: number, t: number, d: boolean): [number, number] =>
    a === 0 ? (d ? [dH0(t), dT0(t)] : [H0(t), T0(t)]) : (d ? [dH1(t), dT1(t)] : [H1(t), T1(t)]);
const lin = (a: number, t: number, d: boolean) => (d ? (a === 0 ? -1 : 1) : (a === 0 ? 1 - t : t));

/** The node index of a patch's corner `(a, b)`: `a` steps along the row (u), `b` down the column (v). */
export function cornerNode(mesh: Mesh, patch: number, a: number, b: number): number {
    const pi = Math.floor(patch / mesh.cols), pj = patch % mesh.cols;
    return (pi + b) * (mesh.cols + 1) + pj + a;
}

/** The number of channels a mesh carries: the longest node value. */
export function meshChannels(mesh: Mesh): number {
    let k = 0;
    for (const n of mesh.nodes) k = Math.max(k, n.value.length);
    return k;
}

/** A node's parameter that the geometry is linear in. */
type GeoParam = "p" | "u" | "v" | "uIn" | "vIn";
/** One position-basis term: corner node, which parameter and its weight β. */
type GeoTerm = { node: number; which: GeoParam; w: number };

/** The tangents a patch reads at its corner `(a, b)`: the far-side ones at a = 0 / b = 0, the near-side ones at 1. */
function cornerTangents(n: MeshNode, a: number, b: number): ["u" | "uIn", "v" | "vIn"] {
    return [a === 1 && n.uIn ? "uIn" : "u", b === 1 && n.vIn ? "vIn" : "v"];
}

/** The geometry basis β at (u, v), or of ∂/∂u (`du`) or ∂/∂v (`dv`): S = Σ β θ over the 12 corner parameters. */
function geoBasis(mesh: Mesh, patch: number, u: number, v: number, du = false, dv = false): GeoTerm[] {
    const out: GeoTerm[] = [];
    for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
        const [ha, ta] = hermite(a, u, du), [hb, tb] = hermite(b, v, dv);
        const node = cornerNode(mesh, patch, a, b), [tu, tv] = cornerTangents(mesh.nodes[node], a, b);
        out.push({ node, which: "p", w: ha * hb }, { node, which: tu, w: ta * hb }, { node, which: tv, w: ha * tb });
    }
    return out;
}

/** Evaluate a basis against the node parameters. */
function applyGeo(mesh: Mesh, terms: GeoTerm[]): Vec2 {
    let x = 0, y = 0;
    for (const t of terms) { const q = mesh.nodes[t.node][t.which]!; x += t.w * q[0]; y += t.w * q[1]; }
    return [x, y];
}

/** The patch's position S(u, v). */
export function patchPoint(mesh: Mesh, patch: number, u: number, v: number): Vec2 {
    return applyGeo(mesh, geoBasis(mesh, patch, u, v));
}

/** The Jacobian [∂S/∂u ∂S/∂v] as [Su, Sv]. */
export function patchJacobian(mesh: Mesh, patch: number, u: number, v: number): [Vec2, Vec2] {
    return [applyGeo(mesh, geoBasis(mesh, patch, u, v, true)), applyGeo(mesh, geoBasis(mesh, patch, u, v, false, true))];
}

/** The value basis at (u, v) (or of a derivative), as node → weight. `bicubic` reaches the neighbours of the patch
 *  through the Catmull-Rom value tangents, so it can touch up to 16 nodes; `bilinear` touches the 4 corners. */
export function valueBasis(mesh: Mesh, patch: number, u: number, v: number, du = false, dv = false): Map<number, number> {
    const out = new Map<number, number>();
    const add = (node: number, w: number) => { if (w !== 0) out.set(node, (out.get(node) ?? 0) + w); };
    const pi = Math.floor(patch / mesh.cols), pj = patch % mesh.cols, W = mesh.cols + 1;
    if ((mesh.values ?? "bilinear") === "bilinear") {
        for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) add(cornerNode(mesh, patch, a, b), lin(a, u, du) * lin(b, v, dv));
        return out;
    }
    for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
        const [ha, ta] = hermite(a, u, du), [hb, tb] = hermite(b, v, dv);
        const i = pi + b, j = pj + a;
        add(i * W + j, ha * hb);
        // C_u at (i, j): a central difference along the row, one-sided at its ends.
        const jl = Math.max(0, j - 1), jr = Math.min(mesh.cols, j + 1), su = jr - jl === 2 ? 0.5 : 1;
        add(i * W + jr, ta * hb * su); add(i * W + jl, -ta * hb * su);
        const iu = Math.max(0, i - 1), id = Math.min(mesh.rows, i + 1), sv = id - iu === 2 ? 0.5 : 1;
        add(id * W + j, ha * tb * sv); add(iu * W + j, -ha * tb * sv);
    }
    return out;
}

/** The value at (u, v) on a patch, k channels. */
export function patchValue(mesh: Mesh, patch: number, u: number, v: number, k = meshChannels(mesh)): Float64Array {
    const out = new Float64Array(k);
    for (const [node, w] of valueBasis(mesh, patch, u, v)) {
        const val = mesh.nodes[node].value;
        for (let c = 0; c < k; c++) out[c] += w * (val[c] ?? 0);
    }
    return out;
}

/** The axis-aligned box of a patch's 16 Bézier control points, which contains the patch (convex hull). */
function patchBox(mesh: Mesh, patch: number): [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
        const n = mesh.nodes[cornerNode(mesh, patch, a, b)], [tu, tv] = cornerTangents(n, a, b), U = n[tu]!, V = n[tv]!;
        const su = a === 0 ? 1 / 3 : -1 / 3, sv = b === 0 ? 1 / 3 : -1 / 3;
        for (const [cu, cv] of [[0, 0], [su, 0], [0, sv], [su, sv]]) {
            const x = n.p[0] + cu * U[0] + cv * V[0], y = n.p[1] + cu * U[1] + cv * V[1];
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    }
    return [x0, y0, x1, y1];
}

/** Newton's starting points: the centre first, then near each corner, so a folded patch's roots are all found. */
const STARTS: Vec2[] = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
/** A root is accepted when its residual is below this (height-normalised units: ~1e-7 of the canvas height). */
const RESIDUAL = 1e-10;
const EDGE = 1e-9;

/** Every root of S(u, v) = x inside a patch, by Newton from each start, deduplicated. */
function patchRoots(mesh: Mesh, patch: number, x: number, y: number): Vec2[] {
    const roots: Vec2[] = [];
    for (const [u0, v0] of STARTS) {
        let u = u0, v = v0;
        for (let it = 0; it < 40; it++) {
            const [sx, sy] = patchPoint(mesh, patch, u, v);
            const rx = x - sx, ry = y - sy;
            if (rx * rx + ry * ry < RESIDUAL * RESIDUAL) {
                if (u >= -EDGE && u <= 1 + EDGE && v >= -EDGE && v <= 1 + EDGE &&
                    !roots.some(([ru, rv]) => Math.abs(ru - u) < 1e-7 && Math.abs(rv - v) < 1e-7)) {
                    roots.push([Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))]);
                }
                break;
            }
            const [[a, c], [b, d]] = patchJacobian(mesh, patch, u, v);   // J = [[a, b], [c, d]]
            const det = a * d - b * c;
            if (Math.abs(det) < 1e-300) break;
            let du = (d * rx - b * ry) / det, dv = (-c * rx + a * ry) / det;
            const len = Math.hypot(du, dv);
            if (len > 0.5) { du *= 0.5 / len; dv *= 0.5 / len; }   // damped: keep a step from leaving the patch at once
            u += du; v += dv;
            if (u < -0.5 || u > 1.5 || v < -0.5 || v > 1.5) break;
        }
    }
    return roots;
}

/**
 * Where pixel (x, y) lands, resolving overlap as the renderer draws it: the last patch in row-major order wins, and
 * within a patch the root with the larger v, then the larger u (the later triangle). Null when the mesh does not
 * cover the pixel.
 */
export function locate(mesh: Mesh, x: number, y: number): MeshHit | null {
    for (let patch = mesh.rows * mesh.cols - 1; patch >= 0; patch--) {
        const [x0, y0, x1, y1] = patchBox(mesh, patch);
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const roots = patchRoots(mesh, patch, x, y);
        if (!roots.length) continue;
        roots.sort((r, s) => s[1] - r[1] || s[0] - r[0]);
        return { patch, u: roots[0][0], v: roots[0][1] };
    }
    return null;
}

/** What `evalMesh` returns: S × k values (NaN where the mesh does not cover a sample) and each sample's hit. */
export interface MeshEval { values: Float64Array; k: number; hits: (MeshHit | null)[] }

/** Evaluate the mesh at sample points `xs` (x0, y0, x1, y1, …). */
export function evalMesh(mesh: Mesh, xs: ArrayLike<number>): MeshEval {
    const k = meshChannels(mesh), s = xs.length >> 1;
    const values = new Float64Array(s * k).fill(NaN), hits: (MeshHit | null)[] = [];
    for (let si = 0; si < s; si++) {
        const hit = locate(mesh, xs[2 * si], xs[2 * si + 1]);
        hits.push(hit);
        if (hit) values.set(patchValue(mesh, hit.patch, hit.u, hit.v, k), si * k);
    }
    return { values, k, hits };
}

/** An all-zero gradient shaped like `mesh`. */
function zeroGrad(mesh: Mesh, k: number): MeshGrad {
    return {
        nodes: mesh.nodes.map((n) => ({
            p: [0, 0] as Vec2, u: [0, 0] as Vec2, v: [0, 0] as Vec2,
            ...(n.uIn ? { uIn: [0, 0] as Vec2 } : {}), ...(n.vIn ? { vIn: [0, 0] as Vec2 } : {}),
            value: new Array(k).fill(0),
        })),
    };
}

/**
 * The vector-Jacobian product at fixed pixels: given ∂L/∂f (S × k), the gradient with respect to every node's
 * position, tangents and value. The geometry's part goes through the inverse map (∂(u,v)/∂θ = −J⁻¹ β). Uncovered
 * samples contribute nothing, and coverage itself is not differentiated (the spec's "Not differentiated").
 */
export function vjpMesh(mesh: Mesh, xs: ArrayLike<number>, g: ArrayLike<number>, hits?: (MeshHit | null)[]): MeshGrad {
    const k = meshChannels(mesh), s = xs.length >> 1;
    const grad = zeroGrad(mesh, k);
    for (let si = 0; si < s; si++) {
        const hit = hits ? hits[si] : locate(mesh, xs[2 * si], xs[2 * si + 1]);
        if (!hit) continue;
        const { patch, u, v } = hit;
        const gs = (c: number) => g[si * k + c];
        for (const [node, w] of valueBasis(mesh, patch, u, v)) for (let c = 0; c < k; c++) grad.nodes[node].value[c] += w * gs(c);
        // q = gᵀ [∂V/∂u ∂V/∂v]
        let qu = 0, qv = 0;
        for (const [node, w] of valueBasis(mesh, patch, u, v, true)) for (let c = 0; c < k; c++) qu += w * gs(c) * (mesh.nodes[node].value[c] ?? 0);
        for (const [node, w] of valueBasis(mesh, patch, u, v, false, true)) for (let c = 0; c < k; c++) qv += w * gs(c) * (mesh.nodes[node].value[c] ?? 0);
        if (qu === 0 && qv === 0) continue;
        const [[a, c], [b, d]] = patchJacobian(mesh, patch, u, v);
        const det = a * d - b * c;
        if (Math.abs(det) < 1e-300) continue;   // a cusp: the inverse has no derivative here
        // r = q J⁻¹, J⁻¹ = [[d, −b], [−c, a]] / det
        const rx = (qu * d - qv * c) / det, ry = (-qu * b + qv * a) / det;
        for (const t of geoBasis(mesh, patch, u, v)) {
            const q = grad.nodes[t.node][t.which]!;
            q[0] -= rx * t.w; q[1] -= ry * t.w;
        }
    }
    return grad;
}

/** The loss ½ Σ ‖f(x_s) − t_s‖² over the covered samples and its gradient, through `vjpMesh`. */
export function meshMse(mesh: Mesh, xs: ArrayLike<number>, targets: ArrayLike<number>): { loss: number; grad: MeshGrad; covered: number } {
    const { values, hits } = evalMesh(mesh, xs);
    const g = new Float64Array(values.length);
    let loss = 0, covered = 0;
    for (let i = 0; i < values.length; i++) {
        if (Number.isNaN(values[i])) continue;
        g[i] = values[i] - targets[i]; loss += 0.5 * g[i] * g[i];
    }
    for (const h of hits) if (h) covered++;
    return { loss, grad: vjpMesh(mesh, xs, g, hits), covered };
}

/** Give every node of `mesh` its own near-side handles (`uIn`, `vIn`, copied from `u`, `v`), so each of its four handles
 *  can move alone. The fill is unchanged until one does. */
export function splitHandles(mesh: Mesh): Mesh {
    return { ...mesh, nodes: mesh.nodes.map((n) => ({ ...n, uIn: n.uIn ?? [n.u[0], n.u[1]], vIn: n.vIn ?? [n.v[0], n.v[1]] })) };
}

/** A regular mesh over a rectangle: straight edges, tangents of one patch's size, values from `value(i, j)`. */
export function gridMesh(rows: number, cols: number, box: [number, number, number, number], value: (i: number, j: number) => number[]): Mesh {
    const [x0, y0, x1, y1] = box, w = (x1 - x0) / cols, h = (y1 - y0) / rows;
    const nodes: MeshNode[] = [];
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
        nodes.push({ p: [x0 + j * w, y0 + i * h], u: [w, 0], v: [0, h], value: value(i, j) });
    }
    return { rows, cols, nodes };
}
