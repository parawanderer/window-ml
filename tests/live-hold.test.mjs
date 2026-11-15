// live-hold.test.mjs — how long a tool call that was being written stays on screen in the calm chat, and what waits for it;
// plus the step that stays open for a command waiting on the person, and what a waiting step's dot says.

import { test, before } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, hold, store, host, useLayoutEffect;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter });
    host = dom.window.document.getElementById("root");
    ({ h, render } = require_("preact"));
    ({ useLayoutEffect } = require_("preact/hooks"));
    hold = await import("../src/sidebar/transcript/live-hold.tsx");
    store = await import("../src/sidebar/store.ts");
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Start from nothing on screen, in the calm view. */
const reset = (calm = true) => { store.focusMode.value = calm; for (let i = 0; i < 10; i++) hold.liveUnmounted(i); hold.liveMounted(0, 0); hold.liveUnmounted(0); };

// --- how long a live call is owed ---
test("a call shown for a moment is owed the rest of the minimum, and one that took longer is owed nothing", () => {
    reset();
    const t0 = 1_000_000;
    hold.liveMounted(0, t0);
    assert.equal(hold.liveOwed(t0 + 300), hold.LIVE_MIN_MS - 300, "300 ms in: the rest of the minimum");
    assert.equal(hold.liveOwed(t0 + hold.LIVE_MIN_MS + 1), 0, "past it: nothing");
    hold.liveUnmounted(0);
    reset();
    const slow = Date.now() - 5000;                               // first shown five seconds ago
    hold.liveMounted(0, slow);
    assert.equal(hold.liveOwed(), 0, "a call that took longer to write than the minimum is not held");
    hold.liveUnmounted(0);
});

test("a second call drawn alongside the first does not restart the window; one that starts during the wait ends it", () => {
    reset();
    const t0 = Date.now();
    hold.liveMounted(0, t0);
    hold.liveMounted(1, t0 + 200);                                   // two calls of one turn, on screen together
    assert.equal(hold.liveOwed(t0 + 200), hold.LIVE_MIN_MS - 200, "counted from the FIRST of them");
    hold.liveUnmounted(0); hold.liveUnmounted(1);                // both went (the step replaced them)
    assert.ok(hold.liveOwed(t0 + 400) > 0, "still owed after they went");
    hold.liveMounted(0, t0 + 400);                                // the next call begins to be written
    assert.equal(hold.liveOwed(t0 + 400), hold.LIVE_MIN_MS, "the old wait is over: the new call has its own window from now");
    hold.liveUnmounted(0);
});

test("nothing is held outside the calm view", () => {
    reset(false);
    hold.liveMounted(0, Date.now());
    assert.equal(hold.liveOwed(), 0);
    hold.liveUnmounted(0);
});

// --- the step that waits, and the live block that stays ---
const step = (o = {}) => ({ tool: "exec", pending: true, ...o });
const mountHeld = async (st, slot = 1) => { render(null, host); render(h(hold.HeldStep, { st, slot }, h("b", { id: "step" }, "the step")), host); await wait(20); return host.querySelector("#step"); };

test("a pending step waits for the live call's time on screen, then appears; a settled step does not wait", async () => {
    reset();
    hold.liveMounted(0, Date.now() - (hold.LIVE_MIN_MS - 150));  // owed about 150 ms more; the step is the call after it, which has no cell of its own
    assert.equal(await mountHeld(step()), null, "pending: not drawn yet");
    await wait(250);
    assert.ok(host.querySelector("#step"), "drawn once the time was served");
    assert.ok(await mountHeld(step({ pending: false, result: "ok" })), "a step that already finished is drawn at once");
    hold.liveUnmounted(0);
    render(null, host);
});

test("a pending step also waits for ITS OWN cell to leave the page, and a step that has only just started waits too", async () => {
    reset();
    hold.liveMounted(0, Date.now() - 5000);                       // its time is served; the cell is still drawn
    assert.equal(await mountHeld(step(), 0), null, "its cell is still on the page");
    hold.liveUnmounted(0);
    assert.ok(await mountHeld(step(), 0), "the cell has gone: drawn");
    hold.liveMounted(0, Date.now() - 5000);
    render(null, host);
    render(h(hold.HeldStep, { st: step(), slot: 0, young: true }, h("b", { id: "step" }, "the step")), host); await wait(20);
    assert.equal(host.querySelector("#step"), null, "only just started, and not yet said whether it will ask: the cell stays");
    hold.liveUnmounted(0);
    render(null, host);
});

test("a held live stream folds away when no step opens to take it, and stays gone", async () => {
    reset();
    const ls = { step: 1, calls: [{ index: 0, name: "exec", args: "{", chars: 1 }] };
    const view = (v) => h(hold.HeldLive, { ls: v, landed: () => 1, render: (x) => h("i", { id: "live" }, `calls:${x.calls.length}`) });
    hold.liveMounted(0, Date.now() - (hold.LIVE_MIN_MS - 150));
    render(view(ls), host); await wait(20);
    assert.equal(host.querySelector("#live")?.textContent, "calls:1");
    render(view(null), host); await wait(20);                     // the reducer cleared it
    assert.equal(host.querySelector("#live")?.textContent, "calls:1", "held while time is owed");
    assert.ok(!host.querySelector(".live-leaving"), "and not folding yet");
    await wait(220);                                              // the time is served
    assert.ok(host.querySelector(".live-leaving #live"), "served, and no step opens: it folds, still drawn while it does");
    await wait(hold.LIVE_LEAVE_MS + 120);
    assert.equal(host.querySelector("#live"), null, "gone once it has folded");
    hold.liveUnmounted(0);
    render(null, host);
});

test("a held live stream goes at once when a step is opening to take its characters, and the step draws only after it has gone", async () => {
    reset();
    const ls = { step: 1, calls: [{ index: 0, name: "exec", args: "{", chars: 1 }] };
    const gated = { tool: "exec", pending: true, awaitingApproval: true };
    const tree = (v) => h("div", null,
        h(hold.HeldStep, { st: gated, slot: 0 }, h("b", { id: "step" }, "the step")),     // the step sits above the live block, as on the page
        h(hold.HeldLive, { ls: v, landed: () => 1, render: (x) => h(Cell, { n: x.calls.length }) }));
    const startedAt = Date.now() - (hold.LIVE_MIN_MS - 150);
    // A cell as the page draws one: it tells the hold it is on screen when it mounts, and that it is gone when it unmounts.
    const Cell = ({ n }) => { useLayoutEffect(() => { hold.liveMounted(0, startedAt); return () => hold.liveUnmounted(0); }, []); return h("i", { id: "live" }, `calls:${n}`); };
    render(tree(ls), host); await wait(10);
    render(tree(null), host);                                     // the step has landed (awaiting you): it opens, so the code flies
    // The ORDER the page changes in, which polling cannot see (both can change in one task): the live block must be removed before the
    // step is added, or the step's flight has no hand-over from the block's characters to start from.
    const order = [];
    const mo = new window.MutationObserver((records) => {
        for (const r of records) {
            for (const n of r.removedNodes) if (n.querySelector?.("#live") || n.id === "live") order.push("live removed");
            for (const n of r.addedNodes) if (n.id === "step" || n.querySelector?.("#step")) order.push("step added");
        }
    });
    mo.observe(host, { childList: true, subtree: true });
    const seen = [];
    for (let i = 0; i < 40; i++) { await wait(10); seen.push({ step: !!host.querySelector("#step"), live: !!host.querySelector("#live"), folding: !!host.querySelector(".live-leaving") }); }
    assert.ok(seen.some((f) => f.live && !f.step), "the live block stood first, with the step waiting");
    assert.ok(seen.some((f) => f.step && !f.live), "then the step, with the block gone");
    assert.ok(!seen.some((f) => f.step && f.live), "never both: the step mounting beside a block that has not left gave the flight nothing to start from");
    assert.ok(!seen.some((f) => f.folding), "a step is opening to take the code, so the block does not fold: it goes");
    mo.disconnect();
    assert.ok(order.includes("live removed") && order.includes("step added"), `both happened: ${order.join(", ")}`);
    assert.ok(order.indexOf("live removed") < order.indexOf("step added"), `the block left before the step arrived (${order.join(" → ")})`);
    render(null, host);
});

// --- several calls in one turn ---
test("the calls that have no step yet stay where they are drawn, while the first one's step takes over", async () => {
    reset();
    const mk = (n) => ({ step: 1, calls: Array.from({ length: n }, (_, i) => ({ index: i, name: "exec", args: "{", chars: 1 })) });
    let have = 0;
    const startedAt = Date.now() - 5000;                          // served: nothing is owed
    const Cell = ({ i }) => { useLayoutEffect(() => { hold.liveMounted(i, startedAt); return () => hold.liveUnmounted(i); }, []); return h("i", { class: "cell", "data-i": i }, `c${i}`); };
    const view = (v) => h(hold.HeldLive, { ls: v, landed: () => have, render: (x, rest) => h("div", { class: rest ? "rest" : "whole" }, x.calls.map((c) => h(Cell, { key: c.index, i: c.index }))) });
    const tree = (v, stepIn) => h("div", null, stepIn ? h(hold.HeldStep, { st: { tool: "exec", pending: true, awaitingApproval: true }, slot: 0 }, h("b", { id: "step" }, "the step")) : null, view(v));
    render(tree(mk(2)), host); await wait(20);
    assert.deepEqual([...host.querySelectorAll(".cell")].map((e) => e.dataset.i), ["0", "1"]);
    // The thought lands first and clears the stream: no call has a step yet, and neither cell goes.
    render(tree(null), host); await wait(20);
    assert.deepEqual([...host.querySelectorAll(".cell")].map((e) => e.dataset.i), ["0", "1"], "no step has landed: both stay");
    assert.ok(host.querySelector(".rest"), "drawn as the calls the turn's own rows do not hold");
    // The first call's step lands, awaiting approval: its cell goes and the second stays, the same element.
    const second = host.querySelector('.cell[data-i="1"]');
    have = 1; render(tree(null, true), host); await wait(30);
    assert.deepEqual([...host.querySelectorAll(".cell")].map((e) => e.dataset.i), ["1"], "the first's cell has gone, the second stays");
    assert.equal(host.querySelector('.cell[data-i="1"]'), second, "the second cell was not drawn again");
    // The second's step lands: nothing is left to hold.
    have = 2; render(tree(null, true), host); await wait(hold.LIVE_LEAVE_MS + 80);
    assert.equal(host.querySelectorAll(".cell").length, 0, "both have a step: the block is gone");
    render(null, host);
});

// --- the wiring, pinned at the source ---
test("a code step holds itself open for a command waiting on the person, and the dot and its tip say whose turn it is", () => {
    const rd = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
    const ad = rd("../src/sidebar/transcript/agent-detail.tsx");
    assert.match(ad, /const holdsForAsk = askWaiting && !!codeOf\(st\);/, "in every view, not only the reading one");
    assert.match(ad, /const forcedOpen = \(awaiting && !\(intent && !codeOf\(st\) && focusMode\.value\)\) \|\| holdsForAsk;/);
    assert.match(ad, /if \(holdsForAsk\) \{ if \(focusMode\.value\) closeOnSettle\.current = true; setExpanded\(true\); \}/, "and it stays open once answered; only the reading view folds it when the step settles");
    assert.match(ad, /Waiting for your approval to run it\./);
    assert.match(ad, /waiting for your answer to the command it started/);
    assert.match(rd("../src/chat/chat.css"), /html\[data-calm\] \.tt-layer \{ --notice: var\(--accent\); --notice-fg: var\(--accent-fg\); --busy: var\(--accent\); \}/, "--busy is blue where the tooltip layer (outside .chat) reads it, and only there");
    assert.match(rd("../src/sidebar/transcript/live-call.tsx"), /fold-rail fold-rail-still/, "the live call wears the rail, still");
});
