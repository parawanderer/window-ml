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
  harness and the wrapper crate's source: `one-describer/` (`build.sh` takes `WML_HOST`). Section 7 is the differential
  run WITH path resolution (`docs/plan/repl/ONE_DESCRIBER_BUILD.md`, section 5), run against the host's shipped wasm: build
  it in a `window-ml-host` checkout with `tools/build-describer.sh <out-dir>` (not the spike's `build.sh` and `wrapper/`,
  which stay as history), then from `one-describer/`: `node --import tsx fuzz-resolved.mjs <out-dir>/describe.wasm <host
  checkout> 2000 1,2,3,7`. The mutation generator both fuzzers use is `makeFuzzer` in `one-describer/lib.mjs`.
