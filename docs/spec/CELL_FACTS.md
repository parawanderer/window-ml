# Cell facts: what a cell did, recorded, and what a cell is for, classified offline

**Status: ruled, not built.** RULED 2026-11-24 (Shane, ruling 111, in the coordinator's session): both halves are
wanted, "not shown to the model, but kept for our own reference and e.g. exposed in the JSON export". A cell is one
`exec` or `python_exec` call of a run. Owners: the recorded facts are the async lane's, for both languages; the
classifier is the bench lane's.

## Why two things, and why only one is stored

What a cell DID depends on the build, the namespace and the worker it ran in. It cannot be recovered afterwards: the
bench recovers it today by replaying cells against a core, and 13 of 226 replayed cells did not reproduce their live
output (the bench lane's baseline, 2026-11-23). So it is recorded when the cell runs. What a cell is FOR is a function
of its source, which the export already holds. It can be computed at any time by any version of a classifier, so
storing it would freeze one version's labels into old exports. It is computed offline and never stored.

## Three rules that hold for both halves

- **Never model-facing.** No fact and no label enters a prompt, a tool result, `ml.current` or `agent_api_docs`.

- **Never an input to a decision.** The gate, the policies, the outside mark and the routing read none of it. A fact
  is written after the decision it describes; a test asserts that removing the recorder changes no call's outcome.

- **Absent means unknown.** An export written before this lands has no facts. A reader treats a step with no `cell` as
  unknown, never as inside and never as outside (the upgrade row: a fixture of an old export, read by the new views
  and the classifier).

## Half 1: the recorded facts

One object, `cell`, on the step of each `exec` and `python_exec` call, in the JSON export (`ExportStep`,
`src/export-schema.ts`) and as one line in the Markdown export; the same object as one record in the execution log
(`docs/dev/run-log.md`), so a run that is never exported still has it. What exists today (the async lane's reading of
main, 2026-11-24): inside or outside is only inferable from `approval`; the first refused name, the steps used and the
lifted calls are computed or thrown and then dropped; no wire-call count exists.

| Field | Type | Meaning |
| --- | --- | --- |
| `lang` | `"js"` or `"python"` | which evaluator |
| `ran` | `"inside"`, `"outside"`, `"not-run"` | inside the dialect; outside it (asked or policy-allowed); refused before any code ran |
| `class` | `"A"`, `"B"` | the ladder's class of the worker when the cell started (the plan's ruling 102); absent for `not-run` |
| `why` | `{ kind, name? }` | for `outside` and `not-run`: why it was not inside. `kind` is a slug from the table below; `name` is the first refused name as the evaluator reports it (`pandas.read_csv`, `while`, `tables`) |
| `steps` | `{ used, budget }` | the step meter at the cell's end; for `inside` cells and for a JS cell that tripped |
| `lifted` | `[{ name, calls, charged }]` | each lifted or host function the cell called, with the steps charged for it; at most 32 rows, largest charge first, then `liftedMore: n` |
| `wire` | `[{ member, calls }]` | each `ml` wire member the cell called; at most 32 rows |
| `marked` | `true` | this cell set the outside mark (Python); absent otherwise |

| `why.kind` | When |
| --- | --- |
| `not-in-dialect` | the evaluator refused a construct or a name; `name` says which |
| `denied` | the evaluator reached a refused operation on a value |
| `budget` | the step budget or a size cap tripped; `name` is the cap's name |
| `marked` | not tried inside, because the worker carries the outside mark |
| `argument` | a tool argument was refused before the cell ran (`not-run`) |
| `routing` | the cell had to run in another world or host than the dialect's (`ml.current`, a pointer, an unapproved page) |

- **Names are identifiers, never values.** `why.name` and `lifted[].name` are dotted names from the source or the
  manifest, at most 120 characters. They cross the stored-text scrub like every exported string.

- **Bounded.** The object is at most 4,096 characters serialized; past that the row lists are cut and the counts kept.

- **Deterministic fields diff cleanly.** `ran`, `class`, `why`, `lifted[].name`, `lifted[].calls` and `wire` are
  functions of the cell, the build and the worker's history. `steps.used` and `charged` are deterministic on one
  build; if a measurement shows they are not, they join `VOLATILE_FIELDS` (`docs/dev/export.md`).

- **The refusal is kept where it is thrown.** Today `readonlyRefused` and `pythonCellInDialect` reduce a refusal to a
  boolean. They return the first refusal instead, and their callers keep deciding on the boolean alone.

- **Tests.** One row per `why.kind` for each language that can produce it; the upgrade row above; the row that the
  recorder changes no outcome; a red-team row that a hostile cell cannot write or forge its own `cell` object (the
  recorder runs outside the cell's realm).

## Half 2: the offline classifier

One tool, one taxonomy for both languages, reading the JSON export and writing a table beside it. It lives with the
bench's notebooks (`docs/dev/notebooks.md`) and nothing under `src/` imports it (a test asserts this).

- **Syntactic.** Labels come from the syntax tree alone: Python's `ast` for a Python cell, the dialect's own parser
  for a JS cell, with a fallback parser for JS the dialect refuses. No model judges a cell. A cell that does not parse
  gets `unparsed`.

- **Multi-label.** A cell that loads, filters and prints carries three labels. No label is primary.

- **Versioned.** The output names `taxonomy: <n>`. Changing a rule or a label raises `n`; old exports are simply
  classified again.

| Label | Python, by syntax | JS, by syntax |
| --- | --- | --- |
| `ingest` | a call to a reader (`pd.read_*`, `open` for read, `json.load`, `ml.table`, `ml.fetch`) | `ml.table`, `ml.fetch`, `fetch`, a `@tool:` or `@file:` dereference |
| `list` | `os.listdir`, `os.walk`, `glob`, `Path.iterdir` and kin | `ml.fs.readdir` |
| `inspect` | a bare expression or `print` of `head`, `info`, `describe`, `dtypes`, `shape`, `columns`, `len`, `type`, `dir` | a bare read of `length`, `textContent`, `outerHTML`, `Object.keys` |
| `select` | boolean indexing, `loc`/`iloc`, `query`, `filter`, a comprehension with `if` | `filter`, `find`, `querySelector(All)` with a non-trivial selector |
| `transform` | assignment to a column or key, `assign`, `apply`, `map`, `astype`, `merge`, `sort_values` | `map`, `sort`, string and array reshaping |
| `aggregate` | `sum`, `mean`, `count`, `groupby`, `value_counts`, `agg`, `min`/`max` | `reduce`, a `for…of` that accumulates |
| `dom-read` | none | any read on `document` or an element |
| `dom-act` | none | a write to the DOM, `click`, `dispatchEvent`, a form value set |
| `write` | a writer (`to_csv`, `open` for write, `Path.write_*`) | `ml.fs.writeFile`, `ml.sh.put` |
| `shell` | `ml.sh.*`, `subprocess` | `ml.sh.*` |
| `plot` | `matplotlib`, `.plot(` | a canvas or SVG draw |
| `define` | a `def`, `class` or `lambda` bound to a name | a function or class declaration |

Structural flags, reported beside the labels: `loop` (`for`, `while`, a comprehension), `try`, `import` (with the
module names), `lines`.

- **Tests.** A fixture corpus of at least 60 cells, 30 per language, with expected label sets, drawn from the bench's
  recorded runs; every label has a positive and a negative case in each language it applies to.

- **First use.** The bench's baseline (114 runs, 371 cells), reported as labels by language by stratum, beside half
  1's facts once those exist: which kind of step the model gives to which language, and which kinds run outside.

## Open

- Whether the sidebar shows the facts (a dev-view line on a step). Not asked for; the export and the run log are the
  ruling.

- Whether a `not-run` cell's refused ARGUMENT text is kept beside `why.name`. Default: no, the step's `arguments`
  already holds it.
