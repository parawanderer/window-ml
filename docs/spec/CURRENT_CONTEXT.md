# Spec: the model reads its own context (`ml.current`)

**Status: agreed in shape, unbuilt** (written 2026-10-05). The READ half. Decided in conversation; the field list and
the open questions at the end are not.

This is the first step of [`AGENT_COMPACTION.md`](AGENT_COMPACTION.md) — the model deciding what in its own history
it no longer needs — and it is deliberately only the step that cannot break anything. Everything here is read-only.
The write half is that document's, and the whole point of the decisions below is that adding it later does not
require redesigning this.

Related: [`COMPACTION.md`](COMPACTION.md) (the harness deciding a session is too long, a different actor),
[`POINTER_VALUES.md`](POINTER_VALUES.md) and [`TOOL_TOKENS.md`](TOOL_TOKENS.md) (how a large value is addressed
instead of copied), [`READONLY_EXEC_SPEC.md`](READONLY_EXEC_SPEC.md) (the dialect this is reached from).

## What it is for

A model cannot see its own context. It can be told things about it — the orientation lines already report the
context window, and `chat_metadata` reports token counts — but it cannot ask. Two kinds of question are unanswerable
today and both come up constantly:

- **When.** Wall-clock times and the gaps between them. A model has no idea whether the page it read was read ten
  seconds or forty minutes ago, whether the person went away between two turns, or how long it has been working.
  This is the single highest-value field precisely because it is the one the model cannot author or infer.
- **How big each part of it is**, and whether that size is a real count or an estimate. This is what makes
  self-compaction actionable at all, which is why it belongs in the READ half rather than waiting for the write
  half. (Which messages the cap is about to DROP is a further question, deliberately left open.)

## The shape

```js
ml.current.run; // { id, model, step, maxSteps, startedTs } — which run this is
ml.current.messages; // the array the NEXT model call would receive, each row carrying a stable `id`
ml.current.meta(id); // what we KNOW about that message; read-only, now and after mutation lands
ml.current.log; // this run's execution log (run-log.ts), gated — see "The log" below
```

Five decisions make it survive the write half. Each is the non-obvious choice.

### 1. `ml.current`, not `self.current`

`self` is on the dialect's DENIED identifier list, beside `window`, `globalThis`, `parent` and `top`
(`readonly-exec.ts`), because `self === window`: it is a realm escape in every other JavaScript context. Giving that
one name a second, safe meaning inside the dialect is a trap for everyone who reads or extends it afterwards, and it
would mean the deny list no longer reads as "these are the ways out".

`ml` is already the run-bound facade. `ml.answer` curates the run's answer set and `ml.dereference` reads a `@tool:`
pointer, both resolving against _the run currently executing a tool_ and both throwing outside one (`tool-exec.ts`).
`ml.current` is the third member of a family, not a new concept — and it inherits the sentence that matters:
**the binding, not a permission check, is what scopes it.**

It also unifies with the Python half: the standing idea is a run-bound `ml` facade inside Pyodide, and `ml.current`
is then the same name reaching the same thing from both languages.

### 2. Stable ids, from day one, even though reading does not need them

Array position is the obvious address and the one that breaks: drop message 3 and every index the model is holding
means a different message, silently. Each row carries an `id` minted the way `@tool:` ids are (`token-id.ts`:
payload plus a check character), so a hallucinated or stale id fails the check instead of addressing a real message
by accident.

Retrofitting addresses later is a breaking change to a contract the model has already learned, and there is no
migration for "the thing it remembered now points elsewhere".

### 3. `messages` is the wire; `meta` is what we know — and they stay apart

`messages` rows are the content the model would actually receive (`role`, `content`, `tool_calls`, …) plus the `id`.
`meta` is everything derived. Merging them reads better and is wrong: `messages` is what later becomes writable, and
a row carrying its own `ts` invites writing a false one. The entire value of the timing fields is that the model
cannot author them.

So: `meta` is read-only permanently, including after the write half lands. Same object graph, two trust levels, kept
apart by shape rather than by a rule in a document.

### 4. Writing to `messages` THROWS; `meta` hands back a copy you own

The two halves differ in write semantics, not only in content, and the rule is: **throw where a write will one day
mean something; copy where it never will.**

`ml.current.messages` is read-only and writing to it throws. Not because writing is dangerous today — it would be
discarded either way — but because assignment to a message is exactly what the write half will eventually MEAN.
Handing back a silently-discarding copy would teach the model that editing its context works, when nothing happened;
it would then be right about the syntax and wrong about the effect, and there is no error anywhere to tell it apart.
A throw is loud now and becomes the real operation later, so nothing learned here has to be unlearned.

A model that wants to work the messages as data has to copy them, and **the dialect cannot give it a deeply
mutable copy today**. That is measured, not assumed (`tests/readonly-exec.test.mjs`):

```js
const i = await ml.info();
i.compute = {}; // OK — the facade built this value for this call
const c = { ...i };
c.mine = 1; // OK — the copy is the script's own object
c.compute.supported_gpus.push(x); // REFUSED — the spread carried it by reference
JSON.parse(JSON.stringify(i)).compute.system_compute.total_memory = 1; // ALSO REFUSED
```

`own()` marks the value it is handed and does not recurse, for every source — an `ml.*` result, a spread, and a
`JSON.parse` result alike. So the top level is writable and nothing below it is, by any route.

That is exactly the guarantee this spec wants for `messages`, and it comes for free: a nested write is refused at
the depth where the alias is, loudly, instead of silently editing something the script did not create. **It is also
what stops the clone-and-edit workflow from working**, and those are the same rule, so one cannot be kept without
the other unless the rule is narrowed.

**Dependency, to be decided before building:** making a `JSON.parse` result owned RECURSIVELY would make the deep
copy usable, and it is narrowly safe in a way the general case is not — `JSON.parse` can only produce fresh plain
objects, arrays and primitives, so there is provably no live page object anywhere in its result to launder. No
other source has that property, which is why this is a change to one branch rather than to `own()`. Per AGENTS.md
it would owe adversarial tests of its own. Until it is made, the honest advice to a model is to rebuild what it
needs at the depth it needs (`msgs.map(m => ({ role: m.role, content: m.content }))`) rather than to clone.

`ml.current.meta(id)` is the opposite case and gets the opposite treatment: a fresh record per call, which the
dialect marks owned, so the script may write to it — to the same one-level depth as everything else above, which is
why `meta` is specified FLAT (see the table) rather than as a nested record. It can afford that because `meta` is never going to be writable — it is derived provenance, and the
whole value of the timing fields is that the model cannot author them (decision 3). There is no future operation for
an assignment here to collide with, so the convenient thing is also the safe one. Annotating a working copy of the
metadata is the natural way to plan a compaction, and a frozen record would throw part-way through that and drop a
reading script out of dialect and into the approval gate.

Keeping `meta` flat is what makes that enough: with no nesting there is no second level for the ownership rule to
refuse, and annotating a working copy — the natural way to plan a compaction — just works.

### 5. It is read from the DIALECT, never from a tool that dumps

Reading your context into your context is a quine that grows. A tool returning the messages array would double the
context in one call, on the path whose whole purpose is usually to save it.

Inside `exec` (and later `python_exec`) the model's filter and slice run OUTSIDE the context, and only the result
lands in it. `ml.current.meta(id).sinceMs` over three hundred messages costs whatever the model chooses to return.
Anything genuinely large is addressed rather than copied, through the value store and a `@tool:` pointer, which is
the machinery that already exists for exactly this.

## It is all RESOLVED UP FRONT, so the whole facade is synchronous

`ml.current.messages` is a plain array and `ml.current.meta(id)` a plain lookup. Nothing here returns a promise and
nothing needs an `await`.

That follows the house pattern rather than inventing one. `@tool:` pointers are resolved before a line of the
script runs — the macro pass is lexical, so every handle the source mentions is known in advance, `exec` awaits
them all in one `Promise.all` before evaluating, and `ml.dereference` is "an ordinary synchronous read for the
duration of the call" (`pointer-macro.ts`). The reason given there is the one that applies here exactly: a model
that writes `@tool:abc.length` gets a length, where against a promise it would get `undefined` and no error —
"which is exactly the plausible-wrong-answer shape this codebase keeps designing out". `ml.current.messages.length`
on a promise is that same silent `undefined`.

**How it is afforded: the same lexical trick.** The source is scanned before evaluation for which members it
names — `messages`/`meta`, `log`, `run` — and only those are fetched, in the same up-front resolve as the pointer
handles. A script
that never says `ml.current` costs nothing — which matters, because on a background-hosted run the context lives in
the worker while `exec` runs on the page, so an unconditional pre-fetch would put the context on the wire for every
delegated tool call whether or not anything read it.

**What the snapshot carries** is therefore bounded by design: per message an id, a role, the metadata, and a short
PREVIEW of the content — not the body. A whole context of bodies is the thing that must never cross on spec, and
the full text of any one message is a separate, explicit, async read (`messageText(id)`, below). So the pre-fetch
is N small records, and the expensive thing stays something you ask for by name.

Combining the two is then the obvious code, and works inside a callback because everything is sync — the dialect
allows a sync read inside a `.map`/`.filter` and refuses an async one (`tests/readonly-exec.test.mjs`), so this
distinction is what decides whether the natural join runs or escalates to a human:

```js
const stale = ml.current.messages
    .map((m) => ({ m, meta: ml.current.meta(m.id) }))
    .filter((x) => x.meta.tokens > 500 && x.meta.sinceMs > 10 * 60_000)
    .map(
        (x) =>
            `${x.m.id} ${x.m.role} ${x.meta.tokens}t ${Math.round(x.meta.sinceMs / 60_000)}m ago`,
    );
```

Resolving up front also makes the facade a SNAPSHOT for free: every row and every record describes the same
instant. A run advances while a survey is being written, and a join whose halves were fetched separately could pair
a message with metadata from a later step and be wrong with nothing to report it.

**The JSDoc on the contract type carries this example**, because `agent_api_docs` lifts contract JSDoc verbatim
into what the model reads, and the join is the part worth showing. It belongs on `meta` itself as well as on the
facade, since that is where `agent_api_docs --member` lands.

**Do not add the contract type before the implementation.** The generator advertises whatever is in `contract.ts`,
so a type landing early would put a method in the model's own API reference that throws when called, with no way
for the model to tell "not built yet" from "refused".

## What `meta` carries

First set, in rough order of how much a model can do with it. All of it is derived from events the run already has.

| field                   | why it is there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts`, `sinceMs`         | wall clock, and the GAP to the previous message, pre-computed — a model doing arithmetic on two stamps pays tokens to get it slightly wrong                                                                                                                                                                                                                                                                                                                                                       |
| `surface`               | where a user message was typed (`PromptSurface`, contract-run.ts) and what that implies: whether anyone can see the page. Already recorded per message                                                                                                                                                                                                                                                                                                                                            |
| `tokens`, `tokensBasis` | the size of THIS message — what compaction would actually reclaim — and WHICH KIND of number it is: `counted` where the engine reported it (an assistant message IS one generation, and its completion count is real), `estimated` where nothing did and it falls back to ~chars/4. The precedent is `RunStats.genBasis`, which carries the same distinction for timing so that a surface can be honest about what it is showing; a bare number here would be read as counted, and is usually not |
| `step`, `seq`           | which step produced it, so a message joins up with the transcript, the exports and a `@tool:` pointer                                                                                                                                                                                                                                                                                                                                                                                             |
| `tool`                  | the tool a tool-result message came from                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `truncated`             | whether what the model was given was already cut (the output cap), so it does not reason about an ellipsis as though it were data                                                                                                                                                                                                                                                                                                                                                                 |

## The log

`ml.current.log` is the model-facing read of the execution log (`run-log.ts`, `docs/dev/run-log.md`), merged here
because it answers the same kind of question: what happened to me that my transcript does not say — the tab that
was discarded and reloaded, the CDP attach that was refused. The gate and the hazards are already written in that
document and are not re-decided here.

It is resolved up front and read synchronously like everything else on `ml.current`, and it is the clearest case
for scanning PER MEMBER rather than for the facade as a whole: a script that wants message times has no use for the
log, and one that wants the log has no use for the message table. Both are capped — `PER_RUN_CAP` records, N small
message records — so either is cheap to ship and neither should be shipped to a script that never names it.

**It is an array of RECORDS, not rendered text.** Each is the shape the log already stores — `ts`, `subsystem`,
`kind`, optional `reason`, optional `detail` — so filtering is ordinary dialect code and needs no query language
and no new methods:

```js
const log = ml.current.log; // sync, like the rest of the facade
log.slice(-20); // the last twenty
log.filter((r) => r.subsystem === "page"); // one subsystem
log.filter((r) => r.kind === "discarded" || r.kind === "unreachable");
log.filter((r) => r.ts > Date.now() - 60_000); // the last minute
```

Records rather than a string, for three reasons. The dialect's array methods are already there, so a string would
mean inventing a grep where `filter` exists. A regex over rendered text would match the rendering — the column
layout and the human wording — rather than the facts, so the log's presentation could not change without breaking
scripts written against it. And `kind` is a closed vocabulary that the log's own sanitizer enforces
(`sanitizeRunReport` silently drops a record whose `subsystem`/`kind` is not a lowercase slug), which is exactly
what makes an equality filter reliable and a substring search a guess.

### And a greppable text form beside it, for `ml.pipe`

`ml.pipe(text, "grep … | head -20")` already runs the tools' shell-style dialect over ANY string
(`text-pipe.ts`), and a log is the most line-oriented thing in the system, so piping one is the obvious move.
`ml.current.logText` is that string:

```js
ml.pipe(ml.current.logText, "grep discarded | tail -20");
```

**A sibling member, not `toString()`.** `ml.current.log` is a plain array, and `String(array)` is comma-joined
`[object Object]`, so a useful `toString` would mean handing back a custom array-like — a live object with
behaviour, which is what the Python-parity decision rules out and what the rejected String wrapper above fails on
for the same reasons. Two plain values cost nothing: an array and a string, both JSON-shaped, both trivially a
`list` and a `str` in Python, and neither needing a new kind in the dialect's deny-by-default `kindOf`.

**The format is part of the contract, which is what answers the objection to text above.** The complaint there was
that a regex over RENDERED output matches the presentation rather than the facts; this is not the presentation.
`housekeepingText` is the UI renderer, with column widths and marks, and is explicitly not this. `logText` is a
specified serialization — one record per line, `<iso-ts> <subsystem> <kind> [reason] [k=v …]`, fields separated by
a single space and NEVER padded, because padding a model-facing string is pure context cost (AGENTS.md). It is
generated from the records by one pure function, so the two cannot drift, and a test asserts that every record
appears in the text with its `kind` intact.

The array is already bounded — `PER_RUN_CAP` records per run — so "the whole log" is a known, small quantity and
`slice(-n)` is the only recency control needed. If a model wants the human rendering (to quote it in an answer), it
builds that from the records; `housekeepingText` is a UI renderer with marks and column widths and is not part of
this contract.

## The kernel variable inspector shows the same objects

The right-dock "kernel state" panel — the unbuilt half of the pair whose other half is the execution log
([`../dev/run-log.md`](../dev/run-log.md)) — is a VIEW of this shape, not a second description of it. One surface reads it as data, the other draws it. That has a
consequence for the contract: every value here must be plainly serializable and renderable, which is another reason
the shape is JSON-shaped data plus explicit calls, with no getters that do work and no live objects.

## Python parity constrains the shape, not the bridge

The same interface must be expressible in Python; how it crosses does not matter. In practice that rules out:
getters that look like properties but perform I/O, Proxies, array methods AS the API, and any distinction between
`undefined` and `null` carrying meaning. `ml.current.messages` is a list of dicts; `ml.current.meta(id)` is a
function. Absent is one value, spelled one way.

## A large message is CAPPED, and its full text is a separate ask

The system prompt is the case that forces this — around 3.2k tokens, re-sent every turn, the largest single thing
in the context and the one the model can least act on. It appears in `messages`, because it IS in the context and a
list that omitted it would make every total wrong. But its `content` is CAPPED, with `truncated: true` and the real
`tokens` beside it, and the full text is a separate explicit call:

```js
ml.current.messageText(id); // the whole thing, when you actually want it
```

The rule is by SIZE, not by role: any message over the cap is treated the same way, because the system prompt is
not the only large thing in a context — a screenshot-bearing tool result or a fetched page is — and a rule keyed to
"is this the system prompt" is a special case that the next large thing walks straight past. The cap itself is the
one the repo already applies to model-facing output (`resolveOutputCap`, contract-pointers.ts) rather than a new
number.

**Considered and rejected: a String-like wrapper** whose `toString()` shows the first N characters and which needs
`.toFullString()` for the rest. It is a tidier idea at the call site and it loses on three counts. It is a live
object with behaviour, which is exactly what the Python-parity decision rules out — it crosses as neither a string
nor a dict, and the Python half would need a bespoke class to match. It needs a new kind registered in the
dialect's `kindOf` plus an allowlist entry, and `kindOf` defaults to deny, so it is a dialect extension owing
adversarial tests rather than a data shape. And it protects the wrong path: a model is most likely to spend its
context by serializing, and `JSON.stringify` unwraps a String object to its full primitive, so the protection would
be absent from the one route that actually costs. A cap plus an explicit fetch is the same affordance — you have to
ask for the spam — as plain data, with none of that.

## What it must never expose

Reading messages the model already has adds no information, which is what makes this safe — so the invariant is
exactly that: **nothing here may return anything the running model was not already given.** No other session's
messages, no configuration the page cannot read (`MlConfig`'s omissions are a security boundary), no credentials.
Outside a run it throws, because there is no run to be the subject of "current".

## What can be added later, and what cannot

Leaving a field out is only safe if adding it later is. The split:

**Additive, so it can wait.** A new key on `meta`; a new member on `ml.current`; a new `tokensBasis` value. `meta`
is derived, read-only, flat JSON, so a later key cannot collide with anything a model wrote against the earlier
shape, and nothing has to be versioned for it.

**Not additive, so it has to be right now.** Message ids and their check character; whether a write to `messages`
throws or is absorbed; `meta` being synchronous; and the snapshot being consistent. Each of those is a property a
model's code depends on structurally rather than a value it reads, and changing one later breaks scripts that were
correct when they were written — which is the whole reason this document exists before the implementation.

## What it owes before it ships

Adding a surface to the read-only dialect triggers the rule in AGENTS.md, and the halting half is the one that bites
later rather than now:

- **Adversarial**: can a row reach a live method, a realm, or `constructor`? Can an id be forged to read another
  run's or another session's messages? Does anything leak the system prompt's resolved secrets?
- **Halting**: a loop over `messages` is bounded today because the array cannot grow. That argument dies the moment
  the write half lands — `for (const m of ml.current.messages) ml.current.drop(m)` is the `Set`/`Map` mutator bug in
  a new costume — so the halting tests are written NOW, against the read-only shape, and re-run against the first
  mutation.
- **Failure**: a script that reads `ml.current` and then falls out of dialect leaves nothing behind.
- **Copy semantics.** The depth rule is already asserted against the real dialect, for every route into it
  (`tests/readonly-exec.test.mjs`, "ownership is ONE LEVEL deep"); what this still owes is the same assertions
  against `ml.current` itself once it exists — that a `messages` row refuses a write, that a `meta(id)` record
  accepts one and reaches nothing, and that neither can be reached around through a shallow copy.

## Open

- ~~`meta(id)` per message is N host calls~~ — answered by making `meta` SYNCHRONOUS over the snapshot the
  single `await` already fetched. N calls are then N lookups in the same realm, with no round trip, over an
  array whose length is fixed before the loop starts. That is cheaper than `ml.queryAll` inside a `.map`,
  which the dialect already allows and which does real DOM work per call. No bulk form is needed; adding one
  for convenience is what would need a budget in front of it.
- Nothing here says which messages the cap is ABOUT to drop. An earlier draft had a `dropsNext` field; it is
  out, because its semantics have not been looked at and a guessed field in a contract is the one thing this
  document is otherwise careful not to do. It is also the field that can most afford to wait: `tokens` +
  `tokensBasis` already let a model reason about size, and an eviction rule can be added once it is a
  decision rather than a hunch.
- How good the numbers under such a field would be is already a split question: the `counted` messages are
  exact, and the `estimated` ones — every user and tool message, so most of the context — are ~chars/4 with
  no tokenizer. An estimate is probably right for deciding WHAT to drop and wrong for deciding WHETHER to.
  `tokensBasis` is what makes that measurable at all rather than one number nobody can audit.
- Nothing is specified about a message arriving over the hub from a REMOTE runtime, where the context lives on
  another machine. The snapshot would have to cross a seal, and `LIVE_PREVIEW_CHARS` exists because that path
  already caps text once.
