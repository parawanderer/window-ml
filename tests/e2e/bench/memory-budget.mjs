// memory-budget.mjs — what the bench holds in this machine's memory, and whether it may hold more: one LEDGER shared by
// every bench process (every clone, every session) of each browser it keeps alive and of its own processes, each
// measured as the summed resident memory of its process tree; a BUDGET (a ceiling, `--memory-limit` or half the RAM)
// checked together with the live free memory (a quarter of the RAM is always left free, since other apps grow); and a
// PREDICTION of what one more browser takes, the p90 of the peaks measured before (scores.sqlite `footprints`).
//
// Why: a sweep with `--hold failures` kept every failed run's browser alive, 38 at once, and the laptop ran out of
// memory. A sweep now asks before it starts a cell and before it keeps one, and at the limit it stops (run.mjs), leaving
// what it holds alive and a menu of what to do with it (hold-menu.mjs).
//
// Resident memory summed over a Chromium tree counts the pages its processes share once per process, so it OVER-states
// what the tree takes: the safe side for a budget.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The ledger: every bench process and held browser on this machine, `[{ kind, pid, … }]` (tests set the env). */
export const LEDGER_FILE = process.env.BENCH_LEDGER_FILE || path.join(os.homedir(), ".cache", "window-ml-bench", "ledger.json");
/** A sweep's exit status when it stopped at the memory budget (EX_TEMPFAIL): run the same command again to resume. */
export const PAUSED_EXIT = 75;
/** The share of the machine's RAM always left free, whatever the limit says. */
export const RESERVE_FRAC = 0.25;
/** The most readings a sweep's budget keeps for its chart before it thins them. */
const HISTORY_MAX = 600;
/** What one browser is assumed to take before any was measured. */
export const ASSUMED_BROWSER = 1024 ** 3;
const GB = 1024 ** 3;

/** A size as a person writes it (`12G`, `512M`, `1.5GB`, `12` for 12 GB) in bytes; null when it is not one. */
export function parseSize(s) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?\s*$/i.exec(String(s ?? ""));
    if (!m) return null;
    const unit = { "": GB, K: 1024, M: 1024 ** 2, G: GB, T: 1024 ** 4 }[m[2].toUpperCase()];
    return Math.round(Number(m[1]) * unit);
}

/** Bytes as the CLI and page write them: `6.1 GB`, `740 MB`. */
export const fmtBytes = (b) => (b == null ? "?" : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/** The ceiling when none is given: half this machine's RAM. */
export const autoLimit = (total = os.totalmem()) => Math.round(total * 0.5);

/** Available memory from macOS's `vm_stat`: free, inactive, speculative and purgeable pages (what can be had without swapping). */
export function parseVmStat(text) {
    const page = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
    const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
    return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page;
}

/** Available memory from Linux's `/proc/meminfo` (`MemAvailable`), or null without it. */
export function parseMeminfo(text) {
    const kb = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)?.[1];
    return kb == null ? null : Number(kb) * 1024;
}

/** Available memory from macOS's own pressure measure (`kern.memorystatus_level`, the "System-wide memory free
 *  percentage" `memory_pressure` prints), as bytes of `total`; null when it is not a percentage. */
export function parseMemoryLevel(text, total = os.totalmem()) {
    const pct = Number(String(text).trim());
    return Number.isFinite(pct) && pct >= 0 && pct <= 100 && String(text).trim() !== "" ? Math.round((pct / 100) * total) : null;
}

/** What this machine can give a new process now, by its own account. On macOS that is the kernel's pressure measure,
 *  which counts what it can compress as well as what is free; `os.freemem()` there leaves out even the inactive pages,
 *  and summing vm_stat's free pages reads a machine at 55% as 27%. vm_stat is the fallback. */
export function availableMemory(platform = process.platform) {
    try {
        if (platform === "darwin") {
            try { const v = parseMemoryLevel(execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8" })); if (v != null) return v; } catch { /* vm_stat below */ }
            return parseVmStat(execFileSync("vm_stat", { encoding: "utf8" }));
        }
        if (platform === "linux") return parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8")) ?? os.freemem();
    } catch { /* fall through */ }
    return os.freemem();
}

/** Every process's parent and resident memory (bytes), from `ps` (the same columns on macOS and Linux): `Map<pid, { ppid, rss }>`. */
export function processTable(psOut = null) {
    const text = psOut ?? (() => { try { return execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }); } catch { return ""; } })();
    const table = new Map();
    for (const line of text.split("\n")) {
        const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
        if (Number.isFinite(pid) && Number.isFinite(rss)) table.set(pid, { ppid, rss: rss * 1024 });
    }
    return table;
}

/** The resident memory of `root` and every process under it, leaving out the subtrees of `exclude` (other ledger
 *  entries a process started: a sweep's held browsers are its children, and are counted as theirs). 0 when it is gone. */
export function treeRss(table, root, exclude = new Set()) {
    const kids = new Map();
    for (const [pid, { ppid }] of table) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
    let sum = 0;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
        const pid = stack.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        sum += table.get(pid)?.rss ?? 0;
        for (const k of kids.get(pid) ?? []) if (!exclude.has(k)) stack.push(k);
    }
    return sum;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readRaw = (file) => { try { const l = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(l) ? l : []; } catch { return []; } };
function writeRaw(file, list) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
}

/** Run `fn(list)` with the ledger locked across processes (a lock directory; one left by a dead holder is taken after
 *  10 s) and write back what it returns, when it returns a list. Dead pids are dropped on the way. */
export function withLedger(fn, file = LEDGER_FILE) {
    const lock = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const until = Date.now() + 5000; ;) {
        try { fs.mkdirSync(lock); break; } catch (e) {
            if (e.code !== "EEXIST") throw e;
            let stale = false;
            try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10_000; } catch { continue; }
            if (stale || Date.now() > until) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
            sleep(20);
        }
    }
    try {
        const before = readRaw(file);
        const live = before.filter((e) => alive(e.pid));
        const out = fn(live);
        const next = Array.isArray(out) ? out : live;
        if (Array.isArray(out) || live.length !== before.length) writeRaw(file, next);
        return next;
    } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/** The ledger's live entries (a dead pid's entry is dropped on read). */
export const ledger = (file = LEDGER_FILE) => withLedger(() => undefined, file);
/** Add or replace the entry for `entry.pid`. */
export const register = (entry, file = LEDGER_FILE) => withLedger((l) => [...l.filter((e) => e.pid !== entry.pid), { at: new Date().toISOString(), ...entry }], file);
/** Merge `patch` into the entry for `pid`, if there is one. */
export const update = (pid, patch, file = LEDGER_FILE) => withLedger((l) => l.map((e) => (e.pid === pid ? { ...e, ...patch } : e)), file);
/** Drop the entry for `pid`. */
export const unregister = (pid, file = LEDGER_FILE) => withLedger((l) => l.filter((e) => e.pid !== pid), file);

/** Measure every entry's process tree now (`rss`, and its `peak` so far), each without the trees of the others. */
export function measureLedger({ file = LEDGER_FILE, table = processTable() } = {}) {
    return withLedger((l) => {
        const roots = new Set(l.map((e) => e.pid));
        const now = new Date().toISOString();
        return l.map((e) => {
            const rss = treeRss(table, e.pid, new Set([...roots].filter((p) => p !== e.pid)));
            return { ...e, rss, peak: Math.max(e.peak ?? 0, rss), measuredAt: now };
        });
    }, file);
}

/**
 * The budget as it stands: the ceiling, what the ledger's entries use (by kind), what the machine has available, the
 * share kept free, and the ROOM left (whichever runs out first). Every figure in bytes.
 */
export function budgetState({ limit, entries, available, total = os.totalmem(), reserveFrac = RESERVE_FRAC }) {
    const byKind = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + (e.rss ?? 0);
    const used = Object.values(byKind).reduce((a, b) => a + b, 0);
    const reserve = Math.round(total * reserveFrac);
    return { limit, used, byKind, available, total, reserve, room: Math.max(0, Math.min(limit - used, available - reserve)) };
}

/** Whether `need` more bytes fit: `{ ok, why }`, `why` saying which bound it hits, in words a person reads. */
export function admits(state, need) {
    if (state.used + need > state.limit) return { ok: false, why: `the memory limit: the bench holds ${fmtBytes(state.used)} of ${fmtBytes(state.limit)}, and one more browser takes about ${fmtBytes(need)}` };
    if (state.available - need < state.reserve) return { ok: false, why: `free memory: ${fmtBytes(state.available)} available, and ${fmtBytes(state.reserve)} (${Math.round((state.reserve / state.total) * 100)}% of RAM) stays free` };
    return { ok: true, why: null };
}

/** The 90th percentile (nearest rank) of `values`, or null for none. */
export function p90(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)] : null;
}

export const FOOTPRINT_SCHEMA = `
CREATE TABLE IF NOT EXISTS footprints (
    id INTEGER PRIMARY KEY,
    run TEXT NOT NULL,                 -- runs.run: the session hash
    task TEXT NOT NULL,                -- the task's id
    model TEXT,                        -- the driver
    peak_rss INTEGER NOT NULL,         -- the peak resident memory of its browser's process tree, bytes (memory-budget.mjs)
    held INTEGER NOT NULL,             -- 1 when it was then kept open
    at TEXT NOT NULL,
    UNIQUE (run)
);
`;

/** Add the footprints table to an open scores log (a log made before it gains it, empty). */
export const openFootprints = (db) => { db.exec(FOOTPRINT_SCHEMA); return db; };

/** Log one run's measured peak; a run already logged is left as it is. */
export const logFootprint = (db, { run, task, model = null, peak, held }) =>
    Number(db.prepare("INSERT OR IGNORE INTO footprints (run, task, model, peak_rss, held, at) VALUES (?, ?, ?, ?, ?, ?)").run(run, task, model, Math.round(peak), held ? 1 : 0, new Date().toISOString()).changes);

/**
 * What one more browser for `task` is predicted to take: the p90 of the peaks measured for that task, else for every
 * task, else {@link ASSUMED_BROWSER}. `{ bytes, basis, n }`, `basis` saying which.
 */
export function predictBrowser(db, task) {
    const peaks = (where, ...a) => (db ? db.prepare(`SELECT peak_rss AS p FROM footprints ${where}`).all(...a).map((r) => r.p) : []);
    const own = peaks("WHERE task = ?", task);
    if (own.length) return { bytes: p90(own), basis: `p90 of ${own.length} measured run${own.length === 1 ? "" : "s"} of ${task}`, n: own.length };
    const all = peaks("");
    if (all.length) return { bytes: p90(all), basis: `p90 of ${all.length} measured run${all.length === 1 ? "" : "s"} of other tasks`, n: all.length };
    return { bytes: ASSUMED_BROWSER, basis: "assumed: no browser measured yet", n: 0 };
}

/**
 * One sweep's budget: registers the runner in the ledger (its tree holds every browser it runs in-process; held runs'
 * browsers are their own entries), re-measures every `everyMs`, and answers the two questions a sweep asks. `canStart`:
 * may a cell of this task start, its predicted browser and all. `canKeep`: may a finished run stay open; its browser is
 * already counted, so the question is whether one more cell would still fit after it. `active` false (a fake-model sweep
 * that holds nothing) registers and measures, but never says no.
 */
export function startBudget({ limit = autoLimit(), reserveFrac = RESERVE_FRAC, whenFull = "pause", db = null, active = true, sweep = null, repo = null, cmd = null, everyMs = 5000, file = LEDGER_FILE, measure = () => measureLedger({ file }), avail = availableMemory, total = os.totalmem() } = {}) {
    register({ kind: "runner", pid: process.pid, sweep, repo, cmd, heap: process.memoryUsage().heapUsed }, file);
    let entries = measure(), available = avail();
    // Every reading, for the page's chart: what each kind held then, and the room. Halved (every other one dropped)
    // past HISTORY_MAX, so a sweep of hours stays a few hundred points.
    const history = [];
    const record = (st) => {
        history.push({ t: Date.now(), values: { ...st.byKind }, room: st.room });
        if (history.length > HISTORY_MAX) for (let i = history.length - 2; i > 0; i -= 2) history.splice(i, 1);
    };
    const refresh = () => {
        try { update(process.pid, { heap: process.memoryUsage().heapUsed }, file); entries = measure(); available = avail(); } catch { /* keep the last reading */ }
        const st = state();
        record(st);
        return st;
    };
    const state = () => budgetState({ limit, entries, available, total, reserveFrac });
    record(state());
    const timer = setInterval(refresh, everyMs);
    timer.unref?.();
    const predict = (task) => predictBrowser(db, task);
    const ask = (task) => (active ? admits(refresh(), predict(task).bytes) : { ok: true, why: null });
    return {
        limit, whenFull, active, state, refresh, predict,
        entries: () => entries,
        /** The readings so far, oldest first: `{ t, values: { <kind>: bytes }, room }`. */
        history: () => history,
        canStart: ask,
        canKeep: ask,
        /** The peak measured for `pid`'s tree, re-measured now. */
        peakOf(pid) { refresh(); return entries.find((e) => e.pid === pid)?.peak ?? null; },
        /** What to expect, for the start of a sweep over `tasks` running `jobs` at once: how many failed runs can be held. */
        expect(tasks, jobs = 1) {
            const s = refresh();
            const per = tasks.map(predict).sort((a, b) => b.bytes - a.bytes)[0] ?? predict("");
            const n = Math.max(0, Math.floor((s.room - per.bytes * jobs) / per.bytes));
            return { n, room: s.room, per, text: `about ${n} failed run${n === 1 ? "" : "s"} can be held this sweep (${fmtBytes(s.room)} free under the ${fmtBytes(limit)} limit${s.reserve ? ` with ${fmtBytes(s.reserve)} of RAM kept free` : ""}, ~${fmtBytes(per.bytes)} per browser: ${per.basis}). The bench holds ${fmtBytes(s.used)} now${Object.keys(s.byKind).length ? ` (${Object.entries(s.byKind).map(([k, v]) => `${k} ${fmtBytes(v)}`).join(", ")})` : ""}.` };
        },
        stop() { clearInterval(timer); try { unregister(process.pid, file); } catch { /* dropped on the next read */ } },
    };
}

/**
 * When a budget is too small to be worth starting in: room for no browser at all (`error`: the sweep does not start), or
 * for the running cell's only (`warn`: nothing can be held, and `--jobs` above 1 runs one at a time). The text says what
 * to set instead: about `per` for each browser (`jobs` running, `held` kept open) and `bench` for the bench's own
 * processes, and that a limit set by hand drops the free-memory reserve, so past the free RAM it swaps and runs slowly.
 * Null when there is room for two or more.
 */
export function tooSmall({ room, per, bench, limit, reserve, jobs = 1, held = 3, limitGiven = false }) {
    const fit = Math.floor(room / per);
    if (fit >= 2) return null;
    const want = bench + per * (jobs + held);
    const how = `To run anyway, set the budget by hand: --memory-limit ${Math.ceil(want / GB)}G budgets about ${fmtBytes(per)} per browser (${jobs} running cell${jobs === 1 ? "" : "s"} and ${held} failed run${held === 1 ? "" : "s"} held open) and ${fmtBytes(bench)} for the bench itself. A limit set by hand also drops the ${limitGiven ? "" : `${fmtBytes(reserve)} of `}RAM kept free, so past what this machine has free it goes to swap and every run is slower.`;
    const where = `${fmtBytes(room)} free under the ${fmtBytes(limit)} limit${limitGiven || !reserve ? "" : ` with ${fmtBytes(reserve)} of RAM kept free`}, and one browser takes about ${fmtBytes(per)}`;
    return fit === 0
        ? { level: "error", text: `The memory budget has room for no browser: ${where}. ${how}` }
        : { level: "warn", text: `The memory budget has room for one browser only, the running cell's: no failed run can be held${jobs > 1 ? `, and --jobs ${jobs} runs one at a time` : ""} (${where}). ${how}` };
}
