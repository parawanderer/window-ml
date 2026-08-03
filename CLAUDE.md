# CLAUDE.md — window.ml

Chrome extension (Manifest V3) that exposes a scripting API, `window.ml`, on
web pages and bridges it to local LLMs via OpenWebUI / Ollama. It's a
**console-first primitive**, not a chat app: the deliverable is a `window.ml`
object you call from any page's devtools console or from userscripts.

See `README.md` for the user-facing API and `docs/` for setup, cloud models,
and OCR. This file is the map for *extending* the code.

## Architecture (4 files + popup)

Requests flow: **page → content script → background worker → OpenWebUI**, and
back. This exists to bypass CORS — the background worker has host permissions
the page doesn't.

| File | World | Role |
| --- | --- | --- |
| `injected.js` | page main world | Defines `window.ml`. Serializes `<img>`/blob/http images to data URLs. Fires `ml:ready` + sets `window.ml.ready`. |
| `content.js` | isolated content-script world | Dumb relay: `window.postMessage` ⇄ `chrome.runtime.sendMessage`, via `HANDLE_MAP`. |
| `background.js` | service worker | Owns config, builds per-format request bodies, extracts replies, talks to the server. All privileged fetches happen here. |
| `popup.html` / `popup.js` | extension popup | Settings UI (`chrome.storage.sync`), model picker, Save & Test, VRAM readout, Free VRAM. |

`content.js` injects `injected.js` as a real `<script>` tag so `window.ml`
lives in the page's **main world** (reachable by page scripts/userscripts), not
the isolated content-script world.

## The message contract (how to add a primitive)

Every `window.ml` method that needs the server/privileges follows one pattern.
To add a new one, touch three files:

1. **injected.js** — call `makeBackgroundTaskPromise(REQUEST_TYPE, RESPONSE_TYPE, payload)`.
   It posts to the content script and resolves with the matching response.
2. **content.js** — add a `HANDLE_MAP` entry mapping `REQUEST_TYPE` →
   `{ type: BACKGROUND_MSG, responseType: RESPONSE_TYPE }`.
3. **background.js** — add an `if (message.type === BACKGROUND_MSG)` branch in
   the `chrome.runtime.onMessage` listener; do the work; `sendResponse({ data })`
   or `sendResponse({ error })`; `return true` to keep the channel open.

Existing message types: `FETCH_LLM`, `LIST_MODELS`, `GET_MODEL`, `GET_CONFIG`,
`SET_MODEL`, `MODEL_CAPS`, `LIST_SERVER_TOOLS`, `OLLAMA_PS`, `OLLAMA_UNLOAD`, `FETCH_IMAGE_B64`,
`CAPTURE_TAB`, `SAVE_SESSION`, `GET_SESSION`, `PYTHON_EXEC`, `FETCH_SHEET`. Plus
**`ABORT_TASK`** (cancel an in-flight task by requestId; the page posts `ABORT_REQUEST`,
`content.js` relays it) and the streaming `LLM_STREAM_*` port — both handled outside HANDLE_MAP.

**Resume (`ml.resumeChat(hash)`).** Continue a chat by its session hash.
Same-tab sessions resume from an in-memory `sessionRegistry` (every `createChat`
registers itself by hash); across reloads/tabs only `{ save: true }` sessions
survive — each turn persists via `SAVE_SESSION` → `chrome.storage.local`
(`ml_session_<hash>`), and `resumeChat` rehydrates via `GET_SESSION`, rebuilding a
history from the stored messages + createChat options (no secrets in a session).
The main world can't touch storage, hence the round-trip. A saved session is
readable by any page that knows its (random 8-hex) hash — fine for chat history,
which holds no credentials.

`GET_CONFIG` (`ml.config()`) returns the **non-secret** config subset
`{ model, ocrModel, apiFormat, utilityModel, utilityNumCtx, utilityForceCpu }` —
the URL and API key are never exposed to the page. `ml.agent` uses it to
auto-wire a vision (`look`) tool. The `vision` option: `null` (default) **probes** the
agent's model then the OCR model, adding `look` only on a positive Ollama capability (native
if the agent's own model sees, else delegated to the reader) — unknown/cloud never qualifies;
**`true` FORCES NATIVE** on the agent's own model (bypasses the probe — for a cloud/non-Ollama
model you know sees, e.g. minimax/gpt-4o); a model-id string forces a **delegated** `look` on
that model; `false` disables it.

`MODEL_CAPS` (`ml.capabilities(model)`) reads Ollama `/api/show` capabilities
(`["completion","tools","vision","thinking"]`); `modelSupportsVision` is derived
from it. Returns `null` when undeterminable (cloud model, old Ollama) — treat as
"unknown", never "no".

## Streaming (`onToken`)

Streaming is the **one path that bypasses `HANDLE_MAP`/`sendMessage`** — the
one-shot `sendResponse` can't emit many tokens. Instead it rides a **Port**:
`ml.chat(prompt, { onToken })` → `injected.js` `makeStreamingTaskPromise` posts
`LLM_STREAM_REQUEST` → `content.js` opens `chrome.runtime.connect({ name:
"LLM_STREAM" })` and relays each port message back as `LLM_STREAM_CHUNK` /
`_DONE` / `_ERROR` → `background.js` `onConnect` runs `streamLLM`, pushing
`{ type: "chunk", delta }` then `{ type: "done", content }`. `fetchLLM` and
`streamLLM` share `prepareRequest` (setup + `send(body, stream)`); each format
has a `streamChunk(line)` parser (OpenAI SSE vs Ollama NDJSON). Streaming is
text-only (skipped when `schema` set) but supports `toolIds` — it streams each
`SERVER_TOOL_MODES` attempt, and a handed-back attempt emits no content, so
nothing reaches the caller before the retry. The call still resolves to the
full string, so history behaves exactly as non-streaming. **Cancel** (`ml.chat({ onToken,
signal })`): the Port IS the cancel channel — on abort `makeStreamingTaskPromise` posts
`ABORT_REQUEST`, `content.js` **disconnects the matching Port** (tracked in `streamPorts` by
requestId), and `background.js` `onConnect`'s `port.onDisconnect` aborts the streaming fetch (a
`closed` guard stops posting to the dead port). Non-streaming `ml.chat`/`ml.step` cancel the same
way but via `ABORT_TASK` → the `inflight` `FETCH_LLM` controller (no port). Both kill the fetch.

## Config

`chrome.storage.sync`, schema in `DEFAULT_CONFIG`:
`chatUrl`, `apiKey`, `model`, `apiFormat` (`"openai"` | `"ollama"`), `ocrModel`.

**`DEFAULT_CONFIG` is duplicated in `background.js` and `popup.js` and must stay
in sync** (popup.js has a comment saying so). `popup.js` `FIELDS` must list
every editable key.

## API formats

`API_FORMATS` in `background.js` maps each backend to `{ buildMessage,
extractContent, extractToolCalls, expectedShape, applyFormat, streamChunk }`. `openai` uses
`choices[0].message.*` + `response_format`; `ollama` uses `message.*` +
`format`. Messages travel in a neutral `{ role, content, images?, tool_calls?,
tool_call_id? }` shape; each format converts to its wire form.

## Tools (ml.step / toolIds)

`FETCH_LLM` payload gained `tools` (client-side defs → `body.tools`), `toolIds`
(OpenWebUI server-side tools → `body.tool_ids`, rejected on the `ollama`
format), `raw` (return `{ content, tool_calls }` instead of the content
string, skipping the null-content error), `extend` (`"utility"` resolves the
utility model + its `num_ctx`/`num_gpu` in `prepareRequest`, right beside the
`ocr`/default model resolution; validated client-side in `injected.ts`), and
`numCtx`/`numGpu` (placed per-format by `applyRuntimeOptions`: an `options`
object on the ollama route; a `params` object on openai — OpenWebUI's
`apply_params_to_form_data` reads `params` and maps it into Ollama's options for
ollama-owned models, the same channel as `function_calling`; a direct `options`
object on that route is overwritten and top-level fields dropped. Explicit values
override the `extend` profile). Sending `toolIds` forces
`body.params.function_calling` to OpenWebUI's server-side execution loop so it
runs the tool and returns finished content; without it, the `native` mode
(OpenWebUI's default since v0.10.0) hands back an unexecuted `tool_call` (empty
`content`, `finish_reason: "tool_calls"`) that the page can't run. That loop's
label is version-dependent (`legacy` on v0.10.0+, `default` on older builds), so
instead of sniffing the version `fetchLLM` **probes `SERVER_TOOL_MODES` in
order** — send, check `isHandedBack`, retry with the next label, and throw a
clear error if every mode still hands the call back. `tool_calls` are normalized to
`{ id, name, arguments }` — OpenAI gives string args + real ids; Ollama gives
object args + no ids (`buildMessage` drops `tool_call_id` for Ollama tool
results). The **agent loop lives client-side** (`ml.step` in `injected.js`);
the extension deliberately ships no loop/whitelist/overseer — callers compose
those, keeping `window.ml` a primitive. **`ml.agent({ signal })`** takes an
`AbortSignal`: checked at each step boundary (before the model call, and after it
before running a tool), an abort stops the loop and **resolves** `{ cancelled: true }`
with the partial transcript (mirroring `hitCap`, not a reject). It also **kills the
in-flight request**: the signal threads `ml.step` → `makeBackgroundTaskPromise`, which
on abort posts an **`ABORT_REQUEST`** (→ `content.js` → **`ABORT_TASK`**) so the
background aborts the fetch keyed by that requestId (a per-request `AbortController` in
an `inflight` map — `FETCH_LLM` is the only registered honorer today), AND rejects the
page-side promise immediately so the loop's try/catch converts it to the same clean
cancel — no waiting on a slow local generation.

**Read-only `exec` auto-approve (experimental).** `exec` is `requiresApproval`,
but the config flag `autoApproveReadonly` (off by default) lets a **read-only DOM
survey** (`querySelectorAll → filter → map`, no mutation) run with **no prompt**
via a mediated mini-interpreter — `readonly-exec.ts` (`evalReadonly`), a
dependency-free tokenizer + Pratt parser + tree-walker bundled into
`injected.js`. It (1) *is* the whitelist — only the modeled dialect runs; (2)
never compiles a string, so it clears **Trusted Types** (Gmail); (3) is safe by
**mediation** — reads are denylisted (`constructor`/`ownerDocument`/`window`/…)
and calls are allowlisted to read/query/pure methods only, so no effectful method
(`fetch`/`click`/`setAttribute`/…) can be invoked even off a leaked `window`, and
`Function`/`eval` are unreachable. The agent loop's approval branch *tries*
`evalReadonly` and, on **any** `NotInDialect`/`Denied` throw, falls through to the
normal approval + `eval` path — safe because the interpreter is side-effect-free,
so a failed attempt does nothing observable. Deliberately incomplete: gaps
degrade to "asks the human," never to "runs unsafely."
The dialect also gets a **read-only `ml`** so self-introspection ("which model am I?" →
`await ml.getModel()`) is free rather than costing an approval. Not `window.ml`: `mlFacade`
builds a null-prototype object holding only `ML_READONLY_METHODS` (`getModel`/`config`/
`models`/`capabilities`/`ps`/`serverTools`), so the mutating (`setModel`/`unload`), token-
spending (`chat`/`agent`/`read`) and privileged (`pythonExec`/`screenshot`) halves aren't
*present* to reach; those names never join `ALLOWED_METHODS` (keyed by name across every
object) — the facade is checked by identity in `evalCall`. It grants no new capability (the
page can call `ml.config()` from its own console, and it's already the non-secret subset) —
it lifts a **prompt**, not a boundary. Since every ml method is async, `Evaluator.eval` is a
**generator**: `yield` to have the driver await. Two drivers — `runAsync` (top level) and
`runSync` for arrows a host method invokes (`.map` calls its callback synchronously), so an
`await` inside a callback throws `NotInDialect` → approval, never a silently Promise-valued
answer. A facade call is auto-awaited, so a forgotten `await` still reads the value — and the
shapes models actually write are supported: `Promise.all([…])` (`Promise` is a **namespace only**
— `all`/`allSettled` allowlisted, never callable/constructable) and `ml.getModel().then(m => …)`
(auto-await already left a value, so `then` applies an **inline** callback to it). The model
learns this from a RUNTIME section of `agent_api_docs` (`selfIntrospectionSection`) — beside the
HUD shortcut, and for the same reason: it's true only while the flag is on, and the system prompt
shouldn't pay for it on every run. Spec:
`docs/spec/READONLY_EXEC_SPEC.md`; the interpreter is unit-tested standalone against the two
canonical surveys, the `ml` gate, and a battery of escape attempts in
`tests/readonly-exec.test.mjs`.

**Visual element location (`locate` / vision).** For controls text/ARIA can't reach — unlabelled
icon buttons, or canvas-only UIs (a bare `<div>`/`<canvas>` with a synthetic click handler) —
`ml.locateTool` finds an element by **describing its appearance** ("a red umbrella icon", never a
name). Like `look`, it's a **delegated** vision sub-call: the model sees an annotated screenshot and
returns a badge number / coordinate; only a stateless `clickSelector` (or a `@pt:`/`@box:` token for a
canvas) re-enters the driver's thread, so a text-only driver can use it and the sub-call's image never
enters the driver's context. Auto-wired into `ml.agent` beside `look` whenever a vision reader resolves.

**Read `docs/LOCATE-VISION.md` before touching locate** — it's the whole pipeline, illustrated with
mermaid diagrams. It covers: the hit-testing primitive (`document.elementFromPoint`, NOT selector
matching) + the `representativeFor` walk-up; the delegation boundary; the four `strategy` dialects
(`marks` Set-of-Marks · `grounding` a coordinate VLM · `grid` numbered-cell classification ·
`grid-grounding`, plus `auto`); the letterbox → 1000×1000 / `groundingRange` coordinate mapping and its
inverse; the scoping tiers (`region` → `grid` → `cells` recursion; `selector`/`index`; the `@pt:`
snap-around-point — a fractal zoom); the canvas/`@pt` coordinate path (mint → `clickAt` → look-verify,
with the re-locate-loop dedup); the density guard, overlay-colour heuristic, debug-render substeps, and
the delegated-sub-call `num_ctx` resident-caching gotcha. All four original slices shipped (incl. the
canvas half: grid, grid-grounding, `@pt`). Pure geometry (`som.ts`) is unit-tested standalone
(`dist/som.js`, `tests/som.test.js`); scoping guards in `tests/agent.test.js`.

**Agent self-knowledge (`agent_api_docs`).** The agent had none: asked "how do I call you
from the console?" it answered from pre-training ("try typing `window`…"), because nothing in
its context named `window.ml` or the extension. Two pieces fix it. `SELF_CLAUSE` (prompts.ts,
appended like the other clauses when the tool is present) is the *identity* — one line saying
this run is an `ml.agent(task)` call inside a Chrome extension whose API the user drives from
the devtools console, plus "that's the user's handle on you, not one of your tools; don't call
it from `exec`". The `agent_api_docs` tool (no args, terse description) is the *reference*, and
it's **generated from `contract.ts`, never curated** — `scripts/gen-api-docs.mjs` lifts `MlApi`'s
public members with their JSDoc, drops the `_` plumbing, then chases the option/result types
they reference (transitively, minus a `SKIP_TYPES` denylist of render/debug internals — a bare
`chat(prompt, options?)` teaches the model nothing about `schema`/`think`/`onToken`) into
`api-docs.gen.ts` (**gitignored**, written by `build.mjs` before bundling and by
`npm run typecheck`; `tools.ts` imports it). ~4k tokens, so it stays behind a tool call rather
than in every system prompt. The tool's `run` **appends a RUNTIME section** the generated doc
can't hold: the HUD keyboard shortcut is **user-rebindable**, so it's read live via
`GET_INVOCATION` (a new background message → `chrome.commands.getAll()`) — reporting what's bound
*now*, whether that still matches the manifest (`isDefault`) or the user changed it, and `""` when
they cleared it (a hardcoded "Alt+Space" would eventually send someone to a dead key). The
rebinding URL is browser-correct: `browserInfo()` (util.ts, pure/unit-tested — prefers
`userAgentData.brands`, since Brave/Edge impersonate Chrome in the UA) maps the fork to its scheme
(`edge://`/`brave://`/…), and also adds a `Browser:` line to `pageContext()`. The lookup is bounded
by `INVOCATION_TIMEOUT_MS` and falls back to generic advice — a docs call must never stall a step.
The **context-menu** line is gated on the manifest declaring `contextMenus`, so it turns itself on
when that feature ships rather than advertising an affordance that doesn't exist yet. A
**HUD-started** run additionally gets `HUD_HINT` via `ml.agent`'s
`hints` (which APPENDS; `system` would replace the preamble) at the `__mlStartAgent` handler —
SELF_CLAUSE's "the user can drive you from the console" is true but isn't how *that* user
actually invoked it. It's a **line scanner, not a real parser**: `typescript@7` is the
Go port and exports only `version` — no JS compiler API — so TypeDoc/ts-morph would each mean a
second TypeScript in the tree. It leans on contract.ts's house style (top-level `export interface
X {`, one member per line, JSDoc above) and **throws** rather than silently truncating if that
stops holding; `tests/api-docs.test.mjs` regenerates and diffs the checked-in output, so a
contract.ts edit can't leave the shipped doc stale.

**Agent runs in the debug sidebar.** `ml.agent` emits its own debug-event kinds
(not `chat`): `agent` (run start: task + model), `agent-step` (a thought OR a tool
call with args/result; `elements` is a **count**, since real DOM nodes can't cross
the window bus — they still reach `onStep`), and `agent-result` (summary + steps +
`hitCap` + `cancelled`). **In-flight rendering:** a tool call emits `agent-step`
**twice** — a `pending: true` START (name + args + best-effort In render, no result
yet) the instant it's about to run, then the DONE (result + Out + approval), sharing a
monotonic `seq`. The sidebar `onDebug` **patches the row in place by `seq`** (immutably —
signals gotcha) instead of appending, so a running step shows a pulsing "running…" until
it fills in. The START is **sidebar-only** — `onStep`/`logStep` fire once, on the DONE
(a pending event has no result). A blocking `confirm()` defers the START's paint until
approved (the case inline approvals will remove — this is the observability half of that
keystone). All share the run's own session
hash (an agent run isn't a `createChat`), so the sidebar renders it as a distinct
"agent" session. It reuses `onStep`'s existing event stream — the tracer was
already there, this just tees it to `emitDebug`. A depth counter (`inAgentRun`)
suppresses `chat*` events while a run is in flight, so the auto-wired `look`
tool's internal `ml.chat` doesn't spawn orphan chat sessions (its result already
shows as the tool step). `agent` also carries the run's resolved `config`
(system prompt, tools, maxSteps, env/vision/hints) for the sidebar's "agent
options" block, and each tool step carries `argIssues` — a minimal page-side
JSON-Schema check (`validateArgs`: required/type/enum/unknown-prop) of the args
against the tool's `parameters`, rendered as a red strip (flat tool schemas
don't warrant ajv; swap it in there if a custom tool ships a complex schema).
An approval-gated call also carries `approval` (`"readonly"` = auto-approved via
the read-only interpreter · `"user"` = you approved · `"denied"` = you rejected),
shown as a green/red **provenance badge** + a matching left-border outline on the
step. That badge is the slot a future interactive-approval control resolves into.

**Tool render descriptors (two slots).** A tool step carries **two** independent
**serializable `RenderDescriptor`s** (`image`/`code`/`table`/`keyval`/`elements`/`locate`/
`python-in`/`python-out`) — data, never code, since functions can't cross the window bus and
page code must never run in the extension-origin iframe. `descriptorFor` fills each slot from
its **own hook** (no `target` field — the slot IS the hook):
- **In** (a visualization of the *call*) = the `ToolResult.renderIn` a `run()` returned
  (e.g. `python`'s notebook-cell header), else the tool's **`render(input, args)`** method
  (page-side, e.g. `exec`'s pretty JS). The sidebar renders the In block whenever there are
  args *or* a `renderIn`.
- **Out** (a visualization of the *result*) = the `ToolResult.render` a `run()` returned
  (e.g. `locate`'s badged image / `python`'s output — shown in the sidebar but, unlike
  `image`, NOT injected into the model's history), else an auto-derived `image`/`elements`
  from the envelope.
Either slot may be `undefined` → that block falls back to its raw view (args / result). The
sidebar (`RenderPanel`) is a registry keyed by `type` + a default fallback — it owns all UI,
so an unknown type just dumps as JSON. Custom-tool render is defensive (throw → fallback,
never breaks the run). The `agent-step` debug event carries `renderIn`/`renderOut`; the
export mirrors both (`python-in` → mode + input-image sidecar + source; `python-out` → an
image sidecar). A `code` descriptor may set `format: true` (the `exec` tool does)
→ the sidebar beautifies the JS with **js-beautify** before highlighting (bundled
into `sidebar-app` only, from the standalone `js-beautify/js/lib/beautify.js` —
the npm deps are CLI-only). Two sidebar-only code-block display prefs live in
`chrome.storage.local` (like the font scale, not in `MlConfig`): `ml_debug_codewrap`
(wrap ⇄ horizontal-scroll) and `ml_debug_codelines` (a line-number gutter). Both
ride `<html>` data-attributes (`data-codewrap`/`data-codelines`) so every code
block reacts at once; the gutter re-splits highlighted HTML per line (`htmlLines`
reopens spans that straddle a newline — matching `<` first, so a text run like
` searchResults` isn't misread as a `<span>`), and numbers stay aligned even when
a line wraps because each source line is its own flex row.

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
`to_base64(...)` image return is always shown. The debug render is the two-slot
`python-in`/`python-out` (above).

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
(off by default, Advanced settings) auto-approves **readonly-mode** calls (badge provenance
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
**Ridiculous mode**: a 40×12 dirty scrolling table) — both with comment-hidden answer keys.

**Export log.** The detail-view header has an "Export log" button opening a small
menu with two formats (chat and agent both). It serialises the in-memory session
(options, turns/steps, exec JS beautified, results, model provenance, timestamps)
— no new plumbing, it's all already in the `Session` object.

*One walk, two sinks.* `writeAgent`/`writeChat` walk the `Session` and emit through
a **`Sink`** — a deliberately small *semantic* vocabulary (`note`/`block`/`prose`/
`image`/`details`/…, never "bold this"), so each format renders those meanings its
own way. A third format = a third sink, not a third walker.

- **Markdown** (`mdSink` → `serializeSession` → `{ md, images }`). **Screenshots
  ship as real PNG sidecars**, because base64 in a text file is unreadable to a
  coding assistant but a `.png` can be opened: the sink decodes each data-URL and
  the markdown references `images/step-N.png`. A run with images downloads a
  **`.zip`** (`run.md` + `images/*.png`); a text-only run downloads a bare
  **`.md`**. The zip is written by a tiny dependency-free **store-method**
  `zipStore` (PNGs are already deflated, so no compression — local headers +
  central directory + a hand-rolled `crc32`). The iframe can't touch the
  filesystem, so it downloads via a `Blob` + `<a download>` click.
- **PDF** (`htmlSink` → `sessionToHtml` → `printSession`). A self-contained
  light-themed HTML doc (inline `PRINT_CSS` + the bundled Atom One *light* hljs
  theme, images inlined — a print doc has nowhere to put sidecars), loaded into an
  **offscreen iframe** (`.printframe`, off-page rather than `display:none`, which
  wouldn't lay out) from a Blob URL, then `contentWindow.print()` → the user picks
  "Save as PDF". Chrome seeds that **filename from the doc's `<title>`**, so it's
  set to the same `ml-agent-<hash>` base as the `.md` (a blank title falls back to
  the `blob:` URL). `@page` margins + `break-inside: avoid` on images/code/notes
  are the reason this isn't just the sidebar's stylesheet. The doc renders at the
  **extension's origin**, so the HTML sink pushes every dynamic string through
  `escapeHtml`/`markdown()`/`highlight()` (all three escape) — a hostile tool
  result or model reply can never inject markup. Disclosures are `<details open>`:
  a collapsed one prints as just its summary. Cleanup rides `afterprint` plus a
  long fallback timer, so a dismissed dialog can't leak the frame.

**Two surfaces (in-page overlay + DevTools panel).** The same `sidebar-app` bundle runs
in two places: the in-page **overlay** (a content-script shadow-root shell, `shell.ts`,
hosting `sidebar.html` in an iframe) and an optional **DevTools panel** (`devtools.ts`
registers a "window.ml" panel; `panel.html`/`panel.ts` host the *same* `sidebar.html`
iframe and play the same parent-relay role the shell does). `sidebar/app.tsx` is
untouched between them — the panel is byte-for-byte the overlay's app. Debug events reach
the panel by an **event-agnostic ONE-WAY stream**: `injected.js` → shell (forwards
`ML_DEBUG_EVENT`) → `background.ts` keeps a per-tab ring buffer (`DEBUG_BUFFER_CAP`) + fans
out to any connected `ml-devtools` port → `panel.ts` relays into the iframe (queuing until
the app handshakes `ready`). The buffer **replays on connect** (a panel opened mid-run
catches up); a fresh shell mount sends `ML_DEBUG_RESET` so stale events don't replay after
navigation. Spec: `docs/spec/DEVTOOLS_PANEL_PLAN.md`.

**Debug surface (`debugMode`).** One config, three values — `"off"` / `"overlay"` /
`"devtools"` (was the `sidebar` boolean) — set in the toolbar popup or Settings → Appearance.
`shell.ts` `applyMode` drives it: `overlay` mounts the in-page shell; `devtools` **attaches
the forwarder only** (relays `__mlDebug` to the background for the panel, draws NO overlay) and
posts `__mlSidebar:"ready"` **itself** (no iframe app to hand the handshake back) so injected.js
goes live; `off` attaches nothing (zero cost). The shell still acks `__mlSidebarShot` in
devtools mode so `look` screenshots work with no overlay to hide. The surfaces are
**exclusive** — the shell forwards to the background ONLY in `devtools` mode (overlay events
stay on the page). A DevTools panel can't be un-registered, so it's always a tab; `panel.ts`
reads `debugMode` and, when it isn't the active surface (`off`/`overlay`), swaps the app for a
self-explaining note instead of a misleading empty log. **Handshake race:** injected.js
announces `__mlSidebar:"hello"` when it loads and the shell re-sends `present`/`ready` on it —
without this, the shell's immediate `ready` (devtools mode has no iframe app to wait for) could
land before injected's async `<script>` was listening, stranding the panel un-live on Ctrl+R
until a settings toggle. `bus.ts` replays its ring only ONCE per session so the re-handshake
can't double-emit.

**Extending the sidebar — will it work in both surfaces?** *View/read features come free:*
a new debug **event kind** (the transport forwards any `__mlDebug` payload), a new
`RenderPanel` descriptor, session UI, export, or anything using `chrome.runtime`/
`chrome.storage` renders identically in both — it's the same app. *Two things don't:*
(1) a **new message the app posts to its parent** (the app→parent protocol is just
`__mlSidebarApp:"ready"` + `__mlLightbox`, both mirrored in `panel.ts`) must be handled in
`panel.ts` too; (2) anything that **acts back on the page** or **sends input into the
agent** (the session composer) needs a **reverse channel** — the debug transport itself
is one-way (page→panel). The overlay can reach the page (its parent is a content script);
the panel routes `panel → background → content-script shell`, keyed by the inspected
`tabId`. **Hover-highlight uses exactly this**: the app posts `__mlHighlight`; `panel.ts`
forwards it to the background as `ML_HL_REMOTE {tabId, ref}`, which `chrome.tabs.sendMessage`s
to the tab's `shell.ts`, which draws the box (in devtools mode it lazily mounts a
highlight-only shadow host, since no overlay is present). `SET_APPROVAL` is the same shape.
A future page-input channel would follow the pattern.

**Sources.** When a tool/RAG runs, OpenWebUI attaches provenance — top-level
`data.sources` (non-stream) or its own SSE line `{ sources: [...] }` (stream,
captured in `streamChunk`/`consume`). `fetchLLM`/`streamLLM` return
`{ content, sources }`; the `FETCH_LLM` response and stream `done` carry
`sources` alongside; `injected.js` attaches it to the stored assistant message
as `.sources`. Only OpenWebUI built-in **web search is UI-only** and never
reaches the API — use a web-search *workspace tool* (see
`examples/searxng_search.py`), which does.

**Resolved model (provenance).** The same return/relay channel also carries the
**resolved** `model` (`prepareRequest`'s model after the extend/ocr/default
resolution). `fetchLLM`/`streamLLM` return it, the `FETCH_LLM` response +
stream `done` + `content.js` relay pass it through, and `injected.js` puts it
(with the `extend` profile) on the `chat-result` debug event. The sidebar shows
it + a `utility` badge — so a session that ran on `extend:"utility"` (whose
client-side `request.model` is `null`) displays the real model, not `default`.

**Reasoning (thinking).** Same channel again: `extractReasoning` reads the
model's separate thinking text (OpenAI `reasoning_content` / Ollama
`message.thinking`; `streamChunk` accumulates the `reasoning_content` delta).
`fetchLLM`/`streamLLM` return `reasoning`; it rides the `FETCH_LLM` response,
stream `done`, and `content.js` relay, and `injected.js` puts it on the
`chat-result` event. The sidebar renders a collapsed "thinking" disclosure above
the reply. Modern models return thinking in this separate field, not inline
`<think>` (verified against the live server) — so there's no `<think>`-stripping
or `cleanup` option anymore; the reply `content` is stored verbatim.

**`think` placement (gotcha).** Like `num_ctx`, OpenWebUI's OpenAI route reads
`think` from the request-body **`params`** object, not top-level — a top-level
`think:false` is silently dropped (reasoning keeps coming). `applyThink` places
it per format: `params.think` (openai) vs a top-level `think` (ollama native).

## Conventions

- **Plain JS in docs/examples** — `document.querySelector`, never jQuery-style
  `$`/`$$` (those are devtools-only and read as dated).
- **Document functions with JSDoc** (`/** … */`, `@param`/`@returns` where useful),
  not a plain `//` block — so callers get the explanation on IDE hover at the call
  site. Inline `//` comments are for logic *inside* a body.
- **Tests: `npm test`** (Node ≥ 20, `node:test`). `tests/helpers.js` loads the
  real extension files into `node:vm` sandboxes with mocked `chrome`/`fetch`/
  `window`, so tests exercise the shipped code with no build step. Add a
  background-contract test to `tests/background.test.js` and a page-relay test to
  `tests/relay.test.js` for any new primitive. DOM-manipulating helpers
  (the agent tools) are tested against a real DOM via `loadDomWorld(html)`, which
  boots `injected.js` over a `jsdom` document. Live tests (`tests/live.test.js`)
  are opt-in via `.env` (see `.env.example`). **Real-CPython tests**
  (`tests/python.test.js`) load Pyodide-in-Node against the shared
  `python-runtime.ts` (built to `dist/python-runtime.js`) — the actual PRELUDE +
  `wrapUserCode` the offscreen sandbox runs, so the tables→df/auto-cast/`tables`
  dict/read_html/return-capture/RESET-isolation behaviour is checked against real
  pandas, not a copy. They need the bundled wheels (`dist/pyodide/`, from
  `npm run fetch-pyodide`) and **self-skip** when absent, so a bundle-less
  `npm test` stays green. CI fetches the wheels (cached by pyodide version) for
  both the test job (so these run) and the build job (so the uploaded extension
  artifact can actually run `python_exec`).

## Security invariants (don't regress these)

- **Config overrides (URL/key) are accepted only from the popup.** Page-relayed
  messages have `sender.tab` set; `background.js` strips overrides when it's set,
  so a hostile page can't repoint the saved API key at another host.
- Pages can change only the **model**, and `setModel` validates it against the
  server list.
- **Model-access filter (`modelFilter`, a regex whitelist, default empty).** When set,
  the wrapper only calls models whose id matches — enforced on the RESOLVED model in
  `prepareRequest` (main/ocr/grounding/utility all pass through) and in `setModel`, and
  `LIST_MODELS` filters its response so a page's `ml.models()` never even sees an excluded
  (e.g. cloud) model. Invalid regex fails **open** (a typo can't brick every call; settings
  flags it). `modelFilterAllows` (contract.ts, pure) is the single source shared by the
  background enforcement and the settings row/datalist markers. `modelFilter` is NOT in the
  `GET_CONFIG` public subset — the page can't read the filter.
- The background's cross-origin fetches rely on `<all_urls>` host permission,
  which "On click" site access withholds for third-party hosts (e.g. image
  CDNs) — a known limitation, not a bug. The popup's **Permissions → "Enable
  Google Sheets access"** requests just the Google origins at runtime
  (`chrome.permissions.request`), a narrower grant than "On all sites".
- **A privileged/credentialed background fetch MUST validate its target host —
  the client-side approval gate does NOT protect it.** The agent approval lives
  in `injected.ts`, but raw messages (`FETCH_SHEET`, …) are reachable by any page
  through the content-script relay, so a hostile page can call the handler
  directly. `FETCH_SHEET` fetches `credentials:"include"` (the user's cookies),
  so it's hard-locked to the `docs.google.com/.../export?` shape (`SHEET_URL_OK`)
  — without it, it's a cookie-authenticated "read any URL" exfil primitive.
  (`FETCH_IMAGE_B64` is *uncredentialed* — default `same-origin` — so it can read
  cross-origin public bytes but not the user's authenticated data.)

## Gotchas (hard-won)

- OpenWebUI has **no root `/v1/chat/completions`** (tested 0.9.5, 0.10.2) —
  external clients use `/api/chat/completions`. Unknown routes return the SPA
  HTML, so a non-JSON body means "wrong route."
- OpenWebUI **0.9.5** 400s external chat calls (`NoneType ... startswith`,
  issue #24550); fixed in 0.10.x. Workaround was the `/ollama/api/chat` passthrough.
- `think` is Ollama's param; sent only when a boolean. Cloud (non-Ollama) models
  may reject it — pass `{ think: null }` to omit.
- Vision fail-fast reads Ollama `/api/show`; for non-Ollama models it returns
  "unknown" and the request is sent anyway (degrades gracefully).
- Cross-origin `<img>` without CORS **taints the canvas**, so pixel readback
  fails even for already-rendered images — hence image fetching goes through the
  background worker, not a canvas.
