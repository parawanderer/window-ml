# Spec: the model reads its own context (`ml.current`)

**Status: the READ half is built, not yet reachable** (written 2026-10-05; built 2026-10-06). The snapshot
(`current-context.ts`), the loop recording each message (`agent-loop.ts`, `contextSink`), the dialect reading it in
a WORKER realm (`readonly-exec.ts`) and the worker-side evaluator (`sw-readonly.ts`) exist and are tested
(`tests/readonly-current.test.mjs`). What makes it reachable is the host calling that evaluator first, in
`sw-run-host.ts`'s `tryReadonly`, which is the site-access work's slice 2. Until then no contract type is added (see
below). Where the build departed from the first draft of this document, the section says so and why.

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
ml.current.run        // { id, model, step, maxSteps, startedTs } — which run this is
ml.current.messages   // `NeutralMessage[]` VERBATIM — the exact array `ml.step()` takes
ml.current.meta       // a PARALLEL array, same length and order: what we KNOW about each message
ml.current.log        // this run's execution log: records, carrying `.text` for ml.pipe
ml.current.debug      // { userWatches: [{ expression, value | error, at }] }: watches the person shared (worker-hosted runs)
```

Five decisions make it survive the write half. Each is the non-obvious choice.

### 1. `ml.current`, not `self.current`

`self` is on the dialect's DENIED identifier list, beside `window`, `globalThis`, `parent` and `top`
(`DENIED_PROPS`, `readonly-exec/policy.ts`), because `self === window`: it is a realm escape in every other JavaScript context. Giving that
one name a second, safe meaning inside the dialect is a trap for everyone who reads or extends it afterwards, and it
would mean the deny list no longer reads as "these are the ways out".

`ml` is already the run-bound facade. `ml.answer` curates the run's answer set and `ml.dereference` reads a `@tool:`
pointer, both resolving against *the run currently executing a tool* and both throwing outside one (`tool-exec.ts`).
`ml.current` is the third member of a family, not a new concept — and it inherits the sentence that matters:
**the binding, not a permission check, is what scopes it.**

It also unifies with the Python half: the standing idea is a run-bound `ml` facade inside Pyodide, and `ml.current`
is then the same name reaching the same thing from both languages.

### 2. Stable ids, from day one — but in `meta`, never on the message

Array position is the obvious address and the one that breaks under mutation: drop message 3 and every index a
model is holding means a different message, silently. So an id exists from the start, minted the way `@tool:` ids
are (`token-id.ts`: payload plus a check character), and a stale or hallucinated one fails the check rather than
addressing a real message by accident. Retrofitting an address later is a breaking change to a contract the model
has already learned.

It lives in `meta[i].id`, NOT on the message. An earlier draft put it on the row, which was the one place derived
data leaked into the wire shape — and decision 3 exists to stop exactly that. Within a snapshot the index IS a
valid address, because the snapshot is one instant; the id is what carries identity ACROSS a filter, a later read,
or a mutation, which is the only thing position cannot do.

### 3. `messages` is the wire; `meta` is what we know — and they stay apart

`ml.current.messages` is `NeutralMessage[]` and nothing else: the same objects `ml.step(messages)` takes and
`ml.agent`'s own loop holds, with no field added, nothing capped and nothing renamed. A doctored copy would be
worse than no copy — a model reasoning about its context from a report ABOUT it is wrong in ways it cannot detect,
and code written against the doctored shape would not fit the function that consumes the real one.
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
const i = await ml.info();  i.compute = {};        // OK — the facade built this value for this call
const c = { ...i };         c.mine = 1;            // OK — the copy is the script's own object
c.compute.supported_gpus.push(x);                  // REFUSED — the spread carried it by reference
JSON.parse(JSON.stringify(i)).compute.a.b = 1;     // ALSO REFUSED — own() does not recurse, for any source
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

`ml.current.meta` is the opposite case and gets the opposite treatment: a fresh array per read, which the
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
lands in it. A survey over three hundred records costs whatever the model chooses to return.
Anything genuinely large is addressed rather than copied, through the value store and a `@tool:` pointer, which is
the machinery that already exists for exactly this.

## It is all RESOLVED UP FRONT, so the whole facade is synchronous

Every member is a plain value — two arrays, a record and a string. Nothing here is a call, nothing returns a
promise, and nothing needs an `await`.

That follows the house pattern rather than inventing one. `@tool:` pointers are resolved before a line of the
script runs — the macro pass is lexical, so every handle the source mentions is known in advance, `exec` awaits
them all in one `Promise.all` before evaluating, and `ml.dereference` is "an ordinary synchronous read for the
duration of the call" (`pointer-macro.ts`). The reason given there is the one that applies here exactly: a model
that writes `@tool:abc.length` gets a length, where against a promise it would get `undefined` and no error —
"which is exactly the plausible-wrong-answer shape this codebase keeps designing out". `ml.current.messages.length`
on a promise is that same silent `undefined`.

**Where it is read: in the WORKER, never evaluated on the page.** The first draft resolved the snapshot up front and shipped it
to the page, where a delegated `exec` ran, and scanned the source per member so as not to put the context on the wire
for nothing. The site-access work showed why that was wrong rather than merely costly: the page is the realm a
hostile site controls, and a read-only survey auto-approves, so a prompt-injected one would carry the run's whole
context (other origins' content, the system prompt) into it with no human asked. So a survey is evaluated in the
service worker FIRST, where the context is local and nothing crosses at all, and only a survey that reaches for the
page is retried there. The two realms have disjoint capabilities (`docs/dev/readonly-exec.md`, "Two realms"):

- the worker has the run's context and no page: any route to the page raises `NeedsPage`, and the host retries there;
- the page has the DOM and no run context: `ml.current` is a refusal there (not `undefined`, which would make a mixed
  survey evaluate to a plausible wrong answer);
- so a survey that needs both is refused on both sides and reaches the human, whatever order it touches them in.

**What that does NOT do, measured (2026-10-06, `demo/ml-current-e2e`).** It keeps the snapshot from being EVALUATED in
the page, and the page is never asked to run a survey that reads the run. It does not keep a survey's RESULT off the
page: what a survey returns is a tool result, and goes where every tool result goes, which today includes the debug
stream relayed through the page's own window (`__mlDebug:agent-step`, carrying the panel's copy, not just the model's
500 characters) in every `debugMode`, and the run's response to a page that started the run. A prompt-injected survey
returning `ml.current.messages.map(m => m.content).join()` is a plain string, so the print boundary does not touch it.
The same channel carries every other tool result already, so it is not new here; closing it is the site-access work's,
and until it is closed this realm is a necessary half, not the whole protection.

**What the snapshot carries** is the real messages, bodies included, because that is the point (decision 3), as a
COPY made when the survey runs, so nothing a script does reaches the loop's own array. The copy is made only for a
script whose source says `current`. That is a cost decision and nothing more: a script that reaches the member by a
computed key finds it absent, which in the worker defers to the page, where it is refused, so it reaches the human.

Combining the two is then the obvious code, and works inside a callback because everything is sync — the dialect
allows a sync read inside a `.map`/`.filter` and refuses an async one (`tests/readonly-exec.test.mjs`), so this
distinction is what decides whether the natural join runs or escalates to a human:

```js
const meta = ml.current.meta;
const stale = ml.current.messages
    .map((m, i) => ({ m, meta: meta[i] }))            // zip by index: same length, same order
    .filter(x => x.meta.tokens > 500 && x.meta.ageMs > 10 * 60_000)
    .map(x => `${x.meta.id} ${x.m.role} ${x.meta.tokens}t ${Math.round(x.meta.ageMs / 60_000)}m ago`);
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

| field | why it is there |
| --- | --- |
| `id` | the STABLE handle (decision 2), minted like a `@tool:` id with a check character. It lives here rather than on the message because the message is the wire shape and nothing derived belongs on it; within a snapshot the index already addresses a row, and this is what carries identity across a filter, a later read, or a mutation |
| `ts`, `ageMs`, `gapMs` | wall clock; how long ago that was, at the snapshot's instant; and the GAP since the previous message (a long one is someone going away between turns). Pre-computed, since a model doing arithmetic on two stamps pays tokens to get it slightly wrong. The first draft had one `sinceMs` that its table defined as the gap and its own example used as the age; these are both, under names that cannot be confused. Null for history carried in from an earlier turn, whose moment of arrival is gone |
| `surface` | where a user message was typed (`PromptSurface`, contract-run.ts) and what that implies: whether anyone can see the page. Already recorded per message |
| `tokens`, `tokensBasis` | the size of THIS message — what compaction would actually reclaim — and WHICH KIND of number it is: `counted` where the engine's count measures it, `estimated` where nothing did and it falls back to ~chars/4. The precedent is `RunStats.genBasis`, which carries the same distinction for timing "so a surface can be honest about what the rate measures"; a bare number here would be read as counted, and usually is not. **Counted only when the turn produced no reasoning**: the completion count is the whole generation, reasoning included, and reasoning is not re-sent in history, so for a thinking model it would overstate what compacting the message reclaims. A model whose reasoning is hidden entirely cannot be told apart and is counted |
| `images` | how many images the message carries, which `tokens` does NOT include: an image's cost depends on the model, and estimating a data URL by its characters would be wrong by orders of magnitude. Added in the build |
| `step`, `seq` | which step produced it, so a message joins up with the transcript, the exports and a `@tool:` pointer |
| `tool` | the tool a tool-result message came from |
| `truncated` | whether the tool output in this message was ALREADY cut before the model ever saw it (`resolveOutputCap`), so it does not reason about an ellipsis as though it were data. Nothing in `ml.current` cuts anything — this records a cut that happened upstream |

## The log

`ml.current.log` is the model-facing read of the execution log (`run-log.ts`, `docs/dev/run-log.md`), merged here
because it answers the same kind of question: what happened to me that my transcript does not say — the tab that
was discarded and reloaded, the CDP attach that was refused. The gate and the hazards are already written in that
document and are not re-decided here.

It is resolved up front and read synchronously like everything else on `ml.current`, and it is the clearest case
for scanning PER MEMBER rather than for the facade as a whole: a script that wants message times has no use for the
log, and one that wants the log has no use for the message table. Both are capped — `PER_RUN_CAP` records, N small
message records — so either is cheap to ship and neither should be shipped to a script that never names it.

**It is an array of RECORDS, not rendered text.** Each is the log's own record, narrowed to what a model can act on
— `ts` (the log's `t`, renamed so a time is spelled one way across `ml.current`), `subsystem`, `kind`, `reason`,
`detail`, with null for an absent one — and never `key`, which the housekeeping log withholds from a page that did not
report the event, nor `tab`/`origin`, which say who REPORTED it. Filtering is ordinary dialect code and needs no
query language and no new methods:

```js
const log = ml.current.log;                        // plain data, like the rest of the facade
log.slice(-20)                                     // the last twenty
log.filter(r => r.subsystem === "page")            // one subsystem
log.filter(r => r.kind === "discarded" || r.kind === "unreachable")
log.filter(r => r.ts > Date.now() - 60_000)        // the last minute
```

Records rather than a string, for three reasons. The dialect's array methods are already there, so a string would
mean inventing a grep where `filter` exists. A regex over rendered text would match the rendering — the column
layout and the human wording — rather than the facts, so the log's presentation could not change without breaking
scripts written against it. And `kind` is a closed vocabulary that the log's own sanitizer enforces
(`sanitizeRunReport` silently drops a record whose `subsystem`/`kind` is not a lowercase slug), which is exactly
what makes an equality filter reliable and a substring search a guess.

### The text form travels WITH it, as `log.text`

`ml.current.log` is one member, not two. It is an array of records that also carries `text`: the same log as
greppable lines, generated from those records by one pure function at snapshot time, so there is nothing to keep in
sync and no second member to discover.

```js
ml.current.log.filter(r => r.kind === "discarded")      // records, for deciding
ml.pipe(ml.current.log, "grep discarded | tail -20")    // text, for scanning
```

Both of those work, measured rather than assumed. The second needed one change, and it was not where this document
first said: `ml.pipe` was not in the read-only dialect at all, so the claim that it "works today" was wrong. It is now
(#375, under bounds of its own), and nothing about the log had to change for it:

- `Array.isArray` is true, and the dialect decides kinds STRUCTURALLY rather than by constructor
  (`kindOf`, `readonly-exec/policy.ts`), so it is an ordinary Array there: `filter`/`slice`/`map` are allowed, it is a writable
  target, and no new kind has to be registered in a `kindOf` that defaults to deny. That is what keeps this a data
  shape rather than a dialect extension owing its own adversarial tests.
- `mlPipe` already unwraps an object carrying a `.text` string — that is what "or a fetch result" means in its
  error — and it reads that BEFORE its array check, so an array with a `text` property pipes while a bare array
  still throws the same steering error it throws today.

In Python the same thing is a `list` subclass with a `text` attribute (and `__str__` returning it), which is
ordinary there — so the earlier claim that parity ruled this out was wrong twice over, and this is the shape that
makes the point moot rather than argued.

**The principle, since it is the second time this has come up:** two members for two different things (`messages`
is the wire, `meta` is what we know about it — and they must not merge, decision 3), one member for two VIEWS of
the same thing. `log` and `logText` were the second case dressed as the first.

The array is already bounded — `PER_RUN_CAP` records per run — so "the whole log" is a known, small quantity and
`slice(-n)` is the only recency control needed. If a model wants the human rendering (to quote it in an answer), it
builds that from the records; `housekeepingText` is a UI renderer with marks and column widths and is not part of
this contract.

## The kernel variable inspector shows the same objects

[`STATE_INSPECTOR.md`](STATE_INSPECTOR.md) is that panel's spec. It adds members to this shape (`init`, `input`,
`pointers`, `subagents`, `debug.userWatches` and others) and gives every member an AUDIENCE. A `model` member is in
`ml.current`. A `human` member (the mailbox, today) is in the panel only, because this document's invariant forbids
the model anything it was not already given.

The right-dock "kernel state" panel — the unbuilt half of the pair whose other half is the execution log
([`../dev/run-log.md`](../dev/run-log.md)) — is a VIEW of this shape, not a second description of it. One surface reads it as data, the other draws it. That has a
consequence for the contract: every value here must be plainly serializable and renderable, which is another reason
the shape is JSON-shaped data plus explicit calls, with no getters that do work and no live objects.

## Python parity constrains the shape, not the bridge

The same interface must be expressible in Python; how it crosses does not matter. In practice that rules out:
getters that look like properties but perform I/O, Proxies, array methods AS the API, and any distinction between
`undefined` and `null` carrying meaning. `ml.current.messages` and `ml.current.meta` are both lists of dicts. Absent is one value, spelled one way.

## The spam problem is solved at the PRINT boundary, not in the data

The system prompt is the case that forces this — around 3.2k tokens, re-sent every turn, the largest single thing
in the context and the one a model can least act on. An earlier draft capped it inside `messages` and put the full
text behind a separate call. That was the wrong trade: it is decision 3 again, and losing it costs more than the
spam does. A model reasoning about its context from an abridged copy is wrong in ways it cannot detect, every total
it computes is off by the part that was removed, and `ml.step(ml.current.messages)` stops being a thing that works.

So `messages` is complete, and the abridging happens where the cost actually is. **Holding the context costs
nothing; PRINTING it is what spends tokens**, because `console.log` from `exec` is what reaches the model as the
tool's result. `console.log(ml.current.messages)` therefore renders abridged — per message the role, the size, and
a short preview — and anything a model wants in full it prints by naming it
(`console.log(ml.current.messages[0].content)`), which is an explicit act over honest data rather than a shape it
was handed.

That is the house pattern rather than a new one: `IMG_PREVIEW_CHARS` (token-pipe.ts) shows "enough to identify the
media type, far short of flooding the context" of a base64 image, and the output caps (`UI_OUT_CAP`,
`resolveOutputCap`) bound what a tool result carries. All of them cut at the boundary where text reaches the model,
none of them change the value underneath.

**A view must say it is one.** Every print that differs from the value carries a note saying exactly what was
replaced, in JSONPath relative to what was printed (`$[0,3].content REPLACED by virtual $[0,3]['chars','preview',
'abridged']`), placed after any clip so the cut cannot remove it. The note is generated from a diff of the printed
object against the value, never written by hand, so a later substitution cannot ship without one. A reader is told
only about the part it received (a note about a row past the model's cut would describe something it never saw), and
a note stays one line however many places it covers (runs become RFC 9535 slices; past eight places it names the
first and gives the count).

It also generalises where a cap on `messages` would not. The rendering is keyed to SIZE, so a screenshot-bearing
tool result or a fetched page abridges the same way the system prompt does — and a rule keyed to "is this the
system prompt" is a special case the next large thing walks straight past.

**Considered and rejected: a String-like wrapper** whose `toString()` shows the first N characters and which needs
`.toFullString()` for the rest. Not because Python could not express it — it could, with `__str__` on a `str`
subclass, and the same objection was made and withdrawn for the log. Two things that do hold: a value that is a
string AND carries behaviour needs a kind registered in the dialect's `kindOf`, which defaults to deny, so it is a
dialect extension owing adversarial tests rather than a data shape; and it protects the wrong path, since
`JSON.stringify` unwraps a String object to its full primitive and serializing is how a model actually spends its
context. Abridging the PRINT has neither problem, because it touches no value at all.

Note the difference from `log.text`, which IS a wrapper of a sort and is kept: that one adds a property to an
ordinary Array, so it stays structurally a plain value the dialect already understands. A String subclass is not
structurally a string in the same way, which is the line between the two.

## What it must never expose

Reading messages the model already has adds no information to the MODEL, which is what makes this safe on that side
— so the invariant is exactly that: **nothing here may return anything the running model was not already given.** No
other session's messages, no configuration the page cannot read (`MlConfig`'s omissions are a security boundary), no
credentials. Outside a run it throws, because there is no run to be the subject of "current".

That argument is only half of it, and the first draft stopped there. From the PAGE's side the context IS new
information: a run that read a banking site and then works on another one carries the first one's content, and the
page it is on now is not entitled to it. That is why it is read in the worker and refused on the page (above), and it
is the same rule the site-access work applies to `@tool:` reads. It is also why the debug channel matters (above):
evaluating in the worker protects the snapshot, and only closing that channel protects what a survey returns.

## What can be added later, and what cannot

Leaving a field out is only safe if adding it later is. The split:

**Additive, so it can wait.** A new key on `meta`; a new member on `ml.current`; a new `tokensBasis` value; a new
VIEW on an existing member, the way `text` sits on `log`. `meta` is derived, read-only, flat JSON, so a later key
cannot collide with anything a model wrote against the earlier shape, and nothing has to be versioned for it.

**Not additive, so it has to be right now.** Message ids and their check character; `messages` being the verbatim
wire shape rather than a report about it; whether a write to `messages` throws or is absorbed; the facade being
plain data rather than promises; and the snapshot being consistent. Each of those is a property a
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
- **`log` is both things at once**: `Array.isArray` holds, `filter`/`slice` run in the dialect, `ml.pipe` reads its
  `.text` without a change to `mlPipe`, a BARE array still throws `mlPipe`'s steering error, and the text is
  derived from the records by the one pure function so a record cannot be missing from it.
- **The print rendering**, since it is now the only thing standing between a model and its own context twice over:
  that `console.log(ml.current.messages)` abridges, that naming one message's `content` prints it whole, that the
  rule is by size rather than by role (a large tool result abridges like the system prompt), and that the VALUE is
  untouched — `ml.current.messages[0].content.length` is the real length whatever the print showed.
- **Copy semantics.** The depth rule is already asserted against the real dialect, for every route into it
  (`tests/readonly-exec.test.mjs`, "ownership is ONE LEVEL deep"); what this still owes is the same assertions
  against `ml.current` itself once it exists — that a `messages` row refuses a write, that a `meta` record
  accepts one and reaches nothing, and that neither can be reached around through a shallow copy.

## Open

- ~~`meta` per message is N host calls~~ — answered by making the whole facade plain data, resolved up front.
  There are no calls at all: `meta[i]` is an array index in the same realm, over an array whose length is fixed
  before the loop starts. That is cheaper than `ml.queryAll` inside a `.map`,
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
- **The wiring.** The host calling `evalReadonlyInWorker` first, and handing the worker's `ml` a `dereference`, is the
  site-access work's slice 2. The contract type, and with it `agent_api_docs`, lands with that, not before.
- Nothing is specified about a message arriving over the hub from a REMOTE runtime, where the context lives on
  another machine. The snapshot would have to cross a seal, and `LIVE_PREVIEW_CHARS` exists because that path
  already caps text once.
