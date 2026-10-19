# Lane 4, root K, slice K1: interpreted scripts pinned by sha256 (result)

Work slug `repl-lane4`, session `b9bc1868-816e-4f91-86bc-4fc2e0f3047e`, model `claude-opus-5-5`, 2026-10-19. Spec:
`PROGRAM_MANIFEST.md`, "Interpreted script tools"; the root-K row of [`README.md`](README.md). Rulings: the coordinator's
of 2026-10-19 (session-mail `20261019-0940Z-repl-specs-to-repl-lane4-k1-answers.md` and
`20261019-1010Z-repl-specs-to-repl-lane4-k3-assignment-and-envelope.md`).

## What landed

- **window-ml-host [#8](https://github.com/parawanderer/window-ml-host/pull/8)**, tag `v0.4.0`. `pathArgs[].hash`
  adds `sha256` to the path fact: the hash of the resolved file, after symlinks. `start` and `pipe` hash it again
  and refuse with `PinChanged` if it changed since `spawn`.
- **window-ml #763.** A manifest with `entrypoint: { path, sha256 }` has no `version`; `ProgramManifest` is a union
  on it. The call is described only when all of these hold:
  - argv[1] is the script, with no interpreter flag before it;
  - the resolved file is `<root>/<path>`;
  - its hash is the pin;
  - the call runs under the sandbox.

  A `PinChanged` start is handled in two ways:
  - a call no person approved is described again, once, from fresh facts;
  - a call the person approved is refused, naming both hashes, and the run log records them.

  No script manifest ships: a pin is per repository, and the store is K2.

## What the tests showed

There is one test per ruling:
- any flag before the entrypoint leaves the call undescribed;
- the hash is of the resolved file, and the path must resolve to the entrypoint itself;
- a person-approved call that changed is refused, with both hashes in the error and the log.

There are also tests for:
- the plain host;
- a wrong or unreadable hash;
- an argv[1] outside every root that resolves to the entrypoint, which is undescribed by intent;
- a symlinked entrypoint file with the pinned content, which is undescribed by intent: a pin names a path and a hash;
- the default unchanged: `node scripts/index.mjs` is unknown and asks.

Each rule was broken in turn and a test failed, on both the host and the extension.

## Known gap: the window between the re-hash and the interpreter's open

The host hashes the entrypoint again at `start`, then execs the interpreter, which opens the script by path. Under
the sandbox, writes inside the roots are allowed, so a CONCURRENT call can rewrite the script in that window, and the
interpreter then runs bytes nobody judged. K3's `write: "none"` envelope stops the call from rewriting its own
script, but not another call that may write the roots. Two closures, neither in scope:

- **an exec-time hash:** the interpreter, or a shim in front of it, hashes the file it actually opened and refuses
  on a mismatch;
- **an fd-passed script:** the host opens the file, hashes that open descriptor, and passes it to the interpreter
  (`/dev/fd/N`), so the bytes hashed are the bytes run.

## What a spec got wrong, and what is next

- PROGRAM_MANIFEST.md's Pin column reads as if a `version` could sit beside a script's pin. A script has no
  version: the manifest describes the script, not the interpreter.
- K2: the manifests store (workspace and global scope) and `propose_manifest`. K3: the sandbox `Plan` compiled from
  the call's effects, through a narrowing-only `envelope` on `start`, goes to a MiMo session; lane 4 reviews its host
  PR.
