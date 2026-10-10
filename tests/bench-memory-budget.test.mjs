// The bench's memory budget (tests/e2e/bench/memory-budget.mjs) and its held-run menu (hold-menu.mjs): sizes as a person
// writes them, the machine's available memory from macOS's and Linux's own accounts, a process tree's resident memory
// without the trees of other ledger entries, the shared ledger (locked, dead pids dropped on read), the budget's two
// bounds, the p90 prediction from measured peaks, a sweep's budget saying no only when active, and the menu: groups,
// paste-ready commands, the runs turned away, the hints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSize, fmtBytes, autoLimit, parseMemoryLevel, parseVmStat, parseMeminfo, processTable, treeRss, withLedger, ledger, register, update, unregister, measureLedger,
    budgetState, admits, tooSmall, p90, openFootprints, logFootprint, predictBrowser, startBudget, ASSUMED_BROWSER, PAUSED_EXIT } from "../tests/e2e/bench/memory-budget.mjs";
import { failureShape, groupHeld, groupCommands, menuText, shellLine, inDir, HOLD_HINTS } from "../tests/e2e/bench/hold-menu.mjs";
import { doneLine } from "../tests/e2e/bench/sinks.mjs";

const GB = 1024 ** 3, MB = 1024 ** 2;
const tmpLedger = () => path.join(mkdtempSync(path.join(os.tmpdir(), "bench-ledger-")), "ledger.json");
/** A pid no process has (the highest pids are rarely in use; checked). */
const deadPid = () => { for (let p = 4_000_000; ; p--) { try { process.kill(p, 0); } catch (e) { if (e.code === "ESRCH") return p; } } };

// --- sizes and the machine's memory ---

test("a size is read as a person writes it; a bare number is GB; anything else is no size", () => {
    assert.deepEqual(["12G", "12GB", "12GiB", "512M", "1.5g", "12", "2T"].map(parseSize), [12 * GB, 12 * GB, 12 * GB, 512 * MB, 1.5 * GB, 12 * GB, 2 * 1024 * GB]);
    assert.deepEqual(["", "lots", "12 X", null].map(parseSize), [null, null, null, null]);
    assert.deepEqual([fmtBytes(6.14 * GB), fmtBytes(740 * MB), fmtBytes(null)], ["6.1 GB", "740 MB", "?"]);
    assert.equal(autoLimit(64 * GB), 32 * GB);
});

test("available memory: macOS's pressure level as a share of RAM, else its free, inactive, speculative and purgeable pages; Linux's MemAvailable", () => {
    const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             9999.\nPages inactive:                            500.\nPages speculative:                          20.\nPages wired down:                         7777.\nPages purgeable:                            30.\n";
    assert.equal(parseVmStat(vm), (1000 + 500 + 20 + 30) * 16384);
    assert.equal(parseMeminfo("MemTotal:       65000000 kB\nMemFree:  100 kB\nMemAvailable:   32000000 kB\n"), 32000000 * 1024);
    assert.equal(parseMeminfo("MemTotal: 1 kB\n"), null);
    assert.equal(parseMemoryLevel("55\n", 16 * GB), Math.round(0.55 * 16 * GB));
    assert.deepEqual(["", "x", "140"].map((t) => parseMemoryLevel(t, GB)), [null, null, null]);
});

test("a tree's resident memory is its own and its descendants', without another ledger entry's subtree", () => {
    // 10 runner → 11 its in-process browser → 12 renderer; 10 → 20 a held child → 21 its browser.
    const t = processTable(" 10 1 1000\n 11 10 2000\n 12 11 3000\n 20 10 500\n 21 20 4000\n junk\n");
    assert.equal(t.get(12).rss, 3000 * 1024);
    assert.equal(treeRss(t, 10), (1000 + 2000 + 3000 + 500 + 4000) * 1024);
    assert.equal(treeRss(t, 10, new Set([20])), (1000 + 2000 + 3000) * 1024, "the held child is its own entry");
    assert.equal(treeRss(t, 20), 4500 * 1024);
    assert.equal(treeRss(t, 99), 0, "gone is 0");
});

// --- the ledger ---

test("the ledger keeps an entry per pid, merges updates, and drops a dead pid's entry on read", () => {
    const f = tmpLedger();
    const dead = deadPid();
    register({ kind: "runner", pid: process.pid, sweep: "s" }, f);
    register({ kind: "held", pid: dead, cell: "c" }, f);
    update(process.pid, { heap: 5 }, f);
    const l = ledger(f);
    assert.deepEqual(l.map((e) => [e.kind, e.pid, e.heap]), [["runner", process.pid, 5]]);
    unregister(process.pid, f);
    assert.deepEqual(ledger(f), []);
});

test("the ledger is locked across processes: two writers at once both land", async () => {
    const f = tmpLedger();
    const mod = new URL("../tests/e2e/bench/memory-budget.mjs", import.meta.url).href;
    // Each child registers itself 30 times (pid stays alive while it writes, then the parent reads before they exit).
    const kid = (n) => spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(mod)}); for (let i = 0; i < 30; i++) m.register({ kind: "held", pid: process.pid, n: ${n}, i }, ${JSON.stringify(f)}); process.stdout.write("ok"); setTimeout(() => {}, 3000);`], { stdio: ["ignore", "pipe", "inherit"] });
    const kids = [kid(1), kid(2)];
    await Promise.all(kids.map((k) => new Promise((r) => k.stdout.once("data", r))));
    const l = ledger(f);
    assert.deepEqual(l.map((e) => [e.n, e.i]).sort(), [[1, 29], [2, 29]], "each child's last write survived the other's");
    for (const k of kids) k.kill();
});

test("a lock left by a dead holder is taken after 10 s, not waited on forever", async () => {
    const { mkdirSync, utimesSync } = await import("node:fs");
    const f = tmpLedger();
    mkdirSync(`${f}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${f}.lock`, old, old);
    const t0 = Date.now();
    register({ kind: "runner", pid: process.pid }, f);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(ledger(f).length, 1);
});

test("measuring gives each entry its own tree and keeps its peak", () => {
    const f = tmpLedger();
    register({ kind: "runner", pid: process.pid }, f);
    const big = processTable(`${process.pid} 1 5000\n 777 ${process.pid} 1000\n`);
    const small = processTable(`${process.pid} 1 2000\n`);
    assert.equal(measureLedger({ file: f, table: big })[0].rss, 6000 * 1024);
    const [e] = measureLedger({ file: f, table: small });
    assert.deepEqual([e.rss, e.peak], [2000 * 1024, 6000 * 1024]);
});

// --- the budget ---

test("the budget's room is whichever runs out first: the limit, or the free memory less the quarter kept free", () => {
    const entries = [{ kind: "runner", rss: 1 * GB }, { kind: "held", rss: 2 * GB }, { kind: "held", rss: 1 * GB }];
    const s = budgetState({ limit: 12 * GB, entries, available: 30 * GB, total: 64 * GB });
    assert.deepEqual([s.used, s.byKind.held, s.reserve, s.room], [4 * GB, 3 * GB, 16 * GB, 8 * GB]);
    assert.deepEqual(admits(s, 7 * GB), { ok: true, why: null });
    assert.match(admits(s, 9 * GB).why, /the memory limit: the bench holds 4\.0 GB of 12\.0 GB/);
    const tight = budgetState({ limit: 40 * GB, entries, available: 17 * GB, total: 64 * GB });
    assert.equal(tight.room, 1 * GB);
    assert.match(admits(tight, 2 * GB).why, /free memory: 17\.0 GB available, and 16\.0 GB \(25% of RAM\) stays free/);
});

test("p90 is the nearest-rank 90th percentile; none is null", () => {
    assert.equal(p90([5, 1, 3, 2, 4, 6, 7, 8, 9, 10]), 9);
    assert.equal(p90([3]), 3);
    assert.equal(p90([]), null);
});

test("a browser's prediction: the p90 of its task's measured peaks, else every task's, else assumed", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = openFootprints(new DatabaseSync(":memory:"));
    assert.deepEqual(predictBrowser(db, "t"), { bytes: ASSUMED_BROWSER, basis: "assumed: no browser measured yet", n: 0 });
    for (let i = 1; i <= 10; i++) logFootprint(db, { run: `r${i}`, task: "a", peak: i * 100 * MB, held: i % 2 });
    assert.equal(logFootprint(db, { run: "r1", task: "a", peak: 1, held: 0 }), 0, "a run is logged once");
    assert.deepEqual(predictBrowser(db, "a"), { bytes: 900 * MB, basis: "p90 of 10 measured runs of a", n: 10 });
    assert.equal(predictBrowser(db, "b").basis, "p90 of 10 measured runs of other tasks");
    assert.equal(predictBrowser(null, "a").bytes, ASSUMED_BROWSER);
});

test("a sweep's budget says no at the limit only when active, and says up front how many runs it can hold", () => {
    const f = tmpLedger();
    const opts = { file: f, total: 64 * GB, avail: () => 40 * GB, everyMs: 60_000 };
    const used = (gb) => () => [{ kind: "runner", pid: process.pid, rss: gb * GB, peak: gb * GB }];
    const b = startBudget({ ...opts, limit: 6 * GB, measure: used(2) });
    // room = min(6 - 2, 40 - 16) = 4 GB; one running browser of 1 GB (assumed) leaves 3 held.
    assert.equal(b.expect(["t"], 1).n, 3);
    assert.match(b.expect(["t"], 1).text, /about 3 failed runs can be held this sweep \(4\.0 GB free under the 6\.0 GB limit/);
    assert.equal(b.canStart("t").ok, true);
    assert.equal(b.peakOf(process.pid), 2 * GB);
    b.stop();
    const full = startBudget({ ...opts, limit: 6 * GB, measure: used(5.5) });
    assert.equal(full.canStart("t").ok, false);
    assert.equal(full.canKeep("t").ok, false);
    full.stop();
    const off = startBudget({ ...opts, limit: 6 * GB, measure: used(5.5), active: false });
    assert.equal(off.canStart("t").ok, true, "a fake-model sweep that holds nothing is never stopped");
    off.stop();
    assert.deepEqual(ledger(f), [], "the runner is gone from the ledger once its budget stops");
});

// --- the menu ---

test("a failure's shape: step cap, rate limit, timeout, wrong answer, or the error's words without ids", () => {
    assert.deepEqual([
        { ok: true, hitCap: true }, { ok: false, error: "HTTP 429 rate limited" }, { ok: false, error: "the run timed out after 300s" },
        { ok: true, succeeded: false }, { ok: false, error: "session 73d87cf725ac3472 lost" }, { ok: true, succeeded: true }, null,
    ].map(failureShape), ["step cap", "rate-limited", "timed out", "wrong answer", "error: session … lost", "ok", "unknown"]);
});

const held = (pid, model, task, failure, rss = GB) => ({ kind: "held", pid, model, task, failure, rss, repo: "/Users/x/git/window-ml-bench", dir: `tests/e2e/artifacts/bench/s/${task}/r${pid}`, sweep: "cuts2" });

test("held runs group by model × task × failure, largest first; running cells and runners are not in it", () => {
    const g = groupHeld([held(1, "glm", "icon-heart", "step cap"), held(2, "glm", "icon-heart", "step cap"), held(3, "minimax", "csv", "wrong answer"), { kind: "runner", pid: 9 }, { kind: "running", pid: 8 }]);
    assert.deepEqual(g.map((x) => [x.key, x.runs.length, x.rss]), [["glm · icon-heart · step cap", 2, 2 * GB], ["minimax · csv · wrong answer", 1, GB]]);
});

test("each group's commands paste into any terminal: cd into the clone, keep one, release the rest or all", () => {
    const [g] = groupHeld([held(101, "glm", "icon-heart", "step cap"), held(102, "glm", "icon-heart", "step cap"), held(103, "glm", "icon-heart", "step cap")]);
    const c = groupCommands(g);
    assert.equal(c.attach, `cd /Users/x/git/window-ml-bench && node tests/e2e/converse.mjs --attach tests/e2e/artifacts/bench/s/icon-heart/r101 "<message>"`);
    assert.equal(c.keepOne, "cd /Users/x/git/window-ml-bench && node --import tsx tests/e2e/bench/hold.mjs --stop 102 103");
    assert.equal(c.release, "cd /Users/x/git/window-ml-bench && node --import tsx tests/e2e/bench/hold.mjs --stop 101 102 103");
    assert.equal(groupCommands(groupHeld([held(5, "m", "t", "x")])[0]).keepOne, undefined, "one run has no duplicates");
    assert.equal(shellLine(["cd", "/a b/c", "it's"], "darwin"), `cd '/a b/c' 'it'\\''s'`);
    // Written for the shell of the machine the bench runs on: PowerShell on Windows.
    assert.equal(shellLine(["C:\\git\\window-ml", "it's"], "win32"), `C:\\git\\window-ml 'it''s'`);
    assert.equal(inDir("C:\\My Repos\\wml", "node x", "win32"), `cd 'C:\\My Repos\\wml'; node x`);
    assert.equal(inDir("/a b", "node x", "linux"), `cd '/a b' && node x`);
});

test("the menu: paused first, the groups with their commands, what was not held, how to resume, the hints; nothing when nothing is held", () => {
    assert.deepEqual(menuText([]), []);
    const lines = menuText([held(1, "glm", "icon-heart", "step cap"), held(2, "glm", "icon-heart", "step cap")], {
        paused: "free memory: …", resume: "cd /r && node --import tsx tests/e2e/bench/run.mjs spec.ts --hold failures",
        wouldHold: [{ cell: "glm · csv · r3", failure: "wrong answer" }] }).join("\n");
    assert.match(lines, /^  PAUSED at the memory budget: free memory: …/);
    assert.match(lines, /2 × glm · icon-heart · step cap {2}\(2\.0 GB, sweep cuts2\)/);
    assert.match(lines, /keep one, release the rest: +cd \/Users\/x\/git\/window-ml-bench && node --import tsx tests\/e2e\/bench\/hold\.mjs --stop 2/);
    assert.match(lines, /Not held \(the budget had no room\): 1 run;[^\n]*\n {4}glm · csv · r3 {2}\(wrong answer\)/);
    assert.match(lines, /Resume the sweep \(finished cells come from the cache\): cd \/r && /);
    for (const h of HOLD_HINTS) assert.ok(lines.includes(h));
});

test("a paused sweep says so on its last line and exits 75", () => {
    const d = { name: "s", runs: 4, ran: 2, cached: 0, ok: 2, errors: 0, correct: 2, wrong: 0, held: [], report: "r.md" };
    assert.doesNotMatch(doneLine(d), /paused/);
    assert.match(doneLine({ ...d, paused: "x" }), / paused=memory-budget$/);
    assert.equal(PAUSED_EXIT, 75);
});

test("a budget with room for no browser stops the sweep before it starts; room for one warns; both say what to set instead", () => {
    const base = { per: GB, bench: 200 * MB, limit: 8 * GB, reserve: 4 * GB, jobs: 1, held: 3 };
    const none = tooSmall({ ...base, room: 600 * MB });
    assert.equal(none.level, "error");
    assert.match(none.text, /room for no browser: 600 MB free under the 8\.0 GB limit with 4\.0 GB of RAM kept free, and one browser takes about 1\.0 GB/);
    // 200 MB for the bench and 1 GB for each of 1 running and 3 held: 4.2 GB, rounded up.
    assert.match(none.text, /--memory-limit 5G budgets about 1\.0 GB per browser \(1 running cell and 3 failed runs held open\) and 200 MB for the bench itself/);
    assert.match(none.text, /goes to swap and every run is slower/);
    const one = tooSmall({ ...base, room: 1.5 * GB, jobs: 2 });
    assert.equal(one.level, "warn");
    assert.match(one.text, /room for one browser only, the running cell's: no failed run can be held, and --jobs 2 runs one at a time/);
    assert.equal(tooSmall({ ...base, room: 2 * GB }), null);
    assert.doesNotMatch(tooSmall({ ...base, room: 0, limitGiven: true }).text, /4\.0 GB of RAM kept free/, "a hand-set limit keeps nothing free");
});

test("a hand-set budget drops the free-memory reserve: the limit alone bounds it", () => {
    const f = tmpLedger();
    const b = startBudget({ file: f, total: 16 * GB, avail: () => 3 * GB, everyMs: 60_000, limit: 6 * GB, reserveFrac: 0, measure: () => [{ kind: "runner", pid: process.pid, rss: GB, peak: GB }] });
    assert.equal(b.state().room, 3 * GB, "min(6 - 1, 3 - 0)");
    assert.equal(b.canStart("t").ok, true);
    b.stop();
});

test("a sweep's budget keeps every reading for the chart, thinned past 600, the first and the latest kept", () => {
    const f = tmpLedger();
    let n = 0;
    const b = startBudget({ file: f, total: 64 * GB, avail: () => 40 * GB, everyMs: 60_000, limit: 8 * GB, measure: () => [{ kind: "held", pid: process.pid, rss: ++n * MB }] });
    for (let i = 0; i < 700; i++) b.refresh();
    const h = b.history();
    assert.ok(h.length <= 600 && h.length > 300, `${h.length}`);
    assert.equal(h[0].values.held, 1 * MB);
    assert.equal(h.at(-1).values.held, n * MB);
    assert.ok(h.every((p, i) => !i || p.t >= h[i - 1].t), "oldest first");
    b.stop();
});
