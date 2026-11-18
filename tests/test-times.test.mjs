// test-times.test.mjs — the timing warnings of scripts/test-times.mjs: each check at its thresholds, the history, the block.
import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
    LIMITS, appendHistory, buildBaseline, checkDisproportionate, checkOutlives, checkSlowerThanHistory, compactHistory,
    finishRun, formatBlock, historyDir, historyRecords, indexHistory, parseRun, percentile, readHistory, warningsFor,
} from "../scripts/test-times.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wml-tt-"));
const t = (ms, name = "x", ok = true) => ({ file: "tests/a.test.mjs", name, ms, ok });
const run = (files) => new Map(files.map((f) => [f.file, { genre: "core", wall: null, sumTop: 0, tests: [], ...f }]));

// --- check (a): a file that outlives its tests ---

test("outlive: the measured case (5 s of tests, 302 s wall) warns with the numbers and the advice", () => {
    const w = checkOutlives({ file: "tests/x.test.mjs", wall: 302_000, sumTop: 5_000 });
    assert.match(w, /^⚠ tests\/x\.test\.mjs: its process stayed alive 297 s after its tests finished \(5\.0 s of tests, 302 s wall\)/);
    assert.match(w, /event loop open.*5-minute timer/);
});
test("outlive: needs more than 20 s past the tests AND more than the tests' own sum", () => {
    assert.equal(checkOutlives({ file: "f", wall: 25_000, sumTop: 5_000 }), null);            // exactly 20 s extra
    assert.notEqual(checkOutlives({ file: "f", wall: 25_100, sumTop: 5_000 }), null);
    assert.equal(checkOutlives({ file: "f", wall: 24_900, sumTop: 5_000 }), null);            // 19.9 s extra
    assert.equal(checkOutlives({ file: "f", wall: 100_000, sumTop: 60_000 }), null);          // 40 s extra but under 2x
    assert.notEqual(checkOutlives({ file: "f", wall: 121_000, sumTop: 60_000 }), null);       // 61 s extra, over the sum
    assert.equal(checkOutlives({ file: "f", wall: null, sumTop: 0 }), null);
});

test("warningsFor: the longest outlive is listed first, so a cap cannot hide it", () => {
    const w = warningsFor(run([
        { file: "tests/short.test.mjs", wall: 30_000, sumTop: 1000 },
        { file: "tests/long.test.mjs", wall: 302_000, sumTop: 5000 },
    ]));
    assert.match(w[0], /long\.test/);
    assert.match(w[1], /short\.test/);
});

// --- check (b): a known test slower than its own history ---

test("history: fires above 3x p90 and 2 s absolute, not at either threshold", () => {
    const prior = [1000, 1000, 1000, 1000, 1000];                          // p90 1000
    assert.notEqual(checkSlowerThanHistory(t(3100), prior), null);
    assert.equal(checkSlowerThanHistory(t(3000), prior), null);            // exactly 3x
    const fast = [100, 100, 100, 100, 100];
    assert.equal(checkSlowerThanHistory(t(1900), fast), null);             // 19x but only 1.8 s slower
    assert.notEqual(checkSlowerThanHistory(t(2200), fast), null);
});
test("history: needs five prior records; fewer fall back to the baseline, else nothing", () => {
    assert.equal(checkSlowerThanHistory(t(9000), [1000, 1000, 1000, 1000]), null);
    assert.match(checkSlowerThanHistory(t(9000), [1000], 1000), /committed baseline/);
    assert.match(checkSlowerThanHistory(t(9000), Array(5).fill(1000), 99_000), /last 5 runs/);   // history wins over the baseline
});
test("history: a failed run is not judged", () => {
    assert.equal(checkSlowerThanHistory(t(90_000, "x", false), Array(5).fill(10)), null);
});

// --- check (c): a new or rare test disproportionately slow ---

test("peers: needs <3 prior, >5x the file median, >5x the genre median, and 2 s", () => {
    assert.notEqual(checkDisproportionate(t(3000), 0, 100, 100, "core"), null);
    assert.equal(checkDisproportionate(t(3000), 3, 100, 100, "core"), null);        // three prior records: known
    assert.equal(checkDisproportionate(t(3000), 2, 600, 100, "core"), null);        // only 5x its file
    assert.equal(checkDisproportionate(t(3000), 2, 100, 600, "core"), null);        // only 5x its genre
    assert.equal(checkDisproportionate(t(1900), 0, 1, 1, "core"), null);            // under the 2 s floor
});
test("peers: a python test is judged against the python genre, not core", () => {
    const r = run([
        { file: "tests/py.test.mjs", genre: "python", tests: [{ name: "boot", ms: 3000, ok: true }, { name: "b", ms: 2500, ok: true }, { name: "c", ms: 2800, ok: true }] },
        { file: "tests/c.test.mjs", genre: "core", tests: [{ name: "q", ms: 5, ok: true }, { name: "r", ms: 5, ok: true }] },
    ]);
    // "boot" is 600x core's median but not python's: no warning. The same test filed under core warns.
    assert.deepEqual(warningsFor(r), []);
    r.get("tests/py.test.mjs").genre = "core";
    r.get("tests/py.test.mjs").tests.push({ name: "tiny", ms: 4, ok: true });
    r.get("tests/py.test.mjs").tests.push({ name: "tiny2", ms: 4, ok: true });
    r.get("tests/py.test.mjs").tests.push({ name: "tiny3", ms: 4, ok: true });
    r.get("tests/py.test.mjs").tests.push({ name: "tiny4", ms: 4, ok: true });
    r.get("tests/py.test.mjs").tests.push({ name: "tiny5", ms: 4, ok: true });
    assert.ok(warningsFor(r).some((w) => /"boot"/.test(w)));
});
test("warningsFor: a test with a history is judged by (b), not also by (c)", () => {
    const r = run([{ file: "tests/a.test.mjs", tests: [t(9000, "slow"), t(5, "a"), t(5, "b")] }]);
    const history = indexHistory(Array(5).fill(0).map(() => ({ file: "tests/a.test.mjs", name: "slow", ms: 1000, ok: true })));
    const w = warningsFor(r, { history });
    assert.equal(w.length, 1);
    assert.match(w[0], /usual p90/);
});
test("warningsFor: a test in the committed baseline is known, not new, however thin the local history", () => {
    // The first full run after seeding: every slow test had one record, and (c) flagged 80 of them as new.
    const r = run([{ file: "tests/a.test.mjs", tests: [t(6000, "slow by design"), t(5, "a"), t(5, "b")] }]);
    assert.equal(warningsFor(r).length, 1);                                                          // unknown: new
    assert.deepEqual(warningsFor(r, { baseline: { "tests/a.test.mjs": { "slow by design": 5900 } } }), []);
});

// --- parsing the reporter's lines ---

test("parseRun: relative paths, top-level sum excludes nested tests and suites are not tests", () => {
    const L = (o) => JSON.stringify(o);
    const f = path.join(ROOT, "tests", "a.test.mjs");
    const text = [
        L({ k: "test", file: f, name: "inner", ms: 5, ok: true, nesting: 1, suite: false }),
        L({ k: "test", file: f, name: "outer", ms: 7, ok: true, nesting: 0, suite: false }),
        L({ k: "test", file: f, name: "S", ms: 9, ok: true, nesting: 0, suite: true }),
        "not json", L({ k: "file", file: f, ms: 500 }),
    ].join("\n");
    const r = parseRun(text, ROOT, () => "ext").get("tests/a.test.mjs");
    assert.deepEqual([r.wall, r.sumTop, r.genre, r.tests.map((x) => x.name)], [500, 16, "ext", ["inner", "outer"]]);
});
test("reporter: a real node:test child yields a file wall time that includes a leaked timer", () => {
    const d = realpathSync(tmp());
    writeFileSync(path.join(d, "leak.test.mjs"), `import t from "node:test"; t("quick", () => {}); setTimeout(() => {}, 600);\n`);
    const out = path.join(d, "o.jsonl");
    spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--test-reporter-destination=stderr",
        `--test-reporter=${path.join(ROOT, "scripts", "test-times-reporter.mjs")}`, `--test-reporter-destination=${out}`, path.join(d, "leak.test.mjs")], { cwd: d, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")) });
    const f = [...parseRun(readFileSync(out, "utf8"), d).values()][0];
    assert.equal(f.file, "leak.test.mjs");
    assert.deepEqual(f.tests.map((x) => x.name), ["quick"]);
    assert.ok(f.wall - f.sumTop > 500, `wall ${f.wall} sum ${f.sumTop}`);
    rmSync(d, { recursive: true, force: true });
});

// --- the history file ---

test("history: appended records are read back and keyed by file + name", () => {
    const dir = tmp();
    assert.equal(appendHistory(historyRecords(run([{ file: "tests/a.test.mjs", tests: [t(500, "one"), t(5, "fast")] }]), { head: "abc" }), { dir }), true);
    const back = readHistory(dir);
    assert.equal(back.length, 1);                       // 5 ms is under recordMinMs
    assert.deepEqual([back[0].file, back[0].name, back[0].ms, back[0].genre, back[0].head, back[0].ok], ["tests/a.test.mjs", "one", 500, "core", "abc", true]);
    assert.match(back[0].ts, /^\d{4}-/);
    rmSync(dir, { recursive: true, force: true });
});
test("history: bounded to the newest N records per test, compacted once the file is large", () => {
    const recs = Array.from({ length: 50 }, (_, i) => ({ file: "f", name: "a", ms: i, ok: true }));
    recs.push({ file: "f", name: "b", ms: 1, ok: true });
    const kept = compactHistory(recs, 30);
    assert.deepEqual(kept.filter((r) => r.name === "a").map((r) => r.ms), Array.from({ length: 30 }, (_, i) => 20 + i));
    assert.equal(kept.length, 31);
    const dir = tmp();
    for (let i = 0; i < 5; i++) appendHistory(Array.from({ length: 10 }, () => ({ file: "f", name: "a", ms: i, ok: true })), { dir, compactBytes: 300, keep: 8 });
    assert.ok(readHistory(dir).length <= 18, String(readHistory(dir).length));
    rmSync(dir, { recursive: true, force: true });
});
test("history: an unwritable folder returns false and does not throw", () => {
    const dir = tmp();
    const ro = path.join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    const blockedByFile = path.join(dir, "afile");
    writeFileSync(blockedByFile, "x");
    assert.equal(appendHistory([{ file: "f", name: "a", ms: 1, ok: true }], { dir: path.join(blockedByFile, "sub") }), false);
    assert.doesNotThrow(() => appendHistory([{ file: "f", name: "a", ms: 1, ok: true }], { dir: path.join(ro, "sub") }));
    assert.deepEqual(readHistory(path.join(dir, "missing")), []);
    chmodSync(ro, 0o700);
    rmSync(dir, { recursive: true, force: true });
});
test("history: TEST_TIMES_DIR overrides the machine-wide default, which is under ~/.cache/window-ml", () => {
    assert.equal(historyDir({ TEST_TIMES_DIR: "/x/y" }), "/x/y");
    assert.equal(historyDir({}), path.join(os.homedir(), ".cache", "window-ml", "test-times"));
});

// --- the baseline ---

test("baseline: p90 rounded to 100 ms, only tests of 500 ms and up", () => {
    const recs = [100, 200, 300, 400, 1000].map((ms) => ({ file: "f", name: "slow", ms, ok: true }))
        .concat([{ file: "f", name: "quick", ms: 449, ok: true }]);
    const { tests, count } = buildBaseline(recs);
    assert.equal(count, 1);
    assert.deepEqual(tests, { f: { slow: Math.round(percentile([100, 200, 300, 400, 1000], 0.9) / 100) * 100 } });
});

// --- the block ---

test("block: silent when empty; header addressed to the reader; capped with 'and N more'", () => {
    assert.equal(formatBlock([]), "");
    const b = formatBlock(Array.from({ length: 13 }, (_, i) => `w${i}`));
    const lines = b.split("\n");
    assert.match(lines[1], /^test timings — warnings for whoever ran this \(the run's result is unchanged\):$/);
    assert.equal(lines.length, 1 + 1 + 10 + 1);
    assert.equal(lines.at(-1), "and 3 more");
    assert.equal(formatBlock(["w"], 10).includes("more"), false);
});

// --- finishRun and the exit code ---

test("finishRun: prints the block, writes history outside CI, writes none in CI, and never throws on garbage", () => {
    const dir = tmp();
    const f = path.join(ROOT, "tests", "z.test.mjs");
    const text = [JSON.stringify({ k: "test", file: f, name: "t", ms: 300, ok: true, nesting: 0, suite: false }), JSON.stringify({ k: "file", file: f, ms: 90_000 })].join("\n");
    let out = "";
    const block = finishRun({ reporterText: text, root: ROOT, genreOf: () => "core", write: (s) => { out += s; }, env: { TEST_TIMES_DIR: dir } });
    assert.match(out, /process stayed alive/);
    assert.equal(block.length > 0, true);
    assert.equal(readHistory(dir).length, 1);
    const dir2 = tmp();
    finishRun({ reporterText: text, root: ROOT, genreOf: () => "core", write() {}, env: { TEST_TIMES_DIR: dir2, CI: "1" } });
    assert.equal(readHistory(dir2).length, 0);
    finishRun({ reporterText: text, root: ROOT, genreOf: () => "core", write() {}, env: { TEST_TIMES_DIR: dir2, CI: "1", TEST_TIMES_HISTORY: "1" } });
    assert.equal(readHistory(dir2).length, 1);
    assert.doesNotThrow(() => finishRun({ reporterText: "\u0000garbage\n{", root: ROOT, genreOf: () => { throw new Error("x"); }, write() {}, env: { TEST_TIMES_DIR: dir } }));
    assert.doesNotThrow(() => finishRun({ reporterText: undefined, root: ROOT, genreOf: () => "core", write() {}, env: {} }));
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
});
test("exit code: the runner passes the child's code through unchanged after the timing block", () => {
    const src = readFileSync(path.join(ROOT, "scripts", "test.mjs"), "utf8");
    assert.match(src, /\(c\) => \{ timings\(\); process\.exit\(c\); \}/);
    assert.match(src, /timings\(\); process\.exit\(1\)/);
    assert.match(src, /finishRun\([^]*?catch \{ \/\* advice only \*\/ \}/);     // advice is wrapped: a timing failure cannot reach the exit code
    assert.equal(LIMITS.cap, 10);
});
