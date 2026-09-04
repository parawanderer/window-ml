# Remote tool execution: streaming and timing

How a tool that runs somewhere other than this browser reports what it is doing while it does it, and how
long it actually spent.

**Primary target: MCP.** It is a real standard, it already streams, and it is what tool authors build
against. Two things follow: most of this document is a *mapping* rather than an invention, and the only
genuinely new thing in it is one `_meta` key.

**Secondary target: OpenWebUI's `/execute`.** Built and working (`parawanderer/open-webui`, branch
`ml/tool-execute-api`), reaching what MCP cannot — OpenWebUI's own local Python tools, its OpenAPI
tool-server configuration, and its access control. Not proposed upstream.

**Status: neither is consumed yet.** The extension still drives server tools through upstream's `tool_ids`
+ `function_calling` loop. This is the contract to write the client against.

## Why streaming, and why timing

Every tool the extension runs locally streams its output as it works. `exec` tees each `console.log`;
`python_exec` tees the Pyodide worker's stdout through worker to offscreen to service worker to page. The
UI renders it into an output cell with tail-follow, an in-cell find, and a per-line "produced at" gutter.

A tool that runs elsewhere is the case where that matters *most*, not least: it is the one the user can
least see into, and the one most likely to take minutes. The client-side surface is already generic — a
tool's `run(args, ctx)` may call `ctx.stream(text, ts?)`, and nothing about it assumes a local producer.

Timing is the other half. We measure a remote call with our own wall clock, which contains the network and
whatever the far end was doing before it started. That total is not attributable: a step that took nine
seconds could be a slow tool or a busy box, and no amount of client-side measurement separates them.

This is settled ground for model calls. Ollama reports `eval_duration` beside our wall clock, and the
difference is the network. We recently had to add `prompt_eval_duration` for the same reason — without it,
"wall minus generation" silently charged the box for the model reading its own prompt. An executor that
reports only its result recreates exactly that confound.

---

## Part 1 — MCP

### What MCP already gives us

A `tools/call` over the Streamable HTTP transport can respond with an SSE stream, and the server MAY send
JSON-RPC notifications related to the originating request before the final response. Two are relevant:

- **`notifications/progress`** — opted into by the client putting a `progressToken` in the request's
  `_meta`. Carries that token, a `progress` value that must increase, an optional `total`, and an optional
  human-readable `message`.
- **Logging notifications** — the client asks for a minimum level, and *where* it asks is version-dependent.
  The DRAFT specification puts `io.modelcontextprotocol/logLevel` in a request's `_meta`, i.e. per call.
  The shipped Python SDK (`mcp==1.27.2`) has no such key: what exists is `logging/setLevel`, a request in
  its own right that sets the level for the **session**. Treat per-request level as not yet reachable.

  The practical consequence outlives the version question: log verbosity is a property of the connection,
  so two concurrent calls sharing one connection cannot ask for different levels. Nothing here depends on
  that — OpenWebUI's `/execute` connects per call — but a future client that pools connections would be
  surprised, and should raise the level per connection rather than per call.

Cancellation, error semantics (protocol errors as JSON-RPC errors, tool execution errors as `isError` on
the result) and structured results (`structuredContent` against a declared `outputSchema`) are all
specified. None of that needs anything from us.

### What MCP does not give us

**A tool result carries no timing of any kind.** Nothing on a result says how long the server spent
evaluating, so the confound above is unresolvable within the standard as it stands.

### The `_meta` extension

MCP's `_meta` is the designated place for this, and its key-naming rules are explicit: an optional prefix
of dot-separated labels followed by `/`, reverse-DNS by convention, with any prefix whose **second label**
is `modelcontextprotocol` or `mcp` reserved for MCP itself. A third-party key under our own domain is
exactly what the mechanism is for.

**Key: `dev.wander.windowml/timing`, on the `_meta` of a `tools/call` RESULT.**

Normative TypeScript: `src/tool-protocol.ts` (`TOOL_TIMING_META_KEY`, `ToolTiming`). Language-neutral
twin, for implementers not writing TypeScript: [`tool-timing.schema.json`](tool-timing.schema.json).

```jsonc
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resultType": "complete",
    "content": [ { "type": "text", "text": "..." } ],
    "_meta": {
      "dev.wander.windowml/timing": {
        "durationMs": 9400,      // required: time spent EVALUATING the tool
        "queuedMs": 120          // optional: elapsed before evaluation began
      }
    }
  }
}
```

- **`durationMs`** — how long the server spent actually evaluating, excluding transport. The whole point.
  A client subtracts it from its own wall measurement to get the network plus the far end's overhead.
- **`queuedMs`** — elapsed time before evaluation started: scheduling, access checks, a module import, a
  downstream connect. Real elapsed non-work time, drawn the way a model load is drawn. Omit it rather than
  reporting `0` when nothing measurable happened — a zero asserts a measurement.

Both are milliseconds and both describe *this* call. A server that cannot measure either omits the key
entirely: an absent key means "unknown", never "instant". That distinction is load-bearing everywhere else
in this codebase and it holds here.

The extension ignores an unrecognised `_meta` key, as any conforming client must, so a server that never
implements this degrades to exactly today's behaviour — a span whose composition is unknown, reported as
unknown.

### Mapping MCP to the client's frames

The extension normalizes every source into one internal frame model — `ToolFrame` in
`src/tool-protocol.ts`, with its schema at [`tool-protocol.schema.json`](tool-protocol.schema.json).

It is OUR model, not a protocol to implement. It is typed and published so a consumer gets real models,
but the wire format anyone implements is MCP's, or `/execute`'s; inventing a rival to MCP is the mistake
this shape exists to avoid. What the schema cannot express — that a `result` frame is last and mandatory,
that `output` frames are deltas, that a closed connection means cancel — is in this document, and is as
normative as the types.

For MCP:

| MCP | frame | why |
| --- | --- | --- |
| logging notification | `output` | a log line is a line, and concatenates correctly |
| `notifications/progress` | `event` | a monotonic counter plus a bar label — see below |
| result `content` / `structuredContent` | `result` | the tool's return value |
| `isError: true` on the result | `result` with `error` | a normal step outcome the model reads and reacts to |
| JSON-RPC error response | transport failure | not a tool result, and must never reach the model as one |
| `_meta["dev.wander.windowml/timing"]` | `result.durationMs` / `queuedMs` | the attribution above |

**Progress is not output**, but the reason is narrower than it first looks, and getting the reason right
decides a second question below.

It is NOT about the model's context. Streamed output never reaches the model: `makeStreamFan` in
`agent-loop.ts` feeds `deps.emit` and nothing else, so `ctx.stream` drives the output cell and the model
receives the tool's returned RESULT. Streaming is a human-facing preview throughout.

The reason is that `progress` is a monotonic number whose `message` is a label for a bar. Appended as
deltas it renders "step 1step 2step 3" — each one replaces the last conceptually while accumulating
literally. A log line is a line and concatenates correctly; a progress label does not. So progress goes to
the human-facing render slot as structure, and logging goes to `output` as text.

**Which settles the OpenWebUI `status` question the other way.** An emitter `status` description is prose,
not a counter, and it is frequently the only text such a tool ever emits — routing it to `event` would
mean many tools stream nothing at all. It maps to `output`, as Part 2 describes and as the implementation
does. Since streamed text is human-facing, there is no context cost to weigh against that.

---

## Part 2 — OpenWebUI `/execute`

The wire format as built.

### Request

```jsonc
POST /api/v1/tools/id/{id}/execute
{
  "name": "search_web",     // the function WITHIN the bundle this tool id names
  "arguments": { "q": "..." },
  "stream": true            // optional, default false -> the single-response shape
}
```

> **BUILT AS.** An earlier draft of this document showed `{"params": {...}}`, which was wrong: a tool id
> names a *bundle* of functions, so the call has always been `{name, arguments}` — the same pair a model
> emits as a tool call.

### Non-streaming response

Unchanged apart from two added keys, which are compatible and just as useful there:

```jsonc
{ "tool_id": "...", "name": "search_web", "result": ..., "durationMs": 9400, "queuedMs": 120 }
```

### Streaming response

NDJSON, `Content-Type: application/x-ndjson`, one JSON object per line:

```jsonc
{"type":"output","text":"Searching the web","atMs":12}
{"type":"event","event":{"type":"chat:message:files","data":{"files":[]}},"atMs":840}
{"type":"result","tool_id":"...","name":"search_web","result":{},"durationMs":9400,"queuedMs":120}
```

**`output` frames** carry a DELTA, not accumulated text. The client appends, so a dropped connection loses
the tail rather than corrupting what arrived.

**`atMs` is an OFFSET** in milliseconds from when the executor started, not an epoch timestamp. This is the
one place the local design does not transfer. Locally the producer and the consumer share a clock, so
`ctx.stream` takes an absolute stamp and the UI renders it; a remote host's clock is not the user's, and a
gutter rendering a host skewed by a few seconds would show output that arrived before it was requested.

The client anchors at the FIRST frame's arrival minus its own `atMs`, then adds each subsequent offset. The
residual error is one-way network latency, which is not measurable from one side — bounded and
acknowledged rather than pretended away. `anchorFor` / `anchorOffset` in `src/tool-protocol.ts` are the
shared implementation, so two adapters cannot each invent a rule.

**`event` frames** forward an implementation-defined payload verbatim, with no text derived from it. A
client that only knows `output` and `result` ignores the type and loses nothing it could have used.

**The `result` frame is last and mandatory**, even on failure:

| field | required | meaning |
| --- | --- | --- |
| `tool_id`, `name` | yes | which callable this was, echoed back |
| `result` | yes* | the return value. Present unless `error` is |
| `durationMs` | yes | time spent evaluating |
| `queuedMs` | yes | elapsed before evaluation began — resolution, not scheduling (below) |
| `truncated` | no | characters dropped if output was capped. Absent when nothing was |
| `error` | yes* | a string the model can read, INSTEAD of `result`. Never both |

> **BUILT AS.** Three things the implementation settled.
>
> **There is no stdout to stream.** A tool callable is awaited once and returns a value; OpenWebUI has no
> streaming tool protocol. The only progress channel is `__event_emitter__`, which this endpoint was
> discarding and which now becomes frames — so a tool that only `print()`s streams nothing at all.
> Capturing stdout was rejected deliberately: it is process-global, so concurrent requests would interleave
> into each other's streams. Practical consequence: output volume is whatever the tool author chose to emit
> for the chat UI, typically a handful of status lines rather than a build log.
>
> **Hence the `event` frame.** Emitter payloads are UI-shaped and inconsistent — `status` carries text in
> `data.description`, message kinds in `data.content`, and files and citations are purely structural with
> no text at all. Deriving text would mean dropping those, so they are forwarded whole. `__event_call__` —
> an emitter that asks the user a question and expects an answer — stays a no-op, since there is no channel
> to answer on and emitting an unanswerable question is worse than dropping it.
>
> **`queuedMs` measures RESOLUTION, not scheduling.** Nothing queues in front of the tool; what happens
> before evaluation is access checks, a DB fetch, a module compile, or an MCP connect. Real elapsed
> non-work time, which is the bucket the field was asked for — but do not render it as "waiting for a slot".

### Errors

An error is a `result` frame with `error` set, not an HTTP status and not a dropped connection. A tool that
fails is a normal step outcome the model reads and reacts to; a transport failure is not, and the client
has to tell them apart. Non-200 covers everything decided before the first byte: unknown tool, no access,
malformed body.

Partial output already streamed before a failure stays valid — do not retract it. Local tools behave the
same way: `python_exec` captures the traceback and keeps the stdout that preceded it, because what a tool
printed before dying is usually what explains the dying.

> **BUILT AS.** Streaming loses the 400. A wrong-arguments `TypeError` genuinely is "the request was bad",
> but by the time it is raised the response has started, so it arrives as an `error` frame.

### Cancellation and cap

**A closed connection is a cancel.** The extension aborts in-flight work when a run is cancelled or the tab
goes away, and it cancels by dropping the request — the same way a streaming model call is aborted. A
server that keeps running a cancelled tool is burning someone's machine for output nobody will read.

Output is capped head-keeping at `TOOL_STREAM_OUTPUT_CAP` (100 000 characters) with the dropped count in
`truncated`. The client caps too — 12 000 for the UI, less for what reaches the model — but a runaway loop
should not become a network problem before it becomes a display problem, and the first output is nearly
always the useful part.

---

## Part 3 — OpenWebUI's MCP proxying is lossy today

Worth stating, because it is the reason MCP is the primary target rather than something reached through
OpenWebUI.

**FIXED** on `ml/tool-execute-api` (`682524b93`): `MCPClient` gained `listen(sink, level)` /
`stop_listening()`, wiring `logging_callback` and `call_tool`'s `progress_callback`, and `/execute` feeds
both into the same frame queue as its own emitter events. Three details worth keeping: the level is raised
in `listen()` rather than at connect (so a connection nobody watches asks for nothing) and is gated on the
server declaring the `logging` capability; a progress token is attached only while something is listening,
since the SDK minting the token is also what opts the call into progress at all; and a sink that raises is
swallowed, because a broken consumer must not take a tool call down. `message_handler` is deliberately
left unwired — it also receives logging notifications, so wiring both double-delivers.

`structuredContent` is still discarded, and deliberately so: returning it changes what every existing
caller receives, including the chat pipeline, which is a behaviour change rather than a repair.

What follows is what was wrong, kept because it is the shape of mistake worth recognising elsewhere.

`backend/open_webui/utils/mcp/client.py` connected with `streamablehttp_client` — the streaming-capable
transport — and then discarded everything that streams:

```python
self._session_context = ClientSession(read_stream, write_stream)      # no callbacks wired
result = await self.session.call_tool(function_name, function_args)   # no progress callback
```

No logging callback, no message handler, no progress callback. An MCP server that faithfully emitted
progress and log notifications during a two-minute call had every one of them dropped — a streaming
transport connected to nothing that reads. The general form: a capability is not acquired by choosing a
transport that has it.

---

## Using the official MCP SDK (measured, not assumed)

The client half is unwritten, and the obvious way to write it is `@modelcontextprotocol/sdk`. Measured
against `1.30.0`, bundled with esbuild for `platform=browser`, because an MV3 service worker is a hostile
enough target that the package's own docs do not answer the question.

**The HTTP client path is genuinely worker-shaped.** It bundles with zero errors and contains no `node:`
imports, no `process.`, no `__dirname`, and — the one that would have settled it — no `EventSource`, which
service workers do not have. It reads the SSE stream off `fetch` through `eventsource-parser`.

**But the obvious import is a trap.** `import { Client }` costs **298 KB minified**, and
`client/index.js` imports the SDK's ajv provider, so the bundle contains `new Function`. MV3 forbids
`unsafe-eval`. It would not fail at load; it would fail the first time a tool declares an `outputSchema`
and ajv tries to compile a validator for it — a landmine rather than an honest error.

**Importing only `StreamableHTTPClientTransport` avoids both**: **138 KB minified**, no `new Function`, no
ajv. What remains is zod, the transport, and `eventsource-parser`.

That is the shape to take. The transport is the part genuinely worth not writing — session handling, SSE
framing, reconnection, resumption tokens: the things that are subtly wrong rather than obviously broken
when hand-rolled. `Client` on top of it is mostly JSON-RPC correlation and schema validation, and the
second is redundant here: tool arguments are already checked by `validateArgs`, and results go through the
frame model.

The cost is real and worth stating plainly. 138 KB is a large addition to a service worker, and most of it
is zod validating a protocol we could parse with `JSON.parse` and a type guard. Against that: hand-rolling
means owning session resumption and SSE edge cases permanently, and lossy streaming clients fail quietly
rather than loudly — the fix in Part 3 is the proof.

**Not yet verified:** that the transport works against a live MCP server from inside a service worker.
Bundling clean is not running clean, and `chrome-extension://` origin CORS plus the extension's host
permissions are the plausible next obstacle. That is a spike against a real server, not a bundler question.

## What the client does with each frame

- `output.text` to `ctx.stream(text, ts)` to the live output cell, then the step's `streamOutput`.
- `output.atMs` anchored as above to `streamMarks`, the per-line "produced at" gutter, which is documented
  as stamped by whoever produced the line rather than whoever displays it. Never treat `atMs` as an epoch.
- `event` frames carry no text and must NOT join the accumulated output — the model would be reading UI
  plumbing. Ignore them, or surface them in the render descriptor.
- `result.durationMs` becomes the tool phase of the step's span, with the remainder of the client's own
  measurement rendered as network. Without it, that split cannot exist.
- `result.queuedMs` becomes its own phase, drawn like a model load: real elapsed time that is not work.
- An `error` frame is a normal step outcome the model reads. **A truncated stream with no `result` frame is
  a transport failure**, and must not reach the model as a tool that returned nothing — that is a wrong
  answer dressed as an empty one, and the model has no way to tell.

## The phase this creates, and what it may not claim

`ExportPhaseKind` is already `@unstable` in anticipation. The distinction the client can honestly record is
**how a tool was dispatched** — in process, or by a call to something that evaluates it. That is a fact
about our own dispatch.

It is *not* a claim about where the work ran. An in-process tool can itself attach to a VM or container
over IPC and nothing on our side sees that. So the phase is named for the dispatch, and this work is what
makes the distinction observable at all.

There is a security half to the same fact: dispatching to something else means the arguments leave the
machine. That belongs in the approval prompt, and it is a reason the distinction has to be visible rather
than an implementation detail.

## Not in scope

- Authentication and tool permissions — unchanged from whatever the source already does.
- Which tools are exposed, or how they are configured.
- Bidirectional streaming (a tool asking the client a question mid-run). MCP specifies this as
  `input_required` results and elicitation, which is a better answer than anything invented here, but
  nothing consumes it yet.

## Sources

- [MCP tools](https://modelcontextprotocol.io/specification/draft/server/tools)
- [MCP `_meta` key rules](https://modelcontextprotocol.io/specification/draft/basic/index)
- [MCP progress](https://modelcontextprotocol.io/specification/draft/basic/utilities/progress)
- [Streamable HTTP transport](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http)

> *Drafted by Claude Code*
