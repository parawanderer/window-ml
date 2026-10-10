// isolated-harness.mjs — a worker-built run whose execs go to an isolated world (a user-script world or a CDP world,
// each a vm context), to the worker's read-only survey, or to the page's main world, for the isolated pointer tests
// (isolated-pointer.test.mjs) and their red-team pass (redteam-isolated-channel.test.mjs).
//
// The run fetches CSVs first (one past the parse cap is a STORED table, read by column through the worker), then runs
// each script as an exec. The main world is played by the page's own pieces (`preResolvedDeref`, `DerefText`,
// `VALUE_COLUMNS` through the real router), as run-delegation.ts and tools.ts put them together, since there is no page.
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { IDBFactory } = await import("fake-indexeddb");
const { MAX_TABLE_ROWS } = await import("../src/table/table-data.ts");
const { preResolvedDeref } = await import("../src/pointers/named-reads.ts");
const { DerefText } = await import("../src/tools/deref-read.ts");
const { expandPointers } = await import("../src/pointers/pointer-macro.ts");

const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
export const SITE_URL = "https://site.example/page";
export const DATA_URL = "https://data.example/orders.csv";
export const fromTab = { tab: { id: 7, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0 };
export const ROWS = MAX_TABLE_ROWS + 1;
/** A CSV one row past the parse cap, so its pointer's table is a preview and the whole body is in the value store. */
export const CSV = ["id,n,s", ...Array.from({ length: ROWS }, (_, i) => `${i},${(i * 7) % 1000},k${i % 13}`)].join("\n");
const csvResponse = (url, body) => ({ ok: true, status: 200, url, headers: { get: (h) => (/content-type/i.test(h) ? "text/csv" : null) }, text: async () => body });

/** A vm context standing in for a world: its own globals, `window` among them, and a silent console. */
export function world(extra = {}) {
    const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, ...extra });
    vm.runInContext("globalThis.window = globalThis", ctx);
    return ctx;
}

const AsyncFunction = (async () => {}).constructor;

/**
 * The page's main world for one approved exec of a worker-built run, built from the page's own pieces: the reads sent
 * with the call answer `ml.dereference` (run-delegation.ts), a stored table reads its columns through `VALUE_COLUMNS`
 * from the run's tab, and a `@tool:` handle is pre-resolved so it is synchronous, its `.pipe()` re-reading
 * `@tool:<id>` (tools.ts `derefValue`).
 */
async function mainWorld(bg, payload) {
    const answer = preResolvedDeref(payload.reads ?? []);
    const deref = async (ref, pipe) => {
        const read = await answer(ref, pipe);
        const t = read.meta?.table, key = t ? read.meta.value : undefined;
        if (!key) return read;
        return { ...read, readColumns: async (names) => {
            const r = await bg.send({ type: "VALUE_COLUMNS", runId: payload.runId, key, names, ...(t.delimiter ? { delimiter: t.delimiter } : {}), ...(t.headerless ? { headerless: true } : {}) }, fromTab);
            if (r.error) throw new Error(r.error);
            return r;
        } };
    };
    const asyncDeref = async (ref, { pipe = null } = {}) => {
        const read = await deref(String(ref), pipe);
        return new DerefText(read.value, read.meta, (stages) => asyncDeref(ref, { pipe: stages }), read.readColumns);
    };
    const { code, expansions } = expandPointers(payload.args.js);
    const pre = new Map();
    for (const h of new Set(expansions.map((e) => e.from))) {
        try { const read = await deref(h); pre.set(h, { v: new DerefText(read.value, read.meta, (st) => asyncDeref(`@tool:${read.meta?.id ?? ""}`, { pipe: st }), read.readColumns) }); }
        catch (e) { pre.set(h, { e }); }
    }
    const ml = { dereference: (ref, opts) => {
        const p = !opts?.pipe ? pre.get(ref) : undefined;
        if (p) { if (p.e) throw p.e; return p.v; }
        return asyncDeref(ref, opts);
    } };
    try { return { result: `value: ${await new AsyncFunction("ml", code)(ml)}` }; }
    catch (e) { return { result: `Error: ${e.message}` }; }
}

/** A CDP fake whose isolated world is context 11, run in a vm context; the binding posts back as `Runtime.bindingCalled`. */
export function cdpWorld(getBg, onEvaluate) {
    const ctx = world({ __mlIsoStream: (payload) => getBg().emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 11, payload }) });
    return async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 11 };
        if (method === "Runtime.evaluate") {
            if (params.contextId !== 11) return { result: { value: { __mlWrapped: true, v: "RAN IN THE PAGE'S CONTEXT", logs: [] } } };
            await onEvaluate?.(getBg(), params, ctx);
            try { return { result: { value: JSON.parse(JSON.stringify(await vm.runInContext(params.expression, ctx) ?? null)) } }; }
            catch (e) { return { exceptionDetails: { text: String(e), exception: { description: `${e.name}: ${e.message}` } } }; }
        }
        return {};
    };
}

/**
 * One worker-built run on tab 7 (an approved page) on `path` ("readonly", "userScripts", "cdp", or "none": no isolation,
 * so a pointer script runs in the main world): each of `fetches`, then each of `scripts` as an exec, each script a
 * function of the first fetch's pointer id.
 * - `between(i, { bg, idb, id })`: awaited before script `i` is sent.
 * - `onExecute(bg, injection, worlds)`: a user-script injection has arrived and is about to run (its call is in flight).
 * - `onEvaluate(bg, params, ctx)`: an evaluate in the CDP world is about to run.
 * @returns the exec results the model read, the run's routing records, its hash, the worker, and the fetches' ids
 */
export async function runOn(path, scripts, { between, fetches = [{ url: DATA_URL, token: "orders" }], bodies = { [DATA_URL]: CSV }, onExecute, onEvaluate, onBg } = {}) {
    const idb = new IDBFactory();
    let n = 0, bg, id;
    const worlds = new Map();
    const userScripts = path !== "userScripts" ? undefined : {
        available: true,
        execute: async (inj) => {
            await onExecute?.(bg, inj, worlds);
            const ctx = worlds.get(inj.worldId) ?? world({ chrome: { runtime: { sendMessage: (m) => bg.emitUserScriptMessage(m, { tab: { id: 7 }, frameId: 0, documentId: "doc-1", userScriptWorldId: inj.worldId }) } } });
            worlds.set(inj.worldId, ctx);
            const r = vm.runInContext(inj.js[0].code, ctx);
            return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r;
        },
    };
    const steps = [...fetches.map((f) => ({ name: "fetch_url", args: f })), ...scripts.map((s) => ({ name: "exec", script: s }))];
    bg = loadBackground({
        siteGate: true, indexedDB: idb, userScripts,
        config: { ...config, autoApproveReadonly: path === "readonly", cdp: path === "cdp" },
        local: { ml_site_always: ["https://site.example"] },
        openTabs: [{ id: 7, url: SITE_URL, title: "Site" }],
        ...(path === "cdp" ? { onDebuggerCommand: cdpWorld(() => bg, onEvaluate) } : {}),
        onFetch: async (call) => {
            if (call.url in bodies) return csvResponse(call.url, bodies[call.url]);
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const tools = (call.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
            id ??= /@tool:([0-9a-f]{7})/.exec(tools[0] ?? "")?.[1];
            const step = steps[n++];
            if (!step) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            if (step.script) await between?.(n - 1 - fetches.length, { bg, idb, id });
            const args = step.script ? { js: step.script(id) } : step.args;
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: step.name, arguments: JSON.stringify(args) } }] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return {};
            if (msg.payload.name === "exec") return mainWorld(bg, msg.payload);
            return { result: "" };
        },
    });
    onBg?.(bg);
    bg.commit?.(7, { documentId: "doc-1", url: SITE_URL });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "probe", surface: "hud", maxSteps: 80 });
    for (let i = 0; i < 4000 && n <= steps.length; i++) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
    const last = bg.calls.filter((c) => c.url.includes("/chat/completions")).at(-1);
    const all = last.body.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    const ids = all.slice(0, fetches.length).map((t) => /@tool:([0-9a-f]{7})/.exec(t)?.[1]);
    const log = JSON.parse(JSON.stringify((await bg.context.__mlRunLog.all()).filter((r) => r.run === hash && r.subsystem === "routing")));
    return { results: all.slice(fetches.length), log, hash, bg, id, ids, idb };
}

