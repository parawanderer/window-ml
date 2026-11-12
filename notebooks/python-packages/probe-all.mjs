// probe-all.mjs — install ONE PyPI project with micropip on the restricted python_exec core and import EVERY module its
// own distribution's RECORD lists, one at a time, in a fresh interpreter. Prints one JSON line per event to stdout:
//   {"ev":"install", ...}               the install's outcome and the closure that came in
//   {"ev":"start","m":"pkg.sub"}        printed BEFORE each import, so a hang or a crash names the module it died in
//   {"ev":"import","m":...,"ok":...}    each import's result
//   {"ev":"done", ...}                  the counts; absent if the process was killed
//
//     node probe-all.mjs 'boto3==1.43.126'
//
// Variant of notebooks/python-packages/probe.mjs `install` (window-ml main 7d7d1b1f), which imports at most six
// top-level modules. Same boot, same core, same wheel sources. Run from the window-ml repo root (it reads pyodide-core/
// and tools/pyodide-dist.json from the cwd).

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = process.cwd();
const CORE = path.join(ROOT, "pyodide-core");
const DIST = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/pyodide-dist.json"), "utf8"));
const CDN = `https://cdn.jsdelivr.net/pyodide/v${DIST.pyodide}/full/`;
const WHEEL_CACHE = process.env.PYPKG_WHEEL_CACHE || path.join(os.tmpdir(), `window-ml-pypkgs-wheels-${DIST.pyodide}`);
const MAX_MODULES = Number(process.env.PYPKG_MAX_MODULES || 5000);

const spec = process.argv[2];
if (!spec) { console.error("usage: probe-all.mjs <project>[==<version>]"); process.exit(2); }

const { loadPyodide } = await import(path.join(CORE, "pyodide.mjs"));
// A package's own prints are dropped; only emit() reaches stdout.
const py = await loadPyodide({ indexURL: CORE + "/", packageBaseUrl: CDN, packageCacheDir: WHEEL_CACHE, stdout: () => {}, stderr: () => {} });
await py.loadPackage(["micropip", "packaging"], { messageCallback: () => {} });
py.globals.set("emit", (s) => { fs.writeSync(1, s + "\n"); });
py.globals.set("SPEC", spec);
py.globals.set("MAX_MODULES", MAX_MODULES);

await py.runPythonAsync(`
import json, sys, time, importlib, importlib.metadata as md, traceback, keyword
import micropip
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
NAME = Requirement(SPEC).name
_emit = emit
def out(**kw): _emit(json.dumps(kw))
before = {canonicalize_name(p) for p in micropip.list()}
t0 = time.time()
try:
    await micropip.install(SPEC)
except BaseException as e:
    out(ev="install", ok=False, error_type=type(e).__name__, error=str(e)[:600])
    out(ev="done", stage="install")
else:
    pkgs = micropip.list()
    out(ev="install", ok=True, s=round(time.time() - t0, 2),
        installed=sorted([{"name": p, "version": pkgs[p].version, "source": pkgs[p].source}
                          for p in pkgs if canonicalize_name(p) not in before], key=lambda r: r["name"]))
    files = [str(f) for f in (md.distribution(NAME).files or [])]
    SKIP_DIRS = {"tests", "test", "testing_data", "__pycache__", "bin", ".."}
    mods = set()
    for f in files:
        parts = f.split("/")
        if parts[0].endswith((".dist-info", ".data")) or any(p in SKIP_DIRS for p in parts[:-1]):
            continue
        leaf = parts[-1]
        if leaf.endswith(".py"):
            stem = leaf[:-3]
        elif leaf.endswith(".so"):
            stem = leaf.split(".")[0]          # foo.cpython-314-wasm32-emscripten.so -> foo
        else:
            continue
        dotted = parts[:-1] + ([] if stem == "__init__" else [stem])
        if not dotted or dotted[-1] in ("__main__", "conftest", "setup") or dotted[-1].startswith(("test_", "conftest")):
            continue
        if all(p.isidentifier() and not keyword.iskeyword(p) for p in dotted):
            mods.add(".".join(dotted))
    order = sorted(mods, key=lambda m: (m.count("."), m))
    truncated = len(order) > MAX_MODULES
    order = order[:MAX_MODULES]
    n_ok = n_fail = 0
    for m in order:
        out(ev="start", m=m)
        t1 = time.time()
        try:
            importlib.import_module(m)
            n_ok += 1
            out(ev="import", m=m, ok=True, s=round(time.time() - t1, 3))
        except BaseException as e:
            n_fail += 1
            tb = traceback.extract_tb(e.__traceback__)
            out(ev="import", m=m, ok=False, error_type=type(e).__name__, error=str(e)[:300],
                where=(tb[-1].filename.split("site-packages/")[-1] + ":" + str(tb[-1].lineno)) if tb else None)
    out(ev="done", stage="ok", modules=len(order), ok=n_ok, failed=n_fail, truncated=truncated)
`);
process.exit(0);
