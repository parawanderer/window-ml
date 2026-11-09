// redteam-coercion.test.mjs — the coercion hole `docs/dev/readonly-exec.md` recorded as OPEN, as rows (closed by #1536;
// they stay as the guard): a value the page
// handed the dialect can make the dialect RUN ITS OWN `toString`/`valueOf` by being coerced, so a read that is
// documented as data executes page code (src/readonly-exec/evaluator.ts; the traps section, "A kind decided by
// `Object.prototype.toString` is a page's choice", names `[o].join("")`, `concat(o).join`, a pattern object coerced by
// native `replace`/`replaceAll`, and `String(obj).length` on a real String carrying its own `toString`).
//
// Each hole row landed as `{ todo }` while the hole was open: it asserted the DEFENDED outcome, failing on main at the
// assertion it carries. #1536 judges a converted value by provenance and turns every one of them, so this commit drops
// the option. Each hole row has a plain control beside it showing the same read on the page's own DATA still works, so
// the fixture cannot pass by refusing everything. The kind checks that closed the neighbouring hole are #1393's
// (`isStringObject`, `isRegExpObject`).
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";

const doc = () => new JSDOM("<!doctype html><body><p>hi</p></body>").window.document;

/** Run `js` against an `ml` whose one member hands back `value`; returns what the cell produced. */
const run = (js, value) => evalReadonly(js, doc(), { models: async () => value }, undefined, {});

/** A page's own object: every function it can offer records that it ran, so an empty `ran` is the defended outcome. */
function pageValue(ran) {
    return { toString() { ran.push("toString"); return "PAGE"; }, valueOf() { ran.push("valueOf"); return "PAGE"; } };
}

/** A GENUINE String object carrying its own `toString` (and `valueOf`, `ownValueOf`): a String a script reads as data is
 *  "a,b", so a coercion that answers "PAGE" ran the page's function and a read that answers "a,b" did not. Only the
 *  overridden methods record, so `ran` empty is exactly "the page's functions did not run". */
function stringObject(ran, { ownValueOf = false } = {}) {
    const s = new String("a,b");
    s.toString = () => { ran.push("toString"); return "PAGE"; };
    if (ownValueOf) s.valueOf = () => { ran.push("valueOf"); return "PAGE"; };
    return s;
}

// (The `OPEN` todo text that carried each row until #1536 is gone with the option.)
// --- the controls: the same reads on the page's own data ---

test("RED TEAM: control — a join, a split and a replace on the page's own data still do their work", async () => {
    assert.equal((await run(`const o = await ml.models(); return o.join("-")`, ["a", "b"])).value, "a-b", "an array of the page's strings joins");
    assert.deepEqual((await run(`const o = await ml.models(); return o.split(",")`, "a,b")).value, ["a", "b"], "a string splits");
    assert.equal((await run(`const o = await ml.models(); return o.replace("a", "z")`, "a,b")).value, "z,b", "a string replaces");
    assert.deepEqual((await run(`const o = await ml.models(); return o.sort()`, ["b", "a"])).value, ["a", "b"], "an array of the page's strings sorts, with no comparator");
    // Measured on main: `+` on a real String object whose own `toString` answers "PAGE" still answers the data, because
    // the intrinsic `valueOf` is what the number hint reaches — so the instrument every hole row uses does report
    // "did not run" on a read that is safe, and a hole row's non-empty `ran` is the page's function, not the probe's.
    const ran = [];
    assert.equal((await run(`const s = await ml.models(); return s + ""`, stringObject(ran))).value, "a,b", "a String object added to a string answers its data");
    assert.deepEqual(ran, [], "and its own toString did not run");
});

test("RED TEAM: a String object's own valueOf is not called by `+` (the read is data)", async () => {
    const ran = [];
    const r = await run(`const s = await ml.models(); return s + ""`, stringObject(ran, { ownValueOf: true })).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `+ ran the String object's own valueOf: ${JSON.stringify(ran)}`);
    assert.equal(r.value ?? r.refused, "a,b", "the read must be the String's data, or a refusal — never the page's answer");
});

// --- the hole: a coercion the dialect performs on a page value runs the page's function ---

test("RED TEAM: `String(o)` on a page value is a data read (the page's toString must not run)", async () => {
    const ran = [];
    await run(`const o = await ml.models(); return String(o)`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "String(o) ran the page's own toString");
});

test("RED TEAM: a template literal over a page value is a data read (the page's toString must not run)", async () => {
    const ran = [];
    await run("const o = await ml.models(); return `${o}`", pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "`${o}` ran the page's own toString");
});

test("RED TEAM: `o + \"\"` on a page value is a data read (the page's valueOf must not run)", async () => {
    const ran = [];
    await run(`const o = await ml.models(); return o + ""`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "o + '' ran the page's own valueOf");
});

test("RED TEAM: `[o].join(\"\")` is a data read (the page's toString must not run)", async () => {
    const ran = [];
    await run(`const o = await ml.models(); return [o].join("")`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "[o].join('') ran the page's own toString");
});

test("RED TEAM: `[1, 2].join(o)` is a data read (the page's toString must not run for the SEPARATOR)", async () => {
    // Measured on d260cbb2: the page's toString ran TWICE, once in the preflight's own `String(args[0] ?? ",")` and
    // once inside `join`, and the answer was "1PAGE2". The other argument of the same call is a coercion too.
    const ran = [];
    const r = await run(`const o = await ml.models(); return [1, 2].join(o)`, pageValue(ran)).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `join ran the page's toString for its separator: ${JSON.stringify(ran)}`);
    assert.ok(r.value === undefined || r.value === "1,2", `the separator became the page's answer: ${JSON.stringify(r.value ?? r.refused)}`);
});

test("RED TEAM: `[].concat(o).join(\"\")` is a data read (the page's toString must not run)", async () => {
    const ran = [];
    await run(`const o = await ml.models(); return [].concat(o).join("")`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "concat(o).join('') ran the page's own toString");
});

test("RED TEAM: `[o].toString()` is a data read (the page's toString must not run)", async () => {
    const ran = [];
    await run(`const o = await ml.models(); return [o].toString()`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "[o].toString() ran the page's own toString");
});

test("RED TEAM: `sort()` with no comparator is a data read (the page's toString must not run)", async () => {
    // The default comparator is ToString, so a sort of two elements coerces the object one: measured on main, the page's
    // own toString ran and the host sorted by its answer. An array of data still sorts (the control above).
    const ran = [];
    await run(`const o = await ml.models(); return [o, 2].sort()`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "[o, 2].sort() ran the page's own toString");
    // The gate reads `args[0] === undefined`, which an EXPLICIT undefined also satisfies — the shape that pins it:
    // rewritten as `args.length === 0`, this call runs the page's toString once and returns [2,{}] (measured).
    const explicit = [];
    await run(`const o = await ml.models(); return [o, 2].sort(undefined)`, pageValue(explicit)).catch(() => {});
    assert.deepEqual(explicit, [], "[o, 2].sort(undefined) ran the page's own toString");
});

test("RED TEAM: a String object's split reads its data, never its own toString", async () => {
    const ran = [];
    const r = await run(`const s = await ml.models(); return s.split(",")`, stringObject(ran)).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `split ran the String object's own toString: ${JSON.stringify(ran)}`);
    assert.deepEqual(r.value ?? r.refused, ["a", "b"], "the read must be the String's data, or a refusal — never the page's answer");
});

test("RED TEAM: a String object's replace reads its data, never its own toString", async () => {
    const ran = [];
    const r = await run(`const s = await ml.models(); return s.replace("a", "z")`, stringObject(ran)).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `replace ran the String object's own toString: ${JSON.stringify(ran)}`);
    assert.equal(r.value ?? r.refused, "z,b", "the read must be the String's data, or a refusal — never the page's answer");
});

test("RED TEAM: a pattern object handed to the native replace is refused, never coerced by the host", async () => {
    const ran = [];
    const pattern = { toString() { ran.push("toString"); return "a"; } };
    await run(`const p = await ml.models(); return "a,b".replace(p, "z")`, pattern).catch(() => {});
    assert.deepEqual(ran, [], "ToString(searchValue) ran the page's own toString inside the host's replace");
});

test("RED TEAM: a String object's own toString never charges the replace (the size check reads data)", async () => {
    const ran = [];
    await run(`const s = await ml.models(); return "aaa".replace(s, "b")`, stringObject(ran)).catch(() => {});
    assert.deepEqual(ran, [], "the replace's size check coerced the String object and ran its own toString");
});
