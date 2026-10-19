// python-run-namespace-py.test.mjs — ROOT C's per-run dict against REAL CPython: who can see whose.
//
// tests/python-run-namespace.test.mjs routes the messages through a fake Worker and never opens a
// Python dict. This file is the real-interpreter half its header names: the worker's `runs` Map
// rebuilt against Pyodide, so what a cell of one run can reach in another's is measured, not assumed.
// Opt-in: needs dist/pyodide/ (npm run fetch-pyodide); self-SKIPS when absent.
// Written by the LANE 3 Mimo session (PR #757's review); the gc test is turned into the residual's pin.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, releaseNamespace } from "../src/python/python-runtime.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let py = null;
before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    await py.loadPackage(["numpy", "pillow", "pandas"]);
}, { timeout: 180000 });

// --- the worker's runs Map, rebuilt against the real interpreter ---
// Exactly python-worker.ts `runNamespace` / `deleteRunNamespace`: one `dict()` per run id, each cell
// run with that dict as its globals, the shipped `releaseNamespace` + `runs.delete` to close a run.

const runs = new Map();
function runNamespace(runId) {
    let entry = runs.get(runId);
    if (!entry) {
        entry = { ns: py.globals.get("dict")() };
        runs.set(runId, entry);
    }
    return entry;
}
function deleteRunNamespace(runId) {
    const entry = runs.get(runId);
    if (!entry) return;
    releaseNamespace(entry.ns);
    runs.delete(runId);
}
/** One cell of a kept run: the worker's `wrapUserCode(code, hardened, "run")` with the run's dict as globals. */
async function cell(runId, code) {
    const ns = runNamespace(runId).ns;
    await py.runPythonAsync(wrapUserCode(code, false, "run"), { globals: ns });
    const err = ns.get("_err");
    if (err) return { ok: false, error: String(err) };
    const jr = ns.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    return { ok: true, value };
}
const FIND_A = `
import gc
return [d.get('secret') for d in gc.get_objects()
        if isinstance(d, dict) and d.get('secret') == 'from-run-A']
`;

// --- cells of one run share a dict; a different run does not ---

test("a name from cell 1 of a run is readable in cell 2 of the SAME run, and not from another run", { skip }, async () => {
    assert.equal((await cell("run-a", "x = 41")).ok, true);
    assert.deepEqual(await cell("run-a", "return x + 1"), { ok: true, value: 42 });
    const other = await cell("run-b", "return x");
    assert.equal(other.ok, false, "run b must not read run a's x");
    assert.match(String(other.error), /name 'x' is not defined/);
});

// --- THE KNOWN RESIDUAL: two full-mode runs alive at once share one interpreter ---
// Every full-mode cell runs on the one `full` worker, so while run A's dict is alive, run B's cell walks to it
// through gc.get_objects(). The routing fix removes A's dict when A ENDS, nothing earlier
// (docs/plan/repl/LANE_1_RESULT_C.md). This asserts the residual EXISTS, so closing it (a worker per full-mode run,
// or full-mode runs serialized) flips this test instead of going unnoticed. A readonly worker refuses `import gc`.

test("RESIDUAL (exists today): a LIVE run's dict is reachable from another run's cell in the same interpreter", { skip }, async () => {
    assert.equal((await cell("run-live-a", "secret = 'from-run-A'")).ok, true);
    const r = await cell("run-live-b", FIND_A);
    assert.deepEqual(r.value, ["from-run-A"], "closed? then flip this to [] and update LANE_1_RESULT_C.md and the full-mode card");
    deleteRunNamespace("run-live-a");
});

// --- and the delete that DOES land closes the hole (positive control) ---

test("once the dict is deleted, gc.get_objects() no longer finds it", { skip }, async () => {
    assert.equal((await cell("run-del-a", "secret = 'from-run-A'")).ok, true);
    deleteRunNamespace("run-del-a");
    const r = await cell("run-del-b", FIND_A);
    assert.deepEqual(r.value, []);
});

// --- releasing a dict EMPTIES it: a cell's function must not keep it reachable ---
// `destroy()` alone left the dict alive: a function the cell defined holds it through `__globals__`, so the delete
// path was dead code against gc.get_objects() until it cleared the dict first. Fails if `releaseNamespace` stops
// clearing.

test("a released dict whose cell defined a function is not reachable through gc.get_objects()", { skip }, async () => {
    const ns = py.globals.get("dict")();
    await py.runPythonAsync(wrapUserCode("marker = 'release-marker'\ndef keep():\n    return marker", false, "run"), { globals: ns });
    assert.equal(ns.get("_err"), undefined, "the cell ran");
    releaseNamespace(ns);
    const r = await cell("run-release-probe", `
import gc
return len([d for d in gc.get_objects() if isinstance(d, dict) and d.get('marker') == 'release-marker'])
`);
    assert.deepEqual(r, { ok: true, value: 0 });
});
