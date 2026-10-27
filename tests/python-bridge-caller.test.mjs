// python-bridge-caller.test.mjs — runPython (sw-python.ts) puts `bridges` on a PY_RUN only for the exact approved code of a
// cell outside the dialect, and only because its CALLER said so, never because a payload did.
//
// The real sw-python.ts under a mocked `chrome`: the PY_RUN it sends the offscreen document is what is read. The links
// around it: who sets `caller.bridges` (a person's card answer, dialect-inside-host.test.mjs), what the offscreen document
// forwards (python-run-namespace.test.mjs), what the worker does with it (python-worker-bridges.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

const sent = [];
globalThis.chrome = {
    runtime: { id: "test", sendMessage: async (m) => { sent.push(m); return { ok: true, stdout: "" }; }, onMessage: { addListener() {} }, getURL: (p) => p },
    offscreen: { hasDocument: async () => true },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} }, sync: { get: async () => ({}) }, onChanged: { addListener() {} } },
    tabs: {},
};
const { runPython } = await import("../src/sw/sw-python.ts");
const { setPythonDialectForTest } = await import("../src/agent/python-dialect.ts");

const CODE = "import js\nprint(js.setTimeout)";
/** A worker-hosted run's caller, as worker-tools.ts builds it, with `extra` laid over it. */
const caller = (extra = {}) => ({ ownSurface: false, untrusted: async () => true, disclose: false, tabUrl: () => "", runGated: true, wireRun: "run-1", pyCodeOk: (c) => c === CODE, ...extra });
/** Run one cell and return the PY_RUN the offscreen document was sent. */
async function pyRun(payload, c) {
    const before = sent.length;
    const r = await runPython(payload, "req", c);
    assert.equal(r.error, undefined, "the call was not refused");
    return sent.slice(before).find((m) => m.type === "PY_RUN");
}

// --- the lift rides only the approved code, outside the dialect, from a caller that was granted it ---

test("a granted caller's approved cell outside the dialect is sent with bridges: true", async () => {
    assert.equal((await pyRun({ code: CODE }, caller({ bridges: true })))?.bridges, true);
});

test("no bridges from the caller, no lift: a payload's own `bridges` is ignored", async () => {
    for (const c of [caller(), caller({ bridges: false })]) {
        const run = await pyRun({ code: CODE, bridges: true }, c);
        assert.ok(run, "positive control: the cell was sent");
        assert.equal("bridges" in run, false);
    }
});

test("a cell other than the approved one is not lifted, nor is any cell when the caller has no approved-code check", async () => {
    const other = await pyRun({ code: CODE + "\nprint('extra')" }, caller({ bridges: true, pyCodeOk: (c) => c === CODE, untrusted: async () => false }));
    assert.ok(other, "positive control: the (trusted-run) cell was sent");
    assert.equal("bridges" in other, false, "the grant was for other code");
    const unchecked = await pyRun({ code: CODE }, caller({ bridges: true, pyCodeOk: undefined, untrusted: async () => false }));
    assert.equal("bridges" in unchecked, false, "nothing says this is the code a person approved");
});

test("a cell inside the dialect is not lifted, even from a caller marked bridges", async () => {
    setPythonDialectForTest((c) => c === "return 1 + 1");   // the sandbox's membership verdict; the real one answers false until it has probed
    try {
        const run = await pyRun({ code: "return 1 + 1" }, caller({ bridges: true, pyCodeOk: () => true, untrusted: async () => false }));
        assert.ok(run, "positive control: the cell was sent");
        assert.equal("bridges" in run, false, "inside the dialect there is no refusal to lift");
        const inside = await pyRun({ code: CODE }, caller({ bridges: true, inside: true, pyCodeOk: () => true }));
        assert.equal("bridges" in inside, false, "an inside run needs none");
    } finally { setPythonDialectForTest(null); }
});

// --- the run remembers a lifted cell, so later cells' cards say what it kept --------------------------------------------

test("runPythonBridged: set by a grant with bridges and outside code, never by one without, and kept after the call ends", async () => {
    const { ensureRunState, grantRunPython, runPythonBridged } = await import("../src/sw/worker-tools.ts");
    ensureRunState("bridged-1", 1, () => "");
    assert.equal(runPythonBridged("bridged-1"), false, "a fresh run");
    grantRunPython("bridged-1", { sheets: [], code: null, bridges: true });
    assert.equal(runPythonBridged("bridged-1"), false, "a grant with no outside code lifts nothing");
    grantRunPython("bridged-1", { sheets: [], code: "x = 1" });
    assert.equal(runPythonBridged("bridged-1"), false, "an outside cell without the lift");
    grantRunPython("bridged-1", { sheets: [], code: CODE, bridges: true });
    grantRunPython("bridged-1", null);
    assert.equal(runPythonBridged("bridged-1"), true, "the lifted cell ended; what it took may still be in the namespace");
    assert.equal(runPythonBridged("no-such-run"), false);
});

