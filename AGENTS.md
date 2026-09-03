# CLAUDE.md — window.ml

Chrome extension (Manifest V3) that exposes a scripting API, `window.ml`, on
web pages and bridges it to local LLMs via OpenWebUI / Ollama. It's a
**console-first primitive**, not a chat app: the deliverable is a `window.ml`
object you call from any page's devtools console or from userscripts.

See `README.md` for the user-facing API and `docs/` for setup, cloud models,
and OCR. This file is the map for *extending* the code.

## Layout

The extension's own sources live in **`src/`** — every `.ts`/`.tsx`, `src/sidebar/`, and the two
extension pages (`popup.html`, `offscreen.html`). Everything else stays at the root: `tests/`,
`scripts/`, `tools/`, `docs/`, `manifest.json`, `build.mjs`. Paths in this file name files by their
bare name (`background.ts`, `sw-llm.ts`) — they are all under `src/`.

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

`background.ts` is the message router + run/approval/consent/print/nav spine;
three cohesive leaf layers are split into their own modules it imports (all
bundled back into `dist/background.js` by esbuild, so the split is invisible at
runtime and to the tests, which load the bundle): **`sw-llm.ts`** (the
per-format request builders `API_FORMATS`, `getConfig`, model-capability probes,
`fetchLLM`/`streamLLM`/`streamAgentTurn` + `prepareRequest`, the model-list /
`setModel` / unload plumbing), **`sw-fetch.ts`** (the ml.fetch GET, the rendered
background-tab fetch, and the credentialed Google Sheets CSV pull — the
security-sensitive fetch guards `SHEET_URL_OK` + the response-header safelist
live here), and **`sw-cdp.ts`** (the `chrome.debugger`/CDP layer: attach
lifecycle + `cdpClick`/`cdpEval`/`cdpScreenshot`/`cdpShadowResolve`/`cdpKeyType`).

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

**RULE — a new settings flag goes in the DevTools Settings panel, ALWAYS.** The
**DevTools Settings panel is the SUPERSET** of the toolbar popup: every user-editable
config surfaces there. The popup is a curated subset (the common knobs). So when you
add a config flag: it MUST appear in DevTools Settings; adding it to the popup too is
optional (only for a common knob). Never add a flag to the popup WITHOUT also adding it
to DevTools Settings — that would make the popup the superset, inverting the rule.

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
but the config flag `autoApproveReadonly` (ON by default) lets a **read-only DOM
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

**RULE — extending the dialect requires adversarial tests.** Any time you add a construct to the
read-only dialect (a new statement/operator/pattern, a new allowed method, a new facade member),
you MUST — without being asked — add ADVERSARIAL tests that try to abuse the NEW pattern to reach
something it shouldn't (extract/invoke an effectful method, walk to `window`/`constructor`/a realm,
mutate, spend tokens, loop unbounded) and assert each is REJECTED (`NotInDialect`/`Denied`) or
rendered inert (the `METHOD_REF` sentinel). A new binding form (e.g. destructuring) must be probed
for whether it can bind a live method or reach a denied prop; a new allowed method for whether its
return leaks the realm. The invariant is unchanged: gaps degrade to "asks the human," never to "runs
unsafely" — new tests prove the new surface keeps that.

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
canvas half: grid, grid-grounding, `@pt`). Pure geometry (`locate.ts`) is unit-tested standalone
(`tests/locate.test.mjs`, importing the source directly via tsx); scoping guards in `tests/agent.test.js`.

**Snap-inject (skip the verify `look`).** When grounding actually SNAPS on something at the end,
`feedBack` (in `buildLocateTool`) feeds the marked crop straight into the driver's context so it can
confirm in-turn and go `locate → click` instead of `locate → look → click`. Only fires on the
grounding-box success returns — NOT the grid cell-CENTRE fallback ("may graze"), which stays manual by
design (grounding gives no confidence score; the binary snapped-vs-fell-back IS the signal). An `@pt`
ALWAYS injects (the model always verifies a coordinate); a DOM selector / `@box` only when the caller
passes **`verify:true`** (structurally a `look()` on the result folded into the same call). A vision
driver gets the crop as an inline **image**; a text-only driver gets a delegated **description** of it (a
reader sub-call) with a clarification that it can't see the image. **"Does the driver see natively"
(`driverSees`) + the resolved reader (`visionModel`) are resolved ONCE in the auto-wire and carried on
the `ToolContext`** (`tool-exec.ts` `toolContext`; page loop + the background-delegated path in
`run-delegation.ts` both build it from the same values) — so `locate`'s feedback reads the SAME answer
that chose native-vs-delegated `look` instead of re-deriving it. That double-resolution was a real bug: a
second `_modelSees(agentModel)` probe disagreed with `_resolveVisionModel` when `agentModel` resolved null,
forcing a vision-capable Ollama agent onto the delegated "you can't see images" path. `driverSees` is now
`visionModel === runModel` (the reader IS the agent's own model), and `runModel` is resolved once (was
computed twice). Near-area **dedup**: a per-run `VisionMemory` (`{ seen }`,
shared by the auto-wired `look` + `locate`; `markSeen`/`seenNearby` in util.ts, radius `PT_LOOK_RADIUS`)
records the spots the driver was shown, so a re-snap onto an already-seen point doesn't re-inject the
near-identical crop (the re-snap-loop case). What got injected + WHY rides a `ToolFeedback` on the
result → the `agent-step` event → a **"Sent to the model"** section in the sidebar (`FeedbackBlock`) and
the export (both surfaces, per the render-in-both rule). Dedup logic unit-tested in `tests/util.test.mjs`.

**`verify` on `click`/`type` (fold the post-action `look`).** The other constant chain is
*do-the-task → look*, so `click`/`type` take an optional **`verify:true`** (never automatic — the param
description says "set it if you'd `look()` right after"). After the action, `verifyAfterAction`
(builtin-tools.ts) captures a **general-area** crop (a `@pt` minted at the element's centre, screenshotted
with `VERIFY_MARGIN` — bigger than a tight element crop, so a menu/nav/validation that appeared is visible)
and feeds it back through the SAME native/delegated split as the locate snap-inject (`ctx.driverSees` →
inline image; text-only → a delegated describe + `CLICK_MARK_NOTE`), as a `ToolResult` with the same
`ToolFeedback` render. It targets the SAME element acted on — **but if that element vanished after the
action** (re-resolve misses → the page mutated: a button that removed itself, a form that navigated), it
falls back to the element's **pre-action centre** and annotates the crop "the element you acted on is
GONE — the page changed" (`elementCenter` captures the centre BEFORE the action for exactly this). The
shared helper is `captureVerify(ml, ctx, center, verb, mutated?)` — **`center: null` → a whole-VIEWPORT
shot** (no click-mark, no `CLICK_MARK_NOTE`) instead of a crop. `wait` (a PURE domTool in tools.ts, no
`ml`) also takes `verify` and is **area-first** (you verify the settled page, not the element you waited
on): it can't reach `captureVerify` directly, so `makeDomTools(defineTool, verifyArea?)` receives an
ml-backed `VerifyArea` closure (built in injected.ts) — keeping the domTools ml-free. Tested in
`tests/agent.test.js` (click/type native / delegated / mutated / no-vision; wait viewport native /
delegated-no-mark).

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

**Cross-page persistence (`navigate` + re-adoption).** A BACKGROUND-hosted run (design A) survives a
same-origin full-page navigation: the SW is the durable spine, the page an ephemeral limb, delegation keyed by
the stable `tabId`. The seam is `nav-barrier.ts` — a per-tab barrier every `RUN_TOOL_IN_PAGE` goes through
(`delegateSend` awaits `navBarrier.whenReady(tabId)`; instant on an idle tab, so single-page runs are
unaffected). Flow: the `navigate(url)` tool (`ml.navigateTool()`; same-origin only via `navTarget` in dom.ts,
pure/tested; **defers `location.href` a tick** so its result posts back before unload) fires → the background
**engages the barrier the instant that result returns** (`delegateTool`, gated on a non-error result) — NOT
only via `webNavigation.onCommitted`, because the loop's next fast local model call + tool delegation RACES
ahead of that async event and would fire the next tool into the dying document (the hard-won bug;
`onCommitted` is now just the backup for IMPLICIT link-click navs). The new document RE-ADOPTS: injected posts
`PAGE_ADOPT_HELLO` on load → content.ts `CONTENT_READY` → the background replies with the run's
`RebuildConfig` (tool names + carried vision facts) from a **live `runRebuilds` map** (set at START — `bgRuns`
only snapshots at run END, too late for a mid-run nav) → content posts `ADOPT_RUN` → injected `_adoptRun`
rebuilds the **BUILTIN** toolset (`_rebuildToolset`; custom function tools can't serialize, so cross-page is
the default/HUD kit only) + `registerRun` → `RUN_READOPTED` → `navBarrier.noteReadopted` releases the held
tool. The agent option **`navigate`** (default true) gates the tool + persistence: `false` → no tool, no
`trackRun` (`StartRunPayload.crossPage`), a `NAV_OFF_CLAUSE` telling the model it can't navigate, and a
`config.navigate` line in the "agent options" debug log. A page-hosted run (no debug surface + no approval
tool) still dies at a nav — persistence needs the background spine (the HUD/off-with-approval/devtools cases).
The `ml.agent()` PROMISE also dies with the caller's navigated-away context; the run continues in the
background and its result surfaces in the HUD/debug stream, not as that call's return value.
**HUD replay-across-nav:** the fresh page's card rebuilds MID-run with its history — the background buffers a
cross-page run's whole debug-event stream per tab (`runReplayBuffer`, populated in `emitStep`/`emitLifecycle`
so the `agent` start is included even when the page-side caller is what fans it live) and, on the
`CONTENT_READY` re-adopt hook, replays it to the destination page; `resetDebug` is suppressed while a run is
live on the tab so the shell's nav-remount doesn't wipe the history (this also keeps a DevTools panel's
sessions across the nav). Verified e2e (`tests/e2e/cross-page.spec.mjs`, incl. a replay test + observing via
the stable fake-LLM).
**Variant B (cross-DOMAIN).** Two gates protect leaving the origin: (1) the run must OPT IN with
**`crossOrigin: true`** (default false — `navTarget` refuses a cross-site URL otherwise), and (2) even then a
NEW cross-origin nav must pass an **interactive consent gate** — a page can't silently send the agent to
another site (prompt-injection exfil). Mechanism: `navigate` is `requiresApproval`, but **same-origin
auto-approves** (`autoApprove` → `"same-origin"` provenance, no prompt) on BOTH loop paths — page-side via
`sameOriginNav(location)`, background-side via `navNeedsConsent` — while a cross-origin nav to an origin NOT
in the run's `consentedOrigins` (seeded with the start origin via `StartRunPayload.pageOrigin`; grown as the
user approves) falls through to the gate. Approving an origin consents to it for the rest of the run (repeat
navs skip). Once approved, it just works mechanically: the content script re-injects on the new site
(`<all_urls>`), so re-adoption + delegation continue there; `crossOrigin` rides on `RebuildConfig` so the
rebuilt tool keeps crossing after a nav, and it's logged in the "agent options" block with a data-carry
caution in the tool description. (v2: an "allow / allow-for-this-run / deny" 3-way + "on-click"
host-permission handling.)
**Durable storage-backed resume:** a background run mirrors its resumable snapshot (`{p, messages, tabId,
sub}`) to `chrome.storage.local` at START and after each step (the host `checkpoint` dep), so an MV3-evicted
run isn't lost. On SW respawn a top-level `hydratePersistedRuns()` reloads in-flight runs into
`bgRuns`/`activeRuns` and marks them in `hydratedRuns` (= INTERRUPTED); `CONTENT_READY` awaits that hydrate,
then a fresh page re-adopting an interrupted run gets `resume:true` on its adopt entry and AUTO-continues it
from the last checkpoint (the `agentRegistry` by-hash resume handle → RESUME_RUN with an empty follow-up).
Storage holds only RUNNING runs (deleted in the run's finally); a run that merely COMPLETED isn't in
`hydratedRuns`, so it re-adopts (for a composer follow-up) but never re-drives. Tested via `__mlEvictForTest`
(an SW-realm-only hook that drops in-memory state + rehydrates, simulating a respawn). Known gap: a run
evicted while idle at an approval gate with NO subsequent page load has no re-adopt trigger, so it resumes
only once the page next loads. Plan + STATUS/HANDOFF: `tmp/cross-page-agent.md`.

**Approval-over-IPC (`__mlApprovals` + `approvalRouting`).** A background-hosted run's privileged gate can
be resolved from OUTSIDE the browser, so an automated driver approves/denies exactly like a human click — the
Playwright harness today, a desktop orchestrator (over `onMessageExternal` / native messaging) later; this is
the control channel for the "one wrapper driving a desktop with delegated subagents over IPC" goal.
`pendingApprovals` (background.ts) stores `{ resolve, descriptor }` — the descriptor is the serializable
"what's being approved" (`runId`/`seq`/`step`/`tool`/`arguments`/`routing`). Both the origin-authed
`SET_APPROVAL` message and the external channel funnel through ONE `resolveApproval(key, decision)`, so a
decision from either resolves the gate on every surface. The channel is
`globalThis.__mlApprovals = { list(), resolve(key, decision) }`, defined on the **service worker** — reachable
ONLY from the SW realm (`serviceWorker.evaluate` in Playwright; the page main world has no `chrome.runtime`
and can't reach this realm), so it grants a hostile page NOTHING: it's the same unforgeable gate, opened by
code instead of a click. **Opt-in via the `approvalRouting` agent option**: `"ui"` (default — human only; the
channel neither lists nor resolves it), `"both"` (UI shows AND the channel can resolve), `"external"` (channel
only — the UI approve/deny buttons are SUPPRESSED via `awaitingApproval:false`, the gate still blocks). A
module-level `externallyResolvable` guards list/resolve to `"both"|"external"` gates, so a default run can't be
silently approved by an orchestrator that never asked for it. Threaded page→background on
`StartRunPayload.approvalRouting`; logged in the sidebar "agent options" block. Tested in
`tests/e2e/approval.spec.mjs` (approve/deny with NO UI, the opt-in guarantee, and the page-realm boundary).

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
against the tool's `parameters`, rendered as a red strip. It is also APPENDED to
the tool result the model sees, so it is what teaches the model the shape it
should have sent — not only a debug decoration. Still not a full validator, but
it does understand a `oneOf`/`anyOf` UNION (checked against its branches when
every branch names a type): reading only `spec.type` meant a union property was
validated as NOTHING AT ALL, which is how `python_exec`'s `tables` — declared
"a source string OR a {name: source} map" — accepted an array, a number and
null in silence. A built-in shipping a complex schema is no longer hypothetical,
so reach for ajv only if one ships something this can't express.
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
**Ridiculous mode**: a 40×12 dirty scrolling table) — both with comment-hidden answer keys.

**RULE — the log/export ALWAYS carries what the MODEL actually saw.** The exports (Markdown +
PDF) and the DevTools/debug log exist for DEBUGGABILITY: there must ALWAYS be a view of the raw
model-facing INPUT *and* OUTPUT of every step — the exact args the model sent and the exact tool
result it received — even if collapsed behind a `<details>`. The default human-facing view may be
pretty and omit spam (a rendered table instead of raw HTML; a clean result instead of the
plumbing/token lines the model was fed), but the raw view must NEVER be *unavailable*. The
precedent is the tool call's raw-JSON-args disclosure that sits beside its rendered In (a static
export shows both since it can't toggle). **So whenever a rendered/pretty view DIFFERS from what
the model actually saw, add the raw view too** — in the sidebar (a rendered⇄raw toggle or a
disclosure) AND both exports. E.g. when a tool result carries an appended `@tool:<id>` token line,
that model-facing result — token line included — must be recoverable in the log, not silently
dropped for the clean render.

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
  theme, images inlined — a print doc has nowhere to put sidecars). `printSession`
  **routes the doc to the background** (`PRINT_SESSION` → `chrome.runtime.sendMessage`,
  which reaches it from BOTH surfaces), which opens a bundled **`print.html` tab**
  (`src/sidebar/print.ts`) that fetches the doc by key (`GET_PRINT_DOC`, one-shot),
  drops it into an iframe, prints THAT, and closes itself (`CLOSE_PRINT_TAB`). This
  is because `window.print()` is **SUPPRESSED for a frame inside DOCKED DevTools**
  (the panel surface) — a real top-level tab prints fine; markdown export was
  unaffected (it downloads via `<a download>`). The background stashes the doc in a
  `pendingPrints` map with a TTL timer (cleared on fetch) so a dismissed export
  never leaks. A `printInFrame` fallback (the old offscreen `.printframe` +
  `contentWindow.print()`) remains for when the runtime channel is absent. Chrome
  seeds the **filename from the printed doc's `<title>`**, so it's set to the same
  `ml-agent-<hash>` base as the `.md`. `@page` margins + `break-inside: avoid` on
  images/code/notes are the reason this isn't just the sidebar's stylesheet. The
  doc renders at the **extension's origin**, so the HTML sink pushes every dynamic
  string through `escapeHtml`/`markdown()`/`highlight()` (all three escape) — a
  hostile tool result or model reply can never inject markup. Disclosures are
  `<details open>`: a collapsed one prints as just its summary.

**Live tool-output streaming (`ctx.stream`) + the shared output cell.** Any tool's `run(args, ctx)` may call
**`ctx.stream(text)`** to stream partial output AS IT WORKS (Jupyter-style) — a GENERIC capability, gated by the
same **`stream`** agent flag as the streamed thinking (`ctx.stream` is simply ABSENT when off, so a tool checks
`if (ctx.stream)` and otherwise returns its full result at the end, unchanged). The loop builds a throttled +
capped fan per tool call (90ms, `UI_OUT_CAP`) and threads it through `runTool` → `executeTool`; each push emits
an `agent-step` DELTA carrying only `{ step, seq, streamOutput }` (no `tool`), which the reducer patches
**additively** onto the pending row — the DONE (with the real result) supersedes it. Shipped consumers: `exec`
(its console patch also calls `ctx.stream` per line) and `python_exec` (the offscreen WORKER's stdout tees to a
JS callback — `_ml_stdout_cb`, set only when streaming — and rides worker → offscreen → SW → page → the tool's
ctx.stream). Works on BOTH paths: the page loop, and the BACKGROUND-hosted (design A) path via a reverse channel
(`RUN_TOOL_IN_PAGE {stream}` → the page posts `PAGE_TOOL_STREAM {runId, chunk}` → SW → the in-flight call's sink,
keyed by runId since the loop delegates tools sequentially). **CDP exec on strict-CSP pages streams too**, by a
different mechanism: `Runtime.evaluate` returns ONCE, and `Runtime.consoleAPICalled` can't help because our wrapper
REPLACES `console.*` with a collector that never calls through, so no console event is ever raised. So `cdpEval`
installs a **`Runtime.addBinding`** (the purpose-built page → debugger-client channel) and the patched console tees
each line through it, raising `Runtime.bindingCalled` on our client mid-eval — no RemoteObject serialization (the
page already stringifies) and no console pollution. The PAGE stamps `ts`; it is the executor. It degrades safely: a
binding that won't install compiles no tee into the wrapper and the full output still lands at DONE. A successful
CDP exec also REBUILDS its Out descriptor from the run's own console/value — forwarding the page's CSP-blocked
render would show that error beside a successful result and wipe the output you just watched stream in.

*Streaming vs truncation.* The model's result is clipped to its context budget, but the UI keeps far more
(`UI_OUT_CAP`) — otherwise output you watched stream in would visibly SHRINK when the step landed. So the render
descriptors carry **`seen`**: how many characters the model actually received. Everything past it renders MARKED
("captured, but NOT sent to the model" — dimmed, dashed rail), so the fuller human view is never mistaken for
what the model read (the raw view still shows the model-facing text verbatim).

*The output cell.* `python_exec` and `exec` render their Out through ONE shared **`OutputCell`**
(src/sidebar/render-panel.tsx) — a future code-ish tool (a `bash_exec`, say) wraps its own sections in it and
inherits everything: a height cap (Settings → Appearance, per-cell drag-to-resize), scrolling, **tail-follow**
(new output scrolls into view only while you're parked at the bottom; scroll up and it holds), and an in-cell
**Ctrl+F find** (substring only — no regex — with a case toggle, match count, ↑/↓ navigation, painted via the
CSS Custom Highlight API so the syntax highlighting underneath is untouched). `exec`'s Out is a rendered cell
too (console / value / error sections), matching python's instead of a raw blob.

*Per-line timestamps (the EXECUTOR stamps them).* Streamed output carries a **produced-at gutter** — when each
line actually happened, not when the UI saw it. `ctx.stream(text, ts?)` lets the producer stamp the instant:
python stamps in the Pyodide **worker** (the chunk then crosses worker → offscreen → SW → page, so anything
downstream would be skewed), and a remote tool (a `bash_exec` on a server) would stamp on its own host. A
producer in the local realm omits `ts` and the loop's fan stamps it. The loop records `[offsetInTheAccumulated
text, epochMs]` on `streamMarks`; the UI only decides whether to SHOW them (Settings → Appearance, default on)
and NEVER invents one — an offset no mark covers renders blank, and `alignedMarks` drops the whole set if it
doesn't index into the text being rendered. The gutter is `user-select: none`, so copying the output copies
only the output; a repeated stamp is blanked so a burst reads as one moment; hovering any row gives the exact
instant to the **millisecond** plus the gap since the previous line. The **hour is elided** (mm:ss) only while
every mark is in the hour we're in *right now* — and since that is answered at render time, a `hourNow` signal
bumped by ONE self-terminating timeout (armed at the next boundary, `unref`'d, re-armed only from a render)
widens every gutter to hh:mm:ss together when the clock rolls over. Time-only, no date: a run spanning
midnight gets a **day divider** at the change (`dayBreaks` — a dashed rule + the ISO date, in the gutter and both
exports), since a time-only gutter would otherwise put `00:00:01` directly under `23:59:58` and read as one second
later. The mapping is pure and shared — **`src/sidebar/timestamps.ts`**
(`timeForOffset`/`alignedMarks`/`elideHour`/`timedText`), imported by the sidebar gutter AND by both export
sinks, so they can't drift; `render-panel.tsx` re-exports it. The **exports** carry the times as a collapsed
`Out · timed` block BESIDE the verbatim Out rather than prefixed onto it (a `<pre>` inside `<details open>`, so
the PDF prints it expanded and monospaced, alignment intact). There EVERY line carries its own stamp — the
sidebar blanks a repeat to keep a burst reading as one moment, but a text file has the opposite ergonomics: a
blank means "look upwards" and can't be hovered, so each line is self-contained and greppable. Only an offset no
mark covers stays blank — the sidebar's gutter is
unselectable and markdown has no equivalent, so baking times into the output would make an exported log
un-pasteable (and the raw-view rule already demands the model-facing text stay verbatim).

**Tool tokens are POINTERS, not just citations (`dereference`).** An `@tool:<id>` was only a way to embed an
output in the final answer. It is also a HANDLE the model can read back mid-run. The loop already retained
every non-failed citable output keyed by that id, so the value was there — there was just no way to reach it.
`dereference` (offered only when `toolTokens` is on) reads it, optionally reduced by a `pipe` first, and it
reaches the FULL capture rather than the ~500-char copy the model was shown — data that was otherwise
unreachable without re-running a side-effecting tool. It is answered **in the loop** (`derefLocally`), not
delegated: a pure read of run state the loop owns, so it behaves identically on the page-hosted and
background-hosted paths with no page round-trip and no approval.
- The **pipe is the existing bash sub-dialect** (`text-pipe.ts`), extended with the structural stages it
  lacked: `keys` · `values` · `schema` (alias `jsonschema`) · `type` · `count` · and jq-style `.a.b[0]` paths,
  composing with the line verbs in either order. Bare words are verbs, a leading dot is a path, so the two
  families can never collide — `.keys()` is spelled `keys`, and "the keys of that field" is `.items | keys`.
  Structural stages REFUSE non-JSON rather than inventing a shape for prose. `count` is the structure-aware
  size (`wc -l` counts LINES, so after a path stage it counts the lines of pretty-printed JSON — true and
  useless). **`PIPE_CMDS` is the single source** for EVERY description of the dialect: `PIPE_USAGE` (a total
  `Record` over it, so adding a verb without describing it is a COMPILE error) feeds `PIPE_SYNTAX` for the
  tools' `pipe` PARAMETERS and `PIPE_HINT` for the error paths, and `pipeHint()` drops the hint when the
  dialect's own refusal already listed the verbs. It was originally single-sourced only for the refusal and
  the system prompt, which is not the same as guarding the invariant: five other copies were hand-written
  and all had drifted to six verbs while the dialect had twelve, and `dereference`'s own description still
  advertised `len`/`slice` — verbs left over from a discarded dialect — even though the drift-guard test
  checked `DEREF_CLAUSE` for exactly those two names. A model told the set is smaller than it is never
  reaches for `schema` or a `.path`, which costs it a whole turn to discover.
  The guard now scans the tree, and its shape is the reusable part: the invariant is COMPLETENESS, not
  "never name a verb" — a pipeline EXAMPLE is what a doc should show, and no regex separates an example from
  a stale list. A line naming THREE OR MORE verbs is a list and must name them all; it scans PROSE only
  (comments + string literals), because five verb names are ordinary identifiers and `|` is TypeScript's
  union operator, so every false positive was code; and an explicit `…` or `e.g.` is honoured as the
  author's own "not exhaustive" disclaimer.
- The pointer carries the value's **TYPE**, from the render descriptor the step already produced — so `keys`
  on a DataFrame means its COLUMNS, and two casts the line dialect can't express work: `latex`, and `img`,
  which never dumps the payload but says it IS base64 image data, how large, and what to do instead.
- `token` takes a **short LABEL** as well as `true` (`token: "the pricing table"`). The string is both the
  opt-in and the name; it is purely for the model, appearing in the deref header, the available list and the
  fault candidates, and `nearest()` matches on it so recalling the NAME while inventing the hex still lands.
  It is a model-authored CLAIM, so it always sits BESIDE the derived description, never instead of it.
- Two failure modes are explicit. A pointer **aliases a snapshot with no invalidation**, so every read leads
  with what the value is and how many steps ago it was captured. And an unresolvable reference is usually a
  hallucinated token-SHAPED id, so it answers with a **MemoryFault** — the bad address, the nearest real
  pointers with their edit distance (distance 1 is a typo; 6 means it invented one, and the message says so),
  and an explicit note that the fault is RECOVERABLE, so a model pattern-matching "fault" to a crash doesn't
  abandon the task.
- **`look` accepts an image pointer**: `look { selector: "@tool:abc123" }` re-examines a screenshot the run
  already took — a new question about the same pixels, instead of re-shooting a page that may have changed.
  The loop resolves it and hands the image down, so `look` never learns about tokens.
- **`ml.dereference(ref, { pipe })`** is the same thing as a primitive, `pipe` taking the dialect string or an
  ARRAY of stages (which sidesteps quoting — one entry may hold a bare `|`). That was documented long before
  it was TRUE: stages were joined with `" | "` and then re-split, so `["grep -E error|warn"]` was torn in two
  and `["grep -E head|tail"]` silently grepped `head` and ran `tail` as a stage — a plausible wrong answer,
  no error. STAGES are now the form execution uses and are never re-joined; joining is for DISPLAY only
  (`pipeStages` vs `displayPipe`). The array had to be widened along the whole path, and `DEREF_TOKEN` in the
  background did `String(pipe || "")`, which comma-joins an array into something that is not the dialect. Run-bound exactly like `ml.answer`: `tool-exec` binds a resolver
  for the duration of a tool call and restores it after, so it is live inside an approved `exec` and throws
  from a page's own console. The BACKGROUND path rings back over the same reverse channel the output stream
  uses (`DEREF_TOKEN`, keyed by runId) — a page-only binding would have worked in off-mode and silently
  returned nothing whenever a debug surface was open. `dereference` and `info` are both in the read-only exec
  dialect (pure reads that spend nothing), with the adversarial tests the dialect rule requires.
- **THREE DISJOINT REFERENCE FORMS, told apart by SHAPE** — dispatched, never tried in order, so each
  spelling has exactly one meaning and nothing can shadow anything:
  `@tool:"the budget dataframe"` (quoted) = the model's own LABEL · `@tool:adf40ed` (7 hex) = a minted id ·
  `@tool:python_exec` (bare) = that tool's latest call. Dispatching on form also keeps a CORRUPTED id in the
  id branch, where it misses and faults, rather than being retried as a tool or label and resolving to
  something unrelated. The partition is ENFORCED: `ml.defineTool` throws on a name that is not an identifier
  or that is id-shaped, because the charset alone does not give it (`deadbee` is both).
- **The id carries a CHECK CHARACTER** (6 hex of avalanched hash + 1). It was FNV-1a truncated, which made it
  a disguised counter — the middle four characters were identical for nine consecutive steps, so ids sat a
  Hamming distance of 2 apart and a two-character typo could land on ANOTHER LIVE POINTER. A murmur3 `fmix32`
  finaliser fixed the diffusion; the check character then makes every single-character substitution
  structurally invalid, and — more usefully — lets a fault tell a MISTYPED id from an INVENTED one.
  Correction is deliberately NOT in the id: the live set of ~24 ids is already a code with minimum distance
  ~4 for zero characters, and unlike an algebraic code it degrades gracefully as the error grows. See
  `docs/POINTER-IDENTIFIERS.md` for the measurements and the benchmark that is still unrun.
- **Labels resolve, in tiers, and a near match is never silent.** Exact → resolve. Near AND clearly ahead of
  the runner-up (`labelMatch`, default `hybrid`) → resolve and SAY SO. Ambiguous → fault with candidates.
  The margin is the guard, not a distance threshold: given `model_fit_linear` and `model_fit_quadratic`,
  both clear any absolute bar, so only separation can refuse `model_fit` while still accepting a typo with a
  clear winner. The announcement channel differs by caller and this is load-bearing — the TOOL appends it to
  its result, but `ml.dereference` in `exec` returns a VALUE the script parses, so a note there would corrupt
  the data: a read returns `{ value, warning? }` and the exec path `console.warn`s it.
- **Pointers span the SESSION, not the turn**, LRU-bounded (`TokenStore.CAP`) with a read counting as a use.
  On the background path the store is released with the `bgRuns` entry, NOT in `untrackRun` — that fires per
  TURN, and putting it there emptied the store between turns.
- **`dereference` with NO argument lists what the session holds** (id, name, TYPE, age) — the answer to "what
  do I have?", so the model never has to recall an id to find out.

- **Reading by NAME pins a stable id.** `@tool:python_exec` means "the LATEST python_exec call" — a moving
  target. A model that didn't pass `token: true` was never shown that call's hex (it is minted for a citable
  builtin either way, just not surfaced), and it often only decides an output is worth keeping AFTER seeing
  it. Dereferencing through the alias is exactly that moment, so the reply hands over the stable id and says
  what it is, rather than leaving the model holding a handle that moves under it.
- **Pointers survive a session's later turns** — a follow-up turn can still read what an earlier one captured.
  The store was per-`runAgentLoop` call, so every turn started empty while the model still saw the earlier
  turn's pointers in its own history. Ids were never the obstacle (`seqBase` already offsets each turn so a
  later one cannot collide), so one store per SESSION is safe. It is therefore BOUNDED — `TokenStore.CAP`,
  evicting least-recently-USED, since a read has to count as a use or "pin it before it goes out of scope"
  does not hold. Recency is tracked apart from insertion order, because insertion order is what makes the
  name alias mean "the latest CALL": refreshing it on a read would promote an old output to look like the
  newest. On the background path the store lives in a map beside `derefByRun`, deliberately NOT on the
  `bgRuns` record — that record is JSON-checkpointed for MV3 eviction and a Map serializes to `{}`.
- **A PIPED read mints its own pointer**, so the model can cite the reduction it just built rather than the
  whole original. `dereference` is otherwise excluded from `citable` because it "produces no new data, only a
  VIEW" — true with no pipe, false with one. Minted inside `derefLocally`, not by flipping `citable`, since
  the generic path would read this tool's `token` PARAMETER as the model's opt-in/label.
- **`ml.pipe(source, pipe)`** runs the same dialect over ANY string, not just a captured tool output:
  `ml.pipe(await ml.fetch(url), "grep -i pricing | head -20")`. So the scanning vocabulary is one language
  wherever text comes from, and a stage never round-trips through a re-joined string.

**Site-authored Markdown twins (`pageInfo`).** Many docs platforms publish a clean, agent-oriented Markdown
version of each page and DECLARE it in `<head>`. Standing on such a page the agent had no way to know the twin
existed and would survey the rendered DOM instead, which is strictly worse text. `pageInfo` now reports it, so
the agent can fetch the declared version rather than scraping the page. (`pageInfo` also stopped naming a tool
the run may not have been given — a suggestion the model cannot act on is worse than none.)

**`ml.info()` — machine capacity.** `ml.ps()` says what is RESIDENT; `ml.info()` says what there is room for
(Ollama `/api/info`, via the same base discovery `/api/ps` uses). Returns **null** when the route isn't served
— only a patched Ollama behind an OpenWebUI passthrough answers it, everything else replies with the SPA's
HTML — which must read as "capacity unknown", never as zero. `LoadedModel` also gained exact
`vramBytes`/`sizeBytes` beside the rounded GB, and `gpus[]` for per-device placement; a CPU-resident model has
**no `gpus` key at all**, and that absence is the server's signal, preserved rather than normalised to `[]`.

**Resource panel (VRAM/RAM).** `resource-model.ts` is the pure, unit-tested layer (parsing, bands, ceilings,
series/tracks/presets, history segmentation); `src/sidebar/resource-chart.tsx` only draws. Spec + ASCII mocks +
live captures from both a CUDA box and a Metal Mac: `docs/spec/RESOURCE_PANEL.md`. **Read it before touching
this** — several of the numbers are counter-intuitive and getting one wrong produces a confidently wrong
display rather than an obvious bug:
- **All memory figures are raw BYTES and BINARY.** A card sold as "96GB" reports 94.97 GiB; dividing by 1000³
  gives 101.97 GB, which reads as plausible and is 7.4% wrong. Keep bytes internally, convert once at the
  render boundary through **`formatBytes`** — one formatter, never a hand-rolled `/1e9`, and never a bare
  number. Model FILE sizes are normalised to GiB too, even though `ollama list` prints them decimal.
- **Three totals, all correct**: nominal (no API reports it — never synthesise it by rounding), the driver
  framebuffer total (`physical_memory`, what nvidia-smi shows — DISPLAY this), and `cuDeviceTotalMem`
  (`total_memory`, what ollama places against — decide FIT against this).
- **A device decomposes into three bands, never two**: attributed per model, the residual, then free. The
  residual is named by MAGNITUDE — under ~1 GiB it is ollama's own driver context (an idle card holds ~0.55
  GiB), above it something genuinely else is there. Calling it "other processes" invents a process.
- **Unified memory (Metal) is one pool**: `runner` is the discriminator, occupancy comes from the HOST (a
  Mac's device reported itself 11.84/11.84 GiB free while the system was 12.6 GiB deep in the same silicon),
  and a GPU-resident model is attributed in FULL there (`size == size_vram`, so attributing only the spill
  attributes nothing).
- **History is session-only and per-BOX**: `boxSignature` identifies the machine, and pointing at a different
  backend drops the old box's samples — including those taken before capacity was known, which would
  otherwise be backfilled with the NEW ceiling. Gaps stay gaps (`segments`), because polling is gated on the
  panel being open and a line across a ten-minute hole is a confident claim about memory nobody measured.
- **Presets are derived from the catalog** and validated by `presetRefusal` against `stackRefusal` — a preset
  may never propose a layout the rule then rejects (Overview stacked several cards until a drift guard caught
  it). Stacking asserts the parts sum to a real whole: true within one pool, false across cards or across
  device+host on unified memory.
- **Capacity is a fact about the BOX, not about a poll** (`holdCapacity`): a `/api/info` that answers with
  nothing means THIS request learned nothing, and forgetting what was measured swapped the whole panel for
  the no-ceiling fallback until some later poll happened to succeed. A box that has NEVER answered still
  degrades — and SAYS so, since an unexplained bare line reads as the panel having regressed.
- **A model keeps its identity for as long as it is DRAWN.** Band colour/name came from the last frame only,
  so an evicted model's whole history turned anonymous grey — in the view whose job is saying what WAS there.
  Identity comes from any frame in the window, and the model list carries GHOST rows for models still drawn
  but no longer resident, because the rows are the chart's legend and a colour with no row explains nothing.
- **Tracks TILE at width** (auto-fit 300px columns) rather than stretching, and the learned drag floor is
  keyed by width as well as layout — tiling needs less height, and the correction only ever grows.

**The event lane (§4.5 of the spec).** Under the tracks, on the SAME segmented axis: what happened, against
what memory was doing while it did. Nothing new is collected — `src/sidebar/model-stats.ts` derives it from what
sessions already record. `usageByModel` is the per-model ledger (attributed to the model that RAN, with
delegated sub-calls charged to the READER); `eventsFrom` builds the timeline.
- **Spans run BACKWARDS from when a call finished** — the timestamp we hold is the end — else every bar sits
  one generation to the right of the memory movement it caused, which defeats the shared axis.
- **A tool step is ONE block with PHASES**: the model generating the call, the human at the approval gate,
  the tool running. `toolMs` and `approveMs` are measured separately in `agent-loop.ts` for exactly that
  reason — a human deciding is the step's wall time but not the machine's work, and the wait draws as a
  hollow neutral so a wide bar can never read as work.
- **`load_duration`** (captured as `TokenUsage.loadMs`) is the only place the difference between "the model
  was slow" and "the model wasn't there yet" exists. Drawn as its own span in front of the block, floored at
  a second so a resident model's few ms of bookkeeping doesn't fill the lane.
- **Sub-calls are drawn under the step that spawned them** (`bus.ts` keeps each one's ts/duration beside the
  totals), and events carry a lineage (`id`/`parent`); hovering one lights its chain and dims the rest.
  Ancestors go all the way up; descendants come only from the hovered event, or one sub-call lights every
  sibling step.
- **The axis is NOT linear in time** (`placeEvents`): the plot is segmented by gaps and each segment is
  flex-weighted by sample count, so an event is placed inside the run that CONTAINS it, one that falls in a
  gap is dropped (nothing was measured then), and the window admits a poll's grace past the last sample —
  without it the newest events, the ones you are watching for, were the only ones that never appeared.
- **Instants rule through the plot** (dashed — a solid line reads as part of the chart), and one eviction is
  drawn in every track, so hovering it anywhere thickens it everywhere.
- **Cursor tooltips share `useTipPlacement`** and are placed against the VIEWPORT from their own MEASURED
  size: they flip when they do not FIT (not at an arbitrary fraction of the width), never sit under the
  pointer, and only the surface the pointer is on renders one. Pinned by `tests/e2e/tooltips.spec.mjs`, which
  sweeps positions in a narrow and a wide panel rather than probing one point.

**Two surfaces (in-page overlay + DevTools panel).** The same `sidebar-app` bundle runs
in two places: the in-page **overlay** (a content-script shadow-root shell, `shell.ts`,
hosting `sidebar.html` in an iframe) and an optional **DevTools panel** (`devtools.ts`
registers a "window.ml" panel; `panel.html`/`panel.ts` host the *same* `sidebar.html`
iframe and play the same parent-relay role the shell does). `src/sidebar/app.tsx` is
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

**Markdown negotiation (`ml.fetch` / `fetch_url`, `format: "markdown" | "html"`).** A docs page run through
Turndown is OUR reduction of its markup; many sites publish an authored Markdown version of the same page,
typically an order of magnitude smaller. A four-rung ladder in `sw-fetch.ts` goes and gets it: **1 `accept`**
— the SAME request asking for Markdown, so its miss IS the HTML fallback and the rung is never wasted;
**2 `declared`** — the `<link rel="alternate" type="text/markdown">` in that HTML, free to evaluate and
authoritative where derivation cannot be (docs.github.com publishes at `/api/article/body?pathname=…`);
**3 `sibling`** — the derived `.md`/`index.md`, the guess, so it goes last; **4 `convert`** — Turndown.
Rungs 2-4 run only when rung 1 returned HTML, so a JSON API answers at rung 1 and a data fetch still costs
one request; a URL whose extension names a data file never negotiates at all. Measured across 12 docs
platforms, neither mechanism dominates: `Accept` alone gets 9 of the 11 that publish a twin, the `.md` URL
alone also 9 — together 11. Two rules the probe forced: later rungs derive from the **final** url (a redirect
is how `…/guide` becomes `…/guide/`, which flips the sibling to `index.md`), and a DECLARED href is
page-controlled, so a cross-origin one is refused rather than followed under this page's grant. `raw` was
replaced by `format` because it straddled "what do we FETCH" and "what does the model RECEIVE"; `format` is
the fetch-level half, shared with `ml.fetch`. `FetchResult.negotiation` carries the trace, rendered as a
resolution TREE in the In slot (`src/sidebar/fetch-ladder.ts` holds the labels once, for the sidebar AND both
export sinks) — not decoration: a stub twin is a valid 200 Markdown document that is simply the wrong page.
`pageInfo` reports a declared twin too, so an agent standing on a docs page knows to fetch rather than survey.

**`ml.pipe(source, pipe)`** runs the text-pipe dialect over ANY string, not just one tool's output —
`ml.pipe(await ml.fetch(url), "grep -i pricing | head -20")`. Named `pipe`, not `bash`: `PIPE_CMDS` includes
`keys`/`values`/`schema`/`type`, which are not shell commands. A fetch result may be passed whole (its
`.markdown`, else `.text`). Advertised in `exec`'s description only — it needs exec, which a run may not
have — and otherwise discovered through `agent_api_docs`.

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

**RULE — self-tools get a skill + an AGENTS.md mention, and you keep both current — WITHOUT asking.**
Any time you (or any model working on this repo) build a TOOL FOR YOURSELF — a harness, wrapper, driver,
or script you'll re-use to develop/debug/benchmark the extension (e.g. `tests/e2e/observe.mjs`) — you MUST
(1) write a **Claude skill** (`.claude/skills/<name>/SKILL.md`) documenting exactly how it's used (invocation,
env knobs, when to reach for it, gotchas), and (2) add a **brief mention** of it in AGENTS.md so the next
agent discovers it. Keeping AGENTS.md, your skill files, and the scripts they describe **in sync and up to
date is YOUR responsibility** — every time you change a self-tool's behaviour, update its skill + the AGENTS.md
mention in the same change. Do this proactively, never ask the user whether to. (Skills live in
`.claude/skills/`; the `observe` skill is the reference example.)

**RULE — never pad model-facing text for alignment.** Column-aligning a list with `padEnd` is a HUMAN
scanning affordance. A model parses the fields either way and pays for every space, so padding is pure
context cost on a path whose whole purpose is usually to SAVE context. Measured on the `dereference`
candidate list: 55 of 557 characters — 10% — were padding, and it grows with the field widths. Use a single
space or a delimiter, and let the fields be ragged. This covers every string a model reads: tool results and
errors, tool/parameter descriptions, prompt clauses, fault messages. **Human-facing surfaces are the
opposite** — the sidebar, the HUD and the exports should align freely, and the sidebar gets it for free in
CSS, so nothing is lost by keeping the model-facing string dense. Testable: assert no run of two or more
spaces in the generated string (see `tests/token-pipe.test.mjs`, memoryFault).

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
- **Working in a git worktree** (`.claude/worktrees/<name>`): two gitignored directories do
  NOT come with it, and neither absence is loud. `node_modules` is obvious (nothing runs);
  `pyodide-wheels/` is not — the build prints one `⚠ pyodide-wheels/ missing` line and
  carries on, `npm test` stays green because the CPython tests self-skip, and the failure
  only surfaces at RUNTIME as `ModuleNotFoundError: No module named 'numpy'` inside a
  `python_exec` step, which reads like a sandbox bug. Symlink both to the main checkout
  rather than re-downloading 28MB of wheels:
  `ln -s ../../../node_modules node_modules && ln -s ../../../pyodide-wheels pyodide-wheels`,
  then rebuild. (`node_modules/` in `.gitignore` has a trailing slash, so a symlink shows as
  untracked — leave it out of commits.)
- **Coverage: `npm run coverage`** — Node's built-in coverage (no dependency), writing
  `coverage/lcov.info` (the **Coverage Gutters** VSCode extension reads it with no configuration) plus a
  table on stdout. `node scripts/coverage-lines.mjs <file>` prints the gaps AS SOURCE, separating **NEVER
  RUN** from **BRANCH NOT TAKEN** — the second is the one a percentage hides, and the one that answers "was
  the `else` of this guard ever taken". Reach for it before claiming a path is tested: auditing the Markdown
  ladder this way found five untaken branches where the claim had been "fully covered", though only one was
  worth a test. `--enable-source-maps` is NOT optional in that script — tests run through tsx, so without it
  every line number describes the transform. See the `coverage` skill.
- **End-to-end tests: `npm run test:e2e`** (Playwright, `tests/e2e/*.spec.mjs`) —
  the ONE heavy layer that loads the **built** extension in a real Chromium. Use
  it **only** for behaviour jsdom/`node:vm` genuinely can't represent: full-page
  navigation, content-script re-injection, the MV3 service-worker lifecycle,
  `webNavigation`. Real browsers are slow, so keep this suite **small and rare** —
  anything expressible in `node:test`/jsdom belongs there instead, and pure logic
  should be factored OUT into a testable module (e.g. `nav-barrier.ts`) with a
  fast `*.test.mjs`. It's a **separate** suite: `npm test` never runs it (the fast
  suite globs `tests/*.test.*`; E2E is `tests/e2e/*.spec.mjs`). See the fuller
  writeup below.

## End-to-end & real-model testing (the Playwright harness)

`tests/e2e/` loads the **built `dist/`** extension in a real Chromium so browser-only
behaviour (navigation, SW lifecycle, content-script re-injection) can be exercised. It is
**opt-in and slow** — reach for it only when jsdom/`node:vm` genuinely can't represent the
thing. The parts:

- **`harness.mjs`** — `launchExtension()` (persistent context + `--load-extension=dist`),
  `configureExtension(sw, cfg)` (writes `chrome.storage.sync` via the SW), `waitForMl(page)`.
  **HEADLESS by default**, via `channel: "chromium"`. The old note here said an MV3 service worker does
  not register under headless Chromium — true, but narrower than it read: plain `headless: true` runs the
  headless SHELL, a stripped binary with no extension support at all. `channel: "chromium"` runs the FULL
  browser in `--headless=new`, where the worker registers in ~0.5s and the whole suite passes. This
  matters beyond tidiness: a headful window grabs focus and the mouse on every launch, and the suite
  launches one per spec. Pass `headful: true` (the narrated demos do) or set `E2E_HEADFUL=1` for a look. **A run is started exactly like a console call:** `page.evaluate(() =>
  window.ml.agent(task, opts))` — Playwright's `page.evaluate` runs in the page **main world**,
  where `injected.js` defines `window.ml`, so no test-only hooks; the same front door a human
  uses. The result structured-clones back to Node.
- **`fake-llm.mjs`** — a scriptable OpenAI-shaped backend (`startFakeLlm()` → `setScript([...])`)
  so the REAL pipeline (background loop → tool delegation → page) runs **deterministically with
  no Ollama**. A script step is `{ content }`, `{ tool, args }`, or `(reqBody) => step` (reactive
  — the final answer can echo a value a real DOM tool read off the page). This is the CI gate.
- **`cross-page.spec.mjs`** — a `smoke` (extension loads + one-shot agent) + a `sanity` (agent
  reads a page value via a DOM tool and answers it) that run under BOTH the fake and a real
  backend, plus the skipped cross-page acceptance test (see `tmp/cross-page-agent.md`). Those two
  are tagged **`@real-ok`**, and a `beforeEach` SKIPS every other test in the file when
  `E2E_BACKEND` is set: the rest script an exact turn sequence and read `fake.calls()` back, so
  they cannot mean anything against a real model — and without the skip they dereferenced a null
  `fake` and failed, which reads as a product bug in the nightly real-model job. Tag a new test
  `@real-ok` only if it guards its fake usage (`if (fake) …`) and asserts on the run's own result.
- **`observe.mjs`** — a **debug/observation wrapper, not a test** (see the `observe` skill for the
  full playbook): `node --import tsx tests/e2e/observe.mjs` drives ONE agent run in a real Chromium
  and writes ARTIFACTS to `tests/e2e/artifacts/<RUN_LABEL|timestamp>/` (gitignored): **`run.md`** =
  the extension's OWN canonical markdown (captures the `__mlDebug` stream under `debugMode:"overlay"`,
  rebuilds a `Session`, runs `serializeSession`), **`run.json`** = the same Session through the
  machine-readable export (diff TWO runs with this — a markdown diff is mostly layout), a screenshot
  per step (`look`/`locate` sidecars included), `events.json`, `transcript.txt`. This is how a model debugs the extension itself: run →
  read `run.md` + screenshots → diff run dirs before/after a fix, and sweep rule-adherence across
  models. Knobs (env vars):
  - `TASK` — the agent task; `START` — the start route (any served example page: `/spreadsheet`,
    `/find-waldo`, `/canvas-input`, … or the cross-page chain `/`, `/step2`, `/step3` — `GET /examples`).
  - **Real model:** `USE_ENV=1` reads `OPENWEBUI_URL/KEY/MODEL` from `.env`; `E2E_MODEL=<id>` overrides
    the model (e.g. `deepseek.deepseek-v4-pro`, `gemma4:31b`); no vars → the deterministic fake-LLM.
  - `TOOLTOKENS=1` enables tool tokens · `PYTHON=1` wires `python_exec` · `TOOLS=findByText,answer`
    limits to a domTools subset (smaller prompt/schemas = far fewer tokens/turn) · `WARM=0` skips the
    VRAM warm-up (a local model wants it warmed; the fake/API don't) · `FOLLOWUP="…"` runs a SECOND turn
    in the SAME session (createAgent + two run()s, same run hash) to reproduce multi-turn behaviour a
    single `ml.agent()` can't (a "…now show the work" follow-up; the cross-turn token-id collision).
  - **`APPROVE=<policy>`** — how the built-in approval poller resolves a gate the run halts on (via the
    SW-only `__mlApprovals` channel; the run passes `approvalRouting:"both"`): `auto` (default, approve
    all), `deny`, `readonly` (approve exec + readonly python, deny the rest), `hold` (log but DON'T
    resolve — leave it for a manual click in WATCH). Every gate + decision is logged, so a run never
    hangs silently at an approval.
  - **Sidebar focus is the DEFAULT:** every run fires non-blocking and the harness opens the overlay
    sidebar at HALF the viewport width + clicks into the live session, so a watching human never has to
    click. **`WATCH=1`** additionally HOLDS the browser open at the end (close the window / Ctrl+C to
    exit) instead of tearing down — for inspecting a finished run; without it the browser closes when the
    run completes.
**Programmatic export (`export-schema.ts` + `docs/spec/export.schema.json`).** The JSON export is a
PUBLISHED contract, and `export-schema.ts` (root, beside contract.ts) is normative. Two things about it are
easy to get wrong. **Internal types are RESOLVED, and tag their own instability**: the
generator chases every referenced type out of contract.ts lazily and transitively — no hand-kept list,
because one goes stale silently and the schema would then describe less than it claims while still
looking complete — so a consumer gets real types for `renderIn`/`renderOut`/`config` instead of an opaque
object. The ones that WILL grow carry **`@unstable`** in the JSDoc above their declaration; the generator
marks those `x-unstable`, says so in the description, and gives an unstable UNION a trailing branch that
accepts anything, so adding a render-descriptor variant does not start failing an old consumer's
validator. A union inherits its members' instability, which is what makes an inline
`DebugSessionConfig | DebugAgentConfig` permissive without being tagged itself. Put `@unstable` on a type
and the schema follows: that is the whole mechanism. **And a differ needs more than the field list**: `VOLATILE_FIELDS` names the fields to strip,
but a pointer id is also surfaced *as text* (an `@tool:` citation in an answer, a `dereference` ref, the
token line on a result), so removing `steps[].token` leaves every copy behind — `VOLATILE_PATTERNS` +
`canonicalizeText()` handle those, and the session hash is deliberately NOT a pattern (eight bare hex
characters would strike colours and short commits too; its value is known from `session.hash`).
`scripts/gen-export-schema.mjs` lifts the interfaces into **JSON Schema draft 2020-12** so a Python or Go
consumer can generate models (`datamodel-code-generator` → Pydantic, `quicktype`, …). It is a line scanner
for the same reason `gen-api-docs.mjs` is (typescript@7 is the Go port, no JS compiler API) and THROWS on a
type it cannot map rather than silently emitting "anything". Unlike the other generated files the output is
**checked in** — a spec people link to cannot be a build artifact — and `tests/export-schema.test.mjs`
regenerates, diffs, and validates real agent AND chat exports against it, including a test that the
validator itself can fail. Each document opens with a **`$schema`** URL pinned to that BUILD's commit on
raw.githubusercontent (`schemaUrl()`, best-effort — omitted when there is no GitHub remote or no commit,
since a wrong URL gets validated against and quietly misleads; still emitted for a DIRTY build, with
`build.dirty` beside it as the caveat). It is the conventional key editors use to validate a file with no
setup, and it points at the commit rather than `main` because `main` drifts away from what the file is.
`generator.build` carries the COMMIT (a manifest version only moves on releases,
so it cannot answer "are these two runs comparable"); its `dirtyDiff` is opt-in via
`ExportProvenance.includeDirtyDiff` — on for a harness artifact whose job is reproducing a run, off for a
download the user shares, since it is unpublished source. `session.page` records where the run STARTED,
previously recoverable only by regexing the system prompt. **`session.events` is the resource panel's event
lane, published** — the run's TIMELINE, so it survives outside the panel that drew it. Derived by the same
`eventsFrom` the panel uses, so the two cannot disagree, and derived deliberately: the arithmetic is wrong
in the same three places every time a consumer redoes it (spans run BACKWARDS from a finish stamp; a tool
step is ONE event with `phases` splitting model/human-at-the-gate/tool, not three; a model load is its own
event because "slow" and "not there yet" are different answers). Sub-calls carry `parent`, so a reader
model's cost is attributable. `evict` is in the kind union but never exported — it is read off `/api/ps`
polls, a fact about the box rather than about a session.

- **`run-once.mjs`** — the run-driving CORE both CLIs share: `runOnce(config)` drives ONE agent run in a
  real Chromium and RETURNS `{ events, session, runMd, result, … }` instead of only writing files.
  `observe.mjs` is a thin env-var CLI over it; the bench is a matrix over it. Every piece of run state is
  a local (not a module global) so `--jobs N` can call it concurrently. It also owns **seeded histories**
  (`seed: { task, script }`): turn 1 runs against the SCRIPTED fake so an experiment decides exactly what
  the model will find in context — a corrupted pointer, a failed call, a large captured output — then the
  backend swaps to the real model and the task continues in the SAME session. Nothing is fabricated (the
  real loop produced that history), and `seedBoundarySeq` marks where the seed ends so the script's own
  behaviour is never scored as the model's.
- **`bench/`** — a **matrix over `runOnce`, not a test** (see the `bench` skill for the playbook):
  `node --import tsx tests/e2e/bench/run.mjs <spec>.bench.ts` runs every combination of the spec's
  dimensions x tasks x repeats and reports re-emission, pointer use split by fault cause, recovery, token
  cost and correctness with **spread, not a point estimate** (models are stochastic; N>=5 per cell). A
  spec is **typed TypeScript** (`spec.ts`, `defineBench`), so the dimension keys you declare are the keys
  `apply()` receives — a mistyped axis is a compile error, not a cell that silently never varies. Four
  rules keep it honest: metrics derive ONLY from the existing `__mlDebug` stream (a metric that can't be
  computed from it means the PRODUCT is missing an event — fix it there); an experimental dimension is a
  build-time `--define` (`build.mjs --outdir <dir> --define K=V`) so a hypothesis that may conclude "the
  current design was fine" adds zero product surface; cells are content-addressed by config AND build
  fingerprint, so a long sweep resumes and an edit invalidates what it invalidates instead of mixing two
  builds into one table; and the extractors are calibrated FIRST against the scripted fake-LLM. That last
  rule is not ceremony — `specs/smoke.bench.ts` scripts a run that re-emits (must read 1.00), one that
  cites instead (0.00) and one that hides a re-emission in a seeded turn (0.00), and it caught two real
  extractor bugs before any GPU time. Assertions: `tests/bench-metrics.test.mjs` (fast, synthetic
  streams) and `tests/e2e/bench-selftest.spec.mjs` (real streams — the only thing that catches an
  extractor reading a field the product never emits). One walk, N sinks: terminal + markdown today. **Two audiences, one run:** the terminal is for the agent, and
  **`--serve`** prints a banner URL for a live page a human watches — every run's state and what is
  queued, the in-flight run's step against its budget and the tool it is in, elapsed / mean-per-run /
  mean-per-step / ETA, and links to each `run.md`. Dependency-free (node:http + SSE) and a SINK, not a
  second brain: it recomputes with the same `aggregate()` the report uses, so it cannot disagree with
  `report.md`. Worked example specs live in `tests/e2e/bench/specs/` with a `README.md` for humans.
  **CI runs it as its own `bench` job**
  (`npm run bench:calibrate` → build, smoke sweep, `check-calibration.mjs`), deliberately separate from
  `test`/`e2e` so a broken INSTRUMENT names itself instead of reading as a broken extension. Artifacts land per RUN under
  `tests/e2e/artifacts/bench/<spec>/<task>/<combo>/r<N>/` (gitignored) — `run.md` to read, **`run.json` to
  DIFF** (a markdown diff is mostly layout; strip `VOLATILE_FIELDS` + `canonicalizeText` first), plus
  events/transcript/screenshots, and `run.html`+`run.pdf` behind `--pdf`. The report's **Runs** table
  indexes every individual run, since the aggregate hides the one repeat that went wrong.
  **`run.md.html`** is the markdown RENDERED (`tests/e2e/viewer.mjs`, `marked` — a devDependency, since
  the alternative is a partial renderer that silently mangles what it did not anticipate). It is written
  beside `run.md` with RELATIVE asset paths, which is what lets ONE file serve both cases: opened off the
  disk it finds its own `images/`, and served under `/artifacts/<run>/` it finds them there too — so there
  is no server-side render to drift from it. Every h2 becomes a collapsible section, and a **failed run's
  status in the index links straight AT the step that broke** (`focusStep` in metrics.mjs: a memory fault,
  else a tool that returned an error, else the last step of a run that crashed or hit its cap; a run that
  merely answered WRONG with every tool working gets no anchor, because there is no failing step and
  pointing at one would send the reader to an innocent call). Folding is the NATIVE `<details>` state,
  driven by a small inline script admitted by a **CSP hash** — raw HTML has to pass through for the sink's
  own `<details>`, so a scraped hostile page could otherwise run script when a human READS the transcript,
  and a hash admits this exact text while refusing anything injected. A first attempt did the folding in
  pure CSS to avoid script entirely, and it was wrong in a way worth remembering: hiding section bodies
  OVERRIDES the native state, so after "collapse all" a heading click did visibly nothing.
  Observe's artifacts get the same file.
- **`approval-demo.mjs`** — a **narrated demo, not a test**: `npm run build && node --import tsx
  tests/e2e/approval-demo.mjs` opens a headful browser and walks the approval-over-IPC flow (idea #2)
  three times — a manual APPROVE, a manual REJECT, and a POLICY driver that auto-approves read-only
  `exec` and rejects writes — printing the pending-gate descriptor (`__mlApprovals.list()`) and each
  decision (`resolve(key, …)`), all driven from the SW realm with the page walled off. Deterministic
  (fake-LLM, no model/key). Pace it with `PACE`/`HOLD` (ms). The automated assertions of the same flow
  are `approval.spec.mjs`.
- **`resource-demo.mjs` / `resource-panel.spec.mjs`** — the VRAM/RAM panel against a scripted fake BOX.
  `fake-llm.mjs` fakes the box as well as the model: **`setResident()`** drives `/api/ps` and
  **`setCapacity()`** drives `/api/info`, both settable mid-run, so a demo or spec can make models load, move
  card and evict on a timeline. `setCapacity(null)` reproduces a server without the patch, which answers that
  route with the SPA's HTML rather than a 404. The demo walks: idle cards → a model onto the first card → a
  second onto the next → a CPU-resident third against System RAM → an eviction → the panel CLOSED for 20s (so
  the history shows an honest GAP) → CHURN (models loading and evicting at random, including two on one card)
  → the same track drawn stacked and overlaid → a SPLIT model (uneven across every card, remainder in RAM; on
  a one-card box, a partial offload instead) → the box going SILENT on `/api/info` (the tracks stand, because
  capacity is a fact about the box) → a fresh page against a box that NEVER answered (no ceiling invented) →
  capacity restored.
  **`BOX=` picks the machine**: `cuda` (default — two ~95 GiB cards, names nvidia-smi) · `amd` (two ROCm
  cards, names rocm-smi) · `laptop` (a 12 GiB 4080 laptop and 32 GiB RAM, where a 27B has to spill into system
  memory) · `rig` (four NVLinked 3090s a 70B is split across) · `lab` (eight A100s = nine pools, past the
  curated colour palette) · `metal` (one unified pool, no vendor tool to name). Screenshots land in
  `tests/e2e/artifacts/resource-demo[-<box>]/`. The fake box PLACES models the way ollama does — a model takes
  what fits on its card and spills the rest to RAM — so a script can't produce a card at 128% of its capacity.
  The spec asserts the same behaviours, plus a **CUDA → Metal backend switch** (the panel re-shapes to one
  unified track and the old box's history is dropped, since an 18 GiB reading redrawn against an 11.84 GiB
  pool clips and looks like a measurement), the tiling at width, the drag floor, and the tooltip/hit-target
  invariants.
- **`md-ladder-live.mjs`** — a **debug probe, not a test**: `npm run build && node --import tsx
  tests/e2e/md-ladder-live.mjs` drives the Markdown negotiation ladder against LIVE docs sites through the
  built extension and prints each resolution tree. Every other ladder test drives a SCRIPTED fetch, so this
  is the only thing that exercises the real background worker, its host permissions and the real consent
  path. Each site is visited first and fetched from its OWN origin, so the fetch is same-origin and needs no
  approval. Not in CI — the sites are live.
- **`stream-demo.mjs`** — a **narrated demo, not a test** of LIVE tool-output streaming: `npm run build &&
  node --import tsx tests/e2e/stream-demo.mjs` opens a headful browser, slides the overlay open on a real
  (background-hosted) run, and drives a deliberately SLOW `exec` (paced `console.log`) and `python_exec`
  (paced `print`) so you can watch each Out fill in Jupyter-style. It also captures the two adjacent
  behaviours: the "captured, but NOT sent to the model" marking, and the in-cell Ctrl+F find bar.
  Screenshots land in `tests/e2e/artifacts/stream-demo/`; `HOLD=0` exits instead of holding the browser
  open. Deterministic (fake-LLM, approvals resolved via the SW `__mlApprovals` channel). The automated
  assertions are `python-stream.spec.mjs` (the reverse channel) and `output-scroll.spec.mjs` (tail-follow).
- **Real model:** point the extension at a real backend with `E2E_BACKEND=<chatUrl>
  E2E_MODEL=<id> E2E_KEY=<bearer>` (the observer also accepts `USE_ENV=1` to read
  `OPENWEBUI_URL/KEY/MODEL` + `OPENWEBUI_UTILITY_MODEL`/`OPENWEBUI_VISION_MODEL` from `.env`).
  Warm-up fires a 1-token completion before the timed window so the ~20GB cold load doesn't
  pollute timings (Ollama's keep-alive TTL keeps it warm between runs — only the first pays it).

**CI (`.github/workflows/tests.yml`):** two Playwright jobs. `e2e` is the **deterministic gate**
(fake-LLM, every push/PR, under `xvfb`). `e2e-real-model` is a **non-blocking** sanity check
(`continue-on-error`, `workflow_dispatch` + nightly) that runs **only the `@real-ok` tests** (everything
else scripts the model, so it skips or tests something a real model has no bearing on) against a free
hosted OpenAI-shaped model —
default **Groq**, enabled by the repo secret `GROQ_API_KEY_FREE`, overridable via repo variables
`E2E_REAL_BACKEND`/`E2E_REAL_MODEL`; it self-skips without the secret. Hard-won findings: a real model on this job produced a Groq
`tool_use_failed` 400 — `attempted to call tool 'orient' which was not in request.tools` — having invented
a tool from the system prompt's own numbered method ("1. ORIENT — get your bearings"). Groq validates tool
calls server-side, so a hallucinated name is a hard 400 rather than a recoverable step, which is one more
reason this job is non-blocking. **GitHub Models is retired** (its API 410s a "retirement brownout" — don't use it); **`llama-3.3-70b` on
Groq emits malformed `<function=…>` tool calls** — use an `openai/gpt-oss-*` model, which complies;
the Groq **free tier is 8000 TPM**, so a multi-turn agent (the ~3.2k-token system prompt re-sends
each turn) trips it — hence the rate-limit backoff below. GPU-less CI runners can't run a real model
usefully (tiny CPU models botch tool-calling), so a free hosted API is the only real-model option in
CI; do real iteration on a local GPU box instead.

- **Rate-limit backoff (`prepareRequest`'s `send`, `background.ts`).** A 429 with a `Retry-After`
  header or a "try again in Xs" body hint is **paced and retried** (bounded by `RATE_LIMIT_RETRIES`
  / `RATE_LIMIT_MAX_WAIT_MS`, abort-aware) rather than failing the run — so a free/shared backend
  degrades to slow-but-successful. `rateLimitWaitMs` is pure/unit-tested; the retry-then-succeed and
  give-up-after-cap behaviour is in `tests/background.test.js`. Harmless on a local backend (Ollama
  never 429s).

## Branches, PRs and CI

Work goes on a **branch and through a PR**, not straight onto main: several sessions work this repo at
once (this one on the UI, another on the benchmark/pointers), and the PR is what runs CI — which is what
catches what one session broke for another. A green local `npm test` is not that check: it does not run
the e2e suite, three Node versions, or the real-CPython tests.

`.github/workflows/tests.yml` runs on `pull_request` (and on pushes to main), and **cancels superseded
runs per branch** so a fix supersedes the run it replaces instead of queueing behind it; main is exempt,
because every commit there keeps its result.

**The `ci` skill (`.claude/skills/ci/SKILL.md`) is the playbook**: open the PR, watch it in the
BACKGROUND (`gh pr checks --watch`, ~5 minutes for a full run), read only the failing steps
(`gh run view <id> --log-failed`), fix forward on the branch, and — importantly — the list of
KNOWN-BAD failures that arrived from other branches, so a red check that is not yours is named in the PR
body rather than chased or silently re-run.

## Forked backends (two features need a patched server)

Most of this runs against stock Ollama + stock OpenWebUI. Two capabilities do not, and
**`docs/FORKED-BACKENDS.md`** is the accounting — read it before assuming a resource-panel field is
broken:

- **`GET /api/info`** (machine capacity) and **`gpus[]` on `/api/ps`** (which card a model is on, and how
  a split is divided) come from `parawanderer/ollama`, branch `local/ps-gpu-attribution`. Stock Ollama
  doesn't serve `/api/info` at all — OpenWebUI answers with its SPA's HTML, which is why a non-JSON body
  is read as "unknown", never as an error. Without them `ml.info()` is `null`, the panel draws no ceiling
  and says so, and a multi-GPU box cannot attribute a model to a card.
- **`POST /api/v1/tools/id/{id}/execute`** comes from `parawanderer/open-webui`, branch
  `ml/tool-execute-endpoint` — it runs the callable the chat pipeline would, so an external client can
  drive its own loop over OpenWebUI-configured tools. **The extension does not call it yet**: server
  tools go through upstream's `tool_ids` + `function_calling` loop (hence the `SERVER_TOOL_MODES` probe).

A patched Ollama behind a STOCK OpenWebUI is fine — the `/ollama/*` passthrough is generic, so the
OpenWebUI fork is not needed for the capacity work.

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
