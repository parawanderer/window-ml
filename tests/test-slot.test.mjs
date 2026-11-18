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
const { jobsFor, capFor, skipReason, submit, finish, look, cancel, waitFor, acquire, waitingLine, jobEnv, procLive, startTime, priceFor, classOf, priceIn, priceAt, priceOfSizing, fitIn, shapeOf, SHAPE_MAX, BASE_DEFAULT, SLOPE_DEFAULT, SLOPE_MIN, SLOPE_MAX, grantLine, admit, minWorkersFor, maxWorkersFor, promisedBy, MAX_RUNS, BATCH_OVERRUN_MS, BATCH_MAX_WORKERS, batchRefusal, usualMsFor, timeCapFor, enforceCap, parseMaxTime, TIME_CAP_MIN_MS, TIME_CAP_FACTOR, KILL_GRACE_MS, MAX_TIME_MAX_MIN } = await import(SLOT);

process.env.TEST_SLOT_POLL_MS = "50";
process.env.TEST_SLOT_MAX_RUNS = "1";
const GB = 1024 ** 3;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "test-slot-"));
const memory = () => ({ available: 16 * GB, total: 32 * GB, perWorker: GB, cap: 4, cores: 15 });
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

test("jobsFor: free memory above the 25% reserve, at base + slope a worker, between 1 and the cap", () => {
    const total = 32 * GB;
    // Enumerated over available × base × slope × cap, against the formula written out.
    for (const available of [0, 4 * GB, 8 * GB, 8.5 * GB, 12 * GB, 20 * GB, 32 * GB]) {
        for (const base of [0, GB, 2.5 * GB]) {
            for (const slope of [0.5 * GB, GB, 1.7 * GB]) {
                for (const cap of [1, 3, 8]) {
                    const want = Math.max(1, Math.min(cap, Math.floor((available - 8 * GB - base) / slope)));
                    assert.equal(jobsFor({ available, total, base, slope, cap }), Math.max(1, want < 0 ? 1 : want), `${available / GB} GB free, ${base / GB} + ${slope / GB} a worker, cap ${cap}`);
                }
            }
        }
    }
    assert.equal(jobsFor({ available: 0, total, cap: 8 }), 1, "a machine under pressure still gets one worker");
    assert.equal(jobsFor({ available: total, total, cap: 8 }), 8, "the cap holds with room to spare");
    assert.equal(jobsFor({ available: 11 * GB, total, cap: 8 }), 5, "the default price is 1 GB + 0.4 GB a worker: 3 GB of room is 5 workers");
    assert.deepEqual([BASE_DEFAULT, SLOPE_DEFAULT], [GB, 0.4 * GB]);
});

test("capFor: test.mjs's cores − 2 at most 8, Playwright's half the cores, never 0", () => {
    assert.deepEqual([1, 2, 4, 10, 16].map((c) => capFor("unit", c)), [1, 1, 2, 8, 8]);
    assert.deepEqual([1, 2, 4, 10, 16].map((c) => capFor("e2e", c)), [1, 1, 2, 5, 8]);
});

test("priceIn: reads the footprints file, skipping lines that do not parse and other kinds", () => {
    const dir = tmpDir();
    assert.deepEqual(priceIn("unit", null, dir), { base: GB, slope: 0.4 * GB, measured: 0, from: "default" });
    const lines = [...Array(10)].map((_, i) => ({ kind: "unit", jobs: 2, peakRss: (i + 1) * 100 })).concat([{ kind: "e2e", jobs: 2, peakRss: 9e9 }]);
    fs.writeFileSync(path.join(dir, "footprints.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    // One worker count: the default slope; the base is the p90 of max(0, peak − 0.4 GB × 2): all under it.
    assert.deepEqual(priceIn("unit", null, dir), { base: 0, slope: 0.4 * GB, measured: 10, from: "kind" });
    assert.deepEqual(priceIn("e2e", null, dir), { base: 9e9 - 0.8 * GB, slope: 0.4 * GB, measured: 1, from: "kind" });
});

// --- the price: base + slope × workers, fitted from the footprints ---

/** A footprint line: a kind's run of `jobs` workers that peaked at `peak` bytes, of command shape `shape` when given. */
const fp = (kind, jobs, peak, shape) => ({ kind, jobs, peakRss: peak, perWorker: Math.round(peak / jobs), ...(shape ? { shape } : {}) });
/** Eight-plus points on a line: peak = 1 GB + `slope` × jobs over 2, 4, 6 and 8 workers, twice each. */
const onLine = (kind, slope, shape, base = GB) => [2, 4, 6, 8, 2, 4, 6, 8].map((j) => fp(kind, j, base + slope * j, shape));

test("priceFor: the shape's footprints win from three on; fewer fall back to the kind's, then to the defaults", () => {
    const core = "scripts/test.mjs core", all = "scripts/test.mjs";
    const lines = [...onLine("unit", 0.2 * GB, all, 3 * GB), fp("unit", 2, 0.5 * GB, core), fp("unit", 2, 0.5 * GB, core), fp("unit", 2, 0.5 * GB, core), fp("e2e", 2, 9 * GB, core)];
    const shaped = priceFor(lines, { kind: "unit", shape: all });
    assert.deepEqual([shaped.from, shaped.measured], ["shape", 8]);
    assert.ok(Math.abs(shaped.slope - 0.2 * GB) < 1 && Math.abs(shaped.base - 3 * GB) < 1, "the full suite's own line: 3 GB + 0.2 GB a worker");
    assert.deepEqual([priceFor(lines, { kind: "unit", shape: core }).from, priceFor(lines, { kind: "unit", shape: core }).measured], ["shape", 3], "three is enough");
    assert.ok(priceFor(lines, { kind: "unit", shape: core }).base < GB, "the one-file shape is priced by its own runs, not the suite's");
    // Two of a shape are not enough: the kind's 11 unit lines price it.
    const two = priceFor([...lines.slice(0, 8), fp("unit", 2, GB, "other"), fp("unit", 2, GB, "other")], { kind: "unit", shape: "other" });
    assert.deepEqual([two.from, two.measured], ["kind", 10]);
    assert.equal(priceFor(lines, { kind: "unit", shape: "never run" }).from, "kind");
    assert.equal(priceFor(lines, { kind: "unit" }).from, "kind", "no shape asked for");
    // A line from before shapes counts at kind level only, even for a null shape.
    assert.equal(priceFor(onLine("unit", 0.2 * GB), { kind: "unit", shape: "x" }).from, "kind");
    assert.deepEqual(priceFor([], { kind: "unit", shape: "x" }), { base: BASE_DEFAULT, slope: SLOPE_DEFAULT, measured: 0, from: "default" });
    assert.deepEqual(priceFor([fp("e2e", 2, GB)], { kind: "unit" }), { base: BASE_DEFAULT, slope: SLOPE_DEFAULT, measured: 0, from: "default" }, "another kind's lines never count");
    assert.equal(priceFor([{ kind: "unit", jobs: 2 }, { kind: "unit", peakRss: 5 }, null], { kind: "unit" }).from, "default", "lines without a peak or workers are not footprints");
});

test("priceFor: the kind's sample is its last 40; the shape's is its last 40", () => {
    const old = [...Array(30)].map(() => fp("unit", 2, 9 * GB, "s")), fresh = [...Array(40)].map(() => fp("unit", 2, GB, "s"));
    const got = priceFor([...old, ...fresh], { kind: "unit", shape: "s" });
    assert.deepEqual([got.measured, got.base < 1.2 * GB], [40, true], "the 30 old 9 GB runs fell out of the window");
    assert.equal(priceFor([...old, ...fresh], { kind: "unit" }).measured, 40);
});

test("priceFor: the slope is least squares, clamped to [0.1 GB, 1.5 GB]; a default with under 8 points or one worker count", () => {
    assert.deepEqual([SLOPE_MIN, SLOPE_MAX], [0.1 * GB, 1.5 * GB]);
    for (const slope of [0.2 * GB, 0.7 * GB, 1.2 * GB]) {
        const got = priceFor(onLine("unit", slope), { kind: "unit" });
        assert.ok(Math.abs(got.slope - slope) < 1, `fitted ${slope / GB} GB`);
        assert.ok(Math.abs(got.base - GB) < 1, "the base is what the line leaves");
    }
    assert.equal(priceFor(onLine("unit", 0), { kind: "unit" }).slope, 0.1 * GB, "a flat sample is clamped up, not free");
    assert.equal(priceFor(onLine("unit", -0.3 * GB, undefined, 4 * GB), { kind: "unit" }).slope, 0.1 * GB, "a falling line is clamped up too");
    assert.equal(priceFor(onLine("unit", 3 * GB), { kind: "unit" }).slope, 1.5 * GB, "a steep one is clamped down");
    // Seven points on a line: too few to fit, so the default slope.
    assert.equal(priceFor(onLine("unit", 0.9 * GB).slice(0, 7), { kind: "unit" }).slope, 0.4 * GB);
    // Many points, one worker count: nothing to fit a slope to.
    const same = [...Array(12)].map((_, i) => fp("unit", 4, (2 + i * 0.1) * GB));
    assert.equal(priceFor(same, { kind: "unit" }).slope, 0.4 * GB);
});

test("priceFor: the base is the p90 of what the slope leaves of each peak, never below 0", () => {
    // One worker count (default slope 0.4 GB): residuals peak − 0.8 GB for jobs = 2, over ten runs of 1..10 GB.
    const lines = [...Array(10)].map((_, i) => fp("unit", 2, (i + 1) * GB));
    const got = priceFor(lines, { kind: "unit" });
    assert.equal(got.base, 9 * GB - 0.8 * GB, "nearest-rank p90 of ten is the ninth");
    assert.equal(priceFor([fp("unit", 4, 0.5 * GB)], { kind: "unit" }).base, 0, "a peak under the slope's share leaves 0");
    assert.equal(priceFor([...lines, fp("unit", 2, 500 * GB)], { kind: "unit" }).base, 10 * GB - 0.8 * GB, "eleven runs: the p90 is the tenth, so one huge outlier moves it to the next rank only");
});

test("the ratchet: the price barely depends on the workers a run was granted, and a 2-worker run does not raise the next price", () => {
    // Peak flat in the workers (1.7 GB at 2 or at 8), as measured on 536 unit footprints: the old per-worker figure
    // would have been 0.85 GB at 2 workers and 0.21 GB at 8.
    const flat = (jobs) => fp("unit", jobs, 1.7 * GB + 0.01 * GB * (jobs % 3), "scripts/test.mjs");
    const history = [2, 8, 4, 6, 8, 2, 8, 4, 6, 2, 8, 4].map(flat);
    const p = priceFor(history, { kind: "unit", shape: "scripts/test.mjs" });
    assert.equal(p.slope, 0.1 * GB, "flat: the clamp floor");
    assert.ok(priceAt(p, 8) - priceAt(p, 2) < 6 * 0.1 * GB + 1, "8 workers cost 6 slopes more than 2, nothing like 4x");
    // Feed it back its own 2-worker grants again and again: the price must not climb.
    let lines = history;
    const prices = [];
    for (let i = 0; i < 30; i++) {
        const q = priceFor(lines, { kind: "unit", shape: "scripts/test.mjs" });
        prices.push(priceAt(q, 2));
        lines = [...lines, flat(2)];
    }
    assert.ok(Math.max(...prices) - prices[0] < 0.1 * GB, `30 runs granted 2 workers each moved the 2-worker price by ${(Math.max(...prices) - prices[0]) / GB} GB`);
    // The old model on the same lines, for the record: the p90 of peak / jobs after only 2-worker runs is 0.85 GB a worker.
    const old = (ls) => { const v = ls.map((l) => l.perWorker).sort((a, b) => a - b); return v[Math.ceil(0.9 * v.length) - 1]; };
    assert.ok(old(lines.slice(-20)) > 0.8 * GB, "per-worker division would have quadrupled the figure");
    // And a whole queue of them grants more than 2 workers on a roomy machine.
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "footprints.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const deps = { memory: () => ({ available: 20 * GB, coming: 0, total: 24 * GB, cores: 15 }), maxRuns: 3, resident: () => 0, startTime: () => startTime(process.pid) };
    const t = submit({ cmd: ["scripts/test.mjs"], mode: "attached", dir, deps, tree: { clone: "/c", head: "a", dirty: null } }).ticket;
    const job = look(t, { dir, deps }).job;
    assert.equal(job.jobs, 8, "14 GB of room less a ~1.7 GB base: the cap of 8 workers");
    assert.equal(job.sizing.from, "shape", "the ticket's command is the history's shape");
});

test("classOf: the runner is a suite (by genre), named test files are files, anything else is nothing", () => {
    const table = [
        // From the queue's own records and the test-slot skill.
        ["node scripts/test.mjs", "suite"],
        ["node scripts/test.mjs core", "suite:core"],
        ["node scripts/test.mjs runner", "suite:runner"],
        ["node scripts/test.mjs --jobs 4", "suite"],
        ["node scripts/test.mjs --jobs 4 core", "suite:core"],
        ["npm test", "suite"],
        ["npm run test:core", "suite:core"],
        ["npm run test:python", "suite:python"],
        ["node --import tsx --test tests/test-slot.test.mjs", "files"],
        ["node --import tsx --test tests/cdp-stream.test.mjs tests/exec-page-label.test.mjs", "files"],
        ["node --import tsx --test --test-reporter=spec --test-reporter-destination=/dev/null --test-reporter=scripts/test-times-reporter.mjs --test-reporter-destination=/s/cdp.jsonl tests/cdp-stream.test.mjs tests/exec-page-label.test.mjs", "files"],
        ['node --import tsx --test "tests/a b.test.mjs"', "files"],
        ["node --import tsx --test tests/foo.test.ts", "files"],
        ["node scripts/test-slot.mjs status", null],
        ["node --import tsx --test", null],
        ["npm run build", null],
        ["npx playwright test", null],
        ["node scripts/probe.mjs --url x", null],
        [null, null],
        ["", null],
    ];
    for (const [shape, want] of table) assert.equal(classOf(shape), want, String(shape));
    assert.equal(classOf(shapeOf([process.execPath, "/w/clone/scripts/test.mjs", "core"], "/w/clone")), "suite:core", "from a real command in any clone");
});

test("priceFor: a run naming test files gets the defaults, not the kind's suite-heavy history, until files-class history exists", () => {
    const suites = [...onLine("unit", 0.2 * GB, "node scripts/test.mjs", 4 * GB)];
    const files = (n, peak) => [...Array(n)].map((_, i) => fp("unit", 2, peak + i * 0.01 * GB, `node --import tsx --test tests/f${i}.test.mjs`));
    const ask = "node --import tsx --test tests/a.test.mjs tests/b.test.mjs";
    assert.ok(priceFor(suites, { kind: "unit" }).base > 3.5 * GB, "the kind alone is priced as a suite");
    const none = priceFor(suites, { kind: "unit", shape: ask });
    assert.deepEqual(none, { base: BASE_DEFAULT, slope: SLOPE_DEFAULT, measured: 0, from: "default" }, "no class history: the defaults, 1 GB + 0.4 GB a worker");
    assert.equal(priceFor([...suites, ...files(2, 0.5 * GB)], { kind: "unit", shape: ask }).from, "default", "two files-class lines are not enough");
    // Three distinct file sets (no shape repeats) are enough, and the suites do not leak in.
    const three = priceFor([...suites, ...files(3, 0.5 * GB)], { kind: "unit", shape: ask });
    assert.deepEqual([three.from, three.measured], ["class", 3]);
    assert.ok(three.base < GB, `priced from the three small runs, not the suites: ${three.base / GB} GB`);
    // The same shape three times wins over the class.
    const same = [...Array(3)].map(() => fp("unit", 2, 3 * GB, ask));
    assert.equal(priceFor([...files(5, 0.5 * GB), ...same], { kind: "unit", shape: ask }).from, "shape");
    // A footprint with a recorded class and no shape counts too; suites of another genre do not mix with this genre's.
    const rec = [...Array(3)].map(() => ({ ...fp("unit", 2, 0.6 * GB), class: "files" }));
    assert.equal(priceFor(rec, { kind: "unit", shape: ask }).from, "class");
    const core = [...Array(4)].map(() => fp("unit", 2, 2 * GB, "node scripts/test.mjs core"));
    assert.deepEqual([priceFor([...core, ...suites], { kind: "unit", shape: "node scripts/test.mjs core" }).from, priceFor(core, { kind: "unit", shape: "node scripts/test.mjs panel" }).from], ["shape", "kind"], "a suite genre with no history of its own falls back to the kind");
    assert.equal(priceFor([...suites, ...core], { kind: "unit", shape: "node scripts/test.mjs core --jobs 3" }).from, "class", "a flag makes a new shape but the same class");
});

test("shapeOf: the clone's path made relative, so the same command in two clones is one shape", () => {
    const a = shapeOf([process.execPath, "/Users/sb/git/window-ml-x/scripts/test.mjs", "core"], "/Users/sb/git/window-ml-x");
    const b = shapeOf([process.execPath, "/Users/sb/git/window-ml-queue/scripts/test.mjs", "core"], "/Users/sb/git/window-ml-queue");
    assert.equal(a, "node scripts/test.mjs core");
    assert.equal(a, b);
    assert.equal(shapeOf(["node", "--import", "tsx", "--test", "/c/tests/a b.test.mjs"], "/c"), 'node --import tsx --test "tests/a b.test.mjs"');
    assert.equal(shapeOf(["x", "/c"], "/c"), "x .", "the clone itself is a dot");
    assert.equal(shapeOf(["x", "/cc/y"], "/c"), "x /cc/y", "a sibling directory with the clone as a prefix is left alone");
});

test("shapeOf: a long command keeps whole arguments and names what it dropped, so two that differ at the end are two shapes", () => {
    // Review of #1953: a character cut made the 267- and 283-character commands below one shape, and cut through an argument.
    const head = ["node", "--import", "tsx", "--test", "--test-reporter=spec", "--test-reporter-destination=/dev/null", "--test-reporter=scripts/test-times-reporter.mjs", "--test-reporter-destination=/s/cdp.jsonl"];
    const a = shapeOf([...head, "tests/cdp-stream.test.mjs", "tests/exec-page-label.test.mjs", "tests/a.test.mjs"], "/c");
    const b = shapeOf([...head, "tests/cdp-stream.test.mjs", "tests/exec-page-label.test.mjs", "tests/a-much-longer-name.test.mjs", "tests/b.test.mjs"], "/c");
    for (const s of [a, b]) {
        assert.ok(s.length <= SHAPE_MAX, `${s.length} characters`);
        assert.match(s, / …\+\d+ #[0-9a-f]{8}$/);
        const kept = s.replace(/ …\+\d+ #[0-9a-f]{8}$/, "").split(" ");
        assert.deepEqual(kept, [...head, "tests/cdp-stream.test.mjs", "tests/exec-page-label.test.mjs"].slice(0, kept.length), "only whole arguments, in order");
    }
    assert.notEqual(a, b);
    assert.equal(shapeOf([...head, "tests/x.test.mjs"], "/c", Infinity), [...head, "tests/x.test.mjs"].join(" "), "uncapped, it is the whole command");
    assert.equal(shapeOf(["node", "scripts/test.mjs"], "/c"), "node scripts/test.mjs", "a short command is unchanged");
});

test("a job's class is read from its WHOLE command, so a long file run whose paths fell past the cap is still `files`", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "footprints.jsonl"), [...onLine("unit", 0.2 * GB, "node scripts/test.mjs", 4 * GB)].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const flags = [...Array(3)].flatMap((_, i) => [`--test-reporter=scripts/reporter-number-${i}.mjs`, `--test-reporter-destination=/private/tmp/some/long/scratch/dir/out-${i}.jsonl`]);
    const cmd = ["node", "--import", "tsx", "--test", ...flags, "tests/a.test.mjs", "tests/b.test.mjs"];
    assert.equal(classOf(shapeOf(cmd, "/c")), null, "the capped shape has lost the test paths");
    const real = { memory: () => ({ available: 20 * GB, coming: 0, total: 24 * GB, cores: 10 }), maxRuns: 3, resident: () => 0, startTime: () => startTime(process.pid) };
    const t = submit({ cmd, mode: "attached", dir, deps: real, tree: { clone: "/c", head: "h", dirty: null } }).ticket;
    const job = look(t, { dir, deps: real }).job;
    assert.equal(job.class, "files");
    assert.equal(job.sizing.from, "default", "priced as a file run with no history, not from the suites");
});

test("the worker cap follows the reading's cores, not the machine the queue runs on", () => {
    // Review of #1953: the grant took its cap from os.cpus(), so a 15-core reading got 2 workers on a 4-vCPU runner.
    for (const cores of [1, 2, 3, 4, 8, 10, 15, 32]) {
        const dir = tmpDir();
        const deps = { memory: () => ({ available: 40 * GB, coming: 0, total: 48 * GB, cores }), maxRuns: 3, resident: () => 0, startTime: () => startTime(process.pid) };
        const t = submit({ cmd: ["scripts/test.mjs"], mode: "attached", dir, deps, tree: { clone: "/c", head: "h", dirty: null } }).ticket;
        assert.equal(look(t, { dir, deps }).job.jobs, Math.min(8, Math.max(1, cores - 2)), `${cores} cores`);
        assert.equal(capFor("e2e", cores), Math.max(1, Math.floor(cores / 2)));
    }
});

test("a footprint records the shape of its command, and the next grant is priced from that shape", () => {
    const dir = tmpDir(), deps = laptop(20 * GB, { cap: 2 });
    const backdate = (t) => edit(dir, t, (j) => { j.grantedAt = new Date(Date.now() - 60_000).toISOString(); });
    const run = (cmd, peak) => { const t = submit({ cmd, mode: "attached", dir, deps, tree: { clone: "/work/clone-a", head: "h", dirty: null } }).ticket; backdate(t); finish(t, 0, { dir, deps, peak }); return t; };
    const t = run(["/work/clone-a/scripts/test.mjs", "core"], 3 * GB);
    const line = JSON.parse(fs.readFileSync(path.join(dir, "footprints.jsonl"), "utf8").trim());
    assert.equal(line.shape, "scripts/test.mjs core");
    assert.equal(line.class, "suite:core", "the class is recorded too");
    assert.equal(line.ticket, t);
    assert.equal(line.perWorker, 1.5 * GB, "the old field is still written");
    run(["/work/clone-a/scripts/test.mjs", "core"], 3 * GB);
    run(["/work/clone-a/scripts/test.mjs", "core"], 3 * GB);
    run(["/work/clone-a/scripts/other.mjs"], 0.5 * GB);
    // Measured, not injected: the real sizing path reads the file. Another clone's same command is the same shape.
    const real = { memory: deps.memory, maxRuns: 3, resident: () => 0, startTime: deps.startTime };
    const a = submit({ cmd: ["/work/clone-b/scripts/test.mjs", "core"], mode: "attached", dir, deps: real, tree: { clone: "/work/clone-b", head: "h", dirty: null } }).ticket;
    const j = look(a, { dir, deps: real }).job;
    assert.deepEqual([j.shape, j.sizing.from, j.sizing.measured], ["scripts/test.mjs core", "shape", 3]);
    assert.deepEqual([j.sizing.slope, j.sizing.base], [0.4 * GB, 3 * GB - 0.8 * GB], "three 2-worker runs at 3 GB: the default slope, the rest is base");
});

test("the upgrade: a running job with only sizing.perWorker still counts its plan, and a footprints file with no shape prices at kind level", () => {
    // The record an older copy wrote: perWorker, no base, slope or from.
    const dir = tmpDir(), deps = { ...laptop(20 * GB), resident: () => 0 };
    const oldJob = holder(process.pid, startTime(process.pid), { jobs: 6, sizing: { available: 20 * GB, coming: 0, total: 24 * GB, perWorker: 1.5 * GB, runs: 1, workers: 6 } });
    writeQueue(dir, [oldJob]);
    assert.deepEqual(priceOfSizing(oldJob.sizing), { base: 0, slope: 1.5 * GB });
    assert.equal(promisedBy([oldJob], () => 0), 9 * GB, "6 workers at 1.5 GB each, as it was granted");
    assert.deepEqual(priceOfSizing({}), { base: GB, slope: 0.4 * GB });
    assert.deepEqual(priceOfSizing({ base: 2 * GB, slope: 0.3 * GB }), { base: 2 * GB, slope: 0.3 * GB });
    assert.match(grantLine({ jobs: 6, sizing: oldJob.sizing }), /^test-slot: 6 workers \(~9\.0 GB for the run: 1\.5 GB a worker; 20\.0 GB available, 6\.0 GB reserved\)$/);
    // The next job is admitted against that plan: 20 GB - 6 reserved - 9 planned = 5 GB of room.
    const b = submit({ cmd: ["b"], mode: "attached", dir, deps, tree: tree() });
    assert.equal(look(b.ticket, { dir, deps }).job.jobs, 5, "5 GB of room at 1 GB a worker");
    // A footprints file written before shapes: no shape field anywhere, 12 lines. It prices the kind and every shape alike.
    const old = tmpDir();
    fs.writeFileSync(path.join(old, "footprints.jsonl"), onLine("unit", 0.3 * GB).map((l) => JSON.stringify({ at: "2026-11-10T00:00:00Z", runs: 1, durationMs: 60_000, ticket: "t", ...l })).join("\n") + "\n");
    const got = priceIn("unit", "scripts/test.mjs", old);
    assert.deepEqual([got.from, got.measured], ["kind", 8]);
    assert.ok(Math.abs(got.slope - 0.3 * GB) < 1 && Math.abs(got.base - GB) < 1);
});

test("the grant line names the run's price, where it came from and the reading", () => {
    const sizing = { available: 18.2 * GB, coming: 0, total: 24 * GB, base: 1.6 * GB, slope: 0.2 * GB, from: "shape", measured: 12, runs: 1, workers: 5 };
    assert.equal(grantLine({ jobs: 5, sizing }), "test-slot: 5 workers (~2.6 GB for the run: 1.6 GB + 205 MB a worker, from 12 runs of this command; 18.2 GB available, 6.0 GB reserved)");
    assert.match(grantLine({ jobs: 1, sizing: { ...sizing, from: "kind", measured: 1, coming: 2 * GB, runs: 2, workers: 7 } }), /^test-slot: 1 worker \(~1\.8 GB for the run: 1\.6 GB \+ 205 MB a worker, from 1 run of this kind; 18\.2 GB available, 2\.0 GB of it promised to bench browsers and other test runs starting up, 6\.0 GB reserved; run 2 at once, 7 workers between them\)$/);
    assert.match(grantLine({ jobs: 2, sizing: { ...sizing, from: "class", measured: 3 } }), /, from 3 runs of commands like this one;/);
    assert.match(grantLine({ jobs: 2, sizing: { ...sizing, from: "default", measured: 0 } }), /, unmeasured: the defaults;/);
});

// --- admission: a few runs at once under the budget ---

/** This laptop's shape: 24 GB, 15 cores (13 workers between runs), `available` free; a fixed per-worker figure. */
const laptop = (available, { perWorker = GB, price = null, cap = 8, e2e = {} } = {}) => ({
    memory: () => ({ available, coming: 0, total: 24 * GB, cores: 15 }),
    kind: (k) => (k === "e2e" ? { perWorker, price, cap: 7, ...e2e } : k === "batch" ? { perWorker, price, cap: 1 } : { perWorker, price, cap }),
    maxRuns: MAX_RUNS, resident: () => 0, startTime: () => startTime(process.pid),
});
const states = (dir, tickets, deps) => tickets.map((t) => look(t, { dir, deps }).job.state);

test("admit: the rule written out, enumerated over runs, workers, room and kind", () => {
    const maxWorkers = 13;
    for (const kind of ["unit", "e2e"]) {
        for (const running of [0, 1, 2, 3, 4]) {
            for (const workers of [0, 5, 11, 12, 13]) {
                for (const room of [-2 * GB, 0, 0.9 * GB, 1.5 * GB, 2 * GB, 6.5 * GB, 30 * GB]) {
                    const price = { base: 0, slope: GB }, cap = 8, min = kind === "e2e" ? 1 : 2, left = maxWorkers - workers, fit = Math.floor(room / GB);
                    const want = running === 0 ? Math.max(1, Math.min(cap, left, fit))
                        : running >= 3 || left < min || fit < min ? 0 : Math.min(cap, left, fit);
                    const got = admit({ kind, running, workers, room, price, cap, maxWorkers });
                    assert.equal(got.jobs, want, `${kind}, ${running} running with ${workers} workers, ${room / GB} GB room`);
                    assert.equal(!!got.why, want === 0);
                }
            }
        }
    }
    assert.deepEqual([minWorkersFor("unit"), minWorkersFor("e2e"), maxWorkersFor(15), maxWorkersFor(2), MAX_RUNS], [2, 1, 13, 1, 3]);
    assert.equal(admit({ kind: "unit", running: 0, workers: 0, room: -5 * GB, price: { base: 0, slope: GB }, cap: 8, maxWorkers: 13 }).jobs, 1, "alone, a run always starts");
    // A declared count (`want`, a batch job's workers): all of it or none, and alone too it must fit both caps.
    for (const running of [0, 1, 2]) for (const workers of [0, 7, 8, 13]) for (const room of [-GB, 5 * GB, 6 * GB, 20 * GB]) {
        const got = admit({ kind: "batch", running, workers, room, price: { base: 0, slope: GB }, cap: 1, maxWorkers: 13, want: 6 }).jobs;
        assert.equal(got, 13 - workers >= 6 && room >= 6 * GB ? 6 : 0, `want 6: ${running} running with ${workers} workers, ${room / GB} GB`);
    }
    assert.equal(admit({ kind: "batch", running: 0, workers: 0, room: 20 * GB, price: { base: 0, slope: GB }, cap: 1, maxWorkers: 2, want: 6 }).jobs, 0, "alone on a 4-core machine: 6 of 2 workers is refused");
    assert.equal(admit({ kind: "unit", running: 1, workers: 0, room: 4 * GB, price: { base: 0, slope: GB }, cap: 8, maxWorkers: 13, want: 3 }).jobs, 3, "`want` replaces the kind's minimum and cap");
});

// --- admission at base + slope × workers ---

test("admit: the most workers is the largest w with base + slope × w within the room; the base alone buys none", () => {
    const price = { base: 1.5 * GB, slope: 0.5 * GB }, args = { kind: "unit", running: 1, workers: 2, price, cap: 8, maxWorkers: 13 };
    // 4 GB of room: 1.5 + 0.5 w <= 4 gives w = 5. Written out over a range of rooms.
    for (const room of [0, GB, 1.5 * GB, 2.4 * GB, 2.5 * GB, 3 * GB, 3.9 * GB, 4 * GB, 4.4 * GB, 5.5 * GB, 30 * GB]) {
        const fit = room < 1.5 * GB ? 0 : Math.floor((room - 1.5 * GB) / (0.5 * GB));
        const got = admit({ ...args, room });
        assert.equal(got.jobs, fit < 2 ? 0 : Math.min(8, 11, fit), `${room / GB} GB of room`);
        if (fit < 2) assert.equal(got.why, `memory: ${room >= GB ? (room / GB).toFixed(1) + " GB" : Math.round(room / 1024 ** 2) + " MB"} above the reserve, 2 workers take ~2.5 GB`);
    }
    assert.equal(fitIn(price, 4 * GB), 5, "fits exactly at the boundary");
    assert.equal(fitIn(price, 4 * GB - 1), 4, "one byte short loses a worker");
    assert.equal(fitIn(price, GB), 0);
    // Alone, the head always starts, on one worker if that is all.
    assert.equal(admit({ ...args, running: 0, workers: 0, room: GB }).jobs, 1);
    assert.equal(admit({ ...args, running: 0, workers: 0, room: 30 * GB, cap: 4 }).jobs, 4, "the cap holds");
    // `want` is all or nothing at the price: 6 workers take 4.5 GB.
    const w = (room) => admit({ ...args, kind: "batch", want: 6, cap: 1, room }).jobs;
    assert.deepEqual([w(4.4 * GB), w(4.5 * GB), w(20 * GB)], [0, 6, 6]);
    // A bigger base moves the whole line: the same slope, 2 GB more base, 4 fewer workers at the same room.
    assert.equal(admit({ ...args, room: 5 * GB }).jobs - admit({ ...args, price: { base: 3.5 * GB, slope: 0.5 * GB }, room: 5 * GB }).jobs, 4);
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
    assert.match(look(b, { dir, deps }).why, /^memory: 0 MB above the reserve, 2 workers take ~2\.0 GB$/);
    const tight = laptop(2 * GB);
    finish(a, 0, { dir, deps: tight });
    assert.deepEqual([look(b, { dir, deps: tight }).job.state, look(b, { dir, deps: tight }).job.jobs], ["running", 1], "below the reserve, the head still starts on one worker");
});

test("what a running run planned counts until its workers hold it, and no further", () => {
    const run = (jobs, perWorker, pid) => ({ jobs, sizing: { base: 0, slope: perWorker }, pid });
    assert.equal(promisedBy([run(4, GB, 1), run(2, GB, 2)], (j) => (j.pid === 1 ? 3 * GB : 5 * GB)), GB, "1 GB still to come; the second run holds more than it planned");
    // The plan is the price at the run's workers: base + slope × workers.
    assert.equal(promisedBy([{ jobs: 4, sizing: { base: 1.5 * GB, slope: 0.5 * GB }, pid: 1 }], () => GB), 2.5 * GB, "3.5 GB planned, 1 GB held");
    // A run that planned 6 GB and holds none of it yet leaves 8 GB of room; holding all of it, it leaves 8 GB too,
    // since free memory has then dropped by what it holds.
    const dir = tmpDir(), deps = { ...laptop(20 * GB), resident: () => 0 };
    writeQueue(dir, [holder(process.pid, startTime(process.pid), { jobs: 6, sizing: { base: 0, slope: GB } })]);
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

// --- batch jobs: not tests, after tests ---

const putBatch = (dir, deps, cmd, workers = 1) => submit({ kind: "batch", workers, cmd: [cmd], mode: "attached", dir, deps, tree: tree() }).ticket;
const putTest = (dir, deps, cmd, kind = "unit") => submit({ kind, cmd: [cmd], mode: "attached", dir, deps, tree: tree() }).ticket;
/** Rewrite the queue's record of a ticket. */
const edit = (dir, ticket, f) => { const s = JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8")); f(s.jobs.find((j) => j.ticket === ticket)); fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(s)); };
/** A queue where something holds 2 workers already, so no job gets the alone-starts exemption. */
const held = (dir) => writeQueue(dir, [holder(process.pid, startTime(process.pid), { jobs: 2, sizing: { base: 0, slope: GB } })]);

test("batch: submitted before a test job, it is judged after it; both start when the budget fits both", () => {
    for (const batchFirst of [true, false]) {
        const dir = tmpDir(), deps = laptop(20 * GB, { cap: 3 }), none = laptop(0);
        held(dir);
        const batch = batchFirst ? putBatch(dir, none, "probe") : null;
        const test = putTest(dir, none, "suite");
        const b = batch ?? putBatch(dir, none, "probe");
        assert.deepEqual(states(dir, [b, test], none), ["queued", "queued"], "no room for either");
        const qt = look(test, { dir, deps }), qb = look(b, { dir, deps });
        assert.deepEqual([qt.job.state, qt.job.jobs, qb.job.state, qb.job.jobs], ["running", 3, "running", 1], `batch first: ${batchFirst}`);
        assert.ok(qt.job.grantedAt <= qb.job.grantedAt && qt.job.sizing.runs === 2 && qb.job.sizing.runs === 3, "the test was granted first");
    }
});

test("batch: when the budget fits only one of them, the test gets it, whatever the submit order", () => {
    // 10 GB less the 6 GB reserve and the holder's 2 planned: room for exactly a suite's 2 workers, or a batch's 1.
    for (const batchFirst of [true, false]) {
        const dir = tmpDir(), deps = laptop(10 * GB, { cap: 8 });
        held(dir);
        let b, t;
        if (batchFirst) { b = putBatch(dir, laptop(0), "probe"); t = putTest(dir, laptop(0), "suite"); } else { t = putTest(dir, laptop(0), "suite"); b = putBatch(dir, laptop(0), "probe"); }
        assert.deepEqual([look(t, { dir, deps }).job.state, look(t, { dir, deps }).job.jobs, look(b, { dir, deps }).job.state], ["running", 2, "queued"], `batch first: ${batchFirst}`);
        assert.match(look(b, { dir, deps }).why, /^memory: /);
    }
});

test("batch: at most one batch job runs at a time, even with room; the next starts when it ends", () => {
    const dir = tmpDir(), deps = laptop(23 * GB, { perWorker: 0.1 * GB });
    const [a, b] = [putBatch(dir, deps, "a"), putBatch(dir, deps, "b")];
    assert.deepEqual(states(dir, [a, b], deps), ["running", "queued"]);
    assert.equal(look(b, { dir, deps }).why, "a batch job runs already (at most one)");
    assert.equal(look(a, { dir, deps }).job.jobs, 1, "a batch job has one worker unless it declares more");
    assert.equal(look(putTest(dir, deps, "suite"), { dir, deps }).job.state, "running", "a test job is not held by it");
    finish(a, 0, { dir, deps });
    assert.equal(look(b, { dir, deps }).job.state, "running");
});

test("batch: alone, a submit whose workers do not fit the memory room is refused with the figures; one that fits starts", () => {
    // 24 GB total: the reserve is 6 GB, so 10 GB free is 4 GB of room, 4 workers at 1 GB.
    const dir = tmpDir(), deps = laptop(10 * GB);
    const no = submit({ kind: "batch", workers: 5, cmd: ["five"], mode: "attached", dir, deps, tree: tree() });
    assert.deepEqual([no.ticket, no.refused], [undefined, "5 workers take 5.0 GB and, with nothing else running, the memory room is 4.0 GB above the reserve; ask for at most 4"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8")).jobs, [], "nothing queued");
    // The count defaulted (no --workers): the text names no flag and counts one worker in the singular.
    assert.equal(submit({ kind: "batch", cmd: ["one"], mode: "attached", dir: tmpDir(), deps: laptop(1 * GB), tree: tree() }).refused,
        "1 worker takes 1.0 GB and, with nothing else running, the memory room is 0 MB above the reserve; not even one fits now: try later");
    const a = putBatch(dir, deps, "four", 4);
    assert.deepEqual([look(a, { dir, deps }).job.state, look(a, { dir, deps }).job.jobs], ["running", 4]);
});

test("batch: more workers than the machine's cap is refused at submit, whatever runs", () => {
    const four = { ...laptop(23 * GB), memory: () => ({ available: 23 * GB, coming: 0, total: 24 * GB, cores: 4 }) };
    for (const queue of [[], [holder(process.pid, startTime(process.pid))]]) {
        const dir = tmpDir();
        writeQueue(dir, queue);
        assert.equal(batchRefusal({ jobs: queue }, 3, dir, four), "3 workers is more than this machine's worker cap of 2 (its cores less two)");
        assert.equal(submit({ kind: "batch", workers: 3, cmd: ["three"], mode: "attached", dir, deps: four, tree: tree() }).refused, "3 workers is more than this machine's worker cap of 2 (its cores less two)");
        assert.equal(batchRefusal({ jobs: queue }, 2, dir, four), null);
    }
    // With something running, a short room is not a refusal: the job queues and waits.
    const dir = tmpDir();
    held(dir);
    assert.equal(look(putBatch(dir, laptop(0), "six", 6), { dir, deps: laptop(0) }).job.state, "queued");
});

test("batch: the dedupe key carries the declared count, and a batch job never shares a test job's run", () => {
    const dir = tmpDir(), deps = { ...laptop(0), spawnJob: () => assert.fail("nothing has room to start") };
    held(dir);
    const put = (kind, workers) => submit({ kind, workers, cmd: ["probe"], mode: "detached", dir, deps, tree: tree(), env: {} });
    const one = put("batch", 1), six = put("batch", 6), sixAgain = put("batch", 6), unit = put("unit", 1);
    assert.deepEqual([one.shared, six.shared, sixAgain.shared, unit.shared], [false, false, true, false]);
    assert.notEqual(one.ticket, six.ticket);
    assert.equal(sixAgain.ticket, six.ticket);
    assert.equal(look(six.ticket, { dir, deps }).job.want, 6);
});

test("batch: it counts toward the 3-run cap and the 13-worker cap", () => {
    const dir = tmpDir(), deps = laptop(23 * GB, { perWorker: 0.1 * GB, cap: 2 });
    const [t1, b, t2, t3] = [putTest(dir, deps, "t1"), putBatch(dir, deps, "b"), putTest(dir, deps, "t2"), putTest(dir, deps, "t3")];
    assert.deepEqual(states(dir, [t1, b, t2, t3], deps), ["running", "running", "running", "queued"], "two tests and a batch fill the 3 runs");
    assert.equal(look(t3, { dir, deps }).why, "3 runs at once already (at most 3)");
    finish(b, 0, { dir, deps });
    assert.equal(look(t3, { dir, deps }).job.state, "running", "its slot goes to the next in line");
    // 13 − 8 workers left is 5, so a 6-worker batch waits.
    const d2 = tmpDir(), big = laptop(23 * GB, { perWorker: 0.1 * GB, cap: 8 });
    const a = putTest(d2, big, "a"), six = putBatch(d2, big, "six", 6);
    assert.deepEqual([look(a, { dir: d2, deps: big }).job.jobs, look(six, { dir: d2, deps: big }).job.state], [8, "queued"]);
    assert.equal(look(six, { dir: d2, deps: big }).why, "the running runs have 8 of 13 workers");
});

test("batch: a declared worker count is all or nothing; alone it must fit too", () => {
    let dir = tmpDir(), deps = laptop(23 * GB, { perWorker: 0.1 * GB, cap: 8 });
    const a = putTest(dir, deps, "a"), b = putBatch(dir, deps, "six", 6);
    assert.deepEqual([look(b, { dir, deps }).job.state, look(b, { dir, deps }).job.want], ["queued", 6], "5 workers left of 13: held back");
    finish(a, 0, { dir, deps });
    assert.deepEqual([look(b, { dir, deps }).job.state, look(b, { dir, deps }).job.jobs], ["running", 6], "starts with exactly 6 once there is room");
    // The holder planned 2 GB of the room above the 6 GB reserve: free 13 GB leaves 5, 14 GB leaves 6.
    dir = tmpDir();
    held(dir);
    const c = putBatch(dir, laptop(0), "six", 6);
    for (const [free, state] of [[11, "queued"], [12, "queued"], [13, "queued"], [14, "running"]]) {
        const got = look(c, { dir, deps: laptop(free * GB) }).job;
        assert.deepEqual([free, got.state], [free, state]);
        if (state === "running") assert.equal(got.jobs, 6);
    }
    // Alone with a tight reading it is refused at submit, not granted (the always-starts rule is not for a declared count).
    const d = submit({ kind: "batch", workers: 6, cmd: ["six"], mode: "attached", dir: tmpDir(), deps: laptop(1 * GB), tree: tree() });
    assert.deepEqual([d.ticket, /^6 workers take 6\.0 GB/.test(d.refused)], [undefined, true]);
    assert.equal(BATCH_MAX_WORKERS, 6);
});

test("batch: its footprints do not size a test run; with none of its own it takes the unit price", () => {
    const dir = tmpDir(), write = (...ls) => fs.writeFileSync(path.join(dir, "footprints.jsonl"), `${ls.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const fp = (kind, peakRss, jobs = 2) => ({ kind, jobs, peakRss });
    assert.deepEqual(priceIn("batch", null, dir), { base: GB, slope: 0.4 * GB, measured: 0, from: "default" }, "nothing measured at all: the defaults");
    write(fp("unit", 3 * GB));
    assert.deepEqual(priceIn("batch", null, dir), { ...priceIn("unit", null, dir), measured: 0 }, "no batch lines: the unit price");
    assert.equal(priceIn("batch", null, dir).base, 3 * GB - 0.8 * GB);
    write(fp("unit", 3 * GB), ...[...Array(10)].map((_, i) => fp("batch", (i + 1) * GB, 1)));
    // Batch lines at one worker count: the default slope; the base is the p90 of their peaks less one slope.
    assert.deepEqual(priceIn("batch", null, dir), { base: 9 * GB - 0.4 * GB, slope: 0.4 * GB, measured: 10, from: "kind" }, "batch lines: their own, whatever the unit lines say");
    assert.equal(priceIn("unit", null, dir).measured, 1, "a batch line never sizes a unit run");
    assert.deepEqual(priceIn("e2e", null, dir), { base: GB, slope: 0.4 * GB, measured: 0, from: "default" });
});

test("batch: a footprint line has durationMs, and a batch run past the overrun mark is marked `overran`", () => {
    const dir = tmpDir(), deps = laptop(20 * GB);
    const lines = () => fs.readFileSync(path.join(dir, "footprints.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ran = (kind, ms, workers = 1) => {
        const t = submit({ kind, workers, cmd: [kind + ms], mode: "attached", dir, deps, tree: tree() }).ticket;
        edit(dir, t, (j) => { j.grantedAt = new Date(Date.now() - ms).toISOString(); });
        finish(t, 0, { dir, deps, peak: 2 * GB });
        return t;
    };
    const t = [ran("batch", BATCH_OVERRUN_MS + 60_000, 2), ran("batch", BATCH_OVERRUN_MS - 60_000), ran("unit", BATCH_OVERRUN_MS + 60_000), ran("batch", 1000)];
    const got = lines();
    assert.deepEqual(got.map((f) => [f.ticket, f.kind, !!f.overran]), [[t[0], "batch", true], [t[1], "batch", false], [t[2], "unit", false]], "unit never overruns; the 1 s run is not measured");
    assert.ok(got.every((f) => f.durationMs >= 10_000 && f.durationMs < BATCH_OVERRUN_MS + 70_000));
    assert.equal(got[0].perWorker, GB, "peak over the declared 2 workers");
    assert.equal(got[1].overran, undefined);
});

test("batch: the CLI takes --kind batch --workers N and refuses a bad count with exit 2", () => {
    const dir = tmpDir(), env = { ...process.env, TEST_SLOT_DIR: dir };
    delete env.TEST_SLOT_TICKET;
    // Something runs (this process), so the memory room is not judged at submit; the cores are fixed by a preload.
    writeQueue(dir, [holder(process.pid, startTime(process.pid))]);
    const cores = (n) => `data:text/javascript,import os from "node:os"; os.cpus = () => Array(${n}).fill({});`;
    const run = (n, ...a) => spawnSync(process.execPath, ["--import", cores(n), SLOT, "submit", ...a, "--", process.execPath, "-e", "0"], { cwd: ROOT, env, encoding: "utf8" });
    for (const bad of [["--kind", "batch", "--workers", "0"], ["--kind", "batch", "--workers", "7"], ["--kind", "batch", "--workers", "2.5"], ["--kind", "batch", "--workers", "x"], ["--kind", "batch", "--workers"], ["--kind", "unit", "--workers", "2"], ["--workers", "2"]]) {
        const r = run(15, ...bad);
        assert.equal(r.status, 2, bad.join(" "));
        assert.match(r.stderr, /--workers is for --kind batch only/);
    }
    const capped = run(4, "--kind", "batch", "--workers", "3");
    assert.deepEqual([capped.status, capped.stderr.trim()], [2, "test-slot.mjs: refused: 3 workers is more than this machine's worker cap of 2 (its cores less two)"]);
    for (const ok of [["--kind", "batch"], ["--kind", "batch", "--workers", "6"]]) assert.equal(run(15, ...ok).status, 0, ok.join(" "));
});

// --- the wall-clock cap: a job past it is stopped ---

const MIN = 60_000;
/** Footprint lines of `kind` with these durations. */
const footprints = (dir, kind, durations) => { fs.mkdirSync(dir, { recursive: true }); if (durations.length) fs.appendFileSync(path.join(dir, "footprints.jsonl"), durations.map((d) => JSON.stringify({ kind, jobs: 2, peakRss: 2 * GB, perWorker: GB, durationMs: d })).join("\n") + "\n"); };
/** A recorder standing in for the signalling, so no test signals a process it did not start. */
const kills = () => { const sent = []; return { sent, kill: (j, sig) => sent.push([j.ticket, sig]) }; };

test("timeCapFor: the longer of 50 min (test.mjs's 45 min watchdog, then 5) and 5× the kind's p90 duration; usualMsFor is that p90, null with none", () => {
    assert.deepEqual([TIME_CAP_MIN_MS, TIME_CAP_FACTOR], [50 * MIN, 5]);
    // Enumerated over the kind's durations, against the rule written out; another kind's lines never count.
    for (const durations of [[], [MIN], [4 * MIN, 5 * MIN, 6 * MIN], [9 * MIN], [10 * MIN, 2 * MIN], [3 * 60 * MIN]]) {
        const dir = tmpDir();
        footprints(dir, "unit", durations);
        footprints(dir, "e2e", [100 * MIN]);
        const want = durations.length ? [...durations].sort((a, b) => a - b)[Math.ceil(0.9 * durations.length) - 1] : null;
        assert.equal(usualMsFor("unit", dir), want, durations.join(","));
        assert.equal(timeCapFor("unit", dir), Math.max(50 * MIN, 5 * (want ?? 0)), durations.join(","));
    }
    const dir = tmpDir();
    footprints(dir, "unit", [9 * MIN]);
    assert.equal(timeCapFor("batch", dir), 50 * MIN, "a kind with no footprints gets the floor, not another kind's figure");
    assert.equal(timeCapFor("unit", tmpDir()), 50 * MIN, "no footprints file at all: the floor");
});

test("enforceCap: SIGTERM once at the cap, noted in the log; SIGKILL once after the grace; nothing before, nothing uncapped", () => {
    const at = Date.parse("2026-11-12T12:00:00Z"), cap = 30 * MIN, g = KILL_GRACE_MS;
    const job = (ranMs, extra = {}) => ({ ticket: "t", state: "running", mode: "detached", pid: 1, grantedAt: new Date(at - ranMs).toISOString(), capMs: cap, ...extra });
    // Enumerated over how long it ran × whether SIGTERM was sent and how long ago × whether SIGKILL was.
    for (const ran of [0, cap - 1, cap, cap + 1, 20 * cap]) {
        for (const termAgo of [null, 0, g - 1, g, 10 * g]) {
            for (const killed of [false, true]) {
                if (termAgo == null && killed) continue;
                const j = job(ran, termAgo == null ? {} : { termAt: new Date(at - termAgo).toISOString(), ...(killed ? { killAt: "x" } : {}) });
                const { sent, kill } = kills();
                enforceCap(j, { now: at, kill });
                const want = termAgo == null ? (ran >= cap ? ["SIGTERM"] : []) : !killed && termAgo >= g ? ["SIGKILL"] : [];
                assert.deepEqual(sent.map((x) => x[1]), want, `ran ${ran}, SIGTERM ${termAgo} ago, killed ${killed}`);
                if (want[0] === "SIGTERM") assert.equal(j.termAt, new Date(at).toISOString());
                if (want[0] === "SIGKILL") assert.equal(j.killAt, new Date(at).toISOString());
            }
        }
    }
    const log = path.join(tmpDir(), "j.log");
    enforceCap(job(31 * MIN, { log }), { now: at, kill: () => {} });
    assert.equal(fs.readFileSync(log, "utf8"), "\ntest-slot: stopped after 31 min, past its cap of 30 min; submit with --max-time <minutes> if it needs longer\n");
    for (const [extra, opts, what] of [[{ capMs: null }, {}, "granted with no cap and none given"], [{ state: "done" }, {}, "not running"], [{ capMs: null }, { cap: 40 * MIN }, "a default longer than it ran"]]) {
        const { sent, kill } = kills();
        enforceCap(job(35 * MIN, extra), { now: at, kill, ...opts });
        assert.deepEqual(sent, [], what);
    }
    const { sent, kill } = kills(), old = job(35 * MIN, { capMs: undefined });
    enforceCap(old, { now: at, kill, cap });
    assert.deepEqual([sent, old.capMs], [[["t", "SIGTERM"]], cap], "a record with no cap takes the default it is given, and keeps it");
});

test("a grant records its cap: what was asked for, else the kind's default; a shared submit keeps the longer ask", () => {
    const dir = tmpDir(), deps = { ...laptop(20 * GB, { cap: 3, e2e: { cap: 3 } }), timeCap: (kind) => (kind === "e2e" ? 77 * MIN : 33 * MIN) };
    const a = submit({ cmd: ["a"], mode: "attached", dir, deps, tree: tree() }).ticket;
    const b = submit({ cmd: ["b"], kind: "e2e", mode: "attached", dir, deps, tree: tree() }).ticket;
    const c = submit({ cmd: ["c"], maxTimeMs: 90 * MIN, mode: "attached", dir, deps, tree: tree() }).ticket;
    assert.deepEqual([a, b, c].map((t) => look(t, { dir, deps }).job.capMs), [33 * MIN, 77 * MIN, 90 * MIN]);
    const d2 = tmpDir(), dd = { memory, spawnJob: () => ({ pid: process.pid, started: startTime(process.pid) }), timeCap: () => 33 * MIN };
    writeQueue(d2, [holder(process.pid, startTime(process.pid), { capMs: 60 * MIN })]);
    const one = submit({ cmd: ["npm", "test"], maxTimeMs: 50 * MIN, dir: d2, deps: dd, tree: tree() }).ticket;
    for (const [ask, want] of [[40 * MIN, 50 * MIN], [null, 50 * MIN], [120 * MIN, 120 * MIN], [60 * MIN, 120 * MIN]]) {
        assert.equal(submit({ cmd: ["npm", "test"], maxTimeMs: ask, dir: d2, deps: dd, tree: tree() }).ticket, one);
        assert.equal(look(one, { dir: d2, deps: dd }).job.maxTimeMs, want, `a sharer asking ${ask}`);
    }
    finish("held", 0, { dir: d2, deps: dd });
    assert.equal(look(one, { dir: d2, deps: dd }).job.capMs, 120 * MIN);
});

test("a run stopped at its cap ends `timedout` with no footprint, and the next starts", () => {
    const dir = tmpDir(), deps = { ...laptop(20 * GB), maxRuns: 1 };
    const a = submit({ cmd: ["a"], mode: "attached", dir, deps, tree: tree() }).ticket;
    const b = submit({ cmd: ["b"], mode: "attached", dir, deps, tree: tree() }).ticket;
    // Its runner was sent SIGTERM at the cap and releases the slot on the way out, as acquire's handler does.
    edit(dir, a, (j) => { j.grantedAt = new Date(Date.now() - 2 * 60 * MIN).toISOString(); j.capMs = 60 * MIN; j.termAt = new Date().toISOString(); });
    finish(a, null, { dir, deps, peak: 4 * GB });
    assert.deepEqual(states(dir, [a, b], deps), ["timedout", "running"]);
    assert.equal(fs.existsSync(path.join(dir, "footprints.jsonl")), false, "a 2-hour run stopped at its cap writes no footprint, so it never raises the next cap");
});

test("the upgrade: a running record from before the cap (no capMs) gets its kind's default on the next read and is stopped past it", () => {
    const dir = tmpDir(), probe = { alive: () => true, startTime: () => "then" };
    // What the code before the cap wrote: a detached job granted 20 hours ago with no capMs, beside a fresh one.
    const rec = (ticket, pid, ago, extra = {}) => ({ ticket, mode: "detached", kind: "unit", cmd: ["x"], cwd: "/", key: ticket, clone: "/c", by: { pid: 1, started: "then" }, state: "running", pid, started: "then", grantedAt: new Date(Date.now() - ago).toISOString(), jobs: 2, ...extra });
    writeQueue(dir, [rec("old", 424242, 20 * 60 * MIN, { jobs: 3, sizing: { perWorker: 1.8 * GB } }), rec("fresh", 424243, 0)]);
    const { sent, kill } = kills();
    const { state } = look("old", { dir, deps: { ...laptop(20 * GB), probe, kill } });
    assert.deepEqual(sent, [["old", "SIGTERM"]], "only the one past the default");
    assert.deepEqual(state.jobs.map((j) => [j.ticket, j.state, j.capMs, !!j.termAt]), [["old", "running", 50 * MIN, true], ["fresh", "running", 50 * MIN, false]]);
    const gone = look("old", { dir, deps: { ...laptop(20 * GB), probe: { alive: (pid) => pid !== 424242, startTime: () => "then" }, kill } });
    assert.deepEqual([gone.job.state, gone.job.exit], ["timedout", null], "once it is gone it is `timedout`, not `lost`");
});

test("a detached job past its cap: its process group is stopped, the next job starts, the log says why, and wait exits 124", async () => {
    const dir = tmpDir(), never = path.join(dir, "never");
    const a = submit({ cmd: waitsFor(never), cwd: ROOT, dir, maxTimeMs: 300 });
    const b = submit({ cmd: quick(0), cwd: ROOT, dir });
    await until(() => look(a.ticket, { dir }).job.pid, 5000, "a to start");
    const pid = look(a.ticket, { dir }).job.pid;
    const jb = await waitFor(b.ticket, { dir, log: () => {} });
    assert.deepEqual([jb.state, jb.exit], ["done", 0]);
    const ja = look(a.ticket, { dir }).job;
    assert.equal(ja.state, "timedout");
    assert.throws(() => process.kill(-pid, 0), "the job's whole process group is gone");
    assert.match(fs.readFileSync(ja.log, "utf8"), /test-slot: stopped after 0 min, past its cap of 0 min; submit with --max-time <minutes>/);
    const env = { ...process.env, TEST_SLOT_DIR: dir };
    delete env.TEST_SLOT_TICKET;
    const w = spawnSync(process.execPath, [SLOT, "wait", a.ticket], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(w.status, 124, w.stderr);
    assert.match(w.stderr, /timedout/);
});

test("a job that ignores SIGTERM: what is left of its process group gets SIGKILL after the grace", { timeout: 15_000 }, async () => {
    const dir = tmpDir(), started = path.join(dir, "started");
    // The child ignores SIGTERM; the queue's `__job` process does not, so the group outlives the pid the record names.
    const stubborn = [process.execPath, "-e", `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(started)},"");setInterval(()=>{},1000)`];
    const a = submit({ cmd: stubborn, cwd: ROOT, dir, maxTimeMs: 1500 });
    const b = submit({ cmd: quick(0), cwd: ROOT, dir });
    await until(() => fs.existsSync(started), 5000, "the stubborn child to start");
    const pid = look(a.ticket, { dir }).job.pid;
    const deps = { killGraceMs: 500 };
    await until(() => look(a.ticket, { dir, deps }).job.termAt, 5000, "SIGTERM at the cap");
    assert.doesNotThrow(() => process.kill(-pid, 0), "the child is still there after SIGTERM");
    assert.equal(look(a.ticket, { dir, deps }).job.state, "running", "and the slot stays held while it is");
    const jb = await waitFor(b.ticket, { dir, deps, log: () => {} });
    assert.equal(jb.state, "done");
    const ja = look(a.ticket, { dir }).job;
    assert.ok(ja.killAt, "SIGKILL was sent");
    assert.equal(ja.state, "timedout");
    assert.throws(() => process.kill(-pid, 0));
});

test("an attached run past its cap: its stderr says it was stopped at the cap, the record ends timedout, and it exits 143", { timeout: 15_000 }, async () => {
    const dir = tmpDir(), started = path.join(dir, "started");
    // acquire's own process is the job (what test.mjs is): this test's polling is what reaches the cap and signals it.
    const holder = `import fs from "node:fs"; import { acquire } from ${JSON.stringify(SLOT)}; await acquire({ cmd: ["holder"], maxTimeMs: 1200 }); fs.writeFileSync(${JSON.stringify(started)}, ""); setInterval(() => {}, 1000);`;
    const env = { ...process.env, TEST_SLOT_DIR: dir };
    for (const k of ["TEST_SLOT_TICKET", "TEST_SLOT", "CI", "GITHUB_ACTIONS"]) delete env[k]; // each would skip the queue
    const child = spawn(process.execPath, ["--input-type=module", "-e", holder], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    await until(() => fs.existsSync(started), 5000, "the attached run to be granted");
    const { ticket } = look(null, { dir }).running[0];
    let code = null;
    exited.then((c) => { code = c; });
    await until(() => (look(null, { dir }), code !== null), 8000, "the run to be stopped at its cap");
    assert.equal(code, 143, stderr);
    assert.match(stderr, /test-slot: stopped: this run passed its cap of 0 min; TEST_SLOT_MAX_TIME=<minutes> gives it longer/);
    assert.equal(look(ticket, { dir }).job.state, "timedout");
});

test("--max-time: a whole number of minutes from 1 to a day; anything else exits 2", () => {
    for (const [v, want] of [["1", MIN], ["45", 45 * MIN], [String(MAX_TIME_MAX_MIN), MAX_TIME_MAX_MIN * MIN], ["0", NaN], [String(MAX_TIME_MAX_MIN + 1), NaN], ["2.5", NaN], ["-3", NaN], ["x", NaN], ["", NaN]]) {
        assert.deepEqual(parseMaxTime(v), want, `"${v}"`);
    }
    const dir = tmpDir(), env = { ...process.env, TEST_SLOT_DIR: dir };
    delete env.TEST_SLOT_TICKET;
    delete env.TEST_SLOT_MAX_TIME;
    writeQueue(dir, [holder(process.pid, startTime(process.pid))]);
    const run = (...a) => spawnSync(process.execPath, [SLOT, "submit", ...a, "--", process.execPath, "-e", "0"], { cwd: ROOT, env, encoding: "utf8" });
    for (const bad of [["--max-time", "0"], ["--max-time", "x"], ["--max-time"], ["--kind", "batch", "--max-time", "1441"]]) {
        const r = run(...bad);
        assert.equal(r.status, 2, bad.join(" "));
        assert.match(r.stderr, /--max-time is a whole number of minutes from 1 to 1440/);
    }
    const ok = run("--kind", "batch", "--max-time", "90");
    assert.equal(ok.status, 0, ok.stderr);
    const ticket = ok.stdout.split("\n")[0].trim();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8")).jobs.find((j) => j.ticket === ticket).maxTimeMs, 90 * MIN);
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
        assert.deepEqual([mine.pid, mine.ticket, mine.planned], [process.pid, r.ticket, priceAt(job.sizing, job.jobs)]);
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
