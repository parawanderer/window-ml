// shell-shot.test.mjs — the shell's side of keeping the extension's UI out of a screenshot (src/sidebar/shell-shot.ts):
// the page's hide handshake, now bounded, and the read-only rect report the worker masks with, answered for the worker
// alone. The rects are read from fake elements here; that the real shell's rects cover the real sidebar's pixels is
// tests/e2e/worker-shot.spec.mjs.

import test from "node:test";
import assert from "node:assert/strict";

const frames = [];   // requestAnimationFrame callbacks waiting for the next frame
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.chrome = { runtime: { id: "ext-id" } };
const pageIframes = [];
globalThis.document = { querySelectorAll: (sel) => (sel === "iframe" ? pageIframes : []) };
globalThis.window = { innerWidth: 1000, innerHeight: 700 };
globalThis.getComputedStyle = (el) => ({ visibility: el.visibility ?? "visible" });
/** Run one frame's callbacks. */
const frame = () => { for (const fn of frames.splice(0)) fn(); };

const { pageShotGate, extensionRects, answerShotRects, fromWorker, PAGE_SHOT_HOLD_MS } = await import("../src/sidebar/shell-shot.ts");

const WORKER = { id: "ext-id" };   // a chrome.tabs.sendMessage from the worker: this extension, no tab
const PAGE_TAB = { id: "ext-id", tab: { id: 3 }, url: "chrome-extension://ext-id/sidebar.html", frameId: 5 };   // the extension's own frame IN a tab

// --- the page's own hide handshake ---

/** A gate over a surface that records whether it is hidden. */
function gate(holdMs) {
    frames.length = 0;
    const surface = { hidden: false, hide() { this.hidden = true; }, show() { this.hidden = false; } };
    return { surface, gate: pageShotGate(surface, holdMs) };
}

test("the page's handshake: hide, the ack after two frames, show restores", () => {
    const { surface, gate: g } = gate();
    let acked = 0;
    g.pageHide(() => acked++);
    assert.equal(surface.hidden, true);
    frame();
    assert.equal(acked, 0, "one frame is not enough: the hidden state may not have painted");
    frame();
    assert.equal(acked, 1);
    g.pageShow();
    assert.equal(surface.hidden, false);
});

test("the page's hide ends on its own when no show comes, so a page cannot keep the sidebar and the approval card hidden", async () => {
    assert.ok(PAGE_SHOT_HOLD_MS <= 5000, "a few seconds, past an honest page-hosted capture");
    const { surface, gate: g } = gate(40);
    g.pageHide(() => {});
    assert.equal(surface.hidden, true);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(surface.hidden, false);
    // A second hide restarts the bound rather than stacking timers that lift a later hide early.
    g.pageHide(() => {});
    await new Promise((r) => setTimeout(r, 25));
    g.pageHide(() => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(surface.hidden, true, "the second hide's own bound has not run out");
});

// --- the rects the worker masks ---

/** A fake element: a viewport rect, an id, and the ancestors `closest` finds. */
const el = (rect, { id = "", tag = "DIV", within = [], visibility } = {}) => ({
    tagName: tag, id, visibility,
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3], right: rect[0] + rect[2], bottom: rect[1] + rect[3] }),
    closest: (sel) => (id === sel.slice(1) || within.includes(sel.slice(1)) ? {} : null),   // like the real one, the element itself first
});
const host = (children, connected = true) => ({ isConnected: connected, shadowRoot: { querySelectorAll: () => children } });
const roots = (hosts) => ({ hosts, lightboxId: "ml-lightbox", highlightId: "ml-highlight", extensionOrigin: "chrome-extension://ext-id/" });

test("every painted element in the shell's shadow roots is reported in viewport px, with its surface; style elements, hidden and empty ones are not", () => {
    const sidebar = host([el([0, 0, 0, 0], { tag: "STYLE" }), el([700, 0, 300, 700]), el([690, 300, 10, 40]), el([0, 0, 0, 0]), el([5, 5, 50, 50], { visibility: "hidden" })]);
    const card = host([el([20, 500, 200, 150])]);
    const out = extensionRects(roots([{ host: sidebar, kind: "sidebar" }, { host: card, kind: "card" }, { host: null, kind: "highlight" }, { host: host([el([1, 1, 1, 1])], false), kind: "card" }]));
    assert.equal(out.vw, 1000); assert.equal(out.vh, 700);
    assert.deepEqual(out.rects, [
        { x: 700, y: 0, w: 300, h: 700, kind: "sidebar" },
        { x: 690, y: 300, w: 10, h: 40, kind: "sidebar" },
        { x: 20, y: 500, w: 200, h: 150, kind: "card" },
    ]);
});

test("the image viewer is reported as such, wherever it is mounted, so a refusal can name it", () => {
    const card = host([el([0, 0, 1000, 700], { id: "ml-lightbox" }), el([400, 100, 200, 300], { tag: "IMG", within: ["ml-lightbox"] })]);
    assert.deepEqual(extensionRects(roots([{ host: card, kind: "card" }])).rects.map((r) => r.kind), ["lightbox", "lightbox"]);
});

test("the hover highlight is four strips round the element it outlines, never the element itself; its label is a box", () => {
    const hl = host([el([100, 200, 50, 20], { id: "ml-highlight" }), el([100, 222, 60, 14], { within: ["ml-highlight"] })]);
    const rects = extensionRects(roots([{ host: hl, kind: "highlight" }])).rects;
    assert.deepEqual(rects, [
        { x: 96, y: 196, w: 58, h: 8, kind: "highlight" },
        { x: 96, y: 216, w: 58, h: 8, kind: "highlight" },
        { x: 96, y: 196, w: 8, h: 28, kind: "highlight" },
        { x: 146, y: 196, w: 8, h: 28, kind: "highlight" },
        { x: 100, y: 222, w: 60, h: 14, kind: "highlight" },
    ]);
    const inside = (x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    assert.equal(inside(125, 210), false, "the outlined element's middle is left alone");
});

test("a frame of the extension's own pages that the page embedded itself is reported; another site's frame is not", () => {
    pageIframes.push({ src: "chrome-extension://ext-id/sidebar.html", getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }) },
        { src: "https://ads.example/", getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }) });
    try { assert.deepEqual(extensionRects(roots([])).rects, [{ x: 0, y: 0, w: 300, h: 200, kind: "frame" }]); }
    finally { pageIframes.length = 0; }
});

test("past 400 rects, each surface's rects are merged into their bounding box rather than sent without bound", () => {
    const many = host(Array.from({ length: 500 }, (_, i) => el([i, i, 2, 2])));
    assert.deepEqual(extensionRects(roots([{ host: many, kind: "card" }])).rects, [{ x: 0, y: 0, w: 501, h: 501, kind: "card" }]);
});

test("the rect report is answered for the worker only: a sender with a tab, another extension or none gets nothing", () => {
    const r = () => roots([{ host: host([el([0, 0, 10, 10])]), kind: "card" }]);
    let got = null;
    assert.equal(answerShotRects(WORKER, r, (x) => { got = x; }), true);
    assert.equal(got.rects.length, 1);
    for (const sender of [PAGE_TAB, { id: "other-ext" }, { id: "other-ext", tab: { id: 3 } }, { tab: { id: 3 } }, undefined, {}]) {
        assert.equal(answerShotRects(sender, r, () => assert.fail(`answered ${JSON.stringify(sender)}`)), false);
    }
    assert.equal(fromWorker(WORKER), true);
});

// --- what the page can do to the UI that the rects alone would not show (tampered / restyled), and the shot's watch ---

const { filterReach, beginWatch, endWatch, sheetText } = await import("../src/sidebar/shell-shot.ts");

/** Run `fn` with a document whose root element has the computed style `rootCs`, and a getComputedStyle reading each fake
 *  element's own `cs` (CSS property names), so the checks see what a page's styles would make them see. */
function withStyles(fn, rootCs = {}) {
    const docEl = { cs: rootCs };
    const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
    globalThis.document = { documentElement: docEl, querySelectorAll: () => [] };
    globalThis.getComputedStyle = (e) => { const cs = { visibility: e.visibility ?? "visible", ...(e.cs ?? {}) }; return { ...cs, getPropertyValue: (n) => cs[n] ?? "" }; };
    try { return fn(docEl); } finally { Object.assign(globalThis, saved); }
}
/** A fake element with a computed style. */
const sel = (rect, cs = {}, extra = {}) => Object.assign(el(rect, extra), { cs });
/** A fake host mounted on `docEl`, its root holding `children` and `style` (our <style>) plus any `extraStyles`. */
const mounted = (docEl, children, { style = { tagName: "STYLE" }, extraStyles = [], adopted = [], hostCs = {} } = {}) => {
    const root = { adoptedStyleSheets: adopted, querySelectorAll: (q) => (q === "style, link" ? [style, ...extraStyles] : [style, ...extraStyles, ...children]) };
    return { host: { isConnected: true, parentNode: docEl, shadowRoot: root, cs: hostCs }, root, style };
};

test("an answer is `tampered` when the page has moved a host off the root element, put a stylesheet of its own into a root (an element or an adopted sheet), or given the UI a reflection, a filter or a text shadow", () => {
    withStyles((docEl) => {
        const clean = mounted(docEl, [sel([700, 0, 300, 700])]);
        assert.equal(extensionRects(roots([{ host: clean.host, kind: "sidebar", root: clean.root, style: clean.style }])).tampered, undefined, "the shell's own mount is not tampered");
        const cases = {
            "a host moved into another element (a frame of the page's, its own shadow root)": () => { const m = mounted(docEl, [sel([0, 0, 10, 10])]); m.host.parentNode = {}; return m; },
            "a <style> of the page's in our root": () => mounted(docEl, [sel([0, 0, 10, 10])], { extraStyles: [{ tagName: "STYLE" }] }),
            "a <link> stylesheet in our root": () => mounted(docEl, [sel([0, 0, 10, 10])], { extraStyles: [{ tagName: "LINK" }] }),
            "an adopted stylesheet": () => mounted(docEl, [sel([0, 0, 10, 10])], { adopted: [{}] }),
            "a reflection on our element": () => mounted(docEl, [sel([0, 0, 10, 10], { "-webkit-box-reflect": "left 0px" })]),
            "a filter on our element": () => mounted(docEl, [sel([0, 0, 10, 10], { filter: "blur(100px)" })]),
            "a text shadow on our element": () => mounted(docEl, [sel([0, 0, 10, 10], { "text-shadow": "rgb(0, 0, 0) -500px 0px 0px" })]),
            "a filter on our host": () => mounted(docEl, [sel([0, 0, 10, 10])], { hostCs: { filter: "drop-shadow(rgb(0, 0, 0) 0px 0px 0px)" } }),
        };
        for (const [what, make] of Object.entries(cases)) {
            const m = make();
            assert.equal(extensionRects(roots([{ host: m.host, kind: "sidebar", root: m.root, style: m.style }])).tampered, true, what);
        }
    });
});

test("a rule of the shell's own stylesheet the page edited through the CSSOM (no DOM mutation) is `tampered`; the sheet as mounted is not", () => {
    withStyles((docEl) => {
        const rules = [{ cssText: "#ml-sb-host { position: fixed; }" }];
        const style = { tagName: "STYLE", sheet: { cssRules: rules } };
        const m = mounted(docEl, [sel([0, 0, 10, 10])], { style });
        const at = sheetText(style);
        const ask = () => extensionRects(roots([{ host: m.host, kind: "sidebar", root: m.root, style, sheet: at }]));
        assert.equal(ask().tampered, undefined);
        rules.push({ cssText: "#ml-sb-host { filter: blur(100px); }" });
        assert.equal(ask().tampered, true, "an inserted rule");
        rules.pop(); rules[0] = { cssText: "#ml-sb-host { position: fixed; translate: -300px; }" };
        assert.equal(ask().tampered, true, "an edited rule");
    });
});

test("an element the shell made, carried by the page out of every root it mounted, is `tampered`: nothing measures it there", () => {
    withStyles((docEl) => {
        const m = mounted(docEl, [sel([0, 0, 10, 10])]);
        const inRoot = { isConnected: true, getRootNode: () => m.root }, carried = { isConnected: true, getRootNode: () => globalThis.document }, gone = { isConnected: false, getRootNode: () => ({}) };
        const ask = (owned) => extensionRects({ ...roots([{ host: m.host, kind: "sidebar", root: m.root, style: m.style }]), owned }).tampered;
        assert.equal(ask([inRoot, gone, null]), undefined);
        assert.equal(ask([inRoot, carried]), true);
    });
});

test("a filter on the root element is bounded round every rect (a blur's 3 sigma, a drop shadow's offset and blur); a reflection or an SVG filter there is `tampered`", () => {
    assert.equal(filterReach("blur(10px)"), 30);
    assert.equal(filterReach("drop-shadow(rgb(0, 0, 0) -300px 4px 2px)"), 310);
    assert.equal(filterReach("invert(1) hue-rotate(180deg)"), 0);
    assert.equal(filterReach("blur(2px) drop-shadow(rgba(0, 0, 0, 0.5) 1px 1px 0px)"), 8);
    withStyles((docEl) => {
        const m = mounted(docEl, [sel([700, 0, 300, 700])]);
        assert.deepEqual(extensionRects(roots([{ host: m.host, kind: "sidebar", root: m.root, style: m.style }])).rects, [{ x: 400, y: -300, w: 900, h: 1300, kind: "sidebar" }]);
    }, { filter: "drop-shadow(rgb(0, 0, 0) -300px 0px 0px)" });
    for (const rootCs of [{ "-webkit-box-reflect": "below 0px" }, { filter: "url(\"#f\")" }]) {
        withStyles((docEl) => {
            const m = mounted(docEl, [sel([700, 0, 300, 700])]);
            assert.equal(extensionRects(roots([{ host: m.host, kind: "sidebar", root: m.root, style: m.style }])).tampered, true, JSON.stringify(rootCs));
        }, rootCs);
    }
});

test("`restyled` when the page sized or moved our host or an element (zoom, scale, translate, rotate, a host transform), or zoomed the root element; our own styles never are", () => {
    for (const [cs, onHost, rootCs] of [[{ zoom: "4" }, true], [{ transform: "matrix(2, 0, 0, 2, 0, 0)" }, true], [{ translate: "-300px" }, false], [{ scale: "2" }, false], [{ rotate: "5deg" }, false], [{}, false, { zoom: "1.5" }]]) {
        withStyles((docEl) => {
            const m = mounted(docEl, [sel([0, 0, 10, 10], onHost ? {} : cs)], { hostCs: onHost ? cs : {} });
            const out = extensionRects(roots([{ host: m.host, kind: "sidebar", root: m.root, style: m.style }]));
            assert.equal(out.restyled, true, JSON.stringify(cs));
            assert.equal(out.tampered, undefined);
        }, rootCs);
    }
    withStyles((docEl) => {
        const m = mounted(docEl, [sel([0, 0, 10, 10], { transform: "matrix(1, 0, 0, 1, 18, 0)", zoom: "1" })]);
        assert.equal(extensionRects(roots([{ host: m.host, kind: "sidebar", root: m.root, style: m.style }])).restyled, undefined, "a transform inside the root is the shell's own (the slide-in)");
    });
});

test("the highlight's band reaches its outline wherever its offset puts it, and its box shadow at the largest any running animation takes it (the approval pulse), not only at the instant read", () => {
    withStyles((docEl) => {
        const strips = (cs, anims = []) => {
            const hl = Object.assign(sel([100, 200, 50, 20], cs, { id: "ml-highlight" }), { getAnimations: () => anims.map((frames) => ({ effect: { getKeyframes: () => frames } })) });
            const m = mounted(docEl, [hl]);
            return extensionRects(roots([{ host: m.host, kind: "highlight", root: m.root, style: m.style }])).rects;
        };
        const covers = (rects, x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
        // An outline 1 px wide, 40 px out: its ring runs at 40-41 px past each edge.
        const off = strips({ "outline-style": "solid", "outline-width": "1px", "outline-offset": "40px" });
        for (const [x, y] of [[125, 200 - 41], [125, 220 + 40.5], [100 - 40.5, 210], [150 + 40.5, 210]]) assert.ok(covers(off, x, y), `ring at ${x},${y}`);
        assert.ok(!covers(off, 125, 210), "the outlined element's middle is still left alone");
        // A negative offset draws the outline inside the box: the band reaches in that far.
        const inner = strips({ "outline-style": "solid", "outline-width": "3px", "outline-offset": "-12px" });
        assert.ok(covers(inner, 125, 200 + 11) && covers(inner, 100 + 11, 210) && covers(inner, 150 - 11, 210), "an inset outline (9-12 px inside) is inside the band");
        // The pulse: read at its rest (no shadow), its keyframes go out to 13 px.
        const pulse = strips({ "outline-style": "solid", "outline-width": "3px", "box-shadow": "rgba(34, 197, 94, 0.6) 0px 0px 0px 0px" },
            [[{ boxShadow: "0 0 0 0 rgba(34, 197, 94, .6)" }, { boxShadow: "0 0 0 13px rgba(34, 197, 94, 0)" }, { boxShadow: "0 0 0 0 rgba(34, 197, 94, .6)" }]]);
        assert.ok(covers(pulse, 125, 200 - 3 - 13 + 0.5), "the pulse's furthest reach above the box");
        assert.ok(covers(pulse, 150 + 3 + 13 - 0.5, 210), "and to its right");
    });
});

test("a shot's watch reports every place the UI was seen from its begin to its end, `moved` when it was ever elsewhere, and an end after the watch ran out is unreadable", async () => {
    const saved = { requestAnimationFrame: globalThis.requestAnimationFrame };
    const ticks = [];
    globalThis.requestAnimationFrame = (fn) => { ticks.push(fn); return ticks.length; };   // frames run when the test says
    const frameNow = () => { for (const fn of ticks.splice(0)) fn(); };
    try {
        let x = 700;
        const panel = { tagName: "DIV", id: "", getBoundingClientRect: () => ({ left: x, top: 0, width: 300, height: 700, right: x + 300, bottom: 700 }), closest: () => null };
        const r = () => roots([{ host: host([panel]), kind: "sidebar" }]);
        const begin = beginWatch("s1", r);
        assert.deepEqual(begin.rects, [{ x: 700, y: 0, w: 300, h: 700, kind: "sidebar" }]);
        const still = endWatch("s1", r);
        assert.equal(still.moved, undefined);
        assert.deepEqual(still.rects, begin.rects);
        // The UI somewhere else at the end than at the begin.
        beginWatch("s2", r);
        x = 100;
        endWatch("unknown-id", r);   // an id with no watch answers a read alone and touches no other watch
        const mid = endWatch("s2", r);
        assert.equal(mid.moved, true);
        x = 700;
        beginWatch("s3", r);
        x = 100;
        const seen = endWatch("s3", r);
        assert.deepEqual(seen.rects.map((q) => q.x).sort((a, b) => a - b), [100, 700], "both places are masked");
        // A move the page makes and undoes between the begin and the end, seen only by a read on a frame in between.
        x = 700;
        beginWatch("s6", r);
        x = 100;
        frameNow();
        x = 700;
        const between = endWatch("s6", r);
        assert.equal(between.moved, true, "the frame's read saw it elsewhere");
        assert.deepEqual(between.rects.map((q) => q.x).sort((a, b) => a - b), [100, 700], "and where it was is masked");
        beginWatch("s4", r, 20);
        await new Promise((res) => setTimeout(res, 50));
        assert.equal(endWatch("s4", r).vw, 0, "a watch that ran out is answered unreadable, not with the end's read alone");
        // A begin is answered only once two frames have run under the watch (the screen then holds nothing painted before
        // it), and an end at once.
        let begun = 0;
        answerShotRects(WORKER, r, () => { begun++; }, { watch: "begin", id: "s7" });
        assert.equal(begun, 0, "not before any frame");
        frameNow();
        assert.equal(begun, 0, "not after one");
        frameNow();
        assert.equal(begun, 1, "after the second");
        endWatch("s7", r);
        // Over the worker's channel, with the ids.
        let got = null;
        answerShotRects(WORKER, r, (a) => { got = a; }, { watch: "begin", id: "s5" });
        x = 300;
        answerShotRects(WORKER, r, (a) => { got = a; }, { watch: "end", id: "s5" });
        assert.equal(got.moved, true);
    } finally { Object.assign(globalThis, saved); }
});
