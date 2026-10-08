// Caller-bound data in the read-only dialect (`evalReadonly`'s `globals`, src/readonly-exec.ts): the name a watch reads the
// run's state under (`inspector`). Extending the dialect's environment, so per AGENTS.md: adversarial tests that try to
// get out through the new name, HALTING tests in a worker with a timeout, and FAILURE tests that a script leaves the
// caller's data as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalReadonly, NotInDialect, Denied, NeedsPage } from "../src/readonly-exec.ts";

const data = () => ({ run: { init: { task: "count the widgets", tools: ["exec", "look"] }, log: [{ kind: "pinned" }] }, n: 3, list: [1, 2, 3] });
const run = (code, globals = { inspector: data() }, realm = "worker") => evalReadonly(code, null, {}, undefined, { realm, globals, stepBudget: 50_000 });
const refused = (e) => e instanceof NotInDialect || e instanceof Denied;

// --- reading: a watch is an expression over the bound data ---

test("the bound name reads like any data: paths, methods on arrays, arithmetic", async () => {
    assert.equal((await run("inspector.run.init.task")).value, "count the widgets");
    assert.deepEqual((await run("inspector.run.init.tools.filter(t => t !== 'look')")).value, ["exec"]);
    assert.equal((await run("inspector.list.reduce((a, b) => a + b, 0) * inspector.n")).value, 18);
    assert.equal((await run(`inspector["run"].log.length`)).value, 1);
    assert.equal((await run("inspector.run.nope")).value, undefined, "a missing member is undefined, as in JavaScript");
});

// --- ADVERSARIAL: the new name is a way in only to its own data ---

test("ADVERSARIAL: no road from the bound data to a constructor, a prototype or the realm", async () => {
    for (const src of [
        "inspector.constructor", "inspector.__proto__", `inspector["__pro" + "to__"]`, `inspector["constr" + "uctor"]`,
        "inspector.run.init.tools.constructor", "inspector.list.map.constructor", "inspector.run.init.task.constructor",
        `inspector.constructor.constructor("return globalThis")()`, "Object.getPrototypeOf(inspector).constructor",
        "inspector.toString.call(inspector).constructor", "inspector.valueOf().constructor", "({}).constructor",
        `inspector.list.map.call(inspector.list, x => x).constructor`, "inspector.globalThis", "inspector.window",
    ]) {
        let value, err;
        try { value = (await run(src)).value; } catch (e) { err = e; }
        if (err) assert.ok(refused(err) || err instanceof TypeError, `${src}: refused, got ${err?.constructor?.name}: ${err?.message}`);
        else {
            assert.notEqual(typeof value, "function", `${src} handed back a function`);
            assert.notEqual(value, globalThis, `${src} reached the realm`);
            assert.ok(value === undefined || typeof value !== "object" || Object.getPrototypeOf(value) !== Function.prototype, src);
        }
    }
});

test("ADVERSARIAL: a caller cannot bind over the environment, and no callable can be bound at all", async () => {
    const r = await run(`[typeof ml, Math.max(1, 2), typeof JSON.parse, typeof console.log]`,
        { inspector: data(), ml: { evil: true }, Math: { max: () => "hijacked" }, JSON: 1, console: 2, constructor: 3, "not-an-id": 4 });
    assert.deepEqual(r.value, ["object", 2, "function", "function"], "the environment's names are its own");
    await assert.rejects(run("constructor"), (e) => e instanceof Error, "a denied name is not bound");
    await assert.rejects(run("document.title", { inspector: data(), document: { title: "fake" } }), NeedsPage, "the page's tripwire stands");
    // A function cannot be copied, so it is never bound: the call fails before any script runs.
    await assert.rejects(run("inspector.f()", { inspector: { f: () => globalThis } }), (e) => e.name === "DataCloneError");
});

test("ADVERSARIAL: the bound data cannot be written at all; the copy is a second wall, behind the refusal", async () => {
    const mine = data();
    const g = { inspector: mine };
    for (const src of ["inspector.n = 99", "inspector.run.init.task = 'rewritten'", "inspector.list.push(4)", "inspector.list.length = 0",
        "delete inspector.n", "inspector.run.init.tools[0] = 'x'", "const r = inspector.run; r.init = null"]) {
        let threw = null;
        try { await run(src, g); } catch (e) { threw = e; }
        assert.ok(threw, `${src}: refused`);
    }
    assert.deepEqual(mine, data(), "the caller's data is untouched");
    assert.equal((await run("inspector.n", g)).value, 3, "and the next script reads the original");
    // What a script builds is its own, as ever: copying out of the bound data and changing the copy is a survey.
    assert.deepEqual((await run("const l = [...inspector.list]; l.push(4); l")).value, [1, 2, 3, 4]);
});

test("ADVERSARIAL: the bound data cannot carry ml.current anywhere writable", async () => {
    const { snapshotCurrent } = await import("../src/agent/current-context.ts");
    const snap = snapshotCurrent({ run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 }, messages: [{ role: "user", content: "hi" }], recorded: [], now: 1 });
    for (const src of ["inspector.m = ml.current.messages", "const m = ml.current.messages; m.push(1)"])
        await assert.rejects(evalReadonly(src, null, {}, undefined, { realm: "worker", current: snap, globals: { inspector: {} } }), Error, src);
    assert.equal(snap.messages.length, 1);
});

// --- FAILURE: falling out of the dialect leaves nothing behind ---

test("FAILURE: a script that writes into the bound data and then leaves the dialect leaves the caller's data as it was", async () => {
    const mine = data();
    await assert.rejects(run("inspector.n = 0; inspector.list.length = 0; window.x", { inspector: mine }), (e) => refused(e) || e instanceof Error);
    assert.deepEqual(mine, data());
});

// HALTING for the bound data is in tests/readonly-current.test.mjs, on that file's worker thread: a second worker that
// compiles the sources at startup slowed the suite's real-budget tests past their limit when every file ran at once.
