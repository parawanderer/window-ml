# Bench notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

- [prompt-cuts2.ipynb](prompt-cuts2.ipynb): prompt budget round 2 (locate and python_exec option texts moved to
  `agent_api_docs`): passes per model under each prompt, whether a drop is more than noise, why each failure failed,
  tokens saved per call, and the ship rule. Generator: `make-prompt-cuts2.py`.
