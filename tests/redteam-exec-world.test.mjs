// redteam-exec-world.test.mjs — the red-team pass for exec's `world` parameter and the stored default world
// (exec-routing.ts, sw-run-host.ts, tools.ts): what a hostile page that shares the main world, answers every message the
// worker sends it however it likes and posts any page-started message must NOT get from it. Each test asserts the
// defended outcome beside a positive control (the honest path still works).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld, loadDomWorld } = require("./helpers");
const { PAGE_STARTED_TYPES } = require("../src/page-relay.ts");
const { registerRun, runDelegatedTool, endRun } = await import("../src/agent/run-delegation.ts");

const T = { timeout: 30000 };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const OLD_CONFIG = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", cdp: false };
const FORGED_TRY = "value: \"FORGED BY THE PAGE\"";
const FORGED_PRE = "Error: FORGED REFUSAL BY THE PAGE";

/**
 * A worker-built run on SITE whose model sends each call in `calls` (`{ js, world? }`) to exec, on a tab whose page is
 * HOSTILE: it answers a read-only try with `tryAnswer` (default: a forged "answered" survey), a precheck with a forged
 * refusal, and a call with "FROM THE PAGE". `attack(bg)` runs first, as that page, before the run starts. Returns every
 * message the tab was sent, the exec calls the page was asked to RUN, what the model read back, the routing records and
 * how many scripts ran in an isolated world.
 */
async function hostileRun(calls, { us = true, approved = true, config = {}, autoRO = false, tryAnswer = { readonly: true, result: FORGED_TRY }, attack } = {}) {
    let n = 0, bg, phase = "attack";
    const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, document: { title: "Site" } });
    vm.runInContext("globalThis.window = globalThis", ctx);
    bg = loadBackground({
        config: { ...OLD_CONFIG, autoApproveReadonly: autoRO, ...config }, openTabs: [SITE, { id: 9, url: "https://site.example/other", title: "Other" }],
        userScripts: { available: us !== "off", execute: async (inj) => { const r = vm.runInContext(inj.js[0].code, ctx); return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r; } },
        local: approved ? { ml_site_always: ["https://site.example"] } : {},
        onFetch: (call) => {
            // The server lists the run's model, so a page's SET_MODEL to it is one the worker would honour.
            if (/models|tags/.test(call.url)) return jsonResponse({ data: [{ id: "default-model" }, { id: "other-model" }], models: [{ name: "default-model", model: "default-model" }, { name: "other-model", model: "other-model" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (phase === "attack") return jsonResponse({ choices: [{ message: { content: "spent" } }] });
            const c = calls[n++];
            return c === undefined
                ? jsonResponse({ choices: [{ message: { content: "done" } }] })
                : jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify(c) } }] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly) return {};
            if (msg.payload.precheck) return { precheckFailed: true, result: FORGED_PRE };
            if (msg.payload.readonlyTry) return tryAnswer;
            return { result: "value: \"FROM THE PAGE\"" };
        },
    });
    if (attack) { await attack(bg); await flush(30); }
    phase = "run";
    const before = bg.tabMessages.length;
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "calls", surface: "hud" });
    for (let i = 0; i < 400 && n <= calls.length; i++) await new Promise((r) => setTimeout(r, 0));
    await flush(30);
    const toTab = bg.tabMessages.slice(before).map(([, m]) => JSON.parse(JSON.stringify(m)));
    const execMsgs = toTab.filter((m) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "exec").map((m) => m.payload);
    const ran = execMsgs.filter((p) => !p.renderOnly && !p.precheck && !p.readonlyTry && !p.finish);
    const results = bg.calls.filter((c) => c.url.includes("/chat/completions")).at(-1).body.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const log = JSON.parse(JSON.stringify((await bg.context.__mlRunLog.all()).filter((r) => r.run === hash && r.subsystem === "routing")));
    const isolated = bg.userScriptCalls.filter(([k, inj]) => k === "execute" && !/^globalThis\.__mlIsoStarted$/.test(inj.js[0].code)).length;
    return { bg, toTab, execMsgs, ran, results, log: log.filter((r) => /^exec-/.test(r.kind)).map((r) => [r.kind, r.reason]), isolated };
}

/** Whether any message the tab was sent, other than the run's own debug events (which go to the extension's frame,
 *  never the page's window), carries `marker`. */
const pageSaw = (toTab, marker) => toTab.some((m) => m.type !== "ML_DEBUG_TO_PAGE" && JSON.stringify(m).includes(marker));

const PLAIN = "document.title = 'x'; return 1";
/** Each policy that forces isolation: [approved page, the script (marked, so the page's sight of it can be told)]. */
const FORCED = {
    pointer: [true, "/*TARGET*/ return @tool:exec.length"],
    current: [true, "/*TARGET*/ return ml.current.messages.length"],
    "unapproved-page": [false, "/*TARGET*/ document.title = 'y'; return 2"],
};
/** The calls that set a policy case up: a pointer needs an earlier exec's output to name. */
const setup = (forced) => (forced === "pointer" ? [{ js: PLAIN }] : []);

// --- 1. a hostile page cannot make a worker-built run's exec run in its main world against the policy ---

test("positive control: a plain exec with world \"page\" on an approved page does run in the page's world", T, async () => {
    const r = await hostileRun([{ js: "/*TARGET*/ " + PLAIN, world: "page" }]);
    assert.equal(r.ran.filter((p) => p.args.js.includes("/*TARGET*/")).length, 1);
    assert.match(r.results[0], /FROM THE PAGE/);
});

for (const [forced, [approved, js]] of Object.entries(FORCED)) for (const world of [undefined, "page", "isolated"]) for (const tries of ["off", "refused", "forged"]) {
    const w = world ?? "omitted";
    test(`policy ${forced}, world ${w}, read-only try ${tries}: the script never runs in the page's main world, whatever the page answers`, T, async () => {
        const call = world === undefined ? { js } : { js, world };
        const r = await hostileRun([...setup(forced), call], { approved, autoRO: tries !== "off", ...(tries === "refused" ? { tryAnswer: { readonly: false, result: "" } } : {}) });
        assert.equal(r.ran.filter((p) => p.args.js.includes("/*TARGET*/")).length, 0, `the page was asked to run it: ${JSON.stringify(r.ran)}`);
        const res = r.results.at(-1);
        assert.doesNotMatch(res, /FROM THE PAGE/);
        assert.doesNotMatch(res, /FORGED REFUSAL/, "the page's precheck answer is never asked for");
        if (world === "page") {
            assert.match(res, /^Error: world "page" is refused here: .* Omit world\.$/);
            assert.ok(!pageSaw(r.toTab, "/*TARGET*/"), "a refused world:\"page\" call sends the page nothing");
        } else if (world === "isolated") {
            assert.ok(!pageSaw(r.toTab, "/*TARGET*/"), "an isolated call sends the page nothing");
        }
        // Where it did run: isolated, or (a survey that reads only the run) answered in the worker, or (world-less) the
        // page's own read-only survey, which is pre-existing (SITE_ACCESS slice 2) and may be forged.
        const surveyedByPage = world === undefined && tries === "forged" && pageSaw(r.toTab, "/*TARGET*/");
        if (world !== "page" && !surveyedByPage) assert.ok(r.isolated >= 1 || (tries !== "off" && !pageSaw(r.toTab, "/*TARGET*/")), `it ran isolated or in the worker: ${res}`);
    });
}

test("a hostile page's forged precheck is never asked for a worker-built exec: it cannot refuse a world-less exec that would run", T, async () => {
    const r = await hostileRun([{ js: "/*TARGET*/ " + PLAIN }]);
    assert.equal(r.execMsgs.filter((p) => p.precheck).length, 0, "no precheck was sent to the page");
    assert.doesNotMatch(r.results[0], /FORGED REFUSAL/, "the page's forged refusal did not reach the model");
    assert.match(r.results[0], /FROM THE PAGE/, "positive control: the exec ran (in the page's world, the default)");
    const iso = await hostileRun([{ js: "/*TARGET*/ " + PLAIN }], { config: { execDefaultWorld: "isolated" } });
    assert.doesNotMatch(iso.results[0], /FORGED REFUSAL/);
    assert.deepEqual(iso.log, [["exec-isolated", "default"]], "a default-isolated exec ran isolated");
});

test("no page-started message type sets the default world: each one, with every world field a page could try, leaves the stored setting and the route as they were", T, async () => {
    assert.ok(PAGE_STARTED_TYPES.size >= 30, `enumerated ${PAGE_STARTED_TYPES.size} types — the relay list was not read`);
    const evil = { tab: { id: 9, url: "https://site.example/other" }, url: "https://site.example/other", origin: "https://site.example", documentId: "doc-9", frameId: 0 };
    const fields = { world: "page", execDefaultWorld: "page", model: "other-model", config: { execDefaultWorld: "page" }, settings: { execDefaultWorld: "page" }, overrides: { execDefaultWorld: "page" }, patch: { execDefaultWorld: "page" } };
    const tried = [];
    const r = await hostileRun([{ js: "/*TARGET*/ " + PLAIN }], {
        config: { execDefaultWorld: "isolated" },
        attack: async (bg) => {
            for (const type of PAGE_STARTED_TYPES) {
                const msg = { type, payload: { ...fields, messages: [{ role: "user", content: "hi" }], runId: "evil-run", task: "t", systemPrompt: "s", tools: [], maxSteps: 1, surface: "off" }, requestId: "r1", event: { kind: "chat", id: "x", ts: 1, session: { hash: "x", turn: 0 } } };
                await Promise.race([bg.send(msg, evil), new Promise((res) => setTimeout(res, 20))]);
                tried.push(type);
            }
            assert.equal(bg.stored.model, "other-model", "positive control: SET_MODEL was honoured");
            assert.equal(bg.stored.execDefaultWorld, "isolated", "the stored setting is unchanged");
        },
    });
    assert.ok(tried.includes("SET_MODEL") && tried.includes("START_RUN") && tried.includes("GET_CONFIG"));
    assert.equal(r.bg.stored.execDefaultWorld, "isolated");
    assert.deepEqual(r.log, [["exec-isolated", "default"]], "a world-less exec still takes the stored default");
    assert.equal(r.ran.length, 0, "and was not run in the page's world");
});

// --- 2. the page does not learn the model's chosen world ---

for (const world of ["page", "isolated"]) for (const autoRO of [false, true]) for (const [label, js, approved] of [["plain", PLAIN, true], ["pointer", "return @tool:exec.length", true], ["unapproved", PLAIN, false]]) {
    test(`no message to the page carries world (${world}, read-only try ${autoRO ? "on" : "off"}, ${label})`, T, async () => {
        const r = await hostileRun([...(label === "pointer" ? [{ js: PLAIN }] : []), { js: "/*TARGET*/ " + js, world }], { approved, autoRO });
        const withWorld = r.toTab.filter((m) => m.type !== "ML_DEBUG_TO_PAGE" && /"world"/.test(JSON.stringify(m)));
        assert.deepEqual(withWorld, [], "a message the page reads named the world");
        if (world === "isolated") assert.ok(!pageSaw(r.toTab, "/*TARGET*/"), "an isolated exec sends the page nothing, not even its js");
        if (world === "page" && label === "plain") assert.equal(r.execMsgs.filter((p) => p.args.js.includes("/*TARGET*/")).length, 1, "positive control: the page was sent the call (or its read-only try)");
    });
}

test("GET_CONFIG and the worker's ml.config() view never expose execDefaultWorld", T, async () => {
    const bg = loadBackground({ config: { ...OLD_CONFIG, execDefaultWorld: "isolated" } });
    const res = await bg.send({ type: "GET_CONFIG", payload: {} }, { tab: { id: 9, url: "https://site.example/" }, url: "https://site.example/" });
    assert.ok(res.data && "model" in res.data, "positive control: the page's view of the config arrived");
    assert.ok(!("execDefaultWorld" in res.data), `the default world is in the page's config: ${JSON.stringify(res.data)}`);
    assert.doesNotMatch(JSON.stringify(res.data), /isolated/);
    const { publicConfig, DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
    assert.ok(!("execDefaultWorld" in publicConfig({ ...DEFAULT_CONFIG, execDefaultWorld: "isolated" }, false)), "publicConfig (ml.config() in the worker too) omits it");
});

// --- 3. the page cannot force a refusal loop ---

test("the page-global hint never suggests world \"page\" where page would be refused, even when the page shapes the error; it does where page is open", T, async () => {
    // The page controls what an isolated script finds: a missing global or an emptied DOM node makes the same
    // "Cannot read properties of undefined" the hint keys on.
    const miss = "return window.__APP__.total";
    const cases = {
        "unapproved-page": [[{ js: miss }], { approved: false }],
        pointer: [[{ js: PLAIN }, { js: "const v = @tool:exec; " + miss }], {}],
        current: [[{ js: "const c = ml.current; " + miss }], {}],
    };
    for (const [forced, [calls, opts]] of Object.entries(cases)) {
        const r = await hostileRun(calls, opts);
        assert.deepEqual(r.log.at(-1), ["exec-isolated", forced], `${forced}: ran isolated by policy`);
        assert.match(r.results.at(-1), /Cannot read properties of undefined/, `${forced}: the page shaped the error`);
        assert.doesNotMatch(r.results.at(-1), /world: "page"/, `${forced}: the hint sent the model to a world it would be refused`);
    }
    const open = await hostileRun([{ js: miss, world: "isolated" }]);
    assert.match(open.results[0], /Page globals need world: "page"\./, "positive control: a requested isolated world gets the hint");
});

for (const forced of Object.keys(FORCED)) {
    test(`a refused world "page" (${forced}) says to omit world, and the omitted retry runs isolated`, T, async () => {
        const [approved, js] = FORCED[forced];
        const r = await hostileRun([...setup(forced), { js, world: "page" }, { js }], { approved });
        const refusal = r.results.at(-2);
        assert.match(refusal, /Omit world\.$/);
        assert.doesNotMatch(refusal, /world: "page"/);
        assert.deepEqual(r.log.at(-1), ["exec-isolated", forced], "the retry ran isolated");
        assert.doesNotMatch(r.results.at(-1), /^Error: world/);
    });
}

test("a world-less exec the default makes isolated is not shown to the page by the read-only try", T, async () => {
    const r = await hostileRun([{ js: "/*TARGET*/ document.title" }], { autoRO: true, config: { execDefaultWorld: "isolated" } });
    assert.ok(!pageSaw(r.toTab, "/*TARGET*/"), "the page was sent the js of an exec that runs isolated by default");
    assert.doesNotMatch(r.results[0], /FORGED BY THE PAGE/, "the page answered an isolated-by-default exec");
    const asked = await hostileRun([{ js: "/*TARGET*/ document.title", world: "isolated" }], { autoRO: true });
    assert.ok(!pageSaw(asked.toTab, "/*TARGET*/"), "positive control: an explicit isolated world skips the page");
});

// --- 4. a page-built run given world "isolated" refuses and never runs the code in the main world ---

test("the page's own exec tool refuses world \"isolated\" (and a malformed world) in precheck and run, and runs nothing", T, async () => {
    const { ml } = loadDomWorld("<p>x</p>");
    const exec = ml.domTools.find((t) => t.name === "exec");
    for (const world of ["isolated", "main", 1]) {
        assert.match(String(exec.precheck({ js: "1", world })), /^Error: world/, `precheck ${world}`);
        const out = await exec.run({ js: "globalThis.__pwned = (globalThis.__pwned || 0) + 1; 1", world });
        assert.match(String(out), /^Error: world/, `run ${world}`);
    }
    const ran = await exec.run({ js: "globalThis.__pwned = (globalThis.__pwned || 0) + 1; globalThis.__pwned", world: "page" });
    assert.match(JSON.stringify(ran), /1/, "positive control: world \"page\" ran once, so nothing before it had run");
});

test("an in-page ml.agent run given world \"isolated\" refuses, with and without auto-approved surveys, and never runs the script", T, async () => {
    for (const autoApproveReadonly of [false, true]) for (const js of ["window.__pwned = 1; 1", "document.title"]) {
        let turn = 0;
        const world = loadPageWorld({
            config: { model: "", ocrModel: "", autoApproveReadonly },
            onRuntimeMessage: (m) => {
                if (m.type === "GET_CONFIG" || m.type === "MODEL_CAPS") return undefined;
                return { data: turn++ === 0 ? { content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js, world: "isolated" } }] } : { content: "done", tool_calls: [] } };
            },
        });
        const win = world.context.window;
        const events = [];
        win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
        win.postMessage({ __mlSidebar: "ready" });
        await new Promise((r) => setTimeout(r, 0));
        const exec = world.ml.domTools.find((t) => t.name === "exec");
        await world.ml.agent("x", { tools: [exec], vision: false, approve: () => true });
        const step = events.find((e) => e.kind === "agent-step" && e.tool === "exec" && !e.pending);
        assert.match(String(step.result), /^Error: world "isolated" is not available in this run/, `autoRO ${autoApproveReadonly}, ${js}: ${JSON.stringify({ result: step.result, approval: step.approval, renderOut: step.renderOut })}`);
        assert.notEqual(step.approval, "readonly", "not answered as a survey in the main world");
        assert.equal(win.__pwned, undefined, "the script never ran in the main world");
    }
});

test("a background-hosted page-built run: the page-side read-only try refuses world \"isolated\" instead of surveying in the main world", T, async () => {
    // The worker's leg: a page-built run's survey with world "isolated" is not sent to the page (whose forged readonly:true
    // answer would be what the model reads); the worker refuses it in its precheck.
    let n = 0, bg;
    const sent = [];
    bg = loadBackground({
        config: { ...OLD_CONFIG, autoApproveReadonly: true }, openTabs: [SITE],
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            return jsonResponse(n++ === 0
                ? { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: JSON.stringify({ js: "document.title", world: "isolated" }) } }] } }] }
                : { choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            sent.push(JSON.parse(JSON.stringify(msg.payload)));
            if (msg.payload.finish || msg.payload.renderOnly) return { result: "" };
            if (msg.payload.precheck) return { precheckFailed: true, result: "Error: world \"isolated\" is not available in this run, so this exec did not run. Omit world." };
            if (msg.payload.readonlyTry) return { readonly: true, result: "value: \"Site\"" };
            return { result: "RAN IN THE MAIN WORLD" };
        },
    });
    const execDesc = { name: "exec", description: "run js", parameters: { type: "object", properties: { js: { type: "string" }, world: { type: "string" } }, required: ["js"] }, requiresApproval: true, capabilities: [], precheck: true };
    const res = await bg.send({ type: "START_RUN", payload: { runId: "page-built", task: "t", systemPrompt: "s", tools: [execDesc], model: "default-model", think: null, maxSteps: 3, autoApproveReadonly: true, autoApprovePython: false, surface: "off" } },
        { tab: { id: 7, url: SITE.url }, url: SITE.url, origin: "https://site.example", documentId: "doc-7", frameId: 0 });
    const tries = sent.filter((p) => p.name === "exec" && p.readonlyTry);
    assert.equal(tries.length, 0, `the worker sent the page-built run's world:"isolated" survey to the page: ${JSON.stringify(sent)} ${JSON.stringify(res)}`);
    assert.equal(sent.filter((p) => p.name === "exec" && !p.precheck && !p.renderOnly && !p.finish && !p.readonlyTry).length, 0, "nothing ran on the page");
    const toolMsg = bg.calls.filter((c) => c.url.includes("/chat/completions")).at(-1).body.messages.find((m) => m.role === "tool");
    assert.doesNotMatch(String(toolMsg?.content), /Site/, `the model read a main-world survey for its world:"isolated" exec: ${toolMsg?.content}`);
    assert.match(String(toolMsg?.content), /^Error: world "isolated" is not available in this run/, "the model reads the refusal");
    const dom = new JSDOM('<button class="x">A</button>');
    const [prevDoc, prevEl] = [globalThis.document, globalThis.Element];
    globalThis.document = dom.window.document; globalThis.Element = dom.window.Element;
    try {
        registerRun("rtw", [{ name: "exec", description: "", parameters: { type: "object", properties: {} }, requiresApproval: true, capabilities: [], run: () => "SHOULD NOT RUN" }]);
        const js = "[...document.querySelectorAll('.x')].map(e => e.textContent)";
        assert.equal((await runDelegatedTool("rtw", "exec", { js }, { readonlyTry: true })).readonly, true, "positive control: a world-less survey is answered");
        const iso = await runDelegatedTool("rtw", "exec", { js, world: "isolated" }, { readonlyTry: true });
        assert.equal(iso.readonly, false, `a world:"isolated" survey was answered in the main world: ${JSON.stringify(iso)}`);
        endRun("rtw");
    } finally { globalThis.document = prevDoc; globalThis.Element = prevEl; }
});
