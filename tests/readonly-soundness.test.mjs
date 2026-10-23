"use strict";
// readonly-soundness.test.mjs — the read-only dialect's HALTING contract against one host call: a String object, a RegExp
// the script did not build, an array that shares its parts, and a loop of O(n) host calls must each end at the human
// gate, never run for minutes. Also what a page-realm read hands the page (docs/dev/readonly-exec.md, "Threat questions").
//
// Every case runs in a worker with a timeout: before the fix each of these held a thread for minutes to hours, and on
// the main thread that would hang the runner instead of failing one test.
import { test, after } from "node:test";
import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied, STEP_BUDGET } from "../src/readonly-exec.ts";
import { AnswerSet, makeAnswerFacade } from "../src/pointers/answer-set.ts";
import { vectors } from "./dialect-vectors.mjs";
import { watchdogMs, assertNotHung } from "./fixtures/hang-watchdog.mjs";

/** The shared vectors (tests/fixtures/dialect-vectors/<genre>.json) lifted from a named group of this file. */
const lifted = (genre, label) => vectors(genre, `tests/readonly-soundness.test.mjs ${label}`);

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");

// One worker, reused; a case that HANGS costs a fresh one (terminating the thread is the only way to stop it).
// `setup` is an expression evaluated IN the worker to `{ doc, ml, opts }`, since a RegExp or a String subclass does not
// cross postMessage as itself.
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return import(workerData.url); });
        parentPort.on("message", ({ id, src, setup, stepBudget }) => ready
            .then(({ evalReadonly }) => {
                const env = setup ? (0, eval)("(" + setup + ")") : {};
                return evalReadonly(src, env.doc ?? { defaultView: null }, env.ml, undefined, { stepBudget, ...(env.opts || {}) });
            })
            .then((r) => parentPort.postMessage({ id, value: typeof r.value === "object" ? "object" : r.value, logs: r.logs.length }),
                  (e) => parentPort.postMessage({ id, threw: e.constructor.name, message: e.message })));`,
        { eval: true, workerData: { url: RO_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API } });
    worker.on("message", ({ id, ...r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: "WorkerError", message: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());

/** Run a survey in the worker; `{ hung: true }` if the halting watchdog fires first. */
function inWorker(src, { setup, stepBudget = 200_000, ms } = {}) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms ?? watchdogMs(stepBudget));
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, setup, stepBudget });
    });
}

/** The survey must END, and end OUT of dialect (the human gate), not with a value and not with a runtime error. */
async function fallsBack(src, why, o = {}) {
    const r = await inWorker(src, o);
    assertNotHung(r, why, o.stepBudget ?? 200_000);
    assert.ok(r.threw === "NotInDialect" || r.threw === "Denied", `${why}: expected a fall-back to approval, got ${JSON.stringify(r)}`);
    return r;
}

// --- HALTING: a String OBJECT is checked as a string ---------------------------------------------------------------

test("HALTING: a String object gets a string's checks before repeat, padStart and a pattern given as a string", async () => {
    // `new String(...)` is a safe constructor, and `ml.dereference` returns one (DerefText), so the receiver of a string
    // method is not always a primitive. The size and backtracking checks looked only at `typeof obj === "string"`.
    for (const v of lifted("halting", "a String object is checked as a string")) await fallsBack(v.js, v.name, { stepBudget: v.budget });
});

test("HALTING: in the WORKER, a pointer value (a String subclass) cannot be handed a backtracking pattern", async () => {
    // The worker realm is where another site's content is surveyed, and a hang there stalls every run the worker hosts.
    const setup = `{ ml: { dereference: () => new (class DerefText extends String {})("a".repeat(34) + "!") }, opts: { realm: "worker" } }`;
    await fallsBack(`ml.dereference("@tool:abc1234").match("(a+)+$")`, "a backtracking pattern on a pointer's text", { setup });
});

// --- HALTING: a RegExp the script did not build ----------------------------------------------------------------------

test("HALTING: a RegExp reached off a page value is checked like one the script wrote", async () => {
    // On the page realm a survey reads the page's JS properties (an expando is one), so a RegExp can arrive that never
    // passed the literal or `new RegExp` check.
    const setup = `{ doc: { re: /(a+)+$/, defaultView: null } }`;
    const EVIL = `("a".repeat(34) + "!")`;
    for (const [src, why] of [
        [`document.re.test(${EVIL})`, "test"],
        [`document.re.exec(${EVIL})`, "exec"],
        [`${EVIL}.match(document.re)`, "String.match with it"],
        [`${EVIL}.replace(document.re, "")`, "String.replace with it"],
        [`${EVIL}.split(document.re)`, "String.split with it"],
        [`new RegExp(document.re).test(${EVIL})`, "new RegExp copying it"],
    ]) await fallsBack(src, `a page RegExp, ${why}`, { setup });
});

// --- HALTING: an array that shares its parts --------------------------------------------------------------------------

// Forty lines of `d = [d, d]` build a value of 2^40 leaves out of forty arrays. Anything that EXPANDS it (stringify,
// flat, an array's toString, which every coercion of an array calls) does 2^40 work inside one host call. Measured in
// Node 22: String(d) at depth 24 takes 3 s, and each level doubles it.
// (The shared vectors spell this prefix out in each program; only the cases that need a `setup` still use the constant.)
const DAG = `let d = []; for (const _ of Array(40).keys()) d = [d, d];`;

test("HALTING: no host call or coercion can expand an array that shares its parts", async () => {
    for (const v of lifted("halting", "no host call or coercion can expand an array that shares its parts")) await fallsBack(v.js, v.name, { stepBudget: v.budget });
});

test("HALTING: printing or returning an array that shares its parts reaches the person, not a 2^40 serialisation", async () => {
    // The RETURNED value is serialised by every caller (formatReadonlyExec, a watch, the console): refused here, once.
    for (const v of lifted("halting", "printing or returning an array that shares its parts")) await fallsBack(v.js, v.name, { stepBudget: v.budget });
});

test("an array that shares its parts in a SMALL way still stringifies, prints and returns", async () => {
    const r = await inWorker(`const a = [1, 2]; const b = [a, a, a]; console.log(b); JSON.stringify(b) + String(b)`);
    assert.deepEqual(r, { value: "[[1,2],[1,2],[1,2]]1,2,1,2,1,2", logs: 1 });
    // A CYCLE is not followed by the walk: stringify's own TypeError reaches the script, catchable, as before.
    const c = await inWorker(`const o = { a: 1 }; o.me = o; let r = "ok"; try { JSON.stringify(o) } catch (e) { r = "circular" } r`);
    assert.deepEqual(c, { value: "circular", logs: 0 });
});

// --- HALTING: what a script's own arrow hands back, what an `ml` member is handed, what a Map or Set holds ------------

test("HALTING: an arrow the host calls cannot hand it an array that shares its parts to expand", async () => {
    // The guard walked what went INTO a host call; a callback's RETURN goes to the host unwalked, and a comparator's
    // result is ToNumber'd, a replacer's ToString'd, a toJSON's serialised.
    for (const v of lifted("halting", "an arrow the host calls cannot hand it an array that shares its parts")) await fallsBack(v.js, v.name, { stepBudget: v.budget });
});

test("HALTING: an `ml` member's arguments are walked, except the two that read them as data", async () => {
    // ml.range does Number(a), ml.answer.add String(x), ml.dereference String(ref): each joins an array argument.
    for (const [setup, src, why] of [
        ["{ ml: { range: (a, b) => { Number(b === undefined ? a : b); return []; } } }", "ml.range(d)", "ml.range"],
        ["{ ml: { dereference: (r) => String(r) } }", "ml.dereference(d)", "ml.dereference"],
        ["{ ml: { schema: (v) => JSON.stringify(v).length } }", "ml.schema(d)", "ml.schema"],
    ]) await fallsBack(`${DAG} ${src}`, why, { setup });
    // The answer facade is an `add` (in the list of methods that only store), and was walked by neither rule.
    const doc = new JSDOM("<!doctype html><body></body>").window.document;
    const facade = Object.assign(Object.create(null), { add: (x) => (typeof x === "string" ? 1 : String(x).length), remove() {}, clear() {}, dump: () => [] });
    await assert.rejects(evalReadonly(`let d = [1]; for (const _ of Array(30).keys()) d = [d, d]; ml.answer.add(d)`, doc, { getModel: async () => "m" }, facade, { stepBudget: 200_000 }),
        NotInDialect, "ml.answer.add of a shared-part array is refused before the facade coerces it");
});

test("HALTING: a Map or a Set does not hide an array that shares its parts", async () => {
    for (const v of lifted("halting", "a Map or a Set does not hide an array that shares its parts")) await fallsBack(v.js, v.name, { stepBudget: v.budget });
});

// --- HALTING: a long string that is consumed where no charge was ---------------------------------------------------

test("HALTING: a long string built by + is charged where it is hashed, compared, coerced or sliced", async () => {
    // `s + i` is a rope, O(1) to build; a Set lookup, a property key, a loose comparison or a fixed-slice read flattens
    // and hashes it: 8M characters, milliseconds, at the step cost of the 2-character version.
    for (const v of lifted("halting", "a long string built by + is charged where it is hashed, compared, coerced or sliced")) {
        assert.equal(v.budget, STEP_BUDGET, "the vector carries the shipped budget");
        await fallsBack(v.js, v.name, { stepBudget: v.budget, ms: 8000 });
    }
});

// --- HALTING: a loop of O(n) host calls --------------------------------------------------------------------------------

test("HALTING: a host call is charged for the size of what it walks, so a loop of them is bounded by the budget", async () => {
    // Each of these is a few steps per iteration and a few milliseconds of host work per iteration: tens of thousands
    // of iterations fit a step budget that assumed every step costs about the same.
    for (const v of lifted("halting", "a host call is charged for the size of what it walks")) await fallsBack(v.js, v.name, { stepBudget: v.budget });
});

test("the charge leaves ordinary surveys alone: a needle list over a long text, a reduce that concatenates, keys per item", async () => {
    for (const v of lifted("halting", "the charge leaves ordinary surveys alone")) {
        const r = await inWorker(v.js, { stepBudget: v.budget });
        assert.deepEqual(r, { value: v.expect.value, logs: 0 }, v.name);
    }
});

test("the charge leaves an ordinary survey alone: a filter-and-map over 20,000 rows still answers at the real budget", async () => {
    const r = await inWorker(`const rows = Array.from({ length: 20000 }, (_, i) => [i, "row " + i, i % 7, "west"]);
        const hits = rows.filter(r => r[2] === 3 && r[1].includes("9")).map(r => r[1].toUpperCase());
        const text = rows.map(r => r.join(",")).join("\\n");
        [hits.length, text.split("\\n").length, text.indexOf("row 19999") > 0, JSON.stringify(rows.slice(0, 100)).length > 0].join("|")`, { stepBudget: STEP_BUDGET });
    assertNotHung(r, "the survey", STEP_BUDGET);
    assert.ok(!r.threw, JSON.stringify(r));
    assert.match(String(r.value), /^\d+\|20000\|true\|true$/);
});

// --- HALTING: a regex search is charged for the backtracking it can do on its input --------------------------------

// Polynomial backtracking: ONE unbounded quantifier followed by something that can fail is quadratic on an unanchored
// search, and `riskyRegex` refuses the exponential shapes only. Measured in Node 22: /a+b/ on 100,000 "a"s took 3.7 s,
// so a million is minutes and MAX_STRING hours, in one host call the step count never saw. Each search is now priced
// before it runs, from its pattern and the runs of its input (regex-cost.ts), and charged to the step budget.
test("HALTING: a single-quantifier pattern on a long input cannot backtrack quadratically", async () => {
    await fallsBack(`"a".repeat(300000).match(/a+b/)`, "quadratic backtracking", { ms: 1500 });
});

test("HALTING: a regex search is charged for the backtracking it can do on its input, through every way a script searches", async () => {
    for (const v of lifted("halting", "a regex search is charged for the backtracking it can do on its input")) {
        assert.equal(v.budget, STEP_BUDGET, "the vector carries the shipped budget");
        await fallsBack(v.js, v.name, { stepBudget: v.budget, ms: 8000 });
    }
});

test("HALTING: a pattern is checked as the text the host compiles: an array or an object is not a way past riskyRegex", async () => {
    // `patternArg` read only a string, and `match`/`search`/`matchAll` coerce anything else with its `toString`.
    // Each is refused by THIS check, not by another one that happens to fire first: each takes its own path into the
    // engine (an array, a `toString` arrow, `matchAll`'s, a searched value), and a fix to one leaves the others open.
    for (const v of lifted("halting", "a pattern is checked as the text the host compiles")) {
        const r = await fallsBack(v.js, v.name, { stepBudget: v.budget, ms: 8000 });
        assert.match(r.message, /that is not a string or a regex/, v.name);
    }
});

test("the regex charge leaves ordinary searches alone: words, delimiters, log lines, a backreference, an anchored match", async () => {
    for (const v of lifted("halting", "the regex charge leaves ordinary searches alone")) {
        const r = await inWorker(v.js, { stepBudget: v.budget });
        assert.deepEqual(r, { value: v.expect.value, logs: 0 }, v.name);
    }
});

// --- HALTING: a replace is charged for the text it builds ----------------------------------------------------------

// `$'` and `` $` `` insert the text after and before each match, so `"a".repeat(n).replace(/a/g, "$'")` builds n²/2
// characters in one host call. The check after the call (`sized`) came once the string was in memory, up to V8's
// limit (0.5 GB at n = 30,000, a RangeError past it), and a result under MAX_STRING was charged as its receiver: 300
// replaces of 8.8 million characters each ran without asking. Each replace is now sized before it runs.
test("HALTING: a replace is refused before it builds a result over MAX_STRING, through every way a script replaces", async () => {
    // Refused by THIS check, before the host builds anything: the reason is the replace's own, not `sized`'s after it.
    for (const v of lifted("halting", "a replace is refused before it builds a result over MAX_STRING")) {
        const r = await fallsBack(v.js, v.name, { stepBudget: v.budget, ms: 8000 });
        assert.match(r.message, /a replace that would build over [\d,]+ characters/, v.name);
    }
});

test("HALTING: a replace is charged for the text it builds, so a loop of them under the limit runs out of budget", async () => {
    for (const v of lifted("halting", "a replace is charged for the text it builds")) await fallsBack(v.js, v.name, { stepBudget: v.budget, ms: 8000 });
});

test("HALTING: a replacement is a string or an arrow: an object, an array or a builtin is not a way past the size", async () => {
    for (const v of lifted("halting", "a replacement is a string or an arrow")) {
        const r = await fallsBack(v.js, v.name, { stepBudget: v.budget, ms: 8000 });
        assert.match(r.message, /a replace(r|ment) that/, v.name);
    }
});

test("the replace charge leaves ordinary rewrites alone: a date rewrite, $& around words, a delimiter, a replacer arrow", async () => {
    for (const v of lifted("halting", "the replace charge leaves ordinary rewrites alone")) {
        const r = await inWorker(v.js, { stepBudget: v.budget });
        assert.deepEqual(r, { value: v.expect.value, logs: 0 }, v.name);
    }
});

test("a replacer arrow that returns its match is counted at the receiver's size, not twice it", async () => {
    // The first version started at the receiver and added every return without taking away the match it replaced, so
    // an identity over 5.5 million characters counted 11 million and was refused. A raised budget pays for the 5.5
    // million calls, which the shipped one never would: the size is what this checks.
    const r = await inWorker(`"a".repeat(5500000).replace(/a/g, (c) => c).length`, { stepBudget: 30_000_000, ms: 20_000 });
    assert.deepEqual(r, { value: 5500000, logs: 0 });
});

test("replaceAll with a RegExp that is not global throws the host's own TypeError, not one from the size check", async () => {
    const r = await inWorker(`"abc".replaceAll(/b/, "$'".repeat(1000000))`);
    assert.equal(r.threw, "TypeError", JSON.stringify(r));
    assert.match(r.message, /replaceAll called with a non-global RegExp/);
});

// --- FAILURE: a survey refused by a new check leaves nothing behind ---------------------------------------------------

test("FAILURE: a survey that curates its answer and then trips an expansion, a cost charge or a page RegExp has changed nothing", async () => {
    const doc = new JSDOM("<!doctype html><body></body>").window.document;
    // A RegExp as a page value's property: the short input keeps a regression here from backtracking on the main thread.
    doc.body.re = /(a+)+$/;
    const cases = [
        ...lifted("failure", "a survey that curates its answer and then trips a check").map((v) => [v.js, v.name, v.budget]),
        [`ml.answer.add("found it"); document.body.re.test("ab")`, "a page RegExp", 200_000],   // needs the planted RegExp above
    ];
    for (const [js, why, stepBudget] of cases) {
        const set = new AnswerSet();
        await assert.rejects(evalReadonly(js, doc, { getModel: async () => "m" }, makeAnswerFacade(set),
            { checkpoint: () => set.checkpoint(), stepBudget }), (e) => e instanceof NotInDialect || e instanceof Denied, why);
        assert.equal(set.dump().length, 0, `${why}: the add before the refusal was rolled back`);
    }
});

// --- What a PAGE-realm survey hands the page ---------------------------------------------------------------------------

test("a page-realm survey runs the page's own code when it reads a page value: the page leg is the page's world", async () => {
    // Recorded rather than refused: on the page leg the survey is evaluated in the page's main world (run-delegation.ts),
    // so a getter, a proxy trap or a replaced built-in there is the page's code, and the page can make the answer say
    // anything. What keeps that harmless is what the page leg is NOT given: no pointer value (refused there) and no
    // ml.current (a refusal there), so a page that takes over the evaluator learns nothing of the run.
    const doc = new JSDOM("<!doctype html><body></body>").window.document;
    let ran = 0;
    Object.defineProperty(doc.body, "probe", { get() { ran++; return "the page's answer"; } });
    const r = await evalReadonly("document.body.probe", doc, {});
    assert.equal(r.value, "the page's answer");
    assert.equal(ran, 1, "the getter ran once, as a read in the page's world does");
    // The page leg's refusal of pointer reads is tests/delegation.test.mjs; ml.current is a refusal on the page realm.
    await assert.rejects(evalReadonly("ml.current", doc, { getModel: async () => "m" }), NotInDialect, "the page leg has no ml.current");
});
