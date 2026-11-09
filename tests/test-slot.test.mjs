// The machine-wide test queue (scripts/test-slot.mjs): a few runs at once under a memory budget, workers from free
// memory, a dead holder reclaimed, detached jobs that outlive their submitter. Every test uses its own queue folder.
// The tests from "who skips" on run with TEST_SLOT_MAX_RUNS=1 (one at a time); admission's own tests pass `maxRuns`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLOT = path.join(ROOT, "scripts", "test-slot.mjs");
// The bench's ledger, which a granted job joins: this file's own, set before the import reads it.
process.env.BENCH_LEDGER_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "test-slot-ledger-")), "ledger.json");
const { ledger, register, unregister } = await import("../tests/e2e/bench/memory-budget.mjs");
const { jobsFor, capFor, skipReason, submit, finish, look, cancel, waitFor, acquire, waitingLine, jobEnv, procLive, startTime, perWorkerFor, admit, minWorkersFor, maxWorkersFor, promisedBy, MAX_RUNS } = await import(SLOT);

process.env.TEST_SLOT_POLL_MS = "50";
process.env.TEST_SLOT_MAX_RUNS = "1";
const GB = 1024 ** 3;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "test-slot-"));
const memory = () => ({ available: 16 * GB, total: 32 * GB, perWorker: GB, cap: 4 });
const tree = (dirty = null) => ({ clone: "/c", head: "abc", dirty });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A pid that existed and has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout.trim() * 1;
const writeQueue = (dir, jobs) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify({ jobs })); };
const holder = (pid, started, extra = {}) => ({ ticket: "held", mode: "attached", kind: "unit", cmd: ["x"], cwd: "/", key: "k0", clone: "/other", by: { pid, started }, state: "running", pid, started, grantedAt: new Date().toISOString(), jobs: 2, ...extra });
/** Until `pred()` holds, or fail after `ms`. */
async function until(pred, ms = 10_000, what = "condition") {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await pred()) return;
    assert.fail(`timed out waiting for ${what}`);
}

// --- how many workers a run gets ---

test("jobsFor: free memory above the 25% reserve, per worker, between 1 and the cap", () => {
    const total = 32 * GB;
    // Enumerated over available × perWorker × cap, against the formula written out.
    for (const available of [0, 4 * GB, 8 * GB, 8.5 * GB, 12 * GB, 20 * GB, 32 * GB]) {
        for (const perWorker of [0.5 * GB, GB, 1.7 * GB, 4 * GB]) {
            for (const cap of [1, 3, 8]) {
                const want = Math.max(1, Math.min(cap, Math.floor((available - 8 * GB) / perWorker)));
                assert.equal(jobsFor({ available, total, perWorker, cap }), want, `${available / GB} GB free, ${perWorker / GB} GB each, cap ${cap}`);
            }
        }
    }
    assert.equal(jobsFor({ available: 0, total, cap: 8 }), 1, "a machine under pressure still gets one worker");
    assert.equal(jobsFor({ available: total, total, cap: 8 }), 8, "the cap holds with room to spare");
    assert.equal(jobsFor({ available: 11 * GB, total, cap: 8 }), 3, "the default per-worker figure is 1 GB");
});

test("capFor: test.mjs's cores − 2 at most 8, Playwright's half the cores, never 0", () => {
    assert.deepEqual([1, 2, 4, 10, 16].map((c) => capFor("unit", c)), [1, 1, 2, 8, 8]);
    assert.deepEqual([1, 2, 4, 10, 16].map((c) => capFor("e2e", c)), [1, 1, 2, 5, 8]);
});

test("perWorkerFor: the p90 of the kind's last measured runs, else 1 GB", () => {
    const dir = tmpDir();
    assert.deepEqual(perWorkerFor("unit", dir), { bytes: GB, measured: 0 });
    const lines = [...Array(10)].map((_, i) => ({ kind: "unit", perWorker: (i + 1) * 100 })).concat([{ kind: "e2e", perWorker: 9e9 }]);
    fs.writeFileSync(path.join(dir, "footprints.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    assert.deepEqual(perWorkerFor("unit", dir), { bytes: 900, measured: 10 });
    assert.deepEqual(perWorkerFor("e2e", dir), { bytes: 9e9, measured: 1 });
});

// --- admission: a few runs at once under the budget ---

/** This laptop's shape: 24 GB, 15 cores (13 workers between runs), `available` free; a fixed per-worker figure. */
const laptop = (available, { perWorker = GB, cap = 8, e2e = {} } = {}) => ({
    memory: () => ({ available, coming: 0, total: 24 * GB, cores: 15 }),
    kind: (k) => (k === "e2e" ? { perWorker, cap: 7, ...e2e } : { perWorker, cap }),
    maxRuns: MAX_RUNS, resident: () => 0, startTime: () => startTime(process.pid),
});
const states = (dir, tickets, deps) => tickets.map((t) => look(t, { dir, deps }).job.state);

test("admit: the rule written out, enumerated over runs, workers, room and kind", () => {
    const maxWorkers = 13;
    for (const kind of ["unit", "e2e"]) {
        for (const running of [0, 1, 2, 3, 4]) {
            for (const workers of [0, 5, 11, 12, 13]) {
                for (const room of [-2 * GB, 0, 0.9 * GB, 1.5 * GB, 2 * GB, 6.5 * GB, 30 * GB]) {
                    const perWorker = GB, cap = 8, min = kind === "e2e" ? 1 : 2, left = maxWorkers - workers, fit = Math.floor(room / perWorker);
                    const want = running === 0 ? Math.max(1, Math.min(cap, left, fit))
                        : running >= 3 || left < min || fit < min ? 0 : Math.min(cap, left, fit);
                    const got = admit({ kind, running, workers, room, perWorker, cap, maxWorkers });
                    assert.equal(got.jobs, want, `${kind}, ${running} running with ${workers} workers, ${room / GB} GB room`);
                    assert.equal(!!got.why, want === 0);
                }
            }
        }
    }
    assert.deepEqual([minWorkersFor("unit"), minWorkersFor("e2e"), maxWorkersFor(15), maxWorkersFor(2), MAX_RUNS], [2, 1, 13, 1, 3]);
    assert.equal(admit({ kind: "unit", running: 0, workers: 0, room: -5 * GB, perWorker: GB, cap: 8, maxWorkers: 13 }).jobs, 1, "alone, a run always starts");
});

test("three runs start together under the budget; a fourth waits on the cap and starts when one ends", () => {
    const dir = tmpDir(), deps = laptop(20 * GB, { cap: 4 });
    const t = ["a", "b", "c", "d"].map((c) => submit({ cmd: [c], mode: "attached", dir, deps, tree: tree() }).ticket);
    assert.deepEqual(states(dir, t, deps), ["running", "running", "running", "queued"]);
    const q = look(t[3], { dir, deps });
    assert.deepEqual(q.running.map((j) => j.jobs), [4, 4, 4], "20 GB less the 6 GB reserve is room for 14 workers; each takes its cap");
    assert.equal(q.why, "3 runs at once already (at most 3)");
    assert.match(waitingLine(q), /^test-slot: waiting for pid \d+ .* and pid \d+ .* and pid \d+ .*\(3 runs at once already \(at most 3\)\); 0 ahead of you$/);
    assert.deepEqual(q.running.map((j) => [j.sizing.runs, j.sizing.workers]), [[1, 4], [2, 8], [3, 12]]);
    finish(t[0], 0, { dir, deps });
    assert.deepEqual(states(dir, t, deps), ["done", "running", "running", "running"]);
    assert.equal(look(t[3], { dir, deps }).job.jobs, 4, "14 GB of room less the two running runs' 8 GB: 6 workers, 5 of 13 left, a cap of 4");
});

test("the worker cap: runs together never have more than cores − 2 workers", () => {
    const dir = tmpDir(), deps = laptop(23 * GB, { perWorker: 0.1 * GB });
    const t = ["a", "b", "c"].map((c) => submit({ cmd: [c], mode: "attached", dir, deps, tree: tree() }).ticket);
    const q = look(t[2], { dir, deps });
    assert.deepEqual([...q.running.map((j) => j.jobs), q.job.state], [8, 5, "queued"]);
    assert.equal(q.why, "the running runs have 13 of 13 workers");
});

test("one pass counts the workers it has just granted: three queued jobs, one look, 8 and 5 of 13", () => {
    const dir = tmpDir(), one = { ...laptop(40 * GB), maxRuns: 1 };
    const t = ["a", "b", "c", "d"].map((c) => submit({ cmd: [c], mode: "attached", dir, deps: one, tree: tree() }).ticket);
    assert.deepEqual(states(dir, t, one), ["running", "queued", "queued", "queued"]);
    const deps = laptop(40 * GB);
    finish(t[0], 0, { dir, deps });
    const q = look(t[3], { dir, deps });
    assert.deepEqual([...q.running.map((j) => j.jobs), q.job.state], [8, 5, "queued"], "the second start sees the first one's 8 workers");
    assert.equal(q.why, "the running runs have 13 of 13 workers");
});

test("the budget full: a second run waits for memory; alone, a run starts on what there is", () => {
    const dir = tmpDir(), deps = laptop(9 * GB);
    const [a, b] = ["a", "b"].map((c) => submit({ cmd: [c], mode: "attached", dir, deps, tree: tree() }).ticket);
    assert.deepEqual(states(dir, [a, b], deps), ["running", "queued"]);
    assert.equal(look(a, { dir, deps }).job.jobs, 3, "9 GB less the 6 GB reserve: 3 workers");
    assert.match(look(b, { dir, deps }).why, /^memory: 0 MB above the reserve, 2 workers take 2\.0 GB$/);
    const tight = laptop(2 * GB);
    finish(a, 0, { dir, deps: tight });
    assert.deepEqual([look(b, { dir, deps: tight }).job.state, look(b, { dir, deps: tight }).job.jobs], ["running", 1], "below the reserve, the head still starts on one worker");
});

test("what a running run planned counts until its workers hold it, and no further", () => {
    const run = (jobs, perWorker, pid) => ({ jobs, sizing: { perWorker }, pid });
    assert.equal(promisedBy([run(4, GB, 1), run(2, GB, 2)], (j) => (j.pid === 1 ? 3 * GB : 5 * GB)), GB, "1 GB still to come; the second run holds more than it planned");
    // A run that planned 6 GB and holds none of it yet leaves 8 GB of room; holding all of it, it leaves 8 GB too,
    // since free memory has then dropped by what it holds.
    const dir = tmpDir(), deps = { ...laptop(20 * GB), resident: () => 0 };
    writeQueue(dir, [holder(process.pid, startTime(process.pid), { jobs: 6, sizing: { perWorker: GB } })]);
    const b = submit({ cmd: ["b"], mode: "attached", dir, deps, tree: tree() });
    assert.equal(look(b.ticket, { dir, deps }).job.jobs, 7, "13 − 6 workers left; 8 GB of room");
    assert.equal(look(b.ticket, { dir, deps }).job.sizing.coming, 6 * GB);
});

test("FIFO among the admissible: a small e2e probe passes a waiting suite only while the suite cannot start", () => {
    const dir = tmpDir(), deps = laptop(13 * GB);
    const a = submit({ cmd: ["a"], mode: "attached", dir, deps, tree: tree() }).ticket;
    assert.equal(look(a, { dir, deps }).job.jobs, 7, "13 GB less the reserve: 7 workers, and nothing else fits a suite's 2");
    const suite = submit({ cmd: ["suite"], mode: "attached", dir, deps, tree: tree() }).ticket;
    const later = submit({ cmd: ["later"], mode: "attached", dir, deps, tree: tree() }).ticket;
    assert.deepEqual(states(dir, [suite, later], deps), ["queued", "queued"], "a unit run behind a waiting one does not pass it");
    // Room for one worker opens: the suite still cannot start, so the probe behind it may.
    const roomy = laptop(14.5 * GB);
    const probe = submit({ kind: "e2e", cmd: ["probe"], mode: "attached", dir, deps: roomy, tree: tree() }).ticket;
    assert.deepEqual(states(dir, [suite, later, probe], roomy), ["queued", "queued", "running"]);
    assert.equal(look(probe, { dir, deps: roomy }).job.jobs, 1);
    // When the suite fits, it goes first, and a probe queued behind it waits its turn.
    finish(probe, 0, { dir, deps: roomy });
    const probe2 = submit({ kind: "e2e", cmd: ["probe2"], mode: "attached", dir, deps: laptop(16 * GB), tree: tree() }).ticket;
    assert.deepEqual(states(dir, [suite, later, probe2], laptop(16 * GB)), ["running", "queued", "queued"]);
    assert.equal(look(suite, { dir, deps: laptop(16 * GB) }).job.jobs, 3);
});

test("a footprint records how many runs shared the machine with it", () => {
    const dir = tmpDir(), deps = laptop(20 * GB, { cap: 2 });
    const [a, b] = ["a", "b"].map((c) => submit({ cmd: [c], mode: "attached", dir, deps, tree: tree() }).ticket);
    const backdate = (t) => { const s = JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8")); s.jobs.find((j) => j.ticket === t).grantedAt = new Date(Date.now() - 60_000).toISOString(); fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(s)); };
    backdate(a);
    finish(a, 0, { dir, deps, peak: 2 * GB });
    finish(b, 0, { dir, deps, peak: 2 * GB });
    const lines = fs.readFileSync(path.join(dir, "footprints.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((f) => [f.ticket, f.runs, f.perWorker]), [[a, 2, GB]], "b ran under 10 s: not measured");
    const c = submit({ cmd: ["c"], mode: "attached", dir, deps, tree: tree() }).ticket;
    backdate(c);
    finish(c, 0, { dir, deps, peak: GB });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "footprints.jsonl"), "utf8").trim().split("\n")[1]).runs, 1);
});

// --- who skips the queue ---

test("skipReason: CI, GITHUB_ACTIONS, TEST_SLOT=off and a run inside a job skip; nothing else does", () => {
    assert.equal(skipReason({ CI: "true" }), "ci");
    assert.equal(skipReason({ GITHUB_ACTIONS: "true" }), "ci");
    assert.equal(skipReason({ TEST_SLOT: "off" }), "off");
    assert.equal(skipReason({ TEST_SLOT_TICKET: "t" }), "nested");
    assert.equal(skipReason({}), null);
    assert.equal(skipReason({ TEST_SLOT: "on" }), null);
});

test("acquire: a skipped run writes no queue, and a nested one takes its job's workers", async () => {
    const dir = tmpDir(), said = [];
    for (const env of [{ CI: "true" }, { TEST_SLOT: "off" }, { TEST_SLOT_TICKET: "t", TEST_SLOT_JOBS: "3" }]) {
        const r = await acquire({ cmd: ["x"], env: { ...env, TEST_SLOT_DIR: dir }, log: (s) => said.push(s) });
        assert.equal(r.ticket, undefined);
        assert.equal(r.jobs, env.TEST_SLOT_JOBS ? 3 : null);
    }
    assert.equal(fs.existsSync(path.join(dir, "queue.json")), false);
    assert.equal(said.length, 1, "only TEST_SLOT=off says it skipped");
    assert.match(said[0], /TEST_SLOT=off/);
});

test("jobEnv: a detached job gets the named variables and none named like a secret", () => {
    const env = jobEnv({ PATH: "/bin", HOME: "/h", E2E_MODEL: "m", E2E_KEY: "k", BENCH_X: "1", OPENAI_API_KEY: "k", GH_TOKEN: "t", RANDOM: "r", TEST_SLOT_TICKET: "t" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h", E2E_MODEL: "m", BENCH_X: "1" });
});

// --- reclaiming a dead holder ---

test("a holder whose process has died is reclaimed and the next run is granted at once", { timeout: 10_000 }, async (t) => {
    const dir = tmpDir(), dead = deadPid(), said = [];
    assert.equal(procLive(dead, null), false);
    writeQueue(dir, [holder(dead, "Sat Nov  7 00:00:00 2026")]);
    const r = await acquire({ cmd: ["me"], env: { TEST_SLOT_DIR: dir }, log: (s) => said.push(s), signal: t.signal });
    assert.equal(typeof r.ticket, "string");
    assert.ok(said.some((s) => s.includes(`reclaimed the slot from pid ${dead}`)), said.join("\n"));
    const q = look(r.ticket, { dir });
    assert.equal(q.job.state, "running");
    assert.equal(q.job.pid, process.pid);
    assert.equal(q.state.jobs.find((j) => j.ticket === "held").state, "lost");
    finish(r.ticket, 0, { dir });
    delete process.env.TEST_SLOT_TICKET; delete process.env.TEST_SLOT_JOBS;
});

test("a holder's pid reused by another process is reclaimed: the start time does not match", () => {
    const dir = tmpDir();
    writeQueue(dir, [holder(process.pid, "Mon Jan  1 00:00:00 2001")]);
    const q = look("held", { dir, deps: { memory } });
    assert.equal(q.job.state, "lost");
    assert.equal(q.reaped.length, 1);
    writeQueue(dir, [holder(process.pid, startTime(process.pid))]);
    assert.equal(look("held", { dir, deps: { memory } }).job.state, "running", "the real holder is kept");
});

// --- the queue's order ---

test("attached runs are granted in FIFO order, one at a time; the waiting line names the holder", () => {
    const dir = tmpDir(), deps = { memory, startTime: () => startTime(process.pid) };
    writeQueue(dir, [holder(process.pid, startTime(process.pid))]);
    const a = submit({ cmd: ["a"], mode: "attached", dir, deps, tree: tree() });
    const b = submit({ cmd: ["b"], mode: "attached", dir, deps, tree: tree() });
    let qa = look(a.ticket, { dir, deps }), qb = look(b.ticket, { dir, deps });
    assert.deepEqual([qa.job.state, qa.ahead, qb.job.state, qb.ahead], ["queued", 0, "queued", 1]);
    assert.match(waitingLine(qb), /^test-slot: waiting for pid \d+ \(\/other, x, 2 workers, held \d+s\) \(1 run at once already \(at most 1\)\); 1 ahead of you$/);
    finish("held", 0, { dir, deps });
    qa = look(a.ticket, { dir, deps }); qb = look(b.ticket, { dir, deps });
    assert.deepEqual([qa.job.state, qa.job.jobs, qb.job.state, qb.ahead], ["running", 4, "queued", 0]);
    finish(a.ticket, 0, { dir, deps });
    assert.equal(look(b.ticket, { dir, deps }).job.state, "running");
});

test("a queued attached run whose runner died is dropped, not granted", () => {
    const dir = tmpDir(), dead = deadPid();
    writeQueue(dir, [holder(process.pid, startTime(process.pid)), { ...holder(dead, "x"), ticket: "gone", state: "queued", pid: undefined }]);
    finish("held", 0, { dir, deps: { memory } });
    assert.equal(look("gone", { dir }).job.state, "abandoned");
});

test("a detached job is shared only while queued, and only for the same clone, command, head and tree", () => {
    const dir = tmpDir(), deps = { memory, spawnJob: () => ({ pid: process.pid, started: startTime(process.pid) }) };
    writeQueue(dir, [holder(process.pid, startTime(process.pid))]);
    const one = submit({ cmd: ["npm", "test"], dir, deps, tree: tree() });
    assert.deepEqual(submit({ cmd: ["npm", "test"], dir, deps, tree: tree() }), { ticket: one.ticket, shared: true, reaped: [] });
    assert.equal(submit({ cmd: ["npm", "test"], dir, deps, tree: tree("d1") }).shared, false, "an edited tree is a new run");
    assert.equal(submit({ cmd: ["npm", "test"], dir, deps, tree: { ...tree(), head: "def" } }).shared, false, "another head is a new run");
    assert.equal(submit({ cmd: ["npm", "test"], dir, deps, tree: { ...tree(), clone: "/d" } }).shared, false, "another clone is a new run");
    assert.equal(submit({ cmd: ["npm", "test", "core"], dir, deps, tree: tree() }).shared, false);
    finish("held", 0, { dir, deps });
    assert.equal(look(one.ticket, { dir, deps }).job.state, "running");
    assert.equal(submit({ cmd: ["npm", "test"], dir, deps, tree: tree() }).shared, false, "once it runs, a new submit queues again");
});

// --- detached jobs, with real processes ---

/** A command that waits for `file` to exist, then exits with `code`. */
const waitsFor = (file, code = 0) => [process.execPath, "-e", `const f=${JSON.stringify(file)};const t=setInterval(()=>{if(require("fs").existsSync(f)){clearInterval(t);process.exit(${code})}},20)`];
const quick = (code) => [process.execPath, "-e", `console.log("job says ${code}");process.exit(${code})`];

test("submit returns before the job runs; jobs run one at a time in order and record their exit codes", async () => {
    const dir = tmpDir(), gate = path.join(dir, "go");
    const a = submit({ cmd: waitsFor(gate), cwd: ROOT, dir });
    const b = submit({ cmd: quick(3), cwd: ROOT, dir });
    const c = submit({ cmd: quick(0), cwd: ROOT, dir });
    await until(() => look(a.ticket, { dir }).job.pid, 5000, "a to start");
    assert.equal(look(a.ticket, { dir }).job.state, "running", "a waits on its gate, so submit did not wait for it");
    assert.deepEqual([look(b.ticket, { dir }).job.state, look(c.ticket, { dir }).job.state], ["queued", "queued"]);
    fs.writeFileSync(gate, "");
    const jc = await waitFor(c.ticket, { dir, log: () => {} });
    const jb = look(b.ticket, { dir }).job, ja = look(a.ticket, { dir }).job;
    assert.deepEqual([ja.exit, jb.exit, jc.exit], [0, 3, 0]);
    assert.ok(ja.endedAt <= jb.grantedAt && jb.endedAt <= jc.grantedAt, "one at a time, in order");
    assert.match(fs.readFileSync(jb.log, "utf8"), /job says 3[\s\S]*test-slot: exit 3/);
    assert.equal(jb.head.length, 40, "the record names the head it ran at");
});

test("a detached job outlives the process that submitted it", async () => {
    const dir = tmpDir(), env = { ...process.env, TEST_SLOT_DIR: dir };
    delete env.TEST_SLOT_TICKET;
    const r = spawnSync(process.execPath, [SLOT, "submit", "--", ...quick(5)], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const ticket = r.stdout.split("\n")[0].trim();
    const job = await waitFor(ticket, { dir, log: () => {} });
    assert.deepEqual([job.state, job.exit], ["done", 5]);
});

test("cancel: a queued job is taken out, a running one's process group is stopped and the next starts", async () => {
    const dir = tmpDir(), never = path.join(dir, "never");
    const a = submit({ cmd: waitsFor(never), cwd: ROOT, dir });
    const b = submit({ cmd: waitsFor(never), cwd: ROOT, dir });
    const c = submit({ cmd: quick(0), cwd: ROOT, dir });
    await until(() => look(a.ticket, { dir }).job.pid, 5000, "a to start");
    assert.equal(cancel(b.ticket, { dir }), "queued");
    const pid = look(a.ticket, { dir }).job.pid;
    assert.equal(cancel(a.ticket, { dir }), "running");
    await until(() => { try { process.kill(-pid, 0); return false; } catch { return true; } }, 5000, "a's process group to end");
    assert.equal(look(b.ticket, { dir }).job.state, "cancelled");
    assert.deepEqual([(await waitFor(c.ticket, { dir, log: () => {} })).exit], [0]);
});

test("a running job killed from outside: a waiter's poll reclaims the slot and starts the next job", { timeout: 10_000 }, async (t) => {
    const dir = tmpDir(), never = path.join(dir, "never");
    const a = submit({ cmd: waitsFor(never), cwd: ROOT, dir });
    const b = submit({ cmd: quick(0), cwd: ROOT, dir });
    await until(() => look(a.ticket, { dir }).job.pid, 5000, "a to start");
    const waiting = waitFor(b.ticket, { dir, log: () => {}, signal: t.signal });
    process.kill(-look(a.ticket, { dir }).job.pid, "SIGKILL");
    const jb = await waiting;
    assert.deepEqual([jb.state, jb.exit], ["done", 0]);
    assert.equal(look(a.ticket, { dir }).job.state, "lost");
});

test("test.mjs inside a granted run is not queued behind it", async () => {
    const dir = tmpDir(), env = { ...process.env, TEST_SLOT_DIR: dir };
    delete env.TEST_SLOT_TICKET; delete env.TEST_SLOT_JOBS; delete env.CI; delete env.GITHUB_ACTIONS;
    // The outer run holds the slot; the inner test.mjs would wait for it forever if it queued.
    const outer = [SLOT, "run", "--", process.execPath, path.join(ROOT, "scripts", "test.mjs"), "--files", "no-such.test.mjs"];
    const r = await new Promise((res) => { const p = spawn(process.execPath, outer, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] }); let err = ""; p.stderr.on("data", (d) => (err += d)); const t = setTimeout(() => p.kill("SIGKILL"), 20_000); p.on("exit", (code) => { clearTimeout(t); res({ code, err }); }); });
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /no such test file\(s\): no-such\.test\.mjs/);
    assert.equal(r.err.match(/test-slot: \d+ workers?/g)?.length, 1, "one grant, the outer run's");
});

// --- sharing memory with the bench ---

test("a grant subtracts the browsers a sweep just admitted, joins the bench's ledger as `tests`, and leaves it when done", { timeout: 10_000 }, async (t) => {
    const dir = tmpDir(), said = [];
    // A sweep (another live process) that admitted 3 GB of browsers its tree does not hold yet.
    const sweep = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
        register({ kind: "runner", pid: sweep.pid, pending: [{ bytes: 3 * GB, until: Date.now() + 60_000 }, { bytes: 9 * GB, until: Date.now() - 1 }] });
        const r = await acquire({ cmd: ["me"], env: { TEST_SLOT_DIR: dir }, log: (s) => said.push(s), signal: t.signal });
        const job = look(r.ticket, { dir }).job;
        assert.equal(job.sizing.coming, 3 * GB, "the expired admission is not counted");
        assert.equal(job.jobs, jobsFor({ ...job.sizing, available: job.sizing.available - 3 * GB, cap: capFor("unit") }));
        assert.ok(said.some((l) => l.includes("3.0 GB of it promised to bench browsers and other test runs starting up")), said.join("\n"));
        const mine = ledger().find((e) => e.kind === "tests");
        assert.deepEqual([mine.pid, mine.ticket, mine.planned], [process.pid, r.ticket, job.jobs * job.sizing.perWorker]);
        finish(r.ticket, 0, { dir });
        assert.equal(ledger().some((e) => e.kind === "tests"), false, "a finished run leaves the ledger");
    } finally {
        unregister(sweep.pid); sweep.kill();
        delete process.env.TEST_SLOT_TICKET; delete process.env.TEST_SLOT_JOBS;
    }
});

test("a cancelled running job leaves the bench's ledger", () => {
    const dir = tmpDir(), deps = { memory, startTime: () => startTime(process.pid) };
    const a = submit({ cmd: ["a"], mode: "attached", dir, deps, tree: tree() });
    assert.equal(ledger().find((e) => e.kind === "tests")?.ticket, a.ticket);
    assert.equal(cancel(a.ticket, { dir, deps: { ...deps, probe: { alive: () => false, startTime } } }), "running");
    assert.equal(ledger().some((e) => e.kind === "tests"), false);
});
