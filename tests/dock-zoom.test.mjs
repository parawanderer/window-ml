// The chat page's docked panels, mounted for real (src/chat/dock.tsx): the zoom and the key that ends it.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, dock, doc;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.localStorage = dom.window.localStorage;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    dock = await import("../src/chat/dock.tsx");
});

/** Preact renders a signal's change in a microtask; two of them are the DOM commit, with no effect run yet. */
const committed = async () => { await Promise.resolve(); await Promise.resolve(); };
const settled = () => new Promise((r) => setTimeout(r, 80));

// --- Maximize and Escape ---

test("an Escape in the very frame the zoom appears ends it: the listener is not a frame behind the class", async () => {
    const panels = [{ id: "resource", title: "Resources", icon: null, body: h("div", { class: "vram" }), close() {} }];
    render(h(dock.DockFrame, { panels, narrow: false }, h("p", null, "the column")), doc.getElementById("root"));
    await settled();
    assert.equal(doc.querySelectorAll(".chat-dock.max").length, 0);
    // What the ⋮ menu's Maximize does. The class is in the DOM once Preact has rendered the change, which is before any
    // effect of that render has run: an Escape right then is what a person pressing it straight after the click sends,
    // and what the e2e test sends on a loaded runner (chat-page.spec.mjs, "zoom until Escape").
    dock.maximized.value = "resource";
    await committed();
    assert.equal(doc.querySelectorAll(".chat-dock.max").length, 1, "the zoom is drawn");
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settled();
    assert.equal(dock.maximized.value, null, "the Escape ended the zoom");
    assert.equal(doc.querySelectorAll(".chat-dock.max").length, 0);
});

test("an Escape with a menu open over the zoom is the menu's, and one after it has gone is the zoom's", async () => {
    dock.maximized.value = "resource";
    await settled();
    const menu = doc.createElement("div"); menu.className = "chat-menu"; doc.body.appendChild(menu);
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settled();
    assert.equal(dock.maximized.value, "resource", "a menu over the zoom takes the key");
    menu.className = "chat-menu leaving";
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settled();
    assert.equal(dock.maximized.value, null, "a menu on its way out does not");
    menu.remove();
});
