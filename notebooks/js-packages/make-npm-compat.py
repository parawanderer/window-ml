"""make-npm-compat.py — builds npm-compat.ipynb: of the npm packages people actually use, which would load in a
browser sandbox with no Node built-ins (a Worker, a sandboxed extension page), and can their package.json and
source tell which before anything is installed? The npm half of python-packages/pypi-compat.ipynb.

    .venv/bin/python notebooks/js-packages/make-npm-compat.py && node scripts/nb.mjs run notebooks/js-packages/npm-compat.ipynb
    (or: node scripts/nb.mjs make notebooks/js-packages/npm-compat.ipynb)

The cells are written here; edit this file, not the notebook. The inputs are pinned in data/npm-compat/: the static
rows (npm.py, read from the registry) and the sandbox probes (sandbox.mjs, plain and with --shims). NB_REFRESH=1
re-extracts them from NPMPKG_CACHE=<dir> (default: the system temp dir), which keeps the registry manifests and each
finished sandbox run: to read the registry and run the sandbox again (about 5 minutes, one headless Chromium), clear
that directory first. npm installs run with --ignore-scripts, in directories under it.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Which npm packages would load in a browser sandbox?

The JS counterpart of "Packages on demand": a model asks for an npm package, the person approves, and the package
runs in a JS sandbox that has the web platform and none of Node: no `fs`, `path`, `process`, `Buffer` or `require`.
A Worker is that sandbox; so is a sandboxed extension page.

1. **Static**: the 1,000 most-downloaded packages (`npm-high-impact`'s download ranking), each one's latest
   `package.json` and its source, by regex: which Node built-ins its entry reaches, through its dependency closure
   (each dependency taken at its latest version), and whether it declares a `browser` build.
2. **Empirical**: every one of them, in three steps. `npm install --ignore-scripts` (no install script ever runs),
   an esbuild bundle of `import * as m from "<name>"` for the browser with NO Node polyfills, and the bundle evaluated
   as a module Worker in headless Chromium. A second pass (`--shims`) defines only `global` (as `globalThis`) and
   `process.env.NODE_ENV`, the two names a runtime can provide for nothing.

Evaluation is the bar measured, as import was for Python: a package that loads can still fail when called. The page
the Worker runs from is not cross-origin isolated, so `SharedArrayBuffer` is absent; an extension page could differ.
""")

code("""
import json, os, subprocess, sys, tempfile
from collections import Counter
from pathlib import Path
import pandas as pd
import wmlnb
sys.path.insert(0, str(wmlnb.ROOT / "notebooks" / "js-packages"))
sys.path.insert(0, str(wmlnb.ROOT / "notebooks" / "python-packages"))
import npm, pypi

HERE = wmlnb.ROOT / "notebooks" / "js-packages"
DATA = HERE / "data" / "npm-compat"
N = 1000
CACHE = Path(os.environ.get("NPMPKG_CACHE") or Path(tempfile.gettempdir()) / "window-ml-npm-cache")
pd.set_option("display.width", 160)
pd.set_option("display.max_colwidth", 100)

static = pd.DataFrame(wmlnb.extract(DATA / "static.json", lambda: npm.collect(N, CACHE),
                                    source={"top": "npm-high-impact npmTopDownloads", "n": N, "registry": "https://registry.npmjs.org/<name>/latest"}))

def sandbox(shims):
    out = CACHE / f"sandbox-top{N}{'-shims' if shims else ''}.jsonl"
    if out.exists() and len(out.read_text().splitlines()) == N:  # a finished run in the cache is reused, like the manifests
        return [json.loads(l) for l in out.read_text().splitlines() if l.strip()]
    args = ["node", "notebooks/js-packages/sandbox.mjs", "--top", str(N), "--out", str(out), "--jobs", "6"] + (["--shims"] if shims else [])
    subprocess.run(args, cwd=wmlnb.ROOT, check=True, capture_output=True, env=os.environ | {"NPMPKG_CACHE": str(CACHE)})
    return [json.loads(l) for l in out.read_text().splitlines() if l.strip()]

plain = pd.DataFrame(wmlnb.extract(DATA / "sandbox.json", lambda: sandbox(False), source={"probe": "sandbox.mjs", "n": N}))
shims = pd.DataFrame(wmlnb.extract(DATA / "sandbox-shims.json", lambda: sandbox(True), source={"probe": "sandbox.mjs --shims", "n": N}))
pd.DataFrame(wmlnb.provenance(DATA / "static.json", DATA / "sandbox.json", DATA / "sandbox-shims.json"))
""")

md("""
## Why a package does not load

Each failure gets one cause, in the same spirit as the Python study's:

- **no build**: npm refused the install because the package is one platform's binary (`@esbuild/linux-x64`), the
  counterpart of a wheel with no build for the core.
- **node built-in**: the bundle reaches a Node module (`fs`, `path`, `http`, …) the sandbox does not have.
- **node global**: it bundles, and its code reads `process`, `global` or `require` when evaluated.
- **isolation**: `SharedArrayBuffer`, present only on a cross-origin-isolated page.
- **undeclared dep**: it imports a package it does not declare (the counterpart of the Python study's undeclared
  host packages).
- **probe**: the package has no JavaScript entry to import: types only (`@types/node`, `type-fest`), data
  (`@babel/compat-data`), or only subpath exports (`@babel/runtime`). Not an incompatibility.
- **timeout**: the install ran past 180 s or the evaluation past 10 s (the probe's caps), so a loaded machine shows
  here rather than in another row. None in the pinned runs.
- **install, bundle or eval: other**: a failure at that stage none of the above explains.
""")

code("""
GLOBALS = ("process is not defined", "global is not defined", "require is not defined", "Buffer is not defined", "__dirname", "__require")
def cause(r):
    if r.stage == "ok":
        return "ok"
    if r.stage == "install":
        if r.bundle_errors[0]["kind"] == "timeout":
            return "timeout"
        return "no build" if "notsup" in r.bundle_errors[0]["text"] else "install: other"
    if r.stage == "bundle":
        kinds = Counter(e["kind"] for e in r.bundle_errors)
        if kinds["node-builtin"]:
            return "node built-in"
        if any(e["kind"] == "unresolved" and e["text"] == r["name"] for e in r.bundle_errors):
            return "probe"
        return "undeclared dep" if kinds["unresolved"] else "bundle: other"
    e = r.eval_error or ""
    if e == "timeout":
        return "timeout"
    if "SharedArrayBuffer" in e:  # first: its message contains "Buffer is not defined"
        return "isolation"
    return "node global" if any(g in e for g in GLOBALS) else "eval: other"

for df in (plain, shims):
    df["cause"] = df.apply(cause, axis=1)
BANDS = [(1, 100, "1-100"), (101, 500, "101-500"), (501, 1000, "501-1000")]
def band(rank):
    return next(label for lo, hi, label in BANDS if lo <= rank <= hi)
t = pd.crosstab(plain.cause, plain["rank"].map(band), margins=True, margins_name="all")
t["with shims"] = shims.cause.value_counts()
t.loc["all", "with shims"] = len(shims)
t.fillna(0).astype(int).sort_values("all", ascending=False)
""")

md("""
### Which built-ins stop the bundles

A package counts once per built-in it reaches; `node:fs` and `fs` are the same module.
""")

code("""
need = Counter()
for r in plain[plain.cause == "node built-in"].itertuples():
    need.update({e["text"].removeprefix("node:").split("/")[0] for e in r.bundle_errors if e["kind"] == "node-builtin"})
pd.DataFrame(need.most_common(15), columns=["built-in", "packages that reach it"]).set_index("built-in")
""")

code("""
only = Counter()
for r in plain[plain.cause == "node built-in"].itertuples():
    mods = {e["text"].removeprefix("node:").split("/")[0] for e in r.bundle_errors if e["kind"] == "node-builtin"}
    if len(mods) == 1:
        only.update(mods)
print(f"{sum(only.values())} of {int((plain.cause == 'node built-in').sum())} built-in failures reach exactly one built-in:")
pd.DataFrame(only.most_common(10), columns=["the one built-in", "packages"]).set_index("the one built-in")
""")

md("""
Whether a failure is the package's purpose or an accident of where it was written: a built-in is **OS-bound** when it
is a door to the machine (a filesystem, a process, a socket, the terminal, the module loader), and **portable**
otherwise (`path`, `buffer`, `util`, `events`, `url`, `assert`, `stream`, …, each of which has a browser
implementation on npm). A package is counted under OS-bound if any built-in it reaches is.
""")

code("""
OS_BOUND = {"fs", "child_process", "net", "http", "https", "http2", "tls", "dgram", "dns", "cluster", "worker_threads",
            "readline", "tty", "module", "vm", "v8", "inspector", "repl", "perf_hooks", "async_hooks", "os"}
def mods_of(r):
    return {e["text"].removeprefix("node:").split("/")[0] for e in r.bundle_errors if e["kind"] == "node-builtin"}
bi = plain[plain.cause == "node built-in"].copy()
bi["reach"] = bi.apply(lambda r: "OS-bound" if mods_of(r) & OS_BOUND else "portable only", axis=1)
split = bi.reach.value_counts()
print(split.to_string())
bi[bi.reach == "portable only"].assign(builtins=lambda d: d.apply(lambda r: ", ".join(sorted(mods_of(r))), axis=1))[["rank", "name", "builtins"]].sort_values("rank").head(25)
""")

md("""
The single-built-in rows are what a small, honest shim would buy: a `path` written in a few dozen lines of string
handling is a different thing from a fake `fs`, which would only move the failure from the bundle to the first call.
""")

code("""
ev = plain[plain.stage == "eval"]
ev[["rank", "name", "cause", "eval_error"]].assign(eval_error=ev.eval_error.str.slice(0, 110)).sort_values("rank")
""")

md("""
## Can the manifest and the source tell, before installing?

The static candidate: the package loads if no Node built-in is reachable from its entry or any dependency's entry
(`closure_builtins_entry` empty), and nothing in the closure is native. The scan is a regex over the source, so a
`require("fs")` behind a runtime check counts, and a computed `require(name)` does not.
""")

code("""
j = plain.merge(static[["name", "closure_builtins_entry", "closure_native", "has_browser_condition", "deps_closure_size", "closure_unscanned"]], on="name", how="left")
j["static_yes"] = j.closure_builtins_entry.map(lambda b: isinstance(b, list) and not b) & ~j.closure_native.fillna(False).astype(bool)
fair = j[~j.cause.isin(["probe", "undeclared dep"])]
cm = pd.crosstab(fair.static_yes.map({True: "static: yes", False: "static: no"}), fair.cause == "ok").rename(columns={True: "loads", False: "does not"})
yes = fair[fair.static_yes]
P = pd.Series({"says yes": len(yes), "precision": (yes.cause == "ok").mean(), "recall": fair[fair.cause == "ok"].static_yes.mean()})
cm, P.to_frame("static verdict").T.style.format({"precision": "{:.1%}", "recall": "{:.1%}"})
""")

code("""
surprise = fair[fair.static_yes != (fair.cause == "ok")]
surprise[["rank", "name", "static_yes", "cause", "closure_builtins_entry", "has_browser_condition"]].sort_values("rank").head(30)
""")

md("""
A `browser` field or a `browser` export condition, which a reader might take as the signal, says less than the scan:
""")

code("""
pd.crosstab(fair.has_browser_condition.fillna(False).map({True: "declares a browser build", False: "does not"}), fair.cause == "ok", margins=True).rename(columns={True: "loads", False: "does not"})
""")

md("""
## Python and npm, side by side

The same top-1,000 question for both runtimes: what loads, and what the rest fail on. The Python column is
pypi-compat's install probes (micropip, then import, on the restricted core); probe artefacts and undeclared
dependencies are left out of the denominator on both sides.
""")

code("""
PY = pd.DataFrame(pypi_rows := json.loads((wmlnb.ROOT / "notebooks/python-packages/data/pypi-compat/installs.json").read_text())["rows"])
py_env = json.loads((wmlnb.ROOT / "notebooks/python-packages/data/pypi-compat/env.json").read_text())["rows"][0]
LOCK = {pypi.canonicalize_name(k) for k in py_env["lock"]}
PY["cause"] = [("ok" if r["stage"] == "ok" else pypi.cause(r, LOCK)) for r in pypi_rows]
py_group = {"ok": "loads", "no build": "no build for the runtime", "platform": "runtime lacks it (platform, Node)",
            "version": "versions / resolver", "extra": "versions / resolver", "probe": "(excluded) probe artefact",
            "undeclared host": "(excluded) undeclared dependency"}
js_group = {"ok": "loads", "no build": "no build for the runtime", "node built-in": "runtime lacks it (platform, Node)",
            "node global": "runtime lacks it (platform, Node)", "isolation": "runtime lacks it (platform, Node)",
            "probe": "(excluded) probe artefact", "undeclared dep": "(excluded) undeclared dependency"}
side = pd.DataFrame({"Python (pypi-compat)": PY.cause.map(lambda c: py_group.get(c, "other")).value_counts(),
                     "npm (this notebook)": plain.cause.map(lambda c: js_group.get(c, "other")).value_counts()}).fillna(0).astype(int)
counted = side.loc[[i for i in side.index if not i.startswith("(excluded)")]]
side.loc["loads, of those counted"] = (counted.loc["loads"] / counted.sum()).map("{:.0%}".format)
side
""")

code("""
from IPython.display import Markdown
ok, n = int((plain.cause == "ok").sum()), len(plain)
ok_s = int((shims.cause == "ok").sum())
b = {label: plain[plain["rank"].map(band) == label] for _, _, label in BANDS}
nb_ = int((plain.cause == "node built-in").sum())
fail = plain[~plain.cause.isin(["ok", "probe", "undeclared dep"])]
loads = fair[fair.cause == "ok"]
no_browser = int((~loads.has_browser_condition.fillna(False).astype(bool)).sum())
lines = [
    "## Conclusion",
    "",
    f"- **{ok} of the top {n:,} npm packages load** in a Worker with no Node built-ins: "
    + ", ".join(f"{(d.cause == 'ok').mean():.0%} of ranks {k}" for k, d in b.items())
    + f". Defining `global` and `process.env.NODE_ENV` adds {ok_s - ok}; nothing else is shimmed.",
    f"- **A Node built-in is {nb_ / len(fail):.0%} of the residual**: {nb_} of the {len(fail)} packages that do not "
    f"load (probe artefacts aside) stop at the bundle on one. {split.get('OS-bound', 0)} of those reach a door to "
    "the machine (`fs`, `child_process`, a socket, the terminal), such as `glob`, `cross-spawn`, `eslint` and `express`: "
    f"work the shell (`ml.sh`) does instead. The other {split.get('portable only', 0)} reach only portable "
    "built-ins (`path`, `buffer`, `util`, …), so a browser implementation of those would get them past the bundle (not measured further).",
    f"- **The static check is usable as the card's verdict**: no built-in reachable in the closure is right "
    f"{P['precision']:.1%} of the times it says yes and says yes to {P['recall']:.1%} of what loads. A declared "
    f"`browser` build is not the signal: {no_browser} of the {len(loads)} packages that load declare none.",
    "- **What the install needs differs from Python**: npm resolves and fetches the closure itself, so the install "
    "step is `npm install --ignore-scripts` plus one bundle, and the artefact to pin is the bundle (one file), not a "
    "set of wheels. No install script may run: the sandbox is the only thing between a package and the machine.",
    "- **Evaluation is the bar measured**, not use; and the page was not cross-origin isolated, so the "
    f"{int((plain.cause == 'isolation').sum())} `SharedArrayBuffer` failures may load on an extension page that is.",
]
Markdown("\\n".join(lines))
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "npm-compat.ipynb")
print("wrote", HERE / "npm-compat.ipynb")
