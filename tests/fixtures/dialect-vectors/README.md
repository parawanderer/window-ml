# Dialect vectors: one contract, two dialects

The halting, failure and abuse cases a read-only dialect must pass, written once and run against BOTH dialects: the
JS one (`src/readonly-exec/`, today) and the Python restricted mode (`docs/spec/PYTHON_DIALECT.md`, once the patched
CPython exists). A vector with a `js` field is run by the JS dialect's own tests, which read these files; a vector
with only `py` waits for the patched interpreter. Plan: `docs/plan/repl/LANE_3_RUNTIME.md`, root G.

## Files: one genre each

| File | What every vector in it asserts |
| --- | --- |
| `abuse.json` | an escape: reaching an effect, a realm, a dunder, an unlisted import, an unowned value. Never runs; `expect` is `"refused"` |
| `halting.json` | the program ENDS within the runner's timeout (each runner runs this file in a worker or subprocess it can kill) |
| `failure.json` | a refused program leaves no state behind (`leaves_nothing`) |
| `ownership.json` | what a program may reach and write: its own values and the listed reads yes (a column, a type), anything it was handed or did not create no |
| `print.json` | what printing and the returned value show (abridging, substitution notes) |

## A vector

```json
{
  "name": "constructor → Function",
  "js": "({}).constructor.constructor(\"return fetch\")()",
  "py": "().__class__.__base__.__subclasses__()",
  "env": "none",
  "expect": "refused",
  "reason": "the realm's Function constructor compiles a string; a dunder walk reaches every class",
  "from": "tests/readonly-exec.test.mjs ESCAPES"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | unique within its file; a lifted vector keeps the JS test's name, so the test list does not change |
| `js`, `py` | at least one | the program in each dialect. Python is a CELL: a top-level `return` is legal, as in `python_exec` |
| `env` | yes | the world it runs in, a key from the table below |
| `expect` | yes | `"refused"`: ends with `NotInDialect` or `Denied` (JS) / `NotInDialect` (Python), never a value or another error. `"halts"`: ends within the timeout, whatever the outcome. `{ "value": <json> }`: ends with this value |
| `budget` | no | a step budget for this vector (JS `stepBudget`, Python the eval-breaker counter); default is the runner's test budget |
| `pre` | no | `{ "js"?, "py"? }`: a program run first, in the same state, which must succeed (a namespace or an answer set to roll back to) |
| `leaves_nothing` | no | `true`: the runner snapshots its state after `pre` and asserts it is identical after the refusal (JS: the answer set; Python: the namespace, compared by value) |
| `reason` | yes | why the expectation holds; the sentence a reviewer needs |
| `from` | no | where a lifted vector came from |

The genre is the file, so it is not a field. A runner that does not know an `env` key SKIPS that vector and names it;
it never runs it in a different world.

## Worlds (`env`)

| Key | JS | Python |
| --- | --- | --- |
| `none` | `{ defaultView: null }`, no `ml` | an empty namespace |
| `dom` | the `world()` document of `tests/readonly-exec.test.mjs`, with its stand-in `ml` | (none: skip) |
| `answer` | `world()`, the stand-in `ml` and an `AnswerSet` facade with its checkpoint | (none: skip) |
| `table` | (none: skip) | a namespace holding `df = pd.DataFrame({"a": [1, 2, 3, 4], "b": [5, 6, 7, 8], "c": [9, 10, 11, 12]})`, which the cell did NOT create (unowned), and the prelude's names (`pd`, `np`, …) |
