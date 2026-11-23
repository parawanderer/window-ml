// replay.mjs — re-judge recorded python_exec cells through the restricted core's inside try, run by run, in order.
//
// usage: node --import tsx replay.mjs <out.json> <run.json>...   (dist/pyodide must be the fork core: `npm run build`
// with pyodide-core/ linked)
//
// Each run's cells replay IN ORDER in one namespace, as a worker-hosted run keeps them (python-worker.ts, ROOT C): the
// cell's tables injected first (`tables` resolved by `tableSpecs`, a source that is the task's /sales.csv rebuilt from
// examples/cross-page/sales.mjs as the worker's fetch cache holds it, `kind: "rows"`), then the cell inside the dialect
// (`wrapUserScript(..., { nodes })`, as python-dialect-inside.test.mjs drives it). A cell refused inside is then run on
// the full path, as an approved one would be, so a later cell sees what it left, unowned. On the full path only, a read
// of a /sales.csv URL is served the same bytes (the run's page server is gone); an inside cell never sees that shim.
//
// With `--owned-plain`, the counterfactual: before each cell, every mutable plain-data value in the namespace (a
// DataFrame, Series, list or dict: `x = x.copy()`; an ndarray: `numpy.array(x, copy=True)`, whose `.copy()` the fork
// does not count as made) is rebuilt INSIDE an inside cell under its own name, so it is owned, as if mutation of
// full-made and injected plain data were permitted. `copy` is not an admitted module, so `copy.deepcopy` cannot do it.
// The rebuild is SHALLOW: a list inside a list stays unowned, and so do the DataFrames in the injected `tables` dict
// (`df` itself is rebuilt). A set is left alone (its mutators are refused as unlisted
// attributes whoever made it), and str, numbers and tuples cannot be written. `result` is not carried: every cell's
// wrapper binds it to None before the cell runs. Each rebuild is checked once at start on
// a value a full-path cell made, every rebuild a cell needs is counted on its row (`rebuilt`), and a rebuild the dialect
// refuses, or one that raises, stops the replay: a counterfactual that rebuilt nothing would agree with the plain
// replay by construction.
//
// With `--read-csv-served`, the other counterfactual: ML_TABLE.md's served `pd.read_csv` (ruling 71). A recorded cell
// is refused at its first `read_csv`, which hides every line after it; this mode serves the calls that rule serves and
// judges the rest of the cell. Each `<x>.read_csv(src, ...)` call (found with `ast`, so a parenthesis inside a string is
// not miscounted) is classed by its source: a URL the run fetched with `fetch_url` before the cell, resolved against the
// page as the fetch cache keys it (`fetched URL`, or `fetched URL, by page path` when the cell or the fetch named it as a
// path); an `io.StringIO`/`BytesIO` call (`owned buffer`); a URL not fetched; or anything else. The replay holds one
// table's bytes, the task's /sales.csv, so only a fetched URL that resolves to that file on the page's origin is served
// (each URL call records its resolved `path` and `taskTable`); a fetched URL naming any other file, and an owned
// buffer, whose bytes the replay cannot know, are left as written and still ask. A served call is replaced by `pd.DataFrame(replay_csv_<k>)`, a frame the cell builds itself from columns parsed OUTSIDE by real pandas
// from the task's /sales.csv bytes with the call's literal keywords (a builtin type name such as `dtype=str` included) from ruling 71's allowed list (a frame read with
// `index_col` has its index reset to columns, and a keyword that is not a literal, or not on the list, is dropped and
// counted; a call whose keywords make pandas raise is left as written and marked `served: "raised"` with the error's
// type, since a served call would raise it in the cell). An unserved call is left as written, and still asks. A refused cell's full-path rerun runs the cell as
// recorded. Each row carries its calls' classes (`csv`), and only those.
//
// Writes features only, never cell text (the repo is public): per cell the run's hash, model, sweep, the cell's index,
// whether it finished inside, the fork's refusal text, and whether its full-path run raised (the exception's type only).
//
// For the bench's rewrite test (tests/e2e/bench/corpus-replay.mjs), six options, each off by default, and with all of
// them off the rows are what they were:
// - `--all-cells` replays every python_exec cell of the run, not only the ones that asked, and indexes `cell` over all
//   of them as the run took them (corpus-extract.mjs's index). A call refused before any of its code ran (the tool's own
//   `Error: ml.pythonExec` reply) keeps its index and is not run.
// - `--files <manifest.json>` gives each run its attached files: `{ "<run hash>": [{ "name", "id", "path" }] }`, each
//   written to /files/attached/<id>/<name> from the local `path` before the run's first cell, with /files/agent empty as
//   the working directory. It is a COPY in Pyodide's in-memory file system, not the worker's ranged mount (#2026), as
//   the /sales.csv shim is a copy of the fetch cache: the inside and full paths read the same bytes. It is read-only, as
//   the mount is: a write raises there and here, though the error's type differs.
// - `--capture <out.jsonl>` writes, per replayed cell, what it left: its stdout, its result, its error's type, and
//   hashes of the values of the names any LATER cell of the run reads and of the names it binds (floats to 9 significant
//   digits). It is derived from what cells print, so it goes only to the path the caller names, never to `<out.json>`.
// - `--replace <run hash>:<cell>=<file>` (repeatable, with `--all-cells`, whose index <cell> is) replays that run once
//   more with cell <cell>'s source read from <file>, so the source never goes on a command line; the variant's rows
//   carry `variant: "<run hash>:<cell>"`.
// - `--count-steps` adds, per cell, `steps` (`_restricted.steps()`, the fork's own count, after a cell that finished
//   inside) and `loops`/`calls`/`depth` for a cell run on the full path: a `sys.monitoring` counter of LINE events on
//   the cell's `while` headers (one per test of the condition) and of starts of the cell's functions that call
//   themselves. It only counts: a callback that raises escapes the frame's try/finally on this core, so none stops a cell.
// - `--admit <Node>` (repeatable) adds an AST node type to the inside whitelist, a counterfactual: `--admit While`
//   judges a cell as if `while` were admitted. Only membership changes: the loop then runs under today's step budget,
//   one step per C leaf call (ruling 105's charge is not built), so each inside cell is capped (`--cap-ms`, 30 s by
//   default with --admit) and one that hits it is `capped`, neither inside nor refused. The list goes in `meta`, so an
//   extract made with it is never read as the as-recorded one; a name that is no ast node, or is admitted already, is refused.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { wrapUserSetup, wrapUserScript, injectInputs } from "../../../src/python/python-runtime.ts";
import { dialectSetup } from "../../../src/python/python-dialect-run.js";
import { tableSpecs } from "../../../src/ml/ml-python.ts";
import { tableFromDelimited } from "../../../src/table/table-data.ts";
import { salesCsv } from "../../../examples/cross-page/sales.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PYODIDE_DIR = path.join(ROOT, "dist/pyodide");
const DATA_DIR = path.join(ROOT, "notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;

const args = process.argv.slice(2);
/** Remove every `<name> <value>` pair from `args` and return the values. */
const take = (name) => { const vals = []; for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) vals.push(args.splice(i, 2)[1]); return vals; };
const filesManifest = take("--files")[0] ?? null;
const captureFile = take("--capture")[0] ?? null;
const replaces = take("--replace").map((r) => { const m = /^([0-9a-f]+):(\d+)=(.+)$/.exec(r); if (!m) { console.error(`--replace ${r}: want <run hash>:<cell>=<file>`); process.exit(2); } return { run: m[1], cell: Number(m[2]), code: fs.readFileSync(m[3], "utf8") }; });
const admit = take("--admit");
// a replaced cell is named by its index over ALL the run's cells, which only --all-cells gives: without it the variant
// would replay unchanged under a `variant` tag
if (replaces.length && !args.includes("--all-cells")) { console.error("--replace needs --all-cells: <cell> is the cell's index over every python_exec cell of the run"); process.exit(2); }
const capMs = Number(take("--cap-ms")[0] ?? (admit.length ? 30000 : 0));
const allCells = args.includes("--all-cells");
const countSteps = args.includes("--count-steps");
const INSIDE_NODES = admit.length ? [...NODES, ...admit] : NODES;
for (const n of admit) {
    // a typo must not equal the default run: only an ast node class the whitelist does not already admit
    if (!/^[A-Z][A-Za-z]*$/.test(n)) { console.error(`--admit ${n}: not an ast node class name`); process.exit(2); }
    if (NODES.includes(n) || admit.indexOf(n) !== admit.lastIndexOf(n)) { console.error(`--admit ${n}: already admitted`); process.exit(2); }
}
const ownedPlain = args.includes("--owned-plain");
const csvServed = args.includes("--read-csv-served");
if (ownedPlain && csvServed) { console.error("--owned-plain and --read-csv-served are separate counterfactuals"); process.exit(2); }
const [out, ...runs] = args.filter((a) => !a.startsWith("--"));
if (!out || !runs.length) { console.error("usage: node --import tsx replay.mjs [--owned-plain|--read-csv-served] [--all-cells] [--files <manifest.json>] [--capture <out.jsonl>] [--replace <run>:<cell>=<file>]... [--count-steps] [--admit <Node>]... <out.json> <run.json>..."); process.exit(2); }

const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
const py = await loadPyodide({ indexURL: PYODIDE_DIR });
if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) throw new Error("dist/pyodide is the stock core, not the restricted-mode fork");
await py.loadPackage(["numpy", "pandas", "pillow"]);
const ready = String(await py.runPythonAsync(dialectSetup(FILES)));
for (const n of admit) if (!py.runPython(`import ast; isinstance(getattr(ast, ${JSON.stringify(n)}, None), type) and issubclass(ast.${n}, ast.AST)`)) { console.error(`--admit ${n}: not an ast node class`); process.exit(2); }
// --cap-ms: a timer thread sets Pyodide's interrupt buffer once an inside cell has run that long. It fires at the next
// eval-breaker check, so it cannot cut a C leaf mid-call: a cell past the cap by more than a leaf's time counts as capped too.
const LEAF_MS = 1000;
const cap = capMs ? (() => {
    // byte 0 is Pyodide's interrupt flag, which it clears when it takes the interrupt; byte 1 says the timer fired
    const sab = new SharedArrayBuffer(8), flag = new Int8Array(sab, 0, 1), fired = new Int8Array(sab, 1, 1), gen = new Int32Array(sab, 4, 1);
    py.setInterruptBuffer(flag);
    // the interrupt can land in the event loop's own callback rather than the cell, where it rejects nothing the wrapper
    // awaits: that rejection is the cap firing, nothing else
    process.on("unhandledRejection", (e) => { if (/KeyboardInterrupt/.test(String(e?.message ?? e))) return; throw e; });
    const timer = new Worker(`const { workerData: { sab, ms } } = require("node:worker_threads");
const flag = new Int8Array(sab, 0, 1), fired = new Int8Array(sab, 1, 1), gen = new Int32Array(sab, 4, 1);
for (;;) {
    const g = Atomics.load(gen, 0);
    if (g < 0) break;
    if (g % 2 === 1 && Atomics.wait(gen, 0, g, ms) === "timed-out") { Atomics.store(fired, 0, 1); Atomics.store(flag, 0, 2); while (Atomics.load(gen, 0) === g) Atomics.wait(gen, 0, g); }
    else if (g % 2 === 0) Atomics.wait(gen, 0, g);
}`, { eval: true, workerData: { sab, ms: capMs } });
    timer.unref();
    const bump = () => { Atomics.add(gen, 0, 1); Atomics.notify(gen, 0); };
    return { arm: () => { Atomics.store(flag, 0, 0); Atomics.store(fired, 0, 0); bump(); }, disarm: () => { bump(); const hit = Atomics.load(fired, 0) !== 0; Atomics.store(flag, 0, 0); Atomics.store(fired, 0, 0); return hit; }, stop: () => { Atomics.store(gen, 0, -1); Atomics.notify(gen, 0); } };
})() : null;
if (ready) throw new Error(`the core is not ready for inside runs: ${ready}`);

const SALES = salesCsv();
const SALES_TABLE = tableFromDelimited(SALES, { delimiter: "," });
py.globals.set("_REPLAY_SALES_CSV", SALES);
py.runPython(`
import io as _io
def _replay_shim_on(ns):
    import pandas as _pd
    _real = _pd.read_csv
    def _read_csv(src, *a, **k):
        if isinstance(src, str) and src.rstrip("/").endswith("sales.csv"): src = _io.StringIO(_REPLAY_SALES_CSV)
        return _real(src, *a, **k)
    _pd.read_csv = _read_csv
    return _real
def _replay_shim_off(real):
    import pandas as _pd
    _pd.read_csv = real
_REPLAY_PLAIN = None
def _replay_plain_names(ns):
    import numpy as _np, pandas as _pd
    kinds = (_pd.DataFrame, _pd.Series, _np.ndarray, list, dict)
    return [[k, "ndarray" if isinstance(v, _np.ndarray) else "copy"] for k, v in list(ns.items())
            if not k.startswith("_") and k not in ("pd", "np", "io", "base64", "sys", "contextlib", "tables", "result") and isinstance(v, kinds)]

_REPLAY_CSV_KW = {"sep", "delimiter", "header", "names", "index_col", "usecols", "dtype", "parse_dates", "nrows",
                  "skiprows", "na_values", "keep_default_na", "thousands", "decimal"}
_REPLAY_KW_TYPES = {"str": str, "int": int, "float": float, "object": object, "bool": bool}
def _replay_kw_value(node):
    """A keyword's value when it is a literal, which may name a builtin type (dtype=str); anything else raises."""
    import ast
    ok = (ast.Constant, ast.Dict, ast.List, ast.Tuple, ast.Set, ast.Load, ast.UnaryOp, ast.USub)
    for n in ast.walk(node):
        if not (isinstance(n, ok) or isinstance(n, ast.Name) and n.id in _REPLAY_KW_TYPES): raise ValueError("not a literal")
    return eval(compile(ast.Expression(node), "<kw>", "eval"), {"__builtins__": {}}, dict(_REPLAY_KW_TYPES))
def _replay_serve(ns, code, page, fetched):
    import ast, json, pandas as _pd
    from urllib.parse import urljoin, urlsplit
    origin = urlsplit(page)[:2]
    for k in [k for k in ns.keys() if k.startswith("replay_csv_")]: del ns[k]
    try: tree = ast.parse(code)
    except SyntaxError: return json.dumps({"code": code, "csv": []})
    keyed = {urljoin(page, u): u.startswith("/") for u in fetched}
    lits = {n.targets[0].id: n.value.value for n in ast.walk(tree) if isinstance(n, ast.Assign) and len(n.targets) == 1
            and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)}
    calls = sorted((n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "read_csv"),
                   key=lambda n: (n.lineno, n.col_offset))
    raw, starts = code.encode(), [0]
    for line in raw.splitlines(keepends=True): starts.append(starts[-1] + len(line))
    at = lambda line, col: starts[line - 1] + col
    csv, edits = [], []
    for n in calls:
        src = n.args[0] if n.args else next((k.value for k in n.keywords if k.arg == "filepath_or_buffer"), None)
        lit = src.value if isinstance(src, ast.Constant) and isinstance(src.value, str) else lits.get(src.id) if isinstance(src, ast.Name) else None
        fn = src.func if isinstance(src, ast.Call) else None
        path = task = None
        if lit is not None:
            u = urljoin(page, lit.strip())
            form = ("fetched URL, by page path" if keyed[u] or lit.strip().startswith("/") else "fetched URL") if u in keyed else "URL not fetched"
            path, task = urlsplit(u).path, urlsplit(u)[:2] == origin and urlsplit(u).path.rstrip("/") == "/sales.csv"
        elif fn is not None and (getattr(fn, "attr", None) or getattr(fn, "id", None)) in ("StringIO", "BytesIO"): form = "owned buffer"
        else: form = "other"
        row = {"form": form, "served": form.startswith("fetched") and task}
        if path is not None: row["path"], row["taskTable"] = path, task
        if row["served"] and not any(e[0] < at(n.end_lineno, n.end_col_offset) and at(n.lineno, n.col_offset) < e[1] for e in edits):
            kw, dropped = {}, 0
            for k in n.keywords:
                if k.arg == "filepath_or_buffer": continue
                try:
                    if k.arg not in _REPLAY_CSV_KW: raise ValueError
                    kw[k.arg] = _replay_kw_value(k.value)
                except Exception: dropped += 1
            try: frame = _pd.read_csv(_io.StringIO(_REPLAY_SALES_CSV), **kw)
            except Exception as e:
                row["served"], row["parseError"] = "raised", type(e).__name__
                csv.append(row)
                continue
            if "index_col" in kw: frame = frame.reset_index()
            name = f"replay_csv_{len(edits)}"
            ns[name] = frame.to_dict("list")
            edits.append((at(n.lineno, n.col_offset), at(n.end_lineno, n.end_col_offset), f"pd.DataFrame({name})".encode()))
            if dropped: row["kwDropped"] = dropped
            if "index_col" in kw: row["indexReset"] = True
        elif row["served"]: row["served"] = "nested"
        csv.append(row)
    for a, b, text in sorted(edits, reverse=True): raw = raw[:a] + text + raw[b:]
    return json.dumps({"code": raw.decode(), "csv": csv})
`);

if (captureFile || countSteps) py.runPython(`
import ast as _rp_ast, hashlib as _rp_hl, json as _rp_json, re as _rp_re, sys as _rp_sys
def _replay_names(code):
    """The names a cell reads (any Name loaded) and the names it binds at its top level."""
    try: t = _rp_ast.parse(code)
    except SyntaxError: return _rp_json.dumps([[], []])
    loads = sorted({n.id for n in _rp_ast.walk(t) if isinstance(n, _rp_ast.Name) and isinstance(n.ctx, _rp_ast.Load)})
    binds = set()
    def visit(n):
        if isinstance(n, _rp_ast.Name) and isinstance(n.ctx, _rp_ast.Store): binds.add(n.id)
        elif isinstance(n, (_rp_ast.FunctionDef, _rp_ast.AsyncFunctionDef, _rp_ast.ClassDef)): binds.add(n.name); return
        elif isinstance(n, _rp_ast.Lambda): return
        elif isinstance(n, (_rp_ast.Import, _rp_ast.ImportFrom)): binds.update(a.asname or a.name.split(".")[0] for a in n.names)
        for c in _rp_ast.iter_child_nodes(n): visit(c)
    for n in t.body: visit(n)
    return _rp_json.dumps([loads, sorted(binds)])
def _replay_h(v, depth=0):
    import numpy as _np, pandas as _pd
    if depth > 4: return "deep"
    if isinstance(v, (_pd.DataFrame, _pd.Series)): return type(v).__name__ + ":" + v.to_csv(float_format="%.9g")
    if isinstance(v, _np.ndarray): return "nd:" + str(v.dtype) + str(v.shape) + (_np.array2string(v, precision=9, threshold=10**9) if v.dtype.kind in "fc" else repr(v.tolist()))
    if isinstance(v, (float, _np.floating)): return format(float(v), ".9g")
    if isinstance(v, dict): return "{" + ",".join(_replay_h(k, depth + 1) + ":" + _replay_h(x, depth + 1) for k, x in v.items()) + "}"
    if isinstance(v, (list, tuple)): return type(v).__name__ + "[" + ",".join(_replay_h(x, depth + 1) for x in v) + "]"
    if callable(v) or isinstance(v, type(_rp_sys)): return "obj:" + type(v).__name__
    return _rp_re.sub(r"0x[0-9a-f]+", "0x", repr(v))
def _replay_values(ns, names):
    out = {}
    for k in names:
        if k in ns:
            try: out[k] = _rp_hl.sha256(_replay_h(ns[k]).encode()).hexdigest()[:16]
            except BaseException as e: out[k] = "unhashable:" + type(e).__name__
    return _rp_json.dumps(out)
_replay_c = None
def _replay_count_on(code):
    """Count, on the full path, tests of the cell's while headers and starts of its self-calling functions. Count only:
    a callback that raises escapes the frame's try/finally on this core."""
    global _replay_c
    try: t = _rp_ast.parse(code)
    except SyntaxError: return False
    lines = {n.lineno for n in _rp_ast.walk(t) if isinstance(n, _rp_ast.While)}
    funcs = {f.name for f in _rp_ast.walk(t) if isinstance(f, (_rp_ast.FunctionDef, _rp_ast.AsyncFunctionDef))
             and any(isinstance(c, _rp_ast.Call) and isinstance(c.func, _rp_ast.Name) and c.func.id == f.name for c in _rp_ast.walk(f))}
    if not lines and not funcs: return False
    M = _rp_sys.monitoring
    tool = next(i for i in (3, 4) if M.get_tool(i) is None)
    c = {"loops": 0, "calls": 0, "depth": 0, "max": 0, "tool": tool}
    def line(code, ln):
        try:
            if ln in lines and code.co_filename == "<python_exec>": c["loops"] += 1
        except BaseException: pass
    def start(code, off):
        try:
            if code.co_name in funcs and code.co_filename == "<python_exec>":
                c["calls"] += 1; c["depth"] += 1; c["max"] = max(c["max"], c["depth"])
        except BaseException: pass
    def leave(code, off, val):
        try:
            if code.co_name in funcs and code.co_filename == "<python_exec>": c["depth"] -= 1
        except BaseException: pass
    M.use_tool_id(tool, "replay-count")
    E = M.events
    M.register_callback(tool, E.LINE, line); M.register_callback(tool, E.PY_START, start)
    M.register_callback(tool, E.PY_RETURN, leave); M.register_callback(tool, E.PY_UNWIND, leave)
    M.set_events(tool, E.LINE | E.PY_START | E.PY_RETURN | E.PY_UNWIND)
    _replay_c = c
    return True
def _replay_count_off():
    M = _rp_sys.monitoring
    c = _replay_c
    M.set_events(c["tool"], 0)
    for e in (M.events.LINE, M.events.PY_START, M.events.PY_RETURN, M.events.PY_UNWIND): M.register_callback(c["tool"], e, None)
    M.free_tool_id(c["tool"])
    return _rp_json.dumps({"loops": c["loops"], "calls": c["calls"], "depth": c["max"]})
`);

/** Does `src` name the task's table: its /sales.csv URL or a `@tool:` token (the fetch's pointer to it)? */
const isSales = (src) => typeof src === "string" && (/sales\.csv\/?$/.test(src.trim()) || /^\s*@tool:/.test(src));

/** The cell's tables as the worker injects them, or a reason they cannot be rebuilt. */
function injected(tables) {
    if (tables == null || tables === "") return { json: null };
    let specs;
    try { specs = tableSpecs(tables); } catch (e) { return { json: null, tableError: "shape" }; }
    if (!specs.every((s) => isSales(s.src))) return { json: null, tableError: "source" };
    return { json: JSON.stringify(specs.map((s) => ({ name: s.name, data: { kind: "rows", columns: SALES_TABLE.columns, rows: SALES_TABLE.rows }, alias: s.alias ?? (typeof s.src === "string" ? s.src : null) }))) };
}

/** A cell's setup in `ns`: its tables injected (`df`/`tables` reset to them, as every python_exec does). */
async function setup(ns, tablesJson) {
    injectInputs(ns, null, tablesJson);
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
}

/** Run one cell in `ns`: setup, then the script inside (with `nodes`) or on the full path. */
async function run(ns, code, tablesJson, inside) {
    await setup(ns, tablesJson);
    return script(ns, code, tablesJson, inside);
}

/** A cell's script alone, in a namespace its setup already ran in. With `--count-steps`, the cell's own counts too:
 *  `steps` inside, `count` (loops, calls, depth) on the full path. */
async function script(ns, code, tablesJson, inside) {
    injectInputs(ns, null, tablesJson);
    const real = inside ? null : py.globals.get("_replay_shim_on")(ns);
    const counting = countSteps && !inside && py.globals.get("_replay_count_on")(code);
    let count = null, capped = false;
    const t0 = Date.now();
    // both paths: a cell admitted inside may be refused for something else and then loop on the full path, which has no budget
    if (cap) cap.arm();
    try { await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: INSIDE_NODES } : null), { globals: ns }); }
    finally {
        if (cap) capped = cap.disarm() || Date.now() - t0 > capMs + LEAF_MS;
        if (real) py.globals.get("_replay_shim_off")(real);
        if (counting) count = JSON.parse(py.globals.get("_replay_count_off")());
    }
    if (capped) { ns.set("_ml_not_in_dialect", undefined); return inside ? { capped: true } : { capped: true, error: "KeyboardInterrupt: --cap-ms" }; }
    const refused = inside ? ns.get("_ml_not_in_dialect") : undefined;
    if (refused) { ns.set("_ml_not_in_dialect", undefined); return { refused: String(refused) }; }
    const err = ns.get("_err");
    const out = err ? { error: String(err) } : {};
    if (countSteps && inside) out.steps = py.runPython("import _restricted; _restricted.steps()");
    if (count) out.count = count;
    return out;
}

/** What a cell left, for `--capture`: its stdout, result and error type, and hashes of the values `later` and `binds` name. */
function captured(ns, r, later, binds) {
    const values = (names) => JSON.parse(py.globals.get("_replay_values")(ns, py.toPy(names)));
    return { stdout: String(ns.get("_stdout") ?? ""), result: ns.get("_json_result") ?? null, error: r.error ? errType(r.error) : null, later: values(later), binds: values(binds) };
}

/** Write a run's attached files (`--files`) to /files/attached/<id>/<name>, and empty /files/agent, its working directory. */
function mountFiles(list) {
    const FS = py.FS;
    const rm = (p) => { if (FS.isDir(FS.stat(p).mode)) { for (const n of FS.readdir(p)) if (n !== "." && n !== "..") rm(`${p}/${n}`); FS.rmdir(p); } else FS.unlink(p); };
    // the last run's copy was left read-only: open it again before clearing it
    const unlock = (p) => { const st = FS.stat(p); FS.chmod(p, FS.isDir(st.mode) ? 0o755 : 0o644); if (FS.isDir(st.mode)) for (const n of FS.readdir(p)) if (n !== "." && n !== "..") unlock(`${p}/${n}`); };
    try { unlock("/files"); } catch { /* no /files yet */ }
    // in the worker's order, so a listing of / or /files reads as it did live (/share is Pyodide's own in the browser)
    for (const d of ["/files", "/files/agent", "/files/attached", "/share"]) { try { FS.mkdir(d); } catch { /* exists */ } }
    for (const d of ["/files/attached", "/files/agent"]) for (const n of FS.readdir(d)) if (n !== "." && n !== "..") rm(`${d}/${n}`);
    for (const { name, id, path: from } of list) { FS.mkdir(`/files/attached/${id}`); FS.writeFile(`/files/attached/${id}/${name}`, fs.readFileSync(from)); }
    // read-only, as the worker's mount answers every write (EROFS there; a PermissionError here, the same "raised")
    const lock = (p) => { const st = FS.stat(p); if (FS.isDir(st.mode)) for (const n of FS.readdir(p)) if (n !== "." && n !== "..") lock(`${p}/${n}`); FS.chmod(p, FS.isDir(st.mode) ? 0o555 : 0o444); };
    lock("/files");
    FS.chdir("/files/agent");
}

/** The exception type an error's text ends on (`NameError`, `KeyError`), never its message, which can quote the cell. */
const errType = (e) => (/(\b[A-Z][A-Za-z]*(?:Error|Exception))\b/.exec(String(e).split("\n").reverse().find((l) => /Error|Exception/.test(l)) ?? "") ?? [])[1] ?? "error";

/** The inside cell that rebuilds `n` as a value it made (see the header for why these two forms). */
const rebuild = (n, kind) => kind === "ndarray" ? `import numpy as own_np\n${n} = own_np.array(${n}, copy=True)\ndel own_np` : `${n} = ${n}.copy()`;

/** Rebuild every mutable plain value the namespace holds inside an inside cell, so it is owned (the counterfactual).
 *  Runs after the next cell's setup, so its injected `df` and `tables` are among them. Returns how many it rebuilt; a
 *  rebuild refused or raising throws. */
async function ownPlain(ns, tablesJson) {
    const names = py.globals.get("_replay_plain_names")(ns).toJs();
    for (const [n, kind] of names) {
        const r = await script(ns, rebuild(n, kind), tablesJson, true);
        if (r.refused || r.error) throw new Error(`--owned-plain: rebuilding a ${kind === "ndarray" ? "ndarray" : "value"} inside failed: ${r.refused ?? errType(r.error)}`);
    }
    return names.length;
}

/** Each rebuild, checked on a value a full-path cell made: refused before it, admitted after. */
async function checkRebuilds() {
    const ns = py.globals.get("dict")();
    await run(ns, "import pandas as pd, numpy as np\nf = pd.DataFrame({'a': [1]}); s = f['a']; a = np.array([1]); l = [1]; d = {'k': 1}", null, false);
    for (const [n, write] of [["f", "f['b'] = 1"], ["s", "s[0] = 2"], ["a", "a[0] = 2"], ["l", "l[0] = 2"], ["d", "d['k'] = 2"]]) {
        if (!(await run(ns, write, null, true)).refused) throw new Error(`--owned-plain check: writing ${n} was not refused before the rebuild`);
    }
    if ((await ownPlain(ns, null)) !== 5) throw new Error("--owned-plain check: not every kind was rebuilt");
    for (const [n, write] of [["f", "f['b'] = 1"], ["s", "s[0] = 2"], ["a", "a[0] = 2"], ["l", "l[0] = 2"], ["d", "d['k'] = 2"]]) {
        const r = await run(ns, write, null, true);
        if (r.refused) throw new Error(`--owned-plain check: writing ${n} is still refused after the rebuild: ${r.refused}`);
    }
}
if (ownedPlain) await checkRebuilds();

const rows = [];
const captures = [];
const manifest = filesManifest ? JSON.parse(fs.readFileSync(filesManifest, "utf8")) : null;
/** A call refused before any of its code ran: the tool's own error, though the step is recorded `sandbox`. */
const ranOf = (st) => !/^Error: (ml\.)?pythonExec\b/.test(String(st.result ?? ""));

/** Replay one run's cells in a fresh namespace; `replace` swaps one cell's source (`--replace`) and tags the rows. */
async function replayRun(s, sweep, replace = null) {
    const ns = py.globals.get("dict")();
    if (manifest) mountFiles(manifest[s.hash] ?? []);
    let i = 0;
    const fetched = [];
    const picked = [];
    let k = 0;
    for (const st of s.steps ?? []) {
        if (st.tool !== "python_exec") continue;
        if (allCells) { const at = k++; if (String(st.arguments?.code ?? "") && ranOf(st)) picked.push({ st, at }); }
        else if (st.approval === "user" && String(st.arguments?.code ?? "")) picked.push({ st, at: null });
    }
    const codeAt = (p) => (replace && p.at === replace.cell ? replace.code : String(p.st.arguments.code));
    const names = captureFile ? picked.map((p) => JSON.parse(py.globals.get("_replay_names")(codeAt(p)))) : null;
    let n = 0;
    for (const st of s.steps ?? []) {
        if (st.tool === "fetch_url" && st.arguments?.url) fetched.push(String(st.arguments.url));
        const p = picked[n];
        if (!p || p.st !== st) continue;
        const recorded = codeAt(p);
        const served = csvServed ? JSON.parse(py.globals.get("_replay_serve")(ns, recorded, s.page?.url ?? "", py.toPy(fetched))) : null;
        const code = served ? served.code : recorded;
        const { json, tableError } = injected(st.arguments?.tables);
        let rebuilt;
        if (ownedPlain) { await setup(ns, json); rebuilt = await ownPlain(ns, json); }
        const t0 = Date.now();
        const inside = ownedPlain ? await script(ns, code, json, true) : await run(ns, code, json, true);
        const row = { run: s.hash, model: s.model, sweep, cell: allCells ? p.at : i++, inside: !inside.refused && !inside.capped, refused: inside.refused ?? null, ms: Date.now() - t0 };
        // past --cap-ms: neither inside nor refused, and not rerun on the full path (it may not end there either)
        if (inside.capped) row.capped = true;
        if (replace) row.variant = `${replace.run}:${replace.cell}`;
        if (ownedPlain) row.rebuilt = rebuilt;
        if (served?.csv.length) row.csv = served.csv;
        if (tableError) row.tableError = tableError;
        if (inside.error) row.insideError = errType(inside.error);
        if (countSteps && inside.steps != null) row.steps = inside.steps;
        let last = inside;
        if (inside.refused) {
            const full = await run(ns, recorded, json, false);
            if (full.error) row.fullError = errType(full.error);
            if (full.capped) row.fullCapped = true;
            if (full.count) Object.assign(row, full.count);
            last = full;
        }
        if (captureFile) {
            const later = [...new Set(names.slice(n + 1).flatMap(([loads]) => loads))];
            captures.push({ run: s.hash, cell: row.cell, ...(replace ? { variant: row.variant } : {}), inside: row.inside, ...captured(ns, last, later, names[n][1]) });
        }
        rows.push(row);
        n++;
    }
    return n;
}

for (const file of runs) {
    const s = JSON.parse(fs.readFileSync(file, "utf8")).session;
    const sweep = file.split("/artifacts/")[1]?.split("/").slice(0, 3).join("/") ?? "";
    const i = await replayRun(s, sweep);
    process.stderr.write(`${s.hash.slice(0, 8)} ${s.model} ${i} cells\n`);
    for (const r of replaces.filter((x) => x.run === s.hash)) await replayRun(s, sweep, r);
}
const rebuilt = rows.reduce((n, r) => n + (r.rebuilt ?? 0), 0);
if (ownedPlain && !rebuilt) throw new Error("--owned-plain rebuilt no value in any run: the counterfactual would equal the plain replay by construction");
if (captureFile) fs.writeFileSync(captureFile, captures.map((c) => JSON.stringify(c)).join("\n") + (captures.length ? "\n" : ""));
cap?.stop();
fs.writeFileSync(out, JSON.stringify({ meta: { ownedPlain, csvServed, rebuilt, ...(admit.length ? { admitted: admit, capMs } : {}), runs: runs.length, core: fs.readFileSync(path.join(ROOT, "pyodide-core/.pin"), "utf8").trim(), at: new Date().toISOString() }, rows }, null, 1) + "\n");
