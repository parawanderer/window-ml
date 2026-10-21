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
  Anthropic models: opus S4 does not parse, and opus F2 and F3 and sonnet F3 hold a regex the realm refuses by its
  SHAPE (`riskyRegex`, `limits.ts`: a repeated group holding a quantifier or `|`). Corrected after the first write-up,
  which said they could backtrack without end: none of the three does. On 100,000-character inputs built to make each
  backtrack they ran in 0.9, 3.4 and 3.5 ms, where `^(a+)+$` takes 88 s on 29 characters. In each, the alternatives
  inside the repeated group cannot both match at one place (every repetition of `(-[a-z0-9]+)*` and `(-[a-z]+)*` opens
  with a `-` the body cannot match; `(\.|%2e){2}`'s two alternatives share no first character), so a string matches in
  one way only. They are false positives of a check that is conservative by design. Why the models wrote them: opus's
  F2 also refuses a `..`, `%2e%2e`, `%2f` or backslash in the path, a path-traversal guard (probably redundant once the
  URL is parsed, which resolves dot segments); the F3 regexes write out the grammar of a Wikipedia language subdomain
  (`zh-min-nan`), where `endsWith(".wikipedia.org")` was what the need asked. `riskyRegex` is not widened to accept such
  a group; `propose_policy`'s details now steer a model to the string methods instead (the rerun below).
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

## The null rule, rescored (2026-10-21)

After the first run the realm was given a rule: a fact that is `null` is unknown, and an ALLOW whose evaluation read
one never fires (POLICIES.md, the tree's ruling; docs/dev/policies.md, "A null fact is unknown"). The `sh` answers above,
rescored under it with nothing rerun: gemma4:31b's and qwen3.8:27b's S3 are now right (the fail-open asks), and opus's S2
and sonnet's S1 now ask where they were right, since each adds `c.repoConfigRunsCode !== true` to a call outside any
repository, where the host sent `null`. Net: 27 right of 53, unchanged, and no fail-open left. SHELL.md's optional-fact
rule now sends `false` when no repository encloses the call, which gives the two back once the host does it.
The host does it as of window-ml-host #23 (fb436349), and the scorer's calls outside a repository now carry `false`: rescored with nothing rerun, opus's S2 and sonnet's S1 are right again, 29 right of 53 (`sh` right among lifted 16/24, among those that stayed code 13/29), still no fail-open. The interview's fact table says the same from here on (`false` when there is no repository, `null` only when the host could not tell); no sweep has read that wording yet.

## With `propose_policy`'s details (2026-10-21)

The `fetch` interview then read `propose_policy`'s details too (`TOOL_DETAILS.propose_policy`, the text
`agent_api_docs` serves): one arrow, exact fields over a regex, a prefix ending in `/`, the shapes the realm refuses. 14
models, the same as above without gemma4:12b (its cell is the first run's, 0 extracted). One run per cell.

| `fetch` | lifted / extracted | excluding format failures | right among lifted | right, all extracted |
| --- | --- | --- | --- | --- |
| no details (the Result above) | 33 / 52 (63%) | 33 / 40 (83%) | 32 / 33 | 36 / 52 |
| details, first text (withdrawn) | 46 / 52 (88%) | 46 / 48 (96%) | 42 / 46 | 42 / 52 |
| **details, as shipped** | **41 / 49 (84%)** | **41 / 45 (91%)** | **41 / 41** | **43 / 49** |

- The first text's examples were F1's host (`docs.python.org`) and F2's prefix (`raw.githubusercontent.com/acme/`),
  and its subdomain example was `c.host.endsWith(".python.org")` without the bare host. Models copied it:
  glm-4.7-flash, qwen3.5:9b and nemotron wrote F4 as `endsWith(".pastebin.com")` alone and miss `pastebin.com` (asks),
  and nemotron wrote F1 as `endsWith(".python.org")`, which allows wiki.python.org (a fail-open). Its row measures
  copying, so it is not the after. The shipped text uses `example.org`, which no need touches, gives the whole idiom
  (`c.host === "example.org" || c.host.endsWith(".example.org")`), and a test holds it to both.
- Every lifted answer is right under the shipped text. The Anthropic models' refused regexes are gone: opus and sonnet
  lift and are right on 4 of 4, where opus lifted 2 and sonnet 3.
- What still stays code: glm-4.7-flash's four answers (an array of policies again; that format failure was gone in the
  first text's run, so it comes and goes between runs), nemotron's F3 and F4 (`.includes(…)` on the host, wrong on both:
  F3 matches `evilwikipedia.org`, a fail-open), qwen3.5:9b's F3 (`startsWith("https://")`) and qwen3.5:4b's one
  answer (a block body).
- One run per cell: 83% to 91% excluding format failures is a direction, not a size. The format failures move between
  runs by four answers at a time.

Spend: $0.23 per sweep, $0.46 for both (opus $0.08 and $0.09 of it); steps 1 and 2 priced with the snapshot each run
recorded later, as above. Wall meter: 15 Wh and 16 Wh.
