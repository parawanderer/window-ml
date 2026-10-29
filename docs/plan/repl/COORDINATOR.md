# The coordinator's handover: how the REPL work is steered, for whoever picks it up

Written 2026-10-15 by the first coordinating session (`repl-specs`, Claude Fable), ahead of its session limit, so that any
model, in any clone, can take the role. The role is small and specific: **answer the lanes' architecture questions,
write every ruling into the spec it changes within the hour, and keep the plan's status true.** It writes no lane code.

## How the lanes reach you

- Session-mail (`~/git/session-mail/README.md` is the protocol): lanes write to `repl-specs`; keep that work slug so
  their mail finds you. Reply by mail for anything with detail, and by a direct session message for the one-line
  version, since a lane may be busy and read only one of them.
- Direct session messages (`ListAgents` names them `[window-ml repl LANE_n_…]`). The red-team session is
  `window-ml-redteam-29`; the site-access session is `window-ml-69`.
- A lane never blocks on you: it states its assumption and continues. So an answer that arrives late must say whether
  the assumption held, and if it did not, what to undo.

## The rules the rulings have followed (apply them before inventing new ones)

1. **Narrow beats wide, and fail closed.** When two readings of a spec differ in how much runs without asking, take the
   narrower one and write it down; widening is a decision for Shane. Examples today: run-scoped URL policies (#699),
   the preview on the main-world fallback (root J), run policies removed at archive (#707).
2. **A universal over a set, never an exclusion list.** The default policy is "every element is …", so a new
   operation cannot slip through unnamed (EFFECTS.md, #671).
3. **Describe, decide, enforce are three layers.** A manifest describes, a policy decides, a sandbox enforces; a ruling
   that moves a job between layers is wrong (EFFECTS.md, "Three layers"). Under a sandbox, a description is enforced as
   the envelope (PROGRAM_MANIFEST.md, "Registering a program").
4. **The sender, never the message.** Authority comes from what the worker can verify about who sent a message (the
   origin gate, the ml wire's sender rule, the SET_APPROVAL tab check in #710), never from a run id or a field in it.
5. **Placement is unobservable, up to the recorded environment.** The same script gives the same result wherever it
   runs; a test that enumerates placements is the proof (root J's). The one deliberate exception is named with its date
   (the 2026-10-08 main-world fallback, POINTER_VALUES.md slice 9).
6. **No proxies across a boundary.** Copies, pointers and handles cross; a live object never does (ML_WIRE.md, the
   lockdown's step 4).
7. **A ruling is written into the spec in the same hour**, with the date, who found the case and why, and the PR
   number; a spec that contradicts code is a defect. The lane cites the spec, never a message.
8. **Measure before claiming.** A corpus count decided the dialect's subset; lane 4 measured that an empty
   `diff.external` pin breaks git before the spec said so (#682); lane 3 measures the no-specialization build's cost
   before anyone cites it. When a lane offers a number, take the number over the argument.
9. **A finding that touches a shipped surface goes to its owner the same day**: the site-access session for consent and
   the origin gate, the red-team session for anything that is an escape.
10. **The classifier rule.** A session that has worked on an exploit may be stopped on defence work afterwards. Keep
    exploit work and defence work in different sessions; a defence design is written as a document that names no
    recipe (PYODIDE_LOCKDOWN.md), so a fresh session can build it.
    AMENDED 2026-10-28 (the #1274 incident): the finder's rows merge first as a test-only PR, the builder's fix PR
    after, and the finder flips its node:test todos on the fix's merge sha. A Playwright failing-first row cannot
    wait for that sha: `test.fail` goes red the moment the fix makes it pass, so the fix PR's CI cannot go green.
    For an e2e row the finder pushes the flip as its own commit onto the builder's branch, touching only its own
    files, before the fix PR merges; the builder never edits the finder's file either way.

## Open threads, as of 2026-10-15 evening

| Lane | In flight | Waiting on | Decided, not yet reflected |
| --- | --- | --- | --- |
| 1 (fresh session) | root J, PR #705 | the lockdown, for PR 2 (`ml` in Pyodide) and root C | the fallback keeps the preview (Shane); PR 2 uses lane 4's nested asks, builds no ask path of its own |
| 2 | #706 (`sh` consumer, `judgeCall` asks while unloaded), #709 (policy vectors); then 3b (rows, re-judging), 3c (model-proposed policies as a tool: registry + red-team) | lane 4's #710 for re-judging a nested ask | the archive rule (#707); the told-on-unarchive line |
| 3 | the CPython fork (`parawanderer/cpython`, branch `ml/restricted-mode`): no-specialization build compiling, baseline numbers, then `CO_RESTRICTED`, `_restricted`, the predicate; #703 (one Node leg in CI) | nothing | C now, A later; restriction is a property of the entry (#711); the dialect row in the README takes the first measured cost |
| 4 | #710 (nested asks); then the `ml.sh` PR (native port, settings, capabilities, the isolated op, the wire member, pointers, the version probe) with its red-team pass | nothing | a dialect-defined command is invoked through `_restricted.call`; root K's Landlock details |
| red-team | #698 (vectors, todo until the lockdown), #708 (interim mitigations); then the lockdown from main per PYODIDE_LOCKDOWN.md, six steps | nothing | P5 ruling (step 6) |
| site-access | #647 merged 2026-10-15 (ac417a98). As of 2026-10-23 (the session's own report, shas checked): SITE_PRESENCE step 2a hidden by default (#993, 85adc9f1), the demos for hidden pages (#997, 8a5fca34), the Node 26 pin (#1000, a900d3c5); #987 (the cancel route matrix) approved, merges on green. In progress: step 2b, the MessagePort between `injected.js` and the content scripts, `feat/presence-2b-port` (55dfe772), code-complete, four red-team gaps fixed with tests, one documented residual (a page given `injected.js` late can still take the port); then slice 3 PR 3, PR 4 (new strings; since 2026-10-27 shipped without approval, Shane reports offenders later), step 3 (exec in the isolated world by default), then measuring `use_dynamic_url`. Unowned: issue #1005 (a hidden page's overlay lists none of the person's own runs after a reload) | PR 4's strings | told about the REPL overlaps and the SET_APPROVAL fix |

Unassigned roots: K (registering a program). Done this round: A, B, D, E, F, G, I, and lane 4's second round under way.

## For Shane, outstanding

- The host repo's Linux sandbox CI is in (host #5); nothing else waits on him except PR 4's strings (site-access) and starting nothing new.
- When lane 3 reports the no-specialization cost, put the number in the README's dialect row (one line).

## If you are a different model

Read, in order: `README.md` here, the lane files, the specs the lanes cite, this file. Then check session-mail for
anything addressed to `repl-specs` that has no reply. The lanes are Claude sessions; they read your messages literally,
so write a ruling as a ruling (what, why, where it is written). Post nothing on GitHub without the session trailer the
repo requires (AGENTS.md, "Branches, PRs and CI").
