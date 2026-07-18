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
`SET_MODEL`, `MODEL_CAPS`, `OLLAMA_PS`, `OLLAMA_UNLOAD`, `FETCH_IMAGE_B64`.

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
