# Python package notebooks

What `python_exec` could install on demand (`docs/spec/PYTHON_DIALECT.md`, "Packages on demand"), measured on the real
restricted-mode core. Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs
under `data/<name>/`.

- [pypi-compat.ipynb](pypi-compat.ipynb): the 2,000 most-downloaded PyPI projects judged statically by wheel tags and
  dependency closure against the core's own tags and markers, and the top 1,000 installed with micropip and imported,
  one fresh interpreter each: how many work, whether the static check predicts it, what blocks the rest, and what an
  install costs.
- `probe.mjs`: the core's environment (`env`), or one project installed and imported (`install <project>`).
- `pypi.py`: PyPI reads, the static verdict, and the parallel probe driver.
