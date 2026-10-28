// python-bridge-gate.test.mjs — an approved cell in the readonly worker cannot import the modules that reach the browser's
// JavaScript (`js`, `pyodide.ffi` and the modules holding its functions, `pyodide.webloop`), by any import route, while
// packages that use them keep working and the lift lets exactly one cell through. Ruled 2026-10-27, PYODIDE_LOCKDOWN.md
// step 2; lockdown.ts `REFUSED_BRIDGES` and `BRIDGE_GATE`.
//
// Real Pyodide in Node (`dist/pyodide/`, self-SKIPS without it), booted in the readonly worker's order: packages, their
// `prepare` (pyarrow's `unix_timezones` imports `js` there), `lockdownReadonly`, then cells through `wrapUserCode`. Its own
// file because `lockdown()` is once per realm. What the gate does NOT claim (introspection: a library function's
// `__globals__`, `gc`, the guard's closure) is written in lockdown.ts and is not asserted here either way.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, injectInputs } from "../src/python/python-runtime.ts";
import { lockdownReadonly } from "../src/python/lockdown.ts";
import { REFUSED_BRIDGES, JS_BRIDGE_LINE, JS_BRIDGE_KEPT_LINE, jsBridgeLine, namesJsBridge } from "../src/python/bridge-names.js";
import { pythonOutsideWhy } from "../src/agent/python-dialect.ts";
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
    // A module that imported the bridges before the boot and kept them as globals, as `unix_timezones` does with `js` (its
    // `prepare` pops that one by name, python-env.ts); the gate must sweep any such module, not only the one it knows.
    py.runPython(`import sys, types, js, pyodide.ffi
_m = types.ModuleType("_rt_early_holder")
_m.js = js
_m.ffi = pyodide.ffi
sys.modules["_rt_early_holder"] = _m
del _m`);
    ({ harness = null, bridges } = await lockdownReadonly(py, {}));
}, { timeout: 180000 });

/** Run one approved cell the way the readonly worker does; `lift` runs it with the refusal lifted. `{ error, value }`. */
async function cell(code, { lift = false } = {}) {
    injectInputs(py.globals, null, null, harness);
    if (lift) bridges(true);
    try { await py.runPythonAsync(wrapUserCode(code, true)); } finally { if (lift) bridges(false); }
    const err = py.globals.get("_err");
    const jr = py.globals.get("_json_result");
    let value;
    try { value = JSON.parse(jr); } catch { value = jr === undefined ? null : String(jr); }
    return { error: err ? String(err) : null, value };
}

const REFUSED = /is refused in python_exec: a cell may not reach the browser's JavaScript/;

// --- every import route is refused ------------------------------------------------------------------------------------
// The gate is in the module a route hands back, never in the import statement, so an obfuscated name or another way to
// import gains nothing. Each route ends in a lookup that would reach the bridge (`.setTimeout`, `.create_proxy`).

/** Each import route a cell could write, ending in a name it needs from a bridge. */
const ROUTES = [
    ["import js", "import js\njs.setTimeout"],
    ["from js import setTimeout", "from js import setTimeout"],
    ["from js import eval", "from js import eval as e"],
    ["__import__ with a built name", "m = __import__('j' + 's')\nm.Function"],
    ["importlib.import_module", "import importlib\nimportlib.import_module('js').setTimeout"],
    ["sys.modules", "import sys\nsys.modules['js'].setTimeout"],
    ["exec of a string", "exec('import js\\njs.setTimeout')"],
    ["a function the cell defines", "def f():\n    import js\n    return js.setTimeout\nf()"],
    ["import pyodide.ffi", "import pyodide.ffi\npyodide.ffi.create_proxy"],
    ["from pyodide.ffi import create_proxy", "from pyodide.ffi import create_proxy"],
    ["from pyodide.ffi import to_js", "from pyodide.ffi import to_js"],
    ["pyodide.ffi.wrappers", "from pyodide.ffi.wrappers import set_timeout"],
    ["pyodide.webloop", "import pyodide.webloop as w\nw.scheduleCallback"],
    ["_pyodide_core, under pyodide.ffi", "import _pyodide_core\n_pyodide_core.create_once_callable"],
    ["_pyodide._importhook", "from _pyodide._importhook import register_js_module"],
    ["_pyodide._core_docs", "from _pyodide._core_docs import JsProxy"],
    ["pyodide._package_loader", "import pyodide._package_loader as pl\npl.to_js"],
    ["a library function that imports js when called (run_js)", "from pyodide.code import run_js\nrun_js('1+1')"],
    ["an asyncio task the cell awaits", "import asyncio\nasync def t():\n    import js\n    return js.setTimeout\nawait asyncio.create_task(t())"],
];

for (const [label, body] of ROUTES) {
    test(`an approved cell cannot reach a bridge by ${label}`, { skip }, async () => {
        const r = await cell(`${body}\nNone`);
        assert.match(String(r.error), REFUSED, `${label} must be refused by the gate, got ${r.error}`);
        // Positive control: the same cell under the lift reaches it, so the refusal is the gate and not a broken route.
        const lifted = await cell(`${body}\nNone`, { lift: true });
        assert.equal(lifted.error, null, `control: ${label} works under the lift, got ${lifted.error}`);
    });
}

test("the gate covers every module in REFUSED_BRIDGES, and each name in sys.modules is its guard", { skip }, async () => {
    const r = await cell(`import sys
{n: type(sys.modules.get(n)).__name__ for n in ${JSON.stringify(REFUSED_BRIDGES)}}`);
    assert.equal(r.error, null, r.error);
    assert.deepEqual(r.value, Object.fromEntries(REFUSED_BRIDGES.map((n) => [n, "_MlBridgeGuard"])));
});

// --- the guard cannot be taken out by the import system ---------------------------------------------------------------

test("popping the guard from sys.modules and importing again hands back the guard", { skip }, async () => {
    const r = await cell(`import sys
for n in ["js", "pyodide.ffi", "pyodide.webloop", "_pyodide_core"]:
    sys.modules.pop(n, None)
import js, pyodide.ffi, pyodide.webloop, _pyodide_core
[type(m).__name__ for m in (js, pyodide.ffi, pyodide.webloop, _pyodide_core)]`);
    assert.equal(r.error, null, r.error);
    assert.deepEqual(r.value, ["_MlBridgeGuard", "_MlBridgeGuard", "_MlBridgeGuard", "_MlBridgeGuard"]);
    assert.match(String((await cell("import js\njs.setTimeout")).error), REFUSED);
});

test("importlib.reload of a guard does not load the real module into it", { skip }, async () => {
    const r = await cell(`import importlib, pyodide.ffi
importlib.reload(pyodide.ffi)
pyodide.ffi.create_proxy`);
    assert.match(String(r.error), REFUSED, `a reloaded guard must still refuse, got ${r.error}`);
});

test("js is unregistered from Pyodide's finder: with the guard and its finder gone, import js finds nothing", { skip }, async () => {
    // Restores both at the end: the tests after this one run on the same interpreter.
    const r = await cell(`import sys
guard = sys.modules.pop("js")
finders = [f for f in sys.meta_path if getattr(f, "__name__", "") == "_MlBridgeFinder"]
sys.meta_path[:] = [f for f in sys.meta_path if f not in finders]
try:
    import js
    out = type(js).__name__
except ModuleNotFoundError:
    out = "not found"
finally:
    sys.meta_path[:0] = finders
    sys.modules["js"] = guard
out`);
    assert.equal(r.error, null, r.error);
    assert.equal(r.value, "not found", "the real js must not come back through Pyodide's own finder");
});

// --- a module that imported a bridge before the gate ------------------------------------------------------------------

test("a module that kept js and pyodide.ffi as globals before the boot holds the guards after it", { skip }, async () => {
    const r = await cell(`import _rt_early_holder as h
[type(h.js).__name__, type(h.ffi).__name__]`);
    assert.equal(r.error, null, r.error);
    assert.deepEqual(r.value, ["_MlBridgeGuard", "_MlBridgeGuard"]);
    assert.match(String((await cell("import _rt_early_holder as h\nh.js.setTimeout")).error), REFUSED);
});

// --- what keeps working -----------------------------------------------------------------------------------------------

test("asyncio still works in an approved cell: sleep, a task, gather", { skip }, async () => {
    const r = await cell(`import asyncio
async def two():
    await asyncio.sleep(0.01)
    return 2
t = asyncio.create_task(two())
await asyncio.sleep(0)
(await t) + sum(await asyncio.gather(two(), two()))`);
    assert.equal(r.error, null, r.error);
    assert.equal(r.value, 6);
});

test("numpy and pandas cells run, and a package's pyodide-aware import at its own import time is answered", { skip }, async () => {
    const r = await cell(`import numpy as np, pandas as pd
df = pd.DataFrame({"a": np.arange(3)})
int(df["a"].sum())`);
    assert.equal(r.error, null, r.error);
    assert.equal(r.value, 3);
    // matplotlib's pyodide backend does \`from pyodide.ffi import create_proxy\` at its own import: library code, answered.
    const m = await cell(`import importlib
importlib.import_module("matplotlib.backends.backend_pyodide")
"imported"`);
    assert.equal(m.error, null, `a library module's import-time use of pyodide.ffi must be answered, got ${m.error}`);
});

test("a guard's dunder lookups answer like a module's, so tools that walk sys.modules do not break", { skip }, async () => {
    const r = await cell(`import inspect, sys, pickle
inspect.getmodule(len)
[getattr(sys.modules["js"], "__file__", "none"), hasattr(sys.modules["pyodide.ffi"], "__path__")]`);
    assert.equal(r.error, null, r.error);
    assert.deepEqual(r.value, ["none", false]);
});

// --- the lift is one cell's -------------------------------------------------------------------------------------------

test("the lift lets one cell through and the next cell is refused again, even one reusing the first cell's name", { skip }, async () => {
    const first = await cell("import js\nkept = js\nkept.Math.max(1, 2)", { lift: true });
    assert.equal(first.error, null, first.error);
    assert.equal(first.value, 2);
    const next = await cell("import js\njs.Math.max(1, 2)");
    assert.match(String(next.error), REFUSED, `the next cell must be refused, got ${next.error}`);
});

// --- the card line: which cells name a bridge, and the wording a person approves --------------------------------------
// Pure (no Pyodide). A cell that names a bridge gets the card's line, and only a person's approval of it lifts the refusal,
// so a false positive costs a needless warning and a false negative costs a cell that stays refused (the safe side).

test("JS_BRIDGE_LINE is the wording the product owner approved, letter for letter", () => {
    assert.equal(JS_BRIDGE_LINE, "This code reaches the browser's JavaScript from Python (`js`, `pyodide.ffi`). Approve only if you expected that.");
});

test("namesJsBridge: every way a cell writes a bridge's name is seen", () => {
    for (const code of [
        "import js", "import js\njs.setTimeout", "x = 1\nimport js as j", "import js.foo",
        "from js import x", "from js import (a,\n b)", "import os, js", "import numpy as np, js", "import os,js as j", "from js.foo import x",
        "import pyodide.ffi", "from pyodide.ffi import to_js", "from pyodide import ffi", "from pyodide import to_js, ffi",
        "from pyodide import webloop", "from pyodide import code",
        "import pyodide.webloop", "import pyodide.code", "pyodide.code.run_js('1')", "run_js('1')",
        "import _pyodide_core", "import _pyodide._importhook", "from _pyodide._core_docs import x", "import pyodide._package_loader",
    ]) assert.equal(namesJsBridge(code), true, code);
});

test("namesJsBridge: a word that merely contains a bridge's letters, or a harmless pyodide import, is not one", () => {
    for (const code of [
        "", "import json", "import jsonify", "from jsonschema import validate", "myjs = 1", "js = 1", "x.js", "'js'",
        "import pyodide", "from pyodide import something_else", "from pyodide import http", "import pyodide_http",
        "import numpy as np\nprint(np.arange(3).sum())", "import os, json", "import numpy as np, jsonschema", "from jsonschema.x import y", "df.to_json()", "import _pyodidefoo", "run_json()",
    ]) assert.equal(namesJsBridge(code), false, code);
});

// --- a later cell of a run whose earlier cell was lifted: what that cell kept is still reachable ----------------------

test("jsBridgeLine: a cell naming a bridge gets the bridge line; one naming none gets the kept line only after a lifted cell", () => {
    for (const bridged of [false, true]) assert.equal(jsBridgeLine("import js", bridged), JS_BRIDGE_LINE);
    assert.equal(jsBridgeLine("_x = T", true), JS_BRIDGE_KEPT_LINE);
    assert.equal(jsBridgeLine("_x = T", false), null, "the default: no lifted cell, no line");
    assert.match(JS_BRIDGE_KEPT_LINE, /^[^\u2014]*$/, "no em-dash");
});

test("pythonOutsideWhy carries bridged only when the run had a lifted cell", () => {
    assert.equal(pythonOutsideWhy("x", true).bridged, true);
    assert.equal("bridged" in pythonOutsideWhy("x"), false);
    assert.equal("bridged" in pythonOutsideWhy("x", false), false);
});
