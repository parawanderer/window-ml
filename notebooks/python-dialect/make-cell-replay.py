"""make-cell-replay.py — builds cell-replay.ipynb: of the python_exec cells real runs wrote, how many would finish inside
the read-only dialect, why the rest are refused, and how many cards a change to ownership would remove.

    node scripts/nb.mjs make notebooks/python-dialect/cell-replay.ipynb

The cells are written here; edit this file, not the notebook. The rows come from data/cell-replay/replay.json and
replay-owned-plain.json, which cell-replay/replay.mjs produced by replaying each recorded run's cells, in order and in
one namespace, through the restricted-mode core's inside try (NB_REFRESH=1 runs it again over the same run exports,
which live in ~/git/window-ml and are not in the repo; about four minutes per mode). The extracts hold features only:
run hash, model, cell index, outcome and the fork's refusal text, never a cell's code.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Why read-only Python cells ask: the recorded cells, re-judged inside the dialect

The question (ruled by Shane, 2026-11-19, through the coordinator): of the Python cells a run tries inside the read-only
dialect, what share finishes inside; for the refused ones, why; how many approval cards that leaves per run; and how many
refused cells would finish inside had mutation of plain data the cell did not make (a full-path cell's, or the injected
`df`/`tables`) been allowed. It decides whether a design that lets the model edit its own kernel values unasked is worth
building.

No recorded run ever tried a cell inside: every bench and observe run is page-built, and page-hosted Python skips the
dialect (`sw-run-host.ts`, "this run's Python runs on the page, where nothing is tried inside the dialect"). So the
recorded cells are REPLAYED here, offline, through the fork core's inside try. That gives an answer under these caveats,
which bound everything below:

1. **One task.** Every cell is from `csv-total` ("what is the exact total of the `amount` column of /sales.csv"), in two
   sweeps of the prompt-budget study (`prompt-budget-cuts`, `-rep2`, 2026-11-13). A summing task is close to the best case
   for a read-only dialect; nothing here says how a task that reshapes data fares.
2. **The models believed Python ran on the page.** Their prompts and results were those of page-hosted Python, with no
   dialect to stay inside and every cell approved. A model told about the dialect, or shown its refusals, would write
   other cells.
3. **Six models, unevenly.** qwen3.6:35b wrote nearly half the cells. The pooled share is that model's; read the
   by-model table.

And three of the replay's own: the injected table is rebuilt as the worker's fetch cache holds it (`kind: "rows"`, from
the fixture's deterministic CSV), not from the run's bytes; the worker's lockdown is not installed (the wrapper runs
with `hardened` off, as `tests/python-dialect-inside.test.mjs` drives it); and a refused cell's full-path rerun has no
`ml` and no network, only a read of the task's /sales.csv served from the fixture, so a cell that needed more than that
leaves less behind for the cells after it.
""")

code("""
import json, re
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "python-dialect"
PLAIN = HERE / "data" / "cell-replay" / "replay.json"
OWNED = HERE / "data" / "cell-replay" / "replay-owned-plain.json"
SERVED = HERE / "data" / "cell-replay" / "replay-read-csv-served.json"
pd.set_option("display.width", 200)
pd.set_option("display.max_colwidth", 80)

def replay(mode, out):
    raise RuntimeError(f"re-extract with: node --import tsx notebooks/python-dialect/cell-replay/replay.mjs {mode} {out} <run.json>... "
                       "(the 58 exports are listed by the extract's source; dist/pyodide must be the fork core)")

plain = pd.DataFrame(wmlnb.extract(PLAIN, lambda: replay("", PLAIN), source={}))
owned = pd.DataFrame(wmlnb.extract(OWNED, lambda: replay("--owned-plain", OWNED), source={}))
served = pd.DataFrame(wmlnb.extract(SERVED, lambda: replay("--read-csv-served", SERVED), source={}))
pd.DataFrame(wmlnb.provenance(PLAIN, OWNED, SERVED))
""")

md("""
## The classes, from the refusal text itself

Each refused cell carries the fork's own text (`not in dialect: ...`, the `notInDialect` a worker run puts on the card as
`askWhy`). The classes are read from that text alone. A mutation refusal names its kind ("item assignment to", "a method
that writes", "an in-place operator on" "a value the cell does not own"); the text does not say who made the value, so
the full-made / injected split is read from the counterfactual below instead.
""")

code("""
CLASSES = [
    ("mutation of a value the cell does not own", r"does not own"),
    ("import", r"not in dialect: (import |a relative import)"),
    ("unlisted leaf: pd.read_csv", r"attribute 'read_csv' of module"),
    ("unlisted attribute or leaf", r"not in dialect: (attribute '|the attribute )"),
    ("unlisted call", r"not in dialect: call on "),
    ("operation on None (the cell named a table it did not load)", r"on NoneType"),
    ("construct outside the dialect", r"generator expression|While|Lambda|ClassDef"),
    ("an inside-defined function called outside", r"was defined in a cell that ran inside"),
    ("step budget, memory cap or recursion", r"step budget|memory cap|recursion past"),
    ("core without the gate", r"no membership predicate|cannot be trusted"),
    ("a refusal caught by library code", r"caught by library code"),
]

def klass(text):
    if not isinstance(text, str): return None
    for name, rx in CLASSES:
        if re.search(rx, text): return name
    return "unclassified"

for df in (plain, owned, served):
    df["class"] = df.refused.map(klass)
    df["outcome"] = df["class"].fillna("finished inside")
    df.loc[df.inside & df.insideError.notna(), "outcome"] = "inside, raised (no card: the error is the result)"
# A served read_csv whose keywords make pandas raise raises that error in the cell: no card. The replay leaves the call
# as written (refused), so it is counted here, where that call is the cell's first refusal.
raised = served.csv.map(lambda c: isinstance(c, list) and any(x.get("served") == "raised" for x in c)) & served["class"].eq("unlisted leaf: pd.read_csv")
served.loc[raised, ["inside", "outcome"]] = [True, "inside, raised (no card: the error is the result)"]

print(f"{len(plain)} cells in {plain.run.nunique()} runs, {plain.model.nunique()} models")
plain.outcome.value_counts().to_frame("cells").assign(share=lambda t: (t.cells / len(plain)).round(3))
""")

md("""
## By model

The share that would have run without a card (finished inside, or raised inside), per model, and each model's refusals
by class. The spread matters more than the pooled figure (caveat 3).
""")

code("""
by_model = plain.groupby("model").agg(runs=("run", "nunique"), cells=("cell", "size"), no_card=("inside", "sum"))
by_model["no_card_share"] = (by_model.no_card / by_model.cells).round(2)
display(by_model.sort_values("cells", ascending=False))
pd.crosstab(plain.model, plain["class"]).loc[by_model.sort_values("cells", ascending=False).index]
""")

md("""
## Cards per run

A card is a refused cell (its full-path rerun is what the person approves). Recorded: every cell asked, so the recorded
cards per run are the cells per run. Replayed: only the refused ones.
""")

code("""
per_run = plain.groupby(["model", "run"]).agg(cells=("cell", "size"), cards=("inside", lambda s: int((~s).sum()))).reset_index()
print("cards per run, replayed:", per_run.cards.value_counts().sort_index().to_dict())
print("runs with no card left:", int((per_run.cards == 0).sum()), "of", len(per_run))
per_run.groupby("model").agg(runs=("run", "size"), cards_recorded=("cells", "sum"), cards_replayed=("cards", "sum"),
                             mean_replayed=("cards", "mean")).round(2)
""")

md("""
## The counterfactual: mutation of plain data permitted

Simulated without a fork change: after each cell's setup and before its code, every mutable plain-data value in the
namespace, the injected `df` and whatever earlier cells left, is rebuilt under its own name inside an inside cell, so it
is owned: a DataFrame, Series, list or dict as `x = x.copy()`, an ndarray as `numpy.array(x, copy=True)`.
`copy` is not an admitted module, so `copy.deepcopy` cannot be the rebuild. The rebuild is shallow: a container inside a
container, and the DataFrames in the `tables` dict, stay unowned. Sets are left alone (their mutators are refused as
unlisted attributes whoever made them), and strings, numbers and tuples cannot be written. The driver checks each rebuild
on a value a full-path cell made before it starts, counts the values rebuilt per cell, and stops on any rebuild the
dialect refuses, so the two replays can agree only because the outcomes do. The change removes a card only where a
cell's refusal is a mutation refusal; the upper bound is the count of cells whose FIRST refusal is that class, since a
later refusal in the same cell is hidden behind it.
""")

code("""
j = plain[["run", "cell", "model", "outcome"]].merge(owned[["run", "cell", "outcome"]], on=["run", "cell"], suffixes=("", "_owned"))
moved = j[j.outcome != j.outcome_owned]
print("cells whose first refusal is a mutation refusal (upper bound on what the change removes):",
      int((plain["class"] == "mutation of a value the cell does not own").sum()))
assert owned["rebuilt"].sum() > 0, "the counterfactual rebuilt no value"
print("values rebuilt before cells:", int(owned["rebuilt"].sum()), "over", int((owned["rebuilt"] > 0).sum()), "of", len(owned), "cells")
print("cells whose outcome changed with plain data owned:", len(moved))
moved
""")

md("""
## The other counterfactual: `read_csv` served (ruling 71)

ML_TABLE.md (ruling 71) serves `pd.read_csv(src)` inside when `src` is a URL in the run's fetch cache, a fetch result, a
readable `/files/` path, or an `io.StringIO`/`BytesIO` the cell owns; a URL the run did not fetch asks. The recorded
cells stop at their first `read_csv`, so this replay (`--read-csv-served`) serves the calls that rule serves and judges
the rest of each cell. Each call is classed by its source: a URL a `fetch_url` earlier in the run fetched, compared after
resolving both against the page as the fetch cache keys them (`by page path` when either named it as a path, which needs
V2 to resolve a page path in `read_csv` as `tables` does); an owned buffer; a URL not fetched; anything else. The replay
holds one table's bytes, so it serves only a fetched URL that resolves to the task's /sales.csv on the page's origin
(`taskTable`, recorded with the resolved path for every URL call); a fetched URL naming another file, or an owned
buffer, is left as written and still asks. A served
call becomes a frame the cell builds itself from columns real pandas parsed outside, from the task's /sales.csv bytes,
with the call's literal keywords from the allowed list. A frame read with `index_col` has its index reset to columns,
and a call whose keywords make pandas raise is left as written (served, it would raise that error in the cell, with
no card).

Packages' scratch counterfactual over the same 58 exports (every `read_csv` rewritten to one frame, keywords dropped)
gave 84 of 129 cells without a card, 46 as recorded. It ran on manifests from before #1993, which delisted
`ndarray.round`; the cell-by-cell difference from this replay is below.
""")

code("""
calls = served[served.csv.notna()].explode("csv")
calls = pd.concat([calls[["run", "cell", "model"]].reset_index(drop=True), pd.json_normalize(calls.csv.tolist())], axis=1)
print(f"{len(calls)} read_csv calls in {calls[['run', 'cell']].drop_duplicates().shape[0]} cells")
assert not calls[calls.served.eq(True)].taskTable.ne(True).any(), "a served call that is not the task's table"
display(calls.groupby(["form", calls.taskTable.astype(str).rename("taskTable"), calls.served.astype(str).rename("served")]).size().to_frame("calls"))
print("cells with no card: as recorded", int(plain.inside.sum()), "| read_csv served", int(served.inside.sum()), "| of", len(served))
""")

md("""
First refusals of the cells that call `read_csv`, as recorded and with it served.
""")

code("""
rc = served[served.csv.notna()][["run", "cell", "model", "outcome"]].merge(plain[["run", "cell", "outcome"]], on=["run", "cell"], suffixes=("_served", ""))
display(pd.crosstab(rc.outcome, rc.outcome_served, margins=True))
sc = served[served.csv.notna()]
first = sc.refused.str.replace(r"\\s*\\(line \\d+\\)", "", regex=True).str.replace("not in dialect: ", "").where(~sc.inside, sc.outcome)
first.value_counts().to_frame("cells, first refusal with read_csv served")
""")

code("""
other = served[served.csv.isna()].merge(plain[["run", "cell", "outcome"]], on=["run", "cell"], suffixes=("", "_plain"))
print("cells without read_csv whose outcome changed:", int((other.outcome != other.outcome_plain).sum()))
""")

md("""
Every recorded `read_csv` reads a URL the run had fetched: 38 by the URL the fetch used, 4 only once a page path is
resolved against the page. None reads an owned buffer and none a URL the run did not fetch, so on this task the served
rule serves every call, and the `tables`-or-buffer split decides nothing here. A task whose cells read a file the run
did not fetch would differ.

Against packages' 84: four cells finish there and are refused here at `attribute 'round' of numpy.ndarray`, which #1993
delisted after their run (two of them call `read_csv`, two do not). One cell passes `header=False`: packages' rewrite
dropped the keyword and the cell reached `attribute 'dtypes' of DataFrame`; served, pandas raises `TypeError` in the
cell, with no card. Every other cell agrees.
""")

md("""
## Behind the first refusal: a syntactic count of the stores

The bound above is on the mutation change ALONE. A refused cell stops at its first refusal, and nothing after that line
was judged: 85 cells stop at a refusal of another class, 41 of them at `pd.read_csv`. If the vocabulary is widened first,
which is what the counts above point to, those cells run further, and a mutation refusal can appear behind the first one.

So this counts, from the recorded source by `ast` and without running it, the stores the gate would judge as a mutation
of a value the cell does not own: item or attribute assignment, an augmented assignment, `del x[...]`, a call with
`inplace=True`, or a listed mutating method of list, dict or set, each on a ROOT name the cell did not bind before that
line (an import binds a module the cell did not make, so it does not count). SYNTACTIC: a store in a branch that never
runs counts, and one made through an alias the cell bound (`y = df; y["a"] = 0`) is missed. The extract
(`stores.json`, from `cell-replay/stores.py`) holds counts per kind, never the code.
""")

code("""
STORES = HERE / "data" / "cell-replay" / "stores.json"
st = pd.DataFrame(wmlnb.extract(STORES, lambda: replay("stores", STORES), source={}))
KINDS = ["item", "attr", "aug", "aug_name", "del", "inplace", "method"]
st["parsed"] = st.stores.notna()
kinds = pd.DataFrame([d if isinstance(d, dict) else {k: 0 for k in KINDS} for d in st.stores])[KINDS]
st = pd.concat([st.drop(columns="stores"), kinds], axis=1)
st["any_store"] = st[KINDS].sum(axis=1) > 0
refused = plain[plain.refused.notna()].merge(st, on=["run", "cell", "model"])
print(f"{len(refused)} refused cells; {int((~refused.parsed).sum())} do not parse as Python")
print("refused cells with a store on a value the cell did not make:", int(refused.any_store.sum()))
display(refused.groupby("class")[["any_store"]].sum().assign(cells=refused.groupby("class").size()))
refused.loc[refused.any_store, ["model", "class"] + KINDS]
""")

md("""
The one store is an attribute assignment on `decimal`'s context (`getcontext().prec = ...`). That is library state, not
plain data that a full-path cell made or that the harness injected, so a change that permits mutating such data would not
admit it either. On this sample, then, no refused cell has a store on plain data it did not make, even behind its first
refusal (syntactically, with the caveats above).
""")

md("""
## Two notes on single classes

- `attribute 'columns' of DataFrame` and `attribute 'shape' of DataFrame` (one cell each): nothing differs in those
  cells. Neither attribute is in `manifest-pandas.json` (`columns` appears there only as the dynamic rule for a
  column read by name, `df.amount`), and every form of the read is refused on the injected frame, `df.shape`,
  `x = df.shape`, `print(df.columns)` and `list(df.columns)` alike (probed through `replay.mjs` on synthetic cells).
  No recorded cell reads either inside: the three others that read them stopped at an earlier refusal.
- The "operation on None" cells are not the replay's artefact. Their recorded results are the same `TypeError` on `None`:
  the run loaded its table under another name, so `df` was `None` in the real run as well (counted below, from the
  recorded result text).
""")

code("""
none_cells = plain[plain["class"] == "operation on None (the cell named a table it did not load)"].merge(st[["run", "cell", "recorded_none"]], on=["run", "cell"])
print(f"{len(none_cells)} replayed 'operation on None' cells, {int(none_cells.recorded_none.sum())} with the TypeError on None in the recorded result; "
      f"{int(st.recorded_none.sum())} recorded cells in all")
""")

md("""
## The unclassified remainder, with examples

A refusal no class above matched, with its text (line numbers stripped). Empty means every refusal was classified.
""")

code("""
rest = plain[plain["class"] == "unclassified"]
rest.refused.str.replace(r"\\(line \\d+\\)", "(line N)", regex=True).value_counts().to_frame("cells")
""")

md("""
## Every refusal text, counted

What the classes were read from, line numbers stripped.
""")

code("""
plain.refused.dropna().str.replace(r"\\(line \\d+\\)", "(line N)", regex=True).str.replace("not in dialect: ", "").value_counts().to_frame("cells")
""")

nb = nbf.v4.new_notebook()
nb["cells"] = cells
nb["metadata"]["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "cell-replay.ipynb")
