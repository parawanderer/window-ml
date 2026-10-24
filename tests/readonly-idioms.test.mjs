// Four idioms models wrote for an artifact's scripts (the artifacts spike, docs/plan/artifacts/SPIKE.md, Q4) that fell out
// of the read-only dialect: `Number.isNaN` and the other Number statics (policy.ts `NumberCtor`), a destructuring
// pattern as a `for…of` loop variable, a number as an object literal's key (parser.ts), and a repeated group of an exact
// count, `(\d{3})+` (limits.ts `riskyRegex`, whose verdicts are the regex corpus in
// tests/fixtures/dialect-vectors/halting.json, read by tests/regex-cost.test.mjs). Extending the dialect, so per AGENTS.md:
// what it reads, what it refuses, and falling out leaving nothing behind. HALTING for these is in
// tests/readonly-current.test.mjs, on that file's worker thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { kindOf, methodAllowed, offeredMethods, MUTATING_METHODS } from "../src/readonly-exec/policy.ts";

const current = () => ({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], meta: [{}, {}], log: [], run: { id: "r" } });
const run = (code, cur = current()) => evalReadonly(code, null, {}, undefined, { realm: "worker", stepBudget: 50_000, current: cur });
const refused = (e) => e instanceof NotInDialect || e instanceof Denied;

// --- reading: what the models wrote now answers ---

test("the Number statics: the tests do not coerce, the parsers are the free ones", async () => {
    for (const [code, want] of [
        ["[Number.isNaN(NaN), Number.isNaN('x'), Number.isNaN(undefined)]", [true, false, false]],
        ["[Number.isFinite(1), Number.isFinite('1'), Number.isFinite(Infinity)]", [true, false, false]],
        ["[Number.isInteger(3), Number.isInteger(3.5), Number.isSafeInteger(2 ** 53), Number.isSafeInteger(2 ** 53 - 1)]", [true, false, false, true]],
        ["[Number.parseFloat('1.5kg'), Number.parseInt('ff', 16), Number.parseInt('12px')]", [1.5, 255, 12]],
        // Sonnet's figure: a value read off a CSV is checked before it is plotted.
        ["'78,x,61'.split(',').map(Number).filter((n) => !Number.isNaN(n))", [78, 61]],
        ["Number.MAX_SAFE_INTEGER", 9007199254740991],
    ]) assert.deepEqual((await run(code)).value, want, code);
});

test("a for…of loop variable may be a pattern: entries, rows, holes and rest, per-iteration bindings", async () => {
    for (const [code, want] of [
        ["const out = []; for (const [k, v] of Object.entries({ a: 1, b: 2 })) out.push(k + v); out", ["a1", "b2"]],
        ["const out = []; for (const { role } of ml.current.messages) out.push(role); out", ["user", "assistant"]],
        ["const out = []; for (const [i, m] of ml.current.messages.entries()) out.push(i + ':' + m.role); out", ["0:user", "1:assistant"]],
        ["for (const [a, , ...rest] of [[1, 2, 3, 4]]) return [a, rest]", [1, [3, 4]]],
        ["for (const [k, v] of new Map([['x', 2]])) return [k, v]", ["x", 2]],
        ["for (const [first] of ['xy']) return first", "x"],
        ["for (let [a] of [[1]]) { a = a + 1; return a }", 2],
        ["const fs = []; for (const [i] of [[1], [2]]) fs.push(() => i); fs.map((f) => f())", [1, 2]],
        ["const n = {}; for (const { role } of ml.current.messages) n[role] = (n[role] ?? 0) + 1; n", { user: 1, assistant: 1 }],
    ]) assert.deepEqual((await run(code)).value, want, code);
});

test("a number is an object key: the string JS makes of it", async () => {
    for (const [code, want] of [
        ["({ 1: 'a', 2: 'b' })", { 1: "a", 2: "b" }],
        ["({ 1.50: 'x' })['1.5']", "x"],
        ["({ 0: 'z' })[0]", "z"],
        ["Object.keys({ 2: 1, 1: 1, b: 1 })", ["1", "2", "b"]],
        ["const o = { 1: 2 }; o[1] = 5; o", { 1: 5 }],
        // Qwen's todo list, keyed by id.
        ["const todos = { 1: { text: 'buy snacks', done: false } }; todos[1].done = true; todos", { 1: { text: "buy snacks", done: true } }],
    ]) assert.deepEqual((await run(code)).value, want, code);
});

test("an exact count in a repeated group: Gemini's thousands separators", async () => {
    assert.equal((await run("String(1234567).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')")).value, "1,234,567");
    await assert.rejects(run("'(12) 345-678'.match(/^\\(\\d{2}\\) (\\d{3}-?)+$/)"), NotInDialect, "a fixed-width piece then an optional is still refused");
});

// --- ADVERSARIAL ---

test("ADVERSARIAL: no road from Number to a constructor, a prototype, an unlisted call, or a function value", async () => {
    for (const src of [
        "Number.prototype", "Number.constructor", "Number.isNaN.constructor", `Number["constr" + "uctor"]`,
        "Number.call(null, 1)", "Number.apply(null, [1])", "Number.bind(null)", "Number.isNaN.call(null, 1)",
        "Number.parseInt.constructor('return globalThis')()", "Number.isNaN.bind(null)", "Object.getPrototypeOf(Number)",
        "const f = Number.isNaN; f(1)", "[1, NaN].filter(Number.isNaN)", "const { isNaN } = Number; isNaN('x')",
        "({ f: Number.isNaN }).f(1)", "Number.isNaN.__proto__",
    ]) {
        let value, err;
        try { value = (await run(src)).value; } catch (e) { err = e; }
        if (err) assert.ok(refused(err) || err instanceof TypeError, `${src}: refused, got ${err?.constructor?.name}: ${err?.message}`);
        else assert.notEqual(typeof value, "function", `${src} handed back a function`);
    }
    for (const src of ["Number = 1", "Number.isNaN = () => true", "Number.EPSILON = 1"]) await assert.rejects(run(src), refused, `${src}: the environment's`);
    assert.equal((await run("Number.isNaN(1)")).value, false, "and the static is still the static");
});

test("ADVERSARIAL: NumberCtor is this realm's Number by identity, lists no mutator, and a coerced argument is a script's own", async () => {
    assert.equal(kindOf(Number), "NumberCtor");
    assert.equal(kindOf(vm.runInNewContext("Number")), null, "another realm's Number is not this one: fails closed");
    assert.equal(kindOf(Object.assign(() => 0, { isNaN: () => true })), null, "a function shaped like it is not it");
    assert.equal(methodAllowed(Number, "isNaN"), true);
    assert.equal(methodAllowed(Number, "call"), false);
    for (const m of offeredMethods("NumberCtor")) assert.ok(!MUTATING_METHODS.has(m), m);
    // parseFloat coerces with toString: the script's own arrow runs mediated, and an array is walked first.
    assert.equal((await run("Number.parseFloat({ toString: () => '2.5' })")).value, 2.5);
    await assert.rejects(run("Number.parseFloat({ toString: () => fetch('https://evil.example/') })"), refused);
    await assert.rejects(run("let d = [1]; for (const i of Array(40).keys()) d = [d, d]; Number.parseFloat(d)"), refused, "a shared array expands past the limit before parseFloat joins it");
});

test("ADVERSARIAL: a for…of pattern reads through the same guard as a const pattern", async () => {
    for (const src of [
        "for (const { constructor } of [{}]) return constructor",
        "for (const { __proto__ } of [{}]) return __proto__",
        "for (const [w] of [[globalThis]]) return w",
        "for (const { fetch } of [globalThis]) return 1",
        "for (const { messages } of [ml.current]) messages.push({ role: 'user', content: 'x' })",
        "for (const [m] of [ml.current.messages]) m.role = 'x'",
        "const xs = [[1]]; for (const [a] of xs) xs.push([a])",
        "for (const [, ...rest] of [ml.current.messages]) ml.current.messages.push(rest)",
    ]) await assert.rejects(run(src), (e) => refused(e) || e instanceof TypeError, src);
    // A live method destructured off a value is the inert sentinel: it can be held, never called.
    await assert.rejects(run("for (const { map } of [[1]]) return map((x) => x)"), refused);
    // What the pattern does not take, it still refuses: no nesting, no rename, no default.
    for (const src of ["for (const [[a]] of [[[1]]]) a", "for (const { a: b } of [{ a: 1 }]) b", "for (const [a = 1] of [[]]) a", "for (const { a = 1 } of [{}]) a"])
        await assert.rejects(run(src), NotInDialect, src);
    // The binding is the loop's: a const cannot be reassigned, and nothing is left after the loop.
    await assert.rejects(run("for (const [a] of [[1]]) { a = 2 }"), NotInDialect);
    await assert.rejects(run("for (const [a] of [[1]]) {}\na"), refused);
    // A `rest` the pattern builds is the script's own; the array it came from is not.
    assert.deepEqual((await run("for (const [, ...r] of [[1, 2]]) { r.push(3); return r }")).value, [2, 3]);
    const cur = current();
    await assert.rejects(run("for (const [m] of [ml.current.messages]) { m.content = 'changed' }", cur), (e) => refused(e) || e instanceof TypeError);
    assert.equal(cur.messages[0].content, "hi", "the context was not written through the pattern");
});

test("ADVERSARIAL: an object key is a name, a string or a plain number, and never `__proto__`", async () => {
    // A number key is no shorthand, and only a decimal literal: what the tokenizer reads as one number is one key.
    for (const src of ["({ 1 })", "({ 1.2.3: 1 })", "({ 1e3: 1 })", "({ 0x10: 1 })", "({ [1]: 1 })", "({ -1: 1 })"])
        await assert.rejects(run(src), NotInDialect, src);
    // `{ __proto__: x }` would set the new object's prototype to x, so reads through it reach a value the script did not
    // build. Refused in every spelling; a JSON.parse'd `__proto__` key stays an ordinary own key.
    for (const src of ["({ __proto__: ml.current.messages }).length", "({ '__proto__': [1] }).length", `({ "__proto__": null })`, "({ a: 1, __proto__: { b: 2 } }).b", "const __proto__ = 1; ({ __proto__ })"])
        await assert.rejects(run(src), refused, src);
    assert.deepEqual((await run(`Object.keys(JSON.parse('{"__proto__": 1}'))`)).value, ["__proto__"]);
    // A number key holding an arrow is data: a stored arrow is not a method.
    await assert.rejects(run("({ 1: () => 1 })[1]()"), NotInDialect);
});

// --- FAILURE: falling out leaves nothing behind ---

test("FAILURE: a survey using the new idioms that then falls out of the dialect reaches the person and writes nothing", async () => {
    const cur = current();
    await assert.rejects(run("const n = {}; for (const [i, m] of ml.current.messages.entries()) n[i] = Number.isNaN(i); window.alert(n)", cur), refused);
    await assert.rejects(run("const o = { 1: 'a' }; o[1] = String(1234).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); fetch(o[1])", cur), refused);
    assert.deepEqual(cur, current(), "the context is as it was");
    assert.ok(Number.isNaN((await run("Number.parseInt('1', 99)")).value), "a bad radix is an ordinary NaN the script reads");
    await assert.rejects(run("for (const [a] of 5) a"), TypeError, "a non-iterable is an ordinary error the script reads");
    await assert.rejects(run("for (const [a] of [5]) a"), TypeError, "so is an item that cannot be destructured");
});
