// The bench's regression suite: every task deciding whether it is in (spec.ts `regression`, checked by the type and at
// load), the suite's spec gathered from every spec (specs/regression.bench.ts), runs logged with `suite`, and the
// verdict (regress.mjs): a build-wide shift μ, each task's shift δ flagged by the false discovery rate, and the scoreboard
// page and scores.md showing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { sigmoid } from "../tests/e2e/bench/rasch.mjs";
import { fitRasch } from "../tests/e2e/bench/rasch.mjs";
import { openScores, logRuns, readRuns, runRow, scoreboard, scoresText, modelKey } from "../tests/e2e/bench/scores.mjs";
import { regressionVerdict, regressionHistory, plannedPower, normalCdf, REGRESSION_SUITE } from "../tests/e2e/bench/regress.mjs";
import { scoresPage } from "../tests/e2e/bench/serve.mjs";
import { loadSpec } from "../tests/e2e/bench/hold.mjs";
const { checkRegression, defineBench } = await import("../tests/e2e/bench/spec.ts");
const { suiteSources, regressionSpec } = await import("../tests/e2e/bench/specs/regression.bench.ts");

let sqlite = true;
try { await import("node:sqlite"); } catch { sqlite = false; }
const needsSqlite = { skip: sqlite ? false : "this Node has no node:sqlite" };
const SPECS = path.resolve(import.meta.dirname, "e2e/bench/specs");

/**
 * Regression runs with no noise: for each build, model and task, `n` runs passing in exactly the share
 * σ(θ − b − shift) says. `shifts[build][task]` is the build's true shift.
 */
function runs({ thetas, bs, builds, shifts = {}, n = 12 }) {
    const rows = [];
    let at = 0;
    for (const build of builds) for (const [model, th] of Object.entries(thetas)) for (const [task, b] of Object.entries(bs)) {
        const k = Math.round(n * sigmoid(th - b - (shifts[build]?.[task] ?? 0)));
        for (let i = 0; i < n; i++) rows.push({
            suite: REGRESSION_SUITE, scored: 1, error: null, passed: i < k ? 1 : 0, build, at: new Date(Date.UTC(2026, 9, 1) + at++ * 1000).toISOString(),
            task, task_hash: "h", task_text: `the ${task} task`, model, digest: null,
        });
    }
    return rows;
}
const THETAS = { a: 1.5, b: 0.5, c: -0.5 };
const BS = { t1: -1, t2: 0, t3: 0.5, t4: 1, t5: -0.5, t6: 0.2 };
const verdict = (rows, opts = {}) => regressionVerdict(rows, { modelKey, ...opts });

// --- every task decides ---

test("every spec here loads, and every task in it says whether it is in the regression suite and why", async () => {
    const sources = await suiteSources(SPECS);
    assert.ok(sources.length >= 3, "smoke, pointer-ids and tool-use at least");
    for (const { file, spec } of sources) for (const t of spec.tasks) {
        assert.equal(typeof t.regression?.included, "boolean", `${file}: ${t.id}`);
        assert.ok(t.regression.reason.trim().length > 10, `${file}: ${t.id} gives a reason`);
    }
});

test("a task with no decision, or a reason of only spaces, is refused at load", () => {
    assert.throws(() => checkRegression([{ id: "x" }], "s.bench.ts"), /task x needs `regression/);
    assert.throws(() => checkRegression([{ id: "x", regression: { included: true, reason: "  " } }], "s"), /with a reason/);
    assert.throws(() => defineBench({ name: "s", dimensions: {}, tasks: [{ id: "x", task: "t", regression: { included: false, reason: "" } }] }), /task x/);
    assert.doesNotThrow(() => checkRegression([{ id: "x", regression: { included: false, reason: "a calibration task" } }], "s"));
});

// --- the suite's spec ---

test("the suite gathers every included task over the models given, logged as the regression suite", async () => {
    const spec = await loadSpec(path.join(SPECS, "regression.bench.ts"), { models: ["m1", "m2"] });
    assert.equal(spec.suite, "regression");
    assert.deepEqual(spec.dimensions, { model: ["m1", "m2"] });
    assert.deepEqual(spec.tasks.map((t) => t.id).sort(), ["csv-total", "find-out", "shadow-reveal", "show-me", "spa-rendered"]);
    assert.deepEqual(spec.apply({ model: "m2" }), { backend: { model: "m2" } });
    assert.ok(spec.tasks.every((t) => t.timeoutMs === 300000), "each task keeps its own spec's timeout");
    await assert.rejects(loadSpec(path.join(SPECS, "regression.bench.ts"), {}), /needs a model list/);
});

test("two specs including a task of the same id are refused rather than run as one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-regress-"));
    const spec = (name) => `export default { name: "${name}", dimensions: {}, tasks: [{ id: "same", task: "t", regression: { included: true, reason: "a fixed local answer" } }] };\n`;
    fs.writeFileSync(path.join(dir, "a.bench.ts"), spec("a"));
    fs.writeFileSync(path.join(dir, "b.bench.ts"), spec("b"));
    await assert.rejects(regressionSpec({ models: ["m"], dir }), /"same" is in both a\.bench\.ts and b\.bench\.ts/);
});

test("a regression run is logged with its suite; a log from before the column gains it, empty", needsSqlite, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-regress-"));
    const file = path.join(dir, "scores.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    // The old schema, as a scoreboard written before `suite` has it.
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, run TEXT NOT NULL UNIQUE, at TEXT NOT NULL, by TEXT NOT NULL, sweep TEXT NOT NULL, spec TEXT, spec_hash TEXT, task TEXT NOT NULL, task_hash TEXT NOT NULL, task_text TEXT, variant TEXT NOT NULL, scored INTEGER NOT NULL, model TEXT NOT NULL, digest TEXT, quant TEXT, params TEXT, local INTEGER, vision TEXT, utility TEXT, backend TEXT, build TEXT NOT NULL, dirty INTEGER NOT NULL, shown TEXT, passed INTEGER, error TEXT, hit_cap INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, sub_tokens INTEGER, tokens INTEGER, steps INTEGER NOT NULL, secs REAL NOT NULL)");
    old.exec("INSERT INTO runs (run, at, by, sweep, task, task_hash, variant, scored, model, build, dirty, hit_cap, steps, secs) VALUES ('old', '2026-10-01', 'x', 's', 't', 'h', '{}', 1, 'm', 'b0', 0, 0, 1, 1)");
    old.close();
    const db = await openScores(file);
    const saved = { hash: "r1", combo: { model: "m" }, models: { driver: "m" }, measurement: { succeeded: true, steps: 2, runMs: 1000, tokens: {} } };
    const task = { id: "t", task: "do it", succeeded: () => true };
    const sweep = { name: "regression", fingerprint: "b1", dirty: false, backend: { chatUrl: "http://box/api/chat/completions" }, suite: "regression" };
    logRuns(db, [runRow(saved, task, sweep), runRow({ ...saved, hash: "r2" }, task, { ...sweep, suite: undefined })]);
    assert.deepEqual(readRuns(db).map((r) => [r.run, r.suite]), [["old", null], ["r1", "regression"], ["r2", null]]);
});

// --- the verdict ---

test("a build that changed nothing is not flagged, and neither is any task", () => {
    const v = verdict(runs({ thetas: THETAS, bs: BS, builds: ["b0", "b1", "b2"] }));
    assert.equal(v.build, "b2");
    assert.deepEqual(v.baseline.sort(), ["b0", "b1"]);
    assert.ok(Math.abs(v.mu.v) < 0.1, `μ ${v.mu.v}`);
    assert.equal(v.flagged, false);
    assert.deepEqual(v.tasks.filter((t) => t.flagged), []);
});

test("one task broken by the build is flagged, says which models fell, and leaves the build unflagged", () => {
    const v = verdict(runs({ thetas: THETAS, bs: BS, builds: ["b0", "b1", "b2"], shifts: { b2: { t2: 3 } } }));
    assert.deepEqual(v.tasks.filter((t) => t.flagged).map((t) => t.task), ["t2"]);
    const t2 = v.tasks[0];
    assert.equal(t2.task, "t2", "flagged first");
    assert.ok(t2.delta.v > 1.5 && t2.delta.pReal > 0.9, JSON.stringify(t2.delta));
    assert.deepEqual(t2.fell.sort(), ["a", "b", "c"]);
    assert.equal(t2.oneModel, false);
    assert.equal(v.flagged, false, "one task is not the whole build");
    assert.ok(v.mu.v < 0.6, `μ ${v.mu.v} stays near 0: the Student-t keeps one broken task from moving it`);
});

test("a build that made every task a little harder flags the build, with μ near the true shift", () => {
    const v = verdict(runs({ thetas: THETAS, bs: BS, builds: ["b0", "b1", "b2"], shifts: { b2: Object.fromEntries(Object.keys(BS).map((t) => [t, 1])) } }));
    assert.equal(v.flagged, true);
    assert.ok(v.mu.pUp > 0.95 && v.mu.lo < 1 && v.mu.hi > 1, JSON.stringify(v.mu));
});

test("a flag one model's drop alone carries is marked as such", () => {
    const rows = runs({ thetas: THETAS, bs: BS, builds: ["b0", "b1", "b2"], n: 40 });
    // Model a, on t1, now fails every run it passed nearly all of before: only a fell.
    for (const r of rows) if (r.build === "b2" && r.model === "a" && r.task === "t1") r.passed = 0;
    const t1 = verdict(rows).tasks.find((t) => t.task === "t1");
    assert.deepEqual(t1.fell, ["a"]);
    assert.equal(t1.flagged, true, JSON.stringify(t1.delta));
    assert.equal(t1.oneModel, true);
});

test("a task run on one side only is listed, not compared; nothing to compare with gives no verdict", () => {
    const rows = runs({ thetas: THETAS, bs: { t1: 0 }, builds: ["b0", "b1"] });
    rows.push(...runs({ thetas: { a: 1 }, bs: { tnew: 0 }, builds: ["b1"] }));
    const v = verdict(rows);
    assert.deepEqual(v.unmatched, [{ key: "tnew#h", side: "now" }]);
    assert.equal(verdict(runs({ thetas: THETAS, bs: BS, builds: ["b0"] })), null, "one build has no baseline");
    assert.equal(verdict(runs({ thetas: THETAS, bs: BS, builds: ["b0", "b1"] }).map((r) => ({ ...r, suite: null }))), null, "only regression runs count");
});

test("the history reads every build against the builds before it", () => {
    const h = regressionHistory(runs({ thetas: THETAS, bs: BS, builds: ["b0", "b1", "b2", "b3"], shifts: { b2: { t2: 3 }, b3: { t2: 3 } } }), { modelKey });
    assert.deepEqual(h.map((v) => v.build), ["b1", "b2", "b3"]);
    assert.ok(h[1].tasks.find((t) => t.task === "t2").flagged, "b2 broke t2");
});

test("the detectable shift shrinks with more repeats, and is printed from earlier runs before a suite run", () => {
    const rows = runs({ thetas: THETAS, bs: BS, builds: ["b0"] });
    const few = plannedPower(rows, { models: ["a", "b"], repeats: 1, modelKey, fitRasch });
    const many = plannedPower(rows, { models: ["a", "b"], repeats: 9, modelKey, fitRasch });
    assert.equal(few.length, Object.keys(BS).length);
    for (const [i, f] of few.entries()) assert.ok(Math.abs(many[i].detectable - f.detectable / 3) < 1e-9, "sd shrinks as 1/sqrt(repeats)");
    assert.deepEqual(plannedPower([], { models: ["a"], repeats: 3, modelKey, fitRasch }), []);
});

test("Φ is the standard normal CDF", () => {
    for (const [x, p] of [[0, 0.5], [1.96, 0.975], [-1.645, 0.05], [3, 0.99865]]) assert.ok(Math.abs(normalCdf(x) - p) < 2e-4, `Φ(${x})`);
});

// --- where it shows ---

test("the scoreboard puts the verdict first, in scores.md and on its page, the flagged task on top", async () => {
    const rows = runs({ thetas: THETAS, bs: BS, builds: ["b0", "b1", "b2"], shifts: { b2: { t2: 3 } } }).map((r, i) => ({ ...r, run: `r${i}`, sweep: "regression", variant: "{}", hit_cap: 0, steps: 1, secs: 1 }));
    const board = scoreboard(rows, { db: "scores.sqlite" });
    assert.equal(board.regression.verdict.build, "b2");
    const md = scoresText(board);
    assert.ok(md.indexOf("## Regression suite") < md.indexOf("## Models"));
    assert.match(md, /\| t2 \| \+[\d.]+ \[[^\]]+\] \| \d+% \| \d+% \| yes \|/);
    assert.match(md, /The build is not flagged/);
    const w = new JSDOM(await scoresPage(board), { runScripts: "dangerously", pretendToBeVisual: true }).window;
    const d = w.document;
    const card = [...d.querySelectorAll("section.card")].find((s) => /Regression suite/.test(s.querySelector("h2")?.textContent ?? ""));
    assert.ok(card, "a regression card");
    assert.equal(d.querySelector("section.card"), card, "above the models");
    assert.match(card.querySelector("tr.flagged").textContent, /^t2harder/);
    assert.equal(card.querySelectorAll("tbody")[1].querySelectorAll("tr").length, 2, "μ for b1 and b2");
    w.close();
    assert.equal(scoreboard(rows.map((r) => ({ ...r, suite: null })), { db: "x" }).regression, null, "no regression runs, no card");
});
