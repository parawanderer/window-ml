# Cell labels

The offline cell classifier of [docs/spec/CELL_FACTS.md](../../docs/spec/CELL_FACTS.md) (Half 2): what each `exec` and
`python_exec` cell of a run is FOR, as labels read from its syntax tree. It reads the JSON export, is never stored in
one, is never shown to a model, and nothing under `src/` imports it (`tests/cell-labels.test.mjs`).

- `classify.py`: the tool, and the Python half (`ast` of the Python running it). `python3 notebooks/cell-labels/classify.py
  <run.json>...` prints a row per cell; `--write` puts `<run>.cell-labels.json` beside each export.
- `classify-js.mjs`: the JS half, called by `classify.py`: the dialect's own parser after the pointer macro, acorn when
  the dialect refuses the cell, both read as ESTree.
- `labels.json`: the rules as data, and the `taxonomy` number every row carries. A name not in it earns no label;
  changing it raises `taxonomy`.
- `fixtures.py`, `test_classify.py`: the fixture corpus (a positive and a near-miss negative per label per language,
  `synthetic` where the baseline has no case) and its test, stdlib only.
- [cell-labels-baseline.ipynb](cell-labels-baseline.ipynb): the first use, on the corpus baseline sweep: labels by
  language by stratum, Python labels by outcome, and the forms stratum task by task (`baseline.py` reads the sweep).
