# Lane 3: the Pyodide (wasm) build plumbing

Written 2026-10-19 by the mechanical hand-off (Claude Code, `openrouter.xiaomi/mimo-v2.6-pro`, session
`50cb17e9-1790-434d-8eb4-9783e2c01644`), per the handover
`20261015-2230Z-repl-lane3-to-coordinator-handover-H-mechanical.md` in `~/git/session-mail/window-ml/`, piece 3. It
is the plumbing note `LANE_3_RUNTIME.md` line 73 asked for ("The Pyodide build of the patch is NOT this round: it
needs the emscripten toolchain and hours per build. Write down what it will take when you know"). The wasm build
itself is not done here. The desktop numbers are in [`LANE_3_RESULT_H.md`](LANE_3_RESULT_H.md); the design is
[`LANE_3_RUNTIME.md`](LANE_3_RUNTIME.md).

## What the series is

The fork is `parawanderer/cpython`, branch `ml/restricted-mode`, head `59bee6b` (8 commits on `v3.14.0`: slices 1,
2, 4, 5, 6 plus the two mid-slice landings). Export it from a clean checkout of that branch:

```sh
git -C ~/git/cpython-restricted format-patch v3.14.0..ml/restricted-mode \
    --start-number 10 -o /tmp/pyodide-cpython-patches/ \
    -- . ':(exclude)Tools/restricted'
```

8 patches, 20 files, +3794/−31. `--start-number 10` is required: Pyodide's own `cpython/patches/` already holds
`0001`–`0009`, and the build concatenates them in glob order (below). Without the exclusion the series is 8 patches
and 21 files — the only extra is `Tools/restricted/run_vectors.py` (created in 0005, a 7-line touch in 0006), the
desktop vector runner. It is a test harness, not part of the interpreter, and it does not belong in a wasm build.
`Lib/restricted.py` and `Lib/test/test_restricted.py` stay in: the test file is what "run `test_restricted` under
node" means.

The 8 patches and the files each touches (0005 and 0006 are the ones that carry the excluded runner):

| patch | files | touches |
| --- | --- | --- |
| 0001 slice 1 | 8 | `code.h`, `pycore_code.h`, `pycore_restricted.h`, `pycore_tstate.h`, `Lib/restricted.py`, `Lib/test/test_restricted.py`, `Setup.bootstrap.in`, `_restrictedmodule.c` |
| 0002 slice 2 | 11 | `pycore_restricted.h`, `test_restricted.py`, `Makefile.pre.in`, `_restrictedmodule.c`, `abstract.c`, `object.c`, `bytecodes.c`, `ceval.c`, `executor_cases.c.h`, `generated_cases.c.h`, `restricted.c` |
| 0003 lifted leaves | 3 | `Lib/restricted.py`, `abstract.c`, `restricted.c` |
| 0004 membership pre-pass | 2 | `Lib/restricted.py`, `test_restricted.py` |
| 0005 entry checks / dynamic attrs | 8 | `pycore_restricted.h`, `Lib/restricted.py`, `_restrictedmodule.c`, `object.c`, `bytecodes.c`, `generated_cases.c.h`, `restricted.c`, **`Tools/restricted/run_vectors.py`** |
| 0006 slice 4 (budget) | 9 | `pycore_ceval.h`, `pycore_restricted.h`, `pycore_tstate.h`, `Lib/restricted.py`, `test_restricted.py`, `_restrictedmodule.c`, `ceval_gil.c`, `restricted.c`, **`Tools/restricted/run_vectors.py`** |
| 0007 slice 5 (ownership) | 8 | `pycore_restricted.h`, `Lib/restricted.py`, `test_restricted.py`, `_restrictedmodule.c`, `abstract.c`, `genobject.c`, `typeobject.c`, `restricted.c` |
| 0008 slice 6 (undo log) | 5 | `pycore_restricted.h`, `Lib/restricted.py`, `test_restricted.py`, `_restrictedmodule.c`, `restricted.c` |

## How Pyodide applies patches

Read from `pyodide/pyodide`'s `cpython/Makefile` (2026-10-19), the `$(PYBUILD)/.patched` target:

```
$(PYBUILD)/.patched: $(PYTARBALL)
	[ -d $(PYBUILD) ] || (mkdir -p $(dir $(PYBUILD)); tar -C $(dir $(PYBUILD)) -xf $(PYTARBALL))
	cat patches/*.patch | (cd $(PYBUILD) ; patch -p1)
	touch $@
```

So: the tarball is unpacked, every file matching `cpython/patches/*.patch` is concatenated in glob order and fed to
`patch -p1`. `git format-patch` output works as-is (GNU `patch` skips the mail header to the first diff). Order is
lexicographic, hence `--start-number 10`. A failure of any hunk leaves `.patched` unmade and the build stops, which
is the behaviour we want.

Pyodide's `Makefile.envs` currently pins `PYVERSION ?= 3.14.2`, archive `Python-3.14.2.tgz`
(`PYTHON_ARCHIVE_SHA256=c609e078adab90e2c6bacb6afafacd5eaf60cd94cf670f1e159565725fcd448d`). The existing 9 patches are
Pyodide's own (pymain_run_python, LONG_BIT, JsProxy_GetMethod, jsproxy modules, emscripten_syscalls, json/JsNull,
ZoneInfo warning, the emscripten signal-clock exports, the emcc-4.0.19 trampoline). Ours must come after all of them.

## The version gap: the series is against 3.14.0, Pyodide builds 3.14.2

**This is the one thing that will bite.** The fork is `v3.14.0`-based; Pyodide's `Makefile.envs` builds `3.14.2`.
Between those tags, 10 of the files our patches touch move:

| file | 3.14.0..3.14.2 |
| --- | --- |
| `Include/internal/pycore_ceval.h` | 16 |
| `Include/internal/pycore_code.h` | 7 |
| `Include/internal/pycore_tstate.h` | 4 |
| `Makefile.pre.in` | 20 |
| `Objects/genobject.c` | 6 |
| `Objects/typeobject.c` | 40 |
| `Python/bytecodes.c` | 10 |
| `Python/ceval.c` | 213 |
| `Python/executor_cases.c.h` | 8 |
| `Python/generated_cases.c.h` | 46 |

Two paths, in order of preference:

1. **Rebase the fork onto `v3.14.2` (or whatever tag Pyodide names when the build starts) and re-export.** The
   restricted-mode change is an abstract-layer gate plus a few thread-state fields plus one eval-breaker bit; none of
   it is in the code 3.14.0..3.14.2 rewrote heavily (`ceval.c` is the worry — 213 lines). Regenerate
   `generated_cases.c.h` / `executor_cases.c.h` from the rebased `bytecodes.c` with `make regen-cases` on a host
   build, and land the regenerated files in the same commit as the `bytecodes.c` change (below).
2. **Rebase only when a hunk fails**, and record which. Cheaper first try, and the failure list is the rebase's
   worklist. Do not hand-edit a rejected hunk into the generated cases.

Either way the export command above is unchanged once the branch is rebased.

## `ENABLE_SPECIALIZATION` under emscripten: already off, unconditionally

`Include/internal/pycore_code.h` (slice 1) forces it off in the header itself, not via `configure`:

```c
#define ENABLE_SPECIALIZATION 0
#define ENABLE_SPECIALIZATION_FT 0
#endif
#if defined(_Py_JIT) || defined(_Py_TIER2)
#  error "window.ml restricted mode: tier 2 and the JIT bypass the abstract-layer gate; build without them"
#endif
```

Unconditional, so it holds under emscripten with no extra work and no emscripten-specific branch. `configure.ac`'s
`--enable-experimental-jit` defaults to `no` (`jit_flags=""`, `tier2_flags=""`), so `_Py_JIT` / `_Py_TIER2` are
absent and the `#error` does not trip unless a build explicitly enables them. Pyodide's `cpython/Makefile` does not
pass `--enable-experimental-jit`. The desktop gate that `run_vectors.py` asserts
(`{"specialization": false, "specialization_ft": false, "tier2": false, "jit": false}`) is therefore expected to read
the same on a wasm build — a test worth writing when the build exists, not a worry for it.

## The budget and the emscripten signal clock share the eval-breaker path

This is the interaction the handover asked to be checked. It is safe, and here is why.

The budget rides CPython's existing eval-breaker: `_restricted.run()` sets
`_PY_EVAL_RESTRICTED_BIT` (`1U << 8`, in `Include/internal/pycore_ceval.h`, `_PY_EVAL_EVENTS_BITS` 8→9), and
`_Py_HandlePending` (`Python/ceval_gil.c`) calls `_PyRestricted_Tick` when the bit is set. The tick charges one
step and refuses on an exhausted budget, the memory cap, or a `CO_RESTRICTED` frame past the depth limit.

Under `__EMSCRIPTEN__`, `RESUME_CHECK` (`Python/bytecodes.c`) is:

```c
#if defined(__EMSCRIPTEN__)
    DEOPT_IF(_Py_emscripten_signal_clock == 0);
    _Py_emscripten_signal_clock -= Py_EMSCRIPTEN_SIGNAL_HANDLING;
#endif
    uintptr_t eval_breaker = _Py_atomic_load_uintptr_relaxed(&tstate->eval_breaker);
    uintptr_t version = FT_ATOMIC_LOAD_UINTPTR_ACQUIRE(_PyFrame_GetCode(frame)->_co_instrumentation_version);
    DEOPT_IF(eval_breaker != version);
```

Two deopts, two clocks:

- **The budget is charged on the second one.** The restricted bit itself makes `eval_breaker != version` true on
  every `RESUME_CHECK` while a run is metered, so the interpreter takes the slow path and `_Py_HandlePending` runs
  regardless of the first deopt. `Py_EMSCRIPTEN_SIGNAL_HANDLING` (the embedder opt-in, default `0` in
  `Python/emscripten_signal.c`) does not gate the budget. A metered cell pays the tick with signal handling off.
- **The signal clock is the first one, and it is independent.** `_Py_emscripten_signal_clock` starts at
  `PY_EMSCRIPTEN_SIGNAL_INTERVAL` (50) and is decremented by `Py_EMSCRIPTEN_SIGNAL_HANDLING` (so by 0 when
  handling is off — the clock never reaches 0, and the first `DEOPT_IF` never fires). When the embedder turns
  handling on (`Module.HEAP8[Module._Py_EMSCRIPTEN_SIGNAL_HANDLING] = 1`), the same slow path then runs
  `_Py_CheckEmscriptenSignalsPeriodically`, which resets the clock to 50 and delivers
  `Module.Py_EmscriptenSignalBuffer[0]` via `PyErr_SetInterruptEx`.

So the two mechanisms share the deopt path but not a counter: turning emscripten signal handling on does not
consume budget steps, and a metered run's budget does not depend on the signal interval. The one coupling that is
real is a performance one: while the restricted bit is set, every `RESUME_CHECK` deopts, so the budget's presence
dominates and the signal clock's arithmetic is paid on top of it. That is the same cost the desktop build pays.

## The committed generated cases

`Python/generated_cases.c.h` and `Python/executor_cases.c.h` are generated from `Python/bytecodes.c` by
`make regen-cases` (`Makefile.pre.in`, `regen-all`), and the fork **commits** them — 0002 and 0005 change both,
alongside their `bytecodes.c` hunks. They are not a build-time artifact: a build that only `make`s will compile
what is committed. Two rules follow.

- **The series carries the regenerated cases.** Applying it to a tarball puts the fork's cases next to the fork's
  `bytecodes.c`, which is what the desktop build compiles and what the 111 tests and 87 vectors ran against. The
  wasm build should compile those, and must not `make regen-cases` on the emscripten side (the generator runs on a
  host CPython and is not part of the emscripten build).
- **A rebase onto 3.14.2 must regenerate them.** 3.14.0..3.14.2 moves 46 lines in `generated_cases.c.h` and 8 in
  `executor_cases.c.h`. A rebase that resolves a `bytecodes.c` hunk without re-running `make regen-cases` on a host
  build produces a tree whose cases and bytecodes disagree — the failure mode is wrong instruction dispatch, not a
  build error. Land the regenerated files in the same commit as the `bytecodes.c` change.

## What running `test_restricted` under node will take

The test file is `Lib/test/test_restricted.py` (905 lines, 111 tests). It imports `unittest`, `_restricted`, and
`restricted` — all of which ship in the patched build — and `numpy`/`pandas` only in `StockWheelsTest`, which is
`@unittest.skipIf(pandas is None, …)`. It does not import the vector runner, so the `Tools/restricted` exclusion
above does not affect it.

What a run needs, in order:

1. **A patched Pyodide build.** emsdk (Pyodide's pinned emcc; the existing patch `0009-Fix-Emscripten-trampoline-with-emcc-4.0.19.patch`
   names 4.0.19), a host CPython to unpack and patch against, and the Pyodide tree. Hours per cold build on a
   laptop; `make rebuild` in `pyodide/cpython/` is the incremental path after `abstract.h` is touched. No Pyodide
   checkout exists on this machine (`~/git/` has `cpython-restricted` and `cpython-nospec`, no pyodide).
2. **The wasm build's own test entry.** `python -m test test_restricted` inside the Pyodide runtime (node driver or
   the in-browser runner). The suite's `unittest.main()` form also works. The 10 non-ABI classes (BuildTest,
   CompileTest, ExtentTest, GateTest, BudgetTest, OwnershipTest, MemoryTest, LiftedDunderTest, UndoTest) need
   nothing beyond the patched interpreter.
3. **`StockWheelsTest`, if the ABI rule is to be checked on wasm.** It needs `numpy` and `pandas` importable in the
   Pyodide runtime — that is, the Pyodide-patched wheels from the lockfile, not PyPI macOS wheels. The desktop run
   used `numpy==2.5.4` / `pandas==3.0.6` cp314 macosx arm64 ([`LANE_3_RESULT_H.md`](LANE_3_RESULT_H.md)); the wasm
   equivalent is whatever `pyodide-lock.json` names for the build. The test's assertion is the ABI rule itself:
   `_restricted.build()` has every flag `false`, and a stock wheel imports and runs lifted from a restricted cell.
4. **A quiet machine and no tree edited under the run.** The 2026-10-15 crash was a suite running while its tree
   was rebuilt and edited ([`LANE_3_RESULT_H.md`](LANE_3_RESULT_H.md), "Shown otherwise"); the rule stands for the
   wasm build too.

None of that is done here. The emsdk toolchain and the hours-long build are the reason
[`LANE_3_RUNTIME.md`](LANE_3_RUNTIME.md) line 73 put the build out of this round; this note is what it will take.

## The window-ml side (not this round)

window-ml's `dist/pyodide/` is fetched by `npm run fetch-pyodide` (`scripts/fetch-pyodide-wheels.mjs`) and bundles
the stock Pyodide runtime plus `cp314-pyemscripten_2026_0_wasm32` wheels (numpy 2.4.3, pandas 3.0.2, Pillow 12.2.0).
A restricted-mode wasm build would replace that runtime's `python.wasm` / stdlib inside `dist/pyodide/`, which is an
integration step with its own versioning (the wheels are tagged for the stock CPython they were built against —
another reason the series has to land on the tag the lockfile names). Until it does, `python_exec` runs the stock
runtime and the dialect is enforced in the JS layer only. See [`docs/dev/python-sandbox.md`](../../dev/python-sandbox.md)
and [`PYODIDE_LOCKDOWN.md`](PYODIDE_LOCKDOWN.md) for what stands in the meantime.

## What this note claims, and what it infers

Checked: the export command and its 8-patch / 20-file output (ran in `~/git/cpython-restricted` at `59bee6b`); the
file list per patch; `pyodide/pyodide`'s `cpython/Makefile` patch application and `Makefile.envs`'s `PYVERSION` and
archive hash (read 2026-10-19 via the GitHub API); the `pycore_code.h` specialization block and the
`configure.ac` JIT default; the `RESUME_CHECK` / `emscripten_signal.c` / `_Py_HandlePending` chain as the code
stands in the fork; the 3.14.0..3.14.2 per-file diffstat; `test_restricted.py`'s import list and skip condition.

Inferred: that `patch -p1` accepts `git format-patch` output (standard GNU patch behaviour, not run against
Pyodide's tarball here); that the wasm `StockWheelsTest` should take Pyodide's own wheels rather than PyPI's (the
ABI rule is about the runtime, so this is the sensible reading, not a measurement); that `make rebuild` is the
incremental path after touching `abstract.h` (Pyodide's `rebuild-all` target does exactly that, and is named in
`cpython/Makefile`).
