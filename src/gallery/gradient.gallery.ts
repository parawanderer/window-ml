// gradient.gallery.ts — the gradient fills (src/lab/gradient/) as a custom gallery entry: the WebGL2 canvas, an SVG overlay
// to drag points, mesh nodes and their handles, per-phase timings for the performance log, a continuous-redraw mode that
// turns it into a small benchmark, and the ML-side caveats as notes. docs/spec/GRADIENT_FILLS.md.

import type { EntryApi, GalleryEntry, MountedEntry } from "./gallery-entry";
import { createGradientRenderer, type GradientRenderer, type GradientScene } from "../lab/gradient/gradient-gl";
import { flattenFreeform, tpsDegenerate, type Freeform } from "../lab/gradient/gradient-freeform";
import { gridMesh, type Mesh } from "../lab/gradient/gradient-mesh";

/** The entry's props: which fill, both fills' parameters, and how to draw and time it. */
interface GradientProps {
    kind: "freeform" | "mesh";
    freeform: Freeform;
    mesh: Mesh;
    /** Width over height of the canvas; the fill's x runs over [0, aspect]. */
    aspect: number;
    /** Device pixels per CSS pixel; 1 keeps a stress test comparable across screens. */
    pixelRatio: number;
    overlay: boolean;
    /** Redraw every frame and report each frame's timings: the benchmark mode. */
    continuous: boolean;
    /** Wait for the GPU after each draw (a one-pixel read) when there is no timer query. */
    sync: boolean;
    background: [number, number, number, number];
}

const ASPECT = 4 / 3;
/** A reproducible spread of values, for the stress variants. */
const hash = (i: number, s: number) => { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); };

/** Points on a jittered grid, for the stress variants. */
function manyPoints(n: number): Freeform["points"] {
    const side = Math.ceil(Math.sqrt(n));
    return Array.from({ length: n }, (_, i) => ({
        x: ((i % side) + 0.2 + 0.6 * hash(i, 1)) / side * ASPECT, y: (Math.floor(i / side) + 0.2 + 0.6 * hash(i, 2)) / side,
        value: [hash(i, 3), hash(i, 4), hash(i, 5)], spread: 1,
    }));
}

const FREEFORM: Freeform = {
    mode: "tps",
    points: [
        { x: 0.25, y: 0.25, value: [0.95, 0.35, 0.3] }, { x: 1.05, y: 0.2, value: [0.98, 0.8, 0.25] },
        { x: 0.65, y: 0.55, value: [0.9, 0.9, 0.95] }, { x: 0.2, y: 0.8, value: [0.3, 0.45, 0.95] },
        { x: 1.1, y: 0.8, value: [0.35, 0.85, 0.6] },
    ],
};

/** Lines mode: a warm curve and a cool one, with two free points between. */
const LINES: Freeform = {
    mode: "tps",
    smoothing: 1e-5,
    points: [{ x: 0.66, y: 0.5, value: [0.95, 0.95, 0.9] }, { x: 1.2, y: 0.9, value: [0.2, 0.25, 0.35] }],
    lines: [
        { stops: [{ x: 0.12, y: 0.2, value: [0.95, 0.3, 0.25] }, { x: 0.5, y: 0.12, value: [0.98, 0.75, 0.2] }, { x: 0.95, y: 0.28, value: [0.95, 0.45, 0.6] }] },
        { stops: [{ x: 0.15, y: 0.85, value: [0.2, 0.4, 0.95] }, { x: 0.55, y: 0.72, value: [0.25, 0.85, 0.75] }, { x: 0.85, y: 0.9, value: [0.55, 0.35, 0.9] }, { x: 1.2, y: 0.55, value: [0.3, 0.8, 0.4] }], samples: 12 },
    ],
};

/** A 3 × 3 mesh with its middle bent, so the handles have something to show. */
function demoMesh(rows = 3, cols = 3, values: Mesh["values"] = "bilinear"): Mesh {
    const m = gridMesh(rows, cols, [0.08, 0.08, ASPECT - 0.08, 0.92], (i, j) => [
        0.5 + 0.45 * Math.sin(i * 1.3 + j * 0.4), 0.5 + 0.45 * Math.sin(j * 1.1 + 2), 0.5 + 0.45 * Math.cos(i + j * 0.7),
    ]);
    for (const [k, n] of m.nodes.entries()) {
        const i = Math.floor(k / (cols + 1)), j = k % (cols + 1);
        if (i > 0 && i < rows && j > 0 && j < cols) {
            n.p[0] += 0.06 * Math.sin(k); n.p[1] += 0.05 * Math.cos(k);
            n.u = [n.u[0], n.u[0] * 0.3 * Math.sin(k + 1)];
        }
    }
    return { ...m, values, tessellation: 24 };
}

const BASE: GradientProps = {
    kind: "freeform", freeform: FREEFORM, mesh: demoMesh(), aspect: ASPECT, pixelRatio: 1,
    overlay: true, continuous: false, sync: true, background: [0, 0, 0, 0],
};

const NOTES = `**What to know before fitting with these** (docs/spec/GRADIENT_FILLS.md):

- **Coverage is not differentiated.** The mesh gradient is exact inside the patches; moving the mesh's outline changes which pixels it covers, and nothing says so. Fit with the mesh covering the target, or add a soft edge.
- **Thin-plate splines overshoot** between points of very different value. The renderer clamps to [0, 1] at output; the reference returns unclamped values and differentiates those, so a loss on clamped pixels and the gradient disagree where it overshoots.
- **Conditioning.** As two points approach, the thin-plate system goes singular; coincident points with no smoothing fall back to Shepard. A little \`smoothing\` (λ) keeps an optimiser that pulls points together stable.
- **Fewer than three points, or all on one line,** have no affine part: the fill falls back to Shepard, and the gradient follows the fallback, so it jumps when a point crosses that boundary.
- **float32 in the shader, Float64 in the reference.** They agree to ~1e-3 on the test fills; with hundreds of points and large weights the shader's sum loses more.
- **Folds.** Where the mesh overlaps itself the later patch wins, and the reference resolves it the same way; at a fold edge the gradient is discontinuous.
- **Tessellation.** The renderer interpolates (u, v) linearly across each triangle: an O(1/T²) error in where a value lands. The reference inverts the patch exactly.
- **Bilinear values are C⁰ across patch edges** (as PDF and Illustrator draw them): kinks along the edges, and a gradient with a jump. \`bicubic\` is C¹ and better for fitting.
- **Lines hold only at their samples** (the cheap version: each curve is sampled into thin-plate points, \`samples\` per segment). Between samples the surface bends freely, every sample adds a row to the O(N³) solve, and two lines crossing with different values need \`smoothing\`. Under Shepard a line outweighs a free point by its sample count.
- **Shepard has flat spots** at every point (zero slope) and is not exact unless \`soften\` is 0, where its gradient is singular.`;

/** The phases a draw reports, bottom of the chart first. */
const PHASES = [
    { key: "solve", label: "CPU solve" }, { key: "upload", label: "upload" },
    { key: "submit", label: "submit" }, { key: "gpu", label: "GPU" },
];

/** A colour for a value, for the overlay's dots. */
const rgb = (v: number[]) => `rgb(${[0, 1, 2].map((c) => Math.round(255 * Math.min(1, Math.max(0, v[c] ?? v[0] ?? 0)))).join(",")})`;

const SVG = "http://www.w3.org/2000/svg";

/** Mount the canvas, the overlay and the timing loop. */
function mount(el: HTMLElement, initial: unknown, api: EntryApi): MountedEntry {
    let props = { ...BASE, ...(initial as Partial<GradientProps>) };
    const wrap = document.createElement("div");
    wrap.className = "gx-wrap";
    const canvas = document.createElement("canvas");
    const svg = document.createElementNS(SVG, "svg");
    wrap.append(canvas, svg);
    el.append(wrap);
    let renderer: GradientRenderer;
    try { renderer = createGradientRenderer(canvas); } catch (e) {
        api.log(`✗ ${e instanceof Error ? e.message : e}`);
        throw e;
    }
    const gl = canvas.getContext("webgl2")!;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    api.log(`WebGL2 on ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`);
    api.log(renderer.gpuTimer ? "GPU timer: EXT_disjoint_timer_query_webgl2 (true GPU time)" : "GPU timer: not exposed; GPU time is a forced sync after each draw (an UPPER bound)");

    let raf = 0, frames = 0, gpuSum = 0, lastReport = performance.now(), lastMode = "";
    const scene = (): GradientScene => props.kind === "mesh"
        ? { kind: "mesh", fill: props.mesh, background: props.background }
        : { kind: "freeform", fill: props.freeform, background: props.background };

    /** Size the canvas to the stage width at the chosen aspect and pixel ratio. */
    function size(): void {
        const w = Math.max(1, el.clientWidth || 480), h = Math.round(w / props.aspect);
        wrap.style.height = `${h}px`;
        const pw = Math.round(w * props.pixelRatio), ph = Math.round(h * props.pixelRatio);
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; api.log(`canvas ${pw}×${ph} px`); }
        svg.setAttribute("viewBox", `0 0 ${props.aspect} 1`);
    }

    /** Draw once and report the timings. */
    function draw(): void {
        size();
        const t = renderer.draw(scene(), { sync: props.sync && !renderer.gpuTimer });
        if (t.mode !== lastMode) {
            const degenerate = props.kind === "freeform" && (props.freeform.mode ?? "tps") === "tps" && tpsDegenerate(flattenFreeform(props.freeform).fill.points);
            api.log(`mode ${t.mode}${degenerate ? " (thin-plate is degenerate here: fell back to Shepard)" : ""}`);
            lastMode = t.mode;
        }
        const cpu = () => { api.metric("solve", t.solveMs); api.metric("upload", t.uploadMs); api.metric("submit", t.submitMs); };
        if (!renderer.gpuTimer) {
            cpu();
            if (t.syncMs != null) { api.metric("gpu", t.syncMs); gpuSum += t.syncMs; }
        } else if (props.continuous) {
            // A timer query answers a frame or two late: each frame reports the GPU times that finished since the last.
            cpu();
            for (const g of renderer.gpuTimes()) { api.metric("gpu", g); gpuSum += g; }
        } else {
            // One draw: hold its CPU phases until its GPU time arrives, so the four land on one point of the chart.
            let tries = 0;
            const wait = () => {
                const g = renderer.gpuTimes();
                if (g.length || ++tries > 30) { cpu(); for (const x of g) { api.metric("gpu", x); gpuSum += x; } return; }
                requestAnimationFrame(wait);
            };
            requestAnimationFrame(wait);
        }
        frames++;
        const now = performance.now();
        if (props.continuous && now - lastReport > 1000) {
            const n = props.kind === "mesh" ? `${props.mesh.rows}×${props.mesh.cols} patches, T=${props.mesh.tessellation ?? 24}` : `${flattenFreeform(props.freeform).fill.points.length} points`;
            api.log(`${frames} frames in ${((now - lastReport) / 1000).toFixed(1)} s (${n}): ${(frames * 1000 / (now - lastReport)).toFixed(0)} fps, GPU mean ${(gpuSum / Math.max(1, frames)).toFixed(2)} ms`);
            frames = 0; gpuSum = 0; lastReport = now;
        }
    }

    function loop(): void { draw(); raf = props.continuous ? requestAnimationFrame(loop) : 0; }

    // --- the overlay: points, nodes and handles, each draggable ---
    let drag: { set: (x: number, y: number) => void } | null = null;
    const toFill = (e: PointerEvent): [number, number] => {
        const r = svg.getBoundingClientRect();
        return [(e.clientX - r.left) / r.height, (e.clientY - r.top) / r.height];
    };
    function dot(x: number, y: number, r: number, fill: string, cls: string, set: (x: number, y: number) => void): void {
        const c = document.createElementNS(SVG, "circle");
        c.setAttribute("cx", String(x)); c.setAttribute("cy", String(y)); c.setAttribute("r", String(r));
        c.setAttribute("fill", fill); c.setAttribute("class", cls);
        c.addEventListener("pointerdown", (e) => { e.preventDefault(); svg.setPointerCapture(e.pointerId); drag = { set }; });
        svg.append(c);
    }
    function polyline(pts: { x: number; y: number }[]): void {
        const l = document.createElementNS(SVG, "polyline");
        l.setAttribute("points", pts.map((p) => `${p.x},${p.y}`).join(" "));
        l.setAttribute("class", "gx-line");
        svg.append(l);
    }
    function line(x1: number, y1: number, x2: number, y2: number): void {
        const l = document.createElementNS(SVG, "line");
        for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) l.setAttribute(k, String(v));
        l.setAttribute("class", "gx-handle-line");
        svg.append(l);
    }
    function overlay(): void {
        svg.replaceChildren();
        if (!props.overlay) return;
        if (props.kind === "freeform") {
            props.freeform.points.forEach((p, i) => dot(p.x, p.y, 0.018, rgb(p.value), "gx-point", (x, y) => {
                const points = props.freeform.points.slice(); points[i] = { ...points[i], x, y };
                change({ freeform: { ...props.freeform, points } });
            }));
            // Lines: the sampled curve (what the fill is actually held to), and its stops to drag.
            const { fill, samples } = flattenFreeform(props.freeform), n0 = props.freeform.points.length;
            props.freeform.lines?.forEach((l, li) => {
                polyline(fill.points.slice(n0).filter((_, j) => samples[j].line === li));
                l.stops.forEach((p, si) => dot(p.x, p.y, 0.014, rgb(p.value), "gx-point", (x, y) => {
                    const lines = props.freeform.lines!.slice(), stops = lines[li].stops.slice();
                    stops[si] = { ...stops[si], x, y }; lines[li] = { ...lines[li], stops };
                    change({ freeform: { ...props.freeform, lines } });
                }));
            });
            return;
        }
        const m = props.mesh;
        const edit = (i: number, f: (n: Mesh["nodes"][number], x: number, y: number) => Mesh["nodes"][number]) => (x: number, y: number) => {
            const nodes = m.nodes.slice(); nodes[i] = f(nodes[i], x, y);
            change({ mesh: { ...props.mesh, nodes } });
        };
        m.nodes.forEach((n, i) => {
            for (const s of [1, -1]) {
                const hu: [number, number] = [n.p[0] + s * n.u[0] / 3, n.p[1] + s * n.u[1] / 3];
                const hv: [number, number] = [n.p[0] + s * n.v[0] / 3, n.p[1] + s * n.v[1] / 3];
                line(n.p[0], n.p[1], hu[0], hu[1]); line(n.p[0], n.p[1], hv[0], hv[1]);
                // A handle moves its tangent symmetrically: the handles of a smooth mesh point stay opposite.
                dot(hu[0], hu[1], 0.009, "var(--fg)", "gx-handle", edit(i, (nd, x, y) => ({ ...nd, u: [3 * s * (x - nd.p[0]), 3 * s * (y - nd.p[1])] })));
                dot(hv[0], hv[1], 0.009, "var(--fg)", "gx-handle", edit(i, (nd, x, y) => ({ ...nd, v: [3 * s * (x - nd.p[0]), 3 * s * (y - nd.p[1])] })));
            }
            dot(n.p[0], n.p[1], 0.016, rgb(n.value), "gx-point", edit(i, (nd, x, y) => ({ ...nd, p: [x, y] })));
        });
    }
    svg.addEventListener("pointermove", (e) => { if (drag) drag.set(...toFill(e)); });
    svg.addEventListener("pointerup", () => { drag = null; });

    /** A change made on the canvas: redraw, and write the props back to the sidebar. */
    function change(patch: Partial<GradientProps>): void {
        props = { ...props, ...patch };
        api.setProps(props);
        if (!props.continuous) draw();
        overlay();
    }

    const ro = new ResizeObserver(() => { if (!props.continuous) draw(); });
    ro.observe(el);
    overlay();
    loop();
    return {
        update(next) {
            const was = props.continuous;
            props = { ...BASE, ...(next as Partial<GradientProps>) };
            overlay();
            if (props.continuous && !was) { frames = 0; gpuSum = 0; lastReport = performance.now(); api.log("continuous redraw: on"); loop(); }
            else if (!props.continuous) { if (was) api.log("continuous redraw: off"); cancelAnimationFrame(raf); raf = 0; draw(); }
        },
        destroy() { cancelAnimationFrame(raf); ro.disconnect(); renderer.destroy(); wrap.remove(); },
    };
}

/** The entry, with its variants: the two fills in each of their modes, and two stress tests for the timings. */
export const gallery: GalleryEntry[] = [{
    id: "gradient-fills",
    title: "Gradient fills",
    summary: "Illustrator's Freeform gradient and Gradient Mesh on WebGL2, held to a differentiable CPU reference.",
    groups: ["canvas", "gradient"],
    props: BASE,
    notes: NOTES,
    phases: PHASES,
    variants: {
        "freeform: thin-plate": BASE,
        "freeform: lines": { ...BASE, freeform: LINES },
        "freeform: Shepard": { ...BASE, freeform: { ...FREEFORM, mode: "shepard", points: FREEFORM.points.map((p, i) => ({ ...p, spread: i === 2 ? 3 : 1 })) } },
        "mesh: bilinear": { ...BASE, kind: "mesh" },
        "mesh: bicubic": { ...BASE, kind: "mesh", mesh: demoMesh(3, 3, "bicubic") },
        "stress: 256 points": { ...BASE, overlay: false, continuous: true, freeform: { mode: "tps", points: manyPoints(256), smoothing: 1e-4 } },
        "stress: 16×16 mesh": { ...BASE, kind: "mesh", overlay: false, continuous: true, mesh: { ...demoMesh(16, 16, "bicubic"), tessellation: 16 } },
    },
    mount,
}];
