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
- **What is about to go.** Which messages the context cap is closest to dropping, and how large each one is. That is
  the only question whose answer makes self-compaction actionable, which is why it is in the READ half rather than
  waiting for the write half.

## The shape

```js
ml.current.run                 // { id, model, step, maxSteps, startedTs } — which run this is
ml.current.messages            // the array the NEXT model call would receive, each row carrying a stable `id`
ml.current.meta(id)            // what we KNOW about that message; read-only, now and after mutation lands
ml.current.log                 // this run's execution log (run-log.ts), gated — see "The log" below
```

Four decisions make it survive the write half. Each is the non-obvious choice.

### 1. `ml.current`, not `self.current`

`self` is on the dialect's DENIED identifier list, beside `window`, `globalThis`, `parent` and `top`
(`readonly-exec.ts`), because `self === window`: it is a realm escape in every other JavaScript context. Giving that
one name a second, safe meaning inside the dialect is a trap for everyone who reads or extends it afterwards, and it
would mean the deny list no longer reads as "these are the ways out".

`ml` is already the run-bound facade. `ml.answer` curates the run's answer set and `ml.dereference` reads a `@tool:`
pointer, both resolving against *the run currently executing a tool* and both throwing outside one (`tool-exec.ts`).
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

### 4. It is read from the DIALECT, never from a tool that dumps

Reading your context into your context is a quine that grows. A tool returning the messages array would double the
context in one call, on the path whose whole purpose is usually to save it.

Inside `exec` (and later `python_exec`) the model's filter and slice run OUTSIDE the context, and only the result
lands in it. `ml.current.meta(id).sinceMs` over three hundred messages costs whatever the model chooses to return.
Anything genuinely large is addressed rather than copied, through the value store and a `@tool:` pointer, which is
the machinery that already exists for exactly this.

## What `meta` carries

First set, in rough order of how much a model can do with it. All of it is derived from events the run already has.

| field | why it is there |
| --- | --- |
| `ts`, `sinceMs` | wall clock, and the GAP to the previous message, pre-computed — a model doing arithmetic on two stamps pays tokens to get it slightly wrong |
| `surface` | where a user message was typed (`PromptSurface`, contract-run.ts) and what that implies: whether anyone can see the page. Already recorded per message |
| `tokens` | the estimated size of THIS message — what compaction would actually reclaim |
| `step`, `seq` | which step produced it, so a message joins up with the transcript, the exports and a `@tool:` pointer |
| `tool` | the tool a tool-result message came from |
| `truncated` | whether what the model was given was already cut (the output cap), so it does not reason about an ellipsis as though it were data |
| `dropsNext` | this message is nearest the context cap — the bridge to the write half, and useless to add later because it is the reason to act at all |

## The log

`ml.current.log` is the model-facing read of the execution log (`run-log.ts`, `docs/dev/run-log.md`), merged here
because it answers the same kind of question: what happened to me that my transcript does not say — the tab that was
discarded and reloaded, the CDP attach that was refused. The gate and the hazards are already written in that
document and are not re-decided here.

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

## What it must never expose

Reading messages the model already has adds no information, which is what makes this safe — so the invariant is
exactly that: **nothing here may return anything the running model was not already given.** No other session's
messages, no configuration the page cannot read (`MlConfig`'s omissions are a security boundary), no credentials.
Outside a run it throws, because there is no run to be the subject of "current".

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

## Open

- `meta(id)` per message is N host calls for N messages. Fine for a few hundred; a bulk form would need a budget in
  front of it rather than being added for convenience.
- `dropsNext` needs a real tokenizer to be exact, and today everything here estimates at ~chars/4. An estimate is
  probably right for deciding WHAT to drop and wrong for deciding WHETHER to — worth measuring before promising it.
- Whether the system prompt appears in `messages`. It is in the context, so including it is consistent; it is also
  the largest single thing there and the one the model can do least about.
