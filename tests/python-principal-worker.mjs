// python-principal-worker.mjs — one principal's interpreter in its OWN realm: the test's stand-in for the readonly worker's "one Worker per principal".
// A second Pyodide cannot boot in a realm `lockdown()` has frozen (its boot attaches `.sig` properties to the now-frozen
// `Math` intrinsics — measured: `Cannot add property sig, object is not extensible`), which is exactly why the real
// split is per-realm. This is that split, small: load Pyodide, `lockdownReadonly`, then run each cell it is sent.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import path from "node:path";

const { pyodideDir, lockdownUrl, runtimeUrl, packages } = workerData;
const { loadPyodide } = await import(pathToFileURL(path.join(pyodideDir, "pyodide.mjs")).href);
const py = await loadPyodide({ indexURL: pyodideDir });
// Swallow the runtime's own prints from the start: a worker thread has no fd 1 for Pyodide's default
// writer, and every package-load print threw `ERR_INVALID_ARG_TYPE`.
py.setStdout({ batched: () => {} });
py.setStderr({ batched: () => {} });
// The prelude imports numpy/PIL/pandas (and pandas pulls pyarrow): the packages the cell's wrapper needs.
if (Array.isArray(packages) && packages.length) await py.loadPackage(packages);
const { lockdownReadonly } = await import(lockdownUrl);
const held = await lockdownReadonly(py, {});
const harness = held.harness;
const { wrapUserCode, injectInputs } = await import(runtimeUrl);

parentPort.on("message", async (msg) => {
    const { id, code, image, tablesJson } = msg;
    try {
        injectInputs(py.globals, image ?? null, tablesJson ?? null, harness);
        await py.runPythonAsync(wrapUserCode(code, true));
        const out = {
            stdout: String(py.globals.get("_stdout") ?? ""),
            error: py.globals.get("_err") ? String(py.globals.get("_err")) : null,
            value: null,
        };
        try { out.value = JSON.parse(py.globals.get("_json_result")); } catch { /* leave null */ }
        parentPort.postMessage({ id, out });
    } catch (e) {
        parentPort.postMessage({ id, out: { stdout: "", error: String((e && e.message) || e), value: null } });
    } finally {
        injectInputs(py.globals, null, null, harness);
    }
});
parentPort.postMessage({ ready: true });
