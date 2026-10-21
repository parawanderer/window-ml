# wrapper-bench: what the memory cap's allocation wrapper costs, and the floor it is measured against

Raw runs and drivers behind the `memory` row of `docs/spec/PYTHON_DIALECT.md`. No notebook: the figures are a few
medians, computed by `aa-summary.py`, and the row quotes them.

- `drive.mjs`, `one.mjs`, `results.json`: lane 3's wrapper bench (`docs/plan/repl/LANE_3_RESULT.md`): interleaved
  rounds, a fresh process per core per round, order rotated.
- `probe3.mjs <coreDir> <dataDir>`: is the wrapper's cost per call or per byte? The same call count at six sizes
  (`spray_sz`) and 400k held ints, five reps each, before and after the first `run_cell` installs the hook.
- `drive-quiet.mjs <rounds> <out.json> <label=coreDir>...`: probe3 rounds with the load average and a spinner check
  stamped beside every row. Two labels on one core are the same-core A/A pair.
- `aa.json`: the first same-core A/A, 4 rounds, taken 2026-10-21 under four cores of foreign spin (six shell loops an
  earlier repro left running for 27 hours; found by the janitor the same day). Its per-round max of 1.29 was quoted as
  an upper bound on the floor until the retake.
- `aa-quiet.json`: the retake, 8 rounds on one core (`pyodide-core` 77376876 r1), 15:35Z to 15:36Z the same day,
  no spinners, load 2.0 to 3.8 from ambient editor helpers. The janitor's run (flaky-ci), recomputed by the coordinator.
- `aa-summary.py <aa.json>`: the figures. For `aa-quiet.json`: A/A median 0.988 (min 0.607, max 1.321), DiD median
  0.992, 35.0 ns per held allocation (16.9 to 41.4, n=16). The rule the row took from it: a wrapper-bench claim is a
  median over rounds, good to about 1% here; a single round swings 1.3x either way and is never quoted.

The 38.5 ns the row quoted before was (main_after - perrun_after) / 400k from a CROSS-core pair (always-on against
per-run install) in a run not kept here; that core is gone from the box, so it is not retaken.
