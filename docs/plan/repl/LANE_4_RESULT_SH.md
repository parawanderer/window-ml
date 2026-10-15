# Lane 4: the process host's extension side, `ml.sh` (result)

Work slug `repl-lane4`, session `b9bc1868-816e-4f91-86bc-4fc2e0f3047e`, model `claude-opus-5-5`, 2026-10-15. How it is
built: [`docs/dev/shell.md`](../../dev/shell.md). What it is: [`docs/spec/SHELL.md`](../../spec/SHELL.md).

## What landed

| PR | What |
| --- | --- |
| #704 | the pure core: the protocol client (`src/shell/host-protocol.ts`), one call's parse, plan, facts, card and result (`src/shell/sh-call.ts`); a script naming `ml.sh` forced into an isolated world (`exec-routing.ts`, reason `sh`) |
| #710 | nested asks (`src/sw/sw-asks.ts`): a card raised from inside a running step, keyed `${runId}:${seq}#${askId}`, on every surface (sidebar, DevTools, chat page, phone), both exports and the session index; SET_APPROVAL bound to the run's own tab (a pre-existing cross-tab hole for step gates) |
| window-ml-host #6 (v0.2.0) | `pipe`, `glob`, `program.fingerprint` |
| #724 | the native port (`src/sw/sw-shell.ts`), Settings "Programs (ml.sh)", `shellHost`/`shellSandboxed`/`shellContainer`, `nativeMessaging` (required); red-team test: no page-started type opens the port |
| this PR | `ml.sh.run`/`ml.sh.read` from an approved exec (`src/sw/sw-shell-call.ts`), the version probe, the descriptor union (#719), the red-team pass |

## The rulings as built

- **Every call is decided on the host's facts, never the script's word.** `judgeCall(runId, "sh", facts, placement)`
  answers with a policy or the built-in default (`effects ⊆ bound ∪ ReadsInRoots`), or the call is a nested ask whose
  card shows `shCardLines(facts)`. A store not yet loaded asks. The call is judged again just before `start`.
- **The version probe is an ordinary call**: the shipped manifest's version args, effects empty, judged like any other;
  free only under the sandbox, never raised on the plain host, refused for a program inside the roots (checked before
  the cache, so a hard link cannot borrow a probed program's version); 2 s, 4 KiB; cached by fingerprint in the worker.
- **Outputs are pointers under their own id seed**, head (64 KiB) in the result, the rest held by the host for
  `ml.sh.read` by range, at most 32 a run, released with the session's pointers or the port.
- **`PendingApprovalDescriptor` is a union by consumer**: a `fetch` or `sh` card cannot be built without `facts.effects`
  (`tests/types/approval-descriptor.types.ts`, mutation-checked); the runtime half is in `tests/nested-asks.test.mjs`.
- **State**: `shell.host` (the port, its status), `shell.outputs` (held outputs, per run), `shell.versions` (the probe
  cache), all lost on worker eviction. No session cwd or env is kept: each call names its own, relative to the first
  root.

## What the red-team pass found (tests/ml-sh-redteam.test.mjs)

Four findings, each a test that failed first, all fixed in this PR: a probe-cache borrow through a shared fingerprint;
a cancel during the call's resolve still starting the probe; a cancel landing during `start` lost; host error text
reaching the script unscrubbed. Found while building it, outside the pass: `raiseAsk` emitted an ask before
registering it, so an approver answering on the same turn found no gate (now register, then emit). Held: no
page-started type reaches the host; the main world never gets `ml.sh`; the channel's `sh` op answers only the call's
own world; only the person answers the ask; `ml.sh.read` reads only the run's own held output.

## Not done, and where it goes

- **`ml.sh` over the wire (a Python cell)**: 4c. The ask's step is a fact of the client handle, recorded when the opener
  issues it (ML_WIRE.md, as ruled on #729); it follows lane 1's facade PR.
- **`pipe`/`glob` forms**: the host has them (v0.2.0); the extension side does not call them yet.
- **The `_restricted.call` seam** for function commands waits for the dispatcher.
- **`nativeMessaging` as an optional permission**, requested from the Settings checkbox: open (docs/dev/shell.md).
- The real host and the OS sandbox are not exercised by window-ml's CI: every test uses `tests/fake-native-host.mjs`.
  window-ml-host's own CI runs the sandbox on macOS and Linux.
