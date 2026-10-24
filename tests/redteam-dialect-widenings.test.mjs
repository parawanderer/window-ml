// redteam-dialect-widenings.test.mjs — the read-only dialect widenings of #1093 (`dialect-artifact-gaps`, merged as
// 2fe3e352 BEFORE this pass) under attack: a destructuring pattern as a `for…of` loop variable, the `NumberCtor`
// statics, a decimal number as an object key, and `riskyRegex`'s loosened bound on a repeated group of an EXACT count
// (`(\d{3})+` now passes; `{0,1}` is now refused like `?`). The widening merged first, so this file is what keeps that
// honest afterwards — AGENTS.md's dialect rule: abuse the new surface AND re-check the whole contract (HALTING in a
// worker with a timeout, FAILURE leaving nothing behind).
//
// The coordinator's first question was whether the cost model prices what the shape check now admits (rule 8: nothing
// is claimed before it is measured). Measured against real V8 on this machine: `(\d{3})+b` over 100,000 digits is 4.0 s
// of engine work and is priced at 273,440,430 units (over the 3M-step budget), and every shape the bound calls "ok"
// runs under its own charge. No unpriced exact-count group. The charges are pinned HERE, not just the verdicts, so a
// weakening of regex-cost.ts that leaves the corpus verdicts unchanged still fails.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { evalReadonly, NotInDialect, Denied, STEP_BUDGET } from "../src/readonly-exec.ts";
import { regexWork, regexSteps, REGEX_UNITS_PER_STEP } from "../src/readonly-exec/regex-cost.ts";
import { riskyRegex } from "../src/readonly-exec/limits.ts";
import { kindOf, methodAllowed, offeredMethods, MUTATING_METHODS } from "../src/readonly-exec/policy.ts";
import { watchdogMs, assertNotHung } from "./fixtures/hang-watchdog.mjs";

const current = () => ({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], meta: [{}, {}], log: [], run: { id: "r" } });
const run = (code, cur = current()) => evalReadonly(code, null, {}, undefined, { realm: "worker", stepBudget: 200_000, current: cur });
const refused = (e) => e instanceof NotInDialect || e instanceof Denied;
const X = (n) => "x".repeat(n);
const D = (n) => "1".repeat(n);
const A = (n) => "a".repeat(n);

// --- the charge the loosened bound admits (the coordinator's rule-8 measurement, pinned) -----------------------------
//
// `riskyRegex` now admits `(\d{3})+` and `(\d{3}){k}` (an exact count is not a quantifier inside a group). The safety
// of that is not the verdict alone: regexWork must still charge the search on the input it is about to run over. On a
// LONG NON-MATCHING input the charge is finite and linear in the input (the group repeats a fixed-width piece a fixed
// number of times, so the only work is one failed attempt per start); on a run of the characters it repeats, `+` and
// `{n,}` backtrack quadratically and must be over the budget before the engine sees the string.

test("CHARGE: `(\d{3})+` on a long non-matching input is priced finite and linear in the input", () => {
    const one = regexSteps("(\\d{3})+", "", X(100_000));
    const two = regexSteps("(\\d{3})+", "", X(200_000));
    assert.ok(Number.isFinite(one) && one > 0, `finite and positive, got ${one}`);
    assert.ok(one < STEP_BUDGET, `a non-matching input is cheap enough to run: ${one}`);
    // The pin: a charge that collapses toward zero, or stops growing with the input, is an unpriced search.
    assert.equal(one, 2735, "the bound's units for 100k non-matching characters (counts every start)");
    assert.equal(two, 5469, "and double the input is double the charge");
    assert.ok(Math.abs(two / one - 2) < 0.01, `linear in the input, got ${two / one}x`);
});

test("CHARGE: `(\d{3}){k}` on a long non-matching input is priced finite and proportional to k", () => {
    const k20 = regexSteps("(\\d{3}){20}", "", X(100_000));
    const k20b = regexSteps("(\\d{3}){20}", "", X(200_000));
    const k200 = regexSteps("(\\d{3}){200}", "", X(100_000));
    assert.equal(k20, 141408, "the bound's units for {20} over 100k non-matching characters");
    assert.equal(k200, 1407046, "and for {200}");
    assert.ok(Math.abs(k200 / k20 - 10) < 0.1, `proportional to k, got ${k200 / k20}x`);
    assert.ok(Math.abs(k20b / k20 - 2) < 0.01, `linear in the input, got ${k20b / k20}x`);
    assert.ok(k200 < STEP_BUDGET, "still under the budget on 100k: the search may run");
});

test("CHARGE: a repeated exact-count group that backtracks quadratically is over the budget before the engine runs", () => {
    // `(\d{3})+b` over a run of digits: greedy, then one backtrack per group of three from every start. Measured in
    // V8 on this machine: 4.0 s of engine work at 100k characters (165 ms at 20k) for a search that never matches.
    // The bound prices it at 273M units — over the 3M-step budget — so the survey goes to the person instead.
    const big = regexSteps("(\\d{3})+b", "", D(100_000));
    assert.equal(big, 273440430, "the bound's units for the quadratic exact-count shape on 100k digits");
    assert.ok(big > STEP_BUDGET, `over the whole budget, got ${big}`);
    assert.ok(regexSteps("(\\d{3})+b", "", D(20_000)) > STEP_BUDGET, "and over it at 20k, where V8 already takes 165 ms");
    // `{n,}` is the same shape with a floor: `(\d{3}){2,}b` is quadratic too, and priced the same way.
    assert.ok(regexSteps("(\\d{3}){2,}b", "", D(20_000)) > STEP_BUDGET, "{2,} is quadratic and priced out");
    // A FINITE count of a fixed-width piece is not: `(\d{3}){20}b` tries twenty groups, not n/3 of them.
    assert.ok(regexSteps("(\\d{3}){20}b", "", D(100_000)) < STEP_BUDGET, "{20} is linear and may run");
    // …and a finite count with a large maximum is priced out as its maximum grows, not admitted at any width.
    assert.ok(regexSteps("(\\d{3}){2,50}b", "", D(300_000)) < STEP_BUDGET, "{2,50} on 300k still fits");
    assert.ok(regexSteps("(\\d{3}){2,50}b", "", D(1_000_000)) > STEP_BUDGET, "{2,50} on 1M does not");
});

test("CHARGE: the bound's own scan is billed too, and the unit constant is pinned", () => {
    const charged = [];
    regexWork("(\\d{3})+", "", X(10_000), (n) => charged.push(n));
    assert.ok(charged.length >= 1, "one scan for the repeat's atoms");
    assert.ok(charged.every((n) => n >= 10_000 / 256), JSON.stringify(charged));
    assert.equal(REGEX_UNITS_PER_STEP, 512, "the measured units-per-step; a recalibration updates this pin in the same breath");
});

// --- HALTING: the dialect refuses the quadratic exact-count search before it runs ------------------------------------
//
// regexCharge (evaluator.ts) prices the search and throws NotInDialect over what is left of the budget, BEFORE the
// host call runs. If that charge stops firing, V8 holds the thread for minutes: these run in a worker with the
// halting watchdog, so a regression fails instead of hanging the runner.

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return import(workerData.url); });
        parentPort.on("message", ({ id, src, stepBudget }) => ready
            .then(({ evalReadonly }) => evalReadonly(src, { defaultView: null }, {}, undefined, { stepBudget, realm: "worker" }))
            .then((r) => parentPort.postMessage({ id, value: typeof r.value === "object" ? "object" : r.value }),
                  (e) => parentPort.postMessage({ id, threw: e.constructor.name, message: e.message })));`,
        { eval: true, workerData: { url: RO_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API } });
    worker.on("message", ({ id, ...r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: "WorkerError", message: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());

function inWorker(src, { stepBudget = 200_000, ms } = {}) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms ?? watchdogMs(stepBudget));
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, stepBudget });
    });
}

test("HALTING: an exact-count shape that backtracks quadratically is refused before the engine runs, at 20k and at 300k", async () => {
    for (const [src, n] of [[`"1".repeat(20000).search(/(\\d{3})+b/)`, 20_000], [`"1".repeat(300000).search(/(\\d{3})+b/)`, 300_000]]) {
        const r = await inWorker(src, { stepBudget: STEP_BUDGET, ms: 8000 });
        assertNotHung(r, `(\d{3})+b over ${n} digits`, STEP_BUDGET);
        assert.equal(r.threw, "NotInDialect", `${src}: ${JSON.stringify(r)}`);
        assert.match(r.message, /could backtrack for too long/, src);
    }
});

test("HALTING: the non-matching charge leaves an ordinary exact-count search alone", async () => {
    // The same pattern class, on input where it cannot run: charged (see the pins above) and allowed through.
    const r = await inWorker(`"x".repeat(100000).search(/(\\d{3}){20}/)`, { stepBudget: STEP_BUDGET });
    assertNotHung(r, "(\d{3}){20} over non-matching", STEP_BUDGET);
    assert.deepEqual(r, { value: -1 }, "priced, under the budget, and it ran");
    const sep = await inWorker(`"1234567".replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")`, { stepBudget: STEP_BUDGET });
    assert.deepEqual(sep, { value: "1,234,567" }, "the idiom the widening was for still works");
});

// --- the `{0,1}` tightening closed a hole the old check left open ----------------------------------------------------
//
// `repeatAt` now reads `{0,1}` as "var", so a repeated group holding one is refused the way `?` is. Before this
// change `(a{0,1})+b` passed the shape check and V8 took 2.1 s over 20,000 "a"s in a single host call.

test("HALTING: `{0,1}` in a repeated group is refused at the shape check, before any search", () => {
    assert.equal(riskyRegex("^(a{0,1})+$"), "a repeated group that contains a quantifier");
    assert.equal(riskyRegex("(a{0,1})+b"), "a repeated group that contains a quantifier");
    assert.equal(riskyRegex("(a?)+b"), "a repeated group that contains a quantifier", "and `?` is refused as it always was");
    // An exact count of one repeats nothing and is not a quantifier: `(a{1})+` is `(a)+`, linear, and passes.
    assert.equal(riskyRegex("(a{1})+b"), null);
});

test("HALTING: the dialect refuses the {0,1} shape without running it", async () => {
    const r = await inWorker(`"a".repeat(20000).search(/(a{0,1})+b/)`, { stepBudget: STEP_BUDGET, ms: 8000 });
    assertNotHung(r, "(a{0,1})+b over 20k a-run", STEP_BUDGET);
    assert.equal(r.threw, "NotInDialect", JSON.stringify(r));
    assert.match(r.message, /could backtrack without end/, "refused by the SHAPE check, not the charge");
});

// --- a for…of pattern: the names and shapes the idiom list does not pin -----------------------------------------------

test("ADVERSARIAL: a for…of pattern cannot bind a denied name even as the script's own data", async () => {
    // The pattern reads each key through the member-read guard, so an OWN data property called `constructor` or
    // `eval` is denied the same as the live one: the name is what is refused, not the value's type.
    for (const src of [
        "for (const { constructor } of [{ constructor: 1 }]) return constructor",
        "for (const { eval } of [{ eval: 1 }]) return eval",
        "for (const { eval } of [{ eval: 1 }]) return typeof eval",
        "for (const { __proto__ } of [{}]) return __proto__",
        "for (const { prototype } of [{ prototype: 1 }]) return prototype",
    ]) await assert.rejects(run(src), refused, src);
    // A name that is NOT denied binds the script's own value: `fetch` as an own key is just data, never the global.
    assert.equal((await run("for (const { fetch } of [{ fetch: 1 }]) return typeof fetch")).value, "number");
});

test("ADVERSARIAL: a for…of pattern refuses a getter rather than running it, and a numeric pattern key is not a shorthand", async () => {
    // On the worker realm the member read is data-only (readonly-exec.md, "Threat questions" 5): a getter is a
    // refusal, so the pattern cannot be the one read that runs page code.
    for (const src of [
        "const o = { get x() { return 1 } }; for (const { x } of [o]) return x",
        "const o = { get x() { throw new Error('boom') } }; for (const { x } of [o]) return x",
        "const o = { get x() { this.y = 1; return 1 } }; for (const { x } of [o]) return [x, o.y]",
        "for (const { 0: z } of [['a']]) return z",
        "for (const { __proto__: p } of [{}]) return p",
        "for (const [a, [b]] of [[[1]]]) return b",
        "for (const { a = 1 } of [{}]) return a",
    ]) await assert.rejects(run(src), (e) => refused(e) || e instanceof TypeError, src);
    // A string is an ordinary iterable of one-character strings: destructuring a character is a plain read.
    assert.deepEqual((await run("for (const [a, b] of 'ab') return [a, b]")).value, ["a", undefined]);
});

// --- NumberCtor: a property read is not a method call ----------------------------------------------------------------

test("ADVERSARIAL: NumberCtor's property reads are data, its method gate is the six statics, and no road to a realm", () => {
    assert.equal(kindOf(Number), "NumberCtor");
    assert.deepEqual(offeredMethods("NumberCtor"), ["isNaN", "isFinite", "isInteger", "isSafeInteger", "parseFloat", "parseInt"]);
    for (const m of offeredMethods("NumberCtor")) assert.ok(!MUTATING_METHODS.has(m), m);
    // A data property is readable but is not a method: `methodAllowed` is the CALL gate, and these fail it.
    for (const n of ["MAX_VALUE", "NaN", "EPSILON", "name", "length", "call", "constructor", "prototype"])
        assert.equal(methodAllowed(Number, n), false, `Number.${n} is not a callable member`);
    assert.equal(methodAllowed(Number, "isNaN"), true);
});

test("ADVERSARIAL: Number's data properties read as data, and a number's constructor is denied", async () => {
    assert.equal((await run("Number.MAX_VALUE")).value, 1.7976931348623157e+308);
    assert.equal((await run("Number.EPSILON")).value, 2.220446049250313e-16);
    assert.equal((await run("Number.name")).value, "Number");
    assert.ok(Number.isNaN((await run("Number.NaN")).value), "NaN is the number NaN");
    for (const src of ["(1).constructor", "(1.5).constructor === Number", "Number.constructor", "Number.prototype",
        "Number.isNaN.constructor('return globalThis')()", "Object.getPrototypeOf(Number)"])
        await assert.rejects(run(src), refused, src);
    // The static is still callable after all that: the gate is on the call, not on the binding.
    assert.equal((await run("Number.isNaN(1)")).value, false);
    assert.equal((await run("Number['isNaN'](1)")).value, false, "a computed key is the same gate");
});

// --- FAILURE: falling out of the dialect leaves nothing behind -------------------------------------------------------

test("FAILURE: a survey that uses the widenings and then falls out reaches the person and writes nothing", async () => {
    const cur = current();
    await assert.rejects(run("const n = {}; for (const { role } of ml.current.messages) n[role] = Number.isNaN(role); fetch(n)", cur), refused);
    await assert.rejects(run("const o = { 1: 'a' }; o[1] = '1,234,567'.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); window.alert(o[1])", cur), refused);
    await assert.rejects(run("for (const [a] of ml.current.messages) { a.content = 'changed' }; fetch('x')", cur), refused);
    assert.deepEqual(cur, current(), "the context is as it was");
    // A pattern that throws mid-loop is an ordinary error the script can catch, and leaves no binding behind.
    await assert.rejects(run("for (const [a] of 5) a"), TypeError);
    assert.equal((await run("const out = []; for (const [k] of Object.entries({ a: 1 })) out.push(k); out")).value[0], "a", "and the idiom still works");
});
