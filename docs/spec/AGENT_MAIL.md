# Agent mail: a queryable inbox agents address without a human in the middle

Parked design, 2026-10-04. Nothing is built. Written by the session that spent a day being the failure mode, so
every claim below has a dated example behind it rather than a guess about what agents might want.

Sub-topic of the subagent / local-execution / cross-device coordination work: see `HEADLESS_AGENTS.md`,
`REMOTE_TOOL_EXECUTION.md` and the three-modes frame in the memory `idea-async-three-modes`.

## The problem, as it actually presents

On 2026-10-04 four sessions worked this repo at once. Every message between them went: one session writes
`tmp/<something>.md`, tells the human, the human forwards it, the other session reads it and writes
`tmp/<something>-answer.md`, the human forwards back. The human is the transport, and the complaint that started
this was theirs: *"I don't want to read their markdown slop or figure out who owns things. I also don't want them
spamming up the disk."*

What the sessions were actually doing, each of which is a missing primitive:

| Observed | The primitive |
| --- | --- |
| Addressing "the hub session", "the `feat/notifications` session" — nicknames invented per conversation | identity |
| The human asking *"Is this for you?"* about a note neither of us could place | routing |
| *"Did you read this?"* about a doc I had read but only acknowledged | read state, per reader |
| *"this needs to be forwarded to somebody else"* | rejection / re-routing |
| Reading a forwarded note without blocking on it | asynchronous delivery |
| `handover-X.md` → `X-answer.md` → `reply-X.md`, related only by filename | threading |
| A notice listing files about to be split, asking anyone affected to speak up | a claim, with a lease |
| Re-reading a whole document to find what changed | a cursor, not a timestamp |

**The filename convention is already the schema.** `inbox-bounds-reply3-from-notifications.md` decomposes exactly
into `topic=inbox-bounds`, `kind=reply`, `seq=3`, `from=notifications`. Four sessions converged on that shape
without coordinating. The data model is therefore discovered rather than designed, which is the best evidence
available that it is the right decomposition.

## The shape: a table, not a mailbox

**Not a CLI.** The deliverable is an object a model writes its own loops over, the same way `window.ml` is the
deliverable rather than a chat app. This repo already has exactly one representation for "a collection a model
writes loops over", and it is `TableLike` + the read-only facade (`contract-fetch.ts`, `table-data.ts`).

If the inbox IS one, these come free rather than being built:

- **`exec` loops.** `.filter`, `.map`, `for…of`, and (since 2026-10-04) `let n = 0; n += 1` for tallies, all
  already in the read-only dialect. Reading your own mail spends nothing and changes nothing, so the read belongs
  in `ML_READONLY_METHODS` for the same reason `ml.ps` and `ml.config` do: no approval prompt.
- **`python_exec`** gets it as a dataframe through the existing `tables` bridge, with no second API.
- **The chat page** renders it with the table view that already exists.
- **`@tool:<id>` pointers** can cite one message, so an agent quotes rather than pastes.
- **The stored-table split** (`isStoredTable`, reads that are requests) already handles an inbox too large to
  carry inline — which a long-running account will have.

So the tool surface is genuinely one tool — read one message — and everything else is a loop over an object.

## Delivery: the path exists, and a note says not to build a second one

The memory `idea-async-three-modes` names agent-to-agent push as **mode 2, the gap**, and records the machinery:
`runInboxes` (sw-runs.ts) is already a per-run mailbox that `a.say()` steering lands in, and `INJECT_MESSAGE` is
already the turn-boundary injection path. Its instruction is explicit: *"Do NOT build a second delivery path."*

Mail is that mailbox with a predicate in front of it. The wake arrives at a TURN BOUNDARY, never as an interrupt
into a live generation, and never as a poll — a tool call per turn to check for mail is a token tax on every turn
that has none.

## Routing, and the queue for what cannot be routed

Three resolvers, tried in order, because the sender often does not know the answer — on 2026-10-04 a note about an
idle-connection measurement reached a session that had never run one, and only a human could say so:

1. **Addressed** — `to: <agent>`, when the sender knows.
2. **Topic** — every message carries one; agents subscribe. This is the common case and matches the filenames.
3. **Scope** — agents declare what they hold (paths, branches, subsystems); the system matches a message's subject
   against those declarations.

All three route on the MESSAGE. On 2026-10-19 (six sessions, three models) most routing was on the RECEIVER: work a
Claude session must not do (reading the sandbox lockdown trips a safety classifier) went to a different model; a
security review went to any session except the one that wrote the code; a red-team pass went to the session that had
NOT built the defence. So a message, and a work order in particular, carries a constraint on who may take it, in
terms the system can check: the receiver's model or trust class, and `not: <lineage>` for "anyone but the author".
A claim that fails the constraint is refused, not queued.

A message none of the three places goes to an **unrouted queue that the human owns** — and that queue already has
a UI. `src/chat/attention.ts` is "what needs someone's hand", with levels, fixes, dismissal and a phone surface. An
unrouted message is an attention item. Human routing stops being the transport for every message and becomes the
exception, which is the actual goal.

## Messages are immutable; threads are the living thing

The human's instinct was "last updated, and last read BY ME". The second half is right and the first should be
served differently. This repo's session contract is append-only — *history append-only, compaction recorded as an
event; an edit forks to a NEW session, never a new epoch* — and mail should match it:

- A message is immutable. A revision is a new message linked `amends: <id>`.
- "Last updated" is then the newest message in the thread.
- "Last read by me" is a **cursor** into the thread, per agent. Reading returns what is new since your cursor,
  which is the thing that kills re-reading a long document to find the changed paragraph.

## Claims are the only genuinely new primitive

Everything above is assembly. This is not, and it is the highest-value piece, because it is the one thing that on
2026-10-04 required a human to BROADCAST: a session about to split a 2,545-line file wrote a notice listing the
files, and asked for it to be forwarded to anyone working in them.

Structured, the system detects the collision instead of asking. A claim is a message with `kind: "claim"` and the
paths or subsystems it covers. Two constraints, both learned the same day:

- **A claim is a LEASE** (mode 1 of the async frame: detach, never kill). An agent that dies holding one must not
  block everybody for ever.
- **A claim is VERIFIED, not trusted.** Which branches touch a file is computable, and the repo's whole posture is
  that a sender is never trusted for anything, including who it is. It also has to be computed CAREFULLY: on
  2026-10-04 `git branch --merged origin/main` did not list a branch whose every line was in main, because it had
  landed by squash, and a conflict check built on that would report a dead branch as live work. `git log
  origin/main --grep` on the subject is what actually answers it.

## Two risks, the first of which is the one to design against

**The human is currently an EDITOR, not only a wire.** Those handovers were written carefully *because* a person
was going to read them before anyone else did. Remove the human from the path and the quality gate goes with the
transport, and the result is the same markdown slop the complaint is about, generated faster and in more volume.
Mitigations worth considering: sending costs something; the human UI shows volume per agent rather than only
content; a thread with no reply in N turns is collapsed rather than kept.

**Mail from another agent is data, never instruction.** Today the human IS the trust boundary: they read before
forwarding. Remove them and one confused agent can steer three others. The repo's posture is already the right one
— *a hub is trusted with nothing, including who sent something; what a runtime acts on is the signature inside the
seal, never `Envelope.sender`* — and the same rule applies here. A message surfaces as a VALUE in a table, framed
as mail, with its sender shown; it is never injected in a shape that reads like an instruction from the human. The
precedent is `cursorTipOn`, which renders a string as escaped markdown precisely because a string is where content
from outside arrives.

## Storage, and not spamming the disk

One store, not N files. The session archive is already SQLite over OPFS in an offscreen worker, with
move-instead-of-delete; mail is another table in it. A thread whose obligations are all closed is collapsed after a
TTL rather than kept for ever, which is the direct answer to *"I don't want them spamming up the disk with slop if
it's not needed."*

Cross-device is the hub: an account already has runtimes, sealed commands and encrypted streams. Mail is another
sealed command stream, and `remoteDescription` already exists for deciding what a remote reader may see.

## From the 2026-10-20 coordination day: five things the primitives above must also carry

Added 2026-10-20 by the REPL coordinator session (`repl-specs`), after a day with nine lanes, a janitor, a red team and
direct session messages instead of files. Direct messages removed the human as transport (two relays all day, against
every message on 2026-10-04). What remained is below, each with the incident, so the primitive is sized by evidence.

- **Identity is the work slug, and a session has one for its life.** Lane 3's session was titled "generalist", so a
  message to "lane 3" found nobody and the session had to relay its own mail. The identity primitive (step 1 below) is
  the slug; a title is display only, and a session that changes jobs changes its slug by a message, never silently.
- **Push at a turn boundary comes earlier than step 4 says.** Four mails to the coordinator sat two hours unread until
  their author nudged it, with one reader who was looking. Pull-only failed with the most attentive reader there is;
  the cursor is necessary and not sufficient.
- **A result is a message carrying a value, never a file in another session's tree.** Lane 9 wrote its result file
  untracked into the coordinator's clone. A session writes only inside what it holds a lease on (next), and a result
  travels as the session contract's remote tool result: a preview plus a pointer.
- **Claims extend to disk: a clone, a build tree and scratch are leased resources.** Lane 5's four Pyodide build trees
  took the machine to 8.7 GB free and the janitor could not touch another session's clone. A session declares its
  scratch roots as a claim with a lease; the resource panel shows disk per session; an expired lease is reapable by
  the janitor with the "nothing unpushed" check COMPUTED by git, the way a claim is verified above, never trusted.
- **Closing a session is releasing its leases.** Closing lane 4 took a message, a result file, a clone check its
  harness refused, and the person's hand. With a work order (session contract, "what makes delegation work") and
  leases, "closed" is a computed state: result delivered, every lease released or reaped. The work order gains a field
  for what the session leaves behind.

Two things deliberately not added from that day: peer messaging as a general facility (every message had one owner and
one obligation, and point-to-point was enough), and any tool that merges for a peer (each time, the person's hand was
the right answer; see "the human is an editor" above).

## From 2026-10-21: a session's state is a fact the harness computes, never a word the model writes

Added 2026-10-21 by the same coordinator session, after a morning in which the peer listing's `busy`/`idle`/`waiting`
was the only state visible and was wrong or empty each time it mattered. Shane's ruling the same day: this is built in
window.ml, not patched into the commercial tool, since window.ml is where the coordination moves once it is finished.

The three incidents, each a state the listing could not express:

- **"waiting" said nothing.** The janitor sat in `waiting` for an hour after an offer was sent to it. From outside that
  was any of three things: the message held for the person's approval (a different permission mode), a permission
  prompt on a tool it had already started, or a question it had asked the person. The coordinator told the person to
  go and look, which is the system failing at the one thing it is for.
- **A false "done" that a state would have made impossible.** Lane 3 reported a fork branch deleted, then corrected
  itself: its own permission check had refused the push. A state of "blocked on approval: `git push --delete`" makes
  the first report unwritable and the correction unnecessary.
- **Silence meant nothing.** A send promises a notice when the receiver holds or refuses the message. None came, and
  the receiver had not read it. So the absence of a notice does not distinguish "read and working" from "never seen",
  and the sender cannot act on it.

The primitive: **the one line of "what it is doing" in step 1 below is a computed state, not free text.** One of
`running`, `blocked: permission` (the tool and one line of the call), `blocked: question` (to the person), `holding
message from <slug> since <time>`, `idle since <time>`, `exited`; beside it, per message, a delivery receipt
(`held`, `read by the model at <time>`, `refused`) that the sender queries, so silence is never a signal. Every value
is produced by the harness at the moment it happens (a permission gate opening, a turn ending, a message dequeued) and
none is written by the model, so it carries no injection surface and needs no approval to read.

The transcript is a different thing and stays out of this, with ONE exception added 2026-10-27 (the person's own turns,
next section). The last message a session wrote is model text, an injection
surface for whoever reads it across sessions; the pending message is one the sender wrote and gains nothing by reading
back. Metadata about it (who, when, read or not) is enough. If the content is ever shown across sessions it is behind
the person's approval and rendered as data, and it is not built first.

## From 2026-10-27: what the person said to one session is a fact every session of theirs can read

Added 2026-10-27 by the same coordinator session, on Shane's request after a day in which the person was again the
transport, this time for their OWN words. Shane's framing of the requirement: collaborating agents should be able to
retrieve the user's messages from the other agent's history, so that one agent is never blocked on the person
answering in ITS window what they already answered in another.

The three incidents, each the same shape:

- **A ruling made in one window had to be made twice.** Shane ruled the parked lockdown widening in the security lane's
  session. It reached the coordinator as a model's sentence, "Shane ruled X", which the coordinator's own rule classes
  as unverifiable (a relayed instruction is model text: the relaying model may have misread, compressed or invented
  it). So the ruling went into the spec marked "relayed, to confirm", and Shane typed the confirmation a second time
  in the coordinator's window. The first utterance was authentic and sufficient; nothing could prove it.
- **A list of open questions, each blocked on one window.** The coordinator's checkpoint carried six decisions as
  "Shane's, outstanding" (a card string, a gate split, a fork-or-not, a button budget, two more), every one asked in
  the coordinator's window and answerable only there. Shane may have answered some to another session, or would have
  answered them from the phone; neither path existed.
- **"Shane asked for it" as a change's provenance.** A lane merged a doc change (#1148, the clone recipe) with the
  reason "Shane asked for it after my slip". True, and recorded only as the lane's sentence; a reader who wants the
  person's actual words has to find the right window's scrollback.

### The primitive: a person-turn is harness-attributed, so it is the one transcript content that crosses sessions

The 2026-10-21 section excludes the transcript because a model's text is an injection surface. The person's turns are
different in exactly the way that matters: the harness KNOWS which turns the person typed (they came from the input
box, not from a tool result, a cross-session message or a pasted block), and it attributes them at the moment they
are submitted. A model cannot write one. So a person-turn is a computed fact in the same sense as the 2026-10-21
state line: produced by the harness, never by the model, with no injection surface of its own and no approval needed
for the person's other sessions to read it.

The table, `ml.person` (a `TableLike` beside `ml.inbox`, read-only dialect, no prompt), one row per person-turn across
every session of the account on this machine (over the hub, every session of the account, sealed like any other
stream):

| Column | Meaning |
| --- | --- |
| `id` | the turn's id, stable, citable as a `@tool:` pointer |
| `session` | the slug and session hash it was typed into (step 1's identity) |
| `at` | when it was submitted |
| `text` | the TYPED text; a pasted block is carried as a pointer with a preview, never inlined (pasted content is where secrets and foreign instructions arrive; `SECRET_HANDLES.md`) |
| `answers` | the id of the ask it answered, when it answered one (next), else empty |
| `preceded_by` | a pointer to the model turn before it: metadata and a preview only, since that is model text, rendered as data |

Two reads cover the incidents: the turns in a session since a cursor (what did the person say to the security lane
today), and the turns that answer a named ask (did anyone answer MY question). A model's sentence "Shane said X" then
carries the row's id, and the receiver verifies by reading the row, exactly as a claim is verified by git and never
by trust. A relay without an id stays what it is today: unverified, recorded as relayed.

### Meaning is bound to the thread; authenticity is not permission

A person-turn from another session is an authentic record of what the person said. It is NOT, by itself, an
instruction to the reading session: "yes, do it" typed to the security lane answers the security lane's question and
nothing else. Three rules keep that straight:

- **A turn means what its thread means.** The reader acts on a turn from another session only when the ask it answers
  is one the reader itself registered, or when the turn names the decision in its own words (as a ruling in a spec
  names it). The `answers` and `preceded_by` columns are what make that judgement possible without reading the other
  session's transcript.
- **A turn never satisfies a permission prompt elsewhere.** A permission decision is the harness's gate event in the
  session that asked (2026-10-21, computed state `blocked: permission`); a person-turn in another session, however
  clearly worded, is not that event. This is the cross-session laundering rule, kept.
- **Rendered as the person's words, with provenance, never as the reading session's own user turn.** The row surfaces
  as a value (session, time, text), so the model sees "Shane, to the security lane at 14:34: …" and not a fresh
  instruction in its own input. The person's words are trusted; the framing still has to say which conversation they
  belong to.

### Asks: a question to the person is a row, answerable from any window

The blocking half of the problem is that a question lives only in the window that asked it. So a question a session
puts to the person is registered, not only printed: `ml.asks` is a table with one row per open question, `{ id,
session, at, decision (a slug naming what is being decided), text, options?, answered_by (a person-turn id) }`.

- **The person answers wherever they are.** The asks of every session are one list, surfaced through the attention
  inbox that already exists (`src/chat/attention.ts`, "what needs someone's hand"), on the phone included. An answer
  typed against an ask, in any window or on the phone, becomes a person-turn with `answers: <id>` and reaches the
  asking session as a push at its next turn boundary (step 4's path, `runInboxes`), framed as the answer to that ask.
- **An answer typed into another session's input box still counts**, when that session's model recognises it as
  answering a listed ask and links it (the link is the model's claim; the turn's text is the fact; the asking session
  reads the text itself). This is the 2026-10-27 case: the security lane's session would have linked Shane's ruling to
  the coordinator's open ask on the widening, and the coordinator would have read the words, not a paraphrase.
- **The listing shows open asks per session**, beside the computed state: "coordinator: 6 open asks, oldest 3 days",
  so the person sees what is blocked without opening the window, and a session whose asks go unanswered is visible as
  such rather than as "idle".
- **An ask is closed by its answer or withdrawn by its session**, never by another session; a withdrawn ask records why.

### What this does not do

- No model-written summary of what the person said stands in for the row. A session relaying a ruling cites the
  person-turn's id; the receiver reads the text.
- No turn is readable by anyone but the person's own sessions. The person is the one principal here; cross-device is
  the hub's sealed stream to the account's runtimes, and a shared or remote reader (`remoteDescription`) sees nothing
  of this table by default.
- No automatic action on an answer. The asking session receives the answer and decides; the push is a wake, not a
  command, like every delivery above.

### The interim, outside window.ml

Until step 1b exists, the commercial harness holds each session's turns in its own transcript file, and a read-only
script over those files (the person's turns of a named session since a time, by their `type` field, nothing of the
model's) would give the two reads today without patching the tool. Whether that interim is worth its own script, or
the day is better spent on step 1b, is Shane's call; the coordinator's rule meanwhile stays "relayed until confirmed",
with the cost above.

## What to build first

1. **Identity + the table + the read** — an agent declares a name, a session hash it already has, and its STATE
   (the computed line above, 2026-10-21; never free text). `ml.inbox` is a `TableLike` in the read-only dialect. No sending yet: this alone replaces
   "who owns this?" with a query. Proposed 2026-10-21 (Shane): the same row carries the PROCESS GROUPS the session
   registered with the desktop host, so "which session owns this CPU process" is a read of this table through the
   host's owner table ([`SHELL.md`](SHELL.md), the paragraph after "The boundary"), never of `ps`; open, a widening of
   the host's boundary that is Shane's.
1b. **Person-turns and asks** (2026-10-27): `ml.person` and `ml.asks` as read-only tables, written only by the harness
   (a turn on submit, an ask when a session puts a question to the person, the link when it is answered), and the open
   asks in the listing beside the state. Reads only, the same as step 1; it ends the person typing a decision twice and
   a session blocked on its own window. The answer's push rides step 4 when step 4 exists; until then the asking session
   reads the table at its next turn, which is already better than today.
2. **Claims**, with leases and git verification. The piece that removes a human broadcast.
3. **Send, with topics and the unrouted queue** wired to the attention inbox.
4. **Push at turn boundaries**, through `runInboxes`. Deliberately last: pull-only is useful, and a push path built
   before the shape settles is the one that gets built twice.
