// metrics.mjs — derive a run's measurements from the artifacts it already produced.
//
// EVERY metric here reads the extension's own `__mlDebug` event stream (and the Session rebuilt from
// it). Nothing in this file asks the product to emit anything new — that is the rule that keeps the
// bench out of the core (docs/POINTER-IDENTIFIERS.md §6, rule 1). If a metric cannot be computed from
// the stream, that is a signal the stream is missing something the PRODUCT should have anyway; fix it
// there, not here.
//
// Everything is PURE — `{ events, session, result } → numbers` — so the extractors are unit-tested in
// the fast suite (tests/bench-metrics.test.mjs) rather than only through a real browser. That matters
// more than usual: a benchmark whose extractors are wrong measures its own bug, confidently.
//
// This is also the ONE module that knows the shape of a run. When the versioned JSON export lands as a
// third sink, re-pointing the bench at it is an edit to this file and nothing else.

/**
 * Drop everything the SEED turn produced, so a seeded run is scored on the measured turn alone.
 *
 * A seeded run's turn 1 is scripted — its steps are the experiment's setup, not the model's behaviour, and
 * counting them would credit the fake-LLM's re-emissions to the model under test. Events without a seq
 * (the lifecycle ones) are kept: the terminal agent-result is the measured turn's, being the last.
 */
export function afterSeed(events, boundaryStep = -1) {
    if (!(boundaryStep >= 0)) return events;
    // Bounded by `step`, not `seq`: a turn's THOUGHT record carries no seq in the raw stream, so a
    // seq-based cut left every seeded thought behind. `step` is on every step record and keeps counting
    // across turns, which is exactly the axis a turn boundary lives on.
    //
    // The seed's own agent-result has no step either, and dropping it matters more than it looks: that
    // answer is where a seeded re-emission actually lives, so leaving it would charge the script's
    // behaviour to the model.
    let seenSeedResult = false;
    return events.filter((e) => {
        if (e.kind === "agent-result" && !seenSeedResult) { seenSeedResult = true; return false; }
        if (e.kind === "agent-step") return (e.step ?? 0) > boundaryStep;
        return true;
    });
}

/** Collapse whitespace so a reflowed copy of the same text still compares equal. */
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * The steps of the (single) agent session, in the order they happened, with each tool call's repeated
 * emissions collapsed into one record.
 *
 * Two different things share a `seq`, and conflating them is the trap here. A tool call emits TWICE — a
 * pending START with its args, then a DONE with the result — and those must merge. But a turn's THOUGHT
 * record carries NO seq at all in the raw stream (agent-loop.ts emits `{ step, usage, reasoning }`), and
 * it is a separate event that must not be folded into the tool call that followed it. Sorting seq-less
 * records as seq 0 put every thought before every tool step, so a thought that repeated an earlier tool's
 * output was compared against a later position and never counted as a re-emission.
 *
 * So: `step` is the real ordering axis (it counts turns and keeps counting across a multi-turn session),
 * the thought sorts first within its turn because that is when the model wrote it, and each record gets a
 * total-order `order` ordinal that the rest of this file compares on instead of `seq`.
 */
export function stepsOf(events) {
    const bySeq = new Map();
    const out = [];
    for (const ev of events) {
        if (ev.kind !== "agent-step") continue;
        if (ev.seq == null) { out.push({ ...ev, _hasSeq: false }); continue; }
        const prev = bySeq.get(ev.seq);
        if (prev) {
            // Later event wins field by field, so the DONE's result lands on top of the START's args.
            Object.assign(prev, Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)));
            continue;
        }
        const rec = { ...ev, _hasSeq: true };
        bySeq.set(ev.seq, rec);
        out.push(rec);
    }
    return out
        .filter((s) => !s.pending || s.result != null || s.tool)
        .sort((a, b) => (a.step ?? 0) - (b.step ?? 0)
            || (a._hasSeq ? 1 : 0) - (b._hasSeq ? 1 : 0)   // the turn's thought precedes its tool calls
            || (a.seq ?? 0) - (b.seq ?? 0))
        .map((s, i) => ({ ...s, order: i }));
}

/** The final agent-result event (the LAST turn's, when a follow-up ran). */
export function resultOf(events) {
    return [...events].reverse().find((e) => e.kind === "agent-result") || null;
}

/**
 * Every turn's answer, in order — because a task with a `followup` has more than one, and they answer
 * DIFFERENT questions.
 *
 * This was a real mis-scoring, not a refinement. `cite-or-retype` asks which region wins and then asks to
 * see the rows; the predicate was handed the LAST summary, which answers the second question, so a run
 * that said "East" and was entirely correct scored WRONG — in both arms, on every repeat. It reads as a
 * task the model cannot do, which is the most expensive kind of bench bug because the output looks like a
 * finding.
 */
export function answersOf(events) {
    return events.filter((e) => e.kind === "agent-result").map((e) => e.summary ?? "");
}

/**
 * Every string the model actually WROTE inside a value, flattened out of the argument object.
 *
 * Not JSON.stringify: that escapes the content it is supposed to expose. A retyped table's newlines become
 * a literal `\n`, and a quoted label `@tool:"the table"` becomes `@tool:\"the table\"` — so a scanner
 * looking for either finds nothing, and the run scores a clean zero for a re-emission that plainly
 * happened. The JSON punctuation was never authored content anyway; the values are.
 */
export function flatStrings(v, out = []) {
    if (v == null) return out;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
    else if (Array.isArray(v)) for (const x of v) flatStrings(x, out);
    else if (typeof v === "object") for (const x of Object.values(v)) flatStrings(x, out);
    return out;
}

/**
 * Text the MODEL authored, in step order: its thoughts, the arguments it passed to each tool, and its
 * final answer. Deliberately excludes tool RESULTS — those are what the model read, not what it wrote,
 * and counting them as authorship would make every run look like it re-emitted everything.
 */
export function authoredTexts(events) {
    const out = [];
    for (const s of stepsOf(events)) {
        if (s.thought) out.push({ order: s.order, kind: "thought", text: String(s.thought) });
        const args = flatStrings(s.arguments).join("\n");
        if (args) out.push({ order: s.order, kind: "args", text: args });
    }
    // EVERY turn's answer, not just the last one. A multi-turn session — a follow-up, or a seeded history —
    // has the model writing a final answer per turn, and reading only the terminal one makes an earlier
    // turn's re-emission invisible. Each answer is placed just after its own turn's last step (the .5), so
    // it stays ordered before the next turn's steps without colliding with an integer seq.
    const steps = stepsOf(events);
    const lastOrderOfStep = new Map();   // the turn's LAST record: an answer follows its tool calls, not its thought
    for (const st of steps) lastOrderOfStep.set(st.step ?? 0, st.order);
    let lastStep = 0;
    for (const ev of events) {
        if (ev.kind === "agent-step" && ev.step != null) lastStep = Math.max(lastStep, ev.step);
        if (ev.kind !== "agent-result") continue;
        // Placed just after its own turn's last step (the .5), so it stays ordered before the next turn's
        // steps without colliding with an integer ordinal.
        const at = (lastOrderOfStep.get(lastStep) ?? steps.length - 1) + 0.5;
        if (ev.summary) out.push({ order: at, kind: "summary", text: String(ev.summary) });
        if (ev.answer) out.push({ order: at, kind: "answer", text: flatStrings(ev.answer).join("\n") });
    }
    return out;
}

/**
 * Tool OUTPUTS the model received, in step order. Prefers `modelResult` — the model-facing copy, which
 * is what it could have retyped — and falls back to the full result when the two are the same.
 */
export function capturedOutputs(events) {
    return stepsOf(events)
        .filter((s) => s.tool && (s.modelResult != null || s.result != null))
        .map((s) => ({ order: s.order, tool: s.tool, text: String(s.modelResult ?? s.result ?? "") }));
}

/**
 * Does `haystack` contain a verbatim run of at least `k` characters from `needleSource`?
 *
 * Shingled rather than a true longest-common-substring: hashing every k-gram of the source into a Set
 * and sliding the same window over the target is O(n+m), where LCS is O(n·m) and a 20-step run with
 * multi-kilobyte outputs makes that quadratic cost real. The metric only needs "did a long verbatim
 * chunk reappear", not its exact length, so the cheaper answer is the same answer.
 */
export function sharesRun(needleSource, haystack, k = 40) {
    const a = norm(needleSource), b = norm(haystack);
    if (a.length < k || b.length < k) return false;
    const grams = new Set();
    for (let i = 0; i + k <= a.length; i++) grams.add(a.slice(i, i + k));
    for (let i = 0; i + k <= b.length; i++) if (grams.has(b.slice(i, i + k))) return true;
    return false;
}

/**
 * RE-EMISSION — the primary metric. How often does the model retype data it already holds a pointer to,
 * instead of referencing it?
 *
 * Counted per captured output: an output is "re-emitted" if any LATER model-authored text repeats a
 * verbatim run of >= k characters from it. Strictly later, so a tool result cannot be re-emitted by the
 * very call that produced it, and only model-authored text counts (see authoredTexts).
 *
 * @returns {{ outputs: number, reEmitted: number, rate: number, instances: Array }}
 */
/**
 * The distinctive VALUES in a blob: numbers of two digits or more, and words of three characters or more.
 *
 * Case is folded and order is dropped, so this survives the transformations a verbatim scan cannot.
 *
 * A number must NOT absorb its separators. The first version matched `\d[\d.,]+`, which reads the CSV
 * row `120,150,130,160` as ONE token while the JS literal `120, 150, 130, 160` — a comma and a SPACE —
 * splits into four. The two shapes then shared almost nothing, which is precisely the comparison this
 * exists to make, and a full twelve-row retype measured 0.49 instead of ~1.
 */
export function valueTokens(text) {
    return new Set(String(text ?? "").toLowerCase().match(/[a-z_][a-z0-9_]{2,}|\d+(?:\.\d+)?/g) || []);
}

/**
 * Did the model REPRODUCE the data, in whatever shape it liked?
 *
 * `sharesRun` finds a verbatim run and tolerates reflowed whitespace, which is not enough: a model asked
 * to compute over a captured table typically RETYPES it into a literal for `exec`. A CSV row
 * `Ada,North,120,150,130,160` becomes `["Ada", "North", 120, 150, 130, 160],` — every value carried over,
 * every 40-character window destroyed by the quotes and brackets. The run in question retyped all twelve
 * rows and scored 0.00, and since neither arm of an A/B would score anything, the sweep would have
 * concluded "no difference" from an instrument measuring nothing.
 *
 * So the test is COVERAGE of the captured values rather than contiguity. It needs the output to be
 * substantial (`minTokens`) before it will judge at all, and then most of it to reappear
 * (`minCoverage`) — a summary that cites two figures out of sixty is a citation, which is the behaviour
 * we want, not a re-emission.
 */
export function sharesValues(needleSource, haystack, { minTokens = 8, minCoverage = 0.7 } = {}) {
    const want = valueTokens(needleSource);
    if (want.size < minTokens) return false;
    const have = valueTokens(haystack);
    let hit = 0;
    for (const t of want) if (have.has(t)) hit++;
    return hit / want.size >= minCoverage;
}

export function reEmission(events, k = 40) {
    const outputs = capturedOutputs(events).filter((o) => norm(o.text).length >= k);
    const authored = authoredTexts(events);
    const instances = [];
    for (const o of outputs) {
        const hit = authored.find((t) => t.order > o.order
            && (sharesRun(o.text, t.text, k) || sharesValues(o.text, t.text)));
        if (hit) {
            const verbatim = sharesRun(o.text, hit.text, k);
            instances.push({ fromOrder: o.order, tool: o.tool, atOrder: hit.order, kind: hit.kind, verbatim });
        }
    }
    return { outputs: outputs.length, reEmitted: instances.length, rate: outputs.length ? instances.length / outputs.length : 0, instances };
}

const TOKEN_RE = /@tool:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z0-9_]+)/g;

/** Every `@tool:…` reference the model WROTE, with the form it used (id / label / alias). */
export function pointerRefs(events) {
    const refs = [];
    for (const t of authoredTexts(events)) {
        for (const m of t.text.match(TOKEN_RE) || []) {
            const body = m.slice("@tool:".length);
            const form = /^["']/.test(body) ? "label" : (/^[0-9a-f]{7}$/.test(body) ? "id" : "alias");
            refs.push({ order: t.order, ref: m, form });
        }
    }
    return refs;
}

/**
 * Pointer usage and its failure modes, read off the dereference steps.
 *
 * A miss is split by CAUSE where the run makes that separable: the fault message names the bad address
 * and says whether the nearest live pointer is a character away (mistyped) or nothing like it
 * (invented). `silentWrong` is the one that matters and should be zero — a corruption that resolved to
 * a DIFFERENT live pointer produces no fault at all, so it is counted from the run's own
 * "resolved a near match" announcement rather than from an error.
 */
export function pointerUse(events) {
    const steps = stepsOf(events);
    const derefs = steps.filter((s) => s.tool === "dereference");
    const text = (s) => String(s.modelResult ?? s.result ?? "");
    const faults = derefs.filter((s) => /memory ?fault/i.test(text(s)));
    const mistyped = faults.filter((s) => /distance 1\b/i.test(text(s)));
    const nearMiss = derefs.filter((s) => !faults.includes(s) && /near match|closest match|resolved .* instead/i.test(text(s)));
    const refs = pointerRefs(events);
    return {
        derefCalls: derefs.length,
        derefFaults: faults.length,
        faultRate: derefs.length ? faults.length / derefs.length : 0,
        mistyped: mistyped.length,
        invented: faults.length - mistyped.length,
        silentWrong: nearMiss.length,
        refsWritten: refs.length,
        refsById: refs.filter((r) => r.form === "id").length,
        refsByLabel: refs.filter((r) => r.form === "label").length,
        refsByAlias: refs.filter((r) => r.form === "alias").length,
    };
}

/**
 * RECOVERY — after a fault, does the next step get it right, or does the model give up and retype?
 * Counted over faults that have any subsequent step at all; a fault on the final step is not evidence
 * either way and is excluded.
 */
export function recovery(events) {
    const steps = stepsOf(events);
    const text = (s) => String(s.modelResult ?? s.result ?? "");
    const faultIdx = steps.map((s, i) => (s.tool === "dereference" && /memory ?fault/i.test(text(s)) ? i : -1)).filter((i) => i >= 0);
    const scored = faultIdx.filter((i) => i + 1 < steps.length);
    const recovered = scored.filter((i) => {
        const next = steps[i + 1];
        return next.tool === "dereference" && !/memory ?fault/i.test(text(next));
    });
    return { faults: scored.length, recovered: recovered.length, rate: scored.length ? recovered.length / scored.length : 0 };
}

/** Token cost — the economic bottom line the pointer mechanism exists to lower. */
export function tokenCost(events) {
    let prompt = 0, completion = 0, sub = 0;
    for (const s of stepsOf(events)) {
        if (s.usage) { prompt += s.usage.promptTokens || 0; completion += s.usage.completionTokens || 0; }
        for (const u of s.subUsage || []) sub += (u.promptTokens || 0) + (u.completionTokens || 0);
    }
    return { prompt, completion, sub, total: prompt + completion + sub };
}

/**
 * Everything measurable about one run, from its artifacts alone.
 *
 * `succeeded` comes from the spec's per-task predicate — the bench cannot know what a right answer
 * looks like, so a task carries its own. A task with no predicate reports null rather than guessing,
 * and the report renders that as "not scored" instead of as a failure.
 */
/**
 * The step worth opening FIRST when a run went wrong — so the index can link into the transcript at the
 * place that broke rather than at the top of a fifty-screen document.
 *
 * Ranked by how specific the evidence is, and it reports WHY so the link can say what it is pointing at:
 *
 *  1. a pointer MemoryFault — an exact step, and the thing the pointer work exists to study;
 *  2. a tool step that came back an error — the tool named it, so this is not a guess;
 *  3. the LAST step, when the run itself errored or hit the cap — where a crash or a timeout left off.
 *
 * A WRONG-but-clean run gets nothing: every step ran fine and the answer is simply not the expected one,
 * so there is no failing step to point at and inventing one would send you to an innocent step. The
 * answer is at the end of the document, which is where the plain link already lands.
 *
 * The TOOL comes back too, because a step is rendered as two sections — its reasoning and its call — and
 * an anchor of "step 4" lands on the reasoning while the thing that failed is the call. The precise
 * anchor is `step-<n>-<tool>`, matching the heading slug the viewer emits.
 *
 * @returns {{step:number, tool:string|undefined, why:string}|null}
 */
export function focusStep(run) {
    /** A step's model-facing result, which is where a tool reports its own failure. */
    const text = (s) => String(s.modelResult ?? s.result ?? "");
    const events = afterSeed(run.events || [], run.seedBoundaryStep ?? -1);
    const steps = stepsOf(events).filter((s) => s.tool);
    if (!steps.length) return null;

    const fault = steps.find((s) => s.tool === "dereference" && /memory ?fault/i.test(text(s)));
    if (fault) return { step: fault.step, tool: fault.tool, why: "memory fault" };

    // `isError` is what the loop itself sets on a failed tool result; the text probe is the fallback for
    // a tool that reports failure in its content instead. Ordered so the structural signal wins.
    const bad = steps.find((s) => s.result?.isError || s.isError || /^\s*(error|failed)\b/i.test(text(s)));
    if (bad) return { step: bad.step, tool: bad.tool, why: "tool error" };

    const done = resultOf(events);
    const last = steps[steps.length - 1];
    if (run.error || done?.error) return { step: last.step, tool: last.tool, why: "run ended here" };
    if (done?.hitCap) return { step: last.step, tool: last.tool, why: "step cap" };
    return null;
}

export function measureRun(run, task = {}, opts = {}) {
    const { result = null, runMs = 0, error = null, approvals = [] } = run;
    const events = afterSeed(run.events || [], run.seedBoundaryStep ?? -1);
    const k = opts.k ?? 40;
    const done = resultOf(events);
    const steps = stepsOf(events).filter((s) => s.tool);
    // The answer to the TASK, which is the FIRST one when a follow-up ran. `finalAnswer` and the full
    // list are handed over too, so a spec that means to score the follow-up can still say so.
    const answers = answersOf(events);
    const answer = answers[0] ?? result?.summary ?? "";
    const finalAnswer = answers[answers.length - 1] ?? answer;
    let succeeded = null;
    if (typeof task.succeeded === "function") {
        try { succeeded = !!task.succeeded({ answer, finalAnswer, answers, events, result, steps }); }
        catch { succeeded = false; }   // a predicate that throws is a failed run, not a broken bench
    }
    return {
        seeded: (run.seedBoundaryStep ?? -1) >= 0,
        ok: !error && !done?.error,
        succeeded,
        error: error || done?.error || null,
        hitCap: !!done?.hitCap,
        cancelled: !!done?.cancelled,
        steps: steps.length,
        runMs,
        approvals: approvals.length,
        denied: approvals.filter((a) => a.decision === "denied").length,
        answer,
        finalAnswer,
        tokens: tokenCost(events),
        reEmission: reEmission(events, k),
        pointers: pointerUse(events),
        recovery: recovery(events),
        focus: focusStep(run),
    };
}

/** Mean + sample standard deviation + n, over the repeats of one cell. Nulls are skipped, not zeroed. */
export function spread(values) {
    const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (!xs.length) return { mean: null, sd: null, n: 0 };
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
    return { mean, sd, n: xs.length };
}

/** A rate over booleans, ignoring nulls (an unscored run is not a failed one). */
export function rate(values) {
    const xs = values.filter((v) => typeof v === "boolean");
    return xs.length ? { mean: xs.filter(Boolean).length / xs.length, sd: null, n: xs.length } : { mean: null, sd: null, n: 0 };
}

/**
 * The columns a report shows, in order. Each pulls one number out of a per-run measurement, so adding a
 * column is one entry here and nothing else. `agg` says how the repeats combine: a rate for booleans,
 * spread for numbers.
 */
export const COLUMNS = [
    { key: "succeeded", label: "success", agg: "rate", get: (m) => m.succeeded, digits: 2, good: "high" },
    { key: "reEmitRate", label: "re-emit", agg: "spread", get: (m) => m.reEmission.rate, digits: 2, good: "low" },
    { key: "derefCalls", label: "deref", agg: "spread", get: (m) => m.pointers.derefCalls, digits: 1, good: "high" },
    { key: "faultRate", label: "faults", agg: "spread", get: (m) => m.pointers.faultRate, digits: 2, good: "low" },
    { key: "silentWrong", label: "silent-wrong", agg: "spread", get: (m) => m.pointers.silentWrong, digits: 2, good: "low" },
    { key: "recoveryRate", label: "recovery", agg: "spread", get: (m) => m.recovery.rate, digits: 2, good: "high" },
    { key: "steps", label: "steps", agg: "spread", get: (m) => m.steps, digits: 1 },
    { key: "tokens", label: "tokens", agg: "spread", get: (m) => m.tokens.total, digits: 0, good: "low" },
    { key: "runMs", label: "secs", agg: "spread", get: (m) => m.runMs / 1000, digits: 1, good: "low" },
];

/** Aggregate the repeats of one cell into one row of the report. */
export function aggregate(measurements) {
    const row = {};
    for (const c of COLUMNS) {
        const vals = measurements.map(c.get);
        row[c.key] = c.agg === "rate" ? rate(vals) : spread(vals);
    }
    row.runs = measurements.length;
    row.errors = measurements.filter((m) => !m.ok).length;
    return row;
}
