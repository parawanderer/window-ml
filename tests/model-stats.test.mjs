"use strict";
// What each model COST, and the machine's timeline of what happened — both derived from what sessions already
// recorded, so the panel's second half needs no new collection.
import { test } from "node:test";
import assert from "node:assert";
const M = await import("../src/sidebar/model-stats.ts");

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

test("eventsFrom: a run starts when it STARTED, so it contains its own first call", () => {
    const evs = M.eventsFrom([{
        hash: "r", model: "gemma4:31b", createdTs: 1000, lastTs: 40_000,
        // One step, finishing at 30s: 20s of it was waiting for the model to load.
        steps: [{ seq: 1, ts: 30_000, tool: "exec", toolMs: 500,
                  usage: usage(10, 10, { genMs: 2000, loadMs: 20_000 }) }],
    }]);
    const run = evs.find((e) => e.kind === "run");
    const load = evs.find((e) => e.kind === "load");
    // A step's timestamp is when it FINISHED. Measured from steps alone the run would begin at 30s — after
    // its own first model call, with the load it waited through sitting outside it.
    assert.equal(run.t, 1000, "the run begins when the agent started");
    assert.equal(run.until, 40_000);
    assert.ok(load.t >= run.t && (load.until ?? 0) <= run.until, "…so the load it caused is INSIDE it");
});

test("eventsFrom: both timings ride along, so the network cost is recoverable", () => {
    const [ev] = M.eventsFrom([{
        hash: "n", model: "m",
        // Ollama says it generated for 3.0s; we measured 3.6s around the fetch. The 600ms difference is the
        // network and the queue — a different diagnosis from a slow model, and not recoverable from the rate.
        turns: [{ ts: 10_000, usage: usage(100, 90, { genMs: 3600, evalMs: 3000 }) }],
    }]);
    assert.equal(ev.cost.evalMs, 3000, "the model's own generation time");
    assert.equal(ev.cost.wallMs, 3600, "…and the time we waited for it");
    assert.equal(ev.cost.genBasis, "eval", "the rate divides by the generation time");
    assert.ok(Math.abs(ev.cost.tokPerSec - 30) < 0.01);

    // A cloud route reports no eval_duration, so there is nothing to subtract — and the tooltip must not
    // invent an overhead from a single number.
    const [cloud] = M.eventsFrom([{ hash: "c", model: "m", turns: [{ ts: 10_000, usage: usage(100, 90, { genMs: 3600 }) }] }]);
    assert.equal(cloud.cost.evalMs, undefined);
    assert.equal(cloud.cost.genBasis, "wall");
});

/* --------------------------- the generation phase split --------------------------- */
// What the model was DOING across a call — thinking, emitting the tool call, answering. Observable only on a
// streamed call, where the service worker marks which channel each chunk arrived on.

const kinds = (phases) => phases.map(p => p.kind);
const durs = (from, phases) => phases.map((p, i) => p.until - (i ? phases[i - 1].until : from));

test("genPhases: marks become contiguous phases, and the pre-first-token gap is the model's too", () => {
    // 300ms of prompt eval + network before the first chunk, then thinking, then the answer.
    const p = M.genPhases(1000, 5000, [{ kind: "think", atMs: 300 }, { kind: "answer", atMs: 2000 }]);
    assert.deepEqual(kinds(p), ["model", "think", "answer"]);
    assert.deepEqual(durs(1000, p), [300, 1700, 3000]);
    assert.equal(p.at(-1).until, 6000, "the phases end where the call did");
});

test("genPhases: an INTERLEAVED turn keeps its order — think, call, think, answer", () => {
    // The case that decides the data structure. A model that resumes reasoning after emitting tool-call
    // fragments produces four phases; bucketing by kind would collapse it to three and draw a block that
    // never happened.
    const p = M.genPhases(0, 1000, [
        { kind: "think", atMs: 0 }, { kind: "call", atMs: 200 },
        { kind: "think", atMs: 400 }, { kind: "answer", atMs: 700 },
    ]);
    assert.deepEqual(kinds(p), ["think", "call", "think", "answer"]);
    assert.deepEqual(durs(0, p), [200, 200, 300, 300]);
});

test("genPhases: no marks (a NON-streamed call) stays one undifferentiated block", () => {
    // We know the composition of the text but not when the boundary fell; splitting it by length would be
    // inventing a timestamp.
    assert.deepEqual(M.genPhases(0, 4000, undefined), [{ kind: "model", until: 4000 }]);
    assert.deepEqual(M.genPhases(0, 4000, []), [{ kind: "model", until: 4000 }]);
});

test("genPhases: a mark past the end of the call contributes nothing, never a backwards phase", () => {
    const p = M.genPhases(0, 1000, [{ kind: "think", atMs: 0 }, { kind: "answer", atMs: 1400 }]);
    assert.deepEqual(kinds(p), ["think"]);
    assert.ok(p.every(x => x.until <= 1000));
});

test("a streamed tool step's model phase is SPLIT, inside the same one block", () => {
    const [ev] = M.eventsFrom([{
        hash: "h", model: "m", createdTs: 0, lastTs: 20_000,
        steps: [{ seq: 1, ts: 10_000, tool: "exec", toolMs: 1000,
                  usage: usage(10, 5, { genMs: 3000, genPhases: [{ kind: "think", atMs: 0 }, { kind: "call", atMs: 2000 }] }) }],
    }]).filter(e => e.kind === "tool");

    assert.deepEqual(kinds(ev.phases), ["think", "call", "tool"],
        "still ONE event — you read the model's channels against the tool run in the same block");
    assert.equal(ev.until, 10_000);
});

/* --------------------------- work still in flight --------------------------- */
// Derived from finish stamps, none of this exists until it is over — and then it appears back-dated across
// memory the chart already drew. `now` is what makes the same spans visible while they are happening.

const liveRun = (over = {}) => ({
    hash: "h", model: "gemma4:31b", createdTs: 1000, lastTs: 5000, steps: [], ...over,
});

test("in flight: nothing is drawn WITHOUT a `now` — that is what an export gets", () => {
    const s = liveRun({ liveTurn: { step: 1, startedTs: 2000 }, steps: [{ seq: 1, ts: 3000, tool: "exec", pending: true }] });
    assert.ok(M.eventsFrom([s]).every(e => !e.open), "a document must not carry a span whose end is 'when the file was written'");
});

test("in flight: a generation underway is an OPEN span from when the call went out", () => {
    const [gen] = M.eventsFrom([liveRun({ liveTurn: { step: 1, startedTs: 2000 } })], 9000).filter(e => e.kind === "gen");
    assert.equal(gen.t, 2000);
    assert.equal(gen.until, 9000, "it reaches the moment being drawn, not an end it does not have");
    assert.equal(gen.open, true);
    assert.match(gen.label, /generating/);
});

test("in flight: a live generation gains its DIVIDERS as it crosses phases", () => {
    const [gen] = M.eventsFrom([liveRun({
        liveTurn: { step: 1, startedTs: 2000, phases: [{ kind: "think", atMs: 100 }, { kind: "call", atMs: 3000 }] },
    })], 9000).filter(e => e.kind === "gen");
    assert.deepEqual(kinds(gen.phases), ["model", "think", "call"]);
});

test("in flight: a pending step is built FORWARDS — its stamp is a START, not a finish", () => {
    const [tool] = M.eventsFrom([liveRun({ steps: [{ seq: 2, ts: 4000, tool: "exec", pending: true }] })], 9000)
        .filter(e => e.kind === "tool");
    assert.equal(tool.t, 4000, "a finished step's ts is when it ENDED; a pending one's is when it began");
    assert.equal(tool.until, 9000);
    assert.deepEqual(kinds(tool.phases), ["tool"]);
    assert.equal(tool.ref.seq, 2, "and it still links back to the step");
});

test("in flight: a step at an approval GATE is a wait, not work", () => {
    const [gate] = M.eventsFrom([liveRun({
        steps: [{ seq: 2, ts: 4000, tool: "python_exec", pending: true, awaitingApproval: true }],
    })], 60_000).filter(e => e.kind === "tool");
    assert.deepEqual(kinds(gate.phases), ["wait"], "a human deciding is the step's wall clock but not the machine's");
    assert.match(gate.label, /awaiting approval/);
});

test("in flight: the run CONTAINER grows to now, so an open span never sticks out of it", () => {
    const evts = M.eventsFrom([liveRun({ liveTurn: { step: 1, startedTs: 2000 } })], 9000);
    const run = evts.find(e => e.kind === "run");
    assert.equal(run.until, 9000);
    assert.equal(run.open, true);
    for (const e of evts) assert.ok(e.until <= run.until, `${e.kind} escapes its run`);
});

test("in flight: a FINISHED run is not open, even when a `now` is given", () => {
    const s = liveRun({ steps: [{ seq: 1, ts: 3000, tool: "exec", toolMs: 200 }] });
    const evts = M.eventsFrom([s], 99_000);
    assert.ok(evts.every(e => !e.open), "nothing is in flight — the run just happens to be in the past");
    assert.equal(evts.find(e => e.kind === "run").until, 5000, "and it ends where it ended, not at now");
});

/* --------------------------- the turn's usage lives on another record --------------------------- */
// The loop emits a turn as TWO records: the model's prose and usage (no `seq`), then the tool call it decided
// on (with one). So the model's half of a composite block has to be found ACROSS records. Reading `usage` off
// the tool record alone finds nothing — and that is exactly what shipped, invisibly, because the demo put both
// on one record and therefore drew a shape the product never emits.

const turn = (step, ts, u) => ({ step, seq: step * 10, ts, thought: "hm", usage: u });
const toolStep = (step, seq, ts, over = {}) => ({ step, seq, ts, tool: "exec", toolMs: 500, ...over });

test("a tool block takes its MODEL phase from the turn's own record, not the tool's", () => {
    const evts = M.eventsFrom([{
        hash: "h", model: "m", createdTs: 0, lastTs: 20_000,
        steps: [turn(1, 5000, usage(100, 20, { genMs: 900 })), toolStep(1, 2, 8000)],
    }]);
    const tool = evts.find(e => e.kind === "tool");
    assert.deepEqual(kinds(tool.phases), ["model", "tool"]);
    assert.equal(tool.until - tool.t, 1400, "the generation plus the tool run");
    assert.equal(tool.cost.inTokens, 100, "and the turn's cost belongs to the block it paid for");
});

test("…and the generation is not ALSO drawn on its own — that would report the same seconds twice", () => {
    const evts = M.eventsFrom([{
        hash: "h", model: "m", createdTs: 0, lastTs: 20_000,
        steps: [turn(1, 5000, usage(100, 20, { genMs: 900 })), toolStep(1, 2, 8000)],
    }]);
    assert.equal(evts.filter(e => e.kind === "gen").length, 0);
});

test("a turn with SEVERAL tool calls keeps its generation separate — one call cannot own it", () => {
    // Parallel calls share one generation, so folding it into each would draw those seconds two or three
    // times. The honest shape for work that fans out is a generation span with the calls after it.
    const evts = M.eventsFrom([{
        hash: "h", model: "m", createdTs: 0, lastTs: 20_000,
        steps: [turn(1, 5000, usage(100, 20, { genMs: 900 })), toolStep(1, 2, 8000), toolStep(1, 3, 9000)],
    }]);
    assert.equal(evts.filter(e => e.kind === "gen").length, 1, "drawn once, on its own");
    for (const t of evts.filter(e => e.kind === "tool")) {
        assert.deepEqual(kinds(t.phases), ["tool"], "…and not charged to either call");
    }
});

test("a turn that answers WITHOUT calling anything still gets its generation span", () => {
    const evts = M.eventsFrom([{
        hash: "h", model: "m", createdTs: 0, lastTs: 20_000,
        steps: [turn(2, 12_000, usage(120, 9, { genMs: 700 }))],
    }]);
    const gen = evts.find(e => e.kind === "gen");
    assert.equal(gen.t, 11_300);
    assert.equal(gen.until, 12_000);
});

test("a LOAD the turn waited through is drawn in front of the tool block it delayed", () => {
    const evts = M.eventsFrom([{
        hash: "h", model: "m", createdTs: 0, lastTs: 30_000,
        steps: [turn(1, 5000, usage(100, 20, { genMs: 900, loadMs: 6000 })), toolStep(1, 2, 8000)],
    }]);
    const load = evts.find(e => e.kind === "load");
    const tool = evts.find(e => e.kind === "tool");
    assert.equal(load.until, tool.t, "the model arrived, then the turn could start");
    assert.equal(load.until - load.t, 6000);
});

test("prompt eval is reported apart from the network — one number cannot be attributed", () => {
    // wall 4200 = prompt eval 900 + generation 3000 + 300 of queue/network. Reported as a single
    // wall-minus-generation remainder it charges the box 1200ms, 900 of which the MODEL spent reading the
    // conversation — and a gap between two models then cannot be attributed to either.
    const [ev] = M.eventsFrom([{ hash: "h", model: "m",
        turns: [{ ts: 10_000, usage: usage(1840, 90, { genMs: 4200, evalMs: 3000, promptEvalMs: 900 }) }] }]);
    assert.equal(ev.cost.promptEvalMs, 900);
    assert.equal(ev.cost.evalMs, 3000);
    assert.equal(ev.cost.wallMs, 4200);
});

test("…and it is simply absent where the route does not report it, never a zero", () => {
    const [ev] = M.eventsFrom([{ hash: "h", model: "m",
        turns: [{ ts: 10_000, usage: usage(100, 90, { genMs: 3600 }) }] }]);
    assert.equal(ev.cost.promptEvalMs, undefined, "a cloud route reports no prompt timing to split out");
});
