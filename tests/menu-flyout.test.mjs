// menu-flyout.test.mjs — the chat page's menu groups (src/chat/menu.tsx `MenuGroup`): on a wide layout a row with
// children opens a SECOND sheet beside the first (hover after an intent delay, click, ArrowRight/Enter), one at a time,
// placed from the row's rectangle and kept inside the viewport; on a phone the same row expands in place. jsdom has no
// layout, so the rectangles are stubbed; what is asserted is the rules, not pixels (the gallery's GearMenu flow shows those).
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import "./stub-css.mjs";

const dom = new JSDOM("<body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
const w = dom.window;
Object.assign(globalThis, { window: w, document: w.document, getComputedStyle: w.getComputedStyle, HTMLElement: w.HTMLElement, Node: w.Node, Event: w.Event });
const { h, render } = createRequire(import.meta.url)("preact");

let MenuGroup, MenuItem, closeFlyout, flyoutIsOpen, FLYOUT_OPEN_MS, FLYOUT_CLOSE_MS;
before(async () => {
    ({ MenuGroup, MenuItem, closeFlyout, flyoutIsOpen, FLYOUT_OPEN_MS, FLYOUT_CLOSE_MS } = await import("../src/chat/menu.tsx"));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(30);

// Rectangles by what the element says: the first sheet, the rows of it, the flyout's size.
let rects, flyoutSize;
w.HTMLElement.prototype.getBoundingClientRect = function () {
    const r = this.classList.contains("chat-menu") && !this.classList.contains("chat-menu-flyout") ? rects.menu
        : this.classList.contains("chat-menu-item") ? rects[this.textContent.trim().split(/\s/)[0]] : null;
    const o = r ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...o, right: o.left + o.width, bottom: o.top + o.height, x: o.left, y: o.top };
};
Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return this.classList.contains("chat-menu-flyout") ? flyoutSize.w : 0; } });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return this.classList.contains("chat-menu-flyout") ? flyoutSize.h : 0; } });

let narrow, root, picked;
const setNarrow = (n) => { narrow = n; globalThis.matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }); };
beforeEach(() => {
    setNarrow(false);
    rects = { menu: { left: 20, top: 100, width: 240, height: 200 }, Alpha: { left: 26, top: 130, width: 228, height: 36 }, Beta: { left: 26, top: 166, width: 228, height: 36 } };
    flyoutSize = { w: 200, h: 120 };
    picked = [];
    closeFlyout();
    document.body.innerHTML = "";
    root = document.createElement("div"); root.className = "chat"; document.body.appendChild(root);
});
afterEach(() => { render(null, root); closeFlyout(); });

const group = (label) => h(MenuGroup, { icon: null, label }, (open, fly) => [0, 1].map((i) =>
    h(MenuItem, { key: i, sub: { i, open }, icon: fly ? h("i", null) : null, label: `${label}-${i}`, onPick: () => picked.push(`${label}-${i}`) })));
const mount = async () => {
    render(h("div", { class: "chat-menu" }, group("Alpha"), group("Beta")), root);
    await flush();
};
const row = (label) => [...root.querySelectorAll(".chat-menu > .chat-menu-item")].find((b) => b.textContent.startsWith(label));
const flyouts = () => [...document.querySelectorAll(".chat-menu-flyout")];
const fire = (el, type, init = {}) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: type !== "pointerenter" && type !== "pointerleave", cancelable: true, ...init }));
const key = (el, k) => { const e = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };

// --- opening: hover after an intent delay, click at once ---

test("hovering a group row opens its flyout only after the intent delay, and a pass through does not open it", async () => {
    await mount();
    fire(row("Alpha"), "pointerenter");
    await sleep(FLYOUT_OPEN_MS / 2);
    assert.equal(flyouts().length, 0, "not yet");
    fire(row("Alpha"), "pointerleave");
    await sleep(FLYOUT_OPEN_MS);
    assert.equal(flyouts().length, 0, "the pointer left before the delay, so it never opens");
    fire(row("Alpha"), "pointerenter");
    await sleep(FLYOUT_OPEN_MS + 40);
    assert.equal(flyouts().length, 1);
    assert.equal(row("Alpha").getAttribute("aria-expanded"), "true");
    assert.ok(row("Alpha").classList.contains("fly-open"), "the parent row stays lit");
});

test("a click opens it at once, and the rows are the same MenuItems, now with the glyph slot filled", async () => {
    await mount();
    fire(row("Alpha"), "click", { detail: 1 });
    await flush();
    const [f] = flyouts();
    assert.ok(f.classList.contains("chat-menu"), "one menu look: the flyout is a .chat-menu sheet");
    assert.equal(f.getAttribute("role"), "menu");
    assert.deepEqual([...f.querySelectorAll("button")].map((b) => b.textContent), ["Alpha-0", "Alpha-1"]);
    assert.equal(f.querySelectorAll(".chat-menu-ico i").length, 2);
    assert.ok(f.closest(".chat"), "drawn into .chat, outside the menu that sits in the clipping list");
    assert.ok(!row("Alpha").parentElement.contains(f), "and not inside the first sheet");
});

test("a touch does not open on hover", async () => {
    await mount();
    const e = new w.MouseEvent("pointerenter"); Object.defineProperty(e, "pointerType", { value: "touch" });
    row("Alpha").dispatchEvent(e);
    await sleep(FLYOUT_OPEN_MS + 40);
    assert.equal(flyouts().length, 0);
});

// --- placement ---

test("the first choice lines up with the row; the flyout opens to the right of the menu", async () => {
    await mount();
    fire(row("Beta"), "click", { detail: 1 });
    await flush();
    const f = flyouts()[0];
    assert.equal(f.style.left, `${20 + 240 + 4}px`, "beside the menu, a gap past its right edge");
    assert.equal(f.style.top, `${166 - 7}px`, "its first ROW (7px = sheet padding + border) at the parent row's top");
    assert.equal(f.dataset.side, "right");
    assert.equal(f.style.getPropertyValue("--fly-dx"), "-6px", "slides in from the menu's side");
});

test("it flips to the left when it would leave the viewport, and is clamped vertically", async () => {
    rects.menu = { left: 1024 - 260, top: 100, width: 240, height: 200 };
    rects.Alpha = { left: 1024 - 254, top: 740, width: 228, height: 36 };
    await mount();
    fire(row("Alpha"), "click", { detail: 1 });
    await flush();
    const f = flyouts()[0];
    assert.equal(f.dataset.side, "left");
    assert.equal(f.style.left, `${1024 - 260 - 4 - 200}px`);
    assert.equal(f.style.top, `${768 - 120 - 8}px`, "clamped to the bottom edge, 8px in");
    assert.equal(f.style.getPropertyValue("--fly-dx"), "6px");
});

// --- closing: the diagonal, one at a time, pick, outside ---

test("moving diagonally from the row into the flyout does not close it: the close delay is cancelled on entry", async () => {
    await mount();
    fire(row("Alpha"), "click", { detail: 1 });
    await flush();
    fire(row("Alpha"), "pointerleave");
    await sleep(FLYOUT_CLOSE_MS - 100);              // crossing the gap takes a while
    fire(flyouts()[0], "pointerenter");
    await sleep(FLYOUT_CLOSE_MS + 60);
    assert.equal(flyouts().length, 1, "still open: the pointer is in it");
    fire(flyouts()[0], "pointerleave");
    await sleep(FLYOUT_CLOSE_MS - 100);
    assert.equal(flyoutIsOpen(), true, "leaving it does not close it at once either");
    await sleep(160);
    assert.equal(flyoutIsOpen(), false, "but it does close once the pointer has been away for the delay");
});

test("only one flyout is open at a time: opening Beta's closes Alpha's", async () => {
    await mount();
    fire(row("Alpha"), "click", { detail: 1 }); await flush();
    fire(row("Beta"), "click", { detail: 1 }); await sleep(200);
    assert.deepEqual(flyouts().map((f) => f.dataset.flyout), ["Beta"]);
    assert.equal(row("Alpha").getAttribute("aria-expanded"), "false");
});

test("picking an item closes the flyout", async () => {
    await mount();
    fire(row("Alpha"), "click", { detail: 1 }); await flush();
    fire(flyouts()[0].querySelector("button"), "click", { detail: 1 });
    await sleep(200);
    assert.deepEqual(picked, ["Alpha-0"]);
    assert.equal(flyouts().length, 0);
});

test("a press outside the row and the flyout closes it; a press inside does not", async () => {
    await mount();
    fire(row("Alpha"), "click", { detail: 1 }); await flush();
    fire(flyouts()[0], "pointerdown"); await flush();
    assert.equal(flyoutIsOpen(), true);
    fire(document.body, "pointerdown"); await flush();
    assert.equal(flyoutIsOpen(), false);
});

// --- keyboard ---

test("ArrowRight on a row opens the flyout and focuses its first item; Down and Up move and wrap", async () => {
    await mount();
    row("Alpha").focus();
    key(row("Alpha"), "ArrowRight"); await flush();
    const [a, b] = flyouts()[0].querySelectorAll("button");
    assert.equal(document.activeElement, a);
    key(a, "ArrowDown"); assert.equal(document.activeElement, b);
    key(b, "ArrowDown"); assert.equal(document.activeElement, a, "wraps");
    key(a, "ArrowUp"); assert.equal(document.activeElement, b, "wraps back");
});

test("Enter on a row (a click with no pointer) opens it and focuses the first item", async () => {
    await mount();
    fire(row("Beta"), "click", { detail: 0 }); await flush();
    assert.equal(document.activeElement, flyouts()[0].querySelector("button"));
});

test("ArrowLeft and Escape return focus to the row and close the flyout, and Escape does not reach the menu's own listener", async () => {
    await mount();
    for (const k of ["ArrowLeft", "Escape"]) {
        key(row("Alpha"), "ArrowRight"); await flush();
        let reached = false;
        const on = () => { reached = true; };
        document.addEventListener("keydown", on);
        key(document.activeElement, k); await sleep(200);
        document.removeEventListener("keydown", on);
        assert.equal(flyouts().length, 0, k);
        assert.equal(document.activeElement, row("Alpha"), k);
        assert.equal(reached, false, `${k} stops at the flyout, so the menu stays`);
    }
});

test("the ARIA roles hold: the row is a menuitem with aria-haspopup, radio rows are menuitemradio", async () => {
    await mount();
    assert.equal(row("Alpha").getAttribute("role"), "menuitem");
    assert.equal(row("Alpha").getAttribute("aria-haspopup"), "true");
    assert.equal(row("Alpha").getAttribute("aria-expanded"), "false");
    render(h("div", { class: "chat-menu" }, h(MenuItem, { icon: null, label: "Dark", radio: { on: true }, onPick() {} }),
        h(MenuItem, { icon: null, label: "Light", radio: { on: false }, onPick() {} })), root);
    await flush();
    const [d, l] = root.querySelectorAll("button");
    assert.equal(d.getAttribute("role"), "menuitemradio");
    assert.equal(d.getAttribute("aria-checked"), "true");
    assert.equal(l.getAttribute("aria-checked"), "false");
    assert.equal(d.querySelectorAll(".chat-menu-on").length, 1, "the chosen one is ticked");
});

// --- the phone keeps the in-place expansion ---

test("on a narrow layout the group expands in place and never draws a flyout", async () => {
    setNarrow(true);
    await mount();
    const r = row("Alpha");
    assert.ok(root.querySelector(".chat-menu-subs"), "the in-place container is there");
    assert.equal(r.getAttribute("aria-expanded"), "false");
    fire(r, "pointerenter"); await sleep(FLYOUT_OPEN_MS + 40);
    assert.equal(flyouts().length, 0, "hover does nothing");
    fire(r, "click", { detail: 1 }); await flush();
    assert.equal(r.getAttribute("aria-expanded"), "true");
    assert.ok(root.querySelector(".chat-menu-subs.open"));
    assert.equal(flyouts().length, 0);
    assert.equal(root.querySelectorAll(".chat-menu-ico i").length, 0, "children carry no glyph in place");
    fire(r, "click", { detail: 1 }); await flush();
    assert.equal(r.getAttribute("aria-expanded"), "false", "a second click collapses it");
});
