// isolated-exec.test.mjs — where an approved exec of a worker-built run runs (exec-routing.ts), and the isolated world
// it runs in when the page must not see what it is given (sw-isolated-exec.ts; docs/spec/SITE_ACCESS.md, part 4).
//
// The rule is pure and tested over every input. The wrapper is run as source in a node:vm context, the way a
// user-script world or a CDP isolated world would run it. The routing runs in the real background bundle, with
// chrome.userScripts played by a vm context per world and CDP by `onDebuggerCommand`.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, streamResponse, loadBackground } = require("./helpers");
const { routeExec, execNames } = await import("../src/sw/exec-routing.ts");
const { isolatedWrapper } = await import("../src/sw/sw-isolated-exec.ts");

const T = { timeout: 10000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const SITE_APPROVED = { ml_site_always: ["https://site.example"] };

// --- the rule: every input ---

const SCRIPTS = {
    plain: "document.title = 'x'; return 1",
    pointer: "return @tool:exec.length",
    deref: "return ml.dereference(\"@tool:exec\").length",
    current: "return ml.current.messages.length",
    both: "return ml.current.messages.length + @tool:exec.length",
};

test("what a script names is read lexically: pointers in any of their forms, ml.current, and nothing in a plain script", () => {
    assert.deepEqual(execNames(SCRIPTS.plain), { current: false, pointers: false });
    assert.deepEqual(execNames(SCRIPTS.pointer), { current: false, pointers: true });
    assert.deepEqual(execNames(SCRIPTS.deref), { current: false, pointers: true });
    assert.deepEqual(execNames(SCRIPTS.current), { current: true, pointers: false });
    assert.deepEqual(execNames(SCRIPTS.both), { current: true, pointers: true });
    assert.deepEqual(execNames("return ml . current"), { current: true, pointers: false }, "spacing does not hide it");
    assert.deepEqual(execNames("const current = 1; return current"), { current: false, pointers: false }, "a local named current is not ml.current");
});

test("the route for every page, script and mechanism", () => {
    // [approved, script, userScripts, cdp] → where (how | reason)
    const ISO = [[true, true], [true, false], [false, true], [false, false]];
    const expect = (approved, kind, us, cdp) => {
        const reason = !approved ? "unapproved-page" : (kind === "current" || kind === "both") ? "current" : kind === "plain" ? "plain" : "pointer";
        if (reason === "plain") return "main/plain";
        if (us) return `isolated/userScripts/${reason}`;
        if (cdp) return `isolated/cdp/${reason}`;
        return reason === "pointer" ? "main/pointer+note" : `refused/${reason}`;
    };
    let n = 0;
    for (const approved of [true, false]) for (const kind of Object.keys(SCRIPTS)) for (const [us, cdp] of ISO) {
        const r = routeExec(SCRIPTS[kind], approved, { userScripts: us, cdp });
        const got = r.where === "isolated" ? `isolated/${r.how}/${r.reason}` : r.where === "main" ? `main/${r.reason}${r.note ? "+note" : ""}` : `refused/${r.reason}`;
        assert.equal(got, expect(approved, kind, us, cdp), `approved=${approved} ${kind} userScripts=${us} cdp=${cdp}`);
        n++;
    }
    assert.equal(n, 40);
});

test("a refusal and the fallback each say what to turn on; the refusal for ml.current says how to read it instead", () => {
    const none = { userScripts: false, cdp: false };
    assert.match(routeExec(SCRIPTS.current, true, none).result, /Read ml\.current in a read-only exec and act on the page in the next\..*Settings → Advanced → "Debugger-based actions and user scripts"/);
    assert.match(routeExec(SCRIPTS.plain, false, none).result, /not approved.*Settings → Advanced → "Debugger-based actions and user scripts"/);
    assert.match(routeExec(SCRIPTS.pointer, true, none).note, /page.s own world.*Settings → Advanced → "Debugger-based actions and user scripts"/);
    for (const s of [routeExec(SCRIPTS.current, true, none).result, routeExec(SCRIPTS.plain, false, none).result, routeExec(SCRIPTS.pointer, true, none).note])
        assert.doesNotMatch(s, / {2}/, "model-facing text is never padded");
});

// --- the wrapper, run as an isolated world runs it ---

/** A vm context standing in for a world: its own globals, `window` among them, and a silent console. */
function world(extra = {}) {
    const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, ...extra });
    vm.runInContext("globalThis.window = globalThis", ctx);
    return ctx;
}

/** Run one form of a script through the wrapper in a fresh vm context; returns the wrapped result and the console
 *  lines streamed. */
async function runWrapped(inner, bindings, { stream = false, ctx } = {}) {
    const streamed = [];
    const context = ctx ?? world({ __emit: (t) => streamed.push(t) });
    const out = await vm.runInContext(isolatedWrapper(inner, bindings, "N1", stream ? "__emit(__t)" : ""), context);
    return { out: JSON.parse(JSON.stringify(out)), streamed, context };
}

const READS = [{ ref: "@tool:exec", pipe: [], value: "FIRST OUTPUT" }, { ref: "@tool:exec", pipe: ["head 1"], value: "FIRST" }, { ref: "@tool:bad", pipe: [], error: "MemoryFault: gone" }];
const CURRENT = { current: { run: { id: "r1" }, messages: [{ role: "user", content: "the task" }], meta: {}, log: [{ kind: "x" }] }, logText: "x happened" };

test("the wrapper binds the pointer reads sent with the call, the pipe as a string or stages, and refuses the rest", async () => {
    const b = { reads: READS };
    assert.equal((await runWrapped("(ml.dereference('@tool:exec'))", b)).out.v, "FIRST OUTPUT");
    assert.equal((await runWrapped("(ml.dereference('@tool:exec', { pipe: ' head 1 ' }))", b)).out.v, "FIRST", "a string pipe is split as the page splits it");
    assert.equal((await runWrapped("(ml.dereference('@tool:exec', { pipe: ['head 1'] }))", b)).out.v, "FIRST");
    assert.match((await runWrapped("(ml.dereference('@tool:other'))", b)).out.threw, /was not named in the script/);
    assert.match((await runWrapped("(ml.dereference('@tool:bad'))", b)).out.threw, /MemoryFault: gone/);
});

test("a pointer value has the page's shape: a String with its facts; what needs the worker mid-script says so", async () => {
    const reads = [{ ref: "@tool:t", pipe: [], value: "[1,2]", meta: { kind: "table", id: "t", tool: "fetch_url", step: 2, label: "the table", table: { columns: ["a"] } } }];
    const r = await runWrapped("{ const v = ml.dereference('@tool:t'); return [v.length, v.split(',').length, v + '', v.json[1], v.id, v.tool, v.step, v.label, v.type, typeof v.pipe] }", { reads });
    assert.equal(r.out.v, JSON.stringify([5, 2, "[1,2]", 2, "t", "fetch_url", 2, "the table", "table", "function"]));
    assert.match((await runWrapped("(ml.dereference('@tool:t').table)", { reads })).out.threw, /\.table is not available in an isolated exec yet\. Read it in a read-only exec/);
    assert.match((await runWrapped("(ml.dereference('@tool:t').pipe('head 1'))", { reads })).out.threw, /\.pipe\(\) is not available/);
    assert.equal((await runWrapped("(ml.dereference('@tool:t').json === ml.dereference('@tool:t').json)", { reads })).out.v, "false", "each read is its own value, as on the page");
});

test("ml.current is the frozen copy with its log text restored; over the cap it is the sentence; absent, the member is refused", async () => {
    const r = await runWrapped("{ const c = ml.current; c.messages.push(1); return [c.messages.length, c.log.text, Object.isFrozen(c)] }", { reads: [], current: CURRENT });
    assert.match(r.out.threw ?? "", /object is not extensible|read only|frozen|Cannot add/, "the snapshot cannot be changed");
    const ok = await runWrapped("([ml.current.messages[0].content, ml.current.log.text, Object.isFrozen(ml.current)])", { reads: [], current: CURRENT });
    assert.equal(ok.out.v, JSON.stringify(["the task", "x happened", true]));
    assert.match((await runWrapped("(ml.current)", { reads: [], currentError: "ml.current is 600000 characters here" })).out.threw, /600000 characters/);
    const none = await runWrapped("(ml.current)", { reads: [] });
    assert.match(none.out.threw, /ml\.current is not available.*it has ml\.dereference\./, "the sentence does not offer what is absent");
});

test("any other ml member throws a sentence naming what the isolated world has; ml cannot be written to", async () => {
    const r = await runWrapped("(ml.fetch('https://x.example'))", { reads: [], current: CURRENT });
    assert.match(r.out.threw, /ml\.fetch is not available in this exec, which runs in an isolated world: it has ml\.current, ml\.dereference\./);
    assert.equal((await runWrapped("{ ml.dereference = () => 'forged'; return ml.dereference('@tool:exec') }", { reads: READS })).out.v ?? "", "FIRST OUTPUT");
    assert.equal((await runWrapped("(typeof ml.then)", { reads: [] })).out.v, "undefined", "awaiting ml does not throw");
});

test("the console is captured and streamed line by line, and restored afterwards", async () => {
    const r = await runWrapped("{ console.log('a', { b: 1 }); console.warn('w'); return 2 }", { reads: [] }, { stream: true });
    assert.deepEqual([r.out.v, r.out.logs], ["2", ["a {\"b\":1}", "w"]]);
    assert.deepEqual(r.streamed, ["a {\"b\":1}\n", "w\n"]);
    assert.equal(vm.runInContext("console.log.toString().includes('__logs')", r.context), false, "console restored");
});

test("state persists across calls in one world; a throw is returned with the lines logged before it", async () => {
    const first = await runWrapped("{ state.n = 41; return 0 }", { reads: [] });
    const second = await runWrapped("(state.n + 1)", { reads: [] }, { ctx: first.context });
    assert.equal(second.out.v, "42");
    const t = await runWrapped("{ console.log('before'); throw new Error('boom') }", { reads: [] });
    assert.match(t.out.threw, /boom/);
    assert.deepEqual(t.out.logs, ["before"]);
});

// --- the routing, in the worker ---

/**
 * A worker-built run on SITE whose model runs each script in `scripts` as an approved exec. `us`: chrome.userScripts
 * present (a vm context per world runs what it is given), `"off"` for present but not allowed, absent otherwise.
 * `cdp`: the CDP setting, with `onDebuggerCommand` playing the browser. Returns what reached the page, what the user-script
 * worlds were given, what the model read back, and the routing records.
 */
async function isoRun(scripts, { approved = true, us, cdp = false, onDebuggerCommand, stream = false, local = {}, onExecute, onBg } = {}) {
    let n = 0, bg;
    const worlds = new Map();
    const userScripts = us === undefined ? undefined : {
        available: us !== "off",
        execute: async (inj) => {
            const ctx = worlds.get(inj.worldId) ?? world({ chrome: { runtime: { sendMessage: (m) => bg.emitUserScriptMessage(m, { tab: { id: 7 }, frameId: 0 }) } } });
            worlds.set(inj.worldId, ctx);
            if (onExecute) onExecute(bg, inj);
            const r = vm.runInContext(inj.js[0].code, ctx);
            return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r;
        },
    };
    bg = loadBackground({
        config: { ...config, autoApproveReadonly: false, cdp }, openTabs: [SITE], userScripts, onDebuggerCommand,
        local: { ...(approved ? SITE_APPROVED : {}), ...local },
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const js = scripts[n++];
            if (stream) return js === undefined
                ? streamResponse(['data: {"choices":[{"delta":{"content":"done"}}]}\n', "data: [DONE]\n"])
                : streamResponse([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: "exec", arguments: JSON.stringify({ js }) } }] } }] })}\n`, 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n', "data: [DONE]\n"]);
            return js === undefined
                ? jsonResponse({ choices: [{ message: { content: "done" } }] })
                : jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ js }) } }] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: "value: \"FROM THE PAGE\"" };
        },
    });
    onBg?.(bg);
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "scripts", surface: "hud", ...(stream ? { stream: true } : {}) });
    for (let i = 0; i < 400 && n <= scripts.length; i++) await new Promise((r) => setTimeout(r, 0));
    await flush(30);
    const toPage = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "exec" && !m.payload.renderOnly && !m.payload.precheck && !m.payload.readonlyTry).map(([, m]) => JSON.parse(JSON.stringify(m.payload)));
    const chatCalls = bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const results = chatCalls.at(-1).body.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const log = JSON.parse(JSON.stringify((await bg.context.__mlRunLog.all()).filter((r) => r.run === hash && r.subsystem === "routing" && /^exec-/.test(r.kind))));
    const injected = bg.userScriptCalls.filter(([k]) => k === "execute").map(([, inj]) => JSON.parse(JSON.stringify(inj)));
    const live = panel.messages.map((m) => m.__mlDebug).filter((e) => e?.kind === "agent-step" && typeof e.streamOutput === "string").map((e) => e.streamOutput);
    return { bg, hash, toPage, results, log, injected, live };
}

const FIRST = "window.a = 1; return 1";

test("a script naming a pointer runs in the run's own user-script world: its value never reaches the page", T, async () => {
    const { toPage, results, log, injected, hash } = await isoRun([FIRST, "window.b = 1; return @tool:exec.toUpperCase()"], { us: true });
    assert.equal(toPage.length, 1, "only the first (plain) script ran in the page's world");
    assert.ok(toPage.every((p) => !p.reads?.length), "the page was sent no pointer value");
    const isoRuns = injected.filter((i) => !/^globalThis\.__mlIsoStarted$/.test(i.js[0].code));
    assert.ok(isoRuns.length >= 1);
    assert.ok(isoRuns.every((i) => i.worldId === `wml-${hash}` && JSON.stringify(i.target) === JSON.stringify({ tabId: 7, documentIds: ["doc-7"] })), "the run's world, in the document it was routed for");
    assert.match(results[1], /FROM THE PAGE/i, "the value the page returned for the first script is what the pointer holds");
    assert.match(results[1], /Ran in an isolated world because it reads pointer values/);
    assert.deepEqual(log.map((r) => [r.kind, r.reason, r.detail?.how]), [["exec-main", "plain", undefined], ["exec-isolated", "pointer", "userScripts"]]);
});

test("a script reading ml.current is given the run's context in its world, and the model reads it back", T, async () => {
    const { toPage, results, log } = await isoRun(["window.b = 1; return ml.current.messages.find(m => m.role === 'user').content"], { us: true });
    assert.equal(toPage.length, 0);
    assert.match(results[0], /scripts/, `the task, read from ml.current; got ${results[0]}`);
    assert.deepEqual(log.map((r) => [r.kind, r.reason]), [["exec-isolated", "current"]]);
});

test("on a site that is not approved, even a plain approved exec runs isolated; with no isolation it is refused and nothing runs", T, async () => {
    const iso = await isoRun(["document.title = 'x'; return document.title"], { approved: false, us: true });
    assert.equal(iso.toPage.length, 0);
    assert.match(iso.results[0], /isolated world because this site is not approved/);
    const none = await isoRun(["document.title = 'x'; return 1"], { approved: false, us: "off" });
    assert.equal(none.toPage.length, 0, "refused: not sent to the page");
    assert.equal(none.injected.length, 0);
    assert.match(none.results[0], /^Error: this page's site is not approved/);
    assert.deepEqual(none.log.map((r) => [r.kind, r.reason]), [["exec-refused", "unapproved-page"]]);
});

test("with no isolation on an approved site: a pointer script runs in the page as before, with a note; an ml.current script is refused", T, async () => {
    const ptr = await isoRun([FIRST, "window.b = 1; return @tool:exec.length"], { us: "off" });
    assert.equal(ptr.toPage.length, 2);
    assert.match(ptr.toPage[1].reads[0].value, /FROM THE PAGE/, "sent with the call, as before part 4");
    assert.match(ptr.results[1], /Ran in the page's own world, where its scripts can read the pointer values/);
    const cur = await isoRun(["window.b = 1; return ml.current.messages.length"], { us: "off" });
    assert.equal(cur.toPage.length, 0);
    assert.match(cur.results[0], /^Error: this exec reads ml\.current/);
});

test("a script that only names a pointer it cannot have is still isolated: what it names decides, not what it gets", T, async () => {
    const { toPage, results } = await isoRun(["return @tool:abcdef1.length"], { us: true });
    assert.equal(toPage.length, 0);
    assert.match(results[0], /Error: .*abcdef1|Error: .*not named|MemoryFault|No tool output/i, results[0]);
});

test("live console lines from the user-script world reach the run only under the call's nonce, from the run's tab", T, async () => {
    const { live, results } = await isoRun(["window.b = 1; console.log('live line'); return @tool:exec"], {
        us: true, stream: true,
        // While the call is in flight: a line with a guessed nonce, and one from another tab with the right one.
        onExecute: (bg, inj) => {
            const nonce = /__mlIsoStarted = "([0-9a-f]+)"/.exec(inj.js[0].code)?.[1];
            bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce: "0".repeat(32), text: "FORGED NONCE\n" }, { tab: { id: 7 }, frameId: 0 });
            if (nonce) bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce, text: "FORGED TAB\n" }, { tab: { id: 9 }, frameId: 0 });
            if (nonce) bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce, text: "FORGED FRAME\n" }, { tab: { id: 7 }, frameId: 3 });
        },
    });
    assert.match(results[0], /live line/);
    assert.ok(live.some((o) => o.includes("live line")), `the line streamed live: ${JSON.stringify(live)}`);
    assert.ok(live.every((o) => !/FORGED/.test(o)), JSON.stringify(live));
});

// --- the CDP isolated world ---

/** A CDP fake whose isolated world (context 11) runs what it is given in a vm context, its binding raising
 *  `Runtime.bindingCalled` from that context as Chrome does; the page's own context is 1. `w.bg` must be set first. */
function cdpWorld() {
    const w = { calls: [], bg: undefined };
    const ctx = world({ __mlIsoStream: (payload) => w.bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 11, payload }) });
    w.onDebuggerCommand = async (method, params) => {
        w.calls.push([method, JSON.parse(JSON.stringify(params ?? {}))]);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 11 };
        if (method === "Runtime.evaluate") {
            if (params.contextId !== 11) return { exceptionDetails: { text: "evaluated outside the isolated world" } };
            try { return { result: { value: JSON.parse(JSON.stringify(await vm.runInContext(params.expression, ctx))) } }; }
            catch (e) { return { exceptionDetails: { text: String(e), exception: { description: `${e.name}: ${e.message}` } } }; }
        }
        return {};
    };
    return w;
}

test("with CDP on and no user scripts, the script runs in a CDP isolated world, never the page's context", T, async () => {
    const w = cdpWorld();
    const { toPage, results, log, hash } = await isoRun([FIRST, "window.b = 1; return 'x' + @tool:exec.length"], { cdp: true, onDebuggerCommand: w.onDebuggerCommand, onBg: (bg) => { w.bg = bg; } });
    assert.equal(toPage.length, 1, "only the plain first script went to the page");
    assert.match(results[1], /^x\d+/, results[1]);
    const created = w.calls.find(([m]) => m === "Page.createIsolatedWorld");
    assert.deepEqual(created?.[1], { frameId: "F1", worldName: `wml-${hash}`, grantUniveralAccess: false });
    assert.ok(w.calls.filter(([m]) => m === "Runtime.evaluate").every(([, p]) => p.contextId === 11), "every evaluation was in the isolated world");
    assert.deepEqual(log.map((r) => [r.kind, r.detail?.how]), [["exec-main", undefined], ["exec-isolated", "cdp"]]);
});

test("the CDP world's live-output binding is installed in that world only, and a call from another context is ignored", T, async () => {
    const w = cdpWorld();
    const { results, live } = await isoRun([FIRST, "window.b = 1; console.log('real'); return @tool:exec.length"], {
        cdp: true, stream: true, onBg: (bg) => { w.bg = bg; },
        onDebuggerCommand: async (method, params) => {
            if (method === "Runtime.evaluate" && params.contextId === 11) {
                // The page's own context calls a binding of that name while the script runs, even holding the call's nonce.
                const nonce = /__mlIsoStarted = "([0-9a-f]+)"/.exec(params.expression)?.[1];
                w.bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 1, payload: JSON.stringify({ nonce, text: "FORGED CONTEXT\n" }) });
            }
            return w.onDebuggerCommand(method, params);
        },
    });
    const binding = w.calls.find(([m]) => m === "Runtime.addBinding");
    assert.equal(binding?.[1].executionContextName, binding?.[1].executionContextName?.startsWith("wml-") ? binding[1].executionContextName : "wml-<run>", `scoped to the world: ${JSON.stringify(binding)}`);
    assert.ok(w.calls.findIndex(([m]) => m === "Runtime.addBinding") < w.calls.findIndex(([m]) => m === "Page.createIsolatedWorld"), "installed before the world exists");
    assert.match(results[1], /real/);
    assert.ok(live.some((o) => o.includes("real")), `the line streamed live: ${JSON.stringify(live)}`);
    assert.ok(live.every((o) => !/FORGED/.test(o)), JSON.stringify(live));
});

test("a CDP world created after the tab moved on is never evaluated in: the exec runs in the routed document or nowhere", T, async () => {
    const w = cdpWorld();
    const inner = w.onDebuggerCommand;
    const { toPage, results } = await isoRun([FIRST, "window.b = 1; return @tool:exec.length"], {
        cdp: true, onBg: (bg) => { w.bg = bg; },
        onDebuggerCommand: async (method, params) => {
            // The tab commits another document while the world is being created, so the world belongs to that one.
            if (method === "Page.createIsolatedWorld") w.bg.commit(7, { documentId: "doc-next", url: "https://evil.example/" });
            return inner(method, params);
        },
    });
    assert.ok(w.calls.some(([m]) => m === "Page.createIsolatedWorld"), "positive control: a world was asked for");
    assert.equal(w.calls.filter(([m, p]) => m === "Runtime.evaluate" && p.contextId === 11).length, 0, "nothing was evaluated in it");
    assert.equal(toPage.length, 1, "only the first, plain script reached the page");
    assert.match(results[1], /navigated before it started/);
});
