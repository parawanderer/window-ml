# The Python sandbox and bench

Implementation notes for `python_exec` (offscreen Pyodide), its capability modes, the Python bench and its editor, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**`python_exec` — sandboxed Python (offscreen Pyodide).** An opt-in, `requiresApproval`
tool (`buildPythonTool`, like `clickTool`) for pixel/array/spatial work better done in Python
than JS. The service worker can't run WASM and the page main-world CSP blocks it, so CPython
runs in an **offscreen document** (`offscreen.ts`, extension-origin, its CSP allows
`'wasm-unsafe-eval'`): `background.js` `ensureOffscreen()` → `PY_RUN` message → the offscreen
doc, which relays to a **dedicated worker** (`python-worker.ts`) that actually runs Pyodide.
The worker exists because the offscreen doc shares a renderer process with the sidebar iframe,
so a compute-bound run on the main thread froze the sidebar's clicks (scroll — compositor thread
— still worked); off-main-thread keeps the UI responsive. The worker is chrome-free (resolves
Pyodide URLs via `self.location`), owns the run-serialization invariant, and `offscreen.ts` is a
thin id-matched relay. Pyodide is
(numpy/Pillow/**pandas**/**scipy**, bundled offline in `dist/pyodide/`, lazy-loaded — the
package set is single-sourced in `python-env.ts` `PY_PACKAGES`, which drives `loadPackage`, the
prelude imports, the tool-description labels, AND the wheel-fetch script; scipy is loaded but
not pre-imported, so a quick coord/table run doesn't pay its import cost). Each call is
**stateless** (the per-run namespace reset, above) — nothing carries between calls. The relay is the usual
contract — `PYTHON_EXEC_REQUEST` (page) → `PYTHON_EXEC` (bg). `ml.pythonExec(code, { image })`
screenshots `image` (a selector or `@pt`/`@box`) into the sandbox as `img` (PIL) + `img_np`
(numpy). **Tabular data → DataFrame(s) via `{ tables }`** — ONE unified param that is either a
single source (→ `df`) or a `{ varName: source }` map (→ each loaded under its name so the model
can `pd.merge` them; keys validated as Python identifiers by `pyVarNameError`, single-sourced in
`python-env.ts` beside the prelude's reserved names). Each df is bound BOTH under its name AND in a
`tables` dict — a model that mirrors the arg name and reaches for `tables['name']` just works
(the same accommodate-don't-fight tack as the read_csv redirect; `tables` is a reserved key). Each source auto-dispatches by shape
(`_loadTable`): **a `<table>`/ARIA-grid selector** is walked page-side (`extractTable`,
case-preserving; col/rowspans or a non-table fall back to `pd.read_html(outerHTML)` with bs4).
Before that fallback ships, `_resolveTable` **guards the cases read_html would choke on**: an
**empty table** (0 rows — a collapsed/lazily-rendered table like the `#bigsales` demo: the node
exists, its rows don't → pandas' `No tables found matching pattern '.+'`), a wrapper with **no
`<table>` inside**, or an **unparseable ARIA grid** each throw an actionable page-side message
("reveal/scroll it into view…") instead of the obscure downstream `ValueError`.
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
actually loaded** (never for a real file-like or a URL — a genuine http `read_csv` /
`Image.open(BytesIO)` passes through). Patched once (module attrs + `_`-prefixed originals survive
RESET; funcs resolve `img`/`tables` from `globals()` each call → current-run data, no stale
closure). And when that CAN'T resolve it — data preloaded but the code still errors trying to
(re)load it (`read_excel`/`read_json`/`open`/`requests`, an ambiguous name across many tables, a
URL in readonly), the tool **appends a redirect hint** ("use `df`/`img` directly") as the
fallback, catching any hallucinated load pattern on the failure. The tool
description frames the sandbox as "appending a cell to a live Jupyter notebook" (img/img_np/df
are pre-loaded) with a df/img snippet. Output (stdout/value/error) is capped by `clipOut`
(dom.ts, shared with `exec`) with a `[+N chars truncated]` count so a runaway result can't
flood context. The code runs in a **sandboxed namespace** (no DOM/fs) under
`contextlib.redirect_stdout` (byte-exact stdout, newlines intact) with its own try/except
(traceback captured, partial stdout preserved). A per-run namespace reset wipes non-`_`
globals so one run can't leak state into the next; the result is serialized via Python
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

**Two capability modes (agent-declared) + auto-approve.** The tool takes `mode`:
`"readonly"` (default) **hardens** the offscreen sandbox for that run — unregisters *and*
purges `sys.modules['js']`/`['pyodide_js']` (an `unregisterJsModule` alone leaves a prior
`full` run's cached `JsProxy` reachable), and nulls every network/exfil global
(fetch/XHR/WebSocket/Worker/**`importScripts`**/… + `navigator.sendBeacon`) so even
`pyodide.code.run_js` or a leaked proxy hits `undefined` — making it a pure function over the
inputs. Since Pyodide now runs in the **worker**, `js` resolves to the WorkerGlobalScope (not the
offscreen document), so `importScripts` — a worker-only fetch+eval vector — is in the null-list
too, and full mode's `import js` correspondingly has NO `js.document`/`js.window` (a worker has
no DOM), only network. `"full"` leaves the bridges intact (outbound network) and **always**
requires manual approval. Restored in
`finally`; PY_RUN is serialized so the global swap can't race. `harden`/`unharden` live in
`python-runtime.ts` (chrome-free) and are **escape-tested against real Pyodide**
(`tests/python.test.js`): a hardened run can't `import js`/`pyodide_js` or reach
`pyodide.code.run_js`, a `full` run's cached `import js` is still purged, and `full` mode
genuinely leaves the bridge open (why it needs approval). Config `autoApprovePython`
(ON by default, Advanced settings) auto-approves **readonly-mode** calls (badge provenance
`sandbox`) — but a `full` mode, or code containing hidden/bidi characters (`suspiciousChars`,
the same check the manual prompt shows), always falls through to the prompt. The background
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
Static analysis of the script being typed — it is never RUN — so the stateless sandbox is no limit for
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
- **Always hardened, and only from our own surfaces** (the `PYTHON_EXEC` choke point, `sender.url`): analysis
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

**The bench KEEPS ITS VARIABLES between runs, like a notebook** (`wrapUserCode(..., persist)`, the worker's
`benchNs`). `python_exec` stays stateless; the bench does not, and six things make that safe:
- **Its own namespace, not main.** Main belongs to the model's `python_exec`, which wipes it every run — so the
  first agent run would have erased a person's variables, and could have read them.
- **One namespace per MODE.** A `full` run can keep a live handle to the browser's network functions in a
  variable; carried into a `readonly` run it would quietly end the sandbox. Nothing crosses between them.
- **Top-level names are declared `global`** in the wrapper, chosen by Python's own `symtable` rather than a
  list of statement shapes. Without it `x = 1` is a local of `_user` and vanishes at the end of the run. A name
  a nested function declares `nonlocal` stays local, or the script would not compile.
- **Only `PRELUDE_BASE`** (imports + helpers). The injected-data part resets `img`/`df`/`tables` every run — it
  would wipe a bench user's `df` — and the loader redirects are defined in, and read, the namespace that runs
  them, so a second namespace would patch on top of the first and read the other's data.
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
executor; anything downstream measures the message bus too), charges it to the call that PAID for it and
reports nothing on every warm call after. It rides `ToolResult.remoteMs.bootMs` → the step → both surfaces:
the footer reads `ran in 4.2s — 3.0s cold start, 1.2s script`, and the event lane draws a **`boot` phase**
first, STRIPED like a model load because it is the step's wall time and none of the work you asked for. A
phase rather than its own span, because unlike a model load it happens INSIDE the dispatch `toolMs` already
measures — a span in front would draw the time twice.
