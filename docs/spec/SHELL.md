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
  same size rules as any pointer read. Nothing crosses because a variable was touched.
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
  one detaches with a cancel handle.
- **Session state is data.** `cwd` and `env` are kept by the host per session and passed to each spawn; `env` writes
  have their own whitelist, since `PAGER`, `GIT_EXTERNAL_DIFF`, `LD_PRELOAD` or `GIT_SSH_COMMAND` turn a read into
  running code. A call's `env` ADDS to the session's; in the Python shim, `env={**os.environ, …}` would carry the
  sandbox's environment to the host, so it is refused with a steer. Restoring them is free; files a command wrote are NOT rolled back (only a container snapshot does that).
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
refused, because `npm test` or `make` can run git under a repository's config, and that is the case the fact exists for. ASSIGNED 2026-10-21 to lane 11 (window-ml-host PR; the janitor reviews after window-ml #957; lane 11 merges with `--read`). Read against the host at 9b7d012: `gitconfig.rs` already resolves a config or an include it cannot read, one past its size or its include depth, to `true` with the reason, which is narrower than `null` and stands; so after the change `repoConfigRunsCode` is `true` or `false` for every call the host can see, and `null` stays reserved for the one case the host could compute nothing at all, `PROTOCOL.md`'s comment on the fact rewritten in the same PR. The failing-first test is the host's `a_plain_repository_runs_no_code_and_a_plain_directory_is_no_repository`, whose last assertion flips from `Null` to `false`; window-ml changes nothing, the realm rule stays. Built as window-ml-host #23 (lane 11), which also closes a `.git` stat error other than NotFound to `true` with the reason. RULED 2026-10-21 on the residual lane 11 named there: a linked worktree's `commondir` that cannot be read or resolved is the same case, `true` with the reason, never the fall-back to the worktree's own gitdir that skips the shared config and reports `false`; only NotFound (a main worktree has no `commondir`) walks on. Folded into #23. As built, `sh-call.ts` leaves `containsSecret`, `topLevel` and `isRoot` out when it has no
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

Proposed by Shane 2026-10-21, open, his to widen since the boundary above is his: the host answers "which session owns
this CPU process" for processes it did NOT spawn. The question came up repeatedly in that day's runs, and its live
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
- **Session state across turns**: whether `cwd`/`env` live per run or per session, and what a resumed session finds.
- **Resolve, then run**: the host resolves paths for the decision and then spawns; a symlink swapped between the two is
  a race for the CHILD'S opens, which reopen by name. The host's own reads open by descriptor without following links
  ("Workspace roots"); the child's are bounded by the OS sandbox in host mode and by construction in a container, and
  on the plain host the race stays open and the call asks anyway.
- **Interactive programs** (`ssh`, a REPL, `top`): out of scope, or a separate input channel later. The hub spec's
  "start a process and send input" names it.
