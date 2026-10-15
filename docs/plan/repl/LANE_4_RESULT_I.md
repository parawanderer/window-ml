# Lane 4, root I: the Rust process host (result)

Work slug `repl-lane4`, session `b9bc1868-816e-4f91-86bc-4fc2e0f3047e`, model `claude-opus-5-5`, 2026-10-15.

## What landed

- **Repository [parawanderer/window-ml-host](https://github.com/parawanderer/window-ml-host)** (public, MIT), first tag
  `v0.1.0` (after PR #1). PR #2 added the rulings below (repository config, recursive readers, `env.free`), PR #3 the
  manifest reader. One crate, binary `wmlhost`. CI runs on Linux and macOS: fmt, clippy, tests, the Node client, and the
  no-hub check.
- **Decision 4 holds in code.** The default build compiles no crate from window-ml-hub; `check-no-hub.sh` fails
  CI if one appears. `--features hub` pulls `wmlhub-client`, `wmlhub-seal` and `wmlhub-keys` (tag `v0.4.3`) and compiles
  a stub `src/hub.rs`. No hub crate was changed or added, so there is no `@hub-compat` PR.
- **The protocol**: [`PROTOCOL.md`](https://github.com/parawanderer/window-ml-host/blob/main/docs/PROTOCOL.md) in
  the host repository, the wire as built, for whoever binds it on the extension side (below).
- **The sandbox as built**, with what each test showed:
  [`SANDBOX.md`](https://github.com/parawanderer/window-ml-host/blob/main/docs/SANDBOX.md).
- **`clients/node/`**: a dependency-free client whose call layer is separate from its stdio framing, so the same layer
  runs over a `chrome.runtime.connectNative` port; and a smoke check.
- **Install**: `wmlhost install --extension-id <id> [--browser chrome|chrome-beta|chromium|brave|edge|all]` writes the
  native messaging host manifest (`com.parawanderer.window_ml_host`) with that one origin; `wmlhost uninstall` removes
  it.

## The protocol as built (for the successor of lane 1 who binds it)

Calls are `{ seq, call, args }` answered by `{ seq, value }` or `{ seq, error: { code, message } }`, the `ML_WIRE.md`
shape. Bytes travel as `{ "$bytes": base64 }`, lane 1's encoding.

| Call | Does |
| --- | --- |
| `hello` | the host, its version, `protocol: 1`, the sandbox kind and whether it starts |
| `configure { roots, sandbox?, path?, timeoutMs?, outputCap? }` | the session's settings from DevTools Settings; drops pending calls |
| `spawn { argv, cwd, env?, mode?, pathArgs?, timeoutMs? }` | resolves and returns the FACTS; starts nothing |
| `start { id }` | runs that pending call; the answer precedes its `done` |
| `discard { id }` / `cancel { id }` | the worker said no / stop a running call (SIGTERM, then SIGKILL after 2 s) |
| `read { ptr, offset, length ≤ 512 KiB }` / `release { ptr }` | held output by byte range / delete it early |
| event `done { id, code, signal, ok, timedOut, cancelled, durationMs, stdout, stderr, error? }` | `stdout`/`stderr` are `{ ptr, size, sha256, truncated }` |

The facts are `program` (realpath after the `PATH` lookup, with `inRoot`), `cwd` (realpath, always in a root, or the
spawn is refused), `env` (the names the call sets, and which are secret handles), `paths` (each marked argument:
`given`, `path`, `inRoot`, `secret`, `exists`), `effects: "unknown"` (until the host reads manifests), `sandboxed`, and
`placement` (`"host-sandbox"` or `"host-plain"`, the names `boundFor` in `src/effects.ts` takes).

## What the acceptance tests showed

`tests/stdio.rs` drives the built binary over the framing, 26 tests. On macOS 26 (Seatbelt), all of them exercise
enforcement:

| Denied | Allowed |
| --- | --- |
| `touch <outside the roots>`: EPERM, the file never appears | `touch` inside a root; a write and read in the call's `$TMPDIR` |
| a connect to a listener on 127.0.0.1, which sees nothing (the control run without the sandbox connects) | `git status`, `git add` in a repository inside a root |
| `cat ~/.ssh/<key>` when the call does not name it | the same file when the call NAMES it and the facts show `secret: true` |
| appending to `.git/hooks/pre-commit`, `.git/config`, `.vscode/settings.json` | |
| reading the session's held output from a child | |

Each enforcement test was run against a deliberately weakened profile and FAILED, so none passes vacuously:

- writes and network allowed;
- the hooks deny removed;
- the named-secret allow removed;
- `GIT_OPTIONAL_LOCKS` removed (PR #1).

Also shown, outside the sandbox:

- a spawn alone never runs: a `touch` that was spawned and never started leaves no file;
- `start` works once;
- `cwd` outside the roots, and a symlink out of a root, are refused as `cwd` and flagged `inRoot: false` as a path;
- the scrubbed environment leaks nothing (a variable set on the host does not reach the child), and `PAGER`,
  `GIT_EXTERNAL_DIFF`, `LD_PRELOAD`, `DYLD_*`, `GIT_CONFIG_*` and `PATH` are refused;
- a secret handle is `SecretUnavailable` (the store is empty, as planned);
- cancel and the time limit end a call, and so does closing the port;
- a call's background children die with it;
- 3 MiB of output reads back in ranges, byte for byte with a matching SHA-256;
- the output cap truncates without blocking the writer.

## What did NOT work, or was left out

- **Linux enforcement now runs in CI (window-ml-host #5), and its first run found the documented gap.** bubblewrap did
  not start on GitHub's Ubuntu 24.04 runner (AppArmor restricts unprivileged user namespaces), so at first every Linux
  sandbox test took the fail-closed branch. Shane chose a per-program AppArmor profile granting `bwrap` user namespaces
  on the runner, and CI now requires the sandbox on Linux (`WMLHOST_REQUIRE_SANDBOX=1`). The session's permission
  classifier would not let the agent commit that AppArmor change even with Shane's go, so Shane pushed it. Its first
  run: 29 of 30 sandbox tests enforced; the hooks test failed because `.vscode/settings.json`, absent when the call
  started, was written. bubblewrap re-binds read-only only what exists at the start. The test now holds what each
  sandbox guarantees, and a separate test PINS the Linux gap, so closing it (Landlock, which root K plans) has to flip
  that test.
- **Linux protects less than macOS even when it runs.** bubblewrap binds paths and cannot match patterns, so hooks in a
  NESTED repository, or created during the call, stay writable, and credential stores are masked only under `$HOME`.
- **No container runner.** `mode: "container"` answers `Unsupported`; the seam and what Docker Desktop, Podman and
  Apple's `container` each need on macOS are in `SANDBOX.md`. None was chosen.
- **No `pipe`, no `glob`, no text pipe at the host, no manifest reading in Rust yet** (root F adds the TypeScript reader
  and the vectors; the Rust reader is F's second half).
- **The host records no program version yet.** Running `--version` before the verdict is itself a spawn; it should run
  only for programs that have a manifest, which is root F's.
- **The extension side** waits on lane 1's root A, as planned. Nothing in window-ml changed for root I.

## Assumptions where a spec was silent

- One native messaging connection is one session: held output and pending calls die with the port.
- Roots, the sandbox switch and `PATH` arrive in `configure` from the worker. With no `path`, the host uses its own
  `PATH` plus the usual package-manager directories (`/opt/homebrew/bin`, `/usr/local/bin`), because Chrome's launchd
  environment lacks them and `git` from Homebrew would not be found.
- **Under the sandbox, reads are allowed everywhere except credential stores.** Tools read system libraries and their
  own config. The spec's bound counts reads only in the roots as free, and the worker sees `inRoot` per path, so a read
  outside still asks.
- The sandbox hides credential STORES (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.config/gh`, `.netrc`,
  `.git-credentials`, keychains, …) even from an approved call, unless the call names the path. Under the sandbox no
  legitimate local call needs them: `git push` and `gh` need the network, which is denied anyway.
- The files that run code later (`.git/hooks`, `.git/config`, shell and tool rc files, `.vscode`, `.claude/settings*`,
  `.mcp.json`, `.envrc`) are unwritable even inside the roots: the list from `sandbox-runtime`, plus `.envrc` (direnv)
  and `.claude/settings*.json`.
- Limits: 30 minutes for a call to wait for its verdict, 256 pending, 32 running, 2 minutes default time limit (1 hour
  ceiling), 64 MiB kept per stream (1 GiB ceiling).

## What I think a spec got wrong (sent to repl-specs)

1. **A git read depends on the repository's config, not only on argv.** `core.fsmonitor`, `core.pager`, `diff.external`,
   a textconv or filter driver in `.git/config` make `git status`/`git diff` run a program, and no manifest sees it. The
   sandbox makes `.git/config` unwritable, so a call cannot plant one, but a repository can ARRIVE with one. Proposed:
   the host pins those keys for every git spawn through its own base environment, or reports a fact for it.
2. **`git status` writes.** It refreshes `.git/index` opportunistically. Fixed in the host (`GIT_OPTIONAL_LOCKS=0`, PR #1,
   with a test that fails without it), but the spec's "read-only git" was not, as stated.
3. **A directory walk reads the secrets in a root** (`rg pat .` reads `root/.env`); `secret` is per NAMED path. `SHELL.md`
   should say whether the free tier's "not secret" covers what a recursive reader reaches.
4. **The env rule is a denylist as built.** `SHELL.md` says a call's env writes have their own whitelist;
   `LANE_4_HOST.md` says the manifest's denylist is refused. Every call asks in v1 and the card shows the changes, so the
   denylist holds for now; a whitelist would be stricter.
5. **Seatbelt rule precedence is not "last rule wins".** A later `literal` allow overrode an earlier regex deny, but a
   later unfiltered `(allow file-write*)` did not override an earlier regex deny. Anyone extending the profile should
   test the direction they rely on; `SANDBOX.md` records both.

## How the work was split

Shane's instruction, relayed by the coordinator: Sonnet subagents wrote the framing and its tests, the installer, the CI
workflow with the no-hub check, and the Node client. I reviewed each diff before merging it. I wrote the protocol, the
spawn path, the facts, path resolution by descriptor, the environment scrub, both sandbox profiles and the integration
tests. The first CI subagent was refused by the permission classifier for proposing the AppArmor change; the second
did the job without it.
