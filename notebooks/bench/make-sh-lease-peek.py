"""make-sh-lease-peek.py — builds sh-lease-peek.ipynb: does the host's `peek` (a detached ml.sh task's `tail` shows the
running call's latest output; host v0.9.0, window-ml #1586) change what models do with a detached call, and does a 5 s
lease tax a 10 s call?

    node scripts/nb.mjs make notebooks/bench/sh-lease-peek.ipynb

The cells are written here; edit this file, not the notebook. The numbers come from data/sh-lease-peek/runs.json (one
row per run, extracted from the sweep's folder; NB_REFRESH=1 extracts again). The first sh-lease notebook's build arm
is read from data/sh-lease/runs.json for the comparison. The sweep's name is SWEEP below; `wmlnb.find_sweep` finds it
in any clone, and SWEEP_ROOT in the environment is tried first.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

REC = HERE / "data" / "sh-lease-peek" / "RECOMMENDATION.md"
RECOMMENDATION = REC.read_text().strip() if REC.exists() else "_(written once the sweep is in)_"

md(f"""
# ml.sh lease with peek: does a tail show progress, and what does a short lease cost a 10 s call

{RECOMMENDATION}

**The question.** The [2026-11-07 matrix](sh-lease.ipynb) could not measure the `build` task's progress: the host had
no `peek`, so a `task` `tail` on a running call returned nothing. Host v0.9.0 has it (window-ml #1586), so a tail on a
running detached call now shows the latest output. This re-run asks:
1. Do models tail a running call, and does the tail return output (the peek effect)?
2. Does the final answer mention progress ("unit 5/8", "tests: 18 done"), apart from the result token?
3. Does it change task turns per detached `build`, against the first matrix?
4. For the new `tests` task (10 s, progress every 2 s, then `TESTS OK 31 passed 5d81b4`): does the 5 s lease tax a
   10 s call, in detach rate and extra turns, against the 15 s and 60 s leases (which should not detach it)?

**The matrix** (`tests/e2e/bench/specs/sh-lease.bench.ts`): three local models (gemma4:31b, gemma4:e4b,
qwen3.8-flash-next:vision) × leases 5, 15 and 60 s × tasks `build` (40 s, "build: unit N/8 done" every 5 s, ends
`BUILD OK 7f3a19`) and `tests` (10 s, "tests: N done" every 2 s, ends `TESTS OK 31 passed 5d81b4`); 5 repeats each,
90 runs. The task text never mentions `expectMs`, leases, tasks or progress.
""")

md("""
## Conditions

- **Image** `wml-sh-lease:peek`, a Linux container with bwrap (`tests/e2e/docker/sh-lease.Dockerfile`).
- **window-ml** `a4f57637` (the sweep's fingerprint).
- **wmlhost** v0.9.0, `5fd151e2`, with `peek`.
- **Approvals.** `autoApproveReadonly` as in the first notebook.
- **Compared with.** The 2026-11-07 build arm (`data/sh-lease/runs.json`, fingerprint `bc0edb7e`, host `ae7284e`, no
  peek). The code differs in more than the host, so a difference is the host's `peek` plus whatever else changed.
- **How a tail is classified.** A `task` step with `op: tail` is a tail. It is LIVE when its result is not a finished
  task (`task <id> done …`): the call was still running. It RETURNED OUTPUT when the result is a `stdout (N B so far…)`
  block with at least one line under the header. A tail on a finished task is not counted as peek.
""")

code("""
import json, os, re
from pathlib import Path
import numpy as np
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "bench"
SWEEP = "sh-lease-peek-20261112"   # the finished sweep's name; falls back to the in-flight folder below
FALLBACK = "sh-lease"              # what the container run writes before it is renamed (found under SWEEP_ROOT)
EXTRACT = HERE / "data" / "sh-lease-peek" / "runs.json"
FIRST = HERE / "data" / "sh-lease" / "runs.json"
PROGRESS = re.compile(r"unit\\s*\\d+\\s*(?:/|of)\\s*8|\\d+\\s*(?:/|of)\\s*8\\s*units?|tests:\\s*\\d+\\s*done|\\d+\\s*tests?\\s*(?:done|so far)|progress", re.I)
pd.set_option("display.width", 180)
pd.set_option("display.max_colwidth", 80)
""")

md("""
## The runs, pinned

One row per run, from `cell.json` (outcome, tokens, answer) and `run.json` (steps). The reader is the first notebook's,
with the tail classification added: for each `task` `tail`, whether the call was still running and whether the result
held output. `progress_in_answer` looks for "unit N/8", "tests: N done" or the word "progress" in the final answer.
""")

code(r'''
def _ts(s):
    return pd.Timestamp(s).timestamp()

def _find():
    try:
        return wmlnb.find_sweep(SWEEP)
    except FileNotFoundError:
        pass
    # The in-flight container run: SWEEP_ROOT may be the artifacts folder (holding bench/) or the bench folder itself.
    root = os.environ.get("SWEEP_ROOT")
    for r in ([Path(root), Path(root) / "bench"] if root else []):
        if (r / FALLBACK).is_dir():
            return r / FALLBACK
    return wmlnb.find_sweep(FALLBACK)

def classify_tail(r):
    """(live, has_output) for a tail's result text."""
    r = str(r or "")
    live = bool(r.strip()) and not re.match(r"task \S+ done", r)
    body = r.split("\n")[1:] if "so far" in r.split("\n")[0] else []
    lines = [l for l in body if l.strip() and not re.match(r"std(out|err):\s*(empty|$)", l.strip()) and not l.startswith("stderr:")]
    return live, bool("so far" in r and lines)

def read_run(cell_path, meta):
    c = json.loads(cell_path.read_text())
    m = c.get("measurement") or {}
    run = json.loads((cell_path.parent / "run.json").read_text())["session"]
    steps = run["steps"]
    calls, ops = [], {"await": 0, "await_still": 0, "tail": 0, "cancel": 0}
    first_det_at = first_call_at = None
    tails_live = tails_data = tails_null = 0
    got_result = outlived = False
    results = []
    for s in steps:
        tool, r = s.get("tool"), str(s.get("result", ""))
        if not tool:
            continue
        results.append(r)
        js = str((s.get("arguments") or {}).get("js", ""))
        if tool == "exec" and re.search(r"\bml\.sh\b", js):
            det = "Detached:" in r
            calls.append({"expect": bool(re.search(r"expectMs\s*:", js)), "before_det": first_det_at is None,
                          "detached": det, "not_fn": "ml.sh is not a function" in r,
                          "reached": det or "host-sandbox" in r or "host-plain" in r})
            if calls[-1]["reached"] and first_call_at is None:
                first_call_at = _ts(s["at"])
            if det and first_det_at is None:
                first_det_at = _ts(s["at"])
            outlived |= det and "you expected ~" in r
        if tool == "task":
            op = (s.get("arguments") or {}).get("op")
            if op in ops:
                ops[op] += 1
            if op == "await" and "still running" in r:
                ops["await_still"] += 1
            if op == "tail":
                live, data = classify_tail(s.get("result"))
                tails_live += live
                tails_data += data
                tails_null += not r.strip()
            if "you expected it within" in r:
                outlived = True
            got_result |= " done" in r[:60]
    answer = m.get("finalAnswer") or m.get("answer") or ""
    toks = m.get("tokens") or {}
    return {
        "task": c["taskId"], "model": c["combo"]["model"], "lease_s": c["combo"]["leaseMs"] // 1000, "repeat": c["repeat"],
        "fingerprint": meta["fingerprint"], "correct": bool(m.get("succeeded")), "hit_cap": bool(m.get("hitCap")),
        "steps": m.get("steps"), "run_s": (m.get("runMs") or 0) / 1000,
        "prompt_tokens": toks.get("prompt"), "completion_tokens": toks.get("completion"),
        "sh_calls": len(calls), "not_fn_calls": sum(x["not_fn"] for x in calls),
        "reached_host": any(x["reached"] for x in calls), "detached": first_det_at is not None,
        "expect_before_det": any(x["expect"] and x["before_det"] for x in calls if x["reached"]),
        "outlived_estimate": outlived, "task_ops": sum(ops[k] for k in ("await", "tail", "cancel")),
        **{f"op_{k}": v for k, v in ops.items()},
        "tails_live": tails_live, "tails_with_output": tails_data, "tails_empty": tails_null,
        "result_via_task": got_result, "progress_in_answer": bool(PROGRESS.search(answer)), "answer": answer[:400],
    }

def read_sweep():
    d = _find()
    recs = [json.loads(l) for l in (d / "sweeps.jsonl").read_text().splitlines() if l.strip()]
    sw = [r for r in recs if r.get("op") == "sweep"][-1]
    meta = {"fingerprint": sw.get("fingerprint")}
    return [read_run(c, meta) for c in sorted(d.glob("*/*/r*/cell.json"))
            if "history" not in c.parts and (c.parent / "run.json").exists()]

data = wmlnb.extract(EXTRACT, read_sweep, source={"sweep": SWEEP, "fallback": FALLBACK,
                                                  "sweep_root": "~/git/window-ml-bench/tests/e2e/artifacts/bench"})
runs = pd.DataFrame(data)
first = pd.DataFrame(json.loads(FIRST.read_text())["rows"])
first = first[first.sweep == "rerun"] if "sweep" in first else first
pd.DataFrame(wmlnb.provenance(EXTRACT, FIRST))
''')

code("""
pd.DataFrame({"runs": runs.groupby("task").size(), "reached host": runs[runs.reached_host].groupby("task").size()}).fillna(0).astype(int)
""")

md("""
## 1. Correct rate, `k/n` per model × lease

Over the repeats of each cell; `n` is below 5 while the sweep is partial.
""")

code("""
def kof(s):
    return f"{int(s.sum())}/{len(s)}"

runs.pivot_table(index=["task", "model"], columns="lease_s", values="correct", aggfunc=kof)
""")

code("""
g = runs.groupby(["task", "lease_s"]).correct.agg(["sum", "count"])
g["rate"] = (g["sum"] / g["count"]).round(2)
g
""")

md("""
## 2. Detached runs and task turns

`task turns` are `await` + `tail` + `cancel` ops per run. The mean and spread (std over the runs; min–max) are per
model × lease × task, over all runs and over the detached runs only.
""")

code("""
def turns(g):
    d = g[g.detached]
    return pd.Series({"runs": len(g), "detached": f"{int(g.detached.sum())}/{len(g)}",
                      "turns/run": g.task_ops.mean(), "std": g.task_ops.std(), "min": g.task_ops.min(), "max": g.task_ops.max(),
                      "turns/detached": d.task_ops.mean() if len(d) else np.nan,
                      "await": g.op_await.mean(), "tail": g.op_tail.mean(), "cancel": g.op_cancel.mean(),
                      "still-running awaits": g.op_await_still.mean()})

runs.groupby(["task", "model", "lease_s"]).apply(turns).round(2)
""")

md("""
## 3. The peek effect: tails made while the call ran, and how many returned output

A live tail is one on a call that had not finished. `with output` is a live tail that returned a `stdout (N B so
far…)` block. `empty` is a tail whose result was blank. If peek works every live tail should return output.
""")

code("""
def peek(g):
    return pd.Series({"runs": len(g), "runs that tailed": int((g.op_tail > 0).sum()), "tails": g.op_tail.sum(),
                      "live": g.tails_live.sum(), "with output": g.tails_with_output.sum(),
                      "live without output": g.tails_live.sum() - g.tails_with_output.sum(), "empty": g.tails_empty.sum(),
                      "live tails/run": g.tails_live.mean()})

runs.groupby(["task", "model", "lease_s"]).apply(peek).round(2)
""")

code("""
runs.groupby("task").apply(peek).round(2)
""")

md("""
Live tails that returned nothing are the thing to read if they exist (peek not reaching the model). Their results:
""")

code("""
bad = runs[(runs.tails_live > runs.tails_with_output)]
bad[["task", "model", "lease_s", "repeat", "op_tail", "tails_live", "tails_with_output", "tails_empty"]]
""")

md("""
## 4. Does the answer mention progress?

`progress_in_answer`: the final answer names a unit/test count or "progress" (`PROGRESS` in the setup cell). The result
token is `correct`; this is the extra.
""")

code("""
p = runs.groupby(["task", "model", "lease_s"]).agg(runs=("repeat", "size"), correct=("correct", "sum"),
        progress=("progress_in_answer", "sum"), tailed=("op_tail", lambda s: int((s > 0).sum())))
p
""")

code("""
runs.assign(tailed=runs.op_tail > 0).groupby(["task", "tailed"]).progress_in_answer.agg(["sum", "count"])
""")

code("""
runs[runs.progress_in_answer][["task", "model", "lease_s", "repeat", "answer"]].head(12)
""")

md("""
## 5. `build` against the 2026-11-07 arm (no peek)

The first matrix's build runs (`data/sh-lease/runs.json`, rerun sweep) against these. Rows: correct rate, task turns
per detached build, tails made, and tails that returned data. The first matrix did not pin tail results (its host
returned nothing for a running call), so its "returned data" is 0 by construction: only the count of tails is known.
""")

code("""
def cmp(df, label, has_data):
    b = df[df.task == "build"]
    out = []
    for (model, lease), g in b.groupby(["model", "lease_s"]):
        d = g[g.detached]
        out.append({"arm": label, "model": model, "lease_s": lease, "runs": len(g), "correct": kof(g.correct),
                    "detached": f"{int(g.detached.sum())}/{len(g)}",
                    "turns/detached build": round(d.task_ops.mean(), 2) if len(d) else np.nan,
                    "tails made": int(g.op_tail.sum()), "tails returned data": int(g.tails_with_output.sum()) if has_data else 0})
    return pd.DataFrame(out)

c = pd.concat([cmp(first, "2026-11-07 (no peek)", False), cmp(runs, "peek", True)])
c.sort_values(["model", "lease_s", "arm"]).set_index(["model", "lease_s", "arm"])
""")

code("""
def pooled(df, label, has_data):
    b = df[df.task == "build"]
    d = b[b.detached]
    return pd.Series({"runs": len(b), "correct": b.correct.mean(), "detached": b.detached.mean(),
                      "turns/detached build": d.task_ops.mean(), "tails/run": b.op_tail.mean(),
                      "tails returning data": b.tails_with_output.sum() if has_data else 0}, name=label)

pd.concat([pooled(first, "no peek", False), pooled(runs, "peek", True)], axis=1).round(2)
""")

md("""
## 6. `tests` (10 s): does the 5 s lease tax it?

At 5 s a 10 s call must detach; at 15 and 60 s it should not. Extra turns are the task turns of those detached runs.
""")

code("""
t = runs[runs.task == "tests"]
t.groupby("lease_s").apply(lambda g: pd.Series({
    "runs": len(g), "detached": f"{int(g.detached.sum())}/{len(g)}", "detach rate": g.detached.mean(),
    "turns/run": g.task_ops.mean(), "turns/detached": g[g.detached].task_ops.mean() if g.detached.any() else np.nan,
    "steps": g.steps.mean(), "run_s median": g.run_s.median(), "correct": kof(g.correct),
    "progress in answer": int(g.progress_in_answer.sum()), "live tails": int(g.tails_live.sum()), "with output": int(g.tails_with_output.sum()),
})).round(2)
""")

code("""
t.groupby(["model", "lease_s"]).apply(lambda g: pd.Series({
    "detached": f"{int(g.detached.sum())}/{len(g)}", "turns/run": g.task_ops.mean(), "turns std": g.task_ops.std(),
    "steps": g.steps.mean(), "correct": kof(g.correct)})).round(2)
""")

md("""
## Wrong runs

Why a run was wrong, in this order: step cap, never reached the host, reached the host but answered wrong.
""")

code("""
def why(r):
    if r.correct: return "correct"
    if r.hit_cap: return "step cap"
    if not r.reached_host: return "ml.sh as a function" if r.not_fn_calls else "never reached the host"
    return "reached the host, wrong answer"

runs["why"] = runs.apply(why, axis=1)
runs.pivot_table(index=["model", "task"], columns="why", values="repeat", aggfunc="count", fill_value=0)
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "sh-lease-peek.ipynb")
print("wrote", HERE / "sh-lease-peek.ipynb")
