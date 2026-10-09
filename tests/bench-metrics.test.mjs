// The bench's metric extractors, against event streams whose right answer is known by construction.
//
// A benchmark whose extractors are wrong measures its own bug and reports it confidently, so these run in
// the FAST suite rather than only through a browser: every metric is a pure function of the debug stream,
// so it can be handed a stream that deliberately re-emits, deliberately corrupts an identifier, and
// deliberately recovers, and asserted to report exactly that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    stepsOf, authoredTexts, capturedOutputs, sharesRun, reEmission, pointerRefs, pointerUse,
    recovery, tokenCost, measureRun, afterSeed, spread, rate, aggregate, COLUMNS, focusStep, streamUse, isRateLimit,
} from "../tests/e2e/bench/metrics.mjs";
import { combos, expandCells, cellKey, selected, parseSelector, buildGroups, cellPath, cellStream } from "../tests/e2e/bench/cells.mjs";

/** A tool step as the sidebar receives it: a pending START, then the DONE carrying the result. */
const step = (seq, tool, args, result, extra = {}) => ([
    { kind: "agent-step", seq, step: seq, pending: true, tool, arguments: args },
    { kind: "agent-step", seq, step: seq, tool, arguments: args, result, modelResult: result, ...extra },
]);
const start = () => ({ kind: "agent", session: { hash: "abc" }, model: "m", task: "t", ts: 1 });
const end = (summary, extra = {}) => ({ kind: "agent-result", session: { hash: "abc" }, summary, ts: 9, ...extra });

const TABLE = "Region,Revenue,Units\nNorth,182340.55,4821\nSouth,99120.10,2610\nEast,143870.25,3902";

test("stepsOf: the pending START and the DONE of one call collapse into a single step", () => {
    const ev = [start(), ...step(1, "findByText", { text: "x" }, "found"), end("done")];
    const steps = stepsOf(ev);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].tool, "findByText");
    assert.equal(steps[0].result, "found", "the DONE's result must survive the merge with the START");
});

test("authoredTexts: what the model WROTE, never what it read", () => {
    const ev = [start(), ...step(1, "exec", { js: "document.title" }, TABLE), end("summary text")];
    const texts = authoredTexts(ev);
    const all = texts.map((t) => t.text).join(" ");
    assert.ok(all.includes("document.title"), "the args it sent are authored");
    assert.ok(all.includes("summary text"), "its final answer is authored");
    assert.ok(!all.includes("182340.55"), "a tool RESULT is read, not authored — counting it would make every run look like a re-emission");
});

test("sharesRun: a long verbatim overlap is found; unrelated text of the same length is not", () => {
    assert.ok(sharesRun(TABLE, `As shown: ${TABLE.slice(20, 90)} — that's the total.`, 40));
    assert.ok(!sharesRun(TABLE, "A completely different sentence of more than forty characters in it.", 40));
});

test("sharesRun: reflowed whitespace still matches (a model rarely retypes spacing exactly)", () => {
    const reflowed = TABLE.replace(/\n/g, "   \n  ");
    assert.ok(sharesRun(TABLE, `here it is: ${reflowed}`, 40));
});

test("authoredTexts: EVERY turn's answer is authored text, not just the terminal one", () => {
    // A follow-up (or a seeded history) has the model writing a final answer per turn. Reading only the
    // last agent-result made an earlier turn's re-emission invisible — a silent zero on multi-turn runs.
    const ev = [
        start(),
        ...step(1, "python_exec", { code: "df" }, TABLE),
        end(`turn one: ${TABLE}`),
        ...step(2, "answer", { text: "summarised" }, "ok"),
        end("turn two"),
    ];
    const kinds = authoredTexts(ev).filter((t) => t.kind === "summary").map((t) => t.text);
    assert.equal(kinds.length, 2, "both turns' answers count");
    assert.equal(reEmission(ev, 40).reEmitted, 1, "the FIRST turn retyped the table, and that must be seen");
});

test("afterSeed: the seed turn's own ANSWER is dropped too, not only its steps", () => {
    // The seeded turn's agent-result carries no seq, so filtering by seq alone would leave its answer —
    // which is exactly where a seeded re-emission lives — attributed to the measured turn.
    const ev = [
        start(),
        ...step(1, "python_exec", { code: "df" }, TABLE),
        end(`seed turn: ${TABLE}`),          // the SEED re-emits, in its answer
        ...step(2, "answer", { text: "summarised" }, "ok"),
        end("measured turn"),
    ];
    assert.equal(reEmission(ev, 40).reEmitted, 1, "scored whole, the seed's re-emission shows");
    assert.equal(reEmission(afterSeed(ev, 1), 40).reEmitted, 0, "scored from the boundary, it is not charged to the model");
});

test("reEmission: counts a retyped output, and only from a LATER step", () => {
    const ev = [
        start(),
        ...step(1, "python_exec", { code: "df" }, TABLE),
        ...step(2, "answer", { text: `The figures are ${TABLE}` }, "ok"),
        end("done"),
    ];
    const r = reEmission(ev, 40);
    assert.equal(r.outputs, 1);
    assert.equal(r.reEmitted, 1);
    assert.equal(r.rate, 1);
    // Positions are the total-order ordinal, not `seq` — which is not unique (a turn's thought and its
    // tool call share one). All that matters is that the retyping happened strictly later.
    assert.ok(r.instances[0].atOrder > r.instances[0].fromOrder);
    assert.equal(r.instances[0].tool, "python_exec");
});

test("reEmission: a run that CITES instead of retyping scores zero", () => {
    const ev = [
        start(),
        ...step(1, "python_exec", { code: "df" }, `${TABLE}\n@tool:a39f599`),
        ...step(2, "answer", { text: "The figures are @tool:a39f599" }, "ok"),
        end("done"),
    ];
    assert.equal(reEmission(ev, 40).reEmitted, 0);
});

test("reEmission: a step cannot re-emit its own output", () => {
    // The args and the result of ONE call share a seq. Counting that as a re-emission would score every
    // echoing tool as a re-emitter, so the comparison is strictly later-than.
    const ev = [start(), ...step(1, "exec", { js: TABLE }, TABLE), end("done")];
    assert.equal(reEmission(ev, 40).reEmitted, 0);
});

test("reEmission: an output shorter than k is not counted as an output at all", () => {
    const ev = [start(), ...step(1, "findByText", { text: "x" }, "42"), ...step(2, "answer", { text: "42" }, "ok"), end("42")];
    const r = reEmission(ev, 40);
    assert.equal(r.outputs, 0, "a short value is not data the model needed a pointer for");
    assert.equal(r.rate, 0);
});

test("pointerRefs: the three reference FORMS are told apart by shape", () => {
    const ev = [
        start(),
        ...step(1, "answer", { text: `see @tool:a39f599 and @tool:"the pricing table" and @tool:python_exec` }, "ok"),
        end("done"),
    ];
    const forms = pointerRefs(ev).map((r) => r.form);
    assert.deepEqual(forms, ["id", "label", "alias"]);
});

test("pointerUse: a fault is split into MISTYPED and INVENTED by the distance the fault reports", () => {
    const ev = [
        start(),
        ...step(1, "dereference", { ref: "@tool:a39f598" }, "MemoryFault: no pointer at a39f598. Nearest: a39f599 (distance 1)."),
        ...step(2, "dereference", { ref: "@tool:beefbee" }, "MemoryFault: no pointer at beefbee. Nearest: a39f599 (distance 6) — this looks invented."),
        ...step(3, "dereference", { ref: "@tool:a39f599" }, TABLE),
        end("done"),
    ];
    const p = pointerUse(ev);
    assert.equal(p.derefCalls, 3);
    assert.equal(p.derefFaults, 2);
    assert.equal(p.mistyped, 1);
    assert.equal(p.invented, 1);
    assert.equal(p.silentWrong, 0, "neither fault resolved to the wrong pointer — it faulted, which is the safe outcome");
});

test("pointerUse: a near match that RESOLVED is the silent-wrong signal, not a fault", () => {
    const ev = [
        start(),
        ...step(1, "dereference", { ref: '@tool:"the budget"' }, "Resolved a near match: 'the budget table'.\n" + TABLE),
        end("done"),
    ];
    const p = pointerUse(ev);
    assert.equal(p.derefFaults, 0);
    assert.equal(p.silentWrong, 1);
});

test("recovery: a fault followed by a good deref counts as recovered; giving up does not", () => {
    const good = [
        start(),
        ...step(1, "dereference", { ref: "@tool:bad" }, "MemoryFault: no pointer at bad."),
        ...step(2, "dereference", { ref: "@tool:a39f599" }, TABLE),
        end("done"),
    ];
    assert.deepEqual(recovery(good), { faults: 1, recovered: 1, rate: 1 });

    const gaveUp = [
        start(),
        ...step(1, "dereference", { ref: "@tool:bad" }, "MemoryFault: no pointer at bad."),
        ...step(2, "answer", { text: TABLE }, "ok"),
        end("done"),
    ];
    assert.deepEqual(recovery(gaveUp), { faults: 1, recovered: 0, rate: 0 });
});

test("recovery: a fault on the FINAL step is not evidence either way and is excluded", () => {
    const ev = [start(), ...step(1, "dereference", { ref: "@tool:bad" }, "MemoryFault: no pointer at bad."), end("gave up")];
    assert.deepEqual(recovery(ev), { faults: 0, recovered: 0, rate: 0 });
});

test("tokenCost: sums the step usage AND the delegated sub-calls", () => {
    // `subUsage` as the product sends it: the SESSION's running total, on every step after the first sub-call.
    const sub = (prompt, completion, calls) => ({ subUsage: { prompt, completion, calls } });
    const ev = [
        start(),
        ...step(1, "look", {}, "a chart", { usage: { promptTokens: 100, completionTokens: 20 }, ...sub(900, 30, 1) }),
        ...step(2, "answer", {}, "ok", { usage: { promptTokens: 200, completionTokens: 10 }, ...sub(900, 30, 1) }),
        end("done"),
    ];
    assert.deepEqual(tokenCost(ev), { prompt: 300, completion: 30, sub: 930, total: 1260 },
        "a running total repeated on a later step is the same spend, not more");
});

test("tokenCost: the sub-call total runs across turns, so a later turn is not counted on top of it", () => {
    const sub = (prompt, completion, calls) => ({ subUsage: { prompt, completion, calls } });
    const ev = [
        start(),
        ...step(1, "look", {}, "a", sub(100, 10, 1)),
        ...step(2, "look", {}, "b", sub(250, 20, 2)),
        end("one"),
        ...step(3, "answer", {}, "c", sub(250, 20, 2)),   // turn two made no sub-call: the total stands
        ...step(4, "look", {}, "d", sub(300, 25, 3)),
        end("two"),
    ];
    assert.equal(tokenCost(ev).sub, 325);
});

test("tokenCost: a seed turn's sub-calls are not charged to the measured turn", () => {
    const sub = (prompt, completion, calls) => ({ subUsage: { prompt, completion, calls } });
    const ev = [
        start(),
        ...step(1, "look", {}, "seeded", sub(900, 30, 1)),
        end("seed"),
        ...step(2, "answer", {}, "measured", sub(900, 30, 1)),
        end("done"),
    ];
    assert.equal(measureRun({ events: ev, seedBoundaryStep: 1 }).tokens.sub, 0);
    assert.equal(measureRun({ events: ev }).tokens.sub, 930);
});

test("afterSeed: the seeded turn's steps are excluded from the measurement", () => {
    const ev = [
        start(),
        ...step(1, "python_exec", { code: "df" }, TABLE),          // the SEED turn: scripted setup
        ...step(2, "answer", { text: `figures: ${TABLE}` }, "ok"), // the seed's own re-emission
        ...step(3, "dereference", { ref: "@tool:a39f599" }, TABLE),
        end("done"),
    ];
    // Scored whole, the scripted turn's re-emission is charged to the model.
    assert.equal(reEmission(ev, 40).reEmitted, 1);
    // Scored from the boundary, only the measured turn counts.
    assert.equal(reEmission(afterSeed(ev, 2), 40).reEmitted, 0);
    assert.equal(measureRun({ events: ev, seedBoundaryStep: 2 }).seeded, true);
    assert.equal(measureRun({ events: ev, seedBoundaryStep: 2 }).reEmission.reEmitted, 0);
    assert.equal(measureRun({ events: ev }).reEmission.reEmitted, 1, "without a seed nothing is dropped");
});

test("measureRun: an unscored task reports null, never a failure", () => {
    const ev = [start(), ...step(1, "answer", {}, "ok"), end("42")];
    assert.equal(measureRun({ events: ev }, {}).succeeded, null);
    assert.equal(measureRun({ events: ev }, { succeeded: ({ answer }) => answer === "42" }).succeeded, true);
    assert.equal(measureRun({ events: ev }, { succeeded: ({ answer }) => answer === "43" }).succeeded, false);
});

test("measureRun: a predicate that THROWS fails that run rather than the sweep", () => {
    const ev = [start(), ...step(1, "answer", {}, "ok"), end("42")];
    assert.equal(measureRun({ events: ev }, { succeeded: () => { throw new Error("bad predicate"); } }).succeeded, false);
});

// --- a run of several turns that did not finish ---

test("measureRun: a task with a follow-up whose run errored before the follow-up answered is not scored", () => {
    const one = [start(), ...step(1, "answer", {}, "ok"), end("42")];
    const task = { followup: "and again", succeeded: ({ answer }) => answer === "42" };
    // Turn 1 passed, turn 2 never ran: the predicate would call it right, which the task is not about.
    assert.equal(measureRun({ events: one, error: "TypeError: the next turn could not start" }, task).succeeded, null);
    // Both turns answered: scored, error or not.
    const two = [...one, end("43")];
    assert.equal(measureRun({ events: two }, task).succeeded, true);
    // One turn and an error, with no follow-up expected: scored as before.
    assert.equal(measureRun({ events: one, error: "late" }, { succeeded: task.succeeded }).succeeded, true);
    // An interview's asks count as turns the same way.
    assert.equal(measureRun({ events: one, error: "x" }, { asks: ["q2"], succeeded: task.succeeded }).succeeded, null);
});

test("spread / rate: nulls are skipped, never counted as zero", () => {
    assert.deepEqual(spread([2, 4, 6]), { mean: 4, sd: 2, n: 3 });
    assert.deepEqual(spread([]), { mean: null, sd: null, n: 0 });
    assert.equal(spread([5]).sd, 0, "a single run has no spread, which is not the same as unknown");
    assert.equal(rate([true, false, null, true]).mean, 2 / 3, "an unscored run is excluded from the denominator");
    assert.equal(rate([null, null]).mean, null);
});

test("aggregate: every declared column is produced, and errored runs are counted", () => {
    const m = [measureRun({ events: [start(), ...step(1, "answer", {}, "ok"), end("x")] }), measureRun({ events: [], error: "boom" })];
    const agg = aggregate(m);
    for (const c of COLUMNS) assert.ok(c.key in agg, `column ${c.key} must appear in the aggregate`);
    assert.equal(agg.runs, 2);
    assert.equal(agg.errors, 1);
});

// ─── the matrix itself ───────────────────────────────────────────────────────────────────────────────

test("combos: the cartesian product, in declaration order", () => {
    assert.deepEqual(combos({ a: ["x", "y"], b: [1, 2] }), [
        { a: "x", b: 1 }, { a: "x", b: 2 }, { a: "y", b: 1 }, { a: "y", b: 2 },
    ]);
    assert.deepEqual(combos({}), [{}], "a spec with no dimensions is still one cell, not none");
});

test("expandCells: combinations x tasks x repeats, with apply() resolved once per combination", () => {
    const spec = {
        dimensions: { fmt: ["hex", "label"] },
        tasks: [{ id: "a", task: "t" }, { id: "b", task: "t" }],
        apply: (c) => ({ agentOptions: { fmt: c.fmt } }),
    };
    const cells = expandCells(spec, { repeats: 3 });
    assert.equal(cells.length, 2 * 2 * 3);
    assert.deepEqual(cells[0].effects, { agentOptions: { fmt: "hex" } });
});

test("expandCells: --only and --skip select by dimension, task or repeat", () => {
    const spec = { dimensions: { fmt: ["hex", "label"] }, tasks: [{ id: "a", task: "t" }, { id: "b", task: "t" }] };
    assert.equal(expandCells(spec, { repeats: 2, only: parseSelector(["fmt=label"]) }).length, 4);
    assert.equal(expandCells(spec, { repeats: 2, only: parseSelector(["task=a"]) }).length, 4);
    assert.equal(expandCells(spec, { repeats: 2, only: parseSelector(["fmt=label", "task=a"]) }).length, 2);
    assert.equal(expandCells(spec, { repeats: 2, skip: parseSelector(["fmt=hex"]) }).length, 4);
    assert.equal(expandCells(spec, { repeats: 5, only: parseSelector(["repeat=0"]) }).length, 4);
});

test("selected: an unknown --only key matches nothing rather than everything", () => {
    const cell = { combo: { fmt: "hex" }, task: { id: "a" }, repeat: 0 };
    assert.equal(selected(cell, parseSelector(["nosuch=x"]), []), false);
});

test("cellKey: the BUILD is part of the identity, so an edit invalidates what it measured", () => {
    const cell = { combo: { fmt: "hex" }, task: { id: "a", task: "t" }, repeat: 0, effects: {} };
    assert.notEqual(cellKey(cell, "commitA"), cellKey(cell, "commitB"));
    assert.equal(cellKey(cell, "commitA"), cellKey({ ...cell }, "commitA"), "the same cell on the same build is cached");
});

test("cellKey: every axis of a cell changes its identity", () => {
    const base = { combo: { fmt: "hex" }, task: { id: "a", task: "t" }, repeat: 0, effects: {} };
    const k = cellKey(base, "c");
    assert.notEqual(cellKey({ ...base, repeat: 1 }, "c"), k);
    assert.notEqual(cellKey({ ...base, combo: { fmt: "label" } }, "c"), k);
    assert.notEqual(cellKey({ ...base, effects: { defines: { X: "1" } } }, "c"), k);
    assert.notEqual(cellKey({ ...base, task: { id: "a", task: "DIFFERENT" } }, "c"), k);
});

test("buildGroups: cells needing the same defines share one build; the undefined ones are 'default'", () => {
    const cells = [
        { effects: {} },
        { effects: { defines: { A: "1" } } },
        { effects: { defines: { A: "1" } } },
        { effects: { defines: { A: "2" } } },
    ];
    const groups = buildGroups(cells);
    assert.equal(groups.length, 3);
    assert.equal(groups.find((g) => g.id === "default").cells.length, 1);
    assert.equal(groups.filter((g) => g.id !== "default").reduce((n, g) => n + g.cells.length, 0), 3);
});

test("cellPath: a value that is not filesystem-safe still yields one directory segment per axis", () => {
    const p = cellPath({ combo: { model: "gemma4:31b/x" }, task: { id: "two tables" }, repeat: 2 });
    assert.equal(p, "two-tables/model-gemma4-31b-x/r2");
    assert.ok(!p.includes(":"));
});

// focusStep — which step the index should link INTO when a cell went wrong.
//
// The risk here is not a crash, it is a confident wrong answer: a link that lands on an innocent step
// sends you to read the wrong evidence, which is worse than landing at the top of the document and
// scrolling. So the interesting assertions are the ones where it must decline to guess.

test("focusStep: a tool that reported an error is the step to open", () => {
    const ev = [start(), ...step(1, "findByText", { text: "x" }, "found"),
        ...step(2, "exec", { js: "@tool:abc" }, "Error: Invalid or unexpected token"), end("gave up")];
    assert.deepEqual(focusStep({ events: ev }), { step: 2, tool: "exec", why: "tool error" });
});

test("focusStep: a memory fault OUTRANKS a later tool error — it is the more specific evidence", () => {
    const ev = [start(),
        ...step(1, "dereference", { ref: "@tool:zzzzzzz" }, "MemoryFault: no such pointer (distance 6)"),
        ...step(2, "exec", { js: "x" }, "Error: boom"), end("gave up")];
    assert.deepEqual(focusStep({ events: ev }), { step: 1, tool: "dereference", why: "memory fault" });
});

test("focusStep: a clean run that merely got the WRONG answer gets no step", () => {
    // Every tool worked; the answer is just not the expected one. There is no failing step, and pointing
    // at one would send the reader to an innocent call.
    const ev = [start(), ...step(1, "findByText", { text: "x" }, "found"), end("West")];
    assert.equal(focusStep({ events: ev }), null);
});

test("focusStep: a run that crashed lands on its LAST step", () => {
    const ev = [start(), ...step(1, "findByText", { text: "x" }, "found"),
        ...step(2, "sampleText", { sel: "td" }, "rows")];
    assert.deepEqual(focusStep({ events: ev, error: "timeout" }), { step: 2, tool: "sampleText", why: "run ended here" });
});

test("focusStep: a run with no steps at all has nothing to point at", () => {
    assert.equal(focusStep({ events: [start(), end("nothing to do")] }), null);
    assert.equal(focusStep({ events: [] }), null);
});

test("focusStep: a SEEDED step is not blamed — the script wrote it, not the model", () => {
    // The seed is the harness deliberately putting a failure in the history. Linking to it would report
    // the bench's own scaffolding as the run's failure.
    const ev = [start(), ...step(1, "exec", { js: "bad" }, "Error: seeded failure"),
        ...step(2, "findByText", { text: "x" }, "found"), end("fine")];
    assert.equal(focusStep({ events: ev, seedBoundaryStep: 1 }), null);
});

test("focusStep rides on the measurement, so the index needs no second pass over the stream", () => {
    const ev = [start(), ...step(1, "exec", { js: "x" }, "Error: boom"), end("nope")];
    assert.deepEqual(measureRun({ events: ev, runMs: 10 }, {}).focus, { step: 1, tool: "exec", why: "tool error" });
});

test("measureRun: a seeded run's seconds are its measured turns', without the scripted turn's", () => {
    const events = [{ kind: "agent-step", step: 0, thought: "seed" }, { kind: "agent-result", summary: "s" }, { kind: "agent-step", step: 1, thought: "real" }, { kind: "agent-result", summary: "r" }];
    assert.equal(measureRun({ events, runMs: 10_000, seedMs: 3000, seedBoundaryStep: 0 }).runMs, 7000);
    assert.equal(measureRun({ events, runMs: 10_000, seedMs: 3000, seedBoundaryStep: -1 }).runMs, 10_000, "unseeded: all of it");
    assert.equal(measureRun({ events, runMs: 10_000, seedBoundaryStep: 0 }).runMs, 10_000, "a run recorded before seedMs existed is unchanged");
});

// --- streaming as a knob: which runs stream, and whether they did ---

test("cellStream: the cell's stream, then its agentOptions, then the task's; unset, a UI surface streams and a console run does not", () => {
    const cell = (task = {}, effects = {}) => ({ task: { id: "t", task: "x", ...task }, effects, combo: {}, repeat: 0 });
    assert.equal(cellStream(cell()), false, "console default: off");
    assert.equal(cellStream(cell({ surface: "hud" })), true, "a UI run sends what the HUD sends");
    assert.equal(cellStream(cell({ surface: "hud" }, { surface: null })), false, "forced to the console");
    assert.equal(cellStream(cell({ stream: true })), true);
    assert.equal(cellStream(cell({ agentOptions: { stream: true } })), true);
    assert.equal(cellStream(cell({ stream: true }, { stream: false })), false, "the cell wins over the task");
    assert.equal(cellStream(cell({ surface: "hud" }, { stream: false })), false, "and over the surface's default");
    assert.equal(cellStream(cell({ stream: false }, { agentOptions: { stream: true } })), true, "the cell's agentOptions too");
    assert.equal(cellStream(cell({ agentOptions: { stream: true }, stream: false })), false, "the task's stream over its agentOptions");
});

test("cellKey: a streamed run is its own cache entry, and a non-streamed one keeps the key it had before stream was a knob", () => {
    const base = { task: { id: "t", task: "x" }, effects: {}, combo: { m: "a" }, repeat: 0 };
    const before = createHash("sha256").update(JSON.stringify({ fingerprint: "f", combo: base.combo, repeat: 0, effects: {},
        task: { id: "t", task: "x", start: null, tools: null, python: false, toolTokens: false, followup: "", seed: null, script: null, agentOptions: null } })).digest("hex").slice(0, 16);
    assert.equal(cellKey(base, "f"), before);
    assert.notEqual(cellKey({ ...base, effects: { stream: true } }, "f"), cellKey({ ...base, effects: { stream: false } }, "f"));
    assert.notEqual(cellKey({ ...base, task: { ...base.task, surface: "hud" } }, "f"), cellKey({ ...base, task: { ...base.task, surface: "hud" }, effects: { stream: false } }, "f"),
        "a UI run cached before it streamed is run again");
});

test("streamUse: asked, how many live deltas, and how many turns reported usage", () => {
    const evs = [
        { kind: "agent-step", step: 0, thought: "a", usage: { promptTokens: 10, completionTokens: 2 } },
        { kind: "agent-stream", step: 0, content: "a" },
        { kind: "agent-step", step: 0, seq: 1, tool: "exec", arguments: {}, result: "r" },
        { kind: "agent-step", step: 1, thought: "done" },
        { kind: "agent-stream", step: 1, content: "done" },
    ];
    assert.deepEqual(streamUse(evs, true), { asked: true, deltas: 2, streamed: true, turns: 2, turnsWithUsage: 1 });
    assert.deepEqual(streamUse(evs.filter((e) => e.kind !== "agent-stream"), true).streamed, false, "asked but never streamed is visible");
    assert.deepEqual(measureRun({ events: evs, stream: false }).stream.asked, false);
});

// --- a rate limit, by name ---

test("isRateLimit: a provider's rate limit however it arrives (Open WebUI passes OpenRouter's as a 400); other errors are not", () => {
    assert.ok(isRateLimit('HTTP 400: {"detail":"Rate limit exceeded: new-account-rpm/anthropic/claude-sonnet-5.5: new accounts are limited to 20 requests per minute for this model"}'));
    assert.ok(isRateLimit("HTTP 429 Too Many Requests"));
    assert.ok(isRateLimit("ratelimit"));
    assert.ok(!isRateLimit("HTTP 400: model not found"));
    assert.ok(!isRateLimit("timeout after 300000ms"));
    assert.ok(!isRateLimit(null));
});

