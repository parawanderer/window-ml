// run.mjs — walk a bench spec's matrix and report it.
//
//   node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/pointer-ids.bench.ts
//   … --jobs 4            run 4 browsers at once (a hosted API; NOT a local GPU — see below)
//   … --only idFormat=label --only task=two-tables      re-measure a subset
//   … --repeats 2 --dry   print the matrix and stop
//   … --no-cache          re-run cells that are already measured
//
// The sweep is RESUMABLE: each cell's measurement is written under a content-addressed key covering the
// cell's configuration AND the build it ran against, so a six-hour sweep that dies at hour five resumes
// rather than restarting, and an edit to the extension invalidates what it invalidates instead of silently
// mixing two builds into one table.
//
// This is a self-tool, not a test: `npm test` globs tests/*.test.* and never picks it up. See the `bench`
// skill for the playbook.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOnce, resolveBackendFromEnv } from "../run-once.mjs";
import { measureRun, aggregate } from "./metrics.mjs";
import { expandCells, cellKey, cellPath, comboLabel, buildGroups, parseSelector, slug } from "./cells.mjs";
import { writeReport, mdSink, terminalSink } from "./sinks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ARTROOT = path.join(ROOT, "tests/e2e/artifacts/bench");
const BUILDROOT = path.join(ROOT, "tests/e2e/artifacts/builds");

function parseArgv(argv) {
    const args = { specPath: null, jobs: 1, only: [], skip: [], repeats: undefined, dry: false, cache: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--jobs") args.jobs = Math.max(1, Number(argv[++i]) || 1);
        else if (a === "--only") args.only.push(argv[++i]);
        else if (a === "--skip") args.skip.push(argv[++i]);
        else if (a === "--repeats") args.repeats = Math.max(1, Number(argv[++i]) || 1);
        else if (a === "--dry") args.dry = true;
        else if (a === "--no-cache") args.cache = false;
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

/** Run one cell (or read it back from cache) and return its measurement. */
async function runCell(cell, ctx) {
    const key = cellKey(cell, ctx.fingerprint);
    const dir = path.join(ctx.sweepDir, cellPath(cell));
    const cacheFile = path.join(dir, "cell.json");

    if (ctx.cache && existsSync(cacheFile)) {
        try {
            const saved = JSON.parse(await readFile(cacheFile, "utf8"));
            if (saved.key === key) { ctx.cached++; return { ...saved, dir, fromCache: true }; }
        } catch { /* unreadable cache → re-run */ }
    }
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
            timeoutMs: t.timeoutMs ?? ctx.spec.timeoutMs ?? 180000,
            // A sweep is a machine reading a matrix: no sidebar to focus, no browser to hold open, and the
            // per-event chatter would bury the progress line.
            focusSidebar: false,
            hold: false,
            warm: ctx.warm,
            log: () => {},
        });
    } catch (err) {
        run = { events: [], result: null, error: String(err), runMs: 0, approvals: [], seedBoundarySeq: -1 };
    }

    const measurement = measureRun(run, t);
    const saved = { key, combo: cell.combo, taskId: t.id, repeat: cell.repeat, measurement };
    await writeFile(cacheFile, JSON.stringify(saved, null, 2));
    ctx.ran++;
    ctx.log(`  ${measurement.ok ? "✔" : "✖"} ${label} — ${measurement.steps} steps, ${(measurement.runMs / 1000).toFixed(1)}s${measurement.succeeded === null ? "" : measurement.succeeded ? ", correct" : ", WRONG"}${measurement.error ? ` — ${String(measurement.error).slice(0, 80)}` : ""}`);
    return { ...saved, dir, fromCache: false };
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
        cached: 0, ran: 0, log: (s) => console.log(s),
    };
    const started = Date.now();
    const results = await pool(cells, args.jobs, (cell) => runCell(cell, ctx));
    const finished = Date.now();

    // Aggregate: one row per (combination x task), over that cell's repeats.
    const byCell = new Map();
    for (let i = 0; i < cells.length; i++) {
        const c = cells[i], r = results[i];
        const k = `${JSON.stringify(c.combo)}|${c.task.id}`;
        if (!byCell.has(k)) byCell.set(k, { combo: c.combo, taskId: c.task.id, path: path.relative(ROOT, path.dirname(r.dir)), measurements: [] });
        byCell.get(k).measurements.push(r.measurement);
    }
    const rows = [...byCell.values()].map((r) => ({
        ...r, agg: aggregate(r.measurements),
        firstError: r.measurements.find((m) => m.error)?.error || null,
    }));

    const sweep = { spec, rows, fingerprint, dirty, started, finished, cached: ctx.cached, ran: ctx.ran, jobs: args.jobs };
    writeReport(sweep, terminalSink());
    const md = writeReport(sweep, mdSink());
    const reportPath = path.join(sweepDir, "report.md");
    await writeFile(reportPath, md);
    await writeFile(path.join(sweepDir, "rows.json"), JSON.stringify({ fingerprint, dirty, started, finished, rows }, null, 2));
    console.log(`\n  report: ${path.relative(ROOT, reportPath)}\n`);
};

main().catch((e) => { console.error(e); process.exit(1); });
