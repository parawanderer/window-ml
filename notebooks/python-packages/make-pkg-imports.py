"""make-pkg-imports.py — builds pkg-imports.ipynb: what happens when EVERY module of the 725 PyPI projects that loaded
on the restricted core is imported, not only the top-level one.

    .venv/bin/python notebooks/python-packages/make-pkg-imports.py && node scripts/nb.mjs run notebooks/python-packages/pkg-imports.ipynb
    (or: node scripts/nb.mjs make notebooks/python-packages/pkg-imports.ipynb)

The cells are written here; edit this file, not the notebook. The measurement was run on mlbox, not here
(probe-all.mjs under drive.py in a network-limited container, 2026-11-12), so the inputs come from another machine:
NB_REFRESH=1 with PKG_IMPORTS_SRC set to a folder holding the report (`pkg-imports-answer.md` and `pkg-imports/`
from slop-zone's reports/ui-api/) re-reads them; summary.jsonl is checked against its sha256 first. The raw
per-project event files (raw.tar.gz) are not copied: they live in slop-zone commit 27fc603 (the rerun in d075ad2).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Every module of the 725 loading projects, imported on the core

`pypi-compat.ipynb` installed the top 1,000 projects with micropip and imported each project's top-level module; 725
of them reached stage `ok`. That probe says whether a package LOADS. It does not say how much of the package works,
because most modules are never imported by the top-level one. This notebook reads the run that imported every module
each of those 725 projects ships (`probe-all.mjs`, driven by `drive.py`): the module list is the project's own
RECORD (`.py` files and `.so` extension modules, without `tests/`, `__main__`, `conftest`), imported one at a time in
a fresh interpreter per project, on the restricted core pinned in `tools/pyodide-dist.json`.

The run was on mlbox, in a docker container whose only route out was an allowlist proxy (pypi.org,
files.pythonhosted.org, cdn.jsdelivr.net), 12 workers, 900 s per project. Nothing below is typed: every figure in the
prose is printed by the cell above it.

Questions: how many projects import completely, what the failures are, which of them are the package's own and which
are an optional dependency that was not installed, what the one crash was, and whether any import reached for the
network.
""")

code("""
import json, os, re, sys
from collections import Counter
from pathlib import Path
import pandas as pd
import wmlnb
from IPython.display import Markdown, display

HERE = wmlnb.ROOT / "notebooks" / "python-packages"
DATA = HERE / "data" / "pkg-imports"
DIST = json.loads((wmlnb.ROOT / "tools" / "pyodide-dist.json").read_text())
SUMMARY_SHA256 = "53f343915702b8094a6d87e2236289249beb894febde71594d590f364ae4fa1e"
pd.set_option("display.width", 170)
pd.set_option("display.max_colwidth", 110)
pd.set_option("display.max_rows", 200)

def src_dir():
    d = os.environ.get("PKG_IMPORTS_SRC")
    if not d:
        raise RuntimeError("PKG_IMPORTS_SRC: the folder with pkg-imports-answer.md and pkg-imports/ (slop-zone reports/ui-api)")
    return Path(d)

def read_summary():
    p = src_dir() / "pkg-imports" / "summary.jsonl"
    if wmlnb.sha256_file(p) != SUMMARY_SHA256:
        raise RuntimeError("summary.jsonl is not the file this notebook was written for")
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]

def read_proxy():
    return (src_dir() / "pkg-imports" / "rerun-proxy.log").read_text().splitlines()

def read_events():
    out = []
    for l in (src_dir() / "pkg-imports" / "rerun-huggingface-hub.ts.jsonl").read_text().splitlines():
        t, _, rest = l.partition(" ")
        if not rest.startswith("{"):   # the harness' own "EOF" marker line
            continue
        out.append({"t": t, **json.loads(rest)})
    return out

def read_answer():
    return [(src_dir() / "pkg-imports-answer.md").read_text()]

SRC = {"measured_on": "mlbox, 2026-11-12", "core": DIST["artefact"]["name"], "raw": "slop-zone 27fc603 (rerun: d075ad2)"}
rows = wmlnb.extract(DATA / "summary.json", read_summary, source=SRC | {"file": "pkg-imports/summary.jsonl", "sha256": SUMMARY_SHA256})
proxy = wmlnb.extract(DATA / "rerun-proxy.json", read_proxy, source=SRC | {"file": "pkg-imports/rerun-proxy.log"})
events = wmlnb.extract(DATA / "rerun-events.json", read_events, source=SRC | {"file": "pkg-imports/rerun-huggingface-hub.ts.jsonl"})
answer = wmlnb.extract(DATA / "answer.json", read_answer, source=SRC | {"file": "pkg-imports-answer.md"})[0]
pd.DataFrame(wmlnb.provenance(DATA / "summary.json", DATA / "rerun-proxy.json", DATA / "rerun-events.json", DATA / "answer.json"))
""")

md("""
## Outcomes
""")

code("""
df = pd.DataFrame(rows)
ok = df[df.stage == "ok"]
n_all, n_clean, n_some = len(df), int((ok.failed == 0).sum()), int((ok.failed > 0).sum())
n_crash = int((df.stage == "crash").sum())
n_mod, n_fail = int(ok.modules.sum()), int(ok.failed.sum())
trunc = list(df[df.truncated == True].spec)
display(pd.DataFrame({"projects": {"every module imported": n_clean, "installed, some modules failed": n_some,
                                   "stage crash (no done line)": n_crash, "total": n_all}}))
Markdown(f"Modules attempted: {n_mod}; failed: {n_fail} ({n_fail / n_mod:.1%}). Truncated at the 5,000-module cap: {', '.join(trunc)}. "
         f"Stages: {df.stage.value_counts().astype(int).to_dict()}.")
""")

md("""
## Failures by error type
""")

code("""
fl = pd.DataFrame([{"spec": r["spec"], **f} for r in rows if r.get("failures") for f in r["failures"]])
fl["error"] = fl.error.fillna("")
by_type = fl.groupby("error_type").agg(failed_imports=("m", "size"), projects=("spec", "nunique")).sort_values("failed_imports", ascending=False)
top = by_type.head(10)
other = by_type.iloc[10:]
if len(other):
    top = pd.concat([top, pd.DataFrame({"failed_imports": [other.failed_imports.sum()], "projects": [None]}, index=[f"(other {len(other)} types)"])])
top
""")

code("""
t = ok.set_index("spec")
t.assign(**{"failed / modules": t.failed.astype(int).astype(str) + " / " + t.modules.astype(int).astype(str)}).sort_values("failed", ascending=False).head(10)[["failed / modules"]]
""")

code("""
df.sort_values("wall_s", ascending=False).head(5)[["spec", "wall_s"]].reset_index(drop=True)
""")

md("""
## What kind of failure: the lane's classification

Each failed import gets one kind from its error alone:

- `ModuleNotFoundError` naming a module of the standard library: **stdlib-missing** (`pwd`, `grp`, `resource`,
  `_multiprocessing`, `tkinter`: the core lacks them, a platform limit);
- `ModuleNotFoundError` naming the module being imported itself: **own-module** (a `.so` or a file the RECORD lists
  but the install does not hold);
- `ModuleNotFoundError` naming anything else: **optional-dep**, a dependency that was not installed (the probe installs
  the project and its REQUIRED closure, not its extras);
- an `ImportError` that says `cannot import name`, `requires` or `install`: **optional-dep-ish**;
- everything else: **other**.

A project whose failures are all optional-dep or optional-dep-ish fails ONLY on optional dependencies.
""")

code("""
STD = set(sys.stdlib_module_names)
def kind(f):
    et, err, m = f["error_type"], f["error"] or "", f["m"]
    if et == "ModuleNotFoundError":
        g = re.search(r"No module named '([^']+)'", err)
        name = g.group(1).split(".")[0] if g else "?"
        if name in STD: return "stdlib-missing", name
        if name == m.split(".")[0]: return "own-module", name
        return "optional-dep", name
    if et == "ImportError" and ("cannot import name" in err or "requires" in err.lower() or "install" in err.lower()):
        return "optional-dep-ish", None
    return "other", None
fl[["kind", "missing"]] = fl.apply(lambda f: pd.Series(kind(f)), axis=1)
per_proj = fl.groupby("spec").kind.agg(set)
only_opt = int(per_proj.map(lambda k: k <= {"optional-dep", "optional-dep-ish"}).sum())
n_with = len(per_proj)
display(fl.groupby("kind").agg(failed_imports=("m", "size"), projects=("spec", "nunique")).sort_values("failed_imports", ascending=False))
Markdown(f"{n_with} projects have a failure; {only_opt} fail ONLY on optional dependencies (optional-dep or optional-dep-ish), "
         f"{n_with - only_opt} have a failure of some other kind.")
""")

code("""
miss = fl[fl.kind.isin(["optional-dep", "stdlib-missing"])].groupby(["kind", "missing"]).agg(failed_imports=("m", "size"), projects=("spec", "nunique"))
pd.concat([miss.loc[k].sort_values("failed_imports", ascending=False).head(12).assign(kind=k).set_index("kind", append=True) for k in ("optional-dep", "stdlib-missing")])
""")

md("""
The projects with a failure of another kind, by what the failure says. A project counts under every reason it has.
""")

code("""
OTHER_OS = re.compile(r"winreg|_winapi|msvcrt|windll|WindowsError|_overlapped|win32|/System/Library|Security\\.framework", re.I)
def reason(f):
    k, name, err = f["kind"], f["missing"], f["error"]
    if k == "stdlib-missing":
        return "another OS (windows, macOS)" if name in ("winreg", "msvcrt", "_winapi", "nt", "_overlapped") else "platform limit: " + name
    if OTHER_OS.search(err) or OTHER_OS.search(f["m"]): return "another OS (windows, macOS)"
    if f["error_type"] == "SystemExit": return "CLI module exits at import (SystemExit)"
    if "processes" in err or "start new thread" in err: return "platform limit: processes / threads"
    if f["error_type"] in ("ImproperlyConfigured", "ZoneInfoNotFoundError", "LibraryNotFoundError", "DidNotEnable"): return "needs configuration, data or a system library: " + f["error_type"]
    if k == "own-module": return "own module missing from the install"
    if k.startswith("optional-dep"): return "(optional dependency)"
    return "other: " + f["error_type"]
fl["reason"] = fl.apply(reason, axis=1)
not_opt = set(per_proj[per_proj.map(lambda k: not k <= {"optional-dep", "optional-dep-ish"})].index)
sub = fl[fl.spec.isin(not_opt) & (fl.reason != "(optional dependency)")]
display(Markdown(f"{len(not_opt)} projects, {len(sub)} failed imports not counting their optional-dependency failures."))
sub.groupby("reason").agg(failed_imports=("m", "size"), projects=("spec", "nunique")).sort_values("projects", ascending=False).head(25)
""")

md("""
## Front-door failures

A module is a front door when its dotted name has at most two parts and none starts with an underscore
(`gunicorn.util`, `joblib.pool`, not `pkg._impl.sub`). These are the imports a user would write. Optional-dep failures
are left out, since a user who has not installed the extra does not expect the module; what remains is a front door
that fails for another reason.
""")

code("""
is_front = (fl.m.str.count(r"\\.") <= 1) & ~fl.m.str.split(".").map(lambda ps: any(p.startswith("_") for p in ps))
front = fl[is_front & (fl.kind != "optional-dep")]
n_front, n_front_p = len(front), front.spec.nunique()
display(Markdown(f"{n_front} front-door failures that are not an uninstalled optional dependency, in {n_front_p} projects."))
display(front.groupby("reason").agg(failures=("m", "size"), projects=("spec", "nunique")).sort_values("failures", ascending=False).head(15))
front.assign(error=front.error.str.replace("\\n", " ", regex=False).str[:90])[["spec", "m", "error_type", "error"]].reset_index(drop=True)
""")

md("""
## The crash

One project never reached its `done` line: the Node process exited. `drive.py` records which module had started and not
finished (`died_in`) and the last 400 characters of stderr. For a wasm trap that tail is all stack frames, so the
cause was read from a solo rerun (quoted in the report, pinned here as `answer.json`). `drive.py` now also keeps the
first 400 characters (`stderr_head`); this run's rows predate that field.
""")

code("""
crash = df[df.stage == "crash"].iloc[0]
cause = re.search(r"fatal error\\. Please report this to the Pyodide maintainers\\.\\nThe cause of the fatal error was:\\n(.+)", answer)
tail = crash.stderr_tail.strip().splitlines()
display(Markdown(f"`{crash.spec}`: died importing `{crash.died_in}` ({crash.wall_s} s into the project). Cause from the solo rerun: `{cause.group(1)}`."))
print("stderr_tail as recorded (its last lines):")
print("\\n".join(tail[-4:]))
""")

md("""
## The network attempt

The proxy refused one `CONNECT huggingface.co:443` in the 725-project run, with 12 workers, so it could not be
attributed to a project. The lane asked for `huggingface-hub` alone, one worker, with the proxy log and the probe's
stdout both timestamped to the millisecond. The cells line the refusal up with the probe's events.
""")

code("""
deny = [l for l in proxy if "DENY" in l]
t_deny = deny[0].split()[0]
ev = pd.DataFrame(events)
secs = lambda t: pd.Timestamp("2000-01-01 " + t)
ev["dt_ms_from_deny"] = ev.t.map(lambda t: round((secs(t) - secs(t_deny)).total_seconds() * 1000))
near = ev[ev.dt_ms_from_deny.abs() <= 150][["t", "dt_ms_from_deny", "ev", "m", "ok", "s"]]
display(Markdown("Proxy log:\\n\\n```\\n" + "\\n".join(proxy) + "\\n```"))
display(Markdown(f"{len(deny)} refusal(s): `{deny[0]}`. The probe's events within 150 ms of it:"))
near.reset_index(drop=True)
""")

code("""
imp = ev[ev.ev == "import"]
last_start = ev[(ev.ev == "start") & (ev.dt_ms_from_deny <= 0)].iloc[-1]
the_import = imp[imp.m == last_start.m].iloc[0]
allowed = [l for l in proxy if "ALLOW" in l]
Markdown(f"The last import started before the refusal is `{last_start.m}` (started {-last_start.dt_ms_from_deny} ms before it); that import "
         f"returned ok={the_import.ok} after {the_import.s} s, {the_import.dt_ms_from_deny} ms after the refusal: the request was made while the import ran, "
         f"and the import did not wait on it. The rerun's proxy log holds {len(allowed)} allowed CONNECTs and {len(deny)} refusal.")
""")

md("## Conclusion")

code("""
top_type = by_type.index[0]
cap = int(df[df.truncated == True].modules.iloc[0])
Markdown("\\n".join([
    f"- **{n_clean} of {n_all} projects import every module** ({n_clean / n_all:.1%}); {n_some} have some failure, {n_crash} crashed the interpreter. "
    f"{n_fail} of {n_mod} modules failed ({n_fail / n_mod:.1%}); the most common error is {top_type} ({by_type.loc[top_type, 'failed_imports']} imports in {by_type.loc[top_type, 'projects']} projects).",
    f"- **{only_opt} of the {n_with} failing projects fail only on optional dependencies** that were not installed; the other {n_with - only_opt} have at least one failure that is the core's platform, another OS's module, a CLI module that exits, or a module needing configuration, data or a system library.",
    f"- **{n_front} front-door failures in {n_front_p} projects** are not an uninstalled extra: those are the ones a user would meet.",
    f"- **The crash is `{crash.spec}`**, importing `{crash.died_in}`: `{cause.group(1)}`, a wasm trap. It takes the interpreter down, so every module after it in the list was never tried; the one-module-per-import record needs the process to be restarted after such a trap.",
    f"- **One import reached for the network** and the allowlist refused it: `{last_start.m}`, whose import succeeded without waiting for the request.",
    f"- **Truncated:** {', '.join(trunc)} hit the {cap}-module cap; its modules beyond it were not tried.",
]))
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "pkg-imports.ipynb")
print("wrote", HERE / "pkg-imports.ipynb")
