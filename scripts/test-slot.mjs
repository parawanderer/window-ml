#!/usr/bin/env node
// test-slot.mjs — one test run on this machine at a time: a QUEUE that every local test runner goes through (every
// scripts/test.mjs spawn, Playwright, `npm run coverage`), shared by every clone and every session, which sizes each
// run's workers from the memory free when its turn comes.
//
//   node scripts/test-slot.mjs submit [--kind unit|e2e] -- <command…>   queue a DETACHED job; prints its ticket, returns at once
//   node scripts/test-slot.mjs wait <ticket>                            block until it ends; its log's tail, its exit code
//   node scripts/test-slot.mjs status                                   what runs, what waits, the last finished jobs
//   node scripts/test-slot.mjs cancel <ticket>                          take a job out of the queue, or stop it
//   node scripts/test-slot.mjs run [--kind unit|e2e] -- <command…>      wait for the slot in the FOREGROUND, then run it here
//
// Why: on 2026-11-08 nine `node --import tsx --test` runners from different sessions ran at once, 34 workers between
// them, and the laptop swapped 27 GB; a suite that takes 40 s alone ran for ten minutes. A rule each lane had to
// remember did not hold, so the runners themselves queue.
//
// Two kinds of job share the one slot. An ATTACHED job is a runner waiting in its own process (`npm test`, a genre,
// Playwright's main process): it keeps its terminal and exit code, and holds the slot until it exits. A DETACHED job
// (`submit`) runs in a process of its own, in the ticket's cwd with the ticket's recorded environment, so it outlives
// the session that asked for it; its output goes to `<ticket>.log`. There is no daemon: whoever finds the slot free
// starts the head of the queue (a job ending, a submit, a `wait` or `status` poll, a waiting runner's poll), and a
// holder whose process has died is reclaimed on every read, so a queue never sits idle while anything waits on it.
//
// CI skips it (`CI` or `GITHUB_ACTIONS`: the runner is a VM whose only job is the suite), so does `TEST_SLOT=off`, and a
// runner started INSIDE a job (`TEST_SLOT_TICKET` set) runs at once. It only covers clones that have pulled it.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alive, availableMemory, fmtBytes, p90, processTable, RESERVE_FRAC, treePids, treeRss, withFileLock } from "../tests/e2e/bench/memory-budget.mjs";

const SELF = fileURLToPath(import.meta.url);
const GB = 1024 ** 3;
/** What one worker is assumed to take before any run was measured: a node:test file process or a Chromium. */
export const PER_WORKER_DEFAULT = GB;
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

/** The most workers a kind may have here: test.mjs's cores − 2 (at most 8), Playwright's half the cores. */
export const capFor = (kind, cores = os.cpus().length) => (kind === "e2e" ? Math.max(1, Math.floor(cores / 2)) : Math.min(8, Math.max(1, cores - 2)));

/** The per-worker figure for a kind: the p90 of its measured runs, or the default with none. */
export function perWorkerFor(kind, dir = slotDir()) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, "footprints.jsonl"), "utf8").split("\n").filter(Boolean); } catch { /* none yet */ }
    const mine = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((f) => f?.kind === kind).slice(-FOOTPRINTS_USED);
    const v = p90(mine.map((f) => f.perWorker));
    return { bytes: v ?? PER_WORKER_DEFAULT, measured: mine.length };
}

/** The memory reading a grant is made from, and the workers it gives (injected in tests). */
function sizeJob(kind, dir, memory) {
    const m = memory ? memory(kind) : { available: availableMemory(), total: os.totalmem(), perWorker: perWorkerFor(kind, dir).bytes, cap: capFor(kind) };
    return { ...m, jobs: jobsFor(m) };
}

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

/** Start the queue's head job if nothing runs: an attached one is GRANTED (its runner sees it and goes), a detached
 *  one is spawned. Returns the started record or null. */
export function startNext(state, dir, deps = {}) {
    if (state.jobs.some((j) => j.state === "running")) return null;
    const head = state.jobs.find((j) => j.state === "queued");
    if (!head) return null;
    const size = sizeJob(head.kind, dir, deps.memory);
    Object.assign(head, { state: "running", grantedAt: new Date().toISOString(), jobs: size.jobs, sizing: { available: size.available, total: size.total, perWorker: size.perWorker } });
    if (head.mode === "attached") Object.assign(head, { pid: head.by.pid, started: head.by.started });
    else {
        const { pid, started } = (deps.spawnJob ?? spawnJob)(head, dir);
        Object.assign(head, { pid, started });
    }
    return head;
}

/** Start a detached job: this script's `__job` in the ticket's cwd with the ticket's environment, in a process group
 *  of its own, so it outlives whoever started it and `cancel` stops all of it. */
function spawnJob(job, dir) {
    const child = spawn(process.execPath, [SELF, "__job", job.ticket], { cwd: job.cwd, env: { ...job.env, TEST_SLOT_DIR: dir }, detached: true, stdio: "ignore" });
    child.unref();
    return { pid: child.pid, started: startTime(child.pid) };
}

/**
 * Put a job in the queue. A detached job with the same clone, command, head and working-tree hash as one still QUEUED
 * gets that one's ticket (`shared: true`): two sessions asking for the same check get one run.
 * @param {{ cmd: string[], cwd?: string, kind?: "unit" | "e2e", mode?: "attached" | "detached", env?: object, dir?: string, deps?: object, tree?: object }} o
 */
export function submit({ cmd, cwd = process.cwd(), kind = "unit", mode = "detached", env = process.env, dir = slotDir(env), deps = {}, tree = treeState(cwd) }) {
    const key = createHash("sha256").update(JSON.stringify([tree.clone, cmd, tree.head, tree.dirty])).digest("hex").slice(0, 16);
    const ticket = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
    const by = { pid: process.pid, started: (deps.startTime ?? startTime)(process.pid) };
    const { out, reaped } = withQueue(dir, (state) => {
        const same = mode === "detached" && state.jobs.find((j) => j.state === "queued" && j.mode === "detached" && j.key === key);
        if (same) return { job: same, shared: true };
        const job = { ticket, mode, kind, cmd, cwd, key, clone: tree.clone, head: tree.head, dirty: tree.dirty, by, state: "queued", submittedAt: new Date().toISOString(),
            ...(mode === "detached" ? { env: jobEnv(env), log: path.join(dir, `${ticket}.log`) } : {}) };
        state.jobs.push(job);
        return { job, shared: false };
    }, deps);
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
    if (rec?.peakRss && rec.durationMs >= MEASURE_MIN_MS && rec.jobs) {
        try { fs.appendFileSync(path.join(dir, "footprints.jsonl"), `${JSON.stringify({ at: rec.endedAt, kind: rec.kind, jobs: rec.jobs, peakRss: rec.peakRss, perWorker: Math.round(rec.peakRss / rec.jobs), ticket })}\n`); } catch { /* unmeasured */ }
    }
    return rec;
}

/** Look at the queue (reaping and starting on the way, so a poll keeps it moving): the job, what runs, what is ahead of it. */
export function look(ticket, { dir = slotDir(), deps = {} } = {}) {
    const { state, reaped, started } = withQueue(dir, () => undefined, deps);
    const job = state.jobs.find((j) => j.ticket === ticket) ?? null;
    const running = state.jobs.find((j) => j.state === "running") ?? null;
    const queued = state.jobs.filter((j) => j.state === "queued");
    return { job, running, ahead: job ? queued.indexOf(job) : -1, queued, state, reaped, started };
}

const home = (p) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const age = (iso, now = Date.now()) => { const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`; };
const cmdText = (cmd) => cmd.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ").replace(process.execPath, "node").slice(0, 120);

/** The line a waiting runner prints: who holds the slot, since when, and how many are ahead. */
export function waitingLine({ running, ahead }, now = Date.now()) {
    const who = running ? `pid ${running.pid} (${home(running.clone)}, ${cmdText(running.cmd)}, ${running.jobs} worker${running.jobs === 1 ? "" : "s"}, held ${age(running.grantedAt, now)})` : "the slot to free";
    return `test-slot: waiting for ${who}; ${ahead} ahead of you`;
}

/** The line a granted run prints: its workers and the reading they came from. */
export const grantLine = (job) => `test-slot: ${job.jobs} worker${job.jobs === 1 ? "" : "s"} (${fmtBytes(job.sizing.available)} available, ${fmtBytes(RESERVE_FRAC * job.sizing.total)} reserved, ~${fmtBytes(job.sizing.perWorker)} per worker)`;

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
 * @param {{ cmd: string[], cwd?: string, kind?: "unit" | "e2e", log?: (s: string) => void, env?: object }} o
 */
export async function acquire({ cmd, cwd = process.cwd(), kind = "unit", log = (s) => console.error(s), env = process.env }) {
    const skipped = skipReason(env);
    if (skipped) {
        if (skipped === "off") log("test-slot: TEST_SLOT=off, not queueing: other runs on this machine are not waited for");
        return { jobs: Number(env.TEST_SLOT_JOBS) || null, skipped };
    }
    const dir = slotDir(env);
    const { ticket, reaped } = submit({ cmd, cwd, kind, mode: "attached", env, dir });
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
        Object.assign(j, { state: "cancelled", endedAt: new Date().toISOString(), exit: null });
    }, deps);
    return was;
}

/** Block until a job ends, starting the queue's head whenever it finds the slot free; prints the waiting line, then
 *  the log's last lines. Resolves the job's record. */
export async function waitFor(ticket, { dir = slotDir(), log = (s) => console.error(s), tail = 40, deps = {} } = {}) {
    let lastSaid = 0;
    for (;;) {
        const q = look(ticket, { dir, deps });
        if (!q.job) throw new Error(`test-slot: no ticket ${ticket} (finished jobs are kept for the last ${KEEP_DONE})`);
        if (!["queued", "running"].includes(q.job.state)) {
            if (tail && q.job.log) { try { log(fs.readFileSync(q.job.log, "utf8").split("\n").slice(-tail).join("\n")); } catch { /* no log */ } }
            return q.job;
        }
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
    console.log(queued.length ? `queued:\n${queued.map((j) => `${row(j)}  waiting ${age(j.submittedAt)}`).join("\n")}` : "queued: nothing");
    if (done.length) console.log(`finished:\n${done.map((j) => `${row(j)}  exit ${j.exit ?? "-"}${j.durationMs ? `, ${Math.round(j.durationMs / 1000)}s` : ""}`).join("\n")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
    const [op, ...rest] = process.argv.slice(2);
    const dash = rest.indexOf("--"), cmd = dash >= 0 ? rest.slice(dash + 1) : [];
    const opts = dash >= 0 ? rest.slice(0, dash) : rest;
    const kind = opts.includes("--kind") ? opts[opts.indexOf("--kind") + 1] : "unit";
    if (op === "__job") await runJob(rest[0]);
    else if (op === "submit" || op === "run") {
        if (!cmd.length) { console.error(`usage: test-slot.mjs ${op} [--kind unit|e2e] -- <command…>`); process.exit(2); }
        if (op === "submit") {
            const { ticket, shared } = submit({ cmd, kind });
            console.log(`${ticket}${shared ? "  (the same tree and command was already queued: sharing its run)" : ""}\nwait: node scripts/test-slot.mjs wait ${ticket}\nlog:  ${path.join(slotDir(), `${ticket}.log`)}`);
        } else {
            const { jobs } = await acquire({ cmd, kind });
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
    else { console.error("usage: test-slot.mjs submit|run [--kind unit|e2e] -- <command…> | wait <ticket> | status | cancel <ticket>"); process.exit(2); }
}
