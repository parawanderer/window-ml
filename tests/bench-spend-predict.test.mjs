// What a sweep will cost (tests/e2e/bench/spend-predict.mjs): the past runs it reads (this clone's log and the pulled
// pool, a run once), each re-priced at today's rates, an estimate per cell from the nearest level that has runs (the same
// task, the task under another wording, the model's other tasks, else none, never 0), a local model's cell as
// electricity, the forecast narrowing as cells finish, the lines the terminal, status.md and the end print, the price
// service's /latest as a book, and the page's badge and pills with the estimate, a page without one unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { pastRuns, repriced, predictCells, forecast, forecastText, estimateCheck, latestPrices, newestLoggedPrices, openPool, RECENT, predictEnergy, energyForecast, energyForecastText, priceFromSettings } from "../tests/e2e/bench/spend-predict.mjs";
import { estimateLine } from "../tests/e2e/bench/estimate-line.mjs";
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

test("UPGRADE: a run logged before its calls were (#555) counts by its token totals, as one driver call, only where no run with its calls is", async () => {
    const db = await tmpDb();
    for (const [id, at, p, c] of [["old1", "2026-09-01", 1000, 100], ["old2", "2026-09-02", 3000, 300]]) {
        logRun(db, { run: id, at, task: "t", taskHash: "h", model: EXT });
        db.prepare("UPDATE runs SET prompt_tokens = ?, completion_tokens = ? WHERE run = ?").run(p, c, id);
    }
    const hist = pastRuns([db]);
    assert.deepEqual(hist.map((r) => [r.run, r.approx, r.calls.map((x) => [x.model, x.usage.promptTokens, x.usage.completionTokens])]).sort(),
        [["old1", true, [[EXT, 1000, 100]]], ["old2", true, [[EXT, 3000, 300]]]]);
    const [only] = predictCells([{ model: EXT, task: "t", taskHash: "h" }], hist, priceOf);
    near(only.cost, (0.0012 + 0.0036) / 2);
    assert.equal(only.n, 2, "a fresh clone with only old runs still has an estimate");
    logRun(db, { run: "new1", at: "2026-10-01", task: "t", taskHash: "h", model: EXT });
    logCalls(db, callRows("new1", [call(2000, 200)]));
    const [mixed] = predictCells([{ model: EXT, task: "t", taskHash: "h" }], pastRuns([db]), priceOf);
    assert.deepEqual([mixed.n, mixed.basis], [1, "item"], "a run with its calls is preferred over the totals");
    near(mixed.cost, 0.0024);
});

test("UPGRADE: an old run's calls are backfilled from its run.json, cached tokens and all; a seeded run and a missing file are counted, not guessed", async () => {
    const { backfillCalls } = await import("../tests/e2e/bench/spend.mjs");
    const db = await tmpDb();
    const root = mkdtempSync(path.join(os.tmpdir(), "bench-backfill-")), dir = path.join(root, "old-sweep");
    const cell = (rel, hash, extra = {}) => {
        mkdirSync(path.join(dir, rel), { recursive: true });
        writeFileSync(path.join(dir, rel, "cell.json"), JSON.stringify({ hash, key: rel, taskId: "t", models: { driver: EXT }, measurement: { ok: true }, ...extra }));
        logRun(db, { run: hash, at: "2026-10-09", task: "t", taskHash: "h", model: EXT });
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sweeps.jsonl"), "{}\n");
    cell("t/a/r0", "h1");
    writeFileSync(path.join(dir, "t/a/r0", "run.json"), JSON.stringify({ session: { hash: "h1", steps: [
        { seq: 1, step: 1, usage: { promptTokens: 1000, completionTokens: 100, cachedTokens: 800 } },
        { seq: 2, step: 2, usage: { promptTokens: 1200, completionTokens: 50, cachedTokens: 1000 }, subUsage: { calls_: [{ model: "vis", prompt: 10, completion: 2, ts: 1 }] } },
    ] } }));
    cell("t/b/r0", "h2");                                          // its run.json is gone
    cell("t/c/r0", "h3", { measurement: { ok: true, seeded: true } });
    writeFileSync(path.join(dir, "t/c/r0", "run.json"), JSON.stringify({ session: { hash: "h3", steps: [{ seq: 1, step: 1, usage: { promptTokens: 5, completionTokens: 5 } }] } }));
    assert.deepEqual(await backfillCalls(db, [dir]), { runs: 1, calls: 3, seeded: 1, noFile: 1 });
    const h1 = pastRuns([db]).find((r) => r.run === "h1");
    assert.deepEqual(h1.calls.map((c) => [c.model, c.usage.promptTokens, c.usage.cachedTokens ?? null]), [[EXT, 1000, 800], [EXT, 1200, 1000], ["vis", 10, null]]);
    assert.equal(h1.approx, false);
    assert.deepEqual(await backfillCalls(db, [dir]), { runs: 0, calls: 0, seeded: 1, noFile: 1 }, "again: nothing added, the ones it cannot do still counted");
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

// --- electricity ---

test("a cell's electricity is the mean Wh of its model's recent runs that drew on the box, at the same fallbacks", () => {
    const hist = [run("l1", LOCAL, "t", "h1", "2026-10-10T01", []), run("l2", LOCAL, "t", "h1", "2026-10-10T02", []), run("l3", LOCAL, "u", "h9", "2026-10-10T03", []),
        run("l0", LOCAL, "t", "h1", "2026-10-09T00", []), run("e1", EXT, "t", "h1", "2026-10-10T01", [])];
    const energyOf = new Map([["l1", { Wh: 1 }], ["l2", { Wh: 2 }], ["l3", { Wh: 9 }]]);   // l0 predates the power readings
    const local = (m) => m === LOCAL;
    const got = predictEnergy([{ model: LOCAL, task: "t", taskHash: "h1" }, { model: LOCAL, task: "t", taskHash: "h2" }, { model: LOCAL, task: "v", taskHash: "x" },
        { model: EXT, task: "t", taskHash: "h1" }, { model: "never-ran", task: "t", taskHash: "h1" }, { model: "loc2", task: "t", taskHash: "h1" }], hist, energyOf, local);
    assert.deepEqual(got.slice(0, 3), [{ Wh: 1.5, basis: "item", n: 2 }, { Wh: 1.5, basis: "task", n: 2 }, { Wh: 4, basis: "model", n: 3 }]);
    assert.deepEqual(got[3], { Wh: 0, basis: "none", n: 0 }, "a cloud model whose runs never drew on the box draws nothing");
    assert.equal(got[4], null, "a model never run: no estimate");
    const noEnergy = predictEnergy([{ model: LOCAL, task: "t", taskHash: "h1" }], [run("l0", LOCAL, "t", "h1", "x", [])], new Map(), local);
    assert.deepEqual(noEnergy, [null], "a local model with no energy on record: no estimate, never 0");
});

test("the electricity forecast narrows as runs finish, and prices the rest at the current rate", () => {
    const pred = [{ Wh: 2, basis: "item", n: 3 }, { Wh: 2, basis: "item", n: 3 }, { Wh: 0, basis: "none", n: 0 }, null, { Wh: 5, basis: "model", n: 1 }];
    const states = ["done", "running", "pending", "pending", "pending"];
    const measured = { 0: { Wh: 2.5 }, 1: { Wh: 0.5 } };
    const f = energyForecast(pred, { stateOf: (i) => states[i], spentOf: (i) => measured[i], modelOf: (i) => (i < 2 ? LOCAL : EXT), cachedOf: (i) => i === 4,
        price: { perKwh: 0.25, currency: "EUR" } });
    assert.deepEqual([f.spentWh, f.remainingWh, f.totalWh, f.left, f.unknown], [3, 1.5, 4.5, 3, 1], "a finished run counts what it drew; a running one the rest of its estimate; a cached one nothing");
    near(f.remainingCost, 1.5 / 1000 * 0.25);
    assert.deepEqual(f.models[LOCAL].left, 1);
    assert.match(energyForecastText(f), /^electricity 3\.00 Wh so far; about 4\.50 Wh by the end \(3 runs left, about 0\.0004 EUR for them at 0\.25 EUR\/kWh\); 1 run on a local model with no energy on record, not in it$/);
    const bare = energyForecast(pred, { stateOf: () => "pending", modelOf: () => LOCAL });
    assert.equal(bare.remainingCost, null);
    assert.match(energyForecastText(bare, { start: true }), /^electricity estimate: about 9\.00 Wh for the 5 runs to run \(no electricity price set: energy only\)/);
});

test("the coming runs' electricity price comes from the runner's settings, a tariff on this device's zone", () => {
    assert.equal(priceFromSettings({}), null);
    assert.deepEqual(priceFromSettings({ electricityPerKwh: 0.26, electricityCurrency: "GBP" }), { perKwh: 0.26, currency: "GBP" });
    const t = priceFromSettings({ electricityPerKwh: 0.26, electricityOffPeakPerKwh: 0.22, electricityOffPeakHours: "23-7" });
    assert.deepEqual({ ...t.tariff, tz: typeof t.tariff.tz }, { normalPerKwh: 0.26, offPeakPerKwh: 0.22, offPeakHours: "23-7", offPeakWeekends: true, tz: "string" });
});

// --- the page ---

async function page(state) {
    const w = new JSDOM(await staticPage(state), { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true }).window;
    await new Promise((r) => w.setTimeout(r, 10));
    return w;
}
const tally = (o) => ({ calls: 0, computed: 0, computedCalls: 0, reported: 0, reportedCalls: 0, local: 0, unpriced: 0, pending: 0, ...o });
const base = { name: "s", dims: ["model"], runs: [{ combo: { model: EXT }, taskId: "t", repeat: 0, state: "running", who: EXT, models: { driver: EXT } }], rows: [], jobs: 1, started: 1_760_000_000_000 };

test("the header badge and the model's pill carry the estimate with its tip; a page from before the estimate shows only the spend", async (t) => {
    const f = forecast(PRED, { stateOf: () => "pending", modelOf: (i) => MODELS[i], cachedOf: (i) => i === 5, prices: "2026-10-10T12:07:01Z" });
    const spend = { currency: "USD", total: tally({ calls: 1, computed: 0.004, computedCalls: 1 }), models: { [EXT]: tally({ calls: 1, computed: 0.004, computedCalls: 1 }) }, runs: {} };
    const w = await page({ ...base, spend, forecast: f });
    t.after(() => w.close());
    const badge = w.document.querySelector(".badge.spend");
    assert.match(badge.textContent, /^spent0\.0040 USD·est\. ≥ 0\.0300 USD$/, "some runs with no estimate: a lower bound, said before the figure");
    const tip = badge.querySelector(".est").getAttribute("data-tip");
    assert.match(tip, /5 runs left/);
    assert.match(tip, /the snapshot of 2026-10-10 12:07 UTC/);
    assert.match(tip, /1 run on a local model: electricity, not priced here\. 1 run with no estimate \(no past run of who\), not in the figure\./);
    const pill = w.document.querySelector(".role.spend");
    assert.match(pill.textContent, /^spent0\.0040 USD·est\. 0\.0300 USD/);
    assert.match(pill.querySelector(".est").getAttribute("data-tip"), new RegExp(`${EXT.replace(/[./]/g, "\\$&")}'s runs in this sweep by its end`));
    const old = await page({ ...base, spend });
    t.after(() => old.close());
    assert.equal(old.document.querySelector(".badge.spend .est"), null);
    assert.match(old.document.querySelector(".badge.spend").textContent, /^spent0\.0040 USD$/);
});

// --- the whole estimate, in one line ---

test("one line says what the runs left will cost, cloud and local apart, counting what neither estimate covers", () => {
    const f = (o) => ({ currency: "USD", prices: null, spent: 0, remaining: 0.62, total: 0.62, left: 10, local: 4, unknown: 0, why: null, basis: { item: 6, task: 0, model: 0 }, models: {}, ...o });
    const ef = (o) => ({ currency: "EUR", perKwh: 0.25, spentWh: 0, remainingWh: 41.5, totalWh: 41.5, left: 10, unknown: 0, remainingCost: 0.0104, basis: { item: 4, task: 0, model: 0, none: 6 }, models: {}, ...o });
    assert.equal(estimateLine(f(), ef()), "estimate for the 10 runs left: cloud about 0.62 USD over 6 runs; local about 41.5 Wh, 0.01 EUR");
    assert.equal(estimateLine(f({ unknown: 2, remaining: 0.4 }), ef({ unknown: 1, remainingCost: null })),
        "estimate for the 10 runs left: cloud about 0.40 USD over 4 runs (+2 runs with no estimate); local about 41.5 Wh (no electricity price set) (+1 run with no energy on record)");
    assert.equal(estimateLine(f({ unknown: 6, remaining: 0 }), ef()), "estimate for the 10 runs left: cloud: no estimate for its 6 runs; local about 41.5 Wh, 0.01 EUR", "a fresh clone's empty history says so, never 0");
    assert.equal(estimateLine(f({ local: 0 }), null), "estimate for the 10 runs left: cloud about 0.62 USD over 10 runs", "all cloud");
    assert.equal(estimateLine(f(), null), "estimate for the 10 runs left: cloud about 0.62 USD over 6 runs; local: 4 runs, no energy on record");
    assert.equal(estimateLine(null, ef()), "estimate for the 10 runs left: local about 41.5 Wh, 0.01 EUR", "no price data: the cloud unsaid");
    assert.equal(estimateLine(f({ left: 0 }), ef({ left: 0 })), null, "nothing left");
    assert.equal(estimateLine(null, null), null);
});
