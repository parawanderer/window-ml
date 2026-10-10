# Notebooks: analyses worth keeping

An analysis that is complex, spans several files and is worth keeping, but is not a feature of a tool, goes in a
Jupyter notebook under `notebooks/<topic>/`. Anything reusable (a column, a score, a report section) goes into the tool
itself instead. The convention is mlbox's, which has worked there for months; the changes below are the ones it said
it would make if it started again.

## The rules

- **A notebook keeps the numbers; prose keeps the argument.** A PR description, a spec or `PROMPT_BUDGET.md` cites the
  notebook (and its section) for a figure rather than pasting a table that Python did not compute.
- **Generated, not hand-edited.** Each notebook has `make-<name>.py` beside it that writes its cells with `nbformat`.
  The generator is the file you edit and the diff reviewers read; the `.ipynb` is the executed record. Both are committed.
- **Committed with outputs**, so a reader sees the results on GitHub without running anything. A notebook's own diff is
  unreadable, and that is accepted: the generator's diff is the one reviewed.
- **Inputs are pinned by extraction.** The bench databases and run folders are gitignored, one copy per checkout, and
  change with every sweep. A notebook reads its rows through `wmlnb.extract(path, fn, source=...)`, which keeps them
  in a committed `data/<name>/` file with what they were read from, the commit and the time; later runs read the
  file. `NB_REFRESH=1` reads the source again. The first cell shows `wmlnb.provenance(...)`.
- **Run headless, never typed in.** `node scripts/nb.mjs run <path>` (or `make <path>` to regenerate first) executes
  it with nbclient and writes the outputs back. `scripts/check-notebooks.mjs` (pre-commit and CI) refuses a notebook
  without nbclient's execution timestamps on every code cell, with execution counts that skip, or with an error
  output, and one its folder's README does not name.
- **One environment.** `notebooks/pyproject.toml` with a committed `uv.lock`; `node scripts/nb.mjs setup` builds the
  root `.venv` (the kernel VS Code offers). Add a dependency there, never with `uv pip install`. The standard set is
  pandas, numpy, scipy and matplotlib; SQLite is read with `wmlnb.open_ro`, which is safe while a sweep writes.
- **Plot from the extract**, so a plot can always be redrawn; keep large images out.

## What the check does not do

It stops a stale notebook (outputs kept while cells changed) and outputs typed into the JSON. It does not stop a forged
one: anything with a shell can write the timestamps too. That needs the runtime to own the kernel and sign what ran,
which is `docs/spec/NOTEBOOK_TOOLING.md` (parked; its section 10 says what window.ml's runtime already provides).

## Traps

- **A generator that rebuilds cells must keep their metadata**, or a regenerated notebook loses its timestamps and the
  check fails (mlbox lost one notebook's evidence this way). The simple form: regenerate, then run.
- **The extract is the input.** Re-extracting after a sweep has been replaced changes the numbers; say so in the commit.
