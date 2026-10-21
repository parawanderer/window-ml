# Lane 3: the per-run wrapper install, measured under wasm (Opus)

Read first: [`ROUND_4.md`](ROUND_4.md); `docs/spec/PYTHON_DIALECT.md`, the `memory` row of the table (all of it: it
holds the whole history of this item, the two guards, and the native result); the fork's branch
`ml/wasm32-wrappers-per-run` (one commit, "not for merge", on top of de165bb7); [`LANE_5_RESULT.md`](LANE_5_RESULT.md)
for the wasm bench cell lane 5 used.

## The one question

Installing the MEM/OBJ allocator wrappers only for a restricted entry's extent is correct on a GIL build with the two
guards the branch carries, and natively it gains nothing (2026-10-20, an ordering effect: plain exec after a run is
1.06 to 1.11x with per-run unwrapping and 1.08 to 1.19x without). It stays open for the wasm number only, because under
wasm32 the wrappers are what lane 5 measured at 1.3 to 1.5x on a million small tuples. This lane produces that number
and closes the item either way.

## Deliverables, in order

1. **Rebase the branch onto the current `ml/restricted-mode` head** (77376876) and build the Pyodide core from it, as
   you built the release core today; a trial build, not a release. Record the build time and sha as before.
2. **The number.** Lane 5's bench cell under wasm32, the same three states as the native measurement (a plain loop
   before any restricted run, after one, and metered), with and without the per-run install, interleaved rounds,
   minimum and spread reported. The question is whether plain exec AFTER a restricted run is faster with per-run
   unwrapping under wasm32, by more than the spread.
3. **Close it.** If there is a gain beyond the spread: the branch becomes a fork PR (the two guards and their tests,
   a free-threaded note), the janitor reviews the build recipe, Shane merges by hand, you release and re-pin as
   today, and the spec's `memory` row says what was measured. If there is no gain: delete the branch, and the spec
   row and the plan say so with the numbers; no re-pin. Either way the item leaves the plan's "nobody's" list.

## Not this lane

No change to the dialect, the copy-back or the gate; nothing in the host repo; no second fork change rides on this
one. If the trial build turns up anything else in the fork, it is a finding for the coordinator, not a commit.

## Who reviews

The janitor for the build recipe if there is a fork PR; the red team reads a merged fork change after merge. The
measurement itself needs no reviewer: its numbers go in the result file.
