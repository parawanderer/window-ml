# Reviewing the prompt: what the model reads, and how to change it

Every model call carries the system prompt (`src/agent/prompts.ts`), every tool's schema, and whatever the contract's
JSDoc puts into `agent_api_docs`. That text drifts as the agent loop grows: a clause added for one bug repeats a
sentence elsewhere, a rule written for one surface contradicts another, an option's description grows a manual. This
file is the method for reviewing it, the strategies that have worked, and when it was last done. The record of what
each review cut and measured is [`../spec/PROMPT_BUDGET.md`](../spec/PROMPT_BUDGET.md).

## When

After a stretch of work on the agent loop, a tool, `ml.current` or `agent_api_docs`, and at least once a month. The
date and PR of the last review are in AGENTS.md ("Prompt review"); a review commit carries the trailer
`Prompt-Review: <date>`, so `git log --grep='^Prompt-Review:'` lists every one. Update both when a review lands.
`scripts/check-prompt-review.mjs` reminds (pre-commit, on a commit that changes model-facing text, and in CI) once the
last review is more than 30 days or 25 such commits old. It never fails anything.

## The method

1. **Inventory what a call carries.** Build a run's system prompt and toolset and count characters per clause and per
   tool. The big items and the ones nobody remembers adding are where to look; a review that starts from a guess
   trims the clause someone already argued about.
2. **Ask models to read it.** Put the prompt (or one tool) to several models at once with the `panel` skill and ask
   where it contradicts itself, repeats itself, or leaves them unsure what to do. Interviews are code
   (`tests/e2e/panel/*.interview.ts`): a question can carry an `expect` that grades the answer, and `followUps` ask
   again when it is wrong ("quote the text you based that on"). VERIFY every claim against the code before acting on
   it: models report duplicates that are deliberate and miss real ones.
3. **Sort the findings by what they need.**
   - Duplicates and contradictions: fix directly, no measurement.
   - Text repeated across schemas: say it once in the prompt, one line per schema.
   - Moving text out of every call, or rewording a rule: a bet that the model still finds it, so it is MEASURED.
4. **Measure with the bench.** A build variant (`--define __ML_PROMPT_VARIANT__="<name>"`, read in one place) and a
   sweep spec whose tasks each NEED the text being moved, scored from the run itself (its answer and its steps), never
   from what the model says it did. The panel models are a `model` dimension; 3 repeats across all of them first, then
   8 on any cell that looks different. The decision rule: no model's pass rate drops, and a secondary measure (tokens
   per call, re-emission, steps) says what it cost. Give every sweep its own name: re-running one under an old name
   replaces its cells. Announce a sweep that uses local models to whoever else runs the box.
5. **Debrief the failures.** Run with `--hold failures`, then ask each failed run why
   (`node tests/e2e/converse.mjs --attach <cell> "<question>"`). The model's stated reason is evidence to check, not a
   verdict, but six models naming the same sentence is a finding. A failure that shows up in BOTH arms is a bug in the
   text, not the variant's cost: fix it in both, re-measure, and only then compare the variant (the navigation fix
   in #544 moved the baseline from 8/24 to 17/24 before the split's own numbers meant anything).
6. **Ship and clean up.** The winning text becomes the default; the variant define and the sweep spec are deleted (the
   branch keeps them); the result, with numbers per model and what was not covered, goes in `PROMPT_BUDGET.md`.

## Strategies that have worked

Not a checklist: new ideas are welcome, and each still goes through step 4.

- **Triggers stay, mechanics move.** A model that does not know an option exists never looks it up, so the schema keeps
  WHEN to reach for it; HOW it behaves once used goes to `agent_api_docs({ tool })` (`tool-details.ts`, #544).
  -16% per call, no model worse (#544).
- **Say it once.** A rule repeated in the prompt and three schemas costs four times and drifts four ways. One
  statement, one line pointing at it.
- **A computed value instead of prose.** Where the prompt explains a rule the code applies, hand the model the rule's
  answer for this run (`ml.current.env` is `routeExec` run over probes), so the text cannot drift from the behaviour.
- **Name the user's words in an exception.** "Navigate by default" beat "unless the user does not want to see your
  work" until the exception quoted what users say: "don't change my page" means fetch.
- **State the consequence, not only the rule.** "Navigating REPLACES the page the user is looking at" let models
  reason about the case the rule did not list.
- **Examples cost more than grammar.** Keep the grammar; move worked examples to the docs.
- **Watch for a rule that pulls the other way.** A default ("assume they want to see it") outweighs a later, vaguer
  exception; read the two together.
- **Terse.** Match the density of the clauses around it; never pad for alignment (the model pays for every space,
  `tests/token-pipe.test.mjs`).
- **One sentence can fix a regression.** When a cut loses on one model, read what that model did instead before
  reverting: the tool-output cut lost on DeepSeek V4 Pro until one sentence named the behaviour it slid into.

## Traps

- **Self-report is not a score.** "I used fetch_url" from a run that navigated is a navigation.
- **A small effect needs repeats.** 1 of 3 against 2 of 3 is noise; re-run the cell at 8 before believing it.
- **The shared prefix is cached.** The box caches a request's stable prefix (LiteLLM for Claude): text that changes per
  call placed early in the prompt costs every call after it in cache misses.
- **No provider branches.** A provider's caching or parameters are set on the box, never in the prompt or `sw-llm.ts`.
