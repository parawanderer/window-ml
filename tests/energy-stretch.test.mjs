// energy-stretch.test.mjs — one stretch of a local runtime's generations watched live (src/spend/energy-stretch.ts):
// what it writes at each of our generations' ends, when it closes, and what a worker that died inside it leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnergyStretch, cutOpen, hasPower } from "../src/spend/energy-stretch.ts";
import { REST_MS, TAIL_MS } from "../src/spend/energy.ts";

const OURS = "wml-ours", THEIRS = "wml-theirs";
/** A sample frame with one GPU drawing `w` watts. */
const sample = (w) => ({ kind: "sample", t: 0, info: { compute: { supported_gpus: [{ gpu_id: "0", power: { draw_mw: w * 1000 } }], power_sources: [] } } });
/** A gen.end of `session` that ran `ms` before it ended. */
const genEnd = (session, ms) => ({ kind: "gen.end", t: 0, model: "qwen3:8b", hint: { session }, timings: { prompt_ms: ms / 2, eval_ms: ms / 2 } });
/** A stretch opened at `t0` whose writes are kept, last one per session and stretch. */
function watched(t0 = 1_000_000) {
    const writes = [];
    const s = new EnergyStretch(t0, (session, id, rec) => writes.push({ session, id, rec }));
    return { s, writes, last: (session) => writes.filter((w) => w.session === session).at(-1)?.rec };
}
/** Samples every second from `from` to `to` (ms) at `w` watts. */
function samples(s, from, to, w) { for (let t = from; t <= to; t += 1000) s.frame(sample(w), t); }

// --- what a stretch writes, and when ---

test("energy share: each of our generations' ends writes the session's share so far, open", () => {
    const { s, writes, last } = watched(1_000_000);
    s.requestStarted(OURS);
    s.setPrice(OURS, { perKwh: 0.36, currency: "EUR" });
    samples(s, 1_000_000, 1_010_000, 200);
    assert.equal(s.frame(genEnd(OURS, 10_000), 1_010_000), true);
    assert.equal(writes.length, 1);
    const r = last(OURS);
    assert.equal(r.open, true);
    assert.equal(r.cut, false);
    assert.equal(r.basis, "gpu");
    assert.ok(Math.abs(r.J - 2000) < 1e-6, `10 s at 200 W is 2000 J, got ${r.J}`);
    assert.ok(Math.abs(r.cost - (2000 / 3.6e6) * 0.36) < 1e-12);
    assert.equal(r.currency, "EUR");
});

test("energy share: another client's generation takes its share and is never written", () => {
    const { s, writes, last } = watched(1_000_000);
    s.requestStarted(OURS);
    samples(s, 1_000_000, 1_010_000, 200);
    assert.equal(s.frame(genEnd(THEIRS, 10_000), 1_010_000), false);
    s.frame(genEnd(OURS, 10_000), 1_010_000);
    assert.deepEqual(writes.map((w) => w.session), [OURS]);
    assert.ok(Math.abs(last(OURS).J - 1000) < 1e-6, "two generations over the same 10 s split the 2000 J");
});

test("energy share: our generation that ended before the stretch opened is an earlier stretch's, not counted again", () => {
    const { s, writes } = watched(1_000_000);
    s.requestStarted(OURS);
    samples(s, 900_000, 1_000_000, 200);
    assert.equal(s.frame(genEnd(OURS, 10_000), 990_000), false, "a backfilled gen.end of ours is not this stretch's");
    assert.equal(writes.length, 0);
});

test("energy share: a runtime whose first sample carries no power is not watched, and nothing is written", () => {
    const { s, writes } = watched(1_000_000);
    s.requestStarted(OURS);
    s.frame({ kind: "sample", t: 0, info: { compute: { supported_gpus: [{ gpu_id: "0" }], power_sources: [] } } }, 1_000_000);
    assert.equal(s.powered, false);
    s.frame(sample(200), 1_001_000);
    s.frame(genEnd(OURS, 1000), 1_002_000);
    assert.equal(writes.length, 0);
});

test("hasPower: a GPU's board power or any power source counts; a frame without either does not", () => {
    assert.equal(hasPower(sample(1)), true);
    assert.equal(hasPower({ kind: "sample", info: { compute: { supported_gpus: [], power_sources: [{ provider: "rapl", scope: "cpu", energy_mj: 1 }] } } }), true);
    assert.equal(hasPower({ kind: "sample", info: { compute: { supported_gpus: [{ gpu_id: "0", power: {} }] } } }), false);
    assert.equal(hasPower({ kind: "sample" }), false);
});

// --- when a stretch closes ---

test("energy share: the stretch may close TAIL_MS + REST_MS after its last generation, never while a request is out", () => {
    const { s } = watched(1_000_000);
    s.requestStarted(OURS);
    assert.equal(s.closesAt(), null, "a request is out");
    samples(s, 1_000_000, 1_010_000, 200);
    s.frame(genEnd(OURS, 10_000), 1_010_000);
    assert.equal(s.closesAt(), null, "its gen.end came, but the call has not returned");
    s.requestEnded(OURS, 1_010_500);
    assert.equal(s.closesAt(), 1_010_500 + TAIL_MS + REST_MS);
    s.requestStarted(OURS);
    assert.equal(s.closesAt(), null, "the next request holds it open again");
});

test("energy share: the close writes the stretch complete, with the tail counted", () => {
    const { s, last } = watched(1_000_000);
    s.requestStarted(OURS);
    samples(s, 940_000, 1_000_000, 50);                  // the box at rest before the stretch
    samples(s, 1_001_000, 1_010_000, 250);
    s.frame(genEnd(OURS, 10_000), 1_010_000);
    const mid = last(OURS);
    samples(s, 1_011_000, 1_020_000, 150);               // clocking down after it
    samples(s, 1_021_000, 1_080_000, 50);
    s.requestEnded(OURS, 1_010_000);
    s.record(false);
    const done = last(OURS);
    assert.equal(done.open, false);
    assert.equal(done.cut, false);
    assert.ok(done.J > mid.J, `the tail adds to it: ${done.J} > ${mid.J}`);
    assert.ok(done.aboveJ != null && done.aboveJ > 0);
});

// --- a worker that dies inside a stretch ---

test("energy share: frames that end mid-stretch leave a cut record, drawn as cut, never as complete", () => {
    const { s, writes } = watched(1_000_000);
    s.requestStarted(OURS);
    samples(s, 1_000_000, 1_010_000, 200);
    s.frame(genEnd(OURS, 10_000), 1_010_000);
    samples(s, 1_011_000, 1_015_000, 150);               // the worker dies here: no close is ever written
    const stored = Object.fromEntries(writes.map((w) => [w.id, w.rec]));
    assert.equal(Object.values(stored)[0].open, true, "what the dead worker left is still open");
    const after = cutOpen(stored);
    const r = after[s.id];
    assert.equal(r.cut, true);
    assert.equal(r.open, false);
    assert.ok(Math.abs(r.J - 2000) < 1e-6, "the figure written before the cut is kept");
    for (const rec of Object.values(after)) assert.ok(rec.cut || !rec.open, "no record reads as complete or still watched after a restart unless it was closed");
});

test("cutOpen: a session whose stretches all closed is left alone", () => {
    assert.equal(cutOpen({ a: { J: 1, aboveJ: null, basis: "gpu", ms: 1, cost: null, currency: null, open: false, cut: false } }), null);
});
