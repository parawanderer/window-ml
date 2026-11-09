"""make-pypi-compat.py — builds pypi-compat.ipynb: of the PyPI projects people actually use, which could python_exec
install on demand, and can a static check of the wheel tags tell which before anything is downloaded?

    .venv/bin/python notebooks/python-packages/make-pypi-compat.py && node scripts/nb.mjs run notebooks/python-packages/pypi-compat.ipynb
    (or: node scripts/nb.mjs make notebooks/python-packages/pypi-compat.ipynb)

The cells are written here; edit this file, not the notebook. The inputs are pinned in data/pypi-compat/: the core's
environment (probe.mjs env), the static verdicts (pypi.py, read from PyPI) and the install probes (probe.mjs install,
one fresh interpreter per project), and the top-10,000 probe. NB_REFRESH=1 reads them all again: the 1,000 probes take
~15 minutes and reach PyPI and the Pyodide CDN. PYPKG_CACHE=<dir> keeps PyPI's answers between refreshes while
iterating. The 10,000 take about an hour: queue them first, one test-slot ticket per chunk,

    .venv/bin/python notebooks/python-packages/pypi.py freeze-top 10000 $PYPKG_10K_DIR
    node scripts/test-slot.mjs submit --kind unit -- .venv/bin/python notebooks/python-packages/pypi.py probe-chunk <start> <end> $PYPKG_10K_DIR

for start = 0, 500, ..., 9500; the refresh then reads the chunks (and runs, unqueued, any that are missing).
The cells also write data/pypi-compat/verdicts.json from the 10,000.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Which PyPI packages could `python_exec` install on demand?

The question behind "Packages on demand" (`docs/spec/PYTHON_DIALECT.md`): a model asks for a package, the person
approves, the worker fetches the wheels outside the cell's lockdown and unpacks them. Whether that is worth building
depends on how much of what people use would then work, and whether the approval card can say "this one will not work
here" BEFORE downloading anything.

The runtime is the real one: `pyodide-core/`, the restricted-mode build pinned by `tools/pyodide-dist.json`. Its tags
and marker environment come from that interpreter, not from a table.

1. **Static**: the 2,000 most-downloaded projects, each one's latest release judged by its wheel tags against the
   core's 110 supported tags, with its dependency closure under the core's markers. Projects in the Pyodide lock
   (compiled by Pyodide for this exact ABI) count as installable, as micropip prefers them.
2. **Empirical**: the top 1,000, every one regardless of its static verdict: `micropip.install` in a fresh interpreter,
   then import each module the distribution provides.

Import is the bar measured. A package that imports can still fail when CALLED: sockets (no network inside the cell),
threads, subprocesses, the real filesystem. That is a lower bound on what is broken, and is said so where it matters.
""")

code("""
import json, os, re, subprocess, tempfile
from collections import Counter
from pathlib import Path
import pandas as pd
import wmlnb
import sys
sys.path.insert(0, str(wmlnb.ROOT / "notebooks" / "python-packages"))
import pypi

HERE = wmlnb.ROOT / "notebooks" / "python-packages"
DATA = HERE / "data" / "pypi-compat"
N_STATIC, N_PROBE = 2000, int(os.environ.get("PYPKG_N_PROBE", 1000))  # a smaller N_PROBE only while iterating
CACHE = Path(os.environ["PYPKG_CACHE"]) if os.environ.get("PYPKG_CACHE") else None
DIST = json.loads((wmlnb.ROOT / "tools" / "pyodide-dist.json").read_text())
pd.set_option("display.width", 160)
pd.set_option("display.max_colwidth", 90)

def env_probe():
    out = subprocess.run(["node", "notebooks/python-packages/probe.mjs", "env"], cwd=wmlnb.ROOT, capture_output=True, text=True, check=True)
    return [json.loads(out.stdout)]

ENV = wmlnb.extract(DATA / "env.json", env_probe, source={"probe": "probe.mjs env", "core": DIST["artefact"]["name"]})[0]

def static_rows():
    when, top = pypi.top_projects(N_STATIC)
    return [{"top_list_updated": when}] + pypi.classify(top, ENV, CACHE)

_static = wmlnb.extract(DATA / "static.json", static_rows, source={"top": pypi.TOP_URL, "n": N_STATIC, "pypi": "https://pypi.org/pypi/<project>/json"})
TOP_WHEN, static = _static[0]["top_list_updated"], pd.DataFrame(_static[1:])

def probe_rows():
    names = static[static.in_top].sort_values("rank").project.head(N_PROBE).tolist()
    return pypi.probe_installs(names, wmlnb.ROOT)

probes = pd.DataFrame(wmlnb.extract(DATA / "installs.json", probe_rows, source={"probe": "probe.mjs install", "n": N_PROBE, "core": DIST["artefact"]["name"]}))
pd.DataFrame(wmlnb.provenance(DATA / "env.json", DATA / "static.json", DATA / "installs.json"))
""")

code("""
pd.Series({"python": ENV["python"], "pyodide": DIST["pyodide"], "abi": DIST["abi"], "core": DIST["artefact"]["name"],
           "supported tags": len(ENV["tags"]), "first tags": ", ".join(ENV["tags"][:3]),
           "lock packages": len(ENV["lock"]), "top list updated": TOP_WHEN,
           "projects judged (top + their deps)": len(static)})
""")

md("""
## 1. The static verdict over the top 2,000

`kind` is the latest release's own verdict: `lock` (Pyodide builds it for this ABI), `pure-wheel`
(`py3-none-any` and kin), `wasm-wheel` (a compatible emscripten wheel uploaded to PyPI itself, PEP 783),
`no-wasm-build` (only native wheels for other platforms), `sdist-only` (needs a build, never done in the browser),
`python-version` (`requires_python` excludes 3.14). `installable` also needs every dependency in its closure to pass.
""")

code("""
top = static[static.in_top].copy()
top["band"] = pd.cut(top["rank"], [0, 100, 500, 1000, 2000], labels=["1-100", "101-500", "501-1000", "1001-2000"])
kinds = pd.crosstab(top["kind"], top["band"], margins=True, margins_name="all")
kinds
""")

code("""
def share(g):
    return pd.Series({"projects": len(g), "installable": g.installable.mean(),
                      "installable, download-weighted": (g.installable * g.downloads_30d).sum() / g.downloads_30d.sum()})
top.groupby("band", observed=True).apply(share, include_groups=False).style.format({"installable": "{:.1%}", "installable, download-weighted": "{:.1%}"})
""")

md("""
### What blocks them

A pure-Python project fails statically when something in its closure is compiled with no build here. The few compiled
projects below block a long tail of pure ones, so each is a candidate for a Pyodide build request, not a reason the
feature cannot exist.
""")

code("""
blk = top[(~top.installable) & top.blocked_by.notna()]
blockers = (blk.groupby("blocked_by").agg(blocks=("project", "size"), examples=("project", lambda s: ", ".join(s.head(4))))
               .sort_values("blocks", ascending=False))
blocker_kind = static.set_index("project")["kind"]
blockers["its kind"] = blockers.index.map(lambda b: blocker_kind.get(b, "?"))
blockers.head(15)
""")

md("""
### One wheel per package: the fact a policy matches

A policy names a package by name, version, source and HASH (`docs/spec/POLICIES.md`). That is one pinnable artefact
only when each package in the closure resolves to ONE file under the core's tags. A lock package is one file with its
sha256 in the lock; a PyPI release with several compatible wheels (a pure one and a wasm one, say) leaves micropip a
choice the card would have to show.
""")

code("""
by = static.set_index("project")
def closure_of(p):
    seen, stack = {p}, list(by.at[p, "deps"])
    while stack:
        d = stack.pop()
        if d in seen or d not in by.index:
            continue
        seen.add(d); stack += list(by.at[d, "deps"])
    return seen
def one_file(p):
    r = by.loc[p]
    return r.kind == "lock" or r.n_compatible_wheels == 1
inst = top[top.installable]
pinnable = inst.project.map(lambda p: all(one_file(d) for d in closure_of(p)))
multi = static[(static.n_compatible_wheels.fillna(0) > 1) & (static.kind != "lock")]
pd.Series({"installable (top 2000)": len(inst), "every package in the closure is ONE file": int(pinnable.sum()),
           "packages with >1 compatible wheel (any judged)": len(multi),
           "those, by name": ", ".join(multi.project.head(12))})
""")

md("""
### Placement: what the host could run that the browser cannot

The spec's "Placement" section runs Python at the host too (CPython there, its numpy and pandas pinned to the lock).
A package with no browser build but a wheel for the host is a PLACEMENT fact, not a "does not work". The host is
assumed to be this laptop: CPython 3.14 on macOS arm64 (`pypi.HOST_TAGS`), not read from a running host.
""")

code("""
pd.crosstab(top.installable.map({True: "browser: installable", False: "browser: not"}), top.host.fillna("?"), margins=True)
""")

code("""
host_only = top[~top.installable & top.host.isin(["native", "pure"])].sort_values("rank")
", ".join(host_only.project.head(40))
""")

code("""
nb = top[top.kind.isin(["no-wasm-build", "sdist-only", "python-version"])].sort_values("rank")
nb.groupby("kind").project.apply(lambda s: ", ".join(s.head(25)))
""")

md("""
## 2. The empirical check: install and import the top 1,000

`stage` is where each project stopped: `ok` (installed, every module imported), `import` (installed, some module
raised), `install` (micropip refused or failed), `no-module` (installed, nothing found to import), `timeout`, `crash`.
""")

code("""
pr = probes.merge(top[["project", "rank", "downloads_30d", "kind", "installable", "installable_by_tags", "blocked_by", "blocked_why"]],
                  on="project", how="left")
pr["stage"].value_counts().to_frame("projects")
""")

md("""
### Does the static verdict predict it?

The card would rest on this: rows are the static `installable`, columns what happened. Off-diagonal cells are where
the filter would be wrong, each listed below with why.
""")

code("""
pd.crosstab(pr.installable.map({True: "static: installable", False: "static: not"}), pr.stage, margins=True)
""")

code("""
ok = pr.stage == "ok"
tp = (pr.installable & ok).sum(); fp = (pr.installable & ~ok).sum(); fn = (~pr.installable & ok).sum(); tn = (~pr.installable & ~ok).sum()
pd.Series({"precision (static yes -> imports)": tp / (tp + fp), "recall (imports -> static said yes)": tp / (tp + fn),
           "static no, and indeed fails": tn / (tn + fn)}).map("{:.1%}".format)
""")

code("""
# Static NO, but it installed and imported: micropip found what the tags of the latest release did not show.
surprise = pr[~pr.installable & ok].sort_values("rank")
surprise[["rank", "project", "kind", "blocked_by"]].assign(
    installed=surprise.installed.map(lambda xs: ", ".join(f"{x['name']}=={x['version']} ({x['source']})" for x in xs)[:140])).head(25)
""")

md("""
### Why a project failed, by rule

Every failure of the 1,000 gets ONE cause, decided by the rules below in order, and each cause says whether it
counts against a tag-based filter:

- **version**: micropip refused a version range. A dependency wants a newer version than the lock pins
  (`cryptography>=49` against the lock's 47; `packaging>=26.3` against the 26.1 micropip itself loaded), or two
  dependencies disagree and micropip does not backtrack (`uuid-utils<1.0`). The constraint-aware verdict sees the
  first kind; the second is micropip's.
- **extra**: a dependency asked for an extra (`fastapi[standard]`) whose packages have no build. The static closure
  reads no extras.
- **no build**: a dependency with no wheel for this core.
- **platform**: the code runs into what the core does not have: processes, threads, `resource`, a native shared
  library, a CPU probe, a linux `.so` inside the wheel. A tag cannot show these; only a run can.
- **undeclared host**: the project imports a package it does not declare (an `opentelemetry-instrumentation-*`
  without the library it instruments, a `sphinxcontrib-*` without sphinx). It works once that package is installed:
  not an incompatibility.
- **probe**: the probe's own artefact. It imported a name `top_level.txt` lists that is not a module (`dist`,
  `swagger`), an optional submodule while the main one imported, or found nothing to import (a stub or meta package).
""")

code("""
LOCK = {pypi.canonicalize_name(k) for k in ENV["lock"]}
cause = lambda r: pypi.cause(r, LOCK)

COUNTS = {"version": "no, if the filter reads ranges", "extra": "yes (extras unread)", "no build": "yes",
          "platform": "yes, irreducible for tags", "undeclared host": "no", "probe": "no (the probe's)",
          "timeout": "?", "crash": "?", "install: other": "?", "import: other": "?"}
pr["cause"] = pr.apply(lambda r: "ok" if r.stage == "ok" else cause(r), axis=1)
t = pd.crosstab(pr.cause, [pr.installable_by_tags.map({True: "tags: yes", False: "tags: no"}),
                           pr.installable.map({True: "ranges: yes", False: "ranges: no"})])
t["counts against the filter"] = t.index.map(lambda c: COUNTS.get(c, ""))
t
""")

md("""
**Precision, honestly counted.** A failure the filter could not be blamed for (the probe's own, an undeclared host
package) is removed from both sides; what is left is how often a "yes" on the card would be wrong.
""")

code("""
fair = pr[~pr.cause.isin(["probe", "undeclared host"])]
def prec(col):
    yes = fair[fair[col]]
    return pd.Series({"says yes": len(yes), "of those, fail": int((yes.cause != "ok").sum()),
                      "precision": (yes.cause == "ok").mean(),
                      "recall": (fair[fair.cause == "ok"][col]).mean()})
pd.DataFrame({"by tags only": prec("installable_by_tags"), "by tags + version ranges": prec("installable")}).T.style.format(
    {"precision": "{:.1%}", "recall": "{:.1%}"})
""")

code("""
fails = pr[pr.installable_by_tags & ~ok].copy()
fails["why"] = fails.cause
fails.why.value_counts().to_frame("statically-installable (by tags) projects that failed")
""")

code("""
def detail(r):
    if r.stage == "install":
        return (r.get("error") or "")[:160]
    bad = [i for i in r.imports if not i["ok"]] if isinstance(r.imports, list) else []
    return f"{bad[0]['module']}: {bad[0]['error_type']}: {bad[0]['error'][:110]} @ {bad[0]['where']}" if bad else r.stage
fails.sort_values("rank").assign(detail=fails.apply(detail, axis=1))[["rank", "project", "why", "detail"]].head(40)
""")

md("""
### Import failures across all 1,000, by the module that was missing

A missing stdlib module is a property of the core (Pyodide unvendors some, the restricted fork may drop more); a
missing third-party one is a dependency the metadata did not declare.
""")

code("""
miss = Counter()
for r in pr[pr.stage == "import"].itertuples():
    for i in r.imports:
        if not i["ok"]:
            m = re.search(r"No module named '([^']+)'", i["error"])
            miss[(m.group(1).split(".")[0] if m else f"<{i['error_type']}>")] += 1
pd.Series(miss).sort_values(ascending=False).head(20).to_frame("import failures")
""")

md("""
## 3. What an install costs, for the cache

Wheels fetched per successful install, where they came from (the Pyodide CDN for lock packages, PyPI for the rest),
and the time micropip took in Node (network included, so an upper bound for a warm cache).
""")

code("""
good = pr[ok].copy()
good["n_installed"] = good.installed.map(len)
good["from_pypi"] = good.installed.map(lambda xs: sum(x["source"] == "pypi" for x in xs))
good["from_lock"] = good.n_installed - good.from_pypi
sizes = static.set_index("project").pypi_wheel_bytes
good["pypi_wheel_mb"] = good.project.map(sizes) / 1e6
good[["n_installed", "from_pypi", "from_lock", "install_s", "pypi_wheel_mb"]].describe(percentiles=[.5, .9, .99]).round(2)
""")

code("""
src = Counter(x["source"] for xs in good.installed for x in xs)
pd.Series({"wheels installed, total": sum(src.values()), **{f"from {k}": v for k, v in src.items()},
           "installs needing NO PyPI wheel (lock only)": int((good.from_pypi == 0).sum()),
           "installs pulling >20 MB from PyPI": int((good.pypi_wheel_mb > 20).sum())})
""")

md("""
## 4. The version the lock pins vs PyPI's latest

micropip takes the lock's version of a lock package over a newer PyPI release (`requests` installs 2.33.1 from the
lock while PyPI has 2.34.2). A card that shows a version must show the one that will INSTALL.
""")

code("""
lk = static[(static.kind == "lock") & static.in_top & static.version.notna()]
lag = lk[lk.version != lk.lock_version]
pd.Series({"lock packages in the top 2000": len(lk), "lock version differs from PyPI latest": len(lag)})
""")

code("""
lag.sort_values("rank")[["rank", "project", "lock_version", "version"]].rename(columns={"version": "pypi_latest"}).head(15)
""")

md("""
## 5. The top 10,000, and the verdicts the card reads

The same probe, run over the top 10,000 (a later ranking than section 2's, frozen for the run) in 20 chunks of 500
queued through test-slot (`pypi.py freeze-top` / `probe-chunk`; a refresh reads the chunks under `PYPKG_10K_DIR`).
Each project gets the cause section 2's rules give it. The result is written to `data/pypi-compat/verdicts.json`,
keyed by the core's release tag, so a later core adds a key instead of overwriting these.
""")

code("""
TEN_DIR = Path(os.environ.get("PYPKG_10K_DIR") or Path(tempfile.gettempdir()) / "window-ml-pypi-10k")
_ten = wmlnb.extract(DATA / "probe-10k.json", lambda: pypi.probe_top(10_000, TEN_DIR, wmlnb.ROOT),
                     source={"top": pypi.TOP_URL, "n": 10_000, "probe": "probe.mjs install, 20 chunks of 500", "core": DIST["artefact"]["name"]})
TEN_WHEN, ten = _ten[0]["top_list_updated"], pd.DataFrame(_ten[1:])
pd.DataFrame(wmlnb.provenance(DATA / "probe-10k.json"))
""")

code("""
ten["cause"] = ten.apply(lambda r: "ok" if r.stage == "ok" else cause(r), axis=1)
ten["band"] = pd.cut(ten["rank"], [0, 1000, 2000, 5000, 10_000], labels=["1-1000", "1001-2000", "2001-5000", "5001-10000"])
by_band = pd.crosstab(ten.cause, ten.band, margins=True, margins_name="all")
by_band.loc["loads, share"] = (by_band.loc["ok"] / by_band.loc["all"]).map("{:.0%}".format)
w = ten.groupby("band", observed=True).apply(lambda g: (g.downloads_30d * (g.cause == "ok")).sum() / g.downloads_30d.sum(), include_groups=False)
by_band.loc["loads, download-weighted"] = [f"{x:.0%}" for x in w] + [f"{(ten.downloads_30d * (ten.cause == 'ok')).sum() / ten.downloads_30d.sum():.0%}"]
by_band
""")

md("""
**Does a second run agree?** The two probes share their top 1,000 (by project, not rank: the rankings are a week
apart and PyPI moved in between). A verdict that changed is a release that changed, or a probe that is not
deterministic.
""")

code("""
again = pr[["project", "cause"]].merge(ten[["project", "cause"]], on="project", suffixes=(" (section 2)", " (10k)"))
moved = again[again["cause (section 2)"] != again["cause (10k)"]]
pd.Series({"projects in both": len(again), "same verdict": len(again) - len(moved),
           "moved": "; ".join(f"{r.project}: {r['cause (section 2)']} -> {r['cause (10k)']}" for _, r in moved.iterrows())})
""")

md("""
**Where the undeclared host packages come from.** The long tail is full of families that extend one package: typing
stubs for boto3's services, `types-*` stubs, instrumentations. They import what they extend without declaring it.
""")

code("""
und = ten[ten.cause == "undeclared host"]
def family(p):
    m = re.match(r"(mypy-boto3|types|opentelemetry-instrumentation|sphinxcontrib|django|flake8|pytest|apache-airflow-providers)-", p)
    return m.group(1) + "-*" if m else "(other)"
fam = und.groupby(und.project.map(family)).agg(projects=("project", "size"), first_rank=("rank", "min"), examples=("project", lambda s: ", ".join(s.head(3))))
fam.sort_values("projects", ascending=False)
""")

code("""
TAG = DIST["artefact"]["tag"]
verdicts_path = DATA / "verdicts.json"
allv = json.loads(verdicts_path.read_text()) if verdicts_path.exists() else {}
allv[TAG] = {"core": DIST["artefact"]["name"], "top_list_updated": TEN_WHEN, "n": len(ten),
             "verdicts": pypi.verdicts(_ten[1:], LOCK)}
body = json.dumps(allv, indent=2, sort_keys=True) + "\\n"
if not verdicts_path.exists() or verdicts_path.read_text() != body:
    verdicts_path.write_text(body)
pd.Series(Counter(v["verdict"] for v in allv[TAG]["verdicts"].values())).sort_values(ascending=False).to_frame(f"verdicts.json[{TAG!r}]")
""")

md("""
## What this says for "Packages on demand"

The cell below writes this section from the figures above, so the prose cannot drift from them.
""")

code("""
from IPython.display import Markdown
band = top.groupby("band", observed=True).apply(lambda g: pd.Series({
    "n": g.installable.mean(), "w": (g.installable * g.downloads_30d).sum() / g.downloads_30d.sum()}), include_groups=False)
pc = lambda x: f"{x:.0%}"
P = prec("installable")
yes = pr[pr.installable]
def asked(r):
    m = re.search(r"Requested '([^']+)', but (\\S+) is already installed", r.get("error") or "")
    return f"`{m.group(1)}` against {m.group(2)}" if m else (r.get("error") or "")[:60]
unbacktracked = Counter(asked(r) for _, r in yes[yes.cause == "version"].iterrows())
lock_share = src["pyodide"] / sum(src.values())
not_here = top[~top.installable]
host_ok = not_here.host.isin(["native", "pure"]).sum()
lines = [
    f"Read against `{DIST['artefact']['name']}` (the figures are the cells above):",
    "",
    f"- **Worth building.** Installable by the static verdict: {pc(band.n.iloc[0])} of the top 100 ({pc(band.w.iloc[0])} by "
    f"downloads), {pc(band.n.iloc[1])} of ranks 101-500, {pc(band.n.iloc[3])} of 1001-2000. Of the top {len(pr):,}, "
    f"{int(ok.sum())} installed AND imported in the real core.",
    f"- **The card's 'will this work here' can be decided before downloading**, from PyPI's JSON and the lock: wheel "
    f"tags, the dependency closure under the core's markers, and version ranges checked against the lock (a lock package "
    f"too old for a range blocks only when no release inside the range has a wheel this core accepts; micropip takes the "
    f"newest such release, which is how awscli gets docutils 0.19). Counted fairly (section 2), the verdict is right "
    f"{P['precision']:.1%} of the times it says yes and says yes to {P['recall']:.1%} of what works. What it cannot see: "
    f"platform limits a tag does not carry ({int((yes.cause == 'platform').sum())}: processes, threads, `resource`, native "
    f"shared libraries), micropip not backtracking between two dependencies' ranges "
    f"({int((yes.cause == 'version').sum())}: " + "; ".join(f"{n}x {k}" for k, n in unbacktracked.most_common()) + "), "
    f"and extras ({int((yes.cause == 'extra').sum())}). So the card says 'should work', and the install step still "
    f"reports a failed import as a failure.",
    f"- **Undeclared host packages are a card fact, not a verdict**: {int((pr.cause == 'undeclared host').sum())} plugins "
    f"(`opentelemetry-instrumentation-*`, `sphinxcontrib-*`) import the package they extend without declaring it; the "
    f"card can name it as a second approval.",
    f"- **A policy's hash is one artefact**: {int(pinnable.sum()):,} of the {len(inst):,} installable closures resolve "
    f"to one file per package.",
    f"- **The cache holds lock wheels too**: {lock_share:.0%} of the wheels a successful install fetched came from the "
    f"lock (the Pyodide CDN). The median install fetched {good.n_installed.median():.0f} wheels and "
    f"{good.pypi_wheel_mb.median():.2f} MB from PyPI; the 99th percentile {good.pypi_wheel_mb.quantile(.99):.0f} MB.",
    f"- **The version shown is the one that installs**, usually the lock's: {len(lag)} of the {len(lk)} lock packages in "
    f"the top 2,000 lag PyPI's latest. A package already loaded cannot move at all, so in the extension the start-up "
    f"set pins its versions for every later install.",
    f"- **A few builds unlock a long tail**: `{blockers.index[0]}` alone blocks {int(blockers.blocks.iloc[0])} of the "
    f"top 2,000, then " + ", ".join(f"`{b}`" for b in blockers.index[1:4]) + ".",
    f"- **The host is the other placement**: of the {len(not_here)} projects not installable here, {int(host_ok)} have a "
    f"wheel for a native CPython 3.14 on macOS arm64 (their closure there is not checked).",
    f"- **Over the top {len(ten):,}**, {int((ten.cause == 'ok').sum()):,} install and import "
    f"({(ten.cause == 'ok').mean():.0%}; {(ten.downloads_30d * (ten.cause == 'ok')).sum() / ten.downloads_30d.sum():.0%} "
    f"by downloads), falling from {by_band.loc['loads, share', '1-1000']} of the top 1,000 to "
    f"{by_band.loc['loads, share', '5001-10000']} of ranks 5,001-10,000: no build is "
    f"{int((ten.cause == 'no build').sum()):,} of the failures, and an undeclared host "
    f"{int((ten.cause == 'undeclared host').sum())}, mostly `{fam.projects.idxmax()}`. A second run agrees on "
    f"{len(again) - len(moved)} of the {len(again)} projects both probed. `verdicts.json` holds each one's verdict for "
    f"`{TAG}`, for the card to read.",
    "- **Import is the bar measured**, not use: `requests` installs and imports and still cannot reach the network from "
    "a locked cell. Which calls work is the library manifest's job (`docs/spec/PYTHON_DIALECT.md`).",
]
Markdown("\\n".join(lines))
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "pypi-compat.ipynb")
print("wrote", HERE / "pypi-compat.ipynb")
