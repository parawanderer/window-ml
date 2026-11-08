---
name: test-slot
description: The machine-wide queue every local test run goes through (one at a time, workers sized from free memory). Use when `npm test` prints a waiting line, when you want to start a suite without blocking on it, or before a full suite in a clone that has not pulled the queue.
---

# test-slot: one test run on the machine at a time

`scripts/test-slot.mjs` is ONE queue shared by every clone and session on this machine. Every local test runner goes
through it: each `scripts/test.mjs` spawn (so `npm test` and the genres), Playwright's main process, and
`npm run coverage`. One run holds the slot at a time; when a run's turn comes its workers are sized from the memory free
at that moment. Why: on 2026-11-08 nine runners from different sessions ran at once (34 workers, 27 GB of swap).

```bash
node scripts/test-slot.mjs submit [--kind unit|e2e] -- <command…>   # queue a DETACHED job; prints its ticket, returns at once
node scripts/test-slot.mjs wait <ticket>                            # block until it ends; prints the log's tail, exits with its code
node scripts/test-slot.mjs status                                   # what runs, what waits, the last finished jobs
node scripts/test-slot.mjs cancel <ticket>                          # take a queued job out, or stop a running one
node scripts/test-slot.mjs run [--kind unit|e2e] -- <command…>      # wait in the FOREGROUND, then run the command here
```

## In a Claude Code session

Either run `npm test` (it waits in the foreground and prints the result), or do not block: `submit` the command, then
run `node scripts/test-slot.mjs wait <ticket>` in the BACKGROUND (the `background-work` skill) and let its completion
notice arrive while you do other work.

A waiting runner prints `test-slot: waiting for pid N (<clone>, <command>, W workers, held 3m); K ahead of you` at the
start and every 30 s. When its turn comes it prints the grant line:
`test-slot: W workers (X available, Y reserved, ~Z per worker)`.

## Opt-outs

- `CI` or `GITHUB_ACTIONS` set: no queue (the runner is a VM whose only job is the suite).
- `TEST_SLOT=off`: no queue; it says so, since other runs on the machine are then not waited for.
- A runner started INSIDE a job (`TEST_SLOT_TICKET` set) runs at once, inside the slot its parent holds.

`--jobs N` on `scripts/test.mjs` still fixes the workers; the queue only waits, it does not override it.

## State and sizing

State lives in `~/.cache/window-ml/test-queue/` (`TEST_SLOT_DIR` overrides): `queue.json`, `<ticket>.log` per job,
`footprints.jsonl`. The per-worker figure is measured: the p90 of the last 20 measured runs of that kind (runs of 10 s or
more only), 1 GB before any. Free memory is taken less what a bench sweep admitted in the last 30 s and has not started
yet (its ledger, the `bench` skill), which the grant line names ("… of it promised to bench browsers starting up").

**With the bench.** A granted run joins the bench's ledger (`~/.cache/window-ml-bench/ledger.json`) as kind `tests`, its
planned memory (workers × per-worker) beside it, and leaves when it ends; `hold.mjs --ledger` lists it. A sweep counts the
part of that plan its workers do not hold yet against free memory, never against the bench's own limit. Bench sweeps do
not queue here: they size themselves cell by cell, so a sweep backs off while a suite runs, and a suite sized while a
sweep runs gets fewer workers. A suite's workers are fixed once granted. A holder whose process has died is reclaimed on every read, so the queue does not stall
behind a crashed run. There is no daemon: whoever finds the slot free starts the head of the queue.

A DETACHED job runs in its own process, in the ticket's cwd, with a RECORDED subset of the environment (`PATH`, `HOME`,
`E2E_*`, `BENCH_*`, `PW_*` and a few more) and nothing named like a secret (`KEY`, `TOKEN`, `SECRET`, `PASS`, `CRED`,
`AUTH`). A job that needs `E2E_KEY` uses `USE_ENV=1` instead, which reads `.env` in the job's cwd.

## The limit

It covers only the runners above, in clones that have pulled it. A direct `node --import tsx --test <file>` does not
queue, and a runner in an older clone ignores the queue: before either, check `pgrep -f 'node --import tsx --test'` and wait if another run is going.
