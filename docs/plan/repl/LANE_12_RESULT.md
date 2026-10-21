# Lane 12: the memory cap's block table fails closed (result)

Work slug `repl-lane12`, session `82322dbd-8764-4509-8d70-a0026ee9ce79`, model `claude-opus-5-5`, 2026-10-21. The brief
is [`LANE_12_MEMORY_FAIL_CLOSED.md`](LANE_12_MEMORY_FAIL_CLOSED.md), with the wasm32 notebook added by Shane (#942) and
the real-cell timing added by the coordinator. All of it is done. Lane 13 stays CLOSED on the number below.

## What was built

1. **parawanderer/cpython#9**, squash-merged as `0169c4fd` on `ml/restricted-mode` (branch commits `8575f359`, then
   `b82a1088` after the janitor's review). The janitor reviewed it.
   - A failed insert into the block table trips the run at every site: `mem_record`, `counted_realloc`'s failure
     restore, and a realloc that moved and then failed to record. The last cannot return `NULL` (the old block is
     gone), so it trips and returns the block, charged. The coordinator ruled this departure correct.
   - `mem_verify` runs again when an approved call into C returns (`_PyRestricted_MemoryRecheck`), so a leaf that drops
     the hook (`tracemalloc.stop()`) cannot leave the rest of the cell uncounted.
   - Tests in `Lib/test/test_restricted.py`, each failing first and mutation-checked by reverting its fix alone: the
     table-OOM shape (a test hook, `_memory_table_fail_after`, chosen over a lowerable capacity because it needs no
     second build); the mid-run drop (fails before the fix under `PYTHONMALLOC=malloc` only: pymalloc keeps ours on
     RAW under tracemalloc); the `hits != 1` refusal, by stacking a second copy of our wrapper (`_memory_stack_ours`).
     152/152 under both allocators.
2. **Core release** `pyodide-314.0.3-ml-0169c4fd` on the fork, sha256 `226b80ba…`; `restricted.py` unchanged at
   `f83a075b`.
3. **window-ml #957**, merged as `c03e1344`: the pin (`patches.count` 21), the notebook
   `notebooks/python-dialect/verify-cost/`, `corpus.py`'s `last_codes()`, and two recipe fixes in
   `tools/build-pyodide-restricted.mjs`: a shallow `--cpython` falls back to the work clone and a missing base tag is
   fetched from python/cpython (the fork carries no `v3.14.2` tag, so a fresh clone could not export patches), and the
   clean-up regex covers patch numbers from 10 up. A trap line in `docs/dev/pyodide-build.md` for the release build's
   link failure on undefined `_Py_LibHacl_*`. The janitor reviewed it and recomputed every figure from `data/`.
4. **`lab/mem-recheck-gate`** (`9c7e5fb8`, pushed, not for merge): the variant that probes only when a domain's top
   allocator changed. Kept for lane 13 if it ever opens.

## What was measured

Each approved call into C pays three probe allocations on return; a call to the cell's own `def` is not checked.
Method: 8 interleaved rounds, a fresh process per core per round, the order rotated; a process's figure is the min of
its reps; a ratio is the median over rounds of the per-round ratio; A/A is `7c40b038` run twice per round.

| | native (macOS arm64) | wasm32 (the release core, Node) |
| --- | --- | --- |
| added per approved C call | about 55 ns | about 74 ns |
| 200k `len()` calls | 1.26x (1.23–1.35) | 1.36x (1.33–1.41); A/A 0.98–1.02 |
| 200k lifted-leaf calls | 1.20x (1.02–1.31) | 1.30x (1.26–1.37); A/A 0.95–1.03 |
| trivial `run_cell("return 1")` | 1.008 | 1.047 (1.03–1.12); A/A 0.97–1.05 |
| 200k calls of the cell's own def | 0.99 | 1.05, inside A/A 0.97–1.05 |

The gate variant: 1.13x and 1.14x natively, 1.08x and 1.09x under wasm32.

Real cells: every `python_exec` cell in the local corpus that parses (1,702), run inside the dialect as
`python-dialect-run.ts` runs one, 8 rounds × 5 reps, compared only where the outcome is the same in every process. Cell
text is never committed: the rounds hold `cell_id` (a hash), the outcome's kind and the ns.

| cells | n | median | q75 | q90 | A/A q25–q75 |
| --- | --- | --- | --- | --- | --- |
| finish (`ok`) | 217 | 1.036 | 1.045 | 1.060 | 0.999–1.014 |
| `ok`, base ≥ 1 ms | 56 | 1.028 | 1.045 | 1.060 | 0.992–1.017 |
| stop on their own error | 260 | 1.041 | 1.051 | 1.070 | 0.997–1.017 |

1,225 cells are refused (`NotInDialect`) and not compared. A typical cell is about 4% slower: outside the A/A spread,
below the 1.2x that would have opened lane 13.

**Load correction.** Six stray CPU-load shells from another session ran from 2026-10-20 until 15:22 on 2026-10-21.
The native rounds, the trial set (core `8575f359`) and the first release set ran under them; the release set was
retaken afterwards at a load average of about 3, and every figure above is from it except the native column. The
loaded sets are committed as `trial` and `release-loaded`. Their ratios agree within a few hundredths on cells and
run 0.03–0.12 higher on the call shapes; their absolute ns are about 2x. This lane's earlier figure of about 200 ns
per approved call under wasm32 is the loaded one; 74 ns is the quiet one. The native 55 ns is from a loaded run, so it
is soft.

Tests on the release core: wasm vectors 98 pass, 1 skipped; python genre 353 pass; e2e `python-stream` and
`python-dialect-inside` 3 pass, 1 skipped; `npm test` 6416 pass.

## What was assumed where the brief was silent

- The table-OOM test uses an injectable failure count, not a lowerable capacity (the brief left the choice open).
- Real cells are compared only when every process gives the same outcome kind; a cell whose outcome flips (a timeout
  near the limit) says nothing about the probe's cost.
- "Visible on real cells" was read as: q75 outside the A/A q25–q75, and the threshold to open lane 13 as a median of
  1.2x or more. The coordinator ruled on that number.
- A process's figure is the min of its reps, as lane 3's `wrapper-bench/` did.

## What is left

- **Lane 13 is closed** (repl-specs, 2026-10-21): the full probe stands, since a 4% real-cell cost does not justify a
  blind window. It reopens only if a real workload shows the bare approved-call-loop shape, and that is Shane's call.
- **Stamp the load average beside the timings** (the janitor's review of #957). The raw JSON has no load-metadata
  field, so the contamination mark and the quiet set's load average live only in the notebook's prose and the PR
  body. The quiet A/A retake is the janitor's; when it runs, `drive.mjs` records the load average before and after
  each round.
- The native column was not retaken quiet.
- The `memory` row's tail in `PYTHON_DIALECT.md` is the coordinator's, written on #957's merge.
