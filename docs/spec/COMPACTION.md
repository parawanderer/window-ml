# Open topic: compaction of long sessions

**Status: open, not started** (noted 2026-09-15). Nothing here is decided.

## The problem

A session can outgrow the model's context: a long discussion on the chat page ([`CHAT_PAGE.md`](CHAT_PAGE.md)), a
saved agent session resumed days later, a long agent run. Today nothing handles it. The loop reports the context
window to the model (`agent-loop.ts`, the orientation lines) but never trims, so what happens at the limit is up to
the backend. What Ollama does with a prompt longer than `num_ctx` should be checked before anything is built on an
assumption about it.

## What this repo already has that changes the shape of it

- **Pointers.** A tool output is referred to by `@tool:<id>` and can be read back with `dereference`, so an old
  tool result can be replaced by its pointer and a one-line gloss without losing it: the model can still get it
  back. That makes compacting tool outputs close to lossless, which a summary of the conversation is not.
- **The raw-view rule** (AGENTS.md): the log and the exports always carry what the model actually saw. A compacted
  step has to show the compacted form the model got, with the original still reachable.
- **The server's prefix cache.** Rewriting early messages invalidates the cached prefix, so the next turn pays a
  full prefill. Compaction has a cost the request hints and the resource panel can measure.

## Open questions

- When: at a threshold of the context window, on resume, or only when asked?
- What goes first: old tool outputs (to pointers), then old turns (to a summary by the utility model)?
- Where it lives: the harness only, or the server too (which knows the real token counts and the cache)?
- How the lane and the log show it: a compaction is an event in the session, and should be visible as one.
