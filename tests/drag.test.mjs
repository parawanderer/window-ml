// followDrag (src/sidebar/drag.ts): a resize handle's drag ends however the pointer does — an up, a cancel, lost
// capture, or a move with no button held — and ends exactly once. The last three were how the bench's divider stuck
// to the mouse.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><div id=h></div>");
globalThis.window = dom.window;
const { followDrag } = await import("../src/sidebar/drag.ts");

/** A pointer event with the fields followDrag reads (jsdom has no PointerEvent). */
function pev(type, { buttons = 1, clientY = 0, pointerId = 1, target } = {}) {
    const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, buttons, clientY });
    Object.defineProperty(e, "pointerId", { value: pointerId });
    if (target) Object.defineProperty(e, "currentTarget", { value: target });
    return e;
}

function start() {
    const el = dom.window.document.getElementById("h");
    const moves = [];
    let ends = 0;
    followDrag(pev("pointerdown", { target: el }), (ev) => moves.push(ev.clientY), () => ends++);
    return { el, moves, ends: () => ends };
}

for (const [name, finish] of [
    ["a pointerup", (el) => dom.window.dispatchEvent(pev("pointerup", { buttons: 0 }))],
    ["a pointercancel", (el) => dom.window.dispatchEvent(pev("pointercancel", { buttons: 0 }))],
    ["losing capture", (el) => el.dispatchEvent(pev("lostpointercapture", { buttons: 0 }))],
    ["a move with no button held (the up went missing)", (el) => dom.window.dispatchEvent(pev("pointermove", { buttons: 0, clientY: 99 }))],
]) {
    test(`a drag ends on ${name}, once, and follows nothing after`, () => {
        const d = start();
        dom.window.dispatchEvent(pev("pointermove", { clientY: 10 }));
        finish(d.el);
        dom.window.dispatchEvent(pev("pointermove", { clientY: 20 }));
        dom.window.dispatchEvent(pev("pointerup", { buttons: 0 }));
        assert.deepEqual(d.moves, [10]);
        assert.equal(d.ends(), 1);
    });
}

test("another pointer's moves are not this drag's", () => {
    const d = start();
    dom.window.dispatchEvent(pev("pointermove", { clientY: 5, pointerId: 2 }));
    dom.window.dispatchEvent(pev("pointermove", { clientY: 7 }));
    dom.window.dispatchEvent(pev("pointerup", { buttons: 0 }));
    assert.deepEqual(d.moves, [7]);
});
