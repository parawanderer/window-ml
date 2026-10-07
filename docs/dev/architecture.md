# The extension's architecture, in detail

The map is in AGENTS.md; this is the detail behind it, moved out of AGENTS.md on 2026-10-07 so that file stays
small enough to load into every session. Read the section you are about to change.

## The contract's modules

**The CONTRACT is one contract in eleven files.** `contract.ts` holds `MlApi` (the shape of `window.ml`
itself), `JsonSchema`, and a BARREL — `export * from "./contract-<theme>"` for each themed module. Everything
still imports from `./contract`, and that is not politeness: roughly a hundred references are written as the
inline type query `import("./contract").X`, which is a string no refactoring tool rewrites, and `gen-api-docs`
and `gen-export-schema` both start from this file by path. All of them follow an `export … from` out to the
real declaration, so the barrel is what makes the split invisible. **Run `node scripts/index.mjs '^contract-'
--kind file --word` for this list live**:

| Module | What it holds |
| --- | --- |
| `contract-agent.ts` | `MlTool` and the loop around one: `AgentOptions`, `ToolContext`, `ToolResult`, `AgentResult`, and the approval pair (a request describes what is ASKED; a grant records that a human answered) |
| `contract-messages.ts` | the wire: the three message-name unions and every payload that carries more than a string, plus `StoredSession` |
| `contract-config.ts` | `MlConfig`, `DEFAULT_CONFIG` (duplicated in popup.ts — keep in step), and `MlPublicConfig`, whose omissions are a security boundary |
| `contract-debug.ts` | the debug event stream: every `MlDebugEvent` four surfaces render and `run.json` carries |
| `contract-server.ts` | what the backend reports about itself, and the pure readings of it (`generatesText`, `backendStateFrom`, …) |
| `contract-chat.ts` | a model call and what came back: `NeutralMessage`, `ChatOptions`, `TokenUsage`, and `RunStats` — the one place a run's tok/s is computed |
| `contract-fetch.ts` | `FetchResult`, `ContentKind`, and the whole `TableLike` representation. No imports, so a parser can be pointed at it alone |
| `contract-render.ts` | `RenderDescriptor` and the vision shapes it is usually derived from |
| `contract-pointers.ts` | resolving a `@tool:<id>`, and the output cap that decides how much of one reaches the context |
| `contract-run.ts` | a run's identity and provenance: `shortHash`, the request hints, the background-run pair |

**Give a new module a blank line after its header comment.** A `//` run touching the first declaration is read
as that declaration's documentation by anything that parses comments by adjacency, and `gen-api-docs` duly
printed two module headers into the model-facing API reference. `tests/api-docs.test.mjs` fails on it now.

## The service worker's modules

`background.ts` is the message ROUTER + the print/nav spine. Every cohesive leaf
layer lives in its own `sw-*.ts` module it imports — all bundled back into
`dist/background.js` by esbuild, so the split is invisible at runtime and to the
tests, which load the bundle. **Run `node scripts/index.mjs '^sw-' --kind file
--word` for this list live**; it is here because you need it to know where to
look at all:

| Module | What it owns |
| --- | --- |
| `sw-llm.ts` | the per-format request builders `API_FORMATS`, `getConfig`, capability probes, `fetchLLM`/`streamLLM`/`streamAgentTurn` + `prepareRequest`, model-list / `setModel` / unload |
| `sw-fetch.ts` | the ml.fetch GET, the rendered background-tab fetch, the credentialed Sheets pull — the security-sensitive guards `SHEET_URL_OK` + the response-header safelist |
| `sw-cdp.ts` | the `chrome.debugger`/CDP layer: attach lifecycle + `cdpClick`/`cdpEval`/`cdpScreenshot`/`cdpShadowResolve`/`cdpKeyType` |
| `sw-consent.ts` | WHO IS ALLOWED TO ASK: the pending approval gates, the per-tab grant ledgers, `senderTrust` |
| `sw-runs.ts` | WHAT THE WORKER KNOWS ABOUT A RUN: `bgRuns`/`activeRuns`, the storage snapshot + rehydration, the replay buffer, the session pointer store |
| `sw-values.ts` | the value store's worker side: what is stored, who holds it, when it goes, how large it may grow |
| `sw-events.ts` | ONE connection to the fork's `/api/events`, fanned to every open resource panel |
| `sw-sessions.ts` | the background's session index, as the chat page's local host sees it |
| `sw-hub.ts` | this browser as a runtime on a hub: the connection (`hub-runtime.ts`) started from the keyring, its state for Settings |
| `sw-attention.ts` | what needs someone's hand on this runtime, as the codes `capabilities.attention` carries |
| `sw-tools.ts` | running ONE OpenWebUI-configured tool ourselves, in our own loop, with arguments we chose |
| `sw-housekeeping.ts` | the one housekeeping log and its two messages |
| `sw-debug.ts` | the DevTools panel's copy of the page's debug stream: one ring buffer per inspected tab, fanned to every panel on it |
| `sw-run-host.ts` | HOSTING one background run: the design-A loop, every tool delegated back to the page that built the toolset, approval gated through the sidebar |
| `sw-python.ts` | the offscreen Pyodide host: who may run `full` mode, and the live stdout relay back to whoever awaits it |

A privileged handler CONSULTS `sw-consent.ts` and MUTATES `sw-runs.ts`, which is
why neither belongs in the router.

## Message types beyond the three-file pattern

**`ABORT_TASK`** (cancel an in-flight task by requestId; the page posts `ABORT_REQUEST`,
`content.js` relays it) and the streaming `LLM_STREAM_*` port — both handled outside HANDLE_MAP.

**Resume (`ml.resumeChat(hash)`).** Continue a chat by its session hash.
Same-tab sessions resume from an in-memory `sessionRegistry` (every `createChat`
registers itself by hash); across reloads/tabs only `{ save: true }` sessions
survive — each turn persists via `SAVE_SESSION` → `chrome.storage.local`
(`ml_session_<hash>`), and `resumeChat` rehydrates via `GET_SESSION`, rebuilding a
history from the stored messages + createChat options (no secrets in a session).
The main world can't touch storage, hence the round-trip. A saved session is
readable by any page that knows its (random 128-bit) hash — fine for chat history,
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

## Tools (ml.step / toolIds) and cancellation

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

## Rate-limit backoff

- **Rate-limit backoff (`prepareRequest`'s `send`, `background.ts`).** A 429 with a `Retry-After`
  header or a "try again in Xs" body hint is **paced and retried** (bounded by `RATE_LIMIT_RETRIES`
  / `RATE_LIMIT_MAX_WAIT_MS`, abort-aware) rather than failing the run — so a free/shared backend
  degrades to slow-but-successful. `rateLimitWaitMs` is pure/unit-tested; the retry-then-succeed and
  give-up-after-cap behaviour is in `tests/background.test.js`. Harmless on a local backend (Ollama
  never 429s).

## Model-access filter

- **Model-access filter (`modelFilter`, a regex whitelist, default empty).** When set,
  the wrapper only calls models whose id matches — enforced on the RESOLVED model in
  `prepareRequest` (main/ocr/grounding/utility all pass through) and in `setModel`, and
  `LIST_MODELS` filters its response so a page's `ml.models()` never even sees an excluded
  (e.g. cloud) model. Invalid regex fails **open** (a typo can't brick every call; settings
  flags it). `modelFilterAllows` (contract-config.ts, pure) is the single source shared by the
  background enforcement and the settings row/datalist markers. `modelFilter` is NOT in the
  `GET_CONFIG` public subset — the page can't read the filter.
- The background's cross-origin fetches rely on `<all_urls>` host permission,
  which "On click" site access withholds for third-party hosts (e.g. image
  CDNs) — a known limitation, not a bug. The popup's **Permissions → "Enable
  Google Sheets access"** requests just the Google origins at runtime
  (`chrome.permissions.request`), a narrower grant than "On all sites".
