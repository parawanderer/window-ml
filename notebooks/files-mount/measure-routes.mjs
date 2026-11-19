// measure-routes.mjs — which routes to a file's bytes under a mounted `/files` a python_exec cell has, INSIDE the read-only
// dialect (the fork's `restricted.run_cell`) and outside it, on the restricted-mode core; and whether a Parquet writer runs.
//
// Ruling 36's first item (docs/spec/FILE_ATTACHMENTS.md, "Python's view: two mounts"): "whether the restricted fork gates
// `open()` on a mount". The fork has no file gate: `open` is a refused BUILTIN of CO_RESTRICTED code, and nothing in
// Python/restricted.c or Lib/restricted.py looks at a path. So the question measured is the table of route by context,
// refused or read, for every route a cell has: the builtin, the io/pathlib/os modules, and the admitted libraries' own
// file readers and writers (pandas, numpy, PIL, pyarrow), which open a path in LIBRARY frames.
//
// Run with `npm run build && node notebooks/files-mount/measure-routes.mjs` (dist/pyodide must be the fork core:
// `npm run fetch-pyodide`). Writes data/routes.json. Nothing in src/ changes: the cell runs through the worker's own
// wrappers (`wrapUserSetup` + `wrapUserScript(…, inside)`), as tests/python-dialect-inside.test.mjs drives them. The mount
// is MEMFS: the gate is in the interpreter, above Emscripten's FS layer, so the FS type behind `/files` cannot change a
// verdict; measure-chromium.mjs runs the read routes again over WORKERFS and the custom mounts to confirm that.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapUserSetup, wrapUserScript } from "../../src/python/python-runtime.ts";
import { dialectSetup } from "../../src/python/python-dialect-run.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const PYODIDE_DIR = path.join(ROOT, "dist", "pyodide");
const DIALECT = path.join(ROOT, "notebooks", "python-dialect", "data");
const TABLES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DIALECT, f), "utf8")]));
const NODES = JSON.parse(TABLES["whitelist.json"]).nodes;

/** The files a cell reaches, written on the full path before any probe, one per reader. */
const FIXTURE = `
import os, json, pickle, numpy as np, pandas as pd
from PIL import Image
os.makedirs("/files/attached", exist_ok=True); os.makedirs("/files/agent", exist_ok=True)
df = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
df.to_csv("/files/attached/t.csv", index=False)
df.to_json("/files/attached/t.json")
open("/files/attached/t.txt", "w").write("1 2 3\\n4 5 6\\n")
np.save("/files/attached/a.npy", np.arange(6))
np.arange(6, dtype="int64").tofile("/files/attached/a.bin")
Image.new("RGB", (4, 3)).save("/files/attached/i.png")
pickle.dump({"k": 1}, open("/files/attached/p.pkl", "wb"))
try:
    import pyarrow as pa, pyarrow.parquet as pq
    pq.write_table(pa.Table.from_pandas(df), "/files/attached/t.parquet")
except Exception as e:
    open("/files/attached/parquet-failed.txt", "w").write(repr(e))
`;

/** Every route, read and write. `cell` is the source a model would write; each read returns how much it got. */
const ROUTES = [
    // --- positive controls: an admitted cell runs inside, so a refusal below is the route's ---
    { route: "CONTROL pandas frame", kind: "control", cell: `import pandas as pd\nlen(pd.DataFrame({"a": [1, 2]}))` },
    { route: "CONTROL numpy array", kind: "control", cell: `import numpy as np\nnp.array([1, 2]).tolist()` },
    // --- the builtin and its aliases ---
    { route: "open() builtin", kind: "read", cell: `len(open("/files/attached/t.csv").read())` },
    { route: "open() in a with", kind: "read", cell: `with open("/files/attached/t.csv") as f:\n    n = len(f.read())\nn` },
    { route: "builtins.open", kind: "read", cell: `import builtins\nlen(builtins.open("/files/attached/t.csv").read())` },
    { route: "io.open", kind: "read", cell: `import io\nlen(io.open("/files/attached/t.csv").read())` },
    { route: "io.FileIO", kind: "read", cell: `import io\nlen(io.FileIO("/files/attached/t.csv").read())` },
    { route: "pathlib read_text", kind: "read", cell: `import pathlib\nlen(pathlib.Path("/files/attached/t.csv").read_text())` },
    { route: "pathlib read_bytes", kind: "read", cell: `from pathlib import Path\nlen(Path("/files/attached/t.csv").read_bytes())` },
    { route: "os.open + os.read", kind: "read", cell: `import os\nfd = os.open("/files/attached/t.csv", os.O_RDONLY)\nlen(os.read(fd, 1000))` },
    { route: "os.listdir", kind: "list", cell: `import os\nsorted(os.listdir("/files/attached"))` },
    { route: "glob.glob", kind: "list", cell: `import glob\nsorted(glob.glob("/files/attached/*"))` },
    { route: "codecs.open", kind: "read", cell: `import codecs\nlen(codecs.open("/files/attached/t.csv").read())` },
    { route: "linecache.getlines", kind: "read", cell: `import linecache\nlen(linecache.getlines("/files/attached/t.csv"))` },
    { route: "fileinput", kind: "read", cell: `import fileinput\nlen(list(fileinput.input("/files/attached/t.csv")))` },
    { route: "shutil.copyfile", kind: "write", target: "/files/agent/copy.csv", cell: `import shutil\nshutil.copyfile("/files/attached/t.csv", "/files/agent/copy.csv")` },
    { route: "csv.reader over open()", kind: "read", cell: `import csv\nlen(list(csv.reader(open("/files/attached/t.csv"))))` },
    { route: "json.load over open()", kind: "read", cell: `import json\nlen(json.load(open("/files/attached/t.json")))` },
    { route: "pickle.load over open()", kind: "read", cell: `import pickle\npickle.load(open("/files/attached/p.pkl", "rb"))` },
    // --- the admitted libraries, opening a path in their own frames ---
    { route: "pd.read_csv(path)", kind: "read", cell: `import pandas as pd\npd.read_csv("/files/attached/t.csv").shape[0]` },
    { route: "pd.read_table(path)", kind: "read", cell: `import pandas as pd\npd.read_table("/files/attached/t.csv", sep=",").shape[0]` },
    { route: "pd.read_json(path)", kind: "read", cell: `import pandas as pd\npd.read_json("/files/attached/t.json").shape[0]` },
    { route: "pd.read_parquet(path)", kind: "read", cell: `import pandas as pd\npd.read_parquet("/files/attached/t.parquet").shape[0]` },
    { route: "pd.read_pickle(path)", kind: "read", cell: `import pandas as pd\nlen(pd.read_pickle("/files/attached/p.pkl"))` },
    { route: "np.load(path)", kind: "read", cell: `import numpy as np\nint(np.load("/files/attached/a.npy").sum())` },
    { route: "np.loadtxt(path)", kind: "read", cell: `import numpy as np\nint(np.loadtxt("/files/attached/t.txt").sum())` },
    { route: "np.genfromtxt(path)", kind: "read", cell: `import numpy as np\nint(np.genfromtxt("/files/attached/t.txt").sum())` },
    { route: "np.fromfile(path)", kind: "read", cell: `import numpy as np\nint(np.fromfile("/files/attached/a.bin", dtype="int64").sum())` },
    { route: "np.memmap(path)", kind: "read", cell: `import numpy as np\nint(np.memmap("/files/attached/a.bin", dtype="int64", mode="r").sum())` },
    { route: "PIL Image.open(path)", kind: "read", cell: `from PIL import Image\nImage.open("/files/attached/i.png").size[0]` },
    { route: "pyarrow.parquet.read_table(path)", kind: "read", cell: `import pyarrow.parquet as pq\npq.read_table("/files/attached/t.parquet").num_rows` },
    // --- writes, each checked by whether the target exists afterwards ---
    { route: "open(path, 'w')", kind: "write", target: "/files/agent/w.txt", cell: `open("/files/agent/w.txt", "w").write("hi")` },
    { route: "pathlib write_text", kind: "write", target: "/files/agent/p.txt", cell: `import pathlib\npathlib.Path("/files/agent/p.txt").write_text("hi")` },
    { route: "df.to_csv(path)", kind: "write", target: "/files/agent/d.csv", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_csv("/files/agent/d.csv")` },
    { route: "df.to_parquet(path)", kind: "write", target: "/files/agent/d.parquet", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_parquet("/files/agent/d.parquet")` },
    { route: "np.save(path)", kind: "write", target: "/files/agent/s.npy", cell: `import numpy as np\nnp.save("/files/agent/s.npy", np.arange(3))` },
    { route: "ndarray.tofile(path)", kind: "write", target: "/files/agent/s.bin", cell: `import numpy as np\nnp.array([1, 2]).tofile("/files/agent/s.bin")` },
    { route: "np.savetxt(path)", kind: "write", target: "/files/agent/s.txt", cell: `import numpy as np\nnp.savetxt("/files/agent/s.txt", np.array([1, 2]))` },
    { route: "Image.save(path)", kind: "write", target: "/files/agent/s.png", cell: `from PIL import Image\nImage.new("RGB", (2, 2)).save("/files/agent/s.png")` },
    { route: "df.to_string(buf=path)", kind: "write", target: "/files/agent/to_string.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_string(buf="/files/agent/to_string.out")` },
    { route: "df.to_html(buf=path)", kind: "write", target: "/files/agent/to_html.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_html(buf="/files/agent/to_html.out")` },
    { route: "df.to_markdown(buf=path)", kind: "write", target: "/files/agent/to_markdown.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_markdown(buf="/files/agent/to_markdown.out")` },
    { route: "df.to_latex(buf=path)", kind: "write", target: "/files/agent/to_latex.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_latex(buf="/files/agent/to_latex.out")` },
    { route: "df.to_json(buf=path)", kind: "write", target: "/files/agent/to_json.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_json("/files/agent/to_json.out")` },
    { route: "df.to_xml(buf=path)", kind: "write", target: "/files/agent/to_xml.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_xml("/files/agent/to_xml.out")` },
    { route: "df.to_pickle(buf=path)", kind: "write", target: "/files/agent/to_pickle.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_pickle("/files/agent/to_pickle.out")` },
    { route: "df.to_feather(buf=path)", kind: "write", target: "/files/agent/to_feather.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_feather("/files/agent/to_feather.out")` },
    { route: "df.to_excel(buf=path)", kind: "write", target: "/files/agent/to_excel.out", cell: `import pandas as pd\npd.DataFrame({"a": [1]}).to_excel("/files/agent/to_excel.out")` },
    { route: "Series.to_csv(path)", kind: "write", target: "/files/agent/series.csv", cell: `import pandas as pd\npd.Series([1]).to_csv("/files/agent/series.csv")` },
    { route: "Series.to_string(buf=path)", kind: "write", target: "/files/agent/series.txt", cell: `import pandas as pd\npd.Series([1]).to_string(buf="/files/agent/series.txt")` },
    { route: "pq.write_table(path)", kind: "write", target: "/files/agent/w.parquet", cell: `import pyarrow as pa, pyarrow.parquet as pq\npq.write_table(pa.table({"a": [1]}), "/files/agent/w.parquet")` },
];

const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
const py = await loadPyodide({ indexURL: PYODIDE_DIR });
if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) throw new Error("dist/pyodide is the stock core: run `npm run fetch-pyodide`");
await py.loadPackage(["numpy", "pandas", "pillow", "pyarrow"]);
const setupAnswer = String(await py.runPythonAsync(dialectSetup(TABLES)));
if (setupAnswer) throw new Error(`dialectSetup refused: ${setupAnswer}`);
py.FS.mkdir("/files");
py.FS.mount(py.FS.filesystems.MEMFS, {}, "/files");
await py.runPythonAsync(FIXTURE);
const exists = (p) => { try { py.FS.stat(p); return true; } catch { return false; } };
const parquetFailed = exists("/files/attached/parquet-failed.txt") ? py.FS.readFile("/files/attached/parquet-failed.txt", { encoding: "utf8" }) : null;

/** One cell, as the worker runs it, in a fresh namespace. Inside: under `run_cell`; outside: the approved full path. */
async function cell(code, inside) {
    const ns = py.globals.get("dict")();
    try {
        await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
        await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: NODES } : null), { globals: ns });
        const refused = inside ? ns.get("_ml_not_in_dialect") : undefined;
        if (refused) return { verdict: "refused", line: String(refused).split("\n").filter((l) => l.trim()).at(-1) };
        const err = ns.get("_err");
        if (err) return { verdict: "error", line: String(err).split("\n").filter((l) => l.trim()).at(-1) };
        const jr = ns.get("_json_result");
        let value; try { value = JSON.parse(jr); } catch { value = String(jr); }
        return { verdict: "ran", value };
    } finally { ns.destroy(); }
}

const rows = [];
for (const r of ROUTES) {
    const row = { route: r.route, kind: r.kind, cell: r.cell };
    for (const [ctx, inside] of [["inside", true], ["outside", false]]) {
        if (r.target && exists(r.target)) py.FS.unlink(r.target);
        const got = await cell(r.cell, inside);
        if (r.kind === "write") got.wrote = exists(r.target);
        row[ctx] = got;
    }
    rows.push(row);
    console.log(`${r.route.padEnd(34)} inside: ${row.inside.verdict.padEnd(8)} outside: ${row.outside.verdict}${row.inside.verdict !== "refused" ? "   <-- " + JSON.stringify(row.inside) : ""}`);
}

const pin = fs.existsSync(path.join(ROOT, "pyodide-core", ".pin")) ? fs.readFileSync(path.join(ROOT, "pyodide-core", ".pin"), "utf8").trim() : null;
const parquet = String(await py.runPythonAsync(`
import pyarrow, json
try:
    import pyarrow.parquet as pq, pyarrow._parquet
    ok = True; err = None
except Exception as e:
    ok = False; err = repr(e)
json.dumps({"pyarrow": pyarrow.__version__, "parquet_module": ok, "error": err, "codecs": {c: pyarrow.Codec.is_available(c) for c in ["snappy", "gzip", "brotli", "zstd", "lz4"]}})
`));
fs.mkdirSync(path.join(HERE, "data"), { recursive: true });
fs.writeFileSync(path.join(HERE, "data", "routes.json"), JSON.stringify({ core: pin, measured: new Date().toISOString().slice(0, 10), fixtureParquetFailed: parquetFailed, parquet: JSON.parse(parquet), rows }, null, 2) + "\n");
console.log("parquet:", parquet);
process.exit(0);
