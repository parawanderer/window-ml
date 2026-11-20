# One describer: the build (spec, ruling 90)

Spec, 2026-11-20, by `program-manifest-backfill` (session ee7315a7). Nothing is built before this merges. The spike and
its numbers are [ONE_DESCRIBER_WASM_SPIKE.md](ONE_DESCRIBER_WASM_SPIKE.md); the cold-wake measurement that ruling 90
asked for first is its item 2 and the notebook's section 6. Red team: e3.

## What changes

window.ml stops describing `ml.sh` calls in TypeScript. The service worker runs window-ml-host's describer
(`src/manifest.rs`, `src/script_grammar.rs`), compiled to `wasm32-unknown-unknown` at opt-level `z`, built and
published by the host's release, pinned in window.ml by sha256. The shared vectors stay and run against the wasm.

Shape (b), the coordinator's call: the bytes are in `background.js`, compiled with `new WebAssembly.Module` when the
worker's script evaluates. Measured: 3.2 ms median and 8.0 ms p95 added to a cold wake, against 3.0 and 8.1 ms for
shape (a), and no 88 to 101 ms first compile at install. There is no not-yet-loaded state for the gate to handle. I
see no reason for (a): its one advantage, a smaller script to parse on every wake, is already inside the measured
figure.

## 1. The finding that changes the ABI: path resolution

The spike compared the two describers WITHOUT path resolution, and so do the vectors. The gate does not. `shFacts`
(`src/shell/sh-call.ts`) passes `describeCall` a `resolve` callback that turns each path argument into the resource
the host reported (realpath, `inRoot`, `secret`, `exists`, the roots it falls under). `describeCall` decides
`described` first, then maps every effect term's targets through `resolve`, then `union`s the sets
(`src/shell/program-manifest.ts`, after `if (!d.described)`). The Rust `describe_call` takes no resolver: every
filesystem key it makes ends `:?:?`.

A raw wasm ABI cannot call back into JS once per path, and should not. So:

- **The host** gains a function that returns the description BEFORE resolution: `described`, `why`, `pathArgs`,
  `actsOnDir`, `runner`, `okCodes`, `echoes`, `recursive`, `harden`, and for each effect term its targets. A target is
  either a placeholder (`{arg, given}` with `arg` an argv index, `"cwd"` or `"repo"`) or a literal resource. This is
  the structure the TS describer builds internally before resolving.
- **The worker** keeps the resolution step: `resolve`, `fromProgramEffect` and `union` stay in TypeScript
  (`src/effects.ts` is the policy engine's own module and stays anyway). It is about 30 lines moved out of
  `describeCall` into the caller.
- **The vectors** gain rows run with a fixed fake resolver: a map from argv index to resource, including two
  arguments that resolve to the same path and one that resolves outside the roots. They compare the resolved effects.
  These rows are new in both repos and must pass against the TS describer before the switch, so they test the move
  and not only the wasm.

## 2. Where it lives, and what the sidebar must not load

- `sw-describer.ts` (new, in `src/sw/`, worker only) holds the bytes and the instance. `build.mjs` gives esbuild a `binary`
  loader for `.wasm` on the `background` entry only.
- `planSpawn` and `shFacts` (`sh-call.ts`) take the describer as a parameter. Today `sh-call.ts` imports
  `describeCall` statically, and the sidebar imports `sh-call.ts` for `shCardLines`, `quoteArg` and the export's
  lines. If the bytes were imported there, every sidebar bundle would carry 292 kB of base64.
- **Row:** the built sidebar, popup and offscreen bundles do not contain the wasm. Grep for the module's magic bytes
  as base64 (`AGFzbQ`), or check the bundle size against a ceiling.

## 3. Failure makes the call ask, never throws past the gate

`describe(argv, manifest, opts)` in `sw-describer.ts` never throws. Each of these answers "not described", with the
reason as its `why` line:

| Case | `why` | Recorded |
| --- | --- | --- |
| The module failed to compile or instantiate at script start | `the describer did not load: <name>` | housekeeping, once per worker start: `subsystem: "shell"`, `kind: "describer-unavailable"` |
| A trap during a call (`RuntimeError`) | `the describer failed on this call` | run log (`noteRunMechanic`), `kind: "describer-trap"`; the instance is dropped and re-instantiated from the compiled `Module` on the next call |
| The reply is `{error}` or not JSON | `the describer could not read this call: <error>` | run log, `kind: "describer-error"` |
| The manifest does not parse on the Rust side | `the describer could not read this manifest` | run log, plus housekeeping once per manifest hash |
| argv, `envSet` or the flavour holds a lone surrogate (section 4) | `an argument is not well-formed text` | none: the page chose it |

"Not described" already means `effects: "unknown"`, which `free()` never passes (`src/effects.ts`), so the call
reaches `raiseAsk` (`sw-shell-call.ts`, `decide`). That path exists today and is not changed. Two existing outcomes
stay as they are and are stated here so nobody is surprised:

- An undescribed call that names `/files` is refused, not asked (`filesPlaced`, `filesRefusal`). With the describer
  unavailable, such a call is refused, and the refusal adds the `why` line.
- The manifest proposal's evidence run skips undescribed calls. With the describer unavailable it gathers no
  evidence, and the card says why.

Today a THROW from `describeCall` inside `runCall` becomes `refuse("Failed", …)` (`failure`, `sw-shell-call.ts`),
not an ask. After the change nothing on the describer's side throws, and a test pins that: a describer stub that
throws, through `runCall`, ends in an ask.

**Rows:** one per line of the table above, through `runCall`, each asserting the ask (or the `/files` refusal) and
the record. A trap followed by a well-formed call: the second call is described.

## 4. Lone surrogates

serde_json refuses a lone surrogate's escape, so the spike's wasm returned an error on 4 to 7 calls per fuzz run
where TS described. The worker checks `isWellFormed()` on every argv entry, every `envSet` name and the flavour BEFORE
encoding. If any fails, the call is not described and asks (section 3). It must NOT call `toWellFormed()`: that
would describe an argv that is not the one that runs.

Ruled 2026-11-20 (the coordinator, on this PR): the call asks. e3 establishes what the native port does with a
lone surrogate when the person approves (Chrome's JSON writer for native messaging is unverified here; if the frame
reaches the host, serde_json refuses it). A refusal in `parseShRun` (`BadRequest`, beside its NUL check) is a later
change, not part of this build.

## 5. The TS describer: deleted

Delete `describeCall`, `hardenArgv` and `inRange` from `program-manifest.ts`, with their TS-only tests. The vector
replay moves to the wasm. Keep everything else that has users today: `validateManifest` (stored and proposed
manifests), `shippedOnlyRefusal`, `scriptLacksRunsCode` and its warning, `CREDENTIAL_PROVIDERS`, `revealsRefusal`,
`flavourOf` (detection from the host's facts, which is the extension's job; Rust's `describe_call_as` takes the
flavour as an input), and the types.

Not kept as a test oracle. An oracle has to be maintained like a port: of the 31 findings on the describer's PRs, 14
were costs of having two (the notebook's section 5), and one, borderline, was a catch. A port nobody ships drifts,
and then fails tests nobody can act on. What replaces the cross-check is what the spike recommended: the vectors,
the red-team suites, and a property fuzz against the wasm alone, over the recorded vectors' mutations. Its
properties: a refused word stays refused under any splice; a described call stays described when an operand is
renamed; the resolved effects never contain an unresolved placeholder. The differential harness stays in
`notebooks/shell/one-describer/` as history and is not run in CI.

**Before `describeCall` is deleted: one more differential run, with resolution.** Once the host returns the
description before resolution (section 1), the spike's differential fuzz runs once more with a fixed fake resolver.
The resolver is deterministic per argv index: some arguments inside the roots, some outside, one secret, two that
resolve to the same path. The run compares the TS describer with `resolve` against the wasm's pre-resolution
description put through the TS resolution step, on the resolved effects. The bar is 0 disagreements on resolved
effects, recorded in the notebook as a new section with the commits of both sides. A disagreement stops the
deletion until it is understood.

## 6. Build, pin, and the row that fails on disagreement

**In window-ml-host:**

- A `describe-wasm` crate in the host repo (a workspace member, a `cdylib`), the spike's wrapper moved there,
  `#[path]` no longer needed. It is built with the host's pinned toolchain (`rust-toolchain.toml`, 1.98.1; ruled
  2026-11-20). The spike used 1.99.1 and 1.98.1 has not been tried; if it fails, the toolchain bump is its own host
  PR, before this one.
- `release.yml` (tag `v*`) gains a job: build at opt-level `z`, run the host's vectors against the built `.wasm` from
  Node (a small replay script in the host repo), and attach `describe.wasm` with its sha256 to the same release as
  `wmlhost`. If the replay fails, nothing is published.
- The release also attaches `describe.json`: `{commit, vectorPin, sha256}`, where `vectorPin` is
  `tests/manifest_vectors.rs`'s `VECTOR_PIN`.

**In window-ml:**

- `tools/host-dist.json` gains `describer: {file, sha256, vectorPin}`, at the SAME tag as the binary. One pin means
  the describer and the process host it describes for cannot drift apart. `npm run fetch-host` fetches and checks it
  the way it does the binary (against the pin, never the release's own `.sha256`).
- **The bytes are committed** (`src/sw/describer/describe.wasm`, 219 kB), not fetched at build time. A fetched file
  is a seventh silent absence (AGENTS.md lists six), and its absence would turn every `ml.sh` call into an ask with no
  other sign. A committed file cannot be absent, CI needs no network for it, and a bump shows in review as a changed
  hash. The cost is 219 kB of history per bump. Ruled 2026-11-20: committed, with row 4 below.

**The rows that fail when the pin and the host's describer disagree** (window-ml, `tests/program-manifest.test.mjs`
or a new `describer-pin.test.mjs`):

1. The committed `describe.wasm` hashes to `host-dist.json`'s `describer.sha256`.
2. `host-dist.json`'s `describer.vectorPin` equals window-ml's `VECTOR_PIN`. A vector change in window-ml without a
   host release that carries it fails here, by name, before any replay.
3. Every vector row, plain, flavoured and resolved (section 1), replays through the committed wasm, as it does
   against the TS describer today.
4. The committed bytes equal the release asset at the pinned tag: `npm run fetch-host` (or a `--check` mode of it)
   downloads `describe.wasm` from the tag in `host-dist.json`, and its sha256 must equal both the pin and the
   committed file. The unit suite has no network, so this runs where `fetch-host` already runs against the network
   (`tests/fetch-host-pin.test.mjs` keeps its mocked fetch for the logic); without the check, a committed file could
   match its own pin and not the release.

## 7. The upgrade rows

Old state meets the new code in two places.

**Stored manifests.** `ml_manifests_global` and `ml_manifests_workspace` hold manifests that the TS validator
accepted. The Rust `Manifest` has `deny_unknown_fields` and fewer keys than `validateManifest` accepts. Read at host
`origin/main`:

- It has no `$schema`, `entrypoint` or `reveals`, all three in the TS validator's `MANIFEST_KEYS`.
- Its `version` is required, and an entrypoint (script tool) manifest has none.

No shipped manifest uses these, but stored script tools do. Without a host change, every call to a stored script
tool, which is described today, would ask after the upgrade. So, before the switch:

- The host's `Manifest` accepts every shape `validateManifest` accepts: `entrypoint` with an optional `version`
  (exactly one of the two, as the TS type says), `reveals`, and `$schema` ignored.
- **Row (enumerated, not sampled):** every manifest the test suites feed `validateManifest` and expect it to accept
  (shipped manifests, the stored-manifest and proposal fixtures, `tests/fixtures/` corpora) parses in the wasm.
- **Upgrade fixture:** a `chrome.storage.local` image as the current code writes it, holding an entrypoint script
  manifest, one with `reveals`, and one with `$schema`, read by the new worker. Each one's call is described exactly
  as before, and its effects key matches what the old code would have stored in a policy.
- A stored manifest the wasm still refuses gets section 3's "could not read this manifest": the call asks, and
  nothing throws.

**Remembered policies.** A policy matches on effects, not on `why`. The fuzz found the two describers' unresolved
effects identical over 340,000 calls; the `why` text differs (quoting, an astral character in a cluster). A remembered
policy is judged on RESOLVED keys (section 1), which the spike did not compare. **Row:** a policy remembered under
the TS describer, from the policy corpus (`tests/fixtures/policy-corpus.json`), still matches the same call under the
wasm. This holds for both the unresolved keys and the resolved ones, through the same fake resolver as section 5's
run, with a path inside the roots, one outside and a secret.

## 8. Handle ABI: no, for now

A handle ABI (parse each manifest once, describe by handle) would remove most of the per-call cost (wasm 39 µs
median and about 0.4 ms p95, against 1.7 µs for TS). It also adds a cache keyed by manifest that must be invalidated
when a stored manifest changes, and that state dies with the worker. On a call that then spawns a process, 0.4 ms is
not worth new state. The trigger to revisit it is a measured p95 above 2 ms on a real run.

## 9. Red team (e3)

What a hostile page must not get, as tests that fail first:

- A page-started `ml.sh` whose argv makes the describer trap, error or refuse never runs free. It asks, or is refused
  for `/files`. The origin gate in front of it is unchanged.
- A lone surrogate anywhere in argv, the env names or the flavour asks (or is refused, if section 4's question is
  ruled that way). It is never described with a replaced character.
- No state leaks between calls through the instance's linear memory: a call after a trap, and a call after one with
  a very large argv (at `SH_LIMITS`), describe the same as on a fresh instance.
- A proposed manifest crafted to be slow or deep for serde (nesting, long flag lists within the validator's limits)
  does not stall the worker. Bound the time per call, or show the validator's limits already do.
- The wasm is not reachable from any page, content script or the sidebar (section 2's bundle row, plus a check that
  nothing outside `src/sw/` imports `sw-describer.ts`).

## 10. Order

1. Host PR: the manifest shapes of section 7, the pre-resolution description of section 1, and the resolved vector
   rows. The TS side's resolved rows land in window-ml in the same round, against the TS describer.
2. Host PR: the `describe-wasm` crate and the release job. Host PRs merge by hand. The host tag is Shane's word,
   given in host-setup's own session; no other session tags the host.
3. The differential run with resolution (section 5), recorded in the notebook, as its own window-ml PR.
4. window-ml PR: the pin, `sw-describer.ts`, the wiring and resolution move, sections 3 and 4, deleting the TS
   describer, every row above, and e3's red-team tests.

There is no urgency against the `ml.table` work.

## Ruled on this PR (2026-11-20, the coordinator)

- The bytes are committed, with a row comparing them to the release asset at the pinned tag (section 6, row 4).
- A lone surrogate asks; e3 establishes what the native port does; a refusal in `parseShRun` is a later change
  (section 4).
- The wasm is built at the host's 1.98.1; a bump only if that fails, as its own host PR (section 6).
- The path-resolution finding and section 1's ABI are accepted.
