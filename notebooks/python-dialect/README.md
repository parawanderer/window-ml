# Python dialect notebooks

The measurements behind the read-only Python dialect (`docs/spec/PYTHON_DIALECT.md`). Each notebook has a generator
beside it (`make-<name>.py`, the file to edit) and its pinned inputs under `data/<name>/`; its outputs under `data/`.

- [corpus-count.ipynb](corpus-count.ipynb): every real `python_exec` cell, parsed with `ast`: node types, imports,
  builtins, library methods, and the fraction of cells each candidate whitelist admits whole. Writes `data/whitelist.json`,
  `data/node-counts.json`, `data/method-counts.json` and the first `data/manifest-pandas.json` /
  `data/manifest-numpy.json` / `data/manifest-stdlib.json` / `data/manifest-pil.json` name lists. The extract holds features, never cell text (the repo is public). Generator:
  `make-corpus-count.py`; the reader is `corpus.py` (tests: `test_corpus.py`).
