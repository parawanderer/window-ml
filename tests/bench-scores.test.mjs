// The bench's model scoreboard: the Rasch fit (rasch.mjs) recovering known abilities and difficulties, the SQLite log
// of runs (scores.mjs: who is logged, and once), the scoreboard's numbers, and the two pages that show them with a
// tooltip on every number.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { fitRasch, sigmoid } from "../tests/e2e/bench/rasch.mjs";
import { openScores, logRuns, readRuns, runRow, scoreboard, scoresText, sweepScores, taskHash, variantOf, modelInfo, unscoredTasks, MIN_SCORED } from "../tests/e2e/bench/scores.mjs";
import { scoresPage, staticPage } from "../tests/e2e/bench/serve.mjs";

let sqlite = true;
try { await import("node:sqlite"); } catch { sqlite = false; }
const needsSqlite = { skip: sqlite ? false : "this Node has no node:sqlite" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-scores-"));

/** `n` runs of each (model, task) pair, passing in exactly the share σ(θ − b) says (rounded): data with no noise. */
function exact(thetas, bs, n = 20) {
    const obs = [];
    for (const [model, th] of Object.entries(thetas)) for (const [task, b] of Object.entries(bs)) {
        const k = Math.round(n * sigmoid(th - b));
        for (let i = 0; i < n; i++) obs.push({ model, task, passed: i < k });
    }
    return obs;
}

// --- the fit ---

test("the fit recovers known abilities and difficulties, in order and inside their intervals", () => {
    const thetas = { a: -1.5, b: -0.5, c: 0.5, d: 1.5 };
    const bs = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, -2 + (4 * i) / 9]));
    const f = fitRasch(exact(thetas, bs, 40));
    assert.ok(f.converged);
    const est = Object.keys(thetas).map((m) => f.models.get(m));
    // Reported relative to the mean difficulty, which is 0 here, so the estimates are on the true scale.
    for (const [i, m] of Object.keys(thetas).entries()) {
        assert.ok(est[i].lo <= thetas[m] && thetas[m] <= est[i].hi, `${m}: ${thetas[m]} in [${est[i].lo}, ${est[i].hi}]`);
    }
    assert.deepEqual([...est].sort((x, y) => x.theta - y.theta), est, "ordered as the truth is");
    for (const [t, b] of Object.entries(bs)) {
        const e = f.tasks.get(t);
        assert.ok(e.lo <= b && b <= e.hi, `${t}: ${b} in [${e.lo}, ${e.hi}]`);
    }
});

test("a model that ran only easy tasks does not outscore an abler one that ran hard ones, though its pass rate is higher", () => {
    const obs = [
        ...exact({ easyRunner: 0 }, { e1: -2, e2: -2, e3: -2, s1: 0, s2: 0 }),
        ...exact({ hardRunner: 1 }, { h1: 1.5, h2: 1.5, h3: 1.5, s1: 0, s2: 0 }),
    ];
    const rate = (m) => obs.filter((o) => o.model === m && o.passed).length / obs.filter((o) => o.model === m).length;
    assert.ok(rate("easyRunner") > rate("hardRunner"), "the raw rates point the wrong way");
    const f = fitRasch(obs);
    assert.ok(f.models.get("hardRunner").theta > f.models.get("easyRunner").theta);
});

test("a model that passed everything gets a finite score with a wide interval, not infinity", () => {
    const f = fitRasch([...exact({ ok: 0 }, { a: 0, b: 1 }), ...Array.from({ length: 10 }, () => ({ model: "perfect", task: "a", passed: true }))]);
    const p = f.models.get("perfect");
    assert.ok(Number.isFinite(p.theta) && p.theta > f.models.get("ok").theta);
    assert.ok(p.hi - p.lo > 2, `interval ${p.lo}..${p.hi}`);
    assert.equal(fitRasch([]).models.size, 0);
});

// --- the log ---

const SWEEP = { name: "s", spec: "specs/s.bench.ts", specHash: "h", fingerprint: "abc", dirty: false, backend: { chatUrl: "http://box:3000/api/chat/completions" }, info: new Map([["gemma4:31b", { digest: "sha256:aa11", quant: "Q4_K_M", params: "31B", local: true }]]), by: "tester", at: "2026-10-09T10:00:00.000Z" };
const TASK = { id: "count", task: "count the links", succeeded: ({ answer }) => /12/.test(answer) };
const saved = (over = {}) => ({ hash: "h".repeat(32), combo: { model: "gemma4:31b", idFormat: "hex" }, models: { driver: "gemma4:31b", vision: null, utility: "u" }, fromCache: false,
    measurement: { succeeded: true, error: null, hitCap: false, steps: 4, runMs: 12000, tokens: { prompt: 3000, completion: 500, sub: 100, total: 3600 } }, ...over });

test("a run is a row with its model's digest and its task's hash; the fake model's, a cached one and one with no session are not", () => {
    const r = runRow(saved(), TASK, SWEEP);
    assert.equal(r.model, "gemma4:31b");
    assert.equal(r.digest, "sha256:aa11");
    assert.equal(r.quant, "Q4_K_M");
    assert.equal(r.passed, 1);
    assert.equal(r.tokens, 3600);
    assert.equal(r.backend, "http://box:3000");
    assert.equal(r.variant, '{"idFormat":"hex"}', "the model is the person, not part of the item");
    assert.equal(r.by, "tester");
    assert.equal(runRow(saved(), TASK, { ...SWEEP, backend: null }), null, "the fake model");
    assert.equal(runRow(saved({ fromCache: true }), TASK, SWEEP), null, "logged by the sweep that ran it");
    assert.equal(runRow(saved({ hash: null }), TASK, SWEEP), null);
    // No predicate: logged, for tokens, but not scored. No usage reported: unknown, not zero.
    const u = runRow(saved({ measurement: { ...saved().measurement, succeeded: null, tokens: { prompt: 0, completion: 0, sub: 0, total: 0 } } }), { id: "free", task: "say hi" }, SWEEP);
    assert.deepEqual([u.scored, u.passed, u.tokens, u.prompt_tokens], [0, null, null, null]);
});

test("an edited task or predicate is a new item; another model on the same task is the same item", () => {
    const h = taskHash(TASK, { model: "a" });
    assert.equal(taskHash(TASK, { model: "b" }), h);
    assert.notEqual(taskHash({ ...TASK, task: "count the external links" }, { model: "a" }), h);
    assert.notEqual(taskHash({ ...TASK, succeeded: ({ answer }) => /13/.test(answer) }, { model: "a" }), h);
    assert.notEqual(taskHash(TASK, { model: "a", idFormat: "label" }), h);
    assert.equal(variantOf({ z: 1, model: "m", a: 2 }), '{"a":2,"z":1}');
});

test("the log keeps a run once, survives being reopened, and is never rewritten", needsSqlite, async () => {
    const file = path.join(tmp(), "scores.sqlite");
    let db = await openScores(file);
    assert.equal(logRuns(db, [runRow(saved(), TASK, SWEEP)]), 1);
    assert.equal(logRuns(db, [runRow(saved({ measurement: { ...saved().measurement, succeeded: false } }), TASK, SWEEP)]), 0, "the same run again changes nothing");
    db.close();
    db = await openScores(file);
    const rows = readRuns(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].passed, 1, "the first record stands");
    assert.equal(rows[0].at, SWEEP.at);
});

test("the server's list says which model is local and its digest; a cloud model has none; an unreachable server, nothing", async () => {
    const owui = { data: [
        { id: "gemma4:31b", owned_by: "ollama", ollama: { digest: "sha256:aa11", details: { quantization_level: "Q4_K_M", parameter_size: "31B" } } },
        { id: "deepseek.v4", owned_by: "openai" },
    ] };
    const fetchOwui = async (url) => ({ ok: url.endsWith("/api/models"), json: async () => owui });
    const info = await modelInfo({ chatUrl: "http://box:3000/api/chat/completions" }, fetchOwui);
    assert.deepEqual(info.get("gemma4:31b"), { digest: "sha256:aa11", quant: "Q4_K_M", params: "31B", local: true });
    assert.deepEqual(info.get("deepseek.v4"), { digest: null, quant: null, params: null, local: false });
    const fetchOllama = async (url) => ({ ok: url.endsWith("/api/tags"), json: async () => ({ models: [{ name: "qwen3.5:9b", digest: "d9", details: { quantization_level: "Q4_K_M" } }] }) });
    assert.equal((await modelInfo({ chatUrl: "http://box:11434/api/chat" }, fetchOllama)).get("qwen3.5:9b").digest, "d9");
    assert.equal((await modelInfo({ chatUrl: "http://box/x" }, async () => { throw new Error("down"); })).size, 0);
    assert.equal((await modelInfo(null)).size, 0);
});

// --- the scoreboard ---

/** Rows as the log holds them, for one (model, task) pair: `pass` of `n` passed. */
const rowsOf = (model, task, n, pass, extra = {}) => Array.from({ length: n }, (_, i) => ({ run: `${model}-${task}-${i}-${Math.random()}`, at: `2026-10-09T10:${String(i).padStart(2, "0")}:00Z`, by: "t", model, digest: null, task, task_hash: `${task}h`, task_text: `do ${task}`, variant: "{}", scored: 1, passed: i < pass ? 1 : 0, error: null, tokens: 1000, ...extra }));

test("a model is scored from enough scored runs; errored runs and runs with no predicate stay out of the fit", () => {
    const rows = [
        ...rowsOf("a", "t1", 4, 3), ...rowsOf("a", "t2", 4, 2),
        ...rowsOf("b", "t1", 4, 1), ...rowsOf("b", "t2", 4, 0),
        ...rowsOf("few", "t1", MIN_SCORED - 1, 2),
        ...rowsOf("b", "t2", 3, 0, { error: "backend down" }),
        ...rowsOf("a", "chat", 2, 0, { scored: 0, passed: null }),
    ];
    const board = scoreboard(rows);
    const by = Object.fromEntries(board.models.map((m) => [m.key, m]));
    assert.ok(by.a.score.theta > by.b.score.theta);
    assert.equal(by.few.score, null, "below the minimum: no score");
    assert.equal(by.b.scored, 8, "errored runs are not scored");
    assert.equal(by.b.errored, 3);
    assert.equal(by.a.unscored, 2);
    assert.equal(board.totals.fitted, 4 + 4 + 4 + 4 + MIN_SCORED - 1);
    assert.equal(board.tasks.find((t) => t.task === "chat").difficulty, null);
    assert.deepEqual(board.models.map((m) => m.key).slice(0, 2), ["a", "b"], "best score first");
    assert.ok(Math.abs(by.a.score.chance - sigmoid(by.a.score.theta)) < 1e-12);
});

test("token bloat: tokens over the task's median, a geometric mean per model, only on tasks another model ran too", () => {
    const rows = [
        ...rowsOf("lean", "t", 2, 1, { tokens: 1000 }), ...rowsOf("fat", "t", 2, 1, { tokens: 4000 }),
        ...rowsOf("fat", "alone", 3, 1, { tokens: 9000 }),
        ...rowsOf("lean", "t", 1, 0, { tokens: null }),
    ];
    const by = Object.fromEntries(scoreboard(rows).models.map((m) => [m.key, m]));
    // The task's median over 1000, 1000, 4000, 4000 is 2500.
    assert.ok(Math.abs(by.lean.bloat.ratio - 0.4) < 1e-9);
    assert.ok(Math.abs(by.fat.bloat.ratio - 1.6) < 1e-9);
    assert.equal(by.fat.bloat.runs, 2, "the task only it ran does not count");
    assert.equal(by.lean.bloat.runs, 2, "a run with no tokens reported does not count");
});

test("a re-pulled model (another digest) is its own line, and the sweep page gets the line of the digest it ran", () => {
    const rows = [...rowsOf("g", "t", 5, 4, { digest: "sha256:old" }), ...rowsOf("g", "t", 5, 1, { digest: "sha256:new" }), ...rowsOf("h", "t", 5, 2)];
    const board = scoreboard(rows);
    assert.equal(board.models.length, 3);
    const lines = sweepScores(board, ["g", "h", "missing"], new Map([["g", { digest: "sha256:new" }]]), "/scores");
    assert.equal(lines.models.g.digest, "sha256:new");
    assert.equal(lines.models.h.key, "h");
    assert.equal(lines.models.missing, undefined);
    assert.equal(lines.href, "/scores");
});

test("scores.md says where the raw data is and how every number is computed", () => {
    const board = scoreboard([...rowsOf("a", "t1", 5, 3), ...rowsOf("b", "t1", 5, 1)], { db: "/x/scores.sqlite" });
    const md = scoresText(board);
    assert.match(md, /in `\/x\/scores\.sqlite` \(SQLite, table `runs`/);
    assert.match(md, /sqlite3 \/x\/scores\.sqlite "SELECT/);
    for (const v of Object.values(board.about)) assert.ok(md.includes(v), v.slice(0, 40));
    assert.match(md, /\| a \|  \| [+-]\d\.\d\d \[/);
    assert.match(scoresText(scoreboard([])), /Nothing logged yet/);
});

test("the runner names the tasks with no predicate (interviews aside)", () => {
    assert.deepEqual(unscoredTasks({ tasks: [TASK, { id: "free", task: "x" }, { id: "iv", task: "x", asks: ["y"] }] }), ["free"]);
});

// --- the pages ---

const domOf = (html) => new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true }).window.document;

test("the scoreboard page: every column and every score explains itself on hover, and says where the raw data is", async () => {
    const rows = [...rowsOf("a", "t1", 5, 3), ...rowsOf("b", "t1", 5, 1), ...rowsOf("c", "t1", 2, 1), ...rowsOf("a", "free", 1, 0, { scored: 0, passed: null, task_text: '<img src=x onerror="window.__pwned=1">' })];
    const board = scoreboard(rows, { db: "/x/scores.sqlite" });
    const doc = domOf(await scoresPage(board));
    const ths = [...doc.querySelectorAll("th")];
    assert.ok(ths.length >= 15);
    for (const th of ths) assert.ok(th.querySelector(".help[data-tip]")?.getAttribute("data-tip"), `${th.textContent} has a tip`);
    assert.equal(doc.querySelector("th .help[data-tip]").getAttribute("data-tip"), board.about.model);
    assert.equal(doc.querySelectorAll("td .ival[data-tip]").length, 2 + 1, "two scored models, one scored task");
    assert.match(doc.querySelector("td .ival").getAttribute("data-tip"), /^θ = [+−]\d\.\d\d, interval .* fitted from 5 scored runs over 1 task/);
    assert.match([...doc.querySelectorAll("td .tt")].map((e) => e.getAttribute("data-tip")).join("\n"), /Not scored yet: 2 of the 5 scored runs/);
    assert.match(doc.querySelector(".counts").innerHTML, /scores\.sqlite/);
    assert.match(doc.querySelector(".counts .tt").getAttribute("data-tip"), /runs table of \/x\/scores\.sqlite \(SQLite\)/);
    assert.match(doc.querySelector(".method").textContent, /sqlite3 \/x\/scores\.sqlite/);
    assert.equal(doc.querySelectorAll("#app [title]").length, 0, "the panel's tooltips, never the browser's");
    assert.equal(doc.querySelectorAll("#app img").length, 0);
    assert.equal(doc.defaultView.__pwned, undefined);
});

test("the sweep page shows each driver's score in its pill, linked to the scoreboard; without a log, no segment", async () => {
    const board = scoreboard([...rowsOf("gemma", "t", 6, 4), ...rowsOf("qwen", "t", 2, 1)]);
    const run = (driver) => ({ combo: { model: driver }, taskId: "t", repeat: 0, state: "done", who: driver, ok: true, models: { driver, vision: null, utility: null } });
    const state = { name: "x", dims: ["model"], runs: [run("gemma"), run("qwen")], rows: [], jobs: 1, started: 0, finished: 1 };
    const doc = domOf(await staticPage({ ...state, scores: sweepScores(board, ["gemma", "qwen"], new Map(), "../scores.html") }));
    const segs = [...doc.querySelectorAll(".mset a.role.score")];
    assert.equal(segs.length, 2);
    assert.equal(segs[0].getAttribute("href"), "../scores.html");
    assert.match(segs[0].textContent, /score[+−]\d\.\d\d/);
    assert.match(segs[0].getAttribute("data-tip"), /from 6 scored runs over 1 tasks, every sweep's runs/);
    assert.match(segs[1].textContent, /2\/5/);
    assert.match(segs[1].getAttribute("data-tip"), /Not on the scoreboard yet: 2 of the 5/);
    assert.equal(domOf(await staticPage(state)).querySelectorAll(".role.score").length, 0);
});
