// Completion for a watch as it is typed (src/watch-complete.ts): what is offered after `chain.` and at a bare name, over
// the tree's shape (`treeShape`, src/state-watch.ts) and the read-only dialect's own method lists, and the bounds on the
// shape a panel is sent.
import { test } from "node:test";
import assert from "node:assert/strict";

const { completeWatch, MAX_COMPLETIONS } = await import("../src/watch-complete.ts");
const { treeShape } = await import("../src/state-watch.ts");
const { offeredMethods, MUTATING_METHODS } = await import("../src/readonly-exec/policy.ts");

const TREE = {
    ml: { current: { messages: [{ role: "user", text: "hi" }], run: { step: 2 } } },
    inspector: { run: { init: { task: "count", tools: ["exec", "look"] }, "odd key": 1 }, session: { title: "t" } },
};
const SHAPE = treeShape(TREE);
/** The labels offered with the caret at the end of `text` (or at the `|` in it). */
function labels(text, shape = SHAPE) {
    const at = text.indexOf("|");
    const src = at < 0 ? text : text.replace("|", "");
    return completeWatch(src, at < 0 ? src.length : at, shape).map((c) => c.label);
}
/** The text after taking the completion labelled `label`, as the input does. */
function take(text, label) {
    const c = completeWatch(text, text.length, SHAPE).find((x) => x.label === label);
    return text.slice(0, c.from) + c.insert;
}

// --- after a dot: the keys of what the chain names, then the dialect's methods on its kind ---

test("after `chain.`, the keys of the object it names, in the tree's order, each with what it holds", () => {
    assert.deepEqual(labels("inspector."), ["run", "session"]);
    assert.deepEqual(labels("inspector.run."), ["init", "odd key"]);
    const init = completeWatch("inspector.run.init.", 19, SHAPE);
    assert.deepEqual(init.map((c) => [c.label, c.detail]), [["task", "string"], ["tools", "[2]"]]);
    assert.deepEqual(labels("ml.current."), ["messages", "run"]);
});

test("a partial name narrows the list, and the caret may be mid-line", () => {
    assert.deepEqual(labels("inspector.se"), ["session"]);
    assert.deepEqual(labels("inspector.run.init.t"), ["task", "tools"]);
    assert.deepEqual(labels("inspector.se| + 1"), ["session"]);
    assert.deepEqual(labels("inspector.x"), []);
});

test("an array: `length` and the dialect's read methods; indexes reach its first element's keys", () => {
    const l = labels("inspector.run.init.tools.");
    assert.equal(l[0], "length");
    for (const m of ["map", "filter", "join", "includes", "at"]) assert.ok(l.includes(m), m);
    assert.deepEqual(labels("ml.current.messages[0]."), ["role", "text"]);
    assert.deepEqual(labels("inspector.run.init.task.len"), ["length"]);
    assert.ok(labels("inspector.run.init.task.").includes("toUpperCase"));
});

test("a key that is not a name is offered in brackets, replacing the dot", () => {
    assert.equal(take("inspector.run.od", "odd key"), `inspector.run["odd key"]`);
    assert.deepEqual(labels(`inspector.run["odd key"].`), ["toFixed", "toPrecision", "toLocaleString"], "and the chain goes on through it: a number's methods");
});

// --- the dialect's own lists, never more ---

test("ADVERSARIAL: no mutator is ever offered, on any kind, since what a completion names is state the script did not build", () => {
    for (const kind of ["array", "string", "number", "set", "map", "Math", "JSON", "ObjectCtor", "ArrayCtor"])
        for (const m of offeredMethods(kind)) assert.ok(!MUTATING_METHODS.has(m), `${kind}.${m}`);
    for (const m of ["push", "pop", "splice", "sort", "reverse", "fill", "shift", "unshift"])
        assert.ok(!labels("inspector.run.init.tools.").includes(m), m);
    assert.deepEqual(offeredMethods("nonsense"), []);
    assert.deepEqual(offeredMethods("constructor"), [], "a name on Object.prototype is no kind");
});

test("the namespaces offer their statics as the dialect allows them; an unknown receiver offers nothing", () => {
    assert.deepEqual(labels("Object."), ["keys", "values", "entries", "fromEntries", "assign"], "assign writes only into a target the script built");
    assert.ok(labels("Math.").includes("max"));
    assert.deepEqual(labels("JSON."), ["stringify", "parse"]);
    assert.deepEqual(labels("document."), [], "the page is not a watch's");
    assert.deepEqual(labels("inspector.list.filter(t => t."), [], "a callback's parameter has no known shape");
    assert.deepEqual(labels("f(x)."), []);
});

// --- at a bare name: the roots ---

test("a bare name offers the roots a watch starts from, then the callable names", () => {
    assert.deepEqual(labels("in"), ["inspector"]);
    assert.deepEqual(labels("m"), ["ml"]);
    assert.ok(labels("M").includes("Math"));
    assert.deepEqual(labels("1 + par"), ["parseInt", "parseFloat"]);
    assert.deepEqual(labels("inspector"), [], "a name typed in full is not offered back");
    assert.deepEqual(labels(""), []);
});

test("between turns there is no ml.current, so `ml` is not offered and `ml.` completes nothing", () => {
    const idle = treeShape({ inspector: TREE.inspector });
    assert.deepEqual(labels("m", idle), []);
    assert.deepEqual(labels("ml.", idle), []);
    assert.deepEqual(completeWatch("inspector.", 10, undefined), [], "before the first read there is no shape at all");
});

test("JSONPath: `$.` completes over the whole tree", () => {
    assert.deepEqual(labels("$."), ["ml", "inspector"]);
    assert.deepEqual(labels("$.inspector.run.init."), ["task", "tools"]);
});

test("inside a string literal nothing completes", () => {
    assert.deepEqual(labels(`inspector.run.init.task === "inspector.`), []);
    assert.deepEqual(labels(`inspector.run.init.task === "a" && inspector.`), ["run", "session"]);
});

// --- the shape a panel is sent: keys and kinds, bounded ---

test("the shape holds keys and kinds, never a value", () => {
    assert.doesNotMatch(JSON.stringify(SHAPE), /count|exec|look|"hi"/);
    assert.deepEqual(treeShape([]), { t: "array", n: 0 });
    assert.deepEqual(treeShape(null), { t: "null" });
});

test("HALTING: a huge or deep tree is described within bounds, and the list is capped", () => {
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, { a: i }]));
    const s = treeShape({ inspector: wide });
    assert.equal(Object.keys(s.keys.inspector.keys).length, 100);
    assert.equal(s.keys.inspector.more, 4900);
    assert.equal(completeWatch("inspector.k", 11, s).length, MAX_COMPLETIONS);
    let deep = {};
    const top = deep;
    for (let i = 0; i < 10_000; i++) deep = deep.d = {};
    let depth = 0;
    for (let at = treeShape(top); at?.keys?.d; at = at.keys.d) depth++;
    assert.ok(depth <= 10, `described ${depth} levels`);
    const many = Array.from({ length: 200 }, () => Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, { x: { y: 1 } }])));
    assert.ok(JSON.stringify(treeShape({ a: many, b: many, c: many })).length < 400_000, "the node budget holds");
});
