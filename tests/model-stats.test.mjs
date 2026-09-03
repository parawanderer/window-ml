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

test("eventsFrom: a tool step is ONE block, phased by who was working", () => {
    const evs = M.eventsFrom([{
        hash: "run9", model: "qwen3.8:27b",
        steps: [{
            seq: 7, ts: 50_000, tool: "python_exec", toolMs: 3000,
            usage: usage(900, 60, { genMs: 2000 }),
        }],
    }]);
    const tool = evs.find((e) => e.kind === "tool");
    assert.ok(tool, "a tool step produces a composite span");
    assert.equal(tool.t, 45_000, "it begins when the model started generating the call");
    assert.deepEqual(tool.phases, [{ kind: "model", until: 47_000 }, { kind: "tool", until: 50_000 }],
        "two phases when nothing was gated: the model, then the tool");
    assert.equal(tool.until, 50_000, "…and ends when the tool finished");
    assert.equal(tool.tool, "python_exec");
    assert.equal(tool.model, "qwen3.8:27b", "both halves are named: the model, then the tool");
    assert.equal(tool.cost.outTokens, 60, "the model half carries what it spent");
    assert.deepEqual(tool.ref, { hash: "run9", seq: 7 }, "clicking it goes to that step");
    // It is ONE event, not a generation plus a tool — you reason about the halves together.
    assert.equal(evs.filter((e) => e.kind === "gen").length, 0);
});

test("eventsFrom: a load before a tool call stays its OWN span", () => {
    const evs = M.eventsFrom([{
        hash: "r", model: "gemma4:31b",
        steps: [{ seq: 1, ts: 100_000, tool: "exec", toolMs: 1000, usage: usage(10, 10, { genMs: 2000, loadMs: 20_000 }) }],
    }]);
    const tool = evs.find((e) => e.kind === "tool");
    const load = evs.find((e) => e.kind === "load");
    assert.equal(tool.t, 97_000);
    // The load happened BEFORE a token was generated. Burying it inside the block would hide the one thing
    // that explains the slow turn.
    assert.equal(load.until, tool.t, "it ends exactly where the generation begins");
    assert.equal(load.t, 77_000);
    assert.deepEqual(load.ref, { hash: "r", seq: 1 });
});

test("eventsFrom: a step with no tool execution is not a composite", () => {
    // A denial, a doomed-action skip, or a thought-only step: nothing ran, so there is no second half.
    const evs = M.eventsFrom([{
        hash: "r", model: "m",
        steps: [{ seq: 1, ts: 10_000, tool: "click", usage: usage(5, 5, { genMs: 800 }) }],
    }]);
    assert.equal(evs.filter((e) => e.kind === "tool").length, 0);
    assert.equal(evs.find((e) => e.kind === "gen").until, 10_000, "just the generation it did do");
});

test("eventsFrom: an approval gate is its OWN phase — the human's time, not the machine's", () => {
    const evs = M.eventsFrom([{
        hash: "gated", model: "qwen3.8:27b",
        steps: [{
            // 2s generating, 47s waiting for a click, 1s actually running.
            seq: 3, ts: 100_000, tool: "python_exec", toolMs: 1000, approveMs: 47_000,
            usage: usage(500, 40, { genMs: 2000 }),
        }],
    }]);
    const tool = evs.find((e) => e.kind === "tool");
    assert.equal(tool.t, 50_000, "the block covers all three, so its width is the step's real wall time");
    assert.deepEqual(tool.phases, [
        { kind: "model", until: 52_000 },
        { kind: "wait", until: 99_000 },
        { kind: "tool", until: 100_000 },
    ], "…and the wait is a phase of its own, so a step that sat at a gate can't read as work");
    // The dominant phase here is a person deciding — which is exactly the thing that was invisible before.
    const widest = tool.phases.reduce((a, b, i, arr) => {
        const dur = (x, j) => x.until - (j ? arr[j - 1].until : tool.t);
        return dur(b, i) > dur(a.p, a.i) ? { p: b, i } : a;
    }, { p: tool.phases[0], i: 0 });
    assert.equal(widest.p.kind, "wait");
});

test("eventsFrom: a delegated sub-call is its own span, parented to the step that spawned it", () => {
    const evs = M.eventsFrom([{
        hash: "r", model: "qwen3.8:27b",
        steps: [{
            seq: 2, ts: 20_000, tool: "look", toolMs: 3000,
            usage: usage(100, 20, { genMs: 1000 }),
            // The reader ran INSIDE the tool's own window — that nesting is the point.
            subUsage: {
                byModel: [{ model: "minicpm-v", prompt: 700, completion: 30, calls: 1 }],
                calls_: [{ model: "minicpm-v", ts: 19_000, ms: 1800, prompt: 700, completion: 30 }],
            },
        }],
    }]);
    const step = evs.find((e) => e.kind === "tool");
    const sub = evs.find((e) => e.kind === "embed");
    assert.ok(sub, "the sub-call is drawn, not just tallied");
    assert.equal(sub.model, "minicpm-v", "a DIFFERENT model doing different work");
    assert.equal(sub.t, 17_200, "a span, back over its own generation");
    assert.equal(sub.until, 19_000);
    assert.equal(sub.parent, step.id, "…owned by the step that spawned it");
    assert.equal(step.parent, "run:r", "…which is owned by the run");
    assert.equal(sub.cost.inTokens, 700, "and it carries its own cost, not the driver's");
    assert.deepEqual(sub.ref, { hash: "r", seq: 2 }, "clicking it opens the step it belongs to");
});
