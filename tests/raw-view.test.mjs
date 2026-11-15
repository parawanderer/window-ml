// raw-view.test.mjs — a block's rendered⇄raw choice and the calm chat's reset of it.

import { test, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, useRawView, calmEntered, host;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.Node = dom.window.Node;
    host = dom.window.document.getElementById("root");
    ({ h, render } = require_("preact"));
    ({ useRawView } = await import("../src/sidebar/raw-view.ts"));
    ({ calmEntered } = await import("../src/sidebar/store.ts"));
});
const tick = () => new Promise((r) => setTimeout(r, 40));

// --- switching the calm chat on resets a block to its rendered view ---
test("a block on its raw view goes back to rendered when the calm chat is switched on, and not otherwise", async () => {
    let set;
    const Block = () => { const [raw, setRaw] = useRawView(); set = setRaw; return h("span", { id: "b" }, raw ? "raw" : "rendered"); };
    render(h(Block), host); await tick();
    const text = () => host.querySelector("#b").textContent;
    assert.equal(text(), "rendered", "rendered by default");
    set(true); await tick();
    assert.equal(text(), "raw", "the person's own switch holds");
    await tick();
    assert.equal(text(), "raw", "and keeps holding: mounting does not reset it");
    calmEntered.value++; await tick();
    assert.equal(text(), "rendered", "calm switched on: back to rendered");
    set(true); await tick();
    assert.equal(text(), "raw", "and the switch works again afterwards");
    render(null, host);
});
