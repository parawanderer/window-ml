# Bench notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

- [links-prompt.ipynb](links-prompt.ipynb): LINKS.md open question 1, whether one sentence in the system prompt makes
  models write `window-ml:` links to a setting: link rate, whether the address resolves, the right place and the exact
  row per model and arm, the control, and the sentence's tokens per call. Generator: `make-links-prompt.py`.
- [prompt-cuts2.ipynb](prompt-cuts2.ipynb): prompt budget round 2 (locate and python_exec option texts moved to
  `agent_api_docs`): passes per model under each prompt, whether a drop is more than noise, why each failure failed,
  tokens saved per call, and the ship rule. Generator: `make-prompt-cuts2.py`.
- [store-tour.ipynb](store-tour.ipynb): what the bench store on mlbox holds (sweeps, models, runs, run folders),
  read with `wmlnb.store()`; the pattern for a notebook that reads the store. Generator: `make-store-tour.py`.
- [serving-decode.ipynb](serving-decode.ipynb): the Ollama fork's decode-speed prediction (`predicted_decode` on
  `gen.end`) against the speed each recorded generation ran at, per basis and per model, from the store's `box_frames`.
  Generator: `make-serving-decode.py`.
- [spend-to-date.ipynb](spend-to-date.ipynb): the bench panel's size and its cloud calls' cost, each call priced at the
  snapshot it ran under by the bench's own pricer (`price-calls.mjs`), and the calls no snapshot prices. Generator:
  `make-spend-to-date.py`.
- [sh-lease.ipynb](sh-lease.ipynb): what `SH_LEASE_MS` should be (#1437). It covers correct/wrong by lease × task × model,
  estimates given before the first `Detached`, wake turns, stalls noticed before the host's kill, and wall and GPU
  time. The first, invalid matrix (whose scripts' `sleep` the sandbox refused) is kept as the negative result.
  Generator: `make-sh-lease.py`; the recommendation prose is `data/sh-lease/RECOMMENDATION.md`.
- [sh-lease-canary.ipynb](sh-lease-canary.ipynb): the `ml.sh` safety row. A real model asked to read `~/.ssh/config` is
  refused with nothing leaked, in two placements (macOS Seatbelt, Linux bwrap), and the `~` spelling reaches the ask
  expanded. Only booleans and counts are pinned. Generator: `make-sh-lease-canary.py`.
- [tools-into-js.ipynb](tools-into-js.ipynb): `fetch_url` as a tool against `ml.fetch` inside exec (and both), over a CSV
  total and a one-fact read: correctness, steps, tokens and time per arm, which reader each run used first, where
  `ml.fetch` appears in the exec arm, switching in the both arm, and three local models against a cloud pair. Generator: `make-tools-into-js.py`; the recommendation prose is `data/tools-into-js/RECOMMENDATION.md`.
- [sh-lease-peek.ipynb](sh-lease-peek.ipynb): the `ml.sh` lease re-run with the host's `peek` (v0.9.0): tails made on a
  running detached call and how many returned output, whether the answer mentions progress, the `build` arm against the
  2026-11-07 one, and what a 5 s lease costs the new 10 s `tests` task. Generator: `make-sh-lease-peek.py`; the
  recommendation prose is `data/sh-lease-peek/RECOMMENDATION.md`.
