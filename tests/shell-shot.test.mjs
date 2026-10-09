// shell-shot.test.mjs — the shell's side of hiding the debug sidebar for a screenshot (src/sidebar/shell-shot.ts): the
// page's window handshake and the worker's SHOT_HIDE/SHOT_SHOW, held apart, so a page script posting "show" cannot put
// the sidebar back into a shot the worker is taking, and nothing but the worker can start or end one.

import test from "node:test";
import assert from "node:assert/strict";

const frames = [];   // requestAnimationFrame callbacks waiting for the next frame
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.chrome = { runtime: { id: "ext-id" } };
/** Run one frame's callbacks. */
const frame = () => { for (const fn of frames.splice(0)) fn(); };

const { shotGate, fromWorker } = await import("../src/sidebar/shell-shot.ts");

const WORKER = { id: "ext-id" };   // a chrome.tabs.sendMessage from the worker: this extension, no tab
const PAGE_TAB = { id: "ext-id", tab: { id: 3 }, url: "chrome-extension://ext-id/sidebar.html", frameId: 5 };   // the extension's own frame IN a tab

/** A gate over a surface that records whether it is hidden. */
function setup(holdMs) {
    frames.length = 0;
    const surface = { hidden: false, hide() { this.hidden = true; }, show() { this.hidden = false; } };
    return { surface, gate: shotGate(surface, holdMs) };
}

// --- the worker's shot ---

test("SHOT_HIDE hides at once and answers only after two frames have painted; SHOT_SHOW restores", () => {
    const { surface, gate } = setup();
    const acks = [];
    assert.equal(gate.onRuntime({ type: "SHOT_HIDE", id: "s1" }, WORKER, (r) => acks.push(r)), true, "the reply comes later: keep the channel open");
    assert.equal(surface.hidden, true);
    assert.equal(acks.length, 0);
    frame();
    assert.equal(acks.length, 0, "one frame is not enough: the hidden state may not have painted");
    frame();
    assert.deepEqual(acks, [{ hidden: true }]);
    assert.equal(gate.onRuntime({ type: "SHOT_SHOW", id: "s1" }, WORKER, () => assert.fail("show is not answered")), false);
    assert.equal(surface.hidden, false);
});

test("a show naming another shot lifts nothing; two shots at once hold the sidebar until both have shown", () => {
    const { surface, gate } = setup();
    gate.onRuntime({ type: "SHOT_HIDE", id: "a" }, WORKER, () => {});
    gate.onRuntime({ type: "SHOT_HIDE", id: "b" }, WORKER, () => {});
    gate.onRuntime({ type: "SHOT_SHOW", id: "zzz" }, WORKER, () => {});
    assert.equal(surface.hidden, true);
    gate.onRuntime({ type: "SHOT_SHOW", id: "a" }, WORKER, () => {});
    assert.equal(surface.hidden, true, "b is still being taken");
    gate.onRuntime({ type: "SHOT_SHOW", id: "b" }, WORKER, () => {});
    assert.equal(surface.hidden, false);
});

test("a worker shot whose show never comes (the worker evicted mid-shot) is lifted when its hold runs out", async () => {
    const { surface, gate } = setup(40);
    gate.onRuntime({ type: "SHOT_HIDE", id: "s1" }, WORKER, () => {});
    assert.equal(surface.hidden, true);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(surface.hidden, false);
    assert.equal(gate.workerHolding(), false);
});

// --- what the page can and cannot do to it ---

test("a page-posted show during a worker shot is ignored: the sidebar stays hidden until the worker's own show", () => {
    const { surface, gate } = setup();
    gate.onRuntime({ type: "SHOT_HIDE", id: "s1" }, WORKER, () => {});
    gate.pageShow();
    assert.equal(surface.hidden, true, "the page's show lifted the worker's hide");
    gate.pageShow();
    gate.pageHide(() => {});
    gate.pageShow();
    assert.equal(surface.hidden, true, "nor does any sequence of the page's own hide and show");
    gate.onRuntime({ type: "SHOT_SHOW", id: "s1" }, WORKER, () => {});
    assert.equal(surface.hidden, false);
});

test("the page's own handshake is unchanged: hide, the ack after two frames, show restores", () => {
    const { surface, gate } = setup();
    let acked = 0;
    gate.pageHide(() => acked++);
    assert.equal(surface.hidden, true);
    frame(); frame();
    assert.equal(acked, 1);
    gate.pageShow();
    assert.equal(surface.hidden, false);
});

test("a worker's show does not lift a hide the page still holds (its own shot in progress)", () => {
    const { surface, gate } = setup();
    gate.pageHide(() => {});
    gate.onRuntime({ type: "SHOT_HIDE", id: "s1" }, WORKER, () => {});
    gate.onRuntime({ type: "SHOT_SHOW", id: "s1" }, WORKER, () => {});
    assert.equal(surface.hidden, true);
    gate.pageShow();
    assert.equal(surface.hidden, false);
});

test("SHOT_HIDE/SHOT_SHOW from anything but the worker are ignored: a sender with a tab, another extension, no sender", () => {
    for (const sender of [PAGE_TAB, { id: "other-ext" }, { id: "other-ext", tab: { id: 3 } }, { tab: { id: 3 } }, undefined, {}]) {
        const { surface, gate } = setup();
        let answered = false;
        assert.equal(gate.onRuntime({ type: "SHOT_HIDE", id: "s1" }, sender, () => { answered = true; }), false);
        frame(); frame();
        assert.equal(surface.hidden, false, `a hide from ${JSON.stringify(sender)} hid the sidebar`);
        assert.equal(answered, false);
        // and one that tries to end the worker's real shot early
        gate.onRuntime({ type: "SHOT_HIDE", id: "real" }, WORKER, () => {});
        gate.onRuntime({ type: "SHOT_SHOW", id: "real" }, sender, () => {});
        assert.equal(surface.hidden, true, `a show from ${JSON.stringify(sender)} lifted the worker's hide`);
    }
    assert.equal(fromWorker(WORKER), true);
});

test("a shot id that is not a short string is refused", () => {
    for (const id of [undefined, null, "", 7, {}, "x".repeat(65)]) {
        const { surface, gate } = setup();
        assert.equal(gate.onRuntime({ type: "SHOT_HIDE", id }, WORKER, () => {}), false);
        assert.equal(surface.hidden, false, `id ${JSON.stringify(id)}`);
    }
});
