// merge-when-green.test.mjs — the merge rule scripts/merge-when-green.mjs applies to a session's own PR, and what it
// reminds about before a merge: bench results and uncommitted files that live only on a checkout's disk.
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { judge, testLineCounts, diskOnly, keepBench } from "../scripts/merge-when-green.mjs";

// --- the rule: green pipeline, no test removed, nothing unread ---

const green = { sha: "abcdef0123", runId: "1", runStatus: "completed", badJobs: [], deletedTestFiles: 0, tests: { removed: 0, added: 2 }, reviews: 0, inlineComments: 0, stacked: 0, mergeable: "MERGEABLE" };

test("a green PR that adds tests and has no reviews is OK", () => {
    const v = judge(green);
    assert.equal(v.ok, true);
    assert.match(v.reason, /^OK \(run 1 green, tests -0\/\+2 lines\)$/);
});

test("every way the rule fails says why, and only CI still running is pending", () => {
    const cases = [
        [{ runId: null }, /no tests run/, true],
        [{ runStatus: "in_progress" }, /in_progress/, true],
        [{ badJobs: ["e2e=cancelled"] }, /not green: e2e=cancelled/, false],
        [{ deletedTestFiles: 1 }, /deletes a test file/, false],
        [{ tests: { removed: 3, added: 1 } }, /removes tests/, false],
        [{ reviews: 1 }, /read them/, false],
        [{ inlineComments: 2 }, /read them/, false],
        [{ stacked: 1 }, /stacked/, false],
        [{ mergeable: "UNKNOWN" }, /not computed/, true],
        [{ mergeable: "CONFLICTING" }, /not mergeable/, false],
    ];
    for (const [patch, reason, pending] of cases) {
        const v = judge({ ...green, ...patch });
        assert.equal(v.ok, false, JSON.stringify(patch));
        assert.match(v.reason, reason);
        assert.equal(!!v.pending, pending, `pending for ${JSON.stringify(patch)}`);
    }
});

test("a test whose body changes counts the same removed and added, so an edit is not a removal", () => {
    const diff = ["--- a/tests/x.test.mjs", "+++ b/tests/x.test.mjs", '-test("old name", () => {', '+test("new name", () => {', "-    a.test(1)", "+    retest(2)"].join("\n");
    assert.deepEqual(testLineCounts(diff), { removed: 1, added: 1 });
});

// --- the reminder: what a merge would leave behind on disk ---

test("a checkout's bench sweeps, scoreboard and uncommitted files are named; other artifacts are not", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mwg-"));
    const bench = path.join(dir, "tests/e2e/artifacts/bench");
    mkdirSync(path.join(bench, "my-sweep"), { recursive: true });
    writeFileSync(path.join(bench, "my-sweep", "done.json"), "{}");
    mkdirSync(path.join(bench, "not-a-sweep"), { recursive: true });
    writeFileSync(path.join(bench, "scores.sqlite"), "");
    const found = diskOnly(dir, "?? tests/e2e/panel/api-docs.json\n M src/x.ts\n");
    assert.deepEqual(found, { sweeps: ["my-sweep"], scoreDbs: ["scores.sqlite"], files: ["?? tests/e2e/panel/api-docs.json", " M src/x.ts"], server: null });
});

test("a clean checkout with no bench directory has nothing to remind about", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mwg-"));
    assert.deepEqual(diskOnly(dir, ""), { sweeps: [], scoreDbs: [], files: [], server: null });
});

test("a page server a finished sweep left running is found while it lives, and forgotten once its process is gone", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mwg-"));
    const bench = path.join(dir, "tests/e2e/artifacts/bench");
    mkdirSync(bench, { recursive: true });
    writeFileSync(path.join(bench, "server.json"), JSON.stringify({ pid: process.pid, port: 7331, url: "http://127.0.0.1:7331", dir: "x" }));
    assert.equal(diskOnly(dir, "").server.pid, process.pid, "this process stands in for a live server");
    writeFileSync(path.join(bench, "server.json"), JSON.stringify({ pid: 2 ** 22 + 12345, port: 7331, url: "u", dir: "x" }));
    assert.equal(diskOnly(dir, "").server, null, "a pid with no process is a stale file, not a server");
});

// --- --keep-bench: a worktree's results move into the main clone, the scoreboard's rows merge ---

test("keepBench moves sweeps, merges scoreboard rows without doubling one, and leaves a name clash in place", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const wt = mkdtempSync(path.join(os.tmpdir(), "mwg-wt-")), main = mkdtempSync(path.join(os.tmpdir(), "mwg-main-"));
    const B = "tests/e2e/artifacts/bench";
    for (const d of [wt, main]) mkdirSync(path.join(d, B), { recursive: true });
    const db = (d, runs) => {
        const x = new DatabaseSync(path.join(d, B, "scores.sqlite"));
        x.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, run TEXT NOT NULL UNIQUE, model TEXT)");
        for (const r of runs) x.prepare("INSERT INTO runs (run, model) VALUES (?, ?)").run(r, "m");
        x.close();
    };
    db(main, ["a", "b"]);
    db(wt, ["b", "c"]);   // "b" is in both: it must not be counted twice
    for (const n of ["fresh", "clash"]) { mkdirSync(path.join(wt, B, n)); writeFileSync(path.join(wt, B, n, "done.json"), "{}"); }
    mkdirSync(path.join(main, B, "clash"));

    const clashes = await keepBench(wt, main, diskOnly(wt, ""));
    assert.ok(existsSync(path.join(main, B, "fresh", "done.json")), "the sweep moved");
    assert.ok(!existsSync(path.join(wt, B, "fresh")));
    assert.equal(clashes.length, 1);
    assert.match(clashes[0], /clash\/ .*rename/);
    assert.ok(existsSync(path.join(wt, B, "clash", "done.json")), "a clash is left where it was");
    const rows = new DatabaseSync(path.join(main, B, "scores.sqlite")).prepare("SELECT run FROM runs ORDER BY run").all().map((r) => r.run);
    assert.deepEqual(rows, ["a", "b", "c"]);
});
