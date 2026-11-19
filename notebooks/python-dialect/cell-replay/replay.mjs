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
const [out, ...runs] = args.filter((a) => a !== "--owned-plain");
if (!out || !runs.length) { console.error("usage: node --import tsx replay.mjs [--owned-plain] <out.json> <run.json>..."); process.exit(2); }

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
    for (const st of s.steps ?? []) {
        if (st.tool !== "python_exec" || st.approval !== "user") continue;
        const code = String(st.arguments?.code ?? "");
        if (!code) continue;
        const { json, tableError } = injected(st.arguments?.tables);
        let rebuilt;
        if (ownedPlain) { await setup(ns, json); rebuilt = await ownPlain(ns, json); }
        const t0 = Date.now();
        const inside = ownedPlain ? await script(ns, code, json, true) : await run(ns, code, json, true);
        const row = { run: s.hash, model: s.model, sweep, cell: i++, inside: !inside.refused, refused: inside.refused ?? null, ms: Date.now() - t0 };
        if (ownedPlain) row.rebuilt = rebuilt;
        if (tableError) row.tableError = tableError;
        if (inside.error) row.insideError = errType(inside.error);
        if (inside.refused) {
            const full = await run(ns, code, json, false);
            if (full.error) row.fullError = errType(full.error);
        }
        rows.push(row);
    }
    process.stderr.write(`${s.hash.slice(0, 8)} ${s.model} ${i} cells\n`);
}
const rebuilt = rows.reduce((n, r) => n + (r.rebuilt ?? 0), 0);
if (ownedPlain && !rebuilt) throw new Error("--owned-plain rebuilt no value in any run: the counterfactual would equal the plain replay by construction");
fs.writeFileSync(out, JSON.stringify({ meta: { ownedPlain, rebuilt, runs: runs.length, core: fs.readFileSync(path.join(ROOT, "pyodide-core/.pin"), "utf8").trim(), at: new Date().toISOString() }, rows }, null, 1) + "\n");
