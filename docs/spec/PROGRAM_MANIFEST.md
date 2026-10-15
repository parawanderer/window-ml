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

## Related

- [`SHELL.md`](SHELL.md): the consumer; what a call gives a policy; the host that resolves the facts.
- [`EFFECTS.md`](EFFECTS.md): the vocabulary.
- [`SECRET_HANDLES.md`](SECRET_HANDLES.md): why `echoes` exists.
