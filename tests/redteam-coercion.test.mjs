// redteam-coercion.test.mjs — the coercion hole `docs/dev/readonly-exec.md` records as OPEN, as rows: a value the page
// handed the dialect can make the dialect RUN ITS OWN `toString`/`valueOf` by being coerced, so a read that is
// documented as data executes page code (src/readonly-exec/evaluator.ts; the traps section, "A kind decided by
// `Object.prototype.toString` is a page's choice", names `[o].join("")`, `concat(o).join`, a pattern object coerced by
// native `replace`/`replaceAll`, and `String(obj).length` on a real String carrying its own `toString`).
//
// Each hole row lands as `{ todo }` while the hole is open: it asserts the DEFENDED outcome, so it fails on main at the
// assertion it carries and the flip is a commit that drops the option once a change turns it. Each hole row has a plain
// control beside it showing the same read on the page's own DATA still works, so the fixture cannot pass by refusing
// everything. The kind checks that closed the neighbouring hole are #1393's (`isStringObject`, `isRegExpObject`).
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

const OPEN = "open: a coercion runs the page's own toString/valueOf (readonly-exec.md, Traps)";

// --- the controls: the same reads on the page's own data ---

test("RED TEAM: control — a join, a split and a replace on the page's own data still do their work", async () => {
    assert.equal((await run(`const o = await ml.models(); return o.join("-")`, ["a", "b"])).value, "a-b", "an array of the page's strings joins");
    assert.deepEqual((await run(`const o = await ml.models(); return o.split(",")`, "a,b")).value, ["a", "b"], "a string splits");
    assert.equal((await run(`const o = await ml.models(); return o.replace("a", "z")`, "a,b")).value, "z,b", "a string replaces");
    // Measured on main: `+` on a real String object whose own `toString` answers "PAGE" still answers the data, because
    // the intrinsic `valueOf` is what the number hint reaches — so the instrument every hole row uses does report
    // "did not run" on a read that is safe, and a hole row's non-empty `ran` is the page's function, not the probe's.
    const ran = [];
    assert.equal((await run(`const s = await ml.models(); return s + ""`, stringObject(ran))).value, "a,b", "a String object added to a string answers its data");
    assert.deepEqual(ran, [], "and its own toString did not run");
});

test("RED TEAM: a String object's own valueOf is not called by `+` (the read is data)", { todo: OPEN }, async () => {
    const ran = [];
    const r = await run(`const s = await ml.models(); return s + ""`, stringObject(ran, { ownValueOf: true })).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `+ ran the String object's own valueOf: ${JSON.stringify(ran)}`);
    assert.equal(r.value ?? r.refused, "a,b", "the read must be the String's data, or a refusal — never the page's answer");
});

// --- the hole: a coercion the dialect performs on a page value runs the page's function ---

test("RED TEAM: `String(o)` on a page value is a data read (the page's toString must not run)", { todo: OPEN }, async () => {
    const ran = [];
    await run(`const o = await ml.models(); return String(o)`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "String(o) ran the page's own toString");
});

test("RED TEAM: a template literal over a page value is a data read (the page's toString must not run)", { todo: OPEN }, async () => {
    const ran = [];
    await run("const o = await ml.models(); return `${o}`", pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "`${o}` ran the page's own toString");
});

test("RED TEAM: `o + \"\"` on a page value is a data read (the page's valueOf must not run)", { todo: OPEN }, async () => {
    const ran = [];
    await run(`const o = await ml.models(); return o + ""`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "o + '' ran the page's own valueOf");
});

test("RED TEAM: `[o].join(\"\")` is a data read (the page's toString must not run)", { todo: OPEN }, async () => {
    const ran = [];
    await run(`const o = await ml.models(); return [o].join("")`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "[o].join('') ran the page's own toString");
});

test("RED TEAM: `[].concat(o).join(\"\")` is a data read (the page's toString must not run)", { todo: OPEN }, async () => {
    const ran = [];
    await run(`const o = await ml.models(); return [].concat(o).join("")`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "concat(o).join('') ran the page's own toString");
});

test("RED TEAM: `[o].toString()` is a data read (the page's toString must not run)", { todo: OPEN }, async () => {
    const ran = [];
    await run(`const o = await ml.models(); return [o].toString()`, pageValue(ran)).catch(() => {});
    assert.deepEqual(ran, [], "[o].toString() ran the page's own toString");
});

test("RED TEAM: a String object's split reads its data, never its own toString", { todo: OPEN }, async () => {
    const ran = [];
    const r = await run(`const s = await ml.models(); return s.split(",")`, stringObject(ran)).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `split ran the String object's own toString: ${JSON.stringify(ran)}`);
    assert.deepEqual(r.value ?? r.refused, ["a", "b"], "the read must be the String's data, or a refusal — never the page's answer");
});

test("RED TEAM: a String object's replace reads its data, never its own toString", { todo: OPEN }, async () => {
    const ran = [];
    const r = await run(`const s = await ml.models(); return s.replace("a", "z")`, stringObject(ran)).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `replace ran the String object's own toString: ${JSON.stringify(ran)}`);
    assert.equal(r.value ?? r.refused, "z,b", "the read must be the String's data, or a refusal — never the page's answer");
});

test("RED TEAM: a pattern object handed to the native replace is refused, never coerced by the host", { todo: OPEN }, async () => {
    const ran = [];
    const pattern = { toString() { ran.push("toString"); return "a"; } };
    await run(`const p = await ml.models(); return "a,b".replace(p, "z")`, pattern).catch(() => {});
    assert.deepEqual(ran, [], "ToString(searchValue) ran the page's own toString inside the host's replace");
});

test("RED TEAM: a String object's own toString never charges the replace (the size check reads data)", { todo: OPEN }, async () => {
    const ran = [];
    await run(`const s = await ml.models(); return "aaa".replace(s, "b")`, stringObject(ran)).catch(() => {});
    assert.deepEqual(ran, [], "the replace's size check coerced the String object and ran its own toString");
});
