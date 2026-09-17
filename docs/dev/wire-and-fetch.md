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

**Tables (`csv`/`tsv`/`parquet`/`arrow` → `FetchResult.table`).** A table body is PARSED on the way through, into a
pandas-shaped `TableLike` (`shape`, `columns`, `dtypes`, `rows` — contract.ts; the parsers are in
`table-data.ts`). The CSV counterpart of `json`/`schema`, for the same reason: a caller that has to re-split
the text is a caller that will get the separator wrong, which is exactly what `looksCsv` used to guarantee by
assuming a comma. The delimiter is now DISCOVERED (`,` `\t` `;` `|`, by Papa Parse), so a semicolon export
mislabelled `text/plain` stops classifying as prose.

Three things about where the work happens, each load-bearing:

**Delimited text parses PAGE-SIDE**, in `ml.fetch`'s `.then`, next to the `.markdown` distillation and for the
same reason — the text has already crossed the message channel, so parsing there adds nothing to the wire,
while parsing in the worker would send every row twice. **Parquet parses in the WORKER**, because the opposite
is true: the bytes have no reason to reach the page at all, and a `TableLike` crosses far more cheaply than
the file. Its `text` is a one-line description rather than the bytes, since every reader of `.text` expects
something printable. **The decoder (hyparquet) is DYNAMICALLY imported** — `table-data.ts` is reachable from
the page bundle through classification, and a static import would ship a Parquet decoder to every page the
extension touches; deferred, esbuild tree-shakes it out of every bundle whose entry never calls it.

**Arrow IPC parses in the WORKER too** (`tableFromArrow`, `apache-arrow`, dynamically imported like hyparquet — about
220 KB minified, all of it in `background.js`; its one `new Function` is in the table BUILDER, which the reader never
calls). The File format is recognised by its `ARROW1` magic whatever it is served as; the Stream format has no
magic, so only its media type (`application/vnd.apache.arrow.stream`) or extension (`.arrows`) sends it to the
decoder, and a body that claimed to be a stream but does not decode is described as `binary`. dtypes come from the
schema with pandas' null rules, exactly as Parquet's do; dates and timestamps become ISO strings.

Binary is detected before classification, never after: a Parquet body run through `res.text()` is already
corrupt by the time anything could sniff it, so `rawGet` reads an ArrayBuffer whenever the type/extension
makes it plausible, checks the `PAR1` magic at both ends, and decodes to text only when it was NOT Parquet.

**Every other body is sniffed for BINARY on its bytes, before any decode** (`binaryKind`, body-read.ts): a NUL in
the first 8,000 bytes, git's rule, with a UTF-16 byte-order mark read as text and a PDF named even without one.
A binary body becomes `type: "binary"`, and its `text` describes it — the format named from its magic (Arrow IPC,
ZIP, gzip, PNG, JPEG, GIF, WebP, PDF, SQLite, WebAssembly), the content type, the size — and says it is not shown.
It skips the Markdown ladder. Before this, a body nobody recognised was decoded as UTF-8 and reached the model byte
for byte, under a note claiming it was the site's authored Markdown. That note now needs an actual `accept` HIT:
a ladder that STOPPED at rung 1 because the body was not HTML (a JSON API) resolves as `accept` too, and is not one.

What the model gets is a `df.head()` plus `[N rows x M columns]` and the dtypes — the shape being the part a
clip can never carry. `pipe` opts out (a model that wrote a scan wants its scan's lines), and `schema: true`
answers with the frame. The RENDER descriptor ships at most `RENDER_TABLE_ROWS` rows to the sidebar and the
export, but carries `rowCount`, so a pointer to a 50,000-row table does not describe itself as a 200-row one.
`python_exec`'s `tables` takes the same URL and loads the parsed table out of the fetch cache — the cache is
the gate, so it is not a new egress, and the sandbox never needs `read_csv` (it has no network anyway).

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
**TWO ENCODERS NOW, and `toolIds` no longer keeps SSE.** The second is OpenWebUI's own `/api/chat/completions` in
the fork (`parawanderer/open-webui`, branch `ml/tool-execute-api`), which is the route most setups actually use.
What had made that impossible was `sources`, OpenWebUI's retrieval provenance, emitted ahead of the first token with
nowhere to go in the schema — so `toolIds` calls were excluded. Two findings from the people who own that route
killed the exclusion rather than the feature: `sources` reaches that stream WITHOUT `tool_ids` by four routes (a
model's attached knowledge, `files` on the request, folder files, `features.web_search`), so the gate never
protected provenance; and the browser UI does not use this branch at all (it takes a socket.io path, since an API
client sends no `chat_id`/`message_id`), so changing it cannot affect the UI. The schema gained one message —
`Event { string json = 1; }`, field 4 of the oneof — and anything that is not a completion chunk becomes one,
carried verbatim: this hands it to the same `format.streamChunk` the SSE line went through, so there is one reader
of that shape whichever wire delivered it.
**The header therefore carries a parameter: `Accept: application/protobuf; events=1, text/event-stream;q=0.9`.**
OpenWebUI's route serves protobuf ONLY with `events=1`, deliberately — a decoder generated before that frame
existed would skip field 4 in silence, and the frame it skipped would be the provenance one. The ollama passthrough
ignores the parameter and never sends an `Event`.
**And the case for it is decode cost, not bytes.** Measured on the box over a 795-delta reply: SSE 196,781 B,
gzipped SSE 11,788 B, protobuf 7,864 B — so gzip alone would capture 98% of the byte saving. Decoding costs 0.497 ms
for SSE, 0.560 ms for gzipped SSE (the inflate adds to a `JSON.parse` that already dominated) and 0.080 ms for
protobuf: 6.2x cheaper, and the only option that wins on both axes. **No `TextDecoder` anywhere in this path** — it
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
unrounded and without the `~` an estimate gets. The DevTools footer (`RunStatsBar`) adds it to "out" while the call
streams (`liveOutTokens`) and drops it once the step lands with its own usage; the bar subscribes to `rev` itself, since
reading the stats signals memoizes it on a session object that is mutated in place. Three facts about it: it is a RUNNING TOTAL, never summed; it
includes thinking tokens and the end-of-sequence token that produces no text, so it can exceed what the text
shows; and a new count is news on its own, so a chunk carrying only an argument fragment still fans a delta.
**A strict backend may refuse the unfamiliar key** with a 400, so a refusal is retried once without it and
the URL remembered for the worker's life (`refusesLiveCount`) — a wire nicety must never cost an answer. A
stock server that ignores it simply sends no count, and the estimate stands in.

**The THINKING count is the same running total, frozen while the call is still thinking** (`reasoningTokens` on
`agent-stream` and on the turn's `TokenUsage`). Thinking comes first and the count is cumulative, so its value on
the last chunk before any answer text or tool-call fragment arrived IS the number of thinking tokens. The check
runs after a chunk's fragments are recorded: the chunk that starts a tool call carries a count that already
includes it. A server's own `completion_tokens_details.reasoning_tokens` wins when it is positive — ollama and
OpenWebUI send 0 for a model that thought for pages, so a 0 is not taken. The sidebar's thinking block shows a
counted figure plain and an estimate (chars/4) with `~`; a non-streamed turn has no count and stays an estimate. `streamLLM` (`ml.chat`) does
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
