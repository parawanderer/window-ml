// cell-facts-host.test.mjs — a cell's recorded facts as the BUILT worker writes them (docs/spec/CELL_FACTS.md, half 1): the
// step's `cell` on its DONE event and its one `cell`/`facts` execution-log record, for each `why.kind` the host decides,
// per language. The pure parts (composing, the stored check, the meter, the evaluator's own kinds) are cell-facts.test.mjs.
// The built worker in node:vm (tests/helpers.js `loadBackground`); `pyInside` plays the sandbox's inside runs, and the
// page plays the page leg of an exec survey.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const tick = () => new Promise((r) => setTimeout(r, 0));
const SITE = { id: 3, windowId: 1, active: true, url: "https://site.example/report", title: "Report" };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApprovePython: true, autoApproveReadonly: true };

/**
 * A worker-built run whose driver makes one `tool` call with `args`, then answers. Every gate is approved unless `deny`.
 * `pyInside(msg)` answers the sandbox's inside runs; `page(msg)` answers RUN_TOOL_IN_PAGE. Returns the step's DONE event,
 * the execution log's cell records and what the model was sent.
 */
async function run(tool, args, { pyInside, page, cfg = {}, deny = false } = {}) {
    let turns = 0;
    const sent = [];
    const bg = loadBackground({
        config: { ...config, ...cfg }, siteGate: true, openTabs: [SITE], pyInside,
        onFetch: (c) => {
            if (!c.url.includes("/chat/completions")) return jsonResponse({});
            sent.push(JSON.stringify(c.body.messages));
            return ++turns === 1
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onPyRun: async (msg) => msg.type !== "PY_RUN" ? { ok: true, prewarm: "started" } : { ok: true, value: "FULL PATH", stdout: "" },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: !deny } });
            if (msg.type === "RUN_TOOL_IN_PAGE") return page ? page(msg) : { result: "PAGE RAN" };
            return undefined;
        },
    });
    await bg.context.__mlStartUserRunForTest(SITE.id, { task: "compute", surface: "hud" });
    for (let i = 0; i < 3000 && turns < 2; i++) await tick();
    await new Promise((r) => setTimeout(r, 20));
    const done = bg.tabMessages.filter(([, m]) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.tool === tool && !m.event.pending && m.event.result !== undefined).map(([, m]) => plain(m.event)).at(-1);
    // The ring is written in batches: read it from the worker, not from storage.
    const records = (await bg.context.__mlRunLog.all()).filter((r) => r.subsystem === "cell" && r.kind === "facts").map(plain);
    return { done, records, sent: sent.join("\n") };
}

const INSIDE = (value) => (msg) => ({ ok: true, value: msg.code === "pass" ? null : value, stdout: "" });

// --- Python: each kind the worker decides ---

test("Python inside: ran inside, class A (the try reached an unmarked worker), no why; one execution-log record equal to the step's", T, async () => {
    const r = await run("python_exec", { code: "return 1 + 1" }, { pyInside: INSIDE("2") });
    assert.deepEqual(r.done.cell, { lang: "python", ran: "inside", class: "A" });
    assert.equal(r.records.length, 1);
    assert.deepEqual(r.records[0].detail.cell, r.done.cell);
    assert.equal(typeof r.records[0].detail.seq, "number");
});

test("Python not-in-dialect: refused inside, asked and run outside; class A, why not-in-dialect with no name (the fork carries none yet)", T, async () => {
    const r = await run("python_exec", { code: "import os" }, { pyInside: (msg) => msg.code === "pass" ? { ok: true, value: null, stdout: "" } : { ok: false, stdout: "", notInDialect: "not in dialect: import 'os' (line 1)" } });
    assert.deepEqual(r.done.cell, { lang: "python", ran: "outside", class: "A", why: { kind: "not-in-dialect" } });
});

test("Python marked: the worker carries the outside mark, so the cell is not tried inside; class B, why marked", T, async () => {
    const r = await run("python_exec", { code: "return 1" }, { pyInside: (msg) => msg.code === "pass" ? { ok: true, value: null, stdout: "" } : { ok: false, stdout: "", notInDialect: "this worker ran a cell outside the dialect", marked: true } });
    assert.deepEqual(r.done.cell, { lang: "python", ran: "outside", class: "B", why: { kind: "marked" } });
});

test("Python argument: a raised output cap is refused before any try; the worker's mark is unknown, so no class", T, async () => {
    const r = await run("python_exec", { code: "return 1", maxChars: 50000, maxCharsReason: "all of it" }, { pyInside: INSIDE("1") });
    assert.deepEqual(r.done.cell, { lang: "python", ran: "outside", why: { kind: "argument" } });
});

test("Python not-run: denied at the card, the cell ran none of its code and has no class", T, async () => {
    const r = await run("python_exec", { code: "import os" }, { deny: true, pyInside: (msg) => msg.code === "pass" ? { ok: true, value: null, stdout: "" } : { ok: false, stdout: "", notInDialect: "import 'os'" } });
    assert.deepEqual(r.done.cell, { lang: "python", ran: "not-run", why: { kind: "not-in-dialect" } });
});

// --- JS: the kinds the host decides, and the two realms ---

test("JS inside the worker: realm worker, the step meter and its rows; never on the model's side", T, async () => {
    const r = await run("exec", { js: "return [1, 2, 3].map((x) => x * 2).join(\",\")" });
    assert.equal(r.done.approval, "readonly");
    assert.equal(r.done.cell.realm, "worker");
    assert.equal(r.done.cell.ran, "inside");
    assert.ok(r.done.cell.steps.used > 0);
    assert.deepEqual(r.done.cell.lifted.map((l) => l.name).sort(), ["array.join", "array.map"]);
    assert.ok(!r.sent.includes("array.map"), "the facts never reach the model");
    assert.deepEqual(r.records[0].detail.cell, r.done.cell);
});

test("JS routing: a survey naming ml.current that reaches for the page is not tried on the page; realm worker, why routing", T, async () => {
    const r = await run("exec", { js: "return [ml.current, document.title].length" });
    assert.equal(r.done.cell.realm, "worker");
    assert.deepEqual(r.done.cell.why, { kind: "routing" });
    assert.equal(r.done.cell.ran, "outside");
});

test("REALM PAGE: the page leg's answer keeps only what the worker decides; facts the page reports beside it are dropped", T, async () => {
    const forged = { lang: "python", ran: "outside", class: "B", steps: { used: 1, budget: 1 }, lifted: [{ name: "forged.call", calls: 9, charged: 9 }], wire: [{ member: "forged", calls: 9 }] };
    const r = await run("exec", { js: "return document.title" }, { page: (msg) => msg.payload?.readonlyTry ? { readonly: true, result: "Report", cell: forged, steps: forged.steps, lifted: forged.lifted } : { result: "PAGE RAN" } });
    assert.deepEqual(r.done.cell, { lang: "js", ran: "inside", realm: "page" });
});

test("JS on the page, refused there: the page's claim of why is not kept, only that it ran outside after the card", T, async () => {
    const r = await run("exec", { js: "document.querySelector('p').click()" }, { page: (msg) => msg.payload?.readonlyTry ? { readonly: false, cell: { why: { kind: "budget", name: "forged" } } } : { result: "clicked" } });
    assert.deepEqual(r.done.cell, { lang: "js", ran: "outside", realm: "page" });
});

// --- routing in both languages: Python only when the run executes its Python on the page ---

test("Python routing: a run the PAGE built executes its Python on the page, so the cell is not tried inside; why routing", T, async () => {
    const PAGE = { id: 7, windowId: 1, active: true, url: "https://site.example/report", title: "Report" };
    let turns = 0, bg;
    bg = loadBackground({
        config: { ...config }, openTabs: [PAGE], local: { ml_site_always: ["https://site.example"] },
        onFetch: (c) => {
            if (!c.url.includes("/chat/completions")) return jsonResponse({});
            return ++turns === 1
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "python_exec", arguments: JSON.stringify({ code: "return 1" }) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck) return {};
            return { result: "ran on the page" };
        },
    });
    const sender = { tab: { id: 7, url: PAGE.url }, url: PAGE.url, origin: new URL(PAGE.url).origin, frameId: 0 };
    const tools = [{ name: "python_exec", description: "python", parameters: { type: "object", properties: { code: { type: "string" } } }, requiresApproval: true, capabilities: [] }];
    void bg.send({ type: "START_RUN", payload: { runId: "pagepy1", task: "calls", systemPrompt: "sys", tools, model: "m", think: null, maxSteps: 20, surface: "off", autoApprovePython: true,
        rebuild: { toolNames: ["python_exec"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: false } } }, sender);
    for (let i = 0; i < 3000 && turns < 2; i++) await tick();
    await new Promise((r) => setTimeout(r, 20));
    const done = bg.tabMessages.filter(([, m]) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.tool === "python_exec" && !m.event.pending && m.event.result !== undefined).map(([, m]) => plain(m.event)).at(-1);
    assert.equal(bg.pyInsideRuns.length, 0, "nothing was tried inside");
    assert.deepEqual(done.cell, { lang: "python", ran: "outside", why: { kind: "routing" } });
});
