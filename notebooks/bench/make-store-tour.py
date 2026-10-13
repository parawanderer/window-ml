"""make-store-tour.py — builds store-tour.ipynb: what the bench store on mlbox holds (sweeps, models, runs, traces), read
through `wmlnb.store()`, and the pattern for a notebook that reads the store.

    node scripts/nb.mjs make notebooks/bench/store-tour.ipynb

The cells are written here; edit this file, not the notebook. Their numbers come from data/store-tour/*.json, extracted
from the store (NB_REFRESH=1 reads the store again, which needs BENCH_STORE_* in .env and mlbox reachable).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# The bench store: what it holds

`tests/e2e/bench/sync.mjs` pushes every sweep to Garage on mlbox: the score rows, model calls, price snapshots and box
frames as Parquet (deduplicated by the store's own `views.sql`), and each run's folder as plain files under
`traces/<sweep>/`. `wmlnb.store()` opens it as DuckDB with those views loaded. This notebook is the inventory, and the
pattern to copy: query the views inside `wmlnb.extract`, so the numbers stay pinned while the store keeps growing.
""")

code("""
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "bench"
DATA = HERE / "data" / "store-tour"
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

One row per sweep and model from the `scores` view, and the number of run folders each sweep has under `traces/`.
""")

code("""
BY_MODEL = '''
SELECT sweep, model, local::BOOLEAN AS local, count(*) AS runs,
       sum(CASE WHEN scored = 1 THEN 1 ELSE 0 END) AS scored, sum(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
       sum(tokens) AS tokens, round(sum(secs) / 60, 1) AS minutes,
       min("at") AS first_at, max("at") AS last_at, count(DISTINCT "by") AS clones
FROM scores GROUP BY ALL ORDER BY sweep, model'''

def traces():
    bucket = con().sql("SELECT getvariable('wml_bucket')").fetchone()[0]
    q = f"SELECT split_part(file, '/', 5) AS sweep, count(*) AS run_dirs FROM glob('s3://{bucket}/traces/**/cell.json') GROUP BY 1 ORDER BY 1"
    return con().sql(q).df().to_dict("records")

by_model = pd.DataFrame(wmlnb.extract(DATA / "by-model.json", lambda: con().sql(BY_MODEL).df().astype({"first_at": str, "last_at": str}).to_dict("records"),
                                      source={"store": "bench store (sync.mjs)", "view": "scores", "query": BY_MODEL.strip()}))
trace_dirs = pd.DataFrame(wmlnb.extract(DATA / "traces.json", traces, source={"store": "bench store (sync.mjs)", "glob": "traces/**/cell.json"}))
pd.DataFrame(wmlnb.provenance(DATA / "by-model.json", DATA / "traces.json"))
""")

md("""
## Sweeps

Runs and models per sweep, how many runs carry a pass/fail score (an interview has none: it is read, not scored), and
whether the run folders are in the store as well as the rows.
""")

code("""
sweeps = (by_model.groupby("sweep")
          .agg(runs=("runs", "sum"), models=("model", "nunique"), local_models=("local", "sum"), scored=("scored", "sum"),
               passed=("passed", "sum"), minutes=("minutes", "sum"), first=("first_at", "min"), last=("last_at", "max"))
          .join(trace_dirs.set_index("sweep"), how="outer").fillna({"run_dirs": 0})
          .sort_values("last", ascending=False))
sweeps = sweeps.fillna({"runs": 0, "models": 0, "local_models": 0, "scored": 0, "passed": 0})
sweeps["first"] = sweeps["first"].str[:10]
sweeps["last"] = sweeps["last"].str[:10]
sweeps.astype({c: int for c in ["runs", "models", "local_models", "scored", "passed", "run_dirs"]})
""")

md("""
A sweep with `run_dirs` but no `runs` has folders in the store that no clone's score log has pushed yet. The reverse
(rows, no folders) is a sweep pushed with `--only-db`, one whose push of its folders failed, or one whose folders the
push does not recognise: `cuts2-recheck` (2026-10-13 extract), which `sync.mjs status` counts as "0 of 0 runs".
""")

md("""
## Models

Each model across every sweep: how much of the store is about it.
""")

code("""
(by_model.groupby("model")
 .agg(sweeps=("sweep", "nunique"), runs=("runs", "sum"), local=("local", "max"), scored=("scored", "sum"),
      passed=("passed", "sum"), tokens=("tokens", "sum"), minutes=("minutes", "sum"))
 .assign(pass_rate=lambda d: (d.passed / d.scored).where(d.scored > 0).round(2))
 .sort_values("runs", ascending=False))
""")

md("""
## One sweep: the shell-shapes interview on local models

`panel-shell-shapes` (2026-10-13) put the `ml.sh` API-shape interview to eight Ollama models
(`tests/e2e/panel/shell-shapes.md` has the scored results). What the store's rows add is the cost: tokens and minutes
per model for the same eight turns. Tokens count every call's whole prompt again (the interview's history grows each
turn), so they measure context carried, not text written.
""")

code("""
(by_model[by_model.sweep == "panel-shell-shapes"][["model", "tokens", "minutes"]]
 .astype({"tokens": int}).sort_values("minutes").reset_index(drop=True))
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "store-tour.ipynb")
print("wrote", HERE / "store-tour.ipynb")
