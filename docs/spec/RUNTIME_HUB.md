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
- **A box shared between users is the hard case.** A box's telemetry is box-wide: its `gen.end` frames carry every
  requester's hints. On a box shared across accounts, relaying its raw feed to one user would show them the other's
  sessions and timings. So a cross-account box needs its stream filtered PER ACCOUNT at the box (hints would carry the
  account, and the patched Ollama would serve each subscriber only its own generations plus the box's aggregate
  memory), rather than a connector relaying everything. Until that exists, a box is shared only within one account.

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
- The hint fields (`runtime`, `root`, and `account` for shared boxes) need the patched Ollama's agreement before use.
- Per-account filtering of a shared box's stream, at the box.

## Related

[`CHAT_PAGE.md`](CHAT_PAGE.md) (the client), [`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md) (runtimes without a visible
page), [`SECRET_HANDLES.md`](SECRET_HANDLES.md) (the same "the relay must not be able to" stance, for credentials),
`docs/dev/resource-panel.md` (the lane and graph this extends), `docs/FORKED-BACKENDS.md` (request hints).
