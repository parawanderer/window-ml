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

async function run(code: string, image: string | null): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string }> {
    const py = await getPyodide();
    py.globals.set("INJECTED_IMAGE_B64", image);
    // The model's code becomes the body of `_user()`. Capture stdout/stderr IN Python
    // (byte-exact, newlines intact) and catch the user's runtime errors there too, so a
    // traceback AND any partial stdout both survive. `result`/`_stdout`/`_err` come back
    // as globals. (A syntax error in the code fails the wrapper compile → the JS catch.)
    const wrapped = `${PRELUDE}\ndef _user():\n${indent(code)}\n` +
        `_out = io.StringIO()\n_err = None\n` +
        `with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out):\n` +
        `    try:\n        result = _user()\n` +
        `    except BaseException:\n        import traceback\n        _err = traceback.format_exc()\n        result = None\n` +
        `_stdout = _out.getvalue()\n`;
    try {
        await py.runPythonAsync(wrapped);
        const stdout = String(py.globals.get("_stdout") ?? "");
        const err = py.globals.get("_err");
        if (err) return { ok: false, stdout, error: String(err) };
        const r = py.globals.get("result");
        const value = r && r.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r;
        if (r && r.destroy) r.destroy();
        return { ok: true, value: sanitize(value), stdout };
    } catch (e: any) {
        return { ok: false, stdout: "", error: String((e && e.message) || e) };   // wrapper didn't run (syntax error)
    } finally {
        py.globals.set("INJECTED_IMAGE_B64", null);
    }
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== "PY_RUN") return;
    run(msg.code, msg.image ?? null).then(sendResponse).catch(e => sendResponse({ ok: false, stdout: "", error: String(e) }));
    return true;   // keep the channel open for the async result
});
