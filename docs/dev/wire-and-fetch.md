# Fetching, wire formats and streaming

Implementation notes for Markdown negotiation, `ml.pipe`, protobuf chat streaming, the engine's live token count, sources, resolved model and reasoning, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**Site-authored Markdown twins (`pageInfo`).** Many docs platforms publish a clean, agent-oriented Markdown
version of each page and DECLARE it in `<head>`. Standing on such a page the agent had no way to know the twin
existed and would survey the rendered DOM instead, which is strictly worse text. `pageInfo` now reports it, so
the agent can fetch the declared version rather than scraping the page. (`pageInfo` also stopped naming a tool
the run may not have been given — a suggestion the model cannot act on is worse than none.)


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

**Protobuf chat streaming (`protoStream`, three states).** OpenAI's SSE re-sends `id`/`object`/`created`/`model`/
`system_fingerprint` and the `choices[0].delta` wrapper for EVERY token — ~224 bytes of envelope around ~5 of
text. A patched Ollama serves the same stream as varint-delimited protobuf instead: the invariant half arrives
once in `Start`, a token costs a tag + a length + its bytes, and `End` replaces the finish chunk, the usage
chunk AND `data: [DONE]`. Measured through the proxy on `gemma4:31b`: **7343 → 292 bytes, 25.1x**.
**One `Accept: application/protobuf` header, sent hopefully and never sniffed** — the path is chosen from the
RESPONSE's Content-Type, so a stock server, an older build or a proxy that drops the header answers with the
SSE it always did and the miss IS the fallback (the same shape as the Markdown ladder's first rung).
**THREE STATES, and `"auto"` is the DEFAULT** (`ProtoMode` in contract.ts; read every stored value through
`protoMode()`, never raw — `chrome.storage.sync` keeps what it was given, so an existing profile still hands
back the BOOLEAN this replaced, and `true` maps to `"auto"` because that user asked for the negotiation and
not for a report about it). `"off"` never sends the header. `"auto"` sends it and takes whatever comes back,
in silence — safe on every backend, which is why the default could move from off to on: asking costs one line
and the miss is the fallback, so there was nothing for the old default to protect. `"on"` sends the identical
request and REPORTS a reply that is not protobuf — once per URL per worker (`servedProto`), because the state
is an assertion about your backend and a silent miss is exactly what you turned it on to hear about. It
reports rather than throwing: a wire format must never cost you an answer, so the SSE path still runs and
`"on"` buys visibility, not a hard failure. The settings warning about a URL that can never serve it (the
OpenWebUI route) is gated on `"on"` for the same reason — under the default it would be a permanent caveat
about a preference nobody expressed, which is the noise that teaches people to skip the times it means
something. The
decoder is **GENERATED** from the schema (`scripts/gen-proto.mjs` → `src/proto/chat.gen.ts`, checked in
because CI has no protoc; `tests/proto.test.mjs` regenerates and diffs, skipping where protoc is absent). That
is not tidiness: `tool_calls` and `logprobs` arrived upstream — field and encoder together, in one commit,
after the handover had said they were missing — and this read them **with no change here**, because
regenerating from a pinned schema absorbs that where a hand-written decoder (a second copy of the field
numbers) would have silently ignored them. The schema is not ours, so it is **pinned by git blob id**
(`src/proto/chat.proto.pin.json` → `parawanderer/ollama:middleware/chat.proto`, beside the Go encoder, which
is what makes it the definition rather than a copy of one). `npm run gen-proto -- --check` verifies the
vendored copy OFFLINE (a blob id is content-addressed, so it holds in CI and a fresh checkout), confirms the
commit still carries that blob when GitHub is reachable, and reports when upstream has moved on — which a
content hash alone cannot, since "we match commit X" stays true forever.
**`toolIds` KEEPS SSE**, and that is PERMANENT rather than a gap waiting on a field. `sources` is not part of
a completion: OpenWebUI emits it ahead of the model's first token, narrating a retrieval it already did, on
`/api/chat/completions` — which proxies ollama's NATIVE `/api/chat` and parses the stream line by line to run
filter functions. The protobuf encoder lives on `/ollama/v1/chat/completions`, a raw passthrough that path
never touches, so a `sources` field could never be filled: permanently empty is not "no sources" and not
"sources dropped" but indistinguishable from both, where an absent field says "ask elsewhere". Serving
protobuf for that class means teaching OpenWebUI's transcoder to emit it — real work, not a schema line. **No `TextDecoder` anywhere in this path** — it
is binary, and decoding it as UTF-8 corrupts it silently rather than throwing. The framing half
(`src/protostream.ts`) is ours because it is not in the schema: `fetch()` chunk boundaries have nothing to do
with message boundaries, so the reader buffers and yields only whole frames, refuses a length prefix claiming
the world, and treats **bytes still held at the end as a transport failure** rather than a short answer.
`tests/e2e/proto-stream-live.mjs` is the debug probe against the real box, and
**`tests/e2e/proto-live.spec.mjs`** the assertions — opt-in via `USE_ENV=1` and skipped entirely without it,
because the backend is live and CI has neither it nor a GPU. They are the only things that put the SERVER'S
OWN bytes through the built extension rather than frames this repo also wrote, and they cover the four cases
that matter: a streamed reply really arrives as protobuf; a real TOOL CALL survives it (a tool the model
cannot answer without, so the run cannot pass by answering from pre-training — and its ARGUMENT is asserted,
which is what says the fragments were reassembled rather than merely that a call happened); the setting OFF
sends no header at all; and a backend that will not serve it still works. That last one uses OpenWebUI's own
chat route on the same box — a route that genuinely cannot answer protobuf, which is a better test of the
fallback than any stub. The wire is observed by wrapping `fetch` in the SERVICE WORKER realm, because the
decode is invisible downstream by design: a caller cannot tell which format delivered its tokens, so asking
the caller would prove nothing.
**Both streaming paths carry it**: `streamLLM` (`ml.chat`) and `streamAgentTurn` (the agent loop, where the
saving actually lands, since a turn re-sends a large prompt and streams a long reply). They share one
`handleChunk`, so the formats differ only in how a chunk is RECOVERED from the wire and cannot drift into
different behaviour.

**The live token count is the ENGINE's (`withLiveCount` in sw-llm.ts).** It was chars/4 over the streamed
reasoning and content, which is not merely approximate: it FROZE for as long as a model took to write a tool
call, because argument fragments carry neither. `streamAgentTurn` now asks for the running count on every
chunk — `stream_options: {include_usage, continuous_usage_stats}` on the OpenAI route (vLLM's name and shape,
so it works there too), `stream_metrics: true` on ollama's native one, `Delta.completion_tokens` (field 6) on
protobuf — and carries it as `tokens` on `agent-stream` → `liveStream.tokens` → the orb, which shows it
unrounded and without the `~` an estimate gets. Three facts about it: it is a RUNNING TOTAL, never summed; it
includes thinking tokens and the end-of-sequence token that produces no text, so it can exceed what the text
shows; and a new count is news on its own, so a chunk carrying only an argument fragment still fans a delta.
**A strict backend may refuse the unfamiliar key** with a 400, so a refusal is retried once without it and
the URL remembered for the worker's life (`refusesLiveCount`) — a wire nicety must never cost an answer. A
stock server that ignores it simply sends no count, and the estimate stands in. `streamLLM` (`ml.chat`) does
not ask: nothing there reads a live count, and on SSE every chunk would carry the usage object for nothing.

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
