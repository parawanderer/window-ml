# Prompt budget: trimming the system prompt and tool schemas, and measuring it

Status: **steps 1 and 2 done (#448, #451); of step 3, the `ml.current` cut shipped unmeasured (#450) and `answer` left
the default kit (#464); the rest of step 3 needs the bench.** Started 2026-10-08, updated 2026-10-09.

Every model call carries the system prompt and every tool's schema. This is the plan for making that smaller
without making runs worse, and the record of what has been measured so far. It is here, not in `tmp/`, so whoever
picks the bench up next finds it.

## What a call carries now

| Run | System prompt | Tools | Measured on |
| --- | --- | --- | --- |
| Console run (`ml.agent` from a page) | 10,545 chars before #448, **8,548 after** | 16 | panel runs, `run.md` "System prompt (N chars)" |
| UI run (HUD, sidebar, chat page) | 13,518 chars before #448, **12,453 after** | 21 (adds `click`, `type`, `python_exec`, `chat_metadata`, `dereference`) | panel runs with `SURFACE=hud` |

Tool schemas are not in that count, and in a UI run they are the larger half. Step 2 took about 1.9k characters a
call out of them, and leaving `answer` out of the default kit (#464) about 2.3k more. Since #456 a console run has
`click` and `type` too, and `agent_api_docs` whenever it has `exec`.

## How the problems were found: the model panel

`converse` (`.claude/skills/converse/SKILL.md`) runs a real model in the built extension and lets a session talk to it
turn by turn. The panel is the same interview run on several API models at once: do the fixture task, then review
your own system prompt (readable as `ml.current.messages[0].content`) and tools for bloat, quoting each part, and say
which half you would keep. What several models agree on is a candidate; every factual claim is checked against
`run.json` before anything changes (a model will state a wrong mechanism confidently).

- Models that work through OpenWebUI, multi-turn included: `deepseek.deepseek-v4-pro` (the most useful: measures
  and quotes), `deepseek.deepseek-flash`, `litellm.google/gemini-flash-latest`. `litellm.google/gemini-pro-latest`
  answered without reading anything, so it is weighted low. MiniMax had no balance on 2026-10-08.
- `SURFACE=hud` (#447) reviews the run a person starts; without it the panel reviews a console run, which has no
  `click`/`type`/`python_exec` and so finds "missing tools" that a UI run has.
- The transcripts are under `tests/e2e/artifacts/bloat*/` (gitignored, so they are not kept).
- Since #461/#462 the panel is a tool: `tests/e2e/panel.mjs` with an interview file (`tests/e2e/panel/*.json`), or
  the same file as a bench sweep (`.claude/skills/panel/SKILL.md`). OpenRouter models joined on 2026-10-09.

## The plan

### Step 1: duplicates and contradictions (#448)

Each rule said once, wherever it is needed when it is needed. Removed the wait, answer and read-only-exec
paragraphs that repeated their tools' descriptions (their unique lines moved into the tools), merged "sanity-check
the outcome" into method step 6, fixed four contradictions, and stopped naming tools a console run does not have.
No rule was dropped, so this needed the panel rerun and the unit tests, not a benchmark.

### Step 2: repeated schema text (done, #451)

The pipe dialect already went this way: it was spelled out in four `pipe` parameters (~800 tokens a run) and is now
said once in the prompt (`PIPE_CLAUSE`), each parameter pointing at it. Do the same for:

- `token`: one explanation in the tool-output-tokens clause, one line on each parameter.
- `verify`: one explanation, one line on each of `click`, `type`, `wait`, `navigate`, `locate`.
- `dereference`'s second copy of the pipe dialect and of the `:in`/`:out` grammar.

The clause and the tool must arrive together (detect from the schema, as `PIPE_CLAUSE` does), or a tool read cold
loses its meaning. Check with the panel and the unit tests, as step 1.

Done in #451: `token` and `verify` are one line on each parameter, pointing at the prompt; `dereference` points at
the pipe syntax (`PIPE_REF`) instead of repeating it.

### Step 3: moving reference text out of every call (needs measurement)

These change what the model knows without asking, so each is a bet that it looks the thing up when it needs it:

| Cut | Where its text goes instead |
| --- | --- |
| `ml.current` clause (~1,400 chars) down to one sentence | the signature into `agent_api_docs` |
| Shadow DOM closed-root and iframe edge cases | the scanning tools' own descriptions, which already flag those roots |
| Pipe dialect worked examples | the dialect grammar stays; examples to `agent_api_docs` |
| `fetch_url`'s table details (pandas dtypes, `df.head()`) | the table result itself, which already prints them |
| `exec`'s description repeating `ml.fetch`, `ml.a11y`, `ml.state` | `agent_api_docs` |
| Tool-output-tokens clause (2,669 chars in a UI run) | shorter clause; the citation grammar to `dereference` |

**The `ml.current` one shipped without the bench (#450)**, on the owner's call: when `agent_api_docs` is in the
toolset, which it is whenever `exec` is (#456), the clause is one sentence and the signature is in the docs; the long
form stays only for a run without them. The panel's cost: the shared-watch question is still answered in one call, the
self-count question now takes 6 to 9 calls instead of 1 (the model looks the shape up first). Its bench task below
still decides whether a middle form is worth it.

## Measuring step 3

**Each cut is a build-time variant**, an esbuild `--define` (the bench's `CellEffects.defines`), as the pointer-ID
experiment did with `__ML_TOKEN_FORMAT__`. A cut that loses adds nothing to the product; a cut that wins becomes the
default and its define is deleted.

**Tasks**, each needing what one cut removes, on the fixture site, each with a `succeeded` predicate read from the
run's own artifact, never from what the model says it did (the pointer pilot scored wrong that way):

| Task | Guards the cut | Passes when |
| --- | --- | --- |
| click a control inside a closed shadow root | shadow edge cases | the fixture records the click |
| read a value from a same-origin iframe | iframe text | the answer holds the value |
| filter a long text with a pipe | pipe examples | the answer holds the line, under N input tokens |
| total a column of a large CSV | `fetch_url` table details | the total is exact |
| "how many messages and tokens are in your context?" | `ml.current` clause | one call, numbers match `run.json`, says "estimated" |
| answer from a shared watch with a note | `ml.current` clause | the note's question is answered |
| fetch for yourself vs show the user a page | `fetch_url` note | navigates when the task says "show me" |
| cite a captured output instead of retyping it | tool-output-tokens clause | re-emission 0 (the pointer A/B metric) |

**Dimensions**: variant (current vs one cut) × model (the panel models) × repeats (3). Report pass rate, calls per
task and input tokens per call, with spread. **Decision rule**: a cut ships when pass rate does not drop on any model
and tokens per call fall; a cut that costs one model a task it used to pass is reworked, not shipped.

## Where the bench was left (check before step 3)

From the memories and git, as of 2026-10-08:

- **Built and merged**: `tests/e2e/bench/` (typed specs, seeded histories, build-time variants, self-calibration,
  the live `--serve` page). Skill: `.claude/skills/bench/SKILL.md`; worked examples in `tests/e2e/bench/specs/`.
- **The pointer-ID experiment** (`specs/pointer-ids.bench.ts`): its pilot found three bugs in the bench, all fixed;
  the real GPU run was never done.
- **Done (2026-10-09)**: the bench draws its runs with the resource panel's event lane: a Timeline section on each
  run's page and a sweep timeline (every run on one clock) on the `--serve` page, both from `eventsFrom` and the
  panel's own `LaneBars`.
- **Gaps for this plan**:
  - ~~a cell cannot set `surface` yet~~: done, `surface` on a task or on `CellEffects` (2026-10-09);
  - `backend` is per cell already, so the panel models are a `model` dimension;
  - none of the step 3 tasks exist yet, and the closed-shadow-root and iframe fixtures may need pages on the
    fixture site.

## Open

- Whether the `title` instruction stays in the prompt. Two reviewers called it duplicated; its comment in
  `prompts.ts` says it is said once there so each schema can carry one line, which is the step 2 pattern already.
