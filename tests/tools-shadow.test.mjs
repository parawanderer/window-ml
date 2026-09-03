"use strict";
// describeElement's SEALED-shadow discovery (tools.ts): a `>>>` path into a closed/declarative shadow root a
// page selector can't enter is resolved via the injected CDP `shadowResolve` closure — the read half of the
// sealed-shadow reach. Tested here (not in the vm-based agent.test.js) so we can inject a STUB resolver and
// exercise both the success listing and the honest "enable CDP" fallback without a live background.
//
// makeDomTools reads the global `document`; point it at jsdom before each call. defineTool is identity — we
// only need the returned tool's `run`.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { makeDomTools } from "../src/tools.ts";

function mount(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, configurable: true });
    return dom.window.document;
}
// A rendered box promotes a hyphenated, light-empty host from "empty" to "sealed" (isSealedHost / firstHopSealed).
const paint = (el) => { el.getBoundingClientRect = () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30 }); };
const defineTool = (t) => ({ ...t });
const describeTool = (shadowResolve) => makeDomTools(defineTool, undefined, undefined, shadowResolve).find(t => t.name === "describeElement");

test("describeElement: a `>>>` into a sealed root LISTS its contents via the CDP resolver, offering a click", async () => {
    const doc = mount(`<sealed-box id="s"></sealed-box>`);
    paint(doc.getElementById("s"));
    let asked = null;
    const stub = async (sel) => { asked = sel; return [{ line: 'button.inner "Go"' }, { line: 'span "x"' }]; };
    const res = await describeTool(stub).run({ selector: "sealed-box >>> .inner" });
    assert.equal(asked, "sealed-box >>> .inner", "the resolver was asked for the exact `>>>` path");
    assert.match(String(res), /reached via the debugger/, "flags the CDP reach");
    assert.match(String(res), /#0: button\.inner "Go"/, "lists the sealed contents with indices");
    assert.match(String(res), /#1: span "x"/);
    assert.match(String(res), /click\(\{ selector: "sealed-box >>> \.inner", index: N \}\)/, "tells the model how to act on one");
});

test("describeElement: a sealed `>>>` with the debugger OFF (resolver → null) is honest about enabling CDP", async () => {
    const doc = mount(`<sealed-box id="s"></sealed-box>`);
    paint(doc.getElementById("s"));
    const off = async () => null;   // the background returned an error (cdp off) → the closure yields null
    const res = await describeTool(off).run({ selector: "sealed-box >>> .inner" });
    assert.match(String(res), /SEALED[\s\S]*shadow root/, "names the barrier");
    assert.match(String(res), /Debugger-based actions \(CDP\)/, "points at the setting that would reach it");
});

test("describeElement: no resolver wired (undefined) → the same honest fallback, never a crash", async () => {
    const doc = mount(`<sealed-box id="s"></sealed-box>`);
    paint(doc.getElementById("s"));
    const res = await describeTool(undefined).run({ selector: "sealed-box >>> .inner" });
    assert.match(String(res), /SEALED[\s\S]*shadow root/);
});

test("describeElement: describing a SEALED HOST itself hints at the `>>>` + debugger path to see inside", async () => {
    const doc = mount(`<sealed-box id="s"></sealed-box>`);
    paint(doc.getElementById("s"));
    const res = await describeTool(async () => null).run({ selector: "sealed-box" });   // single hop → host exists → sealedHint
    assert.match(String(res.content), /SEALED shadow host/, "flags that describeSkeleton stopped at the boundary");
    assert.match(String(res.content), /describeElement\(\{ selector: "sealed-box >>> \*" \}\)/, "offers the `>>>` inspect path");
});

test("describeElement: an ordinary miss (no sealed host in the path) stays a plain 'no match'", async () => {
    mount(`<div id="d"></div>`);
    const res = await describeTool(async () => { throw new Error("must not be called"); }).run({ selector: ".nope" });
    assert.match(String(res), /No element matches/, "no sealed host → the resolver is never consulted");
});
