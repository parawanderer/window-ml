"use strict";
// What each model COST, and the machine's timeline of what happened — both derived from what sessions already
// recorded, so the panel's second half needs no new collection.
import { test } from "node:test";
import assert from "node:assert";
const M = await import("../sidebar/model-stats.ts");

const usage = (p, c, extra = {}) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c, ...extra });

test("usageByModel: attributed to the model that RAN, sub-calls included", () => {
    const by = M.usageByModel([
        {
            hash: "aaa", model: "qwen3.8:27b",
            turns: [
                { ts: 1000, usage: usage(100, 50, { evalMs: 1000 }) },                       // no model → the session's
                { ts: 2000, model: "gemma4:12b", usage: usage(10, 20, { evalMs: 500 }) },    // resolved elsewhere
            ],
            steps: [
                { seq: 1, ts: 3000, usage: usage(200, 80, { evalMs: 2000 }) },
                // A delegated vision sub-call: a DIFFERENT model, and charging it to the driver is how a
                // reader's cost disappears from the ledger.
                { seq: 2, ts: 4000, subUsage: { byModel: [{ model: "minicpm-v", prompt: 700, completion: 30, calls: 3 }] } },
            ],
        },
    ]);
    assert.deepEqual(Object.keys(by).sort(), ["gemma4:12b", "minicpm-v", "qwen3.8:27b"]);
    assert.equal(by["qwen3.8:27b"].inTokens, 300, "the turn with no model of its own belongs to the session's");
    assert.equal(by["qwen3.8:27b"].outTokens, 130);
    assert.equal(by["gemma4:12b"].inTokens, 10, "a turn that names its own model is charged to that one");
    // 130 tokens over 3s of eval time.
    assert.ok(Math.abs(by["qwen3.8:27b"].tokPerSec - 130 / 3) < 0.01);
    assert.equal(by["qwen3.8:27b"].genBasis, "eval", "…and says the rate came from Ollama's own timings");
    // Sub-calls arrive already summed: exact tokens, and the CALL count preserved rather than reported as one.
    assert.equal(by["minicpm-v"].inTokens, 700);
    assert.equal(by["minicpm-v"].calls, 3);
    assert.equal(by["minicpm-v"].tokPerSec, null, "no timing was reported, so no rate is invented");
    assert.equal(by["minicpm-v"].genBasis, null);
});

test("usageByModel: nothing to report is an empty ledger, not zeroes", () => {
    assert.deepEqual(M.usageByModel([]), {});
    assert.deepEqual(M.usageByModel([{ hash: "a", model: "m", turns: [{ ts: 1, usage: null }] }]), {},
        "a turn whose server reported no counts contributes nothing — never a fabricated 0");
});

test("eventsFrom: a generation is a span backwards from when it finished", () => {
    const [ev] = M.eventsFrom([{ hash: "abc", model: "qwen3.8:27b", turns: [{ ts: 10_000, usage: usage(100, 50, { genMs: 4000 }) }] }]);
    assert.equal(ev.kind, "gen");
    assert.equal(ev.until, 10_000, "the timestamp we have is when it FINISHED");
    assert.equal(ev.t, 6000, "…so the span runs back over where the time actually went");
    assert.equal(ev.cost.outTokens, 50);
    assert.equal(ev.cost.genBasis, "wall", "no eval timing → the rate includes network, and says so");
    assert.deepEqual(ev.ref, { hash: "abc" }, "clickable back to the session that caused it");
});

test("eventsFrom: a real model load is its own span; resident bookkeeping is not", () => {
    const evs = M.eventsFrom([{
        hash: "abc", model: "gemma4:31b",
        steps: [
            // 30s of a 34s call spent loading the model off disk.
            { seq: 4, ts: 100_000, usage: usage(10, 100, { genMs: 34_000, loadMs: 30_000 }) },
            // The next call: the model is resident, so Ollama still reports a load_duration — a few ms of it.
            { seq: 5, ts: 140_000, usage: usage(10, 100, { genMs: 4000, loadMs: 12 }) },
        ],
    }]);
    const loads = evs.filter((e) => e.kind === "load");
    assert.equal(loads.length, 1, "only the load that actually happened is drawn");
    assert.equal(loads[0].until - loads[0].t, 30_000);
    assert.equal(loads[0].t, 66_000, "it sits at the START of the call, before a token was generated");
    assert.match(loads[0].label, /loading gemma4:31b/);
    assert.deepEqual(loads[0].ref, { hash: "abc", seq: 4 }, "…and points at the step that provoked it");
    // The threshold is a floor on what counts as a load, not a guess about what a load costs.
    assert.ok(M.LOAD_EVENT_MIN_MS >= 1000);
});

test("eventsFrom: a run spans its steps, and events are ordered by time", () => {
    const evs = M.eventsFrom([{
        hash: "run1", model: "m",
        steps: [{ seq: 1, ts: 5000 }, { seq: 2, ts: 9000 }, { seq: 3, ts: 20_000 }],
    }]);
    const run = evs.find((e) => e.kind === "run");
    assert.equal(run.t, 5000);
    assert.equal(run.until, 20_000);
    assert.deepEqual(run.ref, { hash: "run1" });
    for (let i = 1; i < evs.length; i++) assert.ok(evs[i].t >= evs[i - 1].t, "sorted by when they started");
});

test("eventsFrom: events from DIFFERENT sessions share one timeline", () => {
    const evs = M.eventsFrom([
        { hash: "one", model: "a", turns: [{ ts: 3000, usage: usage(1, 1, { genMs: 500 }) }] },
        { hash: "two", model: "b", turns: [{ ts: 1000, usage: usage(1, 1, { genMs: 500 }) }] },
    ]);
    // A model load belongs to the BOX, not to whichever chat provoked it — so the lane is not per-session, and
    // the ref is what gets you back to the one that did.
    assert.deepEqual(evs.map((e) => e.ref.hash), ["two", "one"]);
});
