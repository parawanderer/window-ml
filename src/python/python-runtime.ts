// The Python source assembled around a `python_exec` snippet — the PRELUDE (what's preloaded:
// numpy/PIL/pandas, the injected image → img/img_np, the injected tables → named DataFrames + a
// `tables` dict) and the wrapper that runs the user's code, captures stdout/return/tracebacks, and
// JSON-serializes the result. Split out of offscreen.ts (which owns the browser/Pyodide plumbing
// + hardening) so this drift-prone Python can be exercised against REAL CPython in tests
// (tests/python.test.js) instead of a re-implementation. Chrome-free (only imports python-env).
import { PY_PRELUDE_IMPORTS } from "./python-env";
import { ML_FACADE, ML_FACADE_NAMES } from "./ml-facade";
import { OUTPUT_CEILING } from "../agent/output-clip";
import { insideDefs, INSIDE_CELL } from "./python-dialect-run";
import { cellBoundary } from "./cell-gate";
import { spendSweep } from "./spend-queue";

/** Pyodide's stdout handler for a STREAMED run: hands `onStdout` the exact text written, newlines included. The
 *  `batched` handler it replaces passes each line with its newline stripped, so a live cell read
 *  "rolled 2000rolled 4000" until the final capture replaced it. Decodes across writes, so a character split
 *  between two writes arrives whole. */
export function stdoutWriter(onStdout: (chunk: string) => void): { write: (buf: Uint8Array) => number } {
    const dec = new TextDecoder();
    return { write: (buf) => { const s = dec.decode(buf, { stream: true }); if (s) onStdout(s); return buf.length; } };
}

/**
 * Release a kept namespace (ROOT C's per-run dict) so no other cell in the interpreter can reach it. Emptied FIRST:
 * the functions a cell defined hold the dict through their `__globals__`, so releasing the proxy alone leaves a cycle
 * that `gc.get_objects()` from another run's cell still walks to until a collection happens.
 * @param ns the namespace dict (a PyProxy)
 */
export function releaseNamespace(ns: any): void {
    try { ns.clear(); } catch { /* already gone */ }
    try { ns.destroy(); } catch { /* already gone */ }
}

/**
 * Hand the run's inputs to the interpreter as PYTHON values — `None` or `str`, never a JS null.
 * `ns.set` of a JS null lands as `JsNull` (a JsProxy in the namespace — the P3 vector); `undefined`
 * lands as Python `None`. Measured on Pyodide: `set(k, null)` → `JsNull`, `set(k, undefined)` → `None`,
 * and `toPy(null)` is itself `JsNull` — only `undefined` converts.
 *
 * @param ns the namespace to set on — `py.globals`, or a bench namespace
 * @param image the injected screenshot (data: URL / base64), or null for none
 * @param tablesJson the injected tables already JSON-encoded, or null for none
 * @param harness the harness module `lockdownReadonly` captured at boot. Re-bound HERE before every
 *   cell, never looked up through `sys.modules`: a cell that pops `sys.modules["_ml_harness"]` cannot
 *   force the next cell into the wrapper's `except ImportError` fallback (which imports the patched
 *   `ast`/`json`). Absent (real-CPython tests without the lockdown): the wrapper falls back to imports.
 */
export function injectInputs(ns: any, image: string | null, tablesJson: string | null, harness?: unknown): void {
    // Between cells: close the cell gate's window, so the next cell's revoke reaches only what that cell made.
    cellBoundary();
    if (harness !== undefined) ns.set("_ml_harness", harness);
    ns.set("INJECTED_IMAGE_B64", image == null ? undefined : String(image));
    ns.set("INJECTED_TABLES_JSON", tablesJson == null ? undefined : String(tablesJson));
}

// Standard prelude injected before the model's code: numpy/PIL/pandas in scope, an optional
// `img` (PIL.Image) + `img_np` (H×W×3 uint8) decoded from the injected screenshot, a `to_base64()`
// helper, and the injected tables as named DataFrames (+ a `tables` dict). Reads the JS-injected
// globals INJECTED_IMAGE_B64 / INJECTED_TABLES_JSON (set before this runs).
// The prelude in three parts, so the persistent BENCH can take only the first. BASE: imports + helpers.
// DATA: the injected image/tables for a `python_exec` (resets `img`/`df`/`tables` to None each run, so it
// would wipe a bench user's `df` between runs). LOADERS: the redirects that serve those injected objects —
// ONE patch per interpreter, reading the namespace the running cell's prelude names (`__main__._ml_load_ns`).
// The bench has no injected data, so it needs neither (and names no namespace). `PRELUDE` is the three joined, unchanged.
export const PRELUDE_BASE = /* python */ `
import io, base64, sys, contextlib
${PY_PRELUDE_IMPORTS}

def to_base64(x):
    if isinstance(x, np.ndarray):
        x = Image.fromarray(x.astype("uint8"))
    _b = io.BytesIO(); x.save(_b, format="PNG")
    return "data:image/png;base64," + base64.b64encode(_b.getvalue()).decode()

`;
const PRELUDE_DATA = /* python */ `
img = None
img_np = None
H = W = 0
_b64 = globals().get("INJECTED_IMAGE_B64")
if _b64:
    _raw = _ml_b64d(_b64.split(",")[-1])   # tolerate a data: URL prefix
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
    def _build_df(_t):
        # A STORED table (the value store): its bytes were copied once into a bytearray bound as _t["buf"], and are
        # decoded here by the format they arrived in. A delimited body is re-read with the columns, delimiter and
        # header decision its preview already made, so pandas cannot disagree with what the model was shown.
        if _t.get("kind") == "value":
            _buf = globals().pop(_t.get("buf") or "", None)
            if _buf is None:
                raise RuntimeError("the stored table was not handed to the sandbox")
            _fmt = _t.get("format")
            if _fmt in ("arrow-file", "arrow-stream"):
                import pyarrow as _pa, pyarrow.ipc as _ipc
                _src = _pa.py_buffer(_buf)
                return (_ipc.open_file(_src) if _fmt == "arrow-file" else _ipc.open_stream(_src)).read_all().to_pandas()
            if _fmt == "parquet":
                import pyarrow as _pa, pyarrow.parquet as _pq
                return _pq.read_table(_pa.BufferReader(_pa.py_buffer(_buf))).to_pandas()
            if _fmt in ("csv", "tsv"):
                _sep = _t.get("delimiter") or ("\t" if _fmt == "tsv" else ",")
                return pd.read_csv(io.BytesIO(_buf), sep=_sep, header=None if _t.get("headerless") else 0, names=_t.get("columns") or None)
            raise RuntimeError("a stored table in a format the sandbox does not read: " + str(_fmt))
        if _t.get("kind") == "rows":
            _cols = _t.get("columns") or []
            _rows = _t.get("rows") or []
            if _cols:
                _w = len(_cols)
                _rows = [ (list(_r) + [None] * _w)[:_w] for _r in _rows ]
                return pd.DataFrame(_rows, columns=_cols)
            return pd.DataFrame(_rows)
        return pd.read_html(io.StringIO(_t.get("html") or ""), flavor="bs4")[0]
    for _entry in _ml_loads(_tsj):
        _df = _build_df(_entry["data"])
        globals()[_entry["name"]] = _df
        tables[_entry["name"]] = _df
        # Also key by the SOURCE string (e.g. a single source "current" → tables['current']), so a model
        # that mirrors the arg it passed reaches its df without knowing the internal 'df' name.
        _alias = _entry.get("alias")
        if _alias and _alias != _entry["name"]:
            tables[_alias] = _df

`;
const PRELUDE_LOADERS = /* python */ `
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
# ONE patch per interpreter. It is installed inside a function, so the originals live in its closure and no
# namespace (a run's dict included) holds an \`_ml_orig_*\` name to chain onto. The guard is on the patched
# module, so a later prelude run in ANY namespace installs nothing. The wrappers read img/tables from the
# namespace the prelude of the cell that is running named (\`__main__._ml_load_ns\`, set per cell below), never
# from the dict that defined them, so a second run cannot be handed the first run's image. None (the bench)
# means no redirect: the real open runs.
def _ml_install_loaders(_Image, _pd):
    import __main__ as _main
    def _ns():
        return getattr(_main, "_ml_load_ns", None) or {}
    def _pick_table(_name):
        _t = _ns().get("tables") or {}
        if isinstance(_name, str) and _name in _t: return _t[_name]
        if len(_t) == 1: return next(iter(_t.values()))   # one table loaded → that's the one they meant
        return None
    def _tableish(_s):
        # A string that names a loaded table, not a real resource (not a URL, not raw HTML).
        return isinstance(_s, str) and "://" not in _s and not _s.lstrip().startswith("<")
    _orig_open = _Image.open
    def _ml_image_open(_fp, *_a, **_k):
        # No str can name a real file here → if an image is loaded, that's what they meant.
        _img = _ns().get("img")
        if isinstance(_fp, str) and _img is not None: return _img
        return _orig_open(_fp, *_a, **_k)
    _orig_read_csv = _pd.read_csv
    def _ml_read_csv(_fp, *_a, **_k):
        # The exact source a table was loaded from (a URL included) is that table: the sandbox has no network,
        # and re-reading what \`tables\` already loaded is the commonest first try. Any other URL is not hijacked.
        _tt = _ns().get("tables") or {}
        if isinstance(_fp, str) and _fp in _tt: return _tt[_fp]
        if _tableish(_fp):
            _t = _pick_table(_fp)
            if _t is not None: return _t
        return _orig_read_csv(_fp, *_a, **_k)
    _orig_read_html = _pd.read_html
    def _ml_read_html(_fp, *_a, **_k):
        _tt = _ns().get("tables") or {}
        if isinstance(_fp, str) and _fp in _tt: return [_tt[_fp]]
        if _tableish(_fp):
            _t = _pick_table(_fp)
            if _t is not None: return [_t]   # read_html returns a LIST of tables
        return _orig_read_html(_fp, *_a, **_k)
    _Image.open, _pd.read_csv, _pd.read_html = _ml_image_open, _ml_read_csv, _ml_read_html
    _main._ml_load_ns = None
if not hasattr(pd, "_ml_loaders_installed"):
    _ml_install_loaders(Image, pd)
    pd._ml_loaders_installed = True
del _ml_install_loaders
import __main__ as _ml_m
_ml_m._ml_load_ns = globals()
del _ml_m
`;
// The bench injects no data and keeps no redirect: it names NO namespace for the loaders, so a patch an earlier
// cell installed falls through to the real open rather than serving another namespace's names.
const PRELUDE_NO_LOADS = /* python */ `
import __main__ as _ml_m
_ml_m._ml_load_ns = None
del _ml_m
`;
export const PRELUDE = PRELUDE_BASE.slice(0, -1) + PRELUDE_DATA.slice(0, -1) + PRELUDE_LOADERS;
/**
 * Replace one exact piece of a prelude, refusing when it is not there exactly once, so an edit to `PRELUDE_DATA`
 * cannot silently leave the kept variant resetting what it must not.
 * @param src the prelude source
 * @param from the exact text to replace
 * @param to its replacement
 * @returns the edited source
 */
const replaceOnce = (src: string, from: string, to: string): string => {
    if (src.split(from).length !== 2) throw new Error(`prelude: expected exactly one ${JSON.stringify(from)}`);
    return src.replace(from, to);
};
// ROOT C's per-run dict: the same DATA, but `img`/`img_np`/`H`/`W` and `df`/`tables` are bound only by a cell that
// passes an image or tables, so a later cell that passes none keeps them. The "run" prelude then adds the LOADERS:
// one shared patch per interpreter that reads the namespace of the cell running, so a second run's dict installs
// nothing over the first and cannot be handed the first run's `img`.
const PRELUDE_DATA_KEPT = replaceOnce(replaceOnce(PRELUDE_DATA,
    "img = None\nimg_np = None\nH = W = 0\n", ""),
    "df = None\ntables = {}\n_tsj = globals().get(\"INJECTED_TABLES_JSON\")\nif _tsj:\n",
    "_tsj = globals().get(\"INJECTED_TABLES_JSON\")\nif _tsj:\n    df = None\n    tables = {}\n");

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
/**
 * The script the sandbox runs: prelude, network policy, and the user's code wrapped so a top-level `return`,
 * a trailing expression and a traceback all come back.
 *
 * @param persist a KEEP-STATE mode: `true` is the bench (only `PRELUDE_BASE`), `"run"` is ROOT C's per-run dict
 *   (`PRELUDE_BASE` and the injected image/tables, bound only when a cell passes them). Neither resets, and the
 *   script's own top-level names are declared `global` in the wrapper, so they land in the namespace it runs in and
 *   are still there next run. Without that the wrapper's function scope would swallow them: `x = 1` is a LOCAL of
 *   `_user` and disappears when the run ends.
 *
 * Split as SETUP (harness, reset, prelude, net policy, `ml` facade) + SCRIPT (the cell itself) so the worker can
 * fire `started` — and arm the script's 15s — when the user's code is about to run, not while the prelude imports
 * pandas (`wrapUserCode` is the two joined, unchanged, for the real-CPython tests that run one string).
 */
export const wrapUserSetup = (hardened = true, persist: boolean | "run" = false): string => /* python */ `
# THE HARNESS'S OWN REFS (lockdown.ts captured them at boot, before any cell ran). A cell that patches
# \`ast.parse\` or \`json.loads\` changes what the RUN's own later cells see, never what the harness parses,
# encodes or injects. Looked up in the NAMESPACE — \`injectInputs\` re-binds the module before every cell —
# never through \`sys.modules\`: a cell that pops the entry there must not force this cell into the import
# fallback below. Fallback to the plain module attributes when the module is absent (real-CPython tests).
_ml_h = globals().get("_ml_harness")
if _ml_h is not None and getattr(_ml_h, "ast_parse", None) is not None:
    _ml_parse = _ml_h.ast_parse
    _ml_loads = _ml_h.json_loads
    _ml_dumps = _ml_h.json_dumps
    _ml_ino = _ml_h.ast_increment_lineno
    _ml_cloc = _ml_h.ast_copy_location
    _ml_fix = _ml_h.ast_fix_missing_locations
    _ml_Ret = _ml_h.ast_Return
    _ml_Expr = _ml_h.ast_Expr
    _ml_Call = _ml_h.ast_Call
    _ml_Attr = _ml_h.ast_Attribute
    _ml_Name = _ml_h.ast_Name
    _ml_Assign = _ml_h.ast_Assign
    _ml_walk = _ml_h.ast_walk
    _ml_b64d = _ml_h.b64decode
    _ml_b64e = _ml_h.b64encode
    _ml_indent = _ml_h.indent
    _ml_bytesio = _ml_h.bytes_io
    _ml_stringio = _ml_h.string_io
    _ml_fmt_exc = _ml_h.format_exc
    _ml_redir_out = _ml_h.redirect_stdout
    _ml_redir_err = _ml_h.redirect_stderr
    _ml_real_out = _ml_h.sys_stdout
else:
    import ast as _ml_a2, json as _ml_j2, base64 as _ml_b2, textwrap as _ml_tw2, traceback as _ml_tb2, io as _ml_io2, contextlib as _ml_c2, sys as _ml_s2
    _ml_parse, _ml_loads, _ml_dumps = _ml_a2.parse, _ml_j2.loads, _ml_j2.dumps
    _ml_ino, _ml_cloc, _ml_fix = _ml_a2.increment_lineno, _ml_a2.copy_location, _ml_a2.fix_missing_locations
    _ml_Ret, _ml_Expr = _ml_a2.Return, _ml_a2.Expr
    _ml_Call, _ml_Attr, _ml_Name, _ml_Assign = _ml_a2.Call, _ml_a2.Attribute, _ml_a2.Name, _ml_a2.Assign
    _ml_walk = _ml_a2.walk
    _ml_b64d, _ml_b64e = _ml_b2.b64decode, _ml_b2.b64encode
    _ml_indent, _ml_bytesio = _ml_tw2.indent, _ml_io2.BytesIO
    _ml_stringio, _ml_fmt_exc = _ml_io2.StringIO, _ml_tb2.format_exc
    _ml_redir_out, _ml_redir_err = _ml_c2.redirect_stdout, _ml_c2.redirect_stderr
    _ml_real_out = _ml_s2.stdout
# ASYNC CELL DRIVERS (the harness captures them; the fallback imports them). A cell's \`_user\` is a
# coroutine function so \`await ml.*\` is legal — the runner is \`runPythonAsync\`, which allows top-level
# await. When no loop is running (a sync \`exec()\` of this wrapper, compiled with
# \`ast.PyCF_ALLOW_TOP_LEVEL_AWAIT\` if the cell awaits), asyncio drives the coroutine instead.
if _ml_h is not None and getattr(_ml_h, "ast_parse", None) is not None:
    _ml_inspect = _ml_h.inspect
    _ml_asyncio = _ml_h.asyncio
else:
    import inspect as _ml_inspect, asyncio as _ml_asyncio
# THE CELL GATE (cell-gate.ts): what the cell hands to JavaScript is revoked in the cancel. No-ops without the lockdown.
_ml_cell_begin = getattr(_ml_h, "cell_begin", None) or (lambda: None)
_ml_cell_revoke = getattr(_ml_h, "cell_revoke", None) or (lambda: None)
# The harness module is GONE from the namespace before the user's code sees it: the refs are in local
# names now, and neither \`import _ml_harness\` (it is not in \`sys.modules\`) nor \`globals()["_ml_harness"]\`
# (popped here) reaches it. \`injectInputs\` re-binds it before the next cell.
del _ml_h
globals().pop("_ml_harness", None)
${persist === true ? "" : `
# The injected inputs are PYTHON \`None\` or \`str\`. A host \`set\` of a JS null lands as \`JsNull\` (a
# JsProxy in the namespace — the P3 vector); coerce here so the cell's namespace holds none. Belt to
# the host's \`injectInputs\`, which is the one that converts at the boundary.
def _ml_in(_v):
    return _v if (isinstance(_v, str) or _v is None) else None
INJECTED_IMAGE_B64 = _ml_in(globals().get("INJECTED_IMAGE_B64"))
INJECTED_TABLES_JSON = _ml_in(globals().get("INJECTED_TABLES_JSON"))
`}
${persist === true ? PRELUDE_BASE + PRELUDE_NO_LOADS : persist === "run" ? PRELUDE_BASE.slice(0, -1) + PRELUDE_DATA_KEPT.slice(0, -1) + PRELUDE_LOADERS : RESET + PRELUDE}
${netPolicy(hardened)}
# THE \`ml\` OBJECT A CELL CALLS THE WIRE THROUGH (ML_FACADE). Built from the harness's transport and
# its own codec refs, then those pieces are dropped: the cell sees \`ml\`/\`MlError\` and nothing that
# reaches the worker's closure-held post (LANE_1_PR2_DESIGN.md). The transport is \`_ml_send\`, a
# leading-underscore global the worker installs before the cell and this drops after building \`ml\` —
# the same shape as the stdout tee, carrying data rather than a JS function the cell holds. Absent
# when the worker installed no channel (real-CPython tests, a completion): \`ml\` is simply not bound
# and a cell that names it gets NameError.
${ML_FACADE}
_ml_send_fn = globals().get("_ml_send")
if _ml_send_fn is not None:
    class _MlCodec:
        loads = staticmethod(_ml_loads)
        dumps = staticmethod(_ml_dumps)
        b64encode = staticmethod(_ml_b64e)
        b64decode = staticmethod(_ml_b64d)
    ml, MlError = _ml_make(_ml_send_fn, _MlCodec)
    globals().pop("_ml_make", None)
    globals().pop("_ml_send", None)
else:
    globals().pop("_ml_make", None)
`;

/** The cell as full Python: parsed as an async `_user()`'s body, its trailing expression returned, and run. */
const FULL_CELL = /* python */ `
        # Parse the code AS _user's body (a top-level \`return\` is only legal inside a function), then
        # Jupyter-style: a bare trailing EXPRESSION becomes the return value. A leading \`pass\` keeps the
        # body non-empty (empty code) without ever being the trailing statement of real code.
        # ASYNC so \`await ml.dereference(...)\` is legal inside the cell (LANE_1_PR2_DESIGN.md). The
        # runner is \`runPythonAsync\`, which allows top-level await; a plain sync \`exec()\` of this
        # source must compile with \`ast.PyCF_ALLOW_TOP_LEVEL_AWAIT\` (or drive the coroutine from
        # asyncio once no loop is running).
        _ml_def_src = "async def _user():\\n    global result\\n    pass\\n" + _ml_indent(_ml_src, "    ")
        try:
            _ml_tree = _ml_parse(_ml_def_src, filename="<python_exec>")
        except SyntaxError as _ml_se:
            # A SyntaxError is raised BY THE PARSE, so the correction below never runs for it — and it
            # carries the prefixed line number in its own fields, which is what gets printed. Shift it here
            # and re-raise, or the one error whose whole content is "which line" names the wrong one.
            if _ml_se.lineno is not None:
                _ml_se.lineno = max(1, _ml_se.lineno - 3)
            if getattr(_ml_se, "end_lineno", None) is not None:
                _ml_se.end_lineno = max(1, _ml_se.end_lineno - 3)
            raise
        _ml_body = _ml_tree.body[0].body
        # KEEP-STATE (the bench): every name the script binds at its own top level becomes a global of the
        # namespace it runs in. Python's own scope analysis decides which names those are — imports, defs,
        # classes, loop targets, walrus, with/except targets — rather than a list of statement shapes that
        # would miss one. A name a nested function declares \`nonlocal\` stays local: made global, the
        # nonlocal would have no binding to refer to and the script would not compile.
        if _ml_persist:
            import symtable as _ml_st
            _ml_fn = next(_c for _c in _ml_st.symtable(_ml_def_src, "<python_exec>", "exec").get_children() if _c.get_name() == "_user")
            def _ml_nonlocals(_t):
                _out_nl = set()
                for _c in _t.get_children():
                    _out_nl |= {_sym.get_name() for _sym in _c.get_symbols() if _sym.is_nonlocal()} | _ml_nonlocals(_c)
                return _out_nl
            _ml_keep = sorted(set(_ml_fn.get_locals()) - _ml_nonlocals(_ml_fn))
            if _ml_keep:
                _ml_body[0].names.extend(_ml_keep)
        # LINE NUMBERS THE USER CAN USE. The code is indented into \`def _user():\` after a three-line prefix,
        # so without this every traceback points three lines past the statement that actually failed — on a
        # ten-line script, at somebody else's line. Corrected HERE rather than in the UI so the MODEL gets
        # true line numbers too: handing it a traceback that names the wrong line costs it a turn, and a
        # renderer that silently disagreed with the text the model was given would break the raw-view rule.
        # Only the user's own statements move; the injected \`global\`/\`pass\` keep their positions, since a
        # negative lineno will not compile.
        for _ml_n in _ml_body[2:]:
            _ml_ino(_ml_n, -3)
        if isinstance(_ml_body[-1], _ml_Expr):
            _ml_body[-1] = _ml_cloc(_ml_Ret(_ml_body[-1].value), _ml_body[-1])
            _ml_fix(_ml_tree)
        # If the RETURNED value is a latex(...) call (sympy.latex / sp.latex / a bare latex from
        # "from sympy import latex"), the string it produces IS LaTeX — remember it so the epilogue flags the
        # render (typeset, no pipe cast) even for a plain scalar like sympy.latex(5) == "5". Covers a
        # trailing expr, an explicit return, and a result = ... assignment.
        def _ml_is_latex_call(_n):
            return isinstance(_n, _ml_Call) and ((isinstance(_n.func, _ml_Attr) and _n.func.attr == "latex") or (isinstance(_n.func, _ml_Name) and _n.func.id == "latex"))
        for _n in _ml_walk(_ml_tree):
            if isinstance(_n, _ml_Ret) and _n.value is not None and _ml_is_latex_call(_n.value):
                _ml_ret_latex = True
            elif isinstance(_n, _ml_Assign) and _ml_is_latex_call(_n.value) and any(isinstance(_t, _ml_Name) and _t.id == "result" for _t in _n.targets):
                _ml_ret_latex = True
        exec(compile(_ml_tree, "<python_exec>", "exec"), globals())
        # ASYNC CELL: \`_user\` is a coroutine function so \`await ml.*\` is legal in the cell. Drive it
        # on the active loop (this source is run under \`runPythonAsync\`, which allows top-level await).
        # A sync \`exec()\` of this wrapper must compile with \`ast.PyCF_ALLOW_TOP_LEVEL_AWAIT\`, or fall
        # back to the harness/asyncio runner below when no loop is running.
        _ml_user_ret = _user()
        if _ml_inspect.iscoroutine(_ml_user_ret):
            try:
                _ml_loop = _ml_asyncio.get_running_loop()
            except RuntimeError:
                _ml_loop = None
            if _ml_loop is None:
                _ret = _ml_asyncio.new_event_loop().run_until_complete(_ml_user_ret)
            else:
                _ret = await _ml_user_ret
        else:
            _ret = _ml_user_ret
`;

/**
 * The user's cell and the wrapper that captures its stdout, its `return`/trailing expression and its traceback.
 * Runs AFTER `wrapUserSetup` in the same namespace (the `_ml_*` refs and the prelude names it needs are already
 * bound). This is the only part the script's 15s and `runMs` are meant to cover.
 *
 * @param code the user's source
 * @param persist a KEEP-STATE mode (see `wrapUserSetup`)
 * @param inside run the cell INSIDE the dialect (`INSIDE_CELL`) with the whitelist's node list, else as full Python
 * @param cancel who cancels what the cell scheduled: `"host"` when the lockdown built the cancel (lockdown.ts), which
 *   runs this script and then the cancel (`hostRunScript`), so the wrapper holds no cancel a cell could rebind;
 *   `"wrapper"` (the full worker, and a test with no lockdown) keeps the cancel in this script
 */
export const wrapUserScript = (code: string, persist: boolean | "run" = false, inside: { nodes: string[] } | null = null, cancel: "wrapper" | "host" = "wrapper"): string => /* python */ `
# Open the cell gate's window before anything of the cell's runs: what crosses to JavaScript from here on is the cell's.
_ml_cell_begin()
result = None
_ml_src = ${JSON.stringify(code)}${inside ? insideDefs(inside.nodes) : ""}
_ml_persist = ${persist ? "True" : "False"}
# The loop this run started on. A cell that calls asyncio.new_event_loop() REPLACES it (WebLoop.__init__
# calls _set_running_loop), and a handle left on the orphan then crashes the next pump with
# "Cannot enter into task" — the orphan is still the running loop, so the handle's task step passes the
# running-loop check and collides with this run's finished task. Restoring the loop in the cancel below
# turns that crash into the benign "loop is not the running loop" a cancelled handle never reaches.
try:
    import asyncio as _ml_aio0
    _ml_orig_loop = _ml_aio0.get_running_loop()
except Exception:
    _ml_orig_loop = None
# stdout capture that tees each write to the REAL stdout (Pyodide's \`setStdout\` wraps it on the JS side for
# live streaming) — no JS callback in the namespace, so the namespace holds no JsProxy at all.
class _MlTee(_ml_stringio):
    # Bounded (output-clip.ts OUTPUT_CEILING): past it a write is counted, not kept and not teed, so a print in a loop
    # costs a counter, not the worker's memory.
    _ml_kept = 0
    _ml_dropped = 0
    def write(self, _s):
        if self._ml_dropped or self._ml_kept + len(_s) > ${OUTPUT_CEILING}:
            self._ml_dropped += len(_s)
            return len(_s)
        self._ml_kept += len(_s)
        _n = super().write(_s)
        if ${inside ? "False" : "True"}:   # a try inside the dialect streams nothing: a refused one's output is dropped
            try: _ml_real_out.write(_s)
            except Exception: pass
        return _n
_out = _MlTee()
_err = None
_ml_ret_latex = False
with _ml_redir_out(_out), _ml_redir_err(_out):
    try:
${inside ? INSIDE_CELL : FULL_CELL}        if _ret is not None:
            result = _ret
    except BaseException:
        _err = _ml_fmt_exc()
        result = None
${cancel === "wrapper" ? `# THE FULL WORKER'S CANCEL. The readonly worker's is the harness's (lockdown.ts \`_ml_make_cancel\`), run after this script
# by \`hostRunScript\`, bounded, and out of a cell's reach; this one a cell can rebind, and its spend has no bound.
# Cancel everything the cell SCHEDULED before its result is returned (PYODIDE_LOCKDOWN.md step 5,
# PYTHON_CANCEL_GAPS.md). The wrapper's OWN task is left alone: cancelling it would raise CancelledError in the
# run machinery. In three steps, in this order:
# 1. Restore the running loop. A cell that calls asyncio.new_event_loop() REPLACES it (WebLoop.__init__ calls
#    _set_running_loop), and a handle on the orphan then crashes the next pump with "Cannot enter into task".
# 2. SPEND every task: cancel it and let the loop turn, so its coroutine takes the CancelledError and FINISHES. A
#    cancelled task is still PENDING until it runs once more, its coroutine suspended inside its try, and a later
#    cell holding the Task could drive it (\`task._coro.throw(...)\`) and run its finally after this result. Its
#    finally or except runs HERE, in this cell's time, its output in this cell's stdout. A task that catches the
#    cancel and awaits again is cancelled again, a bounded number of rounds; one still pending after that refuses
#    the cell, never returns a result beside a live coroutine. A cell that scheduled no task turns no loop.
# 3. REVOKE what the cell handed to JavaScript (cell-gate.ts): a callable given to setTimeout, queueMicrotask, a
#    promise or scheduleCallback makes no Task and no Handle. Then cancel every uncancelled asyncio.Handle that
#    gc.get_objects() reaches: call_soon/call_later/call_at make one, all_tasks() never sees it, and WebLoop.close()
#    is a no-op whose timers' only guard is Handle.cancelled(). After the spend, never before it: the loop's own
#    wakeups are once-callables the cell made, and a task's step revoked first never runs to take its cancel.
# HERE, not at the end of the wrapper: the epilogue below serialises the result, and a BaseException from that
# serialisation (a __str__ that raises one) used to end the wrapper before the cancel (P2-escape).
try:
    import asyncio as _ml_aio2
    if _ml_orig_loop is not None:
        _ml_aio2._set_running_loop(_ml_orig_loop)
except Exception:
    pass
_ml_SPEND_ROUNDS = 8
_ml_unspent = []
try:
    import asyncio as _ml_aio
    _ml_self = _ml_aio.current_task()
    for _ml_round in range(_ml_SPEND_ROUNDS + 1):
        _ml_unspent = [_ml_t for _ml_t in _ml_aio.all_tasks() if _ml_t is not _ml_self and not _ml_t.done()]
        if not _ml_unspent or _ml_round == _ml_SPEND_ROUNDS:
            break
        for _ml_task in _ml_unspent:
            _ml_task.cancel()
        if _ml_self is None:
            break
        await _ml_aio.sleep(0)
except BaseException:
    pass
try:
    _ml_cell_revoke()
except BaseException:
    pass
try:
    import asyncio as _ml_aio3, gc as _ml_gc
    for _ml_obj in _ml_gc.get_objects():
        if isinstance(_ml_obj, _ml_aio3.Handle) and not _ml_obj.cancelled():
            _ml_obj.cancel()
except Exception:
    pass
if _ml_unspent:
    try:
        _ml_names = ", ".join(sorted({_ml_t.get_name() + " (" + str(getattr(_ml_t.get_coro(), "__qualname__", "?")) + ")" for _ml_t in _ml_unspent}))
    except BaseException:
        _ml_names = str(len(_ml_unspent)) + " task(s)"
    _err = (_err or "") + "RuntimeError: this cell left a task running that would not stop: " + _ml_names + ". It was cancelled " + str(_ml_SPEND_ROUNDS) + " times and caught the cancel each time, so the cell's result is refused rather than returned beside it.\\n"
    result = None
` : ""}_stdout = _out.getvalue()${inside ? `
if _ml_not_in_dialect is not None:
    _stdout = ""` : ""}
_ml_stdout_dropped = _out._ml_dropped
try:
    _json_result = _ml_dumps(result, default=lambda o: o.item() if hasattr(o, 'item') else str(o))
except BaseException:
    _json_result = None
# Auto-render by RETURN TYPE (no cast needed): a sympy expression becomes its LaTeX (+ a 'latex' hint the UI
# typesets); a PIL Image becomes a data: URL (which the tool already auto-shows as an image). A model can still
# override the render with a raw pipe when citing it. Best-effort — any failure leaves the plain result untouched.
_json_render = None
try:
    _rmod = (getattr(type(result), '__module__', '') or '').split('.')[0]
    if _rmod == 'sympy':
        import sympy as _sp
        _json_result = _ml_dumps(_sp.latex(result)); _json_render = 'latex'
    elif _rmod == 'PIL' and hasattr(result, 'save'):
        _pbuf = _ml_bytesio(); result.save(_pbuf, format='PNG')
        _json_result = _ml_dumps('data:image/png;base64,' + _ml_b64e(_pbuf.getvalue()).decode()); _json_render = 'img'
    # The code RETURNED a latex(...) call's string (AST-detected above) — typeset it, even a bare "5".
    elif _ml_ret_latex and isinstance(result, str):
        _json_render = 'latex'
except BaseException:
    _json_render = None
# FIGURES (matplotlib). A returned Figure, or an Axes (its figure), draws like a returned PIL Image. A cell that returns
# NOTHING and did not fail, but leaves figures open, draws them as a notebook would: one image, several stacked top to
# bottom (the first _ml_FIGS_MAX), hinted 'figure' so the tool can say where the image came from. Then every figure is
# closed, whatever happened, so none is drawn again by the next cell of a run. Only once pyplot was imported: a script
# that never plots pays nothing here.
_ml_FIGS_MAX = 6
try:
    _ml_plt = __import__('sys').modules.get('matplotlib.pyplot')
    if _ml_plt is not None:
        try:
            _ml_figs = []
            _ml_is_mpl = lambda _v: (getattr(type(_v), '__module__', '') or '').startswith('matplotlib.')
            _ml_fmod, _ml_amod = __import__('sys').modules.get('matplotlib.figure'), __import__('sys').modules.get('matplotlib.axes')
            if _ml_fmod is not None and isinstance(result, _ml_fmod.Figure):
                _ml_figs, _ml_how = [result], 'img'
            elif _ml_amod is not None and isinstance(result, _ml_amod.Axes):
                _ml_figs, _ml_how = [result.get_figure(root=True)], 'img'
            # A trailing plt.plot(...) or plt.title(...) RETURNS its artists: the notebook habit is to show the
            # figure, not the repr of a Line2D list, so a value made only of artists counts as returning nothing.
            elif _err is None and (result is None or _ml_is_mpl(result) or (isinstance(result, (list, tuple)) and result and all(_ml_is_mpl(_v) for _v in result))):
                _ml_figs, _ml_how = [_ml_plt.figure(_n) for _n in _ml_plt.get_fignums()[:_ml_FIGS_MAX]], 'figure'
            if _ml_figs:
                _ml_pngs = []
                for _ml_f in _ml_figs:
                    # At most ~4 megapixels a figure: a figsize of (500, 500) would otherwise render 2.5 gigapixels into the
                    # panel and the exports. The dpi drops instead, so the figure keeps its proportions. Measured on the
                    # TIGHT box the image is cut to, not the figsize: an artist far outside the figure (a text at figure
                    # coordinates (20, 20), a label in data coordinates off the axis) grows that box, and the image with it.
                    # The padding is fixed, so an rcParams savefig.pad_inches cannot grow it either. The box is measured
                    # at the figsize's capped dpi: measuring needs a renderer the size of the figure at ITS dpi, which for
                    # a huge figsize is the gigapixel allocation this cap exists to avoid.
                    _ml_wi, _ml_hi = _ml_f.get_size_inches()
                    _ml_dpi = min(100, (4e6 / max(_ml_wi * _ml_hi, 1e-6)) ** 0.5)
                    _ml_dpi0 = _ml_f.dpi
                    try:
                        _ml_f.set_dpi(_ml_dpi)
                        _ml_bb = _ml_f.get_tightbbox()
                        _ml_dpi = min(_ml_dpi, (4e6 / max((_ml_bb.width + 0.2) * (_ml_bb.height + 0.2), 1e-6)) ** 0.5)
                    except Exception:
                        pass
                    finally:
                        _ml_f.set_dpi(_ml_dpi0)
                    _pbuf = _ml_bytesio(); _ml_f.savefig(_pbuf, format='png', dpi=_ml_dpi, bbox_inches='tight', pad_inches=0.1); _ml_pngs.append(_pbuf.getvalue())
                if len(_ml_pngs) > 1:
                    from PIL import Image as _ml_PI
                    _ml_ims = [_ml_PI.open(_ml_bytesio(_b)).convert('RGB') for _b in _ml_pngs]
                    _ml_sheet = _ml_PI.new('RGB', (max(_i.width for _i in _ml_ims), sum(_i.height for _i in _ml_ims)), 'white')
                    _ml_y = 0
                    for _i in _ml_ims:
                        _ml_sheet.paste(_i, (0, _ml_y)); _ml_y += _i.height
                    _pbuf = _ml_bytesio(); _ml_sheet.save(_pbuf, format='PNG'); _ml_pngs = [_pbuf.getvalue()]
                _json_result = _ml_dumps('data:image/png;base64,' + _ml_b64e(_ml_pngs[0]).decode()); _json_render = _ml_how
        finally:
            _ml_plt.close('all')
except BaseException:
    # A figure that cannot be drawn leaves the plain result as it was. BaseException, because what runs here is the
    # cell's own objects (a Figure's methods, a patched plt.close) outside the cell's try: a raise that escaped would
    # end the wrapper before the cancel below, and a task the cell scheduled would run during the next cell.
    pass
# If the result is a DataFrame/Series, ALSO serialize it structurally ({columns, rows}) so the UI can
# render a real table (PyDfTable) instead of a text repr. Capped rows; a Series becomes a 1-col frame.
_json_table = None
_ipc_result = None
try:
    _cls = result.__class__.__name__
    if _cls in ('DataFrame', 'Series') and hasattr(result, 'to_json'):
        _dfr = result.to_frame() if _cls == 'Series' else result
        _ml_full = _dfr
        _dfr = _dfr.head(200)
        # A CELL PANDAS CANNOT REPRESENT SERIALISES AS AN EMPTY OBJECT. An arbitrary object — a class instance, a
        # function, a nested frame — comes out of to_json as an empty object, and an empty object is a
        # PLAUSIBLE value, so the reader is shown a wrong fact exactly where they are looking for the
        # right one (this is the [object Object] bug wearing different clothes). Named here, at the
        # producer, because this is the only place the real type is still known: the panel gets a marked
        # cell it can render as "unrenderable <type>" instead of guessing from an empty object.
        # Anything json/pandas handles natively is left ALONE — a set becomes a list, a dict stays a
        # dict, a numpy scalar and a timestamp both convert — so this only touches what would be lost.
        try:
            _ml_ok = (str, bool, int, float, dict, list, tuple, set, frozenset, bytes)
            def _ml_cell(_v):
                if _v is None or isinstance(_v, _ml_ok) or _v != _v:   # _v != _v → NaN
                    return _v
                if hasattr(_v, 'item') or hasattr(_v, 'isoformat'):     # numpy scalar, datetime
                    return _v
                return {'__ml_unrenderable__': type(_v).__name__}
            for _c in _dfr.columns[_dfr.dtypes.eq('object')]:
                _dfr = _dfr.assign(**{_c: _dfr[_c].map(_ml_cell)})
        except Exception:
            pass   # a frame this cannot walk still serialises the way it always did
        _split = _ml_loads(_dfr.to_json(orient='split', date_format='iso'))
        _ml_n = len(_ml_full)
        _json_table = _ml_dumps({'columns': [str(_c) for _c in _split.get('columns', [])], 'rows': _split.get('data', []), **({'rowCount': _ml_n} if _ml_n > len(_dfr) else {})})
        # PAST THE PREVIEW, the whole frame is written as Arrow IPC for the value store, so a later step reads every row by
        # pointer (POINTER_VALUES slice 6). The index is dropped, as the preview above drops it. A frame Arrow cannot
        # hold (mixed-type object columns, non-string column names) is simply not stored: its preview still says how
        # big it is.
        if _ml_n > len(_dfr):
            try:
                import pyarrow as _pa
                _ml_at = _pa.Table.from_pandas(_ml_full, preserve_index=False)
                _ml_sink = _pa.BufferOutputStream()
                with _pa.ipc.new_file(_ml_sink, _ml_at.schema) as _ml_w:
                    _ml_w.write_table(_ml_at)
                _ipc_result = _ml_sink.getvalue().to_pybytes()
            except Exception:
                _ipc_result = None
except BaseException:
    _json_table = None
${cancel === "wrapper" ? `# The epilogue ran the cell's own objects (a __str__, a figure's methods, a frame's to_json): revoke what they handed
# to JavaScript too. Every block above catches BaseException, so this line is reached. (The host's cancel runs after
# the whole script, so it covers the epilogue already.)
try:
    _ml_cell_revoke()
except BaseException:
    pass
` : ""}`;

/**
 * The full script for one run: `wrapUserSetup` then `wrapUserScript`, joined. The worker runs the two
 * separately so `started` can fire between them; the real-CPython tests run this one string.
 */
export const wrapUserCode = (code: string, hardened = true, persist: boolean | "run" = false, cancel: "wrapper" | "host" = "wrapper"): string =>
    wrapUserSetup(hardened, persist) + wrapUserScript(code, persist, null, cancel);

/**
 * Which cancel a worker runs (PYTHON_CANCEL_GAPS.md pin 10): the locked-down readonly worker's harness has the closure
 * (`hostRunScript`); the full worker, never locked, keeps the cancel in the wrapper.
 * @param harness the harness `lockdownReadonly` returned, or undefined (no lockdown)
 * @param hardened whether the worker is the readonly (locked-down) one
 * @returns `"host"` or `"wrapper"`
 */
export const cancelPath = (harness: unknown, hardened: boolean): "host" | "wrapper" => harness !== undefined && harness !== null && hardened ? "host" : "wrapper";

/**
 * Run a cell's script and THE CANCEL as one coroutine, through the closure the lockdown built at boot (lockdown.ts
 * `run_script`; PYTHON_CANCEL_GAPS.md pin 7). Nothing the cancel reads is a name the cell could rebind, and nothing the
 * cell queued on the JavaScript side runs between the script and the cancel. Fails closed: a cancel that fails refuses
 * the cell's result.
 * @param harness the PyProxy `lockdownReadonly` returned
 * @param source the wrapper script (`wrapUserScript(..., "host")`)
 * @param ns the namespace it runs in
 * @returns what the cell's tasks printed while being spent, the refusal to append to the cell's error ("" if none), and
 *   the script's own failure ("" if it ran), which the caller raises once it has the rest
 */
export async function hostRunScript(harness: any, source: string, ns: any): Promise<{ out: string; refusal: string; error: string }> {
    // What the last spend cut keeps that cell's contexts where `gc.get_objects()` finds them: released before this cell.
    // The gate holds a reference to each cut callable it revoked until a boundary finds it spent, so one follows the sweep.
    if (await spendSweep()) cellBoundary();
    let fn: any;
    try {
        fn = harness.run_script;
        const r = await fn(source, ns);
        try {
            const [out, refusal, error] = r.toJs();
            return { out: String(out ?? ""), refusal: String(refusal ?? ""), error: String(error ?? "") };
        } finally { r.destroy?.(); }
    } catch (e) {
        return { out: "", refusal: `RuntimeError: the cancel of what this cell scheduled failed (${String((e as Error)?.message || e).split("\n").filter(Boolean).pop()}), so the cell's result is refused.\n`, error: "" };
    } finally {
        fn?.destroy?.();
        // Start releasing what the spend cut, off the spend's path; the next cell waits for it (above).
        void spendSweep();
    }
}

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

// ── THE BENCH EDITOR'S COMPLETION ENGINE ─────────────────────────────────────────────────────────────────
// Jedi, loaded lazily (`PY_LAZY_LOADS`) the first time the bench asks. It never RUNS the script being typed:
// completion is static analysis, so the sandbox holding no state is no limit for anything reached through an
// import or written in the script — measured in Pyodide: module attributes (`np.ara`, `np.linalg.i`,
// `from numpy import lin`), pandas frames (`pd.read_csv(...).he` → `head`, via pandas' own stubs), literals,
// and the script's own functions and classes all complete. The prelude's own names (`np`, `pd`, `Image`,
// `to_base64`) complete with no import, because `completeIn` reads the prelude in front of the script.
//
// What it CANNOT infer is an array returned by a numpy call (`np.arange(24).reshape(4, 6)`, `np.zeros(3)`):
// Jedi 0.19 cannot resolve numpy 2's stub layout, so `grid.` offers nothing. That is exactly the case a
// persisted session fixes, and why `namespace` is the one parameter that changes when the bench keeps its
// state: `None` is Jedi's `Script`, a namespace is its `Interpreter`, which completes the LIVE object
// (`grid.su` → `sum`, verified). The same `complete(line, column)` either way, so the editor never changes.
// The namespace is for what the USER kept; the prelude's modules still come from the text in front, since a
// name found in the namespace is a live module and a live module has no stubs to type a call's result.
//
// `InterpreterEnvironment`: the default environment looks for a Python executable to introspect compiled
// modules in a SUBPROCESS, and there is no subprocess in Pyodide.
export const COMPLETE_HELPER = /* python */ `
def _ml_complete(code, line, column, namespace=None):
    import json, jedi, sys, warnings
    out = []
    # Jedi WARNS when a stub points at a module it cannot import (numpy 2's layout does, on every numpy
    # completion); on a path that runs per keystroke that is console spam, not information.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if namespace is None:
            script = jedi.Script(code, environment=jedi.InterpreterEnvironment())
        else:
            script = jedi.Interpreter(code, [namespace])
        for c in script.complete(line, column):
            kind = c.type
            # Jedi types a name it could not RESOLVE as a module — numpy 2's stubs re-export from modules it
            # cannot import, so np.arange, np.array, np.asarray (40 of numpy's first 200) all came back
            # "module". A module is believed only when it really is one that is loaded; otherwise the kind is
            # unknown, which the editor shows as no label rather than a wrong one.
            if kind == "module" and c.full_name not in sys.modules:
                kind = ""
            out.append({"name": c.name, "type": kind, "complete": c.complete})
            if len(out) >= 200:
                break
    return json.dumps(out)
`;

/** What every bench script runs after (`wrapUserCode(..., persist = true)`), so what completion reads in front of it. */
const COMPLETE_CONTEXT = PRELUDE_BASE.replace(/^\n/, "");
const COMPLETE_CONTEXT_LINES = COMPLETE_CONTEXT.split("\n").length - 1;   // ends in "\n", so the script starts on the next line

/** One completion Jedi offered: the whole `name`, its kind (`module`/`function`/`instance`/…), and the part
 *  still to type (`complete`). */
export interface PyCompletion { name: string; type: string; complete: string; }

/**
 * Ask Jedi what can go at a position in a script. Needs `COMPLETE_HELPER` installed (the worker does that
 * once, after loading the lazy wheels). Always HARDENED, whatever mode the bench is in: analysis can import a
 * compiled module to inspect it, and that import must not reach the network even when the user picked `full`.
 *
 * The script is analysed as if `PRELUDE_BASE` came before it, which is what a bench run does.
 *
 * @param line 1-based, in the script, as Jedi counts. @param column 0-based, in characters.
 * @param namespace a LIVE namespace (the bench's kept state, a Python dict) to complete real objects from;
 *   absent, Jedi analyses the script alone.
 * @returns at most 200 completions, best first as Jedi ranks them.
 */
export function completeIn(py: any, code: string, line: number, column: number, namespace?: any): PyCompletion[] {
    const saved = harden(py);
    try {
        // Handed over as globals rather than spliced into the source, so no script can break out of a quote.
        // The prelude goes IN FRONT, as text Jedi reads and never runs: bench code always runs after it, so
        // `np`/`pd`/`Image`/`to_base64` are in scope whether or not anything is kept. Without it, a bench with
        // nothing kept (before the first run, after a reset or a restart) completed none of them — static
        // analysis knew only what the script itself imported. It also beats the kept namespace's LIVE `pd`:
        // a live module has no stubs to type a call's result, so `pd.read_csv(...).he` completed nothing.
        py.globals.set("_ml_c_code", COMPLETE_CONTEXT + code);
        if (namespace) py.globals.set("_ml_c_ns", namespace);
        return JSON.parse(py.runPython(`_ml_complete(_ml_c_code, ${Math.max(1, line | 0) + COMPLETE_CONTEXT_LINES}, ${Math.max(0, column | 0)}${namespace ? ", _ml_c_ns" : ""})`) as string);
    } finally {
        for (const k of ["_ml_c_code", "_ml_c_ns"]) { try { py.globals.delete(k); } catch { /* absent */ } }
        unharden(py, saved);
    }
}

/**
 * A STORED table's bytes into Python: ONE copy, straight into a `bytearray` in Pyodide's memory, bound as `name` for the
 * prelude to decode (and drop). It is a buffer, never a JsProxy: a proxy is a handle into this realm, which the readonly
 * hardening exists to remove, while a `bytearray` carries no capability at all. Returns the entry with its buffer
 * replaced by that name, since an ArrayBuffer does not survive the JSON the prelude reads.
 */
export function injectStoredTable(py: any, ns: any, t: any, name: string, bound: string[]): unknown {
    const buffer = t?.data?.kind === "value" ? t.data.buffer : undefined;
    if (!(buffer instanceof ArrayBuffer)) return t;
    const bytes = py.runPython("bytearray")(buffer.byteLength);
    try {
        const view = bytes.getBuffer("u8");
        try { view.data.set(new Uint8Array(buffer)); } finally { view.release(); }
        ns.set(name, bytes);
    } finally { bytes.destroy(); }
    bound.push(name);
    const { buffer: _dropped, ...data } = t.data;
    return { ...t, data: { ...data, buf: name } };
}

/** The returned frame's IPC bytes (`_ipc_result`, set by the wrapper), as an ArrayBuffer of their own, or undefined. */
export function takeIpc(ns: any): ArrayBuffer | undefined {
    const b = ns.get("_ipc_result");
    if (!b || typeof b.toJs !== "function") return undefined;
    try {
        const u8 = b.toJs() as Uint8Array;
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
    } finally { b.destroy?.(); }
}
