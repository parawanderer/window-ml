# The process host from the extension's side (`ml.sh`)

What `ml.sh` is and why it is shaped this way is [`docs/spec/SHELL.md`](../spec/SHELL.md). This file is how the
extension half is built. The host itself is a separate repository (window-ml-host), whose PROTOCOL.md is the
wire it speaks.

## The pieces

| File | Holds |
| --- | --- |
| `src/shell/host-protocol.ts` | the protocol client (`HostClient`): seq matching, `done` events, `{ $bytes }`, the types. No `chrome` |
| `src/shell/sh-call.ts` | pure: a call's arguments parsed, a program manifest turned into spawn args, facts into card lines and policy facts, a `done` into a result |
| `src/sw/sw-shell.ts` | the ONE native port: connect, `hello`, protocol check, `configure` from Settings, idle close, the status and the shell capabilities |
| `src/sw/sw-shell-call.ts` | one `ml.sh` call: spawn → facts → version probe → policy or ask → judged again → start → outputs as pointers; `ml.sh.read` |
| `src/sidebar/settings/shell-section.tsx` | the Settings section "Programs (ml.sh)" |
| `tests/fake-native-host.mjs` | a host on the far end of the mocked `connectNative` (`loadBackground({ onNative })`) |

## How a session lives

- **Off until the person says so.** `shellEnabled` is false by default, and with it off or no workspace folder set,
  `connectNative` is never called: the host process is not even started.
- **One port, configured from Settings.** `shellHost()` reuses the open port while the four settings (`SHELL_KEYS`)
  are unchanged; a change closes it and the next call connects afresh. `hello` must report `HOST_PROTOCOL`, or the
  host is not used (`reason: "protocol"`).
- **Idle close after `SHELL_IDLE_MS`**, never while a call is in flight (`withShell`) or the host holds output a run
  may still read (`holdOutput`). The status survives an idle close: the host is still there to reach.
- **What dies with the worker:** the port (an MV3 eviction closes it, and the host then deletes the output it held).
  Declared as `shell.host` in the state registry.

## One call

`ml.sh` exists only in an isolated world: `exec-routing.ts` forces any script that names it there (reason `sh`) and
refuses it where no isolation exists. The wrapper (`isolatedWrapper`) gives the world `ml.sh` only when the run host
bound it, and each call rides the exec's own channel (`iso-channel.ts`, op `sh`) to `sw-shell-call.ts` with the run
and the step's seq the worker already knows (`delegateTool`'s `call`), never anything the script said.

1. `spawn`: the host resolves the argv into facts (program, cwd, paths, repo, sandbox) and starts nothing.
2. **The version probe**, for a manifest written against a version range (git, rg): an ordinary call of the manifest's
   own version args with effects empty, judged like any other. Free only under the sandbox, so on the plain host it
   is never raised; refused for a program inside the roots; 2 s, 4 KiB; cached by the program file's fingerprint
   (`shell.versions`).
3. `judgeCall(runId, "sh", facts, placement)`: a deny refuses (the host discards), an allow (a policy, or the
   built-in default: `effects ⊆ bound ∪ ReadsInRoots`) runs, anything else is a NESTED ASK on the running step
   (`sw-asks.ts`), whose card shows the facts (`shCardLines`), never the script. A store not yet loaded asks.
4. **Judged again** just before `start`: a deny saved while the card waited still holds.
5. `start`, then `done`: each stream's head (64 KiB) is read and noted as a `@tool:` pointer under its own id seed. A
   stream longer than its head stays held for `ml.sh.read` (`shell.outputs`, at most 32 a run), and goes when the
   session's pointers do, or with the port.

**Over the wire** (a full-mode python_exec cell): the cell's `ml.sh.run(...)` is one wire call named `sh.run` (the
facade sends a namespace member by its dotted path, `src/python/ml-facade.ts`). `sw-ml-wire.ts` gives `sh.run` and
`sh.read` only to a `full` client of a run that a running step opened: the opener records that step on the client
handle (`openWireClient`'s `step`, from python_exec's `call` through `grantRunPython`), and the call's ask is raised
there. Nothing in the request names a step (docs/spec/ML_WIRE.md); a read-only client gets `Absent`.

The result says who let it run (`approvedBy`) and how long it waited for the person (`waitedMs`); the exec's result
adds a line when that was a second or more.

**Every call has an owner and a memory bound** (SHELL.md, host 0.3.0). Each `spawn`, the version probe's included,
names `owner: { run, seq }` from the call's context (`ownerOf`), never from the script: an `owner` option is
`BadRequest`. The host keeps that in its owner table (`status`) and kills the call when the port closes. Past its
memory bound (physical footprint) the host kills it: the result has `killed: "oom"`, `ok` false and an `error`, and
`peakFootprint`/`memoryBound` in bytes, which the run log's `shell`/`run` record carries too. A host older than 0.3.0
sends none of these fields, and the result has none. The event lane shows them too: each finished call leaves a span
(`shSpanOf`, then `takeShSpans` when the step's tool returns) that rides the step's DONE event as `shCalls`; see
resource-panel.md, "ml.sh calls on a tool step".

## Capabilities

`shellCapabilities()` feeds the runtime's `RuntimeCapabilities` (sw-sessions.ts): `shellHost` when the host was
reached and configured, `shellSandboxed` when its calls run under the OS sandbox. `shellContainer` stays absent: no
container runner exists. Absent means no, as everywhere in the capabilities. The status is measured at worker start
when the setting is on, and again on every change to a shell setting.

## Who reaches the port

Only the worker, for a run's own call. `SHELL_STATUS` (the Settings page's measurement) is answered for extension pages
only: a content script's is refused before it can start the host. `tests/redteam.test.js` sends every page-started
message type from a hostile page and asserts the native port is never opened.

`nativeMessaging` is a REQUIRED permission in `manifest.json`. Chrome warns for it ("Communicate with cooperating
native applications"), so a store update asks existing installs to accept it. Making it optional, requested from the
Settings checkbox (a user gesture), is open: it has to work from both the overlay and the DevTools panel.

## Traps

- **An ask is shown only once it can be answered.** `raiseAsk` registers the pending approval BEFORE it emits the
  step: an approver that answers on the same turn (an external one, or the harness) otherwise finds no gate.
- **Reads inside the roots are free on the plain host too** (EFFECTS.md, `ReadsInRoots`); what the sandbox adds to
  the free tier is writes inside the roots.

- **`chrome.runtime.lastError` is the only place a native port says why it closed**, and only inside the disconnect
  listener (`nativePort`). Read later, it is gone.
- **The fake host answers synchronously enough to hide ordering bugs.** A test that depends on the port being open
  `flush()`es before asserting, as `tests/sh-host.test.mjs` does.
