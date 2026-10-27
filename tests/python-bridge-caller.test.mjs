// python-bridge-caller.test.mjs — runPython (sw-python.ts) puts `bridges` on a PY_RUN only for the exact approved code of a
// cell outside the dialect, and only because its CALLER said so, never because a payload did.
//
// The real sw-python.ts under a mocked `chrome`: the PY_RUN it sends the offscreen document is what is read. The links
// around it: who sets `caller.bridges` (a person's card answer, dialect-inside-host.test.mjs), what the offscreen document
// forwards (python-run-namespace.test.mjs), what the worker does with it (python-worker-bridges.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

const sent = [];
const session = {};   // chrome.storage.session, which outlives an evicted worker
globalThis.chrome = {
    runtime: { id: "test", sendMessage: async (m) => { sent.push(m); return { ok: true, stdout: "" }; }, onMessage: { addListener() {} }, getURL: (p) => p },
    offscreen: { hasDocument: async () => true },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in session).map((k) => [k, session[k]])), set: async (items) => { Object.assign(session, items); } }, sync: { get: async () => ({}) }, onChanged: { addListener() {} } },
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

// --- the run remembers a lifted cell, past an evicted worker, so later cells' cards say what it kept --------------------

test("pythonRunBridged: marked by a lifted cell, read back from storage.session by a worker that never saw it, dropped with the namespace", async () => {
    const { markPythonBridged, pythonRunBridged, deletePythonRun, evictBridgedCopyForTest } = await import("../src/sw/sw-python.ts");
    assert.equal(await pythonRunBridged("bridged-1"), false, "the default: a fresh run is unmarked");
    await markPythonBridged("bridged-1");
    assert.equal(await pythonRunBridged("bridged-1"), true);
    assert.deepEqual(session.ml_py_bridged, ["bridged-1"], "written to storage.session, which an eviction keeps");
    // The worker is evicted: its memory of the mark is gone, storage.session is not.
    evictBridgedCopyForTest();
    assert.equal(await pythonRunBridged("bridged-1"), true, "a restarted worker still sees the mark");
    assert.equal(await pythonRunBridged("bridged-2"), false, "another run is not marked");
    deletePythonRun("bridged-1");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(session.ml_py_bridged, [], "dropped with the run's namespace");
    evictBridgedCopyForTest();
    assert.equal(await pythonRunBridged("bridged-1"), false, "gone after the next eviction too");
});

test("pythonRunBridged: runs marked and forgotten in the same tick keep each other's edits in storage.session", async () => {
    const { markPythonBridged, pythonRunBridged, deletePythonRun, evictBridgedCopyForTest } = await import("../src/sw/sw-python.ts");
    await Promise.all([markPythonBridged("same-tick-1"), markPythonBridged("same-tick-2"), markPythonBridged("same-tick-3")]);
    assert.deepEqual([...session.ml_py_bridged].sort(), ["same-tick-1", "same-tick-2", "same-tick-3"], "no mark lost to another's write");
    deletePythonRun("same-tick-2");
    await markPythonBridged("same-tick-4");
    evictBridgedCopyForTest();
    assert.deepEqual(await Promise.all(["same-tick-1", "same-tick-2", "same-tick-3", "same-tick-4"].map(pythonRunBridged)), [true, false, true, true],
        "a forget racing a mark drops only its own run");
    for (const id of ["same-tick-1", "same-tick-3", "same-tick-4"]) deletePythonRun(id);
});
