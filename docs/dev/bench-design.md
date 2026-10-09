# The bench's design: one record, read by a person and by a model

The bench (`tests/e2e/bench/`) and the model panel are worked on by a person and by agents, often at the same time: a
person reads the page and marks a wrong answer while an agent edits a spec in a terminal and starts the next sweep.
These rules keep what each of them sees the same, and keep a record of who changed what. They apply to anything new on
the page or in the sweep directory. How the bench runs is in [e2e-harness.md](e2e-harness.md) and the `bench` skill
(`.claude/skills/bench/SKILL.md`).

## 1. The data files are the truth; the CLI and the page are two views of them

A sweep's state is the files in its directory: `rows.json`, `page.json`, the logs below, and each run's `run.json`. The
page renders `page.json`'s object (baked into `report.html`, pushed over SSE when live), and the terminal and the text
files render the same object. Neither view computes anything the other cannot: the page aggregates with `aggregate()`,
the function `report.md` uses, so the two cannot disagree.

**CLI parity follows from this.** Everything the page shows is also a plain-text or JSON file, and the sweep's last
lines in the terminal list them:

| On the page | File |
| --- | --- |
| Results | `report.md`, `rows.json` |
| Answers | `summary.md` |
| Timeline | `timeline.md` |
| Spec | `spec.md` (log: `sweeps.jsonl`) |
| marks and their checks | `marks.jsonl`, and each check in `summary.md` |
| all of it | `page.json` |

Everything the page DOES has a command too: "mark wrong" is `bench/mark.mjs`. A model driving the bench never needs
the page, and a new card is not done until its file is written beside it and listed in the bench skill's "What it
writes" table.

## 2. Edits go to an append-only log; nothing is overwritten

Anything a person or an agent adds to a sweep is one JSON line appended to a log: marks to `marks.jsonl` (`addMark`),
sweeps to `sweeps.jsonl` (`recordSweep`). A single `appendFile` per record means two writers at once (a person on the
page, an agent at a terminal) both land. A read-modify-write of a whole file would lose one of them, which is how
`marks.json`, the first version, behaved. A correction is a new record, never an edit of an old one: the rule window.ml's
own session history follows. Readers skip a line that does not parse, since a torn last line is what an interrupted
append leaves.

## 3. Every edit says who made it and when

Every record carries `by` and `at`. The page has no login, so its marks are by "person (page)". A command takes
`--by "<who you are>"`, else `BENCH_BY`, else "command line" (`defaultBy()`). An agent should say which session it
is ("claude-code 3bdb7a23"), so a reader can ask it why. The page and the files show `by` next to every mark and sweep.
A record written before authorship was kept (the legacy `marks.json`) is read as by "unknown", never guessed.

## 4. An agent's edits to the bench itself show on the page

An agent iterating on the bench changes the question as well as the answers: a task's wording, a predicate, a
dimension. A reader comparing two sweeps has to know which changed. Each sweep therefore records the spec file's text,
its hash, who started the sweep and the build fingerprint (`sweeps.mjs`). The page's Spec card, `spec.md` and
`page.json` show that version, who ran it, and the diff against the previous sweep's spec, and the page header says
"spec changed" when it did. Only the spec FILE is recorded: a module it imports is covered by the build fingerprint,
which hashes the tree's uncommitted diff (`dirty`).

## 5. Liveness is transport, not rendering

A live page and a saved one are the same renderer. `--serve` sends the state over SSE; `report.html` bakes the same
state in. Each run's files are rewritten as its events arrive, and the viewer reloads an open run when it changes.
Nothing renders a run twice, so the live view cannot show something the saved one does not. The page's own source is
watched the same way: a change under `bench/page/` (or the lane modules it shares with the panel) rebuilds the bundle
and the open pages reload onto it, so a person or an agent can change the page while someone watches.

## Where this is heading

These rules are a small case of the agent canvas, [issue #320](https://github.com/parawanderer/window-ml/issues/320):
a surface an agent always has to render into, which a person watches and can act on, where both are working on one
record of what happened.
