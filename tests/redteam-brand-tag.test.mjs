// redteam-brand-tag.test.mjs — a page may not CHOOSE what kind of value the read-only dialect thinks it has: the tag
// it can set is not a brand (src/readonly-exec/policy.ts `kindOf`, src/readonly-exec/evaluator.ts member dispatch;
// docs/dev/readonly-exec.md, "The mediated evaluator"). Found while probing `ml.embed`'s string read (#1336); the flaw
// is in the dialect's central kind check, so it applies to main too, and this file imports nothing of that PR's.
//
// `kindOf` reads `Object.prototype.toString.call(o)` for the String and RegExp kinds. A page object can answer that tag
// through a Symbol.toStringTag getter, so it decides its own kind, and the member dispatch then takes the string (or
// regexp) path — which looks the member up on the object ITSELF — so the page's own function runs where a plain object
// is refused. Measured on main: a tagged object's `o.toUpperCase()` runs its own `toUpperCase` and returns its value,
// while the same object with any other tag is `NotInDialect method 'toUpperCase' not allowed on this value`.
// The Date branch directly below the broken ones already refuses to rely on the tag, and says why:
// "a page object can claim Symbol.toStringTag = 'Date', and since a date now has methods, a claimed one would have its
// OWN getTime called" — the borrowed getter throws on an object without the internal slot. That is the shape of the fix.
//
// A hole still open lands as a `{ todo }` row asserting the DEFENDED outcome; the controls beside it pin what already
// holds, so the fixture cannot pass by refusing nothing.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect } from "../src/readonly-exec.ts";

const TODO = { todo: "open: kindOf trusts a page-settable Symbol.toStringTag for the String and RegExp kinds" };

const doc = () => new JSDOM("<!doctype html><body><p>hi</p></body>").window.document;

/** A value the page hands the dialect, plus counters for every side effect the dialect must not trigger. */
function pageObject(tag, extra = {}) {
    const ran = [];
    const o = {
        get [Symbol.toStringTag]() { ran.push("tag"); return tag; },
        ...Object.fromEntries(Object.entries(extra).map(([k, f]) => [k, (...a) => { ran.push(k); return f(...a); }])),
    };
    return { o, ran };
}

/** Run `js` against an `ml` whose one member hands back `o`; returns what happened. */
async function withValue(o, js) {
    const ml = { models: async () => o };
    return evalReadonly(js, doc(), ml, undefined, {});
}

// --- the hole: a claimed tag decides the member set ---

test("RED TEAM: Symbol.toStringTag = 'String' does not grant the string member set (the page's own method must not run)", TODO, async () => {
    const { o, ran } = pageObject("String", { toUpperCase: () => "PAGE" });
    await assert.rejects(withValue(o, `const o = await ml.models(); return o.toUpperCase()`), (e) => e instanceof NotInDialect, "a claimed String was allowed the string member set");
    assert.deepEqual(ran, [], `the dialect ran the page's own method: ${JSON.stringify(ran)}`);
});

test("RED TEAM: Symbol.toStringTag = 'RegExp' does not grant the regexp member set (nor hand back the page's fields)", TODO, async () => {
    const { o, ran } = pageObject("RegExp", { test: () => true, exec: () => ["PAGE"] });
    await assert.rejects(withValue(o, `const r = await ml.models(); return r.test("x")`), (e) => e instanceof NotInDialect, "a claimed RegExp was allowed the regexp member set");
    assert.deepEqual(ran, [], `the dialect ran the page's own method: ${JSON.stringify(ran)}`);
});

// --- the controls: the same dispatch, decided by a brand ---

test("RED TEAM: control — the same object with any other tag is refused, and the page's own method never runs", async () => {
    for (const tag of [undefined, "Thing", "Object"]) {
        const extra = { toUpperCase: () => "PAGE" };
        const ran = [];
        const o = tag === undefined ? { toUpperCase: () => { ran.push("toUpperCase"); return "PAGE"; } } : pageObject(tag, extra).o;
        const rejected = await withValue(o, `const o = await ml.models(); return o.toUpperCase()`).then(() => false, (e) => e instanceof NotInDialect);
        assert.equal(rejected, true, `a ${tag ?? "untagged"} object was allowed 'toUpperCase'`);
        assert.deepEqual(ran, [], `the page's own method ran for tag ${tag}`);
    }
});

test("RED TEAM: control — a claimed 'Date' or 'Set' is refused by the borrowed getter, and its own method never runs", async () => {
    // The two branches that DO check the internal slot, three lines below the broken ones: the negative control that
    // shows the property is achievable, and the shape the String and RegExp branches are missing.
    for (const [tag, method] of [["Date", "toISOString"], ["Set", "has"]]) {
        const { o, ran } = pageObject(tag, { [method]: () => "PAGE" });
        const rejected = await withValue(o, `const o = await ml.models(); return o.${method}("x")`).then(() => false, (e) => e instanceof NotInDialect);
        assert.equal(rejected, true, `a claimed ${tag} reached '${method}'`);
        assert.deepEqual(ran.filter((r) => r !== "tag"), [], `the page's own ${method} ran`);
    }
});
