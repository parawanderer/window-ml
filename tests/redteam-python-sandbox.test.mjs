// Red-team vectors for the readonly `python_exec` sandbox, against the PYODIDE LOCKDOWN.
//
// Real Pyodide in Node (`dist/pyodide/`, self-SKIPS without it), driving the EXACT hardened path
// `python-worker.ts` runs. Each test names the PROPERTY the boundary must keep, and carries a positive
// control proving the probe works (so a broken setup cannot pass). They were written failing-first
// (`{ todo: ... }`, PR #698) and turn green here with the lockdown (`docs/plan/repl/PYODIDE_LOCKDOWN.md`).
//
// `src/python/lockdown.ts` is the defence's chrome-free entry (`lockdownReadonly(py, scope)`), and
// `src/python/python-principal.ts` is its per-principal interpreter rule. Both are imported
// dynamically so this file loads without them and the assertions still run — a missing defence leaves
// the properties open and the vectors fail again.
//
// The realm note: `lockdown()` is once per JS realm and closes the prototype-chain route P1 proves.
// So P1's positive control (which needs that route OPEN) is captured in `before()`, before any
// lockdown, and asserted by P1's test — the only way to see "reached" in a realm that gets locked.
// And a principal change gets a NEW REALM (a Worker — `tests/python-principal-worker.mjs`): a second
// Pyodide cannot boot in a realm `lockdown()` froze.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { wrapUserCode, harden, unharden, injectInputs } from "../src/python/python-runtime.ts";

/** The defence's boot hook and its allow list. Absent on main: the calls below are no-ops and the properties stay open. */
let lockdownReadonly = null;
let ALLOWED_GLOBALS = null;
try { ({ lockdownReadonly, ALLOWED_GLOBALS } = await import("../src/python/lockdown.ts")); } catch { /* defence not landed */ }
/** The defence's per-principal interpreter rule (step 1). Absent on main: every principal shares `py`. */
let interpreterForPrincipal = null;
try { ({ interpreterForPrincipal } = await import("../src/python/python-principal.ts")); } catch { /* defence not landed */ }

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

/**
 * Boot one Pyodide with the packages the prelude imports. Used for the file's main interpreter.
 */
async function loadPy() {
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    const p = await loadPyodide({ indexURL: PYODIDE_DIR });
    const withArrow = fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("pyarrow-"));
    await p.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy", ...(withArrow ? ["pyarrow"] : [])]);
    return p;
}

/** Workers spawned for principals; terminated in `after` so they cannot hold the test process open. */
const principalWorkers = new Set();

/**
 * A NEW principal's interpreter — in its own realm, as a Worker. One Worker per principal is the real
 * design, and it has to be per-realm: a second Pyodide cannot boot in a realm `lockdown()` froze (its
 * boot attaches `.sig` to the now-frozen `Math`).
 */
function spawnPrincipalRunner() {
    return new Promise((resolve, reject) => {
        const w = new Worker(new URL("./python-principal-worker.mjs", import.meta.url), {
            workerData: {
                pyodideDir: PYODIDE_DIR,
                lockdownUrl: new URL("../src/python/lockdown.ts", import.meta.url).href,
                runtimeUrl: new URL("../src/python/python-runtime.ts", import.meta.url).href,
                // The prelude imports numpy/PIL/pandas; pandas pulls pyarrow. The vectors need nothing else.
                packages: ["numpy", "pillow", "pandas", "pyarrow"],
            },
        });
        principalWorkers.add(w);
        w.once("message", (m) => {
            if (!m || !m.ready) { reject(new Error(m?.error || "principal worker failed to boot")); return; }
            resolve(makeRunner(w));
        });
        w.once("error", reject);
    });
}

/** The runner a principal worker exposes: `runCell` is that principal's hardened `python_exec`. */
function makeRunner(w) {
    let n = 0;
    w.unref();   // booted: a live worker must not hold the test process open (after() terminates it)
    return {
        kind: "principal-runner",
        runCell(code, { image = null, tables = null } = {}) {
            return new Promise((resolve) => {
                const id = ++n;
                const onMsg = (m) => {
                    if (m.id !== id) return;
                    w.off("message", onMsg);
                    resolve(m.out);
                };
                w.on("message", onMsg);
                w.postMessage({ id, code, image, tablesJson: tables == null ? null : JSON.stringify(tables) });
            });
        },
    };
}

let py = null;
/** True once `lockdownReadonly` has run on `py` — the strip IS the hardening then, and `harden()`/`unharden()` must not undo it. */
let lockedDown = false;
/** P1's positive control, captured BEFORE any `lockdown()` (see the header). */
let p1Control = null;

before(async () => {
    if (!hasPyodide) return;
    py = await loadPy();
    // The control first, while the realm is still unlocked: `lockdown()` closes the very route it proves.
    p1Control = await cellOn(py, P1_CHAIN, { hardened: false });
    if (typeof lockdownReadonly === "function") {
        await lockdownReadonly(py, {});
        lockedDown = true;
    }
}, { timeout: 180000 });

after(async () => {
    await Promise.all([...principalWorkers].map((w) => w.terminate().catch(() => {})));
    principalWorkers.clear();
});

/**
 * Run one cell the way a hardened `python_exec` does, and read the wrapper's results back.
 * Inputs go through `injectInputs` — Python `None`/`str`, never a JS null (which lands as `JsNull`,
 * a JsProxy — P3). `stream` hooks Pyodide's JS-side `setStdout`, the tee's live half. `later` is the
 * harness's "a later await": a raw `runPythonAsync` that pumps the event loop AFTER the cell's result
 * has been returned (not the wrapper — it is not a cell).
 */
async function cellOn(interp, code, { hardened = true, stream = false, tables = null, image = null, later = 0 } = {}) {
    injectInputs(interp.globals, image, tables == null ? null : JSON.stringify(tables));
    if (stream) {
        try { interp.setStdout({ batched: (s) => { (cellOn.chunks ??= []).push(s); } }); } catch { /* no setStdout here */ }
    }
    // Under the lockdown the strip is the hardening; `unharden()` would RESTORE what it removed.
    const saved = hardened && !lockedDown ? harden(interp) : null;
    try {
        await interp.runPythonAsync(wrapUserCode(code, hardened));
    } finally {
        if (saved) unharden(interp, saved);
        if (stream) { try { interp.setStdout({}); } catch { /* */ } }
    }
    const out = {
        stdout: String(interp.globals.get("_stdout") ?? ""),
        error: interp.globals.get("_err") ? String(interp.globals.get("_err")) : null,
        chunks: cellOn.chunks ?? [],
        jsProxies: null,
    };
    cellOn.chunks = null;
    const jr = interp.globals.get("_json_result");
    try { out.value = JSON.parse(jr); } catch { out.value = jr === undefined ? null : String(jr); }
    if (later) await interp.runPythonAsync(`import asyncio\nawait asyncio.sleep(${later})`);
    return out;
}

/** The file's main interpreter (`py`) — the principal this file booted. */
async function cell(code, opts) { return cellOn(py, code, opts); }

/**
 * Run one cell for `principal`. With the defence's step 1 each principal gets its own interpreter
 * (its own Worker — its own realm); without it every principal shares `py`, which is exactly why
 * P5-cross fails first.
 */
async function runFor(principal, code, opts) {
    const interp = typeof interpreterForPrincipal === "function"
        ? await interpreterForPrincipal(principal, spawnPrincipalRunner)
        : py;
    return interp && interp.kind === "principal-runner" ? interp.runCell(code, opts) : cellOn(interp, code, opts);
}

// The names a JsProxy of the worker's global object must find nothing of (P4). Split by what
// "gone" means: the host surface and the evaluators must be ABSENT; a timer may stay only if it
// refuses a STRING argument (the indirect-eval path).
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
// Closed by `lockdown()`: the prototype-chain constructors throw afterwards.

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

test("P1: a hardened cell cannot reach a JS function constructor through an object pyodide.ffi hands back", { skip }, async () => {
    // Positive control, captured in before() while the realm was still unlocked: the probe detects a
    // real escape — the same chain reached `Function` before `lockdown()` ran. (After lockdown the
    // chain throws in EVERY mode, so an in-test `hardened: false` control could not show "reached".)
    assert.equal(p1Control.error, null, `positive control should run, got: ${p1Control.error}`);
    const reached = Object.entries(p1Control.value).filter(([, v]) => String(v).startsWith("reached:"));
    assert.ok(reached.length >= 1, `positive control: at least one ffi object must reach Function pre-lockdown, got ${JSON.stringify(p1Control.value)}`);

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

test("P2: nothing a hardened cell schedules runs once its result is returned", { skip }, async () => {
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

test("P3: a hardened cell's namespace holds no JsProxy — the stdout tee is not one", { skip }, async () => {
    // Positive control: the honest path works — a print is captured AND teed to the JS side.
    const r = await cell("print('hello-stream')\n'ok'", { hardened: true, stream: true });
    assert.equal(r.error, null, `streaming cell should run, got: ${r.error}`);
    assert.match(r.stdout, /hello-stream/, "stdout must still be captured byte-exact");
    assert.ok(r.chunks.some((c) => /hello-stream/.test(c)), `the JS side must see the print, got chunks ${JSON.stringify(r.chunks)}`);

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
// Two probes, one property. (a) the REAL global, obtained by the P1 route — ruled: "the route is
// blocked" is a pass, since an unreachable surface is the stronger property; the surface assertion
// itself runs from the HARNESS side (the step-3 enumeration below), never through an attacker route.
// (b) a stand-in scope carrying every name, passed to `lockdownReadonly(py, scope)`: the strip's
// direct check.

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

test("P4: a JsProxy of the worker's global object finds nothing of the host surface", { skip }, async () => {
    // Positive control: the probe sees the surface where it is still there — the stand-in BEFORE any
    // strip. This also proves getattr/timer probing works in this interpreter.
    const scope = standInScope();
    py.globals.set("_probe", scope);
    const beforeStrip = await cell(P4_PROBE, { hardened: true });
    py.globals.delete("_probe");
    assert.equal(beforeStrip.error, null, `probe cell should run, got: ${beforeStrip.error}`);
    assert.equal(beforeStrip.value.present.fetch, true, `positive control: the stand-in must expose fetch, got ${JSON.stringify(beforeStrip.value.present)}`);
    assert.equal(beforeStrip.value.timers.setTimeout, "string-accepted", `positive control: the stand-in's setTimeout must accept a string, got ${JSON.stringify(beforeStrip.value.timers)}`);

    // (a) The real globalThis, obtained by the P1 route. Ruled: accept "the route is blocked" as a
    // pass — an unreachable surface is the stronger property. Only if the route WORKS does the
    // surface have to be gone from it (and on main it is not, which is the open property).
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
    if (real.error === null) {
        const liveOnGlobal = Object.entries(real.value.present).filter(([, v]) => v === true).map(([k]) => k);
        assert.deepEqual(liveOnGlobal, [], `nothing of the host surface may be live on the worker's global, got ${JSON.stringify(real.value.present)}`);
    }

    // (b) The stand-in, after the defence's boot hook. Absent on main → the surface is still there.
    if (typeof lockdownReadonly === "function") await lockdownReadonly(py, scope);
    py.globals.set("_probe", scope);
    const afterStrip = await cell(P4_PROBE, { hardened: true });
    py.globals.delete("_probe");
    assert.equal(afterStrip.error, null, `probe cell should run, got: ${afterStrip.error}`);
    // The host surface must be GONE. The timers are kept (as string-refusing wrappers) — they are checked below.
    const stillThere = HOST_SURFACE.filter((n) => afterStrip.value.present[n] === true);
    assert.deepEqual(stillThere, [], `lockdownReadonly must clear the stand-in scope of the host surface, got ${JSON.stringify(afterStrip.value.present)}`);
    assert.equal(afterStrip.value.timers.setTimeout !== "string-accepted" && afterStrip.value.timers.setInterval !== "string-accepted",
        true, `a timer must refuse a string argument, got ${JSON.stringify(afterStrip.value.timers)}`);
});

// --- step 3. the allow-list strip leaves nothing outside ALLOWED_GLOBALS ----------------------------
// The HARNESS-side check of the strip, never through an attacker route: trusted code enumerates the
// stripped scope's own names against the committed allow list. The scope is a copy of Node's
// `globalThis` names (the strip's work is about names; the values are dummies) so the whole list is
// checkable here without stripping Node's real globals and breaking the test process.

test("step3: after the strip the scope's own names are inside ALLOWED_GLOBALS", { skip }, async () => {
    if (typeof lockdownReadonly !== "function" || !ALLOWED_GLOBALS) {
        assert.fail("the defence's lockdownReadonly and ALLOWED_GLOBALS must exist for this test to mean anything");
    }
    const scope = {};
    for (const n of Object.getOwnPropertyNames(globalThis)) scope[n] = undefined;
    // The timers again model the browser worker's string-eval semantics, so the wrapper is in play.
    const timer = (fn, ms) => { if (typeof fn === "string") { (0, eval)(fn); return 0; } return setTimeout(fn, ms); };
    scope.setTimeout = timer; scope.setInterval = timer;
    await lockdownReadonly(py, scope);
    const outside = Object.getOwnPropertyNames(scope).filter((n) => !ALLOWED_GLOBALS.includes(n));
    assert.deepEqual(outside, [], `the strip must leave nothing outside ALLOWED_GLOBALS, got ${JSON.stringify(outside)}`);
});

// --- P5-intra. the harness's own reporting is unaffected by a patched json.loads -------------------
// On main: a cell that monkeypatches `ast.parse` / `json.loads` keeps the patch across the per-run
// RESET (it lives in module state), so the NEXT cell's source and its injected table both go through
// the first cell's spies — the harness parses with the same importable functions. Closed by step 6:
// the wrapper's parse, result encoding and table injection use the harness's captured references
// (`_ml_harness`, frozen at boot), never the importable ones. The next cell's OWN call still sees
// the patch — that is intra-principal and not the harness's business.

test("P5-intra: the harness's own reporting is unaffected by a patched json.loads, though the next cell's own call sees it", { skip }, async () => {
    // Positive control: the spies work — each observes a call the same cell makes afterwards.
    const plant = await cell(`
import ast, json, types, sys
_m = types.ModuleType("_rt_p5i")
_m.seen = []
_ast_orig = ast.parse
def _ast_spy(_src, *a, **k):
    _m.seen.append(("ast.parse", str(_src)))
    return _ast_orig(_src, *a, **k)
ast.parse = _ast_spy
_json_orig = json.loads
def _json_spy(_s, *a, **k):
    _m.seen.append(("json.loads", str(_s)))
    return _json_orig(_s, *a, **k)
json.loads = _json_spy
sys.modules["_rt_p5i"] = _m
ast.parse("PROBE_CELL1_OWN_CODE")
json.loads("[1]")
{"seen": [list(x) for x in _m.seen]}
`);
    assert.equal(plant.error, null, `plant cell should run, got: ${plant.error}`);
    assert.ok(plant.value.seen.some(([k, v]) => k === "ast.parse" && v.includes("PROBE_CELL1_OWN_CODE")),
        `positive control: the ast.parse spy must see the same cell's call, got ${JSON.stringify(plant.value.seen)}`);
    assert.ok(plant.value.seen.some(([k, v]) => k === "json.loads" && v.includes("[1]")),
        `positive control: the json.loads spy must see the same cell's call, got ${JSON.stringify(plant.value.seen)}`);

    // Cell 2: distinct code AND an injected table, both of which the HARNESS handles, plus two calls
    // the cell makes itself (which must see the patch — intra-principal).
    const secret = [{ name: "t_secret", data: { kind: "rows", columns: ["c"], rows: [["LEAKME_TABLE"]] } }];
    const second = await cell(`
import ast, json, sys
marker = "CELL2_SECRET_SOURCE"
json.loads('["CELL2_OWN_CALL"]')
ast.parse("CELL2_OWN_AST")
_m = sys.modules.get("_rt_p5i")
{"seen": [list(x) for x in _m.seen] if _m else "NO MARKER"}
`, { tables: secret });
    assert.equal(second.error, null, `second cell should run, got: ${second.error}`);
    const seen = second.value.seen;

    // The harness's own work must not have gone through cell 1's spies.
    assert.deepEqual(seen.filter(([, v]) => /LEAKME_TABLE/.test(v)), [],
        `a prior cell must not observe a later cell's injected tables, got ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.filter(([, v]) => /CELL2_SECRET_SOURCE/.test(v)), [],
        `a prior cell must not observe a later cell's code, got ${JSON.stringify(seen)}`);

    // Positive control: the cell's OWN calls still see the patch, so the two asserts above are not a
    // spy that simply died. (This is the intra-principal half — the cell sees what it sees.)
    assert.ok(seen.some(([k, v]) => k === "json.loads" && v.includes("CELL2_OWN_CALL")),
        `the cell's own json.loads call must still see the patch, got ${JSON.stringify(seen)}`);
    assert.ok(seen.some(([k, v]) => k === "ast.parse" && v.includes("CELL2_OWN_AST")),
        `the cell's own ast.parse call must still see the patch, got ${JSON.stringify(seen)}`);
});

// --- P5-cross. a patched function is not visible after the principal changes -----------------------
// On main: one interpreter serves every principal (harden/unharden only swaps a deny list), so a
// patch one principal left in module state is still there for the next. Closed by step 1: one
// interpreter per principal, never shared — a principal change is a new interpreter.

test("P5-cross: a patched function is not visible after the principal changes", { skip }, async () => {
    // Plant the patch under the principal this file's interpreter is.
    const plant = await cell(`
import json, types, sys
_m = types.ModuleType("_rt_p5c")
_m.seen = []
_orig = json.loads
def _spy(_s, *a, **k):
    _m.seen.append(str(_s))
    return _orig(_s, *a, **k)
json.loads = _spy
sys.modules["_rt_p5c"] = _m
json.loads("[1]")
{"seen": list(_m.seen)}
`);
    assert.equal(plant.error, null, `plant cell should run, got: ${plant.error}`);
    assert.deepEqual(plant.value.seen, ["[1]"], `positive control: the spy must see the same cell's call, got ${JSON.stringify(plant.value.seen)}`);

    // A DIFFERENT principal: its own cell must not see the patch or the planter's module state.
    // `runFor` gives it its own interpreter (its own Worker — its own realm) under the defence; without
    // the defence every principal shares `py`, which is exactly why this fails first.
    const probe = await runFor("other-page", `
import json, sys
_m = sys.modules.get("_rt_p5c")
json.loads('["PROBE_OTHER"]')
{"marker": _m is not None, "seen": list(_m.seen) if _m else None, "is_spy": getattr(json.loads, "__name__", "") == "_spy"}
`);
    assert.equal(probe.error, null, `probe cell should run, got: ${probe.error}`);
    assert.equal(probe.value.marker, false,
        `the other principal must not see the planting principal's module state, got ${JSON.stringify(probe.value)}`);
    assert.equal(probe.value.is_spy, false,
        `the other principal must not see the patched json.loads, got ${JSON.stringify(probe.value)}`);

    // Positive control: the planting principal's own later cell DOES still see the patch — so the
    // probe above is not reading a spy that simply died.
    const again = await cell(`
import json, sys
_m = sys.modules.get("_rt_p5c")
json.loads("[2]")
{"seen": list(_m.seen) if _m else "NO MARKER"}
`);
    assert.equal(again.error, null, `later cell should run, got: ${again.error}`);
    assert.deepEqual(again.value.seen, ["[1]", "[2]"],
        `the planting principal's own later cell must still see the patch, got ${JSON.stringify(again.value)}`);
});
