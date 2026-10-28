// one.mjs <coreDir> <restrictedPy> — loads Pyodide from the fork core, runs bench.py, prints ONE JSON object { meta, step_rate, rows }.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [core, restricted = "/Users/sb/git/cpython-pycancel/Lib/restricted.py"] = process.argv.slice(2);
if (!core) { console.error("usage: node one.mjs <coreDir> [restrictedPy] > out.json"); process.exit(2); }
const { loadPyodide } = await import(path.join(path.resolve(core), "pyodide.mjs"));
const py = await loadPyodide({ indexURL: path.resolve(core) + "/" });
py.FS.writeFile("/tmp/regex_bench.py", fs.readFileSync(path.join(import.meta.dirname, "bench.py"), "utf8"));
py.FS.writeFile("/tmp/restricted_fork.py", fs.readFileSync(path.resolve(restricted), "utf8"));
const loadStart = os.loadavg();
const out = JSON.parse(py.runPython(`
import json, sys
sys.path.insert(0, "/tmp")
import regex_bench
json.dumps(regex_bench.run("/tmp/restricted_fork.py"))
`));
out.meta.cpus = os.cpus()[0]?.model ?? "?";
out.meta.cpu_count = os.cpus().length;
out.meta.node = process.version;
out.meta.loadavg_start = loadStart;
out.meta.loadavg_end = os.loadavg();
process.stdout.write(JSON.stringify(out));
