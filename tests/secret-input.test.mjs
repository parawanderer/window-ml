// The secret text box (src/sidebar/secret-input.tsx): hidden until the eye is pressed, shown while it is on, hidden again by
// the next press, and the text typed is the same either way.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, SecretInput, doc, flush;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    flush = () => new Promise((r) => setTimeout(r, 20));
    ({ h, render } = require_("preact"));
    ({ SecretInput } = await import("../src/sidebar/secret-input.tsx"));
});

// --- the eye shows and hides what was typed ---

test("a secret is dots first; the eye shows it, the eye again hides it, and the text never changes", async () => {
    const host = doc.getElementById("root");
    render(h(SecretInput, { value: "sk-abc", placeholder: "key", onInput() {} }), host);
    const input = () => host.querySelector("input");
    const eye = () => host.querySelector("button.secret-eye");
    assert.equal(input().type, "password", "hidden by default");
    assert.equal(eye().getAttribute("aria-pressed"), "false");
    assert.match(eye().getAttribute("aria-label"), /^Show/);
    eye().click(); await flush();
    assert.equal(input().type, "text");
    assert.equal(input().value, "sk-abc");
    assert.equal(eye().getAttribute("aria-pressed"), "true");
    assert.match(eye().getAttribute("aria-label"), /^Hide/);
    eye().click(); await flush();
    assert.equal(input().type, "password");
    assert.equal(input().value, "sk-abc");
});

test("the eye is a button that does not submit, and a disabled field disables it too", async () => {
    const host = doc.getElementById("root");
    render(null, host);
    render(h(SecretInput, { value: "", disabled: true }), host);
    assert.equal(host.querySelector("button.secret-eye").type, "button");
    assert.equal(host.querySelector("button.secret-eye").disabled, true);
});
