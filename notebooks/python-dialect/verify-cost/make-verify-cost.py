"""make-verify-cost.py — builds verify-cost.ipynb: what fork #9's verify-on-return costs, natively and under wasm32,
for the full probe #9 ships and the changed-top-only variant it rejected (window-ml #942's scope for lane 12).

    node scripts/nb.mjs make notebooks/python-dialect/verify-cost/verify-cost.ipynb

The cells are written here; edit this file, not the notebook. The inputs are the raw rounds under data/, committed as
taken: data/native-*.jsonl (native_bench.py's earlier form, one line per process and shape) and data/wasm-rounds-*.json
(drive.mjs, every rep: `trial` with a core built from #9's branch commit before the merge, `release` with #9's released
core, taken on a quiet laptop; `release-loaded` the same cores under stray CPU load; the trial rows stay beside the
release rows). Nothing is extracted from a gitignored store, so no NB_REFRESH.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# The memory cap's verify-on-return: what it costs

Fork #9 (parawanderer/cpython) runs the memory cap's hook check (`mem_verify`, three probe allocations) again whenever
an approved call into C returns, so a leaf that drops the hook mid-run cannot leave the cell uncounted. #9 chose the
FULL probe over a variant that probes only when some domain's top allocator changed (`lab/mem-recheck-gate`), on native
numbers. Under wasm32 an indirect call is a larger share of a tight loop, so the trade may read differently; this
notebook keeps the rounds so it can be revisited. Ruled 2026-10-21 (repl-specs): the full probe stands, since the gate
is a proxy for "ours is in the chain"; a narrower split (the full probe only after a call that is not one of CPython's
own builtins) is Shane's to take or not.

Shapes (`shapes.py`): `trivial` (a `return 1` run: the entry, which the fix should not move), `unlifted_c` (200k `len()`
calls), `lifted_leaf` (200k calls of a lifted host leaf), `py_func` (200k calls of the cell's own def: not checked, the
control for the call path). A shape's figure for one process is the MIN over its reps; across rounds, the median of those.
""")

code("""
import hashlib, json
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "python-dialect" / "verify-cost"
DATA = HERE / "data"
SHAPES = ["trivial", "unlifted_c", "lifted_leaf", "py_func"]
pd.set_option("display.width", 160)
pd.DataFrame([{"file": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()[:16]}
              for p in sorted(DATA.iterdir())])
""")

md("""
## Native (macOS arm64), as in #9's body

8 interleaved rounds of 7c40b038 (`base`) against #9 (`fixed`), then 6 rounds against the changed-top variant (`gate`),
a fresh process per build per round. The ratio is taken per round, then summarised. Taken under the same stray load
as the `trial` set below: the ratios are interleaved, the absolute ns soft.
""")

code("""
def native(path):
    return pd.DataFrame([json.loads(l) for l in open(path)])

def summarise(df, base, other, value):
    rows = []
    for s in [x for x in SHAPES if x in set(df["shape"])]:   # df.shape is the frame's dimensions
        b = df[(df["shape"] == s) & (df.build == base)].set_index("round")[value]
        o = df[(df["shape"] == s) & (df.build == other)].set_index("round")[value]
        r = (o / b).dropna()
        rows.append({"shape": s, f"{base} ns": b.median(), f"{other} ns": o.median(), "ratio median": r.median(),
                     "ratio min": r.min(), "ratio max": r.max(), "rounds": len(r)})
    return pd.DataFrame(rows).round(3)

display(summarise(native(DATA / "native-full.jsonl"), "base", "fixed", "ns_per_call_min"))
summarise(native(DATA / "native-gate.jsonl"), "base", "gate", "ns_per_call_min")
""")

md("""
## wasm32 (Pyodide under Node), every rep

`drive.mjs`: one fresh Pyodide per core per round, the order rotated each round. `base` and `base_aa` load the SAME
7c40b038 core: their ratio is the noise floor. `full` is #9 (in the `trial` set a core built from its branch commit
8575f359, in the `release` set its released core); `gate` is the variant built from `lab/mem-recheck-gate` with the
same recipe. Each set is summarised on its own: rounds are paired only within a set.

The `trial` and `release-loaded` sets ran with six stray CPU-load shells on the laptop (another session's repro, running
from 2026-10-20 until 15:22 on 2026-10-21; the janitor's mail `20261021-1330Z-flaky-ci-to-repl-specs-orphan-load-shells-killed.md`).
Every core of a set ran under the same load, so their ratios stand, but their A/A spread is wider than the laptop's own
and their absolute ns are soft. `release` was taken after the shells were killed, at a load average of about 3.
""")

code("""
sets = {}
for n in ("release", "release-loaded", "trial"):
    p = DATA / f"wasm-rounds-{n}.json"
    if p.exists():
        sets[n] = pd.DataFrame([{"round": r["round"], "build": r["label"], "core": r["core"], "shape": s, "ns": min(v),
                                 "reps": len(v)} for r in json.loads(p.read_text()) for s, v in r["ns"].items()])
tables = {}
for n, wasm in sets.items():
    print(f"=== {n}:", wasm.groupby("build").core.first().to_dict(), "rounds:", wasm["round"].nunique())
    for o in ["base_aa", "full", "gate"]:
        if o in set(wasm.build):
            tables[n, o] = summarise(wasm, "base", o, "ns")
            print(f"{n}: {o} / base")
            display(tables[n, o])
""")

md("""
## The noise floor against each candidate

For each set and shape: the A/A ratio's range, and each candidate's median ratio. A candidate's median inside the A/A
range is not distinguishable from no change on these rounds.
""")

code("""
rows = []
for n in sets:
    aa = tables.get((n, "base_aa"))
    for s in SHAPES:
        row = {"set": n, "shape": s}
        if aa is not None:
            a = aa.set_index("shape").loc[s]
            row["A/A min"], row["A/A max"] = a["ratio min"], a["ratio max"]
        for c in ["full", "gate"]:
            if (n, c) in tables:
                m = tables[n, c].set_index("shape").loc[s, "ratio median"]
                row[f"{c} median"] = m
                if aa is not None:
                    row[f"{c} beyond noise"] = bool(m > row["A/A max"] or m < row["A/A min"])
        rows.append(row)
pd.DataFrame(rows).round(3)
""")

code("""
# ns per approved call that each candidate adds over base, under wasm32 (median of per-round differences)
diff = []
for n, wasm in sets.items():
    for c in [x for x in ["full", "gate", "base_aa"] if x in set(wasm.build)]:
        for s in ["unlifted_c", "lifted_leaf", "py_func"]:
            b = wasm[(wasm["shape"] == s) & (wasm.build == "base")].set_index("round").ns
            o = wasm[(wasm["shape"] == s) & (wasm.build == c)].set_index("round").ns
            diff.append({"set": n, "build": c, "shape": s, "added ns/call (median)": (o - b).median()})
pd.DataFrame(diff).pivot(index=["set", "shape"], columns="build", values="added ns/call (median)").round(1)
""")

md("""
## The trivial run's spread

A trivial run is about 150 µs under wasm32, mostly compile; its per-round ratio spreads wider than the call shapes', so
a median a few percent off 1 is not read as a cost.
""")

code("""
spread = []
for n, wasm in sets.items():
    t = wasm[wasm["shape"] == "trivial"]
    for b, g in t.groupby("build"):
        spread.append({"set": n, "build": b, "min µs": g.ns.min() / 1e3, "median µs": g.ns.median() / 1e3,
                       "max µs": g.ns.max() / 1e3, "max/min": g.ns.max() / g.ns.min()})
pd.DataFrame(spread).round(2)
""")

md("""
## The real cells: does a cell anyone wrote move?

Every real `python_exec` cell the corpus finds (`corpus.py`: the local run exports and the bench store; 1,702 that
parse), timed inside the dialect by `cells.py`, the way `python-dialect-run.ts` runs one, with `drive.mjs
--one=one-cells.mjs`: a fresh Pyodide per core per round, the order rotated, `base`/`base_aa` the same 7c40b038 core.
The cell text stays local (`export_cells.py` writes it outside the repo); the rounds hold only `corpus.py`'s
`cell_id` (a hash of the text), the outcome's kind and the ns.

A cell enters the ratio only when every process, on both cores, gave it the SAME outcome. The headline is the cells that
finish (`ok`); a cell that stops on its own error is timed too, but its run is cut short, so it gets its own row. A
cell's figure for one process is the min over its reps; its ratio is the median over rounds of the per-round ratio. The
decision (repl-specs, 2026-10-21): the full probe stands if the candidate's upper quartile is inside the A/A spread;
lane 13 opens if real cells move 1.2x or more.
""")

code("""
cellsets = {}
for n in ("release", "release-loaded", "trial"):
    p = DATA / f"cells-rounds-{n}.json"
    if p.exists():
        cellsets[n] = pd.DataFrame([{"round": r["round"], "build": r["label"], "cell": cid, "outcome": v["outcome"],
                                     "ns": min(v["ns"])} for r in json.loads(p.read_text()) for cid, v in r["ns"].items()])

def per_cell(c, other):
    # one ratio per cell: the median over rounds of other/base, on cells whose outcome never varied across both builds
    two = c[c.build.isin(["base", other])]
    same = two.groupby("cell").outcome.nunique() == 1
    two = two[two.cell.isin(same[same].index)]
    w = two.pivot_table(index=["cell", "round"], columns="build", values="ns").dropna()
    r = (w[other] / w["base"]).groupby("cell").median()
    out = two.groupby("cell").outcome.first().to_frame().join(r.rename("ratio"), how="inner")
    return out.join(w["base"].groupby("cell").median().rename("base ns"))

rows = []
for n, c in cellsets.items():
    print(f"=== {n}: outcomes per process (round 0, base):", c[(c["round"] == 0) & (c.build == "base")].outcome.value_counts().to_dict())
    for o in ["base_aa", "full", "gate"]:
        if o not in set(c.build):
            continue
        pc = per_cell(c, o)
        for label, sel in [("ok", pc.outcome == "ok"), ("own error", pc.outcome.str.startswith("error:")),
                           ("ok, base >= 1 ms", (pc.outcome == "ok") & (pc["base ns"] >= 1e6))]:
            q = pc[sel].ratio
            rows.append({"set": n, "build": o, "cells": label, "n": len(q), "q25": q.quantile(.25), "median": q.median(),
                         "q75": q.quantile(.75), "q90": q.quantile(.9), "max": q.max()})
cells_tab = pd.DataFrame(rows).round(3)
cells_tab
""")

code("""
# The decision: each candidate's upper quartile against the A/A pair's interquartile spread, on the same cells.
verdict = []
for (n, label), g in cells_tab.groupby(["set", "cells"], sort=False):
    aa = g[g.build == "base_aa"]
    for _, r in g[g.build != "base_aa"].iterrows():
        lo, hi = (aa.q25.iloc[0], aa.q75.iloc[0]) if len(aa) else (float("nan"), float("nan"))
        verdict.append({"set": n, "cells": label, "build": r.build, "n": r.n, "median": r["median"], "q75": r.q75,
                        "A/A q25": lo, "A/A q75": hi, "q75 inside A/A": bool(lo <= r.q75 <= hi),
                        "moves >= 1.2x (q75)": bool(r.q75 >= 1.2)})
pd.DataFrame(verdict)
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
out = HERE / "verify-cost.ipynb"
nbf.write(nb, out)
print("wrote", out)
