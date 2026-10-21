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

Run (spend is Shane's decision; nothing has run):

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
