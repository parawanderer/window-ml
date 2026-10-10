// What a sweep will cost (tests/e2e/bench/spend-predict.mjs): the past runs it reads (this clone's log and the pulled
// pool, a run once), each re-priced at today's rates, an estimate per cell from the nearest level that has runs (the same
// task, the task under another wording, the model's other tasks, else none, never 0), a local model's cell as
// electricity, the forecast narrowing as cells finish, the lines the terminal, status.md and the end print, the price
// service's /latest as a book, and the page's badge and pills with the estimate, a page without one unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { pastRuns, repriced, predictCells, forecast, forecastText, estimateCheck, latestPrices, newestLoggedPrices, openPool, RECENT } from "../tests/e2e/bench/spend-predict.mjs";
import { openScores } from "../tests/e2e/bench/scores.mjs";
import { logCalls, logSnapshot } from "../tests/e2e/bench/spend.mjs";
import { statusText } from "../tests/e2e/bench/status.mjs";
import { staticPage } from "../tests/e2e/bench/serve.mjs";
import { priceBook } from "../src/spend/price-book.ts";

const EXT = "openrouter.x/a", LOCAL = "loc:7b", NOPRICE = "openrouter.x/nope";
const SOURCES = {
    openrouter: { data: [{ id: "x/a", pricing: { prompt: "0.000001", completion: "0.000002" } }] },
    owui_models: { data: [{ id: EXT, connection_type: "external" }, { id: LOCAL, ollama: {} }, { id: NOPRICE, connection_type: "external" }] },
};
const priceOf = priceBook(SOURCES);
/** A call of `p` prompt and `c` completion tokens: at EXT's rates, p/1e6 + 2c/1e6 USD. */
const call = (p, c, model = null) => ({ model, usage: { promptTokens: p, completionTokens: c } });
const run = (id, model, task, taskHash, at, calls) => ({ run: id, model, task, taskHash, at, calls });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

const tmpDb = async () => openScores(path.join(mkdtempSync(path.join(os.tmpdir(), "bench-predict-")), "scores.sqlite"));
/** A runs row with only what the log requires. */
const logRun = (db, r) => db.prepare("INSERT INTO runs (run, at, by, sweep, task, task_hash, variant, scored, model, build, dirty, hit_cap, steps, secs) VALUES (?, ?, 'sb', 's', ?, ?, '{}', 1, ?, 'b', 0, 0, 1, 1)").run(r.run, r.at, r.task, r.taskHash, r.model);
const callRows = (id, calls) => calls.map((c, i) => ({ run: id, call: i, kind: c.kind ?? "turn", step: i, model: c.model, usage: JSON.stringify(c.usage) }));

// --- the history ---

test("past runs come from every log given, a run in two counted once, a turn logged without its model read as the driver's, a run with no calls left out", async () => {
    const a = await tmpDb(), b = await tmpDb();
    for (const db of [a, b]) logRun(db, { run: "r1", at: "2026-10-01", task: "t", taskHash: "h", model: EXT });
    logCalls(a, callRows("r1", [call(1000, 100), { ...call(10, 1, "vis"), kind: "sub" }]));
    logCalls(b, callRows("r1", [call(1, 1)]));
    logRun(b, { run: "r2", at: "2026-10-02", task: "t", taskHash: "h", model: LOCAL });
    logCalls(b, callRows("r2", [call(5, 5)]));
    logRun(b, { run: "r3", at: "2026-10-03", task: "t", taskHash: "h", model: EXT });
    const runs = pastRuns([a, null, b]);
    assert.deepEqual(runs.map((r) => r.run).sort(), ["r1", "r2"]);
    const r1 = runs.find((r) => r.run === "r1");
    assert.deepEqual(r1.calls.map((c) => [c.model, c.usage.promptTokens]), [[EXT, 1000], ["vis", 10]], "the local log's copy; the sub call keeps its own (unknown) model");
});

test("a past run re-priced at today's rates: its tokens, a local call free of money, an unpriced call making the run's cost unknown", () => {
    const r = repriced(run("r", EXT, "t", "h", "x", [call(1000, 100, EXT), call(50, 50, LOCAL)]), priceOf);
    near(r.cost, 0.0012);
    assert.deepEqual([r.tokens, r.local, r.why], [1200, false, null]);
    assert.deepEqual(repriced(run("r", LOCAL, "t", "h", "x", [call(10, 10, LOCAL)]), priceOf), { cost: null, tokens: 20, local: true, why: null });
    const u = repriced(run("r", EXT, "t", "h", "x", [call(10, 10, EXT), call(10, 10, NOPRICE)]), priceOf);
    assert.deepEqual([u.cost, u.why], [null, "no price for x/nope"]);
});

// --- each cell's estimate ---

const HIST = [
    run("a1", EXT, "t", "h", "2026-10-01", [call(1000, 100, EXT)]),          // 0.0012
    run("a2", EXT, "t", "h", "2026-10-02", [call(2000, 200, EXT)]),          // 0.0024
    run("b1", EXT, "t", "old", "2026-09-01", [call(4000, 0, EXT)]),          // 0.004, the same task under another wording
    run("c1", EXT, "u", "h", "2026-09-01", [call(8000, 0, EXT)]),            // 0.008, another task
    run("l1", LOCAL, "t", "h", "2026-10-01", [call(300, 30, LOCAL)]),
    run("n1", NOPRICE, "t", "h", "2026-10-01", [call(10, 10, NOPRICE)]),
];

test("a cell is estimated from the nearest level with runs: the same task, then another wording of it, then the model's other tasks", () => {
    const [item, task, model] = predictCells([{ model: EXT, task: "t", taskHash: "h" }, { model: EXT, task: "t", taskHash: "new" }, { model: EXT, task: "v", taskHash: "h" }], HIST, priceOf);
    near(item.cost, 0.0018);
    assert.deepEqual([item.basis, item.n, item.tokens, item.local], ["item", 2, 1650, false]);
    near(task.cost, (0.0012 + 0.0024 + 0.004) / 3);
    assert.equal(task.basis, "task");
    near(model.cost, (0.0012 + 0.0024 + 0.004 + 0.008) / 4);
    assert.equal(model.basis, "model");
});

test("no past run, an unpriced model and a local one: no estimate with the reason, never 0; local is electricity with or without history", () => {
    const [none, unpriced, local, localNew] = predictCells([{ model: "who", task: "t", taskHash: "h" }, { model: NOPRICE, task: "t", taskHash: "h" }, { model: LOCAL, task: "t", taskHash: "h" }, { model: LOCAL, task: "zz", taskHash: "h" }], HIST, priceOf);
    assert.deepEqual(none, { cost: null, tokens: null, local: false, basis: null, n: 0, why: "no past run of who" });
    assert.deepEqual([unpriced.cost, unpriced.why, unpriced.basis], [null, "no price for x/nope", "item"]);
    assert.deepEqual([local.cost, local.local, local.tokens], [null, true, 330]);
    assert.deepEqual([localNew.local, localNew.basis], [true, "model"]);
    assert.deepEqual(predictCells([{ model: LOCAL, task: "t", taskHash: "h" }], [], priceOf)[0], { cost: null, tokens: null, local: true, basis: null, n: 0, why: null });
});

test(`only the ${RECENT} most recent past runs count: an old expensive prompt does not hold the estimate up`, () => {
    const old = Array.from({ length: 30 }, (_, i) => run(`o${i}`, EXT, "t", "h", `2026-01-${String(i + 1).padStart(2, "0")}`, [call(100_000, 0, EXT)]));
    const recent = Array.from({ length: RECENT }, (_, i) => run(`n${i}`, EXT, "t", "h", `2026-10-${String(i + 1).padStart(2, "0")}`, [call(1000, 0, EXT)]));
    const [p] = predictCells([{ model: EXT, task: "t", taskHash: "h" }], [...old, ...recent], priceOf);
    near(p.cost, 0.001);
    assert.equal(p.n, RECENT);
});

// --- the forecast as the sweep runs ---

const PRED = [{ cost: 0.01, local: false, basis: "item" }, { cost: 0.01, local: false, basis: "item" }, { cost: 0.01, local: false, basis: "task" }, { cost: null, local: true }, { cost: null, local: false, why: "no past run of who" }, { cost: 0.5, local: false, basis: "item" }];
const MODELS = [EXT, EXT, EXT, LOCAL, "who", EXT];

test("at the start every cell to run is estimated; a cached one cost this sweep nothing; local and unknown cells are counted, never priced", () => {
    const f = forecast(PRED, { stateOf: () => "pending", modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5, prices: "2026-10-10T12:07:01Z" });
    near(f.remaining, 0.03);
    assert.deepEqual([f.spent, f.left, f.local, f.unknown, f.why, f.prices], [0, 5, 1, 1, "no past run of who", "2026-10-10T12:07:01Z"]);
    assert.deepEqual(f.basis, { item: 2, task: 1, model: 0 });
    assert.deepEqual([f.models[EXT].left, f.models[LOCAL].local, f.models.who.unknown], [3, 1, 1]);
});

test("as cells finish their estimate gives way to what they spent; a running cell counts the larger of the two", () => {
    const states = ["done", "running", "running", "pending", "pending", "pending"];
    const spent = { 0: { computed: 0.03 }, 1: { computed: 0.002 }, 2: { computed: 0.02 } };
    const f = forecast(PRED, { stateOf: (i) => states[i], spentOf: (i) => spent[i] ?? null, modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5 });
    near(f.spent, 0.052);
    near(f.remaining, 0.008);
    near(f.total, 0.06);
    assert.equal(f.left, 4);
    const end = forecast(PRED, { stateOf: () => "done", spentOf: (i) => spent[i] ?? null, modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5 });
    assert.deepEqual([end.left, end.remaining], [0, 0]);
});

// --- what it prints ---

test("the start lines: the total for the runs to run at the snapshot's time, one line per model with where its estimate came from", () => {
    const f = forecast(PRED, { stateOf: () => "pending", modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5, prices: "2026-10-10T12:07:01Z" });
    const [head, ...rows] = forecastText(f, { start: true });
    assert.equal(head, "  spend estimate (prices of 2026-10-10 12:07 UTC): about 0.03 USD for the 5 runs to run (1 local, 1 with no estimate, not in it)");
    assert.match(rows.find((r) => r.includes(EXT)), /about 0\.03 USD \(2 from past runs of the same task, 1 from past runs of the task under another wording\)/);
    assert.match(rows.find((r) => r.includes(LOCAL)), /1 run local: electricity, not priced here/);
    assert.match(rows.find((r) => r.includes("who")), /1 run with no estimate: no past run of who/);
    assert.match(rows.at(-1), /most recent past runs of the task, re-priced at these rates/);
    assert.match(forecastText(f)[0], /^ {2}spend so far 0\.00 USD; about 0\.03 USD by the end \(5 runs left: 1 local, 1 with no estimate\)/);
    // Nothing estimated in money is said so, never "about 0.00".
    const none = forecast([PRED[3], PRED[4]], { stateOf: () => "pending", modelOf: (i) => [LOCAL, "who"][i] });
    assert.equal(forecastText(none, { start: true })[0], "  spend estimate: none in money for the 2 runs to run (1 local, 1 with no estimate)");
    assert.match(forecastText(none)[0], /no estimate for the rest \(2 runs left: 1 local, 1 with no estimate\)/);
});

test("the end line sets the start estimate beside the computed spend, and names the runs a pause left", () => {
    const start = forecast(PRED, { stateOf: () => "pending", modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5 });
    const done = forecast(PRED, { stateOf: () => "done", spentOf: () => ({ computed: 0.012 }), modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5 });
    assert.equal(estimateCheck(start, done), "spend estimate at the start: about 0.03 USD for 5 runs; computed spend 0.06 USD; 1 run had no estimate");
    const paused = forecast(PRED, { stateOf: (i) => (i === 0 ? "done" : "pending"), spentOf: (i) => (i === 0 ? { computed: 0.011 } : null), modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5 });
    assert.match(estimateCheck(start, paused), /computed spend 0\.01 USD; 4 runs did not run \(about 0\.02 USD of the estimate\)/);
});

test("status.md has the estimate while runs are left, and none once the sweep is done", () => {
    const f = forecast(PRED, { stateOf: () => "pending", modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5 });
    const md = statusText({ name: "s", runs: [], forecast: f }, 0);
    assert.match(md, /## Spend estimate \(narrows as runs finish\)\n\nspend so far 0\.00 USD; about 0\.03 USD by the end \(5 runs left: 1 local, 1 with no estimate\)/);
    assert.ok(!statusText({ name: "s", runs: [], forecast: { ...f, left: 0 } }, 0).includes("Spend estimate"));
});

// --- the prices ---

test("the price service's /latest is a price book (its bodies come parsed); unreachable or refused, none", async () => {
    let asked;
    const ok = await latestPrices("http://box:3002/latest/", async (url) => { asked = url; return { ok: true, json: async () => ({ fetched_at: "2026-10-10T12:07:01Z", sources: Object.fromEntries(Object.entries(SOURCES).map(([k, body]) => [k, { sha256: "x", body }])) }) }; });
    assert.equal(asked, "http://box:3002/latest");
    assert.equal(ok.at, "2026-10-10T12:07:01Z");
    assert.equal(ok.priceOf(EXT).basis, "openrouter");
    assert.equal(await latestPrices("http://box", async () => ({ ok: false })), null);
    assert.equal(await latestPrices("http://box", async () => { throw new Error("down"); }), null);
});

test("without a price service, the newest snapshot the log holds; none when no call names one", async () => {
    const db = await tmpDb();
    assert.equal(newestLoggedPrices(db), null);
    const bodies = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))]));
    const { createHash } = await import("node:crypto");
    const sources = Object.fromEntries(Object.entries(bodies).map(([k, b]) => [k, createHash("sha256").update(b).digest("hex")]));
    for (const [k, b] of Object.entries(bodies)) logSnapshot(db, { hash: sources[k], kind: k, body: b });
    logRun(db, { run: "r", at: "x", task: "t", taskHash: "h", model: EXT });
    logCalls(db, [{ run: "r", call: 0, kind: "turn", step: 0, model: EXT, usage: JSON.stringify({ promptTokens: 1, prices: { fetchedAt: "2026-10-09T08:00:00Z", sources } }) }]);
    const got = newestLoggedPrices(db);
    assert.equal(got.at, "2026-10-09T08:00:00Z");
    assert.equal(got.priceOf(LOCAL).local, true);
    assert.equal(await openPool(path.join(os.tmpdir(), "no-such-pool", "scores.sqlite")), null);
});

// --- the page ---

async function page(state) {
    const w = new JSDOM(await staticPage(state), { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true }).window;
    await new Promise((r) => w.setTimeout(r, 10));
    return w;
}
const tally = (o) => ({ calls: 0, computed: 0, computedCalls: 0, reported: 0, reportedCalls: 0, local: 0, unpriced: 0, pending: 0, ...o });
const base = { name: "s", dims: ["model"], runs: [{ combo: { model: EXT }, taskId: "t", repeat: 0, state: "running", who: EXT, models: { driver: EXT } }], rows: [], jobs: 1, started: 1_760_000_000_000 };

test("the header badge and the model's pill carry the estimate with its tip; a page from before the estimate shows only the spend", async () => {
    const f = forecast(PRED, { stateOf: () => "pending", modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5, prices: "2026-10-10T12:07:01Z" });
    const spend = { currency: "USD", total: tally({ calls: 1, computed: 0.004, computedCalls: 1 }), models: { [EXT]: tally({ calls: 1, computed: 0.004, computedCalls: 1 }) }, runs: {} };
    const w = await page({ ...base, spend, forecast: f });
    const badge = w.document.querySelector(".badge.spend");
    assert.match(badge.textContent, /spent .*0\.004.* · est\. .*0\.03.*\+/);
    const tip = badge.querySelector(".est").getAttribute("data-tip");
    assert.match(tip, /5 runs left/);
    assert.match(tip, /the snapshot of 2026-10-10 12:07 UTC/);
    assert.match(tip, /1 run on a local model: electricity, not priced here\. 1 run with no estimate \(no past run of who\), not in the figure\./);
    const pill = w.document.querySelector(".role.spend");
    assert.match(pill.textContent, /spent.*0\.004.* · est\. .*0\.03/);
    assert.match(pill.querySelector(".est").getAttribute("data-tip"), new RegExp(`${EXT.replace(/[./]/g, "\\$&")}'s runs in this sweep by its end`));
    const old = await page({ ...base, spend });
    assert.equal(old.document.querySelector(".badge.spend .est"), null);
    assert.match(old.document.querySelector(".badge.spend").textContent, /^spent /);
    w.close(); old.close();
});
