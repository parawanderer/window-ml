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
    const r = await cdpEval(7, "console.log('first'); await new Promise((res) => setTimeout(res, 40)); console.log('second'); return 1", (text) => live.push(text));
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
        const r = await cdpEval(7, src, () => {});
        assert.match(String(r.error ?? ""), what, `positive control: the exec failed as expected: ${JSON.stringify(r)}`);
        assert.ok(p.calls.some(([m, a]) => m === "Runtime.addBinding" && a.name === "__mlCdpStream"), "positive control: the binding was installed");
        assert.equal(p.run("'__mlCdpStream' in globalThis"), false, `the binding outlived ${JSON.stringify(src)}`);
    }
});

test("a tab that reports no main-world context for its top frame installs no binding: no stream rather than an unchecked one", T, async () => {
    const p = cdpPage({ contexts: [{ id: 3, auxData: { isDefault: true, frameId: "F2" } }, { id: 11, auxData: { isDefault: false, frameId: "F1" } }] });
    const live = [];
    const r = await cdpEval(7, "console.log('kept'); return 1", (t) => live.push(t));
    assert.deepEqual(r.logs, ["kept"], "positive control: the exec ran and collected");
    assert.ok(!p.calls.some(([m]) => m === "Runtime.addBinding"), "a binding was installed with no context to check its calls against");
    assert.deepEqual(live, []);
    assert.equal(p.run("'__mlCdpStream' in globalThis"), false);
});

// --- an approved exec runs once ---

// OPEN, and it predates the console change: tools.ts takes any SyntaxError from the eval fast path as a parse error and
// re-runs the source as an async body, so the side effects before the throw happen twice. An honest `JSON.parse` does
// it, and so can the page, by throwing a SyntaxError from a builtin it patched (a click). Fix: fall back only when
// nothing ran (a marker the evaluated source sets before its first statement, or a parse check before running it).
test("a main-world exec whose expression throws a SyntaxError while it RUNS is not run a second time", { ...T, todo: "OPEN, predates step 1, a follow-up: tools.ts falls back to the async body on ANY SyntaxError from the eval fast path, including one thrown while the code runs" }, async () => {
    const p = page();
    p.pageRun("globalThis.__n = 0");
    const r = await p.exec("(globalThis.__n++, JSON.parse('{'))");
    assert.match(r.content, /JSON/, `positive control: the error reached the model: ${r.content}`);
    assert.equal(p.pageRun("__n"), 1, "the approved script ran twice");
});

// OPEN, and it predates the console change: cdpEval re-runs the source as a body whenever the exception's description
// matches /SyntaxError/, which a runtime JSON.parse error does, and any page function the script calls can throw an error
// whose MESSAGE says it. The re-run's wrapper also finds __mlCdpStream already deleted by the first run's finally, so it
// streams nothing. Fix: catch inside the wrapper (as isolatedWrapper does, returning `threw`), so an exceptionDetails
// left over means the wrapper never parsed.
test("a strict-page exec that throws while it RUNS is not run a second time, whatever its error says", { ...T, todo: "OPEN, predates step 1, a follow-up: cdpEval re-runs as a body whenever an exception's description matches /SyntaxError/; the wrapper should catch and return `threw`, as isolatedWrapper does" }, async () => {
    for (const [setup, src] of [
        ["", "(globalThis.__n++, JSON.parse('{'))"],
        ["globalThis.pageFn = () => { throw new Error('not a SyntaxError at all'); }", "(globalThis.__n++, pageFn())"],
    ]) {
        const p = cdpPage();
        p.run(`globalThis.__n = 0; ${setup}`);
        const r = await cdpEval(7, src);
        assert.ok(r.error, `positive control: the exec failed: ${JSON.stringify(r)}`);
        assert.equal(p.run("__n"), 1, `the approved script ran twice: ${src}`);
    }
});

// --- open while the exec shares the page's world ---

const SHARED = "Inherent while the exec runs in the page's realm (docs/spec/SITE_PRESENCE.md, step 1): its collector, its result string and the envelope that carries them are built with builtins the page can rewrite and posted on the page's window (PAGE_TOOL_RESULT, which the page can also forge by callId until step 2's MessagePort), so closing one vector closes none. The model is told its console is page-writable (MAIN_CONSOLE_HEAD).";

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

test("the VALUE of a main-world exec is the script's own: a page cannot rewrite it while only the console section is marked page-writable", { ...T, todo: `${SHARED} The value is exactly as page-writable as the console (tools.ts serialises it with the page's JSON.stringify; the CDP wrapper too), yet MAIN_CONSOLE_HEAD marks only the console section, which tells the model the \`value:\` line is the script's.` }, async () => {
    const p = page();
    p.pageRun(`
        const s = JSON.stringify;
        JSON.stringify = function (v, ...rest) { return v && v.price === 10 ? '{"price":0}' : s.call(this, v, ...rest); };
    `);
    const r = await p.exec("console.log('own'); ({ price: 10 })");
    assert.match(r.content, /own/, "positive control");
    assert.match(r.content, /"price":10/, r.content);
});

test("a page reads neither a delegated exec's live stream nor its result off its own window", { ...T, todo: `${SHARED} The delegated path posts PAGE_TOOL_STREAM and PAGE_TOOL_RESULT through the page's window.postMessage (run-delegation.ts), which the page wraps; detection-surface.md row 6, step 2's MessagePort.` }, async () => {
    const p = page();
    p.ml._adoptRun("r-stream", { toolNames: ["exec"], builtBy: "worker" });
    p.pageRun(`
        globalThis.__heard = [];
        const post = window.postMessage.bind(window);
        window.postMessage = function (m, o) { if (m && /^PAGE_TOOL_(STREAM|RESULT)$/.test(m.type)) __heard.push(JSON.stringify(m)); return post(m, o); };
    `);
    const done = new Promise((res) => p.window.addEventListener("message", (e) => { if (e.data?.type === "PAGE_TOOL_RESULT") res(e.data); }));
    p.window.dispatchEvent(new p.window.MessageEvent("message", { source: p.window, data: { type: "PAGE_TOOL_RUN", callId: "c1", runId: "r-stream", name: "exec", args: { js: "console.log('the script prints this'); 1" }, stream: true } }));
    const res = await Promise.race([done, sleep(3000).then(() => null)]);
    assert.ok(res, "positive control: the delegated exec answered");
    assert.deepEqual(plain(p.pageRun("__heard")).filter((m) => m.includes("the script prints this")), [], "the page read the exec's output off its window");
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
