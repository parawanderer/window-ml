# policy-fetch, policy-sh: what fraction of model-written policies the tree covers

The measurement ruled in #924 (docs/spec/POLICIES.md, "The tree, ruled 2026-10-21";
[`LANE_11_POLICY_TREE_DESIGN.md`](../../../docs/plan/repl/LANE_11_POLICY_TREE_DESIGN.md)). The corpus figure, 36 of 39
consumer policies, counts only policies people and agents wrote into this repository. These two interviews ask models
for policies as TEXT, for described needs, and feed every answer through the lifter (`src/readonly-exec/policy-lift.ts`).
**The number is lifted / extracted**: of the answers that give a `(c) => …` block, the fraction the lifter turns into a
tree. Nothing else of the tree is built before it exists. `propose_policy` stays fetch-only; nothing a model writes here
reaches a store, and no tool is called.

- `policy-fetch.interview.ts`, `policy-sh.interview.ts`: four needs each, one per turn, with the facts the consumer
  gives (`policy-proposals.prompt.ts`).
- `policy-proposals.score.ts`: the needs and their hand-labelled calls (9 to 12 per need, built by the product's own
  `fetchFacts` and `shFacts`), and the scorer. A call is a vector only when the need's words settle its answer.
  `tests/policy-proposals.test.mjs` checks that a careful answer is right on every vector and lifts, and that the
  sloppy answers a model is likely to write are each caught by one.

Per answer: **extracted** (a fenced block holding an arrow), **lifted**, **right** (the source, run in the real policy
realm, gives the labelled answer on every vector), **broken** (the realm refused it on some vector: an absent field,
`==`, a non-boolean). Lifted and right are independent: a lifted policy can be wrong, and a right one can stay code.
The report's head also gives, per consumer, right among the lifted against right among those that stayed code: if the
fragment selects for correct policies the tree is worth more than its coverage says, and less if the opposite. A turn's
badge on the bench page is green when the answer is extracted; lifting is the measurement, never the model's failure.

A wrong answer lists each vector as "misses" (the policy does not hold where it must) or "matches" (it holds where it
must not), and what that does in the product depends on the effect. On an ALLOW, "matches" runs a call without asking:
the one fail-open, and the finding to lead with; "misses" only asks the person. On a DENY, "misses" asks the person
(fail-safe) and "matches" refuses a harmless call. "(no manifest)" in a vector's name marks a call no manifest describes
(`rm`, or a git subcommand git's manifest lacks), whose effects are `unknown`: only an answer naming the program in
`argv` gets it right.

| need | consumer | effect | what it asks |
| --- | --- | --- | --- |
| F1 | fetch | allow | docs.python.org, without credentials |
| F2 | fetch | allow | everything under `https://raw.githubusercontent.com/acme/` |
| F3 | fetch | allow | Wikipedia in every language |
| F4 | fetch | deny | pastebin.com and its subdomains |
| S1 | sh | allow | `npm test` exactly, anywhere inside the workspace |
| S2 | sh | allow | any call that only reads non-secret files in the workspace |
| S3 | sh | allow | read-only git, never where `repoConfigRunsCode` is not false |
| S4 | sh | deny | any call that deletes or renames |

Run (spend is Shane's decision; the run of 2026-10-21 is the Result below):

```
USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/panel/policy-fetch.interview.ts --models <a,b,…> --dry
USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/panel/policy-sh.interview.ts --models <a,b,…> --serve
node --import tsx tests/e2e/panel/policy-proposals.score.ts tests/e2e/artifacts/bench/<sweep>
```

## Prediction, written before the first run (2026-10-21, claude-opus-5-5)

- Extraction is near 100% for the cloud models and loses a few answers on the small local ones (prose, or a block with
  no arrow).
- **fetch lifts 80-95%.** The natural answers are `c.host === X`, `c.url.startsWith("…/acme/")` and
  `c.host.endsWith(".wikipedia.org")`, all in the fragment. The misses are a host regex with a character class
  (`/^[a-z-]+\.wikipedia\.org$/`) on F3 and a computed URL on F2.
- **sh lifts 55-75%**, well below fetch and below the corpus's 92%. The misses: `c.argv.slice(1).join(" ")` and
  `c.argv.includes(…)` on S1 and S3, a quantifier inside a quantifier or `.filter(…).length` on S2 and S4, and optional
  chaining.
- **Right is lower than lifted on both**, and the misses are on the facts a need names: F1 forgets `credentials`, F3's
  `endsWith("wikipedia.org")` admits `evilwikipedia.org` on the small models, S1 allows extra arguments, and S3's
  `!c.repoConfigRunsCode` admits `null` for most models. S4 splits: an argv answer (`rm`, `mv`) misses `find -delete`,
  and an effects answer misses `rm`, which has no manifest.
- Broken is rare: a field name that is not a fact (`c.hostname`, `c.path`) on the small models, never `==`.
- The spread between consumers is larger than the spread between models.

## Result (2026-10-21, 15 models, one run per cell)

Panel: the 14 bench models plus `litellm.anthropic/claude-sonnet-5-5`. **`claude-opus-5-5` wrote the needs, the
vectors and this prediction**, so its row is not an independent reading. Scored with `policy-proposals.score.ts` over
`panel-policy-fetch` and `panel-policy-sh`.

| | lifted / extracted | excluding format failures | right among lifted | right among code (all) | right among code (excl. format) |
| --- | --- | --- | --- | --- | --- |
| fetch | **33 / 52 (63%)** | 33 / 40 (83%) | 32 / 33 (97%) | 4 / 19 (21%) | 4 / 7 |
| sh | **24 / 53 (45%)** | 24 / 42 (57%) | 15 / 24 (63%) | 12 / 29 (41%) | 12 / 18 (67%) |

The defined number is the first column. A "format failure" is an answer that holds an arrow but is not one
`(c) => …`: glm-4.7-flash (an array of policies), nemotron-3-nano (`const allow_f1 = …`), qwen3.5:4b on fetch (a
wrapper taking no parameter), granite4.1:3b on sh. They are 23 of the 48 that stayed code, all on four small local
models; every cloud model extracted 4 of 4 on both consumers. qwen3.5:9b's four sh answers are block bodies
(`{ return …; }`), counted as code and not as format failures.

On fetch the fragment selects for correct policies (97% right when lifted, 4 of 7 when a well-formed answer stayed
code). On sh it does not: 63% against 67%.

Against the prediction:

- Extraction near 100% for cloud models: yes. The small local ones lost more than "a few": granite4.1:3b extracted 0
  of 4 on fetch, qwen3.5:4b 0 of 4 on sh.
- fetch 80-95%: 63% as defined, 83% only once format failures are excluded. The predicted F3 miss is the main one: a
  host regex with a character class stayed code for 4 models (opus, sonnet, gemini, gpt-6-luna), and gemma4:31b's F4
  likewise. No computed URL on F2; opus's F2 was a regex with flags.
- sh 55-75%: 45%, 57% excluding format failures. The predicted misses (`argv.slice(1).join`, `argv.includes`, nested
  quantifiers, `.filter().length`, optional chaining) did not occur. The actual ones: `argv.length` compared with a
  number on S3 (4 models), a const that is not a literal (3), a `startsWith("/w/proj")` prefix that does not end at a
  path component (gemma4 ×3), a block body (qwen3.5:9b ×4).
- Right lower than lifted: wrong on both. Right exceeds lifted, 36 against 33 on fetch and 27 against 24 on sh,
  because right answers that stay code outnumber lifted wrong ones.
- The predicted wrong facts mostly did not occur: no F1 answer forgot `credentials`, no F3 answer admitted
  `evilwikipedia.org`, no S1 answer allowed extra arguments. S3's `null` did occur, on 2 models (gemma4:31b,
  qwen3.8:27b), not most: **the one fail-open**, an ALLOW that matches `git status` where `repoConfigRunsCode` is null.
  S4 split one way only: 8 models wrote an effects answer and missed `rm`, `mv`, `git rm`, `git mv` (no manifest), which
  is fail-safe on a DENY (the person is asked). No argv answer missed `find -delete`. gemma4:31b's S4 refuses `npm test`.
- Broken is rare, from field names on small models: wrong. The broken answers outside format failures came from the
  Anthropic models: opus F2 and F3 and sonnet F3 are regexes the realm refuses as able to backtrack without end, and
  opus S4 does not parse.
- The spread between consumers is larger than the spread between models: wrong. Consumers differ by 18 points; models
  run from 0 to 100% lifted on both.

Failed and mixed runs:

- **gemma4:12b failed.** Its sh turn 2 never left the thought channel: a loop ran to the context limit (253,557
  tokens, about 38 minutes, no `num_predict` on the turn), and the runner's single slot queued its other requests behind
  it, so its fetch run extracted nothing. Its one sh answer (S1) is in the counts. Diagnosis from the mlbox agent
  (`reports/ui-api/gemma4-12b-hang-answer.md` there, commit e3e06a6); the 15-minute client timeout did not stop the
  generation upstream.
- The 13 other models ran the extension bundle built at 09:40, older than its source. gemini-flash failed every turn
  then with a 400 (#944: `locate`'s parameter named `description` was deleted while `required` still named it), and
  was rerun alone on a fresh build of main at 271466d3 with this branch. The bundle builds the tools; the interview's
  prompt and scoring do not come from it.

Spend, every call priced at the snapshot its run recorded:

| | all 15 | Opus | the rest | estimate, the rest |
| --- | --- | --- | --- | --- |
| fetch | $0.23 | $0.09 | $0.13 | $0.14 |
| sh | $0.35 | $0.14 | $0.22 | $0.14 |

Gemini's rerun is $0.03 (fetch) and $0.06 (sh) of that. Steps 1 and 2 of every cell were logged with no price snapshot:
the cell's fresh profile has none, and the worker's first refresh lands after step 2. They carry the longest prompts,
so the bench's own spend line read $0.04 and $0.11; the figures above price those calls with the snapshot the same run
recorded at step 3. The box's wall meter measured 24 Wh (fetch) and 67 Wh (sh).
