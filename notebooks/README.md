# Notebooks

Analyses worth keeping that span several files and are not a feature of a tool: one folder per topic, each with a
README naming every notebook. How they are made, run and checked: [docs/dev/notebooks.md](../docs/dev/notebooks.md).

- [bench/](bench/README.md): bench sweeps (prompt variants, models, regressions).
- [ui/](ui/README.md): the panel's drawing decisions (what typing out a live call costs, and its pacing).
- [readonly/](readonly/README.md): the read-only dialect's halting constants (what a regex search costs against its bound).
- [python-dialect/](python-dialect/README.md): what the read-only Python dialect must admit, counted on real `python_exec` cells.
- `pyproject.toml`, `uv.lock`: the one environment (`node scripts/nb.mjs setup`).
- `src/wmlnb/`: what every notebook shares (`extract`, `open_ro`, `provenance`, `find_sweep`, `store`).
