// page-gate.test.mjs — the content script's and the shell's shared gate (src/page-gate.ts, docs/spec/SITE_PRESENCE.md
// step 2): what is held while it is pending, what a close drops, and the extension's own setup that a later open still
// runs. The gate lives on the global, so each test starts from a fresh one.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { setGate, gateState, whenOpen, whenEverOpen, whenDecided } = await import("../src/page-gate.ts");

beforeEach(() => { delete globalThis.__mlPageGate; });

// --- whenOpen: a page's post, dropped by a close ---

test("whenOpen holds while pending and runs on open", () => {
    const ran = [];
    whenOpen(() => ran.push("a"));
    assert.deepEqual(ran, []);
    setGate(true);
    assert.deepEqual(ran, ["a"]);
    whenOpen(() => ran.push("b"));
    assert.deepEqual(ran, ["a", "b"], "an open gate runs at once");
});

test("whenOpen drops what was held when the gate closes, and a later open does not replay it", () => {
    const ran = [];
    whenOpen(() => ran.push("held"));
    setGate(false);
    whenOpen(() => ran.push("after close"));
    setGate(true);
    assert.equal(gateState(), "open");
    assert.deepEqual(ran, [], "a hidden page's posts reached the worker once it opened");
});

// --- whenEverOpen: the extension's own setup, kept across a close ---

test("whenEverOpen runs once the gate opens, even after a close (an origin allowed while its page is open)", () => {
    const ran = [];
    whenEverOpen(() => ran.push("before"));
    setGate(false);
    whenEverOpen(() => ran.push("while closed"));
    assert.deepEqual(ran, []);
    setGate(true);
    assert.deepEqual(ran, ["before", "while closed"]);
    whenEverOpen(() => ran.push("open"));
    assert.deepEqual(ran, ["before", "while closed", "open"]);
});

test("whenEverOpen runs before what whenOpen held, and each only once", () => {
    const ran = [];
    whenOpen(() => ran.push("post"));
    whenEverOpen(() => ran.push("setup"));
    setGate(true);
    setGate(true);
    assert.deepEqual(ran, ["setup", "post"]);
});

test("whenEverOpen keeps at most 16 while the gate is not open", () => {
    let n = 0;
    for (let i = 0; i < 40; i++) whenEverOpen(() => n++);
    setGate(true);
    assert.equal(n, 16);
});

test("once open the gate stays open: a later close neither closes it nor drops anything", () => {
    setGate(true);
    setGate(false);
    assert.equal(gateState(), "open");
    let ran = 0;
    whenOpen(() => ran++);
    assert.equal(ran, 1);
});

// --- whenDecided: answered either way ---

test("whenDecided runs on a close as on an open", () => {
    const ran = [];
    whenDecided(() => ran.push(gateState()));
    setGate(false);
    assert.deepEqual(ran, ["closed"]);
});
