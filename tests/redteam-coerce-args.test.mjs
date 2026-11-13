// redteam-coerce-args.test.mjs — a page's own toString/valueOf, run by any admitted method that COERCES its argument.
//
// The dialect's promise is that a page's value is DATA (docs/dev/readonly-exec.md). A primitive conversion is the one
// way a host call cannot avoid running the page's code: the argument check sees an object and passes it through, then
// the native method converts it with ToString or ToNumber, which calls the page's own `toString`/`valueOf` inside the
// worker's mediated interpreter. `[o].join("")`, `String(o)` and the join separator were #1454's family; this file is
// every OTHER admitted position where one argument is converted, measured on main.
//
// The set is enumerated from `BY_KIND` (src/readonly-exec/policy.ts), not sampled: one row per admitted name that
// converts an argument to a primitive, plus one row per receiver kind whose names all convert by the same route (the
// comment beside it names the rest of them). Positions that do NOT convert are one-line reasons below rather than rows,
// so a fix is not asked to refuse a call that is already data.
//
// Each row landed `{ todo }` while the hole was open; #1536 judges a converted value by provenance and turns them all, so
// the option is gone from this commit on. A row asserts the page's functions never ran, that the survey is refused, and
// that the refusal NAMES the method (the ruled shape). Its control, beside it, runs the same call with a real number or
// string argument and asserts the ordinary answer, so a fix that refused every argument fails here.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";

const doc = () => new JSDOM("<!doctype html><body><p class=\"x\">hi</p><div id=\"d\" name=\"n\">x</div></body>").window.document;

/** A page's own object: `toString` answers "2", `valueOf` answers 2, and each records that it ran. */
function pageValue(ran) {
    return { toString() { ran.push("toString"); return "2"; }, valueOf() { ran.push("valueOf"); return 2; } };
}

/** Run a survey whose `ml.models()` answers the receiver (if any, built from the SAME document) then the page. */
function run(js, ran, make) {
    const d = doc();
    const queue = make === undefined ? [pageValue(ran)] : [make(d), pageValue(ran)];
    return evalReadonly(js, d, { models: async () => queue.shift() }, undefined, {});
}

/** Run a CONTROL: the same call with a real argument; `make` answers `ml.models()` if the control asks. */
function runControl(js, make) {
    const d = doc();
    const queue = make === undefined ? [] : [make(d)];
    return evalReadonly(js, d, { models: async () => queue.shift() }, undefined, {});
}

// One row per converting position: [name, the method the refusal must name, the survey, its control, the control's
// answer, and how to get a receiver when the survey reads one from `ml.models()`].
const O = "const o = await ml.models(); ";
const COERCING = [
    // --- String, numeric conversion (ToInteger/ToNumber) ---
    ["substring", "substring", O + `return "abc".substring(o)`, `return "abc".substring(2)`, "c"],
    ["substr", "substr", O + `return "abc".substr(o)`, `return "abc".substr(2)`, "c"],
    ["slice", "slice", O + `return "abc".slice(o)`, `return "abc".slice(2)`, "c"],
    ["at", "at", O + `return "abc".at(o)`, `return "abc".at(2)`, "c"],
    ["charAt", "charAt", O + `return "abc".charAt(o)`, `return "abc".charAt(2)`, "c"],
    ["charCodeAt", "charCodeAt", O + `return "abc".charCodeAt(o)`, `return "abc".charCodeAt(2)`, 99],
    ["codePointAt", "codePointAt", O + `return "abc".codePointAt(o)`, `return "abc".codePointAt(2)`, 99],
    // Measured TWICE on main: the size preflight converts, then the native call converts again — the shape the join
    // separator's fix already met (redteam-coercion.test.mjs).
    ["repeat", "repeat", O + `return "abc".repeat(o)`, `return "abc".repeat(2)`, "abcabc"],
    ["padStart", "padStart", O + `return "abc".padStart(o)`, `return "abc".padStart(2)`, "abc"],
    ["padEnd", "padEnd", O + `return "abc".padEnd(o)`, `return "abc".padEnd(2)`, "abc"],
    // --- String, string conversion (ToString) ---
    ["normalize", "normalize", O + `return "abc".normalize(o)`, `return "abc".normalize("NFC")`, "abc"],
    ["includes", "includes", O + `return "abc".includes(o)`, `return "abc".includes("b")`, true],
    ["indexOf", "indexOf", O + `return "abc".indexOf(o)`, `return "abc".indexOf("b")`, 1],
    ["lastIndexOf", "lastIndexOf", O + `return "abc".lastIndexOf(o)`, `return "abc".lastIndexOf("b")`, 1],
    ["startsWith", "startsWith", O + `return "abc".startsWith(o)`, `return "abc".startsWith("a")`, true],
    ["endsWith", "endsWith", O + `return "abc".endsWith(o)`, `return "abc".endsWith("c")`, true],
    ["concat", "concat", O + `return "abc".concat(o)`, `return "abc".concat("z")`, "abcz"],
    ["localeCompare", "localeCompare", O + `return "abc".localeCompare(o)`, `return "abc".localeCompare("b")`, -1],
    ["split", "split", O + `return "abc".split(o)`, `return "abc".split("b")`, ["a", "c"]],
    // The SECOND argument is converted too (toString, then valueOf): every argument goes through the same check.
    ["includes' second argument", "includes", O + `return "abc".includes(o, o)`, `return "abc".includes("b", 1)`, true],
    // --- Array, numeric conversion ---
    ["array flat (depth)", "flat", O + `return [1, [2]].flat(o)`, `return [1, [2]].flat(1)`, [1, 2]],
    ["array slice", "slice", O + `return [1, 2].slice(o)`, `return [1, 2].slice(1)`, [2]],
    ["array at", "at", O + `return [1, 2].at(o)`, `return [1, 2].at(1)`, 2],
    ["array splice", "splice", O + `return [1, 2].splice(o)`, `return [1, 2].splice(1)`, [2]],
    // --- statics that convert their arguments: one row per receiver KIND (the reason names the rest of its names) ---
    ["Math.floor", "floor", O + `return Math.floor(o)`, `return Math.floor(2.7)`, 2],
    ["Number.parseInt", "parseInt", O + `return Number.parseInt(o)`, `return Number.parseInt("42")`, 42],
    ["Date.parse", "parse", O + `return Date.parse(o)`, `return Date.parse("2002-01-01T00:00:00Z")`, 1009843200000],
    ["Date.UTC", "UTC", O + `return Date.UTC(o, 0)`, `return Date.UTC(2002, 0)`, 1009843200000],
    // --- DOM: a selector, a name or a property key is a string converted by the host ---
    ["document.querySelector", "querySelector", O + `return document.querySelector(o)?.tagName`, `return document.querySelector("p")?.tagName`, "P"],
    ["document.getElementById", "getElementById", O + `return document.getElementById(o)?.tagName`, `return document.getElementById("d")?.tagName`, "DIV"],
    // Measured on main: every one of the four converts its argument with ToString. `querySelectorAll` then throws
    // "Invalid selector 2" (the page's `toString` answered "2"); the other three answer an empty collection.
    ["document.querySelectorAll", "querySelectorAll", O + `return document.querySelectorAll(o).length`, `return document.querySelectorAll("p").length`, 1],
    ["document.getElementsByTagName", "getElementsByTagName", O + `return document.getElementsByTagName(o).length`, `return document.getElementsByTagName("p").length`, 1],
    ["document.getElementsByClassName", "getElementsByClassName", O + `return document.getElementsByClassName(o).length`, `return document.getElementsByClassName("x").length`, 1],
    ["document.getElementsByName", "getElementsByName", O + `return document.getElementsByName(o).length`, `return document.getElementsByName("n").length`, 1],
    ["element.getAttribute", "getAttribute", `const el = await ml.models(); const o = await ml.models(); return el.getAttribute(o)`, `const el = await ml.models(); return el.getAttribute("class")`, "x", (d) => d.querySelector("p")],
    ["element.matches", "matches", `const el = await ml.models(); const o = await ml.models(); return el.matches(o)`, `const el = await ml.models(); return el.matches("p")`, true, (d) => d.querySelector("p")],
    ["element.closest", "closest", `const el = await ml.models(); const o = await ml.models(); return el.closest(o)?.tagName`, `const el = await ml.models(); return el.closest("body")?.tagName`, "BODY", (d) => d.querySelector("p")],
    ["element.hasAttribute", "hasAttribute", `const el = await ml.models(); const o = await ml.models(); return el.hasAttribute(o)`, `const el = await ml.models(); return el.hasAttribute("class")`, true, (d) => d.querySelector("p")],
    ["style.getPropertyValue", "getPropertyValue", `const s = await ml.models(); const o = await ml.models(); return s.getPropertyValue(o)`, `const s = await ml.models(); return s.getPropertyValue("color")`, "", (d) => d.body.style],
    ["collection.item", "item", `const c = await ml.models(); const o = await ml.models(); return c.item(o)?.tagName`, `const c = await ml.models(); return c.item(0)?.tagName`, "P", (d) => d.getElementsByTagName("p")],
    ["tokenlist.contains", "contains", `const c = await ml.models(); const o = await ml.models(); return c.contains(o)`, `const c = await ml.models(); return c.contains("x")`, true, (d) => d.querySelector("p").classList],
    ["tokenlist.item", "item", `const c = await ml.models(); const o = await ml.models(); return c.item(o)`, `const c = await ml.models(); return c.item(0)`, "x", (d) => d.querySelector("p").classList],
    // --- a Number receiver converts the argument too ---
    ["number toFixed", "toFixed", O + `return (5.1).toFixed(o)`, `return (5.1).toFixed(2)`, "5.10"],
    ["number toPrecision", "toPrecision", O + `return (5.1).toPrecision(o)`, `return (5.1).toPrecision(2)`, "5.1"],
    ["number toString (radix)", "toString", O + `return (5).toString(o)`, `return (5).toString(2)`, "101"],
];

// Positions that do NOT convert, so nothing to row (each measured on main):
//  · `[1, 2].includes/indexOf/lastIndexOf(o)` compare with SameValueZero / strict equality, `.fill(o)` copies the
//    value and `.concat(o)` appends it — no conversion; `new Array(o)` with one non-number argument is an element.
//  · `"abc".search/match/matchAll(o)` and `re.test/exec(o)` already refuse, with "a regex pattern that is not a
//    string or a regex" and "a regex search over a value that is not a string or a" — the wording a fix copies.
//  · `el.contains(o)` takes a Node: a TypeError, never a conversion.
//  · `(5).toLocaleString(o)` answers "5" with no call; `el.querySelectorAll(o)` refuses before any conversion
//    ("querySelectorAll is not a function on this value"), so only `document`'s four are positions;
//    `collection.at(item)` on a NodeList refuses the same way. `collection.item` on an HTMLCollection does convert.
//  · `replace`/`replaceAll`'s pattern and `join`'s separator already have rows in redteam-coercion.test.mjs (#1454).
// The rest of Math (max, min, ceil, round, abs, pow, sqrt, sign, trunc) convert exactly as `Math.floor` does;
// `Number.parseFloat` as `Number.parseInt`; `"abc".toUpperCase`-style readers take no argument at all.

for (const [name, named, js, control, expected, receiver] of COERCING) {
    test(`RED TEAM: ${name} does not run a page function for its argument`, async () => {
        const ran = [];
        const r = await run(js, ran, receiver).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${name} ran the page's function: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${name}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
        assert.match(r.refused, new RegExp(named.replace(/[.()]/g, "\\$&"), "i"), `${name}: the refusal does not name the method: ${r.refused}`);
    });

    test(`CONTROL: ${name} with a real argument still does its work`, async () => {
        const r = await runControl(control, receiver).catch((e) => ({ refused: String(e) }));
        assert.ok(!r.refused, `${name}: a real argument was refused: ${r.refused}`);
        assert.deepEqual(r.value, expected, `${name} with a real argument answered something else`);
    });
}

// --- operators: the converting positions with no method to name ---

// The same predicate judges the operands of `+`, a comparison, a unary sign, a template and a computed key
// (evaluator.ts, `coerces`; called from `applyBinary`, the unary branch, the template branch and `guardKey`, and so by
// `+=` too). There is no method for the refusal to name, so it names the POSITION, and the control beside each row runs
// the same operator on real operands: a fix that refused every operator fails there.
const OPERATORS = [
    ["`+`", /the operator \+/, O + `return o + 1`, `return 2 + 1`, 3],
    // The compound form shares `applyBinary`, so it cannot quietly skip the judgement.
    ["`+=`", /the operator \+/, O + `let x = 1; x += o; return x`, `let x = 1; x += 2; return x`, 3],
    ["an ordering comparison (`>`)", /the operator >/, O + `return o > 1`, `return 2 > 1`, true],
    // `==` between a page object and a number coerces (only two objects, or a null, do not).
    ["a loose comparison (`==`)", /the operator ==/, O + `return o == 2`, `return 2 == 2`, true],
    ["unary `-`", /unary -/, O + `return -o`, `return -2`, -2],
    ["a template literal", /a template/, O + "return `${o}`", "return `${2}`", "2"],
    // `guardKey` judges a computed key on a host receiver AND on an object the script built, so neither is a way in.
    ["a computed key", /a computed key/, O + `const a = { x: 1 }; return a[o]`, `const a = { x: 1 }; return a["x"]`, 1],
];

for (const [name, names, js, control, expected] of OPERATORS) {
    test(`RED TEAM: an operand of ${name} does not run a page function (the refusal names the position)`, async () => {
        const ran = [];
        const r = await run(js, ran).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${name} ran the page's function: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${name}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
        assert.match(r.refused, names, `${name}: the refusal does not name the position: ${r.refused}`);
    });

    test(`CONTROL: ${name} on real operands still does its work`, async () => {
        const r = await runControl(control).catch((e) => ({ refused: String(e) }));
        assert.ok(!r.refused, `${name}: real operands were refused: ${r.refused}`);
        assert.deepEqual(r.value, expected, `${name} on real operands answered something else`);
    });
}

// Provenance, not kind: a Date or an element the page hands over is refused as an operand, whatever it would convert to.
for (const [name, value] of [["a page's Date", () => new Date(0)], ["a page's element", (d) => d.querySelector("p")]]) {
    test(`RED TEAM: ${name} as an operand is refused, never converted by the host`, async () => {
        const ran = [];
        const r = await run(O + `return o > 1`, ran, value).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, []);
        assert.match(String(r.refused), /the operator > was given an object the script did not build/, `${name} as an operand answered instead of refusing: ${JSON.stringify(r.value)}`);
    });
}

// The rule is provenance, so the same operators stay usable on what the script itself built and on the page's DATA.
test("CONTROL: an array of strings, a String object and the script's own arrow still convert as operands", async () => {
    assert.equal((await run(O + `return o + ""`, [], () => ["a", "b"])).value, "a,b", "an array of page strings converts as data");
    assert.equal((await run(O + "return `${o}`", [], () => ["a", "b"])).value, "a,b", "and in a template");
    // A String object carrying its own `toString`: the intrinsic's slot is the data, so no page function runs.
    assert.equal((await run(O + `return o + ""`, [], () => { const s = new String("a,b"); s.toString = () => "PAGE"; return s; })).value, "a,b", "a String object converts to its data");
    assert.equal((await run(`const a = { toString: () => "X" }; return a + ""`, [])).value, "X", "an arrow the script wrote is allowed to convert");
    assert.equal((await run("const a = { toString: () => \"X\" }; return `${a}`", [])).value, "X", "and in a template");
});

test("RED TEAM: an object the script built converts only through arrows the script wrote", async () => {
    // The literal is the script's, but its `toString` is the PAGE's function: provenance is per function, not per object.
    const ran = [];
    const pageFn = function pageFn() { ran.push("page"); return "P"; };
    const r = await run(O + `const a = { toString: o }; return a + ""`, [], () => pageFn).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], "the page's function ran as a conversion");
    assert.match(String(r.refused), /the operator \+ was given an object the script did not build/, `a page function inside the script's literal was run: ${JSON.stringify(r.value)}`);
    // A page's array holding an object is refused for its ITEM, so the array is not a way to smuggle one into `+`.
    const nested = await run(O + `return o + ""`, [], () => [{ a: 1 }]).catch((e) => ({ refused: String(e) }));
    assert.match(String(nested.refused), /item 0 is an object/, `an array holding a page object was converted: ${JSON.stringify(nested.value)}`);
});
