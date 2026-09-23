// What a press inside the phone's WebView feels like (src/native/tap-feedback.ts). The page cannot vibrate a
// phone, so it tells the app that a control was pressed and the app gives the tick; this is the decision about WHICH
// presses count, which is the part that can be wrong in a way no screenshot shows.
//
// The failure being guarded is a phone that buzzes when a thumb goes down to scroll, or one that answers a finger on
// a control that is refusing it — both say something happened when nothing did.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let tapKind, doc;
before(async () => {
    doc = new JSDOM("<!doctype html><body></body>").window.document;
    ({ tapKind } = await import("../src/native/tap-feedback.ts"));
});

/** Put `html` in the body and return the element matching `sel` — what a thumb would have landed on. */
const at = (html, sel) => { doc.body.innerHTML = html; return doc.querySelector(sel); };

test("a press on a control ticks; one on the words does not", () => {
    assert.equal(tapKind(at("<button>Send</button>", "button")), "select");
    assert.equal(tapKind(at('<a href="https://x.test/">a link</a>', "a")), "select");
    assert.equal(tapKind(at('<div role="option">a model</div>', '[role=option]')), "select");
    assert.equal(tapKind(at("<details><summary>options</summary></details>", "summary")), "select");
    // The transcript is the whole screen and is scrolled constantly: nothing here may answer a finger.
    assert.equal(tapKind(at("<p>an answer the model wrote</p>", "p")), null);
    assert.equal(tapKind(at('<div class="chat-transcript"><span>text</span></div>', "span")), null);
    assert.equal(tapKind(at('<a>not a link, just an anchor</a>', "a")), null);
    assert.equal(tapKind(null), null);
});

test("the control is found by walking UP: a thumb lands on the icon, not the button", () => {
    // Every control in this app is a glyph or a label inside a button, so the target is almost never the button.
    assert.equal(tapKind(at("<button><svg><path/></svg></button>", "path")), "select");
    assert.equal(tapKind(at('<button class="csend"><span>Send</span></button>', "span")), "impact");
});

test("a control that is refusing the press stays silent", () => {
    // Saying "that worked" with a buzz, when the button does nothing, is worse than saying nothing.
    assert.equal(tapKind(at("<button disabled>Send</button>", "button")), null);
    assert.equal(tapKind(at('<button aria-disabled="true">Edit</button>', "button")), null);
    // …including when the thumb lands on what is inside it.
    assert.equal(tapKind(at('<button disabled><span>Send</span></button>', "span")), null);
});

test("starting something is heavier than choosing something", () => {
    // Send, stop, continue, resume and an inbox's fix all START work; picking a row from a list does not.
    for (const cls of ["csend", "cstop", "continue-run", "chat-resume", "chat-att-fix"])
        assert.equal(tapKind(at(`<button class="${cls}">go</button>`, "button")), "impact", cls);
    assert.equal(tapKind(at('<button class="btn primary">Resume</button>', "button")), "impact");
    assert.equal(tapKind(at('<button class="btn">Cancel</button>', "button")), "select", "the quiet half of a dialog is a choice");
    assert.equal(tapKind(at('<button class="tp-row">qwen3:32b</button>', "button")), "select");
});
