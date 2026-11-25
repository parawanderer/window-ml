"use strict";
// readonly-while.test.mjs — `while` and `do…while` in the read-only exec dialect (ruling 104), and the budget trip that
// bounds them: a trip is an error the model reads (ResourceStop), never an approval. docs/dev/readonly-exec.md, "Halting".
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied, ResourceStop, STEP_BUDGET, MAX_STRING } from "../src/readonly-exec.ts";
import { AnswerSet, makeAnswerFacade } from "../src/pointers/answer-set.ts";
import { evalReadonlyInWorker } from "../src/sw/sw-readonly.ts";
import { readonlyRefused } from "../src/agent/approval.ts";
import { evalPolicy } from "../src/readonly-exec.ts";
import { mlPipe } from "../src/pointers/text-pipe.ts";
import { asTable } from "../src/table/table-data.ts";
import { expandPointers } from "../src/pointers/pointer-macro.ts";

const doc = () => new JSDOM("<!doctype html><title>t</title><body><p id='p'>hi</p></body>").window.document;
const BUDGET = 20_000;
const ml = () => ({ calls: 0, getModel: async function () { return "m"; }, range: (n) => Array.from({ length: n }, (_, i) => i) });
/** Runs `js` in the page realm with a small budget, so a trip costs milliseconds. */
const run = (js, opts = {}, host = ml()) => evalReadonly(js, doc(), host, undefined, { stepBudget: BUDGET, ...opts });
const trips = (js, opts, host) => assert.rejects(run(js, opts, host), (e) => e instanceof ResourceStop && !(e instanceof NotInDialect) && !(e instanceof Denied) && /^Stopped: the script (used its whole step budget|reached a step)/.test(e.message), js);
const refusesBeforeRunning = async (js) => {
    const host = ml();
    let ran = 0;
    host.getModel = async () => { ran++; return "m"; };
    await assert.rejects(run(`await ml.getModel(); ${js}`, {}, host), (e) => e instanceof ResourceStop && e.kind === "loop" && !(e instanceof NotInDialect) && /always true/.test(e.message), js);
    assert.equal(ran, 0, `${js}: refused when parsed, before anything ran`);
};

// --- what is admitted ---------------------------------------------------------------------------------------------------

test("`while` and `do…while` run: a counter, a test that turns false, a zero-turn loop, a body that runs once", async () => {
    assert.equal((await run("let i = 0; while (i < 5) { i++ } i")).value, 5);
    assert.equal((await run("let i = 0; while (i < 5) i++; i")).value, 5);
    assert.equal((await run("let i = 10; do { i++ } while (i < 5); i")).value, 11, "do…while runs its body once");
    assert.equal((await run("let i = 0; do { i++ } while (i < 5)\n i")).value, 5);
    for (const t of ["false", "0", '""', "null", "undefined", "!1", "!true"]) assert.equal((await run(`let n = 0; while (${t}) { n++ } n`)).value, 0, `${t}: no turn`);
});

test("`return` leaves a loop, however deep: the one exit the dialect has", async () => {
    assert.equal((await run("let i = 0; while (true) { i++; if (i > 3) return i }")).value, 4);
    assert.equal((await run("let i = 0; do { i++; if (i > 3) return i } while (true)")).value, 4);
    assert.equal((await run("while (1) { for (const x of [7, 8]) { if (x > 7) return x } }")).value, 8, "a return inside a for…of inside a while");
    assert.equal((await run("while ('x') { try { return 1 } finally { } }")).value, 1);
    assert.equal((await run("let a = 0; while (a < 3) { let b = 0; while (b < 3) { b++; a++ } } a")).value, 3, "nested whiles");
    assert.equal((await run("const f = () => { let i = 0; while (true) { i++; if (i > 2) return i } }; f() + f()")).value, 6, "a return inside a function leaves that function's loop");
});

test("a `while` works inside a callback a host method runs, and awaits an `ml` call each turn", async () => {
    assert.deepEqual((await run("[1, 2, 3].map((x) => { let n = 0; while (n < x) n++; return n })")).value, [1, 2, 3]);
    assert.equal((await run("let i = 0; while (i < 3) { await ml.getModel(); i++ } i")).value, 3);
    await assert.rejects(run("[1].map((x) => { let i = 0; while (i < 3) { await ml.getModel(); i++ } })"), (e) => e instanceof NotInDialect || e instanceof Denied, "an await in a callback is still out of dialect");
});

test("a `while` may change the collection it reads, because it holds nothing: the budget bounds it, and a `for…of` hold still stands", async () => {
    assert.equal((await run("const a = [1, 2, 3]; let n = 0; while (a.length) { a.pop(); n++ } n")).value, 3);
    await trips("const a = [1]; while (a.length) { a.push(1) }");
    await assert.rejects(run("const a = [1]; for (const x of a) { while (a.length < 3) { a.push(x) } }"), Denied, "a while cannot grow what an enclosing for…of holds");
});

// --- the static refusal: a constant-true test and no exit ---------------------------------------------------------------

test("a loop whose test is constant-true and whose body has no `return` is refused before anything runs", async () => {
    for (const js of [
        "while (true) { }", "while (true) 1", "while (1) { }", "while (2.5) { }", "while ('a') { }", "while (!0) { }", "while (!false) { }", "while (!null) { }",
        "while (!undefined) { }", "while (!'') { }", "while ((true)) { }",
        "do { } while (true)", "do { } while (1)", "do 1; while (!0)",
        // An exit that is not this loop's: inside a function or an arrow, `return` leaves THAT function.
        "while (true) { const f = () => { return 1 } }", "while (true) { const f = function () { return 1 } }",
        "while (true) { [1].map((x) => { return x }) }", "while (true) { [1].map((x) => x) }",
        "do { const f = () => { return 1 } } while (true)",
        // A loop inside, and no `return`: the inner loop's own end is not an exit of the outer.
        "while (true) { for (const x of [1]) { x } }", "while (true) { let i = 0; while (i < 3) i++ }",
        // `break`, `throw` and a label are not in the dialect, so they are no exit either.
        "while (true) { break }", "while (true) { throw 1 }", "while (true) { for (const x of [1]) { break } }",
    ]) await refusesBeforeRunning(js);
});

test("what the static refusal does NOT catch is bounded by the budget instead: the definition is small on purpose", async () => {
    for (const js of ["while (-1) { }", "while (!!1) { }", "while (1 < 2) { }", "while (true && true) { }", "while ([]) { }", "let t = true; while (t) { }", "while (!0 && 1) { }"])
        await trips(js);
});

test("a loop with an exit anywhere in its body is admitted, even one that is never reached", async () => {
    assert.equal((await run("while (true) { if (false) return 1; return 2 }")).value, 2);
    assert.equal((await run("do { if (1 > 2) { return 1 } return 3 } while (true)")).value, 3);
    // Statically present is enough: the check is about what the source says, and a `return` the loop cannot reach is
    // bounded by the budget like any other loop.
    await trips("while (true) { if (false) { return 1 } }");
});

test("`break`, `continue`, a label and `throw` are still not in the dialect: a loop using one is refused as before", async () => {
    // Pinned so the gap is visible: `while` brings no new way out of a loop but `return`.
    await assert.rejects(run("let i = 0; while (i < 3) { i++; break }"), (e) => e instanceof Denied && /'break' is not available/.test(e.message));
    await assert.rejects(run("let i = 0; while (i < 3) { i++; continue }"), (e) => e instanceof Denied && /'continue' is not available/.test(e.message));
    await assert.rejects(run("let i = 0; do { i++; break } while (i < 3)"), Denied);
    await assert.rejects(run("let i = 0; while (i < 3) { i++; throw 1 }"), Denied);
    await assert.rejects(run("for (const x of [1, 2]) { break }"), Denied, "nor does for…of have one");
    await assert.rejects(run("outer: while (i < 3) { }"), NotInDialect, "a label is a parse refusal, which still asks");
    await assert.rejects(run("let i = 0; while (i < 3) { switch (i) { } }"), Denied);
});

// --- the budget trip is its own error, and it is the model's -------------------------------------------------------------

test("a trip is a ResourceStop, not a NotInDialect or a Denied: the callers that ask a person do not see it", async () => {
    const e = await run("let i = 0; while (i >= 0) { i++ }").catch((x) => x);
    assert.ok(e instanceof ResourceStop);
    assert.ok(!(e instanceof NotInDialect) && !(e instanceof Denied));
    assert.equal(readonlyRefused(e), false, "the exec tool's refusal predicate: not a refusal, so it is answered, not asked");
    assert.equal(readonlyRefused(new NotInDialect("x")), true);
    assert.equal(readonlyRefused(new Denied("x")), true);
    assert.equal(e.message, "Stopped: the script used its whole step budget (20,000 steps) and nothing it computed, printed or added was kept. Bound the loop or narrow the work.");
    assert.ok(!/  /.test(e.message), "model-facing text carries no run of two spaces");
});

test("a trip is DETERMINISTIC: the same script stops at the same step, line and words, run after run", async () => {
    const js = "let n = 0;\nwhile (n >= 0) {\n  n = n + 1\n}";
    const seen = [];
    for (let i = 0; i < 3; i++) {
        const e = await run(js).catch((x) => x);
        seen.push([e.message, e.mlLine]);
    }
    assert.deepEqual(seen[0], seen[1]);
    assert.deepEqual(seen[1], seen[2]);
    assert.ok(seen[0][1] >= 2, "the line it stopped on is reported");
});

test("a stop runs no `finally` body, whatever its kind: a finalizer that would loop leaves the stop's kind as it was", async () => {
    const loops = "finally { let k = 0; while (k >= 0) { k++ } }";
    for (const [kind, body] of [["steps", "let n = 0; while (n >= 0) { n++ }"], ["string", `const s = "x".repeat(${MAX_STRING} + 1)`]]) {
        await assert.rejects(run(`try { ${body} } catch (e) { 1 } ${loops} 1`, {}, ml()),
            (e) => e instanceof ResourceStop && e.kind === kind, `${kind}: the finalizer did not run`);
    }
});

test("a trip cannot be swallowed: not by a try/catch, and not by a finally, which does not get to run", async () => {
    const host = ml();
    const set = new AnswerSet();
    const facade = makeAnswerFacade(set);
    await assert.rejects(evalReadonly(`try { let n = 0; while (n >= 0) { n++ } } catch (e) { ml.answer.add("caught") } finally { ml.answer.add("finally") } 1`,
        doc(), { ...host }, facade, { stepBudget: BUDGET, checkpoint: () => set.checkpoint() }), ResourceStop);
    assert.equal(set.dump().length, 0, "neither the catch nor the finally ran, and nothing the attempt added is left");
    await trips("let n = 0; try { while (n >= 0) { n++ } } catch (e) { 1 }");
    await trips("let n = 0; try { JSON.parse('{') } catch (e) { while (n >= 0) { n++ } }");
    await trips("[1].map((x) => { let n = 0; while (n >= 0) { n++ } })", {}, ml());
    await trips("Promise.all([1].map((x) => { let n = 0; while (n >= 0) { n++ } }))");
});

test("the budget error text: one without ml.sh, one with it, no padding, and the early-decided form says what was left", async () => {
    const plain = new ResourceStop("steps", { budget: 3_000_000 });
    const shell = new ResourceStop("steps", { budget: 3_000_000, shell: true });
    const early = new ResourceStop("steps-left", { budget: 3_000_000, left: 2_994_135, shell: true });
    assert.equal(plain.message, "Stopped: the script used its whole step budget (3,000,000 steps) and nothing it computed, printed or added was kept. Bound the loop or narrow the work.");
    assert.equal(shell.message, "Stopped: the script used its whole step budget (3,000,000 steps) and nothing it computed, printed or added was kept. Bound the loop or narrow the work; for a long computation, run a script detached through ml.sh.");
    assert.equal(early.message, "Stopped: the script reached a step that needs more than the 2,994,135 steps left of its 3,000,000-step budget and nothing it computed, printed or added was kept. Bound the loop or narrow the work; for a long computation, run a script detached through ml.sh.");
    for (const e of [plain, shell, early]) assert.ok(!/  /.test(e.message));
    // The evaluator takes the variant from the caller's `shell` (the prompt's own condition), both on a loop and on a priced regex.
    const via = (shellOpt, js) => evalReadonly(js, doc(), ml(), undefined, { stepBudget: BUDGET, ...(shellOpt ? { shell: true } : {}) }).catch((x) => x.message);
    assert.ok(!/ml\.sh/.test(await via(false, "let i = 0; while (i >= 0) { i++ }")));
    assert.match(await via(true, "let i = 0; while (i >= 0) { i++ }"), /detached through ml\.sh\.$/);
    assert.match(await via(true, `/a+b/.test("a".repeat(100000))`), /^Stopped: the script reached a step that needs more than the .* detached through ml\.sh\.$/);
});

test("a trip at the real budget costs STEP_BUDGET steps, and says so", async () => {
    const e = await evalReadonly("let i = 0; while (i >= 0) { i++ }", doc(), ml(), undefined, {}).catch((x) => x);
    assert.ok(e instanceof ResourceStop);
    assert.match(e.message, new RegExp(`^Stopped: the script used its whole step budget \\(${STEP_BUDGET.toLocaleString("en-US")} steps\\)`));
});

// --- which stops are trips and which are size refusals ------------------------------------------------------------------

test("TRIPS: running out of steps, a regex priced over what is left, and a walk that would not fit in what is left", async () => {
    await trips("let n = 0; for (const a of ml.range(1000)) for (const b of ml.range(1000)) n++; n");
    // A regex search priced before it runs: `/a+b/` over 300,000 `a`s is far over the whole budget, so it is a trip whatever is left.
    await assert.rejects(evalReadonly(`/a+b/.test("a".repeat(300000))`, doc(), ml(), undefined, {}), ResourceStop);
    await assert.rejects(evalReadonly(`const s = "a".repeat(300000); while (true) { if (/a+b/.test(s)) return 1 }`, doc(), ml(), undefined, {}), ResourceStop);
    // A walk of a value that expands past what is LEFT of a small budget: the same value is a size refusal at the real one.
    const shared = "let d = [1]; for (const i of ml.range(30)) d = [d, d]; JSON.stringify(d)";
    await assert.rejects(evalReadonly(shared, doc(), ml(), undefined, { stepBudget: 200_000 }), ResourceStop);
});

test("SIZE STOPS are ResourceStops now: a value over a cap is an error the model reads, whatever is left of the budget", async () => {
    const stop = (js, kind, why) => assert.rejects(evalReadonly(js, doc(), ml(), undefined, {}), (e) => e instanceof ResourceStop && e.kind === kind && !(e instanceof NotInDialect) && !(e instanceof Denied), why);
    await stop("let d = [1]; for (const i of ml.range(30)) d = [d, d]; JSON.stringify(d)", "expanded", "an array sharing its parts expands past MAX_EXPANDED at the real budget");
    await stop("let s = 'ab'; while (true) { s = s + s; if (s.length < 0) return 1 }", "string", "a string doubled past MAX_STRING");
    await stop("let a = [1, 2]; while (true) { a = a.concat(a); if (a.length < 0) return 1 }", "collection", "an array doubled past MAX_COLLECTION");
    await stop("Array(2000000)", "collection", "an allocation over MAX_COLLECTION");
    await stop(`"a".repeat(${MAX_STRING + 1})`, "string", "a repeat past MAX_STRING");
});

test("what still ASKS: a regex that could backtrack without end, and a script outside the dialect", async () => {
    await assert.rejects(evalReadonly("/(a+)+$/.test('aaaa')", doc(), ml(), undefined, {}), (e) => e instanceof NotInDialect && !(e instanceof ResourceStop));
    await assert.rejects(evalReadonly("new RegExp('(a+)+$')", doc(), ml(), undefined, {}), (e) => e instanceof NotInDialect && !(e instanceof ResourceStop));
    await assert.rejects(evalReadonly("document.body.remove()", doc(), ml(), undefined, {}), (e) => e instanceof NotInDialect || e instanceof Denied);
    for (const e of [new NotInDialect("x"), new Denied("x")]) assert.equal(readonlyRefused(e), true);
});

test("a `while` that grows a string or an array each turn meets the same caps, and the budget, as any loop", async () => {
    await trips("const a = []; let i = 0; while (true) { a.push(i); i++; if (i < 0) return a }");
    await trips("let s = ''; let i = 0; while (i >= 0) { s = s + 'x'; i++ }");
    await assert.rejects(run("let s = 'x'; while (s.length < 1000000000) { s = s + s }"), (e) => e instanceof ResourceStop && e.kind === "string");
});

test("a `while` whose test reads a page value: every read is the dialect's own, and the budget still stops it", async () => {
    await trips("let n = 0; while (document.title.length >= 0) { n++ }");
    await trips("let n = 0; while (document.querySelector('#p').textContent) { n++ }");
    await assert.rejects(run("while ((document.body.id = 'x')) { }"), (e) => e instanceof NotInDialect || e instanceof Denied, "a test cannot write to the page");
    await assert.rejects(run("while (document.defaultView) { return 1 }"), (e) => e instanceof NotInDialect || e instanceof Denied, "nor reach the realm");
    await assert.rejects(run("let n = 0; while (n < 3) { n++; document.body.remove() }"), (e) => e instanceof NotInDialect || e instanceof Denied);
});

// --- the contract: halting, failure, the doc ----------------------------------------------------------------------------

test("HALTING: every loop form ends within the budget, wherever the loop sits", async () => {
    for (const js of [
        "while (true) { if (false) return 1 }", "do { if (false) return 1 } while (true)", "let i = 0; while (i >= 0) i++",
        "let i = 0; while (i >= 0) { let j = 0; while (j < 10) j++; i++ }",
        "let f = (n) => { while (n >= 0) n++ }; f(1)",
        "const g = (n) => n > 0 ? g(n - 1) : 0; let i = 0; while (i >= 0) { g(100); i++ }",
        "let a = [1, 2, 3]; while (a.length >= 0) { a = [...a, 1] }",
    ]) {
        const t0 = Date.now();
        await trips(js);
        assert.ok(Date.now() - t0 < 5_000, js);
    }
});

test("FAILURE: a trip leaves nothing behind: the answer set is restored, the lines it printed are not in any result", async () => {
    const set = new AnswerSet();
    const facade = makeAnswerFacade(set);
    const lines = [];
    const e = await evalReadonly(`ml.answer.add("kept?"); console.log("printed"); let i = 0; while (i >= 0) { i++ }`, doc(), { ...ml() }, facade,
        { stepBudget: BUDGET, checkpoint: () => set.checkpoint(), onLog: (l) => lines.push(l) }).catch((x) => x);
    assert.ok(e instanceof ResourceStop);
    assert.equal(set.dump().length, 0, "the add before the trip was rolled back");
    assert.equal(e.value, undefined, "no value comes with a trip");
    assert.equal(e.logs, undefined, "and no logs: the caller reads an error, not a partial result");
    assert.deepEqual(lines, ["printed"], "the live line did stream, so the caller that streams it takes it back (the worker's drop, the page loop's discard)");
});

test("UPGRADE: a survey that used to trip and ask a person now returns the budget error to the model, with nothing of the attempt kept", async () => {
    // What the old code did with this script: NotInDialect("too much work to run without asking"), so the worker answered
    // `refused` and the person was asked to approve a run on the page. Now it is `answered`, as an error result.
    const pushed = [];
    let discarded = 0;
    const live = { push: (t) => pushed.push(t), discard: () => { discarded++; } };
    const slow = { range: (n) => Array.from({ length: n }, (_, i) => i) };
    const js = `console.log("tick"); let n = 0; const xs = ml.range(1000); for (const a of xs) for (const b of xs) for (const c of [1, 2, 3, 4]) n++; n`;
    const out = await evalReadonlyInWorker({ js }, { ml: slow, live });
    assert.equal(out.kind, "answered", "not `refused`: no approval card");
    assert.equal(out.result.split(" (line")[0], "Error: Stopped: the script used its whole step budget (3,000,000 steps) and nothing it computed, printed or added was kept. Bound the loop or narrow the work.");
    assert.match(out.result, /\(line 1\)/, "with the line it stopped on, as any runtime error has");
    assert.ok(!/tick/.test(out.result), "nothing it printed is in the result");
    assert.deepEqual(pushed, [], "held lines were dropped before they streamed, or taken back if they had");
    // The same trip on a run offered ml.sh names it as the way on; the prompt's own condition decides (`shell`).
    const withShell = await evalReadonlyInWorker({ js }, { ml: slow, shell: true });
    assert.match(withShell.result, /Bound the loop or narrow the work; for a long computation, run a script detached through ml\.sh\./);
    assert.ok(!/ml\.sh/.test(out.result), "and a run without ml.sh is not pointed at it");
    // A refusal that is a judgement about the script still goes to the person, as before.
    assert.equal((await evalReadonlyInWorker({ js: "/(a+)+$/.test('aaaa')" }, {})).kind, "refused");
});

// --- every resource stop is an error the model reads, never a card ---------------------------------------------------------

const KEPT = "and nothing it computed, printed or added was kept";
const PIECES = "Narrow the selection or work in pieces.";
const STRING = `Stopped: the script built a string of over 10,000,000 characters, the most one step may hold, ${KEPT}. ${PIECES}`;
const STRING_IN = (stage) => `Stopped: the script built a string of over 10,000,000 characters in the ${stage} stage, the most one step may hold, ${KEPT}. ${PIECES}`;
const COLLECTION = `Stopped: the script built an array, set or map of over 1,000,000 elements, the most one step may hold, ${KEPT}. ${PIECES}`;
const STORED = (total) => ({ columns: ["n", "s"], rows: [[0, "a"], [1, "b"]], shape: [total, 2], dtypes: { n: "int64", s: "str" }, truncated: true });
/** A host whose `dereference` hands back a stored table of `total` rows, read in full on demand. */
const storedHost = () => ({
    ...ml(), pipe: mlPipe,
    dereference: async () => ({ text: "n,s", type: "table", id: "a1b2c3d", tool: "fetch_url", step: 1,
        table: asTable(STORED(900_000), { readColumns: async (names) => ({ rowCount: 900_000, columns: Object.fromEntries(names.map((n) => [n, Array.from({ length: 900_000 }, (_, i) => i)])) }) }) }),
});
/** One script per cap: [kind, script, the exact text]. */
const CAPS = [
    ["string", `let s = "ab"; while (true) { s = s + s; if (s.length < 0) return 1 }`, STRING],
    ["string", `"a".repeat(20000000)`, STRING],
    ["string", `"a".padEnd(20000000)`, STRING],
    ["string", `ml.range(3).join("x".repeat(6000000))`, STRING],
    ["string", `"a".repeat(6000000).replace(/a/g, "bb")`, STRING],
    ["string", `ml.pipe("x".repeat(100000), "sed s/./" + "y".repeat(200) + "/g")`, STRING_IN("sed")],
    ["collection", `Array(2000000)`, COLLECTION],
    ["collection", `Array.from({ length: 2000000 })`, COLLECTION],
    ["collection", `let a = [1, 2]; while (true) { a = a.concat(a); if (a.length < 0) return 1 }`, COLLECTION],
    ["expanded", `let d = [1]; for (const i of ml.range(30)) d = [d, d]; JSON.stringify(d)`,
        `Stopped: the script used a value that expands to over 5,000,000 parts (an array holding the same array twice counts it twice), the most one step may walk, ${KEPT}. ${PIECES}`],
    ["expanded-chars", `const s = "x".repeat(9000000); JSON.stringify([s, s, s, s, s, s, s, s, s, s, s, s])`,
        `Stopped: the script used a value whose strings expand to over 100,000,000 characters, the most one step may walk, ${KEPT}. ${PIECES}`],
    ["cells", `const t = @tool:a1b2c3d.table; const n = []; for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) n.push(t.col("n").length); n`,
        `Stopped: the script read over 5,000,000 cells of stored tables, the most one script may read, ${KEPT}. Read fewer rows or columns, or work in pieces.`],
    ["depth", `const f = (n) => f(n + 1); f(0)`,
        `Stopped: the script's own functions nested past the depth limit (256 calls) ${KEPT}. Write the recursion as a loop.`],
    ["loop", `while (true) { }`,
        "Not run: the loop has a test that is always true and no `return` in its body, so it never ends. Add a `return` or give it a test that can turn false."],
];

test("each cap stops the script with its own text: which cap and its figure, what was kept, the way on", async () => {
    for (const [kind, js, text] of CAPS) {
        const host = storedHost();
        const e = await evalReadonly(expandPointers(js).code, doc(), host, undefined, {}).catch((x) => x);
        assert.ok(e instanceof ResourceStop, `${js}: ${e?.message}`);
        assert.equal(e.kind, kind, js);
        assert.equal(e.message, text, js);
        assert.ok(!(e instanceof NotInDialect) && !(e instanceof Denied), "not a refusal");
        assert.equal(readonlyRefused(e), false, `${js}: does not route to approval`);
        assert.ok(!/  /.test(e.message) && !/ml\.sh/.test(e.message), "no padding, and no ml.sh clause on a size stop");
    }
});

test("UPGRADE: each cap asked a person before (a NotInDialect, so `refused`); it now returns an error result and nothing else", async () => {
    for (const [kind, js, text] of CAPS) {
        const live = { pushed: [], discarded: 0, push(t) { this.pushed.push(t); }, discard() { this.discarded++; } };
        const out = await evalReadonlyInWorker({ js: `console.log("printed first"); ${js}` }, { ml: storedHost(), live });
        // `console.log` before a parse-time stop never runs; before a runtime stop it printed, and the result carries none of it.
        assert.equal(out.kind, "answered", `${kind}: ${js}: no approval card`);
        assert.ok(out.result.startsWith(`Error: ${text}`), `${kind}: ${out.result}`);
        assert.ok(!/printed first/.test(out.result), "nothing it printed is in the result");
        assert.deepEqual(live.pushed, [], "and nothing it printed stays in the live view");
    }
});

test("what STILL asks a person: the ml.embed caps, a regex that could backtrack, a Denied, and a script outside the dialect", async () => {
    const embedHost = { ...ml(), embed: async (x) => (Array.isArray(x) ? x : [x]).map(() => []) };
    const asks = async (js, why) => {
        const e = await evalReadonly(js, doc(), embedHost, undefined, {}).catch((x) => x);
        assert.ok(e instanceof NotInDialect || e instanceof Denied, `${why}: ${e?.message}`);
        assert.ok(!(e instanceof ResourceStop), why);
        assert.equal(readonlyRefused(e), true, why);
    };
    await asks(`ml.embed(Array.from({ length: 513 }, () => "a"))`, "more than 512 strings in one call");
    await asks(`for (const i of ml.range(33)) await ml.embed("cat")`, "more than 32 calls in one survey");
    await asks(`ml.embed("a".repeat(500001))`, "more than 500,000 characters in one survey");
    await asks("/(a+)+$/.test('aaaa')", "a regex that could backtrack without end");
    await asks(`"aaa".match("(a+)+$")`, "a pattern string handed to match");
    await asks("document.body.remove()", "an effect");
    await asks("for (;;) {}", "a loop form outside the dialect");
    for (const js of ["/(a+)+$/.test('aaaa')", "for (;;) {}", "[].constructor"])
        assert.equal((await evalReadonlyInWorker({ js }, { ml: embedHost })).kind, "refused", `${js}: the worker still hands it to the person`);
});

test("a pipe's size stop names the STAGE that hit it, at each of text-pipe's three sites", async () => {
    const stage = async (js, name) => {
        const e = await evalReadonly(js, doc(), { ...ml(), pipe: mlPipe }, undefined, {}).catch((x) => x);
        assert.ok(e instanceof ResourceStop && e.kind === "string", js);
        assert.equal(e.message, STRING_IN(name), js);
        assert.equal(readonlyRefused(e), false);
    };
    // sed: a substitution that would produce over the cap, refused before it builds anything.
    await stage(`ml.pipe("x".repeat(100000), "sed s/./" + "y".repeat(200) + "/g")`, "sed");
    // The JSON pretty-printers: the `values` stage, and a `.path` stage (named for itself).
    await stage(`ml.pipe('{"a":' + "[".repeat(3000) + "]".repeat(3000) + "}", "values")`, "values");
    await stage(`ml.pipe("[".repeat(3000) + "]".repeat(3000), ".")`, "path");
    // Any other stage whose OUTPUT is over the cap: named by its command.
    await stage(`ml.pipe("a".repeat(3000000), "grep -on .")`, "grep");
});

test("a policy containing `while` or `do…while` is broken when parsed: the loop forms are exec-realm only", () => {
    for (const src of ["(c) => { while (false) { } return true }", "(c) => { let i = 0; while (i < 2) { i++ } return true }", "(c) => { do { } while (false); return true }"]) {
        const r = evalPolicy(src, {}, "allow");
        assert.equal(r.decision, undefined, src);
        assert.match(r.broken, /^not allowed in a policy: `while` and `do…while` are for scripts/, src);
    }
    // The same source in a policy that loops with for…of is untouched.
    assert.equal(evalPolicy("(c) => { for (const x of [1]) { } return true }", {}, "allow").decision, "allow");
});

// --- a stop inside a policy is worded for a policy -----------------------------------------------------------------------

test("a policy with a constant-true `while` is broken with the policy's own sentence, not the script's `Add a return`", () => {
    for (const src of ["(c) => { while (true) { } return true }", "(c) => { do { } while (true); return true }"]) {
        const r = evalPolicy(src, {}, "allow");
        assert.equal(r.decision, undefined, src);
        assert.match(r.broken, /^not allowed in a policy: `while` and `do…while` are for scripts, not policies/, src);
        assert.doesNotMatch(r.broken, /ResourceStop|Add a `return`/, src);
    }
});

test("a policy whose recursion passes the depth limit is broken with the stop's own words and advice, without the class name", () => {
    const r = evalPolicy("(c) => { const f = (n) => f(n + 1); return f(0) }", {}, "allow");
    assert.equal(r.decision, undefined);
    assert.match(r.broken, /^Stopped: the script's own functions nested past the depth limit \(\d+ calls\) .*Write the recursion as a loop\.$/);
    assert.doesNotMatch(r.broken, /ResourceStop|not allowed in a policy/);
});

test("the budget text names ml.sh only when the survey's `shell` flag is set, and says nothing of it otherwise", async () => {
    // The flag is the run's `shellOffered` (host presence included, sw-run-host.ts); the host-absent and capability rows are in
    // tests/sh-offered.test.mjs. This pins what the text does with the flag it is handed.
    const via = (shell) => evalReadonlyInWorker({ js: "let i = 0; while (i >= 0) { i++ }" }, { ...(shell ? { shell: true } : {}) });
    assert.ok(!/ml\.sh/.test((await via(false)).result));
    assert.match((await via(true)).result, /detached through ml\.sh\./);
});
