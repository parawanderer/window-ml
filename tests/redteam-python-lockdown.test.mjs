// tests/redteam-python-lockdown.test.mjs — the readonly worker's boot must freeze the JS realm, leave PyProxy kinds converting, and reach neither `run_js` nor the live Pyodide bridge through `pyodide_js`/`js`/`pyodide.ffi`/`asyncio`.

// Red-team halves of the pyodide-lockdown gap (found by `[window-ml python-cancel]`, assigned to
// `[window-ml security] Site access` as builder). Real Pyodide in Node (`dist/pyodide/`, self-SKIPS
// without it), driving `lockdownReadonly` and the wrapper exactly as `python-worker.ts` does. Each
// test names the property the boundary must keep and carries a positive control. The open ones are
// `{ todo: "<what is open>" }`; the fixer removes the `todo` when the property holds.
//
// Two surfaces are probed and the file never mixes them in one assertion:
//   - the LOCKDOWN path (an APPROVED cell, `wrapUserCode`): the bridge gate (PYODIDE_LOCKDOWN.md
//     step 2, ruled 2026-10-27, built in #1162) refuses `js`, `pyodide.ffi` and `pyodide.webloop`
//     to the cell's own frames — an obfuscated name gains nothing, a library module's own import
//     keeps working, and an approval card's explicit line lifts it (`bridges`). `run_js` closes
//     with them. `asyncio` is importable as ruled (its risk is #998's sweep), and `pyodide_js`
//     imports as a config-only stand-in with no `_module` and no `_api` beyond config. What the
//     gate does NOT claim — introspection (`__globals__`, a package's module global, `gc`, the
//     guard's own closure), `compile()` under a library filename, removing the finder — is pinned
//     below as failing-first rows.
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
/** The bridge lift `lockdownReadonly` may return (`bridges(on)`); a lifted cell raises it around `runPythonAsync`, and absent it the wraps are no-ops. */
let bridges = null;
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
        bridges = held.bridges ?? null;
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
async function cell(code, { hardened = true, lifted = false } = {}) {
    injectInputs(py.globals, null, null, harness ?? undefined);
    const saved = hardened && !lockedDown ? harden(py) : null;
    try {
        if (lifted) bridges?.(true);
        await py.runPythonAsync(wrapUserCode(code, hardened));
    } finally {
        if (lifted) bridges?.(false);
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

    // The one lifted call site: the kinds cell's `from pyodide.ffi import to_js` runs under the explicit approval.
    const kinds = await cell(KINDS_CELL, { lifted: true });
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

test("after boot the JS realm is frozen: Object.prototype, Promise.prototype, Function.prototype", { skip }, async () => {
    // Positive control: the probe can tell frozen from unfrozen — the realm was unfrozen before the boot.
    assert.deepEqual(freezeBefore, { Object: false, Promise: false, Function: false }, "control: the realm starts unfrozen");

    assert.equal(Object.isFrozen(Object.prototype), true, "Object.prototype must be frozen after lockdownReadonly");
    assert.equal(Object.isFrozen(Promise.prototype), true, "Promise.prototype must be frozen after lockdownReadonly");
    assert.equal(Object.isFrozen(Function.prototype), true, "Function.prototype must be frozen after lockdownReadonly");
});

test("after boot a write to Object.prototype.constructor is refused", { skip }, () => {
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

test("a second lockdownReadonly does not re-boot: lockdown() runs at most once", { skip }, async () => {
    const before = lockdownCalls;
    await lockdownReadonly(py, {});
    assert.ok(lockdownCalls <= 1, `lockdown() must have run at most once across both boots, got ${before} then ${lockdownCalls}`);
});

// --- run_js: a cell must not evaluate a JS string after the boot ---------------------------------
// `pyodide.code.run_js(src)` evaluates `src` in this realm's global scope — python-runtime.ts names
// it bridge (2) of the three Python→outside bridges `harden()` closes. `run_js` does `from js import
// eval` when called, so the bridge gate's caller-scoped refusal closes it for the default approved
// cell (the cell's frame is on the stack when the import runs): both rows flip plain after #1162
// merged (37229b84). Under a lifted approval `js` is back and only the strip (PYODIDE_LOCKDOWN.md
// step 3) closes `run_js` then — a clean freeze never did: `Function("return 1")()` still evaluates
// after one, which is why the freeze rows above are their own property.

test("a cell cannot evaluate a JS string through pyodide.code.run_js after the boot", { skip }, async () => {
    // Positive control: the probe detects evaluation — `run_js("1+1")` returned 2 before the boot.
    assert.equal(Number(runJsControl), 2, "control: run_js evaluates a string before the boot");

    // Defended: after the boot, the same probe does not compute. A refusal or an inert value counts;
    // a computed 2 does not.
    const r = await cell(`from pyodide.code import run_js
run_js("1+1")`);
    if (r.error) return; // refused at import or call: the bridge is closed
    assert.ok(Number(r.value) !== 2, `run_js must not evaluate a string after the boot, got ${r.value}`);
});

test("a cell cannot reach the JS global object through run_js after the boot", { skip }, async () => {
    const r = await cell(`from pyodide.code import run_js
run_js("typeof globalThis")`);
    if (r.error) return; // refused: the bridge is closed
    // `typeof globalThis` is the string "object" only if the string was evaluated in the JS realm.
    assert.ok(String(r.value) !== "object", `run_js must not evaluate a string after the boot, got ${r.value}`);
});

// --- the LOCKDOWN path: a cell must not import the Python→outside bridges ------------------------
// The bridge gate (#1162) replaces each REFUSED_BRIDGE with a guard module in `sys.modules`, on its
// parent and behind a first `meta_path` finder, answered only when no frame on the stack is the
// cell's (a library module's own import is answered; an approval card's explicit line lifts it).
// `run_js` closes with them. The rows below pin each import route's spelling; the obfuscated
// spellings are their own row, and what the gate does NOT claim is pinned as failing-first rows
// further down.
//
// Two properties, kept apart (PYODIDE_LOCKDOWN.md step 2):
//   - the RULED property (2026-10-23): `pyodide_js` imports as a config-only stand-in with no
//     `_module` and no `_api` beyond config. The four STANDIN_ROUTES assert it. Pyodide's own
//     boot-time `from pyodide_js._api import scheduleCallback` keeps working; a user cell must not.
//   - `asyncio` is importable as ruled 2026-10-27 (its risk is work outliving the cell, closed by
//     #998's sweep, not by an import refusal); its row keeps the wider ask as a record and fails
//     while the import works.

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
    test(`a cell reaches only the config stand-in by ${label} after the boot`, { skip }, async () => {
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

/** Each route to a full Python→outside bridge. Ruled 2026-10-27: `js`, `pyodide.ffi` and
 * `pyodide.webloop` are refused in an approved cell by the gate — a refusal counts as closed.
 * `asyncio` is NOT refused (its risk is #998's sweep) and its entry keeps the wider ask as a record. */
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
    const record = label === "import asyncio" ? "asyncio is importable in an APPROVED cell as ruled (2026-10-27): its risk is work outliving the cell, and that is closed by #998's sweep of tasks and Handles, not by an import refusal. This row keeps the wider ask (refusal) as a record of what the approved cell does not get; it fails while the import works." : null;
    test(`a cell cannot reach the outside by ${label} after the boot`, { skip, ...(record ? { todo: record } : {}) }, async () => {
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

// `pyodide_js._module` is the one stand-in attribute the fix removes outright (#1046, de645ea3).
test("a cell cannot reach pyodide_js._module after the boot", { skip }, async () => {
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

// The gate's claim is by the CALLER, never by the name (PYODIDE_LOCKDOWN.md step 2): a name the
// cell builds at run time gains nothing. Enumerated, not sampled — the direct and obfuscated
// spellings of the js family and of pyodide.ffi, each probed for CAPABILITY (the guard hands a
// cell nothing to use; a refusal counts as closed).
test("a cell reaches no bridge by an obfuscated name: __import__ and importlib of a name it builds gain nothing", { skip }, async () => {
    // Positive control: a legitimate import still works — the probe runs on a live interpreter.
    const ok = await cell(`import math
out = {"pi": round(math.pi, 5)}
out`);
    assert.equal(ok.error, null, `control: import math must work, got: ${ok.error}`);
    assert.equal(ok.value?.pi, 3.14159, `control: import math must work, got: ${JSON.stringify(ok.value)}`);

    const r = await cell(`import importlib
out = {}
probes = [("js", __import__("j" + "s"), "eval"), ("js", __import__("".join(("j", "s"))), "eval"),
          ("js", importlib.import_module("j" + "s"), "eval"),
          ("pyodide.ffi", importlib.import_module("pyodide" + ".ffi"), "to_js"),
          ("pyodide.ffi", importlib.import_module("pyodide".__add__(".ffi")), "to_js")]
for name, m, attr in probes:
    try:
        getattr(m, attr)
        out[name + "." + attr] = "reached"
    except Exception as e:
        out.setdefault(name + "." + attr, type(e).__name__)
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    for (const [k, v] of Object.entries(r.value ?? {})) {
        assert.ok(v !== "reached", `an obfuscated name must gain nothing: ${k} reached the bridge`);
    }
});

// --- what the bridge gate does NOT claim: introspection and caller-spoof routes -------------------
// Measured 2026-10-27 and written into PYODIDE_LOCKDOWN.md step 2 and the gate's own docstring: the
// caller-scoped refusal closes the IMPORT routes only. A cell in full Python reaches the same
// functions without an import — a library function's `__globals__`, a package's module global, `gc`
// over any holder, the guard's own closure — or by compiling its code under a library filename, or
// by removing the finder and re-importing from the zip. The builder claims none of these rows
// (MERGE ORDER (3), PYODIDE_LOCKDOWN.md step 2); each is failing-first and its todo names the open
// route and what bounds it (the strip, the cell gate's revoke) — never what the gate claims.

/** The standard control: a legitimate import runs on a live interpreter, so no row passes vacuously. */
async function controlImport() {
    const ok = await cell(`import math
out = {"pi": round(math.pi, 5)}
out`);
    assert.equal(ok.error, null, `control: import math must work, got: ${ok.error}`);
    assert.equal(ok.value?.pi, 3.14159, `control: import math must work, got: ${JSON.stringify(ok.value)}`);
}

test("an approved cell reaches no live bridge through a library function's __globals__ (asyncio's call_later)", { skip, todo: "OPEN, claimed by no one (PYODIDE_LOCKDOWN.md step 2, measured 2026-10-27): type(asyncio.get_event_loop()).call_later.__globals__ holds scheduleCallback, create_once_callable and run_sync with no import at all. The gate claims the import routes only; the strip (no network, no postMessage in the realm) and the cell gate's revoke bound what these do, they do not close the route." }, async () => {
    await controlImport();
    const r = await cell(`import asyncio
g = type(asyncio.get_event_loop()).call_later.__globals__
live = {}
for n in ("scheduleCallback", "create_once_callable", "run_sync"):
    if n in g:
        live[n] = type(g[n]).__name__
out = {"live": live, "mapped": len(g)}
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    assert.ok((r.value?.mapped ?? 0) > 0, `control: the probed mapping must be a live globals dict, got ${JSON.stringify(r.value)}`);
    assert.deepEqual(r.value?.live ?? {}, {}, `a library function's __globals__ must not hand a cell live bridge functions, got ${JSON.stringify(r.value?.live)}`);
});

test("an approved cell reaches no live bridge by walking gc.get_objects() over every holder", { skip, todo: "OPEN (PYODIDE_LOCKDOWN.md step 2, measured 2026-10-27): gc.get_objects() finds any Python object holding a real bridge module — the guard's own __closure__ dict included — and the gate replaces no holder it does not own. The strip and the cell gate's revoke are the bounds." }, async () => {
    await controlImport();
    const r = await cell(`import gc
CAP = {"js": "eval", "pyodide.ffi": "to_js", "pyodide.ffi.wrappers": "create_proxy", "pyodide.webloop": "run_sync",
       "_pyodide_core": "create_proxy", "_pyodide._importhook": "JsFinder", "_pyodide._core_docs": "to_js",
       "pyodide._package_loader": "load_package"}
found = {}
for o in gc.get_objects():
    try:
        n = o.__name__
    except Exception:
        continue
    attr = CAP.get(n)
    if attr:
        try:
            getattr(o, attr)
            found[n] = "capable"
        except Exception:
            pass
out = {"found": found}
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    assert.deepEqual(r.value?.found ?? {}, {}, `gc must not hand a cell a live bridge module, got ${JSON.stringify(r.value?.found)}`);
});

test("an approved cell reaches no js through a package that imported it at boot (unix_timezones.js, pyarrow's timezone shim)", { skip, timeout: 240000 }, async () => {
    // PINNED (measured 2026-10-28): the package's boot-time `import js` binds the GUARD (t = _MlBridgeGuard)
    // and the cell's attribute lookup raises ImportError — the refusal lives at attribute access, so a
    // library module's OWN lookup is answered while a cell reading that module's global is not. (The gc and
    // planted-module rows show where that caller check is fooled or bypassed.)
    await controlImport();
    await py.loadPackage("pyarrow");
    const r = await cell(`import unix_timezones as u
js = getattr(u, "js", None)
info = {"has": js is not None, "t": type(js).__name__ if js is not None else "absent"}
if js is not None:
    try:
        js.eval
        info["cap"] = "reached"
    except Exception as e:
        info["cap"] = type(e).__name__
out = info
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    assert.equal(r.value?.has, true, `control: the package's boot import leaves its js module global (the measured fact this row probes), got ${JSON.stringify(r.value)}`);
    assert.ok(r.value?.cap !== "reached", `a package's boot-imported js must hand a cell no capability, got ${JSON.stringify(r.value)}`);
});

test("an approved cell reaches neither the real modules nor the lift flag through the guard's __getattr__.__closure__", { skip, todo: "OPEN (PYODIDE_LOCKDOWN.md step 2, measured 2026-10-27): sys.modules['js'] is the guard, and type(guard).__getattr__.__closure__ holds the real-modules dict and the function whose closure holds the lift list — a cell reads the real js out of the dict, or flips the list's flag and the guard answers every lookup. The builder claims none of these; the cell gate's revoke does not cover a cell lifting itself." }, async () => {
    await controlImport();
    // Control: reading a closure's cell_contents works in a cell, so the probe is not vacuous.
    const ctl = await cell(`def f():
    x = 1
    return lambda: x
out = {"x": f().__closure__[0].cell_contents}
out`);
    assert.equal(ctl.value?.x, 1, "control: a closure's cell_contents is readable in a cell");

    const r = await cell(`import sys
CAP = {"js": "eval", "pyodide.ffi": "to_js", "pyodide.ffi.wrappers": "create_proxy", "pyodide.webloop": "run_sync"}
g = sys.modules.get("js")
info = {"guard": g is not None}
leaked = {}
fn = type(g).__getattr__ if g is not None else None
for c in (getattr(fn, "__closure__", None) or ()):
    v = c.cell_contents
    if type(v).__name__ == "dict":
        for k, mv in list(v.items()):
            attr = CAP.get(k)
            if attr:
                try:
                    getattr(mv, attr)
                    leaked["real." + k] = "capable"
                except Exception:
                    pass
    if type(v).__name__ == "function":
        for c2 in (getattr(v, "__closure__", None) or ()):
            v2 = c2.cell_contents
            if isinstance(v2, list) and len(v2) == 1 and isinstance(v2[0], bool):
                info["flip_found"] = True
                try:
                    v2[0] = True
                    try:
                        g.eval
                        leaked["lift"] = "capable"
                    except Exception:
                        pass
                finally:
                    v2[0] = False
out = {"info": info, "leaked": leaked}
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    assert.equal(r.value?.info?.guard, true, `control: the guard is in sys.modules under "js" (the shape this row probes), got ${JSON.stringify(r.value)}`);
    assert.deepEqual(r.value?.leaked ?? {}, {}, `the guard's __getattr__.__closure__ must hand a cell neither the real modules nor a working lift flag, got ${JSON.stringify(r.value)}`);
});

test("an approved cell gains no library privilege by compiling its code under a library filename", { skip, todo: "OPEN (PYODIDE_LOCKDOWN.md step 2, measured 2026-10-27): answered() treats a frame as the library's when its co_filename is under the stdlib root and its co_name is `<module>`, so a cell's compile(src, os.__file__, \"exec\") gets every attribute answered — the filename is caller-controlled. The strip and the cell gate's revoke are the bounds." }, async () => {
    await controlImport();
    const r = await cell(`import os
src = "\\n".join(["import js", "try:", "    js.eval", "    LEAK = 'capable'", "except Exception as e:", "    LEAK = type(e).__name__"])
ns = {}
exec(compile(src, os.__file__, "exec"), ns)
out = {"leak": ns.get("LEAK")}
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    assert.ok(r.value?.leak !== "capable", `a frame whose co_filename is a library file must not answer the guard, got ${JSON.stringify(r.value)}`);
});

test("removing the bridge finder and re-importing pyodide.ffi from the zip hands a cell no live module", { skip, todo: "OPEN (PYODIDE_LOCKDOWN.md step 2, measured 2026-10-27): removing _MlBridgeFinder from sys.meta_path and popping the guards re-imports pyodide.ffi from its file in the zip — the real module, since only `js` is unregistered from Pyodide's finder. The claimed half (popping the js guard brings nothing back) is asserted plain here; the ffi half is open. The strip and the cell gate's revoke are the bounds." }, async () => {
    await controlImport();
    const r = await cell(`import sys, importlib
info = {}
orig = list(sys.meta_path)
try:
    sys.meta_path[:] = [f for f in orig if getattr(f, "__name__", "") != "_MlBridgeFinder"]
    for k in ("js", "pyodide.ffi", "pyodide.ffi.wrappers", "pyodide.webloop"):
        sys.modules.pop(k, None)
    p = sys.modules.get("pyodide")
    if p is not None:
        for child in ("ffi", "webloop"):
            try:
                delattr(p, child)
            except Exception:
                pass
    try:
        import js
        js.eval
        info["js"] = "capable"
    except Exception as e:
        info["js"] = type(e).__name__
    try:
        ffi = importlib.import_module("pyodide.ffi")
        ffi.to_js
        info["ffi"] = "capable"
    except Exception as e:
        info["ffi"] = type(e).__name__
finally:
    sys.meta_path[:] = orig
    for k in ("js", "pyodide.ffi", "pyodide.ffi.wrappers", "pyodide.webloop"):
        sys.modules.pop(k, None)
        try:
            importlib.import_module(k)
        except Exception as e:
            info["restore." + k] = type(e).__name__
out = info
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    // Control: the row restores the gate (the finder and the guards) so later rows see a clean world.
    const ctl = await cell(`import sys
g = sys.modules.get("js")
out = {"t": type(g).__name__ if g is not None else "absent"}
out`);
    assert.equal(ctl.value?.t, "_MlBridgeGuard", `control: the row must restore the js guard for later rows, got ${JSON.stringify(ctl.value)}`);
    // Control: after the restore, the refused names reach NO capability — a failed re-import is safe
    // (pyodide.ffi.wrappers cannot be re-imported once pyodide.ffi is a guard); a real module is not.
    const ctl2 = await cell(`import sys
CAP = {"js": "eval", "pyodide.ffi": "to_js", "pyodide.ffi.wrappers": "create_proxy", "pyodide.webloop": "run_sync"}
out = {}
for k, attr in CAP.items():
    m = sys.modules.get(k)
    if m is None:
        out[k] = "absent"
    else:
        try:
            getattr(m, attr)
            out[k] = "capable:" + type(m).__name__
        except Exception:
            out[k] = "refused:" + type(m).__name__
out`);
    assert.deepEqual(Object.entries(ctl2.value ?? {}).filter(([, v]) => String(v).startsWith("capable")), [], `control: the row must leave no real module reachable under the refused names, got ${JSON.stringify(ctl2.value)}`);
    // The gate's own claim: `js` is unregistered from Pyodide's finder, so popping the guard does not bring the real one back.
    assert.match(String(r.value?.js ?? ""), /ImportError|ModuleNotFoundError/, `popping the js guard must not bring the real one back (it is unregistered from Pyodide's finder), got ${JSON.stringify(r.value)}`);
    // Defended: the same must hold for pyodide.ffi, re-importable from its file in the zip.
    assert.ok(r.value?.ffi !== "capable", `removing the finder must hand a cell no live pyodide.ffi from the zip, got ${JSON.stringify(r.value)}`);
});

test("a cell that writes a module under the stdlib root gains no library privilege for it", { skip, todo: "OPEN (PYODIDE_LOCKDOWN.md step 2, measured 2026-10-27): answered() trusts the filename and `<module>` co_name, so a module a cell plants under the stdlib root runs its imports answered — the write into the worker's filesystem is open. The strip and the cell gate's revoke are the bounds." }, async () => {
    await controlImport();
    const r = await cell(`import os, sys, importlib
root = os.path.dirname(os.__file__) + "/"
p = root + "_ml_redteam_planted.py"
info = {}
body = 'LEAK = "no-js"\\ntry:\\n    import js\\n    try:\\n        js.eval\\n        LEAK = "capable"\\n    except Exception as e:\\n        LEAK = type(e).__name__\\nexcept Exception as e:\\n    LEAK = "import:" + type(e).__name__\\n'
try:
    with open(p, "w") as f:
        f.write(body)
    info["wrote"] = True
except Exception as e:
    info["wrote"] = type(e).__name__
if info.get("wrote") is True:
    try:
        m = importlib.import_module("_ml_redteam_planted")
        info["leak"] = getattr(m, "LEAK", "none")
    except Exception as e:
        info["import"] = type(e).__name__
    sys.modules.pop("_ml_redteam_planted", None)
    try:
        os.remove(p)
    except Exception:
        pass
out = info
out`);
    assert.equal(r.error, null, `the probe must run, got: ${r.error}`);
    assert.equal(r.value?.wrote, true, `control: a cell can write under the stdlib root (the fact this row probes), got ${JSON.stringify(r.value)}`);
    assert.equal(r.value?.import, undefined, `control: the planted module imports (the fact this row probes), got ${JSON.stringify(r.value)}`);
    assert.ok(r.value?.leak !== "capable", `a module planted under the stdlib root must gain no library privilege, got ${JSON.stringify(r.value)}`);
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
    ["class C: pass (ClassDef node)", `class C: pass
return C`, /ClassDef/],
    ["yield in a def (Yield node)", `def f():
    yield 1
return f`, /Yield/],
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
    ["operator.methodcaller('__dict__')(math)", `import operator, math
return operator.methodcaller("__dict__")(math)`, /attribute 'methodcaller' of module/],
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
