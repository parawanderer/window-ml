// exec-world.test.mjs — exec's `world` parameter and the default world (exec-routing.ts): every input to the route, the
// build constant `__EXEC_DEFAULT_WORLD__` and the stored setting over it, the one-line hint a page-global miss gets, and
// the same rules in the real background bundle, where the page is never told which world was asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { routeExec, pageGlobalHint, PAGE_GLOBAL_HINT, withoutWorld } = await import("../src/sw/exec-routing.ts");
const { BUILD_DEFAULT_WORLD, defaultExecWorld, DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
const { pageWorldRefusal, EXEC_WORLD_PARAM } = await import("../src/tools/tool-details.ts");
const { envOf } = await import("../src/sw/sw-current-env.ts");

const T = { timeout: 15000 };
const ROOT = new URL("..", import.meta.url).pathname;

// --- the route: every input ---

const SCRIPTS = { plain: "document.title = 'x'; return 1", pointer: "return @tool:exec.length", current: "return ml.current.messages.length", sh: "return (await ml.sh.run([\"ls\"])).code" };
/** Each policy that forces isolation, and none: [approved page, script]. */
const FORCED = { pointer: [true, SCRIPTS.pointer], current: [true, SCRIPTS.current], sh: [true, SCRIPTS.sh], "unapproved-page": [false, SCRIPTS.plain], none: [true, SCRIPTS.plain] };
const AVAIL = { userScripts: { userScripts: true, cdp: false }, cdp: { userScripts: false, cdp: true }, none: { userScripts: false, cdp: false } };

/**
 * The owner's decisions of 2026-10-14, written out as the outcome for one input: `main/<reason>`, `isolated/<how>/<reason>`
 * or `refused/<reason>`.
 */
function expected(world, def, avail, forced) {
    const how = avail === "none" ? null : avail;
    if (forced !== "none") {
        if (world === "page") return `refused/${forced}`;                       // "page" never overrides the policy
        if (how) return `isolated/${how}/${forced}`;
        if (world === "isolated") return `refused/${forced}`;                   // never downgraded
        return forced === "pointer" ? `main/${forced}+note` : `refused/${forced}`;   // today's fallback and refusals
    }
    if (world === "page") return "main/requested";
    if (world === "isolated") return how ? `isolated/${how}/requested` : "refused/requested";
    if (def === "isolated") return how ? `isolated/${how}/default` : "main/plain";   // a default is not a request
    return "main/plain";
}

const label = (r) => (r.where === "isolated" ? `isolated/${r.how}/${r.reason}` : r.where === "main" ? `main/${r.reason}${r.note ? "+note" : ""}` : `refused/${r.reason}`);

test("the route for every world asked, default world, isolation and policy", () => {
    let n = 0;
    for (const world of [undefined, "isolated", "page"]) for (const def of ["page", "isolated"]) for (const avail of Object.keys(AVAIL)) for (const forced of Object.keys(FORCED)) {
        const [approved, js] = FORCED[forced];
        const ask = world === undefined ? { defaultWorld: def } : { world, defaultWorld: def };
        const r = routeExec(js, approved, AVAIL[avail], ask);
        assert.equal(label(r), expected(world ?? "omitted", def, avail, forced), `world=${world ?? "omitted"} default=${def} isolation=${avail} policy=${forced}`);
        if (r.where === "refused") assert.match(r.result, /^Error: /);
        n++;
    }
    assert.equal(n, 3 * 2 * 3 * 5);
});

test("the default world, given nothing: a plain exec on an approved page runs in the page's world, as before this parameter", () => {
    for (const avail of Object.values(AVAIL)) assert.deepEqual(routeExec(SCRIPTS.plain, true, avail), { where: "main", reason: "plain" });
    assert.equal(BUILD_DEFAULT_WORLD, "page", "a build that defines nothing ships the page's world");
    assert.equal(defaultExecWorld(undefined), "page");
});

test("each refusal of a world says why and what to do instead, and never suggests the world it just refused", () => {
    const none = AVAIL.none;
    const iso = routeExec(SCRIPTS.plain, true, none, { world: "isolated" }).result;
    assert.match(iso, /world "isolated" was asked for and no isolated world is available.*Settings → Advanced.*or omit world\.$/);
    for (const [forced, why] of [["pointer", "it reads pointer values"], ["current", "it reads ml.current"], ["sh", "it runs programs through ml.sh"], ["unapproved-page", "this site is not approved for window.ml"]]) {
        const [approved, js] = FORCED[forced];
        const page = routeExec(js, approved, AVAIL.userScripts, { world: "page" }).result;
        assert.equal(page, `Error: world "page" is refused here: ${why}, so this exec runs only in an isolated world. Omit world.`);
        assert.doesNotMatch(page, /world: "page"/, "the refusal does not send the model back to the page's world");
    }
    assert.equal(routeExec(SCRIPTS.plain, true, AVAIL.userScripts, { world: "main" }).result, `Error: world must be "page" or "isolated", or omitted.`);
    assert.equal(routeExec(SCRIPTS.plain, true, AVAIL.userScripts, { world: 1 }).where, "refused");
});

test("the page's own world refuses an isolated or malformed world and runs a page or absent one", () => {
    assert.equal(pageWorldRefusal(undefined), null);
    assert.equal(pageWorldRefusal("page"), null);
    assert.match(pageWorldRefusal("isolated"), /^Error: world "isolated" is not available in this run, so this exec did not run\. Omit world\.$/);
    assert.match(pageWorldRefusal("main"), /^Error: world must be/);
});

test("the page is sent the call without its world", () => {
    assert.deepEqual(withoutWorld({ js: "1", world: "page" }), { js: "1" });
    const args = { js: "1" };
    assert.equal(withoutWorld(args), args);
});

// --- the build constant and the stored setting ---

/** BUILD_DEFAULT_WORLD as esbuild bundles it under `define`. */
async function bundledDefault(define) {
    const esbuild = await import("esbuild");
    const out = await esbuild.build({ entryPoints: [join(ROOT, "src/contract/contract-config.ts")], bundle: true, write: false, format: "cjs", platform: "neutral", logLevel: "silent", ...(define ? { define } : {}) });
    const mod = { exports: {} };
    vm.runInNewContext(out.outputFiles[0].text, { module: mod, exports: mod.exports });
    return { build: mod.exports.BUILD_DEFAULT_WORLD, resolve: mod.exports.defaultExecWorld };
}

test("__EXEC_DEFAULT_WORLD__ sets the build's default world, as the bench's variant builds define it", async () => {
    assert.equal((await bundledDefault({ __EXEC_DEFAULT_WORLD__: JSON.stringify("isolated") })).build, "isolated");
    assert.equal((await bundledDefault({ __EXEC_DEFAULT_WORLD__: JSON.stringify("page") })).build, "page");
    assert.equal((await bundledDefault()).build, "page", "undefined: the page's world");
    // The stored setting overrides the build either way; empty or absent leaves it.
    const iso = (await bundledDefault({ __EXEC_DEFAULT_WORLD__: JSON.stringify("isolated") })).resolve;
    assert.deepEqual(["", undefined, "page", "isolated", "bogus"].map(iso), ["isolated", "isolated", "page", "isolated", "isolated"]);
    assert.deepEqual(["", undefined, "page", "isolated", "bogus"].map(defaultExecWorld), ["page", "page", "page", "isolated", "page"]);
});

test("build.mjs refuses an __EXEC_DEFAULT_WORLD__ that is neither world, before it builds anything", () => {
    const out = mkdtempSync(join(tmpdir(), "wml-world-"));
    try {
        const r = spawnSync(process.execPath, ["build.mjs", "--outdir", join(out, "d"), "--define", "__EXEC_DEFAULT_WORLD__=isolated"], { cwd: ROOT, encoding: "utf8", timeout: 20000 });
        assert.notEqual(r.status, 0, "an unquoted value is not a JSON string");
        assert.match(r.stderr, /__EXEC_DEFAULT_WORLD__ must be one of "page", "isolated", got isolated/);
    } finally { rmSync(out, { recursive: true, force: true }); }
});

test("the stored setting is empty by default, so an install from before it keeps the build's default", () => {
    assert.equal(DEFAULT_CONFIG.execDefaultWorld, "");
    assert.equal(defaultExecWorld({ ...DEFAULT_CONFIG }.execDefaultWorld), BUILD_DEFAULT_WORLD);
});

test("ml.current.env says where an exec without world goes under each default", () => {
    const us = AVAIL.userScripts;
    assert.equal(envOf("u", true, us, true).exec.readsNeither, "page", "no default given: the page's world");
    assert.equal(envOf("u", true, us, true, "isolated").exec.readsNeither, "isolated");
    assert.equal(envOf("u", true, AVAIL.none, true, "isolated").exec.readsNeither, "page", "no isolation: the page's world, as an exec without world runs");
    assert.equal(envOf("u", false, us, true, "page").exec.readsNeither, "isolated", "policy still isolates");
});

// --- the hint, and only where the page's world is open to the call ---

test("a page global's miss in an isolated world gets the hint only when the call could have run in the page's world", () => {
    const misses = ["The exec threw: ReferenceError: __APP__ is not defined", "The exec threw: TypeError: Cannot read properties of undefined (reading 'total')"];
    const others = ["The exec threw: TypeError: Cannot read properties of null (reading 'click')", "The exec threw: SyntaxError: Unexpected token", "The exec stopped before it finished: the page navigated."];
    for (const reason of ["requested", "default"]) {
        for (const e of misses) assert.equal(pageGlobalHint({ where: "isolated", reason }, e), PAGE_GLOBAL_HINT, `${reason}: ${e}`);
        for (const e of others) assert.equal(pageGlobalHint({ where: "isolated", reason }, e), "", `${reason}: ${e}`);
    }
    // Policy isolated it: `world: "page"` would be refused, so the hint would send the model into a refusal.
    for (const reason of ["pointer", "current", "unapproved-page"]) for (const e of misses) assert.equal(pageGlobalHint({ where: "isolated", reason }, e), "", reason);
    for (const where of ["main", "refused"]) assert.equal(pageGlobalHint({ where, reason: "requested" }, misses[0]), "");
    assert.equal(PAGE_GLOBAL_HINT, `Page globals need world: "page".`);
});

test("the parameter's text is terse and unpadded", () => {
    assert.ok(EXEC_WORLD_PARAM.length < 120, EXEC_WORLD_PARAM);
    for (const s of [EXEC_WORLD_PARAM, PAGE_GLOBAL_HINT]) assert.doesNotMatch(s, / {2}/);
});

// --- in the worker: a worker-built run's exec, routed by the real background bundle ---

const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
/** A config as an install from before `execDefaultWorld` stored it: no such key. */
const OLD_CONFIG = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", cdp: false };

/**
 * A worker-built run on SITE whose model sends each call in `calls` (`{ js, world? }`) to exec. `us`: user scripts
 * allowed (true) or not ("off"). Returns every exec message the page was sent, what the model read back, the routing
 * records, and how many approvals were asked for.
 */
async function worldRun(calls, { us = true, approved = true, config = {}, autoRO = false } = {}) {
    let n = 0, bg, approvals = 0;
    const cards = [];
    const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, document: { title: "Site" } });
    vm.runInContext("globalThis.window = globalThis", ctx);
    bg = loadBackground({
        config: { ...OLD_CONFIG, autoApproveReadonly: autoRO, ...config }, openTabs: [SITE],
        userScripts: { available: us !== "off", execute: async (inj) => { const r = vm.runInContext(inj.js[0].code, ctx); return r && typeof r.then === "function" ? JSON.parse(JSON.stringify(await r)) : r; } },
        local: approved ? { ml_site_always: ["https://site.example"] } : {},
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const c = calls[n++];
            return c === undefined
                ? jsonResponse({ choices: [{ message: { content: "done" } }] })
                : jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "exec", arguments: JSON.stringify(c) } }] } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) { approvals++; cards.push(JSON.parse(JSON.stringify(msg.event.renderIn ?? null))); void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } }); }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            if (msg.payload.renderOnly || msg.payload.precheck) return {};
            if (msg.payload.readonlyTry) return { readonly: true, result: "value: \"SURVEYED IN THE PAGE\"" };
            return { result: "value: \"FROM THE PAGE\"" };
        },
    });
    const panel = bg.connect("ml-devtools");
    panel.send({ type: "ml-devtools-init", tabId: 7 });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "calls", surface: "hud" });
    for (let i = 0; i < 400 && n <= calls.length; i++) await new Promise((r) => setTimeout(r, 0));
    await flush(30);
    const execMsgs = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "exec").map(([, m]) => JSON.parse(JSON.stringify(m.payload)));
    const ran = execMsgs.filter((p) => !p.renderOnly && !p.precheck && !p.readonlyTry);
    const results = bg.calls.filter((c) => c.url.includes("/chat/completions")).at(-1).body.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const log = JSON.parse(JSON.stringify((await bg.context.__mlRunLog.all()).filter((r) => r.run === hash && r.subsystem === "routing")));
    const isolated = bg.userScriptCalls.filter(([k, inj]) => k === "execute" && !/^globalThis\.__mlIsoStarted$/.test(inj.js[0].code)).length;
    const tools = bg.calls.find((c) => c.url.includes("/chat/completions")).body.tools;
    return { cards, tools, execMsgs, ran, results, log: log.filter((r) => /^exec-/.test(r.kind)).map((r) => [r.kind, r.reason]), roLog: log.filter((r) => /^readonly-/.test(r.kind)).map((r) => [r.kind, r.reason]), isolated, approvals };
}

const PLAIN = "document.title = 'x'; return 1";

test("UPGRADE: a stored config from before the setting runs an exec without world in the page's world, as today", T, async () => {
    const r = await worldRun([{ js: PLAIN }]);
    assert.deepEqual(r.log, [["exec-main", "plain"]]);
    assert.equal(r.ran.length, 1);
    assert.match(r.results[0], /FROM THE PAGE/);
    assert.equal(r.isolated, 0);
});

test("the stored setting `isolated` runs an exec without world isolated; with no isolation it runs in the page's world", T, async () => {
    const iso = await worldRun([{ js: PLAIN }], { config: { execDefaultWorld: "isolated" } });
    assert.deepEqual(iso.log, [["exec-isolated", "default"]]);
    assert.equal(iso.ran.length, 0, "the page was sent nothing to run");
    assert.match(iso.results[0], /Ran in an isolated world because it is the default here/);
    assert.doesNotMatch(iso.results[0], /page-writable/, "an isolated result carries no page-writable heading");
    const none = await worldRun([{ js: PLAIN }], { us: "off", config: { execDefaultWorld: "isolated" } });
    assert.deepEqual(none.log, [["exec-main", "plain"]], "a default is not a request: no refusal");
    assert.match(none.results[0], /FROM THE PAGE/);
});

test("world: \"page\" runs in the page's world over an isolated default, and the page is not told it was asked", T, async () => {
    const r = await worldRun([{ js: PLAIN, world: "page" }], { config: { execDefaultWorld: "isolated" } });
    assert.deepEqual(r.log, [["exec-main", "requested"]]);
    assert.equal(r.ran.length, 1);
    for (const p of r.execMsgs) assert.ok(!("world" in p.args), `no exec message to the page carries world: ${JSON.stringify(p)}`);
});

test("world: \"isolated\" with no isolated world is refused before anyone is asked, and runs nowhere", T, async () => {
    const r = await worldRun([{ js: PLAIN, world: "isolated" }], { us: "off" });
    assert.equal(r.execMsgs.length, 0, "the page was sent nothing, not even a precheck");
    assert.equal(r.isolated, 0);
    assert.equal(r.approvals, 0, "no approval asked for a call that cannot run");
    assert.match(r.results[0], /^Error: world "isolated" was asked for and no isolated world is available/);
});

test("world: \"page\" for a script policy isolates is refused, and the plain retry it is told to make runs isolated", T, async () => {
    const r = await worldRun([{ js: PLAIN }, { js: "return @tool:exec.length", world: "page" }, { js: "return @tool:exec.length" }]);
    assert.match(r.results[1], /^Error: world "page" is refused here: it reads pointer values/);
    assert.deepEqual(r.log, [["exec-main", "plain"], ["exec-isolated", "pointer"]], "the refused call never reached routing after a gate");
    assert.equal(r.ran.length, 1, "only the first ran in the page");
});

test("an isolated exec that misses a page global gets the hint; one policy isolated does not", T, async () => {
    const asked = await worldRun([{ js: "return window.__APP__.total", world: "isolated" }]);
    assert.match(asked.results[0], /Cannot read properties of undefined[\s\S]*\nPage globals need world: "page"\./);
    const byDefault = await worldRun([{ js: "return __APP__" }], { config: { execDefaultWorld: "isolated" } });
    assert.match(byDefault.results[0], /is not defined[\s\S]*\nPage globals need world: "page"\./);
    const unapproved = await worldRun([{ js: "return window.__APP__.total" }], { approved: false });
    assert.match(unapproved.results[0], /Cannot read properties of undefined/);
    assert.doesNotMatch(unapproved.results[0], /world: "page"/, "a page the call may not run in is never suggested");
    const fine = await worldRun([{ js: "return document.title", world: "isolated" }]);
    assert.doesNotMatch(fine.results[0], /Page globals/);
});

test("a read-only survey with world: \"isolated\" never runs in the page's world: the page leg is skipped", T, async () => {
    const r = await worldRun([{ js: "document.title", world: "isolated" }], { autoRO: true });
    assert.equal(r.execMsgs.filter((p) => p.readonlyTry).length, 0, "no read-only try was sent to the page");
    assert.deepEqual(r.roLog, [["readonly-worker", "world-isolated"]]);
    assert.deepEqual(r.log, [["exec-isolated", "requested"]], "it went to the gate and ran isolated");
    const page = await worldRun([{ js: "document.title", world: "page" }], { autoRO: true });
    const tries = page.execMsgs.filter((p) => p.readonlyTry);
    assert.equal(tries.length, 1);
    assert.ok(!("world" in tries[0].args), "the page's read-only try is not told the world");
});

// --- review of #664: the card, the schema, null, a non-string js, and the survey on the default build ---

const { WORLD_CARD } = await import("../src/sw/exec-routing.ts");
const { withExecWorld } = await import("../src/tools/tool-details.ts");

test("the approval card says the world when the call's world moves the exec away from where the default runs it", T, async () => {
    const steered = await worldRun([{ js: PLAIN, world: "page" }], { config: { execDefaultWorld: "isolated" } });
    assert.equal(steered.cards.length, 1);
    assert.equal(steered.cards[0].note, WORLD_CARD.main, "an isolated default, and the model asked for the page's world");
    assert.equal(WORLD_CARD.main, "Runs in the page's own world, where the page's scripts can see and change it.");
    const iso = await worldRun([{ js: PLAIN, world: "isolated" }]);
    assert.equal(iso.cards[0].note, WORLD_CARD.isolated);
    assert.equal(WORLD_CARD.isolated, "Runs in an isolated world, hidden from the page's scripts.");
    // Where the call lands where the default would: no line.
    for (const [call, config] of [[{ js: PLAIN, world: "page" }, {}], [{ js: PLAIN, world: "isolated" }, { execDefaultWorld: "isolated" }], [{ js: PLAIN }, { execDefaultWorld: "isolated" }]]) {
        const r = await worldRun([call], { config });
        assert.equal(r.cards[0]?.note, undefined, JSON.stringify([call, config]));
    }
    for (const s of Object.values(WORLD_CARD)) assert.doesNotMatch(s, /\u2014|\u2013/, "no dashes");
});

test("world is offered to a run the worker drives and not to one a page started", T, async () => {
    const worker = await worldRun([]);
    const exec = worker.tools.find((t) => t.function.name === "exec");
    assert.deepEqual(exec.function.parameters.properties.world.enum, ["page", "isolated"]);
    // The page's own exec tool (what a page-built run's model is sent) has no `world`.
    const { makeDomTools } = await import("../src/tools/tools.ts");
    const pageExec = makeDomTools((t) => t).find((t) => t.name === "exec");
    assert.ok(pageExec.parameters.properties.js, "positive control: the page's exec schema");
    assert.equal(pageExec.parameters.properties.world, undefined, "the page's exec offers no world");
    const tools = [{ name: "exec", parameters: { type: "object", properties: { js: { type: "string" } } } }, { name: "click", parameters: { type: "object", properties: {} } }];
    const out = withExecWorld(tools);
    assert.ok(out[0].parameters.properties.world && !tools[0].parameters.properties.world, "a copy, the input untouched");
    assert.equal(out[1], tools[1]);
});

test("world: null is world omitted", T, async () => {
    for (const def of ["page", "isolated"]) for (const avail of Object.values(AVAIL)) for (const [approved, js] of Object.values(FORCED))
        assert.deepEqual(routeExec(js, approved, avail, { world: null, defaultWorld: def }), routeExec(js, approved, avail, { defaultWorld: def }));
    assert.equal(pageWorldRefusal(null), null);
    const r = await worldRun([{ js: PLAIN, world: null }]);
    assert.deepEqual(r.log, [["exec-main", "plain"]]);
    assert.ok(r.execMsgs.every((p) => !("world" in p.args)), "null is not sent on either");
});

test("an exec whose js is not a string is refused in the worker, and nothing with its world reaches the page", T, async () => {
    const r = await worldRun([{ js: 5, world: "page" }]);
    assert.match(r.results[0], /^Error: invalid arguments for "exec": "js" must be a string\./);
    assert.equal(r.execMsgs.length, 0, JSON.stringify(r.execMsgs));
    assert.equal(r.approvals, 0);
});

test("on the default build, a world-less read-only survey still auto-answers on the page's leg", T, async () => {
    const r = await worldRun([{ js: "document.title" }], { autoRO: true });
    assert.deepEqual(r.roLog, [["readonly-page", "reads-page"]]);
    assert.equal(r.approvals, 0, "no gate");
    assert.match(r.results[0], /SURVEYED IN THE PAGE/);
});
