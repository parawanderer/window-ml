# Benchmark specs

A **spec** is a TypeScript file describing an experiment: the axes to vary, the tasks to run, and how to
tell a right answer from a wrong one. The runner walks it. Nothing here drives a browser itself, so a spec
reads as a description of a question rather than as a program.

```
npm run build
node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/<spec>.bench.ts --repeats 2 --dry
```

The two specs in this directory are the worked examples, and they are deliberately different kinds:

| Spec | What it is |
| --- | --- |
| [`smoke.bench.ts`](smoke.bench.ts) | The instrument checking **itself**. Scripted against a fake model so every reading is known before it runs. Read this first — it is the shortest complete spec, and it shows `seed`, per-task `script`, and a `succeeded` predicate. |
| [`pointer-ids.bench.ts`](pointer-ids.bench.ts) | A real experiment: does the surface form of a pointer id change whether a model cites data instead of retyping it? Shows a build-time `defines` dimension, a multi-turn task, and a seeded history. |

## Why TypeScript and not JSON

The dimension keys you declare are the keys `apply()` receives, and their values are the union it accepts.
A mistyped axis is a compile error rather than a cell that silently never varies. Predicates are also just
functions, so scoring lives next to the task it scores instead of in a registry somewhere else.

## The shape of a spec

```ts
import { defineBench } from "../spec";

export default defineBench({
    name: "my-experiment",          // names the artifact directory
    repeats: 5,                     // per cell — models are stochastic, one run measures sampling
    dimensions: { thing: ["a", "b"] },

    // one point of the matrix -> what it DOES to a run
    apply: (combo) => ({ agentOptions: { something: combo.thing } }),

    tasks: [{
        id: "does-the-thing",
        start: "/spreadsheet",      // any served example page; GET /examples lists them
        task: "Total the amount column.",
        tools: ["exec", "answer"],  // a subset keeps the prompt small
        succeeded: ({ answer }) => /502980/.test(answer),
    }],
});
```

Every field is documented on hover — see [`../spec.ts`](../spec.ts) for the full set (`seed`, `followup`,
`python`, `toolTokens`, `timeoutMs`, `script`, …).

## Three things that are easy to get wrong

**A predicate is code.** A wrong one does not fail; it scores every arm the same way and the result reads
like a finding ("this task is too hard for both models") instead of a bug — discovered after the GPU time
is spent. `tests/bench-specs.test.mjs` scores each spec's predicates against answers a model plausibly
writes, and against wrong ones. Add yours there. This is not hypothetical: `pointer-ids`' first predicate
looked for a total of `502981` where the columns sum to `502980.90`, so no correct answer could have
matched.

**An experimental dimension belongs in `defines`, not in the product.** `defines` compiles a variant of the
extension (`build.mjs --outdir … --define K=V`), so a hypothesis that may well conclude "the current design
was fine" leaves no config flag behind. Ship a real setting only if the variant wins.

**A task with no `succeeded` is fine.** It reports `—` (not scored) rather than counting as a failure,
which keeps the task usable when correctness is not the question being asked — token cost, re-emission and
step count are all still measured.

## What it writes, and when

Everything lands under `tests/e2e/artifacts/bench/<spec name>/`, which is **gitignored** — a sweep is
reproducible from the spec, and the runs are large.

**Per run, `<task>/<combo>/r<N>/`, written AS IT GOES:**

| File | When | What |
| --- | --- | --- |
| `run.md` | rewritten on every event | The transcript, as the extension's own "Export log → Markdown" would write it. **Read this first.** Written incrementally on purpose: a run that hangs or is interrupted still leaves a readable partial, rather than an empty directory. |
| `run.json` | rewritten on every event | The same session through the machine-readable export (`docs/spec/export.schema.json`). **Diff two runs with this**, not the markdown — a markdown diff is mostly layout. Strip `VOLATILE_FIELDS` and apply `canonicalizeText` first (`export-schema.ts`) or you diff timestamps and pointer ids. |
| `step-<n>.png`, `final.png` | per step | Screenshots, including `look`/`locate` crops. |
| `events.json` | rewritten on every event | The raw `__mlDebug` stream, for a field the export does not carry. |
| `transcript.txt` | at the end | Console + step log. |
| `cell.json` | at the end | The cached measurement, keyed by cell config + build fingerprint. Its presence is what lets a resumed sweep skip this run. |
| `run.html`, `run.pdf` | at the end, `--pdf` only | The print-styled transcript. |

**Per sweep, at the end:**

| File | What |
| --- | --- |
| `report.md` | The aggregate table plus a **Runs index** — every run with its outcome and a link to its `run.md`. The permanent artifact, and the one an agent should read. |
| `report.html` | The same index as a page: the live view with the final state baked in, links relative so it works from disk with no server. For a human. |
| `rows.json` | The aggregate AND every individual run, for further analysis. |

`report.md` and `report.html` come from the same walk over the same data, so they cannot disagree about
what happened — only about how it looks.

## Watching a sweep

`--serve` prints a URL for a live page (on a stable port, so a browser tab can reload between sweeps
rather than needing a new address — in **VS Code**, cmd-click it and pick **Simple Browser** to dock the
page as an editor tab beside the code): every run with its state, what is queued next, the in-flight run's
step against its budget and what it is doing right now, elapsed time, mean time per run and per step, and
an ETA. `--open` launches it. The terminal output is unchanged, so an agent can run the sweep and read the
CLI while a human watches the page.

Full playbook, flags and gotchas: the **`bench`** skill (`.claude/skills/bench/SKILL.md`).
