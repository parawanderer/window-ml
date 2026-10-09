---
name: panel
description: Put one interview to several real models at once (DeepSeek, Gemini, Claude, GPT, Kimi, GLM…) and read where they agree, to judge an API, prompt or tool change by how models in general read it. Use after changing anything a model reads (the system prompt, a tool description, `ml.current`, agent_api_docs), or to find what is confusing before deciding what to change.
---

# panel — several models, one interview

The wrapper exists for models in general, not for any one model. A model reads only the text we wrote, so each
misreading points at a sentence; one model's misreading can be that model, three models' is the text.

```bash
USE_ENV=1 node --import tsx tests/e2e/panel.mjs tests/e2e/panel/bloat.json \
    --models deepseek.deepseek-v4-pro,deepseek.deepseek-flash,litellm.google/gemini-flash-latest,openrouter.anthropic/claude-opus-5.5,openrouter.moonshotai/kimi-k3
# → tests/e2e/artifacts/panel-bloat-<time>/summary.md, plus each model's converse session in its own directory
```

Run it in the BACKGROUND (a few minutes; the models run in parallel). Options: `--out <dir>`, `--surface hud|console`,
`--turn-minutes N`, or `PANEL_MODELS=a,b,c` instead of `--models`.

## An interview file

`tests/e2e/panel/<name>.json`: `{ about, task, asks?, surface?, sharedWatches?, watchNotes? }`. `task` is the first
message, each of `asks` a follow-up sent once the turn before it ends. Keep a TASK first even when the point is a
review: a model that has used the tools reviews them from experience instead of from the schema. The two so far:

| File | What it asks |
| --- | --- |
| `bloat.json` | a page task, then a review of its own system prompt and tools for bloat, duplication, contradictions and gaps (`surface: hud`, the run a person starts) |
| `ml-current.json` | a self-count through `ml.current`, then the shared watches and notes, then a critical review |

## Before trusting it

- **Every model is probed with one tool call first**, and one that cannot make it is listed as skipped with the
  backend's answer. A connection that looks fine in the model list can still 404 (an OpenRouter base URL that ended
  in `/chat/completions` did, 2026-10-09).
- **`surface`**: without it the run is a CONSOLE run (`ml.agent` from the page, a smaller toolset). `hud` is what a
  person gets. Say which one a review saw.
- **The cost is real API traffic.** A panel of five on `bloat.json` is roughly half a million input tokens.

## Reading the result

- **Tally agreement, not opinions.** A cut named by most models is a candidate; one model's favourite is a note.
- **Watch behaviour as well as answers.** Calls per turn, a turn stopped at the step cap, a tool error the model
  fought: those are findings the model did not report (three of eight lost a review to `ml.current` in an approved
  exec on 2026-10-09). `summary.md` shows calls and caps; each session's `run.md` shows why.
- **Check every factual claim against the session's `run.json`** before acting on it. Models state wrong mechanisms
  confidently (a snapshot "excludes the current call"; it did not).
- **Weigh the reviewer.** Some read and quote (DeepSeek V4 Pro, Claude Opus); some answer without reading anything
  (Gemini Pro did). A review with no quotes and no reads counts for little.
- **After a change, rerun the same file on the same models** and compare calls per turn and whether the right thing
  now happens unprompted. That before and after is what goes in the PR.

## Panel or bench?

Related, not the same. The **bench** (`bench` skill) asks "is B better than A?": the model is the SUBJECT, scored by a
predicate over the run, repeated for spread. The **panel** asks "what in this is confusing, and why?": the model is a
READER and reviewer, asked once each, across many models for breadth. A panel turns up a hypothesis ("`tokens` reads
as exact"); when the fix is a choice between versions that needs numbers, that is a bench spec. Both drive
`runOnce`, through `converse` here.

## Which models work (2026-10-09)

Through OpenWebUI, tool calls and multi-turn included: `deepseek.deepseek-v4-pro`, `deepseek.deepseek-flash`,
`litellm.google/gemini-flash-latest`, `litellm.google/gemini-pro-latest` (weak reviewer), and on OpenRouter
`openrouter.anthropic/claude-opus-5.5`, `openrouter.anthropic/claude-sonnet-5.5`, `openrouter.openai/gpt-6-luna`,
`openrouter.moonshotai/kimi-k3`, `openrouter.z-ai/glm-5.3-flash`. MiniMax had no balance. Local Ollama models work
when the GPU is free; ask first. The probe is the source of truth: run it rather than trusting this list.
