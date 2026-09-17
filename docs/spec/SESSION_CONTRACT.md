# Spec: the session contract, what a session source offers a client

**Status: agreed contract, version 1** (2026-09-17). The types are in [`src/session-host.ts`](../../src/session-host.ts);
this document is the prose and the reasons. The user-to-agent surface is final for version 1. The agent-to-agent parts
are typed and marked RESERVED: their shape is fixed so they can be added without a breaking change, but no runtime
offers them yet.

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
  extension's key-derived id once it has one, and `local` until then.
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
  `sideCalls`, `pythonBench`, `resourcePanel`, `localSettings`, and the reserved `headless` and `lineage`) and which
  `boxes` it uses. **Absent means no.** A client renders by capability and never assumes a browser.
- **`grants`**: what THIS client may do there, as scopes (`view`, `drive`, `approve`, `screen`, `desktop`), each
  optionally narrowed to `started` sessions, a list of sessions, or an expiry. The local host holds every scope.
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
| `approval.answer`: by the pending step's `seq`; `persist`, `feedback` | approve | | `approval` → `SET_APPROVAL` → `resolveApproval` |
| `chat.start` | drive | `chat` | nothing background-hosted |
| `agent.start`: on a tab, a blank tab, or (reserved) headless | drive | `agent`, `tabs`, `headless` | `startRun` → the page → `START_RUN` |
| `tabs.list` | drive | `tabs` | nothing |
| `tab.screenshot`: on demand, size-capped | screen | `screenshots` | `CAPTURE_TAB` |
| `page.highlight`: a selector, a canvas token, or clear | drive | `highlight` | `__mlHighlight` → `ML_HL_REMOTE` |
| `side.call`: a utility-model call about a session | drive | `sideCalls` | `FETCH_LLM` with `extend: "utility"` |

Sessions started by a command are **saved unless `ephemeral: true`**, per the chat page's persistence decision.

**Errors** are `unsupported`, `forbidden`, `not-found`, `invalid`, `conflict` (not possible in the session's state),
`unavailable` (runtime offline), `aborted` (the caller's signal fired; the command may still have been delivered), and
`failed`. An `approval.answer` for a gate that already closed is not an error: it returns `{ resolved: false }`, and
the session's events show what happened.

### Approvals

A remote approval is a command handed to the runtime's **one `resolveApproval`**, the same function the sidebar's
click and the IPC channel reach. Nothing new decides a gate, and `approve` is never implied by `drive`. The consent
model does not change: a gated tool still asks, and remote driving only adds places to answer from.

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

## Agent to agent (reserved)

The shapes are fixed now so the link is additive later:

- **An agent is a client** (`Principal.kind: "agent"`) using this same interface. The protocol does not tell a
  person from an agent; grants do.
- **`agent.start` takes `lineage`**: the parent session and the spawning step's `seq` and request id. The child's
  `SessionSummary.lineage` carries it back, and the lane hangs the child under `step:<parent key>:<seq>`
  ([`RUNTIME_HUB.md` §Rendering a subagent](RUNTIME_HUB.md)).
- **A `started` grant** is what an orchestrator holds over what it spawned.
- **A `headless` target** needs `capabilities.headless`.

Runtimes today declare neither `lineage` nor `headless` and answer both with `unsupported`.

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
- **Only while someone watches.** It starts on subscribe and stops on unsubscribe, when the client's connection drops,
  or after an idle limit. While a stream is open, the runtime's own sidebar says so and names who is watching.
- **Every frame is also a `frame` for input**, so tapping the live view uses the same command as tapping a screenshot.
- **Later, real video** (WebRTC from `tabCapture` or a desktop capture) for smooth frame rates. Media would flow outside
  the relay's envelope, so it keeps the hub blind only if the runtime and the device check each other's DTLS
  fingerprints, signed by their paired keys. A different security story, so it waits until frames are not enough.

## Not in the contract

Display preferences and themes (client storage); the envelope, keys, pairing and encryption (hub transport); box
telemetry (`BoxFrame`, its own feed per `RUNTIME_HUB.md` §Telemetry); settings editing beyond the `localSettings`
flag.

## On the wire

The hub parses only its `Envelope` (`docs/spec/hub/*.proto`, written with the hub). Inside the ciphertext, version 1
carries these shapes as JSON: `MlDebugEvent` is an `@unstable`, growing type with a checked-in JSON schema, and a
parallel protobuf definition of it would be the second event format this contract refuses. The commands, index and
capabilities get protobuf messages with the hub; the event payload moves to protobuf only if its schema settles.

## Open

- **Who answered an approval.** `DebugAgentStep.approval` says `user`; with several people and devices it should also
  name the principal. An additive field on the step.
- **The local runtime's id** before the extension has a key, and how the chat page avoids showing the same browser
  twice once it also connects to the hub.
- **`session.send` for a chat** needs a background-hosted chat, which does not exist yet.
- **Index size**: whether a snapshot pages once a runtime has thousands of saved sessions.
