# Read-only dialect notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

- [regex-cost.ipynb](regex-cost.ipynb): whether `REGEX_UNITS_PER_STEP` = 512 is sound: the ns per unit of
  `regexWork`'s bound across worst-case, counted, ordinary and seeded random patterns, the units per step it implies,
  and what ordinary surveys are charged. The timings come from `regex-bench.mjs` (`node --import tsx
  notebooks/readonly/regex-bench.mjs`). Generator: `make-regex-cost.py`.
- [embed-cost.ipynb](embed-cost.ipynb): what the caps on `ml.embed` in a survey cost in wall time (`EMBED_SURVEY_CHARS`
  500,000, `EMBED_SURVEY_CALLS` 32, `EMBED_CALL_INPUTS` 512): batched CPU throughput of the box's embedding models
  through the OpenWebUI passthrough, from `embed-bench.mjs` (`node notebooks/readonly/embed-bench.mjs`, needs `.env`).
  Generator: `make-embed-cost.py`.
