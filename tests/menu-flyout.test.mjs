// menu-flyout.test.mjs — the chat page's menu groups (src/chat/menu.tsx `MenuGroup`): on a wide layout a row with
// children opens a SECOND sheet beside the first (hover after an intent delay, click, ArrowRight/Enter), one at a time,
// placed from the row's rectangle and kept inside the viewport; on a phone the same row slides over. jsdom has no
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

const group = (label) => h(MenuGroup, { icon: null, label }, (open) => [0, 1].map((i) =>
    h(MenuItem, { key: i, sub: { i, open }, icon: h("i", null), label: `${label}-${i}`, onPick: () => picked.push(`${label}-${i}`) })));
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

// --- the phone: the group slides over the menu ---

const rowsIn = (el) => [...el.querySelectorAll("button")].map((b) => b.textContent);

test("on a narrow layout choosing a group row slides its rows over the menu under a back row, and never draws a flyout", async () => {
    setNarrow(true);
    await mount();
    const r = row("Alpha");
    assert.equal(r.getAttribute("aria-expanded"), "false");
    assert.equal(root.querySelector(".chat-menu-page"), null, "nothing is drawn until it is chosen");
    fire(r, "pointerenter"); await sleep(FLYOUT_OPEN_MS + 40);
    assert.equal(root.querySelector(".chat-menu-page"), null, "hover does nothing");
    fire(r, "click", { detail: 1 }); await flush();
    assert.equal(r.getAttribute("aria-expanded"), "true");
    const page = root.querySelector(".chat-menu-page");
    assert.equal(page.parentElement, root.querySelector(".chat-menu"), "a child of the sheet, so the sheet's contents are replaced");
    assert.equal(page.getAttribute("aria-label"), "Alpha");
    assert.deepEqual(rowsIn(page), ["Alpha", "Alpha-0", "Alpha-1"], "a back row named for the group, then its rows");
    assert.equal(page.querySelector(".chat-menu-back .chat-menu-ico svg") !== null, true, "the back row has the arrow");
    assert.equal(flyouts().length, 0);
    assert.equal(document.activeElement, page.querySelector(".chat-menu-sub"), "focus goes to the first child");
});

test("the back row slides it out and returns focus to the group row", async () => {
    setNarrow(true);
    await mount();
    fire(row("Alpha"), "click", { detail: 1 }); await flush();
    fire(root.querySelector(".chat-menu-back"), "click", { detail: 1 }); await flush();
    assert.ok(root.querySelector(".chat-menu-page.closing"), "it is on its way out, still mounted for the slide");
    assert.equal(row("Alpha").getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, row("Alpha"));
    await sleep(250);
    assert.equal(root.querySelector(".chat-menu-page"), null);
});

test("only one page at a time: choosing Beta's replaces Alpha's", async () => {
    setNarrow(true);
    await mount();
    fire(row("Alpha"), "click", { detail: 1 }); await flush();
    fire(row("Beta"), "click", { detail: 1 }); await sleep(250);
    assert.deepEqual([...root.querySelectorAll(".chat-menu-page:not(.closing)")].map((p) => p.getAttribute("aria-label")), ["Beta"]);
});

test("Escape on the phone goes back first and closes the menu on the second press (the gear's rule, on the real GearMenu)", async () => {
    setNarrow(true);
    const { GearMenu } = await import("../src/chat/nav.tsx");
    render(h(GearMenu, { graphsRt: { id: "a", name: "mlbox" }, benchRt: { id: "b", name: "This browser" } }), root);
    await flush();
    fire(root.querySelector(".chat-gear-btn"), "click"); await flush();
    const menu = () => root.querySelector(".chat-gear-menu:not(.leaving)");
    const panels = [...menu().querySelectorAll(":scope > .chat-menu-item")].find((b) => b.textContent.startsWith("Panels"));
    fire(panels, "click", { detail: 1 }); await flush();
    assert.ok(menu().querySelector(".chat-menu-page:not(.closing)"), "Panels is open");
    assert.deepEqual([...menu().querySelectorAll(".chat-menu-section-head")].map((e) => e.textContent), ["mlbox", "This browser"]);
    key(document.activeElement, "Escape"); await sleep(250);
    assert.ok(menu(), "the first Escape leaves the menu open");
    assert.equal(menu().querySelector(".chat-menu-page"), null, "and goes back");
    assert.equal(document.activeElement, panels, "to the Panels row");
    key(document.activeElement, "Escape"); await sleep(250);
    assert.equal(root.querySelector(".chat-gear-menu"), null, "the second closes the menu");
});

// --- Panels under their runtimes ---

test("rows group by runtime, one section each, in the order the first row of each appears", async () => {
    const { sectionsByRuntime } = await import("../src/chat/menu.tsx");
    const a = { id: "a", name: "mlbox" }, b = { id: "b", name: "This browser" };
    const rows = [{ rt: a, l: "models" }, { rt: b, l: "bench" }, { rt: { id: "a", name: "mlbox" }, l: "log" }, { rt: b, l: "state" }];
    const secs = sectionsByRuntime(rows);
    assert.deepEqual(secs.map((s) => [s.rt.name, s.rows.map((r) => r.l)]), [["mlbox", ["models", "log"]], ["This browser", ["bench", "state"]]],
        "the same id is the same section even when the objects differ");
    assert.equal(sectionsByRuntime(rows.filter((r) => r.rt.id === "b")).length, 1, "one runtime: one section, so one header");
    assert.deepEqual(sectionsByRuntime([{ rt: { name: "x" }, l: 1 }, { rt: { name: "x" }, l: 2 }, { rt: { name: "y" }, l: 3 }]).map((s) => s.rows.length), [2, 1], "no id: told by name");
    assert.deepEqual(sectionsByRuntime([]), []);
});

test("a section is a labelled group whose header is not a row: not a menuitem, not a button", async () => {
    const { MenuSection } = await import("../src/chat/menu.tsx");
    render(h("div", { class: "chat-menu" },
        h(MenuSection, { name: "mlbox" }, h(MenuItem, { icon: null, label: "Models and memory", onPick() {} })),
        h(MenuSection, { name: "This browser" }, h(MenuItem, { icon: null, label: "Run state", onPick() {} }))), root);
    await flush();
    const groups = [...root.querySelectorAll('[role="group"]')];
    assert.deepEqual(groups.map((g) => g.getAttribute("aria-label")), ["mlbox", "This browser"]);
    for (const g of groups) {
        const head = g.querySelector(".chat-menu-section-head");
        assert.equal(head.getAttribute("role"), "presentation");
        assert.equal(head.closest("button"), null);
        assert.equal(head.tabIndex, -1, "not focusable");
        assert.equal(g.querySelectorAll('[role="menuitem"]').length, 1, "only the row is an item");
    }
});
