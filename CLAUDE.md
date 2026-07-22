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
`SET_MODEL`, `MODEL_CAPS`, `OLLAMA_PS`, `OLLAMA_UNLOAD`, `FETCH_IMAGE_B64`,
`CAPTURE_TAB`, `SAVE_SESSION`, `GET_SESSION`.

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
auto-wire a vision (`look`) tool from the OCR model.

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
full string, so history behaves exactly as non-streaming.

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
those, keeping `window.ml` a primitive.

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
degrade to "asks the human," never to "runs unsafely." Spec:
`docs/spec/READONLY_EXEC_SPEC.md`; the interpreter is unit-tested standalone (built to
`dist/readonly-exec.js`) against the two canonical surveys + a battery of escape
attempts in `tests/readonly-exec.test.js`.

**Visual element location (`locate` / Set-of-Marks).** For controls text/ARIA can't
reach — unlabelled icon buttons, or pages built with no accessibility markup at all
(a bare `<div>` with a synthetic click handler) — `ml.locateTool` finds an element by
**describing** it. Engine (`som.ts`): the accessibility-agnostic primitive is
`document.elementFromPoint` (hit-testing), NOT selector matching — `collectCandidates`
sweeps the viewport on a grid, takes the topmost element at each point (so occluded
ones are excluded for free), and climbs each to its representative (`representativeFor`:
nearest semantic-interactive ancestor, else the `cursor:pointer` boundary — the one
convention non-semantic UIs keep, since click handlers are invisible to the DOM on
React/synthetic-event pages). Candidates get numbered badges drawn onto the screenshot
in memory (`drawMarks`, dpr-scaled like `cropDataUrl` — zero DOM pollution). It's
**delegated** like `buildLookTool`: a vision sub-call ("which badge is <description>?")
sees the badged image and returns a number; only the chosen element's `clickSelector`
(stateless currency for click/type/answer) re-enters the driver's thread, so a
text-only driver can use it. The badged image rides `ToolResult.render` → sidebar only,
never history. Auto-wired into `ml.agent` alongside `look` whenever `_resolveVisionModel`
resolves a reader (agent-model-if-vision → OCR model).

**Three mechanisms, driver picks (`strategy`).** `locate({ strategy })` — `"marks"` (above),
`"grounding"` (a coordinate VLM points at it), `"grid"` (below), or `"auto"`
(grounding-first, marks fallback; `grid` is explicit-only, never in `auto`). Grounding is **opt-in** config (`groundingEnabled`/`groundingModel`, off by
default — it loads a 3rd model into VRAM): the search region is **letterboxed** into a
**1000×1000 square** (`letterboxToSquare` — aspect-preserving; a stretch mangles an
arbitrary-shaped crop) so one configurable **`groundingRange`** (the coord divisor, default
1000) covers every convention at once — 0–1000 normalized, qwen2.5vl's
absolute-pixels-of-the-sent-image (now == 0–1000), 100 (Molmo %), 1024 (PaliGemma), 1 (0–1
floats). The inverse is `projectFromSquare` (**one** scale = the region's longer side on
both axes, + the region's viewport offset; padding-coords clamp to the region edge) — NOT
`viewportBox`'s per-axis stretch inverse, which survives only to draw the model's box onto
the square it saw. The box is snapped to the DOM by the same `elementFromPoint` sweep
(`collectInBox`), so the model only has to be directionally right. `margin` grows the box on
a retry, reusing a **per-run box cache** (the VLM call is the cost; re-sweeping is free) —
and it only helps a *returned* box that missed, so a no-box retry with a margin is refused
with that explanation. An **`auto` grounding miss** isn't discarded: the marks fallback
render carries `fallbackNote`/`fallbackImage` (why it missed + what the model saw), and the
model-facing result gets a short "(Grounding …)" prefix.

**Grid mechanism (`strategy:"grid"`).** `drawGrid` overlays a numbered grid on the region
and asks the reader *"which cell(s) hold the target?"* — multiple-choice classification, so
it needs **no coordinate training** (any vision model) and **can't hallucinate an (x,y)**.
Four pieces make it actually converge (learned from a toolbar run where a plain 4×4 put all
five icons in one cell and snapped to the wrong one):
- **Aspect-matched dims** (`gridDims`, from `gridSize` base ≈ cell count) — a wide toolbar
  gets more columns than rows instead of a square grid wasting its empty rows.
- **Multi-cell pick** — the model may answer with 1, 2 (edge-adjacent), or 4 (a 2×2 block)
  cells so a target *straddling* a grid line is fully covered; `validateCells` rejects
  non-adjacent / L-shape / 3-cell picks, `cellsBox` unions the selection into one Box.
- **Marks hand-off** — after unioning + the `collectInBox` sweep, a region with **one**
  candidate returns it; **several** → it hands off to Set-of-Marks *within the selection*
  (badge + pick) rather than snapping to the first. `badgeMarks`/`askMarks` are shared with
  mechanism #2.
- **Honest ambiguity** — an invalid selection, an empty region, or a marks hand-off that
  still can't decide returns the candidates + a steer (re-pick / raise `gridSize` / switch
  strategy), never a confident wrong pick.

**Hierarchical refine**: the driver re-runs with the returned `cells` selection to zoom
(that union becomes the next region, a fresh aspect-grid inside) — driver-decided but
delegation-safe (the vision sub-call always picks; the driver only echoes cells the tool
*reported*, never authoring coordinates). Available whenever a vision **reader** resolves
(`model || groundingModel`), NOT gated on `groundingEnabled`. Grid reuses the `locate`
render (`mode:"grid"`: the grid the model saw with the selected cells highlighted +
`griddedImage`/`cells`/`cols`/`rows`, then the DOM-snap `resultImage`); it snaps to the DOM,
so the footer reads **"Snapped to"** like grounding.

**Delegated-model note.** Every vision sub-call (grid/marks/grounding) runs *standalone* —
its image + reply never enter the driver's context. When the sub-call's model **equals the
agent driver's** (so the matching name could read as "the driver saw this"), the sidebar
head and the export add a "· standalone sub-call (not in the agent's context)" note.

This is slice 3's **DOM-first** half; the canvas/WebGL half (a cell over a bare `<canvas>`
has no sub-node → an opaque coordinate currency + a coordinate-click primitive) is a
deliberate follow-up.

**Scope to a container (`selector`/`index`).** `locate({ selector, index })` crops the
search to one element's region (a list row, a toolbar, a card) — far more reliable for a
small target in a busy page. It scrolls the container into view first (like look/click),
clips the rect to the viewport (so the crop pixels and `projectFromSquare` stay in sync),
and rejects a not-found selector / a sub-`MIN_SHOT_PX` sliver with an actionable message
*before* any capture. Both mechanisms honour it: grounding crops+letterboxes the region;
marks runs `collectInBox(region)` and badges a **crop** of just that region (marks
translated to crop-local coords).

Delegated vision sub-calls (OCR, grounding, delegated `look`) cap `num_ctx` at
`VISION_NUM_CTX` (util.ts) so a vision model's huge default context doesn't pre-allocate tens
of GB of KV cache and OOM modest cards — NOT the native look (that reuses the agent's own
model). `som.ts` unit-tested standalone (`dist/som.js`, `tests/som.test.js`:
`representativeFor` walk-up + `viewportBox`/`projectFromSquare` coord mapping +
`gridDims`/`validateCells`/`cellsBox`; `elementFromPoint`/canvas are jsdom no-ops); scoping
guards in `tests/agent.test.js`. Slices
1–3 (DOM-first) of `tmp/visual_element_selection_design.md`; grid's canvas/coordinate half
and slice 4 remain.

**Agent runs in the debug sidebar.** `ml.agent` emits its own debug-event kinds
(not `chat`): `agent` (run start: task + model), `agent-step` (one per step — a
thought OR a tool call with args/result; `elements` is a **count**, since real
DOM nodes can't cross the window bus — they still reach `onStep`), and
`agent-result` (summary + steps + `hitCap`). All share the run's own session
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

**Tool render descriptors.** A tool step can carry a `render`: a **serializable
`RenderDescriptor`** (`image`/`code`/`table`/`keyval`/`elements`/`locate`) — data, never
code, since functions can't cross the window bus and page code must never run in
the extension-origin iframe. `descriptorFor` resolves it in priority order: a
`render` descriptor the tool's **`run()` returned directly** on its `ToolResult`
(for a visualization computed at run-time, e.g. `locate`'s badged image — shown in
the sidebar but, unlike `image`, NOT injected into the model's history) → the tool's
optional **`render(input, args)`** method (runs page-side, e.g. `exec`) → auto-derive
`image`/`elements` from the envelope → `undefined` (the default In:/Out: view). The sidebar (`RenderPanel`) is
a registry keyed by `type` + the default fallback — it owns all UI, so an unknown
type just dumps as JSON. Custom-tool render is defensive (throw → fallback, never
breaks the run). A `code` descriptor may set `format: true` (the `exec` tool does)
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

**Export log.** The detail-view header has an "Export log" button →
`serializeSession(session)` → `{ md, images }`, downloaded (chat and agent both).
It serialises the in-memory session (options, turns/steps, exec JS beautified,
results, model provenance, timestamps) — no new plumbing, it's all already in the
`Session` object. **Screenshots ship as real PNG sidecars**, because base64 in a
text file is unreadable to a coding assistant but a `.png` can be opened: an
`addImage` callback decodes each data-URL, and the markdown references
`images/step-N.png`. A run with images downloads a **`.zip`** (`run.md` +
`images/*.png`); a text-only run downloads a bare **`.md`**. The zip is written by
a tiny dependency-free **store-method** `zipStore` (PNGs are already deflated, so
no compression — local headers + central directory + a hand-rolled `crc32`). The
iframe can't touch the filesystem, so it downloads via a `Blob` + `<a download>`
click.

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
- **Zero runtime dependencies.** The shipped extension uses only built-ins; the
  only dev dependency is `jsdom`, for the DOM-helper tests (never bundled).
- **Tests: `npm test`** (Node ≥ 20, `node:test`). `tests/helpers.js` loads the
  real extension files into `node:vm` sandboxes with mocked `chrome`/`fetch`/
  `window`, so tests exercise the shipped code with no build step. Add a
  background-contract test to `tests/background.test.js` and a page-relay test to
  `tests/relay.test.js` for any new primitive. DOM-manipulating helpers
  (the agent tools) are tested against a real DOM via `loadDomWorld(html)`, which
  boots `injected.js` over a `jsdom` document. Live tests (`tests/live.test.js`)
  are opt-in via `.env` (see `.env.example`). CI runs offline tests on push.

## Security invariants (don't regress these)

- **Config overrides (URL/key) are accepted only from the popup.** Page-relayed
  messages have `sender.tab` set; `background.js` strips overrides when it's set,
  so a hostile page can't repoint the saved API key at another host.
- Pages can change only the **model**, and `setModel` validates it against the
  server list.
- The background's cross-origin fetches rely on `<all_urls>` host permission,
  which "On click" site access withholds for third-party hosts (e.g. image
  CDNs) — a known limitation, not a bug.

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
