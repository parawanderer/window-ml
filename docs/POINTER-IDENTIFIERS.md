# Pointer identifiers — what a model can reliably hold on to

**Status:** analysis + measurements of what ships, plus a benchmark that has NOT been run.
Companion to [spec/TOOL_TOKENS.md](spec/TOOL_TOKENS.md), which specs the *mechanism*
(`@tool:<id>` citations woven into an answer). This document is about the **identifier**: what
shape it should be, what actually goes wrong with it, and how we would find out rather than
argue.

Everything under "Measured" is reproducible from the repo; everything under "Reasoned" is
argument from those numbers; everything under "Unvalidated" is a guess we have not tested. The
sections are separated deliberately — the interesting failure in this area is confusing the
three.

---

## 1. What the identifier is for

A tool token is a handle to an output the run already produced. Its purpose is **not** citation
in the final answer — that is the visible use. The real one is avoiding **re-emission**: without
a pointer, a model that needs a 4,000-row table in a later step has exactly one option, which is
to write the table out again, through its own context, token by token. The pointer exists so the
bytes can move without passing through the model at all:

- `dereference` reads a captured output back, reduced by a `pipe`, without re-running the tool.
- `ml.dereference` **inside `exec`** hands the value to a *script* — the bytes go from the store
  into JS and never enter the model's context. Composed with `ml.pipe`, that is a genuine data
  plane.

This reframes what "a good identifier" means. It is not "an id the model can remember". It is
**an id the model is confident enough in to use instead of retyping**.

## 2. The failure that costs, and the failure that doesn't

Two things can go wrong, and they are not equally expensive:

| | what happens | cost |
| --- | --- | --- |
| **A wrong id that MISSES** | `MemoryFault`, with ranked candidates | one step, recoverable, visible |
| **A wrong id that RESOLVES** | a real output, from the wrong call | silent wrong answer |
| **Hesitation** | the model retypes the data instead | the entire feature, invisibly |

The third is the one to design against, and it is the one you never see in a log — it shows up
only as a fatter transcript. It also means **uncertainty is the enemy, not error**. A model that
is unsure whether `@tool:a39f59d` will resolve has an obvious safe fallback, and it will take it.

A real instance of this, from a live run: a lifetime bug emptied the pointer store between turns,
so the model dereferenced an output it had watched itself produce and was told "Nothing has been
captured in this run yet". It then wrote in its answer that pointers are per-run and that it
would ask for a labelled token on every call from then on. **One broken lifetime produced a
permanently more expensive model for the rest of that session.** Reliability here compounds in a
way that format choices do not.

## 3. The error model

What actually corrupts an id, in rough order of how often we have seen it:

1. **Invention** — a plausible token-shaped string that was never minted. The model needed a
   pointer, did not have one in context, and produced something id-shaped.
2. **Block corruption** — a real id with a contiguous run of characters wrong. Observed in
   practice (and not only in this tool: it is the familiar way models mangle git hashes).
   The likely mechanism is that a hex string is not a sequence of characters to a transformer, it
   is a sequence of **BPE tokens of 2–4 characters**, so the unit of corruption is a chunk, not a
   character. Errors are therefore *contiguous and aligned*, not scattered.
3. **Single-character substitution** — the classic typo. Real, but probably a special case of (2)
   where the chunk happens to be one character.

Point (2) matters a lot and is easy to get wrong: a scheme tuned for single-character errors is
tuned for the wrong distribution. It is called out again in §5 and §6, because it is the reason
the design landed where it did.

---

## 4. Measured

### 4.1 The ids were a disguised counter (fixed, `173d270`)

`toolToken` is FNV-1a over `${runHash}:${seq}`, truncated. FNV-1a's final step xors one byte and
multiplies once, so consecutive `seq` values stayed correlated — and truncating to the **top**
hex characters keeps precisely the bits that moved least:

```
seq 1 -> f22fa7   seq 4 -> f52fac   seq 7 -> f42fab
seq 2 -> ef2fa3   seq 5 -> f62fae   seq 8 -> f92fb2
seq 3 -> f02fa4   seq 6 -> f32fa9   seq 9 -> fa2fb4
```

The middle four characters are identical for nine consecutive steps. Two documented properties
depended on that not being so: that a near-miss misses (these sat a Hamming distance of **2**
apart, with 40 such pairs among 24 ids), and that the id is opaque so a model must copy rather
than guess it (these are visibly extrapolable).

Adding murmur3's `fmix32` finaliser after the FNV loop:

| | broken | fixed | random ideal |
| --- | --- | --- | --- |
| distinct characters per position, 16 consecutive seqs | 1 (constant) | 10.31 | 10.3 |
| pairs within Hamming distance 2, per 24-id run | 40 | 0.059 | 0.057 |

**Lesson worth keeping:** a truncated hash needs an explicit avalanche step, because truncation
takes exactly the bits a weak mixer never diffused. And when auditing an id scheme, measure
**per-position variety across consecutive inputs**, not collision rate — collisions looked
perfectly healthy the entire time this was broken.

### 4.2 Sparsity already does most of the work

With ~24 live ids in a 6-hex space:

- a single-character typo of a live id has 90 neighbours → chance it lands on **another live id**
  ≈ **1 in 8,100**
- a wholesale invented 6-hex id hits a live one ≈ **1 in 730,000**

So after the avalanche fix, "a corrupted id misses" was already true *with high probability*. The
remaining argument for a check character is that a probability is not a property, and the failure
it permits is the silent one.

### 4.3 The check character (shipped, `02025cc`)

An id is now **6 hex of payload + 1 check character** — a weighted sum mod 16 with odd
(therefore 16-coprime) positional weights.

- **630/630** single-character substitutions rejected across a sample — 100%, by construction:
  changing digit `d` to `d'` at position `i` shifts the sum by `w_i·(d'−d)`, and with `w_i`
  coprime to 16 that is 0 mod 16 only when `d' = d`.
- **90.3%** of adjacent transpositions rejected. The gap is pairs differing by exactly 8; a Damm
  quasigroup would close it at the cost of a 256-entry table.
- Against **block** errors (§3.2, the realistic case) detection is ~15/16, not 100% — a linear
  checksum catches an arbitrary corruption with probability 15/16.

The check character was **added** rather than taken out of the 6. Rebalancing would have shrunk
the payload space 16×, making an *invented* id — the more common failure — 16× more likely to hit
a live pointer, in order to fix the rarer typo.

Its most useful property is arguably not detection at all but **diagnosis**: seven hex that fails
its check is definitively a *corrupted real id*, not an invented one. That distinction licenses a
different response (§5).

### 4.4 Error correction: one character detects, two correct

Sphere-packing over GF(16), 6-character payload:

```
n=7 (1 parity):  16,777,216 codewords x 106 words/sphere = 1.78e9  >  16^7 = 2.68e8   OVERFLOWS
n=8 (2 parity):  16,777,216 codewords x 121 words/sphere = 2.03e9  <  16^8 = 4.29e9   FITS
```

At 7 characters the radius-1 spheres need ~6.6× more room than the space contains, so **one
parity character can only ever detect**. Intuitively: one check character yields 15 non-zero
syndromes, but there are 7 positions × 15 wrong values = **105** distinct single-symbol errors to
tell apart. You can know something is wrong; you cannot know what. Two parity characters give 255
syndromes, and Reed–Solomon over GF(16) achieves the bound exactly (`d = n−k+1 = 3`, corrects
one symbol).

**Price list: detection costs 1 character, correction costs 2.**

### 4.5 …but the live set is already a better code, for free

Error-correcting codes exist for when you cannot enumerate valid codewords. Here we can — there
are ~24 live ids in a run. Measured across 5,000 simulated runs:

```
live set (24 ids): mean MINIMUM distance          4.01
                   runs with any pair within 2:   0.5%
expected distance between two random 7-hex ids:   6.56
```

The live set is a code with minimum distance ≈4 at **zero** cost in characters, versus distance 3
for an 8-character Reed–Solomon code costing two. Decoding is nearest-neighbour over 24
candidates, which `nearest()` already implements.

And this is where §3.2 pays off: **set-matching degrades gracefully with error size, algebraic
ECC falls off a cliff at its designed radius.** An RS code sized for one symbol error is defeated
by a 2–4 character block — the common case — while nearest-neighbour against a distance-4 set
handles it comfortably, because the true id remains far closer than any other live id.

*Reproduce:* the numbers in 4.1/4.5 come from short scripts over `toolToken`; the substitution and
transposition rates are asserted in `tests/util.test.mjs` and `tests/token-id`-adjacent tests.

---

## 5. What was built, and why it took that shape

**Optimise for recall, not for transcription fidelity.** Format barely matters if the model never has to
reproduce an opaque string. All of the below now ships; the reasoning is kept because the *shape* of each
decision is the reusable part.

### The namespace: three disjoint forms, dispatched on shape

```
@tool:"the budget dataframe"   quoted        the model's own LABEL
@tool:adf40ed                  7 hex         a generated id
@tool:python_exec              bare word     a tool alias — that tool's latest call
```

Dispatched on **form**, never tried in order. Each spelling has exactly one meaning, so there is no
precedence rule to teach and nothing can shadow anything — and a CORRUPTED id stays in the id branch, where
it misses and faults, instead of being retried as a tool or label and resolving to something unrelated.

The partition rests on ids and tool names being distinguishable, which the charset does **not** give for
free: `deadbee` is a legal identifier *and* a valid token shape. So `ml.defineTool` throws on a name that is
not an identifier or that is id-shaped. The guarantee is enforced at definition time rather than assumed.

### Never require transcription

`@tool:python_exec` needs no memory at all. Reading through it returns that call's **stable id** with a note
that the alias moves and the id does not — handing over the handle at the exact moment the model has it in
context, which is the one situation where transcription is reliable. A model that never asked for a token
still gets one this way, which matters because it usually decides an output is worth keeping only *after*
seeing it.

`dereference` with **no argument** lists what the session holds — id, name, type, age. Previously that was
reachable only by provoking the "token is required" error, which is backwards for a mechanism whose job is
confidence: a model that cannot cheaply see what it has will guess, and one that expects to guess wrong
retypes the data instead. That is the cost the whole mechanism exists to avoid.

### Labels resolve, in tiers, and a near match is never silent

A label is the handle worth having, because the model *chose* it when it knew what the output was for — it
is recalled rather than transcribed, and degrades gracefully where a hex id degrades into garbage.

| the reference | outcome |
| --- | --- |
| exact label | resolve, silently — nothing was approximated |
| near, and clearly ahead of the runner-up | resolve, and **say so** |
| near, but ambiguous | refuse; fault with candidates, types and scores |
| id one character off | refuse — the check character and the sparse space make it miss |
| bare word | a tool alias only, never fuzzy |

**Separation is the guard, not a distance threshold**, and that distinction is the whole design. Given
`model_fit_linear` and `model_fit_quadratic`, both candidates clear *any* absolute bar, so only a margin can
refuse `model_fit` while still accepting `model_fit_linea` — a typo with a clear winner. A rule like
"resolve if edit distance ≤ 2" has the appearance of determinism without the property: `baseline_loss` and
`baseline_losses` are distance 2 apart, so with both in the table it is a coin flip.

**The announcement channel differs by caller, and that is load-bearing.** The tool appends the note to its
result, because there the model READS the result. `ml.dereference` inside `exec` returns a value the script
is about to `JSON.parse`, split, or pipe — a note appended there would corrupt the data. So a read returns
`{ value, warning? }` and the exec path `console.warn`s it, which exec already captures into both the step
result and the live stream.

### The metric is configurable, because it is genuinely undecided

`labelMatch` (default `hybrid`) selects how near-misses are ranked. Exposed as a setting rather than a
build-time define — unlike the identifier FORMAT — because the measurement says no metric wins outright and
plain edit distance is actively misleading. See §6 for the numbers.

### Correction comes from the live set, not from the id

With the checksum saying "corrupted, not invented", and 99.5% of runs having no ambiguous pair, a corrupted
id could be corrected against the live set. The one thing ECC-in-the-id would buy that set-matching cannot
is correcting an id with **no access to the run** — validating a citation inside an exported transcript.
Not a problem we have.

### Semantic ranking is deliberately NOT wired in

`ml.embed` exists as a primitive, but embeddings do not enter the resolve path, and a measurement supports
that rather than mere caution. Against the query `"the table of sales"`:

| candidate | embeddinggemma | qwen3-0.6b |
| --- | --- | --- |
| `the sales table` (correct) | 0.972 | 0.939 |
| `the revenue table` (drift) | 0.768 | 0.825 |
| `the pricing table` (**wrong table**) | 0.731 | 0.733 |

The gap between the correct synonym and a *different table* is **0.037** — an order of magnitude below the
separation guard. Embeddings rank drift above the wrong answer, but nowhere near confidently enough to
auto-resolve it, and correctly so. **They would improve candidate ORDERING, not the resolve rate**, which is
exactly the "explicit search, not a resolve-path fallback" split — now with a number behind it.

---

## 5b. Why reading a pointer is asynchronous

A recurring reaction, and a fair one: a *primitive* should not need ceremony. `ml.dereference` is `async`,
and on the page-hosted path it does not need to be — the resolver behind it is synchronous, a pure read of
in-memory run state, and the `await` is pure ceremony.

It is async for the **background-hosted** path (design A, the default whenever a debug surface is open),
where the pointer store lives in the service worker and the read is a `postMessage` round trip. The
signature cannot vary by host: the same call must work either way, and returning a value in one case and a
promise in the other would be an invisible footgun.

**The useful way to think about it:** this is not a cast. A cast is compile-time and cannot fail. This is a
read from a store that may live in another process — closer to a memory access that can page-fault, which is
exactly why a bad one is already called a `MemoryFault`. **The `await` is the page fault.**

Measured against the read-only dialect, which is the one place we control the language:

```
top level, WITH await     -> "VALUE(@tool:aaa1111)"
top level, NO await       -> "VALUE(@tool:aaa1111)"     the facade auto-awaits: no ceremony needed
Promise.all (parallel)    -> ["VALUE(a)","VALUE(b)"]    the one genuine deferred use case, and it works
inside .map callback      -> NotInDialect: await is not supported inside a callback
```

Three things follow.

1. **In the dialect you already do not await it.** The complaint is answered where it can be.
2. **There is exactly one deferred use case** — `Promise.all` over several reads, which on the background
   path really does halve the latency. Worth milliseconds, so it is not an argument *for* async; but making
   the primitive synchronous would remove it.
3. **The real gap is callbacks, not `await`.** `.map(id => ml.dereference(id))` fails with or without an
   await, because the dialect's `runSync` driver — which exists so a callback can never return a silently
   Promise-valued answer — cannot suspend. Closing it means teaching the interpreter to drive host array
   methods itself: a change to the evaluation model of a security-sensitive component, carrying the
   adversarial-test rule, for a case where a model usually reads ONE pointer rather than N. Not judged
   worth it; recorded so the next reader does not re-derive the question.

## 6. Unvalidated — what needs an A/B

Everything above concerns whether a *corrupted* id is safe. None of it measures the thing that
actually matters: **how often does a model successfully use the pointer instead of retyping the
data?** That is a behavioural question about models, and it is testable rather than arguable.

### Candidate identifier formats

| Format | Example | Hypothesis |
| --- | --- | --- |
| **hex + check** (ships today) | `@tool:a39f599` | baseline |
| **syllable** (built) | `@tool:muroji…` | easier to read and copy, without semantic drift. A strict TRANSCODING of hex — one syllable per hex character — so payload, check character and collision space are bit-identical and the ONLY variable is what the model reads |
| **word pair** (not built) | `@tool:brisk-otter` | easier to copy; **but** introduces semantic drift — a misremembered `f22fa7` is garbage that misses, a misremembered `brisk-otter` becomes `quick-otter`, and near-synonyms are exactly what language models confuse. It also needs 24 bits to match hex's collision space, which is a 4096-word list for a pair (or three words from 256-lists) — hundreds of curated words for an arm whose error model is the one we most suspect |
| **self-chosen label** | `@tool:the-pricing-table` | recalled rather than transcribed; degrades to a good `nearest()` hit |
| **alias only** | `@tool:python_exec` | no identifier at all; fails when two calls of one tool both matter |

### What is built, and how to run it

`hex` and `syllable` ship as build-time variants (`--define __ML_TOKEN_FORMAT__`), and
`tests/e2e/bench/specs/pointer-ids.bench.ts` is the sweep. `hex` needs no define, so the baseline arm
measures the SHIPPED build rather than a rebuild of it.

Choosing a transcoding over a word-pair is what makes the comparison controlled. Both forms carry the same
24-bit payload and the same check character, so a difference in re-emission can be attributed to the form
and nothing else. A word-pair would have moved the error model at the same time — and its own error model
is the thing the table above is most suspicious of, which makes it a poor first arm rather than a good one.

Two tasks. `cite-or-retype` captures a table in turn 1 and asks for it back in a follow-up: a model that
uses the pointer cites it, one that does not retypes the rows. `read-back` SEEDS a captured output and then
requires it, so the read-back path is exercised on every run instead of only when a model happens to reach
for it.

Run the pilot before the sweep:

```
npm run build
USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/pointer-ids.bench.ts --repeats 2
```

### Metrics that answer the real question

1. **Re-emission rate** — the primary metric. Fraction of steps where the model rewrites data it
   already holds a pointer to. Detectable by looking for long verbatim overlaps between a step's
   output and a later message.
2. **Pointer-use rate** — dereferences and citations per run, per format.
3. **Miss rate, split by cause** — invented vs corrupted (the checksum makes this separable for
   hex; for words, "not in the wordlist" vs "a valid but wrong word").
4. **Silent-wrong rate** — a corruption that resolved to the wrong live pointer. Expected ~0;
   worth confirming empirically rather than by argument.
5. **Recovery rate** — after a `MemoryFault`, does the next step get it right, or does the model
   give up and retype?
6. **Token cost per run** — the economic bottom line the mechanism exists to lower.

### Harness — built

This is **built** — `tests/e2e/bench/`, see the `bench` skill. `tests/e2e/observe.mjs` drives ONE run
and writes artifacts (`run.md`, `events.json`, screenshots). It had the wrong *interface* for a matrix
— env knobs (`TASK`, `E2E_MODEL`, `TOOLTOKENS`, …) are right for one run and cannot express a sweep —
so the bench is a sibling, not a bigger `observe`:

- **`harness.mjs` untouched.** Browser plumbing (`launchExtension`, `configureExtension`,
  `waitForMl`), already correct.
- **One refactor:** extract observe's run-driving core into
  `runOnce(config) -> { events, session, runMd, usage }`, returning artifacts rather than only
  writing them. `observe.mjs` becomes a thin CLI over it, behaviour unchanged.
- **`bench.mjs` is new** and walks a matrix, writing per-cell artifacts plus aggregate rows.
- A bench spec is a **file** (a declarative matrix + task list), not environment variables.

One function, two CLIs — one for a human watching a run, one for a matrix. The core never learns
what a benchmark is.

Four rules that keep it that way, and keep the results meaningful:

1. **Metrics come from ARTIFACTS, never from new instrumentation.** Every metric above derives
   from the `__mlDebug` stream the extension already emits. If one cannot, that is a signal the
   event stream is missing something the *product* should have anyway — fix it there, not in the
   bench. This is the rule that stops the bench leaking into the core.
2. **Repeats, or it is noise.** Models are stochastic. N ≥ 5 per cell, reporting spread rather
   than a point estimate. One run per cell measures sampling, not the thing under test.
3. **Experimental dimensions are build-time `define`s, not config flags.** `npm run build` takes
   ~25 ms, so the bench can rebuild per identifier format via esbuild `--define` and add **zero**
   product surface for an experiment that may well conclude "the current design was fine". If a
   format wins, *then* it becomes a real setting.
4. **Validate the extractors on the fake-LLM first.** Script a backend that deliberately re-emits
   data, deliberately corrupts an id, and deliberately recovers; assert the extractors report
   exactly that. Free, deterministic, and it catches the classic benchmark failure of measuring
   your own bug.

**What the calibration caught, before any GPU time.** Rule 4 is not ceremony. Scripting the fake-LLM to
re-emit deliberately, and asserting the extractors said so, found two bugs that would each have produced
a confident wrong answer: the model's tool arguments were being JSON-stringified before scanning, so a
retyped table's newlines became a literal `\n` and a quoted label became `\"` — both invisible, scoring a
clean zero for re-emissions that plainly happened; and only the terminal `agent-result` was read as
authored text, so an earlier turn's answer was never scanned, under-reporting every multi-turn run. Both
are the failure mode the rule exists to prevent: a null result that looks like evidence.

**Seeding changes what metric 5 can measure.** Recovery was going to be observed only where a model
happened to corrupt an identifier, which needs hundreds of runs to collect a handful of instances. A
task's `seed` runs turn 1 against the scripted fake — so the experiment decides exactly what is in
context, a corrupted pointer included — then swaps the backend to the real model and continues in the
SAME session. Nothing is fabricated: the real loop produced that history, so the fault is a real fault
and the recovery is a real recovery. The seed's own steps and answer are excluded from the score, which
is asserted in both directions rather than assumed.

**Order of work, and when GPUs are actually needed.** (1) `runOnce` + `bench.mjs` + the spec
format — no GPU. (2) extractors validated against scripted fake-LLM cells — no GPU. (3) the real
sweep — **this** is the only step that needs the GPUs, so they should not be held during (1) and
(2). Rough size for (3): 4 formats × 3 tasks × 2 models × 5 repeats = **120 runs**, ~1–3 min each,
so **2–6 hours** contiguous. Trim non-discriminating cells after (2) — if two formats perform
identically on a task, that task is not measuring anything and should be dropped rather than
repeated five times.

### Open questions

- Does the block-corruption model (§3.2) hold across model families, and is the block size really
  BPE-aligned? A histogram of observed corruptions by length and offset would settle it.
- Do word-pairs actually reduce re-emission enough to pay for semantic drift? Chosen for semantic
  distance, do they still drift?
- Does a visible run prefix (`@tool:7f-a39f599`) help a model self-check that a pointer belongs to
  *this* run, or is it just two more characters to mangle?
- Is `TokenStore.CAP = 200` ever reached in practice, and does eviction ever surprise a model?
  (Eviction is LRU and a read counts as a use, so a pointer in active use should never vanish —
  but that is reasoning, not measurement.)
