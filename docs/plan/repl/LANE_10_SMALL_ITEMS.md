# Lane 10: the two small extension-side items (Sonnet)

Read first: [`ROUND_4.md`](ROUND_4.md); window-ml issue #882; `docs/spec/EFFECTS.md` (the operations table and the
paragraph under it, "write means changes"); `docs/dev/shell.md`; `build.mjs` around the dist pin check.

## The two items

1. **The dist manifest's mismatch throw runs in CI.** `build.mjs` refuses to build when `pyodide-core/.pin` and the
   sha256 in `tools/pyodide-dist.json` disagree, and leaves `dist/` alone (a failed build builds into `dist.stage/`).
   Today that is tested only by hand. Add a CI leg (or a test in the existing suite, whichever the `ci` skill's
   playbook makes cheaper) that writes a wrong pin, runs the build, and asserts two things: the build fails with the
   mismatch named, and `dist/` is byte-identical before and after. The janitor owns the CI jobs; ask it where the leg
   goes before adding one.
2. **Issue #882, both items.** (a) `parseOptions`'s `apply` in `src/shell/program-manifest.ts` skips a path-valued
   flag's own `read`/`write` so it lands on the value, not the command; add `write-names` to that skip. The find
   primaries at the second skip site (`argIsPath`, further down the same file) are the same rule and get the same
   change: a term that names the path it acts on applies to that path (ruled 2026-10-21; tell lane 11, whose host
   reader has the same two sites). A test per site, failing first with a manifest fixture that has such a flag, since
   no shipped one does. (b) Hold the host's vector pin by hash: `tests/program-manifest.test.mjs` hashes
   `src/shell/manifests/*.json` and `tests/fixtures/program-calls/*.json` and compares with the hash the host records in
   `vectors/program-manifests/PIN` (lane 11 is adding the same check on the host side; agree the hash's exact input,
   byte order and file list with lane 11 directly, so the two sides compute the same number). Also the one sentence
   host #19 leaves to this side: in `EFFECTS.md`, under the operations table, that a call recording `effects: []` is
   the empty set and free on any bound.

## Order and size

Item 2(a) first, one PR with lane 11 as reviewer, since it is the other half of the seam. Item 2(b) with the EFFECTS.md
sentence is the second PR, same reviewer. Item 1 is a third PR, the janitor reviews. Expect the lane to close in a day;
if the CI leg turns out to need a new job, say so in its PR and let the janitor shape it.

## Not this lane

No change to any manifest's effects, no new manifest, nothing in the host repo (lane 11's), nothing in `src/python/`
(lane 3's). A finding about a manifest's effects goes to lane 11 and the coordinator the same day, not into a PR.

## Who reviews

Lane 11 for both #882 PRs (it owns the host's half); the janitor for the CI leg. The red team reads nothing here
unless a test you write is about an escape, in which case tell it.
