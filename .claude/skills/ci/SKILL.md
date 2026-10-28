---
name: ci
description: Open a PR and drive its CI to green — watch the run, read the FAILING logs, fix on the branch, and know which failures are known-bad rather than yours. Use whenever you push a branch, whenever CI is red, or before asking anyone to merge.
---

# CI: branch, PR, watch, fix

Work on this repo happens in **several sessions at once** (UI here, benchmark/pointers elsewhere), which
is why the work goes on branches and merges through PRs: the PR is the thing that runs CI, and CI is the
thing that catches what one session broke for another. A green local `npm test` is not that check —
it does not run the e2e suite or the real-CPython tests.

Merging your own PR once it is green: the `merge-when-green` skill (`node scripts/merge-when-green.mjs <pr> --wait
--merge`), which applies the merge rule and keeps a worktree's bench results.

## The loop

```bash
git switch -c ui/event-lane-zoom          # a branch per piece of work, named for it
# …work, commit…
git push -u origin HEAD
gh pr create --title "…" --body-file body.md --label @exec,@api   # TOPIC labels, see below
gh pr checks --watch                      # blocks until every check settles
```

The body (and every comment or review you post) ENDS with the agent-post lines, so other sessions and
`merge-when-green --session <id>` can tell it is yours (AGENTS.md; `docs/dev/working-in-the-repo.md`, "GitHub posts say
which session made them"). `--fill` writes a body without them: use `--body-file`.

`gh pr checks --watch` is the one to use: it exits non-zero when anything failed, so it doubles as the
gate. For a long e2e run, `--interval 30` keeps the polling quiet.

**Label the PR by topic** (AGENTS.md's rule): every `@` label in `gh label list` that applies, and
`@hub-compat` / `@model-backend-compat` whenever the change needs a matching one in window-ml-hub or the forked
Ollama/OpenWebUI. Forgot? `gh pr edit <n> --add-label @ui,@chat-page`.

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
| `test (node 26)` | `npm run typecheck` + the whole fast suite, including real-CPython tests when the pyodide wheels cache hits |
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
- **`cross-page.spec.mjs` › `cross-domain (HUD card): a RESUME that navigates cross-origin still shows the card on
  the destination origin`** — failed #235 (2026-09-21) on both its tries, a diff of two scripts and docs that touches
  no extension code; a rerun of the shard passed. Treat a single failure as flaky, rerun the shard
  (`gh run rerun <id> --failed`), and look properly only if it fails twice running on the same branch.

The two remaining entries above did not occur once in the 80 `tests` runs of 2026-10-15 (08:09–14:02Z, 24 with e2e): each passed first try everywhere it ran. Six hours is weak evidence for events this rare, so they stay listed until a longer window says otherwise.

Measured from CI logs on 2026-10-15 (the same 80 runs; method: read every e2e shard log, count per test failed vs
flaky), and the only entries that BLOCKED a run that day:

Flaky only (passed on retry, never blocked a run), worth knowing because two may be PRODUCT bugs, not races:

- **`site-access.spec.mjs` › `@security attack 13: cannot be cancelled by the page`** (`:258` on main; `:238` on
  `7ae44af9`) — count 2. Once on run 40579352419 (2026-10-15 era); then BOTH tries on run 40712844338 (e2e 3/3 on #1244,
  job 122902564352): times out at `idx.settled(hash)` after `approveInCard`, the run never left running/waiting within
  its 20 s. The same shard is green on `7ae44af9` (run 40710327490) and the only commit between was a one-line chat-web
  locator change, so not the diff; a rerun of the shard passed. A @security test going flaky is a bug report until
  proven otherwise: security's test-only fix (#1255) replaces the settled poll with a wait on `fake.calls()` and names
  the stage that stalled. Do not raise the 20 s and do not touch `idx.settled`'s meaning of "ended" without that.
- **`site-access.spec.mjs` › `@security attack 15 › 15e: the shell's own admission keeps the page out of the card…`** —
  see Recently removed (#1236 fixed the mechanism). The flaky history stands as a measurement: 3 flaky on main in the
  80-run window of 2026-10-15 (the run did not reach an ended status within 20 s of the approve click, security
  assertions before that step passed), 0 of 660 local on 2026-10-19 (15 solo, 5x full suite at 3 workers, 5x two
  parallel full suites at 3 workers).
- **`resource-panel.spec.mjs:2125` › the narrowed window is in storage** — deterministic-looking, not a race:
  `ml_res_window` Received 6 Expected < 6 on both tries; the on-screen check at `:2119` passed. Peer traced it to
  `settleScrub` in `src/sidebar/resource/resource-scrub.tsx:44-55` (400 ms re-armed `setTimeout`, `chrome.storage.local.set`
  in a swallowed catch). Owner: resource panel. Do not chase as a flake.
- **`background.test.js:2588` › `two START_RUNs under one run id while the first is still starting: one hosts, one is
  refused`** — flaked once on #998 (both starts hosted, `actual: 2, expected: 1`), passed on rerun. The test races two
  START_RUNs through a held restore and a 20ms wait; timing-sensitive. Rerun the job before blaming a diff that does
  not touch background start.
- Seen once each: `site-access` 16a (@security), `site-access` 18 closed-shadow-root (`:1164`, 16.5 s), `site-access` 19
  DevTools-panel ask (`:1492`, 16.3 s), `cross-page` composer seq collision, `output-scroll` tail-follow, `chat-web`
  phone tooltip, `focus-restore`, `bench-editor` traceback, `resource-panel` narrow window (`:3619`),
  `tooltips.spec.mjs:627` › a tip whose trigger disappears under a still pointer disappears with it.
- Seen once each on 2026-10-28 (run 40708391759, head `95a9e87b`, every job green; each row failed its first attempt and
  passed on retry #1): `resource-panel.spec.mjs:2537` › resource panel: the snap mark yields, focuses, and says what it
  is out of (10.5 s on retry); `site-access.spec.mjs:520` › attack 8: approved, then revoked, and still calling without
  a reload (1.9 s on retry); `site-access.spec.mjs:497` › an approved site's page-started Python is refused until the
  person allows THIS site to approve its own actions (17.4 s on retry). The two site-access rows are the security
  lane's if a second hit lands. `bench-editor.spec.mjs:207` traceback row — second sighting, also retry-passed here
  (first is in the line above).
- Node-suite, seen once each on 2026-10-28: `hub-host.test.mjs:96` › a session's events arrive in the contract's order,
  with its own cursor (run 40700963610, hub job on #1238; got `["reset","first","backfilled","second","live"]`, expected
  "second" before "backfilled" — the backfill command's result raced cursor 2's stream delivery; the job reran green)
  and `python-spend-queue.test.mjs:184` › a flood of queued callbacks is cut at the deadline (run 40710327490 on #1244,
  test node 26: "the spend took 1745 ms" against the row's `1500`; the PR's diff touches no python code). The flood
  row's bound is pin 15's open question — my #1250 review says the ruled restatement (deadline + control slack + 250 ms
  residual) is tighter than this measured value; read that before touching the constant.

node:test had no real failures in that window: every `not ok` was a documented `# TODO`.

Recently removed, recorded so nobody re-adds them from memory:

- ~~`site-access.spec.mjs` › `@security attack 15 › 15e: the shell's own admission keeps the page out of the card…`~~ —
  **fixed** in #1236 (`3967b0df`, 2026-10-28), SITE_PRESENCE step 3: a hidden page's run tools now attach in-process in
  the content scripts' isolated world, so the step-2 late-port race is gone (injected.js arriving late under load let the
  page end up holding the channel, and the approved click then went down a port nothing answered). The falsifier held:
  15e ran green on #1236's own CI (e2e 3/3 job 122886731514, first try, 10.4 s), so the diagnosis stands. Do not add as
  flake; the measurement history is kept on its line above.

- ~~`session-index.spec.mjs:59`~~ and ~~`value-store.spec.mjs:176`~~ — **fixed** in #1194 (`16174bb2`, 2026-10-28), one
  race in the e2e harness, not two flakes: both specs wrote the self-approval list through `configureExtension` and
  reloaded at once, and the worker registers the origin's main-world scripts on the storage change AFTER the write
  returns, so under CI load the reloaded document started with no page script; the worker's one-shot catch-up
  (`showInOpenTabs`) ran before that document's content script listened, and `waitForMl` waited its 15 s. Four unrelated
  branches failed the same afternoon (40549239517, 40547626002, 40546447318, 40552504878). `configureExtension` now
  waits for the registration the reload depends on (`awaitPageScriptRegistration`, which fails at its deadline instead
  of passing to its cap as `approveOrigin`'s old loop did). The product half (a document that loads in the registration
  window and misses the catch-up gets `open: true` and no page script until its next reload) is the site-access lane's,
  in a PR after #1189. Do not add as flake.

- ~~`site-access.spec.mjs:1507` › `@security attack 19 › the toolbar badge counts the waiting start on its tab, and the
  popup's Show unfolds its collapsed card`~~ — **fixed** in #1163 (`8f0ea29e`, 2026-10-27), a test-harness gap and not a
  product bug: the Collapse click landed while the shell was still springing the card container in (a 400 ms transform
  with overshoot, plus the arming flip's height repost), and Playwright's stability check runs inside the frame so it
  cannot see the frame's own motion. `cardSettled` now polls the frame element's box for three equal non-null readings
  and `cardArmed` waits for the enabled Allow before every click. Measured before the fix: hard-fail 6/12 shard-3 runs,
  main 3/6. Two real bugs it surfaced went to the security lane: a multi-run start card's Collapse was a no-op
  (hud-card.tsx, fixed in #1175) and `badgeFor` summing every site's requests onto every tab's badge. Do not add as flake.

- ~~`resource-stream.spec.mjs` › `a self-contradicting ps frame does not make a resident model vanish`~~ —
  **fixed** in `f0245376` (2026-09-12), a product bug and not a flake: `pollPs`/`fetchCapacity` checked
  `streamLive` only when SENDING, so the panel's mount-time `/api/ps` reply landing after the stream's first
  sample was recorded over it, and against an empty `/api/ps` the resident model read as "evicted". Both
  callbacks now re-check at reply time, and `resource-stream.spec.mjs` pins it ("a poll answered after the
  stream went live does not overwrite the stream's reading", via `setPsDelay`). The old "unconfirmed lead"
  was that race; the 1-in-10 count was measured on `4e2a385`, which predates the fix. 40/40 local on
  2026-10-19 (12+8 repeats of both tests, 4 and 8 workers); main green. Do not add as flake.

- ~~`mobile-android` › Publish it as the rolling Android build~~ — **fixed** in #752 (`ea87a78c`): the rolling `android-latest` publish is retried once after a failed delete/create cycle, which was the race (`cleaning up draft failed: HTTP 404` after a second main run landed between the delete and the create).

- ~~`chat-web.spec.mjs` › `a citation takes you to the step on the FIRST click, not the second`~~ — **fixed** in #809 (`ecdf04c3`), a product bug and not a flake: after a citation jump the step's growth scroll-anchored the view to exactly the bottom, `onScroll` re-set `stuck`, and #795's glide then cancelled the smooth `scrollIntoView` to the step. Fails 2–5 of 5 locally from #795 on; the failing subject is outside every branch that reddened for it. Do not add as flake.

- ~~`chat-page.spec.mjs:935` › `the start page holds through a worker restart, and its tab list is fresh and has the
  sites' icons`~~ — **fixed.** Two cooperating defects: the test's wait on `.chat-start-wait == null` was a false
  positive (LocalHost holds `online` for `OFFLINE_GRACE_MS` after the port drops, so the badge is already gone while a
  `tabs.list` would fail), and `useTargetPick` never re-asked `tabs.list` when the same `local` re-announced after a
  worker restart (`rt.id` is a constant, so the effect never moved) and a failed refresh kept the stale one-row list
  with no retry. The test now probes the `ml-sessions` port for the `runtime` announce, and the picker watches the
  runtime OBJECT so a re-announce refreshes the list.
- ~~`chat-scroll.spec.mjs:89` › `a standalone tool call slides in, and a pair that becomes a group says so on the
  head`~~ — **fixed** in two halves. (1) Hard fail on main, 5/5: a live tool step that landed in the same frame as
  the history draw mounted under `HistoryPaint=true`, captured `fresh=false` on mount, and never got `.fresh` /
  `chat-tool-in`. `SessionPane` flipped the flag on a `requestAnimationFrame` after the first commit, so anything
  arriving in that window was wrongly history. Now flipped in a layout effect of the same commit (chat-app.tsx).
  (2) Residual CI flake after that: the test emitted the live step after waiting only on `.chat-transcript`, which
  `?long=0` had already drawn, and `longAgent(0)` left nothing else to wait on. Under load the emit landed before
  THIS session's first paint, so the step was correctly read as history (everything mounted in that commit is). The
  test now waits for the session's own task bubble (`.msg.user`), the first paint's visible marker, before emitting.

- ~~`detection-surface.spec.mjs:446` › `rendered fetch: a real tab on the site, focus emulated, visibility flipped,
  window.ml injected there`~~ — **fixed.** The assertion demanded `tab.visibility` be exactly `["hidden","visible"]`,
  which is only the probe-samples-before-the-CDP-lands order (macOS). On the Linux runner the emulation wins the race
  and the page is visible at its first look, so it received `["visible"]`. That is the same product behaviour the
  `hasFocus` line above it already allowed for, and the assertion's own message ("not throttled") named the real
  invariant. It now asserts the tab ends visible and focused, that a recorded flip goes hidden→visible, and that rAF
  is never in the throttled `0`/`1-4` buckets; `["≥40"]` was asserting host load, not the extension.

- ~~`tool-tokens.spec.mjs` › `res.outputs` (2D matrix)~~ — **fixed.** It hardcoded `@tool:([0-9a-f]{6})`
  and ids became SEVEN characters when the check character shipped, so the fake model cited the first six
  of a real id and nothing resolved. It builds its pattern from `TOKEN_HEX_SRC` now, which is the rule the
  rest of the tree follows: a hardcoded copy of a shape does not fail when the shape changes, it silently
  keeps testing the old one.
- ~~`resource-panel.spec.mjs` › the event lane hover~~ — **fixed.** Arrived with the lane-hover race PR
  and failed on main's own CI for a while; main is green.

- ~~`chat-page` PAGE-hosted run state lost to a migration race and empty placeholders~~ — **fixed** in #1013
  (`f9377abe`): a page-hosted run's state was dropped when a storage migration raced an empty placeholder write.

- ~~`media-in-worker.spec.mjs:234` › python's image #b's crop reads grey (the mask covered #b's centre)~~ —
  **fixed.** The HUD card's `expanded` state (an open click/type approval) rests at bottom-right; its measured
  rect is ~(470, 322) 392×339 on the 800×600 test viewport and covered #b's centre at (500, 350). `workerShot`'s
  mask paints the watch union, so a python shot landing while the card was up (or still animating away) greyed
  out the crop. `#b` now sits at (400, 50), centre (500, 100), clear of every card state on that viewport. The
  invariants hold: the crop is still 100 rows, 200 columns, blue; the cast still lands at #b's centre.

A failure that is genuinely not yours goes in the PR body, named, with the evidence — never silently
ignored, and never "fixed" by re-running until it passes.

## Fixing a flake

Agreed with Shane on 2026-10-15, after `detection-surface.spec.mjs:446` blocked several PRs that touched no extension
code. The easy fixes (a sleep, a retry, a looser assertion) turn CI green and hide what the flake meant, and some
"flakes" are product bugs.

- **Measure first, from CI logs**: read the e2e shard logs of recent `tests` runs and count, per test, failed (both
  tries) vs flaky (passed on retry), split main vs PR. Not by running the spec locally while other sessions share the
  machine: under load, local e2e fails unrelated tests and loads everyone else's work.
- **What a weaker model may fix**: only a fixed wait or timing assumption, replaced by waiting on the actual event. No
  new `retries`, no `sleep`, no removed or loosened assertion, no `src/` change. A fix is proven by about ten CI reruns
  of the shard, not by one green run.
- **What goes to a stronger model or to Shane**: an assertion that would have to accept a new outcome, anything in a
  security or detection spec (`detection-surface`, `site-access`, `redteam`), and any diagnosis that points at the
  product. A stronger model reads such a fix's diff before it merges.
- **Who to tell**: a flake that blocks a PR goes to the CI janitor session (`window-ml-flaky-ci`) with the measured
  counts, and to the coordinator session, since every lane's PRs hit the same red shard. Do not just rerun and move on.

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
- **Immediately before merging, read what arrived on the PR**, even with a go-ahead to merge: green CI does not
  mean nobody has commented. Reviews from another session, a person, or a bot all count. Three places, because
  no single command shows all of them:

  ```bash
  gh pr view "$PR" --json reviews,comments -q '.reviews[] , .comments[] | "\(.author.login): \(.body[0:200])"'
  gh api "repos/parawanderer/window-ml/pulls/$PR/comments" -q '.[] | "\(.user.login) \(.path):\(.line): \(.body[0:200])"'   # inline review comments
  ```

  Anything there is answered before the merge: fixed on the branch, or replied to with why not. A bot's comment
  is read too, and dismissed in a reply when it is noise, so the record shows it was seen. This is not
  hypothetical: on 2026-09-18 #154 was merged on a go-ahead eleven minutes after a review with four real findings
  had been posted, and all four became a follow-up PR.
