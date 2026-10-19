# Spec (WIP): one effect algebra for every description of a call

**Status: the algebra is built** (`src/effects.ts`, tested row by row in `tests/effects.test.mjs`); no consumer reads it yet. Written on 2026-10-15 to close the "one effect vocabulary, or one per consumer" question
in [`POLICIES.md`](POLICIES.md). Every spec that DESCRIBES what a call does ([`READONLY_LIBRARY_MANIFEST.md`](READONLY_LIBRARY_MANIFEST.md),
[`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md), [`SHELL.md`](SHELL.md), [`SECRET_HANDLES.md`](SECRET_HANDLES.md),
[`PYTHON_DIALECT.md`](PYTHON_DIALECT.md)) projects its own terms onto this one, and every policy reads this one.

## Three layers, said out loud

Every gated call in the extension is handled in three layers, and most of the confusion in the earlier specs came from
mixing them:

1. **Describe.** A manifest states what a call can affect and what it costs. Shipped or installed, the same for everyone.
2. **Decide.** A policy, or the person, rules on that description: run without asking, ask, or refuse.
3. **Enforce.** A container, the OS sandbox, the workspace roots, the Pyodide boundary, or the dialect's own interpreter
   bounds what actually happens, whatever was decided.

A describer never decides, and a decision never enforces. The algebra below is the language of layer 1, read by layer 2,
and layer 3 publishes what it bounds in the same language so the two can be compared.

## An effect is a set of (operation, resource) pairs

Not a label. A call's effect is a SET, because one call can do several things (`git push` writes the repository and
reaches the network), and because sets compare: "is this call inside what the sandbox bounds" is a subset test.

| Operation | Meaning |
| --- | --- |
| `read` | observes the resource |
| `write` | changes it |
| `exec` | starts code running there (a process, a callback outside mediation) |
| `use` | exercises a capability without observing it (a secret injected into a request it never sees) |
| `alloc` | takes memory or storage from it (bounded separately by cost, listed so a policy can see it) |

| Resource | Meaning | Where it comes from |
| --- | --- | --- |
| `heap(owned)` / `heap(unowned)` / `heap(arg i)` | values inside the interpreter; a manifest says `arg i`, the interpreter resolves it to owned or unowned at the call | the dialects |
| `fs(path)` | a file or directory, with `inRoot` and `secret` resolved by the host | the shell, package install |
| `net(host)` | a network destination | `ml.fetch`, the shell, package install |
| `process` | starting a program | the shell, runner flags (`xargs`, `npm run`) |
| `entropy` | the clock, randomness, anything the arguments did not carry | the dialects (`Date.now()`, `random`) |
| `secret(name)` | a credential the run was granted | [`SECRET_HANDLES.md`](SECRET_HANDLES.md) |
| `unknown` | the top element: a call nobody described | an unannotated function or program |

`unknown` is never inside any bound, so an undescribed call never runs without asking. `read(secret(name))` does not
exist in any vocabulary: a secret can be `use`d, never read, and a file the host flags as secret-looking is
`read(fs(path))` with `secret: true`, which is inside NO bound, below.

## Each vocabulary is a projection

| Spec | Its term | In the algebra |
| --- | --- | --- |
| library manifest | `pure` | `{}` over the heap, plus `read(heap(arg i))` for each argument |
| library manifest | `mutates(i)` | `write(heap(arg i))`; the interpreter turns `arg i` into `owned` (allowed) or `unowned` (refused) |
| library manifest | `cache` | `{}` (observationally pure by definition) |
| library manifest | `reads-external` | `read(entropy)` |
| library manifest | `external` | `unknown` unless the manifest names the resource |
| library manifest | a callback called outside the interpreter | `exec(heap(unowned))`, refused |
| program manifest | `read` | `read(fs(p))` for each path argument, nothing else |
| program manifest | `write` | `write(fs(p))` for the paths it names |
| program manifest | `runs-code` | `exec(process)` |
| program manifest | `network` | `read(net(host))` or `write(net(host))`, host from the arguments when the manifest says where, else `net(*)` |
| `ml.fetch` | a cached read | `{}` |
| `ml.fetch` | a live GET | `read(net(host))` |
| `ml.fetch` with a handle | | `read(net(host))` + `use(secret(name))` |
| package install | | `read(net(index))` + `write(fs(site-packages))` + `alloc` |

## What an enforcer bounds, and the free tier as a subset test

An enforcer publishes the set `B` of effects it bounds, meaning effects it makes harmless or impossible. The built-in
default policy of every consumer is then one rule:

```
free(c)  ⇔  c.effects ⊆ B(c.placement) ∪ ReadsInRoots(c)      with no fs(path) flagged secret in either set
```

**A path flagged secret is inside no bound, sandbox and container included** (ratified 2026-10-15, after lane 2 of the
plan built it stricter than this spec first said). The harm of reading `.env` or a key file is DISCLOSURE: its contents
reach the model's context, the run log and the export, and no enforcer bounds that. Seatbelt confining writes and
denying the network does not make the read harmless, so `B` never contains it; the only way such a read runs is a
person saying so, per call or by a policy they wrote. The default policy is a UNIVERSAL over the set ("every element is
a read on fs, in a root, not secret", plus whatever `B` adds), never a list of excluded operations: an exclusion list
forgets `use` and `alloc` the day they are added, a universal cannot.

| Placement | `B` |
| --- | --- |
| the page's main world | `∅` (nothing is bounded there, which is why the JS dialect must prove effects from the source) |
| a worker-side survey | `∅` for the same reason, with the dialect as the proof |
| the Python dialect (CPython's restricted mode), anywhere | `{ read/write/alloc on heap(owned) }` by the runtime's own gates, plus `read(entropy)` if allowed |
| a container | `read/write(fs(mounts))` less the secret-flagged paths, `exec(process)` inside it, `net(allowlist)` |
| host mode under the OS sandbox | `read/write(fs(roots))` less the secret-flagged paths and less the TOP-LEVEL NAMES of each root (below), `exec(process)`, `net(allowlist)` |
| plain host mode | `∅` |

Every process placement's `B` also carries `alloc(process) ≤ <bound>`, the footprint maximum of the row above
(2026-10-15); the plain host included, since the bound is the host's own and needs no sandbox.

**The top-level names of a root are outside `B` (ruled 2026-10-19, the case found by the red team's shell-policy audit:
`git diff --output=.envrc` was free).** `B` is what the enforcer HOLDS, and the OS sandbox holds the top level of a root
as name-immutable only under the narrow envelope ([`SHELL.md`](SHELL.md)); under the floor, Linux cannot refuse an absent
name at all. So the decide layer never counts a claim on a top-level NAME as covered: a claimed `write(fs(p))` where `p`
is a top-level entry of a root that does not exist, or a claimed `write-names(fs(p))` (a create, remove or rename of a
top-level entry, existing or not; [`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)) is covered by no bound, and the call
asks; a policy may allow it, scoped as any other. An in-place write to an EXISTING top-level file stays inside `B`,
because the floor holds it (a protected name is denied by the floor; a plain one is the person's file). The rule is a
universal over the top level, not a list of protected names, so an unlisted name (`.envrc`, `.mcp.json`) is never the
exception. A claim with no path (`cargo build` creating `target/` under a bare `write(fs(roots))`) is unaffected; the
cost falls only on calls that NAME a top-level path, once, until a policy remembers them. The resolved fact that carries
this is `ShPathFact.topLevel` (whether `path`'s parent is a configured root), computed by the worker from the host's
`realpath` and its own roots. **`write-names` is a manifest WORD, not an operation** (ruled 2026-10-19 on lane 4's
objection building K3c): it projects onto `write` with `names: true` on the `fs` resource, keyed apart from the
in-place write so the two never de-duplicate. A separate operation would make a person's policy fail open: `has("write")`
would never fire for `rm`, `mv` or `sed -i`, and a universal over `writes` would be vacuously true for `rm .envrc`.
The operations table stays as it is; `covers` reads `names` the way it reads `secret`.

So "the sandbox widens the free tier" in [`SHELL.md`](SHELL.md) is a definition, not a rule to hand-write per mode: a
write inside the roots is free under Seatbelt because Seatbelt publishes it in `B`, and asks on the plain host because
the plain host publishes nothing.

**No separate sandbox profile file (2026-10-17).** Layer 3 (the OS sandbox in `window-ml-host/src/sandbox.rs`) does not
introduce a fourth configuration language alongside manifests (Layer 1) and policies (Layer 2). Instead, the per-call
kernel sandbox `Plan` (macOS Seatbelt SBPL or Linux bubblewrap + Landlock) is compiled deterministically from the call's
approved `EffectsData` set $E(c)$, the workspace roots, and a fixed safety floor:

| Sandbox `Plan` Component | Source |
| --- | --- |
| **Invariant safety floor** (`denyRead` on `~/.ssh`, `~/.aws`, `~/.gnupg`, Keychains, `.netrc`; `denyWrite` on `.git/hooks`, `.git/config`, `.bashrc`, `.zshrc`, `.claude/`, `.vscode/`) | Hardcoded in `sandbox.rs` — never weakened by a manifest or policy |
| **Workspace secret files** (`.env*`, `*.pem`, `id_*` inside a root) | Denied at the kernel level by default; added to `plan.allow_read` only when the call explicitly named that path in `pathArgs` and the person or a policy approved it |
| **Writable directories (`plan.roots`)** | Empty (`write: none`, except the call's `$TMPDIR`) when $E(c)$ is described and contains no `write(fs)`; the workspace roots plus any manifest-declared `write(fs(p))` paths (such as a tool cache `~/.cache/uv` or `~/.cargo`) when approved |
| **Process execution (`exec`)** | Restricted to the resolved program/interpreter binary (`exec: program-only`) when $E(c)$ is described and contains no `exec(process)` (`runner: false`); unrestricted within the sandbox when `exec(process)` or `unknown` is approved: the worker then sends NO envelope and the floor applies, since a runner's writes derive from no manifest and both envelope keys are required (ruled 2026-10-19, [`SHELL.md`](SHELL.md), the envelope bullet) |
| **Network (`net`) and memory (`alloc`)** | Network denied unless $E(c)$ carries an approved `net(host)`; physical footprint capped at the `alloc(process)` bound (Root L) |

## What a policy sees

`c.effects` is this set, with helpers the policy realm provides so a policy is a set predicate and not a string compare:

```js
c.effects.has("write", "fs")                      // any write to any path
c.effects.writes.every((r) => r.inRoot)           // every written path is inside a root
c.effects.has("exec", "process")                  // the call starts another program
c.effects.uses("github")                          // the call carries that secret
```

A missing helper or field is a refusal in the policy realm, never `undefined` ([`POLICIES.md`](POLICIES.md), "The policy
realm"), so a typo in a `deny` is a broken policy the person sees rather than a rule that never fires.

## Open questions

- **`net(host)` granularity.** Host alone, or host plus path prefix, as the secret scopes need? Probably the secret's
  scope carries the prefix and the algebra stays at the host.
- **`alloc` as an effect** is decided (2026-10-15): it is an effect with a bound per placement, not only a cost. For a
  process placement the bound is a physical-footprint maximum the host enforces (a watchdog on macOS, a cgroup memory
  maximum on Linux), the measured footprint is a fact, and a policy may lower the default or raise it within what the
  person set ([`SHELL.md`](SHELL.md), "Every process has an owner"). For a value stored by the extension it stays the
  size cap the pointer store already applies.
- **Composition across a pipe.** A pipe's effect is the union of its stages'; whether a policy sees the union or each
  stage is the shell spec's to decide.
