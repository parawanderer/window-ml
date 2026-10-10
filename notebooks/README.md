# Notebooks

Analyses worth keeping that span several files and are not a feature of a tool: one folder per topic, each with a
README naming every notebook. How they are made, run and checked: [docs/dev/notebooks.md](../docs/dev/notebooks.md).

- [bench/](bench/README.md): bench sweeps (prompt variants, models, regressions).
- `pyproject.toml`, `uv.lock`: the one environment (`node scripts/nb.mjs setup`).
- `src/wmlnb/`: what every notebook shares (`extract`, `open_ro`, `provenance`).
