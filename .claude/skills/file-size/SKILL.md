---
name: file-size
description: Find which files are worth refactoring — by what they COST to keep working in (length x how often they are edited), not by raw length. Use when deciding where to spend effort on a large codebase, or before proposing a split.
---

# Which files actually cost you

```bash
node scripts/check-file-size.mjs --cost          # ranked by cost; the one to use for planning
node scripts/check-file-size.mjs --all           # every file over 800 lines, by length
node scripts/check-file-size.mjs [base]          # the ratchet: did THIS change grow an oversized file
```

Exit code is always 0. This is a reminder, never a gate.

## Use `--cost`, not `--all`, to decide where to work

`--all` sorts by length, which answers "what is big". That is the wrong question: a long file nobody opens
costs nothing, and a shorter one edited weekly costs a lot. `--cost` ranks by lines x commits-that-touched-it,
each commit decayed by a 30-day half-life, which is roughly what a reader pays.

The difference is not cosmetic. On this repo `dom.ts` is fourth by length and under 2% by cost; the three
resource-panel files were half the total while being 15% of the lines. Sorting by size sends you to the wrong
file.

`--cost` ignores the 800-line limit on purpose, because cost has no threshold — a 430-line file edited 42
times outranks several oversized ones and the size gate cannot see it.

Flags: `--half-life <days>` (default 30), `--since <git date>` (default 12 months), `--top <n>` (default 20).

## Reading the columns

`recent` is the decayed commit weight, `all` the raw count. **While those stay close, the decay is inert and
you are looking at plain churn.** A ratio below about half means that file's work has stopped and the decay is
doing something. On this repo the lowest ratio is 0.75, so nothing has stopped yet.

`in` is how many source files import it. It is printed and deliberately NOT part of the score, because commits
are WRITES: a heavily imported type module is read far more than it is edited. `contract.ts` is the case —
327 lines, 1.8% cost, 85 importers — and its score is an undercount. There is no honest weight to fold the two
together with, so judge it yourself.

## What it will not tell you

- **Cost is backward-looking.** A subsystem that churned while being built and is now finished still scores
  high. Check whether the work is live before believing the ranking.
- **Churn resets on a split.** New modules carry none of the parent's history, so the next run overstates how
  much a split helped.
- **It says nothing about whether a split is POSSIBLE.** That is decided by the file's edges, not its size —
  ask `node scripts/imports.mjs <a> <b>` (skill: `imports`) before planning one. Three attempts on `vram.tsx`
  died on import cycles that `--cost` knew nothing about.

## Bloat can never hide

Every file over 800 lines that does not make the ranking is listed underneath it anyway, with its commit
count. That is deliberate: a decayed score buries a file that is enormous and quiet, which is exactly the case
worth seeing.

## Keeping this current

`scripts/check-file-size.mjs`. Its header carries the reasoning; change the behaviour and update this file and
the AGENTS.md mention in the same commit.
