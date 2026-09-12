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

import { PY_PACKAGE_LOADS, PY_LAZY_LOADS, PY_BENCH_BASE_NAMES } from "./python-env";
import { wrapUserCode, harden, unharden, COMPLETE_HELPER, completeIn, RESET, type PyCompletion } from "./python-runtime";

type RunMsg = { id: number; code: string; image: string | null; hardened: boolean; tables: unknown; stream?: boolean; env?: boolean; complete?: { line: number; column: number; bench?: "readonly" | "full" }; persist?: boolean; benchReset?: boolean };
// `bootMs` is present ONLY on the call that paid for the cold start; `runMs` is the script itself, so the
// two never have to be inferred from one another.
type RunResult = { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] }; render?: "latex" | "img"; bootMs?: number; runMs?: number; bench?: BenchSession };
/** A kept-state bench namespace after a run: which one it is (`id`, new whenever it is created afresh — a
 *  reset, or the worker restarting under it) and the variables the USER has in it, prelude names excluded. */
type BenchSession = { id: string; vars: { name: string; type: string }[] };

let pyodideReady: Promise<any> | null = null;
// HOW LONG THE COLD START TOOK, charged to the run that PAID for it. A first python_exec spends several
// seconds fetching the runtime and its wheels before a line of the script runs, and a plain "ran in 4.2s"
// blames the script for time it never spent — the same confusion a model's `load_duration` exists to
// settle ("it was slow" and "it was not there yet" are different answers, and only one is about the code).
// Measured HERE because the worker is the executor: anything downstream is measuring the message bus too.
// Read once and cleared, so only the first call reports it; every later run is a warm start with none.
let pendingBootMs: number | null = null;
export const takeBootMs = (): number | null => { const b = pendingBootMs; pendingBootMs = null; return b; };
function getPyodide(): Promise<any> {
    if (!pyodideReady) pyodideReady = (async () => {
        // Resolve the bundled ESM + its asset dir relative to THIS worker's URL
        // (chrome-extension://<id>/python-worker.js) — no `chrome` needed in the worker.
        const base = self.location.href;
        const t0 = Date.now();
        const { loadPyodide } = await import(new URL("pyodide/pyodide.mjs", base).href);
        const py = await loadPyodide({ indexURL: new URL("pyodide/", base).href });
        await py.loadPackage(PY_PACKAGE_LOADS);
        pendingBootMs = Date.now() - t0;
        return py;
    })();
    return pyodideReady;
}

// toJs can produce Maps / nested proxies; a JSON round-trip flattens to plain data (and
// drops anything non-serializable — which shouldn't cross the message bus anyway).
function sanitize(v: unknown): unknown {
    try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

// THE BENCH'S KEPT STATE: one namespace per sandbox MODE, separate from the interpreter's main namespace.
// Separate from main because main belongs to the model's `python_exec`, which wipes it every run (and the
// model must not see a person's variables either). One per mode because a `full` run can store a live handle
// to the browser's network functions in a variable, and if that survived into a later `readonly` run,
// readonly would quietly stop being a sandbox — so nothing crosses between them. Gone when the worker is
// (the watchdog kills it on a runaway script), and that is reported rather than hidden: a fresh namespace
// gets a fresh `id`, which the bench compares against the last one it saw.
const benchNs = new Map<"readonly" | "full", { ns: any; id: string }>();
function benchNamespace(py: any, hardened: boolean): { ns: any; id: string } {
    const key = hardened ? "readonly" : "full";
    let entry = benchNs.get(key);
    if (!entry) {
        entry = { ns: py.globals.get("dict")(), id: `${key}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
        benchNs.set(key, entry);
    }
    return entry;
}
function resetBench(): void {
    for (const { ns } of benchNs.values()) { try { ns.destroy(); } catch { /* already gone */ } }
    benchNs.clear();
}
/** The user's names in a bench namespace, with their Python type — prelude bindings and `_` names excluded. */
function benchVars(py: any, ns: any): BenchSession["vars"] {
    py.globals.set("_ml_v_ns", ns);
    try {
        return JSON.parse(py.runPython(`import json as _jv
_jv.dumps([{"name": _k, "type": type(_v).__name__} for _k, _v in sorted(_ml_v_ns.items())
           if not _k.startswith("_") and _k not in ${JSON.stringify(PY_BENCH_BASE_NAMES)}])`) as string);
    } finally { try { py.globals.delete("_ml_v_ns"); } catch { /* */ } }
}

async function run(code: string, image: string | null, hardened: boolean, tables: unknown, onStdout?: (chunk: string) => void, persist = false, onStarted?: () => void): Promise<RunResult> {
    const py = await getPyodide();
    const boot = takeBootMs();
    // The runtime is up: from here on the time is the SCRIPT's. Said out loud so the offscreen watchdog can time
    // the script rather than the cold start and the queue in front of it (see runInWorker in offscreen.ts).
    onStarted?.();
    // The script's own clock starts AFTER the runtime is up, so the two numbers add to the wall time
    // rather than overlapping — which is what lets the panel show them as one bar split in two.
    const t0 = Date.now();
    const timed = (r: RunResult): RunResult => ({ ...r, runMs: Date.now() - t0, ...(boot != null ? { bootMs: boot } : {}) });
    // Where this run executes: the bench's kept namespace for its mode, or the main one a `python_exec` resets.
    const bench = persist ? benchNamespace(py, hardened) : null;
    const ns = bench ? bench.ns : py.globals;
    // Read only by PRELUDE_DATA, which a kept-state run does not execute — so never put into a bench namespace,
    // where they were listed as two variables no script had defined (and offered by completion).
    if (!bench) {
        ns.set("INJECTED_IMAGE_B64", image);
        ns.set("INJECTED_TABLES_JSON", Array.isArray(tables) && tables.length ? JSON.stringify(tables) : null);
    }
    // LIVE stdout tee (opt-in streaming): the prelude's _MlTee calls this per print(). Set only when the
    // caller wants live output; cleared in finally so a later non-streaming run doesn't reuse a stale cb (it
    // survives the per-run RESET — a leading-underscore global). No callback → pure capture, unchanged.
    if (onStdout) ns.set("_ml_stdout_cb", onStdout);
    const saved = hardened ? harden(py) : null;
    try {
        // RESET (per-run isolation) + PRELUDE (preloaded vars) + the user's code, wrapped to capture
        // stdout / a `return`-or-bare-`result=` value / a traceback → `python-runtime.ts` (shared so
        // the exact script is exercised against real CPython in tests). Reads back _stdout/_err/_json_result.
        await py.runPythonAsync(wrapUserCode(code, hardened, persist), { globals: ns });
        const stdout = String(ns.get("_stdout") ?? "");
        const err = ns.get("_err");
        // A kept-state run reports its namespace either way — what you defined before the line that failed
        // is still there, and the bench says so.
        const kept = bench ? { bench: { id: bench.id, vars: benchVars(py, ns) } } : {};
        if (err) return timed({ ok: false, stdout, error: String(err), ...kept });
        // A DataFrame/Series result also arrives structurally ({columns, rows}) so the UI can draw a real table.
        const tableJson = ns.get("_json_table");
        let table: RunResult["table"];
        if (typeof tableJson === "string") { try { table = JSON.parse(tableJson); } catch { /* keep text */ } }
        const jsonResult = ns.get("_json_result");
        // Auto-render hint from the return TYPE ('latex' for a sympy expr; 'img' folded into a data: value).
        const renderHint = ns.get("_json_render");
        const render = renderHint === "latex" || renderHint === "img" ? renderHint : undefined;
        if (typeof jsonResult === "string") {
            let value: unknown; try { value = JSON.parse(jsonResult); } catch { value = jsonResult; }
            return timed({ ok: true, value, stdout, ...(table ? { table } : {}), ...(render ? { render } : {}), ...kept });
        }
        // Fallback for a non-JSON-serializable return (rare — models return images via
        // to_base64): convert via toJs, then destroy the proxy so it can't leak.
        const r = ns.get("result");
        const value = r && r.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r;
        if (r && r.destroy) r.destroy();
        return timed({ ok: true, value: sanitize(value), stdout, ...kept });
    } catch (e: any) {
        return timed({ ok: false, stdout: "", error: String((e && e.message) || e) });   // wrapper didn't run (syntax error)
    } finally {
        if (!bench) {
            ns.set("INJECTED_IMAGE_B64", null);
            ns.set("INJECTED_TABLES_JSON", null);
        }
        if (onStdout) { try { ns.delete("_ml_stdout_cb"); } catch { /* ignore */ } }   // don't leak the cb into the next run
        // A `python_exec` leaves its injected screenshot and tables in main until the NEXT run's reset — and
        // main is where the loader redirects live, reading `img`/`tables` at call time. So a bench script's
        // `pd.read_csv("sales")` could have been handed the model's last table. Clear them now instead.
        if (!bench) { try { py.runPython(RESET); } catch { /* the next run resets anyway */ } }
        if (saved) unharden(py, saved);
    }
}

// Serialize runs on the single Pyodide instance so a hardened run's global swap
// (harden/unharden) can't overlap another run — one leaking capabilities into the other.
// The worker owns the instance, so the invariant lives here now (was offscreen's runChain).
let runChain: Promise<unknown> = Promise.resolve();
// WHAT THE SANDBOX ACTUALLY IS — the Python and Pyodide versions, and each package's installed version.
// Read FROM the running interpreter rather than from our own manifest: the manifest says what we asked for,
// and the wheel that got installed is what the code will actually import. A panel that reports the first
// while the second is different is worse than one that reports nothing.
async function env(): Promise<{ python: string; pyodide: string; packages: { name: string; version?: string }[] }> {
    const py = await getPyodide();
    const versions = py.runPython(`
import sys, json
from importlib.metadata import version, PackageNotFoundError
def _v(n):
    try: return version(n)
    except PackageNotFoundError: return None
json.dumps({ "python": sys.version.split()[0], "packages": { n: _v(n) for n in ${JSON.stringify(PY_PACKAGE_LOADS)} } })
`) as string;
    const parsed = JSON.parse(versions) as { python: string; packages: Record<string, string | null> };
    return {
        python: parsed.python,
        pyodide: String(py.version ?? ""),
        // Ordered as the manifest lists them, so the panel reads the way the tool description does.
        packages: PY_PACKAGE_LOADS.map((name) => ({ name, ...(parsed.packages[name] ? { version: parsed.packages[name]! } : {}) })),
    };
}

// THE EDITOR'S COMPLETION ENGINE, loaded on the FIRST request and never at start-up: 1.6 MB of wheels a
// `python_exec` has no use for. A failed load clears the memo, so a later request tries again rather than
// the bench being stuck on the static list for the rest of the session.
let completerReady: Promise<void> | null = null;
async function complete(code: string, line: number, column: number, bench?: "readonly" | "full"): Promise<PyCompletion[]> {
    const py = await getPyodide();
    completerReady ??= (async () => { await py.loadPackage(PY_LAZY_LOADS); py.runPython(COMPLETE_HELPER); })()
        .catch((err: unknown) => { completerReady = null; throw err; });
    await completerReady;
    // The bench's kept namespace for the mode it is in, when there is one: Jedi then completes the LIVE objects
    // (`grid.` after `grid = np.arange(...)`), which static analysis alone cannot type. With none, the prelude's
    // names still complete: `completeIn` reads the prelude in front of the script.
    return completeIn(py, code, line, column, bench ? benchNs.get(bench)?.ns : undefined);
}

self.onmessage = (e: MessageEvent) => {
    const msg = e.data as RunMsg;
    if (!msg || typeof msg.id !== "number") return;
    // An ENV query, not a run. It goes through the same serialized chain so it cannot land between a run's
    // globals being set and its code executing — the interpreter is one thread and this reads from it.
    if ((msg as unknown as { env?: boolean }).env) {
        runChain = runChain.then(() => env()).then(
            (info) => self.postMessage({ id: msg.id, ok: true, stdout: "", env: info }),
            (err: unknown) => self.postMessage({ id: msg.id, ok: false, stdout: "", error: String(err) }),
        );
        return;
    }
    // A COMPLETION, not a run: the script is analysed, never executed. It joins the same serialized chain for
    // the same reason the env query does — it reads the one interpreter, and hardens it while it does, which
    // must not interleave with a run's own harden/unharden. A completion asked for during a long run therefore
    // waits for it; the editor has a short budget and falls back to its static list rather than blocking.
    if (msg.complete) {
        const { line, column, bench } = msg.complete;
        runChain = runChain.then(() => complete(msg.code, line, column, bench)).then(
            (completions) => self.postMessage({ id: msg.id, ok: true, stdout: "", completions }),
            (err: unknown) => self.postMessage({ id: msg.id, ok: false, stdout: "", error: String(err) }),
        );
        return;
    }
    // Throw away the bench's kept state, both modes. Through the chain like everything else that touches the
    // interpreter, so it cannot land in the middle of a run that is using it.
    if (msg.benchReset) {
        runChain = runChain.then(() => { resetBench(); self.postMessage({ id: msg.id, ok: true, stdout: "" }); });
        return;
    }
    // Live stdout streaming: when the run opted in (`stream`), post each print() chunk back as a `partial`
    // message (offscreen forwards it up the chain); the final message still carries the full result.
    // Stamped HERE, in the worker — this is where the print actually happened. The chunk then crosses
    // offscreen → SW → page before anything renders it, so a timestamp taken downstream would be skewed
    // by those hops (the same reason a remote bash tool must stamp on its own server).
    const onStdout = msg.stream ? (chunk: string) => self.postMessage({ id: msg.id, partial: true, chunk, ts: Date.now() }) : undefined;
    const onStarted = () => self.postMessage({ id: msg.id, started: true });
    runChain = runChain
        .then(() => run(msg.code, msg.image ?? null, msg.hardened !== false, msg.tables ?? null, onStdout, msg.persist === true, onStarted))
        .then(
            (result: RunResult) => self.postMessage({ id: msg.id, ...result }),
            (err: unknown) => self.postMessage({ id: msg.id, ok: false, stdout: "", error: String(err) }),
        );
};
