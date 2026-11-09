# Python package notebooks

What `python_exec` could install on demand (`docs/spec/PYTHON_DIALECT.md`, "Packages on demand"), measured on the real
restricted-mode core. Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs
under `data/<name>/`.

- [pypi-compat.ipynb](pypi-compat.ipynb): the 2,000 most-downloaded PyPI projects judged statically by wheel tags and
  dependency closure against the core's own tags and markers, and the top 1,000 installed with micropip and imported,
  one fresh interpreter each: how many work, whether the static check predicts it, what blocks the rest, and what an
  install costs.
- [platform-scan.ipynb](platform-scan.ipynb): whether the platform limits no tag carries (processes, threads,
  `resource`, a system library) can be found in a wheel's source before the import, scored against those probes.
  Reads pypi-compat's pinned inputs; never refreshes them.
- `probe.mjs`: the core's environment (`env`), what it lacks (`core`: the stdlib modules that fail to import and the
  calls that fail), or one project installed and imported (`install <project>`).
- `pypi.py`: PyPI reads, the static verdict, why a probe failed (`cause`), and the parallel probe driver.
- `scan.py`: the import-time source scan of a wheel.
