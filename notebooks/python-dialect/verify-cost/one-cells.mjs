// one-cells.mjs <coreDir> <reps> <cells.json> — one fresh Pyodide: prints {cell_id: {outcome, ns: [per rep]}} for every
// real cell (cells.py). The core dir needs the wheels beside it (numpy, pandas, pillow, pyarrow and their deps).
import fs from "node:fs";
import path from "node:path";
const [core, reps = "3", cellsFile] = process.argv.slice(2);
const DATA = path.resolve(import.meta.dirname, "../data");
const { loadPyodide } = await import(path.join(path.resolve(core), "pyodide.mjs"));
const py = await loadPyodide({ indexURL: path.resolve(core) + "/" });
await py.loadPackage(["numpy", "pandas", "pillow", "pyarrow"], { messageCallback: () => {} });
// python-env.ts PYARROW_PREPARE: pyarrow imported where `js` exists, then `js` taken back out of the module.
py.runPython("import pyarrow\nimport unix_timezones as _u\n_u.__dict__.pop('js', None)\ndel _u");
py.FS.mkdirTree("/dialect-data");
py.mountNodeFS("/dialect-data", DATA);
py.FS.writeFile("/tmp/cells.py", fs.readFileSync(path.join(import.meta.dirname, "cells.py"), "utf8"));
py.globals.set("REPS", Number(reps));
py.globals.set("CELLS", fs.readFileSync(cellsFile, "utf8"));
console.log(py.runPython(`
import json, sys
sys.path.insert(0, "/tmp")
from cells import measure
json.dumps(measure(CELLS, "/dialect-data", REPS))
`));
