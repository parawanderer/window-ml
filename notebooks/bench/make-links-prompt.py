"""make-links-prompt.py — builds links-prompt.ipynb: LINKS.md's open question 1. Does a model write the
`[label](window-ml:<address>)` link form when the form is only in agent_api_docs's "Your settings" section, or does it
need one sentence in the system prompt (`LINKS_CLAUSE`, src/agent/prompts.ts)?

    node scripts/nb.mjs make notebooks/bench/links-prompt.ipynb

The cells are written here; edit this file, not the notebook. Their numbers come from data/links-prompt/runs.json, the
runs extracted from the sweep's folders (NB_REFRESH=1 extracts again, from wherever `wmlnb.find_sweep` finds them).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Links to a setting: agent_api_docs only, or one sentence in the prompt?

`docs/spec/LINKS.md` puts the `[label](window-ml:<address>)` form in `agent_api_docs`'s "Your settings" section and
leaves open (question 1) whether one sentence in the system prompt earns its tokens. The sweep `links-prompt`
(`tests/e2e/bench/specs/links-prompt.bench.ts`) runs the same build in two arms, `__ML_LINKS_SENTENCE__` off and on:

> To point the person at one of the extension's settings, link it as `[label](window-ml:setting/<key>)`;
> `agent_api_docs` lists the keys.

Four tasks ask where something is set (the API key, running programs, auto-approving read-only scripts, backup), which a
link answers; a fifth asks for a code on the page and counts links nobody asked for. Per run:

- **linked**: the answer has at least one `[label](window-ml:…)` link;
- **resolves**: some link's address parses (`parseAddress`, the panel's own parser), so it renders as a button;
- **right place**: some link opens the tab and section the task is about (the spec's pass);
- **row**: some link is the exact `setting/<key>` row (backup has no row: its section counts);
- **bare form**: the answer names `window-ml:` outside a Markdown link, which renders as plain text.

And the sentence's cost: the first call's prompt tokens, on minus off, per model (each model's own tokenizer).
""")

code("""
import json, re, subprocess
from pathlib import Path
import pandas as pd
from scipy.stats import fisher_exact
import wmlnb

# The checkout this notebook runs in (the kernel's cwd), not wmlnb.ROOT: a worktree borrowing the clone's venv has its
# ROOT in the clone, and its pinned data would be read from (and written to) there.
TOP = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip())
HERE = TOP / "notebooks" / "bench"
SWEEP = "links-prompt"
EXTRACT = HERE / "data" / "links-prompt" / "runs.json"
pd.set_option("display.width", 180)
pd.set_option("display.max_columns", 30)
""")

md("""
## The runs, pinned

One row per run, from each run's `cell.json` (outcome, answer) and `run.json` (its steps and each call's usage). Every
address an answer links is resolved at extract time by the product's parser (`src/link-address.ts`), and the result is
pinned with the row, so the notebook does not need the source to run.
""")

code("""
WANT = {  # the spec's own `want` per task (links-prompt.bench.ts TASKS)
    "api-key": {"tab": "connection", "key": "apiKey"},
    "shell": {"tab": "advanced", "section": "shell", "key": "shellEnabled"},
    "readonly": {"tab": "advanced", "section": "javascript", "key": "autoApproveReadonly"},
    "backup": {"tab": "appearance", "backup": True},
}
RESOLVE_JS = (
    'import fs from "node:fs"; import { parseAddress } from "./src/link-address.ts"; '
    'const addrs = JSON.parse(fs.readFileSync(0, "utf8")); '
    'console.log(JSON.stringify(Object.fromEntries(addrs.map((a) => [a, parseAddress(a)]))));'
)


def links_in(text):
    return [{"label": m[1], "address": m[2]} for m in re.finditer(r"\\[([^\\]\\n]+)\\]\\(window-ml:([^)\\s]*)\\)", text)]


def resolve(addresses):
    out = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", RESOLVE_JS],
                         input=json.dumps(sorted(addresses)), capture_output=True, text=True, cwd=TOP, check=True)
    return json.loads(out.stdout)


def read_sweep():
    rows = []
    for cell in sorted(wmlnb.find_sweep(SWEEP).glob("*/*/r*/cell.json")):
        if "history" in cell.parts:
            continue
        c = json.loads(cell.read_text())
        m = c.get("measurement") or {}
        run = cell.parent / "run.json"
        steps = json.loads(run.read_text())["session"]["steps"] if run.exists() else []
        usage = [s["usage"] for s in steps if s.get("usage")]
        answer = m.get("finalAnswer") or m.get("answer") or ""
        rows.append({
            "task": c["taskId"], "sentence": c["combo"]["sentence"], "model": c["combo"]["model"], "repeat": c["repeat"],
            "passed": bool(m.get("succeeded")), "error": bool(m.get("error")), "hit_cap": bool(m.get("hitCap")),
            "steps": m.get("steps"), "calls": len(usage),
            "first_prompt_tokens": usage[0].get("promptTokens") if usage else None,
            "prompt_tokens": (m.get("tokens") or {}).get("prompt"),
            "docs_calls": sum(1 for s in steps if s.get("tool") == "agent_api_docs"),
            "answer": answer, "links": links_in(answer),
        })
    resolved = resolve({l["address"] for r in rows for l in r["links"]})
    for r in rows:
        for l in r["links"]:
            l["route"] = resolved.get(l["address"])
    return rows

rows = wmlnb.extract(EXTRACT, read_sweep, source={"sweep": SWEEP})
runs = pd.DataFrame(rows)
pd.DataFrame(wmlnb.provenance(EXTRACT))
""")

code("""
def opens(route, want):
    if not route:
        return False
    if want.get("backup"):
        return route.get("target") == "set-backup"
    return route.get("tab") == want["tab"] and ("section" not in want or route.get("section") == want["section"])


def judge(r):
    links, want = r["links"], WANT.get(r["task"])
    routes = [l["route"] for l in links]
    return pd.Series({
        "linked": bool(links),
        "resolves": any(routes),
        "right_place": bool(want) and any(opens(x, want) for x in routes),
        "row": bool(want) and any(x and (x.get("setting") == want.get("key") or (want.get("backup") and opens(x, want))) for x in routes),
        "bare_form": "window-ml:" in r["answer"].replace("](window-ml:", ""),
        "unresolved": sum(1 for x in routes if not x),
    })

runs = runs.join(runs.apply(judge, axis=1))
ok = runs[~runs.error]
asks = ok[ok.task != "control"]
print(f"{len(runs)} runs, {int(runs.error.sum())} errored (left out below); {len(asks)} on the four link tasks")
""")

md("""
## Link rate and correctness, per arm

The four link tasks pooled, per model and arm: share of runs with a link, one that resolves, one to the right place,
and the exact row.
""")

code("""
def rates(df, by):
    g = df.groupby(by)
    out = pd.DataFrame({"runs": g.size()})
    for col in ["linked", "resolves", "right_place", "row", "bare_form"]:
        out[col] = g[col].mean().round(2)
    return out

rates(asks, ["model", "sentence"]).unstack("sentence")
""")

code("""
rates(asks, ["sentence"])
""")

md("""
Per task, both arms (right place, as a count of runs): a task only one arm gets right points at what the sentence adds.
""")

code("""
asks.pivot_table(index=["model", "task"], columns="sentence", values="right_place", aggfunc="sum").astype(int)
""")

md("""
## Is the difference more than noise?

Fisher's exact test per model on right-place runs over the four link tasks, two-sided, and pooled over models.
""")

code("""
def fisher(df):
    out = []
    for model, g in [*df.groupby("model"), ("(all)", df)]:
        a = g[g.sentence == "off"].right_place; b = g[g.sentence == "on"].right_place
        if not len(a) or not len(b):
            continue
        t = [[a.sum(), len(a) - a.sum()], [b.sum(), len(b) - b.sum()]]
        out.append({"model": model, "off": f"{a.sum()}/{len(a)}", "on": f"{b.sum()}/{len(b)}",
                    "p": round(fisher_exact(t).pvalue, 3)})
    return pd.DataFrame(out).set_index("model")

fisher(asks)
""")

md("""
## Links nobody asked for

The control task asks for a code on the page. Any link there is noise the sentence may have invited.
""")

code("""
ctl = ok[ok.task == "control"]
ctl.groupby(["model", "sentence"]).agg(runs=("linked", "size"), linked=("linked", "sum"), passed=("passed", "sum")).unstack("sentence")
""")

md("""
### The control, run again

The first sweep's control failed 5 of 20 times with the sentence and 0 of 20 without, none of them by linking. It was run
again (`--only task=control --repeats 4`, at the commit that ships the sentence; both arms still set the constant), and
the sweep moved the first runs to its `history/`. Pinned separately, so `runs.json` keeps the first sweep.
""")

code("""
RERUN = HERE / "data" / "links-prompt" / "control-rerun.json"

def read_control_rerun():
    rows = []
    for cell in sorted((wmlnb.find_sweep(SWEEP) / "control").glob("*/r*/cell.json")):
        c = json.loads(cell.read_text()); m = c.get("measurement") or {}
        answer = m.get("finalAnswer") or m.get("answer") or ""
        rows.append({"model": c["combo"]["model"], "sentence": c["combo"]["sentence"], "repeat": c["repeat"],
                     "passed": bool(m.get("succeeded")), "error": bool(m.get("error")), "linked": bool(links_in(answer)),
                     "answer": answer})
    return rows

rerun = pd.DataFrame(wmlnb.extract(RERUN, read_control_rerun, source={"sweep": SWEEP, "task": "control", "rerun": True}))
both = pd.concat([ctl.assign(run="first")[["run", "model", "sentence", "passed", "linked"]],
                  rerun[~rerun.error].assign(run="again")[["run", "model", "sentence", "passed", "linked"]]])
both.groupby(["run", "sentence"]).agg(runs=("passed", "size"), failed=("passed", lambda x: int((~x).sum())), linked=("linked", "sum")).unstack("run")
""")

code("""
rerun[~rerun.passed][["model", "sentence", "answer"]].assign(answer=lambda d: d.answer.str.slice(0, 80))
""")

md("""
## How the off arm finds the form

Runs that called `agent_api_docs` at least once, and of those how many linked: without the sentence, the docs are the
only place the form is written.
""")

code("""
asks.assign(read_docs=asks.docs_calls > 0).groupby(["sentence", "read_docs"]).agg(runs=("linked", "size"), linked=("linked", "sum"), right_place=("right_place", "sum"))
""")

md("""
## What the sentence costs

The first call's prompt tokens are the system prompt plus the tools plus the task, so on minus off is the sentence in
each model's own tokenizer (the median over that model's runs; tasks differ only in the task text, which both arms
share). Every call of every run pays it.
""")

code("""
first = ok.groupby(["model", "sentence"]).first_prompt_tokens.median().unstack("sentence")
first["sentence_tokens"] = first["on"] - first["off"]
first["calls_per_run"] = ok.groupby("model").calls.mean().round(1)
first["tokens_per_run"] = (first.sentence_tokens * first.calls_per_run).round(0)
first
""")

md("""
## Unresolved addresses

Every link whose address does not parse (it renders as its label), with the model and arm that wrote it.
""")

code("""
bad = [{"model": r.model, "sentence": r.sentence, "task": r.task, "address": l["address"]} for r in ok.itertuples() for l in r.links if not l["route"]]
pd.DataFrame(bad, columns=["model", "sentence", "task", "address"])
""")

nb = nbf.v4.new_notebook()
nb["cells"] = cells
nb["metadata"]["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "links-prompt.ipynb")
