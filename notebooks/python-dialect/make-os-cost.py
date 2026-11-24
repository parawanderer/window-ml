"""make-os-cost.py — builds os-cost.ipynb: do the constants that price the dialect's os subset (`DIR_LISTING_STEPS`,
`DIR_ENTRY_STEPS`, `FILE_READ_STEPS`, `FILE_BYTES_PER_STEP` in src/python/python-dialect-run.ts, and `DIR_PAGE` in
src/python/files-mount.ts) cover the time the calls really take?

    node scripts/nb.mjs make notebooks/python-dialect/os-cost.ipynb

The cells are written here; edit this file, not the notebook. Their numbers come from data/os-cost/bench.json, which
os-cost/one.mjs produced (NB_REFRESH=1 runs it again, about ten seconds): os-cost/bench.py inside Pyodide, on the
restricted-mode core in dist/pyodide (a symlink; run from the repo root). The constants themselves are read from the
source files, so the notebook cannot disagree with them.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Do the os subset's constants cover the time its calls take?

Inside the Python dialect a cell may list directories and read files (ruling 112). The step counter never sees the time
those host calls take, so each is charged in steps BEFORE it runs: a listing of N names `DIR_LISTING_STEPS + N x
DIR_ENTRY_STEPS` (`listingSteps`), and a read `FILE_READ_STEPS + ceil(size / FILE_BYTES_PER_STEP)`. A charge is sound
when it is worth at least the time the call takes, at the STRICT basis (the cheapest step's time), as the regex charge is
set (`regex-cost.ipynb`).

Six sections: (1) ns per step of the interpreter, (2) listing cost per entry for five calls, (3) read cost per byte,
(4) the `/files` mount's overcharge, which is arithmetic on the constants, (5) each call's fixed cost, (6) the margin of
candidate constants, and of the shipped ones, at every measured point.

Everything is timed in Pyodide on the restricted-mode fork core (wasm32), on MEMFS, because that is where `python_exec`
runs. The listing and read timings run in plain Python OUTSIDE the gate (the gate only charges); the step rate runs
through `restricted.run_cell`.

Re-run: `NB_REFRESH=1 node scripts/nb.mjs run notebooks/python-dialect/os-cost.ipynb`, which runs
`node notebooks/python-dialect/os-cost/one.mjs` from the repo root.
""")

code("""
import json, re, subprocess
import numpy as np
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "python-dialect"
EXTRACT = HERE / "data" / "os-cost" / "bench.json"
pd.set_option("display.width", 200)

def run_bench():
    out = subprocess.run(["node", "notebooks/python-dialect/os-cost/one.mjs"], cwd=wmlnb.ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)

data = wmlnb.extract(EXTRACT, run_bench, source={"driver": "notebooks/python-dialect/os-cost/one.mjs",
                     "cmd": "node notebooks/python-dialect/os-cost/one.mjs"})
meta, step_rate = data["meta"], data["step_rate"]

def const(path, name):
    return int(re.search(r"export const %s = (\\d+);" % name, (wmlnb.ROOT / path).read_text()).group(1))

DIR_ENTRY_STEPS = const("src/python/python-dialect-run.ts", "DIR_ENTRY_STEPS")
DIR_LISTING_STEPS = const("src/python/python-dialect-run.ts", "DIR_LISTING_STEPS")
FILE_BYTES_PER_STEP = const("src/python/python-dialect-run.ts", "FILE_BYTES_PER_STEP")
FILE_READ_STEPS_SHIPPED = const("src/python/python-dialect-run.ts", "FILE_READ_STEPS")
DIR_PAGE = const("src/python/files-mount.ts", "DIR_PAGE")
BUDGET = step_rate["default_budget"]
listing_steps = lambda n, d=DIR_ENTRY_STEPS, l=DIR_LISTING_STEPS: l + n * d   # listingSteps in python-dialect-run.ts
print(f"DIR_LISTING_STEPS={DIR_LISTING_STEPS}  DIR_ENTRY_STEPS={DIR_ENTRY_STEPS}  FILE_READ_STEPS={FILE_READ_STEPS_SHIPPED}  "
      f"FILE_BYTES_PER_STEP={FILE_BYTES_PER_STEP}  DIR_PAGE={DIR_PAGE}  DEFAULT_BUDGET={BUDGET:,}")
pd.DataFrame(wmlnb.provenance(EXTRACT))
""")

md("""
## The machine

Load from other processes slows the timed calls AND the step loops alike, so every conversion below divides a time by
a step time taken in the same run.
""")

code("""
pd.Series({
    "pyodide": meta["pyodide"], "python": meta["python"][:40], "platform": meta["platform"], "node": meta["node"],
    "cpu": meta["cpus"], "cpus": meta["cpu_count"],
    "loadavg at start (1/5/15 min)": [round(x, 2) for x in meta["loadavg_start"]],
    "loadavg at end": [round(x, 2) for x in meta["loadavg_end"]],
    "run took (s)": meta["seconds"], "date": meta["date"],
}).to_frame("value")
""")

md("""
## 1. How long is one step?

CPU-bound cells through `restricted.run_cell(src, ns, budget=50M)`; wall time over the steps `_restricted.steps()` reports
for the finished run. Nine runs per cell after a warm-up. Cells differ in how much C work a step covers: `pass_loop` (an
empty nested `for`) is the cheapest step there is, so it is the STRICT basis: a charged step is never worth less than that.
`for_add` and `branch` are heavier per step; their median is what a typical cell sees (`DEFAULT_BUDGET` = about 1 s on the
fork's own comment, longer here).
""")

code("""
cells = {k: v for k, v in step_rate.items() if isinstance(v, dict) and "ns_per_step" in v}
tab = pd.DataFrame({k: {"steps per run": v["steps"], "median ns/step": np.median(v["ns_per_step"]),
                        "min": min(v["ns_per_step"]), "max": max(v["ns_per_step"]),
                        "spread (max/min)": max(v["ns_per_step"]) / min(v["ns_per_step"])} for k, v in cells.items()}).T
NS_STEP = float(tab.loc["pass_loop", "median ns/step"])             # the strict basis
NS_STEP_FAST = float(tab.loc["pass_loop", "min"])
NS_STEP_TYPICAL = float(np.median([np.median(v["ns_per_step"]) for k, v in cells.items() if k in ("for_add", "branch", "def_call")]))
print(f"strict (pass_loop median): {NS_STEP:.1f} ns/step (best run {NS_STEP_FAST:.1f}); typical (median of for_add, branch, def_call): {NS_STEP_TYPICAL:.1f} ns/step")
print(f"DEFAULT_BUDGET {BUDGET:,} steps = {BUDGET * NS_STEP * 1e-9:.2f} s at the strict rate, {BUDGET * NS_STEP_TYPICAL * 1e-9:.2f} s at the typical one")
tab.round(1)
""")

md("""
## 2. Listing: ns per entry, as step-equivalents

For a MEMFS directory of N empty files, each call is timed in plain Python (median of many reps; fewer for N = 10000),
and the same call on an empty directory (N = 0) is subtracted, so the fixed cost of a call drops out: `ns per entry =
(t(N) - t(0)) / N`. A step-equivalent is `ns per entry / ns per step`. `DIR_ENTRY_STEPS` must be at least the largest
one, over every call and every N, on the strict basis; the typical basis is shown too. N = 10 is noisy (the subtracted
baseline is of the same size as the signal), so the maximum is also taken over N of 100 and up.
""")

code("""
L_ALL = pd.DataFrame(data["listing"])
L = L_ALL[L_ALL.n >= 10].copy()
L["step_eq_strict"] = L.ns_per_entry / NS_STEP
L["step_eq_typical"] = L.ns_per_entry / NS_STEP_TYPICAL
L["step_eq_min_time_strict"] = L.ns_per_entry_min / NS_STEP
order = ["os.listdir", "os.scandir", "os.walk", "glob.glob", "Path.iterdir"]
print("ns per entry")
display(L.pivot(index="call", columns="n", values="ns_per_entry").reindex(order).round(0))
print("step-equivalents per entry, strict basis (ns/entry over the pass_loop step)")
display(L.pivot(index="call", columns="n", values="step_eq_strict").reindex(order).round(1))
print("step-equivalents per entry, typical basis")
display(L.pivot(index="call", columns="n", values="step_eq_typical").reindex(order).round(1))
""")

code("""
big = L[L.n >= 100]
rows = []
for name in order:
    d = L[L.call == name]; db = big[big.call == name]
    rows.append({"call": name,
                 "max step-eq (all N), strict": d.step_eq_strict.max(), "max step-eq (N>=100), strict": db.step_eq_strict.max(),
                 "max step-eq (N>=100), typical": db.step_eq_typical.max(),
                 "margin of DIR_ENTRY_STEPS, strict (N>=100)": DIR_ENTRY_STEPS / db.step_eq_strict.max(),
                 "margin, typical (N>=100)": DIR_ENTRY_STEPS / db.step_eq_typical.max()})
V = pd.DataFrame(rows).set_index("call")
worst = V["max step-eq (N>=100), strict"].idxmax()
print(f"DIR_ENTRY_STEPS = {DIR_ENTRY_STEPS}; largest step-eq per entry (N>=100, strict): {V.loc[worst, 'max step-eq (N>=100), strict']:.1f} for {worst}")
for basis, col in (("strict", "max step-eq (N>=100), strict"), ("typical", "max step-eq (N>=100), typical")):
    bad = V[V[col] > DIR_ENTRY_STEPS].index.tolist()
    print(f"  {basis}: " + ("HOLDS for every call" if not bad else "DOES NOT HOLD for " + ", ".join(bad)))
V.round(2)
""")

md("""
Verdict, section 2: read the two `HOLDS` lines above. `os.listdir` and `os.scandir` list in C and are the calls the
constant was set from; `glob.glob`, `os.walk` and `Path.iterdir` run Python code (fnmatch, joining, path objects) per entry
inside one lifted call, which the step counter does not meter, so the readdir charge is all they pay.
""")

md("""
## 3. Reads: ns per byte, as bytes per step

`Path.read_bytes` and `Path.read_text` of one regular MEMFS file (1 KB, 64 KB, 1 MB, 8 MB). A read is charged
`ceil(size / FILE_BYTES_PER_STEP)` steps before it runs, which is worth `ceil(size / 2) x ns per step`; it covers the
read when `ns per byte <= ns per step / FILE_BYTES_PER_STEP`, i.e. the bytes per step the read really achieves,
`ns per step / ns per byte`, is at least `FILE_BYTES_PER_STEP`. The small file is the tight one: a fixed per-call cost is
spread over few bytes. This table keeps the original sizes (1 KB and up); the small files are in section 5.
""")

code("""
R_ALL = pd.DataFrame(data["reads"])
R = R_ALL[R_ALL["size"] >= 1024].copy()
R["bytes_per_step_strict"] = NS_STEP / R.ns_per_byte
R["bytes_per_step_typical"] = NS_STEP_TYPICAL / R.ns_per_byte
R["bytes_per_step_strict_min_time"] = NS_STEP / R.ns_per_byte_min
print("ns per byte")
display(R.pivot(index="call", columns="size", values="ns_per_byte").round(3))
print("bytes per step achieved, strict basis (must be >= FILE_BYTES_PER_STEP)")
display(R.pivot(index="call", columns="size", values="bytes_per_step_strict").round(2))
lo = R.loc[R.bytes_per_step_strict.idxmin()]
print(f"FILE_BYTES_PER_STEP = {FILE_BYTES_PER_STEP}; fewest bytes per step: {lo.bytes_per_step_strict:.2f} ({lo.call}, {int(lo['size'])} bytes) strict, "
      f"{R.bytes_per_step_typical.min():.2f} typical; margin {lo.bytes_per_step_strict / FILE_BYTES_PER_STEP:.2f}x strict, {R.bytes_per_step_typical.min() / FILE_BYTES_PER_STEP:.2f}x typical")
print("HOLDS" if lo.bytes_per_step_strict >= FILE_BYTES_PER_STEP else "DOES NOT HOLD on the strict basis")
""")

md("""
## 4. The `/files` overcharge: arithmetic only

The `/files` mount charges before it asks for a page, and cannot know the count first, so every page request costs
`listingSteps(DIR_PAGE)` steps however many names came back (the fork cannot credit a short page). The corpus
figures are given constants, not measured here: source "bench corpus replay, 2026-11-24, aggregate counts" (counts only,
no cell text; the repo is public).
""")

code("""
PAGE_STEPS = listing_steps(DIR_PAGE)
CORPUS_LARGEST_DIR, CORPUS_ALL_LISTED = 147, 1749   # bench corpus replay, 2026-11-24, aggregate counts
print(f"one page request: {DIR_LISTING_STEPS} + {DIR_PAGE} x {DIR_ENTRY_STEPS} = {PAGE_STEPS:,} steps = {PAGE_STEPS * NS_STEP * 1e-6:.2f} ms strict, {PAGE_STEPS * NS_STEP_TYPICAL * 1e-6:.2f} ms typical")
print(f"page requests in one DEFAULT_BUDGET ({BUDGET:,}): {BUDGET / PAGE_STEPS:,.0f}")
pd.DataFrame([
    {"listing": "largest MEMFS dir in the corpus", "names": CORPUS_LARGEST_DIR, "charged by count": listing_steps(CORPUS_LARGEST_DIR),
     "charged as one page": PAGE_STEPS, "overcharge x": PAGE_STEPS / listing_steps(CORPUS_LARGEST_DIR)},
    {"listing": "all listings together (1 page each at best)", "names": CORPUS_ALL_LISTED, "charged by count (names only)": CORPUS_ALL_LISTED * DIR_ENTRY_STEPS,
     "charged as one page": np.nan, "overcharge x": np.nan},
]).set_index("listing")
""")

md("""
Verdict, section 4: the printed page cost and page count above are what a cell that lists `/files` pays; against the
corpus's largest directory (147 names) a short page is overcharged by the factor in the table. That is a cost on cells
that list `/files`, never a hole: the page charge only ever errs high.
""")

md("""
## 5. Fixed cost of each call, and a charge of the form fixed + per unit

Sections 2 and 3 subtract the fixed cost of a call away. A charge "fixed + per unit" needs it, so here it is, in strict
step-equivalents (ns over the `pass_loop` step).

(a) Reads: `Path.read_text` and `read_bytes` of files of 0, 16, 256, 1024 bytes and the larger sizes, fitted as
`time = a + b x size` by weighted least squares (each point divided by its own time, so the 8 MB point does not
swamp the small ones). `a` is the fixed cost in step-equivalents, `b` the per-byte cost; a charge `FILE_READ_STEPS +
ceil(size / FILE_BYTES_PER_STEP)` covers the call when `FILE_READ_STEPS >= a` and `1 / FILE_BYTES_PER_STEP >= b`.

(b) Listings: each call on an EMPTY directory (the fixed cost) and on a directory of one entry.
""")

code("""
fits = []
for name, d in R_ALL.groupby("call"):
    t = d.ns_median.to_numpy(float); sz = d["size"].to_numpy(float)
    A = np.column_stack([np.ones_like(sz), sz]) / t[:, None]
    (a, b), *_ = np.linalg.lstsq(A, np.ones_like(t), rcond=None)
    fits.append({"call": name, "a ns": a, "b ns/byte": b, "a (step-eq)": a / NS_STEP, "b (step-eq/byte)": b / NS_STEP,
                 "bytes/step (1/b)": NS_STEP / b, "max rel. fit error": float(np.max(np.abs((a + b * sz) / t - 1)))})
FIT = pd.DataFrame(fits).set_index("call")
print("read time by size (median ns) and in strict step-eq")
display(R_ALL.pivot(index="call", columns="size", values="ns_median").round(0))
display((R_ALL.pivot(index="call", columns="size", values="ns_median") / NS_STEP).round(1))
FIT.round(3)
""")

code("""
F = L_ALL[L_ALL.n.isin([0, 1])].pivot(index="call", columns="n", values="ns_median").reindex(order)
FIXED = pd.DataFrame({"empty dir (ns)": F[0], "1 entry (ns)": F[1],
                      "fixed, step-eq (N=0)": F[0] / NS_STEP, "1 entry, step-eq": F[1] / NS_STEP,
                      "first entry, step-eq": (F[1] - F[0]) / NS_STEP})
FIXED.round(1)
""")

md("""
## 6. Verdicts for candidate pairs

For each `DIR_ENTRY_STEPS` d in {20, 64, 128} with `DIR_LISTING_STEPS` l in {0, 512}, and `FILE_READ_STEPS` f in
{0, 512, 1024} (with `FILE_BYTES_PER_STEP` = 2), the margin at every measured point on the STRICT basis: `charged steps /
(measured ns / ns per step)`. A margin under 1 is a point the charge does not cover. A listing is charged `l + d x N`
(with l = 0 an empty directory is charged nothing); a read `f + ceil(size / 2)`. Listings use the measured total time at
each N (fixed cost included), N = 0 up to 10000.
""")

code("""
DS, LS, FS = (20, 64, 128), (0, 512), (0, 512, 1024)
LM = L_ALL.copy()
LM["step_eq_total"] = LM.ns_median / NS_STEP
dir_rows = []
for ll in LS:
    for dd in DS:
        for name in order:
            x = LM[LM.call == name]
            m = listing_steps(x.n, dd, ll) / x.step_eq_total
            dir_rows.append({"pair": f"l={ll}, d={dd}", "call": name, "min margin": m.min(), "at N": int(LM.loc[m.idxmin(), "n"]),
                             "min margin, N>=10": m[x.n >= 10].min()})
DM = pd.DataFrame(dir_rows)
pairs = [f"l={ll}, d={dd}" for ll in LS for dd in DS]
print("listing margin = (l + d x N) / actual (strict), minimum over N = 0..10000; under 1 = under-charged")
display(DM.pivot(index="call", columns="pair", values="min margin").reindex(order)[pairs].round(2))
display(DM.pivot(index="call", columns="pair", values="at N").reindex(order)[pairs])
print("same, N >= 10 only")
display(DM.pivot(index="call", columns="pair", values="min margin, N>=10").reindex(order)[pairs].round(2))
""")

code("""
RM = R_ALL.copy()
RM["step_eq_total"] = RM.ns_median / NS_STEP
rd = []
for ff in FS:
    RM["charged"] = ff + np.ceil(RM["size"] / FILE_BYTES_PER_STEP)
    RM["margin"] = RM.charged / RM.step_eq_total
    for name, x in RM.groupby("call"):
        rd.append({"FILE_READ_STEPS": ff, "call": name, "min margin": x.margin.min(), "at size": int(x.loc[x.margin.idxmin(), "size"])})
RD = pd.DataFrame(rd)
print(f"read margin = (f + ceil(size/{FILE_BYTES_PER_STEP})) / actual (strict); minimum over sizes 0..8 MB")
display(RD.pivot(index="call", columns="FILE_READ_STEPS", values="min margin").round(2))
display(RD.pivot(index="call", columns="FILE_READ_STEPS", values="at size"))
RM["margin_f%d" % FILE_READ_STEPS_SHIPPED] = (FILE_READ_STEPS_SHIPPED + np.ceil(RM["size"] / FILE_BYTES_PER_STEP)) / RM.step_eq_total
print(f"margin at each size with the shipped FILE_READ_STEPS = {FILE_READ_STEPS_SHIPPED}")
RM.pivot(index="call", columns="size", values="margin_f%d" % FILE_READ_STEPS_SHIPPED).round(2)
""")

code("""
rows = []
for ll in LS:
    for dd in DS:
        page = listing_steps(DIR_PAGE, dd, ll)
        rows.append({"pair": f"l={ll}, d={dd}", "names-only steps for the corpus's 1,749 names": CORPUS_ALL_LISTED * dd,
                     "share of DEFAULT_BUDGET": CORPUS_ALL_LISTED * dd / BUDGET,
                     "steps for the largest dir (147)": listing_steps(CORPUS_LARGEST_DIR, dd, ll),
                     "steps per /files page": page, "/files pages per budget": BUDGET / page})
pd.DataFrame(rows).set_index("pair").round(4)
""")

code("""
lm = listing_steps(LM.n) / LM.step_eq_total
rm = (FILE_READ_STEPS_SHIPPED + np.ceil(RM["size"] / FILE_BYTES_PER_STEP)) / RM.step_eq_total
lw, rw = LM.loc[lm.idxmin()], RM.loc[rm.idxmin()]
rows = [
    ("ns per step (strict, pass_loop)", f"{NS_STEP:.1f}"),
    ("listing: DIR_LISTING_STEPS + N x DIR_ENTRY_STEPS", f"{DIR_LISTING_STEPS} + N x {DIR_ENTRY_STEPS}: tightest margin {lm.min():.2f}x strict ({lw.call}, N={int(lw.n)}); {'HOLDS' if lm.min() >= 1 else 'DOES NOT HOLD'} at every measured N"),
    ("read: FILE_READ_STEPS + ceil(size / FILE_BYTES_PER_STEP)", f"{FILE_READ_STEPS_SHIPPED} + ceil(size / {FILE_BYTES_PER_STEP}): tightest margin {rm.min():.2f}x strict ({rw.call}, {int(rw['size'])} bytes); {'HOLDS' if rm.min() >= 1 else 'DOES NOT HOLD'} at every measured size"),
    ("a /files page: listingSteps(DIR_PAGE)", f"{PAGE_STEPS:,} steps a page, {BUDGET / PAGE_STEPS:,.0f} pages per DEFAULT_BUDGET"),
]
pd.DataFrame(rows, columns=["constant", "result"]).set_index("constant")
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "os-cost.ipynb")
print("wrote", HERE / "os-cost.ipynb")
