# Lane 4: the Rust process host, and program manifests

Read `README.md` in this folder first, decision 4 in particular. Work slug `repl-lane4`; clone
`~/git/window-ml-repl-lane4` for the manifests, and a NEW repository for the host. Labels in this repo `@exec,@security`;
`@hub-compat` only if a hub crate changes. You own the host repository and a new `src/shell/` this round.

## Read before coding

- `docs/spec/SHELL.md` (all; "Where processes run", "One call", "Policies: what a shell call gives one", "The host's
  language", "Security invariants", "Slices"), `docs/spec/PROGRAM_MANIFEST.md`, `docs/spec/EFFECTS.md`,
  `docs/spec/SECRET_HANDLES.md` ("Processes as a sink": nothing to build yet, but the env injection point must exist).
- `docs/spec/RUNTIME_HUB.md` (Security 1: runtimes connect out and never listen; the `desktop` scope) for what the hub
  transport will later need, so the host's internal interface does not preclude it.
- The hub repo for the BUILD PATTERN, not for code to depend on by default: `~/git/window-ml-hub/crates/connector`
  (`wmlbox`: a native binary with pairing and grants), `crates/client`, `crates/seal`, `crates/keys`, and `vectors/`
  (cross-language test vectors).

## Root I: the host binary (first; it is the long pole)

**Where it lives (decision 4):** its own repository (suggest `window-ml-host`; confirm the name with Shane). Cargo
features: `native` (default; no hub code compiled), `hub` (optional; pulls `wmlhub-client`, `seal`, `keys` as git
dependencies). `cargo build` with default features must produce a binary that has never heard of a hub.

v1 scope, every call asking (nothing is free until a manifest and the worker's decision exist):

- **Native messaging transport**: stdio, 4-byte native-endian length prefix + JSON, Chrome's limits (a message from the
  host to Chrome is at most 1 MB, which is one more reason outputs are pointers read in ranges). An install script that
  writes the host manifest (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json`, Linux's
  equivalent) with `allowed_origins` set to the extension id passed on the command line.
- **The protocol with the extension** (its JSON will later ride `ML_WIRE.md`'s `ml.sh` call; keep the shapes
  compatible with the spec's `run`/`pipe`/`glob` and `{ code, ok, stdout, stderr }`): `spawn { argv, cwd, env, mode }`,
  answered first with the RESOLVED FACTS (`program` after `PATH` lookup, `cwd` resolved, each path argument the manifest
  marks with `realpath`, `inRoot`, `secret`; `effects` from the manifest or `unknown`; `sandboxed`), then after the
  worker's verdict `start { id }` or nothing; `done { id, code, stdout: ptr, stderr: ptr }`; `read { ptr, range }`;
  `cancel { id }`. The host never decides; it spawns only on an explicit `start`.
- **Spawn**: argv direct (`shell: false`), stdin closed, no TTY, a time limit, env from a scrubbed whitelist plus the
  call's additions (the env-variable denylist in `PROGRAM_MANIFEST.md` refused), `cwd` inside a root. **Host mode within
  workspace roots** and **container mode** are both in the spec; build host mode first and leave a clean seam for the
  container runner (Docker/Podman/Apple `container`: write down what each needs; do not pick yet).
- **Held output**: stdout and stderr captured to a per-session store on disk (hashed, size-capped, read by range);
  pointers are opaque ids. No text pipe at the host this round (that is a Rust port of `text-pipe.ts` checked against
  its tests as vectors, or an embedded QuickJS; a later root).
- **The OS sandbox, on by default, fails closed**: a Seatbelt profile generated per call (writes confined to the roots,
  network denied, `/dev/null` and the usual read-only system paths), `sandbox-exec` to apply it (Anthropic's
  `sandbox-runtime` is the reference for the profile text), `bubblewrap` on Linux. If the sandbox cannot start, the
  call reports `sandboxed: false` and the worker will ask; the host never silently runs unsandboxed.
- **Path resolution for the host's OWN reads** by descriptor without following symlinks, component by component on
  macOS (`O_NOFOLLOW`), `openat2` with `RESOLVE_BENEATH` on Linux; the secret-name patterns from `SHELL.md`.
- **A seam for secret injection** at spawn (an env entry whose value is a handle name resolved by the host's store),
  with the store empty this round.
- **Tests**: Rust integration tests that drive the binary over stdio (a `spawn` of `git status` in a temp repo, a path
  outside the roots refused, a symlink out of a root caught, the sandbox denying a write outside the roots and a
  network connect, `cancel` of a sleeping process, a 1 MB-plus output read in ranges), and a tiny Node script speaking
  the framing so lane 1 can later plug it in.

Nothing in the extension changes for I: its extension side waits on lane 1's A and is the next round's root.

## Root F: program manifests (after lane 2's D merges; start on the format meanwhile)

- A new `src/shell/` with `program-manifest.ts` and `manifests/<program>.json`: the fields in `PROGRAM_MANIFEST.md`
  (`effects` in the algebra, `paths`, `operands`, `runner`, `echoes`, `okCodes`, `env`), a validator, and
  `describeCall(argv, manifest)` returning the facts a policy sees. TypeScript, so the worker can resolve facts for a
  container call and the Rust host can read the same JSON (a Rust reader with the JSON as shared vectors, as the hub
  does it).
- Manifests for `git` (the read subcommands and the flags that turn them into writes or code: `--output`,
  `--ext-diff`, `-c core.pager`, `--upload-pack`), `rg`, `ls`, `cat`, `wc`, `head`, `tail`, `find` (without `-exec`,
  `-delete`, `-fprint`), `jq`. A fixture of argv lines per program with the expected facts; the "enumerate, do not
  sample" rule applies to flags that change the effect.
- Version pinning: name plus version range, `unknown` outside it; the host records the resolved path and `--version`.

## Questions already answered

Rust, not Node. The decision is the worker's; the host resolves and enforces. Native messaging first, the hub later as a
feature, never required. argv only, no shell, no string ever parsed. Outputs are pointers. Every call asks in v1.

## Report back

`LANE_4_RESULT_<root>.md` in this folder, per root: the repository and its first tag, what the sandbox denied and
allowed in the tests, what container mode will need on macOS, the protocol as built (so lane 1's successor can bind it),
what a spec got wrong.
