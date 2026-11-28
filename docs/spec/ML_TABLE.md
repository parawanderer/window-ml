# Spec: `ml.table`, a cell reads its own tables

**Status: specified (2026-11-19); the JS member is built (#2043, "Built as of 2026-11-20" below); the Python member is
built and `tables` is removed (2026-11-24, "Page callers" and "What a Python cell gets" below); the `/files` writers and
the lazy table are not.** The design note, with every measurement behind these rules, is
[`docs/plan/repl/ML_TABLE.md`](../plan/repl/ML_TABLE.md). This file holds the rules; where another spec owns a line, it
is pointed at, not restated. Shane's rulings: 55, 56, 57, 68 to 72, 75 to 87 (2026-11-19, in the coordinator's
session, recorded in [`docs/plan/repl/README.md`](../plan/repl/README.md)).

## The member

`python_exec` injects no table. A cell asks for its data itself, and every value in its namespace is one it made and
owns (ruling 68).

- **Python: `t = ml.table(src, raw=False, delimiter=None, header=None, decimal=None)`**, a synchronous call (ruling 77).
  - The facade blocks on the wire answer through JSPI (`pyodide.ffi.run_sync`), with no fork change and no `Await`
    node. The spelling is the same inside and outside the dialect. Built (2026-11-24): `ml.table` is the facade's one
    synchronous member (`_call_sync` in `ml-facade.ts`, over the lockdown harness's `run_sync`), and each cell admits
    it inside the dialect as a lifted leaf (`_ml_table_inside`, "The charge"); the facade's other members stay `async`
    ([`ML_WIRE.md`](ML_WIRE.md), "Step 1"). It is absent where nothing can wait in place: a real-CPython run, a
    completion, and a cell whose worker installed no wire.
  - It returns a pandas DataFrame (ruling 78), built in the cell from the table's bytes. The source facts go on
    `t.attrs`: `source`, `delimiter`, `truncated` and `headerless`.
  - Past the materialise cap, it returns the lazy table instead ("Tables too large to load").
- **The materialise cap is 100 MiB of source bytes** (`MATERIALISE_CAP_BYTES`, one constant in the Python facade's
  module, read by both members and by the lazy table's `to_pandas()`). It is derived, not measured: an inside cell may
  add `_restricted.DEFAULT_MEMORY` (256 MiB, read from the pinned core) to the heap, and a parsed CSV grows the heap
  about 2 bytes per source byte, which leaves about 50 MiB for the cell's own work. The same value applies outside the
  dialect, so the model reads one rule. **Provisional:** it moves when a materialise is measured under the fork's cap
  in Chrome, or when the core's `DEFAULT_MEMORY` changes.
- **Python: `ml.fetch(url, …)`**, the same synchronous form. Its answer enters the run's fetch cache as a `fetch_url`
  result does.
- **JS: `ml.table(src, opts)`**, on `window.ml` and in the exec dialect's `mlFacade`. It returns the `Table` facade
  (`asTable`) and is judged by the same rule.
- **The bytes cross as bytes:** a typed array from the value store, never a JSON row list and never a JS string. A
  string costs twice the heap, and `FS.writeFile` of a 250 MB string crashed Node's heap.

### The hold (ruling 77)

While an inside cell is suspended in a member, nothing but the cell's own awaited chain runs Python on its namespace.

- Today a second run message is held by `runChain` (`src/python/python-worker.ts`).
- An asyncio task and a callable handed to JS cannot reach an inside cell, for two reasons. No task outlives a cell,
  because tasks are spent and the queue is cut at the cell's end. And an inside cell can schedule no task and hand
  no callable to JS.
- Before any scheduler is admitted inside (asyncio, `call_later`, a JS member that takes a callback), the hold is
  built first: in the spend queue's enqueue, keyed on the awaited chain, and in the cell gate's callable wrappers.
- e3's rows come with the first PR that adds the member. Each of the three writers is tried during a suspension, and
  the inside cell's namespace is unchanged. For the asyncio task and the JS callable, the row also asserts that the
  scheduler is refused inside.
- A suspension is not counted against the step budget. The worker's wall-clock kill bounds it.

## Sources, and when one asks (rulings 70, 80)

A source is judged exactly as a source in `python_exec`'s `tables` was:

| Source | Unasked when | Otherwise |
| --- | --- | --- |
| a CSS selector, or `current` on a page with one table | always: a read-only read of the page | none |
| `current` on a Google Sheet page, or a Sheets URL | the Sheet is in the run's approved store (`approvedSheets`) | asks |
| an `@tool:` table pointer | always: the run's own stored value | none |
| an http(s) URL | it is in the run's fetch cache (the person approved that fetch) | asks; it never fetches unasked (ruling 37) |
| a fetch result | as its `url` above: it is read by its URL alone, never by its `.text` or `.table` | as its URL |
| a path under `/files/` | the path is readable to the model ([`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md)) | refused, with that spec's errno |
| an `@file:` pointer (ruling 107) | as the `/files/attached/` path of the file it names | as that path; a name two files share is refused as [`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md) refuses it |

- **Built as of 2026-11-20 (#2043)** (`src/ml/ml-table.ts`; the table above is the design, and these differ from it):
  - A Sheet always asks in the read-only dialect: the run's approved store (`approvedSheets`) is not read there yet, so
    the "Unasked when" cell for a Sheet is not built yet. A direct call from page script, or from an exec the person
    approved, does not ask in `ml.table`. It sends `FETCH_SHEET`, and the worker's gate (`background.ts`) decides: from
    a page whose site does not approve its own actions, the read is refused unless the tab holds a grant for that
    Sheet's id, minted when one of its agent runs approved it. A site that approves its own actions, and an extension
    page, read any Sheet, still host-locked to the `docs.google.com` export URL. This is the gate python_exec's Sheet
    read goes through, not `ml.fetch`'s: `ml.fetch` never sends `FETCH_SHEET`.
  - A `/files/` path is not readable yet: the dialect does not ask, and the read throws "ml.table(<path>): /files/ is
    not readable from here yet". The errno refusal from `FILE_ATTACHMENTS.md` is not built yet.
  - A URL never fetches: a URL not in the fetch cache asks in the dialect, and throws on a direct call. A URL that was
    fetched with credentials or rendered is never cached, so it throws too. A body clipped at the fetch cap throws,
    pointing at the fetch's `@tool:<id>`; only a CSV/TSV reads as a table.
  - A pointer is live only inside an `ml.agent` run, and its output must be a table.
  - A page table with merged or nested cells throws; `delimiter` and `header` apply only to delimited text (a fetched
    CSV, a Sheet) and throw for a page table, a pointer or a table value.
- **An `@file:` pointer is a source (ruling 107; Shane, 2026-11-23; not built).** The attachment's outline hands the
  model the file as `@file:<id>`, and in bench's first corpus that is the form models passed as a table source (39 of
  86 cells, every one refused; bench's account). `ml.table("@file:<id>")` is `ml.table(<that file's /files/attached/
  path>)`: one file, one judgement, one set of bytes, in Python and in JS. `pd.read_csv` does not take the pointer: it
  takes the path, as pandas does. A file that is not delimited text is refused with a sentence naming `dereference`.
- **The rule runs at call time, on the resolved value,** whether the code named it as a literal or computed it.
- **A literal scan only hoists.** It finds the `ml.table("…")` sources in the code, so the card can show them above
  the code and an approval can grant them up front. In JS this is the `fetchUrlLiterals` pattern. For Python it is
  built (2026-11-24) as a tokenizer in the extension, not an `ast` pass (`tableLiterals`, `src/python/table-literals.ts`),
  because the page and the agent loop scan before any interpreter is up. It reads only a call spelled `ml.table` whose
  first argument is one plain string literal: never a computed source, a concatenation, an f-string or bytes, never a
  call inside a comment or a string, and at most `TABLE_LITERALS_MAX` (32) a cell. Literal `raw`, `delimiter` and
  `header` keywords are kept, and any other keyword drops them all. A literal in a branch that never runs is still read.
  Code the tokenizer cannot account for (an unterminated string) yields nothing. `tests/table-literals.test.mjs` holds
  the adversarial rows.
- **A computed Sheet in a worker-run cell asks (fixed 2026-11-24).** The worker's reader (`workerTableRead`) used to
  read an unapproved Sheet unasked when the run's page was one whose site approves its own actions. Because the
  source is now computed at call time, that let a cell build a Sheet URL the card never showed and read it with the
  person's login. It now reads a Sheet only when the Sheet is in the call's approved set, or when the source is
  `current` on that Sheet's own tab. Any other Sheet asks: `Asks` inside the dialect, and a nested ask on the step in
  an approved cell (`sheetAsk`, `sw-ml-table.ts`). The RED TEAM row in `tests/run-start.test.mjs` pins it.
- **Inside the dialect,** a source that needs the person raises `NotInDialect` at the bridge. The call goes to the
  person, and the approved rerun has the hoisted grants.
- **In an approved cell,** a source the card did not hoist gets a nested ask on the running step ([`ML_WIRE.md`](ML_WIRE.md),
  "Per-call asking"). A refusal is an error raised in the cell. An approval goes into the same store the hoisted
  literals use, so a later read of that source is free.
- **A cell's fetch** is judged as `fetch_url`'s is: `judgeCall(runId, "fetch", fetchFacts(url, mode))`, plus the run's
  origin grants and its consented set.

### Page callers (built 2026-11-24)

A cell has two hosts, and they read at different times.

- **A worker-run cell** (an agent run the worker built) reads at the call. Each `ml.table(src)` is an `ML_CALL` for
  member `table` (`tableMemberFor`, `src/sw/sw-ml-table.ts`). The worker judges the resolved source by the table above
  (`workerTableRead`, `src/sw/worker-tools.ts`), asking the run's tab only for a page table, and records each read on
  the call (`pyCall.read`). A computed source is read like a literal one.
- **A page-started cell** (`ml.pythonExec`, or a page-built run's `python_exec`, which the page's own loop runs) has no
  run the worker can read for at the call. So before the cell, the page reads each source its code writes as a literal
  (`hoistTables`, `src/ml/ml-python.ts`). It judges each one with `_hoistTable`, the judgement a `tables` source had,
  and sends the answers as `hoisted` in the `PYTHON_EXEC` payload. The cell's call is answered from them by source
  and options (`hoistKey`). A source the page did not read, because it was computed or never written as a literal, is
  `Absent` with the sentence `UNHOISTED_TABLE`, which tells the model to write the source as a literal or to read it
  in an agent run.
- **A read the page refused is the call's error, not the cell's.** The cell still runs, and the call that names that
  source raises `MlError` with the page's reason, at that line. A read in a branch that never runs then costs nothing.
  A page-started cell has no `/files/`, so an `@file:` or `/files/` literal is that error.
- **An `@tool:` literal** in a page-built run is resolved by the agent loop before the call (`resolveTablePointers`,
  `src/agent/agent-loop.ts`) into `args._tablePointers`. A pointer to something that is not a table, or one that does
  not resolve, becomes that entry's error, in the same words a bad pointer gets elsewhere.
- **A stale `tables` or `tableRaw` argument** (a model, or a saved script, that still passes one) gets one sentence and
  nothing runs (`staleTableArgs`, `src/python/table-literals.ts`). The sentence names `ml.table("<source>")` and
  `raw=True`. It is checked before the gate, so no card is shown for a call that cannot run.

## Ownership (ruling 57, amended by ruling 89)

The JS `Table` that `ml.table` returns is read-only exactly when something else still holds the same arrays, and it is
never copied: `.copy()` always returns an editable table the caller owns.

| Source | Who else holds its arrays after the call | The answer |
| --- | --- | --- |
| A `@tool:` pointer's table, whole or stored | the run's value store (the page-side token store, or the stored preview) | read-only, no copy |
| A fetched URL, or a fetch result by its URL | the fetch cache, and the `ml.fetch` result it was cached from | read-only, frozen at cache time |
| A fetched URL read with `raw`, `delimiter` or `header` | nobody: a parse of the cached text for this call | editable, no copy |
| A CSS selector or `current` page table | nobody: read from the DOM for this call | editable, no copy |
| A Google Sheet | nobody: a parse of the CSV the worker answered for this call | editable, no copy |
| A table value the caller passes | the caller | handed back over the caller's rows; read-only if they came from a read-only table |

- Read-only means frozen at every level (`rows`, each row, `columns`, `shape`, `dtypes`), and every `select` or `head`
  of it is read-only too, sharing rows where it can. A write throws in strict code, and in non-strict page code it does
  nothing. In the dialect a write is refused with "This table is read-only; call .copy() for one you can edit".
- `.copy()` of a stored table copies the rows in hand, not the whole stored file. Built (#2043), it keeps its
  whole-table reads, so after an edit `await c.records()` reads the source and returns the unedited cell. Slice A
  drops them ("Views of a stored table in JS"). A copy's own `select` and `head` are editable.
- In the dialect a read-only table is never script-owned. An editable one from a source nobody else holds, and a
  copy, are owned down to their rows.
- A second `ml.table` of the same source never returns an edit: a read-only table cannot be edited, and an editable
  one is read again from its source.
- The Python frame's default is not decided by ruling 89. Until its PR is specced it stays as ruling 57 put it: the
  frame is fresh, and the original is never in the namespace.

## `pd.read_csv` (ruling 71)

`pd.read_csv(src, **kw)` is served inside when `src` is one of:
- a URL in the run's fetch cache;
- a fetch result (by its URL);
- a readable `/files/` path;
- an `io.StringIO` or `BytesIO` the cell owns.

pandas parses the kept bytes, and the cell owns the frame. A URL the run did not fetch asks.

**Built:** the `/files/` path and the owned buffer (`_ml_read_csv_inside`, `python-dialect-run.ts`). The two URL sources
wait for the kept-bytes store (§10, step 3), and ask until then. As built:
- a path is normalized against the working directory. It must stay under `/files/`, lead out through no link, and name
  no compressed file (pandas decompresses by suffix). A URL of any scheme, `file://` included, and a `~` path ask.
- A separator or delimiter longer than one character asks: pandas reads it as a regular expression with the python
  engine. So do a callable `usecols` or `skiprows`.
- The input's bytes are charged to the cell's step budget before the parse (`_restricted.charge`), at 2 bytes a step, so
  a step of parse costs no less time than a step of interpreter work (on the fork core: 20.2 ns a step, 6-10 ns a byte
  parsed). So the budget bounds a loop of calls too, and a parse that cannot fit asks with nothing read: with the
  15,000,000-step budget, any input past about 30 MB. A file or buffer over the 64 MB table read cap asks.
- With `tables` loaded, the call asks. The prelude's redirect returns an injected table for any name it does not know,
  a `/files` path included, so the result might not be the file. That redirect is a defect on the full path today, and
  goes with `tables` (step 3).
- A hidden file is listed by the mount and refused at open, so an inside read raises the PermissionError a full run gets.

- **Keywords allowed:** `sep`, `delimiter`, `header`, `names`, `index_col`, `usecols`, `dtype`, `parse_dates`,
  `nrows`, `skiprows`, `na_values`, `keep_default_na`, `thousands`, `decimal`.
- **Refused:** `chunksize` and `iterator`; callable `converters` and `on_bad_lines`; `storage_options`, `memory_map`,
  `compression`, `encoding_errors`, and `engine="python"`.
- Any other keyword asks.
- A `**` spread is read through the same checker.
- An AGREE row holds this list equal to the manifest's.
- **Kept bytes:** at most 64 MB per source, the table read cap. The run's total is 256 MiB, and past it the oldest
  source is dropped. A dropped source, or one lost when the worker is evicted, makes the next read of it ask again.
- **One type per file.** In Python, `ml.table(u)` IS `pd.read_csv(<the kept bytes of u>)` with no keywords.
  - A row holds their dtypes equal, over the bench fixture and a quirk corpus: leading zeros, `$1,200`, `12%`,
    `(150)`, a blank, `N/A`, `1e3`, a date and a ragged row.
  - The JS `Table` keeps `tableFromDelimited`'s casts. A second row lists each JS-pandas difference.
- **The prelude's `read_csv` redirect to an injected frame is removed.**

## `tables` is removed (rulings 79, 87)

- `python_exec` has no `tables` and no `tableRaw` argument.
- `ml.pythonExec` (the page API) has no `tables` option.
- The loaders that resolved them go too: `_loadTable`, `workerTable`, `INJECTED_TABLES_JSON`, and the prelude's table
  branch.
- Every test, fixture and bench spec that passes `tables` is rewritten to `name = ml.table(src)` in its code.
- The model-facing text names only `ml.table`.

| Removed | The cell writes |
| --- | --- |
| `tables: "#sales"` (made `df`) | `df = ml.table("#sales")` |
| `tables: {a: src}` | `a = ml.table(src)` |
| `tables: "current"` | `df = ml.table("current")` |
| `tables: "@tool:<id>"` | `df = ml.table("@tool:<id>")` |
| `tableRaw: true` | `ml.table(src, raw=True)` |

- **Upgrade:** a saved script or a model that still passes `tables` gets the `staleTableArgs` sentence ("Page
  callers"), never a silent run without its data. `injectInputs` takes `(ns, image, harness)` and throws on a fourth
  argument, so an old caller that passes a tables map in the third place fails loudly rather than running ungated.

## What a Python cell gets (built 2026-11-24)

- **The answer** is `{ source, data }` (`TableAnswer`, `src/python/table-answer.ts`), where `data` is rows, a page's
  HTML table, a stored value or a `/files/` file.
- **Bytes cross beside the JSON.** The offscreen document reads a stored value's bytes, or a `/files/` file through the
  run's reader (so the hide rule and the secret mask apply as they do to the mount), in `tableAnswerBytes`. It decides
  a file's format by magic (Parquet, Arrow) and a delimited file's delimiter and header by the JS reader's own rules
  (`sniffDelimiter`, `hasHeaderRow`). A binary file is never decoded as text: it is `NotATable`, and so is text with no
  delimiter. A reader errno (`EACCES`, `EFBIG`, `ENOENT`) is the call's error code. The worker binds the bytes once as a
  bytearray (`bindTableBytes`, under `_ml_wbuf_<seq>`), the frame builder takes them, and they are dropped after the
  cell if it never did.
- **The frame** is built in the cell by `_ml_table_frame` (`python-runtime.ts`): Arrow and Parquet through pyarrow, a
  delimited body re-read by `pd.read_csv` with the delimiter and header already decided (so pandas cannot disagree with
  the JS reader), rows and HTML as the old loader built them. The source facts go on `df.attrs`.
- **An error answer** is an `MlError` raised at the line that called, and the cell can catch it. A source that is not
  a string, or an option of the wrong type, is a `TypeError` before any call.

### The charge

Inside the dialect a table's decode is a lifted leaf, so the interpreter counts no steps for it. `ml.table` charges the
budget itself, before the decode it pays for. The check registered with `allow_call` charges
`ceil(len(src) / ML_TABLE_BYTES_PER_STEP)` steps for the source string. The facade's synchronous call charges the same
rate on the answer's JSON (`_call_sync`, `ml-facade.ts`), which is where a rows or HTML answer's size is paid. It charges
after `run_sync` returns and before the decode, on the cell's own stack: inside `run_sync` the awaited chain runs on the
event loop, where the dialect counts nothing, so a charge made there was silently free (found 2026-11-24 by
`tests/python-table-charge.test.mjs`; two answers at the cap cost about 4,400 steps). The decode itself then runs on the
cell's stack and is counted too, a few steps a cell.
`_ml_table_frame` charges it again on the bytes of a stored value or a `/files/` file, which cross beside the JSON. A
page table's answer is bounded by `PAGE_TABLE_CAPS` (`worker-page-read.ts`: 2,000 columns, 1,000,000 rows, 4,000,000
cells, 100,000 characters a cell, 16,000,000 characters of HTML), and the charge applies up to that cap. At the HTML
cap one call costs about 8,000,000 steps, more than half the cell's 15,000,000, so two such calls exhaust the budget.
Outside a run the charge is nothing.
- **Known limit (2026-11-24): a Sheet's body is read whole.** `fetchSheetCsv` (`sw-fetch.ts`) reads the export with
  `res.text()` and no size cap before it is parsed to at most `MAX_TABLE_ROWS` (200,000) rows, with no column or cell
  cap. The charge bills what crosses to the cell, but the service worker holds the whole body first. A fetched table is
  held to the fetch cap and parsed to the same 200,000 rows. Capping the Sheet's body at the fetch cap, refused past it
  with a sentence naming the size, is its own change after this one.

- **`ML_TABLE_BYTES_PER_STEP = 2`.** It was measured on the fork core (2026-11-24, Node, best of 3). One interpreter step
  took 20.2 ns. `pd.read_csv` took 6.0 to 7.8 ns per byte for a numeric file and 8.9 to 9.7 ns per byte for a
  string-heavy one, over 0.5 to 15 MB. So one step is worth 2 to 3 bytes of parsing. The constant takes the low end,
  which charges more, not less. **Provisional:** it moves with the core, or when the decode is measured in Chrome.
- **One class leaks per cell.** The facade is built anew each cell, so `_ml_table_inside` registers `allow_kind` on that
  cell's facade class each time, and the fork's registry keeps an entry for each. Nothing bounds that within a
  worker's life but the number of cells it runs. Building the facade class once per worker removes it; not done here.
  A facade kept from an earlier cell is refused with nothing sent, and the next cell's own facade reads normally
  (`tests/redteam-python-table.test.mjs`, "a facade kept from an earlier cell never reaches the wire in the next").

## What a table keeps of its source

- The bytes are the original, and a table is a view of them.
- `raw=True` keeps every cell a string. `delimiter` and `header` override the reader's discovery.
- `t.attrs["source"]` names the bytes. The byte-exact copy of them is `ml.fs.cp` ("Writing files").
- The bytes themselves are not handed to the cell. They cross once, the frame is built from them, and they are let go,
  so the heap never holds both: a frame already costs about 2 bytes per source byte, and a second copy of the bytes
  would move the materialise cap. A cell that needs them byte for byte copies them with `ml.fs.cp` and reads the file.

## A fetched table (rulings 82, 83)

- A CSV fetch keeps detection and a summary computed from a bounded prefix: the first 64 KB, plus a newline count of
  the rest for the row total. It does not parse the whole body.
- The full parse runs only on `ml.table`, or when the JS `.table` getter is read.
- The fetch result says in words that the table is not the full table, and names `ml.table("<url>")` as the way to
  read all of it.
- Dtypes in that summary are labelled a guess from the first N rows. The label names the call that gives exact types:
  `ml.table(url)` for every row, or `ml.table(url, raw=True)` to keep every cell as text. `ml.table`'s own dtypes
  come from the whole file.
- When the JS `.table` getter is built, the table it parses is frozen on the getter's first read, not in `cacheCopy`.
  Freezing at cache time would read the getter, and so force the full parse this section defers.

## Money columns (ruling 85)

- A column is read as `decimal128` only when the cell names it (`decimal=["amount"]`) or its header names a currency.
  Decimal places alone are never enough.
- Every other numeric column is float64, and its sum is labelled float.
- The summary says which columns were read as decimal, and why.

## Writing files (rulings 69, 75, 76, 81, 86)

**Layout, errno, quota and commit belong to [`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md)** (session-store, #1999's
slice 1): `filesQuotaMB`, commit on close, and the place-by-place errors. This section names which calls may write, and
where.

- **The model's writable folder is `/files/agent/`** (ruling 86: "every model has `/files/`, it's like the home
  directory"). Write, overwrite, `rm` and a rename are free there, inside the dialect too. The rest of the layout
  (subfolders, the read-only rest of `/files/`, relative paths, `ml.fs.cp`'s destination) has one home:
  [`FILE_ATTACHMENTS.md`](FILE_ATTACHMENTS.md), "The layout".
- **The members that write, inside the dialect,** are each a manifest leaf `writes(path arg)`, with the path checker:
  - pandas: `DataFrame.to_csv`, `to_parquet`, `to_json`, `to_feather`, `to_pickle`, `to_html` and
    `to_string(buf=…)`, and `Series.to_csv`.
  - numpy: `save`, `savetxt` and `savez`.
  - Pillow: `Image.save`.
  - pyarrow's `parquet.write_table`, through the lazy table only.
  - `ml.fs.writeFile`, `cp`, `rename` and `rm` (`ml.fs` has Node's `rename`, not `mv`; the coordinator, 2026-11-20).
  Every admitted writer is a row in the ENUMERATED path-and-buffer test, probed or given a reason.
- **Not admitted:**
  - A restricted `open()`. The path is checked at `open`, but a handle kept under another name writes later, from a
    later cell, with no path on the call.
  - `to_excel`, `to_latex`, `to_markdown` and `to_xml`: their optional dependencies are missing.
  - `ndarray.tofile` and `shutil`.
- **Reading a pickle runs code.** `pd.read_pickle`, `np.load(…, allow_pickle=True)` and `pickle.load` stay refused
  inside, on any path, each with a row.
- **The path checker runs before the call.**
  - It is a lifted `allow_call` entry check. It reads the path by keyword, by position, through `*` and `**`, and
    from a bound method held in a name.
  - It normalises the path lexically, with `/` as the session root and `..` stopping there.
  - It admits a write, `rm` or a rename only when every target is under `/files/agent/`. It refuses anything else under
    `/files/`, a hidden-list name included (ruling 34): a hidden file is refused, never asked about.
  - A path it cannot normalise asks.
  - A C method with a path argument is not listed.
  - The offscreen document re-checks every write, and it is the boundary.
- **An inside attempt** commits its closed files only if the attempt succeeds. A refusal or a failure aborts them, as
  its namespace rolls back (the coordinator's call under ruling 75).
- **A fetch to a file:**
  - `ml.fs.cp(<fetch result or pointer>, "/files/agent/x.csv")` copies the kept bytes, byte for byte, from the value
    store. No byte crosses the cell.
  - Writing a value marked `truncated` with a library writer is refused, with a message naming `ml.fs.cp`.

## Tables too large to load (rulings 72, 84)

- **The engine is pyarrow** (already shipped), in the cell's worker. It reads by range through a file-like over
  `/files/` or the fetch cache's value store, so a file is never loaded whole.
- **A large CSV is converted once to Parquet** in `/files/agent/` and queried there. Parquet scans stayed within
  24 MiB of baseline on 11.7 million rows. A CSV groupby did not: it reached 443 MiB.
  - **Conditional.** The conversion's own memory bound is unmeasured: the writer reached 745 MiB at 16 MB blocks, and
    a small block size was not tried. Until it is measured, a CSV past the materialise cap is answered with pandas
    `chunksize` (130-155 MiB at 200,000 rows) or refused. The measurement is owed before the lazy-table PR, and that
    PR does not convert without it.
- **The lazy table answers in one pass:** `shape`, `columns`, `dtypes`, `head`, column selection, a filter of
  column-operator-literal, `groupby` with sum, count, min, max or mean, `value_counts`, and a merge against a small
  table.
  - Groups are capped at 100,000 (`LAZY_GROUP_CAP`). **Provisional:** chosen, not measured. It moves when a groupby's
    partials are measured per group on the 11.7-million-row file under the fork's cap.
  - `to_pandas()` is refused past the materialise cap, with the size in the message.
- **Refused, with the reason and what to do:** sort, a join of two large tables, an exact quantile, and an exact
  distinct count past the cap. An approximation exists only under a name that says so (`approx_quantile`).
- pyarrow is never admitted to a cell. The lazy table is window-ml's class, so `PyFileSystem` stays unreachable.

## Views of a stored table in JS (Shane, 2026-11-20)

The JS `Table` over a stored value reads only what a call asks for, and the worker decodes the stored bytes once.
This is not the Python lazy table above: that one is pyarrow in the cell's worker, and this one is the JS facade's
pushdown to the service worker. Shane agreed the direction in the python-packages session; the coordinator recorded
it and owns the order: this spec, then slice A, then slice B.

Today a stored table's `col`, `select`, `records` and a long `head` each re-parse the whole stored body in the worker
(`storedColumns`), and ship every row of the named columns to the page, up to `MAX_STORED_READ_CELLS` (5,000,000).

### Shared by both slices

- **The stored form does not change.** The value store keeps the bytes as they arrived (POINTER_VALUES slice 7), because
  `ml.fs.cp` copies them byte for byte and Python's `pd.read_csv` parses them (ruling 71). The stale line in
  `value-store.ts` ("Tables become Arrow IPC in a later slice") is corrected in slice A.
- **The decode is a cache.** The worker decodes a stored table once into an Apache Arrow table (`apache-arrow`,
  already a dependency, loaded on demand by `table-data.ts`), with the delimiter and header decisions the preview
  made, and keeps it in memory.
  - It is marked `// state: cache` beside its Map. It is derived from the store, so losing it loses nothing but time.
  - It is keyed by the blob's SHA-256 and the decode options, so a message's options change only its own read, never
    what another session sharing the blob reads.
  - It dies with the worker (MV3 eviction, about 30 s idle; `docs/dev/state.md`). The next read decodes again from the
    store: a full parse, up to `FETCH_TABLE_MAX` (64 MB) of CSV.
- **Ruling 75's one store is the shelf** (`/files`), and a stored table is not in it: the value store holds fetched and
  returned values, and the shelf holds files. Neither is copied into the other. A `/files/` source is refused by
  `ml.table` today; when it is admitted it reads through the shelf's ranged reader, and is not a view source in
  either slice.
- **A view whose source is gone** answers the store's `ValueMissing`, with the tombstone's reason and "fetch it again",
  exactly as a stored read does today. The rows already in hand on the page stay.
- **A view is a plan held on the page, and nothing is held for it in the worker.** Each read sends the whole plan:
  `{ key, delimiter?, headerless?, columns?, where?, limit?, want }`. The worker runs it from the source's decode and
  answers only what `want` names.
- **Authority.** A plan arrives from a page as data.
  - The worker checks every field against a closed shape: an unknown field, a wrong type or a size past the bounds below
    is refused. Nothing in the plan is code.
  - The key is a name, not an entitlement. The worker reads it only through `VALUE_COLUMNS`'s four gates
    (`background.ts`):
    1. the sender's page is approved to use window.ml now;
    2. the value was disclosed to the sender tab's page session, or the run is one of this tab's active runs;
    3. for a run, the value's holders include it;
    4. for a run, the key was named by that run's in-flight approved call (`execReads`).

    A plan cannot name another run's table, because no message field decides whose it is.
  - The brand is not the check. It tells the dialect what an object is; the worker never sees it.
- **Bounds.**
  - The source: at most `FETCH_TABLE_MAX` (64 MB) of bytes, inside `valueStoreBudgetMB` on disk.
  - The decode cache: at most 256 MiB of Arrow buffers (`TABLE_DECODE_CACHE_BYTES`), least recently read first out. A
    decode larger than the cache serves its one read and is not kept. **Measured** in slice A
    ([`decode-cache.ipynb`](../../notebooks/tables/decode-cache.ipynb), in Node's V8, not the service worker): a 64 MB
    CSV decodes to 58 to 90 MB, so the cache holds two to four of the largest. The parse peaks at least 0.6 to 1.2 GB
    over the RSS before it, a lower bound because that RSS (285 to 903 MB) holds the generator's garbage; every stored
    read paid it before slice A. The peak in the real service worker is a separate measurement, not slice A's.
  - `table-data.ts`'s `MAX_TABLE_ROWS` (200,000) caps the preview a fetch keeps, not the stored table, which has no
    row cap of its own. `dom.ts` has its own `MAX_TABLE_ROWS` (5,000), for a page table, which is never stored.
  - A view's rows in hand are never more than its source's rows in hand. A whole read (`col`, `records`) answers at
    most `MAX_STORED_READ_CELLS`, and past it is refused with the count, as today. In the dialect, a script's stored
    reads also count against `MAX_STORED_CELLS`.
  - A plan's own size: at most 16 `where` clauses, at most the table's own columns, an `in` list of at most 1,000
    values, and a string literal of at most 1,000 characters. The plan is flat, not a chain, so its depth is constant.
    The page throws at the 17th `where` with the count, and the worker re-checks every bound. A chain of 10,000
    `where`s stops at the 17th.
- **Python** reads the stored bytes from the value store and parses them with pandas in its own worker (ruling 71); it
  never reads the service worker's decode. The Python member is specced against the store, not the decode, so slice A
  need not precede it.
- **`.copy()` of a view, or of a stored table, drops the plan.** It copies the rows in hand, and keeps `shape` and
  `truncated`. It never reads. The copy is editable (ruling 89), and a plan kept on it would answer a whole read from
  the source, unedited, so a whole read on a copy past its rows in hand is refused, with text naming the source's
  `records()`. A view larger than the cell cap gives a copy marked `truncated`, with `shape` saying how many rows the
  view has. Every row is a whole read on the view (`await v.records()`), and past the cap that read is refused with the
  count. This changes #2043's copy of a stored table, which kept its reads; slice A carries the upgrade row below.

### Slice A: decode once; `select` and `head` become views

- Every stored read runs on the decode cache instead of re-parsing the body.
- **`select` of a stored table is a view, and synchronous.** Choosing columns does not change rows, so the source's
  preview, narrowed to those columns, is exactly the view's first rows.
  - `rows`: the source's rows in hand, narrowed to the selected columns.
  - `rows.length`: what it is on the stored table, the rows in hand.
  - `shape`: `[the source's row count, the selected width]`; `truncated` when the two differ.
  - Its `col` and `records` are requests, pushed down with `columns`, and return only the view's columns.
- **`head(n)` of a stored table:**
  - Within the rows in hand, it stays what it is today: a synchronous, whole table.
  - Past them, it is a view with `limit: n`, its rows those in hand, `shape[0]` the smaller of `n` and the source's
    row count. Its `col` and `records` are requests that return n rows at most.
- **What changes for a caller.** `t.select(names)`, and `t.head(n)` past the rows in hand, used to return a promise of
  every asked row. They return the view now, and `(await t.select(names)).rows` is the rows in hand, with no error.
  A sum over `rows` is then a sum over a sample.
  - `await` still works, because a view is not thenable.
  - What tells the caller: `truncated` is set, and `shape[0]` exceeds `rows.length`. The JSDoc and the model-facing
    text of `ml.table` and the facade say that `rows` is the rows in hand and that every row is
    `await v.records()` or `await v.col(name)`.
  - A copy's whole reads go too (above): `await t.copy().records()` past the rows in hand is refused.
- **Upgrade rows** (the rule for changing a rule). Each runs a script written for the old result on the new code, over
  a stored table larger than its rows in hand, and asserts what the model sees:
  - `(await t.select(["a"])).rows`: the rows in hand, `truncated` true, `shape[0]` the whole count;
  - `(await t.head(n)).rows` for n past the rows in hand: the same;
  - `await t.copy().records()` past the rows in hand: refused, with the text naming `t.records()`.
- **The dialect:** no new method. `select`, `head`, `col`, `records` and `copy` are the existing list
  (`policy.ts`). A view is stored for `isStoredTable` and the cost charge, so its reads count `shape[0]` × width.
- **e4's set for slice A:** a forged view; a view whose plan was edited after it was made; a view naming another run's
  or tab's key; a plan field outside the closed shape; a `select` of a column the source lacks; the cost charge on a
  view, read through every binding form.

### Slice B: `where`

- **`t.where(column, op, value)`**, and `where(column, "isnull")` or `"notnull"` with no value. Successive `where`s are
  ANDed. OR is spelled `"in"`.
- **On a table whose rows are all in hand** (a page table, a fetched table under its preview cap, a copy), `where`
  runs on the page, synchronously, and returns a table under the same rules as below. No message is sent.
- **On a stored table or a view of one, `where` is a request** (a promise, with the missed-`await` hints that
  `request` gives today). It scans once in the worker and resolves to a view:
  - `rows`: the result's first rows, at most as many as the source had in hand.
  - `shape[0]`: the exact count of matching rows; `truncated` when it exceeds `rows.length`.
  - `rows.length`: the rows in hand, as on any stored table.
  - `select` and `head` of the result are views as in slice A, and `col`, `records` and a further `where` are
    requests carrying the plan.
- **`where` after `head`** of a view whose rows are not all in hand is refused with "filter first, then head". A plan
  applies its filters before its limit, so the other order cannot be expressed.
- **Order.** `where` and `select` keep source order, and `head` after `where` is the first n matching rows.
- **Semantics.** There is one rule for a value of the wrong type: refuse, never coerce.

  | op | column dtypes | value | a null cell | a NaN cell |
  | --- | --- | --- | --- | --- |
  | `==`, `!=` | any | the column's kind: number for `int64`/`float64`, string for `str`, boolean for `bool`; for `object`, any one of those, and a cell of another kind never matches | `==`: no match. `!=`: matches (ruling 92, below) | is null |
  | `<`, `<=`, `>`, `>=` | `int64`, `float64`, `str`; `object` compares only cells of the value's kind | number or string as above; never boolean | no match | is null |
  | `in` | any | a list of 0 to 1,000 values, each obeying the `==` rule; an empty list matches nothing | no match | is null |
  | `isnull`, `notnull` | any | none | matches `isnull` | matches `isnull` |

  - **`!=` on a null cell matches (Shane, ruling 92, 2026-11-20).** `where(column, "!=", x)` keeps a row whose cell is
    null or NaN, the pandas rule (`NaN != x` is true), because the Python member reads the same table as pandas. Every
    other op keeps SQL's rule, no match on a null cell. `in` is one of those, and there is no `not in`.
  - **Integers past ±2^53.** The page holds doubles, and the decode holds an `int64` column's 64-bit integers.
    - A number value must be a safe integer (`Number.isSafeInteger`) against an `int64` column, or it is refused;
      a BigInt is accepted, for any 64-bit value.
    - The worker compares exactly, in 64 bits.
    - On the page, a table whose rows are all in hand holds doubles already, as today's casts make them, and compares
      those.
  - A number never matches a numeric string, in either direction. `where("price", ">", "100")` on a `float64` column is
    refused, and the error names `where("price", ">", 100)`.
  - Strings compare by Unicode code point (UTF-8 byte order), on the page and in the worker alike. JS `<` on strings
    is UTF-16 order, so it is not used.
  - `bool` takes only `==`, `!=` and `in`.
  - A value of NaN, `undefined`, an object or a function is refused.
  - An unknown column is refused with the columns listed (the `NotATable` text `select` uses).
  - An unknown op is refused with the list of ops.
- **The dialect:** `where` is a new method on a table (`policy.ts`'s `table` list). It gets the adversarial rows and
  the whole-contract re-check (`docs/dev/readonly-exec.md`, "The rule for extending the dialect"), and e4 writes them.
  They cover each op against each dtype, the value kinds that are refused, a callback, a string that looks like code,
  bound size, the chain, and the cost charge.

### Evidence and what waits

- The verb counts behind the proposal are a regex over 4,771 bench `run.json` files. Those runs predate `ml.table`,
  and the regex also matches DOM-row code and Python's `head()`, so the counts bound nothing. They showed `rows`,
  `rows.length`, `rows[...]` and `col` in use, and `select`, `sort`, `groupBy` and `where` at zero.
- So `where` is slice B, not slice A. Slice A adds no verb and no dialect method, and it changes what `select`, a
  long `head` and a stored table's copy return (Slice A, "What changes for a caller"). It is built for memory: the
  decode once, and no whole column shipped for a `select`.
- `sort`, `groupBy(...).agg(...)`, and slice B itself, wait on the sweep: ruling 64's, frozen until `ml.table`
  lands, as the coordinator scoped it. They are built if that sweep shows models filtering or ordering a stored
  table in JS, rather than handing it to `python_exec`.
- **Out of scope:** an index, `loc`/`iloc`, `apply`, mutating methods and `merge`. A pandas name the table does not
  answer to keeps today's error naming the nearest verb. Heavy editing goes to `python_exec`, where pandas 3 has
  copy-on-write.
- **Rejected engines:**
  - SQLite-wasm stores rows, and is the archive's engine: the wrong shape for scanning columns.
  - Arquero compiles expression strings with `Function`, which the dialect forbids.
  - Danfo.js is pandas in JS and pulls in TensorFlow.

### A page-side cache per pointer

A background-hosted run answers `dereference` by message, so the page pays a structured clone of the preview on every
call. A cache on the page is feasible: a pointer's value never changes once minted, so the cache needs a bound and a
drop when the run ends, and no invalidation. It would be keyed by run and pointer id, closure-private in the injected
script, least recently used out under a cell bound, and marked `// state: cache`. It holds only what was already
disclosed to that page. It is not in either slice; the coordinator queues it.

## Manifest data (rulings 55, 56)

- `ml.table`'s row:
  - `effects`: "reads-external when the source asks; pure otherwise";
  - `returns`: `fresh`;
  - `inside.source`: the table above;
  - `inside.keywords`: `raw`, `delimiter`, `header`, `decimal`.
- `pandas.read_csv`'s row carries the keyword lists above.
- Each writer carries `writes(path arg) when the path is under /files/agent/`
  ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md), "Effects").
- The checkers are generated from these fields, and an AGREE row holds each generated list equal to its manifest.

## Red team (rule 10)

What a hostile page must not get through `ml.table`:
- a table of another tab, origin or frame;
- an unapproved Sheet, through a computed id or a JSON-in-a-string map;
- an egress through a URL;
- a credentialed read;
- another run's cache or stored value;
- a forged table brand;
- a cell that carries code;
- an unbounded output;
- an argument-proportional cost with no check;
- the member from an unapproved origin.

For files, e3 attacks:
- `..` past the root;
- `attached/` by every spelling;
- a write, `rm` or rename outside `/files/agent/`, including a rename out of it;
- a hidden name;
- another session's path;
- a link;
- a write over quota;
- a write followed by a refusal in the same attempt;
- each writer by every binding form;
- a path made by a library callback.

## What the model reads

- `python_exec`'s description loses "Your inputs are ALREADY loaded …", "No network or filesystem here", the `tables`
  text and the `current` hint.
- It gains one line: `t = ml.table(src)` reads a page table, a fetched URL, a Sheet or a pointer;
  `pd.read_csv(<fetched url>)` works; and `/files/agent/` is the model's own folder.
- `fetch_url`'s and `tablePreview`'s pointers to `tables` name `ml.table` instead.
- A bench arm on `csv-total` measures the change, before and after.
- A prompt review follows ([`docs/dev/prompt-review.md`](../dev/prompt-review.md)).
