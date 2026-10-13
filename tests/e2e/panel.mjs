// panel.mjs — one INTERVIEW put to several real models at once, each in its own session, so a change to the API, the
// prompt or the tools is judged by how models in general read it rather than by the one model at hand.
//
//   USE_ENV=1 node --import tsx tests/e2e/panel.mjs tests/e2e/panel/bloat.json \
//       --models deepseek.deepseek-v4-pro,litellm.google/gemini-flash-latest,openrouter.anthropic/claude-sonnet-5.5
//
// It IS the bench, without its page: `bench/run.mjs <interview> --models …` with the same options, so a panel is a
// sweep under tests/e2e/artifacts/bench/<interview name>/ like any other (summary.md with every answer side by side,
// each model's session in its run directory, timeline.md, page.json), logged to the scoreboard, counted by the memory
// budget, and pushed to the bench store with everything else. Add `--serve` to watch it and mark a wrong answer. Until
// 2026-10-13 it wrote tests/e2e/artifacts/panel-<name>-<time>/ instead, which no push sent.
//
// An interview file (tests/e2e/panel/*.json) is { task, asks?: string[], surface?, sharedWatches?, watchNotes? }: the
// first message, then each follow-up, sent once the turn before it has ended. `<name>.interview.ts` (`defineInterview`,
// bench/spec.ts) is the same as code, with checks on the answers (`expect`) and conditional `followUps`. Every model is
// PROBED with one tool call first, and one that cannot make it is reported and skipped.
//
// Options, as run.mjs takes them: --models a,b,c (or PANEL_MODELS), --surface hud|console, --turn-minutes N (default
// 15), and any other run.mjs flag (--repeats, --jobs, --no-sync, …). `--out` is gone: a sweep lives under its name.
// The real backend from .env is the default (USE_ENV=1), unless E2E_BACKEND names another.
// See .claude/skills/panel/SKILL.md for reading the results.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes("--out")) {
    console.error("panel: --out is gone. A panel is a bench sweep now, written to tests/e2e/artifacts/bench/<interview name>/.");
    process.exit(2);
}
if (!argv.some((a) => !a.startsWith("-"))) {
    console.error("usage: panel.mjs <interview.json | .interview.ts> --models a,b,c [--surface hud|console] [--turn-minutes N] [run.mjs flags]");
    process.exit(2);
}
const env = { ...process.env, ...(process.env.E2E_BACKEND || process.env.USE_ENV ? {} : { USE_ENV: "1" }) };
const r = spawnSync(process.execPath, [...process.execArgv, path.join(HERE, "bench", "run.mjs"), ...argv], { stdio: "inherit", env });
process.exit(r.status ?? 1);
