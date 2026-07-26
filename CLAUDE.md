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
**describing** it. (Illustrated end-to-end, DOM + canvas, with mermaid diagrams in
`docs/LOCATE-VISION.md`.) Engine (`som.ts`): the accessibility-agnostic primitive is
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
`"grounding"` (a coordinate VLM points at it), `"grid"` (below), `"grid-grounding"`
(grid narrows to a cell, then grounding pinpoints INSIDE it — the two-model combo for a
small target on a busy page/canvas where grid's cell-centre `@pt` only grazes; the grid
cell-pick just narrows `region` and **falls through into the grounding mechanism**, reusing
its whole snap/`@pt`/fallback pipeline, and renders as "Grid → Grounding" with the cell-pick
as substep 1; needs a grounding model — **or `grid-grounding({ cells })` skips the pick and
grounds straight inside the reused cell**), or `"auto"`
(grounding-first, marks fallback; `grid`/`grid-grounding` are explicit-only, never in `auto`).
**Canvas auto-upgrade:** a plain `strategy:"grid"` cell that lands on a `<canvas>` with a
grounder configured **auto-upgrades to grid-grounding** (grounding pinpoints inside the cell) —
on a canvas the snap can't mis-snap (no element), so it's a free precision win; the result
notes it, and a grounding whiff **falls back to the stashed cell centre** so the upgrade is
never worse than plain grid. Without a grounder, grid returns the cell centre and steers the
off-target case to zoom + the real neighbour cells (`adjacentCells`, named by direction, since
the driver never sees the grid). `@pt:…` is a **universal scope** (`selector`), not just a
grounding input: any strategy re-searches the point's box (grid-inside-a-point, etc.), `margin`
grows that box for a cut-off target. Grounding is **opt-in** config (`groundingEnabled`/`groundingModel`, off by
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
  candidate returns it directly; **several** → a **second vision sub-call** picks by badge
  (Set-of-Marks *within the selection*) rather than snapping to the first. `badgeMarks`/
  `askMarks` are shared with mechanism #2.

**Density guard + verify.** Pure Set-of-Marks over a dense page is unreliable (badges
overlap, the model misreads), and mechanism #2 only badges the first `SOM_BADGE_CAP` (40) of
up to 150 scanned. So when `> SOM_DENSE` (30) candidates exist, the result appends a warning
with the **true count**, the truncation, and a steer to strategy `grid` / a `selector` /
`look`. The `locate` **description also tells the driver to always verify the returned
selector with `look({ selector })` before acting** — a visual pick can be wrong, and it
empirically does better when it confirms first. The highlight colour (grid cell / picked
badge) is page-aware too (`pickAccentColor`, green-first) so it doesn't clash on a green
page.
- **Honest ambiguity** — an invalid selection, an empty region, or a marks hand-off that
  still can't decide returns the candidates + a steer (re-pick / raise `gridSize` / switch
  strategy), never a confident wrong pick.

**Locate debug render = substeps.** Every locate render is `{ mode, model, substeps[],
picked?, pickedBy? }` — `LocateSubstep[]` where each substep is either a **vision sub-call**
(grid cell-pick, Set-of-Marks pick, grounding box: carries `prompt` (In), the model's raw
`output` (Out), the exact `rawImage` sent + a human `image` overlay) or a **DOM snap** (just
`label`+`image`, no model). The sidebar (`LocateSubstepView`) renders each with a numbered
`[N]` head, a collapsible In(prompt), the image under a **raw⇄visualise** toggle (visualise
= the overlay by default; raw = the exact bytes the model saw), and a raw Out line — so a
multi-call locate (grid → hand-off; or an `auto` grounding miss → marks) reads as its
distinct stages, each with an optional grey-italic `note`. `pickedBy` drives the footer:
`"model"` → **"Model picked"** (chose a badge: marks / grid hand-off), `"snap"` →
**"Snapped to"** (the model localized a region, the DOM hit-test chose the element:
grounding, grid-single). The export mirrors it (each substep → a `step-N-subM.png` sidecar,
plus a `-raw.png` when the sent image differs from the overlay).

**Hierarchical refine**: the driver re-runs with the returned `cells` selection to zoom
(that union becomes the next region, a fresh aspect-grid inside) — driver-decided but
delegation-safe (the vision sub-call always picks; the driver only echoes cells the tool
*reported*, never authoring coordinates). Available whenever a vision **reader** resolves
(`model || groundingModel`), NOT gated on `groundingEnabled`. Grid reuses the `locate`
render (`mode:"grid"`: the grid the model saw with the selected cells highlighted +
`griddedImage`/`cells`/`cols`/`rows`, then the DOM-snap `resultImage`); it snaps to the DOM,
so the footer reads **"Snapped to"** like grounding.

**Overlay colour heuristic.** The grid lines and the SoM badges are **model-facing** (the
grounding image sent to the model is the plain letterbox; the element-location/box images are
human-only), so a fixed red vanishes on a red-themed page. `pickOverlayHex` samples the
image into a 12-bucket hue histogram and picks the palette colour that clashes least, also
hard-avoiding any colour **named in the description** (`colorWordHues` — so "the red
umbrella" is never overlaid in red, which the histogram alone won't repel for a tiny
target). Grid lines also get a dark casing so they survive a busy multi-colour page.
`pickOverlayHex`/`colorWordHues` are pure + unit-tested; the sampling/draw is a canvas op
(jsdom no-op).

**Delegated-model note.** Every vision sub-call (grid/marks/grounding) runs *standalone* —
its image + reply never enter the driver's context. When the sub-call's model **equals the
agent driver's** (so the matching name could read as "the driver saw this"), the sidebar
head and the export add a "· standalone sub-call (not in the agent's context)" note.

**Canvas/WebGL — the coordinate half (slice 3, part 2).** A `<canvas>` has **no sub-node
to snap to**, so when a pick's centre lands on one (`canvasAt` = `elementFromPoint().closest
("canvas")`), `locate` mints an **opaque point token** `@pt:<hex>` (a per-page `pointRegistry`
maps it to `{x,y}`) and returns *that* as the currency instead of the useless `#canvas`
selector — the driver copies the token **verbatim**, never authoring coordinates. Grounding
gives a **precise** point (its box centre — its whole strength on a canvas); grid gives the
**cell centre** + a zoom hint (`cells:[…]` re-centres it); marks refuses (nothing to badge)
and steers to those two. The **`click` tool decodes `@pt:`** → `clickAt(x,y)` synthesizes the
full pointer/mouse sequence (`pointerdown`/`mousedown`/`pointerup`/`mouseup`/`click`) at that
viewport coordinate — canvas games read `clientX-rect.left`, which the synthetic `clientX`
satisfies. A stale/unknown token fails cleanly ("re-run locate"). **Re-locate-loop guard:**
each mint is a fresh token even for the same coordinate, so a model that keeps re-locating a
hard target can circle back to the same wrong spot without noticing (observed: qwen2.5vl
grounding fixated on one point across 7 reworded descriptions). `nearbyPoint(x,y)` checks the
registry on mint; if the new point ~matches (≤12px) one already located this run, `locate`
appends a warning naming the prior token so the driver breaks the loop (change region /
description / strategy) instead of re-verifying it. The token registry +
`mintPoint`/`resolvePoint`/`nearbyPoint` live in **util.ts** (shared) so `ml.screenshot` resolves it too:
**`look({ selector: "@pt:…" })` verifies a canvas target** — `screenshot` returns a cropped
view around the point (radius `PT_LOOK_RADIUS`) with the exact click spot **marked** (a
contrast-coloured box), so the driver can confirm what it's about to hit before clicking (the
canvas analogue of `look({ selector })` on a DOM node; works for both the native and delegated
look). **"Snap around point" (`locate({ selector: "@pt:…" })`)** closes the loop: it scopes the
search to that *same* `PT_LOOK_RADIUS` box — the neighborhood the model just VISUALLY CONFIRMED
holds the target in its verify shot — and re-grounds inside it. The finest zoom tier, and the
only one seeded by a verified view rather than a guess: when the mark grazes a target that's
plainly in-frame, re-locating the box snaps precisely. The look(`@pt`) result discloses it. Detection
is robust to a pick **straddling page chrome above the canvas** (`canvasPointIn` samples the
whole box, not just the centre) and a `<canvas>` is dropped from a grid cell's candidates so
it never triggers a snap/hand-off — it becomes a coordinate. **Describe the target by
APPEARANCE, not a name** (the `description` param says so): the vision model reads pixels, so
"a red umbrella icon" works but "Morio"/"the delete handler" does not. Demo:
`examples/find-waldo.html` — a whole-scene `<canvas>` (zero DOM children) where only
vision + `@pt` click can win. Point decode is unit-tested (`tests/agent.test.js`); the
dispatch is a browser op (jsdom `elementFromPoint` is a no-op).

**Scope to a container (`selector`/`index`).** `locate({ selector, index })` crops the
search to one element's region (a list row, a toolbar, a card) — far more reliable for a
small target in a busy page. It scrolls the container into view first (like look/click),
clips the rect to the viewport (so the crop pixels and `projectFromSquare` stay in sync),
and rejects a not-found selector / a sub-`MIN_SHOT_PX` sliver with an actionable message
*before* any capture. Both mechanisms honour it: grounding crops+letterboxes the region;
marks runs `collectInBox(region)` and badges a **crop** of just that region (marks
translated to crop-local coords).

**Coarse pre-crop (`region`) — the level-0 split.** For a dense scene where a ~60-cell grid
is too many near-identical cells to pick a number from, `locate({ region })` crops the search
to a **named directional area** the model can produce from rough spatial "vibe" ("he's on the
left") long before it can read a cell number. `regionBox` (som.ts, pure/unit-tested) maps the
9 names — bands full-length (`left` = left side × full height), corners = quadrants, `center`
= middle box — with **halves overlapping by `REGION_OVERLAP`** so a midline target lands in
BOTH sides ("guess a side, try the opposite on a miss" always succeeds). It's just another
crop, applied right after `selector` scoping, so **every** strategy inherits it — the same
`region`/`scoped` narrowing selector uses. Three tiers now: **region (directional, lvl 0) →
grid (numeric cells, lvl 1) → `cells` recursion (lvl 2+)**, each using the model's strength at
that zoom. Dense-NONE and the too-many-cells advice steer to it first.

**grid-grounding `cells` reuse.** `grid-grounding` normally does its own grid cell-pick, but
`grid-grounding({ cells })` **skips the (nondeterministic) re-pick** and grounds directly
inside `cellsBox(cells)` — deterministic reuse of a prior grid result (re-rolling the pick can
return NONE on the same target). Handled by an early `ggReuse` branch that narrows `region` to
the cell and falls through to the grounding mechanism; the grounding-model guard fires for it
too. `cells` only map back under the **same `gridSize`**, so every emitted `cells:[…]` snippet
carries `gridSize: N` when non-default (the compact caveat). The look(`@pt`) verify result adds
a tip (`@pt`-only) steering a near-miss to `grid-grounding` + `cells`.

Delegated vision sub-calls (OCR, grounding, delegated `look`) cap `num_ctx` at
`VISION_NUM_CTX` (util.ts) so a vision model's huge default context doesn't pre-allocate tens
of GB of KV cache and OOM modest cards — NOT the native look (that reuses the agent's own
model). **But when the model is already resident with a ≥ window, the cap is replaced by the
RESIDENT value** (`residentContextLength` reads `/api/ps`, short-cached): a smaller num_ctx than
the loaded instance forces Ollama to reload, and for grid/marks the reader IS the agent's own
driver model — so the cap was thrashing the driver (reload down → reload up every sub-call),
adding latency and flapping the usage-bar denominator. Sending the resident value matches the
running instance (no reload) — **but NOT `undefined`**: an omitted num_ctx makes a mistaken
fresh load (stale ps cache raced an eviction) auto-size to the model's full window on a big-VRAM
box (qwen2.5vl → 128K, tens of GB of KV cache), so we send the believed value to keep even a
wrong load bounded. The liveness probes (sidebar Test-models grounding/OCR) cap the same way;
`VISION_NUM_CTX` lives in `contract.ts`. The cap only exists to bound a *fresh* load. `som.ts` unit-tested standalone (`dist/som.js`, `tests/som.test.js`:
`representativeFor` walk-up + `viewportBox`/`projectFromSquare` coord mapping +
`gridDims`/`validateCells`/`cellsBox`; `elementFromPoint`/canvas are jsdom no-ops); scoping
guards in `tests/agent.test.js`. The original design's slices 1–4 all shipped (incl. the
canvas/coordinate half — grid, grid-grounding, `@pt`; and slice 4's settings capability-RED,
`visionGate` in `sidebar/settings.tsx`), plus later additions (region tiers, snap-around-point,
canvas auto-upgrade, `@pt` dedup). Illustrated end-to-end in `docs/LOCATE-VISION.md`.

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
`'wasm-unsafe-eval'`): `background.js` `ensureOffscreen()` → `PY_RUN` message → Pyodide
(numpy/Pillow/**pandas**/**scipy**, bundled offline in `dist/pyodide/`, lazy-loaded — the
package set is single-sourced in `python-env.ts` `PY_PACKAGES`, which drives `loadPackage`, the
prelude imports, the tool-description labels, AND the wheel-fetch script; scipy is loaded but
not pre-imported, so a quick coord/table run doesn't pay its import cost). Each call is
**stateless** (the per-run namespace reset, above) — nothing carries between calls. The relay is the usual
contract — `PYTHON_EXEC_REQUEST` (page) → `PYTHON_EXEC` (bg). `ml.pythonExec(code, { image })`
screenshots `image` (a selector or `@pt`/`@box`) into the sandbox as `img` (PIL) + `img_np`
(numpy); **`{ table }`** (a `<table>`/ARIA-grid selector) loads it as `df` (pandas) — a clean
table is walked page-side (`extractTable`, case-preserving; col/rowspans or a non-table fall
back to `pd.read_html(outerHTML)` with the bs4 parser). Numeric columns are **auto-cast
page-side** (`dom.ts` `castTableColumns`, pure/tested: a column ≥90%-numeric after stripping
currency/commas/%/accounting-parens → `number|null`, else strings) so `df.sum()` adds instead
of string-CONCATENATING — `{ tableRaw }` skips it for ZIP/SKU/leading-zero IDs. The tool
description frames the sandbox as "appending a cell to a live Jupyter notebook" (img/img_np/df
are pre-loaded) with a df/img snippet. Output (stdout/value/error) is capped by `clipOut`
(dom.ts, shared with `exec`) with a `[+N chars truncated]` count so a runaway result can't
flood context. The code runs in a **sandboxed namespace** (no DOM/fs) under
`contextlib.redirect_stdout` (byte-exact stdout, newlines intact) with its own try/except
(traceback captured, partial stdout preserved). A per-run namespace reset wipes non-`_`
globals so one run can't leak state into the next; the result is serialized via Python
`json.dumps` (leak-proof — no nested JsProxy) with a numpy-scalar `.item()` coercer, and both
`return X` and a bare top-level `result = X` are captured (`global result` + a return
fallback). Returns come back as **text by default**; `cast:"pt"`/`"box"` validate the return
and mint a clickable `@pt`/`@box` (mismatch → an honest error, never a guess), and a
`to_base64(...)` image return is always shown. The debug render is the two-slot
`python-in`/`python-out` (above).

**Two capability modes (agent-declared) + auto-approve.** The tool takes `mode`:
`"readonly"` (default) **hardens** the offscreen sandbox for that run — unregisters *and*
purges `sys.modules['js']`/`['pyodide_js']` (an `unregisterJsModule` alone leaves a prior
`full` run's cached `JsProxy` reachable), and nulls every network/exfil global
(fetch/XHR/WebSocket/Worker/… + `navigator.sendBeacon`) so even `pyodide.code.run_js` or a
leaked proxy hits `undefined` — making it a pure function over the inputs. `"full"` leaves the
bridges intact (outbound network) and **always** requires manual approval. Restored in
`finally`; PY_RUN is serialized so the global swap can't race. Config `autoApprovePython`
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
shows the input image AND, for a `{ table }` run, the extracted `df` preview (capped);
`examples/spreadsheet.html` is a table demo with a comment-hidden answer key.

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
`panel.ts` too; (2) anything that **acts back on the page** (DOM-node highlight) or **sends
input into the agent** (the session composer) needs a **reverse channel** that doesn't
exist yet — the transport is one-way (page→panel). The overlay can reach the page (its
parent is a content script); the panel would need `panel → port → background → content
script → injected.js`, keyed by the inspected `tabId`.

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
