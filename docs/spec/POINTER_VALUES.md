# Pointers that address values

**Status: draft, not started.** Written 2026-09-16, out of the table work (`fetch_url` returning parsed CSV and
Parquet, PR #74). It replaces nothing yet; it describes what a `@tool:` pointer should BE, so that the pieces
built on top of pointers stop each inventing their own answer.

The goal in one sentence: **a pointer names one value, held once, readable from JavaScript and from Python
without either side making its own copy of it.**

## What a pointer is today

A pointer is a row in a `TokenStore` (`token-pipe.ts`): the text the model saw (`out`), a fuller text the UI
kept (`full`), and — since the table work — a structured `table`. Two facts about that row decide everything
below.

**It holds a PREVIEW, not the value.** Its contents come from the capturing step's render descriptor, which is
sized for a log: it rides the debug stream, the sidebar and `run.json`. A fetched CSV ships at most
`RENDER_TABLE_ROWS` (200) rows into it. So `@tool:abc1234` on a 50,000-row file names 200 rows while reading
like a handle to 50,000. That is survivable while a pointer is only read into a model's context — the preview
is the point there. It stops being survivable the moment a pointer feeds something that computes:

```js
python_exec({ tables: { df: "@tool:abc1234" } })   // pandas would total 200 of 50,000 rows, and say nothing
```

That is the failure this codebase keeps designing out one place at a time — a plausible number computed over a
sample the caller believed was the whole. `fetch_url`'s preview had it (fixed by carrying `rowCount`), the
panel's "copy CSV" had it (fixed by labelling what it copies), and it is still here, one level down.

**It lives in whichever runtime happened to run the loop.** A page-hosted run keeps its store in the page's
main world; a background-hosted run keeps it in service-worker memory (`tokensByRun`, capped at 24 sessions,
lost on an SW eviction). Neither is a home for a value: the page's heap is the user's tab, shared with a page
that may be hostile, and an MV3 service worker is torn down after seconds idle.

## What moving a table costs today

Measured by reading the code, for a large CSV fetched and then handed to `python_exec`:

| Step | Where | What happens |
| --- | --- | --- |
| read | service worker | `await res.text()` reads the WHOLE body, then slices it to 8 MB. A 1 GB response is fully held first (about 2 GB as a UTF-16 string). The Parquet branch calls `res.arrayBuffer()` with no cap at all. |
| relay | SW → content → page | the (≤8 MB) text is structured-cloned twice |
| parse | page main world | Papa Parse builds string rows (≤200k lines); `castTableColumns` builds a second, cast copy |
| cache | page main world | `mlFetchCache` keeps the text AND the rows for every fetched URL, for the life of the tab, never evicted |
| to Python | page → SW → offscreen → worker | rows structured-cloned per hop, then `JSON.stringify(tables)` (`python-worker.ts`) |
| into pandas | Pyodide | `json.loads` builds a list of lists of boxed Python objects — roughly ten times the data — then `pd.DataFrame` copies it again into numpy columns |

The same table exists in full at least six times on that path, in four processes, and the largest copy is the
least useful one.

## The shape

Three layers, each with one job.

### 1. The value store — where a value lives, once

A value is stored ONCE, as bytes, in an **extension-origin store**: IndexedDB, holding `Blob`s keyed by pointer
id. Not in the page (the user's tab, and a hostile heap), not in service-worker memory (evicted), not in the
Pyodide heap (the worker is killed on a timeout). A `Blob` in IndexedDB is not a JavaScript heap object until
someone reads it, so holding a 100 MB table costs disk, not memory, until it is used.

Both halves that need it can reach it: the service worker (which owns the loop and the grants) and the
offscreen document (which hosts Pyodide). The page cannot, and must not — every read goes through the run-bound
resolver that already scopes `ml.dereference` to a tool call of the run that owns the pointer.

**Lifetime** is the session's, the same as a pointer's today (`releaseSessionTokens`). A byte budget per
session evicts oldest-first; an evicted value leaves its preview behind, and reads of it FAIL (below).

### 2. The representation — what the bytes are

- **Tables are Arrow IPC.** It is the one format both runtimes read natively and columnarly, without parsing:
  pyarrow (bundled for this, below) opens an IPC buffer and hands pandas an Arrow-backed frame; the Arrow
  JavaScript reader views the same bytes as typed arrays. Every table source converts to it ONCE, at capture:
  - Parquet and CSV are decoded by **pyarrow** in the offscreen worker (`pyarrow.parquet`, `pyarrow.csv`), which
    replaces both hyparquet and Papa Parse on the full-value path. The delimiter and header decisions the
    preview already made are passed explicitly, so pandas cannot disagree with what the model was shown.
  - A DataFrame returned from `python_exec` is written back as IPC, becoming a new pointer in the SAME
    representation — which is what makes a pointer reusable in both directions rather than a one-way import.
  - A DOM table is small by construction (extraction caps it) and stays inline.
- **Text, images and JSON stay what they are** — a text blob, the image bytes, the JSON text. Nothing here is
  improved by a columnar format, and a pointer's `kind` already says which it is.

### 3. The preview — what a pointer shows

The preview is DERIVED from the value at capture and is exactly what the row holds today: the model-facing
text, the capped render, `shape`, `dtypes`, `rowCount`. It is small, JSON-safe, and it is what `run.json`
embeds — alongside a `source` descriptor saying where the value lived, never the value.

When the preview IS the whole value (a table under the render cap, a short text), there is no stored value at
all, and nothing below applies. That is most pointers, and it must stay free.

## Reading a pointer

Two kinds of reader, deliberately given different things:

| Reader | Gets | Why |
| --- | --- | --- |
| a model's context — `dereference`, `\| keys`, the tool result | the preview | it is going into a context window; the cap is the point |
| the sidebar and the exports | the preview | a log view; a whole table belongs in neither |
| `python_exec` | the value | it computes; a sample is a wrong answer |
| `exec` / the read-only dialect | the value, **by the column or the slice** | it computes, but a page must never be handed the whole thing |
| "copy all rows", "save as file", a column summary | the value | these are the features that currently lie |

### Into Python — one copy, no parse

The offscreen worker reads the `Blob` from IndexedDB (the store and Pyodide share the offscreen document's
process, so nothing crosses a message boundary), and passes it to Python as a **buffer**: one copy into
Pyodide's WebAssembly memory, then `pyarrow.ipc.open_file(buffer)` and `to_pandas(types_mapper=pd.ArrowDtype)`,
which keeps the columns Arrow-backed rather than converting them. The six copies above become one.

**It is a buffer, never a live object handle.** Pyodide can pass JavaScript objects into Python as `JsProxy`
handles, and that is exactly what the sandbox's `readonly` hardening removes: `harden()` unregisters the `js`
and `pyodide_js` modules and purges them from `sys.modules`, because a reference into the JavaScript realm is a
reference to `fetch`, `postMessage` and the worker's globals. A byte buffer carries no capability — it becomes
Python `bytes`/`memoryview` and nothing else — so it crosses the hardened boundary without widening it. This is
the same decision the `vars` bridge idea records ("leak-proof, no JsProxy"); a buffer is how to honour it
without the JSON round trip.

### Into JavaScript — the table facade, lazily

`exec` and the read-only dialect already reach a table through the `Table` facade (`col`, `select`, `records`,
`head`). For a table whose preview is the whole value, those methods run over the rows in hand, as today. For a
stored one, they become requests: `t.col("revenue")` asks the resolver for one column, which the offscreen
document reads out of the IPC bytes and returns as a plain array. The page receives what the script touched,
never the table.

That makes those methods ASYNCHRONOUS for a stored table. The dialect already awaits a host read before using
it, so a survey is unchanged. In a full `exec` it is a promise, which is the one visible cost of this design and
the same shape `ml.dereference` already has for a computed reference — `await` is safe on both, and the
facade's error for a missed `await` should say so.

### From Python back — the same kind of pointer

A DataFrame a `python_exec` returns is written to the store as IPC by the worker, with a preview derived from
it. It is then an ordinary pointer: a later `exec` reads its columns, a later `python_exec` opens it as a frame,
the answer renderer draws its preview. Today that return goes the other way through `to_json(orient="split")`
into a render descriptor, and is only ever a preview.

## Failure: never degrade to the preview

A stored value can be gone — evicted by the budget, or the session released. A read that wanted the VALUE must
then FAIL, loudly, naming what is missing and what still exists:

```
@tool:abc1234 held a 50,000-row table, but the table itself is no longer stored (evicted: this session
passed its 256 MB budget). Its preview is still readable. Re-run the step that produced it for the data.
```

Falling back to the preview would reintroduce, at the one place nobody is looking, the exact bug this exists to
remove.

Two related rules:

- **A DOM source is a snapshot.** A pointer is already defined as the output of the step that produced it, so
  a table extracted from the page is stored as it was, not re-queried on read. Re-reading the page is a new
  step, and makes a new pointer.
- **A fetch source never re-fetches.** The store holds bytes a person already approved; reading them again is
  free. Fetching again — in any mode — goes back through the gate, as a new `fetch_url`.

## Fixed independently, before any of this

Two bugs in the table above are small and stand on their own:

1. **Cap the read, not the result.** `rawGet` should read `res.body` through a reader and stop at the cap,
   instead of `res.text()` followed by a slice. The binary branch needs the same cap, which it has none of.
2. **Evict `mlFetchCache`.** A byte budget and least-recently-used eviction, so a long session does not keep
   every fetched body in the user's tab. (Once values move to the store, this cache holds previews only.)

## Bundling pyarrow

pyarrow 22.0.0 is in this Pyodide release's lock file (`pyarrow-22.0.0-cp314-cp314-pyemscripten_2026_0_wasm32`,
about 10 MB) and its build includes the Parquet, CSV, IPC/Feather, dataset and compute modules — checked in the
wheel, since those are sometimes compiled out. It depends on numpy, pandas and `pyodide-unix-timezones`.

- **Fetched with the other wheels, loaded on demand.** It goes into `PY_PACKAGES` (`python-env.ts`), which
  makes the offline fetch pick it up and — because CI's wheel cache is keyed on that file — refetches it in CI.
  But it is NOT loaded at sandbox start: that would add its load to every `python_exec` cold start, including
  the many that never touch a table. It loads the first time a stored table is opened, or a script imports
  `pyarrow` or calls `read_parquet`/`read_feather`.
- **It changes pandas' string dtype.** pandas 3 makes string columns `str` rather than `object`, backed by
  pyarrow when pyarrow is importable. That is already visible — the table demo's DataFrame prints
  `region str` — and it DISAGREES with `TableLike.dtypes`, which says `object`, the pandas 2 name. The type
  claims to be pandas' surface, so it should say `str` for a string column. Worth fixing on its own.

## Implementation order

Each slice ships and is useful without the next:

1. **The two independent fixes** — the capped streaming read, and `mlFetchCache` eviction.
2. **`TableLike.dtypes` says `str`**, matching pandas 3.
3. **pyarrow in the bundle**, loaded on demand; `read_parquet` works in `python_exec`.
4. **The value store**: IndexedDB blobs keyed by pointer id, session lifetime, byte budget, loud failure on a miss.
   Fetched tables store their bytes; nothing reads them yet except a new, explicit test path.
5. **`python_exec` reads a pointer**: `tables: { df: "@tool:…" }` opens the stored IPC as a frame. The URL form
   stays as an alias. This is the slice that removes the JSON round trip.
6. **Python writes pointers back**: a returned DataFrame is stored as IPC and becomes a table pointer.
7. **The facade reads stored tables lazily**, by column and slice.
8. **The features that were waiting on this**: copy-all and save-as-file (`docs/spec/TABLE_VIEW.md`), and a
   column summary over the whole table rather than its first 200 rows.

The shippable step before all of it, and worth doing now: `python_exec` accepts `@tool:<id>` when the pointer's
table is complete (`!truncated`), and refuses a prefix with an error naming the URL form. It gives the idiom
immediately for small tables, where the preview already is the value, and refuses rather than samples where it
is not.

## Open questions

- **Does the page-hosted loop move its store too?** A page-hosted run's pointer rows live in the page today. The
  VALUES should not, but the rows might stay, with the value behind the same resolver. Worth deciding with the
  design-A background loop in view, which already moves the loop out of the page.
- **Is Arrow JS worth bundling?** Slice 7 can read columns out of IPC in the offscreen document with pyarrow and
  return plain arrays, which needs nothing new. Reading them in JS (Apache Arrow's reader) is faster and avoids
  waking Pyodide for a survey — at the cost of a sizeable dependency. Start without it.
- **The byte budget.** 256 MB per session is a placeholder. IndexedDB's quota is generous, but disk the user did
  not ask to spend is still disk; the budget should probably be a setting.
- **Other large values.** An image or a very long text output has the same preview-versus-value split, less
  sharply. The store is not table-specific, but nothing needs it except tables yet.
- **`@tool:id:in:<line>`** (parked) addresses PART of a value. It should compose with this — a line range over a
  stored text value — rather than grow its own addressing.

## Related

- `docs/spec/TABLE_VIEW.md` — copy-all, save-as-file and whole-table summaries are blocked on this.
- `docs/dev/pointers.md` — how pointers, `dereference` and the pipe dialect work today.
- `docs/dev/python-sandbox.md` — the `readonly` hardening this design must not widen.
- The `Table` facade (branch `table-facade`) — the JavaScript read surface for slice 7.
