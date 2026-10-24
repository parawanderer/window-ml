// start-field.ts — the DOT FIELD behind the start page: a grid of monochrome dots on a slowly rolling surface, drawn
// in 2.5D, that lies flat around the box you type in, and water under it that the pointer disturbs.
//
// One WebGL draw of `gl.POINTS` a frame. Each dot is a point (x, y) on a height field z, the sum of two things:
//
// - THE SWELL, the vertex shader's: slow travelling waves, scaled by a ramp of the signed distance to the box (a
//   rounded rectangle, `sdBox`), 0 at its edge and 1 a `FIELD.calmPx` away, so the surface flattens as it nears the box
//   instead of breaking off at a margin.
// - THE WATER, stepped here (start-water.ts): a damped wave equation on the same grid, into which the pointer drops
//   energy as it moves (and a splash where it presses), which spreads, reflects off the box and the page's edges, and
//   dies away over a few seconds. Its height and slope reach the shader as a per-dot attribute each frame.
//
// A dot is then "projected": lifted up the screen and away from the centre by its height, shifted along the water's
// slope (which reads as refraction), and drawn larger and brighter the higher it is, which is what reads as depth.
//
// The COLOUR is the field's own, one ink and opacity per theme (`FIELD.inkDark`, `inkLight`), chosen by how bright
// the page under it is.
//
// STILL: the field draws one frame and stops (no clock, no water, no pointer) when motion is unwanted or costs too
// much: reduced motion, a battery that is low and not charging (Chrome and Edge report it; elsewhere this never
// triggers), frames that have stayed slow for seconds on end, or `FIELD.still` (the tuning panel's switch, and how
// the field's cost is measured against no cost). Each but slowness lifts again when its cause does. The reason is on
// the canvas as `data-still`. With no WebGL it draws nothing, which is the page as it was.
import { holdStill, splash, stepWater, STEP_HZ, water, type Water } from "./start-water";

/**
 * The field's knobs, read every frame: the shader's as uniforms, the water's as its constants. One object so a tuning
 * panel can bind to it (the web build exposes it as `__startField`); nothing else writes it. The defaults are the
 * values settled on in that panel, `tests/e2e/start-field-tune.html`.
 */
export const FIELD = {   // state: ui
    /** the grid's pitch, CSS px (a change rebuilds the grid and stills the water) */
    pitch: 22,
    /** how far from the box the swell takes to reach full height, CSS px */
    calmPx: 700,
    /** the swell: 1, how fast it moves, and how tight its waves are (1 = as designed) */
    swell: 1, swellSpeed: 0.95, swellScale: 0.4,
    /** the 2.5D projection: how far a unit of height lifts a dot up the screen (px), and spreads it from the centre */
    lift: 5, parallax: 0.01,
    /** a dot's size at rest and per unit of height, CSS px */
    dotSize: 2, dotGrow: 0.35,
    /** a dot's opacity at rest, per unit of height, and from the slow patches across the field */
    alpha: 0.76, alphaDepth: 0.68, alphaPatch: 0.4,
    /** the water: how much its height lifts a dot, and how far its slope shifts one (px per unit of slope) */
    waterLift: 0.45, refract: 8,
    /** how much a pointer's travel of one cell drops into the water, the most one move may drop, and a press */
    drop: 0.4, dropMax: 4, press: 1.4, splashRadius: 2.6,
    /** PILLS instead of dots: each drawn along the surface's slope (the screen's view of its normal), as long as the
     *  slope is steep (`pillLength` px per 1% of slope, up to `pillMax`), so flat water near the box stays round.
     *  `pillAcross` turns them a quarter, along the contour lines instead. */
    pills: true, pillLength: 2, pillMax: 8, pillAcross: false,
    /** the wave speed (K = c²dt²/dx², under 1/2), what is left of a ripple's speed a step, the spring to rest */
    waveK: 0.03, damp: 0.996, level: 0.0002,
    /** THE CLEARING around the box: dots fade out within `fadePx` of it, over `fadeSoft` px, by a distance that slow
     *  noise warps (`fadeWobble` px of it, `fadeWobbleScale` its size, `fadeWobbleSpeed` how fast it drifts), so the
     *  clearing is a moving blob rather than a ring. Opacity only: the waves are not flattened by it. */
    /** CHROMATIC ABERRATION on disturbed water: a glyph's red, green and blue are drawn apart along its axis, by
     *  `aberration` px per unit of the WATER'S slope (never the swell's), up to `aberrationMax` px. Calm water has
     *  none, so it shows only where a press has stirred it, and fades as the ripple does. 0 turns it off. */
    aberration: 12, aberrationMax: 2,
    /** THE INK, per theme: the dots' colour and the canvas's opacity over the page, on a dark page and on a light one
     *  (told apart by the page's own background, so however the theme was chosen). */
    inkDark: "#595760", opacityDark: 0.5, inkLight: "#79798b", opacityLight: 0.5,
    /** the most frames a second it draws (the display may offer 120; the swell is slow and the water steps at 60
     *  regardless), and the resolution it draws at, as a fraction of the screen's (capped at 2x) */
    fps: 60, renderScale: 1,
    /** draw one frame and stop, whatever else holds (see STILL above) */
    still: false,
    fadePx: 20, fadeSoft: 275, fadeWobble: 110, fadeWobbleScale: 1.35, fadeWobbleSpeed: 1,
};

const VS = `
attribute vec2 a_p;
attribute vec3 a_w;      // the water here: height, and its slope along x and y (per cell)
uniform vec2 u_size;
uniform float u_t;
uniform vec4 u_box;      // centre x, y; half width, half height (CSS px)
uniform float u_radius;
uniform float u_dpr;
uniform float u_pitch;
uniform float u_calm;
uniform vec3 u_swell;    // height, speed, scale
uniform vec2 u_proj;     // lift, parallax
uniform vec2 u_dot;      // size, growth
uniform vec3 u_alpha;    // rest, depth, patch
uniform vec2 u_water;    // lift, refraction
uniform vec4 u_pill;     // on (0/1), length per slope, longest (CSS px), across the slope (0/1)
uniform vec4 u_fade;     // clearing: radius, softness, wobble (px), wobble scale
uniform float u_fadeSpeed;
uniform vec2 u_ab;       // aberration: px per unit of water slope, most px
varying float v_a;
varying vec2 v_dir;      // the pill's axis, unit, in point-sprite space (y down, as CSS)
varying vec3 v_shape;    // its half length, its radius and the sprite's size, CSS px
varying float v_ab;      // how far its colour channels are drawn apart, CSS px

float sdBox(vec2 p, vec2 c, vec2 h, float r) {
    vec2 q = abs(p - c) - h + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float swell(vec2 p0, float t0) {
    vec2 p = p0 * u_swell.z;
    float t = t0 * u_swell.y;
    return 0.50 * sin(dot(p, vec2(0.0072, 0.0031)) + t * 0.50)
         + 0.35 * sin(dot(p, vec2(-0.0038, 0.0089)) - t * 0.37 + 1.7)
         + 0.22 * sin(dot(p, vec2(0.0121, -0.0060)) + t * 0.63 + 4.1)
         + 0.18 * sin(length(p - u_size * vec2(0.25, 0.85)) * 0.010 - t * 0.80);
}
float boxDist(vec2 p) { return u_box.z > 0.0 ? sdBox(p, u_box.xy, u_box.zw, u_radius) : u_calm; }
/** The swell's height at p, flattened toward the box. */
float calmSwell(vec2 p) { return swell(p, u_t) * u_swell.x * smoothstep(0.0, u_calm, boxDist(p)); }
/** Slow, smooth noise in about -1..1: a few crossed sines at incommensurate frequencies and speeds. */
float wobble(vec2 p, float t) {
    return 0.45 * sin(p.x * 0.0110 + t * 0.31) * sin(p.y * 0.0130 - t * 0.23)
         + 0.35 * sin((p.x + p.y) * 0.0071 + t * 0.17 + 2.0)
         + 0.25 * sin((p.x - 1.7 * p.y) * 0.0053 - t * 0.27 + 4.4);
}
void main() {
    vec2 p = a_p;
    float d = boxDist(p);
    float z = calmSwell(p) + a_w.x * u_water.x;
    // The surface's slope, per CSS px: the swell's by central difference (calm ramp included), the water's from its
    // own per-cell slope. Its direction and size are what a pill draws.
    vec2 e = vec2(2.0, 0.0);
    vec2 grad = vec2(calmSwell(p + e.xy) - calmSwell(p - e.xy), calmSwell(p + e.yx) - calmSwell(p - e.yx)) / 4.0
              + a_w.yz * u_water.x / u_pitch;
    vec2 push = -a_w.yz * u_water.y;
    vec2 q = p + push + vec2(0.0, -z * u_proj.x) + (p - u_size * 0.5) * z * u_proj.y;
    vec2 clip = q / u_size * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    float r = max(0.5, (u_dot.x + u_dot.y * z) * 0.5);
    float slope = length(grad);
    float halfLen = u_pill.x * min(u_pill.y * slope * 100.0, u_pill.z) * 0.5;
    vec2 dir = slope > 1e-6 ? grad / slope : vec2(1.0, 0.0);
    v_dir = u_pill.w > 0.5 ? vec2(-dir.y, dir.x) : dir;
    v_ab = min(u_ab.x * length(a_w.yz), u_ab.y);
    float size = 2.0 * (halfLen + r + v_ab) + 2.0;
    v_shape = vec3(halfLen, r, size);
    gl_PointSize = size * u_dpr;
    float patch = 0.5 + 0.5 * sin(p.x * 0.0047 + u_t * 0.05) * sin(p.y * 0.0061 - u_t * 0.04 + 1.3);
    // THE CLEARING: the box's distance, warped by drifting noise, ramped into opacity. A blob that breathes, not a ring.
    float fd = d + wobble(p * u_fade.w, u_t * u_fadeSpeed) * u_fade.z;
    float clearing = smoothstep(u_fade.x, u_fade.x + max(u_fade.y, 1.0), fd);
    v_a = clamp(u_alpha.x + u_alpha.y * z + u_alpha.z * patch, 0.04, 1.0) * smoothstep(-2.0, 6.0, d) * clearing;
}`;

// A capsule in the point sprite: the distance to the segment along `v_dir`, less the radius. With no length it is
// the round dot it always was. The edge is soft over about a device pixel.
//
// With ABERRATION (`v_ab` > 0) the capsule is evaluated three times, shifted along its axis by −v_ab, 0 and +v_ab, one
// per channel. A canvas has one alpha, so a channel cannot cover the page by its own amount through blending; the
// shader composites against the page's background (`u_bg`) itself instead. For coverage a_c in each channel and
// A = max(a_c), the colour s_c = bg_c·(A − a_c) + ink_c·a_c, drawn with alpha A, lands on the page as
// bg_c·(1 − a_c) + ink_c·a_c: each channel exactly as covered as its own copy. With no split all three are one copy
// and it is the plain ink it always was.
const FS = `
precision mediump float;
uniform vec3 u_color;
uniform vec3 u_bg;
varying float v_a;
varying vec2 v_dir;
varying vec3 v_shape;
varying float v_ab;
float capsule(vec2 c) {
    vec2 onAxis = v_dir * clamp(dot(c, v_dir), -v_shape.x, v_shape.x);
    float dist = length(c - onAxis) - v_shape.y;
    return clamp(0.5 - dist / max(0.35, v_shape.y * 0.6), 0.0, 1.0) * v_a;
}
void main() {
    vec2 c = (gl_PointCoord - 0.5) * v_shape.z;
    vec3 a = v_ab > 0.01
        ? vec3(capsule(c - v_dir * v_ab), capsule(c), capsule(c + v_dir * v_ab))
        : vec3(capsule(c));
    float top = max(a.r, max(a.g, a.b));
    gl_FragColor = vec4(u_bg * (top - a) + u_color * a, top);
}`;

/** The dot grid: `cols`×`rows` dots, row-major, the first at (x0, y0), `pitch` apart. */
export interface FieldGrid { pos: Float32Array; cols: number; rows: number; x0: number; y0: number; pitch: number }

/** The grid of dot positions covering `w`×`h` CSS px, one pitch past each edge so a lifted row never leaves a gap. */
export function fieldGrid(w: number, h: number, pitch = FIELD.pitch): FieldGrid {
    const cols = Math.ceil(w / pitch) + 3, rows = Math.ceil(h / pitch) + 3;
    const pos = new Float32Array(cols * rows * 2);
    const x0 = (w - (cols - 1) * pitch) / 2, y0 = (h - (rows - 1) * pitch) / 2;
    let i = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { pos[i++] = x0 + c * pitch; pos[i++] = y0 + r * pitch; }
    return { pos, cols, rows, x0, y0, pitch };
}

/** Signed distance from (px, py) to a rounded rectangle centred at (cx, cy) with half-size (hx, hy) and radius r. */
export function sdBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
    const qx = Math.abs(px - cx) - hx + r, qy = Math.abs(py - cy) - hy + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * The water's height and slope at each dot, as the shader's `a_w` (3 floats a dot). The slope is a central difference
 * in cells, one-sided at an edge.
 */
export function waterAttr(w: Water, out: Float32Array): Float32Array {
    const { cols, rows, h } = w;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            const l = x > 0 ? h[i - 1] : h[i], r = x < cols - 1 ? h[i + 1] : h[i];
            const u = y > 0 ? h[i - cols] : h[i], d = y < rows - 1 ? h[i + cols] : h[i];
            out[i * 3] = h[i]; out[i * 3 + 1] = (r - l) / 2; out[i * 3 + 2] = (d - u) / 2;
        }
    }
    return out;
}

/** A `#rgb` or `#rrggbb` colour as 0..1 channels, or null for anything else. */
export function hexRgb(hex: string): [number, number, number] | null {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Whether a background colour is a DARK page's: its relative luminance under a half. */
export function isDark([r, g, b]: readonly [number, number, number]): boolean {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** An `rgb(…)`/`rgba(…)` CSS colour as 0..1 channels, or null for anything else. */
export function rgbOf(css: string): [number, number, number] | null {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
    return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : null;
}

/** Why the field is still, or "" when it moves: the first of these that holds, in this order. */
export function stillReason(why: { forced: boolean; reducedMotion: boolean; lowBattery: boolean; slow: boolean }): "" | "forced" | "motion" | "battery" | "slow" {
    return why.forced ? "forced" : why.reducedMotion ? "motion" : why.lowBattery ? "battery" : why.slow ? "slow" : "";
}

/** The battery level at or under which, unplugged, the field stops moving. */
export const LOW_BATTERY = 0.2;

/** Whether a Battery Status API reading is low enough to stop for: not charging, and at or under `LOW_BATTERY`. */
export function lowBattery(b: { charging: boolean; level: number } | null): boolean {
    return !!b && !b.charging && b.level <= LOW_BATTERY;
}

/**
 * Watches frame intervals for a machine that cannot keep up: SLOW once the smoothed interval has stayed over
 * `slowMs` (25 fps) for `forMs` of frames. A single long gap (a hidden tab, a stall) is skipped, not averaged in.
 */
export function frameWatch(slowMs = 40, forMs = 3000) {
    let ema = 1000 / 60, over = 0;
    return (dtMs: number): boolean => {
        if (dtMs > 250) return false;
        ema += (dtMs - ema) * 0.1;
        over = ema > slowMs ? over + dtMs : 0;
        return over >= forMs;
    };
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src); gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
}

/** What a press on the start page belongs to rather than the field: every control, and the box with all it holds. */
export const NOT_GROUND = "a, button, input, textarea, select, label, summary, [role], [tabindex], [contenteditable], .chat-start-box, .chat-start-above, .tt-pop";

/**
 * Whether a press on `target` may stir the field: it is inside `ground` (the start page) and not on anything
 * `NOT_GROUND` names.
 */
export function onOpenGround(target: EventTarget | null, ground: string): boolean {
    const el = target as Element | null;
    return !!el && typeof el.closest === "function" && !!el.closest(ground) && !el.closest(NOT_GROUND);
}

/**
 * Draw the field into `canvas` (which covers the window), calm around `box()`'s rect, until the returned function is
 * called; a held press that `stirsAt` accepts stirs it. Returns null, drawing nothing, where WebGL is not available.
 */
export function startField(canvas: HTMLCanvasElement, box: () => Element | null, stirsAt: (target: EventTarget | null) => boolean): (() => void) | null {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) return null;
    const vs = compile(gl, gl.VERTEX_SHADER, VS), fs = compile(gl, gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const U = { size: u("u_size"), t: u("u_t"), box: u("u_box"), radius: u("u_radius"), dpr: u("u_dpr"), color: u("u_color"),
        calm: u("u_calm"), swell: u("u_swell"), proj: u("u_proj"), dot: u("u_dot"), alpha: u("u_alpha"), water: u("u_water"),
        pitch: u("u_pitch"), pill: u("u_pill"), fade: u("u_fade"), fadeSpeed: u("u_fadeSpeed"),
        ab: u("u_ab"), bg: u("u_bg") };
    const posBuf = gl.createBuffer(), waterBuf = gl.createBuffer();
    const aP = gl.getAttribLocation(prog, "a_p"), aW = gl.getAttribLocation(prog, "a_w");
    gl.enableVertexAttribArray(aP);
    gl.enableVertexAttribArray(aW);
    // A pill's sprite is its whole length across, and a GPU caps the size of a point (64 px is the least it may), so
    // the longest pill is held to what fits.
    const maxPoint = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null)?.[1] ?? 64;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // WHY IT IS STILL, kept current by the events of each cause; `reason` is "" while it moves.
    const motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    let battery: { charging: boolean; level: number } | null = null, slow = false, reason = "";
    const watch = frameWatch();
    let clock = 0;   // seconds of motion so far: it stops while still, so motion resumes where it left off
    let w = 0, h = 0, raf = 0, last = performance.now(), prevFrame = last, behind = 0, boxKey = "";
    let grid: FieldGrid = fieldGrid(0, 0), sea: Water = water(0, 0), attr = new Float32Array(0);
    // The pointer while it is held down on open ground (`stirsAt`), in the canvas's CSS px; null otherwise.
    let at: { x: number; y: number } | null = null;
    const resize = (): void => {
        const r = canvas.getBoundingClientRect();
        const dpr = Math.max(0.25, Math.min(window.devicePixelRatio || 1, 2) * FIELD.renderScale);
        if (r.width === w && r.height === h && canvas.width === Math.round(r.width * dpr) && grid.pitch === FIELD.pitch) return;
        w = r.width; h = r.height;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        gl.viewport(0, 0, canvas.width, canvas.height);
        grid = fieldGrid(w, h);
        sea = water(grid.cols, grid.rows);
        attr = new Float32Array(grid.cols * grid.rows * 3);
        boxKey = "";
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, grid.pos, gl.STATIC_DRAW);
        gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, waterBuf);
        gl.bufferData(gl.ARRAY_BUFFER, attr, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aW, 3, gl.FLOAT, false, 0, 0);
        gl.uniform2f(U.size, w, h);
        gl.uniform1f(U.dpr, dpr);
    };
    /** Canvas CSS px to the grid's fractional cells. */
    const cell = (x: number, y: number): [number, number] => [(x - grid.x0) / grid.pitch, (y - grid.y0) / grid.pitch];
    let drawn = -1e9;
    const frame = (now: number): void => {
        raf = 0;
        // THE FRAME CAP: a display faster than `fps` gets every other vsync (or fewer). A skipped vsync changes
        // nothing on the canvas, so the compositor has nothing to redraw either.
        if (reason === "" && now - drawn < 1000 / Math.max(FIELD.fps, 1) - 2) { raf = requestAnimationFrame(frame); return; }
        drawn = now;
        resize();
        const origin = canvas.getBoundingClientRect();
        const el = box();
        if (el) {
            const b = el.getBoundingClientRect();
            const cx = b.left - origin.left + b.width / 2, cy = b.top - origin.top + b.height / 2, hx = b.width / 2, hy = b.height / 2;
            const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, hx, hy);
            gl.uniform4f(U.box, cx, cy, hx, hy);
            gl.uniform1f(U.radius, r);
            const key = `${cx},${cy},${hx},${hy},${r}`;
            if (key !== boxKey) {
                boxKey = key;
                holdStill(sea, (x, y) => sdBox(grid.x0 + x * grid.pitch, grid.y0 + y * grid.pitch, cx, cy, hx, hy, r) < 0);
            }
        } else gl.uniform4f(U.box, 0, 0, 0, 0);
        const F = FIELD;
        gl.uniform1f(U.calm, Math.max(F.calmPx, 1));
        gl.uniform3f(U.swell, F.swell, F.swellSpeed, F.swellScale);
        gl.uniform2f(U.proj, F.lift, F.parallax);
        gl.uniform2f(U.dot, F.dotSize, F.dotGrow);
        gl.uniform3f(U.alpha, F.alpha, F.alphaDepth, F.alphaPatch);
        gl.uniform2f(U.water, F.waterLift, F.refract);
        gl.uniform1f(U.pitch, grid.pitch);
        gl.uniform4f(U.fade, F.fadePx, F.fadeSoft, F.fadeWobble, F.fadeWobbleScale);
        gl.uniform1f(U.fadeSpeed, F.fadeWobbleSpeed);
        gl.uniform2f(U.ab, F.aberration, F.aberrationMax);
        const longest = Math.max(0, Math.min(F.pillMax, maxPoint / Math.min(window.devicePixelRatio || 1, 2) - 2 * (F.dotSize + F.dotGrow * 3) - 4));
        gl.uniform4f(U.pill, F.pills ? 1 : 0, F.pillLength, longest, F.pillAcross ? 1 : 0);
        sea.k = F.waveK; sea.damp = F.damp; sea.level = F.level;
        // The page under the field is the canvas's `outline-color` (the theme's --bg, see chat.css), read as rgb()
        // whatever the theme wrote it as: aberration composites against it, and its brightness picks the ink.
        const bg = rgbOf(getComputedStyle(canvas).outlineColor) ?? [0, 0, 0];
        const dark = isDark(bg);
        const rgb = hexRgb(dark ? F.inkDark : F.inkLight) ?? [0.5, 0.5, 0.5];
        const opacity = String(dark ? F.opacityDark : F.opacityLight);
        if (canvas.style.opacity !== opacity) canvas.style.opacity = opacity;
        gl.uniform3f(U.color, rgb[0], rgb[1], rgb[2]);
        gl.uniform3f(U.bg, bg[0], bg[1], bg[2]);
        // The water steps at a fixed rate, however fast frames come; a long gap (a hidden tab) is not caught up.
        behind = Math.min(behind + (now - last) / 1000, 4 / STEP_HZ);
        last = now;
        const still = reason !== "";
        if (!still) {
            for (; behind >= 1 / STEP_HZ; behind -= 1 / STEP_HZ) stepWater(sea);
            clock += Math.min((now - prevFrame) / 1000, 0.1);
            // Judged against the cap: at 30 fps a 33 ms frame is on time, not slow.
            if (watch((now - prevFrame) * Math.min(1, FIELD.fps / 60)) && !slow) { slow = true; queueMicrotask(update); }
        }
        prevFrame = now;
        gl.bindBuffer(gl.ARRAY_BUFFER, waterBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, waterAttr(sea, attr));
        gl.uniform1f(U.t, clock);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.POINTS, 0, grid.cols * grid.rows);
        if (!still && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const kick = (): void => { if (!raf) raf = requestAnimationFrame(frame); };
    // ONLY A HELD PRESS STIRS IT, and only one that began on open ground: hovering does nothing, and a press on the
    // box, a pill, a button or any other control is that control's. While held, a move drops energy along the segment
    // it travelled, in steps of under a cell, in proportion to its length: a fast drag is a wake, a slow one a ripple.
    const local = (e: PointerEvent): { x: number; y: number } => {
        const o = canvas.getBoundingClientRect();
        return { x: e.clientX - o.left, y: e.clientY - o.top };
    };
    const onDown = (e: PointerEvent): void => {
        if (reason || e.button !== 0 || !stirsAt(e.target)) return;
        // A drag across the page would otherwise select its text. Focus stays where it was, too.
        e.preventDefault();
        at = local(e);
        document.documentElement.classList.add("start-field-stirring");
        const [gx, gy] = cell(at.x, at.y);
        splash(sea, gx, gy, FIELD.press, FIELD.splashRadius * 1.4);
    };
    const onMove = (e: PointerEvent): void => {
        if (!at) return;
        const next = local(e);
        const [ax, ay] = cell(at.x, at.y), [bx, by] = cell(next.x, next.y);
        const len = Math.hypot(bx - ax, by - ay), n = Math.ceil(len / 0.7);
        const each = Math.min(len * FIELD.drop, FIELD.dropMax) / Math.max(n, 1);
        for (let i = 1; i <= n; i++) splash(sea, ax + (bx - ax) * i / n, ay + (by - ay) * i / n, each, FIELD.splashRadius);
        at = next;
    };
    const onUp = (): void => { at = null; document.documentElement.classList.remove("start-field-stirring"); };
    const noSelect = (e: Event): void => { if (at) e.preventDefault(); };
    const onVis = (): void => { if (!document.hidden) { last = prevFrame = performance.now(); kick(); } };
    /** Re-read every cause; on a change, mark the canvas and draw (one frame if now still, the loop if not). */
    const update = (): void => {
        const next = stillReason({ forced: FIELD.still, reducedMotion: !!motionQuery?.matches, lowBattery: lowBattery(battery), slow });
        if (next === reason) return;
        reason = next;
        if (next) canvas.dataset.still = next; else delete canvas.dataset.still;
        if (next) onUp();
        last = prevFrame = performance.now();
        kick();
    };
    // The panel's switch has no event to listen to; reading one boolean a second costs nothing.
    const forcedPoll = setInterval(update, 1000);
    motionQuery?.addEventListener?.("change", update);
    type BatteryLike = { charging: boolean; level: number; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
    let batteryRef: BatteryLike | null = null;
    const onBattery = (): void => { if (batteryRef) { battery = { charging: batteryRef.charging, level: batteryRef.level }; update(); } };
    const getBattery = (navigator as { getBattery?: () => Promise<BatteryLike> }).getBattery;
    void getBattery?.call(navigator).then((b) => {
        batteryRef = b;
        for (const t of ["chargingchange", "levelchange"]) b.addEventListener(t, onBattery);
        onBattery();
    }, () => {});
    // A still field still redraws when its size or the box changes (the box grows as someone types).
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(kick);
    ro?.observe(canvas);
    const el = box();
    if (el) ro?.observe(el);
    const ends = ["pointerup", "pointercancel", "blur"] as const;
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: true });
    for (const t of ends) window.addEventListener(t, onUp);
    document.addEventListener("selectstart", noSelect);
    update();
    document.addEventListener("visibilitychange", onVis);
    kick();
    return () => {
        if (raf) cancelAnimationFrame(raf);
        ro?.disconnect();
        window.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        for (const t of ends) window.removeEventListener(t, onUp);
        document.removeEventListener("selectstart", noSelect);
        clearInterval(forcedPoll);
        motionQuery?.removeEventListener?.("change", update);
        if (batteryRef) for (const t of ["chargingchange", "levelchange"]) batteryRef.removeEventListener(t, onBattery);
        onUp();
        document.removeEventListener("visibilitychange", onVis);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
}
