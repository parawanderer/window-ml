"""make-spend-to-date.py — builds spend-to-date.ipynb: how big the bench panel is and what its cloud calls have cost, read
from the bench store and priced by the bench's own pricer (price-calls.mjs over tests/e2e/bench/cost.mjs).

    node scripts/nb.mjs make notebooks/bench/spend-to-date.ipynb

The cells are written here; edit this file, not the notebook. Its rows come from data/spend-to-date/*.json, extracted
from the store's `scores`, `calls` and `price_snapshots` views (NB_REFRESH=1 reads the store again, which needs
BENCH_STORE_* in .env and mlbox reachable, and node with the repository's node_modules).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# The bench panel: size and spend to date

Every run the bench store holds, and every model call those runs made, priced against the price snapshot the call ran
under (`docs/dev/e2e-harness.md`; `tests/e2e/bench/spend.mjs` is the same sum for one checkout's scores). A call is
priced by the bench's own code, `price-calls.mjs` beside this notebook, so the join from a model to its price is the
one the scoreboard uses, not a second copy of it.
""")

code("""
import json, subprocess, tempfile
from pathlib import Path
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "bench"
DATA = HERE / "data" / "spend-to-date"
pd.set_option("display.width", 160)

_con = None
def con():
    \"\"\"The store, opened only when an extract has to read it (a pinned run never connects).\"\"\"
    global _con
    _con = _con or wmlnb.store()
    return _con
""")

md("""
## The rows, pinned

The store is at-least-once: overlapping pushes put a row in several objects. Its views keep one row per key: a run per
`run`, a call per (`run`, `call`), a price snapshot per `hash`. The runs are kept whole; the calls are kept as their
priced result only (the snapshot bodies are megabytes each, and only their prices matter here).
""")

code("""
RUNS = '''
SELECT run, sweep, model, task, local::BOOLEAN AS local, scored, passed, "at" FROM scores ORDER BY "at"'''
CALLS = '''SELECT run, call, kind, model, usage FROM calls'''
SNAPSHOTS = '''SELECT hash, body FROM price_snapshots'''

def priced_calls():
    # Rows as plain dicts, not a DataFrame's: pandas turns a missing model into NaN, which is not JSON.
    rel = con().sql(CALLS)
    calls = [dict(zip(rel.columns, r)) for r in rel.fetchall()]
    drivers = dict(con().sql("SELECT run, model FROM scores").fetchall())
    snapshots = dict(con().sql(SNAPSHOTS).fetchall())
    with tempfile.TemporaryDirectory() as d:
        src, out = Path(d) / "in.json", Path(d) / "out.json"
        src.write_text(json.dumps({"calls": calls, "drivers": drivers, "snapshots": snapshots}, default=int))
        subprocess.run(["npx", "tsx", str(HERE / "price-calls.mjs"), str(src), str(out)], cwd=wmlnb.ROOT, check=True)
        return json.loads(out.read_text())

runs = pd.DataFrame(wmlnb.extract(DATA / "runs.json", lambda: con().sql(RUNS).df().astype({"at": str}).to_dict("records"),
                                  source={"store": "bench store (sync.mjs)", "view": "scores", "query": RUNS.strip()}))
calls = pd.DataFrame(wmlnb.extract(DATA / "priced-calls.json", priced_calls,
                                   source={"store": "bench store (sync.mjs)", "views": ["calls", "scores", "price_snapshots"],
                                           "query": CALLS, "priced_by": "notebooks/bench/price-calls.mjs (tests/e2e/bench/cost.mjs)"}))
pd.DataFrame(wmlnb.provenance(DATA / "runs.json", DATA / "priced-calls.json"))
""")

md("""
## The panel
""")

code("""
pd.Series({"runs": len(runs), "models": runs.model.nunique(), "local models": runs[runs.local == True].model.nunique(),
           "tasks": runs.task.nunique(), "sweeps": runs.sweep.nunique(), "first": runs["at"].min()[:10], "last": runs["at"].max()[:10]})
""")

md("""
## Spend

`computed` is the call's tokens at its snapshot's prices; `reported` is what the provider said the call cost, where it
said so. A call on a local model costs electricity, not tokens, and is counted apart. Each call's model is its run's
driver when the call does not name one, as the scoreboard reads it.
""")

code("""
calls["driver"] = calls.run.map(dict(zip(runs.run, runs.model)))
calls["state"] = calls.apply(lambda c: "local" if c.local else "priced" if pd.notna(c.computed) else "reported only" if pd.notna(c.reported) else "unpriced", axis=1)
total = pd.Series({"calls": len(calls), "computed USD": round(calls.computed.sum(), 2), "priced calls": int(calls.computed.notna().sum()),
                   "reported USD": round(calls.reported.sum(), 2), "reported calls": int(calls.reported.notna().sum()),
                   "local calls": int(calls.local.sum()), "unpriced calls": int((calls.state == "unpriced").sum())})
total
""")

code("""
(calls[calls.computed.notna()].groupby("driver").agg(calls=("call", "size"), computed_usd=("computed", "sum"))
 .round({"computed_usd": 2}).sort_values("computed_usd", ascending=False))
""")

md("""
## The undercount

A cloud call with no price snapshot is in neither sum. Most of them ran before the bench set a price service at all; the
rest are the first calls of a cell. Each cell starts in a fresh browser profile with no snapshot, a call waits 15 s for
the first one and then runs without it, and the refresh took longer than that: on panel-policy-sh the first two of every
cloud cell's four calls went unpriced. #950 (2026-10-21) has the bench fetch the snapshot before a cell's first turn, so
sweeps from then on price every call; the sweeps before it stay undercounted.
""")

code("""
un = calls[calls.state == "unpriced"]
print(f"{len(un)} unpriced calls ({len(un) / len(calls):.0%} of all calls), by reason:")
display(un.why.value_counts().to_frame("calls"))
sweep = calls.run.map(dict(zip(runs.run, runs.sweep)))
(pd.DataFrame({"sweep": sweep, "unpriced": calls.state == "unpriced", "priced": calls.state == "priced"})
 .groupby("sweep").sum().query("unpriced > 0 and priced > 0").sort_values("unpriced", ascending=False).head(15))
""")

md("""
The table lists the sweeps that have priced AND unpriced calls: the ones where the fresh-profile bug cost a cell its
first calls' prices, rather than sweeps that ran with no price service.

Not in the store at all (checked 2026-10-21 against the local scoreboards of four checkouts): 3,760 calls of sweeps whose
rows were pushed before the store kept calls (`prompt-budget-tool-details`, `tool-details-v2` and others). They are in
the checkouts' own `scores.sqlite`, and a `sync.mjs push` from those checkouts would add them.
""")

nb = nbf.v4.new_notebook()
nb["cells"] = cells
nb["metadata"] = {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}}
out = HERE / "spend-to-date.ipynb"
if out.exists():
    old = nbf.read(out, as_version=4)
    for new, prev in zip(nb["cells"], old["cells"]):
        if new["source"] == prev["source"]:
            new["metadata"] = prev.get("metadata", {})
nbf.write(nb, out)
