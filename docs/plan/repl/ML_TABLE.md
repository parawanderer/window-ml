# `ml.table`: a cell reads its own tables (design note for ruling 68, 2026-11-19)

Written by packages (session `19f583d1`, `claude-opus-5-5`) for Shane, through the coordinator (repl-specs). NOTHING here
is built; nothing is built from it until Shane rules on this note. Rulings 69 (item 7), 70 (item 2), 71 (item 4),
72 (item 12), 75 (item 7, the commit point) and 76 (item 7, the quota) are already Shane's and are written as settled.
Every other item ends in a recommendation.

Each claim is marked:
- **[code]**: read from the code at main 293e3bf7, with the place.
- **[measured]**: run, with the script in the lane's scratchpad (mtable/, mpandas/, marrow/, mjspi/).
- **[guess]**: neither.

## Decisions for Shane

| Question | Recommendation | Item |
| --- | --- | --- |
| How a cell waits on `ml.table`: the fork's `Await`, or a synchronous call over JSPI | JSPI: `t = ml.table(src)` works on the pinned core with no rebuild (measured in Node; Chrome still to measure) | 1 |
| What a Python cell gets: ruling 68's TableLike, or a pandas DataFrame | a DataFrame: the JS facade has four methods, less than the model has now | 1 |
| `tables` on `python_exec` (and `ml.pythonExec`'s option): removed, or kept as shorthand for `name = ml.table(src)` | kept as shorthand: it injects nothing, and 623 of 647 table-fetch runs use it | 5 |
| A computed Sheet in an approved cell, which the card did not hoist | a nested ask on the running step, its card naming the resolved id | 2 |
| `ml.fs.rm`, `mv` and an overwrite, unasked | free only for a file this run made; otherwise ask; `attached/` refused. A restorable `rm`: three sub-questions | 7 |
| A fetch parses its whole table eagerly | detection and a prefix summary in the fetch; the full parse only on `ml.table` or `.table` | 11 |
| Dtypes in that summary, taken from a prefix | label them "from the first N rows" | 11 |
| The engine for tables past the cell's memory cap | pyarrow 22 (already shipped); a large CSV is converted to Parquet first | 12 |
| Money columns read as `decimal128` by inference | only when the cell names the column (`decimal=[...]`) or its header names a currency; never by decimal places alone | 12 |

## What ruling 68 changes

Today `python_exec`'s `tables` argument is resolved BEFORE the cell runs, by one of two loaders (the page's
`_loadTable`, `src/ml/ml-python.ts:144`; the worker's `workerTable`, `src/sw/worker-tools.ts:353`), and the rows are
injected into the namespace as `INJECTED_TABLES_JSON` (`src/python/python-runtime.ts:49-54`, prelude :90-134) **[code]**.
After ruling 68 the cell asks for its data itself, `t = await ml.table("#sales")`, so every value in the namespace is
one the cell made and owns, and the same member exists in JS.

## 1. The await bridge, and a page-built run

- **The bridge exists.** `ml` inside Python is a facade over the `ml` wire (`src/python/ml-facade.ts:28-120`,
  `docs/spec/ML_WIRE.md`): a cell's call posts `{seq, call, args}` from the Pyodide worker (`makeWireSend`,
  `src/python/python-worker.ts:74-92`); the offscreen document stamps the client and relays `ML_CALL`; the service
  worker answers from `membersFor` (`src/sw/sw-ml-wire.ts:46-66`), which is `ML_READONLY_METHODS` plus `sh.*` for a
  full client **[code]**. `docs/dev/python-sandbox.md:661` still says "not yet wired"; that sentence is stale.
- **But no read-only cell can await today.** The dialect's node list has no `Await`
  (`notebooks/python-dialect/data/whitelist.json`), and the fork's `run_cell` (pinned `Lib/restricted.py:160`) is a
  synchronous exec with no top-level-await compile flag **[code]**. So "the dialect allows an await of `ml.table`" is a
  FORK change and a core rebuild: `run_cell` compiles with `PyCF_ALLOW_TOP_LEVEL_AWAIT` and drives the coroutine on the
  cell's loop, and the membership pass admits an `Await` node only when its value is a call whose callee is an
  attribute of the facade `ml` (the name bound by the harness, never a rebinding). Every other await stays out.
- **The alternative needs no `Await` node: a synchronous `ml.table(...)` over JSPI.**
  - The pinned core has `pyodide.ffi.run_sync` and `can_run_sync`. They are marked experimental, and they work when
    JS Promise Integration is on and the stack was entered through `runPythonAsync`, which is how every cell runs
    (`_pyodide/_core_docs.py:1689` in the core's stdlib) **[code]**.
  - Measured on the pinned core in Node 26, where JSPI is on by default (mjspi/jspi.mjs): `can_run_sync()` is True. A
    harness callable registered with `_restricted.allow_call` that calls `run_sync(<coroutine>)` returned its value
    from inside `restricted.run_cell` **[measured]**.
  - So the facade's `ml.table` can block on the wire answer and return the frame, and a cell writes `t = ml.table(src)`
    with no rebuild.
  - What is not measured: Chrome's offscreen worker (JSPI ships enabled in current Chrome **[guess: not checked against
    the pinned Chrome]**); the dialect's step budget and wall clock while suspended; and whether other webloop tasks
    run during the suspension and can see the half-run cell (`spend-queue.ts:4` notes JSPI queues Python a second
    time).
  - **Recommendation: JSPI, after those three are measured in Chrome.** It needs no fork change and no Await rule, and
    the facade gives one spelling inside and outside the dialect. Ruling 68 wrote `await ml.table`; under JSPI,
    `await` is refused inside and harmless outside only if the member also returns an awaitable, so the spelling is
    part of this decision.
- **Size.** A wire answer over `WIRE_VALUE_CAP` (1 MiB, `sw-ml-wire.ts:27`) comes back as a pointer **[code]**.
  Recommendation: `ml.table` answers with the table's bytes in the value store (the route `injectStoredTable` already
  uses, `python-runtime.ts:918`), read into the cell as `bytes`, never as a JSON row list.
- **What a Python cell gets: a question for Shane.** Ruling 68's words are "it returns a TableLike, not bare rows". The
  recommendation departs from them: **a pandas DataFrame**, built in the cell from those bytes, so it is fresh and owned (item 3)
  and is the pandas the model already writes. The JS `Table` facade has four methods (`col`, `select`, `records`,
  `head`; `contract-fetch.ts:135-145`) and refuses everything else with a pointer to `python_exec`
  (`table-data.ts:626-639`) **[code]**: handing Python that facade would give the model LESS than it has now. The
  source facts the facade carries (`delimiter`, `truncated`, `headerless`, the source) go on `df.attrs`. Past the
  materialise cap the answer is the lazy table of item 12 instead.
- **`await ml.fetch(url)` and `await ml.table(...)` in Python are packages' to build** (owners set 2026-11-19). On main
  the wire serves no live fetch: gated members "come with the consent path" (`sw-ml-wire.ts:40-41`) **[code]**.
- **The consent path for a cell's fetch is fetch_url's, unchanged.**
  - The URL is judged by the same function and the same facts: `judgeCall(runId, "fetch", fetchFacts(url, mode))`,
    the run's origin grants, and its consented set (`worker-tools.ts:172-176`, :222-230) **[code]**.
  - So a policy that lets fetch_url read a URL lets a cell read it, and one that asks or denies does the same.
  - Inside the dialect: a cached URL, or one a policy allows, is served. Anything that asks raises `NotInDialect` at
    the bridge, and the whole call goes to the person, with the literal URLs hoisted on the card (item 2).
  - In an approved cell: a nested ask on the running step. `grantRunPython` already carries the step "its `ml` calls'
    asks are shown there" (`worker-tools.ts:178-181`).
  - A fetched result enters the run's fetch cache exactly as a fetch_url result does, so `ml.table(url)` and
    `pd.read_csv(url)` find it afterwards.
- **A page-built run** (`ml.pythonExec` from a page script, stateless) opens a wire client too (`src/sw/sw-python.ts:275`,
  `run: null`) **[code]**, so `ml.table` exists there with the same rule; what it cannot have is a run's fetch cache.
  Whether `ml.pythonExec` keeps its `tables` option is part of item 5's question. The recommendation is to keep it,
  as item 5's shorthand, because a page script is the one caller that already holds its data.

## 2. The approval rule (ruling 70, settled)

A source given to `ml.table` is judged exactly as a source in `tables` is today **[code]**:

- A selector, `current` on a page with a table, or an `@tool:` table pointer is free: a read-only read of the page or
  of the run's own values. `current` on a Sheet page reads that Sheet.
- An external Google Sheet asks, every time, until the person approves it; then it is free for the rest of the run
  (`approvedSheets`, `src/sw/sw-run-host.ts:1925`). `externalSheetIds` (`src/dom/dom.ts:1237`) finds the Sheet ids in
  `args.tables`, decoding a JSON-string map and walking nested values to depth 8, and `autoApprovePython`
  (`src/agent/auto-approve.ts:22-36`) asks when any is unapproved.
- An http(s) URL is read only from the run's fetch cache, and never fetched (`worker-tools.ts:382-387`): a cache hit
  is free, because the person already approved that fetch. A miss is an error today.
- The approval card hoists the sources above the code (`externalSheetGrant`, `sidebar/transcript/agent-detail.tsx:213`).
- **A fetch result is a source** (ruling 68's own example, `ml.table(ml.fetch(<a csv>))`), with this note's
  recommendation for how:
  - It is judged and read by its URL alone: `ml.table(r)` is `ml.table(r.url)`, so a fetch made in the same cell is
    then a cache hit.
  - Its `.text` and `.table` are never read as the source. They may be a truncated view (`valueKey`), and in a cell
    they are the cell's own dict, which could carry any URL beside any text. Reading by the URL takes the whole kept
    body (ruling 71), and a dict naming a URL the run never fetched gets the same ask as that URL.
  - In JS the same holds for a `FetchResult` object, whose `url` field is the source.

What changes is WHERE the source is. In `tables` it is a value in the tool's arguments; in `ml.table` it is an
expression in the code. The coordinator's reading is correct, with one correction:

- **The rule runs at call time, on the resolved value.** The awaited call reaches the wire carrying the source as data,
  and the member applies the rule above to that value, whether it was a literal or computed. This is already how the
  worker re-checks a sheet at load (`ctx.pyCall.sheets.has(id)`, `worker-tools.ts:364-366`).
- **The scan only hoists.** A literal scan of the code finds `ml.table("…")` sources, so the card can show them above
  the code, and an approval can grant them up front. JS already has this scan for `ml.fetch` (`fetchUrlLiterals`,
  `src/sw/grant-extract.ts:45`, acorn, static strings only). Python needs its own, an `ast` pass in the sandbox. Both
  feed the same list `externalSheetIds` feeds today.
- **The correction:** today's scan is not "the code is scanned for the table references it names". It reads only
  `args.tables`, and it collects only Sheet ids. Selectors and URLs are never flagged, because they never need to be.
  There is no second scan to avoid building. The new piece is the literal pass. Without it a card could not show a
  source named only in code.
- **A mid-cell ask.**
  - In a cell running inside the dialect: no. A source that needs approval raises `NotInDialect` at the bridge. The
    cell's output is discarded and the whole call goes to the person, as any refusal does today
    (`tryPythonInside`, `sw-run-host.ts:1124-1145`). The approved rerun has the card's hoisted grants.
  - In an approved (full) cell: possible, and there is a precedent. `ml.sh` raises a nested ask on the running step
    (`sw-asks.ts`, `src/sw/sw-shell-call.ts:6-7`), and the wire waits on it.
  - Recommendation: a computed Sheet the card did not hoist gets that nested ask, its card showing the resolved id.
    Otherwise a computed source could never be approved at all.
- **A URL not in the run's fetch cache** asks (ruling 37's network gate). It never fetches unasked.

## 3. Ownership, and "the original" (ruling 57)

- **The cell owns what it gets.** The frame `ml.table` returns is built in the cell from bytes, so it is marked fresh,
  and so is everything derived from it. An edit to it (`t["x"] = …`, `t.sort_values(inplace=True)`) runs inside with
  no card. This is ruling 68's point: no injected, unowned value is left to protect.
- **"The original" is never in the namespace.**
  - For a page table, it is the page's DOM. `ml.table` reads it through `extractTable` (`src/dom/dom.ts:1168`) into
    new bytes, so nothing a cell does reaches the page.
  - For a fetch, it is the fetched body in the run's fetch cache (frozen, `cacheCopy`, `src/ml/fetch-result.ts:79`).
  - For a pointer, it is the stored value.
- **A second `ml.table` of the same source returns a new frame, parsed again from the original** (ruling 57: the
  original is never modified, only a copy). That also settles the loader-redirect question ruling 57 left open: a
  re-read returns the original, not the cell's edited frame.

## 4. `pd.read_csv(<source>)` (ruling 71, settled: option A)

`pd.read_csv(src, **kw)` stays served. When the run already fetched `src`, pandas parses the kept bytes, and the cell
owns the frame. A URL the run did not fetch asks (ruling 37), and so does a source given as a path the run cannot
resolve. It is also served from an owned `io.StringIO`/`BytesIO`, and from a path under the session's `/files/` once
the mount exists. Why it stays:

- Bench's replay: 41 of 129 cells call `read_csv` unprompted.
- In the 3,231 bench runs, 209 of the 647 runs that fetched a table tried `read_csv` on its URL, though the
  description says not to (`python-tool.ts:103-104`) **[measured]**.
- Today's prelude redirect (`PRELUDE_LOADERS`, `python-runtime.ts:136-205`), which hands back the injected frame,
  goes away with injection.

- **Keywords allowed:** `sep`, `delimiter`, `header`, `names`, `index_col`, `usecols`, `dtype`, `parse_dates`,
  `nrows`, `skiprows`, `na_values`, `keep_default_na`, `thousands`, `decimal`.
  - Refused: `chunksize` and `iterator`, which return a stateful reader; `converters` and `on_bad_lines` given as
    callables; `storage_options`; `memory_map`; `compression`; `encoding_errors`; `engine="python"`.
  - A `**` spread is read through the same checker, so it cannot hide a keyword (the #1991/#1993 lesson).
  - Any other keyword asks.
  - An AGREE row holds this list equal to the manifest's `inside.keywords` (item 8).
- **The kept bytes, and their cap.**
  - Today the run's fetch cache is a per-run `Map` in the service worker (`worker-tools.ts:70`, :326). It keeps the
    `FetchResult`, whose `.text` is the body up to the table read cap (`FETCH_TABLE_MAX`, 64 MB, `sw-fetch.ts:122`). A
    body past the parse cap is kept whole in the value store (`valueKey`, `contract-fetch.ts:184`) **[code]**.
  - `workerTable` hands Python the parsed rows, not the bytes (`worker-tools.ts:381`). That changes to the bytes.
  - Proposed cap: 64 MB per source, which is the read cap already, so nothing new is cut. The run's kept bytes total
    256 MiB; past that, the oldest source is dropped. A dropped source, or one lost to the worker's eviction (state
    in worker memory dies with it, `docs/dev/state.md`), makes the next `read_csv` of it ask, which refetches on
    approval. Nothing is served stale or partial.
- **One file gives the same column types through both doors.** In Python both are pandas over the same bytes:
  `ml.table(src)` IS `pd.read_csv(<the kept bytes>)` with no keywords, so its dtypes are pandas' by construction.
  - A committed row holds `ml.table(u).dtypes == pd.read_csv(u).dtypes`, over the bench fixture and a quirk corpus:
    leading zeros, `$1,200`, `12%`, `(150)`, a blank cell, `N/A`, `1e3`, a date, and a ragged row.
  - The JS `Table` keeps `tableFromDelimited`'s casts (`table-data.ts:216-254`), which differ from pandas in exactly
    those places. So the fetch result's summary line (item 11) says which reader made its dtypes.
  - A second committed row lists each JS-pandas difference, so the gap is known, not discovered. Unifying the two
    readers is not this work.

## 5. `tables`, `df`, `current`, sheets and pointers

- **Question for Shane: keep `python_exec`'s `tables` argument, or remove it?** Ruling 68 says python_exec stops
  injecting tables; the shorthand injects nothing, but keeping the argument is Shane's call. **Recommendation: keep
  it as shorthand,** defined as the cell running `name = await ml.table(source)` for each
  entry before its code, under item 2's rule.
  - 623 of the 647 table-fetch runs used `tables` **[measured]**, so removing it would retrain every model for no gain.
  - The rows are no longer injected: the prelude calls the member.
  - The worker's path bug goes with it. `/sales.csv` is sent to the DOM reader and fails as "not a valid CSS selector",
    because only the page loader resolves a path (`ml-python.ts:~172`, `worker-tools.ts:376-381`). One resolver in
    the member fixes it for both hosts.
- **The replacement for each:**

| Today | After |
| --- | --- |
| `tables: "#sales"` makes `df` | `df = await ml.table("#sales")` |
| `tables: {a: src}` | `a = await ml.table(src)` |
| `current` | `ml.table("current")`, the same rule as today (`pageTable`, `ml-python.ts:220-231`) |
| a Sheets URL | `ml.table(url)`: asks once, then free in the run |
| `@tool:<id>` table pointer, resolved before the call (`resolveTablePointers`, `agent-loop.ts:804-825`) | `ml.table("@tool:<id>")`: the stored bytes |
| `tableRaw: true` | `ml.table(src, raw=True)` |

## 6. Lossless: what the casts lose

A JS `Table` keeps none of the source text **[code]**:

- Casting is per column. A column at least 90% numeric becomes numbers. `"007"` becomes 7, and `"$1,200"`, `"12%"` and
  `"(150)"` lose their formatting. A blank and an outlier like `N/A` both become `null`, and an `int64` column with a
  null becomes `float64`.
- Headers are trimmed and renamed (`Unnamed: N`, `a.1`).
- There is no date parsing, and `1e3` stays text (`table-data.ts:216-254`).
- The table has no link back to `FetchResult.text`, and a Parquet fetch's `.text` is a description, not the bytes.

Recommendation: the bytes are the original, and the table is a view of them.

- `ml.table(src, raw=…, delimiter=…, header=…)` makes a view; `raw` keeps every cell a string.
- `ml.table(src).source` (the kept bytes) stays reachable, in Python as `bytes`, in JS as text or a Uint8Array.
- In Python, pandas' own casting replaces ours (item 4). `dtype=str` is the lossless read pandas users already know.

## 7. A cell writes its own session's `/files` (ruling 69, settled)

A cell inside the dialect writes its own session's `/files/` unasked. The limit is the session quota and nothing
else (ruling 76): `filesQuotaMB`, default 1024, what the session's runs keep at stored size. It is a DevTools Settings
flag, and session-store's. The model may propose a change through `change_setting`, which always asks. It is enforced
in the offscreen document on every chunk (#1999's slice 1, not on main).

- **Which members write `/files` inside the dialect** (async's hole 4). The dialect has no `open()` and no `os`. Ruling
  36's route table (branch `measure/py-files-mount`, notebooks/files-mount/data/routes.json) shows every one of 51
  file routes refused inside today. The one exception, `to_string(buf=path)`, is #1991's fix **[measured]**.
  - Admitted, each as a manifest leaf `"effects": "writes(path arg) when the path is in the session's files"` with
    the checker below:
    - pandas: `DataFrame.to_csv`, `to_parquet`, `to_json`, `to_feather`, `to_pickle` (writing a pickle is data;
      reading one stays refused), `to_html` and `to_string(buf=…)`, and `Series.to_csv`.
    - numpy: `save`, `savetxt` and `savez`.
    - Pillow: `Image.save`.
    - pyarrow: `parquet.write_table`, through the lazy table only (item 12).
    - matplotlib's `savefig`, if and when matplotlib is admitted. It is not admitted today.
  - `ml.fs.writeFile`, `ml.fs.cp`, `ml.fs.mv` and `ml.fs.rm` (ruling 60), awaited over the wire. They need item 1's
    await change, and the offscreen document checks them itself.
  - Not admitted: a restricted `open()`. The path is checked once, at `open`, but the writes come later and carry no
    path. The gate would see `write(str)` on a handle, which says nothing about where it goes:
    ```python
    f = open("/files/out.csv", "w")    # checked here: inside the session's files
    keep = f                            # the handle under another name
    keep.write(row)                     # no path on this call; the gate sees a str
    ```
    In a worker-hosted run the namespace persists, so `keep` outlives the cell and writes from a later cell, long after
    the path was checked at `open`. The library writers and `ml.fs.writeFile` cover the
    same need with one checked call each. Revisit only if a measured task needs incremental writes.
  - Not admitted: `to_excel`, `to_latex`, `to_markdown` and `to_xml`. Their optional dependencies are missing
    outside too (the route table). Also not admitted: `ndarray.tofile` and `shutil`. `tofile` is a C method with a
    path argument, so the rule of #1993 applies to it.
  - `to_pickle` writes inert bytes, but reading a pickle back runs code. `pd.read_pickle`, `np.load(...,
    allow_pickle=True)` and `pickle.load` stay refused inside, on a `/files` path too, and each gets a committed row.
    `np.load` with `allow_pickle` unset or False is a read, under ruling 71's rule.
  - Every admitted writer is a row in #1991's ENUMERATED test: probed, or given a reason. A name added to it without
    the row fails that test.
  - JS: `ml.fs.writeFile`, `ml.fs.rm` and `ml.fs.mv`, through `mlFacade`.
- **Question for Shane: may `ml.fs.rm`, `ml.fs.mv` and an overwrite run unasked?** Ruling 69's words are "let it write
  it to its own files". Deleting or overwriting an earlier file is wider than writing a new one.
  - What protects the person's files: `attached/` is read-only (EROFS, session-store's rule (a)), and nothing else.
  - Who writes outside it, by #1999's spec at b93f7328: a person cannot upload into `agent/`. Attachments land at
    `attached/<handle>/<name>`, and the model copies from there. The person can rename, move within `agent/` and
    delete there, from the files panel. So every byte outside `attached/` was written by a run of this session, and
    `rm` cannot reach a byte the model did not write.
  - But an earlier run's file, or one the person renamed or kept on purpose, is not this run's, and a later model can
    delete it.
  - Caveat: a later host proposal ("/files on the person's disk") would let the person's own edits reach `agent/`.
    This rule would then need asking again.
  - **Recommendation:** writing a NEW path is free (ruling 69). `rm`, `mv` and an overwrite are free only for a file
    this run made, tracked by the offscreen document per run as the commit records it, never as the script says.
    For any other file outside `attached/`, they ask, with a card that names the file, who made it and when. Under
    `attached/` they are refused (EROFS).
  - **A restorable `rm`, if Shane wants it** (session-store: the shelf can keep a removed or overwritten version as
    one row marked removed, with the Blob kept by reference and no bytes copied; a restore is one commit; `mv` needs
    nothing kept). Three sub-questions, with session-store's recommendations:
    - Do kept versions count toward `filesQuotaMB`? Yes, or `rm` frees nothing.
    - How long are they kept: until the session is deleted, for a bounded time, or until the person empties them?
    - Does the backup carry them? No.
    It would amend two sentences of #1999's spec: "there are no versions per write" and "Deleting a file deletes its
    versions".
- **The checker proves the path before the call.** It is a lifted `allow_call` entry check, registered the way
  #1991's `buf` check is (`_ml_buffer_args`). It reads the path by keyword and by position, through `*` and `**`, and
  from a bound method held in a name (e3's `f = d.to_string; f(*[], **{…})`). Then it applies session-store's rule:
  - lexical normalisation with `/` as the session root, `/files/x` the same as `/x`, and `..` stopping at the root;
  - refused under `attached/` (the person's files, EROFS);
  - a hidden-list name (ruling 34) asks;
  - no symlinks exist, so the lexical path is the real one.
  The session comes from the worker's run record, never from the script. A buffer, a non-str or a computed path the
  check cannot normalise asks. The C-method lesson of #1993 applies: a C method with a path argument is not listed
  until the fork maps a bound builtin to its descriptor.
- **A cell saving a fetch to its own `/files`.** `r = await ml.fetch(u)` and then a write of `r.text`, or
  `t = await ml.table(u)` and then `t.to_parquet("/files/x.parquet")`, falls out of the rules above. Two cases do not:
  - **The result crossed as a view, not the whole.** A body past the parse cap is a preview with the whole in the
    value store (`valueKey`). A wire answer over 1 MiB crosses as a pointer. Writing the view would save a prefix under
    the whole file's name. So the copy is made from the stored whole, never from the view:
    - in JS, `ml.fs.cp(<the fetch's @tool: pointer or valueKey>, "/files/x.csv")`;
    - in Python, `await ml.fs.cp(r, "/files/x.csv")`, with `r` the fetch result or its `MlPointer`.
    The copy runs in the offscreen document from the value store to the shelf, so no byte crosses the cell. Writing a
    value marked `truncated` with `open()`/`to_csv` is refused, and the message names `ml.fs.cp`.
  - **Byte-exact copies.** `r.text` is decoded text, and a table is a cast view. Neither is the body.
    `ml.fs.cp` copies the kept bytes (ruling 71's), so the file in `/files` is byte-for-byte the response, with its
    encoding, BOM and line endings. It is the only route that promises that, and the docs say so.
- **The offscreen document is the boundary;** the checker is a gate before it.
- **The commit point (ruling 75, and the coordinator's call under it).** A file commits when it is closed.
  - A full cell commits on close. A failed full cell keeps the files it closed.
  - An attempt INSIDE the dialect holds its closed files in the attempt's transaction. It commits them only if the
    attempt succeeds, and a refusal or a failure aborts them, as its namespace already rolls back. Otherwise a
    refused attempt, rerun on the full path after approval, would have written once before the person answered.
  - session-store writes it in slice 1's spec.
- **What e3 attacks:** `..` past the root; `/files/attached`, `./attached/../attached/x`; a hidden name; a path in
  another session (it must resolve inside its own root by construction); a link, if any API can make one; a write
  over quota (ENOSPC, the old version intact); a write then a refusal in the same cell; each write leaf by every
  binding form; a path made by a library callback.

## 8. Manifest data (rulings 55, 56)

`ml.table` is a member of the `ml` facade, not a library leaf. Its row goes in a window-ml manifest beside the stdlib
one, so the AGREE rows that hold the generated registration equal to the manifest (V1) cover it too:

```json
"ml.table": {"effects": "reads-external when the source is an unapproved Sheet or an uncached URL; pure otherwise",
             "returns": "fresh", "inside": {"await": true, "source": ["selector", "current", "@tool:", "cached url",
             "fetch result (by its url)", "approved sheet", "/files path"], "keywords": ["raw", "delimiter", "header", "decimal"]}}
```

The `/files` writers carry `"effects": "writes(path arg) when inside the session's files"`. The checker of item 7 is
generated from that field.

## 9. The red-team pass (a new `ml.*` member)

The JS member goes through the page contract (AGENTS.md, three files) and the origin gate, and the dialect admits it
in `mlFacade` (`src/readonly-exec/policy.ts:561`), outside `PAGE_ML_METHODS` on purpose. What a hostile page must not
get:

- A table of another tab, another origin, or a cross-origin frame.
- An unapproved Sheet read through a computed id, or a JSON-in-a-string map (the `tablesMapFromJson` case).
- A fetch that egresses through `ml.table(url)`, a credentialed read, or the cache of another run or page.
- A stored value of another run through `@tool:`.
- A way to make the facade forge the brand (`table-brand.ts`), or a table whose cells carry code: page content arrives
  as plain strings and numbers, never a getter, a proxy, or HTML that renders.
- An output size the caps do not bound, and work proportional to an argument with no check (the halting rule,
  `readonly-exec.md:920-947`).
- The page's own `window.ml.table` called from an unapproved origin.

Every probe ends as a committed row or a one-line reason.

## 10. Owners, order, and what the model reads

- **Owners** (set by the coordinator, 2026-11-19):
  - packages: the Python `await ml.fetch` and `await ml.table`, the dialect change, `read_csv`, the `/files` write
    checker, and the lazy table.
  - The JS `ml.table` and its `mlFacade` entry: unassigned; the coordinator assigns after the ruling.
  - The fork's `run_cell` with await, if item 1 chooses it over JSPI: unassigned; the coordinator assigns after the
    ruling.
  - session-store: the ranged reader, `ml.fs` and the `/files` commit, after #1995 and #1999.
  - async: Python's `/files` mount, on session-store's reader.
  - e3: the rows.
- **Order:**
  1. A spec PR from this note.
  2. The fork's await, with a core rebuild (the coordinator first, by the standing rule).
  3. The JS member, which needs no fork.
  4. The Python member, with `tables` redefined over it.
  5. `read_csv`.
  6. The `/files` writes, after #1999's slice 1.
  7. The lazy table (item 12), last.
  V1 (the vocabulary) is unaffected; V2 is step 5, now served from the kept bytes rather than from `tables`.
- **What the model reads** (`docs/dev/prompt-review.md`, one review at the end):
  - `python_exec`'s description loses "Your inputs are ALREADY loaded … never re-open/parse/read_csv them"
    (`python-tool.ts:103-104`) and "No network or filesystem here". It gains one line: `t = await ml.table(src)` reads a
    page table, a fetched URL, a Sheet or a pointer, and `pd.read_csv(<fetched url>)` works.
  - `fetch_url`'s "pass the same URL to `python_exec`'s `tables`" (`tool-details.ts:83-84, 197-198`) and
    `tablePreview`'s line (`table-data.ts:300-301`) name `ml.table`.
  - `PYTHON_CLAUSE` (`agent/prompts.ts:215-218`) is unchanged.
  - A bench arm, before and after, on `csv-total`.

## 11. Should a fetch stop building a table by default?

**[measured]**, mtable/measure.mjs, Node/V8, calling `derivedFetchFields` itself:

- **The parse is eager.** Every CSV fetch parses the whole body page-side (`derivedFetchFields`,
  `src/ml/fetch-result.ts:24`, `tableFromDelimited(r.text)` with no options).
- **Its cost:**
  - The bench's 3,000-row sales CSV (84 KB, `examples/cross-page/sales.mjs`): 6 ms, 11 MB of transient heap, 0.5 MB
    kept.
  - 60 MB, near `FETCH_TABLE_MAX` (64 MB, `sw-fetch.ts:122`): 1.16 s and about 600 MB of transient heap. Papa lexes
    every row before the 200,000-row cap applies (`table-data.ts:40-53`), so the parse costs about 10 bytes of heap per
    byte of input, and 32 MB stays.
  - Detection alone (`sniffDelimiter` on a 64 KB prefix) takes 0.1 ms at every size: it reads only six lines.
- **What the model sees** (bench run, verbatim): `Fetched <url> — HTTP 200, type: csv.`, the header and 5 rows,
  `[3,000 rows x 5 columns] (first 5)`, `dtypes: id int64, region str, …`, and "Whole table cached: pass "<url>" to
  python_exec's `tables` for all 3,000 rows as a DataFrame (no refetch, no read_csv)."
- **Use:** in all 3,231 bench run exports (38 sweeps), 647 runs fetched a table, and 633 of them (98%) used it later.
  The routes were `tables` 623, a `read_csv` try 209, exec `.table` 2, and an `@tool:` pointer 0. Caveat: every one of
  those fetches is the same `/sales.csv` fixture, in two tasks, with Python enabled. That says the bench always uses
  its table. It says nothing about a CSV a model only skims.

**Recommendation: the coordinator's split.**

- The fetch result keeps the detection and the summary the model reads: shape, dtypes and the first rows. They are
  computed from a bounded prefix (the first 64 KB, plus a newline count of the rest for the row total).
- The full parse runs only on `ml.table(...)`, or on the JS `.table` being read: a lazy getter, so existing exec code
  keeps working.
- **Question for Shane: may the summary state dtypes inferred from a prefix?** The failure case: a column numeric in
  the first 64 KB and text after it (a footer row, a `TBD`) is shown as `int64`. The model then writes arithmetic the
  full parse breaks. Recommendation: yes, labelled "dtypes from the first N rows", because the alternative is the
  full parse this item removes. `ml.table`'s own dtypes always come from the whole file.
- The bytes stay the original (item 6).
- The gain is at size, not on the bench fixture: about 1 s and 600 MB of transient page heap per 60 MB fetch that
  nothing reads.

## 12. Very large files: a table that never loads the file

**Where pandas fails today [measured]**

Setup: mpandas/one.mjs, the pinned core (pandas 3.0.2), Node on a 24 GiB machine, one fresh process per size, and a
6-column sales CSV written into the file system as bytes.

| CSV | `read_csv` | wasm heap after | frame (deep) |
| --- | --- | --- | --- |
| 10 MB | 1.8 s | 136 MB | 29 MB |
| 60 MB | 1.7 s | 235 MB | 175 MB |
| 120 MB | 2.3 s | 406 MB | 351 MB |
| 250 MB | 3.5 s | 688 MB | 730 MB |
| 500 MB | 5.5 s | 1,169 MB | 1,461 MB |

- No size failed. So in a full cell the ceiling is the browser's worker, not pandas.
- A full cell has no memory cap of its own, only the 15 s watchdog (`src/offscreen.ts:14`). An out-of-memory worker
  death is recognised afterwards (`MEMORY_DEATH`, :173).
- The wasm32 ceiling is 4 GiB **[guess: the core's maximum was not read]**. Chrome is not measured; it will fail
  earlier than Node.
- An inside cell has the fork's own cap, 256 MiB added to the heap (`_restricted.DEFAULT_MEMORY` = 268435456, read
  from the pinned core). The heap grows about 2 bytes per CSV byte. So an inside cell that materialises a CSV past
  roughly 100 MB is refused **[guess: from the growth above, not run under the cap]**. That size is the case for item
  12 inside the dialect.
- Handing a big CSV to Pyodide as a JS string costs twice. At 60 MB the heap was 537 MB against 235 MB from a file.
  At 250 MB, `FS.writeFile(<string>)` crashed Node's own heap. `ml.table`'s bytes cross as a typed array, never as a
  string.

**Choosing the engine (ruling 72: reuse one that fits; scans of our own only if none does)**

| Candidate | Where it runs | Ranged read, no whole file | CSV / Parquet | Size, pin | Exact sums | Surface to close | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pyarrow 22.0.0 | in Pyodide, the cell's worker | yes: `pq.ParquetFile(<file-like>)` read 0.27% of a 53 MB file for the schema and 1.24% for one int column **[measured]** | both: `csv.open_csv` streams, Parquet by row group | 10 MB wheel, already in `pyodide-wheels/` and the lock, so nothing new to pin | `decimal128(18,2)` columns sum exactly; float64 drifts by up to 0.17 cents per region, varying with batch size **[measured]** | no S3/GCS/Azure/HDFS/HTTP filesystems, no Flight; `PyFileSystem` + `FSSpecHandler` remain (a cell must not reach them) **[measured]** | **recommended** |
| pandas `chunksize` | in Pyodide | CSV only, sequential | CSV; Parquet has no chunks without pyarrow | already loaded | float, order-dependent | none new | the fallback for CSV, nothing more |
| DuckDB (the Pyodide wheel, 1.5.1 in the lock) | in Pyodide | yes, by design **[guess]** | both | not in `pyodide-wheels/`; its size was not read | exact DECIMAL **[guess]** | a SQL string; its own readers (`read_csv('…')` on any path), `httpfs`, `ATTACH` and `INSTALL`, each to be shut off and red-teamed | rejected for now: the wheel is not on disk, so it was not measured (a downloaded wheel is not run here), and the SQL surface is the largest |
| DuckDB-wasm | a JS worker beside Pyodide | yes **[guess]** | both | 141-149 MB unpacked across its variants **[measured: `npm view`]**; a second binary pin | as above | as above, plus a second realm | rejected: the size, a second engine and a second dtype mapping to hold equal to pandas |
| Polars 1.33.1 (Pyodide wheel in the lock) | in Pyodide | its streaming engine single-threaded in wasm: unknown **[guess]** | both | not in `pyodide-wheels/`; not read | exact Decimal **[guess]** | its own cloud readers (`scan_parquet("s3://…")`) | rejected for now: not on disk, not measured; reconsider if pyarrow's CSV path fails its bound |
| hyparquet + Papa (what `tableFromParquet` and the JS CSV path use) | the JS worker | yes, `asyncBuffer` | both | already shipped | none: they only read; the aggregates would be ours to write | none new | rejected by ruling 72: they read, but every operation would be our own scan |

**pyarrow on 11.74 million rows (a 500 MB CSV, the same data as a 53 MB Parquet file) [measured]**

Setup: marrow/, the pinned core, Node, one fresh process per run. The files are on a NODEFS mount, so they are not
in the wasm heap. The heap baseline with pyarrow and pandas imported is 124 MiB. The per-cell cap is 256 MiB on top
of the heap.

| | Row count | groupby region (sum, count) | Filter `units > 30`, count | head(5) |
| --- | --- | --- | --- | --- |
| Parquet, `iter_batches` | 0.12 s, 124 MiB | 0.66 s, 148 MiB | 0.24 s, 124 MiB | |
| CSV `open_csv`, 1 MB blocks | 2.2 s, 178 MiB | 1.5 s, **443 MiB** | 1.8 s, 178 MiB | 0.1 s, 178 MiB |
| CSV `open_csv`, 16 MB blocks | 729 MiB | 729 MiB | 729 MiB | 0.5 s |
| pandas `chunksize=200k` | 3.1 s, 155 MiB | 2.9 s, 130 MiB | 2.0 s, 130 MiB | |
| whole `pd.read_csv` | | | | 8.0 s, 1,094 MiB, a 1.44 GB frame |

- **Parquet stays inside the cap** for every operation measured: at most 24 MiB over the baseline. That bound is
  shown, not assumed.
- **CSV through pyarrow is bounded by the block size,** not by the file. The pool peaks at about 32 times the block
  size. Even so, the 1 MB-block groupby reached 443 MiB of heap, about 300 MiB of it outside pyarrow's pool, and
  that was not isolated.
- So the CSV recommendation is narrower: a large CSV is converted once, in a streaming pass, to Parquet in the
  session's files, and queried there. The conversion's own bound is still to be measured: the writer reached 745 MiB
  at 16 MB blocks, and a small block size was not tried. Until it is measured, a CSV past the materialise cap is
  answered with pandas `chunksize` (the 130-155 MiB row above), or refused.
- **Exactness: a question for Shane, because it is an inference on the person's data.** `decimal128` sums are exact
  and do not move with block size, while float64 drifted by up to 0.17 cents per region **[measured]**.
  - The rule first drafted, "a column with at most 2 decimal places in the first block is money", fails on a
    2-decimal measurement column (a temperature, a weight). It would be summed as decimal, then refuse a `mean` that
    needs more places, or overflow `decimal128(18,2)` past 10^16.
  - Recommendation: never infer money from decimal places alone. A column is read as decimal only when the cell says
    so (`ml.table(src, decimal=["amount"])`), or when its header names a currency (`amount_usd`, `price €`). The
    summary says which columns were read as decimal and why. Every other numeric column is float64, and its sum is
    labelled float.
- **Where it runs:** in the cell's own Pyodide worker, over a file-like built on #1999's ranged reader (`/files`) or on
  the fetch cache's value store. No bridge call is needed per operation.
- **Open question for the fork lane:** whether Arrow's allocations count against the dialect's memory cap. The fork
  wraps the MEM and OBJ allocator domains (`docs/dev/pyodide-build.md:59`), and Arrow's pool allocates outside them
  **[guess]**. If they do not count, the bound comes from the harness (the block size and the batch), and the
  harness reads it from pyarrow's `max_memory()`.

**How the pandas-shaped table maps onto it**

| The cell writes | pyarrow does | Bound |
| --- | --- | --- |
| `t.shape`, `t.columns`, `t.dtypes` | the Parquet metadata; for CSV, a counting pass | O(1) |
| `t.head(n)` | the first batch | n rows |
| `t[["a", "b"]]` | `columns=` on the reader | the selected chunks |
| `t[t.units > 30]` | a filter compiled from the expression, which must be column-op-literal; anything else is refused | one batch plus the result |
| `t.groupby(k).agg({...})` with sum, count, min, max or mean | `Table.group_by` per batch, with the partials combined | O(groups), capped (100,000 proposed) |
| `t[c].value_counts()` | the same | the same cap |
| `t.merge(small)` | a hash join against the small side | the small side |
| `await t.to_pandas()` | a read under the materialise cap | refused past it, with the size in the message |

- **Refused, with why and what to do:** sort, a join of two large tables, an exact quantile, and an exact distinct
  count past the cap. An approximate answer is offered only under a name that says so (`approx_quantile`, from
  Arrow's t-digest), and nothing approximates silently.
- **The lazy table refuses anything it does not map,** as `asTable` does (`table-data.ts:591-592`).
- **Manifest data:** each operation is a row with `returns: fresh`, so its result is the cell's. pyarrow itself is
  never admitted to a cell: the lazy table is window-ml's class, and pyarrow stays behind it, unreachable (no
  `PyFileSystem`). A cell names only the facade's methods, and they are synchronous calls inside Pyodide, so the
  dialect needs no await rule for them.
