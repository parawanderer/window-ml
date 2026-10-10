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

The next planned experiment is the prompt budget (cuts to the system prompt and tool schemas as build-time
variants): [docs/spec/PROMPT_BUDGET.md](../../../docs/spec/PROMPT_BUDGET.md), including where the bench was left off.

**Two audiences, one run.** You define the experiment in code, run it, and read the terminal. A human
watching over your shoulder opens the live page (`--serve`). Same data, rendered for whoever is looking —
so START A SWEEP WITH `--serve` AND HAND THE HUMAN THE URL. It prints as a banner for exactly that:

```
  ┌─────────────────────────────┐
  │    http://127.0.0.1:7331    │
  └─────────────────────────────┘
  watch it live ↑  (120 runs)
```

**A sweep ends by EXITING, so run it in the background and wait for it.** The last line it prints is
`BENCH DONE <name> runs=… ok=… errors=… correct=… wrong=… held=… report=… page=…` (and the same in `done.json` in the sweep
directory); the status is 0 when no run errored, 2 when some did, 1 when the runner failed. With `--serve` the page
stays up after the exit, served from the sweep's files by a detached `serve.mjs` on the same port, so the URL you
handed over keeps working. The next sweep takes that port back; `node --import tsx tests/e2e/bench/serve.mjs --stop`
stops it, and `serve.mjs <sweep dir>` serves any finished sweep again.

**A run is never deleted by a later one.** When a cell runs again in place (the spec or the build changed its key,
`--no-cache`, an errored run retried), the run already there moves to `history/<cell path>/<when>-<key>/` in the sweep
directory (`↪ … kept in` in the log, `kept` in `done.json`), and `sync.mjs push` sends it too, beside the run that
replaced it. Reusing a sweep's name for a changed spec therefore no longer loses its baseline.

**The report is the whole sweep on disk, of one version.** `report.md`, `summary.md`, `rows.json` and the page include
every cell in the sweep directory whose cache key is the current spec and build's, whether or not this invocation's
`--only`/`--models` selected it (`N already on disk` on the page, `(on disk)` in the Runs table). So a sweep built up a
model or a task at a time reads as one. Cells from an earlier spec or build are not counted: they are listed under "Also
on disk, from an earlier version" (`older` in `rows.json`). `BENCH DONE` and `done.json` count only what this invocation
ran or read. A deliberate before/after (a reworded prompt, a tool change) is TWO sweep names, compared by diffing their
`rows.json` or on the scoreboard; one name for both leaves the "before" listed, not compared.

**A run that ERRORED is not cached as done.** The next sweep runs it again (`↻ … running it again`, `retried` in
`done.json`); a finished run, right or wrong, stays cached. A backend's rate limit is named as one (`rate-limited` on
the page, `rate_limited=` in the final line), however it arrives: Open WebUI passes OpenRouter's as a 400. Its fix is
fewer at once: a lower `--jobs`, or `--lanes`, which runs a cloud model one run at a time.

**Keep a run open to go on talking to it: `--hold`.** `--hold all`, `--hold failures` (only a run that errored or was
wrong) or `--hold k=v` (cells as `--only` picks them), or `hold: true | "failures"` on a task or an interview file. A
held cell runs in a DETACHED process of its own (`bench/hold.mjs`) that hands the finished run back to be measured as
usual and then stays up with the session, its pointers, `ml.current` and the page exactly as the run left them, which a
re-seeded run cannot give back. The sweep still exits: `held=N` in the last line, each attach line printed above it and
in `done.json` (`held`), a `held` badge on the page. Talk to one with `node tests/e2e/converse.mjs --attach <cell dir>
"<message>"` (prints the turn it starts; without a message, where the session is), and end it with the message `/end`.
It also lets go after 30 idle minutes (`--hold-idle N`, `holdIdleMinutes` on a task), since a local model's run keeps
its memory on the box, and on SIGTERM. `hold.mjs` lists the held runs (`artifacts/bench/held.json`), `hold.mjs --stop
[pid|cell|dir]` releases them, a held run's browser is headless like every bench browser (`--hold-window` makes it a minimised
real window that `hold.mjs --show [x]` brings up and `--hide` minimises again; on macOS each such window takes the
screen as it opens, every cell under `--hold failures`, so it is opt-in), and each turn sent to it after its own goes in `continued.jsonl` and on the page's
Continued card, apart from the interview and never scored, and merge-when-green releases those a merged worktree left.
To SEE a held run, open the live page (`--serve`, or `serve.mjs <sweep dir>` after the sweep): its Watch card lists the
held runs, and each one opens as a tile streaming that browser's screen, headless or not (`stream.mjs`; captured only while
a tile is open). Tiles drag by their title and resize by their corner; when the run lets go the tile keeps its last frame,
greyed, under "stream ended". A saved `report.html` has no server behind it, so no Watch card. A held cell is never served
from the cache under `all` or a selector (a cached result has no browser to keep); under `failures` it is.

**Local models in parallel: `--lanes`.** One lane per model: each model's runs in turn, different models at once when
the box says the next one fits beside what is loaded (`/api/fits` on the patched Ollama, `/ollama/api/fits` through
Open WebUI), asked before every run since another client can change the answer. A lane that does not fit waits, and
still runs once nothing else is running, as `--jobs 1` would. A cloud model is not on the box and always goes, one at a
time per model (a provider's rate limit is per model). Without `/api/fits` the local lanes take turns. `--jobs N` caps
the lanes at once; an interview runs in lanes unless `--jobs` is given. Two runs of ONE model gain nothing by running at
once: the box has one generation slot per model, so they take turns.

**The bench store pools results off the laptop (`sync.mjs`), opt-in.** With `BENCH_STORE_URL`, `BENCH_STORE_KEY_ID` and
`BENCH_STORE_SECRET` in `.env`, a sweep ends by pushing its new scoreboard rows and box frames (Parquet) and its run
directories to the bucket; `--no-sync` skips that once, `--only-db` sends rows only, and `sync: false` on a spec or a task
keeps run directories (screenshots, page text, logged-in pages included) on this machine. A run against the fake LLM
never goes (`isFake`), as it never reaches the scoreboard, so a throwaway check needs no flag. `sync.mjs push | pull |
status [--json]` by hand; `pull` fills `artifacts/bench-pool/`, deduped. The store is AT-LEAST-ONCE: read it through
`pull` or the `views.sql` views, never the raw objects. The pool and pulled copies are the only copies.

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

The page is a set of cards: progress and timing, what is running now, an interview's Answers, the **Timeline** (every
run on one clock, each as the resource panel's event lane: which runs overlapped, where the time went; cached runs are
left out, they ran in an earlier sweep), Results and Runs. A run opened from it reloads as the run moves, keeping your
place. Each `run.md.html` has the same lane as its own Timeline section. The page follows the system theme; its
button switches light/dark. It is Preact under `tests/e2e/bench/page/`, bundled in memory each time the bench starts.

**The page is editable while someone looks at it.** With `--serve`, the server watches the page's sources
(`tests/e2e/bench/page/`, the lane modules it shares with the panel, `sidebar.css`, `palette.ts`): an edit rebuilds it and
every open browser reloads onto the new build, keeping its scroll and getting its state straight back, while the sweep
runs on. So a person, this session or any other agent can work on the page with a human watching it change. A build that
fails shows the compiler's message on the page and the previous build stays up. Edits to `lane-static.ts` or
`bundle.mjs` themselves are node modules of the server, so they need a restart.

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

**Give every task a `succeeded` predicate whenever a right answer can be checked.** Only predicate-scored runs count
toward a model's score on the bench's scoreboard (below), so a task without one adds nothing to it, and the sweep ends
by listing which tasks had none. Writing one is usually a line: a regex for the number the page holds, or a check
against the artifact the task produced (ground truth from the page or the file, never from the model's own claim).
Check it against an answer a model would plausibly write, right and wrong, before the sweep: a predicate that is too
strict scores every model as failing, and nothing flags it. An edit to the task's text or its predicate makes it a new
task on the scoreboard, so the old runs do not mix with the new.

A task (or a cell, through `apply`) can set `surface: "hud"` to start the run the way a person does from the UI (the
kit and prompt a UI run gets) instead of a console `ml.agent`; `tools`, `python`, `toolTokens`, `agentOptions` and
`seed` are console knobs and do not apply to it. `sharedWatches`/`watchNotes` go to `ml.current` as in observe.

`incognito: true` on a task (or a cell's `apply`) turns on the extension's "Allow in Incognito" before the run. A
fresh install has it off, and so does every other run here: a private rendered fetch (`fetch_url({ rendered: true })`
without credentials) then returns guidance instead of the page, so a task about rendering MUST set it or it measures
recovery from that error (spa-rendered did, until it set it). It is part of the task's hash and the cell's cache key.

`stream: true` on a task or a cell streams each model turn, as the HUD does (tool calls assembled from chunks, usage
from the stream's last chunk); `dimensions: { stream: [false, true] }` with `apply: (c) => ({ stream: c.stream })`
makes it an arm. Unset, a console run is NOT streamed (`ml.agent`'s default, and every sweep before this knob) and a
`surface` run IS (what the HUD sends). Each run records `measurement.stream` (`asked`, live `deltas`, `turns`,
`turnsWithUsage`) in `cell.json` and `page.json`, and the page tags it `streamed`, or `not streamed` when it asked
and no delta came. Compare the arms' token figures only where `turnsWithUsage` equals `turns`: a provider can leave
usage off a stream.

## Interviews (a panel, read by a person or a model)

A task with `asks: [...]` is an INTERVIEW: each ask is sent once the turn before it ends, every turn's answer lands
in `outbox/turn-<n>.md` and in the cell's `turns`, and the page gets an **Answers** view (turns as rows, runs as
columns, each answer linked to its run). An ask may carry a check (`{ ask, expect, why }`) and a task conditional
`followUps`, written as a `.interview.ts` (`defineInterview`, see the `panel` skill): each answer checked shows "as
expected" or not, follow-ups sit under the answer that called for them. A panel interview file (`.json` or
`.interview.ts`) runs as a sweep directly:

```bash
USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/panel/bloat.json \
    --models deepseek.deepseek-v4-pro,litellm.google/gemini-flash-latest --serve
```

One run per model, all at once (`--jobs` overrides), each model PROBED first exactly as `panel.mjs` does, and
`summary.md` in the sweep directory is the file `panel.mjs` writes. On the live page a person selects a wrong line in
an answer and presses **mark wrong**; marks are kept in the sweep's `marks.jsonl` (an append-only log, each record saying who made it), and every later run of that model
and turn is CHECKED: does its answer still contain the marked line (case, spacing and markdown syntax folded, so a line selected from the rendered answer matches the raw text)? Answers show as markdown, rendered as the panel renders one, or raw (the toggle on the Answers card). The page and
`summary.md` say "still says" or "no longer says". A verbatim match is crude, but it turns a person's reading into
something the next run is held to. For a model reading results, `panel.mjs` is the same thing without a page.

## Flags

| Flag | What it does |
| --- | --- |
| `--jobs N` | N browsers at once. Good against a hosted API; **bad against one local GPU**, and it makes the `secs` column meaningless (the report says so). Default 1. |
| `--only k=v` | Select cells. Works on any dimension, plus `task=<id>` and `repeat=<n>`. Repeatable, ANDed. |
| `--skip k=v` | The inverse. |
| `--repeats N` | Override the spec's repeat count — use `--repeats 1` while iterating on a spec. |
| `--dry` | Print the matrix and its cell keys, run nothing. Do this before any long sweep. |
| `--no-cache` | Re-run cells that are already measured. |
| `--serve` | Serve the live page and print its URL. Costs nothing when nobody opens it; SSE, and the page is bundled from source in memory (no dist to rebuild). |
| `--open` | `--serve` plus launch a browser. |
| `--port N` | Serve on a specific port. The default (7331) is STABLE on purpose, so a browser tab can just reload between sweeps instead of needing a new URL. Falls back to any free port if taken. |
| `--models a,b` | With an interview file (`.json`, `.interview.ts`) in place of a spec: the models to put it to (or `PANEL_MODELS`). `--surface hud\|console` and `--turn-minutes N` as `panel.mjs` takes them. |
| `--pdf` | Also render each run to `run.html` + `run.pdf`. Off by default: it roughly triples a cell's disk and adds a render per run. The HTML is written alongside deliberately — it is searchable and diffable where a PDF is neither, and it is the only way to see why a PDF looks wrong. |

Backend selection is the same as observe: `USE_ENV=1` reads `.env`, `E2E_BACKEND`/`E2E_MODEL`/`E2E_KEY`
set one explicitly, and with neither it runs the scripted fake-LLM (which is what makes the smoke spec
deterministic). `apply()`'s `backend.model` overrides the model per cell.

## What it writes

**Everything the page shows is also a file**, rendered from the same data, and the sweep's last lines in the terminal
list them. A model driving the bench reads these; it never needs the page. Why, and the rules a new card or file follows (append-only
logs, who and when on every edit): [docs/dev/bench-design.md](../../../docs/dev/bench-design.md).

| On the page | In the sweep directory | From a terminal |
| --- | --- | --- |
| Results table | `report.md` (and `rows.json`) | read it |
| Answers, side by side | `summary.md` (`summary-<task>.md` with several interviews) | read it |
| "mark wrong" and its checks | `marks.jsonl` (append-only; who and when on each); each answer's checks in `summary.md` | add a mark: `node tests/e2e/bench/mark.mjs <sweep dir> --model <who> --turn <n> --quote "<line>" [--note "<why>"] --by "<who you are>"`; `--list` shows them. The next run of that model is checked for it. |
| Spec: which spec version ran, who started the sweep, the diff against the sweep before | `spec.md`; the log of every sweep, `sweeps.jsonl` (append-only) | read it. Set `BENCH_BY="<who you are>"` when you start a sweep, so it says who did. |
| Memory: the box's VRAM and RAM over the sweep, drawn with the resource panel's chart above the timeline's lanes (zoom, scrub and drag to select move both), and a "the box" row of what the server itself reported (loads in their two halves, evictions with its reason, serving spans, any client's generations) | `memory.md`: each pool's peak and mean use, each model's stretch in memory with whose it was (loaded for this sweep, used by it, or not its; also tagged in the chart's tooltips), and what the box reported; the readings and events themselves are in `page.json` (`resources`). Every frame of the server's event stream is kept in `tests/e2e/artifacts/bench/box.sqlite` (table `frames`, one row per frame, across sweeps) | read it; `sqlite3 tests/e2e/artifacts/bench/box.sqlite "SELECT datetime(at/1000,'unixepoch'), kind, json_extract(frame,'$.model') FROM frames WHERE kind LIKE 'load.%' ORDER BY at DESC LIMIT 20"` |
| Timeline | `timeline.md`: each run's start, end and busy time on one clock, which runs overlapped and for how long, then every span (model calls with their phases, tool steps, model loads, sub-calls) | read it |
| all of it | `page.json`: the exact state `report.html` renders | `jq` it |
| each model's score, in its pill (links to the scoreboard) | one level up, beside every sweep: `scores.md`, `scores.json`, `scores.html`, from the log `scores.sqlite` | `node tests/e2e/bench/scores.mjs` prints it and rewrites the three files |

### The scoreboard (every sweep, every model)

Every run a sweep makes against a REAL model (never the fake one, never a cached cell) is inserted into
`tests/e2e/artifacts/bench/scores.sqlite`, table `runs`, as it finishes: the model's tag plus the digest and
quantisation the server reports, the task's id plus a hash of its text and predicate, pass/fail, tokens, steps, the
build, who started the sweep and when. A row is never updated. `scores.mjs` fits a Rasch model over the predicate-scored
runs (`rasch.mjs`): a score θ per model and a difficulty per task, so models that ran different tasks compare. An ITEM
is a task's id, its wording and predicate, and what the model was SHOWN with it (`shown`, shown.mjs: the system prompt
and tool schemas from run.json, minus what moves between runs, a sight-dependent tool like `look` by name only): a branch
that rewords the prompt or a tool is a new item with its own difficulty, never pooled with main's; runs logged before
`shown` existed are one `legacy` item. Token
bloat is each run's tokens over the median run of the same task, averaged per model. Every number's meaning is in
`scores.md` under "How these numbers are computed", and in the page's tooltips. Ask the log anything else directly:
`sqlite3 tests/e2e/artifacts/bench/scores.sqlite "SELECT model, task, passed, tokens FROM runs ORDER BY at DESC LIMIT 20"`.

### The regression suite (can models still do it with our tools)

Every task in every spec MUST say `regression: { included, reason }` (the type requires it, `defineBench` refuses an
empty reason, and `tests/bench-regress.test.mjs` loads every spec here). Include a task only when it is scored from the
run itself, uses local fixtures only, has a fixed answer, does not depend on its spec's other dimensions, and some model
in the list neither always passes nor always fails it (`RegressionChoice` in spec.ts). Run the suite by hand, never
automatically, over any model list:

```bash
npm run build
USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs --regression --models a,b,c --repeats 3 --lanes --serve
```

It prints first how small a shift each task could show with that list and repeat count. Its runs are logged with
`suite = 'regression'`. `regress.mjs` reads them: P(pass) = σ(θ − b − δ) with θ per model and b per task fixed across
builds, δ the build's shift of each task, Student-t around a build-wide μ. μ is the headline (flagged at P(μ > 0) ≥ 95%);
a task is flagged by the false discovery rate at 10% on P(δ > 0.5). Here a regression item is the task id plus its own
hash, never `shown`: the prompt is part of the build being compared. The verdict tops `scores.md` and the scoreboard
page, with which models fell on each flagged task, and μ for every earlier build. With 3 models × 3 repeats a single
task must get about 2 logits harder to be caught most of the time; more repeats is the lever.

### Spend (what each model call cost, kept raw)

Every model call of a logged run goes into `scores.sqlite`, table `calls`, beside its run: one row per call, in order,
with the usage the extension recorded for it, verbatim (`usage` JSON: the counts, `raw` the server's own usage block with
a provider's `cost` when it sends one, `prices` the price snapshot the call ran under, `electricity` the price per kWh
set then). `kind` is `turn` (the driver's) or `sub` (a delegated look, locate or verify, which records counts only). The
model is read from the run's `gen` event with the same counts, and is null when none matches. Each price snapshot body a
call names is kept once in `snapshots`, by its sha256, fetched from the extension's worker (`__mlPriceBody`) at the end
of the run only when the log lacks it, and refused when it does not hash to its name. Nothing is priced on write: a cost
is computed when read (`cost.mjs`): `scores.md` and `scores.json` carry a Spend section per model, `computed` (tokens x the snapshot's per-token rates, joined through the box's model list (an Open WebUI preset priced as the model it wraps) to the box's LiteLLM routes, OpenRouter's list, then LiteLLM's map (also as `<connection>/<id>`; LiteLLM's 0 is no price); a long-context tier when the prompt is past it) beside `reported` (the provider's own `cost`), local calls apart (electricity), and calls neither prices counted with the reason. Set `PRICE_SNAPSHOT_URL`, `ELECTRICITY_PER_KWH` and `ELECTRICITY_CURRENCY` (env or `.env`) for a
real run to record them; unset records nothing, never zero. Runs logged before this have no calls, which means "no
per-call data". Both tables sync with the store (views `calls`, `price_snapshots`).
`sqlite3 tests/e2e/artifacts/bench/scores.sqlite "SELECT run, call, model, json_extract(usage,'$.raw.cost') FROM calls ORDER BY id DESC LIMIT 20"`

While a sweep runs, the same pricing runs live (`live-spend.mjs`): each call's usage is read off the run's event stream
as it arrives and priced against the snapshot it names, a body the log lacks fetched from `PRICE_SNAPSHOT_URL/raw/<sha256>`,
checked, and kept in `snapshots`. The page shows it as a `spent` badge in the header (the whole invocation) and a
`spent` segment on each driver model's pill, computed first and reported in the tip; a `+` means some calls are unpriced
or still waiting on their snapshot. `page.json` carries it as `spend`, the terminal prints it as one line at the end, and
`scores.html` has a Spend card from the logged calls.

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
