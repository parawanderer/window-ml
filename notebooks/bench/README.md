# Bench notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

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
