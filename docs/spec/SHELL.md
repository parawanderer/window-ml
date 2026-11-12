# Spec (WIP): one executor, many places — processes through `ml.sh`

**Status: draft (2026-10-13, refined 2026-10-15). Built so far: the pure core (`src/shell/`), the native port and its
Settings, and `ml.sh.run`/`ml.sh.read` from an approved exec in an isolated world
([`docs/dev/shell.md`](../dev/shell.md)). `ml.sh.run`/`ml.sh.read` over the `ml` wire from a full-mode Python cell (the ask on the step that opened the client).
Not yet: `pipe`/`glob` forms.** Where processes run and how the model reaches them. The
mechanism of a single call (typed call to argv, a manifest per program) is summarised under "One call". It rests on
three specs: [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), which DESCRIBES a program (only the free tier waits on it),
[`POLICIES.md`](POLICIES.md), which DECIDES whether a call needs the person, and [`EFFECTS.md`](EFFECTS.md), the
vocabulary both use. Every `ml` call a script makes from wherever it runs is one message ([`ML_WIRE.md`](ML_WIRE.md)).

## The constraint: the model knows one executor

The model writes JavaScript in `exec`, and `ml` reaches everything: the page, the run's own context (`ml.current`),
earlier tool outputs (`ml.dereference`), the network (`ml.fetch`), models (`ml.chat`). It does not choose where its
script runs. That is already true today: `exec-routing.ts` puts an approved exec in the page's world, an isolated
world, or refuses it, by what the script NAMES, and a read-only survey is evaluated in the worker with its DOM reads
delegated to the page. The model learns the outcome (`ml.current.env.exec`), never picks it.

A second executor with a WORLD of its own (a `bash` tool beside `exec`, with its own variables, its own output and its
own rules) breaks that: every task then starts with "which one", and data has to be carried between them by the model,
in its context. Processes are therefore **a capability of the executor**, reached as `ml.sh`, the way the network is
reached as `ml.fetch`. There is no `bash` tool.

A second LANGUAGE is not a second world. Python (`python_exec`) is a REPL beside JavaScript with the same `ml` in it
(decided 2026-10-13, see "Python"), so the model knows one world reachable in two languages, and `ml.sh` is in both.
The one namespace is a map from name to HANDLE held by the worker, each handle pointing at where its value lives (the
page heap for `ml.state`, the Pyodide heap, the process host); where values live stays asymmetric on purpose
([`PERSISTENT_RUNTIME_SPEC.md`](PERSISTENT_RUNTIME_SPEC.md)), and reading one from the other language is a dereference.

## The model of it: one namespace, values that stay home

"Executes JS somewhere and has everything in memory" cannot literally be one heap: the DOM lives in the page, the run's
values in the worker, a 2 GB log in a container. What can be one is the NAMESPACE, with each value living where it was
made and the script holding a handle to it.

- **A value stays where it was made.** A process's stdout is kept by the process host; the script gets an ordinary
  pointer (`@tool:` token, `ml.dereference`). This is the session contract's rule for a subagent's result, reused
  unchanged ([`SESSION_CONTRACT.md`](SESSION_CONTRACT.md), "The value stays where it was made": addressed as
  `runtime:hash:<token>`, read as a byte range or "a pipe the child's runtime runs so only the reduction crosses").
- **An operation goes to the value, not the value to the operation.** `ml.pipe(out, "grep -i error | head -20")` on a
  host-held value runs the text-pipe dialect AT the host, and only the twenty lines cross. The dialect is TypeScript
  and pure (`text-pipe.ts`), so the host runs the same code, not a reimplementation.
- **Crossing is explicit and bounded.** Bringing a whole value into the script's realm is `ml.dereference`, with the
  same size rules as any pointer read. Nothing crosses because a variable was touched. RULED 2026-10-28 (for
  `FILE_ATTACHMENTS.md`): a pointer token of any prefix (`@tool:`, `@file:`, `@pt:`, `@box:`) given as an argv item is refused by the shell
  call itself (`describeCall`, one rule), with a sentence saying it is a held value, not a path; a manifest never repeats it.
  BUILT 2026-11-08 in `parseShRun` (`heldValueRefusal`), the check every argv passes before the host sees it, whatever
  its manifest: an item that IS a token is refused; one that only contains a token is the program's text.
- **Placement is unobservable.** The rule the rest depends on: where a script or a call runs may change its latency and
  nothing else. The same script gives the same result wherever the runtime places it. This is what lets placement be
  improved later without the model, or any script it wrote, noticing.

## Where processes run: a process host

A Chrome MV3 service worker cannot start a process, and Pyodide is WebAssembly with no `subprocess`. Processes run in a
separate program, the **process host**, which the browser runtime reaches and which never listens on a port
([`RUNTIME_HUB.md`](RUNTIME_HUB.md), Security 1: "Runtimes connect out and never listen").

| Transport | What it is | For |
| --- | --- | --- |
| **Native messaging** (`chrome.runtime.connectNative`) | Chrome starts the host over stdio; the host's manifest names the extension's id (`allowed_origins`), so nothing else can reach it; no port | **first**: this browser's runtime gains a shell on this machine |
| **The hub, as a desktop runtime** | the same host program registers its own key on the hub and connects out; commands are sealed and scoped (`desktop` scope, already in `Scope`) | later: a shell on ANOTHER machine (mlbox), and an orchestrator driving it |

One program, two transports. The hub form is the "desktop runtime holds a shell" the hub spec already names; the
native form is the same thing attached to one browser.

**A hub is not an execution environment, and an execution environment is not a hub** (Shane, 2026-10-15). The host
builds and runs with NO hub code: native messaging alone is a complete product, and the hub transport is an optional
build feature that pulls the hub's client crates in. The hub, for its part, knows nothing of shells or processes beyond
relaying sealed commands to a runtime that declared the capability. In code: the host is its own repository, built the
way `wmlbox` is built, not living beside it. The plan for building it: [`docs/plan/repl/`](../plan/repl/README.md).

**The host's session events over the hub** (ruled 2026-10-19, cases found by lane 4 building window-ml-host #11,
after the 2026-10-19 Q2 ruling that `done`, `exit` and the span are PUBLISHED session events, never a long-poll):

- **A caller's events go to that caller alone.** The stream key is wrapped to the calling principal's own agreement
  key, not fanned out to every `view` device of the account the way a browser runtime's `SessionPublisher` does. A
  browser runtime's sessions are the person's; a host's calls are a caller's, and its held output and owner table are
  already private to that caller (the per-caller ledger). A second device watching a desktop's calls is a widening and
  the owner's decision; it is one change to add and would not be one to take back. **Decided 2026-10-19 (Shane): no,
  for now.** `view` follows runtimes, never hosts: a device that views the runtime already sees each call as a step of
  the runtime's session, with its span and the output the model saw, and a direct subscription to the host would be a
  second path to the same call with its own held-output question. When a desktop host is itself a runtime (the hub
  desktop runtime), the runtime rule applies to it on its own, with no new grant. Revisable.
- **The frame is the host's native `done` record, versioned.** No session-stream envelope (`epoch`, `cursor`): those
  serve `reset` and `backfill`, and the host backfills nothing, since held output is read by request, one nonce each.
  Every published frame carries `v`, the host's protocol version, because session events are versioned and a reducer
  switches on the kinds it knows ([`RUNTIME_HUB.md`](RUNTIME_HUB.md)). The extension-side reader wraps the record into
  its envelope when it is built.
- **The stream counter never repeats across restarts.** It starts at the wall clock in microseconds AND above a
  high-water mark the host persists in its state directory (0600) beside its keys, so a clock stepped backwards between
  two runs (NTP, a restored VM) cannot reuse a counter under a new key. A reader holding the old key sees `skipped`
  jump, which is the designed signal.
- **A caller gone from presence past a grace of 30 s** (chosen, not derived) loses only its own calls, through its own
  owner table; another caller's processes are untouched.

### Two modes: a container, or the real filesystem

**Both are supported (Shane, 2026-10-13).** A container is the safe default for work that can be isolated. Working on
the person's own machine (their repo, their toolchain, their `git` and credentials), the way Claude Code and similar
tools run, is the other half, and it is not a lesser mode: for most real work it is the point.

| | **Container** | **Host** (the real filesystem) |
| --- | --- | --- |
| What it reaches | the folders mounted into it, nothing else | the person's machine, as the user running the host |
| Network | off unless granted | the machine's |
| Effects | discardable: a session's container can be thrown away or kept | permanent: files written stay written, nothing rolls back |
| Tools | what the image has | the person's own (`node`, `cargo`, `gh`, their shell config not applied: no shell) |
| Credentials | none unless mounted | whatever the user's files and helpers hold (`~/.ssh`, `git` credential helpers, cloud CLIs) |
| What runs without asking | the manifest's read-only calls, anywhere in the container | the manifest's read-only calls whose PATH arguments resolve inside a workspace root |
| Provenance | inputs mountable read-only by hash ([`NOTEBOOK_TOOLING.md`](NOTEBOOK_TOOLING.md) §10) | inputs are live files: the call log records paths and output hashes, not pinned inputs |
| Cost | a VM on macOS (Docker, Podman, Apple's `container`) | none: native speed |

**Who chooses:** the person, per workspace, in DevTools Settings (the superset rule in AGENTS.md); never the model,
never a page. The model learns which mode a call ran in from the call's result, as it learns where an exec ran.

**What host mode needs that a container gives for free:**

- **Workspace roots.** The person names the folders the agent works in. `cwd` stays inside them; a path argument is
  resolved (`realpath`, so `..` and symlinks cannot step out) and judged against them. The manifest marks which
  arguments are paths, so the host can resolve them; an argument the manifest does not describe is not a path the host
  can vouch for, and the call asks. What the host itself reads (the secret check, a text pipe over a held value) it
  opens by descriptor without following symlinks, component by component on macOS, which has no `openat2`; that
  closes the race for the host's own reads only, since the child reopens its arguments by name (see "Resolve, then
  run").
- **The free tier narrows to the roots.** A read-only call is free only when every path it names resolves inside a root,
  and never for a file that looks like a secret (`.env`, `*.pem`, `id_*`, a credentials file), wherever it is. Reading
  is the half of an exfiltration that the fetch gate does not see.
- **Standing rules**, which are policies ("Policies" below, and [`POLICIES.md`](POLICIES.md)): "always allow `npm test`
  in this repo" is a predicate over a structured argv plus a root, exact in a way a string pattern over shell text cannot
  be.
- **An OS sandbox, on by default (decided 2026-10-13).** Between a container and nothing: the host spawns each process
  under the OS's own sandbox (Seatbelt on macOS, bubblewrap on Linux) with writes confined to the roots and the
  network to an allowlist, keeping the person's tools and native speed. Both halves are needed, for the reason
  Anthropic gives for Claude Code's: without network isolation a process can send out what it reads (an SSH key);
  without filesystem isolation it can rewrite its way out of the network limit. Two choices differ from Claude Code's
  defaults, where the sandbox is off until turned on and a command runs unsandboxed when the sandbox cannot start:
  here it is **on by default**, and it **fails closed** (no sandbox available: every call asks, as a gap does
  everywhere else in this extension). Codex CLI is the precedent for on by default (writes confined to the workspace,
  network off). The person turns it off per workspace, knowingly; a tool that needs to write elsewhere (a package
  cache, `~/.kube`) gets that path added through its [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md) `write(fs(p))` effect
  or the workspace roots rather than the sandbox removed or a separate sandbox config file introduced
  ([`EFFECTS.md`](EFFECTS.md), "No separate sandbox profile file").
- **The sandbox widens the free tier, by definition.** An enforcer publishes the set of effects it bounds, and the free
  tier is "the call's effects are inside that set, plus reads in the roots" ([`EFFECTS.md`](EFFECTS.md)). Seatbelt
  publishes writes inside the roots and the network allowlist, so a sandboxed host-mode call is judged like a container
  call: a write inside the roots no longer needs the person, only an effect the sandbox cannot bound does. Plain host
  mode publishes nothing and keeps the narrow free tier above. This is what the sandbox is FOR in Claude Code too:
  fewer prompts, with the boundary set up front instead of judged per command.
- **The environment is scrubbed** to a whitelist in both modes; in host mode that matters more, since the host's own
  environment is the person's login session. A call's own additions meet TWO lists (2026-10-15): REFUSED, which never
  runs approved or not (`LD_*`/`DYLD_*`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`,
  `PAGER` and their kind, since each turns a read into running code), and FREE, the few a call may add and still be in
  the free tier (`LANG`, `LC_*`, `TZ`, `NO_COLOR`, `TERM=dumb`, `COLUMNS`); anything else asks.
- **A git "read" is only as read-only as the repository's config** (lane 4 of the plan, 2026-10-15). `core.fsmonitor`,
  `core.pager`, `core.hooksPath`, `diff.external`, a `textconv`, a `filter` driver, an alias or credential helper
  starting with `!` make `git status` or `git diff` run a program, and no manifest can see that from argv. Repo-level
  config is UNTRUSTED, because it arrived with the repository (a tarball, a copied tree); the person's global config is
  theirs. Two answers, both: a BELT, the host forcing `core.fsmonitor=false` and `core.pager=cat` through
  `GIT_CONFIG_COUNT` in its own base environment for every git spawn (plus `GIT_OPTIONAL_LOCKS=0`, so a status writes
  no index), with the manifest adding `--no-pager`, `--no-ext-diff` and `--no-textconv` to the read subcommands (an
  EMPTY `diff.external` pin is not an option: git tries to run the empty command and every `git diff` fails, measured
  by lane 4 on git 2.55, so the external diff is covered by the flag and the fact below); and a FACT, `repoConfigRunsCode`, from the host reading the repository's
  config and what its includes pull in for those keys, which the plain-host default policy requires to be false. Under
  the sandbox the harm is bounded and the tier is what the algebra says.
- **A recursive reader is judged on what is BENEATH its directory argument**, not on the named path alone (`rg pat .`
  reads `root/.env`). The manifest marks recursive readers (`rg`, `grep -r`, `find`, `ls -R`, `tar`, `du`); for one, a
  directory argument carries a `containsSecret` fact from a bounded walk by the host (past the cap it is `unknown`, and
  the call asks), and the default policy requires it false. A `.env` in the tree asks; a person whose dotenv test suite
  needs it free writes a WORKSPACE policy saying so. In the baseline host-mode sandbox (`v0.2.0`), Seatbelt hides
  credential STORES (`~/.ssh`, `~/.aws`) at any depth and relies on `containsSecret` / `pathArgs` for project `.env`
  files; under Root K's effect-compiled sandbox `Plan` ([`EFFECTS.md`](EFFECTS.md)), workspace secret files found by the
  host's walk are also denied at the kernel level unless the call explicitly named them and was approved (`allow_read`
  in `sandbox.rs`), so an interpreted script (`node scripts/tool.mjs`, `python3 scripts/tool.py`) cannot read `.env`
  behind its declared `argv` operands.

## Where the script runs

**First: where it runs today.** `ml.sh` is a call from the script's realm (the worker for a read-only survey, an
isolated world for an approved exec) through the worker to the process host. Outputs stay at the host as pointers, so
a script that runs `git log` and pipes it to `grep` moves twenty lines, not the log.

**Later, by the same rule as routing today:** a script that names `ml.sh` and nothing of the page could be evaluated AT
the host, saving the round trip per call. The read-only interpreter (`readonly-exec.ts`) is TypeScript with no DOM
dependency, so it runs there unchanged; an approved (full JavaScript) exec at the host needs a sandbox of its own,
which the container provides. Because placement is unobservable, this is an optimisation the model never sees.

**The routing rule this adds**, and it is a security rule before it is a placement one: **a script that names `ml.sh`
never runs in the page's main world.** There it would share a realm with the page's own scripts, which would read
process output and could call the host. It runs in the worker (a survey) or an isolated world (an approved exec), and
is refused where neither is available, exactly as a script naming `ml.current` is (`exec-routing.ts`, reason
`current`). `execNames` gains `sh`.

## One call

The model writes a typed call, and no shell ever parses a string.

```js
const r = await ml.sh.git.diff("HEAD~1", { stat: true });   // sugar for the plain form:
const r = await ml.sh.run(["git", "diff", "--stat", "HEAD~1"], { cwd: "repo" });
r.code; r.ok;                              // exit code as a value: grep's 1 and diff's 1 are answers, not errors
ml.pipe(r.stdout, "grep -c '^ '");         // stdout and stderr are pointers, held by the host
```

- **argv, never a string.** The host spawns the vector directly (`shell: false`). Injection and quoting are gone by
  construction, and what is judged is (argv, env, cwd).
- **The sugar has one fixed rule** for turning `{ stat: true }` into `--stat`, and everything is judged on the final
  argv, so the sugar can never widen what the plain form allows.
- **Explicit instead of implicit:** a glob is expanded by the host (`ml.sh.glob("*.c")`), a pipe between processes is
  `ml.sh.pipe(a, b)` (real OS pipes, still argv), and redirecting is a typed `stdoutTo:` argument whose effect is seen.
- **argv-safe is not option-safe.** A value that starts with `-` is read as an option by the program: a `ref` of
  `--output=f` makes `git diff` write a file, a search text of `-v` inverts `grep`. No shell is involved, so argv does not
  help. The manifest marks where a program's operands start, the host puts `--` (or git's `--end-of-options`) there
  when a value came from a variable, and the card marks such a value. In the 2026-10-13 panel, two of six models never
  guarded a typed search text, and none guarded a git ref correctly.
- **A pipe's result is every stage's.** `ok` holds only when every stage exited as expected (pipefail), each stage's
  code and stderr are kept (`r.stages[i]`), and `okCodes` says that `grep`'s 1 is an answer. Otherwise a failed `find`
  before `sort` reads as an empty success. A pipe is ONE approval showing every argv.
- **No shell is not no further process.** `npm test` runs its script through `sh -c`; `find -exec`, `xargs`, `env`,
  `timeout` and git aliases start other programs. The manifest marks such runners, the card says the call runs
  something else, and none of them is ever in the free tier on its own word.
- **No terminal, stdin closed:** a program that prompts fails at once instead of hanging; a time limit applies; a long
  one detaches with a cancel handle. That detach is mode 1 of [`ASYNC_CALLS.md`](ASYNC_CALLS.md), the one executor
  that has it today; the handle, the inbox return and the wake on a missed expectation are specified there.
- **Session state is data.** `cwd` and `env` are kept by the host per session and passed to each spawn; `env` writes
  have their own whitelist, since `PAGER`, `GIT_EXTERNAL_DIFF`, `LD_PRELOAD` or `GIT_SSH_COMMAND` turn a read into
  running code. A call's `env` ADDS to the session's; in the Python shim, `env={**os.environ, …}` would carry the
  sandbox's environment to the host, so it is refused with a steer. Restoring them is free; files a command wrote are NOT rolled back (only a container snapshot does that).
- **A session is a VALUE, held by the script, never by the host** (ruled 2026-10-30, Shane's question: a model
  should write `sh = ml.sh.session()` and `sh.cd("repo")` in one cell and `sh.cat("file.txt")` in the next, with the
  cwd kept). `ml.sh.session()` returns an object holding `cwd`, the `env` additions and options (`check`); every call
  it makes sends `{ argv, cwd, env }` explicitly, exactly as the plain form does, and the host keeps no per-session
  state. Persistence across cells then costs nothing new: a worker-hosted run keeps one Python namespace across its
  cells (`docs/dev/python-sandbox.md`, "A run's namespace"), so `sh` survives as any variable does, and in JavaScript
  from the console it lives in the page heap; one rule in both languages, no new lifetime. Loss is already specified:
  a reap, a kill or an evicted worker loses `sh` with the rest of the namespace and the next cell is told
  `namespace reset`, so nothing dangles at the host, nothing joins the owner table, and a resumed run has nothing to
  "find". The card is unchanged, since it already shows the cwd on every call, so a stale `cd` can hide nothing. The
  `with ml.sh.session() as sh:` form is the same object with nothing to tear down, documented as optional sugar; the
  bare form is the primary one, being what a model writes in a REPL. `sh.cd(path)` and `sh.env(name, value)` mutate
  the value, under the same root check and env whitelist as a call's own `cwd`/`env`. A shell metacharacter in an
  argv item (`sh.echo("foo", ">>", "bar.txt")`) stays refused with the steer to the explicit form, above; the cwd
  persistence does not change that. A host-held session with an id appears only when there is host state to own, a
  slice-1 container ("a session's container can be thrown away or kept"), and the cwd is never the reason to
  create one early. This closes the "Session state across turns" open question below.
- **`&&` is the calling language's control flow** (ruled 2026-10-20, Shane's question): a chain of calls is judged one
  call at a time as each arrives, suspending on an ask, and nothing new is needed to express it. In Python a result's
  truth value IS `ok` (`okCodes` applied, never `code == 0`, or grep's 1 breaks the chain), so
  `sh.git(["checkout", "main"]) and sh.npm(["install"]) and sh.npm(["test"])` is `&&` exactly: eager, short-circuiting,
  the first failing result or the last; the API doc says `if r:` means ok, since `CompletedProcess` is always truthy.
  In JavaScript the `await` makes that clumsy, so a session option `check: true` that throws on a non-ok result is the
  form there, opt-in only (the default stays the value, above). A chain of LITERAL argv judged as one card before the
  first spawn, the pipe's card without the pipe, is a possible later sugar, not planned: a later argv that depends on
  an earlier result cannot be shown before it exists, and with policies covering the free tier a chain of read-only
  calls asks nothing today. Build it only once a measured case shows the per-call asks are the annoying part.

RULED 2026-11-07 (the bench lane's proposal, `20261107-1357Z-bench-to-repl-specs-sh-tilde-proposal.md`; Shane's
agreement reached the coordinator relayed, "it saves tokens", and he CONFIRMED it in the coordinator's session the
same day, leaving the allocation to the coordinator): the HOST
expands a leading `~` in an `ml.sh.run` argument. Today argv is passed as written with no shell, so
`["cat", "~/notes.txt"]` names `<cwd>/~/notes.txt`, reads free inside the workspace and finds nothing (CORRECTED
2026-11-07 by the bench lane: a literal `~/.ssh/config` does NOT read free, since the credential-store segment match
applies anywhere in the path, so it asks, as qwen's canary run showed); in the bench's canary gemma4:31b spent a step
on `~` and fell back to `sh -c`, which always asks. The rule: the host
expands at resolve time, in the facts pass that already resolves path arguments, from the `HOME` it already passes
through, so the facts, the judging, the card and the spawn see one path; the judge never sees an unexpanded `~`,
because an expansion after judging would let `~/.ssh/config` pass as an in-root relative path. POSIX tilde-prefix
cut down: a whole argument that is `~` or starts with `~/`, in `argv[0]`, every operand and `cwd` alike; never
`~user`, never after `=`, never inside an argument; no globs, `$VAR` or pipes. Shown, not silent: the facts record
`{ index, from, to }` per expanded argument, the card and the unasked line show `~/x → /real/x`, the result's argv
echo carries the expanded form. No `HOME`: the argument stays literal and the facts say why, never `""` or `/`. A
host that cannot expand is told apart by its version; against it the worker keeps today's literal behaviour and the
JSDoc clause ("a leading `~` or `~/` in an argument is your home directory; nothing else is expanded") does not
appear. It is a host protocol change (resolve plus a facts field, PROTOCOL.md) and then a window-ml PR; the host
owner is the ASYNC LANE, as a third host slice after `peek` (allocated 2026-11-07, both in the host's resolve path),
starting only once `peek`, #1437, #1451 and #1453 are through; the window-ml tests and the `~`-spelled
canary row (must ASK and show the expanded path, never read free as a workspace path) are the bench lane's, finder's
own file. Independent of the lease bench. PEEK DESIGN ACCEPTED 2026-11-08 (the async lane, building on branch `async/peek` in its own window-ml-host clone): a new host call `peek { id, bytes? = 4096, at most 512 KiB }` answering `{ id, stdout: { size, truncated, data } | null, stderr: { … } }` with the LAST `bytes` kept bytes of a call still in THIS connection's running table (null for a stage feeding a pipe); anything else is `UnknownId` (an ended call keeps the `done` pointer plus `read`, as now). Bytes, not text: the worker decodes and cuts lines. Same transports as `read` and `cancel`, no hub refusal, since it reads only the connection's own call. `hello` gains `peek: true` so the worker tells an old host apart, and that flag is the ONLY gate (no probing by calling peek). Capture flushes each chunk before publishing its count, so a peek never reads past disk. Conditions (coordinator): the worker drops a partial leading UTF-8 sequence and cuts at a line boundary before the model sees anything; the tail is model-facing and goes through sw-scrub.ts and the tool-output cap (e3's row: a secret in a running call's stdout never reaches the model); host-side red-team rows: peek of another connection's id, of an ended id and of a never-issued id all `UnknownId`, `bytes` above the cap clamped rather than an error that names the size, a peek during capture never reads past the flushed count. The host PR carries its PROTOCOL.md paragraph, janitor-2 reviews, then the window-ml side: an `ml.sh` task's `tail` calls peek when hello says so, else today's null with the reason line, which stays for old hosts. The build arm of the lease bench re-runs after this slice. HOST PR OPEN 2026-11-08: parawanderer/window-ml-host#29 at aedbc008 (verified open, "peek, the latest output of a call that is still running"); janitor-2 reviews it against the conditions above, then the window-ml side follows. TILDE HOST DESIGN RULED 2026-11-08 (the async lane's note; branch `async/tilde` stacked on `async/peek`, PR after #29, janitor-3 reviewing): one rewrite at the top of `Session::spawn`, the only argv resolve path (pipe stages are spawned ids, `register` runs nothing), so facts, path facts, the repo argument, the pending argv and the spawn all see the expanded form; HOME is the host process's own, the value env.rs passes to the child, and unset, empty or relative counts as absent, the argument staying literal with a reason and `to: null`; the facts gain `tilde: [{index, from, to}]`, always present, `index: "cwd"` standing for the cwd, which is expanded then still checked absolute and inside a root; `hello` gains `tilde: true`, the only gate. Three rulings: `"cwd"` in the same list, typed `number | "cwd"`; every later argument expands, not only pathArgs-marked ones, since an argv must mean one thing regardless of manifest, keeping the spec's limit that only a whole-argument `~` or a `~/…` prefix expands (`~user`, `a~b`, `--flag=~/x` stay literal, each with a row); the no-HOME reasons are a fixed enum (`no-home`, `home-not-absolute`), never free text. Two pins: expansion happens BEFORE judging, so `~/.ssh/config` is judged as the expanded path and asks while `~/notes.txt` inside a root reads free; no probing, the hello flag decides. WINDOW-ML HALF BUILT 2026-11-09 on `async/tilde`: the worker passes a `~` cwd through only when `hello.tilde` says so, the card and the unasked line show each entry as `~/x is /real/x` (or warn that it stayed literal), and the JSDoc clause is conditioned on a new `shellTilde` capability rather than the host's version; glob's own cwd does not expand (janitor-3), which nothing in window-ml reaches, since the worker never calls `glob`. PUT SLICE RULED 2026-11-08 (Shane confirmed the ruling in the coordinator's session; the async lane's host design note accepted in full): the fourth slice of the resolve path, after tilde, lets `ml.sh.put(handle, path)` write an attachment's original bytes to disk (FILE_ATTACHMENTS.md ruling 3). THREE CALLS, spawn's resolve → judge → act shape, because "an existing file always asks" must be judged before a byte lands: `put {path, cwd, size}` resolves and answers facts only (`exists`, `existingSize`, `root`, `rel`, `tilde`, `expiresInMs`; the same tilde and cwd rules as `spawn`; the parent must exist, is held as a directory descriptor from then on so a later symlink swap cannot redirect the write; a missing parent is `NoParent`, a parent whose realpath leaves the roots is `OutsideRoots`, a symlink target `IsSymlink` whichever way it points, a directory `IsDirectory`, a `protected_rels` or `looks_secret` target `Protected` with no verdict that can allow it, `size` above the host's cap `TooLarge`); `write {id, offset, bytes}` appends chunks of at most 512 KiB (PROTOCOL's constant) at a strict offset into a temp file created `O_CREAT|O_EXCL|O_NOFOLLOW` 0600 beside the target; `commit {id, replace}` fsyncs, chmods to 0666 & ~umask and renames through the held descriptor, no-replace (`RENAME_NOREPLACE`/`RENAME_EXCL`) unless the person approved the overwrite, so a file that appears between the fact and the write is `Exists`; the answer is `{id, path, rel, size, sha256}`. The temp file is deleted on `discard`, TTL, a failed commit and connection end. Hello carries `put: { max }` (64 MiB first; the host owns the number, the worker refuses above it before the first write and its sentence names it). The host refuses the call over the hub transport (`HubRefused`, scope) as well as the worker refusing a run with `origin.remote`. The window-ml half NAMES `put` in the iso-channel allowlist and never relaxes its length guard (e3's guard row). Owners: async builds the host PR first on `async/put` stacked on `async/tilde` (janitor-3), then the window-ml half in `sh-call.ts` (janitor-2); e3's rule-10 rows are on `redteam/sh-put` at 7a056e3d (13 tests: 2 controls and 1 guard green today, 10 todo, each measured red with the todo stripped), the test-only PR lands after the feature merges. WINDOW-ML HALF BUILT 2026-11-08 on `feat/sh-put` (`shPut`, sw-shell-call.ts; `sh-put.ts`; how it works: `docs/dev/shell.md`, "Writing an attachment to disk"): a new file is judged under the sandbox's bound at placement `host-sandbox`, since the host itself holds that bound for this write, so a nested path is free and a new top-level name asks; an existing file asks as `kind: "put"`; a run whose origin cannot be read is refused like a remote one. FINDING 2026-11-08 (e3, rule 9): the argv pointer-token refusal RULED 2026-10-28 above is UNBUILT: `ml.sh.run(["cat", "@file:3fa91c2"])` spawns the token as a path, unflagged. Not an escape today (opaque token), but with `put` it reads as a route to the person's bytes; the async lane builds the refusal in `sh-call.ts` with or before the put window-ml half, and e3's row flips as the finder's own commit. GH UNDER THE SANDBOX RULED 2026-11-08 (the gh-host session's piece-2 note, measured on macOS 25.6 with gh 2.103.0): gh keeps its token in the KEYRING, not in `hosts.yml`, and reaches it by exec'ing `/usr/bin/security`; with no token reachable, gh answers anonymously with NO error (a private repo reads as "not found"). A profile that authenticates from the keyring needs exec of `security`, read of `~/Library/Keychains` and the `com.apple.SecurityServer` service, and with those three granted the sandbox read a throwaway Keychain item another tool had stored: the Keychain ACL trusts the `security` binary, not the caller, so that variant is the whole Keychain and is REFUSED. The brief's variant (the credential directory read-only, `hosts.yml` writable) is withdrawn. ACCEPTED: a credentialed-network variant of `host-sandbox` whose credential the HOST holds and injects. The host has a fixed table of credential providers in code (v1: `github`), each saying how the token is obtained outside the sandbox (v1: the person's resolved gh run unconfined at spawn with `auth token --hostname github.com`, stdout captured and never logged; a Keychain dialog on first use is the person's one-time consent), which env name receives it (`GH_TOKEN`) and which program may name it (gh, by manifest name AND resolved binary). The manifest names only `credential: {provider}` and `network: {direction, ports}` with ports a subset of the provider's list ([443]); no path, env name or argv comes from a manifest, and the provider is honoured only for a manifest whose hash is in the host's pinned vector copy. The host sets `GH_TOKEN`, `GH_CONFIG_DIR=<call tmp>/gh` (throwaway: the person's pager/browser/editor keys and aliases are never read, which takes #1538's finding (e)), `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_TELEMETRY=0`; a call env naming any `GH_*`, `GITHUB_*`, `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY` (any case) or `SSL_CERT_*` is refused (takes #1538's finding (c)). No token from the provider is `SecretUnavailable` before spawn: the call never runs anonymously by surprise (measured: a wrong token is a 401, not a fallback; an empty config dir refuses `api`). It ALWAYS asks: no policy allow applies, the free tier never covers it, and the card says "sends your GitHub token" through a `credential` fact (the "as the person" term #1538 pinned). Exec stays program-only, {gh, git, git's exec-path helpers}, never `/usr/bin/security`; Seatbelt is inherited, so git spawned by gh runs under gh's profile with port 443 and `GH_TOKEN` in its env, reads no credential helper, goes anonymous over https and fails over ssh (`~/.ssh` stays denied); the gh calls that spawn git with network already describe `runs-code` and ask. Seatbelt profile additions: `(allow network-outbound (remote tcp "*:443") (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))` and `(allow mach-lookup (global-name "com.apple.trustd.agent"))`; port 80 is refused; nothing is written under `$HOME`. An env token is never refreshed or persisted (gh source `internal/config/config.go`, `ActiveTokenWithRefresh` returns a non-refreshable credential unchanged), so #1538's `hosts.yml` write does not arise on this path. Placement: the placement stays `host-sandbox`; `done`'s envelope gains `profile: "credentialed:github"` beside `write` and `exec`, and the worker's `boundFor` treats it as its own bound (network read and write, the credential effect, never free). A host that lacks the provider or a platform that cannot hold the variant answers `SandboxFailed` and NEVER the ordinary profile, which is the anonymous-by-surprise one; the worker then shows "asks, runs on the plain host" (the plain host keeps today's behaviour: gh asks and runs unconfined with the person's own keyring). STAGING: v1 is macOS with `*:443` (Seatbelt filters by address and port, so the host set is not scopable there), Linux answering `SandboxFailed`; PR 2 is a local CONNECT proxy on BOTH platforms (Seatbelt allows only `localhost:<port>`, bwrap keeps `--unshare-net` with a host-side unix socket bound in and a forwarder inside; the host sets `HTTPS_PROXY`; the proxy filters by CONNECT host: api.github.com, github.com, uploads.github.com, *.githubusercontent.com), designed after v1 merges and measured on Linux by an mlbox handover. SHANE'S DIRECTION 2026-11-08 for PR 2: a manifest author must be able to declare the specific hosts a program may reach, so the PR 2 manifest shape carries `network.hosts` (exact hostnames or one `*.suffix` form, never a bare `*`), enforced by the proxy; a credential provider further restricts where the TOKEN may go to its own host list; a declared host is a described effect the card names ("reaches api.example.com") and asks by default. Hostile-manifest refusals: no path field exists; an env name is never taken from a manifest; a provider not in the table, or named by another program's manifest (curl naming github), is refused; ports outside the provider's list are refused at load; an unpinned manifest gets the ordinary profile. RED-TEAM ROWS (rule 10; e3 writes them as a test-only PR in a separate session after the feature merges): (1) `/usr/bin/security find-generic-password` on a throwaway item fails under the variant, direct and via gh; (2) `~/.config/gh` and `~/Library/Keychains` stay read-denied; (3) no token is `SecretUnavailable` and gh never ran; (4) a call env setting `GH_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, `GH_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`, `HTTPS_PROXY`, `https_proxy` or `SSL_CERT_FILE` is refused; (5) port 80 and a non-443 port are refused, 443 admitted; (6) `gh api https://<local listener>:443/x` sends no `Authorization`; (7) `GH_CONFIG_DIR` is under the call's tmp and gone after, nothing under `$HOME`; (8) the curl manifest naming `provider: github` is refused and an unpinned one gets the ordinary profile; (9) what git spawned by gh CAN do is pinned as a FINDING row; (10) the token appears in no `done`, run log, error text (`sw-scrub.ts`) or card; (11) upgrade: an old host answers `SandboxFailed` to `profile: credentialed:github` and the worker does not retry under the ordinary profile. OWNERS: the gh-host session builds both halves (host PR reviewed by janitor-3; window-ml half, `boundFor`, the `credential` fact, scrub, the upgrade row, reviewed by janitor-2), after host#30 (MERGED a9613327) and the release workflow PR. Unmeasured and said so: the Linux rules, the proxy, git under the inherited profile, whether `gh auth token` run by the host prompts. HOST RELEASE WORKFLOW RULED 2026-11-08 (piece-3 note; the host has 0 releases and CI needs a pinned binary): modelled on the hub's `release.yml`; trigger a `v*` tag push plus `workflow_dispatch` with a tag input, checkout of the TAG, concurrency `release-<tag>` not cancelled, a version gate failing when `wmlhost --version` is not the tag minus `v`; three native targets (x86_64-unknown-linux-gnu on ubuntu-24.04, aarch64-unknown-linux-gnu on ubuntu-24.04-arm, aarch64-apple-darwin on macos-14), default features (`native`, no `hub`), each job unpacking its own `wmlhost-<tag>-<target>.tar.gz` (wmlhost, LICENSE, README.md) and running `--version` and `clients/node/smoke.mjs` before upload; `<archive>.sha256` beside each and one `SHA256SUMS`; a `publish` job with `contents: write` creates the release with generated notes and uploads WITHOUT `--clobber` (a tag's bytes are immutable; a broken release gets a new tag); `actions/attest-build-provenance` on each archive IN v1 as provenance, not a gate. The gate is window-ml's OWN pin: unlike fetch-hub, which trusts the release's `.sha256` from the same release, window-ml commits the per-target sha256 in a pin file (flaky-ci's fetch-host; a `host-dist.json` under tools suggested) of shape {repo, tag, commit, assets{<target>:{file, sha256}}}; `fetch-host --bump <tag>` downloads SHA256SUMS and each archive, hashes each itself, refuses unless both agree, reads the tag's commit through the API and rewrites the pin; `--bump --check` compares and writes nothing (the reviewer runs it); a pin bump is a window-ml PR with @ci (+@security when the host sandbox changed) naming tag, commit and the three hashes. First tag v0.7.0 (Cargo.toml's version; tags stop at v0.5.0), cut by the gh-host session on main after host#30 and the workflow PR merge. Shane's own setting to flip: immutable releases on window-ml-host. Unchecked: ubuntu-24.04-arm availability, smoke.mjs on a release build, mlbox's glibc (a 24.04 build needs 2.39; musl is the fallback). CI GAP CONFIRMED BY SHANE 2026-11-08: CI runs ml.sh against a real wmlhost (the e2e specs skip without the binary today). Allocation (Shane confirmed): the release workflow is the gh-host session's; fetch-host, the ml-sh-host.spec gate and one put round trip are flaky-ci's after #1535, design note first, the job FAILING (never skipping) when the release is unreachable; async takes nothing more beyond tilde, put and the argv pointer-token refusal. HOST RELEASED 2026-11-08 (all verified with gh). host#32 (the release workflow) MERGED 323b5c21 after janitor-3's clean review at fcc22473 (comment 6721562229); host#33 (put) MERGED 37739365 after janitor-3's review at 61767538 (6721562412), so all three host slices are in (hello peek, tilde, put). Shane allowed the tag push: wmlhost v0.7.0 is RELEASED by run 42491062828 on all three targets (version gate, smoke, attestation, publish), release immutable, seven assets (three archives, three .sha256, SHA256SUMS). The tag is ANNOTATED: the ref peels through tag object dfecf446 to commit 323b5c21. RULES ADDED: (1) fetch-host's `--bump` and `--check` PEEL the tag (the ref API returns an object of type tag, not the commit) and compare the peeled commit with the pin's `commit`, refusing on a mismatch rather than storing the tag object's sha; (2) the publish job's `--clobber` is ACCEPTED as an exception to the no-clobber rule when and only when the target is still a DRAFT release (a re-run refilling a short draft); a published release is never clobbered, which immutable releases enforce server-side; a re-run deletes no asset it does not upload, which is fine because a published tag's set never changes. The pin values (per-target sha256: x86_64 a7624078…, aarch64-linux f7772d3f…, darwin 9f91a28a…) went to flaky-ci in session-mail (20261108-1444Z-gh-host-to-flaky-ci-wmlhost-v0.7.0-pin.md); fetch-host starts after #1535 merges, design note first. #1535 (fetch-hub retry) is CLEARED by janitor-3 at c705c406 (6722861933; CI fully green including hub and all three e2e shards; four new body-read catch rows); flaky-ci arms; once on main, #1478, #1508, #1524 and #1536 rebase and the 504 blocker lifts. gh-host proceeds to piece 2 v1. FETCH-HOST DESIGN RULED 2026-11-08 (flaky-ci's note, session-mail 20261108-1450Z; ACCEPTED as written, coding may start). The pin is a `host-dist.json` under tools, shape `{repo, tag, commit, assets{<target>:{file, sha256}}}` with v0.7.0's values (commit 323b5c21, the three sha256 from gh-host's 1444Z note); it is the ONLY trust root: fetch-host never fetches the release's `.sha256`, checks the archive against the pinned hash BEFORE unpacking, and runs `--version` after landing at `../window-ml-host-<tag>/target/release/` so the existing sibling scan in native-host.mjs is unchanged. `--bump <tag>` downloads SHA256SUMS and every archive, hashes each itself, refuses on any disagreement, and PEELS the tag (ref `object.type` "tag" → `git/tags/<sha>` → `.object.sha` until a commit; a lightweight tag is stored as-is); `--bump --check` writes nothing and refuses a pin whose `commit` is a tag object (its own row: passes 323b5c21, refuses dfecf446). The gate job (ubuntu-24.04, cache keyed on the pin's hash, fetch on miss, a visibility step that exits 1 when the binary is absent, E2E_WMLHOST exported so the spec's skip cannot fire) runs ml-sh-host.spec and FAILS when the release is unreachable, never skips; the one put round trip joins it as a second ROW once put's window-ml half merges. glibc ≥ 2.39, bubblewrap and the AppArmor userns step are carried as job requirements, marked as gh-host's unverified claims. Reviewer janitor-3; label @ci; a pin-bump PR carries @ci (+@security if the host sandbox changed) and names tag, commit and the three hashes. GH PIECE 2 v1 OPEN 2026-11-08 (gh-host's note, session-mail 20261108-1615Z; verified with gh). host#34 e658e84f (@host): a provider table in the host's credential module; `spawn.credential:{provider, manifest:<sha256>}`; `hello.credentials`; `done.envelope.profile`; Seatbelt `(remote tcp "*:443")`; exec program-only (gh, git, git-remote-http(s)); the token read at `start` (`SecretUnavailable` if none); `CredentialRefused`; Linux answers `SandboxFailed`; env denylist plus `GH_*`, `GITHUB_*`, `SSL_CERT_*`, `*_PROXY`. #1545 a2dbc235 (@host @security @docs): manifest `credential:{provider}` and `network:{ports}` (no `direction`; hosts come in PR 2), the gh manifest, `credentialFor`, `ShFacts.credential`, `judgeCall` (no allow policy and no free tier for a held credential), a GitHub-token scrub by shape, an upgrade row. SIX READINGS ACCEPTED: the token is read at start; `network` carries ports only; an unpinned manifest hash is `CredentialRefused`, never a demotion; gh planted in a root or named by path is refused because the token fetch runs unconfined (e3's row 12: planted ./gh, a root first on PATH, an absolute gh, an in-root git `--exec-path`, each refused before anything runs); `boundFor` is unchanged; the upgrade goes through `hello.credentials`. #1538's (c) and (e) are taken. Measured by gh-host: no Keychain dialog, `gh api /rate_limit` 5000, a non-443 port refused. REVIEW: janitor-3 is the only pass on host#34 and janitor-2 reviews #1545; e3's twelve rows are the adversarial pass after both merge. host#34 PASSED 2026-11-08 at e658e84f (janitor-3, comment 6723473480: no findings, no change; the three load-bearing guards each have a row that reds when the guard is removed; no planted-binary route, since PATH is on the denylist and the only writable place outside the roots is the call's own tmp; vectors byte-identical to window-ml 8324c22d; CI run 42493113720 green). Two notes, neither a change: the exec-path directory enters the allowlist as git reports it; the token fetch blocks the session task up to 30 s. host#34 MERGED f82f08f5 (squash of e658e84f, four checks green; clone removed); the pin bump carries it into window-ml once fetch-host exists. #1545 waits on janitor-2; e3's rows measure once it merges. 2026-11-08 evening: #1542's merge (980a7f93) left #1545 a2dbc235 CONFLICTING on sh-call.ts, its test file and docs/dev/shell.md; gh-host merges main into feat/gh-credentialed (a merge, so the diff stays reviewable) and names the new head to janitor-2, keeping #1542's four-prefix refusal in parseShRun. async's put window-ml half starts on feat/sh-put from main; it will meet the same merge if it touches sh-call.ts after #1545 lands. #1545 at 67bcf16a (verified: a merge commit over a2dbc235 and main 980a7f93; mergeable again): docs/dev/shell.md keeps #1542's step 0 and the credential step 1; the four-prefix refusal is intact; gh-host reports tsc clean and the full suite green (8831 pass). janitor-2's review must name 67bcf16a. The host side is complete: host#30 and host#34 merged, v0.7.0 released 2026-11-08 14:43Z; janitor-3 removed its host clone after its three host reviews merged. FETCH-HOST OPEN 2026-11-08 (flaky-ci; verified with gh): #1549 at 21a10ff5 (@ci; eight files: the tests workflow, AGENTS.md, working-in-the-repo.md, package.json, a fetch-host script under scripts, test.mjs, a fetch-host-pin test, and the host-dist pin under tools). The ruling is implemented as written: the pin is the only trust root; the peel rule has its own rows (--check passes on 323b5c21 and refuses a pin that holds dfecf446 by name); --check writes nothing (a row runs it against a temporary pin and asserts the bytes unchanged); the gate job fails at fetch or at its visibility step, and E2E_WMLHOST is exported at the binary the step found, so the ml-sh-host spec's skip cannot fire in CI; the put round trip is named as the job's second row once async's window-ml half merges. One deviation RULED acceptable: the bump path reads the git ref and tag objects with plain fetch to the same api.github.com endpoints instead of the gh CLI, so the peel and --check rows run with a stubbed fetch and no gh dependency; the endpoints and the peel semantics are the ruled ones. Non-blocking note passed to janitor-3: the patch sends no Authorization header, and unauthenticated reads of api.github.com are limited to 60 per hour per IP, which bites only a reviewer re-running --check; sending GITHUB_TOKEN or GH_TOKEN as a bearer when set would remove it. janitor-3 reviews; flaky-ci arms on a comment naming the head; the pin bump that moves CI onto v0.7.0 follows as its own PR. PUT WINDOW-ML HALF OPEN 2026-11-08 (async; verified with gh). #1553 at 6de56c33 (@exec @security; eighteen files, among them a new sh-put module under src/shell, its own sh-put test, iso-channel, sw-shell-call, sw-values, the ask card and the export): an `@file:` attachment's original bytes written to the host's disk over the host's put/write/commit (host#33). `put` is named in iso-channel with its own arity of exactly two; run and read keep their bound of two arguments; a run whose origin cannot be read is refused like a remote one. e3's three fixture notes are folded into its own file at fcd928da on redteam/sh-put (15/15 against the branch with todos stripped); its test-only PR lands after #1553 merges, per #1307. TWO GUESSES RULED ACCEPTED. (1) The judgement runs at placement host-sandbox: a put runs no child, but the host itself holds the write bound for this one write (the parent's realpath inside a root through a held directory descriptor, protected and secret-looking names refused, never through a link), which is the in-root write with no new tier that FILE_ATTACHMENTS.md ruling 3 names; at host-plain every put would ask and the free nested-new-file tier would be dead. The built-in frees a nested new file, asks for a new top-level file, and always asks for an existing file. (2) putFacts carries the keys of an ml.sh.run call that runs nothing (argv empty, program, cwd) beside put, so a person's program policy evaluates without throwing and a put never marks it broken. CONDITION on (2): a program policy must never FREE a put; a rule on c.program.path naming a real program evaluates to false on a put's facts, and a row says so under both placements. janitor-2 is asked to confirm the row exists and to report its absence as a finding. The chat-page lane's FILE_ATTACHMENTS paragraph and UPGRADE row follow the merge. PEEK WINDOW-ML SIDE RULED 2026-11-09 (the async lane's commit 6d48eb40 on async/peek-tail, stacked on feat/sh-put, opening once #1553 merges): (1) two tail bounds, by who asked. The 500-character OUTPUT_CAP.exec.default bounds the tail nobody asked for (the `Detached` message, the inbox line, the `ml.current.tasks` row); the tail the model ASKS for through `task tail` is lines-first, the N asked capped at TASK_TAIL_MAX_LINES (200) with a ceiling of 8 KiB per stream, keeping the end, the full capped stream a value it can point at. "Capped like any tool output" meant bounded, not 500. (2) `ml.current.tasks` keeps one peek per running `ml.sh` task per snapshot (4 KiB requested, the small bound shown); null only when `hello.peek` is false, with the reason sentence. Accepted as the lane guessed: bytes requested (N+1)*240 clamped to 4 KiB-512 KiB; a no-newline fragment that does not start the stream kept and marked "(start of the line cut)"; SH_TAIL_ABSENT reworded to name the old-host and hub cases (model-facing; listed for the next prompt review). Rule 10: e3's secret-in-stdout row ships as e3's test-only PR after the feature merges. janitor-2 reviews. VERIFIED 2026-11-09: #1545 MERGED 337095ac (the gh credential sent to a host that holds it, the call always asks, a GitHub token scrubbed by its shape) with host#34 f82f08f5 merged on the host; the pins' release field is filled when the next host release carries it (flaky-ci's bump). e3's test-only pass on the new surface is #1561 OPEN c3d90df0 (tests/redteam-gh-credential.test.mjs, measured worker-side), janitor-3 reviews, landing after the feature as the amended rule 10 has it. RULED 2026-11-09 (PR 2, gh-host's design note in session-mail 20261109-1145Z, scoping the credentialed call to GitHub's hosts with a host-side CONNECT proxy; v1 complete: host#34 f82f08f5, host#35 4105a44b, #1545 337095ac, #1561 82a3ed37): the profile allows exactly one outbound address, `localhost:<P>`, a port the host binds for this call alone; behind it a proxy in the host process admits only `CONNECT <listed host>:443` (exact match after lowercasing and one trailing dot; IP literals, userinfo, percent-escapes, any other method and absolute-URI GET get 403 with no outbound connection; TLS is never terminated); the env (`HTTPS_PROXY` and kin, `NO_PROXY` empty, `ALL_PROXY`) is routing only. Q1: `network.hosts` goes in the manifest as a subset of the provider's list (validator and schema, as `ports`); the host pins both gh.json hashes for one release and an old gh.json gets the provider's full list, so scoping is host behaviour from the first release; `done.envelope` gains `hosts`; the extension's pin bump follows the release. Q2: mDNSResponder is dropped from the profile, measured in the PR; a negative result keeps the socket and the body says what broke. Q3: PR 2a (macOS proxy, worker hosts, card names the hosts, `ShFacts.credential.hosts`) now; PR 2b (Linux: bwrap keeps `--unshare-net`, a unix socket bound into the call tmp, `exec-under` forwards `127.0.0.1:<P>` to it) after mlbox's measurements; `holds_credentials` stays false on Linux until 2b. Q4: the note's limits list goes into the host's SANDBOX.md with 2a, plus: the proxy resolves the listed name with the host's resolver, so the bound is the name, not the address; a client that ignores the proxy env fails closed. Rows 1 to 13 are e3's, each failing first, under the amended rule 10 in both repos. Reviewer for the host PR 2a: janitor-2; the worker PR's reviewer is assigned by load when it opens. MEASURED 2026-11-09 (mlbox, slop-zone a0821d8, reports/ui-api/gh-host-linux-proxy-answer.md; reported by mlbox and gh-host alike, the repo is not on GitHub so the commit is not verified here): PR 2b's design works on the Linux box. Loopback comes up under bwrap `--unshare-net`; a unix socket bound in with `--bind` accepts connections from inside; curl, git and python reach GitHub through the forwarder while example.com gets 403, a direct connect gets ENETUNREACH and there is no DNS; gh 2.98 honours `HTTPS_PROXY` (a fake token got 401 through the proxy). glibc 2.43, bubblewrap 0.11.1, Landlock ABI 8. Caveat for SANDBOX.md and 2b: Ubuntu 26.04 restricts unprivileged user namespaces and bwrap works only through the AppArmor profile attached to `/usr/bin/bwrap` by path, so a vendored bwrap elsewhere is denied. PR 2b is unblocked; 2a in progress. OPENED 2026-11-09 12:10Z: PR 2a is window-ml-host#36 at 5a9e2e14 (`@host`, CI running at open). gh-host reports: the profile allows only `localhost:<the call's proxy>` with no DNS; Q2 measured (authenticated gh, rate limit 5000; tarball, release download and raw reachable; example.com answered 403); Q1 both gh.json hashes pinned; the vectors come from window-ml commit 99c96e8d on feat/gh-network-hosts, the worker PR to come (no PR open yet); SANDBOX.md carries the Q4 limits, the two coordinator lines and the AppArmor caveat. e3's v1 FINDING row (any 443 host reachable) fails as expected on the branch; e3 flips it there as its own commit per rule 10. Reviewer janitor-2, as ruled. The measurements are gh-host's report, not verified here; the reviewer confirms them. REVIEWED 2026-11-09 13:00Z: janitor-2 reviewed window-ml-host#36 at 5a9e2e1 clean (comment 6740566163); the one red check is e3's v1 FINDING row, which the PR invalidates on purpose. Head is now 6e73973d (one commit: the 0.8.0 version bump in Cargo.toml, Cargo.lock and docs/PROTOCOL.md). Order from here: e3 flips the FINDING row and rows 1-10 as its own commit on the branch, janitor-2 re-checks the final head, gh-host merges and tags v0.8.0, then opens the worker PR from feat/gh-network-hosts (at 995f3079: the validator and schema take `hosts` as a subset, `ShFacts.credential.hosts`, the card names the hosts, an upgrade row for a host that names none, PROGRAM_MANIFEST.md); only the credential-pins test is red there until #36's merge commit exists. gh-host reports Shane approved the v0.8.0 tag in its session; CONFIRMED by Shane in the coordinator's session on 2026-11-09: this one tag is approved. FLIPPED 2026-11-09 13:30Z: e3's rows 1-10 of the PR 2 note are on host#36 as its own commit, head 8061d665 (one commit, tests/stdio.rs only, verified), each through a real call, the v1 FINDING row (any 443 host reachable) folded into row 5: a raw connect to GitHub's own address or a third party's is refused by the profile and only the proxy admits anything; ten green, full stdio suite 155/155, each row measured red under its own mutation. All four CI jobs green, mergeable; janitor-2 asked to name the head, then merge, tag v0.8.0, worker PR. MEASURED (e3, macOS 26, forwarded to gh-host for SANDBOX.md): the resolver's unix socket is what closes DNS; the grant that reopens resolution is `(allow network-outbound (remote unix-socket (path "/private/var/run/mDNSResponder")))`; mach-lookup grants for com.apple.dnsResponder, com.apple.dnssd.service and com.apple.networkd restore nothing, and resolution fails under `(allow default)(deny network-outbound)` too. The thing never to add back is that socket path, not a mach service. MERGED 2026-11-09: host#36 squash-merged as 7158d74f after janitor-2's comment named 8061d66 (per gh-host); v0.8.0 is tagged and released with three targets and SHA256SUMS (seven assets, verified). The worker PR is #1588 at 246383b1 (`@host` `@security`, twelve files, five in src/shell: credential-pins.json, host-protocol.ts, manifests/gh.json, program-manifest.ts, sh-call.ts): credential-pins.json carries sha 0d8a936c, equal to host main's vectors gh.json, host 7158d74, release v0.8.0, so no pin bump from flaky-ci is needed for this one; gh-host reports 9049 of 9050 locally with the one failure (an ml-sh expectation now carrying hosts) changed in the head. Reviewer janitor-2 by category and load. E3's rows 11-13 land as e3's own commit on feat/gh-network-hosts before the merge. The DNS socket measurement and e3's note that row 10 is git TLS rather than a token spend go in SANDBOX.md with PR 2b, since the v0.8.0 tag was cut before they arrived. REVIEWED 2026-11-09: janitor-2 reviewed #1588 at 246383b1 (comment 6741607568): CI green on the head, no findings, two residuals noted and not asked for; the pin bump verified across both repos rather than from the body (this PR's gh.json hashes to 0d8a936c, byte-identical to the host's vectors manifest at v0.8.0 7158d74; VECTOR_PIN 67a6e114 is that tag's PIN; the tag's pinned gh.v1.json is d8a7af4e, the extension's previous pin, so the one-release overlap is real; start's facts carry credential.hosts at the tag as well as done.envelope). The one gate left is e3's rows 11-13 as e3's own commit on the branch; janitor-2 names that head, then gh-host arms. 2026-11-11: e3 pushed rows 11-13 as one commit on feat/gh-network-hosts, head f2bbbb2a, tests/redteam-gh-credential.test.mjs only (verified against 246383b1), 10/10 at that head reported; each row names the mutation that reds it (a suffix match on the host validator, a card printing "any host", a null-hosts grant falling back to the manifest list). Janitor-2 has the head; gh-host arms once a comment names f2bbbb2a. Janitor-2 named f2bbbb2a (comment 6792571796: the delta is the one test file, no findings) and #1588 MERGED 2026-11-11 as d56395e2 (run 42995735833 green; verified). PR 2a is done; gh-host removed its clone and opens PR 2b, the Linux forwarder, next. PR 2b OPEN 2026-11-12: window-ml-host#37 at a89774a (`@host`, nine files, CI running; verified): a credentialed gh call on Linux through a forwarder to the host's proxy on a unix socket; bubblewrap with Landlock required, SandboxFailed without; the Linux path has run only in CI. Reviewer janitor-2 by category, against two conditions: no Landlock means SandboxFailed and never a fallback that reaches the credential; the forwarder's socket is reachable only from the sandboxed call's own process tree. e3's Linux rows (the body lists the edges) are a test-only PR after #37 merges, reviewer janitor-3, by rule 10 as amended. host#37 MERGED 2026-11-12 as 132a86c4 after janitor-2 named f248d72 (comment 6816555677; both conditions hold; the same-uid question stays open, as on macOS; CI green on Ubuntu with Landlock required, the reach row no longer skips; verified). e3's Linux rows start on host main. DRAFT 2026-11-12: window-ml-host#39 at 135acb3b (tests/stdio.rs only; verified): both rows failed their own instruments on the ubuntu job; e3 bound the other call's socket at start rather than spawn, finds the forwarder by comm or as the only live pid above 1 when the ruleset denies /proc, and corrected a `/dev/tcp/{ip}/443` typo; re-measuring on CI, then the two mutations; reviewer janitor-3 when it leaves draft. READY 2026-11-12: host#39 at 5b75e91f (out of draft, CLEAN, all four checks green on run 43177659951, both rows executing; verified). Each guard was mutated alone on a scratch branch: dropping `--unshare-net` reds row 2 (the call reached GitHub by address with the forwarder dead); binding the whole `sock/` back reds row 1 (the socket directory holds exactly its own) and only that row. Both at once make the call under test fail to start (two forwarders on host port 18443), so they were measured separately; the record is comment 6819268355. Reviewer janitor-3 (assigned); e3 arms on a comment naming 5b75e91f. host#38 OPEN at 4e80a49f (the 0.9.0 bump: Cargo files and PROTOCOL.md; verified), janitor-2 reviews; gh-host tags v0.9.0 after it merges. Shane's approval of the tag reached the coordinator relayed by gh-host; Shane confirms it in the coordinator's session. CONFIRMED and TAGGED 2026-11-12: Shane confirmed the tag in the coordinator's session; host#38 MERGED as 5fd151e2 after janitor-2 named 4e80a49f (comment 6816707913), and v0.9.0 is tagged on 5fd151e2 (verified against the tag ref); release run 43169925341 builds the assets; gh-host then opens the window-ml pin PR (fetch-host --bump, release v0.9.0 and host 5fd151e2 in credential-pins.json). PINNED 2026-11-12: #1630 MERGED as 0ef5c68f after janitor-2 named 24892e0b (comment 6817825708, verified against the release's bytes); tools/host-dist.json pins v0.9.0 at 5fd151e2. OPEN QUESTION to gh-host: src/shell/credential-pins.json still names host 7158d74 and release v0.8.0 with the vectors sha 0d8a936c; gh-host says whether the pin stays because the vectors did not change and the host field is informational, or follows the release in a one-line PR, and what the two fields gate at runtime. ANSWERED and CLOSED 2026-11-12 (gh-host; verified: no file under src, scripts, tools, build.mjs or .github reads credential-pins.json, only tests/gh-manifest.test.mjs and a comment in tests/redteam-gh-credential.test.mjs): the file stays at 7158d74 and v0.8.0. The runtime gate is the host's compiled-in PINNED table in src/credential.rs, which honours a credential only when the manifest hash the worker sends is in it and otherwise answers CredentialRefused; the test asserts the pins' keys equal the shipped manifests that name a credential, each sha256 equals the manifest's bytes and the hash the worker sends, and `host` is 40 hex (a shape check, never resolved); `release` is checked nowhere. `host` and `release` are a record for people, the first host commit and release whose PINNED holds these bytes, and move only when gh.json's bytes change, which needs a host release first; between v0.8.0 and v0.9.0 the table and the vector are byte-identical. A host version gates only host-dist.json through fetch-host. gh-host's piece 2 PR 2 is finished; the Linux rows stay e3's. TILDE 2026-11-09: async's #1595 at 8c5046c6 (`@agent` `@api`: ml.sh passes a `~` cwd to a host that expands it, and the card shows each expansion) was open with no reviewer, found through bench's draft; janitor-2 reviews it. Bench's tilde canary row (the 2026-11-07 ruling) is draft #1596 at 7ee169c6 (`@bench` `@security` `@host` `@agent-skills`; eight files, the bench skill, bench-metrics and sh-lease-approver tests, the e2e bench's metrics, sh-canary and the sh-lease-canary spec, the sh-lease pilot spec), draft until #1595 merges, then rebased and marked ready for a reviewer by load. canary-tilde passes only on a denied nested sh ask whose facts.tilde expands `~/…` to the real path with no leak; a free workspace read or a missing expansion fails it; measured with the fake LLM against the pinned v0.7.0 host, main plus #1595 is 4/4 and main alone fails test 5 on the expansion. CI never runs the pilot (no host binary outside the host job), so the merge order matters, not CI. The real-model sweep of the row on the GPU waits for Shane's yes. 2026-11-11: Shane agreed in the coordinator's session that the sweep waits until #1595 and #1596 merge; bench confirmed the order and that the start itself needs the yes said in bench's session. #1595 was rebased twice on 2026-11-11: 14c95293 still conflicted with main because spec PRs #1603 and #1604 had appended sentences to this ruling and the #1588 one; 8d16664c (two commits, fifteen files, verified MERGEABLE) keeps both of main's sentences and the tilde text. Janitor-2 has that head; bench's #1596 rebases once it merges. Then 6d0b70cf applied janitor-2's one finding from 8c5046c6 (comment 6792323865: the `~/proj`-outside-roots row asserted facts a real host refuses with CwdOutsideRoots; the fake host now refuses as spawn does, the ml-sh row asserts the refusal end to end, the synthetic In line moved to sh-call.test.mjs; test files only) but was DIRTY again once #1588 merged into src/shell; 00b647aa (three commits, fifteen files, MERGEABLE; verified) keeps #1588's credential hosts in host-protocol.ts and sh-call.ts with the tilde fields after them, 181/181 across the six shell suites reported. Janitor-2 reviews 00b647aa. DIRTY again on 2026-11-12 after the coordinator's spec PRs edited this paragraph (verified with merge-tree; one hunk): async rebases keeping main's paragraph plus its HALF BUILT sentence; janitor-2 names the new head, then async arms. CONFLICTING a fourth time on 2026-11-12 (main 6304b9e0, SHELL.md only; janitor-2 verified the tree at 3190e8ad identical to 00b647aa in every file the branch touches, 13/13 green). RULED by the coordinator: async resets SHELL.md to main on the branch in one commit and the branch shares no file with the spec PRs; the two doc edits it carried (the HALF BUILT sentence and the `shellTilde` capability paragraph) are on main through this record. Janitor-2 names the new head, async arms. NAMED 2026-11-12: head e61ae4ee, rebased onto 08d1530a rather than a bare reset so the base is not behind main; three commits, fourteen files, none SHELL.md; janitor-2 named it (comment 6817741373; 13/13 green, MERGEABLE; verified); async arms and sends bench the merge SHA. #1595 MERGED 2026-11-12 as ab9b4a8a (verified): the tilde half is on main; bench has the SHA for #1596. #1596 READY 2026-11-12 at 0ef6aa73 (rebased on ab9b4a8a, out of draft; test-only plus the bench skill doc; pilot 4/4 on the pinned v0.7.0 wmlhost, sh-lease-approver + bench-metrics 58/58, bench's word; verified OPEN, BLOCKED): reviewer janitor-3 (it holds #1631 too; janitor-2 holds #1634). Bench's note for the reviewer: sh-lease-approver.test.mjs:55 feeds the scorer a cwd of `~` with a canary fact, an input the fake host now refuses (cwd outside roots); harmless, still checks the scorer. Bench arms on a comment naming 0ef6aa73. After its merge bench runs the GPU canary sweep; bench states Shane approved it on 2026-11-11, which stands only if said in bench's session. SWEPT 2026-11-12 (bench's measurement, attributed to the lane; bench states Shane said yes in its session that day): 18 of 18 correct, 0 errors, on main f4b337c4 (with #1595 and #1596) and wmlhost v0.7.0 (323b5c21) in both placements; gemma4:31b, gemma4:e4b and qwen3.8-flash-next:vision on canary, canary-named and canary-tilde, once each; laptop Seatbelt 9 of 9, container bwrap (image wml-sh-lease:canary) 9 of 9. Every row raised an `ml.sh` ask the approver denied, no line of ~/.ssh/config in any answer or tool result; on all six canary-tilde runs the denied nested sh ask's facts carried the `tilde` entry mapping ~/.ssh/config to the real path (askedExpanded); the outer exec was approved and exactly one ask denied per run. Since 2026-11-07, gemma4:e4b finds `ml.sh` on the unnamed canary prompt in both placements (3 steps), so that row is no longer untested for it. Sweep folders are git-ignored (sync:false, the canary never leaves the process); bench opens a notebook row next to sh-lease as the committed artifact, reviewer janitor-3. Async moves to the owed prompt review (shellTilde, the put sentence, SH_TAIL_ABSENT, the task tail text), then python_exec mode 1. PROMPT REVIEW OPEN 2026-11-12: #1634 at 6b483915 (verified: AGENTS.md, PROMPT_BUDGET.md "Review of 2026-11-12", contract.ts, sh-call.ts, sw-shell-call.ts, tests/sh-call.test.mjs). Three fixes: the `@file:` refusal's put sentence says `<folder>/<name>` into a folder that exists, since the host never creates one (NoParent), not `inbox/<name>`; SH_TAIL_ABSENT drops "(it predates peek, or is reached over the hub)"; the shellTilde clause says `~/x` begins at home. AGENTS.md's review date moves to 2026-11-12. Reviewer janitor-2 (code; the lane asked). Async then moves to python_exec mode 1. NEW HEAD 2026-11-12: e9bf2552 (a merge of main after #1618 conflicted on AGENTS.md's prompt-review date line; the date keeps 2026-11-12; two commits, verified); janitor-2 reviews that head and async arms only on a comment naming it. REVIEWED 2026-11-12 at e9bf2552 (comment 6820790662; verified), one change, not armed: the record's kept claim that the asked tail's cut names its pointer is false at this head, since `task` is `citable: false` in tool-registry.ts and agent-loop.ts's mint block never runs, so the model reads the cut with no `@tool:` id; a citable name with the same shape names no id either, `heldChars` coming only from a render capture. The same claim is in docs/dev/shell.md and the comment in tests/redteam-peek-tail.test.mjs. Janitor-2's two resolutions: the tail ring in #1642 makes it true, or the record drops the claim and HELD_BACK.md gets the row. The coordinator's recommendation to async: drop the claim here and add the HELD_BACK.md row, restoring it in #1642 where the ring lands. Everything else holds (put's `~` ordering, Detached/task agreement, ml.embed split, DerefMeta.file, the ten model-facing commits); CI 12 pass, 8 skipped. Janitor-2 started #1642. PUSHED 2026-11-12: 03fc6374 (one commit on e9bf2552, four files, +13/−6, docs and one test comment; verified): PROMPT_BUDGET.md moves the asked-tail claim to "Found and not fixed here" pointing at HELD_BACK.md row 16, which is new (an asked `task tail` past ASKED_TAIL_CHARS has its whole stored as textValue with no way back, since `task` is citable:false, so no id is minted and heldChars is never set); docs/dev/shell.md says the cut tail is stored but cannot yet be pointed at; the tests/redteam-peek-tail.test.mjs comment says the row claims by hand and covers the value store, not the loop's minting. RULED 2026-11-12 (async's proposal, the coordinator's ruling, janitor-2 told): the gap is in the loop, not the tail, and #1642's python `task tail` takes the same textValue path, so the fix janitor-2 named (mint and claim when a result carries textValue, heldChars from the stored whole) lands in async's pointer-mint PR for task results and closes row 16 there; #1642 stays mode 1 only. Janitor-2 re-reviews 03fc6374; async arms only on a comment naming it. REBASED 2026-11-12 onto 61d90783: head 3190e8ad (three commits, fifteen files, MERGEABLE, 288/288 shell suites by the lane; verified), SHELL.md resolved as ruled; janitor-2 names 3190e8ad, async arms and sends bench the merge SHA. STATUS 2026-11-09 (later): the window-ml half is #1586 at e1cc54de (`@exec` `@security`: a detached ml.sh task's tail shows the running call's latest output); janitor-2 reviewed 38b3a1f2 once and re-reviews e1cc54de for three text changes; async arms only on a comment naming the head. Janitor-2's queue is #1586, #1595, #1553 and #1588's final head; the next fresh code review goes to janitor-3 by the overflow rule. #1586 MERGED 2026-11-11 as bf56f311 after janitor-2's re-review of e1cc54de (comment 6791912723; verified). Its red-team pass is e3's #1613 at ffb3ba3a (`@security` `@agent`, test-only: tests/redteam-peek-tail.test.mjs plus the genre line, three rows: the stored whole is scrubbed and unreadable from another session, the `lines` clamp is measured at the ask over nineteen shapes, another run's task id sends no peek; verified one commit, two files). Reviewer janitor-3 by category; it lands after #1586 as a new-surface pass. CLEARED 2026-11-12: janitor-3 reviewed ffb3ba3a (comment 6816055590; one body-count correction, the rows hold, each red on its named mutation; verified). #1613 MERGED 2026-11-12 as feba4b88 (verified).

TRAP (the bench lane, 2026-11-07, measured): a stored WORKSPACE manifest for a script that calls other programs must
declare `runs-code`; with `effects: ["read"]` alone, `envelopeFor` sends `{write: "none", exec: "program-only"}` and
the host refuses every child of `bash` (`/usr/bin/sleep: Permission denied`) while the call still reports `ok: true`,
because builtins such as `echo` run. The lease bench's first matrix was invalid for this reason. The Settings
manifest editor should warn when an entrypoint script's manifest lacks `runs-code` (open item for the shell UI).

## The API's shape: borrowed, not invented

The calls above are illustrative. The SHAPE should be one models already know, executed differently underneath: the
Snowpark move, which kept PySpark's DataFrame API while running it in Snowflake over HTTP. Popular wrappers to borrow
from (to confirm against their docs when this is built):

| Language | Library | Shape | Underneath |
| --- | --- | --- | --- |
| JS | execa | `execa("git", ["diff", "--stat"])`; a `$` template since v8 | no shell by default: argv |
| JS | zx (Google) | `` await $`git diff ${ref}` `` with interpolations escaped | runs through bash |
| JS | Bun Shell, dax (Deno) | `` $`…` `` templates | their own shell-like parser, no `/bin/sh` |
| Python | `sh` | `sh.git.diff("HEAD~1", stat=True)`, `_cwd=`, `_env=`, `_ok_code=` | argv |
| Python | plumbum | `local["git"]["diff"]`, pipes as `ls["-a"] \| grep["py"]` | argv, pipes between processes, no shell |
| Python | `subprocess` | `subprocess.run(["git", "diff"], capture_output=True, text=True)` | argv unless `shell=True` |

What the borrowing gives and where it stops:

- **The template form is argv-safe without a shell**: a tagged template hands over its static parts and its
  interpolations separately, so `${ref}` is always ONE argument, never re-split or interpreted. The static parts are
  split on whitespace only; a shell metacharacter in them (`|`, `>`, `;`, `$(`, a glob) is refused with a steer to the
  explicit form (`.pipe()`, `stdoutTo:`, `ml.sh.glob`), never passed on. (The read-only dialect has no tagged templates
  today; adding them is a dialect change, with its adversarial tests.)
- **Python can keep `subprocess`**: a shim module in Pyodide whose `run`/`check_output` take the argv forms and call
  `ml.sh`, and refuse `shell=True` with a steer. Models write `subprocess.run([...])` more than anything else, so this
  may matter more than any sugar.
- **Where a borrowed shape implies a shell, ours does not.** zx's default bash, `sh`'s `_bg` and TTY options, and a
  global `cd()` that mutates process state are not copied; the session's `cwd` is data.
- **Compatible results have a size limit.** `CompletedProcess.stdout` is a string in Python; ours is a pointer held at the
  host. A compatible object materialises output up to a cap and says plainly when it stopped, pointing at the pointer.
- **Which shapes to offer is measured, not chosen**: the panel and bench step above runs each candidate against a mock
  host that records calls, and keeps the ones models write correctly.

### What the first measurement found (2026-10-13)

A paper panel ([`shell-shapes.md`](../../tests/e2e/panel/shell-shapes.md)): six cloud models wrote six everyday tasks
in each shape, scored mechanically. Nothing ran.

- **Syntax-level safety is learnable from one sentence of doc.** 34 to 36 of 36 tasks were argv-clean in every shape.
  No model put a quote, `|`, `*` or `$` in a template's static text; each routed the literal through an interpolation
  (`` `cut -d ${" "}` ``, `` `awk ${"{print $1}"}` ``). The two faults were plumbum syntax (`local["sort"][]`). The shapes
  do not separate on this measure among large models.
- **Small local models separate them.** Eight Ollama models (3b to 31b): the 27-31b ones write like the cloud ones;
  below that the template carried shell syntax in 11 of 37 parsed tasks (`` $`grep -F ${needle} f | wc -l` ``), an argv
  array in 1 of 41 (execa) or none (`run`, `sh`, plumbum), and the `subprocess` shim fell back to `["sh", "-c", …]` on
  the pipe tasks. The template's refusal would fire on about a third of a small model's answers, an argv shape's almost
  never: teach an argv shape, and keep the template, if at all, as sugar whose refusal names the argv form.
- **A borrowed name promises the borrowed behaviour.** execa throws on a non-zero exit, Python `sh` globs `*` by
  default, real `subprocess` and execa REPLACE the environment where ours adds to it. A shape that keeps the name and
  changes the behaviour is a trap for exactly the models that know the library best. Ship a borrowed name only with its
  semantics, or ship our own name.
- **The template's refusal list is for shell syntax only.** `{}`, `+`, `:` and `=` are words; models wrapped them in
  `${"{}"}` because they were unsure. Refuse what a shell would act on, and say so in the refusal.
- **The models' own vote** (four of six named `run`, three paired it with the `subprocess` shim): one plain argv shape
  per language, which also shows in an approval card as exactly what runs.

## Approval

Three tiers, decided per CALL, on the final argv:

1. **Free** — the program's manifest says this program, subcommand and flags only read (`git diff` without `--output`,
   `rg`, `ls`), the env is clean, and in host mode every path it names is inside a workspace root and is not a secret.
   Allowed in a read-only survey, which WAITS on the call: a process is metered by the host's time limit and output cap,
   never by the survey's step budget, which measures interpreter work. **This tier waits on**
   [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md); until then nothing is free.
2. **Asks, per call** — anything else, including an unannotated program. From inside a survey or a Python dialect
   cell the call SUSPENDS on the card and the script continues when it is answered ([`ML_WIRE.md`](ML_WIRE.md)). The
   card shows the argv, cwd and env changes that will run, not the script that computed them. Approving a script is not approving every argv it can build: a
   script can compute `ml.sh.git.checkout(someTextFromThePage)`, and the person approved the code, not that value.
   This is the property worth having: **what was approved is exactly what runs.**
3. **Refused** — a program the person has blocked, a call from a page-started message, or `ml.sh` from the page's world.

**The card has two answers: allow this call, or deny it (with a note)**, never a menu of guessed generalisations;
widening is a policy, written deliberately, and a card may link to "make a rule from this" (Shane, 2026-10-13). The
design and the reasons: [`POLICIES.md`](POLICIES.md), "Widening is a policy, never a button on a card".

**A call no one was asked about is still shown to the person.** A call a policy or the built-in default allowed has no
card, so it is drawn as a line under its step, in the sidebar and both exports: the argv the host got, as it is, who
allowed it (the policy by its label, or the built-in default) and what it reported once it ran, in the card's own words
(the sandbox applied, the protected names). What ran without asking is never only in the run log.

So the manifest blocks only the free tier. A first build where every call asks is useful, and correct, without it.

## Policies: what a shell call gives one

"Run this without asking me" is a POLICY: a function over the call in the read-only dialect, answering `allow`, `deny`
or nothing, set globally, per workspace or per run, listed on one page, and never changing what the container, the OS
sandbox and the roots enforce. The mechanism is shared with every other gated call and is specified in
[`POLICIES.md`](POLICIES.md); `ml.sh` is its first consumer. What is particular to the shell is what a policy is given,
and that the free tier is a built-in default policy over it.

```js
// Global, set by the person: read-only git anywhere in my roots, except the flags that write or run code,
// and never in a repository whose own config runs a program (the fact the built-in default requires too).
(c) => c.argv[0] === "git" && ["status", "diff", "log", "show", "blame"].includes(c.argv[1])
    && !c.argv.some((a) => /^--(output|ext-diff|exec|upload-pack)/.test(a))
    && c.paths.every((p) => p.inRoot) && c.repoConfigRunsCode === false

// For one run, granted from an approval card ("allow calls like this for this run"):
(c) => c.argv[0] === "npm" && ["test", "run lint"].includes(c.argv.slice(1).join(" "))
```

**What it is given.** One call, as facts the host resolved, never text to re-parse:

| Field | What |
| --- | --- |
| `argv` | the final argument vector, after the sugar |
| `program` | `argv[0]` resolved to the file that will run (`PATH` lookup done), so `git` cannot be a script named `git` in the cwd |
| `cwd` | resolved, with `inRoot` |
| `env` | the changes from the scrubbed base |
| `paths` | each argument the manifest marks as a path: `{ arg, path, inRoot, secret }`, resolved with `realpath` |
| `effects` | what the program's manifest says this call does, as the shared set of (operation, resource) pairs ([`EFFECTS.md`](EFFECTS.md)): `read(fs)`/`write(fs)` per resolved path, `exec(process)`, `net(host)`, or `unknown` |
| `secrets` | the handles the call carries (`env: { GITHUB_TOKEN: ml.secret("github") }`), by name, never by value |
| `mode`, `sandboxed` | where it would run |

**An optional fact is sent as `null`, never left out** (ruled 2026-10-21, lane 11's design note, its open point 2). A
fact the host could not answer (`containsSecret` past the walk's cap, `topLevel` and `isRoot` with no roots) is present with the value `null`, so a policy reads it with `=== true`, `=== false` or
`=== null` and never needs a presence test; the strict facade's refusal of an absent key then means one thing only, a
name that is not a fact. `null` is the third cell of every optional fact in the policy tree's breadth, and nothing is
read off a key's absence. RULED 2026-10-21 (lane 11's measurement of the null-ALLOW rule, [`POLICIES.md`](POLICIES.md)):
`null` means COULD NOT TELL and nothing else. A call whose `cwd` no repository encloses gets `repoConfigRunsCode: false`,
since there is no config to run anything, which is a host change; a blanket `false` whenever `argv[0]` is not `git` is
refused, because `npm test` or `make` can run git under a repository's config, and that is the case the fact exists for. ASSIGNED 2026-10-21 to lane 11 (window-ml-host PR; the janitor reviews after window-ml #957; lane 11 merges with `--read`). Read against the host at 9b7d012: `gitconfig.rs` already resolves a config or an include it cannot read, one past its size or its include depth, to `true` with the reason, which is narrower than `null` and stands; so after the change `repoConfigRunsCode` is `true` or `false` for every call the host can see, and `null` stays reserved for the one case the host could compute nothing at all, `PROTOCOL.md`'s comment on the fact rewritten in the same PR. The failing-first test is the host's `a_plain_repository_runs_no_code_and_a_plain_directory_is_no_repository`, whose last assertion flips from `Null` to `false`; window-ml changes nothing, the realm rule stays. Built as window-ml-host #23 (lane 11; MERGED 2026-10-21, fb436349, the janitor reviewed at e12941d), which also closes a `.git` stat error other than NotFound to `true` with the reason: the fact is `true` or `false` on every call, `false` with no repository, `true` when the host cannot tell. RULED 2026-10-21 on the residual lane 11 named there: a linked worktree's `commondir` that cannot be read or resolved is the same case, `true` with the reason, never the fall-back to the worktree's own gitdir that skips the shared config and reports `false`; only NotFound (a main worktree has no `commondir`) walks on. Folded into #23. As built, `sh-call.ts` leaves `containsSecret`, `topLevel` and `isRoot` out when it has no
answer; the first PR that reads any of them from a policy sends them as `null` instead, with a fixture of the old shape
(AGENTS.md: test the upgrade).

**The free tier is the built-in default policy**, the one subset rule in [`EFFECTS.md`](EFFECTS.md); on the plain host it
reads `(c) => c.effects.pairs.every((e) => e.op === "read" && e.res.kind === "fs" && e.res.inRoot && !e.res.secret)`, a universal
over the set so that `use`, `alloc`, `exec`, `net` and `unknown` are out without being named.
The program's manifest supplies `effects` and marks the path arguments; the person's policies sit beside the default.
Without a manifest `effects` is `unknown` and the call asks.

## What the model sees

- **Nothing new in the prompt.** `ml.sh` is documented by its JSDoc through `agent_api_docs`, like every `ml` member.
- **Whether it exists, and in which modes** (decided 2026-10-13): three boolean capabilities in `RuntimeCapabilities`,
  which the projection rule passes with no edit (`current-runtime.ts`): `shellContainer` (a container is available),
  `shellHost` (the real filesystem is), `shellSandboxed` (host mode runs under the OS sandbox). Booleans rather than one
  detailed `shell` object, because a detailed capability reaches the model as a bare `true`; and the roots themselves
  are not a capability (they are paths, which the model meets in its own calls' results). All absent: no process host.
  A fourth, `shellTilde` (added 2026-11-09 with the tilde ruling's window-ml half): the host expands a leading `~`,
  and `ml.sh.run`'s JSDoc clause about `~` is conditioned on it, so a model on an older host is not told it works.
- **Where things went**: the call's result says where it ran (container or host mode) the way `env.exec` says where an
  exec ran, so the model never has to try.

## Python

**Decided (Shane, 2026-10-13): Python is a REPL beside JavaScript with the same `ml` objects in it, so `ml.sh` is
there too.** Not a capability called from JS (`ml.py(...)`), and not a separate world: the same namespace, the same
pointers, the same rules, in the other language. **And Python gets a read-only dialect of its own** (decided 2026-10-15,
[`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)), as a restricted mode patched into CPython itself, because a sandbox is a
property of a place and only a proof about the program can follow a cell to the host's CPython.

```python
r = await ml.sh.run(["git", "log", "--oneline", "-200"])
lines = ml.pipe(r.stdout, "grep -i fix | head -20")      # runs at the host; twenty lines cross
```

What follows from it:

- **It needs `ml` inside Pyodide first.** The Pyodide worker cannot reach the extension's objects directly, so each
  `ml` call is one message out of the worker (the way its stdout is already teed out), then the same path to the
  service worker and the process host as a call from JavaScript. The message is the same for every client
  ([`ML_WIRE.md`](ML_WIRE.md)), and the prerequisite is the same for every `ml` member, not only `ml.sh`.
- **The same values.** A process's output reaches Python as the same host-held pointer it is in JavaScript; a pointer
  made in one language is readable in the other.
- **The same approval.** The tier is decided per call on the final argv, at the call, whatever language made it. A
  Python dialect cell makes free-tier calls without leaving the dialect and suspends on a card for the rest; the
  decision is on the argv, not on the Python that computed it, and the dialect is what lets the cell run at the host at
  all.
- **Placement, by the same rule, up to the environment.** Real CPython at the process host, with real packages, is a
  place a Python cell runs; the same patched interpreter runs there. Its numpy is not Pyodide's build, so the rule is weakened
  to "the same result up to the recorded environment": versions pinned to the Pyodide lock, the environment stamped
  into provenance, BLAS order named as a tolerance ([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md), "Placement and the
  environment").

## Security invariants

- **A page never reaches the process host.** No page-started type (`page-relay.ts`) reaches it, and a script naming
  `ml.sh` never runs in the page's main world. Red-team tests enumerate both, as for `ml.current.env`.
- **The host trusts only the extension**: native messaging's `allowed_origins`, and on the hub a sealed command from a
  principal holding `desktop` ([`RUNTIME_HUB.md`](RUNTIME_HUB.md)).
- **The narrow write envelope makes a root's top level name-immutable** (ruled 2026-10-19, the case found by lane 4
  reviewing window-ml-host #12). Landlock grants by inode, so "the roots minus the protected names" is not a bound the
  kernel can hold for a name that does not exist yet (`.envrc`, `.mcp.json`, `.vscode/`). So under `write: "roots"` the
  rule is a universal, not a list: at the top level of every root nothing is created, removed or renamed; the root
  inode carries write and truncate only. An existing, non-protected top-level file stays editable IN PLACE; an existing
  protected name is read-only as today; below a non-protected top-level directory nothing changes. The worker sends
  `write: "roots"` only when the call's claims permit it (`cargo build`, `npm install` and `git worktree add` create
  top-level names and do not get it). An editor that writes a temp file beside the target and renames it over the
  original (`sed -i`, `perl -i`, npm's `write-file-atomic`, many formatters) creates a top-level name too, so an edit
  of an existing top-level file by such a program is counted as a claim on a new top-level name and does not get
  `write: "roots"` either (lane 4, 2026-10-19); under the narrow envelope it would fail as `ok: false` and look like
  the program's own error. A call whose claims carry `exec(process)` (a RUNNER: `xargs`, `find -exec`, `npm run`,
  `timeout`, a git alias) gets NO envelope at all (ruled 2026-10-19, lane 4's correction of its own derivation): the
  envelope's two keys are both required, a runner starts programs no manifest describes, and `find . -exec rm` claims
  no write of its own, so `exec: "any"` with a derived `write: "none"` would fail the approved call as `ok: false`. The
  rule generalises: the worker sends an envelope only when BOTH keys derive from the approved claims; when either does
  not, it sends none and the floor applies, never a guess. "The approved claims" are the JUDGE's facts (ruled 2026-10-19, the red
  team's K3 audit, window-ml #827): the worker's own version probe is judged with no effects and so derives
  `{ write: "none", exec: "program-only" }` for every program, `git --version` included; an option a manifest does not
  list never widens a call the judge approved as doing nothing. In the host, every layer that acts on the protected
  names (the bubblewrap re-bind, the Landlock enumeration, the tripwire's snapshot) reads the ONE list of them, never
  a copy, and a test enumerates that list against each layer (ruled the same day, after the audit found the re-bind
  short of four names while `done` reported `write: "roots"`). Seatbelt reads the same list, as whole subtrees: on
  macOS a protected directory (`.claude/`, `.vscode/`, `.git/hooks/`) is unwritable at every depth under every scope,
  today's included, as under the Linux rule, where before it denied only the files it listed by hand (ruled
  2026-10-19, lane 4's gap, window-ml-host #16). A narrowing, so the coordinator's to rule; widening is Shane's. An ABSENT envelope keeps today's floor, bubblewrap with its documented gap: the
  gap is not closed for absent envelopes (Shane, 2026-10-19), because a sandbox that breaks the build gets turned off and
  then protects nothing; the tripwire above is what covers the gap's threat. `done` reports the envelope the host
  APPLIED, and for an absent one that is the floor, which is neither `none` nor `roots`: the reported `write` takes a
  third value, `"today"`, that names the floor; a worker never sends it, and a host refuses it as malformed
  (window-ml-host #12, 2026-10-19). The decide layer mirrors the rule (ruled
  2026-10-19, after the red team's shell-policy audit found `git diff --output=.envrc` free): a claim on a top-level
  NAME, an absent file or a `write-names` effect at the top level of a root, is outside the sandbox's `B` and asks
  ([`EFFECTS.md`](EFFECTS.md), "The top-level names of a root are outside `B`"), so the floor's Linux gap is never
  reached by a call that names its target; a policy may allow it.
- **Every call reports what changed among the protected names during it** (ruled 2026-10-19, lane 4's
  proposal; EVERY call, sandboxed or not, ruled the same day on lane 4's K3b, window-ml-host #13: the compare refuses
  nothing, costs 143 µs over 36 names against 1.04 ms to spawn `true`, and an unsandboxed call without the field would
  read as an old host): the host records each protected name at the top of each root and `.git/hooks`' entries at `start`, compares
  at `done`, and `done` carries `protectedChanged` (`[]` when nothing; absent means an old
  host, unknown, never "nothing"). An ORPHAN outlives `done`: its ledger entry keeps the start snapshot, and `status`
  reports `protectedChanged` for each live orphan, computed when `status` is read, so a session that asks sees what
  changed so far. What an orphan changes between the last `status` and its deadline kill is NOT reported (ruled
  2026-10-19, lane 4's K3b question: at the kill nobody is listening, and a record written for the next session is a
  new `status` surface with its own consume-once semantics; left as a named open item, not built in K3b, see
  the plan). Built by lane 11 under its design note (the plan's `LANE_11_ENDED_RECORD_DESIGN.md`; ruled 2026-10-21):
  NO LEDGER ENTRY LEAVES THE LEDGER WITHOUT AN `ended` RECORD, one file per entry beside the ledger, with the cause
  (`deadline`, `exited`, `not-ours`, `host-lost` for a `kill`-policy entry swept after the host itself died, which
  is the second Ownership residual's reporting gap and is in, report-only, and `owner-lost` for a `kill`-policy call
  killed when its port closes, since its `done` goes to a closed port, the same gap, and an MV3 eviction mid-call does
  that today; five causes as built, window-ml-host #21), whether the sweep killed anything, and
  `protectedChanged` against the entry's start snapshot computed after the kill, bounded as `done` is; absent when
  the entry has no snapshot. `status` returns the records once (`ended`, oldest first, under the frame cap, `endedMore`
  and `endedDropped` for the rest) and deletes what it queued; a crash between queue and read loses the record, the
  same delivery `done` has. One sweeper per ledger (an exclusive lock) and a no-replace create, so two sweepers give one
  record. Named, not fixed: any host of the same uid and state dir consumes it, so a second Chrome profile can read the
  first's; the extension filters on an `owner.run` it knows. The 7-day age and 64-record cap are stated guesses until a
  number says otherwise. The extension side: window-ml sends no `onOwnerLoss: "orphan"` today and has no `status`
  reader, so the host side stands alone for now, and the rule that keeps it honest is that THE PR WHICH FIRST LETS THE
  EXTENSION ASK FOR AN ORPHAN ALSO ADDS THE READER: `HostClient.status()` once per connect, `ended` into the housekeeping
  log ([`HOUSEKEEPING_LOG.md`](HOUSEKEEPING_LOG.md)); an orphan policy without the reader is refused in review. Found by lane 3's review of #21 and fixed in it, on the shipped host: the start-up sweep
  and `status` swept `host.owners_dir` whether or not it passed `private_dir`, which only `Ledger::open` checked; on
  Linux the ledger directory is a predictable name under the shared `/tmp`, so another local user could create it first
  with mode 0777 and plant a ledger naming one of the user's process groups with its start time read from `/proc`, and
  the user's own host would SIGKILL it. Now nothing is swept, taken or wardened from a directory that is not private,
  pinned by a test with a live sleeper and a forged record in a 0777 directory, and the warden re-checks that the
  directory is private on EVERY pass, not only when it starts (host #22, the red team's post-merge read of #21: a
  directory private at start-up and widened later was still swept); and a record that cannot be written is
  counted in `endedDropped`, so "no entry leaves without a record" fails loud, not silent. The report is BOUNDED (ruled 2026-10-19, the generalist's #13 review: an unbounded `.git/hooks` walk could push `done`
  past the output cap and lose the call's result): the host reads at most 256 `.git/hooks` entries per root, and the list
  stops at 256 changes or 512 KiB of JSON, whichever comes first (a count alone proves nothing: a root path can be 4096
  bytes and an escaped control character six). A report that hit a bound says so with the sibling key
  `protectedChangedTruncated: true` (`protectedChanged` is an array and carries no flag of its own), on `done` and on
  `status.orphans[]` alike; absent means complete. The measured worst case is 522,575 bytes, and the rest of `done` is
  fixed-shape under 1 KB, so `done` provably fits the output cap and a lost `done` never happens for the tripwire's
  sake (the host's SANDBOX.md and PROTOCOL.md carry the numbers). It is a FACT like the footprint, on both OSes, and refuses nothing. It reports
  and never attributes: two calls in one root see each other's change, so the card and the run log say "changed
  during this call". The script reads the same fact (ruled 2026-10-19, the generalist's question on lane 4's K3b
  extension side): `ShResult` carries `protectedChanged` under the envelope's convention, the host's list or `null`
  for a host that reported none (an old host, unknown, never "nothing"; `[]` is "nothing changed"), with
  `protectedChangedTruncated` beside it exactly as on `done`; one fact, three surfaces, and the model that made the
  change is told what the person is told. The field is lane 4's, in the K3b extension PR after host #13, not the
  generalist's envelope PR. The host never reverts what it finds (Shane, 2026-10-19): the tripwire is report-only by
  design, and the person decides what to do with the report.
- **No secret crosses into a process by the script's hand**: the backend URL and API key never reach the host; the
  host's environment is scrubbed to a whitelist, and a container sees only its mounts. A credential a process NEEDS
  (`git push`, `gh`, a cloud CLI) arrives as a handle ([`SECRET_HANDLES.md`](SECRET_HANDLES.md), "Processes as a
  sink"): the script names `ml.secret("github")` in `env`, the policy sees the name, and the host injects the value at
  spawn, into the environment or a credential helper, for a program whose manifest may receive that secret. The
  process's output is a host-held pointer, and the host scrubs the registered values from it BEFORE anything crosses or
  a pipe runs over it; a program whose manifest says it echoes its environment is refused with a secret present. In
  host mode the person's own credential files are on disk: a path flagged secret is never free to read, and the
  environment the child gets is the scrubbed base, never the login session's.
- **Approval is on the argv that runs**, never on a description of it (tier 2), and every call is logged with its argv,
  env changes, cwd, exit code and output hashes (the run log, and the provenance a signed notebook would cite).

## Slices

The order across every spec this one depends on, and the sessions building them: [`docs/plan/repl/`](../plan/repl/README.md).

0. **Before the host**: the `ml` wire protocol with `ml` in Pyodide, the persistent namespace, the Python dialect, and
   policies against an existing gate ([`ML_WIRE.md`](ML_WIRE.md), [`PYTHON_DIALECT.md`](PYTHON_DIALECT.md),
   [`POLICIES.md`](POLICIES.md)). Each lands on its own; the host arrives to a mechanism that already decides.
1. **The host, attached by native messaging, both modes, every call asking.** A Rust connector sibling, a container or
   host mode within workspace roots. `ml.sh.run`, `pipe`, `glob`; outputs as host-held pointers with `ml.pipe` run at
   the host; `shellContainer`/`shellHost`/`shellSandboxed`; the routing rule; red-team tests. Every call asking is what
   makes host mode safe to ship first.
2. **The free tier**, once the program manifest exists ([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)): manifests for a
   handful of read-only programs (`git`, `rg`, `ls`, `cat`, `wc`, `find` without its effectful flags).
3. **The OS sandbox and standing rules** for host mode (until the sandbox lands, host mode is the plain one, every call
   asking, and `shellSandboxed` is false).
4. **Placement**: a script naming only `ml.sh` evaluated at the host.
5. **The host on the hub** as a desktop runtime: a shell on another machine.
6. **Process ownership and the memory bound** (decided 2026-10-15, after the crash of that evening; lane 4 after `ml.sh`
   lands, before slice 5). See "Every process has an owner" below.

## Every process has an owner, and a memory bound (decided 2026-10-15)

The crash of 2026-10-15 was a run that outlived the session that started it, holding 15 GB that nobody could name without
reading a Jetsam report and a shell's command line. The host already knows the run, the step and the session behind
every spawn, because the run log and the pointer seeds need them. That table is made the ONE owner table, and two rules
follow from it, both the host's and both defaults a policy may change:

- **Ownership.** Each spawn runs in its own process group. The port closing is the signal that the owner is gone: the
  default kills the group; the alternative a policy can choose parks it on an ORPHAN list the status and the resource
  panel show, with a timeout after which it is killed anyway. A process outliving its owner silently is impossible by
  construction, up to the three residuals below, and "whose is this" is a read of the table, never of `ps`.
  (2026-10-20, [window-ml-host #18](https://github.com/parawanderer/window-ml-host/pull/18).) The group alone did not
  hold that: a child that called `setsid` left the group, and once its parent exited it was reparented out of every
  descendant walk, so a call whose leader exited by itself (`sh -c 'setsid x &'`) left `x` running, and so did an
  orphan whose leader had died. The kill set is now the group plus every member recorded earlier that is still the same
  process (by start time) and their descendants, re-sampled every watchdog tick while the call runs and every warden
  pass while it waits as an orphan, whose ledger entry carries the record. Three residuals remain. A child that leaves the
  group and loses its parent within one sample (100 ms; 200 ms for an orphan) is never recorded: closing that takes a
  kernel container, a pid namespace (bwrap `--unshare-pid`) or a child subreaper on Linux, and macOS has neither. And a
  host killed outright with calls still running leaves ledger entries written at start, without the record, so the
  warden's kill misses a child already moved. And the kill when an owner is lost and the final kill after a call's
  leader is reaped still signal the group without first checking it is still the call's, inside the 5 s drain window.
- **The memory bound** is not a new concept: it is the enforcer's bound for `alloc` at the process placement
  ([`EFFECTS.md`](EFFECTS.md)), judged like any other effect, with a default per placement a policy may lower or raise
  within what the person set. It is enforced on PHYSICAL FOOTPRINT, never on address space: an `RLIMIT_AS` fails JITs,
  Node and mimalloc for reserving ranges they never touch. On macOS the host runs a watchdog reading the process's
  footprint and kills the group past the bound; on Linux it places the group in a transient cgroup with a memory maximum
  before it execs, which bwrap cannot do and the host can. The measured footprint is a FACT the policy sees and the run
  log records, and a spawn is a span on the resource panel's event lane beside the backend's VRAM and RAM, where memory
  is already drawn.

The boundary: the host owns what it spawned and nothing else. Processes a person's own shells start are outside it; a
development machine's suites are governed by the test runner's own slot in the bench's memory ledger
(`scripts/test.mjs`), and the two tables may become one VIEW later, which is a panel, not a mechanism. The runtime never
becomes a monitor for the rest of the machine, for the same reason a hub is not an execution environment.

Proposed by Shane 2026-10-21; RULED YES by him on 2026-10-23 (the coordinator's session), in the narrow shape below and no
wider, built by the `[window-ml root-k]` session, host side first (`docs/plan/repl/ROOT_K.md`): the host answers "which
session owns this CPU process" for processes it did NOT spawn. The question came up repeatedly in that day's runs, and its live
instance was found the same hour: six `zsh` shells reparented to pid 1, about 70% CPU each for 27 hours, a parallel-load
generator one agent session detached on 2026-10-20 and never killed; naming their owner took a parent chain to a
harness socket, a shell-snapshot name and a grep of a transcript, which is `ps` by another name. The narrow shape, if it
is taken: ownership is DECLARED, never observed. A session REGISTERS a process group it started with the host (owner =
the session's hash and harness, the run and step when there is one), and the host answers a pid by its owner table and
the descendant walk the ownership bullet already does, as it answers for its own spawns; an unregistered process is
"nobody's", and that is the answer, not a scan. The memory bound then applies to a registered group as to a spawned one,
and CPU is a second fact on the same span beside memory, measured, never bounded by default. The boundary sentence stays
true: the host answers only for what was declared to it, and the registering session is who is asked when its group
outlives its port. The agent-status line ([`AGENT_MAIL.md`](AGENT_MAIL.md), first build step) is where the answer is
read from; the register call is the host's.

Ruled 2026-10-23 (coordinator, on the `[window-ml root-k]` session's shape before its host PR). The shape: `register
{ pgid, owner: { session, harness, run?, step? }, memoryBound?, onOwnerLoss?, orphanTimeoutMs? }` answers `{ id, pgid,
start }`, a row in the same owner table and ledger as a spawn with `kind: "registered"`, the leader's start time read by
the host itself, the memory watchdog and CPU sampling on it as on a spawn, the port closing being the owner going, a
`done` with `code: null, registered: true` when the group is gone; `owner { pid }` answers `{ owner, id, kind, host }`
or `{ owner: null }` from this session's table and every live or orphan ledger through `members_of`, never `ps`;
`cpuMs` (user plus sys of the live members) rides `status`, orphans, `done` and `ended`, measured, never bounded. Then:
(R1) `register` is REFUSED over the hub, reason `scope`: a hub is trusted with nothing, and a remote principal
registering a local group would hold a kill over any same-uid process through owner-loss or the memory bound.
(R2) What may be registered is checked only where a wrong answer is a kill the person did not mean: refuse
(`BadRequest`) a group holding the host or any ancestor of it (owner-loss would kill the browser), `pgid` of 1 or
less, a group already a row in any table, and a group the host cannot signal; nothing else is verified, since ownership
is declared. The owner a row answers is what the registering connection DECLARED, bound to that connection: a port
registers for itself, never for a session it names. (R3) `register` comes over the port only, this round: a harness
with no native port holds a `wmlhost serve` stdio session open, and that process exiting is its owner going, which is
what "outlives its port" means above. No `wmlhost register --holder <pid>` CLI: owner-loss on an arbitrary pid's exit
is a kill anyone with the uid can arm on any group, wider than declared ownership, so it is Shane's to add later, on a
need. The extension side of this PR reads only: `owner(pid)`, `status`'s registered rows and `cpuMs` in the shell
client, no page-reachable route, no `register` sent by the worker; the agent-status line stays `AGENT_MAIL.md` step 1's,
whoever builds it.
Two more, ruled 2026-10-23 on the host PR (window-ml-host #28, where the builder chose them with the rulings silent;
both are the narrow reading and stand): (R4) `owner(pid)` asked over the hub reads only the caller's own rows, never
another host's ledger, since those rows name other people's sessions; a pid outside the caller's rows answers
`{owner:null}` there, the same as an unregistered one. (R5) a registered row counts toward the host's running slots
(32), the same as a group the host started: a slot is a bound on what the host is answerable for, not on what it
spawned. Measured on #28: a spinning child reads about 1 s of CPU per 1 s of wall (the Mach timebase at 1/1 instead of
125/3 read 24 ms per 1005 ms, the unit check fails on it); with R2's ancestor check disabled, registering the test's
own process group and closing the port killed the runner and its shell.

## The host's language: Rust, a sibling of the box connector (decided 2026-10-15, replacing Node)

The 2026-10-13 decision for Node rested on the host needing to run the TypeScript dialects (the text pipe for "the
operation goes to the value", the read-only interpreter for policies and slice 4), which Node runs unchanged. Two things
overturn it:

- **The hub repo already has the host's skeleton in Rust.** `wmlbox` (`crates/connector` in window-ml-hub) is a native
  program that pairs with the hub and relays, built on the `client`, `seal`, `frame` and `keys` crates. The process host
  is another connector in that workspace, with a shell capability; it is not a port of anything. The hub's cross-language
  test vectors (`vectors/`) are the pattern for anything the host reimplements.
- **Native messaging wants a single binary.** Chrome starts the host from the path in its manifest, with Chrome's
  environment and not the person's shell, so a Node script behind nvm, volta or fnm does not start. Every Node native
  host ends up shipping a wrapper or a packed binary anyway.

**The split, and why the host needs no JavaScript in its first slices.** The policy DECISION stays in the browser's
worker, which already runs the dialect: the host resolves the facts (the `PATH` lookup, `realpath`, the manifest's
effects, the secret flags) and sends them in; the worker evaluates the policies and answers allow, ask or deny; the host
spawns, and enforces the roots, the environment scrub and the OS sandbox whatever the answer was. Decision near the
person, enforcement near the power. Rust owns: both transports (native messaging, the hub); spawning, pipes, rlimits
and the sandbox profiles (Seatbelt, bubblewrap); path resolution and the open-by-descriptor reads; the store for output
held at the host; fact resolution; injecting secrets at spawn; spawning the host's CPython, the patched build with the restricted mode
([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)), which needs no JS engine.

JavaScript reaches the host later, for two things, by two routes: the text pipe over a host-held value is a Rust port
checked against the TypeScript tests as vectors, or an embedded QuickJS running the esbuild bundle pinned by hash; a full
JS exec placed at the host (slice 4) runs in the container's Node, or in an embedded engine if it must be in-process. A
JS sidecar at the host becomes necessary when the hub drives a desktop runtime with no browser attached, because the
policies then have to be evaluated there; that is slice 5's problem, and the facts-in, verdict-out message is the same
either way. Deno's permission model restricts the host and not the processes it starts, so it never replaced the OS
sandbox; Anthropic's `sandbox-runtime` is the reference for the profiles, not a dependency.

## Open questions

- **Containers on macOS**: Docker or Podman (a VM either way) or Apple's own `container`; what the person has to
  install before slice 1 works.
- **Session state across turns**: RULED 2026-10-30, see "A session is a VALUE" above: `cwd`/`env` live in the
  session value in the run's namespace, lost with it, and a resumed run finds nothing at the host.
- **Resolve, then run**: the host resolves paths for the decision and then spawns; a symlink swapped between the two is
  a race for the CHILD'S opens, which reopen by name. The host's own reads open by descriptor without following links
  ("Workspace roots"); the child's are bounded by the OS sandbox in host mode and by construction in a container, and
  on the plain host the race stays open and the call asks anyway.
- **Interactive programs** (`ssh`, a REPL, `top`): out of scope for what is built; the shape, the ruling that every
  write to stdin is a call, the host-side terminal emulator and the order of slices are in
  [`SHELL_INTERACTIVE.md`](SHELL_INTERACTIVE.md) (proposed 2026-10-24, nothing assigned). The hub spec's "start a
  process and send input" names the same thing.
