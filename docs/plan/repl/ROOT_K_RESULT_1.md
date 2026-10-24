# Root K, root 1: process ownership, declared never observed — result

Root 1 of [`ROOT_K.md`](ROOT_K.md), on Shane's ruling of 2026-10-23 in `docs/spec/SHELL.md` and the coordinator's R1 to
R5. Written by the `[window-ml root-k]` session, 2026-10-23.

## What landed

- **Host, parawanderer/window-ml-host#28** (`ae7284e6`, host 0.7.0). `register { pgid, owner, … }` makes a process
  group a session started a row of the one owner table (`kind: "registered"`), bound to the registering connection, so
  the port closing is its owner going under the same `onOwnerLoss` as a spawn. The host samples it every 100 ms, holds
  it to its memory bound (`killed: "oom"`), answers `cancel`, and signals it only through `kill_if_ours`. Refused with
  nothing else verified (R2): `pgid` ≤ 1, a group the host cannot signal, a group holding the host or an ancestor, a
  group already in any ledger, an owner over 1 KiB; over the hub, `Refused` with `reason: "scope"` before the arguments
  are read (R1). `owner { pid }` answers through the rows' `members_of` walk and nothing else: an unregistered process
  is `{ owner: null }`, no scan. `cpuMs` (user + system of live members and reaped children) is on `status` rows,
  orphans and both kinds of `done`: measured, never bounded.
- **Extension, #1042** (`b7e9a3c1`). `HostClient.owner(pid)` and a typed `status()`; `hello`'s `owners` and `cpu`. The
  client has no `register`, and `tests/sh-call.test.mjs` holds that no file under `src/` sends one: the worker reads
  ownership, it never declares it. `done.cpuMs` reaches `ShResult.cpuMs`, the call's span, the run log's `shell`/`run`
  record and the event lane's row (`peak 312.0 MiB of 4.00 GiB bound · cpu 1.5 s`); absent from an older host it is
  unknown, never `0 ms`. No page-started type, `ml.*` member or tool was added, so no red-team pass applied.

## The numbers

- The CPU clock, macOS: a busy child spinning 1005 ms read 24 ms of CPU at a 1/1 timebase, which is why the Mach-tick
  timebase is applied (125/3 on arm64); `a_busy_child_s_cpu_time_tracks_the_wall_clock` holds it.
- Mutation check of the ancestor refusal: with it disabled, the refusal test registered its own process group, and the
  port closing killed the test runner and the shell that ran it. The refusal is what stands between `register` and the
  host killing its own caller.
- Linux enforcement tests ran in the host's CI (four jobs green); macOS locally.

## What is left, and whose

- **The CPU timebase is a per-arch constant, not `mach_timebase_info`** (window-ml-host; non-blocking review finding on
  #28). An x86_64 build of the host run under Rosetta on Apple silicon would undercount CPU by about 42x (1/1 against
  125/3). The fix reads the timebase once at start-up; it needs the crate's first `unsafe`, or a dependency that wraps
  it. Not yet posted on #28 as a follow-up: the post was refused by this session's permission check.
- **`HostStatus` is narrower than PROTOCOL.md's `status`** (window-ml; non-blocking finding on #1042, posted there).
  Extend it to `startedMs`, `deadlineMs`, `endedMs`, `protectedChanged`/`protectedChangedTruncated`, `endedMore` and
  `endedDropped` before the first `status()` consumer lands; nothing calls it yet.
- **Nothing reads `owner` yet.** Its consumer is the agent-status line, `docs/spec/AGENT_MAIL.md` step 1, not built.
  Until then the answer is reachable from `HostClient` only.
- **A registered row counts toward the 32 running calls**, and `ended`'s 7-day and 64-record bounds are unchanged. Both
  were left as they are on purpose; neither has been measured against a session that registers many groups.
