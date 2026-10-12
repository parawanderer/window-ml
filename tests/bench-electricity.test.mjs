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
import { reading, intervals, measured, attribute, genSpan, rateAt, priceShare, runEnergy, energyByModel, MAX_GAP_MS } from "../tests/e2e/bench/electricity.mjs";
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
    close(attribute(intervals(busy), [SPAN_A], { restW: 50 }).sessions.get("wml-a").tailJ, 800, "the box's rest, supplied");
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
