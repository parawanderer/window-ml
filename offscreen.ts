// Offscreen document — hosts the Pyodide (CPython→WASM) runtime for the `python_exec`
// tool. It runs in an extension-origin page (whose CSP we set to allow 'wasm-unsafe-eval'),
// off the service worker (which can't run WASM). The background relays { code, image? }
// here; we execute it in a SANDBOXED Python namespace — no network, no filesystem, no DOM,
// only the optional injected image — and return the value + stdout. Pyodide and the
// numpy/Pillow wheels (bundled in dist/pyodide/) load lazily on the first call.

// Standard prelude injected before the model's code: numpy/PIL in scope, an optional
// `img` (PIL.Image) + `img_np` (H×W×3 uint8) decoded from the injected screenshot, and a
// `to_base64()` helper so a script can return a processed image back to the caller.
const PRELUDE = `
import io, base64, sys, contextlib
import numpy as np
from PIL import Image

def to_base64(x):
    if isinstance(x, np.ndarray):
        x = Image.fromarray(x.astype("uint8"))
    _b = io.BytesIO(); x.save(_b, format="PNG")
    return "data:image/png;base64," + base64.b64encode(_b.getvalue()).decode()

img = None
img_np = None
H = W = 0
_b64 = globals().get("INJECTED_IMAGE_B64")
if _b64:
    _raw = base64.b64decode(_b64.split(",")[-1])   # tolerate a data: URL prefix
    img = Image.open(io.BytesIO(_raw)).convert("RGB")
    img_np = np.array(img)
    H, W = img_np.shape[:2]
`;

const indent = (code: string) => (code || "pass").split("\n").map(l => "    " + l).join("\n");

let pyodideReady: Promise<any> | null = null;
function getPyodide(): Promise<any> {
    if (!pyodideReady) pyodideReady = (async () => {
        // Dynamic import of the vendored ESM (runtime URL → esbuild leaves it external).
        const { loadPyodide } = await import(chrome.runtime.getURL("pyodide/pyodide.mjs"));
        const py = await loadPyodide({ indexURL: chrome.runtime.getURL("pyodide/") });
        await py.loadPackage(["numpy", "pillow"]);
        return py;
    })();
    return pyodideReady;
}

// toJs can produce Maps / nested proxies; a JSON round-trip flattens to plain data (and
// drops anything non-serializable — which shouldn't cross the message bus anyway).
function sanitize(v: unknown): unknown {
    try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

// --- Sandbox hardening (the `readonly` mode) --------------------------------------
// python_exec is auto-approvable ONLY because a hardened run genuinely cannot reach the
// outside world. There are three Python→outside bridges: (1) Pyodide's `js`/`pyodide_js`
// modules — but unregistering isn't enough: a prior `full` run's `import js` leaves a cached
// JsProxy in `sys.modules['js']` that `sys.modules['js']` reaches straight past the
// unregister, so we must PURGE sys.modules too; (2) `pyodide.code.run_js(...)`, which
// executes JS in this document's global scope; (3) any leaked proxy. Defences (all three
// bridges converge on the JS global scope): unregister + sys.modules-purge the modules, AND
// null every network/exfil primitive on the global (fetch/XHR/WebSocket/Worker/… +
// navigator.sendBeacon) so even run_js or a leaked proxy hits `undefined`. A `full` run
// (agent-declared, always manually approved) leaves them intact. Restored in `finally`;
// runs are serialized (below) so the global swap can't race a concurrent run.
const NET_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "BroadcastChannel", "RTCPeerConnection", "chrome", "importScripts"];
interface Hardened { globals: Record<string, unknown>; beacon: unknown; hadBeacon: boolean; }
function harden(py: any): Hardened {
    for (const m of ["js", "pyodide_js"]) { try { py.unregisterJsModule(m); } catch { /* not registered */ } }
    // The cache-leak fix (#1): drop any JsProxy a prior `full` run cached under import.
    try { py.runPython("import sys\nsys.modules.pop('js', None)\nsys.modules.pop('pyodide_js', None)"); } catch { /* */ }
    const saved: Record<string, unknown> = {};
    for (const k of NET_GLOBALS) { saved[k] = (globalThis as any)[k]; try { (globalThis as any)[k] = undefined; } catch { /* non-configurable */ } }
    const nav = (globalThis as any).navigator;
    const hadBeacon = !!nav && Object.prototype.hasOwnProperty.call(nav, "sendBeacon");
    const beacon = nav ? nav.sendBeacon : undefined;
    if (nav) { try { nav.sendBeacon = () => false; } catch { /* */ } }
    return { globals: saved, beacon, hadBeacon };
}
function unharden(py: any, saved: Hardened): void {
    for (const k in saved.globals) { try { (globalThis as any)[k] = saved.globals[k]; } catch { /* */ } }
    const nav = (globalThis as any).navigator;
    if (nav) { try { if (saved.hadBeacon) nav.sendBeacon = saved.beacon; else delete nav.sendBeacon; } catch { /* */ } }
    // Re-expose the bridges for the next (possibly `full`) run. The default `js` module is
    // this global scope; `pyodide_js` is the Pyodide API object itself.
    try { py.registerJsModule("js", globalThis); } catch { /* already present */ }
    try { py.registerJsModule("pyodide_js", py); } catch { /* already present */ }
}

async function run(code: string, image: string | null, hardened: boolean): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string }> {
    const py = await getPyodide();
    py.globals.set("INJECTED_IMAGE_B64", image);
    const saved = hardened ? harden(py) : null;
    // Per-run namespace reset (#2 isolation): Pyodide keeps ONE persistent heap across calls,
    // so a prior run's module-level vars would leak into this one. Wipe every non-underscore
    // global before re-running the prelude (which rebuilds its own names) → a clean slate.
    const RESET = `for _k in list(globals().keys()):\n    if not _k.startswith('_'):\n        try: del globals()[_k]\n        except Exception: pass\n`;
    // The model's code becomes the body of `_user()`. `global result` + a captured return
    // handle BOTH conventions (#5): a `return X` (result = the return) AND a bare top-level
    // `result = X` with no return (the return is None, so we keep the assigned global).
    // Capture stdout/stderr IN Python (byte-exact, newlines intact) and catch the user's
    // runtime errors there too, so a traceback AND partial stdout both survive. The result is
    // serialized to JSON in Python (#4 — leak-proof: no nested JsProxy to destroy; numpy
    // scalars coerced via `.item()`), with a `null` sentinel when it isn't JSON-serializable.
    const wrapped = `${RESET}${PRELUDE}\nresult = None\ndef _user():\n    global result\n${indent(code)}\n` +
        `_out = io.StringIO()\n_err = None\n` +
        `with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out):\n` +
        `    try:\n        _ret = _user()\n        if _ret is not None:\n            result = _ret\n` +
        `    except BaseException:\n        import traceback\n        _err = traceback.format_exc()\n        result = None\n` +
        `_stdout = _out.getvalue()\n` +
        `import json as _json\n` +
        `try:\n    _json_result = _json.dumps(result, default=lambda o: o.item() if hasattr(o, 'item') else str(o))\nexcept Exception:\n    _json_result = None\n`;
    try {
        await py.runPythonAsync(wrapped);
        const stdout = String(py.globals.get("_stdout") ?? "");
        const err = py.globals.get("_err");
        if (err) return { ok: false, stdout, error: String(err) };
        const jsonResult = py.globals.get("_json_result");
        if (typeof jsonResult === "string") {
            let value: unknown; try { value = JSON.parse(jsonResult); } catch { value = jsonResult; }
            return { ok: true, value, stdout };
        }
        // Fallback for a non-JSON-serializable return (rare — models return images via
        // to_base64): convert via toJs, then destroy the proxy so it can't leak.
        const r = py.globals.get("result");
        const value = r && r.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r;
        if (r && r.destroy) r.destroy();
        return { ok: true, value: sanitize(value), stdout };
    } catch (e: any) {
        return { ok: false, stdout: "", error: String((e && e.message) || e) };   // wrapper didn't run (syntax error)
    } finally {
        py.globals.set("INJECTED_IMAGE_B64", null);
        if (saved) unharden(py, saved);
    }
}

// Serialize PY_RUN so a hardened run's global swap (harden/unharden) can't overlap another
// run on the shared Pyodide instance — one leaking capabilities into the other.
let runChain: Promise<unknown> = Promise.resolve();
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== "PY_RUN") return;
    runChain = runChain
        .then(() => run(msg.code, msg.image ?? null, msg.hardened !== false))
        .then(sendResponse, e => sendResponse({ ok: false, stdout: "", error: String(e) }));
    return true;   // keep the channel open for the async result
});
