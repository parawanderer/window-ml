// The memory chart's gestures and its readout, end to end in jsdom: the panel's own ResourceTracks (the chart, the scrub
// strip, the window chip) as the bench page bundles it with a lane per run, driven by pointer, wheel and key events.
// Each rule here broke at least once: live drawing past a finished recording, a strip with no window to move, a drag
// that selected nothing, a readout left up after the pointer went. jsdom lays nothing out, so every element is given
// one 800 px box: a pixel x is the instant `FIRST + x / 800 * SPAN`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { staticPage } from "../tests/e2e/bench/serve.mjs";

const W = 800;
const FIRST = 1000, LAST = 39_000, SPAN = LAST - FIRST;   // readings every 2 s
const xAt = (t) => ((t - FIRST) / SPAN) * W;
const ev = (kind, t, until) => ({ kind, t, until, label: `${kind} ${t}`, model: "m:1", ref: { hash: "h" } });

/** A finished sweep with memory readings from 1 s to 39 s and two runs (6 s to 20 s, 22 s to 36 s), on the page. With
 *  `running`, the same sweep still going: its readings end at the wall clock, and the page has no end to stop at. */
async function chart(t, { running = false } = {}) {
    const shift = running ? Date.now() - LAST : 0;
    const { readSample, packSamples } = await import("../tests/e2e/bench/resource-poll.mjs");
    const GiB = 1024 ** 3;
    const info = { compute: { system_compute: { cpu_cores: 8, total_memory: 64 * GiB, free_memory: 32 * GiB, free_swap: 0 }, supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 24 * GiB, free_memory: 20 * GiB, compute: "8.6", driver: "13" }] } };
    const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith("/api/ps") ? { models: [] } : info) });
    const reads = [];
    for (let k = 0; k < 20; k++) reads.push(await readSample({ chatUrl: "http://box/api/chat/completions" }, { fetchImpl, now: () => shift + FIRST + k * 2000 }));
    const runs = [0, 1].map((i) => ({ combo: { model: `m${i}` }, taskId: "t", repeat: 0, state: "done", who: `m${i}`, ok: true }));
    const at = (ms) => shift + ms;
    const html = await staticPage({ name: "gestures", dims: ["model"], runs, rows: [], jobs: 1, started: at(5000), finished: running ? null : 30_000, resources: packSamples(reads),
        timeline: { now: at(running ? LAST : 30_000), runs: [{ index: 0, events: [ev("run", at(6000), at(20_000))] }, { index: 1, events: [ev("run", at(22_000), at(36_000))] }] } });
    const w = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true }).window;
    t.after(() => w.close());
    w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: 100, right: W, bottom: 100, x: 0, y: 0 });
    const d = w.document;
    const tick = (ms = 40) => new Promise((r) => w.setTimeout(r, ms));
    await tick();
    const q = (sel) => d.querySelector(`.tlchart ${sel}`);
    const P = (type, x, extra = {}) => new w.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 50, button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra });
    return {
        w, d, tick, q,
        /** The strip's window box as [left %, width %], or null without one. */
        box: () => { const s = q(".rc-scrub-win")?.getAttribute("style"); return s ? s.match(/[\d.]+/g).slice(0, 2).map(Number) : null; },
        /** Following the clock (nothing pinned), as the chip says. The strip's live button lights whenever the window
         *  ends at the tail, which a pinned stretch near the end does too. */
        live: () => !d.querySelector(".card .vram-zoom.pinned"),
        chip: () => {
            const c = d.querySelector(".card .vram-zoom");
            if (!c) return null;
            const text = [...c.childNodes].filter((n) => !n.classList?.contains("tt-pop")).map((n) => n.textContent).join("").trim();
            return { text, kind: c.className.match(/at-default|pinned|resized/)?.[0], el: c };
        },
        /** Where run `i`'s bar starts and how wide it is, in % of the lane. */
        bar: (i) => { const b = d.querySelectorAll(".tlchart .wml-lane .rc-ev-run")[i]; return b ? [parseFloat(b.style.left), parseFloat(b.style.width)] : null; },
        tip: () => d.querySelectorAll(".tlchart .rc-tip-keys").length,
        /** A drag from x0 to x1 that starts on `el`, as a hand makes one: down, moves on the window, up. */
        drag: async (el, x0, x1) => {
            el.dispatchEvent(P("pointerdown", x0));
            for (let k = 1; k <= 4; k++) w.dispatchEvent(P("pointermove", x0 + ((x1 - x0) * k) / 4));
            w.dispatchEvent(P("pointerup", x1));
            await tick();
        },
        wheel: async (el, init) => { el.dispatchEvent(new w.WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, clientY: 50, ...init })); await tick(); },
        key: async (key) => { d.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true })); await tick(); },
        hover: async (x = 400) => {
            const hit = q(".rc .rc-hit");
            hit.dispatchEvent(new w.PointerEvent("pointerenter", { bubbles: false, clientX: x, clientY: 50 }));
            hit.dispatchEvent(new w.PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: 50 }));
            await tick();
        },
    };
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// --- live: what the chart shows with nothing selected ---

test("live on a finished recording is all of it: the strip boxes the whole, the lanes sit on its axis, the chip says how wide", async (t) => {
    const c = await chart(t);
    assert.deepEqual(c.box(), [0, 100]);
    assert.ok(c.live());
    near(c.bar(0)[0], (5000 / SPAN) * 100, 0.5, "run 0 starts at 6 s on a 1 s to 39 s axis");
    assert.deepEqual([c.chip().text, c.chip().kind], ["all · 38s", "at-default"]);
});

test("live on a sweep still running follows the clock: the window ends now, and grows as it goes", async (t) => {
    const c = await chart(t, { running: true });
    const [left, width] = c.box();
    assert.equal(left, 0);
    near(width, 100, 1, "boxes all of it");
    assert.match(c.chip().text, /^all · 3[89]s$/);
    // The axis slides on the chart's own tick: its left edge stays at the first reading, its right edge is now, so a
    // bar drawn early moves left as the axis grows.
    const before = c.bar(0)[0];
    await c.tick(1300);
    assert.ok(c.bar(0)[0] < before - 0.3, `run 0 moved left as the axis grew (${before}% → ${c.bar(0)[0]}%)`);
    // And the chip counts with it, on the page's clock: no push comes to a saved page.
    assert.match(c.chip().text, /^all · (39|4\d)s$/, "a second later, a second wider");
});

// --- selecting a stretch, and leaving it ---

test("a drag on the plot selects that stretch: the lanes open out to it, the strip and the chip say so, and Esc goes back to live", async (t) => {
    const c = await chart(t);
    await c.drag(c.q(".rc .rc-hit"), xAt(6000), xAt(20_000));
    assert.ok(!c.live(), "a selection is not live");
    const [left, width] = c.box();
    near(left, (5000 / SPAN) * 100, 3, "box starts near 6 s");
    near(width, (14_000 / SPAN) * 100, 6, "box is about 14 s wide");
    assert.equal(c.chip().kind, "pinned");
    assert.match(c.chip().text, /^1[3-6]s ✕$/);
    const [bl, bw] = c.bar(0);
    near(bl, 0, 8, "run 0 now starts near the left edge");
    near(bl + bw, 100, 8, "and ends near the right");
    await c.key("Escape");
    assert.ok(c.live());
    assert.deepEqual(c.box(), [0, 100]);
    assert.equal(c.chip().kind, "at-default");
});

test("a drag across a lane selects the same way a drag on the plot does", async (t) => {
    const c = await chart(t);
    await c.drag(c.q(".wml-lane .rc-lane-row"), xAt(22_000), xAt(36_000));
    assert.ok(!c.live());
    near(c.box()[0], (21_000 / SPAN) * 100, 3, "box starts near 22 s");
    assert.equal(c.chip().kind, "pinned");
});

test("a click is not a selection", async (t) => {
    const c = await chart(t);
    await c.drag(c.q(".rc .rc-hit"), 400, 401);
    assert.ok(c.live());
    assert.deepEqual(c.box(), [0, 100]);
});

test("the chip's ✕ leaves a selection for live", async (t) => {
    const c = await chart(t);
    await c.drag(c.q(".rc .rc-hit"), xAt(10_000), xAt(20_000));
    assert.equal(c.chip().kind, "pinned");
    c.chip().el.click();
    await c.tick();
    assert.ok(c.live());
    assert.equal(c.chip().kind, "at-default");
});

// --- moving and resizing the window ---

test("scrolling back moves a selection earlier at the same width, on the plot and on the strip", async (t) => {
    const c = await chart(t);
    await c.drag(c.q(".rc .rc-hit"), xAt(20_000), xAt(30_000));
    const [l0, w0] = c.box();
    await c.wheel(c.q(".rc"), { deltaX: -200 });
    const [l1, w1] = c.box();
    assert.ok(l1 < l0, `plot: moved earlier (${l0} → ${l1})`);
    near(w1, w0, 0.5, "plot: same width");
    await c.wheel(c.q(".rc-scrub-track"), { deltaX: -200 });
    const [l2, w2] = c.box();
    assert.ok(l2 < l1, `strip: moved earlier (${l1} → ${l2})`);
    near(w2, w0, 0.5, "strip: same width");
});

test("pinching in on live narrows the window and keeps following; the chip's ✕ restores the default width", async (t) => {
    const c = await chart(t, { running: true });
    await c.wheel(c.q(".rc"), { ctrlKey: true, deltaY: -300, clientX: 700 });
    const [left, width] = c.box();
    assert.ok(width < 100, `narrower (${width}%)`);
    near(left + width, 100, 0.5, "still at the end");
    assert.ok(c.live(), "a narrower window at the tail still follows");
    assert.equal(c.chip().kind, "resized");
    c.chip().el.click();
    await c.tick();
    assert.deepEqual(c.box(), [0, 100]);
    assert.equal(c.chip().kind, "at-default");
});

test("dragging the strip's box moves the selection; dragged back to the end of a sweep still running, it is live again", async (t) => {
    const c = await chart(t, { running: true });
    await c.drag(c.q(".rc .rc-hit"), xAt(10_000), xAt(20_000));
    const [l0, w0] = c.box();
    const mid = ((l0 + w0 / 2) / 100) * W;
    await c.drag(c.q(".rc-scrub-track"), mid, mid + 100);
    const [l1, w1] = c.box();
    near(l1 - l0, (100 / W) * 100, 1.5, "moved by the drag");
    near(w1, w0, 0.5, "same width");
    assert.ok(!c.live());
    await c.drag(c.q(".rc-scrub-track"), ((l1 + w1 / 2) / 100) * W, W);
    assert.ok(c.live(), "at the tail it follows again");
    assert.equal(c.chip().kind, "resized", "at the width it was given, which the chip offers to undo");
});

test("a finished recording offers no live view: its button goes back to all of it, and a window dragged to the end stays put", async (t) => {
    const c = await chart(t);
    const button = () => c.q(".rc-scrub-live");
    assert.equal(button().textContent, "↺all");
    await c.drag(c.q(".rc .rc-hit"), xAt(10_000), xAt(20_000));
    const [l0, w0] = c.box();
    await c.drag(c.q(".rc-scrub-track"), ((l0 + w0 / 2) / 100) * W, W);
    const [l1, w1] = c.box();
    near(l1 + w1, 100, 0.5, "at the end");
    near(w1, w0, 0.5, "at the width it had");
    assert.equal(c.chip().kind, "pinned", "nothing to follow: the end is where it was put");
    button().click();
    await c.tick();
    assert.deepEqual(c.box(), [0, 100]);
    assert.equal(c.chip().kind, "at-default");
});

// --- the readout ---

test("the readout opens over the plot and closes when the pointer moves off the chart or onto a lane", async (t) => {
    const c = await chart(t);
    await c.hover();
    assert.equal(c.tip(), 1);
    c.d.body.dispatchEvent(new c.w.PointerEvent("pointermove", { bubbles: true, clientX: 10, clientY: 900 }));
    await c.tick();
    assert.equal(c.tip(), 0, "off the chart");
    await c.hover();
    c.q(".wml-lane .rc-lane-row").dispatchEvent(new c.w.PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 150 }));
    await c.tick();
    assert.equal(c.tip(), 0, "on a lane, whose bars have tips of their own");
});

test("a line the arrow keys hold stays read when the pointer moves off, and goes on Esc", async (t) => {
    const c = await chart(t);
    await c.hover();
    await c.key("ArrowDown");
    c.d.body.dispatchEvent(new c.w.PointerEvent("pointermove", { bubbles: true, clientX: 10, clientY: 900 }));
    await c.tick();
    assert.equal(c.tip(), 1, "held");
    await c.key("Escape");
    c.d.body.dispatchEvent(new c.w.PointerEvent("pointermove", { bubbles: true, clientX: 12, clientY: 900 }));
    await c.tick();
    assert.equal(c.tip(), 0, "let go");
});
