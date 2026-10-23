// tests/redteam-python-lockdown.test.mjs — the readonly worker's boot must freeze the JS realm, leave PyProxy kinds converting, and reach neither `run_js` nor the live Pyodide bridge through `pyodide_js`/`js`/`pyodide.ffi`/`asyncio`.

// Red-team halves of the pyodide-lockdown gap (found by `[window-ml python-cancel]`, assigned to
// `[window-ml security] Site access` as builder). Real Pyodide in Node (`dist/pyodide/`, self-SKIPS
// without it), driving `lockdownReadonly` and the wrapper exactly as `python-worker.ts` does. Each
// test names the property the boundary must keep and carries a positive control. The open ones are
// `{ todo: "<what is open>" }`; the fixer removes the `todo` when the property holds.
//
// Two surfaces are probed and the file never mixes them in one assertion:
//   - the LOCKDOWN path (an APPROVED cell, `wrapUserCode`): `import pyodide_js` and `run_js` reach
//     today because `lockdownReadonly` never calls `harden()` (which unregisters the JS bridges).
//     These escape an approved cell, not the auto-approved path — the dialect refuses these imports.
//     On this path the RULED property (PYODIDE_LOCKDOWN.md step 2, 2026-10-23) is that `pyodide_js`
//     imports as a config-only stand-in with no `_module` and no `_api` beyond config; the wider
//     ask (refuse `js`/`pyodide.ffi`/`pyodide.webloop`/`asyncio` outright) is parked by the freeze.
//   - the DIALECT path (the auto-approved inside cell, `wrapUserScript(…, inside)`): the attribute
//     gate refuses every route out of an ADMITTED object. Those routes HOLD and are pinned here so
//     a change cannot flip one quietly.
//
// `docs/plan/repl/PYODIDE_LOCKDOWN.md` is the spec. The #735 property (PyProxy kinds still convert)
// is its own passing test beside the freeze, NOT inside the freeze's `todo`: a fix that simply
// deletes the `Object.prototype.constructor` accessor breaks `getPyProxyClass`'s
// `n.constructor = …`, and that test is what notices.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, wrapUserSetup, wrapUserScript, injectInputs, harden, unharden } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;

/** The defence's boot hook. Absent on main: the calls below are no-ops and the properties stay open. */
let lockdownReadonly = null;
try { ({ lockdownReadonly } = await import("../src/python/lockdown.ts")); } catch { /* defence not landed */ }

/** How many times `globalThis.lockdown` ran. The latch must hold this at 1 across two boots. */
let lockdownCalls = 0;
try {
    if (typeof globalThis.lockdown === "function") {
        const orig = globalThis.lockdown;
        globalThis.lockdown = (...a) => { lockdownCalls++; return orig(...a); };
    }
} catch { /* lockdown is non-writable: the call-count half of the latch test reports unknown */ }

let py = null;
/** True once `lockdownReadonly` has run on `py`. */
let lockedDown = false;
/** The harness module `lockdownReadonly` captured at boot, re-bound into every cell by `injectInputs`. */
let harness = null;
/** True when `dist/pyodide` is the restricted-mode fork (the dialect's gate is present). */
let fork = false;
/** `run_js("1+1")` before any lockdown: the positive control that the probe detects evaluation. */
let runJsControl = null;
/** The prototypes' frozen state before any lockdown: the positive control that the probe can tell. */
let freezeBefore = null;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    fork = !py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`);
    await py.loadPackage(["numpy", "pillow", "pandas"]);
    // Controls first, while the realm is still unlocked — `lockdown()` closes the very routes they prove.
    freezeBefore = {
        Object: Object.isFrozen(Object.prototype),
        Promise: Object.isFrozen(Promise.prototype),
        Function: Object.isFrozen(Function.prototype),
    };
    runJsControl = await py.runPythonAsync(`from pyodide.code import run_js
run_js("1+1")`);
    if (typeof lockdownReadonly === "function") {
        const held = await lockdownReadonly(py, {});
        harness = held.harness ?? null;
        lockedDown = true;
    }
    if (fork) await py.runPythonAsync(dialectSetup(FILES));
}, { timeout: 240000 });

after(async () => {
    try { await py?.destroy?.(); } catch { /* */ }
});

/**
 * Run one cell the way a hardened `python_exec` does on the LOCKDOWN path (an approved cell), and
 * read the wrapper's results back. Under the lockdown the strip is the hardening; `harden()` would
 * RESTORE what it removed.
 */
async function cell(code, { hardened = true } = {}) {
    injectInputs(py.globals, null, null, harness ?? undefined);
    const saved = hardened && !lockedDown ? harden(py) : null;
    try {
        await py.runPythonAsync(wrapUserCode(code, hardened));
    } finally {
        if (saved) unharden(py, saved);
    }
    const out = {
        stdout: String(py.globals.get("_stdout") ?? ""),
        error: py.globals.get("_err") ? String(py.globals.get("_err")) : null,
        value: null,
    };
    const jr = py.globals.get("_json_result");
    try { out.value = JSON.parse(jr); } catch { out.value = jr === undefined ? null : String(jr); }
    return out;
}

/**
 * Run one cell INSIDE the dialect (the auto-approved path), as `python-worker.ts` does. Returns the
 * fork's refusal in `refused`, the wrapper's error in `error`, and the cell's value in `value`.
 */
async function insideCell(code) {
    const ns = py.globals.get("dict")();
    ns.set("_ml_send", () => Promise.resolve(JSON.stringify({ seq: 1, value: "WIRE_OK" })));
    try {
        await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
        await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
    } catch (e) {
        return { threw: String(e).split("\n").slice(0, 3).join(" | ") };
    }
    return {
        refused: ns.get("_ml_not_in_dialect") ?? null,
        error: ns.get("_err") ?? null,
        value: ns.has("_json_result") ? String(ns.get("_json_result")) : null,
    };
}

// --- #735: the PyProxy kinds still convert after boot ---------------------------------------------
// The guard against the wrong fix. A plain freeze of `Object.prototype` breaks every kind at
// `getPyProxyClass`'s `n.constructor = …` ("Cannot assign to read only property 'constructor'").
// The accessor exists for exactly that; this test must stay GREEN, including after the freeze fix.
// It is NOT `{ todo }`: if it goes red, the fix removed the accessor and #735 is broken again.

/** Every PyProxy kind #735 names, converted on both sides of the bridge. */
const KINDS_CELL = /* python */ `
from pyodide.ffi import to_js
out = {}
for name, obj in [
    ("tuple", (1, 2, 3)),
    ("set", {1, 2, 3}),
    ("generator", (x for x in range(3))),
    ("iterator", iter([1, 2])),
    ("memoryview", memoryview(b"abc")),
]:
    try:
        j = to_js(obj)
        out[name] = "ok:" + type(j).__name__
    except Exception as e:
        out[name] = "broken:" + type(e).__name__ + ":" + str(e)[:80]
try:
    import numpy as np
    j = to_js(np.arange(6))
    out["ndarray"] = "ok:" + type(j).__name__
except Exception as e:
    out["ndarray"] = "broken:" + type(e).__name__ + ":" + str(e)[:80]
out
`;

test("after boot the PyProxy kinds still convert: tuple, set, generator, ndarray, iterator, memoryview", { skip }, async () => {
    // Positive control: the boot ran (the realm was probed and the wrapper answers).
    assert.deepEqual(freezeBefore, { Object: false, Promise: false, Function: false }, "control: the realm starts unfrozen");

    const kinds = await cell(KINDS_CELL);
    assert.equal(kinds.error, null, `kinds cell should run, got: ${kinds.error}`);
    for (const name of ["tuple", "set", "generator", "iterator", "memoryview", "ndarray"]) {
        assert.match(String(kinds.value?.[name]), /^ok:/, `PyProxy kind ${name} must still convert after boot, got ${kinds.value?.[name]}`);
    }
    // The same kinds on the JS side — this is where `getPyProxyClass` assigns `n.constructor`.
    for (const [name, code] of [["tuple", "(1, 2)"], ["set", "{1, 2}"], ["generator", "(x for x in range(2))"], ["iterator", "iter([1])"], ["memoryview", "memoryview(b'a')"], ["ndarray", "__import__('numpy').arange(4)"]]) {
        let v;
        try { v = py.runPython(code); } catch (e) { assert.fail(`JS-side PyProxy of a ${name} must construct after boot: ${e}`); }
        assert.ok(v != null, `JS-side PyProxy of a ${name} must construct after boot`);
        try { v?.toJs?.(); } catch (e) { assert.fail(`JS-side PyProxy of a ${name} must convert after boot: ${e}`); }
    }
});

// --- the freeze is real and the latch sets -------------------------------------------------------

test("after boot the JS realm is frozen: Object.prototype, Promise.prototype, Function.prototype", { skip, todo: "lockdown() throws `Accessor not expected at intrinsics.%ObjectPrototype%.constructor` (the accessor is installed BEFORE it), so the realm is left unfrozen and `locked` never sets. The ruled fix (PYODIDE_LOCKDOWN.md 2026-10-23) is `overrideTaming: \"severe\"` in place of our accessor, under which lockdown() installs it and succeeds — do not widen the SES permit to allow a hand-installed accessor." }, async () => {
    // Positive control: the probe can tell frozen from unfrozen — the realm was unfrozen before the boot.
    assert.deepEqual(freezeBefore, { Object: false, Promise: false, Function: false }, "control: the realm starts unfrozen");

    assert.equal(Object.isFrozen(Object.prototype), true, "Object.prototype must be frozen after lockdownReadonly");
    assert.equal(Object.isFrozen(Promise.prototype), true, "Promise.prototype must be frozen after lockdownReadonly");
    assert.equal(Object.isFrozen(Function.prototype), true, "Function.prototype must be frozen after lockdownReadonly");
});

test("after boot a write to Object.prototype.constructor is refused", { skip, todo: "the ruled fix's `overrideTaming: \"severe\"` accessor refuses `this === Object.prototype` and otherwise defines an own property. Today the hand-installed accessor accepts the write on the prototype itself — a write path to Function for anything that reaches the prototype." }, () => {
    // Positive control: a write to a PLAIN object's constructor is an own property (that is what
    // #735's `n.constructor = …` needs), and it works today with the hand-installed setter.
    const plain = {};
    const marker = function Marker() {};
    plain.constructor = marker;
    assert.equal(plain.constructor, marker, "control: a plain-object write materialises an own property");

    // Defended: the same write aimed at `Object.prototype` itself does not land on the prototype.
    const before = Object.getOwnPropertyDescriptor(Object.prototype, "constructor");
    const evil = function Evil() {};
    try { Object.prototype.constructor = evil; } catch { /* refused */ }
    const after = Object.getOwnPropertyDescriptor(Object.prototype, "constructor");
    assert.ok(after?.value !== evil, "a write to Object.prototype.constructor must not land on the prototype");
    if (before?.value !== undefined) {
        assert.equal(after?.value, before.value, "and the prototype keeps its own constructor");
    }
});

test("a second lockdownReadonly does not re-boot: lockdown() runs at most once", { skip, todo: "`locked` is set only on a successful lockdown(); the accessor makes lockdown() throw and the catch leaves it false, so a second boot re-runs lockdown() (measured: 2 calls). The latch must hold at 1." }, async () => {
    const before = lockdownCalls;
    await lockdownReadonly(py, {});
    assert.ok(lockdownCalls <= 1, `lockdown() must have run at most once across both boots, got ${before} then ${lockdownCalls}`);
});

// --- run_js: a cell must not evaluate a JS string after the boot ---------------------------------
// `pyodide.code.run_js(src)` evaluates `src` in this realm's global scope — python-runtime.ts names
// it bridge (2) of the three Python→outside bridges `harden()` closes. `lockdownReadonly` replaces
// `harden()` and does not close it. Measured after the boot: `run_js("1+1")` returns 2 and
// `run_js("globalThis")` hands back the global object. Even a SUCCESSFUL `lockdown()` may not stop
// this on its own: `Function("return 1")()` still evaluates after a clean freeze (the prototype-chain
// constructors throw, the kept `Function` binding does not), so the fix must close the bridge
// directly — unregister/block `pyodide.code.run_js`, or refuse a string in it — not rely on the freeze.

test("a cell cannot evaluate a JS string through pyodide.code.run_js after the boot", { skip, todo: "run_js evaluates a string after lockdownReadonly (run_js('1+1') returns 2). Close bridge (2): the lockdown path must not leave a string-eval route into the JS realm. A clean freeze alone may not be enough — Function('return 1') still evaluates after one." }, async () => {
    // Positive control: the probe detects evaluation — `run_js("1+1")` returned 2 before the boot.
    assert.equal(Number(runJsControl), 2, "control: run_js evaluates a string before the boot");

    // Defended: after the boot, the same probe does not compute. A refusal or an inert value counts;
    // a computed 2 does not.
    const r = await cell(`from pyodide.code import run_js
run_js("1+1")`);
    if (r.error) return; // refused at import or call: the bridge is closed
    assert.ok(Number(r.value) !== 2, `run_js must not evaluate a string after the boot, got ${r.value}`);
});

test("a cell cannot reach the JS global object through run_js after the boot", { skip, todo: "run_js('globalThis') returns the global object after lockdownReadonly — the cell reads the realm's names. (The test strips a STAND-IN scope, not globalThis, so this asserts the eval happened, not which names the worker kept.)" }, async () => {
    const r = await cell(`from pyodide.code import run_js
run_js("typeof globalThis")`);
    if (r.error) return; // refused: the bridge is closed
    // `typeof globalThis` is the string "object" only if the string was evaluated in the JS realm.
    assert.ok(String(r.value) !== "object", `run_js must not evaluate a string after the boot, got ${r.value}`);
});

// --- the LOCKDOWN path: a cell must not import the Python→outside bridges ------------------------
// `harden()` unregisters `js` and `pyodide_js` and purges `sys.modules`; `lockdownReadonly` never
// calls it. Measured after the boot: `import pyodide_js`, `import js`, `import pyodide.ffi`,
// `import asyncio`, `sys.modules["pyodide_js"]` and the `__subclasses__` walk all reach. These are
// APPROVED-cell escapes.
//
// Two properties, kept apart (PYODIDE_LOCKDOWN.md step 2, ruled 2026-10-23):
//   - the RULED property: `pyodide_js` imports as a config-only stand-in with no `_module` and no
//     `_api` beyond config. The four STANDIN_ROUTES assert it. Pyodide's own boot-time
//     `from pyodide_js._api import scheduleCallback` keeps working; a user cell must not.
//   - the WIDER property: `js`, `pyodide.ffi`, `pyodide.webloop` and `asyncio` are refused in an
//     approved cell. Parked by the freeze (a new defence with a corpus cost, Shane's call).

/** Every live bridge key `pyodide_js._api` must not hand a user cell. */
const LIVE_API_KEYS = ["scheduleCallback", "saveState", "restoreState", "destroyProxies"];

/** Each route to the `pyodide_js` stand-in. Defended: it is config-only. */
const STANDIN_ROUTES = [
    ["import pyodide_js", `import pyodide_js
live = []
if getattr(pyodide_js, "_module", None) is not None: live.append("_module")
api = getattr(pyodide_js, "_api", None)
if api is not None:
    for k in ${JSON.stringify(LIVE_API_KEYS)}:
        if getattr(api, k, None) is not None: live.append("_api." + k)
out = {"live": live}`],
    ["__import__('pyodide_js')", `m = __import__("pyodide_js")
live = []
if getattr(m, "_module", None) is not None: live.append("_module")
api = getattr(m, "_api", None)
if api is not None:
    for k in ${JSON.stringify(LIVE_API_KEYS)}:
        if getattr(api, k, None) is not None: live.append("_api." + k)
out = {"live": live}`],
    ["sys.modules['pyodide_js']", `import sys
m = sys.modules["pyodide_js"]
live = []
if getattr(m, "_module", None) is not None: live.append("_module")
api = getattr(m, "_api", None)
if api is not None:
    for k in ${JSON.stringify(LIVE_API_KEYS)}:
        if getattr(api, k, None) is not None: live.append("_api." + k)
out = {"live": live}`],
    ["pyodide_js._api", `import pyodide_js
api = getattr(pyodide_js, "_api", None)
live = []
if api is not None:
    for k in ${JSON.stringify(LIVE_API_KEYS)}:
        if getattr(api, k, None) is not None: live.append(k)
out = {"live": live}`],
];

for (const [label, body] of STANDIN_ROUTES) {
    test(`a cell reaches only the config stand-in by ${label} after the boot`, { skip, todo: `ruled property (PYODIDE_LOCKDOWN.md step 2): ${label} must hand a config-only stand-in with no \`_module\` and no \`_api\` beyond config. Today the stand-in imports as a live module carrying both, so the route hands the cell the Pyodide bridge. Pyodide's own boot-time \`from pyodide_js._api import scheduleCallback\` keeps working; a user cell must not reach it. The wider ask (refuse the import form outright) is parked with js/ffi/webloop/asyncio below.` }, async () => {
        // Positive control: a legitimate import still works — the probe runs on a live interpreter.
        const ok = await cell(`import math
out = {"pi": round(math.pi, 5)}
out`);
        assert.equal(ok.error, null, `control: import math must work, got: ${ok.error}`);
        assert.equal(ok.value?.pi, 3.14159, `control: import math must work, got: ${JSON.stringify(ok.value)}`);

        // Defended: whatever this route hands back is config-only. A refusal counts as closed.
        const r = await cell(`${body}
out`);
        if (r.error) return; // refused at import or attribute: the route is closed
        const live = r.value?.live;
        assert.deepEqual(live, [], `${label} must hand only the config stand-in after the boot, got live keys ${JSON.stringify(live)}`);
    });
}

/** Each route to a full Python→outside bridge. Wider property, parked by the freeze. */
const BRIDGE_ROUTES = [
    ["import js", `import js
out = {"v": type(js).__name__}`],
    ["from js import setTimeout", `from js import setTimeout
out = {"v": type(setTimeout).__name__}`],
    ["import pyodide.ffi", `from pyodide.ffi import to_js
out = {"v": type(to_js).__name__}`],
    ["import pyodide.webloop", `import pyodide.webloop as w
out = {"v": type(w).__name__}`],
    ["import asyncio", `import asyncio
out = {"v": type(asyncio).__name__}`],
];

for (const [label, body] of BRIDGE_ROUTES) {
    test(`a cell cannot reach the outside by ${label} after the boot`, { skip, todo: `wider property, parked by the freeze (PYODIDE_LOCKDOWN.md step 2, 2026-10-23): ${label} is refused in an APPROVED cell. Today lockdownReadonly never calls harden() (which unregisters js/pyodide_js and purges sys.modules), so it reaches. A new defence with a corpus cost; Shane's call after the freeze.` }, async () => {
        // Positive control: a legitimate import still works — the probe runs on a live interpreter.
        const ok = await cell(`import math
out = {"pi": round(math.pi, 5)}
out`);
        assert.equal(ok.error, null, `control: import math must work, got: ${ok.error}`);
        assert.equal(ok.value?.pi, 3.14159, `control: import math must work, got: ${JSON.stringify(ok.value)}`);

        // Defended: this route does not reach the bridge. A refusal counts as closed.
        const r = await cell(`${body}
out`);
        if (r.error) return; // refused at import or attribute: the route is closed
        const s = String(r.value?.v ?? r.value);
        assert.ok(!/module|JsProxy|function|builtin|type/.test(s), `${label} must not reach the outside after the boot, got ${s}`);
    });
}

// `pyodide_js._module` is the one stand-in attribute the fix removes outright (todo 16 in the
// site-access per-todo list), so this turns plain when #1046 merges rather than being rewritten.
test("a cell cannot reach pyodide_js._module after the boot", { skip, todo: "the ruled fix removes `_module` from the stand-in entirely, so this route is refused and the test turns plain when #1046 merges. Today the stand-in carries it: the Emscripten module, the JS side of the bridge." }, async () => {
    const ok = await cell(`import math
out = {"pi": round(math.pi, 5)}
out`);
    assert.equal(ok.error, null, `control: import math must work, got: ${ok.error}`);
    assert.equal(ok.value?.pi, 3.14159, `control: import math must work, got: ${JSON.stringify(ok.value)}`);

    const r = await cell(`import pyodide_js
out = {"v": type(pyodide_js._module).__name__}
out`);
    if (r.error) return; // refused at import or attribute: the route is closed
    const s = String(r.value?.v ?? r.value);
    assert.ok(!/module|JsProxy|function|builtin|type/.test(s), `pyodide_js._module must not reach the outside after the boot, got ${s}`);
});

// --- the DIALECT's attribute gate: an ADMITTED object must not lead to the bridges ----------------
// The auto-approved inside cell runs under the fork's `restricted.run_cell`. The finder measured
// that every IMPORT form of these modules is refused; the attribute routes out of an ADMITTED
// object (a module the gate let the cell import, a function it defined, a builtin) were unprobed.
// Measured here on the fork core: every route below is refused. Pinned so a change cannot flip one
// quietly. These HOLD — they are not `{ todo }`. One-line reasons are in the PR body beside each.

/** Every attribute route from an admitted object to a bridge module. `want` is the refusal we expect. */
const ATTR_ROUTES = [
    ["import pyodide_js", `import pyodide_js
return pyodide_js`, /import 'pyodide_js'/],
    ["import js", `import js
return js`, /import 'js'/],
    ["import pyodide.ffi", `from pyodide.ffi import to_js
return to_js`, /import 'pyodide\.ffi'/],
    ["import asyncio", `import asyncio
return asyncio`, /import 'asyncio'/],
    ["__import__('pyodide_js')", `return __import__("pyodide_js")`, /the name __import__/],
    ["np.arange.__globals__", `import numpy as np
return np.arange.__globals__["sys"].modules["pyodide_js"]`, /the attribute __globals__/],
    ["np.__dict__", `import numpy as np
return np.__dict__["sys"].modules["pyodide_js"]`, /the attribute __dict__/],
    ["json.loads.__globals__", `import json
return json.loads.__globals__["sys"].modules["pyodide_js"]`, /the attribute __globals__/],
    ["json.__dict__", `import json
return json.__dict__["sys"].modules["pyodide_js"]`, /the attribute __dict__/],
    ["collections.namedtuple.__globals__", `import collections
return collections.namedtuple.__globals__["sys"].modules["pyodide_js"]`, /the attribute __globals__/],
    ["io.open.__globals__", `import io
return io.open.__globals__["sys"].modules["pyodide_js"]`, /the attribute __globals__/],
    ["math.__dict__", `import math
return math.__dict__`, /the attribute __dict__/],
    ["math.__loader__", `import math
return math.__loader__`, /the attribute __loader__/],
    ["math.__builtins__", `import math
return math.__builtins__`, /the attribute __builtins__/],
    ["f.__globals__ (cell-defined)", `def f(): return 1
return f.__globals__["sys"].modules["pyodide_js"]`, /the attribute __globals__/],
    ["f.__code__", `def f(): return 1
return f.__code__`, /the attribute __code__/],
    ["f.__defaults__", `def f(a=1): return a
return f.__defaults__`, /the attribute __defaults__/],
    ["lambda.__globals__", `f = lambda: 1
return f.__globals__`, /the attribute __globals__/],
    ["e.__traceback__", `try: 1/0
except Exception as e: return e.__traceback__`, /Try/],
    ["import sys", `import sys
return sys.modules["pyodide_js"]`, /import 'sys'/],
    ["().__class__", `return ().__class__`, /the attribute __class__/],
    ["__subclasses__", `return ().__class__.__bases__[0].__subclasses__()`, /the attribute __subclasses__/],
    ["type(1).__dict__", `return type(1).__dict__`, /the attribute __dict__/],
    ["type(1).mro()", `return type(1).mro()`, /attribute 'mro'/],
    ["np.__dict__ via getattr", `import numpy as np
return getattr(np, "__dict__")`, /call on builtin_function_or_method/],
    ["object.__getattribute__(math, '__dict__')", `import math
return object.__getattribute__(math, "__dict__")`, /the attribute __getattribute__/],
    ["math.__getattribute__('__dict__')", `import math
return math.__getattribute__("__dict__")`, /the attribute __getattribute__/],
    ["type(math).__bases__", `import math
return type(math).__bases__`, /the attribute __bases__/],
    ["type(math).__subclasses__()", `import math
return type(math).__subclasses__()`, /the attribute __subclasses__/],
    ["np.linalg (submodule attr)", `import numpy as np
return np.linalg`, /attribute 'linalg' of module/],
    ["json.decoder (submodule attr)", `import json
return json.decoder`, /attribute 'decoder' of module/],
    ["np.sys (alias attr)", `import numpy as np
return np.sys`, /attribute 'sys' of module/],
    ["operator.attrgetter('__dict__')(math)", `import operator, math
return operator.attrgetter("__dict__")(math)`, /attribute 'attrgetter' of module/],
    ["vars(math)", `import math
return vars(math)`, /call on builtin_function_or_method/],
    ["dir(math)", `import math
return dir(math)[:8]`, /attribute '__dict__' of module/],
    ["import builtins", `import builtins
return builtins`, /import 'builtins'/],
    ["import importlib", `import importlib
return importlib`, /import 'importlib'/],
    ["import types", `import types
return types`, /import 'types'/],
];

for (const [label, code, want] of ATTR_ROUTES) {
    // `fork` is known only in before(), so the skip is decided in the body (the `{ skip }` option is
    // read at declaration and would pin the pre-boot `false`).
    test(`inside: an admitted object does not lead to a bridge by ${label}`, { timeout: 60000 }, async (t) => {
        if (!fork) return t.skip("needs the restricted-mode fork core (npm run fetch-pyodide)");
        const out = await insideCell(code);
        assert.ok(out.refused || out.threw, `${label} must be refused inside the dialect, got ${JSON.stringify(out)}`);
        const text = String(out.refused ?? out.threw);
        assert.match(text, want, `${label}: expected the gate to refuse it`);
    });
}

test("inside: positive control — an admitted import and its admitted attribute run", { timeout: 60000 }, async (t) => {
    if (!fork) return t.skip("needs the restricted-mode fork core");
    // The attr tests above must not pass because EVERYTHING is refused: a normal cell runs. `math`
    // is an admitted module and `fsum` is the attribute its manifest admits (`math.pi` is not).
    const out = await insideCell(`import math
return math.fsum([1.0, 2.0])`);
    assert.equal(out.refused, null, `control: a normal cell must run inside, got ${JSON.stringify(out)}`);
    assert.equal(out.value, "3.0", `control: a normal cell must run inside, got ${JSON.stringify(out)}`);
});
