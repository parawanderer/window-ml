"use strict";
// One floating layer for every static tooltip. The old hidden-sibling scheme had three problems at once, and
// each was being patched per call site: its text was in the DOM so it got COPIED with the row, it was
// positioned inside the layout so any scroll ancestor CLIPPED it, and its direction was hardcoded.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";

const { installTooltipLayer } = await import("../src/sidebar/tooltip-layer.ts");

function world(html) {
    const dom = new JSDOM(`<body>${html}</body>`, { pretendToBeVisual: true });
    const { document } = dom.window;
    // jsdom has no layout: give the trigger a position so placement is computable.
    document.querySelectorAll(".tt").forEach((el, i) => {
        // The second trigger sits hard against the right edge of jsdom's 1024px window, so it must flip.
        const left = 100 + i * 800;
        el.getBoundingClientRect = () => ({ left, top: 200, width: 40, height: 16, right: left + 40, bottom: 216 });
    });
    const stop = installTooltipLayer(document, document);
    return { dom, document, stop, layer: () => document.querySelector(".tt-layer") };
}
const hover = (doc, el) => el.dispatchEvent(new doc.defaultView.Event("pointerover", { bubbles: true }));

test("the tooltip's text is NOT in the copyable DOM until hovered", () => {
    const w = world(`<div class="row">visible text<span class="tt">?<span class="tt-pop">hidden prose</span></span></div>`);
    // The source stays put (markup and existing tests are unchanged) but never renders — CSS keeps it
    // display:none, which is what stops it being selected and copied along with the row.
    assert.ok(w.document.querySelector(".tt-pop"), "the source node is still in the markup");
    assert.equal(w.layer().hidden, true, "…and nothing is shown until you hover");
    assert.equal(w.layer().textContent, "", "the layer holds no text to copy either");
    w.stop();
});

test("hovering fills the ONE layer, and leaving empties it", () => {
    const w = world(`<span class="tt">?<span class="tt-pop">the explanation</span></span>`);
    hover(w.document, w.document.querySelector(".tt"));
    assert.equal(w.layer().hidden, false);
    assert.match(w.layer().textContent, /the explanation/);
    assert.equal(w.document.querySelectorAll(".tt-layer").length, 1, "one layer, not one per tooltip");

    w.document.dispatchEvent(new w.dom.window.Event("pointerout", { bubbles: true }));
    assert.equal(w.layer().hidden, true);
    assert.equal(w.layer().textContent, "", "emptied, so its text can't be copied while idle");
    w.stop();
});

test("it is position:fixed, so no scrolling ancestor can clip it", () => {
    const w = world(`<div style="overflow:auto"><span class="tt">?<span class="tt-pop">deep inside a scroller</span></span></div>`);
    hover(w.document, w.document.querySelector(".tt"));
    // The layer is a child of the ROOT, not of the scrolling box the trigger lives in.
    assert.equal(w.layer().parentElement.tagName, "BODY", "mounted outside the clipping ancestor");
    assert.equal(w.layer().style.position || "fixed", "fixed");
    w.stop();
});

test("direction is COMPUTED: a trigger near the right edge opens leftward", () => {
    const w = world(`<span class="tt">a<span class="tt-pop">left one</span></span>`
        + `<span class="tt">b<span class="tt-pop">right one</span></span>`);
    const [near, far] = w.document.querySelectorAll(".tt");

    hover(w.document, near);
    assert.notEqual(w.layer().style.left, "auto", "room on the right → opens rightward");

    hover(w.document, far);   // this one sits at x=500 in a 1024-wide window
    assert.equal(w.layer().style.left, "auto", "near the edge → opens leftward instead of overflowing");
    assert.ok(parseFloat(w.layer().style.right) >= 0);
    w.stop();
});

test("scrolling hides it — a tooltip anchored to something that moved away is worse than none", () => {
    const w = world(`<span class="tt">?<span class="tt-pop">x</span></span>`);
    hover(w.document, w.document.querySelector(".tt"));
    assert.equal(w.layer().hidden, false);
    w.document.dispatchEvent(new w.dom.window.Event("scroll", { bubbles: true }));
    assert.equal(w.layer().hidden, true);
    w.stop();
});

test("installing twice is a no-op — one layer per root", () => {
    const w = world(`<span class="tt">?<span class="tt-pop">x</span></span>`);
    installTooltipLayer(w.document, w.document);
    assert.equal(w.document.querySelectorAll(".tt-layer").length, 1);
    w.stop();
});

// The layer shows a COPY, so a source that re-renders while the tooltip is open (the resource panel polls
// every 2s) used to leave the reader looking at a figure the panel no longer believed.
test("a shown tooltip follows its source's numbers", async () => {
    const w = world(`<span class="tt" id="key">CUDA0 19%<span class="tt-pop">18.00 GiB of 95.59 GiB (19%)</span></span>`);
    const trigger = w.document.querySelector("#key");
    hover(w.document, trigger);
    assert.match(w.layer().textContent, /\(19%\)/);

    // The panel polls and the model grows.
    trigger.querySelector(".tt-pop").textContent = "30.00 GiB of 95.59 GiB (31%)";
    await new Promise((r) => setTimeout(r, 0));   // MutationObserver delivers on a microtask
    assert.match(w.layer().textContent, /30\.00 GiB of 95\.59 GiB \(31%\)/, "the open tooltip re-copied");

    // A re-render that REPLACES the popup node, rather than editing its text, counts too — which is why the
    // observer watches the trigger and not the popup.
    trigger.innerHTML = 'CUDA0 44%<span class="tt-pop">42.00 GiB of 95.59 GiB (44%)</span>';
    await new Promise((r) => setTimeout(r, 0));
    assert.match(w.layer().textContent, /42\.00 GiB/, "…even when the .tt-pop node itself is new");

    // And it stops watching once hidden — a stale observer firing into a closed layer is a leak.
    trigger.dispatchEvent(new w.dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: w.document.body }));
    trigger.querySelector(".tt-pop").textContent = "changed while hidden";
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(w.layer().hidden, true);
    assert.equal(w.layer().textContent, "");
});

// A TIP WHOSE TRIGGER GOES AWAY GOES WITH IT. The layer hides on pointer-out, and a trigger that is REMOVED under
// a pointer that has not moved never raises one — so pressing Esc in the find bar (which unmounts its ✕) left
// "Close (Esc)" floating over the panel with nothing under it. Any tooltip whose trigger unmounts or is hidden
// while hovered had the same bug; this is the layer's job, not each call site's.
const settle = (w) => new Promise((r) => w.dom.window.setTimeout(r, 0));

test("a tip whose trigger is REMOVED while hovered is hidden", async () => {
    const w = world(`<div class="bar"><button class="tt">✕<span class="tt-pop">Close (Esc)</span></button></div>`);
    hover(w.document, w.document.querySelector(".tt"));
    assert.equal(w.layer().hidden, false);
    w.document.querySelector(".bar").remove();   // the find bar closing, with the pointer still parked
    await settle(w);
    assert.equal(w.layer().hidden, true, "no tooltip left pointing at nothing");
    assert.equal(w.layer().textContent, "");
    w.stop();
});

test("a tip whose trigger is HIDDEN while hovered is hidden", async () => {
    const w = world(`<div class="bar"><button class="tt">✕<span class="tt-pop">Close (Esc)</span></button></div>`);
    hover(w.document, w.document.querySelector(".tt"));
    w.document.querySelector(".bar").hidden = true;
    await settle(w);
    assert.equal(w.layer().hidden, true);
    w.stop();
});

test("Esc dismisses a tip without moving the pointer", () => {
    const w = world(`<span class="tt">?<span class="tt-pop">the explanation</span></span>`);
    hover(w.document, w.document.querySelector(".tt"));
    w.document.dispatchEvent(new w.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(w.layer().hidden, true);
    w.stop();
});

test("a tip whose trigger merely RE-RENDERS its text stays up", async () => {
    // The guard against over-correcting: the resource panel rewrites numbers under an open tip every poll.
    const w = world(`<span class="tt">?<span class="tt-pop">old</span></span>`);
    hover(w.document, w.document.querySelector(".tt"));
    w.document.querySelector(".tt-pop").textContent = "new";
    await settle(w);
    assert.equal(w.layer().hidden, false);
    w.stop();
});

test("the CURSOR tip is cleared when its trigger is removed, too", async () => {
    const dom = new JSDOM(`<body><div class="row">a line of code</div></body>`, { pretendToBeVisual: true });
    const g = globalThis;
    const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver };
    Object.assign(g, { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver });
    try {
        const { cursorTipOn, cursorTip } = await import("../src/sidebar/ui-kit.tsx");
        const row = dom.window.document.querySelector(".row");
        cursorTipOn("why this line").onPointerMove({ clientX: 10, clientY: 10, currentTarget: row });
        assert.equal(cursorTip.value?.text, "why this line");
        row.remove();
        await new Promise((r) => dom.window.setTimeout(r, 0));
        assert.equal(cursorTip.value, null);
    } finally { Object.assign(g, saved); }
});
