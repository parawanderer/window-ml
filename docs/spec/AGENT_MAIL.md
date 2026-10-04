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

## What to build first

1. **Identity + the table + the read** — an agent declares a name, a session hash it already has, and one line of
   what it is doing. `ml.inbox` is a `TableLike` in the read-only dialect. No sending yet: this alone replaces
   "who owns this?" with a query.
2. **Claims**, with leases and git verification. The piece that removes a human broadcast.
3. **Send, with topics and the unrouted queue** wired to the attention inbox.
4. **Push at turn boundaries**, through `runInboxes`. Deliberately last: pull-only is useful, and a push path built
   before the shape settles is the one that gets built twice.
