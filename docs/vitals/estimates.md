# Estimates against actuals

An agent's estimate of a bounded task, written down BEFORE the work starts, against how long it took. The question it
answers: does an agent estimate from how long a human developer would take (what its training data describes), or
from how long it takes itself, running unattended?

## Protocol

1. Define the task as a scope that can be checked when it is done, and write it here first.
2. Before reading the code the task touches (beyond what was already read), write the estimate: the agent's own time
   to a PR with local tests green (pre-CI) and to CI green (post-CI), each with a range, and what it would quote for a
   human developer.
3. Record the start timestamp (`date "+%Y-%m-%dT%H:%M:%S%z"`) when the entry is committed to disk, and the end
   timestamps when the PR is opened with local tests green, and when its CI is green.
4. Afterwards, note what took the time and where the estimate was wrong. Time spent waiting on a human answer is
   recorded separately and subtracted.

Wall clock, on one laptop, with other sessions sharing it. The agent runs in auto mode.

## Ledger

| # | date | task | estimate pre-CI | actual pre-CI | estimate post-CI | actual post-CI | human quote |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-12 | event lane off per-bar elements (#605) | 3 h 30 min (2-6 h) | 58 min | 4 h 15 min (2.5-7 h) | | 5-8 working days |

## 1. The event lane drawn on a canvas (2026-10-12)

Agent: Claude Code, Opus 5.5, auto mode. Session context: had just shipped #594 and #598 (the resource chart's hover
cost), so the chart's interaction code and the lane's `LaneBars`/CSS were already read; `resource-lane-ui.tsx`, the
lane's tooltip and the tests touching `.rc-ev` were not.

Scope, checkable at the end:

- The event lane's bars (the panel's lane and the bench page's, both through `LaneBars`) are drawn on a canvas instead
  of one positioned element per bar.
- Kept: every fill the bars have now (model colour, phase gradients, patterns, the live fade and pulse, dimming outside
  the hovered lineage, the hovered bar's ring), theme colours, hover with its tooltip, click, double-click, the brush
  drag, and a keyboard/screen-reader path to the events.
- Tests that read `.rc-ev` updated or replaced; `npm test` and the lane's e2e specs green.
- Measured on the same `prompt-budget-cuts2` report as #594: per-move main-thread work on the overview.

Estimate, written at the start:

- Pre-CI (PR open, local tests green): 3 h 30 min, range 2-6 h. The drawing is a day of work for a person but mostly
  transcription for an agent; the risk is the test fallout (~100 references in 11 files, several e2e specs) and
  matching the CSS fills exactly.
- Post-CI (CI green): 4 h 15 min, range 2.5-7 h: one CI run (~35 min) plus one fix-and-rerun.
- Human developer quote: 5-8 working days, including review.

Start: 2026-10-12T11:03:54+0200
Pre-CI (PR #605 open, local tests green): 2026-10-12T12:02:19+0200, 58 min.

What happened, against the estimate:

- **The approach changed after 10 minutes**, and that is most of the difference. A 15-line prototype measured first showed
  that ONE SVG removes nearly all of the lane's cost (per move 7.7 ms → 5.2 ms, against 4.6 ms with no lane) while keeping
  what a canvas would have thrown away: pointer events, classes, focus and names. So the ~100 test references to `.rc-ev`
  mostly kept working, and the estimate's main risk (test fallout from a canvas) never arrived. The scope above said
  "canvas"; the deliverable is the same outcome by a different route, kept in the record as a deviation.
- **Where the time went:** pixel fidelity (four passes against before/after screenshots: rounded ends, sub-pixel phases,
  the hairline showing through translucent fills), two dead ends measured and dropped (a `clip-path` and `<use>` per bar
  each cost as much as they saved), and tests: 9 unit and 10 e2e failures, two of them real bugs (hollow bars not
  hoverable; `tabIndex` on SVG making bars unfocusable). The full e2e suite took 18.5 min wall clock at a load average
  of 74, and its 16 timeouts needed a re-run to clear.
- **Not counted:** a mistake at the end (a rebase that dropped the stacked-on PR's commit, undone from the reflog in a
  minute) and re-triggering #598's CI, which GitHub had never started.

