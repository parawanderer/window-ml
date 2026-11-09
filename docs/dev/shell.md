# The process host from the extension's side (`ml.sh`)

What `ml.sh` is and why it is shaped this way is [`docs/spec/SHELL.md`](../spec/SHELL.md). This file is how the
extension half is built. The host itself is a separate repository (window-ml-host), whose PROTOCOL.md is the
wire it speaks.

## The pieces

| File | Holds |
| --- | --- |
| `src/shell/host-protocol.ts` | the protocol client (`HostClient`): seq matching, `done` events, `{ $bytes }`, the types. No `chrome` |
| `src/shell/sh-call.ts` | pure: a call's arguments parsed, a program manifest turned into spawn args, facts into card lines and policy facts, a `done` into a result |
| `src/shell/sh-put.ts` | pure: one `ml.sh.put` checked, the host's `put` facts into policy facts and card lines, a refusal's sentence |
| `src/sw/sw-shell.ts` | the ONE native port: connect, `hello`, protocol check, `configure` from Settings, idle close, the status and the shell capabilities |
| `src/sw/sw-shell-call.ts` | one `ml.sh` call: spawn → facts → version probe → policy or ask → judged again → start → outputs as pointers; `ml.sh.read`; `ml.sh.put` |
| `src/sidebar/settings/shell-section.tsx` | the Settings section "Programs (ml.sh)" |
| `tests/fake-native-host.mjs` | a host on the far end of the mocked `connectNative` (`loadBackground({ onNative })`) |
| `tests/e2e/native-host.mjs` | a REAL `wmlhost` for an e2e run, registered in the test profile only (`tests/e2e/ml-sh-host.spec.mjs`) |

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

0. `parseShRun` checks the argv before the host sees it: an item that IS a pointer token (`@tool:…`, `@file:…`,
   `@pt:…`, `@box:…`, the whole item) is refused as a held value, not a path (`heldValueRefusal`, SHELL.md's ruling of
   2026-10-28; one rule for every program, so no manifest repeats it). An item that only contains one (`--in=@file:x`)
   is the program's text. The prefixes come from `token-prefixes.ts`, a leaf, so the shell call's neutral bundle does
   not pull in the modules that mint them.
1. `spawn`: the host resolves the argv into facts (program, cwd, paths, repo, sandbox) and starts nothing. A manifest
   naming a `credential` (gh) adds `spawn.credential` when the session is sandboxed and `hello.credentials` lists the
   provider (`credentialFor`): the host then injects the person's token at `start`, and `judgeCall` never lets an
   allow or the free tier answer it (PROGRAM_MANIFEST.md, "The credentialed profile").
2. **The version probe**, for a manifest written against a version range (git, rg): an ordinary call of the manifest's
   own version args with effects empty, judged like any other. Free only under the sandbox, so on the plain host it
   is never raised; refused for a program inside the roots (and, since 2026-10-22, `shFacts` describes no in-root program by a shipped manifest, so `./cat` asks: PROGRAM_MANIFEST.md); 2 s, 4 KiB; cached by the program file's fingerprint
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

**A call no one was asked about is drawn under its step** (SHELL.md, "Approval"). Its span (`shSpanOf`) carries
`unasked`: `by` (`default` or `policy`, with the policy's label), the argv from the host's facts, and the same
`shOutcome` an allowed ask records. `UnaskedList` (ask-card.tsx) and the Markdown export draw it through
`unaskedLines`, which is `shOutcomeLines` after an "Allowed by" line, so the card and this line cannot word one call
differently; the JSON export carries the step's `shCalls` verbatim. A call the person approved has no `unasked`: its
ask already shows what ran.

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
and the run log's `shell`/`pin-changed` record keeps them. No script manifest ships: a pin is per repository, so a
script's manifest lives in its workspace's part of the store below.

**Manifests the person registered are stored beside the shipped ones** (PROGRAM_MANIFEST.md, "Registering a program", the store's ruling of 2026-10-23;
root K slice b, rulings B1 to B5 of 2026-10-23). `sw-manifests.ts` keeps them in `chrome.storage.local`
(`ml_manifests_global`, and `ml_manifests_workspace` by the root's realpath; declared `manifests.global` and
`manifests.workspace`), and the pure `stored-manifests.ts` says what may be kept and when one describes a call. The
store refuses at write time (`storeRefusal`), naming why: a key a shipped manifest describes (shipped wins, naming
the file), a binary without the host's pin (`path`, `fingerprint`, `inRoot`, and `version` only for a manifest that
reads one), a script's entry outside workspace scope or with a program pin, an in-root program for any scope but its
own workspace, and a second entry for one key in one scope and root. A read keeps the well-formed entries and drops
the rest, never repairing them. At call time `manifestsFor` puts the workspace's own entries, then the global ones,
before the shipped list; `storedMisses` makes the call `unknown`, with a `why` line, when the resolved program's path,
fingerprint or version is not the pin's, when an in-root program meets a non-workspace entry, and when an entry the
model proposed (`origin: "proposed"`) and whose evidence run has not passed meets a call not under the sandbox. A change waits for the first read
(`manifestsReady`), so an add made before it is not overwritten by it, and `shRun` waits for it too. Only an extension
page reaches the store: `MANIFESTS` (`list`, `add`, `remove`) refuses any other sender, and what it adds is the
person's (`origin: "person"`), whatever the payload says. An add is pinned the way a model's draft is (`checkDraft`,
`sw-manifest-proposal.ts`): the host resolves `{ manifest, scope }` under the root the page names (or the first) and
discards it, so the pin and a script's `sha256` are the host's and a payload's are never read; B3's forced scope comes
back as `forced`. The page is `manifests-section.tsx` in Settings, after "Programs (ml.sh)", on the policy page's row
styles; it re-reads on a change to either storage key.

**A model's draft goes through `propose_manifest`** (PROGRAM_MANIFEST.md, "Registering a program", the store's ruling of 2026-10-23, the slice c ruling).
The gate's precheck (`checkManifestProposal`, `sw-manifest-proposal.ts`) parses the draft (`parseDraft`), has the host
resolve it under each root and discards each resolve, pins it (`draftRequest`: a binary's path and fingerprint, a
script's `sha256` from the host's `paths`, B3 forcing workspace), and asks `storeRefusal`; an error goes to the model
and no card is shown. The card (`draftCardNote`) re-resolves this run's ran calls of the program with the draft as the
only stored entry and reads each through `shFacts` and the policies; `draftNote` writes it, DERIVED and said to be.
This run's ran calls are `shell.ran` (`sw-shell-call.ts`, memory, 64 per run, 32 runs), noted after each successful
`start`; a call that set environment variables is not re-read, because their values are not kept. On approval
`approveManifest` stores the entry and runs `evidenceRun`: on a sandboxed host only, it re-spawns each of those calls
with the 2 s probe limit, re-runs only one the stored entry makes free under the sandbox, starts it with
`envelopeFor`'s envelope (which must be `write: "none"`, on a host that takes envelopes), and checks the exit against
`okCodes`, the envelope the host reports, and `protectedChanged`; `markEvidence` stores the pass or the first failure.
Both go to the run log (`shell`/`manifest-added`, `shell`/`manifest-evidence`). The tool itself only reports the
outcome (`proposalOutcome`). It is offered by the settings (`shellTurnedOn`), not the measured status, so a run started
while a woken worker reconnects is offered the same tools; a host that does not answer is the precheck's error.

**`propose_manifest` with `library` proposes a tier 3 Python library** (READONLY_LIBRARY_MANIFEST.md, "The runtime
import loop", rulings A to D of 2026-10-24; `sw-library-proposal.ts`, the pure half `library-proposal.ts`). The
precheck (`precheckLibrary`) parses `{ path, module, names? }` (one identifier, no dots, not `_`; global scope only;
never with `manifest`), refuses a module already stored, and has the host resolve `cat <path>` with `pathArgs` hashing
the file, then discards it: a file that does not exist, is outside every root, or is a secret path never becomes a card.
The card (`checkLibraryProposal`) reads the source with ONE `shRun` of `cat` on the resolved path, recorded and judged
under cat's own manifest like any call; the text must be complete, at most `LIBRARY_MAX_BYTES` (64 KiB), and hash to
both the stream's and the resolve's sha256, or it "changed while it was read". The verdict is the sandbox's shape rule
(`pythonLibrary("shape")`, python-sandbox.md), with nothing of the library run; `libraryNote` writes the card, which
shows the source as Python. On the yes, `approveLibrary` loads it (`pythonLibrary("load")`, the enforce layer) and
stores it (`addLibrary`, `sw-libraries.ts`, key `ml_libraries_global`, at most 50) only if the load agrees; a
disagreement is a `python`/`library-disagreed` warn in the run log, a store a `python`/`library-added` record. The
Settings page "Python libraries" (`libraries-section.tsx`) lists them through `LIBRARIES` (`list`, `remove`, extension
pages only, no add), and a remove sends `PY_DROP_LIBRARIES`, which kills every Python worker the offscreen document
handed a library (`libraryPrincipals`), so nothing can still import it.

**CPU is a second measured fact beside memory** (host 0.7.0, root 1 of ROOT_K.md). `done.cpuMs`, the user and system
time of the call's members with the children they reaped, reaches `ShResult.cpuMs`, the span (`shSpanOf`), the
`shell`/`run` record and the event lane's row (`shCallText`); it is never bounded, and absent from an older host.

**Whose process is this** (SHELL.md, the ownership ruling of 2026-10-23, R1 to R5). The host answers `owner { pid }` from
its owner tables, which hold what it spawned and the process groups a connection on that machine declared with
`register`; `HostClient.owner` and `HostClient.status` read them. The worker only reads: it never sends `register`
(`tests/sh-call.test.mjs` holds that no file in `src/` does), and no page-started type reaches either call. Nothing in
the extension shows the answer yet: the agent-status line it is meant for is `AGENT_MAIL.md`'s first build step.

## Writing an attachment to disk (`ml.sh.put`)

`ml.sh.put(file, path)` writes an `@file:` attachment's ORIGINAL bytes (the value store's `data` row, never a PDF's
text) into a workspace folder (FILE_ATTACHMENTS.md ruling 3, amended 2026-11-08; the host's `put`/`write`/`commit` in
window-ml-host's PROTOCOL.md). `shPut` in order:

1. `parseShPut`: exactly a `@file:` handle and a path. The handle resolves on THIS run's shelf (`ctx.tokens.files`), so
   another run's handle is `ValueMissing` and names nothing of that run's file.
2. A run whose turn has `origin.remote` is refused, and so is one whose origin cannot be read (`ctx.origin`, read from
   `turnByRun`): the file would land on a machine the person is not at. The host refuses the hub transport too.
3. `hello.put` absent (an older host) or `null` (the hub) means the host cannot take a file; a file over `hello.put.max`
   is `TooLarge`, naming both numbers. Both before anything is sent.
4. The host's `put` resolves the target and writes nothing: `OutsideRoots`, `NoParent`, `IsSymlink`, `IsDirectory` and
   `Protected` become a sentence (`putRefusalText`) and no verdict can allow them.
5. `decidePut`: a `deny` always holds. A NEW file is judged as an in-root write by `judgeCall(…, "sh", putFacts(…),
   "host-sandbox")`: a policy, or the built-in default, which frees a nested path and asks for a new top-level name.
   The placement is the sandbox's because the host itself holds that bound for this one write (the parent's realpath in
   a root, through a held directory descriptor; protected and secret-looking names refused; never through a link). An
   EXISTING file always asks (`kind: "put"`), whatever a policy allows.
6. Chunks of `READ_CHUNK`, contiguous from 0, then `commit` with `replace` true only for a file that existed AND the
   person approved; a file that appeared since `put` is `Exists`. A cancel between chunks discards the put.

`putFacts` carries the keys of an `ml.sh.run` call that runs nothing (`argv: []`, `program`, `cwd`, …) beside its `put`
fact, so a person's policy written for programs reads them without throwing and is never marked broken by a put. A put
that ran without an ask is drawn under its step like any unasked call (`Wrote …`, `unaskedLines`). It never detaches.
In an isolated exec, `iso-channel.ts` names `put` with its own arity of exactly two; `run` and `read` keep theirs.

## Detached calls (ASYNC_CALLS.md, mode 1)

A call that runs past its lease detaches into a task: [`async-calls.md`](async-calls.md) is how that is built (the
lease, the task table, the inbox, the `task` tool), for `ml.sh` and every executor after it.

### A running call's tail (host `peek`)

`task tail` on a detached `ml.sh` call asks the host's `peek` (`HostClient.peek`) for the last bytes of each stream and
`sh-tail.ts` (`peekText`) turns them into lines. `hello.peek === true` is the ONLY gate: on a host without it, and over
the hub, `tail` stays null and the task tool says `SH_TAIL_ABSENT`; the worker never probes by calling `peek`.

- **The bytes are cut at a byte.** `peekText` drops a half character at the front (continuation bytes `0x80`-`0xBF`) and
  holds back an unfinished sequence at the end, so U+FFFD appears only for bytes the program itself wrote. When the data
  does not begin the stream (`size` is more than the data) the first line is partial and is dropped; a fragment with no
  newline at all is kept and marked, rather than showing nothing. Then the last N lines (CRLF split), each stream
  labelled, a null stdout (it feeds a pipeline stage) said as such, and `truncated` said as "passed the host's output cap".
- **How many bytes are asked** (`peekBytesFor`): 240 per line plus one line, never under the host's 4096 default, never
  over its 512 KiB ceiling.
- **The text is model-facing**: each stream is cut to exec's output cap (`OUTPUT_CAP.exec.default`, from the end), then
  `taskAction` runs the whole through `forModel` like any tool result. A `peek` failure sentence is scrubbed before it
  is cut to 120 characters, so the cut cannot leave the front of a key. `UnknownId` (the call ended between the
  model's request and the host's answer) says so; its result arrives on its own.
- **`ml.current.tasks` carries the same tail** in each running row's `tail` cell, one `peek` per running `ml.sh` task per
  snapshot; a failing ask leaves the cell null. The state inspector reads synchronously and sees null for these.

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
