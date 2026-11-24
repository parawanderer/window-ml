"""baseline.py — the corpus sweep's cells, classified, for cell-labels-baseline.ipynb: one row per `exec` and
`python_exec` cell of the sweep's runs, with its task, stratum, repeat and labels, and for a Python cell its outcome
from the sweep's extract (inside the dialect, asked, or not run).

The inputs are each run's `run.json` (the JSON export) and the sweep's `corpus.jsonl` (tests/e2e/bench/corpus-extract.mjs)
for the stratum and the outcome. Both hold cell code; the rows hold labels, never the code.
"""

import json
from pathlib import Path

import classify


def read(sweep: Path) -> list[dict]:
    sweep = Path(sweep)
    extract = [json.loads(l) for l in (sweep / "corpus.jsonl").read_text().splitlines() if l.strip()]
    stratum = {r["task"]: r["stratum"] for r in extract}
    outcome = {(r["run"], r["step"]): r["outcome"] for r in extract}  # the extract's `step` is the step's seq

    meta, cells = [], []
    for p in sorted(sweep.glob("corpus-*/*/r*/run.json")):
        if "history" in p.parts:
            continue
        run = json.loads(p.read_text())
        task = json.loads((p.parent / "cell.json").read_text())
        for c in classify.export_cells(run):
            meta.append({"run": run["session"]["hash"], "task": task["taskId"][len("corpus-"):], "stratum": stratum.get(task["taskId"]),
                         "repeat": task["repeat"], "step": c["step"], "seq": c["seq"]})
            cells.append(c)
    rows = []
    for m, c, r in zip(meta, cells, classify.classify_cells(cells)):
        rows.append({**m, "lang": r["lang"], "labels": r["labels"], "flags": r["flags"], "lines": r["lines"],
                     "parser": r["parser"], "taxonomy": r["taxonomy"],
                     "outcome": outcome.get((m["run"], m["seq"] if m["seq"] is not None else m["step"])) if r["lang"] == "python" else None})
    return rows
