"""make-verify-cost.py — builds verify-cost.ipynb: what fork #9's verify-on-return costs, natively and under wasm32,
for the full probe #9 ships and the changed-top-only variant it rejected (window-ml #942's scope for lane 12).

    node scripts/nb.mjs make notebooks/python-dialect/verify-cost/verify-cost.ipynb

The cells are written here; edit this file, not the notebook. The inputs are the raw rounds under data/, committed as
taken: data/native-*.jsonl (native_bench.py's earlier form, one line per process and shape) and data/wasm-rounds.json
(drive.mjs, every rep). Nothing is extracted from a gitignored store, so there is no NB_REFRESH.
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
notebook keeps the rounds so it can be revisited.

Shapes (`shapes.py`): `trivial` (a `return 1` run: the entry, which the fix should not move), `unlifted_c` (200k `len()`
calls), `lifted_leaf` (200k calls of a lifted host leaf), `py_func` (200k calls of the cell's own def: not checked, the
control for the call path). A shape's figure for one process is the MIN over its reps; across rounds, the median of those.
""")

code("""
import hashlib, json
from pathlib import Path
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
a fresh process per build per round. The ratio is taken per round, then summarised.
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

full = native(DATA / "native-full.jsonl")
gate = native(DATA / "native-gate.jsonl")
display(summarise(full, "base", "fixed", "ns_per_call_min"))
summarise(gate, "base", "gate", "ns_per_call_min")
""")

md("""
## wasm32 (Pyodide under Node), every rep

`drive.mjs`: one fresh Pyodide per core per round, the order rotated each round. `base` and `base_aa` load the SAME
7c40b038 core: their ratio is the noise floor. `full` is #9's released core; `gate` is the variant built from
`lab/mem-recheck-gate` with the same recipe.
""")

code("""
raw = json.loads((DATA / "wasm-rounds.json").read_text())
wasm = pd.DataFrame([{"round": r["round"], "build": r["label"], "core": r["core"], "shape": s, "ns": min(v), "reps": len(v)}
                     for r in raw for s, v in r["ns"].items()])
print(wasm.groupby("build").core.first().to_dict(), "rounds:", wasm["round"].nunique())
tables = {other: summarise(wasm, "base", other, "ns") for other in ["base_aa", "full", "gate"] if other in set(wasm.build)}
for name, t in tables.items():
    print(f"\\n{name} / base")
    display(t)
""")

md("""
## The noise floor against each candidate

For each shape: the A/A ratio's range, and each candidate's median ratio. A candidate's median inside the A/A range is
not distinguishable from no change on these rounds.
""")

code("""
aa = tables.get("base_aa")
rows = []
for s in SHAPES:
    row = {"shape": s}
    if aa is not None:
        a = aa.set_index("shape").loc[s]
        row["A/A min"], row["A/A max"] = a["ratio min"], a["ratio max"]
    for c in ["full", "gate"]:
        if c in tables:
            m = tables[c].set_index("shape").loc[s, "ratio median"]
            row[f"{c} median"] = m
            if aa is not None:
                row[f"{c} beyond noise"] = bool(m > row["A/A max"] or m < row["A/A min"])
    rows.append(row)
pd.DataFrame(rows).round(3)
""")

code("""
# ns per approved call that each candidate adds over base, under wasm32 (median of per-round differences)
diff = []
for c in [x for x in ["full", "gate", "base_aa"] if x in set(wasm.build)]:
    for s in ["unlifted_c", "lifted_leaf", "py_func"]:
        b = wasm[(wasm["shape"] == s) & (wasm.build == "base")].set_index("round").ns
        o = wasm[(wasm["shape"] == s) & (wasm.build == c)].set_index("round").ns
        diff.append({"build": c, "shape": s, "added ns/call (median)": (o - b).median()})
pd.DataFrame(diff).pivot(index="shape", columns="build", values="added ns/call (median)").round(1)
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
out = HERE / "verify-cost.ipynb"
nbf.write(nb, out)
print("wrote", out)
