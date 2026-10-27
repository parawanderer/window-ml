// redteam-isolated.test.mjs — the red-team pass for the isolated exec (exec-routing.ts, sw-isolated-exec.ts; site access
// slice 2 part 4): what a hostile page must NOT get from an approved exec of a worker-built run, each property a test.
//
// The page is played by `onTabMessage` (what reaches it is every RUN_TOOL_IN_PAGE it is sent) and by `bg.send` with the
// run's own tab as sender (what it can post). A user-script world is a vm context per world; the CDP world is a fake
// whose isolated context is 11 and the page's own context is 1. An open hole is a `todo` naming what is open.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, streamResponse, loadBackground } = require("./helpers");
const { isolatedWrapper } = await import("../src/sw/sw-isolated-exec.ts");
const { CLOSED_ROOTS_EVENT } = await import("../src/ids.ts");

const T = { timeout: 15000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const SITE_URL = "https://site.example/page";
const EVIL_URL = "https://evil.example/";
const SITE_APPROVED = { ml_site_always: ["https://site.example"] };
/** What the run's own tab can post: its top frame, on whatever document it now holds. */
const fromTab = (url = SITE_URL, documentId) => ({ tab: { id: 7, url }, url, origin: new URL(url).origin, frameId: 0, ...(documentId ? { documentId } : {}) });

/** A vm context standing in for a world: its own globals, `window` among them, and a silent console. */
function world(extra = {}) {
    const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, ...extra });
    vm.runInContext("globalThis.window = globalThis", ctx);
    return ctx;
}

/**
 * A worker-built run on tab 7 whose model runs each script in `scripts` as an approved exec. The real site gate is on.
 * - `us`: chrome.userScripts present (`true`), present but not allowed (`"off"`), or absent (undefined).
 * - `onDecide(bg, i)`: called while the worker asks whether user scripts are allowed for script `i`, which is AFTER it
 *   read the page's URL for that script's route and BEFORE anything is sent: where a navigation race lands.
 * - `onExecute(bg, injection, worlds)`: called as a user-script injection arrives, before it runs.
 * - `onPageExec(bg, payload, i)`: the page, while a main-world exec of script `i` is in flight; its return replaces the
 *   page's answer.
 * - `onTurn(bg, i)`: called as the model's turn that asks for script `i` is answered, before any of its routing.
 * - `pageValue`: what the page answers for a main-world exec.
 * Returns what reached the page, what the user-script worlds were given, what the model read back, the live output and
 * the routing records.
 */
async function rtRun(scripts, { approved = true, us, cdp = false, onDebuggerCommand, stream = false, onExecute, onDecide, onPageExec, onBg, onTurn, pageValue = "FROM THE PAGE", task = "scripts", tab } = {}) {
    let n = 0, bg;
    const worlds = new Map();
    const theTab = tab ?? { id: 7, url: SITE_URL, title: "Site" };
    const userScripts = us === undefined ? undefined : {
        get available() { if (onDecide && n >= 1) onDecide(bg, n - 1); return us !== "off"; },
        execute: async (inj) => {
            if (onExecute) { const r = await onExecute(bg, inj, worlds); if (r && r.override) return r.value; }
            const ctx = worlds.get(inj.worldId) ?? world({ chrome: { runtime: { sendMessage: (m) => bg.emitUserScriptMessage(m, { tab: { id: 7 }, frameId: 0 }) } } });
            worlds.set(inj.worldId, ctx);
            const r = vm.runInContext(inj.js[0].code, ctx);
            return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r;
        },
    };
    const toolCall = (js) => ({ id: `c${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ js }) } });
    bg = loadBackground({
        siteGate: true,
        config: { ...config, autoApproveReadonly: false, cdp }, openTabs: [theTab], userScripts, onDebuggerCommand,
        local: approved ? SITE_APPROVED : {},
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return new Response(JSON.stringify({ ok: true, url: call.url }), { headers: { "content-type": "application/json" } });
            const js = scripts[n++];
            onTurn?.(bg, n - 1);
            if (stream) return js === undefined
                ? streamResponse(['data: {"choices":[{"delta":{"content":"done"}}]}\n', "data: [DONE]\n"])
                : streamResponse([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: "exec", arguments: JSON.stringify({ js }) } }] } }] })}\n`, 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n', "data: [DONE]\n"]);
            return js === undefined
                ? jsonResponse({ choices: [{ message: { content: "done" } }] })
                : jsonResponse({ choices: [{ message: { content: null, tool_calls: [toolCall(js)] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") { bg.__hash = msg.payload?.runId; return { pageInfo: "" }; }
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            if (onPageExec) { const r = await onPageExec(bg, msg.payload, n - 1); if (r) return r; }
            return { result: `value: ${JSON.stringify(pageValue)}` };
        },
    });
    onBg?.(bg);
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task, surface: "hud", ...(stream ? { stream: true } : {}) });
    for (let i = 0; i < 600 && n <= scripts.length; i++) await new Promise((r) => setTimeout(r, 0));
    await flush(40);
    const allToPage = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE").map(([, m]) => JSON.parse(JSON.stringify(m.payload)));
    const toPage = allToPage.filter((p) => p.name === "exec" && !p.renderOnly && !p.precheck && !p.readonlyTry);
    const chatCalls = bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const results = chatCalls.at(-1).body.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const log = JSON.parse(JSON.stringify((await bg.context.__mlRunLog.all()).filter((r) => r.run === hash && r.subsystem === "routing" && /^exec-/.test(r.kind))));
    const injected = bg.userScriptCalls.filter(([k]) => k === "execute").map(([, inj]) => JSON.parse(JSON.stringify(inj)));
    const live = panel.messages.map((m) => m.__mlDebug).filter((e) => e?.kind === "agent-step" && typeof e.streamOutput === "string").map((e) => e.streamOutput);
    return { bg, hash, allToPage, toPage, results, log, injected, live, worlds, theTab };
}

/** The browser commits `url` on tab 7 as document `doc`, and that document re-adopts the run a moment later, as a real
 *  tab reports a navigation (webNavigation.onCommitted, then the new document's content script). */
function navigateTab(bg, hash, doc, url, delay = 5) {
    bg.commit(7, { documentId: doc, url });
    setTimeout(() => { void bg.send({ type: "RUN_READOPTED", payload: { runId: hash, pageInfo: `URL: ${url}` } }, fromTab(url, doc)); }, delay);
}

const isProbe = (inj) => /^globalThis\.__mlIsoStarted$/.test(inj.js[0].code);
const FIRST = "window.a = 1; return 1";

// --- 1. what the page can read from an isolated exec ---

test("a hostile page on the run's tab gets no pointer value and no part of ml.current from an isolated exec, in any message it is sent", T, async () => {
    const MARK = "TASK-SECRET-7781";
    const r = await rtRun([
        "window.b = 1; return ml.current.messages.find(m => m.role === 'user').content",   // isolated: current
        "window.b = 1; return 'again ' + @tool:exec",                                        // isolated: pointer to the secret
        "document.title = 'x'; return 2",                                                    // main: plain
    ], { us: true, task: `${MARK} scripts` });
    // Positive control: the secret really was read into the run, twice, and a plain script really did reach the page.
    assert.match(r.results[0], new RegExp(MARK), r.results[0]);
    assert.match(r.results[1], new RegExp(`again .*${MARK}`), r.results[1]);
    assert.equal(r.toPage.length, 1, "the plain script ran in the page's world");
    assert.deepEqual(r.log.map((x) => [x.kind, x.reason]), [["exec-isolated", "current"], ["exec-isolated", "pointer"], ["exec-main", "plain"]]);
    for (const p of r.allToPage) assert.ok(!JSON.stringify(p).includes(MARK), `a RUN_TOOL_IN_PAGE carried the secret: ${JSON.stringify(p).slice(0, 300)}`);
    // Every other message to the tab that the content script hands to the page's window (ML_DEBUG_TO_PAGE is the
    // shell's alone, content.ts:103).
    const other = r.bg.tabMessages.map(([, m]) => m).filter((m) => m.type !== "ML_DEBUG_TO_PAGE" && m.type !== "RUN_TOOL_IN_PAGE");
    for (const m of other) assert.ok(!JSON.stringify(m).includes(MARK), `${m.type} carried the secret`);
});

test("an isolated exec mints nothing the page can spend: no fetch grant for the URL it spells out, no live-output sink", T, async () => {
    // The script spells a URL inside ml.fetch("…"), which mints `fetchUrls` for a main-world exec (sw-run-host.ts), and
    // streams. While each call is in flight the page (the run's own tab, top frame) fetches that URL and posts a line
    // into the run's live output.
    const URL_ = "https://data.example/secret.json";
    const SCRIPT = (k) => `window.b = 1; const f = () => ml.fetch("${URL_}"); console.log("real ${k}"); return ${k === "iso" ? "ml.dereference('@tool:exec').length" : "2"}`;   // the call form parses as JS, so a grant minted from it would name the URL
    const attempts = [];
    const pagePokes = async (bg, hash, tag) => {
        void bg.send({ type: "PAGE_TOOL_STREAM", runId: hash, chunk: `FORGED STREAM ${tag}\n` }, fromTab());
        attempts.push([tag, await bg.send({ type: "FETCH_URL", payload: { url: URL_ } }, fromTab())]);
        await new Promise((res) => setTimeout(res, 120));   // past the fan's throttle
    };
    const r = await rtRun([FIRST, SCRIPT("iso"), SCRIPT("main")], {
        us: true, stream: true,
        onExecute: async (bg, inj) => { if (!isProbe(inj) && /real iso/.test(inj.js[0].code)) await pagePokes(bg, bg.__hash, "iso"); },
        onPageExec: async (bg, payload) => { if (/real main/.test(payload.args.js)) await pagePokes(bg, bg.__hash, "main"); return null; },
    });
    const fetched = r.bg.calls.filter((c) => c.url === URL_).length;
    // Positive control: the same pokes during the MAIN-world exec are honoured, so the oracle can see them.
    const main = attempts.find(([t]) => t === "main")?.[1];
    assert.ok(main && !main.error, `the main-world exec's grant let the page fetch: ${JSON.stringify(main)}`);
    assert.ok(r.live.some((o) => o.includes("FORGED STREAM main")), "a page line during a main-world exec reaches the live output (its world is the page's)");
    // The defended outcome during the isolated exec.
    const iso = attempts.find(([t]) => t === "iso")?.[1];
    assert.ok(iso, "the page tried during the isolated exec");
    assert.match(String(iso.error ?? ""), /Refused/, `the page fetched on the isolated exec's grant: ${JSON.stringify(iso)}`);
    assert.equal(fetched, 1, "only the main-world exec's fetch reached the network");
    assert.ok(r.live.every((o) => !o.includes("FORGED STREAM iso")), `a page line reached the isolated exec's live output: ${JSON.stringify(r.live)}`);
    assert.ok(r.live.some((o) => o.includes("real iso")), "the isolated exec's own line streamed");
    assert.ok(!r.results[1].includes("FORGED"), r.results[1]);
});

// --- 2. what the page can write into an isolated exec's output ---

test("a user-script line is taken only from the run's tab, top frame, under the call's nonce: every sender shape a page could hold is refused", T, async () => {
    const forged = [];
    const r = await rtRun(["window.b = 1; console.log('real'); return @tool:exec"], {
        us: true, stream: true,
        onExecute: async (bg, inj) => {
            if (isProbe(inj)) return;
            const nonce = /__mlIsoStarted = "([0-9a-f]+)"/.exec(inj.js[0].code)?.[1];
            const shapes = { "no tab": { frameId: 0 }, "another tab": { tab: { id: 9 }, frameId: 0 }, "a sub-frame": { tab: { id: 7 }, frameId: 2 }, "nothing": {} };
            for (const [k, s] of Object.entries(shapes)) { forged.push(k); bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce, text: `FORGED ${k}\n` }, s); }
            for (const bad of ["", "0".repeat(32), nonce?.toUpperCase(), `${nonce} `]) bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce: bad, text: "FORGED nonce\n" }, { tab: { id: 7 }, frameId: 0 });
            // The page's own channel (window message → content script → runtime.onMessage), holding the right nonce.
            void bg.send({ type: "ISO_EXEC_STREAM", nonce, text: "FORGED via onMessage\n" }, fromTab());
            void bg.send({ type: "PAGE_TOOL_STREAM", runId: bg.__hash, chunk: "FORGED via PAGE_TOOL_STREAM\n" }, fromTab());
            await new Promise((res) => setTimeout(res, 120));   // past the fan's throttle, so the world's own line is its own emit
        },
    });
    assert.ok(forged.length >= 4, "the forgeries were sent while the call was in flight");
    assert.ok(r.live.some((o) => o.includes("real")), `positive control: the world's own line streamed: ${JSON.stringify(r.live)}`);
    const bad = r.live.filter((o) => /FORGED/.test(o));
    assert.deepEqual(bad, [], "a forged line reached the live output");
    assert.ok(!r.results[0].includes("FORGED"), r.results[0]);
});

test("a user-script line with NO frameId is refused (an absent fact never reads as the top frame)", T, async () => {
    const r = await rtRun(["window.b = 1; console.log('real'); return @tool:exec"], {
        us: true, stream: true,
        onExecute: (bg, inj) => {
            if (isProbe(inj)) return undefined;
            const nonce = /__mlIsoStarted = "([0-9a-f]+)"/.exec(inj.js[0].code)?.[1];
            bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce, text: "FORGED no frame\n" }, { tab: { id: 7 } });
            return new Promise((res) => setTimeout(res, 120));
        },
    });
    assert.ok(r.live.some((o) => o.includes("real")), `positive control: ${JSON.stringify(r.live)} ${r.results}`);
    assert.ok(r.live.every((o) => !o.includes("FORGED no frame")), JSON.stringify(r.live));
});

/** A CDP fake whose isolated world (context 11) runs what it is given in a vm context; the page's own context is 1. */
function cdpWorld({ createdContext = 11 } = {}) {
    const w = { calls: [], bg: undefined };
    const ctx = world({ __mlIsoStream: (payload) => w.bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 11, payload }) });
    w.onDebuggerCommand = async (method, params) => {
        w.calls.push([method, JSON.parse(JSON.stringify(params ?? {}))]);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
        if (method === "Page.createIsolatedWorld") return createdContext === null ? {} : { executionContextId: createdContext };
        if (method === "Runtime.evaluate") {
            if (params.contextId !== 11) return { result: { value: { __mlWrapped: true, v: "RAN IN THE PAGE'S CONTEXT", logs: [] } } };
            try { return { result: { value: JSON.parse(JSON.stringify(await vm.runInContext(params.expression, ctx))) } }; }
            catch (e) { return { exceptionDetails: { text: String(e), exception: { description: `${e.name}: ${e.message}` } } }; }
        }
        return {};
    };
    return w;
}

test("a CDP binding call is taken only from the isolated world's context on the run's tab: the page's context, another tab and an absent context are refused", T, async () => {
    const w = cdpWorld();
    const r = await rtRun(["window.b = 1; console.log('real'); return @tool:exec.length"], {
        cdp: true, stream: true, onBg: (bg) => { w.bg = bg; },
        onDebuggerCommand: async (method, params) => {
            if (method === "Runtime.evaluate" && params.contextId === 11) {
                const nonce = /__mlIsoStarted = "([0-9a-f]+)"/.exec(params.expression)?.[1];
                const payload = JSON.stringify({ nonce, text: "FORGED\n" });
                w.bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 1, payload });
                w.bg.emitDebuggerEvent({ tabId: 9 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 11, payload });
                w.bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", payload });
                w.bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlCdpStream", executionContextId: 11, payload });
            }
            return w.onDebuggerCommand(method, params);
        },
    });
    assert.ok(r.live.some((o) => o.includes("real")), `positive control: the world's line streamed: ${JSON.stringify(r.live)}`);
    assert.ok(r.live.every((o) => !o.includes("FORGED")), JSON.stringify(r.live));
});

/** A strict-CSP main-world exec through CDP, the page's main world being context `main`: enabling Runtime reports it,
 *  `during(bg)` runs while the wrapper's evaluate is in flight, and the wrapper answers with `logs`. */
async function cdpMainExec(script, { main = 1, during, logs = ["real"] } = {}) {
    let bg;
    const r = await rtRun([script], {
        cdp: true, stream: true,
        onPageExec: async () => ({ result: "Error: this page blocks eval (CSP)", cdpExec: { source: script } }),
        onBg: (b) => { bg = b; },
        onDebuggerCommand: async (method, params) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
            if (method === "Runtime.enable") {
                // Every context of the tab: a frame's (3), an isolated world (11), and the top frame's main world.
                for (const context of [{ id: 3, auxData: { isDefault: true, frameId: "F2" } }, { id: 11, auxData: { isDefault: false, frameId: "F1" } }, { id: main, auxData: { isDefault: true, frameId: "F1" } }])
                    bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.executionContextCreated", { context });
                return {};
            }
            if (method !== "Runtime.evaluate") return {};
            if (/^delete /.test(params.expression)) return {};
            await during?.(bg, params);
            return { result: { value: { __mlWrapped: true, v: "1", logs, dropped: 0 } } };
        },
    });
    return { ...r, evals: r.bg.debuggerCalls.filter((c) => c[2] === "Runtime.evaluate").map((c) => c[3]) };
}
/** The binding the exec installed: its name is random per exec. */
const boundName = (bg) => bg.debuggerCalls.filter((c) => c[2] === "Runtime.addBinding").at(-1)?.[3]?.name;
const bindingCall = (bg, executionContextId, text) => bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: boundName(bg), executionContextId, payload: JSON.stringify({ text }) });

test("a MAIN-world CDP exec takes __mlCdpStream calls only from the context it evaluated in: another frame's or world's context is refused", T, async () => {
    const SCRIPT = "document.title = 'x'; console.log('real'); return 1";
    const r = await cdpMainExec(SCRIPT, {
        main: 1,
        during: async (bg) => {
            // The binding lands on every context of the tab: a same-process frame (3), an isolated world (11), none.
            bindingCall(bg, 3, "FORGED FROM A FRAME\n");
            bindingCall(bg, 11, "FORGED FROM A WORLD\n");
            bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: boundName(bg), payload: JSON.stringify({ text: "FORGED NO CONTEXT\n" }) });
            await new Promise((res) => setTimeout(res, 120));
            bindingCall(bg, 1, "real\n");
        },
    });
    assert.match(boundName(r.bg) ?? "", /^__mlCdpStream[0-9a-f]{16}$/, "positive control: the exec bound its stream, under a name of its own");
    const wrapper = r.evals.find((e) => /__mlWrapped/.test(e.expression));
    assert.equal(wrapper?.contextId, 1, "the wrapper is evaluated in the context the listener trusts");
    assert.ok(r.live.some((o) => o.includes("real")), `positive control: its line streamed: ${JSON.stringify(r.live)}`);
    assert.ok(r.live.every((o) => !o.includes("FORGED")), `another context's line reached the exec's live output: ${JSON.stringify(r.live)}`);
});

test("a MAIN-world CDP exec's wrapper deletes __mlCdpStream from the page's global in its finally, and the page's console is never replaced", T, async () => {
    const r = await cdpMainExec("console.log('real'), 1");   // an expression, so its first form is the one that runs
    const wrapper = r.evals.find((e) => /__mlWrapped/.test(e.expression))?.expression;
    assert.ok(wrapper, "positive control: the wrapper was evaluated");
    // Run it in a page of its own, with the binding and a console the page owns.
    const page = world();
    const pageConsole = page.console;
    const lines = [];
    vm.runInContext(`globalThis.${boundName(r.bg)} = (p) => __sent.push(p)`, Object.assign(page, { __sent: lines }));
    const out = await vm.runInContext(wrapper, page);
    assert.deepEqual(JSON.parse(JSON.stringify(out.logs)), ["real"], "positive control: the script's own line was collected");
    assert.equal(lines.length, 1, "positive control: and streamed through the binding");
    assert.equal(vm.runInContext("Object.getOwnPropertyNames(globalThis).some((k) => k.startsWith('__mlCdpStream'))", page), false, "the binding is still on the page's global after the exec");
    assert.equal(page.console, pageConsole, "the page's console object was replaced");
});

test("the model reads a MAIN-world exec's console as one the page can write into; an isolated exec's stays plain", T, async () => {
    const main = await cdpMainExec("console.log('real'); return 1");
    assert.match(main.results[0], /^page-writable \(ran in page world\):\nconsole:\nreal\n\nvalue: 1/, main.results[0]);
    const iso = await rtRun([FIRST, "window.b = 1; console.log('real'); return @tool:exec.length"], { us: true });
    assert.match(iso.results[1], /^console:\nreal/, JSON.stringify(iso.results));
});

test("the page cannot write into a MAIN-world CDP exec's live output through __mlCdpStream", { ...T, todo: "Inherent while the exec runs in the page's world: the page's own scripts run in the very context the listener trusts and can call the binding (or take it before the wrapper starts, or rewrite the builtins the collector calls), and nothing in a bindingCalled event tells them apart. The binding's random per-exec name stops only a page that defines an accessor under it beforehand: the page enumerates the global while the exec runs. What holds instead: other contexts are refused, the global is deleted after the exec, and the model is told the console is page-writable (the tests above)" }, async () => {
    const r = await cdpMainExec("document.title = 'x'; console.log('real'); return 1", {
        main: 1,
        during: async (bg) => {
            bindingCall(bg, 1, "FORGED BY THE PAGE\n");   // the page's own script, in the context the exec runs in
            await new Promise((res) => setTimeout(res, 120));
            bindingCall(bg, 1, "real\n");
        },
    });
    assert.ok(r.live.some((o) => o.includes("real")), `positive control: its line streamed: ${JSON.stringify(r.live)}`);
    assert.ok(r.live.every((o) => !o.includes("FORGED BY THE PAGE")), `a page line reached the exec's live output: ${JSON.stringify(r.live)}`);
});

// --- 3. routing the page can steer ---

test("an exec routed to the page's world on an approved site never runs in the main world of an unapproved page the tab moved to before the send", T, async () => {
    // Positive control: with no navigation the plain script runs in the page's world.
    const calm = await rtRun(["document.title = 'x'; return 1"], { us: "off", onBg: (bg) => bg.commit(7, { documentId: "doc-site", url: SITE_URL }) });
    assert.equal(calm.toPage.length, 1);
    assert.deepEqual(calm.log.map((x) => [x.kind, x.reason]), [["exec-main", "plain"]]);
    // The tab moves to an unapproved site after the route was read and before the send.
    let raced = false;
    const r = await rtRun(["document.title = 'x'; return 1"], {
        us: "off", onBg: (bg) => bg.commit(7, { documentId: "doc-site", url: SITE_URL }),
        onDecide: (bg) => { if (raced) return; raced = true; navigateTab(bg, bg.__hash, "doc-evil", EVIL_URL); },
        onPageExec: async () => null,
    });
    assert.ok(raced, "the navigation raced the route");
    assert.equal(r.toPage.length, 0, `the approved script was sent into the unapproved page's main world: ${JSON.stringify(r.toPage)}`);
});

test("a pointer script that falls back to the page's world on an approved site never carries its values to an unapproved page the tab moved to", T, async () => {
    const SECRET = "SITE-SECRET-41";
    // Positive control: with no navigation the fallback is what the owner chose (values sent to the approved page).
    const calm = await rtRun([FIRST, "window.b = 1; return @tool:exec.length"], { us: "off", pageValue: SECRET, onBg: (bg) => bg.commit(7, { documentId: "doc-site", url: SITE_URL }) });
    assert.equal(calm.toPage.length, 2);
    assert.match(JSON.stringify(calm.toPage[1].reads ?? []), new RegExp(SECRET));
    let raced = false, onEvil = [];
    const r = await rtRun([FIRST, "window.b = 1; return @tool:exec.length"], {
        us: "off", pageValue: SECRET, onBg: (bg) => bg.commit(7, { documentId: "doc-site", url: SITE_URL }),
        onDecide: (bg, i) => { if (i !== 1 || raced) return; raced = true; navigateTab(bg, bg.__hash, "doc-evil", EVIL_URL); },
        onPageExec: async (_bg, payload) => { if (raced) onEvil.push(payload); return null; },
    });
    assert.ok(raced);
    assert.deepEqual(onEvil.filter((p) => JSON.stringify(p).includes(SECRET)).map((p) => p.args.js), [], "a pointer value reached the unapproved page");
    assert.equal(r.log.length, 2);
});

test("with no navigation record (a worker that restarted), the route reads where the tab IS, not the page the run started on", T, async () => {
    // Positive control: still on the approved site, the plain script runs in the page's world.
    const calm = await rtRun(["document.title = 'x'; return 1"], { us: "off" });
    assert.equal(calm.toPage.length, 1);
    const tab = { id: 7, url: SITE_URL, title: "Site" };
    let moved = false;
    // No commit is ever seen by this worker. Before the model asks for the exec, the browser reports the tab on the
    // unapproved site (it navigated before the worker restarted).
    const r = await rtRun(["document.title = 'x'; return 1"], { us: "off", tab, onTurn: () => { tab.url = EVIL_URL; moved = true; } });
    assert.ok(moved);
    assert.equal(r.toPage.length, 0, `an approved exec ran in the main world of a tab the browser says is on ${EVIL_URL}`);
    assert.match(r.results[0], /not approved/);
});

test("an isolated exec runs only in the document its route was decided for", T, async () => {
    let raced = false;
    const r = await rtRun(["window.b = 1; return @tool:exec.length"], {
        us: true, onBg: (bg) => bg.commit(7, { documentId: "doc-site", url: SITE_URL }),
        onDecide: (bg) => { if (raced) return; raced = true; bg.commit(7, { documentId: "doc-evil", url: EVIL_URL }); },
    });
    assert.ok(raced);
    assert.deepEqual(r.log.map((x) => [x.kind, x.reason]), [["exec-isolated", "pointer"]], "positive control: routed isolated");
    const real = r.injected.filter((i) => !isProbe(i));
    assert.ok(real.length >= 1);
    for (const i of real) assert.deepEqual(i.target.documentIds, ["doc-site"], `injected without the decided document: ${JSON.stringify(i.target)}`);
});

test("an isolated exec stopped by a navigation is never run a second time on the document that replaced it", T, async () => {
    let stopped = false, ranOn = [];
    const r = await rtRun(["(window.n = 1, @tool:exec.length)"], {
        us: true, onBg: (bg) => bg.commit(7, { documentId: "doc-site", url: SITE_URL }),
        onExecute: async (bg, inj, worlds) => {
            if (isProbe(inj)) return;
            const doc = stopped ? "doc-evil" : "doc-site";
            ranOn.push(doc);
            if (!stopped) {
                // The expression form starts in the approved document, then the tab navigates: the world it ran in is
                // gone and the call comes back with nothing.
                const ctx = world(); worlds.set(inj.worldId, ctx);
                void vm.runInContext(inj.js[0].code, ctx);
                stopped = true;
                bg.commit(7, { documentId: "doc-evil", url: EVIL_URL });
                worlds.set(inj.worldId, world());   // the new document's world, fresh
                return { override: true, value: undefined };
            }
        },
    });
    assert.ok(stopped, "positive control: the script started in the approved document");
    assert.deepEqual(ranOn, ["doc-site"], `the approved script ran again on the new document: ${JSON.stringify(ranOn)}`);
    assert.match(r.results[0], /stopped before it finished|navigat/i, r.results[0]);
});

test("a strict-page exec the page hands to CDP runs only on the document it was approved on, not one the page navigated to", T, async () => {
    // The page answers a main-world exec with `cdpExec` (it shares the world, and can forge PAGE_TOOL_RESULT besides), then
    // navigates the tab before the worker evaluates the approved source through the debugger.
    const SCRIPT = "document.title = 'x'; console.log('real'); return 1";
    const wrappers = (r) => r.bg.debuggerCalls.filter((c) => c[2] === "Runtime.evaluate" && /__mlWrapped/.test(c[3]?.expression ?? ""));
    const run = (navigate) => {
        const tab = { id: 7, url: SITE_URL, title: "Site" };
        return rtRun([SCRIPT], {
            cdp: true, tab,
            onBg: (bg) => bg.commit(7, { documentId: "doc-site", url: SITE_URL }),
            onPageExec: async (bg) => {
                if (navigate) { tab.url = EVIL_URL; bg.commit(7, { documentId: "doc-evil", url: EVIL_URL }); await flush(); }
                return { result: "Error: this page blocks eval (CSP)", cdpExec: { source: SCRIPT } };
            },
            onDebuggerCommand: async (method, params) => (method === "Runtime.evaluate" && /__mlWrapped/.test(params.expression) ? { result: { value: { __mlWrapped: true, v: "1", logs: ["real"], dropped: 0 } } } : undefined),
        });
    };
    const calm = await run(false);
    assert.equal(wrappers(calm).length, 1, "positive control: with no navigation the approved source ran through CDP");
    const raced = await run(true);
    assert.ok(wrappers(calm).every((c) => c[3].contextId === 1), "positive control: pinned to the page's main-world context");
    assert.deepEqual(wrappers(raced).map((c) => c[3].expression.slice(0, 40)), [], `the approved source ran on the document the page navigated to: ${raced.results[0]}`);
    assert.match(raced.results[0], /navigated before it started/, raced.results[0]);
});

// --- 4. the values spliced into the wrapper's source ---

const EVIL = [
    "\"", "\\", "'", "`${globalThis.PWN = 'tpl'}`", "</script><script>globalThis.PWN = 'tag'</script>",
    " globalThis.PWN = 'ls'", " ", "\ud800", "\udfff", "*/ globalThis.PWN = 'cmt' /*",
    "\"); globalThis.PWN = 'dq'; (\"", "'); globalThis.PWN = 'sq'; ('", "\\\"); globalThis.PWN = 'esc'; //",
    "\n})(); globalThis.PWN = 'close'; (async () => {", "\u0000", "${}", "\\u0022",
].join(" ");

test("no pointer value, read ref, pipe, meta field or ml.current content can break out of the wrapper or change ml", async () => {
    const reads = [
        { ref: "@tool:exec", pipe: [], value: EVIL, warning: EVIL, meta: { kind: EVIL, id: EVIL, tool: EVIL, step: 1, label: EVIL, latex: EVIL } },
        { ref: "@tool:x", pipe: [EVIL], value: EVIL },
        { ref: "@tool:bad", pipe: [], error: EVIL },
    ];
    const current = {
        current: { run: { id: EVIL }, messages: [{ role: "user", content: EVIL }], meta: JSON.parse(`{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "dereference": "${"x"}"}`), log: [{ kind: EVIL }] },
        logText: EVIL,
    };
    for (const b of [{ reads, current }, { reads, currentError: EVIL }]) {
        const ctx = world();
        const src = isolatedWrapper("([ml.dereference('@tool:exec') + '', ml.dereference('@tool:exec').label, ml.dereference('@tool:x', { pipe: [" + JSON.stringify(EVIL) + "] }) + '', (() => { try { ml.dereference('@tool:bad') } catch (e) { return e.message } })(), (() => { try { return ml.current.messages[0].content } catch (e) { return e.message } })(), typeof ml.dereference, ({}).polluted === undefined])", b, "ab12", "");
        const out = JSON.parse(JSON.stringify(await vm.runInContext(src, ctx)));
        assert.equal(vm.runInContext("typeof globalThis.PWN", ctx), "undefined", `a value ran as code: ${vm.runInContext("String(globalThis.PWN)", ctx)}`);
        assert.ok(!out.threw, out.threw);
        const v = JSON.parse(out.v);
        // Positive control: every value arrived intact (a lone surrogate is JSON's replacement, as it is on the page).
        const same = (s) => s === EVIL || s === JSON.parse(JSON.stringify(EVIL));
        assert.ok(same(v[0]) && same(v[1]) && same(v[2]) && same(v[3]) && same(v[4]), JSON.stringify(v).slice(0, 200));
        assert.equal(v[5], "function");
        assert.equal(v[6], true, "an Object.prototype in the world was polluted");
    }
});

// --- 5. what the isolated path leaves on the tab ---

test("after an isolated exec the user-script world is the run's own, and messaging is configured only for a call that streams or may ask the worker for a read", T, async () => {
    // `a` names a pointer that does not resolve (no exec before it), so nothing was sent and there is nothing to ask for.
    const a = await rtRun(["window.b = 1; return @tool:exec"], { us: true });
    const b = await rtRun(["window.b = 1; console.log(1); return @tool:exec"], { us: true, stream: true });
    // `c` names one that resolves (part 4b): its value's .pipe() may ask the worker, so the world gets messaging.
    const c = await rtRun([FIRST, "window.b = 1; return @tool:exec"], { us: true });
    const conf = (bg) => bg.userScriptCalls.filter(([k]) => k === "configureWorld").map(([, c]) => JSON.parse(JSON.stringify(c)));
    assert.deepEqual(conf(a.bg), [{ worldId: `wml-${a.hash}`, messaging: false }]);
    assert.deepEqual(conf(b.bg), [{ worldId: `wml-${b.hash}`, messaging: true }]);
    assert.deepEqual(conf(c.bg), [{ worldId: `wml-${c.hash}`, messaging: true }]);
    assert.match(c.results[1], /FROM THE PAGE/, `positive control: the resolved read was sent: ${c.results[1]}`);
    // Never the default (main/USER_SCRIPT) world, which other user scripts share.
    for (const r of [a, b, c]) for (const i of r.injected) assert.equal(i.worldId, `wml-${r.hash}`);
});

// --- 6. fail-open on absent facts ---

test("user scripts allowed at the decision but failing mid-call: an error, never a fall back to the page's world", T, async () => {
    for (const fail of ["configure", "execute"]) {
        const r = await rtRun(["window.b = 1; return ml.current.messages.length"], {
            us: true,
            onBg: (bg) => { if (fail === "configure") bg.context.chrome.userScripts.configureWorld = async () => { throw new Error("The userScripts API is not available"); }; },
            onExecute: fail === "execute" ? async () => { throw new Error("Cannot access contents of the page"); } : undefined,
        });
        assert.deepEqual(r.log.map((x) => [x.kind, x.reason]), [["exec-isolated", "current"]], `positive control (${fail}): routed isolated`);
        assert.equal(r.toPage.length, 0, `${fail}: sent to the page's world`);
        assert.match(r.results[0], /^Error: The isolated exec failed|^Error: The exec could not run/, `${fail}: ${r.results[0]}`);
        assert.equal(r.bg.debuggerCalls.filter((c) => c[2] === "Runtime.evaluate").length, 0, `${fail}: no CDP evaluation in its place`);
    }
});

test("a CDP isolated world that reports no context id: nothing is evaluated anywhere (an evaluate with no contextId is the page's world)", T, async () => {
    const w = cdpWorld({ createdContext: null });
    const r = await rtRun(["window.b = 1; return ml.current.messages.length"], { cdp: true, onDebuggerCommand: w.onDebuggerCommand, onBg: (bg) => { w.bg = bg; } });
    assert.ok(w.calls.some(([m]) => m === "Page.createIsolatedWorld"), "positive control: the CDP world was asked for");
    assert.deepEqual(w.calls.filter(([m]) => m === "Runtime.evaluate"), []);
    assert.equal(r.toPage.length, 0);
    assert.match(r.results[0], /could not create its world/);
    assert.ok(!r.results[0].includes("RAN IN THE PAGE'S CONTEXT"));
});

// --- 7. the read-only helpers (ml.queryAll, ml.a11y, ...) the isolated world now has ---
//
// The page is hostile and shares the DOM with the world. Played here by a jsdom window, which is ONE realm: the page's
// listeners and the wrapper run side by side, so what is shown is "nothing of ours is dispatched, posted or written, and
// no closed root is crossed". NOT shown (needs a real browser): that a page's prototype patches (Element.prototype
// getters, EventTarget.prototype.dispatchEvent, Function.prototype) do not apply in the isolated world. That is the
// browser's world isolation, the same property the rest of this file relies on; there is no cheap e2e for it, since an
// isolated exec on an unapproved page is not driven by the harness's fixtures.

const HOSTILE_HTML = `<ul id="list"><li><a href="/pull/1">One</a></li><li><a href="/pull/2">Two</a></li></ul>
    <button aria-label="Merge" id="merge">Merge</button>
    <div id="open-host"></div><div id="closed-host"></div>
    <div id="ml-sb-host"></div><div id="ml-lightbox-1"><i id="in-lightbox">x</i></div><div id="ml-highlight-1"></div>`;

/** A jsdom page, with one open and one closed shadow root, and the extension's own UI hosts. Returns the page, its world
 *  context, the closed root (the page holds it, as it would from its own attachShadow) and the open one. */
function helperPage() {
    const dom = new JSDOM(`<!doctype html><body>${HOSTILE_HTML}</body>`, { runScripts: "outside-only", url: "https://evil.example/" });
    const d = dom.window.document;
    const open = d.getElementById("open-host").attachShadow({ mode: "open" });
    open.innerHTML = "<span class='in'>open-inside</span>";
    const closed = d.getElementById("closed-host").attachShadow({ mode: "closed" });
    closed.innerHTML = "<span class='secret'>closed-inside</span><button aria-label='hidden btn'>b</button>";
    // Closed, as the extension's own roots are (since attack 17); the page cannot reach inside, nor can the world.
    const sb = d.getElementById("ml-sb-host").attachShadow({ mode: "closed" });
    sb.innerHTML = "<div class='card'>our ui</div>";
    return { dom, d, ctx: dom.getInternalVMContext(), closed, open };
}

/** Run `inner` through the wrapper in the page's context, watching everything the world could send the page. Returns the
 *  wrapped result plus: every event dispatched on any EventTarget, every postMessage, the document's markup before and
 *  after, the mutation records and the globals the run added. */
async function runHelper(page, inner, bindings = { reads: [] }) {
    const w = page.dom.window;
    const events = [], posts = [];
    const origDispatch = w.EventTarget.prototype.dispatchEvent;
    w.EventTarget.prototype.dispatchEvent = function (e) { events.push(e.type); return origDispatch.call(this, e); };
    const origPost = w.postMessage; w.postMessage = (...a) => { posts.push(a); };
    const mo = new w.MutationObserver(() => {}); mo.observe(page.d, { subtree: true, childList: true, attributes: true, characterData: true });
    const before = page.d.documentElement.outerHTML, globalsBefore = new Set(Object.getOwnPropertyNames(w));
    const out = JSON.parse(JSON.stringify(await vm.runInContext(isolatedWrapper(inner, bindings, "N1", ""), page.ctx)));
    const records = mo.takeRecords().length; mo.disconnect();
    w.EventTarget.prototype.dispatchEvent = origDispatch; w.postMessage = origPost;
    return { out, events, posts, records, markupChanged: page.d.documentElement.outerHTML !== before, // __mlIsoStarted and __mlState are the wrapper's own (the start marker and the console/state slot), not the helpers'.
        newGlobals: Object.getOwnPropertyNames(w).filter((k) => !globalsBefore.has(k) && k !== "__mlIsoStarted" && k !== "__mlState") };
}

const EVERY_HELPER = `{
    const out = [];
    out.push(ml.queryAll('a').length, ml.queryAll('*').length, ml.queryAll('#open-host >>> .in').length, ml.queryAll('#closed-host >>> .secret').length);
    out.push(ml.queryAll('li:contains("Two")').length, ml.queryAll('role=button').length, ml.queryAll('label=Merge').length, ml.queryAll('text=One').length);
    for (const el of ml.queryAll('button, a, ul, li')) out.push(ml.a11y(el).role);
    out.push(ml.pipe('a', 'head 1'), JSON.stringify(ml.range(2)), ml.schema({ a: 1 }));
    return out;
}`;

test("running every helper (queryAll with >>>, role=, label=, text=, :contains, a11y, pipe, schema, range) dispatches no event, posts no message and writes no node, attribute or global", T, async () => {
    const page = helperPage();
    const r = await runHelper(page, EVERY_HELPER);
    assert.equal(r.out.threw, undefined, `positive control: it ran: ${r.out.threw}`);
    assert.ok(r.out.v.includes("2"), "positive control: the queries found the page's links");
    assert.deepEqual(r.events, [], "an event was dispatched (a closed-root reader claim is a CustomEvent on window)");
    assert.deepEqual(r.posts, []);
    assert.equal(r.records, 0, "a DOM mutation was made");
    assert.equal(r.markupChanged, false);
    assert.deepEqual(r.newGlobals, [], "a global was left in the world");
});

test("a closed shadow root is not crossed by queryAll >>> or a plain query, and a page listener for the closed-roots event is never asked for a reader", T, async () => {
    const page = helperPage();
    const w = page.dom.window;
    let asked = 0;
    // The page's listener, registered first: hands over a reader for every closed root it made.
    w.addEventListener(CLOSED_ROOTS_EVENT, (e) => { asked++; e.detail.read = (el) => (el.id === "closed-host" ? page.closed : null); });
    // Control: the listener works, so a path that DID ask would be given the root.
    const probe = Object.create(null); w.dispatchEvent(new w.CustomEvent(CLOSED_ROOTS_EVENT, { detail: probe }));
    assert.equal(asked, 1); assert.equal(probe.read(page.d.getElementById("closed-host")), page.closed);
    asked = 0;
    const r = await runHelper(page, `{
        return [ml.queryAll('#closed-host >>> .secret').length, ml.queryAll('.secret').length, ml.queryAll('#closed-host >>> *').length,
                ml.queryAll('*').filter((e) => e.className === 'secret').length, ml.queryAll('#open-host >>> .in').length,
                ml.queryAll('button').map((b) => ml.a11y(b).name)];
    }`);
    assert.equal(r.out.threw, undefined, r.out.threw);
    assert.deepEqual(JSON.parse(r.out.v), [0, 0, 0, 0, 1, ["Merge"]], "closed content was reached, or the open root (control) was not");
    assert.equal(asked, 0, "the world asked the page for a closed-root reader");
    assert.equal(r.out.v.includes("closed-inside"), false);
});

test("queryAll never returns the extension's own UI hosts, their contents or descendants, for * or >> or an id selector; a second argument cannot ask for them", T, async () => {
    const page = helperPage();
    const r = await runHelper(page, `{
        const ids = (l) => l.map((e) => e.id || e.className || e.tagName);
        return {
            star: ids(ml.queryAll('*')), deep: ids(ml.queryAll('div >>> *')), sb: ml.queryAll('#ml-sb-host').length, sbDeep: ml.queryAll('#ml-sb-host >>> .card').length,
            lb: ml.queryAll('#ml-lightbox-1 i').length, hl: ml.queryAll('[id^="ml-"]').length, forced: ml.queryAll('#ml-sb-host', true).length, forced2: ml.queryAll('[id^="ml-"]', { includeExtensionUi: true }).length,
            ctl: ml.queryAll('#open-host').length };
    }`);
    assert.equal(r.out.threw, undefined, r.out.threw);
    const v = JSON.parse(r.out.v);
    assert.equal(v.ctl, 1, "positive control: a page element is found");
    assert.deepEqual([v.sb, v.sbDeep, v.lb, v.hl, v.forced, v.forced2], [0, 0, 0, 0, 0, 0]);
    for (const l of [v.star, v.deep]) assert.ok(!l.some((x) => /ml-|card|in-lightbox/.test(x)), `ext UI in ${JSON.stringify(l)}`);
});

test("the script cannot replace, delete or redefine ml's helpers, and a later exec in the same world gets the originals; the kit leaves no global", T, async () => {
    const page = helperPage();
    const attack = await runHelper(page, `{
        const log = [];
        for (const k of ['queryAll', 'a11y', 'pipe', 'schema', 'range']) {
            try { ml[k] = () => 'forged'; } catch (e) { log.push('set'); }
            try { delete ml[k]; } catch (e) { log.push('del'); }
            try { Object.defineProperty(ml, k, { value: () => 'forged' }); } catch (e) { log.push('def'); }
        }
        try { Object.setPrototypeOf(ml, { queryAll: () => 'forged' }); } catch (e) { log.push('proto'); }
        // The function objects themselves are not frozen, but they are this call's copies.
        ml.queryAll.poisoned = true; ml.range.call = () => 'forged';
        return [ml.queryAll('#merge').length, ml.range(2).length, typeof globalThis.__mlIsoKit, typeof globalThis.helpers, typeof globalThis.queryAll, typeof globalThis.Papa, typeof globalThis.mlPipe];
    }`);
    assert.equal(attack.out.threw, undefined, attack.out.threw);
    assert.deepEqual(JSON.parse(attack.out.v), [1, 2, "undefined", "undefined", "undefined", "undefined", "undefined"]);
    assert.deepEqual(attack.newGlobals, []);
    const later = await runHelper(page, `[ml.queryAll('#merge').length, typeof ml.queryAll.poisoned, ml.range(3).length, ml.a11y(ml.queryAll('#merge')[0]).name]`);
    assert.deepEqual(JSON.parse(later.out.v), [1, "undefined", 3, "Merge"], "a poisoned helper survived into the next exec");
    assert.deepEqual(later.newGlobals, []);
});

test("page-shaped markup cannot make a11y's selector or name throw, loop or carry markup: hostile ids, classes, labelledby cycles, huge labels", T, async () => {
    const page = helperPage();
    const d = page.d;
    const evil = d.createElement("button");
    evil.id = `x"] , body , [id="`; evil.className = "a b\"c' ]]]"; evil.setAttribute("aria-label", "</button><script>1</script>\u0000\n".repeat(50) + "z".repeat(100000));
    evil.setAttribute("aria-labelledby", "self cyc1");
    evil.id = "self";
    const c1 = d.createElement("span"); c1.id = "cyc1"; c1.setAttribute("aria-labelledby", "cyc2"); const c2 = d.createElement("span"); c2.id = "cyc2"; c2.setAttribute("aria-labelledby", "cyc1"); c2.textContent = "c";
    const weird = d.createElement("button"); weird.id = `q"] , body , [id="`; weird.className = "a\"b c'd"; weird.textContent = "weird";
    d.body.append(evil, c1, c2, weird);
    const r = await runHelper(page, `{
        const res = [];
        for (const el of ml.queryAll('button')) {
            const a = ml.a11y(el);
            let back = null;
            try { back = ml.queryAll(a.selector).length; } catch (e) { back = 'threw'; }
            res.push({ keys: Object.keys(a).join(), types: [typeof a.role, typeof a.name, typeof a.state, typeof a.selector].join(), len: a.name.length, sel: a.selector, back });
        }
        return res;
    }`);
    assert.equal(r.out.threw, undefined, r.out.threw);
    const rows = JSON.parse(r.out.v);
    assert.ok(rows.length >= 3, "positive control: the hostile buttons were reached");
    for (const x of rows) {
        assert.equal(x.keys, "role,name,state,selector");
        assert.equal(x.types, "string,string,string,string");
        // No cap on the name's length here: parity with the page's ml.a11y (an observation, not pinned).
        assert.notEqual(x.back, "threw", `the selector ${x.sel} does not parse`);
        assert.equal(x.back, 1, `the selector ${x.sel} does not name one element (it names ${x.back}), so a click on it lands elsewhere`);
    }
    assert.deepEqual([r.events, r.records, r.markupChanged], [[], 0, false]);
});

test("a page that makes an element's getters throw (a hostile class instance in its own realm) cannot make queryAll or a11y write or dispatch anything", T, async () => {
    const page = helperPage();
    const w = page.dom.window;
    // In this one-realm stand-in the page's own throwing getters do run; what must hold is that a throw is contained and nothing leaks while it happens.
    const el = page.d.getElementById("merge");
    Object.defineProperty(el, "id", { get() { throw new Error("page getter"); }, configurable: true });
    Object.defineProperty(el, "className", { get() { throw new Error("page getter"); }, configurable: true });
    const r = await runHelper(page, `{
        let a; try { a = ml.a11y(ml.queryAll('button')[0]); } catch (e) { a = 'threw:' + e.message; }
        return [typeof a === 'string' ? a : 'ok', ml.queryAll('a').length];
    }`);
    assert.equal(r.out.threw, undefined, r.out.threw);
    assert.equal(JSON.parse(r.out.v)[1], 2, "positive control: the world still reads");
    assert.deepEqual([r.events, r.posts, r.records, r.newGlobals], [[], [], 0, []]);
    void w;
});
