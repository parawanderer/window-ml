// Pyodide (CPython→WASM) runtime, hosted in a DEDICATED WORKER spawned by the offscreen
// document. It used to run on the offscreen page's main thread — but that page shares a
// renderer process with the extension-origin sidebar iframe, so a compute-bound run
// (ndimage.label over a screenshot, a big numpy pass) blocked the shared main thread and
// froze the sidebar's click handling (scroll kept working — it's on the compositor thread).
// Moving the WASM off the main thread keeps the UI responsive during a long python_exec.
//
// This worker is chrome-free: it resolves the vendored Pyodide URLs relative to its OWN
// location (self.location) rather than chrome.runtime.getURL, and the sandbox logic
// (wrapUserCode/harden/unharden) is the same shared, real-CPython-tested module the
// offscreen path used. The offscreen doc is now a thin id-matched relay (offscreen.ts).

import { PY_PACKAGE_LOADS } from "./python-env";
import { wrapUserCode, harden, unharden } from "./python-runtime";

type RunMsg = { id: number; code: string; image: string | null; hardened: boolean; tables: unknown; stream?: boolean };
type RunResult = { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] }; render?: "latex" | "img" };

let pyodideReady: Promise<any> | null = null;
function getPyodide(): Promise<any> {
    if (!pyodideReady) pyodideReady = (async () => {
        // Resolve the bundled ESM + its asset dir relative to THIS worker's URL
        // (chrome-extension://<id>/python-worker.js) — no `chrome` needed in the worker.
        const base = self.location.href;
        const { loadPyodide } = await import(new URL("pyodide/pyodide.mjs", base).href);
        const py = await loadPyodide({ indexURL: new URL("pyodide/", base).href });
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

async function run(code: string, image: string | null, hardened: boolean, tables: unknown, onStdout?: (chunk: string) => void): Promise<RunResult> {
    const py = await getPyodide();
    py.globals.set("INJECTED_IMAGE_B64", image);
    py.globals.set("INJECTED_TABLES_JSON", Array.isArray(tables) && tables.length ? JSON.stringify(tables) : null);
    // LIVE stdout tee (opt-in streaming): the prelude's _MlTee calls this per print(). Set only when the
    // caller wants live output; cleared in finally so a later non-streaming run doesn't reuse a stale cb (it
    // survives the per-run RESET — a leading-underscore global). No callback → pure capture, unchanged.
    if (onStdout) py.globals.set("_ml_stdout_cb", onStdout);
    const saved = hardened ? harden(py) : null;
    try {
        // RESET (per-run isolation) + PRELUDE (preloaded vars) + the user's code, wrapped to capture
        // stdout / a `return`-or-bare-`result=` value / a traceback → `python-runtime.ts` (shared so
        // the exact script is exercised against real CPython in tests). Reads back _stdout/_err/_json_result.
        await py.runPythonAsync(wrapUserCode(code, hardened));
        const stdout = String(py.globals.get("_stdout") ?? "");
        const err = py.globals.get("_err");
        if (err) return { ok: false, stdout, error: String(err) };
        // A DataFrame/Series result also arrives structurally ({columns, rows}) so the UI can draw a real table.
        const tableJson = py.globals.get("_json_table");
        let table: RunResult["table"];
        if (typeof tableJson === "string") { try { table = JSON.parse(tableJson); } catch { /* keep text */ } }
        const jsonResult = py.globals.get("_json_result");
        // Auto-render hint from the return TYPE ('latex' for a sympy expr; 'img' folded into a data: value).
        const renderHint = py.globals.get("_json_render");
        const render = renderHint === "latex" || renderHint === "img" ? renderHint : undefined;
        if (typeof jsonResult === "string") {
            let value: unknown; try { value = JSON.parse(jsonResult); } catch { value = jsonResult; }
            return { ok: true, value, stdout, ...(table ? { table } : {}), ...(render ? { render } : {}) };
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
        if (onStdout) { try { py.globals.delete("_ml_stdout_cb"); } catch { /* ignore */ } }   // don't leak the cb into the next run
        if (saved) unharden(py, saved);
    }
}

// Serialize runs on the single Pyodide instance so a hardened run's global swap
// (harden/unharden) can't overlap another run — one leaking capabilities into the other.
// The worker owns the instance, so the invariant lives here now (was offscreen's runChain).
let runChain: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent) => {
    const msg = e.data as RunMsg;
    if (!msg || typeof msg.id !== "number") return;
    // Live stdout streaming: when the run opted in (`stream`), post each print() chunk back as a `partial`
    // message (offscreen forwards it up the chain); the final message still carries the full result.
    const onStdout = msg.stream ? (chunk: string) => self.postMessage({ id: msg.id, partial: true, chunk }) : undefined;
    runChain = runChain
        .then(() => run(msg.code, msg.image ?? null, msg.hardened !== false, msg.tables ?? null, onStdout))
        .then(
            (result: RunResult) => self.postMessage({ id: msg.id, ...result }),
            (err: unknown) => self.postMessage({ id: msg.id, ok: false, stdout: "", error: String(err) }),
        );
};
