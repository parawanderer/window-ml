# Lane 4, root L: process ownership and the memory bound (result)

Work slug `repl-lane4`, session `b9bc1868-816e-4f91-86bc-4fc2e0f3047e`, model `claude-opus-5-5`, 2026-10-19. Spec:
`SHELL.md`, "Every process has an owner, and a memory bound", and `EFFECTS.md`'s `alloc` bound (#734).

## What landed

- **window-ml-host [#7](https://github.com/parawanderer/window-ml-host/pull/7)**, tag `v0.3.0`. The wire as built is
  [`PROTOCOL.md`](https://github.com/parawanderer/window-ml-host/blob/main/docs/PROTOCOL.md), sections "Owners",
  `status` and `done`.
- **window-ml #753**: the extension names each call's owner and reports a call killed past its bound.

## The host as built

- **One owner table.** Each spawn is its own process group. A row holds the call id, the group, the leader's start
  time, the `owner` object the worker sent (at most 1 KiB), the start, an orphan deadline, and the memory bound. The
  new `status` call lists the table. `hello` reports `owners` (where the ledger lives) and `memory` (the metric, the
  default bound and the maximum).
- **A pid is never taken for ours on its number alone.** A group is killed only when its leader's start time still
  matches the row, or when the leader is gone but the group still has members (`test_kill_process_group`). Processes
  are read through `libproc` on macOS and `/proc` on Linux, never through `ps`.
- **Owner loss.** `onOwnerLoss: "kill"` is the default: when the port closes, every call in the table is killed (the
  group plus every descendant, SIGKILL). `{ orphan: ms }` (default 10 minutes, at most 24 hours) keeps the call alive
  past the port and lists it as an orphan until its deadline. A call registered after the host started closing is
  killed at once.
- **Death of the host itself is covered by a warden.** The table is mirrored to a ledger file
  (`$WMLHOST_STATE_DIR`, else `<tmp>/wmlhost-owners-<uid>`, which must be 0700 and ours; writes are atomic). The first
  call starts `wmlhost warden <ledger>` in its own process group with no stdio. It polls every 200 ms, and when the host
  is gone it kills each entry that has no deadline or a passed one, and keeps orphans until theirs. So a `kill -9` of
  the host, which runs no destructor, still takes its calls with it.
- **The memory bound is enforced on the physical footprint**, sampled every 100 ms over the call's group plus
  descendants (at most 4096 members): `ri_phys_footprint` on macOS, `RssAnon + RssShmem + VmSwap` on Linux, never
  the address space. Past the bound the call is killed with no grace and `done` says `killed: "oom"`; every `done`
  carries `peakFootprint` and `memoryBound`. `memoryBound` defaults to 4 GiB per call, is clamped to at least 16 MiB
  and at most `memoryMax` (16 GiB by default, from `configure`).

## What the tests showed

`tests/stdio.rs` drives the built binary; the root L tests are: the owner listed by `status`; a malformed owner
refused; a sleeper killed when its port closes; the host killed outright (`kill -9`) and the warden killing its sleeper;
an orphan surviving the port and listed until its deadline; a child allocating past its bound killed with `killed:
"oom"`; a child under its bound reporting its peak; the bound clamped at both ends. None of them reads `ps`: a call
writes `started` at once and `late` after a sleep, and a killed call never writes `late`; the rest read `status` and
`done`. Full suite on macOS: 80 lib, 52 stdio and the rest pass;
CI green on macOS and Ubuntu, both with and without the hub feature.

Each of the three central tests was run against a deliberately broken host and FAILED: without the watchdog check,
without the warden start, and without the kill on port close.

On the extension side (#753): each `spawn`, the version probe's included, names `owner: { run, seq }` from the call's
context, and an `owner` option in a script is `BadRequest`. A killed call's result has `ok: false`, `killed: "oom"`
and an error naming the bound; the run log's `shell`/`run` record carries `killed`, `peakFootprint` and `memoryBound`.
Three tests in `tests/ml-sh.test.mjs`; full `npm test` 5852 pass, 0 fail; CI green.

## What a spec got wrong, and what is not done

- **Linux CI found a conflict the spec did not name**: bwrap's `--die-with-parent` killed an orphaned call the moment
  the host exited, so the orphan policy could never hold on Linux. The flag is now added only when the call's policy
  is `kill` (`Plan.outlives_host`), and the sandbox test checks both cases. `SHELL.md` should say that the owner-loss
  policy decides the sandbox's tie to the host, not the other way round.
- **The Linux cgroup `memory.max` is not built.** The spec offered it as the Linux mechanism; it needs a delegated
  cgroup (systemd user slice), which a native-messaging host cannot count on. Linux uses the same footprint watchdog
  as macOS. `PROTOCOL.md` lists the cgroup under "Not in v1".
- **Not done yet**: the footprint as a span on the resource panel's event lane (in progress), and a visible orphan list
  in the panel (later). The watchdog samples every 100 ms, so a child that allocates very fast can overshoot its bound
  between two samples; the kill still lands at the next one.
