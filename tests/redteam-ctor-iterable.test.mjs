// redteam-ctor-iterable.test.mjs — the constructor position, probed where it is dangerous: `new Set(o)` makes the HOST
// walk the page's iterator, so a page object whose own `Symbol.iterator`/`next` is page code runs that code inside the
// worker for a read the dialect documents as DATA (docs/dev/readonly-exec.md). The constructor set is
// `CTOR_ITERABLES` (src/readonly-exec/policy.ts: Set, Map, WeakSet, WeakMap), and the ruled test is "a string, an array,
// a Set or a Map WITHOUT an own iterator", judged in `iterates`.
//
// This file is the finder's probe on #1536 (the red-team pass, session window-ml-redteam-e3), added after the owner's
// coercion commit so the fix's constructor judgement is measured rather than assumed. Two boundaries the rows insist on,
// because over-refusing here breaks ordinary reads: a plain page ARRAY of primitives is data and still constructs, and a
// string, a Set and a Map of the page's do too.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";

const doc = () => new JSDOM("<!doctype html><body><p>hi</p></body>").window.document;

/** Run `js` against an `ml` whose one member hands back `value`; answer what the cell produced or the refusal's text. */
async function run(js, value) {
    try {
        const r = await evalReadonly(js, doc(), { models: async () => value }, undefined, {});
        return { value: r?.value };
    } catch (e) {
        return { refused: String(e) };
    }
}

/** A page object whose iterator is page code: every step records that it ran. */
function pageIterable(ran, items = [[1, 2], [3, 4]]) {
    return {
        [Symbol.iterator]() {
            ran.push("Symbol.iterator");
            let i = 0;
            return { next() { ran.push("next"); return i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }; } };
        },
    };
}

/** A page ARRAY carrying its own iterator: still an array, but walking it runs the page's function. */
function ownedArray(ran) {
    const a = [1, 2];
    a[Symbol.iterator] = function () {
        ran.push("own Symbol.iterator");
        return { next() { ran.push("own next"); return { value: undefined, done: true }; } };
    };
    return a;
}

/** A page's real Set with its own iterator: the brand is Set's, but its iteration is the page's. */
function ownedSet(ran) {
    const s = new Set([1, 2]);
    s[Symbol.iterator] = function () { ran.push("own Symbol.iterator"); return { next() { ran.push("own next"); return { value: undefined, done: true }; } }; };
    return s;
}

/** A page object that is ITSELF an iterator (a `next` and nothing else). */
function pageIterator(ran) {
    let i = 0;
    return { next() { ran.push("next"); return i < 1 ? { value: [1, 2], done: false } : { value: undefined, done: true }; } };
}

// One row per constructor that walks an iterable, plus the three shapes a page can hand it. `ctor` is what the refusal
// must name; `js` is what the survey would run. A row demands the refusal's text as well as the empty `ran`, so a call
// refused for an unrelated reason does not pass it.
const CASES = [
    ["Set", "Set", (o) => `new Set(${o}); return 1`, () => pageIterable([])],
    ["Map", "Map", (o) => `new Map(${o}); return 1`, () => pageIterable([])],
    ["WeakSet", "WeakSet", (o) => `new WeakSet(${o}); return 1`, () => pageIterable([])],
    ["WeakMap", "WeakMap", (o) => `new WeakMap(${o}); return 1`, () => pageIterable([])],
    ["Set over a page array with its own iterator", "Set", (o) => `new Set(${o}); return 1`, (ran) => ownedArray(ran)],
    ["Map over a page array with its own iterator", "Map", (o) => `new Map(${o}); return 1`, (ran) => ownedArray(ran)],
    ["Set over a page Set with its own iterator", "Set", (o) => `new Set(${o}); return 1`, (ran) => ownedSet(ran)],
    ["Set over a page ITERATOR object", "Set", (o) => `new Set(${o}); return 1`, (ran) => pageIterator(ran)],
];

for (const [name, ctor, js, make] of CASES) {
    test(`RED TEAM: \`${name}\` does not run the page's iterator`, async () => {
        const ran = [];
        const r = await run(`const o = await ml.models(); ${js("o")}`, make(ran));
        assert.deepEqual(ran, [], `${name} ran the page's iterator: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${name} was admitted instead of refused: ${JSON.stringify(r.value)}`);
        assert.match(r.refused, new RegExp(`new ${ctor}`, "i"), `${name}: the refusal does not name the constructor: ${r.refused}`);
        assert.match(r.refused, /iterat/i, `${name}: the refusal does not say the iterable is what it refused: ${r.refused}`);
    });
}

// The boundary: the data forms still construct, so a fix cannot pass these rows by refusing every iterable.
const CONTROL = [
    ["a plain array of numbers", "new Set(o).size", () => [1, 2, 2], 2],
    ["a plain array of pairs into a Map", "new Map(o).get(1)", () => [[1, "a"]], "a"],
    ["a string", "new Set(o).size", () => "ab", 2],
    ["a Set", "new Set(o).size", () => new Set([3]), 1],
    ["a Map into a Set of its entries", "new Set(o).size", () => new Map([[1, 2]]), 1],
];

for (const [name, js, make, expected] of CONTROL) {
    test(`CONTROL: \`new Set/Map\` over ${name} (data, no page iterator) still constructs`, async () => {
        const r = await run(`const o = await ml.models(); return ${js}`, make());
        assert.ok(!r.refused, `${name} was refused: ${r.refused}`);
        assert.deepEqual(r.value, expected, `${name} answered something else`);
    });
}
