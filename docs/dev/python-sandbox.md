# The Python sandbox and bench

Implementation notes for `python_exec` (offscreen Pyodide), its capability modes, the Python bench and its editor, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**`python_exec` — sandboxed Python (offscreen Pyodide).** An opt-in, `requiresApproval`
tool (`buildPythonTool`, like `clickTool`) for pixel/array/spatial work better done in Python
than JS. The service worker can't run WASM and the page main-world CSP blocks it, so CPython
runs in an **offscreen document** (`offscreen.ts`, extension-origin, its CSP allows
`'wasm-unsafe-eval'`): `sw-offscreen.ts` `ensureOffscreen()` → `PY_RUN` message → the offscreen
doc, which relays to a **dedicated worker** (`python-worker.ts`) that actually runs Pyodide.
The worker exists because the offscreen doc shares a renderer process with the sidebar iframe,
so a compute-bound run on the main thread froze the sidebar's clicks (scroll — compositor thread
— still worked); off-main-thread keeps the UI responsive. The worker is chrome-free (resolves
Pyodide URLs via `self.location`), owns the run-serialization invariant, and `offscreen.ts` is a
thin id-matched relay. Pyodide is
(numpy/Pillow/**pandas**/**scipy**/**matplotlib**, bundled offline in `dist/pyodide/`, lazy-loaded — the
package set is single-sourced in `python-env.ts` `PY_PACKAGES`, which drives `loadPackage`, the
prelude imports, the tool-description labels, AND the wheel-fetch script; scipy is loaded but
not pre-imported, so a quick coord/table run doesn't pay its import cost). A call
made inside a worker-hosted run shares ONE namespace with the run's other cells ("A run's namespace", further down);
any other call (a page's `ml.pythonExec`, a page-hosted agent) is **stateless**: the reset, above. The relay is the usual
contract — `PYTHON_EXEC_REQUEST` (page) → `PYTHON_EXEC` (bg). `ml.pythonExec(code, { image })`
screenshots `image` (a selector or `@pt`/`@box`) into the sandbox as `img` (PIL) + `img_np`
(numpy). In a worker-built run the image is shot by the worker from its own capture, and a `cast` mints its token in
the page's registry (`src/sw/worker-media.ts`, docs/dev/agent-tools.md). **Tabular data → DataFrame(s) via `{ tables }`** — ONE unified param that is either a
single source (→ `df`) or a `{ varName: source }` map (→ each loaded under its name so the model
can `pd.merge` them; keys validated as Python identifiers by `pyVarNameError`, single-sourced in
`python-env.ts` beside the prelude's reserved names). Each df is bound BOTH under its name AND in a
`tables` dict — a model that mirrors the arg name and reaches for `tables['name']` just works
(the same accommodate-don't-fight tack as the read_csv redirect; `tables` is a reserved key). A map sent as a JSON
STRING (`"{\"df\": \"https://…\"}"`, how glm-4.7-flash reads the schema's `oneOf`) is that map (`tablesMapFromJson`,
dom.ts); the loader and the consent check both decode through it, or a sheet inside the string would skip its card. A
path on the page's site (`/sales.csv`, `./x.csv`) is resolved against the page and read from the fetch cache like the
absolute URL. A map key that is not a variable name (models key the map by the URL itself) loads under a name
derived from it (`derivedTableName`: `…/sales.csv` → `sales`) with the key as its alias; a reserved name is still
refused. Each source auto-dispatches by shape
(`_loadTable`): **a `<table>`/ARIA-grid selector** is walked page-side (`extractTable`,
case-preserving; col/rowspans or a non-table fall back to `pd.read_html(outerHTML)` with bs4).
Before that fallback ships, `_resolveTable` **guards the cases read_html would choke on**: an
**empty table** (0 rows — a collapsed/lazily-rendered table like the `#bigsales` demo: the node
exists, its rows don't → pandas' `No tables found matching pattern '.+'`), a wrapper with **no
`<table>` inside**, or an **unparseable ARIA grid** each throw an actionable page-side message
("reveal/scroll it into view…") instead of the obscure downstream `ValueError`.
**An `@tool:` pointer to a table** (`tables: { df: "@tool:\"the stock table\"" }`, or the single-source string) is
resolved by the AGENT LOOP, which owns the pointer store (`resolveTablePointers`, beside `look`'s image pointer): the
call's arguments are rewritten for execution only, so the step's raw view keeps what the model wrote, and the table
travels down BY VALUE with its `shape` and the pointer's name. `ml.pythonExec` accepts such a `TableValue` from any
caller (a page script's table, the `Table` facade from `ml.fetch`) and loads it only when it is WHOLE: a preview
(`truncated`, or fewer rows than `shape` says) is refused with the URL form that loads the whole parsed table, because a
DataFrame over a prefix answers confidently and wrongly.

**A pointer to a STORED table** (a fetched table past the parse cap, whose body the value store holds; `docs/dev/pointers.md`)
reads the whole table instead, POINTER_VALUES slice 5:

- The loop adds the store key (`value`) and the preview's `delimiter`/`headerless` to the `TableValue`, on EITHER host:
  what decides the read is the worker's own record of who it gave the key to, not anything the loop asserts.
- `_loadTable` sends `{ kind: "value", key, label, columns, delimiter?, headerless? }` and none of the preview rows. The
  log shows the preview with the whole table's `rowCount`, and the model's load note gives the whole size.
- The background `PYTHON_EXEC` handler refuses a key unless the sender is entitled to it: a run active on the sender's
  tab holds it, or the worker disclosed that key to that tab (`page:<tabId>`, how a page-hosted run qualifies). Our own
  surfaces are trusted. A key that is no longer stored passes, so the read fails with the store's reason.
- The offscreen document reads the Blob (`withStoredTables`) and TRANSFERS its ArrayBuffer to the worker. A missing value
  fails the whole run with the store's message: `python_exec could not load \`df\` from @tool:… (…): the stored value …
  was evicted …`.
- The worker makes the ONE copy: `injectStoredTable` (python-runtime.ts, so the CPython tests use it) allocates a
  `bytearray`, fills it through `getBuffer`, and binds it as `_ml_tbuf_<i>`. It is a buffer, never a JsProxy, so it
  crosses the locked-down boundary without widening it.
- The prelude decodes by stored format:
  - `arrow-file` / `arrow-stream`: `pyarrow.ipc` → `to_pandas()`.
  - `parquet`: `pyarrow.parquet.read_table` → `to_pandas()`.
  - `csv` / `tsv`: `pd.read_csv` with the preview's `sep`, header decision and column `names`, so pandas cannot disagree
    with what the model was shown.

  The prelude pops the buffer, and the worker deletes the name in `finally`.

**A returned DataFrame larger than its 200-row preview becomes a stored table** (slice 6):

- The wrapper adds the frame's real `rowCount` to `_json_table`, and writes the whole frame as Arrow IPC to `_ipc_result`
  (`pa.Table.from_pandas(preserve_index=False)`, dropping the index as the preview does). A frame Arrow cannot hold,
  such as mixed object cells, is not stored, and its preview still says how big it is.
- The worker copies the bytes out (`takeIpc`, python-runtime.ts) and transfers them to the offscreen document. Bench
  runs never store.
- The offscreen document stores them as `arrow-file` (source `python_exec`) under the budget the service worker sent
  with the run (`valueBudget`, since that document cannot read settings), and returns `valueKey`.
- `pythonExec` puts `value` and `rowCount` on `resultTable`, so the `python-out` render's `df` carries both. The loop's
  pointer then has the whole `shape` and claims the value, and a later `python_exec` reads it through slice 5.
**A Google Sheets URL** or **`'current'`** (the sheet you're on) is fetched as CSV. Numeric
columns are **auto-cast page-side** (`dom.ts` `castTableColumns`, pure/tested: a column
≥90%-numeric after stripping currency/commas/%/accounting-parens → `number|null`, else strings)
so `df.sum()` adds instead of string-CONCATENATING — `{ tableRaw }` skips it for
ZIP/SKU/leading-zero IDs. The **Google Sheet** path exists because the DOM is useless (Sheets
renders to canvas): `googleSheetCsvUrl` (dom.ts, pure) derives the `/export?format=csv&gid=…`
endpoint and a `FETCH_SHEET` background message fetches it **credentialed** (`credentials:"include"`
→ the user's own Google login, so PRIVATE corporate sheets work), then `parseCsv` (dom.ts,
RFC-4180) + the same `castTableColumns` pipeline. No access / not signed in → Google serves an
HTML login page instead of CSV; `fetchSheetCsv` detects that and returns an actionable error
telling the model to **have the USER authenticate in-browser and retry**. An **external** Sheets
URL **always** requires approval (a privileged cross-origin fetch); a selector / `'current'` is
auto-approvable like a readonly survey (the tool description gains a "YOU ARE CURRENTLY ON A
GOOGLE SHEET" hint when `location` is one). An approved external sheet is **cached per page-session**
(`approvedSheets`, keyed by `googleSheetId` — the spreadsheet, so its tabs share it): a repeat
call skips the re-prompt (lifts only the external-sheet escalation, so a non-autoPy run is still
gated on the code). Escalation scans **every** source (`externalSheetIds` — a bare string or every
map value), so an external sheet inside a `tables` map still prompts. The debug render
(`python-in.tables`) shows each df with its **variable name + a source label/tooltip** (`TableSource`:
dom / sheet-current / sheet-external), mirrored in the export. The approval prompt **hoists the
data source** (`renderArgs` ranks `tables`/`image` above the `code` blob) so the human sees
*which* sheet before the script. **Host access:** the SW's
credentialed fetch needs the `docs.google.com` host permission, which "On click" site-access
withholds (activeTab covers content scripts, NOT the background fetch) — so a withheld fetch
returns an actionable error (walks the user to the popup's **"Enable Google Sheets access"**
button, or "On all sites"), best-effort `chrome.action.openPopup()`s to it, and the popup's
collapsible **Permissions** block one-click `chrome.permissions.request`s the Google origins
(docs/accounts/googleusercontent — the export can redirect across them). **Loader
interception (PRELUDE, `python-runtime.ts`):** models reach for their pre-training loader idioms
with the selector/name they passed — `Image.open('canvas#stage')`, `pd.read_csv('current')`,
`pd.read_html('#sel')` — and the fs-less sandbox would just throw, burning a turn. The prelude
patches `Image.open`/`pd.read_csv`/`pd.read_html` to return the pre-loaded `img`/`df` **when it's
actually loaded** (never for a real file-like or a URL — except the exact URL a table was loaded FROM, which is that
table: re-reading what `tables` already fetched is the commonest first try — a genuine http `read_csv` /
`Image.open(BytesIO)` passes through). ONE patch per interpreter (the module attrs survive RESET;
the originals live in the install function's closure, so no namespace holds an `_ml_orig_*` name and a later
prelude run in any namespace installs nothing, never a chain). The wrappers resolve `img`/`tables` from the
namespace the running cell's prelude named (`__main__._ml_load_ns`), never from the dict that defined them: a
run with no image of its own is not handed another run's, and `from PIL import Image` in a cell neither loses
the redirect nor leaks one. The bench names none (`None`), so for it the real loader runs. And when that CAN'T resolve it — data preloaded but the code still errors trying to
(re)load it (`read_excel`/`read_json`/`open`/`requests`, an ambiguous name across many tables, a
URL in readonly), the tool **appends a redirect hint** ("use `df`/`img` directly") as the
fallback, catching any hallucinated load pattern on the failure. The tool
description frames the sandbox as "appending a cell to a live Jupyter notebook" (img/img_np/df
are pre-loaded) with a df/img snippet. Output (stdout/value/error) is capped by `clipOut`
(dom.ts, shared with `exec`) with a `[first K of M chars]` note so a runaway result can't
flood context. The code runs in a **sandboxed namespace** (no DOM/fs) under
`contextlib.redirect_stdout` (byte-exact stdout, newlines intact) with its own try/except
(traceback captured, partial stdout preserved). For a call with no run, a reset wipes non-`_`
globals so one call can't leak state into the next (a run's cells instead share a kept namespace); the result is serialized via Python
`json.dumps` (leak-proof — no nested JsProxy) with a numpy-scalar `.item()` coercer. THREE return
conventions all work (`wrapUserCode` builds `_user`'s body at runtime via `ast`): an explicit
`return X`, a bare top-level `result = X` (`global result`), AND a bare **trailing expression**
(`df` on the last line ⇒ its value — Jupyter/REPL-style, the same convention the JS `exec` tool
uses; the code is parsed inside a `def _user()` wrapper so a top-level `return` stays legal, and
its trailing `ast.Expr` is rewritten to a `Return`). Returns come back as **text by default**; `cast:"pt"`/`"box"` validate the return
and mint a clickable `@pt`/`@box` (mismatch → an honest error, never a guess), and a
`to_base64(...)` image return is always shown. **Auto-render by RETURN TYPE** (the serialization epilogue in
`python-runtime.ts` sets a `_json_render` hint → `PyResult.render` → the descriptor): a **sympy** expression is
serialized as `sympy.latex(...)` with `render:"latex"` (the descriptor's `latex:true` → the surfaces typeset it,
and a plain `:out` citation renders as math with **no `| latex` cast** — `| raw` overrides); a **PIL Image** is
encoded to a `data:image/png;base64,…` value with `render:"img"`, which rides the existing image path. Crucially
this keeps **base64 OUT of the model's context** — the model returns the OBJECT (`return img`), WE convert it, and
the tool's model-facing `content` stays a short `"Returned an image."` while the base64 lives only in the UI
descriptor (never re-fed to the model). The debug render is the two-slot `python-in`/`python-out` (above).
**Which of those a return draws as is ONE decision, `pyValueParts` (`src/python/py-render.ts`)**, shared by the tool and
the Python bench (`pyBenchDescriptor`). The bench had its own copy and it drifted: it ignored `render`, so a sympy
return showed as raw LaTeX source there while the log typeset it. What stays in each caller is what differs — the
tool's model-facing text (hints, clipping, `cast`) and the bench's pretty-printed JSON.

**matplotlib: a figure comes back as an image** (the `FIGURES` block of the epilogue, `python-runtime.ts`):

- **Loaded at start, never pre-imported.** The wheels cost ~0.3 s of cold start; `import matplotlib.pyplot` costs
  ~2.4 s (it builds its font list) and is paid only by a script that plots. Not loaded on import, because a readonly
  worker has no `fetch` after its lockdown and Pyodide's loader needs it.
- **Its `prepare`** picks the headless Agg backend before anything imports pyplot, and silences the warning Agg gives
  for `plt.show()`, which a script written for a notebook calls.
- **What draws.** A returned `Figure`, or an `Axes` (its figure), draws like a returned PIL image (`render: "img"`).
  A cell that returns nothing and did not fail, but left figures open, draws them as a notebook would (`render:
  "figure"`): several stack into one image, at most six. A trailing `plt.plot(...)` returns its artists, and a value
  made only of artists counts as nothing returned, so the figure shows rather than a `Line2D` repr.
- **At most ~4 megapixels a figure**: the dpi drops for a huge `figsize`, so the image in the panel and the exports
  stays bounded. It is measured on the TIGHT box the image is cut to (at the figsize's capped dpi, or measuring
  allocates the gigapixels), since an artist far outside the figure grows that box; the padding is fixed at 0.1 in.
- **Every figure is closed after every cell**, a failed one included, so a run's next cell does not draw it again.
  Not against the cell itself: one that patches `plt.close` keeps its figures open for the next cell of its PRINCIPAL
  (a readonly worker is one principal's; the `full` one is everyone's, the shared-interpreter residual below).
- **The epilogue catches `BaseException`**: it runs the cell's own objects outside the cell's try, and an escape would
  skip the cancel of the cell's tasks and asyncio handles; since #998 the cancel runs BEFORE the epilogue, so the catch
  is belt and braces.
- **No module it brings in holds the JavaScript bridge**: `tests/python-matplotlib.test.mjs` walks everything those
  modules reach under the lockdown, after a cell tried every backend, the check a new package with a `prepare` owes.

**`verify: true` hands an image result to the model**, never automatically (`verifyPyImage`, `python-tool.ts`). It is
the `verify` of `click`/`type` (`docs/dev/agent-tools.md`): a driver that sees gets the image on its next turn, a
text-only driver gets the vision reader's description through `ml.chat` with `images`, and with no reader the model is
told so. Without it, an image costs the model nothing, and it is still drawn for the person. In a worker-hosted run,
the run's `ml.chat` with `images` is the vision chat `look` uses (`workerVisionChat`).

**Two capability modes (agent-declared) + auto-approve.** The tool takes `mode`:
`"readonly"` (default) runs in a **locked-down** worker — one Worker (one realm) per PRINCIPAL:
a worker-hosted run (`run:<id>`), a page (`page:<tabId>`), or one of our own surfaces (`own`).
`"full"` is a separate worker that is never locked. A principal change spawns a new worker;
the old one's kept bench namespace dies with it (the bench's "sandbox restarted" banner), and a
respawn writes the `pyodide/respawn` housekeeping record (`docs/dev/housekeeping.md`). The
lockdown is `lockdownReadonly` (`src/python/lockdown.ts`), one boot step that never undoes:
(1) Agoric `ses` `lockdown()` after one `runPythonAsync("1")` warmup (Pyodide's result path
assigns `.constructor`, which `lockdown()` then freezes — lock first and every later call
throws `ConversionError`); (2) an ALLOW-LIST strip of `globalThis` — only the intrinsics Pyodide
needs and a few capability-free host APIs stay; `eval`, `Function`, `fetch`, `importScripts`,
`postMessage`, `navigator`, `chrome`, every Node module go. There is no deny list to keep
current. (3) The harness's module references (`ast.parse`, `json.loads`, `textwrap.indent`,
`base64`, `io`, `contextlib`, …) are captured into a frozen `_ml_harness` module before any cell
runs, so a cell that monkeypatches `ast.parse` or `json.loads` cannot change what the harness
parses, encodes or injects — and the wrapper looks the harness up in the NAMESPACE
(`injectInputs` re-binds it every cell), never through `sys.modules`, so a cell that pops
`sys.modules["_ml_harness"]` cannot force the import fallback onto patched modules. (4) No
JsProxy lands in the Python namespace: injected inputs are `None`/`str` via `undefined`, and
the stdout tee is Pyodide's JS-side `setStdout`, given the exact bytes (`stdoutWriter`; the `batched`
handler strips each line's newline). (5) asyncio pending handles are cancelled
before a cell's result is returned: every `asyncio.Task` from `all_tasks()` and every uncancelled `asyncio.Handle` that
`gc.get_objects()` reaches (#998; the route matrix in #987). Two classes that sweep does not reach, found by the red
team on 2026-10-23 and held as failing-first `{ todo }` tests in `tests/redteam-python-sandbox.test.mjs` (on main since
#987, 8c312e6a), assigned 2026-10-23 to the session `[window-ml python-cancel]` (`docs/plan/repl/PYTHON_CANCEL_GAPS.md`; the property, ruled there: nothing the cell scheduled runs AFTER its result is returned, so its `finally` running during the cancel, inside the cell's own time, satisfies it): a callable handed to a JS scheduler the strip keeps (`setTimeout`, `queueMicrotask`, `Promise.then`,
through `create_once_callable`/`create_proxy`) makes no Handle and fires after the result; and a started task kept on a
module keeps a live `_coro` that a later cell drives with `throw`, so the first cell's `finally` runs after its result
(the fix is to spend the coroutine in the cancel, not to leave it pending). The strip, the harness capture and the wrapper are
**escape-tested against real Pyodide** (`tests/redteam-python-sandbox.test.mjs`): a readonly
cell cannot reach `eval`/`Function`/`fetch`/`importScripts`, a patched `ast.parse` never
receives a later cell's source, popping `sys.modules["_ml_harness"]` does not hand the next
cell the import fallback, and `loadPackage` of a wheel still works after the strip. There is **no `mode`**
(removed 2026-10-19, lane 7): every cell runs in a hardened worker, inside the read-only dialect (no card) or outside
it (asks, the full gated `ml`).

**Membership is decided by RUNNING the cell under the fork's gate, never by its source alone**
(`docs/spec/PYTHON_DIALECT.md`, "Membership replaces `mode`"). The fork's `restricted.check()` admits `import`, calls
and attributes; which modules, calls and attributes are allowed is enforced only by the allow tables while
`restricted.run_cell` runs. So `import os` passes `check()` and is refused by `run_cell`. The path, for a run the
worker drives with `autoApprovePython` on:

1. The host's read-only try (`tryPythonInside`, `sw-run-host.ts`) runs the cell before the gate, with the run's grant
   marked `inside` (`grantRunPython`). `runPython` passes `inside` to the worker only for a `runGated` caller.
2. The worker loads the allow tables once (`dialectSetup` in `python-dialect-run.ts`, from `dialect-data.ts`, which bundles
   `notebooks/python-dialect/data/`). It refuses to run anything inside on a core without `_restricted`, or one whose
   `_restricted.build()` reports specialization, tier 2 or a JIT. On such a core every cell asks.
3. `wrapUserScript(…, inside)` runs the cell through `run_cell` (`INSIDE_CELL`, `python-dialect-run.ts`) in a COPY of the namespace that holds no `_` name.
   A bare trailing expression gets `return ` spliced in at its own column, so the value matches the full path.
4. If it finishes, its bindings are copied back, except a builtin's name or one starting with `_`, and only if every
   new binding and the value are DATA (`_ml_not_inert`, an allowlist on the exact type: scalars, the builtin containers,
   numpy arrays, pandas frames, series and indexes, object values walked), or exactly what the cell's own import
   statement bound (`_ml_imported`: `import numpy as np`, `from numpy import sum as total`), or a function the cell
   defined (every code object `CO_RESTRICTED`). The fork enters such code only inside a run (#895): a later inside cell
   calls it under the gate, and a full-path cell that calls it gets `NotInDialect: f() was defined in a cell that ran
   inside the read-only dialect, unasked, …; define it again in this cell to call it here`. Its defaults and closed-over
   cells are walked like any value. Anything else (a class, a module, an iterator, a captured builtin, an approved
   function under a new name), at any depth, makes the try a refusal: `it leaves 'f' holding …`. Nothing passes by
   identity: a value the namespace already held, under a NEW name (`a = ml`, `h = helper`), would hide from the card
   what it is (#896). The try writes nothing to the live stdout stream; its print reaches the call only when it finished.
5. If it is refused (`NotInDialect`, including the step budget and the memory cap, or a `SystemError` from an undo
   log that did not replay), the namespace is left as it was and the output and value are discarded. The worker
   answers `notInDialect`, with the fork's own line for a check-time refusal and the cell's frame's for a run-time one
   (the fork numbers both by the cell's lines). The try returns null. The gate then asks, with
   `askWhy = pythonOutsideWhy(where)` keyed by the cell's exact source. An edited cell has no entry and is outside.
   Approved, the cell runs on the full path, and only that run's result is the cell's.

`pythonCellInDialect` stays false for every cell: every path that has not run the cell treats it as outside. That
covers the page's own loop, a page-started cell, a grant's prefix and the run's call grant.
A grant keeps the old prefixes (`full:` outside, `readonly:` inside), so a stored `full:` grant still covers its code
and a stored `readonly:` one no longer does.
Config `autoApprovePython`
(ON by default, Advanced settings) lets the inside try run (badge provenance `sandbox`). A cell with hidden/bidi
characters (`suspiciousChars`, the same check the manual prompt shows), an unapproved external sheet or a raised
output cap is never tried: it goes to the prompt. Cost: one inside run measured against the same cell on the full
path in Node on the fork core (`tests/python-dialect-inside.test.mjs`, COST) differs by about a millisecond. The background
retries PY_RUN once if the offscreen doc was torn down (SW slept → "Receiving end does not
exist"). The sandbox's third-party packages are a **single source of truth** in
`python-env.ts` (`PY_PACKAGES`) — the offscreen `loadPackage`, the prelude imports, and the
tool description's "in scope" list all derive from it, so adding a package (e.g. pandas) is
one edit. When `python_exec` is in an `ml.agent` toolset, `PYTHON_CLAUSE` is appended to the
system prompt telling the model to **delegate** arithmetic/matrix/probability/precise
computation to it (it predicts tokens, it doesn't calculate) instead of guessing; when
`python_exec` is absent but `exec` is present, `EXEC_COMPUTE_CLAUSE` is the fallback
(compute deterministically in read-only JS — `Array`/`Math`/`.reduce`). Mutually exclusive. The
markdown/PDF export keeps the **raw tool-call args alongside** any rendered In (the sidebar
has a rendered⇄raw toggle; a static export can't, so it shows both). The `python-in` render
shows the input image AND, for a `{ table }` run, a **Jupyter/DataFrame-style `df` preview**
(`PyDfTable`: numbered index gutter, sticky header, zebra rows + vertical rules, right-aligned
monospace numbers, `NaN` styling, both-axis scroll — plus click-to-sort, drag-to-resize columns,
collapse, and copy-CSV; all zero-dep, no grid library). The export draws a **real `<table>`**
(a `table` Sink verb → `<table class="dftable">` for HTML/PDF, a GFM table for `.md`, uncapped).
A `table` selector loads the **FIRST** match; a `>1`-match warning is prepended (python_exec,
and the single-element `describeElement`/`ancestors` via `firstOfNote`) so a wrong pick isn't
silent. `examples/spreadsheet.html` is a table demo (a small static table + a toggleable
**Ridiculous mode**: a 40×12 dirty scrolling table). Its answers are in `examples/spreadsheet.answers.md` and
**never on the page**: they used to sit in HTML comments, which a read-only `exec` reaches through `outerHTML`
for free — one read away from every run (the bench's included) that was supposed to compute them. The page
must not NAME that file either, since an agent reading its own repo source could follow the path;
`tests/bench-specs.test.mjs` pins both.


**The Python bench is a bottom DRAWER (`BenchDrawer`).** It used to REPLACE the session view, so trying a
snippet cost you your place in the run you opened it from — which is exactly the trip you would be making
(copy this step's code, poke at it, look back at the step). The drawer is a SIBLING of the scroll container,
not content inside it, so the transcript keeps its own scroll position while you work below it. Draggable
from the top edge (how much you want depends on the script), `✕` closes WITHOUT discarding the draft, and
`⤢`/`⤡` swap it with the full-page mode — two real modes, since a drawer is bad for a long script and
full-page is bad for cross-referencing. **Full-page carries `✕` and `⤡` and NO `‹`**: back and dock meant the
same trip, differing only in whether the bench came with you, and two adjacent chevrons for that distinction
is the confusion itself — so both remaining controls are about the BENCH and the glyph says what happens to
it. Both **RETURN to the exact view you left** (`viewReturn`, shared with Settings and the server-tool list,
which had the same bug — glancing at a setting mid-run cost you the run you were reading); the return is read
only while you are somewhere that REPLACED a view, so a stale one cannot send you where you did not come
from. The dock is a remembered preference and `✕` does not reset it: `✕` is about the bench being open, `⤢`/`⤡`
about its shape, and conflating them makes one of them surprising.
Opening it puts the resource panel away: two draggable strips on the same bottom edge is not a layout. Open
state, dock and height all persist (`chrome.storage.local`) — it is a workspace you leave set up, not a
dialog you dismiss. Covered by `tests/e2e/bench-dock.spec.mjs`.

**The bench's ENVIRONMENT panel (`BenchEnv`).** What the sandbox actually IS — the Python and Pyodide
versions and every package you can import, each with the version that INSTALLED. Read from the running
interpreter (a `PY_RUN` with `env: true`, answered in the worker off the same serialized chain a run uses),
never from `PY_PACKAGES`: the manifest says what we ASKED for, and the wheel that installed is what the code
will import — a panel reporting the first while the second differs is worse than one reporting nothing.
A PANEL rather than a tooltip, because it is read while writing and is about to be searched and acted on;
filterable already, since that is how you will find a package to install. Fetched on OPEN, once — reading it
STARTS the sandbox, which is exactly what a first `python_exec` pays for, so doing it on mount would make
every glance at the bench cost a cold start. Installing a package and choosing which the model may import
are **stated in words, not drawn as controls that no-op**: an affordance that silently does nothing cannot be
told from a bug, so you try it twice.

**The bench editor's COMPLETION is Jedi, in the sandbox (`COMPLETE_HELPER`/`completeIn`, python-runtime.ts).**
Static analysis of the script being typed — it is never RUN — so a sandbox that holds no state is no limit for
anything reached through an import or written in the script: module attributes (`np.ara`), pandas frames
(`pd.read_csv(...).he`, via pandas' own stubs), literals, and the script's own functions all complete. It
**cannot** type an array returned by a numpy call (`grid = np.arange(24).reshape(4, 6)` → `grid.` offers
nothing): Jedi 0.19 cannot resolve numpy 2's stub layout. The bench's KEPT STATE fixes it: completion passes
the current mode's namespace (`complete.bench`), and `namespace` is the helper's one moving part — `None` is
Jedi's `Script`, a live namespace is its `Interpreter`, which completes the real object (`grid.su` → `sum` once
a run has defined `grid`; the static gap stays pinned in `tests/python.test.mjs`, so a Jedi that fixes it
announces itself). Six things are load-bearing:
- **The prelude is read IN FRONT of the script, never run** (`COMPLETE_CONTEXT` = `PRELUDE_BASE`, which every
  bench run executes first). So `np`/`pd`/`Image`/`to_base64` complete with NOTHING kept — before the first
  run, after a reset, after a restart — where the script alone completed none of them unless it imported them
  itself. It also serves the kept state, and is not redundant with it: a name the namespace holds is a LIVE
  module, which has no stubs to type a call's result, so through the namespace's `pd` alone
  `pd.read_csv(...).he` and `df.groupby('a').su` completed nothing. The namespace is for what the USER kept.
- **Lazy** (`PyPackage.lazy`, `PY_LAZY_LOADS`): the 1.6 MB of wheels are fetched with the rest but loaded on
  the first completion, never at start-up and never offered to the model.
- **Only once the sandbox is WARM** (`completeInSandbox` returns null until `benchEnv` is set): a completion
  starts Pyodide when it is cold, and a keystroke must not pay that start, nor push your first Run behind it.
- **A completion arms NO watchdog** (offscreen.ts). Every armed call gets a timer when it is POSTED, and a
  completion queued behind a long run would fire it mid-run and kill the worker — your script with it —
  because you typed. A hung completion is still cleared by the next run's own start bound.
- **The 15s cap is the SCRIPT's** (`PY_TIMEOUT_MS`). The timer armed at the post is the generous START bound
  (`PY_START_TIMEOUT_MS`, 120s: the queue ahead plus the cold start), and the worker's `started` message
  (runtime up, this run's turn) swaps in the 15s. Armed from the post, the cold start and any queue were charged
  to the script: a run queued behind an 8s one was killed three seconds into its own work, and on a loaded CI
  runner a first `time.sleep(4)` was killed by the boot alone, both with "simplify the computation".
- **Always locked down, and only from our own surfaces** (the `PYTHON_EXEC` choke point, `sender.url`): analysis
  can import a compiled module to inspect it, which must not reach the network even in `full` mode, and a
  page is refused rather than handed a new kind of request to the one sandbox.
- **Budgeted, with the static list as the floor** (`withRemote`, cm-editor.ts, 350 ms): the first request
  after warming loads Jedi and falls back, the next word gets it. Asked once per WORD — `validFor` narrows the
  same answer as you type. On a MEMBER (`np.zz`) a missing answer means no popup, never builtins offered as
  attributes; inside a string or comment it asks nothing (Jedi would complete the sandbox's file paths).
- **A kind Jedi could not RESOLVE is shown as no label, never as the wrong one.** numpy 2's stubs make Jedi
  call 35 of numpy's functions "module" (`np.arange` among them), so "module" is believed only when the name
  really is a loaded module (`sys.modules`); otherwise it is `""`. Only module/class/function/property/keyword
  are printed beside a name at all — `statement`/`instance`/`param` are Jedi's internals, not a reader's.

**A run's namespace (root C).**

ROOT C ([`docs/spec/PYTHON_DIALECT.md`](../spec/PYTHON_DIALECT.md), "The namespace"). Which cells share one dict:

- **Cells of the same worker-hosted run**, by run id: `wire.run` on `PY_RUN`, set only from `wireRun` (`worker-tools.ts`).
  The worker keeps `runs: Map<runId, { ns, id }>` (`python-worker.ts`), so the key is the run and nothing else.
- **Not** a page's `ml.pythonExec` or a page-hosted agent's `python_exec`: no run id, so the main namespace and the reset
  as before. **Not** the bench (`persist`): its own `benchNs`.
- **Injected names** (`df`, `tables`, `img`) are assigned into the dict by each cell that passes them and are not
  wiped when a later cell passes none. `RESET` never runs on a kept dict, so `_`-prefixed names persist too.
- **Ends** with the run: `settle()` (`sw-run-host.ts`) and `forgetRun` (`background.ts`) call `deletePythonRun`, which
  sends `PY_DELETE_RUN { run, principal: "run:<id>" }`; the offscreen document forwards it to that principal's worker as
  `deleteRun`, which destroys the dict, and clears its own `runPrincipals`, `runNsVars` and `nsLoss` entries.
- **Loss is told.** `killWorker` (timeout, start timeout, crash) records `nsLoss` for every run `runPrincipals` lists on
  the killed worker, whether or not one of its cells ever returned a scope manifest; the run's next cell opens its
  stdout with `namespace reset at <ISO time>: <timeout|start-timeout|crashed>` and the result carries `nsReset`. The
  offscreen document closing loses the dict without a record: the note comes only from a kill the document saw.
- **The state registry:** `python.run-namespace` (`defineState`, offscreen, audience `model`); its `read` is the last
  cell's scope manifest (`bench.vars`: names and type names).
- **Deleting reaches every worker holding the run's dict**, the shared `full` one included (`runPrincipals` in
  `offscreen.ts`), and empties the dict first, since the run's own functions keep it alive through `__globals__`.
- **The `full` worker is unreachable from the service worker** since `mode` went (`runPython` always sends `hardened: true`); its branch in `offscreen.ts` and `python-worker.ts` stays for the Pyodide-build lanes to delete. The residual it carried (two full-mode runs sharing one interpreter) is gone with it.
- **Not done:** an eviction rule by size (the dict is bounded by the worker's memory only).

Tests: `tests/python-run-namespace.test.mjs` (routing, through a fake Worker) and `tests/python-run-namespace-py.test.mjs`
(the dicts in real Pyodide).

**The bench KEEPS ITS VARIABLES between runs, like a notebook** (`wrapUserCode(..., persist)`, the worker's
`benchNs`). A `python_exec` outside a run stays stateless; the bench and a run's cells do not (a run's:
"A run's namespace", above), and six things make that safe for the bench:
- **Its own namespace, not main.** Main belongs to a `python_exec` with no run, which wipes it every call — so the
  first agent run would have erased a person's variables, and could have read them.
- **One namespace per MODE.** A `full` run can keep a live handle to the browser's network functions in a
  variable; carried into a `readonly` run it would quietly end the sandbox. Nothing crosses between them.
- **Top-level names are declared `global`** in the wrapper, chosen by Python's own `symtable` rather than a
  list of statement shapes. Without it `x = 1` is a local of `_user` and vanishes at the end of the run. A name
  a nested function declares `nonlocal` stays local, or the script would not compile.
- **Only `PRELUDE_BASE`** (imports + helpers). The injected-data part resets `img`/`df`/`tables` every run — it
  would wipe a bench user's `df` — and it keeps no loader redirect: it names no
  namespace for the shared patch (`__main__._ml_load_ns = None`), so a patch a run cell installed falls
  through to the real `Image.open`/`pd.read_*` for the bench rather than serving another namespace's names.
- **After a `python_exec`, main is reset** (worker `finally`): its injected screenshot and tables otherwise
  linger until the next run, where a bench script's `pd.read_csv("sales")` could reach them through the
  redirect.
- **A namespace has an `id`**, new whenever it is created afresh. When a run comes back in one the bench did
  not reset — the watchdog killed the worker, the extension reloaded — it says the variables are gone
  (`benchLost`) instead of leaving it to surface as a NameError. A reset arms no watchdog, for the same reason a
  completion does not.
Keep-state and reset are ours alone at the `PYTHON_EXEC` choke point: a page's `persist` is dropped and its
`benchReset` refused. The environment panel lists the current mode's variables (`BenchVars`) with the one Reset,
which clears both modes.

**One `openBench(code?)`.** There were two openers and they disagreed: a code block's ▶ went straight to the
FULL page, which is precisely the trip the drawer exists to stop — you press it FROM a step in order to
compare against that step. Both go through the one function now, which honours the dock preference and puts
the resource panel away. Caught by the demo, which is what a demo is for.


**A PYTHON COLD START is not the script.** The first `python_exec` of a session spends seconds fetching
Pyodide and its wheels before a line runs, and one elapsed figure charges the script for time it never
spent — the confusion a model's `load_duration` exists to settle. The **worker** measures it (it is the
executor; anything downstream measures the message bus too). `bootMs` is how long the CALL waited for the
runtime to finish starting, and is absent on a call that found it running. It is the call's wait rather than the
start's duration because of the pre-warm (below): a call arriving halfway through a pre-warmed start waited only
for the rest of it. It rides `ToolResult.remoteMs.bootMs` → the step → both surfaces:
the footer reads `ran in 4.2s — 3.0s cold start, 1.2s script`, and the event lane draws a **`boot` phase**
first, STRIPED like a model load because it is the step's wall time and none of the work you asked for. A
phase rather than its own span, because unlike a model load it happens INSIDE the dispatch `toolMs` already
measures — a span in front would draw the time twice.

**pyarrow LOADS AT START, and is prepared before any run.** It was built to load on demand (a text match on the
script, before it ran), and that cannot work: pandas decides whether pyarrow exists when PANDAS is imported —
`pandas.compat.pyarrow` sets `HAS_PYARROW`/`pa_version_under…`, a dozen modules copy those by value, and which of
its own arrow modules it imports depends on them — and the prelude imports pandas on the first run. pyarrow
arriving later left pandas half-switched: `to_parquet` died in `unregister_extension_type`, and patching the
flags moved the failure to `NameError: pa`. Measured in Node, loading it at start costs ~1.5 s of cold start
(3.1 s → 4.7 s); the pre-warm absorbs most of that, and pandas behaves the same in every run (its `str` columns
are pyarrow-backed from the first).

`PyPackage.prepare` runs once, before the lockdown, right after the start-up packages load (`PY_STARTUP_PREPARE`, in
`getPyodide`, then `lockdownReadonly`). pyarrow needs it: its `unix_timezones` dependency does `import js` at import time, and a `readonly`
run has no `js` — while its prelude's `import pandas` imports pyarrow. Importing it first, where `js` exists, puts
it in the module cache; but that module then HOLDS `js` as an attribute, and `import unix_timezones;
unix_timezones.js` would hand a locked-down script the global scope the strip removed, so `prepare` deletes it.
`tests/python.test.mjs` has the escape test, which fails with that deletion removed. A new package with a
`prepare` gets the same check: look for a `js` attribute on every module it brought in.

**THE PRE-WARM starts the runtime before anyone needs it**, on exactly two triggers: a run whose tools include
`python_exec` starting (`injected.ts`, beside the hosting decision, so both loop paths pass it), and the Commander
opening (`openComposer` in `shell.ts` — its runs always carry the tool). Never on a mere `ml.*` call: the runtime
and its packages cost real memory. Both send `PYTHON_PREWARM` with a `trigger`; the background creates the
offscreen document and posts `PY_PREWARM`; the worker calls `getPyodide("prewarm")` OUTSIDE the run chain and
answers at once with `started` or `already`. Outside the chain because a run arriving meanwhile must wait on the
start itself, and be charged for that wait, rather than queue behind a message that is waiting on it. Lazy
packages are never loaded early. It has no watchdog of its own: nothing waits on it, and a run that later waits on
a hung start arms its own start timeout. The housekeeping log records the trigger (`pyodide/prewarm`), the start
(`pyodide/cold-start`, `reason: prewarm`) and whether the first run after it found the runtime warm
(`pyodide/prewarm-used`) — which is how anyone finds out whether pre-warming pays for itself.

**`ml` inside Python is a FACADE over the `ml` wire, built and not yet wired** (`src/python/ml-facade.ts`; the wire:
`docs/spec/ML_WIRE.md`; the plan: `docs/plan/repl/LANE_1_PR2_DESIGN.md`). `_ml_make(send, codec)` returns `ml` and
`MlError`; every member is awaited (`rows = await ml.dereference("@tool:…", pipe=".rows")`), and which members exist is
the server's list, so nothing is copied into Python. A call sends ONE request, `{ seq, call, args }` (keyword arguments
as a trailing options object); the client and run are stamped by the offscreen document, never by the facade. Answers
decode as: `value` to plain data (`{"$bytes": …}` to `bytes`, `{"$secret": …}` to an opaque read-only handle), `pointer`
to an `MlPointer` whose token reads back through `ml.dereference`, `error` to a raised `MlError` with the wire's `code`.
Data shaped like a tag (an object whose one key starts with `$`) crosses wrapped as `{"$": …}` in
both directions and is unwrapped one level, so a fetched JSON `{"$bytes": …}` stays a dict and a cell's own
`{"$secret": …}` never crosses as a handle. A value marked `truncated` prints one line saying so. There is no ask path: a call that needs the person waits in the
transport, on the server's per-call suspension. Two rules the wiring must keep: `send` is a PYTHON callable (a cell can
reach it through the factory's closure, so a JsProxy there would be one in the namespace), and `codec` holds the
harness's references captured before any cell ran, never the importable `json`/`base64`, which a cell may patch.
Tested under real CPython against a fake transport: `tests/ml-facade.test.mjs`.

## Traps

- **A worker-hosted run keeps one namespace across its cells; every other call is stateless** (a page's `ml.pythonExec`, a page-hosted agent).
- **`readonly` mode hardens the sandbox and may auto-approve; `full` always asks.**
- **The wheels (`pyodide-wheels/`) are gitignored, and a missing set fails only at run time**, as
  `No module named 'numpy'`.
