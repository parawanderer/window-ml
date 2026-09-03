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

**Two audiences, one run.** You define the experiment in code, run it, and read the terminal. A human
watching over your shoulder opens the live page (`--serve`). Same data, rendered for whoever is looking —
so START A SWEEP WITH `--serve` AND HAND THE HUMAN THE URL. It prints as a banner for exactly that:

```
  ┌─────────────────────────────┐
  │    http://127.0.0.1:7331    │
  └─────────────────────────────┘
  watch it live ↑  (120 runs)
```

**In VS Code, that URL docks as an editor tab.** Cmd-click it in the terminal and VS Code offers a picker
— choose **Simple Browser** and the page opens beside the code, TensorBoard-style. Simple Browser is
built in (it registers an external URI opener for http), so nothing needs installing. The port is stable,
so the tab stays valid across sweeps: reload it rather than reopening.

The page shows every run with its state and what is queued next, the in-flight run's step against its
budget and the tool it is in right now, the last thing that happened, elapsed time, mean time per run and
per step, and an ETA (withheld until a few runs land — an estimate from one sample is a guess wearing a
number's clothes), and which MODEL(s) the sweep ran against. Each row carries the agent run's own hash as
a pill, so a row can be matched by eye to the transcript that names it, and links to that run's artifacts:
`read` (the rendered transcript, which opens in an overlay without leaving the index), `md`, `json`, and
`export` when `--pdf` produced one. **A run that failed links its STATUS straight to the step that broke**
— a memory fault, else a tool that returned an error, else the last step of a run that crashed or hit the
cap. A run that merely got the answer WRONG with every tool working links to the top instead: there is no
failing step, and pointing at one would send you to an innocent call. It is a SINK, not a second brain: the
server recomputes the table with the same `aggregate()` the report uses, so the page cannot disagree with
`report.md`.

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

The two specs in `specs/` are worked examples, and `specs/README.md` is the walkthrough for a human who is
not using this skill. `smoke.bench.ts` is the shortest complete one; `pointer-ids.bench.ts` is a real
experiment with a build-time dimension and a seeded history.


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
| `--serve` | Serve the live page and print its URL. Costs nothing when nobody opens it; SSE, no dependency, no build step. |
| `--open` | `--serve` plus launch a browser. |
| `--port N` | Serve on a specific port. The default (7331) is STABLE on purpose, so a browser tab can just reload between sweeps instead of needing a new URL. Falls back to any free port if taken. |
| `--pdf` | Also render each run to `run.html` + `run.pdf`. Off by default: it roughly triples a cell's disk and adds a render per run. The HTML is written alongside deliberately — it is searchable and diffable where a PDF is neither, and it is the only way to see why a PDF looks wrong. |

Backend selection is the same as observe: `USE_ENV=1` reads `.env`, `E2E_BACKEND`/`E2E_MODEL`/`E2E_KEY`
set one explicitly, and with neither it runs the scripted fake-LLM (which is what makes the smoke spec
deterministic). `apply()`'s `backend.model` overrides the model per cell.

## What it writes

`tests/e2e/artifacts/bench/<spec>/` (gitignored) holds `report.md`, `rows.json` (the aggregate AND every
individual run, for further analysis), and one directory per RUN at
`<task>/<combo>/r<N>/`, each containing that run's full observe-style artifacts:

- **`run.md`** — the transcript to read. Same canonical markdown observe writes. **This is the one an
  agent should read**; the two HTML renders below exist for humans.
- **`run.md.html`** — the same markdown RENDERED, written beside it. Asset paths are relative, which is
  what lets one file serve both cases: opened straight off the disk it finds its own `images/`, and served
  under `/artifacts/<run>/` it finds them there too. Every h2 is a collapsible section with two anchors —
  `#step-4-exec` (the exact call) and a bare `#step-4` — so the index can link INTO the transcript at the
  step that failed rather than at the top of a fifty-screen document. Opening such a link folds everything
  else to an outline and expands the failing call plus the reasoning that produced it. `collapse all` /
  `expand all` are in the header. The page denies script by CSP except its own, admitted by hash.
- **`run.json`** — the machine-readable export. **Diff two runs with this, not the markdown** — a markdown
  diff is dominated by layout. Strip `VOLATILE_FIELDS` and apply `canonicalizeText` first (export-schema.ts)
  or you will diff timestamps and pointer ids instead of behaviour.
- `events.json`, `transcript.txt`, a screenshot per step, and `cell.json` (the cached measurement).
- `run.html` + `run.pdf` with `--pdf` — the OTHER HTML render, produced by the extension's own export sink
  rather than by `marked`. Higher fidelity, and authoritative where the two disagree; it is just expensive
  enough not to be the default. The dashboard offers it as `export` when the sweep produced it.

`run.md`, `run.json` and `events.json` are rewritten on EVERY event, not at the end — a run that hangs or
is interrupted still leaves a readable partial rather than an empty directory. `report.md`, `report.html`
and `rows.json` are written once, when the sweep finishes. `specs/README.md` has the full table.

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
- **A predicate is CODE, and a wrong one does not fail.** It scores every arm identically and reads like a
  finding rather than a bug — after the GPU time is spent. `tests/bench-specs.test.mjs` scores each spec's
  predicates against answers a model plausibly writes and against wrong ones; add yours. `pointer-ids`'
  first predicate looked for `502981` where the columns sum to `502980.90`, so nothing correct could match.
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
