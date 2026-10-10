---
name: notebooks
description: Keep a complex multi-file analysis (bench sweeps, model comparisons) as a Jupyter notebook in notebooks/<topic>/: a make-<name>.py generator, inputs pinned with wmlnb.extract, run headless with scripts/nb.mjs, checked by check-notebooks. Use when an analysis spans several files and is worth keeping but is not a feature of the bench.
---

# Notebooks

The rules and why: `docs/dev/notebooks.md`. The commands:

```bash
node scripts/nb.mjs setup                                # once: the root .venv from notebooks/pyproject.toml
node scripts/nb.mjs make notebooks/bench/<name>.ipynb    # run make-<name>.py, then execute the notebook
node scripts/nb.mjs run notebooks/bench/<name>.ipynb     # execute only (outputs written back; exit 1 if a cell raised)
NB_REFRESH=1 node scripts/nb.mjs run …                   # re-extract the pinned inputs from their source
node scripts/check-notebooks.mjs                         # what the hook and CI check
```

A new notebook: copy `notebooks/bench/make-prompt-cuts2.py` as the pattern (a markdown cell with the question, a
setup cell, `wmlnb.extract` for the rows, then one cell per table), add a line for it to the folder's README, run
`make`, and commit the generator, the `.ipynb` and its `data/<name>/` together. Edit the generator, never the notebook.
