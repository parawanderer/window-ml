// transcript-window.test.mjs — how much of a transcript is drawn (src/sidebar/transcript-window.tsx): the tail, growing
// it, what is held back, and `reveal` walking its three states (drawn, held but not drawn, older than what is loaded).
// The DOM here is a stub: what is under test is the arithmetic and the order things are tried in, not the scrolling.
import { test } from "node:test";
import assert from "node:assert/strict";

const W = await import("../src/sidebar/transcript/transcript-window.tsx");
const { installServices } = await import("../src/sidebar/services.ts");

const items = (n) => Array.from({ length: n }, (_, i) => `item${i}`);

/** The services seam with only what `reveal` reads. */
function host(loadEarlier) {
    installServices({
        sideCall: async () => ({ ok: false, error: "no" }), sideCalls: () => false, bench: false, answerApproval() {},
        sendToSession: async () => ({ ok: false, error: "no" }), cancelSession() {}, continueSession() {}, highlight() {},
        openLightbox() {}, hostAccess: null, sheetTitle: async () => null, savePref() {}, storedTable: null, loadEarlier,
    });
}

test("a transcript draws its newest window, and says how much it is holding back", () => {
    W.resetWindow("s1");
    assert.deepEqual(W.tail(items(3), "s1"), { drawn: ["item0", "item1", "item2"], hidden: 0 }, "a short session is drawn whole");
    const long = W.tail(items(W.WINDOW + 10), "s1");
    assert.equal(long.drawn.length, W.WINDOW);
    assert.equal(long.hidden, 10);
    assert.equal(long.drawn.at(-1), `item${W.WINDOW + 9}`, "the NEWEST items: a transcript is read from its end");
});

test("growing draws more, and a session closed and opened again is back to the newest window", () => {
    W.resetWindow("s2");
    W.tail(items(200), "s2");
    W.growWindow("s2");
    assert.equal(W.tail(items(200), "s2").drawn.length, W.WINDOW * 2);
    assert.equal(W.hiddenFor("s2"), 200 - W.WINDOW * 2);
    W.resetWindow("s2");
    assert.equal(W.tail(items(200), "s2").drawn.length, W.WINDOW);
});

test("a window is per session: growing one does not grow another", () => {
    W.resetWindow("a"); W.resetWindow("b");
    W.tail(items(200), "a"); W.tail(items(200), "b");
    W.growWindow("a");
    assert.equal(W.shownFor("a"), W.WINDOW * 2);
    assert.equal(W.shownFor("b"), W.WINDOW);
});

test("reveal: what is already drawn is found at once, and nothing is grown", async () => {
    W.resetWindow("r1");
    host(null);
    W.tail(items(200), "r1");
    const at = W.shownFor("r1");
    assert.equal(await W.reveal("r1", () => ({})), "shown");
    assert.equal(W.shownFor("r1"), at, "a reference to something on screen costs no growth");
});

test("reveal: something held but not drawn grows the window until it is", async () => {
    W.resetWindow("r2");
    host(null);
    const all = items(200);
    // The target is the 30th item: it is drawn once the window reaches 170 back from the end.
    let drawnNow = [];
    const draw = () => { drawnNow = W.tail(all, "r2").drawn; };
    draw();
    const found = () => (drawnNow.includes("item30") ? {} : (draw(), drawnNow.includes("item30") ? {} : null));
    assert.equal(await W.reveal("r2", found), "shown");
    assert.ok(W.shownFor("r2") >= 170, `grew to ${W.shownFor("r2")}`);
    assert.ok(W.shownFor("r2") <= 200 + W.WINDOW, "and no further than it had to");
});

test("reveal: something older than what is loaded pages the session back, then finds it", async () => {
    W.resetWindow("r3");
    let pages = 0;
    let loaded = items(60);
    host(async () => { pages++; loaded = [...items(60 - pages * 20), ...loaded]; return { more: pages < 3 }; });
    let drawn = [];
    const draw = () => { drawn = W.tail(loaded, "r3").drawn; };
    draw();
    const found = () => { draw(); return drawn.includes("older") ? {} : null; };
    // The target arrives with the second page.
    const realHost = async () => { pages++; if (pages === 2) loaded = ["older", ...loaded]; return { more: pages < 4 }; };
    host(realHost);
    assert.equal(await W.reveal("r3", found), "shown");
    assert.equal(pages, 2, "it stopped asking as soon as the step turned up");
});

test("reveal: a step nothing can produce is reported gone, never silently ignored", async () => {
    W.resetWindow("r4");
    let pages = 0;
    host(async () => { pages++; return { more: pages < 3 }; });
    assert.equal(await W.reveal("r4", () => null), "gone");
    assert.equal(pages, 3, "every page was asked for before giving up");
    // And with a host that cannot page at all (the extension panel), it gives up at once rather than looping.
    host(null);
    assert.equal(await W.reveal("r4", () => null), "gone");
});

test("an item can weigh more than one, so a fold cannot smuggle a hundred turns past the window", () => {
    // The budget is about what a transcript COSTS TO DRAW, not how many rows it has. A folded run of tool calls is
    // one row on screen and its own length in DOM the moment somebody opens it, so counting it as one item let a
    // hundred and forty turns through the guard that exists to stop exactly that.
    const items = [{ w: 1 }, { w: 1 }, { w: W.WINDOW * 3 }, { w: 1 }];
    const { drawn, hidden } = W.tail(items, "wgt", (i) => i.w);
    assert.deepEqual(drawn, [{ w: 1 }], "the heavy one does not fit, so neither does anything above it");
    assert.equal(hidden, 3);
    // Unweighted callers are untouched: every item weighs one and this is the slice it always was.
    assert.equal(W.tail(items, "wgt2").drawn.length, 4);
});

test("one item heavier than the whole budget is still drawn — never an empty transcript", () => {
    const { drawn, hidden } = W.tail([{ w: 1 }, { w: W.WINDOW * 20 }], "wgt3", (i) => i.w);
    assert.deepEqual(drawn, [{ w: W.WINDOW * 20 }], "the thing you are looking at is the one thing that must be there");
    assert.equal(hidden, 1);
});

// --- infinite scroll upward: the window grows from a sentinel and holds the reader's position ---

test("growHolding draws a window more and queues nothing to run until the edge's layout effect asks", () => {
    W.resetWindow("g1");
    W.tail(items(200), "g1");
    W.growHolding("g1", null);
    assert.equal(W.shownFor("g1"), W.WINDOW * 2, "one more window per growth");
    assert.equal(W.tail(items(200), "g1").hidden, 200 - W.WINDOW * 2);
});

test("a held position is restored by the measured delta, the way a browser with no scroll anchoring needs", () => {
    // A stub scroller whose content grows by 3000 px above the reader, who was at 120.
    const scroller = { scrollHeight: 5000, scrollTop: 120, clientHeight: 800, parentElement: null, isScroller: true };
    const child = { parentElement: scroller };
    const saved = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (p) => ({ overflowY: p.isScroller ? "auto" : "visible" });
    try {
        const restore = W.holdPosition(child);
        scroller.scrollHeight = 8000;
        restore();
        assert.equal(scroller.scrollTop, 120 + 3000, "the reader stays on the same text");
    } finally { globalThis.getComputedStyle = saved; }
});

test("the window says when it is drained, so the store may be asked for older pages", () => {
    const seen = [];
    const off = W.onWindowDrained((k) => seen.push(k));
    off();
    assert.deepEqual(seen, [], "unsubscribing works; the layout effect is what fires it, covered by chat-scroll.spec");
    assert.ok(W.EARLIER_MARGIN_PX >= 400, "the margin outruns a flick");
});
