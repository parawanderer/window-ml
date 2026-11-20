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
// path); an `io.StringIO`/`BytesIO` call (`owned buffer`); a URL not fetched; or anything else. A served call is
// replaced by `pd.DataFrame(replay_csv_<k>)`, a frame the cell builds itself from columns parsed OUTSIDE by real pandas
// from the task's /sales.csv bytes with the call's literal keywords (a builtin type name such as `dtype=str` included) from ruling 71's allowed list (a frame read with
// `index_col` has its index reset to columns, and a keyword that is not a literal, or not on the list, is dropped and
// counted; a call whose keywords make pandas raise is left as written and marked `served: "raised"` with the error's
// type, since a served call would raise it in the cell). An unserved call is left as written, and still asks. A refused cell's full-path rerun runs the cell as
// recorded. Each row carries its calls' classes (`csv`), and only those.
//
// Writes features only, never cell text (the repo is public): per cell the run's hash, model, sweep, the cell's index,
// whether it finished inside, the fork's refusal text, and whether its full-path run raised (the exception's type only).
import fs from "node:fs";
import path from "node:path";
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
const ownedPlain = args.includes("--owned-plain");
const csvServed = args.includes("--read-csv-served");
if (ownedPlain && csvServed) { console.error("--owned-plain and --read-csv-served are separate counterfactuals"); process.exit(2); }
const [out, ...runs] = args.filter((a) => !a.startsWith("--"));
if (!out || !runs.length) { console.error("usage: node --import tsx replay.mjs [--owned-plain|--read-csv-served] <out.json> <run.json>..."); process.exit(2); }

const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
const py = await loadPyodide({ indexURL: PYODIDE_DIR });
if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) throw new Error("dist/pyodide is the stock core, not the restricted-mode fork");
await py.loadPackage(["numpy", "pandas", "pillow"]);
const ready = String(await py.runPythonAsync(dialectSetup(FILES)));
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
    from urllib.parse import urljoin
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
        if lit is not None:
            u = urljoin(page, lit.strip())
            form = ("fetched URL, by page path" if keyed[u] or lit.strip().startswith("/") else "fetched URL") if u in keyed else "URL not fetched"
        elif fn is not None and (getattr(fn, "attr", None) or getattr(fn, "id", None)) in ("StringIO", "BytesIO"): form = "owned buffer"
        else: form = "other"
        row = {"form": form, "served": form.startswith("fetched") or form == "owned buffer"}
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

/** A cell's script alone, in a namespace its setup already ran in. */
async function script(ns, code, tablesJson, inside) {
    injectInputs(ns, null, tablesJson);
    const real = inside ? null : py.globals.get("_replay_shim_on")(ns);
    try { await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: NODES } : null), { globals: ns }); }
    finally { if (real) py.globals.get("_replay_shim_off")(real); }
    const refused = inside ? ns.get("_ml_not_in_dialect") : undefined;
    if (refused) { ns.set("_ml_not_in_dialect", undefined); return { refused: String(refused) }; }
    const err = ns.get("_err");
    return err ? { error: String(err) } : {};
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
for (const file of runs) {
    const s = JSON.parse(fs.readFileSync(file, "utf8")).session;
    const ns = py.globals.get("dict")();
    const sweep = file.split("/artifacts/")[1]?.split("/").slice(0, 3).join("/") ?? "";
    let i = 0;
    const fetched = [];
    for (const st of s.steps ?? []) {
        if (st.tool === "fetch_url" && st.arguments?.url) fetched.push(String(st.arguments.url));
        if (st.tool !== "python_exec" || st.approval !== "user") continue;
        const recorded = String(st.arguments?.code ?? "");
        if (!recorded) continue;
        const served = csvServed ? JSON.parse(py.globals.get("_replay_serve")(ns, recorded, s.page?.url ?? "", py.toPy(fetched))) : null;
        const code = served ? served.code : recorded;
        const { json, tableError } = injected(st.arguments?.tables);
        let rebuilt;
        if (ownedPlain) { await setup(ns, json); rebuilt = await ownPlain(ns, json); }
        const t0 = Date.now();
        const inside = ownedPlain ? await script(ns, code, json, true) : await run(ns, code, json, true);
        const row = { run: s.hash, model: s.model, sweep, cell: i++, inside: !inside.refused, refused: inside.refused ?? null, ms: Date.now() - t0 };
        if (ownedPlain) row.rebuilt = rebuilt;
        if (served?.csv.length) row.csv = served.csv;
        if (tableError) row.tableError = tableError;
        if (inside.error) row.insideError = errType(inside.error);
        if (inside.refused) {
            const full = await run(ns, recorded, json, false);
            if (full.error) row.fullError = errType(full.error);
        }
        rows.push(row);
    }
    process.stderr.write(`${s.hash.slice(0, 8)} ${s.model} ${i} cells\n`);
}
const rebuilt = rows.reduce((n, r) => n + (r.rebuilt ?? 0), 0);
if (ownedPlain && !rebuilt) throw new Error("--owned-plain rebuilt no value in any run: the counterfactual would equal the plain replay by construction");
fs.writeFileSync(out, JSON.stringify({ meta: { ownedPlain, csvServed, rebuilt, runs: runs.length, core: fs.readFileSync(path.join(ROOT, "pyodide-core/.pin"), "utf8").trim(), at: new Date().toISOString() }, rows }, null, 1) + "\n");
