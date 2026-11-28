// redteam-cell-facts.test.mjs — the red-team pass for CELL_FACTS half 1 (docs/spec/CELL_FACTS.md, src/agent/cell-facts.ts):
// what a hostile SCRIPT, a hostile PAGE and a hostile log RECORD must not be able to put into a step's `cell` facts.
//
// The facts are composed by the worker after the step's approval from what the WORKER itself noted (the meter, the
// routing decision, the fork's mark). A script's return value is a result; a page's answer to the page leg is data; a
// record is rebuilt by enumeration before it is stored. Every row below is the deny side of one of those: a page's
// report dropped whole, a script's own text kept out of every field, and the model's view of the log carrying no cell.
//
// Red first: on origin/main 26b18bf8 src/agent/cell-facts.ts does not exist (`git show origin/main:src/agent/cell-facts.ts`
// fails), so every row here is red by absence; within this branch each assertion is the one an implementation would
// break by forwarding the script's or the page's object instead of composing/dropping it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { sanitizeRunReport } from "../src/log/run-log.ts";
import { currentLogRecords, logText, snapshotCurrent } from "../src/agent/current-context.ts";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const tick = () => new Promise((r) => setTimeout(r, 0));
const SITE = { id: 3, windowId: 1, active: true, url: "https://site.example/report", title: "Report" };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };
/** A token no composed fact can produce: it is what a forged field or a leaked script string would carry. */
const FORGED = "FORGEDTOKEN";

/**
 * A worker-built run whose driver makes one `exec` call with `js`, then answers. Every gate is approved. `page(msg)`
 * answers RUN_TOOL_IN_PAGE, as the PAGE does. Returns the step's DONE event, the execution log's records, and what the
 * model was sent.
 */
async function runExec(js, { page } = {}) {
    let turns = 0;
    const sent = [];
    const bg = loadBackground({
        config, siteGate: true, openTabs: [SITE],
        onFetch: (c) => {
            if (!c.url.includes("/chat/completions")) return jsonResponse({});
            sent.push(JSON.stringify(c.body.messages));
            return ++turns === 1
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: JSON.stringify({ js }) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onPyRun: async (msg) => msg.type !== "PY_RUN" ? { ok: true, prewarm: "started" } : { ok: true, value: "", stdout: "" },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type === "RUN_TOOL_IN_PAGE") return page ? page(msg) : { result: "PAGE RAN" };
            return undefined;
        },
    });
    await bg.context.__mlStartUserRunForTest(SITE.id, { task: "compute", surface: "hud" });
    for (let i = 0; i < 3000 && turns < 2; i++) await tick();
    await new Promise((r) => setTimeout(r, 20));
    const done = bg.tabMessages.filter(([, m]) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.tool === "exec" && !m.event.pending && m.event.result !== undefined).map(([, m]) => plain(m.event)).at(-1);
    const all = plain(await bg.context.__mlRunLog.all());
    const records = all.filter((r) => r.subsystem === "cell" && r.kind === "facts");
    return { done, records, all, sent: sent.join("\n") };
}

// --- a worker-realm JS cell cannot write or forge its own `cell` ---

test("a worker-realm script that RETURNS a whole CellFacts object changes none of the step's facts", T, async () => {
    const forged = {
        lang: "python", ran: "outside", realm: "page", class: "B", marked: true,
        why: { kind: "denied", name: `${FORGED}.name` },
        steps: { used: 999999999, budget: 1 },
        lifted: [{ name: `${FORGED}.call`, calls: 99, charged: 99 }],
        wire: [{ member: `${FORGED}.member`, calls: 99 }],
    };
    const r = await runExec(`return ${JSON.stringify(forged)}`);
    assert.ok(r.sent.includes(FORGED), "the script's object is the step's RESULT, where its text belongs");
    const { steps, ...rest } = r.done.cell;
    assert.deepEqual(rest, { lang: "js", ran: "inside", realm: "worker" }, "every other field is the worker's, not the script's");
    assert.ok(steps && Number.isInteger(steps.used) && steps.used > 0 && steps.used <= steps.budget, `the meter's own count: ${JSON.stringify(steps)}`);
    assert.ok(!JSON.stringify(r.done.cell).includes(FORGED), "no token of the returned object reaches the facts");
    assert.equal(r.records.length, 1);
    assert.deepEqual(r.records[0].detail.cell, r.done.cell, "the record is the step's facts, not a second copy of the result");
});

test("a script's printed text is the step's result, never a fact", T, async () => {
    const r = await runExec(`console.log(${JSON.stringify(FORGED)}); return 1`);
    assert.ok(r.done.result.includes(FORGED), "the console text is the result the model is told about");
    assert.equal(r.done.cell.why, undefined);
    assert.deepEqual(r.done.cell.lifted, [{ name: "console.log", calls: 1, charged: 0 }], "the call's own row, nothing from its text");
    assert.ok(!JSON.stringify(r.done.cell).includes(FORGED));
});

test("the one field a script can influence is why.name: an identifier it wrote, dropped past the cap; a value-shaped one is not a name", T, async () => {
    const named = await runExec("return FORGEDTOKEN");
    assert.equal(named.done.cell.why.kind, "denied");
    assert.equal(named.done.cell.why.name, "FORGEDTOKEN", "an identifier the script wrote is kept, bounded");
    const long = await runExec(`return ${"A".repeat(200)}`);
    assert.equal(long.done.cell.why.kind, "denied");
    assert.equal(long.done.cell.why.name, undefined, "a name past the cap is dropped, not truncated into a different name");
    const spaced = await runExec(`return ml[${JSON.stringify(`${FORGED} value`)}]`);
    assert.deepEqual(spaced.done.cell, { lang: "js", ran: "outside", realm: "page" }, "a member the worker does not know defers to the page, which reports nothing the facts keep");
    assert.ok(!JSON.stringify([named.done.cell, long.done.cell, spaced.done.cell]).includes(`${FORGED} value`));
});

// --- a page forging the page leg's answer changes no recorded field ---

test("the page's forged facts beside its leg's answer are dropped whole; the worker's realm page survives", T, async () => {
    const forged = {
        realm: "worker", lang: "python", ran: "outside", class: "B", marked: true,
        why: { kind: "budget", name: `${FORGED}.why` },
        steps: { used: 1, budget: 1 },
        lifted: [{ name: `${FORGED}.call`, calls: 9, charged: 9 }],
        wire: [{ member: `${FORGED}.member`, calls: 9 }],
        liftedMore: 5, wireMore: 5, [`${FORGED}Key`]: 1,
    };
    const r = await runExec("return document.title", { page: (msg) => msg.payload?.readonlyTry ? { readonly: true, result: "Report", cell: forged, facts: forged, realm: "worker", steps: forged.steps } : { result: "PAGE RAN" } });
    assert.deepEqual(r.done.cell, { lang: "js", ran: "inside", realm: "page" }, "only what the worker decided");
    assert.ok(!JSON.stringify(r.done.cell).includes(FORGED));
    assert.deepEqual(r.records[0].detail.cell, r.done.cell);
});

test("a page refusing the survey forges no why: the step ran outside after the card, and that is all", T, async () => {
    const r = await runExec("document.querySelector('p').click()", { page: (msg) => msg.payload?.readonlyTry ? { readonly: false, why: { kind: "denied", name: FORGED }, cell: { why: { kind: "budget", name: FORGED } }, steps: { used: 1, budget: 1 } } : { result: "clicked" } });
    assert.deepEqual(r.done.cell, { lang: "js", ran: "outside", realm: "page" });
    assert.ok(!JSON.stringify(r.done.cell).includes(FORGED));
});

test("a page answer's inherited or __proto__ fields are not read as its own", T, async () => {
    const proto = Object.assign(Object.create({ cell: { lang: "python", realm: "worker", why: { kind: "denied", name: FORGED } }, realm: "worker", steps: { used: 1, budget: 1 } }), { readonly: true, result: "Report" });
    const r = await runExec("return document.title", { page: (msg) => msg.payload?.readonlyTry ? proto : { result: "PAGE RAN" } });
    assert.deepEqual(r.done.cell, { lang: "js", ran: "inside", realm: "page" }, "an inherited cell/realm is not the envelope's own");
    const own = JSON.parse(`{"readonly":true,"result":"Report","__proto__":{"cell":{"lang":"python"},"realm":"worker"}}`);
    const r2 = await runExec("return document.title", { page: (msg) => msg.payload?.readonlyTry ? own : { result: "PAGE RAN" } });
    assert.deepEqual(r2.done.cell, { lang: "js", ran: "inside", realm: "page" }, "an own __proto__ key is inert data, and the step still records");
    assert.ok(r2.records.length === 1, "an odd envelope neither throws the step's record away nor duplicates it");
});

// --- the record itself: one nested shape, rebuilt by enumeration, or dropped ---

test("a `cell`/`facts` record survives only as exactly `{seq, cell}`, the cell rebuilt by the facts' own check", () => {
    const run = "abc123";
    const CELL = { lang: "js", ran: "inside", realm: "worker" };
    const facts = (detail) => sanitizeRunReport({ run, subsystem: "cell", kind: "facts", detail });
    assert.deepEqual(facts({ seq: 3, cell: CELL }), { run, subsystem: "cell", kind: "facts", detail: { seq: 3, cell: CELL } }, "the one accepted shape");
    assert.ok(facts({ seq: 3, cell: { ...CELL, steps: { used: 4, budget: 9 } } }), "a known nested object the facts own is kept");
    // An unknown key on the DETAIL drops the whole record — the requested probe; a nested field must not be a way in.
    assert.equal(facts({ seq: 3, cell: CELL, [FORGED]: 1 }), null);
    assert.equal(facts({ seq: 3, cell: { ...CELL, [FORGED]: 1 } }), null, "an unknown key on the CELL drops it too");
    assert.equal(facts({ seq: 3 }), null);
    assert.equal(facts({ cell: CELL }), null);
    assert.equal(facts({ seq: 3, cell: null }), null);
    // Every wrong type is refused, not coerced.
    for (const seq of [-1, 1.5, "3", null]) assert.equal(facts({ seq, cell: CELL }), null, `seq ${JSON.stringify(seq)}`);
    // A field on the wrong language is a different object, and refused.
    assert.equal(facts({ seq: 3, cell: { lang: "js", ran: "inside", marked: true } }), null);
    assert.equal(facts({ seq: 3, cell: { lang: "js", ran: "inside", class: "A" } }), null);
    assert.equal(facts({ seq: 3, cell: { lang: "js", ran: "inside", lifted: [{ name: `${FORGED} name`, calls: 1, charged: 1 }] } }), null, "a name that is not an identifier");
    // The flat records keep their own rule: a nested value is dropped, never stored (so the nested shape is one kind only).
    const mech = sanitizeRunReport({ run, subsystem: "tab", kind: "pinned", detail: { tab: 7, cell: { [FORGED]: 1 } } });
    assert.deepEqual(mech.detail, { tab: 7 }, "a mechanics record cannot smuggle a nested object under `detail`");
});

// --- the model never reads a cell's facts ---

test("ml.current.log and its text carry no cell record, and the model's messages carry no fact at all", T, async () => {
    const r = await runExec("return [1, 2, 3].map((x) => x * 2).join(',')");
    assert.equal(r.records.length, 1, "the person's log has the record");
    const modelLog = currentLogRecords(r.all);
    assert.equal(modelLog.filter((e) => e.subsystem === "cell" && e.kind === "facts").length, 0, "the model's view of the log drops it");
    assert.ok(!JSON.stringify(modelLog).includes("array.map"), "and no row's facts ride another record's detail");
    assert.ok(!logText(modelLog).includes("array.map"), "nor its text");
    const snap = snapshotCurrent({ run: { id: "rt" }, messages: [], recorded: [], log: r.all, now: Date.now() });
    assert.equal(snap.log.filter((e) => e.subsystem === "cell").length, 0, "the snapshot the model reads builds from the filtered view");
    assert.ok(!snap.log.text.includes("array.map"));
    assert.ok(!r.sent.includes("array.map"), "and the facts never reached a request");
});
