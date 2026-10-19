// reply-arrival.test.mjs — a reply ARRIVING while you watch grows into place (`useReplyArrival`, src/sidebar/transcript/reply.tsx):
// which arrivals play it, which do not, and that a surface that sets no duration draws it in one frame as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
// jsdom has neither the Web Animations API nor custom properties in computed style: record the animations, and say
// the surface's duration is `arriveMs` (0 is the panel, which sets none).
let arriveMs = 260;
const played = [];
dom.window.HTMLElement.prototype.animate = function (frames) { played.push({ el: this.className, frames }); return { cancel() {} }; };
globalThis.getComputedStyle = (el) => ({ getPropertyValue: (p) => (p === "--asst-arrive-ms" ? String(arriveMs) : ""), marginBottom: "26px" });
const { h, render } = createRequire(import.meta.url)("preact");
const { ReplyBubble } = await import("../src/sidebar/transcript/reply.tsx");
const { HistoryPaint } = await import("../src/sidebar/transcript/history-paint.ts");
const flush = () => new Promise((r) => setTimeout(r, 10));

/** Draw a reply, then redraw it with `next` props; returns the animations each draw played. */
async function drawn(props, next, history = false) {
    played.length = 0;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const at = (p) => h(HistoryPaint.Provider, { value: history }, h(ReplyBubble, { model: "m", profile: null, ts: Date.now(), ...p }));
    render(at(props), root);
    await flush();
    const first = played.splice(0).map((a) => a.el);
    if (next) { render(at({ ...props, ...next }), root); await flush(); }
    return { first, then: played.splice(0).map((a) => a.el) };
}

// --- which arrivals grow into place ---

test("a reply mounted in front of you grows in from nothing, the placeholder beside your message included", async () => {
    const { first } = await drawn({ content: "", status: "pending" });
    assert.deepEqual(first, ["msg asst pending"]);
});

test("a placeholder replaced by the whole reply grows its body from the placeholder's height", async () => {
    const { then } = await drawn({ content: "", status: "pending" }, { content: "The answer.", status: "ok" });
    assert.deepEqual(then, ["asst-body"]);
});

test("a reply that streamed does not grow again when it settles: it has been arriving all along", async () => {
    played.length = 0;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const at = (p) => h(ReplyBubble, { model: "m", profile: null, ts: Date.now(), ...p });
    render(at({ content: "", status: "pending" }), root); await flush();
    render(at({ content: "The ans", status: "ok", streaming: true }), root); await flush();
    played.length = 0;
    render(at({ content: "The answer.", status: "ok" }), root); await flush();
    assert.deepEqual(played, []);
});

// --- what never animates ---

test("history is drawn, not performed: an old reply, and one mounted in a transcript's first paint", async () => {
    assert.deepEqual((await drawn({ content: "Old.", status: "ok", ts: Date.now() - 60_000 })).first, []);
    assert.deepEqual((await drawn({ content: "New.", status: "ok" }, null, true)).first, []);
});

test("a surface that sets no duration (the panel) draws every arrival in one frame, as it always has", async () => {
    arriveMs = 0;
    try {
        const { first, then } = await drawn({ content: "", status: "pending" }, { content: "The answer.", status: "ok" });
        assert.deepEqual([...first, ...then], []);
    } finally { arriveMs = 260; }
});
