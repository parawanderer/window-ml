// probe.mjs — asks the REAL python_exec core (pyodide-core/, the restricted-mode build) what it can install: its marker
// environment, supported wheel tags and lock (`env`), or whether one PyPI project installs with micropip and imports
// (`install <project>`). One interpreter per call, so no install leaks into the next; prints one JSON line.
//
//     node notebooks/python-packages/probe.mjs env
//     node notebooks/python-packages/probe.mjs install tabulate
//
// Wheels the lock names come from the Pyodide CDN for the pinned version (tools/pyodide-dist.json), the rest from PyPI,
// which is what micropip does in the browser. Run from the repo root.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CORE = path.join(ROOT, "pyodide-core");
const DIST = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/pyodide-dist.json"), "utf8"));
const CDN = `https://cdn.jsdelivr.net/pyodide/v${DIST.pyodide}/full/`;
// Where Node's Pyodide keeps the lock wheels it downloads. Left unset it is `packageBaseUrl` read as a RELATIVE path,
// which wrote a `https:/cdn.jsdelivr.net/…` tree into the working directory.
const WHEEL_CACHE = process.env.PYPKG_WHEEL_CACHE || path.join(os.tmpdir(), `window-ml-pypkgs-wheels-${DIST.pyodide}`);

/** Boot a fresh interpreter on the restricted core, with micropip and packaging loaded. */
async function boot() {
    const { loadPyodide } = await import(path.join(CORE, "pyodide.mjs"));
    const py = await loadPyodide({ indexURL: CORE + "/", packageBaseUrl: CDN, packageCacheDir: WHEEL_CACHE, stdout: () => {}, stderr: () => {} });
    await py.loadPackage(["micropip", "packaging"], { messageCallback: () => {} });
    return py;
}

const ENV_PY = `
import json, sys
from packaging.markers import default_environment
from packaging import tags
import pyodide_js
lock = pyodide_js._api.lockfile_packages.to_py()
json.dumps({
    "env": default_environment(),
    "tags": [str(t) for t in tags.sys_tags()],
    "python": sys.version.split()[0],
    "preloaded": sorted(pyodide_js.loadedPackages.to_py()),
    "lock": {k: {"version": v["version"], "file_name": v["file_name"], "depends": list(v.get("depends", [])),
                 "imports": list(v.get("imports", [])), "package_type": v.get("package_type")} for k, v in lock.items()},
})
`;

// Install, then import what the distribution provides: its top_level.txt, else the top packages and modules its
// RECORD lists (descending into a namespace package that has no __init__.py, so `google-cloud-storage` imports
// google.cloud.storage, not the empty `google`). Each import's failure is kept separately.
const INSTALL_PY = (name) => `
import json, sys, time, importlib, importlib.metadata as md, traceback
import micropip
from packaging.utils import canonicalize_name
NAME = ${JSON.stringify(name)}
out = {"project": NAME}
before = {canonicalize_name(p) for p in micropip.list()}
t0 = time.time()
try:
    await micropip.install(NAME)
except BaseException as e:
    out.update(stage="install", error_type=type(e).__name__, error=str(e)[:600])
else:
    out["install_s"] = round(time.time() - t0, 2)
    pkgs = micropip.list()
    out["installed"] = sorted([{"name": p, "version": pkgs[p].version, "source": pkgs[p].source}
                               for p in pkgs if canonicalize_name(p) not in before], key=lambda r: r["name"])
    try:
        dist = md.distribution(NAME)
    except md.PackageNotFoundError:
        dist = None
    mods = []
    if dist is not None:
        top = dist.read_text("top_level.txt")
        files = [str(f) for f in (dist.files or [])]
        if top:
            mods = [m.strip() for m in top.split() if m.strip()]
        else:
            pkgdirs, singles = {}, []
            for f in files:
                parts = f.split("/")
                if parts[0].endswith((".dist-info", ".data")) or parts[0] in ("..", "bin", "tests", "test"):
                    continue
                if len(parts) == 1 and f.endswith(".py"):
                    singles.append(f[:-3])
                elif f.endswith("__init__.py"):
                    dotted = ".".join(parts[:-1])
                    top0 = parts[0]
                    if top0 not in pkgdirs or len(dotted) < len(pkgdirs[top0]):
                        pkgdirs[top0] = dotted
            mods = list(pkgdirs.values()) + singles
        # A namespace package's top_level.txt names the empty parent: descend to its first real package.
        resolved = []
        for m in mods:
            if any(f.startswith(m.replace(".", "/") + "/__init__.py") or f == m.replace(".", "/") + ".py" for f in files) or not files:
                resolved.append(m)
                continue
            inits = sorted((f for f in files if f.startswith(m.replace(".", "/") + "/") and f.endswith("__init__.py")), key=len)
            resolved.append(".".join(inits[0].split("/")[:-1]) if inits else m)
        mods = [m for m in dict.fromkeys(resolved) if m and not m.startswith("_") and m.isascii()][:6]
    out["modules"] = mods
    out["imports"] = []
    for m in mods:
        t1 = time.time()
        try:
            importlib.import_module(m)
            out["imports"].append({"module": m, "ok": True, "s": round(time.time() - t1, 2)})
        except BaseException as e:
            tb = traceback.extract_tb(e.__traceback__)
            out["imports"].append({"module": m, "ok": False, "error_type": type(e).__name__, "error": str(e)[:400],
                                   "where": (tb[-1].filename.split("site-packages/")[-1] + ":" + str(tb[-1].lineno)) if tb else None})
    out["stage"] = "import" if any(not r["ok"] for r in out["imports"]) else ("no-module" if not mods else "ok")
json.dumps(out)
`;

const [mode, arg] = process.argv.slice(2);
const py = await boot();
if (mode === "env") {
    console.log(await py.runPythonAsync(ENV_PY));
} else if (mode === "install" && arg) {
    console.log(await py.runPythonAsync(INSTALL_PY(arg)));
} else {
    console.error("usage: probe.mjs env | install <project>");
    process.exit(2);
}
process.exit(0);
