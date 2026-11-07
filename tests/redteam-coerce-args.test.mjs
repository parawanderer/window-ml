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
// row's reason names the rest of them). Positions that do NOT convert are one-line reasons below rather than rows, so
// a fix is not asked to refuse a call that is already data.
//
// Each row lands `{ todo }` while the hole is open: it asserts the page's functions never ran, that the survey is
// refused, and that the refusal NAMES the method (the ruled shape). Its control, beside it, runs the same call with a
// real number or string argument and asserts the ordinary answer, so a fix that refused every argument fails here.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";

const doc = () => new JSDOM("<!doctype html><body><p class=\"x\">hi</p><div id=\"d\">x</div></body>").window.document;

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
    ["element.getAttribute", "getAttribute", `const el = await ml.models(); const o = await ml.models(); return el.getAttribute(o)`, `const el = await ml.models(); return el.getAttribute("class")`, "x", (d) => d.querySelector("p")],
    ["element.matches", "matches", `const el = await ml.models(); const o = await ml.models(); return el.matches(o)`, `const el = await ml.models(); return el.matches("p")`, true, (d) => d.querySelector("p")],
    ["style.getPropertyValue", "getPropertyValue", `const s = await ml.models(); const o = await ml.models(); return s.getPropertyValue(o)`, `const s = await ml.models(); return s.getPropertyValue("color")`, "", (d) => d.body.style],
    ["collection.item", "item", `const c = await ml.models(); const o = await ml.models(); return c.item(o)?.tagName`, `const c = await ml.models(); return c.item(0)?.tagName`, "P", (d) => d.getElementsByTagName("p")],
    // --- a Number receiver converts the argument too ---
    ["number toFixed", "toFixed", O + `return (5.1).toFixed(o)`, `return (5.1).toFixed(2)`, "5.10"],
    ["number toString (radix)", "toString", O + `return (5).toString(o)`, `return (5).toString(2)`, "101"],
];

// Positions that do NOT convert, so nothing to row (each measured on main):
//  · `[1, 2].includes/indexOf/lastIndexOf(o)` compare with SameValueZero / strict equality, `.fill(o)` copies the
//    value and `.concat(o)` appends it — no conversion; `new Array(o)` with one non-number argument is an element.
//  · `"abc".search/match/matchAll(o)` and `re.test/exec(o)` already refuse, with "a regex pattern that is not a
//    string or a regex" and "a regex search over a value that is not a string or a" — the wording a fix copies.
//  · `el.contains(o)` takes a Node: a TypeError, never a conversion.
//  · `(5).toLocaleString(o)` answers "5" with no call; `collection.at(item)` on a NodeList refuses before any
//    conversion ("... is not a function on this value"). `collection.item` on an HTMLCollection does convert (a row).
//  · `replace`/`replaceAll`'s pattern and `join`'s separator already have rows in redteam-coercion.test.mjs (#1454).
// The rest of Math (max, min, ceil, round, abs, pow, sqrt, sign, trunc) convert exactly as `Math.floor` does;
// `Number.parseFloat` as `Number.parseInt`; `"abc".toUpperCase`-style readers take no argument at all.

for (const [name, named, js, control, expected, receiver] of COERCING) {
    const twice = /^(repeat|padStart|padEnd)$/.test(named) ? " TWICE — the size preflight converts, then the native call converts again, the shape the join separator's fix met" : "";
    test(`RED TEAM: ${name} does not run a page function for its argument`, { todo: `open: ${named} coerces the page's object into a primitive, so the host runs the page's own toString/valueOf${twice}` }, async () => {
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
