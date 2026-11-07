// redteam-host-callbacks.test.mjs — what a page FUNCTION must not get from a read-only survey: the host CALLING it.
//
// The dialect admits host methods that take a callback, and the page can hand one back as data (`ml.models()` is a
// read, and a function is an object). Nothing in the whitelist stops the host from calling that function: measured on
// main, `[1,2].map(o)` runs the page's function per element and `[2,1].sort(o)` runs it as a comparator, inside the
// worker's mediated interpreter, whose whole promise is that page code does not run (src/readonly-exec/evaluator.ts;
// docs/dev/readonly-exec.md).
//
// Every position below is measured RUNNING the page's function on main and lands `{ todo }` while the hole is open:
// each asserts the function never ran, that the survey is refused, and that the refusal names the method (the ruled
// shape — a caller reading the refusal must know which call was the problem). Twenty rows over NINETEEN admitted
// names, because `collection` admits one name on two host receivers (`querySelectorAll` and `getElementsByTagName`);
// nothing else in `BY_KIND` hands an argument to the host to be called. The three shapes already refused name no
// method: they assert the defence that exists. One control row shows a function written IN the script still works in
// every one of those positions, so a fix that refused every callback fails here rather than passing.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";

const doc = () => new JSDOM("<!doctype html><body><p>hi</p><p>there</p></body>").window.document;

/** Run `js` against an `ml` whose one member hands back `value`; returns what the cell produced. */
const run = (js, value) => evalReadonly(js, doc(), { models: async () => value }, undefined, {});

/** A page's own function: it records that it ran, whatever it was called with, and returns a number. */
function pageFunction(ran) {
    return function (...args) { ran.push(args.length); return 1; };
}

/** A survey naming a page function, and the string its refusal must carry (the method that would have called it). */
const CALLBACKS = [
    ["map", "const f = await ml.models(); return [1, 2].map(f)"],
    ["filter", "const f = await ml.models(); return [1, 2].filter(f)"],
    ["forEach", "const f = await ml.models(); return [1, 2].forEach(f)"],
    ["reduce", "const f = await ml.models(); return [1, 2].reduce(f)"],
    ["reduceRight", "const f = await ml.models(); return [1, 2].reduceRight(f)"],
    ["find", "const f = await ml.models(); return [1, 2].find(f)"],
    ["findIndex", "const f = await ml.models(); return [1, 2].findIndex(f)"],
    ["findLast", "const f = await ml.models(); return [1, 2].findLast(f)"],
    ["findLastIndex", "const f = await ml.models(); return [1, 2].findLastIndex(f)"],
    ["some", "const f = await ml.models(); return [1, 2].some(f)"],
    ["every", "const f = await ml.models(); return [1, 2].every(f)"],
    ["flatMap", "const f = await ml.models(); return [1, 2].flatMap(f)"],
    ["sort", "const f = await ml.models(); return [2, 1].sort(f)"],
    ["Array.from", "const f = await ml.models(); return Array.from([1, 2], f)", "from"],
    ["Set.forEach", "const f = await ml.models(); const s = new Set([1, 2]); return s.forEach(f)", "forEach"],
    ["Map.forEach", "const f = await ml.models(); const m = new Map([[\"a\", 1]]); return m.forEach(f)", "forEach"],
    ["collection.forEach (querySelectorAll)", `const f = await ml.models(); return document.querySelectorAll("p").forEach(f)`, "forEach"],
    ["collection.forEach (getElementsByTagName)", `const f = await ml.models(); return document.getElementsByTagName("p").forEach(f)`, "forEach"],
    ["JSON.stringify", "const f = await ml.models(); return JSON.stringify([1, 2], f)", "stringify"],
    ["JSON.parse", "const f = await ml.models(); return JSON.parse('{\"a\":1}', f)", "parse"],
];

/** The same positions, handed a function the page wrote: already refused today, and the refusal names no method. */
const REFUSED_ALREADY = [
    ["replace", `const f = await ml.models(); return "ab".replace("a", f)`],
    ["replaceAll", `const f = await ml.models(); return "aba".replaceAll("a", f)`],
    ["then", "const f = await ml.models(); return [1].then(f)"],
];

// --- the hole: the host calls the page's function ---

for (const [why, js, named] of CALLBACKS) {
    // Measured on main (7e937260): every one of these calls the page's function — map [3,3], sort [2], reduce [4],
    // forEach [3,3], Array.from [2,2], JSON.stringify [2] — and answers with its result.
    test(`RED TEAM: ${why} does not run a page function handed as its callback`, { todo: `open: ${why} calls the page's function; the whitelist admits the method and nothing checks the argument` }, async () => {
        const ran = [];
        const r = await run(js, pageFunction(ran)).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${why} ran the page's function: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${why}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
        assert.match(r.refused, new RegExp(named ?? why, "i"), `${why}: the refusal does not name the method: ${r.refused}`);
    });
}

// --- what already holds: a callback that is not the script's own is refused ---

for (const [why, js] of REFUSED_ALREADY) {
    test(`RED TEAM: ${why} with a page function is refused and the function never runs`, async () => {
        const ran = [];
        const r = await run(js, pageFunction(ran)).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${why} ran the page's function: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${why}: the survey answered instead: ${JSON.stringify(r.value)}`);
    });
}

// --- the control: a function written in the script still works everywhere above ---

test("CONTROL: a function written in the survey still works in every position the rows cover", async () => {
    const v = async (js) => (await run(js)).value;
    assert.deepEqual(await v(`return [1, 2].map((x) => x * 2)`), [2, 4], "map");
    assert.deepEqual(await v(`return [1, 2, 3].filter((x) => x > 1)`), [2, 3], "filter");
    assert.deepEqual(await v(`const a = []; [1, 2].forEach((x) => a.push(x * 2)); return a`), [2, 4], "forEach");
    assert.equal(await v(`return [1, 2, 3].reduce((a, b) => a + b, 0)`), 6, "reduce");
    assert.equal(await v(`return [1, 2, 3].reduceRight((a, b) => a - b)`), 0, "reduceRight");
    assert.equal(await v(`return [1, 2].find((x) => x > 1)`), 2, "find");
    assert.equal(await v(`return [1, 2].findIndex((x) => x > 1)`), 1, "findIndex");
    assert.equal(await v(`return [1, 2].findLast((x) => x < 2)`), 1, "findLast");
    assert.equal(await v(`return [1, 2].findLastIndex((x) => x < 2)`), 0, "findLastIndex");
    assert.equal(await v(`return [1, 2].some((x) => x > 1)`), true, "some");
    assert.equal(await v(`return [1, 2].every((x) => x > 0)`), true, "every");
    assert.deepEqual(await v(`return [1, 2].flatMap((x) => [x, x])`), [1, 1, 2, 2], "flatMap");
    assert.deepEqual(await v(`return [2, 1].sort((a, b) => a - b)`), [1, 2], "sort");
    assert.deepEqual(await v(`return Array.from([1, 2], (x) => x + 1)`), [2, 3], "Array.from");
    assert.deepEqual(await v(`const a = []; const s = new Set([1, 2]); s.forEach((x) => a.push(x)); return a`), [1, 2], "Set.forEach");
    assert.deepEqual(await v(`const a = []; const m = new Map([["a", 1]]); m.forEach((v, k) => a.push(k + v)); return a`), ["a1"], "Map.forEach");
    assert.deepEqual(await v(`const a = []; document.querySelectorAll("p").forEach((p) => a.push(p.textContent)); return a`), ["hi", "there"], "collection.forEach (querySelectorAll)");
    assert.deepEqual(await v(`const a = []; document.getElementsByTagName("p").forEach((p) => a.push(p.textContent)); return a`), ["hi", "there"], "collection.forEach (getElementsByTagName)");
    assert.equal(await v(`return JSON.stringify([1, 2], (k, x) => (typeof x === "number" ? x + 1 : x))`), "[2,3]", "JSON.stringify");
    assert.deepEqual(await v(`return JSON.parse('{"a":1}', (k, x) => (typeof x === "number" ? x + 1 : x))`), { a: 2 }, "JSON.parse");
    assert.equal(await v(`return "ab".replace("a", () => "z")`), "zb", "replace");
    assert.equal(await v(`return "aba".replaceAll("a", () => "z")`), "zbz", "replaceAll");
});
