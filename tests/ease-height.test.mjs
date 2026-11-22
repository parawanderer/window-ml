// ease-height.test.mjs — a box whose content changed eases from the height it had to the one it has (src/sidebar/ease-height.ts).

import { test, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, useHeightEase, host;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
    host = dom.window.document.getElementById("root");
    ({ h, render } = require_("preact"));
    ({ useHeightEase } = await import("../src/sidebar/ease-height.ts"));
});
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A box whose height the test sets, recording each animation the hook starts on it. */
function box() {
    // `height` is the layout's own; while an ease runs, the box measures as `animated` (where the animation has got to).
    const b = { height: 100, animated: null, calls: [], running: [] };
    b.rect = () => ({ height: b.running.length && b.animated != null ? b.animated : b.height });
    return b;
}
/** Mount a probe that eases `b` by `sig`; returns a function to re-render it with another signature. */
function mount(b, sig, enabled = true) {
    const Probe = ({ sig, enabled }) => {
        const ref = require_("preact/hooks").useRef(null);
        const setRef = (el) => {
            if (el && !el.__stubbed) {
                el.__stubbed = true;
                el.getBoundingClientRect = b.rect;
                el.getAnimations = () => b.running;
                el.animate = (frames, opts) => { b.calls.push({ frames, opts }); const a = { id: opts.id, cancel() { b.running = b.running.filter((x) => x !== a); } }; b.running.push(a); return a; };
            }
            ref.current = el;
        };
        useHeightEase(ref, sig, enabled);
        return h("div", { ref: setRef });
    };
    const draw = (sig, enabled = true) => { render(h(Probe, { sig, enabled }), host); return wait(); };
    return { draw: (s, e) => draw(s, e), first: draw(sig, enabled) };
}

// --- when it eases, and from where to where ---
test("a change of signature that changes the height eases from the old height to the new, once", async () => {
    const b = box();
    const m = mount(b, "a"); await m.first;
    assert.equal(b.calls.length, 0, "nothing on the first draw");
    b.height = 180; await m.draw("b");
    assert.equal(b.calls.length, 1);
    assert.deepEqual(b.calls[0].frames.map((f) => f.height), ["100px", "180px"], "from where it was to where it is");
    assert.equal(b.calls[0].frames[0].overflow, "hidden", "clipped while it moves");
    await m.draw("b");                                            // a re-render with the same signature
    assert.equal(b.calls.length, 1, "no second animation for no change");
    render(null, host);
});

test("nothing eases for a change too small to see, a signature that did not change, a view that is not calm, or reduced motion", async () => {
    const b = box();
    const m = mount(b, "a"); await m.first;
    b.height = 101; await m.draw("b");
    assert.equal(b.calls.length, 0, "a pixel is not an animation");
    b.height = 300; await m.draw("b");
    assert.equal(b.calls.length, 0, "a height change with no change of signature belongs to something else");
    await m.draw("c", false);
    assert.equal(b.calls.length, 0, "disabled (the panel's views)");
    render(null, host);
    const r = box(); window.matchMedia = () => ({ matches: true }); globalThis.matchMedia = window.matchMedia;
    const m2 = mount(r, "a"); await m2.first;
    r.height = 400; await m2.draw("b");
    assert.equal(r.calls.length, 0, "reduced motion");
    delete globalThis.matchMedia; delete window.matchMedia;
    render(null, host);
});

test("a change that lands mid-ease starts from the height the box had reached, and replaces the first animation", async () => {
    const b = box();
    const m = mount(b, "a"); await m.first;
    b.height = 200; await m.draw("b");
    assert.equal(b.running.length, 1, "the first ease is running");
    b.animated = 150;                                             // where the box has got to when the next change lands
    b.height = 260; await m.draw("c");
    assert.equal(b.calls.length, 2);
    assert.equal(b.running.length, 1, "the first was cancelled, not stacked");
    assert.deepEqual(b.calls[1].frames.map((f) => f.height), ["150px", "260px"], "from where it had reached, to the new height");
    render(null, host);
});

// --- the height it eases from is the height the box really had ---
test("a box that grew by itself between two draws eases from where it had got to, not from the height it was first drawn at", async () => {
    const seen = [];
    globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; seen.push(this); } observe() {} disconnect() {} };
    try {
        const b = box();
        const m = mount(b, "a"); await m.first;                   // drawn at 100
        b.height = 400;                                           // it opened / reflowed on its own: no render
        for (const ro of seen) ro.cb([]);                         // the browser tells the hook
        b.height = 450; await m.draw("b");                        // then its content changed
        assert.equal(b.calls.length, 1);
        assert.deepEqual(b.calls[0].frames.map((f) => f.height), ["400px", "450px"], "from 400, not from the 100 it was first drawn at (that is a fold and a re-open in one beat)");
        render(null, host);
    } finally { delete globalThis.ResizeObserver; }
});
