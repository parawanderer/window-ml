// Turning a stack frame back into the MODEL'S line number (src/exec-trace.ts). `exec` runs the source
// inside one of two wrappers and each shifts the line differently, so this is measured against the real
// constructs — a hardcoded offset would be a claim about a V8 detail nothing here controls.
//
// The invariant under all of it: a line it cannot be sure of is NULL. A wrong line number is worse than
// none, because the reader (and the model) goes and looks at it, finds ordinary code, and concludes the
// tool is broken rather than that the number was.
import { test } from "node:test";
import assert from "node:assert";
import { rawEvalLine, rawEvalPos, evalLineOffset, evalColOffset, execErrorLine, execErrorExcerpt, lineExcerpt, surveyWhere, evalWrapper, asyncWrapper } from "../src/tools/exec-trace.ts";

// The two wrappers tools.ts builds, the same functions.
const runEval = (src, params = ["state"]) => evalWrapper(params)(...params.map(() => undefined)).run(src);
const runAsync = (src, params = ["state"]) => asyncWrapper(params, src)(...params.map(() => undefined));

test("the LAST <anonymous> on a frame is the one that locates the code", () => {
    // A V8 eval frame names <anonymous> twice — the outer one is where the eval was CALLED from.
    assert.equal(rawEvalLine("Error: x\n    at eval (eval at <anonymous> (<anonymous>:1:34), <anonymous>:3:6)"), 3);
    assert.equal(rawEvalLine("Error: x\n    at <anonymous>:7:11"), 7);
    // The innermost frame wins: it is where it actually threw.
    assert.equal(rawEvalLine("Error: x\n    at <anonymous>:2:1\n    at <anonymous>:9:1"), 2);
});

test("no stack, or a stack with no evaluated frame, is null", () => {
    assert.equal(rawEvalLine(undefined), null);
    assert.equal(rawEvalLine("Error: x"), null);
    assert.equal(rawEvalLine("Error: x\n    at Object.<anonymous> (/app/index.js:3:9)"), null);
});

test("the eval wrapper's line IS the source's line", async () => {
    const src = "const a = 1;\nconst b = null;\nb.x.y;\n";
    let line = "no throw";
    try { runEval(src); } catch (e) { line = await execErrorLine(e.stack, "eval", ["state"], 3); }
    assert.equal(line, 3);
    assert.equal(await evalLineOffset("eval", ["state"]), 0);
});

test("the async wrapper shifts the line, and the shift is MEASURED not assumed", async () => {
    const src = "const a = 1;\nconst b = null;\nawait 0;\nb.x.y;";
    let line = "no throw";
    try { await runAsync(src); } catch (e) { line = await execErrorLine(e.stack, "async", ["state"], 4); }
    assert.equal(line, 4, "the failure is on line 4 of what the model wrote");
    // The raw frame is NOT 4 — that difference is the whole reason this file exists.
    let raw = null;
    try { await runAsync(src); } catch (e) { raw = rawEvalLine(e.stack); }
    assert.notEqual(raw, 4);
    assert.equal(raw - await evalLineOffset("async", ["state"]), 4);
});

test("the offset follows the PARAMETER LIST, since that is the wrapper's own first line", async () => {
    // `exec` passes an extra `ml` when there are pointers to substitute. Both shapes must resolve to the
    // same source line, which is what makes the offset a function of the params rather than a constant.
    const src = "const b = null;\nawait 0;\nb.x;";
    for (const params of [["state"], ["state", "ml"]]) {
        let line = null;
        try { await runAsync(src, params); } catch (e) { line = await execErrorLine(e.stack, "async", params, 3); }
        assert.equal(line, 3, `params ${params.join()}`);
    }
});

test("a frame from OUTSIDE the source is refused rather than pointed at", async () => {
    // The failure happens inside something the code called, so the innermost evaluated frame is beyond the
    // end of a short script. Clamping it to the last line would send the reader to innocent code.
    const src = "const f = () => { throw new Error('deep'); };\nf();";
    let e;
    try { runEval("\n\n\n\n\n\n\n\n\nnull.x;"); } catch (err) { e = err; }
    assert.equal(await execErrorLine(e.stack, "eval", ["state"], 2), null, "line 10 is not a line of a 2-line script");
    assert.ok(src);
});

test("an unmeasurable stack is null, never a guess", async () => {
    assert.equal(await execErrorLine(undefined, "eval", ["state"], 10), null);
    assert.equal(await execErrorLine("Error: nope", "async", ["state"], 10), null);
});

// --- the piece of a long line, in place of a column ---

test("a long line gets a piece of itself with ▶ at the spot; a short one gets nothing", () => {
    const long = "a".repeat(60) + "BAD" + "b".repeat(60);
    const piece = lineExcerpt(long, 61);
    assert.match(piece, /^…a+▶BADb+…$/);
    assert.ok(piece.length < long.length);
    assert.equal(lineExcerpt("short();", 1), null, "a line number already says where on a short line");
    assert.equal(lineExcerpt(long, 0), null, "a column outside the line is no place");
    assert.equal(lineExcerpt(long, long.length + 1), null);
    assert.ok(!/ {2}/.test(lineExcerpt("x".repeat(90) + "   y   " + "z".repeat(40), 92)), "no padding reaches the model");
});

test("the frame's column is read with its line", () => {
    assert.deepEqual(rawEvalPos("Error: x\n    at eval (eval at <anonymous> (<anonymous>:1:34), <anonymous>:3:6)"), { line: 3, col: 6 });
    assert.equal(rawEvalPos("Error: x"), null);
});

// The model's own script from the run that found this (one line, `i` unbound in the reduce), through both wrappers.
const ONE_LINE = "const nums = ['Q1', 'Q2']; const r = ['Ada', 'East', '1', '2']; " +
    "const q = Object.fromEntries(nums.map((n, i) => [n, Number(r[i + 2])])); const total = nums.reduce((s, n) => s + Number(r[i + 2]), 0); return total;";

test("on line 1 the eval wrapper's prefix shifts the column, and the shift is MEASURED", async () => {
    assert.ok(await evalColOffset("eval", ["state"]) > 0, "the fast path prepends its `ran` marker to line 1");
    let e;
    try { runEval(ONE_LINE.replace(" return total;", " total;")); } catch (err) { e = err; }
    assert.match(await execErrorExcerpt(e.stack, "eval", ["state"], ONE_LINE), /s \+ Number\(r\[▶i \+ 2\]\)/);
});

test("the async wrapper puts the source on a line of its own, so its column is the source's", async () => {
    assert.equal(await evalColOffset("async", ["state"]), 0);
    let e;
    try { await runAsync(ONE_LINE); } catch (err) { e = err; }
    assert.match(await execErrorExcerpt(e.stack, "async", ["state"], ONE_LINE), /s \+ Number\(r\[▶i \+ 2\]\)/);
});

test("a survey's error says its line, and the piece only beside a line", () => {
    assert.deepEqual(surveyWhere({ mlLine: 1, mlExcerpt: "…r[▶i]…" }), { at: 1, where: " (line 1)\nat: …r[▶i]…" });
    assert.deepEqual(surveyWhere({ mlLine: 3 }), { at: 3, where: " (line 3)" });
    assert.deepEqual(surveyWhere(new Error("x")), { at: null, where: "" });
    assert.deepEqual(surveyWhere("a string"), { at: null, where: "" });
});
