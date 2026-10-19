// frames-lib (scripts/frames-lib.mjs) — the pure parts of the frame recorder: frame picking, the contact-sheet grid, the change summary.
import { test } from "node:test";
import assert from "node:assert";
import { pickEvenly, gridFor, summarize } from "../scripts/frames-lib.mjs";

// --- which frames a contact sheet shows ---

test("pickEvenly keeps every frame when there are few, and the first and last when there are many", () => {
    assert.deepEqual(pickEvenly(3, 16), [0, 1, 2]);
    const p = pickEvenly(100, 16);
    assert.equal(p.length, 16);
    assert.equal(p[0], 0);
    assert.equal(p.at(-1), 99);
    assert.deepEqual(p, [...p].sort((a, b) => a - b));
    assert.deepEqual(pickEvenly(0, 16), []);
    assert.deepEqual(pickEvenly(5, 1), [0]);
});

// --- the grid ---

test("gridFor gives wide frames fewer columns than tall ones and always holds every frame", () => {
    assert.deepEqual(gridFor(16, 1280, 800), { cols: 4, rows: 4 });
    assert.deepEqual(gridFor(16, 390, 844), { cols: 8, rows: 2 });
    assert.deepEqual(gridFor(3, 390, 844), { cols: 3, rows: 1 });
    assert.deepEqual(gridFor(0, 390, 844), { cols: 0, rows: 0 });
});

// --- the change summary ---

const row = (t, o = {}) => ({ t, scrollTop: 0, scrollHeight: 100, msgs: 0, anims: [], ...o });

test("summarize prints the first frame and only the frames where something changed", () => {
    const rows = [row(0), row(16), row(32, { msgs: 1 }), row(48, { msgs: 1 }), row(64, { msgs: 1, scrollTop: 40 }),
        row(80, { msgs: 1, scrollTop: 40, anims: [{ name: "fade", target: "msg" }] }), row(96, { msgs: 1, scrollTop: 40, anims: [{ name: "fade", target: "msg" }] })];
    const s = summarize(rows);
    assert.equal(s.length, 4);
    assert.match(s[0], /first/);
    assert.match(s[1], /msgs 0->1/);
    assert.match(s[2], /scrollTop 0->40/);
    assert.match(s[3], /fade@msg/);
});

test("summarize notices a watched element moving, and an empty input prints nothing", () => {
    const w = (x) => ({ sel: [{ rect: [x, 0, 10, 10], opacity: "1", transform: "none" }] });
    assert.equal(summarize([row(0, { watch: w(0) }), row(16, { watch: w(0) }), row(32, { watch: w(5) })]).length, 2);
    assert.deepEqual(summarize([]), []);
});
