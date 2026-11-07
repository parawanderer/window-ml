"""make-sh-lease.py — builds sh-lease.ipynb: what should SH_LEASE_MS be, the time an `ml.sh` call runs before it
detaches into a task (docs/spec/ASYNC_CALLS.md mode 1, rule 1; #1437)?

    node scripts/nb.mjs make notebooks/bench/sh-lease.ipynb

The cells are written here; edit this file, not the notebook. Their numbers come from data/sh-lease/runs.json, one row
per run extracted from the two sweeps' folders (NB_REFRESH=1 extracts again, from wherever `wmlnb.find_sweep` finds
them). The recommendation at the top is prose written from the tables below; re-check it if the extract changes.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

RECOMMENDATION = (Path(HERE / "data" / "sh-lease" / "RECOMMENDATION.md").read_text().strip()
                  if (HERE / "data" / "sh-lease" / "RECOMMENDATION.md").exists() else "_(written once the re-run is in)_")

md(f"""
# ml.sh lease: how long a call runs before it detaches

{RECOMMENDATION}

**The question.** `ml.sh.run` waits up to `expectMs`, or `SH_LEASE_MS` when no estimate is given, and then THROWS
`Detached {{id, elapsed_ms, lease_ms, …}}`. The call carries on as a task that the model reaches with the `task` tool
(`await`, `tail`, `cancel`). If the lease is too short, every ordinary call spends turns on a detach. If it is too
long, a stalled call is the silent hang again. #1437's draft default is 15 s.

**The matrix** (`tests/e2e/bench/specs/sh-lease.bench.ts`):
- three local models: gemma4:31b, gemma4:e4b, qwen3.8-flash-next:vision;
- three leases: 5, 15 and 60 s, built into each cell through `__SH_LEASE_MS__`;
- three task scripts: **build** (40 s, a progress line every 5 s, then `BUILD OK 7f3a19`), **hang** (one line, then
  never ends: the host kills it at 120 s) and **quick** (2 s, then `CHECK OK c42e07`);
- 5 repeats each.

The task text names the command and the answer wanted. It never mentions `expectMs`, leases or tasks, so an
estimate given before the first `Detached` is the model's own idea.
""")

md("""
## Conditions

- **Code.** Integration commit `bc0edb7e`, local and unpushed:
  - window-ml main `4e5277ae`;
  - #1437 at `859cd023`: `4706fae1` plus the JSDoc clause that `ml.sh` is a namespace called as `ml.sh.run(argv)`;
  - the e2e harness for a native host, `dd870393` (#1453);
  - the bench's own commits, including `efb2eb1a`, which gives the scripts' manifest `runs-code`.
- **wmlhost:** `ae7284e`.
- **Container.** A Linux container (`tests/e2e/docker/sh-lease.Dockerfile`) with bwrap and Landlock ABI 8, run with
  seccomp, apparmor and systempaths unconfined. Every call ran `host-sandbox`.
- **#1437 was rebased during the sweep, to `47ee6834`.** The two heads' patch-ids are unequal (`d6a14a42`, `62ff40fc`)
  but their stats are identical (44 files, +1191/−77). The 12 lines that differ thread main's steering `images` field
  through `drainInbox`'s return type, its item map and the `runInboxes` queue type. The task-result branch is
  identical, and no lease, `Detached` or `ml.sh` line differs. The coordinator and the async lane agreed that this
  sweep stands for the final head.
- **Approvals.** `autoApproveReadonly` was OFF: the routing bug, #1451.
  - Every gate was ruled by `shLeaseDecide`: the run's own `exec` was approved, and every nested ask and every other
    gated tool was DENIED.
  - The scripts ran free through stored workspace manifests (effects `read`, `runs-code`), which the host pins by
    sha256.
- **Pilot.** 3/3 passed on `bc0edb7e`. Check 3 shows `bash build.sh` ran with no ask and its `sleep` ran (no
  `Permission denied`; the `SLEPT-<nonce>` line appears only after `sleep 2` succeeds).
- **Excluded.**
  - The cells from the bench fingerprint `nogit` (an image with no `.git`, which made the cache reuse cells across
    builds).
  - The b4cff4ef pilot cells: the model-facing MlSh header and JSDoc changed after them.
  - `history/`.
  - The first matrix (image `18a812eb`) is not in the tables. It is the negative result at the end.
- **What the build arm cannot measure.** The host reports a call's output only when the call ends, because it has no
  `peek` yet. So a model never sees the build's progress lines while it waits. Re-run that arm after the host's peek
  slice.
""")

code("""
import json, re
from pathlib import Path
import numpy as np
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "bench"
SWEEPS = {"sh-lease": "rerun", "sh-lease-18a812eb": "first"}
EXTRACT = HERE / "data" / "sh-lease" / "runs.json"
HOST_KILL_S = 120
pd.set_option("display.width", 180)
pd.set_option("display.max_colwidth", 80)
""")

md("""
## The runs, pinned

There is one row per run, read from its `cell.json` (the outcome, tokens and answer) and its `run.json` (the steps).
Each `exec` that names `ml.sh` counts as one call:
- did it give `expectMs`;
- was it before or after the run's first `Detached`;
- did it outlive its own estimate (`you expected ~N s and it is still running`).

Every `task` op is a turn the model spent on a detached call. No run received a task's result as a `[task …]` inbox
message: every model waited with `task await` inside its turn. So these task turns are the wake turns.
""")

code(r'''
def _sweep_meta(d):
    recs = [json.loads(l) for l in (d / "sweeps.jsonl").read_text().splitlines() if l.strip()]
    sweep = [r for r in recs if r.get("op") == "sweep"][-1]
    done = json.loads((d / "done.json").read_text()) if (d / "done.json").exists() else {}
    return {"fingerprint": sweep.get("fingerprint"), "started": sweep.get("at"), "done": done.get("at"),
            "runsIn": sweep.get("runsIn")}

def _ts(s):
    return pd.Timestamp(s).timestamp()

def read_run(cell_path, sweep, meta):
    c = json.loads(cell_path.read_text())
    m = c.get("measurement") or {}
    run = json.loads((cell_path.parent / "run.json").read_text())["session"]
    steps = run["steps"]
    calls, ops = [], {"await": 0, "await_still": 0, "tail": 0, "cancel": 0}
    first_det_at = first_call_at = None
    got_result = host_killed = outlived = False
    results = []
    for s in steps:
        tool, r = s.get("tool"), str(s.get("result", ""))
        if not tool:
            continue
        results.append(r)
        js = str((s.get("arguments") or {}).get("js", ""))
        if tool == "exec" and re.search(r"\bml\.sh\b", js):
            det = "Detached:" in r
            outlived_call = det and "you expected ~" in r
            calls.append({"expect": bool(re.search(r"expectMs\s*:", js)), "before_det": first_det_at is None,
                          "detached": det, "not_fn": "ml.sh is not a function" in r,
                          "reached": det or "host-sandbox" in r or "host-plain" in r, "outlived": outlived_call})
            if calls[-1]["reached"] and first_call_at is None:
                first_call_at = _ts(s["at"])
            if det and first_det_at is None:
                first_det_at = _ts(s["at"])
            outlived |= outlived_call
            host_killed |= bool(re.search(r'"timedOut":\s*true|timedOut true', r)) and "timeoutMs" not in js
        if tool == "task":
            op = (s.get("arguments") or {}).get("op")
            if op in ops:
                ops[op] += 1
            if op == "await" and "still running" in r:
                ops["await_still"] += 1
            if "you expected it within" in r:
                outlived = True
            got_result |= " done" in r[:60]
            host_killed |= "timeoutMs" in r and "killed" in r
    answer_msgs = [x for x in run["messages"] if x["role"] == "assistant"]
    answer_at = _ts(answer_msgs[-1]["at"]) if answer_msgs else None
    gen_ms = sum((s.get("usage") or {}).get("genMs") or 0 for s in steps)
    toks = m.get("tokens") or {}
    return {
        "sweep": SWEEPS[sweep], "sweep_dir": sweep, "fingerprint": meta["fingerprint"],
        "sweep_started": meta["started"], "sweep_done": meta["done"], "runs_in": meta["runsIn"], "task": c["taskId"],
        "model": c["combo"]["model"], "lease_s": c["combo"]["leaseMs"] // 1000, "repeat": c["repeat"],
        "correct": bool(m.get("succeeded")), "hit_cap": bool(m.get("hitCap")), "steps": m.get("steps"),
        "run_s": (m.get("runMs") or 0) / 1000, "gen_s": gen_ms / 1000,
        "prompt_tokens": toks.get("prompt"), "completion_tokens": toks.get("completion"),
        "approvals": m.get("approvals"), "denied": m.get("denied"),
        "sh_calls": len(calls), "not_fn_calls": sum(x["not_fn"] for x in calls),
        "reached_host": any(x["reached"] for x in calls), "detached": first_det_at is not None,
        "expect_before_det": any(x["expect"] and x["before_det"] for x in calls if x["reached"]),
        "expect_any": any(x["expect"] for x in calls if x["reached"]),
        "outlived_estimate": outlived, "task_ops": sum(ops[k] for k in ("await", "tail", "cancel")),
        **{f"op_{k}": v for k, v in ops.items()},
        "result_via_task": got_result, "host_killed": host_killed,
        "answer_after_call_s": (answer_at - first_call_at) if (answer_at and first_call_at) else None,
        "sleep_denied": any("sleep: Permission denied" in r for r in results),
        "answer": (m.get("finalAnswer") or m.get("answer") or "")[:200],
    }

def read_sweeps():
    rows = []
    for sweep in SWEEPS:
        d = wmlnb.find_sweep(sweep)
        meta = _sweep_meta(d)
        for cell in sorted(d.glob("*/*/r*/cell.json")):
            if "history" in cell.parts or not (cell.parent / "run.json").exists():
                continue
            rows.append(read_run(cell, sweep, meta))
    return rows

data = wmlnb.extract(EXTRACT, read_sweeps, source={"sweeps": list(SWEEPS), "sweep_root": "~/git/window-ml-bench/tests/e2e/artifacts/bench"})
all_runs = pd.DataFrame(data)
assert "nogit" not in set(all_runs.fingerprint), "a nogit cell is in the extract"
runs = all_runs[all_runs.sweep == "rerun"].copy()
first = all_runs[all_runs.sweep == "first"].copy()
pd.DataFrame(wmlnb.provenance(EXTRACT))
''')

code("""
sweeps = all_runs.groupby("sweep_dir").agg(fingerprint=("fingerprint", "first"), started=("sweep_started", "first"),
                                           done=("sweep_done", "first"), runs_in=("runs_in", "first"), runs=("repeat", "size"))
sweeps
""")

md("""
## Is the re-run valid?

The first matrix's fault (its scripts' `sleep` refused by the sandbox) would show here as `sleep_denied`. A build that
really runs takes at least 40 s, so the build arm under the 5 and 15 s leases must detach whenever the call reached
the host.
""")

code("""
reached = runs[runs.reached_host]
pd.DataFrame({
    "runs": runs.groupby("task").size(),
    "reached host": reached.groupby("task").size(),
    "sleep denied": runs.groupby("task").sleep_denied.sum(),
    "detached": reached.groupby("task").detached.sum(),
}).fillna(0).astype(int)
""")

code("""
reached.pivot_table(index="task", columns="lease_s", values="detached", aggfunc="mean").round(2)
""")

md("""
## Time: wall and GPU, against the 4.5–7.5 h estimate

Wall time runs from the sweep record to `done.json`. GPU time is the sum of every generation's `genMs`: the box
generating for this sweep, not waiting on a script.
""")

code("""
def times(df, sweep):
    s = sweeps.loc[sweep]
    wall_h = (pd.Timestamp(s["done"]) - pd.Timestamp(s["started"])).total_seconds() / 3600 if s["done"] else np.nan
    return {"wall h": round(wall_h, 2), "GPU h (sum genMs)": round(df.gen_s.sum() / 3600, 2),
            "run h (sum runMs)": round(df.run_s.sum() / 3600, 2), "runs": len(df)}

pd.DataFrame({"re-run": times(runs, "sh-lease"), "first (invalid)": times(first, "sh-lease-18a812eb")}).T
""")

code("""
runs.groupby(["task", "lease_s"]).run_s.agg(["mean", "median", "max"]).round(0).unstack("lease_s")
""")

md("""
## Correct / wrong by lease × task × model

Each cell reads `k/5`. A right **build** or **quick** answer reports the script's own result line. A right **hang**
answer says the call stalled or was stopped, and does not report a result it never had.
""")

code("""
def kof(s):
    return f"{int(s.sum())}/{len(s)}"

runs.pivot_table(index=["task", "model"], columns="lease_s", values="correct", aggfunc=kof)
""")

code("""
pooled = runs.groupby(["task", "lease_s"]).correct.agg(["sum", "count"])
pooled["rate"] = (pooled["sum"] / pooled["count"]).round(2)
pooled.unstack("lease_s")
""")

md("""
Why the wrong runs were wrong, in this order:
1. the step cap;
2. never reached the host (most often `ml.sh('…')` called as a function, or no `ml.sh` at all);
3. reached the host but answered wrong.
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

md("""
## Estimates and wake turns

Of the runs whose call reached the host:
- **expectMs before Detached:** the model gave its own estimate before any `Detached`;
- **detached:** a call actually detached;
- **outlived estimate:** a call or an `await` ran past the estimate the model gave;
- **task turns:** `task` ops (await, tail, cancel), the turns spent on a detached call;
- **still-running awaits:** awaits that came back still running.
""")

code("""
def behaviour(g):
    return pd.Series({
        "runs": len(g), "expectMs before Detached": g.expect_before_det.mean(), "detached": g.detached.mean(),
        "outlived estimate": g.outlived_estimate.mean(), "task turns (mean)": g.task_ops.mean(),
        "task turns (max)": g.task_ops.max(), "still-running awaits (mean)": g.op_await_still.mean(),
        "steps (mean)": g.steps.mean(),
    }).round(2)

reached.groupby(["task", "lease_s"]).apply(behaviour)
""")

code("""
reached.groupby(["model", "task", "lease_s"]).apply(behaviour)[["runs", "expectMs before Detached", "detached", "task turns (mean)", "steps (mean)"]]
""")

md("""
## The hang: a stall noticed before the host's 120 s kill

The time from the first call reaching the host to the final answer. A stall the model **noticed** gives an answer that
says so in under 120 s, by cancelling the task or answering while it still runs. A run where the host's kill
answered for the model is counted apart.
""")

code("""
hang = reached[reached.task == "hang"].copy()
hang["noticed before kill"] = hang.correct & (hang.answer_after_call_s < HOST_KILL_S)
hang.groupby(["model", "lease_s"]).agg(
    runs=("repeat", "size"), correct=("correct", "sum"), noticed_before_kill=("noticed before kill", "sum"),
    cancelled=("op_cancel", lambda s: int((s > 0).sum())), host_killed=("host_killed", "sum"),
    answer_s_median=("answer_after_call_s", "median"),
).round(0)
""")

md("""
## The quick call: what the lease costs the common case

The 2 s script is under every lease, so it should never detach, and its turns should not depend on the lease.
""")

code("""
q = reached[reached.task == "quick"]
q.groupby(["lease_s"]).agg(runs=("repeat", "size"), detached=("detached", "sum"), correct=("correct", "sum"),
                           steps=("steps", "mean"), run_s=("run_s", "median"), task_turns=("task_ops", "sum")).round(1)
""")

md("""
## Denied gates

Every gate that is not the run's own `exec` is denied: an `ml.sh` ask, or another gated tool. A denial here means a
model reached for something outside the free tier.
""")

code("""
runs.pivot_table(index=["model", "task"], columns="lease_s", values="denied", aggfunc="sum", fill_value=0)
""")

md("## Tokens")

code("""
runs.pivot_table(index=["task", "model"], columns="lease_s", values="prompt_tokens", aggfunc="median").round(-2)
""")

code("""
runs.groupby("lease_s")[["prompt_tokens", "completion_tokens"]].sum()
""")

md("""
## Negative result: the first matrix (image `18a812eb`)

That matrix gave its scripts a manifest with `effects: ["read"]`. From that, `envelopeFor` (src/shell/sh-call.ts) sent
`exec: program-only`, and the host refused every child program of `bash`, so `sleep` failed with `Permission denied`.
- **build and quick:** `echo` is a bash builtin, so both still printed their result lines. But the "40 s" build ran in
  milliseconds, and no call could detach under any lease.
- **hang:** it still hung, as a spin on the failing `sleep` that filled stderr with permission errors. The models read
  that as a permission problem, not a stall.
- **Why it was missed:** the pilot's check 3 looked only for the result line. It now also proves that `sleep` ran.
- **Kept:** the runs stay, as `sh-lease-18a812eb`. None of its numbers is in the tables above.
""")

code("""
fr = first[first.reached_host]
pd.DataFrame({"runs": first.groupby("task").size(), "reached host": fr.groupby("task").size(),
              "sleep denied": first.groupby("task").sleep_denied.sum(),
              "median run s": first.groupby("task").run_s.median().round(0)}).fillna(0)
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "sh-lease.ipynb")
print("wrote", HERE / "sh-lease.ipynb")
