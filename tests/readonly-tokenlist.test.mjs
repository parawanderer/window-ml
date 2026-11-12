// readonly-tokenlist.test.mjs — a DOMTokenList (`classList`, `relList`, `sandbox`, …) in the read-only dialect: its
// read-only half answers, every route to a mutator stays out, and the kind is a brand a page cannot claim. (jsdom has
// no `sandbox` on an iframe; `<output>`'s `htmlFor` stands in for the third interface member.)
//
// Bench evidence: seven runs of the disabled-controls task (deepseek-flash, gemini-flash) wrote
// `all.filter(e => e.matches(':disabled') || e.classList.contains('disabled'))` and got "contains is not a function on
// this array", because a token list matched the DOM-collection SHAPE (a numeric `length` and an `item` function) and was
// copied into an Array of strings on the member read. Extending the dialect, so per AGENTS.md: what it reads, what it
// refuses (each mutator by every route the evaluator has), a forged receiver, halting, and failure.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Worker } from "node:worker_threads";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { kindOf, methodAllowed, offeredMethods, tokenListBrand, METHODS_BY_KIND } from "../src/readonly-exec/policy.ts";
import { watchdogMs, assertNotHung } from "./fixtures/hang-watchdog.mjs";

const HTML = `<!doctype html><body class="page">
  <button id="b1" disabled>One</button>
  <button id="b2" class="btn disabled">Two</button>
  <button id="b3" class="btn primary">Three</button>
  <a id="a1" href="/x" rel="noopener external" class="link">Link</a>
  <output id="o" for="x y"></output>
</body>`;
const world = () => new JSDOM(HTML).window.document;
/** An `ml` stand-in: `queryAll` as the real one answers it (an array of elements), and `models` handing back `value`. */
const mlFor = (doc, value) => ({ queryAll: (s) => Array.from(doc.querySelectorAll(s)), models: async () => value });
const run = (js, doc = world(), value) => evalReadonly(js, doc, mlFor(doc, value));
const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;

// --- the bench's survey, and the read-only half of a real DOMTokenList ---

test("the bench survey runs: filter by :disabled or classList.contains('disabled')", async () => {
    // The deepseek-flash run's script, verbatim but for the fields this document lacks.
    const js = `const all = ml.queryAll('*');
const dis = all.filter(e => e.matches(':disabled') || e.getAttribute('aria-disabled') === 'true' || e.classList.contains('disabled'));
return { total: all.length, dis: dis.map(e => e.tagName + '.' + e.className) }`;
    const { value } = await run(js);
    assert.deepEqual(value.dis, ["BUTTON.", "BUTTON.btn disabled"]);
    // And the same over document.querySelectorAll, whose result is an Array in the dialect.
    assert.deepEqual((await run(`[...document.querySelectorAll('button')].filter(e => e.matches(':disabled') || e.classList.contains('disabled')).map(e => e.id)`)).value, ["b1", "b2"]);
});

test("every read of the read-only half answers as on a real DOMTokenList", async () => {
    const el = `document.getElementById('b3').classList`;
    for (const [js, want] of [
        [`${el}.contains('btn')`, true],
        [`${el}.contains('nope')`, false],
        [`${el}.item(1)`, "primary"],
        [`${el}.item(9)`, null],
        [`${el}.length`, 2],
        [`${el}[0]`, "btn"],
        [`${el}.value`, "btn primary"],
        [`${el}.toString()`, "btn primary"],
        [`[...${el}.keys()]`, [0, 1]],
        [`[...${el}.values()]`, ["btn", "primary"]],
        [`[...${el}.entries()]`, [[0, "btn"], [1, "primary"]]],
        [`${el}.keys()`, [0, 1]],   // an iterator a host call returns is materialised, as for a Set's
        [`const a = []; ${el}.forEach((t, i) => a.push(i + ':' + t)); return a`, ["0:btn", "1:primary"]],
        [`const a = []; for (const t of ${el}) a.push(t); return a`, ["btn", "primary"]],
        [`[...${el}]`, ["btn", "primary"]],
        [`Array.from(${el})`, ["btn", "primary"]],
        [`Array.from(${el}, (t) => t.toUpperCase())`, ["BTN", "PRIMARY"]],
        [`const [a, b] = ${el}; return b`, "primary"],
        [`const { classList } = document.getElementById('b3'); return classList.contains('primary')`, true],
        [`document.getElementById('b3').classList?.contains('btn')`, true],
        [`${el}.contains && ${el}.contains('btn')`, true],
        // The other token lists are the same interface.
        [`document.getElementById('a1').relList.contains('external')`, true],
        [`document.getElementById('o').htmlFor.contains('y')`, true],
    ]) assert.deepEqual((await run(js)).value, want, js);
});

test("a token list RETURNED or printed reads as its tokens, as it did when it was copied into an array", async () => {
    assert.deepEqual((await run(`document.getElementById('b3').classList`)).value, ["btn", "primary"]);
    assert.deepEqual((await run(`[...document.querySelectorAll('button')].map(e => ({ id: e.id, cls: e.classList }))`)).value,
        [{ id: "b1", cls: [] }, { id: "b2", cls: ["btn", "disabled"] }, { id: "b3", cls: ["btn", "primary"] }]);
    const { logs } = await run(`console.log(document.getElementById('b3').classList); 1`);
    assert.deepEqual(logs, [`["btn","primary"]`]);
});

test("real DOM collections still read as Arrays: children, rows, querySelectorAll, getElementsBy*", async () => {
    for (const [js, want] of [
        [`document.body.children.map(c => c.id)`, ["b1", "b2", "b3", "a1", "o"]],
        [`Array.isArray(document.body.children)`, true],
        [`document.querySelectorAll('button').map(e => e.id)`, ["b1", "b2", "b3"]],
        [`document.getElementsByClassName('btn').map(e => e.id)`, ["b2", "b3"]],
        [`document.getElementsByTagName('a').length`, 1],
    ]) assert.deepEqual((await run(js)).value, want, js);
    const t = new JSDOM(`<table><tr><td>a</td></tr><tr><td>b</td></tr></table>`).window.document;
    assert.deepEqual((await run(`document.querySelector('table').rows.map(r => r.cells.map(c => c.textContent))`, t)).value, [["a"], ["b"]]);
});

// --- the kind: decided by a brand, which a page cannot claim ---

test("kindOf: a real token list is `tokenlist`; a NodeList stays `collection`", () => {
    const d = world();
    const is = tokenListBrand(d.defaultView);
    assert.equal(kindOf(d.body.classList, is), "tokenlist");
    assert.equal(kindOf(d.getElementById("a1").relList, is), "tokenlist");
    assert.equal(kindOf(d.querySelectorAll("button"), is), "collection");
    assert.equal(kindOf(d.body.children, is), "collection");
    assert.ok(methodAllowed(d.body.classList, "contains", is));
    assert.ok(!methodAllowed(d.body.classList, "add", is));
    // A token list from ANOTHER document's realm (an iframe's, or here another JSDOM) has the same brand.
    assert.equal(kindOf(new JSDOM(`<p class="a">`).window.document.querySelector("p").classList, is), "tokenlist");
});

test("the tokenlist allowlist is exactly the read-only half, and no mutator is offered", () => {
    assert.deepEqual([...METHODS_BY_KIND.tokenlist].sort(), ["contains", "entries", "forEach", "item", "keys", "values"]);
    for (const m of ["add", "remove", "toggle", "replace"]) {
        assert.ok(!METHODS_BY_KIND.tokenlist.includes(m), m);
        assert.ok(!offeredMethods("tokenlist").includes(m), m);
    }
});

/** A page object shaped like a token list, whose members record that they ran. */
function lookalike(ran, extra = {}) {
    const o = { 0: "disabled", length: 1, value: "disabled" };
    for (const k of ["item", "contains", "add", "remove", "toggle", "replace", "forEach", "keys", "values", "entries", "supports"])
        o[k] = (...a) => { ran.push(k); return k === "contains" ? true : null; };
    return Object.defineProperties(o, Object.getOwnPropertyDescriptors(extra));   // a getter in `extra` is copied, never run
}

test("a forged look-alike (length, item, contains) never gains the kind, by shape, tag or prototype", () => {
    const d = world();
    const is = tokenListBrand(d.defaultView);
    const ran = [];
    const plain = lookalike(ran);
    const tagged = lookalike(ran, { get [Symbol.toStringTag]() { ran.push("tag"); return "DOMTokenList"; } });
    const protod = Object.setPrototypeOf(lookalike(ran), d.defaultView.DOMTokenList.prototype);
    for (const [why, o] of [["shape", plain], ["toStringTag", tagged], ["prototype", protod]]) {
        assert.notEqual(kindOf(o, is), "tokenlist", why);
        assert.ok(!methodAllowed(o, "contains", is) || kindOf(o, is) === "element", why);
    }
    assert.deepEqual(ran, [], "deciding the kind ran nothing of the page's");
});

test("a forged look-alike reached through the dialect never has its contains (or anything else) called", async () => {
    for (const make of [
        (ran) => lookalike(ran),
        (ran) => lookalike(ran, { get [Symbol.toStringTag]() { ran.push("tag"); return "DOMTokenList"; } }),
    ]) {
        // Read as a PROPERTY of a page object (the shape is still copied into an Array, as any collection is), and handed
        // back by an `ml` member uncopied, where it is judged by `kindOf` alone. Not rowed: `o.item(0)` and
        // `o.forEach(f)` on that uncopied object, which the STRUCTURAL `collection` kind admits and so call the page's
        // own `item`/`forEach`. That predates this kind and is unchanged by it; no `ml` member returns a page object.
        for (const js of [
            `document.body.fake.contains('disabled')`,
            `document.body.fake.add('evil')`,
            `const o = await ml.models(); return o.contains('disabled')`,
            `const o = await ml.models(); return o.add('evil')`,
            `const o = await ml.models(); return o.toggle('evil')`,
        ]) {
            const ran = [];
            const d = world();
            d.body.fake = make(ran);
            const r = await run(js, d, make(ran)).catch((e) => ({ threw: e }));
            assert.deepEqual(ran, [], `${js}: the page's member ran: ${JSON.stringify(ran)}`);
            assert.ok(r.threw, `${js}: answered ${JSON.stringify(r.value)}`);
        }
    }
});

// --- ADVERSARIAL: every mutator, by every route the evaluator has ---
//
// Before the kind existed the list was an Array of strings, so the method rows failed as a missing-method TypeError (the
// page unchanged either way); they now fail as withheld. The write, reflection and extraction rows held already: a
// write needs an owned plain target, `Reflect`/`DOMTokenList`/`window` are not in scope, `constructor`/`__proto__` are
// denied, `Object.getPrototypeOf` is not an admitted static, and a method read as a value is the inert METHOD_REF.
// Not rowed: a Proxy around a real token list. Blink's brand check reads the Proxy's own internals and refuses it
// without a trap; jsdom's consults the target through the Proxy, so it cannot be measured here, and on the page realm
// a Proxy's traps are the page's code by design (docs/dev/readonly-exec.md, threat question 5).

const MUTATIONS = [
    // direct calls
    ["add", `cl.add('evil')`],
    ["remove", `cl.remove('btn')`],
    ["toggle", `cl.toggle('btn')`],
    ["toggle with force", `cl.toggle('evil', true)`],
    ["replace", `cl.replace('btn', 'evil')`],
    // computed keys
    ["computed add", `cl['add']('evil')`],
    ["computed add from a string built at run time", `const k = 'ad' + 'd'; cl[k]('evil')`],
    ["optional call", `cl.add?.('evil')`],
    // routes around the call gate
    ["add.call", `cl.add.call(cl, 'evil')`],
    ["add.apply", `cl.add.apply(cl, ['evil'])`],
    ["add.bind", `cl.add.bind(cl)('evil')`],
    ["extracted to a variable", `const f = cl.add; f('evil')`],
    ["extracted by destructuring", `const { add } = cl; add('evil')`],
    ["extracted via forEach's third argument", `cl.forEach((t, i, list) => list.add('evil'))`],
    ["handed as forEach's callback", `cl.forEach(cl.add)`],
    ["handed to Array.from as the mapper", `Array.from(['evil'], cl.add)`],
    ["handed to map", `['evil'].map(cl.add)`],
    ["called from a callback", `[1].forEach(() => cl.add('evil'))`],
    ["inside try (a refusal is not catchable)", `try { cl.add('evil') } catch (e) { 0 }`],
    // writes
    ["value assignment", `cl.value = 'evil'`],
    ["index assignment", `cl[0] = 'evil'`],
    ["length assignment", `cl.length = 0`],
    ["className through the element", `document.getElementById('b3').className = 'evil'`],
    ["Object.assign onto the list", `Object.assign(cl, { value: 'evil' })`],
    ["Object.assign onto the element", `Object.assign(document.getElementById('b3'), { className: 'evil' })`],
    ["compound assignment to value", `cl.value += ' evil'`],
    ["update of length", `cl.length++`],
    // reflection and prototype walks
    ["Reflect", `Reflect.apply(cl.add, cl, ['evil'])`],
    ["constructor", `cl.constructor.prototype.add.call(cl, 'evil')`],
    ["__proto__", `cl.__proto__.add.call(cl, 'evil')`],
    ["computed __proto__", `cl['__pro' + 'to__'].add.call(cl, 'evil')`],
    ["Object.getPrototypeOf", `Object.getPrototypeOf(cl).add.call(cl, 'evil')`],
    ["DOMTokenList global", `DOMTokenList.prototype.add.call(cl, 'evil')`],
    ["window", `window.document.getElementById('b3').classList.add('evil')`],
    // the other token lists
    ["relList.add", `document.getElementById('a1').relList.add('evil')`],
    ["htmlFor.add", `document.getElementById('o').htmlFor.add('evil')`],
];

for (const [why, body] of MUTATIONS) {
    test(`ADVERSARIAL: a token list's mutator via ${why} is refused and the page is unchanged`, async () => {
        const d = world();
        const before = [d.getElementById("b3").className, d.getElementById("a1").rel, d.getElementById("o").getAttribute("for")];
        const js = `const cl = document.getElementById('b3').classList; ${body}; return 1`;
        await assert.rejects(run(js, d), outOfDialect, why);
        assert.deepEqual([d.getElementById("b3").className, d.getElementById("a1").rel, d.getElementById("o").getAttribute("for")], before, `${why} changed the page`);
    });
}

test("ADVERSARIAL: an existing-but-withheld mutator is a REFUSAL naming the kind, not a missing-method TypeError", async () => {
    for (const m of ["add", "remove", "toggle", "replace", "supports"]) {
        const e = await run(`document.body.classList.${m}('x', 'y')`).catch((x) => x);
        assert.ok(e instanceof NotInDialect, `${m}: ${e}`);
        assert.match(e.message, new RegExp(`'${m}' not allowed on tokenlist`), m);
    }
    // A name the list does not have is a runtime TypeError, as for any kind ("A missing method is not a refusal").
    const e = await run(`document.body.classList.nope()`).catch((x) => x);
    assert.ok(e instanceof TypeError && !outOfDialect(e), String(e));
});

test("ADVERSARIAL: a method read as a value is the inert sentinel, which throws when anything calls it", async () => {
    assert.deepEqual((await run(`const cl = document.body.classList; return [typeof cl.add, typeof cl.contains, !!cl.add]`)).value, ["function", "function", true]);
    await assert.rejects(run(`const f = document.body.classList.contains; return f('page')`), outOfDialect);
});

// --- ADVERSARIAL: a page's value in the arguments, and a page's function as the callback ---

/** A page object whose `toString`/`valueOf` record that they ran. */
const pageValue = (ran) => ({ toString() { ran.push("toString"); return "btn"; }, valueOf() { ran.push("valueOf"); return 0; } });

for (const [m, js] of [
    ["contains", `const o = await ml.models(); return document.getElementById('b3').classList.contains(o)`],
    ["item", `const o = await ml.models(); return document.getElementById('b3').classList.item(o)`],
]) {
    test(`ADVERSARIAL: tokenlist.${m} does not convert a page object (its toString would run)`, async () => {
        const ran = [];
        const d = world();
        const e = await run(js, d, pageValue(ran)).catch((x) => x);
        assert.deepEqual(ran, [], `${m} ran the page's conversion`);
        assert.ok(e instanceof NotInDialect, `${m}: ${e}`);
        assert.match(e.message, new RegExp(m));
    });
}

test("ADVERSARIAL: tokenlist.forEach does not call a page function handed as its callback", async () => {
    const ran = [];
    const e = await run(`const f = await ml.models(); document.body.classList.forEach(f); return 1`, world(), () => { ran.push("f"); })
        .catch((x) => x);
    assert.deepEqual(ran, []);
    assert.ok(e instanceof NotInDialect && /forEach/.test(e.message), String(e));
});

// --- FAILURE: a survey that reads a token list and then leaves the dialect leaves nothing behind ---

test("FAILURE: reading, then a refused mutator, then more reads: nothing changed and no answer escaped", async () => {
    const d = world();
    await assert.rejects(run(`const cl = document.body.classList; const had = cl.contains('page'); cl.toggle('page'); return had`, d), outOfDialect);
    assert.equal(d.body.className, "page");
});

// --- HALTING: nothing can grow a token list while something walks it ---
//
// A DOMTokenList's iterator re-reads `length` on every step, so a mutator that slipped through would turn
// `for (const t of cl) cl.add(t + 'x')` into an infinite loop. Each case runs in a WORKER with a timeout, so a
// regression fails here instead of hanging the runner.

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const JSDOM_URL = import.meta.resolve("jsdom");
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");
const BUDGET = 200_000;
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return Promise.all([import(workerData.url), import(workerData.jsdom)]); });
        parentPort.on("message", ({ id, src }) => ready
            .then(([{ evalReadonly }, { JSDOM }]) => {
                const d = new JSDOM('<body class="a b c">').window.document;
                return evalReadonly(src, d, undefined, undefined, { stepBudget: workerData.budget }).then((r) => [r, d]);
            })
            .then(([r, d]) => parentPort.postMessage({ id, value: r.value, className: d.body.className }),
                  (e) => parentPort.postMessage({ id, threw: e.constructor.name, message: e.message })));`,
        { eval: true, workerData: { url: RO_URL, jsdom: JSDOM_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API, budget: BUDGET } });
    worker.on("message", ({ id, ...r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: "WorkerError", message: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());
function inWorker(src) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, watchdogMs(BUDGET));
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src });
    });
}

test("HALTING: a loop over a token list cannot grow it, by for…of, forEach, spread-in-a-loop or Array.from's mapper", async () => {
    for (const src of [
        `const cl = document.body.classList; for (const t of cl) cl.add(t + 'x'); return 1`,
        `const cl = document.body.classList; cl.forEach((t) => cl.add(t + 'x')); return 1`,
        `const cl = document.body.classList; for (const t of cl) cl.toggle(t + 'x', true); return 1`,
        `const cl = document.body.classList; for (const t of cl) document.body.className += ' x'; return 1`,
        `const cl = document.body.classList; Array.from(cl, (t) => cl.add(t + 'x')); return 1`,
        `const cl = document.body.classList; cl.forEach((t, i, list) => list.add(t + 'x')); return 1`,
    ]) {
        const r = await inWorker(src);
        assertNotHung(r, src, BUDGET);
        assert.ok(r.threw === "NotInDialect" || r.threw === "Denied", `${src}: ${JSON.stringify(r)}`);
    }
});

test("HALTING: the read-only half over a token list ends with its value", async () => {
    const r = await inWorker(`const cl = document.body.classList; const out = []; for (const t of cl) cl.forEach((u) => out.push(t + u)); return [out.length, cl.contains('b'), [...cl.entries()].length]`);
    assertNotHung(r, "nested reads", BUDGET);
    assert.deepEqual(r, { value: [9, true, 3], className: "a b c" });
});
