# Remote tool execution: streaming and timing

A spec for the OpenWebUI-side endpoint that evaluates a tool on the server, written for whoever
implements it there. It covers two things the current endpoint does not do, both of which are much
cheaper to build in now than to retrofit: **streaming its output**, and **reporting how long it
actually spent**.

Nothing here needs the extension to change first. The client side already accepts both.

## What exists

`POST /api/v1/tools/id/{id}/execute` (fork `parawanderer/open-webui`, branch
`ml/tool-execute-endpoint`) runs the callable the chat pipeline would, so an external client can drive
its own loop over OpenWebUI-configured tools. It returns a single response when the tool finishes.
The extension does not call it yet — server tools currently go through upstream's `tool_ids` +
`function_calling` loop.

## Why streaming

Every tool the extension runs locally can stream its output as it works. `exec` tees each
`console.log`; `python_exec` tees the Pyodide worker's stdout through worker → offscreen → service
worker → page. The UI renders it Jupyter-style, into an output cell with tail-follow and an in-cell
find.

A tool that runs on a server is the case where this matters *most*, not least. It is the one the user
can least see into, and it is the one most likely to take minutes. A single response at the end means
a bar that sits there saying nothing and then jumps — the same problem, on a longer timescale, that
made us draw in-flight spans at all.

The client-side surface for it already exists and is generic: a tool's `run(args, ctx)` may call
`ctx.stream(text, ts?)`. Nothing about it assumes a local producer.

## Why the endpoint must time itself

The extension measures the tool's span with its own wall clock, which for a remote call contains the
network and whatever queueing happened on the server. That total is not attributable: a step that
took 9 seconds could be a slow tool or a busy box, and no amount of client-side measurement separates
them.

This is settled ground for model calls. Ollama reports `eval_duration` beside our wall clock, and the
difference is the network. We recently had to add `prompt_eval_duration` for the same reason — without
it, "wall minus generation" silently charged the box for the model reading its prompt. A remote tool
executor that reports only its result recreates exactly that confound.

So: **report your own measured evaluation time**. One number makes the difference recoverable.

## Wire format

Two modes, selected by the request. Keep the existing non-streaming shape working unchanged.

### Request

```jsonc
POST /api/v1/tools/id/{id}/execute
{
  "params": { ... },        // the tool's arguments, as today
  "stream": true            // NEW, optional, default false → today's single response
}
```

### Streaming response

NDJSON, one JSON object per line, `Content-Type: application/x-ndjson`. Chosen over SSE because
Ollama's native route already uses it and the extension has a parser for that shape; SSE is equally
fine if it is more natural on your side, but pick one and say which.

```jsonc
{"type":"output","text":"resolving deps\n","atMs":12}
{"type":"output","text":"building\n","atMs":840}
{"type":"output","text":"done\n","atMs":9310}
{"type":"result","result":{ ... },"durationMs":9400,"queuedMs":120,"truncated":0}
```

**`output` frames** carry a DELTA, not the accumulated text. The client appends. This matches
`ctx.stream`, and it means a dropped connection loses the tail rather than corrupting what arrived.

**`atMs` is an OFFSET**, in milliseconds, from when *you* started evaluating — not an epoch
timestamp. This is the one place the local design does not transfer directly. Locally the producer
and the consumer share a clock, so `ctx.stream` takes an absolute stamp and the UI renders it. Your
clock and the user's are not the same clock, and a gutter rendering timestamps from a host skewed by
even a few seconds would show output that arrived before it was requested. Offsets are unambiguous
and the client anchors them.

For the record, the anchoring rule the client uses: the first frame's arrival time minus its own
`atMs`. The residual error is bounded by one-way network latency, which is not measurable from one
side — so it is bounded and acknowledged rather than pretended away.

**The `result` frame is last and mandatory**, even on failure. Fields:

| field | required | meaning |
| --- | --- | --- |
| `result` | yes | the tool's return value, same shape as the non-streaming response |
| `durationMs` | yes | how long YOU spent evaluating. The whole point of this document |
| `queuedMs` | no | time between accepting the request and starting to evaluate, if you queue. A third bucket, exactly like Ollama's `load_duration`: "the tool was slow" and "the tool had not started" are different answers |
| `truncated` | no | characters dropped if you cap output (see below). Omit or `0` when nothing was |
| `error` | no | present instead of `result` when the tool threw. A string the model can read |

### Errors

An error is a `result` frame with `error` set, not an HTTP status and not a dropped connection. A tool
that fails is a normal step outcome the model reads and reacts to; a transport failure is not, and the
client has to tell them apart. Reserve non-200 for "the request was bad" and "the tool does not
exist".

Partial output already streamed before a failure stays valid — do not retract it. Local tools behave
the same way: `python_exec` captures the traceback and keeps the stdout that preceded it, because what
the tool printed before dying is usually what explains the dying.

### Cancellation

**Treat a closed connection as a cancel** and stop evaluating. The extension aborts in-flight work
when a run is cancelled or the tab goes away, and it cancels by dropping the request — that is already
how a streaming model call is aborted (the port disconnects, the fetch aborts). A server that keeps
running a cancelled tool is burning someone's machine for output nobody will read.

### Output cap

Cap what you stream, and say how much you dropped via `truncated`. The client caps too (12 000
characters for the UI, less for what reaches the model), but a runaway `while true; do echo` should
not become a network problem before it becomes a display problem. Keep the HEAD and count the rest —
the first output is nearly always the useful part.

## What the client does with each field

Not requirements on you, but worth knowing what the numbers become, because it explains why the shape
is what it is:

- `output.text` → `ctx.stream(text, ts)` → the live output cell, then the step's `streamOutput`.
- `output.atMs` → anchored to local time → `streamMarks`, the per-line "produced at" gutter, which is
  explicitly documented as stamped by whoever produced the line rather than by whoever displays it.
- `result.durationMs` → the tool phase of the step's span, with the remainder of the client's own
  measurement rendered as network. Without it, that split cannot exist.
- `result.queuedMs` → its own phase, drawn like a model load: real elapsed time that is not work.

## The phase this creates, and what it may not claim

The export format's `ExportPhaseKind` is already `@unstable` in anticipation of this, and the naming
matters. The distinction the client can honestly record is **how a tool was dispatched** — in process,
or by calling an HTTP endpoint that evaluates it. That is a fact about our own dispatch.

It is *not* a claim about where the work ran. An in-process tool can itself attach to a VM or container
over IPC, and nothing on our side sees that. So the phase will be named for the dispatch, not for
"local" versus "remote", and this endpoint's arrival is what makes the distinction observable at all.

There is a security half to the same fact: dispatching over HTTP means the arguments leave the
machine. That belongs in the approval prompt on our side, and it is a reason the distinction has to be
visible rather than an implementation detail.

## Not in scope

- Authentication and tool permissions — unchanged from the existing endpoint.
- Anything about which tools are exposed, or how they are configured.
- Bidirectional streaming (a tool asking the client a question mid-run). Interesting, not now.

> *Drafted by Claude Code*
