"""make-tools-into-js.py — builds tools-into-js.ipynb: what a run loses or gains if fetch_url lived only as ml.fetch
inside exec, and which reader a model reaches for.

    .venv/bin/python notebooks/bench/make-tools-into-js.py && node scripts/nb.mjs run notebooks/bench/tools-into-js.ipynb
    (or: node scripts/nb.mjs make notebooks/bench/tools-into-js.ipynb)

The cells are written here; edit this file, not the notebook. Their numbers come from data/tools-into-js/runs.json, the
runs extracted from the sweep's folder (NB_REFRESH=1 extracts again, from wherever `wmlnb.find_sweep` finds it).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# fetch_url as a tool, or only as ml.fetch inside exec

Spec: `tests/e2e/bench/specs/tools-into-js.bench.ts`. Three arms, each with `answer`: `tool` (fetch_url alone), `exec`
(exec alone; its description names `ml.fetch`) and `both` (fetch_url and exec). Two tasks on the fixture site:
`sales-total` (sum a 3,000-row CSV) and `find-out` (one fact from another page).

Questions:

1. Does a run lose correctness, steps, tokens or time when fetch_url is not a tool (`exec` against `tool`)?
2. In the `exec` arm, do models find `ml.fetch` (on which turn, after reading `agent_api_docs` or not), or fall back to
   a page-world `fetch(`?
3. In the `both` arm, which reader do they reach for first, and do they switch?

Every run is classified by the readers it used, in order: `fetch_url` (sub-kinds `fetch_url+ask`, `fetch_url+pipe`),
`ml.fetch` (an exec whose `js` matches `\\bml\\.fetch\\s*\\(`), `page-fetch` (an exec calling bare `fetch(` or
`XMLHttpRequest` without `ml.fetch`), `api-docs` (`agent_api_docs`), `exec-other` (any other exec).
""")

code("""
import json, re
from pathlib import Path
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "bench"
SWEEP = "tools-into-js"
EXTRACT = HERE / "data" / "tools-into-js" / "runs.json"
pd.set_option("display.width", 180)
pd.set_option("display.max_columns", 40)
""")

md("""
## The runs, pinned

One row per run, from each run's `cell.json` (outcome, tokens, time) and `run.json` (its steps). An earlier launch of
the same sweep ran with `navigate` on and left stale cells. A cell is **excluded** when any of these holds: it sits under
`history/` (the harness moves a replaced cell there), its run has a `navigate` step (no arm offers it, so only the broken
launch can produce one), or its session started before the first `sweeps.jsonl` record carrying the latest record's
fingerprint (it ran under an older spec). The cell itself carries no fingerprint, so the third test uses the session
time. The excluded cells are listed in `excluded`.
""")

code("""
FETCH_JS = re.compile(r"\\bml\\.fetch\\s*\\(")
PAGE_JS = re.compile(r"(?<![\\w.])fetch\\s*\\(|XMLHttpRequest")
URL_READERS = ("fetch_url", "ml.fetch", "page-fetch")
# The literal URL an ml.fetch call names: whatever quote opens it, then URL characters.
REL_JS = re.compile(r"ml\\.fetch\\(\\s*[^\\w\\s(]([\\w/:.?=&%~-]+)")


def classify(step):
    \"\"\"The kind of one tool step: how it read a URL, or its tool name.\"\"\"
    tool, args = step.get("tool"), step.get("arguments") or {}
    if tool == "fetch_url":
        return "fetch_url+ask" if args.get("ask") else "fetch_url+pipe" if args.get("pipe") else "fetch_url"
    if tool == "exec":
        js = str(args.get("js", ""))
        return "ml.fetch" if FETCH_JS.search(js) else "page-fetch" if PAGE_JS.search(js) else "exec-other"
    if tool == "agent_api_docs":
        return "api-docs"
    return tool


def base(kind):
    return "fetch_url" if kind.startswith("fetch_url") else kind


def read_runs():
    root = wmlnb.find_sweep(SWEEP)
    sweeps = [json.loads(l) for l in (root / "sweeps.jsonl").read_text().splitlines() if l.strip()]
    sweeps = [s for s in sweeps if s.get("op") == "sweep"]
    latest = sweeps[-1]["fingerprint"]
    since = min(s["at"] for s in sweeps if s["fingerprint"] == latest)
    rows, excluded = [], []
    for cell in sorted(root.rglob("cell.json")):
        rel = str(cell.relative_to(root))
        c = json.loads(cell.read_text())
        m = c.get("measurement") or {}
        run = cell.parent / "run.json"
        sess = json.loads(run.read_text())["session"] if run.exists() else {"steps": [], "createdAt": ""}
        steps = [s for s in sess["steps"] if s.get("tool")]
        why = ("history/" if rel.startswith("history/") else
               "navigate step" if any(s["tool"] == "navigate" for s in steps) else
               "older fingerprint" if sess.get("createdAt", "") < since else None)
        if why:
            excluded.append({"cell": rel, "why": why})
            continue
        kinds = [classify(s) for s in steps]
        readers = [k for k in kinds if k not in ("answer",) and (base(k) in URL_READERS or k in ("api-docs", "exec-other"))]
        used = [base(k) for k in kinds if base(k) in URL_READERS]
        mf = next((i + 1 for i, k in enumerate(kinds) if k == "ml.fetch"), None)
        execs = [s for s in steps if s["tool"] == "exec"]
        tok = m.get("tokens") or {}
        gen_ms = sum((s.get("usage") or {}).get("genMs") or 0 for s in sess["steps"])
        rows.append({
            "model": c["combo"]["model"], "arm": c["combo"]["arm"], "task": c["taskId"], "repeat": c["repeat"],
            "correct": bool(m.get("succeeded")), "steps": m.get("steps"), "run_s": (m.get("runMs") or 0) / 1000,
            "gen_s": gen_ms / 1000, "prompt_tokens": tok.get("prompt"), "completion_tokens": tok.get("completion"),
            "readers": readers, "first_reader": used[0] if used else None, "switched": len(set(used)) > 1,
            "mlfetch_turn": mf, "before_mlfetch": kinds[:mf - 1] if mf else None,
            "docs_before_mlfetch": ("api-docs" in kinds[:mf - 1]) if mf else None,
            "failed_first_exec": ("Error" in str(execs[0].get("result"))) if execs else None,
            "unknown_tool_calls": sum("no tool named" in str(s.get("result")) for s in sess["steps"]),
            # The runner's own error (a run that hit the spec's 300 s cap gives no agent-result), scored as not correct.
            "timed_out": "timed out" in str(c.get("error") or m.get("error") or ""),
            # ml.fetch called with a relative URL, and refused by the worker (sw-fetch-url.ts parses it with no base).
            "relative_mlfetch": sum(len([u for u in REL_JS.findall(str((s.get("arguments") or {}).get("js", ""))) if not u.startswith(("http://", "https://"))]) for s in steps if s["tool"] == "exec"),
            "relative_refused": sum("not a valid URL" in str(s.get("result")) for s in steps if s["tool"] == "exec"),
        })
    return {"rows": rows, "excluded": excluded, "latest_fingerprint": latest, "since": since}


data = wmlnb.extract(EXTRACT, read_runs, source={"sweep": SWEEP, "sweep_root": "tests/e2e/artifacts/bench/tools-into-js"})
runs = pd.DataFrame(data["rows"])
print(len(runs), "runs kept; excluded:", data["excluded"], "; latest fingerprint", data["latest_fingerprint"], "since", data["since"])
pd.DataFrame(wmlnb.provenance(EXTRACT))
""")

md("## Runs per cell (n)")

code("""
G = ["model", "task", "arm"]
runs.groupby(G).size().unstack("arm", fill_value=0)
""")

md("## Correct rate, model x task x arm")

code("""
def rate(df):
    g = df.groupby(G).correct.agg(["sum", "count"])
    g["correct"] = g["sum"].astype(int).astype(str) + "/" + g["count"].astype(str)
    g["rate"] = (g["sum"] / g["count"]).round(2)
    return g[["correct", "rate"]].unstack("arm")

rate(runs)
""")

md("Pooled over models, task x arm.")

code("""
g = runs.groupby(["task", "arm"]).correct.agg(["sum", "count"])
g["rate"] = (g["sum"] / g["count"]).round(2)
g
""")

md("## Steps, tokens and run time: mean and median")

code("""
runs["tokens"] = runs.prompt_tokens.fillna(0) + runs.completion_tokens.fillna(0)
runs.groupby(G)[["steps", "tokens", "run_s", "gen_s"]].agg(["mean", "median"]).round(1)
""")

md("Pooled over models, task x arm.")

code("""
runs.groupby(["task", "arm"])[["steps", "tokens", "run_s", "gen_s"]].agg(["mean", "median"]).round(1)
""")

md("## Reader mix: the first URL reader of each run, all arms")

code("""
runs.assign(first_reader=runs.first_reader.fillna("none")).pivot_table(
    index=G, columns="first_reader", values="repeat", aggfunc="count", fill_value=0)
""")

md("## Exec arm: where ml.fetch appears")

code("""
ex = runs[runs.arm == "exec"]
print("mlfetch_turn distribution (None = never used ml.fetch), by model:")
display(ex.assign(mlfetch_turn=ex.mlfetch_turn.fillna(-1).astype(int).replace(-1, "none")).pivot_table(
    index=["model", "task"], columns="mlfetch_turn", values="repeat", aggfunc="count", fill_value=0))
summary = ex.groupby(["model", "task"]).apply(lambda d: pd.Series({
    "n": len(d),
    "used_mlfetch": int(d.mlfetch_turn.notna().sum()),
    "docs_before_mlfetch": f"{int(d.docs_before_mlfetch.fillna(False).sum())}/{int(d.mlfetch_turn.notna().sum())}",
    "page_fetch_rate": round((d.first_reader == "page-fetch").mean(), 2),
    "any_page_fetch": int(d.readers.apply(lambda r: "page-fetch" in r).sum()),
    "failed_first_exec": int(d.failed_first_exec.fillna(False).sum()),
}), include_groups=False)
summary
""")

md("Exec arm, pooled over models.")

code("""
ex.groupby("task").apply(lambda d: pd.Series({
    "n": len(d), "used_mlfetch": int(d.mlfetch_turn.notna().sum()),
    "docs_before_mlfetch": int(d.docs_before_mlfetch.fillna(False).sum()),
    "page_fetch_first": int((d.first_reader == "page-fetch").sum()),
    "median_mlfetch_turn": d.mlfetch_turn.median(),
    "correct_when_mlfetch": f"{int(d[d.mlfetch_turn.notna()].correct.sum())}/{int(d.mlfetch_turn.notna().sum())}",
    "correct_when_page_fetch": f"{int(d[d.first_reader == 'page-fetch'].correct.sum())}/{int((d.first_reader == 'page-fetch').sum())}",
}), include_groups=False)
""")

md("What came before the first ml.fetch (the step kinds, exec arm).")

code("""
ex[ex.mlfetch_turn.notna()][["model", "task", "repeat", "mlfetch_turn", "before_mlfetch", "correct"]].sort_values(["model", "task", "repeat"])
""")

md("## Both arm: first reader and switching")

code("""
bo = runs[runs.arm == "both"]
display(bo.assign(first_reader=bo.first_reader.fillna("none")).pivot_table(
    index=["model", "task"], columns="first_reader", values="repeat", aggfunc="count", fill_value=0))
bo.groupby(["model", "task"]).apply(lambda d: pd.Series({
    "n": len(d), "switched": int(d.switched.sum()), "switched_rate": round(d.switched.mean(), 2),
    "correct": f"{int(d.correct.sum())}/{len(d)}",
}), include_groups=False)
""")

md("Both arm, pooled over models: first reader against correctness.")

code("""
bo.assign(first_reader=bo.first_reader.fillna("none")).groupby(["task", "first_reader"]).correct.agg(["sum", "count"])
""")

md("## Calls to a tool the arm did not offer")

code("""
u = runs.groupby(G).unknown_tool_calls.agg(["sum", "count"]).rename(columns={"sum": "unknown_tool_calls", "count": "runs"})
display(u)
print("total:", int(runs.unknown_tool_calls.sum()), "in", int((runs.unknown_tool_calls > 0).sum()), "of", len(runs), "runs")
""")

md("""
## Runs that hit the 300 s cap

The runner ends a run at the spec's `timeoutMs` with no answer; it is scored as not correct above.
""")

code("""
t = runs[runs.timed_out]
display(t.groupby(G).size().rename("timed out"))
print("total:", len(t), "of", len(runs), "runs; every one in:", sorted(set(zip(t.task, t.arm))))
""")

md("""
## A relative URL to `ml.fetch`

The task says "/sales.csv on this site", and a model often passes exactly that. The worker parses the URL with no base
(`src/sw/sw-fetch-url.ts`), so a relative one is refused as "not a valid URL", even though the page has a base for it.
""")

code("""
r = runs[runs.relative_mlfetch > 0]
print("relative ml.fetch calls:", int(runs.relative_mlfetch.sum()), "in", len(r), "runs; refused:", int(runs.relative_refused.sum()))
display(r[["model", "task", "arm", "repeat", "relative_mlfetch", "relative_refused", "correct"]].sort_values(["model", "task", "arm", "repeat"]))
print("of those runs, correct:", f"{int(r.correct.sum())}/{len(r)}")
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "tools-into-js.ipynb")
print("wrote", HERE / "tools-into-js.ipynb")
