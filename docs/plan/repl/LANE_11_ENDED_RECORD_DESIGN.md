# Lane 11: the orphan's `ended` record (design, 2026-10-21)

Lane 11's item 2 ([`LANE_11_HOST_AND_POLICY_TREE.md`](LANE_11_HOST_AND_POLICY_TREE.md)). K3b compares the protected
names at `done`, and at `status` for a live orphan; what an orphan changes between the last `status` and its end is
not reported (`SHELL.md`, the security list; ruled 2026-10-19, left open because it needs persistence and a
consume-once read). This note is the shape lane 11 builds under while it is read. Code refs are window-ml-host at
`318977d` (`src/owners.rs`, `src/session.rs`, `src/tripwire.rs`).

## A finding first: nothing in window-ml makes or reads an orphan today

`HostSpawn.onOwnerLoss` is typed (`src/shell/host-protocol.ts`) but nothing sets it, `HostConfigure` has no default
for it, and `HostClient` has no `status` method. Every window-ml call is `kill` on owner loss, so no orphan exists for
a record to describe, and "the extension's `status` reader" in the lane file has nothing to extend. The host side
below stands on its own (the host's protocol has orphans and `status` for any client); the extension side is a
question for the coordinator (last section).

## The gap is wider than the deadline kill

An orphan's entry leaves the ledger in three ways, and K3b reports none of them:

| How it ends | Where (`owners.rs`) | Reported today |
| --- | --- | --- |
| its deadline passes and it is killed | `sweep_file`, `kill_if_ours` branch | no |
| it exits on its own before its deadline | `sweep_file`, `!still_ours` → `continue` | no, and the entry is dropped silently |
| its group id now names someone else's processes | the same `!still_ours` branch | no |

So the rule this note proposes is the universal one (COORDINATOR.md rule 2): **an orphan entry never leaves the ledger
without an `ended` record.** The deadline kill is one `cause` of three, not a special path. An entry with no deadline
(a `kill`-policy call whose host was SIGKILLed) is out of scope: it was never an orphan, its kill is the sweep's
cleanup, and SHELL.md's second Ownership residual already names that case. Including it would be one more `cause`
value; I left it out to stay inside the ruling, and it is a one-line widening if wanted.

## Where it lives

In the ledger directory (`owners::default_dir`, 0700, checked by `private_dir`), one file per ended orphan:
`<host pid>-<host start>.<call id>.ended`. The host pair is the ledger's own name, so the file is unique across host
processes (call ids `c1`, `c2` restart per host). The extension is `.ended`, not `.json`, so `sweep` and `writer_of`
never read it as a ledger. Written like the ledger: temp file, then rename.

## What it holds

```jsonc
{ "id": "c1", "owner": { "run": "…", "step": 4 }, "startedMs": 1760000000000, "deadlineMs": 1760000600000,
  "endedMs": 1760000600140, "cause": "deadline",          // "deadline" | "exited" | "not-ours"
  "killed": true,                                          // kill_if_ours found something to signal
  "protectedChanged": [ … ], "protectedChangedTruncated": true }   // truncated only when true, as on done
```

- `protectedChanged` is `tripwire::report` against the entry's start snapshot, computed AFTER the kill returns, so
  nothing of the call is still writing. Same bounds as `done` (256 changes, 512 KiB). Absent when the entry has no
  snapshot (an older host wrote it): unknown, never "nothing", the K3b convention.
- `killed` separates "we killed it" from "it was already gone" for `cause: "deadline"`, the case where both happen.
- No `footprint`, no members: the processes are gone, and the record is about what the call left behind.

## Who writes it, and the race

`sweep_file` writes it, whoever is sweeping: the dead host's warden, a later host's start-up sweep (`serve`), or a
later host's `status`. Two of them can sweep the same ledger at once (the warden and a new host's `status`), and today
that is harmless because a double kill is idempotent. A record is not: A and B both read the entry, B writes the record,
B's `status` consumes it, A writes it again, and the next `status` returns it a second time.

The fix: `sweep_file` holds an exclusive `flock` on `<ledger>.lock` for its whole read-kill-write-rewrite, so one
sweeper handles an entry and the other then reads the rewritten ledger without it. The record is written BEFORE the
ledger is rewritten, so a crash between the two leaves both. The next sweep then finds the entry not ours (it is dead)
and would write a second record with `cause: "exited"`. Guard: the record is created with no-replace (write the temp
file, then `link` it to the final name, which fails if the name exists). The first record stands and the duplicate is
dropped.

## Who consumes it, and what consuming means

`status` gains a third list, `ended`, beside `running` and `orphans`: every record in the directory, oldest `endedMs`
first, each one deleted after its frame is queued to the writer. Consume-once means the first `status` of any later
host session returns the record and no later one does. The loss this accepts: if the port dies between the queue and
the browser reading the frame, the record is gone unread. That is the same delivery `done` has, and an ack op would
be a second wire change for a case that already means the reader is gone.

`status` must stay under the 1 MiB frame cap. One record can carry 512 KiB, so `ended` takes records in order while
the reply stays under `MAX_OUT` minus the `running`/`orphans` part. The rest stay on disk for the next `status`, and
the reply says `endedMore: true`. A record that alone would not fit (impossible for one the host wrote, since its list is
bounded, but possible for one forged or corrupted) is deleted and counted in `endedDropped`.

Who "a later session" is: any host process of the same uid with the same state dir. Two Chrome profiles share
`wmlhost-owners-<uid>`, so profile B's `status` can consume profile A's record. `orphans` already has this property
(B lists A's orphans). The `owner` field is opaque to the host, so the host cannot filter, and the extension can
(`owner.run` it does not know is not its own). Named, not fixed.

## One never consumed

A record ages out after 7 days and the directory holds at most 64 of them. Both bounds are enforced by every sweep, and
the oldest are dropped first. A host that never runs again leaves the files in a 0700 temp directory the OS clears.
Dropping is silent at the time; the next `status` reports `endedDropped`, the count since the last read, kept in a
one-line counter file. The bounds are guesses: no measurement says how often a profile goes 7 days without a
`status`.

## What a hostile or crashed host process can do to it

- **A crash** mid-write leaves a `.tmp` file, which is removed by the next sweep when older than a minute. The rename
  is atomic and the link no-replace, so a reader never sees half a record.
- **A forged or corrupted record** is read with a size limit (the frame cap) and parsed by a strict reader, and it is
  dropped (`endedDropped`) if it fails either. It can still say anything the schema allows: the record is a REPORT,
  like `done`, and refuses nothing.
- **Who can write the directory.** Anything running as the user, outside a sandbox. That includes an UNSANDBOXED orphan,
  which can delete its own record or replace it with `protectedChanged: []`. The same call could just as well undo its
  change to `.envrc` before the deadline, so the record adds no trust the call did not already have. A SANDBOXED call
  can write only its roots and its own `$TMPDIR` (SANDBOX.md, the write tests), and the ledger directory is neither:
  the record is out of its reach. `SANDBOX.md` gets a test that a sandboxed call cannot touch the state dir, failing
  against a profile that allows it.
- **A hostile host binary** is outside the threat model: the host is trusted to enforce (window-ml-host AGENTS.md).

## What gets built (host PR, lane 3 reviews)

1. `owners.rs`: the `.ended` writer in `sweep_file` for all three causes; the `flock`; the no-replace link; the age,
   count and `.tmp` bounds in `sweep`.
2. `session.rs`: `status.ended`, `endedMore`, `endedDropped`, under the frame budget.
3. `PROTOCOL.md` (`status`) and `SANDBOX.md` (the state-dir test row), in the same commit (host AGENTS.md).
4. `clients/node/`: the `status` type.
5. Tests: kill an orphan at its deadline with a protected name changed after the last `status`, and read the record
   from the NEXT session's `status` exactly once; the self-exit and not-ours causes; two concurrent sweepers give one
   record; a forged oversize record is dropped; the sandbox cannot write the state dir.

## Ruled (2026-10-21, the coordinator; written into `SHELL.md`'s K3b paragraph, #914)

1. **The extension side: (a), host only.** Window-ml makes no orphans, so a reader would read nothing it produced. The
   PR that first lets the extension ask for an orphan adds `HostClient.status()` once per connect, with `ended` into the
   housekeeping log. An orphan policy without that reader is refused in review.
2. **Universal: yes**, every ledger entry's leaving.
3. **`host-lost`: in**, report-only. It closes the reporting gap of the second Ownership residual.

As built (window-ml-host #21), there is one cause more than this note listed: `owner-lost`, a `kill`-policy call
killed when its port closes. Its `done` goes to a closed port, which is the same gap and happens today whenever an MV3
worker is evicted mid-call. That makes five causes: `deadline`, `owner-lost`, `host-lost`, `exited`, `not-ours`. The
flock, the no-replace link, the two-profile residual and the 7-day / 64 guesses stand as written.
