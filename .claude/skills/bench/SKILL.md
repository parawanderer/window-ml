---
name: bench
description: Run a MATRIX of agent runs and compare them — models, prompts, or an experimental variant — reporting re-emission, pointer use, recovery, token cost and correctness with spread over repeats. Use when a question is "which of these is better" rather than "what did this one run do".
---

# bench — measuring the extension across a matrix

`tests/e2e/bench/` walks a declarative spec: every combination of the dimensions you declare, against
every task, repeated N times. It drives the same `runOnce()` core as [observe](../observe/SKILL.md), so a
cell is a real run of the built extension in a real Chromium — just many of them, scored.

Reach for **observe** to understand ONE run. Reach for **bench** when the question is comparative:
does this model follow the rules better than that one, does this prompt change help, does an
experimental identifier format reduce re-emission.

```
npm run build
node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/smoke.bench.ts --repeats 1
```

## Before you trust a number, run the smoke spec

`specs/smoke.bench.ts` is the instrument's calibration, not a demo. Its tasks are scripted against the
fake-LLM to re-emit, to cite, and to hide a re-emission inside a seeded turn, so the expected reading of
each cell is known before it runs: **re-emitter must read 1.00, citer 0.00, seeded 0.00**. If those
three are not exactly that, the extractors are wrong and every other number the bench prints is wrong
too. Run it after touching anything under `bench/`.

`npm run bench:calibrate` does exactly this — builds, runs the smoke spec, and asserts the readings via
`check-calibration.mjs`, which exits non-zero with what broke. It is the **`bench` CI job**, kept separate
from `test`/`e2e` so a failure names the right thing: a broken measurement tool is not a broken extension,
and "e2e failed" sends you to look at the wrong code.

The same calibration is automated in three places, all of which must stay green:
- `tests/bench-metrics.test.mjs` — the extractors against synthetic streams (fast suite, `npm test`).
- `tests/e2e/bench-selftest.spec.mjs` — the same readings against REAL debug streams, which is the only
  thing that catches an extractor reading a field the product does not actually emit.
- `npm run bench:calibrate` — the CLI end to end (spec loading, matrix expansion, cache, sinks, report),
  which neither of the above exercises. Also `tests/bench-specs.test.mjs`, which scores each spec's
  `succeeded` predicate against answers a model plausibly writes: a wrong predicate does not fail, it
  silently marks every arm the same way and reads like a finding.

## Writing a spec

Specs are TypeScript so the config is typed as you fill it in — the dimension keys you declare are the
keys `apply()` receives, and their values are the union it accepts.

```ts
import { defineBench } from "../spec.ts";

export default defineBench({
    name: "pointer identifier formats",
    repeats: 5,
    dimensions: {
        idFormat: ["hex", "words", "label"],
        model: ["gemma4:31b", "deepseek.deepseek-v4-pro"],
    },
    // one point of the matrix -> what it DOES to a run
    apply: (combo) => ({
        backend: { model: combo.model },
        defines: combo.idFormat === "hex" ? {} : { __ML_ID_FORMAT__: JSON.stringify(combo.idFormat) },
        toolTokens: combo.idFormat !== "alias",
    }),
    tasks: [{
        id: "two-tables",
        start: "/spreadsheet",
        task: "Sum column C of both tables and compare them.",
        python: true,
        succeeded: ({ answer }) => /1?\d{3}\.\d/.test(answer),   // scoring lives WITH the task
    }],
});
```

A task without `succeeded` reports `—` (not scored) rather than counting as a failure — which keeps a
task usable for measuring behaviour when correctness is not the question.

## Flags

| Flag | What it does |
| --- | --- |
| `--jobs N` | N browsers at once. Good against a hosted API; **bad against one local GPU**, and it makes the `secs` column meaningless (the report says so). Default 1. |
| `--only k=v` | Select cells. Works on any dimension, plus `task=<id>` and `repeat=<n>`. Repeatable, ANDed. |
| `--skip k=v` | The inverse. |
| `--repeats N` | Override the spec's repeat count — use `--repeats 1` while iterating on a spec. |
| `--dry` | Print the matrix and its cell keys, run nothing. Do this before any long sweep. |
| `--no-cache` | Re-run cells that are already measured. |
| `--pdf` | Also render each run to `run.html` + `run.pdf`. Off by default: it roughly triples a cell's disk and adds a render per run. The HTML is written alongside deliberately — it is searchable and diffable where a PDF is neither, and it is the only way to see why a PDF looks wrong. |

Backend selection is the same as observe: `USE_ENV=1` reads `.env`, `E2E_BACKEND`/`E2E_MODEL`/`E2E_KEY`
set one explicitly, and with neither it runs the scripted fake-LLM (which is what makes the smoke spec
deterministic). `apply()`'s `backend.model` overrides the model per cell.

## What it writes

`tests/e2e/artifacts/bench/<spec>/` (gitignored) holds `report.md`, `rows.json` (the aggregate AND every
individual run, for further analysis), and one directory per RUN at
`<task>/<combo>/r<N>/`, each containing that run's full observe-style artifacts:

- **`run.md`** — the transcript to read. Same canonical markdown observe writes.
- **`run.json`** — the machine-readable export. **Diff two runs with this, not the markdown** — a markdown
  diff is dominated by layout. Strip `VOLATILE_FIELDS` and apply `canonicalizeText` first (export-schema.ts)
  or you will diff timestamps and pointer ids instead of behaviour.
- `events.json`, `transcript.txt`, a screenshot per step, and `cell.json` (the cached measurement).
- `run.html` + `run.pdf` with `--pdf`.

So a surprising row is always readable down to the transcript that produced it. The report's **Runs**
table is the index: the aggregate says which CELL is interesting, that says which of its repeats to open —
a mean of five hides the one that went wrong, which is usually the one worth reading.

## Things that will bite you

- **Repeats or it is noise.** Models are stochastic; one run per cell measures sampling. The default is
  5 and the report shows `mean ±sd` for a reason — if the spread swamps the difference, there is no
  difference yet.
- **The cache key includes the BUILD**, commit plus a digest of uncommitted changes. Edit the extension
  and previously measured cells correctly re-run rather than silently mixing two builds into one table.
  A dirty tree does not block a sweep but is stated in the report.
- **An experimental dimension is a `--define`, not a config flag.** `build.mjs --outdir <dir> --define
  K=V` produces a variant; the runner builds each distinct variant once up front and points that cell's
  browser at it. A hypothesis that may conclude "the current design was fine" should leave no trace in
  the product.
- **Metrics come from artifacts, never new instrumentation.** Everything derives from the `__mlDebug`
  stream. If a metric cannot be computed from it, that is a signal the stream is missing something the
  PRODUCT should have — fix it there, not in `metrics.mjs`. Adding a column is one entry in `COLUMNS`.
- **`--dry` first for anything long.** 4 formats x 3 tasks x 2 models x 5 repeats is 120 runs and hours
  of GPU. Trim cells that do not discriminate rather than repeating them five times.

## Seeded histories — measuring recovery on purpose

Waiting for a real model to corrupt an identifier by chance needs hundreds of runs. A task's `seed` runs
turn 1 against the SCRIPTED fake — so the experiment decides exactly what the model will find in its
context — then swaps the backend to the real model and continues in the SAME session:

```ts
{
    id: "recover-from-fault",
    seed: { task: "Load the table and report it.", script: [{ tool: "python_exec", args: { … } }, { content: "…@tool:a39f598" }] },
    task: "Using the data you already have, what is the median?",
}
```

Nothing is fabricated: the loop really produced that history, so the fault is a real fault. The seed's
own steps and its answer are excluded from the score (`seedBoundarySeq`), so the script's behaviour is
never charged to the model — `tests/e2e/bench-selftest.spec.mjs` asserts exactly that, in both
directions.
