// redteam-current-runtime.test.mjs — the red-team pass for `ml.current.runtime` (sw-current-runtime.ts): what a hostile
// page sharing the main world with window.ml must not get from it, and what the projection must never carry.
//
// The runtime is projected in the worker from the description it gives every client (`localDescription`) and handed
// only to a script the worker evaluates (a read-only survey) or to the frozen copy an approved exec gets in its ISOLATED
// world. The bundle runs in node:vm with chrome mocked (loadBackground); a user-script world is a vm context. Canary:
// capability names only this description has, in the form a serialised one has (`"pythonBench":`).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { runtimeOf } = await import("../src/agent/current-runtime.ts");
const { attentionTitle } = await import("../src/chat/attention.ts");

// --- harness ---

const T = { timeout: 30000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const SITE = "https://site.example/page";
const APPROVED = { ml_site_always: ["https://site.example"] };
/** The runtime, serialised, in any nesting (an object, or JSON inside a string). */
const RUNTIME_CANARY = /\\*"(pythonBench|localSettings|switchModel)\\*":/;
const sendOrTimeout = (bg, msg, sender) => Promise.race([bg.send(msg, sender), new Promise((r) => setTimeout(() => r({ __timeout: true }), 300))]);

/**
 * A worker-built run on tab 7 whose model runs each script in `scripts` as an exec in turn, with user scripts available
 * (so an approved exec that reads `ml.current` runs isolated). Returns the worker, the run's hash and each tool result.
 */
async function runtimeRun(scripts) {
    let bg;
    const worlds = new Map();
    const world = (tabId) => {
        const ctx = vm.createContext({ console: { log() {} }, chrome: { runtime: { sendMessage: (m) => bg.emitUserScriptMessage(m, { tab: { id: tabId }, frameId: 0 }) } } });
        vm.runInContext("globalThis.window = globalThis", ctx);
        return ctx;
    };
    bg = loadBackground({
        config: { ...config, autoApproveReadonly: true }, openTabs: [{ id: 7, url: SITE, title: "S" }], local: APPROVED,
        userScripts: {
            available: true,
            execute: async (inj) => {
                const ctx = worlds.get(inj.worldId) ?? world(inj.target?.tabId);
                worlds.set(inj.worldId, ctx);
                const r = vm.runInContext(inj.js[0].code, ctx);
                return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r;
            },
        },
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const n = call.body.messages.filter((m) => m.role === "tool").length;
            const js = scripts[n];
            return js === undefined
                ? jsonResponse({ choices: [{ message: { content: "done" } }] })
                : jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify({ js }) } }] } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            return { result: "value: \"FROM THE PAGE\"" };
        },
    });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "task-7", surface: "hud" });
    const chat = () => bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const done = () => chat().some((c) => c.body.messages.filter((m) => m.role === "tool").length >= scripts.length);
    for (let i = 0; i < 600 && !done(); i++) await new Promise((r) => setTimeout(r, 0));
    await flush(30);
    const results = chat().at(-1)?.body.messages.filter((m) => m.role === "tool").map((m) => m.content) ?? [];
    return { bg, hash, results };
}

// --- 1. the page never receives ml.current.runtime ---

test("the page never receives ml.current.runtime: no message the worker sends the tab carries it, while the worlds that asked for it do", T, async () => {
    const { bg, results } = await runtimeRun([
        "document.title = 'x'; return 1",                                                                        // the page's main world
        "window.__x = 1; return ml.current.runtime.capabilities.chat === true ? 'RT-OK' : 'RT-BAD'",             // isolated
        "ml.current.runtime.kind === 'browser' && ml.current.runtime.capabilities.tabs ? 'SURVEY-OK' : 'SURVEY-BAD'",   // a survey, in the worker
    ]);
    assert.equal(results[0], 'value: "FROM THE PAGE"', "positive control: the plain exec ran in the page");
    assert.match(results[1], /^RT-OK/, "the isolated exec read the runtime");
    assert.match(results[2], /SURVEY-OK/, "the worker's survey read the runtime");
    const injected = bg.userScriptCalls.filter(([k]) => k === "execute").map(([, inj]) => JSON.stringify(plain(inj)));
    assert.ok(injected.some((c) => RUNTIME_CANARY.test(c)), "the frozen copy with the runtime went into the user-script world");
    assert.ok(bg.tabMessages.length > 5, "the tab was sent messages (the run's steps)");
    for (const [tabId, msg] of bg.tabMessages) assert.ok(!RUNTIME_CANARY.test(JSON.stringify(plain(msg))), `tab ${tabId} got the runtime in ${msg.type}: ${JSON.stringify(plain(msg)).slice(0, 300)}`);
});

test("no page-started message type returns ml.current.runtime, from the run's own approved tab, enumerated from page-relay.ts", T, async () => {
    const { PAGE_STARTED_TYPES } = require("../src/page-relay.ts");
    const { bg, hash } = await runtimeRun(["window.__x = 1; return ml.current.runtime.kind"]);
    const page = { tab: { id: 7, url: SITE }, url: SITE, frameId: 0, origin: "https://site.example", documentId: "doc-7" };
    const payload = { messages: [{ role: "user", content: "hi" }], url: SITE, runId: hash, run: hash, hash };
    assert.ok(PAGE_STARTED_TYPES.size >= 30, "the relay list was read");
    let answered = 0;
    for (const type of [...PAGE_STARTED_TYPES, "DUMP_RUN_STATE", "DUMP_RUN_LOG"]) {
        const res = await sendOrTimeout(bg, { type, payload, requestId: "r1", event: { kind: "chat", id: hash, ts: 1, session: { hash, turn: 0 } } }, page);
        if (res && !res.__timeout) answered++;
        assert.ok(!RUNTIME_CANARY.test(JSON.stringify(plain(res))), `${type} answered the page with the runtime: ${JSON.stringify(plain(res)).slice(0, 300)}`);
    }
    assert.ok(answered >= 10, `${answered} types answered: the sends reached handlers`);
    // The Run state panel reads it (positive control: run.runtime is real).
    const dump = plain(await bg.send({ type: "DUMP_RUN_STATE", payload: { run: hash } }, { url: "chrome-extension://test/sidebar.html" }));
    assert.equal(dump.data.entries.find((e) => e.id === "run.runtime")?.value?.capabilities?.chat, true, "the panel reads the run's runtime");
});

// --- 2. the projection carries no identifier, over every shape a capability can take ---

/** Identifiers a capability's details hold, none of which may cross. */
const HEX64 = "ab".repeat(32);
const LEAKS = ["https://", "http://", "pages.example", "zz9extensionid", "Brave", "a.example", HEX64, "C:\\\\Users", "/Users/sb", "box-secret"];

/** Every non-boolean shape the contract has, filled with identifiers, plus ones a later contract might add. */
const DETAILED = [
    { blankStart: { url: "https://pages.example/agent-start.html", granted: false, origins: ["https://a.example/*"], browser: "Brave", extensionId: "zz9extensionid" } },
    { blankStart: { url: "https://pages.example/agent-start.html", granted: true } },
    { archive: { on: true, folder: { name: "/Users/sb/archive", state: "needs-grant" } } },
    { archive: { on: false } },
    { boxes: [{ id: HEX64, name: "box-secret", url: "http://box-secret:11434" }] },
    { futureList: ["https://pages.example/"] },
    { futureText: `principal ${HEX64}` },
    { futureNumber: 42 },
    { futureObject: { path: "C:\\\\Users\\x" } },
];

/** Attention lists a runtime could report, junk included. */
const ATTENTION = [
    [],
    ["no-model", "site-access"],
    ["spend-no-electricity-price", "spend-no-electricity-price"],
    ["a-code-this-build-does-not-know"],
    ["https://pages.example/x", HEX64, "", 7, null, { code: "no-model" }, "UPPER", "no-model"],
    "no-model",
];

test("the projection carries no identifier: every capability is a boolean, and attention is codes with the inbox's titles", () => {
    let checked = 0;
    for (const detail of DETAILED) for (const attention of ATTENTION) for (const kind of ["browser", "desktop", "headless"]) {
        const rt = runtimeOf({ kind, capabilities: { chat: true, agent: false, sideCalls: true, ...detail, attention } });
        const json = JSON.stringify(rt);
        for (const leak of LEAKS) assert.ok(!json.includes(leak), `${leak} crossed: ${json}`);
        assert.equal(rt.kind, kind);
        for (const [name, value] of Object.entries(rt.capabilities)) {
            if (name === "attention") continue;
            assert.equal(typeof value, "boolean", `${name} is ${JSON.stringify(value)}`);
        }
        for (const a of rt.capabilities.attention ?? []) {
            assert.deepEqual(Object.keys(a), ["code", "title"]);
            assert.match(a.code, /^[a-z][a-z0-9-]{0,39}$/);
            assert.equal(a.title, attentionTitle(a.code));
        }
        checked++;
    }
    assert.equal(checked, DETAILED.length * ATTENTION.length * 3);
});

test("the rule names no capability: a boolean stays itself (false too), a detailed one is present, an absent one is absent", () => {
    const rt = runtimeOf({ kind: "browser", capabilities: { chat: true, agent: false, aNewOne: true, blankStart: { url: "https://pages.example/" }, gone: undefined, nothing: null, attention: ["no-model", "a-code-this-build-does-not-know"] } });
    assert.deepEqual(rt, { kind: "browser", capabilities: {
        chat: true, agent: false, aNewOne: true, blankStart: true,
        attention: [{ code: "no-model", title: "No model is chosen" }, { code: "a-code-this-build-does-not-know", title: "Something needs attention" }],
    } });
    assert.deepEqual(runtimeOf({ kind: "browser", capabilities: {} }), { kind: "browser", capabilities: {} });
});

// --- 3. what the model reads is this runtime's own description ---

test("a read-only survey reads the runtime this browser describes to its clients, projected", T, async () => {
    const { results } = await runtimeRun([
        "ml.current.runtime.kind",
        "['chat', 'agent', 'tabs', 'screenshots', 'localSettings', 'switchModel', 'resourcePanel'].filter((k) => ml.current.runtime.capabilities[k] !== true).join() || 'ALL-TRUE'",
        "Object.keys(ml.current.runtime.capabilities).filter((k) => k !== 'attention' && typeof ml.current.runtime.capabilities[k] !== 'boolean').join() || 'ALL-BOOLEAN'",
        "Object.keys(ml.current.runtime).join()",
    ]);
    assert.match(results[0], /browser/);
    assert.match(results[1], /ALL-TRUE/);
    assert.match(results[2], /ALL-BOOLEAN/);
    assert.equal(results[3], "kind,capabilities", "nothing but the two members");
});

// --- size: what runtime adds to the copy an approved exec is sent ---

test("runtime adds a few hundred characters to the frozen copy (EXEC_CURRENT_CHARS)", async () => {
    const { currentForExec, EXEC_CURRENT_CHARS, snapshotCurrent } = await import("../src/agent/current-context.ts");
    const snap = snapshotCurrent({ run: { id: "r", model: "m", step: 1, maxSteps: 5, startedTs: 0 }, messages: [{ role: "user", content: "x" }], recorded: [], log: [], now: 1 });
    const size = (s) => JSON.stringify(currentForExec(s, true).value).length;
    const caps = { chat: true, agent: true, tabs: true, highlight: true, screenshots: true, sideCalls: true, persistence: true, resourcePanel: true, pythonBench: true, localSettings: true, switchModel: true, archive: { on: true }, blankStart: { url: "https://x/" },
        attention: ["no-model", "backend-unreachable", "site-access", "tab-groups", "no-utility-model", "archive-folder-lapsed", "spend-no-electricity-price"] };
    const overhead = size({ ...snap, runtime: runtimeOf({ kind: "browser", capabilities: caps }) }) - size(snap);
    console.log(`EXEC_CURRENT_CHARS=${EXEC_CURRENT_CHARS} runtime overhead=${overhead} (every capability and seven attention codes)`);
    assert.ok(overhead < 900, `${overhead}`);
});
