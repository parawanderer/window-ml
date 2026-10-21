# Lane 11: the typed-node policy tree (design, 2026-10-21)

Lane 11's item 3 ([`LANE_11_HOST_AND_POLICY_TREE.md`](LANE_11_HOST_AND_POLICY_TREE.md)). A design note, no code until it
is ruled on. It answers [`POLICIES.md`](../../spec/POLICIES.md), "Showing what was approved": the analysable fragment
(boolean combinations of equality, prefix and membership atoms over the resolved facts and the effect set, finite
domains) made visible, so a proposed policy's card can lead with a DERIVED breadth. Code refs are window-ml at
`924ec1dc`.

## The measurement first

**What was measured.** Every policy source in the repository and in every local artifact: tests, fixtures, docs,
skills, built-ins, the e2e and bench artifacts under `tests/e2e/artifacts` (3.7 GB), `tmp/` run exports, every sibling
clone's gitignored output, and the session-mail notes. 231 distinct sources were found: 205 in tests, 22 in docs, 4
built-in. **None was written by a model or by a person using the product.** `propose_policy` is fetch-only and no bench
task asks a model for one, and nobody has set a policy outside a test. Bench results pushed to S3 were not searched;
the local bench ledger holds none. So the measurement below covers what this repository's authors wrote to exercise the
machinery, and it says nothing about what a model would propose. That is the main limit of this note.

**The denominator.** Of the 231, 115 are attacks (escapes, hangs, probe gaming) and 49 are expected to be refused
(typos, `==`, non-booleans). That leaves 60 distinct complete functional policies once ten extraction slips are
removed (policy ids recorded as sources, such as `h-deny`, whose real sources are already in the set). The corpus is
[`tests/fixtures/policy-corpus.json`](../../../tests/fixtures/policy-corpus.json), with the slips dropped; how to keep it
current is [`docs/dev/policies.md`](../../dev/policies.md), "The policy corpus". They split into
two groups, reported separately because they are different things:

- **38 policies over a real consumer** (`fetch` or `sh`), from the policy machinery's tests, the docs and the
  built-ins.
- **22 evaluator probes** (`tests/readonly-policy.test.mjs`) over a hybrid facts object. These test the policy realm's
  semantics (`argv[9]?.length`, `{ c = 1; return true; }`, `Math.pwned`), and nobody would set one as a policy.

| Group | Fits as written | Fits after a mechanical rewrite | Fits after a hand rewrite | Does not fit |
| --- | --- | --- | --- | --- |
| real consumer (38) | 32 | 3 | 1 | 2 |
| evaluator probes (22) | 10 | 4 | 0 | 8 |
| all (60) | 42 (70%) | 7 | 1 | 10 |

So the grammar covers **35 of 38 (92%)** of the real-consumer policies by machine (as written plus mechanical rewrite),
and 36 counting the hand rewrite. Over all 60 it covers 49 (82%). Each rewrite and each miss:

| Policy | Outcome | Why |
| --- | --- | --- |
| `c.effects.writes.every((r) => r.path.startsWith("/r/src/"))` | mechanical | a character prefix ending in `/` is `Under(path, /r/src)` exactly, on a `realpath`ed path |
| POLICIES.md's git example, `!c.argv.some((a) => /^--(output\|ext-diff\|exec\|upload-pack)/.test(a))` | mechanical | an anchored alternation of literals is membership of prefixes: `Not(Some(argv, StartsWith one of {…}))` |
| POLICIES.md's built-in, `c.effects.every(…)` | mechanical, after a doc fix | the effects view has no `every`, so as written it is BROKEN (a refusal); `pairs.every(…)` is what was meant and fits (fixed in this PR) |
| `["test", "run lint"].includes(c.argv.slice(1).join(" "))` | hand | exactly `(argc 2 and argv[1] is one of {test, "run lint"}) or (argc 3 and argv[1] is run and argv[2] is lint)`; correct, but no lifter would find it |
| `c.url.startsWith("http")` | no | a raw character prefix over a URL; the tree's URL atom is structured (below) and does not offer this one, which is the shape of the `https://a.example.evil` trap |
| `(c) => c.host === "b.test"` as an `sh` policy | no, correctly | `sh` facts have no `host`, so in code this policy is BROKEN on every call; the typed tree refuses to build it |
| probes: `argv[5] === undefined`; `pairs.length === 0`; anchored literal regex over the URL; a `const` helper inlined | mechanical | `ArgCount`; `Not(Some(pairs, true))`; `Under(url, …)`; inlining |
| probes: `argv[9]?.length`, `({...c}).argv0`, `c.url.length > 0 && c.url[0]`, `argv.length < 10 && "a" < "b"`, `c = 1`, `Math.pwned`, `c.paths[0].inRoot`, a `for…of` summing lengths | no | string length, spread, character index, order, assignment, globals, a positional index into `paths`, a loop with arithmetic |

**What the distribution says.** 21 of the 38 are one atom, `c.host === "<host>"`, because that is what the
proposal and lapsed-policy tests need, and the one generator that ships (`fetchUrlPolicySource`, the card's "Approve +
remember these URLs") emits `c.kind === "fetch" && c.url === <literal>`, which fits by construction. So the high figure
is partly an artifact of the corpus: tests write what is easy to assert. The five doc examples are the closest thing to
policies written to be used: four fit by machine (the built-in only after the doc fix), and the `npm` one by hand. Before the
tree becomes the default, the measurement should be redone on policies models actually propose (last section).

## The node grammar

A tree is typed by its consumer. A field's type decides which atoms it admits, so a node that reads a field the
consumer does not have cannot be built. The whole grammar:

```text
Policy  ::= { consumer: "fetch" | "sh", effect: "allow" | "deny", root: Node }
Node    ::= All(Node*) | Any(Node*) | Not(Node) | Atom             -- All() is true, Any() is false
Atom    ::= Is(F, k)            F scalar, k a constant of F's type, or "absent" when F is optional
          | OneOf(F, k1 … kn)    membership in a finite set of constants
          | Under(F, k)          prefix over F's own SEGMENTS (below), strict: k itself is not under k
          | StartsWith(F, k1 … kn)  character prefix, for an opaque string field only (an argv element)
          | ArgAt(i, Is | OneOf | StartsWith)   argv position i, false when argc ≤ i
          | ArgCount(OneOf n1 … nk)             argc in a finite set
          | Some(L, Node) | Every(L, Node)     over a list field L; the Node reads only the element's fields
          | Has(op, kind?) | Uses(name) | Unknown      the effect set's own queries
```

**Segments, not characters.** `Under` is a prefix over the parts of a value that carry meaning: a path's `/`
components (`Under(path, /r/src)` does not admit `/r/srcevil`), a host's labels from the right (`Under(host, shop.com)`
admits `a.shop.com`, not `evilshop.com`), and a URL's (scheme, host, port, path components), so `Under(url,
https://a.example/docs)` fixes the host. Character prefixes exist only for argv elements, which are opaque text
(`StartsWith(--output)` catches `--output=x`).

**Absent is a cell.** An optional fact (`topLevel` without roots, `containsSecret` when the host did not send it,
every resource field the resource's kind lacks) is three-valued: `Is(f, true)`, `Is(f, false)` and `Is(f, absent)` are
three atoms. The tree has no truthiness, so `!e.res.secret`, which is true for an absent `secret`, is written as
the atom that says which cells it means.

**What is left out on purpose.** Regexes, every string operation besides the three above, order (`<`), arithmetic,
indexes into lists other than argv, relations between two fields or two list elements, helpers, loops, and globals.
Each one is a sound addition only once its analysis is written. None goes in for convenience (the not-covered list).

## One source, two renderings

The TREE is what is stored. The sentence on the policy page and the predicate the judge runs are both rendered from it,
and neither is ever parsed back. The judge does not change: it runs the rendered predicate through the read-only
dialect, as it runs every policy. So there is still one evaluator, and the analyser reads the tree.

| Node | Sentence | Predicate |
| --- | --- | --- |
| `Is(host, "shop.com")` | the host is shop.com | `c.host === "shop.com"` |
| `Under(host, "shop.com")` | the host is a subdomain of shop.com | `c.host.endsWith(".shop.com")` |
| `Under(url, https://a.example/docs)` | the URL is under https://a.example/docs/ | `c.host === "a.example" && c.url.startsWith("https://a.example/docs/")` |
| `Every(paths, Is(inRoot, true))` | every path argument is inside a root (true when there are none) | `c.paths.every((p) => p.inRoot === true)` |
| `Not(Has("write"))` | it writes nothing | `!c.effects.has("write")` |
| `Is(cwd.topLevel, absent)` | no roots were given | a presence test (open point 2) |

Three rules hold the two renderings together:

- **Every renderer output is strict.** It uses `===` only and has no truthiness. It never reads an optional field
  without its presence test, so a tree's predicate cannot be BROKEN. That matters most for a `deny`: a broken deny is
  no opinion, which is the dangerous direction (POLICIES.md, the strict facade).
- **The empty list is said.** `Every` renders "(true when there are none)" in the sentence: the `[].every` trap
  POLICIES.md lists, made visible where the person reads it.
- **The renderers are tested against the analyser, by enumeration.** For every node kind, one representative fact
  per cell (below) is evaluated two ways: the rendered predicate in the real dialect, and the analyser's cell truth.
  The test asserts they agree (AGENTS.md: enumerate the inputs, do not sample them). This is the only place two
  semantics meet, and it is checked once per node kind rather than per policy.

**How a tree is made.** A person builds one in the editor, and the "make a rule from this" link fills one from the
call's facts. A model writes JS, as today, and a LIFTER, a syntactic recogniser over the dialect's AST, turns a source
that fits into a tree. The source then becomes the tree: what is stored and judged is the rendering, and the model's
own text stays only in the run log as what the model said. A source that does not lift stays code, and its breadth is
MEASURED. The model is not asked to emit tree JSON. POLICIES.md chose a JS subset because the model writes JS
fluently, and a JSON tree would be the bespoke language that argument rejected. The lifter's own test: for each corpus
policy it lifts, the original source and the rendering agree on every cell representative.

## Breadth, enumerated

**The cells.** The constants a tree mentions partition each field's domain into finitely many cells:

- `Is` and `OneOf` with constants k1…kn give the cells {k1}, …, {kn} and "anything else".
- `Under` gives one cell per node of the trie of its constants, plus "under none".
- A boolean field has two cells, and three when it is optional.
- An enum has its values (`placement`, `mode`, an effect's `op` and `kind`).
- `argc` has a cell per mentioned count and "any other".

The tree is constant on each combination of cells, so which calls it admits is a finite, exact question. A list
quantifier does not break this. The truth of a Boolean combination of `Every(L, φ)` and `Some(L, ψ)` depends only on
which element cells occur in the list, and it can be decided without enumerating lists: the conjunction holds iff
every `Some(ψ)` is satisfiable together with all the `Every(φ)`s on one element. The empty list satisfies every
`Every` and no `Some`.

**The questions the card asks**, each answered by "is the tree AND this condition satisfiable":

- which programs (`sh`): the cells of `argv[0]`'s basename, which is what selects the manifest
  (`program-manifest.ts`, `describeCall`)
- does any admitted call write, run code, or use a secret: `Has(write)`, `Has(exec)`, `Has(use, secret)`
- which hosts (`fetch`, and `net` resources): the host cells, with "and any other host" when the "anything else" cell is
  admitted
- can it admit a call nobody described: `Unknown`, or `described` false
- can it admit a call whose repository config runs a program: `repoConfigRunsCode` true or null

**Where the domains come from**:

- the tree's own constants, for strings
- the fact types in `sh-call.ts` (`ShFacts`) and `sw-policies.ts` (`fetchFacts`), for the finite fields
- the effect algebra (`effects.ts`: 5 operations × 7 kinds), for effects
- for programs, the installed manifests (9 ship: `cat`, `find`, `git`, `head`, `jq`, `ls`, `rg`, `tail`, `wc`) plus
  "any other program", whose effects are `unknown`

**Fields are correlated, and the analysis treats most of them as independent.** That makes it a sound
OVER-approximation. A negative line ("never writes", "no host but shop.com") is a proof. A positive line ("can match a
write") means only that the tree does not exclude one, and the combination may not be realisable. Two correlations are
modelled because without them the answers are useless:

- **The URL fixes the host.** `Under(url, …)` and `Is(url, …)` carry their host, so `c.url === "https://a.example/x"`
  is reported as reaching a.example only.
- **The program bounds its effects.** For a program with a manifest, the reachable effects are the command's terms
  plus the terms of every flag the tree does not exclude, plus `unknown` unless the tree excludes undescribed calls.
  This bound is sound and coarse: it ignores which flags combine, and it is exact only when the tree fixes the argv.

**Its cost.** Satisfiability over n atoms needs at most 2^n checks in a trivial per-field theory (consistency of
equalities, memberships and prefixes on one field). Trees are small: no corpus policy that fits has more than 5 atoms.
A cap (24 atoms, a guess) above which the card says MEASURED keeps a hostile proposal from costing anything.

**A breadth carries its manifest pins.** The program bound is read from the manifests installed when the breadth was
derived. When a manifest's pin changes, the breadth of every tree that leans on it is derived again, and the card says
which manifest it used.

**A worked example: POLICIES.md's own git policy,** lifted. The derived card says:

- programs: git only
- writes: none from `status`, `diff`, `log`, `show` or `blame` with the four excluded flags absent, as far as the git
  manifest describes them
- can admit an undescribed git call (a flag the manifest does not know gives `unknown` effects, and the policy never
  asks about effects)
- **can admit a call whose repository config runs a program**, because the policy does not mention
  `repoConfigRunsCode`

The built-in plain-host default requires that fact to be false (SHELL.md, "Repo-level config is UNTRUSTED"). The
example policy, as a person's `allow`, would let `git diff` run in such a repository without asking. Whether the belt
(the forced `core.fsmonitor`/`core.pager`, `--no-ext-diff`, `--no-textconv`) makes that harmless is the belt's
question. The card's job is to say it, and a measured breadth would not have: the probes vary hosts and paths, not
repository configs.

Ruled since (#921): both specs' example now ends `&& c.repoConfigRunsCode === false`, on the rule that an example in a
spec is never wider than the built-in default on a fact the default names. That is one more `Is` atom, so the example
still lifts mechanically, and its derived card loses the last line above.

## The card: DERIVED or MEASURED, and saying which

The card's breadth block has one label, and it is never mixed:

- **Derived** ("from the rule: exact"): the lines above, with a negative line worded as a fact ("never writes") and a
  positive one as "can match". This is shown when the proposal lifted to a tree and its breadth was derived within the
  cap.
- **Measured** ("from N sample calls: a sample, not a proof"): today's probe counts, worded as today ("matched none of
  the N unrelated sites it was tried on"), and the reason it is not derived, named ("uses a regex", "reads a string's
  length", "over the atom cap").

The evidence part of the card is the same for both: the calls this run made and the ones it would allow next, checked
against the policy before it is granted. A derived card still runs the probes, and they become a TEST of the
derivation. A probe the tree admits that the derived breadth says it cannot admit is a bug in the analyser. The card
then falls back to MEASURED and logs the disagreement.

## A person's code policy beside a proposed tree

- **Nothing about the code policy changes.** The composition is today's: `deny` wins over `allow`, no opinion defers.
  A person's policy is shown as the code they wrote (POLICIES.md), and nothing converts it on its own.
- **The tree's breadth is its own, and an upper bound on what it adds.** Overlap with a code policy cannot be derived,
  since that is the code-breadth question again, so the card does not claim it. It says "you have N other policies for
  this consumer; a deny among them still wins", and it lists which of them decided any of the evidence calls, which is
  measured and labelled so.
- **Lifting a person's policy is the person's act.** The policy page can offer "this rule fits the tree: show it as a
  sentence" on a code policy that lifts. Accepting stores the tree, and the change shows the sentence beside the old
  code.
- **When the tree becomes the default** and code policies move behind the "allow read-only exec policies" toggle (off by
  default, POLICIES.md), EXISTING code policies keep judging, and the toggle governs only writing new ones. Turning
  them off would widen as well as narrow. An allow switched off only asks more, but a DENY switched off lets through
  what the person refused. So the toggle never disables a stored policy. The upgrade gets a fixture of today's stored
  code policies, read by the new code, still deciding as they did (AGENTS.md: test the upgrade).

## Not covered

- **The corpus.** No model- or person-written policy exists to measure against, so 92% is a figure over tests and
  docs.
- **Regexes**, except an anchored alternation of literals over an argv element, which lifts to `StartsWith`.
- **String operations** other than equality, segment prefix and an argv element's character prefix: `endsWith` (the
  renderer uses it for subdomains, a person cannot), `includes`, `split`, `slice`, `join`, length, character index.
- **Order and arithmetic**: `<`, length comparisons beyond `ArgCount`'s finite set, and semver ranges over
  `program.version` (`Is` only).
- **Positions and relations**: an index into `paths` (`c.paths[0]`), "the argument after `-o`", and a fact compared
  with another fact.
- **The world and the history**: conditions about the outside world (the pinned script of POLICIES.md), time, how
  often something happened, what the run did before.
- **The over-approximation itself**: a positive breadth line may name a combination no real call reaches, and the
  program bound ignores which flags combine.
- **A program with no manifest**: its breadth is "effects unknown", true and uninformative.
- **Consumers**: only `fetch` and `sh` have facts. A consumer without resolved facts has no policies at all.
- **What a breadth is relative to**: the installed manifests, at the time it was derived.

## Open points for the ruling

1. **Is 92% over tests and docs enough to proceed?** I recommend measuring on real proposals first. That means one
   bench task per consumer that asks a model to propose a policy for a described need ("let it read the repo's docs
   site", "let it run the test suite"), run across the panel, with the proposals fed through a lifter prototype. The
   lifter is the first code either way, and it is small. `propose_policy` is fetch-only today, so sh proposals need it
   widened, which is its own decision.
2. **The renderer's presence test.** `Is(f, absent)` and every guarded optional read need a presence check the policy
   realm accepts, and the facade refuses reading an absent key. `Object.keys(p).includes("topLevel")` should work with
   the root's `Object`, but that is unverified. The alternative is to send every optional fact as an explicit `null`,
   which is a facts-shape change for SHELL.md.
3. **`StartsWith` on argv elements** is a character prefix, which the segment rule rejects for structured fields. It is
   in because argv is opaque text and the git example needs it. Say if it should be out.
4. **The atom cap** (24) and the "probe disagrees with derivation" fallback are guesses with no measurement behind them.

Also fixed in this PR, reported by the corpus collection and checked against the code:

- `POLICIES.md` and `SHELL.md` wrote the plain-host default as `c.effects.every(…)`. The effects view has no `every`,
  so as written it is broken; both now read `c.effects.pairs.every(…)`.
- `POLICIES.md`'s regex warning tested `c.program`, which is an object; it now tests `c.program.path`.
- `SHELL.md`'s field table lists `run`, which `ShFacts` does not have; that row is removed.
