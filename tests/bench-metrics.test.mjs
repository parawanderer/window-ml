// The bench's metric extractors, against event streams whose right answer is known by construction.
//
// A benchmark whose extractors are wrong measures its own bug and reports it confidently, so these run in
// the FAST suite rather than only through a browser: every metric is a pure function of the debug stream,
// so it can be handed a stream that deliberately re-emits, deliberately corrupts an identifier, and
// deliberately recovers, and asserted to report exactly that.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stepsOf, authoredTexts, capturedOutputs, sharesRun, reEmission, pointerRefs, pointerUse,
    recovery, tokenCost, measureRun, afterSeed, spread, rate, aggregate, COLUMNS,
} from "../tests/e2e/bench/metrics.mjs";
import { combos, expandCells, cellKey, selected, parseSelector, buildGroups, cellPath } from "../tests/e2e/bench/cells.mjs";

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
    assert.equal(r.instances[0].fromSeq, 1);
    assert.equal(r.instances[0].atSeq, 2);
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
    const ev = [
        start(),
        ...step(1, "look", {}, "a chart", { usage: { promptTokens: 100, completionTokens: 20 }, subUsage: [{ promptTokens: 900, completionTokens: 30 }] }),
        ...step(2, "answer", {}, "ok", { usage: { promptTokens: 200, completionTokens: 10 } }),
        end("done"),
    ];
    assert.deepEqual(tokenCost(ev), { prompt: 300, completion: 30, sub: 930, total: 1260 });
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
    assert.equal(measureRun({ events: ev, seedBoundarySeq: 2 }).seeded, true);
    assert.equal(measureRun({ events: ev, seedBoundarySeq: 2 }).reEmission.reEmitted, 0);
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
