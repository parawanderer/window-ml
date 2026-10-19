// pin-glide.test.mjs — the transcript follows its bottom with a short glide for a small growth and a jump for a large
// one (src/chat/pin-glide.ts), retargets mid-glide, and stops when the reader takes over.
import { test } from "node:test";
import assert from "node:assert/strict";

const { pinGlide, glides, easeOut, GLIDE_MS } = await import("../src/chat/pin-glide.ts");

/** A scroller of `height` px whose content is `content` px, with a frame clock the test advances by hand. */
function world({ content = 1000, height = 400, reduced = false } = {}) {
    let t = 0, queued = null;
    // A real scroller clamps scrollTop to the end, which a jump relies on.
    let top = content - height;
    const el = { get scrollTop() { return top; }, set scrollTop(v) { top = Math.min(Math.max(0, v), content - height); }, clientHeight: height, get scrollHeight() { return content; }, grow(px) { content += px; } };
    const pin = pinGlide(el, { now: () => t, raf: (f) => { queued = f; return 1; }, caf: () => { queued = null; }, reduced: () => reduced });
    const frame = (ms = 16) => { t += ms; const f = queued; queued = null; f?.(t); };
    const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
    return { el, pin, frame, gap, pending: () => !!queued };
}

// --- glide or jump ---

test("a small growth is followed by a glide that ends exactly at the bottom", () => {
    const w = world();
    w.el.grow(26); w.pin.follow();
    assert.equal(w.gap(), 26, "nothing moves until the first frame");
    w.frame();
    assert.ok(w.gap() > 0 && w.gap() < 26, "part of the way after one frame");
    for (let i = 0; i < 12; i++) w.frame();
    assert.equal(w.gap(), 0);
    assert.equal(w.pending(), false, "and then it stops asking for frames");
});

test("a large growth, or reduced motion, jumps to the bottom at once", () => {
    const big = world(); big.el.grow(300); big.pin.follow();
    assert.equal(big.gap(), 0);
    const calm = world({ reduced: true }); calm.el.grow(26); calm.pin.follow();
    assert.equal(calm.gap(), 0);
    assert.deepEqual([glides(200, 400), glides(201, 400), glides(0, 400)], [true, false, false]);
});

test("content growing mid-glide is followed from where the glide is, never backwards", () => {
    const w = world();
    w.el.grow(26); w.pin.follow(); w.frame(); w.frame();
    const before = w.el.scrollTop;
    w.el.grow(26); w.pin.follow(); w.frame();
    assert.ok(w.el.scrollTop >= before);
    for (let i = 0; i < 12; i++) w.frame();
    assert.equal(w.gap(), 0);
});

test("stop() leaves the scroller where the reader took it", () => {
    const w = world();
    w.el.grow(26); w.pin.follow(); w.frame();
    w.pin.stop();
    const at = w.el.scrollTop;
    w.frame(); w.frame();
    assert.equal(w.el.scrollTop, at);
});

test("the easing starts fast and lands exactly", () => {
    assert.equal(easeOut(0), 0);
    assert.equal(easeOut(1), 1);
    assert.equal(easeOut(2), 1);
    assert.ok(easeOut(16 / GLIDE_MS) > 16 / GLIDE_MS, "ahead of linear after the first frame");
});
