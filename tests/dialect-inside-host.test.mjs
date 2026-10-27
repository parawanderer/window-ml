// dialect-inside-host.test.mjs — the worker's try of a python_exec cell INSIDE the read-only dialect, before its gate, in the built worker.
//
// docs/spec/PYTHON_DIALECT.md, "Membership replaces `mode`": a cell the sandbox runs inside is the call's result, with
// no card; one it refuses asks, saying where it left the dialect, and only the approved full-path run's result is the
// cell's; a sandbox with no predicate (the stock core) makes every cell ask and reads none of a call's inputs for a try.
// The built worker in node:vm (tests/helpers.js `loadBackground`); `pyInside` plays the sandbox's inside runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const tick = () => new Promise((r) => setTimeout(r, 0));
const SITE = { id: 3, windowId: 1, active: true, url: "https://site.example/report", title: "Report" };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApprovePython: true };

/**
 * A worker-built run whose driver calls python_exec once with `code`, then answers. `pyInside(msg)` answers the inside
 * runs (absent: the stock core); `local` presets chrome.storage.local. Every gate is approved. Returns the sandbox's runs, the step events and the model's view.
 */
async function run(code, { pyInside, cfg = {}, local = {}, external = false } = {}) {
    let turns = 0, last = null;
    const full = [];
    const bg = loadBackground({
        config: { ...config, ...cfg }, local, siteGate: true, openTabs: [SITE], pyInside,
        onFetch: (c) => {
            if (!c.url.includes("/chat/completions")) return jsonResponse({});
            last = c.body.messages;
            return ++turns === 1
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "python_exec", arguments: JSON.stringify({ code }) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onPyRun: async (msg) => {
            if (msg.type !== "PY_RUN") return { ok: true, prewarm: "started" };
            full.push(plain(msg));
            return { ok: true, value: "FULL PATH", stdout: "" };
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (external) return msg.type === "RUN_TOOL_IN_PAGE" ? { result: "" } : undefined;
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            return msg.type === "RUN_TOOL_IN_PAGE" ? { result: "" } : undefined;
        },
    });
    await bg.context.__mlStartUserRunForTest(SITE.id, { task: "compute", surface: "hud" }, external ? { approvalRouting: "both" } : undefined);
    for (let i = 0; i < 3000 && turns < 2; i++) {
        // The external channel (an orchestrator's `__mlApprovals`) answers the gate with source "external", not a person.
        if (external) for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await tick();
    }
    await new Promise((r) => setTimeout(r, 20));
    const events = bg.tabMessages.filter(([, m]) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.tool === "python_exec").map(([, m]) => plain(m.event));
    return {
        full, inside: bg.pyInsideRuns.map(plain), events,
        asked: events.filter((e) => e.awaitingApproval),
        done: events.find((e) => !e.pending),
        result: (last ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n"),
    };
}

// --- a cell the sandbox runs inside: no card, its result is the call's ---

test("a cell the sandbox runs inside the dialect is the call's result with no card, approved as sandbox, and never runs on the full path", T, async () => {
    const r = await run("return 1 + 1", { pyInside: (msg) => ({ ok: true, value: msg.code === "pass" ? null : "INSIDE 2", stdout: "" }) });
    assert.deepEqual(r.inside.map((m) => m.code), ["pass", "return 1 + 1"], "the probe, then the cell, both inside");
    assert.equal(r.asked.length, 0, "no card");
    assert.equal(r.full.length, 0, "nothing ran on the full path");
    assert.equal(r.done.approval, "sandbox");
    assert.match(r.result, /INSIDE 2/);
});

// --- a cell the sandbox refuses: it asks, says where, and only the full-path run counts ---

test("a cell the sandbox refuses asks with where it left the dialect, and only the approved full-path run's result reaches the model", T, async () => {
    const r = await run("import os\nreturn os.getcwd()", { pyInside: (msg) => (msg.code === "pass"
        ? { ok: true, value: null, stdout: "" }
        : { ok: false, stdout: "", notInDialect: "not in dialect: import 'os' (line 1)" }) });
    assert.equal(r.asked.length, 1, "the person is asked");
    assert.equal(r.asked[0].askWhy?.line, "Outside the read-only Python dialect: import 'os' (line 1)");
    assert.equal(r.full.length, 1, "approved, it ran on the full path");
    assert.equal(r.full[0].inside, undefined, "the approved run is not an inside run");
    assert.match(r.result, /FULL PATH/);
    assert.match(r.result, /outside the read-only Python dialect \(import 'os' \(line 1\)\)/, "the model reads why it asked");
});

// --- no predicate: every cell asks, and no try reads anything ---

test("FAIL CLOSED: a sandbox with no membership predicate (the stock core) makes the cell ask; the probe is the only inside run", T, async () => {
    const r = await run("return 1 + 1");
    assert.deepEqual(r.inside.map((m) => m.code), ["pass"], "one probe with no inputs, then no try");
    assert.equal(r.asked.length, 1);
    assert.match(r.asked[0].askWhy?.line ?? "", /no membership predicate/);
    assert.equal(r.full.length, 1);
});

test("Python auto-approval off: nothing is tried inside, and the cell asks saying so", T, async () => {
    const r = await run("return 1 + 1", { cfg: { autoApprovePython: false }, pyInside: () => ({ ok: true, value: "INSIDE", stdout: "" }) });
    assert.equal(r.inside.length, 0);
    assert.equal(r.asked.length, 1);
    assert.match(r.asked[0].askWhy?.line ?? "", /auto-approval of Python is off/);
});

// --- the stored tier 3 libraries reach every inside run ---

const LIB_SOURCE = "def total(xs):\n    return sum(xs)\n";
const LIB = { id: "lib-1", module: "stats_lib", path: "/w/proj/lib/stats.py", root: "/w/proj", sha256: "a".repeat(64), source: LIB_SOURCE, names: [{ name: "total", kind: "def", signature: "xs" }], origin: "proposed", created: 1 };

test("an inside run carries every stored library as the sandbox loads it; an entry that no longer validates is dropped, never loaded", T, async () => {
    const stale = { ...LIB, id: "lib-2", module: "_private", sha256: "not-a-sha" };
    const r = await run("import stats_lib\nreturn stats_lib.total([1, 2])", { local: { ml_libraries_global: [LIB, stale] }, pyInside: () => ({ ok: true, value: "3", stdout: "" }) });
    const tries = r.inside.filter((m) => m.code !== "pass");
    assert.ok(tries.length >= 1);
    for (const m of tries) assert.deepEqual(m.libraries, [{ name: "stats_lib", source: LIB_SOURCE, sha256: LIB.sha256, names: ["total"] }]);
    assert.equal(r.full.length, 0, "nothing ran on the full path");
});

test("with no library stored, an inside run carries an empty list", T, async () => {
    const r = await run("return 1 + 1", { pyInside: () => ({ ok: true, value: "2", stdout: "" }) });
    for (const m of r.inside.filter((x) => x.code !== "pass")) assert.deepEqual(m.libraries ?? [], []);
});

// --- the JavaScript-bridge lift: PY_RUN carries `bridges` only for a cell a person approved on its card ---
// bridge-names.ts. The chain from the loop's approval (`person`) through sw-run-host, the run's python grant, runPython
// and the PY_RUN the offscreen document gets; each link is also pinned where it lives (agent-loop.test.mjs,
// python-run-namespace.test.mjs). The sandbox's refusal itself is python-bridge-gate.test.mjs.

const NO_DIALECT = { pyInside: (msg) => (msg.code === "pass" ? { ok: true, value: null, stdout: "" } : { ok: false, stdout: "", notInDialect: "not in dialect: import 'js' (line 1)" }) };

test("a cell naming a bridge that the person approved on the card runs with PY_RUN bridges: true", T, async () => {
    const r = await run("import js\nreturn js.Date.now()", NO_DIALECT);
    assert.equal(r.asked.length, 1, "the card asked");
    assert.equal(r.full.length, 1);
    assert.equal(r.full[0].bridges, true);
    assert.equal(r.full[0].hardened, true);
});

test("a cell outside the dialect that names no bridge, approved on the card, carries no lift", T, async () => {
    const r = await run("import os\nreturn os.getcwd()", { pyInside: NO_DIALECT.pyInside });
    assert.equal(r.full.length, 1);
    assert.equal("bridges" in r.full[0], false);
});

test("a cell naming a bridge approved through the external channel (not a person) carries no lift", T, async () => {
    const r = await run("import js\nreturn js.Date.now()", { ...NO_DIALECT, external: true });
    assert.equal(r.full.length, 1, "the external approval did run the cell");
    assert.equal("bridges" in r.full[0], false, "an orchestrator is not the person the card's line is for");
});

test("a cell the sandbox runs inside the dialect is never sent the lift", T, async () => {
    const r = await run("return 1 + 1", { pyInside: (msg) => ({ ok: true, value: "INSIDE 2", stdout: msg.code }) });
    for (const m of [...r.inside, ...r.full]) assert.equal("bridges" in m, false);
});

test("PYTHON_EXEC cannot ask for the lift: `bridges` in a payload is ignored, from a page and from our own surface", T, async () => {
    const runs = [];
    const bg = loadBackground({
        config, siteGate: false, openTabs: [SITE],
        onPyRun: async (msg) => { runs.push(plain(msg)); return { ok: true, value: "x", stdout: "" }; },
    });
    const payload = { code: "import js", bridges: true, hardened: true };
    const page = { tab: { id: SITE.id, url: SITE.url }, url: SITE.url, frameId: 0 };
    const refused = await bg.send({ type: "PYTHON_EXEC", requestId: "r1", payload }, page);
    assert.match(refused.error ?? "", /needs approval/, "a page's cell outside the dialect is refused before the sandbox");
    assert.equal(runs.filter((x) => x.type === "PY_RUN").length, 0);
    await bg.send({ type: "PYTHON_EXEC", requestId: "r2", payload }, {});
    const ran = runs.filter((x) => x.type === "PY_RUN");
    assert.equal(ran.length, 1, "positive control: our own surface's cell did reach the sandbox");
    assert.equal("bridges" in ran[0], false, "whatever the payload said, nothing is lifted");
});
