// start-field.test.mjs — the start page's dot field away from WebGL: the water under it (start-water.ts), a damped
// wave equation that has to stay stable, carry a disturbance outward, die away and leave the box still; and the
// geometry the shader is handed (the grid, the box's signed distance, the page's colour). How it LOOKS is a screenshot
// (`node tests/e2e/chat-shots.mjs`), not a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { water, stepWater, splash, holdStill, energy, WAVE_K, DAMP, STEP_HZ } from "../src/chat/start-water.ts";
import { fieldGrid, sdBox, rgbOf, hexRgb, isDark, waterAttr, stillReason, lowBattery, LOW_BATTERY, frameWatch } from "../src/chat/start-field.ts";

const at = (w, x, y) => w.h[y * w.cols + x];
const steps = (w, n) => { for (let i = 0; i < n; i++) stepWater(w); };

// --- the water: stable, spreading, fading ---

test("the scheme is inside the 2D stability bound, and a ripple lasts seconds, not frames", () => {
    assert.ok(WAVE_K > 0 && WAVE_K < 0.5, "K = c²dt²/dx² under 1/2");
    const seconds = Math.log(0.01) / Math.log(DAMP) / STEP_HZ;
    assert.ok(seconds > 3 && seconds < 15, `down to 1% in ${seconds.toFixed(1)} s`);
});

test("a drop spreads outward: a cell ten away is still before the wave arrives and moves after", () => {
    const w = water(41, 41);
    splash(w, 20, 20, 1);
    stepWater(w);
    assert.equal(at(w, 30, 20), 0, "nothing has reached it after one step");
    let moved = 0;
    for (let i = 0; i < 80; i++) { stepWater(w); moved = Math.max(moved, Math.abs(at(w, 30, 20))); }
    assert.ok(moved > 1e-3, `it moved (${moved})`);
});

test("it stays bounded under a long stir of drops at random places", () => {
    const w = water(64, 40);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 6000; i++) {
        if (i % 3 === 0 && i < 3000) splash(w, rnd() * 64, rnd() * 40, 1.1);
        stepWater(w);
    }
    const peak = w.h.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(Number.isFinite(peak) && peak < 1e-3, `settled after the stir stopped (peak ${peak})`);
});

test("energy only drains: never more after a step than before it", () => {
    const w = water(30, 30);
    splash(w, 15, 15, 1);
    stepWater(w);
    let e = energy(w);
    for (let i = 0; i < 400; i++) {
        stepWater(w);
        const next = energy(w);
        assert.ok(next <= e * 1.0001, `step ${i}: ${next} > ${e}`);
        e = next;
    }
});

// --- the box holds the water still ---

test("cells under the box stay at zero, and a drop on the box adds nothing there", () => {
    const w = water(30, 20);
    const inside = (x, y) => x >= 10 && x < 20 && y >= 8 && y < 12;
    splash(w, 15, 10, 1);   // before the box is known: it is cleared when it is
    holdStill(w, inside);
    assert.equal(at(w, 15, 10), 0);
    splash(w, 15, 10, 1);
    splash(w, 5, 10, 1);
    steps(w, 200);
    for (let y = 8; y < 12; y++) for (let x = 10; x < 20; x++) assert.equal(at(w, x, y), 0, `(${x},${y})`);
    assert.notEqual(at(w, 5, 5), 0, "the water outside it moves");
});

test("a ripple reflects off the box: the side facing the drop is disturbed more than the side behind it", () => {
    const w = water(60, 21);
    holdStill(w, (x) => x >= 28 && x <= 31);
    splash(w, 15, 10, 1);
    let front = 0, behind = 0;
    for (let i = 0; i < 120; i++) { stepWater(w); front = Math.max(front, Math.abs(at(w, 20, 10))); behind = Math.max(behind, Math.abs(at(w, 40, 10))); }
    assert.ok(front > 0.01 && behind < front / 10, `front ${front}, behind ${behind}`);
});

// --- what the shader is handed ---

test("the grid covers the canvas past every edge, row-major from (x0, y0)", () => {
    const g = fieldGrid(400, 300, 20);
    assert.equal(g.pos.length, g.cols * g.rows * 2);
    assert.ok(g.x0 < 0 && g.y0 < 0, "starts before the top-left");
    assert.ok(g.x0 + (g.cols - 1) * g.pitch > 400 && g.y0 + (g.rows - 1) * g.pitch > 300, "ends past the bottom-right");
    assert.deepEqual([g.pos[2] - g.pos[0], g.pos[g.cols * 2 + 1] - g.pos[1]], [20, 20]);
});

test("the box's signed distance: negative inside, zero on the edge, the corner radius rounds it", () => {
    const d = (x, y, r = 0) => sdBox(x, y, 100, 50, 40, 20, r);
    assert.ok(d(100, 50) < 0);
    assert.equal(d(140, 50), 0);
    assert.equal(d(150, 50), 10);
    assert.equal(d(140, 70), 0, "a sharp corner is on the edge");
    assert.ok(d(140, 70, 10) > 0, "a rounded one is outside it");
    assert.ok(Math.abs(d(130 + 10 * Math.SQRT1_2, 60 + 10 * Math.SQRT1_2, 10)) < 1e-9, "on the arc");
});

test("the water attribute is the height and its central slope, one-sided at an edge", () => {
    const w = water(3, 1);
    w.h.set([0, 1, 4]);
    assert.deepEqual([...waterAttr(w, new Float32Array(9))], [0, 0.5, 0, 1, 2, 0, 4, 1.5, 0]);
});

test("the page's colour is read from rgb() and rgba(), and anything else is no colour", () => {
    assert.deepEqual(rgbOf("rgb(255, 0, 51)"), [1, 0, 0.2]);
    assert.deepEqual(rgbOf("rgba(0, 0, 0, 0.5)"), [0, 0, 0]);
    assert.equal(rgbOf("color(srgb 1 0 0)"), null);
});

test("an ink colour is read from #rgb and #rrggbb, and anything else is no colour", () => {
    assert.deepEqual(hexRgb("#ff0033"), [1, 0, 0.2]);
    assert.deepEqual(hexRgb("#f03"), [1, 0, 0.2]);
    assert.equal(hexRgb("red"), null);
    assert.equal(hexRgb("#ff003"), null);
});

test("which ink a page gets is decided by its background's brightness: both themes' backgrounds, and the line", () => {
    assert.equal(isDark(hexRgb("#121316")), true, "the calm dark page");
    assert.equal(isDark(hexRgb("#1e1f24")), true, "the panel's dark page");
    assert.equal(isDark(hexRgb("#ffffff")), false, "the light page");
    assert.equal(isDark([0.5, 0.5, 0.5]), false, "half is light");
    assert.equal(isDark([0.49, 0.49, 0.49]), true);
});

// --- when the field stops moving ---

test("still for the first cause that holds, in order: forced, reduced motion, low battery, slow; else moving", () => {
    const none = { forced: false, reducedMotion: false, lowBattery: false, slow: false };
    assert.equal(stillReason(none), "");
    assert.equal(stillReason({ ...none, slow: true }), "slow");
    assert.equal(stillReason({ ...none, lowBattery: true, slow: true }), "battery");
    assert.equal(stillReason({ ...none, reducedMotion: true, lowBattery: true }), "motion");
    assert.equal(stillReason({ forced: true, reducedMotion: true, lowBattery: true, slow: true }), "forced");
});

test("low battery is unplugged AND at or under the line: charging never is, and no reading never is", () => {
    assert.equal(lowBattery(null), false, "a browser with no Battery API");
    assert.equal(lowBattery({ charging: false, level: LOW_BATTERY }), true);
    assert.equal(lowBattery({ charging: false, level: 0.05 }), true);
    assert.equal(lowBattery({ charging: false, level: LOW_BATTERY + 0.01 }), false);
    assert.equal(lowBattery({ charging: true, level: 0.05 }), false);
});

test("slow frames: 60 fps never trips it, three seconds of 20 fps does, and one long stall is not counted", () => {
    const fast = frameWatch();
    for (let i = 0; i < 600; i++) assert.equal(fast(1000 / 60), false);
    const slow = frameWatch();
    let tripped = -1;
    for (let i = 0; i < 200 && tripped < 0; i++) if (slow(50)) tripped = i;
    assert.ok(tripped > 0 && tripped * 50 >= 3000 && tripped * 50 < 4500, `tripped after ${tripped * 50} ms`);
    const stall = frameWatch();
    for (let i = 0; i < 20; i++) assert.equal(stall(i === 10 ? 5000 : 16), false);
});

test("a stutter that recovers starts the count again", () => {
    const w = frameWatch();
    for (let i = 0; i < 40; i++) w(60);        // 2.4 s slow
    for (let i = 0; i < 120; i++) w(16);       // recovers
    for (let i = 0; i < 40; i++) assert.equal(w(60), false, "only 2.4 s since it was last fast");
});
