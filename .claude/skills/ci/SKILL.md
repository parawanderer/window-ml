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

**Do not run it in the foreground and wait.** Use `run_in_background: true` and carry on; the result
arrives as a task notification. A full run of this workflow is ~5 minutes (matrix + build + e2e).

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
| `e2e` | the built extension in a real Chromium — navigation, the SW lifecycle, layout, anything jsdom cannot represent |
| `e2e-real-model` | non-blocking, on demand / nightly only — a free hosted model, never a gate |

## Known-bad, so you don't chase them

Check these BEFORE assuming a failure is yours — and re-check that the claim is still true rather than
trusting this list blindly:

- **`tool-tokens.spec.mjs` › `res.outputs` (2D matrix)** — arrived broken from the `md-negotiation`
  branch (verified failing at that branch's own commit, in a clean worktree). Another session's
  in-flight feature; not caused by anything here.
- **`cross-page.spec.mjs` › `fetch_url rendered: the DOM-quiet settle…`** — timing-sensitive, carries
  `retries: 2`, and usually passes on retry. Reported as *flaky*, not failed.

A failure that is genuinely not yours goes in the PR body, named, with the evidence — never silently
ignored, and never "fixed" by re-running until it passes.

## Rules

- **Fix forward on the branch.** Push the fix; the PR re-runs. Do not merge red, and do not merge with
  "it's just the flaky one" unless the run says *flaky* rather than *failed*.
- **Re-run only to test a flake hypothesis** (`gh run rerun <id> --failed`), and say so. Re-running to
  get a different answer is how a real intermittent bug becomes permanent.
- **Reproduce locally first when you can**: `npm test` for the fast suite, `npx playwright test
  tests/e2e/<spec>` for one e2e, `npm run typecheck` for types. CI is slower than you are.
- **The workflow cancels superseded runs per branch** (`concurrency`), so pushing a fix supersedes the
  previous run rather than queueing behind it. `main` is exempt: every commit there keeps its result.
- **Before asking for a merge**, `gh pr checks` must be green (or the only red is documented above).
