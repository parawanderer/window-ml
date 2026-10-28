// python-lockdown.test.mjs — the readonly Python worker's BOOT itself: that `lockdownReadonly` leaves the realm frozen, and that a
// cell cannot reach the Pyodide API (`pyodide_js`, its `_api` and `_module`). docs/plan/repl/PYODIDE_LOCKDOWN.md step 2 (the
// DEFECT: our accessor made `lockdown()` throw, swallowed) and step 4 (the GAP: `import pyodide_js`).
//
// Real Pyodide in Node (`dist/pyodide/`, self-SKIPS without it), booted in the readonly worker's order: packages, their
// `prepare`, `lockdownReadonly`, then cells through `wrapUserCode`. Its own file because `lockdown()` is once per realm and
// this file's assertions are about that one lockdown; the escape vectors live in redteam-python-sandbox.test.mjs. Its cells run
// with the bridge refusal lifted (the probes read `js` and `pyodide.ffi`), so what they assert holds even for a cell approved
// to reach the browser's JavaScript; the refusal itself is python-bridge-gate.test.mjs.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, injectInputs } from "../src/python/python-runtime.ts";
import { lockdownReadonly, realmLocked } from "../src/python/lockdown.ts";
import { PY_PACKAGE_LOADS, PY_STARTUP_PREPARE } from "../src/python/python-env.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let py = null;
/** The harness module `lockdownReadonly` captured at boot; re-bound into every cell by `injectInputs`. */
let harness = null;
/** The bridge lift `lockdownReadonly` returned. */
let bridges = null;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    py.setStdout({ batched: () => {} });
    py.setStderr({ batched: () => {} });
    await py.loadPackage(PY_PACKAGE_LOADS);
    if (PY_STARTUP_PREPARE) py.runPython(PY_STARTUP_PREPARE);
    ({ harness = null, bridges } = await lockdownReadonly(py, {}));
}, { timeout: 180000 });

/** Run harness-side Python with the bridge refusal lifted (the probes below read `pyodide.ffi` and the import hook). */
function lifted(fn) {
    bridges(true);
    try { return fn(); } finally { bridges(false); }
}

/** Run one cell the way a hardened `python_exec` does, with the bridge refusal lifted; `{ error, value }` as the wrapper reports them. */
async function cell(code) {
    injectInputs(py.globals, null, null, harness);
    bridges(true);
    try { await py.runPythonAsync(wrapUserCode(code, true)); } finally { bridges(false); }
    const err = py.globals.get("_err");
    const jr = py.globals.get("_json_result");
    let value;
    try { value = JSON.parse(jr); } catch { value = jr === undefined ? null : String(jr); }
    return { error: err ? String(err) : null, value };
}

// --- step 2. the realm is frozen, and Pyodide still converts every kind of object -------------------------------------
// On main our accessor on `Object.prototype.constructor` made ses refuse the realm ("Accessor not expected"), the throw
// was swallowed, and nothing was frozen. `overrideTaming: "severe"` is ses's own answer to the assignment Pyodide's
// `getPyProxyClass` makes (`n.constructor = ...` on a plain object, #735).

test("step2: after boot the realm is frozen and the lockdown latch is set", { skip }, () => {
    assert.ok(Object.isFrozen(Object.prototype), "Object.prototype must be frozen after lockdownReadonly");
    assert.ok(Object.isFrozen(Promise.prototype), "Promise.prototype must be frozen after lockdownReadonly");
    assert.ok(Object.isFrozen(Function.prototype), "Function.prototype must be frozen after lockdownReadonly");
    assert.equal(realmLocked(), true, "the latch must be set once lockdown() has frozen the realm");
});

test("step2: assigning Object.prototype.constructor is refused, from JS and from a cell, while an ordinary object's still works", { skip }, async () => {
    let wrote = false;
    try {
        assert.throws(() => { "use strict"; Object.prototype.constructor = Function; }, TypeError);
    } finally {
        // In an unfrozen realm the write lands and breaks every later conversion: put it back, so only THIS test fails.
        if (Object.prototype.constructor !== Object) { wrote = true; Object.prototype.constructor = Object; }
    }
    assert.equal(wrote, false, "Object.prototype.constructor was reassigned from JS");
    const r = await cell(`from js import Object
out = {}
try:
    Object.prototype.constructor = Object.prototype.toString
    out["proto"] = "assigned"
except Exception as e:
    out["proto"] = "refused:" + type(e).__name__
o = Object.new()
o.constructor = 7
out["own"] = o.constructor
out`);
    assert.equal(r.error, null, `the cell must run, got ${r.error}`);
    assert.match(String(r.value?.proto), /^refused:/, `a cell must not reassign Object.prototype.constructor, got ${JSON.stringify(r.value)}`);
    assert.equal(r.value?.own, 7, "the control: an ordinary object's constructor is still assignable (an own property, ses's override setter)");
    assert.equal(Object.prototype.constructor, Object, "Object.prototype.constructor must be unchanged after the cell");
});

// Each kind makes JS take a PyProxy of a class flag set no warm-up made. Measured 2026-10-23: a freeze WITHOUT the override
// taming throws "Cannot assign to read only property 'constructor'" on 6 of these 14 (tuple, set, generator, ndarray,
// iterator, memoryview); main's boot threw on none only because it left the realm unfrozen. The table and DataFrame
// cells pass under either freeze, so this list, not a table cell, is #735's test.
const PYPROXY_KINDS = {
    list: "[1, 2]", dict: "{'a': 1}", tuple: "(1, 2)", set: "{1, 2}", func: "lambda x: x", generator: "(i for i in range(2))",
    coroutine: "__import__('asyncio').sleep(0)", ndarray: "__import__('numpy').arange(4)", cls: "type('K', (), {})",
    iterator: "iter([1])", dataframe: "__import__('pandas').DataFrame({'a': [1]})", memoryview: "memoryview(b'ab')",
    module: "__import__('json')", object: "object()",
};

test("step2 (#735): JS takes a PyProxy of every kind after boot", { skip }, () => {
    const failed = {};
    for (const [kind, src] of Object.entries(PYPROXY_KINDS)) {
        try {
            const v = py.runPython(src);
            if (!v || (typeof v !== "object" && typeof v !== "function")) failed[kind] = `not a PyProxy: ${typeof v}`;
            try { v?.destroy?.(); } catch { /* already gone */ }
        } catch (e) { failed[kind] = String(e?.message || e).slice(0, 120); }
    }
    assert.deepEqual(failed, {}, `every PyProxy kind must convert in the frozen realm, got ${JSON.stringify(failed)}`);
});

// --- step 4. pyodide_js, _api and _module are out of a cell's reach -----------------------------------------------------
// `import pyodide_js` reached `_api` (`runPythonInternal`, `rawRun`, `scheduleCallback`) and `_module` (`ccall`, `HEAP`,
// `PyProxy_getAttrsQuiet`, which un-revokes a proxy through `.shared.ptr`). The dialect refuses these imports unasked, so
// this was an APPROVED cell's escape. The name stays registered as a stand-in carrying only `_api.config`, which
// `webloop.run_until_complete` and the patched `asyncio.run` import at call time.

/**
 * Every live Python object the walk can reach that is a JsProxy of one of `targets` (JS objects): every gc-tracked object,
 * each one's referents (a JsProxy is not tracked itself), and every module's dict. Returns the labels found.
 */
function jsProxiesOf(targets) {
    const walk = lifted(() => py.runPython(`
import gc, sys
from pyodide.ffi import JsProxy
def _rt_walk():
    seen = set(); found = []
    def visit(o):
        if id(o) not in seen:
            seen.add(id(o))
            if isinstance(o, JsProxy): found.append(o)
    for o in gc.get_objects():
        visit(o)
        for r in gc.get_referents(o): visit(r)
    for m in list(sys.modules.values()):
        for v in list(getattr(m, "__dict__", {}).values()): visit(v)
    return found
_rt_walk`));
    const found = walk();
    const hits = [];
    for (let i = 0; i < found.length; i++) {
        const o = found.get(i);
        for (const [label, t] of targets) if (o === t) hits.push(label);
    }
    found.destroy();
    walk.destroy();
    return hits;
}

test("step4: no live Python object holds a JsProxy of the Pyodide API, _api or _module", { skip }, async () => {
    // Control: the walk finds a JS object a cell imported and kept.
    const marker = { marker: true };
    py.registerJsModule("_rt_walk_marker", marker);
    await cell("import _rt_walk_marker, sys\nsys.modules['_rt_walk_marker_kept'] = _rt_walk_marker\nNone");
    assert.deepEqual(jsProxiesOf([["marker", marker]]), ["marker"], "the control: the walk must find a JsProxy a cell kept");
    py.unregisterJsModule("_rt_walk_marker");
    py.runPython("import sys\nsys.modules.pop('_rt_walk_marker_kept', None)\nsys.modules.pop('_rt_walk_marker', None)");

    // A cell that imports the name and keeps it, so the walk would see whatever it got.
    await cell("import pyodide_js, sys\nsys.modules['_rt_kept_pjs'] = pyodide_js\nNone");
    const hits = jsProxiesOf([["API", py], ["_api", py._api], ["_module", py._module]]);
    py.runPython("import sys\nsys.modules.pop('_rt_kept_pjs', None)");
    assert.deepEqual(hits, [], `nothing in Python may hold the API, got ${JSON.stringify(hits)}`);
});

test("step4: import pyodide_js gives a stand-in with _api.config alone, and a pop brings the stand-in back", { skip }, async () => {
    const r = await cell(`import sys
import pyodide_js
out = {"api": sorted(k for k in pyodide_js._api.object_keys()), "module": hasattr(pyodide_js, "_module")}
try:
    from pyodide_js._api import runPythonInternal
    out["runPythonInternal"] = "reached"
except ImportError:
    out["runPythonInternal"] = "ImportError"
for k in [k for k in sys.modules if k == "pyodide_js" or k.startswith("pyodide_js.")]:
    del sys.modules[k]
import pyodide_js as again
out["again"] = sorted(k for k in again._api.object_keys())
out`);
    assert.equal(r.error, null, `the cell must run, got ${r.error}`);
    assert.deepEqual(r.value, { api: ["config"], module: false, runPythonInternal: "ImportError", again: ["config"] });
});

test("step4: the import hook registers no JsProxy of the API; asyncio.run and run_until_complete still work on the API's own flag, also after a pop", { skip }, async () => {
    const r = await cell(`import sys, asyncio
import _pyodide._importhook as h
out = {"hook": sorted(h.jsfinder.jsproxies.keys())}
async def f():
    await asyncio.sleep(0)
    return 7
out["run"] = asyncio.run(f())
sys.modules.pop("pyodide_js", None); sys.modules.pop("pyodide_js._api", None)
out["run_after_pop"] = asyncio.run(f())
import pyodide_js
out["flag"] = bool(pyodide_js._api.config.enableRunUntilComplete)
x = asyncio.get_event_loop().run_until_complete(f())
out["ruc"] = "scheduled" if asyncio.isfuture(x) else x
out`);
    assert.equal(r.error, null, `the cell must run, got ${r.error}`);
    // The stand-in's flag is the real one, and run_until_complete took the branch it names: a result when set, a
    // scheduled task when not. A wrong flag would still pass asyncio.run, through the native path.
    const flag = !!py._api.config.enableRunUntilComplete;
    // `js` is not registered: the bridge gate unregisters it, so a cell that pops the guard cannot import the real one back.
    assert.deepEqual(r.value, { hook: ["pyodide_js"], run: 7, run_after_pop: 7, flag, ruc: flag ? 7 : "scheduled" });
    const registered = lifted(() => py.runPython("import _pyodide._importhook as h\nh.jsfinder.jsproxies['pyodide_js']"));
    assert.ok(registered !== py && registered !== py._api && registered !== py._module, "the import hook must hand out the stand-in, never the API");
    assert.deepEqual(Object.keys(registered._api), ["config"]);
    assert.equal(registered._api.config.enableRunUntilComplete, flag, "the stand-in must carry the API's own flag");
});

// --- step 3. the strip walks the scope's prototype chain ---------------------------------------------------------------
// A worker's host surface is not own properties of `self`: `location`, `navigator`, `crypto`, `postMessage` and the `on*`
// handlers are accessors and methods on `WorkerGlobalScope.prototype` and up. The own-name strip left `js.globalThis.location`
// readable in the built extension (a WorkerLocation naming the worker's chrome-extension URL). The stand-in has that shape: a
// scope over two prototypes of accessors and methods, one of them not configurable. Last in the file: a second boot.

test("step3: the strip removes prototype-chain accessors and methods outside ALLOWED_GLOBALS, and shadows one it cannot delete", { skip }, async () => {
    const accessor = (v) => ({ get: () => v, configurable: true });
    const eventTarget = { addEventListener() {}, dispatchEvent() {} };
    const workerScope = Object.create(eventTarget, {
        location: accessor({ href: "chrome-extension://stand-in/python-worker.js" }),
        navigator: accessor({ userAgent: "stand-in" }),
        crypto: accessor({ getRandomValues: (a) => a }),
        performance: accessor({ now: () => 0 }),
        postMessage: { value() {}, configurable: true, writable: true },
        fonts: { get: () => ({ check: () => true }), configurable: false },
    });
    const scope = Object.create(workerScope);
    scope.URL = URL;
    await lockdownReadonly(py, scope);
    const host = ["location", "navigator", "postMessage", "addEventListener", "dispatchEvent", "fonts"];
    assert.deepEqual(host.filter((n) => scope[n] !== undefined), [], "the strip must leave no host accessor or method readable through the chain");
    assert.deepEqual(Object.getOwnPropertyDescriptor(scope, "fonts"), { value: undefined, writable: false, enumerable: false, configurable: false },
        "a prototype accessor the strip cannot delete must be shadowed on the scope");
    // Positive control: what ALLOWED_GLOBALS names stays, on the chain as well as on the scope.
    assert.deepEqual(["crypto", "performance", "URL"].filter((n) => scope[n] === undefined), [], "the strip must keep the allowed names");
});
