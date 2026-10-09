// panel.mjs — one INTERVIEW put to several real models at once, each in its own session, so a change to the API, the
// prompt or the tools is judged by how models in general read it rather than by the one model at hand.
//
//   USE_ENV=1 node --import tsx tests/e2e/panel.mjs tests/e2e/panel/bloat.json \
//       --models deepseek.deepseek-v4-pro,litellm.google/gemini-flash-latest,openrouter.anthropic/claude-sonnet-5.5
//
// An interview file (tests/e2e/panel/*.json) is { task, asks?: string[], surface?, sharedWatches?, watchNotes? }: the
// first message, then each follow-up, sent once the turn before it has ended. Before anything starts every model is
// PROBED with one tool call through the configured backend, and one that cannot make it is reported and skipped (a
// misconfigured connection otherwise looks like a model that ignored the task). The result is <out>/summary.md: per
// model, the calls each turn took and how it ended, then every answer side by side, turn by turn. Each model's whole
// session is in <out>/<model>/ (run.md, run.json, outbox/turn-<n>.md, run.log).
//
// The same interview is a bench sweep too, for a person to read in the browser (answers side by side, each one
// markable as wrong): `node --import tsx tests/e2e/bench/run.mjs tests/e2e/panel/bloat.json --models a,b --serve`.
// Both drive interview.mjs (the probe, the per-turn report, the follow-up driver, the summary).
//
// Options: --models a,b,c (or PANEL_MODELS), --out <dir> (default tests/e2e/artifacts/panel-<name>-<time>),
// --surface hud|console (overrides the file; hud is a run started as from the UI), --turn-minutes N (default 15).
// See .claude/skills/panel/SKILL.md for reading the results.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce, resolveBackendFromEnv } from "./run-once.mjs";
import { loadInterview, probe, interviewDriver, readTurns, promptChars, panelSummary, modelSlug } from "./interview.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The command line: the interview file, then `--name value` options. */
function parseArgs(argv) {
    const opts = { file: null, models: (process.env.PANEL_MODELS || "").split(","), out: null, surface: null, turnMinutes: 15 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--models") opts.models = argv[++i].split(",");
        else if (a === "--out") opts.out = argv[++i];
        else if (a === "--surface") opts.surface = argv[++i];
        else if (a === "--turn-minutes") opts.turnMinutes = Number(argv[++i]);
        else if (!opts.file) opts.file = a;
        else throw new Error(`panel: unexpected argument ${a}`);
    }
    opts.models = opts.models.map((m) => m.trim()).filter(Boolean);
    if (!opts.file || !opts.models.length) throw new Error("usage: panel.mjs <interview.json> --models a,b,c [--out dir] [--surface hud|console]");
    return opts;
}

/** One model's whole interview, in its own browser: the task, each follow-up as the turn before it ends, then done. */
async function interview(model, iv, opts, outDir, backend) {
    const dir = path.join(outDir, modelSlug(model));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const log = fs.openSync(path.join(dir, "run.log"), "w");
    const { nextTurn, statuses } = interviewDriver({ asks: iv.asks, dir });
    const surface = opts.surface ?? iv.surface ?? null;
    let error = null;
    try {
        const r = await runOnce({
            task: iv.task, start: "/step3",
            sharedWatches: iv.sharedWatches ?? [], watchNotes: iv.watchNotes ?? {},
            surface: surface && surface !== "console" ? surface : null,
            backend: { ...backend, model }, artDir: dir, approve: "auto", nextTurn,
            timeoutMs: opts.turnMinutes * 60_000,
            warm: process.env.WARM !== "0", synthetic: process.env.SYNTHETIC !== "0",
            focusSidebar: false, hold: false,
            log: (s) => fs.writeSync(log, s + "\n"),
        });
        error = r?.error ?? null;
    } catch (e) { error = String(e?.message || e); }
    fs.closeSync(log);
    if (error && !statuses.length) statuses.push(`failed: ${error.slice(0, 200)}`);
    const expected = iv.asks.length + 1;
    return { model, dir, turns: readTurns(dir, expected), statuses, prompt: promptChars(dir), expected };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const iv = loadInterview(opts.file);
    const outDir = path.resolve(opts.out || path.join(HERE, "artifacts", `panel-${iv.name}-${Date.now()}`));
    fs.mkdirSync(outDir, { recursive: true });
    const backend = await resolveBackendFromEnv({ ...process.env, USE_ENV: process.env.E2E_BACKEND ? "" : "1" });
    if (!backend) throw new Error("panel: no backend (set USE_ENV=1 with .env, or E2E_BACKEND)");
    console.log(`panel ${iv.name}: probing ${opts.models.length} model(s) for a tool call…`);
    const probed = await Promise.all(opts.models.map(async (model) => ({ model, why: await probe(backend, model) })));
    const skipped = probed.filter((p) => p.why);
    for (const s of skipped) console.log(`  ✗ ${s.model}: ${s.why}`);
    const ok = probed.filter((p) => !p.why).map((p) => p.model);
    console.log(`  running ${ok.length}: ${ok.join(", ")}  →  ${outDir}`);
    const results = await Promise.all(ok.map((m) => interview(m, iv, opts, outDir, backend)));
    const surface = opts.surface ?? iv.surface ?? null;
    fs.writeFileSync(path.join(outDir, "summary.md"), panelSummary(iv.name, iv, results, skipped, surface));
    for (const r of results) console.log(`  ${r.model}: ${r.turns.map((t) => t.tools.length + (t.capped ? "(cap)" : "")).join(" / ")} calls`);
    console.log(`summary: ${path.join(outDir, "summary.md")}`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
