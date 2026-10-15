// redteam-tool-throw.test.mjs — a tool call that THROWS somewhere in its dispatch ends as an error result the model
// reads, never as the end of the run.
//
// Before, a throw anywhere between the model's call and the tool's answer (delegateTool's setup on odd arguments, the
// page's malformed envelope, an isolated world's odd return, the auto-approve decision, the gate's bookkeeping) left
// the loop, and the run ended with no answer: a hostile page or one odd argument could end any run. Each test here is
// a worker-built run in the real bundle, the page played by `onTabMessage`, and asserts the run went on to its next
// model call with the error in the tool result, and that the execution log has the throw (`tool`/`threw`). A cancel
// still ends the run.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { runOn } from "./isolated-harness.mjs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { IDBFactory } = await import("fake-indexeddb");

const SITE_URL = "https://site.example/page";
const THREW = /failed inside the extension/;

/**
 * One worker-built run on tab 7 (an approved page) that makes each of `steps` as a tool call, approving every gate,
 * then answers "done". `page(payload, bg, hash)` answers a call the page runs (default "ok").
 * @returns the tool results the model read on its last call, how many model calls there were, the run's `tool` log
 *   records, the terminal agent-result event, and the worker
 */
async function runSteps(steps, { page, side, config = {} } = {}) {
    let n = 0, bg, hash;
    bg = loadBackground({
        siteGate: true, indexedDB: new IDBFactory(),
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off", ...config },
        local: { ml_site_always: ["https://site.example"] },
        openTabs: [{ id: 7, url: SITE_URL, title: "Site" }],
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const step = steps[n++];
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return side ? side(msg.payload) : {};
            return page ? page(msg.payload, bg, hash) : { result: "ok" };
        },
    });
    bg.commit?.(7, { documentId: "doc-1", url: SITE_URL });
    ({ hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 20 }));
    const ended = () => bg.tabMessages.map((a) => a[1]).find((m) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === hash)?.event;
    for (let i = 0; i < 4000 && !ended(); i++) await new Promise((r) => setTimeout(r, 0));
    const models = bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const results = (models.at(-1)?.body.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    const log = JSON.parse(JSON.stringify((await bg.context.__mlRunLog.all()).filter((r) => r.run === hash && r.subsystem === "tool")));
    return { results, modelCalls: models.length, log, end: JSON.parse(JSON.stringify(ended() ?? null)), bg, hash };
}

/** The run went on past the throw: a model call after it, which read the error, and the run's own answer. */
function wentOn(r, steps) {
    assert.equal(r.modelCalls, steps + 1, `the run made its next model call after the throw (end: ${JSON.stringify(r.end)})`);
    assert.equal(r.end?.error, undefined, "the run did not end in an error");
    assert.equal(r.end?.summary, "done");
}

// --- the page's main world: a call delegated to the page ---
test("main world: a page answering with a malformed envelope (answerMedia not iterable) gets an error result, not the run's end", async () => {
    const r = await runSteps([{ name: "click", args: { selector: "#a" } }], { page: () => ({ result: "clicked", answerMedia: { length: 1 } }) });
    wentOn(r, 1);
    assert.match(r.results[0], THREW);
    assert.deepEqual(r.log.map((x) => [x.kind, x.reason, x.level, x.detail?.tool]), [["threw", "run", "error", "click"]]);
    // Positive control: the same call answered properly is the page's answer.
    const ok = await runSteps([{ name: "click", args: { selector: "#a" } }], { page: () => ({ result: "clicked" }) });
    wentOn(ok, 1);
    assert.equal(ok.results[0], "clicked");
    assert.deepEqual(ok.log, []);
});

test("main world: an exec whose js cannot be a string is an error result, and the run goes on", async () => {
    // `{ toString: 1 }` cannot be made a string: tabGrantsForCall's String(js) threw in delegateTool before anything was
    // sent. A worker-built run's precheck now refuses a js that is no string before the gate (#664), so it never gets there.
    const r = await runSteps([{ name: "exec", args: { js: { toString: 1 } } }]);
    wentOn(r, 1);
    assert.match(r.results[0], /^Error: invalid arguments for "exec": "js" must be a string\./);
});

// --- the worker: a tool the worker runs itself, and the decisions before it ---
// `autoApprovePython` must be ON for the python_exec case: the throw it is about lives inside the auto-approve
// decision (`String(code)` in auto-approve.ts), and with the flag off that decision returns null before reaching it.
for (const [tool, args, config] of [
    ["fetch_url", { url: { toString: 1 } }, {}],
    ["python_exec", { code: { toString: 1 } }, { autoApprovePython: true }],
])
test(`worker: ${tool} with an argument that cannot be a string is asked about instead of ending the run`, async () => {
    // Before: auto-approve's String(url) / autoApprovePython threw in the loop, and the approval's bookkeeping threw
    // when the person approved, which left the gate hanging.
    const r = await runSteps([{ name: tool, args }], { config });
    wentOn(r, 1);
    assert.equal(r.results.length, 1, "the model read the call's result");
    assert.ok(r.log.some((x) => x.kind === "threw" && x.reason === "auto-approve" && x.detail?.tool === tool), JSON.stringify(r.log));
});

// --- an isolated world: an approved exec of a worker-built run that names a pointer ---
test("isolated: an exec whose world returns a value the worker cannot print is an error result, not the run's end", async () => {
    // The script replaces its world's JSON.stringify, so the wrapper hands back `{ toString: 1 }` as the value and
    // the worker's `${r.value}` threw.
    const r = await runOn("userScripts", [(id) => `const v = @tool:${id}; JSON.stringify = () => ({ toString: 1 }); return { a: 1 }`]);
    assert.equal(r.results.length, 1, "the run made its next model call after the exec");
    assert.match(r.results[0], THREW);
    assert.equal(r.log.find((x) => x.kind === "exec-isolated")?.detail?.how, "userScripts", "it was routed to the isolated world");
    const tool = JSON.parse(JSON.stringify((await r.bg.context.__mlRunLog.all()).filter((x) => x.run === r.hash && x.subsystem === "tool")));
    assert.deepEqual(tool.map((x) => [x.kind, x.reason, x.detail?.tool]), [["threw", "run", "exec"]]);
    // Positive control: the same script without the replacement returns its value.
    const ok = await runOn("userScripts", [(id) => `const v = @tool:${id}; return { a: 1 }`]);
    assert.match(ok.results[0], /\{"a":1\}/);
});

test("main world: a page answering an approved exec with a render the run's pointer cannot be described from is the page's result, with no pointer", async () => {
    // The pointer-minting block reads the page's renderOut (tableOf over `columns`, String(value) for latex) after the
    // tool ran: a malformed one ended the run.
    const js = "document.body.remove()";   // not read-only, so it goes to the gate and the page runs it
    for (const renderOut of [{ type: "table", columns: 1, rows: 1 }, { type: "python-out", latex: true, value: { toString: 1 } }]) {
        const r = await runSteps([{ name: "exec", args: { js, token: true } }], { page: () => ({ result: "ran", renderOut }) });
        wentOn(r, 1);
        assert.equal(r.results[0], "ran", "the page's result, with no pointer line");
        assert.deepEqual(r.log.map((x) => [x.kind, x.reason, x.detail?.tool]), [["threw", "run", "exec"]]);
    }
    // Positive control: a well-formed render mints the pointer the model asked for.
    const ok = await runSteps([{ name: "exec", args: { js, token: true } }], { page: () => ({ result: "ran", renderOut: { type: "exec-out", stdout: "ran" } }) });
    wentOn(ok, 1);
    assert.match(ok.results[0], /^ran\n\n\[output token @tool:[0-9a-f]+/);
    assert.deepEqual(ok.log, []);
});

// --- the page's answer to a step that only decides: the read-only survey's page leg, the precheck ---
for (const [label, step, side] of [
    // A survey that reads the page goes there (autoApproveReadonly, on by default); the page answers it.
    ["a read-only survey's page leg", { name: "exec", args: { js: "document.title" } }, (pl) => (pl.readonlyTry ? { readonly: true, result: { toString: 1 } } : {})],
    // click's doomed-action precheck goes to the page; a failed one is returned in place of the gate.
    ["the precheck", { name: "click", args: { selector: "#a" } }, (pl) => (pl.precheck ? { precheckFailed: true, result: { toString: 1 } } : {})],
])
test(`a page answering ${label} with a result that cannot be text is asked about instead of ending the run`, async () => {
    let gates = 0;
    const r = await runSteps([step], { side, page: () => ({ result: "page ran it" }) });
    wentOn(r, 1);
    assert.equal(r.results[0], "page ran it", "the call went through the gate and ran");
    assert.ok(r.bg.tabMessages.some(([, m]) => m?.type === "ML_DEBUG_TO_PAGE" && m.event?.awaitingApproval && ++gates), "the person was asked");
    assert.deepEqual(r.log.map((x) => [x.kind, x.reason, x.detail?.tool]), [["threw", label === "the precheck" ? "precheck" : "readonly", step.name]]);
});

// --- a cancel is still a cancel ---
test("a throw while the run is cancelled ends the run: no further model call", async () => {
    const r = await runSteps([{ name: "click", args: { selector: "#a" } }, { name: "click", args: { selector: "#b" } }], {
        page: (_p, bg, hash) => { bg.send({ type: "CANCEL_RUN", payload: { runId: hash } }); return { result: "clicked", answerMedia: { length: 1 } }; },
    });
    assert.equal(r.modelCalls, 1, "the run did not go on to another model call after the cancel");
    assert.ok(r.end, "the run ended");
    assert.notEqual(r.end.summary, "done");
    assert.deepEqual(r.log, [], "a throw under a cancel is the cancel's, not recorded as a tool's");
});
