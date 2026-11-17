// step-settle.test.mjs — when a tool step may join a group of calls in the calm chat, and when it is left out for a beat.

import { test } from "node:test";
import assert from "node:assert";
import { noteSteps, noteStreamed, isSettling, isYoung, STEP_YOUNG_MS, GROUP_AFTER_MS } from "../src/sidebar/transcript/step-settle.ts";
import { foldStreaks } from "../src/sidebar/transcript/step-streak.tsx";

const st = (o) => ({ step: 1, seq: 1, tool: "exec", ...o });
let n = 0;
const run = () => `run${++n}`;

// --- a step that has just started ---
test("a step that has only just started is young until it has said whether it will ask, then it is not", () => {
    const hash = run(), t0 = 5_000;
    noteStreamed(hash, 1);                                       // its calls were drawn as the model wrote them
    noteSteps(hash, [st({ pending: true })], t0);
    assert.ok(isYoung(hash, st({ pending: true }), t0 + 50), "a beat after its start event: the gate event may still follow");
    assert.ok(!isYoung(hash, st({ pending: true, awaitingApproval: true }), t0 + 50), "it said it asks: not young");
    assert.ok(!isYoung(hash, st({ pending: true }), t0 + STEP_YOUNG_MS + 1), "and past the beat it is just running");
    assert.ok(isSettling(hash, st({ pending: true }), t0 + 50));
    assert.ok(!isSettling(hash, st({ pending: true }), t0 + STEP_YOUNG_MS + 1));
});

// --- a step that waited for a person ---
test("a step that was waiting for a person is not grouped while it runs, nor for a moment after it settles", () => {
    const hash = run(), t0 = 9_000;
    noteSteps(hash, [st({ pending: true, awaitingApproval: true })], t0);
    noteSteps(hash, [st({ pending: true })], t0 + 3000);          // approved: running
    assert.ok(isSettling(hash, st({ pending: true }), t0 + 9000), "approved and running: its code is still open, however long it runs");
    noteSteps(hash, [st({ pending: false, result: "ok" })], t0 + 10_000);
    assert.ok(isSettling(hash, st({ pending: false }), t0 + 10_000 + 200), "settled a moment ago: it folds by itself first");
    assert.ok(!isSettling(hash, st({ pending: false }), t0 + 10_000 + GROUP_AFTER_MS + 1), "then it may join");
});

test("a step first seen already settled (a transcript opened later) is never made to wait", () => {
    const hash = run();
    const next = noteSteps(hash, [st({ pending: false, result: "ok" })], 1000);
    assert.equal(next, 0);
    assert.ok(!isSettling(hash, st({ pending: false }), 1001));
});

test("a step in a turn that was not streamed is never young: nothing covers its first beat, so it is drawn and grouped at once", () => {
    const hash = run(), t0 = 7_000;
    noteSteps(hash, [st({ pending: true })], t0);
    assert.ok(!isYoung(hash, st({ pending: true }), t0 + 50));
    assert.ok(!isSettling(hash, st({ pending: true }), t0 + 50));
});

test("noteSteps says when the first waiting step is let go, so the view can draw again then", () => {
    const hash = run(), t0 = 4000;
    noteStreamed(hash, 1);
    const wait = noteSteps(hash, [st({ pending: true })], t0);
    assert.ok(wait > 0 && wait <= STEP_YOUNG_MS, `drawn again within the beat (${wait})`);
});

// --- what it does to the grouping ---
test("with the 'group everything' preference, a turn whose second call is only just starting is not grouped for that beat", () => {
    const turn = (tools) => ({ step: 1, localStep: 1, tools });
    const a = st({ seq: 1, pending: false, result: "ok" });
    const b = st({ seq: 2, pending: true });                     // started, not yet said whether it asks
    const hash = run(), t0 = 20_000;
    noteStreamed(hash, 1);
    noteSteps(hash, [{ ...a, pending: true }], t0 - 5000); noteSteps(hash, [a, b], t0);
    const settling = (x) => isSettling(hash, x, t0 + 20);
    const grouped = foldStreaks([turn([a, b])], { live: true, all: true, settling });
    assert.ok(!grouped.some((g) => "kind" in g), "no group yet: it would be torn down a render later when the gate event lands");
    const later = foldStreaks([turn([a, b])], { live: true, all: true, settling: (x) => isSettling(hash, x, t0 + STEP_YOUNG_MS + 20) });
    assert.ok(later.some((g) => "kind" in g), "past the beat it is a group of two, as before");
    const plain = foldStreaks([turn([a, b])], { live: true, all: true });
    assert.ok(plain.some((g) => "kind" in g), "with no settling rule given it groups as it always did");
});
