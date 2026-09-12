# Tool tokens as pointers

Implementation notes for `@tool:` pointers, `dereference`, the text-pipe dialect and the pointer macro, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**Tool tokens are POINTERS, not just citations (`dereference`).** An `@tool:<id>` was only a way to embed an
output in the final answer. It is also a HANDLE the model can read back mid-run. The loop already retained
every non-failed citable output keyed by that id, so the value was there — there was just no way to reach it.
`dereference` (offered only when `toolTokens` is on) reads it, optionally reduced by a `pipe` first, and it
reaches the FULL capture rather than the ~500-char copy the model was shown — data that was otherwise
unreachable without re-running a side-effecting tool. It is answered **in the loop** (`derefLocally`), not
delegated: a pure read of run state the loop owns, so it behaves identically on the page-hosted and
background-hosted paths with no page round-trip and no approval.
- The **pipe is the existing bash sub-dialect** (`text-pipe.ts`), extended with the structural stages it
  lacked: `keys` · `values` · `schema` (alias `jsonschema`) · `type` · `count` · and jq-style `.a.b[0]` paths,
  composing with the line verbs in either order. Bare words are verbs, a leading dot is a path, so the two
  families can never collide — `.keys()` is spelled `keys`, and "the keys of that field" is `.items | keys`.
  Structural stages REFUSE non-JSON rather than inventing a shape for prose. `count` is the structure-aware
  size (`wc -l` counts LINES, so after a path stage it counts the lines of pretty-printed JSON — true and
  useless). **`PIPE_CMDS` is the single source** for EVERY description of the dialect: `PIPE_USAGE` (a total
  `Record` over it, so adding a verb without describing it is a COMPILE error) feeds `PIPE_SYNTAX` for the
  tools' `pipe` PARAMETERS and `PIPE_HINT` for the error paths, and `pipeHint()` drops the hint when the
  dialect's own refusal already listed the verbs. It was originally single-sourced only for the refusal and
  the system prompt, which is not the same as guarding the invariant: five other copies were hand-written
  and all had drifted to six verbs while the dialect had twelve, and `dereference`'s own description still
  advertised `len`/`slice` — verbs left over from a discarded dialect — even though the drift-guard test
  checked `DEREF_CLAUSE` for exactly those two names. A model told the set is smaller than it is never
  reaches for `schema` or a `.path`, which costs it a whole turn to discover.
  The guard now scans the tree, and its shape is the reusable part: the invariant is COMPLETENESS, not
  "never name a verb" — a pipeline EXAMPLE is what a doc should show, and no regex separates an example from
  a stale list. A line naming THREE OR MORE verbs is a list and must name them all; it scans PROSE only
  (comments + string literals), because five verb names are ordinary identifiers and `|` is TypeScript's
  union operator, so every false positive was code; and an explicit `…` or `e.g.` is honoured as the
  author's own "not exhaustive" disclaimer.
- **`sed` is SUBSTITUTION only** — `s/PATTERN/REPLACEMENT/` with the `g` and `i` flags and any delimiter
  (`sed 's|http://a|X|'`, quoted, since a bare `|` separates stages). No addresses, no `-n`, no other
  commands: a model reaching for `sed -n '2p'` gets a refusal naming what the verb does accept, and `head`
  is what it wanted. It is a LINE verb, so it composes with the structural stages in either order.
- The pointer carries the value's **TYPE**, from the render descriptor the step already produced — so `keys`
  on a DataFrame means its COLUMNS, and two casts the line dialect can't express work: `latex`, and `img`,
  which never dumps the payload but says it IS base64 image data, how large, and what to do instead.
- `token` takes a **short LABEL** as well as `true` (`token: "the pricing table"`). The string is both the
  opt-in and the name; it is purely for the model, appearing in the deref header, the available list and the
  fault candidates, and `nearest()` matches on it so recalling the NAME while inventing the hex still lands.
  It is a model-authored CLAIM, so it always sits BESIDE the derived description, never instead of it.
- Two failure modes are explicit. A pointer **aliases a snapshot with no invalidation**, so every read leads
  with what the value is and how many steps ago it was captured. And an unresolvable reference is usually a
  hallucinated token-SHAPED id, so it answers with a **MemoryFault** — the bad address, the nearest real
  pointers with their edit distance (distance 1 is a typo; 6 means it invented one, and the message says so),
  and an explicit note that the fault is RECOVERABLE, so a model pattern-matching "fault" to a crash doesn't
  abandon the task.
- **`look` accepts an image pointer**: `look { selector: "@tool:abc123" }` re-examines a screenshot the run
  already took — a new question about the same pixels, instead of re-shooting a page that may have changed.
  The loop resolves it and hands the image down, so `look` never learns about tokens.
- **`ml.dereference(ref, { pipe })`** is the same thing as a primitive, `pipe` taking the dialect string or an
  ARRAY of stages (which sidesteps quoting — one entry may hold a bare `|`). That was documented long before
  it was TRUE: stages were joined with `" | "` and then re-split, so `["grep -E error|warn"]` was torn in two
  and `["grep -E head|tail"]` silently grepped `head` and ran `tail` as a stage — a plausible wrong answer,
  no error. STAGES are now the form execution uses and are never re-joined; joining is for DISPLAY only
  (`pipeStages` vs `displayPipe`). The array had to be widened along the whole path, and `DEREF_TOKEN` in the
  background did `String(pipe || "")`, which comma-joins an array into something that is not the dialect. Run-bound exactly like `ml.answer`: `tool-exec` binds a resolver
  for the duration of a tool call and restores it after, so it is live inside an approved `exec` and throws
  from a page's own console. The BACKGROUND path rings back over the same reverse channel the output stream
  uses (`DEREF_TOKEN`, keyed by runId) — a page-only binding would have worked in off-mode and silently
  returned nothing whenever a debug surface was open. `dereference` and `info` are both in the read-only exec
  dialect (pure reads that spend nothing), with the adversarial tests the dialect rule requires.
- **THREE DISJOINT REFERENCE FORMS, told apart by SHAPE** — dispatched, never tried in order, so each
  spelling has exactly one meaning and nothing can shadow anything:
  `@tool:"the budget dataframe"` (quoted) = the model's own LABEL · `@tool:adf40ed` (7 hex) = a minted id ·
  `@tool:python_exec` (bare) = that tool's latest call. Dispatching on form also keeps a CORRUPTED id in the
  id branch, where it misses and faults, rather than being retried as a tool or label and resolving to
  something unrelated. The partition is ENFORCED: `ml.defineTool` throws on a name that is not an identifier
  or that is id-shaped, because the charset alone does not give it (`deadbee` is both).
- **The id carries a CHECK CHARACTER** (6 hex of avalanched hash + 1). It was FNV-1a truncated, which made it
  a disguised counter — the middle four characters were identical for nine consecutive steps, so ids sat a
  Hamming distance of 2 apart and a two-character typo could land on ANOTHER LIVE POINTER. A murmur3 `fmix32`
  finaliser fixed the diffusion; the check character then makes every single-character substitution
  structurally invalid, and — more usefully — lets a fault tell a MISTYPED id from an INVENTED one.
  Correction is deliberately NOT in the id: the live set of ~24 ids is already a code with minimum distance
  ~4 for zero characters, and unlike an algebraic code it degrades gracefully as the error grows. See
  `docs/POINTER-IDENTIFIERS.md` for the measurements and the benchmark that is still unrun.
- **Labels resolve, in tiers, and a near match is never silent.** Exact → resolve. Near AND clearly ahead of
  the runner-up (`labelMatch`, default `hybrid`) → resolve and SAY SO. Ambiguous → fault with candidates.
  The margin is the guard, not a distance threshold: given `model_fit_linear` and `model_fit_quadratic`,
  both clear any absolute bar, so only separation can refuse `model_fit` while still accepting a typo with a
  clear winner. The announcement channel differs by caller and this is load-bearing — the TOOL appends it to
  its result, but `ml.dereference` in `exec` returns a VALUE the script parses, so a note there would corrupt
  the data: a read returns `{ value, warning? }` and the exec path `console.warn`s it.
- **Pointers span the SESSION, not the turn**, LRU-bounded (`TokenStore.CAP`) with a read counting as a use.
  On the background path the store is released with the `bgRuns` entry, NOT in `untrackRun` — that fires per
  TURN, and putting it there emptied the store between turns.
- **`dereference` with NO argument lists what the session holds** (id, name, TYPE, age) — the answer to "what
  do I have?", so the model never has to recall an id to find out.

- **Reading by NAME pins a stable id.** `@tool:python_exec` means "the LATEST python_exec call" — a moving
  target. A model that didn't pass `token: true` was never shown that call's hex (it is minted for a citable
  builtin either way, just not surfaced), and it often only decides an output is worth keeping AFTER seeing
  it. Dereferencing through the alias is exactly that moment, so the reply hands over the stable id and says
  what it is, rather than leaving the model holding a handle that moves under it.
- **Pointers survive a session's later turns** — a follow-up turn can still read what an earlier one captured.
  The store was per-`runAgentLoop` call, so every turn started empty while the model still saw the earlier
  turn's pointers in its own history. Ids were never the obstacle (`seqBase` already offsets each turn so a
  later one cannot collide), so one store per SESSION is safe. It is therefore BOUNDED — `TokenStore.CAP`,
  evicting least-recently-USED, since a read has to count as a use or "pin it before it goes out of scope"
  does not hold. Recency is tracked apart from insertion order, because insertion order is what makes the
  name alias mean "the latest CALL": refreshing it on a read would promote an old output to look like the
  newest. On the background path the store lives in a map beside `derefByRun`, deliberately NOT on the
  `bgRuns` record — that record is JSON-checkpointed for MV3 eviction and a Map serializes to `{}`.
- **A PIPED read mints its own pointer**, so the model can cite the reduction it just built rather than the
  whole original. `dereference` is otherwise excluded from `citable` because it "produces no new data, only a
  VIEW" — true with no pipe, false with one. Minted inside `derefLocally`, not by flipping `citable`, since
  the generic path would read this tool's `token` PARAMETER as the model's opt-in/label.
- **`ml.pipe(source, pipe)`** runs the same dialect over ANY string, not just a captured tool output:
  `ml.pipe(await ml.fetch(url), "grep -i pricing | head -20")`. So the scanning vocabulary is one language
  wherever text comes from, and a stage never round-trips through a re-joined string.
