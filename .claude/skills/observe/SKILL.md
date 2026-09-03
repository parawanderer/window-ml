---
name: observe
description: Drive ONE window.ml agent run in a real Chromium and inspect it — the primary way to debug the extension itself, watch a run live, or sweep model rule-adherence. Use when you need to see what an agent actually did (run.md + screenshots), test against a real local/API model, or watch a run unfold in the real UI.
---

# observe — the window.ml run wrapper

`tests/e2e/observe.mjs` drives a single `ml.agent` run in the built extension (real Chromium) and writes
artifacts you read back. It is a **debug/observation tool, not a test** — reach for it to see what an agent
did, iterate on the extension, validate a fix against a real model, or watch a run live.

## Run it

```
node --import tsx tests/e2e/observe.mjs
```

Configure everything with **env vars** (all optional):

| Var | What it does |
| --- | --- |
| `TASK="…"` | The agent task. Default is a findByText demo. |
| `START=/spreadsheet` | Start route. Any served example page (`/spreadsheet`, `/find-waldo`, `/canvas-input`, `/shadow-dom`, `/agent-hell`, …), the cross-page chain (`/`, `/step2`, `/step3`), or a fixture (`/slow`, `/lazy`, `/table`). `GET /examples` lists them. |
| `USE_ENV=1` | Real model: read `OPENWEBUI_URL/KEY/MODEL` (+ `OPENWEBUI_UTILITY_MODEL`/`OPENWEBUI_VISION_MODEL`) from `.env`. |
| `E2E_MODEL=<id>` | Override the model (e.g. `deepseek.deepseek-v4-pro`, `gemma4:31b`, `dsv4-flash:q4kxl`). With no backend vars → the deterministic **fake-LLM**. |
| `TOOLTOKENS=1` | Enable tool tokens (the `@tool:` embed/answer feature). |
| `PYTHON=1` | Wire `python_exec` (for `{ tables }`→DataFrame / sympy / numpy work). |
| `TOOLS=findByText,answer` | Limit to a subset of `ml.domTools` — smaller system prompt + fewer schemas = far fewer tokens/turn. |
| `FOLLOWUP="…"` | Run a SECOND turn in the SAME session (via `createAgent` + two `run()`s, so both turns share the run hash). Reproduces multi-turn behaviour a single `ml.agent()` can't — e.g. a "…now show the work" follow-up, or the cross-turn token-id collision. `TASK` is turn 1, `FOLLOWUP` is turn 2. |
| `WARM=0` | Skip the VRAM warm-up. A **local** model wants it warmed (omit `WARM=0`); the fake/API don't need it. |
| `APPROVE=<policy>` | How the built-in approval poller resolves a gate the run halts on: `auto` (default), `deny`, `readonly` (approve exec + readonly python only), `hold` (log but don't resolve — for manual clicking in WATCH). Every gate + decision is logged, so a run never hangs silently. |
| `WATCH=1` | HOLD the browser open at the end (close the window / Ctrl+C to exit) instead of tearing down — for inspecting a finished run. (The sidebar auto-opens + focuses on the session by DEFAULT, so a watching human never clicks; `WATCH` only adds the hold. `WATCH=0` is off, like `WARM=0`.) |
| `RUN_LABEL=my-run` | Names the artifact dir (else a timestamp). Use stable labels to diff before/after a fix. |

## Read the artifacts

Written to `tests/e2e/artifacts/<RUN_LABEL|timestamp>/` (gitignored):

- **`run.md`** — the extension's OWN canonical markdown transcript (the "Export log" output): task, every
  step's In/Out, tool renders, the answer + its `@tool:` citations, model provenance. **Read this first.**
- **`step-<n>.png`** / **`final.png`** — a screenshot per step (`look`/`locate` crops included).
- **`run.json`** — the same session as the machine-readable export (`docs/spec/PROGRAMMATIC_EXPORT.md`):
  steps with arguments/results verbatim, per-model token totals, outcome flags. **Diff two runs with this,
  not `run.md`** — markdown diffs are dominated by layout. Unlike `events.json` it needs no reducer replay.
- **`events.json`** — the raw `__mlDebug` event stream (parse it for exact fields: `renderOut`, `token`,
  `answer`, `outputs`, per-step `tool`/`arguments`/`result`).
- **`transcript.txt`** — console + step log.

## Gotchas

- **The browser is headful and closes the instant the run ends.** A short run flashes past, which
  looks like "it never launched". `WATCH=1` holds it open. (`WATCH=0` used to hold it too — the check
  tested the variable's PRESENCE — so a run that seemed stuck was actually finished. Fixed; `WATCH=0`
  is now off, matching `WARM=0`.)
- **Three different step counts, all correct.** The console line ("N steps") is the observer's own
  tally; `AgentResult.steps` is the loop's TURN count; `run.json`'s `steps[]` is one record per
  emitted event — a turn contributes a thought AND its tool call. A run can print "0 steps", return
  `steps: 2`, and export 5 records without anything being wrong. `outcome.turnsRun` is the one to
  compare against `maxSteps`.
- **In a fresh worktree, `python_exec` fails with `No module named 'numpy'`** until `pyodide-wheels/`
  is present — see the worktree note in AGENTS.md. The build warns once and carries on, so the first
  sign is a traceback inside a step.

## Typical uses

- **Debug a fix:** `RUN_LABEL=before …` then `RUN_LABEL=after …`, diff the two `run.md`s + screenshots.
- **Real-model check:** `USE_ENV=1 E2E_MODEL=gemma4:31b TOOLTOKENS=1 PYTHON=1 TASK="…" node --import tsx tests/e2e/observe.mjs`
- **Rule-adherence sweep:** run the same TASK across several `E2E_MODEL`s, compare the `run.md` answers
  (does it cite `![…](@tool:…)`, use `:in`, avoid retyping?). Inspect `events.json` for `summary`/`answer`.
- **Watch live:** every run auto-opens the sidebar focused on the session, so you can review it AS it runs;
  add `WATCH=1` to keep the browser open after it finishes.

## Gotchas

- Needs the **built** `dist/` — observe loads the built extension. It doesn't auto-build; run `npm run build`
  first if you changed source (`npm test` builds via `pretest`, but a bare `node …/observe.mjs` does not).
- A gate the run halts on is only resolvable because the run opts into `approvalRouting:"both"`; the poller
  uses the SW-only `__mlApprovals` channel. If `APPROVE=hold`, resolve it yourself (WATCH + click, or via the
  channel from `ext.sw`).
- Headful by default (an MV3 service worker doesn't register headless); CI runs e2e under `xvfb`.
- `page.evaluate(() => window.ml.agent(...))` is the front door — the SAME call a human makes from the
  console. `res.elements` holds live DOM nodes and can't structured-clone back to Node; a run that designates
  elements will fail to return them (read them from the artifacts instead).

**Keep this skill + the AGENTS.md `observe.mjs` bullet in sync with the script** whenever you change its
behaviour — that's the repo rule (AGENTS.md → Conventions → "self-tools get a skill").
