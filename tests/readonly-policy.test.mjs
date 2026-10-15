// readonly-policy.test.mjs — the dialect's POLICY realm (src/readonly-exec/policy-realm.ts, docs/spec/POLICIES.md, "The
// policy realm"): what a policy cannot reach, the `c` facade that refuses a field it does not have, `==` refused, every
// failure is no opinion with a reason (fails CLOSED), halting in a worker with a timeout, and the facts left untouched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

const { evalPolicy, evalReadonly, POLICY_STEPS } = await import("../src/readonly-exec.ts");

const FACTS = Object.freeze({
    kind: "fetch", url: "https://a.example/x", argv: ["git", "status"],
    paths: [{ path: "/r/a", inRoot: true, secret: false }],
    effects: [{ op: "read", res: { kind: "net", host: "a.example" } }, { op: "read", res: { kind: "fs", path: "/r/a", inRoot: true, secret: false } }],
});
const run = (src, facts = FACTS, effect) => evalPolicy(src, facts, effect);
/** The policy must be BROKEN (no opinion, with a reason), never an answer. */
function broken(src, why, facts = FACTS) {
    const r = run(src, facts);
    assert.equal(r.decision, undefined, `${why}: must not decide`);
    assert.ok(r.broken, `${why}: must be marked broken, got ${JSON.stringify(r)}`);
    return r.broken;
}

// --- what a policy answers ---

test("a policy that holds answers its effect; one that does not is no opinion, not broken", () => {
    assert.deepEqual(run('(c) => c.kind === "fetch" && c.url === "https://a.example/x"'), { decision: "allow" });
    assert.deepEqual(run('(c) => c.url === "https://a.example/x"', FACTS, "deny"), { decision: "deny" });
    assert.deepEqual(run('(c) => c.url === "https://b.example/"'), { decision: undefined });
});

test("helpers declared before the function are in scope, and the function is the program's value", () => {
    assert.deepEqual(run('const READ = ["status", "log", "diff"];\n(c) => c.argv[0] === "git" && READ.includes(c.argv[1])'), { decision: "allow" });
});

test("a result that is not a boolean is broken, so a truthy number never reads as a grant", () => {
    assert.match(broken("(c) => c.paths.length", "a number"), /returned number/);
    assert.match(broken('(c) => c.url', "a string"), /returned string/);
    assert.match(broken("(c) => undefined", "undefined"), /returned undefined/);
    assert.match(broken("(c) => null", "null"), /returned null/);
    assert.match(broken('(c) => c.paths.length && c.paths[0].inRoot', "an && chain on an empty list", { ...FACTS, paths: [] }), /returned number/);
});

test("a script that is not a function, or does not parse, is broken", () => {
    assert.match(broken("1 + 1", "a value, not a function"), /function of the call/);
    assert.match(broken('(c) => c.kind === "fetch" &&', "a parse error"), /not allowed in a policy/);
    assert.match(broken("", "empty"), /function of the call/);
});

// --- the c facade refuses a field it does not have ---

test("a typo'd field is broken, never undefined-and-silent: top level, nested, and on an array", () => {
    assert.match(broken('(c) => c.kidn === "fetch"', "top level"), /no field 'kidn'/);
    assert.match(broken("(c) => c.paths[0].inroot === true", "inside a path"), /no field 'inroot'/);
    assert.match(broken("(c) => c.argv.lenght > 0", "a non-index key of an array"), /no field 'lenght'/);
    assert.match(broken('(c) => c.effects.hass("write")', "a helper of the effect set"), /no field 'hass'/);
    assert.match(broken("(c) => c.effects.reads[0].inroot", "inside a resource"), /no field 'inroot'/);
});

test("a typo'd DENY is broken too, which is the case the rule exists for: it would otherwise never fire", () => {
    assert.match(broken('(c) => c.arg[0] === "rm"', "deny on c.arg"), /no field 'arg'/);
});

test("an alias, a destructuring, optional chaining and a computed key are refused the same way", () => {
    assert.match(broken("(c) => { const x = c; return x.argv0 === 1; }", "an alias"), /no field 'argv0'/);
    assert.match(broken("(c) => { const { argv0 } = c; return !!argv0; }", "a destructuring"), /no field 'argv0'/);
    assert.match(broken("(c) => c?.argv0 === undefined", "optional chaining"), /no field 'argv0'/);
    assert.match(broken('(c) => c["ar" + "gv0"] === undefined', "a computed key"), /no field 'argv0'/);
    assert.match(broken("(c) => ((x) => x.urll)(c) === 1", "through an arrow's parameter"), /no field 'urll'/);
    assert.match(broken("(c) => [c].map(x => x.urll)[0] === 1", "through a host callback"), /no field 'urll'/);
});

test("an index past the end of an array reads undefined, as an argv test needs", () => {
    assert.deepEqual(run('(c) => c.argv[5] === undefined && c.argv[1] === "status"'), { decision: "allow" });
});

test("reading off undefined is a TypeError, as in JavaScript; optional chaining is the way to ask", () => {
    assert.match(broken("(c) => c.argv[9].length > 0", "a read off a missing argument"), /TypeError: Cannot read properties of undefined/);
    assert.deepEqual(run("(c) => c.argv[9]?.length === undefined"), { decision: "allow" });
});

test("a copy the script makes is its own object and reads an absent field as JavaScript does (documented)", () => {
    assert.deepEqual(run("(c) => ({ ...c }).argv0 === undefined"), { decision: "allow" });
});

test("a resource's fields of another kind read undefined, so a policy over mixed reads is false, not broken", () => {
    assert.deepEqual(run("(c) => c.effects.reads.every((r) => r.inRoot === true)"), { decision: undefined }, "the net read has no inRoot");
    assert.deepEqual(run('(c) => c.effects.reads.some((r) => r.host === "a.example")'), { decision: "allow" });
});

test("the effect set's helpers are callable; nothing else on c is", () => {
    assert.deepEqual(run('(c) => c.effects.has("read", "net") && !c.effects.has("write") && !c.effects.uses("github")'), { decision: "allow" });
    assert.match(broken("(c) => { const h = c.effects.has; return h(\"read\"); }", "a helper lifted off as a value"), /cannot be called indirectly|not allowed/);
    assert.match(broken('(c) => c.effects.has.call(null, "read")', "a helper's .call"), /not allowed/);
    assert.match(broken('(c) => c.url.big() === ""', "a method the string kind withholds"), /.+/);
});

test("on an undescribed call every effect question answers in the direction that asks", () => {
    const facts = { ...FACTS, effects: "unknown" };
    assert.deepEqual(run('(c) => !c.effects.has("write")', facts), { decision: undefined });
    assert.deepEqual(run("(c) => c.effects.reads.every((r) => r.inRoot === true)", facts), { decision: undefined });
    assert.deepEqual(run("(c) => c.effects.unknown", facts, "deny"), { decision: "deny" });
    assert.deepEqual(run('(c) => c.effects.pairs.every((e) => e.op === "read")', facts), { decision: undefined }, "pairs carry the top element too");
    assert.deepEqual(run("(c) => c.effects.pairs.length === 0", facts), { decision: undefined });
});

test("a question about an operation or kind the algebra does not have is broken, not a quiet false", () => {
    assert.match(broken('(c) => !c.effects.has("wirte")', "a misspelt operation"), /no operation 'wirte'/);
    assert.match(broken('(c) => !c.effects.has("write", "files")', "a misspelt kind"), /no resource kind 'files'/);
    assert.match(broken("(c) => !c.effects.uses(1)", "a secret name that is not a string"), /secret's name/);
    assert.match(broken('(c) => !c.effects.has("wirte")', "on an undescribed call too", { ...FACTS, effects: "unknown" }), /no operation/);
});

test("a typo on a string is refused; its length, indices and methods are not", () => {
    assert.match(broken("(c) => c.url.lenght > 0", "a string's typo"), /string has no field 'lenght'/);
    assert.deepEqual(run('(c) => c.url.length > 0 && c.url[0] === "h" && c.url.startsWith("https:")'), { decision: "allow" });
});

// --- == and != are refused here, and only here ---

test("== and != are refused in a policy, wherever they appear", () => {
    assert.match(broken('(c) => c.kind == "fetch"', "=="), /== coerces; compare with ===/);
    assert.match(broken('(c) => c.kind != "x"', "!="), /!= coerces; compare with !==/);
    assert.match(broken('(c) => c.argv.some((a) => a == "git")', "inside a callback"), /==/);
    assert.match(broken('(c) => c.kind === "fetch" || c.kind == "x"', "on a branch that is not reached first"), /==/, "the left side is true, so the right is never evaluated...");
});

test("an ordering between a string and a number is refused in a policy, as == is", () => {
    assert.match(broken('(c) => c.argv.length < "10"', "number < string"), /between a number and a string coerces/);
    assert.deepEqual(run('(c) => c.argv.length < 10 && "a" < "b"'), { decision: "allow" });
});

test("=== and !== are fine in a policy, and == stays accepted in a survey", async () => {
    assert.deepEqual(run('(c) => c.kind !== "x" && c.argv[0] === "git"'), { decision: "allow" });
    assert.equal((await evalReadonly('1 == "1"', null)).value, true);
    assert.equal((await evalReadonly('1 != "1"', null, undefined, undefined, { realm: "worker" })).value, false);
});

// --- what a policy cannot reach ---

test("no ml, no document, no window, no console, no clock, no Promise", () => {
    for (const [src, why] of [
        ["(c) => !!ml", "ml"], ["(c) => !!document", "document"], ["(c) => !!window", "window"], ["(c) => !!globalThis", "globalThis"],
        ['(c) => { console.log("x"); return true; }', "console"], ["(c) => Date.now() > 0", "Date"], ["(c) => new Date() > 0", "new Date"],
        ["(c) => !!Promise", "Promise"], ["(c) => !!getComputedStyle", "getComputedStyle"], ["(c) => !!Function", "Function"],
        ["(c) => !!fetch", "fetch"], ["(c) => !!self", "self"],
    ]) broken(src, why);
});

test("constructor, __proto__ and prototype are denied on c, on its parts and through every binding form", () => {
    for (const [src, why] of [
        ["(c) => !!c.constructor", "c.constructor"], ["(c) => !!c.__proto__", "c.__proto__"],
        ["(c) => !!c.argv.constructor", "an array's constructor"], ['(c) => !!c["constr" + "uctor"]', "a computed constructor"],
        ["(c) => !!c.url.constructor", "a string's constructor"], ["(c) => !!c.effects.has.constructor", "a helper's constructor"],
        ["(c) => { const { constructor } = c.argv; return !!constructor; }", "a destructured constructor"],
        ["(c) => !!c.paths[0].__proto__", "a nested __proto__"], ["(c) => !!c.argv.prototype", "prototype"],
    ]) broken(src, why);
});

test("a realm cannot be reached through a callback", () => {
    for (const [src, why] of [
        ["(c) => c.argv.map((x) => x.constructor).length > 0", "constructor inside map"],
        ["(c) => c.argv.map((x) => Object.getPrototypeOf(x)).length > 0", "getPrototypeOf inside map"],
        ["(c) => c.argv.some(function () { return this; })", "this in a function expression"],
        ["(c) => c.argv.map(c.effects.has).length > 0", "a helper handed to a host method"],
        ['(c) => c.argv.sort((a, b) => a.constructor.constructor("return 1")()) && true', "Function through a comparator"],
        ['(c) => JSON.parse("{}", (k, v) => v.constructor) && true', "a reviver"],
    ]) broken(src, why);
});

test("a policy cannot write c, its arrays or its parts", () => {
    for (const [src, why] of [
        ['(c) => { c.kind = "x"; return true; }', "assign to c"],
        ['(c) => { c.argv.push("x"); return true; }', "push to c.argv"],
        ['(c) => { c.argv[0] = "x"; return true; }', "assign into c.argv"],
        ['(c) => { c.paths[0].inRoot = false; return true; }', "assign into a path"],
        ['(c) => { c.argv.sort(); return true; }', "sort c.argv in place"],
        ['(c) => { Object.assign(c, { kind: "x" }); return true; }', "Object.assign onto c"],
        ['(c) => { c = 1; return true; }', "rebind the parameter... is allowed, but"],
    ]) {
        const r = run(src);
        if (why.startsWith("rebind")) { assert.deepEqual(r, { decision: "allow" }, "a parameter is the script's own binding"); continue; }
        assert.equal(r.decision, undefined, why);
        assert.ok(r.broken, why);
    }
});

test("a policy cannot write the host's builtins, which every later evaluation and the host itself share", () => {
    for (const src of [
        "(c) => { Object.assign(Math, { pwned: 1 }); return true; }",
        '(c) => { Object.assign(JSON, { stringify: (x) => "PWN" }); return true; }',
        "(c) => { Object.assign(Array, { isArray: (x) => false }); return true; }",
    ]) broken(src, src);
    assert.equal(Math.pwned, undefined);
    assert.equal(JSON.stringify({ a: 1 }), '{"a":1}');
    assert.equal(Array.isArray([]), true);
    assert.deepEqual(run("(c) => Math.pwned === undefined"), { decision: "allow" });
});

test("a regex that could backtrack without end is refused, as in a survey; a safe one runs", () => {
    assert.match(broken("(c) => /(a+)+$/.test(c.url)", "a literal"), /backtrack/);
    assert.match(broken('(c) => new RegExp("(\\\\w+\\\\s?)*$").test(c.url)', "new RegExp"), /backtrack/);
    assert.match(broken('(c) => c.url.match("(a|a)+") !== null', "a string pattern"), /backtrack/);
    assert.deepEqual(run("(c) => /^https:\\/\\/a\\.example\\//.test(c.url)"), { decision: "allow" });
});

// --- a broken policy fails CLOSED ---

test("a throwing policy is no opinion, with the error as the reason", () => {
    assert.match(broken("(c) => c.argv[9].length > 0", "reading off undefined"), /TypeError/);
    assert.match(broken('(c) => JSON.parse("{") && true', "a JSON error"), /SyntaxError/);
    assert.match(broken('(c) => { throw new Error("no"); }', "a throw statement"), /.+/);
});

test("a throwing DENY is no opinion too: the call then asks, it is never silently allowed", () => {
    const r = run('(c) => c.argv[9].length > 0', FACTS, "deny");
    assert.equal(r.decision, undefined);
    assert.ok(r.broken);
});

test("try/catch inside a policy cannot swallow a refusal", () => {
    assert.match(broken("(c) => { try { return c.kidn === 1; } catch (e) { return true; } }", "a typo inside try"), /no field 'kidn'/);
    assert.match(broken('(c) => { try { return c.kind == "fetch"; } catch (e) { return true; } }', "== inside try"), /==/);
});

// --- the facts are left untouched ---

test("FAILURE: a refused policy leaves the facts exactly as they were, and the next evaluation sees them unchanged", () => {
    const facts = structuredClone({ ...FACTS });
    const before = structuredClone(facts);
    for (const src of [
        '(c) => { c.argv.push("x"); return true; }', '(c) => { c.kind = "x"; return true; }',
        '(c) => { const a = c.argv; a[0] = "rm"; return true; }', "(c) => { c.paths[0].inRoot = false; return c.kidn; }",
        '(c) => { Object.assign(c.paths[0], { secret: true }); return true; }',
    ]) {
        assert.ok(evalPolicy(src, facts).broken, src);
        assert.deepEqual(facts, before, `facts changed by: ${src}`);
    }
    assert.deepEqual(run('(c) => c.argv[0] === "git" && c.kind === "fetch" && c.paths[0].inRoot === true', facts), { decision: "allow" });
    assert.equal(Object.isFrozen(facts.argv), false, "the caller's objects are copied, never frozen in place");
});

test("FAILURE: what one evaluation builds is gone by the next, though the parse is shared", () => {
    const src = 'const seen = [];\n(c) => { seen.push(c.url); return seen.length === 1; }';
    assert.deepEqual(run(src), { decision: "allow" });
    assert.deepEqual(run(src), { decision: "allow" }, "a fresh scope per evaluation: `seen` starts empty again");
});

test("facts that are not data are refused before the policy runs", () => {
    assert.match(evalPolicy("(c) => true", { f: () => 1 }).broken, /data/);
    assert.match(evalPolicy("(c) => true", { d: new Date(0) }).broken, /plain objects/);
});

test("a parse error is cached and broken every time, with the same reason", () => {
    const a = run("(c) => (", FACTS), b = run("(c) => (", FACTS);
    assert.ok(a.broken);
    assert.equal(a.broken, b.broken);
});

// --- halting: every policy ends, in a worker with a timeout ---

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return import(workerData.url); });
        parentPort.on("message", ({ id, src, facts }) => ready
            .then(({ evalPolicy }) => parentPort.postMessage({ id, r: evalPolicy(src, facts) }),
                  (e) => parentPort.postMessage({ id, r: { threw: String(e) } })));`,
        { eval: true, workerData: { url: RO_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API } });
    worker.on("message", ({ id, r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());
/** Evaluate in a worker; `{ hung: true }` when it is still running after `ms`. */
function inWorker(src, facts, ms = 5000) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, facts });
    });
}
const BIG = { ...FACTS, effects: undefined, argv: Array.from({ length: 5000 }, (_, i) => `a${i}`) };
delete BIG.effects;

test("HALTING: a loop over c.argv is allowed and bounded by the argv", async () => {
    const r = await inWorker('(c) => { let n = 0; for (const a of c.argv) n += a.length; return n > 0; }', BIG);
    assert.deepEqual(r, { decision: "allow" });
});

test("HALTING: a loop the budget cannot afford is broken, not hung", async () => {
    const r = await inWorker("(c) => c.argv.every((a) => c.argv.every((b) => a !== b || a === b))", BIG);
    assert.ok(!r.hung, "still running after 5 s");
    assert.equal(r.decision, undefined);
    assert.match(r.broken, /budget|steps|too much/i);
});

test("HALTING: recursion past the call depth is refused, directly and mutually", async () => {
    for (const src of [
        "(c) => { const f = (n) => f(n + 1); return f(0); }",
        "(c) => { const g = (n) => h(n); const h = (n) => g(n + 1); return g(0); }",
        "(c) => { const f = (n) => [n].map((x) => f(x + 1))[0]; return f(0) === 1; }",
    ]) {
        const r = await inWorker(src, FACTS);
        assert.ok(!r.hung, `${src}: still running`);
        assert.equal(r.decision, undefined, src);
        assert.match(r.broken, /nested more than|budget/, src);
    }
});

test("HALTING: a string doubled in a loop and an exponential recursion are stopped by size or budget", async () => {
    for (const src of [
        '(c) => { let s = "ab"; for (const a of c.argv) s = s + s; return s.length > 0; }',
        "(c) => { const f = (n) => n === 0 ? 1 : f(n - 1) + f(n - 1); return f(40) > 0; }",
        '(c) => { const a = []; for (const x of c.argv) for (const y of c.argv) a.push(x + y); return a.length > 0; }',
    ]) {
        const r = await inWorker(src, BIG);
        assert.ok(!r.hung, `${src}: still running after 5 s`);
        assert.equal(r.decision, undefined, src);
        assert.ok(r.broken, src);
    }
});

test("HALTING: a backtracking regex never reaches the engine", async () => {
    const r = await inWorker("(c) => /(a+)+b/.test(c.url)", { ...FACTS, effects: undefined, url: "a".repeat(40) });
    assert.ok(!r.hung);
    assert.match(r.broken, /backtrack/);
});

test("the policy budget is a fraction of a survey's", () => {
    assert.ok(POLICY_STEPS <= 100_000);
});
