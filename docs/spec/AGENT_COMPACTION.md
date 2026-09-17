# Idea: the agent manages its own context over pointers

**Status: brainstorm, not started.** Written down on 2026-09-17 from a conversation about pointers, to come back to.
Nothing here is decided and nothing is measured. The numbers people reach for when this comes up ("most of the context is
stale tool output") are hypotheses for the benchmark below, not findings.

Related: [`COMPACTION.md`](COMPACTION.md) is the harness deciding when a session is too long; this file is the MODEL
deciding what in its own history it no longer needs. [`TOOL_TOKENS.md`](TOOL_TOKENS.md) is the pointer mechanism, and
[`POINTER_VALUES.md`](POINTER_VALUES.md) is what a pointer holds.

## The idea

An agent's context is treated as append-only: every tool result stays in it, word for word, until the session ends or
the harness summarises it away. Pointers make a different arrangement cheap. Every tool output already has an address
(`@tool:<id>:out`), is kept outside the context, and can be read back (`dereference`). So an old output can be REPLACED
in the history by a short stub naming its address, and nothing is lost, because the model can expand it again.

What the harness cannot know, and the model can, is which outputs are stale. Three failed builds and their 500-line
logs, the first draft of a table survey, a page read before the page changed: the model has moved on from them. So give
the model the operation:

```
collapse(
  ["@tool:1a2b3c4:out", "@tool:5d6e7f8:out", "@tool:9a0b1c2:out"],
  strategy: "head 10",                    // how much of each stays visible
  reason: "superseded by the passing build at @tool:3c4d5e6"
)
```

Each collapsed result in the history becomes something like:

```
[@tool:1a2b3c4:out collapsed: text, 1,420 lines. Kept: head 10. Reason: superseded by the passing build at @tool:3c4d5e6]
<the first 10 lines>
```

and `dereference` (or an `expand`) brings any of it back, whole or as a slice.

It is one operation that falls out of pointers being addressable. The others that fall out the same way are listed in
[What else composes](#what-else-composes).

## Pointers are objects, not text files

What makes the idea stronger than text compaction is what a pointer holds. A pointer does not name a string. It names
the TYPED value a step produced, and the model can compute over that value without reading it into context:

- A fetched Parquet, Arrow or CSV file is held as a table (`TableLike`, with the `Table` facade in JavaScript), not as
  its text. Past the preview, the whole table sits in the value store (POINTER_VALUES slices 4 to 6, built).
- `dereference` with the pipe dialect (`PIPE_CMDS`: `grep`, `head`, `keys`, `schema`, `type`, …) is already a set of
  projections over a pointer's value.
- The read-only `exec` dialect reads `@tool:"label".table` as an object; `python_exec` opens a table pointer as a
  DataFrame (slice 5) and a DataFrame it returns becomes a new table pointer (slice 6). A derivation is a new pointer,
  and the source is never copied through the context.

So the model's context holds descriptors (type, shape, schema, a small projection), and the payloads live in the
runtime, which the model reaches through JavaScript and Python. `collapse` is then a statement about which PROJECTION of
each value the context should hold from here on, and the projection language already exists.

## Shape (a sketch, unvalidated)

- **What can be collapsed.** Tool results only. Never a user message, the system prompt, an approval decision or the
  model's own reasoning. A collapse names pointers, so anything without one is out of reach by construction.
- **The strategy is the existing projection language.** A pipe expression (`head 10`, `grep -i error`, `keys`, `schema`)
  or nothing at all (the stub alone). Inventing a second projection syntax would split the dialect `PIPE_CMDS` is the one
  source for.
- **Expanding** is `dereference` as it is today. Whether a separate `expand` is worth adding, one that also restores
  the result in place, is an open question below.
- **The log keeps both.** The raw-view rule (AGENTS.md) says the log and the exports carry what the model saw. From the
  collapse on, the model saw the stub, so the step shows the stub and keeps the original reachable. The collapse itself
  is an event in the session (the lane, `session.events`), with its reason.
- **It is not a way to hide anything from the human.** The originals stay in the log and the exports; only the model's
  next prompt changes.

## Costs to be honest about

- **The prefix cache.** Rewriting a message in the middle of the history invalidates the server's cached prefix from
  that point, so the next turn pays a prefill over everything after it. A collapse that saves 20k tokens of context
  but forces a 60k-token prefill can be a loss on a local model. Ways around it: batch collapses, apply them only at
  turn boundaries, or append a "collapsed" notice and physically drop the text only when the prefix is being rebuilt
  anyway. The resource panel and the request hints can measure which is right.
- **Regret.** A model that collapses something and then expands it the next turn paid twice. The count of expands of
  collapsed pointers is the number that says whether the model is any good at this.
- **Instruction cost.** The operation needs a prompt clause and a tool schema in every request. It has to save more than
  it costs on a typical session, not only on the long ones.

## What else composes

The same addressability gives more than one operation. Listed so they are not re-derived later, not proposed:

- **Harness-driven compaction** (`COMPACTION.md`) can use the same stub format, choosing by age and size instead of by
  the model's judgement. Agent-driven and harness-driven are one mechanism with two triggers.
- **Scoped reads**: `@tool:<id>:in:<line>` (parked) addresses part of a value; a collapsed log expanded by line range is
  the same address.
- **Replay and branching**: when every derivation is a pointer computed from pointers, a run is a graph of typed
  transformations, and a subtree can be re-run or branched without redoing the steps before it.
- **Subagents**: a subagent's result handed back as a pointer to its output, not its transcript
  ([`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md)).

## Benchmarking it

Worth doing properly before building much, because the claims are easy to make and nobody seems to have measured them.
The bench (`tests/e2e/bench/`) already runs a matrix of cells with spread across seeds, and the pointer A/B pilot is the
precedent (`docs/POINTER-IDENTIFIERS.md`).

The order matters, because each step can end the idea more cheaply than the one after it.

1. **Measure the ceiling, with nothing built.** Take real `run.json` exports and, for each tool output, find the last
   turn anything used it: a `dereference` of its pointer, a citation in an answer, a later tool call's arguments naming
   it or quoting it. Count the tokens that sit in the context after that point, turn by turn, in every request that
   re-sent them. That is the most any compaction policy could remove, since a perfect one drops each output the moment
   it stops mattering. If it is a small share of prompt tokens on real sessions, the idea stops here. It also needs a
   known limit to be honest: an output the model read but never quoted still shaped what it did, so "never used again"
   is an upper bound on what is safe to drop, not a measurement of it.
2. **Try a mechanical rule** before any model judgement: an output is stale when a later call of the same tool with the
   same arguments superseded it (the build re-run, the URL re-fetched), or when nothing used it for N turns. No prompt
   clause, no tool schema. Measure what it removes against the ceiling, and what it costs in reprocessing, since the
   server reports prefill time and cache misses.
3. **Then the model-driven `collapse`**, scored against the rule from step 2, not against doing nothing. It earns its
   prompt cost only by beating the rule.

For steps 2 and 3:

- **Arms:** no compaction; the mechanical rule; agent `collapse`; both.
- **Tasks:** long-horizon ones that produce stale output as a matter of course: a fix-build-retest loop, a table
  survey that refines its query several times, a multi-page read.
- **Measures:** prompt tokens per turn and in total; prefill time and cache misses; task success; collapses made;
  expands of collapsed pointers (regret, the headline number for step 3); whether answers still cite the right pointers.
- **The collapse log is training data either way.** Each collapse with its reason, and each expand that followed, labels
  what turned out to matter; an expand right after a collapse is a clean negative. That is the route to the "post-training"
  column in the README if prompting alone does not get there.
- **Questions behind the measures:** does a context of descriptors keep a model on task over a longer horizon than a
  context of raw output? Does a type signature (a table's schema and shape) steer the code a model writes better than
  pasted rows? Can an off-the-shelf instruction-tuned model manage its own context usefully, or does this need
  post-training, as the pointer row in the README expects?

## Open questions

- Rewrite in place, or append a notice and drop text only when the prefix is rebuilt anyway?
- A separate `expand`, or `dereference` only? Does an expand restore the result into the history, or add a new result?
- Can a collapse be undone, and does undoing it cost another prefill?
- Should the harness suggest candidates ("these five outputs are 70% of your context") rather than leave it to the model?
- For the ceiling in step 1: which uses count? A quoted value is easy to find; an output that only informed a decision
  leaves no trace in the transcript.
- How does a collapsed step look in the sidebar, and in `run.md`, so the reader sees both what the model saw and what
  was there?
- Does a collapse belong to the session (surviving resume) or to the turn?
