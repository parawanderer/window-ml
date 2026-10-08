// The JSON tree's opt-in right-click menu and root slots (src/sidebar/transcript/json-tree.tsx): the path a copied row
// names, what "Copy value" puts on the clipboard, the row a menu is about being marked while it is open, and that a tree
// given no path (a tool's schema, the raw In) behaves exactly as before.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, T, ui, doc, win;
const copied = [];
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    win = dom.window;
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.Node = win.Node;
    globalThis.HTMLElement = win.HTMLElement;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (t) => { copied.push(t); } }, platform: "Test" } });
    doc = win.document;
    ({ h, render } = require_("preact"));
    T = await import("../src/sidebar/transcript/json-tree.tsx");
    ui = await import("../src/sidebar/ui-kit.tsx");
});
beforeEach(() => { copied.length = 0; ui.ctxMenu.value = null; });

const show = (props) => { const host = doc.getElementById("root"); render(null, host); render(h(T.JsonNode, props), host); return host; };
/** Right-click a row, as the browser would: returns whether the default (the browser's own menu) was prevented. */
const rightClick = (el) => { const e = new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }); el.dispatchEvent(e); return e.defaultPrevented; };
const rowWith = (host, text) => [...host.querySelectorAll(".jt-row")].find((r) => r.textContent.includes(text));
const run = async (label) => { ui.ctxMenu.value.items.find((i) => i.label === label).run(); await new Promise((r) => setTimeout(r, 0)); };

// --- the path a row names: what a watch or the console would take ---

test("a member's path: `.name` for an identifier, `[i]` for an index, a quoted key for anything else", () => {
    assert.equal(T.childPath("inspector.run.init", "task", false), "inspector.run.init.task");
    assert.equal(T.childPath("ml.current.messages", "0", true), "ml.current.messages[0]");
    assert.equal(T.childPath("$", "_private1", false), "$._private1");
    for (const [key, want] of [["a.b", '$["a.b"]'], ["1st", '$["1st"]'], ["has space", '$["has space"]'], ['say "hi"', '$["say \\"hi\\""]'], ["", '$[""]']])
        assert.equal(T.childPath("$", key, false), want, `key ${JSON.stringify(key)}`);
});

test("a copied value: a string as itself, anything else as indented JSON", () => {
    assert.equal(T.copyableValue("count the widgets"), "count the widgets");
    assert.equal(T.copyableValue({ a: [1, 2] }), '{\n  "a": [\n    1,\n    2\n  ]\n}');
    assert.equal(T.copyableValue(3), "3");
    assert.equal(T.copyableValue(null), "null");
    assert.equal(T.copyableValue(false), "false");
});

// --- the right-click menu, only where a caller asked for it ---

test("with no path the tree offers no menu: the browser's own stays, so the trees that never asked are unchanged", () => {
    const host = show({ v: { task: "x", tags: ["a"] }, allOpen: true });
    for (const row of host.querySelectorAll(".jt-row")) assert.equal(rightClick(row), false, row.textContent);
    assert.equal(ui.ctxMenu.value, null);
});

test("with a path every row offers its value and its path, nested rows and odd keys included", async () => {
    const host = show({ v: { task: "count", "a.b": [{ n: 7 }] }, allOpen: true, path: "inspector.run.init" });
    assert.equal(rightClick(rowWith(host, "n:")), true);
    assert.deepEqual(ui.ctxMenu.value.items.map((i) => i.label), ["Copy value", "Copy path"]);
    await run("Copy path");
    await run("Copy value");
    assert.deepEqual(copied, ['inspector.run.init["a.b"][0].n', "7"]);
    // The root row names the root, and a string leaf copies as its text.
    rightClick(host.querySelector(".jt-row"));
    await run("Copy path");
    rightClick(rowWith(host, "task:"));
    await run("Copy value");
    assert.deepEqual(copied.slice(2), ["inspector.run.init", "count"]);
});

test("the row a menu is about is marked while that menu is open, and unmarked when it closes or another replaces it", () => {
    const host = show({ v: { a: 1, b: 2 }, allOpen: true, path: "$" });
    const a = rowWith(host, "a:"), b = rowWith(host, "b:");
    rightClick(a);
    assert.ok(a.classList.contains("ctx-target"));
    rightClick(b);
    assert.ok(!a.classList.contains("ctx-target"), "replaced by the menu on b");
    assert.ok(b.classList.contains("ctx-target"));
    ui.ctxMenu.value = null;
    assert.ok(!b.classList.contains("ctx-target"), "closed");
});

// --- a caller's own name and chips, on the root's line only ---

test("label replaces the key and trail ends the line, on the ROOT row only, for a branch and for a leaf", () => {
    const branch = show({ v: { a: 1, b: { c: 2 } }, allOpen: true, k: "ignored", label: h("span", { class: "L" }, "inspector.x:"), trail: h("span", { class: "T" }, "you only") });
    assert.equal(branch.querySelectorAll(".L").length, 1);
    assert.equal(branch.querySelectorAll(".T").length, 1);
    const root = branch.querySelector(".jt-row");
    assert.ok(root.querySelector(".L") && root.querySelector(".T"), "both on the first row");
    assert.ok(!root.textContent.includes("ignored"), "the label stands in for the key");
    assert.ok(rowWith(branch, "c:"), "members keep their own keys");
    const leaf = show({ v: "a string", label: h("span", { class: "L" }, "inspector.y:"), trail: h("span", { class: "T" }, "chip") });
    assert.equal(leaf.querySelectorAll(".jt-row").length, 1);
    assert.match(leaf.textContent, /inspector\.y:"a string"chip/);
});
