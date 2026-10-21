# Lane 10 result (2026-10-21)

Both items of [`LANE_10_SMALL_ITEMS.md`](LANE_10_SMALL_ITEMS.md) are merged.

## Built

| Item | PR | Merge |
| --- | --- | --- |
| #882 2(a): `write-names` on a path-valued flag or find primary lands on the value, at `parseOptions`'s `apply` and `parseFind` | #909 | 1c3a30da |
| #882 2(b): the manifests and call fixtures held by hash (`VECTOR_PIN`), and the `effects: []` sentence in `EFFECTS.md` | #910 | 96f823ce |
| Item 1: a wrong `pyodide-core/.pin` fails the build, names the mismatch, leaves `dist/` byte-identical | #911 | e9c95c81 |

The host half is window-ml-host #20 (4dd4271f), reviewed here (review 5595748421).

## Measured

- #909's test fails against main's source and passes on the PR.
- The pin is 18075fc660564baa5db258a2a7279cdb4def08fdf403b3247501e3abb2b6bcba over the 18 files, identical on both sides.
- #911's test runs in about 2 s because the pin check throws before any bundling; with the throw disabled it fails on "the build fails".

## Assumed where the spec was silent

- A term that names the path it acts on applies to that path, and the lane 11 reading of the ruling was taken as is: skip `write-names` from the command's targets and also push it onto the value, only when the value is taken.
- The pin input is lane 11's: host-side names `calls/<p>.json` and `manifests/<p>.json`, bytewise sort, `<sha256>  <name>\n` lines over raw bytes.
- #911 is a test in the `checks` genre, not a CI job (the janitor agreed).

## Left

Nothing in this lane. A change to any manifest or call fixture fails `tests/program-manifest.test.mjs` here and `tests/manifest_vectors.rs` in the host until both pins move. The e2e test `chat-page.spec.mjs:791` failed once on #911; the janitor reads it as a real worker bug (messages and init held for a page-hosted run), not this lane's.

> *Drafted by Claude Code · work: repl-lane10 · session b7f7da82 · claude-sonnet-5-5*
