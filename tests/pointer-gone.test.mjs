// pointer-gone.test.mjs — tooltips that must not stay up after the pointer has gone (src/sidebar/pointer-gone.ts): the
// leave events the sidebar's iframe never receives, replayed when the shell says the pointer is on the page; and the
// cursor tips taken down by a scroll or a window blur, which raise no leave at all. The browser half (the shell relay,
// measured against a real iframe) is in tests/e2e/tooltips.spec.mjs.
import { test, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, act, doc, win, G, ui, layer;

before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    win = dom.window;
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.Node = win.Node;
    globalThis.getComputedStyle = win.getComputedStyle.bind(win);
    doc = win.document;
    ({ h, render } = require_("preact"));
    // `act` flushes renders AND effects, so a tip's listeners exist when the next line acts: no timer to guess.
    ({ act } = require_("preact/test-utils"));
    G = await import("../src/sidebar/pointer-gone.ts");
    ui = await import("../src/sidebar/ui-kit.tsx");
    layer = await import("../src/sidebar/tooltip-layer.ts");
});

const ev = (type, init = {}) => new win.MouseEvent(type, { bubbles: true, composed: true, ...init });

// --- replaying the leaves the iframe never got ---

test("the pointer coming in is reported once per crossing, and the replay is a no-op when it was not here", () => {
    const host = doc.createElement("div");
    doc.body.append(host);
    let ins = 0;
    const stop = G.trackPointer(doc, () => ins++);
    host.dispatchEvent(ev("pointerover"));
    host.dispatchEvent(ev("pointermove"));
    host.dispatchEvent(ev("pointermove"));
    assert.equal(ins, 1, "one message in, however many moves");
    G.pointerGone();
    G.pointerGone();
    host.dispatchEvent(ev("pointermove"));
    assert.equal(ins, 2, "back in after it was gone: one more");
    G.pointerGone();
    stop();
    host.remove();
});

test("the replay reaches the hovered element and every ancestor, through a shadow root, innermost first", () => {
    const outer = doc.createElement("section");
    const shadowHost = doc.createElement("div");
    outer.append(shadowHost);
    doc.body.append(outer);
    const sr = shadowHost.attachShadow({ mode: "open" });
    const inner = doc.createElement("span");
    sr.append(inner);
    const leaves = [], outs = [];
    for (const [name, el] of [["inner", inner], ["host", shadowHost], ["outer", outer], ["body", doc.body]]) {
        el.addEventListener("pointerleave", () => leaves.push(name));
    }
    doc.addEventListener("pointerout", (e) => outs.push(e.relatedTarget), true);
    const stop = G.trackPointer(doc, () => {});
    inner.dispatchEvent(ev("pointermove"));
    G.pointerGone();
    assert.deepEqual(leaves.slice(0, 4), ["inner", "host", "outer", "body"]);
    assert.deepEqual(outs, [null], "one pointerout, going nowhere: the layer reads that as leaving");
    stop();
    outer.remove();
});

test("an element that left the page meanwhile gets nothing replayed on it", () => {
    const el = doc.createElement("div");
    doc.body.append(el);
    let left = 0;
    el.addEventListener("pointerleave", () => left++);
    const stop = G.trackPointer(doc, () => {});
    el.dispatchEvent(ev("pointermove"));
    el.remove();
    G.pointerGone();
    assert.equal(left, 0);
    stop();
});

// --- each kind of tip, taken down by the replay ---

test("the anchored layer's tip goes on the replay", () => {
    doc.body.insertAdjacentHTML("beforeend", `<span class="tt" id="badge">?<span class="tt-pop">prose</span></span>`);
    const t = doc.getElementById("badge");
    t.getBoundingClientRect = () => ({ left: 100, top: 200, width: 40, height: 16, right: 140, bottom: 216 });
    const stopLayer = layer.installTooltipLayer(doc, doc);
    const stop = G.trackPointer(doc, () => {});
    t.dispatchEvent(ev("pointerover"));
    assert.equal(doc.querySelector(".tt-layer").hidden, false, "shown");
    G.pointerGone();
    assert.equal(doc.querySelector(".tt-layer").hidden, true, "gone");
    stop(); stopLayer(); t.remove();
});

const mountCursorTip = async () => {
    const host = doc.getElementById("root");
    await act(() => { render(null, host); render(h("div", null, h("span", { id: "trigger", ...ui.cursorTipOn("what this is") }, "x"), h(ui.CursorTipLayer, null)), host); });
    const t = doc.getElementById("trigger");
    const show = () => act(() => { t.dispatchEvent(ev("pointermove", { clientX: 50, clientY: 50 })); });
    return { t, show, tip: () => doc.querySelector(".cursor-tip") };
};

test("the cursor tip goes on the replay", async () => {
    const c = await mountCursorTip();
    const stop = G.trackPointer(doc, () => {});
    await c.show();
    assert.ok(c.tip(), "shown");
    await act(() => G.pointerGone());
    assert.equal(c.tip(), null, "gone");
    stop();
});

// --- what raises no leave even in a browser that sends them ---

test("the cursor tip goes when anything scrolls, and when the window loses focus", async () => {
    const c = await mountCursorTip();
    await c.show();
    assert.ok(c.tip());
    await act(() => { doc.body.dispatchEvent(new win.Event("scroll")); });
    assert.equal(c.tip(), null, "a scroll moves the content out from under a still pointer");
    await c.show();
    assert.ok(c.tip());
    await act(() => { win.dispatchEvent(new win.Event("blur")); });
    assert.equal(c.tip(), null, "another window or tab took focus");
    // Down means the listeners are gone too: a later scroll with no tip up does nothing.
    doc.body.dispatchEvent(new win.Event("scroll"));
});

// A scroll is a reason to look, not to hide: the scroll that brings a trigger into view can land a frame AFTER the
// pointer did (Playwright's hover does exactly that, and so can a person), and hiding on it took down the tip that had
// just been raised. The tip stays while its trigger is still what the pointer is on.
test("a scroll that leaves the trigger under the pointer keeps the tip; one that moves something else there does not", async () => {
    const c = await mountCursorTip();
    const real = doc.elementFromPoint;
    try {
        doc.elementFromPoint = () => c.t;
        await c.show();
        await act(() => { doc.body.dispatchEvent(new win.Event("scroll")); });
        assert.ok(c.tip(), "still on its trigger: the tip stays");
        doc.elementFromPoint = () => doc.body;
        await act(() => { doc.body.dispatchEvent(new win.Event("scroll")); });
        assert.equal(c.tip(), null, "something else slid under the pointer: gone");
    } finally { doc.elementFromPoint = real; }
});

test("uninstalling the anchored layer removes its window blur listener", () => {
    const added = [], removed = [];
    const add = win.addEventListener, rem = win.removeEventListener;
    win.addEventListener = function (t, f, o) { if (t === "blur") added.push(f); return add.call(this, t, f, o); };
    win.removeEventListener = function (t, f, o) { if (t === "blur") removed.push(f); return rem.call(this, t, f, o); };
    try {
        const d2 = new JSDOM("<body></body>").window.document;
        Object.defineProperty(d2, "defaultView", { value: win });
        const stop = layer.installTooltipLayer(d2, d2);
        stop();
        assert.equal(added.length, 1);
        assert.deepEqual(removed, added, "the same function, so it is really gone");
    } finally { win.addEventListener = add; win.removeEventListener = rem; }
});
