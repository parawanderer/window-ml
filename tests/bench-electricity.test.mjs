// The bench's electricity (tests/e2e/bench/electricity.mjs): power readings integrated between samples (GPU watts by
// trapezoid, energy counters by their differences across a wrap), nested scopes never added, each interval's energy
// split among the generations in it, the draw above rest in the half minute after a generation still that
// generation's, each moment priced at its own tariff rate, and the scores report's energy and electricity columns, with
// energy alone (and a warning) for a run that had no price.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { reading, intervals, measured, attribute, genSpan, placement, channels, rateAt, priceShare, runEnergy, energyByModel, sweepEnergy, energyLine, MAX_GAP_MS } from "../tests/e2e/bench/electricity.mjs";
import { statusText } from "../tests/e2e/bench/status.mjs";
import { staticPage } from "../tests/e2e/bench/serve.mjs";
import { openBoxLog, logFrames } from "../tests/e2e/bench/box-stream.mjs";
import { openScores } from "../tests/e2e/bench/scores.mjs";
import { callsOf, logCalls, spendReport, spendText } from "../tests/e2e/bench/spend.mjs";

const close = (got, want, msg, tol = 1e-6) => assert.ok(Math.abs(got - want) <= tol * Math.max(1, Math.abs(want)), `${msg}: ${got} vs ${want}`);
const gpu = (...w) => ({ supported_gpus: w.map((x) => ({ power: { draw_mw: x * 1000, limit_mw: 600_000 } })) });
const rapl = (mj, extra = {}) => ({ provider: "rapl", scope: "cpu", power_mw: 0, energy_mj: mj, energy_wrap_mj: 65_532_610, at_ms: 0, ...extra });

// --- readings and intervals ---

test("GPU board power integrates by trapezoid over every GPU; a GPU with no reading makes the GPUs unmeasured, not 0", () => {
    const [iv] = intervals([reading(0, gpu(100, 50)), reading(2000, gpu(300, 50))]);
    close(iv.J.gpu, ((150 + 350) / 2) * 2, "two GPUs, two seconds");
    assert.equal(reading(0, { supported_gpus: [{ power: { draw_mw: 1 } }, {}] }).gpuW, null);
    assert.deepEqual(intervals([reading(0, {}), reading(1000, {})]), [], "nothing measured: no interval");
});

test("an energy counter counts its difference, across a wrap; a source restart and a long gap are unmeasured", () => {
    const at = (t, mj) => reading(t, { power_sources: [rapl(mj)] });
    close(intervals([at(0, 1_000_000), at(1000, 1_080_000)])[0].J.cpu, 80, "80 J in a second");
    close(intervals([at(0, 65_532_000), at(1000, 1000)])[0].J.cpu, 1.61, "wrapped at energy_wrap_mj");
    const reset = reading(1000, { power_sources: [rapl(1000, { energy_wrap_mj: undefined })] });
    assert.deepEqual(intervals([at(0, 5000), reset]), [], "a decrease with no wrap is a restart");
    assert.deepEqual(intervals([reading(0, gpu(100)), reading(MAX_GAP_MS + 1, gpu(100))]), [], "a gap past MAX_GAP_MS");
    assert.deepEqual(reading(0, { power_sources: [rapl(1, { error: "permission denied" }), { provider: "x", scope: "moon", power_mw: 5 }] }).counters, {}, "an erroring source and an unknown scope are left out");
});

test("scopes nest, so they are never added across: the wall when there is one, else the system, else GPU + CPU", () => {
    assert.deepEqual(measured({ wall: 100, system: 90, gpu: 60, cpu: 20 }), { J: 100, basis: "wall" });
    assert.deepEqual(measured({ system: 90, gpu: 60, cpu: 20 }), { J: 90, basis: "system" });
    assert.deepEqual(measured({ gpu: 60, cpu: 20 }), { J: 80, basis: "gpu+cpu" });
    assert.deepEqual(measured({ cpu: 20 }), { J: 20, basis: "cpu" });
    assert.equal(measured({}), null);
});

// --- whose energy it is ---

test("an interval goes to the generations in it by overlap, a stranger's generation taking its share too", () => {
    const ivs = [{ from: 0, to: 1000, J: { gpu: 90 } }];
    const { sessions } = attribute(ivs, [{ from: 0, to: 1000, session: "A" }, { from: 500, to: 1000, session: null }]);
    close(sessions.get("A").J, 60, "A covered 1000 of 1500 ms of generation");
    assert.equal(sessions.size, 1, "the stranger's share is nobody's");
});

/** A box at 50 W rest; A generates 60-64 s at 450 W, then the GPUs clock down at 150 W until 70 s. */
const profile = (t) => (t >= 60_000 && t <= 64_000 ? 450 : t > 64_000 && t <= 70_000 ? 150 : 50);
const samples = Array.from({ length: 121 }, (_, i) => i * 1000);
const SPAN_A = { from: 60_000, to: 64_000, session: "wml-a" };

test("the draw above rest in the 30 s after a generation is still that generation's; rest is the box 30 s after any", () => {
    const { restW, sessions } = attribute(intervals(samples.map((t) => reading(t, gpu(profile(t))))), [SPAN_A]);
    assert.equal(restW, 50);
    const a = sessions.get("wml-a");
    close(a.J, 4 * 450 + (250 + 5 * 100 + 50), "generating, then the tail above rest");
    close(a.tailJ, 800, "the tail");
    close(a.aboveJ, 4 * 400 + 800, "above rest");
    close(a.ms, 4000, "generation time only");
});

test("with no rest in reach, the tail is not given away and nothing is said above rest, unless a rest is supplied", () => {
    const busy = samples.slice(58, 75).map((t) => reading(t, gpu(profile(t))));   // 58-74 s: no 30 s of quiet
    const none = attribute(intervals(busy), [SPAN_A]);
    assert.equal(none.restW, null);
    assert.equal(none.sessions.get("wml-a").aboveJ, null);
    close(none.sessions.get("wml-a").tailJ, 0, "no tail");
    close(attribute(intervals(busy), [SPAN_A], { restBy: { "gpu:0": 50 } }).sessions.get("wml-a").tailJ, 800, "the box's rest, supplied");
});

// --- which GPU ---

/** A frame's compute and models: two cards at the given watts, and where each model sits (its VRAM per card). */
const twoCards = (w0, w1, cpuMj = null) => ({ supported_gpus: [{ gpu_id: "0", power: { draw_mw: w0 * 1000 } }, { gpu_id: "1", power: { draw_mw: w1 * 1000 } }],
    ...(cpuMj == null ? {} : { power_sources: [rapl(cpuMj)] }) });
const PS = [{ name: "big:31b", gpus: [{ gpu_id: "0", size_vram: 40e9 }] }, { name: "small:4b", gpus: [{ gpu_id: "1", size_vram: 4e9 }] },
    { name: "split:70b", gpus: [{ gpu_id: "0", size_vram: 30e9 }, { gpu_id: "1", size_vram: 10e9 }] }];
/** Ten seconds of readings at constant draw, a reading a second. */
const steady = (w0, w1, cpuW = null) => intervals(Array.from({ length: 11 }, (_, i) => reading(i * 1000, twoCards(w0, w1, cpuW == null ? null : i * cpuW * 1000), PS)));
const span = (session, model, from = 0, to = 10_000) => ({ from, to, session, model });

test("where a model sits: its VRAM per card as shares, read off the frame, the registry prefix and :latest dropped", () => {
    assert.deepEqual(placement([...PS, { name: "registry.ollama.ai/library/glm:latest", gpus: [{ gpu_id: "1", size_vram: 1 }] }, { name: "cpu-only", gpus: [] }]),
        { "big:31b": { 0: 1 }, "small:4b": { 1: 1 }, "split:70b": { 0: 0.75, 1: 0.25 }, glm: { 1: 1 } });
    const [iv] = steady(350, 150);
    assert.deepEqual(iv.gpuBy, { 0: 350, 1: 150 });
    assert.deepEqual(channels(iv).ch.map((c) => [c.key, c.J]), [["gpu:0", 350], ["gpu:1", 150]], "GPUs only: no box channel");
});

test("two models on two cards each pay their own card's draw, not half the sum", () => {
    const { sessions } = attribute(steady(350, 150), [span("A", "big:31b"), span("B", "small:4b")]);
    close(sessions.get("A").J, 3500, "big on GPU0 at 350 W for 10 s");
    close(sessions.get("B").J, 1500, "small on GPU1 at 150 W");
    close(sessions.get("A").ms, 10_000, "generation time is the span's, once");
});

test("two models on ONE card split it by overlap; the other card, drawing for nobody, is nobody's", () => {
    const ps = [{ name: "a", gpus: [{ gpu_id: "0", size_vram: 1 }] }, { name: "b", gpus: [{ gpu_id: "0", size_vram: 1 }] }];
    const ivs = intervals(Array.from({ length: 11 }, (_, i) => reading(i * 1000, twoCards(400, 30), ps)));
    const { sessions } = attribute(ivs, [span("A", "a"), span("B", "b", 5000, 10_000)]);
    close(sessions.get("A").J, 400 * 5 + 400 * 5 * (2 / 3) * 0 + 200 * 5, "alone for 5 s, then half the card");
    close(sessions.get("B").J, 200 * 5, "half the card for its 5 s");
    close(sessions.get("A").J + sessions.get("B").J, 4000, "GPU1's 300 J went to nobody");
});

test("a model split across both cards pays each card by its share of it; the CPU is the box's, split by overlap", () => {
    const { sessions } = attribute(steady(300, 100, 50), [span("S", "split:70b"), span("B", "small:4b")]);
    // GPU0: only split sits there → all 3000 J. GPU1: split (share 0.25) and small (share 1), both all 10 s: 0.2 / 0.8.
    // CPU: 500 J between the two, by overlap: half each.
    close(sessions.get("S").J, 3000 + 1000 * 0.2 + 250, "S");
    close(sessions.get("B").J, 1000 * 0.8 + 250, "B");
    assert.deepEqual(Object.keys(sessions.get("S").scopes).sort(), ["cpu", "gpu"]);
});

test("where a model sits is unknown (no ps in the frame): it counts as on every card", () => {
    const ivs = intervals(Array.from({ length: 11 }, (_, i) => reading(i * 1000, twoCards(350, 150))));
    const { sessions } = attribute(ivs, [span("A", "big:31b"), span("B", "small:4b")]);
    close(sessions.get("A").J, 2500, "half of each card, as before per-card readings");
});

test("a card's tail goes only to what ended on that card; each card has its own rest", () => {
    // GPU0 rests at 20 W and GPU1 at 30 W; A (on GPU0) runs 40-44 s at 400 W, then GPU0 clocks down at 100 W to 50 s.
    const w0 = (t) => (t >= 40_000 && t <= 44_000 ? 400 : t > 44_000 && t <= 50_000 ? 100 : 20);
    const ivs = intervals(Array.from({ length: 121 }, (_, i) => reading(i * 1000, twoCards(w0(i * 1000), 30), PS)));
    const { restBy, sessions } = attribute(ivs, [span("A", "big:31b", 40_000, 44_000), span("B", "small:4b", 40_000, 44_000)]);
    assert.deepEqual(restBy, { "gpu:0": 20, "gpu:1": 30 });
    close(sessions.get("A").tailJ, (250 - 20) + 5 * 80 + (60 - 20), "GPU0's draw above its rest after A");
    close(sessions.get("B").tailJ, 0, "GPU1 never rose: B has no tail, and none of A's");
});

test("a generation's span runs back from its gen.end for its prompt and decode time; one with no timings has none", () => {
    assert.deepEqual(genSpan({ at: 10_000, session: "s", model: "m", promptMs: 62.5, evalMs: 937.5 }), { from: 9000, to: 10_000, session: "s", model: "m" });
    assert.equal(genSpan({ at: 10_000, promptMs: null, evalMs: null }), null);
});

// --- the price ---

test("each moment is priced at its own rate: a stretch crossing into off-peak, on the tariff's clock", () => {
    const price = { perKwh: 0.3, currency: "EUR", rate: "normal", tariff: { normalPerKwh: 0.3, offPeakPerKwh: 0.1, offPeakHours: "23-7", offPeakWeekends: false, tz: "UTC" } };
    const before = Date.UTC(2026, 9, 5, 22, 59), after = Date.UTC(2026, 9, 5, 23, 1);   // a Monday, either side of 23:00 UTC
    assert.deepEqual([rateAt(price, before), rateAt(price, after)], [0.3, 0.1]);
    const got = priceShare({ aboveJ: 3.6e6, at: [[before, 3.6e6, 1.8e6], [after, 3.6e6, 1.8e6]] }, price);
    close(got.cost, 0.4, "one kWh at each rate");
    close(got.costAbove, 0.2, "above rest at the same rates");
    assert.equal(got.currency, "EUR");
    assert.deepEqual(priceShare({ aboveJ: 0, at: [[before, 1, 1]] }, null), { cost: null, costAbove: null, currency: null }, "no price: no cost, never 0");
    assert.equal(rateAt({ perKwh: 0.26, currency: "GBP" }, before), 0.26, "one rate");
});

// --- from the box log ---

const A = "a".repeat(32), B = "b".repeat(32);
async function boxWith(frames) {
    const db = await openBoxLog(path.join(mkdtempSync(path.join(os.tmpdir(), "bench-elec-")), "box.sqlite"));
    logFrames(db, frames.map(([at, frame]) => ({ frame, at, serverAt: at, box: "box1" })));
    return db;
}
const sampleFrames = (t0) => samples.map((t) => [t0 + t, { v: 1, kind: "sample", info: { compute: gpu(profile(t)) } }]);
const genEnd = (at, session) => [at, { v: 1, kind: "gen.end", model: "glm", timings: { prompt_ms: 1000, eval_ms: 3000 }, hint: { session } }];

test("each run's energy from the box log, priced at its calls' price; a run the box never generated for is not there", async () => {
    const t0 = Date.UTC(2026, 9, 5, 12, 0);
    const db = await boxWith([...sampleFrames(t0), genEnd(t0 + 64_000, `wml-${A}`)]);
    const e = runEnergy(db, [{ run: A, price: { perKwh: 0.25, currency: "EUR" } }, { run: B, price: null }]);
    assert.deepEqual([...e.keys()], [A]);
    const a = e.get(A);
    close(a.Wh, 2600 / 3600, "Wh");
    close(a.aboveWh, 2400 / 3600, "above rest");
    close(a.cost, (2600 / 3.6e6) * 0.25, "cost");
    assert.deepEqual([a.basis, a.restW, a.currency, a.ms], ["gpu", 50, "EUR", 4000]);
    const by = energyByModel(e, () => "glm");
    assert.deepEqual([by.get("glm").runs, by.get("glm").unpriced], [1, 0]);
    db.close();
});

test("UPGRADE: a box log from before power was reported gives no energy, never 0", async () => {
    const t0 = Date.UTC(2026, 9, 5, 12, 0);
    const db = await boxWith([...samples.map((t) => [t0 + t, { v: 1, kind: "sample", info: { compute: { supported_gpus: [{ id: "0" }] } } }]), genEnd(t0 + 64_000, `wml-${A}`)]);
    assert.equal(runEnergy(db, [{ run: A, price: null }]).size, 0);
    db.close();
});

test("a sweep's electricity: per driver model and per run index, from the sweep's own time; none when the box drew for no run", async () => {
    const t0 = Date.UTC(2026, 9, 5, 12, 0);
    const db = await boxWith([...sampleFrames(t0), genEnd(t0 + 64_000, `wml-${A}`)]);
    const e = sweepEnergy(db, [{ index: 3, run: A, price: null }, { index: 4, run: B, price: null }], (i) => (i === 3 ? "glm" : "cloud"), { since: t0 });
    assert.deepEqual([Object.keys(e.models), Object.keys(e.runs), e.total.runs, e.total.unpriced], [["glm"], ["3"], 1, 1]);
    assert.equal(energyLine(e.total), "0.72 Wh over 1 run (0.67 above rest); 1 run with no electricity price (energy only; set one in DevTools Settings > Spend); measured as GPUs only");
    assert.equal(sweepEnergy(db, [{ index: 3, run: A, price: null }], () => "glm", { since: t0 + 3_600_000 }), null, "generations before `since` are not the sweep's");
    db.close();
});

test("UPGRADE: a box log written before the (kind, at) index gains it on open, its frames intact, and the live read uses it", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "bench-elec-")), "box.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE frames (id INTEGER PRIMARY KEY, box TEXT NOT NULL, server_at INTEGER, at INTEGER NOT NULL, kind TEXT NOT NULL, frame TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE (box, server_at, kind, digest));
        CREATE INDEX frames_at ON frames (box, at);`);
    old.prepare("INSERT INTO frames (box, server_at, at, kind, frame, digest) VALUES ('b', 1, 1, 'gen.end', '{}', 'd')").run();
    old.close();
    const db = await openBoxLog(file);
    assert.equal(db.prepare("SELECT count(*) n FROM frames").get().n, 1);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT at FROM frames WHERE kind = 'gen.end' AND at >= ?").all(0).map((r) => r.detail).join(" ");
    assert.match(plan, /frames_kind_at/);
    db.close();
});

// --- on the sweep page and in status.md ---

const ENERGY = { total: { runs: 2, Wh: 1.5, aboveWh: 1.2, cost: 0.0004, costAbove: 0.0003, currency: "EUR", unpriced: 1, basis: "gpu+cpu" } };
ENERGY.models = { glm: ENERGY.total };
ENERGY.runs = { 0: ENERGY.total };
const EFORE = { currency: "EUR", perKwh: 0.25, spentWh: 1.5, remainingWh: 2, totalWh: 3.5, left: 2, unknown: 0, remainingCost: 0.0005, basis: { item: 2, task: 0, model: 0, none: 0 } };
EFORE.models = { glm: { ...EFORE } };
const SWEEP = { name: "s", dims: ["model"], runs: [{ combo: { model: "glm" }, taskId: "t", repeat: 0, state: "running", who: "glm", models: { driver: "glm" } }], rows: [], jobs: 1, started: 1_760_000_000_000 };

test("status.md says what the box drew and what it is estimated to draw, as the page does", () => {
    const md = statusText({ ...SWEEP, energy: ENERGY, energyForecast: EFORE }, 1_760_000_001_000);
    assert.match(md, /## Electricity \(this invocation, from the box's power readings; re-read every 30 s\)\n\n1\.50 Wh over 2 runs \(1\.20 above rest\); 0\.0004 EUR; 1 run with no electricity price/);
    assert.match(md, /- glm: 1\.50 Wh over 2 runs/);
    assert.match(md, /## Electricity estimate \(narrows as runs finish\)\n\nelectricity 1\.50 Wh so far; about 3\.50 Wh by the end/);
    assert.doesNotMatch(statusText(SWEEP, 1_760_000_001_000), /Electricity/, "no box energy: no section");
});

test("the header badge and the model's pill show the power drawn, its cost, a warning for unpriced runs, and the estimate", async (t) => {
    const w = new JSDOM(await staticPage({ ...SWEEP, energy: ENERGY, energyForecast: EFORE }), { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true }).window;
    t.after(() => w.close());   // closed even when an assertion fails: an open window keeps the test process alive
    await new Promise((r) => w.setTimeout(r, 10));
    const badge = w.document.querySelector(".badge.spend");
    // The separators are their own elements, spaced by the stylesheet: the text runs together here, not on screen.
    assert.equal(badge.textContent, "spent0.0004 EUR 1.50 Wh·est. 3.50 Wh");
    assert.deepEqual([...badge.querySelectorAll(".sep")].map((e) => e.textContent), ["·"]);
    assert.ok(badge.querySelector(".warn-price svg"), "the warning icon");
    assert.match(badge.querySelector(".warn-price").getAttribute("data-tip"), /1 run had no electricity price.*DevTools Settings > Spend/);
    assert.match(badge.querySelector(".tt").getAttribute("data-tip"), /GPUs \+ CPU package/);
    assert.equal(w.document.querySelector(".role.spend").textContent, "spent0.0004 EUR 1.50 Wh·est. 3.50 Wh", "every call local: electricity is the figure, no token one");
});

// --- in the scores report ---

const SESSION = JSON.parse(readFileSync(new URL("./fixtures/bench/spend-session.json", import.meta.url)));

test("the spend section gains energy and electricity: a priced run's cost, and energy alone with a warning for one with no price", async () => {
    const db = await openScores(path.join(mkdtempSync(path.join(os.tmpdir(), "bench-elec-")), "scores.sqlite"));
    const s = structuredClone(SESSION);
    s.steps[0].usage = { ...s.steps[0].usage, electricity: { perKwh: 0.25, currency: "EUR" } };
    logCalls(db, callsOf(s));
    const t0 = Date.parse(s.steps[0].ts ?? "2026-10-09T08:46:00Z");
    const box = await boxWith([...sampleFrames(t0), genEnd(t0 + 64_000, `wml-${s.hash}`)]);
    const rows = [{ run: s.hash, model: "glm-4.7-flash" }];
    const spend = spendReport(db, rows, (r) => r.model, { box });
    const [m] = spend.models;
    close(m.energy.Wh, 2600 / 3600, "Wh");
    close(m.energy.cost, (2600 / 3.6e6) * 0.25, "cost");
    const text = spendText(spend).join("\n");
    assert.match(text, /energy, Wh \(runs\) \| electricity \|/);
    assert.match(text, /\| 0\.72 \(1\), 0\.67 above rest \| 0\.0002 EUR \(0\.0002 above rest\) \|/);
    assert.match(text, /Energy measured as: GPUs only\./);
    assert.match(text, /- \*\*electricity\*\*: .*Settings > Spend/);

    const bare = structuredClone(SESSION);
    const db2 = await openScores(path.join(mkdtempSync(path.join(os.tmpdir(), "bench-elec-")), "scores.sqlite"));
    logCalls(db2, callsOf(bare));
    const noPrice = spendReport(db2, rows, (r) => r.model, { box });
    assert.equal(noPrice.models[0].energy.cost, null);
    assert.match(spendText(noPrice).join("\n"), /\| 0\.72 \(1\), 0\.67 above rest \| ⚠ 1 run with no electricity price \|/);
    assert.equal(spendReport(db2, rows, (r) => r.model).models[0].energy, undefined, "no box log: no energy columns");
    assert.doesNotMatch(spendText(spendReport(db2, rows, (r) => r.model)).join("\n"), /energy/);
    for (const d of [db, db2, box]) d.close();
});
