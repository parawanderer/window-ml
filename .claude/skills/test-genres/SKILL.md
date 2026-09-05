---
name: test-genres
description: Run a subset of the test suite by genre (core/panel/ext/python/live) instead of all ~2 minutes of it. Reach for this while iterating; run the full suite before committing.
---

# Test genres

`npm test` is ~2 minutes. Three files are 80% of that — `sidebar.test.js` (53s), `background.test.js`
(22s), `cdp-stream.test.mjs` (20s) — and none of them are usually what you just changed.

```bash
npm run test:core      # ~8s, 978 tests — pure modules. The default while iterating.
npm run test:panel     # the sidebar UI against jsdom
npm run test:ext       # background / relay / CDP / the page loop
npm run test:python    # real CPython (self-skips without dist/pyodide)
npm test               # everything. Before you commit.

node scripts/test.mjs --list      # what each genre holds
node scripts/test.mjs --timings   # per-file durations, slowest first
node scripts/test.mjs panel ext   # more than one
```

## Which genre

Match it to what you touched, not to what you hope passes:

| You changed | Run |
| --- | --- |
| a pure module (`src/*.ts` with no chrome/DOM) | `core` |
| `src/sidebar/*` | `panel` — and `core`, since `model-stats`/`resource-model`/`timestamps` live there |
| `background.ts`, `sw-*.ts`, `content.ts`, `injected.ts` | `ext` |
| `python-runtime.ts` / `python-worker.ts` | `python` |
| anything you are about to commit | `npm test` |

## Why `core` is derived, not listed

The named genres list their files; `core` is everything left over. That direction is deliberate: a new
test file lands in `core` and runs by default, rather than belonging to no genre and being silently
skipped — which a hand-kept list of every genre would eventually do.

The cost is the other way round: a new SLOW file lands in `core` and makes it less fast, invisibly. That
is what `--timings` is for. If `core` creeps past ~15s, run it and either move the offender into a named
genre or make it fast.

## Gotchas

- **A genre naming a file that no longer exists is a hard error**, not a warning — a stale entry means
  those tests stop running and nothing says so.
- `--timings` spawns one node per file (~0.3s of startup each), so its total reads higher than the suite's.
  Compare the ROWS to each other, not the total to `npm test`.
- This runner does not touch **e2e** (`npm run test:e2e`, Playwright, separate suite) or the **bench**.
