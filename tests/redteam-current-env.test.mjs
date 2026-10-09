// redteam-current-env.test.mjs — the red-team pass for `ml.current.env` (sw-current-env.ts): what a hostile page sharing
// the main world with window.ml must not get from it, and what the env must not claim.
//
// The env is computed in the worker (currentEnv) and handed only to a script the worker evaluates (a read-only survey)
// or to the frozen copy an approved exec gets in its ISOLATED world (sw-run-host.ts). The bundle runs in node:vm with
// chrome mocked (loadBackground); user-script worlds are vm contexts. Canary: the env's own JSON keys, in the form a
// serialised env has (`"readsCurrent":"`), which the build's embedded diff text (BUILD_DIFF) never has.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

// --- harness ---

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };

/** A vm context standing in for a user-script world. */
function world(extra = {}) {
    const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, ...extra });
    vm.runInContext("globalThis.window = globalThis", ctx);
    return ctx;
}

/**
 * Worker-built runs, one per `{ tab, scripts }`, whose model runs each script as an exec in turn. The model of a run is
 * told apart by its task (`task-<tabId>`). `beforeCall(bg, run, n)` runs before the model answers its n-th call.
 */
async function envRuns(runs, { auto = true, us, cdp = false, local = {}, beforeCall, onTab } = {}) {
    let bg;
    // CDP played as Chrome does for an isolated world (context 11); the page's own context would be 1.
    const cdpCtx = world();
    const onDebuggerCommand = async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 11 };
        if (method === "Runtime.evaluate") {
            if (params.contextId !== 11) return { exceptionDetails: { text: "evaluated outside the isolated world" } };
            try { return { result: { value: JSON.parse(JSON.stringify(await vm.runInContext(params.expression, cdpCtx))) } }; }
            catch (e) { return { exceptionDetails: { text: String(e), exception: { description: `${e.name}: ${e.message}` } } }; }
        }
        return {};
    };
    const worlds = new Map();
    const userScripts = us === undefined ? undefined : {
        available: us !== "off",
        execute: async (inj) => {
            const tabId = inj.target?.tabId;
            const ctx = worlds.get(inj.worldId) ?? world({ chrome: { runtime: { sendMessage: (m) => bg.emitUserScriptMessage(m, { tab: { id: tabId }, frameId: 0 }) } } });
            worlds.set(inj.worldId, ctx);
            const r = vm.runInContext(inj.js[0].code, ctx);
            return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r;
        },
    };
    bg = loadBackground({
        config: { ...config, autoApproveReadonly: auto, cdp }, openTabs: runs.map((r) => r.tab), userScripts, onDebuggerCommand,
        local,
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const msgs = call.body.messages;
            const run = runs.find((r) => msgs.some((m) => m.role === "user" && String(m.content).includes(`task-${r.tab.id}`)));
            const n = msgs.filter((m) => m.role === "tool").length;
            if (beforeCall) await beforeCall(bg, run, n);
            const js = run?.scripts[n];
            return js === undefined
                ? jsonResponse({ choices: [{ message: { content: "done" } }] })
                : jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${run.tab.id}_${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ js }) } }] } }] });
        },
        onTabMessage: async (tabId, msg) => {
            onTab?.(tabId, msg);
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck) return {};
            if (msg.payload.readonlyTry) return {};
            return { result: "value: \"FROM THE PAGE\"" };
        },
    });
    const hashes = [];
    for (const r of runs) hashes.push((await bg.context.__mlStartUserRunForTest(r.tab.id, { task: `task-${r.tab.id}`, surface: "hud" })).hash);
    const chat = () => bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const doneOf = (r) => chat().some((c) => c.body.messages.some((m) => m.role === "user" && String(m.content).includes(`task-${r.tab.id}`)) && c.body.messages.filter((m) => m.role === "tool").length >= r.scripts.length);
    for (let i = 0; i < 600 && !runs.every(doneOf); i++) await new Promise((r) => setTimeout(r, 0));
    await flush(30);
    const results = runs.map((r) => {
        const last = chat().filter((c) => c.body.messages.some((m) => m.role === "user" && String(m.content).includes(`task-${r.tab.id}`))).at(-1);
        return last ? last.body.messages.filter((m) => m.role === "tool").map((m) => m.content) : [];
    });
    return { bg, hashes, results };
}

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const SITE = "https://site.example/page";
const OTHER = "https://other.example/inbox?id=OTHER-TAB-SECRET";
const APPROVED = { ml_site_always: ["https://site.example", "https://unrelated-bank.example"] };
/** The env, serialised, in any nesting (an object, or JSON inside a string). */
const ENV_CANARY = /\\*"(readsCurrent|readsPointer|readonlyAutoApprove)\\*":/;
/** The first line of an isolated exec's result is what the script returned. */
const envFrom = (result) => JSON.parse(result.split("\n")[0]);
const PANEL = { url: "chrome-extension://test/sidebar.html" };   // the Run state panel, an extension page
/** Race a send against a short timer: a type nothing answers never settles. */
const sendOrTimeout = (bg, msg, sender) => Promise.race([bg.send(msg, sender), new Promise((r) => setTimeout(() => r({ __timeout: true }), 300))]);

// --- 1. the page never receives ml.current.env ---

test("the page never receives ml.current.env: no message the worker sends the tab carries it, while the isolated world that asked for it does", T, async () => {
    const { bg, results } = await envRuns([{ tab: { id: 7, url: SITE, title: "S" }, scripts: [
        "document.title = 'x'; return 1",                                                                   // plain: the page's main world
        "window.__x = 1; return ml.current.env.page.approved && ml.current.env.exec.readsCurrent === 'isolated' ? 'ENV-OK' : 'ENV-BAD'",   // isolated
        "document.title.length + ml.current.run.id.length",                                                 // a survey that needs the page
        "ml.current.run.id.length",                                                                         // a survey answered in the worker
        "ml.current.env.readonlyAutoApprove && ml.current.env.page.approved ? 'SURVEY-OK' : 'SURVEY-BAD'",  // a survey reading env, in the worker
    ] }], { us: true, local: APPROVED });
    // Positive controls: the plain exec reached the page's world, and the isolated one was given the env.
    assert.equal(results[0][0], 'value: "FROM THE PAGE"', "the plain exec ran in the page");
    assert.match(results[0][1], /^ENV-OK/, "the isolated exec read the run's env");
    assert.match(results[0][4], /SURVEY-OK/, "the worker's survey read the run's env");
    const injected = bg.userScriptCalls.filter(([k]) => k === "execute").map(([, inj]) => JSON.stringify(plain(inj)));
    assert.ok(injected.some((c) => ENV_CANARY.test(c)), "the frozen copy with the env went into the user-script world");
    // Defended: every message the worker sent the tab (RUN_TOOL_IN_PAGE in every form, ML_DEBUG_TO_PAGE, the rest).
    assert.ok(bg.tabMessages.length > 5, "the tab was sent messages (the run's steps)");
    for (const [tabId, msg] of bg.tabMessages) assert.ok(!ENV_CANARY.test(JSON.stringify(plain(msg))), `tab ${tabId} got the env in ${msg.type}: ${JSON.stringify(plain(msg)).slice(0, 300)}`);
    for (const [, msg] of bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE"))
        assert.ok(!("current" in msg.payload) && !("env" in msg.payload), `a RUN_TOOL_IN_PAGE payload carries ${Object.keys(msg.payload)}`);
});

test("no page-started message type returns ml.current.env, from the run's own approved tab, enumerated from page-relay.ts", T, async () => {
    const { PAGE_STARTED_TYPES } = require("../src/page-relay.ts");
    const { bg, hashes } = await envRuns([{ tab: { id: 7, url: SITE, title: "S" }, scripts: ["window.__x = 1; return ml.current.env.page.approved ? 'Y' : 'N'"] }], { us: true, local: APPROVED });
    const page = { tab: { id: 7, url: SITE }, url: SITE, frameId: 0, origin: "https://site.example", documentId: "doc-7" };
    const payload = { messages: [{ role: "user", content: "hi" }], url: SITE, runId: hashes[0], run: hashes[0], hash: hashes[0] };
    assert.ok(PAGE_STARTED_TYPES.size >= 30, "the relay list was read");
    let answered = 0;
    for (const type of [...PAGE_STARTED_TYPES, "DUMP_RUN_STATE", "DUMP_RUN_LOG"]) {
        const res = await sendOrTimeout(bg, { type, payload, requestId: "r1", event: { kind: "chat", id: hashes[0], ts: 1, session: { hash: hashes[0], turn: 0 } } }, page);
        if (res && !res.__timeout) answered++;
        assert.ok(!ENV_CANARY.test(JSON.stringify(plain(res))), `${type} answered the page with the env: ${JSON.stringify(plain(res)).slice(0, 300)}`);
    }
    assert.ok(answered >= 10, `${answered} types answered: the sends reached handlers`);
    // The Run state panel's read is refused to the page, and gives the person the env (positive control: run.env is real).
    const refused = plain(await bg.send({ type: "DUMP_RUN_STATE", payload: { run: hashes[0] } }, page));
    assert.match(refused.error ?? "", /extension pages/);
    const dump = plain(await bg.send({ type: "DUMP_RUN_STATE", payload: { run: hashes[0] } }, PANEL));
    const env = dump.data.entries.find((e) => e.id === "run.env")?.value;
    assert.deepEqual(env?.page, { url: SITE, approved: true }, "the panel reads the run's env");
});

// --- 2. env is the run's own tab, and nothing else ---

test("env carries only the run's own tab: two concurrent runs each see their own page and approval, and no key, list or other tab", T, async () => {
    const read = "window.__x = 1; return JSON.stringify(ml.current.env)";
    const { results, hashes } = await envRuns([
        { tab: { id: 7, url: SITE, title: "S" }, scripts: [read] },
        { tab: { id: 8, url: OTHER, title: "O" }, scripts: [read] },
    ], { us: true, auto: false, local: APPROVED });
    const [a, b] = [envFrom(results[0][0]), envFrom(results[1][0])];
    // Exact shapes: an extra key (a list, a URL, a run) fails here.
    assert.deepEqual(a, { page: { url: SITE, approved: true }, isolation: { userScripts: true, cdp: false }, exec: { plain: "page", readsCurrent: "isolated", readsPointer: "isolated" }, readonlyAutoApprove: false });
    assert.deepEqual(b, { page: { url: OTHER, approved: false }, isolation: { userScripts: true, cdp: false }, exec: { plain: "isolated", readsCurrent: "isolated", readsPointer: "isolated" }, readonlyAutoApprove: false });
    for (const [mine, other, otherHash] of [[results[0][0], OTHER, hashes[1]], [results[1][0], SITE, hashes[0]]]) {
        const raw = mine.split("\n")[0];
        for (const leak of ["sk-SECRET-KEY", "http://host", "unrelated-bank", "ml_site", other, otherHash])
            assert.ok(!raw.includes(leak), `env holds ${leak}: ${raw}`);
    }
});

// --- 3. the probes are routed, never run ---

test("computing env runs no probe: none is injected, evaluated or sent to the tab, and nothing reaches the backend but the model", T, async () => {
    const PROBE_SOURCES = ["document.title", "ml.current.run.step", "ml.dereference('x')"];
    for (const iso of [{ us: true, cdp: false }, { us: undefined, cdp: true }]) {
        const scripts = ["window.__x = 1; return ml.current.env.exec.plain", "ml.current.env === undefined ? ml.current.run.id.length : 0", "window.__y = 2; return ml.current.env.isolation.cdp"];
        const { bg, results } = await envRuns([{ tab: { id: 7, url: SITE, title: "S" }, scripts }], { ...iso, local: APPROVED });
        const how = iso.us ? "userScripts" : "cdp";
        // Positive control: each exec read the env, by the mechanism under test.
        assert.match(results[0][0], /^page/, `${how}: the exec read env.exec.plain`);
        assert.match(results[0][2], iso.us ? /^false/ : /^true/, `${how}: the exec read env.isolation.cdp`);
        const chat = bg.calls.filter((c) => c.url.includes("/chat/completions")).length;
        // A run's start asks the server for the model's capabilities (/api/show); nothing else but the model.
        const other = bg.calls.filter((c) => !c.url.includes("/chat/completions") && !/\/api\/show$/.test(c.url));
        assert.deepEqual(other.map((c) => c.url), [], `${how}: the backend got more than the model`);
        assert.equal(chat, scripts.length + 1, `${how}: one model call per step`);
        const sent = [
            ...bg.tabMessages.map(([, m]) => JSON.stringify(plain(m.type === "RUN_TOOL_IN_PAGE" ? m.payload.args ?? {} : {}))),
            ...bg.userScriptCalls.filter(([k]) => k === "execute").map(([, inj]) => inj.js.map((j) => j.code).join("\n")),
            ...bg.debuggerCalls.filter(([k, , m]) => k === "sendCommand" && /evaluate|callFunctionOn|compileScript/i.test(m)).map(([, , , p]) => JSON.stringify(plain(p))),
        ];
        for (const probe of PROBE_SOURCES) assert.ok(!sent.some((s) => s.includes(probe)), `${how}: the probe ${probe} was run`);
        // The worker-answered survey sent nothing to the tab for its step.
        const sends = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && !m.payload.finish && !m.payload.precheck);
        assert.ok(sends.every(([, m]) => !/run\.id/.test(m.payload.args?.js ?? "")), `${how}: the worker's survey went to the tab`);
    }
});

test("currentEnv touches only browser READS: no tab message, script, debugger, storage write or fetch", T, async () => {
    const { currentEnv } = await import("../src/sw/sw-current-env.ts");
    const calls = [];
    const READS = new Set(["tabs.get", "storage.local.get", "storage.session.get", "storage.sync.get", "permissions.contains", "userScripts.getWorldConfigurations", "runtime.getURL", "runtime.getManifest"]);
    const answers = {
        "tabs.get": async (id) => { if (id !== 7) throw new Error("No tab"); return { id: 7, url: SITE }; },
        "storage.local.get": async () => ({ ...APPROVED }),
        "storage.session.get": async () => ({}),
        "storage.sync.get": async (d) => ({ ...(d ?? {}), cdp: true, apiKey: "sk-SECRET-KEY" }),
        "permissions.contains": async () => true,
        "userScripts.getWorldConfigurations": async () => [],
        "runtime.getURL": (p = "") => `chrome-extension://test/${p}`,
    };
    const node = (path) => new Proxy(function () {}, {
        get: (_t, k) => (typeof k === "string" ? node(path ? `${path}.${k}` : k) : undefined),
        apply: (_t, _this, args) => { calls.push(path); return answers[path] ? answers[path](...args) : Promise.resolve(undefined); },
    });
    const prevChrome = globalThis.chrome, prevFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.chrome = node("");
    globalThis.fetch = async () => { fetched++; return new Response("{}"); };
    try {
        const env = await currentEnv(7, true);
        // Positive control: each read happened and decided something.
        assert.deepEqual(plain(env), { page: { url: SITE, approved: true }, isolation: { userScripts: true, cdp: true }, exec: { plain: "page", readsCurrent: "isolated", readsPointer: "isolated" }, readonlyAutoApprove: true });
        assert.ok(calls.includes("tabs.get") && calls.includes("storage.local.get") && calls.includes("userScripts.getWorldConfigurations"), calls.join());
        const writes = calls.filter((c) => !READS.has(c));
        assert.deepEqual(writes, [], `currentEnv called ${writes.join(", ")}`);
        assert.equal(fetched, 0, "no fetch");
    } finally { globalThis.chrome = prevChrome; globalThis.fetch = prevFetch; }
});

// --- 4. env is read at the moment of the read ---

test("after a navigation to an unapproved origin, the next read says approved:false, and the exec goes where env said", T, async () => {
    const tab = { id: 7, url: SITE, title: "S" };
    const read = "window.__x = 1; return JSON.stringify(ml.current.env)";
    const { results, bg } = await envRuns([{ tab, scripts: [read, read, "document.title = 'x'; return 1"] }], {
        us: true, auto: false, local: APPROVED,
        // What the browser answers for the tab from now on (chrome.tabs.get, which env and routing both read first). A
        // committed navigation is not used: the harness's page does not re-adopt the run after one.
        beforeCall: (_b, _run, n) => { if (n === 1) tab.url = OTHER; },
    });
    const [before, after] = [envFrom(results[0][0]), envFrom(results[0][1])];
    assert.deepEqual([before.page, before.exec.plain], [{ url: SITE, approved: true }, "page"], "positive control: approved before");
    assert.deepEqual([after.page, after.exec.plain], [{ url: OTHER, approved: false }, "isolated"], "read now, after the navigation");
    // And the plain exec after it went where env said: not the page's world.
    const toPage = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "exec" && !m.payload.renderOnly && !m.payload.precheck && !m.payload.readonlyTry);
    assert.equal(toPage.length, 0, "no exec ran in the unapproved page's world");
    assert.doesNotMatch(results[0][2], /FROM THE PAGE/);
});

test("a run on an unapproved page with no isolation: env says every exec is refused, and every exec is", T, async () => {
    const { results, bg, hashes } = await envRuns([{ tab: { id: 8, url: OTHER, title: "O" }, scripts: ["document.title = 'x'; return 1", "window.__x = 1; return ml.current.env"] }], { auto: false, local: APPROVED });
    const dump = plain(await bg.send({ type: "DUMP_RUN_STATE", payload: { run: hashes[0] } }, PANEL));
    const env = dump.data.entries.find((e) => e.id === "run.env")?.value;
    assert.deepEqual(env, { page: { url: OTHER, approved: false }, isolation: { userScripts: false, cdp: false }, exec: { plain: "refused", readsCurrent: "refused", readsPointer: "refused" }, readonlyAutoApprove: false });
    for (const r of results[0]) assert.match(r, /^Error: /, `refused: ${r}`);
    const toPage = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "exec" && !m.payload.renderOnly && !m.payload.precheck && !m.payload.readonlyTry);
    assert.equal(toPage.length, 0, "nothing ran in the page");
    assert.equal(bg.userScriptCalls.length + bg.debuggerCalls.length, 0, "nor anywhere else");
});

// --- 5. fails closed ---

/** currentEnv against a browser whose tab `7` answers `tab` (or is gone when null). */
async function envWith(tab, { lists = APPROVED, fallbackUrl } = {}) {
    const { currentEnv } = await import("../src/sw/sw-current-env.ts");
    const { tabPageUrl } = await import("../src/sw/sw-runs.ts");
    const prev = globalThis.chrome;
    globalThis.chrome = {
        tabs: { get: async () => { if (!tab) throw new Error("No tab with id: 7."); return { ...tab }; } },
        storage: { local: { get: async () => ({ ...lists }) }, session: { get: async () => ({}) }, sync: { get: async (d) => ({ ...(d ?? {}) }) } },
        permissions: { contains: async () => false },
        runtime: { getURL: (p = "") => `chrome-extension://test/${p}` },
    };
    if (fallbackUrl) tabPageUrl.set(7, fallbackUrl); else tabPageUrl.delete(7);
    try { return plain(await currentEnv(7, false)); } finally { globalThis.chrome = prev; tabPageUrl.delete(7); }
}

test("fails closed: a tab with no URL, a gone tab, or a non-web URL is never approved, whatever the lists hold", T, async () => {
    assert.equal((await envWith({ id: 7, url: SITE })).page.approved, true, "positive control: an approved site reads approved");
    assert.deepEqual((await envWith(null)).page, { url: "", approved: false }, "a gone tab");
    assert.deepEqual((await envWith({ id: 7 })).page, { url: "", approved: false }, "a tab whose URL the extension may not read");
    const odd = { ml_site_always: ["null", "file://", "chrome://settings", "about:blank", "*", ""] };
    for (const url of ["about:blank", "data:text/html,<p>x", "file:///etc/passwd", "chrome://settings", "javascript:1", "chrome-extension://test/sidebar.html", "not a url"])
        assert.equal((await envWith({ id: 7, url }, { lists: odd })).page.approved, false, `${url} approved`);
    // With no approval and no isolation, every exec column is refused, never "page".
    assert.deepEqual((await envWith(null)).exec, { plain: "refused", readsCurrent: "refused", readsPointer: "refused" });
});

test("fails closed: a tab that is GONE is not approved on the strength of the URL the worker last saw it at", T, async () => {
    assert.equal((await envWith({ id: 7, url: SITE })).page.approved, true, "positive control");
    assert.equal((await envWith(null, { fallbackUrl: SITE })).page.approved, false, "a closed tab claimed approved");
});

// --- the read-only survey reads env in the worker ---

test("a read-only survey (answered in the worker) reads ml.current.env, as the prompt tells the model", T, async () => {
    const { results } = await envRuns([{ tab: { id: 7, url: SITE, title: "S" }, scripts: ["Object.keys(ml.current).join()", "ml.current.env.page.url"] }], { local: APPROVED });
    assert.match(results[0][0], /run,messages,meta,log/, "positive control: the survey ran in the worker");
    assert.match(results[0][1], /site\.example/, `the survey read ${results[0][1]}`);
});

// --- size: what env adds to the copy an approved exec is sent ---

test("env adds a few hundred characters plus the page's URL to the frozen copy (EXEC_CURRENT_CHARS)", async () => {
    const { currentForExec, EXEC_CURRENT_CHARS, snapshotCurrent } = await import("../src/agent/current-context.ts");
    const { envOf } = await import("../src/sw/sw-current-env.ts");
    const snap = snapshotCurrent({ run: { id: "r", model: "m", step: 1, maxSteps: 5, startedTs: 0 }, messages: [{ role: "user", content: "x" }], recorded: [], log: [], now: 1 });
    const size = (s) => JSON.stringify(currentForExec(s, true).value).length;
    const base = size(snap);
    const withEnv = (url) => size({ ...snap, env: envOf(url, true, { userScripts: true, cdp: true }, true) });
    const overhead = withEnv("") - base;
    console.log(`EXEC_CURRENT_CHARS=${EXEC_CURRENT_CHARS} base=${base} env overhead=${overhead}+url (typical ${withEnv(SITE) - base})`);
    assert.ok(overhead < 300, `${overhead}`);
    assert.equal(withEnv("u".repeat(1000)) - base, overhead + 1000, "and grows one for one with the URL");
});
