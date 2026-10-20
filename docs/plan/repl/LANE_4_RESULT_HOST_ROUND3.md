# Lane 4: the host's protected names, the call's processes, the unasked line (result, round 3)

Work slug `repl-lane4`, session `b9bc1868-816e-4f91-86bc-4fc2e0f3047e`, model `claude-opus-5-5`, 2026-10-19 to
2026-10-20. Covers what lane 4 landed after [`LANE_4_RESULT_HUB.md`](LANE_4_RESULT_HUB.md); the earlier rounds are
[`LANE_4_RESULT_SH.md`](LANE_4_RESULT_SH.md), [`LANE_4_RESULT_L.md`](LANE_4_RESULT_L.md) and
[`LANE_4_RESULT_K.md`](LANE_4_RESULT_K.md). Lane 4 is closed with this file.

## What landed

| PR | Merge | What |
| --- | --- | --- |
| window-ml #788 (K3c) | a6826b0 | a root's top-level names are outside `B`; `write-names` projects onto `write`; the red team's acceptance tests first, unchanged |
| window-ml-host #13 (K3b) | e0d29a6 | `done.protectedChanged` and the orphans' `protectedChanged` in `status`; a 512 KiB byte budget; the warden kills through `runner::kill_call` (members read before the leader dies) and re-checks each member's start time |
| window-ml #813, #823 (K3b) | 99b294d8, 4024f86b | `ShResult.protectedChanged` (null = unknown) and `protectedChangedTruncated`; the ask card's outcome lines (envelope applied, mismatch, protected changes) in the sidebar, the run log and both exports |
| window-ml-host #15 | cd56124 | bwrap re-binds every protected name read-only, from `protected_rels()` (the red team's finding: 4 of 13 were writable on Linux) |
| window-ml-host #16 (K3d) | 816113a | Seatbelt denies the whole of `.claude`, its regexes from the same list |
| window-ml #817 | 4e8f490c | `HubRuntime.renew` refuses on the signing path when `chain[0]` lacks `may_pair` (lane 8's finding) |
| window-ml-host #17 | 54caaa8 | every effect term and network direction has a vector (`ProgramEffect::ALL` and an exhaustive `slot()`); an unknown effect word is refused |
| window-ml #864 | 1d0ad45e | an `ml.sh` call that ran under a policy or the default is a line under its step (`unasked` on the span), drawn through the card's code path, in both exports |
| window-ml-host #18 | 318977d | a descendant that left the group (`setsid`) and outlived its leader dies with the call; the group is signalled only while it is still the call's own |
| window-ml #868 | 94fb146a | `SHELL.md`'s ownership bullet: "up to the three residuals", each named |

Reviews done for other lanes: window-ml-host #12 (K3, four rounds), #14; window-ml #800, #802, #807, #818, #820;
parawanderer/cpython #3 and #4 (built and run natively).

## What was measured

- The protected-names tripwire costs 143 µs for 36 names against a 1.04 ms spawn (host #13).
- `protectedChanged`'s worst case under the byte budget is 92 changes in 522,575 B; a typical full report is 27,137 B.
- host #13's orphan test failed 2 of 5 Ubuntu runs. It was a real bug on main, not a flake: the warden killed only
  the group, which bwrap's `--new-session` had already left.
- host #18: the reused-leader-pid test (a member survives, its leader's pid now belongs to an unrelated group) fails
  with the old member clause and passes with `group_is_ours`, checked by mutation both ways.
- cpython #4: 136 tests pass at the head; the base `restricted.c` double-counts a block (16,000,800 against a 9,000,000
  bound).

## What is left

- The three residuals in `SHELL.md` (Ownership): a child that leaves the group and loses its parent within one sample
  (100 ms, 200 ms for an orphan) is never recorded, which takes a pid namespace or a subreaper on Linux and has no
  macOS answer; a host SIGKILLed with calls running leaves ledger entries without members; the owner-lost kill and the
  final kill after the leader is reaped signal the group without the ownership check, inside the 5 s drain window.
- `group_is_ours`'s "leader gone, group alive" branch trusts a group whose leader created it and exited, whether or not
  it was the call's. Pre-existing; noted on host #18.
- A send-only network effect has no vector: none of the nine shipped programs only sends. host #17 holds the term in a
  constructed manifest and its test fails once window-ml's vectors gain one, which is the cue to add it.
- The tripwire does not compare at an orphan's deadline kill (#790), and nested repositories are not walked.
- The bwrap gap for an absent envelope stays open by Shane's decision, and the tripwire is report-only for good.
