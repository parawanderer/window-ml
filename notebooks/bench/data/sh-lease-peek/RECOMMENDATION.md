**Keep `SH_LEASE_MS` at 15 s: peek works, and it changes no outcome.**
- **Peek reaches the model.** All 18 tails taken while a build was still running returned its latest output; on
  2026-11-07 every such tail returned nothing.
- **Outcomes did not move.** On the 45 build runs, correct was 0.76 with peek against 0.80 without, and task turns per
  detached build were 2.04 against 1.85: both inside the spread of 5 repeats. Only 13 of the 45 build runs tailed at
  all; the rest awaited the result.
- **No model reported progress unasked.** The tasks ask for the last line, and only qwen3.8 mentioned the progress
  lines (14 of 90 answers); tailing did not make it likelier (3 of 14 runs that tailed, against 11 of 76 that did not).
- **A 5 s lease taxes a 10 s call only when the model gives no estimate.** At 5 s the `tests` call detached in 8 of 15
  runs, at 15 and 60 s in none. gemma4:31b never estimates: it detached 5 of 5 times and spent one task turn and 1.6
  more steps each time. qwen3.8 gave `expectMs` in 4 of 5 runs, which replaces the lease, and did not detach. Correct
  was 12/15 at both 5 and 15 s.
- **gemma4:e4b's failures are still about finding `ml.sh`**, not about the lease: 9 of its 17 wrong runs called it as
  a function, 7 never reached the host.
