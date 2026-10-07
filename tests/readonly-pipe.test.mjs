"use strict";
// readonly-pipe.test.mjs — `ml.pipe` as a member of the read-only `exec` dialect: free in a survey, and held to the
// same three properties as everything else there (it cannot reach anything, it cannot run unbounded, and a refusal
// leaves nothing behind).
//
// Models reach for the pipe constantly, often instead of the JS they would otherwise write
// (`ml.pipe(JSON.stringify(cfg, null, 1), "grep -iE 'model|approve' | head -40")`), and until this it sent every such
// survey to the human gate. What made it unsafe to just allow: one pipe is ONE host call doing work the step budget
// cannot see, over a regex the model wrote, and two of its stages can grow their input by more than a constant factor
// (`sed`, and pretty-printed JSON, which is quadratic in nesting depth: 6,000 characters became 18,000,000, measured).
import { test, after } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { Worker } from "node:worker_threads";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { mlPipe } from "../src/text-pipe.ts";
import { AnswerSet, makeAnswerFacade } from "../src/answer-set.ts";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hello</p></body>").window.document;
const CONFIG = { model: "qwen3.8-flash-next:vision", ocrModel: "qwen3-vl:30b", apiFormat: "openai",
    autoApproveReadonly: true, cdp: true, groundingEnabled: true, debugMode: "devtools", theme: "auto" };
let GETTER_RAN = false;
const ML = {
    config: async () => ({ ...CONFIG }),
    // A host value whose `text` is a GETTER: on the page that is the page's own code, and the pipe must never run it.
    info: async () => ({ get text() { GETTER_RAN = true; return "from a getter"; } }),
    range: (n) => Array.from({ length: n }, (_, i) => i),
    pipe: mlPipe,
};
const run = (js, ml = ML) => evalReadonly(js, doc(), ml);
const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;

// --- ml.pipe in a survey: what models actually write ------------------------------------------------------------------

test("the survey a model wrote runs with no approval, verbatim", async () => {
    // Copied from a real run, where it went to the approval card.
    const { value } = await run(`const c = await ml.config();
return ml.pipe(JSON.stringify(c, null, 1), "grep -iE 'model|approve|cdp|ground|debug|mode|server|vision|view' | head -40");`);
    const lines = value.split("\n");
    assert.ok(lines.some((l) => l.includes('"model": "qwen3.8-flash-next:vision"')), value);
    assert.ok(lines.some((l) => l.includes('"autoApproveReadonly": true')), value);
    assert.ok(!lines.some((l) => l.includes("apiFormat") || l.includes("theme")), "the grep filtered the rest out");
});

test("the source may be a string, a fetch-shaped result, or an array carrying `.text`; a bare array is told what to do", async () => {
    assert.equal((await run(`ml.pipe("a\\nb\\nc", "grep b")`)).value, "b");
    assert.equal((await run(`ml.pipe({ markdown: "# t\\nx", text: "<h1>" }, "head 1")`)).value, "# t", "markdown wins, as in mlPipe");
    assert.equal((await run(`ml.pipe({ text: "one\\ntwo" }, "tail 1")`)).value, "two");
    // The execution log's shape (an Array of records that also carries `.text`): the array is the data, the text
    // is what a pipe reads.
    assert.equal((await run(`const log = [{ kind: "a" }, { kind: "b" }]; log.text = "a 1\\nb 2"; return ml.pipe(log, "grep b")`)).value, "b 2");
    // A plain Error, reported to the model: no approval could make a wrong argument right.
    await assert.rejects(run(`ml.pipe([1, 2], "head 1")`), (e) => !outOfDialect(e) && /needs a string.*got an array/.test(e.message));
    await assert.rejects(run(`ml.pipe({ n: 1 }, "head 1")`), (e) => !outOfDialect(e) && /JSON\.stringify it first/.test(e.message));
});

test("stages may be one string or an array of stages; anything else is an error, not a refusal", async () => {
    assert.equal((await run(`ml.pipe("x|1\\ny|2", ["grep -F x|1", "head 1"])`)).value, "x|1", "an array stage keeps its bare |");
    await assert.rejects(run(`ml.pipe("a", 5)`), (e) => !outOfDialect(e) && /stages are a string/.test(e.message));
    await assert.rejects(run(`ml.pipe("a", ["head 1", 2])`), (e) => !outOfDialect(e));
});

test("an ordinary substitution still works, including one that puts the match back in", async () => {
    assert.equal((await run(`ml.pipe("a b c", "sed s/b/xyz/g")`)).value, "a xyz c");
    assert.equal((await run(`ml.pipe("ab", "sed 's/b/[$&]/'")`)).value, "a[b]");
});

// --- ADVERSARIAL: ml.pipe as a dialect member ---------------------------------------------------------------------------
// A pattern that backtracks exponentially is the one way a pipe could hang inside a single host call, where nothing can
// interrupt it. These run in a WORKER with a timeout, so a regression fails here instead of hanging the runner.

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const PIPE_URL = new URL("../src/text-pipe.ts", import.meta.url).href;
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return Promise.all([import(workerData.ro), import(workerData.pipe)]); });
        parentPort.on("message", ({ id, src, stepBudget }) => ready
            .then(([ro, tp]) => ro.evalReadonly(src, { defaultView: null },
                { pipe: tp.mlPipe, range: (n) => Array.from({ length: n }, (_, i) => i) }, undefined, { stepBudget }))
            .then((r) => parentPort.postMessage({ id, value: typeof r.value === "string" ? r.value.length : r.value }),
                  (e) => parentPort.postMessage({ id, threw: e.constructor.name, message: e.message })));`,
        { eval: true, workerData: { ro: RO_URL, pipe: PIPE_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API } });
    worker.on("message", ({ id, ...r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: "WorkerError", message: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());
function inWorker(src, ms = 5000, stepBudget = 200_000) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, stepBudget });
    });
}
/** The survey must END, and end OUT of dialect (the human gate), not with a value and not with a runtime error. */
async function fallsBack(src, why, stepBudget) {
    const r = await inWorker(src, 5000, stepBudget);
    assert.ok(!r.hung, `${why}: still running after 5 s`);
    assert.ok(r.threw === "NotInDialect" || r.threw === "Denied", `${why}: expected a fall-back to approval, got ${JSON.stringify(r)}`);
    return r;
}
// One line of `a`s ending in a character the pattern cannot match: the classic catastrophic-backtracking input.
const EVIL_LINE = `"${"a".repeat(40)}!"`;

test("ADVERSARIAL: a pattern that backtracks exponentially is refused before it compiles, in grep and in sed", async () => {
    for (const [src, why] of [
        [`ml.pipe(${EVIL_LINE}, "grep -E '(a+)+$'")`, "grep -E with a nested quantifier"],
        [`ml.pipe(${EVIL_LINE}, "grep '(a|aa)*$'")`, "grep with a repeated alternation"],
        [`ml.pipe(${EVIL_LINE}, "grep -iw '(\\\\w+\\\\s?)*$'")`, "grep -w, which wraps the pattern"],
        [`ml.pipe(${EVIL_LINE}, "sed 's/(a+)+$/x/'")`, "sed with a nested quantifier"],
        [`ml.pipe(${EVIL_LINE}, ["head 5", "grep -E (a+)+$"])`, "a risky pattern in a LATER stage"],
    ]) {
        const r = await fallsBack(src, why);
        assert.match(r.message, /needs approval/, why);
    }
});

test("ADVERSARIAL: -F makes the same pattern a literal, which is safe and runs", async () => {
    const r = await inWorker(`ml.pipe(${EVIL_LINE}, "grep -F '(a+)+$'")`);
    assert.ok(!r.hung && !r.threw, JSON.stringify(r));
});

test("ADVERSARIAL: a getter on the source is never run — the source is read from own DATA properties only", async () => {
    GETTER_RAN = false;
    await assert.rejects(run(`ml.pipe(await ml.info(), "head 1")`), (e) => !outOfDialect(e) && /needs a string/.test(e.message));
    assert.equal(GETTER_RAN, false, "the host's getter ran");
});

test("ADVERSARIAL: a script cannot hand the pipe its own limits, or reach the host function", async () => {
    // A third argument is never forwarded: the dialect's limits are the only ones the host sees.
    const r = await fallsBack(`ml.pipe(${EVIL_LINE}, "grep -E '(a+)+$'", { onPattern: null, maxChars: 1000000000000 })`, "a forged limits object");
    assert.match(r.message, /needs approval/);
    // Read as a VALUE, the member is the inert sentinel, so it cannot be called past the gate.
    await assert.rejects(run(`const p = ml.pipe; return p("a", "head 1")`), outOfDialect);
    await assert.rejects(run(`[ml.pipe].map(f => f("a", "head 1"))`), outOfDialect);
});

test("ADVERSARIAL: try/catch cannot swallow a pipe's refusal — of a pattern, of a size, or of the budget", async () => {
    // A refusal is a GUARD signal the dialect re-raises past any catch, which is what makes every other rule here
    // hold. The pipe raises its refusals from INSIDE a host call, so this is checked rather than assumed.
    for (const [src, why] of [
        [`try { return ml.pipe("ab", "grep -E '(a+)+$'") } catch (e) { return "swallowed" }`, "a refused pattern"],
        [`try { return ml.pipe("x".repeat(100000), "sed s/./" + "y".repeat(200) + "/g") } catch (e) { return "swallowed" }`, "a refused size"],
        [`try { const t = ml.range(200000).join("\\n"); return ml.range(1000).map(() => ml.pipe(t, "sort")).length } catch (e) { return "swallowed" }`, "an exhausted budget"],
    ]) await fallsBack(src, why, 3_000_000);
});

// --- HALTING and cost: what one host call is charged -------------------------------------------------------------------

test("HALTING: pipes inside a long .map spend the step budget, so they end at the human gate instead of running on", async () => {
    // About 1.3M characters, sorted a thousand times. Uncharged, that is several seconds inside host calls the budget
    // never sees; charged at its input and output it is a handful of calls.
    const r = await fallsBack(`const t = ml.range(200000).join("\\n"); return ml.range(1000).map(() => ml.pipe(t, "sort")).length`,
        "a thousand sorts of 1.3M characters");
    assert.match(r.message, /too much work/);
});

test("HALTING: a pretty-print that would be quadratic is refused before it builds anything", async () => {
    // 6,000 characters of nesting re-emitted through `.` was 18,000,000 characters (measured), in one host call.
    const r = await fallsBack(`ml.pipe("[".repeat(3000) + "]".repeat(3000), ".")`, "3,000-deep JSON through a path stage", 3_000_000);
    assert.match(r.message, /nested 3,000 levels deep/);
    // The same through `values`, the other stage that emits a nested value.
    await fallsBack(`ml.pipe('{"a":' + "[".repeat(3000) + "]".repeat(3000) + "}", "values")`, "3,000-deep JSON through values", 3_000_000);
});

test("HALTING: sed may not multiply its input past the cap, and a line stage may not either", async () => {
    // One copy of a 200-character replacement per character: 20M from 100k, refused before the line is built.
    const r = await fallsBack(`ml.pipe("x".repeat(100000), "sed s/./" + "y".repeat(200) + "/g")`, "sed growing 200x", 3_000_000);
    assert.match(r.message, /sed: this substitution would produce over/);
    // A `$&` inserts the match, so it counts as a whole line: the bound is an upper bound, never an estimate.
    await fallsBack(`ml.pipe("x".repeat(100000), "sed 's/x/$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&$&/g'")`,
        "sed growing by $& references", 3_000_000);
    // `grep -on .` numbers every character, four times its input: the per-stage output check catches it.
    const g = await fallsBack(`ml.pipe("a".repeat(3000000), "grep -on .")`, "grep -on over 3M characters", 3_000_000);
    assert.match(g.message, /produced over/);
});

// --- FAILURE: a refused pipe leaves nothing behind ----------------------------------------------------------------------

test("FAILURE: a survey that curates its answer and then pipes a refused pattern has changed nothing", async () => {
    const set = new AnswerSet();
    await assert.rejects(
        // A SHORT input: the pattern is refused before anything is matched, so this tests the same property, and if
        // that guard ever regresses this fails at once instead of backtracking on the main thread (152 s, measured).
        evalReadonly(`ml.answer.add("found it"); return ml.pipe("ab", "grep -E '(a+)+$'")`,
            doc(), ML, makeAnswerFacade(set), { checkpoint: () => set.checkpoint() }),
        outOfDialect);
    assert.equal(set.dump().length, 0, "the add before the refusal was rolled back");
});
