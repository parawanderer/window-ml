---
name: idea-continue-past-step-cap
description: "Backlog (do AFTER the bugs): a run that STOPPED at the step cap gets a 'give it more steps + continue' button — raise maxSteps and resume from that exact state, not a fresh reply"
metadata:
  node_type: memory
  type: project
---

Shane, watching a run hit "Stopped at the 20-step cap without finishing": you can reply to continue, but that
starts a NEW turn — annoying when the model was mid-task and just needed more room. Want a **button on the
`hitCap` result** (HUD card + sidebar/panel) that ALLOCATES MORE STEP BUDGET and **continues from that exact
state** — i.e. raise `maxSteps` and re-drive the SAME loop, not a fresh user reply.

**Why it's more than a reply:** a composer reply appends a user turn and re-enters; the model re-reads context
and may re-plan. "Continue with +N steps" should just lift the cap and let the loop keep going from where it
stopped (its history is intact). The resume machinery already exists — `agentRegistry.resume(task)` /
RESUME_RUN with an EMPTY follow-up continues a run by hash. The knob is `maxSteps`: `control.maxSteps` is read
fresh each step and a handle can raise it mid-run (see the createAgent control). So the button = "raise
maxSteps by N, resume('')".

**Sketch:** the `agent-result` with `hitCap:true` carries the run hash → the card/sidebar shows a
"Continue (+20 steps)" button next to "Reply to continue". It posts a new app→parent message (e.g.
`__mlSidebarApp:"continueRun" {hash, addSteps}`) → shell/background → the run's resume handle, first bumping
maxSteps. Mirror in panel.ts (reverse channel, like SET_APPROVAL). A quick-pick for the amount (+10/+20/+50)
or just a fixed bump. Background path: RESUME_RUN already re-drives by hash; add a `maxStepsDelta` to its
payload so the cap is raised before the continue.

Neighbours [[idea-agent-as-live-controllable-object]] (this is the "raise maxSteps mid-run" affordance made a
button) and [[idea-prompt-from-ui-hud]]. Status: BACKLOG, queued AFTER the HUD-after-nav + status-color bugs.
