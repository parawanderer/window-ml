# Programmatic export (JSON)

Status: **spec, not built.** Branch off `main` after `md-negotiation` merges.

A third export format, beside PDF (flat, rendered) and Markdown (LLM-readable, a `.zip`
once images exist). This one is for **programs**: something another tool can load without
knowing how we format markdown.

## Why not a third sink

`AGENTS.md` says "a third format = a third sink, not a third walker", and that is right for
*document* formats. It is wrong here.

The `Sink` vocabulary (`sidebar/export.ts:38`) is `title` / `meta` / `head` / `sub` /
`prose` / `note` / `code` / `block` / `speech` / `inline` / `image` / `details` / `table` /
`divider`. Those are presentation verbs. A JSON sink would emit a serialized *document* —
our layout decisions in JSON clothing — which is the exact coupling this format exists to
remove. A consumer would be parsing our choice to put something behind a `details` rather
than reading a field.

So this serializes the `Session` (`sidebar/store.ts:44`) directly and skips the walk. It is
also less code: no sink implementation, no walker changes.

The one piece worth reusing from the walker is `sidebar/timestamps.ts` for per-line stamps
on streamed output, which is already shared between the sidebar and both sinks.

## Consumers, and what each one needs

Design pressure comes from these, roughly in order of likelihood:

| Consumer | Needs |
| --- | --- |
| Debugging window.ml (`observe.mjs` run dirs) | everything, stable ordering, structural diffability |
| Model sweeps — N tasks × M models | model provenance, token usage, step counts, outcome flags |
| Regression comparison between two runs | stable ids and ordering; volatile fields identified so a differ can strip them |
| Custom renders (timelines, contact sheets) | render descriptors, images, per-step timings |
| Dataset construction from successful runs | the model-facing text, verbatim |
| Cost accounting | usage per turn/step, totals per model |

**Relationship to `events.json`.** `observe.mjs` already dumps the raw `__mlDebug` stream.
That is not this. To use it a consumer must replay our reducer, including the pending/DONE
patching by `seq`. This format is the *reconstructed* session — the thing you get after
that replay — so it is consumable without reimplementing our internals. Both can coexist;
`events.json` is a transport log, this is the record.

## Shape

```jsonc
{
  "schema": 1,                         // integer, bumped on breaking change
  "exportedAt": "2026-09-03T09:41:02.113Z",
  "generator": { "name": "window.ml", "version": "<extension version>" },
  "session": {
    "hash": "a1b2c3d4",
    "kind": "agent",                   // "agent" | "chat"
    "title": "…",                      // may be absent (lazily summarised)
    "createdAt": "…", "lastAt": "…",
    "status": "done",                  // as the sidebar's Status
    "model": "gemma4:31b",             // the session's model, when one is pinned
    "config": { … },                   // DebugSessionConfig / DebugAgentConfig verbatim
    "task": "…",                       // agent runs
    "outcome": {                       // derived, see below
      "status": "done",
      "hitCap": false, "cancelled": false, "resumed": false,
      "error": null,
      "turnsRun": 7, "maxSteps": 20
    },
    "totals": { … },                   // derived, see below
    "messages": [ … ],                 // agent: says/answers interleaved. chat: turns
    "steps":    [ … ],                 // agent only
    "events":   [ … ]                  // the timeline; derived, see below
  }
}
```

### A step

Fields are the `AgentStep` (`sidebar/store.ts:37`) with transient UI state dropped:

```jsonc
{
  "step": 3,                    // the loop's turn number (several steps share one)
  "localStep": 3,               // per-turn index in a multi-turn session
  "seq": 11,                    // monotonic; the stable ordering key
  "at": "2026-09-03T09:40:58.220Z",
  "durationMs": 812,            // from toolMs
  "thought": "…",
  "reasoning": "…",             // separate thinking text, when the model produced it
  "tool": "exec",
  "arguments": { … },           // raw, exactly as the model emitted them
  "argIssues": ["unknown property: foo"],
  "result": "…",                // the fuller captured output (what the UI shows)
  "modelResult": "…",           // what the model actually received; omitted when identical
  "streamOutput": "…",          // live output, when the tool streamed
  "streamMarks": [[0, 1756890058220]],   // [offset, epochMs] per line
  "token": "@tool:9f2a",        // tool-token id, when one was minted
  "approval": "user",           // provenance: readonly | sandbox | same-origin | … | denied
  "elements": 12,               // count only; DOM nodes cannot cross the bus
  "renderIn":  { … },           // RenderDescriptor, verbatim
  "renderOut": { … },
  "feedback":  { … },           // what was fed back to the model, and why
  "usage":    { … },            // TokenUsage for the model call
  "subUsage": { … },            // delegated sub-calls (look / locate / verify)
  "grants": [ … ], "reused": [ … ]
}
```

**Dropped as transient UI state:** `pending`, `awaitingApproval`, `liveStream`, `ended`,
`endedStep`. These describe a live view, not the run. A `pending` step never appears —
only its DONE.

### The timeline

`session.events` is the resource panel's event lane, published: what ran, when, and for how
long, as a flat list of spans and instants. It is derived from the step records above, using
the same function the panel uses (`sidebar/model-stats.ts`), so the two cannot disagree.

```jsonc
{
  "kind": "tool",               // run | gen | tool | embed | load | evict | error | note
  "label": "exec",
  "at": "2026-09-03T09:40:55.020Z",
  "endedAt": "2026-09-03T09:40:58.220Z",   // absent → an instant
  "durationMs": 3200,
  "model": "gemma4:31b",
  "id": "step:a1b2c3d4:11",     // opaque, unique within the document
  "parent": "run:a1b2c3d4",     // the event that spawned it
  "seq": 11,                    // the step it came from
  "tool": "exec",
  "phases": [                   // contiguous from `at`; only on a tool event
    { "kind": "model", "ms": 900 },
    { "kind": "wait",  "ms": 1500 },
    { "kind": "tool",  "ms": 800 }
  ],
  "cost": { "inTokens": 10, "outTokens": 5, "tokPerSec": 6.25, "genBasis": "eval",
            "evalMs": 800, "wallMs": 900 }
}
```

It is published rather than left to each consumer because the arithmetic is easy to get
subtly wrong, in the same three places every time:

- **Spans run backwards.** A step's timestamp is when it FINISHED. Reconstructed forwards,
  every bar sits one generation to the right of the work it describes.
- **A tool step is one event with phases**, not three events. The model deciding, the human
  at the approval gate and the tool running are three kinds of time inside one step, and the
  wait is the step's wall clock but not the machine's work — frequently the largest part.
- **A model load is its own event.** "The model was slow" and "the model wasn't there yet"
  are different answers. Only real loads appear: a resident model reports a few ms of
  bookkeeping on every call, and those are floored out.

Delegated sub-calls carry `parent`, so a reader model's cost is attributable instead of
hidden inside the step that spawned it. `evict` events are in the union because the panel
draws them, but they are read off consecutive `/api/ps` polls — a fact about the box, not
about a session — so they never appear in an export.

### Derived fields

The agreed exception to "raw only". Three consumers immediately want these, and if the
format omits them each one recomputes them slightly differently and they stop agreeing:

- `step.durationMs` — from `toolMs`.
- `session.totals` — `{ steps, turnsRun, tokensIn, tokensOut, subcallTokens, wallMs, byModel: { "<model>": { calls, tokensIn, tokensOut } } }`.
- `session.outcome` — the flags above, gathered in one object rather than scattered as
  optional booleans.
- `session.events` — the timeline, above.

Everything else is verbatim. Nothing derived is *only* derived: the inputs stay present, so
a consumer that disagrees with our arithmetic can redo it.

### Rules

- **Nested, never flattened.** A flat step table is trivial to derive from this; the
  reverse is lossy.
- **Stable ordering.** Steps by `seq`, messages by `atStep` then `ts`. Object keys emitted
  in a fixed order so a byte diff of two exports is meaningful.
- **Images inline as data URLs.** One file, no archive — a program ingesting exports should
  not have to unzip. This is the deliberate difference from the markdown export, which uses
  PNG sidecars because a coding assistant can open a `.png` and cannot read base64.
- **Absent, not null.** An optional field that has no value is omitted, so `"error" in step`
  is a meaningful test. The exceptions are inside `outcome`, where the flags are always
  present so consumers need no defaulting.
- **Volatile fields**, for anyone diffing two runs: `exportedAt`, every `at` / `ts`,
  `durationMs`, `wallMs`, `streamMarks`, `hash`, and any tool token. A differ that ignores
  these compares behaviour rather than timing. An event's `phases` and rate go with them; what
  survives is the SHAPE of the timeline — which events, in what order, spawned by what, costing
  how many tokens — which is the part worth diffing.

## Size

Both `result` and `modelResult` are kept whenever they differ (the raw-view rule: the log
always carries what the model actually saw). With data-URL images, an image-heavy run gets
large. That is the accepted price of losslessness for a machine format. If it becomes a
problem, the first lever is an option to drop `renderIn`/`renderOut` image payloads while
keeping their metadata — not truncating `modelResult`, which would break the rule.

## Surface

- A third entry in the export dropdown, beside Markdown and PDF.
- Downloads `ml-agent-<hash>.json` (or `ml-chat-<hash>.json`), matching the existing base
  name, via the same `downloadBlob` path — the iframe cannot touch the filesystem.
- No new config, so nothing is needed in DevTools Settings.

## Tests

`tests/export.test.mjs` already covers the markdown sink; add beside it:

- an agent session round-trips: every step present, ordered by `seq`, `arguments` and
  `modelResult` verbatim
- a chat session exports turns with model provenance and usage
- transient state is absent (no `pending` step, no `liveStream`)
- `totals` agree with summing the parts, and `turnsRun` counts distinct `step` values
  rather than `steps.length` (see the note at `sidebar/store.ts:39`)
- a step whose `result` and `modelResult` differ keeps both
- an image-bearing step emits a data URL, and the output is a single file
- the output is valid JSON with stable key order across two exports of the same session
