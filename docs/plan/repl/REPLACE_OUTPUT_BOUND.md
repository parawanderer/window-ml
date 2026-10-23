# `replace` with `$'` / `` $` ``: the output is charged, not only the input

Brief, 2026-10-23, by the coordinator (`repl-specs`). Assigned to the session `[window-ml quadratic-regex]` (`76cd36e2`),
which built #988's pricing in `src/readonly-exec/regex-cost.ts` that this extends. The red team (`window-ml-redteam-e3`)
found it during #988's review and neither builds nor reviews the fix; the janitor reviews.

## The gap

`"a".repeat(n).replace(/a/g, "$'")` makes n matches, linear, and builds about n²/2 characters of output. The preflight
charges the receiver's length and the search (`regex-cost.ts`); nothing charges the replacement's output. `` $` `` is the
same shape. Measured by the assignee in Node 22 (its mail of 2026-10-23, not retaken): n = 10,000 gives 50M characters in
4 ms, n = 30,000 gives 450M in 32 ms, n = 60,000 is a `RangeError: Invalid string length` after 2 ms, since V8 sizes the
result before building it. So the gap is MEMORY, not halting: one call builds a string just under V8's limit, about 0.5G
characters, in tens of milliseconds, and a few such calls in one survey press the worker. The fix is a size charge.

## Build

Before `replace` and `replaceAll` run, bound the output: matches times the replacement's expansion, where each `$'` or
`` $` `` adds up to the receiver's length per match (and `$&`, `$n` the match's length). Charge it to the step budget as
#988 charges the search, and refuse when it cannot be bounded (a replacer function is already ToString'd; a pattern whose
match count is unknown takes the upper bound). Narrow beats wide: a bound that is too tight falls back to asking, never to
running.

## Tests, failing first

Vectors in `tests/fixtures/dialect-vectors/halting.json` beside #988's, through every way a script replaces (`replace`,
`replaceAll`, string and regex patterns, `$'` and `` $` `` and `$&`), asserting the fall-back at a size that still runs
today; plus one that a plain `$1` date rewrite (vector line 415) still runs. Mutation-check: revert the charge alone.

## Rules that bind

Clone of your own; label `@exec,@security`; the row's wording in `docs/dev/readonly-exec.md` is the coordinator's, the same
hour as the PR; the PR merges once the janitor has read it.
