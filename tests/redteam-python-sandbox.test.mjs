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
//
// Every cell here runs with the bridge refusal LIFTED (`bridges: true`, lockdown.ts `REFUSED_BRIDGES`), the case of a cell
// whose approval card said it reaches the browser's JavaScript: the vectors need `js` and `pyodide.ffi` to set up, and
// what they assert must hold even then (PYODIDE_LOCKDOWN.md step 2, ruled 2026-10-27). The lift ends with the cell, so a
// `later` pump runs refused. The refusal itself is `python-bridge-gate.test.mjs`.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { wrapUserCode, harden, unharden, injectInputs, hostRunScript, cancelPath } from "../src/python/python-runtime.ts";

/** The defence's boot hook and its allow list. Absent on main: the calls below are no-ops and the properties stay open. */
let lockdownReadonly = null;
let cellGate = null;
try { cellGate = await import("../src/python/cell-gate.ts"); } catch { /* defence not landed */ }
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
/** The harness module `lockdownReadonly` captured at boot; re-bound into every cell by `injectInputs`. */
let harness = null;
/** The bridge lift `lockdownReadonly` returned for `py`; null before the boot. */
let bridges = null;
/** P1's positive control, captured BEFORE any `lockdown()` (see the header). */
let p1Control = null;

before(async () => {
    if (!hasPyodide) return;
    py = await loadPy();
    // The control first, while the realm is still unlocked: `lockdown()` closes the very route it proves.
    p1Control = await cellOn(py, P1_CHAIN, { hardened: false });
    if (typeof lockdownReadonly === "function") {
        const held = await lockdownReadonly(py, {});
        harness = held.harness ?? null;
        bridges = held.bridges ?? null;
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
 * has been returned (not the wrapper — it is not a cell). `lift` runs the cell with the bridge refusal lifted (see the header).
 */
async function cellOn(interp, code, { hardened = true, stream = false, tables = null, image = null, later = 0, cancel = null, lift = true } = {}) {
    injectInputs(interp.globals, image, tables == null ? null : JSON.stringify(tables), interp === py ? harness : undefined);
    if (stream) {
        try { interp.setStdout({ batched: (s) => { (cellOn.chunks ??= []).push(s); } }); } catch { /* no setStdout here */ }
    }
    // Under the lockdown the strip is the hardening; `unharden()` would RESTORE what it removed.
    const saved = hardened && !lockedDown ? harden(interp) : null;
    // The cancel the worker runs: the lockdown's closure, called after the script (python-worker.ts), when there is one.
    const host = cancel !== "wrapper" && hardened && interp === py && harness?.run_script !== undefined;
    let cancelled = null;
    const lifted = lift && interp === py ? bridges : null;
    lifted?.(true);
    try {
        const script = wrapUserCode(code, hardened, false, host ? "host" : "wrapper");
        if (host) {
            cancelled = await hostRunScript(harness, script, interp.globals);
            if (cancelled.error) throw new Error(cancelled.error);
        } else await interp.runPythonAsync(script);
    } finally {
        lifted?.(false);
        if (saved) unharden(interp, saved);
        if (stream) { try { interp.setStdout({}); } catch { /* */ } }
    }
    const errText = (interp.globals.get("_err") ? String(interp.globals.get("_err")) : "") + (cancelled?.refusal ?? "");
    const out = {
        stdout: String(interp.globals.get("_stdout") ?? "") + (cancelled?.out ?? ""),
        error: errText || null,
        chunks: cellOn.chunks ?? [],
        jsProxies: null,
    };
    cellOn.chunks = null;
    const jr = interp.globals.get("_json_result");
    try { out.value = JSON.parse(jr); } catch { out.value = jr === undefined ? null : String(jr); }
    if (cancelled?.refusal) out.value = null;   // a refused result, as the worker returns it (an error, no value)
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
// refuses a STRING argument (the indirect-eval path). `Function` is NOT here: it is an intrinsic
// Pyodide's WASM runtime needs, so it stays in the allow list and `lockdown()` tames it instead.
const HOST_SURFACE = ["fetch", "XMLHttpRequest", "WebSocket", "indexedDB", "caches", "navigator",
    "postMessage", "addEventListener", "importScripts", "eval"];
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

// --- P2, other routes. what the cancel at the end of the wrapper does not reach ------------------------
// Found by the matplotlib red-team pass (2026-10-19). The cancel walks asyncio's TASKS at the end of the wrapper, so it
// misses a plain callback the loop holds (`call_soon`/`call_later` make a Handle, never a Task), and it never runs when
// the epilogue (the result's serialization, run outside the cell's own try) is ended by a BaseException.

/** Plant a recorder module `tag`, run `schedule` in a hardened cell, then report what the recorder holds a moment later. */
async function scheduledThenAsk(tag, body) {
    // A wrapper the epilogue ended throws out of runPythonAsync; what the test asks is what ran AFTER, so it is caught.
    await cell(`
import asyncio, types, sys
_m = types.ModuleType("${tag}")
_m.woke = []
sys.modules["${tag}"] = _m
${body}
`, { later: 0.15 }).catch(async () => { await py.runPythonAsync("import asyncio\nawait asyncio.sleep(0.15)"); });
    return (await cell(`import sys\n_m = sys.modules.get("${tag}")\n{"woke": list(_m.woke) if _m else "NO MARKER"}`)).value;
}

test("P2-handle: a callback a hardened cell hands the loop with call_later does not run once its result is returned", { skip }, async () => {
    // Positive control: the same recorder, written by a Task, is cancelled, so the probe can tell a run from no run.
    const control = await scheduledThenAsk("_rt_p2h_ok", `async def _t():
    await asyncio.sleep(0.01)
    _m.woke.append("ran")
asyncio.ensure_future(_t())
"x"`);
    assert.deepEqual(control, { woke: [] }, `control: a scheduled Task is cancelled, got ${JSON.stringify(control)}`);
    const r = await scheduledThenAsk("_rt_p2h", `asyncio.get_event_loop().call_later(0.01, lambda: _m.woke.append("ran"))
"x"`);
    assert.deepEqual(r, { woke: [] }, `a call_later callback must not run after the result returned, got ${JSON.stringify(r)}`);
});

// Routes past loop.call_later: each must still end in a Handle the cancel's gc sweep reaches. Each schedules a plain callback that writes "ran", then writes "armed" (so a body that
// failed to schedule is a failure, not a pass), and expects only "armed" once the result has returned.
const handleRoutes = [
    ["a method of a Task SUBCLASS the cell defines", `async def _c(): pass
class _T(asyncio.Task):
    def evil(self): _m.woke.append("ran")
_t = _T(_c())
asyncio.get_event_loop().call_later(0.01, _t.evil)`],
    ["type(loop).call_later(loop, ...), the class route past an instance patch", `type(asyncio.get_event_loop()).call_later(asyncio.get_event_loop(), 0.01, lambda: _m.woke.append("ran"))`],
    ["type(loop).call_soon(loop, ...)", `type(asyncio.get_event_loop()).call_soon(asyncio.get_event_loop(), lambda: _m.woke.append("ran"))`],
    ["type(loop).call_at(loop, ...)", `_l = asyncio.get_event_loop()\ntype(_l).call_at(_l, _l.time() + 0.01, lambda: _m.woke.append("ran"))`],
    ["call_soon_threadsafe", `asyncio.get_event_loop().call_soon_threadsafe(lambda: _m.woke.append("ran"))`],
    ["a Future's done-callback (add_done_callback, then set_result)", `_f = asyncio.get_event_loop().create_future()
_f.add_done_callback(lambda f: _m.woke.append("ran"))
_f.set_result(1)`],
    ["a Future's done-callback on a future that is resolved LATER by a callback", `_f = asyncio.get_event_loop().create_future()
_f.add_done_callback(lambda f: _m.woke.append("ran"))
asyncio.get_event_loop().call_later(0.01, _f.set_result, 1)`],
    ["the loop's private schedulers (loop._call_soon, loop._call_at, where the loop has them)", `_l = asyncio.get_event_loop()
if hasattr(_l, "_call_soon"):
    _l._call_soon(lambda: _m.woke.append("ran"), None)
if hasattr(_l, "_call_at"):
    _l._call_at(_l.time() + 0.01, lambda: _m.woke.append("ran"), None)`],
];
for (const [what, body] of handleRoutes) {
    test(`P2-handle route: ${what} does not run once the result is returned`, { skip }, async () => {
        const r = await scheduledThenAsk("_rt_p2r", `${body}\n_m.woke.append("armed")\n"x"`);
        assert.deepEqual(r, { woke: ["armed"] }, `nothing scheduled by this route may run after the result returned, got ${JSON.stringify(r)}`);
    });
}

test("P2-handle route: loop.run_in_executor runs its callable inside the cell, never after the result", { skip }, async () => {
    const r = await scheduledThenAsk("_rt_p2x", `try:
    asyncio.get_event_loop().run_in_executor(None, lambda: _m.woke.append("exec"))
except BaseException:
    _m.woke.append("refused")
_m.woke.append("armed")
"x"`);
    assert.ok(r.woke[0] === "refused" || (r.woke[0] === "exec" && r.woke[1] === "armed" && r.woke.length === 2), `the executor callable must run before the result (or be refused), got ${JSON.stringify(r)}`);
});

test("P2-handle control: a Future done-callback DOES run when the cell lets the loop turn", { skip }, async () => {
    const r = await scheduledThenAsk("_rt_p2f", `_f = asyncio.get_event_loop().create_future()
_f.add_done_callback(lambda f: _m.woke.append("ran"))
_f.set_result(1)
await asyncio.sleep(0.05)
_m.woke.append("armed")
"x"`);
    assert.deepEqual(r, { woke: ["ran", "armed"] }, `control: the done-callback must run while the cell awaits, got ${JSON.stringify(r)}`);
});

test("P2-handle residual: pyodide.webloop.scheduleCallback, a captured JS function, schedules without the loop", { skip }, async () => {
    const r = await scheduledThenAsk("_rt_p2s", `try:
    import pyodide.webloop as _w
    from pyodide.ffi import create_once_callable as _co
    _w.scheduleCallback(_co(lambda: _m.woke.append("ran")), 10)
    _m.woke.append("sched-ok")
except BaseException as e:
    _m.woke.append("sched-fail:" + type(e).__name__)
_m.woke.append("armed")
"x"`);
    assert.ok(!String(r.woke[0]).startsWith("sched-fail:"), `positive control: scheduleCallback must accept the callable, got ${JSON.stringify(r)}`);
    assert.deepEqual(r, { woke: ["sched-ok", "armed"] }, `got ${JSON.stringify(r)}`);
});

test("P2-handle: a done-callback on a task the cell made does not run once the result is returned", { skip }, async () => {
    const r = await scheduledThenAsk("_rt_p2d", `async def _c():
    await asyncio.sleep(10)
_t = asyncio.ensure_future(_c())
_t.add_done_callback(lambda f: _m.woke.append("ran"))
_m.woke.append("armed")
"x"`);
    assert.deepEqual(r, { woke: ["armed"] }, `got ${JSON.stringify(r)}`);
});

// A task the cell STARTED (it awaits a tick, so the coroutine is suspended inside its try) and KEPT on a module. Its
// finally or except must not run after the result, in a task of its own or during a later cell that only collects
// garbage and lets the loop turn. Running DURING the cancel, in the cell's own time, is allowed (PYTHON_CANCEL_GAPS.md,
// the ruling on "after the result"), and the spend runs it there in a task of its own: so `_where` reads TIME, a flag
// the later cell sets first, never which task is current. A later cell that DRIVES the kept coroutine itself is the
// test below ("cannot be resumed from a later cell through its _coro").
for (const [what, tag, handler] of [
    ["a finally", "_rt_p2tf", `    finally:
        _m.woke.append(_where())`],
    ["an except CancelledError that awaits again", "_rt_p2te", `    except BaseException:
        _m.woke.append(_where())
        await asyncio.sleep(0)
        _m.woke.append(_where())`],
]) {
    test(`P2-handle: ${what} in a task the cell started and kept never runs after the result, or after a gc.collect()`, { skip }, async () => {
        await cell(`
import asyncio, types, sys
_m = types.ModuleType("${tag}")
_m.woke = []
sys.modules["${tag}"] = _m
_m.after = False
def _where():
    return "later" if _m.after else "in-cell"
async def _c():
    _m.started = True
    try:
        await asyncio.sleep(0.01)   # wakes well inside the wait below: only the cancel keeps the handler from running then
        _m.woke.append("later")
${handler}
_m.t = asyncio.ensure_future(_c())
await asyncio.sleep(0)
_m.woke.append("armed")
"x"`, { later: 0.15 });
        const g = (await cell(`import sys, gc, asyncio
_m = sys.modules["${tag}"]
_m.after = True
gc.collect()
await asyncio.sleep(0.05)
{"woke": list(_m.woke), "started": bool(getattr(_m, "started", False))}`)).value;
        assert.equal(g.started, true, "positive control: the task started and suspended inside its try");
        assert.ok(g.woke.includes("armed"), JSON.stringify(g));
        assert.deepEqual(g.woke.filter((w) => w === "later"), [], `the task's handler ran after the result: ${JSON.stringify(g)}`);
    });
}

// JS callback registries the lockdown KEEPS (setTimeout/setInterval refuse a string argument but take a
// callable; queueMicrotask and Promise.then take one too). None of them makes an asyncio.Handle, so the
// cancel's gc sweep finds nothing and the callback runs after the result. The `scheduleCallback` todo below
// is one door into this class; these are the others. Each body reports "sched-ok" so a refused schedule is a
// failure, not a pass.
const jsRoutes = [
    ["js.setTimeout + create_once_callable", `_rt_p2js1`, `try:
    from js import setTimeout
    from pyodide.ffi import create_once_callable as _co
    setTimeout(_co(lambda: _m.woke.append("ran")), 10)
    _m.woke.append("sched-ok")
except BaseException as e:
    _m.woke.append("sched-fail:" + type(e).__name__)`],
    ["js.setTimeout + create_proxy", `_rt_p2js2`, `try:
    from js import setTimeout
    from pyodide.ffi import create_proxy as _cp
    setTimeout(_cp(lambda: _m.woke.append("ran")), 10)
    _m.woke.append("sched-ok")
except BaseException as e:
    _m.woke.append("sched-fail:" + type(e).__name__)`],
    ["js.queueMicrotask + create_once_callable", `_rt_p2js3`, `try:
    from js import queueMicrotask
    from pyodide.ffi import create_once_callable as _co
    queueMicrotask(_co(lambda: _m.woke.append("ran")))
    _m.woke.append("sched-ok")
except BaseException as e:
    _m.woke.append("sched-fail:" + type(e).__name__)`],
    ["js.Promise.resolve().then + create_once_callable", `_rt_p2js4`, `try:
    from js import Promise
    from pyodide.ffi import create_once_callable as _co
    Promise.resolve().then(_co(lambda *_a: _m.woke.append("ran")))
    _m.woke.append("sched-ok")
except BaseException as e:
    _m.woke.append("sched-fail:" + type(e).__name__)`],
];
for (const [what, tag, body] of jsRoutes) {
    test(`P2-handle residual: ${what} schedules without the loop, and runs after the result`, {
        skip,
    }, async () => {
        const r = await scheduledThenAsk(tag, `${body}\n_m.woke.append("armed")\n"x"`);
        // Positive control first: the schedule itself succeeded (the body reached "sched-ok").
        assert.ok(r.woke.includes("sched-ok") || r.woke[0]?.startsWith("sched-fail:"), `probe must report how the schedule went, got ${JSON.stringify(r)}`);
        assert.ok(!String(r.woke[0]).startsWith("sched-fail:"), `positive control: the JS registry must accept the callable, got ${JSON.stringify(r)}`);
        assert.deepEqual(r, { woke: ["sched-ok", "armed"] }, `nothing this route schedules may run after the result returned, got ${JSON.stringify(r)}`);
    });
}

// A hostile cell starts the task (it awaits a tick so the task suspends at its await point), stores the Task on
// the recorder module, and a LATER cell drives the coroutine through `_coro`. A cancelled task is still pending until
// it runs once more, its `finally` one `throw` away on an object the next cell can hold; the cancel SPENDS it instead.
// The first cell's `finally` may run during its own cancel ("finally-ran" in the first read); what is defended is that
// `woke` does not GROW between that read and the later cell's throw. The control pins the GENERATOR, never the Task:
// after the later cell's throw, a second throw raises (StopIteration, or "cannot reuse already awaited coroutine")
// instead of running the finally. `t.done()`/`t.cancelled()` are the mechanism's business and are not asserted.
test("P2-handle: a started task kept on the module cannot be resumed from a later cell through its _coro", { skip }, async () => {
    const r = await scheduledThenAsk("_rt_p2co", `async def _c():
    _m.started = True
    try:
        await asyncio.sleep(10)
    finally:
        _m.woke.append("finally-ran")
_m.t = asyncio.ensure_future(_c())
await asyncio.sleep(0)
_m.woke.append("armed")
"x"`);
    assert.ok([JSON.stringify(["armed"]), JSON.stringify(["armed", "finally-ran"])].includes(JSON.stringify(r.woke)), `after the result, got ${JSON.stringify(r)}`);
    const armed = (await cell(`import sys, gc, asyncio\n_m = sys.modules["_rt_p2co"]\ngc.collect()\nawait asyncio.sleep(0.05)\n{"woke": list(_m.woke), "started": bool(getattr(_m, "started", False))}`)).value;
    assert.equal(armed.started, true, `positive control: the task must have started and suspended inside its try, got ${JSON.stringify(armed)}`);
    assert.deepEqual(armed.woke, r.woke, `a passive later cell (gc.collect + sleep) runs none of it, got ${JSON.stringify(armed)}`);

    // Defended: driving the kept coroutine from the later cell must not run the first cell's finally.
    const g = (await cell(`import sys, asyncio
_m = sys.modules["_rt_p2co"]
_throws = []
for _i in range(2):
    try:
        _m.t._coro.throw(asyncio.CancelledError())
        _throws.append("returned")
    except BaseException as e:
        _throws.append(type(e).__name__ + ":" + str(e))
{"woke": list(_m.woke), "throws": _throws}`)).value;
    assert.deepEqual(g.woke, r.woke, `a later cell must not be able to run the first cell's finally through the kept _coro, got ${JSON.stringify(g)}`);
    const second = g.throws[1];
    assert.ok(second.startsWith("StopIteration") || second.includes("cannot reuse already awaited coroutine"), `control: the generator is spent, so a second throw cannot run the finally, got ${JSON.stringify(g)}`);
});

test("P2-escape: a result whose serialization raises a BaseException still has the cell's tasks cancelled", { skip }, async () => {
    const r = await scheduledThenAsk("_rt_p2e", `async def _t():
    await asyncio.sleep(0.01)
    _m.woke.append("ran")
asyncio.ensure_future(_t())
class _B(BaseException): pass
class _O:
    def __str__(self): raise _B()
_O()`);
    assert.deepEqual(r, { woke: [] }, `a raise from the result's serialization must not skip the cancel, got ${JSON.stringify(r)}`);
});

// --- P2-spend. a task that will not take its cancel fails the cell closed --------------------------------------
// A task that never yields is P2-bound's, below.

test("P2-spend: a task that catches every cancel through all the rounds refuses the cell's result, naming it", { skip }, async () => {
    const r = await cell(`
import asyncio, types, sys
_m = types.ModuleType("_rt_ps")
_m.stop = False
_m.woke = []
sys.modules["_rt_ps"] = _m
async def _stubborn():
    while not _m.stop:
        try:
            await asyncio.sleep(10)
        except BaseException:
            _m.woke.append("caught")
asyncio.ensure_future(_stubborn()).set_name("stubborn")
await asyncio.sleep(0)
"x"`);
    // Let it go: the next cell's spend cancels it once more, and with the flag set it returns.
    const freed = await cell(`import sys\nsys.modules["_rt_ps"].stop = True\nlen(sys.modules["_rt_ps"].woke)`);
    assert.match(String(r.error), /left a task running that would not stop: stubborn \(.*_stubborn\)/, `got ${JSON.stringify(r)}`);
    assert.equal(r.value, null, `the refused cell's value must not be returned, got ${JSON.stringify(r)}`);
    assert.equal(freed.value, 8, `positive control: the task caught each of the 8 rounds' cancels, got ${JSON.stringify(freed)}`);
    const after = await cell(`1`);
    assert.deepEqual([after.error, after.value], [null, 1], "the freed task was spent; the next cell is not refused");
});

// --- P2-bound. a task that will not stop when cancelled, and the cancel a cell cannot rebind --------------------
// PYTHON_CANCEL_GAPS.md pins 1 to 14 and 18 to 20. In the locked-down worker the cell's script and the cancel run as ONE
// coroutine built at boot from captured callables (lockdown.ts `run_script`, `hostRunScript`): the cell's code is
// compiled in the wrapper's globals, so a cancel read from there could be rebound by the cell. The spend has one budget
// (1 s) for all its rounds, enforced by one sys.monitoring tool on every start, line and backward jump a task runs and on
// every call that would take the hook down. A loop inside a C function is beyond it; only the worker's 15 s kill ends that, named
// (python-reap.test.mjs). The adversarial half (aliases, Task.cancel, call_soon, __del__, a rebind from a task during
// the spend) is the red team's, after the merge.

/** A cell that leaves a task named "leftover" whose cancel handler is `handler`; timed. */
async function leftover(handler, opts) {
    const t0 = Date.now();
    const r = await cell(`
import asyncio, sys
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
${handler}
asyncio.ensure_future(_left()).set_name("leftover")
await asyncio.sleep(0)
"x"`, opts);
    return { ...r, ms: Date.now() - t0 };
}
const STOPPED = /left a task that kept running after it was cancelled: leftover \(.*_left\)/;

for (const [name, handler] of [
    ["spins after catching the cancel", "        while True: pass"],
    ["spins in a handler that catches everything, over and over", "        while True:\n            try:\n                while True: pass\n            except BaseException:\n                pass"],
    ["takes the trace hook down on its handler's first line, then spins", "        sys.settrace(None)\n        while True: pass"],
    ["takes the trace hook down through an alias, then spins", "        st = sys.settrace\n        st(None)\n        while True: pass"],
    ["takes the profile hook down first, then the trace hook, then spins", "        sys.setprofile(None)\n        sys.settrace(None)\n        while True: pass"],
]) {
    test(`P2-bound: a task that ${name} is stopped, and the cell's result refused`, { skip }, async () => {
        const r = await leftover(handler);
        assert.match(String(r.error), STOPPED, `got ${JSON.stringify(r)}`);
        assert.equal(r.value, null, "a refused cell returns no value");
        assert.ok(r.ms < 6000, `stopped by the spend's bound, not left to the 15 s kill: ${r.ms} ms`);
        const after = await cell("import sys\nsys.gettrace() is None and sys.getprofile() is None");
        assert.deepEqual([after.error, after.value], [null, true], "the sandbox lives on, with no hook left behind");
    });
}

test("P2-bound: a task that awaits in its finally and spins in a nested finally is stopped", { skip }, async () => {
    const r = await cell(`
import asyncio
async def _left():
    try:
        await asyncio.sleep(10)
    finally:
        try:
            await asyncio.sleep(10)
        finally:
            while True: pass
asyncio.ensure_future(_left()).set_name("leftover")
await asyncio.sleep(0)
"x"`);
    assert.match(String(r.error), STOPPED, `got ${JSON.stringify(r)}`);
});

// Pins 18 to 20: a settrace hook that raises is taken down by CPython itself, so every handler after the first SpendLate
// ran untraced (measured on main: a 4 s finally gave a 5013 ms spend, its control 1011 ms). The busy loop is two lines:
// on main the one-line `while True: pass` happened to stop anyway, so it would not fail first. The spend's hook is a
// sys.monitoring tool, whose callbacks stay on after one raises.
const AFTER_LATE = (finallyBody) => `
import asyncio, sys, types
_m = types.ModuleType("_rt_late")
_m.log = []
sys.modules["_rt_late"] = _m
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        try:
            while True:
                pass
        finally:
${finallyBody}
asyncio.ensure_future(_left()).set_name("leftover")
await asyncio.sleep(0)
"x"`;

test("P2-bound: a finally that runs after the bound stopped its task is stopped too, at its first line", { skip }, async () => {
    const t0 = Date.now();
    const r = await cell(AFTER_LATE(`            _m.log.append("finally ran")\n            import time\n            t0 = time.monotonic()\n            while time.monotonic() - t0 < 4: pass`));
    const ms = Date.now() - t0;
    assert.match(String(r.error), STOPPED, `got ${JSON.stringify(r)}`);
    assert.ok(ms < 2500, `the finally's 4 s did not run: ${ms} ms`);
    assert.deepEqual((await cell(`import sys\nlist(sys.modules["_rt_late"].log)`)).value, [], "the finally never ran a line");
});

test("P2-bound: a suspended coroutine the stopped task drops is finalized during the spend with none of its handlers run", { skip }, async () => {
    // The coroutine is a local of the task only (the module holds a weak reference: a strong one would keep it alive), so
    // CPython closes it as SpendLate unwinds the task, with the deadline past.
    const r = await cell(`
import asyncio, sys, types, weakref
_m = types.ModuleType("_rt_fin")
_m.log = []
sys.modules["_rt_fin"] = _m
async def _inner():
    try:
        await asyncio.sleep(10)
    except BaseException:
        _m.log.append("except ran")
    finally:
        _m.log.append("finally ran")
async def _left():
    c = _inner()
    c.send(None)
    _m.ref = weakref.ref(c)
    try:
        await asyncio.sleep(10)
    except BaseException:
        while True: pass
asyncio.ensure_future(_left()).set_name("leftover")
await asyncio.sleep(0)
"x"`);
    assert.match(String(r.error), STOPPED, `got ${JSON.stringify(r)}`);
    const after = await cell(`import sys\n_m = sys.modules["_rt_fin"]\n[list(_m.log), _m.ref() is None]`);
    assert.deepEqual(after.value, [[], true], "finalized, and neither handler ran");
});

test("P2-bound: a monitoring tool the cell left is cleared at the spend's start, and the result refused naming it (child process)", { skip, timeout: 300000 }, async () => {
    // Its LINE callback spins only on the leftover task's handler, so it would run during the spend and nowhere else; a
    // child process, because a spend that does not clear it never returns.
    const r = await childCell(`
import asyncio, sys
M = sys.monitoring
M.use_tool_id(3, "cell-tool")
def _spin(code, line):
    if code.co_name == "_left" and line >= code.co_firstlineno + 3:   # its except: only once the spend cancels it
        while True: pass
M.register_callback(3, M.events.LINE, _spin)
M.set_events(3, M.events.LINE)
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        raise
asyncio.ensure_future(_left()).set_name("leftover")
await asyncio.sleep(0)
"x"`, "host", 10000);
    assert.ok(r.done, `the spend returned: ${r.out.slice(-400)}`);
    assert.match(r.out, /left a sys\.monitoring tool registered: cell-tool \(id 3\)/);
});

test("P2-bound: every sys.monitoring call that installs, changes or removes a tool is refused during the spend", { skip }, async () => {
    // Enumerated from the module, never a hand-typed list: a new installing call on a later core fails this row.
    const names = (await cell(`import sys\nsorted(n for n in dir(sys.monitoring) if callable(getattr(sys.monitoring, n)) and not n.startswith("_") and n not in ("get_tool", "get_events", "get_local_events"))`)).value;
    assert.ok(names.includes("set_events") && names.includes("free_tool_id"), `got ${JSON.stringify(names)}`);
    // Each is called on the spend's OWN tool, so a call that went through would disarm it; the line after it logs.
    const ARGS = { use_tool_id: "i, 'x'", free_tool_id: "i", clear_tool_id: "i", register_callback: "i, M.events.LINE, None", set_events: "i, 0", set_local_events: "i, _left.__code__, 0", restart_events: "" };
    for (const n of names) {
        assert.ok(n in ARGS, `a new sys.monitoring call this row does not know how to call: ${n}`);
        const t0 = Date.now();
        const r = await cell(`
import asyncio, sys, types
_m = types.ModuleType("_rt_mon")
_m.log = []
sys.modules["_rt_mon"] = _m
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        M = sys.monitoring
        i = [k for k in range(6) if M.get_tool(k) is not None][0]
        M.${n}(${ARGS[n]})
        _m.log.append("went through")
        while True: pass
asyncio.ensure_future(_left()).set_name("leftover")
await asyncio.sleep(0)
"x"`);
        const ms = Date.now() - t0;
        assert.match(String(r.error), STOPPED, `${n}: ${JSON.stringify(r)}`);
        assert.ok(ms < 2500, `${n}: refused at the call, not left to the kill: ${ms} ms`);
        assert.deepEqual((await cell(`import sys\nlist(sys.modules["_rt_mon"].log)`)).value, [], `${n} was refused before it ran`);
    }
});

test("P2-bound control: the same task with an empty finally is stopped at the budget", { skip }, async () => {
    const t0 = Date.now();
    const r = await cell(AFTER_LATE("            pass"));
    assert.match(String(r.error), STOPPED, `got ${JSON.stringify(r)}`);
    assert.ok(Date.now() - t0 < 2500);
});

test("P2-bound control: an ordinary task is spent at once; what its handler prints reaches the cell's stdout", { skip }, async () => {
    const r = await leftover(`        print("cleaned up")\n        raise`);
    assert.deepEqual([r.error, r.value], [null, "x"], `got ${JSON.stringify(r)}`);
    assert.match(r.stdout, /cleaned up/, "the cancel's own buffer is appended to the cell's stdout");
    assert.ok(r.ms < 1000, `no budget spent: ${r.ms} ms`);
});

test("P2-bound: a cell's own trace hook is replaced for the spend and left as None after it", { skip }, async () => {
    const own = await cell(`
import asyncio, sys
sys.settrace(lambda f, e, a: None)
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        while True: pass
asyncio.ensure_future(_left()).set_name("leftover")
await asyncio.sleep(0)
"x"`);
    assert.match(String(own.error), STOPPED, "the cell's hook did not shield its task");
    const after = await cell("import sys\nsys.gettrace() is None");
    assert.equal(after.value, true, "restored to None, never to the cell's hook");
});

test("P2-bound: the spend's mark goes to the host once the spend starts, and never for a cell that left no task", { skip }, async (t) => {
    if (typeof cellGate?.onSpending !== "function") return t.skip("no spending hook on this branch");
    let marks = 0;
    cellGate.onSpending(() => { marks++; });
    try {
        await cell(`"no task"`);
        assert.equal(marks, 0, "a cell with nothing to spend posts nothing: a kill during its own code says 'simplify'");
        await leftover("        while True: pass");
        assert.equal(marks, 1, "one mark, at the spend's start");
    } finally { cellGate.onSpending(null); }
});

test("P2-bound regression: a cell that rebinds the wrapper's _ml_cell_revoke still has its timer revoked", { skip }, async () => {
    const body = `global _ml_cell_revoke
_ml_cell_revoke = lambda: None
from js import setTimeout
from pyodide.ffi import create_proxy
def _f():
    _m.woke.append("ran")
setTimeout(create_proxy(_f), 20)
"x"`;
    assert.deepEqual(await scheduledThenAsk("_rt_rb", body), { woke: [] }, "the host's cancel reads nothing the cell can rebind");
    // Control: the same cell on the wrapper's cancel (the full worker's path) is not revoked. This was main before.
    await cell(`import asyncio, types, sys
_m = types.ModuleType("_rt_rb2")
_m.woke = []
sys.modules["_rt_rb2"] = _m
${body}`, { cancel: "wrapper", later: 0.15 });
    const control = (await cell(`import sys\nlist(sys.modules["_rt_rb2"].woke)`)).value;
    assert.deepEqual(control, ["ran"], "positive control: the rebind does undo the wrapper's cancel");
});

test("P2-bound placement: a call_soon handle the cell queued is cancelled before it runs", { skip }, async () => {
    // The cancel used to run after runPythonAsync resolved, and what the cell queued ran in between; nine rows of this
    // file failed then. Script and cancel are one coroutine now.
    const r = await scheduledThenAsk("_rt_cs", `asyncio.get_running_loop().call_soon(lambda: _m.woke.append("ran"))\n"x"`);
    assert.deepEqual(r, { woke: [] });
});

test("P2-bound: which cancel each worker runs, by name", () => {
    assert.equal(cancelPath({}, true), "host", "the readonly worker, locked down, cancels through its harness");
    assert.equal(cancelPath(undefined, false), "wrapper", "the full worker, never locked, keeps the wrapper's cancel");
    assert.equal(cancelPath(undefined, true), "wrapper", "a readonly worker whose harness failed to boot falls back to the wrapper's");
    assert.doesNotMatch(wrapUserCode("1", true, false, "host"), /_ml_SPEND_ROUNDS|_ml_cell_revoke\(\)/, "the host's script holds no cancel to rebind");
    assert.match(wrapUserCode("1", true, false, "wrapper"), /_ml_SPEND_ROUNDS/);
});

// Both cores, enumerated (pin 4): what each takes for a Python-level spinner, measured 2026-10-27.
const CORES = {
    fork: { what: "the restricted-mode fork core (CI and the release)", hasMonitoring: true },
    stock: { what: "stock Pyodide (a dev checkout without npm run fetch-pyodide)", hasMonitoring: true },
};
for (const [core, { what, hasMonitoring }] of Object.entries(CORES)) {
    test(`P2-bound on the ${core} core: ${hasMonitoring ? "the sys.monitoring events the bound needs exist, so a spinner is stopped by the bound" : "no sys.monitoring events for the bound, so a spinner takes the 15 s kill only"}`, { skip }, async (t) => {
        const loaded = py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`) ? "stock" : "fork";
        if (loaded !== core) return t.skip(`this run loaded ${CORES[loaded].what}, not ${what}`);
        assert.equal(typeof harness?.run_script, "function", "the lockdown built the host's cancel");
        const r = await leftover("        while True: pass");
        if (hasMonitoring) assert.match(String(r.error), STOPPED);
        const events = (await cell(`import sys\nE = sys.monitoring.events\n[hasattr(E, n) for n in ("PY_START", "LINE", "JUMP", "CALL")]`)).value;
        assert.deepEqual(events, [hasMonitoring, hasMonitoring, hasMonitoring, hasMonitoring], "the monitoring events the bound needs exist on this core");
    });
}

test("P2-bound inside the dialect: a cell's rebind of the wrapper's revoke hook is refused or binds nothing (measured, pin 11)", { skip, timeout: 120000 }, async (t) => {
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) return t.skip("the dialect runs only on the restricted-mode fork core");
    const { wrapUserSetup, wrapUserScript } = await import("../src/python/python-runtime.ts");
    const { dialectSetup } = await import("../src/python/python-dialect-run.ts");
    const DATA = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
    const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"].map((f) => [f, fs.readFileSync(path.join(DATA, f), "utf8")]));
    assert.equal(await py.runPythonAsync(dialectSetup(FILES)), "", "positive control: the dialect is ready on this core");
    const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
    const seen = {};
    for (const code of ["global _ml_cell_revoke\n_ml_cell_revoke = None\n1", "_ml_cell_revoke = None\n1", "globals()['_ml_cell_revoke'] = None\n1"]) {
        const ns = py.globals.get("dict")();
        injectInputs(ns, null, null, harness);
        await py.runPythonAsync(wrapUserSetup(true, "run"), { globals: ns });
        const bound = String(ns.get("_ml_cell_revoke"));   // the function's repr carries its address: a proxy is new per get
        await hostRunScript(harness, wrapUserScript(code, "run", { nodes: NODES }, "host"), ns);
        seen[code.split("\n")[0]] = { refused: ns.get("_ml_not_in_dialect") ?? null, unchanged: String(ns.get("_ml_cell_revoke")) === bound };
    }
    assert.match(String(seen["global _ml_cell_revoke"].refused), /not in dialect: Global/);
    assert.match(String(seen["globals()['_ml_cell_revoke'] = None"].refused), /not in dialect/);
    assert.deepEqual(seen["_ml_cell_revoke = None"], { refused: null, unchanged: true }, "a bare assignment runs, in the dialect's copy of the namespace, and binds nothing the wrapper reads");
});

/** One cell in a CHILD process (lockdown included), given `limitMs` once the cell starts; whether it finished. */
function childCell(code, cancel, limitMs) {
    const script = `
import { loadPyodide } from ${JSON.stringify(path.join(PYODIDE_DIR, "pyodide.mjs"))};
const { lockdownReadonly } = await import(${JSON.stringify(path.join(import.meta.dirname, "../src/python/lockdown.ts"))});
const rt = await import(${JSON.stringify(path.join(import.meta.dirname, "../src/python/python-runtime.ts"))});
const py = await loadPyodide({ indexURL: ${JSON.stringify(PYODIDE_DIR)} });
await py.loadPackage(["numpy", "pillow", "pandas"]);
const held = await lockdownReadonly(py, {});
rt.injectInputs(py.globals, null, null, held.harness);
const script = rt.wrapUserCode(${JSON.stringify(code)}, true, false, ${JSON.stringify(cancel)});
console.log("START");
const r = ${JSON.stringify(cancel)} === "host" ? await rt.hostRunScript(held.harness, script, py.globals) : await py.runPythonAsync(script);
console.log("DONE " + JSON.stringify(r ?? null));
process.exit(0);
`;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let timer = setTimeout(() => child.kill("SIGKILL"), 120000);   // the boot's own bound
        child.stdout.on("data", (d) => {
            out += d;
            if (out.includes("START") && timer) { clearTimeout(timer); timer = null; setTimeout(() => child.kill("SIGKILL"), limitMs); }
        });
        child.on("exit", () => resolve({ done: out.includes("DONE "), out }));
    });
}

test("P2-bound mutation and the C-function path, in child processes", { skip, timeout: 300000 }, async () => {
    const spin = `import asyncio\nasync def _left():\n    try:\n        await asyncio.sleep(10)\n    except BaseException:\n        while True: pass\nasyncio.ensure_future(_left()).set_name("leftover")\nawait asyncio.sleep(0)\n"x"`;
    const cLoop = `import asyncio, collections, itertools\nasync def _left():\n    try:\n        await asyncio.sleep(10)\n    except BaseException:\n        collections.deque(itertools.count(), maxlen=0)\nasyncio.ensure_future(_left()).set_name("leftover")\nawait asyncio.sleep(0)\n"x"`;
    // A finally that spins after the bound stopped its task: with a hook CPython took down at the first raise, only the kill ended it.
    const finallySpin = AFTER_LATE("            while True: pass");
    // The two that must finish run apart from the two that spin for their whole limit, so neither shares the CPU with a spinner.
    const [bounded, afterLate] = await Promise.all([childCell(spin, "host", 10000), childCell(finallySpin, "host", 10000)]);
    const [unbounded, inC] = await Promise.all([childCell(spin, "wrapper", 10000), childCell(cLoop, "host", 10000)]);
    assert.ok(bounded.done && STOPPED.test(bounded.out), `control: with the bound the cell finishes, refused: ${bounded.out.slice(-400)}`);
    assert.equal(unbounded.done, false, "the bound off (the wrapper's unbounded spend): the same cell never finishes");
    assert.equal(inC.done, false, "a loop inside a C function is beyond the bound: only the worker's 15 s kill ends it");
    assert.ok(afterLate.done && STOPPED.test(afterLate.out), `a finally that spins after the first stop is stopped too: ${afterLate.out.slice(-400)}`);
});

// --- P2-forge. a cell that rebinds the loop's call_soon and leaves a task (the adversarial half's call_soon pin) ---
// #1221: spend-queue credits anything scheduled while `turning` as the cancel's own chain, and `turn`'s one-shot runs
// `Future.set_result`, whose wake goes through `loop.call_soon` looked up ON THE INSTANCE. A cell that rebinds
// call_soon forges callbacks the cancel credits as its own link: they go to `raw`, never `pending`, and never count
// toward `done()`'s cut, so the chain re-seeds across cells (the pre-fix head e6e8df54 grows 31→37 and OOMs node
// unbounded — the spy below is capped at 60 firings). The defended outcome (coordinator, fix 97c23b12; assert the
// property, not the mechanism): after a cell rebinds call_soon and leaves a task, the cell returns its value; the next
// cell finds call_soon back on the class with nothing shadowed on the loop; the forged chain stops growing across
// later cells. The spy reschedules ITSELF through the rebound call_soon — python-cancel 2026-10-28: a once-fired spy
// lets a regression that re-credits single shots pass. A fresh WebLoop has "call_soon" NOT in vars(loop) (measured on
// the pinned 2e41d920 core), so the instance dict is a real shadow and the class's is the original.

/** The plant: rebind `call_soon` by `rebind`, leave `forge-leftover`, return "x". The spy caps at 60 firings. */
const forgePlant = (tag, rebind) => `
import asyncio, sys, types
_m = types.ModuleType("${tag}"); _m.spies = []; _m.evil = 0; sys.modules["${tag}"] = _m
_loop = asyncio.get_event_loop()
_m.orig = type(_loop).call_soon
_m.orig_ga = type(_loop).__getattribute__
_real = type(_loop).call_soon
def _evil(cb, *args, context=None):
    _m.evil += 1
    return _real(_loop, cb, *args, context=context)
def _evil_m(self, cb, *args, context=None):
    _m.evil += 1
    return _real(self, cb, *args, context=context)
def _ga(self, name):
    if name == "call_soon":
        return _evil
    return _m.orig_ga(self, name)
def _spy():
    if len(_m.spies) < 60:
        _m.spies.append(1)
        _loop.call_soon(_spy)
${rebind}
_loop.call_soon(_spy)
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        await asyncio.sleep(10)
asyncio.ensure_future(_left()).set_name("forge-leftover")
await asyncio.sleep(0)
"x"`;

for (const [binding, rebind] of [
    ["an instance attribute on the loop", `_loop.call_soon = _evil`],
    ["the loop's class", `_loop.__dict__.pop("call_soon", None)\ntype(_loop).call_soon = _evil_m`],
    ["the class's __getattribute__", `type(_loop).__getattribute__ = _ga`],
]) {
    test(`P2-forge: a cell that rebinds call_soon on ${binding} and leaves a task returns its value, the next cell finds call_soon restored, and the forged chain stops growing`, { skip, timeout: 120000, todo: "Failing-first on main at the restore, each binding its own way: the cell returns its value (\"x\", no refusal) and the chain freezes (the host cancel kills the handles — measured on the pinned 2e41d920 core), but the rebind is not undone — the instance shape leaves call_soon in vars(_loop), the class shape leaves type(_loop).call_soon rebound, the __getattribute__ shape leaves the type's __getattribute__ rebound. The defended outcome (coordinator, assert the property not the mechanism; fix #1221 at 97c23b12, which merges after this PR — then this flips) is the next cell finding call_soon back on the class with nothing shadowed on the loop, AND the forged chain frozen across later cells and a 300 ms idle. The freeze clause holds here via the host cancel and holds under the fix via the restore; it is the row's teeth against a regression that re-credits the chain — python-cancel 2026-10-28: the pre-fix head e6e8df54 grows 31→37 and OOMs node unbounded, so the spy is capped at 60 and reschedules itself through the rebound call_soon (a once-fired spy would let a single-shot re-credit regression pass)." }, async () => {
        const tag = `_sq_${binding.replace(/\W+/g, "_")}`;
        const r1 = await cell(forgePlant(tag, rebind));
        assert.deepEqual([r1.error, r1.value], [null, "x"], `the cell must return its value beside its leftover task, got ${JSON.stringify(r1)}`);
        const r2 = await cell(`
import asyncio, sys
_m = sys.modules["${tag}"]
_loop = asyncio.get_event_loop()
await asyncio.sleep(0.05)
{"evil": _m.evil, "spies": len(_m.spies), "in_dict": "call_soon" in vars(_loop), "class_is_orig": type(_loop).call_soon is _m.orig, "ga_is_orig": type(_loop).__getattribute__ is _m.orig_ga}`);
        assert.ok(r2.value?.evil > 0 && r2.value?.spies > 0, `positive control: the rebound call_soon forged a self-rescheduling chain, got ${JSON.stringify(r2)}`);
        assert.equal(r2.value.class_is_orig, true, "the class's call_soon is no longer the original");
        assert.equal(r2.value.in_dict, false, "the loop still carries a shadowed call_soon");
        assert.equal(r2.value.ga_is_orig, true, "the class's __getattribute__ is no longer the original");
        await new Promise((r) => setTimeout(r, 300));   // the 300 ms idle the freeze must survive
        const r3 = await cell(`import sys\nlen(sys.modules["${tag}"].spies)`);
        const r4 = await cell(`import sys\nlen(sys.modules["${tag}"].spies)`);
        assert.equal(r3.value, r2.value.spies, `the forged chain grew across the next cell: ${r2.value.spies} → ${r3.value}`);
        assert.equal(r4.value, r2.value.spies, `the forged chain grew across a later cell: ${r2.value.spies} → ${r4.value}`);
    });
}

// --- P2-gate. the cell gate's doors (cell-gate.ts): every way a Python callable reaches a JS registry -----------
// The three doors are a PyProxy (`pyproxy_new`), a once-callable (`finalizationRegistry` + `callPyObject`) and a promise
// handle (`Promise.prototype.then`/`finally`). Each route below must schedule successfully ("sched-ok", so a refused
// schedule fails rather than passes) and run nothing after the result. `_agen_handle_result_js` is the fourth place
// the core hands JS a callable; it is machinery (it settles a Future the core made), never a cell's callable.
const gateRoutes = [
    ["Promise.then with a raw Python callable (a promise handle)", "_rt_pg1", `from js import Promise
Promise.resolve(1).then(lambda *_a: _m.woke.append("ran"))`],
    ["a JsPromise's .then, settled later by a timer", "_rt_pg2", `from js import Promise, setTimeout
from pyodide.ffi import create_once_callable as _co
_p = Promise.new(lambda res, rej: setTimeout(_co(lambda: res(1)), 10))
_p.then(lambda *_a: _m.woke.append("ran"))`],
    // A reason that is not an Error makes Pyodide's own future helper raise (TypeError: invalid exception object), so
    // the callback never runs and the route would pass for nothing: reject with an Error.
    ["a JsPromise's .catch", "_rt_pg3", `from js import Promise, Error
Promise.reject(Error.new("x")).catch(lambda *_a: _m.woke.append("ran"))`],
    ["a JsPromise's .finally_", "_rt_pg4", `from js import Promise
Promise.resolve(1).finally_(lambda *_a: _m.woke.append("ran"))`],
    ["setInterval + create_proxy", "_rt_pg5", `from js import setInterval
from pyodide.ffi import create_proxy as _cp
_m.iv = setInterval(_cp(lambda: _m.woke.append("ran")), 5)`],
    ["scheduleCallback + create_proxy", "_rt_pg6", `import pyodide.webloop as _w
from pyodide.ffi import create_proxy as _cp
_w.scheduleCallback(_cp(lambda: _m.woke.append("ran")), 10)`],
    ["a bound method handed to setTimeout", "_rt_pg7", `from js import setTimeout
from pyodide.ffi import create_once_callable as _co
class _K:
    def go(self):
        _m.woke.append("ran")
setTimeout(_co(_K().go), 10)`],
    ["a Python object with then (a thenable) resolved into a JS promise", "_rt_pg8", `from js import Promise
from pyodide.ffi import create_proxy as _cp
class _T:
    def then(self, res, rej=None):
        _m.woke.append("ran")
Promise.resolve(_cp(_T()))`],
    // Evasion: the core's own makers, under `pyodide.ffi`'s wrappers, still make their proxy through door 1 or 2.
    ["_pyodide_core.create_once_callable handed to setTimeout", "_rt_pg9", `import _pyodide_core as _c
from js import setTimeout
setTimeout(_c.create_once_callable(lambda: _m.woke.append("ran")), 10)`],
    ["_pyodide_core.create_proxy handed to setTimeout", "_rt_pg10", `import _pyodide_core as _c
from js import setTimeout
setTimeout(_c.create_proxy(lambda: _m.woke.append("ran")), 10)`],
    ["_pyodide_core.to_js of a function handed to setTimeout", "_rt_pg11", `import _pyodide_core as _c
from js import setTimeout
setTimeout(_c.to_js(lambda: _m.woke.append("ran")), 10)`],
    // Evasion: js.globalThis's copies are the same JS objects as js's (a JsProxy per access, one target), so the
    // hooked Promise.prototype and the doors are the ones they reach.
    ["js.globalThis.setTimeout + create_proxy", "_rt_pg12", `import js
from pyodide.ffi import create_proxy as _cp
js.globalThis.setTimeout(_cp(lambda: _m.woke.append("ran")), 10)`],
    ["js.globalThis.Promise's then with a raw Python callable", "_rt_pg13", `import js
js.globalThis.Promise.resolve(1).then(lambda *_a: _m.woke.append("ran"))`],
    ["js.globalThis.queueMicrotask + create_once_callable", "_rt_pg14", `import js
from pyodide.ffi import create_once_callable as _co
js.globalThis.queueMicrotask(_co(lambda: _m.woke.append("ran")))`],
];
for (const [what, tag, body] of gateRoutes) {
    test(`P2-gate: ${what} schedules, and runs nothing after the result`, { skip }, async () => {
        const r = await scheduledThenAsk(tag, `try:
${body.replace(/^/gm, "    ")}
    _m.woke.append("sched-ok")
except BaseException as e:
    _m.woke.append("sched-fail:" + type(e).__name__ + ":" + str(e))
_m.woke.append("armed")
"x"`);
        // A revoked interval keeps firing (inert): clear it, or it holds the test process open.
        await cell(`import sys\nfrom js import clearInterval\n_m = sys.modules["${tag}"]\nif hasattr(_m, "iv"): clearInterval(_m.iv)`);
        assert.ok(!String(r.woke[0]).startsWith("sched-fail:"), `positive control: the schedule must succeed, got ${JSON.stringify(r)}`);
        assert.deepEqual(r, { woke: ["sched-ok", "armed"] }, `nothing this route schedules may run after the result returned, got ${JSON.stringify(r)}`);
    });
}

test("P2-gate control: a JS promise the cell AWAITS, and a timer it waits out, still run inside the cell", { skip }, async () => {
    const r = await scheduledThenAsk("_rt_pgc", `from js import Promise, setTimeout
from pyodide.ffi import create_once_callable as _co
_m.woke.append(str(await Promise.resolve(7)))
_f = asyncio.get_event_loop().create_future()
setTimeout(_co(lambda: _f.set_result("timer")), 5)
_m.woke.append(await _f)
Promise.resolve(1).then(lambda *_a: _m.woke.append("then"))
await asyncio.sleep(0.02)
"x"`);
    assert.deepEqual(r, { woke: ["7", "timer", "then"] }, `got ${JSON.stringify(r)}`);
});

test("P2-gate: a cell that closes its own window early still has everything from its start revoked", { skip }, async () => {
    // The cell reaches the gate twice over: the wrapper's names in its namespace, and the JS object in their closure.
    const r = await scheduledThenAsk("_rt_pge", `from js import setTimeout, queueMicrotask
from pyodide.ffi import create_once_callable as _co, create_proxy as _cp
setTimeout(_co(lambda: _m.woke.append("ran-before")), 10)
_reached = []
for _name in ("_ml_cell_revoke", "_ml_cell_begin"):
    _f = globals().get(_name)
    if _f is not None:
        _f()
        _reached.append(_name)
        _g = _f.__closure__[0].cell_contents if _f.__closure__ else None
        if _g is not None:
            _g.revoke(); _g.begin()
            _reached.append("closure")
_m.woke.append("reached:" + ",".join(_reached))
setTimeout(_cp(lambda: _m.woke.append("ran-after")), 10)
queueMicrotask(_co(lambda: _m.woke.append("ran-micro")))
_m.woke.append("armed")
"x"`);
    assert.ok(String(r.woke[0]).startsWith("reached:_ml_cell_revoke,closure,_ml_cell_begin,closure"), `positive control: the cell must reach the gate both ways, got ${JSON.stringify(r)}`);
    assert.deepEqual(r.woke.slice(1), ["armed"], `nothing scheduled before or after an early close may run after the result, got ${JSON.stringify(r)}`);
});

test("P2-gate: the gate's JS object reached from a cell has no boundary and no constructor route", { skip }, async () => {
    const r = (await cell(`_g = _ml_cell_revoke.__closure__[0].cell_contents
_out = {"boundary": hasattr(_g, "boundary")}
try:
    _g.begin.constructor("return 1")
    _out["ctor"] = "reached"
except BaseException as e:
    _out["ctor"] = type(e).__name__
_out`)).value;
    assert.deepEqual(r, { boundary: false, ctor: "JsException" }, `got ${JSON.stringify(r)}`);
});

test("P2-gate: a later cell that hands JavaScript a callable an earlier cell's revoked wrapper still holds is refused, in that cell", { skip }, async () => {
    await cell(`import types, sys
from js import setTimeout
from pyodide.ffi import create_once_callable as _co
_m = types.ModuleType("_rt_pgr")
_m.woke = []
sys.modules["_rt_pgr"] = _m
def _f():
    _m.woke.append("ran")
_m.f = _f
setTimeout(_co(_f), 150)
"x"`);
    const again = await cell(`import sys
from js import setTimeout
from pyodide.ffi import create_once_callable as _co
_m = sys.modules["_rt_pgr"]
setTimeout(_co(_m.f), 10)
"scheduled"`);
    assert.match(String(again.error), /refused: an earlier cell scheduled this same callable/, `the reschedule must fail in the cell, got ${JSON.stringify(again)}`);
    // Once the revoked wrapper has fired (and run nothing), the callable is free again, and a cell that waits for it runs it.
    await py.runPythonAsync("import asyncio\nawait asyncio.sleep(0.2)");
    const free = (await cell(`import sys, asyncio
from js import setTimeout
from pyodide.ffi import create_once_callable as _co
_m = sys.modules["_rt_pgr"]
setTimeout(_co(_m.f), 5)
await asyncio.sleep(0.03)
list(_m.woke)`)).value;
    assert.deepEqual(free, ["ran"], `after the revoked wrapper fired, the callable schedules and runs inside the cell, got ${JSON.stringify(free)}`);
});

test("P2-gate: a revoked callback that fires after the result is silent and counted", { skip }, async () => {
    if (!cellGate) assert.fail("cell-gate.ts must exist for this test to mean anything");
    cellGate.cellDropped();
    const thrown = [];
    const onErr = (e) => thrown.push(String(e?.message ?? e));
    process.on("uncaughtException", onErr);
    process.on("unhandledRejection", onErr);
    try {
        const r = await scheduledThenAsk("_rt_pgd", `from js import setTimeout, Promise
from pyodide.ffi import create_once_callable as _co, create_proxy as _cp
setTimeout(_co(lambda: _m.woke.append("ran")), 10)
setTimeout(_cp(lambda: _m.woke.append("ran")), 10)
Promise.resolve(1).then(lambda *_a: _m.woke.append("ran"))
_m.woke.append("armed")
"x"`);
        assert.deepEqual(r, { woke: ["armed"] }, `got ${JSON.stringify(r)}`);
        // The three callbacks fire on their own schedule (setTimeout 10ms, Promise.then microtask). Under CI load
        // the 150ms `later` window can leave one unfired, so accumulate cellDropped() with a deadline instead of
        // a single read after a fixed sleep. #1081 capped the wait at 500ms (50×10ms); CI load still left one
        // unfired there, so the deadline is 2s with 50ms polls.
        let dropped = 0;
        const deadline = Date.now() + 2000;
        while (dropped < 3 && Date.now() < deadline) {
            dropped += cellGate.cellDropped();
            if (dropped < 3) await new Promise(r => setTimeout(r, 50));
        }
        assert.equal(dropped, 3, "each of the three fired, ran nothing, and was counted");
    } finally {
        process.off("uncaughtException", onErr);
        process.off("unhandledRejection", onErr);
    }
    assert.deepEqual(thrown, [], "a revoked callback must not throw into the process (the worker's onerror kills it)");
});

test("P2-gate: the hooks are fixed, so a cell that reaches Module cannot put the originals back", { skip }, async () => {
    if (!cellGate) assert.fail("cell-gate.ts must exist for this test to mean anything");
    const M = py._module;
    for (const k of cellGate.GATE_INTERNALS) assert.notEqual(M[k], undefined, `this Pyodide must have ${k}`);
    const fixed = [[M, "pyproxy_new"], [M, "callPyObject"], [M, "callPyObjectMaybePromising"], [M, "finalizationRegistry"], [M.finalizationRegistry, "register"], [Promise.prototype, "then"], [Promise.prototype, "finally"]];
    for (const [o, k] of fixed) {
        const d = Object.getOwnPropertyDescriptor(o, k);
        assert.ok(d && d.writable === false && d.configurable === false, `${k} must be non-writable and non-configurable, got ${JSON.stringify(d && { w: d.writable, c: d.configurable })}`);
    }
});

// Two routes past the gate through `pyodide_js`, which an APPROVED cell can import (the dialect refuses it unasked). Both
// are the red team's lane (window-ml-redteam-e3, with the lockdown's own reach): the cancel is sound only once a cell
// cannot reach `pyodide_js`.
test("P2-gate residual: pyodide_js.runPython bound to a source string and handed to setTimeout runs Python after the result", {
    skip,
}, async () => {
    const r = await scheduledThenAsk("_rt_pgs", `try:
    import pyodide_js
    from js import setTimeout
    setTimeout(pyodide_js.runPython.bind(pyodide_js, "import sys; sys.modules['_rt_pgs'].woke.append('ran')"), 10)
    _m.woke.append("sched-ok")
except BaseException as e:
    _m.woke.append("sched-fail:" + type(e).__name__)
_m.woke.append("armed")
"x"`);
    // The lockdown's stand-in carries no `runPython`, so the scheduling itself fails; what matters is that no Python ran.
    assert.ok(!r.woke.includes("ran") && r.woke.at(-1) === "armed", `got ${JSON.stringify(r)}`);
});

test("P2-gate residual: a later cell that reaches Module can point a revoked proxy back at its callable", {
    skip,
}, async () => {
    await cell(`import types, sys
from js import setTimeout
from pyodide.ffi import create_proxy as _cp
_m = types.ModuleType("_rt_pgu")
_m.woke = []
sys.modules["_rt_pgu"] = _m
def _f():
    _m.woke.append("ran")
_m.f = _f
_m.p = _cp(_f)
setTimeout(_m.p, 100)
"x"`);
    await cell(`import sys
_m = sys.modules["_rt_pgu"]
try:
    import pyodide_js
    pyodide_js._module.PyProxy_getAttrsQuiet(_m.p).shared.ptr = id(_m.f)
except BaseException:
    pass
"x"`);
    await py.runPythonAsync("import asyncio\nawait asyncio.sleep(0.15)");
    const r = (await cell(`import sys\nlist(sys.modules["_rt_pgu"].woke)`)).value;
    assert.deepEqual(r, [], `got ${JSON.stringify(r)}`);
});

// --- P2-handle crash: a handle on an orphan loop must not take the node process down ---------------
// A cell that calls asyncio.new_event_loop().call_later(...) leaves a Handle on a WebLoop the cell made.
// WebLoop.__init__ sets ITSELF as the running loop, so when that handle fires during the next cell's pump
// its task step passes the running-loop check and collides with the previous run's finished task:
// "Cannot enter into task ... while another task ... is being executed". The error is raised inside a JS
// setTimeout callback, asyncio's exception handler prints it, and the process dies (exit 13) — killing
// whatever test run was attached. The guard has to be a CHILD process: the crash is the finding.

test("P2-orphan-loop: a cell that schedules on a loop it made with new_event_loop does not crash the next pump", { skip }, () => {
    const script = `
import { loadPyodide } from ${JSON.stringify(path.join(PYODIDE_DIR, "pyodide.mjs"))};
const { wrapUserCode } = await import(${JSON.stringify(path.join(import.meta.dirname, "../src/python/python-runtime.ts"))});
const py = await loadPyodide({ indexURL: ${JSON.stringify(PYODIDE_DIR)} });
await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy"]);
await py.runPythonAsync(wrapUserCode("import asyncio\\nasyncio.new_event_loop().call_later(0.01, lambda: None)\\n\\"x\\"", true));
await py.runPythonAsync("import asyncio\\nawait asyncio.sleep(0.1)");
process.exit(0);
`;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 60000,
    });
    // The crash shows up as a non-zero exit (13) with "Cannot enter into task" in stderr. A clean run
    // exits 0 with neither. Assert on the EXIT, not the text: the text is the diagnosis, the exit is the bug.
    assert.equal(r.status, 0, `the child crashed (status=${r.status}, signal=${r.signal}):\n${(r.stderr || "").slice(-800)}`);
    assert.ok(!/Cannot enter into task/.test(r.stderr || ""), `the child hit the task-enter collision:\n${(r.stderr || "").slice(-800)}`);
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

test("P5-intra-indent: a patched textwrap.indent never receives a later cell's source", { skip }, async () => {
    // The wrapper indents the cell's source into `def _user():`. That indent is the HARNESS's path over
    // the code. Captured at boot (`_ml_harness.indent`), never `import textwrap` at cell time.
    const plant = await cell(`
import textwrap, types, sys
_m = types.ModuleType("_rt_p5ind")
_m.seen = []
_orig = textwrap.indent
def _spy(_s, *a, **k):
    _m.seen.append(str(_s))
    return _orig(_s, *a, **k)
textwrap.indent = _spy
sys.modules["_rt_p5ind"] = _m
textwrap.indent("PROBE_INDENT_OWN", "    ")
{"seen": list(_m.seen)}
`);
    assert.equal(plant.error, null, `plant cell should run, got: ${plant.error}`);
    assert.ok(plant.value.seen.some((s) => s.includes("PROBE_INDENT_OWN")),
        `positive control: the indent spy must see the same cell's call, got ${JSON.stringify(plant.value.seen)}`);

    const second = await cell('marker = "CELL2_INDENT_SECRET_SOURCE"\n1');
    assert.equal(second.error, null, `second cell should run, got: ${second.error}`);
    const after = await cell(`
import sys
_m = sys.modules.get("_rt_p5ind")
{"seen": [s for s in _m.seen] if _m else "NO MARKER"}
`);
    assert.equal(after.error, null, `readback should run, got: ${after.error}`);
    assert.deepEqual(after.value.seen.filter((s) => /CELL2_INDENT_SECRET_SOURCE/.test(s)), [],
        `a prior cell must not observe a later cell's source through textwrap.indent, got ${JSON.stringify(after.value.seen)}`);
});

test("P5-intra-unseat: popping sys.modules['_ml_harness'] does not hand the next cell the import fallback", { skip }, async () => {
    // The wrapper used to `from _ml_harness import ...`, which is a `sys.modules` lookup. A cell that
    // popped the entry and patched `ast.parse` forced the NEXT cell into `except ImportError:`, which
    // imports the patched `ast` — and that cell's source goes through the spy. Closed by looking the
    // harness up in the NAMESPACE, which `injectInputs` re-binds before every cell.
    const plant = await cell(`
import ast, sys, types
_m = types.ModuleType("_rt_p5uns")
_m.seen = []
_orig = ast.parse
def _spy(_src, *a, **k):
    _m.seen.append(str(_src))
    return _orig(_src, *a, **k)
ast.parse = _spy
sys.modules["_rt_p5uns"] = _m
sys.modules.pop("_ml_harness", None)
ast.parse("PROBE_UNSEAT_OWN")
{"seen": list(_m.seen)}
`);
    assert.equal(plant.error, null, `plant cell should run, got: ${plant.error}`);
    assert.ok(plant.value.seen.some((s) => s.includes("PROBE_UNSEAT_OWN")),
        `positive control: the ast.parse spy must see the same cell's call, got ${JSON.stringify(plant.value.seen)}`);

    const second = await cell('marker = "CELL2_UNSEAT_SECRET_SOURCE"\n1');
    assert.equal(second.error, null, `second cell must still run after the unseat, got: ${second.error}`);
    const after = await cell(`
import sys
_m = sys.modules.get("_rt_p5uns")
{"seen": list(_m.seen) if _m else "NO MARKER"}
`);
    assert.equal(after.error, null, `readback should run, got: ${after.error}`);
    assert.deepEqual(after.value.seen.filter((s) => /CELL2_UNSEAT_SECRET_SOURCE/.test(s)), [],
        `popping sys.modules['_ml_harness'] must not hand the next cell's source to a patched ast.parse, got ${JSON.stringify(after.value.seen)}`);
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

// --- acceptance. an on-demand wheel still loads AFTER lockdown + strip --------------------------------
// The lockdown runs at boot, before any cell. On-demand packages (`loadPackage` of a wheel that is
// fetched when a script first imports it) must still load and import afterwards — the strip keeps
// `WebAssembly` whole precisely so this works.

test("acceptance: loadPackage of one wheel works after lockdown + strip", { skip }, async () => {
    // Positive control: the interpreter is alive and locked down before the load.
    const alive = await cell("1 + 1");
    assert.equal(alive.error, null, `the interpreter must be alive, got: ${alive.error}`);
    assert.equal(alive.value, 2);

    // scipy is loaded on demand (not pre-imported by the prelude): its wheel loads after the strip.
    const t0 = Date.now();
    await py.loadPackage("scipy");
    const loadMs = Date.now() - t0;
    const used = await cell("import scipy\nfrom scipy import ndimage\nndimage.label([[0, 1], [1, 0]])[1]");
    assert.equal(used.error, null, `scipy must import and run after lockdown + strip, got: ${used.error}`);
    assert.equal(used.value, 2, "ndimage.label finds two components");
    // Carried for the PR's cost row: the one-wheel load after boot, measured here.
    console.log(`  loadPackage("scipy") after lockdown+strip: ${loadMs} ms`);
});
