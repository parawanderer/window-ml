# Spec (WIP): one effect algebra for every description of a call

**Status: draft, nothing built.** Written on 2026-10-15 to close the "one effect vocabulary, or one per consumer" question
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
| host mode under the OS sandbox | `read/write(fs(roots))` less the secret-flagged paths, `exec(process)`, `net(allowlist)` |
| plain host mode | `∅` |

So "the sandbox widens the free tier" in [`SHELL.md`](SHELL.md) is a definition, not a rule to hand-write per mode: a
write inside the roots is free under Seatbelt because Seatbelt publishes it in `B`, and asks on the plain host because
the plain host publishes nothing.

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
- **`alloc` as an effect or only a cost.** Listed here so a policy can refuse a call that would store a large value; it
  may belong only in the cost model.
- **Composition across a pipe.** A pipe's effect is the union of its stages'; whether a policy sees the union or each
  stage is the shell spec's to decide.
