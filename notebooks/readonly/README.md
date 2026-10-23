# Read-only dialect notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

- [regex-cost.ipynb](regex-cost.ipynb): whether `REGEX_UNITS_PER_STEP` = 512 is sound: the ns per unit of
  `regexWork`'s bound across worst-case, counted, ordinary and seeded random patterns, the units per step it implies,
  and what ordinary surveys are charged. The timings come from `regex-bench.mjs` (`node --import tsx
  notebooks/readonly/regex-bench.mjs`). Generator: `make-regex-cost.py`.
