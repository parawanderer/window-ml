// json-tree-strings.test.mjs — a string in the JSON tree: cut when long, with the full text a click away; and the hover card
// that reads one with escapes in it, with its timing and placement.

import { test, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, JsonNode, JT_STR_CUT, hasEscapes, cutString, HoverCard, placeCard, lineAt, doc, host, win;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    win = dom.window; doc = win.document;
    Object.assign(globalThis, { window: win, document: doc, Node: win.Node, NodeFilter: win.NodeFilter });
    globalThis.getComputedStyle = win.getComputedStyle.bind(win);
    host = doc.getElementById("root");
    ({ h, render } = require_("preact"));
    ({ JsonNode, JT_STR_CUT, hasEscapes, cutString } = await import("../src/sidebar/transcript/json-tree.tsx"));
    ({ HoverCard, placeCard, lineAt } = await import("../src/sidebar/hover-card.tsx"));
});
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: false }));
const LONG = "x".repeat(720);   // three times JT_STR_CUT (240), spelled out: the constant is not loaded yet here

// --- which strings are worth a card, and how a long one is cut ---
test("the cut length the tests assume is the tree's", () => { assert.equal(JT_STR_CUT * 3, LONG.length); });

test("hasEscapes is true for a control character and false for everything the JSON text shows as is", () => {
    for (const s of ["a\nb", "tab\there", "cr\r", "nul\u0000", "bell\u0007", "line sep"]) assert.equal(hasEscapes(s), true, JSON.stringify(s));
    for (const s of ["", "plain", "quote \" and back\\slash", "unicode é 漢字 🙂", "spaces   only"]) assert.equal(hasEscapes(s), false, JSON.stringify(s));
});

test("cutString leaves the quote open, keeps the escapes of what it keeps, and never splits a surrogate pair", () => {
    assert.equal(cutString("abcdef", 3), '"abc');
    assert.equal(cutString("a\nbcdef", 3), '"a\\nb', "three characters, the newline written as the JSON does");
    assert.equal(cutString("short", 240), '"short', "nothing to cut: all of it, still open");
    const pair = "ab🙂cd";                                  // 🙂 is two UTF-16 units, at 2 and 3
    assert.equal(cutString(pair, 3), '"ab', "a cut between the halves backs up before the pair");
    assert.equal(cutString(pair, 4), '"ab🙂');
});

// --- the tree's string row ---
const mountTree = async (v, props = {}) => { render(null, host); render(h(JsonNode, { v, defaultOpen: true, ...props }), host); await wait(); return host; };
const leaf = () => host.querySelector(".jt-val");
const more = () => host.querySelector("button.jt-more");

test("a long string is cut with the count to show all; a short one is not", async () => {
    await mountTree({ k: LONG });
    assert.ok(leaf().textContent.endsWith("…"), "cut with an ellipsis");
    assert.ok(leaf().textContent.length < JT_STR_CUT + 10, "and short");
    assert.match(more().textContent, new RegExp(`^show all ${LONG.length.toLocaleString()} chars$`));
    await mountTree({ k: "short" });
    assert.equal(more(), null, "a short string has nothing to expand");
    assert.equal(leaf().textContent, '"short"');
});

test("show all draws the whole string, show less cuts it again, and the button says which", async () => {
    await mountTree({ k: LONG });
    more().click(); await wait();
    assert.equal(leaf().textContent, JSON.stringify(LONG), "all of it, quotes and all");
    assert.equal(more().textContent, "show less");
    assert.equal(more().getAttribute("aria-expanded"), "true");
    more().click(); await wait();
    assert.ok(leaf().textContent.endsWith("…"));
    assert.equal(more().getAttribute("aria-expanded"), "false");
});

test("folding the container a string is in, and opening it again, starts the string cut", async () => {
    await mountTree({ inner: { k: LONG } });
    const inner = () => host.querySelectorAll(".jt-branch")[1];
    inner().click(); await wait();                                // a container below the root starts folded: open it
    more().click(); await wait();
    assert.equal(leaf().textContent, JSON.stringify(LONG), "expanded");
    inner().click(); await wait();                                // fold the object holding it
    assert.equal(host.querySelector(".jt-val"), null, "folded: the string is not drawn");
    inner().click(); await wait();                                // open it again
    assert.ok(leaf().textContent.endsWith("…"), "opened again: cut");
    assert.match(more().textContent, /^show all/);
});

test("allOpen (the raw In view, which Ctrl+F reads) never cuts a string", async () => {
    await mountTree({ k: LONG }, { allOpen: true });
    assert.equal(leaf().textContent, JSON.stringify(LONG));
    assert.equal(more(), null);
});

test("a cut string keeps its comma after the ellipsis, and a click on the button does not fold the row", async () => {
    await mountTree({ a: LONG, b: 1 });
    const a = host.querySelectorAll(".jt-row")[1];
    assert.ok(/…,$/.test(leaf().textContent), `the comma follows the cut: ${leaf().textContent.slice(-6)}`);
    const rowsBefore = host.querySelectorAll(".jt-row").length;
    more().click(); await wait();
    assert.equal(host.querySelectorAll(".jt-row").length, rowsBefore, "expanding a string leaves the tree's rows as they were");
    assert.ok(a);
});

test("a string with something hidden from its row is a hover card, and one that shows all of itself is not", async () => {
    await mountTree({ plain: "no escapes", multi: "line one\nline two\tTabbed", long: LONG });
    const triggers = [...host.querySelectorAll(".hc")];
    assert.equal(triggers.length, 2, "the string with escapes and the cut one; the short plain one has nothing to reveal");
    assert.match(triggers[0].textContent, /line one\\nline two\\tTabbed/, "the row still shows the escapes, as the JSON does");
    assert.ok(triggers[1].textContent.endsWith("…"), "the cut one is the second");
    more().click(); await wait();                                  // expanded: the row shows all of it already
    assert.equal(host.querySelectorAll(".hc").length, 1, "once it is all there, the card has nothing to add");
    more().click(); await wait();
    assert.equal(host.querySelectorAll(".hc").length, 2, "and cut again, it has");
});

// --- the hover card's timing ---
const card = (el) => el.querySelector(".hc-card");
const mountCard = async (inMs = 30, outMs = 60) => {
    render(null, host);
    render(h("div", null, h(HoverCard, { card: h("pre", { class: "hc-text" }, "a\nb"), inMs, outMs }, "trigger")), host);
    await wait(10);
    return host.querySelector(".hc");
};

test("the card waits for the pointer to rest, and a pass across the trigger opens nothing", async () => {
    const t = await mountCard();
    fire(t, "pointerenter"); await wait(10); fire(t, "pointerleave");
    await wait(80);
    assert.equal(card(t), null, "left before the delay: never opened");
    assert.ok(!t.classList.contains("hc-on"));
    fire(t, "pointerenter"); await wait(70);
    assert.ok(card(t), "rested: opened");
    assert.ok(t.classList.contains("hc-on"), "and the trigger is marked for the highlight");
    assert.equal(card(t).textContent, "a\nb");
});

test("the card stays while the pointer is in it, and closes a moment after it leaves both", async () => {
    const t = await mountCard();
    fire(t, "pointerenter"); await wait(70);
    assert.ok(card(t));
    fire(t, "pointerleave"); await wait(20);                      // out of the trigger, on the way to the card
    fire(t, "pointerenter"); await wait(100);                     // into the card (a descendant: the trigger is entered again)
    assert.ok(card(t), "kept open: the pointer came back within the delay");
    fire(t, "pointerleave"); await wait(120);
    assert.equal(card(t), null, "closed after the delay");
    assert.ok(!t.classList.contains("hc-on"));
});

test("Escape closes the card at once, and a touch pointer never opens it", async () => {
    const t = await mountCard();
    fire(t, "pointerenter"); await wait(70);
    assert.ok(card(t));
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(10);
    assert.equal(card(t), null);
    const touch = new win.Event("pointerenter"); touch.pointerType = "touch";
    t.dispatchEvent(touch); await wait(80);
    assert.equal(card(t), null, "no hover on a touch screen");
});

// --- where the card goes ---
test("placeCard: below the trigger when it fits, above when there is more room there, and never past an edge", () => {
    const view = { w: 800, h: 600 };
    assert.deepEqual(placeCard({ left: 100, top: 100, bottom: 120 }, { w: 300, h: 200 }, view), { left: 100, top: 124 }, "fits below");
    const above = placeCard({ left: 100, top: 500, bottom: 520 }, { w: 300, h: 240 }, view);
    assert.equal(above.top, 500 - 4 - 240, "no room below, more above: above, flush to the trigger");
    assert.equal(placeCard({ left: 700, top: 100, bottom: 120 }, { w: 300, h: 100 }, view).left, 800 - 300 - 8, "shifted left off the right edge");
    assert.equal(placeCard({ left: -50, top: 100, bottom: 120 }, { w: 300, h: 100 }, view).left, 8, "and off the left");
    const tall = placeCard({ left: 0, top: 300, bottom: 320 }, { w: 100, h: 900 }, view);
    assert.ok(tall.top >= 8, "a card taller than either side still starts on screen");
});

test("lineAt picks the line of a wrapped trigger that the pointer is on, else the nearest, so the card hangs from where the eye is", () => {
    const lines = [{ left: 80, top: 100, bottom: 120 }, { left: 20, top: 120, bottom: 140 }, { left: 20, top: 140, bottom: 160 }];
    assert.equal(lineAt(lines, 110), lines[0]);
    assert.equal(lineAt(lines, 150), lines[2], "the third of three lines, not the box around all of them");
    assert.equal(lineAt(lines, 400), lines[2], "below them all: the nearest");
    assert.equal(lineAt(lines, 10), lines[0], "above them all: the nearest");
    assert.equal(lineAt([], 10), null);
});

test("placeCard clears the cursor's own image: a card below starts under the pointer's foot, never across it", () => {
    const view = { w: 800, h: 600 };
    const line = { left: 100, top: 100, bottom: 118 };            // an 18px line; the pointer is near its top, at y=102
    assert.equal(placeCard(line, { w: 300, h: 100 }, view, 4, 8, 102 + 24).top, 102 + 24 + 4, "starts below the cursor image, which reaches 24px under the hotspot");
    assert.equal(placeCard(line, { w: 300, h: 100 }, view).top, 118 + 4, "without a pointer it hangs from the line, as before");
    const low = placeCard({ left: 100, top: 500, bottom: 518 }, { w: 300, h: 240 }, view, 4, 8, 502 + 24);
    assert.ok(low.top + 240 <= 502, "above, the whole card is over the hotspot, so the cursor is never under it");
});
