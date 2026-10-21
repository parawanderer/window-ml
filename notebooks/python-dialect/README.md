# Python dialect notebooks

The measurements behind the read-only Python dialect (`docs/spec/PYTHON_DIALECT.md`). Each notebook has a generator
beside it (`make-<name>.py`, the file to edit) and its pinned inputs under `data/<name>/`; its outputs under `data/`.

- [corpus-count.ipynb](corpus-count.ipynb): every real `python_exec` cell, parsed with `ast`: node types, imports,
  builtins, library methods, and the fraction of cells each candidate whitelist admits whole. Writes `data/whitelist.json`,
  `data/node-counts.json`, `data/method-counts.json` and the `data/manifest-pandas.json` /
  `data/manifest-numpy.json` / `data/manifest-stdlib.json` / `data/manifest-pil.json` name lists plus their
  `leaves` rows (effects, return marking and cost shapes, from `leafpass.py`), and `data/leaf-vocabulary.json`
  (what cells pass to name-resolving and callback-taking leaves). The extract holds features, never cell text (the
  repo is public). Generator: `make-corpus-count.py`; the reader is `corpus.py`; the second-pass table is
  `leafpass.py` (tests: `test_corpus.py`, `test_leafpass.py`).
- [wrapper-bench/](wrapper-bench/): the per-run MEM/OBJ wrapper install under wasm32 (lane 3, round 4). `node
  drive.mjs <rounds> <reps> <out.json> <label>=<coreDir>...` runs `one.mjs` in a fresh process per core per round,
  order alternating: a 1M-tuple plain loop before any restricted run, after one trivial run, metered, and after the
  metered runs (`after2`). `results.json` is the 12-round run of 2026-10-21 (`main` = fork 77376876, `perrun` = the
  rebased per-run branch); the table is in `docs/plan/repl/LANE_3_RESULT.md`. Not a notebook yet: no generator.
- [verify-cost/](verify-cost/): the memory cap's verify-on-return (fork #9), native and wasm32, full probe against the
  changed-top-only variant, with an A/A control (lane 12). See its README.
