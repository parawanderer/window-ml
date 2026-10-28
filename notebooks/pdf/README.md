# PDF notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit). Its inputs are the committed files in
`data/`, written by the scripts below; the PDFs themselves and the text excerpts stay in the gitignored corpus cache,
`tests/e2e/artifacts/pdf-corpus/`.

- [pdf-thresholds.ipynb](pdf-thresholds.ipynb): where the page classifier's provisional cut-offs (`pdf-classify.ts`,
  `pdf-measure.ts`) should sit, read against a local vision model's labels of 373 real pages and Claude Opus 5.5's of
  40, with what the labels cost. Generator: `make-pdf-thresholds.py`.

The scripts, in the order they run (each says how in its header):

1. `fetch-corpus.mjs`: downloads the 83 documents named in `corpus.json`, each checked against its sha256.
2. `measure-corpus.mjs`: reads every page with the extension's reader and writes `data/pages.jsonl` and
   `data/docs.jsonl`.
3. `select-pages.mjs`: picks the pages near a cut-off plus controls (`data/selection.jsonl`), and with `--opus` the
   calibration set from the local model's labels (`data/selection-opus.jsonl`).
4. `label-pages.mjs`: renders each selected page in the built extension and labels it through `ml.step`
   (`data/labels-<model>.jsonl`), recording the box's event log for the energy.
5. `cost.mjs`: prices the cloud model's calls and reads the local model's energy (`data/cost.json`).
