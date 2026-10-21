# Lane 12: the memory cap's block table fails closed (fork PR)

DONE 2026-10-21: fork #9 merged at 0169c4fd (the janitor reviewed); the re-pin and the `verify-cost` notebook in window-ml #957, merged c03e1344 (the janitor reviewed, neither finder nor builder). The as-built numbers are in the `memory` row; lane 13 is CLOSED on them. The lane's result file is `LANE_12_RESULT.md`, lane 12's to write.

Brief, 2026-10-21, by the coordinator (`repl-specs`). One fork PR on parawanderer/cpython, branch from `ml/restricted-mode`
at 7c40b038, then a window-ml re-pin (#928's shape: `pyodide-build` skill, release, pin sha, the two wasm tests).

Read first: `PYTHON_DIALECT.md`'s `memory` row to its end (the ruling is its last sentences);
[`LANE_3_RESULT.md`](LANE_3_RESULT.md) (how the last two fork PRs were built, measured and pinned); the red team's mail
`~/git/session-mail/window-ml/20261021-1300Z-redteam-e3-to-coordinator-fork6-fork7-post-merge.md` (the finding, with
lines). The red team found it and does not build or review the defence; a different session than lane 12 reviews.

## Build

1. `mem_record` (`Python/restricted.c:898`): a failed `_Py_hashtable_set` is a trip (`mem_tripped = 1`), the block is
   freed and `NULL` returned. The same for `counted_realloc`'s failure restore (`:960`, `:967`).
2. `mem_verify` runs again when an approved leaf (`allow_call`) returns, not only at the outermost entry.
3. A C test that stacks two of our wrappers, so the `hits != 1` refusal is exercised.

## Tests, failing first

- The table-OOM shape: a run grows many tiny live blocks until the insert fails, then allocates a block that must be
  refused against the cap. Needs an injectable table allocator or a lowerable capacity in the test build; pick the
  smaller, say which.
- The mid-run drop: `tracemalloc.start()` before the first run, a cell that calls an approved `stop_hook()` then the
  `DOUBLING` body against an 8 MiB cap; assert refusal.
- Both as `Lib/test/test_restricted.py` rows; mutation-check each by reverting its fix alone.

## Measure before claiming

The verify-on-return cost, natively, on the trivial-run and the many-approved-calls shapes, against 7c40b038; the
numbers go in the PR body and into the `memory` row's sentence. No "free" without them.

Added 2026-10-21 (Shane, after #9 opened with the native table): the wasm32 measurement that comes with the re-pin is a
NOTEBOOK, `notebooks/python-dialect/verify-cost/`, not a PR body. The reason is the trade #9 makes: the full probe (three
allocations per approved C call, 1.26x on a native `len()` loop) over the changed-top-only probe (1.13x) that is blind
to a hook restarted with an identical top. Under wasm32 one indirect call is already a third of a tight loop (the
janitor, mail `20261021-1138Z`), so the trade may read differently there, and revisiting it needs the raw rounds. Shape:
lane 3's `wrapper-bench/` driver (fresh process per core per round, order rotated, 8 or more interleaved rounds, a
same-core A/A control since one round's noise floor reached 1.29x, measured under four cores of foreign spin, so an upper bound until the quiet rerun), cores 7c40b038 and the #9 release, the four shapes of
#9's table plus the changed-top-only variant if it is cheap to build, raw JSON committed, the native table of #9's body
copied in as the first cell. The row's wasm32 sentence quotes the notebook. `docs/dev/notebooks.md` for the form.

## Rules that bind

Narrow beats wide; the cap errs toward refusing. Every change of the row's wording is the coordinator's, same hour as
the PR. Clone of your own; label `@python,@security`; the fork PR is merged by whoever the coordinator says once a
reviewer other than the red team has read it.
