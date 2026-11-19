// The secret text box (src/sidebar/secret-input.tsx): hidden until the eye is pressed, shown while it is on, hidden again by
// the next press, and the text typed is the same either way.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, act, SecretInput, doc, flush;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    ({ act } = require_("preact/test-utils"));
    ({ SecretInput } = await import("../src/sidebar/secret-input.tsx"));
    /**
     * Do `fn` (a render, a click, an input event) inside `act`, so every effect it schedules has RUN when this returns.
     * The old wait was a fixed 20 ms sleep, and the effect that hides a value written from OUTSIDE lands on Preact's
     * after-paint timer (a 35 ms setTimeout fallback in the hooks build, measured at 36.5-39.5 ms), so a loaded runner
     * could read the box before that effect ran: `secret-input.test.mjs`'s "a key written elsewhere is not drawn in the
     * clear" failed on run 44590427280 with `'text' !== 'password'` while passing locally. `act` flushes the effects,
     * so the wait is on the work being done rather than on a clock.
     */
    flush = (fn) => act(async () => { fn(); });
});

// --- the eye shows and hides what was typed ---

test("a secret is dots first; the eye shows it, the eye again hides it, and the text never changes", async () => {
    const host = doc.getElementById("root");
    await flush(() => render(h(SecretInput, { value: "sk-abc", placeholder: "key", onInput() {} }), host));
    const input = () => host.querySelector("input");
    const eye = () => host.querySelector("button.secret-eye");
    assert.equal(input().type, "password", "hidden by default");
    assert.equal(eye().getAttribute("aria-pressed"), "false");
    assert.match(eye().getAttribute("aria-label"), /^Show/);
    await flush(() => eye().click());
    assert.equal(input().type, "text");
    assert.equal(input().value, "sk-abc");
    assert.equal(eye().getAttribute("aria-pressed"), "true");
    assert.match(eye().getAttribute("aria-label"), /^Hide/);
    await flush(() => eye().click());
    assert.equal(input().type, "password");
    assert.equal(input().value, "sk-abc");
});

test("the eye is a button that does not submit, and a disabled field disables it too", async () => {
    const host = doc.getElementById("root");
    await flush(() => { render(null, host); render(h(SecretInput, { value: "", disabled: true }), host); });
    assert.equal(host.querySelector("button.secret-eye").type, "button");
    assert.equal(host.querySelector("button.secret-eye").disabled, true);
});

// --- a value changed from outside hides the text again; typing does not ---

test("a value replaced from outside while the eye is on hides the text again; typing does not", async () => {
    const host = doc.getElementById("root");
    await flush(() => render(null, host));
    let value = "sk-abc";
    const draw = () => render(h(SecretInput, { value, onInput(e) { value = e.currentTarget.value; draw(); } }), host);
    await flush(draw);
    const input = () => host.querySelector("input");
    await flush(() => host.querySelector("button.secret-eye").click());
    assert.equal(input().type, "text");
    await flush(() => { input().value = "sk-abcd"; input().dispatchEvent(new doc.defaultView.Event("input", { bubbles: true })); });
    assert.equal(input().value, "sk-abcd");
    assert.equal(input().type, "text", "a keystroke does not hide it");
    value = "sk-from-the-popup"; await flush(draw);
    assert.equal(input().value, "sk-from-the-popup");
    assert.equal(input().type, "password", "a key written elsewhere is not drawn in the clear");
    await flush(() => host.querySelector("button.secret-eye").click());
    assert.equal(input().type, "text", "and the eye still works afterwards");
});
