# Lane 3: the corpus count, the vector corpus, the CPython restricted mode

Read `README.md` in this folder first. Work slug `repl-lane3`; clone `~/git/window-ml-repl-lane3`. Labels `@python,@exec`
plus a NEW `@runtime-compat` (create it: "needs a matching change in the forked CPython/Pyodide"). You own
a new `notebooks/python-dialect/` topic folder, a new `tests/fixtures/dialect-vectors/` folder and the CPython fork; nothing under `src/` this round.

## Read before coding

- `docs/spec/PYTHON_DIALECT.md` (all; "The design" is your spec), `docs/spec/READONLY_LIBRARY_MANIFEST.md` ("Cost",
  "Format", the Python examples), `docs/spec/EFFECTS.md`.
- `docs/dev/readonly-exec.md` ("Halting", "Threat questions answered", "Known gaps": the JS dialect's test genres are
  what you lift into vectors), `docs/dev/notebooks.md` and the `notebooks` skill, `docs/dev/python-sandbox.md` (how
  `dist/pyodide/` is fetched and which CPython it carries), `docs/FORKED-BACKENDS.md` (the fork pattern you are
  joining).

## Root B: the corpus count (first PR, a notebook)

- A new topic folder `notebooks/python-dialect/` with `make-corpus-count.py` → `corpus-count.ipynb`, run with `node scripts/nb.mjs`, inputs
  pinned with `wmlnb.extract`. Sources of real `python_exec` cells: bench sweeps under `tests/e2e/artifacts/bench/`
  (each run's `run.json` holds the tool calls' arguments), the pooled copies under `artifacts/bench-pool/`, the bench
  store through `pull` if configured in `.env`, and the exports in `tmp/runs/` (about fifty mention `python_exec`).
  Say how many cells you found from each source.
- For every cell: `ast.parse`; count node types; imports; attribute CHAINS rooted at a name (`df.groupby`,
  `np.where`, `pd.DataFrame`, `s.str.contains`); builtins called; `while`, `class`, generators, `try`, recursion,
  `global`. Then the measure that matters: for each candidate whitelist (Starlark set; plus `while`; plus `class`),
  the fraction of cells ADMITTED whole, and the top constructs that exclude the rest.
- Outputs committed as data under that folder's `data/`: `node-counts.json`, `method-counts.json`, a proposed
  `whitelist.json`, and a proposed first `manifest-pandas.json`/`manifest-numpy.json` method list (names only; the
  effects and cost shapes are lane 3's second pass, after H). Prose in the notebook, cited from the PR, never pasted.

## Root G: the vector corpus (same PR or the next)

- A new `tests/fixtures/dialect-vectors/` folder, one JSON file per genre (abuse, halting, failure, ownership, print), each vector
  `{ name, js, py, expect: "refused" | "halts" | { value }, reason }`. Lift them from the existing JS tests (find them
  with `node scripts/test-index.mjs 'halting|adversarial|refus|rollback'`) and add the Python-only ones the spec names:
  `__class__`, `__subclasses__`, `"{0.__class__}".format(x)`, `operator.attrgetter("__class__")`, `type(x)`,
  `e.__traceback__.tb_frame`, an unlisted import, `getattr(x, "__" + "class__")`, mutation of an unowned value, unbounded
  `range`, recursion past the depth.
- The JS dialect's tests READ the shared file for the vectors that have a `js` field, and still pass. A vector with
  only `py` waits for H. Section headers per the test rule.

## Root H: the restricted mode in CPython (the big one; several PRs in the fork, one in this repo)

Target the CPython version the current `dist/pyodide/` carries (its `pyodide-lock.json` names it), so the patch applies
to the Pyodide build later. Fork under `parawanderer/` (ask Shane for the repository name before creating it). Land it
in this order, each piece with its vectors passing under `pytest` against the patched binary:

1. `CO_RESTRICTED` on code objects (set by a `compile(…, flags=…)` extension or a `_restricted.compile` helper after the
   `ast` whitelist pass), a `restricted` depth on the thread state, incremented on entering such a frame and
   decremented on leaving, including on exceptions and generators (there are none in the subset, but the frame code
   must be right anyway).
2. The gate: when the depth is non-zero, `PyObject_GetAttr`, `PyObject_SetAttr`, `PyObject_GetItem`,
   `PyObject_SetItem`, `PyObject_Call` and `IMPORT_NAME` consult a table registered from Python
   (`_restricted.allow(type, names)`, `_restricted.allow_call(callable, …)`), dunders refused outright, a miss raising
   `NotInDialect` (a new exception type). Measure the overhead on a stock pandas cell with the depth at zero (must be
   noise) and at one.
3. A manifest-approved C leaf LIFTS the depth for its dynamic extent and re-enters it when a restricted frame is pushed
   (the callback case: `df.apply(lambda …)`). `fresh`/`alias`/`internal` return marking as the spec says.
4. The step budget at the eval breaker: a counter decremented where CPython already checks `eval_breaker`, raising when
   it reaches zero; a test with a bounded `for` that runs out.
5. The allocation hook under the depth (a side set keyed by pointer, removal on dealloc) and the owned check at the
   write barrier; the byte count per cell. Measure the cost; if it shows, write to `repl-specs` with the numbers before
   choosing the alternative the spec lists.
6. The undo log at the write barrier and replay on refusal; a test that a refused cell leaves the namespace as it was,
   including a list it appended to and a dict it set.

Rules: **the ABI stays** (no object header change, no stable-ABI change; stock numpy and pandas wheels must import and
run under the patched binary, and a test says so). The halting rules stay static where they can be (the whitelist
refuses `while` before running; the budget catches the rest). `re` gets the `riskyRegex` pre-check ported to Python and
applied before `re` calls. Nothing in this repo's `src/` changes for H; what lands here is the vectors passing, the
notebook's numbers, and a `docs/dev/` note on building and testing the fork.

The Pyodide build of the patch is NOT this round: it needs the emscripten toolchain and hours per build. Write down what
it will take when you know.

## Questions already answered

No evaluator written in Python. No guarded-compile prototype. No sandbox-only path. The parser is `ast.parse`. The gate is
in the abstract object layer, not in opcodes alone, so `str.format` and `getattr` are covered by construction.

## Report back

`LANE_3_RESULT_<root>.md` in this folder, per root: the corpus sizes and the admitted fraction per whitelist, the
overhead numbers at depth zero and one, the allocation hook's cost, what the fork's build needs, what a spec got wrong.
