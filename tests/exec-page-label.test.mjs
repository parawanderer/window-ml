// exec-page-label.test.mjs — the heading that marks a main-world exec's whole result as page-writable (PAGE_WORLD_HEAD,
// output-clip.ts): on the main-world path and the CDP strict-page path, with and without console output, on an error,
// and absent from a read-only survey. The isolated-world absence is in isolated-exec.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadDomWorld } = require("./helpers");
const { PAGE_WORLD_HEAD, pageWorldResult } = await import("../src/agent/output-clip.ts");
const { formatReadonlyExec } = await import("../src/agent/approval.ts");
const { toolFailed } = await import("../src/sidebar/format.ts");

const T = { timeout: 15000 };
const mainExec = (js) => {
    const w = loadDomWorld("<button>b</button>");
    return w.ml.domTools.find((t) => t.name === "exec").run({ js }, {});
};

// --- the heading itself ---

test("the heading is one line, short, with no run of two spaces", () => {
    assert.ok(!PAGE_WORLD_HEAD.includes("\n"));
    assert.doesNotMatch(PAGE_WORLD_HEAD, /  /);
    assert.ok(PAGE_WORLD_HEAD.length <= 40, PAGE_WORLD_HEAD);
    assert.doesNotMatch(pageWorldResult("console:\nx\n\nvalue: 1"), /  /);
    assert.equal(pageWorldResult("1").split("\n")[0], PAGE_WORLD_HEAD);
});

// --- main world ---

test("a main-world result leads with the heading, with and without console output", T, async () => {
    const withLog = await mainExec("console.log('a'); 1");
    assert.equal(withLog.content, `${PAGE_WORLD_HEAD}\nconsole:\na\n\nvalue: 1`);
    const quiet = await mainExec("2");
    assert.equal(quiet.content, `${PAGE_WORLD_HEAD}\n2`);
});

test("a main-world error and an element result are labelled too, and the sidebar still reads the error as a failure", T, async () => {
    const err = await mainExec("throw new Error('page shaped')");
    assert.match(err.content, new RegExp(`^${PAGE_WORLD_HEAD.replace(/[()]/g, "\\$&")}\\nError: page shaped`));
    assert.ok(toolFailed(err.content), "toolFailed skips the heading line");
    assert.ok(toolFailed("Error: x") && toolFailed("Denied") && !toolFailed(`${PAGE_WORLD_HEAD}\n1`));
    const el = await mainExec("document.querySelector('button')");
    assert.equal(el.content.split("\n")[0], PAGE_WORLD_HEAD);
});

test("the heading adds one line to the model's string and none to the panel's render, so line numbers there do not move", T, async () => {
    const r = await mainExec("console.log('a'); throw new Error('boom')");
    assert.equal(JSON.stringify(r.render).includes("page-writable"), false, "the Out cell carries no heading");
    assert.match(r.render.error, /boom \(line 1\)/, "the error line is the script's own line");
});

// --- read-only survey ---

test("a read-only survey carries no heading", () => {
    assert.doesNotMatch(formatReadonlyExec(1, ["a"]).result, /page-writable/);
    assert.equal(formatReadonlyExec(1, ["a"]).result, "console:\na\n\nvalue: 1");
    assert.equal(formatReadonlyExec(2, []).result, "2");
});

// --- CDP strict-page path ---

function cdpChrome(logs) {
    const listeners = new Set();
    globalThis.chrome = {
        permissions: { contains: async () => true },
        webNavigation: { getFrame: async () => ({ documentId: "doc-7", frameId: 0 }) },
        debugger: {
            attach: async () => {}, detach: async () => {}, onDetach: { addListener: () => {} },
            onEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
            sendCommand: async (_t, method, params) => {
                if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
                // The top frame F1's main world is context 1, reported as Runtime is enabled, as Chrome does.
                if (method === "Runtime.enable") { [...listeners].forEach((fn) => fn({ tabId: 7 }, "Runtime.executionContextCreated", { context: { id: 1, auxData: { isDefault: true, frameId: "F1" } } })); return undefined; }
                if (method !== "Runtime.evaluate") return undefined;
                return { result: { value: logs.threw ? { __mlWrapped: true, threw: logs.threw, logs: [] } : { __mlWrapped: true, v: "42", logs: logs.lines } } };
            },
        },
    };
}

test("a CDP exec's text leads with the heading, with and without console output, and its thrown error is marked page-shaped", T, async () => {
    const { cdpEval } = await import("../src/sw/sw-cdp.ts");
    cdpChrome({ lines: ["alpha"] });
    assert.equal((await cdpEval(7, "doc-7", "1")).text, `${PAGE_WORLD_HEAD}\nconsole:\nalpha\n\nvalue: 42`);
    cdpChrome({ lines: [] });
    assert.equal((await cdpEval(7, "doc-7", "1")).text, `${PAGE_WORLD_HEAD}\n42`);
    cdpChrome({ threw: "Error: from the page" });
    const bad = await cdpEval(7, "doc-7", "1");
    assert.equal(bad.pageShaped, true);
    assert.match(bad.error, /from the page/);
});
