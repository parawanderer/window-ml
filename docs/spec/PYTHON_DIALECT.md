# Spec (WIP): a read-only dialect of Python, and the namespace it runs in

**Status: decided, nothing built.** Decided by Shane on 2026-10-15, after a discussion that first proposed treating
Python as a sandbox and was corrected. This spec holds that decision, the reasons, the design, and the answers to the
open questions on persistent Python state in [`STATE_INSPECTOR.md`](STATE_INSPECTOR.md) ("Python state persists per
run") and [`PERSISTENT_RUNTIME_SPEC.md`](PERSISTENT_RUNTIME_SPEC.md). It is the second implementation of the concept the
JS dialect implements ([`docs/dev/readonly-exec.md`](../dev/readonly-exec.md)), and the main consumer of
[`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md).

## Why a dialect, when Pyodide is already a sandbox

The sandbox position was argued and rejected. Its case: Pyodide is a sealed WebAssembly worker, nothing crosses except by
copy through a callback, and a stuck cell is killed by terminating the worker, so the Python equivalent of the JS dialect
is the callback gate plus the kill switch. Four things are wrong with it.

1. **A sandbox is a property of a place; a dialect is a property of the program.** Under "placement is unobservable"
   ([`SHELL.md`](SHELL.md)), a read-only Python cell must be safe wherever the runtime puts it, and the place that
   matters most is the process host's real CPython, with numpy at native speed and no WebAssembly around it. Only a
   proof about the program travels there.
2. **A sandbox decays.** The original Pyodide hardening was a deny-list of things to purge (`js`, `pyodide_js`, the
   network globals; `harden()` in `src/python/python-runtime.ts`). Red-teaming (`#698`, `#708`, `#735`,
   [`docs/plan/repl/PYODIDE_LOCKDOWN.md`](../plan/repl/PYODIDE_LOCKDOWN.md)) proved six concrete escape routes past a
   Python-level deny-list in unpatched Pyodide: `import _pyodide_core` (`jsproxy_c` is compiled into the main WASM
   binary), `Object.__getattribute__(proxy, "constructor")` bypassing JS proxy get traps to reach the worker's
   `Function` constructor (`Function("return globalThis")()`), `import ctypes; ctypes.CDLL(None)` calling Emscripten's
   `emscripten_run_script`, monkey-patching `builtins.__import__` / `sys.stdout` to spoof harness return markers, and
   `asyncio` background tasks firing `postMessage` after a cell returns. Even after locking down the JS worker realm at
   boot (`ses` `lockdown()` plus an explicit global allow-list in `src/python/lockdown.ts`, `#735`) so the worker holds
   only closure-captured capabilities, any in-worker sandbox remains a boundary around the *worker*, not around the
   *program*: only the dialect's CPython gate holds inside the interpreter and on the native host.
3. **Persistent state brings rollback back.** A sandboxed cell that is refused halfway has already mutated the run's
   namespace. An owned-value interpreter restores what it touched, as `evalReadonly` does.
4. **Totality composes; a timer does not.** Every program the dialect admits terminates within a cost bound known before
   or during the run. A policy, a manifest cost and a survey can then be reasoned about together, and a budget can be
   shared across placements. A kill after N seconds proves nothing about the program, and Python is Turing-complete
   by default although almost nothing a model does with it needs to be.

## The design: the evaluator is CPython, under a restricted mode we add

**Refined on 2026-10-15, the same day, replacing a first draft that put an evaluator written in Python above the
runtime.** That draft was the Python analogue of the JS tree-walker, and the tree-walker has already proved what a
read-only language is worth; a second proof-of-concept at that layer teaches nothing. In V8 the dialect cannot be hooked
into the runtime without shipping a browser, which is why the JS side's best move is a bytecode compiler
([#277](https://github.com/parawanderer/window-ml/issues/277)). CPython is different: Pyodide already builds it from a
patch series, and the process host runs a build we ship. So the gate goes where it belongs, in the interpreter's abstract
object layer, and the cost of interpretation goes to zero.

Where each property of the dialect lives:

| Property | Where | How |
| --- | --- | --- |
| membership | a Python-side pre-pass, unchanged | `ast.parse`, a WHITELIST of node types (the one ratchet), `compile` with a new code flag, `CO_RESTRICTED`; an unlisted node is `NotInDialect` before anything runs |
| the gate | a thread-state flag with DYNAMIC extent | set on entering a restricted frame; checked in `PyObject_GetAttr`, `PyObject_SetAttr`, `PyObject_GetItem`, `PyObject_SetItem`, `PyObject_Call` and `IMPORT_NAME`, one branch per abstract call, against the kind tables (methods allowed per receiver kind, dunders refused outright, which cuts the `__class__` → `__subclasses__` chain at its root) |
| C leaves | every allowed C callable runs UNLIFTED by default: the flag stays on, so the lookups it makes from its arguments hit the gate. Only a manifest leaf marked `lift` runs with the flag lifted for its dynamic extent (lane 3, 2026-10-15; the first draft lifted by default, which was wrong) | the C paths are covered by construction only while C runs unlifted: `"{0.__class__}".format(1)`, `getattr(x, "__class__")`, `hasattr`, `operator.attrgetter` all escape through a lifted callable. numpy's and pandas' internals legitimately touch dunders, so their leaves are lifted, by the manifest ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)) that approves the call and says what it returns, with the rule that a lifted leaf never resolves a NAME it is given |
| callbacks | inside a lifted leaf, the gate also fires when a `CO_RESTRICTED` frame sits between the current frame and the lift barrier | a `lambda` handed to `df.apply` runs restricted inside pandas' C loop; the manifest's `@calls` falls out of this instead of being an annotation the interpreter has to honour. No per-frame depth counting: the state is set for the C extent of an ENTRY and the walk happens only inside a lifted leaf, up to its barrier |
| entries | `_restricted.run(code, ns)` for a cell, `_restricted.call(fn, …)` for a registered command | restriction is a property of the ENTRY, not of a function's callers: a dialect-defined `def` called bare from full-mode Python or from the host's own code runs unrestricted, which escalates nothing since that caller already holds full capability. The one rule that follows: anything invoking a dialect-defined function AS A COMMAND on the strength of tier 3 ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), "Two kinds of command") goes through `_restricted.call`, because the proof holds only while the body runs restricted |
| the step budget | a counter at the eval breaker | CPython already checks it on backward jumps and calls, which is where loops and recursion are; a few lines in `ceval`. The halting rules below still refuse the unbounded forms statically, so a refusal happens BEFORE running where it can |
| ownership | an allocation hook under the flag, plus the manifest's return marking | an object allocated while restricted is owned; a leaf's `fresh` return is marked owned, `alias(i)` inherits argument i's, `internal` is never owned (a view from `reshape`). A side set keyed by pointer, with removal on dealloc, so the object layout is unchanged |
| rollback | an undo log at the write barrier | every restricted write records container, key and old value, and a refusal replays it; a C leaf marked `mutates(i)` on a value from an earlier cell gets a copy first, or a refusal |
| memory | the same allocation hook, on EVERY allocator domain in use | a byte count per cell, the native form of the JS dialect's `MAX_COLLECTION`. The hook wraps the domain an allocation actually reaches, never one layer it is assumed to pass through: the first cut hooked the RAW domain and pymalloc's arenas, which Pyodide's CPython is built without (`--without-pymalloc`), so under wasm32 the MEM and OBJ domains went straight to `malloc` and the count saw almost nothing (lane 3, 2026-10-19, found from lane 5's two wasm32 vectors). A sequence repeat's size is judged against the count before CPython's own overflow guards, so the refusal is `NotInDialect` and never `OverflowError`/`MemoryError`; the tests run under `PYTHONMALLOC=malloc` natively, which is the same wiring. The MEM and OBJ wrappers are installed only for the outermost run's extent, so plain exec outside a run allocates with nothing in between (RAW stays installed); built in parawanderer/cpython#6 (merged a315999c, 2026-10-21) with two guards against stacked hooks: `MemoryEnd` restores only while the installed allocator is still ours, so a hook stacked on ours during a run (`tracemalloc.start` from host code) is not dropped, and `MemoryBegin` never wraps our own wrapper, or every block counts twice. A free-threaded build keeps them installed from the first run on, since no domain is swapped without a GIL; its FIRST wrap is still unlocked (the janitor's review of #6), a named limit outside Pyodide's build. Measured: natively NO gain (2026-10-20, the generalist: plain exec after a run 1.06–1.11x of before with per-run unwrapping, 1.08–1.19x without, an ordering effect); under wasm32 a gain beyond the spread (lane 3, 2026-10-21: 1,000,000 `(i, i+1)` appends, 12 interleaved rounds, a fresh interpreter per core per round, minimum of 3 per state: plain exec after three metered runs 0.142–0.158 s with per-run wrapping and 0.150–0.237 s without, median 0.146 vs 0.213, faster in all 12 paired rounds; equal before any run and in the metered run itself). Lane 5's earlier 1.3x was the always-installed cost this removes. Its mechanism, settled by the janitor (2026-10-21, mail `20261021-1138Z-flaky-ci-to-repl-specs-wrapper-mechanism.md`, measurement only): one extra C frame and a second function-pointer call on every MEM/OBJ allocation, about 40 ns each (38.5 ns median per held int; 105–122 ns per alloc+free pair, FLAT from 1 B to 2048 B, so not locality; 1.00 before the first restricted run, so not the interleaving), invisible natively because libc malloc already costs more than that. Two measurement rules it leaves: a same-core A/A control's per-round MAX reached 1.29x, taken under four cores of foreign spin (six load shells an earlier repro left running for 27 hours; found 2026-10-21, 13:30Z mail); RETAKEN QUIET the same day (the janitor, 15:35Z, 8 same-core rounds on one core, min over reps, median over rounds, load average and a spinner check stamped beside every row, no spinners, load 2.0-3.8 from ambient editor helpers; raw `notebooks/python-dialect/wrapper-bench/aa-quiet.json`, its driver and `aa-summary.py` beside it, the figures recomputed by the coordinator): A/A median 0.988, difference-in-differences median 0.992 (1.009 the other way round), per-round min and max 0.607 and 1.321. So a wrapper-bench claim is a MEDIAN OVER ROUNDS and is good to about 1%; a single round swings 1.3x either way and is never quoted. The absolute cost the row quotes is the same-core (after minus before) per held allocation, median 35.0 ns (16.9-41.4, n=16); the earlier 38.5 ns was a cross-core pair (always-on against per-run install) from a core that is gone from the box, so it is not retaken, and the 122 ns upper figure was taken under the spin.3 from one paired round; and plain exec after ANY restricted run is 1.33–1.51x slower on both cores, so "worse after metered than after trivial" is that shift plus spread, not accumulation in the wrapper. A second defect of the first cut, native only: the allocator name was read AFTER RAW was wrapped, so under pymalloc the MEM/OBJ domains were wrapped too and every block counted twice (`[0]*10**6` counted 16,000,800 bytes; the desktop host's 256 MiB cap refused at about 128 MiB); the name is read first (parawanderer/cpython#3, the test pins that number; lane 4 verified natively over 5,715 allocator states, and under the default 256 MiB cap the largest `[0]*n` is exactly 2^25 items). A hook installed on pymalloc BEFORE the first run (`-X tracemalloc`, or host code calling `tracemalloc.start` first) hides the allocator's name, and a hidden name used to mean "wrap MEM/OBJ", so the cap counted every block twice again and refused at half its number (lane 4's review, 2026-10-20, listed as a limit that errs toward refusing); fixed the same day in parawanderer/cpython#4 (merged b0bbaa5, lane 4 reviewed): when the name is hidden, the startup choice (`_PyRuntime.preconfig.allocator`) decides, pinned by a tracemalloc variant of the memory test. Left out, by design: an embedder that swaps the MEM/OBJ allocators after startup. Pyodide is unaffected (its name reads `malloc`), so no rebuild is needed for it. A Python-level swap is NOT left out (lane 3, 2026-10-21, measured on 77376876 under both allocators): `tracemalloc.start()` from host code, then any restricted run, then `tracemalloc.stop()` puts back the allocators saved at start, which predate ours, so RAW, MEM and OBJ are all dropped for good and a later dialect cell growing 512 MB of pointers is admitted with `memory() = 0` (a one-shot repeat is still refused, since that check is arithmetic). Only approved full-path code can do it and the consequence is an uncapped cell, a worker OOM, not an escape. Ruled the same day: at EVERY restricted entry the hooks are verified installed on every domain in use and re-installed when not, or the run refuses; a universal check, so it also covers any other swap, not a tracemalloc special case. The per-run branch's MEM/OBJ re-wrap is half of it (RAW stays lost under pymalloc); the fork fix is lane 3's, its own PR after the wasm number, with the repro as its test, read by the red team after merge. Built in parawanderer/cpython#7 (merged 7c40b038, 2026-10-21): at each outermost entry every wrapped domain (RAW; MEM and OBJ without pymalloc) gets one allocation of a distinctive size through its public API, counting the wrappers of ours it passes. One means ours is in the chain, on top or under a stacked hook. None means it was dropped, and ours goes back on top; anything but one after that refuses the run. Only the probe's own size counts, since tracemalloc's trace entries pass through ours too. The arena allocator, which nothing in CPython hooks, is checked by pointer. A free-threaded build refuses instead of re-installing. The block table allocates from the C library, because through RAW a restarted tracemalloc chained back into our wrapper without end. Entry cost natively: none measurable next to a trivial run's 80–99 µs. The repro is the test, under pymalloc, `PYTHONMALLOC=malloc` and `-X tracemalloc`. Red team's post-merge read of #6 and #7 (2026-10-21, mail `20261021-1300Z-redteam-e3-to-coordinator-fork6-fork7-post-merge.md`): both hold on the path the ruling names; one hole in the row as written, ruled the same day. The block table FAILS OPEN: `mem_record` ignores a failed `_Py_hashtable_set` (`restricted.c:898`), so when the table's own node allocation fails the block is live and uncharged and every later block too, and the run is uncapped from then on; the owned set and the lifted-generators table use the same idiom and are fail-closed by construction (not recorded means not owned, stays gated), which the cap's direction is not. Reachable only when the table's malloc fails while the cell's own still succeeds (a process near its limit; zero-byte blocks take a node at zero charge), so a resource-limit hole and not an escape, but a hole in "a byte count per cell". RULED: a failed insert is a TRIP, the block freed and `NULL` returned, and the same for `counted_realloc`'s failure restore (`:960`, `:967`): the cap errs toward refusing, never toward not counting. One case the letter cannot cover, ruled on lane 12's question (2026-10-21, fork #9, merged at 0169c4fd): a realloc that SUCCEEDED and then fails to record cannot be freed and `NULL` returned, since the block may have moved and the caller's old pointer is gone; it trips the run, stays charged and is returned, and the tripped run executes nothing after it. The verify-on-return is per approved call into C, lifted or not. AS BUILT (lane 12, 2026-10-21; window-ml #957, merged c03e1344, pins the fork's 0169c4fd release; the rounds and the raw JSON in `notebooks/python-dialect/verify-cost/`, reviewed by the janitor, who recomputed every figure from `data/`): natively about 55 ns per approved call (1.26x on a `len()` loop); under wasm32 about 74 ns per approved C call on a quiet machine, 1.36x on a bare loop of approved C calls (1.326-1.405, same-core A/A 0.975-1.019), 1.30x on a lifted leaf, 1.047 on a trivial run and 1.05 on the cell's own defs, both inside the A/A; the gate's own cost 1.08-1.09x; on 1,702 real cells (217 ok, 260 own-error, 1,225 refused; a fresh process per core per round, order rotated, min over reps and median over rounds) the ok cells' median is 1.036 and upper quartile 1.045 against an A/A of 0.999-1.014, the cells whose base runs a millisecond or more 1.028 and 1.045, own-error cells 1.041 and 1.051. The 200 ns and 1.41x of the trial were taken under six foreign load shells (the `trial` and `release-loaded` sets, marked), as the native 55 ns may have been; the ratios agree within a few hundredths, the absolute nanoseconds are about 2x. A changed-top-only probe (42-51 ns, 1.09x) is blind to a hook restarted with an identical top, so it is not used, and the full probe STANDS (ruled 2026-10-21): the changed-top check is a proxy for "ours is in the chain", and its blind window is one where bytes are not counted, so no counted quantity can bound it. The narrowing that pays the full probe only after calls that can reach the allocator API ([`LANE_13_PROBE_NARROWED.md`](../plan/repl/LANE_13_PROBE_NARROWED.md)) is CLOSED on the number (ruled 2026-10-21): about 4% at the upper quartile of real cells is outside the A/A spread and worth no widening; the 1.36x exists only on a bare loop of approved C calls, and the brief reopens only if a real workload shows that shape, which is Shane's call. Also ruled: "every entry" is not every moment of a run. An approved leaf (`allow_call`) that swaps the allocator back mid-run (`tracemalloc.stop()` from host code) uncaps the rest of that cell until the next outermost entry; the verify runs again when an approved leaf RETURNS, built in fork #9 with the cost above. The `hits != 1` refusal (a domain that would count twice) is covered by #9's C test that stacks two of our wrappers; its mutation (`== 0`) fails the test. One limit stated, not fixed: the cap is per thread (`mem_mine`), so a C library allocating on its own threads is outside the count, which the shipped wasm32 core cannot do. Left for the next rounds (the janitor's review of #957): the raw JSON carries no load metadata, so the quiet A/A retake stamps the load average before and after beside the timings. |
| imports | the `IMPORT_NAME` gate | a module is a receiver kind with an allow list; a package installed on demand arrives with its manifest or as `unknown` |

**Two things this does that nothing above the runtime can**, and both are why Python 2's `rexec` and RestrictedPython's
list of CVEs look the way they do:

1. **The gate covers the C paths.** `str.format` walking `"{0.__class__}"`, `getattr`, `operator.attrgetter`, pickle:
   all of them go through `PyObject_GetAttr`. An evaluator or an AST rewrite guards the Python-visible paths and has to
   ENUMERATE them; the abstract layer is a small, stable set of entry points. Enumerating entry points beats enumerating
   tricks. **With one condition the first draft missed** (lane 3, 2026-10-15): CPython 3.11+'s specializing interpreter
   rewrites hot `LOAD_ATTR`, `STORE_ATTR`, subscript and `CALL` instructions into about forty-five specialized forms that
   do the access inline and never call the abstract function, and `CALL_LIST_APPEND`/`STORE_SUBSCR_DICT` skip the write
   barrier too; a library warmed up before a run holds already-specialized instructions. So the honest claim is: every
   access goes through the abstract layer BECAUSE the build has specialization off (`ENABLE_SPECIALIZATION`, and the
   free-threading variant, off; the tier-2 interpreter and the JIT off). The build switch is part of the security
   argument, the patched interpreter ASSERTS it at runtime through `_restricted` and the vector suite's first test
   checks it, and a warm-library vector (specialize a pure-Python function, then run it restricted and watch the gate
   fire) guards it forever. Per-form guards in the specialized instructions (deopt when restricted) are the later
   optimisation if the measured cost of the switch matters; the same vectors then prove they lose nothing. The cost is
   measured on the corpus's own cells, not only on a benchmark suite. **Measured** (lane 3, 2026-10-15, slice 1 at
   `parawanderer/cpython` branch `ml/restricted-mode`, 5b1d921): pyperformance's fourteen pure-Python benchmarks run
   1.66x slower with specialization off (geometric mean, stock and no-spec interleaved per benchmark over three rounds;
   `json_loads` 1.04x, `nbody` 2.47x), so specialization is most of 3.11+'s speedup. The 684 real bench cells (median
   152 µs, mostly pandas and numpy C) run about 1.06x (1.04x weighted by time; noise about 0 to 14%). So the switch is
   right for the first slice and real cells barely notice it, and the per-form guards are the second slice, needed as
   soon as tier-3 pure-Python library code carries the work rather than C leaves.
   **Lifting is opt-in, and a lifted leaf resolves no name it is given** (lane 3's slice 2, 2026-10-15). The gate's
   coverage of the C paths holds only while C runs with the flag ON: a lifted `str.format` walks `"{0.__class__}"`
   ungated, and `getattr`, `hasattr` and `operator.attrgetter` are the same hole. So the default for every allowed C
   callable (builtins, method descriptors, bound methods, a module's listed functions, instances of a kind that lists
   `()`) is UNLIFTED, callbacks stay gated because the flag never went off, and only a leaf the manifest marks `lift`
   runs lifted. Three consequences, each a rule: (a) a leaf is never `lift` if it resolves a name it is given. In pandas
   that is `agg`, `apply` and `transform` with a string, `groupby(...).agg`/`transform` with strings, `eval` and
   `query`, all of which `getattr` on the string. The ruling: the aggregation names are a CLOSED VOCABULARY in the
   manifest entry (`names=`), checked against the string argument BEFORE the call by the entry, the same mechanism
   that checks a `range` or a cost bound; an unlisted string is `NotInDialect`; a callable argument must be a
   `CO_RESTRICTED` Python function, since only such a frame turns the gate back on inside the lift and a C callable
   (a bound `str.format`, an `attrgetter`, a `partial`) makes no frame (lane 3's second finding, PR #721; the entry
   walks plain containers for both rules, and a gate-restoring shim is rejected). `df.eval` and `df.query` are OUT: a string that is a program is a second language, and the dialect
   never compiles a string, in Python as in JavaScript. If the corpus shows `query` common enough to matter, the
   later answer is a parser of our own over a closed grammar of comparisons on column names, as `ml.pipe` has, never
   pandas' engine. (b) An unlifted builtin that looks a method up by name (`sorted` reaching `list.sort` on the list it
   just built) is judged by the SAME kind tables as user code, no separate list of internal names: the list is owned,
   `sort` is an owned-only write in the table, the call passes; a builtin that needs a method the tables lack gets the
   table entry, with its ownership condition. (c) A module's C function is callable only if its module's table lists
   it, because `builtins.eval` is reached by name with no attribute read: `builtins` is a module with a table like any
   other, and `eval`, `exec`, `compile`, `__import__`, `open`, `getattr`, `setattr`, `delattr`, `hasattr`, `globals`,
   `locals`, `vars`, `input` and `breakpoint` are not in it. `getattr` with a literal would be gated correctly
   unlifted, and stays out anyway: a cell whose attribute names are strings cannot be read statically, and the JS
   dialect has no `Reflect.get` for the same reason; the corpus count decides if that ever changes. Vectors:
   `df.agg("__sizeof__")`, `"{0.__class__}".format(1)` through every lifted leaf that takes a format-like string, and
   `sorted` on a list the cell does not own.
2. **Tier 3 is the default.** A pure-Python library function called from a restricted frame simply runs under the gates,
   at native speed, with no manifest: it stays inside them or raises `NotInDialect`. Only C leaves need manifest
   entries, which is where the library manifest spec was always going to earn its keep ("interpret my body" costs
   nothing here, where in JS it costs the interpretation slowdown).

**Halting is still the Starlark set, checked statically first.** `for` over a finite collection or a bounded `range`,
comprehensions over the same, no `while`, recursion to a bounded depth, no generators and no `yield`, no `class`.
`lambda` and `def` are in. The budget catches what the static rules cannot see; the static rules keep a refusal
BEFORE the run wherever the form is decidable from the source, so nothing has to be rolled back.

**What the corpus count changed (2026-10-15, lane 3 of the plan: 1,714 unique cells from 18 models).** The Starlark set
admits 89.4% of cells whole; no cell uses `while` or `class`, which confirms their static refusal. Three rulings on
what the count surfaced:

- **A generator expression is rewritten to a list comprehension in the pre-pass, in CONSUMER POSITION only**: as the
  sole POSITIONAL argument of `sum`, `any`, `all`, `min`, `max`, `sorted`, `list`, `tuple`, `set`, `dict`, `str.join`,
  `enumerate` or `zip`, keyword arguments beside it allowed (`key=`, `default=`, `reverse=` never receive the
  generator), where the two differ only in early exit and memory, both bounded by the budget and the allocation cap.
  164 of the corpus's 177 generator expressions are in that position; the rule admits 98.4% of cells (93.6% with the
  static gate's import and builtin lists), against 99.1% if any generator expression were admitted. A genexp anywhere else is refused: there the rewrite would be
  observable, and a generator object is a suspended frame the patch's first slice does not have to get right.
- **`type(x)` is allowed** (2.4% of cells, mostly a debugging print or `type(x) == str`), returning a receiver kind of
  its own that lists no attributes (so `__mro__`, `__subclasses__`, `__name__` are refused by the gate) and supports
  `is`, `==` and `repr`. The three-argument `type(name, bases, dict)` is refused outright. "Not callable" was the first
  wording and cannot be implemented (lane 3, 2026-10-15): `type(1)` IS the `int` object, the same one the builtin name
  binds, so `type(1)(5)` cannot be told from `int(5)`, and a proxy type object would break `type(x) is str`, one of the
  two corpus uses. The property that matters holds without it: a call through `type(x)` is judged at the call gate by
  the class's identity like any other call, so it reaches no constructor the manifest does not list. The vectors say
  exactly that: `type(box)()` and `type(df)()` refused, `type(1)(5) == 5` a value.
- **A kind may carry a DYNAMIC attribute rule from its manifest**: the DataFrame kind's `dynamic: columns` lets `df.Region`
  resolve when `Region` is a column, by a predicate registered beside the table and run with the depth lifted like any
  approved leaf, returning `alias(0)`. Never a dunder, never a name in the kind's static method set (`df.sum` is the
  method even when a column is called `sum`, pandas' own rule), and never the object's `__getattr__`.

**What this does not solve**, and the spec keeps saying so: the COST of a C leaf (tier 1 bounds over `len`, `size` and
`shape`, with hard caps, since there is no charge hook inside a C loop); `re` backtracking (`sre` is C, so the
`riskyRegex` pre-check is ported and applied before the call); and a long numpy operation does not visit the eval
breaker, so the wall-clock kill stays as the backstop behind the budget.

**RULED 2026-10-24 (Shane's question: can the regex check live in one place, imported by both?): one DEFINITION
and one CORPUS, two parsers, no shared code.** The two checks judge two languages: Python's `re` has `{,n}`,
conditional groups `(?(1)a|b)`, verbose mode and `(?P<n>)`; JavaScript has `\k<n>`, the `v` flag's set operations and
its own lookbehind rules. A pattern string that one engine accepts the other may refuse or read differently, so a
shared parser is not a thing that can exist, and the lesson of the fork's #11 (three exponential escapes that a hand
check over the string missed) is that each check walks ITS ENGINE'S OWN parse tree (`re._parser` there; a parser the
JS side owns here). Running one implementation on both sides would mean Pyodide inside the worker for a JS cell, or the
`js` bridge from restricted mode, which the lockdown exists to refuse; a WASM judge shared by both builds would save
about a hundred lines of rule for a second toolchain in both repos, and still needs the two parsers. What IS one:
(1) the rule, written once, over a common shape (a repeated group holding a quantifier, a count past the bound, or an
alternation; the backtracking bound of `regex-cost.ts` over the same shape), in `docs/dev/readonly-exec.md`'s Halting
rows, which both implementations transcribe; and (2) the corpus, `tests/fixtures/dialect-vectors/halting.json`
(each vector: pattern, flags, the dialect it is written in, expected verdict and reason), read by both
`tests/regex-cost.test.mjs` and the fork's `Lib/test/test_restricted.py`. A verdict that differs between the sides on a
pattern both engines accept is a corpus failure, not drift to tolerate. The cost model is ported (`regex_work`, fork
branch `ml/regex-cost`): a `"priced"` entry is over the budget on its input on both sides, and the bound's growth on each
input is the cost corpus `tests/fixtures/dialect-vectors/regex-cost.json`, read by both suites the same way. The
JS/Python parity test is these two corpora read twice, not a third list of cases.
RULED the same day (the canvas session's question): the SHIPPED core reads the corpus too. A test in the python genre
runs `dist/pyodide`'s own `risky_regex`/`risky_parse` over the `py`/`both` vectors; a vector the shipped core judges
wrongly is a `{ todo }` naming the fork commit the core lacks and the pin, and a todo that starts passing FAILS (built
explicitly; `node:test` does not fail a passing todo). A commit list compared with the pin is a proxy and is not the
test. So the pin's lag behind a security fix is visible in CI as a red todo whose fix is a rebuild, never as a green
suite over a core that still has the escapes.
RULED 2026-10-27 (python-cancel's design note, `tmp/python-cancel/regex-cost-design.md`, for the port of the cost
model): Python PRICES a search through ONE budget, not a cap per search. `regex_work` in `Lib/restricted.py` is the
bound of `regex-cost.ts` walked over `re._parser`'s tree (an unknown op is Infinity, refused), and `regex_check`
spends it through one C entry, `_restricted.charge(n)`, which trips exactly as `_PyRestricted_Tick` does, called after
the shape checks and before the leaf, the linear scan billed first; `compile` charges nothing. A fixed cap per search
was refused: it cannot see what the cell already spent, so fifteen just-under searches still run to the kill. The
units per step are measured in Pyodide on the fork core (`notebooks/python-dialect/regex-cost.ipynb`), with the
margin stated beside its number, never V8's figure copied. The cost vectors (pattern, flags, input recipe, expected
bound) are one file in `tests/fixtures/dialect-vectors/` beside `halting.json`, read by both suites; `halting.json`'s
`{ todo }` on `regexWork` flips plain when the port merges. The fork PR is reviewed by the fork's owner natively; the
core is rebuilt and re-pinned by the pyodide-build session on Shane's go-ahead; the red team pins the cost table's rows
after the pin lands.
MEASURED with the port (cpython#13, window-ml #1170; 275 searches in Pyodide on the fork core), two facts recorded
without changing a number: (1) the interpreter steps at a median of about 7.1M/s on that core (5.1M to 13.6M by
cell), so the 15M-step DEFAULT_BUDGET is about 2.1 s of interpreter work there, not the ~1 s the fork's comment
states; the budget stays 15M (Shane, 2026-10-27: the comment is fixed to the measured figure in cpython#13; the number is not re-expressed in time). (2) The shared bound's per-start pessimism refuses
`findall` over about 1M characters of ordinary text (priced 20 to 100x over its real 15 to 30 ms; at 100k characters
it costs 2 to 30% of the budget): a stated limit, in the refusing direction. DECIDED 2026-10-27 (Shane): it stays; loosening is revisited only if the bench shows models hitting it.

**RULE: the patch keeps the ABI.** It touches `ceval`, the abstract object layer and the thread state, never the object
header or the stable ABI. Then Pyodide's own numpy and pandas builds work unchanged, and on the host a patched CPython
with the same ABI tag installs stock wheels from PyPI. The cost of the fork stays at "rebase one patch per CPython
release", the forked-backends pattern this repo already pays for Ollama and OpenWebUI
([`docs/FORKED-BACKENDS.md`](../FORKED-BACKENDS.md)); a change that needs the patch gets a compat label the way hub and
backend changes do. A header bit for ownership would be cheaper than the side set and is not worth the ABI.

**The history a reviewer will raise.** CPython removed restricted execution (`rexec`, `Bastion`) in 2003 because the
object model's introspection kept opening paths out of it, and PyPy moved its sandbox to the system-call boundary. This
is a different object: an ALLOW list rather than a deny list, a refusal that degrades to a person rather than to the
attacker, and an enforcement belt behind it (the Wasm boundary in the browser, the OS sandbox on the host). It is an
approval-fatigue reducer for an honest model that fails closed, which is what the JS dialect's doc already says of
itself, with the gate at the one layer every path crosses.

**Effects are the shared algebra** ([`EFFECTS.md`](EFFECTS.md)): restricted mode publishes `B = { read/write/alloc on
heap(owned) }`, so a cell whose every leaf projects inside that set is free wherever it runs. The same patched CPython
runs under Pyodide and at the host, which is what makes placement free and keeps JavaScript out of the process host
([`SHELL.md`](SHELL.md), "The host's language").

### Membership replaces `mode`

`python_exec`'s `mode: "readonly" | "full"` goes away, and nothing is lost: with `ml` reachable from Python
([`ML_WIRE.md`](ML_WIRE.md)), `full` mode's raw `js` module and `pyodide.http` have no use a gated `ml.fetch` does not
cover. The model never chooses. A cell inside the dialect runs with no card, in either place. A cell outside it (a
`while`, a class, an unannotated library call) goes to the person and runs as full Python with the gated `ml` callback,
in a worker that is still hardened. That is the two-path story the JS `exec` already tells.

Until a membership predicate exists in the Pyodide build, every cell is outside the dialect: it asks and runs hardened
with the gated `ml`, and `autoApprovePython` approves nothing (ruled 2026-10-20, lane 7's narrower reading, #820; rule 1,
narrow and fail closed). The one seam is `pythonCellInDialect`, false today, where the predicate plugs in; the wider
reading, keep auto-approving what ran as `readonly`, would need a predicate that was not lane 7's to write and would let an
old `full` cell arriving without `mode` run unasked. Stored grants keep their prefixes: an old `readonly:` grant no longer
covers a cell, so it asks again; an old `full:` grant still covers the same code.

**Membership is the check AND the gated run, never the check alone** (ruled 2026-10-20, lane 3's finding while wiring the
seam): `restricted.check` is the node whitelist, and it admits `Import`, `Call` and `Attribute` because which modules,
calls and attributes are allowed is decided at run time by the allow tables under `_restricted.run`. So a cell that
passes the check is not yet inside; `import os; os.listdir("/")` passes it. The seam therefore answers "inside" only to
run the cell through `restricted.run_cell` with the manifests loaded, never through the ordinary hardened path, and a
runtime `NotInDialect` (a refused module, call or attribute) is not an error to the model: the cell becomes outside, the
person is asked, and the card says where the cell left the dialect; on approval the cell runs again on the full path and
only that run's result is the cell's. The rerun is sound because an inside run can leave nothing behind but reads: the
dialect is read-only, the namespace is restored by `run_cell`'s undo log, and a lifted `ml` call inside it is a read or
an ask, so the rerun repeats a read; a grant consumed by the partial run covered a read that happened, and the rerun's
ask covers the whole cell. That property is the red team's to test, as the JS dialect's FAILURE tests do: after a
runtime refusal the namespace is as before, nothing is held, and no write reached `ml`. The verdict is computed once,
at the gate, keyed by the cell's source (an edited cell gets a fresh verdict), and carried on the step for the five
synchronous readers (the auto-approver, grant extraction, the worker, the run host, the card's render); a step with no
carried verdict is outside. The predicate absent (a stock or older Pyodide core) or throwing anything but
`NotInDialect`/`SyntaxError` is outside. The static alternative, resolving imports and attributes in the check, is
rejected: an attribute of a runtime value cannot be resolved statically, so it would refuse most real cells or be unsound.

**What an inside run may leave behind is data, never code** (ruling 2026-10-20, from the red team's #880 pass; lane 3
builds, the red team gates). "Nothing behind but reads" covers the namespace's bindings too: a function, lambda, class,
generator or coroutine defined inside had its body CHECKED for membership but never RUN under the gate, so copying it
back hands a later cell unjudged code, and a builtin the gate never allowed (`f = open`) is a capability under a plain
name. The red team showed both: `def f(): import os; return os.listdir('/')` admitted unasked, then an approved cell's
`f()` listed the filesystem; `def f(): return ml.config()` the same way sent a wire call, a write reaching `ml` from an
inside run. The rule has two layers, and one is not the other's substitute:

1. **The fork honours `CO_RESTRICTED` wherever the code runs**, not only under `_restricted.run`: a `CO_RESTRICTED`
   frame entered while no run is active is REFUSED with `NotInDialect` ("restricted code runs only inside the
   dialect"), never run ungated and never run gated outside a run (ruling 2026-10-20, lane 3's R over G: gating
   outside a run would need ownership, a budget, an undo log and a frame-exit hook with no run to hold them, while
   refusing is a subset of that and loosens nothing if gating is ever wanted). The check sits where the interpreter
   resumes a frame, so it covers a direct call, a generator's or coroutine's resumption, `exec(f.__code__)` and a C
   library calling a cell lambda from a full-path cell; inside a run nothing changes. Measured cost (cpython#5, native
   arm64, the check present against absent, 9 interleaved runs): 2M calls ×1.013 (+0.6 ns a call), 2M generator
   resumptions ×0.986, both inside the runs' spread. Landed in fork `77376876` with the line fix (a cell is parsed as
   itself, so its lines, columns and multi-line strings are its own), pinned by lane 3's re-pin.
   After the re-pin: a `FunctionType` whose code and every nested code constant is `CO_RESTRICTED` may cross back,
   later inside cells call it unasked, and a full-path cell that calls it gets the refusal, whose text names the
   function and says it was defined in an unasked cell, to be redefined in the approved one. What such a function
   carries is walked like any other value: its defaults, keyword defaults and closure cells, so `def f(a=open)` and a
   lambda closing over `open` stay outside. The FIRST release of 77376876 (`pyodide-314.0.3-ml-77376876`) did not carry
   the fork's Python side: the recipe's stale install stamp packed a9f034a2's `restricted.py` under the new name (lane
   3, 2026-10-21, by hashing the zip's file), so under wasm the C side (entry gate, line numbers) was real and the
   parse-as-itself (offsets, multi-line string values) was not; superseded by `-r2`, built by a recipe that stamps the
   patch set and witnesses the zip's `restricted.py` against the fork commit, the hash pinned beside the tarball's.
   Captured builtins, bound methods and anything not `CO_RESTRICTED` stay
   refused; classes and `yield` stay outside. Stated residual (the red team's post-merge read of cpython#5,
   2026-10-20): APPROVED code on the full path can strip the flag, `f.__code__.replace(co_flags=...)`, and run the body
   ungated (its probe listed the filesystem); a fresh `types.CodeType` from the same bytes would do the same, so the
   flag cannot be made unstrippable without taking code-object access from the full path, which the full path has by
   design. It is not an escape: the cell that does it is on the card, and a cell that rewrites a function's flags reads
   as what it is.
2. **The copy-back admits data only.** A binding an inside cell made persists only when its value carries no cell code
   and is no builtin: until layer 1 is in the pinned core, no function, lambda, class, bound method, generator,
   coroutine or `builtin_function_or_method` crosses back, and the check is RECURSIVE, since the container case is
   real (the red team, 2026-10-20, four shapes: a list, a dict, a nested list of lambdas, and an instance of an
   inside-defined class, each admitted inside and each reaching `open` from the full path): a value crosses back only
   if no callable is reachable through list, tuple, set, dict or an instance's `__dict__`; an instance of a class
   defined inside is refused outright, since its methods are cell code. As built (#880, d4574ebe) it is stricter than
   "the binding does not persist": the admitted set is an allowlist on the exact type, walking the builtin containers
   and numpy/pandas object values, and a cell whose binding or returned value falls outside it is OUTSIDE the dialect
   and asks, so the model sees why on the card instead of finding a name silently missing. An inside try no longer
   writes to the live stdout stream at all (a test holds the real stdout to nothing from an inside try), and a refused
   try's captured stdout is dropped. The red team's second pass (2026-10-20, 11/11, no escape) left one gap between the
   words and the code: the copy-back also admitted any value the namespace already held, by identity, so `a = ml`,
   `f = [ml]` and `return [ml]` crossed back. That grants no capability the full path did not have, but it DISGUISES
   one: an approved cell reading `a.config()` hides that `a` is `ml`, and the card shows the person the alias, not the
   thing. Ruled the same day: a non-data value crosses back only under a name it already had (so `np` stays `np`, and
   rebinding it elsewhere than its own name makes the cell outside, `h = helper` and `m = math` included) or as the
   target of an import the gate admitted. As built (#880, ddc35ea9): the gate still decides whether the import may run;
   the copy-back then admits a binding made by the cell's `Import`/`ImportFrom` nodes only if its value IS that
   module (`sys.modules[m]`) or that attribute of it, so `import numpy as np`, `from numpy import array` and
   `from numpy import sum as total, mean` cross back, while `m = math`, `xs = [math]`, `f = np.sum` and `return math`
   make the cell outside (measured 2026-10-20 against the python genre, 335 pass, 0 fail; before this the from-import of
   a function was refused by the walk, since a function is not data). The identity pass under a NEW name is gone.
   The RETURN value is a third channel with no name and no import, so it admits data only: `return ml` and `return
   [ml]` make the cell outside (the red team's reading question, 2026-10-20; its P2-alias pins eight shapes). Once layer 1 holds, a cell-defined function may cross back, since outside a run it refuses; a captured builtin
   never does, because it is not cell code and layer 1 never sees it.

A refused try leaves no output either: its captured stdout is discarded with its env, and whether text the tee already
wrote to the real stdout reaches the model in a streamed call is measured before it is called closed (rule 8), not
inferred. Each part is mutation-checked alone: revert it and the red team's test fails again.

A cell inside the dialect that makes a gated `ml` call (`ml.fetch` on a new URL, `ml.sh`) does not fall out of it: the
call SUSPENDS on an `ask` and continues when answered ([`ML_WIRE.md`](ML_WIRE.md), "Per-call asking"), which the JS
survey could not do and which answers the manifest spec's "granularity of a refusal".

## The namespace

**One namespace per run, persistent**, as decided on 2026-10-08. The five questions the state inspector spec left open:

1. **Per run AND per mode?** Dissolved: there is no `mode`. A cell can never hold a live network handle, because no
   cell ever gets one; `ml` is a callback that returns copies, and the dialect refuses what it does not list. The
   namespace holds data and handles, never capabilities.
2. **What the injected names mean on the second call.** `df`, `tables` and `img` become ordinary assignments at the top
   of the cell that passes them, and nothing resets them. A later cell without the parameter sees the earlier table,
   which is what a notebook does and what models assume. The tool's text says so, once, in place of the two sentences
   that contradict each other today.
3. **Lifetime and loss.** The next cell's result opens with "namespace reset at <time>: <reason>" from the housekeeping
   record that already exists for Pyodide kills and cold starts, and `ml.current.env` lists the live names with their
   types and shapes (the scope manifest in [`PERSISTENT_RUNTIME_SPEC.md`](PERSISTENT_RUNTIME_SPEC.md)). A run is told;
   it is never handed a silently empty namespace.
4. **Memory.** The namespace is one dict in the one shared interpreter, deleted at run end, with a memory eviction that
   triggers the loss message above rather than a quiet reset.
5. **Approval.** Dissolved with 1: state is data, and capability exists only at the call, judged per call.

**JS values reach Python the same way.** No `vars` parameter: `ml.state` read from Python through the callback, by
copy, is the bridge, and a value too large to copy crosses as a pointer. One rule for every crossing: JSON or Arrow by
copy, or a pointer, never a proxy. The run's namespace, seen from the worker, is a map from name to HANDLE, each pointing
at where its value lives (the page heap for `ml.state`, the Pyodide heap, the process host); the JS/Python asymmetry of
WHERE values live, deliberate in the persistent-runtime spec, survives, and the model sees one namespace reachable in two
languages ([`SHELL.md`](SHELL.md)).

## Packages on demand

Installing is its own step, gated by a policy or an approval and pinned by hash, so that a dialect cell only ever
IMPORTS. `micropip` from a local wheel mirror; PyPI as a gated network read. The facts a policy sees are small (a
package name, a version, a source, the hash), which makes this a cheap early consumer of [`POLICIES.md`](POLICIES.md).
The same hash keys the package's library manifest, so an installed package arrives with the description the dialect
needs, or arrives as `unknown` and every call into it asks.

**Measured 2026-11-09** (the packages lane's notebook, `notebooks/python-packages/pypi-compat.ipynb`, PR #1557, against
the real core `pyodide-restricted-314.0.3-35bd1d69`: 110 tags, 354 lock entries): 725 of PyPI's top 1,000 projects
install and import; 95% of the top 100 are installable, 67% of ranks 1001-2000; `grpcio` alone blocks 79 of the top
2,000. Four rulings follow from it.

- **Three sources, two of them local.** 62% of the wheels a successful install fetched came from the core's lock (the
  Pyodide CDN), not PyPI. The local mirror therefore holds the pinned core's WHOLE lock beside the wheels the person
  has approved, so the lock is never a network read; PyPI stays the one gated network read. The `source` fact a policy
  sees is one of `lock`, `mirror`, `pypi`.
- **One artefact per package, decided before download.** 1,461 of 1,467 installable closures resolve to ONE file per
  package under the core's tags (the four with more, `isort`, `multiprocess`, `backrefs`, `pex`, take the first file
  in the resolver's order and record its hash like any other). The "works here" verdict (tags, the closure under the
  interpreter's markers, version ranges against the lock) is computed BEFORE the download and before the approval
  card: right 96.4% of the times it says yes, and saying yes to 99.0% of what works. The card therefore lists every
  file the approval covers, with its hash, or refuses up front. A failed import AFTER the install is still a failure
  (15 platform limits no tag carries, 8 micropip non-backtracks, 3 extras in the measurement): the install rolls back
  and nothing is recorded as installed.
- **The start-up set pins versions.** 161 of the 208 lock packages in the top 2,000 lag PyPI, and a loaded package
  cannot move, so the `version` fact for a package in the lock IS the lock's version; a newer PyPI release is not
  offered (nine top projects fail only on `packaging>=26.2` against the loaded 26.1; a core bump moves them, an
  install does not).
- **An undeclared dependency is a second ask, not a failure.** 31 projects (`opentelemetry-instrumentation-*`,
  `sphinxcontrib-*`) import a package they do not declare: the install succeeds, the import asks for the missing
  package by name through the same card.

Host placement is a COLUMN of the notebook, not a verdict: 459 of the 533 projects not installable in Pyodide have a
wheel for a native CPython 3.14 on macOS arm64, measured directly with the host's closure unchecked and the host's tag
set assumed rather than read from window-ml-host. No placement rule is drawn from it until the host side reads its own
tags. Not measured anywhere: whether a package WORKS when called beyond import (a locked cell cannot reach the network). RULED 2026-11-09 (the coordinator, on the packages lane's three follow-ups; #1557 MERGED cbb4d9ae, verified) in four parts. (1) The 10,000-project probe runs through test-slot as 20 chunks of 500 at 6 interpreters, `--kind unit`, submitted one at a time (the next submit after the previous `wait`), with no reserved window; a chunk past about ten minutes is reported, not retried. (2) The verdicts are a notebook extract only, `notebooks/python-packages/data/pypi-compat/verdicts.json` keyed by the core tag in `tools/pyodide-dist.json`; nothing enters `src/`, because the spec computes the verdict before download from the tags, the closure and the lock, and a shipped list would go stale at every pin bump. (3) The platform scan: the notebook's one-call-deep source scan (PR #1563, the lane, notebook-only) finds most of the 15 platform limits no tag carries, moving precision 98.1 to 99.2 and recall 99.2 to 98.9 against the 725 measured; a naive rule that flags any platform-named import would mark 464 of 724 working packages, so the scan is a NOTE on the install card, never a refusal (joblib and scikit-learn carry the names and work). It runs after unpack and before the first import; a failed import still rolls back, with the scan's finding as the reason text. The two core tables the scan reads are a notebook extract, re-measured by `probe.mjs core` at each pin bump and generated into a `*.gen.ts` only when the install step is built. No per-package misses list: the six misses are the accepted residual. (4) The npm counterpart (`npm install --ignore-scripts`, an esbuild browser bundle, one headless Chromium): top 100 measured in 7 s, 66 import, 30 fail to bundle (27 on Node built-ins), 3 fail at evaluation; the top-1,000 run (one browser, 2 to 5 minutes) is the bench-sweep case and runs OUTSIDE test-slot, keeping `--ignore-scripts`, reporting counts in the Python study's shape. MEASURED the same day as #1564 OPEN 117fbc5c (the lane, notebook-only, stacked on #1563), Python then npm, probe artefacts and undeclared dependencies excluded: loads 725 / 657; no build 177 / 10; the runtime lacks it 15 / 271; versions or resolver 33 / 0; other 1 / 5; share loading 76% / 70%. A Node built-in stops 250 of the 286 npm failures (172 reach fs, child_process, a socket or the terminal; 78 reach only portable built-ins such as path, buffer, util); shimming `global` and `process.env.NODE_ENV` adds nine; the static closure scan reaches 95.4% precision and 86.1% recall. No npm install is specified for `exec`; the study bounds what one would give. WHAT REMAINS OPEN after #1584 (the packages lane's reading of 13bf53b8, RULED 2026-11-09): (1) the install step itself is not built, though this section describes all of it (the verdict before download from tags, closure and lock; the card listing every file with its hash, or refusing up front; the mirror holding the whole lock; the lock|mirror|pypi fact; the pinned lock version; rollback on a failed import; the platform scan as a note; an undeclared dependency as a second ask), and POLICIES.md names it a possible first consumer of the policy store; (2) whether a package works beyond import stays unmeasured, measurable offline only for packages with a no-network smoke call, of which there is no generic definition; (3) host placement (459 of 533 projects have a native-host wheel) waits on window-ml-host reading its own tags; (4) npm install for exec needs a design ruling, not more measurement, and gets none until someone asks for npm in exec; (5) a shipped verdicts-driven wheel allowlist is declined, since the verdict is computed per pin and a shipped list goes stale at every pin bump. RULED: the lane takes (1), brief first as its own docs/plan PR, reviewed by the coordinator, no src/ change until it merges. The brief holds the slice list; the first slice's boundary, a pure TS module (tags, closure under markers, version ranges against the lock, the verdict before any download) with PyPI metadata and the lock treated as untrusted input and the brief saying what a hostile index can and cannot make the verdict do; the oracle, verdicts.json as a fixture rerun at each pin bump with the pin named in the test, which is the useful form of the allowlist idea (nothing ships as a list); and what the later slices add (the card, the mirror, the policy-store wiring, rollback). The card and download slices are a new surface taking hostile input and get e3's red-team pass under rule 10 before they land; the pure module slice carries the lane's own hostile-metadata rows instead. BRIEF MERGED 2026-11-09: docs/plan/repl/PACKAGES_INSTALL.md, #1598, reviewed by the coordinator at b86aafdf (one addition asked: who reruns the probe and the extract at a pin bump) and cleared at 27315228 (the pin-bump PR carries the rerun, done by whoever bumps; the pyodide-build skill gains the step in slice 1's PR; the packages lane reviews the new verdicts.json and snapshot; the test's pin line moves in the same PR; the rerun's cost from #1584 as submit-to-finish times, 174 to 2,217 s, median 227 s, 11,006 s in all including queue wait, as `--kind unit` jobs until #1583 lands). MERGED 586f3250 (run 42631437239 green). Slice 1, the pure verdict module and its oracle, branches from it; its PR carries the parser-size figures. SLICE 1 OPEN 2026-11-11: #1610 at d0356094 (`@python` `@docs` `@agent-skills`; one commit, fourteen files; verified). Parity with pypi.py: 2,224 of 2,224 verdicts and blockers, the 1,666 installable ones with the same wheel, closure size and bytes; all 21,979 requirement strings read to pypi.py's lists. Probe on the top 1,000: fair precision 96.4%, recall 99.2% from the 10k run (replacing section 2's 99.0% from its own run); the top-2,000 confusion table is pinned, and the 14 yes-but-version and no-build rows are listed with their reasons. Parser sizes: in-house PEP 440 is 236 lines (171 code), 4.0 KB minified; in-house PEP 508 is 333 lines (271 code), 9.1 KB minified with the PEP 440 file; both agree with packaging 26.3 on 2,983 versions, 4,504 specifier sets across 108 probe versions and 87 requirements, the one difference a deliberate refusal of backslashes in quoted strings. The vendored option, @renovatebot/pep440 6.0.0, is 18.4 KB, PEP 440 only, with no PEP 508 package on npm; its agreement was not measured. RULED 2026-11-11 by the coordinator: in-house, the decision resting on coverage and the measured agreement, not on the unmeasured vendored figure. Snapshot 3.77 MB, top 2,000 plus dependencies. Departures from the brief, written into it in the same PR and accepted: a `loaded` field; source lock or pypi only until slice 3's mirror; a `no-metadata` reason; a replacement must fit every range asked of it. Reviewer janitor-2, after #1595. IN REVIEW 2026-11-12 (janitor-2's report, comment pending): the PEP 440 port agrees with packaging 26.3 on 7,992,824 specifier-version answers with zero differences (2,573 single-specifier sets plus 120 multi-specifier sets, against 2,968 versions; janitor-2's corrected figure). POSTED (comment 6816216813, names d0356094; verified): one finding on pkg-verdict.ts, the bounds cap each lookup and not the walk, so the work is their product (24.7 s at 66 packages, 109 s at the 256-package bound, about 40 MB of index JSON, all inside every documented bound) against the plan's "cannot make the verdict run without bound"; the packages lane answers on the PR; nothing of janitor-2's gates the merge beyond that answer. ANSWERED 2026-11-12 at 8994fbff (one commit, three files; comment 6816356933; verified): the walk is bounded by a work count, VERDICT_BOUNDS.work of 65,536 steps, a step being one file judged or one version tested against one range; janitor-2 re-reviews and names the head if it holds. NEW HEAD 2026-11-12: e2c3259c (verified): the hostile row uses 256 releases after janitor-2's memory finding; the delta is that row, its comment and a retitle; janitor-2 names it when green. NAMED 2026-11-12: comment 6817222334 on e2c3259c (verified); the packages lane arms. DIRTY 2026-11-12: e2c3259c conflicts with main since 26688239 (#1636's glob on scripts/test.mjs; the pr-conflicts bot's comment 6820516221; CI not running; verified), so the packages lane merges main in and janitor-2 names the new head. NEW HEAD 2026-11-12: 26ffa9fb, a merge of main onto e2c3259c (verified: scripts/test.mjs differs from main by the python-host line alone, adding the branch's two pkg-* files; main's python line kept). The lane's measurement: python-host 86 of 86 on a fresh build, pre-commit clean including #1636's naming check. Janitor-2 re-reviews it third, after #1634 at 03fc6374 and #1642 at 76c7b49a; the packages lane arms only on a comment naming 26ffa9fb. MERGED 2026-11-12 as f3f19a11 (verified; janitor-2 named 26ffa9fb in comment 6822828855 with nothing outstanding; run 43199786884 green, tests -0/+22 lines, the lane's report). NEXT for the lane after #1610: the CDN-wedge defect (the plan, under #1575): the sandbox never fetches a wheel from the CDN; the lane opened the branch fix/pyodide-no-cdn from main the same day. OPEN 2026-11-12: #1676 at 8a012b6c (verified: @python @ci, one commit, eight files: docs/dev/python-sandbox.md, scripts/test.mjs, src/python/python-env.ts, python-worker.ts, tests/no-cdn-fetch.mjs, tests/pyodide-no-cdn.test.mjs, tests/python-bench-stop.test.mjs, tests/python-worker-bridges.test.mjs). The lane's account: the worker boots with `packageBaseUrl = indexURL` (Pyodide's own default in the extension), so the Node retry is a local read that fails at once; the two worker shims override `packageBaseUrl` too; scripts/test.mjs preloads tests/no-cdn-fetch.mjs, which refuses cdn.jsdelivr.net/pyodide/ at once naming the wheel and `npm run fetch-pyodide`, covering the fourteen tests that call `loadPyodide` themselves; python and python-host pass locally. Reviewer janitor-2 (code), fourth in its queue; the lane arms only on a comment naming 8a012b6c. REVIEWED 2026-11-12 (janitor-2 comment 6824680216 on 8a012b6c, verified): the product change holds, python-worker.ts:115 being the sole loadPyodide call in src and `packageBaseUrl: indexURL` what removes the fallback, since Pyodide derives cdnUrl from a passed packageBaseUrl and otherwise keeps jsdelivr; both real-Pyodide rows hold against a temp directory of symlinks with one wheel left out; the guard is idempotent; the shims gain packageBaseUrl beside indexURL. One finding, so the lane does not arm: tests/no-cdn-fetch.mjs:3-4 claims every test file, child process and worker thread has the guard, but the two hand-built-argv children in tests/redteam-python-sandbox.test.mjs:994 and :1562 (node --import tsx -e, calling loadPyodide then loadPackage) and `npm run coverage` (package.json:30) do not preload it. The lane preloads the guard on those paths or narrows the claim to the paths that do, with a test enumerating them; head change to janitor-2; the lane arms only on a comment naming the new head with nothing outstanding. PUSHED 2026-11-12: e9484bde (one commit over 8a012b6c; package.json, tests/no-cdn-fetch.mjs, tests/pyodide-no-cdn.test.mjs, tests/redteam-python-sandbox.test.mjs; verified with gh), the lane's reply being comment 6824981788. The lane's account: both hand-built children in redteam-python-sandbox.test.mjs pass `--import` NO_CDN_URL, `npm run coverage` preloads the guard, and tests/pyodide-no-cdn.test.mjs lists every execPath child of a Pyodide-loading test file, each guarded or listed with why (the bench-stop writer backstop, which loads no Pyodide); python + python-host 720/730 pass, 0 fail, 3 skipped, 7 todo. Sent to janitor-2 as a head change; the lane arms only on a comment naming e9484bde with nothing outstanding. #1676 MERGED 2026-11-12 as 5048e135 (janitor-2 comment 6825314649 naming e9484bde, nothing outstanding; run 43227971384 green, tests -0/+4, the lane's report; verified): the CDN wedge is closed on both halves (#1664 the gate, #1676 the product change). The lane's clone window-ml-pypkgs3 is removed (the lane's account). NEXT RULED 2026-11-12: slice 2 of docs/plan/repl/PACKAGES_INSTALL.md, the install CARD, per the brief's own order (slice 1's output is its only input, no network, slice 5 depends on it); the coordinator first asked for a slice plan that already exists (#1598 MERGED 586f3250, slice 1 #1610 MERGED f3f19a11) and withdrew the ask. Reviewer janitor-2. Red team e3 under rule 10 as amended by #1307: the card is a NEW surface not on main, so e3's test-only PR lands after the feature PR merges, flips of its rows go as e3's own commits onto the lane's branch in e3's file, reviewer janitor-3 for the rows; e3 is briefed and drafts its properties now; the branch name and head reach it through the coordinator. SLICE 2 RED-TEAM PROPERTIES 2026-11-12 (e3, drafted before the branch existed; file tests/redteam-pkg-card.test.mjs; each with a hostile input, an observable and a control on honest traffic): P1 index text is data, not structure (a version, filename or reason carrying a newline and "Approve this", markup, a bidi override or a NUL renders as text nodes only, control and bidi bytes shown escaped beside the field, the file count equal to the verdict's); P2 no truncated hash (every sha256 complete in the card's own surface, the approved set equal to the displayed set, two files sharing a 12-hex prefix distinguishable); P3 source is ours (lock, pypi or mirror is the verdict's; no index field sets it); P4 no verdict, no Approve ({ok:false, reason, at} shows the reason and the package with no control resolving the ask as approved, and no answer payload approves it); P5 what was approved is what was shown (the answer carries exactly the displayed files, rebuilt field by field on our side; a verdict changed between render and answer cannot be approved for the new list unseen); P6 a page cannot see the card, the verdict or the ask id (no page-started type, no relay; the ask id's shape is the only thing an answer may name); P7 a page cannot pre-approve (a page-started run asking to install still raises the card; no tab-sender message resolves it); P8 a page cannot write it (a hostile specifier through that path hits P1); P9 the model cannot write it (args carry a specifier; files, hashes and reason come from the verdict; args naming files or sha256 do not reach the card; a tool result claiming approval changes no state); P10 the model cannot name the answer; P11 a PyPI file with no stated sha256 is not approvable and the card says why; P12 the platform note is our text (the index cannot turn it into a refusal nor suppress a no-verdict). P13 (hash mismatch refuses with nothing stored, a redirect or an oversize body refuses, a second request for the same hash does not re-approve) is slice 3's and stays out of the card file. Reviewer janitor-3 for the rows. SLICE 2 DESIGN 2026-11-12 (the packages lane's account; branch feat/pkg-card in its clone, on main at 7d7d1b1f, no head yet): tool `install_package` {name, version?}, gated, realm worker, in PROPOSAL_TOOLS, declared in the tool registry; renderIn gains the descriptor variant {type:"packages", request, verdict: PkgCard}; SET_APPROVAL gains files?: PkgRow[], approvalPayload rebuilds it field by field, the worker approves only when every row equals the check it froze at card time and otherwise denies with a warn python/pkg-card-mismatch. Row shape: .pkg-row[data-source=lock|pypi] holding .pkg-name .pkg-version .pkg-file .pkg-size .pkg-source .pkg-sha with the full 64-hex sha256; a lock row uses pyodide-lock.json's sha256 with size null shown as "in the core"; .pkg-total below the rows; index text as text nodes only, control, bidi and zero-width characters shown as \u{XXXX} in a .pkg-escaped span beside their field and as U+FFFD in the field; a refusal is .pkg-refused with the reason and at, Dismiss only, and the worker refuses an approval for a refused check. No network in slice 2; the index view is the lock alone. RULED Q1: the tool is wired in full and offered to no run behind OFFER_INSTALL_PACKAGE = false in sw-run-start, flipped in slice 4, with a one-line reason beside the constant and check-tools passing unoffered; tests build it directly. RULED Q2: fail closed; a package card answered without files (the chat page, the phone, the hub) is denied with the same warn naming the missing files, so those surfaces can only dismiss it; carrying files on approval.answer is an OPEN `@hub-compat` item outside slice 2. EVERY-MODULE IMPORT PROBE 2026-11-12 (the packages lane's account; run on mlbox in a container, slop-zone 27fc603, reports/ui-api/pkg-imports-answer.md; Shane's approval of the probe as relayed by the lane): of the 725 measured projects, 483 import every module clean; of the 241 with failures, 156 fail only on optional dependencies not installed, the rest on other-OS modules, CLI modules that exit at import, or the platform limits the scan already notes (pwd, grp, resource, _multiprocessing); one import reached for huggingface.co and the allowlist proxy refused it, unattributed so far, a solo rerun asked of mlbox. The card's claim stays "its top-level modules import"; the data goes to notebooks/python-packages in a later PR; slice 2 is unchanged. DEFECT FOUND BY IT, routed to async 2026-11-12: importing PIL._imagingtk from the lock's own pillow 12.2.0 (Pyodide's build, not PyPI) traps in wasm (RuntimeError: function signature mismatch), which Pyodide reports as a fatal error the interpreter does not survive; any python_exec cell can import it today, independent of installs. Nothing measures what the worker does after a fatal error (whether a worker-hosted run loses its namespace, whether the next cell restarts or hangs, what the model is told, whether a detached cell's lease and kernel lock are released). Async measures it as failing-first rows in its own file, then changes it so a fatal error ends the cell with honest text naming the module, restarts the worker and tells the model the namespace is gone; not rule 10; reviewer janitor-2 for the change, janitor-3 for rows in their own PR; ordered after async's current pushes. Slice 4's rollback treats "interpreter died" as a failed install (the packages lane's side). Async's reading before measuring: offscreen.ts:372 kills a worker only on worker onerror, so a Pyodide fatal error likely rejects the cell and leaves the worker alive, every later cell reading "Pyodide already fatally failed" with no respawn; the rows confirm or refute it; queued after #1698. MEASURED 2026-11-12 (async, locally with node, real Pyodide and dist/pyodide's pillow 12.2.0; the lane's account): `import PIL._imagingtk` throws RuntimeError "function signature mismatch"; every later runPython or runPythonAsync throws "Pyodide already fatally failed and can no longer be used"; the process stays alive, neither hanging nor crashing, which confirms the reading. DESIGN, RELAYED (async's account of Shane's agreement; unconfirmed in the coordinator's session): the change copies Jupyter's model: the kernel dies, restarts automatically, and the model is told its namespace is gone and which import killed it. Order in async's queue: #1698's head, the pointer-mint PR, rule 4a, then these rows and the change. E3'S CARD ROWS 2026-11-12 (its account; six drafted before the branch has a head): the full 64-hex sha equal to the verdict's; index text as text (bidi and control as U+FFFD with \u{XXXX} beside, no element); data-source the verdict's, a lock row reading "in the core", plus .pkg-total; a refusal with no approve control and Enter approving nothing; approvalPayload rebuilding a row field by field with extra fields dropped; no page relays or page-starts SET_APPROVAL and install_package a proposal tool that withoutProposals drops. Three more wait for the branch (a mismatched set denied and logged; a no-files answer denied; OFFER_INSTALL_PACKAGE read as false). Two anchors asked of the packages lane through the coordinator: how the refusal footer is rendered (.appr-btn.yes suppressed, or a Dismiss-only foot with its class and aria-label) and the module and record the pkg-card-mismatch warn is written from. The rows land on feat/pkg-card as e3's own commit before the PR merges (the reversed ruling in the plan). PROBE NOTEBOOK OPEN 2026-11-12: #1712 at 4a9e4ce3 (packages; `@python` `@docs`; notebook-only, ten files under notebooks/python-packages: pkg-imports.ipynb, make-pkg-imports.py, probe-all.mjs, drive.py with the stderr head kept, README.md, data/pkg-imports answer.json, pins.txt, rerun-events.json, rerun-proxy.json, summary.json; verified) pins the every-module probe from slop-zone 27fc603 and d075ad2; a Sonnet agent wrote it, check-notebooks passes (the lane's account). Reviewer janitor-3, third after #1703 and #1704; the lane arms only on a comment naming 4a9e4ce3. RENAME, RELAYED 2026-11-12 (the lane's account of Shane's agreement; unconfirmed in the coordinator's session): install_package becomes `python_install`, beside `python_exec`, so the generic name stays free; the packages card's descriptor gains `ecosystem: "pypi"` and refusal reasons become ecosystem-specific; row shape and class names unchanged; the tool is still offered to no run, so the rename costs nothing in code; passed to e3 before its rows name the tool; the registry declares the new name from the first commit. #1712 REVIEWED 2026-11-12 by janitor-3 at 4a9e4ce3 (comment 6827646393, verified): one change, the front-door cell at make-pkg-imports.py:213 filters only `kind != "optional-dep"` and keeps the 23 optional-dep-ish imports its paragraph says are left out, so the headline is 107 front-door failures in 35 projects, printed as 130 in 43; the fix is `~fl.kind.str.startswith("optional-dep")` and `nb.mjs make`; everything else checked out (483/241/1, the error-type table, pins.txt equal to the 725 summary specs, the pillow crash row, reproduction exact across 22 cells); the report's "93 modules" for the crash is uncheckable from the pins and the notebook does not repeat it. Forwarded to the packages lane; re-review stays with janitor-3. #1712 PUSHED 2026-11-12 as f49e1152 (verified: one commit over 4a9e4ce3, make-pkg-imports.py and pkg-imports.ipynb): the filter is `~fl.kind.str.startswith("optional-dep")`, the notebook rerun, the PR description corrected. The lane CORRECTS its own earlier account, whose classify.py made the same mistake: 107 front-door failures in 35 projects, not 130 in 43; 483/241/156/85 unchanged. Head change to janitor-3; the lane arms only on a comment naming f49e1152.

SLICE 2 DRAFT OPEN 2026-11-12: #1719, branch feat/pkg-card, labels `@python @ui @api @security`, first head 61d30b74 (verified; 33 files: src/python/pkg-card.ts and pkg-verdict.ts, src/sw/sw-pkg-install.ts, src/tools/python-install-tool.ts, src/sidebar/card/pkg-card-view.tsx, hud-card.tsx and approval-row.tsx changes, contract and export-schema changes, tests/pkg-card.test.mjs and tests/python-install.test.mjs), then 8c284e33 after main was merged in (verified: two conflicts, sw-run-start.ts keeps main's `offersTask` condition with the `OFFER_PYTHON_INSTALL` entry appended, scripts/test.mjs keeps main's python-host line with pkg-card.test.mjs added; the lane's account: tsc clean, check-tools lists 25 builtins, the five touched suites 157/157). Sent to janitor-2 as a fresh code/security review, then as a head change to 8c284e33. E3'S TWO ANCHORS ANSWERED by the lane and forwarded: the refusal footer is Dismiss-only with no `.appr-btn.yes`, control `button.appr-btn.no.pkg-dismiss[aria-label="Dismiss"]` in both ApprovalRow (prop `dismissOnly`) and the HUD footer, Enter does not approve a refused card, body `.pkg-card.pkg-refused` with `.pkg-asked .pkg-at .pkg-reason`, predicate `isRefusedPkgCard`; the mismatch warn is written from sw-run-host.ts in the gate's resolve through `recordRunLog` with `subsystem: "python"`, `kind: "pkg-card-mismatch"`, a slug `reason` (files-absent, files-malformed, files-differ, refusal, no-check) and `detail: { tool: "python_install", seq, why }`, the judge being `judgeAnswer` in sw-pkg-install.ts; card time logs `python/pkg-card` with reason ok or the verdict's reason. Harness notes for e3: the tool is offered to no run (`OFFER_PYTHON_INSTALL = false`); tests/python-install.test.mjs offers it by rewriting the constant in the loaded dist/background.js, which needs a fresh build; rows sent through SET_APPROVAL in a node:vm harness are built in the worker's realm, since `rowsFromAnswer` treats other-realm rows as malformed. E3 pushes tests/redteam-pkg-card.test.mjs as its own commits onto feat/pkg-card from 8c284e33 before merge; that file is reviewed by janitor-3 on #1719; the lane arms only when janitor-2 and janitor-3 have both named the head it ends on.

## Secrets

A secret handle is a receiver kind of its own in the dialect: no attributes, no methods, `repr` is `[secret: github]`,
and it can only be passed to an `ml` member whose manifest lists `use(secret)` ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)).
The namespace persists the handle, never a value, because the value never enters any Python process: the worker or the
host injects it at the sink.

## Placement and the environment

CPython at the host runs a different numpy build than Pyodide, and the strict reading of "placement is unobservable" is
not available at native speed. The rule is weakened to **the same result up to the recorded environment**: the host's
numpy and pandas are pinned to the versions in the Pyodide lock, the environment is stamped into the run's provenance
(the open topic on stamping a run's environment), and BLAS operation-order differences are named as a tolerance rather
than pretended away. Running Pyodide under Node at the host would make placement bit-identical and is kept as an option
for a case that needs it, not the default.

**Where a host-placed cell's values live.** RULED 2026-10-28 (Shane, in the coordinator's session; the host kernel is
designed, not scheduled). A value's home does not move because a cell is placed at the host: a fetched table and an
attached file live in the browser's value store, a process's output lives at the host, and the namespace entry is a
handle to that home. A host cell that needs a browser-held value gets it by ONE content-addressed copy over native
messaging into a host-side store keyed by the same SHA-256 the browser's store uses, so the bytes move once per value,
never per cell, and both stores charge their own budget; a host cell's result comes back the same way, as Arrow rows,
and becomes a pointer in the browser's store as a Pyodide result does. A paged document stays rendered in the browser
(pdf.js in the offscreen document); a host cell's `png()` is one bounded crossing per page, as
[`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md) has it. The operation goes to the value where it can (`ml.pipe` on a
host-held value runs at the host, [`SHELL.md`](SHELL.md)); the copy is for a cell that needs the whole value. The
transport's own limits (native messaging's per-message cap on the host-to-browser direction) are measured before the
build and bound the page size of a `png()` and the frame size of the copy; nothing in this rule depends on the number.

**Local kernel Python vs. CLI Python scripts on disk (`ml.sh`).** Host-placed `python_exec` ("local kernel Python") and
running a Python script via `ml.sh.run(["python3", "script.py", ...])` do not share a gate:

- **In-kernel (`python_exec`, or `import helper` inside a cell):** Runs inside the persistent per-run `dict` under
  `CO_RESTRICTED` (tier 3 by default for pure-Python functions, [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)
  for native leaves). It has no `open()`, `os`, `sys`, `argparse` or `subprocess`, and halts within the step budget with
  write-barrier rollback on failure. RULED 2026-10-28 (for `FILE_ATTACHMENTS.md` slice 3): an attached file reaches a cell
  the way a stored table does, as an injected value (`files: { name: "@file:…" }` giving the bytes; a tabular one through
  `tables`), never as a path under a mounted directory; a cell's `open("<name>")` is caught by the redirect that catches
  `pd.read_csv('current')`, resolving the attachment by name. A paged document (a PDF) is injected as its pages:
  each page's `text`, `kind` and `measure`, and `png(scale)`, a bounded on-demand render through the offscreen
  document, beside the bytes (`FILE_ATTACHMENTS.md`, "Python"). REOPENED 2026-11-12 (Shane, in the coordinator's
  session) for approved and `full` cells, which get a mounted `/files/` with a read-only `/files/attached/`
  (`FILE_ATTACHMENTS.md`, "A session's files as a directory"); this dialect keeps the injected value and the redirect.
- **Subprocess CLI (`ml.sh.run(["python3", ...])`):** Spawns a fresh OS process with `CO_RESTRICTED` off, because a CLI
  script legitimately uses `sys.argv`, `argparse`, `pathlib` and `open()`. While an agent is actively writing and editing
  an ad-hoc script (`tmp/scratch.py`, whose `sha256` changes on every turn), it is bounded by the OS sandbox (Seatbelt /
  Landlock) plus Root L's process-group memory/time cap and authorised for the session by a run-scoped policy
  (`propose_policy`, [`POLICIES.md`](POLICIES.md)). Once the script stabilises into a reusable repo tool
  (`scripts/<name>.py`), it is registered under a `(program: "python3", entrypoint: "scripts/<name>.py")` program
  manifest pinned by `sha256` (`propose_manifest`, [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), "Interpreted script
  tools"), whose claimed effects derive a tighter read-only kernel sandbox envelope.

## Step 0: measure the subset before writing it

The session plan that carries this and the vector corpus: [`docs/plan/repl/`](../plan/repl/README.md), lane 3.

The repo holds a corpus of real `python_exec` cells in run logs and bench results. Walking them with `ast` and counting
node types, imports and attribute calls says which subset admits most of what models actually write, and which numpy and
pandas methods the first manifest must cover. The JS dialect grew the same way. The gap list from that count is the
first PR's spec, and it decides the node whitelist and the first manifest whichever layer the evaluator lives in; nothing
in the design above is written into code before it. No guarded-compile or tree-walking prototype precedes the patch: the
utility is proved, and the patch is tested against the vector corpus below.

## Tests

The AGENTS.md rule for extending a dialect applies from the first construct: adversarial tests (reach `__class__`, a
builtin's `__globals__`, `getattr` with a computed dunder, `"{0.__class__}".format(x)`, `operator.attrgetter`,
`type()`, an exception's `__traceback__` → `tb_frame`, an unlisted import, a mutation of an unowned value, unbounded
`range`, a recursion past the depth), HALTING tests under a timeout, FAILURE tests (a refused cell leaves the namespace
as it was), run against the PATCHED CPython (the existing `dist/pyodide/` tests self-skip without it, and the patched
build replaces that directory's interpreter). A test that the C paths are gated is the one the evaluator-above-the-runtime
could never pass, and is why it sits first. The halting, failure and abuse vectors are written language-neutrally where
they can be and run against BOTH dialects, which is the only sharing the two can honestly have: one contract, one
manifest format, one vector corpus.

## Open questions

- **The allocation hook's cost.** A side-set insert per allocation while restricted, and a removal per dealloc; CPython
  allocates many small objects. If it shows, the alternatives are an epoch counter (needs a header word, breaks the ABI)
  or owning by reachability from the cell's namespace at the write barrier instead of by allocation.
- **Which CPython and Pyodide versions carry the patch first**, and how the host's build is distributed (a wheel of
  the interpreter, a `uv`-managed toolchain, the container image).
- **The first import list.** From the count's top refusers: `csv` and `PIL` admitted (both C leaves underneath, so
  manifest entries, not a bare import allowance), `urllib` and `sys` refused.
- **The genexp tail.** If a real share of generator expressions turns out to sit outside consumer position, a generator
  object becomes a receiver kind with no attributes and the frame bookkeeping for suspension joins the patch.
- **How much of real pandas falls inside tier 1.** `groupby().apply`, `merge` and string accessors have data-dependent
  cost; the first manifest may need a hard cap in place of a bound for some of them.
- **Exceptions.** `try`/`except` over the dialect's own errors is in (the JS dialect has it); whether a cell may catch a
  numpy error and continue, and what that does to rollback.
- **Printing.** The JS dialect's print boundary (abridging, substitution notes) needs a Python counterpart over
  `print`, `repr` and the implicit last-expression value.
