"""make-prompt-cuts2.py — builds prompt-cuts2.ipynb: does prompt-budget round 2 (locate and python_exec option texts
moved to agent_api_docs, the private-rendering error leading with its retry) cost any model a pass?

    .venv/bin/python notebooks/bench/make-prompt-cuts2.py && node scripts/nb.mjs run notebooks/bench/prompt-cuts2.ipynb
    (or: node scripts/nb.mjs make notebooks/bench/prompt-cuts2.ipynb)

The cells are written here; edit this file, not the notebook. Their numbers come from data/prompt-cuts2/runs.json, the
runs extracted from the sweeps' folders (NB_REFRESH=1 extracts again from SWEEP_ROOT).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Prompt budget, round 2: does any model lose a pass?

Round 2 (`__ML_PROMPT_VARIANT__="cuts2"`, `src/tools/tool-details.ts`) moves `locate`'s option texts and
`python_exec`'s `tables`/`cast`/`mode` texts out of every call and into `agent_api_docs({ tool })`, and makes the
"Incognito is off" rendering error lead with the retry that works. The ship rule (`docs/dev/prompt-review.md`): **no
model's pass rate drops.** Each task needs something that moved, and is scored from the run itself.

Sweeps read here:

- `prompt-budget-cuts2`: 11 models x 4 tasks x 2 prompts x 3 repeats (the first look).
- `cuts2-recheck2`: the three models that dropped there (MiniMax M3, qwen3.6, glm-4.7-flash), x 8 repeats, on main
  `1eb1448c` plus the variant.
- `cuts2-python-fix` (MiniMax) and `cuts2-python-fix-glm` (glm-4.7-flash): the two table tasks, x 8, after one
  sentence was added to the short `tables` text.
""")

code("""
import json, os
from pathlib import Path
import pandas as pd
from scipy.stats import fisher_exact
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "bench"
SWEEP_ROOT = Path(os.environ.get("SWEEP_ROOT", Path.home() / "git/window-ml-cuts2/tests/e2e/artifacts/bench"))
SWEEPS = ["prompt-budget-cuts2", "cuts2-recheck2", "cuts2-python-fix", "cuts2-python-fix-glm"]
FIX_SWEEPS = ["cuts2-python-fix", "cuts2-python-fix-glm"]
EXTRACT = HERE / "data" / "prompt-cuts2" / "runs.json"
pd.set_option("display.width", 160)
""")

md("""
## The runs, pinned

One row per run, read from each run's `cell.json` (outcome, tokens, answer) and `run.json` (its steps). The rows are
kept in `data/prompt-cuts2/runs.json`, so the numbers below do not depend on the sweep folders still existing.
""")

code("""
def read_sweeps():
    rows = []
    for sweep in SWEEPS:
        for cell in sorted((SWEEP_ROOT / sweep).glob("*/*/r*/cell.json")):
            if "history" in cell.parts:
                continue
            c = json.loads(cell.read_text())
            m = c.get("measurement") or {}
            steps = json.loads((cell.parent / "run.json").read_text())["session"]["steps"] if (cell.parent / "run.json").exists() else []
            tools = [s.get("tool") for s in steps if s.get("tool")]
            py_code = [str((s.get("arguments") or {}).get("code", "")) for s in steps if s.get("tool") == "python_exec"]
            rows.append({
                "sweep": sweep, "task": c["taskId"], "prompt": c["combo"]["prompt"], "model": c["combo"]["model"],
                "repeat": c["repeat"], "passed": bool(m.get("succeeded")), "hit_cap": bool(m.get("hitCap")),
                "steps": m.get("steps"), "calls": sum(1 for s in steps if s.get("usage")),
                "prompt_tokens": (m.get("tokens") or {}).get("prompt"),
                "answer": (m.get("finalAnswer") or m.get("answer") or "")[:160],
                "tools": tools, "tables_in_code": any("tables=" in s for s in py_code),
            })
    return rows

rows = wmlnb.extract(EXTRACT, read_sweeps, source={"sweeps": SWEEPS, "sweep_root": "~/git/window-ml-cuts2/tests/e2e/artifacts/bench"})
runs = pd.DataFrame(rows)
pd.DataFrame(wmlnb.provenance(EXTRACT))
""")

md("## Passes per model, current prompt vs round 2")

code("""
def passes(df):
    t = df.pivot_table(index="model", columns="prompt", values="passed", aggfunc=["sum", "count"])
    out = pd.DataFrame({p: t["sum"][p].astype(int).astype(str) + "/" + t["count"][p].astype(str) for p in ["current", "cuts2"]})
    out["change"] = t["sum"]["cuts2"] - t["sum"]["current"]
    return out.sort_values("change")

passes(runs[runs.sweep == "prompt-budget-cuts2"])
""")

code("""
recheck = runs[runs.sweep == "cuts2-recheck2"]
passes(recheck)
""")

md("""
Per task, for the recheck. A drop concentrated in one task points at the text that task needs.
""")

code("""
recheck.pivot_table(index=["model", "task"], columns="prompt", values="passed", aggfunc="sum").astype(int)
""")

md("""
## Is a drop more than noise?

Fisher's exact test on each model's 2x2 table (passes and failures under each prompt), one-sided towards round 2
being worse. Pooled: both sweeps together, for the models in both.
""")

code("""
def fisher(df):
    out = []
    for model, g in df.groupby("model"):
        a = g[g.prompt == "current"].passed; b = g[g.prompt == "cuts2"].passed
        table = [[a.sum(), len(a) - a.sum()], [b.sum(), len(b) - b.sum()]]
        out.append({"model": model, "current": f"{a.sum()}/{len(a)}", "cuts2": f"{b.sum()}/{len(b)}",
                    "p (cuts2 worse)": round(fisher_exact(table, alternative="greater").pvalue, 3)})
    return pd.DataFrame(out).set_index("model")

both = runs[runs.sweep.isin(["prompt-budget-cuts2", "cuts2-recheck2"]) & runs.model.isin(recheck.model.unique())]
pd.concat({"recheck": fisher(recheck), "pooled": fisher(both)}, axis=1)
""")

md("""
## Why each round-2 failure failed

Classified from the run's own steps, in this order: the step cap; `tables=` written inside the Python code instead of
passed as the argument; a table task answered without `python_exec`; the right status read but clicked through `exec`
(the task's check asks for the `click` tool); otherwise an answer not taken from the page.
""")

code("""
TABLE_TASKS = {"csv-total", "table-north-q3"}

def why(r):
    if r.hit_cap: return "step cap"
    if r.tables_in_code: return "tables= written in the code"
    if r.task in TABLE_TASKS and "python_exec" not in r.tools: return "table task without python_exec"
    if r.task == "icon-heart" and "Clicked: heart" in r.answer and "click" not in r.tools: return "clicked via exec (scoring)"
    return "answer not from the page"

failed = recheck[~recheck.passed].copy()
failed["why"] = failed.apply(why, axis=1)
failed.pivot_table(index=["model", "why"], columns="prompt", values="repeat", aggfunc="count", fill_value=0)
""")

md("""
## After one sentence: the table tasks again

`PYTHON_SHORT.tables` gained "Pass it HERE, not in your code: the code then just uses `df` (or each name)." Both
prompts were re-run on the same build, so the comparison is within this sweep only.
""")

code("""
fix = runs[runs.sweep.isin(FIX_SWEEPS)]
fix.pivot_table(index=["model", "task"], columns="prompt", values="passed", aggfunc=["sum", "count"])
""")

md("## What the cut saves: prompt tokens per model call")

code("""
r = recheck[recheck.calls > 0].assign(per_call=lambda d: d.prompt_tokens / d.calls)
t = r.pivot_table(index="model", columns="prompt", values="per_call", aggfunc="mean").round(0)
t["saved"] = (1 - t["cuts2"] / t["current"]).map("{:.1%}".format)
t
""")

md("""
## The ship rule

A model fails the rule when it passes fewer runs under round 2 than under the current prompt in the recheck, after
setting aside failures the classification attributes to scoring. For a model re-run after the fix, those runs replace
the recheck's on the table tasks.
""")

code("""
def verdict():
    out = []
    for model, g in recheck.groupby("model"):
        g = g.copy()
        g["counted"] = g.passed | g.apply(lambda r: not r.passed and why(r) == "clicked via exec (scoring)", axis=1)
        refit = fix[fix.model == model]
        if len(refit):
            g = pd.concat([g[~g.task.isin(TABLE_TASKS)], refit.assign(counted=refit.passed)])
        cur, cut = g[g.prompt == "current"].counted.sum(), g[g.prompt == "cuts2"].counted.sum()
        a = [[cur, len(g[g.prompt == "current"]) - cur], [cut, len(g[g.prompt == "cuts2"]) - cut]]
        out.append({"model": model, "current": int(cur), "cuts2": int(cut), "re-run after fix": bool(len(refit)),
                    "holds": bool(cut >= cur), "p (cuts2 worse)": round(fisher_exact(a, alternative="greater").pvalue, 3)})
    return pd.DataFrame(out).set_index("model")

verdict()
""")

md("""
## Why glm-4.7-flash still lost csv-total after the fix

The same classification over glm's table-task runs, the recheck and the re-run after the fix together. A class that
appears under one prompt only is a behaviour that prompt caused.
""")

code("""
glm = runs[runs.sweep.isin(["cuts2-recheck2", *FIX_SWEEPS]) & (runs.model == "glm-4.7-flash:latest") & runs.task.isin(TABLE_TASKS)]
g = glm[~glm.passed].assign(why=lambda d: d.apply(why, axis=1))
passed = glm.pivot_table(index="task", columns="prompt", values="passed", aggfunc=["sum", "count"])
display(passed)
g.pivot_table(index=["task", "why"], columns="prompt", values="repeat", aggfunc="count", fill_value=0)
""")

md("""
## Decision (2026-10-10)

Shipped: the `locate` cut and the private-rendering error that leads with its retry. Not shipped: the `python_exec`
cut. With the `tables` fix MiniMax recovered on the table tasks, but glm-4.7-flash gave up on csv-total without
calling `python_exec` only under the cut (the table above), so `python_exec` keeps its full texts and cannot have
regressed. The `locate` cut held on icon-heart for qwen3.6 and glm-4.7-flash; MiniMax's remaining gap there is one
run in eight. The record is `docs/spec/PROMPT_BUDGET.md`.
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "prompt-cuts2.ipynb")
print("wrote", HERE / "prompt-cuts2.ipynb")
