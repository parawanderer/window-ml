// live-hold.test.mjs — how long a tool call that was being written stays on screen in the calm chat, and what waits for it;
// plus the step that stays open for a command waiting on the person, and what a waiting step's dot says.

import { test, before } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, hold, store, host;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter });
    host = dom.window.document.getElementById("root");
    ({ h, render } = require_("preact"));
    hold = await import("../src/sidebar/transcript/live-hold.tsx");
    store = await import("../src/sidebar/store.ts");
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Start from nothing on screen, in the calm view. */
const reset = (calm = true) => { store.focusMode.value = calm; for (let i = 0; i < 20; i++) hold.liveUnmounted(); hold.liveMounted(0); hold.liveUnmounted(); };

// --- how long a live call is owed ---
test("a call shown for a moment is owed the rest of the minimum, and one that took longer is owed nothing", () => {
    reset();
    const t0 = 1_000_000;
    hold.liveMounted(t0);
    assert.equal(hold.liveOwed(t0 + 300), hold.LIVE_MIN_MS - 300, "300 ms in: the rest of the minimum");
    assert.equal(hold.liveOwed(t0 + hold.LIVE_MIN_MS + 1), 0, "past it: nothing");
    hold.liveUnmounted();
    reset();
    const slow = Date.now() - 5000;                               // first shown five seconds ago
    hold.liveMounted(slow);
    assert.equal(hold.liveOwed(), 0, "a call that took longer to write than the minimum is not held");
    hold.liveUnmounted();
});

test("a second call drawn alongside the first does not restart the window; one that starts during the wait ends it", () => {
    reset();
    const t0 = Date.now();
    hold.liveMounted(t0);
    hold.liveMounted(t0 + 200);                                   // two calls of one turn, on screen together
    assert.equal(hold.liveOwed(t0 + 200), hold.LIVE_MIN_MS - 200, "counted from the FIRST of them");
    hold.liveUnmounted(); hold.liveUnmounted();                   // both went (the step replaced them)
    assert.ok(hold.liveOwed(t0 + 400) > 0, "still owed after they went");
    hold.liveMounted(t0 + 400);                                   // the next call begins to be written
    assert.equal(hold.liveOwed(t0 + 400), hold.LIVE_MIN_MS, "the old wait is over: the new call has its own window from now");
    hold.liveUnmounted();
});

test("nothing is held outside the calm view", () => {
    reset(false);
    hold.liveMounted(Date.now());
    assert.equal(hold.liveOwed(), 0);
    hold.liveUnmounted();
});

// --- the step that waits, and the live block that stays ---
const step = (o = {}) => ({ tool: "exec", pending: true, ...o });
const mountHeld = async (st) => { render(null, host); render(h(hold.HeldStep, { st }, h("b", { id: "step" }, "the step")), host); await wait(20); return host.querySelector("#step"); };

test("a pending step waits for the live call's time on screen, then appears; a settled step does not wait", async () => {
    reset();
    hold.liveMounted(Date.now() - (hold.LIVE_MIN_MS - 150));      // owed about 150 ms more
    assert.equal(await mountHeld(step()), null, "pending: not drawn yet");
    await wait(250);
    assert.ok(host.querySelector("#step"), "drawn once the time was served");
    assert.ok(await mountHeld(step({ pending: false, result: "ok" })), "a step that already finished is drawn at once");
    hold.liveUnmounted();
    render(null, host);
});

test("the live stream stays drawn as it last was for the time it is owed after the run dropped it, then goes", async () => {
    reset();
    const ls = { step: 1, calls: [{ index: 0, name: "exec", args: "{", chars: 1 }] };
    const view = (v) => h(hold.HeldLive, { ls: v, render: (x) => h("i", { id: "live" }, `calls:${x.calls.length}`) });
    hold.liveMounted(Date.now() - (hold.LIVE_MIN_MS - 150));
    render(view(ls), host); await wait(20);
    assert.equal(host.querySelector("#live")?.textContent, "calls:1");
    render(view(null), host); await wait(20);                     // the reducer cleared it
    assert.equal(host.querySelector("#live")?.textContent, "calls:1", "held while time is owed");
    await wait(250);
    assert.equal(host.querySelector("#live"), null, "gone once it was served");
    hold.liveUnmounted();
    render(null, host);
});

// --- the wiring, pinned at the source ---
test("a code step holds itself open for a command waiting on the person, and the dot and its tip say whose turn it is", () => {
    const rd = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
    const ad = rd("../src/sidebar/transcript/agent-detail.tsx");
    assert.match(ad, /const holdsForAsk = askWaiting && !!codeOf\(st\) && focusMode\.value;/);
    assert.match(ad, /const forcedOpen = \(awaiting && !\(intent && !codeOf\(st\) && focusMode\.value\)\) \|\| holdsForAsk;/);
    assert.match(ad, /if \(holdsForAsk\) \{ closeOnSettle\.current = true; setExpanded\(true\); \}/, "and it stays open once answered, folding when the step settles");
    assert.match(ad, /Waiting for your approval to run it\./);
    assert.match(ad, /waiting for your answer to the command it started/);
    assert.match(rd("../src/chat/chat.css"), /\.chat\.calm, html\[data-calm\] \{ --notice: var\(--accent\); --notice-fg: var\(--accent-fg\); --busy: var\(--accent\); \}/, "--busy is blue where the tooltip layer (outside .chat) reads it");
    assert.match(rd("../src/sidebar/transcript/live-call.tsx"), /fold-rail fold-rail-still/, "the live call wears the rail, still");
});
