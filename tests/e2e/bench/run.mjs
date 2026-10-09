// run.mjs — walk a bench spec's matrix and report it.
//
//   node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/pointer-ids.bench.ts
//   … --jobs 4            run 4 browsers at once (a hosted API; NOT a local GPU — see below)
//   … --only idFormat=label --only task=two-tables      re-measure a subset
//   … --repeats 2 --dry   print the matrix and stop
//   … --no-cache          re-run cells that are already measured
//   … --pdf               also render each run to run.html + run.pdf (slower, and much larger)
//   … --capture always    snapshot the browser (screenshot + DOM, every open page) on EVERY run, not
//                         just the failures — the default is `failure`, and `never` turns it off
//   … --serve             serve a live page: every run's state, what is queued, the table filling in
//   … --serve --open      …and open it in a browser
//   … tests/e2e/panel/bloat.json --models a,b,c    an INTERVIEW file instead of a spec: one run per model, each
//                         follow-up sent as the turn before it ends, the answers side by side on the page (where a
//                         person can mark one wrong) and in summary.md; `--surface hud|console` as panel.mjs takes it
//   … --port 7400         serve on a specific port (the default is stable, so a browser tab can just
//                         reload between sweeps — in VS Code, cmd-click the URL and pick "Simple
//                         Browser" to dock the page as an editor tab)
//
// The division of labour this is built for: an agent defines the benchmark in code, runs it, and reads the
// terminal; a human watching over its shoulder opens the page. Same data, two audiences — which is why
// `--serve` prints the URL as a banner rather than a log line, so the assistant can hand it over.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOnce, resolveBackendFromEnv, renderRun } from "../run-once.mjs";
import { measureRun, aggregate } from "./metrics.mjs";
import { expandCells, cellKey, cellPath, comboLabel, buildGroups, parseSelector, slug } from "./cells.mjs";
import { writeReport, mdSink, terminalSink } from "./sinks.mjs";
import { startDashboard, staticPage } from "./serve.mjs";
import { pageSources } from "./page/bundle.mjs";
import { addMark, readMarks, defaultBy } from "./mark.mjs";
import { recordSweep, specProvenance, specText } from "./sweeps.mjs";
import { timelineText } from "./timeline-text.mjs";
import { memoryText } from "./resource-poll.mjs";
import { startBox, openBoxLog, BOX_DB } from "./box-stream.mjs";
import { repoUrl } from "../../../scripts/gen-build-info.mjs";
import { openScores, modelInfo, runRow, logRuns, readRuns, scoreboard, sweepScores, writeScoreFiles, unscoredTasks, SCORES_DB } from "./scores.mjs";
import { watch as watchFs } from "node:fs";
// The sweep's timeline: each run's events as the resource panel derives them; the page draws them with its lane.
const { eventsFrom } = await import("../../../src/sidebar/resource/model-stats.ts");
import { loadInterview, interviewBench, interviewDriver, readTurns, probe, panelSummary, promptChars, checkMarks, validMark } from "../interview.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ARTROOT = path.join(ROOT, "tests/e2e/artifacts/bench");
const BUILDROOT = path.join(ROOT, "tests/e2e/artifacts/builds");

function parseArgv(argv) {
    const args = { specPath: null, models: (process.env.PANEL_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean), surface: undefined, turnMinutes: 15, jobs: 1, only: [], skip: [], repeats: undefined, dry: false, cache: true, pdf: false, serve: false, open: false, port: undefined, capture: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--jobs") args.jobs = Math.max(1, Number(argv[++i]) || 1);
        else if (a === "--only") args.only.push(argv[++i]);
        else if (a === "--skip") args.skip.push(argv[++i]);
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

    if (ctx.cache && existsSync(cacheFile)) {
        try {
            const saved = JSON.parse(await readFile(cacheFile, "utf8"));
            if (saved.key === key) {
                ctx.cached++;
                const hit = { ...saved, dir, fromCache: true };
                ctx.report?.(index, "done", hit);
                return hit;
            }
        } catch { /* unreadable cache → re-run */ }
    }
    // Where its artifacts land is known now, so the page can open a run WHILE it runs: they are rewritten on every
    // event, and the open viewer reloads as the run moves.
    ctx.report?.(index, "running", { path: path.relative(ctx.sweepDir, dir) });
    await rm(dir, { recursive: true, force: true });   // a re-run must not read a stale run.md as its own
    await mkdir(dir, { recursive: true });

    const t = cell.task;
    const e = cell.effects;
    const backend = e.backend ? { ...(ctx.backend || {}), ...e.backend } : ctx.backend;
    const label = `${comboLabel(cell.combo)} · ${t.id} · r${cell.repeat}`;
    ctx.log(`  ▶ ${label}`);

    const surface = e.surface !== undefined ? e.surface : (t.surface ?? null);
    // An interview: each ask is sent once the turn before it ends, and every turn's answer lands in outbox/, read
    // back as the run goes so the page fills in turn by turn rather than at the end.
    const driver = t.asks?.length ? interviewDriver({ asks: t.asks, dir }) : null;
    const nextTurn = driver && (async (info) => {
        const next = await driver.nextTurn(info);
        ctx.report?.(index, "running", { turns: readTurns(dir) });
        return next;
    });
    let run;
    try {
        run = await runOnce({
            task: t.task,
            followup: t.followup || "",
            start: t.start || "/step3",
            tools: e.tools !== undefined ? e.tools : (t.tools ?? null),
            python: e.python ?? !!t.python,
            toolTokens: e.toolTokens ?? !!t.toolTokens,
            agentOptions: { ...(t.agentOptions || {}), ...(e.agentOptions || {}) },
            seed: t.seed || null,
            ...(t.script ? { script: t.script } : {}),
            surface,
            sharedWatches: t.sharedWatches ?? [], watchNotes: t.watchNotes ?? {},
            ...(nextTurn ? { nextTurn } : {}),
            backend,
            dist: ctx.buildDirs.get(cell) ?? null,
            artDir: dir,
            approve: ctx.spec.approve || "auto",
            capture: ctx.capture,
            timeoutMs: t.timeoutMs ?? ctx.spec.timeoutMs ?? 180000,
            // A sweep is a machine reading a matrix: no sidebar to focus, no browser to hold open, and the
            // per-event chatter would bury the progress line.
            focusSidebar: false,
            hold: false,
            warm: ctx.warm,
            log: () => {},
            // The in-flight run's own debug stream, reduced to what a watcher wants: how far in it is,
            // against what budget, what it is doing right now, and the last thing that actually happened.
            // A sweep cell takes minutes; without this a running row is a spinner, and a slow step is
            // indistinguishable from a wedged one.
            onEvent: (ev) => {
                ctx.rawOf?.(index)?.push(ev);
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
                } else return;
                ctx.report?.(index, "running", { live });
            },
        });
    } catch (err) {
        run = { events: [], result: null, error: String(err), runMs: 0, approvals: [], seedBoundaryStep: -1 };
    }

    const measurement = measureRun(run, t);
    ctx.finalSession?.(index, run.session ?? null);
    // An interview's answers, turn by turn, kept with the cell so a cached one still sets them side by side.
    const turns = t.asks?.length ? readTurns(dir, t.asks.length + 1) : null;
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
        // WHICH MODEL produced this. A sweep can vary the model as a dimension, and even when it does
        // not, "which model was this run against" is the first question asked of any result and was
        // previously answerable only by reading a run.md. Saved with the cell so a cached one keeps it.
        backend: run.backendLabel ?? null, models: run.models ?? null,
        ...(turns ? { turns, prompt: promptChars(dir), statuses: driver.statuses } : {}) };
    await writeFile(cacheFile, JSON.stringify(saved, null, 2));
    // Into the scores log, once, as it lands (scores.mjs): a sweep that dies half way still leaves its runs counted.
    const row = ctx.scores && runRow({ ...saved, fromCache: false }, t, ctx.scoreSweep);
    if (row) ctx.logged += logRuns(ctx.scores, [row]);
    ctx.ran++;
    ctx.report?.(index, "done", { ...saved, dir, fromCache: false });
    ctx.log(`  ${measurement.ok ? "✔" : "✖"} ${label} — ${measurement.steps} steps, ${(measurement.runMs / 1000).toFixed(1)}s${measurement.succeeded === null ? "" : measurement.succeeded ? ", correct" : ", WRONG"}${measurement.error ? ` — ${String(measurement.error).slice(0, 80)}` : ""}`);
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
    if (args.specPath.endsWith(".json")) {
        const iv = loadInterview(args.specPath);
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
        spec = interviewBench(iv, models, { surface: args.surface, turnMinutes: args.turnMinutes });
        // One browser per model, as panel.mjs runs them, unless --jobs says otherwise.
        if (!process.argv.includes("--jobs")) args.jobs = models.length;
    } else {
        const specMod = await import(pathToFileURL(path.resolve(args.specPath)).href);
        spec = specMod.default || specMod.spec;
        if (!spec?.name || !spec?.tasks?.length) throw new Error(`${args.specPath} does not export a bench spec (default export with name + tasks)`);
    }

    const { fingerprint, dirty } = buildFingerprint();
    const cells = expandCells(spec, { only: parseSelector(args.only), skip: parseSelector(args.skip), repeats: args.repeats });
    if (!cells.length) throw new Error("no cells selected — check --only/--skip");

    const groups = buildGroups(cells);
    console.log(`\n  ${spec.name}\n  ${cells.length} runs · ${groups.length} build${groups.length > 1 ? "s" : ""} · jobs ${args.jobs}${dirty ? " · DIRTY TREE" : ""}\n`);
    if (args.dry) {
        for (const c of cells) console.log(`  ${comboLabel(c.combo)} · ${c.task.id} · r${c.repeat}  [${cellKey(c, fingerprint)}]`);
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
    const sweepDir = path.join(ARTROOT, slug(spec.name));
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
    const scoreSweep = { name: spec.name, spec: specRel, specHash: provenance?.specHash ?? null, fingerprint, dirty, backend, info, by: defaultBy() };
    const ctx = {
        spec, fingerprint, sweepDir, backend, buildDirs, cache: args.cache, scores, scoreSweep, logged: 0,
        // Warming is a VRAM concern for a local model, and pointless against a hosted API or the fake.
        warm: !!backend && process.env.WARM !== "0",
        cached: 0, ran: 0, pdf: args.pdf,
        // CLI beats the spec: a sweep you are debugging wants `--capture always` without editing the file.
        capture: args.capture || spec.capture || "failure",
        log: (s) => console.log(s),
    };
    // The live page, when asked for. Every cell is seeded as QUEUED so the whole matrix is visible from the
    // start — what is running, what is next, and what is left is the question a long sweep actually raises.
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
    const interviews = Object.fromEntries(spec.tasks.filter((t) => t.asks?.length).map((t) => [t.id, [t.task, ...t.asks]]));

    // The sweep timeline (page/timeline.tsx): every run on one clock, each its own event lane, so a sweep shows where the
    // time went and which runs overlapped. A finished cell's events come from its final session; a running one's from
    // its live event stream, rebuilt at most every 2 s (a session rebuild per event, per running cell, would be most of
    // the CPU). Cached cells have none: their times belong to an earlier sweep and would stretch the axis across it.
    const raw = cells.map(() => []);
    const laneEvents = cells.map(() => null);
    let ganttAt = 0, gantt = null;
    ctx.rawOf = (i) => raw[i];
    ctx.finalSession = (i, session) => { laneEvents[i] = session ? eventsFrom([session]) : []; raw[i] = []; ganttAt = 0; };
    const sweepTimeline = () => {
        if (Date.now() - ganttAt < 2000 && gantt) return gantt;
        ganttAt = Date.now();
        const now = Date.now();
        const evs = cells.map((c, i) => {
            if (runsState[i].cached) return null;
            if (laneEvents[i]) return laneEvents[i];
            if (runsState[i].state !== "running" || !raw[i].length) return null;
            try { const { session } = renderRun(raw[i]); return session ? eventsFrom([session], now) : null; } catch { return null; }
        });
        const runs = evs.flatMap((events, index) => (events?.length ? [{ index, events }] : []));
        gantt = runs.length ? { runs, now } : null;
        return gantt;
    };
    const push = () => dash?.update({
        name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
        runs: runsState, rows: aggregateRows(cells, results),
        started, finished: null, jobs: args.jobs, dirty, interviews, skipped, spec: provenance, timeline: sweepTimeline(), scores: liveScores, cloud, repo,
        resources: resPoll?.resources() ?? null,
    });
    ctx.liveOf = (i) => runsState[i].live;
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
                cached: info.fromCache, path: path.relative(sweepDir, info.dir), live: undefined,
                hash: info.hash ?? null, backend: info.backend ?? null, models: info.models ?? null,
                ...(info.turns ? { turns: info.turns, statuses: info.statuses ?? [] } : {}),
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
    push();

    await pool(cells, args.jobs, (cell, i) => runCell(cell, ctx, i));
    const finished = Date.now();
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
        steps: results[i]?.measurement?.steps ?? 0, cached: !!results[i]?.fromCache,
        secs: results[i]?.measurement ? results[i].measurement.runMs / 1000 : null,
        // Relative to the SWEEP directory: report.html sits there, and the terminal/markdown reports
        // print repo-relative paths separately below.
        hash: results[i]?.hash ?? null, backend: results[i]?.backend ?? null,
        models: results[i]?.models ?? null,
        path: results[i] ? path.relative(sweepDir, results[i].dir) : "",
        repoPath: results[i] ? path.relative(ROOT, results[i].dir) : "",
        who: runsState[i].who,
        ...(runsState[i].turns ? { turns: runsState[i].turns, checks: runsState[i].checks ?? [] } : {}),
    }));

    const sweep = { spec, rows, runs, fingerprint, dirty, started, finished, sweepDir: path.relative(ROOT, sweepDir), cached: ctx.cached, ran: ctx.ran, jobs: args.jobs, pdf: args.pdf };
    writeReport(sweep, terminalSink());
    const md = writeReport(sweep, mdSink());
    const reportPath = path.join(sweepDir, "report.md");
    await writeFile(reportPath, md);
    // What the sweep wrote, for the terminal: a model driving the bench reads these rather than the page.
    const files = [["report", "report.md", "the results table, per cell"]];
    // An interview's answers as panel.mjs writes them, so a model reading the sweep reads the same file either way.
    for (const t of spec.tasks.filter((t) => t.asks?.length)) {
        const res = runs.flatMap((r, i) => r.taskId === t.id && results[i] ? [{
            model: spec.dimensions?.model && Object.keys(spec.dimensions).length === 1 ? r.combo.model : `${comboLabel(r.combo)}${r.repeat ? ` r${r.repeat}` : ""}`,
            turns: r.turns ?? [], statuses: results[i].statuses ?? [], prompt: results[i].prompt ?? "?", expected: t.asks.length + 1,
            checks: r.checks ?? [],
        }] : []);
        const iv = { task: t.task, asks: t.asks, about: spec.description };
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
        runs, rows, started, finished, jobs: args.jobs, dirty, fingerprint, pdf: args.pdf, interviews, skipped, spec: provenance,
        scores: scoreLines("../scores.html"), cloud, repo,
        resources: resPoll?.resources() ?? null,
        timeline: (ganttAt = 0, sweepTimeline()),
    };
    // report.html — the live page with the final state baked in. Written ALWAYS, not only with --serve:
    // the page is already an index of the runs, so archiving it is what makes the sweep directory
    // navigable on its own. Links are relative, so it works from disk with no server.
    await writeFile(path.join(sweepDir, "report.html"), await staticPage(pageState));
    await writeFile(path.join(sweepDir, "page.json"), JSON.stringify(pageState, null, 2));
    const nameOf = (i) => [runs[i].taskId, ...Object.keys(spec.dimensions || {}).map((d) => runs[i].combo[d]), `r${runs[i].repeat}`].join(" · ");
    await writeFile(path.join(sweepDir, "timeline.md"), timelineText(pageState.timeline, nameOf, { cached: runs.filter((r) => r.cached).length }));
    await writeFile(path.join(sweepDir, "spec.md"), specText(provenance));
    await writeFile(path.join(sweepDir, "memory.md"), memoryText(pageState.resources));
    await writeFile(path.join(sweepDir, "rows.json"), JSON.stringify({ fingerprint, dirty, started, finished, rows, runs }, null, 2));
    files.push(
        ["timeline", "timeline.md", "every run on one clock: spans, overlaps, model loads"],
        ["memory", "memory.md", "the box's memory during the sweep: each pool's peak and mean, each model's stretch in memory"],
        ["spec", "spec.md", "which spec version ran, who started the sweep, the diff against the sweep before (log: sweeps.jsonl)"],
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
    if (resPoll) console.log(`  box: ${resPoll.mode === "stream" ? `its event stream, every frame kept in ${path.relative(ROOT, BOX_DB)}` : "polled memory (the server has no event stream)"}; memory.md says what it did.`);
    console.log("");
    // A live watcher holds the process open: without a page to keep current, stop watching marks.jsonl now.
    const unwatchMarks = () => { clearTimeout(marksTimer); marksWatch?.close(); };
    if (!dash) unwatchMarks();

    if (dash) {
        dash.update({
            name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
            runs: runsState, rows, started, finished, jobs: args.jobs, dirty, interviews, skipped, spec: provenance, timeline: sweepTimeline(), scores: scoreLines("/scores"), cloud, repo,
            resources: pageState.resources,
        });
        // Held open on purpose: the page IS the result when you ran with --serve, and tearing the server
        // down the instant the last cell lands would blank it exactly when you look.
        console.log(`  live: ${dash.url} — still serving; Ctrl+C to stop.\n`);
        await new Promise((r) => process.on("SIGINT", r));
        await dash.stop();
        unwatchMarks();
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
