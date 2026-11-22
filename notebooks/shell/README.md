# Shell notebooks

Each notebook has a generator beside it (`make-<name>.py`, the file to edit) and its pinned inputs under
`data/<name>/`.

- [shell-usage.ipynb](shell-usage.ipynb): which shell programs past Claude Code sessions ran through the `Bash` tool,
  ranked by distinct sessions, and so which `ml.sh` program manifests to write first: the top programs, the ones with
  no manifest, where the starting list (`top`, `ps`, `vm_stat`, ...) landed, how much each batch of new manifests
  would cover, the repo's own scripts behind `node`/`npm`, and how many calls were refused. Program names and counts
  only: `count-programs.mjs` never emits command text, and keeps a name only if two sessions ran it. Generator:
  `make-shell-usage.py`; counter: `count-programs.mjs`.
- [one-describer.ipynb](one-describer.ipynb): ruling 66's spike, the figures behind
  `docs/plan/repl/ONE_DESCRIBER_WASM_SPIKE.md`. window-ml-host's Rust describer compiled to wasm, run beside the TS
  `describeCall`: every shared vector row, a differential fuzz of 340,000 calls, size, compile and per-call time in Node,
  and the count of what the second port caught in both repos' review history. Generator: `make-one-describer.py`;
  harness and the wrapper crate's source: `one-describer/` (`build.sh` takes `WML_HOST`).
