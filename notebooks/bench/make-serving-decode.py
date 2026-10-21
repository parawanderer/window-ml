"""make-serving-decode.py — builds serving-decode.ipynb: how close the Ollama fork's decode-speed prediction
(`predicted_decode` on `gen.end`, `ollama-slop:genpredict`) came to the speed each generation actually ran at.

    node scripts/nb.mjs make notebooks/bench/serving-decode.ipynb

The cells are written here; edit this file, not the notebook. Its rows come from data/serving-decode/gen-end.json,
extracted from the bench store's `box_frames` view (NB_REFRESH=1 reads the store again, which needs BENCH_STORE_* in
.env and mlbox reachable).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Serving layer: the decode-speed prediction against recorded use

Before a generation runs, the forked Ollama predicts its decode speed and sends it on that generation's `gen.end`
frame as `predicted_decode.ms_per_token`. `basis` is `profile` (the card's measured bandwidth and per-token costs) or
`profile_corrected` (that, scaled by the model's own earlier clean generations: `correction_samples` of them). The same
frame carries what happened: `timings.eval_ms` over `timings.decoded` tokens. This notebook compares the two for every
generation the bench store holds (`docs/FORKED-BACKENDS.md`, "Measured decode speed").
""")

code("""
import json
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "bench"
DATA = HERE / "data" / "serving-decode"
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

Every `gen.end` frame that carries a prediction, one per frame: the `box_frames` view keeps one row per
(box, server_at, kind, digest), since overlapping pushes put a frame in the store more than once.
""")

code("""
GEN_END = '''
SELECT box, "at", frame FROM box_frames
WHERE kind = 'gen.end' AND frame LIKE '%predicted_decode%' ORDER BY "at"'''

def gen_ends():
    out = []
    for box, at, frame in con().sql(GEN_END).fetchall():
        f = json.loads(frame)
        p, t = f.get("predicted_decode") or {}, f.get("timings") or {}
        out.append({"box": box, "at": at, "model": f.get("model"), "basis": p.get("basis"), "predicted_ms": p.get("ms_per_token"),
                    "profile_ms": p.get("profile_ms_per_token"), "correction": p.get("correction_factor"),
                    "samples": p.get("correction_samples"), "decoded": t.get("decoded"), "eval_ms": t.get("eval_ms")})
    return out

gens = pd.DataFrame(wmlnb.extract(DATA / "gen-end.json", gen_ends,
                                  source={"store": "bench store (sync.mjs)", "view": "box_frames", "query": GEN_END.strip()}))
pd.DataFrame(wmlnb.provenance(DATA / "gen-end.json"))
""")

md("""
## The error

Actual speed is `eval_ms / decoded`. A generation of fewer than 32 tokens is left out: its decode time is a handful of
milliseconds, and a scheduling hiccup dominates it. The error is `(predicted - actual) / actual`, so a negative error is
a prediction that was too fast.
""")

code("""
g = gens.dropna(subset=["predicted_ms", "decoded", "eval_ms"])
g = g[(g.decoded >= 32) & (g.eval_ms > 0) & (g.predicted_ms > 0)].copy()
g["actual_ms"] = g.eval_ms / g.decoded
g["err"] = (g.predicted_ms - g.actual_ms) / g.actual_ms
g["abs_err"] = g.err.abs()
first, last = pd.to_datetime(g["at"].min(), unit="ms"), pd.to_datetime(g["at"].max(), unit="ms")
print(f"{len(gens)} gen.end frames with a prediction; {len(g)} with >= 32 decoded tokens, {g.model.nunique()} models, {first:%Y-%m-%d} to {last:%Y-%m-%d}")

def summary(d):
    return pd.Series({"n": len(d), "median |err| %": round(d.abs_err.median() * 100, 1), "median signed %": round(d.err.median() * 100, 1),
                      "within 10 %": round((d.abs_err <= 0.10).mean() * 100), "p90 |err| %": round(d.abs_err.quantile(0.9) * 100, 1)})

pd.concat({"all": summary(g), **{b: summary(d) for b, d in g.groupby("basis")}}, axis=1).T
""")

md("""
The corrected prediction is the one the server makes once a model has clean generations to learn from, and almost
every generation has it. The uncorrected `profile` basis runs too fast by about three quarters: the card's raw
bandwidth model alone is not a usable prediction, and the correction is what makes it one.
""")

md("""
## By model

Where the long tail comes from.
""")

code("""
(g.groupby("model").apply(summary, include_groups=False)
 .astype({"n": int}).sort_values("n", ascending=False))
""")

nb = nbf.v4.new_notebook()
nb["cells"] = cells
nb["metadata"] = {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}}
out = HERE / "serving-decode.ipynb"
if out.exists():
    old = nbf.read(out, as_version=4)
    for new, prev in zip(nb["cells"], old["cells"]):
        if new["source"] == prev["source"]:
            new["metadata"] = prev.get("metadata", {})
nbf.write(nb, out)
