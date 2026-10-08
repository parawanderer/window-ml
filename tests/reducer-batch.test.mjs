// reducer-batch.test.mjs — REBUILDING A SESSION IN ONE PASS (`batchReduce`, src/sidebar/debug-reducer.ts), which is
// what paging a long history back costs, and what it must not change.
//
// The reducer is written for events arriving one at a time, and two of the things it does per step are O(steps):
// finding an existing row by `seq`, and copying the array to append. Over a replay those are the whole cost — a
// 25,600-event session took 1.2 seconds to rebuild, and a pull that replayed after every page took 5.3. A batch
// appends in place and finds by an index instead. So the thing to hold down is that NOTHING ELSE CHANGED: the same
// events in the same order must produce the same session, field for field, either way.

import test from "node:test";
import assert from "node:assert/strict";
import { batchReduce, maxSessionStep, onDebug, forgetSessionReduced } from "../src/sidebar/debug-reducer.ts";
import { sessionMap } from "../src/sidebar/store.ts";

const start = (hash) => ({ kind: "agent", session: { hash }, ts: 1000, task: "do the thing", model: "m", maxSteps: 20 });
const pending = (hash, step, seq) => ({ kind: "agent-step", session: { hash }, ts: 1000 + step, step, seq, tool: "exec", arguments: { js: `${step}` }, pending: true, renderIn: { type: "code", code: "x" } });
const done = (hash, step, seq) => ({ kind: "agent-step", session: { hash }, ts: 1100 + step, step, seq, tool: "exec", arguments: { js: `${step}` }, result: `r${step}` });
const say = (hash, text) => ({ kind: "agent-say", session: { hash }, ts: 1500, text });
const result = (hash, steps) => ({ kind: "agent-result", session: { hash }, ts: 2000, summary: "done", steps });

/** A session's whole history, with every shape the step path has: a start, pending-then-done pairs sharing a `seq`,
 *  a step with no `seq` at all, a user message mid-run, and a result that seals it. */
function history(hash) {
    const evs = [start(hash)];
    for (let i = 1; i <= 6; i++) { evs.push(pending(hash, i, i), done(hash, i, i)); }
    evs.push({ kind: "agent-step", session: { hash }, ts: 1700, step: 7, thought: "no seq on this one" });
    evs.push(say(hash, "actually, also check the other one"));
    for (let i = 8; i <= 12; i++) { evs.push(pending(hash, i, i), done(hash, i, i)); }
    evs.push(result(hash, 12));
    return evs;
}

const build = (hash, inBatch) => {
    forgetSessionReduced(hash);
    const evs = history(hash);
    if (inBatch) batchReduce(() => { for (const e of evs) onDebug(e); });
    else for (const e of evs) onDebug(e);
    return JSON.parse(JSON.stringify(sessionMap.get(hash)));
};

// --- a batch is the same session, cheaper ---

test("a session rebuilt in one pass is the session it was, field for field", () => {
    const one = build("aaaa0001", false);
    const many = build("aaaa0002", true);
    // The hash is the one thing that legitimately differs, since it is the key each was built under.
    one.hash = many.hash = "x";
    assert.deepEqual(many, one);
});

test("a pending step is still patched by its seq, not appended beside itself", () => {
    // The index replaces a linear scan, so this is the assertion that it finds the same row the scan did: six tools
    // that each arrived twice are six steps, each with its result, not twelve.
    const s = sessionMap.get("aaaa0002");
    assert.equal(s.steps.filter((x) => x.tool === "exec").length, 11, "eleven tool steps, each seen twice");
    assert.deepEqual(s.steps.map((x) => x.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.ok(s.steps.every((x) => x.tool !== "exec" || (x.result && !x.pending)), "every one settled onto its own row");
});

test("a batch that lands on a session with steps already in it finds those too", () => {
    // The index is built from what the session already held, which is the case a replay does NOT exercise (it starts
    // from a forgotten session) and a second page onto a live transcript does.
    forgetSessionReduced("aaaa0003");
    onDebug(start("aaaa0003"));
    onDebug(pending("aaaa0003", 1, 1));
    onDebug(pending("aaaa0003", 2, 2));
    batchReduce(() => { onDebug(done("aaaa0003", 2, 2)); onDebug(done("aaaa0003", 1, 1)); });
    const s = sessionMap.get("aaaa0003");
    assert.equal(s.steps.length, 2, "two rows, patched where they were");
    assert.deepEqual(s.steps.map((x) => x.result), ["r1", "r2"]);
});

test("a batch hands out ONE new steps array, so a reader comparing by identity sees one change", () => {
    // This is what makes appending in place safe: within a batch nothing renders, and at the end every session it
    // touched gets a fresh array exactly as a single event would have given it.
    forgetSessionReduced("aaaa0004");
    onDebug(start("aaaa0004"));
    onDebug(done("aaaa0004", 1, 1));
    const before = sessionMap.get("aaaa0004").steps;
    batchReduce(() => { for (let i = 2; i <= 5; i++) onDebug(done("aaaa0004", i, i)); });
    const after = sessionMap.get("aaaa0004").steps;
    assert.notEqual(after, before, "a new array");
    assert.equal(before.length, 1, "and the old one is the old one: it was not grown under whoever held it");
    assert.equal(after.length, 5);
});

test("a throw inside a batch still ends it, rather than leaving every later event appending in place", () => {
    forgetSessionReduced("aaaa0005");
    onDebug(start("aaaa0005"));
    assert.throws(() => batchReduce(() => { onDebug(done("aaaa0005", 1, 1)); throw new Error("stopped"); }), /stopped/);
    const before = sessionMap.get("aaaa0005").steps;
    onDebug(done("aaaa0005", 2, 2));
    assert.notEqual(sessionMap.get("aaaa0005").steps, before, "back to a copy per event");
});

// --- a transcript long enough to break the old arithmetic ---

test("maxSessionStep reads a session no argument list could hold", () => {
    // It was `Math.max(0, ...steps.map(…))`, which passes one argument per step: past roughly 125,000 of them V8
    // throws, so a long enough session went from slow to broken.
    const s = { steps: Array.from({ length: 200_000 }, (_, i) => ({ step: i })) };
    assert.equal(maxSessionStep(s), 199_999);
});

// --- a replay delivered twice into one document ---

test("the same replay reduced twice is the same session: a step with no seq is not appended again", () => {
    // The worker replays a run's history to a tab's shell on every CONTENT_READY, and a page sends that at will
    // (PAGE_ADOPT_HELLO → content.ts, ungated). Within one document the card's app keeps its sessionMap, so the second
    // replay patches the seq'd rows and APPENDS every row without one: the model's thoughts, repeated, in the
    // transcript the person reads. Fixed either here (dedupe a no-seq step by step + ts) or in the worker (one replay
    // per document); tests/redteam.test.js has the worker half.
    const hash = "replayed-twice";
    forgetSessionReduced(hash);
    const evs = history(hash);
    for (const e of evs) onDebug(e);
    const once = JSON.parse(JSON.stringify(sessionMap.get(hash).steps));
    for (const e of evs) onDebug(e);
    assert.equal(sessionMap.get(hash).steps.length, once.length, `rows after a second replay: ${sessionMap.get(hash).steps.map((s) => s.thought ? "thought" : s.seq).join(",")}`);
});
