# Notebooks

Analyses worth keeping that span several files and are not a feature of a tool: one folder per topic, each with a
README naming every notebook. How they are made, run and checked: [docs/dev/notebooks.md](../docs/dev/notebooks.md).

- [bench/](bench/README.md): bench sweeps (prompt variants, models, regressions).
- [ui/](ui/README.md): the panel's drawing decisions (what typing out a live call costs, and its pacing).
- [readonly/](readonly/README.md): the read-only dialect's halting constants (what a regex search costs against its bound).
- [pdf/](pdf/README.md): the PDF page classifier's cut-offs, read against vision models' labels of real pages.
- [python-dialect/](python-dialect/README.md): what the read-only Python dialect must admit, counted on real `python_exec` cells.
- [js-packages/](js-packages/README.md): which of the top npm packages load in a browser Worker with no Node built-ins, installed, bundled and run, and whether a static scan of the dependency closure predicts it.
- [python-packages/](python-packages/README.md): which PyPI packages `python_exec` could install on demand, judged by wheel tags and checked by installing them, and whether a source scan finds the platform limits tags cannot.
- [pyodide-mount/](pyodide-mount/README.md): what route A of #1780 (a synchronous host-backed filesystem in the Pyodide worker) costs: Stop latency, per-operation and per-hop cost, `os.walk`, `import`, large files.
- `pyproject.toml`, `uv.lock`: the one environment (`node scripts/nb.mjs setup`).
- `src/wmlnb/`: what every notebook shares (`extract`, `open_ro`, `provenance`, `find_sweep`, `store`).
