"use strict";
// Page-side routing for TRUSTED input (canvas / WebGL / remote-desktop / sealed targets): `type` into @focus /
// @pt / a sealed `>>>` field hands back a `cdpType` envelope; `click` on an @pt goes through CDP (cdpClick)
// when the run enabled it. The background then performs the trusted CDP action (covered in background.test.js).
// Tested here (not the vm harness) so we can flip the module `setCdpEnabled` flag + stub a tiny `ml`.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { buildTypeTool, buildClickTool, setCdpEnabled } from "../builtin-tools.ts";
import { mintPoint } from "../util.ts";

function mount(html = "") {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, configurable: true });
    return dom.window.document;
}
const paint = (el) => { el.getBoundingClientRect = () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30 }); };
const ml = { defineTool: (t) => ({ ...t }) };   // the envelope branches return before touching ml
const typeTool = () => buildTypeTool(ml);
const clickTool = () => buildClickTool(ml);

test("type @focus → a cdpType signal for the page's CURRENT focus (no coords, no selector)", async () => {
    mount();
    const res = await typeTool().run({ selector: "@focus", text: "hello", submit: true });
    assert.ok(res.cdpType, "emits cdpType");
    assert.equal(res.cdpType.text, "hello");
    assert.equal(res.cdpType.submit, true, "submit rides along");
    assert.ok(!("x" in res.cdpType) && !("selector" in res.cdpType), "focus mode carries neither coords nor a selector");
});

test("type '' (empty selector) is treated as @focus too", async () => {
    mount();
    const res = await typeTool().run({ selector: "", text: "hi" });
    assert.ok(res.cdpType && res.cdpType.text === "hi", "empty selector → current-focus cdpType");
});

test("type @pt → a cdpType signal carrying the coordinate (click-to-focus then type)", async () => {
    mount();
    const tok = mintPoint(120, 340);
    const res = await typeTool().run({ selector: tok, text: "abc" });
    assert.ok(res.cdpType, "emits cdpType");
    assert.equal(res.cdpType.x, 120); assert.equal(res.cdpType.y, 340);
    assert.equal(res.cdpType.text, "abc");
});

test("type into a sealed `>>>` field → a cdpType signal with the selector (CDP resolves + focuses it)", async () => {
    const doc = mount(`<sealed-box id="s"></sealed-box>`);
    paint(doc.getElementById("s"));
    const res = await typeTool().run({ selector: "sealed-box >>> input", text: "q", index: 0 });
    assert.ok(res.cdpType, "emits cdpType");
    assert.equal(res.cdpType.selector, "sealed-box >>> input");
    assert.equal(res.cdpType.text, "q");
});

test("type @box → refused (a region, not a field)", async () => {
    mount();
    const res = await typeTool().run({ selector: "@box:deadbeef", text: "x" });
    assert.match(String(res), /@box region, not a field/);
    assert.ok(!res.cdpType);
});

test("type into a NORMAL field still sets the value directly (no CDP) — the DOM path is unchanged", async () => {
    const doc = mount(`<input id="q">`);
    const res = await typeTool().run({ selector: "#q", text: "search" });
    assert.match(String(res.content ?? res), /Value now: "search"/, "normal fields keep the synthetic value-set path");
    assert.equal(doc.getElementById("q").value, "search");
    assert.ok(!(res.cdpType), "no trusted-keyboard signal for an ordinary field");
});

test("click @pt: CDP-trusted ONLY when the run enabled it; otherwise the synthetic canvas path", async () => {
    mount();   // empty doc → elementFromPoint returns null (not a reserved surface)
    const tok = mintPoint(200, 250);
    setCdpEnabled(true);
    const on = await clickTool().run({ selector: tok });
    assert.ok(on.cdpClick, "cdp ON → a trusted CDP click at the coordinate");
    assert.equal(on.cdpClick.x, 200); assert.equal(on.cdpClick.y, 250);
    setCdpEnabled(false);
    const off = await clickTool().run({ selector: tok });
    assert.ok(!off.cdpClick, "cdp OFF → the synthetic canvas path (no CDP signal)");
    assert.match(String(off), /Nothing is at point|Clicked at/, "fell to the synthetic clickAt");
});
