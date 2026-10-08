// Dates, number formatting and unary `+` in the read-only dialect (src/readonly-exec/policy.ts `date`/`DateCtor`/`number`,
// the parser's unary `+`). Added because real models wrote them while reading `ml.current` (`new Date(ts).toISOString()`,
// `Date.now() - at`, `.toFixed(1)`, `+new Date()`) and every one fell out of the dialect to an approval. Extending the
// dialect, so per AGENTS.md: what it reads, what it refuses, a forged receiver, and falling out leaving nothing behind.
// HALTING for these is in tests/readonly-current.test.mjs, on that file's worker thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { kindOf, methodAllowed, offeredMethods, MUTATING_METHODS } from "../src/readonly-exec/policy.ts";

const run = (code) => evalReadonly(code, null, {}, undefined, { realm: "worker", stepBudget: 50_000 });
const refused = (e) => e instanceof NotInDialect || e instanceof Denied;

// --- reading: what the models wrote now answers ---

test("a Date's reads and formatting, the clock, the parsers, number formatting and unary +", async () => {
    for (const [code, want] of [
        ["new Date(5).toISOString()", "1970-01-01T00:00:00.005Z"],
        ["new Date(5).getTime()", 5],
        ["new Date(Date.UTC(2020, 0, 2)).getUTCDate()", 2],
        ["Date.parse('2020-01-01T00:00:00Z')", 1577836800000],
        ["new Date(0).toLocaleString('en-GB', { timeZone: 'UTC' })", "01/01/1970, 00:00:00"],
        ["(1.25).toFixed(1)", "1.3"],
        ["(1234.5).toPrecision(3)", "1.23e+3"],
        ["+new Date(7)", 7],
        ["+'5' + 1", 6],
        ["1 + +'2'", 3],
        ["new Date(9) - new Date(2)", 7],
    ]) assert.deepEqual((await run(code)).value, want, code);
    const now = (await run("Date.now()")).value;
    assert.ok(Math.abs(now - Date.now()) < 5000, "the clock");
    assert.ok((await run("Date.now() - new Date().getTime() <= 0")).value);
});

// --- ADVERSARIAL ---

test("ADVERSARIAL: no setter, on any name, and the set is checked against the mutators the dialect knows", async () => {
    const setters = Object.getOwnPropertyNames(Date.prototype).filter((k) => k.startsWith("set"));
    assert.ok(setters.length >= 15, "the list being checked is the real one");
    for (const k of setters) {
        await assert.rejects(run(`const d = new Date(0); d.${k}(5); d.getTime()`), refused, k);
        assert.equal(offeredMethods("date").includes(k), false, `${k} is not offered to completion either`);
    }
    for (const kind of ["date", "DateCtor", "number"]) for (const m of offeredMethods(kind)) assert.ok(!MUTATING_METHODS.has(m), `${kind}.${m}`);
});

test("ADVERSARIAL: no road from Date to a constructor, a prototype, a call it does not list, or the realm", async () => {
    for (const src of [
        "Date.prototype", "Date.constructor", "Date.now.constructor", `Date["constr" + "uctor"]`, "Date.now.call(null)",
        "Date.now.bind(null)()", "Date.apply(null, [])", "Date()", "Date(0)", "new Date(0).constructor",
        `new Date(0).toISOString.constructor("return globalThis")()`, "Object.getPrototypeOf(new Date(0))",
        "new Date(0).__proto__", "Date.prototype.getTime.call({})",
    ]) {
        let value, err;
        try { value = (await run(src)).value; } catch (e) { err = e; }
        if (err) assert.ok(refused(err) || err instanceof TypeError, `${src}: refused, got ${err?.constructor?.name}: ${err?.message}`);
        else {
            assert.notEqual(typeof value, "function", `${src} handed back a function`);
            assert.notEqual(value, globalThis, `${src} reached the realm`);
        }
    }
    for (const src of ["Date = 1", "Date.now = () => 0", "Date.parse = 1"]) await assert.rejects(run(src), refused, `${src}: the environment's`);
    assert.ok(Math.abs((await run("Date.now()")).value - Date.now()) < 5000, "and the clock is still the clock");
});

test("ADVERSARIAL: a forged Date is not one: a toStringTag claim gets no method, a real one from another realm does", () => {
    let called = 0;
    const forged = { [Symbol.toStringTag]: "Date", getTime() { called++; return 0; }, toISOString() { called++; return "x"; } };
    assert.equal(Object.prototype.toString.call(forged), "[object Date]", "the forgery is convincing to the old check");
    assert.equal(kindOf(forged), null);
    assert.equal(methodAllowed(forged, "getTime"), false);
    assert.equal(methodAllowed(forged, "toISOString"), false);
    assert.equal(called, 0, "the forged method was never called by the check");
    const foreign = vm.runInNewContext("new Date(5)");
    assert.equal(foreign instanceof Date, false, "another realm's Date");
    assert.equal(kindOf(foreign), "date");
    assert.equal(kindOf(Date), "DateCtor");
    assert.equal(kindOf(vm.runInNewContext("Date")), null, "another realm's Date constructor is not this one: fails closed");
});

test("ADVERSARIAL: unary + coerces only as `-` already did: a script's object, a refused operand, nothing new", async () => {
    assert.ok(Number.isNaN((await run("+{}")).value));
    assert.equal((await run("+[]")).value, 0);
    assert.equal((await run("+[5]")).value, 5);
    await assert.rejects(run("+document.title"), (e) => e instanceof Error, "the operand is evaluated first, under the same rules");
    await assert.rejects(run("+globalThis"), refused);
    assert.equal((await run("let n = 1; n = +n + 1; n")).value, 2);
});

// --- FAILURE: falling out leaves nothing behind ---

test("FAILURE: a survey that reads the clock and formats dates, then falls out of the dialect, reaches the person", async () => {
    await assert.rejects(run("const t = Date.now(); const s = new Date(t).toISOString(); new Date(t).setTime(0)"), refused);
    await assert.rejects(run("const s = (1.5).toFixed(1); window.alert(s)"), refused);
    await assert.rejects(run("new Date(0).toLocaleString('en', { timeZone: 'Not/AZone' })"), RangeError, "a bad time zone is an ordinary error the script reads");
});
