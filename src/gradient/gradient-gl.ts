// gradient-gl.ts — the WebGL2 renderer for the gradient fills: the Freeform gradient as one full-screen fragment pass
// (thin-plate weights solved on the CPU, the O(N) sum per pixel), the Gradient Mesh as instanced tessellated patches.
// It draws to the canvas for display and to a float target for reading values back unclamped, which is how a test holds
// the shader to the CPU reference. The maths: docs/spec/GRADIENT_FILLS.md.

import { FREEFORM_DEFAULTS, freeformChannels, solveTps, type Freeform } from "./gradient-freeform";
import { meshChannels, type Mesh } from "./gradient-mesh";

/** What to draw: one fill and the colour behind it. */
export type GradientScene =
    | { kind: "freeform"; fill: Freeform; background?: [number, number, number, number] }
    | { kind: "mesh"; fill: Mesh; background?: [number, number, number, number] };

/** How long one draw took, by phase. `gpuMs` is filled in later (a timer query) or at once (`sync`), when known. */
export interface DrawTiming { solveMs: number; uploadMs: number; submitMs: number; syncMs?: number; mode: string }

/** A renderer bound to one canvas. */
export interface GradientRenderer {
    /** Draw to the canvas. With `sync`, wait for the GPU (a one-pixel read) and report how long that took. */
    draw(scene: GradientScene, opts?: { sync?: boolean }): DrawTiming;
    /** Render to a float target at the canvas size and return S × 4 values, rows TOP-DOWN, unclamped; null without
     *  float render targets. Alpha is 0 where nothing was drawn (off a mesh). */
    readValues(scene: GradientScene): Float32Array | null;
    /** GPU times (ms) of finished draws since the last call, oldest first; empty without the timer extension. */
    gpuTimes(): number[];
    /** Whether the GPU timer extension is there, so a caller can say which kind of number it shows. */
    readonly gpuTimer: boolean;
    destroy(): void;
}

const VS_QUAD = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/** The pixel's position in the fill's coordinates: height-normalised, y down. */
const COORD = `
uniform vec2 u_size;
vec2 fillCoord() { return vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y) / u_size.y; }`;

/** The output: raw values for the float target, clamped channels over the background for display. */
const OUTPUT = `
uniform int u_raw;
uniform int u_k;
uniform vec4 u_bg;
out vec4 o;
void emit(vec4 v, float covered) {
    if (u_raw == 1) { o = vec4(v.rgb, covered); return; }
    vec4 c = clamp(v, 0.0, 1.0);
    if (u_k < 4) c.a = 1.0;
    if (u_k == 1) c.rgb = vec3(c.r);
    c.a *= covered;
    o = vec4(mix(u_bg.rgb, c.rgb, c.a), mix(u_bg.a, 1.0, c.a));
}`;

const FS_FREEFORM = `#version 300 es
precision highp float;
precision highp int;
${COORD}
${OUTPUT}
uniform highp sampler2D u_points;   // texel i: (x, y, spread, 0)
uniform highp sampler2D u_values;   // texel i: tps weight row i (N+3 rows) or shepard value i
uniform int u_n;
uniform int u_mode;                 // 0 tps, 1 shepard
uniform float u_power;
uniform float u_eps2;
void main() {
    vec2 x = fillCoord();
    vec4 acc = vec4(0.0);
    if (u_mode == 0) {
        acc = texelFetch(u_values, ivec2(u_n, 0), 0) + texelFetch(u_values, ivec2(u_n + 1, 0), 0) * x.x
            + texelFetch(u_values, ivec2(u_n + 2, 0), 0) * x.y;
        for (int i = 0; i < u_n; i++) {
            vec2 d = x - texelFetch(u_points, ivec2(i, 0), 0).xy;
            float r2 = dot(d, d);
            if (r2 > 0.0) acc += texelFetch(u_values, ivec2(i, 0), 0) * (0.5 * r2 * log(r2));
        }
    } else {
        float total = 0.0;
        for (int i = 0; i < u_n; i++) {
            vec4 p = texelFetch(u_points, ivec2(i, 0), 0);
            vec2 d = x - p.xy;
            float d2e = dot(d, d) + u_eps2;
            if (d2e == 0.0) { emit(texelFetch(u_values, ivec2(i, 0), 0), 1.0); return; }
            float w = p.z * pow(d2e, -0.5 * u_power);
            total += w;
            acc += w * texelFetch(u_values, ivec2(i, 0), 0);
        }
        acc /= total;
    }
    emit(acc, 1.0);
}`;

/** The Hermite basis, shared by the mesh's two stages. */
const HERMITE = `
vec2 hermite(int a, float t, bool d) {
    if (a == 0) return d ? vec2(6.0*t*t - 6.0*t, 3.0*t*t - 4.0*t + 1.0) : vec2(2.0*t*t*t - 3.0*t*t + 1.0, t*t*t - 2.0*t*t + t);
    return d ? vec2(-6.0*t*t + 6.0*t, 3.0*t*t - 2.0*t) : vec2(-2.0*t*t*t + 3.0*t*t, t*t*t - t*t);
}
uniform highp sampler2D u_nodes;    // row 0: (p.x, p.y, u.x, u.y); row 1: (v.x, v.y, 0, 0); row 2: value
uniform int u_cols;
uniform int u_rows;
int nodeAt(int i, int j) { return i * (u_cols + 1) + j; }`;

const VS_MESH = `#version 300 es
precision highp float;
precision highp int;
in vec2 a_uv;
uniform vec2 u_size;
${HERMITE}
out vec2 v_uv;
flat out int v_patch;
void main() {
    int pc = gl_InstanceID, pi = pc / u_cols, pj = pc - pi * u_cols;
    vec2 s = vec2(0.0);
    for (int b = 0; b < 2; b++) for (int a = 0; a < 2; a++) {
        int n = nodeAt(pi + b, pj + a);
        vec4 pu = texelFetch(u_nodes, ivec2(n, 0), 0);
        vec2 v = texelFetch(u_nodes, ivec2(n, 1), 0).xy;
        vec2 hu = hermite(a, a_uv.x, false), hv = hermite(b, a_uv.y, false);
        s += hu.x * hv.x * pu.xy + hu.y * hv.x * pu.zw + hu.x * hv.y * v;
    }
    v_uv = a_uv;
    v_patch = pc;
    float aspect = u_size.x / u_size.y;
    gl_Position = vec4(s.x / aspect * 2.0 - 1.0, 1.0 - 2.0 * s.y, 0.0, 1.0);
}`;

const FS_MESH = `#version 300 es
precision highp float;
precision highp int;
${HERMITE}
uniform vec2 u_size;
${OUTPUT}
uniform int u_bicubic;
in vec2 v_uv;
flat in int v_patch;
vec4 val(int i, int j) { return texelFetch(u_nodes, ivec2(nodeAt(i, j), 2), 0); }
void main() {
    int pi = v_patch / u_cols, pj = v_patch - pi * u_cols;
    float u = clamp(v_uv.x, 0.0, 1.0), v = clamp(v_uv.y, 0.0, 1.0);
    vec4 acc = vec4(0.0);
    for (int b = 0; b < 2; b++) for (int a = 0; a < 2; a++) {
        int i = pi + b, j = pj + a;
        if (u_bicubic == 0) {
            acc += (a == 0 ? 1.0 - u : u) * (b == 0 ? 1.0 - v : v) * val(i, j);
        } else {
            vec2 hu = hermite(a, u, false), hv = hermite(b, v, false);
            int jl = max(0, j - 1), jr = min(u_cols, j + 1), iu = max(0, i - 1), id = min(u_rows, i + 1);
            vec4 cu = (val(i, jr) - val(i, jl)) * (jr - jl == 2 ? 0.5 : 1.0);
            vec4 cv = (val(id, j) - val(iu, j)) * (id - iu == 2 ? 0.5 : 1.0);
            acc += hu.x * hv.x * val(i, j) + hu.y * hv.x * cu + hu.x * hv.y * cv;
        }
    }
    emit(acc, 1.0);
}`;

/** Compile and link, throwing the driver's log on failure. */
function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`gradient shader: ${gl.getShaderInfoLog(s)}`);
        gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`gradient program: ${gl.getProgramInfoLog(p)}`);
    return p;
}

/** A float texture of `width × height` RGBA texels, nearest-sampled (read with texelFetch only). */
function floatTexture(gl: WebGL2RenderingContext, tex: WebGLTexture, width: number, height: number, data: Float32Array): void {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, Math.max(1, width), Math.max(1, height), 0, gl.RGBA, gl.FLOAT, data);
}

/** The (u, v) grid one patch instance draws: T × T quads as triangles, row-major in (v, u), the order the reference
 *  resolves a fold by. */
function tessellation(t: number): Float32Array {
    const out: number[] = [];
    for (let j = 0; j < t; j++) for (let i = 0; i < t; i++) {
        const u0 = i / t, u1 = (i + 1) / t, v0 = j / t, v1 = (j + 1) / t;
        out.push(u0, v0, u1, v0, u0, v1, u1, v0, u1, v1, u0, v1);
    }
    return Float32Array.from(out);
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Make a renderer on `canvas`. Throws when WebGL2 is not available. */
export function createGradientRenderer(canvas: HTMLCanvasElement | OffscreenCanvas): GradientRenderer {
    const ctx = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!ctx) throw new Error("WebGL2 is not available");
    const gl: WebGL2RenderingContext = ctx;
    const floatTarget = !!gl.getExtension("EXT_color_buffer_float");
    const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    const freeform = program(gl, VS_QUAD, FS_FREEFORM);
    const mesh = program(gl, VS_MESH, FS_MESH);
    const quad = gl.createBuffer()!, grid = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    const texA = gl.createTexture()!, texB = gl.createTexture()!;
    let gridT = 0, gridCount = 0;
    const pending: WebGLQuery[] = [];
    const finished: number[] = [];

    const uni = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);
    const common = (p: WebGLProgram, k: number, bg: number[], raw: boolean, w: number, h: number) => {
        gl.uniform2f(uni(p, "u_size"), w, h);
        gl.uniform1i(uni(p, "u_raw"), raw ? 1 : 0);
        gl.uniform1i(uni(p, "u_k"), k);
        gl.uniform4fv(uni(p, "u_bg"), bg);
    };

    /** Upload and draw one scene into whatever framebuffer is bound. */
    function render(scene: GradientScene, raw: boolean, w: number, h: number): DrawTiming {
        const t0 = now();
        const bg = scene.background ?? [0, 0, 0, 0];
        gl.viewport(0, 0, w, h);
        gl.clearColor(raw ? 0 : bg[0], raw ? 0 : bg[1], raw ? 0 : bg[2], raw ? 0 : bg[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (scene.kind === "freeform") {
            const ff = scene.fill, n = ff.points.length, k = freeformChannels(ff);
            if (!n || !k) return { solveMs: now() - t0, uploadMs: 0, submitMs: 0, mode: "empty" };
            const sol = (ff.mode ?? "tps") === "tps" ? solveTps(ff) : null;
            const t1 = now();
            const pts = new Float32Array(4 * n), vals = new Float32Array(4 * (sol ? n + 3 : n));
            ff.points.forEach((p, i) => { pts.set([p.x, p.y, p.spread ?? 1, 0], 4 * i); });
            if (sol) for (let r = 0; r < n + 3; r++) for (let c = 0; c < k; c++) vals[4 * r + c] = sol.weights[r * k + c];
            else ff.points.forEach((p, i) => { for (let c = 0; c < k; c++) vals[4 * i + c] = p.value[c] ?? 0; });
            gl.useProgram(freeform);
            gl.activeTexture(gl.TEXTURE0); floatTexture(gl, texA, n, 1, pts);
            gl.activeTexture(gl.TEXTURE1); floatTexture(gl, texB, sol ? n + 3 : n, 1, vals);
            const t2 = now();
            gl.uniform1i(uni(freeform, "u_points"), 0);
            gl.uniform1i(uni(freeform, "u_values"), 1);
            gl.uniform1i(uni(freeform, "u_n"), n);
            gl.uniform1i(uni(freeform, "u_mode"), sol ? 0 : 1);
            gl.uniform1f(uni(freeform, "u_power"), ff.power ?? FREEFORM_DEFAULTS.power);
            const eps = ff.soften ?? FREEFORM_DEFAULTS.soften;
            gl.uniform1f(uni(freeform, "u_eps2"), eps * eps);
            common(freeform, k, bg, raw, w, h);
            const loc = gl.getAttribLocation(freeform, "a_pos");
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(loc, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.disableVertexAttribArray(loc);
            return { solveMs: t1 - t0, uploadMs: t2 - t1, submitMs: now() - t2, mode: sol ? "tps" : "shepard" };
        }
        const m = scene.fill, nodes = m.nodes.length, k = meshChannels(m), patches = m.rows * m.cols;
        if (!patches || nodes !== (m.rows + 1) * (m.cols + 1)) return { solveMs: 0, uploadMs: 0, submitMs: 0, mode: "empty" };
        const t1 = now();
        const data = new Float32Array(4 * nodes * 3);
        m.nodes.forEach((nd, i) => {
            data.set([nd.p[0], nd.p[1], nd.u[0], nd.u[1]], 4 * i);
            data.set([nd.v[0], nd.v[1], 0, 0], 4 * (nodes + i));
            for (let c = 0; c < k; c++) data[4 * (2 * nodes + i) + c] = nd.value[c] ?? 0;
        });
        gl.useProgram(mesh);
        gl.activeTexture(gl.TEXTURE0); floatTexture(gl, texA, nodes, 3, data);
        const t = Math.max(1, Math.min(256, Math.round(m.tessellation ?? 24)));
        gl.bindBuffer(gl.ARRAY_BUFFER, grid);
        if (t !== gridT) { const g = tessellation(t); gl.bufferData(gl.ARRAY_BUFFER, g, gl.STATIC_DRAW); gridT = t; gridCount = g.length / 2; }
        const t2 = now();
        gl.uniform1i(uni(mesh, "u_nodes"), 0);
        gl.uniform1i(uni(mesh, "u_cols"), m.cols);
        gl.uniform1i(uni(mesh, "u_rows"), m.rows);
        gl.uniform1i(uni(mesh, "u_bicubic"), m.values === "bicubic" ? 1 : 0);
        common(mesh, k, bg, raw, w, h);
        const loc = gl.getAttribLocation(mesh, "a_uv");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, gridCount, patches);
        gl.disableVertexAttribArray(loc);
        return { solveMs: 0, uploadMs: t2 - t1, submitMs: now() - t2, mode: m.values ?? "bilinear" };
    }

    /** Collect finished timer queries. */
    function poll(): void {
        if (!timer) return;
        const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
        while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
            const q = pending.shift()!;
            if (!disjoint) finished.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
            gl.deleteQuery(q);
        }
    }

    return {
        gpuTimer: !!timer,
        draw(scene, opts = {}) {
            poll();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            const q = timer ? gl.createQuery() : null;
            if (q) gl.beginQuery(timer!.TIME_ELAPSED_EXT, q);
            const timing = render(scene, false, gl.drawingBufferWidth, gl.drawingBufferHeight);
            if (q) { gl.endQuery(timer!.TIME_ELAPSED_EXT); pending.push(q); }
            if (opts.sync) {
                const t = now();
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
                timing.syncMs = now() - t;
            }
            return timing;
        },
        readValues(scene) {
            if (!floatTarget) return null;
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const tex = gl.createTexture()!, fb = gl.createFramebuffer()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            render(scene, true, w, h);
            const raw = new Float32Array(4 * w * h);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
            gl.deleteTexture(tex);
            const out = new Float32Array(raw.length);   // readPixels is bottom-up; the fill's y is down
            for (let r = 0; r < h; r++) out.set(raw.subarray(4 * w * (h - 1 - r), 4 * w * (h - r)), 4 * w * r);
            return out;
        },
        gpuTimes() { poll(); return finished.splice(0); },
        destroy() {
            for (const q of pending) gl.deleteQuery(q);
            gl.deleteProgram(freeform); gl.deleteProgram(mesh);
            gl.deleteBuffer(quad); gl.deleteBuffer(grid);
            gl.deleteTexture(texA); gl.deleteTexture(texB);
        },
    };
}
