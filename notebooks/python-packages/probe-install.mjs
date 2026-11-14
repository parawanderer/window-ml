// probe-install.mjs — the measurements slice 4's design rests on (docs/plan/repl/PACKAGES_INSTALL.md, "Slice 4: the
// design"): a wheel installed from its BYTES (no loadPackage, no fetch) into the readonly worker's boot, unpacked
// before or after `lockdownReadonly`, then imported in a hardened cell; what a failed import leaves behind; what a
// candidate worker's boot costs. Reads only local files: the built core and the lock's own wheels.
//
//   node --import tsx notebooks/python-packages/probe-install.mjs <pre|post|leftovers> [dist/pyodide] [pyodide-wheels]
//
// One mode per process, because `lockdown()` runs once per realm. `pre`: unpack, then lock down, then import.
// `post`: lock down, then unpack (from JS, as the harness would), then import. `leftovers`: no lockdown; an import
// that fails on an undeclared dependency, and what stays on disk and in `sys.modules`.

import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const [MODE = "pre", DIR = path.join(ROOT, "dist/pyodide"), WHEELS = path.join(ROOT, "pyodide-wheels")] = process.argv.slice(2);
const SITE = "/lib/python3.14/site-packages";
const { wrapUserCode, injectInputs } = await import(path.join(ROOT, "src/python/python-runtime.ts"));
const { lockdownReadonly } = await import(path.join(ROOT, "src/python/lockdown.ts"));
const { PY_PACKAGE_LOADS, PY_STARTUP_PREPARE } = await import(path.join(ROOT, "src/python/python-env.ts"));

/** A lock wheel's bytes by project name, as a Uint8Array (Pyodide refuses a Node Buffer). */
const bytes = (name) => new Uint8Array(fs.readFileSync(path.join(WHEELS, fs.readdirSync(WHEELS).find((f) => f.startsWith(name + "-")))));
const lastLine = (e) => String(e?.message ?? e).trim().split("\n").pop().slice(0, 300);

const t0 = Date.now();
const { loadPyodide } = await import(path.join(DIR, "pyodide.mjs"));
const py = await loadPyodide({ indexURL: DIR + "/" });
py.setStdout({ batched: () => {} });
py.setStderr({ batched: () => {} });
const tCore = Date.now() - t0;
const unpack = (name) => { try { py.unpackArchive(bytes(name), "wheel", { extractDir: SITE }); return "ok"; } catch (e) { return `threw: ${lastLine(e)}`; } };
const py1 = (code) => { try { return String(py.runPython(code)); } catch (e) { return `PYERR ${lastLine(e)}`; } };

if (MODE === "leftovers") {
    console.log("unpack matplotlib without its dependencies:", unpack("matplotlib"));
    console.log("import:", py1("import importlib\nimportlib.invalidate_caches()\ntry:\n    import matplotlib\n    r = 'ok'\nexcept ModuleNotFoundError as e:\n    r = f'ModuleNotFoundError name={e.name!r}'\nr"));
    console.log("in sys.modules after:", py1("import sys\nrepr(sorted(k for k in sys.modules if k.startswith('matplotlib')))"));
    console.log("on disk after:", py1(`import os\nrepr(sorted(n for n in os.listdir(${JSON.stringify(SITE)}) if n.startswith('matplotlib')))`));
    console.log("top_level.txt vs RECORD:", py1("import importlib.metadata as m\nd = m.distribution('matplotlib')\nrepr((d.read_text('top_level.txt'), sorted({f.parts[0] for f in d.files if '.dist-info' not in f.parts[0]})))"));
    process.exit(0);
}

await py.loadPackage(PY_PACKAGE_LOADS);
if (PY_STARTUP_PREPARE) py.runPython(PY_STARTUP_PREPARE);
const tSet = Date.now() - t0;
if (MODE === "pre") console.log("unpack kiwisolver (native), cycler (pure) before the lockdown:", unpack("kiwisolver"), unpack("cycler"));
const { harness } = await lockdownReadonly(py, {});
console.log(`boot: core ${tCore} ms, with the start-up set ${tSet} ms, locked ${Date.now() - t0} ms; rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`);
if (MODE === "post") { const t = Date.now(); console.log("unpack kiwisolver, cycler after the lockdown:", unpack("kiwisolver"), unpack("cycler"), `${Date.now() - t} ms`); }

/** One hardened cell, as python_exec runs it in a readonly worker. */
async function cell(code) {
    injectInputs(py.globals, null, null, harness);
    try { await py.runPythonAsync(wrapUserCode(code, true)); } catch (e) { return { threw: lastLine(e) }; }
    const err = py.globals.get("_err");
    return { error: err ? lastLine(err) : null, value: py.globals.get("_json_result") };
}
const ti = Date.now();
console.log("import cycler:", JSON.stringify(await cell("import cycler\ncycler.__version__")));
console.log("import kiwisolver and solve:", JSON.stringify(await cell("import kiwisolver\ns = kiwisolver.Solver(); x = kiwisolver.Variable('x'); s.addConstraint(x >= 3); s.updateVariables(); x.value()")));
console.log(`import test ${Date.now() - ti} ms`);
