# Lane 3 result, root H: the restricted mode, desktop

Measured by session `repl-lane3` (Claude Code, `claude-opus-5-5`, session
`834c05ec-8bfd-46af-9296-ab7f2cb1e06a`), 2026-10-15. Written up from that session's measurements and the fork by the
mechanical hand-off (Claude Code, `openrouter.xiaomi/mimo-v2.6-pro`, session
`50cb17e9-1790-434d-8eb4-9783e2c01644`), 2026-10-18, per the handover `20261015-2230Z-repl-lane3-to-coordinator-handover-H-mechanical.md`
in `~/git/session-mail/window-ml/`.

The fork is `parawanderer/cpython`, branch `ml/restricted-mode`, head `29069ba` (slices 1, 2, 4, 5, 6, the two
mid-slice landings and the print fix; the measurements of 2026-10-15 were taken at `59bee6b`, those of 2026-10-19 at
`29069ba`). Root H's design is [`LANE_3_RUNTIME.md`](LANE_3_RUNTIME.md); the dialect it implements is
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
- **111 fork tests pass** at `59bee6b`, **121** at `29069ba` (the print fix adds PrintTest and a pandas print test):
  every test in `Lib/test/test_restricted.py` (BuildTest, CompileTest, ExtentTest, GateTest, BudgetTest,
  OwnershipTest, MemoryTest, LiftedDunderTest, UndoTest, PrintTest, StockWheelsTest). The 87 vectors pass again at
  `29069ba` (2026-10-19, fixtures at `d42895d6`).
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
| `29069ba` | print: a cell's `print(...)` is rewritten at check time to `__cell_print__(str(a), …)`, so each argument goes through the cell's own gated `str()`; the writer, lifted behind a check, takes only strings (`sep`/`end` str or None, `flush` bool); `file=`, `**` and print as a value are refused |

## What a spec got wrong (each ruled by `repl-specs`)

- **Lifting C callables by default opens the C paths.** `str.format`, `getattr` and `operator.attrgetter` walk names
  they are given; unlifted (gated) they are covered by construction. They now run unlifted by default: only a manifest
  leaf marked `lift=True` runs lifted, and a callable that looks up names it is given must never be one.
- **Callbacks into lifted leaves need entry checks.** `df.apply(lambda …)` re-enters restricted through the gate; the
  callable argument must be the program's own `CO_RESTRICTED` function and a method-name string must be in the closed
  vocabulary (the pandas reductions; `query` and `eval` are out).
- **pandas' callable item keys were an escape.** `df["{0.__class__}".format]` reached a callable through a key; closed
  by a crossing check on what enters a lifted extent through `[]^` keys/values or a lifted dunder's operands.
- **print was refused in every run, and no vector or test printed.** Gated `print` looks up `sys.stdout.write`, an
  attribute read the gate refuses; 144 of the 684 runnable corpus cells print. Found by the corpus run of
  2026-10-19, fixed in `29069ba`. Output a cell wrote before a refusal has left: the undo log restores values, not
  output, so the host drops or marks a refused cell's output.
- **pandas dunders and generators need lifting through type slots and on resume.** A kind listing `__^` runs its
  Python dunders (`__len__`, `__add__`, `__eq__`, `__iter__`) lifted, and a generator created inside a lifted extent
  resumes lifted.

## What restricted mode costs on the corpus (2026-10-19, `29069ba`)

All on the patched build (specialization off throughout, so these are costs ON TOP of option C's). The same 684
runnable cells as above, in one process per condition per round, 20 timed calls per cell (median), six rounds with
the condition order reversed every other round, per-cell median across rounds. The machine was quieter than on
2026-10-15 (1-minute load 2.2 to 5.8): condition A against itself across round halves now agrees to **1.01 in
aggregate and 0.94 to 1.06 per cell (p10/p90)**, so differences of a few percent are real. Manifests and vectors
from `d42895d6`. Scripts: `scratchpad/corpus-perf/runner3.py` (conditions), `rounds3.sh` to `rounds6.sh`,
`analyze3.py`, `cmp.py`; raw results `c3-*` to `c6-*.json`.

| Condition | What it is |
| --- | --- |
| A | plain `exec` of the cell; `restricted` never imported, so no tracer and no allocator hooks |
| T, H, B | plain `exec` after one restricted run left the reference tracer (T), the allocator hooks (H), or both (B) installed; the other removed through `ctypes` |
| C | the cell under `_restricted.run`: gate, budget, depth, owned set, memory counting, undo log; code compiled outside the timing |
| M | C with the original allocators put back, so memory counting is off (`mem_install` never reinstalls) |
| K | C with every lifted leaf's Python entry check nulled (timing only; the cells that run are unaffected) |

**386 of the 684 cells run in the dialect** at `d42895d6`'s manifests (272 before the print fix). The ratios:

| Ratio | Cells | Geomean | Median | p10 / p90 | Total time |
| --- | --- | --- | --- | --- | --- |
| T / A: tracer installed, idle | 684 | **1.033** | 1.031 | 1.000 / 1.073 | 1.044 |
| H / A: allocator hooks installed, idle | 684 | **0.998** | 1.000 | 0.977 / 1.019 | 0.998 |
| B / A: both, idle (second set) | 684 | 1.035 | 1.033 | 1.000 / 1.078 | 1.049 |
| B / A: both, idle (first set, busier machine) | 684 | 1.065 | 1.059 | 1.001 / 1.140 | 1.074 |
| C / A: a restricted run, in-dialect cells | 386 | 1.742 | **1.325** | 1.200 / 4.624 | **1.332** |
| C / A, cells of 100 µs and more | 140 | 1.265 | 1.248 | 1.174 / 1.371 | 1.331 |
| C / M: memory counting inside a run | 386 | **0.995** | 0.999 | 0.970 / 1.022 | 1.002 |
| C / K: the Python entry checks | 384 | **1.005** | 1.001 | 0.979 / 1.039 | 1.002 |

- **The allocator hooks cost nothing measurable**, idle or counting.
- **The reference tracer costs about 3 to 4% on all Python in the process, between runs too**: it is called on every
  object creation and destruction, and it cannot be removed between runs because ownership persists across cells
  (a list one cell made is the next cell's to append to), so the side set must see every death or a reused address
  would be owned by accident.
- **A run adds about 25 to 35% over plain execution** on cells of real size (median C/A 1.29 for 5-50 µs cells,
  1.24 for 50-500 µs, 1.36 above). The geomean of 1.74 is dominated by sub-5 µs cells, where a run's fixed cost
  (median 0.6 µs) is most of the time. A few cells show 12 µs and more: those rebind an injected table's name
  (`df = None`), which under the wrapper's `global` frees the frame inside the timed run; under A it is a local, so
  that is the harness, not the mode.
- **Where the run's cost goes**, from a differential profile (macOS `sample`, 8 s at 1 ms over the 156 in-dialect
  cells above 50 µs, A against C; C completed 109 passes to A's 147, i.e. 1.35x): `ref_tracer` and its hashtable
  +4.5% of C's samples, the attribute gate (`PyObject_GetAttr`, `_PyObject_GetMethod`, `PyObject_GetOptionalAttr`)
  +4.4%, the call gate (`_PyRestricted_Vectorcall`) +2.9%, the step budget (`_Py_HandlePending` and
  `_PyRestricted_Tick`, taken at every call and backward jump while the run's eval-breaker bit is set, in lifted
  library frames too) +2.0%; the rest is spread thin. Neither memory counting nor the Python entry checks show.
- **Two cheap cuts if this matters:** a pointer filter in front of the owned set (a few-thousand-bit array indexed by
  pointer bits, set on insert) so that `ref_tracer`'s destroy path skips the hashtable for the many library dicts and
  lists that were never owned; and charging the budget in the eval breaker's fast path rather than through
  `_Py_HandlePending`. Neither is built.

## Specialized forms the corpus reaches, for option A (2026-10-19)

Counted on stock CPython **3.14.6** (Homebrew; the fork's base is 3.14.0, and patch releases do not change the set of
specializations), with stock `numpy==2.5.4` and `pandas==3.0.6`. Each runnable cell is called 30 times, then every
code object of the cell (its `_user` and nested functions and comprehensions) is read with
`dis.get_instructions(adaptive=True)`; one further call of a fresh compile, instrumented with `sys.monitoring`
INSTRUCTION events, counts how often each specializable instruction of the cell's own code ran. Script
`scratchpad/corpus-perf/forms.py`, result `forms.json`.

The key number is the denominator: **the 386 in-dialect cells execute about 178,000 specializable instructions of
their own code in one call each, about 460 per cell**, which is a few µs at most against a median cell time of tens of
µs. Nearly all of a cell's time is in library code: pandas, numpy and the C they call. The forms, by share of those
executions (all 684 cells in brackets):

| Family | In-dialect share | Forms that dominate it |
| --- | --- | --- |
| CALL | 22.4% (35.4%) | `CALL_METHOD_DESCRIPTOR_FAST_WITH_KEYWORDS`, `CALL_BUILTIN_FAST_WITH_KEYWORDS`, `CALL_BUILTIN_CLASS`, `CALL_LEN`, `CALL_BUILTIN_O` (all-cells: `CALL_NON_PY_GENERAL` 15.9%, `CALL_STR_1` 13.2%) |
| BINARY_OP | 20.6% (3.5%) | `BINARY_OP_EXTEND`, `_SUBSCR_LIST_INT`, `_ADD_INT`, `_ADD_UNICODE`, `_MULTIPLY_INT`; 5.1% stayed generic |
| LOAD_CONST | 16.6% (3.6%) | `LOAD_CONST_IMMORTAL`, `_MORTAL` |
| LOAD_GLOBAL | 15.6% (16.6%) | `LOAD_GLOBAL_BUILTIN` |
| LOAD_ATTR | 7.1% (4.3%) | `LOAD_ATTR_METHOD_NO_DICT` (on library objects); `_MODULE`, `_METHOD_WITH_VALUES` rare |
| FOR_ITER | 7.0% (17.5%) | generic 5.1%, `FOR_ITER_GEN` 1.7%, `_LIST` |
| JUMP_BACKWARD | 7.0% (17.5%) | `JUMP_BACKWARD_NO_JIT` |
| COMPARE_OP, TO_BOOL, the rest | under 2% each | `COMPARE_OP_INT`, `TO_BOOL_BOOL` |

What this says about option A:

- **Re-enabling forms in the cell's own code recovers next to nothing**, because that code is a few percent of a
  cell's time. Option C's measured cost (about 6%, above) is almost all library code losing its specialization.
- **The option worth building is the other cut: specialize everywhere, and make the forms that bypass the gate
  deoptimize while the gate is active.** Library code runs lifted or outside any run, where the gate does not apply,
  so it keeps every form; code running gated (the cell's, or a tier-3 library function called from it) takes the
  generic path. Concretely: the specializer does not specialize while `_PyRestricted_Active`, and each bypassing form
  (every `LOAD_ATTR_*`, `STORE_ATTR_*`, `STORE_SUBSCR_*`, `BINARY_OP_SUBSCR_GETITEM`, `SEND_GEN`, `FOR_ITER_GEN`, the
  `CALL_*` forms that call a C function or push a frame directly, `CALL_LIST_APPEND`) gets a guard on that flag. A
  gate-neutral form needs no guard: the `LOAD_CONST_*`, `LOAD_GLOBAL_*`, `COMPARE_OP_*`, `TO_BOOL_*`,
  `UNPACK_SEQUENCE_*`, `CONTAINS_OP_*`, `JUMP_BACKWARD_*` forms, and the arithmetic `BINARY_OP_*` forms on exact
  builtin types. Its cost is one thread-state load and a branch per guarded instruction, against option C's 6% on
  everything. The classification is a proposal; each form needs reading against the gate before it is trusted, and
  the build-off guards above would change to "specialization guarded", with tests that a form specialized while
  lifted deoptimizes when it next runs gated.

## Manifest gaps the corpus run shows (for the manifests' owner)

298 of the 684 cells are refused at `d42895d6`'s manifests. The top reasons, by cell (first round of condition C):
calling a class (`io.StringIO`, `csv.reader`, `decimal.Decimal` and similar, "call on type") 106;
`DataFrame.columns` 46; `DataFrame.loc` 41; `pandas.read_csv` 18; `Series.str` 13; `DataFrame.dtypes` 12; a
generator expression outside consumer position 7; `Series.dtype` 6; `Series.iloc` 6; `import sys` 4;
`DataFrame.info` 4. `str()` of an ndarray is also refused under the gate (numpy configures its printer lazily, by
attribute reads), and `DataFrame.loc`, `.columns` and `.dtypes` being absent after the second pass looks like a
property-versus-method gap in how the leaf pass reads kinds rather than a ruling.

## The 2026-10-15 crash

Not a patch regression. The full write-up is the shared memory `trap-laptop-oom-runaway-test-suite` (summarized in
`docs/plan/repl/README.md`): a `test.test_asyncio.test_runners` worker reached 14.4 GB while the tree it ran from was
being rebuilt and edited under it. The follow-up same night could not reproduce it on a clean build of the same
commit (3/3 in 1 s, peak 45 MB), and a full `test_asyncio` + `test_threading` run passed 2,902 tests in 82 s at a
146 MB peak. The rule that came out of it: never rebuild or edit a source tree while a suite runs from it.
