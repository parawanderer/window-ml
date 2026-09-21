// transcript-window.test.mjs — how much of a transcript is drawn (src/sidebar/transcript-window.tsx): the tail, growing
// it, what is held back, and `reveal` walking its three states (drawn, held but not drawn, older than what is loaded).
// The DOM here is a stub: what is under test is the arithmetic and the order things are tried in, not the scrolling.
import { test } from "node:test";
import assert from "node:assert/strict";

const W = await import("../src/sidebar/transcript-window.tsx");
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
