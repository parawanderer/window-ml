// Pyodide (CPython→WASM) runtime, hosted in a DEDICATED WORKER spawned by the offscreen
// document. It used to run on the offscreen page's main thread — but that page shares a
// renderer process with the extension-origin sidebar iframe, so a compute-bound run
// (ndimage.label over a screenshot, a big numpy pass) blocked the shared main thread and
// froze the sidebar's click handling (scroll kept working — it's on the compositor thread).
// Moving the WASM off the main thread keeps the UI responsive during a long python_exec.
//
// This worker is chrome-free: it resolves the vendored Pyodide URLs relative to its OWN
// location (self.location) rather than chrome.runtime.getURL, and the sandbox logic
// (wrapUserSetup, wrapUserScript, injectInputs) is the same shared, real-CPython-tested module the
// offscreen path used. The offscreen doc is now a thin id-matched relay (offscreen.ts).
//
// A READONLY worker boots LOCKED DOWN (`lockdownReadonly`: ses `lockdown()` + the allow-list strip +
// the harness's captured refs) and stays that way. A FULL worker is a separate worker that is never
// locked — that is why `self.name` is "readonly" or "full", set by the host when it spawns us.

import { PY_PACKAGE_LOADS, PY_LAZY_LOADS, PY_BENCH_BASE_NAMES, PY_STARTUP_PREPARE } from "./python-env";
import { DIALECT_FILES, DIALECT_NODES } from "./dialect-data";
import { wrapUserSetup, wrapUserScript, COMPLETE_HELPER, completeIn, RESET, injectInputs, stdoutWriter, injectStoredTable, takeIpc, releaseNamespace, type PyCompletion } from "./python-runtime";
import { dialectSetup } from "./python-dialect-run";
import { lockdownReadonly } from "./lockdown";

// Captured BEFORE the lockdown's strip removes `postMessage` from `self` (`STRIPPED_NAMES`). Every reply
// in this file goes through `post`, never `self.postMessage` — which is gone once `lockdownReadonly` runs
// in a real Worker where `self === globalThis`.
const post = self.postMessage.bind(self);

/** Which kind of worker this is, from `self.name` (the host spawns one per principal and mode). */
const READONLY = self.name !== "full";
/** The harness module `lockdownReadonly` captured at boot; re-bound into every cell by `injectInputs`. */
let harness: unknown;   // state: plumbing — the frozen _ml_harness PyProxy, re-bound into every cell's namespace

type RunMsg = { id: number; code: string; image: string | null; hardened: boolean; tables: unknown; stream?: boolean; env?: boolean; complete?: { line: number; column: number; bench?: "readonly" | "full" }; persist?: boolean; benchReset?: boolean; wire?: boolean; inside?: boolean; run?: string | null; deleteRun?: string };
// `bootMs` is present ONLY on the call that paid for the cold start; `runMs` is the script itself, so the
// two never have to be inferred from one another.
// `prewarm` is on the first run after a pre-warm started the runtime: whether that run found it `warm` or still
// `starting`.
type RunResult = { ok: boolean; value?: unknown; stdout: string; stdoutDropped?: number; error?: string; ipc?: ArrayBuffer; table?: { columns: string[]; rows: (string | number | null)[][]; rowCount?: number }; render?: "latex" | "img" | "figure"; bootMs?: number; runMs?: number; bench?: BenchSession; prewarm?: "warm" | "starting"; notInDialect?: string };
/** A kept-state bench namespace after a run: which one it is (`id`, new whenever it is created afresh — a
 *  reset, or the worker restarting under it) and the variables the USER has in it, prelude names excluded. */
type BenchSession = { id: string; vars: { name: string; type: string }[] };

// THE `ml` WIRE (ML_WIRE.md): one pending call per `seq`, matched to the answer the offscreen document
// relays back. The worker never sees the client handle — the offscreen document stamps it — so this map
// is only `seq → resolve`, and a call that answers `ask` stays pending until the final `ML_ANSWER`.
const pendingWire = new Map<number, { resolve: (answerJson: string) => void }>();   // state: plumbing — one in-flight ml call each

/**
 * The transport `_ml_make` closes over: one wire request out, the FINAL answer back, as JSON text.
 * Posts `{ mlCall }` through the closure-held `post`; the offscreen document stamps `{ client, run }`
 * and relays `ML_CALL`. An `ask` answer does not resolve — the offscreen holds the promise until the
 * later `ML_ANSWER` push (LANE_1_PR2_DESIGN.md).
 * @param id the run message id this call rides (so a late answer can be dropped if the run is gone)
 * @returns `send(request_json) -> answer_json`, awaiting through a per-call ask
 */
function makeWireSend(id: number): (requestJson: string) => Promise<string> {
    return (requestJson: string) => new Promise((resolve) => {
        let seq: number;
        try { seq = Number(JSON.parse(requestJson)?.seq); } catch { resolve(JSON.stringify({ seq: -1, error: { code: "Failed", message: "the request was not readable" } })); return; }
        if (!Number.isFinite(seq)) { resolve(JSON.stringify({ seq: -1, error: { code: "Failed", message: "the request carried no seq" } })); return; }
        pendingWire.set(seq, { resolve });
        // The request is `{ seq, call, args }` only: which client and run it is for is stamped outside.
        try {
            const { call, args } = JSON.parse(requestJson) as { call: string; args: unknown[] };
            post({ id, mlCall: { seq, call, args: args ?? [] } });
        } catch (e) {
            pendingWire.delete(seq);
            resolve(JSON.stringify({ seq, error: { code: "Failed", message: String((e as Error)?.message || e) } }));
        }
    });
}

let pyodideReady: Promise<any> | null = null;
// Whether the runtime has finished starting. A run that finds it false WAITED for the start, and that wait is
// its `bootMs`: a first python_exec spends several seconds fetching the runtime and its wheels before a line of
// the script runs, and a plain "ran in 4.2s" blames the script for time it never spent — the same confusion a
// model's `load_duration` exists to settle. Measured HERE because the worker is the executor: anything
// downstream is measuring the message bus too. It is the run's own WAIT rather than the start's duration
// because of the pre-warm: a run arriving halfway through a pre-warmed start waited only for the rest of it.
let pyodideLive = false;
// Set when a PRE-WARM started the runtime and no run has used it yet: the first run reports whether it found
// the runtime warm, which is how the housekeeping log shows whether pre-warming pays for itself.
let prewarmUnused = false;
/**
 * The runtime, started on first call. When that first call starts it, the worker posts `{ booted, ms, by }` once
 * the start finishes, for the housekeeping log.
 *
 * @param by What started it: a pre-warm, or anything that needs the interpreter now.
 */
function getPyodide(by: "prewarm" | "run" = "run"): Promise<any> {
    if (!pyodideReady) prewarmUnused = by === "prewarm";
    if (!pyodideReady) pyodideReady = (async () => {
        // Resolve the bundled ESM + its asset dir relative to THIS worker's URL
        // (chrome-extension://<id>/python-worker.js) — no `chrome` needed in the worker.
        const base = self.location.href;
        const t0 = Date.now();
        const { loadPyodide } = await import(new URL("pyodide/pyodide.mjs", base).href);
        const py = await loadPyodide({ indexURL: new URL("pyodide/", base).href });
        await py.loadPackage(PY_PACKAGE_LOADS);
        // Lazy tooling (jedi) loads BEFORE the lockdown too: `complete()` calls `py.loadPackage(PY_LAZY_LOADS)`
        // after the strip has removed `fetch`, and Pyodide's loader needs it to fetch the wheel. Only readonly
        // workers pay this at boot — a full worker still has `fetch` and can load it on demand.
        if (READONLY && PY_LAZY_LOADS.length) await py.loadPackage(PY_LAZY_LOADS);
        // Before ANY run and before the lockdown: a package that needs the `js` bridge to import (pyarrow's
        // timezone helper) is imported here, where the bridge exists. See python-env.ts `prepare`.
        if (PY_STARTUP_PREPARE) py.runPython(PY_STARTUP_PREPARE);
        if (READONLY) {
            // The readonly worker's security model: ses `lockdown()` + the allow-list strip + the harness's
            // captured refs, once at boot, never undone. `harden()`/`unharden()` no longer gate anything —
            // the strip IS the hardening. The relay keeps `postMessage`/`close` in its closure; the harness
            // module is re-bound into every cell by `injectInputs`.
            const held = await lockdownReadonly(py, self);
            harness = held.harness;
        }
        pyodideLive = true;
        post({ booted: true, ms: Date.now() - t0, by });
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
           if not _k.startswith("_") and _k not in ${JSON.stringify([...PY_BENCH_BASE_NAMES, "INJECTED_IMAGE_B64", "INJECTED_TABLES_JSON"])}])`) as string);
    } finally { try { py.globals.delete("_ml_v_ns"); } catch { /* */ } }
}

// ROOT C: ONE NAMESPACE PER RUN (docs/spec/PYTHON_DIALECT.md "The namespace"). A run's cells share a
// dict; injected names (`df`/`tables`/`img`) are assigned into it without wiping the run's other
// bindings; RESET never wipes it. Deleted when the run closes (`deleteRun`), and a worker restart under
// a live run is told as a loss (the housekeeping record the offscreen document writes on respawn).
const runs = new Map<string, { ns: any; id: string }>();   // state: python.run-namespace — per-run Python namespace, lost on worker kill
/**
 * The run's kept namespace, created fresh on first use. `id` is new whenever it is created afresh, so a
 * reader can tell a restart from a continuation (the same shape as the bench's).
 * @param py the interpreter
 * @param runId the run
 * @returns the kept entry
 */
function runNamespace(py: any, runId: string): { ns: any; id: string } {
    let entry = runs.get(runId);
    if (!entry) {
        entry = { ns: py.globals.get("dict")(), id: `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
        runs.set(runId, entry);
    }
    return entry;
}
/** Drop a run's kept namespace: the run closed or was archived (`releaseNamespace` empties it first). */
function deleteRunNamespace(runId: string): void {
    const entry = runs.get(runId);
    if (!entry) return;
    releaseNamespace(entry.ns);
    runs.delete(runId);
}

// state: cache — "" once this interpreter can run cells inside the dialect, else why it cannot; loaded on the first inside run
let dialectReady: Promise<string> | null = null;

/**
 * Whether this interpreter can run a cell inside the dialect, loading the fork's allow tables on the first call.
 * @param py the interpreter
 * @returns "" when it can, else the reason (a stock or old core, or a load that failed), so the cell asks
 */
function dialectReason(py: any): Promise<string> {
    return dialectReady ??= Promise.resolve().then(() => py.runPythonAsync(dialectSetup(DIALECT_FILES)))
        .then((r: unknown) => String(r ?? ""), (e: any) => `the dialect's manifests could not be loaded (${String((e && e.message) || e).split("\n").filter(Boolean).pop()})`);
}

async function run(code: string, image: string | null, hardened: boolean, tables: unknown, onStdout?: (chunk: string) => void, persist = false, onStarted?: () => void, wire = false, runId: string | null = null, msgId = 0, inside = false): Promise<RunResult> {
    const wasLive = pyodideLive;
    const w0 = Date.now();
    const py = await getPyodide();
    const boot = wasLive ? null : Date.now() - w0;
    // INSIDE THE DIALECT (docs/spec/PYTHON_DIALECT.md, "Membership replaces `mode`"): an interpreter that cannot judge
    // membership runs nothing unasked; the cell is reported outside and goes to the person.
    const unready = inside ? await dialectReason(py) : "";
    if (unready) return { ok: false, stdout: "", notInDialect: unready };
    const prewarm = prewarmUnused ? (wasLive ? "warm" : "starting") : undefined;
    prewarmUnused = false;
    // `started` / `t0` fire when the USER'S CELL is about to run — after the namespace, the injected inputs,
    // the wire transport and the prelude (which imports pandas). The 15s is that cell's, not the cold start,
    // the queue ahead of it, or the imports in front of it (see runInWorker in offscreen.ts and the
    // "queued behind another" e2e). A setup that hangs is still the START bound's to clear.
    let t0 = Date.now();
    const timed = (r: RunResult): RunResult => ({ ...r, runMs: Date.now() - t0, ...(boot != null ? { bootMs: boot } : {}), ...(prewarm ? { prewarm } : {}) });
    // Where this run executes: a kept namespace (the bench's per-mode one, or ROOT C's per-run dict), or
    // the main one a one-off `python_exec` resets. A run's dict is the ROOT C namespace (PYTHON_DIALECT.md):
    // cells of the same run share it, RESET never wipes it, and injected names are assigned into it.
    const bench = persist ? benchNamespace(py, hardened) : null;
    const keptRun = !bench && runId ? runNamespace(py, runId) : null;
    const kept = bench ?? keptRun;
    const ns = kept ? kept.ns : py.globals;
    // Read only by PRELUDE_DATA, which a kept-state run does not execute — so never put into a bench namespace,
    // where they were listed as two variables no script had defined (and offered by completion).
    const tableBufs: string[] = [];
    if (!kept) {
        // Python None/str, never a JS null: `set` of a null lands as `JsNull`, a JsProxy in the namespace.
        const injected = Array.isArray(tables) ? tables.map((t, i) => injectStoredTable(py, ns, t, `_ml_tbuf_${i}`, tableBufs)) : tables;
        injectInputs(ns, image, Array.isArray(injected) && injected.length ? JSON.stringify(injected) : null, harness);
    } else if (keptRun) {
        // ROOT C: a run's kept dict still gets the injected names and the harness, assigned WITHOUT
        // wiping the run's other bindings. `injectInputs` sets the injected inputs; the wrapper's
        // wrapper's `"run"` prelude decodes `img`/`tables` only when they are present.
        const injected = Array.isArray(tables) ? tables.map((t, i) => injectStoredTable(py, ns, t, `_ml_tbuf_${i}`, tableBufs)) : tables;
        injectInputs(ns, image, Array.isArray(injected) && injected.length ? JSON.stringify(injected) : null, harness);
    } else {
        // A kept-state bench run still needs the harness module in its namespace — the wrapper looks it up there.
        // Only the harness: `injectInputs` would also set INJECTED_IMAGE_B64 / INJECTED_TABLES_JSON as
        // undefined (→ Python None) in the bench namespace, and `benchVars()` would list them as kept.
        if (harness !== undefined) ns.set("_ml_harness", harness);
    }
    // THE `ml` WIRE TRANSPORT: a leading-underscore global the wrapper folds into `_ml_make` and drops.
    // The worker never sees the client handle (the offscreen document stamps it); this only posts
    // `{ seq, call, args }` and resolves when the answer comes back (LANE_1_PR2_DESIGN.md).
    if (wire) ns.set("_ml_send", makeWireSend(msgId));
    // LIVE stdout tee (opt-in streaming): Pyodide's JS-side setStdout wraps the interpreter's real stdout,
    // which the prelude's _MlTee writes through to. No callback object lands in the namespace — a JsProxy
    // of one is a JS `Function` constructor to a hostile cell. Cleared in finally.
    if (onStdout) py.setStdout(stdoutWriter(onStdout));
    try {
        // SETUP first: harness refs, RESET (per-run isolation) + PRELUDE (preloaded vars) + net policy + the
        // `ml` facade → `python-runtime.ts`. Not the user's cell, so it is not what the 15s covers.
        // The readonly worker's `hardened` flag is the wrapper's netPolicy belt — the lockdown already
        // stripped the JS realm. The full worker passes false and keeps the bridges.
        // `persist` is true for ANY kept namespace (bench or ROOT C's per-run dict): no RESET, and the
        // wrapper's async `await _user()` drives `await ml.*` cells.
        const keep = bench ? true : keptRun ? "run" : false;
        await py.runPythonAsync(wrapUserSetup(hardened, keep), { globals: ns });
        // THE USER'S CELL IS ABOUT TO RUN. Said out loud so the offscreen watchdog swaps the generous START
        // bound for the script's own 15s at the only moment that 15s is meant to measure.
        onStarted?.();
        t0 = Date.now();
        // The cell itself, wrapped to capture stdout / a `return`-or-bare-`result=` value / a traceback.
        // Reads back _stdout/_err/_json_result.
        await py.runPythonAsync(wrapUserScript(code, keep, inside ? { nodes: DIALECT_NODES } : null), { globals: ns });
        // A refused inside run: its output and value are discarded (only the full-path run's result is the cell's), and the
        // namespace is as it was. The host asks the person, saying where the cell left the dialect.
        const refused = inside ? ns.get("_ml_not_in_dialect") : undefined;
        if (refused) return timed({ ok: false, stdout: "", notInDialect: String(refused) });
        const stdout = String(ns.get("_stdout") ?? "");
        // Characters printed past the ceiling and not kept (python-runtime.ts _MlTee); rides every result below.
        const dropped = Number(ns.get("_ml_stdout_dropped") ?? 0) || 0;
        const over = dropped ? { stdoutDropped: dropped } : {};
        const err = ns.get("_err");
        // A kept-state run reports its namespace either way — what you defined before the line that failed
        // is still there, and the bench says so.
        const keptResult = bench ? { bench: { id: bench.id, vars: benchVars(py, ns) } } : keptRun ? { bench: { id: keptRun.id, vars: benchVars(py, ns) } } : {};
        if (err) return timed({ ok: false, stdout, error: String(err), ...over, ...keptResult });
        // A DataFrame/Series result also arrives structurally ({columns, rows}) so the UI can draw a real table.
        const tableJson = ns.get("_json_table");
        let table: RunResult["table"];
        if (typeof tableJson === "string") { try { table = JSON.parse(tableJson); } catch { /* keep text */ } }
        // The whole returned frame as Arrow IPC, when it is larger than its preview: copied out of Pyodide once and
        // transferred to the offscreen document, which stores it. Never from the bench, whose results nothing points at.
        const ipc = bench ? undefined : takeIpc(ns);
        const jsonResult = ns.get("_json_result");
        // Auto-render hint from the return TYPE ('latex' for a sympy expr; 'img' folded into a data: value; 'figure' for
        // matplotlib figures the cell left open, drawn as that value).
        const renderHint = ns.get("_json_render");
        const render = renderHint === "latex" || renderHint === "img" || renderHint === "figure" ? renderHint : undefined;
        if (typeof jsonResult === "string") {
            let value: unknown; try { value = JSON.parse(jsonResult); } catch { value = jsonResult; }
            return timed({ ok: true, value, stdout, ...over, ...(table ? { table } : {}), ...(ipc ? { ipc } : {}), ...(render ? { render } : {}), ...keptResult });
        }
        // Fallback for a non-JSON-serializable return (rare — models return images via
        // to_base64): convert via toJs, then destroy the proxy so it can't leak.
        const r = ns.get("result");
        const value = r && r.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r;
        if (r && r.destroy) r.destroy();
        return timed({ ok: true, value: sanitize(value), stdout, ...over, ...(ipc ? { ipc } : {}), ...keptResult });
    } catch (e: any) {
        // The wrapper itself failed (a user syntax error is caught INSIDE it, as `_err`). A kept namespace still exists,
        // and may hold the names earlier cells defined, so the scope manifest rides this result too.
        let keptCatch = {};
        if (kept) { try { keptCatch = { bench: { id: kept.id, vars: benchVars(py, ns) } }; } catch { /* the namespace is unreadable */ } }
        return timed({ ok: false, stdout: "", error: String((e && e.message) || e), ...keptCatch });
    } finally {
        if (!kept) injectInputs(ns, null, null, harness);
        if (wire) { try { ns.delete("_ml_send"); } catch { /* the wrapper dropped it */ } }
        if (onStdout) { try { py.setStdout({}); } catch { /* ignore */ } }
        for (const name of tableBufs) { try { ns.delete(name); } catch { /* the prelude already took it */ } }
        try { ns.delete("_ipc_result"); } catch { /* not set */ }
        // The loaders' namespace pointer is per cell: a stale one must not keep a released run's dict reachable.
        try { py.globals.set("_ml_load_ns", undefined); } catch { /* the interpreter is gone */ }
        if (inside) for (const name of ["_ml_not_in_dialect", "_ml_inside_run", "_ml_trailing_return"]) { try { ns.delete(name); } catch { /* not set */ } }
        // A `python_exec` leaves its injected screenshot and tables in main until the NEXT run's reset — and
        // main is where the loader redirects live, reading `img`/`tables` at call time. So a bench script's
        // `pd.read_csv("sales")` could have been handed the model's last table. Clear them now instead.
        if (!bench) { try { py.runPython(RESET); } catch { /* the next run resets anyway */ } }
    }
}

// Serialize runs on the single Pyodide instance this worker owns — one interpreter, one queue.
// The per-principal split is the HOST's (offscreen spawns one worker per principal); inside a
// worker, runs still queue so a completion or env query cannot land mid-run.
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

// The message handler. Registered via `addEventListener` at module load — BEFORE the lockdown strips
// `addEventListener` — so the listener lives in the browser's C++ EventTarget list, unreachable from JS
// after the strip. Setting `self.onmessage` instead would invoke the WebIDL setter (which starts the
// MessagePort); `Object.defineProperty(self, "onmessage", ...)` shadows that setter WITHOUT invoking it,
// and the port never starts — every message goes unanswered until the 120s timeout.
function onMessage(e: MessageEvent): void {
    const msg = e.data as RunMsg & { mlAnswer?: { seq: number; answer: unknown } };
    // THE `ml` WIRE ANSWER (ML_WIRE.md): a call's final answer, matched by `seq`. An `ask` is not final —
    // the offscreen document holds the promise and only relays the later `ML_ANSWER`. Not a run message,
    // so it is handled before the `id` check.
    if (msg?.mlAnswer && typeof msg.mlAnswer.seq === "number") {
        const pending = pendingWire.get(msg.mlAnswer.seq);
        if (pending) {
            pendingWire.delete(msg.mlAnswer.seq);
            try { pending.resolve(JSON.stringify(msg.mlAnswer.answer)); }
            catch { pending.resolve(JSON.stringify({ seq: msg.mlAnswer.seq, error: { code: "Failed", message: "the answer was not readable" } })); }
        }
        return;
    }
    if (!msg || typeof msg.id !== "number") return;
    // ROOT C: drop a run's kept namespace when the run closes or is archived. Through the chain so it
    // cannot land mid-run.
    if (typeof msg.deleteRun === "string" && msg.deleteRun) {
        runChain = runChain.then(() => { deleteRunNamespace(msg.deleteRun!); post({ id: msg.id, ok: true, stdout: "" }); });
        return;
    }
    // A worker is readonly OR full, never both: the readonly one is locked down at boot and must not be
    // handed a `full` run (the bridges are stripped), and a full worker must not be handed a readonly
    // run under the assumption it is locked. Refuse rather than silently run in the wrong sandbox.
    if (msg.hardened !== undefined && msg.hardened !== READONLY && !msg.complete && !msg.env && !msg.benchReset && !(msg as { prewarm?: boolean }).prewarm) {
        post({ id: msg.id, ok: false, stdout: "", error: READONLY ? "Refused: this worker is the readonly sandbox (locked down)." : "Refused: this worker is the full sandbox (not locked down)." });
        return;
    }
    // A PRE-WARM: start the runtime now so the run that needs it later does not wait. Deliberately NOT on the
    // run chain — a run arriving meanwhile must wait on the start itself (and be charged for that wait), not
    // queue behind a message that is itself waiting on it. Answers at once with whether it started anything.
    if ((msg as unknown as { prewarm?: boolean }).prewarm) {
        const started = pyodideReady == null;
        getPyodide("prewarm").catch(() => { /* the run that needs it reports the failure */ });
        post({ id: msg.id, ok: true, stdout: "", prewarm: started ? "started" : "already" });
        return;
    }
    // An ENV query, not a run. It goes through the same serialized chain so it cannot land between a run's
    // globals being set and its code executing — the interpreter is one thread and this reads from it.
    if ((msg as unknown as { env?: boolean }).env) {
        runChain = runChain.then(() => env()).then(
            (info) => post({ id: msg.id, ok: true, stdout: "", env: info }),
            (err: unknown) => post({ id: msg.id, ok: false, stdout: "", error: String(err) }),
        );
        return;
    }
    // A COMPLETION, not a run: the script is analysed, never executed. It joins the same serialized chain for
    // the same reason the env query does — it reads the one interpreter and must not interleave with a run.
    // A completion asked for during a long run therefore waits for it; the editor has a short budget and
    // falls back to its static list rather than blocking.
    if (msg.complete) {
        const { line, column, bench } = msg.complete;
        runChain = runChain.then(() => complete(msg.code, line, column, bench)).then(
            (completions) => post({ id: msg.id, ok: true, stdout: "", completions }),
            (err: unknown) => post({ id: msg.id, ok: false, stdout: "", error: String(err) }),
        );
        return;
    }
    // Throw away the bench's kept state, both modes. Through the chain like everything else that touches the
    // interpreter, so it cannot land in the middle of a run that is using it.
    if (msg.benchReset) {
        runChain = runChain.then(() => { resetBench(); post({ id: msg.id, ok: true, stdout: "" }); });
        return;
    }
    // Live stdout streaming: when the run opted in (`stream`), post each print() chunk back as a `partial`
    // message (offscreen forwards it up the chain); the final message still carries the full result.
    // Stamped HERE, in the worker — this is where the print actually happened. The chunk then crosses
    // offscreen → SW → page before anything renders it, so a timestamp taken downstream would be skewed
    // by those hops (the same reason a remote bash tool must stamp on its own server).
    const onStdout = msg.stream ? (chunk: string) => post({ id: msg.id, partial: true, chunk, ts: Date.now() }) : undefined;
    const onStarted = () => post({ id: msg.id, started: true });
    runChain = runChain
        .then(() => run(msg.code, msg.image ?? null, msg.hardened !== false, msg.tables ?? null, onStdout, msg.persist === true, onStarted, msg.wire === true, msg.run ?? null, msg.id, msg.inside === true))
        .then(
            (result: RunResult) => post({ id: msg.id, ...result }, { transfer: result.ipc ? [result.ipc] : [] }),
            (err: unknown) => post({ id: msg.id, ok: false, stdout: "", error: String(err) }),
        );
}
self.addEventListener("message", onMessage as EventListener);
