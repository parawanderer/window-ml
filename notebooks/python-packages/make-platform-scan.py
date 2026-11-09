"""make-platform-scan.py — builds platform-scan.ipynb: can the platform limits no wheel tag carries (processes,
threads, `resource`, a system shared library) be found in a package's source before it is imported, and how often
would such a check call a working package broken?

    .venv/bin/python notebooks/python-packages/make-platform-scan.py && node scripts/nb.mjs run notebooks/python-packages/platform-scan.ipynb
    (or: node scripts/nb.mjs make notebooks/python-packages/platform-scan.ipynb)

The cells are written here; edit this file, not the notebook. It scores scan.py against the install probes that
pypi-compat.ipynb pinned (data/pypi-compat/), and pins two inputs of its own in data/platform-scan/: what the core
lacks (probe.mjs core) and the scan's rows (scan.py over the wheels each probe installed). NB_REFRESH=1 reads both
again: about 1 GB of wheels from PyPI and the Pyodide CDN into PYPKG_SCAN_CACHE (default: the system temp dir), then
a few minutes of parsing.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Can a platform limit be found before the import?

`pypi-compat.ipynb` found that a verdict computed from wheel tags, the dependency closure and the lock's versions is
right 96.4% of the times it says a package will work. Most of what it gets wrong is the core's PLATFORM: code that
starts a process or a thread, imports `resource`, or loads a system library, none of which a tag records. The
question here: can those be marked in advance, as a rule the install step applies, or only as a list?

The candidate rule reads the wheels' source (`scan.py`): Python's `ast` over every module, nothing executed. It follows
what runs at IMPORT, because import is where the probes failed: module bodies, class bodies, decorators and default
arguments, and, to a chosen depth, the package's own functions those call. It skips a `try` that handles the failure,
skips an `if TYPE_CHECKING:` or `if __name__ == "__main__":` block, and evaluates the platform tests the way the core would (`sys.platform`,
`os.name`, `platform.system()`, `sys.version_info`, `hasattr(select, "epoll")` against the measured attributes).

It is scored against the 1,000 probes: each project installed in a fresh interpreter and imported.
""")

code("""
import json, os, subprocess, sys, tempfile
from collections import Counter
from pathlib import Path
import pandas as pd
import wmlnb
sys.path.insert(0, str(wmlnb.ROOT / "notebooks" / "python-packages"))
import pypi, scan

HERE = wmlnb.ROOT / "notebooks" / "python-packages"
COMPAT, DATA = HERE / "data" / "pypi-compat", HERE / "data" / "platform-scan"
DIST = json.loads((wmlnb.ROOT / "tools" / "pyodide-dist.json").read_text())
CACHE = Path(os.environ.get("PYPKG_SCAN_CACHE") or Path(tempfile.gettempdir()) / "window-ml-pypkgs-scan")
DEPTHS = (0, 1, 2, 3)
pd.set_option("display.width", 160)
pd.set_option("display.max_colwidth", 100)

def pinned(name):
    def refuse():
        raise RuntimeError(f"{name} belongs to pypi-compat.ipynb: refresh that notebook first")
    # NB_REFRESH re-reads this notebook's own inputs; pypi-compat's are only read, never refreshed from here
    return wmlnb.extract(COMPAT / name, refuse, source={}, refresh_env="PYPKG_COMPAT_REFRESH_UNUSED")

ENV, installs, static = pinned("env.json")[0], pinned("installs.json"), pinned("static.json")[1:]

def core_probe():
    out = subprocess.run(["node", "notebooks/python-packages/probe.mjs", "core"], cwd=wmlnb.ROOT, capture_output=True, text=True, check=True)
    return [json.loads(out.stdout)]

CORE = wmlnb.extract(DATA / "core.json", core_probe, source={"probe": "probe.mjs core", "core": DIST["artefact"]["name"]})[0]
scan.set_core(CORE, set(CORE["bad"]))

def scan_rows():
    env = ENV | {"cdn": f"https://cdn.jsdelivr.net/pyodide/v{DIST['pyodide']}/full/"}
    rows = scan.scan_installs(installs, env, set(CORE["bad"]), CACHE, depths=DEPTHS)
    for r in rows:
        for h in r["hits"]:
            h["chain"] = h["chain"][-4:]
    return rows

rows = pd.DataFrame(wmlnb.extract(DATA / "scan.json", scan_rows, source={"scan": "scan.py over the wheels installs.json installed", "depths": list(DEPTHS), "core": DIST["artefact"]["name"]}))
pd.DataFrame(wmlnb.provenance(COMPAT / "env.json", COMPAT / "installs.json", COMPAT / "static.json", DATA / "core.json", DATA / "scan.json"))
""")

md("""
## What the core lacks, measured

Every stdlib module and submodule was imported in the core, and each call below was made in it. These two tables are
the scan's whole knowledge of the platform; nothing in it is assumed.
""")

code("""
relevant = {m: e for m, e in CORE["bad"].items()
            if not m.split(".")[0].lstrip("_").startswith(("win", "msvcrt", "nt", "aix", "android", "apple", "ios", "osx", "scproxy", "wmi", "overlapped", "tkinter", "curses", "turtle", "idlelib", "pydoc_data", "ensurepip", "venv"))
            and "win32 only" not in e and not m.startswith("encodings.")}
print(f"{len(CORE['bad'])} of {CORE['n_stdlib']} stdlib modules fail to import; those a package on Linux might reach:")
pd.DataFrame({"error": relevant}).rename_axis("module")
""")

code("""
pd.DataFrame({"result in the core": CORE["calls"]}).rename_axis("call")
""")

md("""
Processes, `os.fork`, starting a thread and every `multiprocessing` primitive fail; a named shared library is never
there (`find_library` returns `None`, `CDLL(name)` raises). Sockets, `signal`, `os.system` (it returns an error
code), `CDLL(None)` and constructing a `multiprocessing.Process` all work, so the scan does not count them.
""")

md("""
## The scan against the probes

Each probed project that installed gets the probe's verdict (pypi-compat's `cause()`) and the scan's. "naive" is
the rule a reader would write first: the closure mentions a platform module (`subprocess`, `threading`, `ctypes`,
`socket`, …) anywhere.
""")

code("""
LOCK = {pypi.canonicalize_name(k) for k in ENV["lock"]}
by_project = {r["project"]: r for r in installs}
rows["cause"] = rows.project.map(lambda p: "ok" if by_project[p]["stage"] == "ok" else pypi.cause(by_project[p], LOCK))
rows["flag"] = rows.n_hits > 0
rows["naive_flag"] = rows.naive.map(bool)
d0 = rows[rows.depth == 0]
t = pd.DataFrame({"projects": d0.cause.value_counts(), "naive flags": d0.groupby("cause").naive_flag.sum()})
for d in DEPTHS:
    t[f"scan, depth {d}"] = rows[rows.depth == d].groupby("cause").flag.sum()
t.fillna(0).astype(int).sort_values("projects", ascending=False)
""")

md("""
Depth is how many calls into the package's own functions the scan follows from a module body (0: the bodies only).
The naive rule finds every platform failure and also flags most of the packages that work, which makes it useless as
a verdict. The import-time scan flags almost nothing that works. Following one call finds more failures for no new
false positive; a second call finds one more failure (`pip-api`) and three new false positives, all `django`'s
`get_version`, which runs `git` only for an alpha release. A function's body branches on values the scan does not
know, so each level deeper reads more code that never runs.
""")

code("""
DEPTH = 1
at = rows[rows.depth == DEPTH].set_index("project")
def show(h):
    return f"{h['kind']}: {h['what']} in {h['in']}"
def error(p):
    bad = [i for i in by_project[p].get("imports") or [] if not i["ok"]]
    return (bad[0]["error"] if bad else by_project[p].get("error", ""))[:110].replace("\\n", " ")
plat = at[at.cause == "platform"]
pd.DataFrame({"scan flags it": plat.flag, "what the scan found": plat.hits.map(lambda hs: show(hs[0]) if hs else ""),
              "what the probe hit": plat.index.map(error)})
""")

md("""
The fourteen are fewer causes than packages: `pexpect` fails through `ptyprocess`, `trio-websocket` through `trio`,
`cairosvg` through `cairocffi`. What the scan misses at depth 1, and why:

- **pip-api** runs `pip` two calls from its module body (`version()` → `_call.call` → `subprocess`): depth 2 finds it.
- **gitpython** runs `git` from a module-level `refresh()` through `Git.refresh` → `cls().version()`, where `version`
  exists only through `__getattr__`: dynamic dispatch, which no depth reaches.
- **python-magic** tries each library name in a guarded loop and raises after the loop; the guard is right, the
  `raise` in the loop's `else` is the failure.
- **py-cpuinfo** compares `platform.machine()`'s result, through a parser, with a list of CPU names.
- **posthog** reads an attribute urllib3's emscripten connection class does not define.
- **opentelemetry-distro** starts its thread from a class body: a dataclass field's default,
  `Resource.create({})` (`sdk/_logs/_internal/__init__.py:281`), reaches `get_aggregated_resources`, which builds a
  `concurrent.futures.ThreadPoolExecutor` into a local and calls `submit` on it (`sdk/resources/__init__.py:750-752`).
  The core fails that `submit`; the scan lists no `concurrent.futures` call, and would not know the local's type if
  it did.

Apart from pip-api's depth and opentelemetry's executor, each is a fact about a VALUE at run time or a dynamic
dispatch, not a construct in the source.
""")

code("""
fp = at[(at.cause == "ok") & at.flag]
pd.DataFrame({"what the scan found": fp.hits.map(lambda hs: show(hs[0]))})
""")

md("""
Both false positives are one cause: joblib imports `_multiprocessing` inside a `try` in one module, sets `mp = None`
when that fails, and every later module tests `if mp is not None:` before reaching the missing parts. Following that
needs the value of a name across modules, which a scan of constructs does not track.
""")

md("""
## What the scan adds to the verdict

The verdict pypi-compat scored (tags, closure, version ranges), with the scan applied on top: a project it flags is
no longer a "yes". Probe artefacts and undeclared host packages are left out of both sides, as there.
""")

code("""
st = pd.DataFrame(static).set_index("project")
pr = at.join(st[["installable"]], how="inner")
fair = pr[~pr.cause.isin(["probe", "undeclared host"])]
def score(yes):
    y = fair[yes]
    return pd.Series({"says yes": len(y), "of those, fail": int((y.cause != "ok").sum()),
                      "of those, platform": int((y.cause == "platform").sum()),
                      "precision": (y.cause == "ok").mean(), "recall": yes[fair.cause == "ok"].mean()})
S = pd.DataFrame({"tags + ranges": score(fair.installable), "tags + ranges + scan": score(fair.installable & ~fair.flag)}).T
S.style.format({"precision": "{:.1%}", "recall": "{:.1%}"})
""")

md("""
The recall here is over the projects that installed (the scan needs the wheels), so it is not pypi-compat's 99.2%;
the change between the two rows is what the scan costs.
""")

code("""
from IPython.display import Markdown
a, b = S.iloc[0], S.iloc[1]
missed = [p for p in plat.index[~plat.flag]]
caught = int(plat.flag.sum())
per_depth = {d: (int(((rows.depth == d) & (rows.cause == "platform") & rows.flag).sum()),
                 int(((rows.depth == d) & (rows.cause == "ok") & rows.flag).sum())) for d in DEPTHS}
lines = [
    "## Conclusion",
    "",
    f"- **A rule, one call deep.** Scanning what runs at import, one call into the package's own functions, finds "
    f"{caught} of the {len(plat)} platform failures among the 1,000 probes, and calls {len(fp)} working packages broken "
    f"({', '.join(fp.index)}, one cause). Were it a refusal, it would move precision from {a.precision:.1%} to "
    f"{b.precision:.1%} and recall from {a.recall:.1%} to {b.recall:.1%}.",
    "- **So it is a note, not a refusal**: the recall it would cost is working flagship packages. The import still "
    "runs; when it fails, the scan's finding (which module or call the core lacks) is the reason given, in place of a "
    "traceback; when it succeeds the finding costs nothing.",
    f"- **What it misses ends as it does today**, in a failed import: {', '.join(missed)}. All but pip-api (two calls "
    "deep) turn on a run-time value or a dynamic dispatch, which no scan of constructs sees.",
    f"- **The naive rule is not usable**: mentioning a platform module flags {int(at[at.cause == 'ok'].naive_flag.sum())} "
    f"of the {int((at.cause == 'ok').sum())} packages that work.",
    "- **It runs after the download, before the import.** It reads the wheels, so it cannot sit on the approval card "
    "the way the tag verdict can; it fits the install step, between unpacking and the first import, and it needs only "
    "`ast`, which the core has. Its two tables (the stdlib modules that fail, the calls that fail) are measured from the "
    "core by `probe.mjs core`, so they move with the pin.",
    "- **The depth is a trade, measured**: " + "; ".join(f"depth {d} finds {c} and calls {f} working packages broken"
    for d, (c, f) in per_depth.items()) + ". Depth 1 is the cheapest point with no false positive beyond depth 0's; "
    "the top-10k probe is the sample that would settle it.",
]
Markdown("\\n".join(lines))
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "platform-scan.ipynb")
print("wrote", HERE / "platform-scan.ipynb")
