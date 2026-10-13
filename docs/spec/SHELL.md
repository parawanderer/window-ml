# Spec (WIP): one executor, many places — processes through `ml.sh`

**Status: initial draft (2026-10-13), nothing built.** Where processes run and how the model reaches them. The
mechanism of a single call (typed call to argv, a manifest per program) is summarised under "One call"; its open
dependency is [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md), which only the free tier waits on.

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

**Inside the host, a container by default.** Each session gets its own container with the work folder mounted and the
network off unless granted. The container bounds the damage; the manifest (below) decides what runs without asking.
Without a container ("host mode", the person's real filesystem) the same calls work, every effectful one asks, and the
person turns it on knowing that. A container's state can be kept per session or thrown away, and its inputs mounted
read-only by hash, which is what the notebook-signing gaps need ([`NOTEBOOK_TOOLING.md`](NOTEBOOK_TOOLING.md) §10).

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
- **No terminal, stdin closed:** a program that prompts fails at once instead of hanging; a time limit applies; a long
  one detaches with a cancel handle.
- **Session state is data.** `cwd` and `env` are kept by the host per session and passed to each spawn; `env` writes
  have their own whitelist, since `PAGER`, `GIT_EXTERNAL_DIFF`, `LD_PRELOAD` or `GIT_SSH_COMMAND` turn a read into
  running code. Restoring them is free; files a command wrote are NOT rolled back (only a container snapshot does that).

## Approval

Three tiers, decided per CALL, on the final argv:

1. **Free** — the program's manifest says this program, subcommand and flags only read (`git diff` without `--output`,
   `rg`, `ls`), and the env is clean. Allowed in a read-only survey, charged to its step budget (the manifest's cost
   tier). **This tier waits on** [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md); until then nothing is
   free.
2. **Asks, per call** — anything else, including an unannotated program. The card shows the argv, cwd and env changes
   that will run, not the script that computed them. Approving a script is not approving every argv it can build: a
   script can compute `ml.sh.git.checkout(someTextFromThePage)`, and the person approved the code, not that value.
   This is the property worth having: **what was approved is exactly what runs.**
3. **Refused** — a program the person has blocked, a call from a page-started message, or `ml.sh` from the page's world.

So the manifest blocks only the free tier. A first build where every call asks is useful, and correct, without it.

## What the model sees

- **Nothing new in the prompt.** `ml.sh` is documented by its JSDoc through `agent_api_docs`, like every `ml` member.
- **Whether it exists**: `ml.current.runtime.capabilities.shell`, which the projection rule passes with no edit
  (`current-runtime.ts`). Absent means no process host is attached.
- **Where things went**: the call's result says where it ran (container or host mode) the way `env.exec` says where an
  exec ran, so the model never has to try.

## Python

**Decided (Shane, 2026-10-13): Python is a REPL beside JavaScript with the same `ml` objects in it, so `ml.sh` is
there too.** Not a capability called from JS (`ml.py(...)`), and not a separate world: the same namespace, the same
pointers, the same rules, in the other language.

```python
r = await ml.sh.run(["git", "log", "--oneline", "-200"])
lines = ml.pipe(r.stdout, "grep -i fix | head -20")      # runs at the host; twenty lines cross
```

What follows from it:

- **It needs `ml` inside Pyodide first.** The Pyodide worker cannot reach the extension's objects directly, so each
  `ml` call is a mediated callback out of the worker (the way its stdout is already teed out), then the same path to
  the worker and the process host as a call from JavaScript. That prerequisite is the same for every `ml` member, not
  only `ml.sh`.
- **The same values.** A process's output reaches Python as the same host-held pointer it is in JavaScript; a pointer
  made in one language is readable in the other.
- **The same approval.** The tier is decided per call on the final argv, at the call, whatever language made it.
  `python_exec`'s `readonly` mode (which cuts the network and JS bridges, `docs/dev/python-sandbox.md`) can make
  free-tier calls and asks for the rest; it does not need a Python read-only dialect for that, since the decision is
  on the argv, not on the Python that computed it.
- **Placement, later, by the same rule.** Real CPython at the process host, with real packages, is a place a Python
  cell could run; under "placement is unobservable" that is an optimisation, not a second Python the model addresses.

## Security invariants

- **A page never reaches the process host.** No page-started type (`page-relay.ts`) reaches it, and a script naming
  `ml.sh` never runs in the page's main world. Red-team tests enumerate both, as for `ml.current.env`.
- **The host trusts only the extension**: native messaging's `allowed_origins`, and on the hub a sealed command from a
  principal holding `desktop` ([`RUNTIME_HUB.md`](RUNTIME_HUB.md)).
- **No secret crosses into a process**: the backend URL and API key never reach the host; the host's environment is
  scrubbed to a whitelist, and a container sees only its mounts.
- **Approval is on the argv that runs**, never on a description of it (tier 2), and every call is logged with its argv,
  env changes, cwd, exit code and output hashes (the run log, and the provenance a signed notebook would cite).

## Slices

1. **The host, attached by native messaging, in a container, every call asking.** `ml.sh.run`, `pipe`, `glob`; outputs
   as host-held pointers with `ml.pipe` run at the host; `capabilities.shell`; the routing rule; red-team tests.
2. **The free tier**, once the library manifest exists: manifests for a handful of read-only programs (`git`, `rg`,
   `ls`, `cat`, `wc`, `find` without its effectful flags).
3. **Placement**: a script naming only `ml.sh` evaluated at the host.
4. **The host on the hub** as a desktop runtime: a shell on another machine.

## Open questions

- **The host's language.** Rust matches the hub (decided there for memory per connection); Node or Deno runs the
  text-pipe dialect and the read-only interpreter as they are, which slice 3 and "the operation goes to the value"
  both want. Leaning Deno (one binary, permissions, runs the TypeScript).
- **Containers on macOS**: Docker or Podman (a VM either way) or Apple's own `container`; what the person has to
  install before slice 1 works.
- **Session state across turns**: whether `cwd`/`env` live per run or per session, and what a resumed session finds.
- **Interactive programs** (`ssh`, a REPL, `top`): out of scope, or a separate input channel later. The hub spec's
  "start a process and send input" names it.
