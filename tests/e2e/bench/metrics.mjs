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
export function afterSeed(events, boundarySeq = -1) {
    if (!(boundarySeq >= 0)) return events;
    // The seed turn's own agent-result carries no seq, so dropping by seq alone would leave its ANSWER in
    // the measured turn's authored text — and that answer is exactly where a seeded re-emission lives.
    let seenSeedResult = false;
    return events.filter((e) => {
        if (e.kind === "agent-result" && !seenSeedResult) { seenSeedResult = true; return false; }
        return e.seq == null || e.seq > boundarySeq;
    });
}

/** Collapse whitespace so a reflowed copy of the same text still compares equal. */
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The steps of the (single) agent session in an event stream, deduplicated by seq, in order. */
export function stepsOf(events) {
    const bySeq = new Map();
    const noSeq = [];
    for (const ev of events) {
        if (ev.kind !== "agent-step") continue;
        if (ev.seq == null) { noSeq.push(ev); continue; }
        // A tool call emits twice (pending START, then DONE). Merge, letting the later event win field
        // by field, so the DONE's result lands on top of the START's args.
        const prev = bySeq.get(ev.seq);
        bySeq.set(ev.seq, prev ? { ...prev, ...Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)) } : ev);
    }
    return [...bySeq.values(), ...noSeq]
        .filter((s) => !s.pending || s.result != null || s.tool)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** The final agent-result event (the LAST turn's, when a follow-up ran). */
export function resultOf(events) {
    return [...events].reverse().find((e) => e.kind === "agent-result") || null;
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
        if (s.thought) out.push({ seq: s.seq ?? 0, kind: "thought", text: String(s.thought) });
        const args = flatStrings(s.arguments).join("\n");
        if (args) out.push({ seq: s.seq ?? 0, kind: "args", text: args });
    }
    // EVERY turn's answer, not just the last one. A multi-turn session — a follow-up, or a seeded history —
    // has the model writing a final answer per turn, and reading only the terminal one makes an earlier
    // turn's re-emission invisible. Each answer is placed just after its own turn's last step (the .5), so
    // it stays ordered before the next turn's steps without colliding with an integer seq.
    let lastSeq = 0;
    for (const ev of events) {
        if (ev.kind === "agent-step" && ev.seq != null) lastSeq = Math.max(lastSeq, ev.seq);
        if (ev.kind !== "agent-result") continue;
        if (ev.summary) out.push({ seq: lastSeq + 0.5, kind: "summary", text: String(ev.summary) });
        if (ev.answer) out.push({ seq: lastSeq + 0.5, kind: "answer", text: flatStrings(ev.answer).join("\n") });
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
        .map((s) => ({ seq: s.seq ?? 0, tool: s.tool, text: String(s.modelResult ?? s.result ?? "") }));
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
export function reEmission(events, k = 40) {
    const outputs = capturedOutputs(events).filter((o) => norm(o.text).length >= k);
    const authored = authoredTexts(events);
    const instances = [];
    for (const o of outputs) {
        const hit = authored.find((t) => t.seq > o.seq && sharesRun(o.text, t.text, k));
        if (hit) instances.push({ fromSeq: o.seq, tool: o.tool, atSeq: hit.seq, kind: hit.kind });
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
            refs.push({ seq: t.seq, ref: m, form });
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
export function measureRun(run, task = {}, opts = {}) {
    const { result = null, runMs = 0, error = null, approvals = [] } = run;
    const events = afterSeed(run.events || [], run.seedBoundarySeq ?? -1);
    const k = opts.k ?? 40;
    const done = resultOf(events);
    const steps = stepsOf(events).filter((s) => s.tool);
    const answer = done?.summary ?? result?.summary ?? "";
    let succeeded = null;
    if (typeof task.succeeded === "function") {
        try { succeeded = !!task.succeeded({ answer, events, result, steps }); }
        catch { succeeded = false; }   // a predicate that throws is a failed run, not a broken bench
    }
    return {
        seeded: (run.seedBoundarySeq ?? -1) >= 0,
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
        tokens: tokenCost(events),
        reEmission: reEmission(events, k),
        pointers: pointerUse(events),
        recovery: recovery(events),
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
