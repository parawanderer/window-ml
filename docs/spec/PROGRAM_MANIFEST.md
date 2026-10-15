# Spec (WIP): program manifests, what a shell call is described by

**Status: draft, nothing built.** Split out of [`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md) on
2026-10-15, because the shell's free tier ([`SHELL.md`](SHELL.md)) needs a much smaller thing than the library manifest
and should not wait on its cost model. A program manifest describes a PROGRAM the way a library manifest describes a
function; it never decides anything ([`POLICIES.md`](POLICIES.md) decides).

## What a program manifest says

Per program, subcommand and flag:

| Field | What | Why |
| --- | --- | --- |
| `effects` | in the shared algebra ([`EFFECTS.md`](EFFECTS.md)): `read(fs)`, `write(fs)`, `exec(process)`, `read(net(host))` or `write(net(host))`; `unknown` for a flag it does not know | the free tier and every policy read it |
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

## Pinning

A library manifest is pinned to a content hash of one build. A program cannot be, in general: `git` is whatever the
machine has. A program manifest names the program and a version range, the host records the RESOLVED path and the
version it reports with every call, and a program outside the range is `unknown`. A container image can pin exactly.
The BSD coreutils on macOS (`ls`, `cat`, `wc`, `head`, `tail`, `find`) report no version at all: such a manifest has
`range: "*"`, takes no version arguments, and lists only flags with the same meaning in GNU and BSD (2026-10-15).

## Trust

As for library manifests: shipped with the extension or installed by the person; never from a page, never from the
program. A first set covers `git` (the read subcommands without their writing flags), `rg`, `ls`, `cat`, `wc`, `head`,
`tail`, `find` without its effectful flags, `jq`.

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
- A draft manifest is generated from the program's `--help`, its man page or its shell completion files (which encode
  the flags and whether they take file arguments). A model is good at the drafting, and it is safe because the draft
  reaches the person as a card with its evidence and, under the sandbox, is enforced rather than believed.
- Manifests have SCOPES, as policies do. A repository-local tool (`./scripts/<name>`) arrived with the repository, so
  it is untrusted content, and its manifest belongs to the workspace, approved by the person. A tool on the person's
  own `PATH` may be global. A page never registers anything.
- One page lists them, like the policy page: shipped, installed, proposed, each with its source, its pin and the
  measured evidence (calls run under it, failures under its envelope). It lives in DevTools Settings, the superset.

**Two kinds of command, two kinds of manifest.** A registered command is either a BINARY, described by a program
manifest and bounded by the envelope above, or a FUNCTION exposed as `ml.sh.<name>`, written in JavaScript or Python and
described by a library manifest ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md)). A function written
in the read-only dialect of either language needs no manifest at all: tier 3 proves its effects by construction
([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)). So the cheapest way to a free-tier command is to write it in the dialect,
and the two kinds meet the policy as the same facts.

**What this adds, later:** profile derivation from a manifest's effects, hash pinning of a resolved program, a
manifests directory with workspace and global scope, and the registration page. None of it blocks the host's first
slices; it is a root of its own in [`docs/plan/repl/`](../plan/repl/README.md).

## Related

- [`SHELL.md`](SHELL.md): the consumer; what a call gives a policy; the host that resolves the facts.
- [`EFFECTS.md`](EFFECTS.md): the vocabulary.
- [`SECRET_HANDLES.md`](SECRET_HANDLES.md): why `echoes` exists.
