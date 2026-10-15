# The REPL work: plan for independent agent sessions (2026-10-15)

Committed under `docs/plan/repl/` so every clone has it; the results each lane sends back land in this folder too, by PR.

Written by the Fable session "repl-specs" (session `c658cbfe-3609-423d-9482-601a398d1e59`, model `claude-fable-5-1`),
which stays alive to resolve ARCHITECTURE questions. Shane owns the decisions. Each lane below is one Opus session in its
own clone. Read this file, then your lane file, then the specs it names, before writing code.

## What this is

Five connected topics, now specified: policies, library and program manifests, the shell (`ml.sh`) and its process host,
Python parity (a read-only dialect, `ml` inside Python, a persistent namespace), and where desktop-level work runs. The
specs (all in `docs/spec/`, merged in #666, #668, #669):

| Spec | What it decides |
| --- | --- |
| `EFFECTS.md` | one effect algebra: sets of (operation, resource) pairs; every vocabulary projects onto it; the free tier is one subset test |
| `POLICIES.md` | a policy is a function over a call's resolved facts, evaluated in a POLICY REALM of the read-only dialect; scopes; one page; widening is never a card button |
| `ML_WIRE.md` | one `ml` call as a message every executor speaks; copies and handles, never proxies; per-call asking by suspension |
| `PYTHON_DIALECT.md` | a read-only Python as a RESTRICTED MODE PATCHED INTO CPYTHON (not a sandbox, not an evaluator above the runtime); `mode` replaced by membership; one persistent namespace per run |
| `READONLY_LIBRARY_MANIFEST.md` | how a library's functions are described (effects, callbacks, aliasing, cost tiers); its main consumer is the Python dialect |
| `PROGRAM_MANIFEST.md` | how a PROGRAM is described for the shell (effects, path args, operand start, runner, echoes); no cost tiers |
| `SHELL.md` | processes as `ml.sh`, values stay home, two modes (container, host), the OS sandbox on by default, the host in Rust |
| `SECRET_HANDLES.md` | credentials an agent uses but never reads; how they meet policies, the algebra, processes, the wire, the dialects |

## Decisions already made (do not re-litigate; mail `repl-specs` if you think one is wrong)

1. **Python is a dialect, not a sandbox.** The gate goes into CPython's abstract object layer under a thread-state flag.
   No tree-walker, no guarded-compile prototype first. (`PYTHON_DIALECT.md`, "Why a dialect", "The design".)
2. **The CPython patch keeps the ABI** (ceval, abstract.c, thread state only): stock wheels work in Pyodide and on the host.
3. **The host is Rust**, not Node. The policy DECISION stays in the browser's worker; the host resolves facts and enforces.
   No JavaScript in the host's first slices. (`SHELL.md`, "The host's language".)
4. **A hub is not an execution environment, and an execution environment is not a hub** (Shane, 2026-10-15). The process
   host must build and run with NO hub code (native messaging alone), and the hub must know nothing about shells or
   processes beyond relaying sealed commands to a runtime that declares capabilities. In code: the host is its own
   repository, and the hub transport is an optional Cargo feature that pulls the hub's client crates in; the default
   build has none of them. `SHELL.md`'s "a sibling of `wmlbox`" means "built the way `wmlbox` is built", not "lives
   with it". (`SHELL.md`, "Where processes run".)
5. **`ml` is a wire protocol**, served by the service worker, and the run id is never authority: the server answers by the
   sender it can verify. (`ML_WIRE.md`.)
6. **Policies' first consumer is an existing gate** (the approved-URL grants from an `exec` card), not `ml.sh`.
7. **`mode: readonly|full` goes away**, replaced by dialect membership. Not yet: it needs `ml` in Pyodide AND the patch.
8. **No `vars` parameter.** JS values reach Python through `ml.state` over the wire, by copy or as a pointer.
9. **Placement is unobservable up to the recorded environment**: pin versions, stamp the environment, name BLAS order
   as a tolerance; no Pyodide-under-Node at the host.
10. **Step 0 of the Python dialect is a corpus count**, a notebook, before any whitelist is written.

## The dependency graph, and what is a root

A ROOT depends on nothing unbuilt. Nine of them:

| Root | What it is | Done when | Size | Lane |
| --- | --- | --- | --- | --- |
| **A. `ml` wire** | the message schema in the contract, the worker routing it, answered by sender not run id | a fake client in a test gets `value`, `pointer`, `error` and `ask` back | M | 1 |
| **B. corpus count** | a notebook walking every stored `python_exec` cell with `ast`: node types, imports, attribute calls | the node whitelist and the first manifest's method list, as data files | S | 3 |
| **C. persistent namespace** | a dict per run in the Pyodide worker, injected names as plain assignments, the loss message from the housekeeping record | a run's second cell sees the first's names; a kill is told, never silent | M | 1 |
| **D. effect algebra** | one TypeScript module: the pair set, the projections, the subset test | property tests over every projection row in the spec | S | 2 |
| **E. policy realm** | the third `ReadonlyRealm`, a `c` facade that refuses absent fields, `==` refused | adversarial and halting tests per the dialect rule | M | 2 |
| **F. program manifests** | the data format, a validator, manifests for `git`, `rg`, `ls`, `cat`, `wc`, `head`, `tail`, `find`, `jq` | argv in, effects and path arguments out, over a fixture of calls | M | 4 |
| **G. vector corpus** | the JS dialect's halting, failure and abuse tests lifted into language-neutral vectors | the JS dialect still passes them from the shared file | S | 3 |
| **H. CPython patch, desktop** | the restricted mode against stock CPython on a laptop: flag, gates, budget, allocation hook, undo log | the vectors from G pass, including the C-path cases, under the patched binary | L | 3 |
| **I. Rust host binary** | its own repo: stdio framing, spawn with argv, env scrub, Seatbelt profile, held output, fact resolution | a test driver sends argv and reads back a pointer; nothing touches the extension yet | L | 4 |

Edges (what waits on what):

- `ml` in Pyodide ← A. The policy store and its first consumer ← D, E. F's effect type ← D (F may start on the data
  format and adopt D's module when it merges). `mode` removal ← `ml` in Pyodide, H. The Pyodide build of the patch ← H.
  The host's extension side ← A, I. Package install, secrets ← the policy store. Placement, the hub desktop runtime ←
  everything above.

Not a root, and not started this round: `mode` removal, the Pyodide build, the host's extension side, package install,
secrets, placement, the hub desktop runtime.

**Added 2026-10-15: K. registering a program** ([`PROGRAM_MANIFEST.md`](../../spec/PROGRAM_MANIFEST.md), "Registering a
program"): the sandbox profile derived from a manifest's claims (the description as the envelope), hash pinning of a
resolved program, a manifests directory with workspace and global scope, drafting a manifest from `--help` or completion
files as a card with evidence, and the registration page. Depends on I and F; unassigned this round. Details settled
with lane 4 (2026-10-15): the host's sandbox plan gains `write: none|roots` and `exec: any|program-only`; on macOS
Seatbelt restricts `process-exec` to a literal path; on Linux the same comes from Landlock's per-path EXECUTE right,
applied by a small exec shim (`exec-under <ruleset> -- prog`, which composes with bubblewrap and keeps the host free of
`unsafe`), with EXECUTE granted to the program, the ELF interpreter and a script's `#!` interpreter; the Landlock ABI is
reported in `hello`, and best-effort is treated as unavailable, so a no-runner claim is never silently trusted where
the kernel cannot enforce it. Landlock also closes a WRITE gap bubblewrap has (measured in the host's Linux CI, 29 of 30
enforcement tests passing): bwrap binds only paths that EXIST when the call starts, so a protected path that is absent
then (`.vscode/settings.json`) is writable on Linux while Seatbelt's regex denies it. K's Linux write rules are Landlock
rules over the roots minus the protected NAMES, which hold whether or not the file exists; the gap is pinned by its own
test in the host repo, which must flip when K lands.

**Added 2026-10-15 from lane 1's root A findings: J. whole text captures in the value store.** The run's pointer store
keeps only the text the model saw (`fetch_url` stores the first few thousand characters of a body), and only TABLES are
kept whole (`POINTER_VALUES.md`, slices 5 and 6). So "the operation goes to the value" has no value to go to for a text
body, and a code client (a Python cell, a survey's pipe) computes over a prefix. J is a root (it extends the value store
the way the table slices did), taken by the fresh lane 1 session on 2026-10-15 (`POINTER_VALUES.md`, slice 9): a fetched text body past its preview is
now stored whole. A `value` answer for a capture that was NOT stored (a page-hosted run's fetch, a body past the fetch's
read cap, an `exec` or `python_exec` output) still carries `truncated: true` and the full size, and every client
surfaces it.

## Status (2026-10-15, evening of the first day)

- **Lane 1**: root A merged (#678, result #689, design note #691); root J merged (#705, result #726) with the main-world
  fallback kept on Shane's decision. The lockdown is owned by the red-team session (below). While it lands, lane 1 builds
  the non-colliding part of PR 2: the Python `ml` facade in `python-runtime.ts` against a fake transport, wired to the
  real channel once the lockdown merges; then root C.
- **Lane 2**: D (#672), E (#686), 3a (#699), the `sh` consumer and archive removal (#706), the policy vectors (#709), 3b
  (#716: the `POLICIES` message, the policy page in DevTools Settings, re-judging a showing card) all merged. Next: 3c
  (`propose_policy`, with the breadth probe carrying no fixed shape and siblings at every label depth, #719), then the
  results `LANE_2_RESULT_E.md` and `LANE_2_RESULT_3.md`. Two dialect holes found and fixed on the way (#675 `Object.assign`,
  #699 the page inheriting run URL grants).
- **Lane 3**: B+G (#677), root H in `parawanderer/cpython` branch `ml/restricted-mode`: slice 1 (`CO_RESTRICTED`, the entry,
  the extent predicate, specialization off) and slice 2 (the gate, with lifting OPT-IN per manifest leaf) built; the
  no-specialization cost measured (#718: 1.66x on pure-Python benchmarks, about 1.06x on real cells); CPython's suite at 0
  failures; stock cp314 wheels load unrebuilt (the ABI holds). 71 of 85 shared Python vectors pass; the rest wait on
  slices 4 to 6. Vectors #721, the leaf-vocabulary count #722 open. **Assigned after H** (Shane, 2026-10-15): the Pyodide
  build of the patch, a build-flags job on the ABI argument.
- **Lane 4**: I (host v0.1.0, v0.2.0), F (#683), results (#687, #694), the `sh` core (#704), nested asks (#710) merged.
  Next PR 4a (the native port, Settings, the shell capabilities, the red-team test that no page-started type reaches
  the host), then 4b (`ml.sh` itself, with the descriptor union making `effects` required for `fetch` and `sh`).
- **Red team** (outside the lanes): vectors #698 open as `todo`; interim mitigations #708 merged; the lockdown's core
  built on #698's branch, uncommitted (ses `lockdown()` plus the allow-list strip, both needed, #725; captured harness
  refs; stdout through real stdout; asyncio cancel); still to build: the worker per principal, the enumeration test,
  the corpus number, docs, state registry. Its PR unblocks lane 1's PR 2 and root C.
- **Site access** (#647, outside the plan): rebased past #710, owner strings approved, merging; lanes 2 and 4 rebase onto it.
- **Specs amended today by rulings** (all merged): effects (#671), wire (#693, #701), policies (#679, #700, #707, #719),
  shell and manifests (#681, #682, #685, #688, #695, #697, #702), the Python dialect (#673, #674, #711, #718, #720), the
  lockdown plan (#690, #700, #725), the README's rows (#712), the coordinator's handover (#715).
- **Unassigned roots**: K (registering a program; depends on I and F), the host's hub transport (behind a Cargo feature),
  the typed-node policy tree (the derived breadth).

## The lanes

Each lane's second task is unblocked by its own first one, so a session never waits on another lane to have work.

1. **Wire and Python** (`LANE_1_WIRE_PYTHON.md`): A, then `ml` in Pyodide, then C. Starts first: everything consumes A's schema.
2. **Policies** (`LANE_2_POLICIES.md`): D, then E, then the store with the approved-URL grants as first consumer.
3. **Runtime** (`LANE_3_RUNTIME.md`): B and G together, then H, then (later) the Pyodide build.
4. **Host** (`LANE_4_HOST.md`): I, then F once D has merged.

## How to work, and how to coordinate

- **A heavy run never rides a session's shell** (incident, 2026-10-15 evening). A full test suite, a benchmark sweep or a
  build that takes minutes runs detached (`nohup … > <log> 2>&1 &`, its own log under the scratchpad), with a per-test
  timeout and a memory cap (`ulimit -v`, or the suite's own `--timeout`/`--memlimit`), and ONE at a time on this machine,
  which has 16 GB. Lane 3's CPython suite run on the restricted-mode fork sat on a worker that grew to 14 GB and took every
  session down with it; the session that started it died, the run did not. A run whose owner dies is anyone's to kill.

- **One clone per session**, a sibling of `~/git/window-ml` named for the lane (`window-ml-repl-lane1`, …). The
  commands are in `docs/dev/working-in-the-repo.md`, "Running several sessions at once": clone, symlink `.env` and
  `pyodide-wheels`, `git config core.hooksPath .githooks` (silent if skipped), `npm ci && npm run build`. The clone
  `~/git/window-ml-repl` belongs to the Fable session; do not work in it. Remove your clone when your lane's last PR has
  merged and it holds nothing unpushed (AGENTS.md rule).
- **One root per PR**, two at most. The first PR of a lane lands tests and data wherever it can before code. Labels by
  topic on every PR (`gh pr create --label …`): lane 1 `@python,@api,@security`; lane 2 `@exec,@security,@ui`; lane 3
  `@python,@exec` and a NEW `@runtime-compat` label (make it, with a description: "needs a matching change in the
  forked CPython/Pyodide"); lane 4 `@hub-compat` only if a hub crate changes, otherwise the host repo's own labels.
- **Every GitHub post names your session** (AGENTS.md, "Branches, PRs and CI"): the trailer and the HTML comment with
  your session id, model id and work slug. Work slugs: `repl-lane1`, `repl-lane2`, `repl-lane3`, `repl-lane4`.
- **Merge your own green PR** with `node scripts/merge-when-green.mjs <pr> --wait --merge --session <id>` once CI is
  green, no test was removed and no review is unread. Spec-only PRs merge the same way.
- **Session mail** (`~/git/session-mail/README.md` is the protocol; the `session-mail` skill adds the Claude Code
  specifics): when your work touches a file another lane owns, when a root another lane consumes has merged (D for
  lane 4; A for whoever takes the host's extension side later), or when you have a question only another session can
  answer. Do not poll the folder; Shane relays "check your mail".
- **Architecture questions go to `repl-specs`** by mail, and tell Shane "mail for repl-specs". What counts: anything
  that would change a decision above; a contradiction between two specs; the security shape of a new message type;
  the sync-versus-`await` question for `ml` in Python; the semantics of a suspended call (`ask`); whether `mode` can
  go earlier than planned; where a piece of state belongs. Do not block on the answer: do everything that does not
  depend on it, state your assumption in the PR, and continue.
- **File ownership this round**, to keep PRs from colliding: lane 1 owns `src/python/`, `src/offscreen.ts`,
  `src/sw/sw-offscreen.ts` and a new `sw-ml-wire.ts` under `src/sw/`; lane 2 owns `src/readonly-exec/`, `src/sw/sw-consent.ts`,
  `src/sw/grant-extract.ts`, the settings panel and a new `effects.ts` at the top of `src/`; lane 3 owns `notebooks/python-dialect/`,
  `tests/fixtures/dialect-vectors/` and the CPython fork, and touches nothing under `src/` this round; lane 4 owns the
  new host repository and a new `src/shell/`. Touching another lane's file is fine with a mail first.
- **The repo's standing rules apply to every lane** (AGENTS.md): a new `ml.*` member or message type gets a RED-TEAM
  PASS with tests that fail first (lane 1's A is one); state kept across calls is declared in the STATE REGISTRY from
  the first commit (lane 1's namespace, lane 2's policy store); a dialect extension gets adversarial, halting and
  failure tests WITHOUT being asked (lane 2's realm, lane 3's patch); the DevTools Settings panel is the superset for any
  new flag; `docs/dev/` is updated in the same PR as the code it describes; search by concept before building anything
  reusable (`node scripts/index.mjs '<regex>'`); a complex analysis is a notebook, not a reply (lane 3's count).
- **What to send back** at the end of each root, as a file in this folder named `LANE_<n>_RESULT_<root>.md`, by PR
  (label `@docs`): the PR numbers, what the acceptance test showed, what did
  NOT work or was left out and why, every assumption you made where a spec was silent, and anything you think a spec
  got wrong. Negative results are wanted.
