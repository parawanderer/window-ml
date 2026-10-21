# Lane 3 result, round 4 (2026-10-21)

[`LANE_3_WRAPPER_NUMBER.md`](LANE_3_WRAPPER_NUMBER.md) is closed: under wasm32 the per-run install gains beyond the
spread, so it became a fork PR and is pinned. The coordinator's ruling on the tracemalloc finding (spec #912) landed in
the same pin, and the trial build exposed a stale release core, fixed with the recipe.

## Built

| Item | PR | Merge |
| --- | --- | --- |
| MEM/OBJ wrappers installed for a run's extent only (RAW and arena stay permanent); a free-threaded build keeps them installed | parawanderer/cpython#6 | a315999c |
| The cap's hooks verified on every domain at each restricted entry: a probe allocation counts our wrappers, zero reinstalls and re-probes, any other count refuses; a free-threaded build refuses instead of reinstalling (#912) | parawanderer/cpython#7 | 7c40b038 |
| The janitor's comment on #6, with the free-threaded limit | parawanderer/cpython#8 | 0acc4aa6 |
| Recipe stamp + witness: a changed patch set clears the stale CPython build, stdlib and install stamp; the zip's `restricted.py` must equal the fork commit's; `restrictedPySha256` in the pin; core re-released as `pyodide-314.0.3-ml-77376876-r2` | #918 | 42d5bec9 |
| Core pinned to fork 7c40b038 (`pyodide-314.0.3-ml-7c40b038`, sha b3b7e879); the spec's `memory` row as built | #928 | 07a4314d |

## Measured

- Trial core of the rebased branch: 292 s from source. The first two trial builds took 15 s and packed the OLD CPython,
  which is how the stale-core defect was found.
- Lane 5's bench cell (1M small tuple appends), 12 interleaved rounds, a fresh process per core, minimum of 3 reps per
  state:

  | State | Without per-run (median, range) | Per-run (median, range) |
  | --- | --- | --- |
  | before any restricted run | 0.129 s (0.118-0.145) | 0.126 s (0.118-0.132) |
  | after one trivial run | 0.165 s (0.151-0.220) | 0.147 s (0.138-0.158) |
  | after 3 metered runs | 0.213 s (0.150-0.237) | 0.146 s (0.142-0.158) |
  | metered | 0.544-0.689 s | 0.550-0.625 s |

  After metered work, per-run is faster in 12 of 12 paired rounds (ratio 1.03-1.59, median about 1.43). Metered runs
  themselves do not differ.
- The tracemalloc repro (host `tracemalloc.start()`, a run, `tracemalloc.stop()`, then a 2**26-item doubling cell):
  ADMITTED with `memory()` = 0 on 77376876-r2, REFUSED on 7c40b038, under wasm.
- Entry cost of the verify, natively: 80-99 µs per trivial run with and without it, no measurable difference.
- The released 77376876 core held a9f034a2's `restricted.py` (multi-line strings indented, SyntaxError columns +4);
  r2 and 7c40b038 hold f83a075b. Red team rerun on r2: 227 pass (comment 6310338059).

## Assumed where the spec was silent

- "Gain beyond the spread" was read on the paired per-round ratio after metered work, the state the brief names, not on
  the one-trivial-run state, where the ranges overlap.
- The probe counts only allocations of size 3001 to 3001+256 as its own, because tracemalloc's internal allocations
  pass through our wrapper too. The block table allocates with libc `malloc`/`free` to avoid recursing through
  tracemalloc.
- Shane allowed merging without review mid-round; fork #6 and #7 were merged by this lane, not by hand as the brief said.

## Left

- The mechanism of the slowdown without per-run unwrapping is not established: the pass-through is a flag check and an
  indirect call.
- The red team's post-merge read of fork #6 and #7, and its PR pinning its 15 column shapes as rows.
- The pre-rebase fork branch `ml/wasm32-wrappers-per-run` (d8943bef) is superseded by #6 and still on the fork; it goes
  when Shane says.

> *Drafted by Claude Code · work: repl-lane3 · session c9de9f3e · claude-opus-5-5*
