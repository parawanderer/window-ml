# Open topic: headless agents, subagents and background runs

**Status: open, deliberately deferred** (noted 2026-09-15). The chat page ([`CHAT_PAGE.md`](CHAT_PAGE.md)) shows a
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
- **Subagents**: how a run spawns another, what the child may do (its own tools, its own approvals, a budget), how
  its session nests under the parent's in the sessions list and the lane, and whether its result comes back as a
  tool result or a pointer.
- **Runs that outlive the service worker by design**: long or scheduled work rather than a run that happens to
  survive an eviction.
- **The box**: several agents at once on one GPU box compete for it. The request hints (`use`, `session`) are where
  the server would learn that they are one tree of work.
