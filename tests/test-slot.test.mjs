// The machine-wide test queue (scripts/test-slot.mjs): one run at a time, workers from free memory, a dead holder
// reclaimed, detached jobs that outlive their submitter. Every test uses its own queue folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLOT = path.join(ROOT, "scripts", "test-slot.mjs");
const { jobsFor, capFor, skipReason, submit, finish, look, cancel, waitFor, acquire, waitingLine, jobEnv, procLive, startTime, perWorkerFor } = await import(SLOT);

process.env.TEST_SLOT_POLL_MS = "50";
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

test("a holder whose process has died is reclaimed and the next run is granted at once", async () => {
    const dir = tmpDir(), dead = deadPid(), said = [];
    assert.equal(procLive(dead, null), false);
    writeQueue(dir, [holder(dead, "Sat Nov  7 00:00:00 2026")]);
    const r = await acquire({ cmd: ["me"], env: { TEST_SLOT_DIR: dir }, log: (s) => said.push(s) });
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
    assert.match(waitingLine(qb), /^test-slot: waiting for pid \d+ \(\/other, x, 2 workers, held \d+s\); 1 ahead of you$/);
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

test("a running job killed from outside: a waiter's poll reclaims the slot and starts the next job", async () => {
    const dir = tmpDir(), never = path.join(dir, "never");
    const a = submit({ cmd: waitsFor(never), cwd: ROOT, dir });
    const b = submit({ cmd: quick(0), cwd: ROOT, dir });
    await until(() => look(a.ticket, { dir }).job.pid, 5000, "a to start");
    const waiting = waitFor(b.ticket, { dir, log: () => {} });
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
