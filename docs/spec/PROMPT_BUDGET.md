# Prompt budget: trimming the system prompt and tool schemas, and measuring it

Status: **steps 1 and 2 done (#448, #451); of step 3, the `ml.current` cut shipped unmeasured (#450), `answer` left
the default kit (#464), and the tool-output-tokens cut and the `exec`/`fetch_url` split shipped measured (below); the
shadow/iframe, pipe-example and `locate`/`python_exec` parameter cuts are still open.**
Started 2026-10-08, updated 2026-10-10.

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
| `fetch_url`'s table details (pandas dtypes, `df.head()`) | SHIPPED, measured: `agent_api_docs({ tool })` (below) |
| `exec`'s description repeating `ml.fetch`, `ml.a11y`, `ml.state` | SHIPPED, measured: `agent_api_docs({ tool })` (below) |
| Tool-output-tokens clause (2,669 chars in a UI run) | SHIPPED, measured: 3,738 → ~1,470 chars with `DEREF_CLAUSE` |

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

## Step 3 result, round 2: `locate`'s option texts (2026-10-10)

`locate` keeps its triggers in the schema and serves its full description and parameter texts from
`agent_api_docs({ tool: "locate" })` (`LOCATE` and `TOOL_DETAILS.locate` in `src/tools/tool-details.ts`): about 3,900
characters down to 1,460 on every call. The "Incognito is off" rendering error now leads with the retry that works
(`credentials:true`) and tells the user how to allow Incognito only as the alternative. Measured with a `cuts2` variant
that also cut `python_exec`'s `tables`/`cast`/`mode` texts; the variant and its spec are deleted (the branch
`backup/prompt-cuts-2` has them). The numbers, per model and task, are computed in
[`notebooks/bench/prompt-cuts2.ipynb`](../../notebooks/bench/prompt-cuts2.ipynb) from 520 pinned runs.

- **First sweep** (11 models x 4 tasks x 3): eight models unchanged, DeepSeek V4 Pro one better, and three models one
  or two worse (MiniMax M3, qwen3.6:35b, glm-4.7-flash). Prompt tokens per call fell about 6% with both cuts.
- **Recheck** (those three, x 8): qwen3.6 held (31/32 both). MiniMax fell 31 → 27: two failures were the `python_exec`
  cut (it wrote `tables=` inside its Python code; it answered a table task from a screenshot), the rest unrelated (a
  status line it never read, the step cap, a correct click made through `exec` that the task's check does not count).
- **One sentence fixed MiniMax** ("Pass it HERE, not in your code"): 32/32 on the table tasks under both prompts.
  glm-4.7-flash, re-run the same way, tied overall (9/16 both) but lost csv-total (8/16 → 4/16 across both runs): only
  under the cut did it fetch the CSV and then give up without calling `python_exec` (3 runs).
- **Shipped**: the `locate` cut and the error. **Not shipped**: the `python_exec` cut, so its texts are unchanged and
  the table tasks cannot have regressed. The `locate` cut held on icon-heart for qwen3.6 and glm-4.7-flash; MiniMax is
  7/8 → 6/8 there (one run, p = 0.5). The spa task never got worse.
- **Saving**: the `locate` cut is about 70% of what round 2 removed, so roughly 4% of prompt tokens per call. That is
  an estimate from the character counts; the sweeps measured both cuts together.
- **Not covered**: a canvas task (the bench has no grounding model, so `locate`'s canvas and `container` options were
  not exercised), and the remaining one-run icon-heart gap on MiniMax.

## Step 3 result: the `exec`/`fetch_url` split (2026-10-10)

`exec` and `fetch_url` keep their TRIGGERS in the schema (when to reach for an option) and serve their MECHANICS from
`agent_api_docs({ tool })`, or inline when the run has no docs tool (`src/tools/tool-details.ts`). Measured with a
`split` build variant and a sweep spec over five tasks (total a 3,000-row CSV, reveal a code inside nested shadow
roots, read a client-rendered page, show a page, look something up without moving the tab), both deleted once it won
(branch `feat/tool-details` has them).

- **Prompt tokens per call fell 16%**, 16,602 → 13,893 on average, and on every model: Claude Sonnet 5.5 10%, Gemini
  3.6 Flash 16%, GPT-6 Luna 16%, DeepSeek V4 Pro 15%, DeepSeek Flash 14%, Kimi K3 25%, GLM-5.3 Flash 20%, MiniMax M3
  16%, gemma4:31b 19%, qwen3.6:35b 13%, glm-4.7-flash 14%. Steps per run held or fell, except Kimi K3 (1.9 → 2.7),
  which looks the details up; it still pays less per run.
- **Pass rate held on all 11** (3 repeats, 15 runs a model): 160/165 split against 158/165 current. Ten models scored
  15/15 split; glm-4.7-flash scored 10/15 on both.
- **The first sweep found a bug in both texts**: told "without changing what I'm looking at", qwen3.6, glm-4.7-flash
  and MiniMax M3 navigated about two thirds of the time. Asked afterwards (held runs, `--hold failures`), all six
  said `fetch_url` was the right tool: they read "don't change" as "don't mutate", and `fetch_url`'s showing-vs-
  fetching note told them to navigate by default. The fix, in the shipped text: "don't change my page" means fetch,
  and `navigate`'s description says navigating replaces the page the user is looking at. On that task (8 repeats,
  three models) passes went from 8/24 to 17/24 (current) and 7/24 to 19/24 (split); asked to SHOW a page, they still
  navigated (47/48, the one miss an error).
- **Not covered**: glm-4.7-flash's remaining misses on the client-rendered page (5/16; most did not navigate, so
  likely a rendering miss, not read yet).

## Step 3 result: the tool-output-tokens cut (2026-10-09)

Measured as this doc prescribes, with `__ML_PROMPT_VARIANT__` builds and a sweep spec over the pointer A/B's two
tasks (`cite-or-retype`, `read-back`), both deleted once the cut won (git history has them, branch
`feat/prompt-variant-tooltokens`). The clause plus `DEREF_CLAUSE` went from 3,738 characters to about 1,470.

- **The first cut lost.** On DeepSeek V4 Pro, re-emission on `cite-or-retype` rose in all three sweeps, to 0.46
  ±0.28 against 0.17 ±0.20 at 8 repeats: the model wrote the rows out as a markdown table instead of embedding the
  pointer. Pass rate held, so the decision rule's other half was the one that caught it.
- **One sentence fixed it** ("Asked to show rows, a table or a value a tool returned, embed its pointer: never write
  it out again as a markdown table or a list"): 0.19 ±0.28 on V4 Pro, against 0.17 for the current text.
- **That version held on 12 models**, pass rate at or above the current text on every one: gemma4:31b, gemma4:26b,
  qwen3.5:9b (3 repeats); DeepSeek V4 Pro (8), DeepSeek Flash, Gemini Flash (5); Claude Sonnet 5.5, GPT-6 Luna,
  Kimi K3, GLM-5.3 Flash, Gemini 3.6 Flash, MiniMax M3 (3). Re-emission was equal or within one standard deviation
  everywhere; Kimi K3's rise (0.00 → 0.20) is numbers typed into its own exec code, and its answers embedded.
- **What the sweeps found on the way**, all fixed: a follow-up turn lost when turn 1 navigated (#483); the read-back
  seed typed its data as a literal and never forced a `dereference` (#487, which also fixed two exec-output bugs);
  OpenWebUI relays OpenRouter's rate limit as a 400, which the extension did not back off (#498).
- **Not covered**: streamed runs (the bench gained `stream` in #491 after these sweeps; wording should not depend on
  it), and repeats beyond 3 on most models. The decision rule was met; a small effect on one model would not show.

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
