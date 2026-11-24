# Cell facts: what a cell did, recorded, and what a cell is for, classified offline

**Status: ruled; Half 2 built, Half 1 not.** RULED 2026-11-24 (Shane, ruling 111, in the coordinator's session): both halves are
wanted, "not shown to the model, but kept for our own reference and e.g. exposed in the JSON export". A cell is one
`exec` or `python_exec` call of a run. Owners: the recorded facts are the async lane's, for both languages; the
classifier is the bench lane's.

## Why two things, and why only one is stored

What a cell DID depends on the build, the namespace and the worker it ran in. It cannot be recovered afterwards: the
bench recovers it today by replaying cells against a core, and 12 of 226 replayed cells did not reproduce their live
output (the bench lane's baseline, 2026-11-23, replayed at #2124's aef9a8eb). So it is recorded when the cell runs. What a cell is FOR is a function
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

**Built** (taxonomy 1): [notebooks/cell-labels/](../../notebooks/cell-labels/README.md), first used in
`cell-labels-baseline.ipynb`.

One tool, one taxonomy for both languages, reading the JSON export and writing a table beside it. It lives with the
bench's notebooks (`docs/dev/notebooks.md`) and nothing under `src/` imports it (a test asserts this).

- **Syntactic.** Labels come from the syntax tree alone: Python's `ast` for a Python cell, the dialect's own parser
  for a JS cell, with a fallback parser for JS the dialect refuses. No model judges a cell. A cell that does not parse
  gets `unparsed`.

- **Multi-label.** A cell that loads, filters and prints carries three labels. No label is primary.

- **Versioned, and the rules are data.** Each label's list of names lives in ONE data file beside the tool, and the
  output names `taxonomy: <n>`. Changing a list, a rule or a label raises `n`; old exports are simply classified
  again. The table below defines what each label MEANS and gives its leading names; the data file is the rule, and a
  name not in it earns no label.

- **Never empty.** A cell that parses and earns no label gets `other`; one that does not parse gets `unparsed`.

- **The step's arguments count as syntax.** A label may be earned from the tool call's arguments, which the export
  holds: a `python_exec` step that passes `tables` (exports from before ruling 110) is `ingest`, with the flag
  `by-argument`.

| Label | Means | Python, leading names | JS, leading names |
| --- | --- | --- | --- |
| `ingest` | data enters the cell from outside its source | `pd.read_*`, `open` with no mode or a read mode, `Path.read_text`/`read_bytes`, `json.load`, `ml.table`, `ml.fetch`; the `tables` argument | `ml.table`, `ml.fetch`, `fetch`, `ml.fs.readFile`, a `@tool:` or `@file:` dereference |
| `parse` | text is turned into records by hand | `io.StringIO(`, `csv.reader`, `json.loads`, a `split` on a line or field separator | a `split` on `"\n"` or `","`, `JSON.parse`; a `map` chained on such a `split` is part of the parse, not `transform` |
| `list` | file-system metadata is read | `os.listdir`, `os.walk`, `os.scandir`, `glob`, `Path.iterdir`/`glob`/`rglob`, `os.path.exists`/`isfile`/`isdir`, `os.stat` | `ml.fs.readdir`, `ml.fs.stat` |
| `probe` | the cell asks what its environment is | `globals()`, `locals()`, `vars()`, a bare `dir()`, `os.getcwd`, `os.environ`, `sys.version`, `sys.path`, `platform.*` | `typeof ml`, `Object.keys` of `globalThis` or `ml`, `navigator.*`, `location.*` |
| `inspect` | a description of DATA is the cell's output | `head`, `tail`, `info`, `describe`, `dtypes`, `shape`, `columns`, `len`, `type`, `dir(x)`, where the value is printed, returned or a bare expression; the same name used inside a computation earns nothing | a bare or returned read of `length`, `textContent`, `outerHTML`, `Object.keys(x)` |
| `select` | rows or items are kept or dropped | boolean indexing, `loc`/`iloc`, `query`, `filter`, `nlargest`/`nsmallest`, a comprehension with `if` | `filter`, `find`, `querySelector(All)` with a selector that is not a bare tag or id |
| `transform` | values are changed, same cardinality | assignment to a column or key, `assign`, `apply`, `map`, `astype`, `to_datetime`/`to_numeric`, the `.str` accessor, `merge`, `sort_values`, `sorted`, `pivot`, `melt`, `cumsum`/`shift`/`diff`/`rank` | `map` (but see `parse`), `sort`, string and array reshaping |
| `aggregate` | many values become fewer | `sum`, `mean`, `count`, `min`/`max` (methods and builtins), `groupby`, `value_counts`, `agg`, `idxmax`/`idxmin`, `pivot_table`, `crosstab` | `reduce`, `Math.max`/`min` over a spread, a `for…of` that accumulates |
| `report` | the result is rendered for a reader | `to_markdown`, `to_string`, `to_dict`, `json.dumps`, a formatted `print` of a computed value | `JSON.stringify` of the result, a template string built for return |
| `dom-read` | the page is read | none | any read on `document` or an element |
| `dom-act` | the page is changed or driven | none | a write to the DOM, `click`, `dispatchEvent`, a form value set |
| `write` | a file is written | `to_csv` and kin, `open` with a write mode, `Path.write_*` | `ml.fs.writeFile`, `ml.fs.appendFile`, `ml.sh.put` |
| `shell` | a program is run | `ml.sh.*`, `subprocess` | `ml.sh.*` |
| `plot` | a picture is drawn | `matplotlib`, `.plot(` | a canvas or SVG draw |
| `define` | a function or class is bound to a name | a `def`, a `class`, a `lambda` ASSIGNED to a name; an inline `lambda` argument is not | a function or class declaration, an arrow assigned to a name |

Structural flags, reported beside the labels: `loop` (`for`, `while`, a comprehension), `try`, `import` (with the
module names), `returns` (the cell ends in a `return` or a bare expression), `by-argument`, `lines`.

- **Rulings on the bench lane's objections (the coordinator, 2026-11-24, against its probe of the 371 Python and 344
  JS baseline cells).** `len` alone, printed or returned, is `inspect` and not `aggregate`. `idxmax` and `idxmin`
  reduce, so `aggregate`; `nlargest` and `nsmallest` return rows, so `select`. `pivot_table` and `crosstab` aggregate;
  `pivot`, `melt` and the window operations keep cardinality, so `transform`. A bare `return` earns the `returns` flag
  and no label. Hand-parsing is its own label because it is the behaviour of interest: in the baseline about 121 of
  344 JS cells split CSV text by hand.

- **Tests.** A fixture corpus of at least 60 cells, 30 per language, with expected label sets; every label has a
  positive and a negative case in each language it applies to. Cells come from the bench's recorded runs where they
  exist. A label the baseline never shows (`shell`, `plot`, `dom-act`, Python `write`) takes a hand-written minimal
  cell, marked synthetic in the fixture.

- **First use.** The bench's baseline (114 runs: 371 `python_exec` cells and 344 `exec` cells), reported as labels by
  language by stratum, beside half 1's facts once those exist: which kind of step the model gives to which language,
  and which kinds run outside.

## Open

- Whether the sidebar shows the facts (a dev-view line on a step). Not asked for; the export and the run log are the
  ruling.

- Whether a `not-run` cell's refused ARGUMENT text is kept beside `why.name`. Default: no, the step's `arguments`
  already holds it.
