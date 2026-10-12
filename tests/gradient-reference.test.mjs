// gradient-reference.test.mjs — the gradient fills' CPU reference (src/lab/gradient/): interpolation properties of the
// Freeform gradient (thin-plate and Shepard) and the Gradient Mesh, and every vector-Jacobian product against central
// finite differences. The maths these hold the code to: docs/spec/GRADIENT_FILLS.md.
import { test } from "node:test";
import assert from "node:assert";
import { evalFreeform, vjpFreeform, freeformMse, solveTps, flattenFreeform } from "../src/lab/gradient/gradient-freeform.ts";
import { evalMesh, vjpMesh, gridMesh, locate, patchPoint, patchValue, splitHandles } from "../src/lab/gradient/gradient-mesh.ts";

/** A seeded generator (mulberry32), so a failure reproduces. */
function rng(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Every number in a JSON-shaped object, as [getter, setter, path] triples, sorted by path so that two objects with
 *  the same leaves pair up whatever order their keys were written in. */
function leaves(obj, skip = new Set()) {
    const out = [];
    const walk = (o, at) => {
        for (const key of Object.keys(o)) {
            if (skip.has(key)) continue;
            if (typeof o[key] === "number") out.push([() => o[key], (v) => { o[key] = v; }, `${at}.${key}`]);
            else if (o[key] && typeof o[key] === "object") walk(o[key], `${at}.${key}`);
        }
    };
    walk(obj, "");
    return out.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

/** L = Σ g·f(x) through `evaluate`, and its central difference for every leaf of `params`, compared to `analytic`. */
function checkFd(params, evaluate, analytic, g, { h = 1e-6, tol = 2e-5, skip } = {}) {
    const L = () => { const f = evaluate(params); let s = 0; for (let i = 0; i < f.length; i++) s += g[i] * f[i]; return s; };
    const ps = leaves(params, skip), as = leaves(analytic, skip);
    assert.deepStrictEqual(ps.map((l) => l[2]), as.map((l) => l[2]), "the gradient is not shaped like the parameters");
    let worst = 0, where = -1;
    for (let i = 0; i < ps.length; i++) {
        const [get, set] = ps[i], v = get();
        set(v + h); const up = L();
        set(v - h); const dn = L();
        set(v);
        const fd = (up - dn) / (2 * h), an = as[i][0]();
        const err = Math.abs(fd - an) / Math.max(1, Math.abs(fd));
        if (err > worst) { worst = err; where = i; }
    }
    assert.ok(worst < tol, `worst relative error ${worst.toExponential(2)} at ${ps[where]?.[2]}`);
}

const randomPoints = (r, n, k) => Array.from({ length: n }, () => ({
    x: 0.1 + 0.8 * r(), y: 0.1 + 0.8 * r(), value: Array.from({ length: k }, () => r()), spread: 0.5 + r(),
}));
const randomSamples = (r, s) => Float64Array.from({ length: 2 * s }, () => r());

// --- the Freeform gradient: what the interpolants promise ---------------------------------------------------------------------

test("tps with no smoothing is exact at every point", () => {
    const r = rng(1);
    const ff = { mode: "tps", points: randomPoints(r, 12, 3) };
    const xs = ff.points.flatMap((p) => [p.x, p.y]);
    const { values, mode } = evalFreeform(ff, xs);
    assert.strictEqual(mode, "tps");
    ff.points.forEach((p, i) => p.value.forEach((v, c) => assert.ok(Math.abs(values[i * 3 + c] - v) < 1e-9)));
});

test("tps reproduces an affine function everywhere, not just at the points", () => {
    const r = rng(2);
    const affine = (x, y) => [0.2 + 0.5 * x - 0.3 * y];
    const ff = { points: randomPoints(r, 8, 1).map((p) => ({ ...p, value: affine(p.x, p.y) })) };
    const xs = randomSamples(r, 50);
    const { values } = evalFreeform(ff, xs);
    for (let s = 0; s < 50; s++) assert.ok(Math.abs(values[s] - affine(xs[2 * s], xs[2 * s + 1])[0]) < 1e-9);
});

test("tps with smoothing no longer interpolates exactly, and is still solvable", () => {
    const r = rng(3);
    const ff = { points: randomPoints(r, 10, 1), smoothing: 0.05 };
    const xs = ff.points.flatMap((p) => [p.x, p.y]);
    const { values } = evalFreeform(ff, xs);
    assert.ok(ff.points.some((p, i) => Math.abs(values[i] - p.value[0]) > 1e-4));
});

test("tps falls back to shepard, and says so, for too few, collinear or coincident points", () => {
    const line = [0, 0.25, 0.5, 0.75].map((t) => ({ x: t, y: 2 * t, value: [t] }));
    const two = line.slice(0, 2);
    const dup = [{ x: 0.1, y: 0.1, value: [0] }, { x: 0.1, y: 0.1, value: [1] }, { x: 0.9, y: 0.2, value: [0] }, { x: 0.3, y: 0.8, value: [1] }];
    for (const points of [line, two, dup]) {
        const out = evalFreeform({ mode: "tps", points }, [0.3, 0.3]);
        assert.strictEqual(out.mode, "shepard");
        assert.strictEqual(out.degenerate, true);
        assert.ok(Number.isFinite(out.values[0]));
    }
    assert.strictEqual(solveTps({ points: line }), null);
});

test("shepard with no softening is exact at the points; with softening, close", () => {
    const r = rng(4);
    const points = randomPoints(r, 6, 2);
    const xs = points.flatMap((p) => [p.x, p.y]);
    const exact = evalFreeform({ mode: "shepard", points, soften: 0 }, xs).values;
    const soft = evalFreeform({ mode: "shepard", points }, xs).values;
    points.forEach((p, i) => p.value.forEach((v, c) => {
        assert.strictEqual(exact[i * 2 + c], v);
        assert.ok(Math.abs(soft[i * 2 + c] - v) < 1e-3);
    }));
});

test("a fill with no points evaluates to zeros and has an empty gradient", () => {
    const out = evalFreeform({ points: [] }, [0.5, 0.5]);
    assert.strictEqual(out.values.length, 0);
    assert.deepStrictEqual(vjpFreeform({ points: [] }, [0.5, 0.5], []), { points: [] });
});

// --- the Freeform gradient: every gradient against finite differences ---------------------------------------------------------

const ffCases = [
    ["tps", { mode: "tps" }],
    ["tps with smoothing", { mode: "tps", smoothing: 0.01 }],
    ["shepard", { mode: "shepard" }],
    ["shepard, power 3, larger softening", { mode: "shepard", power: 3, soften: 0.05 }],
];
for (const [name, opts] of ffCases) {
    test(`freeform VJP matches finite differences: ${name}`, () => {
        for (const seed of [11, 12, 13]) {
            const r = rng(seed), k = 3;
            const ff = { ...opts, points: randomPoints(r, 7, k) };
            const xs = randomSamples(r, 40), g = Float64Array.from({ length: 40 * k }, () => r() - 0.5);
            const skip = new Set(["mode", "smoothing", "power", "soften", ...(opts.mode === "tps" ? ["spread"] : [])]);
            const grad = vjpFreeform(ff, xs, g);
            checkFd(ff, (p) => evalFreeform(p, xs).values, grad, g, { skip });
        }
    });
}

test("freeform VJP follows the fallback: a degenerate tps differentiates as shepard", () => {
    const r = rng(14);
    const ff = { mode: "tps", points: [0.2, 0.5, 0.8].map((t) => ({ x: t, y: t, value: [r(), r()], spread: 1 })) };
    const xs = randomSamples(r, 20), g = Float64Array.from({ length: 40 }, () => r() - 0.5);
    // Moving a point off the line would leave the fallback, so check only the values and spreads here.
    const grad = vjpFreeform(ff, xs, g);
    checkFd(ff, (p) => evalFreeform(p, xs).values, grad, g, { skip: new Set(["mode", "x", "y"]) });
});

test("freeformMse descends: a small step along −∇ lowers the loss", () => {
    const r = rng(15);
    const ff = { points: randomPoints(r, 6, 3) };
    const xs = randomSamples(r, 64), targets = Float64Array.from({ length: 64 * 3 }, () => r());
    const { loss, grad } = freeformMse(ff, xs, targets);
    const step = 1e-3;
    const next = { points: ff.points.map((p, i) => ({ ...p, x: p.x - step * grad.points[i].x, y: p.y - step * grad.points[i].y, value: p.value.map((v, c) => v - step * grad.points[i].value[c]) })) };
    assert.ok(freeformMse(next, xs, targets).loss < loss);
});

// --- the Freeform gradient: Lines mode ---------------------------------------------------------------------------------------

const randomLine = (r, m, k, samples) => ({ stops: randomPoints(r, m, k), ...(samples ? { samples } : {}) });

test("a line's samples start at each stop and end at the last, carrying the stops' values there", () => {
    const r = rng(21);
    const line = randomLine(r, 4, 3, 5);
    const { fill, samples } = flattenFreeform({ points: [], lines: [line] });
    assert.strictEqual(fill.points.length, 3 * 5 + 1);
    assert.strictEqual(fill.lines, undefined, "the flattened fill is points only");
    for (const [m, at] of [[0, 0], [1, 5], [2, 10], [3, 15]]) {
        const p = fill.points[at], st = line.stops[m];
        assert.ok(Math.hypot(p.x - st.x, p.y - st.y) < 1e-12, `sample ${at} is stop ${m}`);
        st.value.forEach((v, c) => assert.ok(Math.abs(p.value[c] - v) < 1e-12));
    }
    for (const smp of samples) {
        assert.ok(Math.abs(smp.at.reduce((a, [, w]) => a + w, 0) - 1) < 1e-12, "position weights are affine");
        assert.ok(Math.abs(smp.mix.reduce((a, [, w]) => a + w, 0) - 1) < 1e-12, "value weights are affine");
    }
});

test("a two-stop line samples the straight segment between them, evenly", () => {
    const { fill } = flattenFreeform({ points: [], lines: [{ stops: [{ x: 0.1, y: 0.2, value: [0] }, { x: 0.9, y: 0.6, value: [1] }], samples: 4 }] });
    fill.points.forEach((p, s) => {
        assert.ok(Math.abs(p.x - (0.1 + 0.2 * s)) < 1e-12 && Math.abs(p.y - (0.2 + 0.1 * s)) < 1e-12, `sample ${s} at ${p.x}, ${p.y}`);
        assert.ok(Math.abs(p.value[0] - s / 4) < 1e-12);
    });
});

test("a fill with lines is exact at every sample under tps, and a fill without lines flattens to itself", () => {
    const r = rng(22);
    const ff = { points: randomPoints(r, 4, 2), lines: [randomLine(r, 3, 2, 4), randomLine(r, 1, 2)] };
    const flat = flattenFreeform(ff).fill;
    assert.strictEqual(flat.points.length, 4 + 9 + 1);
    const { values, mode } = evalFreeform(ff, flat.points.flatMap((p) => [p.x, p.y]));
    assert.strictEqual(mode, "tps");
    flat.points.forEach((p, i) => p.value.forEach((v, c) => assert.ok(Math.abs(values[i * 2 + c] - v) < 1e-7)));
    const plain = { points: ff.points };
    assert.deepStrictEqual(flattenFreeform(plain), { fill: plain, samples: [] });
});

for (const mode of ["tps", "shepard"]) {
    test(`freeform VJP through line stops matches finite differences: ${mode}`, () => {
        for (const seed of [23, 24]) {
            const r = rng(seed), k = 3;
            const ff = { mode, smoothing: mode === "tps" ? 1e-3 : undefined, points: randomPoints(r, 3, k), lines: [randomLine(r, 3, k, 3), randomLine(r, 2, k, 2)] };
            const xs = randomSamples(r, 40), g = Float64Array.from({ length: 40 * k }, () => r() - 0.5);
            const skip = new Set(["mode", "smoothing", "samples", ...(mode === "tps" ? ["spread"] : [])]);
            const grad = vjpFreeform(ff, xs, g);
            assert.strictEqual(grad.lines.length, 2);
            checkFd(ff, (p) => evalFreeform(p, xs).values, grad, g, { skip, tol: 1e-4 });
        }
    });
}

// --- the Gradient Mesh: forward map and inverse ------------------------------------------------------------------------

/** A gently warped 2 × 3 mesh, no folds: every node moved and its tangents turned a little. */
function warpedMesh(r, values = "bilinear", k = 3) {
    const m = gridMesh(2, 3, [0.1, 0.1, 1.2, 0.9], () => Array.from({ length: k }, () => r()));
    for (const n of m.nodes) {
        n.p[0] += 0.03 * (r() - 0.5); n.p[1] += 0.03 * (r() - 0.5);
        n.u[0] *= 1 + 0.2 * (r() - 0.5); n.u[1] += 0.05 * (r() - 0.5);
        n.v[1] *= 1 + 0.2 * (r() - 0.5); n.v[0] += 0.05 * (r() - 0.5);
    }
    return { ...m, values };
}

/** `warpedMesh` with every node's handles split, and each near-side handle turned on its own. */
function brokenHandleMesh(r, values = "bilinear", k = 3) {
    const m = splitHandles(warpedMesh(r, values, k));
    for (const n of m.nodes) {
        n.uIn[0] *= 1 + 0.4 * (r() - 0.5); n.uIn[1] += 0.08 * (r() - 0.5);
        n.vIn[1] *= 1 + 0.4 * (r() - 0.5); n.vIn[0] += 0.08 * (r() - 0.5);
    }
    return m;
}

/** Pixels strictly inside patches, by mapping random (u, v) in [0.2, 0.8]² forward. */
function interiorSamples(r, mesh, s) {
    const xs = [];
    for (let i = 0; i < s; i++) xs.push(...patchPoint(mesh, Math.floor(r() * mesh.rows * mesh.cols), 0.2 + 0.6 * r(), 0.2 + 0.6 * r()));
    return Float64Array.from(xs);
}

test("a regular grid mesh maps (u, v) affinely, and locate inverts it", () => {
    const m = gridMesh(2, 2, [0, 0, 1, 1], (i, j) => [i, j]);
    assert.deepStrictEqual(patchPoint(m, 3, 0.25, 0.75).map((v) => +v.toFixed(12)), [0.625, 0.875]);
    const hit = locate(m, 0.625, 0.875);
    assert.strictEqual(hit.patch, 3);
    assert.ok(Math.abs(hit.u - 0.25) < 1e-9 && Math.abs(hit.v - 0.75) < 1e-9);
    assert.strictEqual(locate(m, 1.5, 0.5), null);
});

test("both value interpolations are exact at the nodes, and bilinear is bilinear inside a patch", () => {
    const r = rng(21);
    for (const values of ["bilinear", "bicubic"]) {
        const m = warpedMesh(r, values);
        for (let patch = 0; patch < m.rows * m.cols; patch++) {
            const pi = Math.floor(patch / m.cols), pj = patch % m.cols;
            for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                const node = m.nodes[(pi + b) * (m.cols + 1) + pj + a];
                const v = patchValue(m, patch, a, b);
                node.value.forEach((c, i) => assert.ok(Math.abs(v[i] - c) < 1e-12));
            }
        }
    }
    const m = gridMesh(1, 1, [0, 0, 1, 1], (i, j) => [i + 2 * j + 3 * i * j]);
    assert.ok(Math.abs(patchValue(m, 0, 0.3, 0.6)[0] - (0.6 + 0.6 + 3 * 0.18)) < 1e-12);
});

test("evalMesh agrees with the forward map at interior pixels, and is NaN off the mesh", () => {
    const r = rng(22);
    const m = warpedMesh(r);
    const patch = 4, u = 0.37, v = 0.61;
    const [x, y] = patchPoint(m, patch, u, v);
    const { values, hits } = evalMesh(m, [x, y, -1, -1]);
    assert.strictEqual(hits[0].patch, patch);
    const want = patchValue(m, patch, u, v);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(values[c] - want[c]) < 1e-9);
    assert.ok(Number.isNaN(values[3]) && hits[1] === null);
});

test("where patches overlap, the later patch wins (the renderer's draw order)", () => {
    // Two patches side by side, the right one's far edge dragged back over the left one.
    const m = gridMesh(1, 2, [0, 0, 1, 0.5], (i, j) => [j]);
    m.nodes[2].p = [0.1, 0]; m.nodes[5].p = [0.1, 0.5];
    m.nodes[2].u = [-0.4, 0]; m.nodes[5].u = [-0.4, 0];
    const hit = locate(m, 0.3, 0.25);
    assert.strictEqual(hit.patch, 1);
});

test("independent handles: splitting changes nothing, and neighbouring patches still share their edges", () => {
    const r = rng(25);
    const m = warpedMesh(r), split = splitHandles(m), xs = interiorSamples(r, m, 20);
    assert.deepStrictEqual(evalMesh(split, xs).values, evalMesh(m, xs).values);
    const b = brokenHandleMesh(r);
    for (let t = 0; t <= 1; t += 0.125) {
        // Along a row: patch 0's right edge is patch 1's left edge. Down a column: patch 0's bottom is patch 3's top.
        const [ax, ay] = patchPoint(b, 0, 1, t), [bx, by] = patchPoint(b, 1, 0, t);
        assert.ok(Math.hypot(ax - bx, ay - by) < 1e-12, `row edge at ${t}`);
        const [cx, cy] = patchPoint(b, 0, t, 1), [dx, dy] = patchPoint(b, 3, t, 0);
        assert.ok(Math.hypot(cx - dx, cy - dy) < 1e-12, `column edge at ${t}`);
    }
    // A near-side handle moves only the patch on its side: patch 1 reads node 1's u at its left corner, patch 0 reads uIn.
    const before = patchPoint(b, 1, 0.5, 0.5);
    b.nodes[1].uIn = [b.nodes[1].uIn[0] * 2, 0.2];
    assert.deepStrictEqual(patchPoint(b, 1, 0.5, 0.5), before);
});

// --- the Gradient Mesh: every gradient against finite differences -------------------------------------------------------

for (const values of ["bilinear", "bicubic"]) {
    test(`mesh VJP matches finite differences, positions, tangents and values: ${values}`, () => {
        for (const seed of [31, 32]) {
            const r = rng(seed), k = 3;
            const m = warpedMesh(r, values, k);
            const xs = interiorSamples(r, m, 30), g = Float64Array.from({ length: 30 * k }, () => r() - 0.5);
            const grad = vjpMesh(m, xs, g);
            checkFd(m, (p) => evalMesh(p, xs).values, grad, g, { skip: new Set(["rows", "cols", "values", "tessellation"]), tol: 1e-4 });
        }
    });
}

for (const values of ["bilinear", "bicubic"]) {
    test(`mesh VJP matches finite differences with independent handles: ${values}`, () => {
        for (const seed of [33, 34]) {
            const r = rng(seed), k = 3;
            const m = brokenHandleMesh(r, values, k);
            const xs = interiorSamples(r, m, 30), g = Float64Array.from({ length: 30 * k }, () => r() - 0.5);
            const grad = vjpMesh(m, xs, g);
            assert.ok(grad.nodes.every((n) => n.uIn && n.vIn), "the gradient names the near-side handles");
            checkFd(m, (p) => evalMesh(p, xs).values, grad, g, { skip: new Set(["rows", "cols", "values", "tessellation"]), tol: 1e-4 });
        }
    });
}
