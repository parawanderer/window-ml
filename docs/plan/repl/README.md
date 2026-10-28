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
11. **New user-facing strings ship without Shane's approval** (Shane, 2026-10-27). An agent writes a string that meets the documented rules and ships it; Shane reports any that offend later, as a separate fix. Memory `feedback-ui-strings-no-approval`.

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
5 s drain). **Lane 4: CLOSED 2026-10-20** (Shane): result [`LANE_4_RESULT_HOST_ROUND3.md`](LANE_4_RESULT_HOST_ROUND3.md)
(#878, dae6278e); its clones are clean with nothing unpushed and their removal is Shane's (the lane's classifier refused it).

**Added 2026-10-15 from lane 1's root A findings: J. whole text captures in the value store.** The run's pointer store
keeps only the text the model saw (`fetch_url` stores the first few thousand characters of a body), and only TABLES are
kept whole (`POINTER_VALUES.md`, slices 5 and 6). So "the operation goes to the value" has no value to go to for a text
body, and a code client (a Python cell, a survey's pipe) computes over a prefix. J is a root (it extends the value store
the way the table slices did), taken by the fresh lane 1 session on 2026-10-15 (`POINTER_VALUES.md`, slice 9): a fetched text body past its preview is
now stored whole. A `value` answer for a capture that was NOT stored (a page-hosted run's fetch, a body past the fetch's
read cap, an `exec` or `python_exec` output) still carries `truncated: true` and the full size, and every client
surfaces it.

## Status (2026-10-19)

**Freeze, 2026-10-23 (Shane, day 5 of the usage week at 81%): land, then stop, "for now".** Every builder finishes the
one item in hand and goes idle: root-k finishes (d), the Settings registration page, and does not start root 3;
python-cancel writes `LANE_PYTHON_CANCEL_RESULT.md` and stops; site-access rebases #1046 on #1051, marks it ready and
stops (done: merged de645ea3), PR 4 was parked for Shane's strings; RULED 2026-10-27 (Shane, confirmed in the coordinator's session): new user-facing strings need no approval, an agent writes one that meets the documented rules and ships it, and Shane reports any that offend later as a separate fix; PR 4b's strings approved, 4b started. The Chat Page lane is paused. The red team and the janitor run on free models
and continue. The janitor reviews every open code PR in dependency order (#1052, #1042, #1046, #1048, #1055, #1041, #1068, #1051, #1045, #1063 are merged): #1070; the coordinator reviews result files and specs only. The lanes resume when the week resets.
On 2026-10-24 the janitor's fix for #1051's P2-gate flake (#1081, test only) went to the python-cancel lane, the
test's owner, to review and merge (the janitor built it, root-k found it); it found the fix clean, Shane posted the
review. #1081's CI then showed main red: the `test (node 26)` job fails three #1068 tests in `tests/redteam.test.js`
(the page cannot list, add or remove a manifest; a stored manifest never reaches a page; a page cannot mint `origin`
proposed or person) with a TypeError reading `global` on the extension page's positive-control add. First recorded
as a flake; root-k, e3 and the janitor each measured it deterministic: #1063 made an extension page's add take its
pin from the host (`checkDraft` through `withShell`), so with ml.sh off the handler answers `{error}` and no `data`,
and #1068's positive controls add under `baseConfig()` with no host. The two landed within a minute of each other
without a shared CI run (a35d7363 and 443c9336 failed, both of #1081's runs failed; cde627ce's unit job "passed" as
the prose-only leg, running nothing). Ruled 2026-10-24: e3 writes the fix, test only (the three controls get a faked host, as #1070's pins
already do; assertions unchanged), the janitor reviews, e3 merges; root-k, whose #1063 caused it, touches neither.
FIXED the same morning: #1084 merged b73dc013 after the janitor's review (the three controls faked a host; one new
pin: an extension page's add with ml.sh off answers `{error}` and stores nothing); main's unit job passes on it. #1070
rebased onto it (12 pins green) and is with the janitor; e3 merges it. #1081 MERGED 48bee329 (python-cancel, after
updating onto the fix; no test line removed); that lane is frozen again.

**Freeze exception, 2026-10-24 (Shane).** The root-k lane alone resumes, to spend the week's remaining budget on the
most useful open item: first the evidence-run gap (a lying manifest that claims an output and exits 0 having written
nothing passes the evidence run), measured failing-first, fixed in its own PR, the janitor reviews, root-k merges; then
(c2) library manifests only if time allows. The other left items stay parked. Rule 10 holds: the red team pins any new
surface in its own PR stacked on root-k's, merged after. Every other lane stays frozen.
The gap MEASURED the same day (failing-first, fake host: a recorded `mytool out.txt` creates the file; a draft calling
it a reader re-runs exit 0 under `write:none` and passes, since the host reports no denials and under `write:none` the
root cannot change). FIX in #1089 (open; `@exec,@security,@ui,@docs`): the evidence run checks the RECORDED call; every
non-flag operand and `--flag=value` value is hashed by spawn-then-discard before the call starts and after it is done,
and a changed one fails evidence without re-running anything. The pass message claims only that ("no named operand of a
recorded call was created, modified or removed"), the card names what the check cannot see (a write inside a directory
operand, a file no argument names, a secret path compared by existence only), both pinned. The closure is host-side
denial reporting (`done.denied`), a left item in [`ROOT_K_RESULT_2.md`](ROOT_K_RESULT_2.md) for Shane to post on the
host repo. RULED on opening: #1089 edits three of the red team's test files, so it merges only after e3 has posted on
the PR that each edit keeps its property (a narrowed one is reverted and e3's own version lands stacked after), and
after the janitor's review of the rest; e3 then pins the residuals in its own file, stacked and merged after.
#1089 MERGED 70fdd57d, both gates recorded on the PR (e3: each property kept; the janitor: no finding); green on the
third run, the two before it the P2-gate flake in `tests/redteam-python-sandbox.test.mjs` that #1081 narrowed and the
janitor's #1098 (test only, MERGED 4dc0c5ff 2026-10-24) accumulates with a deadline. e3's residual pins are #1094, retargeted to main, e3's
to merge. Root-k moves to (c2) library manifests, the last item of its exception.

(c2) RULED 2026-10-24 on root-k's measurement of the pinned core (the four rulings and the fork finding are in
`READONLY_LIBRARY_MANIFEST.md`, "The runtime import loop"): the source is read as a recorded `cat` call, spawn then
discard; nothing executes before the word, the card's admission is a static MODULE-SHAPE rule and the load plus the
post-load global check run after approval as enforcement; the stored entry is the snapshot of the approved bytes; global
scope only, removal restarts the worker. Root-k files the "load-run objects stay owned through reset" finding on the
fork today. The red team writes the pass in its own file; the janitor reviews the code.

RULED 2026-10-24 (Shane): `navigate` is a credentialed rendered fetch in interactive mode; one consumer, one consent
scoped by origin, one free tier (`POLICIES.md`, "Navigate is a fetch: one read, two modes"). UNASSIGNED, after the
freeze: a small build in the run host and the fetch gate with a red-team pass. ASSIGNED 2026-10-24 (Shane lifted the
freeze for one next session, the coordinator's pick; the root-k lane is CLOSED, its left items recorded above) to
`[window-ml security] Site access`, which owns the fetch gate and consent and neither found nor probed anything here;
the janitor reviews the code, the red team's pass (nine properties, briefed) is a PR stacked on the lane's branch,
merging after it. The worked example and the demo site follow it, not with it.
#1120 MERGED 9254b385 (2026-10-24): the janitor reviewed it (no finding); the coordinator reviewed the spec text (the
"As built" block narrows the ruling at every point, no finding; the allow-row as-you hole it raised was corrected first,
#1116). Not built: the policy page's rows show no facts yet, `interactive` included; that is #1122 (`@agent,@ui`) and
needs Shane's design. The red team's stacked pass now targets main, merging after the janitor's review. The lane moves
to site-access slice 3 PR 3. The worked example and the demo site are the next item here, UNASSIGNED.
Extended the same day: the worked example and acceptance test (a task on another site scoped by a proposed policy),
needing a multi-rule `propose_policy`, an `act` consumer that folds in the self-approval origin list, and an approved
policy counting as the person's word under `crossOrigin: false` (`POLICIES.md`, "Worked example and acceptance test").
UNASSIGNED, after the freeze, after the navigate build.
Extended again the same day (Shane): a fourth rule, one button on one page (`/user/approvals`: only "Approve This
Draft"), ruled as a deny on `act` written on what is allowed, matched on the accessible name the worker resolved at the
click; plus a demo site with a redirect-into-`/admin/` button and a server-side log, so the acceptance test asserts
what happened (`POLICIES.md`, same section, "Extended the same day"). Same place in the order.
Filed as #1102 on window-ml (issues are disabled on the cpython fork; moving it there is Shane's). The red team's
#1094 (operand-check residual pins, base `main`) MERGED a988fb6f after a flake rerun. The #1093 red-team pass is #1103
(open, `@exec,@security`), with the cost measurement in it: `(\d{3})+` on 100k non-matching chars charges 2,735 units
(linear); `(\d{3})+b` on 100k digits charges 273M units, over the 3M budget, so the loosened bound is PRICED; the
charges are pinned as numbers.
#1103 MERGED 8f1137b5: the #1093 widening is now covered by its pass, after the fact; the miss stays recorded.
The red team's #1109 (MERGED 9cd722ef 2026-10-24, `@python,@security`) turns the three KNOWN OPEN Python-regex
backtracking escapes of the shipped core into failing-first todos with the harness that sees them; the fix is on the
fork (#11), shipped by the core rebuild (#1119), with which e3 turns the todos into plain tests.
Root-k's (c2) build is #1110 (open, `manifests/library-tier3`, `@exec,@security,@docs,@ui`): tier 3 libraries to the
four rulings, with an "As built" list in the spec naming where it narrows them (64 KiB cap; the already-importable
precheck is a shape op over an empty source; annotated assignments refused for 3.14's `__conditional_annotations__`;
a builtin admitted only as an admitted name; removal restarts only the workers handed a library; "disk differs" on the
page is a left item). Every difference narrows, so no new ruling. The janitor reviews its code; the red team's pass is
a PR stacked on the branch, merging after it. Both assigned 2026-10-24.

e3's pass is #1129 (2026-10-25, `@agent,@security`, test-only, off main; the janitor reviews). Twelve properties; two
findings, both the security lane's (told the same day): (1) KNOWN OPEN, a commit between turns with no hold standing is
never judged (a failing-first todo in #1129); (2) a layering split pinned as the defended refusal: the arrival's consent
reaches the host's prompt but not the `FETCH_URL` choke point, so an allow-row arrival's uncredentialed read cards.
RULED into `POLICIES.md` ("Narrowed 2026-10-25"): the spec stands at the choke point, navigation only; widening is
Shane's. The lane's fix PR lands with its own tests; e3's todo turns plain after.

#1131 MERGED dc5a301b (2026-10-25, security lane, `@security,@agent`): both #1129 findings fixed in one PR, its own
tests (`tests/nav-arrival-host.test.mjs`), e3's file untouched (rule 10). The tab is watched between turns; any page
the run's judge has not spoken on is judged before the turn's first tool, fail closed after an eviction; an `allow`
arrival consents navigation only (`navOnlyOrigins`), so the read cards. The janitor reviewed (no finding). As-built
block in `POLICIES.md` under "Narrowed 2026-10-25". Order ruled: #1131 before #1129, since #1131 turns one e3 pin red
and only e3 edits e3's file; e3 rebases #1129, swaps the two choke-point pins for card pins, flips the todo, re-pings
the janitor. RULED 2026-10-27 (Shane, in the coordinator's session; [`POLICIES.md`](../../spec/POLICIES.md), "Ruled
2026-10-27"): the card's "why" line is a fixed string ("Your policy lets the run go to <origin>. Reading pages there is a
separate permission: …"); the start-origin split closes narrow, the gate carding the read with a start-origin variant of the line
("The run started on <origin>. Reading pages there once the tab has left is a separate permission: …"), the choke
point unchanged; the widening stays unassigned. The security lane builds both with its tests (`feat/navonly-read-card`, built
the same day). ORDER ruled the same day, since e3's file is on main and the fix turns its start-origin pin red in the
lane's PR (rule 10: no finder's commit in a builder's PR, no red base merges): (1) e3 turns the pin into a failing-first
card pin marked todo, test-only on main, first; (2) the lane rebases and merges green; (3) e3 flips the todo plain in
its file. The janitor reviews each. DONE 2026-10-27: (1) #1166 MERGED 58c3e7b3 (janitor's post-merge finding, same day: the uncredentialed read's "nothing runs" invariant sits only in a todo's body; sent to e3 as a plain row to pin beside the as-you one, the todo's target stays the lane's fix); (2) #1157 MERGED 941e4ce7, both
verified; (3) e3's flip is next, in its file.

#1129 MERGED 9133ec92 (2026-10-25, e3, `@agent,@security`, test-only, `tests/nav-navigate-redteam.test.mjs`): rebased
on #1131 in the ruled order; the between-turns todo is a plain passing test, the two choke-point pins are card pins,
no todo left. The one `CHOKE_REFUSED` pin that stays is the start origin's uncredentialed read (the lane's open
gate/choke split, same default). The janitor's first review was of the pre-rebase file and said so; its correction
against the merged head (no finding) preceded the merge. The navigate red-team pass is CLOSED; nothing of e3's on
navigate is open.

#1110 MERGED 7891e866 (2026-10-24): the janitor reviewed it (no finding); one test-only fix after the review
(the Settings page's test waits on conditions, not a sleep). Root K (c2) is BUILT; root-k's clone is removed. Open
from it: the red team's stacked pass (e3, its own test file, merging after), #1102 (owned-through-reset, awaiting
Shane's fork-or-not call), the "disk differs" page state, and the Linux Landlock evidence run. Root-k asked the same
day which to take next; RULED in `READONLY_LIBRARY_MANIFEST.md`: the disk check is a button (a recorded read, result
described, store untouched), workspace scope is parked until a build needs its ruling. Whether root-k spends this
week's budget on the button is Shane's: the freeze exception covered the evidence-run gap and (c2) only.

#1118 MERGED 8832036d (2026-10-24, e3, `@security`): the rule-10 pass on the tier 3 import loop, two test files of
e3's own, result MISS. Eight properties pinned (nothing runs before approval; a load whose globals disagree is not
stored; the name precheck neither executes nor shadows; an out-of-root or secret path is refused before the card; the
64 KiB + 1 source; the stored bytes are the snapshot; removal restarts the holders; the #1102 leak is unreachable from
an admitted module). Probed and not gotten: `libraryShape` does not walk a def's body, so a listed function can hand a
cell `math.sqrt` or an inert `open`; every call path is refused under the gate. The janitor reviewed it (no finding).
With it root K's stacked pass is done; left from #1110 are only #1102, the disk-check button and the Landlock run.

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
- **Open decisions for Shane**: none. His proposal of 2026-10-21, the host answers "which session owns this CPU process" for groups a session REGISTERS with it, he RULED YES on 2026-10-23 in the narrow shape written (`SHELL.md`, after "The boundary"), as he did `propose_policy` widening to `sh` with the probes as its prerequisite kept (`POLICIES.md`); both are the `[window-ml root-k]` session's to build. A desktop host's call events reach the caller only; `view` follows runtimes, never
  hosts (decided 2026-10-19, `SHELL.md`, revisable). #647 (site access, agent level) merged 2026-10-15 as ac417a98 and no longer waits on anyone.
- **Round 3 (opened 2026-10-19, [`ROUND_3.md`](ROUND_3.md))**: five lanes on this list: 5 the Pyodide build, 6 lane 1's four
  follow-ups, 7 `mode` removal, 8 the phone's pairing UX, 9 telling a run why its next call asks.
  Lane 5's build is window-ml #835 (2026-10-19; merged 2026-10-20 as b2bea587 after the janitor sanctioned one e2e rerun
  on the annotate-diff flake that fails on main too; the janitor's fix is #887, 2026-10-20: the approver outlived the wait): the artefact lives as a RELEASE on the fork, `parawanderer/cpython`
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
  name defers to the startup choice; no wasm32 change. Re-pinned to b0bbaa5 the same day: window-ml #873 (merged
  fecd6abe; release `pyodide-314.0.3-ml-b0bbaa52`, `pyodide` pinned exactly), the pin lane 3's predicate wiring lands on.
  **Lane 5: CLOSED 2026-10-20**: [`LANE_5_RESULT.md`](LANE_5_RESULT.md) (#874, bcbb6543); build trees and clone removed.
  Left, nobody's: nothing. Per-run wrapping is fork cpython#6 (merged a315999c, lane 3's wasm number in the spec's memory row), the hooks verified at every entry is cpython#7 (merged 7c40b038; #8 is comment only), main's core is pinned to 7c40b038 by #928 (merged 07a4314d, lane 3, 2026-10-21) after #918's `-r2` re-pin (merged 42d5bec9), and the dist manifest's mismatch throw is tested in #911 (merged e9c95c81, lane 10).
  **The membership wiring landed 2026-10-20**: window-ml #880 (lane 3, merged b791311d) runs a `python_exec` cell unasked
  only inside the dialect, under the fork's gate. Its red-team pass (09:40Z mail) requested changes: a function defined
  inside was copied back and ran ungated on the full path (reached `os` and `ml`), captured builtins crossed back, and a
  refused try's stdout was not dropped. Ruled in [`PYTHON_DIALECT.md`](../../spec/PYTHON_DIALECT.md), "What an inside
  run may leave behind is data, never code", in two layers. Layer 2, the copy-back, is in #880: data only, checked
  recursively (the container residual was real), not-data makes the cell outside, no aliasing of a non-data value under
  a new name (#896), the return value data only (#898), imports admitted as themselves. The red team's second pass
  cleared it (12/12 alias shapes); the janitor's build review found the numpy/pandas branches were `isinstance`, not
  exact type, fixed at 249ccad5. Layer 1 is fork parawanderer/cpython#5 (lane 3, merged 77376876, Shane's by-hand
  merge at the janitor-reviewed head): a `CO_RESTRICTED` frame entered outside a run refuses (R over G), the check-time
  line fix, and, found by fixing it, the check now parses the cell as itself (the wrapper's indent had been adding four
  spaces to multi-line strings). Re-pinned by #901 (merged 1334d623; release `pyodide-314.0.3-ml-77376876`, sha
  3273be76…): line corrections gone, the copy-back admits a cell function whose every code object is `CO_RESTRICTED`,
  walking defaults and closures. CORRECTION 2026-10-21 (lane 3): that release packed the OLD `restricted.py` (the recipe's
  stale install stamp, found while building the per-run branch), so its Python side was a9f034a2's; a `-r2` release
  from a stamped, witnessed recipe re-pins it (#918, merged 42d5bec9, 2026-10-21: recipe stamp, zip witness, two wasm tests), then #928 (07a4314d) pins fork 7c40b038. Red team's post-merge read holds on every route; stated residual: approved code can
  strip the flag, and every shape that does names `__code__`/`co_flags` on the card (#903). Lane 3's #906 (177dde76)
  adds the red-team rule that every probed shape ends as a committed test or a stated reason. Lane 3's extra pin clone
  removed; lane 3 is free.
  Lane 7 is closed: `mode` removed, #820 (merged 2026-10-19), [`LANE_7_RESULT.md`](LANE_7_RESULT.md) (#839); its narrower
  reading is ruled (2026-10-20): no cell auto-approves until the membership predicate plugs into `pythonCellInDialect`
  (`PYTHON_DIALECT.md`, "Membership replaces `mode`"). Wired by lane 3 in #880 (above, merged 2026-10-20). Lane 3's #865 (merged 2026-10-20, a96b1e3d) wrote the pinned-script section into `POLICIES.md`,
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
- **Round 4 (opened 2026-10-21, [`ROUND_4.md`](ROUND_4.md))**: lane 10 (Sonnet) the dist mismatch throw in CI and #882;
  lane 11 (Opus) host #19, the orphan's deadline-kill `ended` record, then the typed-node policy tree's DESIGN NOTE (no
  code until ruled; the note is #920, ruled 2026-10-21 into POLICIES.md "The tree, ruled" and SHELL.md "An optional
  fact is sent as `null`": the lifter first, then the number is measured on policies models propose, nothing else of the
  tree before that; both consumers' proposals are measured as text from a bench prompt, no tool widened; widening
  `propose_policy` to `sh` is a later decision of Shane's); lane 3 the per-run wrapper's wasm number. Lanes 6 to 9 took the rest of the old list (2026-10-19 to
  2026-10-20, above). Nothing was unassigned then; the three findings of 2026-10-22 at the end of this section are.
  Lane 10 is closed: #909 (1c3a30da), #910 (96f823ce), #911 (e9c95c81), the seam complete with host #20;
  [`LANE_10_RESULT.md`](LANE_10_RESULT.md) (#923, d6ccae00). Lane 11's round-4 items are closed: host #20, #21, #22
  (the `ended` record, five causes; the private-sweep fix), #913, #920, #921; [`LANE_11_RESULT.md`](LANE_11_RESULT.md)
  (#922, eafcc2b3). Lane 11 stayed open on the tree's next item, ruled 2026-10-21 (#921, #924): the lifter, then the
  `fetch` and `sh` bench tasks measured as text, with the corpus committed (#925); the lifter's test may hold a tree evaluator under `tests/` (#927). MEASURED 2026-10-21 (#934, b8030ae8): the lifter covers 63% of `fetch` and 45% of `sh` proposals, below the predicted 80-95 and 55-75; one fail-open (an ALLOW over a `null` fact), ruled in `POLICIES.md` (an ALLOW over an unknown never fires); lane 11's follow-up MERGED (#961, c1d1f6ed): the null rule in the realm and the tree verdict, `propose_policy`'s details text, the `fetch` rerun (lifted 63% to 84%, every lifted policy right; in `POLICIES.md`); left there: model proposals not yet appended to `policy-corpus.json`, `riskyRegex` not widened. ASSIGNED 2026-10-21 (#963): the host-side change of the null ruling, `repoConfigRunsCode: false` when no repository encloses `cwd`, is lane 11's, a window-ml-host PR, the janitor reviewing after #957; the two `sh` answers it wins back are in #961's rescore. Built as window-ml-host #23, MERGED 2026-10-21 (fb436349; the janitor reviewed at e12941d), with the commondir residual ruled into it (#965); host #24, MERGED 2026-10-21 (afba286c, f1b0bfd with the janitor's one finding applied: the still-running check tells a timeout from a panicked thread), is the warden exit-2 test queued from #22. #973 (e7ab5488) carries `false` into the scorer's non-git calls, `sh` rescored 29 of 53; it merged before its named review was posted, and the janitor's review of it is post-merge. **Lane 11: DONE** (2026-10-21): [`LANE_11_RESULT.md`](LANE_11_RESULT.md) (#978, f34d3555; reviewed by the coordinator), clone removed. Left, named there: model proposals not appended to `policy-corpus.json`, `riskyRegex` not widened, `sh` in `propose_policy` only if Shane widens it, the two-profile residual of the `ended` record; and from the janitor's post-merge review of #973 (clear, 2026-10-21): no scorer vector is a git call outside a repository, so the host's `false` for that shape is untested in the panel. **Lane 12: DONE** (2026-10-21): [`LANE_12_MEMORY_FAIL_CLOSED.md`](LANE_12_MEMORY_FAIL_CLOSED.md); parawanderer/cpython#9 merged at 0169c4fd (block table fails closed, verify on every approved return, the stacked-wrapper C test; reviewed by the janitor, the red team found it); the re-pin and the `verify-cost` notebook in #957, merged c03e1344 (the janitor reviewed): about 74 ns per approved C call quiet, 1.36x on a bare loop of approved C calls, about 4% at the upper quartile of 1,702 real cells; as built in the `memory` row. CLOSED 2026-10-21: [`LANE_12_RESULT.md`](LANE_12_RESULT.md) (#966, 4bce7b08; reviewed by the coordinator), clones removed. Left, named there: the native column not retaken quiet. Done since: the quiet A/A retake with the load average stamped (#977; raw in `notebooks/python-dialect/wrapper-bench/`); the fork branch `lab/mem-recheck-gate` (9c7e5fb8) deleted 2026-10-21 on Shane's word, its design kept in [`LANE_13_PROBE_NARROWED.md`](LANE_13_PROBE_NARROWED.md). **Lane 13: CLOSED ON THE NUMBER** (2026-10-21): [`LANE_13_PROBE_NARROWED.md`](LANE_13_PROBE_NARROWED.md) kept as the design; 4% at q75 on real cells is no widening's worth, and the 1.36x is only the bare loop; reopens only if a real workload shows that shape, Shane's call. **Lane 3: CLOSED 2026-10-21**: [`LANE_3_RESULT.md`](LANE_3_RESULT.md) (#932, 84ec012b): fork #6/#7/#8, #918, #928, the wasm
  numbers, the tracemalloc repro refused on 7c40b038. Left, named there: the red team's post-merge read of fork #6 and #7 and
  its column-shapes PR (the red team's); the superseded fork branch `ml/wasm32-wrappers-per-run` (Shane's to delete); the
  mechanism of the slowdown without per-run unwrapping, since settled by the janitor (2026-10-21, one extra indirect call per allocation, about 40 ns; in the memory row). Fork #7 merged with no review on it
  (lane 3 reports Shane allowed merging without review mid-round; relayed, so Shane confirms).
- **Open findings with no lane (2026-10-22).** Catalogued by the janitor as `{ todo }` tests on main, brought by the
  site-access session (`2dfb7129`), which is taking the MAIN-world group itself. Every REPL lane is closed, so these have
  no owner; who takes one is Shane's call. Whoever does: the finder neither builds nor reviews the fix, and the fix
  lands with its todo test turned on, failing first.
  1. `tests/redteam-python-sandbox.test.mjs:302` (P2-handle): the cancel at the end of `wrapUserScript`
     (`python-runtime.ts`) walks `asyncio.all_tasks()`; a `call_soon`/`call_later` Handle is not a task, so its callback
     runs after the result has returned. Python side of window-ml, not the fork; lane 3 or 12 would have held it.
  2. `tests/redteam-python-sandbox.test.mjs:315` (P2-escape): `_ml_dumps`'s `default=` calls `str()` on the cell's object
     under `except Exception`; a `BaseException` raised there ends `wrapUserScript` before the cancel runs.
     BOTH FIXED by #998 (676bf355, merged 2026-10-23): the cancel sweeps `all_tasks()` and every `asyncio.Handle`
     `gc.get_objects()` reaches, and runs before the epilogue; both todos are plain tests there. RULE 10 NOT HELD: #998 was
     built by the janitor, which found both gaps, and merged with no review posted; the red team's review of #987 at
     0abddc51 (2026-10-23, named by Shane) checked main's sweep after the fact and found it holds on every scheduling
     route. #987 (the site-access session, Sonnet) was since tests only, the route matrix guarding the sweep, reviewed
     clear, MERGED 2026-10-23 as 8c312e6a. The red team's review names two classes the sweep does not reach, now
     failing-first `{ todo }` tests on main in `tests/redteam-python-sandbox.test.mjs` (six todos there: the red
     team's five plus `scheduleCallback`), ASSIGNED 2026-10-23 on Shane's word (his session) to a new session
     `[window-ml python-cancel]` (Opus): [`PYTHON_CANCEL_GAPS.md`](PYTHON_CANCEL_GAPS.md); the janitor reviews; the red
     team found both and builds and reviews neither: a
     callable handed to a kept JS scheduler (`setTimeout`, `queueMicrotask`, `Promise.then`) makes no Handle; a started
     task kept on a module keeps a live `_coro` a later cell can `throw` into. Also: the two existing `finally` tests
     never started the coroutine, so they would have passed with the cancel deleted; #987 reshaped them.
     FIXED 2026-10-23: #1051 merged 5dd5a1fc (reviewed by the janitor, two rounds), result
     [`LANE_PYTHON_CANCEL_RESULT.md`](LANE_PYTHON_CANCEL_RESULT.md) merged 7fbb8eca. The spend cancels every task and
     turns the loop up to 8 rounds, a task still pending refuses the cell's result, named; the cell gate
     (`src/python/cell-gate.ts`) hooks Pyodide's three doors from Python to JS before `lockdown()`, once per realm,
     non-configurable, and a revoked callable that fires is a silent counted no-op reported on the next cell. Order:
     spend, then revoke (ruled). The six todos are plain tests; gate reverted alone fails 21 tests, spend alone 1.
     Left, named in the result: two todos through `pyodide_js` that turn plain when #1046 lands; drops after a run's
     last cell unreported, and a task that never yields hangs to the run's timeout, both unowned. Lane STOPPED
     2026-10-23 under the freeze; clone removed. #1046 landed the same day, so the two `pyodide_js` todos can turn plain;
     unowned until the week resets. RESUMED 2026-10-27: the lane picks up the two leftovers in order (the last cell's
     drops reported, a run-log fix with its test; then the never-yielding task, design note to the coordinator before a
     build), plus the regex-cost Python port named to it in fork #11 (the two `pyodide_js` todos were already plain
     through #1046 itself). The janitor reviews each PR. MERGED 2026-10-27: #1139 (cf8cc300, the drops after a turn's
     last cell reported, janitor no findings); #1148 (c6a3808f, a clone symlinks `pyodide-core` too, since the stock core
     skips 324 of the python genre's 530 tests). RULED 2026-10-27 on the never-yielding task, in
     [`PYTHON_CANCEL_GAPS.md`](PYTHON_CANCEL_GAPS.md): refuse, not interrupt; one budget for the whole spend; the C-level
     case keeps the kill, named; cores enumerated; e3 probes the hook's reach after the merge, in its own file. FOUND the
     same day by the lane in its own #1051 cancel: an approved outside-dialect cell rebinds the wrapper's globals
     (`_ml_cell_revoke`, the round count) and keeps a callback alive past the result. RULED the same hour (pins 7 to 12
     there): the cancel and its bound become a closure built at boot over captured callables, called from JS in a
     `finally`; the full worker keeps the wrapper path; the rebind row is the lane's, the rest e3's after the merge. CORRECTED by the lane the same day, ruled the same hour (pins 13 and 14): its probes first ran on stock Pyodide and reproduce on the fork core, so the cores test names both; and a cancel called from JS after the result leaves a gap the cell's queued handles run in (9 of 55 rows), so the script and the cancel are one coroutine, the `finally` inside it. FOUND
     2026-10-27 by the lane, outside its brief, raised with Shane, unowned: a worker-hosted run's own Pyodide worker
     (`run:<id>`) is never terminated (`PY_DELETE_RUN` empties the namespace; the offscreen document is never closed), so
     every run that used Python keeps a realm alive for the browser's lifetime. ASSIGNED the same day by Shane to the lane,
     confirmed to the coordinator 2026-10-27: idle reap by default, late drops reported at the shutdown, and the model
     may ask for its worker to be kept (Shane: a Python process should be able to run overnight). Its own PR,
     `@python`; the keep is a new thing the model can ask for, so it gets a red-team PASS by e3 after the merge, in e3's
     file, not a note. The lane's order: last-cell drops, idle reap and keep, the never-yield bound, the regex-cost port. MERGED 2026-10-27: #1142 (89a8a1ef, the idle reap and the keep; spec text in `docs/dev/python-sandbox.md`, "The idle reap"; green on a rerun of the site-access flake the lane measured on main, 5 of 10, now the janitor's). e3 briefed the same day on the keep's red-team pass. #1150 (the never-yield bound, pins 1 to 14) MERGED 2026-10-27 afcbe2b9, janitor review clean; spec text `docs/dev/python-sandbox.md`, "Where the cancel runs"; the lane's rows under "P2-bound" in `tests/redteam-python-sandbox.test.mjs`. e3 briefed the same day on pins 6, 12, 13 and 14, in its own file. Left of the lane's work: the regex-cost Python port, in the cpython fork with its own cost model for Python's engine (the TS constants are V8's); design note to the coordinator before a build. RULED 2026-10-27 (`PYTHON_DIALECT.md`, the regex paragraph): one budget through `_restricted.charge(n)`, a cap per search refused; OPEN as cpython#13 + window-ml #1170 (corpus `regex-cost.json`, 8 units/step measured, margin 1.46; the janitor reviews both, the fork's owner is not live). TWO CALLS FOR SHANE, tracked here and in that spec paragraph, measured in `notebooks/python-dialect/regex-cost.ipynb` (#1170): (1) DEFAULT_BUDGET's 15M steps is ~2.1 s on the fork core in Pyodide (median 7.1M steps/s), not the ~1 s the fork's comment states; restate the budget, or not. (2) `findall` over ~1M characters of ordinary text is refused, 20 to 100x over its real cost, by the shared bound's per-start pessimism; loosen it, or not. DECIDED 2026-10-27 (Shane): (1) 15M stays, the fork's comment is fixed to the measured figure in cpython#13; (2) the bound stays as is, revisited only if the bench shows models hitting it. Both closed. cpython#13 MERGED 2026-10-27 at 2e41d920f5 on `ml/restricted-mode` (janitor review: `re.sub`/`subn` priced the replacement, 20.8 s measured, fixed at db7b192065 before the merge; 174/0 on the janitor's build), verified. DECIDED 2026-10-27 (Shane, in the coordinator's session): rebuild now from that commit; the quiet bench re-run gates the pin bump, not the build; a materially different 15M-step figure comes back to Shane. MEASURED 2026-10-28 by the pyodide session on the core built from 2e41d920f5 (tarball sha256 054b8ea8…), quiet machine (load 2.4): median 9.35M steps/s, 15M = 1.60 s, against the committed 7.07M/s = 2.12 s taken at load 9 to 14; old core ca282158 and new back to back at load 6 to 9: 8.19M/s = 1.83 s and 8.78M/s = 1.71 s, so cpython#13 does not slow the step loop and the move is load. On that core locally: python genre 536/0/7 todo, wasm vectors 98/0, e2e python-stream 2/2. DECIDED 2026-10-28 (Shane): the pin PROCEEDS on the 1.60 s figure (the back-to-back run shows the move is load, not the core; the budget decision stands; the fork's comment may say 1.6 to 2.1 s depending on load in a later fork PR, no rebuild); the release permission granted in the pyodide session. Pin PR #1202 MERGED 2026-10-28 at 9233b8d1 (janitor review: every pin field checked, its regex probe run inside the downloaded core, every shape refused under 5 ms), verified; main pins fork 2e41d920 (release `pyodide-314.0.3-ml-2e41d920`); the pyodide session's clone removed. e3 pins the cost rows against it. The fork's budget-comment wording landed as cpython#14 MERGED 2026-10-28 at c0132c1f (an Opus subagent of the coordinator, on Shane's word; comment-only in `Lib/restricted.py` and `Modules/_restrictedmodule.c`, 1.6 to 2.1 s depending on load with both rates; janitor review clean; no rebuild, main's pin stays 2e41d920), verified. Closed. Brief: `~/git/session-mail/window-ml/20261027-2042Z-repl-specs-to-pyodide-core-rebuild-from-cpython13.md`. The rebuild (the `[window-ml pyodide]` session re-pins `tools/pyodide-dist.json`, which still names ca282158c5); the janitor's #1170 bench ran at load 9 to 14 on 15 CPUs and wants a quiet re-run before the core release; then e3 pins the cost rows. #1170 MERGED 2026-10-27 at 7c719cf7 (janitor review: no finding, 12/12), verified. FOUND 2026-10-27 by the lane: a raising `settrace` function unsets tracing, so the spend's bound degrades to the kill after its first exception (5013 ms measured); RULED (pins 18–20 in PYTHON_CANCEL_GAPS.md): the spend moves to `sys.monitoring` in its own PR first, `sys.monitoring` is guarded universally, the pins-15–17 fix rebases on it, e3 pins the case after. #1182 (pins 18 to 20, step 2b) MERGED 2026-10-28 at 42237e59, janitor review clean, verified; the sha forwarded to e3 for its P2 row. Next from the lane: the janitor's non-blocking note (a guarded `sys.monitoring` call made from C emits no CALL event; the spend checks its tool's events, name and callbacks after each round) #1208 MERGED 2026-10-28 at d698cc0a (a post-turn check of the tool's mask, and a trace or profile function set during the spend read and cleared, both refused with their reason; no rows in it, rule 10; the lane's measured rows went to e3 as a patch path for its file; janitor re-review clean), verified; e3 flips its rows after it. Then the hunt-2 fix (pins 15 to 17), rebased on d698cc0a: #1221 MERGED 2026-10-28 at 933e5e48 (the loop's queue cut at the spend's deadline; @python,@security; janitor re-review clean; the first CI run's e2e failures were pixel and site-access rows off the sandbox, green on rerun), verified; pin 15 amended with its figures. e3's flip #1245 MERGED 2026-10-28 at 1799c899 (the three P2-forge rows plain, 3/3 on the pinned core), verified: the rebound-`call_soon` property is landed end to end (property #1239 → fix #1221 → flip #1245). FOUND 2026-10-28 by the janitor's review (one finding, on the PR): a cell that rebinds the loop instance's `call_soon` runs inside the turn window, so its callbacks are credited as the cancel's own chain, bypass the cut and outlive the cell across later teardowns with no refusal (about 45 self-rescheduling callbacks measured on the branch). ROUTED the same hour under rule 10: e3 pins the rebound-`call_soon` shape failing-first in its own file, test-only PR on main first; the lane FIXED it on the branch at 97c23b12 (rebinding on the instance, the class or `__getattribute__` all covered; the next cell finds `call_soon` back on the class and the forged chain stops growing; on the pre-fix head it grew until node ran out of memory), janitor re-review requested, #1221 merges after e3's PR: that is #1239 OPEN (test-only on main, three failing-first rows under "P2-forge" in `tests/redteam-python-sandbox.test.mjs`, one per binding, each with a capped self-rescheduling chain and a positive control; measured on main against 2e41d920 the restore fails per binding; `@python,@security`, janitor reviewer); #1239 MERGED 2026-10-28 at 3a992d40, verified; the lane reports the rows passing against #1221's head 2b20196e and merges next; then e3 flips its todo, the second red team flips its hunt-2 todo on 933e5e48 (told the same hour), and the coordinator amended pin 15 the same day. FOUND 2026-10-27 by the second red team on #1150's bound: a queued frameless callback outlives the 1 s deadline (#1171 MERGED 9fbb3b22, `PYTHON_CANCEL_GAPS.md`, pins 15 to 17); the lane's fix rebases on its monitoring PR (pins 18 to 20), then the second red team flips the todo. ALLOCATED 2026-10-28 (Shane): the second red team's hunts 1 and 3 (its first brief, `~/git/session-mail/window-ml/20261027-coordinator-to-redteam-hard-brief.md`). Hunt 3 (a route through the #1102 workaround, owned-through-reset) briefed the same day: `~/git/session-mail/window-ml/20261028-0635Z-repl-specs-to-redteam-hard-hunt3-owned-through-reset.md`, its file `tests/redteam-hard-python-<lockdown>.test.mjs`, new. FOUND 2026-10-28 by the second red team (hunt 3, measured on the worker wrapper, fork core ca282158): a list captured by a cell-defined closure stays OWNED through `_restricted.reset()` and the allow-table reload (`[1]`, `[1, 2]`, `[1, 2, 3]` across a reset; a closure built outside a run is refused), a third shape of #1102 beside the default argument and the module global, noted on the issue the same day. ROUTED the same hour: GO for the test-only PR (@python,@security, janitor reviewer, todo failing-first, re-measured on the pinned 2e41d920 core), with one more bounded row first: the same closure inside a tier-3 library proposal, through the static shape rule and the post-load global check, which is the route the brief asked for; the result comes to the coordinator before the PR. No defence is built by the finder. MEASURED 2026-10-28 by the second red team on the pinned 2e41d920 core (rebased on 488512fa): the cell closure still holds (`[1, 2, 3]` after reset, the outside-built control refused), and the tier-3 row is LIVE too: a library with no module-level mutable global, whose `make()` returns a closure over a local list, passes `libraryShape` and `libraryLoad` and keeps the list owned across reset (`[1]`, then `[1, 2]`); the same reset defect as #1102, not a shape-rule defect, noted on the issue. GO given the same hour; #1222 MERGED 2026-10-28 at 7a14f579 (both rows failing-first in `tests/redteam-hard-python-lockdown.test.mjs`; janitor review: no finding, the `scripts/test.mjs` change is the genre registration only), verified. The fix for #1102 is its owner's, merges after it, then the finder flips the todos. Hunt 3 closed. ASSIGNED 2026-10-28 (Shane, in the coordinator's session): #1102 to the python-cancel lane, in the fork from 2e41d920 (ownership ends at `_restricted.reset()`, one run's cells keep their namespace; its rows in `Lib/test/test_restricted.py`; janitor reviews; the rebuild and pin bump follow #1202's pattern on Shane's go; the second red team's #1222 rows flip after the pin); design note to the coordinator before the build. Brief: `~/git/session-mail/window-ml/20261028-1120Z-repl-specs-to-python-cancel-1102-reset-ownership.md`. RULED 2026-10-28 on the lane's design note (`20261028-1527Z-python-cancel-to-repl-specs-1102-design.md`, measured on a native build of c0132c1f across the four shapes, the control and the fork's 174 tests): neither fix the issue names works, both end ownership at the CELL (one `_restricted.run`), refusing the second cell's `keep(2)` and failing 4 and 7 fork tests; the fix is C, `_PyRestricted_Reset` clears the owned set (all four shapes written within the run and refused after reset, the control and the undo check hold, 174/174), `lifted_gens` kept (provenance, not a write right), the undo log untouched. The worker question is scoped, not filed: a readonly worker is one PRINCIPAL's (`docs/dev/python-sandbox.md`), a worker-hosted run is `run:<id>` and a principal change spawns a worker whose boot runs `reset()`, so two runs never share a worker and the worker boundary is the run boundary; a page or `own` principal's many cells are one trust boundary, the within-run rule; no owner tag per run, no window-ml change. The tier-3 shape rule and the post-load check stay (e3's #1118 row). BUILT as cpython#15 OPEN (`ml/reset-ownership` 79868e1306 from c0132c1f; `ResetOwnershipTest`'s four shapes and the owned-after-reset row fail on c0132c1f and pass on the head; 178/0; the janitor asked by session-mail), verified 2026-10-28. The lane relays Shane's approval of the rebuild and pin bump for that core, given in its session; recorded as relayed, then CONFIRMED 2026-10-28 by Shane in the coordinator's session: the python-cancel lane runs the rebuild from cpython#15's merge commit (the `pyodide-build` skill, a release on the fork as #1202's was) and opens the pin-bump PR (`tools/pyodide-dist.json`; `@python,@security`; the janitor asked by session-mail; the python genre, the wasm vectors and the e2e python-stream rows on the new core; a materially different regex step figure from #1202's 1.60 s comes to the coordinator before the merge; the tier-3 shape rule stays); the second red team flips its #1222 todos on the pin's sha. The second red team's hunt-2 flip is #1250 OPEN (test-only on main, `tests/redteam-hard-python-cancel.test.mjs` only, c27a8810, `@python,@security`; the todo removed, the regex widened to the merged wording, the timing bound restated per pin 15; the row at 1110 ms, control 16 ms; the janitor asked by session-mail), verified 2026-10-28; hunt 2 closes on its merge sha. cpython#15 MERGED 2026-10-28 at 35bd1d69 (squash onto `ml/restricted-mode`; the janitor's review in its comment 6474114925: native run 178/0/8 skipped, the five new rows failing with the fix reverted), verified; the lane runs the rebuild from 35bd1d69 (release tag `pyodide-314.0.3-ml-35bd1d69`) and opens the pin PR next. The pin PR is #1263 OPEN 2026-10-28 (`python-cancel/pin-35bd1d69`, `tools/pyodide-dist.json` only, @python @security; release `pyodide-314.0.3-ml-35bd1d69` on the fork, download verified by the lane; the regex step figure measured 1.69 s at load 5.6, inside #1202's own 1.60 to 1.71 s spread, so the coordinator ruled it not material and the 1.60 s figure stands; the lane reports the full suite, the python genre and the 98 wasm vectors clean, CI runs the e2e python-stream rows; the janitor asked by session-mail, the lane merges after its review comment and green), verified. The lane reports both #1222 todos already passing on the new core: the second red team flips them on the pin's merge sha, never the lane (rule 10). Hunt 1 (post-strip realm and network reach) is sent the day PYODIDE_LOCKDOWN step 3's strip merges; #1162 is the import refusal, not the strip, so it did not unblock it.
  3. `tests/readonly-soundness.test.mjs:189` (halting): `riskyRegex` refuses the exponential shapes only (#684), so `/a+b/`
     on 10^6 characters is quadratic and runs for minutes in one host call; a sound bound needs a linear-time matcher or
     an input cap tied to the pattern's quantifiers. FIXED 2026-10-23 (#988, merged bcafa80e, session `76cd36e2`,
     reviewed by the red team, not the finder): each search is priced on its pattern and its input (`regex-cost.ts`)
     and charged to the step budget; the todo at `:189` is a plain test, failed on main, passes. Two follow-ups #988
     did not cause, named in its PR: a Python cell calling through the ml wire has no shared step meter, so each search
     gets the per-call cap (handed to the repl follow-up session; BUILT in #1007, merged 9ec17928, 2026-10-23: one ml-wire
     step budget a cell, `ML_WIRE.md` "One budget a cell", the red team's grep `-A/-B/-C` quadratic fixed with it;
     named there and since charged by #1053, merged bb881ed7, 2026-10-23: the unpiped stored-text read and `serveWireCall`'s argument copies); a `replace` whose replacement uses `$'` or `` $` ``
     builds output quadratic in its input while only the input's length is charged. ASSIGNED 2026-10-23 on Shane's word
     (relayed by the quadratic-regex session) to that session: [`REPLACE_OUTPUT_BOUND.md`](REPLACE_OUTPUT_BOUND.md); the
     red team found it and reviews nothing, the janitor reviews. Measured since: memory, not halting (V8 refuses the
     string at about 0.5G characters in milliseconds). Built in #1010 (merged a83afab2, 2026-10-23, the janitor reviewed): the
     `replaceCharge` row of `docs/dev/readonly-exec.md`; also found there, a `sed` stage outside the dialect had no
     output bound at all, now held to `MAX_STRING`. Found since by the repl follow-up session: `sed`'s bound over-counts
     (`s/a/$'/g` refused at 4,000 lines), safe, a usability cost; taken by root-k's subagent as #1045, a NEGATIVE result
     (does not reproduce on main; the real defect, a transient peak in `replaceSize`, fixed there; [`ROOT_K.md`](ROOT_K.md)),
     MERGED 443c9336 on 2026-10-24 after the janitor's review.
  4. FOUND 2026-10-23 by `[window-ml python-cancel]` while building item 2: a lockdown cell can `import pyodide_js` and
     reach `_api`/`_module`, running Python after its result with no proxy to revoke and un-revoking old proxies
     ([`PYODIDE_LOCKDOWN.md`](PYODIDE_LOCKDOWN.md), step 4, the GAP paragraph). ASSIGNED the same day (builder corrected within
     the hour) to `[window-ml security] Site access`, which neither found nor probed it; the red team delivers the
     attribute-gate probe as failing-first tests in its own PR; the janitor reviews; the finder builds and reviews nothing on it;
     item 2's fix is sound only once this is closed. Severity MEASURED the same day: the dialect refuses every import form
     involved, so this and item 2's six routes escape an APPROVED readonly cell, not the auto-approved path; the
     attribute-gate route is the red team's to probe with the fix. FIXED 2026-10-23: #1046 merged de645ea3 (the
     config-only stand-in; the gc walk finds 0 live proxies of the API); the red team's attribute-gate probe is #1060;
     **#1060 MERGED 214b4bd7 (2026-10-25, e3, `@python,@security`, test-only, `tests/redteam-python-lockdown.test.mjs`)**:
     43 pass / 15 todo / 0 fail; 41 attribute-gate routes pinned as passing (the janitor's one finding, three routes the body
     named and the file did not pin, fixed by e3 before the merge); the 15 todos are the freeze and latch (3), `run_js` (2)
     and the ten bridge imports from an APPROVED cell, each failing for its claimed reason, each the security lane's to
     turn plain with the lockdown fix (`fix/python-lockdown`, not yet a PR). Shane approved and merged it himself, the
     sessions being out of tokens that day. `run_js` stays OPEN as a step 3 property ([`PYODIDE_LOCKDOWN.md`](PYODIDE_LOCKDOWN.md), step 2,
     RULED). Lane STOPPED under the freeze; clone removed. RULED 2026-10-27 by Shane in the security lane's session (relayed, confirmed here the same day) on the parked
     widening: `js`, `pyodide.ffi`, `pyodide.webloop` refused by the worker in an approved cell unless the card carried
     an explicit browser-JavaScript line (a new public string, wording to Shane first); `asyncio` stays; nothing
     scheduled outside asyncio outlives the cell even when approved; packages' boot-time imports keep working; lands with
     SITE_PRESENCE step 3; the two rewritten todos are the red team's. Written into [`PYODIDE_LOCKDOWN.md`](PYODIDE_LOCKDOWN.md) step 2. #1162 MERGED 2026-10-27 at 37229b84 (the security lane's `fix/python-strip`: `js`, `pyodide.ffi` and `pyodide.webloop` refused in an approved readonly cell, the JS-bridge card lines, the kept line surviving worker eviction; janitor review over three rounds, nothing blocking, its nit fixed at 4550a26b before the merge), verified. DONE 2026-10-28: #1203 MERGED 88677d5e, verified: the step-3 todos in `tests/redteam-python-lockdown.test.mjs` flipped plain, the seven unclaimed bridge rows failing-first (the pyarrow route pinned closed), the #1166 both-worlds nav row. DONE 2026-10-28: #1228 MERGED 46065d09, verified (PR-2, the SITE_PRESENCE hidden-page rows); the security lane's step-3 PR #1236 MERGED 2026-10-28 at 3967b0df, verified (recorded in [`SITE_PRESENCE.md`](../../spec/SITE_PRESENCE.md)). The rebound-`call_soon` pin PR for #1221, #1239, MERGED 2026-10-28 at 3a992d40, and its flip #1245 MERGED at 1799c899 after #1221, verified; e3's setup review of #1236 passed (two findings fixed, head fbd2f8b2); e3 flips its nine SITE_PRESENCE todos on 3967b0df: #1259 OPEN 2026-10-28 (`redteam/step3-flip`, head e6ce7aa7, `tests/redteam-presence.test.mjs` only, @security; the lane reports ten of ten step-3 rows passing on bfde2519 with a fresh `dist/` and the full suite clean; the janitor asked by session-mail), verified; MERGED 2026-10-28 at f4d8bb78 (run 40722828762; the janitor's pre-merge review in its comment 6474314462, which also confirmed the stale-`dist/` trap), verified: SITE_PRESENCE step 3 is CLOSED on main. e3's PR-3 follows on `redteam/pr3-p2-regex` (the C-call rows in, nine of nine on main; pin 18's named-property row and the `:732` guard-off mutation row written and passing; the regex-cost shapes next). The security lane's next PR is test-only: the attack-13 flake in `tests/e2e/site-access.spec.mjs` (two CI hits on main's step-2 shape, runs 40579352419 and 40712844338; measured from the logs only, which record neither the run's status nor the click; the status poll becomes the wait on the fake reaching the script's length, the failure naming the stage; the late-port race is the lane's hypothesis, not a finding); opened 2026-10-28 as #1255 OPEN (`test/attack13-wait-on-calls`, one file, @security @ci; waits on the fake's calls reaching 2, then settled, then done; the janitor reviewing by session-mail; the lane merges with merge-when-green after the review), verified; MERGED 2026-10-28 at 677faeb1 after the janitor's review, verified, the lane's clone removed. CORRECTED 2026-10-28 (the coordinator, on Shane's go to assign the strip): the lockdown's `globalThis` strip (PYODIDE_LOCKDOWN step 3) is NOT this PR, and it is NOT unbuilt: it landed 2026-10-16 in #735 (d2cb57cd, `lockdownReadonly` in `src/python/lockdown.ts`, called by the worker with its real scope; e3's enumeration pin in `tests/redteam-python-sandbox.test.mjs`, section "step 3"), verified; the coordinator's "unbuilt" of the same day (plan #1254, the hunt-3 brief) was wrong and nothing was assigned. Hunt 1 (post-strip realm and network reach) was never blocked and is BRIEFED 2026-10-28 to the second red team: `~/git/session-mail/window-ml/20261028-1640Z-repl-specs-to-redteam-hard-hunt1-realm-and-network.md`, its own new file `tests/redteam-hard-python-<realm>.test.mjs`, new, pre-PR measurement first, then the test-only PR after the coordinator's go. FINDING 2026-10-28 (hunt 1, the second red team, its 1653Z mail; CLOSES hunt 1 by the brief's first-route rule): on the built extension with the real `lockdownReadonly(py, self)` boot and the 2e41d920 core, a worker-hosted cell that named `js` and was answered Allow on the sidebar card read `js.globalThis.location` and got a `WorkerLocation` whose href is the worker's own extension URL; `postMessage`, `close` and `fetch` were unreadable in the same cell, `URL` the positive control. Cause, verified by the coordinator against the code: `location` is outside `ALLOWED_GLOBALS` and appears nowhere in `src/python/lockdown.ts`; it is an accessor on `WorkerGlobalScope.prototype`, which the strip's own-property and `STRIPPED_NAMES` deletes do not reach, and which the Node stand-in of e3's enumeration pin does not carry. Effect as measured: a readable `WorkerLocation`; navigation and network were not tried and are not claimed. Ruled a confirmed contract gap in step 3 (the allow-list is to fail on anything outside it). Rule 10: the finder's test-only PR goes on main first (a Node row with a prototype-accessor stand-in in `tests/redteam-hard-python-<realm>.test.mjs`, an e2e row on the real worker in `tests/e2e/redteam-hard-python-<realm>.spec.mjs`, the three negatives as passing rows; @python @security, the janitor by session-mail); the defect went to the security lane the same hour in defect language (its fix PR merges after the test-only PR, never touching that file; the lane needs a fresh clone); the finder flips the rows on the fix's sha. The security lane's fix is IN PROGRESS 2026-10-28 (`fix/lockdown-prototype-accessors`, a fresh clone): the strip walks every prototype of the scope up to `Object.prototype`, deletes each own name outside `ALLOWED_GLOBALS` (`constructor` excepted) and shadows on the scope any chain name it cannot delete; its own failing-first row goes in `tests/python-lockdown.test.mjs`, not the finder's files. RULED 2026-10-28: `crypto` joins `ALLOWED_GLOBALS` (Pyodide's random source reads `crypto.getRandomValues` on every call; it is the same prototype accessor as `location` and survives today only through this gap; `getRandomValues` and `subtle` compute on bytes the cell holds and reach nothing), written into [`PYODIDE_LOCKDOWN.md`](PYODIDE_LOCKDOWN.md) step 3. The fix PR merges after the finder's test-only PR, never before. e3's PR-3 is #1266 OPEN 2026-10-28 (`redteam/pr3-p2-regex`, head bb7db9ef, test-only, @python @security; `tests/redteam-python-sandbox.test.mjs`, `tests/redteam-python-regex-backtrack.test.mjs` and the new `regex-cost-core.test.mjs` under `tests/`; the janitor asked by session-mail), verified. Per the lane: the pin-18 named-property row with the bound-off hang mutation; one guard-off mutation row for the `:732` enumeration, the enumeration itself not duplicated; python-cancel's C-call rows re-verified nine of nine on main; the janitor's `spies < 60` line; the regex-cost shapes on the shipped core: the new file holds 28 rows (`regex-cost.json` read with the LAG contract, growth order, priced-and-refused before the run with a wall-time pin, under-budget controls), the backtrack file the budget shapes (one budget per cell: nine run, the tenth refused, ten separate cells each run; `re.compile` charges nothing; `re.sub`/`re.subn` price their INPUT, not the replacement, which is the shipped property and supersedes the coordinator's shorthand in the scoping above); the full suite clean. MERGED 2026-10-28 at a633c93d, verified; the new file `regex-cost-core.test.mjs` now exists under `tests/`. e3's next is the keep red-team pass against #1142 (89a8a1ef), in its own file: scope, what ends a keep, what a page or model cannot get through it, the idle clock. SCOPED 2026-10-28 on e3's question: one named row for the raising-`settrace` 4 s-`finally` case with the mutation check (pin 18); no second `dir(sys.monitoring)` enumeration, the lane's row in `tests/redteam-python-sandbox.test.mjs` is pin 19's, plus one mutation row only if it lacks one; the C-call rows from the lane's patch; the regex-cost rows run on the SHIPPED core (`dist/pyodide`, 2e41d920), four shapes: `regex-cost.json` read with the LAG contract, one budget across several just-under searches (refused at the crossing search, before it runs), `compile` charges nothing, `sub`/`subn` price the replacement.
  5. FOUND 2026-10-23 by `[window-ml python-cancel]`, reproduced by the coordinator: `lockdown()` THROWS on main (the
     `Object.prototype.constructor` accessor from #735 is refused by `ses`'s permit check), the `try/catch` swallows it, so
     the readonly realm is never frozen and the latch never sets; P1 still holds, nothing tests the freeze
     ([`PYODIDE_LOCKDOWN.md`](PYODIDE_LOCKDOWN.md), step 2, the DEFECT paragraph). ASSIGNED the same day with item 4 to
     `[window-ml security] Site access` as builder (the red team's first assignment withdrawn under rule 10; it delivers
     the frozen-realm tests), the janitor reviews, the finder builds nothing on it. Fix shape ruled: the accessor goes
     in AFTER `lockdown()`, the `ses` permit is not widened. FIXED 2026-10-23 in the same #1046 (de645ea3):
     `overrideTaming: "severe"` in place of our accessor, the realm frozen and the latch set, 0 of 14 PyProxy kinds
     broken, corpus 0 changed, lockdown 9.0 ms from 8.1.
- **The repl follow-up session's merges (sh-policy, `2df4ae0f`, Opus; synced 2026-10-23 at Shane's request).** #989
  (6ace2dbf): an undescribed exec call answers an ALLOW's direction only, said in the policy prompt; a refused `in` is
  named. #990 (46ca8dc9, with host #25): manifests for `rm`, `mv`, `rmdir`, `unlink`, `git rm`, `git mv`; no shipped
  manifest describes a program inside a workspace root (red team rechecked). #992 (51526abc): reading the agent files a
  person already keeps, an idea; a measurement a decision rests on is a notebook. #995 (5acd17e7): JSON Schemas for
  program and library manifests. #999 (7d2127ba): a policy may answer `ask`; precedence deny > ask > allow > builtin;
  the card names it and offers no remember. #1007 (above). #1019 (93d34a3c): `POLICIES.md` "A policy kept in a file
  (proposed, not built)" and "Where a policy can live". Shane's decisions with it (2026-10-23, in `POLICIES.md` via
  #1019, nothing built): a policy kept in a FILE (a repo is one channel, not the main case) applies its `deny`/`ask`
  live, its `allow` only from an accepted, hash-pinned snapshot entering the store as `origin: "file"`; loading is a
  proposal card; committing or pushing a policy file asks by default, an endorsement; every gate is a default a person
  may widen. Worked example and future test: "merge only through my script" = deny `gh` and non-read-only `git`, allow
  one pinned user script; open under it whether the host refuses a denied program started INDIRECTLY (`npm run`,
  `xargs`, a git alias). Two more of Shane's, in `POLICIES.md` since #1026 (0b32d25a, 2026-10-23; open there: more than one card per drafting conversation, whether a proposed policy the person edits becomes theirs, and, closed by #1028 (3516b69a) the same day, the HUD card sent no deny note): a policy is CO-WRITTEN with the model interactively, never
  filled in as a builder or JSON, safe only when the person approves the system's deterministic rendering of the rule
  plus breadth evidence (calls it would and would not match), never the model's paraphrase; a classifier never decides
  what runs automatically, at most after-the-fact detection. The red team's recheck of #999 (the page's own `ml.fetch`
  free tiers and the page-hosted loop skip an `ask`) is settled by design, not open: those tiers are reads the page can
  make itself with `fetch()`, and the page-hosted loop's `approve` is the page's own callback, so a card there binds
  nothing (`docs/dev/policies.md`, "What an ask cannot reach"; `tests/redteam-policy-ask-free-tiers.test.mjs`). Still
  open from it: an ask saved between `decide` and host start is not re-checked (only deny is); a URL consented BEFORE
  an ask existed is already refused while an ask or deny matches (`sw-fetch-url.ts` `withdrawn`; `docs/dev/policies.md`,
  "A remembered consent yields to an `ask` or a `deny`"). Unstarted and unrequested: the
  symlink link as a second claim resource; `RIPGREP_CONFIG_PATH`; the lost-POLICIES-add race, FIXED 2026-10-23 by root-k
  as #1052 (merged 265d055f, the janitor reviewed: a policy added before the worker's first storage read is merged, not
  lost; after a failed read the store no longer counts as loaded, so `judgeCall` asks for every call in that worker
  unless a policy added since denies it; a `forgetRunPolicies` before the read is replayed after it).

- **The canvas session's fork merges (`[window-ml canvas]`, on Shane's word, 2026-10-24).** parawanderer/cpython#10
  (59d015a5): `risky_regex` tells an exact count like `{3}` from a choice inside a repeated group, and refuses `{0,1}` like
  `?`, window-ml's `riskyRegex` change ported. cpython#11 (1e35340b): the read-only Python dialect's regex check also walks
  `re`'s parse tree (`risky_parse`, either check refuses); closes the `{,n}`, verbose-via-flags-int and conditional-group
  escapes, three exponential cells that ran unasked in the shipped core. Neither is in the shipped core: the pin stays
  0169c4fd until Shane assigns the rebuild. The three escapes went to the red team as a brief; the unpriced quadratic
  (`regex-cost.ts` has no Python port) is named to the python-cancel lane in #11's body. REBUILD ASSIGNED 2026-10-24
  (Shane) to a new session, `[window-ml pyodide]`: the core at the fork's head (ca282158, #10–#12 merged), released on
  the fork, the pin moved in one PR (`@python,@security`), the janitor reviewing; the red team turns #1109's
  fail-on-land todos into plain tests in step with it. RULED the same day on Shane's
  question whether one implementation can serve both sides: no; one definition and one corpus, two parsers
  ([`PYTHON_DIALECT.md`](../../spec/PYTHON_DIALECT.md), "one DEFINITION and one CORPUS"); the parity test he asked for
  is `halting.json` read by both suites.
  cpython#12 (ca282158): the fork's `RegexCorpusTest` reads that corpus (35 `regex` vectors on window-ml's
  `dialect-artifact-gaps` branch, PR pending). RULED the same day: the shipped core reads the corpus too, in the python
  genre, each lag a `{ todo }` naming the fork commit and the pin, a passing todo failing
  ([`PYTHON_DIALECT.md`](../../spec/PYTHON_DIALECT.md), "the SHIPPED core reads the corpus"). Until the rebuild Shane
  assigns, the pin 0169c4fd lags fork #10 to #12: the three exponential escapes are KNOWN OPEN in the shipped core.
  #1119 MERGED 0d6bcdde (2026-10-24): main pins the core from ca282158 (release `pyodide-314.0.3-ml-ca282158`),
  so the three escapes are CLOSED in the shipped core; e3's #1121 (merged into the branch first) emptied both LAG maps,
  the corpus test's and the red-team file's. The janitor reviewed with no finding. The pyodide session's clone is removed.
  The dialect PR is #1093, MERGED 2fe3e352 after the janitor's review (the corpus; `tests/regex-corpus-core.test.mjs`
  with 9 lag todos, 6 for fork #10 and 3 for #11, a stale todo and a drift both failing, measured by flipping a verdict;
  the four idioms the artifacts panel fell out on). MISS, recorded as such: #1093 WIDENS the read-only dialect on three
  counts (destructuring as a `for…of` variable and decimal object keys; the `Number` statics; a repeated group of an
  exact count passes `riskyRegex`) and merged BEFORE its red-team pass, which the standing rule says lands with the
  change; the canvas session and the janitor both missed it. e3 writes the pass now, in its own file, merged after,
  with the loosened bound pinned by its COST (a repeated exact-count group on a long non-matching input charged at
  the bound), not only its verdict. The janitor's #1096 (7fea734a) fixed eight stale doc paths the hook and CI never
  see, since both check changed files only; whether CI runs the bare checker is an open `@ci` item.

- **Root K and the rest of the policy layer, ASSIGNED 2026-10-23** on Shane's word (his session) to a new session
  `[window-ml root-k]` (Opus): [`ROOT_K.md`](ROOT_K.md), five roots in order (process ownership on the host, root K in four
  PRs, the shell probes then `propose_policy` to `sh`, file-kept policies, co-writing's two items), and the small
  unowned items of this section (the `ended` record at a deadline kill, #1007's two uncharged reads, the `sed`
  over-count, the `ask` re-check, the lost-POLICIES-add race, the corpus append) run through Sonnet subagents that the
  session briefs, reviews and merges, never two in one tree. The red team's `MANIFESTS` pass is #1068 (2026-10-23,
  test-only, stacked on #1048's branch `manifests/store` as ruled, head b05f0650, rebased on the janitor's B2 fix
  fec2cbd7): the three page properties hold (pinned, positive controls, mutation-checked); one residual B2 gap as a
  failing-first todo, the entrypoint branch of `storeRefusal` runs no shipped-program check, so a stored entrypoint
  manifest naming `git` is kept, survives load and shadows `git.json` at call time. The fix is root-k's, on #1048's
  branch before it merges (a hole in the item being landed, inside the freeze); #1068 merges after #1048 and the
  janitor reviews it. The red team's `propose_manifest` pass is #1070 (2026-10-23, test-only, stacked on #1055's
  branch `manifests/propose`, head 5ee9eb92, `redteam-propose-manifest.test.mjs` on its branch): twelve pins, all six
  boundary properties hold against c0ca2a09, mutation-checked, no gap; it merges after #1055, the janitor reviews it.
  #1068's entrypoint todo is a passing pin since 4d80c878 (root-k's fix 01f3952f on `manifests/store`). The janitor's
  re-reviews cleared #1048 and #1063 on 2026-10-23. Blocked the same day: #1048's base was #1042's branch and
  `merge-when-green` refuses a PR another is stacked on; root-k's session was refused permission to retarget #1048 or
  to merge host #28, and stopped there. Shane cleared it himself the same afternoon: #1042 MERGED b7e9a3c1 (the host's
  owner table and CPU time read; the worker never registers), host #28 MERGED ae7284e6, #1048 retargeted to `main`.
  Root-k merged `main` into `manifests/store`; main's backup inventory then failed on the store's two keys, classified
  `never` backed up in a48e9743; the janitor cleared that commit (review 5631381308) and **#1048 MERGED 703e8724**
  the same evening. GitHub retargeted #1068 and #1055 to `main`. The next morning (2026-10-24): #1068 MERGED
  ce2a96bb (the red team's `MANIFESTS` pass, its entrypoint pin passing), #1055 MERGED 76ef2f7d, #1041 MERGED
  326ff8cf (the corpus append). **Root 2 DONE 2026-10-24**: [`ROOT_K_RESULT_2.md`](ROOT_K_RESULT_2.md) landed with
  #1055 (the coordinator checked its claims against the merged code: the tool is offered on `shellTurnedOn` at run
  start, a draft stores `origin: "proposed"`, the evidence run requires the host to hold a `write: none` envelope;
  host `c107434` is host #28's head before its squash). Measured there on the real host: a true read-only draft gets
  `evidence {calls: 1}`; a lying one (`touch` drafted as a reader) fails its re-run on exit 1 and stays sandbox-only.
  Named as left: a lying manifest whose program exits 0 having written nothing would pass (the check is exit code,
  envelope and protected names, never a diff of the root); the evidence run is unmeasured on Linux (Landlock); one
  accepted change beyond the ruling, the tool is offered by the settings, not the measured host status. **(d) DONE
  2026-10-24**: #1063 MERGED a35d7363, the Settings page "Program manifests (ml.sh)" (every stored entry with whose it
  is, where it describes calls, its evidence or the run's failure, its pin; add and remove); beyond the page, an add is
  pinned by the host through the same precheck as a draft (`checkDraft`, origin `person`, in `background.ts`), so the
  page's payload never chooses a pin; not measured against the real host, the same resolve path the two runs
  exercised. Written into `ROOT_K_RESULT_2.md` with it. **#1070 MERGED a8ff7230 (2026-10-25)**, the red team's `propose_manifest` pass on `main`: the janitor ran its
  twelve pins green on the head (12/12), root-k had checked them against `manifests/propose` the day before, no gap
  found, nothing open from it. Left: (c2) library manifests only if time allows; the Linux measurement.
  **Root 1 DONE 2026-10-23**: [`ROOT_K_RESULT_1.md`](ROOT_K_RESULT_1.md) merged 9fe4e6a2 (#1075, the coordinator
  reviewed, every claim checked against the merged code). Left by it, each named there: the host's CPU timebase is a
  per-arch constant (an x86_64 host under Rosetta undercounts about 42x), a follow-up root-k's session was refused
  permission to post on host #28, so it is Shane's to post or assign; `HostStatus` is narrower than PROTOCOL.md's
  `status`, to widen before the first `status()` consumer, unowned; nothing reads `owner` until the agent-status line
  (`AGENT_MAIL.md` step 1); a registered row counts toward the 32 running calls, unmeasured against a session that
  registers many.

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
