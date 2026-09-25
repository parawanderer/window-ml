// ambient-gl.ts — THE START PAGE'S AMBIENT FIELD, as a shader. The CSS version (chat.css, `.chat-ambient`) moves four
// blurred circles with a matrix; this evaluates a colour at every pixel, every frame, which buys the three things the
// CSS one structurally cannot have:
//
//   DOMAIN WARPING — the wobble. Noise is fed back into its own coordinates twice (fbm(p + 4*fbm(p + 4*fbm(p)))),
//   so the field does not translate, it CHURNS: shapes stretch, fold and pull apart, and the movement reads as a
//   liquid rather than as things sliding past each other. A transform cannot do this at any cost.
//   LINEAR-LIGHT BLENDING — colours cross without going muddy. Compositing in sRGB darkens every midpoint, which is
//   what makes overlapping CSS gradients grey in the middle.
//   DITHER — a smooth gradient on an 8-bit display bands, and blur does not hide it because banding IS smooth. A
//   pixel of noise under the quantiser removes it, and there is no way to say that in CSS.
//
// It is DECORATION, so nothing here is allowed to cost anything that matters: one fullscreen triangle, an 8x8 texture,
// no depth buffer, no library. It stops entirely when the page is hidden, when the element scrolls away, and when the
// reader asked for less motion — in that last case it draws ONE frame and holds it, because the objection is to the
// movement and not to the colour. Anything unsupported or lost returns false and the caller keeps the CSS field.

/** How fast the field churns. Small on purpose: at 0.03 a shape takes about a minute to become a different shape. */
const SPEED = 0.03;

/** The colours the field is made of, the app's own indigo either side of itself. Kept few and close: a palette that
 *  spans the wheel reads as a lava lamp, and this is meant to be the product's colour out of focus. */
const PALETTE = ["#4f4fd8", "#6b3fd0", "#2478b4", "#b8407a", "#3a3a96", "#1f5590"];

/** How many texels across the palette image is. EIGHT, because the diffusion is the POINT: at this size a texel is a
 *  tenth of the screen and bilinear filtering turns six colours into a continuous wash on its own, which is the whole
 *  trick — the blur is done by the sampler, not by a kernel. */
const TEX = 8;

/** One triangle covering the viewport. A quad needs two and a rectangle's diagonal is a seam the rasteriser can see. */
const VERT = /* glsl */ `#version 300 es
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// NO BACKTICKS BELOW THIS LINE. The whole shader is a template literal, so one in a comment ends it, and the error
// it produces points at the JavaScript after the string rather than at the comment that broke it.
const FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime;
/** 0 on a dark page, 1 on a light one: the same field has to be a glow on one and a wash on the other. */
uniform float uLight;
/** The box the glow comes off, in canvas pixels: centre, half-size, corner radius. */
uniform vec2 uBoxC;
uniform vec2 uBoxR;
uniform float uBoxRad;
/** The page's own background, in LINEAR light. The glow is added to it here rather than composited over it by the
 *  browser: see the note where it is written out. */
uniform vec3 uBg;
/** The palette, as an 8x8 sRGB image. Sampled with LINEAR filtering, which is where the diffusion comes from. */
uniform sampler2D uTex;

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

/** Value noise, smoothed with 3t²-2t³ so the lattice never shows as a grid of creases. */
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Distance from a point to a rounded box — negative inside it. The glow is a function of this, which is what makes
// it hug the composer's actual shape, corners included, rather than being a circle that sits behind it.
// (No backticks in here: this whole shader is a template literal, and one would end it.)
float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

/** Five octaves. Beyond that the detail is finer than the blur this is imitating and only costs fill rate. */
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
    return v;
}

// Linear light to sRGB, the REAL transfer function and not a 2.2 power.
//
// They are close in the midtones and quite different in the darks, where sRGB has a straight segment — and the darks
// are this entire page. The background is decoded with the exact curve in JavaScript, so encoding with pow(1/2.2)
// here made the round trip lossy: with no light added at all the canvas came out a slightly different grey from the
// page it sits on, and the seam was visible down the edge of the pane. An exact pair means the field fades into
// EXACTLY the page colour, which is the only way a background can be invisible.
vec3 toSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// HOW SLOWLY THE INNER GLOW BREATHES, and by how little. A period of about forty seconds at a tenth of its own
// strength — under the threshold at which anyone catches it happening, and over the one at which a live page and a
// screenshot of it look like the same thing. Both numbers were tried louder first: at a quarter depth it reads as a
// notification pulsing, which is a decoration asking to be looked at.
const float PULSE_RATE = 0.157;
const float PULSE_DEPTH = 0.10;

// THE CLOUDS OUT AT THE EDGES: how large the shapes are, how fast they drift, how far the noise is allowed to push
// the depth around (which is what makes a cloud arrive and leave at all), the level it has to clear to be a cloud,
// how soft that edge is, and how bright the whole thing may get.
const float CLOUD_SCALE = 0.42;
const float CLOUD_DRIFT = 0.10;
const float CLOUD_IMPACT = 1.25;
const float CLOUD_LEVEL = 0.34;
const float CLOUD_SOFT = 0.30;
const float CLOUD_GAIN = 0.16;

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.2;
    float t = uTime * ${SPEED};

    // THE WARP, twice over. Each pass displaces the sample point by a field that is itself noise, so the second pass
    // is reading a coordinate system that is already bending — which is where the folding comes from. The two passes
    // drift at different rates so the fold never settles into a pattern.
    // THE COLOUR COMES FROM A TINY TEXTURE, not from noise evaluated here. This is the primitive that makes an
    // ambient backdrop look like light BLED from something rather than a procedural field: a handful of colours in an
    // 8x8 image, read through the GPU's bilinear filter, which diffuses them into a broad smooth wash for free. It is
    // also far cheaper than what it replaced — one texture fetch against five fbm evaluations, each five octaves.
    //
    // The WARP is still noise, because that is the part a texture cannot do: the sample coordinate is displaced by a
    // slowly moving field, so the wash churns and folds instead of sliding. Warping the LOOKUP rather than the image
    // is what keeps this cheap — the texture never changes, only where each pixel reads it from.
    vec2 w = vec2(fbm(p * 0.7 + vec2(0.0, 0.0) + t), fbm(p * 0.7 + vec2(5.2, 1.3) - t * 0.8));
    // SCALE MATTERS MORE THAN ANYTHING HERE. At 0.16 the whole glow fell inside a single texel of an 8x8 image, so
    // six colours averaged to one and the field was a flat wash. Around 0.6 the glow spans three or four texels,
    // which is what puts distinct colours at its two ends while the sampler keeps the join smooth.
    vec2 uvTex = p * 0.62 + w * 0.30 + vec2(t * 0.35, -t * 0.22);
    vec3 col = texture(uTex, uvTex).rgb;

    float d = sdRoundBox(gl_FragCoord.xy - uBoxC, uBoxR, uBoxRad);
    // ONE OCTAVE, not five. fbm is built for detail, and detail on a boundary is lumps: the edge looked chewed
    // rather than breathing. A single smooth noise at a low frequency gives one broad undulation that travels
    // around the box, which is the motion this wants.
    // ONE OCTAVE, not five. fbm is built for detail, and detail on a boundary is lumps: the edge looked chewed
    // rather than breathing. A single smooth noise at a low frequency gives one broad undulation.
    float wob = noise(gl_FragCoord.xy / max(uRes.y, 1.0) * 1.5 + vec2(t * 1.5, -t * 1.1)) - 0.5;

    // TWO LAYERS, which is what makes it read as light rather than as a coloured shape. A RIM hugging the box, tight
    // and at full chroma, wobbling only slightly — and behind it a BLOOM, several times wider, dimmer, pulled back
    // toward one hue and wobbling far more. The bloom is what a heavy blur over a glow looks like, without the cost
    // of actually blurring: a blur destroys detail and lowers contrast, so the cheap way to have blurred light is to
    // never draw the detail in the first place.
    // THE RIM GETS ITS OWN NOISE, AT A MUCH LARGER SCALE. Sharing one meant the tight inner edge and the wide outer
    // one undulated together at a frequency chosen for the outer one, so the rim rippled slightly and everywhere —
    // which reads as a texture ON the edge rather than as a shape that is moving. At a third of that frequency and
    // nearly three times the amplitude it does something else: one side of the box swells while the other draws in,
    // slowly, and the whole rim leans.
    float wobRim = noise(gl_FragCoord.xy / max(uRes.y, 1.0) * 0.52 + vec2(t * 0.9, -t * 0.7)) - 0.5;
    float dRim = d + wobRim * uBoxR.y * 0.62;
    float dBloom = d + wob * uBoxR.y * 0.95;
    // The falloff widens with the amplitude: left at its old width the swell would push parts of the rim past the end
    // of their own gradient and punch holes in it, which is the detachment this went through once already.
    float rim = 1.0 - smoothstep(0.0, uBoxR.y * 1.25, max(dRim, 0.0));
    rim = pow(rim, 1.4);
    float bloom = 1.0 - smoothstep(0.0, uBoxR.y * 3.6, max(dBloom, 0.0));
    bloom *= bloom;

    // Nothing UNDER the box — it would only be seen through a panel that is already opaque — but FULL STRENGTH the
    // moment it is outside it. Fading this across the first few pixels OUTSIDE the box put a dark band exactly where
    // a glow is brightest, so the light appeared to hover away from the thing emitting it.
    float inside = smoothstep(-10.0, 0.0, d);
    // The bloom, with its variation flattened toward the field's own average: fewer colours, further apart, which
    // is what a heavy blur does to an image and is cheaper than blurring one.
    vec3 soft = mix(col, vec3(dot(col, vec3(0.30, 0.42, 0.28))), 0.55);   // the bloom, with its variation flattened out: fewer colours, further apart
    // The weights are low because the page has ONE sentence on it and the glow sits under it. Twice this and the
    // hint line under the box could not be read, which is a decoration that has started competing with the content.
    // THE RIM BREATHES. A sine on the inner layer's weight alone — not the bloom, which is the part already doing
    // the slow churning, and not the colour, because brightening a hue shifts it. The phase comes from the clock the
    // seed already wound forward, so two loads are not in step with each other either.
    float aRim = rim * 0.30 * mix(1.0, 0.55, uLight) * (1.0 + PULSE_DEPTH * sin(uTime * PULSE_RATE));
    float aBloom = bloom * 0.17 * mix(1.0, 0.55, uLight);

    // ===== THE CLOUDS OUT AT THE EDGES =====
    // Distance fog, taken from how a 3D scene does it: a DEPTH, and that depth wobbled by noise. Distance out from the
    // box is this page's depth — the composer is where the camera stands and the corners of the window are the far end
    // — which is what puts the clouds at the edges STRUCTURALLY. A vignette masking a noise field was the first
    // version, and it looks like what it is: a frame around the picture, moving at one rate while the thing behind it
    // moves at another.
    float far = max(d, 0.0) / max(uRes.y, 1.0);
    // THE NOISE'S AMPLITUDE GROWS WITH THAT DEPTH — the one idea worth taking from a fog shader. A constant amplitude
    // wobbles the near field too, which reads as a texture crawling over the page rather than as weather happening
    // some way off; multiplying by the depth means nothing near the box moves at all and only the far field clouds up.
    // The warp is reused rather than recomputed, so the whole effect costs one fbm.
    vec2 cp = p * CLOUD_SCALE + w * 0.45 + vec2(t * CLOUD_DRIFT, -t * 0.07);
    float depth = far * (1.0 + CLOUD_IMPACT * (fbm(cp) - 0.5) * 2.0);
    // AND THEN A LEVEL, which is the part a fog shader does not need. In a real scene the shapes come from the
    // geometry the fog is tinting; there is none here, so an exponential falloff over that depth is just a vignette —
    // brightest at the corners, smooth all the way round, moving as one piece. A level is what makes an EDGE, and
    // because only distance can lift the field over it, the shapes appear at the edges without anything masking them
    // there. Where the field is high a cloud reaches in; where it is low the corner is the page's own colour again.
    float cloud = smoothstep(CLOUD_LEVEL, CLOUD_LEVEL + CLOUD_SOFT, depth);
    vec3 cloudCol = texture(uTex, cp * 0.55 + vec2(3.1, 7.4)).rgb;
    // Flattened further than the bloom is: a cloud at the edge of vision has no hue separation left in it, and the
    // full palette out there read as a second coloured subject on a page whose subject is one input box.
    cloudCol = mix(cloudCol, vec3(dot(cloudCol, vec3(0.30, 0.42, 0.28))), 0.45);
    float aCloud = cloud * CLOUD_GAIN * mix(1.0, 0.5, uLight);

    // THE PAGE'S BACKGROUND IS PAINTED HERE, and the light is ADDED to it, in linear space.
    //
    // The version before this drew only the light and let the browser composite it over the page. That needs
    // premultiplied alpha — colour must equal tint times coverage, in the same space — and the gamma encode below
    // breaks exactly that relationship: at low coverage pow() lifts the colour far more than the alpha, so the two
    // stop agreeing and the seam shows up as a hard edge right where the bloom fades out. A ring around the whole
    // glow, which is the opposite of what a glow is.
    //
    // Adding to a filled background has no such relationship to break: everything happens in linear light, there is
    // one gamma encode at the very end, and the dither lands under the quantiser rather than on a colour that is
    // about to be divided by its alpha.
    vec3 lit = uBg + (col * aRim + soft * aBloom + cloudCol * aCloud) * inside;

    lit = toSrgb(max(lit, vec3(0.0)));
    lit += (hash(gl_FragCoord.xy) - 0.5) / 255.0;   // dither, under the quantiser: this is what stops the banding
    outColor = vec4(lit, 1.0);
}`;

/** A running field: how to stop it. */
export interface Ambient { stop(): void }

/**
 * Draw the ambient field into `canvas` until `stop()`.
 *
 * Returns null where WebGL2 is missing, refused, or the shaders do not compile — every one of which is a normal
 * thing on someone's machine, and none of which is worth a broken page for a decoration. The caller keeps the CSS
 * field in that case, which is why this reports failure rather than throwing.
 *
 * @param canvas the element to draw into; it is sized to its own box, times the device pixel ratio
 * @param opts `light` picks the palette's weight for a light page; `still` draws one frame and stops, for a reader
 *   who asked for less motion; `target` is the element the glow comes off, read every frame because it moves; `bg`
 *   is the page's own background colour, which the shader PAINTS rather than compositing over; `seed` (0-1) fixes the
 *   arrangement and the starting phase, and defaults to a fresh one per call
 */
export function startAmbient(canvas: HTMLCanvasElement, opts: { light?: boolean; still?: boolean; target?: HTMLElement | null; bg?: string; palette?: readonly string[]; seed?: number } = {}): Ambient | null {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl) return null;

    const compile = (type: number, src: string): WebGLShader | null => {
        const sh = gl.createShader(type);
        if (!sh) return null;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        // A compile failure returns null and the page simply has no field; to see WHY, log `gl.getShaderInfoLog(sh)`
        // here. It is silent by default because a decoration must never put an error in anyone's console.
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
        return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uBoxC = gl.getUniformLocation(prog, "uBoxC");
    const uBoxR = gl.getUniformLocation(prog, "uBoxR");
    const uBoxRad = gl.getUniformLocation(prog, "uBoxRad");
    gl.uniform1f(gl.getUniformLocation(prog, "uLight"), opts.light ? 1 : 0);
    const bg = linearOf(opts.bg || "#121316");
    gl.uniform3f(gl.getUniformLocation(prog, "uBg"), bg[0], bg[1], bg[2]);
    gl.activeTexture(gl.TEXTURE0);
    // A FRESH START EACH VISIT. The arrangement of colours and the phase of the warp both come from this, so the page
    // is never opened twice on the same picture — and the phase matters more than the palette: without it every load
    // began at the same composition and the first few seconds were identical every time, which is the one part anyone
    // would ever see of a field this slow.
    const seed = opts.seed ?? Math.random();
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture(gl, opts.palette ?? PALETTE, seed));
    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);

    let raf = 0, stopped = false;
    // Wound forward to somewhere in the middle of the warp's evolution, rather than to its beginning.
    const t0 = performance.now() - seed * 400_000;
    // HALF RESOLUTION, deliberately. Every feature here is wider than a hundred pixels, so the only thing full
    // resolution buys is fill rate — and this is running behind a WebView on a phone.
    const size = () => {
        const r = canvas.getBoundingClientRect();
        const s = Math.min(devicePixelRatio || 1, 2) * 0.5;
        const w = Math.max(1, Math.round(r.width * s)), h = Math.max(1, Math.round(r.height * s));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        // WHERE THE LIGHT COMES FROM, in canvas pixels. Read from the element itself rather than assumed, because the
        // box moves: it grows with what is typed, and the pills above it come and go with the kind.
        const box = opts.target?.getBoundingClientRect();
        const k = canvas.width / Math.max(r.width, 1);
        if (box) {
            const cx = (box.left - r.left + box.width / 2) * k;
            // GL's y runs up the screen and the DOM's runs down, so the centre is measured from the bottom.
            const cy = (r.bottom - (box.top + box.height / 2)) * k;
            gl.uniform2f(uBoxC, cx, cy);
            gl.uniform2f(uBoxR, (box.width / 2) * k, (box.height / 2) * k);
            gl.uniform1f(uBoxRad, 26 * k);
        } else {
            gl.uniform2f(uBoxC, canvas.width / 2, canvas.height / 2);
            gl.uniform2f(uBoxR, canvas.width * 0.22, canvas.height * 0.07);
            gl.uniform1f(uBoxRad, 26 * k);
        }
    };

    const draw = (now: number) => {
        if (stopped) return;
        size();
        gl.uniform1f(uTime, (now - t0) / 1000);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (!opts.still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    // A field nobody is looking at is pure cost: a backgrounded tab, or this page scrolled away behind another view.
    const onVisible = () => {
        if (document.hidden) { cancelAnimationFrame(raf); }
        else if (!stopped && !opts.still) raf = requestAnimationFrame(draw);
    };
    document.addEventListener("visibilitychange", onVisible);

    return { stop() {
        stopped = true;
        cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVisible);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
    } };
}

/** A `#rgb` / `#rrggbb` / `rgb(…)` colour as LINEAR light, which is the space the shader adds in. `rgb()` is here
 *  because the ground is found by asking an element what it PAINTS, and that is the form a computed style comes back
 *  in. Anything unparseable comes back as the dark theme's background rather than as black: a wrong-but-plausible
 *  ground beats a hole in the page. */
function linearOf(css: string): [number, number, number] {
    const srgb = channelsOf(css);
    if (!srgb) return linearOf("#121316");
    // The real sRGB transfer function, not a 2.2 power: they differ most in the darks, which is all this page is.
    const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return [lin[0], lin[1], lin[2]];
}

/** The three channels of a `#rgb`, `#rrggbb` or `rgb()/rgba()` colour, each 0-1, or null if it is neither. */
function channelsOf(css: string): [number, number, number] | null {
    const s = css.trim();
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (fn) return [Number(fn[1]) / 255, Number(fn[2]) / 255, Number(fn[3]) / 255];
    const hex = s.replace(/^#/, "");
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    if (!/^[0-9a-f]{6}$/i.test(full)) return null;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/**
 * The palette as a small sRGB image, seeded and then smoothed so no two neighbours are far apart.
 *
 * Uploaded as `SRGB8_ALPHA8`, so the sampler converts to linear light on every read: the blending the hardware does
 * between texels is then physically the same blending the shader does afterwards, and neither darkens the midpoints
 * the way sRGB interpolation would.
 *
 * Seeded from a hash of the palette rather than from `Math.random`, so a reload is the same field: a decoration that
 * is different every time is one nobody can describe a problem with.
 */
function paletteTexture(gl: WebGL2RenderingContext, palette: readonly string[], seed0: number): WebGLTexture | null {
    const px = new Float32Array(TEX * TEX * 3);
    let seed = (Math.floor(seed0 * 0xffffffff) >>> 0) || 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < TEX * TEX; i++) {
        const c = palette[Math.floor(rnd() * palette.length)] ?? palette[0];
        const [r, g, b] = bytesOf(c);
        px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b;
    }
    // Two box passes, wrapping at the edges: random texels alone give a field that still reads as noise once it is
    // stretched across a screen. Smoothing first is what makes it read as a few large colour regions.
    // ONE pass, not two. Twice averaged, six colours converge on their own mean and the image is one colour with a
    // faint mottle — the diffusion the sampler does afterwards is already most of what this is for.
    for (let pass = 0; pass < 1; pass++) {
        const out = new Float32Array(px.length);
        for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
            for (let k = 0; k < 3; k++) {
                let sum = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    sum += px[(((y + dy + TEX) % TEX) * TEX + ((x + dx + TEX) % TEX)) * 3 + k];
                }
                out[(y * TEX + x) * 3 + k] = sum / 9;
            }
        }
        px.set(out);
    }
    const data = new Uint8Array(TEX * TEX * 4);
    for (let i = 0; i < TEX * TEX; i++) {
        data[i * 4] = px[i * 3]; data[i * 4 + 1] = px[i * 3 + 1]; data[i * 4 + 2] = px[i * 3 + 2]; data[i * 4 + 3] = 255;
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, TEX, TEX, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    // LINEAR is the diffusion, and REPEAT lets the warped lookup roam without ever meeting an edge.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
}

/** A palette colour as three 0-255 bytes, for the texture upload. */
function bytesOf(css: string): [number, number, number] {
    const c = channelsOf(css);
    return c ? [c[0] * 255, c[1] * 255, c[2] * 255] : [40, 40, 90];
}
