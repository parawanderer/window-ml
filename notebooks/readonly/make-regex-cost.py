"""make-regex-cost.py — builds regex-cost.ipynb: is REGEX_UNITS_PER_STEP = 512 sound for the read-only dialect's regex bound?

    .venv/bin/python notebooks/readonly/make-regex-cost.py && node scripts/nb.mjs run notebooks/readonly/regex-cost.ipynb
    (or: node scripts/nb.mjs make notebooks/readonly/regex-cost.ipynb)

The cells are written here; edit this file, not the notebook. Their numbers come from data/regex-cost/bench.json, which
`regex-bench.mjs` produced (NB_REFRESH=1 runs it again, about half a minute).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Is `REGEX_UNITS_PER_STEP = 512` sound, and what does an ordinary survey pay?

The read-only dialect runs at about 3.2M evaluation steps a second, and `STEP_BUDGET` is 3,000,000, so one step is about
312.5 ns. A regex search is one host call whose work the step count never sees, so `regexWork(source, flags, input)`
(`src/readonly-exec/regex-cost.ts`) prices it first: an upper bound, in units, on the backtracking work of one native V8
search over that input, charged at `REGEX_UNITS_PER_STEP` units a step (`docs/dev/readonly-exec.md`, Halting row
`REGEX_UNITS_PER_STEP`). Counted repeats (`{m,n}` with finite n) are weighted x3 inside the bound.

The constant is sound only if every shape costs at most 312.5 / 512 = 0.61 ns per unit of bound. Four groups are timed:
twenty worst-case shapes, counted repeats at up to 2M characters, ten ordinary surveys, and seeded random patterns that
pass `riskyRegex`, on six adversarial inputs (a search whose bound predicts over about 2 s is skipped, and sub-millisecond
timings are dropped as call overhead).

Re-run: `NB_REFRESH=1 node scripts/nb.mjs run notebooks/readonly/regex-cost.ipynb`, which runs
`node --import tsx notebooks/readonly/regex-bench.mjs` from the repo root.
""")

code("""
import json, subprocess
import numpy as np
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "readonly"
EXTRACT = HERE / "data" / "regex-cost" / "bench.json"
NS_PER_STEP = 312.5
UNITS_PER_STEP = 512
LIMIT = NS_PER_STEP / UNITS_PER_STEP
STEP_BUDGET = 3_000_000
pd.set_option("display.width", 200)
pd.set_option("display.max_colwidth", 60)

def run_bench():
    out = subprocess.run(["node", "--import", "tsx", "notebooks/readonly/regex-bench.mjs"], cwd=wmlnb.ROOT,
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)

data = wmlnb.extract(EXTRACT, run_bench, source={"driver": "notebooks/readonly/regex-bench.mjs", "cmd": "node --import tsx notebooks/readonly/regex-bench.mjs"})
meta = data["meta"]
df = pd.DataFrame(data["rows"])
bad = df[df.ns_per_unit.isna()]
df = df[df.ns_per_unit.notna()].copy()
pd.DataFrame(wmlnb.provenance(EXTRACT))
""")

md("""
## The machine

Load from other processes inflates ns/unit (the timed search shares the core with them), which makes the derived constant
conservative, never optimistic: a load-free run can only be faster per unit.
""")

code("""
pd.Series({
    "node": meta["node"], "v8": meta["v8"], "platform": meta["platform"], "cpu": meta["cpus"], "cpus": meta["cpu_count"],
    "loadavg at start (1/5/15 min)": [round(x, 2) for x in meta["loadavg_start"]],
    "loadavg at end": [round(x, 2) for x in meta["loadavg_end"]],
    "run took (s)": meta["seconds"], "date": meta["date"], "rows": len(df), "rows with an error or no bound": len(bad),
}).to_frame("value")
""")

md("## ns per unit of bound, by group")

code("""
g = df.groupby("group").ns_per_unit
(pd.DataFrame({"max": g.max(), "p95": g.quantile(0.95), "median": g.median(), "count": g.count()})
   .reindex(["worst", "counted", "ordinary", "fuzz"]).round(3))
""")

md("The ten rows closest to (or over) the budget line of 0.61 ns per unit, across all groups.")

code("""
top = df.sort_values("ns_per_unit", ascending=False).head(10)
top[["group", "pattern", "flags", "method", "n", "ms", "units", "ns_per_unit", "steps"]].assign(
    ms=lambda d: d.ms.round(1), units=lambda d: d.units.map("{:.2e}".format), ns_per_unit=lambda d: d.ns_per_unit.round(3))
""")

md("""
## The derived constant

`312.5 / max ns per unit` is the most units a step could be charged for if the slowest measured shape were to just fit
its budget. It is compared with the shipped 512; it prints a verdict and does not raise.
""")

code("""
worst_row = df.loc[df.ns_per_unit.idxmax()]
derived = NS_PER_STEP / worst_row.ns_per_unit
print(f"max ns/unit = {worst_row.ns_per_unit:.3f}  ({worst_row.group}: /{worst_row.pattern}/{worst_row["flags"]} on n={worst_row.n}, {worst_row.ms:.1f} ms)")
print(f"derived units per step = floor(312.5 / max) = {int(np.floor(derived))}   shipped = {UNITS_PER_STEP}   limit = {LIMIT:.3f} ns/unit")
print("PASS: 512 is within the measured bound" if derived >= UNITS_PER_STEP else "FAIL: a measured shape costs more than 0.61 ns per unit")
print("headroom (derived / 512): %.2fx" % (derived / UNITS_PER_STEP))
""")

md("""
## What an ordinary survey pays

Steps charged are `ceil(units / 512)`; the budget is `STEP_BUDGET` = 3,000,000 steps.
""")

code("""
o = df[df.group == "ordinary"].copy()
o["pct_of_budget"] = (o.steps / STEP_BUDGET * 100).round(2)
o[["pattern", "flags", "n", "ms", "units", "steps", "pct_of_budget"]].assign(ms=lambda d: d.ms.round(1), units=lambda d: d.units.map("{:.2e}".format))
""")

md("""
## Bound against time

Each point is one timed search. The line is the budget: ms = units x 0.61e-6, where a point on it spends exactly its
steps' worth of time. Points above it are under-charged.
""")

code("""
fig, ax = plt.subplots(figsize=(6, 4), dpi=80)
colors = {"worst": "#d95f02", "counted": "#7570b3", "ordinary": "#1b9e77", "fuzz": "#8c8c8c"}
for grp, c in colors.items():
    d = df[(df.group == grp) & (df.ms > 0)]
    ax.scatter(d.units, d.ms, s=12, c=c, label=grp, alpha=0.8)
xs = np.array([df.units.min(), df.units.max()])
ax.plot(xs, xs * LIMIT * 1e-6, "k--", lw=1, label="budget: 0.61 ns/unit")
ax.set_xscale("log"); ax.set_yscale("log")
ax.set_xlabel("bound (units)"); ax.set_ylabel("measured (ms)")
ax.legend(fontsize=8); fig.tight_layout()
display(fig)
plt.close(fig)
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "regex-cost.ipynb")
print("wrote", HERE / "regex-cost.ipynb")
