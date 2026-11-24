// cell-facts.test.mjs — what one exec or python_exec cell did, as the worker records it (docs/spec/CELL_FACTS.md, half 1):
// composing the facts from the step's approval and the worker's note, checking a stored object by enumeration, the dialect
// evaluator's meter (each host function's charge, its callbacks' steps the cell's own), and the refusal's kind and name.
// The rows through the built worker (each `why.kind` the host decides, the recorder changing no outcome) are
// cell-facts-host.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { composeCellFacts, sanitizeCellFacts, cellFactsLine, ranOf, isCellName, CELL_ROWS_MAX, CELL_CHARS_MAX } from "../src/agent/cell-facts.ts";
import { evalReadonly, newCellMeter, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { evalReadonlyInWorker } from "../src/sw/sw-readonly.ts";
import { runAgentLoop } from "../src/agent/agent-loop.ts";

const doc = () => new JSDOM("<!doctype html><body><p>a</p><p>b</p></body>").window.document;
/** Run `code` in the worker realm with a meter; the meter, and the value or the refusal. */
async function metered(code, { ml = {}, stepBudget } = {}) {
    const meter = newCellMeter();
    try {
        const r = await evalReadonly(code, null, ml, undefined, { realm: "worker", meter, ...(stepBudget ? { stepBudget } : {}) });
        return { meter, value: r.value };
    } catch (e) { return { meter, error: e }; }
}
const charged = (m) => [...m.lifted.values()].reduce((n, r) => n + r.charged, 0);

// --- the meter: every step is charged to one host call or to the cell's own code ---

test("the sum of every host function's charge and the cell's own steps is the step meter's count", async () => {
    const { meter, value } = await metered(`const a = Array.from({ length: 300 }, (_, i) => "row" + i);
let n = 0;
for (const s of a) n += s.indexOf("w") + Math.max(s.length, 2);
const parts = a.map((s) => s.split("w")).filter((p) => p.length > 1);
return n + parts.length + JSON.stringify(parts.slice(0, 3)).length;`);
    assert.equal(typeof value, "number");
    assert.ok(meter.steps.used > 0);
    assert.equal(charged(meter) + meter.own, meter.steps.used);
    for (const name of ["ArrayCtor".replace(/Ctor$/, "") + ".from", "string.indexOf", "Math.max", "array.map", "array.filter", "string.split", "JSON.stringify", "array.slice"])
        assert.ok(meter.lifted.has(name), `a row for ${name}: ${[...meter.lifted.keys()].join(", ")}`);
    assert.equal(meter.lifted.get("string.indexOf").calls, 300);
});

test("a host call is not charged its callback's steps: those are the cell's own", async () => {
    const light = await metered(`const a = Array.from({ length: 200 }, (_, i) => i); return a.map((x) => x).length;`);
    const heavy = await metered(`const a = Array.from({ length: 200 }, (_, i) => i); return a.map((x) => [x, x + 1, x + 2, x + 3].filter((y) => y % 2).length).length;`);
    assert.equal(heavy.meter.lifted.get("array.map").charged, light.meter.lifted.get("array.map").charged, "map is charged the same whatever its callback does");
    assert.ok(heavy.meter.own > light.meter.own + 1000, "the heavier callback's steps are the cell's own");
    assert.equal(heavy.meter.lifted.get("array.filter").calls, 200, "a host call inside a callback still has its own row");
    for (const r of [light, heavy]) assert.equal(charged(r.meter) + r.meter.own, r.meter.steps.used);
});

test("each ml member a cell calls is counted on the wire; a call to a namespace's static is a lifted row too", async () => {
    const { meter } = await metered(`const a = await ml.models(); const b = await ml.models(); const c = await ml.info(); return [a, b, c].length;`,
        { ml: { models: async () => ["m"], info: async () => ({}) } });
    assert.deepEqual(Object.fromEntries(meter.wire), { models: 2, info: 1 });
    assert.equal(meter.lifted.get("ml.models").calls, 2);
});

test("a meter changes nothing the evaluation answers: the same value, the same console, with and without it", async () => {
    const code = `const xs = [3, 1, 2]; console.log(xs.join("-")); return [...xs].sort().map((x) => x * 2);`;
    const plain = await evalReadonly(code, null, {}, undefined, { realm: "worker" });
    const withMeter = await evalReadonly(code, null, {}, undefined, { realm: "worker", meter: newCellMeter() });
    assert.deepEqual(withMeter.value, plain.value);
    assert.deepEqual(withMeter.logs, plain.logs);
});

test("a cell that trips the step budget reports the whole budget spent, and its refusal says it was the budget", async () => {
    const { meter, error } = await metered(`const a = Array.from({ length: 5000 }, (_, i) => i); let n = 0; for (const x of a) n += x; return n;`, { stepBudget: 2000 });
    assert.ok(error instanceof NotInDialect);
    assert.equal(error.budget, true);
    assert.equal(error.refusedName, "STEP_BUDGET");
    assert.deepEqual(meter.steps, { used: 2000, budget: 2000 });
});

// --- the refusal names what it refused, as a field, never as text to parse ---

test("a refused construct carries its name: a while loop, a C-style for, a refused method, a denied property", async () => {
    const name = async (code, d = null) => { try { await evalReadonly(code, d, {}, undefined, d ? {} : { realm: "worker" }); } catch (e) { return [e.constructor.name, e.refusedName]; } return null; };
    // `while` is no keyword of the dialect: it reaches the evaluator as a name nothing declares, which it refuses as Denied.
    assert.deepEqual(await name("while (true) {}"), ["Denied", "while"]);
    assert.deepEqual(await name("for (let i = 0; i < 3; i++) {}"), ["NotInDialect", "for"]);
    assert.deepEqual(await name(`document.querySelector("p").click()`, doc()), ["NotInDialect", "click"]);
    assert.deepEqual(await name(`return [].constructor`), ["Denied", "constructor"]);
});

// --- composing the facts from the approval and the note ---

test("ran: an approval read as what the cell did, for every approval the loop gives", () => {
    const want = { readonly: "inside", sandbox: "inside", user: "outside", consented: "outside", "same-origin": "outside", "self-source": "outside", denied: "not-run", skipped: "not-run", cancelled: "not-run" };
    for (const [approval, ran] of Object.entries(want)) assert.equal(ranOf(approval), ran, approval);
    assert.equal(ranOf(undefined), "not-run", "no approval at all: the call errored before anything ran");
});

const FULL_NOTE = {
    realm: "worker", why: { kind: "not-in-dialect", name: "while" }, steps: { used: 10, budget: 100 },
    lifted: [{ name: "array.map", calls: 1, charged: 4 }], wire: [{ member: "fetch", calls: 2 }],
    markedWorker: true, workerKnown: true, markSet: true,
};

test("a JS cell inside: its realm, steps, lifted rows by charge and wire rows; no why, no class, no mark", () => {
    const f = composeCellFacts("js", "readonly", { ...FULL_NOTE, lifted: [{ name: "a.b", calls: 1, charged: 1 }, { name: "c.d", calls: 9, charged: 7 }] });
    assert.deepEqual(f, { lang: "js", ran: "inside", realm: "worker", steps: { used: 10, budget: 100 }, lifted: [{ name: "c.d", calls: 9, charged: 7 }, { name: "a.b", calls: 1, charged: 1 }], wire: [{ member: "fetch", calls: 2 }] });
});

test("a JS cell outside keeps why and its name, and no steps unless the budget tripped", () => {
    assert.deepEqual(composeCellFacts("js", "user", FULL_NOTE), { lang: "js", ran: "outside", realm: "worker", why: { kind: "not-in-dialect", name: "while" } });
    assert.deepEqual(composeCellFacts("js", "user", { ...FULL_NOTE, why: { kind: "budget", name: "STEP_BUDGET" } }).steps, { used: 10, budget: 100 });
});

test("REALM PAGE: of a cell the page evaluated, only what the worker decides is kept (ran, the worker's why.kind); every page-reported field is dropped", () => {
    assert.deepEqual(composeCellFacts("js", "readonly", { ...FULL_NOTE, realm: "page" }), { lang: "js", ran: "inside", realm: "page" });
    assert.deepEqual(composeCellFacts("js", "user", { ...FULL_NOTE, realm: "page", why: { kind: "routing", name: "current" } }), { lang: "js", ran: "outside", realm: "page", why: { kind: "routing" } });
});

test("a Python cell: class from the worker's mark, why.kind with no name (the fork carries none yet), wire, and the mark it set; never steps or lifted", () => {
    assert.deepEqual(composeCellFacts("python", "user", FULL_NOTE), { lang: "python", ran: "outside", class: "B", why: { kind: "not-in-dialect" }, wire: [{ member: "fetch", calls: 2 }], marked: true });
    assert.deepEqual(composeCellFacts("python", "sandbox", { workerKnown: true, markedWorker: false }), { lang: "python", ran: "inside", class: "A" });
    assert.equal(composeCellFacts("python", "user", {}).class, undefined, "no inside try reached the worker: its mark is unknown, so no class");
    assert.equal(composeCellFacts("python", "denied", FULL_NOTE).class, undefined, "absent for not-run");
});

test("names are identifiers, never values: a lifted row or a refused name that is not one is dropped", () => {
    assert.equal(isCellName("pandas.read_csv"), true);
    for (const bad of ["a b", "x=1", "'q'", "", "a".repeat(121), "1abc", "a..b"]) assert.equal(isCellName(bad), false, bad);
    const f = composeCellFacts("js", "readonly", { lifted: [{ name: "obj.has space", calls: 1, charged: 1 }, { name: "ok.name", calls: 1, charged: 1 }] });
    assert.deepEqual(f.lifted.map((l) => l.name), ["ok.name"]);
    assert.deepEqual(composeCellFacts("js", "user", { why: { kind: "denied", name: "a key with spaces" } }).why, { kind: "denied" });
});

test("bounded: past 32 rows the rest are counted; past 4,096 characters rows are cut and counted", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `fn${i}`, calls: 1, charged: 40 - i }));
    const f = composeCellFacts("js", "readonly", { lifted: rows });
    assert.equal(f.lifted.length, CELL_ROWS_MAX);
    assert.equal(f.liftedMore, 8);
    assert.equal(f.lifted[0].name, "fn0", "the largest charges are kept");
    const long = Array.from({ length: 32 }, (_, i) => ({ name: `n${i}.` + "x".repeat(110), calls: 1, charged: 1 }));
    const g = composeCellFacts("js", "readonly", { lifted: long, wire: long.map((l) => ({ member: l.name, calls: 1 })) });
    assert.ok(JSON.stringify(g).length <= CELL_CHARS_MAX);
    assert.equal(g.lifted.length + g.liftedMore, 32);
    assert.equal((g.wire?.length ?? 0) + (g.wireMore ?? 0), 32);
    assert.ok(sanitizeCellFacts(g), "the bounded object passes the stored check");
});

// --- the stored check: every key known and typed, nothing passed through ---

test("a composed object passes the stored check unchanged, for both languages", () => {
    for (const f of [composeCellFacts("js", "readonly", FULL_NOTE), composeCellFacts("python", "user", FULL_NOTE), composeCellFacts("js", "denied", {})])
        assert.deepEqual(sanitizeCellFacts(f), f);
});

test("an unknown key anywhere, a wrong type, a field on the wrong language or an over-cap list refuses the whole object", () => {
    const ok = { lang: "js", ran: "inside", realm: "worker", steps: { used: 1, budget: 2 }, lifted: [{ name: "a.b", calls: 1, charged: 1 }], wire: [{ member: "fetch", calls: 1 }] };
    assert.ok(sanitizeCellFacts(ok));
    const bad = [
        { ...ok, extra: 1 },
        { ...ok, steps: { used: 1, budget: 2, more: 3 } },
        { ...ok, lifted: [{ name: "a.b", calls: 1, charged: 1, value: "secret" }] },
        { ...ok, wire: [{ member: "fetch", calls: -1 }] },
        { ...ok, why: { kind: "made-up" } },
        { ...ok, why: { kind: "denied", name: "not a name" } },
        { ...ok, ran: "maybe" },
        { ...ok, class: "A" },
        { lang: "python", ran: "inside", steps: { used: 1, budget: 2 } },
        { lang: "python", ran: "inside", realm: "worker" },
        { lang: "js", ran: "inside", marked: true },
        { ...ok, lifted: Array.from({ length: 33 }, () => ({ name: "a.b", calls: 1, charged: 1 })) },
        { ...ok, steps: { used: 1.5, budget: 2 } },
        [ok], null, "cell",
    ];
    for (const b of bad) assert.equal(sanitizeCellFacts(b), null, JSON.stringify(b)?.slice(0, 120));
});

test("the Markdown line names every field it carries", () => {
    assert.equal(cellFactsLine(composeCellFacts("js", "readonly", FULL_NOTE)), "js · inside · worker · steps 10/100 · lifted array.map×1 (4) · wire fetch×2");
    assert.equal(cellFactsLine(composeCellFacts("python", "user", FULL_NOTE)), "python · outside · class B · why not-in-dialect · wire fetch×2 · set the outside mark");
});

// --- why.kind, for a JS cell the worker evaluates (the host's kinds: cell-facts-host.test.mjs) ---

/** The facts of one exec call evaluated in the worker, then run outside (`user`) when it was refused. */
async function jsFacts(args) {
    const w = await evalReadonlyInWorker(args, { ml: {} });
    return composeCellFacts("js", w.kind === "answered" ? "readonly" : "user", w.cell);
}

test("JS not-in-dialect: a construct the dialect does not have, with its name", async () => {
    assert.deepEqual((await jsFacts({ js: "for (let i = 0; i < 3; i++) {}" })).why, { kind: "not-in-dialect", name: "for" });
});

test("JS denied: an operation the dialect refuses on a value, with its name", async () => {
    assert.deepEqual((await jsFacts({ js: "return [].constructor" })).why, { kind: "denied", name: "constructor" });
});

test("JS budget: a size cap tripped, with the cap's name, and the steps spent", async () => {
    const f = await jsFacts({ js: `return "x".repeat(20000000)` });
    assert.equal(f.why.kind, "budget");
    assert.equal(f.why.name, "MAX_STRING");
    assert.ok(f.steps.budget > 0);
});

test("JS argument: a raised output cap is refused before any of the cell runs", async () => {
    const f = await jsFacts({ js: "return 1", maxChars: 50000, maxCharsReason: "need it all" });
    assert.deepEqual(f.why, { kind: "argument", name: "maxChars" });
    assert.equal(f.steps, undefined, "nothing ran");
});

test("JS inside: no why, the worker realm, the meter's rows", async () => {
    const f = await jsFacts({ js: `return [1, 2, 3].map((x) => x * 2).join(",")` });
    assert.equal(f.ran, "inside");
    assert.equal(f.why, undefined);
    assert.equal(f.realm, "worker");
    assert.deepEqual(f.lifted.map((l) => l.name).sort(), ["array.join", "array.map"]);
});

test("the refusal classes carry their facts only as fields; an unnamed refusal has none", () => {
    assert.equal(new NotInDialect("x").refusedName, undefined);
    assert.equal(new NotInDialect("x").budget, undefined);
    assert.equal(new Denied("x", { name: "y" }).refusedName, "y");
});

// --- the recorder decides nothing: present, throwing or absent, every call's outcome is the same ---

/** One scripted run of three cells (inside, asked and approved, asked and denied) with `cellFacts` as given. */
async function scripted(cellFacts) {
    const turns = [
        { content: "", tool_calls: [{ id: "a", name: "exec", arguments: { js: "return 1" } }] },
        { content: "", tool_calls: [{ id: "b", name: "python_exec", arguments: { code: "import os" } }] },
        { content: "", tool_calls: [{ id: "c", name: "exec", arguments: { js: "while (true) {}" } }] },
        { content: "done", tool_calls: [] },
    ];
    let i = 0, gates = 0;
    const sent = [], emits = [], ran = [];
    const deps = {
        callModel: async (messages) => { sent.push(JSON.parse(JSON.stringify(messages))); return turns[i++] || { content: "" }; },
        tryReadonly: async (name, args) => name === "exec" && args.js === "return 1" ? { result: "1" } : null,
        runTool: async (name) => { ran.push(name); return { result: `ran ${name}` }; },
        approve: async () => ++gates === 1,
        autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        emit: (ev) => emits.push(ev),
        ...(cellFacts ? { cellFacts } : {}),
    };
    const tools = [{ name: "exec", requiresApproval: true }, { name: "python_exec", requiresApproval: true }];
    const res = await runAgentLoop("t", { tools }, deps);
    const done = emits.filter((e) => e.tool && !e.pending && e.result !== undefined);
    return { res, sent, ran, done };
}

test("removing the recorder changes no call's outcome: the same approvals, results, runs and model requests", async () => {
    const recorded = [];
    const withIt = await scripted(async (name, seq, approval) => { const f = composeCellFacts(name === "exec" ? "js" : "python", approval, {}); recorded.push(f); return f; });
    const throwing = await scripted(async () => { throw new Error("the recorder broke"); });
    const without = await scripted(undefined);
    assert.deepEqual(recorded.map((f) => [f.lang, f.ran]), [["js", "inside"], ["python", "outside"], ["js", "not-run"]], "the recorder saw every cell");
    for (const other of [throwing, without]) {
        assert.deepEqual(other.done.map((e) => [e.tool, e.approval, e.result]), withIt.done.map((e) => [e.tool, e.approval, e.result]));
        assert.deepEqual(other.ran, withIt.ran);
        assert.deepEqual(other.sent, withIt.sent, "the model was sent exactly the same requests");
        assert.equal(other.res.summary, withIt.res.summary);
    }
    assert.deepEqual(withIt.done.map((e) => e.cell?.ran), ["inside", "outside", "not-run"], "the DONE events carry the facts");
    assert.ok(without.done.every((e) => !("cell" in e)) && throwing.done.every((e) => !("cell" in e)), "with no recorder, or a broken one, a step has none: unknown");
    assert.ok(!JSON.stringify(withIt.sent).includes("\"ran\""), "nothing of the facts reaches the model");
});
