// one.mjs [coreDir] — loads Pyodide (default dist/pyodide, run from the repo root), runs bench.py, prints ONE JSON object { meta, step_rate, listing, reads }.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [core = "dist/pyodide"] = process.argv.slice(2);
const { loadPyodide } = await import(path.join(path.resolve(core), "pyodide.mjs"));
const py = await loadPyodide({ indexURL: path.resolve(core) + "/", stdout: () => {}, stderr: () => {} });
py.FS.writeFile("/tmp/os_bench.py", fs.readFileSync(path.join(import.meta.dirname, "bench.py"), "utf8"));
const loadStart = os.loadavg();
const out = JSON.parse(py.runPython(`
import json, sys
sys.path.insert(0, "/tmp")
import os_bench
json.dumps(os_bench.run())
`));
out.meta.cpus = os.cpus()[0]?.model ?? "?";
out.meta.cpu_count = os.cpus().length;
out.meta.node = process.version;
out.meta.pyodide = py.version;
out.meta.date = new Date().toISOString().slice(0, 19) + "Z";
out.meta.loadavg_start = loadStart;
out.meta.loadavg_end = os.loadavg();
process.stdout.write(JSON.stringify(out));
