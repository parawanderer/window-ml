---
name: panel
description: Put one interview to several real models at once (DeepSeek, Gemini, Claude, GPT, Kimi, GLM…) and read where they agree, to judge an API, prompt or tool change by how models in general read it. Use after changing anything a model reads (the system prompt, a tool description, `ml.current`, agent_api_docs), or to find what is confusing before deciding what to change.
---

# panel — several models, one interview

The wrapper exists for models in general, not for any one model. A model reads only the text we wrote, so each
misreading points at a sentence; one model's misreading can be that model, three models' is the text.

```bash
USE_ENV=1 node --import tsx tests/e2e/panel.mjs tests/e2e/panel/bloat.json \
    --models deepseek.deepseek-v4-pro,deepseek.deepseek-flash,litellm.google/gemini-flash-latest,litellm.anthropic/claude-opus-5-5,moonshot.kimi-k3
# → tests/e2e/artifacts/panel-bloat-<time>/summary.md, plus each model's session in its own directory
```

Each model's directory holds `run.md`, `run.json`, `outbox/turn-<n>.md` (one per turn, the answer then each step) and
`run.log`. A PERSON reading a panel wants the bench's page instead: the same file through `bench/run.mjs` with
`--models … --serve` sets the answers side by side in a browser and lets them mark a wrong line, which every later run
of that model is checked against (`bench` skill, "Interviews"). A MODEL gets the same from the bench without the page:
`summary.md`, `timeline.md` and `page.json` in the sweep directory, and `node tests/e2e/bench/mark.mjs <sweep dir>
--model <who> --turn <n> --quote "<line>"` to mark an answer wrong (the bench skill's "What it writes" table).

Run it in the BACKGROUND (a few minutes; the models run in parallel). Options: `--out <dir>`, `--surface hud|console`,
`--turn-minutes N`, or `PANEL_MODELS=a,b,c` instead of `--models`.

## An interview file

`tests/e2e/panel/<name>.json`: `{ about, task, asks?, surface?, sharedWatches?, watchNotes? }`. `task` is the first
message, each of `asks` a follow-up sent once the turn before it ends. Keep a TASK first even when the point is a
review: a model that has used the tools reviews them from experience instead of from the schema. The files so far:

| File | What it asks |
| --- | --- |
| `bloat.json` | a page task, then a review of its own system prompt and tools for bloat, duplication, contradictions and gaps (`surface: hud`, the run a person starts) |
| `ml-current.json` | a self-count through `ml.current`, then the shared watches and notes, then a critical review |


### As code: checks on the answers, and follow-ups an answer calls for

`tests/e2e/panel/<name>.interview.ts` (or anywhere) is the same interview as code, and runs wherever a JSON one does
(`panel.mjs`, `bench/run.mjs --models …`). Its default export is `defineInterview` from `tests/e2e/bench/spec.ts`:

```ts
import { defineInterview } from "../bench/spec";
export default defineInterview({
    about: "…", surface: "hud",
    task: { ask: "Find the code on this page.", expect: (t) => t.tools.includes("findByText"), why: "it searched the page" },
    asks: ["Which tool did you use?", { ask: "What did it cost?", expect: (t) => /\d/.test(t.answer), why: "gives a number" }],
    followUps: [{ after: 2, when: (t) => !/exec/.test(t.answer), ask: (t) => `You said "${t.answer}". Why not exec?` }],
});
```

- `expect(turn, run)` checks one answer: `turn` is `{ n, ask, answer, answered, tools, capped, steps }` (steps with their
  arguments and results), `run` is `{ model, turns }` so far. The result is in `turns.json`, the cell's `turns`
  (`expect`) and `expects` (`{ passed, total }`), `rows.json`, `summary.md` (an "as expected" column and a line under
  each checked answer) and a badge on the page; a check that throws counts as not expected. So a before/after of a
  change is a diff of two sweeps' `rows.json`.
- `followUps` are asked only when `when(turn, run)` holds for the fixed turn `after` (absent: any fixed turn), each at
  most once. Models get different ones, so they are never a row of the side-by-side: they sit under the answer they
  followed (page, `summary.md`), and the interview's own turns keep their numbers (`turns.json` maps them).
- A `.bench.ts` task takes the same `expect`/`why` (for its first turn), ask objects and `followUps`.

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
`runOnce`, and an interview file runs as a bench sweep too (`interview.mjs` is the part they share).

## Which models work (2026-10-09)

Through OpenWebUI, tool calls and multi-turn included: `deepseek.deepseek-v4-pro`, `deepseek.deepseek-flash`,
`litellm.google/gemini-flash-latest`, `litellm.google/gemini-pro-latest` (weak reviewer); Claude as
`litellm.anthropic/claude-sonnet-5-5`, `-opus-5-5` and `-haiku-5-5` (Shane's own Anthropic key on the native API, so
prompt-cached; not the `openrouter.anthropic/*` ids, which cost several times more, and not the unprefixed `claude-*`
ids, whose OpenAI-compatibility route does no caching); on OpenRouter `openrouter.openai/gpt-6-luna`,
`openrouter.z-ai/glm-5.3-flash` and `openrouter.minimax/minimax-m3`; and Moonshot's own `moonshot.kimi-k3` (also
`moonshot.kimi-k2.6`). Local Ollama models work when the GPU is free; ask first. The probe is the source of truth: run it rather than trusting this list.
