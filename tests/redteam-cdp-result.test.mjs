// redteam-cdp-result.test.mjs — the red-team pass on what a strict-CSP page's own scripts can put into a MAIN-world CDP
// exec's RESULT (src/sw/sw-cdp.ts `cdpEval`): the model's result, the panel's Out cell and both exports, which all read
// the `logs` the wrapper collected inside the page's realm, not the live stream.
//
// TWO SINKS, and the row below pins the stronger one. A call to the `__mlCdpStream` binding only reaches `onStream` —
// the person's live output and the session events that mirror it — never `r.logs`; redteam-isolated.test.mjs pins that
// half ("the page cannot write into a MAIN-world CDP exec's live output through __mlCdpStream"). What DOES reach the
// model's result is the wrapper's own collector, and it runs in the page's realm, beside the page's own code.
//
// The heading `page-writable (ran in page world):` was the whole of the mitigation while that collector called the
// page's builtins on the exec's line. It no longer calls one on a string line: the lines go into a null-prototype
// object by index with a counter (no `push`, no array whose prototype could hold an index setter), a line is joined by
// `+` (no `map`/`join`), and the collector is an object literal (no `Object.defineProperty`). The row below is live
// against that, so a change that makes the collector call one of the page's builtins on a string line again reds it. A
// NON-string argument's text still goes through the page's `JSON.stringify` (or `String`), which is why the heading
// stays; tests/cdp-collector-realm.test.mjs pins that residual.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const T = { timeout: 15000 };

/** A chrome.debugger whose page is a vm context (the main world, context 1): Runtime.evaluate really runs the
 *  expression there, and Runtime.addBinding puts a function on that context's global that raises bindingCalled from
 *  context 1, as Chrome does. Page code runs in the same context, which is the hole under test. */
function cdpPage() {
    const pageLines = [];
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
                if (method === "Runtime.addBinding") { ctx[params.name] = (p) => fire({ name: params.name, payload: String(p), executionContextId: 1 }); return {}; }
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
    return { ctx, pageLines, run: (src) => vm.runInContext(src, ctx) };
}
const { cdpEval, releaseDebugger } = await import("../src/sw/sw-cdp.ts");
after(() => releaseDebugger(7));

// --- the model's result: the wrapper's collector is the page's realm ---

test("the page cannot write into a STRICT-PAGE main-world exec's result by patching the builtins its collector calls", T, async () => {
    const clean = cdpPage();
    const before = await cdpEval(7, "doc-7", "console.log('own'); return 1", () => {});
    assert.ok("ok" in before, `positive control: the exec ran: ${JSON.stringify(before)}`);
    assert.deepEqual(before.logs, ["own"], "positive control: with no page tampering the result is the exec's own line");
    assert.match(before.text, /^page-writable \(ran in page world\):\nconsole:\nown\n\nvalue: 1/, before.text);

    // A page script, in the same world and before the exec: it patches the builtin an array collector would call for
    // the exec's own line. Nothing about it is async, so it is in place for the wrapper's very first line.
    clean.run(`
        globalThis.__ownPush = Array.prototype.push;
        Array.prototype.push = function (...a) {
            if (a.length && typeof a[0] === "string" && a[0] === "own") __ownPush.call(this, "FORGED BY THE PAGE");
            return __ownPush.apply(this, a);
        };
    `);
    const r = await cdpEval(7, "doc-7", "console.log('own'); return 1", () => {});
    assert.ok("ok" in r, `positive control: the exec ran: ${JSON.stringify(r)}`);
    assert.deepEqual(r.logs, ["own"], `a page line beside the exec's reached the result the model reads: ${JSON.stringify(r.logs)}`);
    assert.doesNotMatch(r.text, /FORGED BY THE PAGE/, r.text);
});
