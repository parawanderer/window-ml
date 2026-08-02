// The Python source assembled around a `python_exec` snippet — the PRELUDE (what's preloaded:
// numpy/PIL/pandas, the injected image → img/img_np, the injected tables → named DataFrames + a
// `tables` dict) and the wrapper that runs the user's code, captures stdout/return/tracebacks, and
// JSON-serializes the result. Split out of offscreen.ts (which owns the browser/Pyodide plumbing
// + hardening) so this drift-prone Python can be exercised against REAL CPython in tests
// (tests/python.test.js) instead of a re-implementation. Chrome-free (only imports python-env).
import { PY_PRELUDE_IMPORTS } from "./python-env";

// Standard prelude injected before the model's code: numpy/PIL/pandas in scope, an optional
// `img` (PIL.Image) + `img_np` (H×W×3 uint8) decoded from the injected screenshot, a `to_base64()`
// helper, and the injected tables as named DataFrames (+ a `tables` dict). Reads the JS-injected
// globals INJECTED_IMAGE_B64 / INJECTED_TABLES_JSON (set before this runs).
export const PRELUDE = /* python */ `
import io, base64, sys, contextlib
${PY_PRELUDE_IMPORTS}

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

# Each DataFrame is bound BOTH under its own variable name AND in a "tables" dict (tables[name]) —
# models reaching for either work (the map's param name is tables, so tables[x] is a natural guess;
# the description tells them to use the bare name). df stays the single-source alias.
df = None
tables = {}
_tsj = globals().get("INJECTED_TABLES_JSON")
if _tsj:
    import json as _json
    def _build_df(_t):
        if _t.get("kind") == "rows":
            _cols = _t.get("columns") or []
            _rows = _t.get("rows") or []
            if _cols:
                _w = len(_cols)
                _rows = [ (list(_r) + [None] * _w)[:_w] for _r in _rows ]
                return pd.DataFrame(_rows, columns=_cols)
            return pd.DataFrame(_rows)
        return pd.read_html(io.StringIO(_t.get("html") or ""), flavor="bs4")[0]
    for _entry in _json.loads(_tsj):
        _df = _build_df(_entry["data"])
        globals()[_entry["name"]] = _df
        tables[_entry["name"]] = _df
        # Also key by the SOURCE string (e.g. a single source "current" → tables['current']), so a model
        # that mirrors the arg it passed reaches its df without knowing the internal 'df' name.
        _alias = _entry.get("alias")
        if _alias and _alias != _entry["name"]:
            tables[_alias] = _df

# --- Loader interception (DX, not a security boundary) ---------------------------------------
# Models have strong pre-training habits — Image.open(path), pd.read_csv(name), pd.read_html(
# selector) — and reach for them with the SELECTOR/name they passed to the tool (observed:
# Image.open('canvas#stage'), pd.read_csv('current')). This sandbox has no filesystem, so those
# only ever throw FileNotFoundError, burning a whole turn. Their INTENT is obvious: the
# already-loaded img / a loaded DataFrame. Redirect the call to the in-memory object — but ONLY
# when we actually HAVE it, and never for a real file-like/URL — so nothing legitimate is
# hijacked (a genuine http read_csv, or Image.open(BytesIO(...)), passes straight through). The
# on-error redirect hint in builtin-tools.ts stays as the fallback for what this can't resolve.
#
# Patched ONCE — the module attrs (Image.open/pd.read_*) and the _-prefixed originals both
# survive RESET (module state persists on Pyodide's single heap; _-names aren't cleared). The
# patched funcs resolve img/tables DYNAMICALLY from globals() each call, so across runs they
# always see the CURRENT run's freshly-loaded data, never a stale closure.
def _ml_pick_table(_name):
    _t = globals().get("tables") or {}
    if isinstance(_name, str) and _name in _t: return _t[_name]
    if len(_t) == 1: return next(iter(_t.values()))   # one table loaded → that's the one they meant
    return None
def _ml_tableish(_s):
    # A string that names a loaded table, not a real resource (not a URL, not raw HTML).
    return isinstance(_s, str) and "://" not in _s and not _s.lstrip().startswith("<")
if "_ml_orig_image_open" not in globals():
    _ml_orig_image_open = Image.open
    def _ml_image_open(_fp, *_a, **_k):
        # No str can name a real file here → if an image is loaded, that's what they meant.
        if isinstance(_fp, str) and globals().get("img") is not None: return globals()["img"]
        return _ml_orig_image_open(_fp, *_a, **_k)
    Image.open = _ml_image_open
if "_ml_orig_read_csv" not in globals():
    _ml_orig_read_csv = pd.read_csv
    def _ml_read_csv(_fp, *_a, **_k):
        if _ml_tableish(_fp):
            _t = _ml_pick_table(_fp)
            if _t is not None: return _t
        return _ml_orig_read_csv(_fp, *_a, **_k)
    pd.read_csv = _ml_read_csv
if "_ml_orig_read_html" not in globals():
    _ml_orig_read_html = pd.read_html
    def _ml_read_html(_fp, *_a, **_k):
        if _ml_tableish(_fp):
            _t = _ml_pick_table(_fp)
            if _t is not None: return [_t]   # read_html returns a LIST of tables
        return _ml_orig_read_html(_fp, *_a, **_k)
    pd.read_html = _ml_read_html
`;

// Network policy. pandas' read_csv/read_html and urllib all funnel through
// `urllib.request.OpenerDirector.open`, so patch THAT (robust to however urlopen was imported). The
// original is saved once (module state persists across runs in Pyodide's single heap) and the policy
// is (re)set EVERY run by mode — so switching modes can't leave the wrong open installed.
//
// - readonly (DX, not a security boundary): there is no network anyway — WASM has no raw sockets, and
//   harden() nulls the JS fetch bridge — but urllib dies deep in the socket layer with a confusing
//   40-line "[Errno 23] Host is unreachable". Replace it with one clear line steering to the loaded data.
// - full: make the sync pandas idiom actually WORK by routing urllib through Pyodide's SYNCHRONOUS
//   `pyodide.http.open_url` (a sync XHR) wrapped in a minimal urllib-response shim. Caveats (surfaced
//   in the on-failure message): uncredentialed (no cookies — for a PRIVATE sheet use the `tables` param,
//   which fetches credentialed) + text-only + subject to CORS/host-permissions like any extension fetch.
//   Guarded: if pyodide.http can't load, full mode falls back to the raw (socket-bound) original.
const netPolicy = (hardened: boolean): string => {
    let policy = /* python */ `
import urllib.request as _mlnet
if not hasattr(_mlnet.OpenerDirector, "_ml_orig_open"):
    _mlnet.OpenerDirector._ml_orig_open = _mlnet.OpenerDirector.open
`;

    if (hardened) {
        policy += /* python */ `
def _ml_blocked_open(self, *_a, **_k):
    raise RuntimeError("network is disabled in readonly python_exec — the tool ALREADY loaded your table/sheet/image via the tables/image parameter, so reference it directly (e.g. df, df_remote, img). For a live fetch, re-run in mode:'full'.")
_mlnet.OpenerDirector.open = _ml_blocked_open
`;

    } else {
        policy += /* python */ `
try:
    import pyodide.http as _mlph, io as _mlio
    class _MlResp(_mlio.BytesIO):   # a subclass has a __dict__, so urllib/pandas can poke .headers/.status/.url
        def geturl(self): return getattr(self, "url", None)
        def info(self): return getattr(self, "headers", {})
        def getcode(self): return getattr(self, "status", 200)
    def _ml_working_open(self, fullurl, data=None, timeout=None):
        _u = fullurl.full_url if hasattr(fullurl, "full_url") else fullurl
        try:
            _text = _mlph.open_url(_u).getvalue()   # synchronous XHR → StringIO of the response text
        except Exception as _e:
            raise RuntimeError("full-mode fetch of " + repr(_u) + " failed (" + str(_e) + "). Pyodide fetches via the browser: the host must allow CORS and the extension must have access to it (check site access / host permissions). This path is UNCREDENTIALED + text-only — for a private Google Sheet use the tool's tables param instead (it fetches with your login).")
        _r = _MlResp(_text.encode())
        _r.headers = {}; _r.status = 200; _r.url = _u
        return _r
    _mlnet.OpenerDirector.open = _ml_working_open
except Exception:
    _mlnet.OpenerDirector.open = _mlnet.OpenerDirector._ml_orig_open
`;

    }

    return policy;
}

// Per-run namespace reset (isolation): Pyodide keeps ONE persistent heap across calls, so a prior
// run's module-level vars would leak into the next. Wipe every non-underscore global before the
// prelude re-runs (rebuilding its own names). Keep the JS-injected inputs (set before this runs).
export const RESET = /* python */ `
for _k in list(globals().keys()):
    if not _k.startswith('_') and _k not in ('INJECTED_IMAGE_B64', 'INJECTED_TABLES_JSON'):
        try: del globals()[_k]
        except Exception: pass
`;

// The full script for one run: RESET + PRELUDE + the user's code, run as the body of `_user()`.
// The body is built at RUNTIME via ast so THREE conventions all work: an explicit `return X`, a bare
// top-level `result = X`, AND a bare TRAILING EXPRESSION (`df` on the last line ⇒ its value, Jupyter/
// REPL-style, matching how a notebook cell and the JS `exec` tool surface the last expression). The
// user source is embedded as a STRING (JSON.stringify → a valid Python string literal), parsed inside a
// `def _user()` wrapper (so a top-level `return` is legal), and its trailing `Expr` rewritten to a
// `Return`. stdout/stderr are captured IN Python (byte-exact); runtime AND syntax errors are caught here
// (traceback + partial stdout survive). The result is JSON-serialized in Python (leak-proof — no JsProxy
// to destroy; numpy scalars coerced via `.item()`), null when unserializable. Reads: `_stdout`, `_err`,
// `_json_result`, `result`.
export const wrapUserCode = (code: string, hardened = true): string => /* python */ `
${RESET}${PRELUDE}
${netPolicy(hardened)}
result = None
_ml_src = ${JSON.stringify(code)}
_out = io.StringIO()
_err = None
with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out):
    try:
        import ast as _ast, textwrap as _tw
        # Parse the code AS _user's body (a top-level \`return\` is only legal inside a function), then
        # Jupyter-style: a bare trailing EXPRESSION becomes the return value. A leading \`pass\` keeps the
        # body non-empty (empty code) without ever being the trailing statement of real code.
        _ml_tree = _ast.parse("def _user():\\n    global result\\n    pass\\n" + _tw.indent(_ml_src, "    "))
        _ml_body = _ml_tree.body[0].body
        if isinstance(_ml_body[-1], _ast.Expr):
            _ml_body[-1] = _ast.copy_location(_ast.Return(_ml_body[-1].value), _ml_body[-1])
            _ast.fix_missing_locations(_ml_tree)
        exec(compile(_ml_tree, "<python_exec>", "exec"), globals())
        _ret = _user()
        if _ret is not None:
            result = _ret
    except BaseException:
        import traceback
        _err = traceback.format_exc()
        result = None
_stdout = _out.getvalue()
import json as _json
try:
    _json_result = _json.dumps(result, default=lambda o: o.item() if hasattr(o, 'item') else str(o))
except Exception:
    _json_result = None
# If the result is a DataFrame/Series, ALSO serialize it structurally ({columns, rows}) so the UI can
# render a real table (PyDfTable) instead of a text repr. Capped rows; a Series becomes a 1-col frame.
_json_table = None
try:
    _cls = result.__class__.__name__
    if _cls in ('DataFrame', 'Series') and hasattr(result, 'to_json'):
        _dfr = result.to_frame() if _cls == 'Series' else result
        _split = _json.loads(_dfr.head(200).to_json(orient='split', date_format='iso'))
        _json_table = _json.dumps({'columns': [str(_c) for _c in _split.get('columns', [])], 'rows': _split.get('data', [])})
except Exception:
    _json_table = None
`;

// --- Sandbox hardening (the `readonly` mode) --------------------------------------
// python_exec is auto-approvable ONLY because a hardened run genuinely cannot reach the
// outside world. There are three Python→outside bridges: (1) Pyodide's `js`/`pyodide_js`
// modules — but unregistering isn't enough: a prior `full` run's `import js` leaves a cached
// JsProxy in `sys.modules['js']` that `import js` reaches straight past the unregister, so we
// must PURGE sys.modules too; (2) `pyodide.code.run_js(...)`, which executes JS in this
// document's global scope; (3) any leaked proxy. Defences (all three bridges converge on the JS
// global scope): unregister + sys.modules-purge the modules, AND null every network/exfil
// primitive on the global (fetch/XHR/WebSocket/Worker/… + navigator.sendBeacon) so even run_js
// or a leaked proxy hits `undefined`. A `full` run (agent-declared, always manually approved)
// leaves them intact. Restored via unharden() in a `finally`; runs are serialized so the global
// swap can't race a concurrent run. Chrome-free (globalThis + py only) → escape-tested in
// tests/python.test.js against real Pyodide.
const NET_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "BroadcastChannel", "RTCPeerConnection", "chrome", "importScripts"];
export interface Hardened { globals: Record<string, unknown>; beacon: unknown; hadBeacon: boolean; }
export function harden(py: any): Hardened {
    for (const m of ["js", "pyodide_js"]) { try { py.unregisterJsModule(m); } catch { /* not registered */ } }
    // The cache-leak fix: drop any JsProxy a prior `full` run cached under import.
    try { py.runPython("import sys\nsys.modules.pop('js', None)\nsys.modules.pop('pyodide_js', None)"); } catch { /* */ }
    const saved: Record<string, unknown> = {};
    for (const k of NET_GLOBALS) { saved[k] = (globalThis as any)[k]; try { (globalThis as any)[k] = undefined; } catch { /* non-configurable */ } }
    const nav = (globalThis as any).navigator;
    const hadBeacon = !!nav && Object.prototype.hasOwnProperty.call(nav, "sendBeacon");
    const beacon = nav ? nav.sendBeacon : undefined;
    if (nav) { try { nav.sendBeacon = () => false; } catch { /* */ } }
    return { globals: saved, beacon, hadBeacon };
}
export function unharden(py: any, saved: Hardened): void {
    for (const k in saved.globals) { try { (globalThis as any)[k] = saved.globals[k]; } catch { /* */ } }
    const nav = (globalThis as any).navigator;
    if (nav) { try { if (saved.hadBeacon) nav.sendBeacon = saved.beacon; else delete nav.sendBeacon; } catch { /* */ } }
    // Re-expose the bridges for the next (possibly `full`) run. The default `js` module is
    // this global scope; `pyodide_js` is the Pyodide API object itself.
    try { py.registerJsModule("js", globalThis); } catch { /* already present */ }
    try { py.registerJsModule("pyodide_js", py); } catch { /* already present */ }
}
