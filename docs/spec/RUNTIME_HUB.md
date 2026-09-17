# Spec: the runtime hub, driving agents from anywhere

**Status: agreed direction, not started** (2026-09-15). Security comes first in this document because it is the
whole design: everything after it is plumbing that must not weaken it.

## What it is

A small relay server that **runtimes** register with and **clients** connect to.

- A **runtime** runs agents and emits the session event stream: this extension in a browser, a second browser on
  another machine, a desktop daemon, later a headless or container runtime.
- A **client** shows sessions and drives them: the chat page ([`CHAT_PAGE.md`](CHAT_PAGE.md)), a phone, or an agent
  (an orchestrator driving subagents).
- A **box** is a GPU server (the patched Ollama) that runtimes send model requests to. It is not a runtime: several
  runtimes may share one, and its telemetry belongs to it.

The motivating cases: a browser with the extension at home, driven from a phone (watch the session, send it
messages, answer its approvals, see the agent's tab on demand); and a root agent that starts browsers and drives
subagents in them, with the whole tree visible in the root's own event lane and graph.

## Security

**The asset.** A runtime holds a logged-in browser: credentialed fetches as you, CDP clicks and typing, the Python
sandbox, every site you are signed in to. A desktop runtime holds a shell. Whoever can send a runtime commands has
all of that. So the design is judged by one question: what can someone who controls the hub, or sees its traffic,
make a runtime do? The answer has to be nothing.

1. **Runtimes connect out and never listen.** No port is opened on the machine running the browser. The runtime
   dials the hub; the hub never dials it.
2. **Principals are keys.** Every runtime, device and agent client has its own keypair; a runtime's id is derived
   from its public key. Pairing is done in person (a QR code or a short code shown on the runtime, confirmed on the
   device), and each runtime keeps an allowlist of the keys it takes commands from, each with its scopes.
3. **End-to-end encryption.** Traffic between two principals is encrypted between them; the hub relays ciphertext
   and routing metadata only, so a compromised hub can read nothing and forge nothing. (Options to evaluate: the
   Noise protocol framework, or libsodium boxes per pair; a group key per box for telemetry, see below.)
4. **Every command is signed.** A command is `{ to, scope, body, nonce, time }` signed by the sender and verified by
   the runtime against its allowlist before anything happens. Nonces and a clock window stop replays. A remote
   approval is such a command, handed to the same single `resolveApproval` every other surface uses (approvals over
   IPC, `docs/dev/agent-tools.md`), so it is exactly as unforgeable as a click in the sidebar.
5. **Scopes, attenuated, never widened.** See Principals and scopes. A grant can be passed on only as a subset.
6. **The consent model does not change.** Approval-gated tools still ask. Remote driving adds places to answer
   from; it never removes a question.
7. **Who sent something comes from the signature.** A runtime records a command's principal (who answered, who
   steered, who started a session) from the key that signed it, never from a field inside the body. The hub
   authenticates keys and routes; it never asserts a sender on anyone's behalf.

**What the hub can still do**, stated so nobody assumes otherwise: drop or delay messages, see which principals are
online and when, and see the sizes and timing of traffic. It cannot read or originate a command.

### The boundaries

Each boundary, what crosses it, and what stops it being abused:

| Boundary | What crosses | Enforcement |
| --- | --- | --- |
| Hub ↔ everyone | ciphertext, routing | end-to-end encryption; the hub is untrusted by construction |
| Device or agent client → runtime | signed commands | allowlisted key, scope check, nonce and clock window |
| Hub-facing code → the page | nothing | remote commands enter at the background worker and use its choke points (`resolveApproval`, the privileged-fetch guards); they never pass through the page's main world, which a hostile page owns |
| Runtime → runtime (orchestration) | signed commands, session events | capabilities issued at spawn; drive, never approve, by default |
| Box → subscribers | telemetry frames | a group key for the devices allowed to see that box; box telemetry is box-wide by nature (see Telemetry) |
| Runtime → box | model requests with hints | hints are the runtime's own claims; attribution across runtimes trusts only exact request-id joins (see Telemetry) |

**Keys never live in the page world.** A runtime's key, and an orchestrator's, are held by the extension's
background worker. The page's main world is hostile territory (see the security invariants in AGENTS.md), and a key
reachable from it would let any page drive every runtime the key can reach.

**Residual risk**: a compromised paired device or agent client can do what its scopes allow. That is why scopes are
narrow and why approving is its own scope.

## Principals and scopes

Scopes are granted per pairing and checked on every command.

| Scope | Lets the holder | Typically held by |
| --- | --- | --- |
| `view` | receive a runtime's session events, and the telemetry of the boxes it uses | a phone, the chat page, an orchestrator for its subagents |
| `drive` | send messages to sessions, start and cancel runs, list tabs | a phone, an orchestrator for runtimes it started |
| `approve` | answer approval gates | a person's device; never an agent by default |
| `screen` | request a screenshot of the agent's tab (a desktop runtime: of the desktop) | a person's device |
| `desktop` | shell, processes and input on a desktop runtime, each still approval-gated | an orchestrator, when a person grants it |

- **Attenuation.** A holder may pass a scope on only as a subset: to a narrower set of sessions, for less time, or
  without `approve`. Nothing can mint a scope it does not hold.
- **`started` covers a whole subtree.** An orchestrator's grant over what it started extends to every session
  descended from those through lineage, on any runtime, so a subagent's own subagents stay visible and steerable to
  it (`SESSION_CONTRACT.md` §Agent to agent).
- **A key is shared by every session on its runtime, so authority is also checked there.** The hub sees the
  orchestrator runtime's key; the runtime itself makes sure only the session that spawned a child (or a person's
  surface) uses the grant over that child, and not a console script or another page's session on the same browser.
- **Spawned runtimes inherit, narrowed.** A runtime started by an orchestrator (a browser on a desktop) is
  provisioned at start with its parent's device allowlist, each entry no wider than the parent's, plus a `view` and
  `drive` grant for the orchestrator. The person's phone can therefore watch and answer a subagent without pairing
  each browser by hand, and the orchestrator can drive what it started and nothing else.
- **Approvals stay with people.** A subagent's approval goes to the person's devices and the sidebar. Letting an
  agent approve is an explicit, scoped grant a person makes, never a default.

## Tenancy: many users, none reaching another's

One hub can serve several unrelated users. It is cheap to design in now and expensive to retrofit, because every
table above assumes a single owner.

- **An account is a root key.** A user's runtimes, devices, agent clients and boxes are paired under their account.
  Every registration carries the account; the hub routes a message only between principals of the same account, and
  its directory (who is online, which runtimes exist) is per account. Nothing is addressable across accounts: no
  subscription, no command, no listing.
- **Isolation holds twice.** The hub's routing is one wall; the keys are the second. Even a hub that routed a message
  to the wrong account's runtime delivers nothing usable: it is not encrypted to that runtime, and its sender is on
  no allowlist there.
- **The hub protects itself.** Registering needs an account credential for the hub (separate from the end-to-end
  keys, which the hub never sees), so a stranger cannot fill it with registrations; connections, ring sizes and
  message rates are limited per account, so one account cannot starve another.
- **A box belongs to exactly one account, and its feed never crosses accounts.** An account is a trust domain, not
  a person: a lab sharing one workstation is one account with several people's devices, and they see each other's
  model loads and token counts the way colleagues sharing a machine do. Whose model stays loaded is then a question
  of fairness among them (a `use: interactive` hint is a fairness signal, and gaming it is a social problem), not of
  security.

**Why a box is not shared across accounts.** The box this project targets is a patched Ollama, and Ollama is
designed for a single owner: one scheduler, one cache and one trust level for every client. The placement and
keep-alive work here is about exactly that setting (how to spend VRAM on a personal or lab workstation), not
large-scale serving. Serving strangers from one box would need five things it does not have, and building them would
fight its design:

1. **Its telemetry is everyone's metadata.** The event stream carries every generation's hint: other users' session
   and request ids, prompt and output token counts, timings, the models they load, whether a request was
   interactive. Not content, but usage patterns, prompt lengths and private model names.
2. **Control actions act on the shared box.** Freeing VRAM or unloading a model evicts someone else's mid-
   conversation; placement and keep-alive trade one user's latency for another's. The box trusts every client
   equally.
3. **Hints are self-reported.** A client could claim `interactive` to win if the scheduler ever prioritised it, or
   tag its requests with someone else's session. The lane only trusts exact request-id joins across runtimes; a
   scheduler has no such check.
4. **The prompt cache is a side channel.** The patched box keeps conversations' KV caches, including in host RAM. A
   prefix cache that can hit across users reveals, by a fast response, that someone else sent the same prefix: a
   known cross-tenant leak in shared LLM serving. Isolation would need cache entries scoped per account.
5. **Learned corrections mix users.** The decode-speed correction and a learned keep-alive would train on everyone's
   traffic, so one user's habits would shape another's latency.

A server built for many tenants (vLLM and its kind are built for high-throughput serving of many users) could provide
all five. The hub does not implement that; it publishes the contract such a server would emit (see The contract)
and treats any server that emits it as untrusted input.

## Who subscribes to whom

| Subscriber | Source | What it receives | Needs |
| --- | --- | --- | --- |
| a client (phone, chat page) | a runtime | that runtime's session events | `view` on the runtime |
| a client | a box | the box's telemetry | `view` on a runtime that uses the box |
| a runtime (as orchestrator) | a child runtime | the child's session events, to draw the tree in its own lane | `view`, from the spawn grant |
| a runtime (as box connector) | a box | the box's frames, to relay them once | being able to reach the box |

**Relays.** The hub relays everything and reads nothing. A **box connector** is a runtime that can reach a box and
relays its feed to the hub, once, for every subscriber: the hub usually cannot reach a GPU box on a home network.
The first runtime to reach a box becomes its connector, the others that can reach it stand by, and one takes over if
the connector goes away. Where the hub can reach a box directly, it subscribes itself. Either way there is **one
subscription per box**, never one per agent: three agents sharing a box must not produce three copies of its stream
to merge (reconnect replays already need de-duplication within one stream, `sameMachineEvent`; merging several would
be that fragility multiplied).

## Telemetry: relaying what the panel draws

**The hub relays the panel's INPUTS, never its drawing.** The resource panel and the event lane are derived, by pure
functions, from three inputs, which `ml.__events()` already dumps together: each runtime's session debug events, the
box's event-stream frames, and the box's `ps`/`info` readings. A client receives those inputs and runs the same
derivation (`eventsFrom`, `laneEvents`, `joinGens`, the band and window functions). The phone and the desktop then
cannot disagree about a run, for the same reason the JSON export reuses `eventsFrom`.

- **Box identity.** A box's stream opens with a `hello` carrying its `box` id; subscriptions and caches are keyed by
  it. Frames are relayed as they come (`v: 1`, already versioned).
- **Box telemetry is box-wide.** A box's frames describe everything on it, including other runtimes' generations
  (their session ids, token counts and timings, via the hints echoed on `gen.end`). So a box's feed goes only to
  devices trusted for everything on that box: in practice, a person's own devices. It is encrypted under a group key
  held by those devices.
- **Session events are versioned** with a schema, the way `docs/spec/export.schema.json` is for exports: runtimes are
  different builds, and a client switches on the kinds it knows.
- **Clocks.** Events from different machines are stamped by different clocks, and the lane would misalign them.
  Each source carries its own clock in its hello; the client estimates an offset per source (round trip halved,
  refined over time) and corrects every timestamp before placing it. The box stream already anchors its frames on
  the server's hello within one box; this is the same idea per runtime.
- **Volume.** About a sample a second while a box works, fifteen seconds apart idle, plus the frames: small over a
  websocket. Screenshots are on demand only.

## Rendering a subagent in its parent's lane and graph

Exactly how a subagent running on another runtime appears in the root agent's event lane and chart, on the root's
own browser and on any client that can view both. Everything here extends a mechanism the lane already has.

### 1. Identity

- **A session's global id** is `runtime:hash`. Hashes are 8 hex characters and collide across runtimes; the runtime
  part makes them unique. Lane ids are namespaced the same way: `run:<runtime:hash>:<i>`, `step:<runtime:hash>:<seq>`.
- **Request ids** (`wml-r-<16 hex>`) are already unique enough across runtimes, and they are what the exact join uses.
- **The hint** each model request carries (`ml`'s request hints, `docs/FORKED-BACKENDS.md`) gains `runtime` beside
  `session`, and `root`, the tree's root session. `root` is not needed to draw; it tells the box which requests are
  one tree of work competing for its GPU, for the placement and keep-alive learning. (Hint fields are agreed with
  the patched Ollama before use; `wireHint` is where they are added and limited.)

### 2. Lineage

- **Spawning is a step.** The parent's step that starts a subagent (a `delegate`-style tool call) sends `start` to the
  child runtime with `lineage: { runtime, session, step, request }`, naming that exact step.
- **The child's session records it.** Its session-start debug event carries the lineage, so every client that reduces
  the child's events knows where it hangs.
- **The child's run event's `parent`** is the spawning step's id in the parent: `step:<parent runtime:hash>:<seq>`.
  This is the same `parent` link a delegated sub-call uses today (`${stepId}:sub${i}`, kind `embed`), so `lineageOf`
  (hover lights the chain, dims the rest) and click-through work across runtimes unchanged.

### 3. Reduction

- A client that can view the child subscribes to the child's session events and reduces them with the SAME reducer as
  local sessions, into a session record keyed by the global id. The chat page's two sources (local and hub) feed one
  store; a remote session is a session.
- `eventsFrom` runs over all sessions, local and remote alike, and produces the child's runs, steps, generations and
  asides with namespaced ids and the lineage parent.

### 4. Bands: one per tree, not per session

- The lane packs rows **per band**, and a band today is one session (`laneRows` groups by `ref.hash`). For a tree,
  the band key becomes the tree's **root**: walk `parent` links across sessions to the root session. The parent and
  all its subagents then share one contiguous band, which is what makes the tree readable.
- Within a band, **depth orders the rows**, as tiers do today: the root's run, the root's steps, each child's run
  under the step that spawned it, the child's steps, and so on down; the machine's spans claimed by any session in
  the tree sit at the bottom of the band. Rows are still packed by time within a depth, so two sequential subagents
  share a row and two concurrent ones do not.
- A child runs on its own clock (corrected, see Clocks) and may outlive the spawning step, which the lane already
  handles: spans are placed by time, and a child that continues past its parent step is drawn continuing.

### 5. Joining the box's record

- The box stream carries every generation on the box, with the hint the requesting runtime sent. A child's
  generation arrives as `gen.end` with `{ runtime, session, request }` of the CHILD.
- **`joinGens` matches it to the child's own step by request id**, exactly as it does for local steps today. The
  engine's prefill and decode figures, and the server's predicted decode, then travel on the child's bar.
- **Only an exact join attributes a generation to a session from another runtime.** A hint is the requester's own
  claim: a runtime could tag its traffic with someone else's session. So a generation whose hint names a session
  whose records do not contain that request id is drawn as the box's traffic, labelled with what it CLAIMS
  (`serverGenNote`), never inside that session's band. (Within one runtime, the panel's own side tasks, which it
  recorded itself, are the exception they are today.)
- **Loads, serving periods and evictions** are claimed as `laneEvents` claims them now: a load belongs to the work
  that waited on it. A load a child's first request waited for sits under the child's step, in the tree's band.

### 6. The graph

- The memory tracks are the box's, so they are already shared: the child's model loading shows as the step in the
  trace, and its load rules are ruled through the plot like any other.
- The phase ribbon (each card's prefill and decode) is drawn from generations, so a child's work on a card is on it,
  coloured by model like everything else.
- A client showing runtimes and boxes separately (see Runtimes) draws one set of tracks per box and one lane per tree,
  so a tree that spans two boxes shows each box's tracks with the tree's bars against both.

### 7. What a client that cannot view the child sees

The child's generations still arrive in the box's stream. Without the child's session events they do not join, so
they are drawn as the box's traffic with the claimed runtime and session named, and the parent's spawning step shows
the subagent as a single span (its own step) rather than a subtree. Seeing the subtree requires `view` on the child,
which the spawn grant gives the orchestrator and inheritance gives the person's devices.

## The contract: making another server compatible

Anything that emits the contract can be a source: another box (a patched vLLM, a different local server), or a
runtime that is not this extension. Building those is out of scope for this project; making it possible and safe is
not. As the hub is implemented, this section becomes the published specification, with the schemas and test vectors
beside it, so a compatible server can be written from it alone.

**What is published** (as `docs/spec/hub/*.proto` plus a prose reference, versioned):

- **`Envelope`**: the only part the hub reads. Version, account, sender, recipient or stream, sequence number, flags,
  and the encrypted payload.
- **`SessionEvent`**: the session debug stream (agent start with lineage, steps with usage and phases, turns, asides,
  approvals), the objects `eventsFrom` derives the lane from.
- **`BoxFrame`**: a box's telemetry, the shape the patched Ollama's `/api/events` already emits (`hello` with the box
  id and server time, `sample` with `ps` and changed `info`, `load.*`, `busy.*`, `gen.start`/`gen.end` with timings,
  the echoed hint and the predicted decode, `evict`, `expires`), each with `v`.
- **`Hint`**: what a requester attaches to a model request and a compatible box echoes on `gen.end`: `use`, `session`,
  `request`, `runtime`, `root`, `after`, `synthetic`.
- **`Command`** and **`Capability`**: the signed commands and scope grants in Security and Principals and scopes.
  Their shapes, with the session index and the event envelope, are the session contract
  ([`SESSION_CONTRACT.md`](SESSION_CONTRACT.md)), which a client uses the same way against the local extension.
- **Conformance vectors**: recorded streams (real captures, as `tests/fixtures/hw/` holds for the box today) and the
  lane and chart each should produce, so an implementer can check they are drawn correctly.

**What a compatible box must do**: emit `BoxFrame`s over its stream with its own box id and clock in `hello`; echo the
request's hint on `gen.end`; report timings in the units named; send `info` when it changes. **What it may omit**:
anything optional in the schema. Absent means not reported, which the panel already says rather than inventing a
value (see `docs/FORKED-BACKENDS.md`, where every field of the patched Ollama is already optional).

**How the client handles a third-party source, securely:**

- **Every source is untrusted input.** Sizes, rates and field lengths are capped per source; an unknown kind or
  version is skipped, never guessed at; malformed frames are dropped and counted.
- **Nothing a source sends is markup.** Strings are rendered as escaped text (the rule the panel's tooltips already
  follow for content from outside), and no source can supply a link, a script or an image.
- **Attribution needs evidence.** A generation lands in a session's band only by an exact request-id join with that
  session's own records (see Rendering a subagent); a hint alone is a claim, labelled as one.
- **A source's clock is corrected, not trusted**: offsets are estimated per source, and a source whose clock jumps is
  flagged rather than redrawn.

## Distributed and multi-tenant servers: a worked example

What a compatible server built for many users would do: one deployment serving one model (or a few) across many GPUs
and nodes, with continuous batching, a paged KV cache and prefix caching, possibly with prefill and decode on
separate nodes (vLLM with tensor or pipeline parallelism, and clusters built on it). It is the kind of box the tenancy
rule leaves room for: the five concerns there are ones it can meet, because it authenticates every request and so
knows whose it is.

**What it emits** (the `BoxFrame` contract, with a few optional kinds):

- **`hello`**: its box id and clock, and its topology as capacity: nodes, GPUs, and the parallel layout.
- **`gen.start` / `gen.end` per request**, with the echoed hint and timings: queue time, prefill, decode, cached-prefix
  tokens. With prefill and decode on different nodes, each phase names where it ran, which the panel's per-card phase
  ribbon already draws.
- **Samples** whose moving parts differ from a workstation's: memory is flat (the weights never move), so it reports
  KV-block usage, batch size, queue depth and preemptions. These are optional kinds; absent means not reported.
- **Loads and evictions** rarely or never: placement is static.

**How it meets the five concerns** (see Tenancy):

1. **Telemetry.** It knows each request's account from its own authentication, never from the hint, and emits one
   stream per account: that account's generations in full, and coarse box-wide aggregates (utilisation, queue depth)
   with nobody else's hints.
2. **Control actions.** It offers tenants none: no unload, no placement; the operator owns those. It declares no
   control capabilities, and the client renders by capability, so the controls a workstation box has are not shown.
3. **Hints.** It schedules on authenticated identity and per-account quotas. A hint such as `use: interactive` can
   reorder a tenant's own requests within its own share, never another tenant's.
4. **The prompt cache.** Prefix-cache entries are scoped per account, so a cache hit can only come from the account's
   own earlier requests. (vLLM is believed to offer a per-request cache salt for this; to be confirmed.)
5. **Learned corrections** are mostly moot: decode speed is a property of the deployment, and nothing is kept alive or
   evicted. Anything learned per tenant stays per tenant.

**How the hub handles it.** It is the one principal that serves several accounts. Each tenant pairs it into their
own account (the tenant's credential for the server, and the server's key), and the server publishes each account's
filtered stream encrypted to that account's key. The hub routes per account as it does everything, and isolation still
holds twice: the hub reads only ciphertext, and a tenant holds only its own account's key. The server is trusted to
filter correctly, which is inherent in serving everyone: it already holds every request.

**What changes in the client**: box capabilities (`multi_tenant`, `placement: static`, which controls exist) so the
panel shows only what applies; an aggregate view for boxes with more devices than the chart's box shapes cover (they
reach about nine pools); and the client never sends an account in a hint, since the server derives it.

## Building the relay (a proposal)

Small, stateless where it can be, and scaled by account. Not a stream of JSON text.

- **Binary, schema'd framing.** Varint-length-delimited protobuf, the framing the extension already uses for the
  patched Ollama's chat stream (`protostream.ts`). One schema, generated code for every language an implementer might
  use, and protobuf's evolution rules match "switch on the kinds you know". Carried as WebSocket binary messages now
  (they work from a phone and through proxies), WebTransport later if head-of-line blocking matters.
- **The hub parses only the envelope.** A few fixed fields in front of an AEAD ciphertext. It never decodes a payload,
  so its cost per message is a header read and a queue push.
- **Batched and coalesced.** A source batches events into one frame per ~100 ms while busy. Box samples carry only
  what changed (the box already sends `info` only on change, and memory figures move rarely). Telemetry that is
  superseded before it is sent is replaced, not queued.
- **Compression, carefully.** Telemetry (numbers) compresses freely. Session events mix page content an attacker can
  influence (a hostile page's text reaches tool results) with things that must stay secret, and compressing those
  before encryption lets whoever sees ciphertext sizes (the hub) learn from them, the CRIME and BREACH class of
  attack. So session events are not compressed, or are padded to size buckets.
- **Backpressure by kind.** Each subscriber has a bounded queue. Telemetry for a slow subscriber (a phone on a poor
  connection) is coalesced and, past a limit, dropped with a marker; the panel already draws a reported drop as a
  hatched gap (`gapBefore`). Session events are state and are never dropped: a subscriber that falls behind on them
  is disconnected and resyncs from the ring.
- **Scaled by account, sharing nothing between accounts.** Connections are routed to a hub node by account (a hash of
  the account id at the load balancer), so an account's principals meet on one node and nodes share nothing. Each
  node keeps the bounded rings for its accounts in memory. The rings are a CACHE: the authoritative history is on the
  runtimes (saved sessions) and the boxes (their own rings), so a node lost is a reconnect and a backfill, not data
  lost. No database.
- **Large objects on their own channel.** Screenshots are requested, sent in chunks outside the rings, and never
  retained.
- **Approvals reach a sleeping phone by push**, carrying nothing but "an approval is waiting": the decision itself is
  made in the app, signed, over the relay.
- **Language**: Rust (decided 2026-09-17). Per-connection memory stays small, and `prost` covers the protobuf framing.

## Runtimes

- A runtime registers under its public key and a name, with **capabilities**: whether it has tabs, can take
  screenshots, has the Python sandbox, which models and boxes it can reach, whether it can run headless, and (a
  desktop runtime) shell, processes and input. Clients render by capability, never by assuming a browser.
- It declares which **boxes** it uses, so a client can show their telemetry beside its sessions.

## Protocol

- **Session events** are the debug stream every surface already reduces (`__mlDebug`, the same the DevTools panel
  receives from the background), versioned with a schema. A runtime that emits the format is drawable, whatever it
  is.
- **Reconnects** follow the design the patched Ollama event stream already proved: a hello, a bounded ring of recent
  events per source (ciphertext, so the hub still reads nothing), and a backfill on reconnect.
- **Commands** (signed, scoped): send a message to a session, start a session (on a chosen tab, a blank tab, or
  headless when offered; with `lineage` when started by an agent), cancel, answer an approval, list tabs, request a
  screenshot; on a desktop runtime, start a process and send input.
- **Renderables** already travel as data: tool renders are descriptors (`renderIn`/`renderOut`), because
  background-hosted runs ship them across the page bus, which is also why a live DOM node becomes a count or a
  description. Tables travel as their data. **Screenshots** are on demand and size-capped.
- **Transport**: websockets. The hub is small and stateless apart from the rings; any low-overhead language will do.

## Orchestration: agents that drive other agents

The longer-term case: a root agent on a page that is a canvas over a desktop, issuing commands to the computer (such
as starting browsers) and driving subagents in those browsers.

- **An agent can be a client.** The orchestrator holds a key the way a phone does (in its runtime's background
  worker, never in a page), watches subagent sessions through the same events, and sends them the same signed
  commands. The protocol does not distinguish a person from an agent; scopes do.
- **A desktop runtime.** Commands to the computer come from a small daemon that registers as a runtime with shell,
  processes, desktop screenshots and input. Clicking a remote-desktop canvas also works (the extension already sends
  trusted input into a canvas through CDP), but real input and process commands are more reliable than pixels, so the
  canvas is better as the person's view than as the agent's control path.
- **Authority flows down by capability** (see Principals and scopes): starting a runtime yields `view` and `drive` for
  that runtime only; the orchestrator never holds `approve` by default; the desktop runtime's shell commands are
  approval-gated the way `exec` is, and `desktop` is a scope a person grants.
- **The tree is drawn as one** (see Rendering a subagent), in the root's own lane, on any client with `view` on the
  sessions in it.
- **Subagents are not only browsers.** A browser app with the extension injected, an app driven through accessibility
  APIs, or a specialised wrapper (a CAD tool) is a runtime like any other if it speaks the contract (see The contract):
  its own `kind` (the enumeration is open), its tools as steps, its output as render descriptors with fallbacks.
- **Blocked, it asks.** A subagent that hits a captcha, a login or a question it cannot answer opens a gate, and the
  gate goes where the spawn said: to the coordinator, to the person's devices, or both. Approvals go only to people
  whatever it says. A takeover gate is answered by a person driving the page through remote control
  (`SESSION_CONTRACT.md` §Proposed: gates).
- **Its result is a pointer.** The spawning step gets a preview and an ordinary `@tool:` token; the value stays on the
  child's runtime and is read on demand, paged (`value.read`). The relay therefore carries long paged reads, bounded
  by its per-account limits like any other traffic.
- **The desktop canvas knows whose windows are whose.** Display frames can name regions by session, so the
  coordinator's view masks the windows its subagents drive and its input cannot land in them.

This is the goal approvals over IPC were built toward (`docs/dev/agent-tools.md` names it: one wrapper driving a
desktop with delegated subagents), and it overlaps [`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md), where subagents and
headless runtimes are still open.

## Open

- **MV3 lifetime.** The extension's service worker is evicted when idle. A websocket with regular traffic is believed
  to keep it alive in current Chrome (since around Chrome 116); if not, the socket lives in the offscreen document.
  To verify before building.
- The pairing flow's exact UI, and key storage on each side.
- Group keys for box telemetry: rotation when a device is unpaired.
- Whether the local chat page also connects to the hub to show other runtimes, or stays local-only.
- How much history a client can pull (the rings are bounded; saved sessions live on the runtime).
- Frame sizes and flow control for paged value reads (`value.read`), which can run to hundreds of megabytes.
- The hint fields (`runtime`, `root`) need the patched Ollama's agreement before use.
- The schemas and conformance vectors (see The contract) are written as the hub is implemented, not before.

## Related

[`CHAT_PAGE.md`](CHAT_PAGE.md) (the client), [`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md) (runtimes without a visible
page), [`SECRET_HANDLES.md`](SECRET_HANDLES.md) (the same "the relay must not be able to" stance, for credentials),
`docs/dev/resource-panel.md` (the lane and graph this extends), `docs/FORKED-BACKENDS.md` (request hints).
