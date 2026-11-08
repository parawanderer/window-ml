// readonly-convert.test.mjs — a value a host call or an operator CONVERTS to a primitive is judged once, by provenance.
//
// The dialect's promise is that a page's value is data. Converting an object runs its own `toString`/`valueOf`, so every
// converting position (the CONVERTS table in policy.ts) and every operator holds a value the script built, a String object
// (read by its slot), or an array of data. These rows are the adversarial pass for that rule and its completeness walk;
// e3's redteam-coerce-args.test.mjs is the measured list of positions.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";
import { METHODS_BY_KIND, CONVERTS, NO_CONVERSION } from "../src/readonly-exec/policy.ts";

const doc = () => new JSDOM("<!doctype html><body><p class=\"x\">hi</p></body>").window.document;
const handed = (...vs) => { const q = [...vs]; return { models: async () => q.shift() }; };
const run = (js, ...vs) => evalReadonly(js, doc(), handed(...vs), undefined, {});
const refused = (e) => e?.name === "NotInDialect" || /NotInDialect/.test(String(e?.constructor?.name)) || /was given|too large|not allowed/.test(String(e?.message));
const page = (ran) => ({ toString() { ran.push("toString"); return "2"; }, valueOf() { ran.push("valueOf"); return 2; } });

// --- completeness: every admitted method is decided ---

test("every admitted method is in CONVERTS or NO_CONVERSION, and in not both", () => {
    const undecided = [], both = [];
    for (const [kind, names] of Object.entries(METHODS_BY_KIND))
        for (const m of names) {
            const c = Object.hasOwn(CONVERTS[kind] ?? {}, m), n = Object.hasOwn(NO_CONVERSION[kind] ?? {}, m);
            if (!c && !n) undecided.push(`${kind}.${m}`);
            if (c && n) both.push(`${kind}.${m}`);
        }
    assert.deepEqual(undecided, [], "a method added to the whitelist needs a decision in CONVERTS or NO_CONVERSION (policy.ts)");
    assert.deepEqual(both, []);
});

test("neither table names a method the whitelist does not have", () => {
    const stray = [];
    for (const [kind, t] of [...Object.entries(CONVERTS), ...Object.entries(NO_CONVERSION)])
        for (const m of Object.keys(t)) if (!(METHODS_BY_KIND[kind] ?? []).includes(m) && !(METHODS_BY_KIND["*"].includes(m))) stray.push(`${kind}.${m}`);
    assert.deepEqual(stray, []);
});

// --- positions the red team did not list ---

test("JSON.parse, getRootNode and a locale options object do not run a page's conversion", async () => {
    const ran = [];
    for (const js of [
        `const o = await ml.models(); return JSON.parse(o)`,
        `const o = await ml.models(); return document.getRootNode(o)`,
        `const o = await ml.models(); return (5).toLocaleString("en", o)`,
        `const o = await ml.models(); return [1, 2, 3].fill(0, o)`,
        `const o = await ml.models(); return [1, 2, 3].indexOf(2, o)`,
        `const o = await ml.models(); return String(o)`,
        `const o = await ml.models(); return Number(o)`,
        `const o = await ml.models(); return isNaN(o)`,
        `const o = await ml.models(); return getComputedStyle(document.body, o)`,
    ]) await assert.rejects(run(js, page(ran)), refused, js);
    assert.deepEqual(ran, []);
});

test("every operator, a template and a computed key refuse a page object before converting it", async () => {
    const ran = [];
    for (const js of [
        `const o = await ml.models(); return o + 1`, `const o = await ml.models(); return 1 - o`, `const o = await ml.models(); return o * 2`,
        `const o = await ml.models(); return o < 3`, `const o = await ml.models(); return o == 2`, `const o = await ml.models(); return -o`,
        `const o = await ml.models(); return +o`, "const o = await ml.models(); return `${o}`", `const o = await ml.models(); return ({})[o]`,
        `const o = await ml.models(); const t = {}; t[o] = 1; return t`,
    ]) await assert.rejects(run(js, page(ran)), refused, js);
    assert.deepEqual(ran, [], "a conversion ran");
});

// --- provenance: what the script built ---

test("a script's own objects convert, and its own arrows run mediated", async () => {
    assert.equal((await run(`return "abc".slice({ valueOf: () => 1 })`)).value, "bc");
    assert.equal((await run("const o = { toString: () => 'z' }; return `${o}` + (o + '')")).value, "zz");
    assert.equal((await run(`return String({})`)).value, "[object Object]");
    assert.equal((await run(`return new Date(5) - new Date(2)`)).value, 3);
    assert.equal((await run(`return new Date(2) < new Date(5)`)).value, true);
});

test("a function a page handed back, stored in the script's own object, is not a conversion the script wrote", async () => {
    const ran = [];
    const f = () => { ran.push("f"); return "x"; };
    await assert.rejects(run(`const f = await ml.models(); const o = { toString: f }; return "abc".slice(o)`, f), refused);
    await assert.rejects(run(`const f = await ml.models(); const o = { valueOf: f }; return o + 1`, f), refused);
    await assert.rejects(run(`const f = await ml.models(); return f + ""`, f), refused);
    assert.deepEqual(ran, []);
});

test("a script's object with an own toStringTag or an accessor conversion is refused", async () => {
    await assert.rejects(run(`return "abc".slice({ [Symbol.toStringTag]: "x" })`), refused);
    // A getter is not in the dialect's object literals, so the accessor case cannot be written; a tag can only be a computed key.
});

// --- a String object is its slot's primitive ---

test("a String object is its primitive wherever it is converted or called, whatever it carries", async () => {
    const ran = [];
    const s = new String("a,b");
    s.toString = () => { ran.push("toString"); return "PAGE"; };
    s.valueOf = () => { ran.push("valueOf"); return "PAGE"; };
    s.split = () => { ran.push("split"); return ["PAGE"]; };
    s[Symbol.toPrimitive] = () => { ran.push("toPrimitive"); return "PAGE"; };
    assert.equal((await run(`const s = await ml.models(); return s + "!"`, s)).value, "a,b!");
    assert.equal((await run("const s = await ml.models(); return `<${s}>`", s)).value, "<a,b>");
    assert.deepEqual((await run(`const s = await ml.models(); return s.split(",")`, s)).value, ["a", "b"]);
    assert.equal((await run(`const s = await ml.models(); return "xa,bx".includes(s)`, s)).value, true);
    assert.equal((await run(`const s = await ml.models(); return String(s)`, s)).value, "a,b");
    assert.deepEqual(ran, []);
});

test("the controls: real arguments and operands still answer", async () => {
    assert.equal((await run(`return "abc".slice(1) + 1 + \`\${2}\``)).value, "bc12");
    assert.equal((await run(`return Math.max(1, 3) - parseInt("2") + Number("1")`)).value, 2);
    assert.equal((await run(`return [1, 2, 3].indexOf(2, 1)`)).value, 1);
    assert.equal((await run(`return (255).toString(16)`)).value, "ff");
    assert.equal((await run(`return document.querySelector("p").getAttribute("class")`)).value, "x");
    assert.equal((await run(`return "a-b".replace(/-/, "+")`)).value, "a+b");
    assert.deepEqual((await run(`return "a-b".split(/-/)`)).value, ["a", "b"]);
    assert.equal((await run(`return [["a"], ["b"]].join(",")`)).value, "a,b");
});

test("a refused conversion leaves nothing behind when the survey falls out of dialect", async () => {
    const d = doc();
    const before = d.body.innerHTML;
    await assert.rejects(evalReadonly(`const o = await ml.models(); document.body.setAttribute("x", "1"); return "abc".slice(o)`, d, handed({ toString: () => "1" }), undefined, {}), refused);
    assert.equal(d.body.innerHTML, before);
});
