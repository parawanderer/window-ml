"use strict";
// LIVE console streaming from a STRICT-CSP page's exec (the CDP path). Runtime.evaluate returns once, so the
// lines have to leave the page mid-eval — via Runtime.addBinding, because our wrapper replaces console.* and
// therefore never raises Runtime.consoleAPICalled. Exercises sw-cdp.ts directly against a mocked chrome.debugger.
import { test } from "node:test";
import assert from "node:assert";

/** A chrome.debugger mock. `onEval(fireEvent)` runs while Runtime.evaluate is "in flight", so a test can emit
 *  bindingCalled events at the moment the page would have logged them. */
function mockChrome({ onEval, permission = true } = {}) {
    const calls = [];
    const listeners = new Set();
    const fire = (method, params, tabId = 7) => [...listeners].forEach(fn => fn({ tabId }, method, params));
    globalThis.chrome = {
        permissions: { contains: async () => permission },
        debugger: {
            attach: async () => { calls.push(["attach"]); },
            detach: async () => { calls.push(["detach"]); },
            onDetach: { addListener: () => {} },
            onEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
            sendCommand: async (target, method, params) => {
                calls.push([method, params]);
                if (method !== "Runtime.evaluate") return undefined;
                const logs = onEval ? (onEval(fire, params.expression) || []) : [];
                return { result: { value: { __mlWrapped: true, v: "42", logs } } };
            },
        },
    };
    return { calls, listeners, fire };
}
const line = (text, ts) => JSON.stringify({ text, ts });

test("CDP exec streams each console line live, via a Runtime binding", async () => {
    const seen = [];
    const { calls, listeners } = mockChrome({
        onEval: (fire) => {
            // The page logs twice while the eval is still running — each raises bindingCalled on our client.
            fire("Runtime.bindingCalled", { name: "__mlCdpStream", payload: line("alpha\n", 1000) });
            fire("Runtime.bindingCalled", { name: "__mlCdpStream", payload: line("beta\n", 1200) });
            return ["alpha", "beta"];
        },
    });
    const { cdpEval } = await import("../sw-cdp.ts");
    const r = await cdpEval(7, "console.log('alpha')", (text, ts) => seen.push([text, ts]));

    assert.deepEqual(seen, [["alpha\n", 1000], ["beta\n", 1200]], "both lines arrived live, with the PAGE's stamps");
    const methods = calls.map(c => c[0]);
    assert.ok(methods.includes("Runtime.enable"), "the Runtime domain is enabled (bindingCalled needs it)");
    assert.ok(methods.includes("Runtime.addBinding"), "the page → client binding is installed");
    // The wrapper must tee through the binding IN ADDITION to collecting, so the model still gets everything.
    const expr = calls.find(c => c[0] === "Runtime.evaluate")[1].expression;
    assert.match(expr, /__mlCdpStream\(JSON\.stringify/, "the patched console calls the binding");
    assert.match(expr, /__logs\.push\(__s\)/, "…and still collects the line for the model-facing result");
    assert.match(expr, /ts: Date\.now\(\)/, "the PAGE stamps each line (it is the executor), not the SW");

    assert.ok("ok" in r, "the exec still succeeded");
    assert.deepEqual(r.logs, ["alpha", "beta"], "the structured console comes back for the Out render");
    assert.equal(r.value, "42");
    assert.match(r.text, /console:\nalpha\nbeta\n\nvalue: 42/, "the model-facing string is unchanged");
    // Teardown: the binding is dropped and we stop listening, so a later page call can't reach a dead sink.
    assert.ok(methods.includes("Runtime.removeBinding"), "the binding is removed when the exec ends");
    assert.equal(listeners.size, 0, "the event listener is removed");
});

test("CDP exec without streaming installs no binding (and the wrapper carries no tee)", async () => {
    const { calls, listeners } = mockChrome({ onEval: () => ["only"] });
    const { cdpEval } = await import("../sw-cdp.ts");
    const r = await cdpEval(7, "console.log('only')");

    const methods = calls.map(c => c[0]);
    assert.ok(!methods.includes("Runtime.addBinding"), "a non-streaming run touches no binding");
    assert.ok(!methods.includes("Runtime.enable"), "…and doesn't enable the Runtime domain either");
    assert.equal(listeners.size, 0);
    const expr = calls.find(c => c[0] === "Runtime.evaluate")[1].expression;
    assert.ok(!/__mlCdpStream/.test(expr), "no dead binding call is compiled into the page wrapper");
    assert.deepEqual(r.logs, ["only"], "the full output still lands at DONE — the documented degrade");
});

test("CDP exec survives a binding that won't install (streaming is a nicety, never a failure)", async () => {
    const seen = [];
    const { calls } = mockChrome({ onEval: () => ["kept"] });
    const realSend = globalThis.chrome.debugger.sendCommand;
    globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
        if (method === "Runtime.addBinding") throw new Error("no binding for you");
        return realSend(target, method, params);
    };
    const { cdpEval } = await import("../sw-cdp.ts");
    const r = await cdpEval(7, "console.log('kept')", (t) => seen.push(t));

    assert.ok("ok" in r, "the exec ran anyway");
    assert.deepEqual(r.logs, ["kept"], "output still captured for the model");
    assert.deepEqual(seen, [], "nothing streamed — it degraded to the old behaviour");
    const expr = calls.find(c => c[0] === "Runtime.evaluate")[1].expression;
    assert.ok(!/__mlCdpStream/.test(expr), "the wrapper doesn't call a binding that failed to install");
});

test("bindingCalled from ANOTHER tab or another binding is ignored", async () => {
    const seen = [];
    mockChrome({
        onEval: (fire) => {
            fire("Runtime.bindingCalled", { name: "__mlCdpStream", payload: line("mine\n", 5) }, 7);
            fire("Runtime.bindingCalled", { name: "__mlCdpStream", payload: line("other tab\n", 6) }, 99);
            fire("Runtime.bindingCalled", { name: "somethingElse", payload: line("not ours\n", 7) }, 7);
            fire("Runtime.consoleAPICalled", { args: [{ value: "wrong event" }] }, 7);
            fire("Runtime.bindingCalled", { name: "__mlCdpStream", payload: "{not json" }, 7);
            return ["mine"];
        },
    });
    const { cdpEval } = await import("../sw-cdp.ts");
    await cdpEval(7, "console.log('mine')", (text, ts) => seen.push([text, ts]));
    assert.deepEqual(seen, [["mine\n", 5]], "only this tab's own binding, and a malformed payload is dropped");
});
