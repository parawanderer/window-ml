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
