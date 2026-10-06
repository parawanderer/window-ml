---
name: vitals
description: Record and read the monthly figures on how the codebase grows and how often it breaks (lines by kind, big files, commits by kind, CI failures, the forks' diffs), kept in docs/vitals/history.json. Use once a month to take the snapshot, or when asked how the codebase or the agents maintaining it are doing over time.
---

# The codebase's vitals

```bash
node scripts/vitals.mjs              # recompute, merge into docs/vitals/history.json, print the table
node scripts/vitals.mjs --dry-run    # print only
node scripts/vitals.mjs --no-ci      # git figures only, no GitHub API (seconds instead of about a minute)
VITALS_HUB_DIR=/path/to/window-ml-hub node scripts/vitals.mjs   # when the hub is not a sibling checkout
```

Needs `gh` logged in for the CI and fork figures. Takes about a minute, most of it paging through CI runs.

## Why it exists

The repo's code is written and maintained by agents and its owner does not read it. Whether that holds up as
the codebase grows is one of the experiments, and the evidence is a trend over months, not a reading on one
day. Most of the figures are recomputed from git every run, but CI history ages out of GitHub and a fork's diff
against upstream is only measured on the day the script runs, so **run it about once a month and commit
`docs/vitals/history.json`**. A month nobody recorded loses those two.

## Reading the table

- `test/code`: lines under test paths over lines of code. Data files (JSON, CSV, `fixtures/`) and generated
  files (`*.gen.*`) are counted apart, so this compares written code. Rust tests inline in a source file count
  as code, which is why the hub's ratio reads low.
- `big`: code files over 800 lines, the same line `check-file-size.mjs` draws.
- `fix share`: `fix` commits over `fix` + `feat`. Rising over months is the signal worth watching: more of the
  work going into keeping things working than into new ideas.
- `main CI fail`: failed runs on pushes to main, all workflows. The closer reading of "something landed broken".
  `PR CI fail` is mostly CI doing its job.
- `*` marks the current month, measured at today's commit.

## Gotchas

- Classification is by commit SUBJECT prefix. July 2026 shows 0% fix share because commits then had no
  conventional prefixes, not because nothing was fixed.
- A squash-merged PR is one commit, however much it held.
- The fork figures come from GitHub's compare API, which lists at most 300 files and 250 commits; past either,
  the snapshot is marked `truncated` and is a floor. The forks and their upstream branches are the `FORKS` list
  at the top of the script: update it when a fork moves to a new branch.
- Merging: a CI lane whose run count FELL keeps the recorded number (GitHub aged runs out); everything else
  takes the fresh value.
