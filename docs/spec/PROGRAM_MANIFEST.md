# Spec (WIP): program manifests, what a shell call is described by

**Status: draft, nothing built.** Split out of [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md) on
2026-10-15, because the shell's free tier ([`SHELL.md`](SHELL.md)) needs a much smaller thing than the library manifest
and should not wait on its cost model. A program manifest describes a PROGRAM the way a library manifest describes a
function; it never decides anything ([`POLICIES.md`](POLICIES.md) decides).

## What a program manifest says

Per program, subcommand and flag:

| Field | What | Why |
| --- | --- | --- |
| `effects` | in the shared algebra ([`EFFECTS.md`](EFFECTS.md)): `read(fs)`, `write(fs)`, `write-names(fs)` (the program creates, removes or renames an ENTRY at the path rather than writing bytes into it in place: `mkdir`, `rm`, `mv`, and every editor that writes a temp file and renames it over the target, `sed -i`, `perl -i`, npm's `write-file-atomic`; added 2026-10-19 so that the atomic-rename rule in [`SHELL.md`](SHELL.md) is claimable), `exec(process)`, `read(net(host))` or `write(net(host))`; `unknown` for a flag it does not know | the free tier and every policy read it |
| `paths` | which arguments are paths, so the host can `realpath` them and judge `inRoot` and `secret` | an argument the manifest does not mark is not a path the host can vouch for, and the call asks |
| `operands` | where the program's operands start, and whether it honours `--` or `--end-of-options` | a value from a variable that starts with `-` is an option to the program; the host puts the terminator there |
| `runner` | the flags that start other programs (`find -exec`, `xargs`, `git -c core.pager`, `npm run`, `env`) | never free on the program's own word |
| `echoes` | whether it prints its environment or its inputs (`env`, `printenv`, `set`, `curl -v`) | a secret in the env reaches stdout; refused with a secret present, scrubbed otherwise |
| `okCodes` | exit codes that are answers, not failures (`grep` 1, `diff` 1) | `ok` and pipefail |
| `env` | environment variables that change what it does (`PAGER`, `GIT_EXTERNAL_DIFF`, `LD_PRELOAD`) | the REFUSED list, and the forced values the host sets for this program (`git`: `core.fsmonitor=false` and `core.pager=cat` through `GIT_CONFIG_COUNT`; never an empty `diff.external`, which makes every `git diff` fail; the external diff is suppressed by the `harden` flags, `--no-ext-diff`) |
| `recursive` | whether a directory argument means everything beneath it (`rg`, `grep -r`, `find`, `ls -R`, `tar`, `du`) | the host computes `containsSecret` for such an argument ([`SHELL.md`](SHELL.md)) |
| `configRunsCode` | for a program whose own config can make a read run code (`git`), the keys to look for | the `repoConfigRunsCode` fact |

**No cost tiers.** A process is metered by the host's time limit and output cap, not by a survey's step budget: a
survey that calls `ml.sh` waits on a promise, and the dialect's steps measure interpreter work, not the person or the
host. (The earlier sentence in `SHELL.md` charging a process to the step budget was wrong for that reason.)

### The delete family (`rm`, `mv`, `rmdir`, `unlink`, `git rm`, `git mv`; 2026-10-22)

A delete, a rename and a create of a directory entry are `write-names` on the operand: `rm`, `rmdir`, `unlink` on each operand, `mv` on EVERY operand (the sources, and the destination operand itself: the narrow reading, since a manifest cannot know that `mv a dir` creates `dir/a`). A recursive flag (`rm -r`, `-R`) walks the operand, so the host answers `containsSecret`; `mv` and `git mv` are `recursive` at the command level, since moving a directory renames everything beneath it with no flag (the same red-team pass: `mv src/keep src/keep2` renamed `src/keep/.env` free). Flags that exist on one platform only (`rm -I -P -W -x`, GNU long options, `mv -t -T -b -S -u`, `rmdir -p`) are not listed, so the call is `unknown`. Four command keys carry what `cat` and `ls` never needed:

- `optionsFirst`: GNU permutes options and operands (`rm a -r` is recursive), BSD stops at the first operand (`rm a -r` removes two files; `rm a -- -b` removes a file named `--` as well). An argument starting with `-` after an operand, `--` included, makes the call `unknown`.
- `dashIsPath`: a lone `-` is a file name (`rm -` removes the file `-`), so it stays a path operand instead of meaning stdin.
- `repoWide` (git): the command's effects also fall on the directory it acts in (`-C`, else the cwd) and on the repository's root (`resolve({ arg: "repo" })`, the host's `repo.root`; the cwd when none was found). `git rm` removes the parent directories it empties, so `git rm src/gen/only.ts` can remove the top-level `src`; a claim on the operand alone would be free under the sandbox. With `-C` and operands it is `unknown`: git resolves the operands against the `-C` directory (composing a repeated `-C`), the host against the cwd, so the host would walk the wrong path (review of #990, 2026-10-22).
- `pathspecs` (git): an operand starting with `:` is pathspec magic (`:/x` is relative to the repository root), and one holding `*`, `?`, `[` or `\` is a glob git expands to every match (or an escape: `a\*` names `a*`); neither is one path the host can resolve: `unknown`. Found by the red-team pass on #990 (2026-10-22): `git rm *.ts` removed a secret among its matches under a claim that named only `*.ts`. `--icase-pathspecs` is `unknown` for the same reason: on a case-sensitive host `Secret.ts` matches `secret.ts`, a name the host never resolved (red-team recheck, 2026-10-22). A repository with `core.ignoreCase=true` does the same without the flag; that is not caught yet.

A nested `rm` inside a root stays free under `host-sandbox` (ruled 2026-10-22): the built-in default is one algebra over effects, as it is for `find -delete` and for overwriting a file with `>`, never a per-program exception, so deleting a top-level name, a root, a secret or anything outside the roots asks and a nested delete does not; a person who wants stricter or wider writes a policy, and stored policies are judged before the built-in.

## Pinning

A library manifest is pinned to a content hash of one build. A program cannot be, in general: `git` is whatever the
machine has. A program manifest names the program and a version range, the host records the RESOLVED path and the
version it reports with every call, and a program outside the range is `unknown`. A container image can pin exactly.
The BSD coreutils on macOS (`ls`, `cat`, `wc`, `head`, `tail`, `find`) report no version at all: such a manifest has
`range: "*"`, takes no version arguments, and lists only flags with the same meaning in GNU and BSD (2026-10-15).

**When the version is learned** (ruled 2026-10-15, lane 4 of the plan). Learning a version means RUNNING the program,
and the host spawns nothing without an explicit start, so the probe is not an exception to that rule but an ordinary
call: the shipped manifest carries a `version` entry (the arguments, the output pattern, effects empty, no runner, no
paths, a 2 s limit, stdin closed, output capped at 4 KiB), the worker judges it with the default policy like any call,
and the host spawns it on a start. Under the sandbox its effects are inside what the sandbox bounds, so it is free and
no card is raised; on the plain host nothing is bounded, so the worker does not raise the probe at all and the program
stays `unknown` there, which costs nothing since every plain-host call asks anyway. Two refusals in the worker: a
program whose resolved path is inside a workspace root is never probed (it arrived with the repository), and only a
SHIPPED manifest's probe entry is used, never arguments from a script. The result is cached per binary for the session
(realpath, device, inode, size, mtime), reported in the facts as `program.version` (`null` when unreadable), shown on
the card and written to the log. A sweep of every manifest's program at configure time was rejected: it runs binaries the
person may never call.

## Trust

As for library manifests: shipped with the extension or installed by the person; never from a page, never from the
program. A first set covers `git` (the read subcommands without their writing flags, and `rm`/`mv`), `rg`, `ls`, `cat`, `wc`, `head`,
`tail`, `find` without its effectful flags, `jq`, `rm`, `mv`, `rmdir`, `unlink`.

## Registering a program (2026-10-15)

People have their own CLIs, and a manifest shipped with the extension cannot know them. Three things make registration
safe without making it a trust decision the person has to get right.

**The baseline needs no registration.** An unregistered program is `unknown`: it runs, and every call asks. A manifest
buys the free tier and better facts on the card (which arguments are paths, where the operands start). Registration is
about DESCRIBING a program, never about permission for it to exist.

**Under the sandbox, the description is the envelope.** A manifest's claims are not believed; they are enforced. A
call the manifest describes as `read` with no `runner` is spawned under a profile derived from that claim: writes
denied, network denied, `process-exec` of anything but the program itself denied. A wrong manifest then degrades to a
FAILING command, never to an effect, which is the same fail-closed shape as everything else here. So the two claims that
matter (`effects`, `runner`) need no one's word while the sandbox is on; the descriptive fields (`echoes`, `okCodes`,
`operands`) are low-risk, and `echoes` has the output scrubber as its belt regardless ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)).
On the plain host there is no envelope: a person's own manifest is trusted on their word, and a manifest a MODEL
drafted is run in the sandbox first, over the calls it claims are reads, before it may make anything free. Evidence
before trust, the rule model-proposed policies already follow ([`POLICIES.md`](POLICIES.md)). `describeCall` stays pure
over the manifest's data so the profile is derived from the same source as the facts.

**How a program is registered.**

- The person names it. The host resolves it, and a tool the person owns is pinned by the HASH of its binary or script,
  a better pin than `git` can have; a changed script drops back to `unknown`.
- A draft manifest is generated from the program's `--help`, its man page, its shell completion files (which encode
  the flags and whether they take file arguments), or—for a script in the workspace—directly from its source and
  argument parser (`parseArgs`, `argparse`, `process.argv` walk). A model with `ml.sh` enabled can draft the manifest
  for a CLI or repo script it just wrote or inspected, and it is safe because the draft reaches the person as a card
  with its evidence (`propose_manifest`, parallel to `propose_policy` in [`POLICIES.md`](POLICIES.md)) and, under the
  sandbox, is enforced rather than believed.
- Manifests have SCOPES, as policies do. A repository-local tool (`./scripts/<name>` or `node scripts/<name>.mjs`)
  arrived with the repository, so it is untrusted content, and its manifest belongs to the workspace, approved by the
  person. A tool on the person's own `PATH` may be global. A page never registers anything.
- One page lists them, like the policy page: shipped, installed, proposed, each with its source, its pin and the
  measured evidence (calls run under it, failures under its envelope). It lives in DevTools Settings, the superset.

### Interpreted script tools (`node scripts/<name>.mjs`, `python3 <script>.py`)

In LLM agent workflows, almost every repository-specific CLI utility (`node scripts/index.mjs`,
`node scripts/test-cover.mjs`, `python3 tools/check.py`) is invoked through a general language interpreter rather than
compiled to a standalone binary. Keying a manifest solely on `argv[0]` fails on this pattern: `argv[0]` is `"node"` or
`"python3"`, which as a bare binary is an un-describable universal code runner (`effects: ["unknown"]`, `runner: true`).

A program manifest therefore matches a **command prefix** `(program, entrypoint?)` rather than `argv[0]` alone:

**A shipped manifest never describes a program inside a workspace root** (ruled 2026-10-22): when the host reports `program.inRoot` for the resolved file, `shFacts` leaves the call `unknown` and undescribed, whatever `argv[0]` is spelled (`./cat`, `bin/ls`); a workspace-registered entrypoint manifest is unaffected.

| Field | For a standalone binary (`rg`, `git`) | For an interpreted script (`node scripts/index.mjs`) |
| --- | --- | --- |
| `program` | `"rg"` (`argv[0]` basename, resolved on `PATH`) | `"node"` or `"python3"` (`argv[0]` resolved on `PATH`) |
| `entrypoint` | absent | `"scripts/index.mjs"` (workspace-relative path; must match `argv[1]` after `realpath`, with **no interpreter flags** between `argv[0]` and `argv[1]`) |
| Option parsing | starts at `argv[1]` | starts at `argv[2]` |
| Pin (`sha256` / `version`) | `version` range probed once per binary inode | `sha256` of the entrypoint script (or its static local import closure, computed the way `scripts/imports.mjs` walks local specifiers); no `--version` subprocess is needed |
| Sandbox `exec` envelope (`exec: program-only`) | `process-exec` restricted to `{ resolved(program) }` | `process-exec` restricted to `{ resolved(program) }` (plus `/usr/bin/env` when invoked via a `#!` shebang on `./scripts/<name>.mjs`), with interpreter injection variables (`NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`) already in `REFUSED_ENV` |

Two invariants keep an interpreted-script manifest sound:

1. **No interpreter flags before the entrypoint.** A call `["node", "--import", "./evil.mjs", "scripts/index.mjs"]` or
   `["node", "-e", "..."]` has an option at `argv[1]`, so it does not match `(program: "node", entrypoint: "scripts/index.mjs")`
   and falls back to `unknown` (asks).
2. **Transitive imports vs. the sandbox envelope.** Unlike a static binary, `scripts/index.mjs` may import local modules.
   Under the OS sandbox (Seatbelt / Landlock+bubblewrap), the kernel enforces the manifest's claimed effect envelope
   (`write: none`, `net: deny`, `exec: program-only`, secret paths denied) across the entire process regardless of what
   files `scripts/index.mjs` imports. On the plain host (where there is no kernel envelope), pinning must hash the
   entrypoint's transitive local import closure, or the manifest applies only when `sandboxed: true`.

**Two kinds of command, two kinds of manifest — and how ad-hoc scripts graduate.** A registered command is either a
PROCESS, described by a program manifest (standalone binary or `(program, entrypoint)` script) and bounded by the kernel
envelope above, or an IN-PROCESS FUNCTION exposed in `exec` / `python_exec`, written in JavaScript or Python and
described by a library manifest ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)). A function written in
the read-only dialect of either language needs no effect or cost trust at all: tier 3 (`@cost interpret`) proves its
effects and step bound by construction ([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)).

When an agent works with Python (or Node) on a desktop runtime, three execution modes therefore coexist without
overlapping:

| Mode | Invocation | Gate & Pin | Why |
| --- | --- | --- | --- |
| **1. Local kernel (`python_exec` cell or `import` inside it)** | In-process cell or pure helper module | **In-interpreter `CO_RESTRICTED` gate** (step budget, `heap(owned)` write barrier + rollback, [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)). No `open()`, `os`, `sys`, `argparse`. | Shares one persistent per-run heap (`dict`); must halt and never mutate unowned state. |
| **2. Ad-hoc script written & edited mid-run (`python3 tmp/scratch.py`)** | `ml.sh.run(["python3", "tmp/scratch.py", ...])` while the agent iterates on `tmp/scratch.py` | **OS sandbox** (Seatbelt / Landlock confines writes to roots, denies `~/.ssh` and network) + Root L process-group memory/time cap + **run-scoped policy** (`propose_policy`, [`POLICIES.md`](POLICIES.md)). | A CLI script imports `sys`/`os`/`pathlib`/`open` (which `CO_RESTRICTED` refuses), and its `sha256` changes on every edit, so a hash-pinned manifest would invalidate on each turn. |
| **3. Stabilized repo CLI (`python3 scripts/tool.py`, `node scripts/index.mjs`)** | `ml.sh.run(["python3", "scripts/tool.py", ...])` | **`ProgramManifest` `(program, entrypoint)` pinned by `sha256`** (`propose_manifest`) + **manifest-derived sandbox envelope** (`write: none`, `net: deny`, `exec: program-only`). | Once stationary, its flag grammar is described once and enforced as a tight read-only kernel envelope across runs without needing a run policy. |

**What this adds, later (Root K):** `(program, entrypoint)` prefix matching in `describeCall`, profile derivation from a
manifest's effects, `sha256` pinning of a resolved binary or script closure, a manifests store with workspace and global
scope, `propose_manifest` (drafting from `--help` or script source into an approval card with sandbox evidence), and the
registration page. None of it blocks the host's first slices; it is a root of its own in
[`docs/plan/repl/`](../plan/repl/README.md).

## Related

- [`SHELL.md`](SHELL.md): the consumer; what a call gives a policy; the host that resolves the facts.
- [`EFFECTS.md`](EFFECTS.md): the vocabulary.
- [`SECRET_HANDLES.md`](SECRET_HANDLES.md): why `echoes` exists.
