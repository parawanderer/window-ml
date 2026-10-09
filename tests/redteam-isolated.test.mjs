// redteam-isolated.test.mjs — the red-team pass for the isolated exec (exec-routing.ts, sw-isolated-exec.ts; site access
// slice 2 part 4): what a hostile page must NOT get from an approved exec of a worker-built run, each property a test.
//
// The page is played by `onTabMessage` (what reaches it is every RUN_TOOL_IN_PAGE it is sent) and by `bg.send` with the
// run's own tab as sender (what it can post). A user-script world is a vm context per world; the CDP world is a fake
// whose isolated context is 11 and the page's own context is 1. An open hole is a `todo` naming what is open.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, streamResponse, loadBackground } = require("./helpers");
const { isolatedWrapper } = await import("../src/sw/sw-isolated-exec.ts");

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

let r_bg;
test("the page cannot write into a MAIN-world CDP exec's live output through __mlCdpStream (predates the isolated exec)", { ...T, todo: "cdpEval (src/sw/sw-cdp.ts) adds __mlCdpStream with no executionContextName and its listener checks neither context nor nonce: the page's own scripts call it while a strict-page exec runs. Inherent while the exec runs in the page's world, which can also patch the console the wrapper reads; predates PR #453" }, async () => {
    const SCRIPT = "document.title = 'x'; console.log('real'); return 1";
    const r = await rtRun([SCRIPT], {
        cdp: true, stream: true,
        onPageExec: async () => ({ result: "Error: this page blocks eval (CSP)", cdpExec: { source: SCRIPT } }),
        onBg: (bg) => { r_bg = bg; },
        onDebuggerCommand: async (method, params) => {
            if (method === "Runtime.evaluate") {
                // The page's own script, in the context the exec runs in (the main world, context 1), calls the binding.
                r_bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlCdpStream", executionContextId: 1, payload: JSON.stringify({ text: "FORGED BY THE PAGE\n" }) });
                await new Promise((res) => setTimeout(res, 120));
                r_bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlCdpStream", executionContextId: 1, payload: JSON.stringify({ text: "real\n" }) });
                return { result: { value: { __mlWrapped: true, v: "1", logs: ["real"], dropped: 0 } } };
            }
            return {};
        },
    });
    const added = r.bg.debuggerCalls.find((c) => c[2] === "Runtime.addBinding" && c[3]?.name === "__mlCdpStream");
    assert.ok(added, "positive control: the main-world CDP exec ran and bound its stream");
    assert.ok(r.live.some((o) => o.includes("real")), `positive control: its line streamed: ${JSON.stringify(r.live)} ${r.results}`);
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

test("after an isolated exec the user-script world is the run's own, and messaging is configured only for a call that streams", T, async () => {
    const a = await rtRun(["window.b = 1; return @tool:exec"], { us: true });
    const b = await rtRun(["window.b = 1; console.log(1); return @tool:exec"], { us: true, stream: true });
    const conf = (bg) => bg.userScriptCalls.filter(([k]) => k === "configureWorld").map(([, c]) => JSON.parse(JSON.stringify(c)));
    assert.deepEqual(conf(a.bg), [{ worldId: `wml-${a.hash}`, messaging: false }]);
    assert.deepEqual(conf(b.bg), [{ worldId: `wml-${b.hash}`, messaging: true }]);
    // Never the default (main/USER_SCRIPT) world, which other user scripts share.
    for (const r of [a, b]) for (const i of r.injected) assert.equal(i.worldId, `wml-${r.hash}`);
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
