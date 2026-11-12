// cdp-collector-realm.test.mjs — a STRICT-PAGE main-world exec's collector (src/sw/sw-cdp.ts `cdpEval`) runs in the
// page's realm, so every builtin it might call is the page's. These rows replace each builtin the collector used to call
// before the exec runs, and assert the lines the model reads are still the exec's own; and they pin that genuine output
// is unchanged, and where the page-writable boundary now sits.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const T = { timeout: 15000 };

/** A chrome.debugger whose page is a vm context (the main world, context 1): Runtime.evaluate runs the expression
 *  there, and the result is serialised by value as CDP's returnByValue does. `pageConsole` collects what reaches
 *  the page's own console. */
function cdpPage() {
    const pageConsole = [];
    const listeners = new Set();
    const sink = (k) => (...a) => pageConsole.push([k, ...a]);
    const names = ["log", "info", "warn", "error", "debug", "table", "dir", "group", "groupEnd", "count", "time", "timeEnd"];
    const ctx = vm.createContext({ console: Object.fromEntries(names.map((k) => [k, sink(k)])), setTimeout, Date });
    globalThis.chrome = {
        permissions: { contains: async () => true },
        webNavigation: { getFrame: async () => ({ documentId: "doc-7", frameId: 0 }) },
        debugger: {
            attach: async () => {}, detach: async () => {},
            onDetach: { addListener: () => {} },
            onEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
            sendCommand: async (_t, method, params = {}) => {
                if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
                if (method === "Runtime.enable") { [...listeners].forEach((fn) => fn({ tabId: 7 }, "Runtime.executionContextCreated", { context: { id: 1, auxData: { isDefault: true, frameId: "F1" } } })); return {}; }
                if (method !== "Runtime.evaluate") return {};
                try {
                    const v = await vm.runInContext(params.expression, ctx);
                    return { result: { value: v === undefined ? undefined : JSON.parse(JSON.stringify(v)) } };
                } catch (e) {
                    return { exceptionDetails: { text: "Uncaught", executionContextId: 1, exception: { description: String(e?.stack ?? e) } } };
                }
            },
        },
    };
    return { pageConsole, run: (src) => vm.runInContext(src, ctx) };
}
const { cdpEval, releaseDebugger } = await import("../src/sw/sw-cdp.ts");
after(() => releaseDebugger(7));

// --- the page's builtins cannot add, drop or rewrite a line ---

/** Each replaces one builtin the collector called before this fix, so it adds "FORGED" beside or instead of a line; the
 *  first five do so on the old collector. `JSON.stringify` and `String` pin that a string argument never reaches them. */
const POISONS = {
    "Array.prototype.push": `const p = Array.prototype.push; Array.prototype.push = function (...a) { p.call(this, "FORGED"); return p.apply(this, a); };`,
    "Array.prototype.map": `const m = Array.prototype.map; Array.prototype.map = function (...a) { return ["FORGED"]; };`,
    "Array.prototype.join": `Array.prototype.join = function () { return "FORGED"; };`,
    "an index setter on Array.prototype": `for (const i of [0, 1, 2]) Object.defineProperty(Array.prototype, i, { configurable: true, set(v) { Object.defineProperty(this, i, { value: "FORGED", writable: true, enumerable: true, configurable: true }); } });`,
    "Object.defineProperty": `const d = Object.defineProperty; Object.defineProperty = function (o, k, desc) { if (desc && typeof desc.value === "function") { const f = desc.value; desc = { ...desc, value: (...a) => { f("FORGED"); return f(...a); } }; } return d(o, k, desc); };`,
    "JSON.stringify": `const s = JSON.stringify; JSON.stringify = function (v, ...r) { return typeof v === "string" ? "FORGED" : s(v, ...r); };`,
    "String": `globalThis.String = function () { return "FORGED"; };`,
};

for (const [name, poison] of Object.entries(POISONS)) {
    test(`a page that replaces ${name} before the exec puts no line of its own into the result`, T, async () => {
        const page = cdpPage();
        page.run(`(() => { ${poison} })()`);
        const r = await cdpEval(7, "doc-7", "console.log('own'); console.warn('two', 'parts'); return 1", () => {});
        assert.ok("ok" in r, JSON.stringify(r));
        assert.deepEqual(r.logs, ["own", "two parts"], `the exec's own lines, no more: ${JSON.stringify(r.logs)}`);
        assert.doesNotMatch(r.text, /FORGED/, r.text);
    });
}

// --- genuine output is what it was ---

test("genuine output reads as before: each argument's text joined by one space, one line per call, the heading on top", T, async () => {
    cdpPage();
    const src = `console.log('a', 1, true, null, { k: [1, 'x'] }); console.info(undefined, () => 0, Symbol('s')); console.error(10n); console.debug(); console.log('last'); return { ok: 1 }`;
    const r = await cdpEval(7, "doc-7", src, () => {});
    assert.ok("ok" in r, JSON.stringify(r));
    // The old collector: a.map(x => typeof x === 'string' ? x : JSON.stringify(x), String on a throw).join(' ').
    const expected = ['a 1 true null {"k":[1,"x"]}', "  ", "10", "", "last"];
    assert.deepEqual(r.logs, expected);
    assert.equal(r.value, '{"ok":1}');
    assert.equal(r.text, `page-writable (ran in page world):\nconsole:\n${expected.join("\n")}\n\nvalue: {"ok":1}`);
});

test("past the output ceiling a line is counted, not kept, as before", T, async () => {
    cdpPage();
    const r = await cdpEval(7, "doc-7", "const s = 'x'.repeat(1000000); for (let i = 0; i < 40; i++) console.log(s); return 0", () => {});
    assert.ok("ok" in r, JSON.stringify(r));
    assert.ok(r.dropped > 0, `some output dropped: ${r.dropped}`);
    assert.equal(r.logs.length, 31, "whole lines kept until the next would pass 32 MB (each is 1 MB and a newline)");
    assert.ok(r.logs.every((l) => l.length === 1000000));
    assert.equal(r.dropped, 9 * 1000001, "every later line counted with its separator");
});

test("the forwarding methods still reach the page's own console, and collect nothing", T, async () => {
    const page = cdpPage();
    const r = await cdpEval(7, "doc-7", "console.table([1]); console.count('c'); console.log('kept'); return 1", () => {});
    assert.ok("ok" in r, JSON.stringify(r));
    assert.deepEqual(r.logs, ["kept"]);
    assert.deepEqual(page.pageConsole.map((c) => c[0]), ["table", "count"]);
});

// --- what stays page-writable ---

test("RESIDUAL: a NON-string argument's text is still the page's JSON.stringify, which is why the heading stays", T, async () => {
    const page = cdpPage();
    page.run(`(() => { const s = JSON.stringify; JSON.stringify = function (v, ...r) { return typeof v === "object" && v && v.k === 1 ? "PAGE TEXT" : s(v, ...r); }; })()`);
    const r = await cdpEval(7, "doc-7", "console.log('n', { k: 1 }); return 1", () => {});
    assert.ok("ok" in r, JSON.stringify(r));
    assert.deepEqual(r.logs, ["n PAGE TEXT"], "the line is still the exec's one line; its object's text is the page's");
    assert.match(r.text, /^page-writable \(ran in page world\):\n/);
});
