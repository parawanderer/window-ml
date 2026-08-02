// Pure dom.ts helpers.
import { test } from "node:test";
import assert from "node:assert";
import { elementReference, classifyOverlay } from "../dom.ts";

test("elementReference: a plain path → document.querySelector('…')", () => {
    assert.equal(elementReference("body > div#main > button.foo"),
        "document.querySelector('body > div#main > button.foo')");
});

test("elementReference: a non-zero index → querySelectorAll(...)[i]; index 0 → querySelector", () => {
    assert.equal(elementReference(".card", 2), "document.querySelectorAll('.card')[2]");
    assert.equal(elementReference(".card", 0), "document.querySelector('.card')");   // first match
    assert.equal(elementReference(".card"), "document.querySelector('.card')");
});

test("elementReference: single quotes + backslash CSS-escapes survive into a valid JS string literal", () => {
    // A Tailwind path with a CSS `\/` escape — the backslash must be doubled for the JS literal so the
    // pasted line's querySelector receives the original single backslash.
    assert.equal(elementReference("button.p-2\\/3"), "document.querySelector('button.p-2\\\\/3')");
    // A single quote in the path is backslash-escaped.
    assert.equal(elementReference("a[data-x='y']"), "document.querySelector('a[data-x=\\'y\\']')");
    // Sanity: the emitted string literal, when parsed as JS, round-trips to the original path.
    const out = elementReference("button.p-2\\/3");
    const literal = out.slice("document.querySelector(".length, -1);   // the '…' part
    assert.equal(eval(literal), "button.p-2\\/3");   // eslint-disable-line no-eval — trusted, our own output
});

test("classifyOverlay: a rect whose top is invariant across a scroll is PINNED (fixed / stuck sticky)", () => {
    const vh = 800;
    // Fixed header: top stays 0 as we scroll from 0 → vh; centre (0+30) is in the top half → header.
    assert.deepEqual(classifyOverlay({ top: 0, height: 60 }, { top: 0 }, vh), { pinned: true, anchor: "top" });
    // Fixed footer: top pinned near the viewport bottom; centre (760+20) is in the bottom half → footer.
    assert.deepEqual(classifyOverlay({ top: 760, height: 40 }, { top: 760 }, vh), { pinned: true, anchor: "bottom" });
    // A ≤2px jitter still counts as pinned (sub-pixel rounding between two paints).
    assert.equal(classifyOverlay({ top: 0, height: 50 }, { top: 1.4 }, vh).pinned, true);
});

test("classifyOverlay: an element that MOVES with the scroll is NOT pinned (in-flow / unstuck sticky)", () => {
    const vh = 800;
    // Its viewport top dropped by ~vh as the page scrolled up under it → it scrolls with content.
    assert.equal(classifyOverlay({ top: 500, height: 40 }, { top: -300 }, vh).pinned, false);
    // Exactly on the 2px threshold boundary is NOT pinned (strict <2).
    assert.equal(classifyOverlay({ top: 100, height: 20 }, { top: 102 }, vh).pinned, false);
});
