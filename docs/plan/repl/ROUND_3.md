# Round 3: five lanes on the unassigned list (opened 2026-10-19)

The shared half of five handoffs. Each lane reads this file once, then its own `LANE_n_*.md`, then the spec its lane
file names. Nothing here repeats what [`README.md`](README.md) (the plan), [`COORDINATOR.md`](COORDINATOR.md) (the
rules) and the repo's `AGENTS.md` already say; read those three first, in that order, and `~/git/session-mail/README.md`
for the mail protocol.

## The lanes

| Lane | Session title | Mail slug | Clone | Model | Brief |
| --- | --- | --- | --- | --- | --- |
| 5 | `[window-ml repl LANE_5_PYODIDE_BUILD]` | `repl-lane5` | `~/git/window-ml-repl-lane5` | Sonnet (MiMo until 2026-10-19 evening) | [`LANE_5_PYODIDE_BUILD.md`](LANE_5_PYODIDE_BUILD.md) |
| 6 | `[window-ml repl LANE_6_FOLLOWUPS]` | `repl-lane6` | `~/git/window-ml-repl-lane6` | Sonnet (MiMo until 2026-10-19 evening) | [`LANE_6_FOLLOWUPS.md`](LANE_6_FOLLOWUPS.md) |
| 7 | `[window-ml repl LANE_7_MODE]` | `repl-lane7` | `~/git/window-ml-repl-lane7` | Sonnet | [`LANE_7_MODE_REMOVAL.md`](LANE_7_MODE_REMOVAL.md) |
| 8 | `[window-ml repl LANE_8_PAIRING]` | `repl-lane8` | `~/git/window-ml-repl-lane8` | Sonnet | [`LANE_8_PHONE_PAIRING.md`](LANE_8_PHONE_PAIRING.md) |
| 9 | `[window-ml repl LANE_9_WHY_ASKS]` | `repl-lane9` | `~/git/window-ml-repl-lane9` | Sonnet | [`LANE_9_WHY_ASKS.md`](LANE_9_WHY_ASKS.md) |

The clone is ready: `.env` and `pyodide-wheels` symlinked, `core.hooksPath` set, `npm ci` and `npm run build` done.
Work ONLY in your clone, on a branch, through a PR with `@` topic labels; never in `~/git/window-ml` or another
lane's clone. Remove the clone when your last PR has merged and it holds nothing unpushed.

## Who to ask, and when

Ask a PEER first; the coordinator is the expensive model and is for rulings, not for obvious things. A question is
obvious when the spec answers it or a peer owns the code. Direct messages go to the session title (`ListAgents` shows
it); mail goes to the slug.

| Session | Title (direct message) | Mail slug | Ask it about |
| --- | --- | --- | --- |
| coordinator | `[window-ml policies/python/desktop/manifests coordinator] continuation` | `repl-specs` | a spec that is silent or contradicts code; anything that widens what runs without asking; which of two readings; a decision that is Shane's |
| lane 4 | `[window-ml repl LANE_4_HOST] continued` | `repl-lane4` | the process host (window-ml-host), `ml.sh`, nested asks, approval cards, the K3 envelope and tripwire |
| the generalist | `window-ml-mimo-generalist` (Opus from 2026-10-19 evening; the title keeps its old name) | `repl-lane3` | the Pyodide worker, the CPython fork, the dialect vectors, the extension side of K3 |
| the red team | `window-ml-redteam-e3` | `redteam` | an escape, a failing-first test for a property, a review of something security-shaped (it never builds the defence) |
| the CI janitor | `window-ml-flaky-3f` | `flaky-ci` | a CI failure that is not yours, the known-bad list, a review when no owner is free (window-ml only, never the host repo) |
| lanes 5 to 9 | the titles above | the slugs above | each other, when one's file overlaps another's |

Rules that apply to every lane, from `COORDINATOR.md`: never block on an answer (state the assumption, continue, say
so in the PR); measure before claiming; a finding on a shipped surface goes to its owner the same day; a lane that
has written an exploit does not build its defence. Every GitHub post carries the session trailer `AGENTS.md`
requires; merge your own PR with `node scripts/merge-when-green.mjs <pr> --wait --merge --session <id>` once it is
green AND reviewed (a review from a peer, named in the lane file). Mail the coordinator when a PR merges, one line, and
when a lane is CLOSED, with a `LANE_n_RESULT.md` next to this file: what was built, what was measured, what was
assumed where a spec was silent, what is left.

## What is shared

Lanes 5 and 6 both touch the Python worker (`src/python/`), lanes 7 and 9 both touch the approval card and the run
log, and lane 7 touches the Python tool's text that lane 5 ships under. Before editing a file another lane names in
its brief, message that lane; whoever is second rebases. Lane 8 is alone in `mobile/` and `src/pairing/`.
