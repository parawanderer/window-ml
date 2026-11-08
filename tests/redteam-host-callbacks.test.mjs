// redteam-host-callbacks.test.mjs — what a page FUNCTION must not get from a read-only survey: the host CALLING it.
//
// The dialect admits host methods that take a callback, and the page can hand one back as data (`ml.models()` is a
// read, and a function is an object). Nothing in the whitelist stops the host from calling that function: measured on
// main, `[1,2].map(o)` runs the page's function per element and `[2,1].sort(o)` runs it as a comparator, inside the
// worker's mediated interpreter, whose whole promise is that page code does not run (src/readonly-exec/evaluator.ts;
// docs/dev/readonly-exec.md).
//
// Every position below was measured RUNNING the page's function before the fix, and each asserts the function never
// ran, that the survey is refused, and that the refusal names the method (the ruled shape — a caller reading the
// refusal must know which call was the problem). Twenty rows over NINETEEN admitted names, because `collection`
// admits one name on two host receivers (`querySelectorAll` and `getElementsByTagName`); nothing else in `BY_KIND`
// hands an argument to the host to be called. Five more rows cover the ACQUISITION channels: the function need not
// arrive from `ml.models()` itself, because an admitted method's return and a `for…of` binding over the page's array
// or its `Object.values` hand it back unwrapped (an index read and a spread are inert). The three shapes already
// refused name no method: they assert the defence that exists. One control row shows a function written IN the script
// still works in every one of those positions, so a fix that refused every callback fails here rather than passing.
//
// The fix's OWN admissions get the same treatment, because each admits a VALUE the script can supply: a bare
// `getComputedStyle` is judged against `scope.getComputedStyle`, and `scope` is the script's frame, so binding that
// name to a page function buys the admission (a name is not a value — the one row still `{ todo }`); a coercing
// intrinsic (`Number`, `String`, `parseInt`, ...) as a callback runs an element's `valueOf`/`toString` unless the
// elements are data; and a member reference stays the inert sentinel that throws, never the method.
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
    // Measured before the fix (main 7e937260): every one of these calls the page's function — map [3,3], sort [2],
    // reduce [4], forEach [3,3], Array.from [2,2], JSON.stringify [2] — and answers with its result.
    test(`RED TEAM: ${why} does not run a page function handed as its callback`, async () => {
        const ran = [];
        const r = await run(js, pageFunction(ran)).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${why} ran the page's function: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${why}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
        assert.match(r.refused, new RegExp(named ?? why, "i"), `${why}: the refusal does not name the method: ${r.refused}`);
    });
}

// --- the acquisition channels: the function need not come from `ml.models()` itself ---

/** A page object carrying its own functions: an array of them, and two bare members (for `Object.values`). */
function pageFunctions(ran) {
    const f = () => { ran.push("f"); return 1; };
    const g = () => { ran.push("g"); return 1; };
    return { arr: [f, g], f1: f, f2: g };
}

/** A page object whose members are ONLY the functions: `Object.values` walks them, so an array first would be refused
 *  for being uncallable and the row would never reach the channel it is about. */
function pageFunctionMembers(ran) {
    return { f1: () => { ran.push("f1"); return 1; }, f2: () => { ran.push("f2"); return 1; } };
}

// Measured before the fix with no stub at all: an admitted method's RETURN is not wrapped (`arr.at(i)`, `arr.find(...)`,
// `arr.slice(n).at(m)` all hand the page's function straight back), and neither is a `for…of` binding over the page's
// array or over `Object.values(pageObj)`. An INDEX read and a spread DO give the inert sentinel, which is why the rows
// above — whose function comes from `ml.models()` — cannot see either channel.
const ACQUIRED = [
    ["an admitted method's return (at)", `const o = await ml.models(); return [1].map(o.arr.at(1))`],
    ["an admitted method's return (find)", `const o = await ml.models(); return [1].map(o.arr.find(() => true))`],
    ["an admitted method's return (slice(n).at(m))", `const o = await ml.models(); return [1].map(o.arr.slice(1).at(0))`],
    ["a for…of binding over the page's array", `const o = await ml.models(); const out = []; for (const f of o.arr) out.push(...[9].map(f)); return out`],
    ["a for…of binding over Object.values", `const o = await ml.models(); const out = []; for (const f of Object.values(o)) out.push(...[9].map(f)); return out`, pageFunctionMembers],
];

for (const [why, js, make] of ACQUIRED) {
    test(`RED TEAM: a page function acquired through ${why} is not called by a host method`, async () => {
        const ran = [];
        const r = await run(js, (make ?? pageFunctions)(ran)).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${why}: the page's function ran: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${why}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
        assert.match(r.refused, /map/i, `${why}: the refusal does not name the method that would have called it: ${r.refused}`);
    });
}

test("CONTROL: a function the script wrote, acquired the same ways, still works", async () => {
    const v = async (js) => (await run(js)).value;
    assert.deepEqual(await v(`const arr = [(x) => x * 2]; return [1].map(arr.at(0))`), [2], "at");
    assert.deepEqual(await v(`const arr = [(x) => x * 2]; return [1].map(arr.find(() => true))`), [2], "find");
    assert.deepEqual(await v(`const arr = [1, (x) => x * 2]; return [1].map(arr.slice(1).at(0))`), [2], "slice(n).at(m)");
    assert.deepEqual(await v(`const arr = [(x) => x + 1]; const out = []; for (const f of arr) out.push(...[9].map(f)); return out`), [10], "for…of array");
    assert.deepEqual(await v(`const o = { a: (x) => x + 1 }; const out = []; for (const f of Object.values(o)) out.push(...[9].map(f)); return out`), [10], "for…of Object.values");
});

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

// --- the fix's own admissions: a NAME is not a VALUE ---

/** A page object that records any coercion: `valueOf`/`toString` are what a coercing intrinsic would run on it. */
function pageCoercer(ran) {
    return { valueOf() { ran.push("valueOf"); return 1; }, toString() { ran.push("toString"); return "1"; } };
}

test("RED TEAM: a page function bound to the name `getComputedStyle` is not admitted as a callback", { todo: "open: the admission compares the argument with `scope.getComputedStyle`, and `scope` is the script's own frame, so `const getComputedStyle = <page fn>` buys it (evaluator.ts:334)" }, async () => {
    // The fix admits a bare `getComputedStyle` as a callback by identity against the SCOPE. The scope is the script's
    // frame over the host's root, and shadowing a root name is a script's ordinary move (`const document = …` writes to
    // the child), so the comparison reads whatever the script bound there: the name buys the admission, not the value.
    const POSITIONS = [
        ["map", "[1].map(getComputedStyle)"],
        ["filter", "[1].filter(getComputedStyle)"],
        ["forEach", "[1].forEach(getComputedStyle)"],
        ["sort", "[2, 1].sort(getComputedStyle)"],
        ["Array.from", "Array.from([1], getComputedStyle)"],
    ];
    for (const decl of ["const", "let", "var"]) {
        for (const [why, call] of POSITIONS) {
            const ran = [];
            const r = await run(`const o = await ml.models(); ${decl} getComputedStyle = o; return ${call}`, pageFunction(ran)).catch((e) => ({ refused: String(e) }));
            assert.deepEqual(ran, [], `${decl} ${why}: the page's function ran: ${JSON.stringify(ran)}`);
            assert.ok(r.refused, `${decl} ${why}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
        }
    }
    // The bypass is the NAME and not the value: the same function under a name of the script's choosing is refused
    // today, so a row that went red here is measuring the admission and not the general hole.
    const plain = [];
    const r = await run(`const o = await ml.models(); const f = o; return [1].map(f)`, pageFunction(plain)).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(plain, [], "the plain hole is back, so this row is not about the name");
    assert.ok(r.refused, "another name was answered, so the admission is what let the page's function through");
});

test("CONTROL: the root's own getComputedStyle is still a callback, so a fix that refuses the bare name fails here", async () => {
    const out = (await run(`const el = document.querySelector("p"); return [el].map(getComputedStyle).map((s) => s.display)`)).value;
    assert.deepEqual(out, ["block"], "the root's getComputedStyle stopped working as a callback");
});

test("RED TEAM: a coercing intrinsic as a callback never runs a page object's valueOf/toString", async () => {
    // `Number`, `String`, `parseInt`, `parseFloat`, `isNaN` and `isFinite` COERCE what the host hands them, so an
    // element that is a page object runs its own `valueOf`/`toString` — page code, mid-survey. They are admitted over
    // an array of DATA only; the refusal names the intrinsic, as every other refusal names the method.
    for (const cb of ["Number", "String", "parseInt", "parseFloat", "isNaN", "isFinite"]) {
        for (const [why, js, make] of [
            ["map", `const o = await ml.models(); return [o].map(${cb})`, pageCoercer],
            ["filter", `const o = await ml.models(); return [o].filter(${cb})`, pageCoercer],
            ["Array.from", `const o = await ml.models(); return Array.from([o], ${cb})`, pageCoercer],
            // The page's OWN array, reached through an admitted method's return: the elements are page objects whichever
            // array they sit in.
            ["the page's array", `const o = await ml.models(); return o.arr.map(${cb})`, (ran) => ({ arr: [pageCoercer(ran)] })],
        ]) {
            const ran = [];
            const r = await run(js, make(ran)).catch((e) => ({ refused: String(e) }));
            assert.deepEqual(ran, [], `${cb} via ${why}: the page's coercion ran: ${JSON.stringify(ran)}`);
            assert.ok(r.refused, `${cb} via ${why}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
            assert.match(r.refused, new RegExp(cb, "i"), `${cb} via ${why}: the refusal does not name the intrinsic: ${r.refused}`);
        }
    }
    // The two non-coercing intrinsics stay usable over page data, and a coercing one over data the script wrote does
    // too: a fix that refused every intrinsic would pass the loop above and fails here.
    const v = async (js, value) => (await run(js, value)).value;
    assert.deepEqual(await v(`const o = await ml.models(); return [o].map(Boolean)`, pageCoercer([])), [true], "Boolean over a page object");
    assert.deepEqual(await v(`return [1, 2].map(Number)`), [1, 2], "Number over script numbers");
    assert.deepEqual(await v(`return [1, 2].map(String)`), ["1", "2"], "String over script numbers");
});

test("RED TEAM: a member reference as a callback is the inert sentinel, never the method and never the page's member", async () => {
    // `Math.abs` is METHOD_REF: the host calling it reaches the sentinel's own refusal, so the survey neither computes
    // nor answers, and a page object's member (`o.someFn`) is the same sentinel — the function behind it never runs.
    const math = await run(`return [-1].map(Math.abs)`).catch((e) => ({ refused: String(e) }));
    assert.ok(math.refused, `the sentinel answered as the method: ${JSON.stringify(math.value)}`);
    assert.match(String(math.refused), /method reference cannot be called indirectly/, math.refused);
    for (const [why, js] of [
        ["map", "const o = await ml.models(); return [1].map(o.someFn)"],
        ["filter", "const o = await ml.models(); return [1].filter(o.someFn)"],
        ["forEach", "const o = await ml.models(); return [1].forEach(o.someFn)"],
        ["sort", "const o = await ml.models(); return [1, 2].sort(o.someFn)"],
        ["Array.from", "const o = await ml.models(); return Array.from([1], o.someFn)"],
    ]) {
        const ran = [];
        const r = await run(js, { someFn: pageFunction(ran) }).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${why}: a page object's member ran: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${why}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
    }
    // The arrow that names the method still works: the sentinel is refused, the method is not.
    assert.deepEqual((await run(`return [-1].map((x) => Math.abs(x))`)).value, [1], "an arrow over Math.abs");
});
