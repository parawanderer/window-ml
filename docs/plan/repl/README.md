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
| `PYTHON_DIALECT.md` | a read-only Python as a RESTRICTED MODE PATCHED INTO CPYTHON (not a sandbox, not an evaluator above the runtime); `mode` replaced by membership; one persistent namespace per run. Measured cost (lane 3, `LANE_3_RESULT_H.md`): building with specialization off is 0 to 10% slower on the corpus, central estimate 6%, inside a ±40% noise floor; a restricted run adds 25 to 35% on cells of real size on top of that, and the reference tracer 3 to 4% on all Python in the process |
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

**Added 2026-10-15: K. registering a program or library manifest** ([`PROGRAM_MANIFEST.md`](../../spec/PROGRAM_MANIFEST.md),
"Registering a program" and "Interpreted script tools"; [`READONLY_LIBRARY_MANIFEST.md`](../../spec/READONLY_LIBRARY_MANIFEST.md),
"Generating and importing a manifest into the runtime"): the sandbox profile derived from a program manifest's claims
(the description as the envelope: no separate sandbox profile file is introduced — the host's per-call sandbox `Plan` is
compiled directly from the call's approved `EffectsData` set $E(c)$, the workspace roots, and the fixed credential/hook
safety floor, with workspace secret files denied at the kernel level unless present in `allow_read`, see
[`EFFECTS.md`](../../spec/EFFECTS.md)), `(program, entrypoint)` prefix matching so interpreted CLI scripts
(`["node", "scripts/<name>.mjs", ...]`, `["python3", "<script>.py", ...]`) with no preceding interpreter flags get their
own manifests keyed on `argv[0..1]`, `sha256` pinning of a resolved binary, script closure, or library module, a
manifests store with workspace and global scope, `propose_manifest` (drafting a program manifest from `--help`/script
source or a library manifest from module source/types into a card with sandbox or Tier 3/Tier 1 probe evidence, and
loading it live into the runtime on approval), and the registration page in DevTools Settings. Depends on I and F;
unassigned this round. Details settled with lane 4 (2026-10-15): the host's sandbox plan gains `write: none|roots` and
`exec: any|program-only`; on macOS Seatbelt restricts `process-exec` to a literal path (the binary, or the interpreter
binary when matching `(program, entrypoint)`); on Linux the same comes from Landlock's per-path EXECUTE right, applied by
a small exec shim (`exec-under <ruleset> -- prog`, which composes with bubblewrap and keeps the host free of `unsafe`),
with EXECUTE granted to the program, the ELF interpreter and a script's `#!` interpreter; the Landlock ABI is reported in
`hello`, and best-effort is treated as unavailable, so a no-runner claim is never silently trusted where the kernel cannot
enforce it. Landlock also closes a WRITE gap bubblewrap has (measured in the host's Linux CI, 29 of 30 enforcement tests
passing): bwrap binds only paths that EXIST when the call starts, so a protected path that is absent then
(`.vscode/settings.json`) is writable on Linux while Seatbelt's regex denies it. K's Linux write rules are Landlock rules
over the roots minus the protected NAMES, which hold whether or not the file exists; the gap is pinned by its own test in
the host repo. **Amended 2026-10-19 (coordinator ruling on window-ml-host #12, the case found by lane 4's review):** the
Landlock rules apply to a call whose envelope says `write: "roots"`, and ONLY to it. Landlock allows by path and cannot
except a name, so under those rules the kernel refuses a top-level `mkdir`/`rmdir` and a new directory under `.git`
(`cargo build`, `npm install`, `git rebase`, `git worktree add`); that is a documented property of the narrow envelope,
stated in the host repository's sandbox doc (SANDBOX.md in window-ml-host), and the worker does not send `write: "roots"` for a call whose claims need a new
top-level directory. An ABSENT envelope keeps today's floor, bubblewrap with the gap (the 2026-10-19 10:10Z ruling:
absent is today's behaviour, so that the monotonicity invariant holds), so the gap's test does not flip at K3: it stays
as the pin of the absent case and gains a sibling that passes under `write: "roots"`. Closing the gap for an absent
envelope at the price of top-level `mkdir` was Shane's decision: **no** (2026-10-19), the default stays as ruled, and the
report-only tripwire below is what covers the gap's threat; the host never reverts what the tripwire finds. **Later the same day:** under `write: "roots"` the top level of a root is name-immutable (no new, removed or
renamed name there, files included: Landlock cannot withhold an absent FILE either, lane 4's finding), and every
call (sandboxed or not, host #13) reports `protectedChanged` in `done`, report-only (`SHELL.md`, the host's security list). The tripwire is
**K3b**, lane 4's, DONE 2026-10-19: host side window-ml-host #13 (merged, the generalist reviewed), extension side window-ml
#813 (merged 99b294d8, the janitor and the generalist reviewed; the run-log cut marker and the `run.json` ask outcome followed in
#823, merged 2026-10-20, 4024f86b). The envelope's extension side is the generalist's #807 (merged 1f79f663). K3b ships the
compare at `done` and at `status` for a live orphan; the compare at an orphan's DEADLINE kill (an `ended` record next to
the ledger, returned by the next session's `status`) is an open item, unassigned, because it adds persistence and a
consume-once semantic that need their own design (ruled 2026-10-19).
**K3d** (the red team's #827 audit, 2026-10-19): bwrap re-bound only part of the protected names, so the host now reads one
list per layer (bwrap re-bind, Landlock enumeration, tripwire snapshot) from `PROTECTED_TOP` (+ `PROTECTED_GIT`), with an
enumerating test per layer and a real-kernel read-only proof: window-ml-host #15 (merged 2026-10-19, cd56124, lane 4's; the
generalist reviewed; the red team verified after merge, rule 10). Lane 4's next host PR, window-ml-host #16 (merged 2026-10-19, 816113a,
the generalist reviewed): macOS denies the whole `.claude` directory, as the Linux rule does, not only the files it lists.
The red team verified both on 2026-10-20 at 816113a, statically on both OSes: one list of fifteen names, read by the bwrap
re-bind and by the Seatbelt regexes, with enumerating tests; a real-kernel Landlock run is not checked (no Linux box). The
audit's extension half, the version probe's start carrying the envelope its judged facts derive (ruling A, one derivation
path), is window-ml #834 (the generalist's, merged 2026-10-20, 274b8a6a; the janitor reviewed; the red team's two probe
tests un-todo'd plus a git control: a pre-K3 host is sent no envelope). The red team's #827 is closed as superseded; its
done-mismatch test already held on main through #813. K3's audit is closed.
**K3c** (2026-10-19 14:07Z, the red team's escape: the policy layer counted any in-root write as inside `B`, so
`git diff --output=.envrc` ran free) is window-ml #788 (merged 2026-10-19, a6826b0), lane 4's, ahead of K3b: the top-level names of a root are
outside `B` (`EFFECTS.md`, #783), `write-names` is a manifest word projecting onto `write` (#786), the red team's
acceptance tests come first unchanged; flaky-3f reviews, never the red team (rule 10). Host follow-up: the host's manifest
reader's `WriteNames` variant landed in window-ml-host #14 (the generalist's, 2026-10-19, a6637b6); what was missing were
the two guards, window-ml-host #17 (lane 4, 2026-10-20, tests only: every effect term and direction enumerated against the
call vectors, an unknown-word refusal; a send-only network effect has no vector yet). Host #17 merged 2026-10-20 as
54caaa85 with the inventory compiler-enforced (`ProgramEffect::ALL` beside the enum, an exhaustive `slot()`; the janitor
replayed three mutations that no longer compile; the red team reads it after merge). Also lane 4's, done 2026-10-20: the
transcript line for an `ml.sh` call that ran under a policy or the default, window-ml #864 (merged 1d0ad45e, the Chat
Page session reviewed): `unasked` on the call's span, drawn in the sidebar and both exports through the card's own code
path, the JSON export carrying the spans verbatim. Then its setsid residual, window-ml-host #18 (merged 2026-10-20,
318977df, the red team gated it: the kill set is the group plus recorded members and their descendants, re-sampled, and
a group signal only while the group is still the call's own, the red team's overkill finding; the LIVE path had the
same hole and is fixed with it), with window-ml #868 (merged 94fb146a: `SHELL.md`'s Ownership bullet, its claim
softened to "up to the residuals", three named: a child that leaves the group within one sample, a host killed outright
with calls running, and the owner-lost and final kills signalling the group without the ownership check inside the
5 s drain). Lane 4 stood down 2026-10-20, clones removed.

**Added 2026-10-15 from lane 1's root A findings: J. whole text captures in the value store.** The run's pointer store
keeps only the text the model saw (`fetch_url` stores the first few thousand characters of a body), and only TABLES are
kept whole (`POINTER_VALUES.md`, slices 5 and 6). So "the operation goes to the value" has no value to go to for a text
body, and a code client (a Python cell, a survey's pipe) computes over a prefix. J is a root (it extends the value store
the way the table slices did), taken by the fresh lane 1 session on 2026-10-15 (`POINTER_VALUES.md`, slice 9): a fetched text body past its preview is
now stored whole. A `value` answer for a capture that was NOT stored (a page-hosted run's fetch, a body past the fetch's
read cap, an `exec` or `python_exec` output) still carries `truncated: true` and the full size, and every client
surfaces it.

## Status (2026-10-19)

The coordinator role passed on 2026-10-19 to a continuation session (`7a8ce8b6`, same name in `ListAgents`, work slug
`repl-specs`); the previous session's state is `COORDINATOR.md` plus the clone's checkpoint. What the 2026-10-16 status
listed as remaining is DONE unless named below.

- **Lane 1: CLOSED 2026-10-19.** PR 2b + root C merged (#757: `ml` over the wire from a cell, one namespace per run,
  the per-browser residual pinned by a test and named on the full-mode card); `LANE_1_RESULT_C.md` merged; clone removed.
  Left unassigned by it: the redteam's non-blocking second pass on the codec fix (b05d1d7c), renaming the two "property
  FAILS TODAY" tests, a bound of `handlesIn`'s own should it ever be exported, and the two loader shapes
  (`LANE_1_RESULT_C.md`, follow-up).
- **Lane 2: DONE** (unchanged since 2026-10-16).
- **Lane 3: list CLEAR.** Root H's result (#749), the corpus cost (#755, #766), the Pyodide build plumbing (#754), the
  fork rebased onto v3.14.2 (#760), the owned-set filter measured and parked plus the lifted-generator removal fix
  (#765), the manifests' second pass (#751). Option A (specialized forms) ruled deferred. Waits only on the
  address-reuse audit of the fork (flaky-CI janitor, branch `audit/address-reuse`), which lane 3 reviews and merges.
- **Lane 4: hub transport DONE.** PR 4c (#748), root L both sides (#753, host v0.3.0, result #758), the span on the
  event lane (#761), K1 (#763, host v0.4.0), then H1-H3 in `window-ml-host` behind `--features hub` (host #9, #10, #11;
  v0.5.0), rulings in session-mail 2026-10-19 and `SHELL.md` (#768); result `LANE_4_RESULT_HUB.md` (#769). Next: review
  of the K3 host PR.
- **K3** (the host's sandbox `Plan` compiler and the Landlock envelope; `PROGRAM_MANIFEST.md`, `EFFECTS.md`, #743, #744)
  is assigned to the Mimo generalist session (clone `window-ml-host-k3`, branch `k3/plan-envelope`), mid-implementation,
  lane 4 reviewing.
- **Red team**: the PR 4c pass posted with no finding; the `handlesIn` property pass is a non-blocking second-adversary
  pass after the owner lifted a stop that turned out to be a provider refusal, not the classifier (the redteam skill now
  says so, #767); then back to the shell-policy audit.
- **Specs amended by rulings since 2026-10-16** (all merged): root K's interpreted entrypoints and the 3-way Python
  model (#743), the OS sandbox `Plan` as a compiler over `EffectsData` (#744), the checkpoint primitive and receiver
  routing (#759, #762), the host's session events over the hub (#768).
- **Open decisions for Shane**: none. A desktop host's call events reach the caller only; `view` follows runtimes, never
  hosts (decided 2026-10-19, `SHELL.md`, revisable). #647 (site access, agent level) merged 2026-10-15 as ac417a98 and no longer waits on anyone.
- **Round 3 (opened 2026-10-19, [`ROUND_3.md`](ROUND_3.md))**: five lanes on this list: 5 the Pyodide build, 6 lane 1's four
  follow-ups, 7 `mode` removal, 8 the phone's pairing UX, 9 telling a run why its next call asks.
  Lane 5's build is window-ml #835 (2026-10-19; merged 2026-10-20 as b2bea587 after the janitor sanctioned one e2e rerun
  on the annotate-diff flake that fails on main too, the janitor's fix): the artefact lives as a RELEASE on the fork, `parawanderer/cpython`
  tag `pyodide-314.0.3-ml-8f6a50ab` (Shane's decision, 2026-10-19, after the fetch-hub precedent), pinned by tag, URL and
  sha256 in the consumer's dist manifest (#835) and checked before unpack. Measured: tarball 6.4 MB; an incremental
  `make all-but-packages` 47 s on an M4, a full build from a clean tree 448 s. The build is NOT reproducible (lane 5,
  2026-10-19: a clean rebuild matches the release's sizes, not its bytes), so the pinned sha256 proves the artefact is the
  one uploaded, never that it is what the fork's source builds; trust in it is trust in the uploader's machine, which is
  the fetch-hub precedent's standing too; 85 of 87 dialect vectors pass under wasm32, the two memory vectors end in
  `MemoryError`/`OverflowError` instead of `NotInDialect` because the per-cell byte count never fires for an
  allocation wasm32 cannot make (pinned as `WASM32_GAPS`; the fork's, lane 3's). Lane 3's diagnosis (2026-10-19) is
  larger than the two vectors: Pyodide builds CPython without pymalloc, so the cap, hooked on the RAW domain and the
  arenas, counted almost nothing under wasm32; the fix wraps the MEM and OBJ domains whenever the allocator is not
  pymalloc and judges a repeat's size before the overflow guards (`PYTHON_DIALECT.md`, the memory row; fork PR against
  `ml/restricted-mode`, merged 2026-10-20 as de165bb7, lane 5 verified it under wasm32 first). Re-pinned the same day:
  release `pyodide-314.0.3-ml-de165bb7`, 87 of 87 vectors under wasm32, `WASM32_GAPS` deleted, so the per-cell memory
  bound holds under Pyodide from #835 on. Its cost, measured by lane 5 on a noisy laptop (a million small tuples,
  minimum of four alternating rounds): a metered cell 0.31 s → 0.46 s, an UNMETERED one 0.15 s → 0.20 s, about 1.3 to
  1.5x either way, because the MEM/OBJ wrappers stay installed outside restricted cells. Open, the fork's (lane 3):
  whether the wrappers can be installed only for a restricted entry's extent, measured before it is claimed cheaper:
  natively no gain (2026-10-20, an ordering effect), so open for the wasm number only; the code sits on the fork's
  `ml/wasm32-wrappers-per-run`. Also found 2026-10-20: the native double count (the cap refused at half its number
  under pymalloc), fixed in parawanderer/cpython#3 (merged 2026-10-20, 7e400fbc), lane 4 verified it natively; no Pyodide rebuild. A hook on pymalloc before the first run brings the
  double count back; fixed by lane 3 in parawanderer/cpython#4 (merged 2026-10-20, b0bbaa5, lane 4 reviewed): a hidden
  name defers to the startup choice; no wasm32 change. Lane 5 next (2026-10-20): re-pin to b0bbaa5 with `pyodide` pinned
  exactly in package.json, then `LANE_5_RESULT.md`, then its clone removed; lane 3's predicate wiring lands on that pin.
  Per-run wrapping stays open.
  Lane 7 is closed: `mode` removed, #820 (merged 2026-10-19), [`LANE_7_RESULT.md`](LANE_7_RESULT.md) (#839); its narrower
  reading is ruled (2026-10-20): no cell auto-approves until the membership predicate plugs into `pythonCellInDialect`
  (`PYTHON_DIALECT.md`, "Membership replaces `mode`"). Wiring it is lane 3's (assigned 2026-10-20): the seam asks the
  Pyodide worker's `_restricted` predicate at compile time, every dialect vector through the seam, fail closed without the
  predicate, the per-cell cost measured in the Python bench first, a red-team pass before merge; lands after #835, lane 5
  reviews the build side. Lane 3's #865 (merged 2026-10-20, a96b1e3d) wrote the pinned-script section into `POLICIES.md`,
  and #859 (merged bb460720, Shane's by-hand merge) made merge-when-green run main's copy of itself. Lane 8 is
  closed: the phone pairs a desktop runtime, #814 and #816 (merged 2026-10-19), [`LANE_8_RESULT.md`](LANE_8_RESULT.md) (#840);
  its host-kind flag is DEFERRED (ruled 2026-10-20, `RUNTIME_HUB.md`): the design note
  [`LANE_8_HOST_KIND_DESIGN.md`](LANE_8_HOST_KIND_DESIGN.md) (#852, merged 3ca782c8) is the record, nothing is built.
  Lane 9 is closed: a call that asks says why when the policy that covered it is gone, #818 (merged 2026-10-20, 60d0c704;
  lane 4 reviewed; a red-team pass of 23 tests before merge, six failing first, each fixed in the PR: a page-forged
  `askWhy` on its own card, control and line-separator characters in labels, an unfiltered card label, a cross-origin
  archive-note consume; the resume note is a system message marked as the extension's), [`LANE_9_RESULT.md`](LANE_9_RESULT.md).
  Lane 6: items 2 and 3 are #822 (merged 2026-10-20, 4ca4201d), item 1 (the one shared loader patch with a per-cell lookup)
  is #830 (merged 2026-10-20, c789e647), item 4 was already closed by #772; the generalist reviewed both. Lane 6 is closed:
  [`LANE_6_RESULT.md`](LANE_6_RESULT.md) (#849, merged 73e57802), clone removed.
- **Unassigned**: the host's hub transport is no longer; left is the typed-node policy tree (the derived breadth). Lanes
  6 to 9 took the rest of the old list (2026-10-19 to 2026-10-20, above).

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
  which has 16 GB; CPython's own suite runs `-j1` or `-j2`, never `-j6`. While iterating, run a genre (`npm run test:core`),
  as AGENTS.md says, and the full `npm test` only before a commit: the Jetsam report of the crash counted eighty `node`
  processes at 12.8 GB beside the 14.9 GB Python worker, every lane's full suite at once. A machine-wide cap on concurrent
  full suites is the flaky-CI janitor's first item (`~/git/window-ml-flaky/tmp/HANDOFF.md`). Lane 3's CPython suite run on the restricted-mode fork sat on a worker that grew to 14 GB and took every
  session down with it; the session that started it died, the run did not. A run whose owner dies is anyone's to kill.
  The write-up, with the Jetsam evidence and how to read it, is the shared memory
  ~/.claude/projects/-Users-sb-git-window-ml/memory/trap-laptop-oom-runaway-test-suite.md (outside the repo).

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
  green, no test was removed and no review is unread. Spec-only PRs merge the same way. A review that asks nothing still
  refuses until the operator names it read: `--read <id>` (the janitor's #853, merged 2026-10-20, 5c91dbdb; the refusal
  prints the ids; the tool never parses a body).
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
