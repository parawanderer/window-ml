# Spec: the runtime hub, driving agents from anywhere

**Status: agreed direction, not started** (2026-09-15). Security comes first in this document because it is the
whole design: everything after it is plumbing that must not weaken it.

## What it is

A small relay server that agent **runtimes** register with and **clients** connect to. A runtime is anything that
runs agents and emits the session event stream: this extension in a browser, a second browser on another machine,
later a headless or container runtime. A client is anything that shows sessions and drives them: the chat page
([`CHAT_PAGE.md`](CHAT_PAGE.md)), a phone. The motivating case is a browser with the extension at home, driven from
a phone: watch the session, send it messages, answer its approvals, and look at the agent's tab on demand.

## Security

**The asset.** A runtime holds a logged-in browser: credentialed fetches as you, CDP clicks and typing, the Python
sandbox, every site you are signed in to. Whoever can send it commands has all of that. So the design is judged by
one question: what can someone who controls the hub, or sees its traffic, make a runtime do? The answer has to be
nothing.

1. **Runtimes connect out and never listen.** No port is opened on the machine running the browser. The runtime
   dials the hub; the hub never dials it.
2. **Devices are paired, with keys.** Each runtime and each client device has its own keypair. Pairing is done in
   person (a QR code or a short code shown on the runtime, confirmed on the device), and the runtime keeps an
   allowlist of the device public keys it will take commands from. Unpairing a device is removing its key.
3. **End-to-end encryption between runtime and device.** The hub relays ciphertext and routing metadata only, so a
   compromised hub can read nothing and forge nothing. (Options to evaluate: the Noise protocol framework, or
   libsodium boxes per pair.)
4. **Commands and approvals are signed.** A remote approval must be as unforgeable as a click in the sidebar, so it
   is a decision signed by a paired device: `{ runtime, session, gate, decision, nonce, time }`, verified by the
   runtime and then handed to the same single `resolveApproval` every other surface uses (see approvals over IPC in
   `docs/dev/agent-tools.md`). Every command is signed the same way; nonces and a clock window stop replays.
5. **Scopes per device.** A device can be paired to view, to drive (send messages, start and cancel runs), or to
   approve. A phone that should only watch cannot be talked into approving.
6. **The consent model does not change.** Approval-gated tools still ask. Remote driving adds a place to answer
   from; it does not remove a question.

**What the hub can still do**, stated so nobody assumes otherwise: drop or delay messages, see who is online and
when, and see the sizes and timing of traffic. It cannot read or originate a command.

**Residual risk**: a paired device that is compromised can do what its scope allows. That is why scopes exist and
why approving is its own scope.

## Runtimes

- A runtime registers under its public key and a name, with **capabilities**: whether it has tabs, can take
  screenshots, has the Python sandbox, which models it can reach, and whether it can run headless. Clients render
  by capability, never by assuming a browser.
- **Sessions are keyed by runtime and hash.** Hashes are 8 hex characters and will collide across runtimes.
- **Runtimes are not GPU boxes.** Several runtimes may share one Ollama server. The resource panel's data belongs to
  the box, so a client shows runtimes (whose agents) and boxes (whose GPU) as separate things.

## Protocol

- **The event stream is the session debug stream** every surface already reduces into session state (`__mlDebug`
  events, the same the DevTools panel receives from the background). It becomes a versioned contract with a schema,
  the way `docs/spec/export.schema.json` is for exports: runtimes will be different builds, and a client switches
  on the kinds it knows. A runtime that emits the format is drawable, whatever it is.
- **Reconnects** follow the design the patched Ollama event stream already proved here: a hello, a bounded ring of
  recent events per runtime (ciphertext, so the hub still reads nothing), and a backfill on reconnect.
- **Commands** (signed, see Security): send a message to a session, start a session (on a chosen tab, a blank tab,
  or headless when a runtime offers it), cancel, answer an approval, list tabs, request a screenshot.
- **Renderables** already travel as data: tool renders are descriptors (`renderIn`/`renderOut`) because
  background-hosted runs ship them across the page bus, which is also why a live DOM node becomes a count or a
  description. Tables travel as their data.
- **Screenshots are on demand**, never pushed: the device asks, the runtime captures the agent's tab and sends it,
  size-capped.
- **Transport**: websockets. The hub is small and stateless apart from the rings; any low-overhead language will do.

## Orchestration: agents that drive other agents

The longer-term case: a root agent on a page that is a canvas over a desktop, issuing commands to the computer (such
as starting browsers) and driving subagents in those browsers. The hub carries it with three additions, and a
stricter security rule, because an orchestrator is exactly what a prompt injection would want to take over.

- **An agent can be a client.** The orchestrator holds a paired key the way a phone does, watches subagent sessions
  through the same event stream, and sends them the same signed commands. The protocol does not distinguish a
  person from an agent.
- **A desktop runtime.** Commands to the computer come from a small daemon on it that registers as a runtime, with
  capabilities such as shell, processes, desktop screenshots and input. Clicking a remote-desktop canvas also works
  (the extension already sends trusted input into a canvas through CDP), but real input and process commands are
  more reliable than pixels, so the canvas is better as the person's view than as the agent's control path.
- **Lineage across runtimes.** A subagent's session records its parent: the root session, possibly on another
  runtime. The client can then draw the tree, and the request hints tell the GPU box it is one tree of work. The
  lane already nests by `parent` within one runtime; this extends it across runtimes.

**Authority flows down by capability, and approvals stay with people.**

- Starting a runtime returns a capability for THAT runtime only. The orchestrator can drive what it started and
  nothing else, the same object-capability stance as [`SECRET_HANDLES.md`](SECRET_HANDLES.md).
- The orchestrator gets the drive scope, not the approve scope. A subagent's approval still goes to a person's
  paired device or the sidebar. Letting an agent approve would be an explicit, scoped decision made by a person,
  never a default.
- The desktop runtime's shell is the most dangerous capability in the whole system, and its commands are
  approval-gated the way `exec` is.

This is the goal approvals over IPC were built toward (`docs/dev/agent-tools.md` names it: one wrapper driving a
desktop with delegated subagents), and it overlaps [`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md), where subagents and
headless runtimes are still open.

## Open

- **MV3 lifetime.** The extension's service worker is evicted when idle. A websocket with regular traffic is
  believed to keep it alive in current Chrome (since around Chrome 116); if not, the socket lives in the offscreen
  document. To verify before building.
- The pairing flow's exact UI, and key storage on each side.
- Whether the local chat page also connects to the hub to show other runtimes, or stays local-only.
- How much history a client can pull (the rings are bounded; saved sessions live on the runtime).

## Related

[`CHAT_PAGE.md`](CHAT_PAGE.md) (the client), [`HEADLESS_AGENTS.md`](HEADLESS_AGENTS.md) (runtimes without a
visible page), [`SECRET_HANDLES.md`](SECRET_HANDLES.md) (the same "the relay must not be able to" stance, for
credentials).
