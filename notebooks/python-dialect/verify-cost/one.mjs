// one.mjs <coreDir> <reps> — one fresh Pyodide: prints {shape: [ns per call per rep]} for shapes.py's four shapes.
import fs from "node:fs";
import path from "node:path";
const [core, reps = "5"] = process.argv.slice(2);
const { loadPyodide } = await import(path.join(path.resolve(core), "pyodide.mjs"));
const py = await loadPyodide({ indexURL: path.resolve(core) + "/" });
py.FS.writeFile("/tmp/shapes.py", fs.readFileSync(path.join(import.meta.dirname, "shapes.py"), "utf8"));
py.globals.set("REPS", Number(reps));
console.log(py.runPython(`
import json, sys
sys.path.insert(0, "/tmp")
from shapes import measure
json.dumps(measure(REPS))
`));
