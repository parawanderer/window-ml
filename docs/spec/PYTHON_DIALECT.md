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
| memory | the same allocation hook, on EVERY allocator domain in use | a byte count per cell, the native form of the JS dialect's `MAX_COLLECTION`. The hook wraps the domain an allocation actually reaches, never one layer it is assumed to pass through: the first cut hooked the RAW domain and pymalloc's arenas, which Pyodide's CPython is built without (`--without-pymalloc`), so under wasm32 the MEM and OBJ domains went straight to `malloc` and the count saw almost nothing (lane 3, 2026-10-19, found from lane 5's two wasm32 vectors). A sequence repeat's size is judged against the count before CPython's own overflow guards, so the refusal is `NotInDialect` and never `OverflowError`/`MemoryError`; the tests run under `PYTHONMALLOC=malloc` natively, which is the same wiring. The MEM and OBJ wrappers stay installed once the first run has installed them (RAW is permanent), so plain exec pays one indirect call per allocation: lane 5 measured about 1.3x on a million small tuples under wasm32, on a noisy laptop. Installing them only for the outermost restricted entry's extent is OPEN, not ruled (2026-10-20, the generalist's analysis): it is correct on a GIL build with two guards (`MemoryEnd` restores only while the installed allocator is still ours, so a hook stacked on ours during a run, `tracemalloc.start` from host code, is not dropped; `MemoryBegin` never wraps our own wrapper, or every block counts twice), a free-threaded build needs a fresh look, and it is built only after a native before/after number says the gain is real (a plain loop before any run, after one, and metered, under `PYTHONMALLOC=malloc` and pymalloc), then lane 5's wasm bench cell. Batched with the next fork change. |
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

**Local kernel Python vs. CLI Python scripts on disk (`ml.sh`).** Host-placed `python_exec` ("local kernel Python") and
running a Python script via `ml.sh.run(["python3", "script.py", ...])` do not share a gate:

- **In-kernel (`python_exec`, or `import helper` inside a cell):** Runs inside the persistent per-run `dict` under
  `CO_RESTRICTED` (tier 3 by default for pure-Python functions, [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)
  for native leaves). It has no `open()`, `os`, `sys`, `argparse` or `subprocess`, and halts within the step budget with
  write-barrier rollback on failure.
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
