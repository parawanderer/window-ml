// test-times.mjs — timing WARNINGS for a test run: a file that outlives its tests, a test far past its own history, a new test far past its peers.
//
// Why: a test left an approval ask pending and the ask's 5-minute timer kept its file's process alive for 302 s while its
// tests took 5 s. The run was green and said nothing, and it held the machine-wide test queue's slot the whole time.
// Everything here is advice printed at the END of a run for whoever ran it: it never changes an exit code and never throws.
//
// Data: scripts/test-times-reporter.mjs writes one JSON line per test and per file while `scripts/test.mjs` runs; this
// module turns them into records, compares them with the history (a machine-wide JSONL file shared by every clone, keyed by
// repo-relative file + test name) or, when the history is thin, with the committed tests/test-times-baseline.json, prints
// the block, and appends the run to the history. docs/dev/working-in-the-repo.md, "Test timings".

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Thresholds, in one place so the docs and the tests name the same numbers. */
export const LIMITS = {
    /** Check (a): wall minus tests must exceed this, and exceed the tests' own sum. */
    outliveMs: 20_000,
    /** Check (b): a known test is slow when above this multiple of its p90, by at least `slowerByMs`. */
    p90Factor: 3,
    /** Check (b): prior records needed (history or baseline) before a test counts as known. */
    knownRecords: 5,
    /** Checks (b) and (c): the absolute floor. A test is never flagged for being a little slower. */
    slowerByMs: 2_000,
    /** Check (c): fewer prior records than this makes a test new or rare. */
    rareRecords: 3,
    /** Check (c): multiple of the median of the test's file AND of its genre. */
    peerFactor: 5,
    /** Warnings printed before "and N more". */
    cap: 10,
    /** History: records kept per test, and the shortest test written at all (the history is every run of every clone). */
    keepPerTest: 30,
    recordMinMs: 100,
    /** History: the file is compacted when it grows past this many bytes. */
    compactBytes: 3_000_000,
    /** Baseline: only tests at or above this are listed. */
    baselineMinMs: 500,
};

/** The machine-wide folder: `TEST_TIMES_DIR` overrides it (the tests do). */
export function historyDir(env = process.env) {
    return env.TEST_TIMES_DIR || path.join(os.homedir(), ".cache", "window-ml", "test-times");
}

/**
 * Parse the reporter's JSON lines into per-file records, with paths made repo-relative.
 *
 * @param {string} text the reporter's output
 * @param {string} root the repo root the files are relative to
 * @param {(file: string) => string} genreOf the genre of a repo-relative file
 * @returns {Map<string, {file: string, genre: string, wall: number|null, sumTop: number, tests: {name: string, ms: number, ok: boolean, first: boolean}[]}>}
 */
export function parseRun(text, root, genreOf = () => "core") {
    const files = new Map();
    const get = (abs) => {
        const file = path.relative(root, abs).split(path.sep).join("/");
        if (!files.has(file)) files.set(file, { file, genre: genreOf(file), wall: null, sumTop: 0, tests: [] });
        return files.get(file);
    };
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || typeof r.file !== "string") continue;
        const f = get(r.file);
        if (r.k === "file") f.wall = r.ms;
        else if (r.k === "test") {
            if (r.nesting === 0) f.sumTop += r.ms;
            if (!r.suite) f.tests.push({ name: String(r.name), ms: r.ms, ok: !!r.ok, first: !!r.first });
        }
    }
    return files;
}

/** The p-th percentile (0..1) of a list, linear interpolation. */
export function percentile(xs, p) {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

const sec = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const key = (file, name) => `${file}\u0000${name}`;

/**
 * Group history records by test: key (file + name) to the durations of the passing records, oldest first.
 * @param {{file: string, name: string, ms: number, ok: boolean}[]} records
 */
export function indexHistory(records) {
    const by = new Map();
    for (const r of records) {
        if (!r.ok) continue;
        const k = key(r.file, r.name);
        (by.get(k) ?? by.set(k, []).get(k)).push(r.ms);
    }
    return by;
}

/**
 * Check (a): the file's process outlived its tests. Wall time minus the top-level tests' sum must exceed both
 * `outliveMs` and the sum itself.
 *
 * @param {{file: string, wall: number|null, sumTop: number}} f
 * @returns {string|null} the warning, or null
 */
export function checkOutlives(f) {
    if (f.wall == null) return null;
    const extra = f.wall - f.sumTop;
    if (extra <= Math.max(LIMITS.outliveMs, f.sumTop)) return null;
    return `⚠ ${f.file}: its process stayed alive ${sec(extra)} after its tests finished (${sec(f.sumTop)} of tests, ${sec(f.wall)} wall). `
        + "Something keeps the event loop open: a timer, server, socket or child process a test started and did not stop. "
        + "Find it and stop it in the test (an unanswered ask holds a 5-minute timer).";
}

/**
 * Check (b): a known test (at least `knownRecords` prior durations) slower than `p90Factor` times its own p90, and
 * by at least `slowerByMs`. `prior` is the history's durations, or one number (the baseline's p90) with `baselineP90`.
 *
 * @param {{file: string, name: string, ms: number, ok: boolean}} t
 * @param {number[]} prior durations from the history, excluding this run
 * @param {number|undefined} baselineP90 the committed baseline's p90, used when `prior` is too short
 * @returns {string|null}
 */
export function checkSlowerThanHistory(t, prior, baselineP90) {
    if (!t.ok) return null;
    let p90, n, src;
    if (prior.length >= LIMITS.knownRecords) { p90 = percentile(prior, 0.9); n = prior.length; src = `its last ${n} runs`; }
    else if (baselineP90 != null) { p90 = baselineP90; src = "the committed baseline"; }
    else return null;
    if (t.ms <= LIMITS.p90Factor * p90 || t.ms - p90 < LIMITS.slowerByMs) return null;
    return `⚠ ${t.file}: "${t.name}" took ${sec(t.ms)}, ${(t.ms / p90).toFixed(1)}x its usual p90 of ${sec(p90)} (${src}). `
        + "Something in the change, or in a leftover timer or poll, made it wait; find what it waits for.";
}

/**
 * Check (c): a new or rare test (fewer than `rareRecords` prior records) that is more than `peerFactor` times the median
 * of its file's tests AND of its genre's tests, and at least `slowerByMs`. The genre comparison is why a python test is not
 * judged against a pure-module one.
 *
 * @param {{file: string, name: string, ms: number, ok: boolean}} t
 * @param {number} priorCount how many prior records the test has
 * @param {number} fileMedian median duration of the tests in its file this run
 * @param {number} genreMedian median duration of the tests in its genre this run
 * @param {string} genre
 * @returns {string|null}
 */
export function checkDisproportionate(t, priorCount, fileMedian, genreMedian, genre) {
    if (!t.ok || priorCount >= LIMITS.rareRecords || t.ms < LIMITS.slowerByMs) return null;
    if (!(t.ms > LIMITS.peerFactor * fileMedian) || !(t.ms > LIMITS.peerFactor * genreMedian)) return null;
    return `⚠ ${t.file}: "${t.name}" took ${sec(t.ms)}, over ${LIMITS.peerFactor}x the median of its file (${sec(fileMedian)}) and of the ${genre} genre (${sec(genreMedian)}), `
        + `and it has ${priorCount} earlier record(s). A slow test by design belongs in a named genre; otherwise find what it waits for.`;
}

/**
 * Run all three checks over one run.
 *
 * @param {Map<string, ReturnType<typeof parseRun> extends Map<any, infer V> ? V : never>} run
 * @param {{ history?: Map<string, number[]>, baseline?: Record<string, Record<string, number>> }} [ctx]
 * @returns {string[]} warnings, in the order (a), (b), (c)
 */
export function warningsFor(run, { history = new Map(), baseline = {} } = {}) {
    const out = { a: [], b: [], c: [] };
    const genreMs = new Map();
    for (const f of run.values()) for (const t of f.tests) (genreMs.get(f.genre) ?? genreMs.set(f.genre, []).get(f.genre)).push(t.ms);
    for (const f of run.values()) {
        const a = checkOutlives(f);
        if (a) out.a.push({ w: a, extra: f.wall - f.sumTop });
        const fileMedian = percentile(f.tests.map((t) => t.ms), 0.5);
        const genreMedian = percentile(genreMs.get(f.genre) ?? [], 0.5);
        for (const t of f.tests) {
            const prior = history.get(key(f.file, t.name)) ?? [];
            const rec = { file: f.file, name: t.name, ms: t.ms, ok: t.ok };
            const b = checkSlowerThanHistory(rec, prior, baseline[f.file]?.[t.name]);
            if (b) out.b.push(b);
            // A test in the committed baseline is not new, however thin the local history: its slowness is known. The file's
            // first top-level test carries the file's top-level before() hooks, so it is not comparable with its peers.
            else if (baseline[f.file]?.[t.name] == null && !t.first) {
                const c = checkDisproportionate(rec, prior.length, fileMedian, genreMedian, f.genre);
                if (c) out.c.push(c);
            }
        }
    }
    // The worst outlive first: under a cap, the 300 s file must not sit behind twenty files held 20 s.
    return [...out.a.sort((x, y) => y.extra - x.extra).map((x) => x.w), ...out.b, ...out.c];
}

/**
 * The block printed at the end of a run: a header addressed to the reader, at most `cap` warnings, then "and N more".
 * Empty string when there is nothing to say.
 * @param {string[]} warnings
 */
export function formatBlock(warnings, cap = LIMITS.cap) {
    if (!warnings.length) return "";
    const shown = warnings.slice(0, cap);
    const lines = ["", "test timings — warnings for whoever ran this (the run's result is unchanged):", ...shown];
    if (warnings.length > cap) lines.push(`and ${warnings.length - cap} more`);
    return lines.join("\n");
}

/**
 * Read the history file. Unreadable or missing is an empty history; a torn line is skipped.
 * @returns {{file: string, name: string, ms: number, ok: boolean}[]}
 */
export function readHistory(dir = historyDir()) {
    try {
        const out = [];
        for (const line of readFileSync(path.join(dir, "history.jsonl"), "utf8").split("\n")) {
            if (!line) continue;
            try { const r = JSON.parse(line); if (r && typeof r.file === "string") out.push(r); } catch { /* torn line */ }
        }
        return out;
    } catch { return []; }
}

/** Keep the newest `keep` records of each test (file + name), in their original order. */
export function compactHistory(records, keep = LIMITS.keepPerTest) {
    const seen = new Map();
    const kept = [];
    for (let i = records.length - 1; i >= 0; i--) {
        const k = key(records[i].file, records[i].name);
        const n = seen.get(k) ?? 0;
        if (n < keep) { kept.push(records[i]); seen.set(k, n + 1); }
    }
    return kept.reverse();
}

/**
 * Append a run's records to the machine-wide history, compacting it when it has outgrown `compactBytes`. Never throws:
 * an unwritable folder returns false.
 *
 * @param {object[]} records
 * @param {{dir?: string, compactBytes?: number, keep?: number}} [o]
 * @returns {boolean} whether the records were written
 */
export function appendHistory(records, { dir = historyDir(), compactBytes = LIMITS.compactBytes, keep = LIMITS.keepPerTest } = {}) {
    try {
        if (!records.length) return true;
        mkdirSync(dir, { recursive: true });
        const f = path.join(dir, "history.jsonl");
        appendFileSync(f, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
        if (statSync(f).size > compactBytes) {
            const tmp = f + `.${process.pid}.tmp`;
            writeFileSync(tmp, compactHistory(readHistory(dir), keep).map((r) => JSON.stringify(r)).join("\n") + "\n");
            renameSync(tmp, f);
        }
        return true;
    } catch { return false; }
}

/** The history rows for a run: tests of at least `recordMinMs`, stamped with genre, time and git head. */
export function historyRecords(run, { head = "", now = new Date() } = {}) {
    const rows = [];
    for (const f of run.values()) for (const t of f.tests) {
        if (t.ms < LIMITS.recordMinMs) continue;
        rows.push({ file: f.file, name: t.name, ms: Math.round(t.ms), genre: f.genre, ok: t.ok, ts: now.toISOString(), head });
    }
    return rows;
}

/** Read the committed baseline `{ file: { name: p90ms } }`; missing or malformed is empty. */
export function readBaseline(file) {
    try { return JSON.parse(readFileSync(file, "utf8")).tests ?? {}; } catch { return {}; }
}

/** How many tests a baseline lists. */
export const baselineCount = (tests) => Object.values(tests).reduce((n, byName) => n + Object.keys(byName).length, 0);

/**
 * Why a rebuilt baseline must not replace the committed one, or null when it may: it is empty (a machine with no
 * history), or under half the committed one's tests (a thin history, not a suite that shrank). `force` writes anyway.
 * @param {number} built tests in the rebuilt baseline
 * @param {number} committed tests in the committed baseline
 */
export function baselineRefusal(built, committed, force = false) {
    if (force) return null;
    if (built === 0) return `the history here has no test at or above ${LIMITS.baselineMinMs} ms; the committed baseline (${committed} tests) is kept`;
    if (built < committed / 2) return `the rebuilt baseline lists ${built} tests, under half the committed one's ${committed}: this machine's history is too thin to replace it (--force writes it anyway)`;
    return null;
}

/**
 * Build the committed baseline from the history: per test at or above `baselineMinMs`, the p90 rounded to 100 ms.
 * @returns {{tests: Record<string, Record<string, number>>, count: number}}
 */
export function buildBaseline(records) {
    const tests = {};
    let count = 0;
    for (const [k, xs] of indexHistory(records)) {
        const p90 = Math.round(percentile(xs, 0.9) / 100) * 100;
        if (p90 < LIMITS.baselineMinMs) continue;
        const [file, name] = k.split("\u0000");
        (tests[file] ??= {})[name] = p90;
        count++;
    }
    const sorted = Object.fromEntries(Object.keys(tests).sort().map((f) => [f, Object.fromEntries(Object.entries(tests[f]).sort(([a], [b]) => (a < b ? -1 : 1)))]));
    return { tests: sorted, count };
}

/**
 * After a run: read the reporter's lines, print the warning block, append to the history. Never throws, never exits.
 *
 * @param {{reporterText: string, root: string, genreOf: (f: string) => string, write?: (s: string) => void, env?: NodeJS.ProcessEnv, head?: string}} o
 * @returns {string} the block printed ("" for none)
 */
export function finishRun({ reporterText, root, genreOf, write = (s) => process.stdout.write(s), env = process.env, head = "" }) {
    try {
        const run = parseRun(reporterText, root, genreOf);
        const dir = historyDir(env);
        const history = indexHistory(readHistory(dir));
        const block = formatBlock(warningsFor(run, { history, baseline: readBaseline(path.join(root, "tests", "test-times-baseline.json")) }));
        if (block) write(block + "\n");
        const onCi = !!(env.CI || env.GITHUB_ACTIONS);
        if (!onCi || env.TEST_TIMES_HISTORY === "1") appendHistory(historyRecords(run, { head }), { dir });
        return block;
    } catch { return ""; }
}
