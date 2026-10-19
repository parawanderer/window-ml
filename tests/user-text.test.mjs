// user-text.test.mjs — a long message you sent is FOLDED (src/sidebar/user-text.tsx): its first lines and a chevron that
// opens it, decided by the drawn height, and a short one is drawn as it is. The images sent with it sit under it as tiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, getComputedStyle: dom.window.getComputedStyle, HTMLElement: dom.window.HTMLElement });
// Through require, NOT `import("preact")`: tsx compiles the component to CJS, and an ESM import here would be a second
// preact whose hooks have no current component (as tests/output-cell.test.mjs says).
const { h, render } = createRequire(import.meta.url)("preact");
const { UserText, SentImages, ArrivingMsg } = await import("../src/sidebar/transcript/user-text.tsx");
const { HistoryPaint } = await import("../src/sidebar/transcript/history-paint.ts");
const flush = () => new Promise((r) => setTimeout(r, 10));

/** Draw it with the text's height FAKED, since jsdom lays nothing out: `lines` lines of 20px. */
async function drawn(text, lines) {
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return this.classList.contains("utext") ? lines * 20 : 0; } });
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.style.lineHeight = "20px";
    render(h(UserText, { text }), root);
    await flush();
    return root;
}

test("a short message is drawn as it is: no fold, no button", async () => {
    const r = await drawn("hi", 3);
    assert.equal(r.querySelector(".utext.folded"), null);
    assert.equal(r.querySelector(".utext-more"), null);
});

test("a message only just past the limit is not folded: hiding a line or two costs a click for nothing", async () => {
    const r = await drawn("x", 10);
    assert.equal(r.querySelector(".utext-more"), null);
});

test("a long one folds, and its chevron opens it and folds it again, saying which it does", async () => {
    const r = await drawn("a pasted log", 60);
    const btn = r.querySelector(".utext-more");
    assert.ok(r.querySelector(".utext.folded"), "folded");
    assert.equal(btn.getAttribute("aria-expanded"), "false");
    assert.match(btn.getAttribute("aria-label"), /Show all/);
    btn.click();
    await flush();
    assert.equal(r.querySelector(".utext.folded"), null, "open");
    assert.equal(r.querySelector(".utext-more").getAttribute("aria-expanded"), "true");
    assert.match(r.querySelector(".utext-more").getAttribute("aria-label"), /Show less/);
    r.querySelector(".utext-more").click();
    await flush();
    assert.ok(r.querySelector(".utext.folded"), "folded again");
});

test("the images sent with a message are tiles, one per image, and none when there are none", async () => {
    const root = document.createElement("div");
    render(h(SentImages, { images: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="] }), root);
    assert.equal(root.querySelectorAll(".sent-tiles img").length, 2);
    render(h(SentImages, { images: [] }), root);
    assert.equal(root.querySelector(".sent-tiles"), null);
});

// --- a message arriving: the wrapper the reading view grows it up in (chat.css, `.msg-arrive`) ---

/** Draw a message stamped `ts` through ArrivingMsg, optionally as part of a transcript's first paint. */
async function arriving(ts, history = false) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(h(HistoryPaint.Provider, { value: history }, h(ArrivingMsg, { ts }, h("div", { class: "msg user" }, "hi"))), root);
    await flush();
    return root;
}

test("a message that just arrived is wrapped to grow, and the growing layout comes off when its animation ends", async () => {
    const r = await arriving(Date.now());
    const w = r.querySelector(".msg-arrive");
    assert.ok(w?.classList.contains("growing"));
    // Preact listens for `animationend` where the element knows it (every browser) and the prop's own case where it
    // does not (jsdom): send the one it chose.
    const end = "onanimationend" in w ? "animationend" : "AnimationEnd";
    w.querySelector(".msg").dispatchEvent(new dom.window.Event(end, { bubbles: true }));
    await flush();
    assert.ok(w.classList.contains("growing"), "the bubble's own animation ending is not the wrapper's");
    w.dispatchEvent(new dom.window.Event(end, { bubbles: true }));
    await flush();
    assert.equal(w.classList.contains("growing"), false);
});

test("history is drawn bare: an old message, and a new one mounted in a transcript's first paint", async () => {
    for (const r of [await arriving(Date.now() - 60_000), await arriving(Date.now(), true), await arriving(undefined)]) {
        assert.equal(r.querySelector(".msg-arrive"), null);
        assert.ok(r.querySelector(".msg.user"));
    }
});
