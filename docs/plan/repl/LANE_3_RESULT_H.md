# Lane 3 result, root H: the restricted mode, desktop

Measured by session `repl-lane3` (Claude Code, `claude-opus-5-5`, session
`834c05ec-8bfd-46af-9296-ab7f2cb1e06a`), 2026-10-15. Written up from that session's measurements and the fork by the
mechanical hand-off (Claude Code, `openrouter.xiaomi/mimo-v2.6-pro`, session
`50cb17e9-1790-434d-8eb4-9783e2c01644`), 2026-10-18, per the handover `20261015-2230Z-repl-lane3-to-coordinator-handover-H-mechanical.md`
in `~/git/session-mail/window-ml/`.

The fork is `parawanderer/cpython`, branch `ml/restricted-mode`, head `59bee6b` (slices 1, 2, 4, 5, 6 and the two
mid-slice landings). Root H's design is [`LANE_3_RUNTIME.md`](LANE_3_RUNTIME.md); the dialect it implements is
[`PYTHON_DIALECT.md`](../../spec/PYTHON_DIALECT.md). Every figure below is either read from a run artifact named
beside it or recomputed from one; the two measurement scratchpads of session `834c05ec` are named where they are the
source (`scratchpad/…` is that session's scratchpad under `/private/tmp/claude-501/-Users-sb-git-window-ml/`,
ephemeral; the scripts are named so the measurement is re-runnable).

## What the acceptance test showed

- **87 of 87 shared Python vectors pass.** Every vector in `tests/fixtures/dialect-vectors/` that carries a `py`
  program, run by `Tools/restricted/run_vectors.py` against the fork at `59bee6b`: one fresh child process per
  vector, 10 s timeout, 4 jobs. The run artifact (`results.json` at the fork's root) holds 87 rows, every one `PASS`,
  and its build gate reads `{"specialization": false, "specialization_ft": false, "tier2": false, "jit": false}`.
  By genre: abuse 43, halting 20, ownership 19, failure 5 (print has no `py` vectors). The 87 is what the fixtures
  hold at `737d0d05` — the commit messages `ec7ebb4` ("90/93") and `59bee6b` ("93/93") count wrong; the README
  status's "84 of 87" at `ec7ebb4` is the matching pre-undo-log figure. Mid-flight, after slice 2, the same runner
  recorded 85 rows, 65 `PASS` and 20 `FAIL` (`scratchpad/r2.json`).
- **111 fork tests pass**, every test in `Lib/test/test_restricted.py` (BuildTest, CompileTest, ExtentTest, GateTest,
  BudgetTest, OwnershipTest, MemoryTest, LiftedDunderTest, UndoTest, StockWheelsTest).
- **Stock wheels run unrebuilt.** `numpy==2.5.4` and `pandas==3.0.6` (cp314 macosx arm64, from PyPI) import and run on
  the patched build: StockWheelsTest, and `numpy.arange(10).sum() == 45` plus a DataFrame sum in the venv check of
  `scratchpad/corpus-perf/report.md`. **No object-header or stable-ABI change.** The patch touches only internal
  `_PyThreadStateImpl` fields (the restricted extent, the lifted flag, the lift-barrier frame) and a ninth
  eval-breaker bit (`_PY_EVAL_RESTRICTED_BIT`).

## The cost of building with specialization off (option C)

Two measurements, both on the laptop under load, both no-specialization build over stock CPython 3.14.0. A ratio
above 1 means the no-specialization build is slower.

### pyperformance, 14 pure-Python benchmarks: 1.66x geomean

Source: `scratchpad/perf2/` (`stock-<bench>-rN.json`, `nospec-<bench>-rN.json`, `load.txt`), recomputed here.

- **Method.** Interleaved rounds (stock, nospec, stock, nospec, stock, nospec), 3 rounds each; each JSON is one
  pyperformance run of one benchmark whose timed `values` (10 runs x 2 values) give the file's median; per benchmark,
  the ratio of medians per round, then the median of the 3 round ratios; the geomean over the 14 benchmarks is
  **1.657**, the handover's 1.66x.
- **Load.** The 1-minute load average over the rounds was 2.7 to 13 (`load.txt`); round 2 was the heaviest. The
  per-round geomeans are 1.617, 1.751, 1.606 — the spread is smaller than the effect, unlike the corpus run below.
- **Per benchmark** (ratio nospec/stock; median of the three rounds bolded):

| benchmark | r1 | r2 | r3 | median |
| --- | --- | --- | --- | --- |
| chaos | 1.91 | 6.02 | 1.22 | **1.91** |
| deltablue | 2.23 | 2.35 | 1.58 | **2.23** |
| fannkuch | 1.30 | 1.71 | 1.26 | **1.30** |
| float | 1.99 | 1.18 | 2.44 | **1.99** |
| go | 2.32 | 3.20 | 2.32 | **2.32** |
| hexiom | 1.67 | 1.69 | 1.69 | **1.69** |
| json_loads | 1.04 | 0.56 | 1.26 | **1.04** |
| nbody | 1.68 | 3.12 | 2.47 | **2.47** |
| nqueens | 1.31 | 2.53 | 1.25 | **1.31** |
| raytrace | 2.06 | 0.95 | 1.85 | **1.85** |
| regex_v8 | 1.08 | 0.85 | 1.08 | **1.08** |
| richards | 1.51 | 1.59 | 2.09 | **1.59** |
| spectral_norm | 1.48 | 1.66 | 1.16 | **1.48** |
| unpickle_pure_python | 1.74 | 1.73 | 1.74 | **1.74** |

### 684 real `python_exec` corpus cells: 1.064x unweighted, 1.040x weighted

Source: `scratchpad/corpus-perf/report.md` and its `results.json` (scripts `extract.py`, `runner.py`, `analyze.py`
in the same folder). The report's method and caveats are the authority; the headline:

| statistic | unweighted (684 cells) | weighted by stock time |
| --- | --- | --- |
| geometric mean | **1.064** | **1.040** |
| median | 1.085 | 1.044 |
| p10 / p90 | 0.808 / 1.384 | n/a |
| within 5% | 18.1% | 17.8% of time |
| more than 25% slower | 25.7% | 20.8% of time |
| total time ratio (sum nospec / sum stock) | | 1.066 |

Cells with stock >= 100 us (394 cells): geomean 1.070, median 1.082.

- **Method.** 2,418 `python_exec` occurrences found in bench `run.json` files (1,607 unique cells); 684 ran on both
  builds (the rest raise on stock — network, missing table, import — and measure nothing). One subprocess per
  interpreter per round, 1 untimed warm call, 20 timed calls of `_user()` with fresh tables rebuilt untimed before
  each call, median; 3 rounds alternating stock and nospec; per-cell median across rounds.
- **Noise floor.** About **±40%** per cell: stock against stock across rounds gives r2/r1 geomean 1.36, r3/r2 0.69,
  r3/r1 0.94, per-cell p10/p90 for r3/r1 0.59/1.58. Per-round geomeans of nospec/stock are 1.143, 0.974, 1.007. Only
  the aggregates mean anything; the individual ratios, including the report's ten slowest, are mostly noise. The
  aggregate says: 0 to 10% slower on these cells, central estimate about 6%, not distinguishable from 0 with
  confidence from one run. A rerun on a quiet machine would tighten it.
- **Not covered.** Cells that fetch data, read files or need images (about 60% of unique cells); import and startup
  cost; cold first calls; anything about the wasm build's absolute cost (this is native CPython only).

## The build-off guards

A specialized instruction does its attribute/item/call access inline and would bypass the abstract-layer gate, so the
build must not specialize, and a runner must refuse an interpreter that does:

- `BuildTest.test_00_specialization_tier2_and_jit_are_off` asserts `_restricted.build()` reports all four false
  (`specialization`, `specialization_ft`, `tier2`, `jit`); `test_a_hot_attribute_read_is_not_specialized` runs
  `def f(o): return o.x` 10,000 times and finds `LOAD_ATTR` and no `LOAD_ATTR_*` under
  `dis.get_instructions(..., adaptive=True)`.
- `#error` on `_Py_JIT` or `_Py_TIER2` in `Include/internal/pycore_code.h` ("window.ml restricted mode: tier 2 and
  the JIT bypass the abstract-layer gate; build without them").
- `ENABLE_SPECIALIZATION` is off (`_FT = 0`); `_restricted.build()` reports all three at run time.
- `Tools/restricted/run_vectors.py` exits 2 and refuses to run vectors unless the build gate holds.

## What each slice does

The fork's commit messages carry every design choice and its reason; read them in full. In order:

| Commit | Slice |
| --- | --- |
| `5b1d921` | 1: `CO_RESTRICTED` on the cell's code objects, the three internal thread-state fields, `_PyRestricted_Active()`, specialization/tier-2/JIT off, `Lib/test/test_restricted.py` |
| `c7e0d04` | 2: the gate in the abstract object layer and the interpreter's call path (attributes, items, imports, the six call sites); `NotInDialect`; a listed C callable runs UNLIFTED by default |
| `56c3794` | lifted leaves by function (including a bound method's `__func__`), a kind's lifted item protocol (`[]^`), `restricted.load_manifests` |
| `3ed826f` | the membership pre-pass: AST against the node whitelist, generator expressions only in consumer position (rewritten to a list comprehension), dunder names refused, `NotInDialect` before anything runs |
| `69293c5` | entry checks (`allow_call(f, lift=True, checker)`, closed method-name vocabulary, own-functions-only callbacks), `allow_dynamic` for DataFrame columns, the vector runner |
| `1c8b7db` | 4: the step budget at a ninth eval-breaker bit, the depth at a `CO_RESTRICTED` frame (256 default), `range`'s unlifted cost checker (`MAX_COLLECTION` 1e6), tripped runs; default budget 15M steps, about a second at the measured ~15M steps/s |
| `ec7ebb4` | 5: ownership (writes need an owned target; a mutating method is not read off an unowned value), the memory cap (raw allocator + pymalloc arenas, 256 MiB default, `run(..., memory=)`), pandas dunders through type slots, generators resume lifted, the crossing check on `[]^` keys/values, `re`'s backtracking check |
| `59bee6b` | 6: the undo log at the write barrier — a refused run leaves the namespace and every value it reaches as before the cell (one snapshot per owned value per run; globals dict restored; an ordinary error keeps its writes) |

## What a spec got wrong (each ruled by `repl-specs`)

- **Lifting C callables by default opens the C paths.** `str.format`, `getattr` and `operator.attrgetter` walk names
  they are given; unlifted (gated) they are covered by construction. They now run unlifted by default: only a manifest
  leaf marked `lift=True` runs lifted, and a callable that looks up names it is given must never be one.
- **Callbacks into lifted leaves need entry checks.** `df.apply(lambda …)` re-enters restricted through the gate; the
  callable argument must be the program's own `CO_RESTRICTED` function and a method-name string must be in the closed
  vocabulary (the pandas reductions; `query` and `eval` are out).
- **pandas' callable item keys were an escape.** `df["{0.__class__}".format]` reached a callable through a key; closed
  by a crossing check on what enters a lifted extent through `[]^` keys/values or a lifted dunder's operands.
- **pandas dunders and generators need lifting through type slots and on resume.** A kind listing `__^` runs its
  Python dunders (`__len__`, `__add__`, `__eq__`, `__iter__`) lifted, and a generator created inside a lifted extent
  resumes lifted.

## Still to measure (needs a quiet machine; not mechanical)

- The cost of the ownership tracer (`PyRefTracer`) and the allocator hooks on the corpus — the script is
  `scratchpad/corpus-perf/rounds-tracer.sh` (`runner-tracer.py` beside it; the partial runs in `tracer-r*.json` were
  taken under load and are not the result).
- The per-form count of specialized forms the corpus hits, for option A.

## The 2026-10-15 crash

Not a patch regression. The full write-up is the shared memory `trap-laptop-oom-runaway-test-suite` (summarized in
`docs/plan/repl/README.md`): a `test.test_asyncio.test_runners` worker reached 14.4 GB while the tree it ran from was
being rebuilt and edited under it. The follow-up same night could not reproduce it on a clean build of the same
commit (3/3 in 1 s, peak 45 MB), and a full `test_asyncio` + `test_threading` run passed 2,902 tests in 82 s at a
146 MB peak. The rule that came out of it: never rebuild or edit a source tree while a suite runs from it.
