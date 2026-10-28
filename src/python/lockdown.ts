// lockdown.ts — the readonly python_exec worker's boot: intrinsic taming and an allow-list strip of the JS realm.
// Chrome-free: takes the interpreter and the scope to strip, so tests run it against real Pyodide in Node.

// The readonly (auto-approved) `python_exec` sandbox exists because a hardened run genuinely cannot reach
// the outside world. The old model — `harden()` nulling a deny list of network globals and restoring them
// in `unharden()` — decays: every new host API is a hole until someone remembers to add it. This is the
// replacement: ONE boot step that (1) tames the JS intrinsics via Agoric's `ses` `lockdown()`, so the
// `Function`/`AsyncFunction`/`GeneratorFunction` constructors reached through a prototype chain throw;
// (2) strips the scope to an ALLOW LIST — only what Pyodide needs stays; `eval`, `Function`, the whole
// host surface, and every Node module go; (3) captures the harness's module references before any cell
// runs, so a cell that monkeypatches `ast.parse` or `json.loads` cannot change what the harness reports.
// `docs/plan/repl/PYODIDE_LOCKDOWN.md` is the spec; `docs/dev/python-sandbox.md` is the implementation note.
import "ses";
import { installCellGate, type CellGate } from "./cell-gate";
import { REFUSED_BRIDGES } from "./bridge-names";
import { installSpendQueue, type SpendQueue } from "./spend-queue";

/** Once per realm: `lockdown()` freezes the intrinsics and throws if called twice. */
let locked = false;   // state: plumbing — the realm's lockdown latch, one-way
/** The realm's cell gate, installed with the lockdown (cell-gate.ts). */
let gate: CellGate | null = null;   // state: plumbing — installed once per realm, before `lockdown()`
/** Each interpreter's bridge lift (BRIDGE_GATE), so a second boot of the same interpreter hands back the same one. */
const bridgeLifts = new WeakMap<object, (on: boolean) => void>();   // state: plumbing — one per interpreter, set at its boot
/** The realm's loop queue (spend-queue.ts), installed with the gate. */
let queue: SpendQueue | null = null;   // state: plumbing — installed once per realm, before the gate

/** Whether this realm's `lockdown()` has run and left it frozen: the latch `lockdownReadonly` sets, for tests and the worker's own checks. */
export function realmLocked(): boolean { return locked; }

/**
 * The names a worker's `globalThis` must keep after the strip: the JS intrinsics Pyodide needs, plus a
 * few host APIs that carry no capability (console, timers — string arguments refused — the URL and
 * encoding constructors). Everything else — `eval`, `Function`, `fetch`, `importScripts`, `postMessage`,
 * `navigator`, `indexedDB`, every Node module — is removed. The strip is the allow list; there is no deny
 * list to keep current. A test enumerates `globalThis` after the strip and fails on anything outside this.
 */
export const ALLOWED_GLOBALS: readonly string[] = Object.freeze([
    // JS intrinsics Pyodide's WASM runtime and the stdlib reach.
    "globalThis", "undefined", "NaN", "Infinity",
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Function",
    "Math", "JSON", "Reflect", "Proxy", "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
    "Date", "RegExp", "FinalizationRegistry", "Iterator",
    "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
    "AggregateError", "DOMException", "SuppressedError",
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics",
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
    "BigInt64Array", "BigUint64Array", "Float16Array",
    "Intl", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape",
    "isFinite", "isNaN", "parseFloat", "parseInt",
    "DisposableStack", "AsyncDisposableStack",
    // Host APIs that carry no capability.
    "console", "queueMicrotask", "structuredClone", "atob", "btoa", "performance",
    "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
    "WebAssembly", // compiles bytes, never a string: kept whole (Pyodide's WASM runtime needs it)
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", // string arguments refused below
    "AbortController", "AbortSignal",
]);

/** The evaluator and host-surface names the strip must ensure are ABSENT (never kept, even if a realm adds one).
 *  `Function` is NOT here: it is an intrinsic Pyodide's runtime needs, and `lockdown()` already tames it
 *  (calling `Function("code")` throws). `eval` is stripped — Pyodide never uses it. */
export const STRIPPED_NAMES: readonly string[] = Object.freeze([
    "eval", "importScripts", "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
    "Worker", "SharedWorker", "BroadcastChannel", "RTCPeerConnection",
    "postMessage", "addEventListener", "removeEventListener", "dispatchEvent",
    "onmessage", "onerror", "onmessageerror",
    "navigator", "indexedDB", "caches", "localStorage", "sessionStorage",
    "chrome",
]);

/** The timer entry points; replaced with wrappers that refuse a STRING argument (the browser's indirect-eval path). */
const TIMER_NAMES = ["setTimeout", "setInterval"];

/**
 * The Python bootstrap that captures the harness's module references and freezes them. Run once at boot,
 * before any cell: a cell that monkeypatches `ast.parse` or `json.loads` changes what the RUN's own later
 * cells see, but never what the harness parses, encodes or injects through. The frozen module is looked up
 * under `_ml_harness` in the wrapper (`wrapUserCode`); when it is absent (real-CPython tests) the wrapper
 * falls back to the normal module attributes.
 */
const HARNESS_BOOT = /* python */ `
import ast as _ml_a, json as _ml_j, base64 as _ml_b, textwrap as _ml_tw, traceback as _ml_tb, types as _ml_t, sys as _ml_s, io as _ml_io, contextlib as _ml_c, inspect as _ml_i, asyncio as _ml_aio, time as _ml_tm, threading as _ml_th

class _MlHarnessMod(_ml_t.ModuleType):
    """The harness's captured module references. A cell cannot patch through this."""
    def __getattribute__(self, name):
        if name.startswith("_"):
            return object.__getattribute__(self, name)
        refs = object.__getattribute__(self, "_MlHarnessMod__ml_refs")
        if name in refs:
            return refs[name]
        raise AttributeError(name)
    def __setattr__(self, name, value):
        raise AttributeError(f"{name} is frozen")
    def __delattr__(self, name):
        raise AttributeError(f"{name} is frozen")

# THE CELL GATE (cell-gate.ts): the wrapper opens its window and revokes what the cell handed to JavaScript. Held
# in closures, so the harness's refs are Python functions and no JsProxy lands in a cell's namespace.
def _ml_gate_calls(g):
    def begin():
        g.begin()
    def revoke():
        g.revoke()
    def spending():
        g.spending()
    # The loop's queue (spend-queue.ts): the spend's deadline, the cancel's own turn of the loop, and the cut at its end.
    def mark(budget):
        g.mark(budget)
    def turn(fn):
        g.turn(fn)
    def done():
        return g.done()
    return begin, revoke, spending, (mark, turn, done)
_ml_cell_begin, _ml_cell_revoke, _ml_cell_spending, _ml_spend_queue = _ml_gate_calls(globals().pop("_ml_gate_js"))

# THE CANCEL (python-runtime.ts, "the cancel"; PYTHON_CANCEL_GAPS.md pins 7 to 12): everything a cell scheduled is
# spent, revoked or cancelled before its result is returned. Built HERE, at boot, as a closure over CALLABLES and plain
# values captured now, and called by the worker from JavaScript after the cell, in a finally. A cell's code is compiled
# in the wrapper's globals, so a cancel that looked anything up there (or in a module, or in builtins) could be undone
# by a cell rebinding the name. Classes the captured callables dispatch through (Task.cancel) are not closed by this.
class _MlSpendLate(BaseException):
    """Raised in a task the cancel's spend stopped: it kept running past the spend's budget, or reached for its hook."""

def _ml_make_cancel(revoke, spending, queue, proxy, loop_globals, schedule, loop, set_running_loop, all_tasks, current_task, Future,
                    get_objects, Handle, traces, th_hooks, monitoring, monotonic, StringIO, redirect_stdout, redirect_stderr, guarded,
                    skip_files, SpendLate, BaseException_, isinstance_, id_, len_, range_, sorted_, str_, getattr_, ref_, ROUNDS, BUDGET, CAP):
    # The spend's hook is a sys.monitoring tool (pins 18 to 20): a settrace hook that raises is taken down by CPython
    # itself, so every handler after the first SpendLate ran untraced; a monitoring callback that raises stays on.
    use_tool_id, free_tool_id, clear_tool_id, register_callback, set_events, get_tool, get_events, DISABLE, TOOL, EVENTS = monitoring
    PY_START, LINE, JUMP, CALL = EVENTS
    MASK = PY_START | LINE | JUMP | CALL
    NAME = "window.ml spend"
    # The tasks' own output during the spend: kept up to CAP characters, then counted.
    class Out:
        def __init__(self):
            self.buf = StringIO()
            self.n = 0
        def write(self, s):
            s = str_(s)
            if self.n < CAP:
                self.buf.write(s[:CAP - self.n])
            self.n += len_(s)
            return len_(s)
        def flush(self):
            pass
    mark, turn, done = queue
    # Tasks whose cancel the queue's cut dropped (step 5), by id, each with a weak reference to tell a reused id apart.
    dead = {}
    def is_dead(t):
        r = dead.get(id_(t))
        return r is not None and r() is t
    async def cancel():
        me = current_task()
        out = Out()
        unspent = []
        seen = []
        deadline = None
        cut = 0
        code = cancel.__code__
        def skip(c):
            return c is code or c.co_filename.startswith(skip_files)
        # Every line, backward jump and function start a task runs past the deadline raises, its handlers' included; a
        # call that would take a hook down raises at once. The machinery's own code is switched off where it stands.
        def late(c, *_):
            if skip(c):
                return DISABLE
            if monotonic() > deadline:
                raise SpendLate()
        def call(c, offset, fn, arg0):
            if skip(c):
                return DISABLE
            if id_(fn) in guarded:
                raise SpendLate()
        HOOKS = ((PY_START, late), (LINE, late), (JUMP, late), (CALL, call))
        # A guarded call made from C (functools.partial, map, a key= function) raises no CALL event, so the tool is
        # checked after every turn instead: its name, its events and its callbacks. One that changed is taken back, and
        # the cell's result refused; a handler that spins once the tool is off is left to the worker's kill.
        def arm():
            if get_tool(TOOL) != NAME:
                if get_tool(TOOL) is not None:
                    clear_tool_id(TOOL)
                    free_tool_id(TOOL)
                use_tool_id(TOOL, NAME)
            for ev, fn in HOOKS:
                register_callback(TOOL, ev, fn)
        def intact(mask):
            try:
                if get_tool(TOOL) != NAME or get_events(TOOL) != mask:
                    return False
                for ev, fn in HOOKS:
                    if register_callback(TOOL, ev, fn) is not fn:
                        return False
                return True
            except BaseException_:
                return False
        tampered = False
        # The same C path reaches sys.settrace and setprofile (and threading's), which change no tool: a trace or profile
        # function a task installed during the spend would run on every frame of the next cell. Each is read and cleared
        # after every turn and after the spend; the profile function sees the reads themselves, so a raise counts as set.
        # threading's are read from its module dict: its gettrace is Python, which the tool stops once the deadline passed.
        def untraced():
            clean = True
            for get, set_ in traces:
                try:
                    if get() is not None:
                        clean = False
                        set_(None)
                except BaseException_:
                    clean = False
                    try:
                        set_(None)
                    except BaseException_:
                        pass
            for k in ("_trace_hook", "_profile_hook"):
                try:
                    if th_hooks.get(k) is not None:
                        clean = False
                        th_hooks[k] = None
                except BaseException_:
                    clean = False
            return clean
        # A tool the cell left would run its callbacks during the spend, on no clock: cleared and freed first, and named.
        foreign = []
        for i in range_(6):
            try:
                name = get_tool(i)
                if name is not None:
                    foreign.append(str_(name) + " (id " + str_(i) + ")")
                    clear_tool_id(i)
                    free_tool_id(i)
            except BaseException_:
                pass
        untraced()
        hooked = False
        with redirect_stdout(out), redirect_stderr(out):
            # 1. The running loop: a cell's new_event_loop() replaced it, and a handle on the orphan crashes the next pump.
            #    And the loop's queue: a cell that rebound webloop's scheduleCallback would hold the cancel's wakeup.
            try:
                set_running_loop(loop)
            except BaseException_:
                pass
            loop_globals["scheduleCallback"] = schedule
            # 2. SPEND every task: cancel it and let the loop turn, so it takes the CancelledError and finishes. A task
            #    that catches the cancel and awaits again is cancelled again, ROUNDS times. The rounds share ONE budget,
            #    enforced on every line, jump and start a task runs and on every call that would take the hook down (one
            #    sys.monitoring tool); a cell's own trace and profile hooks are cleared for the spend and left as None.
            try:
                for rnd in range_(ROUNDS + 1):
                    unspent = [t for t in all_tasks() if t is not me and not t.done() and not is_dead(t)]
                    if not unspent or rnd == ROUNDS:
                        break
                    for t in unspent:
                        if t not in seen:
                            seen.append(t)
                        t.cancel()
                    if deadline is None:
                        deadline = monotonic() + BUDGET
                        mark(BUDGET)
                        spending()
                        arm()
                        hooked = True
                    elif monotonic() > deadline:
                        break
                    if tampered:
                        arm()
                    set_events(TOOL, MASK)
                    # One turn of the loop, behind what is queued: the queue's own one-shot, never cut at the deadline, so
                    # a cell's flood of queued callbacks is dropped there instead of holding the cancel past it.
                    try:
                        turned = Future(loop=loop)
                        turn(proxy(lambda: turned.done() or turned.set_result(None)))
                        await turned
                    finally:
                        if not untraced() or not intact(MASK):
                            tampered = True
                        try:
                            set_events(TOOL, 0)
                        except BaseException_:
                            pass
            except BaseException_:
                pass
            # 2b. A task that ended in an exception keeps its frames in the traceback, and whatever they held (a
            #     suspended coroutine, an object with __del__) is finalized when they are collected: in a later cell, on
            #     no clock. Cleared here, under the tool with the deadline forced past, so a finalizer stops at its first event.
            if hooked:
                deadline = 0.0
                try:
                    if tampered:
                        arm()
                    set_events(TOOL, MASK)
                    for t in seen:
                        try:
                            e = t.exception() if t.done() and not t.cancelled() else None
                            for _ in range_(64):
                                if e is None:
                                    break
                                tb = e.__traceback__
                                while tb is not None:
                                    try:
                                        tb.tb_frame.clear()
                                    except BaseException_:
                                        pass
                                    tb = tb.tb_next
                                e = e.__context__
                        except BaseException_:
                            pass
                except BaseException_:
                    pass
                finally:
                    if not untraced() or not intact(MASK):
                        tampered = True
                    try:
                        set_events(TOOL, 0)
                    except BaseException_:
                        pass
            # 3. CUT the loop's queue: nothing queued so far runs, and the deadline's count. First, so the revoke and the
            #    Handle walk below never pay for a flood the cut has already made inert.
            try:
                cut = done()
            except BaseException_:
                pass
            # 4. REVOKE what the cell handed to JavaScript (cell-gate.ts), leaving out the callbacks the cut dropped (the
            #    sweep destroys them), then cancel every asyncio.Handle left. Every Handle a loop queued was in the cut,
            #    so after a deadline cut the walk is skipped: over a flood it cost seconds, on objects already inert.
            try:
                revoke()
            except BaseException_:
                pass
            if not cut:
                try:
                    for obj in get_objects():
                        if isinstance_(obj, Handle) and not obj.cancelled():
                            obj.cancel()
                except BaseException_:
                    pass
            # 5. A task whose cancel the cut dropped can never run again: nothing is left to wake it. Close its coroutine
            #    now, under the tool with the deadline past, so its handlers stop at their first event instead of running
            #    whenever the task is collected; later spends leave it out.
            if cut and hooked:
                deadline = 0.0
                for t in unspent:
                    try:
                        dead[id_(t)] = ref_(t)
                    except BaseException_:
                        pass
                    try:
                        if tampered:
                            arm()
                        set_events(TOOL, MASK)
                        t.get_coro().close()
                    except BaseException_:
                        pass
                    finally:
                        if not untraced() or not intact(MASK):
                            tampered = True
                        try:
                            set_events(TOOL, 0)
                        except BaseException_:
                            pass
            if hooked:
                try:
                    clear_tool_id(TOOL)
                    free_tool_id(TOOL)
                except BaseException_:
                    pass
            if not untraced():
                tampered = True
        # A task the bound stopped ended with SpendLate (reading it also keeps asyncio from logging it as unretrieved).
        stopped = []
        for t in seen:
            try:
                if t.done() and not t.cancelled() and isinstance_(t.exception(), SpendLate):
                    stopped.append(t)
            except BaseException_:
                pass
        def names(tasks):
            try:
                return ", ".join(sorted_({t.get_name() + " (" + str_(getattr_(t.get_coro(), "__qualname__", "?")) + ")" for t in tasks}))
            except BaseException_:
                return str_(len_(tasks)) + " task(s)"
        refusal = ""
        if foreign:
            refusal += "RuntimeError: this cell left a sys.monitoring tool registered: " + ", ".join(foreign) + ". It was cleared before the cancel's spend, so the cell's result is refused rather than returned beside it.\\n"
        if tampered:
            refusal += "RuntimeError: a task this cell left changed the cancel's sys.monitoring tool or set a trace or profile function during the spend (a call made from C, such as functools.partial or map, which the hook does not see), so the cell's result is refused rather than returned beside it.\\n"
        if stopped:
            refusal += "RuntimeError: this cell left a task that kept running after it was cancelled: " + names(stopped) + ". It was stopped after " + str_(BUDGET) + " s (or when it tried to remove the cancel's hook), so the cell's result is refused rather than returned beside it.\\n"
        if unspent and cut:
            refusal += "RuntimeError: " + str_(cut) + " callbacks this cell queued were dropped at the spend's deadline, so " + names(unspent) + " never took its cancel; the result is refused rather than returned beside it.\\n"
        elif unspent:
            refusal += "RuntimeError: this cell left a task running that would not stop: " + names(unspent) + ". It was cancelled " + str_(ROUNDS) + " times and caught the cancel each time, so the cell's result is refused rather than returned beside it.\\n"
        text = out.buf.getvalue()
        if out.n > CAP:
            text += "\\n[the cancel cut " + str_(out.n - CAP) + " more characters the cell's tasks printed]"
        return (text, refusal)
    return cancel

# The cell's script and its cancel as ONE coroutine: the host awaits this instead of runPythonAsync, so nothing the
# cell queued on the JavaScript side (a microtask, a promise's then, a call_soon) runs between the two.
def _ml_make_run(eval_code_async, cancel, format_exception, BaseException_):
    async def run(source, ns):
        err = ""
        try:
            await eval_code_async(source, ns, return_mode="none")
        except BaseException_ as e:
            err = "".join(format_exception(e))
        out, refusal = await cancel()
        return (out, refusal, err)
    return run

# The calls that would take the spend's hook down, and the files whose frames the hook never stops: asyncio's and
# Pyodide's loop machinery (stopping them would break the loop, not the task) and the harness's own. Every sys.monitoring
# call but the three that only read is guarded, enumerated from the module so a later core's new one is too.
import gc as _ml_gc, os as _ml_os, pyodide as _ml_pyo, weakref as _ml_wr
_ml_mon = _ml_s.monitoring
_ml_spend_guarded = frozenset(id(f) for f in (_ml_s.settrace, _ml_s.setprofile, _ml_th.settrace, _ml_th.setprofile,
    getattr(_ml_th, "settrace_all_threads", None), getattr(_ml_th, "setprofile_all_threads", None),
    *(getattr(_ml_mon, n) for n in dir(_ml_mon) if not n.startswith("_") and n not in ("get_tool", "get_events", "get_local_events")
      and callable(getattr(_ml_mon, n)))) if f is not None)
_ml_spend_skip = (_ml_os.path.dirname(_ml_aio.__file__), _ml_os.path.dirname(_ml_pyo.__file__), _ml_c.__file__, _ml_s._getframe().f_code.co_filename)
from pyodide.ffi import create_proxy as _ml_proxy
import pyodide.webloop as _ml_wl
_ml_cancel = _ml_make_cancel(_ml_cell_revoke, _ml_cell_spending, _ml_spend_queue, _ml_proxy, _ml_wl.__dict__, _ml_wl.scheduleCallback,
    _ml_aio.get_event_loop(), _ml_aio._set_running_loop, _ml_aio.all_tasks, _ml_aio.current_task, _ml_aio.Future, _ml_gc.get_objects, _ml_aio.Handle,
    ((_ml_s.gettrace, _ml_s.settrace), (_ml_s.getprofile, _ml_s.setprofile)), _ml_th.__dict__,
    (_ml_mon.use_tool_id, _ml_mon.free_tool_id, _ml_mon.clear_tool_id, _ml_mon.register_callback,
    _ml_mon.set_events, _ml_mon.get_tool, _ml_mon.get_events, _ml_mon.DISABLE, 4, (_ml_mon.events.PY_START, _ml_mon.events.LINE, _ml_mon.events.JUMP, _ml_mon.events.CALL)),
    _ml_tm.monotonic, _ml_io.StringIO, _ml_c.redirect_stdout, _ml_c.redirect_stderr,
    _ml_spend_guarded, _ml_spend_skip, _MlSpendLate, BaseException, isinstance, id, len, range, sorted, str, getattr, _ml_wr.ref,
    8, 1.0, 20000)
from _pyodide._base import eval_code_async as _ml_eval_async
_ml_run = _ml_make_run(_ml_eval_async, _ml_cancel, _ml_tb.format_exception, BaseException)


_h = _MlHarnessMod("_ml_harness")
object.__setattr__(_h, "_MlHarnessMod__ml_refs", {
    "ast_parse": _ml_a.parse,
    # The tree surgery (line numbers, the trailing-expression return, the latex(...) detect) walks and
    # rebuilds the parse of the cell's SOURCE. Captured too: a patched ast.walk would observe the tree,
    # which is the code, and a patched ast.Return would replace what the harness builds.
    "ast_increment_lineno": _ml_a.increment_lineno,
    "ast_copy_location": _ml_a.copy_location,
    "ast_fix_missing_locations": _ml_a.fix_missing_locations,
    "ast_Return": _ml_a.Return,
    "ast_Expr": _ml_a.Expr,
    "ast_Call": _ml_a.Call,
    "ast_Attribute": _ml_a.Attribute,
    "ast_Name": _ml_a.Name,
    "ast_Assign": _ml_a.Assign,
    "ast_walk": _ml_a.walk,
    "json_loads": _ml_j.loads,
    "json_dumps": _ml_j.dumps,
    # The wrapper's SOURCE indent, the injected image decode and the result encode are the harness's own
    # paths: a patched textwrap.indent would receive the next cell's source, a patched base64 would decide
    # what the harness reports as the cell's bytes.
    "b64decode": _ml_b.b64decode,
    "b64encode": _ml_b.b64encode,
    "indent": _ml_tw.indent,
    "bytes_io": _ml_io.BytesIO,
    "string_io": _ml_io.StringIO,
    "format_exc": _ml_tb.format_exc,
    "redirect_stdout": _ml_c.redirect_stdout,
    "redirect_stderr": _ml_c.redirect_stderr,
    "sys_stdout": _ml_s.stdout,
    # ASYNC CELL DRIVERS: the wrapper builds \`async def _user()\` so \`await ml.*\` is legal, and drives
    # the coroutine on the active loop (or a fresh one). Captured so a cell that patches
    # \`inspect.iscoroutine\` or \`asyncio.get_running_loop\` cannot change how the harness runs its own
    # code (LANE_1_PR2_DESIGN.md).
    "inspect": _ml_i,
    "asyncio": _ml_aio,
    "cell_begin": _ml_cell_begin,
    "cell_revoke": _ml_cell_revoke,
    # The worker runs every cell's script through this (python-worker.ts \`hostRunScript\`): the script, then the cancel.
    "run_script": _ml_run,
})
del _ml_gate_calls, _ml_cell_begin, _ml_cell_revoke, _ml_cell_spending, _ml_spend_queue, _ml_proxy, _ml_wl, _MlSpendLate, _ml_spend_guarded, _ml_spend_skip, _ml_make_cancel, _ml_cancel, _ml_make_run, _ml_run, _ml_eval_async
_h
`;

/**
 * The Python half of taking `pyodide_js` (the Pyodide API object, and through it `_api` and `_module`) out of a cell's
 * reach. Pyodide's own modules import from it at THEIR import time (`webloop`'s `scheduleCallback`, the package loader's
 * `loadedPackages`), so both are imported first and keep what they bound; then every `pyodide_js*` entry leaves
 * `sys.modules`, and the import hook's loader for each old module (its `__loader__`, its spec's `loader`) lets go of
 * it: the old module's spec keeps that loader alive past a collection, where `gc.get_objects()` finds it.
 */
const PYODIDE_JS_SEAL = /* python */ `
def _ml_seal():
    import sys
    import pyodide.webloop, pyodide._package_loader
    from _pyodide._importhook import JsLoader
    for k in [k for k in sys.modules if k == "pyodide_js" or k.startswith("pyodide_js.")]:
        m = sys.modules.pop(k)
        for loader in (getattr(m, "__loader__", None), getattr(getattr(m, "__spec__", None), "loader", None)):
            if isinstance(loader, JsLoader):
                loader.jsproxy = None
_ml_seal()
del _ml_seal
`;

/**
 * The Python half of refusing `REFUSED_BRIDGES` to a cell. Each module is replaced, in `sys.modules`, on its parent
 * package and behind a first `sys.meta_path` finder, by a guard module that holds none of its names: a lookup through
 * it is answered from the real module only when no frame on the stack is the cell's. A frame is the LIBRARY's when its
 * code was compiled from a file under the stdlib's directory or zip (site-packages included); anything else (the cell, the
 * harness's `<exec>`, a string the cell compiled) counts as the cell's. One exception: a library module running its own
 * import (`<module>`) is answered, so pyarrow's `unix_timezones` (`import js` at import time) loads from a cell. The
 * caller unregisters `js` from Pyodide's finder first, so popping the guard does not bring the real one back.
 * `_ml_bridge_gate` returns the LIFT: a setter only the worker's JavaScript holds, for the one cell whose approval card
 * said it reaches the browser's JavaScript, cleared when that cell ends (lockdownReadonly's `bridges`).
 *
 * What this does NOT claim (measured 2026-10-27, written into PYODIDE_LOCKDOWN.md step 2): a cell in full Python reaches
 * the same functions by introspection without an import (a library function's `__globals__`, a package's module
 * global, `gc` over any holder, this guard's own closure), by compiling code under a library filename, or by removing
 * the finder and re-importing a Python module from its file. Those keep the bounds they had: the strip and the cell gate.
 */
const BRIDGE_GATE = /* python */ `
def _ml_bridge_gate(names):
    import sys, os, types, importlib, importlib.util
    if any(getattr(f, "__name__", None) == "_MlBridgeFinder" for f in sys.meta_path):
        return None
    root = tuple([os.path.dirname(os.__file__) + "/"] + [p + "/" for p in sys.path if p.endswith(".zip")])
    real = {}
    for n in names:
        m = sys.modules.get(n)
        if m is None and n != "js":
            try:
                m = importlib.import_module(n)
            except ImportError:
                m = None
        if m is not None:
            real[n] = m
    getframe = sys._getframe
    lift = [False]

    def answered(f):
        if lift[0]:
            return True
        while f is not None and f.f_code.co_filename.startswith("<frozen "):
            f = f.f_back
        if f is None:
            return True
        if f.f_code.co_filename.startswith(root) and f.f_code.co_name == "<module>":
            return True
        while f is not None:
            fn = f.f_code.co_filename
            if not fn.startswith(root) and not fn.startswith("<frozen "):
                return False
            f = f.f_back
        return True

    class _MlBridgeGuard(types.ModuleType):
        def __getattr__(self, attr):
            name = types.ModuleType.__getattribute__(self, "__name__")
            if attr.startswith("__") and attr.endswith("__"):
                raise AttributeError(attr)
            if not answered(getframe(1)):
                raise ImportError(f"{name} is refused in python_exec: a cell may not reach the browser's JavaScript ({name}.{attr})")
            return getattr(real[name], attr)

    guards = {n: _MlBridgeGuard(n) for n in real}

    class _MlBridgeLoader:
        @staticmethod
        def create_module(spec):
            return guards[spec.name]
        @staticmethod
        def exec_module(module):
            pass

    class _MlBridgeFinder:
        @staticmethod
        def find_spec(name, path=None, target=None):
            if name in guards:
                return importlib.util.spec_from_loader(name, _MlBridgeLoader)
            return None

    for n, g in guards.items():
        g.__spec__ = importlib.util.spec_from_loader(n, _MlBridgeLoader)
        g.__loader__ = _MlBridgeLoader
        sys.modules[n] = g
        parent, _, child = n.rpartition(".")
        if parent and parent in sys.modules and not isinstance(sys.modules[parent], _MlBridgeGuard):
            setattr(sys.modules[parent], child, g)
    sys.meta_path.insert(0, _MlBridgeFinder)
    # A module that imported a bridge before the gate holds the real module as a global (unix_timezones' \`js\`).
    by_id = {id(m): guards[n] for n, m in real.items()}
    for m in list(sys.modules.values()):
        d = getattr(m, "__dict__", None)
        if isinstance(d, dict) and not isinstance(m, _MlBridgeGuard):
            for k, v in list(d.items()):
                if id(v) in by_id:
                    d[k] = by_id[id(v)]

    def set_lift(on):
        lift[0] = bool(on)
    return set_lift
`;

/**
 * Boot a readonly-only Python worker: tame the JS intrinsics, strip the scope to the allow list, and
 * capture the harness's module references before any cell runs. Never undone — the readonly worker is
 * locked down at boot and stays that way (`full` mode runs in a separate worker that is never locked).
 *
 * @param py the Pyodide interpreter (already booted and its packages loaded)
 * @param scope the JS object to strip — `globalThis` in the worker, a stand-in in tests
 * @returns the relay's `postMessage`/`close`, captured before the strip, the harness module the
 *   caller re-binds into every cell's namespace, and `bridges`, which lifts the refusal of `REFUSED_BRIDGES` for the
 *   cell about to run (true) and restores it (false). The CALLER keeps them in its closure — never on the
 *   scope, where a JsProxy of it would find them.
 */
export async function lockdownReadonly(py: any, scope: any = globalThis): Promise<{ postMessage?: unknown; close?: unknown; harness?: unknown; bridges: (on: boolean) => void }> {
    // 1. Intrinsic taming: the Function/AsyncFunction/GeneratorFunction constructors reached through a
    //    prototype chain throw. `lockdown()` is once per realm; a second call is a no-op here.
    if (!locked) {
        // Pyodide's PyProxy class factory (`Module.getPyProxyClass`) builds a descriptor map with
        // `n.constructor = ...` on a plain `{}`. A frozen `Object.prototype.constructor` is the override
        // mistake: the assignment throws `Cannot assign to read only property 'constructor'`, and the factory
        // caches per flag bitfield, so the table/DataFrame path hits a combination no warmup made (#735).
        // `overrideTaming: "severe"` is ses's own fix: it turns that property (and the rest of the tamed
        // prototypes') into an accessor whose setter defines an OWN property on `this` and refuses
        // `this === Object.prototype`. An accessor we define ourselves is refused by ses's permit check
        // ("Accessor not expected"), which left the realm unfrozen.
        // Warm up the basic eval path too (cheap, keeps the first cell from being the first conversion).
        try { await py.runPythonAsync("1", { globals: py.globals }); } catch { /* unwarmable: the later cells will say so */ }
        // The cell gate wraps `Promise.prototype.then`/`finally`, so it goes in before `lockdown()` freezes them.
        // It throws on a Pyodide without the internals it hooks: no worker boots then, rather than one whose cells
        // can schedule Python past their result (cell-gate.ts).
        // The loop's queue (spend-queue.ts) goes in first: the gate wraps the same call entry point, outside it.
        queue ??= installSpendQueue(py);
        gate ??= installCellGate(py);
        gate.skipping(queue.isDoomed);
        try {
            (globalThis as any).lockdown({ errorTaming: "unsafe", overrideTaming: "severe" });
        } catch (e) {
            // A second call in a realm already locked is fine; a realm left unfrozen must not run a cell.
            if (!Object.isFrozen(Object.prototype) || !Object.isFrozen(Promise.prototype)) throw e;
        }
        locked = true;
    }
    if (!gate || !queue) throw new Error("lockdownReadonly: this realm is already locked down, so the cell gate cannot be installed");
    const q = queue;

    // 1b. `pyodide_js` out of a cell's reach: `import pyodide_js` reached `_api` (`runPythonInternal`, `rawRun`) and
    //     `_module` (`ccall`, `HEAP`, `PyProxy_getAttrsQuiet`). Two imports in `webloop` run at CALL time
    //     (`run_until_complete` and the patched `asyncio.run` read `pyodide_js._api.config`), so the name stays
    //     registered, as a stand-in holding `config.enableRunUntilComplete` and nothing else. It is the import
    //     hook's, not a `sys.modules` entry, so a cell that pops it gets it back on the next import. `_nodeSock` and
    //     `abortSignalAny` stay absent, so those imports fail as they do in a browser. A seal that throws fails the
    //     boot: the worker must not run a cell with the API in reach.
    // Only `config` is frozen: the import system sets `_api` on its parent whenever a cell re-imports it.
    const standIn = { _api: { config: Object.freeze({ enableRunUntilComplete: !!py._api?.config?.enableRunUntilComplete }) } };
    try { py.unregisterJsModule("pyodide_js"); } catch { /* a second boot of this interpreter, or a seal that threw before */ }
    // A second boot of this interpreter seals behind the bridge gate the first one installed (step 5).
    const lifted = bridgeLifts.get(py);
    lifted?.(true);
    try { py.runPython(PYODIDE_JS_SEAL); } finally { lifted?.(false); }
    py.registerJsModule("pyodide_js", standIn);

    // 2. Capture what the relay needs BEFORE the strip: the worker's `onmessage` is defined once and
    //    frozen; the closure holds `postMessage` so the relay can still answer.
    const heldPost = typeof scope.postMessage === "function" ? scope.postMessage.bind(scope) : undefined;
    const heldClose = typeof scope.close === "function" ? scope.close.bind(scope) : undefined;

    // 3. The allow-list strip. Delete everything outside ALLOWED_GLOBALS; also force-remove the known
    //    evaluator/host names even if a realm invents an alias for one. Timers become string-refusing
    //    wrappers. WebAssembly is kept whole — it compiles bytes, never a string. Prototype chain too:
    //    `onmessage`, `postMessage` etc. live on `DedicatedWorkerGlobalScope.prototype`, not as own
    //    properties of `self`, so an own-property delete alone leaves them reachable.
    const keep = new Set(ALLOWED_GLOBALS);
    for (const name of Object.getOwnPropertyNames(scope)) {
        if (keep.has(name)) continue;
        try { delete scope[name]; } catch { try { Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false }); } catch { /* non-configurable */ } }
    }
    for (const name of STRIPPED_NAMES) {
        try { delete scope[name]; } catch { /* gone or non-configurable */ }
        // Walk the prototype chain and delete there too (the WorkerGlobalScope methods are prototype
        // accessors: `delete self.postMessage` is a no-op when `postMessage` is on the prototype).
        let proto = Object.getPrototypeOf(scope);
        while (proto && proto !== Object.prototype) {
            try { delete proto[name]; } catch { /* non-configurable */ }
            proto = Object.getPrototypeOf(proto);
        }
    }
    // Timers: a STRING argument is the browser's indirect-eval path. Keep the function; refuse the string.
    for (const name of TIMER_NAMES) {
        const orig = scope[name];
        if (typeof orig !== "function") continue;
        try {
            scope[name] = (fn: unknown, ms?: number, ...rest: unknown[]) => {
                if (typeof fn === "string") throw new TypeError(`${name} refuses a string argument`);
                return (orig as (...a: unknown[]) => unknown)(fn, ms, ...rest);
            };
        } catch { /* non-configurable */ }
    }

    // 4. The harness's module references, captured before any cell runs. The wrapper looks the module
    //    up in the cell's NAMESPACE (which `injectInputs` re-binds before every cell), never through
    //    `sys.modules`: a cell that pops `sys.modules["_ml_harness"]` must not force the next cell into
    //    the import fallback, which imports the patched `ast`/`json`. The caller holds the PyProxy and
    //    re-sets it, so nothing a prior cell did in Python can unseat it.
    let harness: unknown;
    try {
        // `HARNESS_BOOT` ends with `_h` as its trailing expression: `runPython` returns the module object
        // directly. It is NOT placed in `sys.modules` — `import _ml_harness` must fail, and the wrapper
        // deletes `_ml_harness` from the cell's namespace after extracting the refs.
        // The gate reaches the boot as a temporary global the boot pops: the cell's namespace never holds it.
        py.globals.set("_ml_gate_js", {
            begin: () => gate!.begin(), revoke: () => gate!.revoke(), spending: () => gate!.spending(),
            mark: (budget: number) => q.mark(budget), turn: (fn: () => void) => q.turn(fn), done: () => q.done(),
        });
        harness = py.runPython(HARNESS_BOOT);
    } catch { /* the wrapper falls back */ }

    // 5. The bridges a cell may not import (BRIDGE_GATE), installed last so the boot's own imports above are done. A
    //    gate that throws fails the boot: the worker must not run a cell with `js` importable.
    try { py.unregisterJsModule("js"); } catch { /* a second boot of this interpreter */ }
    py.runPython(BRIDGE_GATE);
    const install = py.globals.get("_ml_bridge_gate");
    py.globals.delete("_ml_bridge_gate");
    const setLift = install(py.toPy([...REFUSED_BRIDGES]));
    install.destroy?.();
    if (setLift) bridgeLifts.set(py, (on: boolean) => { setLift(on); });
    const bridges = bridgeLifts.get(py);
    if (!bridges) throw new Error("lockdownReadonly: the bridge gate did not install");

    // The relay keeps these in its own closure. Nothing is written to the scope: a JsProxy of it
    // must find neither the relay's functions nor a name that leads to them.
    return { postMessage: heldPost, close: heldClose, harness, bridges };
}
