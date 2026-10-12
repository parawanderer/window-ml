// gradient-shader.spec.mjs — the gradient fills' WebGL2 renderer against their CPU reference: render each fill in real
// Chromium to a float target, read every pixel back, and compare with the reference evaluated at the same pixel
// centres (docs/spec/GRADIENT_FILLS.md §Tests). No extension: the module is bundled into a blank page.
import { test, expect } from "@playwright/test";
import * as esbuild from "esbuild";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** The renderer and the reference, bundled as one global, `G`. */
async function bundle() {
    const out = await esbuild.build({
        stdin: {
            contents: `export * from "./src/lab/gradient/gradient-gl"; export * from "./src/lab/gradient/gradient-freeform"; export * from "./src/lab/gradient/gradient-mesh";`,
            resolveDir: ROOT, loader: "ts",
        },
        bundle: true, write: false, format: "iife", globalName: "G", target: "chrome114",
    });
    return out.outputFiles[0].text;
}

/** Render `scene` at W × H and compare with the reference at every pixel both cover. Runs in the page. */
function compare({ scene, W, H, edge }) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const r = G.createGradientRenderer(canvas);
    const gpu = r.readValues(scene);
    if (!gpu) return { skipped: "no float render target" };
    const xs = new Float64Array(2 * W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { xs[2 * (j * W + i)] = (i + 0.5) / H; xs[2 * (j * W + i) + 1] = (j + 0.5) / H; }
    const cpu = scene.kind === "freeform" ? G.evalFreeform(scene.fill, xs) : G.evalMesh(scene.fill, xs);
    const k = cpu.k;
    let worst = 0, compared = 0, coverMismatch = 0;
    for (let p = 0; p < W * H; p++) {
        const covered = gpu[4 * p + 3] > 0.5, cpuCovered = !Number.isNaN(cpu.values[p * k]);
        if (covered !== cpuCovered) { coverMismatch++; continue; }
        if (!covered) continue;
        if (edge && cpu.hits) { const h = cpu.hits[p]; if (h.u < edge || h.u > 1 - edge || h.v < edge || h.v > 1 - edge) continue; }
        compared++;
        for (let c = 0; c < Math.min(k, 3); c++) worst = Math.max(worst, Math.abs(gpu[4 * p + c] - cpu.values[p * k + c]));
    }
    r.destroy();
    return { worst, compared, coverMismatch, total: W * H };
}

/** A seeded generator, as the node test uses, so a failure reproduces. */
const RNG = `(seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }`;

let src;
test.beforeAll(async () => { src = await bundle(); });

async function open(page) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><body><script>${src}; window.rng = ${RNG};</script></body>`);
    return errors;
}

// --- the Freeform gradient ------------------------------------------------------------------------------------------------

for (const mode of ["tps", "shepard"]) {
    test(`freeform ${mode}: the shader matches the reference at every pixel`, async ({ page }) => {
        const errors = await open(page);
        const scene = await page.evaluate((mode) => {
            const r = rng(7);
            const points = Array.from({ length: 9 }, () => ({ x: 0.1 + 1.1 * r(), y: 0.1 + 0.8 * r(), value: [r(), r(), r()], spread: 0.5 + r() }));
            return { kind: "freeform", fill: { mode, points } };
        }, mode);
        const res = await page.evaluate(compare, { scene, W: 80, H: 60 });
        expect(errors).toEqual([]);
        test.skip(!!res.skipped, res.skipped);
        expect(res.coverMismatch).toBe(0);
        expect(res.compared).toBe(res.total);
        expect(res.worst).toBeLessThan(2e-3);
    });
}

// --- the Gradient Mesh ------------------------------------------------------------------------------------------------

for (const values of ["bilinear", "bicubic"]) {
    test(`mesh ${values}: the shader matches the reference inside the patches`, async ({ page }) => {
        const errors = await open(page);
        const scene = await page.evaluate((values) => {
            const r = rng(9);
            const m = G.gridMesh(2, 3, [0.1, 0.1, 1.2, 0.9], () => [r(), r(), r()]);
            for (const n of m.nodes) {
                n.p[0] += 0.04 * (r() - 0.5); n.p[1] += 0.04 * (r() - 0.5);
                n.u[1] += 0.06 * (r() - 0.5); n.v[0] += 0.06 * (r() - 0.5);
            }
            return { kind: "mesh", fill: { ...m, values, tessellation: 64 } };
        }, values);
        const res = await page.evaluate(compare, { scene, W: 80, H: 60, edge: 0.02 });
        expect(errors).toEqual([]);
        test.skip(!!res.skipped, res.skipped);
        // Coverage can differ only along the silhouette, where a pixel centre sits within a tessellated chord of the curve.
        expect(res.coverMismatch).toBeLessThan(0.01 * res.total);
        expect(res.compared).toBeGreaterThan(0.5 * res.total);
        expect(res.worst).toBeLessThan(5e-3);
    });
}
