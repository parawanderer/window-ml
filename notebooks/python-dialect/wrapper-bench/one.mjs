// one.mjs <coreDir> <dataDir> <reps> — one fresh Pyodide: the plain loop before any restricted run, after one, and metered.
import path from "node:path";
import fs from "node:fs";
const [core, data, reps = "3"] = process.argv.slice(2);
const { loadPyodide } = await import(path.join(core, "pyodide.mjs"));
const py = await loadPyodide({ indexURL: core + "/" });
const files = Object.fromEntries(fs.readdirSync(data).filter((f) => /^(whitelist|manifest-.*)\.json$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(data, f), "utf8")]));
py.globals.set("FILES", py.toPy(files));
py.globals.set("REPS", Number(reps));
const out = py.runPython(`
import json, os, time, gc, _restricted, restricted
os.makedirs("/tmp/d", exist_ok=True)
for n, t in FILES.items():
    open("/tmp/d/" + n, "w").write(t)
_restricted.reset(); restricted.load_manifests("/tmp/d")
NODES = frozenset(json.loads(FILES["whitelist.json"])["nodes"])
BODY = "x = []\\nfor i in range(1000000):\\n    x.append((i, i + 1))\\n"
ns = {}
exec("def plain():\\n" + "".join("    " + l + "\\n" for l in BODY.splitlines()) + "    return x\\n", ns)
plain = ns["plain"]
def timed(f):
    gc.collect(); t = time.perf_counter(); r = f(); dt = time.perf_counter() - t; del r; return dt
hook = getattr(_restricted, "_memory_wrapped", None)
res = {"per_run_build": hook is not None}
res["before"] = [timed(plain) for _ in range(REPS)]
restricted.run_cell("y = 1\\nreturn y", {}, NODES)
res["wrapped_after_run"] = list(hook()) if hook else None
res["after"] = [timed(plain) for _ in range(REPS)]
res["metered"] = [timed(lambda: restricted.run_cell(BODY + "return 7", {}, NODES)) for _ in range(REPS)]
res["after2"] = [timed(plain) for _ in range(REPS)]
json.dumps(res)
`);
console.log(out);
