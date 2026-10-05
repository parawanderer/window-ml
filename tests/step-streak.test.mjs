// step-streak.test.mjs — folding a run of the same tool in the reading view. Every clause of the rule is here,
// because each one is a thing the fold must NOT swallow: a gate, something the model said, a tool change, or a
// streak that is still being added to.
"use strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldStreaks, streakFacts, holdsSeq, foldedInView, STREAK_MIN } from "../src/sidebar/step-streak.tsx";
import { JUST_ARRIVED_MS } from "../src/sidebar/just-arrived.ts";

/** One turn with a single tool call, which is the shape a streak is made of. */
const turn = (step, tool, over = {}) => ({ step, localStep: step, tools: [{ step, seq: step, tool, ...over }] });
/** A step whose collapsed row SHOWS something — the thing that keeps it out of a fold. */
const says = (step, tool, text = "3 fare cards") => turn(step, tool, { result: text });
const kinds = (out) => out.map((x) => ("kind" in x ? `${x.tool}×${x.turns.length}` : x.tools[0]?.tool ?? "·"));

// --- what folds, and what a fold must never swallow ---

test("three or more adjacent turns of one tool fold; two do not", () => {
    assert.deepEqual(kinds(foldStreaks([turn(1, "exec"), turn(2, "exec"), turn(3, "exec")])), ["exec×3"]);
    assert.deepEqual(kinds(foldStreaks([turn(1, "exec"), turn(2, "exec")])), ["exec", "exec"]);
    assert.equal(STREAK_MIN, 3, "two is a pair, not a pattern");
});

test("a different tool breaks the run, because that is a change of activity", () => {
    const out = foldStreaks([turn(1, "exec"), turn(2, "exec"), turn(3, "exec"), turn(4, "look"), turn(5, "exec"), turn(6, "exec"), turn(7, "exec")]);
    assert.deepEqual(kinds(out), ["exec×3", "look", "exec×3"]);
});

test("PROSE breaks it: if the model said something, that is content and not noise", () => {
    const out = foldStreaks([turn(1, "exec"), { ...turn(2, "exec"), thought: "the cards are in a list" }, turn(3, "exec"), turn(4, "exec")]);
    assert.deepEqual(kinds(out), ["exec", "exec", "exec", "exec"], "a prose turn cannot join, and splits the rest below three");
});

test("THINKING does not break it — that is the other half of what is being folded away", () => {
    const out = foldStreaks([turn(1, "exec"), { ...turn(2, "exec"), reasoning: "let me try the other selector" }, turn(3, "exec")]);
    assert.deepEqual(kinds(out), ["exec×3"]);
});

test("A GATE IS NEVER HIDDEN, under any circumstance", () => {
    const out = foldStreaks([turn(1, "exec"), turn(2, "exec", { pending: true, awaitingApproval: true }), turn(3, "exec"), turn(4, "exec")]);
    assert.deepEqual(kinds(out), ["exec", "exec", "exec", "exec"]);
});

test("a turn that batched two tools is not a member: the fold is about rows that say one thing", () => {
    const two = { step: 2, localStep: 2, tools: [{ step: 2, seq: 2, tool: "exec" }, { step: 2, seq: 3, tool: "exec" }] };
    const out = foldStreaks([turn(1, "exec"), two, turn(3, "exec"), turn(4, "exec")]);
    assert.equal(out.filter((x) => "kind" in x).length, 0, "nothing folded: the batched turn cannot join, and it splits the rest below three");
    assert.equal(out.length, 4);
});

// --- when it folds: after the streak has ended, never while it is growing ---

test("a LIVE run does not fold its tail — you are watching that", () => {
    const steps = [turn(1, "exec"), turn(2, "exec"), turn(3, "exec")];
    assert.deepEqual(kinds(foldStreaks(steps, { live: true })), ["exec", "exec", "exec"]);
    assert.deepEqual(kinds(foldStreaks(steps, { live: false })), ["exec×3"]);
});

test("…but a live run folds a streak that something follows, because that one has ended", () => {
    const out = foldStreaks([turn(1, "exec"), turn(2, "exec"), turn(3, "exec"), turn(4, "look")], { live: true });
    assert.deepEqual(kinds(out), ["exec×3", "look"]);
});

test("the turns are kept whole, so expanding draws exactly what would have been there", () => {
    const [s] = foldStreaks([turn(1, "exec"), turn(2, "exec"), turn(3, "exec")]);
    assert.deepEqual(s.turns.map((t) => t.step), [1, 2, 3]);
    assert.equal(s.step, 1, "it sits where its first turn did, so the run's order is unchanged");
});

// --- what the folded row says, which is what the rows it replaced could not ---

test("the facts are the failures and the time — `exec × 8` alone is the same nothing, compressed", () => {
    const [s] = foldStreaks([
        turn(1, "exec", { result: "3", toolMs: 1000 }),
        turn(2, "exec", { result: "Error: no active agent run", toolMs: 500 }),
        turn(3, "exec", { result: "Denied", toolMs: 500 }),
    ]);
    assert.deepEqual(streakFacts(s), { failed: 2, ms: 2000 });
});

test("a time is claimed only when something reported one", () => {
    const [s] = foldStreaks([turn(1, "exec"), turn(2, "exec"), turn(3, "exec")]);
    assert.deepEqual(streakFacts(s), { failed: 0, ms: null });
});

// --- a jump must be able to reach a step inside a folded one ---

test("a streak knows whether it holds the step a jump is reaching for", () => {
    // What the component does with this is make itself STICKILY open — `revealSeq` clears itself about a second
    // later, so reading it directly would fold the streak again right after it opened. That wiring is the same
    // shape a step and the HUD's per-task block already use; the RULE is here, because a citation landing inside a
    // folded streak and doing nothing would be a new way to break what `scrollToStepSeq` exists to prevent.
    const [s] = foldStreaks([turn(1, "exec"), turn(2, "exec"), turn(3, "exec")]);
    assert.equal(holdsSeq(s, 2), true);
    assert.equal(holdsSeq(s, 9), false);
    assert.equal(holdsSeq(s, null), false, "nothing is being revealed");
    assert.equal(holdsSeq(s, undefined), false);
    assert.equal(holdsSeq(s, 0), false, "a falsy seq is still a seq, and this one is not in it");
});

// --- the clause the rule really turns on: a row that says something is not noise ---

test("a result does NOT keep a row out — the reading view hides the preview, so every row says only its name", () => {
    // `html[data-focus] .astep-preview { display: none }`. Gating on the preview's text would test something the
    // reader cannot see, and would have spared exactly the rows the complaint was about.
    assert.deepEqual(kinds(foldStreaks([says(1, "exec"), says(2, "exec"), says(3, "exec")])), ["exec×3"]);
});

test("a step that REVISES another never folds: the diff header is the only place that is said", () => {
    // Three `python_exec` calls each revising the last — which is a real run in this repo's own tests. Folding
    // them would hide what changed, and would make the step somebody was reading vanish on entering calm.
    const revise = (step) => turn(step, "python_exec", { renderIn: { type: "python-in", mode: "script", code: "x", revision: { ref: "@tool:a1b2c3d", tool: "python_exec", seq: step - 1 } } });
    const out = foldStreaks([turn(1, "python_exec"), revise(2), revise(3)]);
    assert.equal(out.filter((x) => "kind" in x).length, 0);
});

// --- a fold the reader WATCHED happen, told apart from history drawn for the first time ---
// The two make the same component and want opposite things: one has to collapse (or a block of the transcript
// vanishes between frames and you go looking for it), and the other must not (or opening an old session plays a
// page of animations about rows the reader never saw).

/** A streak whose last call landed `ago` ms before `now`. */
const streakAt = (ago, now = 1_000_000) => ({
    kind: "streak", tool: "exec", step: 1,
    turns: [turn(1, "exec"), turn(2, "exec"), { step: 3, localStep: 3, tools: [{ step: 3, seq: 3, tool: "exec", ts: now - ago }] }],
});

test("a streak whose calls landed a moment ago collapses; an old one is simply folded already", () => {
    const now = 1_000_000;
    assert.equal(foldedInView(streakAt(200, now), now), true, "a fold the reader just watched");
    assert.equal(foldedInView(streakAt(JUST_ARRIVED_MS + 1, now), now), false, "past the window: history");
    assert.equal(foldedInView(streakAt(5 * 60_000, now), now), false, "and a run from this morning, certainly");
});

test("the run having ENDED is not a reason to snap — that is the fold most certain to be watched", () => {
    // The tail folds precisely BECAUSE the run finished, so gating this on "is the run still live" would have
    // excluded the one case a reader is guaranteed to be looking at. Only the clock decides.
    const now = 1_000_000;
    assert.equal(foldedInView(streakAt(50, now), now), true);
});

test("a stamp from a clock running fast is read as history, not as the future", () => {
    // A remote runtime's `ts` can be minutes ahead of this device. A negative age is not "a moment ago", and the
    // safe way to be wrong is one missing animation rather than a whole transcript moving at once.
    const now = 1_000_000;
    assert.equal(foldedInView(streakAt(-60_000, now), now), false);
});

test("an unstamped streak is treated as history, so nothing animates on a guess", () => {
    // ts is optional on a step; without one there is no evidence the reader saw this happen.
    assert.equal(foldedInView({ kind: "streak", tool: "exec", step: 1, turns: [turn(1, "exec")] }, 1_000_000), false);
});
