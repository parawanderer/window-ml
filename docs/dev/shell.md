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
   (`shell.versions`). Its `start` carries the envelope `envelopeFor` derives from that same judged object, so on a
   K3 host every probe is sent `write: "none"`, `git --version` (an option git's manifest does not list) included
   (ruled 2026-10-19 on the red team's K3 audit, #827).
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

**What the host applied, and what changed, is told three times, as one fact** (SHELL.md, the envelope and tripwire
bullets; host K3 and K3b). The result carries `envelope` (what the host APPLIED, `null` from an older host), `asked`
(what was sent on start, absent for the floor), and `protectedChanged`: the protected names (`.envrc`, `.git/hooks/*`,
…) that changed DURING the call, `[]` when none, `null` when the host reported nothing, which is unknown and never
"none" (a list with one malformed entry is `null` too, never a shorter list that reads as complete), with
`protectedChangedTruncated` when the host cut it. The run log's `shell`/`run` record says `asked` (`floor`), `applied`
(`unknown`), `envelopeMismatch` and the `protectedChanged` count (`unknown`); a change also writes its own
`shell`/`protected-changed` record at warn, whose `changes` text is fitted to the log's 200-character
detail cap (`MAX_DETAIL_STRING`) and ends `and N more (the list was cut)` when it could not name them all, so the log
alone never reads a cut list as whole. A call the PERSON allowed gets its `ShOutcome` on the ask
(`noteAskOutcome`, the list cut at `SH_CHANGES_SHOWN`), so the line under the step shows "Sandbox applied" and
"Protected names" once it ran. A call a policy or the default allowed has no ask, so for it the run log and the
script's result are the only surfaces.

**An interpreted script is described by its own manifest** (PROGRAM_MANIFEST.md, "Interpreted script tools"; root K,
slice K1, host 0.4.0). A manifest with an `entrypoint: { path, sha256 }` has no `version`: `program` is the
interpreter, and `manifestFor` chooses it only when `argv[1]`, taken from the cwd, is `<root>/<path>` for a root as the
host resolved it, with no interpreter flag before it (`-u`, `-X`, `--` included). `planSpawn` asks the host to hash
`argv[1]` (`pathArgs` `{ arg: 1, hash: true }`), and `shFacts` describes the call only when the resolved file IS
`<root>/<path>` (a symlinked entrypoint is not), its sha256 is the pin, and the call runs under the sandbox; otherwise
it is unknown and asks, with a `why` line each. The card shows the script and its hash where a binary shows its
version. If the host refuses the start with `PinChanged` (the file changed after its facts were read), a call no
person approved is described again from fresh facts, once; one the person approved is refused, naming both hashes,
and the run log's `shell`/`pin-changed` record keeps them. No script manifest ships: a pin is per repository, and the
store that holds them is K2, so until then only tests pass their own list.

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
  the free tier is writes inside the roots, less the top-level NAMES of each root: creating an absent top-level file,
  or a `write-names` claim (create, remove, rename) that reaches the top level, asks (`claimsTopLevelName`, the
  `roots-less-top-names` bound). It needs the `topLevel`/`isRoot` facts, which `shFacts` computes only when it is
  given the roots; a `names` write with no such fact counts as top-level.

- **`chrome.runtime.lastError` is the only place a native port says why it closed**, and only inside the disconnect
  listener (`nativePort`). Read later, it is gone.
- **The fake host answers synchronously enough to hide ordering bugs.** A test that depends on the port being open
  `flush()`es before asserting, as `tests/sh-host.test.mjs` does.
