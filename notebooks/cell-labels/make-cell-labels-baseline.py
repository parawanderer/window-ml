"""make-cell-labels-baseline.py — builds cell-labels-baseline.ipynb: the offline cell classifier's first use, on the
table-work corpus's baseline sweep (qwen3.8, as shipped): which kind of step the model gives to which language, by
stratum, and for Python which kinds ran inside the dialect.

    node scripts/nb.mjs make notebooks/cell-labels/cell-labels-baseline.ipynb

The cells are written here; edit this file, not the notebook. The rows come from data/cell-labels-baseline/, extracted by
baseline.py from the sweep `corpus` (NB_REFRESH=1 reads it again). The sweep's files hold cell code; the extract holds
labels, never the code.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Cell labels on the corpus baseline

The offline classifier of `docs/spec/CELL_FACTS.md` (Half 2: syntactic, multi-label, versioned; rules in
`labels.json`) run over every `exec` and `python_exec` cell of the corpus baseline: one model,
`qwen3.8-flash-next:vision`, 38 tasks x 3 repeats on build `9be83ae0`, corpus version 1.

**Label: "model told: stateless, no filesystem (defect)".** These runs were given the page-hosted `python_exec`
description, which says there is no filesystem and every call is stateless. Where the model reaches for JS, or probes
its environment, that is consistent with what it was told and is not evidence about the model. Reruns A and B are the
comparison.

The questions: (1) does every cell parse, and with which parser; (2) which kinds of step appear in which language, by
stratum; (3) for Python, which kinds ran inside the dialect, were asked, or never ran; (4) what the forms stratum's cells
are, as the input to forms step c (score the stratum by whether the invited form ran).
""")

code("""
import sys
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "cell-labels"
sys.path.insert(0, str(HERE))
import baseline, classify

DATA = HERE / "data" / "cell-labels-baseline"
pd.set_option("display.width", 160, "display.max_rows", 80)
SOURCE = {"sweep": "corpus", "reader": "notebooks/cell-labels/baseline.py", "classifier": "notebooks/cell-labels/classify.py",
          "taxonomy": classify.TAXONOMY, "privacy": "labels only: no cell code"}
rows = pd.DataFrame(wmlnb.extract(DATA / "cells.json", lambda: baseline.read(wmlnb.find_sweep("corpus")), source=SOURCE))
assert (rows.taxonomy == classify.TAXONOMY).all(), "the extract was classified under another taxonomy: NB_REFRESH=1"
lab = rows.explode("labels").rename(columns={"labels": "label"}).reset_index(drop=True)
LANG = {"python": "Python", "js": "JS"}
pd.DataFrame(wmlnb.provenance(DATA / "cells.json"))
""")

md("""
## Every cell, and its parser

A JS cell is read by the dialect's own parser when it can be, and by acorn when the dialect refuses it; a cell neither
reads is `unparsed`. A Python cell is read by `ast`.
""")

code("""
t = pd.crosstab(rows.lang.map(LANG), rows.parser.fillna("unparsed"), margins=True, margins_name="all")
t
""")

md("""
## Which kind of step goes to which language, by stratum

The share of cells carrying each label (a cell carries several, so a column does not sum to 100). `n` is the cells in
the column. `files` tasks have attached files, `inline` tasks a table framed whole into the message, `forms` tasks
invite a loop-like form.
""")

code("""
n = rows.groupby(["lang", "stratum"]).size()
share = (lab.groupby(["lang", "stratum"]).label.value_counts() / n).unstack(["lang", "stratum"]).fillna(0)
share = share.rename(columns=LANG, level=0).sort_index(axis=1)
order = ["ingest", "parse", "list", "probe", "inspect", "select", "transform", "aggregate", "report", "define",
         "dom-read", "dom-act", "write", "shell", "plot", "other", "unparsed"]
out = (100 * share.reindex([l for l in order if l in share.index])).round(0).astype(int)
out.loc["n"] = n.rename(index=LANG, level=0).reindex(out.columns).values
out
""")

md("""
The same, counted per language over all strata: how many cells of each kind each language got, and the JS share of
that kind.
""")

code("""
c = lab.groupby("label").lang.value_counts().unstack().fillna(0).astype(int).rename(columns=LANG)
c["JS share %"] = (100 * c["JS"] / (c["JS"] + c["Python"])).round(0).astype(int)
c.reindex([l for l in order if l in c.index])
""")

md("""
## `probe`, with and without the `ml.current` reads

Any read of `ml.current` is `probe` (the cell asks what its run holds), except `ml.current.files` and
`ml.current.attachments`, which are file metadata and so `list` only. The second column is the same cells classified
with `ml.current` reads earning nothing, so the share that rests on that definition can be read off.
""")

code("""
p = pd.DataFrame({"probe": rows.labels.map(lambda x: "probe" in x), "without ml.current": rows.probe_without_ml_current})
p.groupby(rows.lang.map(LANG)).sum().astype(int)
""")

md("""
## Python: which kinds ran inside the dialect

A Python cell's outcome, from the sweep's extract: `inside` ran inside the read-only dialect, `asked` ran outside it
(the person was asked), `not run` was refused before any code ran (its `tables` argument failed). The not-run cells'
labels describe what the model wrote, not what ran. Shares are of the cells carrying the label.
""")

code("""
py = lab[lab.lang == "python"]
assert rows[rows.lang == "python"].outcome.notna().all(), "a Python cell did not join to the sweep's extract"
o = pd.crosstab(py.label, py.outcome)
o = o.reindex([l for l in order if l in o.index])
pct = (100 * o.div(o.sum(axis=1), axis=0)).round(0).astype(int).add_suffix(" %")
pd.concat([o.sum(axis=1).rename("cells"), pct], axis=1)
""")

md("""
## Flags

`loop` is `for`, `while` or a comprehension; `returns` is a cell that ends in a return or a bare expression (a `print`
or `console.log` is not one); `by-argument` is a `python_exec` call that passed `tables`, which earns `ingest` by itself.
""")

code("""
fl = rows.explode("flags").dropna(subset=["flags"]).reset_index(drop=True)
f = (100 * fl.groupby("lang")["flags"].value_counts() / rows.groupby("lang").size()).unstack(0).fillna(0).round(0).astype(int)
f.rename(columns=LANG)
""")

md("""
## The forms stratum, task by task

The forms tasks invite `while`, recursion, a class or a generator. Per task and language: the cells, the share with a
loop, the share that define a function or class, and the share that earn only `other` (arithmetic with no data step,
the shape of a closed-form answer).
""")

code("""
fm = rows[rows.stratum == "forms"].copy()
fm["loop"] = fm["flags"].map(lambda x: "loop" in x)
fm["define"] = fm.labels.map(lambda x: "define" in x)
fm["only other"] = fm.labels.map(lambda x: x == ["other"])
g = fm.groupby(["task", fm.lang.map(LANG)]).agg(cells=("step", "size"), loop=("loop", "mean"), define=("define", "mean"), only_other=("only other", "mean"))
g[["loop", "define", "only_other"]] = (100 * g[["loop", "define", "only_other"]]).round(0).astype(int)
g.unstack().fillna(0).astype(int)
""")

md("""
## What it shows

- **Hand-parsing is a JS behaviour.** 120 of the 131 `parse` cells are JS (92%), a third or more of the JS cells in
  every stratum; Python reads the same files with `pd.read_csv` (`ingest`).
- **The JS cells probe.** 129 JS cells against 26 Python carry `probe`; 96 of those 129 earn it only by reading
  `ml.current` (a rule choice, below): the model looks for its files through the run's context, from JS.
- **Every Python `list` cell was asked** (89 of 89): `os.listdir` and its kin are outside the dialect. Few cells of any
  kind ran inside it, as the baseline's class A count (9 of 226 cells that ran) already said.
- **The forms stratum barely shows its forms.** `forms-double-weeks` has no JS cell and 3 of its 5 Python cells earn
  only `other`, the shape of a closed-form answer; `forms-cumulative-threshold` has 4 Python cells with no loop.
  This is the input forms step c will score from.
""")

md("""
## Choices the data file makes

The spec's table gives each label's leading names; `labels.json` is the rule. Where it goes past the table:

- Reading `ml.current` is `probe` (the cell asks what its run holds), except `ml.current.files` and
  `ml.current.attachments`, which are `list` only (file metadata).
- `df.to_csv()` with no path returns text, so it is `report`, not `write`.
- A call in a chain that feeds a separator `split` (`txt.trim().split("\\n")`) is part of the parse, like the `map`
  chained on it.
- An accumulation in a Python loop (`total += x`) is `aggregate`, as the spec says for JS's `for…of`.
- A `python_exec` call whose `tables` is an empty string passed no table, so it earns no `by-argument`.
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "cell-labels-baseline.ipynb")
print("wrote", HERE / "cell-labels-baseline.ipynb")
