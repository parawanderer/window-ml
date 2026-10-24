// redteam-exec-shared-world.test.mjs — the red-team pass on a MAIN-world exec after its `console` became a parameter
// (docs/spec/SITE_PRESENCE.md, Order step 1): what a page sharing that world can still read from, or write into, the
// model's result, the panel's render and the live stream, and what it can do to the closed-root capture. The
// coordinator's tests are in redteam-exec-console.test.mjs and redteam-isolated.test.mjs; these add to them.
//
// Two harnesses. The main-world exec (tools.ts) runs in loadDomWorld, where page code is run in the same vm context as
// shadow-patch.js and injected.js. The strict-CSP exec (sw-cdp.ts cdpEval) runs against a chrome.debugger fake whose
// Runtime.evaluate REALLY evaluates in a vm context standing in for the page's main world (context 1), and whose
// Runtime.addBinding puts a function on that context's global that raises Runtime.bindingCalled, as Chrome does.
// A property the shared world cannot keep is a `todo` naming why; a test with no `todo` that fails is a gap to fix.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadDomWorld } = require("./helpers");

const T = { timeout: 15000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x));

/** The page's main world with window.ml, and a runner for the exec tool as a run calls it. */
function page(html = "<button>b</button>") {
    const w = loadDomWorld(html);
    const execTool = w.ml.domTools.find((t) => t.name === "exec");
    const pageRun = (src) => vm.runInContext(src, w.context);
    return { ...w, exec: (js) => execTool.run({ js }, {}), pageRun };
}

/** A page with a closed root captured by the patch, and a run that sets piercing as a re-adopt sets it. */
function sealedPage() {
    const p = page("<sealed-widget></sealed-widget><other-widget></other-widget>");
    p.document.querySelector("sealed-widget").attachShadow({ mode: "closed" }).innerHTML = '<button class="secret">real</button>';
    const pierce = (on) => p.ml._adoptRun(`pierce-${on}`, { toolNames: [], pierceClosed: on, builtBy: "worker" });
    const desc = (sel) => { const r = p.ml.domTools.find((t) => t.name === "describeElement").run({ selector: sel }); return String(r.content ?? r); };
    return { ...p, pierce, desc };
}

// --- main world: what the console parameter keeps out ---

test("a line the page logs from a handler or function the exec itself calls goes to the page's console, not into the result", T, async () => {
    const p = page();
    p.pageRun(`
        globalThis.__pageLines = [];
        const log = console.log;
        console.log = (...a) => { __pageLines.push(a.join(" ")); };
        document.querySelector("button").onclick = () => console.log("PAGE HANDLER");
        globalThis.pageHelper = () => { console.log("PAGE HELPER"); return 2; };
    `);
    const r = await p.exec("document.querySelector('button').click(); console.log('own'); pageHelper()");
    assert.match(r.content, /own/, "positive control: the exec's own line was captured");
    assert.doesNotMatch(r.content, /PAGE HANDLER|PAGE HELPER/, r.content);
    assert.doesNotMatch(JSON.stringify(r.render ?? {}), /PAGE HANDLER|PAGE HELPER/, "the panel's copy carried a page line");
    assert.deepEqual(plain(p.pageRun("__pageLines")), ["PAGE HANDLER", "PAGE HELPER"], "positive control: the page's lines went to its own console");
});

// --- main world: the closed-root ask ---

test("a page that listens for the closed-root ask and rewrites the builtins the patch calls neither hears the DOM tools' ask nor changes its answer", T, () => {
    const p = sealedPage();
    // After load, as any page script can: a listener in both phases, and the builtins shadow-patch's listener calls.
    p.pageRun(`
        globalThis.__heardAsk = 0;
        window.addEventListener("wml-closed-roots", () => { __heardAsk++; }, true);
        window.addEventListener("wml-closed-roots", () => { __heardAsk++; });
        Event.prototype.stopImmediatePropagation = function () {};
        window.Event.prototype.stopImmediatePropagation = function () {};
        const apply = Reflect.apply;
        Reflect.apply = function (f, t, a) { globalThis.__applied = (globalThis.__applied || 0) + 1; return apply(f, t, a); };
    `);
    p.pierce(true);
    assert.match(p.desc("sealed-widget >>> button.secret"), /real/, "positive control: the tools read the captured root");
    assert.equal(p.pageRun("__heardAsk"), 0, "a page listener heard the DOM tools ask for the reader");
    assert.equal(p.pageRun("globalThis.__applied ?? 0"), 0, "the patch called the page's Reflect.apply");
});

// --- strict-CSP main world through CDP (cdpEval) ---

/** A chrome.debugger whose page is a vm context (the main world, context 1): Runtime.evaluate runs the expression
 *  there, and Runtime.addBinding installs a global that raises bindingCalled from context 1. `contexts` is what enabling
 *  Runtime reports (the top frame is F1). */
function cdpPage({ contexts = [{ id: 1, auxData: { isDefault: true, frameId: "F1" } }] } = {}) {
    const pageLines = [];
    const calls = [];
    const listeners = new Set();
    const sink = (k) => (...a) => pageLines.push(`${k}: ${a.join(" ")}`);
    const ctx = vm.createContext({ console: { log: sink("log"), info: sink("info"), warn: sink("warn"), error: sink("error"), debug: sink("debug") }, setTimeout, Date });
    vm.runInContext("globalThis.window = globalThis", ctx);
    const fire = (params) => [...listeners].forEach((fn) => fn({ tabId: 7 }, "Runtime.bindingCalled", params));
    globalThis.chrome = {
        permissions: { contains: async () => true },
        webNavigation: { getFrame: async () => ({ documentId: "doc-7", frameId: 0 }) },   // the document the exec is pinned to
        debugger: {
            attach: async () => {}, detach: async () => {},
            onDetach: { addListener: () => {} },
            onEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
            sendCommand: async (_t, method, params = {}) => {
                calls.push([method, params]);
                if (method === "Runtime.addBinding") {
                    ctx[params.name] = (payload) => fire({ name: params.name, payload: String(payload), executionContextId: 1 });
                    return {};
                }
                if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
                if (method === "Runtime.enable") { for (const context of contexts) [...listeners].forEach((fn) => fn({ tabId: 7 }, "Runtime.executionContextCreated", { context })); return {}; }
                if (method !== "Runtime.evaluate") return {};
                if (params.contextId !== undefined && params.contextId !== 1) throw new Error("Cannot find context with specified id");
                try {
                    const v = await vm.runInContext(params.expression, ctx);
                    return { result: { value: v === undefined ? undefined : plain(v) } };
                } catch (e) {
                    return { exceptionDetails: { text: "Uncaught", executionContextId: 1, exception: { description: String(e?.stack ?? e) } } };
                }
            },
        },
    };
    return { ctx, pageLines, calls, run: (src) => vm.runInContext(src, ctx) };
}
const { cdpEval, releaseDebugger } = await import("../src/sw/sw-cdp.ts");
after(() => releaseDebugger(7));

test("a strict-page exec keeps the page's lines out of its result, and a page that swaps __mlCdpStream mid-exec gets none of its stream", T, async () => {
    const p = cdpPage();
    p.run(`
        globalThis.__stolen = [];
        setTimeout(() => {
            console.log("PAGE SAYS DURING EXEC");
            globalThis.__mlCdpStream = (payload) => __stolen.push(payload);
        }, 10);
    `);
    const live = [];
    const r = await cdpEval(7, "doc-7", "console.log('first'); await new Promise((res) => setTimeout(res, 40)); console.log('second'); return 1", (text) => live.push(text));
    assert.ok("ok" in r, JSON.stringify(r));
    assert.deepEqual(r.logs, ["first", "second"], "positive control: both of the script's lines were collected");
    assert.deepEqual(live, ["first\n", "second\n"], "both streamed through the binding the wrapper took at its start");
    assert.doesNotMatch(r.text, /PAGE SAYS/, r.text);
    assert.deepEqual(plain(p.run("__stolen")), [], "the page's replacement binding received the script's lines");
    assert.ok(p.pageLines.includes("log: PAGE SAYS DURING EXEC"), "positive control: the page's line went to its own console");
});

test("the binding is off the page's global after a strict-page exec that throws, and after one that never parsed", T, async () => {
    for (const [src, what] of [["throw new Error('boom')", /boom/], ["return )(", /SyntaxError/]]) {
        const p = cdpPage();
        const r = await cdpEval(7, "doc-7", src, () => {});
        assert.match(String(r.error ?? ""), what, `positive control: the exec failed as expected: ${JSON.stringify(r)}`);
        assert.ok(p.calls.some(([m, a]) => m === "Runtime.addBinding" && a.name.startsWith("__mlCdpStream")), "positive control: the binding was installed");
        assert.equal(p.run("Object.getOwnPropertyNames(globalThis).some((k) => k.startsWith('__mlCdpStream'))"), false, `the binding outlived ${JSON.stringify(src)}`);
    }
});

test("a tab that reports no main-world context for its top frame runs nothing: no exec and no binding, rather than an unpinned one", T, async () => {
    const p = cdpPage({ contexts: [{ id: 3, auxData: { isDefault: true, frameId: "F2" } }, { id: 11, auxData: { isDefault: false, frameId: "F1" } }] });
    const live = [];
    const r = await cdpEval(7, "doc-7", "console.log('kept'); return 1", (t) => live.push(t));
    assert.match(String(r.error ?? ""), /main world could not be found/, JSON.stringify(r));
    assert.ok(!p.calls.some(([m]) => m === "Runtime.evaluate"), "the script was evaluated with no context to pin it to");
    assert.ok(!p.calls.some(([m]) => m === "Runtime.addBinding"), "a binding was installed with no context to check its calls against");
    assert.deepEqual(live, []);
    assert.equal(p.run("Object.getOwnPropertyNames(globalThis).some((k) => k.startsWith('__mlCdpStream'))"), false);
});

// --- an approved exec runs once ---

// Predated the console change (#652 review, gap A): tools.ts took any SyntaxError from the eval fast path as a parse
// error and re-ran the source as an async body, so the side effects before the throw happened twice. An honest
// `JSON.parse` did it, and so could the page, by throwing a SyntaxError from a builtin it patched. The evaluated source
// now sets a marker before its first statement (exec-trace.ts evalWrapper `ran`), and only a source that never started
// is retried.
test("a main-world exec whose expression throws a SyntaxError while it RUNS is not run a second time", T, async () => {
    const p = page();
    p.pageRun("globalThis.__n = 0");
    const r = await p.exec("(globalThis.__n++, JSON.parse('{'))");
    assert.match(r.content, /JSON/, `positive control: the error reached the model: ${r.content}`);
    assert.equal(p.pageRun("__n"), 1, "the approved script ran twice");
});

// Predated the console change (#652 review, gap A): cdpEval re-ran the source as a body whenever the exception's
// description matched /SyntaxError/, which a runtime JSON.parse error does, and any page function the script calls can
// throw an error whose MESSAGE says it. The wrapper now catches and returns `threw`, so an exception the evaluate reports
// means the wrapper never parsed, the only case the body form is tried for.
test("a strict-page exec that throws while it RUNS is not run a second time, whatever its error says", T, async () => {
    for (const [setup, src] of [
        ["", "(globalThis.__n++, JSON.parse('{'))"],
        ["globalThis.pageFn = () => { throw new Error('not a SyntaxError at all'); }", "(globalThis.__n++, pageFn())"],
    ]) {
        const p = cdpPage();
        p.run(`globalThis.__n = 0; ${setup}`);
        const r = await cdpEval(7, "doc-7", src);
        assert.ok(r.error, `positive control: the exec failed: ${JSON.stringify(r)}`);
        assert.equal(p.run("__n"), 1, `the approved script ran twice: ${src}`);
    }
});

// --- open while the exec shares the page's world ---

const SHARED = "Inherent while the exec runs in the page's realm (docs/spec/SITE_PRESENCE.md, step 1): its collector, its result string and the envelope that carries them are built with builtins the page can rewrite, and sent on a MessagePort whose postMessage is one of them, so closing one vector closes none. The model is told its console is page-writable (MAIN_CONSOLE_HEAD).";

test("a page function the exec calls cannot reach the exec's collector, state or ml through Function.caller", T, async () => {
    const p = page();
    p.pageRun(`
        globalThis.__got = null;
        globalThis.helper = function helper() {
            const a = helper.caller && helper.caller.arguments;
            if (a) { __got = [...a].map((x) => typeof x); const c = [...a].find((x) => x && typeof x.log === "function" && x !== console); if (c) c.log("FORGED VIA CALLER"); }
            return 1;
        };
    `);
    const r = await p.exec("console.log('own'); helper()");
    assert.match(r.content, /own/, "positive control");
    // The eval wrapper is a closure taking only the source (exec-trace.ts evalWrapper), which PAGE_TOOL_RUN already shows the page.
    const got = plain(p.pageRun("__got"));
    assert.ok(got === null || JSON.stringify(got) === '["string"]', `the page read more than the source from the wrapper's arguments: ${JSON.stringify(got)}`);
    assert.doesNotMatch(r.content, /FORGED/, r.content);
});

test("a page accessor on console.log neither receives the exec's lines nor puts its own in the result", T, async () => {
    const p = page();
    p.pageRun(`
        globalThis.__read = []; let coll = null;
        Object.defineProperty(console, "log", { configurable: true, set(v) { coll = v; }, get() { return (...a) => { __read.push(a.join(" ")); coll && coll("FORGED VIA ACCESSOR"); }; } });
    `);
    const r = await p.exec("console.log('the script says this'); 1");
    assert.deepEqual(plain(p.pageRun("__read")), [], "the page read the exec's line");
    assert.doesNotMatch(r.content, /FORGED/, r.content);
    assert.match(r.content, /the script says this/, "the exec's own line is missing from the result");
});

test("a page that rewrites Array.prototype.map neither reads the exec's lines nor rewrites them", { ...T, todo: `${SHARED} This vector: the collector joins each call's arguments with \`a.map(…).join(" ")\`.` }, async () => {
    const p = page();
    p.pageRun(`
        globalThis.__read = [];
        const map = Array.prototype.map;
        Array.prototype.map = function (f) { const out = map.call(this, f); if (out.includes("secret")) { __read.push([...out]); return ["FORGED VIA MAP"]; } return out; };
    `);
    const r = await p.exec("console.log('secret'); 1");
    assert.deepEqual(plain(p.pageRun("__read")), [], "the page read the exec's line");
    assert.match(r.content, /secret/, r.content);
});

test("the VALUE of a main-world exec is the script's own: a page cannot rewrite it (the result is labelled page-writable, but the value is still the page's to change)", { ...T, todo: `${SHARED} The value is exactly as page-writable as the console (tools.ts serialises it with the page's JSON.stringify; the CDP wrapper too). The model is told so by PAGE_WORLD_HEAD on the whole result; the page can still change it.` }, async () => {
    const p = page();
    p.pageRun(`
        const s = JSON.stringify;
        JSON.stringify = function (v, ...rest) { return v && v.price === 10 ? '{"price":0}' : s.call(this, v, ...rest); };
    `);
    const r = await p.exec("console.log('own'); ({ price: 10 })");
    assert.match(r.content, /own/, "positive control");
    assert.match(r.content, /"price":10/, r.content);
});

// The delegated exec's request, live stream and result travel on injected.js's port to the content script (SITE_PRESENCE
// step 2b), not on the page's window. `run` sends the PAGE_TOOL_RUN as content.js would and resolves to its result.
function delegatedExec(p, runId) {
    p.ml._adoptRun(runId, { toolNames: ["exec"], builtBy: "worker" });
    const done = new Promise((res) => p.fromInjected((e) => { if (e.data?.type === "PAGE_TOOL_RESULT") res(e.data); }));
    p.asContent({ type: "PAGE_TOOL_RUN", callId: "c1", runId, name: "exec", args: { js: "console.log('the script prints this'); 1" }, stream: true });
    return Promise.race([done, sleep(3000).then(() => null)]);
}

test("a page reads neither a delegated exec's live stream nor its result off its own window", T, async () => {
    const p = page();
    p.pageRun(`
        globalThis.__heard = [];
        const post = window.postMessage.bind(window);
        window.postMessage = function (m, o) { if (m && /^PAGE_TOOL_(STREAM|RESULT)$/.test(m.type)) __heard.push(JSON.stringify(m)); return post(m, o); };
        window.addEventListener("message", (e) => { if (e.data && /^PAGE_TOOL_(STREAM|RESULT)$/.test(e.data.type)) __heard.push(JSON.stringify(e.data)); }, true);
    `);
    assert.ok(await delegatedExec(p, "r-stream"), "positive control: the delegated exec answered");
    assert.deepEqual(plain(p.pageRun("__heard")).filter((m) => m.includes("the script prints this")), [], "the page read the exec's output off its window");
});

test("a page that rewrites MessagePort.prototype.postMessage reads neither a delegated exec's stream nor its result", { ...T, todo: `${SHARED} This vector: injected.js's port is a MessagePort of the page's realm, and its postMessage the page's to wrap (docs/dev/detection-surface.md).` }, async () => {
    const p = page();
    p.pageRun(`
        globalThis.__heard = [];
        const proto = Object.getPrototypeOf(new MessageChannel().port1);
        const post = proto.postMessage;
        proto.postMessage = function (m) { if (m && /^PAGE_TOOL_(STREAM|RESULT)$/.test(m.type)) __heard.push(JSON.stringify(m)); return post.apply(this, arguments); };
    `);
    assert.ok(await delegatedExec(p, "r-proto"), "positive control: the delegated exec answered");
    assert.deepEqual(plain(p.pageRun("__heard")).filter((m) => m.includes("the script prints this")), [], "the page read the exec's output off the port");
});

test("an error a page function throws cannot point the model at a line of its choosing", { ...T, todo: "Inherent: a page function the exec calls throws what it likes, and execErrorLine (exec-trace.ts) reads the line from the error's stack, which the page writes. The range check keeps it inside the script, not on the line that threw." }, async () => {
    const { evalLineOffset } = await import("../src/tools/exec-trace.ts");
    const off = await evalLineOffset("eval", ["state", "console"]);
    const p = page();
    p.pageRun(`globalThis.boom = () => { const e = new Error("from the page"); e.stack = "Error: from the page\\n    at eval (eval at run (x), <anonymous>:${2 + off}:1)"; throw e; };`);
    const r = await p.exec("1;\nboom();\n3");
    assert.match(r.content, /from the page/, "positive control: the page's error reached the model");
    assert.doesNotMatch(r.content, /\(line 2\)/, `the page's stack chose the line the model reads: ${r.content}`);
});

test("a page that puts a `read` accessor on Object.prototype cannot put a root of its choosing behind a host through the reader handover", T, () => {
    const p = sealedPage();
    p.pageRun(`
        const decoyHost = document.createElement("div");
        const decoy = decoyHost.attachShadow({ mode: "open" });
        decoy.innerHTML = '<button class="secret">DECOY</button>';
        const target = document.querySelector("other-widget");
        let real = null;
        Object.defineProperty(Object.prototype, "read", { configurable: true, set(v) { real = v; }, get() { return (el) => (el === target ? decoy : real ? real(el) : null); } });
    `);
    p.pierce(true);
    assert.match(p.desc("sealed-widget >>> button.secret"), /real/, "positive control: the real captured root resolves");
    assert.doesNotMatch(p.desc("other-widget >>> button.secret"), /DECOY/, "the DOM tools read the page's decoy behind other-widget");
});

test("an unapproved page cannot tell window.ml is installed by asking for the closed-root reader", { ...T, todo: "Inherent while shadow-patch.js runs on every page at document_start (detection-surface.md row 2, whose fix is registering it for approved origins only): the event that replaced `__mlClosedRoots` answers any page that dispatches it, as the non-native `attachShadow` already does." }, () => {
    const p = page();
    const d = p.pageRun(`(() => { const d = {}; window.dispatchEvent(new CustomEvent("wml-closed-roots", { detail: d })); return typeof d.read; })()`);
    assert.equal(d, "undefined", "the page received a reader, which only this extension hands out");
});

// --- the #652 review: one-shot wrappers, the collector's prototype, the dereference key, the reader's one answer ---

/** Page code that, called by the exec, tries every function it can reach (its `.caller`, and each frame's
 *  `getFunction()` through Error.prepareStackTrace) with arguments of its own, and records what ran. */
const REACH = `
    globalThis.__reached = [];
    globalThis.reach = function reach() {
        const fns = new Set();
        try { if (reach.caller) fns.add(reach.caller); } catch {}
        const prev = Error.prepareStackTrace;
        Error.prepareStackTrace = (e, cs) => cs.map((c) => { try { return c.getFunction(); } catch { return undefined; } });
        try { for (const f of new Error().stack) if (typeof f === "function") fns.add(f); } catch {}
        Error.prepareStackTrace = prev;
        const forged = { log() { __reached.push("collector-replaced"); }, info() {}, warn() {}, error() {}, debug() {} };
        for (const f of fns) {
            if (f === reach) continue;
            for (const args of [["console.log('FORGED BY THE PAGE'); state.planted = 1"], [{ planted: 1 }, forged], [{ planted: 1 }, undefined, forged]]) {
                try { const v = f(...args); __reached.push("called"); if (v && typeof v.then === "function") v.then(() => __reached.push("resolved"), () => {}); } catch { /* spent, or not callable so */ }
            }
        }
        return 1;
    };`;

test("a page function the exec calls cannot run code of its own beside the collector, state and ml, through .caller or a stack frame's getFunction()", T, async () => {
    for (const js of [
        "globalThis.__runs = (globalThis.__runs || 0) + 1; console.log('own'); reach()",                       // the eval fast path
        "globalThis.__runs = (globalThis.__runs || 0) + 1; console.log('own'); await 0; return reach()",        // the async path
    ]) {
        const p = page();
        p.pageRun(REACH);
        const r = await p.exec(js);
        await sleep(20);
        assert.match(r.content, /own/, `positive control: ${r.content}`);
        assert.doesNotMatch(r.content, /FORGED BY THE PAGE/, `the page wrote into the result through a reachable wrapper: ${r.content}`);
        assert.equal(p.pageRun("globalThis.__runs"), 1, `the page ran the approved script again: ${js}`);
        const state = await p.exec("state.planted ?? 'none'");
        assert.match(state.content, /none/, `the page planted state through a reachable wrapper: ${state.content}`);
        assert.ok(!plain(p.pageRun("__reached")).includes("resolved"), `a reachable wrapper ran to completion for the page: ${JSON.stringify(plain(p.pageRun("__reached")))}`);
    }
});

test("a page function a strict-page exec calls cannot run the approved script again through a stack frame's getFunction()", T, async () => {
    const p = cdpPage();
    p.run(REACH.replace("globalThis.__reached", "globalThis.__reached"));
    const live = [];
    const r = await cdpEval(7, "doc-7", "globalThis.__runs = (globalThis.__runs || 0) + 1; console.log('own'); return reach()", (t) => live.push(t));
    await sleep(20);
    assert.ok("ok" in r, JSON.stringify(r));
    assert.deepEqual(r.logs, ["own"], "the page wrote into the collected lines");
    assert.equal(p.run("globalThis.__runs"), 1, "the page ran the approved script again");
    assert.ok(live.every((l) => !/FORGED/.test(l)), JSON.stringify(live));
});

test("a method the page put on its console runs with the page's console as `this`, never the collector", T, async () => {
    const p = page();
    p.pageRun("console.table = function () { if (this && typeof this.log === 'function') this.log('FORGED VIA THIS'); }; console.dir = function () { return this === console; };");
    const r = await p.exec("console.table([1]); console.log('own'); console.dir({})");
    assert.match(r.content, /own/, "positive control");
    assert.doesNotMatch(r.content, /FORGED VIA THIS/, r.content);
    assert.match(r.content, /value: true/, "a forwarded method was not called on the page's console");
    const c = cdpPage();
    c.run("console.table = function () { if (this && typeof this.log === 'function') this.log('FORGED VIA THIS'); };");
    const s = await cdpEval(7, "doc-7", "console.table([1]); console.log('own'); return 1");
    assert.deepEqual(s.logs, ["own"], JSON.stringify(s));
});

test("a page that replaces ml.dereference is never handed the exec's collector through its options", T, async () => {
    const p = page();
    p.pageRun("globalThis.__opts = []; window.ml.dereference = function (ref, o) { __opts.push(o === undefined ? 'none' : Object.getOwnPropertySymbols(Object(o)).length); return Promise.resolve('PAGE VALUE'); };");
    const r = await p.exec("const id = '@tool:' + 'abc1234'; try { await ml.dereference(id); } catch (e) {} try { await ml.dereference(id, { pipe: 'head 1' }); } catch (e) {} return 1");
    assert.match(r.content, /1/, `positive control: ${r.content}`);
    assert.deepEqual(plain(p.pageRun("__opts")), [], "the page's dereference was called from the exec's own ml");
});

test("a script that declares its own `const console` runs on the async path as it did before the parameter", T, async () => {
    const r = await page().exec("const console = { log() {} }; await 0; return 5");
    assert.match(r.content, /^page-writable \(ran in page world\):\n5$/, r.content);
    assert.doesNotMatch(r.content, /already been declared/, r.content);
    const c = cdpPage();
    const s = await cdpEval(7, "doc-7", "const console = { log() {} }; await 0; return 5");
    assert.equal(s.value, "5", JSON.stringify(s));
});

test("the closed-root reader is handed out once: a page that asks after injected.js started gets nothing, and a page that asked first leaves the tools without one (fails closed)", T, () => {
    const late = sealedPage();
    const asked = late.pageRun(`(() => { const d = {}; window.dispatchEvent(new CustomEvent("wml-closed-roots", { detail: d })); return typeof d.read; })()`);
    assert.equal(asked, "undefined", "a page asking after injected.js started received the reader");
    late.pierce(true);
    assert.match(late.desc("sealed-widget >>> button.secret"), /real/, "positive control: the tools hold the reader");
    // A page script that runs before injected.js (it loads at document_idle) and asks first.
    const w = loadDomWorld("<sealed-widget></sealed-widget>", { beforeInjected: `globalThis.__first = (() => { const d = {}; window.dispatchEvent(new CustomEvent("wml-closed-roots", { detail: d })); return typeof d.read; })();` });
    w.document.querySelector("sealed-widget").attachShadow({ mode: "closed" }).innerHTML = '<button class="secret">real</button>';
    w.ml._adoptRun("pierce", { toolNames: [], pierceClosed: true, builtBy: "worker" });
    assert.equal(vm.runInContext("__first", w.context), "function", "positive control: the page asked first and got the reader");
    const d = String(w.ml.domTools.find((t) => t.name === "describeElement").run({ selector: "sealed-widget >>> button.secret" }).content);
    assert.doesNotMatch(d, /real/, `the tools pierced with a reader the page asked for first: ${d}`);
});

test("a page that answers the closed-root ask itself after document.open() removed the patch's listener feeds the tools its own reader", { ...T, todo: "Inherent in the main world: before injected.js starts the page can remove shadow-patch's listener (document.open()) or wrap dispatchEvent/CustomEvent and answer the ask itself; the tools cannot tell its reader from the patch's. The page decides what the tools see in its own document anyway (el.shadowRoot, querySelector), detection-surface.md row 4." }, () => {
    const w = loadDomWorld("<sealed-widget></sealed-widget><other-widget></other-widget>", { beforeInjected: `
        const decoyHost = document.createElement("div"); const decoy = decoyHost.attachShadow({ mode: "open" });
        decoy.innerHTML = '<button class="secret">DECOY</button>';
        const d = window.dispatchEvent;
        window.dispatchEvent = function (e) { if (e.type === "wml-closed-roots" && e.detail) { e.detail.read = (el) => (el.tagName === "OTHER-WIDGET" ? decoy : null); return true; } return d.call(this, e); };` });
    w.ml._adoptRun("pierce", { toolNames: [], pierceClosed: true, builtBy: "worker" });
    const d = String(w.ml.domTools.find((t) => t.name === "describeElement").run({ selector: "other-widget >>> button.secret" }).content);
    assert.doesNotMatch(d, /DECOY/, d);
});

test("a page that defines an accessor under the binding's name beforehand gets none of a strict-page exec's stream", T, async () => {
    const p = cdpPage();
    p.run(`globalThis.__stolen = []; Object.defineProperty(globalThis, "__mlCdpStream", { configurable: false, set(v) { __stolen.push("binding"); }, get() { return (x) => __stolen.push(String(x)); } });`);
    const live = [];
    const r = await cdpEval(7, "doc-7", "console.log('own'); return 1", (t) => live.push(t));
    assert.ok("ok" in r, JSON.stringify(r));
    assert.deepEqual(live, ["own\n"], "positive control: the line streamed through the exec's own binding");
    assert.deepEqual(plain(p.run("__stolen")), [], "the page's accessor took the binding or a line");
});
