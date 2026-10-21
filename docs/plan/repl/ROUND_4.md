# Round 4: three lanes on what round 3 left (opened 2026-10-21)

The shared half of three handoffs. Each lane reads this file once, then its own `LANE_n_*.md`, then the spec its lane
file names. Nothing here repeats what [`README.md`](README.md) (the plan), [`COORDINATOR.md`](COORDINATOR.md) (the
rules) and the repo's `AGENTS.md` already say; read those three first, in that order, and `~/git/session-mail/README.md`
for the mail protocol.

## The lanes

| Lane | Session title | Mail slug | Clone(s) | Model | Brief |
| --- | --- | --- | --- | --- | --- |
| 10 | `[window-ml repl Sonnet]` | `repl-lane10` | `~/git/window-ml-repl-lane10` | Sonnet | [`LANE_10_SMALL_ITEMS.md`](LANE_10_SMALL_ITEMS.md) |
| 11 | `[window-ml repl Opus]` | `repl-lane11` | `~/git/window-ml-repl-lane11`, `~/git/window-ml-host-lane11` | Opus | [`LANE_11_HOST_AND_POLICY_TREE.md`](LANE_11_HOST_AND_POLICY_TREE.md) |
| 3 | `[window-ml repl LANE 3]` | `repl-lane3` | `~/git/window-ml-repl-lane3`, `~/git/cpython-restricted` | Opus | [`LANE_3_WRAPPER_NUMBER.md`](LANE_3_WRAPPER_NUMBER.md) |

**Make your own clone this round** (lanes 10 and 11; lane 3 has its clones). From `~/git`:

```
git clone git@github.com:parawanderer/window-ml.git window-ml-repl-lane<n>
cd window-ml-repl-lane<n>
ln -s ../window-ml/.env .env && ln -s ../window-ml/pyodide-wheels pyodide-wheels
git config core.hooksPath .githooks
npm ci && npm run build
```

Lane 11's host clone: `git clone git@github.com:parawanderer/window-ml-host.git window-ml-host-lane11` (Rust; its own
README says how to build and test). Work ONLY in your clones, on a branch, through a PR with `@` topic labels; never in
`~/git/window-ml`, `~/git/window-ml-host`, `~/git/window-ml-host-k3`, `~/git/window-ml-host-review` or another lane's
clone (the three host checkouts that exist are not yours and are not removed). Remove a clone you made when your last
PR has merged and it holds nothing unpushed.

## Who to ask, and when

Ask a PEER first; the coordinator is the expensive model and is for rulings, not for obvious things. A question is
obvious when the spec answers it or a peer owns the code. Direct messages go to the session title (`ListAgents` shows
it); mail goes to the slug. When two lanes share a seam, they talk to each other and skip the coordinator; the
coordinator is told in one line when the seam has landed.

| Session | Title (direct message) | Mail slug | Ask it about |
| --- | --- | --- | --- |
| coordinator | `[window-ml policies/python/desktop/manifests coordinator] continuation` | `repl-specs` | a spec that is silent or contradicts code; anything that widens what runs without asking; which of two readings; a decision that is Shane's |
| lane 3 | `[window-ml repl LANE 3]` | `repl-lane3` | the Pyodide worker, the CPython fork and its build, the dialect, the extension side of the host seam |
| lane 11 | `[window-ml repl Opus]` | `repl-lane11` | the process host (window-ml-host), `ml.sh`, the effect reader's host side, policies |
| lane 10 | `[window-ml repl Sonnet]` | `repl-lane10` | the effect reader's extension side, the dist manifest check |
| the red team | `window-ml-redteam-e3` | `redteam` | an escape, a failing-first test for a property, a read of something security-shaped after it merges (it never builds or reviews a defence it found the hole in) |
| the CI janitor | `window-ml-flaky-3f` | `flaky-ci` | a CI failure that is not yours, the known-bad list, a build-side review when no owner is free (window-ml only, never the host repo) |

Rules that apply to every lane, from `COORDINATOR.md`: never block on an answer (state the assumption, continue, say
so in the PR); measure before claiming; a finding on a shipped surface goes to its owner the same day; a lane that
has written an exploit does not build its defence. Every GitHub post carries the session trailer `AGENTS.md`
requires; merge your own PR with `node scripts/merge-when-green.mjs <pr> --wait --merge --session <id> --read <post-id>`
once it is green AND reviewed (a review from a peer, named in the lane file; `--read` names the review you read).
Run the merge as a background task of your harness, never `&`-detached: a detached copy once ran for an hour unseen.
A merge your own permission prompt denies is Shane's, never a peer's: say so to Shane, do not ask a peer to run it.
Mail the coordinator when a PR merges, one line, and when a lane is CLOSED, with a `LANE_n_RESULT.md` next to this
file: what was built, what was measured, what was assumed where a spec was silent, what is left.

## Checkpoints and compaction

A session's context fills; when it is compacted, what was not written down is gone. The mechanic every lane uses:

- Keep `tmp/CHECKPOINT.md` in your clone (`tmp/` is gitignored). After each COMPLETED chunk (a PR merged, a
  measurement taken, a review posted, a ruling received), append one dated line: what landed, its SHA or post id,
  what is open and on whom. Never a plan for work not yet done, never a claim not yet measured.
- When a chunk is done and nothing of yours is in flight (no PR open, no background task running, no unanswered
  question you are waiting on), write a `## COMPACTION n (<date>)` block: the lanes' state as you know it, what you
  are waiting for, and one line "On resume: …". Then tell Shane, in one line, that it is a good point to compact.
  Shane compacts; the session resumes from the checkpoint, not from memory.
- The first thing after a compaction is to read `tmp/CHECKPOINT.md` and `git status`, and to pull. Nothing is verified
  from the summary alone; a plan line that disagrees with `git log` is wrong, not the log.
- Do not ask for a compaction mid-chunk: a half-built PR with its reasoning only in context is the one state a
  checkpoint cannot recover.

## What is shared

Lanes 10 and 11 share one seam: the effect reader on both sides (window-ml #882 and window-ml-host #19 are the two
halves of the same three findings). Each lane changes its own side and tells the other directly when it lands; the pin
hash lands on both sides against the same bytes, so neither has to wait for the other, but a change to a manifest or
call fixture after that fails both suites until both move, which is the point. Lane 3 is alone in the fork and in
`src/python/`; lane 11 is alone in the host repo and in `docs/spec/POLICIES.md`.
