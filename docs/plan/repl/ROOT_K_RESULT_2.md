# Root K, root 2: the result (slices b and c)

Written 2026-10-23 by `[window-ml root-k]` (session `fabd107f`), for the coordinator and whoever builds slice d. The
brief is [`ROOT_K.md`](ROOT_K.md); the rulings are in
[`PROGRAM_MANIFEST.md`](../../spec/PROGRAM_MANIFEST.md), "Registering a program", the store's ruling of 2026-10-23.

## What was built

- **(b) the store**, #1048: `chrome.storage.local`, global and per workspace root (B1), shipped manifests win (B2),
  in-root programs and scripts are workspace scope (B3), a binary is pinned by the host's fingerprint and path and a
  version only when its manifest reads one (B4), a model's entry describes sandboxed calls only (B5).
- **(c) `propose_manifest`**, #1055: a gated worker tool. The host resolves the draft and discards it (nothing starts),
  the card is derived only, approval stores it `origin: "proposed"`, and an evidence run on a sandboxed host re-runs this
  run's calls the entry makes free under a write-none envelope. One change beyond the ruling, accepted: the tool is
  offered by the settings (`shellTurnedOn`), not by the measured host status.

## Measured: two evidence runs on the real host

Real `wmlhost` 0.7.0 (window-ml-host `c107434`, debug build), macOS, Seatbelt, `landlockAbi: null`, driven through the
built worker in `node:vm` (`tests/isolated-harness.mjs` with its native port bridged to the binary's stdio). One root, a
scratch folder holding `a.txt`. Each run: one `ml.sh` call the person approved, then `propose_manifest` with a
read-only draft (`effects: ["read"]`, `paths: "operands"`, version `*`), approved.

| Program | The recorded call | Card | Evidence re-run | Outcome |
| --- | --- | --- | --- | --- |
| `/usr/bin/file` | `file a.txt`, exit 0 | 1 call, read, free | envelope `write: none, exec: program-only` applied as asked; exit 0 in 9 ms; no protected name changed | `evidence {calls: 1}`: describes plain-host calls too |
| `/usr/bin/touch`, drafted as a reader (a manifest that lies) | `touch b.txt`, exit 0, created `b.txt` | 1 call, "read", free | the same envelope; exit 1 in 7 ms (the sandbox refused the write) | `evidenceFailure: "it exited 1, not one of 0"`: sandbox-only |

Nothing started before the card was answered in either run: the host was sent `spawn` and `discard` for the draft and
for the re-read of the recorded call, and the one `start` after approval was the evidence run's. From the first host
message to the outcome: 147 ms for `file`. The draft was resolved twice before its card (the gate's precheck, then
again at approval so the stored pin is what the card showed); each was discarded.

What the second run shows, and what it does not: the card read the lying draft's call as "read, free", because a card
is derived from the draft and says so; the evidence run is what caught it. A lying manifest whose program fails
silently under the sandbox (exits 0 having written nothing) would pass; the check is the exit code, the envelope the
host applied and the protected names, never a diff of the root.

## (d), the registration page: #1063

Settings, "Program manifests (ml.sh)": every stored entry with whose it is, where it describes calls (B5), its evidence
or the evidence run's failure, and its pin; an add and a remove. What changed beyond the page: `MANIFESTS add` is pinned
by the host through the same precheck as a draft (`checkDraft`, origin `person`), so the page's payload never chooses a
pin. Not measured against the real host; the add's resolve is the same code path the two runs above exercised.

## Not done in root 2

- (c2) library manifests: only if time allows.
- The evidence run has not been measured on Linux (Landlock).
- The lying-manifest gap above is narrowed, not closed, by the operand check (`manifests/evidence-writes`): a recorded
  undescribed call's arguments are read as paths before and after it, and a draft calling it a reader fails if it
  created, modified or removed one. A write inside a named directory, or to a file no argument names, still passes.
  The closure is window-ml-host's, for Shane to post on the host repo: `done` carrying the sandbox's refusals,
  `"denied": { "write": <count>, "exec": <count>, "net": <count>, "paths": [<at most 16 refused write paths>],
  "truncated": <bool> }` (absent: the host cannot tell; Seatbelt's deny log, Landlock's audit records on 6.15+), so the
  evidence run fails on `denied.write > 0` whatever the exit code.
