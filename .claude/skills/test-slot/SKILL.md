---
name: test-slot
description: The machine-wide queue every local test run goes through (up to three runs at once under a memory budget, workers sized from free memory). Use when `npm test` prints a waiting line, when you want to start a suite without blocking on it, or before a full suite in a clone that has not pulled the queue.
---

# test-slot: a few test runs on the machine at a time, under a budget

`scripts/test-slot.mjs` is ONE queue shared by every clone and session on this machine. Every local test runner goes
through it: each `scripts/test.mjs` spawn (so `npm test` and the genres), Playwright's main process, and
`npm run coverage`. Up to 3 runs go at once (`TEST_SLOT_MAX_RUNS` overrides), 13 workers between them (cores − 2). A
queued run starts when free memory, less the 25% reserve, less what the running runs planned and do not hold yet, leaves
room for its minimum (2 workers for unit, 1 for e2e) at the run's price, `base + slope × workers` (see State and
sizing); it gets the most workers that room buys, up to its kind's cap. FIFO among the admissible: a job is passed only by one that fits while it does not (a small
e2e probe past a waiting suite). With nothing running the head always starts, on one worker if that is all there is.
Why the limits: on 2026-11-08 nine runners from different sessions ran at once (34 workers, 27 GB of swap); one at a
time then queued twelve sessions' suites behind a single 3-worker run.

```bash
node scripts/test-slot.mjs submit [--kind unit|e2e|batch] [--workers N] [--max-time MIN] -- <command…>   # queue a DETACHED job; prints its ticket, returns at once
node scripts/test-slot.mjs wait <ticket>                            # block until it ends; prints the log's tail, exits with its code
node scripts/test-slot.mjs status                                   # what runs, what waits, the last finished jobs
node scripts/test-slot.mjs cancel <ticket>                          # take a queued job out, or stop a running one
node scripts/test-slot.mjs run [--kind unit|e2e|batch] [--workers N] [--max-time MIN] -- <command…>      # wait in the FOREGROUND, then run the command here
```

## In a Claude Code session

Either run `npm test` (it waits in the foreground and prints the result), or do not block: `submit` the command, then
run `node scripts/test-slot.mjs wait <ticket>` in the BACKGROUND (the `background-work` skill) and let its completion
notice arrive while you do other work.

A waiting runner prints `test-slot: waiting for pid N (<clone>, <command>, W workers, held 3m) and pid … (<why>); K ahead
of you` at the start and every 30 s, where `<why>` is the cap, the workers or the memory that holds the queue's first
waiting job. When its turn comes it prints the grant line:
`test-slot: 5 workers (~2.6 GB for the run: 1.6 GB + 205 MB a worker, from 12 runs of this command; 18.2 GB available, 6.0 GB
reserved; run 2 at once, 9 workers between them)`. `from` says what priced it: runs of this command, runs of commands like this one
(the class), runs of this kind, or "unmeasured: the defaults". A waiting job's reason reads `memory: 1.5 GB above the reserve, 2 workers take ~2.2 GB`.

## Non-test jobs: `--kind batch`

A probe, a scan or a notebook data run that is not a test but wants the machine-wide memory lock is submitted as
`--kind batch`, never as `--kind unit` (that sizes it as a suite, puts its memory into the unit figures and takes a
slot ahead of tests). The rule of 2026-11-09:

- It declares the cores it really uses, `--workers N` (1 to 6, default 1); the queue grants all N or none. `--workers`
  with no value, outside 1..6, or with another kind exits 2.
- Alone, both caps still hold: the always-starts rule is for a run sized from free memory, not a declared count. So a
  submit (or `run`) exits 2 with the figures when N exceeds the machine's worker cap (cores less two: 2 on a 4-core box),
  or when nothing runs and N workers' memory exceeds the room above the reserve; ask for fewer. Waiting would never end
  on a small box, and granting fewer breaks all-or-nothing. Submitted while something runs, it queues and waits for both.
- The same command submitted with a different N is a different job (the dedupe key carries N).
- Every queued test job is judged before any batch job, whatever the submit order; at most ONE batch job runs at a time.
- It counts toward the 3-run and 13-worker caps like any run.
- Chunk it to about five minutes or less (guidance, not enforced). A run past 15 minutes is marked `overran: true` in
  its footprint (every footprint has `durationMs`) so the chunk can be tuned. The wall-clock cap below still applies.
- Its price is fitted from the batch footprints only; with none yet it takes the unit price (the defaults when unit is
  unmeasured too). Batch lines never size a test run.

## The wall-clock cap

Every job, of every kind, is stopped once it has run past its cap (rule of 2026-11-12). The default cap is the longer of
50 minutes (test.mjs's own 45-minute watchdog plus five, so a stuck suite fails there first, with its diagnostic) and 5×
the p90 duration of that kind's footprints. `--max-time <minutes>` on `submit` or `run` (1 to 1440), or
`TEST_SLOT_MAX_TIME=<minutes>` for `npm test` and Playwright, replaces it; two sessions sharing one queued job get the
longer ask. Past the cap, the job's process group gets SIGTERM (an attached runner gets it itself and stops its children),
then SIGKILL 30 s later for anything still alive. The record ends `timedout` (`wait` exits 124), the log says why, and
no footprint is written. The check runs on every read of the queue, like reclaiming a dead holder. A running job granted
before the cap existed gets the default on the next read. `status` shows each running job's cap and marks it SLOW once
it has run 3× its kind's usual. Why: on 2026-11-11 a detached loop of direct `node --test` runs with
`--test-timeout=0` spun in a file's `before()` for 19.6 hours. It held three workers and a 5.4 GB plan, so every queued
suite waited and every bench sweep found no room. A multi-run repro either declares `--max-time` or goes in as one job
per run.

## Opt-outs

- `CI` or `GITHUB_ACTIONS` set: no queue (the runner is a VM whose only job is the suite).
- `TEST_SLOT=off`: no queue; it says so, since other runs on the machine are then not waited for.
- A runner started INSIDE a job (`TEST_SLOT_TICKET` set) runs at once, inside the slot its parent holds.

`--jobs N` on `scripts/test.mjs` still fixes the workers; the queue only waits, it does not override it.

## State and sizing

State lives in `~/.cache/window-ml/test-queue/` (`TEST_SLOT_DIR` overrides): `queue.json`, `<ticket>.log` per job,
`footprints.jsonl` (each line has `runs`, the most runs that shared the machine with it, and `shape`, the command with the clone's path made
relative, so `scripts/test.mjs core` is one shape in every clone, and past 200 characters whole arguments ending `…+<n> #<hash>`;
`class`, read from the whole command at submit; `perWorker` is still written, for comparison).

The price is measured (rule of 2026-11-18): a run costs `base + slope × workers`, from `priceFor`. The sample is the
last 40 footprints of the same shape when there are 3 or more, else of the same CLASS (`classOf`: `suite` or
`suite:<genre>` for the runner and `npm test`, `files` for `--test tests/…` paths, recorded as `class`), else, for a `files`
run, the defaults (1 GB + 0.4 GB a worker: the kind's history is dominated by suites, and ad-hoc file sets rarely repeat), else
the kind's last 40 (a line from before shapes counts here only, or by the class its shape gives), else the defaults; runs of 10 s or more only. The slope is the least-squares slope
of peak on workers, clamped to [0.1, 1.5] GB, and 0.4 GB with fewer than 8 points or one worker count; the base is the
p90 of `peak − slope × workers`. Why not peak / workers: a unit run's peak barely depends on its workers (about 1.5-1.8 GB
at 2 or at 8), so the per-worker figure of a run granted few workers was high, priced the next one higher and granted it
fewer: the daily median went 0.20 → 1.46 GB in nine days and grants fell from 8 workers to 2. A job's `sizing` stores
`base`, `slope` and `from`; a record from before has only `perWorker`, read as a base of 0. Free memory is taken less what a bench sweep admitted in the last 30 s and has not started
yet (its ledger, the `bench` skill), which the grant line names ("… of it promised to bench browsers and other test runs starting up"; a running run's own unresident plan is counted from the queue, not the ledger).

**With the bench.** A granted run joins the bench's ledger (`~/.cache/window-ml-bench/ledger.json`) as kind `tests`, its
planned memory (its price at its workers) beside it, and leaves when it ends; `hold.mjs --ledger` lists it. A sweep counts the
part of that plan its workers do not hold yet against free memory, never against the bench's own limit. Bench sweeps do
not queue here: they size themselves cell by cell, so a sweep backs off while a suite runs, and a suite sized while a
sweep runs gets fewer workers. One run inside a job anyway (`--kind batch`) spends that job's grant: what it writes to
the ledger is marked `inside` the job's ticket and taken off the job's plan, and it does not count its own job's plan
against itself (until 2026-11-11 it did, and found room for no browser). A suite's workers are fixed once granted. A holder whose process has died is reclaimed on every read, so the queue does not stall
behind a crashed run. There is no daemon: every read of the queue starts whatever is admissible.

A DETACHED job runs in its own process, in the ticket's cwd, with a RECORDED subset of the environment (`PATH`, `HOME`,
`E2E_*`, `BENCH_*`, `PW_*` and a few more) and nothing named like a secret (`KEY`, `TOKEN`, `SECRET`, `PASS`, `CRED`,
`AUTH`). A job that needs `E2E_KEY` uses `USE_ENV=1` instead, which reads `.env` in the job's cwd.

## The limit

It covers only the runners above, in clones that have pulled it. A direct `node --import tsx --test <file>` does not
queue, and a runner in an older clone ignores the queue: before either, check `pgrep -f 'node --import tsx --test'` and wait if another run is going.
