# Spec: the session contract, what a session source offers a client

**Status: agreed contract, version 1** (2026-09-17). The types are in [`src/session-host.ts`](../../src/session-host.ts);
this document is the prose and the reasons. The user-to-agent surface is final for version 1. The agent-to-agent parts
are typed and marked RESERVED: their shape is fixed so they can be added without a breaking change, but no runtime
offers them yet. The rules an agent tree needs that would break if changed later (transitive `started`, open
enumerations, idempotency keys, sender attribution) were settled on 2026-09-17, still in version 1; §Agent to agent.

## What it is

One interface, `SessionHost`, between a client that shows and drives sessions and a source that has them:

- the **chat page's local host**, over this extension's own messaging ([`CHAT_PAGE.md`](CHAT_PAGE.md));
- the **hub host**, over the relay to remote runtimes ([`RUNTIME_HUB.md`](RUNTIME_HUB.md));
- later, an **agent client**: an orchestrator uses the same interface to watch and drive its subagents.

The UI depends on this interface and nothing else, so a phone (a plain web page with no `chrome.*`) and the chat page
run the same code. The hub encodes the same shapes as its `Command`, `SessionEvent` and `Capability` messages.

## Identity

- **A session is `{ runtime, hash }`**, written `runtime:hash` (`sessionKey`). A hash is 8 hex and unique only
  within its runtime. A client keys everything by the pair, never by a bare hash.
- **A runtime id is derived from the runtime's public key**, so it is unique across every account and every hub. A
  client that merges several hosts, or several accounts, cannot collide two runtimes. The local host reports the
  extension's key-derived id once it has one, and `local` until then — and it goes on ANSWERING to `local`
  afterwards. Two hosts reporting the same browser under two ids would not conflict, they would simply list it
  twice, because dedupe is by id and two ids never collide; and a page open across the change, a bookmarked
  `local:<hash>` and a key kept on disk would each become a session on a runtime that never existed. A runtime
  answers to the ids it has had; it reports the one it has now.
- **An alias is RECOGNISED, never EMITTED.** `local` is the one relative name in a namespace where everything else
  is absolute: every other runtime id denotes one machine wherever it is read, and `local` denotes whoever is
  holding it. A session key that leaves the machine that minted it — into `Grant.sessions`, into a `Lineage.parent`
  another runtime walks, or into a link somebody opens elsewhere — has an absolute runtime segment
  (`isPortableSessionKey`). Where a relative key is RESOLVED, the canonical id is what gets written back, so the
  alias is a migration that drains rather than a second name that accumulates users.

  The cost of getting this wrong is not a broken link. A hash is unique only within its runtime, so two browsers
  each holding `local:a1b2c3d4` are two different sessions with one name: a `Grant.sessions` naming it matches on
  whichever machine reads it, and a lineage walk that decides whether a `started` grant covers a session matches
  across the collision. That is a name collision rather than a hash collision, and the runtime id is the thing that
  was supposed to prevent it.

  A profile's id history is `local` → its first principal → its next one, because revoking by subject key means
  "this device including whatever it is renewed into", so a browser that was revoked and wants back in needs a new
  identity key and is therefore a new principal. That is an argument for canonicalising on read rather than for
  keeping a longer list of names: a list nobody drains grows once per revocation, and each entry is a name some
  stale grant may still be using.
- **A principal is a key** with a `kind`: `local` (this browser's own surfaces), `device` (a person's paired device),
  `agent` (an agent acting as a client), `runtime`. Its `name` is a label, never proof. A session records who
  started it (`startedBy`, absent when unknown, such as a console call).

## Versioning

- **One major number, `SESSION_CONTRACT_VERSION`**, carried as `v` on every event envelope and as
  `contractVersion` on every runtime. It changes only for a breaking change: a field removed, renamed or re-typed,
  or a meaning changed.
- **Everything additive is free**: an optional field, an event kind, a command type, a capability. An older peer
  ignores what it does not know; a runtime answers an unknown command with `unsupported`.
- **Features are discovered by capability, never by version.** A client does not reason "version 3 has
  screenshots"; it reads `capabilities.screenshots`. Version numbers only say whether the two sides can understand
  each other at all.
- **A client skips a runtime or envelope whose major version it does not know**, and says so, rather than rendering
  it half-understood.
- **Enumerations are open on the wire.** A new value of an existing enumeration is additive, so a peer must meet one it
  does not know without failing, and each has a fixed fallback:

  | Field | An unknown value |
  | --- | --- |
  | `RuntimeInfo.kind` | renders as a generic runtime |
  | `SessionSummary.status` | reads as `running`: in progress, never finished |
  | `SessionSummary.kind` | renders the session's events generically |
  | `AgentTarget.kind` | the runtime answers `unsupported` |
  | `Scope` | grants nothing: an older runtime grants it to nobody |
  | a gate's `kind` (proposed below) | shown as waiting, answerable only on a surface that knows it |

  The hub encodes these as strings, not closed protobuf enumerations, so a runtime a release ahead of a client never
  breaks it.
- **The event payload is `MlDebugEvent`** (`src/contract.ts`), whose members are already `@unstable` and grow
  additively, the same rule the JSON export follows (`docs/spec/export.schema.json`). A breaking change there is a
  breaking change here.

## The host

| Method | Delivers |
| --- | --- |
| `status(listener)` | the host's connection: `connecting`, `online`, `offline` (with a reason and retry time) |
| `runtimes(listener)` | every runtime the client can see, as a whole list on each change |
| `sessions(listener, { runtime? })` | the session index: a `snapshot` per runtime, then `upsert` and `remove` |
| `events(session, listener, { since? })` | one session's event stream, backfilled then live |
| `send(command, { signal? })` | a command's result; never rejects, every failure is `{ ok: false }` |

Every subscription delivers its current state first, then changes. A listener is never called from inside the call
that subscribed it, and never after its `Unsubscribe` returns.

## Runtimes, capabilities and grants

A `RuntimeInfo` carries three things a client renders from:

- **`capabilities`**: what the runtime can do (`chat`, `agent`, `tabs`, `screenshots`, `highlight`, `persistence`,
  `sideCalls`, `pythonBench`, `resourcePanel`, `localSettings`, `devices`, and the reserved `headless` and `lineage`), which
  `boxes` it uses, the session `archive` with its folder's state (present only while the archive is on), and
  `attention`: what needs someone's hand on the runtime (`no-model`, `backend-unreachable`, `site-access`, …), as
  codes a client words itself, since a runtime's text is untrusted. **Absent means no.** A client renders by capability and never assumes a browser.
- **`grants`**: what THIS client may do there, as scopes (`view`, `drive`, `approve`, `screen`, `desktop`, `admin`), each
  optionally narrowed to `started` sessions (and their descendants, §Agent to agent), a list of sessions, or an expiry. The local host holds every scope.
- **`clockOffsetMs`**: the estimated offset of the runtime's clock, since every timestamp in its index and events is
  on its own clock.

**Grants on the client are presentation only.** The runtime checks every command against its own allowlist. A wrong
grant on the client costs a greyed-out button or a `forbidden` result, never access.

## The session index

A `SessionSummary` is one row of a list: id, `kind` (`chat`, `agent`, `embed`), `status`, `title`, `task`, `model`,
created and last timestamps, `pendingApprovals`, the `page` it started on, whether it is `saved`, `startedBy`, and
`lineage`.

`status` is one of `running`, `waiting` (on an approval), `done`, `error`, `cancelled`, `capped` (continuable), and
`interrupted` (the runtime restarted under it).

A `snapshot` replaces everything the client holds for that runtime, and is sent again after a reconnect, so a client
never has to reconcile a missed `remove`.

## Session events

The payload is **the same `MlDebugEvent` every surface already reduces**. There is no second event format. Each is
wrapped in a `SessionEventEnvelope`: `v`, the global `session` id, an `epoch` and a `cursor`.

- **`cursor`** increases strictly within an epoch (not necessarily by one). A client remembers the last one it
  applied.
- **`epoch`** changes whenever the runtime rebuilt the session's history, such as a service worker that re-hydrated
  a saved session. A cursor from another epoch means nothing.
- **Subscribing** (or re-subscribing with `since: { epoch, cursor }`) runs one fixed sequence: an optional `reset`,
  the backfill as events, one `backfilled`, then live events. When the runtime still holds everything after
  `since`, it sends only that. Otherwise it sends `reset` and everything it holds.
- **`reset` only when there is something to replace with.** A runtime that has lost a session's history (an
  ephemeral session after a restart) sends `backfilled` with `truncated: true` and no `reset`, and the client keeps
  what it shows. This is the rule the DevTools panel learned the hard way: an empty replay after a service worker
  recycle wiped history that was still correct.
- **Delivery can repeat and reorder** around a reconnect, so a client reduces with a reducer that converges in any
  order, as `debug-reducer.ts` already does.
- **A client drops an envelope whose `event.session.hash` differs from `session.hash`**, so no source can write into
  another session's record by mislabelling an event.
- `gone` ends a subscription when the session is deleted.

## Render descriptors: new kinds and fallbacks

Tool output reaches a client as render descriptors (`renderIn` / `renderOut` on a step, `RenderDescriptor` in
`src/contract.ts`): serializable data, never code. The relay does not read them, so a new kind of output needs no
contract or hub change. What decides how it looks is the client's renderer, picked by `type`. So that a runtime can add
kinds faster than every client ships renderers for them:

- **An experimental descriptor's `type` starts with `x-`** (`x-intent-mask`). When it settles it becomes an ordinary
  type. Both steps are additive.
- **Any descriptor may carry `fallback`**: another descriptor, of a type clients already know, showing the same
  output more plainly (a flattened `image` for a layered one). A client that has no renderer for `type` draws
  `fallback`; with neither, it shows the raw data as text. The exports follow the same rule.
- **Prefer a general type to a one-off**: a layered image (a base plus named layers, each with a blend, an opacity and
  whether it starts visible) serves an intent mask, a segmentation mask and an attention map alike.
- **Heavy data travels by reference.** A descriptor carries something drawable (a tensor channel as a PNG layer), and
  the raw value, when it matters, as a pointer the client fetches on demand, so a phone never receives a tensor it did
  not ask for.
- **Untrusted like everything else**: images are `data:image/*` within size caps, labels render as escaped text, and a
  malformed descriptor falls back rather than breaking the view. Whether a layer is toggled on is a display
  preference, kept on the client.

`fallback` is added to `RenderDescriptor`'s types with the first descriptor that uses it.

## Commands

Each command names the scope it needs (`COMMAND_SCOPE`) and, where it is optional, the capability that offers it. A
runtime answers a type or option it does not offer with `unsupported`.

| Command | Scope | Capability | Today |
| --- | --- | --- | --- |
| `session.send`: text, images, or both; steers a running agent or starts the next turn | drive | | `sessionSend` → `ML_SESSION_REMOTE` / the page's handle registry |
| `session.cancel` | drive | | `sessionCancel` → `CANCEL_RUN` |
| `session.continue`: past the step cap | drive | | `continueRun` |
| `session.delete` | drive | `persistence` for saved sessions | nothing |
| `session.rename`: a person's title, trimmed and capped (80); empty returns to a generated one; the row's `title` and `renamed` change by `upsert` | drive | | nothing |
| `models.list`: what `chat.start`/`agent.start` would accept, after the runtime's whitelist, with `kinds` and the `default` marked; empty when the backend is unreachable | view | | `LIST_MODELS` |
| `storage.stats`: where saved-session storage goes now (images, tool output by tool, the rest, unmeasured), a daily history of the same (no session hashes), and the largest sessions | view | `persistence` | `STORAGE_HISTORY` |
| `sessions.list`: a page of sessions, newest activity first, past `before` (a `lastTs`); the live index and the archive merged, archived rows marked `archived`; `archived: true/false` for only or none of them | view | | nothing |
| `sessions.search`: the same rows and paging, matching a query: an archived session by every word its events hold (FTS5), a live one by title, task and page title; `match.snippet` is plain text with the match in «guillemets» | view | | nothing |
| `session.unarchive`: bring an archived session back into the live store, to be opened, resumed, pinned or deleted like any other; `session.resume` does it first on its own | drive | | nothing |
| `session.pin`: keep a session whatever the caps and retention say, or stop; the row's `pinned` changes by `upsert`; bounded, `conflict` past it | drive | `persistence` | nothing |
| `approval.answer`: by the pending step's `seq`; `persist`, `feedback` | approve | | `approval` → `SET_APPROVAL` → `resolveApproval` |
| `chat.start` | drive | `chat` | nothing background-hosted |
| `agent.start`: on a tab, a blank tab, or (reserved) headless | drive | `agent`, `tabs`, `headless` | `startRun` → the page → `START_RUN` |
| `session.resume`: pick a saved session up on another page, by target | drive | `persistence`, `tabs`, and `agent` or `chat` by the session's kind | nothing |
| `session.backfill`: a page of a session's events, older than a position | view | `persistence` | nothing |
| `runtime.info`: what this runtime IS — its kind, contract version, capabilities and its own clock | view | | nothing |
| `tabs.list`: windows in order (the focused one first), each window's tabs in strip order, with `index`, `groupId` and a `favicon` data URL the RUNTIME fetched (a client never loads a site's own icon URL); `groups` with names and colours where the runtime can name them | drive | `tabs` | nothing |
| `tab.focus`: bring a tab and its window to the front; only a tab `tabs.list` would show | drive | `tabs` | nothing |
| `tab.screenshot`: on demand, size-capped | screen | `screenshots` | `CAPTURE_TAB` |
| `page.highlight`: a selector, a canvas token, or clear | drive | `highlight` | `__mlHighlight` → `ML_HL_REMOTE` |
| `side.call`: a utility-model call about a session | drive | `sideCalls` | `FETCH_LLM` with `extend: "utility"` |
| `device.list` | admin | `devices` | nothing |
| `device.renew`: a fresh certificate for a device that still holds a valid one | admin | `devices` | nothing |
| `device.revoke`: unpair, and rotate the stream keys it held | admin | `devices` | nothing |
| `device.scopes`: narrow or widen what a device may do; `approve`, `control` and `admin` are refused with `forbidden` | admin | `devices` | nothing |

**`session.backfill` exists because a RELAY's ring is short.** A subscription resumes from a position, and a client
that opens a session from last Tuesday is answered `truncated` with nowhere to read the rest. Locally the index
serves that in-process from its ring and the store, which is why the contract never needed a command for it; across
a relay there is no in-process.

It reads UPWARDS — the page ending just before `before`, oldest-first within the page — because that is how a person
scrolls a transcript back. `before` and `from` are positions in the SESSION'S OWN HISTORY, 0 being its first event
ever, and deliberately not the stream cursor: a cursor counts across every session on a runtime and is not kept for
an event once it is on disk. A client pages by handing back the `from` it was given.

**Where the first page starts.** A subscription says where its events begin: `backfilled.from` is the history
position of the contiguous run of events the stream ended with, and each event may carry its own `pos`. A client's
first request is `before: from`, so no page overlaps what the stream delivered: events that arrive with no cursor
cannot be deduplicated by one, and a reducer that appends (a user message) would show them twice. Locally `from` is
0 whenever nothing was lost. Over a hub the runtime stamps `pos` and the client's adapter reads the ring's first
one; a short ring is then not reported `truncated`, since what the HUB kept is not what the RUNTIME still holds, and
`session.backfill` answers that. No `from`: the client offers no paging.

**A short ring keeps the session's START.** A reducer hangs every step on the session's first event and parks the
rest until it arrives, so a ring without it shows nothing. The runtime re-publishes the start so the ring holds it
(it arrives ahead of the tail, at a position below `from`, and a client drops by `pos` what a page repeats). A client
facing a runtime that does not pages back on its own, a bounded number of times, until the start arrives.

`more` says another page exists below this one. `truncated` says one does not and never will, which is a different
sentence: a session the runtime does not KEEP has no durable history at all, its only copy having been the ring the
subscription already served, and a client given an empty page without being told would wait for a page that is never
coming.

The page is capped by the runtime whatever a client asks for. It is a size decision wearing a count: forty events of
a DOM run is nothing and forty screenshots is tens of megabytes.

**`runtime.info` exists because a TRANSPORT cannot answer it.** A hub carries a runtime's identity and liveness and
deliberately nothing else: the moment it holds a claim about what a runtime can do, a client is trusting it for
something other than routing. So `RuntimeInfo.kind`, `contractVersion` and `capabilities` come from the runtime, over
the same authenticated channel as every other command, and a client asks when a runtime appears and again when it
reconnects — a runtime that restarted may have been upgraded under it. `nowMs` is the runtime's own clock at the
moment it answered, which is where `clockOffsetMs` comes from and why the round trip bounds its error. A hub's own
`server_time_ms` is the offset from the HUB, which is a different quantity and not the one a session timestamp needs.

Sessions started by a command are **saved unless `ephemeral: true`**, per the chat page's persistence decision.

**Retrying is safe with an `idempotencyKey`.** `session.send`, `chat.start` and `agent.start` take one, because
repeating them does something twice: a second subagent, a steering message delivered twice. `aborted` and a dropped
connection both mean "may have been delivered", and an agent client retries in a loop where a person would look first.
A runtime that has carried out a command with the same key from the same principal, within its dedupe window (at
least ten minutes), returns the first result and does nothing else. The relay carries the key unchanged and never
de-duplicates by it: only the runtime knows whether the command took effect.

**Errors** are `unsupported`, `forbidden`, `not-found`, `invalid`, `conflict` (not possible in the session's state),
`unavailable` (runtime offline), `aborted` (the caller's signal fired; the command may still have been delivered), and
`failed`. An `approval.answer` for a gate that already closed is not an error: it returns `{ resolved: false }`, and
the session's events show what happened.

### Approvals

A remote approval is a command handed to the runtime's **one `resolveApproval`**, the same function the sidebar's
click and the IPC channel reach. Nothing new decides a gate, and `approve` is never implied by `drive`. The consent
model does not change: a gated tool still asks, and remote driving only adds places to answer from.

### Resuming

A saved session picked up on another page is, from the agent's side, a NAVIGATION: everything in its context
describes the page it last ran on. So it reuses that framing rather than inventing a second one, and it is its own
command because `session.send` would reach a page that no longer holds the session.

- **The hash does not change.** The result answers with the same session id, and it stays one conversation on every
  surface.
- **It needs the capability that RUNS the session, not only the one that stored it.** A runtime advertising
  `persistence` and `tabs` but not `agent` can hold a saved run and cannot continue one, so resuming it is
  `unsupported` — the capability is `agent` or `chat` by the resumed session's kind.
- **The runtime says what was lost, in the transcript.** `session-resumed` is the first event of the new turn: the
  page it is resuming on, the page it was on, how long it had been idle, and what did not survive. It is a fact
  about the session rather than something anybody said, so a client draws it as a divider and never as a message.
- **It is the one SESSION-level event kind**, because a chat and a run resume for the same reasons and lose the
  same things. It never creates a session: a note about a session a client does not hold is not a session.
- **What is kept and what is dropped** is `CHAT_PAGE.md` §Resuming — messages, config and captured outputs kept, so
  a `@tool:` pointer still resolves; live element references, the page's `state`, cached fetches, page-defined
  tools and approval grants dropped, and each named in `dropped`.

### Devices

Pairing is how a runtime gets clients, and `device.*` is how a person manages the ones it has. Four rules, because
each of them is a sentence a list has to be able to say.

**`admin` is its own scope, granted at the runtime and never passed on.** A phone that may `approve` a click should
not thereby be able to pair another phone, so `admin` is not implied by `approve` and, like `approve` and `control`,
a delegate cannot delegate it (the hub enforces this as `NEVER_DELEGABLE`). For the same reason a `device.scopes`
carrying any of the three is answered `forbidden` rather than quietly ignored: scopes are an open enumeration, and
these are the members that must never be settable over the wire.

**`mayPair` is not a scope, and the list has to show it anyway.** It is a field of the device's certificate, so
`scopes` cannot carry it, and a device that holds it can issue a certificate for a new device by itself — without
`admin`, and without asking the runtime. A phone that can pair another phone is not the same thing as a phone that
can drive a run, and that is the distinction a person revoking a device most needs to see.

**A principal id is lowercase hex.** The list's one comparison is `principal === myPrincipal`, so a runtime sending
`0A3F…` to a client holding `0a3f…` shows no "this device" row and no logout warning, with nothing wrong to see in
either value. Both implementations already emit lowercase; this says so.

**Whether this client may administer is not on the wire.** It is `COMMAND_SCOPE` against the grants the runtime
already reported, the same table the runtime enforces from. A second answer to the same question disagrees with the
first eventually, and the case where they disagree is the case a UI gets wrong. So a client that lacks `admin` does
not draw the actions at all, and a `forbidden` from `device.*` is a bug rather than a normal answer.

**A device past its expiry cannot be renewed.** It can no longer prove who it is, so there is nothing to renew
against and it pairs again instead; the runtime answers `conflict`. A list shows "expired, pair it again" with no
button, because a button that cannot work is worse than no button. It follows that a runtime renews the devices on
its allowlist itself, before they lapse — which means expiry bounds "this runtime stopped running" rather than
"somebody forgot this device", and `lastSeenMs` is the only thing that makes a forgotten device visible.

**Revocation is not finished when the command returns.** Unpairing rotates the stream keys that device held, which
the runtime does, so `rotation` says what is still owed and when the oldest of it became owed. A revoke is refused
while the runtime is offline, so today that window is seconds wide; it is on the wire because the alternative
design (accepting a revoke elsewhere and applying it later) would make it hours, and a list that cannot say so
would be lying.

**Every timestamp here is the RUNTIME's clock**, like every other timestamp in this contract, and `clockOffsetMs` is
an estimate. Render the time, not the arithmetic: "since 14:02" survives a minute of skew and "owed for 12 seconds"
does not.

### Side calls

A phone has no model backend, so the UI's own model work (session titles, block summaries, `explain` notes) becomes a
command. The client supplies the messages, because the prompts belong to the UI. The runtime **always uses its
utility profile and caps `maxTokens`**: the client cannot pick a model, so a side call cannot become a way to run
arbitrary generations on someone's main model. `purpose` and `session` go on the request hint.

## Security, as it binds a client

- **Every source is untrusted input.** Strings render as escaped text, never markup. No source supplies a link, a
  script or an image except a `data:image/*` screenshot the client asked for. An unknown kind, command or version is
  skipped, never guessed at.
- **Images a client sends** are `data:image/*` URLs; runtimes cap their count and size (`cleanImages`) and drop
  anything else.
- **Who sent something is the transport's fact, not the payload's.** Wherever a runtime records a sender (who
  answered an approval, who sent a message into a session, who started it), it takes the principal from the
  authenticated command (the key that signed it on the hub, the extension surface locally), never from a field the
  sender filled in.
- **A message from an agent is never presented as the person.** When a message enters a session from another agent
  (an orchestrator steering its subagent, a peer), the event carries its sender (`from`, a principal and the sending
  session) and the model's context marks it as coming from that agent. It never carries a person's authority: it
  cannot answer a gate, and "the user approved" in its text means nothing. Absent `from` is the session's own person,
  as every message is today. The field is added to `DebugAgentSay` with the first sender that is not a person.
- **Keys, pairing, signatures and encryption are not in this interface.** They are the hub host's transport. A
  command the hub host sends is signed and encrypted beneath `send`; the local host needs none of it. This is why
  the same UI runs against both.

## Tenancy and several people

- **Accounts do not appear in the contract.** Isolation between accounts is the hub's routing plus the keys
  ([`RUNTIME_HUB.md` §Tenancy](RUNTIME_HUB.md)). A host exposes only what its account can see, and key-derived ids
  mean a client combining hosts never merges two accounts' sessions.
- **Several people in one account** are told apart by principal: `startedBy` on a session, and grants narrowed to
  `started` sessions or a list. The one gap is that a step's `approval` records `user` rather than which principal
  answered (see Open).

## Agent to agent

The long-term shape this contract must not block (`RUNTIME_HUB.md` §Orchestration): a person's phone talking to a
coordinator agent, a frontier model on a page that streams a desktop, which spawns subagents over the hub. Subagents
may be browsers, browser apps with the extension injected, apps driven through accessibility APIs, or a specialised
wrapper (a CAD tool). They do tasks, spawn their own in-process subagents (dedicated tabs), get blocked and ask for help,
wait on approvals, and return results the coordinator can investigate like any tool output.

### Reserved: typed now, offered by no runtime yet

- **An agent is a client** (`Principal.kind: "agent"`) using this same interface. The protocol does not tell a
  person from an agent; grants do.
- **`agent.start` takes `lineage`**: the parent session and the spawning step's `seq` and request id. The child's
  `SessionSummary.lineage` carries it back, and the lane hangs the child under `step:<parent key>:<seq>`
  ([`RUNTIME_HUB.md` §Rendering a subagent](RUNTIME_HUB.md)).
- **A `started` grant** is what an orchestrator holds over what it spawned.
- **A `headless` target** needs `capabilities.headless`.

Runtimes today declare neither `lineage` nor `headless` and answer both with `unsupported`.

### Settled now, because changing them later would break

- **`started` is transitive.** It covers the sessions a principal started and every session descended from them
  through `lineage`, on any runtime. A browser subagent that opens its own tabs stays inside the coordinator's grant.
  The runtime checks it by walking a session's lineage up to one the principal started.
- **Authority belongs to the spawning session, not to the whole runtime.** The hub authenticates a runtime's key, and
  every session on that runtime shares it: a console script, or a hostile page's session, on the coordinator's
  browser. So the coordinator's runtime enforces locally that only the session named in a child's `lineage` (or a
  person's surface) can steer, cancel or read that child. Nothing on the wire changes; a runtime that acts as a client
  must do this before it holds a key.
- **Open enumerations, idempotency keys and sender attribution** (above): an orchestrator retries, meets runtime kinds
  newer than itself, and sends messages that must not read as the person's.

### Proposed: gates, not only approvals

A step can wait on an approval today (`awaitingApproval`). A subagent also waits on things that are not approvals: a
captcha, a login or a second factor, a question only someone with more context can answer. Generalised, additively:

- **A step's `gate`**: `{ kind: "approval" | "question" | "takeover"; prompt?; choices? }`, with `awaitingApproval`
  kept for the approval kind.
  - `approval`: answered only by people, exactly as now (`approval.answer`).
  - `question`: raised by the agent's own `ask` tool ("which of these three accounts?"). A new `gate.answer`
    command carries the text or the choice. Scope `drive`, so a coordinator can answer from its own context.
  - `takeover`: the agent needs a person at the page. Someone with `control` drives it through remote control (below),
    then releases the gate with a note, which reaches the agent like a steering message.
- **Where a gate goes** is set at start: `escalate: ("people" | SessionId)[]`, defaulting to people. It names targets
  rather than "the parent", so a peer or a coordinator that is not the parent can be one. It mirrors today's
  `approvalRouting: "ui" | "both" | "external"`. Approvals still reach only people, whatever it says.
- **The index counts open gates** (`pendingGates` beside `pendingApprovals`), and a session with one reads `waiting`.

### Proposed: a subagent's result is a remote tool result

Starting a subagent from a step has the same shape as a remote tool call (`REMOTE_TOOL_EXECUTION.md`), so it reuses
that machinery rather than growing its own:

- **Progress streams into the spawning step** (`ctx.stream`), from the child's events, and the child's own time comes
  back as the step's remote timing, so the parent's wall clock is not charged with the child's work.
- **The result is a preview plus a pointer.** `agent-result` gains an optional value reference; the parent's step shows
  the preview and mints an ordinary `@tool:` token for it, exactly like a server tool's truncated output. The model's
  pointer dialect does not change: only the resolver knows the value is remote.
- **The value stays where it was made**, addressed as `runtime:hash:<token>`, and is read with a new `value.read`
  command (scope `view` on the child): a byte range, or a pipe the child's runtime runs so only the reduction crosses.
  A small value may be copied into the parent's value store when the child finishes (`POINTER_VALUES.md`); a large one
  is read on demand and fails loudly once gone, never degrading to its preview.
- **Reads are chunked.** A 100 MB table cannot be one command result, so `value.read` returns pages and the relay's
  frame limits and flow control must allow a long paged read.

### Proposed: what makes delegation work in practice

- **A work order on `agent.start`**: acceptance criteria, a result schema, a budget (steps, tokens, wall time), a
  deadline, the tools and domains the child may use, and `escalate`. All optional fields.
- **A digest instead of the event stream.** A coordinator reading every event of every child spends its context on
  them. The child's runtime keeps a short status line (a side call on its own utility model), and the coordinator reads
  details by pointer, including the child's whole transcript as one value.
- **Tree operations**: cancel a tree, answer several gates from one device, a tree-wide stop, export a tree as one run.
- **Passing values between siblings** as references with a read grant, so the coordinator never copies a table
  through its own context.

### Not blocked: coordination between peers

Agents on related jobs passing messages to each other, rather than one driving the other, is not designed and not
planned. The contract keeps it possible:

- `session.send` already delivers a message into any session by global id; peer messaging is the same delivery with
  another sender, and the sender rule above keeps it from reading as the person.
- **Lineage is not the only relationship.** `started` is one way a grant covers sessions; a later `group` value (the
  sessions of one job) covers peers without changing what `started` means. `escalate` names targets, not a parent.
- Loops between agents (two peers answering each other forever) need a per-job budget and a per-link rate limit when
  this is built.

## Proposed: remote control

**Status: proposal, not in `session-host.ts`** (2026-09-17, from the UI session). Controlling an agent from a phone
needs to see its page and sometimes act on it directly: dismiss a dialog the agent is stuck on, sign in where it cannot.
All three parts are additive. They go into the types once agreed, and streaming stays open until its mechanism is
chosen.

### 1. A one-off screenshot

`tab.screenshot` already covers a tab (scope `screen`, capability `screenshots`). Two additions:

- **The result says what coordinates it is in**: the image's pixel size, the viewport's CSS size, `devicePixelRatio`,
  the scroll offset, and a `frame` id the runtime can recognise later (see input below).
- **A desktop runtime's display** as a target (`{ display: string }`), under the `desktop` capability and scope.

### 2. Input at a point

A new command, sketched:

```ts
| {
    type: "input.pointer"; target: { tabId: number } | { session: SessionId } | { display: string };
    /** the frame the client was looking at; the runtime maps the point through it */
    frame: string;
    action: "click" | "double" | "move" | "down" | "up" | "scroll";
    x: number; y: number;          // in that frame's image pixels
    button?: "left" | "middle" | "right";
    deltaX?: number; deltaY?: number;
  }
| { type: "input.text"; target: …; frame: string; text: string }
| { type: "input.key"; target: …; frame: string; key: string; modifiers?: ("alt" | "ctrl" | "meta" | "shift")[] }
```

- **Coordinates are in the frame the client saw**, not the viewport. The runtime maps them through that frame's size,
  pixel ratio and scroll. If the viewport has since resized or scrolled, it refuses with `conflict` instead of clicking
  a different element than the one tapped.
- **A new scope, `control`.** Acting as the user in a logged-in browser is more than `drive`, which only reaches the
  page through the agent and its approval gates, and different from `screen`, which only sees. It is never held by an
  agent client by default, and never implied by another scope. A new `Scope` value is additive: an older runtime
  grants it to nobody. The matching capability is `input`.
- **Trusted input through CDP**, as the agent's own reserved clicks already use (`cdpClick` in `sw-cdp.ts`). Chrome's
  debugger banner is then the visible signal on the machine that the page is being driven.
- **Recorded in the session.** When a session's agent is running on the target, the input is added to its events (a new
  event kind naming the principal and the action), so the log shows it, and the agent is told at its next step boundary
  that the page changed under it, as a steering message is.

### 3. Streaming the display (open)

A subscription, not a command: an optional host method, offered under a `screencast` capability and the `screen` scope.

```ts
display?(target: { tabId: number } | { session: SessionId } | { display: string },
         listener: (frame: DisplayFrame | { type: "ended"; reason: string }) => void,
         opts?: { maxWidth?: number; quality?: number; maxFps?: number }): Unsubscribe;
// DisplayFrame: { type: "frame"; frame: string; image: ImageDataUrl; width; height; viewport; dpr; ts }
```

- **Version 1, screencast frames over the relay.** CDP `Page.startScreencast` sends JPEG frames and waits for an ack
  before sending more, which gives backpressure for free: the runtime acks once the subscriber's queue has room, so a
  slow phone gets fewer frames rather than a growing backlog. Frames are superseded, so the hub coalesces and drops
  them like telemetry, never like session events. Without CDP it falls back to `captureVisibleTab`, which Chrome limits
  to about two a second.
- **Frames may name regions.** A desktop runtime can mark which window regions belong to which session
  (`regions: { rect, session, label? }[]` on a frame). A coordinator's canvas then masks the windows its subagents
  drive, its own screenshots redact them (a child's signed-in window never enters the coordinator's context), and input
  aimed into a region another session holds is refused with `conflict`. Regions are metadata on a frame, coalesced and
  dropped with it.
- **Only while someone watches.** It starts on subscribe and stops on unsubscribe, when the client's connection drops,
  or after an idle limit. While a stream is open, the runtime's own sidebar says so and names who is watching.
- **Every frame is also a `frame` for input**, so tapping the live view uses the same command as tapping a screenshot.
- **Later, real video** (WebRTC from `tabCapture` or a desktop capture) for smooth frame rates. Media would flow outside
  the relay's envelope, so it keeps the hub blind only if the runtime and the device check each other's DTLS
  fingerprints, signed by their paired keys. A different security story, so it waits until frames are not enough.

## Not in the contract

Display preferences and themes (client storage); the envelope, keys, pairing and encryption (hub transport); box
telemetry (`BoxFrame`, its own feed per `RUNTIME_HUB.md` §Telemetry); settings editing beyond the `localSettings`
flag. That flag is local by design: the settings include where the runtime sends its traffic (the backend URL, the
API key, `modelFilter`), which no remote client may change whatever scopes it holds.

## On the wire

The hub parses only its `Envelope` (`docs/spec/hub/*.proto`, written with the hub). Inside the ciphertext, version 1
carries these shapes as JSON: `MlDebugEvent` is an `@unstable`, growing type with a checked-in JSON schema, and a
parallel protobuf definition of it would be the second event format this contract refuses. The commands, index and
capabilities get protobuf messages with the hub; the event payload moves to protobuf only if its schema settles.

## Open

- **Who answered an approval.** `DebugAgentStep.approval` says `user`; with several people and devices it should also
  name the principal, taken from the authenticated command (§Security). An additive field on the step.
- **The local runtime's id** before the extension has a key, and how the chat page avoids showing the same browser
  twice once it also connects to the hub.
- **`session.send` for a chat** needs a background-hosted chat, which does not exist yet.
- **Index size**: whether a snapshot pages once a runtime has thousands of saved sessions.
