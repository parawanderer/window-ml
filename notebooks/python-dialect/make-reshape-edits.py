"""make-reshape-edits.py — builds reshape-edits.ipynb: on the reshaping bench's multi-cell task, how many python_exec
cells finish inside the read-only dialect, why the rest ask, and for each refused EDIT, who made the value it wrote to.

    node scripts/nb.mjs make notebooks/python-dialect/reshape-edits.ipynb

The cells are written here; edit this file, not the notebook. A skeleton until the sweep runs: the sweep waits for the
widened read-only Python vocabulary on main (ruling 63), since csv-total's first refusals (`pd.read_csv`, `df.columns`,
`df.shape`) would come before any edit and hide it; the gate is packages' V1 and V2 and the worker's site-path repair. Until then the notebook runs its classifier on the five cells of
tests/e2e/python-dialect-edits.spec.mjs, whose outcomes that spec asserts in the built extension, and says the sweep is
missing. The rows come from reshape-edits/provenance.py over the sweep's run exports, pinned in data/reshape-edits/;
features only, never a cell's code.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Who made the value a refused edit wrote to: the reshaping task, cell by cell

The question (ruling 58's design waits on it, ruling 63): when a model's cells reshape data across several cells, how
often is a cell refused for an EDIT, and of what? The fork refuses a write to a value the cell does not own. A value an
earlier INSIDE cell made stays owned, so editing it runs unasked; the injected table (`df`, `tables`) and a value an
earlier ASKED cell made (made on the full path) are not owned, so writing to them asks. Letting the model edit its own
kernel values unasked is worth building only if the second and third kinds are common among the refusals that remain once
the vocabulary is wide enough.

The task (tests/e2e/bench/specs/reshape.bench.ts): four CSVs on the fixture site, joined to find the region-and-product
pair that fell furthest short of its target after returns. Three arms on the same models: `neutral-hint` and
`staged-hint`, the two wordings (`neutral` leaves the number of cells to the model, `staged` names four stages) each ending
with "Fetch each file with fetch_url and pass the four URLs to python_exec's `tables`.", and `neutral` without that
sentence. Every run starts from the HUD, so every cell is tried inside the dialect.

Each run is classified by the ROUTE its first Python cell took to the files: `tables-url` (a `tables` source that is a full
URL, which loads inside), `tables-path` (a site path or anything else in `tables`), `read_csv-fetched` and
`read_csv-unfetched` (no `tables`; a read_csv of a file fetch_url did or did not read), `other`. The two `tables` routes
load the files inside the dialect (a site path since the worker's path repair), so they reach the edits without a file
refusal first: edits are counted within each of them, as separate rows, and nowhere else. The route mix per arm is
reported apart: it is what the hint changes.

How a refused edit's maker is read (reshape-edits/provenance.py): the root name of the store on the refusal's line, found
with `ast`; `injected` if the cell was handed that name, `alias` if the cell bound it itself before the line (a name for a
value it did not make), else the latest earlier cell that bound it, `inside` or `full` by that cell's outcome, `unknown`
when none did. Syntactic, so a binding in a branch that never ran counts.
""")

code("""
import importlib.util, json
from pathlib import Path
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "python-dialect"
spec = importlib.util.spec_from_file_location("provenance", HERE / "reshape-edits" / "provenance.py")
prov = importlib.util.module_from_spec(spec); spec.loader.exec_module(prov)
pd.set_option("display.width", 200)
""")

md("""
## The classifiers on the e2e smoke's cells

The five cells of tests/e2e/python-dialect-edits.spec.mjs, with the outcomes that spec asserts in the built extension (the
reason is the fork's, as the result sentence carries it). The makers must read: none, none, `injected`, none, `full`.
""")

code("""
SMOKE = [
    ("kept = [1, 2]\\nlen(kept)", True, None, set()),
    ("kept.append(3)\\nkept[0] = 9\\nkept", True, None, set()),
    ("df['flag'] = 1\\nlen(df)", False, "item assignment to a value the cell does not own: on DataFrame (line 1)", {"df"}),
    ("import os\\nmade = [1]\\nlen(made)", False, "import 'os' (line 1)", set()),
    ("made.append(2)\\nmade", False, "a method that writes a value the cell does not own: 'append' of list (line 1)", set()),
]
smoke = prov.rows_of([{"code": c, "inside": ok, "reason": r, "injected": prov.injected_names(None) | names} for c, ok, r, names in SMOKE])
assert [r["maker"] for r in smoke] == [None, None, "injected", None, "full"], [r["maker"] for r in smoke]
pd.DataFrame(smoke)
""")

md("""
An alias is followed to what it names, since ruling 64 counts an alias of an earlier cell's value and not one of the
injected table: `y = df` then `y['a'] = 1` is an alias of `injected`; `z = kept` then `z.append(1)` after an inside cell
made `kept` is an alias of `inside`; `w = z` before that is followed through `z`. Across cells too: `y = df` in one cell
and `y['a'] = 1` in the next is an alias of `injected`, while `y = df.copy()` there is a value the earlier cell made.
""")

code("""
ITEM = "item assignment to a value the cell does not own: on DataFrame (line 2)"
APPEND = "a method that writes a value the cell does not own: 'append' of list (line {})"
ALIASES = [
    ("kept = [1, 2]", True, None),
    ("y = df\\ny['a'] = 1", False, ITEM),
    ("z = kept\\nz.append(1)", False, APPEND.format(2)),
    ("z = kept\\nw = z\\nw.append(1)", False, APPEND.format(3)),
    ("y = df", True, None),
    ("y['a'] = 1", False, ITEM.replace("line 2", "line 1")),
    ("c = df.copy()", True, None),
    ("c['a'] = 1", False, ITEM.replace("line 2", "line 1")),
]
aliases = prov.rows_of([{"code": c, "inside": ok, "reason": r, "injected": prov.injected_names(None)} for c, ok, r in ALIASES])
got = [(r["maker"], r["alias_of"]) for r in aliases]
assert got == [(None, None), ("alias", "injected"), ("alias", "inside"), ("alias", "inside"),
               (None, None), ("alias", "injected"), (None, None), ("inside", None)], got
pd.DataFrame(aliases)
""")

code("""
U = "http://127.0.0.1:1/"
fetch = lambda n: {"tool": "fetch_url", "arguments": {"url": U + n}}
py = lambda code, tables=None: {"tool": "python_exec", "arguments": {"code": code, **({"tables": tables} if tables else {})}}
ROUTES = {
    "tables-url": [fetch("sales.csv"), py("len(sales)", {"sales": U + "sales.csv"})],
    "tables-path": [fetch("sales.csv"), py("len(sales)", {"sales": "/sales.csv"})],
    "read_csv-fetched": [fetch("sales.csv"), py("import pandas as pd\\nlen(pd.read_csv('/sales.csv'))")],
    "read_csv-unfetched": [py(f"import pandas as pd\\nlen(pd.read_csv('{U}returns.csv'))")],
    "other": [py("1 + 1")],
    "no-python": [fetch("sales.csv")],
}
got = {want: prov.route({"steps": steps}) for want, steps in ROUTES.items()}
assert all(k == v for k, v in got.items()), got
got
""")

md("""
## The sweep

Run as `reshape` (`node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/reshape.bench.ts`, after the vocabulary
PR is on main and with Shane's yes). Its rows are pinned in data/reshape-edits/cells.json on the first run that finds it.
""")

code("""
OUT = HERE / "data" / "reshape-edits" / "cells.json"

def read_sweep():
    import subprocess, sys, tempfile
    sweep = wmlnb.find_sweep("reshape")
    runs = sorted(str(p) for p in sweep.glob("reshape-*/*/*/run.json"))
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "cells.json"
        subprocess.run([sys.executable, str(HERE / "reshape-edits" / "provenance.py"), str(out), *runs], check=True)
        return json.loads(out.read_text())

try:
    cells = pd.DataFrame(wmlnb.extract(OUT, read_sweep, source={"sweep": "reshape", "reader": "reshape-edits/provenance.py"}))
except (FileNotFoundError, LookupError) as e:
    cells = None
    print(f"No reshape sweep yet ({type(e).__name__}): it runs once the vocabulary PR is on main (ruling 63).")
""")

md("""
## The route each run's first cell took, by arm and model
""")

code("""
if cells is not None:
    cells["outcome"] = cells.apply(lambda r: "inside" if r.inside else ("edit" if r.mutation else ("other refusal" if r.refused else "asked, no reason")), axis=1)
    runs = cells.drop_duplicates("run")
    display(runs.groupby(["arm", "model", "route"]).size().unstack(fill_value=0))
    display(cells.groupby(["arm", "route", "outcome"]).size().unstack(fill_value=0))
""")

md("""
## Refused edits, by who made the value: the two `tables` routes, apart

Per cell: each refused edit, by route, arm and maker. Per run: of the runs on each counted route (`runs`, the
denominator), how many have at least one refused edit of each maker.
""")

code("""
if cells is not None:
    COUNTED = ["tables-url", "tables-path"]
    edits = cells[cells["mutation"].notna() & cells["route"].isin(COUNTED)]
    display(edits.groupby(["route", "arm", "maker"]).size().unstack(fill_value=0))
    display(edits.groupby(["route", "mutation", "maker"]).size().unstack(fill_value=0))
    counted = cells[cells["route"].isin(COUNTED)]
    per_run = counted.groupby(["route", "arm", "model"]).agg(runs=("run", "nunique"))
    for m in ["injected", "inside", "full", "alias", "unknown"]:
        hit = edits[edits["maker"] == m].groupby(["route", "arm", "model"])["run"].nunique()
        per_run[f"runs with {m}"] = hit.reindex(per_run.index, fill_value=0)
    display(per_run)
""")

md("""
## Ruling 64: build ruling 58, drop it, or read the edits

Fixed before any run (Shane, 2026-11-19). The unit is the run. A counted run is one in a hinted arm (`neutral-hint`,
`staged-hint`) whose first cell loads its files through `tables` (route `tables-url` or `tables-path`). A HIT is a counted
run with at least one refused edit on a value an earlier cell made: maker `inside` or `full`, or an `alias` of one of
those. An edit on the injected table, directly or through an alias, is reported apart and does not count; nor does
`unknown`.

- at least a quarter of the counted runs are hits: build ruling 58;
- under a tenth: drop it;
- in between: read which edits they are.

The fraction is the point estimate the rule is stated on; the 95% Wilson interval is printed beside it.
""")

code("""
import math
HINTED = ["neutral-hint", "staged-hint"]
TABLES = ["tables-url", "tables-path"]
EARLIER = {"inside", "full"}

def wilson(k, n, z=1.96):
    if n == 0: return (float("nan"), float("nan"))
    p = k / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (c - h, c + h)

def ruling64(rows):
    \"\"\"(hits, counted runs, fraction, Wilson interval, verdict, injected-only runs) over the hinted arms.\"\"\"
    df = pd.DataFrame(rows)
    counted = df[df["arm"].isin(HINTED) & df["route"].isin(TABLES)]
    n = counted["run"].nunique()
    edit = counted[counted["mutation"].notna()]
    earlier = edit["maker"].isin(EARLIER) | ((edit["maker"] == "alias") & edit["alias_of"].isin(EARLIER))
    injected = (edit["maker"] == "injected") | ((edit["maker"] == "alias") & (edit["alias_of"] == "injected"))
    k = edit[earlier]["run"].nunique()
    inj = edit[injected]["run"].nunique()
    frac = k / n if n else float("nan")
    verdict = "no counted runs" if n == 0 else "build ruling 58" if frac >= 0.25 else "drop ruling 58" if frac < 0.10 else "read which edits they are"
    return {"hits": k, "counted runs": n, "fraction": frac, "wilson 95%": wilson(k, n), "verdict": verdict, "runs with an injected edit": inj}

# the rule on synthetic rows: 4 counted runs (an unhinted run and a read_csv run are not counted), hits in r1 (full) and
# r2 (alias of inside); r3's edit is on the injected table through an alias, so it is reported apart
row = lambda run, arm, route, maker=None, alias_of=None: {"run": run, "arm": arm, "route": route, "mutation": "item" if maker else None, "maker": maker, "alias_of": alias_of}
synth = [row("r1", "neutral-hint", "tables-url", "full"), row("r2", "staged-hint", "tables-path", "alias", "inside"),
         row("r3", "staged-hint", "tables-url", "alias", "injected"), row("r4", "neutral-hint", "tables-url"),
         row("r5", "neutral", "tables-url", "inside"), row("r6", "neutral-hint", "read_csv-fetched", "inside")]
got = ruling64(synth)
assert (got["hits"], got["counted runs"], got["verdict"], got["runs with an injected edit"]) == (2, 4, "build ruling 58", 1), got
lo, hi = got["wilson 95%"]
assert 0.15 < lo < 0.16 and 0.84 < hi < 0.86, got["wilson 95%"]

if cells is None:
    print("No reshape sweep yet: ruling 64's fraction is not computed.")
else:
    r = ruling64(cells.to_dict("records"))
    lo, hi = r["wilson 95%"]
    print(f"{r['hits']} of {r['counted runs']} counted runs in the hinted arms have a refused edit on a value an earlier cell made: "
          f"{r['fraction']:.3f} (95% Wilson {lo:.3f} to {hi:.3f}). Verdict: {r['verdict']}.")
    print(f"Reported apart: {r['runs with an injected edit']} counted runs with a refused edit on the injected table.")
""")

nb = nbf.v4.new_notebook()
nb["cells"] = cells
nb["metadata"]["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "reshape-edits.ipynb")
