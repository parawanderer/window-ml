# Lane 3 result, root G: the vector corpus

Session `repl-lane3` (Claude Code, `claude-opus-5-5`, session `834c05ec-8bfd-46af-9296-ab7f2cb1e06a`), 2026-10-15. Landed
in the same PR as root B.

## What the acceptance test showed

The JS dialect's tests read the shared vectors and still pass, with an identical test list. The list was diffed before
and after the change: both runs give the same 207 test names and 0 failures. The vectors are in
`tests/fixtures/dialect-vectors/`; the schema and the worlds are in its README. The loader and validator are
`tests/dialect-vectors.mjs`, and `tests/dialect-vectors.test.mjs` checks every file. Vectors per genre:

| Genre | With `js` (lifted, run today) | With `py` (wait for H) |
| --- | --- | --- |
| abuse | 18 | 31 |
| halting | 114 | 20 |
| failure | 5 | 5 |
| ownership | 66 | 13 |
| print | 0 | 0 |

The Python vectors cover what `PYTHON_DIALECT.md` lists, plus the C paths an evaluator above the runtime could not
guard:

- **Escapes through C:**
  - `str.format` and `format_map` walking a dunder;
  - `getattr` with a computed name;
  - `operator.attrgetter`, both called directly and as a sort key;
  - `np.frompyfunc` calling a restricted lambda from C;
  - `df.apply` with a lambda;
  - `df.eval`.
- **Introspection without a dunder:** `gi_frame`, `f_builtins`, `tb_frame`.
- **Loops CPython's step counter cannot see**, because they run inside one C call: `sum(range(10**12))`,
  `max(itertools.count())`, `iter(int, 1)`, `"a" * 10**11`.
- **A list that grows while it is being iterated.** In Python this does not halt; the JS dialect fixes the trip count
  instead.
- **Undo of C-method writes** (`list.sort`, `append`, `del`) on a refusal.
- **The rulings from root B:** generator expressions in and out of consumer position, the `type(x)` kind, and the
  DataFrame column rule.

Both counts are pinned by a test, so neither shrinks silently. Every `py` program parses as a cell (checked with `ast`).

## What did not work, or was left out

- **`print.json` is empty.** Every JS print test asserts a `logs` array, which the schema has no field for, and the
  Python print boundary is an open question in the spec. Its counterpart needs a `stdout` expectation, added when the
  print boundary is designed.
- **JS cases that stay inline**, because a vector cannot express them:
  - Cases needing a bespoke fixture: values planted on the page, the table-facade worlds, a custom `ml`.
  - Cases expecting a value JSON cannot hold (`Infinity`), or asserting by regex.
  - Positive tests with no refusal or halting angle.
- **One lifted case must be refused as `Denied` specifically.** A vector only says `refused`, so the test asserts
  `Denied` beside the vector.

## Assumptions where a spec was silent

Each of these is written into its vector's `reason`:

- **Ownership lasts for the whole run, not one cell.** A list an earlier restricted cell allocated is still owned.
- **Injected values are unowned.** Mutating the `df` that `tables` handed in is refused, as page values are in the JS
  dialect. A `.copy()` is owned.
- **`reshape` returns `internal`, as the spec says, so writing through it is refused even when the base is owned.** This
  is probably too strict, since `alias(0)` would admit it. The vector is kept as written until the manifest pass decides.
- **The `table` world's frame** is fixed as `a`, `b`, `c` over 1 to 12, so the value vectors have exact answers.

## What a spec got wrong

Nothing in the vector contract itself. `PYTHON_DIALECT.md` names the escapes but not the halting cases that run inside
one C call. Those can only be refused before the call, by the manifest's cost bound, and the vectors make that
requirement explicit.
