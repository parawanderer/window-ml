// What a bench run's model calls spent, kept raw (tests/e2e/bench/spend.mjs): which calls a run.json holds and which
// model served each, the price snapshot bodies kept once by a hash they must match, an old scores log gaining the tables,
// the spend settings a real run sets, and both tables through the store and back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { callsOf, priceHashes, logCalls, readCalls, logSnapshot, missingSnapshots } from "../tests/e2e/bench/spend.mjs";
import { openScores } from "../tests/e2e/bench/scores.mjs";
import { spendFromEnv, backendFromDotenv } from "../tests/e2e/run-once.mjs";

/** A real run.json's session (deepseek-flash, three turns), trimmed to steps and events. It predates `raw` and
 *  `prices`, so `withSpend` adds them as #542/#547/#551 record them. */
const SESSION = JSON.parse(readFileSync(new URL("./fixtures/bench/spend-session.json", import.meta.url)));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const PRICES = { fetchedAt: "2026-10-10T09:00:00Z", sources: { openrouter: sha("or-body"), owui_models: sha("models-body") } };
const withSpend = () => {
    const s = structuredClone(SESSION);
    s.steps[0].usage = { ...s.steps[0].usage, raw: { prompt_tokens: 12050, cost: 0.0012, cost_details: { upstream_inference_cost: 0.001 } },
        prices: PRICES, electricity: { perKwh: 0.31, currency: "EUR" }, genPhases: [{ kind: "answer", atMs: 0 }] };
    s.steps[1].subUsage = { prompt: 900, completion: 40, calls: 1, calls_: [{ model: "qwen-vl", ts: Date.parse("2026-10-09T08:46:22.5Z"), ms: 800, prompt: 900, completion: 40 }] };
    return s;
};
const tmpDb = async () => openScores(path.join(mkdtempSync(path.join(os.tmpdir(), "bench-spend-")), "scores.sqlite"));

// --- reading the calls out of a run ---

test("each turn is one call, in order, with its model read from the gen event of the same counts", () => {
    const calls = callsOf(SESSION);
    assert.deepEqual(calls.map((c) => [c.call, c.kind, c.step, c.model]), [[0, "turn", 1, "deepseek.deepseek-flash"], [1, "turn", 2, "deepseek.deepseek-flash"], [2, "turn", 3, "deepseek.deepseek-flash"]]);
    assert.equal(JSON.parse(calls[0].usage).promptTokens, 12050);
    assert.ok(calls.every((c) => c.run === SESSION.hash && c.at));
});

test("the usage is kept as recorded (raw, prices, electricity), less the phase marks; a delegated call follows its step", () => {
    const calls = callsOf(withSpend());
    const u = JSON.parse(calls[0].usage);
    assert.deepEqual(u.raw.cost_details, { upstream_inference_cost: 0.001 });
    assert.deepEqual(u.prices, PRICES);
    assert.deepEqual(u.electricity, { perKwh: 0.31, currency: "EUR" });
    assert.equal(u.genPhases, undefined);
    assert.deepEqual(calls.map((c) => c.kind), ["turn", "sub", "turn", "turn"]);
    // steps[1] is step 1's tool record: the delegated call it made comes after the turn that chose the tool.
    assert.deepEqual([calls[1].model, calls[1].step, JSON.parse(calls[1].usage).promptTokens], ["qwen-vl", 1, 900]);
});

test("a delegated call keeps what it recorded beyond its counts, and its snapshot is collected too", () => {
    const s = withSpend();
    const other = { fetchedAt: "x", sources: { litellm_map: sha("map-body") } };
    Object.assign(s.steps[1].subUsage.calls_[0], { raw: { cost: 0.002 }, prices: other, electricity: { perKwh: 0.31, currency: "EUR" } });
    const u = JSON.parse(callsOf(s)[1].usage);
    assert.deepEqual([u.raw.cost, u.prices, u.electricity.perKwh], [0.002, other, 0.31]);
    assert.equal(priceHashes(s).get(sha("map-body")), "litellm_map");
});

test("a turn no gen event matches has no model (null), never the session's guessed in", () => {
    const s = structuredClone(SESSION);
    s.events = s.events.filter((e) => e.kind !== "gen");
    assert.ok(callsOf(s).every((c) => c.model === null));
});

test("a run with no usage anywhere has no calls, and no session has none either", () => {
    const s = structuredClone(SESSION);
    for (const st of s.steps) delete st.usage;
    assert.deepEqual(callsOf(s), []);
    assert.deepEqual(callsOf(null), []);
});

test("the price snapshots a run names, by hash with the source's name", () => {
    assert.deepEqual([...priceHashes(withSpend())], [[sha("or-body"), "openrouter"], [sha("models-body"), "owui_models"]]);
    assert.equal(priceHashes(SESSION).size, 0);
});

// --- the log ---

test("calls are logged once per (run, call); a re-log adds nothing", async () => {
    const db = await tmpDb();
    assert.equal(logCalls(db, callsOf(withSpend())), 4);
    assert.equal(logCalls(db, callsOf(withSpend())), 0);
    assert.equal(readCalls(db)[0].usage.raw.cost, 0.0012);
    db.close();
});

test("a snapshot body is kept once, only under the hash it has", async () => {
    const db = await tmpDb();
    const hash = sha("or-body");
    assert.equal(logSnapshot(db, { hash, kind: "openrouter", body: "not-the-body" }), null, "a mismatch is refused");
    assert.deepEqual(missingSnapshots(db, [hash]), [hash]);
    assert.equal(logSnapshot(db, { hash, kind: "openrouter", body: Buffer.from("or-body") }), true);
    assert.equal(logSnapshot(db, { hash, kind: "openrouter", body: "or-body" }), false, "already kept");
    assert.deepEqual(missingSnapshots(db, [hash]), []);
    assert.equal(Buffer.from(db.prepare("SELECT body FROM snapshots").get().body).toString(), "or-body");
    db.close();
});

test("UPGRADE: a scores log from before the spend tables opens with them, empty, and its runs intact", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "bench-spend-")), "scores.sqlite");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, run TEXT NOT NULL UNIQUE, at TEXT NOT NULL, by TEXT NOT NULL, sweep TEXT NOT NULL, spec TEXT, spec_hash TEXT, task TEXT NOT NULL, task_hash TEXT NOT NULL, task_text TEXT, variant TEXT NOT NULL, scored INTEGER NOT NULL, model TEXT NOT NULL, digest TEXT, quant TEXT, params TEXT, local INTEGER, vision TEXT, utility TEXT, backend TEXT, build TEXT NOT NULL, dirty INTEGER NOT NULL, passed INTEGER, error TEXT, hit_cap INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, sub_tokens INTEGER, tokens INTEGER, steps INTEGER NOT NULL, secs REAL NOT NULL)");
    old.exec("INSERT INTO runs (run, at, by, sweep, task, task_hash, variant, scored, model, build, dirty, hit_cap, steps, secs) VALUES ('r1', 'x', 'y', 's', 't', 'h', '{}', 1, 'm', 'b', 0, 0, 2, 1.0)");
    old.close();
    const db = await openScores(file);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
    assert.deepEqual(readCalls(db), []);
    assert.equal(logCalls(db, callsOf(SESSION)), 3);
    db.close();
});

// --- the settings a real run sets ---

test("spend settings come from the environment over .env, and each absent one stays absent", () => {
    assert.deepEqual(spendFromEnv({}, {}), {});
    assert.deepEqual(spendFromEnv({ PRICE_SNAPSHOT_URL: "http://box:3002", ELECTRICITY_PER_KWH: "0.31" }, { ELECTRICITY_CURRENCY: "CHF" }),
        { priceSnapshotUrl: "http://box:3002", electricityPerKwh: 0.31, electricityCurrency: "CHF" });
    assert.deepEqual(spendFromEnv({ ELECTRICITY_PER_KWH: "0" }), {}, "0 is the extension's unset");
    assert.deepEqual(spendFromEnv({ ELECTRICITY_PER_KWH: "abc" }), {});
    assert.equal(backendFromDotenv({ OPENWEBUI_URL: "http://h", PRICE_SNAPSHOT_URL: "http://box:3002" }).priceSnapshotUrl, "http://box:3002");
    assert.equal("priceSnapshotUrl" in backendFromDotenv({ OPENWEBUI_URL: "http://h" }), false);
});

test("a two-rate tariff's off-peak half comes from .env only alongside a price, with each part optional", () => {
    const base = { ELECTRICITY_PER_KWH: "0.26216", ELECTRICITY_OFFPEAK_PER_KWH: "0.22113" };
    assert.deepEqual(spendFromEnv({ ...base, ELECTRICITY_OFFPEAK_HOURS: "23-7", ELECTRICITY_OFFPEAK_WEEKENDS: "false" }),
        { electricityPerKwh: 0.26216, electricityCurrency: "EUR", electricityOffPeakPerKwh: 0.22113, electricityOffPeakHours: "23-7", electricityOffPeakWeekends: false });
    assert.deepEqual(spendFromEnv(base), { electricityPerKwh: 0.26216, electricityCurrency: "EUR", electricityOffPeakPerKwh: 0.22113 }, "unset hours and weekends keep the extension's defaults");
    assert.deepEqual(spendFromEnv({ ELECTRICITY_OFFPEAK_PER_KWH: "0.22" }), {}, "no off-peak price without a price");
    assert.equal(spendFromEnv({ ...base, ELECTRICITY_OFFPEAK_WEEKENDS: "true" }).electricityOffPeakWeekends, true);
});

// --- the spend section of scores.md ---

test("spend per model: computed and reported apart, unpriced counted with why, older runs said to have no per-call data", async () => {
    const { spendReport, spendText } = await import("../tests/e2e/bench/spend.mjs");
    const db = await tmpDb();
    assert.equal(spendReport(db, [], (r) => r.model), null, "no calls, no section");
    logCalls(db, callsOf(withSpend()));
    const rows = [{ run: SESSION.hash, model: "deepseek.deepseek-flash" }, { run: "older", model: "deepseek.deepseek-flash" }];
    const spend = spendReport(db, rows, (r) => r.model);
    assert.deepEqual([spend.calls, spend.runsWithCalls, spend.runsWithout], [4, 1, 1]);
    const [m] = spend.models;
    // The snapshot's bodies were never stored: the call that names it has no model list to join through.
    assert.deepEqual([m.reported, m.reportedCalls, m.computedCalls, m.unpriced], [0.0012, 1, 0, 3], "the reported call is priced by the provider; the other three by nothing");
    const text = spendText(spend).join("\n");
    assert.match(text, /## Spend/);
    assert.match(text, /1 run logged before calls were recorded has no per-call data/);
    assert.match(text, /0\.0012 USD \(1\)/);
    db.close();
});
