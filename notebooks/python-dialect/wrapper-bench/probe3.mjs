// probe3.mjs <coreDir> <dataDir> — is the wrapper's cost per call or per byte? Same call count, different sizes.
import path from "node:path";
import fs from "node:fs";
const [core, data] = process.argv.slice(2);
const { loadPyodide } = await import(path.join(core, "pyodide.mjs"));
const py = await loadPyodide({ indexURL: core + "/" });
const files = Object.fromEntries(fs.readdirSync(data).filter((f) => /^(whitelist|manifest-.*)\.json$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(data, f), "utf8")]));
py.globals.set("FILES", py.toPy(files));
const out = py.runPython(`
import json, os, time, gc, _restricted, restricted
os.makedirs("/tmp/d", exist_ok=True)
for n, t in FILES.items():
    open("/tmp/d/" + n, "w").write(t)
_restricted.reset(); restricted.load_manifests("/tmp/d")
NODES = frozenset(json.loads(FILES["whitelist.json"])["nodes"])
hook = getattr(_restricted, "_memory_wrapped", None)

def timed(f):
    gc.collect(); t = time.perf_counter(); r = f(); dt = time.perf_counter() - t; del r; return dt

def spray_sz(sz, n=100_000):
    def f():
        c = 0
        for i in range(n):
            b = bytearray(sz)
            c += b[0]
        return c
    return f

def held_ints(n=400_000):
    def f():
        return [i + 12345678 for i in range(n)]
    return f

SZ = (1, 8, 32, 128, 512, 2048)
res = {"per_run_build": hook is not None, "reps": 5, "spray_n": 100_000, "held_n": 400_000}
res["before"] = {"held": [timed(held_ints()) for _ in range(5)],
                 **{str(sz): [timed(spray_sz(sz)) for _ in range(5)] for sz in SZ}}
restricted.run_cell("y = 1\\nreturn y", {}, NODES)
res["wrapped_after"] = list(hook()) if hook else None
res["after"] = {"held": [timed(held_ints()) for _ in range(5)],
                **{str(sz): [timed(spray_sz(sz)) for _ in range(5)] for sz in SZ}}
json.dumps(res)
`);
console.log(out);
