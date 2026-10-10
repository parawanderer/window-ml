// run.mjs — walk a bench spec's matrix and report it.
//
//   node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/pointer-ids.bench.ts
//   … --jobs 4            run 4 browsers at once (a hosted API; NOT a local GPU — see below)
//   … --no-sync / --only-db   when a bench store is configured (sync.mjs), do not push this sweep / push only the rows
//   … --lanes             one lane per model: each model's runs in turn, different models at once when the box says
//                         the next fits beside what is loaded (/api/fits); a cloud model always goes. `--jobs N` caps
//                         the lanes running at once. An interview runs this way unless --jobs is given
//   … --only idFormat=label --only task=two-tables      re-measure a subset
//   … --repeats 2 --dry   print the matrix and stop
//   … --no-cache          re-run cells that are already measured
//   … --pdf               also render each run to run.html + run.pdf (slower, and much larger)
//   … --capture always    snapshot the browser (screenshot + DOM, every open page) on EVERY run, not
//                         just the failures — the default is `failure`, and `never` turns it off
//   … --serve             serve a live page: every run's state, what is queued, the table filling in. When the
//                         sweep ends the page stays up (a detached server; `serve.mjs --stop` stops it) and the
//                         process EXITS, so whoever started it in the background learns it is done
//   … --serve --open      …and open it in a browser
//   … tests/e2e/panel/bloat.json --models a,b,c    an INTERVIEW file instead of a spec: one run per model, each
//                         follow-up sent as the turn before it ends, the answers side by side on the page (where a
//                         person can mark one wrong) and in summary.md; `--surface hud|console` as panel.mjs takes it
//   … --hold all | failures | k=v   keep those cells' runs open after their last turn, each in a detached process, to go
//                         on talking to (`failures`: only a run that errored or was wrong). The sweep still exits; the
//                         attach lines are printed above BENCH DONE (bench/hold.mjs lists and releases them).
//                         `--hold-idle 60` releases one after that many minutes with no message (default 30). A held
//                         run's browser is headless, as every bench browser is; `--hold-window` makes it a minimised real
//                         window instead (`hold.mjs --show` brings it up), at the cost of one window popping up per held cell
//   … --memory-limit 12G  the most the bench may hold in this machine's memory (browsers held open, its own processes),
//                         across every bench process here (memory-budget.mjs; default half the RAM). A quarter of the RAM
//                         is also kept free, checked live before each cell starts and before a failed run is kept open.
//   … --when-full pause | stop-holding   at the budget: `pause` (the default) starts no more cells, holds nothing more, and
//                         exits 75 once the running cells end, printing what is held and the command that resumes;
//                         `stop-holding` goes on running and records each later failure as "would have held" (overnight)
//   … --port 7400         serve on a specific port (the default is stable, so a browser tab can just
//                         reload between sweeps — in VS Code, cmd-click the URL and pick "Simple
//                         Browser" to dock the page as an editor tab)
//
// The division of labour this is built for: an agent defines the benchmark in code, runs it, and reads the
// terminal; a human watching over its shoulder opens the page. Same data, two audiences — which is why
// `--serve` prints the URL as a banner rather than a log line, so the assistant can hand it over.
//
// The last line a sweep prints is `BENCH DONE <name> runs=… ok=… errors=… report=… page=…` (also done.json in the sweep
// directory), and it exits 0 when no run errored, 2 when some did, 1 when the runner itself failed, 75 when it paused at
// the memory budget (run the same command again to go on).
//
// The sweep is RESUMABLE: each cell's measurement is written under a content-addressed key covering the
// cell's configuration AND the build it ran against, so a six-hour sweep that dies at hour five resumes
// rather than restarting, and an edit to the extension invalidates what it invalidates instead of silently
// mixing two builds into one table.
//
// This is a self-tool, not a test: `npm test` globs tests/*.test.* and never picks it up. See the `bench`
// skill for the playbook.

import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce, resolveBackendFromEnv, renderRun, FAKE_MODEL } from "../run-once.mjs";
import { measureRun, aggregate, isRateLimit } from "./metrics.mjs";
import { expandCells, cellKey, cellPath, comboLabel, buildGroups, parseSelector, slug, cellStream, runConfig } from "./cells.mjs";
import { holdMode, loadSpec, startHeld, heldWindow, HOLD_IDLE_MIN } from "./hold.mjs";
import { writeReport, mdSink, terminalSink, doneSummary, doneLine } from "./sinks.mjs";
import { startDashboard, staticPage, servedSweep } from "./serve.mjs";
import { pageSources } from "./page/bundle.mjs";
import { addMark, readMarks, defaultBy } from "./mark.mjs";
import { recordSweep, specProvenance, specText, keepEarlierRun, cellsOnDisk, sortOnDisk } from "./sweeps.mjs";
import { runLanes, fitsGate, settleUntilResident } from "./lanes.mjs";
import { shownFingerprint } from "./shown.mjs";
import { storeFromEnv, openStore, push as pushToStore } from "./sync.mjs";
import { timelineText, labelSeed, seedEndOf, SEED_LABEL } from "./timeline-text.mjs";
import { memoryText } from "./resource-poll.mjs";
import { startBox, openBoxLog, BOX_DB } from "./box-stream.mjs";
import { repoUrl } from "../../../scripts/gen-build-info.mjs";
import { openScores, modelInfo, runRow, logRuns, readRuns, scoreboard, sweepScores, writeScoreFiles, unscoredTasks, modelKey, SCORES_DB } from "./scores.mjs";
import { plannedPower } from "./regress.mjs";
import { callsOf, logCalls, logSnapshot, missingSnapshots } from "./spend.mjs";
import { liveSpend, fetchFromPriceService, spendLine } from "./live-spend.mjs";
import { statusWriter } from "./status.mjs";
import { startBudget, tooSmall, limitWhence, fmtBytes, parseSize, register, update, unregister, openFootprints, logFootprint, ledger, PAUSED_EXIT } from "./memory-budget.mjs";
import { failureShape, menuText, groupHeld, groupCommands, shellLine, inDir, HOLD_HINTS } from "./hold-menu.mjs";
import { fitRasch } from "./rasch.mjs";
import { watch as watchFs } from "node:fs";
// The sweep's timeline: each run's events as the resource panel derives them; the page draws them with its lane.
const { eventsFrom } = await import("../../../src/sidebar/resource/model-stats.ts");
import { isInterviewFile, loadInterviewFile, driverFor, isInterviewTask, readFollowUps, expectTally, askText, readTurns, followContinued, probe, panelSummary, promptChars, checkMarks, validMark } from "../interview.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ARTROOT = path.join(ROOT, "tests/e2e/artifacts/bench");
const BUILDROOT = path.join(ROOT, "tests/e2e/artifacts/builds");
/** The regression suite's spec (`--regression`): every included task of every spec, over `--models`. */
const REGRESSION_SPEC = path.join(HERE, "specs/regression.bench.ts");

function parseArgv(argv) {
    const args = { specPath: null, models: (process.env.PANEL_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean), surface: undefined, turnMinutes: 15, jobs: 1, jobsSet: false, lanes: false, only: [], skip: [], repeats: undefined, dry: false, cache: true, pdf: false, serve: false, open: false, port: undefined, capture: undefined, hold: [], holdIdle: undefined, memoryLimit: undefined, whenFull: "pause" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--jobs") { args.jobs = Math.max(1, Number(argv[++i]) || 1); args.jobsSet = true; }
        else if (a === "--lanes") args.lanes = true;
        else if (a === "--regression") args.specPath = REGRESSION_SPEC;
        else if (a === "--no-sync") args.sync = false;
        else if (a === "--only-db") args.onlyDb = true;
        else if (a === "--only") args.only.push(argv[++i]);
        else if (a === "--skip") args.skip.push(argv[++i]);
        else if (a === "--hold") args.hold.push(argv[++i]);
        else if (a === "--hold-idle") args.holdIdle = Number(argv[++i]) || undefined;
        else if (a === "--hold-window") args.holdWindow = true;
        else if (a === "--memory-limit") {
            args.memoryLimit = parseSize(argv[++i]);
            if (args.memoryLimit == null) throw new Error(`--memory-limit takes a size such as 12G or 512M, not ${argv[i]}`);
        } else if (a === "--when-full") {
            args.whenFull = argv[++i];
            if (!["pause", "stop-holding"].includes(args.whenFull)) throw new Error(`--when-full takes pause or stop-holding, not ${args.whenFull}`);
        }
        else if (a === "--hold-headless") args.holdWindow = false;   // the default now; kept so an old command line still parses
        else if (a === "--repeats") args.repeats = Math.max(1, Number(argv[++i]) || 1);
        else if (a === "--dry") args.dry = true;
        else if (a === "--no-cache") args.cache = false;
        else if (a === "--pdf") args.pdf = true;
        else if (a === "--capture") args.capture = argv[++i];
        else if (a === "--models") args.models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
        else if (a === "--surface") args.surface = argv[++i];
        else if (a === "--turn-minutes") args.turnMinutes = Number(argv[++i]) || 15;
        else if (a === "--serve") args.serve = true;
        else if (a === "--port") { args.serve = true; args.port = Number(argv[++i]) || 0; }
        else if (a === "--open") { args.serve = true; args.open = true; }
        else if (!a.startsWith("--")) args.specPath = a;
    }
    return args;
}

/**
 * What code did this measure? The commit, plus a digest of any uncommitted changes.
 *
 * A dirty tree does not block a sweep — iterating on the bench itself means measuring uncommitted code all
 * the time — but it goes in the cache key and is stated in the report, because "these numbers came from
 * commit X" is otherwise a claim the sweep cannot support.
 */
function buildFingerprint() {
    const git = (args) => { try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } };
    const head = git(["rev-parse", "HEAD"]) || "nogit";
    const diff = git(["diff", "HEAD"]);
    if (!diff) return { fingerprint: head, dirty: false };
    return { fingerprint: `${head}+${createHash("sha256").update(diff).digest("hex").slice(0, 8)}`, dirty: true };
}

/**
 * Build the extension into its own directory for a variant's `defines`, reusing it if it is already there.
 * An experimental dimension is a build-time define rather than a config flag: the build is ~25ms, and a
 * hypothesis that may conclude "the current design was fine" should leave no trace in the product.
 */
async function buildVariant(group, fingerprint, log) {
    if (group.id === "default") {
        if (!existsSync(path.join(ROOT, "dist", "manifest.json"))) {
            log("  building dist/ …");
            execFileSync("node", ["build.mjs"], { cwd: ROOT, stdio: "pipe" });
        }
        return null;   // null → runOnce loads dist/
    }
    const dir = path.join(BUILDROOT, `${slug(fingerprint).slice(0, 12)}-${group.id}`);
    if (existsSync(path.join(dir, "manifest.json"))) return dir;
    log(`  building variant ${group.id} (${Object.entries(group.defines).map(([k, v]) => `${k}=${v}`).join(" ")}) …`);
    await mkdir(path.dirname(dir), { recursive: true });
    const defines = Object.entries(group.defines).flatMap(([k, v]) => ["--define", `${k}=${v}`]);
    execFileSync("node", ["build.mjs", "--outdir", dir, ...defines], { cwd: ROOT, stdio: "pipe" });
    return dir;
}

/**
 * Render a finished run to `run.html` + `run.pdf`.
 *
 * The HTML is the same self-contained print document the sidebar's PDF export builds, and it is written
 * alongside the PDF rather than thrown away: it costs nothing (it IS the input), it is searchable and
 * diffable where a PDF is neither, and when a PDF looks wrong it is the only way to see why.
 *
 * Rendered by a PLAIN headless Chromium, not the harness's own browser — `page.pdf()` is headless-only and
 * the extension one runs headful (an MV3 service worker does not register headless). Nothing about this
 * page needs the extension: it is a static document.
 */
let pdfBrowser = null;   // shared: launching one per cell would dominate the runtime of a sweep
async function renderPdf(session, dir, name) {
    const { sessionToHtml } = await import("../../../src/sidebar/export/export.ts");
    const html = sessionToHtml(session, name);
    await writeFile(path.join(dir, "run.html"), html);
    // `||=` on a promise, not on the browser: with --jobs N several cells reach here at once, and awaiting
    // the value would let each start its own launch.
    pdfBrowser ||= chromium.launch({ headless: true });
    const page = await (await pdfBrowser).newPage();
    try {
        await page.setContent(html, { waitUntil: "load" });
        await page.pdf({ path: path.join(dir, "run.pdf"), format: "A4", printBackground: true,
            margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
    } finally { await page.close().catch(() => {}); }
}

/** Run one cell (or read it back from cache) and return its measurement. */
async function runCell(cell, ctx, index) {
    const key = cellKey(cell, ctx.fingerprint);
    const dir = path.join(ctx.sweepDir, cellPath(cell));
    const cacheFile = path.join(dir, "cell.json");

    // A cell to hold always runs: a cached result has no browser to keep. One held only on failure keeps its cache.
    const hold = holdMode(cell, ctx.holdCli);
    if (ctx.cache && hold !== "always" && existsSync(cacheFile)) {
        try {
            const saved = JSON.parse(await readFile(cacheFile, "utf8"));
            // A run that ERRORED (the backend refused, timed out, crashed) measured nothing about the model: run it
            // again rather than serve the error from the cache. A finished run, right or wrong, is kept.
            if (saved.key === key && saved.measurement && !saved.measurement.ok) {
                ctx.retried++;
                ctx.log(`  ↻ ${cellPath(cell)}: errored last time${isRateLimit(saved.measurement.error) ? " (rate-limited)" : ""}, running it again`);
            } else if (saved.key === key) {
                ctx.cached++;
                const hit = { ...saved, dir, fromCache: true };
                ctx.report?.(index, "done", hit);
                return hit;
            }
        } catch { /* unreadable cache → re-run */ }
    }
    // The memory budget (memory-budget.mjs): no cell starts once the sweep paused at it, nor while its browser would not fit.
    if (!(await memoryLets(cell, ctx))) return null;
    // Where its artifacts land is known now, so the page can open a run WHILE it runs: they are rewritten on every
    // event, and the open viewer reloads as the run moves.
    ctx.report?.(index, "running", { path: path.relative(ctx.sweepDir, dir) });
    // A run already there is moved to the sweep's history, never deleted: it may be the only copy of it.
    const kept = await keepEarlierRun(ctx.sweepDir, cellPath(cell)).catch((e) => { ctx.log(`  (could not keep the earlier run of ${cellPath(cell)}: ${e.message}; it is replaced)`); return null; });
    if (kept) { ctx.kept.push(kept); ctx.log(`  ↪ ${cellPath(cell)}: the run already there is kept in ${kept}/`); }
    await rm(dir, { recursive: true, force: true });   // a re-run must not read a stale run.md as its own
    await mkdir(dir, { recursive: true });

    const t = cell.task;
    const label = `${comboLabel(cell.combo)} · ${t.id} · r${cell.repeat}`;
    ctx.log(`  ▶ ${label}`);

    // An interview: each ask is sent once the turn before it ends, and every turn's answer lands in outbox/, read
    // back as the run goes so the page fills in turn by turn rather than at the end.
    const driver = !hold && isInterviewTask(t) ? driverFor(t, dir, cell.effects.backend?.model ?? ctx.backend?.model ?? null) : null;
    const onTurns = () => ctx.report?.(index, "running", { turns: readTurns(dir) });
    const nextTurn = driver && (async (info) => {
        const next = await driver.nextTurn(info);
        onTurns();
        return next;
    });
    // The in-flight run's own debug stream, reduced to what a watcher wants: how far in it is, against what budget,
    // what it is doing right now, and the last thing that actually happened. A sweep cell takes minutes; without this a
    // running row is a spinner, and a slow step is indistinguishable from a wedged one.
    const onEvent = (ev) => {
        ctx.rawOf?.(index)?.push(ev);
        // A model call's usage rides the same stream: priced as it comes, for the page's spend (live-spend.mjs).
        const spent = ctx.spendOn?.(index, ev);
        const live = { ...(ctx.liveOf?.(index) || {}) };
        if (ev.kind === "agent") { live.maxSteps = ev.maxSteps; live.last = "started"; }
        else if (ev.kind === "agent-step" && ev.tool) {
            live.step = ev.step;
            live.tool = ev.tool;
            live.pending = !!ev.pending;
            // The DONE carries the result; a pending START does not. Show what came back, clipped —
            // this is a status line, not a transcript (the transcript is one click away).
            if (!ev.pending) live.last = `${ev.tool} → ${String(ev.result ?? "").replace(/\s+/g, " ").slice(0, 90)}`;
            else live.last = `calling ${ev.tool}`;
        } else if (ev.kind === "agent-step" && (ev.thought || ev.reasoning)) {
            live.step = ev.step ?? live.step;
            live.tool = "thinking";
            live.last = String(ev.thought || ev.reasoning).replace(/\s+/g, " ").slice(0, 90);
        } else if (ev.kind === "agent-result") {
            live.tool = "answered";
            live.last = String(ev.summary ?? "").replace(/\s+/g, " ").slice(0, 90);
        } else {
            if (spent) ctx.report?.(index, "running", {});
            return;
        }
        ctx.report?.(index, "running", { live });
    };
    const env = { backend: ctx.backend, dist: ctx.buildDirs.get(cell) ?? null, approve: ctx.spec.approve, capture: ctx.capture, timeoutMs: ctx.spec.timeoutMs, warm: ctx.warm };
    let run, statuses = driver?.statuses ?? [], held = null;
    try {
        if (hold) {
            // Its own detached process (hold.mjs), which hands the run back here to be measured and can outlive the sweep.
            held = startHeld({ ...ctx.held.job, index, key, fingerprint: ctx.fingerprint, dir, env, sweep: ctx.spec.name, label,
                window: ctx.held.window, idleMs: (ctx.held.idleMin ?? t.holdIdleMinutes ?? HOLD_IDLE_MIN) * 60_000 }, { onEvent, onTurns });
            // In the ledger while it runs, so the budget counts its browser (a detached child is not the runner's).
            try { register({ kind: "running", pid: held.pid, sweep: ctx.spec.name, repo: ROOT, cell: label, task: t.id, model: driverModel(cell, ctx) }); } catch { /* the budget then counts it under the runner */ }
            ({ run, statuses } = await held.ran);
        } else run = await runOnce(runConfig(cell, env, dir, { ...(nextTurn ? { nextTurn } : {}), onEvent,
            havePrice: ctx.scores ? (h) => !missingSnapshots(ctx.scores, [h]).length : null }));
    } catch (err) {
        run = { events: [], result: null, error: String(err), runMs: 0, approvals: [], seedBoundaryStep: -1 };
    }

    const measurement = measureRun({ ...run, stream: run.stream ?? cellStream(cell) }, t);
    // Kept open when asked to, or (`failures`) when the run errored or got it wrong, while the budget has room; else its
    // process lets go now.
    const entry = held && await keepOrRelease(held, { want: hold === "always" || !measurement.ok || measurement.succeeded === false, measurement, run, cell, label, dir, ctx });
    if (entry) ctx.held.runs.push(entry);
    ctx.finalSession?.(index, run.session ?? null, run.events ?? []);
    // An interview's answers, turn by turn, kept with the cell so a cached one still sets them side by side.
    const turns = isInterviewTask(t) ? readTurns(dir, (t.asks?.length ?? 0) + 1) : null;
    // Turns asked only because an answer called for them, under the turn they followed, and how the checks came out.
    const followUps = turns ? readFollowUps(dir) : [];
    const expects = turns ? expectTally(turns) : null;
    // Best-effort: a failed render must not lose the cell's measurement, which is the expensive part.
    if (ctx.pdf && run.session) {
        await renderPdf(run.session, dir, `${slug(ctx.spec.name)}-${t.id}-r${cell.repeat}`)
            .catch((e) => ctx.log(`  (pdf render failed for ${label}: ${String(e).slice(0, 80)})`));
    }
    // The agent run's own hash, so a row in the table can be matched by eye to the transcript it
    // names (`# Agent run · model · <hash>`). Saved with the cell rather than derived at report
    // time, because a cached cell has no session to ask.
    const saved = { key, combo: cell.combo, taskId: t.id, repeat: cell.repeat, measurement,
        hash: run.session?.hash ?? null,
        // What the model was SHOWN (system prompt and tool schemas): part of the task's item on the scoreboard, saved
        // with the cell so a cached one keeps it.
        shown: shownFingerprint(run.session),
        // WHICH MODEL produced this. A sweep can vary the model as a dimension, and even when it does
        // not, "which model was this run against" is the first question asked of any result and was
        // previously answerable only by reading a run.md. Saved with the cell so a cached one keeps it.
        backend: run.backendLabel ?? null, models: run.models ?? null,
        ...(turns ? { turns, prompt: promptChars(dir), statuses, ...(followUps.length ? { followUps } : {}), ...(expects ? { expects } : {}) } : {}) };
    await writeFile(cacheFile, JSON.stringify(saved, null, 2));
    // Into the scores log, once, as it lands (scores.mjs): a sweep that dies half way still leaves its runs counted.
    const row = ctx.scores && runRow({ ...saved, fromCache: false }, t, ctx.scoreSweep);
    if (row) {
        ctx.logged += logRuns(ctx.scores, [row]);
        // What each model call spent, raw, and the price snapshot bodies they name that the log lacks (spend.mjs).
        logCalls(ctx.scores, callsOf(run.session, { driver: run.models?.driver ?? null, seedThrough: run.seedBoundaryStep ?? -1 }));
        for (const [hash, { kind, b64 }] of Object.entries(run.priceBodies ?? {})) {
            if (logSnapshot(ctx.scores, { hash, kind, body: Buffer.from(b64, "base64") }) === null) ctx.log(`  (price snapshot ${hash.slice(0, 12)} did not match its hash; not kept)`);
        }
    }
    ctx.ran++;
    ctx.report?.(index, "done", { ...saved, dir, fromCache: false, held: entry || null });
    if (entry) ctx.log(`  ⏸ ${label} is held open: ${entry.attach}`);
    ctx.log(`  ${measurement.ok ? "✔" : "✖"} ${label} — ${measurement.steps} steps, ${(measurement.runMs / 1000).toFixed(1)}s${measurement.succeeded === null ? "" : measurement.succeeded ? ", correct" : ", WRONG"}${expects ? `, ${expects.passed}/${expects.total} as expected` : ""}${followUps.length ? `, ${followUps.length} follow-up${followUps.length === 1 ? "" : "s"}` : ""}${measurement.error ? ` — ${String(measurement.error).slice(0, 80)}` : ""}${measurement.stream?.asked && measurement.stream.turns && !measurement.stream.streamed ? " — asked to stream, but nothing streamed" : ""}`);
    return { ...saved, dir, fromCache: false };
}

/**
 * One row per (combination x task), over that cell's repeats. Used for the final report AND for each live
 * push, so the page and report.md are the same numbers by construction rather than by agreement.
 * `results` may be sparse while a sweep is in flight; a cell with nothing measured yet is skipped.
 */
function aggregateRows(cells, results) {
    const byCell = new Map();
    for (let i = 0; i < cells.length; i++) {
        const c = cells[i], r = results[i];
        if (!r?.measurement) continue;
        const k = `${JSON.stringify(c.combo)}|${c.task.id}`;
        if (!byCell.has(k)) byCell.set(k, { combo: c.combo, taskId: c.task.id, path: path.relative(ROOT, path.dirname(r.dir)), measurements: [] });
        byCell.get(k).measurements.push(r.measurement);
    }
    return [...byCell.values()].map((r) => ({
        ...r, agg: aggregate(r.measurements),
        firstError: r.measurements.find((m) => m.error)?.error || null,
    }));
}

/**
 * What a person's mark names a run by: the `model` value when the sweep has that dimension (so a mark carries over
 * to the same model in another variant of the build), else the whole combination.
 */
function whoOf(combo) {
    return combo.model != null ? String(combo.model) : comboLabel(combo);
}

/** Run `cells` with at most `jobs` in flight, preserving nothing about order beyond scheduling fairness. */
/** The driver a cell runs on. */
const driverModel = (cell, ctx) => cell.effects.backend?.model ?? ctx.backend?.model ?? FAKE_MODEL;

/**
 * Whether a cell may start under the memory budget: false once the sweep paused at it. At the limit, `pause` pauses the
 * sweep (no more cells; it exits PAUSED_EXIT once the running ones end); `stop-holding` waits for room, which a held run
 * released or an app closed gives back.
 */
async function memoryLets(cell, ctx) {
    if (ctx.paused) return false;
    if (!ctx.budget?.active) return true;
    let said = null;
    for (;;) {
        const a = ctx.budget.canStart(cell.task.id);
        if (a.ok) return true;
        if (ctx.budget.whenFull === "pause") { ctx.pause(a.why); return false; }
        if (a.why !== said) ctx.log(`  ⏸ ${cellPath(cell)} waits for memory: ${a.why}`);
        said = a.why;
        await new Promise((r) => setTimeout(r, 15_000));
        if (ctx.paused) return false;
    }
}

/**
 * Keep a finished held run open, or let it go: kept when wanted and the budget has room for one more cell after it; when
 * it has none, recorded as "would have held" (and with `pause`, the sweep pauses). Its browser's measured peak goes into
 * the scores log either way, for the next prediction. Returns the held entry, or null.
 */
async function keepOrRelease(held, { want, measurement, run, cell, label, dir, ctx }) {
    const failure = failureShape(measurement);
    let keep = want;
    if (keep && ctx.budget?.active) {
        const a = ctx.paused ? { ok: false, why: ctx.paused } : ctx.budget.canKeep(cell.task.id);
        if (!a.ok) {
            keep = false;
            ctx.wouldHold.push({ cell: label, task: cell.task.id, model: driverModel(cell, ctx), failure, dir: path.relative(ROOT, dir), why: a.why });
            ctx.log(`  ⊘ ${label}: not held (${a.why})`);
            if (ctx.budget.whenFull === "pause") ctx.pause(a.why);
        }
    }
    const peak = ctx.budget?.peakOf(held.pid);
    if (peak && ctx.scores && run.session?.hash) {
        try { logFootprint(ctx.scores, { run: run.session.hash, task: cell.task.id, model: driverModel(cell, ctx), peak, held: keep }); } catch { /* a prediction is the worse for it, nothing else */ }
    }
    const entry = await held.decide(keep);
    try {
        if (entry) update(held.pid, { kind: "held", cell: label, task: cell.task.id, model: driverModel(cell, ctx), failure, dir: entry.dir, attach: entry.attach, expiresAt: entry.expiresAt });
        else unregister(held.pid);
    } catch { /* the ledger drops a dead pid on its next read */ }
    return entry;
}

async function pool(cells, jobs, fn) {
    const out = new Array(cells.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, cells.length) }, async () => {
        while (next < cells.length) {
            const i = next++;
            out[i] = await fn(cells[i], i);
        }
    }));
    return out;
}

const main = async () => {
    const args = parseArgv(process.argv.slice(2));
    if (!args.specPath) {
        console.error("usage: node --import tsx tests/e2e/bench/run.mjs <spec.bench.ts> [--jobs N] [--only k=v] [--skip k=v] [--repeats N] [--dry] [--no-cache]");
        process.exit(2);
    }
    // An interview file is a spec too: one task over a `model` dimension. Every model is PROBED first, as panel.mjs
    // does, and one that cannot make a tool call is listed as skipped instead of read later as a model that ignored
    // the task.
    let spec, skipped = [];
    if (isInterviewFile(args.specPath)) {
        await loadInterviewFile(args.specPath);   // checked before any model is probed
        if (!args.models.length) throw new Error("an interview file needs --models a,b,c (or PANEL_MODELS)");
        let models = args.models;
        if (!args.dry) {
            const backend = await resolveBackendFromEnv();
            if (!backend) throw new Error("an interview needs a real backend (USE_ENV=1 with .env, or E2E_BACKEND)");
            console.log(`  probing ${models.length} model(s) for a tool call…`);
            const probed = await Promise.all(models.map(async (model) => ({ model, why: await probe(backend, model) })));
            skipped = probed.filter((p) => p.why);
            for (const p of skipped) console.log(`  ✗ ${p.model}: ${p.why}`);
            models = probed.filter((p) => !p.why).map((p) => p.model);
            if (!models.length) throw new Error("no model passed the tool-call probe");
        }
        args.models = models;
        spec = await loadSpec(args.specPath, { models, surface: args.surface, turnMinutes: args.turnMinutes });
        // One browser per model, as panel.mjs runs them, unless --jobs says otherwise.
        if (!args.jobsSet) args.lanes = true;
    } else {
        spec = await loadSpec(args.specPath, { models: args.models, surface: args.surface, turnMinutes: args.turnMinutes });
        if (!spec?.name || !spec?.tasks?.length) throw new Error(`${args.specPath} does not export a bench spec (default export with name + tasks)`);
    }

    const { fingerprint, dirty } = buildFingerprint();
    const cells = expandCells(spec, { only: parseSelector(args.only), skip: parseSelector(args.skip), repeats: args.repeats });
    if (!cells.length) throw new Error("no cells selected — check --only/--skip");
    const sweepDir = path.join(ARTROOT, slug(spec.name));
    // The rest of the sweep already on disk: what an earlier `--only`/`--models` ran of the same spec and build goes into
    // this report as if read from the cache, so the report is the whole sweep; what an earlier version ran is only listed.
    // An interview's other models are cells of the same spec over a longer model list.
    const disk = await cellsOnDisk(sweepDir);
    let whole = spec;
    if (isInterviewFile(args.specPath)) {
        const more = [...new Set(disk.map((d) => d.saved.combo?.model).filter((m) => typeof m === "string" && !args.models.includes(m)))];
        if (more.length) whole = await loadSpec(args.specPath, { models: [...args.models, ...more], surface: args.surface, turnMinutes: args.turnMinutes });
    }
    const { same: alsoSame, older } = sortOnDisk(disk, { base: expandCells(whole, { repeats: 1 }), selected: new Set(cells.map(cellPath)), fingerprint });

    const groups = buildGroups(cells);
    // With lanes, the most that can run at once: one per model, under --jobs when given (the page's "N jobs").
    if (args.lanes) {
        const models = new Set(cells.map((c) => c.effects.backend?.model ?? "")).size;
        args.jobs = args.jobsSet ? Math.min(args.jobs, models) : models;
    }
    console.log(`\n  ${spec.name}\n  ${cells.length} runs · ${groups.length} build${groups.length > 1 ? "s" : ""} · ${args.lanes ? `lanes ${args.jobs} (one per model, as the box has room)` : `jobs ${args.jobs}`}${dirty ? " · DIRTY TREE" : ""}${alsoSame.length ? ` · ${alsoSame.length} more already on disk` : ""}${older.length ? ` · ${older.length} on disk from an earlier version` : ""}\n`);
    if (args.dry) {
        for (const c of cells) console.log(`  ${comboLabel(c.combo)} · ${c.task.id} · r${c.repeat}  [${cellKey(c, fingerprint)}]`);
        if (alsoSame.length) console.log(`\n  and in the report, already on disk: ${alsoSame.map((s) => s.rel).join(", ")}`);
        console.log(`\n  (dry run — nothing executed)\n`);
        return;
    }

    // Build every variant up front: a build failure should stop the sweep before it spends an hour, not
    // half way through, and a shared build must not be raced by parallel jobs.
    const buildDirs = new Map();
    for (const g of groups) {
        const dir = await buildVariant(g, fingerprint, (s) => console.log(s));
        for (const c of g.cells) buildDirs.set(c, dir);
    }

    const backend = await resolveBackendFromEnv();
    // What the box did over the sweep, read as the resource panel reads it: its event stream when the server has one
    // (memory readings and its own loads, evictions and serving spans, every frame also kept in box.sqlite), else polled
    // memory. For the page's memory chart and memory.md; only against a real backend.
    const boxLog = backend ? await openBoxLog() : null;
    const resPoll = backend ? startBox(backend, { db: boxLog, log: (m) => console.log(m) }) : null;
    await mkdir(sweepDir, { recursive: true });
    // Which spec this sweep ran and who started it, appended to the sweep's log; the page's Spec card, spec.md and
    // page.json show it beside the diff against the sweep before (sweeps.mjs).
    const specRel = path.relative(ROOT, path.resolve(args.specPath));
    const provenance = specProvenance(await recordSweep(sweepDir, { specPath: specRel, onDisk: path.resolve(args.specPath), source: await readFile(args.specPath, "utf8"), fingerprint, dirty, by: defaultBy() }));

    // The scores log (scores.mjs): every run against a real model, one row each, for the scoreboard. Never the fake's.
    const scores = backend ? await openScores() : null;
    // What the server says about each model: digests for the scoreboard, and which are cloud, for their own shade on the page.
    const info = backend ? await modelInfo(backend) : new Map();
    const cloud = [...info].filter(([, v]) => v.local === false).map(([k]) => k);
    // The repository the build came from (origin's URL, as the extension's own build stamp reads it), so the page can
    // link the build to its commit and the spec to its file there. "" without a remote: no links.
    const repo = repoUrl() || null;
    // The regression suite says up front how small a shift it could see with this model list and repeat count, so a run
    // too small to tell anything is known before it is paid for.
    if (spec.suite === "regression" && scores) {
        const power = plannedPower(readRuns(scores), { models: args.models, repeats: args.repeats ?? spec.repeats ?? 1, modelKey, fitRasch });
        if (power.length) console.log(`  regression suite: the smallest shift each task would show 80% of the time, in log-odds (from earlier regression runs):\n${power.map((p) => `    ${p.task.split("#")[0].padEnd(20)} ${p.detectable == null ? "unknown" : p.detectable.toFixed(1)}`).join("\n")}\n`);
        else console.log("  regression suite: no earlier regression run, so this one is the baseline; the next build is compared with it.\n");
    }
    // The memory budget (memory-budget.mjs), shared with every bench process on this machine through its ledger. It says
    // no only to a sweep that can hold runs or runs a real model; a fake-model sweep is measured and never stopped.
    if (scores) openFootprints(scores);
    // The command that goes on from here: this one, less `--no-cache`, so the cells already done come from the cache.
    const resume = inDir(process.cwd(), shellLine(["node", ...process.execArgv, path.relative(process.cwd(), process.argv[1]), ...process.argv.slice(2).filter((a) => a !== "--no-cache")]));
    const holding = cells.some((c) => holdMode(c, args.hold));
    // A limit set by hand is the person's call on swap: it drops the free-memory reserve as well.
    // The limit: this sweep's --memory-limit, else the machine-wide one (hold.mjs --limit, or the page), re-read on every
    // measurement so a person can change it while the sweep runs, else half the RAM.
    const budget = startBudget({ limit: args.memoryLimit ?? null, whenFull: args.whenFull, db: scores, active: !!backend || holding, sweep: spec.name, repo: ROOT, cmd: resume,
        onLimit: (now, was) => console.log(`  ⇄ memory limit ${fmtBytes(was.bytes)} → ${fmtBytes(now.bytes)} (${limitWhence(now)})${now.bytes < was.bytes ? "; nothing running is stopped, but nothing more starts or is held past it" : ""}`) });
    if (budget.active) {
        const expect = budget.expect([...new Set(cells.map((c) => c.task.id))], args.jobs);
        if (holding) console.log(`  memory: ${expect.text}\n`);
        const st = budget.state();
        const small = tooSmall({ room: st.room, per: expect.per.bytes, bench: st.byKind.runner ?? 0, limit: st.limit, reserve: st.reserve, jobs: args.jobs, held: holding ? 3 : 0, limitGiven: budget.limit().handSet });
        if (small?.level === "error") {
            console.log(`  ✖ ${small.text}\n\nBENCH NOT STARTED ${spec.name} paused=memory-budget`);
            budget.stop();
            process.exit(PAUSED_EXIT);
        }
        if (small) console.log(`  ⚠ ${small.text}\n`);
    }
    const scoreSweep = { name: spec.name, spec: specRel, specHash: provenance?.specHash ?? null, fingerprint, dirty, backend, info, by: defaultBy(), suite: spec.suite ?? null };
    const ctx = {
        spec, fingerprint, sweepDir, backend, buildDirs, cache: args.cache, scores, scoreSweep, logged: 0,
        // Warming is a VRAM concern for a local model, and pointless against a hosted API or the fake.
        warm: !!backend && process.env.WARM !== "0",
        cached: 0, ran: 0, retried: 0, pdf: args.pdf, kept: [],
        // What a held cell's own process needs to find the same cell in the same spec (hold.mjs), and the runs kept open.
        holdCli: args.hold,
        held: { job: { specPath: path.resolve(args.specPath), load: { models: args.models, surface: args.surface, turnMinutes: args.turnMinutes }, select: { only: parseSelector(args.only), skip: parseSelector(args.skip), repeats: args.repeats } },
            idleMin: args.holdIdle, runs: [],
            // Headless, as every bench browser is. A real window only when asked (`--hold-window`): each one is opened, takes
            // the screen and is minimised after, and with `--hold failures` that is every cell of the sweep.
            window: heldWindow(!!args.holdWindow) },
        // CLI beats the spec: a sweep you are debugging wants `--capture always` without editing the file.
        capture: args.capture || spec.capture || "failure",
        log: (s) => console.log(s),
        budget, paused: null, wouldHold: [],
        pause(why) { if (!this.paused) { this.paused = why; console.log(`  ⏸ PAUSED at the memory budget (${why}): no new cell starts and nothing more is held; the sweep ends once the running cells do`); } },
    };
    // The live page, when asked for. Every cell is seeded as QUEUED so the whole matrix is visible from the
    // start — what is running, what is next, and what is left is the question a long sweep actually raises.
    // The cells this invocation runs come first; the rest of the sweep already on disk (above) after them, never run.
    const nRun = cells.length;
    for (const { cell } of alsoSame) cells.push(cell);
    const runsState = cells.map((c) => ({ combo: c.combo, taskId: c.task.id, repeat: c.repeat, state: "pending", who: whoOf(c.combo) }));
    const results = new Array(cells.length);
    // A person's marks on interview answers, kept beside the sweep so the next run of it checks them.
    // marks.jsonl is the ONE store, an append-only log written by the page's button and by mark.mjs alike (both through
    // `addMark`, each record saying who made it), re-read whenever it changes, so a mark made from the command line
    // mid-sweep shows up on the page and neither side can overwrite the other's.
    const marksFile = path.join(sweepDir, "marks.jsonl");
    let marks = [];
    const loadMarks = async () => { marks = await readMarks(sweepDir); };
    await loadMarks();
    const recheck = (r) => { if (r.turns) r.checks = checkMarks(r, marks); };
    const onMark = async (body) => {
        if (!validMark(body)) return null;
        // The page has no login, so a mark from it is by the person at the page, which is what it says.
        const mark = await addMark(sweepDir, body, "person (page)");
        await loadMarks();
        runsState.forEach(recheck);
        push();
        return mark;
    };
    let marksTimer = null;
    const marksWatch = (() => {
        try {
            return watchFs(sweepDir, (_, f) => {
                if (f !== "marks.jsonl" && f !== "marks.json") return;
                clearTimeout(marksTimer);
                marksTimer = setTimeout(async () => { await loadMarks(); runsState.forEach(recheck); push(); }, 100);
            });
        } catch { return null; }
    })();
    // Watching the page's own sources makes the page editable while it is open: a person or an agent changes a file
    // under bench/page/ (or the lane's shared modules) and every open browser reloads onto the new build.
    const dash = args.serve ? await startDashboard({ artifactRoot: sweepDir, onMark, watch: pageSources(), ...(scores ? { scores: async () => scoreboard(readRuns(scores)) } : {}), ...(args.port != null ? { port: args.port } : {}) }) : null;
    // Each driver model's line on the scoreboard, for the badge in its pill; refreshed as runs are logged.
    const drivers = () => runsState.map((r) => r.models?.driver).concat(cells.map((c) => c.effects.backend?.model ?? backend?.model));
    const scoreLines = (href) => (scores ? sweepScores(scoreboard(readRuns(scores)), drivers(), info, href) : null);
    let liveScores = dash ? scoreLines("/scores") : null;
    const started = Date.now();
    // The question each turn of each interview asked, for the answers view's row headings.
    const interviews = Object.fromEntries(spec.tasks.filter(isInterviewTask).map((t) => [t.id, [t.task, ...(t.asks ?? []).map(askText)]]));

    // The sweep timeline (page/timeline.tsx): every run on one clock, each its own event lane, so a sweep shows where the
    // time went and which runs overlapped. A finished cell's events come from its final session; a running one's from
    // its live event stream, rebuilt at most every 2 s (a session rebuild per event, per running cell, would be most of
    // the CPU). Cached cells have none: their times belong to an earlier sweep and would stretch the axis across it.
    const raw = cells.map(() => []);
    const laneEvents = cells.map(() => null);
    let ganttAt = 0, gantt = null;
    ctx.rawOf = (i) => raw[i];
    // A seeded cell against a real model runs its first turn on the fake LLM: named as the spec's script, not as a model.
    const seededOf = (c) => !!c.task.seed && !!(c.effects.backend || backend);
    const lane = (i, events, rawEvents) => (seededOf(cells[i])
        ? labelSeed(events, FAKE_MODEL, { seedEnd: seedEndOf(rawEvents), measured: cells[i].effects.backend?.model ?? backend?.model ?? null })
        : events);
    const scripted = cells.some(seededOf) ? [SEED_LABEL] : [];
    ctx.finalSession = (i, session, rawEvents) => { laneEvents[i] = session ? lane(i, eventsFrom([session]), rawEvents) : []; raw[i] = []; ganttAt = 0; };
    const sweepTimeline = () => {
        if (Date.now() - ganttAt < 2000 && gantt) return gantt;
        ganttAt = Date.now();
        const now = Date.now();
        const evs = cells.map((c, i) => {
            if (runsState[i].cached) return null;
            if (laneEvents[i]) return laneEvents[i];
            if (runsState[i].state !== "running" || !raw[i].length) return null;
            try { const { session } = renderRun(raw[i]); return session ? lane(i, eventsFrom([session], now), raw[i]) : null; } catch { return null; }
        });
        const runs = evs.flatMap((events, index) => (events?.length ? [{ index, events }] : []));
        gantt = runs.length ? { runs, now } : null;
        return gantt;
    };
    // The page's state, and the same object as status.md/status.json for a model reading the sweep from the CLI (status.mjs).
    // The state is built only for a reader: the page on each change, the status files at most every 2 s.
    const push = () => { if (dash) dash.update(liveState()); status.update(liveState); };
    const liveState = () => ({
        name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
        runs: runsState, rows: aggregateRows(cells, results), older,
        started, finished: null, jobs: args.jobs, dirty, interviews, skipped, spec: provenance, timeline: sweepTimeline(), scores: liveScores, cloud, scripted, repo,
        resources: resPoll?.resources() ?? null, spend: spent?.summary(driverOf) ?? null, memory: memoryView(),
    });
    const status = statusWriter(sweepDir);
    console.log(`  status (for a model reading this from the CLI): ${path.relative(ROOT, sweepDir)}/status.md and status.json, rewritten every few seconds\n`);
    ctx.liveOf = (i) => runsState[i].live;
    // What the bench holds in memory, for the page: the budget, what each kind of process uses, the held runs grouped
    // with their commands, and what the budget turned away (hold-menu.mjs).
    const memoryView = () => {
        const st = budget.state();
        const entries = budget.entries();
        return { ...st, active: budget.active, whenFull: budget.whenFull, paused: ctx.paused, resume, hints: HOLD_HINTS,
            runner: entries.find((e) => e.pid === process.pid) ?? null,
            groups: groupHeld(entries).map((g) => ({ key: g.key, count: g.runs.length, rss: g.rss, sweeps: [...new Set(g.runs.map((r) => r.sweep))], commands: groupCommands(g) })),
            wouldHold: ctx.wouldHold, history: budget.history() };
    };
    // What this invocation's runs have spent so far, priced as their calls come in (live-spend.mjs): a snapshot body
    // the scores log lacks is fetched from the price service by its hash and kept there. Only against a real backend.
    const driverOf = (i) => cells[i].effects.backend?.model ?? backend?.model ?? null;
    const snapshotBody = scores?.prepare("SELECT body FROM snapshots WHERE hash = ?");
    const spent = backend ? liveSpend({
        bodyOf: (h) => snapshotBody?.get(h)?.body ?? null,
        fetchBody: backend.priceSnapshotUrl ? fetchFromPriceService(backend.priceSnapshotUrl) : null,
        keep: (snap) => scores && logSnapshot(scores, snap),
        changed: () => push(),
    }) : null;
    // A seeded cell's first turn runs on the fake LLM (run-once): its calls are nobody's spend, up to its first answer.
    const inSeed = cells.map((c) => !!c.task.seed);
    ctx.spendOn = (i, ev) => {
        if (inSeed[i]) { if (ev.kind === "agent-result") inSeed[i] = false; return false; }
        return spent?.add(i, ev, driverOf(i)) ?? false;
    };
    ctx.report = (i, state, info) => {
        const r = runsState[i];
        if (state === "running" && r.state !== "running") r.startedAt = Date.now();   // for the elapsed ticker
        r.state = state;
        if (info?.path && state === "running") r.path = info.path;
        if (info?.live) { r.live = info.live; return push(); }
        if (info?.turns && state === "running") { r.turns = info.turns; recheck(r); return push(); }
        if (state === "done" && info) {
            const m = info.measurement;
            Object.assign(r, {
                ok: m.ok, succeeded: m.succeeded, steps: m.steps, secs: m.runMs / 1000,
                ...(!m.ok && isRateLimit(m.error) ? { rateLimited: true } : {}),
                cached: info.fromCache, path: path.relative(sweepDir, info.dir), live: undefined,
                hash: info.hash ?? null, backend: info.backend ?? null, models: info.models ?? null,
                stream: m.stream ?? null,
                ...(info.held ? { held: info.held.attach } : {}),
                ...(info.turns ? { turns: info.turns, statuses: info.statuses ?? [], ...(info.followUps ? { followUps: info.followUps } : {}), ...(info.expects ? { expects: info.expects } : {}) } : {}),
            });
            recheck(r);
            results[i] = info;
            if (dash && scores && !info.fromCache) liveScores = scoreLines("/scores");
        }
        push();
    };
    if (dash) {
        // A banner, not a log line: this URL is the whole point of --serve, and it must survive being
        // skimmed in a terminal that is about to fill with progress output.
        const bar = "─".repeat(dash.url.length + 6);
        console.log(`\n  ┌${bar}┐\n  │   ${dash.url}   │\n  └${bar}┘\n  watch it live ↑  (${cells.length} runs)\n`);
        if (args.open) {
            const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            try { spawn(cmd, [dash.url], { detached: true, stdio: "ignore" }).unref(); }
            catch { /* no opener here — the URL is printed above */ }
        }
    }
    alsoSame.forEach(({ rel, saved }, k) => {
        runsState[nRun + k].onDisk = true;
        ctx.report(nRun + k, "done", { ...saved, dir: path.join(sweepDir, rel), fromCache: true });
    });
    push();
    // A run held open mid-sweep can be talked to before the sweep ends: its added turns go on the page as they come.
    const unfollow = dash ? followContinued(sweepDir, () => runsState, push) : () => {};

    // Per-model LANES (lanes.mjs): each model's cells in turn, different models at once when the box says the next one
    // fits beside what is loaded. Without a real backend every cell is the fake's, so it is one lane.
    if (args.lanes) {
        const gate = backend ? fitsGate(backend, info) : async () => ({ go: true, local: false, why: "the fake model" });
        await runLanes(cells.slice(0, nRun), {
            modelOf: (c) => c.effects.backend?.model ?? backend?.model ?? "",
            gate, settle: backend ? settleUntilResident(gate) : async () => {},
            fn: (cell, i) => runCell(cell, ctx, i),
            maxLanes: args.jobsSet ? args.jobs : Infinity, log: (s) => console.log(s),
        });
    } else await pool(cells.slice(0, nRun), args.jobs, (cell, i) => runCell(cell, ctx, i));
    const finished = Date.now();
    unfollow();
    resPoll?.stop();
    if (pdfBrowser) await (await pdfBrowser).close().catch(() => {});

    const rows = aggregateRows(cells, results);
    // Every individual run, with where it landed — the aggregate table says WHICH cell is interesting,
    // this says which of its repeats to open.
    const runs = cells.map((c, i) => ({
        combo: c.combo, taskId: c.task.id, repeat: c.repeat,
        // `state` is what the saved page reads to know a run FINISHED; without it report.html renders a
        // completed sweep as 0% done. A cell with no measurement never ran (the sweep was interrupted),
        // and saying so is more honest than calling it a failure.
        state: results[i] ? "done" : "pending",
        ok: results[i]?.measurement?.ok ?? false, succeeded: results[i]?.measurement?.succeeded ?? null,
        ...(results[i]?.measurement && !results[i].measurement.ok && isRateLimit(results[i].measurement.error) ? { rateLimited: true } : {}),
        steps: results[i]?.measurement?.steps ?? 0, cached: !!results[i]?.fromCache,
        secs: results[i]?.measurement ? results[i].measurement.runMs / 1000 : null,
        // Relative to the SWEEP directory: report.html sits there, and the terminal/markdown reports
        // print repo-relative paths separately below.
        hash: results[i]?.hash ?? null, backend: results[i]?.backend ?? null,
        models: results[i]?.models ?? null,
        path: results[i] ? path.relative(sweepDir, results[i].dir) : "",
        repoPath: results[i] ? path.relative(ROOT, results[i].dir) : "",
        who: runsState[i].who,
        // Not selected this time: an earlier invocation of the same spec and build ran it.
        ...(runsState[i].onDisk ? { onDisk: true } : {}),
        ...(runsState[i].held ? { held: runsState[i].held } : {}),
        ...(runsState[i].continued?.length ? { continued: runsState[i].continued } : {}),
        ...(runsState[i].turns ? { turns: runsState[i].turns, checks: runsState[i].checks ?? [], ...(runsState[i].followUps ? { followUps: runsState[i].followUps } : {}), ...(runsState[i].expects ? { expects: runsState[i].expects } : {}) } : {}),
    }));

    const sweep = { spec, rows, runs, older, onDisk: alsoSame.length, fingerprint, dirty, started, finished, sweepDir: path.relative(ROOT, sweepDir), cached: ctx.cached, ran: ctx.ran, jobs: args.jobs, pdf: args.pdf };
    writeReport(sweep, terminalSink());
    const md = writeReport(sweep, mdSink());
    const reportPath = path.join(sweepDir, "report.md");
    await writeFile(reportPath, md);
    // What the sweep wrote, for the terminal: a model driving the bench reads these rather than the page.
    const files = [["report", "report.md", "the results table, per cell"]];
    // An interview's answers as panel.mjs writes them, so a model reading the sweep reads the same file either way.
    for (const t of spec.tasks.filter(isInterviewTask)) {
        const res = runs.flatMap((r, i) => r.taskId === t.id && results[i] ? [{
            model: spec.dimensions?.model && Object.keys(spec.dimensions).length === 1 ? r.combo.model : `${comboLabel(r.combo)}${r.repeat ? ` r${r.repeat}` : ""}`,
            turns: r.turns ?? [], statuses: results[i].statuses ?? [], prompt: results[i].prompt ?? "?", expected: (t.asks?.length ?? 0) + 1,
            followUps: r.followUps ?? [],
            checks: r.checks ?? [],
        }] : []);
        const iv = { task: t.task, asks: (t.asks ?? []).map(askText), about: spec.description };
        const file = spec.tasks.length === 1 ? "summary.md" : `summary-${slug(t.id)}.md`;
        await writeFile(path.join(sweepDir, file), panelSummary(t.id, iv, res, skipped, t.surface));
        files.push([`answers${spec.tasks.length === 1 ? "" : ` (${t.id})`}`, file, "each turn's answers side by side, and the checks of lines marked wrong (add one: bench/mark.mjs)"]);
    }
    // EVERYTHING THE PAGE SHOWS IS ALSO A FILE, from the same object: report.html bakes `pageState` in, page.json is
    // it verbatim, and timeline.md is its timeline as text, so a model reading the sweep from a terminal and a person
    // reading the page see the same thing and cannot drift apart.
    // The scoreboard as of this sweep, beside the log: scores.md, scores.json, scores.html (the saved page's badges link there).
    if (scores) await writeScoreFiles(scores);
    const pageState = {
        name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
        runs, rows, older, started, finished, jobs: args.jobs, dirty, fingerprint, pdf: args.pdf, interviews, skipped, spec: provenance,
        scores: scoreLines("../scores.html"), cloud, scripted, repo,
        resources: resPoll?.resources() ?? null, spend: spent?.summary(driverOf) ?? null, memory: memoryView(),
        // What may leave this machine for the bench store (sync.mjs): nothing when the spec says `sync: false`, and no
        // run of a task that says so.
        ...(spec.sync === false || spec.tasks.some((t) => t.sync === false)
            ? { sync: { off: spec.sync === false, tasksOff: spec.tasks.filter((t) => t.sync === false).map((t) => t.id) } } : {}),
        timeline: (ganttAt = 0, sweepTimeline()),
    };
    // report.html — the live page with the final state baked in. Written ALWAYS, not only with --serve:
    // the page is already an index of the runs, so archiving it is what makes the sweep directory
    // navigable on its own. Links are relative, so it works from disk with no server.
    await writeFile(path.join(sweepDir, "report.html"), await staticPage(pageState));
    await writeFile(path.join(sweepDir, "page.json"), JSON.stringify(pageState, null, 2));
    status.flush(pageState);
    const nameOf = (i) => [runs[i].taskId, ...Object.keys(spec.dimensions || {}).map((d) => runs[i].combo[d]), `r${runs[i].repeat}`].join(" · ");
    await writeFile(path.join(sweepDir, "timeline.md"), timelineText(pageState.timeline, nameOf, { cached: runs.filter((r) => r.cached).length }));
    await writeFile(path.join(sweepDir, "spec.md"), specText(provenance));
    await writeFile(path.join(sweepDir, "memory.md"), memoryText(pageState.resources, new Set(runsState.filter((r) => r.hash && !r.cached && !r.onDisk).map((r) => `wml-${r.hash}`))));
    await writeFile(path.join(sweepDir, "rows.json"), JSON.stringify({ fingerprint, dirty, started, finished, rows, runs, older }, null, 2));
    files.push(
        ["timeline", "timeline.md", "every run on one clock: spans, overlaps, model loads"],
        ["memory", "memory.md", "the box's memory during the sweep: each pool's peak and mean, each model's stretch in memory"],
        ["spec", "spec.md", "which spec version ran, who started the sweep, the diff against the sweep before (log: sweeps.jsonl)"],
        ["status", "status.md", "spend, the memory budget with its readings over the sweep, held runs and their commands, a pause (status.json: the same as JSON)"],
        ["page data", "page.json", "everything the page shows, as JSON"],
        ["page", "report.html", "the same, for a person (opens from disk)"],
    );
    if (existsSync(marksFile)) files.push(["marks", "marks.jsonl", "lines marked wrong, who marked each and when (append-only); later runs are checked for them"]);
    console.log(`\n  ${path.relative(ROOT, sweepDir)}/`);
    for (const [what, f, why] of files) console.log(`    ${f.padEnd(22)} ${what}: ${why}`);
    // The scoreboard counts only tasks that say what a right answer is, so say which did not.
    if (scores) {
        const none = unscoredTasks(spec);
        console.log(`\n  ${path.relative(ROOT, SCORES_DB)}: ${ctx.logged} run${ctx.logged === 1 ? "" : "s"} logged; the scoreboard is scores.md / scores.html beside it (node tests/e2e/bench/scores.mjs).`);
        if (none.length) console.log(`  ${none.length} of ${spec.tasks.length} task${spec.tasks.length === 1 ? "" : "s"} had no \`succeeded\` predicate, so their runs count for tokens but not for any model's score: ${none.join(", ")}`);
    } else if (backend) console.log("\n  (runs not logged for the scoreboard: this Node has no node:sqlite)");
    if (pageState.spend) console.log(`  spend: ${spendLine(pageState.spend)}`);
    if (resPoll) console.log(`  box: ${resPoll.mode === "stream" ? `its event stream, every frame kept in ${path.relative(ROOT, BOX_DB)}` : "polled memory (the server has no event stream)"}; memory.md says what it did.`);
    console.log("");
    // A live watcher holds the process open: without a page to keep current, stop watching marks.jsonl now.
    const unwatchMarks = () => { clearTimeout(marksTimer); marksWatch?.close(); };
    if (!dash) unwatchMarks();

    let page = null;
    if (dash) {
        dash.update({
            name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
            runs: runsState, rows, older, started, finished, jobs: args.jobs, dirty, interviews, skipped, spec: provenance, timeline: sweepTimeline(), scores: scoreLines("/scores"), cloud, scripted, repo,
            resources: pageState.resources, spend: pageState.spend, memory: pageState.memory,
        });
        // The page outlives the sweep, the sweep's PROCESS does not: a caller that started it in the background (an
        // agent's background task, a `&` and a wait) learns it finished by its exit, which a held-open server never gave.
        // The page goes to a detached server on the same port (serve.mjs `serveSweep`), which serves the final state from
        // page.json; the open tab's event stream reconnects to it, so the person watching sees no change.
        const port = Number(new URL(dash.url).port);
        await dash.stop();
        unwatchMarks();
        page = await handOffPage(sweepDir, port);
    }
    // ONE line a poller can look for, last, and the same as done.json in the sweep directory.
    // About what THIS invocation did: a run already on disk is in the report, not in the exit status.
    const done = doneSummary(spec.name, runs.filter((r) => !r.onDisk), { report: path.relative(ROOT, reportPath), page, retried: ctx.retried,
        held: ctx.held.runs.map(({ pid, cell, dir, attach, expiresAt }) => ({ pid, cell, dir, attach, expiresAt })), kept: ctx.kept });
    if (ctx.paused) Object.assign(done, { paused: ctx.paused, exit: PAUSED_EXIT, resume });
    if (ctx.wouldHold.length) done.wouldHold = ctx.wouldHold;
    await writeFile(path.join(sweepDir, "done.json"), JSON.stringify(done, null, 2));
    // Into the bench store, when one is configured (sync.mjs; off by default). Never the sweep's failure: what did not
    // go now goes on the next push.
    const storeCfg = args.sync === false ? null : storeFromEnv();
    if (storeCfg) {
        try { await pushToStore(openStore(storeCfg), { sweeps: [sweepDir], onlyDb: !!args.onlyDb, log: console.log }); }
        catch (e) { console.log(`  (store push failed: ${String(e?.message || e).slice(0, 160)}; \`node --import tsx tests/e2e/bench/sync.mjs push\` retries)`); }
    }
    if (page) console.log(`  the page stays up at ${page}; stop it with: node --import tsx tests/e2e/bench/serve.mjs --stop`);
    if (ctx.kept.length) console.log(`  ${ctx.kept.length} earlier run${ctx.kept.length === 1 ? "" : "s"} of re-run cells kept in ${path.relative(ROOT, path.join(sweepDir, "history"))}/ (the run each replaced, with its cell.json)`);
    // What the bench holds open on this machine now (every clone's), grouped, with what to paste for each.
    if (done.held.length) console.log(`  ${done.held.length} run${done.held.length === 1 ? "" : "s"} of this sweep held open (each until /end, ${ctx.held.idleMin ?? HOLD_IDLE_MIN} idle minutes, or released below).`);
    const menu = menuText(budget.refresh() && budget.entries(), { resume: ctx.paused ? resume : null, wouldHold: ctx.wouldHold, paused: ctx.paused });
    if (menu.length) console.log(menu.join("\n"));
    budget.stop();
    console.log(doneLine(done));
    // Exit, rather than wait for every handle to close: everything is written, and the exit IS the signal.
    process.exit(done.exit);
};

/**
 * Start the detached server for a finished sweep's page (serve.mjs, as its own process, so this one can exit) and wait
 * until it says it is listening (SERVER_FILE). Resolves its URL, or null when it did not come up.
 */
async function handOffPage(sweepDir, port) {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("./serve.mjs", import.meta.url)), sweepDir, "--port", String(port)],
        { cwd: ROOT, detached: true, stdio: "ignore" });
    child.unref();
    for (const until = Date.now() + 20_000; Date.now() < until;) {
        const s = servedSweep();
        if (s?.pid === child.pid) {
            // In the ledger with the bench's other processes: a page server lives on after its sweep.
            try { register({ kind: "page", pid: child.pid, sweep: path.basename(sweepDir), repo: ROOT }); } catch { /* not counted, nothing worse */ }
            return s.url;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    console.log("  (the page server did not come up; report.html in the sweep directory is the same page, from disk)");
    return null;
}

main().catch((e) => { console.error(e); process.exit(1); });
