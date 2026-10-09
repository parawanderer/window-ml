---
name: merge-when-green
description: Merge your own PR only when the standing rule holds (pipeline green, no test removed, nothing unread), waiting while CI runs, and never lose a worktree's bench results or uncommitted files to the merge. Use whenever you would merge your own PR, or wait for one to go green.
---

# Merging your own PR

```bash
node scripts/merge-when-green.mjs 501                  # check once: OK, or why not (exit 0 / 1)
node scripts/merge-when-green.mjs 501 --wait --merge   # poll every 30 s while CI runs (up to an hour), then squash-merge
```

Run the `--wait` form in the background (the `background-work` skill): it exits when the PR is merged or refused, so the
completion notice is the signal.

## The rule it checks

The owner's standing rule for a session's OWN PR, nothing more:

- the PR's `tests` workflow run is complete and every job succeeded or was skipped (a CANCELLED job counts as not
  green, since it prints as a failure: re-run it, do not merge past it);
- no test file deleted, and no more `test(` lines removed than added (an edited test counts once each way);
- no review and no comment (the pr-conflicts bot's notice excepted): an unread review means stop and read it;
- nothing stacked on it, and GitHub says it is mergeable.

`no tests run` usually means the PR conflicts with main: a conflicting PR runs no checks at all. Rebase it.

## What a merge would leave behind

Before the verdict it looks at every checkout of the PR's branch. Bench sweeps and the scoreboard database
(`tests/e2e/artifacts/bench/`) are git-ignored, and uncommitted files are in no commit, so a worktree removed after its
merge takes them with it. Both have happened: a whole sweep's runs, and an interview file left untracked.

- A LINKED WORKTREE holding any of it REFUSES the merge, and prints what and how to keep it.
- `--keep-bench` moves the worktree's sweeps into the main clone's `tests/e2e/artifacts/bench/` and merges its scoreboard
  rows into the main clone's (rows are keyed by run, so none is counted twice). A sweep whose name the main clone already
  has is left in place: rename one and run again.
- Uncommitted files are yours to commit (a new branch from main, if this PR is done) or stash. They are never moved.
- `--discard` merges anyway, when the results are not wanted.
- A page server a finished sweep left running from a linked worktree (`server.json`, from `serve.mjs`) is named, and
  stopped once the merge goes ahead: a worktree removed under it leaves it serving a directory that is gone. The script
  prints the `serve.mjs <sweep dir>` that serves the sweep again from wherever it now lives.
- The main clone is only reminded, since nothing removes it. Any checkout on the branch keeps its LOCAL branch; only the
  remote one is deleted.

So run sweeps you want to keep from the main clone, or `--keep-bench` them before the merge.

## Keeping this current

The rule lives in `judge()` and the disk check in `diskOnly()`/`keepBench()`, tested by `tests/merge-when-green.test.mjs`.
Change the rule there, here and in AGENTS.md together.
