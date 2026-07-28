// Offscreen document — hosts the Pyodide (CPython→WASM) runtime for the `python_exec`
// tool. It runs in an extension-origin page (whose CSP we set to allow 'wasm-unsafe-eval'),
// off the service worker (which can't run WASM). The background relays { code, image? }
// here; we execute it in a SANDBOXED Python namespace — no network, no filesystem, no DOM,
// only the optional injected image — and return the value + stdout. Pyodide and the
// numpy/Pillow wheels (bundled in dist/pyodide/) load lazily on the first call.

import { PY_PACKAGE_LOADS } from "./python-env";
import { wrapUserCode, harden, unharden } from "./python-runtime";

let pyodideReady: Promise<any> | null = null;
function getPyodide(): Promise<any> {
    if (!pyodideReady) pyodideReady = (async () => {
        // Dynamic import of the vendored ESM (runtime URL → esbuild leaves it external).
        const { loadPyodide } = await import(chrome.runtime.getURL("pyodide/pyodide.mjs"));
        const py = await loadPyodide({ indexURL: chrome.runtime.getURL("pyodide/") });
        await py.loadPackage(PY_PACKAGE_LOADS);
        return py;
    })();
    return pyodideReady;
}

// toJs can produce Maps / nested proxies; a JSON round-trip flattens to plain data (and
// drops anything non-serializable — which shouldn't cross the message bus anyway).
function sanitize(v: unknown): unknown {
    try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

// Sandbox hardening (readonly mode) lives in python-runtime.ts — chrome-free (globalThis + py),
// so it's escape-tested against real Pyodide in tests/python.test.js.

async function run(code: string, image: string | null, hardened: boolean, tables: unknown): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string }> {
    const py = await getPyodide();
    py.globals.set("INJECTED_IMAGE_B64", image);
    py.globals.set("INJECTED_TABLES_JSON", Array.isArray(tables) && tables.length ? JSON.stringify(tables) : null);
    const saved = hardened ? harden(py) : null;
    try {
        // RESET (per-run isolation) + PRELUDE (preloaded vars) + the user's code, wrapped to capture
        // stdout / a `return`-or-bare-`result=` value / a traceback → `python-runtime.ts` (shared so
        // the exact script is exercised against real CPython in tests). Reads back _stdout/_err/_json_result.
        await py.runPythonAsync(wrapUserCode(code));
        const stdout = String(py.globals.get("_stdout") ?? "");
        const err = py.globals.get("_err");
        if (err) return { ok: false, stdout, error: String(err) };
        const jsonResult = py.globals.get("_json_result");
        if (typeof jsonResult === "string") {
            let value: unknown; try { value = JSON.parse(jsonResult); } catch { value = jsonResult; }
            return { ok: true, value, stdout };
        }
        // Fallback for a non-JSON-serializable return (rare — models return images via
        // to_base64): convert via toJs, then destroy the proxy so it can't leak.
        const r = py.globals.get("result");
        const value = r && r.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r;
        if (r && r.destroy) r.destroy();
        return { ok: true, value: sanitize(value), stdout };
    } catch (e: any) {
        return { ok: false, stdout: "", error: String((e && e.message) || e) };   // wrapper didn't run (syntax error)
    } finally {
        py.globals.set("INJECTED_IMAGE_B64", null);
        py.globals.set("INJECTED_TABLES_JSON", null);
        if (saved) unharden(py, saved);
    }
}

// Serialize PY_RUN so a hardened run's global swap (harden/unharden) can't overlap another
// run on the shared Pyodide instance — one leaking capabilities into the other.
let runChain: Promise<unknown> = Promise.resolve();
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== "PY_RUN") return;
    runChain = runChain
        .then(() => run(msg.code, msg.image ?? null, msg.hardened !== false, msg.tables ?? null))
        .then(sendResponse, e => sendResponse({ ok: false, stdout: "", error: String(e) }));
    return true;   // keep the channel open for the async result
});
