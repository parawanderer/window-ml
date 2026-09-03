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
import { runOnce, resolveBackendFromEnv } from "../run-once.mjs";
import { measureRun, aggregate } from "./metrics.mjs";
import { expandCells, cellKey, cellPath, comboLabel, buildGroups, parseSelector, slug } from "./cells.mjs";
import { writeReport, mdSink, terminalSink } from "./sinks.mjs";
import { startDashboard, staticPage } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ARTROOT = path.join(ROOT, "tests/e2e/artifacts/bench");
const BUILDROOT = path.join(ROOT, "tests/e2e/artifacts/builds");

function parseArgv(argv) {
    const args = { specPath: null, jobs: 1, only: [], skip: [], repeats: undefined, dry: false, cache: true, pdf: false, serve: false, open: false, port: undefined, capture: undefined };
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
    const { sessionToHtml } = await import("../../../sidebar/export.ts");
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
    ctx.report?.(index, "running");
    await rm(dir, { recursive: true, force: true });   // a re-run must not read a stale run.md as its own
    await mkdir(dir, { recursive: true });

    const t = cell.task;
    const e = cell.effects;
    const backend = e.backend ? { ...(ctx.backend || {}), ...e.backend } : ctx.backend;
    const label = `${comboLabel(cell.combo)} · ${t.id} · r${cell.repeat}`;
    ctx.log(`  ▶ ${label}`);

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
    // Best-effort: a failed render must not lose the cell's measurement, which is the expensive part.
    if (ctx.pdf && run.session) {
        await renderPdf(run.session, dir, `${slug(ctx.spec.name)}-${t.id}-r${cell.repeat}`)
            .catch((e) => ctx.log(`  (pdf render failed for ${label}: ${String(e).slice(0, 80)})`));
    }
    const saved = { key, combo: cell.combo, taskId: t.id, repeat: cell.repeat, measurement };
    await writeFile(cacheFile, JSON.stringify(saved, null, 2));
    ctx.ran++;
    ctx.report?.(index, "done", { measurement, dir, fromCache: false });
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
    const specMod = await import(pathToFileURL(path.resolve(args.specPath)).href);
    const spec = specMod.default || specMod.spec;
    if (!spec?.name || !spec?.tasks?.length) throw new Error(`${args.specPath} does not export a bench spec (default export with name + tasks)`);

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
    await mkdir(sweepDir, { recursive: true });

    const ctx = {
        spec, fingerprint, sweepDir, backend, buildDirs, cache: args.cache,
        // Warming is a VRAM concern for a local model, and pointless against a hosted API or the fake.
        warm: !!backend && process.env.WARM !== "0",
        cached: 0, ran: 0, pdf: args.pdf,
        // CLI beats the spec: a sweep you are debugging wants `--capture always` without editing the file.
        capture: args.capture || spec.capture || "failure",
        log: (s) => console.log(s),
    };
    // The live page, when asked for. Every cell is seeded as QUEUED so the whole matrix is visible from the
    // start — what is running, what is next, and what is left is the question a long sweep actually raises.
    const runsState = cells.map((c) => ({ combo: c.combo, taskId: c.task.id, repeat: c.repeat, state: "pending" }));
    const results = new Array(cells.length);
    const dash = args.serve ? await startDashboard({ artifactRoot: sweepDir, ...(args.port != null ? { port: args.port } : {}) }) : null;
    const started = Date.now();

    const push = () => dash?.update({
        name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
        runs: runsState, rows: aggregateRows(cells, results),
        started, finished: null, jobs: args.jobs, dirty,
    });
    ctx.liveOf = (i) => runsState[i].live;
    ctx.report = (i, state, info) => {
        const r = runsState[i];
        if (state === "running" && r.state !== "running") r.startedAt = Date.now();   // for the elapsed ticker
        r.state = state;
        if (info?.live) { r.live = info.live; return push(); }
        if (state === "done" && info) {
            const m = info.measurement;
            Object.assign(r, {
                ok: m.ok, succeeded: m.succeeded, steps: m.steps, secs: m.runMs / 1000,
                cached: info.fromCache, path: path.relative(sweepDir, info.dir), live: undefined,
            });
            results[i] = info;
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
        path: results[i] ? path.relative(sweepDir, results[i].dir) : "",
        repoPath: results[i] ? path.relative(ROOT, results[i].dir) : "",
    }));

    const sweep = { spec, rows, runs, fingerprint, dirty, started, finished, sweepDir: path.relative(ROOT, sweepDir), cached: ctx.cached, ran: ctx.ran, jobs: args.jobs, pdf: args.pdf };
    writeReport(sweep, terminalSink());
    const md = writeReport(sweep, mdSink());
    const reportPath = path.join(sweepDir, "report.md");
    await writeFile(reportPath, md);
    // report.html — the live page with the final state baked in. Written ALWAYS, not only with --serve:
    // the page is already an index of the runs, so archiving it is what makes the sweep directory
    // navigable on its own. Links are relative, so it works from disk with no server.
    await writeFile(path.join(sweepDir, "report.html"), staticPage({
        name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
        runs, rows, started, finished, jobs: args.jobs, dirty, fingerprint,
    }));
    await writeFile(path.join(sweepDir, "rows.json"), JSON.stringify({ fingerprint, dirty, started, finished, rows, runs }, null, 2));
    console.log(`\n  report: ${path.relative(ROOT, reportPath)}\n  page:   ${path.relative(ROOT, path.join(sweepDir, "report.html"))}\n`);

    if (dash) {
        dash.update({
            name: spec.name, description: spec.description, dims: Object.keys(spec.dimensions || {}),
            runs: runsState, rows, started, finished, jobs: args.jobs, dirty,
        });
        // Held open on purpose: the page IS the result when you ran with --serve, and tearing the server
        // down the instant the last cell lands would blank it exactly when you look.
        console.log(`  live: ${dash.url} — still serving; Ctrl+C to stop.\n`);
        await new Promise((r) => process.on("SIGINT", r));
        await dash.stop();
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
