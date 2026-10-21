# verify-cost: the memory cap's verify-on-return (fork #9)

- [verify-cost.ipynb](verify-cost.ipynb): what fork #9's verify-on-return costs natively and under wasm32, for the full
  probe it ships and the changed-top-only variant (`lab/mem-recheck-gate`), against 7c40b038, with a same-core A/A
  control. Generator: `make-verify-cost.py`.
- `shapes.py`: the four shapes, shared by `native_bench.py` (a native `./python.exe`) and `one.mjs` (one Pyodide).
- `drive.mjs <rounds> <reps> <out.json> <label>=<coreDir>...`: interleaved rounds, a fresh process per core per round,
  order rotated; two labels on the same core are the A/A pair. Writes every rep.
- `data/native-full.jsonl`, `data/native-gate.jsonl`: the native rounds behind #9's table (2026-10-21);
  `data/wasm-rounds.json`: the wasm32 rounds.
