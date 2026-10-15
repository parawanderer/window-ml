# Lane 4, root F: program manifests (result)

Work slug `repl-lane4`, session `b9bc1868-816e-4f91-86bc-4fc2e0f3047e`, model `claude-opus-5-5`, 2026-10-15.

## What landed

- **PR #683** (merged, `b00b310c`), labels `@exec,@security,@host`. Full `npm test`: 5450 pass, 0 fail.
- **window-ml-host #3** (merged): the Rust reader of the same JSON (`src/manifest.rs`), held to the 227 vectors
  vendored byte for byte (`vectors/program-manifests/`, pinned to `b00b310c` by window-ml-host #4).
- **`src/shell/program-manifest.ts`**:
  - the format, as TypeScript types with a doc comment per field;
  - `describeCall(argv, manifest, { version, envSet, resolve })`, which returns the facts a policy is given before the
    host resolves the paths;
  - `hardenArgv`;
  - `validateManifest`, which refuses unknown keys, so a misspelt `runer` cannot silently drop a runner flag.

  Effects are lane 2's `ProgramEffect` terms, projected with `fromProgramEffect` and combined with `union` from
  `src/effects.ts`.
- **`src/shell/manifests/<program>.json`** for the first set PROGRAM_MANIFEST.md names: `git`, `rg`, `ls`, `cat`, `wc`,
  `head`, `tail`, `find`, `jq`.
- **`tests/fixtures/program-calls/<program>.json`**: 227 argv lines with the expected description of each. These are
  the vectors the host's Rust reader will be held to.

  | Program | Calls | Undescribed | Runners |
  | --- | --- | --- | --- |
  | git | 66 | 16 | 14 |
  | rg | 30 | 5 | 6 |
  | find | 29 | 10 | 6 |
  | jq | 24 | 9 | 0 |
  | tail | 20 | 4 | 0 |
  | ls | 16 | 7 | 0 |
  | head | 16 | 4 | 0 |
  | cat | 13 | 4 | 0 |
  | wc | 13 | 4 | 0 |
- **`tests/program-manifest.test.mjs`** (44 tests):
  - every manifest validates;
  - every fixture call describes as recorded;
  - **every flag or primary that changes the effects appears in at least one fixture call**, checked by walking the
    manifests, so the "enumerate, do not sample" rule is a test, not a habit;
  - an unlisted flag makes every command `unknown`;
  - a hardened argv describes exactly as the original;
  - the descriptions meet `free()` the way EFFECTS.md says.

## What the format says, beyond PROGRAM_MANIFEST.md's table

- **Per command** (a program or a subcommand):
  - `effects` over its targets;
  - `paths`: `none`, `operands`, `{ operandsFrom }` or `repo`, where `repo` is the cwd, or the value of a `valueIsDir`
    flag like `git -C`;
  - `noPaths` (`cwd` or `nothing`);
  - `terminator`, `numericFlag`, `clusters`, `maxOperands`;
  - `subcommands`;
  - `syntax: "find"` with its `primaries`;
  - `okCodes`, `echoes`, `recursive`, `harden`.
- **Per flag**:
  - `value` / `optionalValue`;
  - `effects`;
  - `valueIsPath` (`read`/`write`) and `valueIsDir`;
  - `pathsFrom` (`rg -e`, `jq -f`);
  - `runner`, `echoes`, `okCodes`, `recursive`.
- **A flag with no path value applies its read/write to the command's own targets.** `git push -u` writes the
  repository's config. The first version applied it to nothing, and the fixture review caught it.
- **`harden`** (ruling of 2026-10-15): arguments the caller inserts after a command's name, all of them flags that
  command lists. They are `git --no-pager`, and `--no-ext-diff --no-textconv` for `diff`/`log`/`show`/`blame`. An explicit `--ext-diff` written after
  them still wins, and is still described as a runner: hardening never hides what the call asked for.
- **`recursive`**: `rg` and `find` are recursive, and so is `ls -R`. A recursive call's path operands carry `walk: true`,
  and the host answers `containsSecret` for each (window-ml-host PR #2).
- **Every description says why it is `unknown`** (`why`), for the card.

## Assumptions where the spec was silent

- **A version is required**, and an unreported one is `unknown`, except for a manifest whose range is `"*"` (below). The
  host does not report versions yet, so in practice only the six unversioned manifests describe anything until it does.
- `git`'s rev and pathspec operands are not paths: pathspecs stay inside the repository by git's own rule, and the
  call's target is the repository. `git diff --no-index` is the exception, and is `unknown`.
- **What is deliberately `unknown`**:
  - git's global `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, `--bare` and
    `--paginate`;
  - `git branch` with an operand;
  - every unlisted subcommand (`commit`, `checkout`, …);
  - `rg -L`/`--follow`, `ls -L`/`-H`, `find -L`/`-follow`: following symlinks out of the named paths, where the host
    cannot check;
  - jq's `--arg`, `--argjson`, `--rawfile` and `--slurpfile` (two values each; the format has one), and `--args`/
    `--jsonargs` (operands stop being files).
- `git fetch` is `write(repo) + exec(process) + read(net)`. `git push` is `read(repo) + exec(process) + read/write(net)`.
  Both run hooks (`reference-transaction`, `pre-push`), hence the `exec`.

## What a spec got wrong, or did not say (sent to repl-specs, which ruled; specs amended by repl-specs)

1. **BSD userland reports no version.** `ls`, `cat`, `wc`, `head`, `tail` and `find` on macOS have no `--version`.
   Ruled: `"range": "*"` with no version arguments, and such a manifest lists only flags with the same meaning in GNU and
   BSD (the subagent's list of flags left out for that reason is in the PR).
2. **A git read depends on the repository's config.** Ruled: the manifest hardens (`harden`), the host pins
   `core.fsmonitor` and `core.pager` and reports `repoConfigRunsCode`. Measured on the way: pinning `diff.external` to
   empty breaks every `git diff`, so it is not pinned (the ruling was amended).
3. **A directory walk reads the secrets in a root.** Ruled: manifests mark recursive readers, and the host walks
   (bounded) and reports `containsSecret`.
4. **The env rule is two lists.** Ruled: REFUSED (the host's denylist) and FREE (locale, time zone, colour, width,
   `TERM=dumb`), now `env.free` in the facts.

## What did NOT work, or was left out

- **The host does not use the Rust reader in `spawn` yet**: the worker still sends `pathArgs`, `walk`, `walkCwd` and
  `repoArg`. Wiring it in (and reporting the program's version, which only a manifested program should be asked for)
  is the host's extension-side root.
- **Two-valued flags** (`jq --arg name value`) cannot be expressed; they are `unknown`, so most real jq calls ask.
- **A path attached to a short flag** (`git diff -Oorder.txt`) is `unknown`: the host can split only on a separator.
- **`cat` on a UNIX socket** connects to it on BSD, more than a read. Only a file-type check by the host would catch it.
- **jq's `import`/`include`** read modules from `~/.jq` and the search path, which the filter text names and no flag does.
- **`rg -f -` and `jq -f -`** mark `-` as a path, which the host resolves as a file named `-` in the cwd. Harmless (it
  does not exist; stdin is closed), but imprecise.
- **`find` honours no `--`**, so a value from a variable that starts with `-` cannot be protected by a terminator for find.

## How the work was split

I wrote the format, `describeCall`, the validator, `git`'s manifest and fixture, and the tests. A second Sonnet subagent
ported the reader to Rust; its report came back empty, so I verified it directly (the vectors match, and a deliberately
wrong port fails them). A Sonnet subagent wrote
the other eight manifests and fixtures: it wrote each expectation by hand, then compared it with `describeCall`'s output
line by line. It found that `find`'s pre-options ignored an `unknown` effect, which is fixed in the module.
