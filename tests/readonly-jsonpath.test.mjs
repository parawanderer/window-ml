"use strict";
// readonly-jsonpath.test.mjs — `ml.jsonPath` as a member of the read-only `exec` dialect: free in a survey, and held to
// the same three properties as everything else there (it cannot reach anything, it cannot run unbounded, and a refusal
// leaves nothing behind). The engine's RFC 9535 conformance is tests/json-path.test.mjs; this file is about the guard.
//
// One query is ONE host call doing work the step count cannot see, over an expression the model wrote and data the
// script may have built: `$..[?@..x]` is quadratic in depth, a `match()` pattern can backtrack, and a cycle walked by
// `..` would never end. So every node visited is charged to the step budget, every pattern passes `riskyRegex`, and the
// data is read as DATA (a getter is refused, not run).
import { test, after } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { Worker } from "node:worker_threads";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { mlJsonPath } from "../src/json-path.ts";
import { AnswerSet, makeAnswerFacade } from "../src/pointers/answer-set.ts";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hello</p></body>").window.document;
const CONFIG = { model: "qwen3.8-flash-next:vision", ocrModel: "qwen3-vl:30b", apiFormat: "openai", autoApproveReadonly: true };
let GETTER_RAN = 0;
const getterArray = () => { const a = [1]; Object.defineProperty(a, 0, { enumerable: true, get() { GETTER_RAN++; return 1; } }); return a; };
const ML = {
    config: async () => ({ ...CONFIG }),
    // Host values carrying GETTERS: on the page that is the page's own code, and the query must never run it.
    info: async () => ({ get text() { GETTER_RAN++; return "from a getter"; } }),
    // A getter on an array INDEX, which `v[i]` and `v.map` read through.
    models: async () => ({ items: getterArray() }),
    // A getter only an equality comparison reaches: the walk never visits the subtree `==` compares.
    ps: async () => ({ a: { get x() { GETTER_RAN++; return 1; } }, b: { x: 1 } }),
    // The same, on array ELEMENTS only `==` reads.
    capabilities: async () => ({ a: getterArray(), b: [1] }),
    range: (n) => Array.from({ length: n }, (_, i) => i),
    jsonPath: mlJsonPath,
};
const run = (js, ml = ML) => evalReadonly(js, doc(), ml);
const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;
const notJson = (re) => (e) => !outOfDialect(e) && re.test(e.message);

// --- ml.jsonPath in a survey: what it is for -------------------------------------------------------------------------

test("a query over host data runs with no approval, and `paths` gives Normalized Paths", async () => {
    assert.deepEqual((await run(`const c = await ml.config(); return ml.jsonPath(c, "$.model")`)).value, [CONFIG.model]);
    assert.deepEqual((await run(`ml.jsonPath({ a: [1, 2] }, "$.a[*]", { paths: true })`)).value,
        [{ path: "$['a'][0]", value: 1 }, { path: "$['a'][1]", value: 2 }]);
    assert.deepEqual((await run(`ml.jsonPath('{"items":[{"id":1},{"id":2}]}', "$.items[?@.id > 1].id")`)).value, [2]);
});

test("a malformed expression or a non-string one is an error the model reads, not a refusal", async () => {
    await assert.rejects(run(`ml.jsonPath({ a: 1 }, "$[")`), notJson(/invalid JSONPath/));
    await assert.rejects(run(`ml.jsonPath({ a: 1 }, 5)`), notJson(/expression string/));
    await assert.rejects(run(`ml.jsonPath("not json", "$")`), notJson(/needs JSON/));
});

// --- ADVERSARIAL: ml.jsonPath as a dialect member -----------------------------------------------------------------------

test("ADVERSARIAL: a getter on the source is never run — on a member, an array index, or a subtree only `==` reaches", async () => {
    for (const [src, why] of [
        [`ml.jsonPath(await ml.info(), "$.text")`, "a member named by the query"],
        [`ml.jsonPath(await ml.info(), "$.*")`, "a member reached by a wildcard"],
        [`ml.jsonPath(await ml.info(), "$..*")`, "a member reached by descent"],
        [`ml.jsonPath(await ml.models(), "$.items[0]")`, "an array index"],
        [`ml.jsonPath(await ml.models(), "$.items[*]")`, "an array index reached by a wildcard"],
        [`ml.jsonPath(await ml.models(), "$.items[0:1]")`, "an array index reached by a slice"],
        [`ml.jsonPath(await ml.ps(), "$[?@ == $.b]")`, "a member only an equality comparison reads"],
        [`ml.jsonPath(await ml.capabilities(), "$[?@ == $.b]")`, "an array element only an equality comparison reads"],
    ]) {
        GETTER_RAN = 0;
        await assert.rejects(run(src), notJson(/getter/), why);
        assert.equal(GETTER_RAN, 0, `${why}: the host's getter ran`);
    }
});

test("ADVERSARIAL: a Map, a DOM node, or a node held inside data is refused, never walked into", async () => {
    for (const [src, why] of [
        [`ml.jsonPath(new Map([["a", 1]]), "$.a")`, "a Map as the source"],
        [`ml.jsonPath(document.querySelector("#p"), "$.ownerDocument")`, "a DOM node as the source"],
        [`ml.jsonPath({ el: document.querySelector("#p") }, "$.el.ownerDocument")`, "a DOM node a name selector steps into"],
        [`ml.jsonPath({ el: document.querySelector("#p") }, "$..*")`, "a DOM node reached by descent"],
        [`ml.jsonPath({ el: document.body }, "$.el[?@.nodeType]")`, "a DOM node a filter would iterate"],
    ]) await assert.rejects(run(src), notJson(/not JSON data/), why);
});

test("ADVERSARIAL: a script cannot hand the query its own limits, or reach the host function", async () => {
    // The third argument is sanitized to `{ paths }` and a fourth is never forwarded: the dialect's limits are the only
    // ones the host sees, so neither a forged `onPattern` nor a forged `charge` switches a guard off.
    for (const src of [
        `ml.jsonPath(["a"], '$[?match(@, "(a+)+b")]', { paths: true, onPattern: null, charge: null })`,
        `ml.jsonPath(["a"], '$[?match(@, "(a+)+b")]', null, { onPattern: () => {}, charge: () => {} })`,
    ]) await assert.rejects(run(src), (e) => e instanceof Denied && /needs approval/.test(e.message), src);
    // Read as a VALUE, the member is the inert sentinel, so it cannot be called past the gate.
    await assert.rejects(run(`const j = ml.jsonPath; return j({ a: 1 }, "$.a")`), outOfDialect);
    await assert.rejects(run(`[ml.jsonPath].map(f => f({ a: 1 }, "$.a"))`), outOfDialect);
});

test("ADVERSARIAL: a `match()`/`search()` pattern that could backtrack is refused before it compiles", async () => {
    // An I-Regexp is translated to a JS RegExp, so the translated source is what riskyRegex judges. A SHORT input on
    // purpose, as in every main-thread case here: the refusal comes before anything is matched, and if that guard ever
    // regresses this fails at once instead of backtracking on the test runner's thread.
    for (const fn of ["match", "search"]) {
        await assert.rejects(run(`ml.jsonPath(["aaa"], '$[?${fn}(@, "(a+)+b")]')`),
            (e) => e instanceof Denied && /needs approval/.test(e.message), fn);
    }
    // An ordinary pattern runs.
    assert.deepEqual((await run(`ml.jsonPath(["ab", "cd"], '$[?match(@, "a.")]')`)).value, ["ab"]);
});

// --- HALTING and cost: what one host call is charged -------------------------------------------------------------------
// These run in a WORKER with a timeout, so a regression fails here instead of hanging the runner.

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const JP_URL = new URL("../src/json-path.ts", import.meta.url).href;
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return Promise.all([import(workerData.ro), import(workerData.jp)]); });
        parentPort.on("message", ({ id, src, stepBudget }) => ready
            .then(([ro, jp]) => ro.evalReadonly(src, { defaultView: null },
                { jsonPath: jp.mlJsonPath, range: (n) => Array.from({ length: n }, (_, i) => i) }, undefined, { stepBudget }))
            .then((r) => parentPort.postMessage({ id, value: Array.isArray(r.value) ? r.value.length : r.value }),
                  (e) => parentPort.postMessage({ id, threw: e.constructor.name, message: e.message })));`,
        { eval: true, workerData: { ro: RO_URL, jp: JP_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API } });
    worker.on("message", ({ id, ...r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: "WorkerError", message: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());
function inWorker(src, ms = 8000, stepBudget = 3_000_000) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, stepBudget });
    });
}
/** The survey must END, and end OUT of dialect (the human gate), not with a value and not with a runtime error. */
async function fallsBack(src, why) {
    const r = await inWorker(src);
    assert.ok(!r.hung, `${why}: still running after 8 s`);
    assert.ok(r.threw === "NotInDialect" || r.threw === "Denied", `${why}: expected a fall-back to approval, got ${JSON.stringify(r)}`);
    return r;
}
// JSON nested `n` deep, as a string: the dialect builds it in one step, and the engine parses it.
const DEEP_OBJ = (n) => `'{"x":'.repeat(${n}) + "1" + "}".repeat(${n})`;
const DEEP_ARR = (n) => `"[".repeat(${n}) + "]".repeat(${n})`;

test("HALTING: `$..[?@..x]` is quadratic in depth, and every node it visits spends the step budget", async () => {
    // 3,000 deep: each of 3,000 nodes walks the subtree under it, 4.5M visits in one host call. With `x` every visit
    // also selects a member, which is charged on its own; with a name that is never there, only the walk is.
    for (const q of ["$..[?@..x]", "$..[?@..absent]"]) {
        const r = await fallsBack(`ml.jsonPath(${DEEP_OBJ(3000)}, "${q}").length`, `${q} over 3,000-deep JSON`);
        assert.match(r.message, /too much work/);
    }
});

test("HALTING: a query inside a long .map spends the same budget, so it ends at the human gate", async () => {
    const r = await fallsBack(`const d = ml.range(2000).map(i => ({ id: i })); return ml.range(2000).map(() => ml.jsonPath(d, "$[*].id").length).length`,
        "two thousand queries over two thousand rows");
    assert.match(r.message, /too much work/);
});

test("HALTING: a path is never copied per node, and materialising Normalized Paths is charged by depth", async () => {
    // 100,000 deep: copying the path per child is 5 billion key copies for a walk charged 100,000 nodes, and printing
    // every match's path from the root is the same again.
    const plain = await inWorker(`ml.jsonPath(${DEEP_ARR(100000)}, "$..*")`);
    assert.ok(!plain.hung, "a walk of 100,000-deep JSON is linear");
    assert.equal(plain.value, 99999);
    const r = await fallsBack(`ml.jsonPath(${DEEP_ARR(100000)}, "$..*", { paths: true })`, "100,000 paths, each 100,000 deep");
    assert.match(r.message, /too much work/);
});

test("HALTING: a cyclic object the script built is an error under `..`, and a budget stop under `==`", async () => {
    // A script may write to its own objects, so it can build a cycle JSON cannot express. A descent refuses it.
    const c = await inWorker(`const o = { a: 1 }; o.me = o; return ml.jsonPath(o, "$..a")`);
    assert.ok(!c.hung, "a walk of a cycle ended");
    assert.equal(c.threw, "JsonPathError");
    assert.match(c.message, /cycle/);
    // Two DIFFERENT cycles of the same shape never compare unequal; the comparison is charged, so it stops.
    const r = await fallsBack(`const a = { k: 1 }; a.s = a; const b = { k: 1 }; b.s = b; return ml.jsonPath({ a, b }, "$[?@ == $.b]")`,
        "equality over two distinct cycles");
    assert.match(r.message, /too much work/);
});

test("ADVERSARIAL: try/catch cannot swallow a query's refusal — of a pattern, or of the budget", async () => {
    // A refusal is a GUARD signal the dialect re-raises past any catch. The engine raises its refusals from INSIDE a
    // host call, so this is checked rather than assumed.
    for (const [src, why] of [
        [`try { return ml.jsonPath(["a"], '$[?search(@, "(a+)+b")]') } catch (e) { return "swallowed" }`, "a refused pattern"],
        [`try { return ml.jsonPath(${DEEP_OBJ(3000)}, "$..[?@..x]") } catch (e) { return "swallowed" }`, "an exhausted budget"],
    ]) await fallsBack(src, why);
});

// --- FAILURE: a refused query leaves nothing behind --------------------------------------------------------------------

test("FAILURE: a survey that curates its answer and then runs a refused query has changed nothing", async () => {
    for (const src of [
        `ml.answer.add("found it"); return ml.jsonPath(["a"], '$[?match(@, "(a+)+b")]')`,
        // A query that SUCCEEDS, then a statement out of dialect: the add before both is still rolled back.
        `ml.answer.add(ml.jsonPath({ a: 1 }, "$.a")[0]); document.body.remove(); return 1`,
    ]) {
        const set = new AnswerSet();
        await assert.rejects(evalReadonly(src, doc(), ML, makeAnswerFacade(set), { checkpoint: () => set.checkpoint() }), outOfDialect, src);
        assert.equal(set.dump().length, 0, `the add before the refusal was rolled back: ${src}`);
    }
});
