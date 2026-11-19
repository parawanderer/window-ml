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

## Ownership (ruling 57)

- The frame or `Table` that `ml.table` returns is fresh, and so is everything derived from it. An edit to it runs
  inside, with no card.
- The original is never in the namespace. That is the page's DOM, the fetched body in the run's frozen fetch cache,
  the stored value, or the file.
- A second `ml.table` of the same source parses the original again, so a re-read never returns the cell's edits.

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

## A fetched table (rulings 82, 83)

- A CSV fetch keeps detection and a summary computed from a bounded prefix: the first 64 KB, plus a newline count of
  the rest for the row total. It does not parse the whole body.
- The full parse runs only on `ml.table`, or when the JS `.table` getter is read.
- The fetch result says in words that the table is not the full table, and names `ml.table("<url>")` as the way to
  read all of it.
- Dtypes in that summary are labelled a guess from the first N rows. The label names the call that gives exact types:
  `ml.table(url)` for every row, or `ml.table(url, raw=True)` to keep every cell as text. `ml.table`'s own dtypes
  come from the whole file.

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
  - `ml.fs.writeFile`, `cp`, `mv` and `rm`.
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
- **The lazy table answers in one pass:** `shape`, `columns`, `dtypes`, `head`, column selection, a filter of
  column-operator-literal, `groupby` with sum, count, min, max or mean, `value_counts`, and a merge against a small
  table.
  - Groups are capped (proposed 100,000).
  - `to_pandas()` is refused past the materialise cap, with the size in the message.
- **Refused, with the reason and what to do:** sort, a join of two large tables, an exact quantile, and an exact
  distinct count past the cap. An approximation exists only under a name that says so (`approx_quantile`).
- pyarrow is never admitted to a cell. The lazy table is window-ml's class, so `PyFileSystem` stays unreachable.

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
