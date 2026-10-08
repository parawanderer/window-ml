// vitals.test.mjs — the pure half of `scripts/vitals.mjs`: how a path, a commit subject and a CI run are counted,
// and how a fresh computation merges into the recorded history without losing what GitHub has since aged out.

import { test } from "node:test";
import assert from "node:assert/strict";

const { pathKind, commitKind, monthsBetween, monthEnd, commitsByMonth, ciByMonth, mergeHistory } = await import("../scripts/vitals.mjs");

// --- classifying paths and commits ---

test("a path is test, data or generated before it is code", () => {
    assert.equal(pathKind("src/sw/sw-llm.ts"), "code");
    assert.equal(pathKind("tests/agent.test.js"), "test");
    assert.equal(pathKind("crates/hub/tests/auth.rs"), "test");
    assert.equal(pathKind("src/x.test.mjs"), "test");
    assert.equal(pathKind("tests/e2e/fixtures/events-gen-timings.json"), "data");
    assert.equal(pathKind("tests/fixtures/boxes.mjs"), "data");
    assert.equal(pathKind("src/proto/wmlhub/v1/hub.gen.ts"), "generated");
    assert.equal(pathKind("docs/dev/archive.md"), "docs");
    assert.equal(pathKind("README.md"), "docs");
    assert.equal(pathKind("manifest.json"), "data");
    assert.equal(pathKind("LICENSE"), "other");
});

test("a commit's kind comes from its conventional prefix, scope and bang included", () => {
    assert.equal(commitKind("feat(agent): the model is told where"), "feat");
    assert.equal(commitKind("fix: a thing"), "fix");
    assert.equal(commitKind("refactor!: break it"), "refactor");
    assert.equal(commitKind("tests: plural spelling"), "test");
    assert.equal(commitKind("Revert \"feat: x\""), "revert");
    assert.equal(commitKind("Merge remote-tracking branch 'origin/main'"), "merge");
    assert.equal(commitKind("wip: unknown prefix"), "other");
    assert.equal(commitKind("Add a thing"), "other");
});

// --- months ---

test("months run inclusively across a year boundary, and a month ends at the next one's first instant", () => {
    assert.deepEqual(monthsBetween("2026-11-30T23:00:00Z", "2027-02-01T00:00:00Z"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
    assert.deepEqual(monthsBetween("2026-07-04T00:00:00Z", "2026-07-20T00:00:00Z"), ["2026-07"]);
    assert.equal(monthEnd("2026-12"), "2027-01-01T00:00:00.000Z");
});

test("commits are tallied by month and kind", () => {
    const t = commitsByMonth([
        { date: "2026-09-01T10:00:00+02:00", subject: "feat: a" },
        { date: "2026-09-30T23:30:00-02:00", subject: "fix: b" },
        { date: "2026-09-15T00:00:00Z", subject: "fix(ui): c" },
    ]);
    assert.deepEqual(t["2026-09"], { total: 2, feat: 1, fix: 1 });
    assert.deepEqual(t["2026-10"], { total: 1, fix: 1 }, "a timestamp is bucketed in UTC");
});

// --- CI ---

test("CI runs split into pushes to main and pull requests; branch pushes and runs in progress are left out", () => {
    const t = ciByMonth([
        { created: "2026-09-02T00:00:00Z", event: "push", branch: "main", conclusion: "success" },
        { created: "2026-09-02T00:00:00Z", event: "push", branch: "main", conclusion: "failure" },
        { created: "2026-09-02T00:00:00Z", event: "push", branch: "main", conclusion: "timed_out" },
        { created: "2026-09-02T00:00:00Z", event: "pull_request", branch: "feat/x", conclusion: "cancelled" },
        { created: "2026-09-02T00:00:00Z", event: "push", branch: "feat/x", conclusion: "failure" },
        { created: "2026-09-02T00:00:00Z", event: "pull_request", branch: "feat/x", conclusion: null },
    ]);
    assert.deepEqual(t["2026-09"].main, { runs: 3, success: 1, failure: 2, cancelled: 0 });
    assert.deepEqual(t["2026-09"].pr, { runs: 1, success: 0, failure: 0, cancelled: 1 });
});

// --- merging into the recorded history ---

test("a CI lane whose run count fell keeps the recorded figure, because GitHub aged runs out", () => {
    const old = { repos: { r: { months: { "2026-07": { ci: { main: { runs: 30, success: 20, failure: 10, cancelled: 0 } } } } } } };
    const fresh = { repos: { r: { months: { "2026-07": { ci: { main: { runs: 4, success: 4, failure: 0, cancelled: 0 }, pr: { runs: 2, success: 2, failure: 0, cancelled: 0 } } } } } } };
    const m = mergeHistory(old, fresh).repos.r.months["2026-07"];
    assert.equal(m.ci.main.runs, 30);
    assert.equal(m.ci.pr.runs, 2, "a lane the record did not have is taken");
});

test("fresh git figures replace recorded ones, and a fork's earlier diff snapshot survives", () => {
    const old = {
        repos: { r: { months: { "2026-10": { lines: { total: 1 }, partial: true } } } },
        forks: { f: { months: { "2026-09": { diff: { additions: 5 } } } } },
    };
    const fresh = {
        repos: { r: { months: { "2026-10": { lines: { total: 2 } } } } },
        forks: { f: { months: { "2026-09": { commits: { total: 3 } }, "2026-10": { diff: { additions: 9 } } } } },
    };
    const out = mergeHistory(old, fresh);
    assert.deepEqual(out.repos.r.months["2026-10"], { lines: { total: 2 } }, "a finished month loses its partial mark");
    assert.deepEqual(out.forks.f.months["2026-09"], { diff: { additions: 5 }, commits: { total: 3 } });
    assert.equal(out.forks.f.months["2026-10"].diff.additions, 9);
    assert.equal(old.repos.r.months["2026-10"].lines.total, 1, "the recorded history is not mutated");
});
