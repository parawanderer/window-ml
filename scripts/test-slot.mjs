#!/usr/bin/env node
// test-slot.mjs — a few test runs on this machine at a time, under a memory budget: a QUEUE that every local test
// runner goes through (every scripts/test.mjs spawn, Playwright, `npm run coverage`), shared by every clone and every
// session, which admits a run when the memory free above the reserve leaves room for its minimum workers, and sizes
// its workers from that room.
//
//   node scripts/test-slot.mjs submit [--kind unit|e2e|batch [--workers N]] -- <command…>   queue a DETACHED job; prints its ticket, returns at once
//   node scripts/test-slot.mjs wait <ticket>                            block until it ends; its log's tail, its exit code
//   node scripts/test-slot.mjs status                                   what runs, what waits, the last finished jobs
//   node scripts/test-slot.mjs cancel <ticket>                          take a job out of the queue, or stop it
//   node scripts/test-slot.mjs run [--kind unit|e2e|batch [--workers N]] -- <command…>   wait for the slot in the FOREGROUND, then run it here
//
// Why: on 2026-11-08 nine `node --import tsx --test` runners from different sessions ran at once, 34 workers between
// them, and the laptop swapped 27 GB; a suite that takes 40 s alone ran for ten minutes. A rule each lane had to
// remember did not hold, so the runners themselves queue.
//
// Admission (the rule of 2026-11-09): at most MAX_RUNS runs at once and MAX_WORKERS workers between them (cores − 2).
// A queued job starts when free memory, less the reserve, less what every running run planned and does not hold yet
// (and what a bench sweep admitted), leaves room for its kind's minimum workers at its p90 per-worker figure; it gets
// as many as that room gives. The queue is FIFO among the admissible: a job is passed only by one that fits while it
// does not. With nothing running the head always starts, on one worker if that is all there is, so a busy machine
// slows the queue and never stops it.
//
// Batch jobs (the rule of 2026-11-09): `--kind batch` is for any job that is NOT a test run but wants the memory lock
// (probes, scans, notebook data runs). It declares the workers it really uses, `--workers N` (1 to BATCH_MAX_WORKERS,
// default 1), and the queue grants all N or none: min and cap are both N, and both caps hold even alone (the
// always-starts rule is for a run sized from free memory, not a declared count). A submit is refused (exit 2) when N
// exceeds the machine's worker cap, or when nothing runs and N workers' memory exceeds the room: waiting would never
// end on a small box, and granting fewer breaks all-or-nothing. It counts toward
// the run and worker caps like any run, at most ONE runs at a time, and every queued test job is judged before any
// batch job, whatever the submit order. Its footprints are its own (`perWorkerFor("batch")`, the unit figure until it
// has any), so it never sizes a test run. Submitters chunk it to about five minutes or less (guidance, not enforced); a
// run past BATCH_OVERRUN_MS is marked `overran` in its footprint so the chunk can be tuned. Nothing kills it here.
//
// Two kinds of job share the slots. An ATTACHED job is a runner waiting in its own process (`npm test`, a genre,
// Playwright's main process): it keeps its terminal and exit code, and holds the slot until it exits. A DETACHED job
// (`submit`) runs in a process of its own, in the ticket's cwd with the ticket's recorded environment, so it outlives
// the session that asked for it; its output goes to `<ticket>.log`. There is no daemon: every read of the queue starts
// whatever is admissible (a job ending, a submit, a `wait` or `status` poll, a waiting runner's poll), and a holder
// whose process has died is reclaimed on every read, so a queue never sits idle while anything waits on it.
//
// CI skips it (`CI` or `GITHUB_ACTIONS`: the runner is a VM whose only job is the suite), so does `TEST_SLOT=off`, and a
// runner started INSIDE a job (`TEST_SLOT_TICKET` set) runs at once. It only covers clones that have pulled it.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alive, availableMemory, fmtBytes, ledger, notYetResident, p90, processTable, register, RESERVE_FRAC, treePids, treeRss, unregister, withFileLock } from "../tests/e2e/bench/memory-budget.mjs";

const SELF = fileURLToPath(import.meta.url);
const GB = 1024 ** 3;
/** What one worker is assumed to take before any run was measured: a node:test file process or a Chromium. */
export const PER_WORKER_DEFAULT = GB;
/** The most runs at once (the 2026-11-08 incident was nine; a few is fine). `TEST_SLOT_MAX_RUNS` overrides it. */
export const MAX_RUNS = 3;
/** The most workers all running runs may have between them: the cores less two. */
export const maxWorkersFor = (cores = os.cpus().length) => Math.max(1, cores - 2);
/** The fewest workers a run of a kind is started with, unless nothing else runs: a suite on one worker takes twice as long. */
export const minWorkersFor = (kind) => (kind === "e2e" || kind === "batch" ? 1 : 2);
/** The most workers a batch job may declare (`--workers`). */
export const BATCH_MAX_WORKERS = 6;
/** A batch run longer than this is marked `overran` in its footprint, so the chunk size can be tuned. */
export const BATCH_OVERRUN_MS = 15 * 60_000;
/** How many finished jobs the queue keeps (their logs go with them). */
const KEEP_DONE = 20;
/** Footprints of the last this-many runs of a kind decide its per-worker figure. */
const FOOTPRINTS_USED = 20;
/** A run shorter than this is not measured: it never filled its workers. */
const MEASURE_MIN_MS = 10_000;
/** The environment a detached job is given: these names, and those matching `ENV_PREFIXES`, never a secret's. */
const ENV_NAMES = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "FORCE_COLOR", "NO_COLOR", "NODE_OPTIONS", "DISPLAY"];
const ENV_PREFIXES = ["E2E_", "BENCH_", "PW_", "PLAYWRIGHT_", "USE_ENV", "DEBUG"];
const SECRET = /KEY|TOKEN|SECRET|PASS|CRED|AUTH/i;

/** The queue's folder: `TEST_SLOT_DIR`, else `~/.cache/window-ml/test-queue`. */
export const slotDir = (env = process.env) => env.TEST_SLOT_DIR || path.join(os.homedir(), ".cache", "window-ml", "test-queue");
const pollMs = (env = process.env) => Number(env.TEST_SLOT_POLL_MS) || 2000;

/** Why this process does not queue (`"ci"`, `"off"`, `"nested"`), or null when it does. */
export function skipReason(env = process.env) {
    if (env.CI || env.GITHUB_ACTIONS) return "ci";
    if (env.TEST_SLOT === "off") return "off";
    if (env.TEST_SLOT_TICKET) return "nested";
    return null;
}

/** A process's start time as `ps` prints it, or null when it is gone: with the pid, what tells a holder from a reuse. */
export function startTime(pid) {
    try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
    catch { return null; }
}

/** Whether the process a record names is the one still running: alive, and started when it was recorded. */
export const procLive = (pid, started, probe = { alive, startTime }) => !!pid && probe.alive(pid) && (!started || probe.startTime(pid) === started);

/** How many workers a run gets: what free memory leaves above the reserve, per worker, between 1 and `cap`. */
export function jobsFor({ available, total, perWorker = PER_WORKER_DEFAULT, cap }) {
    const room = available - RESERVE_FRAC * total;
    return Math.max(1, Math.min(cap, Math.floor(room / perWorker)));
}

/** The most workers a kind may have here: test.mjs's cores − 2 (at most 8), Playwright's half the cores, a batch job's
 *  declared `want` (1 here, the default). */
export const capFor = (kind, cores = os.cpus().length) => (kind === "batch" ? 1 : kind === "e2e" ? Math.max(1, Math.floor(cores / 2)) : Math.min(8, Math.max(1, cores - 2)));

/** The per-worker figure for a kind: the p90 of its measured runs, or the default with none; a batch job with none of
 *  its own takes the unit figure (batch lines never feed a test kind's). */
export function perWorkerFor(kind, dir = slotDir()) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, "footprints.jsonl"), "utf8").split("\n").filter(Boolean); } catch { /* none yet */ }
    const mine = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((f) => f?.kind === kind).slice(-FOOTPRINTS_USED);
    const v = p90(mine.map((f) => f.perWorker));
    return { bytes: v ?? (kind === "batch" ? perWorkerFor("unit", dir).bytes : PER_WORKER_DEFAULT), measured: mine.length };
}

/** What the bench's ledger says is on its way but not yet in free memory: browsers a sweep just admitted. Test runs'
 *  own entries are left out: the queue counts them itself, from what each holds now (`promisedBy`). Never throws. */
function benchComing() {
    try { return notYetResident(ledger().filter((e) => e.kind !== "tests")); } catch { return 0; }
}

/** What running jobs planned and do not hold yet: each one's workers × per-worker, less its process tree's memory now. */
export function promisedBy(running, resident = residentOf()) {
    return running.reduce((a, j) => a + Math.max(0, (j.jobs ?? 0) * (j.sizing?.perWorker ?? PER_WORKER_DEFAULT) - resident(j)), 0);
}
/** A job's process tree's resident memory, from one process table. */
function residentOf() {
    let table = null;
    return (j) => { try { table ??= processTable(); return j.pid ? treeRss(table, j.pid) : 0; } catch { return 0; } };
}

/** The memory reading admission is made from (injected in tests, which may also fix `perWorker` and `cap` for every
 *  kind): free memory, what the bench admitted and has not started, the machine's total and cores. One reading per pass; each start in the pass is counted against it. */
const readMemory = () => ({ available: availableMemory(), coming: benchComing(), total: os.totalmem(), cores: os.cpus().length });
/** A kind's per-worker figure and worker cap (injected in tests). */
const readKind = (kind, dir) => ({ perWorker: perWorkerFor(kind, dir).bytes, cap: capFor(kind) });
/** A kind's per-worker figure and cap under a reading: injected by `deps.kind` or the reading itself in tests, else measured. */
const sizingFor = (kind, m, dir, deps) => (deps.kind ? deps.kind(kind) : m.perWorker ? { perWorker: m.perWorker, cap: m.cap } : readKind(kind, dir));

/**
 * Whether a job of `kind` may start now, and with how many workers. `room` is free memory less the reserve, less what
 * the bench admitted and what running runs planned and do not hold yet; `workers` is what the running runs have.
 * With nothing running a job without `want` always starts (at least one worker); else it needs its minimum in memory
 * and in the worker cap. A job that declares `want` workers (batch) needs exactly that many in both, even alone, gets
 * exactly that many, and waits while `batches` batch jobs run (at most one). Returns `{ jobs }` or `{ jobs: 0, why }`.
 */
export function admit({ kind, running, workers, room, perWorker, cap, maxRuns = MAX_RUNS, maxWorkers, want = 0, batches = 0 }) {
    const left = Math.max(0, maxWorkers - workers), fit = Math.floor(room / perWorker);
    if (!running && !want) return { jobs: Math.max(1, Math.min(cap, left, fit)) };
    if (kind === "batch" && batches) return { jobs: 0, why: "a batch job runs already (at most one)" };
    if (running >= maxRuns) return { jobs: 0, why: `${running} run${running === 1 ? "" : "s"} at once already (at most ${maxRuns})` };
    const min = want || minWorkersFor(kind);
    if (left < min) return { jobs: 0, why: `the running runs have ${workers} of ${maxWorkers} workers` };
    if (fit < min) return { jobs: 0, why: `memory: ${fmtBytes(Math.max(0, room))} above the reserve, ${min} workers take ${fmtBytes(min * perWorker)}` };
    return { jobs: want || Math.min(cap, left, fit) };
}

/** Put a granted job in the bench's ledger as kind `tests`, with the memory its workers will take, so a sweep counts
 *  it before its workers are up (memory-budget.mjs's notYetResident). Dropped once its process is gone. Never throws. */
function joinBench(job) {
    try { register({ kind: "tests", pid: job.pid, ticket: job.ticket, repo: job.clone, cmd: cmdText(job.cmd), planned: job.jobs * job.sizing.perWorker }); } catch { /* the bench sees it through free memory */ }
}
const leaveBench = (job) => { try { if (job.pid) unregister(job.pid); } catch { /* dropped when the pid dies */ } };

/** The clone, head and working-tree hash a job runs at; `dirty` is null for a clean tree. Never throws. */
export function treeState(cwd) {
    const git = (args, enc = "utf8") => { try { return execFileSync("git", args, { cwd, encoding: enc, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 ** 2 }); } catch { return null; } };
    const clone = git(["rev-parse", "--show-toplevel"])?.trim() ?? cwd;
    const head = git(["rev-parse", "HEAD"])?.trim() ?? null;
    const diff = git(["diff", "HEAD", "--binary"], "buffer");
    const untracked = (git(["ls-files", "-o", "--exclude-standard", "-z"]) ?? "").split("\0").filter(Boolean);
    if (!diff?.length && !untracked.length) return { clone, head, dirty: null };
    const h = createHash("sha256").update(diff ?? "");
    for (const f of untracked.sort()) {
        h.update(`\0${f}\0`);
        try { const p = path.join(clone, f), st = fs.statSync(p); h.update(st.size > 8 * 1024 ** 2 ? `${st.size}:${st.mtimeMs}` : fs.readFileSync(p)); } catch { /* gone */ }
    }
    return { clone, head, dirty: h.digest("hex").slice(0, 16) };
}

/** The part of `env` a detached job is given: the names above, without anything named like a secret. */
export function jobEnv(env = process.env) {
    return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET.test(k) && (ENV_NAMES.includes(k) || ENV_PREFIXES.some((p) => k.startsWith(p)))));
}

const readState = (dir) => { try { const s = JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8")); return Array.isArray(s?.jobs) ? s : { jobs: [] }; } catch { return { jobs: [] }; } };
function writeState(dir, state) {
    const file = path.join(dir, "queue.json"), tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
}

/** Run `fn(state)` with the queue locked, reaping dead holders and starting the head job on the way out. */
function withQueue(dir, fn, deps = {}) {
    fs.mkdirSync(dir, { recursive: true });
    return withFileLock(path.join(dir, "queue.lock"), () => {
        const state = readState(dir);
        const out = fn(state);
        const reaped = reap(state, deps.probe);
        const started = startNext(state, dir, deps);
        writeState(dir, state);
        return { state, out, reaped, started };
    });
}

/** Mark what has died: a running job whose process is gone is `lost`, a queued attached one whose runner is gone is
 *  `abandoned`. Then keep only the last finished jobs, deleting the logs of the rest. Returns the reaped records. */
export function reap(state, probe) {
    const now = new Date().toISOString(), reaped = [];
    for (const j of state.jobs) {
        if (j.state === "running" && !procLive(j.pid, j.started, probe)) Object.assign(j, { state: "lost", endedAt: now, exit: null });
        else if (j.state === "queued" && j.mode === "attached" && !procLive(j.by.pid, j.by.started, probe)) Object.assign(j, { state: "abandoned", endedAt: now, exit: null });
        else continue;
        reaped.push(j);
    }
    const done = state.jobs.filter((j) => !["queued", "running"].includes(j.state));
    for (const j of done.slice(0, Math.max(0, done.length - KEEP_DONE))) {
        try { if (j.log) fs.rmSync(j.log, { force: true }); } catch { /* gone */ }
        state.jobs.splice(state.jobs.indexOf(j), 1);
    }
    return reaped;
}

/** Start every queued job that is admissible (`admit`), test jobs first in queue order, then batch jobs: an attached one is GRANTED (its runner sees it
 *  and goes), a detached one is spawned. Each start is counted against the same reading before the next is judged.
 *  Records why the first job left waiting waits (`state.waiting`). Returns the started records. */
export function startNext(state, dir, deps = {}) {
    const queued = state.jobs.filter((j) => j.state === "queued");
    state.waiting = null;
    if (!queued.length) return [];
    const running = state.jobs.filter((j) => j.state === "running");
    const m = (deps.memory ?? readMemory)();
    const maxRuns = deps.maxRuns ?? (Number(process.env.TEST_SLOT_MAX_RUNS) || MAX_RUNS), maxWorkers = maxWorkersFor(m.cores ?? os.cpus().length);
    const base = m.available - (m.coming ?? 0) - RESERVE_FRAC * m.total;
    let promised = promisedBy(running, deps.resident ?? residentOf()), workers = running.reduce((a, j) => a + (j.jobs ?? 0), 0);
    const started = [];
    let batches = running.filter((j) => j.kind === "batch").length;
    for (const job of [...queued.filter((j) => j.kind !== "batch"), ...queued.filter((j) => j.kind === "batch")]) {
        const k = sizingFor(job.kind, m, dir, deps);
        const room = base - promised;
        const a = admit({ kind: job.kind, running: running.length, workers, room, perWorker: k.perWorker, cap: k.cap, maxRuns, maxWorkers, want: job.kind === "batch" ? job.want ?? 1 : 0, batches });
        if (!a.jobs) { state.waiting ??= { ticket: job.ticket, why: a.why }; if (running.length >= maxRuns) break; continue; }
        Object.assign(job, { state: "running", grantedAt: new Date().toISOString(), jobs: a.jobs,
            sizing: { available: m.available, coming: (m.coming ?? 0) + promised, total: m.total, perWorker: k.perWorker, runs: running.length + 1, workers: workers + a.jobs } });
        if (job.mode === "attached") Object.assign(job, { pid: job.by.pid, started: job.by.started });
        else Object.assign(job, (deps.spawnJob ?? spawnJob)(job, dir));
        (deps.joinBench ?? joinBench)(job);
        running.push(job);
        promised += a.jobs * k.perWorker;
        workers += a.jobs;
        if (job.kind === "batch") batches++;
        started.push(job);
    }
    // The most runs each running job has shared the machine with, for its footprint.
    for (const j of running) j.peakRuns = Math.max(j.peakRuns ?? 1, running.length);
    return started;
}

/** Start a detached job: this script's `__job` in the ticket's cwd with the ticket's environment, in a process group
 *  of its own, so it outlives whoever started it and `cancel` stops all of it. */
function spawnJob(job, dir) {
    const child = spawn(process.execPath, [SELF, "__job", job.ticket], { cwd: job.cwd, env: { ...job.env, TEST_SLOT_DIR: dir, ...(process.env.TEST_SLOT_MAX_RUNS ? { TEST_SLOT_MAX_RUNS: process.env.TEST_SLOT_MAX_RUNS } : {}) }, detached: true, stdio: "ignore" });
    child.unref();
    return { pid: child.pid, started: startTime(child.pid) };
}

/**
 * Why a batch job declaring `want` workers is refused at submit, or null: more workers than the machine's cap, or, with
 * nothing running, more memory than the room above the reserve. Both are figures the submitter acts on by asking for
 * fewer; with something running the job queues and waits for both caps like any other.
 */
export function batchRefusal(state, want, dir, deps = {}) {
    const m = (deps.memory ?? readMemory)(), maxWorkers = maxWorkersFor(m.cores ?? os.cpus().length);
    if (want > maxWorkers) return `${want} workers is more than this machine's worker cap of ${maxWorkers} (its cores less two)`;
    if (state.jobs.some((j) => j.state === "running")) return null;
    const { perWorker } = sizingFor("batch", m, dir, deps), room = m.available - (m.coming ?? 0) - RESERVE_FRAC * m.total;
    if (want * perWorker <= room) return null;
    const most = Math.floor(Math.max(0, room) / perWorker);
    return `${want === 1 ? "1 worker takes" : `${want} workers take`} ${fmtBytes(want * perWorker)} and, with nothing else running, the memory room is ${fmtBytes(Math.max(0, room))} above the reserve; ${most ? `ask for at most ${most}` : "not even one fits now: try later"}`;
}

/**
 * Put a job in the queue. A detached job with the same clone, command, head and working-tree hash (and, for batch, the
 * same declared workers) as one still QUEUED gets that one's ticket (`shared: true`): two sessions asking for the same
 * check get one run. A batch job `batchRefusal` refuses is not queued: `{ refused }`, no ticket.
 * @param {{ cmd: string[], cwd?: string, kind?: "unit" | "e2e" | "batch", workers?: number, mode?: "attached" | "detached", env?: object, dir?: string, deps?: object, tree?: object }} o
 */
export function submit({ cmd, cwd = process.cwd(), kind = "unit", workers = 1, mode = "detached", env = process.env, dir = slotDir(env), deps = {}, tree = treeState(cwd) }) {
    // A test job's key is what it was before batch existed, so an old copy's queued job is still shared.
    const key = createHash("sha256").update(JSON.stringify([tree.clone, cmd, tree.head, tree.dirty, ...(kind === "batch" ? ["batch", workers] : [])])).digest("hex").slice(0, 16);
    const ticket = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
    const by = { pid: process.pid, started: (deps.startTime ?? startTime)(process.pid) };
    const { out, reaped } = withQueue(dir, (state) => {
        const same = mode === "detached" && state.jobs.find((j) => j.state === "queued" && j.mode === "detached" && j.key === key);
        if (same) return { job: same, shared: true };
        const refused = kind === "batch" ? batchRefusal(state, workers, dir, deps) : null;
        if (refused) return { refused };
        const job = { ticket, mode, kind, cmd, cwd, key, clone: tree.clone, head: tree.head, dirty: tree.dirty, by, state: "queued", submittedAt: new Date().toISOString(),
            ...(kind === "batch" ? { want: workers } : {}),
            ...(mode === "detached" ? { env: jobEnv(env), log: path.join(dir, `${ticket}.log`) } : {}) };
        state.jobs.push(job);
        return { job, shared: false };
    }, deps);
    if (out.refused) return { refused: out.refused, reaped };
    return { ticket: out.job.ticket, shared: out.shared, reaped };
}

/** Mark a job ended with `exit` and start the next one. */
export function finish(ticket, exit, { dir = slotDir(), deps = {}, peak = null } = {}) {
    let rec = null;
    withQueue(dir, (state) => {
        const j = state.jobs.find((x) => x.ticket === ticket);
        if (!j || j.state !== "running") return;
        const endedAt = new Date();
        Object.assign(j, { state: "done", exit, endedAt: endedAt.toISOString(), durationMs: endedAt - new Date(j.grantedAt), ...(peak ? { peakRss: peak } : {}) });
        rec = j;
    }, deps);
    if (rec) (deps.leaveBench ?? leaveBench)(rec);
    if (rec?.peakRss && rec.durationMs >= MEASURE_MIN_MS && rec.jobs) {
        try { fs.appendFileSync(path.join(dir, "footprints.jsonl"), `${JSON.stringify({ at: rec.endedAt, kind: rec.kind, jobs: rec.jobs, peakRss: rec.peakRss, perWorker: Math.round(rec.peakRss / rec.jobs), runs: rec.peakRuns ?? 1, durationMs: rec.durationMs, ...(rec.kind === "batch" && rec.durationMs > BATCH_OVERRUN_MS ? { overran: true } : {}), ticket })}\n`); } catch { /* unmeasured */ }
    }
    return rec;
}

/** Look at the queue (reaping and starting on the way, so a poll keeps it moving): the job, what runs, what is ahead
 *  of it, and why the first waiting job waits. */
export function look(ticket, { dir = slotDir(), deps = {} } = {}) {
    const { state, reaped, started } = withQueue(dir, () => undefined, deps);
    const job = state.jobs.find((j) => j.ticket === ticket) ?? null;
    const running = state.jobs.filter((j) => j.state === "running");
    const queued = state.jobs.filter((j) => j.state === "queued");
    return { job, running, ahead: job ? queued.indexOf(job) : -1, queued, why: state.waiting?.why ?? null, state, reaped, started };
}

const home = (p) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const age = (iso, now = Date.now()) => { const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`; };
const cmdText = (cmd) => cmd.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ").replace(process.execPath, "node").slice(0, 120);

/** The line a waiting runner prints: what runs, since when, why the queue waits, and how many are ahead. */
export function waitingLine({ running = [], ahead, why = null }, now = Date.now()) {
    const one = (r) => `pid ${r.pid} (${home(r.clone)}, ${cmdText(r.cmd)}, ${r.jobs} worker${r.jobs === 1 ? "" : "s"}, held ${age(r.grantedAt, now)})`;
    const who = running.length ? running.map(one).join(" and ") : "a slot to free";
    return `test-slot: waiting for ${who}${why ? ` (${why})` : ""}; ${ahead} ahead of you`;
}

/** The line a granted run prints: its workers and the reading they came from. */
export const grantLine = (job) => `test-slot: ${job.jobs} worker${job.jobs === 1 ? "" : "s"} (${fmtBytes(job.sizing.available)} available${job.sizing.coming ? `, ${fmtBytes(job.sizing.coming)} of it promised to bench browsers and other test runs starting up` : ""}, ${fmtBytes(RESERVE_FRAC * job.sizing.total)} reserved, ~${fmtBytes(job.sizing.perWorker)} per worker${job.sizing.runs > 1 ? `; run ${job.sizing.runs} at once, ${job.sizing.workers} workers between them` : ""})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sample this process tree's resident memory every 2 s; returns a function giving the peak so far. */
function samplePeak(pid = process.pid) {
    let peak = 0;
    const read = () => { try { peak = Math.max(peak, treeRss(processTable(), pid)); } catch { /* unread */ } };
    read();
    const t = setInterval(read, 2000);
    t.unref();
    return () => { read(); clearInterval(t); return peak; };
}

/**
 * Wait in THIS process for the slot, then hold it until the process exits: what test.mjs, Playwright's config and
 * `run` call. Resolves `{ jobs, ticket }`, or `{ jobs: null, skipped }` when this process does not queue (CI, `TEST_SLOT=off`,
 * inside a job, where `TEST_SLOT_JOBS` is the job's workers). Prints the waiting line at the start and every 30 s.
 * `signal` gives up the wait (a test's deadline): the ticket is cancelled and the abort reason thrown.
 * @param {{ cmd: string[], cwd?: string, kind?: "unit" | "e2e" | "batch", workers?: number, log?: (s: string) => void, env?: object, signal?: AbortSignal }} o
 */
export async function acquire({ cmd, cwd = process.cwd(), kind = "unit", workers = 1, log = (s) => console.error(s), env = process.env, signal = null }) {
    const skipped = skipReason(env);
    if (skipped) {
        if (skipped === "off") log("test-slot: TEST_SLOT=off, not queueing: other runs on this machine are not waited for");
        return { jobs: Number(env.TEST_SLOT_JOBS) || null, skipped };
    }
    const dir = slotDir(env);
    const { ticket, reaped, refused } = submit({ cmd, cwd, kind, workers, mode: "attached", env, dir });
    if (refused) throw Object.assign(new Error(`test-slot: refused: ${refused}`), { code: "TEST_SLOT_REFUSED" });
    const sayReaped = (list) => { for (const r of list) log(`test-slot: reclaimed the slot from pid ${r.pid ?? r.by.pid} (${r.state}: its process is gone)`); };
    sayReaped(reaped);
    let release = () => {};
    const onSignal = (sig) => {
        // The runner's children (node --test, Playwright's workers) do not all get a signal sent to this pid alone.
        for (const p of treePids(processTable(), process.pid).filter((p) => p !== process.pid)) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
        release();
        process.exit(sig === "SIGINT" ? 130 : 143);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let lastSaid = 0;
    for (;;) {
        const q = look(ticket, { dir });
        sayReaped(q.reaped);
        if (q.job?.state === "running") {
            const peak = samplePeak();
            let done = false;
            release = () => { if (done) return; done = true; finish(ticket, process.exitCode ?? null, { dir, peak: peak() }); };
            process.once("exit", () => release());
            // What this run starts (a test that spawns test.mjs, test-isolated-bundle) is inside the slot, not behind it.
            Object.assign(process.env, { TEST_SLOT_TICKET: ticket, TEST_SLOT_JOBS: String(q.job.jobs) });
            log(grantLine(q.job));
            return { jobs: q.job.jobs, ticket };
        }
        if (!q.job || q.job.state !== "queued") throw new Error(`test-slot: ticket ${ticket} was ${q.job?.state ?? "removed"} before it ran`);
        if (signal?.aborted) { cancel(ticket, { dir }); throw signal.reason; }
        if (Date.now() - lastSaid >= 30_000) { log(waitingLine(q)); lastSaid = Date.now(); }
        await sleep(pollMs(env));
    }
}

/** Stop a job: a queued one is taken out, a running one's process group (or its runner) is sent SIGTERM. */
export function cancel(ticket, { dir = slotDir(), deps = {} } = {}) {
    let was = null;
    withQueue(dir, (state) => {
        const j = state.jobs.find((x) => x.ticket === ticket);
        if (!j || !["queued", "running"].includes(j.state)) return;
        was = j.state;
        if (j.state === "running" && procLive(j.pid, j.started, deps.probe)) {
            try { process.kill(j.mode === "detached" ? -j.pid : j.pid, "SIGTERM"); } catch { /* gone */ }
        }
        if (j.state === "running") (deps.leaveBench ?? leaveBench)(j);
        Object.assign(j, { state: "cancelled", endedAt: new Date().toISOString(), exit: null });
    }, deps);
    return was;
}

/** Block until a job ends, starting the queue's head whenever it finds the slot free; prints the waiting line, then
 *  the log's last lines. Resolves the job's record; `signal` gives up the wait (the job is left as it is). */
export async function waitFor(ticket, { dir = slotDir(), log = (s) => console.error(s), tail = 40, deps = {}, signal = null } = {}) {
    let lastSaid = 0;
    for (;;) {
        const q = look(ticket, { dir, deps });
        if (!q.job) throw new Error(`test-slot: no ticket ${ticket} (finished jobs are kept for the last ${KEEP_DONE})`);
        if (!["queued", "running"].includes(q.job.state)) {
            if (tail && q.job.log) { try { log(fs.readFileSync(q.job.log, "utf8").split("\n").slice(-tail).join("\n")); } catch { /* no log */ } }
            return q.job;
        }
        if (signal?.aborted) throw signal.reason;
        if (q.job.state === "queued" && Date.now() - lastSaid >= 30_000) { log(waitingLine(q)); lastSaid = Date.now(); }
        await sleep(pollMs());
    }
}

/** The body of a detached job: run the ticket's command with its output in the log, then record how it ended. */
async function runJob(ticket) {
    const dir = slotDir();
    const { job } = look(ticket, { dir });
    if (!job || job.state !== "running") return;
    const fd = fs.openSync(job.log, "a");
    fs.writeSync(fd, `test-slot: ${ticket} in ${job.cwd} at ${job.head ?? "?"}${job.dirty ? ` (dirty ${job.dirty})` : ""}: ${cmdText(job.cmd)}\n${grantLine(job)}\n\n`);
    const peak = samplePeak();
    const child = spawn(job.cmd[0], job.cmd.slice(1), { cwd: job.cwd, env: { ...process.env, TEST_SLOT_TICKET: ticket, TEST_SLOT_JOBS: String(job.jobs) }, stdio: ["ignore", fd, fd] });
    const code = await new Promise((r) => { child.on("error", (e) => { fs.writeSync(fd, `test-slot: could not start: ${e.message}\n`); r(127); }); child.on("exit", (c, s) => r(c ?? (s ? 128 : 1))); });
    fs.writeSync(fd, `\ntest-slot: exit ${code}\n`);
    fs.closeSync(fd);
    finish(ticket, code, { dir, peak: peak() });
}

function printStatus(dir = slotDir()) {
    const { state } = withQueue(dir, () => undefined);
    const row = (j) => `  ${j.ticket}  ${j.state.padEnd(9)} ${j.kind.padEnd(4)} ${j.mode.padEnd(8)} ${home(j.clone)}  ${cmdText(j.cmd)}`;
    const running = state.jobs.filter((j) => j.state === "running"), queued = state.jobs.filter((j) => j.state === "queued");
    const done = state.jobs.filter((j) => !["queued", "running"].includes(j.state)).slice(-10);
    console.log(running.length ? `running:\n${running.map((j) => `${row(j)}  pid ${j.pid}, ${j.jobs} workers, ${age(j.grantedAt)}`).join("\n")}` : "running: nothing");
    console.log(queued.length ? `queued:${state.waiting?.why ? ` (${state.waiting.why})` : ""}\n${queued.map((j) => `${row(j)}  waiting ${age(j.submittedAt)}`).join("\n")}` : "queued: nothing");
    if (done.length) console.log(`finished:\n${done.map((j) => `${row(j)}  exit ${j.exit ?? "-"}${j.durationMs ? `, ${Math.round(j.durationMs / 1000)}s` : ""}`).join("\n")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
    const [op, ...rest] = process.argv.slice(2);
    const dash = rest.indexOf("--"), cmd = dash >= 0 ? rest.slice(dash + 1) : [];
    const opts = dash >= 0 ? rest.slice(0, dash) : rest;
    const kind = opts.includes("--kind") ? opts[opts.indexOf("--kind") + 1] : "unit";
    const wArg = opts.includes("--workers") ? opts[opts.indexOf("--workers") + 1] ?? "" : null;
    const workers = wArg == null ? 1 : /^\d+$/.test(wArg) ? Number(wArg) : 0;
    if (op === "__job") await runJob(rest[0]);
    else if (op === "submit" || op === "run") {
        if (!cmd.length) { console.error(`usage: test-slot.mjs ${op} [--kind unit|e2e|batch [--workers N]] -- <command…>`); process.exit(2); }
        if (wArg != null && (kind !== "batch" || workers < 1 || workers > BATCH_MAX_WORKERS)) { console.error(`test-slot.mjs: --workers is for --kind batch only, an integer from 1 to ${BATCH_MAX_WORKERS}`); process.exit(2); }
        if (op === "submit") {
            const { ticket, shared, refused } = submit({ cmd, kind, workers });
            if (refused) { console.error(`test-slot.mjs: refused: ${refused}`); process.exit(2); }
            console.log(`${ticket}${shared ? "  (the same tree and command was already queued: sharing its run)" : ""}\nwait: node scripts/test-slot.mjs wait ${ticket}\nlog:  ${path.join(slotDir(), `${ticket}.log`)}`);
        } else {
            const { jobs } = await acquire({ cmd, kind, workers }).catch((e) => { if (e.code !== "TEST_SLOT_REFUSED") throw e; console.error(e.message.replace("test-slot:", "test-slot.mjs:")); process.exit(2); });
            const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, ...(jobs ? { TEST_SLOT_JOBS: String(jobs) } : {}) } });
            child.on("exit", (c, s) => { process.exitCode = c ?? (s ? 128 : 1); });
        }
    } else if (op === "wait" && rest[0]) {
        const job = await waitFor(rest[0]);
        console.error(`test-slot: ${job.ticket} ${job.state}${job.exit != null ? `, exit ${job.exit}` : ""}`);
        process.exit(job.state === "done" ? (job.exit ?? 1) : 1);
    } else if (op === "cancel" && rest[0]) {
        const was = cancel(rest[0]);
        console.log(was ? `cancelled ${rest[0]} (was ${was})` : `no queued or running job ${rest[0]}`);
    } else if (op === "status") printStatus();
    else { console.error("usage: test-slot.mjs submit|run [--kind unit|e2e|batch [--workers N]] -- <command…> | wait <ticket> | status | cancel <ticket>"); process.exit(2); }
}
