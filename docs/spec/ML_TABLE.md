# Spec: `ml.table`, a cell reads its own tables

**Status: specified, not built (2026-11-19).** The design note, with every measurement behind these rules, is
[`docs/plan/repl/ML_TABLE.md`](../plan/repl/ML_TABLE.md). This file holds the rules; where another spec owns a line, it
is pointed at, not restated. Shane's rulings: 55, 56, 57, 68 to 72, 75 to 87 (2026-11-19, in the coordinator's
session, recorded in [`docs/plan/repl/README.md`](../plan/repl/README.md)).

## The member

`python_exec` injects no table. A cell asks for its data itself, and every value in its namespace is one it made and
owns (ruling 68).

- **Python: `t = ml.table(src, raw=False, delimiter=None, header=None, decimal=None)`**, a synchronous call (ruling 77).
  - The facade blocks on the wire answer through JSPI (`pyodide.ffi.run_sync`), with no fork change and no `Await`
    node. The spelling is the same inside and outside the dialect.
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
- **The rule runs at call time, on the resolved value,** whether the code named it as a literal or computed it.
- **A literal scan only hoists.** It finds the `ml.table("…")` sources in the code, so the card can show them above
  the code and an approval can grant them up front. In JS this is the `fetchUrlLiterals` pattern; in Python it is an
  `ast` pass.
- **Inside the dialect,** a source that needs the person raises `NotInDialect` at the bridge. The call goes to the
  person, and the approved rerun has the hoisted grants.
- **In an approved cell,** a source the card did not hoist gets a nested ask on the running step ([`ML_WIRE.md`](ML_WIRE.md),
  "Per-call asking"). A refusal is an error raised in the cell. An approval goes into the same store the hoisted
  literals use, so a later read of that source is free.
- **A cell's fetch** is judged as `fetch_url`'s is: `judgeCall(runId, "fetch", fetchFacts(url, mode))`, plus the run's
  origin grants and its consented set.

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
  directory").
  - The model may make subfolders there.
  - Write, overwrite, `rm` and `mv` are free there, inside the dialect too.
  - Everything else under `/files/` is the person's, and read-only to the model.
  - A relative path resolves against `/files/agent/`.
  - `ml.fs.cp`'s destination must be under `/files/agent/`.
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
  - It admits a write, `rm` or `mv` only when every target is under `/files/agent/`. It refuses anything else under
    `/files/`, and asks for a hidden-list name (ruling 34).
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
    decode larger than the cache serves its one read and is not kept. **Provisional:** chosen, not measured. Slice A's
    PR measures the decode of the 64 MB CSV in the worker (Arrow buffer bytes and peak heap), commits the figure, and
    sets the constant from it.
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
- a write, `rm` or `mv` outside `/files/agent/`, including an `mv` out of it;
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
