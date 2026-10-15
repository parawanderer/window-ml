# Spec (WIP): one executor, many places — processes through `ml.sh`

**Status: draft (2026-10-13, refined 2026-10-15), nothing built.** Where processes run and how the model reaches them. The
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
  cache, `~/.kube`) gets that path added rather than the sandbox removed.
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
  theirs. Two answers, both: a BELT, the host forcing `core.fsmonitor=false`, `core.pager=cat` and an empty
  `diff.external` through `GIT_CONFIG_COUNT` in its own base environment for every git spawn (plus
  `GIT_OPTIONAL_LOCKS=0`, so a status writes no index), with the manifest adding `--no-pager`, `--no-ext-diff` and
  `--no-textconv` to the read subcommands; and a FACT, `repoConfigRunsCode`, from the host reading the repository's
  config and what its includes pull in for those keys, which the plain-host default policy requires to be false. Under
  the sandbox the harm is bounded and the tier is what the algebra says.
- **A recursive reader is judged on what is BENEATH its directory argument**, not on the named path alone (`rg pat .`
  reads `root/.env`). The manifest marks recursive readers (`rg`, `grep -r`, `find`, `ls -R`, `tar`, `du`); for one, a
  directory argument carries a `containsSecret` fact from a bounded walk by the host (past the cap it is `unknown`, and
  the call asks), and the default policy requires it false. A `.env` in the tree asks; a person whose dotenv test suite
  needs it free writes a WORKSPACE policy saying so. The Seatbelt profile hides credential STORES (`~/.ssh`, `~/.aws`) at
  any depth and does not hide project `.env` files, for that reason.

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

So the manifest blocks only the free tier. A first build where every call asks is useful, and correct, without it.

## Policies: what a shell call gives one

"Run this without asking me" is a POLICY: a function over the call in the read-only dialect, answering `allow`, `deny`
or nothing, set globally, per workspace or per run, listed on one page, and never changing what the container, the OS
sandbox and the roots enforce. The mechanism is shared with every other gated call and is specified in
[`POLICIES.md`](POLICIES.md); `ml.sh` is its first consumer. What is particular to the shell is what a policy is given,
and that the free tier is a built-in default policy over it.

```js
// Global, set by the person: read-only git anywhere in my roots, except the flags that write or run code.
(c) => c.argv[0] === "git" && ["status", "diff", "log", "show", "blame"].includes(c.argv[1])
    && !c.argv.some((a) => /^--(output|ext-diff|exec|upload-pack)/.test(a))
    && c.paths.every((p) => p.inRoot)

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
| `run` | the run it belongs to (its id; a run policy sees only its own run) |

**The free tier is the built-in default policy**, the one subset rule in [`EFFECTS.md`](EFFECTS.md); on the plain host it
reads `(c) => c.effects.every((e) => e.op === "read" && e.res.kind === "fs" && e.res.inRoot && !e.res.secret)`, a universal
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
