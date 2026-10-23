# Root K and what is left of the policy layer: one session, with Sonnet subagents for the small items

Brief, 2026-10-23, by the coordinator (`repl-specs`, session `7a8ce8b6`), on Shane's word in its session. Assigned to a NEW
session, `[window-ml root-k]` (work slug `root-k`, clone `~/git/window-ml-root-k`, Opus). Every REPL lane is closed and the
plan's status (`README.md`, "Status") names what this brief hands over; the dependency graph there ("K. registering a
program") and the three specs below are the design. Nothing here is new design: it is built as specified, and anything
that needs a decision goes to the coordinator, who writes the ruling into the spec the same hour.

## The roots, one PR each, in this order

1. **Process ownership, declared never observed** (`docs/spec/SHELL.md`, the paragraph "Proposed by Shane 2026-10-21;
   RULED YES"). Host side first, a window-ml-host PR: a `register` call takes a process group a session started, with
   the owner (session hash and harness, run and step when there is one); the owner table answers a pid by it and the
   descendant walk the ownership bullet already does; an unregistered process is "nobody's", that IS the answer, no
   scan; the memory bound applies to a registered group as to a spawned one; CPU is a second measured fact on the
   span, never bounded by default. Extension side second: the answer is read from the agent-status line
   (`docs/spec/AGENT_MAIL.md`, step 1). The host's Linux CI runs the enforcement tests; its labels are the host repo's.
2. **Root K, registering a program or library manifest** (`README.md`, "K. registering a program"; `PROGRAM_MANIFEST.md`,
   "Registering a program" and "Interpreted script tools"; `READONLY_LIBRARY_MANIFEST.md`, "Generating and importing a
   manifest into the runtime"; `EFFECTS.md`). Split it as the graph does: (a) host, `exec: program-only` in the sandbox
   `Plan`, Seatbelt's literal `process-exec` path and the Landlock exec shim (`exec-under <ruleset> -- prog`), EXECUTE
   for the program, the ELF interpreter and a `#!` interpreter, the ABI reported; `(program, entrypoint)` prefix matching
   for interpreted scripts; (b) extension, the manifests store with workspace and global scope (declared in the state
   registry from its first commit; read `docs/dev/state.md` first); (c) `propose_manifest`, a builtin tool in the tool
   registry, drafting a program manifest from `--help` or script source, or a library manifest from module source, into a
   card with sandbox or probe evidence, loaded live on approval; (d) the registration page in DevTools Settings. RULED
   2026-10-23: (c) is PROGRAM manifests only this round; a library manifest needs the Tier 3 admission check or the
   Tier 1 isolated probe (`READONLY_LIBRARY_MANIFEST.md`, "Generating and importing a manifest into the runtime"),
   neither built, and a Tier 1 `@lift` entry suspends the in-process gate, so it is its own root. (c2), after (c) merges
   and only if time allows: Tier 3 (`@cost interpret`) entries only, sha256-pinned, delivered through the existing
   `src/python/dialect-data.ts` path to the fork's `load_manifests`, no fork change; Tier 1 stays out of root K, listed
   for Shane. RULED 2026-10-23, the evidence run of (c): nothing executes before the person's word; the card's block is
   DERIVED and says so (the host resolves the program and discards: pin path, fingerprint, `inRoot`, the version when
   the draft reads one, a script's sha256; plus this run's recorded `ml.sh` calls of that program with the draft's
   reading of each, free or asks), never mixed with MEASURED; on approval the entry is stored `origin: "proposed"` and
   applies sandboxed only (B5), loaded live; the MEASURED run follows approval, on a sandboxed host only, over this
   run's recorded calls of the program the draft makes free, under the envelope derived from the draft (write none, net
   none, program-only exec) with the 2 s / 4 KiB probe limits, each within `okCodes` with no envelope mismatch and no
   `protectedChanged`; all pass marks `evidence {calls, at}` and the entry then also describes plain-host calls; any
   failure keeps it sandbox-only and is stored on the entry for (d)'s page; zero recorded free calls means no evidence,
   sandbox-only, said on the card, never a synthetic call. Measuring before the card was refused: an execution no card
   covered. Scope is the model's choice, B3 forcing workspace for an in-root program or a script, said on the card; the
   tool is offered only to a worker-built run with `ml.sh` bound, like `propose_policy`. (c) is a
   new tool and (b) adds message types: each gets the red-team pass AGENTS.md requires, written by a separate agent with
   tests that fail first (`tests/redteam.test.js`; the `redteam` skill). The sh-policy session's #990 (destructive
   programs, no shipped manifest inside a workspace root) and #995 (the manifest JSON Schemas) are K's edges, already on
   main; build on them, do not redo them.
3. **The shell probes, then `propose_policy` widened to `sh`** (`POLICIES.md`, "RULED YES by Shane on 2026-10-23" in the
   paragraph after "The tree, ruled"). The probes first: programs, paths and flags the run never used, the shell side's
   own breadth evidence, the same block shape as `fetch`'s, DERIVED or MEASURED and never mixed. Then the widening, in the
   same PR or after, never before; an `sh` proposal the lifter cannot lift is refused with the model told which shapes
   lift. The number afterwards: rerun the `sh` panel task (`tests/e2e/panel/policy-proposals.md`; lane 11's 29 of 53 is
   the baseline) and put it in `POLICIES.md` beside lane 11's, with the spend.
4. **A policy kept in a file** (`POLICIES.md`, "A policy kept in a file (proposed, not built)" and "Where a policy can
   live"): live `deny`/`ask` apply at once; `allow` only from an accepted, hash-pinned snapshot entering the store with
   `origin: "file"`; loading is a proposal card; committing or pushing a policy file asks by default. The worked example
   is the acceptance test: "merge only through my script" (deny `gh` and non-read-only `git`, allow one pinned user
   script), including the open dependency named there, whether the host refuses a denied program started INDIRECTLY
   (`npm run`, `xargs`, a git alias): measure it on the host before claiming either answer, and send the answer to the
   coordinator the same day; the spec takes it.
5. **Co-writing's two open items** (`POLICIES.md`, "A policy is co-written with the model"): more than one card per
   drafting conversation; whether a proposed policy the person edits becomes theirs (`editPolicy` keeps `origin:
   "proposed"`). The second is a ruling before it is code: ask the coordinator with your reading.

## The small items, yours to run through Sonnet subagents

Each is one branch, one failing-first test, one PR you review and merge; a Sonnet subagent (`model: "sonnet"`) builds it
from a brief you write to a file under your clone's `tmp/`, in a `git worktree` of your clone (`git worktree add
../window-ml-root-k-<item> -b <branch>`, removed after the merge), never two in one tree. You are its reviewer, so you
read its diff before merging, with your session line on the review; the subagent never merges. Rule 10 holds for each:
the session or agent that FOUND an item reviews nothing on its fix, and these were found by the red team, the janitor
and the sh-policy session, none of which is your subagent.

- The orphan's compare at its DEADLINE kill: the `ended` record's two-profile residual (`LANE_11_RESULT.md`, "What is
  left"; `LANE_11_ENDED_RECORD_DESIGN.md`), and K3b's open item that the deadline kill's record is consumed once
  (`README.md`, "K3b"). Host side.
- The two uncharged reads named in #1007's body: the unpiped stored-text read and `serveWireCall`'s argument copies
  (`ML_WIRE.md`, "One budget a cell").
- `sed`'s size bound over-counts (`s/a/$'/g` refused at 4,000 lines; `src/readonly-exec/replace-size.ts`, the
  `replaceCharge` row of `docs/dev/readonly-exec.md`): exact where the worst case is wrong, never looser than exact.
  DONE as #1045 (a Sonnet subagent of root-k, 2026-10-23), a NEGATIVE result on the stated bug: the 4,000-line refusal
  does not reproduce on main; the real defect was `replaceSize` stopping on built plus rest, which peaks above the
  final length (16 `a`: peak 121, built 120, so a limit of 120 refused); the fix stops on the built part only, which
  never decreases. Accepted residual: the replacer-arrow path keeps the running total and can refuse transiently near
  the limit, erring toward asking.
- An `ask` saved between `decide` and host start is not re-checked, only a deny is (`docs/dev/policies.md`, "What an ask
  cannot reach" and the sh-policy session's #999).
- The lost-POLICIES-add race (the sh-policy session's note; its record is `~/git/window-ml-sh-policy/tmp/CHECKPOINT.md`,
  a local file outside git that Shane keeps for you: READ it, never work in that clone; ask that session if the shape is
  unclear, it found it).
- The model-written proposals appended to `tests/fixtures/policy-corpus.json` (`LANE_11_RESULT.md`, "Left by #961").
  OPEN as #1041 (a Sonnet subagent of root-k, 2026-10-23, the janitor reviews): 110 model entries (206 occurrences), the
  corpus from 221 to 331; by distinct source 45 of 74 lift (fetch 25 of 37, sh 20 of 37); the per-run figures reproduce
  the documented ones with the scorer's own extract and lift (run A fetch 33 of 52 and sh 24 of 53; run B fetch 46 of
  52; run C fetch 41 of 49); no lifted tree disagrees with its source; the two sh answers that cannot be enumerated are
  compared on their need's calls, now a committed assertion. Judgment calls, stated in the entries' notes: run B (the
  withdrawn details text) included and labelled; Gemini-flash's 12:15Z fetch attempt excluded (setup unidentifiable);
  the 19 entries marked `no` had no rewrite attempted. Not recomputed: the counts in
  `tests/e2e/panel/policy-proposals.md`, which root 3's rerun recomputes.

Not yours, said so you do not take them: `riskyRegex` stays as it is (ruled, lane 11); the python cancel gaps are
`[window-ml python-cancel]`'s; site access and presence are `[window-ml security] Site access`'s; the Pyodide fork is
nobody's until a finding names it.

## How to work

Read, in this order, before touching code: `AGENTS.md`; `README.md` beside this file, "Decisions already made" and "How
to work, and how to coordinate" (the clone, one root per PR, labels, the session line on every post, merge-when-green,
session mail, when to ask the coordinator, the result file; written for the numbered lanes, every line applies to you
with work slug `root-k`); `docs/dev/shell.md`, `docs/dev/policies.md`, `docs/dev/state.md`, `docs/dev/working-in-the-repo.md`;
then the three specs; then `~/git/window-ml-sh-policy/tmp/CHECKPOINT.md`, the sh-policy session's own record of where
roots 3 to 5's edges ended (read only). Keep `tmp/CHECKPOINT.md` in your clone, one block per stretch, and say when it is a good moment to
compact. The coordinator is live as `[window-ml policies/python/desktop/manifests coordinator]` (ListAgents; SendMessage,
no mail needed while it runs); message it at each root's PR, at each ruling you need, and with every number you measure
(rule 8: nothing is claimed before it is measured; rule 9: a finding goes to its owner the same day). Your reviewer for
the roots is the flaky-CI janitor (`window-ml-flaky-ci`) for host and extension code, and the red team for the red-team
passes only; the coordinator reviews spec-only PRs. Labels: `@hub-compat` never; `@python` never; `@exec,@security` for
the shell side, `@ui` for the page, `@docs` for specs; the host repo's own labels there. When a root merges, a short
`ROOT_K_RESULT_<n>.md` beside this file: what landed, the numbers, what is left and whose. Negative results are wanted.
