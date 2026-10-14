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

/** Run a survey in the worker; `{ hung: true }` past `ms`. */
function inWorker(src, { setup, stepBudget = 200_000, ms = 5000 } = {}) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, setup, stepBudget });
    });
}

/** The survey must END, and end OUT of dialect (the human gate), not with a value and not with a runtime error. */
async function fallsBack(src, why, o) {
    const r = await inWorker(src, o);
    assert.ok(!r.hung, `${why}: still running after 5 s`);
    assert.ok(r.threw === "NotInDialect" || r.threw === "Denied", `${why}: expected a fall-back to approval, got ${JSON.stringify(r)}`);
    return r;
}

// --- HALTING: a String OBJECT is checked as a string ---------------------------------------------------------------

test("HALTING: a String object gets a string's checks before repeat, padStart and a pattern given as a string", async () => {
    // `new String(...)` is a safe constructor, and `ml.dereference` returns one (DerefText), so the receiver of a string
    // method is not always a primitive. The size and backtracking checks looked only at `typeof obj === "string"`.
    const EVIL = `"a".repeat(34) + "!"`;
    for (const [src, why] of [
        [`new String(${EVIL}).match("(a+)+$")`, "match with a backtracking pattern string on a String object"],
        [`new String(${EVIL}).search("(a+)+$")`, "search, the same"],
        [`[...new String(${EVIL}).matchAll("(a+)+$")].length`, "matchAll, the same"],
        [`new String("ab").repeat(1000000000).length`, "repeat past MAX_STRING on a String object"],
        [`new String("ab").padStart(2000000000).length`, "padStart past MAX_STRING on a String object"],
    ]) await fallsBack(src, why);
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
const DAG = `let d = []; for (const _ of Array(40).keys()) d = [d, d];`;

test("HALTING: no host call or coercion can expand an array that shares its parts", async () => {
    for (const [src, why] of [
        ["JSON.stringify(d).length", "JSON.stringify"],
        ["JSON.stringify({ d }).length", "JSON.stringify of an object holding it"],
        ["d.flat(Infinity).length", "flat(Infinity)"],
        ["d.flatMap(x => x).flat(Infinity).length", "flatMap then flat"],
        ["String(d).length", "String()"],
        ["`${d}`.length", "a template literal"],
        ["(d + '').length", "+ with a string"],
        ["d * 1", "* (ToPrimitive calls toString)"],
        ["-d", "unary minus"],
        ["d.join().length", "join"],
        ["d.toString().length", "toString"],
        ["[d, d].sort().length", "sort without a comparator"],
        ["({})[d]", "a computed key"],
        ["'x'.includes(d)", "a string method's argument"],
        ["parseInt(d)", "a callable root's argument"],
        ["Object.fromEntries([[d, 1]])", "a key in fromEntries"],
        ["new Date(d)", "a safe constructor's argument"],
        ["d < 1", "a comparison"],
    ]) await fallsBack(`${DAG} ${src}`, why);
});

test("HALTING: printing or returning an array that shares its parts reaches the person, not a 2^40 serialisation", async () => {
    await fallsBack(`${DAG} console.log(d); 0`, "console.log");
    // The RETURNED value is serialised by every caller (formatReadonlyExec, a watch, the console): refused here, once.
    await fallsBack(`${DAG} d`, "the returned value");
    await fallsBack(`${DAG} ({ d })`, "the returned value, nested");
});

test("an array that shares its parts in a SMALL way still stringifies, prints and returns", async () => {
    const r = await inWorker(`const a = [1, 2]; const b = [a, a, a]; console.log(b); JSON.stringify(b) + String(b)`);
    assert.deepEqual(r, { value: "[[1,2],[1,2],[1,2]]1,2,1,2,1,2", logs: 1 });
    // A CYCLE is not followed by the walk: stringify's own TypeError reaches the script, catchable, as before.
    const c = await inWorker(`const o = { a: 1 }; o.me = o; let r = "ok"; try { JSON.stringify(o) } catch (e) { r = "circular" } r`);
    assert.deepEqual(c, { value: "circular", logs: 0 });
});

// --- HALTING: a loop of O(n) host calls --------------------------------------------------------------------------------

test("HALTING: a host call is charged for the size of what it walks, so a loop of them is bounded by the budget", async () => {
    // Each of these is a few steps per iteration and a few milliseconds of host work per iteration: tens of thousands
    // of iterations fit a step budget that assumed every step costs about the same.
    for (const [src, why] of [
        ["const big = new Array(1000000).fill(0); let n = 0; for (const _ of Array(100000).keys()) n += big.slice().length; n", "slice of a million-element array, in a loop"],
        ["const big = new Array(1000000).fill(0); let n = 0; for (const _ of Array(100000).keys()) n += big.indexOf(1); n", "indexOf over a million elements, in a loop"],
        ["const s = 'ab'.repeat(4000000); let n = 0; for (const _ of Array(100000).keys()) n += s.toLowerCase().length; n", "toLowerCase of 8M characters, in a loop"],
        ["const s = 'ab'.repeat(4000000); let n = 0; for (const _ of Array(100000).keys()) n += s.split('b').length; n", "split of 8M characters, in a loop"],
        ["const s = 'ab'.repeat(4000000); let n = 0; for (const _ of Array(100000).keys()) { const [c] = s; n++; } n", "destructuring 8M characters, in a loop"],
    ]) await fallsBack(src, why);
});

test("the charge leaves an ordinary survey alone: a filter-and-map over 20,000 rows still answers at the real budget", async () => {
    const r = await inWorker(`const rows = Array.from({ length: 20000 }, (_, i) => [i, "row " + i, i % 7, "west"]);
        const hits = rows.filter(r => r[2] === 3 && r[1].includes("9")).map(r => r[1].toUpperCase());
        const text = rows.map(r => r.join(",")).join("\\n");
        [hits.length, text.split("\\n").length, text.indexOf("row 19999") > 0, JSON.stringify(rows.slice(0, 100)).length > 0].join("|")`, { stepBudget: STEP_BUDGET });
    assert.ok(!r.hung && !r.threw, JSON.stringify(r));
    assert.match(String(r.value), /^\d+\|20000\|true\|true$/);
});

// Polynomial backtracking: ONE unbounded quantifier followed by something that can fail is quadratic on an unanchored
// search. `riskyRegex` refuses the exponential shapes only. Measured in Node 22: /a+b/ on 100,000 "a"s takes 3.7 s, so a
// million is minutes and MAX_STRING hours. Not fixed here: a sound bound needs a linear-time matcher, or a cap on the
// input length tied to the pattern's quantifiers (docs/dev/readonly-exec.md, "Threat questions answered", item 4).
test("HALTING: a single-quantifier pattern on a long input cannot backtrack quadratically", { todo: "riskyRegex refuses exponential shapes only; /a+b/ on 10^6 characters runs for minutes in one host call" }, async () => {
    await fallsBack(`"a".repeat(300000).match(/a+b/)`, "quadratic backtracking", { ms: 1500 });
});

// --- FAILURE: a survey refused by a new check leaves nothing behind ---------------------------------------------------

test("FAILURE: a survey that curates its answer and then trips an expansion, a cost charge or a page RegExp has changed nothing", async () => {
    const doc = new JSDOM("<!doctype html><body></body>").window.document;
    // A RegExp as a page value's property: the short input keeps a regression here from backtracking on the main thread.
    doc.body.re = /(a+)+$/;
    for (const [src, why] of [
        [`let d = []; for (const _ of Array(40).keys()) d = [d, d]; JSON.stringify(d)`, "an expansion"],
        [`const s = "ab".repeat(4000000); for (const _ of Array(100000).keys()) s.toLowerCase(); 0`, "the string charge"],
        [`document.body.re.test("ab")`, "a page RegExp"],
        [`new String("ab").match("(a+)+$")`, "a String object's pattern"],
    ]) {
        const set = new AnswerSet();
        await assert.rejects(evalReadonly(`ml.answer.add("found it"); ${src}`, doc, { getModel: async () => "m" }, makeAnswerFacade(set),
            { checkpoint: () => set.checkpoint(), stepBudget: 200_000 }), (e) => e instanceof NotInDialect || e instanceof Denied, why);
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
