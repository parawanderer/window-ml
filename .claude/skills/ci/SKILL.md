---
name: ci
description: Open a PR and drive its CI to green — watch the run, read the FAILING logs, fix on the branch, and know which failures are known-bad rather than yours. Use whenever you push a branch, whenever CI is red, or before asking anyone to merge.
---

# CI: branch, PR, watch, fix

Work on this repo happens in **several sessions at once** (UI here, benchmark/pointers elsewhere), which
is why the work goes on branches and merges through PRs: the PR is the thing that runs CI, and CI is the
thing that catches what one session broke for another. A green local `npm test` is not that check —
it does not run the e2e suite, three Node versions, or the real-CPython tests.

## The loop

```bash
git switch -c ui/event-lane-zoom          # a branch per piece of work, named for it
# …work, commit…
git push -u origin HEAD
gh pr create --fill                       # title/body from the commits
gh pr checks --watch                      # blocks until every check settles
```

`gh pr checks --watch` is the one to use: it exits non-zero when anything failed, so it doubles as the
gate. For a long e2e run, `--interval 30` keeps the polling quiet.

**Wait a beat before watching.** Run immediately after `gh pr create` (or a push), it can print
`no checks reported on the 'branch'` and exit 0 — it raced the run's registration, and that exit code
looks exactly like success. Sleep ~20s first, or poll until a check exists:

```bash
# Poll for a real STATE, not for output: "no checks reported" is itself a line, so `grep -q .` matches it
# and the watch exits immediately — the same trap one level down.
until gh pr checks "$PR" 2>/dev/null | grep -qE "pass|fail|pending"; do sleep 10; done
gh pr checks "$PR" --watch --interval 30
```

A push while a run is in flight starts a NEW run and the concurrency group cancels the old one, so the PR
can report no checks for a few seconds in between. Same remedy.

**And confirm the exit code with a real poll.** A dropped connection ends the watch with exit 0 too:

```
Post "https://api.github.com/graphql": read tcp ...: connection reset by peer
[exited with code 0]
```

The last table it printed had three `test` jobs and `e2e` still `pending`, so exit 0 meant "the watch
stopped", not "the checks passed". Both spurious-zero cases look identical to success from the exit code
alone, so the rule is the same for both: **never merge on the watch's exit status — re-run a plain
`gh pr checks <PR>` and read that every check says `pass`.** The tell is a watch that ends far too early,
or whose final output still contains `pending`.

**When a push supersedes the run you are watching**, the watch loses it and ends with `no checks reported`
while its last table still says `pending` — both spurious-zero cases at once, and the likeliest way to see
them, since pushing a docs fixup mid-run is normal. Rather than re-entering the watch (which can race the
new run's registration all over again), poll for a TERMINAL state and print it:

```bash
# 1. wait for the new run to register, then 2. wait until nothing is pending.
until gh pr checks "$PR" 2>/dev/null | grep -qE "pass|fail|pending"; do sleep 10; done
until out=$(gh pr checks "$PR" 2>&1); ! grep -qE "pending" <<<"$out"; do sleep 25; done
echo "$out"    # every line must say pass (or skipping) before merging
```

This is the "confirm with a real poll" step above, done once instead of after the fact, and it is immune to
both traps because it never trusts an exit code.

**A CANCELLED check prints as `fail`, and that is not a failure.** `gh pr checks` has no third word: a job
that never ran reads exactly like one whose tests broke. So before investigating a red check, or reporting
one, RESOLVE ITS CONCLUSION:

```bash
# every job on a run that is not a clean pass, with its real conclusion
gh api repos/$REPO/actions/runs/$RUN/jobs --paginate \
  -q '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "\(.name) -> \(.conclusion)"'
```

`cancelled` means nothing was learned, so a re-run is the whole fix; `failure` is the only one worth reading
a log for. The DURATION is the tell that costs nothing to look at: a `test` leg that normally takes 3 minutes
sitting at 22, or five jobs all ending within a few minutes of each other at ~27, is a cancellation, not a
test that got slower. Confirm it by comparing each job's `started_at` against when it finished — a job
starved of a runner never ran at all, and a sibling leg of the SAME matrix finishing green in 3 minutes
while the others are killed is the signature.

Three readings in one session were wrong in this one direction, each because a convenient view was trusted
over the specific thing:

- the e2e SHARDS were green while the required `e2e` aggregate was cancelled — the shards are not the gate;
- a run's `conclusion` was `failure` while every job under it was `cancelled` — one failed-or-cancelled job
  makes the RUN a failure, so the run's own conclusion cannot tell the two apart;
- `gh run list` returned a stale page, and a watch loop exited on runs from two weeks earlier. **Poll a run
  by ID** (`actions/runs/<id>`) whenever you already have one; a listing can come back pointing elsewhere.

Starvation is real here and arrives in windows: on 2026-10-05 between 19:48 and 20:42, jobs across four main
runs and one PR sat queued 25-54 minutes and were cancelled without ever getting a runner. Nothing was
broken. If several unrelated runs go red at once, check the queue times before the code.

**A STACKED PR DIES WITH ITS BASE BRANCH: retarget it to `main` BEFORE merging the one under it.** `gh pr merge
--delete-branch` deletes the base of every PR stacked on that branch, and GitHub then CLOSES those PRs rather than
retargeting them. A closed PR cannot be retargeted, and it cannot be reopened either once its head has been
force-pushed (which the rebase onto `main` that follows always does): #377 was lost this way on 2026-10-07 and replaced
by #380. So, for a stack: `gh pr edit <upper> --base main` first, then merge the lower one, then rebase the upper one
with `git rebase --onto origin/main <lower's last commit> <upper branch>` (a squash merge puts the lower PR on `main`
as ONE new commit, so its original commits must be dropped, not replayed).

**MAKING A CHECK REQUIRED BLOCKS EVERY PR WHOSE BRANCH PREDATES THE JOB.** A required context that never
reports is not a failure, it is an indefinite wait, and a branch forked before the job existed has no such
job to run. So the order is: merge the workflow first, then add the context, and update any branch already
open. Adding `mobile-bundle` to the ruleset on 2026-10-06 put #365 straight into `MERGEABLE/BLOCKED` with no
`mobile-bundle` row at all; a rebase onto main was the whole fix. The same applies to RENAMING a job, which
is a remove plus an add as far as the ruleset is concerned.

A CONDITIONAL job can still be required: a job that runs and is SKIPPED by its own `if:` satisfies the
ruleset here, which is why `e2e` and `bench` are required and a docs-only PR is `CLEAN` with both
`skipping`. That is worth re-confirming on a docs-only PR before requiring a new conditional check, rather
than assuming — the failing shape (never reported at all) and the passing one (reported as skipped) look
alike from the outside.

**Do not run it in the foreground and wait.** Use `run_in_background: true` and carry on; the result
arrives as a task notification. The e2e suite runs as three shards (`e2e (1/3)` … `e2e (3/3)`, each with 3 workers) plus an `e2e` job that is
green only when all three are; a full run is about 6 minutes, the slowest shard still being the long pole.

**And having backgrounded it, do not then poll its output file.** `until [ -s "$OUT" ]; do sleep 20;
done` is a foreground wait wearing a disguise, and it is the commoner mistake by far — it happens
within a minute of correctly backgrounding the thing. Go and do other work; the notification will
come. For a mid-flight peek, one plain `gh pr checks <PR>` is a snapshot and exits immediately.
The general discipline, and the `dist/`-rebuild hazard that goes with it, is the `background-work`
skill.

## NO checks is worse than red checks

```bash
node scripts/pr-conflicts.mjs --branch "$(git branch --show-current)"   # does my PR still merge?
node scripts/pr-conflicts.mjs --all                                    # which open PRs stopped merging
```

If `gh run list` shows nothing for a commit you pushed, the first thing to suspect is that the PR CONFLICTS with
its base. GitHub builds a `pull_request` run against the MERGE COMMIT, so while there is no merge commit there is
no run at all: the checks do not go red, they stop existing, and every push after that looks untested. It cost
this repo two commits on #313, and nothing anywhere was red.

The nastier half is that it happens to a branch NOBODY TOUCHED: three PRs landed on main, and #313 became
conflicting without a single push to it. So the `conflicts` workflow asks the question from both ends — on a push
to a branch ("did I just break my own PR?") and on a push to main ("did what just landed break someone else's?",
which comments on each affected PR and never reddens main's own run). `tests.yml` cannot hold this, because a
workflow cannot detect its own absence.

Mergeability is computed asynchronously, so GitHub answers `null` for a window after any push — after a push to
main, for every open PR at once. Both the script and you should treat that as unknown and ask again, never as a
conflict.

## Reading a failure

```bash
gh run list --branch "$(git branch --show-current)" --limit 3     # which run, and its id
gh run view <id>                                                  # jobs, and which step failed
gh run view <id> --log-failed                                     # ONLY the failing steps' logs
gh run view --job <job-id> --log | tail -100                      # one job in full, when needed
```

`--log-failed` is almost always the right one: a full matrix log is tens of thousands of lines and the
answer is a single assertion in it.

Artifacts are worth knowing about: a red **legend word-clipping** case uploads
`legend-notebook-node<N>` — download it and open `legend-notebook.html`, where the failing cell shows the
words, the crop box, and expected-vs-actual. The workflow also writes a pointer to it on the run summary.

## What runs, and what each catches

| Job | Catches |
| --- | --- |
| `test` (Node 22/24/26) | `npm run typecheck` + the whole fast suite, including real-CPython tests when the pyodide wheels cache hits |
| `build` | that `dist/` still builds, and uploads a loadable extension |
| `e2e (N/3)` | the built extension in a real Chromium — navigation, the SW lifecycle, layout, anything jsdom cannot represent. One third of the suite each (`--shard=N/3`); read the failing SHARD's log, not the `e2e` job's |
| `e2e` | the three shards' verdict in one check: red if any shard was not green. Its own log only says which result it saw |
| `e2e-real-model` | non-blocking, on demand / nightly only — a free hosted model, never a gate |

## When an e2e shard fails: read what the page showed

A failing shard uploads `test-results/` as `e2e-results-<shard>`: each failed test's `error-context.md` (the page's
accessibility snapshot at the moment it failed), its trace and screenshots.

```bash
gh run download <run-id> -n e2e-results-1 -D /tmp/e2e-1 && find /tmp/e2e-1 -name error-context.md
```

Read that before theorising: a failure that passes locally is usually a page in a state the test did not expect, and
the snapshot shows which.

## Known-bad, so you don't chase them

Check these BEFORE assuming a failure is yours — and **re-verify the claim rather than trusting the
list**. Every entry here has an expiry nobody sets: the branch that caused it gets fixed, and a stale
entry then teaches you to ignore a real failure. Two commands settle it:

```bash
npx playwright test tests/e2e/<spec>.spec.mjs   # does it still fail locally?
gh run list --branch main --limit 3             # does MAIN fail it too? then it is not yours
```

- **`cross-page.spec.mjs` › `fetch_url rendered: the DOM-quiet settle…`** — timing-sensitive, carries
  `retries: 2`, and usually passes on retry. Reported as *flaky*, not failed. A **flaky** line is not a
  red check; a **failed** one is.
- **`resource-stream.spec.mjs` › `a self-contradicting ps frame does not make a resident model vanish`** —
  INTERMITTENT on main itself: 1 of 10 locally against a build of `4e2a385`, and it failed #43's CI, whose
  diff never touches the resource panel. Always the same assertion — `t=100: the row lost the model's
  memory`, the row reading "evicted" — right after the first `loading` frame, and it has no `retries`, so it
  reports as *failed*. Unconfirmed lead: the test seeds only the event stream, so the fake box's `/api/ps`
  reports nothing resident, and a poll landing in the 150ms window disagrees with the stream.

- **`cross-page.spec.mjs` › `cross-domain (HUD card): a RESUME that navigates cross-origin still shows the card on
  the destination origin`** — failed #235 (2026-09-21) on both its tries, a diff of two scripts and docs that touches
  no extension code; a rerun of the shard passed. Treat a single failure as flaky, rerun the shard
  (`gh run rerun <id> --failed`), and look properly only if it fails twice running on the same branch.

Recently removed, recorded so nobody re-adds them from memory:

- ~~`tool-tokens.spec.mjs` › `res.outputs` (2D matrix)~~ — **fixed.** It hardcoded `@tool:([0-9a-f]{6})`
  and ids became SEVEN characters when the check character shipped, so the fake model cited the first six
  of a real id and nothing resolved. It builds its pattern from `TOKEN_HEX_SRC` now, which is the rule the
  rest of the tree follows: a hardcoded copy of a shape does not fail when the shape changes, it silently
  keeps testing the old one.
- ~~`resource-panel.spec.mjs` › the event lane hover~~ — **fixed.** Arrived with the lane-hover race PR
  and failed on main's own CI for a while; main is green.

A failure that is genuinely not yours goes in the PR body, named, with the evidence — never silently
ignored, and never "fixed" by re-running until it passes.

## Rules

- **Fix forward on the branch.** Push the fix; the PR re-runs. Do not merge red, and do not merge with
  "it's just the flaky one" unless the run says *flaky* rather than *failed*.
- **Re-run only to test a flake hypothesis** (`gh run rerun <id> --failed`), and say so. Re-running to
  get a different answer is how a real intermittent bug becomes permanent.
- **A fresh worktree needs `npm ci`.** Worktrees do not get `node_modules`, and since `@types/node`
  became a devDependency a stale one fails with `Cannot find type definition file for 'node'` — which
  reads like a tsconfig problem rather than a missing install. Symlinking the main checkout's
  `node_modules` works for running, but not after a dependency changes.
- **`npm run lint`** is format + types, and is what the pre-commit hook runs a subset of. Cheaper than
  waiting for CI to tell you about a trailing space.
- **Reproduce locally first when you can**: `npm test` for the fast suite, `npx playwright test
  tests/e2e/<spec>` for one e2e, `npm run typecheck` for types. CI is slower than you are.
- **The workflow cancels superseded runs per branch** (`concurrency`), so pushing a fix supersedes the
  previous run rather than queueing behind it. `main` is exempt: every commit there keeps its result.
- **Before asking for a merge**, `gh pr checks` must be green (or the only red is documented above).
