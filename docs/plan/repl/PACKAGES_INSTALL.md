# Build brief: installing a Python package on demand (2026-11-09)

The packages lane's build brief for the install step, ruled by the coordinator on 2026-11-09 (item 1 of the lane's
open list; npm in `exec` and a shipped wheel allowlist declined, beyond-import behaviour and host placement recorded as
open, placement blocked on window-ml-host reading its own tags). It rests on two spec sections and changes neither:

- [`PYTHON_DIALECT.md`](../../spec/PYTHON_DIALECT.md), "Packages on demand": installing is its own step, gated by a
  policy or an approval and pinned by hash; three sources (`lock`, `mirror`, `pypi`), two of them local; one artefact
  per package, decided before download; the start-up set pins versions; an undeclared dependency is a second ask; and
  the coordinator's four-part ruling of 2026-11-09 (verdicts are a notebook extract, nothing enters `src/` as a list;
  the platform scan is a note on the card, never a refusal).
- [`POLICIES.md`](../../spec/POLICIES.md), the first-consumer paragraph (decided 2026-10-15): installing a Python
  package on demand is one of the two first consumers of the policy store, with the facts a name, a version, a source
  and a hash.

No `src/` change lands until this brief merges. Each slice below is its own PR.

## The slices

| # | Slice | Adds | Red team |
| --- | --- | --- | --- |
| 1 | The verdict | a pure TS module: does this package, at this version, install on this core, and as which files | no (its own hostile-metadata rows) |
| 2 | The card | the approval card that lists every file the approval covers, its hash and source, or refuses up front | yes, e3, rule 10 |
| 3 | The mirror and the download | the local mirror holding the pinned core's whole lock plus approved wheels; PyPI as the one gated network read; bytes checked against the card's hash | yes, e3, rule 10 |
| 4 | Install and rollback | loading the approved set into the sandbox; a failed import rolls the install back; the undeclared-dependency second ask; the platform scan's note | with 3 |
| 5 | Policy-store wiring | the four facts reach `sw-policies.ts` as POLICIES.md's first consumer, so a policy can allow or deny an install without a card | yes, with the policy realm's own tests |

Slice 1 has no caller outside its tests. Slices 2 and 3 can be built in either order against slice 1's output.
Slice 4 needs both, and slice 5 needs slice 2, since a policy replaces the card's question and nothing else.

## Slice 1: the verdict

### Module boundary

One new module in `src/python/` (`pkg-verdict.ts`), pure: no `fetch`, no `chrome`, no Pyodide, no storage, no clock. It takes
plain data and returns plain data, so it runs the same in the worker, the offscreen document and `node:test`. As built,
its two parsers are files of their own beside it (`pkg-pep440.ts`, `pkg-pep508.ts`), equally pure.

```ts
verdict(request: { name: string; version?: string }, core: CoreFacts, index: IndexView): Verdict
```

- `CoreFacts`: the compatible tag set, the marker environment and `python_full_version`, the lock (name to version,
  file and dependencies), and the preloaded set (packages already loaded that cannot move). All of it comes from the
  pinned core. Nothing about the person or the run goes in.
- `IndexView`: a synchronous lookup from a canonical name to that project's metadata (release versions, each release's
  files with filename, sha256, size, `yanked` and `requires_python`, and the chosen release's `requires_dist`). The
  caller fetches. Slice 1 only reads what it is given, which is what keeps it pure and lets the fixture drive it.
- `Verdict`: either `{ ok: true, files: [{ name, version, filename, source, sha256?, size? }], loaded }`, the whole
  closure as one file per package with `source` `lock` or `pypi` (`mirror` arrives with slice 3, the digest and size
  only on a PyPI file, since the core's own loader checks a lock file) and `loaded` the closure's packages already
  loaded, or `{ ok: false, reason, at }`, where `reason` is one of `no-build`, `python-version`, `lock-too-old`,
  `not-on-index`, `too-large`, `malformed` or `no-metadata` (a release asked for by version whose requirements the
  index did not give) and `at` names the package in the closure that decided it.

What it computes is the notebook's static verdict (`notebooks/python-packages/pypi.py`, `classify` and its `closure`),
ported:

- tags: a wheel is a candidate when its filename parses under the wheel grammar and its tag set meets the core's;
- the closure under markers: `requires_dist` without extras, each marker evaluated against the core's environment;
- version ranges against the lock: a lock package is used at the lock's version. A range that excludes it is fatal
  unless the package is not preloaded AND some release inside the range has a candidate wheel (micropip then takes the
  newest such release, as the notebook's `replaceable` measures). As built, the release installed must sit inside
  EVERY range asked of that package on the closure, where the notebook checks each range alone: stricter, and the
  same on all 2,224 projects it judged;
- the newest admitted release, the first candidate file in the resolver's order when there are several (the four
  projects the spec names), and the hash the index states for that file.

The PEP 440 specifier and PEP 508 marker parsers are written for this module, total and bounded. Markers are parsed and
evaluated by our own grammar against the fixed environment and never reach any `eval`. If writing them costs more than
vendoring a small library, the slice says so in its PR with the size of each option, and the coordinator decides.

### Inputs and their trust

Both inputs are UNTRUSTED. PyPI's JSON is whatever the index serves, whether it is PyPI or anything answering at that
URL. The lock ships inside the core artefact, whose sha256 `tools/pyodide-dist.json` pins and `fetch-pyodide` verifies
before unpacking, so its integrity is the pin's. It is still parsed as untrusted input: the bounds apply to it the
same way, and a malformed entry gives `malformed`, never a throw.

What a hostile index CAN make the verdict do:

- say yes to a package that will not work: claim a compatible wheel, or omit a dependency. The verdict trusts filenames
  and `requires_dist`. A failed import after install is slice 4's rollback, and the spec already counts that case.
- say no to a package that would work, by hiding files or adding a dependency with no build. The worst it can do is
  deny the install, and the person sees the reason with the package named.
- choose WHICH bytes are approved. The hash on the card is the hash the index stated. Slice 3 refuses any other bytes,
  so the index cannot swap the file after approval. Before approval it can serve anything, and the card shows exactly
  what is being approved.
- widen the closure with extra declared dependencies, which the card then lists. The bounds cap it.

What it CANNOT make the verdict do:

- run code: no `eval`, no `Function`, and no regex built from its strings. A marker is data under our grammar.
- reach the network or storage: the module has neither.
- move a lock package: a lock name, canonicalized, always resolves to the lock's version and file with `source:
  lock`. A PyPI project whose name canonicalizes to a lock entry cannot shadow it (`Foo_Bar`, `foo-bar` and `foo.bar`
  are one name, PEP 503).
- name a path: a filename that does not parse under the wheel grammar, or that contains `/`, `\`, `..` or a NUL, is not
  a candidate. So whatever slice 3 writes is named by a string slice 1 has already validated.
- run without bound: at most N packages in a closure, D levels deep, and B bytes of metadata per project, plus caps on
  specifier and marker length (as built: `VERDICT_BOUNDS` in `pkg-verdict.ts`, B counted per verdict, plus the
  wheels' total bytes). Those cap each lookup, not their product, so a `work` bound counts every file judged and
  every range test across the walk (as built: 65,536 steps, where the snapshot's largest verdict takes 2,993); each
  release's files are judged once per verdict. Cycles terminate through the seen set. Past any bound the verdict is
  `too-large`. Slice 1 picks the values from the 10k probe's largest real closure (the notebook's `closure_size`),
  with headroom stated.
- approve anything: a verdict is the card's input (slice 2) or a policy's facts (slice 5). Neither installs on its
  own.

### The oracle

The fixture is the notebook's data at one pin: `notebooks/python-packages/data/pypi-compat/verdicts.json`, keyed by the
core tag in `tools/pyodide-dist.json` (`pyodide-314.0.3-ml-35bd1d69` at the time of writing), together with a trimmed
snapshot of the index metadata the verdict reads, for every project in the closures. The snapshot is a new extract that
the notebook writes with `wmlnb.extract` at the same pin and ranking date, holding only the fields `IndexView` carries.
Its size is measured in slice 1. The raw cache for 2,110 projects is 16 MB untrimmed. If the trimmed snapshot of the
10,000 is too large to commit, the test runs on the top 2,000, which `static.json` already covers, and the PR states
the number. As built it is the top 2,000 and their dependencies (`index-snapshot.json`, 3.8 MB for 2,078 projects).

The test names the pin it was measured against, and fails if `tools/pyodide-dist.json` names another one. So a pin
bump cannot pass on a stale fixture, and every bump turns the test red until the probe and the extract rerun.

**Who reruns it, and where** (ruled 2026-11-09, the coordinator's review of this brief). The rerun goes in the pin-bump
PR itself, and whoever bumps the pin does it. The `pyodide-build` skill gains a step, in slice 1's PR, that names the
notebook's make script (`notebooks/python-packages/make-pypi-compat.py`, whose header lists the commands) and the
probe's job command. The packages lane reviews the new `verdicts.json` and snapshot in that PR. The test's pin line
moves in the same PR, so main never has a bumped core with a stale oracle.

The rerun's cost, from #1584: `freeze-top 10000`, then 20 chunks of 500 at 6 interpreters, submitted one at a time as
`--kind unit` jobs. Each chunk's time from submit to finish was 174 to 2,217 s, median 227 s, 11,006 s (about 3 h 3 min)
in all. Those times include waiting in the queue behind other jobs. test-slot does not keep a finished job's own run
time, so the share spent queued is not known. Once the bench lane's batch kind lands (#1583, open at the time of
writing), the chunks run as `--kind batch --workers 6`, and the skill step names that command.

Three assertions, against the same snapshot:

1. **Parity with the notebook.** On every project, the TS verdict equals `pypi.py`'s static verdict: the same yes or
   no, the same blocker, the same files. Any difference is a porting defect.
2. **Agreement with the probe, as measured.** Against verdicts.json's measured outcome, the confusion table is pinned
   exactly. A measured `no build` or `version` that the verdict calls yes is a failure unless the pinned table lists
   it. A yes whose measured cause is one the static verdict cannot see by construction (`platform`, `undeclared
   host`, `import: other`, `probe`, `timeout`) is expected, and is counted rather than listed. The spec's figures (yes
   right 96.4%, yes to 99.0% of what works, on the top 1,000) are what the table reproduces.
3. **The default.** A project absent from the index gives `not-on-index`, and one in the lock gives the lock's
   version and file. Each has its own assertion, rather than being covered by the sweep.

### Hostile-metadata rows

These are the slice's own rows. The red team is not required for slice 1. Each row asserts the verdict's exact
output:

- a filename with a path separator, `..`, a NUL or a tag set that does not parse: not a candidate;
- a project named to canonicalize onto a lock entry, offering a newer version: the lock's file, `source: lock`;
- a dependency cycle (A needs B, B needs A) and a self-dependency: it terminates, and the closure lists each once;
- a closure one past each bound, and metadata one byte past B: `too-large`;
- a marker or specifier using syntax outside PEP 508/440 (a function call, an attribute, a backtracking-shaped
  string of length L): `malformed`, in bounded time;
- a marker true under the core's environment and one false under it, for each environment key the core sets;
- `requires_python` excluding 3.14, a yanked wheel as the only candidate, and two candidate wheels for one release:
  the first in resolver order;
- a `requires_dist` naming the requested package itself at another version.

## What each later slice adds

**Slice 2, the card.** The card renders a verdict: every file with its name, version, size, sha256 and source, the
total download, and the platform scan's note where it finds one. The note is never a refusal. A no-verdict shows the
reason and the package it names, with no Approve. It goes through the existing approval path and uses the panel's
tooltip. What a hostile page or index must not get from it is e3's red-team pass, run before it lands: a card whose
text the index wrote, a filename that renders as something else, a hash the card truncates.

**Slice 3, the mirror and the download.** The mirror stores, locally, the pinned core's whole lock and the wheels a
person has approved, keyed by sha256. The lock is never a network read, and PyPI is the one gated network read. Every
downloaded byte is checked against the hash on the card before it is stored or loaded. A mismatch refuses, and nothing
is kept. Where the mirror lives (OPFS or IndexedDB) and how it meets the state registry are slice 3's to decide in its
PR, after `docs/dev/state.md`. This slice is e3's red-team pass too: redirects, a body larger than its stated size, and
a second request for the same hash.

**Slice 4, install and rollback.** A readonly worker loads its packages before the lockdown (`python-worker.ts`), so
an install cannot happen inside a locked-down worker. Where the approved set is loaded (a fresh worker that loads it
before the lockdown, as the start-up set is loaded now, or something else) is this slice's design question, and it
reports back before building. A failed import after install rolls back, and nothing is recorded as installed. The
platform scan's finding is the reason text. An import that asks for an undeclared package raises a second card for
that package by name.

**Slice 5, policy-store wiring.** The four facts (`name`, `version`, `source`, `sha256`) reach the policy realm as a
call's facts. A policy can then allow or deny an install where the card would otherwise ask, and the policy page
lists it like any other. This is the first consumer POLICIES.md names. Widening is never a card button. A remembered
approval is a policy, written as one.

## Recorded as open, not in this brief

- Whether a package WORKS when called beyond import. No measurement exists, and a generic no-network smoke call is not
  defined.
- Host placement: 459 of the 533 not installable in Pyodide have a native-host wheel. No placement rule is drawn until
  window-ml-host reads its own tags.

> Written by the packages lane (session `19f583d1-eb33-429d-bccc-727080ef9997`, model `claude-opus-5-5`).
