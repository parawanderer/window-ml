# Shell notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

- [shell-usage.ipynb](shell-usage.ipynb): which shell programs past Claude Code sessions ran through the `Bash` tool,
  ranked by distinct sessions, and so which `ml.sh` program manifests to write first: the top programs, the ones with
  no manifest, where the starting list (`top`, `ps`, `vm_stat`, ...) landed, how much each batch of new manifests
  would cover, the repo's own scripts behind `node`/`npm`, and how many calls were refused. Program names and counts
  only: `count-programs.mjs` never emits command text, and keeps a name only if two sessions ran it. Generator:
  `make-shell-usage.py`; counter: `count-programs.mjs`.
