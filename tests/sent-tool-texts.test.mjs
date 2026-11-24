// sent-tool-texts.test.mjs — what a run reads of its tools is the text of the tools that run it: a run the worker built
// and drives reads each worker tool's text from the tool the worker executes (sw-local-tools.ts `workerFacing`), on
// every start path, on a later turn, with no tab, and after a resume of a session the old code stored; a page's own run
// reads the page-hosted text.
//
// Each test is a run in the real bundle (`dist/background.js` in node:vm, tests/helpers.js `loadBackground`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { modelFacing } = await import("../src/agent/run-assembly.ts");
const { WORKER_TOOL_NAMES } = await import("../src/sw/worker-tools.ts");

const T = { timeout: 30000 };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const fromTab = { tab: { id: 7, url: SITE.url }, url: SITE.url, origin: "https://site.example", frameId: 0 };
const EXT = { id: "ext", url: "chrome-extension://test/chat.html", origin: "chrome-extension://test" };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
/** python_exec as the code before this change stored it for a run the worker built: the page-hosted text. */
const OLD_PY = JSON.parse(readFileSync(new URL("./fixtures/python-exec-page-variant.json", import.meta.url), "utf8"));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(done, cap = 4000) { for (let i = 0; i < cap && !done(); i++) await tick(); return done(); }
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A worker with tab 7 open on an approved site, the model answering "done" to every call. */
function world(more = {}) {
    let bg;
    bg = loadBackground({
        config, openTabs: [SITE], local: { ml_site_always: ["https://site.example"] },
        onFetch: (call) => call.url.includes("/chat/completions") ? jsonResponse({ choices: [{ message: { content: "done" } }] }) : jsonResponse({}),
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type === "RUN_TOOL_IN_PAGE" && msg.payload.finish) return { result: "" };
            return undefined;
        },
        ...more,
    });
    const bodies = () => bg.calls.filter((c) => c.url.includes("/chat/completions")).map((c) => c.body);
    const sent = (i = -1) => bodies().at(i).tools.map((t) => t.function);
    const port = bg.connect("ml-sessions", EXT);
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    let id = 0;
    const cmd = async (command) => {
        const n = ++id;
        port.send({ type: "cmd", id: n, command });
        assert.ok(await until(() => port.messages.some((m) => m.type === "result" && m.id === n)), `${command.type} is answered`);
        return port.messages.find((m) => m.type === "result" && m.id === n).result;
    };
    return { bg, bodies, sent, cmd, panel };
}

/** The text of the python_exec a worker-hosted run has: a namespace kept across cells, `keep`/`expect_ms`, `/files`. */
function assertWorkerPy(tools, where) {
    const py = tools.find((t) => t.name === "python_exec");
    assert.ok(py, `${where}: python_exec is offered`);
    assert.match(py.description, /Names you define persist across your python_exec calls in this run/, `${where}: told its names persist`);
    assert.match(py.description, /Files the person attached to this session are under \/files\/attached\//, `${where}: told where the files are`);
    assert.doesNotMatch(py.description, /STATELESS|No network or filesystem/, `${where}: no page-hosted clause`);
    assert.ok(py.parameters.properties.keep && py.parameters.properties.expect_ms, `${where}: offered keep and expect_ms`);
}

/** Each worker tool the model was sent reads as the tool registered to run it, through the one chain (`modelFacing`). */
function assertSentIsRun(bg, hash, tools, p, where) {
    const running = plain(bg.context.__mlLocalToolTextsForTest(hash)).filter((t) => WORKER_TOOL_NAMES.has(t.name));
    const names = new Set(running.map((t) => t.name));
    const offered = tools.filter((t) => WORKER_TOOL_NAMES.has(t.name) && !PER_CALL.has(t.name));
    assert.ok(offered.length >= 2, `${where}: positive control, the run offers worker tools: ${offered.map((t) => t.name)}`);
    assert.deepEqual(offered.map((t) => t.name).filter((n) => !names.has(n)), [], `${where}: every worker tool offered is registered to run in the worker`);
    const rest = tools.filter((t) => !names.has(t.name));
    const shown = modelFacing([...running, ...rest], p);
    for (const t of offered) {
        const run = shown.find((s) => s.name === t.name);
        assert.equal(t.description, run.description, `${where}: ${t.name}'s description is the running tool's`);
        assert.deepEqual(t.parameters, run.parameters, `${where}: ${t.name}'s parameters are the running tool's`);
    }
}

/** Worker tools the run host builds for each call (worker-look.ts, worker-locate.ts): never registered, so not compared here. */
const PER_CALL = new Set(["look", "locate"]);

/** What a run of this kit carries into the chain: what `assembleRun` read when it built it. */
const FACTS = { unattended: false, autoRO: true, autoPy: false, toolTokens: true };

// --- every start path a person has: the worker-hosted text ---

test("(a) the DevTools panel's composer (PANEL_START_RUN): python_exec reads as the worker-hosted tool that runs it", T, async () => {
    const w = world();
    const r = await w.bg.send({ type: "PANEL_START_RUN", payload: { tabId: 7, task: "t", surface: "devtools" } }, EXT);
    assert.ok(r.data?.hash, `started: ${JSON.stringify(r)}`);
    assert.ok(await until(() => w.bodies().length >= 1));
    assertWorkerPy(w.sent(0), "panel");
    assertSentIsRun(w.bg, r.data.hash, w.sent(0), FACTS, "panel");
});

test("(b) the sidebar's or HUD's composer (USER_START_RUN): python_exec reads as the worker-hosted tool that runs it", T, async () => {
    const w = world();
    const r = await w.bg.send({ type: "USER_START_RUN", payload: { task: "t", surface: "hud" } }, fromTab);
    assert.ok(r.data?.hash, `started: ${JSON.stringify(r)}`);
    assert.ok(await until(() => w.bodies().length >= 1));
    assertWorkerPy(w.sent(0), "hud");
    assertSentIsRun(w.bg, r.data.hash, w.sent(0), FACTS, "hud");
});

test("(c) the chat page (agent.start): python_exec reads as the worker-hosted tool that runs it", T, async () => {
    const w = world();
    const r = await w.cmd({ type: "agent.start", runtime: "local", task: "t", target: { kind: "tab", tabId: 7 } });
    assert.equal(r.ok, true, `agent.start: ${JSON.stringify(r)}`);
    assert.ok(await until(() => w.bodies().length >= 1));
    assertWorkerPy(w.sent(0), "chat page");
    assertSentIsRun(w.bg, r.data.session.hash, w.sent(0), FACTS, "chat page");
});

test("(d) the harness's start hook: python_exec reads as the worker-hosted tool that runs it", T, async () => {
    const w = world();
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "t", surface: "hud" });
    assert.ok(await until(() => w.bodies().length >= 1));
    assertWorkerPy(w.sent(0), "harness");
    assertSentIsRun(w.bg, hash, w.sent(0), FACTS, "harness");
});

test("every worker tool, with ml.sh and answer on too: each text the model reads is the text of the tool that runs", T, async () => {
    // ml.sh is offered only when a process host answers at the run's start (#2130, `shellOffered`), so one answers here.
    const w = world({ config: { ...config, shellEnabled: true, shellRoots: ["/tmp/x"] }, onNative: fakeNativeHost({ landlockAbi: null }).onNative });
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "t", surface: "hud" }, { answer: true });
    assert.ok(await until(() => w.bodies().length >= 1));
    const names = w.sent(0).map((t) => t.name).filter((n) => WORKER_TOOL_NAMES.has(n)).sort();
    assert.deepEqual(names.filter((n) => !PER_CALL.has(n)), [...WORKER_TOOL_NAMES].filter((n) => !PER_CALL.has(n)).sort(), "positive control: the run offers every registered worker tool");
    assertSentIsRun(w.bg, hash, w.sent(0), FACTS, "every tool");
});

// --- later turns: what the stored payload holds is not what the model reads ---

test("the start event records the worker-hosted text the model was sent, and a later message reads it again", T, async () => {
    const w = world({ config: { ...config, debugMode: "devtools" } });
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "t", surface: "hud" });
    assert.ok(await until(() => w.bodies().length >= 1));
    const r = await w.cmd({ type: "session.send", session: { runtime: "local", hash }, text: "more" });
    assert.equal(r.ok, true, `session.send: ${JSON.stringify(r)}`);
    assert.ok(await until(() => w.bodies().length >= 2));
    assertWorkerPy(w.sent(1), "turn 2");
    // The run's start event, which run.json and both exports read its tools from, records what the model was sent.
    const start = w.panel.messages.map((m) => m.__mlDebug).find((e) => e?.kind === "agent" && e.id === hash && e.config?.tools);
    assert.ok(start, "the start event reached the panel");
    assertWorkerPy(plain(start.config.tools), "the start event (what run.json and the exports read)");
});

test("a run whose tab closed: its next turn, with no tab, reads the worker-hosted text", T, async () => {
    const w = world();
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "t", surface: "hud" });
    assert.ok(await until(() => w.bodies().length >= 1 && !w.bg.context.__mlRunStateForTest().controllers.includes(hash)));
    w.bg.closeTab(7);
    await until(() => false, 200);
    const r = await w.cmd({ type: "session.send", session: { runtime: "local", hash }, text: "go on" });
    assert.equal(r.ok, true, `session.send: ${JSON.stringify(r)}`);
    assert.ok(await until(() => w.bodies().length >= 2));
    assertWorkerPy(w.sent(1), "no tab");
});

test("UPGRADE: a session the old code stored, with python_exec's page-hosted text in its payload, reads the worker-hosted text when resumed", T, async () => {
    const runId = "oldpy001";
    // What the code before this change wrote: the page-hosted python_exec text, for a run the worker built.
    const tools = [OLD_PY, { name: "fetch_url", description: "Fetch a URL.", parameters: { type: "object", properties: { url: { type: "string" } } } }]
        .map((t) => ({ ...t, requiresApproval: true, capabilities: [] }));
    const snap = {
        version: "9.9.9", ts: Date.now(), tabId: 7, messages: [{ role: "user", content: "first" }, { role: "assistant", content: "done" }],
        p: {
            runId, task: "first", tools, model: "m", think: null, maxSteps: 5, systemPrompt: "s", surface: "off",
            autoApprovePython: false, autoApproveReadonly: false, builtBy: "worker", crossPage: true,
            rebuild: { toolNames: ["python_exec", "fetch_url"], model: "m", builtBy: "worker", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true },
        },
    };
    const w = world({ local: { ml_site_always: ["https://site.example"], [`ml_bgrun_${runId}`]: snap } });
    await w.bg.context.__mlEvictForTest();
    const r = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash: runId, action: "send", text: "and this", surface: "hud" } }, fromTab);
    assert.equal(r.data, "turn", JSON.stringify(r));
    assert.ok(await until(() => w.bodies().length >= 1));
    assertWorkerPy(w.sent(0), "resumed old session");
    assert.notEqual(w.sent(0).find((t) => t.name === "fetch_url").description, "Fetch a URL.", "fetch_url, a worker tool too, reads as the tool that runs, not the stored text");
});

// --- a page's own run: the page-hosted text, which is what it has ---

test("a page's own ml.agent run (START_RUN) reads python_exec's page-hosted text: its cells are stateless and it has no /files", T, async () => {
    const w = world();
    const tools = [{ name: "python_exec", description: "the page's words", parameters: { type: "object", properties: { code: { type: "string" } } }, requiresApproval: true, capabilities: [] }];
    void w.bg.send({ type: "START_RUN", payload: { runId: "pagerun1", task: "t", systemPrompt: "sys", tools, model: "m", think: null, maxSteps: 5, surface: "off",
        rebuild: { toolNames: ["python_exec"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: false } } }, fromTab);
    assert.ok(await until(() => w.bodies().length >= 1), "the page's run reached the model");
    const py = w.sent(0).find((t) => t.name === "python_exec");
    assert.match(py.description, /Each call is STATELESS/);
    assert.match(py.description, /No network or filesystem here/);
    assert.doesNotMatch(py.description, /\/files\/attached/);
    assert.equal(py.parameters.properties.keep, undefined, "no keep: nothing persists to keep");
});

test("a page-built run handed to the worker, its next turn the worker's: reads the worker-hosted text, as its Python runs in the worker", T, async () => {
    const runId = "handed01";
    const tools = [OLD_PY].map((t) => ({ ...t, requiresApproval: true, capabilities: [] }));
    const snap = {
        version: "9.9.9", ts: Date.now(), tabId: 7, messages: [{ role: "user", content: "t" }, { role: "assistant", content: "ok" }],
        p: { runId, task: "t", systemPrompt: "s", tools, model: "default-model", think: null, maxSteps: 10, surface: "off", crossOrigin: true, pageUrl: SITE.url, pageOrigin: "https://site.example", approvalRouting: "ui",
            rebuild: { toolNames: ["python_exec"], model: "default-model", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } },
    };
    const w = world({ local: { ml_site_always: ["https://site.example"], [`ml_bgrun_${runId}`]: snap, ml_handed_to_worker: [runId] } });
    await until(() => false, 30);
    const r = await w.bg.context.__mlUserRunActionForTest(runId, "send", { text: "more", surface: "hud" });
    assert.equal(r, "turn");
    assert.ok(await until(() => w.bodies().length >= 1), "positive control: the handed run's turn reached the model");
    // The hand-over stores it as the worker's (sw-run-host.ts `storedP`), so its later turns are a run the worker built and drives.
    assertWorkerPy(w.sent(0), "handed run");
});
