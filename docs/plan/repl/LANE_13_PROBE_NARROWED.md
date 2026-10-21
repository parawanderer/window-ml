# Lane 13: the verify-on-return probe, narrowed to the calls that can drop a hook (fork PR)

Brief, 2026-10-21, by the coordinator (`repl-specs`), written while the context was fresh. CLOSED ON THE NUMBER the same
day (window-ml #957, the `memory` row): the full probe costs about 4% at the upper quartile of 1,702 real cells, outside
the A/A spread but no widening's worth; the 1.36x is only a bare loop of approved C calls. It reopens only if a real
workload shows that shape, and Shane says so. Kept as the design for that day. Originally: it opens only
when the gate number below says the cost is visible on real cells, and Shane says so. One fork PR on
parawanderer/cpython after #9 has merged, branched from the fork tip then; a window-ml re-pin in #928's shape; the
`verify-cost` notebook rerun with the new core as a third column.

Read first: `PYTHON_DIALECT.md`'s `memory` row from "Built in parawanderer/cpython#7" to its end (the two rulings of
2026-10-21 and the wasm32 numbers); [`LANE_12_MEMORY_FAIL_CLOSED.md`](LANE_12_MEMORY_FAIL_CLOSED.md) and lane 12's
result file once it exists; `notebooks/python-dialect/verify-cost/` (lane 12's rounds; the shape this lane reruns);
the janitor's mail `~/git/session-mail/window-ml/20261021-1138Z-flaky-ci-to-repl-specs-wrapper-mechanism.md` (why a
40 ns call is a third of a tight loop under wasm32, and the 1.29x single-round noise floor taken under foreign load; retaken quiet 2026-10-21, median 0.988 over 8 same-core rounds, per-round swing 1.3x either way, so a wrapper-bench claim is a median over rounds).

## The question

Fork #9 re-verifies the cap's hooks on every domain whenever an approved call into C returns, with three probe
allocations. Under wasm32 that is about 200 ns per approved call: 1.41x on a `len()` loop, 1.34x on a lifted leaf,
nothing on a trivial run or on the cell's own Python (lane 12's trial, 8 interleaved rounds, A/A 0.92–1.10). A cheaper
check, "did any domain's top allocator change since the call began", costs 42–51 ns (1.09x, inside the A/A spread)
but is blind to one case: a hook stopped and restarted inside the call with an identical top over a chain that lost
ours. That case needs two hook libraries or host C code inside the approved call; tracemalloc alone cannot produce it.

Ruled 2026-10-21 (the row): the full probe stands as built, because the top check is a proxy for "ours is in the
chain", and trading it for a blind window is a widening, which is Shane's. This brief is that widening, designed so
that the blind window is ZERO for every call that cannot reach the allocator API, and the full probe is paid only by
the calls that can.

## The design

The full probe is needed only after a call that could have run `PyMem_SetAllocator` (or `PyObject_SetArenaAllocator`).
In CPython's own tree the callers are the tracemalloc module, the test modules (`_testcapi`, `_testinternalcapi`) and
the debug-allocator setup at startup. A function of the `builtins` module and a method of a builtin type (`len`,
`str.split`, `list.append`, `dict.get`, …) cannot reach them, except by calling BACK into Python (`sorted(key=f)`,
`map`, a `__del__`, `__eq__` in a `dict` lookup), and that Python is either the cell's own code, which is gated, or an
approved leaf, which is checked on its own return.

So, on an approved call's return:

- always: the top check on every wrapped domain (the gate lane 12 built on `lab/mem-recheck-gate`, 9c7e5fb8);
- when the callee is NOT a core builtin, or the top check sees any change: the full probe, as in #9.

"Core builtin" is decided ONCE, when the call is approved, from the callable's identity: a `builtin_function_or_method`
whose `__self__` is the `builtins` module or an instance of a builtin type, or a `method_descriptor` /
`wrapper_descriptor` of a type that lives in `builtins`. Not from the name, never from a string the cell supplies
(rule: no proxies). An extension module's function (`_tracemalloc.stop`, a host's own C) is never a core builtin, and
nor is any Python callable.

The arena allocator stays a pointer check in both branches (nothing in CPython hooks it); the free-threaded build
refuses instead of re-installing, as in #7.

## What must be true, and how it is pinned

1. No core builtin reaches `PyMem_SetAllocator`/`PyObject_SetArenaAllocator`. Pinned by a test in the fork that greps
   the tree for the callers and asserts the exact set (tracemalloc, the two test modules, `Objects/obmalloc.c`'s
   startup path); a new caller fails the test, and whoever adds one decides then whether it is reachable from a
   builtin. A grep, because it is the only check that covers a future caller.
2. The gate on its own sees every drop that changes a top. Pinned by lane 12's mid-run-drop test run against a build
   with the full probe compiled out (a `#define` for the test build), so the gate alone refuses the `DOUBLING` body.
3. The blind case is refused when the callee is not a core builtin. Pinned by the red team's test (below): two hooks,
   or a host C function in the test module, that restore an identical top over a chain without ours, inside an
   approved call; assert refusal with the narrowed probe, and assert ADMISSION with the gate alone (the blind window
   is real, and the test says exactly where it is).
4. The classification cannot be gamed from a cell: a cell that passes a Python callable, a `functools.partial` over a
   builtin, a bound method of its own class, or a builtin obtained through an approved leaf's return gets the full
   probe. Tests for each shape; `allow_call` already decides what a cell may call, and this only reads what it decided.

## Order of work (rule 10)

1. The red team, in its own session, writes the blind-case test and the gaming tests of point 4 as failing-first rows
   against #9's core, before the builder starts. The red team never builds or reviews the defence.
2. A builder session (not lane 12 if lane 12 is closed by then; any fresh session) builds the fork PR: the
   classification at approval time, the two-branch recheck, the grep test, the `#define`, and the window-ml re-pin.
3. A reviewer other than the red team and the builder reads it; the builder merges after the review; the coordinator
   writes the row's sentence the same hour.

## Measure before claiming

- The gate number, FIRST, before this lane opens: the real `python_exec` cells (read by `notebooks/python-dialect/
  corpus.py` from the local exports, features only committed) run on 7c40b038 and the #9 release under wasm32, the
  same interleaved shape as `verify-cost`. The number that decides is the per-cell ratio's median and its upper
  quartile against the A/A spread. If the upper quartile is inside the spread, this brief stays closed and the row
  stands as ruled; the notebook says so and that is the result.
- If it opens: the `verify-cost` notebook gets a third column (the narrowed core) on all of its shapes, plus two new
  shapes: a loop of calls into an extension-module function (pays the full probe) and the real cells again. The row's
  sentence quotes the three columns.
- Natively too, since the fork's own tests run there: the same shapes, so the two platforms are read side by side.

## Rules that bind

Narrow beats wide; the cap errs toward refusing: a call whose class is in doubt gets the full probe. The classification
is a fact read from the callable's identity, never a name. Every change of the row's wording is the coordinator's, same
hour as the PR. Clone of your own; labels `@python,@security`; the fork PR is merged by the builder once a reviewer
other than the red team has read it.
