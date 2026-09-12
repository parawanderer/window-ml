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

**Read-only `exec` auto-approve.** `autoApproveReadonly` (on by default) runs a read-only DOM survey with no
prompt, through a mediated mini-interpreter (`readonly-exec.ts`) that is itself the whitelist and never compiles a
string. Anything outside its dialect falls through to the normal approval: gaps degrade to "asks the human", never
to "runs unsafely". How it works: `docs/dev/agent-tools.md`; spec `docs/spec/READONLY_EXEC_SPEC.md`.

**RULE — extending the dialect requires adversarial tests.** Any time you add a construct to the
read-only dialect (a new statement/operator/pattern, a new allowed method, a new facade member),
you MUST — without being asked — add ADVERSARIAL tests that try to abuse the NEW pattern to reach
something it shouldn't (extract/invoke an effectful method, walk to `window`/`constructor`/a realm,
mutate, spend tokens, loop unbounded) and assert each is REJECTED (`NotInDialect`/`Denied`) or
rendered inert (the `METHOD_REF` sentinel). A new binding form (e.g. destructuring) must be probed
for whether it can bind a live method or reach a denied prop; a new allowed method for whether its
return leaks the realm. The invariant is unchanged: gaps degrade to "asks the human," never to "runs
unsafely" — new tests prove the new surface keeps that.

## Where the implementation notes live — read the one you are about to change

This file holds the rules for working in the repo and the traps. How each subsystem works, and why it is built
that way, lives in `docs/dev/`. Read the matching file BEFORE changing that code: most of what is in them was
learned by shipping the wrong version first.

| Changing… | Read first |
| --- | --- |
| agent tools, the read-only dialect, locate/vision, `verify`, cross-page runs, approvals over IPC, how a run renders in the sidebar | `docs/dev/agent-tools.md` (+ `docs/LOCATE-VISION.md` for locate, `docs/spec/READONLY_EXEC_SPEC.md`) |
| `python_exec`, the sandbox modes, the Python bench and its editor | `docs/dev/python-sandbox.md` |
| streamed tool output, the output cell, line maps, tracebacks, code-block buttons, retry diffs | `docs/dev/output-and-code.md` |
| `@tool:` pointers, `dereference`, the pipe dialect, the pointer macro | `docs/dev/pointers.md` (+ `docs/POINTER-IDENTIFIERS.md`) |
| the Markdown/PDF export, the JSON export and its schema | `docs/dev/export.md` |
| `ml.fetch` Markdown negotiation, protobuf streaming, the live token count, sources/reasoning plumbing | `docs/dev/wire-and-fetch.md` |
| the resource panel (VRAM/RAM) and the event lane | `docs/dev/resource-panel.md` (+ `docs/spec/RESOURCE_PANEL.md`) |
| the overlay vs DevTools surfaces, `debugMode`, shared UI components | `docs/dev/sidebar.md` |
| the patched Ollama/OpenWebUI features and how the client reads them | `docs/FORKED-BACKENDS.md` |
| the e2e harness, observe, the bench, live probes, demos | `docs/dev/e2e-harness.md` (+ each tool's skill in `.claude/skills/`) |

**The traps, one line each** — enough to stop you breaking something before you have opened the doc:

- **Resource panel.** Memory is raw BYTES and BINARY: convert once, through `formatBytes`. Absent is not zero and
  not idle (`memory`, `activity`, `processes`, `gpus` all mean "not reported" when missing). Never pro-rate a split
  model across cards. The event stream names models fully-qualified and `/api/ps` short: `normModel` at the
  boundary. Screen↔time goes only through `runWeight`/`runFrac` (the axis is linear in time). A memo over the
  lane's events keys on `events.length`, never `events`. Every residual band key must be in `bandOrder`, and a band
  that belongs to a model steps with it — but steps run only from the bottom of the stack (`stepBands`), and a
  line band rides the steps' corners (`bandEdge`), or the stack draws wedges. A residual's note names its OWN
  backend's context (CUDA / HIP / generic; host RAM and unified memory have their own), never CUDA by default. A
  lane test seeds `ml_res_sections: { lane: true }` and a box (`setCapacity`/`setResident`) or nothing is drawn.
- **Event lane.** Spans run BACKWARDS from a finish stamp; a tool step is ONE event with phases; a load is its own
  event. Phases are drawn only where something TIMED them.
- **Pointers.** `PIPE_CMDS` is the single source for every description of the dialect. The three reference forms
  (`@tool:"label"`, 7-hex id, bare tool name) are told apart by SHAPE, never tried in order.
- **Python.** Each call is stateless; `readonly` mode hardens the sandbox and may auto-approve, `full` always asks.
  The wheels (`pyodide-wheels/`) are gitignored and a missing set fails only at run time.
- **Wire formats.** The protobuf path is chosen from the RESPONSE's content type, never sniffed; no `TextDecoder`
  anywhere near binary; `toolIds` keeps SSE permanently. A strict backend refusing an optional request key is
  retried once without it — a wire nicety must never cost an answer.
- **Sidebar.** One app, two surfaces: a new app→parent message must also be handled in `panel.ts`, and anything
  that acts back on the page needs the reverse channel (panel → background → content shell).
- **Exports.** Diff two runs with `run.json` after stripping `VOLATILE_FIELDS` and running `canonicalizeText()`.

## Showing a run: the log, the exports and tooltips

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

**WHICH ARTIFACT TO REACH FOR.** A run can be got out four ways and they are not interchangeable. Picking
the wrong one costs a whole read-through, so:

| You want to | Reach for | Because |
| --- | --- | --- |
| READ a run — what the model did, in order, with the images | **`run.md`** (+ `images/`) | It is the canonical human narrative. Screenshots are real PNG sidecars, so a coding assistant can open them; base64 in a text file is unreadable to everyone. |
| Read it in a browser, folded | **`run.md.html`** | The same markdown rendered, every `h2` collapsible, and a failed run's status links AT the step that broke. Relative asset paths, so it works off the disk and under a server. |
| DIFF two runs | **`run.json`** | A markdown diff is mostly layout. Strip `VOLATILE_FIELDS` and run `canonicalizeText()` first, or every pointer id and timestamp shows as a change. |
| Parse a run from Python/Go, or build a tool on it | **`run.json`** + `docs/spec/export.schema.json` | The schema is normative and checked in; generate models from it. Fields tagged `@unstable` will grow. |
| Hand a run to a person who is not you | **the PDF** | Self-contained, light-themed, images inlined, prints with sane page breaks. Nothing to unzip and no sidecars to lose. |
| Collect data for tuning the server's VRAM predictor | **`ml.__loads()`** | One record per load: the prediction, the load's own figures and the measured trace (peak, settled, every sample). Collected only with the panel's "load predictions" toggle on. |
| Debug the resource panel / the event lane | **`ml.__events()`** | Not an export at all: the raw INPUTS the timeline is derived from (the debug stream, the server's frames, ps/info). Use it when the drawn events look wrong, because the drawing is what is in question. |

The one that surprises people: **`run.json` carries `session.events`**, the whole timeline the resource panel
draws — spans, phases, model loads, sub-call lineage. That is the "event spam", and it is the point: it is
derived by the same `eventsFrom` the panel uses, so a consumer never redoes arithmetic that is wrong in the
same three places every time (spans run BACKWARDS from a finish stamp; a tool step is ONE event with
`phases`, not three; a model load is its own event). If you are asking "where did the time go", that is the
file. If you are asking "what did it say", it is `run.md`.

**RULE — use the PANEL'S tooltip, not the browser's `title`.** `cursorTipOn(text)` (ui-kit.tsx) is the
default for anything explanatory; a native `title` needs an argument for itself. Three reasons, all of them
things a reader hits rather than notices: the native one waits about a second, which on something you are
hovering to decide whether to CLICK is long enough to have given up; it renders as an OS artefact rather than
as part of the panel, and cannot show a pointer as code or wrap a sentence sensibly; and on a wide target —
a code line, a table cell, a whole row — it appears wherever the pointer is while an anchored tip can sit
half a panel away from what summoned it. `cursorTipOn` follows the cursor and is read into the one shared
floating layer (`CursorTipLayer`), which is also what makes its prose unselectable, so copying a code block
never picks up the explanation of it.

  **TWO RENDER MODES, told apart by TYPE.** `cursorTipOn` takes a `string` OR a node. A STRING is markdown
  TEXT — escaped, then rendered inline (`code`, *emphasis*, math) — because a string is where content from
  OUTSIDE arrives: a JSON Schema's `description`, a tool result, a model's prose. Treating one as markup
  would be an injection. Anything else is authored JSX, passed as children rather than an HTML string, so
  there is no way to hand it something unescaped by accident. `TipText` (ui-kit) does the same for the
  ANCHORED `.tt-pop` tooltips whose prose comes from data — the JSON tree's key descriptions are our own
  parameter docs, which are full of backticked identifiers, and printing the backticks reads as a renderer
  that gave up.

  **What inline markdown will NOT do, deliberately**: no images (unbounded pixels in a gutter or a tooltip,
  and a tool result could put them there) and no links out of a model's prose — a one-click egress in chrome
  the reader trusts, whose text and destination markdown lets disagree. A pointer link stays text there too:
  navigating needs the run's `seq`, which this renderer has none of, and a link that goes nowhere is worse
  than plain text. Pointer links live in the ANSWER renderer, which has that context. Both refusals have a
  test, because both are currently true by accident of how the inline pass works.

  **The exception is an accessible NAME.** A `title` on an icon-only control is what a screen reader and a
  keyboard user get, and `cursorTip` is pointer-only — so those keep a name (prefer `aria-label`) and gain
  the custom tip for the pointer. The split is: naming a control → `aria-label` (+ a tip); explaining
  anything → the custom tip. When the prose must also be readable with no pointer at all, put a `.tt-pop`
  child in the DOM beside it, the way a marked code line does.

  Not yet swept: `settings.tsx`, `hud-card.tsx`, `card-composer.tsx` and `resource-chart.tsx` still hold
  native `title`s. New code follows the rule; those are a follow-up, not a licence.

## Conventions

**RULE — when one rule VALIDATES another's output, enumerate the inputs; do not sample them.** The resource
panel GENERATES layouts (`presetsFor`) and JUDGES them (`stackRefusal`), and the invariant is that a preset
may never propose a layout the rule then rejects. There is a drift guard for exactly that, and it shipped a
broken DEFAULT anyway, because it ran two machine shapes: a two-card box and a unified Mac. One discrete card
plus host RAM — the commonest machine there is — was assumed to be a weaker case of two cards. It is not: the
generator branched on `devices.length` while the rule judges POOLS, and those two quantities agree everywhere
except at one card, where a GPU plus the host is still two pools. The default preset proposed a stack the
panel then refused, on most people's hardware.

The general shape, which is worth recognising before it happens again:

- **A guard over generated output is only as good as the SHAPES of input it runs**, and "fewer of them" is a
  different shape, not a smaller one. Enumerate the kinds; do not pick two and assume monotonicity.
- **Watch for a PROXY quantity in the branch.** `devices.length` standing in for "how many pools" is the bug
  in one line — it was right on every box anyone had tested and wrong on the one they had not. When a
  decision is about X, branch on X, and if X is only available after a filter, read it after the filter.
- **The DEFAULT deserves its own assertion.** It is what a user meets without choosing anything, so it is the
  one worst to get wrong and the easiest to leave untested among a list.

**`tests/fixtures/boxes.mjs` holds the shapes** — one per kind of machine people actually have (two-card
CUDA, two-card ROCm, a four-card prosumer rig, a one-card laptop that has to spill, an eight-card lab node at
nine pools, and a unified Mac) — and it is SHARED with `resource-demo.mjs`, because a guard and a demo
disagreeing about what a box looks like is the same drift in another costume. Anything that routes on box
shape gets run against all of them.

**RULE — before you build a UI primitive, check whether it exists: `node scripts/components.mjs`.** One
grep-able line per sidebar component, hook and documented CSS class — `NAME kind file:line — first sentence
of its docstring` — so you search by CONCEPT (`grep -i pill`), which is the only way this works: nobody
greps `tok-chip` while about to write a pill. The failure it addresses is not "I searched and could not find
it", it is "I did not think to look": one session produced a CSS copy of the pointer chip, a FOURTH drag
handle, and a second view-return signal, and each was one grep away. Two of those three were CSS, not JSX,
which is why the index covers the stylesheet too.

The **docstrings are the index** (nothing is duplicated into a manifest that would go stale), so the cost is
that an undocumented export is INVISIBLE and gets rebuilt — `--undocumented` makes that loud and exits
non-zero. **Both halves are ENFORCED**, in the pre-commit hook and in CI's `tools` job: every exported
sidebar thing needs a docstring, and every CSS class a change ADDS under a new family needs a comment. CSS is
a ratchet rather than a rule because 323 of the stylesheet's 557 classes have none, and a check that ships
red is one people learn to scroll past — so it reads the diff against the merge base and asks only about what
you are adding. A member of a documented block passes on its ancestor (`.r-diff-head` inherits `.r-diff`),
because the failure being prevented is a NEW family under a name nobody would grep — a second pointer chip
called something else — not a paragraph per modifier. What you owe it: a new shared thing gets a first sentence saying what it is FOR in words someone
would search, and an EXTRACTION says what it replaced, because that sentence is what stops the third copy.
A TRAILING `//` counts as the docstring for a one-line export, which is the house style here — teaching the
scanner to read those fixed thirty of them with no churn, rather than having me move thirty comments above
their declarations to satisfy an indexer. Playbook: `.claude/skills/components/SKILL.md`.

**RULE — AGENTS.md holds working rules and traps; implementation notes go to `docs/dev/`.** Everything here is
loaded into every session, so it is for what you must know to work in the repo at all: the rules, the map, the
invariants, and one-line traps that break things silently. How a subsystem works and why it is built that way —
the explanation of a design, the bug that shaped it, the measurement behind a threshold — goes in that subsystem's
`docs/dev/<area>.md`, indexed under "Where the implementation notes live". A new subsystem gets a new file and a
row in that table, not a section here. Before adding a paragraph, ask whether someone NOT touching that code needs
it; if not, it belongs in the doc. (This file was 2,763 lines before the split — 257 KB in every session's context.)

**RULE — self-tools get a skill + an AGENTS.md mention, and you keep both current — WITHOUT asking.** Any time you
(or any model working on this repo) build a TOOL FOR YOURSELF — a harness, wrapper, driver, or script you'll re-use
to develop/debug/benchmark the extension (e.g. `tests/e2e/observe.mjs`) — you MUST (1) write a **Claude skill**
(`.claude/skills/<name>/SKILL.md`) documenting exactly how it's used (invocation, env knobs, when to reach for it,
gotchas), and (2) add a **brief mention** of it in AGENTS.md so the next agent discovers it (its detail goes in
`docs/dev/e2e-harness.md`). Keeping AGENTS.md, your skill files, and the scripts they describe **in sync and up to
date is YOUR responsibility** — every time you change a self-tool's behaviour, update its skill + the AGENTS.md
mention in the same change. Do this proactively, never ask the user whether to. (Skills live in `.claude/skills/`;
the `observe` skill is the reference example.)

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
- **A FAILED build leaves `dist/` alone** — `build.mjs` bundles into `dist.stage/` and swaps only on
  success, because the old order (delete, then build) left a loaded extension with no manifest whenever
  anything threw. The consequence to remember: a build you silenced (`npm run build >/dev/null 2>&1`) that
  FAILED now looks exactly like one that worked, and everything you run next tests the previous bundle —
  which will mislead a bisect. It exits non-zero and says so on stderr; do not discard that stream.
- **Iterating? Run a GENRE, not the suite: `npm run test:core`** (~8s, 978 tests) — `node scripts/test.mjs`
  with `core` / `panel` / `ext` / `python` / `live`, `--list` to see what each holds, `--timings` for
  per-file durations slowest-first. The full suite is ~2 minutes and three files are 80% of it
  (`sidebar` 53s, `background` 22s, `cdp-stream` 20s), which is the right cost in CI and the wrong one in a
  loop where you changed one pure module. `core` is DERIVED — everything the named genres do not claim — so
  a new test file runs by DEFAULT rather than falling out of every bucket and being silently skipped; the
  cost of that direction is that a new SLOW file quietly lands in `core`, which is what `--timings` is for.
  Still run the full `npm test` before you commit; CI runs everything regardless.
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
- **Running several sessions at once? Give each one its own CLONE**, as a sibling directory
  (`../window-ml-bench`, `../window-ml-md-negotiation`), and never work in whichever checkout the other
  sessions are using. Sharing one working tree costs real time, all of it observed rather than
  hypothetical: changes swept into another session's commit; their uncommitted files sitting in your
  `git status`, so `git add -A` is never safe; and the pre-commit hook regenerating
  `docs/spec/export.schema.json` from THEIR in-flight `export-schema.ts`, blocking an unrelated commit and
  telling you to stage their generated output.

  ```bash
  cd .. && git clone git@github.com:parawanderer/window-ml.git window-ml-<what-you-are-doing>
  cd window-ml-<what-you-are-doing>
  ln -s ../window-ml/.env .env                       # the backend + key, for USE_ENV=1
  ln -s ../window-ml/pyodide-wheels pyodide-wheels   # 28MB of static wheels, don't re-download
  git config core.hooksPath .githooks                # LOCAL config: it does not clone
  npm ci && npm run build
  ```

  The `core.hooksPath` line is easy to skip and its absence is silent in the worst direction: commits keep
  working, so nothing looks wrong, and the pre-commit checks (formatting, and regenerating
  `docs/spec/export.schema.json` to catch a stale one) simply never run. You find out in review.

  **Tell the user to open both directories in one VS Code window** (File > Add Folder to Workspace, or
  `code ~/git/window-ml ~/git/window-ml-bench`). Each session then edits its own tree while the human
  reads both side by side, and a file the user opens is unambiguous about which checkout it came from.

  A `git worktree` is the lighter alternative and shares the object store, but prefer a clone: a worktree
  has to symlink `node_modules` back into the shared checkout, and that coupling is what produced a
  self-referential symlink that replaced the real `node_modules` and left every dependency UNMET. Its own
  `npm ci` has no such edge. A worktree also refuses to check out a branch another worktree holds, which
  is occasionally what you want and occasionally just in the way.
- **Three gitignored things do NOT come with a fresh checkout, and no absence is loud.** `node_modules` is
  obvious (nothing runs); `pyodide-wheels/` is not — the build prints one `⚠ pyodide-wheels/ missing`
  line and carries on, `npm test` stays green because the CPython tests self-skip, and the failure only
  surfaces at RUNTIME as `ModuleNotFoundError: No module named 'numpy'` inside a `python_exec` step,
  which reads like a sandbox bug. **`.env` is the third**: `USE_ENV=1` (observe, the bench) then dies on
  `ENOENT ... /.env` before anything runs. Symlink `.env` and `pyodide-wheels` as above; run `npm ci` for
  `node_modules` rather than symlinking it. All three are ignored as plain names, so the symlinks cannot
  be committed — they previously had trailing slashes, which match a DIRECTORY only, and a `node_modules`
  symlink duly got committed and then replaced the real directory on the next pull.
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
  launches one per spec. Pass `headful: true` (the narrated demos do) or set `E2E_HEADFUL=1` for a look.
  **`E2E_DIST=<dir>`** runs specs against a bundle built elsewhere (`node build.mjs --outdir <dir>`) — use it
  whenever `dist/` is loaded in a window someone is using, rather than rebuilding underneath them. **A run is started exactly like a console call:** `page.evaluate(() =>
  window.ml.agent(task, opts))` — Playwright's `page.evaluate` runs in the page **main world**,
  where `injected.js` defines `window.ml`, so no test-only hooks; the same front door a human
  uses. The result structured-clones back to Node.
- **`fake-llm.mjs`** — a scriptable OpenAI-shaped backend (`startFakeLlm()` → `setScript([...])`)
  so the REAL pipeline (background loop → tool delegation → page) runs **deterministically with
  no Ollama**. A script step is `{ content }`, `{ tool, args }`, or `(reqBody) => step` (reactive
  — the final answer can echo a value a real DOM tool read off the page). This is the CI gate.
- **The suite is `fullyParallel`** (3 workers in CI, half the cores locally). Each test gets its own browser and
  its own servers on port 0, so tests share nothing. A spec that DOES share state across its tests (one browser
  from a `beforeAll`) must pin itself with `test.describe.configure({ mode: "default" })`, or its tests land on
  different workers, each running its own `beforeAll`.
- **RULE — a wait loop breaks on something that is on screen while a step is COLLAPSED.** Steps start collapsed,
  so anything inside a step body (`.r-py-in`, `.code.tb`, `.r-df-table`) is not in the DOM until the step is
  opened, and a `for (…; i < 60; …) { …; if (bodyThing) break; sleep(400) }` quietly runs to its cap and then
  passes anyway, because the test opens the step next. Eleven tests did that for 24–30 s each. Wait on the row:
  `.astep.tool:not(.pending)`. A test whose time is the same on a laptop and on CI is waiting on a timer.
- **`cross-page.spec.mjs`** — a `smoke` (extension loads + one-shot agent) + a `sanity` (agent
  reads a page value via a DOM tool and answers it) that run under BOTH the fake and a real
  backend, plus the skipped cross-page acceptance test (see `tmp/cross-page-agent.md`). Those two
  are tagged **`@real-ok`**, and a `beforeEach` SKIPS every other test in the file when
  `E2E_BACKEND` is set: the rest script an exact turn sequence and read `fake.calls()` back, so
  they cannot mean anything against a real model — and without the skip they dereferenced a null
  `fake` and failed, which reads as a product bug in the nightly real-model job. Tag a new test
  `@real-ok` only if it guards its fake usage (`if (fake) …`) and asserts on the run's own result.
- **The self-tools** (details and gotchas: `docs/dev/e2e-harness.md`; each has a skill in `.claude/skills/`):
  `observe.mjs` drives ONE agent run and writes `run.md`/`run.json`/screenshots — how a model debugs the
  extension. `run-once.mjs` is the core observe and the bench share (seeded histories included). `bench/` is a
  typed matrix over `runOnce` with spread, not point estimates, and its own CI job. Debug probes against LIVE
  backends (never in CI): `server-tool-live.mjs`, `md-ladder-live.mjs`, `proto-stream-live.mjs`,
  `capture-frames.mjs` (records real event-stream fixtures). Narrated demos (watched, never asserting):
  `approval-demo`, `resource-demo` (`BOX=`), `line-map-demo`, `cursor-demo`, `panel-news-demo`, `whole-box-demo`,
  `stream-demo`, `bench-editor-demo`, `bench-completion-demo`.
- **RULE — a demo says what it is doing, on screen: `narrate(page, "…", { sub: "…" })`** (harness.mjs). A
  demo is WATCHED, and a watcher who cannot tell which beat is running infers it from what moved — which is
  exactly backwards when the point of a beat is that something did NOT move. It draws a banner in the PAGE
  (top-left, its own element, very high z-index), deliberately not inside the extension's shadow hosts, so it
  can never be mistaken for part of the product and a demo about the sidebar cannot have its narration hidden
  by the sidebar. `narrate(page, null)` clears it for a screenshot that should show the product alone. Call it
  at every beat, not once at the start.

  The banner also says WHOSE WINDOW IT IS. A headful demo takes the pointer and the keyboard, and a watcher
  who cannot tell a finished demo from a paused one either waits for nothing or clicks into the middle of a
  beat — so every `narrate` marks the run as still driving, and **`narrateDone(page)` flips it** to "the
  browser is yours". Call `narrateDone` immediately before holding the browser open (or before exiting),
  never after a later `narrate`, which sets the status back to running.
- **RULE — a demo about what happens INSIDE a run must call `openRunInSidebar(page)`** (harness.mjs). The
  panel opens on the SESSIONS LIST, not on the run, so a demo that only slides the sidebar open queries an
  empty transcript, reads zero of everything, and reports that the feature does not work — which every demo
  here has done at least once. The helper slides the panel open, waits for the iframe, CLICKS the session row
  (optionally matched by task text) and waits for the detail view. It does not wait for the run to finish, so
  it is right for the live demos too.
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

**And the `background-work` skill (`.claude/skills/background-work/SKILL.md`) is how to run ANY slow
thing** — CI, an e2e suite (minutes, even parallel), a bench sweep — without stalling the session: start it with
`run_in_background: true` and go and do other work, because the harness re-invokes you when it exits.
The mistake it exists for is subtler than forgetting to background something: it is backgrounding it
and then blocking on its output file anyway (`until [ -s "$OUT" ]; do sleep 20; done`), which is a
foreground wait wearing a disguise and happened four times in one session. It also holds the
`dist/`-rebuild hazard — never build while an e2e suite is running, since the suite loads the bundle
you are replacing.

## Forked backends (patched servers)

Most of this runs against stock Ollama + stock OpenWebUI. Several capabilities need `parawanderer/ollama` (branch
`slop`) and one needs `parawanderer/open-webui` (branch `ml/tool-execute-api`): `/api/info` (capacity), `gpus[]`
and `memory` on `/api/ps`, `/api/events` (the scheduler's own transitions — the one thing polling cannot
approximate), `activity` (what the runner is doing), `processes` on each card, the engine's running token count,
and OpenWebUI's tool execute route. **Read `docs/FORKED-BACKENDS.md` before assuming a resource-panel field is
broken** — it is the accounting of what needs which build, and how the client reads each. Every one of them is
optional: absent means "this server does not report it", and the panel says so rather than inventing a value.

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
- **The page you are ON is free in every fetch mode; a local file is never read** (`isCurrentPage`, dom.ts).
  - Every `fetch_url` mode aimed at the current page (fragment ignored, query not) auto-approves, AS-YOU
    INCLUDED, on both loop paths: the page already holds it and can `fetch(location.href, {credentials:
    "include"})` itself. The credentials rule is about the REST of the origin. At the choke point, an as-you GET
    passes without a grant only when it is the SENDER's own frame URL — the loop's check only skips a prompt.
  - **`rendered + credentials` of the current page is its LIVE DOM** (`live: true`), read rather than loaded a
    second time in a session tab (which re-runs the page's scripts and their side effects). It is the ONLY mode
    answered that way: a plain or `format: "html"` fetch promises the server's or file's BYTES, and a
    sessionless `rendered` load is a fresh page — handing either the live DOM would be a different document
    under the name of the one asked for. Overlays are not stripped (that works by deleting nodes, which on the
    live page would edit the user's page).
  - `ml.fetch` holds the rule, so `fetch_url` (which calls it) and `ml.fetch` in `exec` cannot disagree. The
    read-only dialect hands `_fetchCached` the MODE (a sanitized copy) instead of dropping it, and serves a
    non-default mode only as a live read — it had been answering `rendered`/`format: "html"` from the
    default-mode cache.
  - The background refuses every non-http(s) URL: a `file:` read could be any file on the machine (`~/.ssh`, a
    `.env` holding the API key), a hostile page reaches that handler directly, and Chrome's fetch has no file
    scheme anyway. On a `file://` page the refusal names `rendered + credentials` as the one mode that works.
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
- `think` placement: Like `num_ctx`, OpenWebUI's OpenAI route reads `think` from the request-body **`params`**
  object, not top-level — a top-level `think:false` is silently dropped (reasoning keeps coming). `applyThink`
  places it per format: `params.think` (openai) vs a top-level `think` (ollama native).
