# Open topic: headless agents, subagents and background runs

**Status: open, deliberately deferred** (noted 2026-09-15). A spawned run's handle is a detached call's handle:
[`ASYNC_CALLS.md`](ASYNC_CALLS.md) owns that shape (await, cancel, join, the inbox return) and this file uses it. The chat page ([`CHAT_PAGE.md`](CHAT_PAGE.md)) shows a
disabled "headless" option as a placeholder for this.

## What exists today

- **Background-hosted runs**: the loop lives in the service worker and delegates DOM tools to a bound tab
  (`run-delegation.ts`). They need that tab.
- **Eviction**: MV3 evicts the service worker after about 30 s idle. Runs are mirrored to storage and resumed on
  respawn, with the gaps recorded in the design-A eviction notes (an evicted run idle at an approval gate resumes
  only when its page next loads).
- **Approvals over IPC** (`__mlApprovals`): a gate can be resolved from outside the browser, which is the control
  channel an external driver would use.
- **Lineage in the lane**: events carry `id` and `parent`, so a sub-call already nests under the step that made it.

## What is not decided

- **Where a headless agent's page lives**: a hidden tab, an offscreen document, a CDP headless target. Each has
  different limits (what it can render, what CSP it runs under, whether it survives the service worker).
- **Subagents**: how a run spawns another and where the child's page lives. The contract side has a direction
  (`SESSION_CONTRACT.md` §Agent to agent, 2026-09-17): a subagent's result comes back as a remote tool result, a
  preview plus a pointer whose value stays on the child's runtime; a blocked child opens a gate (approval, question,
  takeover) routed by `escalate`; a work order on the start carries the child's tools, budget and result schema; the
  child nests under the spawning step through `lineage`, and `started` grants cover the whole subtree. PROPOSED 2026-11-07 (Shane's question through the chat-page lane, "could a subagent simply be a fork"; the
  coordinator's recommendation, nothing built, no lane named, for Shane to accept or change): **a fork, by
  reference.** Not by passing messages: an extension-hosted run refuses a first turn carrying its own history
  (API.md, `fork()`), deliberately, since such a run trusts that a user turn is the person's and a tool result the
  tool's, so a caller-supplied history could forge an approval or a page read; `host: "page"` forks fine because that
  run has only the page's powers. The safe shape is `fork: <run hash>` on the work order: the WORKER copies its own
  stored history of that run and never accepts one from the caller. Rulings proposed on the open points: (1) grants
  and approvals are NOT inherited, the child asks again (a grant is to a run, not a lineage; `started` covers the
  parent's ask having happened, not the child's own asks); (2) the `@tool:` values and the `@file:` shelf the copied
  history names are readable by the child as shared, immutable values, or the copied context is damaged, the child's
  new values its own, nothing of the parent's writable from the child; (3) the child never drives the parent's tab, it
  starts on its own blank tab (`blankStart`), and a fork that needs the parent's page is a steer, not a fork; (4) reach:
  a fork is started by the subagent-spawning tool's work order, never from the read-only dialect, which does not reach
  `ml.agent`; (5) cost is an open measurement: the child prefills the whole context, and a backend's prefix cache helps
  only if the children do not contend for one slot. A red-team pass by e3 when built, as a new way to start a run.
  Settled the same day: a model CAN read its own whole history as data in `exec` (`ml.current.messages` is complete
  and only the print abridges, as `CURRENT_CONTEXT.md` decided); the inspector's `run.messages` row is a preview of
  the same data, not the source, which is what made it look cut.
- **Runs that outlive the service worker by design**: long or scheduled work rather than a run that happens to
  survive an eviction.
- **The box**: several agents at once on one GPU box compete for it. The request hints (`use`, `session`) are where
  the server would learn that they are one tree of work.
- **Proposed: a child's status, when its parent asks for it** (Shane, 2026-10-22). A work order may ask the child to
  report status; the child then appends a short status entry now and then: what it last did, in a sentence, and a timestamp.
  Nothing is edited in place, the way `AGENT_MAIL.md` keeps messages immutable: the child's current status is its
  newest entry, and "last updated" is that entry's time. The parent, the session list and the agent graph read the
  newest entry; the whole list is the child's progress log. Open: the cadence (the work order's, the child's
  judgement, or both), whether an entry counts against the child's budget, and whether a status the child stops
  updating is shown as stale after some time. It sits beside `SESSION_CONTRACT.md`'s digest ("A digest instead of the
  event stream"), a status line the child's RUNTIME derives on its utility model: the entries are what the AGENT says it
  did, the digest what the runtime saw; which one a parent reads first, or whether the digest is built from the entries,
  is not decided.
