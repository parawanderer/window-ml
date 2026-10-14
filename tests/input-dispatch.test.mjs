"use strict";
// W3C pointer/keyboard event property mapping (src/input-dispatch.ts): the keyboard code table and the
// per-stage builders behind CDP Input.dispatch*Event and the synthetic DOM path. Asserts the emitted
// parameters carry the fields a hardware mouse/keyboard produces — pressure, `code`/`keyCode`/`which`,
// button/bitmask per lifecycle stage — not the empty-field synthetic defaults.
import { test } from "node:test";
import assert from "node:assert";
import {
    keyPress, fallbackPress, typeSteps, cdpMouseEvent, cdpClickPlan, cdpKeyEvent, cdpTypePlan,
    pointerInit, mouseInit, syntheticClickPlan, keyInit,
} from "../src/input-dispatch.ts";

// --- keyboard code table: key / code / keyCode / which cross-map like a hardware keyboard ---

test("letters cross-map: key, code, keyCode (Windows VK), and `which`'s number", () => {
    const h = keyPress("h");
    assert.deepEqual({ key: h.key, code: h.code, keyCode: h.keyCode, which: h.keyCode, text: h.text }, {
        key: "h", code: "KeyH", keyCode: 72, which: 72, text: "h",
    });
    const up = keyPress("H");
    assert.equal(up.key, "H");
    assert.equal(up.code, "KeyH", "same physical key");
    assert.equal(up.keyCode, 72);
    assert.equal(up.shift, true, "a capital is the shifted form");
    assert.equal(up.text, "H");
    assert.equal(up.unmodifiedText, "h", "unmodifiedText is the unshifted character");
});

test("Enter is the documented triple: key \"Enter\", code \"Enter\", keyCode 13", () => {
    const e = keyPress("Enter");
    assert.deepEqual({ key: e.key, code: e.code, keyCode: e.keyCode, text: e.text }, {
        key: "Enter", code: "Enter", keyCode: 13, text: "\r",
    });
    assert.equal(keyPress("\n")?.code, "Enter", "a newline types as Enter");
    assert.equal(keyPress("\r")?.code, "Enter");
});

test("digits and punctuation map to their physical keys, shifted forms included", () => {
    const one = keyPress("1");
    assert.deepEqual({ key: one.key, code: one.code, keyCode: one.keyCode }, { key: "1", code: "Digit1", keyCode: 49 });
    const bang = keyPress("!");
    assert.deepEqual({ key: bang.key, code: bang.code, keyCode: bang.keyCode, shift: bang.shift }, {
        key: "!", code: "Digit1", keyCode: 49, shift: true,
    });
    assert.equal(bang.unmodifiedText, "1");
    assert.equal(keyPress("-")?.code, "Minus");
    assert.equal(keyPress("_")?.code, "Minus");
    assert.equal(keyPress("_")?.shift, true);
});

test("named keys keep their left/right location and shared VK", () => {
    const sl = keyPress("ShiftLeft");
    assert.deepEqual({ key: sl.key, code: sl.code, keyCode: sl.keyCode, location: sl.location }, {
        key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1,
    });
    const sr = keyPress("ShiftRight");
    assert.equal(sr.location, 2);
    assert.equal(sr.keyCode, 16);
    assert.equal(keyPress("ArrowLeft")?.keyCode, 37);
    assert.equal(keyPress("F5")?.keyCode, 116);
    assert.equal(keyPress("Escape")?.text, "", "a non-printing key inserts nothing");
});

test("a code point the US layout does not name falls back to the IME shape (code \"\" is then honest)", () => {
    const p = fallbackPress("é");
    assert.equal(p.key, "é");
    assert.equal(p.code, "");
    assert.equal(p.text, "é");
    assert.equal(keyPress("é"), null, "not in the table");
    assert.equal(keyPress("中"), null);
});

// --- typing sequences: Shift holds around shifted characters ---

test("typeSteps holds Shift around a capital and releases it after, like hardware", () => {
    assert.deepEqual(typeSteps("Hi").map(s => [s.kind, s.spec.key, s.spec.shift]), [
        ["hold", "Shift", false],
        ["press", "H", true],
        ["release", "Shift", false],
        ["press", "i", false],
    ]);
});

test("typeSteps ends with Enter only when submit is asked for", () => {
    assert.equal(typeSteps("a").some(s => s.spec.key === "Enter"), false);
    const sub = typeSteps("a", true);
    assert.deepEqual(sub.map(s => [s.kind, s.spec.key]), [["press", "a"], ["press", "Enter"]]);
});

// --- CDP mouse parameters: pressure dynamics and button/bitmask per stage ---

test("a CDP click is move → press → release, each stage with the hardware button state", () => {
    const plan = cdpClickPlan(120, 340);
    assert.deepEqual(plan.map(p => p.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
    const [move, press, release] = plan;
    for (const p of plan) {
        assert.equal(p.x, 120);
        assert.equal(p.y, 340);
        assert.equal(p.pointerType, "mouse");
    }
    assert.deepEqual({ button: move.button, buttons: move.buttons, force: move.force }, {
        button: "none", buttons: 0, force: 0,
    });
    assert.deepEqual({ button: press.button, buttons: press.buttons, clickCount: press.clickCount, force: press.force }, {
        button: "left", buttons: 1, clickCount: 1, force: 0.5,
    });
    assert.deepEqual({ button: release.button, buttons: release.buttons, clickCount: release.clickCount, force: release.force }, {
        button: "left", buttons: 0, clickCount: 1, force: 0,
    });
});

test("pressure is 0.5 only while the button is down (W3C: a mouse does not report pressure)", () => {
    assert.equal(cdpMouseEvent("mousePressed", 0, 0).force, 0.5);
    assert.equal(cdpMouseEvent("mouseReleased", 0, 0).force, 0);
    assert.equal(cdpMouseEvent("mouseMoved", 0, 0).force, 0);
});

// --- CDP key parameters: identifiers, modifiers, the standard firing order ---

test("a CDP keystroke carries key, code and the virtual key code together", () => {
    const down = cdpKeyEvent("down", keyPress("h"));
    assert.deepEqual({
        type: down.type, key: down.key, code: down.code,
        windowsVirtualKeyCode: down.windowsVirtualKeyCode,
        nativeVirtualKeyCode: down.nativeVirtualKeyCode,
        text: down.text,
    }, {
        type: "keyDown", key: "h", code: "KeyH",
        windowsVirtualKeyCode: 72, nativeVirtualKeyCode: 72,
        text: "h",
    });
    const up = cdpKeyEvent("up", keyPress("h"));
    assert.equal(up.type, "keyUp");
    assert.equal(up.code, "KeyH");
    assert.ok(!("text" in up), "a keyup does not insert a character");
});

test("a shifted character carries the Shift modifier bit on every call of its press", () => {
    const H = keyPress("H");
    const down = cdpKeyEvent("down", H, 8);
    assert.equal(down.modifiers, 8);
    assert.equal(down.text, "H");
    assert.equal(down.unmodifiedText, "h");
});

test("cdpTypePlan is keydown → keyup per key, with a Shift hold around a capital, Enter after submit", () => {
    const plan = cdpTypePlan("Hi!", true);
    assert.deepEqual(plan.map(p => [p.type, p.key, p.modifiers ?? 0]), [
        ["keyDown", "Shift", 8],
        ["keyDown", "H", 8],
        ["keyUp", "H", 8],
        ["keyUp", "Shift", 0],
        ["keyDown", "i", 0],
        ["keyUp", "i", 0],
        ["keyDown", "Shift", 8],
        ["keyDown", "!", 8],
        ["keyUp", "!", 8],
        ["keyUp", "Shift", 0],
        ["keyDown", "Enter", 0],
        ["keyUp", "Enter", 0],
    ]);
    // The required standard firing order a press produces in the page: keydown → beforeinput → input → keyup
    // (the browser adds the legacy keypress for a printable; CDP only chooses the down/up pair).
    const chars = plan.filter(p => p.type === "keyDown" && p.text).map(p => p.text);
    assert.deepEqual(chars, ["H", "i", "!", "\r"], "each press carries the character it inserts");
});

test("cdpTypePlan for a plain lowercase string is the minimal down/up pair per character", () => {
    assert.deepEqual(cdpTypePlan("hi").map(p => [p.type, p.key, p.code]), [
        ["keyDown", "h", "KeyH"], ["keyUp", "h", "KeyH"],
        ["keyDown", "i", "KeyI"], ["keyUp", "i", "KeyI"],
    ]);
});

// --- synthetic DOM inits: the same stages, with the event properties set explicitly ---

test("a synthetic click plan is move → down → up → click with pressure / button / buttons / detail", () => {
    const plan = syntheticClickPlan(10, 20, 110, 220, { x: 0, y: 0 });
    assert.deepEqual(plan.map(s => s.type), ["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    const down = plan.find(s => s.type === "pointerdown").init;
    assert.equal(down.pressure, 0.5);
    assert.equal(down.pointerType, "mouse");
    assert.equal(down.button, 0);
    assert.equal(down.buttons, 1);
    assert.equal(down.detail, 1);
    assert.deepEqual([down.bubbles, down.cancelable, down.composed], [true, true, true]);
    assert.deepEqual([down.clientX, down.clientY, down.screenX, down.screenY], [10, 20, 110, 220]);
    const moveIn = plan.find(s => s.type === "pointermove").init;
    assert.deepEqual([moveIn.movementX, moveIn.movementY], [10, 20], "the move into the point is the prior-state delta");
    assert.deepEqual([down.movementX, down.movementY], [0, 0], "the press at that point does not move");
    const up = plan.find(s => s.type === "pointerup").init;
    assert.equal(up.pressure, 0);
    assert.equal(up.buttons, 0);
    const click = plan.find(s => s.type === "click").init;
    assert.equal(click.detail, 1);
    assert.equal(click.button, 0);
    const move = plan.find(s => s.type === "mousemove").init;
    assert.equal(move.detail, 0);
    assert.equal(move.buttons, 0);
});

test("synthetic inits without a prior point report no movement (the pointer was already there)", () => {
    const plan = syntheticClickPlan(5, 5, 5, 5);
    assert.deepEqual([plan[0].init.movementX, plan[0].init.movementY], [0, 0]);
});

test("a synthetic KeyboardEvent init carries key, code, keyCode and which (the constructor drops the last two)", () => {
    const e = keyInit(keyPress("Enter"));
    assert.deepEqual({ key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, location: e.location }, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, location: 0,
    });
    assert.deepEqual([e.bubbles, e.cancelable, e.composed], [true, true, true]);
    const shifted = keyInit(keyPress("H"), { shiftKey: true });
    assert.equal(shifted.shiftKey, true);
    assert.equal(shifted.keyCode, 72);
});
