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

/** Once per realm: `lockdown()` freezes the intrinsics and throws if called twice. */
let locked = false;   // state: plumbing — the realm's lockdown latch, one-way

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
import ast as _ml_a, json as _ml_j, base64 as _ml_b, textwrap as _ml_tw, traceback as _ml_tb, types as _ml_t, sys as _ml_s, io as _ml_io, contextlib as _ml_c, inspect as _ml_i, asyncio as _ml_aio

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
})
_h
`;

/**
 * Boot a readonly-only Python worker: tame the JS intrinsics, strip the scope to the allow list, and
 * capture the harness's module references before any cell runs. Never undone — the readonly worker is
 * locked down at boot and stays that way (`full` mode runs in a separate worker that is never locked).
 *
 * @param py the Pyodide interpreter (already booted and its packages loaded)
 * @param scope the JS object to strip — `globalThis` in the worker, a stand-in in tests
 * @returns the relay's `postMessage`/`close`, captured before the strip, and the harness module the
 *   caller re-binds into every cell's namespace. The CALLER keeps them in its closure — never on the
 *   scope, where a JsProxy of it would find them.
 */
export async function lockdownReadonly(py: any, scope: any = globalThis): Promise<{ postMessage?: unknown; close?: unknown; harness?: unknown }> {
    // 1. Intrinsic taming: the Function/AsyncFunction/GeneratorFunction constructors reached through a
    //    prototype chain throw. `lockdown()` is once per realm; a second call is a no-op here.
    if (!locked) {
        // Pyodide's PyProxy class factory (`Module.getPyProxyClass`) builds a descriptor map with
        // `n.constructor = ...` on a plain `{}`, which `lockdown()` then freezes non-writable so the
        // assignment throws `Cannot assign to read only property 'constructor'`. The factory caches
        // per flag bitfield, so a single warmup only pre-creates the class for ONE flag combination
        // and the table/DataFrame path hits the uncached one. Fix: give `Object.prototype.constructor`
        // an accessor setter BEFORE the freeze — `lockdown()` preserves accessors (just makes them
        // non-configurable), so the setter still materialises an own property on every assignment.
        try {
            Object.defineProperty(Object.prototype, "constructor", {
                get() { return Object; },
                set(v: unknown) {
                    Object.defineProperty(this, "constructor", {
                        value: v, writable: true, enumerable: true, configurable: true,
                    });
                },
                configurable: true,
                enumerable: false,
            });
        } catch { /* already an accessor or non-configurable */ }
        // Warm up the basic eval path too (cheap, keeps the first cell from being the first conversion).
        try { await py.runPythonAsync("1", { globals: py.globals }); } catch { /* unwarmable: the later cells will say so */ }
        try { (globalThis as any).lockdown({ errorTaming: "unsafe" }); locked = true; } catch { /* already locked */ }
    }

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
        harness = py.runPython(HARNESS_BOOT);
    } catch { /* the wrapper falls back */ }

    // The relay keeps these in its own closure. Nothing is written to the scope: a JsProxy of it
    // must find neither the relay's functions nor a name that leads to them.
    return { postMessage: heldPost, close: heldClose, harness };
}
