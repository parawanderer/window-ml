---
name: merge-when-green
description: Merge your own PR only when the standing rule holds (pipeline green, no test removed, nothing unread), waiting while CI runs, and never lose a worktree's bench results or uncommitted files to the merge. Use whenever you would merge your own PR, or wait for one to go green.
---

# Merging your own PR

```bash
node scripts/merge-when-green.mjs 501                  # check once: OK, or why not (exit 0 / 1)
node scripts/merge-when-green.mjs 501 --wait --merge --session <your session id>   # while CI runs, one API call a minute (up to 90 min; sleeps if the account's hourly API budget runs low), then squash-merge
node scripts/merge-when-green.mjs 501 --read 5577239105 --read 444   # a post you have read that asks nothing further
```

Run the `--wait` form in the background (the `background-work` skill): it exits when the PR is merged or refused, so the
completion notice is the signal.

## The rule it checks

The owner's standing rule for a session's OWN PR, nothing more:

- the PR's `tests` workflow run is complete and every job succeeded or was skipped (a CANCELLED job counts as not
  green, since it prints as a failure: re-run it, do not merge past it);
- no test file deleted (a `*.test.*` or `*.spec.*` file or a fixture under `tests/fixtures/`; the harness and the bench's
  own code also live under `tests/`, and moving one of those is not removing a test), and no more `test(` lines removed
  than added (an edited test counts once each way);
- no review and no comment (the pr-conflicts bot's notice excepted): an unread review means stop and read it. A post
  you have read and that asks nothing further is named with `--read <id>` (below); every other post still stops the merge;
- nothing stacked on it, and GitHub says it is mergeable.

The merge is pinned to the commit the rule was checked on (`--match-head-commit`), so a push during the wait is
refused by GitHub instead of merged untested.

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
- `--discard` merges anyway, when the results are not wanted: nothing is moved, and they go when the worktree is removed.
- Every page server a sweep left running from a linked worktree is named, and stopped once the merge goes ahead: the
  one in `server.json` (from `serve.mjs`, one file per checkout, so only the newest) and each `page` entry the bench's
  memory ledger holds for that worktree (one per `--serve` sweep). One left running keeps memory the budget counts, and a worktree removed under it leaves it serving a directory that is gone. The script
  prints the `serve.mjs <sweep dir>` that serves the sweep again from wherever it now lives.
- A run a sweep left HELD open (`held.json`, a list from the bench's `hold`) is named with its attach line, and
  released once the merge goes ahead, so it stops holding a browser and a model slot. Entries whose process is gone are
  ignored.
- The main clone is only reminded, since nothing removes it. Any checkout on the branch keeps its LOCAL branch; only the
  remote one is deleted.

So run sweeps you want to keep from the main clone, or `--keep-bench` them before the merge.

## Keeping this current

The rule lives in `judge()`, what still counts as unread in `pickUnread()`/`postKey()`, and the disk check in
`diskOnly()`/`keepBench()`, tested by `tests/merge-when-green.test.mjs`. Change the rule there, here and in AGENTS.md
together.

## Your own comments

Your own comment blocks like anyone's: name it with `--read <id>` once it asks nothing further. A marker is text anyone
can post, so letting the `<!-- agent-post: … session=<id> … -->` marker clear a post would let a comment copying it
clear itself. Text can only block a merge. `--session <id>` still helps: the refusal labels a post whose marker names
that session "marked yours", so you can tell which of the listed ids are your own notes.

## Main's copy judges

The script first fetches `origin/main` and compares itself and its local imports with main's. When they differ (your
PR edits the script, or your branch is behind), it prints `running main's copy` to stderr and runs main's version from a
temp directory with the same arguments, so a branch never judges its own merge. It refuses, saying why, when main's
copy cannot run that way: main's version predates this, or imports a package or a computed name. Then run it from a
checkout of main.

## A post that asks nothing further

**The standing rule is unchanged: an unread review is a reason to stop, not to merge.** What `--read <id>` adds is a way
past a post you HAVE read and found to ask nothing further (a "LGTM, no changes requested" review, a note you already
answered). It is repeatable and takes comma-separated ids, and the refusal prints each unread post's id in exactly the
form the flag takes, so the next run is a copy of what it printed:

```
834: has 1 reviews/comments and 0 inline comments: read them (--read 5577239105)
  review 5577239105 parawanderer: Reviewed on `7afaedde` because the red team cannot review it
```

- **The tool never parses a body.** The flag is YOU saying you read that one post and nothing is outstanding on it. A
  review that asks something and is not named still refuses, as does one you never look at.
- **The id is GitHub's number**, the same one in the URL's fragment: `#pullrequestreview-5577239105`,
  `#issuecomment-123`, `#discussion_r9`. `--read` takes the bare number, the whole fragment, or the GraphQL node id.
- **Naming an id that matches nothing reads nothing.** The post still blocks. Fail safe, never open.
- **Read it before naming it.** `--read` is the record that you did. Naming every id to get to green is exactly the
  bypass the rule exists to prevent, and is what `gh pr merge` was for when no flag existed.

So: read what arrived, answer or fix what it asks, and `--read` only the ones that ask nothing further or that the
push you just made has already answered.
