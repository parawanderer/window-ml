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
- [pkg-imports.ipynb](pkg-imports.ipynb): every module of the 725 projects that loaded, imported one at a time on the
  core (run on mlbox in a network-limited container, 2026-11-12): how many import completely, what fails and why, the
  one crash (pillow's `PIL._imagingtk`, a wasm trap), and the one import that reached for the network. Its inputs came
  from another machine and are pinned under `data/pkg-imports/`.
- `probe.mjs`: the core's environment (`env`), what it lacks (`core`: the stdlib modules that fail to import and the
  calls that fail), or one project installed and imported (`install <project>`).
- `probe-all.mjs`, `drive.py`: the run behind pkg-imports.ipynb: one project installed and EVERY module of it
  imported (`probe-all.mjs`), over a list of pins in parallel (`drive.py`; the list is `data/pkg-imports/pins.txt`).
- `pypi.py`: PyPI reads, the static verdict, why a probe failed (`cause`), and the parallel probe driver.
- `scan.py`: the import-time source scan of a wheel.
