---
name: coverage
description: Measure which lines and BRANCHES of window.ml the test suite actually reaches, and read the gaps as source. Use when auditing whether a feature's paths are covered, before claiming something is tested, or when deciding where a new test is worth writing.
---

# Coverage

Answers "is this path tested?" deterministically, instead of by reading the test names and hoping. Node's
built-in coverage; no dependency.

```bash
npm run coverage                              # full suite -> coverage/lcov.info + a table on stdout
node scripts/coverage-lines.mjs sw-fetch.ts   # the gaps in one file, WITH the source
node scripts/coverage-lines.mjs --all --min 5 # every file with >= 5 uncovered lines
```

## Read the branches, not the percentage

The table's percentage tells you a file is thin. It cannot tell you whether the `else` of one specific
guard was ever taken, which is the question that actually comes up. `coverage-lines.mjs` reports two
different things and the second is usually the interesting one:

- **NEVER RUN** — the line never executed. Usually a whole function no test imports.
- **BRANCH NOT TAKEN** — the line RAN, but a condition on it only ever went one way. This is what a
  percentage hides: a file can read as 100% line-covered while half its guards were never exercised.

## Judge each gap; do not chase the number

A real example from this repo. Auditing the Markdown ladder, five branches inside it were untaken —
and only ONE was worth a test:

| branch | verdict |
| --- | --- |
| `headers.get("content-type") \|\| ""` | **real** — servers do omit the header. Test written. |
| `res.url \|\| url` | defensive; a real `fetch` always sets `.url` |
| `(e as Error)?.message \|\| String(e)` | defensive; something threw a non-Error |
| `try { new URL(landed) } catch` | unreachable — the URL came from a fetch |

Testing the last three would assert the shape of our own mocks rather than any behaviour. **Coverage finds
candidates; you decide which are real.** A test written only to colour a line green is worse than the gap,
because it looks like protection and is not.

The value here was the opposite direction: without the tool the claim would have been "the ladder is fully
covered", which was wrong. Run it before saying something is tested.

## Gotchas

- **`--enable-source-maps` is not optional.** Tests run through `tsx`, so without it every line number
  describes esbuild's transformed output and the report is quietly wrong — a covered function shows as
  uncovered, and gutters land on the wrong lines. It is already in the npm script; keep it if you edit.
- **`precoverage` builds `dist/`.** Some suites (`agent.test.js`, `background.test.js`, `sidebar.test.js`)
  load the BUILT bundle, so a stale build measures stale code.
- **Files no test imports are absent from the report entirely**, not listed at 0% — `coverage-lines.mjs`
  says "not in the report" for a file you name explicitly, which is itself a useful signal.
- Tests run with `--test-concurrency=1`, matching `npm test`; some suites share module state.

## VSCode

`npm run coverage` writes `coverage/lcov.info`, which the **Coverage Gutters** extension
(`ryanluker.vscode-coverage-gutters`) reads with no configuration — install it, then *Coverage Gutters:
Watch* to see hit/miss in the gutter as you edit. Uncovered branches show as partially-covered lines.
`coverage/` is gitignored.
