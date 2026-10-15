// FAILING-FIRST red-team vectors for the readonly `python_exec` sandbox escape.
//
// Real Pyodide in Node (`dist/pyodide/`, self-SKIPS without it), driving the EXACT hardened path
// `python-worker.ts` runs: `harden(py)` then `py.runPythonAsync(wrapUserCode(code, true))`.
// Each test names the PROPERTY the boundary must keep, carries a positive control proving the probe
// works (so a broken setup cannot pass), and is marked `{ todo: ... }` while the property is open.
// The Pyodide lockdown (`docs/plan/repl/PYODIDE_LOCKDOWN.md`) removes the marks; a mark that goes
// green before that is a bug in the test.
//
// Measured OPEN on main against real Pyodide (all five): see the todo text on each test.
// `src/python/lockdown.ts` is the defence's chrome-free entry (`lockdownReadonly(py, scope)`); it is
// imported dynamically so this file loads before the defence exists and the assertions still run.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, harden, unharden } from "../src/python/python-runtime.ts";

/** The defence's boot hook. Absent on main: the calls below are no-ops and the properties stay open. */
let lockdownReadonly = null;
try { ({ lockdownReadonly } = await import("../src/python/lockdown.ts")); } catch { /* defence not landed */ }

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

// What is open, named once so the fixer greps one string. Disclosure is lifted (no users yet), so the
// titles and this text name the routes plainly.
const OPEN = "Pyodide lockdown (docs/plan/repl/PYODIDE_LOCKDOWN.md): open on main";

let py = null;
before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    const withArrow = fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("pyarrow-"));
    await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy", ...(withArrow ? ["pyarrow"] : [])]);
}, { timeout: 180000 });

/**
 * Run one cell the way a hardened `python_exec` does, and read the wrapper's results back.
 * `stream` binds the stdout tee's JS callback exactly as `python-worker.ts` does today.
 * `later` is the harness's "a later await": a raw `runPythonAsync` that pumps the event loop AFTER
 * the cell's result has been returned (not the wrapper — it is not a cell).
 */
async function cell(code, { hardened = true, stream = false, tables = null, image = null, later = 0 } = {}) {
    py.globals.set("INJECTED_IMAGE_B64", image);
    py.globals.set("INJECTED_TABLES_JSON", tables == null ? null : JSON.stringify(tables));
    if (stream) py.globals.set("_ml_stdout_cb", (s) => { (cell.chunks ??= []).push(s); });
    const saved = hardened ? harden(py) : null;
    try {
        await py.runPythonAsync(wrapUserCode(code, hardened));
    } finally {
        if (saved) unharden(py, saved);
        if (stream) { try { py.globals.delete("_ml_stdout_cb"); } catch { /* absent */ } }
    }
    const out = {
        stdout: String(py.globals.get("_stdout") ?? ""),
        error: py.globals.get("_err") ? String(py.globals.get("_err")) : null,
        chunks: cell.chunks ?? [],
        jsProxies: null,
    };
    cell.chunks = null;
    const jr = py.globals.get("_json_result");
    try { out.value = JSON.parse(jr); } catch { out.value = jr === undefined ? null : String(jr); }
    if (later) await py.runPythonAsync(`import asyncio\nawait asyncio.sleep(${later})`);
    return out;
}

// The names a JsProxy of the worker's global object must find nothing of (P4). Split by what
// "gone" means: the host surface and the evaluators must be ABSENT; a timer may stay only if it
// refuses a STRING argument (the indirect-eval path); WebAssembly's compiling entry points likewise.
const HOST_SURFACE = ["fetch", "XMLHttpRequest", "WebSocket", "indexedDB", "caches", "navigator",
    "postMessage", "addEventListener", "importScripts", "eval", "Function"];
const TIMER_STRING = ["setTimeout", "setInterval"];

/** A stand-in for the worker's `globalThis`, carrying the whole P4 surface so every name is checkable in Node.
 *  The timers model the BROWSER worker's semantics — `setTimeout("code")` evaluates the string — which is
 *  the indirect-eval path the strip must close. (Node's own timers throw on a string, so a bare
 *  `setTimeout` would make the positive control a no-op and the test would pass for the wrong reason.) */
function standInScope() {
    const noop = () => undefined;
    const timer = (fn, ms) => { if (typeof fn === "string") { (0, eval)(fn); return 0; } return setTimeout(fn, ms); };
    return {
        fetch: noop, XMLHttpRequest: noop, WebSocket: noop,
        indexedDB: {}, caches: {}, navigator: { sendBeacon: noop },
        postMessage: noop, addEventListener: noop, importScripts: noop,
        eval: (s) => (0, eval)(s), Function: Function,
        setTimeout: timer, setInterval: timer,
        WebAssembly: WebAssembly,
    };
}

// --- P1. a JS function constructor through an object `pyodide.ffi` hands back ----------------------
// On main: `to_js({}).constructor.constructor` is `Function`; `Function("return this")()` returns the
// worker's global object and arbitrary JS runs in it. `create_proxy`'s proxy escapes the same way.

/** The P1 chain, as a hostile cell would run it. `label` names the object `pyodide.ffi` handed back. */
const P1_CHAIN = /* python */ `
from pyodide.ffi import to_js, create_proxy
out = {}
def _try(label, obj):
    try:
        Fn = obj.constructor.constructor
        g = Fn("return this")()
        out[label] = "reached:" + type(Fn).__name__ + ":" + str(sorted(k for k in dir(g) if k in ("eval","Function","fetch","setTimeout","navigator")))
    except Exception as e:
        out[label] = "blocked:" + type(e).__name__
_try("to_js_dict", to_js({"a": 1}))
_try("to_js_list", to_js([]))
_p = create_proxy(lambda: 1)
_try("create_proxy", _p)
try: _p.destroy()
except Exception: pass
out
`;

test("P1: a hardened cell cannot reach a JS function constructor through an object pyodide.ffi hands back", { skip, todo: OPEN }, async () => {
    // Positive control: the probe detects a real escape — the same chain in FULL mode reaches `Function`.
    const open = await cell(P1_CHAIN, { hardened: false });
    assert.equal(open.error, null, `positive control should run, got: ${open.error}`);
    const reached = Object.entries(open.value).filter(([, v]) => String(v).startsWith("reached:"));
    assert.ok(reached.length >= 1, `positive control: at least one ffi object must reach Function in full mode, got ${JSON.stringify(open.value)}`);

    // Defended: nothing `pyodide.ffi` hands back yields a working JS `Function`.
    const r = await cell(P1_CHAIN, { hardened: true });
    assert.equal(r.error, null, `hardened cell should run, got: ${r.error}`);
    const escaped = Object.entries(r.value).filter(([, v]) => String(v).startsWith("reached:"));
    assert.deepEqual(escaped, [], `no ffi object may reach a JS function constructor, got ${JSON.stringify(r.value)}`);
});

// --- P2. Python the cell SCHEDULED runs after the result is returned -------------------------------
// On main: `asyncio.ensure_future` in a hardened cell runs AFTER `unharden()`, so it finds `js` and
// `fetch` restored and escapes through P1 from there. Defended: nothing a cell scheduled runs once
// its result is returned — the loop's pending handles are cancelled before the return.

test("P2: nothing a hardened cell schedules runs once its result is returned", { skip, todo: OPEN }, async () => {
    // Positive control: asyncio itself works in this interpreter — an awaited task runs.
    const alive = await (async () => {
        py.globals.set("INJECTED_IMAGE_B64", null);
        py.globals.set("INJECTED_TABLES_JSON", null);
        await py.runPythonAsync(`
import asyncio
_ran = []
async def _t():
    _ran.append("now")
await asyncio.sleep(0)
await _t()
assert _ran == ["now"], _ran
`);
        return true;
    })();
    assert.equal(alive, true, "positive control: asyncio must be alive in this Pyodide");

    // Plant a recorder in a MODULE (survives the wrapper's per-run RESET), then schedule from a
    // hardened cell and do not await. The marker is what the callback writes if it ever runs.
    await cell(`
import asyncio, types, sys
_m = types.ModuleType("_rt_p2")
_m.woke = []
sys.modules["_rt_p2"] = _m
async def _later():
    _m.woke.append("ran")
    try:
        import js
        _m.woke.append("js-open")
    except Exception as e:
        _m.woke.append("js-closed:" + type(e).__name__)
asyncio.ensure_future(_later())
"scheduled"
`, { later: 0.15 });

    const after = await cell(`
import sys
_m = sys.modules.get("_rt_p2")
{"woke": list(_m.woke) if _m else "NO MARKER"}
`);
    assert.deepEqual(after.value, { woke: [] }, `nothing the cell scheduled may run after its result returned, got ${JSON.stringify(after.value)}`);
});

// --- P3. a JsProxy in the namespace ----------------------------------------------------------------
// On main: a streaming run binds `_ml_stdout_cb` (a JS function) into the namespace, and its
// `.constructor.constructor` is `Function`. The injected JS-null inputs land as `JsNull` too.
// Defended: the namespace holds no JsProxy at all — the stdout tee is JS-side (`setStdout`).

test("P3: a hardened cell's namespace holds no JsProxy — the stdout tee is not one", { skip, todo: OPEN }, async () => {
    // Positive control: the honest path works — a print is captured AND teed to the JS callback.
    const r = await cell("print('hello-stream')\n'ok'", { hardened: true, stream: true });
    assert.equal(r.error, null, `streaming cell should run, got: ${r.error}`);
    assert.match(r.stdout, /hello-stream/, "stdout must still be captured byte-exact");
    assert.ok(r.chunks.some((c) => /hello-stream/.test(c)), `the JS tee must see the print, got chunks ${JSON.stringify(r.chunks)}`);

    // Defended: scanning the namespace from INSIDE the cell (what a hostile cell does) finds no JsProxy.
    const s = await cell(`
found = []
for _k, _v in list(globals().items()):
    try:
        if type(_v).__name__.startswith("Js") or getattr(type(_v), "__module__", "") == "pyodide.ffi":
            found.append(_k + ":" + type(_v).__name__)
    except Exception:
        pass
{"found": found}
`, { hardened: true, stream: true });
    assert.equal(s.error, null, `scan cell should run, got: ${s.error}`);
    assert.deepEqual(s.value.found, [], `the namespace must hold no JsProxy, got ${JSON.stringify(s.value.found)}`);
});

// --- P4. the host surface through a JsProxy of the worker's global object --------------------------
// Two probes, one property. (a) the REAL global, obtained by the P1 route; (b) a stand-in scope that
// carries every name (Node's own global lacks indexedDB/caches/postMessage/addEventListener, so a
// stand-in is how the whole list is checkable here) passed to `lockdownReadonly(py, scope)`.

/** From inside the cell: which of `names` are present and live on the object bound as `_probe`. */
const P4_PROBE = /* python */ `
_names = ${JSON.stringify(HOST_SURFACE.concat(TIMER_STRING))}
_o = _probe
present = {}
for _n in _names:
    try:
        present[_n] = getattr(_o, _n) is not None
    except Exception:
        present[_n] = False
timers = {}
for _n in ${JSON.stringify(TIMER_STRING)}:
    try:
        _f = getattr(_o, _n)
        _f("globalThis.__rt_eval_hit = 1", 0)
        timers[_n] = "string-accepted"
    except Exception as e:
        timers[_n] = "refused:" + type(e).__name__
{"present": present, "timers": timers}
`;

test("P4: a JsProxy of the worker's global object finds nothing of the host surface", { skip, todo: OPEN }, async () => {
    // Positive control: the probe sees the surface where it is still there — the stand-in BEFORE any
    // strip. This also proves getattr/timer probing works in this interpreter.
    const scope = standInScope();
    py.globals.set("_probe", scope);
    const before = await cell(P4_PROBE, { hardened: true });
    py.globals.delete("_probe");
    assert.equal(before.error, null, `probe cell should run, got: ${before.error}`);
    assert.equal(before.value.present.fetch, true, `positive control: the stand-in must expose fetch, got ${JSON.stringify(before.value.present)}`);
    assert.equal(before.value.timers.setTimeout, "string-accepted", `positive control: the stand-in's setTimeout must accept a string, got ${JSON.stringify(before.value.timers)}`);

    // (a) The real globalThis, obtained by the P1 route — the surface must be gone from it.
    const real = await cell(`
from pyodide.ffi import to_js
_g = to_js({"a": 1}).constructor.constructor("return this")()
_names = ${JSON.stringify(HOST_SURFACE.concat(TIMER_STRING))}
present = {}
for _n in _names:
    try:
        present[_n] = getattr(_g, _n) is not None
    except Exception:
        present[_n] = False
{"present": present}
`, { hardened: true });
    assert.equal(real.error, null, `global probe should run, got: ${real.error}`);
    const liveOnGlobal = Object.entries(real.value.present).filter(([, v]) => v === true).map(([k]) => k);
    assert.deepEqual(liveOnGlobal, [], `nothing of the host surface may be live on the worker's global, got ${JSON.stringify(real.value.present)}`);

    // (b) The stand-in, after the defence's boot hook. Absent on main → the surface is still there.
    if (typeof lockdownReadonly === "function") lockdownReadonly(py, scope);
    py.globals.set("_probe", scope);
    const after = await cell(P4_PROBE, { hardened: true });
    py.globals.delete("_probe");
    assert.equal(after.error, null, `probe cell should run, got: ${after.error}`);
    const stillThere = Object.entries(after.value.present).filter(([, v]) => v === true).map(([k]) => k);
    assert.deepEqual(stillThere, [], `lockdownReadonly must clear the stand-in scope, got ${JSON.stringify(after.value.present)}`);
    assert.equal(after.value.timers.setTimeout !== "string-accepted" && after.value.timers.setInterval !== "string-accepted",
        true, `a timer must refuse a string argument, got ${JSON.stringify(after.value.timers)}`);
});

// --- P5. cross-cell: nothing left that observes a later cell's code or injected tables -------------
// On main: a cell that monkeypatches `ast.parse` / `json.loads` (or `builtins.__import__`) keeps the
// patch across the per-run RESET, because the patch lives in module state and `RESET` only deletes
// non-underscore NAMESPACE names. Measured: cell 2's source and its injected table both went through
// cell 1's spies. Defended: whatever a cell leaves behind cannot see the next cell's code or tables.

test("P5: nothing a hardened cell leaves behind observes a later cell's code or injected tables", { skip, todo: OPEN }, async () => {
    // Positive control: the spies work — each observes a call the same cell makes afterwards.
    const plant = await cell(`
import ast, json, types, sys
_m = types.ModuleType("_rt_p5")
_m.seen = []
_ast_orig = ast.parse
def _ast_spy(_src, *a, **k):
    _m.seen.append(("ast.parse", str(_src)[:120]))
    return _ast_orig(_src, *a, **k)
ast.parse = _ast_spy
_json_orig = json.loads
def _json_spy(_s, *a, **k):
    _m.seen.append(("json.loads", str(_s)[:120]))
    return _json_orig(_s, *a, **k)
json.loads = _json_spy
sys.modules["_rt_p5"] = _m
ast.parse("PROBE_CELL1_OWN_CODE")
json.loads("[1]")
{"seen": [list(x) for x in _m.seen]}
`);
    assert.equal(plant.error, null, `plant cell should run, got: ${plant.error}`);
    assert.ok(plant.value.seen.some(([k, v]) => k === "ast.parse" && v.includes("PROBE_CELL1_OWN_CODE")),
        `positive control: the ast.parse spy must see the same cell's call, got ${JSON.stringify(plant.value.seen)}`);
    assert.ok(plant.value.seen.some(([k, v]) => k === "json.loads" && v.includes("[1]")),
        `positive control: the json.loads spy must see the same cell's call, got ${JSON.stringify(plant.value.seen)}`);

    // Cell 2: distinct code AND an injected table, both of which must stay invisible to cell 1.
    const secret = [{ name: "t_secret", data: { kind: "rows", columns: ["c"], rows: [["LEAKME_TABLE"]] } }];
    const second = await cell(`
import sys
marker = "CELL2_SECRET_SOURCE"
_m = sys.modules.get("_rt_p5")
{"seen": [list(x) for x in _m.seen] if _m else "NO MARKER"}
`, { tables: secret });
    assert.equal(second.error, null, `second cell should run, got: ${second.error}`);

    const leakedCode = second.value.seen.filter(([, v]) => /CELL2_SECRET_SOURCE/.test(v));
    assert.deepEqual(leakedCode, [], `a prior cell must not observe a later cell's code, got ${JSON.stringify(second.value.seen)}`);
    const leakedTable = second.value.seen.filter(([, v]) => /LEAKME_TABLE/.test(v));
    assert.deepEqual(leakedTable, [], `a prior cell must not observe a later cell's injected tables, got ${JSON.stringify(second.value.seen)}`);
});
